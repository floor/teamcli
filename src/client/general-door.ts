// The general door: one place, in the dispatcher, where every command accepts a general grant.
// `team <command> ... --general <grant.json> --key <client.key>` is verified here, before the
// command runs, for the op this line reaches and for the entity of the team it acts on. An
// admitted run reaches the command as the owner (its caller is the owner, so no detached or
// terminal refusal applies), with the two options taken off its argv.
//
// The op is the command's own name, or the one a flag or a grouped verb reaches: `down --abandon`
// is `abandon`, and `team seat add` is `add` (both from the one mapping in general-grant.ts).
//
// The team is the one the line names: `--file`, `--session`, `--root`, a send address (for
// `team send`, and each side of a `team grant --send` pair), a registry key, a project, the ids
// `forget` names, or every team a machine-wide flag reads — each resolved from the same source
// its command reads, so the grant is checked against the team the run will act on rather than the
// folder the door happens to stand in. A line that names no team is this folder's team, as it
// always was. A grant that lists entities reads that team first and refuses a target it cannot
// resolve, before the run; a wildcard grant (`entities: ["*"]`) resolves no target at all and
// admits exactly what it admitted before.
//
// Left to the command itself: `up`, `init` and `config`, which read `--general` with their own
// admission (an owner-seat-shaped launch, a first record, a signed edit). Never admitted here:
// `team client general-grant`, the one command that issues grants — a grant never issues itself.
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readTeamConfig } from '../file/team-config.ts';
import type { Io } from '../io.ts';
import { resolveTargets } from '../pause/targets.ts';
import { AGENT_ID_PATTERN, getAgent } from '../registry/agents.ts';
import * as projectRegistry from '../registry/projects.ts';
import { findTeam, findTeams, readTeams, type TeamRecord } from '../registry/teams.ts';
import { ORCHESTRATOR_RECEIVER } from '../send/admit.ts';
import { FLAG_OPS, grantCoversEntity, grantCoversOp, grantKeyMatches, readGeneralGrant, VERB_OPS, type GeneralGrant, type GeneralOp } from './general-grant.ts';

/** Commands that parse `--general` themselves. */
export const OWN_GENERAL = new Set(['up', 'init', 'config']);

/** Whether this command line is the grant-issuing command, which no general grant admits. */
export function issuesGrants(name: string, rest: readonly string[]): boolean {
  return name === 'client' && rest.find((word) => !word.startsWith('-')) === 'general-grant';
}

export type Door =
  | { kind: 'pass'; argv: string[]; io: Io }
  | { kind: 'usage'; why: string; json: boolean }
  | { kind: 'refused'; why: string; json: boolean }
  | { kind: 'target'; why: string; json: boolean }
  | { kind: 'admitted'; argv: string[]; io: Io; grant: GeneralGrant; json: boolean };

/** One option's value, `--name v` or `--name=v`, and the argv without it. */
function take(argv: string[], name: string): { value: string | undefined; present: boolean; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  let present = false;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    if (word === `--${name}`) {
      present = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { value = next; i++; }
      continue;
    }
    if (word.startsWith(`--${name}=`)) { present = true; value = word.slice(name.length + 3); continue; }
    rest.push(word);
  }
  return { value, present, rest };
}

/**
 * Each command's valued options, as its own parser declares them, less `--general` and `--key`
 * (the door takes those off the line before this table is read). A scan must consume a value
 * where the command consumes one: `status --session --file x` makes `--file` the session's
 * value and names no file, and a door that read `--file` there would check the wrong team.
 * test/general-door-scope.test.ts holds this table to contract/cli.json.
 */
