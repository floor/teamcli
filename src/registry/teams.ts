// The team registry (Layer 3): `~/.config/team/teams.yaml`, the live truth `up` and routing read.
// The team file stays the seed and projection; this file says which teams exist on the machine,
// who is on each roster, and whether the team is defined, running, stopped or archived.
//
// Every write is a read-modify-write under a lock file, ending in an atomic replace (a temp file
// in the same folder, then a rename), so a reader never sees half a file and two writers never
// lose each other's update.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveLobby } from '../lobby/gate.ts';
import * as projects from './projects.ts';
import { withRegistryLock, withTeamProjectsLocks } from './locks.ts';
import { checkIssueTracker, type IssueTracker } from './issue-tracker.ts';
import { writeAtomic } from '../state.ts';
import { currentRunMemo } from '../run-memo.ts';
import { parseYaml, toValue, YamlError, type YamlValue } from '../yaml.ts';

export type { IssueTracker } from './issue-tracker.ts';

export type TeamLifecycle = 'defined' | 'running' | 'stopped' | 'archived';

export const TEAM_LIFECYCLES: readonly TeamLifecycle[] = ['defined', 'running', 'stopped', 'archived'];

/** One roster line: the agent's immutable ID, the seat and role it holds in this team, and the
 *  capabilities the team file marks on the seat `leads: true` grants — readable without knowing
 *  any role name. `leads: true` is the seat the team file marks as its lead; `assistant: true` is
 *  the seat whose place in the chain is the entity's assistant (src/send/admit.ts). Absent means
 *  the seat is not known to hold it, so a registry written before the field reads unchanged.
 *  `nickname` is the seat's human name as the file writes it: projected here so another team can
 *  resolve `<nickname>@<team>` without loading this team's file. It confers nothing. */
export type RosterEntry = { agent: string; seat: string; role: string; nickname?: string; leads?: boolean; assistant?: boolean };

export type TeamProvenance = { registered_by: string; registered_at: string; updated_at: string };

export type PreviousTeamName = { name: string; until: string };

export type TeamRecord = {
  /** The team ID this record is stored under. Filled in when a record is read; never written. */
  id?: string;
  /** The team's own name — today's `project:` key in the team file. Not the project it sits in. */
  project: string;
  /** The project this team sits in, by project ID (src/registry/projects.ts), or null: a team no
   *  project names is its own project. Written from the team file's `in_project` through sync. */
  projectId: string | null;
  /** All project memberships, including the home. Older records default to the home alone. */
  projects?: string[];
  /** Previous team names carried across a rename with their grace-window expiry (`until`, ISO UTC). */
  previousNames?: PreviousTeamName[];
  entity: string | null;
  session: string;
  root: string;
  /** The lobby the team operates on in its `session`: recorded at registration and kept, so an
   *  entity edit never moves a running fleet. It is also the `lobbies` entry for `session`. */
  lobby: string;
  /** The lobby recorded for each session — `session` among them. The registry is keyed by the
   *  root, and a checkout can hold another team file, or the same team can be launched with
   *  `--session alt`: each session records its own entry without taking another's away. A file
   *  written before the map existed reads as one entry, `{[session]: lobby}`. */
  lobbies: Record<string, string>;
  roster: RosterEntry[];
  lifecycle: TeamLifecycle;
  /** Owner-signed team-level settings, one signed entry per key, when present. */
  settings?: Record<string, YamlValue>;
  /** The issue tracker project the team's work is tracked in (src/registry/issue-tracker.ts), or
   *  absent: the team names none. Team level, a reference only, written as `issue_tracker`. */
  issueTracker?: IssueTracker;
  provenance: TeamProvenance;
};

/** The registry file could not be read as a team registry. Names the file and what is wrong. */
export class TeamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamsError';
  }
}

/** The team ID: sha256 of the real path of the project root, first 12 hex digits. A root that
 *  does not exist (yet) is hashed as written, resolved to an absolute path. */
export function teamIdOf(root: string): string {
  return createHash('sha256').update(realRoot(root)).digest('hex').slice(0, 12);
}

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

export function teamsFile(home: string): string {
  return join(home, '.config', 'team', 'teams.yaml');
}

/** How a reader takes the registry. `strictRoster` refuses a `roster: null` instead of reading
 *  it as the empty roster a lenient reader takes it to be: a command that retires a record on the
 *  strength of "no roster names it" must never read an unreadable roster as naming nobody. A
 *  record with the field absent reads as it always did — a team with no roster lines. */
