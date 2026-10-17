// The agent registry (layer 2): one file per agent, `<home>/.config/team/agents/<id>.yaml`.
// The agent id is assigned once at registration and is immutable: it is never reused, never
// renamed, never re-derived from a seat name. Every write goes through a temporary file and a
// rename, and a read-modify-write holds the folder's lock.
//
// A record's identity is (reach.team, reach.seat) — the team id and the seat the live file
// declares — and never the pane: a pane change re-points the same record, and one pair holds at
// most one live record. Records are append-only: ending a seat marks its record ended and takes
// it out of the roster's reading, but nothing deletes it, so its history stays readable. And a
// record confers no right: it says which agent a seat is, never what the seat may do — admission
// decides from the pair's own relationships and capabilities, never from a record's existence
// (src/send/admit.ts).

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSeatId, withLock } from '../state.ts';
import { parseYaml, toValue, type YamlValue } from '../yaml.ts';

export const AGENT_ID_PATTERN = /^agt_[0-9a-f]{12}$/;

export const LIFECYCLES = ['registered', 'running', 'stopped', 'retired'] as const;
export type AgentLifecycle = (typeof LIFECYCLES)[number];

/** The triple the commit gate checks. */
export type AgentSigning = { model: string; version: string; role: string };

/** Where the agent can be reached: unifies the team, seat and herdr namespaces. */
export type AgentReach = {
  team: string;
  seat: string;
  session: string;
  /** The current herdr pane; re-pointed on relaunch. */
  pane: string | null;
  /** A cross-session address if the agent has one, else null. */
  address: string | null;
};

/** Who wrote the record and when. `registered_by` and `registered_at` are the first
 *  registration's and never change; `dev_mode` says whether the run that last wrote the record's
 *  registration had dev mode on — the caller gate folded into a warning — and is set and cleared
 *  by the writers that know, so a record a dev-mode run made says so until a run in force
 *  rewrites it. */
export type AgentProvenance = {
  registered_by: string;
  registered_at: string;
  updated_at: string;
  /** The mark of a record a dev-mode run wrote. `registered_by` is the registrant's and never
   *  changes, so the caller that run admitted — and when it wrote — is kept beside the mark: a
   *  record registered by the owner and re-written under dev mode by another caller names that
   *  caller, not the owner. An older record carries the mark without them. */
  dev_mode?: boolean;
  dev_mode_by?: string;
  dev_mode_at?: string;
};

export type Agent = {
  /** `agt_` plus 12 lowercase hex. Immutable. */
  id: string;
  /** Display only: a rename edits this field and nothing else. */
  name: string;
  signing: AgentSigning;
  /** The vendor. */
  lab: string;
  cli: string;
  /** A launcher reference, once launchers exist; until then the raw line lives in `launch`. */
  launcher: string | null;
  launch: string;
  reach: AgentReach;
  mcp: string[];
  skills: string[];
  lifecycle: AgentLifecycle;
  provenance: AgentProvenance;
  /** The stable `seat_<12 hex>` handle `team seats` shows, kept for continuity when the seat had one. */
  seat_handle?: string | null;
};

export type AgentInit = Omit<Agent, 'id' | 'provenance'> & { by: string; devMode?: boolean };

/** What `updateAgent` accepts. The nested records merge field by field, so a relaunch can re-point
 *  `reach.pane` alone; `id`, `provenance.registered_by` and `provenance.registered_at` are never
 *  changed. `provenance.dev_mode` is the mark a writer may state — true marks the record as one a
 *  dev-mode run wrote, false takes the mark off — and `provenance.dev_mode_by`, with it, names
 *  the caller that run admitted: the writer states who, `updateAgent` stamps when. */
export type AgentPatch = Partial<Omit<Agent, 'id' | 'signing' | 'reach' | 'provenance'>> & {
  signing?: Partial<AgentSigning>;
  reach?: Partial<AgentReach>;
  provenance?: Partial<AgentProvenance>;
};

export function agentsDir(home: string): string {
  return join(home, '.config', 'team', 'agents');
}

