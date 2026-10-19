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
import { DELIVERY_LEGS, isLivenessSeconds, isSenderNameMode, SENDER_NAME_MODES, type DeliveryLeg, type LivenessThresholds, type SenderNameMode } from '../settings/inherit.ts';
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
  /**
   * The project's word on the delivery order — the legs a send walks before the team file's own
   * words are read — or absent when the project declares none. Written under `delivery_order`;
   * no command writes it in this build, but a hand-written one reads, and an upsert keeps it.
   */
  deliveryOrder?: DeliveryLeg[];
  /**
   * The project's word on the liveness defaults — the idle-to-lead, idle-to-owner and blind
   * windows, in seconds — or absent when the project declares none. Written under `liveness`.
   * A project may tighten a default (a shorter window), never loosen it: a longer word is set
   * aside where the thresholds resolve, and the inherited value stands.
   */
  liveness?: Partial<LivenessThresholds>;
  /**
   * How a sender reads in TeamCLI's own headlines for this project's teams: `auto` (the default
   * when the record declares none), `nickname`, `seat`, or `seat@team`. Written under
   * `sender_name`. It changes the human headline only — every record keeps the registry id.
   */
  senderName?: SenderNameMode;
  /** Owner-signed project-level policy declarations (Kernel amendment 02 §2.12), when present. */
  policies?: Record<string, YamlValue>;
  provenance: ProjectProvenance;
};

/** The keys `liveness` may carry, in the order the writer emits them. */
const LIVENESS_KEYS = ['idle_lead_seconds', 'idle_owner_seconds', 'blind_after_seconds'] as const;

/** One `liveness` map, checked: only the three keys, each a whole number of seconds, at least
 *  one — the same rule the resolver judges every liveness word by. */
