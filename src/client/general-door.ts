// The general door: one place, in the dispatcher, where every command accepts a general grant.
// `team <command> ... --general <grant.json> --key <client.key>` is verified here: the grant's
// whole signed chain and its expiry (`readGeneralGrant`), the key that proves it, and the op the
// line reaches — the command, the flag that reaches another op (`down --abandon` is `abandon`),
// and the grouped verb (`seat add` is `add`). An admitted run reaches the command as the owner
// (its caller is the owner, so no detached or terminal refusal applies), with the two options
// taken off its argv. A command added later is covered the same way, with no wiring of its own.
//
// 0.5.10's narrow door: a grant whose entities are not exactly `['*']` is refused, in one
// sentence every door gives (`SCOPED_GRANT_REFUSAL`); scoped grants arrive in 0.5.11. With the
// wildcard the only admitted shape there is no team target to resolve here, and this door reads
// none: what the line acts on is the command's own reading of it.
//
// Left to the command itself: `up`, `init` and `config`, which read `--general` with their own
// admission (an owner-seat-shaped launch, a first record, a signed edit). The dispatcher still
// reads three things from their line before the command sees it (see `ownGeneral`): a grant that
// lists entities refuses there too, `--general` beside the owner-seat door is a usage error, and
// so is `--general` on a form that never reads a grant. No admission path can outrun the 0.5.10
// rule that way, and everything else is the command's.
// Never admitted here: `team client general-grant`, the one command that issues grants — a
// grant never issues itself.
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Io } from '../io.ts';
import { FLAG_OPS, grantCoversOp, grantIsWildcard, grantKeyMatches, readGeneralGrant, VERB_OPS, type GeneralGrant, type GeneralOp } from './general-grant.ts';

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
 * where the command consumes one: `down --session --abandon` makes `--abandon` the session's
 * value and reaches no abandon op, and a door that read the flag there would check the wrong op.
 * test/general-door-narrow.test.ts holds this table to contract/cli.json.
 */
export const VALUED: Readonly<Record<string, readonly string[]>> = {
  ack: ['older-than', 'seat'],
  add: ['approval', 'client', 'effort', 'file', 'like', 'model', 'reason', 'session', 'team', 'until', 'worktree'],
  agents: [],
  answer: ['file', 'session'],
  approvals: ['approval', 'reason'],
  archive: ['file', 'older-than', 'out', 'seat', 'session'],
  'ask-show': ['ask', 'marker'],
  batch: ['approval', 'do'],
  brief: ['file', 'seat', 'session'],
  broker: [],
  bus: ['approval', 'inherited', 'reason'],
  check: ['file', 'pr', 'session', 'since'],
  checkpoint: ['file', 'session'],
  client: ['approval', 'days', 'entities', 'ops', 'out', 'public-key', 'reason', 'to', 'via'],
  commits: ['file', 'since'],
  config: ['approval', 'reason'],
  daemon: ['inherited', 'root', 'route', 'started-by'],
  delegate: ['commands'],
  'development-mode': ['approval', 'reason'],
  doctor: ['file', 'session'],
  down: ['approval', 'client', 'file', 'reason', 'session', 'team'],
  drops: ['epoch', 'seat', 'session'],
  fallback: [],
  feed: ['audit', 'briefs', 'limit', 'seat'],
  forget: ['approval', 'reason'],
  grant: ['answer', 'approve-as-owner-seat', 'approve', 'assertion', 'at', 'bundle', 'capabilities', 'client', 'code', 'credential-id', 'deny', 'entity', 'execute', 'expires', 'from', 'grant-entity', 'grant-project', 'grant-team', 'name', 'public-key', 'revoke-approval', 'rp-id', 'scope', 'seat', 'signer-public-key', 'signer', 'team', 'to', 'type', 'via'],
  hold: ['client', 'team', 'until'],
  import: ['approval'],
  init: ['approval-mode', 'approve-as-owner-seat', 'assertion', 'execute', 'from-archive', 'reason', 'revoke-approval', 'scope', 'signer'],
  issues: [],
  list: [],
  lock: ['for', 'wait'],
  mcp: ['epoch', 'file', 'seat', 'session'],
  messages: ['ack', 'client', 'limit', 'request-id', 'since'],
  migrate: ['approval', 'reason'],
  next: [],
  order: ['file', 'session'],
  'owner-seat': ['days', 'entity', 'grant-emission', 'owner-signers', 'policy-entity', 'port', 'reason', 'signer', 'team'],
  pause: ['client', 'reason', 'seat', 'team'],
  peek: ['lines'],
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
  restart: ['client', 'file', 'resume', 'session', 'team'],
  resume: ['client', 'seat', 'team'],
  revoke: ['client'],
  route: [],
  seat: ['client', 'file', 'session', 'team'],
  seats: ['client', 'file', 'session', 'team'],
  send: ['approval', 'brief', 'channel', 'client', 'confirm', 'file', 'ms', 'reason', 'record', 'request-id', 'subject', 'timeout'],
  sessions: ['by', 'client', 'team'],
  settings: ['file'],
  setup: ['credential-id', 'grant-duration', 'public-key', 'request-expiry', 'roots', 'rule-lifetime', 'signature', 'signer', 'team'],
  status: ['client', 'file', 'project', 'session', 'team'],
  swap: ['file', 'to'],
  tempo: [],
  trace: [],
  unlock: [],
  up: ['approval', 'client', 'file', 'reason', 'session', 'team'],
  usage: [],
  waits: [],
  watch: ['file', 'session'],
  workflow: ['evidence', 'script'],
  worktree: ['branch', 'file', 'kind', 'remote-session', 'seat', 'session'],
};