export const VALUED: Readonly<Record<string, readonly string[]>> = {
  ack: [],
  add: ['approval', 'client', 'effort', 'file', 'like', 'model', 'session', 'team', 'until', 'worktree'],
  agents: [],
  answer: ['file', 'session'],
  approvals: ['approval'],
  archive: ['file', 'out', 'session'],
  'ask-show': ['ask', 'marker'],
  batch: ['approval', 'do'],
  brief: ['file', 'seat', 'session'],
  broker: [],
  bus: ['approval', 'inherited'],
  check: ['file', 'pr', 'session', 'since'],
  client: ['approval', 'days', 'entities', 'ops', 'out', 'public-key', 'to', 'via'],
  commits: ['file', 'since'],
  config: ['approval'],
  daemon: ['root', 'route', 'started-by'],
  delegate: ['commands'],
  'development-mode': [],
  doctor: ['file', 'session'],
  down: ['approval', 'client', 'file', 'session', 'team'],
  drops: ['epoch', 'seat', 'session'],
  feed: ['audit', 'briefs', 'limit', 'seat'],
  forget: ['approval'],
  grant: ['answer', 'approve-as-owner-seat', 'approve', 'assertion', 'at', 'bundle', 'capabilities', 'client', 'code', 'credential-id', 'deny', 'entity', 'execute', 'expires', 'from', 'grant-entity', 'grant-project', 'grant-team', 'name', 'public-key', 'revoke-approval', 'rp-id', 'scope', 'seat', 'signer-public-key', 'signer', 'team', 'to', 'type', 'via'],
  hold: ['client', 'team', 'until'],
  import: ['approval'],
  init: ['approval-mode', 'approve-as-owner-seat', 'assertion', 'execute', 'from-archive', 'revoke-approval', 'scope', 'signer'],
  issues: [],
  list: [],
  lock: ['for', 'wait'],
  mcp: ['epoch', 'file', 'seat', 'session'],
  messages: ['ack', 'client', 'limit', 'request-id', 'since'],
  migrate: ['approval'],
  next: [],
  'owner-seat': ['days', 'entity', 'grant-emission', 'owner-signers', 'policy-entity', 'port', 'reason', 'signer', 'team'],
  pause: ['client', 'reason', 'seat', 'team'],
  plan: [],
  policy: ['entity', 'file', 'kind', 'project', 'seat', 'until'],
  pr: ['file'],
  proc: ['note', 'pid'],
  projects: [],
  queue: ['assignee', 'commit', 'id', 'priority', 'version'],
  raise: [],
  register: ['pane', 'session'],
  release: ['file'],
  reload: ['client', 'file', 'team'],
  remove: ['client', 'file', 'session', 'team'],
  rename: ['file', 'session'],
  reply: [],
  restart: ['client', 'file', 'session', 'team'],
  resume: ['client', 'seat', 'team'],
  revoke: ['client'],
  route: [],
  seat: ['client', 'file', 'session', 'team'],
  seats: ['client', 'file', 'session', 'team'],
  send: ['approval', 'brief', 'channel', 'client', 'confirm', 'file', 'ms', 'record', 'request-id', 'subject', 'timeout'],
  sessions: ['by', 'client', 'team'],
  settings: ['file'],
  setup: ['credential-id', 'grant-duration', 'public-key', 'request-expiry', 'roots', 'rule-lifetime', 'signature', 'signer', 'team'],
  status: ['client', 'file', 'project', 'session', 'team'],
  swap: ['file', 'to'],
  tempo: [],
  unlock: [],
  up: ['approval', 'client', 'file', 'session', 'team'],
  usage: [],
  watch: ['file', 'session'],
  workflow: ['evidence', 'script'],
  worktree: ['branch', 'file', 'kind', 'seat', 'session'],
};

/** What one command line carries once it is read the way its own parser reads it. */
type Scan = {
  /** Every occurrence of each valued option, in the order written. */
  values: Record<string, string[]>;
  /** The options written without a value. */
  flags: Set<string>;
  /** The positional words. */
  words: string[];
};

/** Read the words as `readArgs` does: a valued option consumes the next word, whatever it spells;
 *  an option without a value is a flag; anything else is positional. */