export type ReadTeamsOptions = { strictRoster?: boolean };

function cloneTeamRecord(record: TeamRecord): TeamRecord {
  return {
    ...record,
    projects: [...membershipsOf(record)],
    lobbies: { ...record.lobbies },
    roster: record.roster.map((entry) => ({ ...entry })),
    provenance: { ...record.provenance },
    ...(record.projects !== undefined ? { projects: [...record.projects] } : {}),
    ...(record.previousNames !== undefined ? { previousNames: record.previousNames.map((entry) => ({ ...entry })) } : {}),
    ...(record.settings !== undefined ? { settings: { ...record.settings } } : {}),
    ...(record.issueTracker !== undefined ? { issueTracker: { ...record.issueTracker } } : {}),
  };
}

function cloneTeams(records: Record<string, TeamRecord>): Record<string, TeamRecord> {
  const out: Record<string, TeamRecord> = {};
  for (const [id, record] of Object.entries(records)) {
    out[id] = cloneTeamRecord(record);
  }
  return out;
}

/** Every registered team, by team ID. A missing file is no teams; a file that cannot be read —
 *  a corrupt one, or one under a folder this user cannot search — throws `TeamsError`, so no
 *  reader takes an unreadable registry as an empty one (the bridge would fall back to the team
 *  file's own declaration) and no writer replaces a file it could not read. */
export function readTeams(home: string, options: ReadTeamsOptions = {}): Record<string, TeamRecord> {
  const memo = currentRunMemo();
  const strict = options.strictRoster === true;
  if (memo !== null) {
    const map = strict ? memo.teamsStrict : memo.teamsTolerant;
    const cached = map.get(home);
    if (cached !== undefined) return cloneTeams(cached);
  }
  const path = teamsFile(home);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // Absence is ENOENT alone: an existence check would read a folder this user cannot search
    // as "no registry", and callers decide seats on that answer.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (memo !== null) {
        memo.teamsTolerant.set(home, {});
        memo.teamsStrict.set(home, {});
      }
      return {};
    }
    throw new TeamsError(`${path}: ${(error as Error).message}`);
  }
  if (!text.trim()) {
    if (memo !== null) {
      memo.teamsTolerant.set(home, {});
      memo.teamsStrict.set(home, {});
    }
    return {};
  }
  let value: YamlValue;
  try {
    value = toValue(parseYaml(text));
  } catch (error) {
    if (error instanceof YamlError) throw new TeamsError(`${path}: line ${error.line}: ${error.message}`);
    throw error;
  }
  const parsed = teamsOf(value, path, options);
  if (memo !== null) {
    const map = strict ? memo.teamsStrict : memo.teamsTolerant;
    map.set(home, cloneTeams(parsed));
  }
  return parsed;
}

export function getTeam(home: string, id: string): TeamRecord | null {
  return readTeams(home)[id] ?? null;
}

/** All memberships; the home alone is the fallback for records from older builds. */
export function membershipsOf(team: Pick<TeamRecord, 'projectId' | 'projects'>): string[] {
  return [...(team.projects ?? (team.projectId === null ? [] : [team.projectId]))];
}

/** What `registeredRootOf` found: the team a seat is on by the registry's roster, or why none
 *  could be named. Every failure is structured, so each caller words its own sentence. */
export type RegisteredRoot =
  | { ok: true; root: string; session: string }
  | { ok: false; kind: 'unreadable'; message: string }
  | { ok: false; kind: 'none' }
  | { ok: false; kind: 'ambiguous'; ids: readonly string[] };

/**
 * The root of the registered team whose roster holds `seat`: how a seat that names no file finds
 * its team. The folder a seat starts in says nothing about the team — a seat starts in a lobby,
 * which is not a work tree of any checkout — so the registry's roster is what names it, and
 * `session` narrows between teams that hold the same seat name. A lone holder is returned even
 * when its session differs, so a caller's own session check can name the difference.
 */
export function registeredRootOf(home: string, seat: string, session?: string): RegisteredRoot {
  let teams: Record<string, TeamRecord>;
  try {
    teams = readTeams(home);
  } catch (error) {
    return { ok: false, kind: 'unreadable', message: (error as Error).message };
  }
  const holders = Object.values(teams).filter((team) => team.roster.some((line) => line.seat === seat));
  if (holders.length === 0) return { ok: false, kind: 'none' };
  const matching = session === undefined
    ? holders
    : holders.filter((team) => team.session === session || team.lobbies[session] !== undefined);
  const candidates = matching.length > 0 ? matching : holders;
  if (candidates.length > 1) {
    return { ok: false, kind: 'ambiguous', ids: candidates.map((team) => team.id ?? team.project).sort() };
  }
  const team = candidates[0]!;
  return { ok: true, root: team.root, session: team.session };
}

