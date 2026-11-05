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

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { editedRecordText, withValue } from '../config/team-record.ts';
import type { RulesEditPlan } from '../entities.ts';
import {
  DELIVERY_LEGS,
  isLivenessSeconds,
  isSenderNameMode,
  LEGACY_ORDER_WORDS,
  SENDER_NAME_MODES,
  type LivenessThresholds,
  type OrderWord,
  type SenderNameMode,
} from '../settings/inherit.ts';
import { writeAtomic } from '../state.ts';
import { leadWordProblem } from '../lead.ts';
import { currentRunMemo } from '../run-memo.ts';
import { parseYaml, toValue, YamlError, type YamlValue } from '../yaml.ts';
import { teamIdOf } from './teams.ts';

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
  /**
   * The seat that leads this project's teams by default, by seat name — not the
   * project lead above, which is an agent ID. Absent when the project declares none: the
   * entity's word, then the universe's, stands. Written under `lead_seat`; no command writes it
   * in this build, but a hand-written one reads, and an upsert keeps it.
   */
  leadSeat?: string;
  /** The team IDs this project groups. */
  teams: string[];
  /**
   * The project's word on the delivery order — the legs a send walks before the team file's own
   * words are read — or absent when the project declares none. Written under `delivery_order`;
   * no command writes it in this build, but a hand-written one reads, and an upsert keeps it.
   * A word an older build wrote may still name the retired `mcp-inbox`: it reads, and the walk
   * drops it at resolution (`src/settings/resolve.ts`).
   */
  deliveryOrder?: OrderWord[];
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
  /** Owner-signed project-level settings, one signed entry per key, when present. */
  settings?: Record<string, YamlValue>;
  /** Project-wide standing rules (`projects.<id>.rules`), inherited by every home team's seats. */
  rules?: string[];
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

function cloneProjectRecord(record: ProjectRecord): ProjectRecord {
  return {
    ...record,
    teams: [...record.teams],
    ...(record.deliveryOrder !== undefined ? { deliveryOrder: [...record.deliveryOrder] } : {}),
    ...(record.liveness !== undefined ? { liveness: { ...record.liveness } } : {}),
    provenance: { ...record.provenance },
    ...(record.policies !== undefined ? { policies: { ...record.policies } } : {}),
    ...(record.settings !== undefined ? { settings: { ...record.settings } } : {}),
    ...(record.rules !== undefined ? { rules: [...record.rules] } : {}),
  };
}

function cloneProjects(records: Record<string, ProjectRecord>): Record<string, ProjectRecord> {
  const out: Record<string, ProjectRecord> = {};
  for (const [id, record] of Object.entries(records)) {
    out[id] = cloneProjectRecord(record);
  }
  return out;
}

/** Every registered project, by project ID. A missing file is no projects; a file that cannot
 *  be read — a corrupt one, or one under a folder this user cannot search — throws
 *  `ProjectsError`, so no reader takes an unreadable registry as an empty one (a team no
 *  project names reads as its own project) and no writer replaces a file it could not read. */