function scan(argv: readonly string[], valued: readonly string[] | undefined): Scan {
  const values: Record<string, string[]> = {};
  const flags = new Set<string>();
  const words: string[] = [];
  const takesValue = new Set(valued ?? []);
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    if (!word.startsWith('--')) { words.push(word); continue; }
    const equals = word.indexOf('=');
    const name = equals >= 0 ? word.slice(2, equals) : word.slice(2);
    if (equals >= 0) { (values[name] ??= []).push(word.slice(equals + 1)); continue; }
    if (takesValue.has(name)) {
      const value = argv[i + 1];
      if (value !== undefined) { (values[name] ??= []).push(value); i++; }
      continue;
    }
    flags.add(name);
  }
  return { values, flags, words };
}

/**
 * The command one line dispatches to, and the words that command parses. `team seat` hands a
 * grouped verb to the top-level command (src/commands/seat.ts), moving the options it shares
 * ahead of the verb; the op and the target are then the dispatched command's.
 */
function dispatchedCommand(name: string, rest: readonly string[]): { command: string; words: string[] } {
  if (name !== 'seat') return { command: name, words: [...rest] };
  const ahead: string[] = [];
  let index = 0;
  while (index < rest.length) {
    const word = rest[index] as string;
    if (word === '--json') { ahead.push(word); index += 1; continue; }
    const [option, inline] = word.startsWith('--')
      ? (word.slice(2).split(/=(.*)/s) as [string, string | undefined])
      : ['', undefined];
    if (option !== 'session' && option !== 'file') break;
    if (inline !== undefined) { ahead.push(word); index += 1; continue; }
    const value = rest[index + 1];
    if (value === undefined) break;
    ahead.push(word, value);
    index += 2;
  }
  const verb = rest[index];
  const op = verb === undefined ? undefined : VERB_OPS.seat?.[verb];
  if (op === undefined) return { command: 'seat', words: [...rest] };
  return { command: op, words: [...ahead, ...rest.slice(index + 1)] };
}

/** The op this line reaches, from the command and the flags its own parser reads. */
function opOf(command: string, scanned: Scan): GeneralOp {
  const flags = FLAG_OPS[command];
  if (flags !== undefined) {
    for (const [flag, op] of Object.entries(flags)) if (scanned.flags.has(flag)) return op;
  }
  return command as GeneralOp;
}

/** The teams a line names: one entity per team, `null` for a team that belongs to none. */
export type Resolved = { ok: true; entities: (string | null)[] } | { ok: false; why: string };

/** The entity of the registry record at this folder, or null when there is none. */
function entityHere(io: Io, home: string): string | null {
  try {
    const here = readTeamConfig(io.cwd, { home, checkOnly: true });
    return here.ok ? here.team.entity ?? null : null;
  } catch {
    return null;
  }
}

/** This folder's team, the target of every line that names none. */
function here(io: Io, home: string): Resolved {
  return { ok: true, entities: [entityHere(io, home)] };
}

/** A team file, read the way the commands read `--file`. */
function fromFile(io: Io, home: string, file: string): Resolved {
  const loaded = readTeamConfig(io.cwd, { file, home, checkOnly: true });
  if (!loaded.ok) return { ok: false, why: `the team file "${file}" cannot be resolved` };
  return { ok: true, entities: [loaded.team.entity ?? null] };
}