/** What `upsertTeam` takes: any of the record's fields, and who is writing and when. A team not
 *  yet registered needs `project`, `session` and `root` at least. */
export type TeamPatch = Partial<Omit<TeamRecord, 'id' | 'provenance' | 'issueTracker'>> & {
  by?: string;
  at?: string;
  /** The team's issue tracker: a value sets it, `null` removes it, absent leaves it as it is. */
  issueTracker?: IssueTracker | null;
  /** Entries to set, or to remove with `null`, inside the record's settings map. Applied to the
   *  record the writer reads under the registry lock, so two writes of different keys both land. */
  settingsDelta?: Record<string, YamlValue | null>;
};

/** Creates the team's record, or changes the fields the patch names and nothing else. */
export function upsertTeam(home: string, id: string, patch: TeamPatch): TeamRecord {
  return locked(home, () => {
    const teams = readTeams(home);
    const at = patch.at ?? new Date().toISOString();
    const prior = teams[id];
    const { by, at: _at, settingsDelta, issueTracker, ...fields } = patch;
    if (fields.projects !== undefined && !Array.isArray(fields.projects)) throw new TeamsError('"projects" must be a list of project IDs');
    let record: TeamRecord;
    if (prior) {
      record = { ...prior, ...definedOnly(fields), provenance: { ...prior.provenance, updated_at: at } };
    } else {
      for (const key of ['project', 'session', 'root'] as const) {
        if (typeof fields[key] !== 'string' || !fields[key]) throw new TeamsError(`a new team needs a ${key}`);
      }
      record = {
        project: fields.project as string,
        projectId: fields.projectId ?? null,
        projects: fields.projects ?? (fields.projectId ? [fields.projectId] : []),
        ...(fields.previousNames !== undefined ? { previousNames: fields.previousNames.map((entry) => ({ ...entry })) } : {}),
        entity: fields.entity ?? null,
        session: fields.session as string,
        root: fields.root as string,
        lobby: fields.lobby ?? '',
        lobbies: fields.lobbies ?? (fields.lobby ? { [fields.session as string]: fields.lobby } : {}),
        roster: fields.roster ?? [],
        lifecycle: fields.lifecycle ?? 'defined',
        ...(fields.settings !== undefined ? { settings: fields.settings } : {}),
        provenance: { registered_by: by ?? 'team', registered_at: at, updated_at: at },
      };
    }
    if (record.projectId !== null && (record.projects === undefined || !record.projects.includes(record.projectId))) {
      record.projects = [record.projectId, ...(record.projects ?? [])];
    }
    if (!TEAM_LIFECYCLES.includes(record.lifecycle)) throw new TeamsError(`"${record.lifecycle}" is not a team lifecycle`);
    if (record.projectId !== null && typeof record.projectId !== 'string') throw new TeamsError('"project_id" must be a project ID or null');
    if (fields.projects === undefined && fields.projectId !== undefined) {
      record.projects = membershipsOf(prior ?? { projectId: null }).filter(id => id !== prior?.projectId);
      if (record.projectId !== null && !record.projects.includes(record.projectId)) record.projects.unshift(record.projectId);
    }
    if (record.projects !== undefined && !Array.isArray(record.projects)) throw new TeamsError('"projects" must be a list of project IDs');
    const memberships = membershipsOf(record);
    if (memberships.some(id => typeof id !== 'string' || !id)) {
      throw new TeamsError('"projects" must be a list of project IDs');
    }
    record.projects = [...new Set(memberships)];
    // An update that names no tracker keeps the one on record (the spread above carried it).
    if (issueTracker === null) delete record.issueTracker;
    else if (issueTracker !== undefined) {
      const checked = checkIssueTracker(issueTracker);
      if (!checked.ok) throw new TeamsError(checked.why);
      record.issueTracker = checked.value;
    }
    if (settingsDelta !== undefined) {
      const settings: Record<string, YamlValue> = { ...(record.settings ?? {}) };
      for (const [key, entry] of Object.entries(settingsDelta)) {
        if (entry === null) delete settings[key];
        else settings[key] = entry;
      }
      record.settings = settings;
    }
    // A write of the primary session's lobby keeps that session's map entry in step; every other
    // entry is left exactly as it was, which is what keeps the other sessions' lobbies.
    record.lobbies = { ...(record.lobbies ?? {}) };
    if (record.lobby) record.lobbies[record.session] = record.lobby;
    if (record.settings !== undefined && Object.keys(record.settings).length === 0) delete record.settings;
    if (record.settings !== undefined && !isMap(record.settings)) throw new TeamsError('"settings" must be a map');
    delete record.id;
    teams[id] = record;
    write(home, teams);
    return { ...record, id };
  });
}

