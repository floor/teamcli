// The project registry (Layer 3): `~/.config/team/projects.yaml`, the record between the entity
// and the teams. The hierarchy is entity → project → team → seat: a project groups teams under
// one lead, given by agent ID. Each team record points to its project by ID (src/registry/teams.ts
// carries the field; sync.ts writes it from the team file), and a team no project names is its
// own project — so a machine with no projects.yaml is a machine where every team stands alone,
// and every reader here reads an absent record that way.
//
// The shape and the reads come first; the write (upsertProject) follows them and is a
// read-modify-write under a lock ending in an atomic replace, exactly like teams.ts, so a reader
// never sees half a file and two writers never lose each other's update.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeAtomic } from '../state.ts';
import { parseYaml, toValue, YamlError, type YamlValue } from '../yaml.ts';

export type ProjectProvenance = { registered_by: string; registered_at: string; updated_at: string };

export type ProjectRecord = {
  /** The project ID this record is stored under. Filled in when a record is read; never written. */
  id?: string;
  /** The display name: what people and team files call the project (`TeamCLI`). Immutable
   *  alongside the ID — a rename moves this field, never the key the record is stored under. */
  name: string;
  entity: string | null;
  /** The project lead, by agent ID — never a seat or a role name. Null until set. */
  lead: string | null;
  /** The team IDs this project groups. */
  teams: string[];
  provenance: ProjectProvenance;
};

/** The registry file could not be read as a project registry. Names the file and what is wrong. */
export class ProjectsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectsError';
  }
}

export function projectsFile(home: string): string {
  return join(home, '.config', 'team', 'projects.yaml');
}

/** Every registered project, by project ID. A missing file is no projects. A file that does not
 *  read as a project registry throws `ProjectsError`, so a writer never replaces a file it could
 *  not read. */
export function readProjects(home: string): Record<string, ProjectRecord> {
  const path = projectsFile(home);
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ProjectsError(`${path}: ${(error as Error).message}`);
  }
  if (!text.trim()) return {};
  let value: YamlValue;
  try {
    value = toValue(parseYaml(text));
  } catch (error) {
    if (error instanceof YamlError) throw new ProjectsError(`${path}: line ${error.line}: ${error.message}`);
    throw error;
  }
  return projectsOf(value, path);
}

/** The projects of the registry, ID order, so a view reads the same twice. */
export function list(home: string): ProjectRecord[] {
  const projects = readProjects(home);
  return Object.keys(projects)
    .sort()
    .map((id) => projects[id] as ProjectRecord);
}

/** One project by ID, or null. */
export function get(home: string, id: string): ProjectRecord | null {
  return readProjects(home)[id] ?? null;
}

/** The one project whose display name is exactly `name` — the name a team file writes — or null.
 *  Two projects under one name is a registry that cannot answer, and is refused, naming both. */
export function byName(home: string, name: string): ProjectRecord | null {
  const found = list(home).filter((project) => project.name === name);
  if (found.length > 1) {
    throw new ProjectsError(`two projects are named ${name}: ${found.map((project) => project.id).join(', ')}`);
  }
  return found[0] ?? null;
}

/** The project a team belongs to: the one whose `teams` names it, or null — and callers read
 *  null as this team being its own project. A team two projects both name is the state
 *  `team check` refuses; it is refused here too, naming both, so no reader picks one silently. */
export function ofTeam(home: string, teamId: string): ProjectRecord | null {
  const found = list(home).filter((project) => project.teams.includes(teamId));
  if (found.length > 1) {
    throw new ProjectsError(`team ${teamId} is named in ${found.length} projects: ${found.map((project) => project.id).join(', ')}`);
  }
  return found[0] ?? null;
}

/** The ID a project name gets: the name lowercased, every run of characters outside letters,
 *  digits, `.`, `_` and `-` written as one `-`, and no `-` left at either end. `TeamCLI` is
 *  `teamcli`, `Team CLI` is `team-cli`. This is the bridge a team file's `in_project` name crosses
 *  to reach the record's key, so it must derive the same ID every time; a name with nothing left
 *  to keep is refused rather than minted an empty key. */
export function projectIdOf(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!id) throw new ProjectsError(`"${name}" is not a project name`);
  return id;
}

/** What `upsertProject` takes: any of the record's fields, and who is writing and when. A project
 *  not yet registered needs `name` at least. The id and the provenance are the writer's own. */
export type ProjectPatch = Partial<Omit<ProjectRecord, 'id' | 'provenance'>> & { by?: string; at?: string };

/** Creates the project's record, or changes the fields the patch names and nothing else. The id
 *  is the key and never moves: a rename writes `name` and keeps `byName` answering for the new
 *  one. A name another project already holds is refused, so `byName` stays an answer.
 *
 *  A team two projects would both name is not refused here — a file can be edited into that
 *  state, and it is `team check` that refuses it; `ofTeam` refuses to answer it either way. */