/** What one command line carries once it is read the way its own parser reads it. */
type Scan = {
  /** The options written without a value. */
  flags: Set<string>;
  /** How many times each option is written, in either spelling (`--name v` and `--name=v`). */
  counts: Record<string, number>;
  /** The options written with a value (`--name=v`), in either kind. */
  equal: Set<string>;
};

/** Read the words as `readArgs` does: a valued option consumes the next word, whatever it spells;
 *  an option without a value is a flag. */
function scan(argv: readonly string[], valued: readonly string[] | undefined): Scan {
  const flags = new Set<string>();
  const counts: Record<string, number> = {};
  const equal = new Set<string>();
  const takesValue = new Set(valued ?? []);
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    if (!word.startsWith('--')) continue;
    const equals = word.indexOf('=');
    const name = equals >= 0 ? word.slice(2, equals) : word.slice(2);
    counts[name] = (counts[name] ?? 0) + 1;
    if (equals >= 0) { equal.add(name); continue; }
    if (takesValue.has(name)) { i++; continue; }
    flags.add(name);
  }
  return { flags, counts, equal };
}

/**
 * The command one line dispatches to, and the words that command parses. `team seat` hands a
 * grouped verb to the top-level command (src/commands/seat.ts), moving the options it shares
 * ahead of the verb; the op is then the dispatched command's.
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

/**
 * The first op-changing flag the door cannot read as the command will: a valued spelling
 * (`--abandon=<value>`) is an unknown option to the command, which takes the flag alone, and a
 * repeated one names the op twice. Either is refused before the grant is used, rather than admit
 * a line whose op the door could read differently from the command.
 */
function opFlagProblem(command: string, scanned: Scan): string | null {
  for (const flag of Object.keys(FLAG_OPS[command] ?? {})) {
    if (scanned.equal.has(flag)) return `--${flag} takes no value, and the command reads the --${flag}=<value> spelling as an unknown option`;
    if ((scanned.counts[flag] ?? 0) > 1) return `--${flag} is named more than once, and the command reads one op; name it once`;
  }
  return null;
}

/** The words a line leaves once its options are read as its command reads them. The two options
 *  the door owns (`--general`, `--key`) take a value as well, so the word after them is never a
 *  verb: `config keys --general g --key k` still starts with `keys`. */
function positionals(argv: readonly string[], valued: readonly string[] | undefined): string[] {
  const takesValue = new Set([...(valued ?? []), 'general', 'key']);
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    if (!word.startsWith('--')) { words.push(word); continue; }
    if (word.indexOf('=') >= 0) continue;
    if (takesValue.has(word.slice(2))) i++;
  }
  return words;
}

/**
 * The forms of an `OWN_GENERAL` command whose branch returns before the command's own
 * `--general` admission, so the grant is never read: `team config keys` lists the static
 * settings registry (src/commands/config.ts:83), and `team init --approval-modes` lists the
 * approval-mode records, `--approval-mode` signs one with an owner signer, and
 * `--revoke-approval` is the owner's revoke (each branch of src/commands/init.ts runs before
 * the `--general` one). Accepting `--general` there and ignoring it would make a readable grant
 * look like it admitted the run; it is refused as usage instead.
 */