/** Replaces the roster of a registered team. */
export function setRoster(home: string, id: string, roster: RosterEntry[]): TeamRecord {
  if (!getTeam(home, id)) throw new TeamsError(`no team ${id} in the registry`);
  return upsertTeam(home, id, { roster });
}

/** Sets the lifecycle of a registered team. */
export function setTeamLifecycle(home: string, id: string, state: TeamLifecycle): TeamRecord {
  if (!getTeam(home, id)) throw new TeamsError(`no team ${id} in the registry`);
  return upsertTeam(home, id, { lifecycle: state });
}

/** The teams a key names, in the order a written address may mean it: the team with that id,
 *  else every team whose own name (the file's `project:`) is that word, else every team whose
 *  session is. A class with any answer is taken whole, so a second team that only shares a
 *  session never takes a name, and more than one record in the answering class stays ambiguous
 *  for the caller to name. */
export function findTeams(home: string, key: string): TeamRecord[] {
  const teams = readTeams(home);
  const byId = teams[key];
  if (byId) return [byId];
  const all = Object.values(teams);
  const named = all.filter((team) => team.project === key);
  if (named.length > 0) return named;
  return all.filter((team) => team.session === key);
}

/** The one team a key names, or null when none does or when the key is ambiguous. */
export function findTeam(home: string, key: string): TeamRecord | null {
  const found = findTeams(home, key);
  return found.length === 1 ? (found[0] as TeamRecord) : null;
}

/**
 * Teams whose `previousNames` carry `key`, paired with whether the grace window (`until`) has
 * expired at `now`. Used only when no current team id, project or session matches `key`.
 */
export function findTeamsByPreviousName(
  home: string,
  key: string,
  now: Date = new Date(),
): Array<{ team: TeamRecord; expired: boolean }> {
  const all = Object.values(readTeams(home));
  const out: Array<{ team: TeamRecord; expired: boolean }> = [];
  const nowMs = now.getTime();
  for (const team of all) {
    const match = team.previousNames?.find((entry) => entry.name === key);
    if (!match) continue;
    const untilMs = Date.parse(match.until);
    const expired = Number.isFinite(untilMs) && untilMs <= nowMs;
    out.push({ team, expired });
  }
  return out;
}

/**
 * Single seam for changing a team's project membership (`project_id` home, `projects: [...]` list,
 * and `projects.yaml` membership). Isolates item 0's project membership shape in one function.
 */
export function setTeamProjectMembership(
  home: string,
  teamId: string,
  inProject: string | null,
  opts: { entity?: string | null; by?: string; at?: string } = {},
): { projectId: string | null; projects: string[] } {
  const current = getTeam(home, teamId);
  const entity = opts.entity !== undefined ? opts.entity : (current?.entity ?? null);
  const by = opts.by ?? 'rename';
  const at = opts.at ?? new Date().toISOString();
  if (inProject === null) {
    const served = (current?.projects ?? []).filter((id) => id !== current?.projectId);
    upsertTeam(home, teamId, { projectId: null, projects: served, by, at });
    projectLeave(home, teamId, null);
    return { projectId: null, projects: served };
  }
  const projectId = projects.projectIdOf(inProject);
  const otherProjects = (current?.projects ?? []).filter((id) => id !== current?.projectId && id !== projectId);
  const nextProjects = [projectId, ...otherProjects];
  upsertTeam(home, teamId, { projectId, projects: nextProjects, by, at });
  projectJoin(home, teamId, inProject, entity, by);
  return { projectId, projects: nextProjects };
}

/**
 * Explicitly re-keys a team record from `oldId` to `newId` when the owner moves a repository root
 * with `--rekey`, updating `teams.yaml` and `projects.yaml` `teams[]` references.
 */