export function upsertProject(home: string, id: string, patch: ProjectPatch): ProjectRecord {
  return locked(home, () => {
    const projects = readProjects(home);
    const at = patch.at ?? new Date().toISOString();
    const prior = projects[id];
    const { by, at: _at, ...fields } = patch;
    let record: ProjectRecord;
    if (prior) {
      record = { ...prior, ...definedOnly(fields), provenance: { ...prior.provenance, updated_at: at } };
    } else {
      if (typeof fields.name !== 'string' || !fields.name) throw new ProjectsError('a new project needs a name');
      record = {
        name: fields.name,
        entity: fields.entity ?? null,
        lead: fields.lead ?? null,
        teams: fields.teams ?? [],
        provenance: { registered_by: by ?? 'team', registered_at: at, updated_at: at },
      };
    }
    if (typeof record.name !== 'string' || !record.name) throw new ProjectsError('a project needs a name');
    if (record.entity !== null && typeof record.entity !== 'string') throw new ProjectsError('"entity" must be text or null');
    if (record.lead !== null && typeof record.lead !== 'string') throw new ProjectsError('"lead" must be an agent ID or null');
    if (!Array.isArray(record.teams)) throw new ProjectsError('"teams" must be a list of team IDs');
    for (const team of record.teams) {
      if (typeof team !== 'string' || !team) throw new ProjectsError('a team ID in "teams" must be text');
    }
    for (const [other, held] of Object.entries(projects)) {
      if (other !== id && held.name === record.name) throw new ProjectsError(`a project named ${record.name} is already ${other}`);
    }
    delete record.id;
    projects[id] = record;
    write(home, projects);
    return { ...record, id };
  });
}

function definedOnly<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

// --- the lock and the write ------------------------------------------------------------------

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 15000;

function locked<T>(home: string, work: () => T): T {
  const path = `${projectsFile(home)}.lock`;
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
      if (Date.now() > deadline) throw new ProjectsError(`${path} is held by another run`);
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

function write(home: string, projects: Record<string, ProjectRecord>): void {
  const path = projectsFile(home);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, emit(projects));
}

// --- writing the records as the YAML subset the reader takes ---------------------------------

/** A word is written bare only where the reader would read it back as the same text; every
 *  other string is double-quoted, so an ID of digits or a name with a colon survives a round trip. */
function scalar(text: string): string {
  const bare = /^[A-Za-z_/~][A-Za-z0-9_./@~-]*$/.test(text) && !/^(~|null|true|false)$/i.test(text);
  return bare ? text : JSON.stringify(text);
}

function nullable(text: string | null): string {
  return text === null ? 'null' : scalar(text);
}

function emit(projects: Record<string, ProjectRecord>): string {
  const ids = Object.keys(projects).sort();
  if (!ids.length) return 'projects: {}\n';
  const lines = ['projects:'];
  for (const id of ids) {
    const project = projects[id] as ProjectRecord;
    lines.push(`  ${scalar(id)}:`);
    lines.push(`    name: ${scalar(project.name)}`);
    lines.push(`    entity: ${nullable(project.entity)}`);
    lines.push(`    lead: ${nullable(project.lead)}`);
    lines.push(project.teams.length ? `    teams: [${project.teams.map(scalar).join(', ')}]` : '    teams: []');
    const p = project.provenance;
    lines.push(`    provenance: { registered_by: ${scalar(p.registered_by)}, registered_at: ${scalar(p.registered_at)}, updated_at: ${scalar(p.updated_at)} }`);
  }
  return `${lines.join('\n')}\n`;
}

// --- reading the file's value into records ---------------------------------------------------

function projectsOf(value: YamlValue, path: string): Record<string, ProjectRecord> {
  if (!isMap(value)) throw new ProjectsError(`${path}: expected a map with a "projects" key`);
  const section = value.projects;
  if (section === null || section === undefined) return {};
  if (!isMap(section)) throw new ProjectsError(`${path}: "projects" must be a map of project IDs`);
  const out: Record<string, ProjectRecord> = {};
  for (const [id, raw] of Object.entries(section)) out[id] = recordOf(id, raw, path);
  return out;
}

function recordOf(id: string, raw: YamlValue, path: string): ProjectRecord {
  const bad = (what: string): never => {
    throw new ProjectsError(`${path}: project ${id}: ${what}`);
  };
  if (!isMap(raw)) return bad('expected a map');
  const text = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : bad(`"${key}" must be text`));
  const entity = raw.entity ?? null;
  if (entity !== null && typeof entity !== 'string') bad('"entity" must be text or null');
  const lead = raw.lead ?? null;
  if (lead !== null && typeof lead !== 'string') bad('"lead" must be an agent ID or null');
  const teams = raw.teams ?? [];
  if (!Array.isArray(teams)) bad('"teams" must be a list of team IDs');
  for (const [i, team] of (teams as YamlValue[]).entries()) {
    if (typeof team !== 'string') bad(`teams line ${i + 1} must be a team ID`);
  }
  const prov = raw.provenance;
  if (!isMap(prov)) return bad('"provenance" must be a map');
  for (const key of ['registered_by', 'registered_at', 'updated_at']) {
    if (typeof prov[key] !== 'string') bad(`provenance: "${key}" must be text`);
  }
  return {
    id,
    name: text('name'),
    entity: entity as string | null,
    lead: lead as string | null,
    teams: teams as string[],
    provenance: { registered_by: prov.registered_by as string, registered_at: prov.registered_at as string, updated_at: prov.updated_at as string },
  };
}

function isMap(value: YamlValue | undefined): value is { [key: string]: YamlValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