function noRecordForm(name: string, rest: readonly string[], scanned: Scan): string | null {
  if (name === 'config' && positionals(rest, VALUED.config)[0] === 'keys') {
    return 'team config keys takes no --general: no grant admits it, and it lists the settings registry';
  }
  if (name === 'init' && scanned.flags.has('approval-modes')) {
    return 'team init --approval-modes takes no --general: no grant admits it, and it lists the approval modes';
  }
  if (name === 'init' && (scanned.counts['approval-mode'] ?? 0) > 0) {
    return 'team init --approval-mode takes no --general: no grant admits it, and an owner signer sets the mode';
  }
  if (name === 'init' && (scanned.counts['revoke-approval'] ?? 0) > 0) {
    return 'team init --revoke-approval takes no --general: no grant admits it, and only the owner revokes an approval rule';
  }
  return null;
}

/** The owner-seat options a grant has no meaning beside: each asks the owner (or answers her)
 *  for this very run, which is what a grant already does. */
const OWNER_SEAT_OPTIONS = ['request', 'approval', 'approvals', 'approve-as-owner-seat'];

/**
 * The line of an `OWN_GENERAL` command, read here before the command's own admission runs.
 * Those commands hand `--general` to their own door, but their owner-seat branches (`--request`,
 * `--approvals`, `--approval`, `--approve-as-owner-seat`) run first and return, so a grant that
 * lists entities was never read on those paths. Two things are therefore settled first:
 *
 *  - a readable grant whose entities are not exactly `['*']` is refused with the one scoped
 *    sentence (exit id `team.general-target`), whatever other options the line carries;
 *  - `--general` beside an owner-seat option is refused as usage: the two doors have no defined
 *    meaning together (`init` already refuses that combination in its own words when it gets
 *    there; this makes the refusal reach the line whatever branch would have run);
 *  - `--general` on a form whose branch returns before the command's own admission (`config
 *    keys`, `init --approval-modes`, `init --approval-mode`, `init --revoke-approval`) is
 *    refused as usage too: the grant would never be read, so it must not be taken and silently
 *    ignored.
 *
 * Everything else, including the key match and the op, stays with the command's own admission.
 * A grant that cannot be read is left to it too, so each command keeps its own refusal id.
 */
function ownGeneral(name: string, rest: string[], io: Io, now: Date): Door | null {
  const general = take(rest, 'general');
  if (!general.present) return null;
  const json = rest.includes('--json') || rest.some((word) => word.startsWith('--json='));
  if (general.value !== undefined) {
    const read = readGeneralGrant(io.env.HOME ?? homedir(), resolve(io.cwd, general.value), now);
    if (read.ok) {
      const wildcard = grantIsWildcard(read.grant);
      if (!wildcard.ok) return { kind: 'target', why: wildcard.why, json };
    }
  }
  const scanned = scan(rest, VALUED[name]);
  const beside = OWNER_SEAT_OPTIONS.find((option) => scanned.flags.has(option) || (scanned.counts[option] ?? 0) > 0);
  if (beside !== undefined) return { kind: 'usage', why: `--general is its own door: it takes no --${beside}`, json };
  const form = noRecordForm(name, rest, scanned);
  if (form !== null) return { kind: 'usage', why: form, json };
  return { kind: 'pass', argv: rest, io };
}

/** The door's verdict for `team <name> <rest>`. Without `--general` it passes the line untouched. */
export function generalDoor(name: string, rest: string[], io: Io, now: Date = new Date()): Door {
  if (OWN_GENERAL.has(name)) return ownGeneral(name, rest, io, now) ?? { kind: 'pass', argv: rest, io };
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
  // 0.5.10's narrow door: a grant that lists entities is not admitted at all, whatever the line
  // names; 0.5.11 adds scoped grants. The refusal is its own exit id, team.general-target.
  const wildcard = grantIsWildcard(read.grant);
  if (!wildcard.ok) return { kind: 'target', why: wildcard.why, json };
  const doubled = opFlagProblem(command, scanned);
  if (doubled !== null) return { kind: 'refused', why: doubled, json };
  const covered = grantCoversOp(read.grant, op);
  if (!covered.ok) return { kind: 'refused', why: covered.why, json };
  return { kind: 'admitted', argv: key.rest, io: { ...io, caller: { kind: 'owner' }, general: { grant: grantPath, key: keyPath, grantId: read.grant.grant_id, clientId: read.grant.client_id } }, grant: read.grant, json };
}
