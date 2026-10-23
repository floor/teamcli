// The team registry (Layer 3): `~/.config/team/teams.yaml`, the live truth `up` and routing read.
// The team file stays the seed and projection; this file says which teams exist on the machine,
// who is on each roster, and whether the team is defined, running, stopped or archived.
//
// Every write is a read-modify-write under a lock file, ending in an atomic replace (a temp file
// in the same folder, then a rename), so a reader never sees half a file and two writers never
// lose each other's update.

import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveLobby } from '../lobby/gate.ts';
import * as projects from './projects.ts';
import { checkIssueTracker, type IssueTracker } from './issue-tracker.ts';
import { writeAtomic } from '../state.ts';
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

export type TeamRecord = {
  /** The team ID this record is stored under. Filled in when a record is read; never written. */
  id?: string;
  /** The team's own name — today's `project:` key in the team file. Not the project it sits in. */
  project: string;
  /** The project this team sits in, by project ID (src/registry/projects.ts), or null: a team no
   *  project names is its own project. Written from the team file's `in_project` through sync. */
  projectId: string | null;
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

/** Every registered team, by team ID. A missing file is no teams. A file that does not read as
 *  a team registry throws `TeamsError`, so a writer never replaces a file it could not read. */
export function readTeams(home: string): Record<string, TeamRecord> {
  const path = teamsFile(home);
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new TeamsError(`${path}: ${(error as Error).message}`);
  }
  if (!text.trim()) return {};
  let value: YamlValue;
  try {
    value = toValue(parseYaml(text));
  } catch (error) {
    if (error instanceof YamlError) throw new TeamsError(`${path}: line ${error.line}: ${error.message}`);
    throw error;
  }
  return teamsOf(value, path);
}

export function getTeam(home: string, id: string): TeamRecord | null {
  return readTeams(home)[id] ?? null;
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
    if (!TEAM_LIFECYCLES.includes(record.lifecycle)) throw new TeamsError(`"${record.lifecycle}" is not a team lifecycle`);
    if (record.projectId !== null && typeof record.projectId !== 'string') throw new TeamsError('"project_id" must be a project ID or null');
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

/** The teams a key names: the team with that ID, else every team whose project or session is
 *  that word. More than one is ambiguous, and the caller decides what to say about it. */
export function findTeams(home: string, key: string): TeamRecord[] {
  const teams = readTeams(home);
  const byId = teams[key];
  if (byId) return [byId];
  return Object.values(teams).filter((team) => team.project === key || team.session === key);
}

/** The one team a key names, or null when none does or when the key is ambiguous. */
export function findTeam(home: string, key: string): TeamRecord | null {
  const found = findTeams(home, key);
  return found.length === 1 ? (found[0] as TeamRecord) : null;
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
    // The lobby is recorded once per session: a session the registry holds a lobby for keeps it,
    // so editing the file's `entity` never moves a running team's seats. An explicit `lobby:` is
    // the owner's own declaration, not a derivation, and is re-recorded; a session with no entry
    // derives from the entity (`src/lobby/recorded.ts` reads the record back at every use). The
    // map is what lets another session — `up --session alt`, or another team file in the same
    // checkout, since the registry is keyed by the root — record its own lobby without taking
    // this one's entry away. The file's own session is recorded alongside when the note runs
    // under another name, unless it already holds an entry of its own.
    const earlier = getTeam(home, teamId);
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
  } catch (error) {
    return `the team registry was not updated: ${(error as Error).message}`;
  }
  if (inProject === undefined) return null;
  try {
    if (inProject === null) projectLeave(home, teamId, null);
    else projectJoin(home, teamId, inProject, seed.entity, by);
    return null;
  } catch (error) {
    return `the project registry was not updated: ${(error as Error).message}`;
  }
}

/** The team joins the project the file names: the record is made if the registry has none — with
 *  the name the file wrote and the team's entity — and lists the team. Keys by `projectIdOf`, so
 *  the spelling the file chose is the display name and the ID is the same one every reader
 *  derives. Then the team leaves every other project that named it. */
function projectJoin(home: string, teamId: string, name: string, entity: string | null, by: string): void {
  const id = projects.projectIdOf(name);
  const held = projects.get(home, id);
  if (!held) {
    projects.upsertProject(home, id, { name, entity, teams: [teamId], by });
  } else if (!held.teams.includes(teamId)) {
    projects.upsertProject(home, id, { teams: [...held.teams, teamId] });
  }
  projectLeave(home, teamId, id);
}

/** The team leaves every project that names it except `keep` (null: every one). The project it
 *  leaves also loses its lead when the lead on record is one of this team's agents: that id came
 *  from this team's lead seat, so it goes with the team's place in the project rather than
 *  staying admitted as a lead after its team left. Another team's lead is left alone. */
function projectLeave(home: string, teamId: string, keep: string | null): void {
  const roster = getTeam(home, teamId)?.roster ?? [];
  for (const held of projects.list(home)) {
    const id = held.id as string;
    if (id === keep || !held.teams.includes(teamId)) continue;
    const patch: projects.ProjectPatch = { teams: held.teams.filter((team) => team !== teamId) };
    if (held.lead !== null && roster.some((line) => line.agent === held.lead)) patch.lead = null;
    projects.upsertProject(home, id, patch);
  }
}

function definedOnly<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

// --- the lock and the write ------------------------------------------------------------------

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 15000;

function locked<T>(home: string, work: () => T): T {
  const path = `${teamsFile(home)}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A holder that died leaves its file behind: one older than any write takes is not held.
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
      } catch {
        // gone already, or taken by another waiter: look again
      }
      if (Date.now() > deadline) throw new TeamsError(`${path} is held by another run`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return work();
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // already removed as stale
    }
  }
}

function write(home: string, teams: Record<string, TeamRecord>): void {
  const path = teamsFile(home);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, emit(teams));
}

// --- reading the file's value into records ---------------------------------------------------

function teamsOf(value: YamlValue, path: string): Record<string, TeamRecord> {
  if (!isMap(value)) throw new TeamsError(`${path}: expected a map with a "teams" key`);
  const section = value.teams;
  if (section === null || section === undefined) return {};
  if (!isMap(section)) throw new TeamsError(`${path}: "teams" must be a map of team IDs`);
  const out: Record<string, TeamRecord> = {};
  for (const [id, raw] of Object.entries(section)) out[id] = recordOf(id, raw, path);
  return out;
}

function recordOf(id: string, raw: YamlValue, path: string): TeamRecord {
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