export function rekeyTeamRecord(home: string, oldId: string, newId: string, patch: TeamPatch): TeamRecord {
  const record = locked(home, () => {
    const teams = readTeams(home);
    const prior = teams[oldId];
    if (!prior) throw new TeamsError(`no team ${oldId} in the registry to re-key`);
    delete teams[oldId];
    const at = patch.at ?? new Date().toISOString();
    const { by: _by, at: _at, settingsDelta: _sd, issueTracker: _it, ...fields } = patch;
    const next: TeamRecord = {
      ...prior,
      ...definedOnly(fields),
      provenance: { ...prior.provenance, updated_at: at },
    };
    next.lobbies = { ...(next.lobbies ?? {}) };
    if (next.lobby) next.lobbies[next.session] = next.lobby;
    delete next.id;
    teams[newId] = next;
    write(home, teams);
    return { ...next, id: newId };
  });
  for (const [projectId, proj] of Object.entries(projects.readProjects(home))) {
    if (!proj.teams.includes(oldId)) continue;
    const nextTeams = proj.teams.map((t) => (t === oldId ? newId : t));
    projects.upsertProject(home, projectId, { teams: Array.from(new Set(nextTeams)) });
  }
  return record;
}

/**
 * Removes one team registry record and drops that id from every project that names it. Does not
 * stop panes, delete the team file, or touch seats. Returns the record that was removed, or null
 * when the registry has no team with that id.
 */
export function forgetTeam(home: string, id: string): TeamRecord | null {
  return withTeamProjectsLocks(home, () => {
    const teams = readTeams(home);
    const prior = teams[id];
    if (!prior) return null;
    projectLeave(home, prior, null);
    delete teams[id];
    write(home, teams);
    return { ...prior, id };
  });
}

/** What of a team file the registry keeps. */
export type TeamSeed = {
  project: string;
  entity: string | null;
  session: string;
  lobby: string | null;
  /** The project the file names this team sits in, as written, or null when it names none — the
   *  team is then its own project. Absent (undefined) leaves the registry's pointer as it is. */
  inProject?: string | null;
  /** The session the team file itself names, when this note runs under another (`up --session
   *  alt`). That session records the same lobby too, unless it already has one, so a plain
   *  `team check` — which reads the file's own session — finds the lobby back. */
  aliasSession?: string;
};

/**
 * Records a team from its file: registers it, or brings the registered record in line with the
 * file, with the lifecycle given. The roster is kept as it is. A seed that names the project its
 * file points to also joins it: the project record is made if the registry has none, gains the
 * team, and loses it if the file moves the team or stops naming a project. Never throws: the
 * registry is a record of what the commands did, so a registry that cannot be written is a line
 * for the caller to say, not a reason for the command to fail. Returns that line, or null.
 */
export function noteTeam(home: string, root: string, seed: TeamSeed, lifecycle: TeamLifecycle, by: string): string | null {
  const real = realRoot(root);
  const teamId = teamIdOf(real);
  const inProject = seed.inProject;
  let projectId: string | null | undefined;
  try {
    projectId = inProject === undefined ? undefined : inProject === null ? null : projects.projectIdOf(inProject);
  } catch (error) {
    return `the project registry was not updated: ${(error as Error).message}`;
  }
  try {
    return withTeamProjectsLocks(home, () => {
      // The lobby is recorded once per session: a session the registry holds a lobby for keeps it,
      // so editing the file's `entity` never moves a running team's seats. An explicit `lobby:` is
      // the owner's own declaration, not a derivation, and is re-recorded; a session with no entry
      // derives from the entity (`src/lobby/recorded.ts` reads the record back at every use). The
      // map is what lets another session — `up --session alt`, or another team file in the same
      // checkout, since the registry is keyed by the root — record its own lobby without taking
      // this one's entry away. The file's own session is recorded alongside when the note runs
      // under another name, unless it already holds an entry of its own.
      const earlier = getTeam(home, teamId);
      if (inProject !== undefined) {
        if (inProject !== null) projectJoin(home, inProject, seed.entity, by);
        if (earlier && earlier.projectId !== projectId) projectLeave(home, earlier, projectId ?? null);
      }
      const prior = earlier?.lobbies[seed.session] ?? '';
      const current = seed.lobby ? resolveLobby(home, { lobby: seed.lobby }) : prior || resolveLobby(home, { entity: seed.entity });
      const lobbies: Record<string, string> = { ...(earlier?.lobbies ?? {}), [seed.session]: current };
      if (seed.aliasSession && !lobbies[seed.aliasSession]) lobbies[seed.aliasSession] = current;
      upsertTeam(home, teamId, {
        project: seed.project,
        projectId,
        entity: seed.entity,
        session: seed.session,
        root: real,
        lobby: current,
        lobbies,
        lifecycle,
        by,
      });
      return null;
    });
  } catch (error) {
    const registry = error instanceof projects.ProjectsError ? 'project' : 'team';
    return `the ${registry} registry was not updated: ${(error as Error).message}`;
  }
}