function agentFile(home: string, id: string): string {
  return join(agentsDir(home), `${id}.yaml`);
}

export function isAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID_PATTERN.test(value);
}

/** Every valid agent record, by id. A file that does not parse or validate is skipped, never fatal. */
export function readAgents(home: string): Agent[] {
  let names: string[];
  try {
    names = readdirSync(agentsDir(home));
  } catch {
    return [];
  }
  const agents: Agent[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.yaml')) continue;
    const id = name.slice(0, -'.yaml'.length);
    if (!isAgentId(id)) continue;
    const agent = readAgentFile(join(agentsDir(home), name), id);
    if (agent) agents.push(agent);
  }
  return agents;
}

export function getAgent(home: string, id: string): Agent | null {
  if (!isAgentId(id)) return null;
  return readAgentFile(agentFile(home, id), id);
}

/** Assigns the id, records who registered and when, and writes the file atomically. A run under
 *  dev mode hands in `devMode` and the record keeps the mark. */
export function registerAgent(home: string, init: AgentInit): Agent {
  const dir = agentsDir(home);
  return withLock(dir, () => {
    let id = mintAgentId();
    while (existsSync(agentFile(home, id))) id = mintAgentId();
    const now = new Date().toISOString();
    const { by, devMode, ...fields } = init;
    const agent: Agent = {
      ...fields,
      id,
      mcp: [...fields.mcp],
      skills: [...fields.skills],
      provenance: {
        registered_by: by,
        registered_at: now,
        updated_at: now,
        ...(devMode === true ? { dev_mode: true, dev_mode_by: by, dev_mode_at: now } : {}),
      },
    };
    const problem = invalid(agent);
    if (problem) throw new Error(`cannot register the agent: ${problem}`);
    writeAgentFile(agentFile(home, id), agent);
    return agent;
  });
}

/** Applies the patch and rewrites the file atomically. `id`, `registered_by` and `registered_at`
 *  never change; `updated_at` is set to now, and `dev_mode` follows the patch when it states one.
 *  Throws when there is no such agent. */
export function updateAgent(home: string, id: string, patch: AgentPatch): Agent {
  if (!isAgentId(id)) throw new Error(`"${id}" is not an agent id`);
  return withLock(agentsDir(home), () => {
    const file = agentFile(home, id);
    const current = readAgentFile(file, id);
    if (!current) throw new Error(`no agent ${id} in ${agentsDir(home)}`);
    const { signing, reach, provenance, ...rest } = patch;
    const nextProvenance: AgentProvenance = { ...current.provenance, updated_at: new Date().toISOString() };
    if (provenance?.dev_mode === true) {
      nextProvenance.dev_mode = true;
      // Who wrote it under dev mode, and when: a record the owner registered and a later folded
      // run wrote again keeps `registered_by` the owner's, so the caller that run admitted is
      // recorded beside the mark. A state with no caller keeps the one an earlier dev write named.
      if (provenance.dev_mode_by !== undefined) nextProvenance.dev_mode_by = provenance.dev_mode_by;
      nextProvenance.dev_mode_at = nextProvenance.updated_at;
    } else if (provenance?.dev_mode === false) {
      delete nextProvenance.dev_mode;
      delete nextProvenance.dev_mode_by;
      delete nextProvenance.dev_mode_at;
    }
    const next: Agent = {
      ...current,
      ...definedOnly(rest),
      id: current.id,
      signing: { ...current.signing, ...definedOnly(signing ?? {}) },
      reach: { ...current.reach, ...definedOnly(reach ?? {}) },
      provenance: nextProvenance,
    };
    const problem = invalid(next);
    if (problem) throw new Error(`cannot update ${id}: ${problem}`);
    writeAgentFile(file, next);
    return next;
  });
}

/** Records the agent's cross-session address — the socket a send can reach the live session at —
 *  or clears it with null. The launch and register paths write it; nothing here reads herdr, so a
 *  caller hands in what it found. The pid the path's own name carries is how a later read tells a
 *  live address from one a relaunch left behind. */