/** One registry record named by id, project or session, the way `findTeams` reads a key. */
function fromRegistry(home: string, key: string): Resolved {
  let found: TeamRecord[];
  try {
    found = findTeams(home, key);
  } catch (error) {
    return { ok: false, why: `the team named "${key}" cannot be resolved: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (found.length !== 1) return { ok: false, why: `no team named "${key}" can be resolved` };
  return { ok: true, entities: [(found[0] as TeamRecord).entity ?? null] };
}

/** A session named with `--session`, read the way `findTeams` reads a session key: the teams whose
 *  record names that session (a session may host more than one, and each entity is checked).
 *  `default` is the commands' own word for the session this folder's team keeps, so it names
 *  that team. A session no record names is one the door cannot place, and a listed grant is
 *  refused for it before the run. */
function fromSession(io: Io, home: string, session: string): Resolved {
  if (session === 'default') return here(io, home);
  let found: TeamRecord[];
  try {
    found = findTeams(home, session).filter((team) => team.session === session);
  } catch (error) {
    return { ok: false, why: `the team of the session "${session}" cannot be resolved: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (found.length === 0) return { ok: false, why: `the team of the session "${session}" cannot be resolved` };
  return { ok: true, entities: found.map((team) => team.entity ?? null) };
}

/** Every registered team, the target of a machine-wide flag. */
function everyTeam(home: string): Resolved {
  let records: Record<string, TeamRecord>;
  try {
    records = readTeams(home);
  } catch (error) {
    return { ok: false, why: `the team registry cannot be read, so the teams this line reads cannot be resolved: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, entities: Object.values(records).map((record) => record.entity ?? null) };
}

/** A project record and the entities of its teams, the way `team status --project` reads it. */
function fromProject(home: string, name: string): Resolved {
  let project: projectRegistry.ProjectRecord | null;
  try {
    project = projectRegistry.byName(home, name);
  } catch (error) {
    return { ok: false, why: `the project named "${name}" cannot be resolved: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (project === null) return { ok: false, why: `no project named "${name}" can be resolved` };
  let records: Record<string, TeamRecord>;
  try {
    records = readTeams(home);
  } catch {
    records = {};
  }
  const entities = (project.teams ?? []).map((id) => records[id]?.entity ?? project.entity ?? null);
  return { ok: true, entities: entities.length > 0 ? entities : [project.entity ?? null] };
}

/** A project a policy rule scopes, by the project registry or else the team registry. */
function fromPolicyProject(home: string, name: string): Resolved {
  const project = fromProject(home, name);
  return project.ok ? project : fromRegistry(home, name);
}

/** Every checkout named with `--root`, read the way `team daemon` reads its roots. */
function fromRoots(io: Io, home: string, roots: readonly string[]): Resolved {
  const entities: (string | null)[] = [];
  for (const named of roots) {
    const loaded = readTeamConfig(resolve(io.cwd, named), { home });
    if (!loaded.ok) return { ok: false, why: `the team of the checkout "${named}" cannot be resolved` };
    entities.push(loaded.team.entity ?? null);
  }
  return { ok: true, entities };
}

/** A send address: `<seat>@<team>` and an agent id name a team, `@<nickname>` and a plain seat
 *  this folder's — the split `src/send/resolve.ts` reads, without the live lookup. */
function fromAddress(io: Io, home: string, spec: string): Resolved {
  if (AGENT_ID_PATTERN.test(spec)) {
    let team: TeamRecord | null = null;
    try {
      const agent = getAgent(home, spec);
      team = agent === null ? null : findTeam(home, agent.reach.team);
    } catch {
      team = null;
    }
    if (team === null) return { ok: false, why: `the team the address "${spec}" names cannot be resolved` };
    return { ok: true, entities: [team.entity ?? null] };
  }
  if (spec.startsWith('@')) return here(io, home);
  const at = spec.indexOf('@');
  if (at > 0 && at === spec.lastIndexOf('@') && at < spec.length - 1) {
    const scope = spec.slice(at + 1);
    let team: TeamRecord | null = null;
    try {
      team = findTeam(home, scope);
    } catch {
      team = null;
    }
    if (team === null) return { ok: false, why: `no team named "${scope}" can be resolved` };
    return { ok: true, entities: [team.entity ?? null] };
  }
  return here(io, home);
}

/** One side of a `team grant --send` pair: the address forms `fromAddress` reads, the
 *  `session/seat` form the writer also takes, and — in `to` alone — the reserved
 *  `orchestrator@<entity>`, which names a lead seat of that entity and never falls back to a
 *  `seat@team` reading (`src/send/admit.ts`). */
function fromSendSide(io: Io, home: string, side: 'from' | 'to', spec: string): Resolved {
  if (side === 'to') {
    const at = spec.indexOf('@');
    if (at > 0 && spec.slice(0, at) === ORCHESTRATOR_RECEIVER && spec.indexOf('@', at + 1) < 0 && at < spec.length - 1) {
      return { ok: true, entities: [spec.slice(at + 1)] };
    }
  }
  const slash = spec.indexOf('/');
  if (slash > 0 && !spec.includes('@')) return fromSession(io, home, spec.slice(0, slash));
  return fromAddress(io, home, spec);
}

/** The targets a pause or a resume acts on, resolved by the commands' own resolver. Never the
 *  owner's remembering read: a refused line writes no state (`remember` is off). */
function fromPauseTargets(name: string, scanned: Scan, io: Io, home: string, now: Date): Resolved {
  const seat = scanned.values.seat?.[0];
  const team = scanned.values.team?.[0];
  const all = scanned.flags.has('all');
  const key = seat === undefined && team === undefined && !all ? scanned.words[0] : undefined;
  let resolved: ReturnType<typeof resolveTargets>;
  try {
    resolved = resolveTargets({
      key,
      ...(seat !== undefined ? { seat } : {}),
      ...(team !== undefined ? { team } : {}),
      all,
      command: name === 'resume' ? 'resume' : 'pause',
      io,
      home,
      now: () => now,
      owner: false,
    });
  } catch (error) {
    return { ok: false, why: `the teams this line names cannot be resolved: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!resolved.ok) return { ok: false, why: resolved.message };
  return { ok: true, entities: resolved.targets.map((target) => target.team.entity ?? null) };
}

/** The comma-separated names one option carries. */
function names(value: string): string[] {
  return value.split(',').map((name) => name.trim()).filter((name) => name !== '');
}

/** The words of each `--do` piece, read as `team batch` reads them: a piece runs until the next
 *  `--do`, and the batch's own switches and valued options are not part of it. */
function batchPieces(argv: readonly string[]): string[][] {
  const pieces: string[][] = [];
  let current: string[] | null = null;
  const switches = new Set(['request', 'json', 'dry-run']);
  const valued = new Set(['approval']);
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]!;
    if (word === '--do') {
      current = [];
      pieces.push(current);
      continue;
    }
    if (word.startsWith('--do=')) return [];
    const named = word.startsWith('--') ? word.slice(2).split(/=(.*)/s)[0]! : '';
    if (switches.has(named) || valued.has(named)) {
      if (valued.has(named) && !word.includes('=')) index++;
      continue;
    }
    if (current !== null) current.push(word);
  }
  return pieces;
}

/** Every target a line names, from the options and words the commands read as targets. `words` is
 *  the raw rest, for the one command (`batch`) whose `--do` pieces are read before any scan. */
function targetEntities(command: string, scanned: Scan, words: readonly string[], io: Io, home: string, now: Date): Resolved {
  switch (command) {
    case 'send': {
      const spec = scanned.words[0];
      return spec === undefined ? here(io, home) : fromAddress(io, home, spec);
    }
    case 'daemon': {
      const roots = scanned.values.root ?? [];
      return roots.length === 0 ? here(io, home) : fromRoots(io, home, roots);
    }
    case 'pause':
    case 'resume':
      return fromPauseTargets(command, scanned, io, home, now);
    case 'status':
    case 'seats': {
      const entities: (string | null)[] = [];
      let named = false;
      for (const project of scanned.values.project ?? []) {
        named = true;
        const resolved = fromProject(home, project);
        if (!resolved.ok) return resolved;
        entities.push(...resolved.entities);
      }
      for (const file of scanned.values.file ?? []) {
        named = true;
        const resolved = fromFile(io, home, file);
        if (!resolved.ok) return resolved;
        entities.push(...resolved.entities);
      }
      if (scanned.flags.has('all')) {
        named = true;
        const resolved = everyTeam(home);
        if (!resolved.ok) return resolved;
        entities.push(...resolved.entities);
      }
      return named ? { ok: true, entities } : here(io, home);
    }
    case 'policy': {
      const entities: (string | null)[] = [];
      let named = false;
      for (const entity of scanned.values.entity ?? []) { named = true; entities.push(entity); }
      for (const project of scanned.values.project ?? []) {
        named = true;
        const resolved = fromPolicyProject(home, project);
        if (!resolved.ok) return resolved;
        entities.push(...resolved.entities);
      }
      for (const file of scanned.values.file ?? []) {
        named = true;
        const resolved = fromFile(io, home, file);
        if (!resolved.ok) return resolved;
        entities.push(...resolved.entities);
      }
      return named ? { ok: true, entities } : here(io, home);
    }
    case 'grant': {
      const entities: (string | null)[] = [];
      let named = false;
      for (const entity of scanned.values.entity ?? []) { named = true; entities.push(entity); }
      for (const list of scanned.values['grant-entity'] ?? []) {
        named = true;
        entities.push(...names(list));
      }
      for (const key of [...(scanned.values.team ?? []), ...(scanned.values['grant-team'] ?? []).flatMap(names)]) {
        named = true;
        const resolved = fromRegistry(home, key);
        if (!resolved.ok) return resolved;
        entities.push(...resolved.entities);
      }
      for (const key of (scanned.values['grant-project'] ?? []).flatMap(names)) {
        named = true;
        const resolved = fromRegistry(home, key);
        if (!resolved.ok) return resolved;
        entities.push(...resolved.entities);
      }
      for (const word of scanned.words) {
        if (!word.startsWith('@') || word.length === 1) continue;
        named = true;
        const resolved = fromRegistry(home, word.slice(1));
        if (!resolved.ok) return resolved;
        entities.push(...resolved.entities);
      }
      // `--send` writes a record for the pair it names: each side is the team the record acts
      // on, so a listed grant is checked against the pair's entities, never only this folder's.
      if (scanned.flags.has('send')) {
        for (const [side, spellings] of [['from', scanned.values.from], ['to', scanned.values.to]] as const) {
          const spec = spellings?.[0];
          if (spec === undefined || spec === '') continue;
          named = true;
          const resolved = fromSendSide(io, home, side, spec);
          if (!resolved.ok) return resolved;
          entities.push(...resolved.entities);
        }
      }
      return named ? { ok: true, entities } : here(io, home);
    }
    case 'forget': {
      if (scanned.words.length === 0) return here(io, home);
      const entities: (string | null)[] = [];
      for (const id of scanned.words) {
        const resolved = fromRegistry(home, id);
        if (!resolved.ok) return { ok: false, why: `no team record "${id}" can be resolved` };
        entities.push(...resolved.entities);
      }
      return { ok: true, entities };
    }
    case 'batch': {
      // Each `--do` piece runs a batchable command with its own words: every piece's target is
      // resolved the way that command's own line resolves it, and all of them are checked.
      const entities: (string | null)[] = [];
      for (const piece of batchPieces(words)) {
        const inner = piece[0];
        if (inner === undefined || inner === 'batch') continue;
        const args = piece.slice(1);
        const innerScan = scan(args, VALUED[inner]);
        const resolved = targetEntities(inner, innerScan, args, io, home, now);
        if (!resolved.ok) return resolved;
        entities.push(...resolved.entities);
      }
      return entities.length === 0 ? here(io, home) : { ok: true, entities };
    }
    case 'import': {
      const file = scanned.words[0];
      return file === undefined ? here(io, home) : fromFile(io, home, file);
    }
    case 'delegate': {
      // `<session/pane>`, the same split the edit reads; the session names the team it belongs to.
      const spec = scanned.words[0];
      if (spec === undefined) return here(io, home);
      const cut = spec.indexOf('/');
      return fromSession(io, home, cut > 0 ? spec.slice(0, cut) : spec);
    }
    case 'setup': {
      // The charter's roots: the teams they hold are the ones the charter would cover.
      const roots = (scanned.values.roots ?? []).flatMap(names);
      return roots.length === 0 ? here(io, home) : fromRoots(io, home, roots);
    }
    case 'owner-seat': {
      const entities = scanned.values.entity ?? [];
      return entities.length === 0 ? here(io, home) : { ok: true, entities };
    }
    case 'sessions': {
      // The owner's form is the machine-wide listing; `--team` is the client form's, and a
      // `--client` line is refused by the command itself (the door takes its --key).
      return everyTeam(home);
    }
    case 'list': {
      // Every form reads the machine's herdr sessions; `--all` only adds the stopped ones.
      return everyTeam(home);
    }
    case 'feed':
    case 'usage': {
      if (!scanned.flags.has('all')) return here(io, home);
      return everyTeam(home);
    }
    default: {
      const file = scanned.values.file?.[0];
      if (file !== undefined) return fromFile(io, home, file);
      const session = scanned.values.session?.[0];
      if (session !== undefined) return fromSession(io, home, session);
      return here(io, home);
    }
  }
}

/** The teams a `team up` launch acts on: the file it launches, the session it launches into, else
 *  this folder's team — the same resolution the door does for its own line. */
export function launchEntities(io: Io, home: string, file: string | undefined, session: string | undefined): Resolved {
  if (file !== undefined) return fromFile(io, home, file);
  if (session !== undefined) return fromSession(io, home, session);
  return here(io, home);
}

/** The door's verdict for `team <name> <rest>`. Without `--general` it passes the line untouched. */
export function generalDoor(name: string, rest: string[], io: Io, now: Date = new Date()): Door {
  if (OWN_GENERAL.has(name)) return { kind: 'pass', argv: rest, io };
  const general = take(rest, 'general');
  if (!general.present) return { kind: 'pass', argv: rest, io };
  const json = rest.includes('--json') || rest.some((word) => word.startsWith('--json='));
  if (issuesGrants(name, rest)) return { kind: 'usage', why: 'team client general-grant issues grants and takes no --general (a holder issues with --via <grant.json> --key <client.key>)', json };
  if (general.value === undefined) return { kind: 'usage', why: '--general takes <grant.json>', json };
  const key = take(general.rest, 'key');
  if (!key.present || key.value === undefined) return { kind: 'usage', why: '--general needs --key <client.key>', json };
  const home = io.env.HOME ?? homedir();
  const grantPath = resolve(io.cwd, general.value);
  const keyPath = resolve(io.cwd, key.value);
  const { command, words } = dispatchedCommand(name, key.rest);
  const scanned = scan(words, VALUED[command]);
  const op = opOf(command, scanned);
  const read = readGeneralGrant(home, grantPath, now);
  if (!read.ok) return { kind: 'refused', why: read.why, json };
  const keyed = grantKeyMatches(home, read.grant, keyPath);
  if (!keyed.ok) return { kind: 'refused', why: keyed.why, json };
  const covered = grantCoversOp(read.grant, op);
  if (!covered.ok) return { kind: 'refused', why: covered.why, json };
  // The team the run will act on, for a grant that lists entities: a wildcard grant resolves no
  // target at all, so nothing this line could name changes what it admits.
  if (!read.grant.entities.includes('*')) {
    const targets = targetEntities(command, scanned, words, io, home, now);
    if (!targets.ok) return { kind: 'target', why: targets.why, json };
    for (const entity of targets.entities) {
      const entityCovered = grantCoversEntity(read.grant, entity);
      if (!entityCovered.ok) return { kind: 'refused', why: entityCovered.why, json };
    }
  }
  return { kind: 'admitted', argv: key.rest, io: { ...io, caller: { kind: 'owner' }, general: { grant: grantPath, key: keyPath } }, grant: read.grant, json };
}