/** Project metadata exists before the membership write. Membership itself has one writer. */
function projectJoin(home: string, name: string, entity: string | null, by: string): void {
  const id = projects.projectIdOf(name);
  if (!projects.get(home, id)) projects.upsertProject(home, id, { name, entity, by });
}

/** Clear this team's old home lead before changing its membership. No project-side link write. */
function projectLeave(home: string, team: TeamRecord, keep: string | null): void {
  if (team.projectId === null || team.projectId === keep) return;
  const held = projects.get(home, team.projectId);
  if (held?.lead && team.roster.some(line => line.agent === held.lead)) {
    projects.upsertProject(home, team.projectId, { lead: null });
  }
}

function definedOnly<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

// --- the lock and the write ------------------------------------------------------------------

/** Holds the team registry lock across a read and a write. */
export function withTeamsLock<T>(home: string, work: () => T): T {
  return locked(home, work);
}

function locked<T>(home: string, work: () => T): T {
  return withRegistryLock(home, 'teams', work, message => new TeamsError(message));
}

function write(home: string, teams: Record<string, TeamRecord>): void {
  const path = teamsFile(home);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, emit(teams));
  const memo = currentRunMemo();
  if (memo !== null) {
    memo.teamsStrict.clear();
    memo.teamsTolerant.clear();
  }
}

// --- reading the file's value into records ---------------------------------------------------

function teamsOf(value: YamlValue, path: string, options: ReadTeamsOptions): Record<string, TeamRecord> {
  if (!isMap(value)) throw new TeamsError(`${path}: expected a map with a "teams" key`);
  const section = value.teams;
  if (section === null || section === undefined) return {};
  if (!isMap(section)) throw new TeamsError(`${path}: "teams" must be a map of team IDs`);
  const out: Record<string, TeamRecord> = {};
  for (const [id, raw] of Object.entries(section)) out[id] = recordOf(id, raw, path, options);
  return out;
}