export function recordAgentAddress(home: string, id: string, address: string | null): Agent {
  return updateAgent(home, id, { reach: { address } });
}

/** The agent that holds a seat of a team. A retired agent no longer holds it; if more than one
 *  does, the most recently updated wins. */
export function findAgent(home: string, query: { team: string; seat: string }): Agent | null {
  let found: Agent | null = null;
  for (const agent of readAgents(home)) {
    if (agent.lifecycle === 'retired') continue;
    if (agent.reach.team !== query.team || agent.reach.seat !== query.seat) continue;
    if (!found || agent.provenance.updated_at >= found.provenance.updated_at) found = agent;
  }
  return found;
}

function mintAgentId(): string {
  return `agt_${randomBytes(6).toString('hex')}`;
}

// A patch field set to `undefined` means "not given"; null is a real value (a pane that is gone).
function definedOnly<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

function writeAgentFile(path: string, agent: Agent): void {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, emit(agent));
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

function readAgentFile(path: string, id: string): Agent | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let value: YamlValue;
  try {
    value = toValue(parseYaml(text));
  } catch {
    return null;
  }
  const agent = fromValue(value);
  // The file name is the id: a file whose body says otherwise is not trusted. A record the writer
  // would refuse is not handed out either.
  if (!agent || agent.id !== id || invalid(agent)) return null;
  return agent;
}

// ---- validation --------------------------------------------------------------------------

type Obj = { [key: string]: YamlValue };

function isObj(value: YamlValue | undefined): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: YamlValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function strOrNull(value: YamlValue | undefined): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : undefined;
}