function checkedLiveness(value: unknown, bad: (what: string) => never): Partial<LivenessThresholds> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad('"liveness" must be a map of thresholds');
  const out: Partial<LivenessThresholds> = {};
  for (const [key, held] of Object.entries(value as Record<string, unknown>)) {
    if (!(LIVENESS_KEYS as readonly string[]).includes(key)) {
      bad(`"liveness" has no threshold "${key}"; the keys are ${LIVENESS_KEYS.join(', ')}`);
    }
    if (typeof held !== 'number' || !isLivenessSeconds(held)) {
      bad(`liveness "${key}" must be a whole number of seconds, at least 1`);
    }
    out[key as keyof LivenessThresholds] = held;
  }
  return out;
}

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
        ...(fields.deliveryOrder !== undefined ? { deliveryOrder: fields.deliveryOrder } : {}),
        ...(fields.liveness !== undefined ? { liveness: fields.liveness } : {}),
        ...(fields.senderName !== undefined ? { senderName: fields.senderName } : {}),
        ...(fields.policies !== undefined ? { policies: fields.policies } : {}),
        provenance: { registered_by: by ?? 'team', registered_at: at, updated_at: at },
      };
    }
    if (record.policies !== undefined && Object.keys(record.policies).length === 0) {
      delete record.policies;
    }
    if (typeof record.name !== 'string' || !record.name) throw new ProjectsError('a project needs a name');
    if (record.entity !== null && typeof record.entity !== 'string') throw new ProjectsError('"entity" must be text or null');
    if (record.lead !== null && typeof record.lead !== 'string') throw new ProjectsError('"lead" must be an agent ID or null');
    if (!Array.isArray(record.teams)) throw new ProjectsError('"teams" must be a list of team IDs');
    for (const team of record.teams) {
      if (typeof team !== 'string' || !team) throw new ProjectsError('a team ID in "teams" must be text');
    }
    // The word the reader takes: a non-empty list of distinct leg names, so what this writer
    // stores is what `recordOf` reads back.
    if (record.deliveryOrder !== undefined) {
      if (!Array.isArray(record.deliveryOrder)) throw new ProjectsError('"delivery_order" must be a list of legs');
      if (record.deliveryOrder.length === 0) throw new ProjectsError('"delivery_order" must name at least one leg');
      if (new Set(record.deliveryOrder).size !== record.deliveryOrder.length) throw new ProjectsError('"delivery_order" names a leg twice');
      for (const leg of record.deliveryOrder) {
        if (typeof leg !== 'string' || !(DELIVERY_LEGS as readonly string[]).includes(leg)) {
          throw new ProjectsError(`a "delivery_order" leg must be one of: ${DELIVERY_LEGS.join(', ')}`);
        }
      }
    }
    if (record.liveness !== undefined) {
      record = { ...record, liveness: checkedLiveness(record.liveness, (what) => { throw new ProjectsError(what); }) };
    }
    // The word must be one a reader can act on: a headline is never guessed at, and a project
    // record a later reader refuses would make every display in its teams fail.
    if (record.senderName !== undefined && !isSenderNameMode(record.senderName)) {
      throw new ProjectsError(`"sender_name" must be one of: ${SENDER_NAME_MODES.join(', ')}`);
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

function emitPolicyValue(v: YamlValue): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((item) => emitPolicyValue(item)).join(', ')}]`;
  return JSON.stringify(v);
}

function emitPolicies(indent: string, policies: Record<string, YamlValue>): string[] {
  const keys = Object.keys(policies).sort();
  if (keys.length === 0) return [];
  const lines = [`${indent}policies:`];
  for (const name of keys) {
    const entry = policies[name];
    if (isMap(entry)) {
      lines.push(`${indent}  ${scalar(name)}:`);
      for (const [k, v] of Object.entries(entry)) {
        lines.push(`${indent}    ${scalar(k)}: ${emitPolicyValue(v ?? null)}`);
      }
    } else {
      lines.push(`${indent}  ${scalar(name)}: ${emitPolicyValue(entry ?? null)}`);
    }
  }
  return lines;
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
    // Only when the project declares one: a registry written before the field keeps its bytes,
    // so a record read and written back is the file it was.
    if (project.deliveryOrder) lines.push(`    delivery_order: [${project.deliveryOrder.map(scalar).join(', ')}]`);
    if (project.senderName !== undefined) lines.push(`    sender_name: ${scalar(project.senderName)}`);
    if (project.liveness !== undefined) {
      const said = LIVENESS_KEYS
        .filter((key) => project.liveness?.[key] !== undefined)
        .map((key) => `${key}: ${project.liveness?.[key]}`);
      if (said.length) lines.push(`    liveness: { ${said.join(', ')} }`);
    }
    if (project.policies && Object.keys(project.policies).length > 0) {
      lines.push(...emitPolicies('    ', project.policies));
    }
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
  // The project's word on the delivery order, when the record writes one — the shape the team
  // file's own reader takes (src/file/sections/delivery_order.ts), so one word means one thing.
  const order = raw.delivery_order ?? undefined;
  if (order !== undefined) {
    if (!Array.isArray(order)) bad('"delivery_order" must be a list of legs');
    const legs = order as YamlValue[];
    if (legs.length === 0) bad('"delivery_order" must name at least one leg');
    for (const [i, leg] of legs.entries()) {
      if (typeof leg !== 'string' || !(DELIVERY_LEGS as readonly string[]).includes(leg)) {
        bad(`delivery_order line ${i + 1} must be one of: ${DELIVERY_LEGS.join(', ')}`);
      }
    }
    if (new Set(legs).size !== legs.length) bad('"delivery_order" names a leg twice');
  }
  // The project's word on the liveness defaults, when the record writes one: seconds, under the
  // same names the settings carry.
  const liveness = raw.liveness === undefined
    ? undefined
    : checkedLiveness(raw.liveness, (what) => bad(what));
  // The project's word on how a sender reads in a headline, when the record writes one.
  const senderNameWord = raw.sender_name ?? undefined;
  if (senderNameWord !== undefined && !isSenderNameMode(senderNameWord)) {
    bad(`"sender_name" must be one of: ${SENDER_NAME_MODES.join(', ')}`);
  }
  const policies = isMap(raw.policies) && Object.keys(raw.policies).length > 0 ? raw.policies : undefined;
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
    ...(order !== undefined ? { deliveryOrder: order as DeliveryLeg[] } : {}),
    ...(liveness !== undefined ? { liveness } : {}),
    ...(senderNameWord !== undefined ? { senderName: senderNameWord as SenderNameMode } : {}),
    ...(policies !== undefined ? { policies } : {}),
    provenance: { registered_by: prov.registered_by as string, registered_at: prov.registered_at as string, updated_at: prov.updated_at as string },
  };
}

function isMap(value: YamlValue | undefined): value is { [key: string]: YamlValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