function recordOf(id: string, raw: YamlValue, path: string, options: ReadTeamsOptions): TeamRecord {
  const bad = (what: string): never => {
    throw new TeamsError(`${path}: team ${id}: ${what}`);
  };
  if (!isMap(raw)) return bad('expected a map');
  const text = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : bad(`"${key}" must be text`));
  const lifecycle = raw.lifecycle;
  if (typeof lifecycle !== 'string' || !TEAM_LIFECYCLES.includes(lifecycle as TeamLifecycle)) {
    bad(`"lifecycle" must be one of ${TEAM_LIFECYCLES.join(', ')}`);
  }
  const entity = raw.entity ?? null;
  if (entity !== null && typeof entity !== 'string') bad('"entity" must be text or null');
  const projectId = raw.project_id ?? null;
  if (projectId !== null && typeof projectId !== 'string') bad('"project_id" must be a project ID or null');
  const memberships = raw.projects === undefined ? (projectId === null ? [] : [projectId]) : raw.projects;
  if (!Array.isArray(memberships) || memberships.some(id => typeof id !== 'string' || !id)) bad('"projects" must be a list of project IDs');
  let previousNames: PreviousTeamName[] | undefined;
  if (raw.previous_names !== undefined) {
    if (!Array.isArray(raw.previous_names)) bad('"previous_names" must be a list');
    previousNames = (raw.previous_names as YamlValue[]).map((item, i): PreviousTeamName => {
      if (!isMap(item) || typeof item.name !== 'string' || typeof item.until !== 'string') {
        return bad(`previous_names line ${i + 1} must carry "name" and "until"`);
      }
      return { name: item.name, until: item.until };
    });
  }
  // A lenient reader takes a null roster as no roster lines; a strict one refuses it, because a
  // command must not read "I cannot see this roster" as "this roster names nobody".
  if (options.strictRoster === true && raw.roster === null) bad('"roster" must be a list');
  const roster = raw.roster ?? [];
  if (!Array.isArray(roster)) bad('"roster" must be a list');
  const entries = (roster as YamlValue[]).map((entry, i): RosterEntry => {
    if (!isMap(entry)) return bad(`roster line ${i + 1} must be a map`);
    for (const key of ['agent', 'seat', 'role']) {
      if (typeof entry[key] !== 'string') bad(`roster line ${i + 1}: "${key}" must be text`);
    }
    // Absent leaves the line as it was written before the field existed: not known to lead.
    const leads = entry.leads;
    if (leads !== undefined && typeof leads !== 'boolean') bad(`roster line ${i + 1}: "leads" must be true or false`);
    // The same reading for the assistant capability: an absent field is a line written before it.
    const assistant = entry.assistant;
    if (assistant !== undefined && typeof assistant !== 'boolean') bad(`roster line ${i + 1}: "assistant" must be true or false`);
    // A line written before the field existed carries none: no human name is known here.
    const nickname = entry.nickname;
    if (nickname !== undefined && typeof nickname !== 'string') bad(`roster line ${i + 1}: "nickname" must be text`);
    return {
      agent: entry.agent as string,
      seat: entry.seat as string,
      role: entry.role as string,
      ...(typeof nickname === 'string' ? { nickname } : {}),
      ...(typeof leads === 'boolean' ? { leads } : {}),
      ...(typeof assistant === 'boolean' ? { assistant } : {}),
    };
  });
  const prov = raw.provenance;
  if (!isMap(prov)) return bad('"provenance" must be a map');
  for (const key of ['registered_by', 'registered_at', 'updated_at']) {
    if (typeof prov[key] !== 'string') bad(`provenance: "${key}" must be text`);
  }
  const session = text('session');
  const lobby = typeof raw.lobby === 'string' ? raw.lobby : '';
  // A record written before the map existed knows one lobby: the one its session holds. Read
  // that way, every reader sees a session's lobby without a migration write.
  const lobbies: Record<string, string> = {};
  const map = raw.lobbies;
  if (map !== undefined) {
    if (!isMap(map)) bad('"lobbies" must be a map of sessions to lobbies');
    for (const [name, value] of Object.entries(map as { [key: string]: YamlValue })) {
      if (typeof value !== 'string' || !value) bad(`lobbies: "${name}" must be a lobby path`);
      lobbies[name] = value as string;
    }
  }
  if (lobby) lobbies[session] = lobby;
  // A settings map that is not a map is refused here, not dropped: a reader that ignored it
  // would answer as if the team had no settings, and the settings it holds would vanish unseen.
  if (raw.settings !== undefined && raw.settings !== null && !isMap(raw.settings)) bad('"settings" must be a map');
  const settings = isMap(raw.settings) && Object.keys(raw.settings).length > 0 ? raw.settings : undefined;
  // Absent is a team that names no tracker, so a record written before the field reads unchanged.
  // A value that does not read as one is refused here, not dropped: a reader that ignored it would
  // answer as if the team had none, and the next write would erase it unseen.
  let issueTracker: IssueTracker | undefined;
  if (raw.issue_tracker !== undefined) {
    const checked = checkIssueTracker(raw.issue_tracker);
    if (!checked.ok) bad(checked.why);
    else issueTracker = checked.value;
  }
  return {
    id,
    project: text('project'),
    projectId: projectId as string | null,
    projects: memberships as string[],
    ...(previousNames !== undefined && previousNames.length > 0 ? { previousNames } : {}),
    entity: entity as string | null,
    session,
    root: text('root'),
    lobby,
    lobbies,
    roster: entries,
    lifecycle: lifecycle as TeamLifecycle,
    ...(settings !== undefined ? { settings } : {}),
    ...(issueTracker !== undefined ? { issueTracker } : {}),
    provenance: { registered_by: prov.registered_by as string, registered_at: prov.registered_at as string, updated_at: prov.updated_at as string },
  };
}

function isMap(value: YamlValue | undefined): value is { [key: string]: YamlValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- writing the records as the YAML subset the reader takes ---------------------------------

/** A word is written bare only where the reader would read it back as the same text; every
 *  other string is double-quoted, so an ID of digits or a path with a colon survives a round trip. */
function scalar(text: string): string {
  const bare = /^[A-Za-z_/~][A-Za-z0-9_./@~-]*$/.test(text) && !/^(~|null|true|false)$/i.test(text);
  return bare ? text : JSON.stringify(text);
}

function nullable(text: string | null): string {
  return text === null ? 'null' : scalar(text);
}

function emitSettingValue(v: YamlValue): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return scalar(v);
  if (Array.isArray(v)) return `[${v.map((item) => emitSettingValue(item)).join(', ')}]`;
  return JSON.stringify(v);
}