function strings(value: YamlValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

// A scalar the emitter wrote quoted always comes back a string; a plain number-looking value in a
// hand-edited file (a version `5.5`) is read as a string too, since these fields are text.
function text(value: YamlValue | undefined): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function fromValue(value: YamlValue): Agent | null {
  if (!isObj(value)) return null;
  const signing = value.signing;
  const reach = value.reach;
  const provenance = value.provenance;
  if (!isObj(signing) || !isObj(reach) || !isObj(provenance)) return null;
  const mcp = value.mcp === undefined ? [] : strings(value.mcp);
  const skills = value.skills === undefined ? [] : strings(value.skills);
  const launcher = strOrNull(value.launcher);
  const pane = strOrNull(reach.pane);
  const address = strOrNull(reach.address);
  const handle = strOrNull(value.seat_handle);
  const id = str(value.id);
  const name = str(value.name);
  const model = text(signing.model);
  const version = text(signing.version);
  const role = text(signing.role);
  const lab = str(value.lab);
  const cli = str(value.cli);
  const launch = value.launch === undefined || value.launch === null ? '' : str(value.launch);
  const team = text(reach.team);
  const seat = text(reach.seat);
  const session = text(reach.session);
  const registeredBy = str(provenance.registered_by);
  const registeredAt = str(provenance.registered_at);
  const updatedAt = str(provenance.updated_at);
  const lifecycle = value.lifecycle;
  if (
    id === null || name === null || model === null || version === null || role === null ||
    lab === null || cli === null || launch === null || team === null || seat === null ||
    session === null || registeredBy === null || registeredAt === null || updatedAt === null ||
    mcp === null || skills === null || launcher === undefined || pane === undefined ||
    address === undefined || handle === undefined
  ) {
    return null;
  }
  if (typeof lifecycle !== 'string' || !(LIFECYCLES as readonly string[]).includes(lifecycle)) return null;
  const agent: Agent = {
    id,
    name,
    signing: { model, version, role },
    lab,
    cli,
    launcher,
    launch,
    reach: { team, seat, session, pane, address },
    mcp,
    skills,
    lifecycle: lifecycle as AgentLifecycle,
    provenance: {
      registered_by: registeredBy,
      registered_at: registeredAt,
      updated_at: updatedAt,
      // Only the writer's own `true` counts: any other value reads as no mark at all, and the
      // caller and time are the mark's own — a file without them is an older record.
      ...(provenance.dev_mode === true
        ? {
            dev_mode: true,
            ...(typeof provenance.dev_mode_by === 'string' ? { dev_mode_by: provenance.dev_mode_by } : {}),
            ...(typeof provenance.dev_mode_at === 'string' ? { dev_mode_at: provenance.dev_mode_at } : {}),
          }
        : {}),
    },
  };
  if (handle !== null) agent.seat_handle = handle;
  return agent;
}

// What a record must hold to be written: the same rules a read applies, so a file never lands
// that the next read would skip.
function invalid(agent: Agent): string | null {
  if (!isAgentId(agent.id)) return 'the id is not agt_ plus 12 hex';
  if (!agent.name.trim()) return 'the name is empty';
  if (!agent.signing.model.trim() || !agent.signing.version.trim() || !agent.signing.role.trim()) {
    return 'the signing triple (model, version, role) is incomplete';
  }
  if (!agent.reach.team.trim() || !agent.reach.seat.trim()) return 'reach.team and reach.seat are required';
  if (!(LIFECYCLES as readonly string[]).includes(agent.lifecycle)) return `"${agent.lifecycle}" is not a lifecycle state`;
  if (agent.seat_handle != null && !isSeatId(agent.seat_handle)) return 'seat_handle is not seat_ plus 12 hex';
  return null;
}

// ---- writing -----------------------------------------------------------------------------

// The yaml parser reads a subset and the repo has no writer, so this writes that subset: block
// maps, one flow-free layout, and every string double-quoted (JSON escapes are valid yaml ones).
function quote(value: string): string {
  return JSON.stringify(value);
}

function scalarOrNull(value: string | null | undefined): string {
  return value === null || value === undefined ? 'null' : quote(value);
}

function list(items: string[]): string {
  return items.length ? `[${items.map(quote).join(', ')}]` : '[]';
}

function emit(agent: Agent): string {
  const lines = [
    `id: ${quote(agent.id)}`,
    `name: ${quote(agent.name)}`,
    'signing:',
    `  model: ${quote(agent.signing.model)}`,
    `  version: ${quote(agent.signing.version)}`,
    `  role: ${quote(agent.signing.role)}`,
    `lab: ${quote(agent.lab)}`,
    `cli: ${quote(agent.cli)}`,
    `launcher: ${scalarOrNull(agent.launcher)}`,
    `launch: ${quote(agent.launch)}`,
    'reach:',
    `  team: ${quote(agent.reach.team)}`,
    `  seat: ${quote(agent.reach.seat)}`,
    `  session: ${quote(agent.reach.session)}`,
    `  pane: ${scalarOrNull(agent.reach.pane)}`,
    `  address: ${scalarOrNull(agent.reach.address)}`,
    `mcp: ${list(agent.mcp)}`,
    `skills: ${list(agent.skills)}`,
    `lifecycle: ${quote(agent.lifecycle)}`,
    'provenance:',
    `  registered_by: ${quote(agent.provenance.registered_by)}`,
    `  registered_at: ${quote(agent.provenance.registered_at)}`,
    `  updated_at: ${quote(agent.provenance.updated_at)}`,
  ];
  // Written only when it holds: a record with no mark does not carry a `dev_mode: false` line,
  // so the files an ordinary launch writes read exactly as they always did. The caller the
  // dev-mode run admitted, and when, sit under the mark.
  if (agent.provenance.dev_mode === true) {
    lines.push('  dev_mode: true');
    if (agent.provenance.dev_mode_by !== undefined) lines.push(`  dev_mode_by: ${quote(agent.provenance.dev_mode_by)}`);
    if (agent.provenance.dev_mode_at !== undefined) lines.push(`  dev_mode_at: ${quote(agent.provenance.dev_mode_at)}`);
  }
  if (agent.seat_handle != null) lines.push(`seat_handle: ${quote(agent.seat_handle)}`);
  return `${lines.join('\n')}\n`;
}