export function readProjects(home: string): Record<string, ProjectRecord> {
  const memo = currentRunMemo();
  if (memo !== null) {
    const cached = memo.projects.get(home);
    if (cached !== undefined) return cloneProjects(cached);
    if (memo.projectsRaw.has(home)) {
      const raw = memo.projectsRaw.get(home);
      if (raw === null || raw === undefined) {
        memo.projects.set(home, {});
        return {};
      }
      const parsed = projectsOf(raw, projectsFile(home));
      memo.projects.set(home, cloneProjects(parsed));
      return parsed;
    }
  }
  const path = projectsFile(home);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // Absence is ENOENT alone: an existence check would read a folder this user cannot search
    // as "no project registry".
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      memo?.projects.set(home, {});
      memo?.projectsRaw.set(home, null);
      return {};
    }
    throw new ProjectsError(`${path}: ${(error as Error).message}`);
  }
  if (!text.trim()) {
    memo?.projects.set(home, {});
    memo?.projectsRaw.set(home, null);
    return {};
  }
  let value: YamlValue;
  try {
    value = toValue(parseYaml(text));
  } catch (error) {
    if (error instanceof YamlError) throw new ProjectsError(`${path}: line ${error.line}: ${error.message}`);
    throw error;
  }
  memo?.projectsRaw.set(home, value);
  const parsed = projectsOf(value, path);
  memo?.projects.set(home, cloneProjects(parsed));
  return parsed;
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
export type ProjectPatch = Partial<Omit<ProjectRecord, 'id' | 'provenance'>> & {
  by?: string;
  at?: string;
  /** Entries to set, or to remove with `null`, inside the record's settings map. Applied to the
   *  record the writer reads under the registry lock, so two writes of different keys both land. */
  settingsDelta?: Record<string, YamlValue | null>;
};

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
    const { by, at: _at, settingsDelta, ...fields } = patch;
    let record: ProjectRecord;
    if (prior) {
      record = { ...prior, ...definedOnly(fields), provenance: { ...prior.provenance, updated_at: at } };
    } else {
      if (typeof fields.name !== 'string' || !fields.name) throw new ProjectsError('a new project needs a name');
      record = {
        name: fields.name,
        entity: fields.entity ?? null,
        lead: fields.lead ?? null,
        ...(fields.leadSeat !== undefined ? { leadSeat: fields.leadSeat } : {}),
        teams: fields.teams ?? [],
        ...(fields.deliveryOrder !== undefined ? { deliveryOrder: fields.deliveryOrder } : {}),
        ...(fields.liveness !== undefined ? { liveness: fields.liveness } : {}),
        ...(fields.senderName !== undefined ? { senderName: fields.senderName } : {}),
        ...(fields.policies !== undefined ? { policies: fields.policies } : {}),
        ...(fields.settings !== undefined ? { settings: fields.settings } : {}),
        ...(fields.rules !== undefined ? { rules: fields.rules } : {}),
        provenance: { registered_by: by ?? 'team', registered_at: at, updated_at: at },
      };
    }
    if (record.rules !== undefined) {
      if (!Array.isArray(record.rules)) throw new ProjectsError('"rules" must be a list of strings');
      const cleaned: string[] = [];
      for (const r of record.rules) {
        if (typeof r !== 'string') throw new ProjectsError('a rule in "rules" must be text');
        const trimmed = r.trim();
        if (trimmed.length > 0) cleaned.push(trimmed);
      }
      if (cleaned.length > 0) record.rules = cleaned;
      else delete record.rules;
    }
    if (settingsDelta !== undefined) {
      const settings: Record<string, YamlValue> = { ...(record.settings ?? {}) };
      for (const [key, entry] of Object.entries(settingsDelta)) {
        if (entry === null) delete settings[key];
        else settings[key] = entry;
      }
      record.settings = settings;
    }
    if (record.policies !== undefined && Object.keys(record.policies).length === 0) {
      delete record.policies;
    }
    if (record.settings !== undefined && Object.keys(record.settings).length === 0) {
      delete record.settings;
    }
    if (record.settings !== undefined && !isMap(record.settings)) throw new ProjectsError('"settings" must be a map');
    if (typeof record.name !== 'string' || !record.name) throw new ProjectsError('a project needs a name');
    if (record.entity !== null && typeof record.entity !== 'string') throw new ProjectsError('"entity" must be text or null');
    if (record.lead !== null && typeof record.lead !== 'string') throw new ProjectsError('"lead" must be an agent ID or null');
    if (record.leadSeat !== undefined) {
      if (typeof record.leadSeat !== 'string') throw new ProjectsError('"lead_seat" must be one seat name');
      const problem = leadWordProblem(record.leadSeat);
      if (problem !== null) throw new ProjectsError(`"lead_seat" ${problem}`);
    }
    if (!Array.isArray(record.teams)) throw new ProjectsError('"teams" must be a list of team IDs');
    for (const team of record.teams) {
      if (typeof team !== 'string' || !team) throw new ProjectsError('a team ID in "teams" must be text');
    }
    // The word the reader takes: a non-empty list of distinct leg names, so what this writer
    // stores is what `recordOf` reads back. This is a write: a record an older build wrote may
    // still carry the retired `mcp-inbox` alias and `recordOf` reads it, but no upsert names it
    // — the name is no longer a leg, and storing it would only wait for its removal.
    if (record.deliveryOrder !== undefined) {
      if (!Array.isArray(record.deliveryOrder)) throw new ProjectsError('"delivery_order" must be a list of legs');
      if (record.deliveryOrder.length === 0) throw new ProjectsError('"delivery_order" must name at least one leg');
      if (new Set(record.deliveryOrder).size !== record.deliveryOrder.length) throw new ProjectsError('"delivery_order" names a leg twice');
      for (const leg of record.deliveryOrder) {
        if (typeof leg === 'string' && (LEGACY_ORDER_WORDS as readonly string[]).includes(leg)) {
          throw new ProjectsError('delivery_order names mcp-inbox, which is no longer a leg; remove it');
        }
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
// Fixed lock order with `entities.yaml`: if a caller ever holds both locks, `entities.yaml.lock`
// (`lockedEntities` in `src/entities.ts`) is acquired before `projects.yaml.lock` (`locked`).

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
    const memo = currentRunMemo();
    if (memo !== null) {
      memo.projects.delete(home);
      memo.projectsRaw.delete(home);
    }
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
  const memo = currentRunMemo();
  if (memo !== null) {
    memo.projects.clear();
    memo.projectsRaw.clear();
  }
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

function emitSettings(indent: string, settings: Record<string, YamlValue>): string[] {
  const keys = Object.keys(settings).sort();
  if (keys.length === 0) return [];
  const lines = [`${indent}settings:`];
  for (const name of keys) {
    const entry = settings[name];
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
    if (project.leadSeat !== undefined) lines.push(`    lead_seat: ${scalar(project.leadSeat)}`);
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
    if (project.settings && Object.keys(project.settings).length > 0) {
      lines.push(...emitSettings('    ', project.settings));
    }
    if (project.rules && project.rules.length > 0) {
      lines.push('    rules:');
      for (const rule of project.rules) {
        lines.push(`      - ${JSON.stringify(rule)}`);
      }
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
  // An empty list is the empty registry in the shape a JSON view prints: it names no project, so
  // it declares nothing, and reading it as corrupt would refuse every send on a machine that
  // wrote that view back. A list holding an entry is still not a map of project IDs.
  if (Array.isArray(section) && section.length === 0) return {};
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
  const leadSeatRaw = raw.lead_seat ?? undefined;
  let leadSeat: string | undefined;
  if (leadSeatRaw !== undefined) {
    if (typeof leadSeatRaw !== 'string') bad('"lead_seat" must be one seat name');
    const problem = leadWordProblem(leadSeatRaw as string);
    if (problem !== null) bad(`"lead_seat" ${problem}`);
    leadSeat = leadSeatRaw as string;
  }
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
      // The retired `mcp-inbox` reads as an alias an older record may still carry.
      if (typeof leg !== 'string' || !([...DELIVERY_LEGS, ...LEGACY_ORDER_WORDS] as readonly string[]).includes(leg)) {
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
  const settings = isMap(raw.settings) && Object.keys(raw.settings).length > 0 ? raw.settings : undefined;
  let rules: string[] | undefined;
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) bad('"rules" must be a list of strings');
    const cleaned: string[] = [];
    for (const [i, item] of (raw.rules as YamlValue[]).entries()) {
      if (typeof item !== 'string') return bad(`rules line ${i + 1} must be text`);
      const trimmed = item.trim();
      if (trimmed.length > 0) cleaned.push(trimmed);
    }
    if (cleaned.length > 0) rules = cleaned;
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
    ...(leadSeat !== undefined ? { leadSeat } : {}),
    teams: teams as string[],
    ...(order !== undefined ? { deliveryOrder: order as OrderWord[] } : {}),
    ...(liveness !== undefined ? { liveness } : {}),
    ...(senderNameWord !== undefined ? { senderName: senderNameWord as SenderNameMode } : {}),
    ...(policies !== undefined ? { policies } : {}),
    ...(settings !== undefined ? { settings } : {}),
    ...(rules !== undefined ? { rules } : {}),
    provenance: { registered_by: prov.registered_by as string, registered_at: prov.registered_at as string, updated_at: prov.updated_at as string },
  };
}

function isMap(value: YamlValue | undefined): value is { [key: string]: YamlValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Each project's declared standing rules (`projects.<id>.rules`), read directly from
 * `<home>/.config/team/projects.yaml` (including minimal test fixtures without provenance).
 */
export function declaredProjectRules(home: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const path = projectsFile(home);
  if (!existsSync(path)) return out;
  try {
    const parsed = toValue(parseYaml(readFileSync(path, 'utf8')));
    if (!isMap(parsed) || !isMap(parsed.projects)) return out;
    for (const [id, raw] of Object.entries(parsed.projects)) {
      if (!isMap(raw) || !Array.isArray(raw.rules)) continue;
      const list: string[] = [];
      for (const item of raw.rules) {
        if (typeof item !== 'string') continue;
        const line = item.trim();
        if (line !== '') list.push(line);
      }
      if (list.length > 0) {
        out.set(id, list);
      }
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * Resolve one project's declared rules at `home` by project ID (or display name).
 */
export function projectRules(home: string | undefined, projectId: string | null): string[] {
  if (home === undefined || projectId === null) return [];
  const map = declaredProjectRules(home);
  const direct = map.get(projectId);
  if (direct !== undefined) return direct;
  try {
    const slug = projectIdOf(projectId);
    const bySlug = map.get(slug);
    if (bySlug !== undefined) return bySlug;
  } catch {}
  return [];
}

/**
 * Resolve a team's **home** project ID only (a served project's rules never apply).
 * Checks `team.inProject` first, then `teams.yaml` `project_id`, and only falls back to a single
 * non-served entry in `projects.yaml` when neither `in_project` nor `teams.yaml` is present.
 */
export function homeProjectIdOf(
  home: string,
  root: string,
  team?: { inProject?: string | null; alsoIn?: string[] } | null,
): string | null {
  const projPath = projectsFile(home);
  let rawProjects: Record<string, YamlValue> | null = null;
  if (existsSync(projPath)) {
    try {
      const parsed = toValue(parseYaml(readFileSync(projPath, 'utf8')));
      if (isMap(parsed) && isMap(parsed.projects)) {
        rawProjects = parsed.projects;
      }
    } catch {}
  }

  if (team?.inProject !== undefined && team.inProject !== null && team.inProject.trim() !== '') {
    const target = team.inProject.trim();
    if (rawProjects !== null) {
      if (Object.hasOwn(rawProjects, target)) return target;
      for (const [id, raw] of Object.entries(rawProjects)) {
        if (isMap(raw) && raw.name === target) return id;
      }
    }
    try {
      return projectIdOf(target);
    } catch {
      return target;
    }
  }

  const tId = teamIdOf(root);
  const teamsPath = join(home, '.config', 'team', 'teams.yaml');
  if (existsSync(teamsPath)) {
    try {
      const parsed = toValue(parseYaml(readFileSync(teamsPath, 'utf8')));
      if (isMap(parsed) && isMap(parsed.teams) && Object.hasOwn(parsed.teams, tId)) {
        const rec = parsed.teams[tId];
        if (isMap(rec)) {
          return typeof rec.project_id === 'string' && rec.project_id.trim() !== ''
            ? rec.project_id.trim()
            : null;
        }
      }
    } catch {}
  }

  // If `team` explicitly says `inProject: null`, do not guess a project when `teams.yaml` exists or
  // when multiple projects or `also_in` name this team. When no `teams.yaml` exists and a synthetic
  // test placed `tId` in a single project in `projects.yaml` without `also_in`, return that project.
  if (rawProjects !== null) {
    const servedSet = new Set((team?.alsoIn ?? []).map((n) => n.toLowerCase()));
    const matches: string[] = [];
    for (const [id, raw] of Object.entries(rawProjects)) {
      if (!isMap(raw) || !Array.isArray(raw.teams)) continue;
      if (!raw.teams.includes(tId)) continue;
      const nameLower = typeof raw.name === 'string' ? raw.name.toLowerCase() : '';
      if (servedSet.has(id.toLowerCase()) || (nameLower !== '' && servedSet.has(nameLower))) continue;
      matches.push(id);
    }
    if (matches.length === 1 && team?.inProject === undefined) {
      return matches[0] ?? null;
    }
    if (matches.length === 1 && !existsSync(teamsPath) && team?.inProject === null) {
      return matches[0] ?? null;
    }
  }
  return null;
}

function renderProjectDiff(path: string, before: string, after: string): string {
  if (before === after) return `nothing changed in ${path}`;
  const beforeLines = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const afterLines = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  const out: string[] = [`--- ${path}`, `+++ ${path}`];
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i += 1) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === a && b !== undefined) continue;
    if (b !== undefined) out.push(`- ${b}`);
    if (a !== undefined) out.push(`+ ${a}`);
  }
  return out.join('\n');
}

export type SetProjectRulesRefusal = {
  ok: false;
  kind: 'path' | 'unreadable';
  why: string;
};

export type SetProjectRulesOutcome =
  | ({ ok: true; written: boolean } & RulesEditPlan)
  | SetProjectRulesRefusal;

/**
 * Plan setting `projects.<id>.rules` in `<home>/.config/team/projects.yaml` without writing to disk.
 * Used for `--dry-run` and inside `setProjectRules` under `projects.yaml.lock`.
 */
export function planProjectRulesSet(
  home: string,
  projectId: string,
  rules: string[],
  opts: { allowDisplayName?: boolean } = {},
): RulesEditPlan {
  const path = projectsFile(home);
  const cleaned = rules.map((r) => r.trim()).filter((r) => r.length > 0);
  if (!existsSync(path)) {
    throw new ProjectsError(`${path} does not exist: no entry for project "${projectId}"; nothing was written`);
  }
  let before: string;
  try {
    before = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ProjectsError(`${path}: ${(error as Error).message}`);
  }
  let parsed: YamlValue;
  try {
    parsed = toValue(parseYaml(before));
  } catch (error) {
    if (error instanceof YamlError) {
      throw new ProjectsError(`${path}: line ${error.line}: ${error.message}`);
    }
    throw new ProjectsError(`${path}: ${(error as Error).message}`);
  }
  if (!isMap(parsed)) {
    throw new ProjectsError(`${path}: expected a map of projects`);
  }
  if (!isMap(parsed.projects)) {
    throw new ProjectsError(`${path}: no entry for project "${projectId}"; nothing was written`);
  }
  let resolvedId = projectId;
  if (!Object.hasOwn(parsed.projects, resolvedId)) {
    const byDisplay =
      opts.allowDisplayName !== false
        ? Object.entries(parsed.projects).find(
            ([, raw]) => isMap(raw) && raw.name === projectId,
          )
        : undefined;
    if (byDisplay) {
      resolvedId = byDisplay[0];
    } else if (opts.allowDisplayName !== false) {
      let derivedId: string | null = null;
      try {
        derivedId = projectIdOf(projectId);
      } catch {}
      if (derivedId !== null && Object.hasOwn(parsed.projects, derivedId)) {
        resolvedId = derivedId;
      } else {
        throw new ProjectsError(`${path}: no entry for project "${projectId}"; nothing was written`);
      }
    } else {
      throw new ProjectsError(`${path}: no entry for project "${projectId}"; nothing was written`);
    }
  }
  const entry = parsed.projects[resolvedId];
  if (!isMap(entry)) {
    throw new ProjectsError(`${path}: project "${resolvedId}" is not a map; nothing was written`);
  }
  const recordPath = ['projects', resolvedId, 'rules'];
  const changed = withValue(parsed, recordPath, cleaned);
  if (!changed.ok) {
    throw new ProjectsError(`project "${resolvedId}" rules: ${changed.why}; nothing was written`);
  }
  if (!changed.changed) {
    return {
      path,
      before,
      after: before,
      diff: `nothing changed in ${path}`,
      changed: false,
      kept: true,
    };
  }
  const edited = editedRecordText(before, recordPath, cleaned, changed.root);
  return {
    path,
    before,
    after: edited.text,
    diff: renderProjectDiff(path, before, edited.text),
    changed: true,
    kept: edited.kept,
  };
}

/**
 * Single locked writer for `projects.<id>.rules` in `<home>/.config/team/projects.yaml`.
 * Acquires `projects.yaml.lock` via `locked()`, re-reads `projects.yaml` under the lock,
 * applies the edit, and writes atomically so concurrent `upsertProject` and rules writes
 * never overwrite one another. Used by both `team config set project.<id>.rules` and
 * `writeProjectRulesSet`.
 */
export function setProjectRules(
  home: string,
  projectId: string,
  rules: string[],
  opts: { dryRun?: boolean; allowDisplayName?: boolean } = {},
): RulesEditPlan & { written: boolean } {
  if (opts.dryRun) {
    const plan = planProjectRulesSet(home, projectId, rules, opts);
    return { ...plan, written: false };
  }
  return locked(home, () => {
    const plan = planProjectRulesSet(home, projectId, rules, opts);
    if (!plan.changed) {
      return { ...plan, written: false };
    }
    mkdirSync(dirname(plan.path), { recursive: true });
    let mode = 0o600;
    try {
      mode = statSync(plan.path).mode & 0o777;
    } catch {}
    const tmp = `${plan.path}.${process.pid}.tmp`;
    writeFileSync(tmp, plan.after, { mode });
    renameSync(tmp, plan.path);
    const memo = currentRunMemo();
    if (memo !== null) {
      memo.projects.clear();
      memo.projectsRaw.clear();
    }
    return { ...plan, written: true };
  });
}

/**
 * Write `projects.<id>.rules` in `<home>/.config/team/projects.yaml` (or return the plan without
 * writing when `opts.dryRun` is true), delegating to `setProjectRules` under `projects.yaml.lock`.
 */
export function writeProjectRulesSet(
  home: string,
  projectId: string,
  rules: string[],
  opts: { dryRun?: boolean } = {},
): RulesEditPlan & { written: boolean } {
  return setProjectRules(home, projectId, rules, opts);
}