function emitSettings(indent: string, settings: Record<string, YamlValue>): string[] {
  const keys = Object.keys(settings).sort();
  if (keys.length === 0) return [];
  const lines = [`${indent}settings:`];
  for (const name of keys) {
    const entry = settings[name];
    if (isMap(entry)) {
      lines.push(`${indent}  ${scalar(name)}:`);
      for (const [k, v] of Object.entries(entry)) {
        lines.push(`${indent}    ${scalar(k)}: ${emitSettingValue(v ?? null)}`);
      }
    } else {
      lines.push(`${indent}  ${scalar(name)}: ${emitSettingValue(entry ?? null)}`);
    }
  }
  return lines;
}

/** One flow map in a fixed key order, every text through `scalar`, so it reads back as written. */
function emitIssueTracker(tracker: IssueTracker): string {
  const parts = [`type: ${scalar(tracker.type)}`, `project: ${scalar(tracker.project)}`];
  if (tracker.team !== undefined) parts.push(`team: ${scalar(tracker.team)}`);
  if (tracker.url !== undefined) parts.push(`url: ${scalar(tracker.url)}`);
  return `{ ${parts.join(', ')} }`;
}

function emit(teams: Record<string, TeamRecord>): string {
  const ids = Object.keys(teams).sort();
  if (!ids.length) return 'teams: {}\n';
  const lines = ['teams:'];
  for (const id of ids) {
    const team = teams[id] as TeamRecord;
    lines.push(`  ${scalar(id)}:`);
    lines.push(`    project: ${scalar(team.project)}`);
    lines.push(`    project_id: ${nullable(team.projectId)}`);
    lines.push(`    projects: [${membershipsOf(team).map(scalar).join(', ')}]`);
    lines.push(`    entity: ${nullable(team.entity)}`);
    lines.push(`    session: ${scalar(team.session)}`);
    lines.push(`    root: ${scalar(team.root)}`);
    lines.push(`    lobby: ${scalar(team.lobby)}`);
    // Only sessions with a lobby of their own are written: a record whose map is just its
    // `session` entry reads back from `lobby`, so single-session files stay byte for byte.
    const others = Object.entries(team.lobbies ?? {})
      .filter(([session, lobby]) => session !== team.session || lobby !== team.lobby)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (others.length) {
      lines.push('    lobbies:');
      for (const [session, lobby] of others) lines.push(`      ${scalar(session)}: ${scalar(lobby)}`);
    }
    if (team.roster.length) {
      lines.push('    roster:');
      for (const entry of team.roster) {
        // Only the line that holds a capability says so: `false` and an absent field mean the same.
        // A nickname is written where the file writes one, before the capabilities.
        const nickname = entry.nickname !== undefined ? `, nickname: ${scalar(entry.nickname)}` : '';
        const leads = entry.leads === true ? ', leads: true' : '';
        const assistant = entry.assistant === true ? ', assistant: true' : '';
        lines.push(`      - { agent: ${scalar(entry.agent)}, seat: ${scalar(entry.seat)}, role: ${scalar(entry.role)}${nickname}${leads}${assistant} }`);
      }
    } else {
      lines.push('    roster: []');
    }
    lines.push(`    lifecycle: ${team.lifecycle}`);
    if (team.previousNames && team.previousNames.length > 0) {
      lines.push('    previous_names:');
      for (const prev of team.previousNames) {
        lines.push(`      - { name: ${scalar(prev.name)}, until: ${scalar(prev.until)} }`);
      }
    }
    // Only a team that names a tracker says so: absent and "none" are the same record.
    if (team.issueTracker) lines.push(`    issue_tracker: ${emitIssueTracker(team.issueTracker)}`);
    if (team.settings && Object.keys(team.settings).length > 0) {
      lines.push(...emitSettings('    ', team.settings));
    }
    const p = team.provenance;
    lines.push(`    provenance: { registered_by: ${scalar(p.registered_by)}, registered_at: ${scalar(p.registered_at)}, updated_at: ${scalar(p.updated_at)} }`);
  }
  return `${lines.join('\n')}\n`;
}
