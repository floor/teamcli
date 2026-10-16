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
import { writeAtomic } from '../state.ts';
import { parseYaml, toValue, YamlError, type YamlValue } from '../yaml.ts';

export type TeamLifecycle = 'defined' | 'running' | 'stopped' | 'archived';

export const TEAM_LIFECYCLES: readonly TeamLifecycle[] = ['defined', 'running', 'stopped', 'archived'];

/** One roster line: the agent's immutable ID, and the seat and role it holds in this team. */
export type RosterEntry = { agent: string; seat: string; role: string };

export type TeamProvenance = { registered_by: string; registered_at: string; updated_at: string };

export type TeamRecord = {
  /** The team ID this record is stored under. Filled in when a record is read; never written. */
  id?: string;
  project: string;
  entity: string | null;
  session: string;
  root: string;
  lobby: string;
  roster: RosterEntry[];
  lifecycle: TeamLifecycle;
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
export type TeamPatch = Partial<Omit<TeamRecord, 'id' | 'provenance'>> & { by?: string; at?: string };

/** Creates the team's record, or changes the fields the patch names and nothing else. */
export function upsertTeam(home: string, id: string, patch: TeamPatch): TeamRecord {
  return locked(home, () => {
    const teams = readTeams(home);
    const at = patch.at ?? new Date().toISOString();
    const prior = teams[id];
    const { by, at: _at, ...fields } = patch;
    let record: TeamRecord;
    if (prior) {
      record = { ...prior, ...definedOnly(fields), provenance: { ...prior.provenance, updated_at: at } };
    } else {
      for (const key of ['project', 'session', 'root'] as const) {
        if (typeof fields[key] !== 'string' || !fields[key]) throw new TeamsError(`a new team needs a ${key}`);
      }
      record = {
        project: fields.project as string,
        entity: fields.entity ?? null,
        session: fields.session as string,
        root: fields.root as string,
        lobby: fields.lobby ?? '',
        roster: fields.roster ?? [],
        lifecycle: fields.lifecycle ?? 'defined',
        provenance: { registered_by: by ?? 'team', registered_at: at, updated_at: at },
      };
    }
    if (!TEAM_LIFECYCLES.includes(record.lifecycle)) throw new TeamsError(`"${record.lifecycle}" is not a team lifecycle`);
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
export type TeamSeed = { project: string; entity: string | null; session: string; lobby: string | null };

/**
 * Records a team from its file: registers it, or brings the registered record in line with the
 * file, with the lifecycle given. The roster is kept as it is. Never throws: the registry is a
 * record of what the commands did, so a registry that cannot be written is a line for the caller
 * to say, not a reason for the command to fail. Returns that line, or null.
 */
export function noteTeam(home: string, root: string, seed: TeamSeed, lifecycle: TeamLifecycle, by: string): string | null {
  try {
    const real = realRoot(root);
    upsertTeam(home, teamIdOf(real), {
      project: seed.project,
      entity: seed.entity,
      session: seed.session,
      root: real,
      lobby: resolveLobby(home, { entity: seed.entity, lobby: seed.lobby }),
      lifecycle,
      by,
    });
    return null;
  } catch (error) {
    return `the team registry was not updated: ${(error as Error).message}`;
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
  const roster = raw.roster ?? [];
  if (!Array.isArray(roster)) bad('"roster" must be a list');
  const entries = (roster as YamlValue[]).map((entry, i): RosterEntry => {
    if (!isMap(entry)) return bad(`roster line ${i + 1} must be a map`);
    for (const key of ['agent', 'seat', 'role']) {
      if (typeof entry[key] !== 'string') bad(`roster line ${i + 1}: "${key}" must be text`);
    }
    return { agent: entry.agent as string, seat: entry.seat as string, role: entry.role as string };
  });
  const prov = raw.provenance;
  if (!isMap(prov)) return bad('"provenance" must be a map');
  for (const key of ['registered_by', 'registered_at', 'updated_at']) {
    if (typeof prov[key] !== 'string') bad(`provenance: "${key}" must be text`);
  }
  return {
    id,
    project: text('project'),
    entity: entity as string | null,
    session: text('session'),
    root: text('root'),
    lobby: typeof raw.lobby === 'string' ? raw.lobby : '',
    roster: entries,
    lifecycle: lifecycle as TeamLifecycle,
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

function emit(teams: Record<string, TeamRecord>): string {
  const ids = Object.keys(teams).sort();
  if (!ids.length) return 'teams: {}\n';
  const lines = ['teams:'];
  for (const id of ids) {
    const team = teams[id] as TeamRecord;
    lines.push(`  ${scalar(id)}:`);
    lines.push(`    project: ${scalar(team.project)}`);
    lines.push(`    entity: ${nullable(team.entity)}`);
    lines.push(`    session: ${scalar(team.session)}`);
    lines.push(`    root: ${scalar(team.root)}`);
    lines.push(`    lobby: ${scalar(team.lobby)}`);
    if (team.roster.length) {
      lines.push('    roster:');
      for (const entry of team.roster) {
        lines.push(`      - { agent: ${scalar(entry.agent)}, seat: ${scalar(entry.seat)}, role: ${scalar(entry.role)} }`);
      }
    } else {
      lines.push('    roster: []');
    }
    lines.push(`    lifecycle: ${team.lifecycle}`);
    const p = team.provenance;
    lines.push(`    provenance: { registered_by: ${scalar(p.registered_by)}, registered_at: ${scalar(p.registered_at)}, updated_at: ${scalar(p.updated_at)} }`);
  }
  return `${lines.join('\n')}\n`;
}
