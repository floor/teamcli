// Lifecycle actions approved by the owner seat: `team import`, `team migrate`, `team add` and
// `team up` (and `team init`, bundled with `up` so one answer starts a new team) run for a caller
// that is not the owner at a terminal once the owner seat has signed for exactly that action. The flow is the one
// `team init` already uses (src/client/team-create.ts):
//
//   request   the caller records what it will run (actions, repository root, team, HEAD, a hash
//             of each action's arguments, who asks) for fifteen minutes and drops a confirmation
//             in the owner seat inbox, which the owner page shows;
//   confirm   the owner answers oui / always / non on the owner page (a passkey: Touch ID on the
//             Mac, or the phone) or with `--approve-as-owner-seat`; the answer is signed by an
//             accepted owner signer whose key is confirmed against the credential store;
//   execute   the caller runs the action with `--approval <id>`; TeamCLI verifies the signed
//             answer is bound to this id and these parameters, claims it single-use per action,
//             and writes an audit entry.
//
// An `always` answer stands as a rule for the same actions under the repository's parent folder,
// inside the owner's approval-rule-ttl. Fail-closed: a missing, expired, mismatched, unsigned,
// replayed or self-signed answer admits nothing. The actions never grant, never change
// owner-signers and never change approval-mode, so no principal widens its own authority
// through them. Revoking an always rule and forgetting a registry record are asked here too:
// they remove a standing the owner already gave, and they do not hand a new one out.

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { charterLifetime } from '../charter/check.ts';
import { answerChoiceOf, approvalRuleExpired } from './emission.ts';
import { answerCard, cardPrompt, ownerActionCard } from './approval-card.ts';
import { presentOwnerRequest } from './owner-page-link.ts';
import { answerDeadline, deliverToOwnerSeat, readOwnerSeat, replaceOwnerSeatMessage, signOwnerAnswer, verifyOwnerAnswer, type AnswerWindow, type OwnerSeatAnswer, type OwnerSeatKeyStore, type SignedOwnerAnswer } from './owner-seat.ts';
import { claimInLedger, ledgerSpent, machineBindingOf, readOwnerPin, requestMachineProblem, validMachineBinding, verifyPinnedOwnerAnswer, type MachineBinding } from './owner-pin.ts';
import { ownerMachinePinned } from './owner-pin-path.ts';
import { actionApprovalsFolder, actionAuditFolder, actionRequestsFolder } from './team-create.ts';

export const OWNER_ACTIONS = ['team-create', 'team-import', 'team-migrate', 'team-add', 'team-up', 'team-send', 'team-down', 'team-bus', 'team-revoke-approval', 'team-forget', 'team-config', 'team-general-grant', 'development-mode'] as const;
export type OwnerAction = (typeof OWNER_ACTIONS)[number];
export const OWNER_ACTION_TTL_MS = 15 * 60 * 1000;
export const OWNER_ACTION_ID_PATTERN = /^oa_[0-9a-f]{24}$/;

export type OwnerActionParams = {
  kind: 'owner-action';
  actions: OwnerAction[];
  root: string;
  team: string;
  head: string | null;
  /** Per action, the hash of the arguments it will run with (`actionArgsHash`). */
  args: Partial<Record<OwnerAction, string>>;
  /** Per action, the arguments that hash names. Present on a request recorded by this build. */
  words?: Partial<Record<OwnerAction, string[]>>;
  /** Why the asker wants it, in their own words. Display only: it is not part of the hash, so a
   *  request still signs the same actions and arguments whether or not it carries a reason. */
  reason?: string;
  /** Who asked: the caller's log label. A signer of that name cannot answer it. */
  requested_by: string;
  /** Every caller folded into one card. Set only when more than one asked, and part of the hash then. */
  requesters?: string[];
  /** The machine the request was made on, when its owner seat is pinned from another machine
   *  (src/client/owner-pin.ts). Part of the hash, so the owner's answer is bound to that machine
   *  and runs nowhere else. A machine with a local owner names none, and hashes as before. */
  machine?: MachineBinding;
  /** The answer window, inside the hash: when the request was made and when it stops accepting
   *  an answer (`null`: never, when the charter says so). The record's own `created` and
   *  `expires_at` must equal it. A record written before the field existed carries none; a
   *  machine with a local owner reads it as before, and a pinned machine refuses it. */
  window?: { created: string; expires_at: string | null };
};
export type OwnerActionRecord = {
  request_id: string;
  params: OwnerActionParams;
  params_sha256: string;
  created: string;
  /** `null` when the charter says a request does not expire. */
  expires_at: string | null;
  /** Epoch of the coalesce that wrote this card. A later caller joins only a newer epoch. */
  join?: { epoch: number };
};

/** The words of a command that an approval binds: everything but how it is asked and shown. */
export function boundWords(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    if (word === '--json' || word === '--dry-run' || word === '--request' || word === '--then-up') continue;
    if (word === '--approval' || word === '--reason') { i++; continue; }
    if (word.startsWith('--approval=') || word.startsWith('--reason=')) continue;
    out.push(word);
  }
  return out;
}

export function actionArgsHash(action: OwnerAction, words: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ action, words }), 'utf8').digest('hex');
}

export function ownerActionHash(p: OwnerActionParams): string {
  // No prototype on either map: an entry the record names `__proto__` is an ordinary own key
  // and its value is part of the hash. On a plain object the write would replace the map's
  // prototype instead, and two records that differ only in that entry would share one hash.
  const args: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(p.args).sort()) args[key] = p.args[key as OwnerAction]!;
  // `words` is part of the hash when the request carries it, so one signature binds each
  // action's argument list. A record written before the field existed hashes as it did then.
  const body: Record<string, unknown> = { kind: p.kind, actions: [...p.actions], root: p.root, team: p.team, head: p.head, args, requested_by: p.requested_by };
  if (p.words !== undefined) {
    const words: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    for (const key of Object.keys(p.words).sort()) words[key] = [...(p.words[key as OwnerAction] ?? [])];
    body.words = words;
  }
  if (p.requesters !== undefined) body.requesters = [...p.requesters].sort();
  if (p.machine !== undefined) body.machine = { id: p.machine.id, name: p.machine.name };
  if (p.window !== undefined) body.window = { created: p.window.created, expires_at: p.window.expires_at };
  // `reason` is not hashed on purpose: the owner's answer signs the actions, arguments, folder,
  // team and HEAD, and the asker's own words about why must not change what that signature covers.
  return createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
}

function askedBy(params: OwnerActionParams): readonly string[] {
  return params.requesters ?? [params.requested_by];
}

/** The binding a deferral must name and the window an extension counts from. */
function windowOf(record: OwnerActionRecord): AnswerWindow {
  return { params_sha256: record.params_sha256, created: record.created, expires_at: record.expires_at };
}

export function canonicalRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

function writeExclusive(path: string, text: string): 'written' | 'exists' | 'failed' {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'failed';
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return 'written';
}

function replaceFile(path: string, text: string): boolean {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  if (writeExclusive(temp, text) !== 'written') return false;
  try {
    renameSync(temp, path);
    return true;
  } catch {
    try { unlinkSync(temp); } catch {}
    return false;
  }
}

const ACTION_WORDS: Record<OwnerAction, string> = {
  'team-create': 'create the team',
  'team-import': 'import the team file',
  'team-migrate': 'migrate the team',
  'team-add': 'add a seat',
  'team-up': 'start the team',
  'team-send': 'send a message',
  'team-down': 'stop the team',
  'team-bus': 'start the bus',
  'team-revoke-approval': 'revoke an approval rule',
  'team-forget': 'forget a team record',
  'team-config': "change the team's record",
  'team-general-grant': 'issue a general grant',
  'development-mode': "set the machine's development mode",
};

/** The card for `team migrate`: team, project, seat count, and the canonical-record hash the signature binds. */
function migrateCardSummary(p: OwnerActionParams): string | null {
  if (p.actions.length !== 1 || p.actions[0] !== 'team-migrate') return null;
  const words = p.words?.['team-migrate'] ?? [];
  const take = (key: string): string | undefined => words.find((word) => word.startsWith(`${key}=`))?.slice(key.length + 1);
  const team = take('team');
  const id = take('id');
  const project = take('project');
  const seats = take('seats');
  const record = take('record');
  if (team === undefined || id === undefined || project === undefined || seats === undefined || record === undefined) return null;
  const count = Number(seats);
  const seatWord = count === 1 ? '1 seat' : `${seats} seats`;
  const keep = words.includes('--keep-file') ? ' The file stays.' : ' The file is retired after the record verifies.';
  const head = p.head ? ` (HEAD ${p.head.slice(0, 12)})` : '';
  return `${p.requested_by} asks to migrate team "${team}" (${id}) in project "${project}" — ${seatWord} — canonical record ${record} — ${p.root}${head}.${keep}`;
}

export function ownerActionSummary(p: OwnerActionParams): string {
  const card = migrateCardSummary(p);
  if (card !== null) return card;
  const what = p.actions.map((action) => {
    const words = p.words?.[action] ?? [];
    return words.length > 0 ? `${ACTION_WORDS[action]} (${words.join(' ')})` : ACTION_WORDS[action];
  }).join(', then ');
  return `${p.requested_by} asks to ${what} — team "${p.team}" in ${p.root}${p.head ? ` (HEAD ${p.head.slice(0, 12)})` : ''}.`;
}

export type OwnerActionRequestInput = {
  actions: readonly OwnerAction[];
  root: string;
  team: string;
  head: string | null;
  args: Partial<Record<OwnerAction, readonly string[]>>;
  requestedBy: string;
  /** Why the asker wants it. Display only; see `OwnerActionParams.reason`. */
  reason?: string;
};

/** The directory two overlapping requests wait in. A caller writes its file before taking the lock. */
export function ownerActionWaitersFolder(home: string): string {
  return join(actionRequestsFolder(home), '.waiters');
}

/** Held only while a request is recorded. A second caller that finds it is concurrent with the holder. */
export function ownerActionLockPath(home: string): string {
  return join(actionRequestsFolder(home), '.lock');
}

const COALESCE_SLEEP = new Int32Array(new SharedArrayBuffer(4));

type WaiterFile = { id: string; input: OwnerActionRequestInput };

function requestExpiry(home: string, now: Date): string | null {
  // A pinned machine reads no charter of its own: its requests keep the default window, the one
  // its readers allow (`windowProblem`).
  if (ownerMachinePinned(home)) return new Date(now.getTime() + OWNER_ACTION_TTL_MS).toISOString();
  const life = charterLifetime(home, 'request');
  if (life.kind === 'set') return life.ms === null ? null : new Date(now.getTime() + life.ms).toISOString();
  return new Date(now.getTime() + OWNER_ACTION_TTL_MS).toISOString();
}

function sameAsk(a: OwnerActionRequestInput, b: OwnerActionRequestInput): boolean {
  return canonicalRoot(a.root) === canonicalRoot(b.root) && a.team === b.team && a.head === b.head;
}

function recordFrom(inputs: readonly OwnerActionRequestInput[], now: Date, home: string, prior?: OwnerActionRecord): OwnerActionRecord {
  const actions = [...new Set(inputs.flatMap((input) => input.actions))];
  const first = inputs[0]!;
  const args: Partial<Record<OwnerAction, string>> = {};
  const words: Partial<Record<OwnerAction, string[]>> = {};
  for (const action of actions) {
    const source = [...inputs].reverse().find((input) => input.actions.includes(action));
    words[action] = [...(source?.args[action] ?? [])];
    args[action] = actionArgsHash(action, words[action]!);
  }
  const requesters = [...new Set(inputs.map((input) => input.requestedBy))].sort();
  // The first reason given names why the card was drawn; an asker who gave none leaves it out.
  const reason = inputs.map((input) => input.reason?.replace(/\s+/g, ' ').trim()).find((why) => why !== undefined && why !== '');
  // A request on a machine whose owner seat is pinned names that machine; a merged card keeps the
  // machine its first request named.
  const machine = prior?.params.machine ?? machineBindingOf(home) ?? undefined;
  // The window is signed with the rest: a merged card keeps the window of the card it joined.
  const created = prior?.created ?? now.toISOString();
  const expiresAt = prior?.expires_at === undefined ? requestExpiry(home, now) : prior.expires_at;
  const params: OwnerActionParams = {
    kind: 'owner-action',
    actions,
    root: canonicalRoot(first.root),
    team: first.team,
    head: first.head,
    args,
    words,
    ...(reason === undefined ? {} : { reason }),
    requested_by: requesters.length === 1 ? requesters[0]! : requesters.join(', '),
    ...(requesters.length > 1 ? { requesters } : {}),
    ...(machine !== undefined ? { machine } : {}),
    window: { created, expires_at: expiresAt },
  };
  return {
    request_id: prior?.request_id ?? `oa_${randomBytes(12).toString('hex')}`,
    params,
    params_sha256: ownerActionHash(params),
    created,
    expires_at: expiresAt,
    join: prior?.join,
  };
}

function readWaiters(home: string): WaiterFile[] {
  const folder = ownerActionWaitersFolder(home);
  let names: string[];
  try {
    names = readdirSync(folder).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const waiters: WaiterFile[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(folder, name), 'utf8')) as WaiterFile;
      if (typeof parsed.id === 'string' && parsed.input !== undefined) waiters.push(parsed);
    } catch {
      // a waiter that is still being written is read on the next pass
    }
  }
  return waiters;
}

function readEpoch(home: string): number {
  try {
    const value = Number(readFileSync(join(actionRequestsFolder(home), '.epoch'), 'utf8'));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function joinCardAfter(home: string, seen: number): OwnerActionRecord | null {
  let names: string[];
  try {
    names = readdirSync(actionRequestsFolder(home)).filter((name) => /^oa_[0-9a-f]{24}\.json$/.test(name));
  } catch {
    return null;
  }
  let found: OwnerActionRecord | null = null;
  for (const name of names) {
    try {
      const record = JSON.parse(readFileSync(join(actionRequestsFolder(home), name), 'utf8')) as OwnerActionRecord;
      const epoch = record.join?.epoch;
      if (epoch === undefined || !(epoch > seen)) continue;
      // A card carried from another machine is never joined here, whatever epoch it carries.
      if (record.params?.machine !== undefined && record.params.machine.id !== machineBindingOf(home)?.id) continue;
      if (found === null || epoch > (found.join?.epoch ?? 0)) found = record;
    } catch {
      // skip a card that is mid-write
    }
  }
  return found;
}

function holdLock(lock: string): boolean {
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 15_000) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        // the holder released it between the stat and the next try
      }
      if (Date.now() - started > 20_000) return false;
      Atomics.wait(COALESCE_SLEEP, 0, 0, 15);
    }
  }
}

function dropWaiters(home: string, ids: readonly string[]): void {
  for (const id of ids) {
    try { unlinkSync(join(ownerActionWaitersFolder(home), `${id}.json`)); } catch { /* already gone */ }
  }
}

function publish(home: string, record: OwnerActionRecord, now: Date, open: ((url: string) => void) | undefined, fresh: boolean): { ok: true; record: OwnerActionRecord; inbox: string | null; text: string; page: 'live' | 'closed' } {
  const text = `Request ${record.request_id}: ${ownerActionSummary(record.params)} Authorized? oui, always, or non.`;
  const message = { kind: 'owner-action-confirmation', request_id: record.request_id, params_sha256: record.params_sha256, text, summary: record.params, at: now.toISOString() };
  const inbox = fresh ? deliverToOwnerSeat(home, message) : (replaceOwnerSeatMessage(home, message) ?? deliverToOwnerSeat(home, message));
  // The open page polls for this card. A request never opens a browser, including when two callers share the card.
  const page = presentOwnerRequest(home, open);
  return { ok: true, record, inbox, text, page };
}

/**
 * Records one request and, when an owner seat is registered, drops its confirmation in that
 * inbox. A missing seat does not refuse the card: `--request` records and returns, and the
 * inbox drop waits until a seat exists. Two callers that overlap on the lock share one card
 * and one signature. Two calls in sequence stay two requests: a join is taken only when the
 * card's epoch is newer than the epoch this call read before it waited.
 */
export function createOwnerActionRequest(
  home: string,
  input: OwnerActionRequestInput,
  now: Date = new Date(),
  open?: (url: string) => void,
): { ok: true; record: OwnerActionRecord; inbox: string | null; text: string; page: 'live' | 'closed' } | { ok: false; why: string } {
  const actions = [...new Set(input.actions)];
  if (actions.length === 0 || actions.some((action) => !(OWNER_ACTIONS as readonly string[]).includes(action))) return { ok: false, why: `an owner-seat request names one or more of ${OWNER_ACTIONS.join(', ')}` };
  const mine: OwnerActionRequestInput = { ...input, actions };
  const waiterId = randomBytes(8).toString('hex');
  mkdirSync(ownerActionWaitersFolder(home), { recursive: true, mode: 0o700 });
  if (writeExclusive(join(ownerActionWaitersFolder(home), `${waiterId}.json`), `${JSON.stringify({ id: waiterId, input: mine })}\n`) !== 'written') return { ok: false, why: 'the request could not be recorded' };
  const seen = readEpoch(home);
  const lock = ownerActionLockPath(home);
  if (!holdLock(lock)) {
    dropWaiters(home, [waiterId]);
    return { ok: false, why: 'the request could not be recorded' };
  }
  try {
    const compatible = (): WaiterFile[] => readWaiters(home).filter((waiter) => sameAsk(waiter.input, mine));
    let batch = compatible();
    const card = joinCardAfter(home, seen);
    const included = batch.some((waiter) => waiter.id === waiterId);
    if (card !== null && sameAsk({ actions: card.params.actions, root: card.params.root, team: card.params.team, head: card.params.head, args: {}, requestedBy: card.params.requested_by }, mine)) {
      const inputs = [...inputsOf(card), ...batch.map((waiter) => waiter.input)];
      const merged = recordFrom(inputs, now, home, card);
      merged.join = card.join;
      if (!replaceFile(join(actionRequestsFolder(home), `${merged.request_id}.json`), `${JSON.stringify(merged, null, 2)}\n`)) return { ok: false, why: 'the request could not be recorded' };
      dropWaiters(home, batch.map((waiter) => waiter.id));
      return publish(home, merged, now, open, false);
    }
    const again = compatible();
    if (again.length > batch.length) batch = again;
    if (!included && !batch.some((waiter) => waiter.id === waiterId)) batch = [...batch, { id: waiterId, input: mine }];
    const epoch = readEpoch(home) + 1;
    const record = recordFrom(batch.map((waiter) => waiter.input), now, home);
    record.join = { epoch };
    writeFileSync(join(actionRequestsFolder(home), '.epoch'), String(epoch), { mode: 0o600 });
    if (writeExclusive(join(actionRequestsFolder(home), `${record.request_id}.json`), `${JSON.stringify(record, null, 2)}\n`) !== 'written') return { ok: false, why: 'the request could not be recorded' };
    dropWaiters(home, batch.map((waiter) => waiter.id));
    return publish(home, record, now, open, true);
  } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch { /* released */ }
  }
}

function inputsOf(record: OwnerActionRecord): OwnerActionRequestInput[] {
  // No prototype: a record read back from disk is not checked here, and an entry named
  // `__proto__` must stay an ordinary own key rather than replace the map's prototype.
  const args: OwnerActionRequestInput['args'] = Object.create(null) as OwnerActionRequestInput['args'];
  for (const action of record.params.actions) args[action] = record.params.words?.[action] ?? [];
  const names = record.params.requesters ?? [record.params.requested_by];
  return names.map((requestedBy, index) => ({
    actions: index === 0 ? record.params.actions : [],
    root: record.params.root,
    team: record.params.team,
    head: record.params.head,
    args: index === 0 ? args : {},
    requestedBy,
  }));
}

export function readOwnerActionRecord(home: string, id: string): OwnerActionRecord | string {
  if (!OWNER_ACTION_ID_PATTERN.test(id)) return `"${id}" is not an owner-seat request id`;
  try {
    const path = join(actionRequestsFolder(home), `${id}.json`);
    if (!lstatSync(path).isFile()) return `request ${id} is not a plain file`;
    return ownerActionRecordOf(JSON.parse(readFileSync(path, 'utf8')), id);
  } catch {
    return `no owner-seat request ${id} can be read`;
  }
}

function isoTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/**
 * The arguments a card shows are the arguments the answer admits: when a request carries its
 * words, every action it names carries its own list, and each action's argument hash is the hash
 * of exactly that list. No hash or list names an action the request does not. A record from
 * before words existed carries none, and its card shows no arguments to differ from (a pinned
 * machine refuses it, `ownerActionBindingProblem`).
 */
function argumentWordsProblem(p: OwnerActionParams, id: string): string | null {
  const args: unknown = p.args;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return `request ${id} carries no argument hashes`;
  const named = new Set<string>(p.actions);
  if (Object.keys(args).some((key) => !named.has(key))) return `request ${id} hashes arguments for an action it does not name`;
  if (p.words === undefined) return null;
  const words: unknown = p.words;
  if (words === null || typeof words !== 'object' || Array.isArray(words)) return `request ${id} carries argument words that cannot be read`;
  if (Object.keys(words).some((key) => !named.has(key))) return `request ${id} carries argument words for an action it does not name`;
  for (const action of p.actions) {
    const list: unknown = (words as Record<string, unknown>)[action];
    if (!Array.isArray(list) || !list.every((word) => typeof word === 'string')) return `request ${id} carries no argument words for ${action}`;
    if ((args as Record<string, unknown>)[action] !== actionArgsHash(action, list as string[])) return `request ${id}'s arguments for ${action} are not the words it shows`;
  }
  return null;
}

/** A signed window, when the request carries one, is whole and is the record's own. */
function windowShapeProblem(record: OwnerActionRecord, id: string): string | null {
  const window: unknown = record.params.window;
  if (window === undefined) return null;
  if (window === null || typeof window !== 'object' || Array.isArray(window)) return `request ${id} carries an answer window that cannot be read`;
  const w = window as Record<string, unknown>;
  if (!isoTime(w.created) || (w.expires_at !== null && !isoTime(w.expires_at)) || Object.keys(w).some((key) => key !== 'created' && key !== 'expires_at')) {
    return `request ${id} carries an answer window that cannot be read`;
  }
  if (record.created !== w.created || record.expires_at !== w.expires_at) return `request ${id}'s answer window is not the one it was signed with`;
  if (w.expires_at !== null && Date.parse(w.expires_at) < Date.parse(w.created)) return `request ${id}'s answer window ends before it begins`;
  return null;
}

/**
 * What a request must carry to be answered across machines: its machine, its signed window — whole,
 * ending, and no longer than a request's default window — and its full argument words. Asked of
 * every request on a pinned machine and of every request that names a machine, wherever it is
 * read: before its card is shown, before it is signed, when its answer is recorded, and when it
 * runs. A request on a machine with a local owner that names no machine is read as before.
 */
export function ownerActionBindingProblem(home: string, record: OwnerActionRecord): string | null {
  const p = record.params;
  if (p.machine === undefined && !ownerMachinePinned(home)) return null;
  const id = record.request_id;
  if (p.window === undefined) return `request ${id} carries no signed answer window; record it again with --request`;
  if (p.window.expires_at === null) return `request ${id} never expires; a request answered from another machine must`;
  const life = Date.parse(p.window.expires_at) - Date.parse(p.window.created);
  if (!(life > 0 && life <= OWNER_ACTION_TTL_MS)) return `request ${id}'s answer window is longer than a request's ${OWNER_ACTION_TTL_MS / 60_000} minutes`;
  if (p.words === undefined) return `request ${id} carries no argument words; record it again with --request`;
  return null;
}

/** One owner-action record read from anywhere — the requests folder, or a file carried from
 *  another machine — whole and bound to its own hash, or why not. */
export function ownerActionRecordOf(raw: unknown, id: string): OwnerActionRecord | string {
  if (!OWNER_ACTION_ID_PATTERN.test(id)) return `"${id}" is not an owner-seat request id`;
  try {
    const record = raw as OwnerActionRecord;
    if (record === null || typeof record !== 'object' || record.request_id !== id || record.params?.kind !== 'owner-action') return `request ${id} is not an owner-seat request`;
    const actions: unknown = record.params.actions;
    if (!Array.isArray(actions) || actions.length === 0 || !actions.every((action) => typeof action === 'string' && (OWNER_ACTIONS as readonly string[]).includes(action))) {
      return `request ${id} names an action this build does not know`;
    }
    if (record.params.machine !== undefined && !validMachineBinding(record.params.machine)) return `request ${id} names a machine this build cannot read`;
    if (ownerActionHash(record.params) !== record.params_sha256) return `request ${id}'s parameters do not match its hash`;
    // A record edited and hashed again still has to say what it admits: the words it shows hash
    // to the arguments it runs, and its window is the one it was signed with.
    const words = argumentWordsProblem(record.params, id);
    if (words !== null) return words;
    const window = windowShapeProblem(record, id);
    if (window !== null) return window;
    return record;
  } catch {
    return `no owner-seat request ${id} can be read`;
  }
}

/**
 * One signed answer, verified and bound to `record`. On a machine whose owner seat is pinned from
 * another machine, the pin is the only key source (src/client/owner-pin.ts) and a pin that cannot
 * be read admits nothing; anywhere else, the local owner seat and its credential store, as before.
 */
export function boundOwnerActionAnswer(home: string, signed: SignedOwnerAnswer, record: OwnerActionRecord, store: OwnerSeatKeyStore, now: Date): { ok: true; answer: OwnerSeatAnswer; signer: string } | { ok: false; why: string } {
  return boundAnswer(home, signed, record, store, now);
}

function boundAnswer(home: string, signed: SignedOwnerAnswer, record: OwnerActionRecord, store: OwnerSeatKeyStore, now: Date): { ok: true; answer: OwnerSeatAnswer; signer: string } | { ok: false; why: string } {
  const pin = readOwnerPin(home);
  if (pin.kind === 'refused') return { ok: false, why: `${pin.why}; no owner-seat answer is accepted on this machine` };
  const verified = pin.kind === 'pinned' ? verifyPinnedOwnerAnswer(pin, signed) : verifyOwnerAnswer(home, signed, store, now);
  if (!verified.ok) return verified;
  const a = verified.answer;
  if (a.kind !== 'owner-action' || a.request_id !== record.request_id || a.params_sha256 !== record.params_sha256) return { ok: false, why: `the owner-seat answer is not bound to request ${record.request_id} and its parameters` };
  if (askedBy(record.params).includes(verified.signer.name)) return { ok: false, why: `signer "${verified.signer.name}" asked for request ${record.request_id}; no principal approves its own request` };
  return { ok: true, answer: a, signer: verified.signer.name };
}

/** The refusal for a request recorded by a build before the signed window: it is never signed
 *  again, on any machine, so its unsigned expiry can never be stretched under a fresh answer. */
export function windowlessRefusal(id: string): string {
  return `request ${id} was recorded by an earlier build and carries no signed answer window, so it is not signed; record it again with --request`;
}

/** How long an answer to a request recorded before the signed window stands: counted from the
 *  answer's own signed time, whatever the request's unsigned expiry says. */
export const WINDOWLESS_ANSWER_MS = OWNER_ACTION_TTL_MS;

/** The owner seat answers one request; `always` also stores a rule for the parent folder.
 *  `expect` is the parameter hash the owner was shown: a request that no longer has it is not
 *  signed. */
export function approveOwnerAction(
  home: string,
  id: string,
  word: string,
  store: OwnerSeatKeyStore,
  now: Date = new Date(),
  via: { signer?: string; assertion?: { authenticator_data: string; client_data_json: string; signature: string }; expect?: string } = {},
): { ok: true; choice: 'once' | 'always' | 'deny'; ruleId?: string } | { ok: false; why: string } {
  const choice = answerChoiceOf(word);
  if (choice === null) return { ok: false, why: `"${word}" is not an answer: oui/approved/yes, always, or non/deny` };
  const record = readOwnerActionRecord(home, id);
  if (typeof record === 'string') return { ok: false, why: record };
  if (via.expect !== undefined && record.params_sha256 !== via.expect) return { ok: false, why: `request ${id} changed since it was shown; nothing was signed` };
  // Every fresh signature covers a signed window and the full argument words, each action's hash
  // matching the words its card shows (`readOwnerActionRecord` checked the match when words are
  // there): a request without either is not signed. An answer given before stays verifiable.
  if (record.params.window === undefined) return { ok: false, why: windowlessRefusal(id) };
  if (record.params.words === undefined) return { ok: false, why: `request ${id} carries no argument words, so its card cannot show what it admits and it is not signed; record it again with --request` };
  // Before any card is shown or signed: a request for another machine carries all it must.
  const binding = ownerActionBindingProblem(home, record);
  if (binding !== null) return { ok: false, why: binding };
  const deadline = answerDeadline(home, actionRequestsFolder(home), id, windowOf(record), store, now, OWNER_ACTION_TTL_MS);
  if (deadline <= now.getTime()) return { ok: false, why: `request ${id} expired at ${record.expires_at}` };
  const seat = readOwnerSeat(home);
  if (seat === null) return { ok: false, why: 'no owner seat is registered' };
  if (via.signer !== undefined && askedBy(record.params).includes(via.signer)) return { ok: false, why: `signer "${via.signer}" asked for request ${id}; no principal approves its own request` };
  const answer: OwnerSeatAnswer = {
    kind: 'owner-action', request_id: id, params_sha256: record.params_sha256, choice, team: seat.team, seat: 'owner', at: now.toISOString(),
    ...(choice === 'always' ? { scope: dirname(record.params.root) } : {}),
  };
  // The Touch ID prompt is the card, one line: the kind, the question, and the answer's scope.
  // The record (arguments, root, HEAD, hash) is not in it; `team approvals details` prints that.
  const card = answerCard(ownerActionCard(record.params), choice);
  const signed = signOwnerAnswer(home, answer, via.signer, store, cardPrompt(card), via.assertion);
  if (!signed.ok) return signed;
  if (askedBy(record.params).includes(signed.signed.signer)) return { ok: false, why: `signer "${signed.signed.signer}" asked for request ${id}; no principal approves its own request` };
  const text = `${JSON.stringify(signed.signed, null, 2)}\n`;
  const path = join(actionRequestsFolder(home), `${id}.seat-answer.json`);
  const written = writeExclusive(path, text);
  if (written === 'failed') return { ok: false, why: 'the answer could not be written' };
  if (written === 'exists') {
    // Only an answer that verifies and is bound to this request blocks this one.
    if (heldAnswer(home, path, record, store, now)) return { ok: false, why: `request ${id} was already answered` };
    if (!replaceFile(path, text)) return { ok: false, why: 'the answer could not be written' };
  }
  // A request carried from another machine is answered here and runs there: no rule is kept on
  // this machine for it, and the machine it runs on keeps none yet either, so `always` admits
  // that one request once.
  if (choice === 'always' && record.params.machine === undefined) {
    mkdirSync(actionApprovalsFolder(home), { recursive: true, mode: 0o700 });
    const rulePath = join(actionApprovalsFolder(home), `${id}.json`);
    const ruleText = `${JSON.stringify({ ...signed.signed, params: record.params }, null, 2)}\n`;
    const ruleWritten = writeExclusive(rulePath, ruleText);
    if (ruleWritten !== 'written' && !replaceFile(rulePath, ruleText)) return { ok: false, why: `the answer was recorded but the always rule ${id} could not be written; the request can still run once` };
    return { ok: true, choice, ruleId: id };
  }
  return { ok: true, choice };
}

function heldAnswer(home: string, path: string, record: OwnerActionRecord, store: OwnerSeatKeyStore, now: Date): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    return boundAnswer(home, JSON.parse(readFileSync(path, 'utf8')) as SignedOwnerAnswer, record, store, now).ok;
  } catch {
    return false;
  }
}

/** The instant `record` stops accepting an answer, as every reader of the requests folder compares it. */
export function ownerActionDeadline(home: string, record: OwnerActionRecord, store: OwnerSeatKeyStore, now: Date): number {
  return answerDeadline(home, actionRequestsFolder(home), record.request_id, windowOf(record), store, now, OWNER_ACTION_TTL_MS);
}

/** The signed answer the requests folder holds for `record`, when one verifies and is bound to it. */
export function heldOwnerActionAnswer(home: string, record: OwnerActionRecord, store: OwnerSeatKeyStore, now: Date): SignedOwnerAnswer | null {
  const path = join(actionRequestsFolder(home), `${record.request_id}.seat-answer.json`);
  if (!heldAnswer(home, path, record, store, now)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SignedOwnerAnswer;
  } catch {
    return null;
  }
}

/**
 * Records a request carried from another machine, so the owner answers it here as any other: on
 * the owner page, or with `team approvals sign` (one Touch ID card). The record is kept exactly as
 * it came, never merged: a second copy of the same request is the same card, and a different
 * request under the same id is refused. The card goes to the owner seat inbox once.
 */
export function recordForeignOwnerAction(home: string, record: OwnerActionRecord, now: Date = new Date()): { ok: true; fresh: boolean; text: string } | { ok: false; why: string } {
  if (record.params.machine === undefined) return { ok: false, why: `request ${record.request_id} names no machine; only a request carried from another machine is recorded here` };
  mkdirSync(actionRequestsFolder(home), { recursive: true, mode: 0o700 });
  const path = join(actionRequestsFolder(home), `${record.request_id}.json`);
  const text = `Request ${record.request_id} from machine ${record.params.machine.name}: ${ownerActionSummary(record.params)} Authorized? oui, always, or non.`;
  // The other machine's coalescing epoch stays there: a request made here never joins a card
  // that came from another machine. The epoch is not part of the hash.
  const kept: OwnerActionRecord = { request_id: record.request_id, params: record.params, params_sha256: record.params_sha256, created: record.created, expires_at: record.expires_at };
  const written = writeExclusive(path, `${JSON.stringify(kept, null, 2)}\n`);
  if (written === 'failed') return { ok: false, why: 'the request could not be recorded' };
  if (written === 'exists') {
    const held = readOwnerActionRecord(home, record.request_id);
    const same = typeof held !== 'string' && held.params_sha256 === record.params_sha256 && held.created === record.created && held.expires_at === record.expires_at;
    if (!same) return { ok: false, why: `a different request ${record.request_id} is already recorded here; nothing was changed` };
    return { ok: true, fresh: false, text };
  }
  deliverToOwnerSeat(home, { kind: 'owner-action-confirmation', request_id: record.request_id, params_sha256: record.params_sha256, text, summary: record.params, at: now.toISOString() });
  presentOwnerRequest(home);
  return { ok: true, fresh: true, text };
}

/**
 * Records an answer carried from the machine that holds the owner's signers, for a request of this
 * machine. The answer must verify against this machine's key source and be bound to the request;
 * it is written once: an answer already held that verifies is never replaced, and a request
 * already run is never answered again. Expiry and the machine the request names are the caller's
 * checks, made before this one.
 */
export function recordCarriedOwnerAnswer(home: string, record: OwnerActionRecord, signed: SignedOwnerAnswer, store: OwnerSeatKeyStore, now: Date): { ok: true; answer: OwnerSeatAnswer; signer: string } | { ok: false; why: string } {
  const id = record.request_id;
  const binding = ownerActionBindingProblem(home, record);
  if (binding !== null) return { ok: false, why: binding };
  const bound = boundAnswer(home, signed, record, store, now);
  if (!bound.ok) return bound;
  if (ledgerSpent(home, id)) return { ok: false, why: `request ${id} was already used: an approval is single-use` };
  const text = `${JSON.stringify(signed, null, 2)}\n`;
  const path = join(actionRequestsFolder(home), `${id}.seat-answer.json`);
  const written = writeExclusive(path, text);
  if (written === 'failed') return { ok: false, why: 'the answer could not be written' };
  if (written === 'exists') {
    if (heldAnswer(home, path, record, store, now)) return { ok: false, why: `request ${id} was already answered` };
    if (!replaceFile(path, text)) return { ok: false, why: 'the answer could not be written' };
  }
  return bound;
}

export type OwnerActionRule = { rule_id: string; actions: OwnerAction[]; scope: string; team: string; signer: string; created: string };

/** Every `always` rule whose owner-signer signature verifies now, binds its parameters, and is inside the approval-rule-ttl. */
export function listOwnerActionRules(home: string, store: OwnerSeatKeyStore, now: Date = new Date()): { rules: OwnerActionRule[]; ignored: string[] } {
  let names: string[];
  try {
    names = readdirSync(actionApprovalsFolder(home)).filter((n) => /^oa_[0-9a-f]{24}\.json$/.test(n)).sort();
  } catch {
    return { rules: [], ignored: [] };
  }
  const rules: OwnerActionRule[] = [];
  const ignored: string[] = [];
  // A machine whose owner seat is pinned keeps no standing rule yet: every action there runs on an
  // answer to its own request, bound to that machine. A rule copied onto it admits nothing.
  if (ownerMachinePinned(home)) return { rules: [], ignored: names.map((name) => name.slice(0, -5)) };
  for (const name of names) {
    const id = name.slice(0, -5);
    try {
      const path = join(actionApprovalsFolder(home), name);
      if (!lstatSync(path).isFile()) throw new Error('kind');
      const file = JSON.parse(readFileSync(path, 'utf8')) as SignedOwnerAnswer & { params: OwnerActionParams };
      const p = file.params;
      if (p === undefined || p.kind !== 'owner-action') throw new Error('params');
      // A rule for a request of another machine never stands here.
      if (p.machine !== undefined) throw new Error('machine');
      const record: OwnerActionRecord = { request_id: id, params: p, params_sha256: ownerActionHash(p), created: '', expires_at: '' };
      const bound = boundAnswer(home, file, record, store, now);
      const a = file.owner_seat_answer;
      if (!bound.ok || a.choice !== 'always' || typeof a.scope !== 'string' || a.scope !== dirname(p.root)) throw new Error('rule');
      const seat = readOwnerSeat(home);
      if (seat === null || approvalRuleExpired(home, seat.entity, a.at, now, store)) throw new Error('expired');
      rules.push({ rule_id: id, actions: p.actions, scope: a.scope, team: p.team, signer: bound.signer, created: a.at });
    } catch {
      ignored.push(id);
    }
  }
  return { rules, ignored };
}

export type OwnerActionAsk = {
  action: OwnerAction;
  root: string;
  team: string;
  head: string | null;
  words: readonly string[];
  /** Claim the approval (single-use per action). A dry run verifies and claims nothing. */
  claim: boolean;
};

export type OwnerActionAdmission = { ok: true; via: 'owner-seat' | 'rule' | 'charter' | 'leads'; requestId?: string; ruleId?: string; signer: string } | { ok: false; why: string };

/**
 * Admits one action run under request `id`: the request is whole, unexpired, names this action,
 * repository, team, HEAD and arguments, and holds a verified owner-seat answer bound to it — or a
 * verified `always` rule covers it. A real run claims the action single-use and writes an audit.
 */
export function admitOwnerAction(home: string, id: string, ask: OwnerActionAsk, store: OwnerSeatKeyStore, now: Date = new Date()): OwnerActionAdmission {
  const record = readOwnerActionRecord(home, id);
  if (typeof record === 'string') return { ok: false, why: record };
  const p = record.params;
  // The machine first: a request runs only on the machine it names, and a machine whose owner
  // seat is pinned runs no request that names none.
  const elsewhere = requestMachineProblem(home, p.machine, id);
  if (elsewhere !== null) return { ok: false, why: elsewhere };
  // Then what it must carry to have been answered across machines: its signed window and words.
  const binding = ownerActionBindingProblem(home, record);
  if (binding !== null) return { ok: false, why: binding };
  if (!p.actions.includes(ask.action)) return { ok: false, why: `request ${id} does not approve ${ask.action} (it names ${p.actions.join(', ')})` };
  if (p.root !== canonicalRoot(ask.root)) return { ok: false, why: `request ${id} is for ${p.root}, not this repository` };
  if (p.team !== ask.team) return { ok: false, why: `request ${id} is for team "${p.team}", not "${ask.team}"` };
  if (p.head !== null && p.head !== ask.head) return { ok: false, why: `request ${id} was approved at HEAD ${p.head.slice(0, 12)}; HEAD is now ${ask.head?.slice(0, 12) ?? 'unknown'}` };
  if (p.args[ask.action] !== actionArgsHash(ask.action, ask.words)) return { ok: false, why: `request ${id} was approved for other ${ask.action} arguments` };
  const deadline = answerDeadline(home, actionRequestsFolder(home), id, windowOf(record), store, now, OWNER_ACTION_TTL_MS);
  if (deadline <= now.getTime()) return { ok: false, why: `request ${id} expired at ${record.expires_at}` };
  let answerText: string | null = null;
  try {
    answerText = readFileSync(join(actionRequestsFolder(home), `${id}.seat-answer.json`), 'utf8');
  } catch {}
  let admitted: OwnerActionAdmission;
  if (answerText !== null) {
    let signed: SignedOwnerAnswer;
    try {
      signed = JSON.parse(answerText);
    } catch {
      return { ok: false, why: `the owner-seat answer to ${id} is not whole JSON` };
    }
    const bound = boundAnswer(home, signed, record, store, now);
    if (!bound.ok) return bound;
    if (!(Date.parse(bound.answer.at) <= answerDeadline(home, actionRequestsFolder(home), id, windowOf(record), store, now, OWNER_ACTION_TTL_MS))) return { ok: false, why: `the owner-seat answer to ${id} was given after the request expired` };
    // A request recorded before the signed window, answered then: its expiry is not signed, so the
    // answer stands only for the default window after its own signed time.
    if (p.window === undefined && !(now.getTime() < Date.parse(bound.answer.at) + WINDOWLESS_ANSWER_MS)) {
      return { ok: false, why: `request ${id} was recorded by an earlier build with no signed answer window; its answer stood for ${WINDOWLESS_ANSWER_MS / 60_000} minutes after it was signed, and that has passed: record it again with --request` };
    }
    if (bound.answer.choice === 'deny') return { ok: false, why: `the owner seat denied request ${id}` };
    admitted = { ok: true, via: 'owner-seat', requestId: id, signer: bound.signer };
  } else {
    const rule = ruleFor(home, ask, store, now);
    if (rule === undefined) return { ok: false, why: `request ${id} has no owner-seat answer yet; the owner answers it on the owner page` };
    admitted = { ok: true, via: 'rule', requestId: id, ruleId: rule.rule_id, signer: rule.signer };
  }
  // A pinned machine spends its approvals in the ledger the resolver names, the one place a later
  // account split moves out of the agents' reach; a machine with a local owner keeps its marker.
  const pinned = ownerMachinePinned(home);
  if (!ask.claim) {
    if (pinned && ledgerSpent(home, id, ask.action)) return { ok: false, why: `request ${id} was already used for ${ask.action}: an approval is single-use` };
    return admitted;
  }
  if (pinned) {
    const spent = claimInLedger(home, id, ask.action, now);
    if (!spent.ok) return spent;
  } else {
    const used = writeExclusive(join(actionRequestsFolder(home), `${id}.used-${ask.action}`), `${now.toISOString()}\n`);
    if (used !== 'written') return { ok: false, why: used === 'exists' ? `request ${id} was already used for ${ask.action}: an approval is single-use` : `request ${id} could not be claimed` };
  }
  audit(home, `${id}.${ask.action}`, { request_id: id, action: ask.action, params: p, params_sha256: record.params_sha256, via: admitted.via, signer: admitted.signer, ...(admitted.ruleId ? { rule_id: admitted.ruleId } : {}), at: now.toISOString() });
  return admitted;
}

function ruleFor(home: string, ask: Pick<OwnerActionAsk, 'action' | 'root' | 'team'> & { ruleId?: string }, store: OwnerSeatKeyStore, now: Date): OwnerActionRule | undefined {
  const root = canonicalRoot(ask.root);
  return listOwnerActionRules(home, store, now).rules.find((r) => (ask.ruleId === undefined || r.rule_id === ask.ruleId) && r.actions.includes(ask.action) && r.scope === dirname(root));
}

/** Removes one owner-action `always` rule (`oa_…`). A missing file is a refusal; nothing else is touched. */
export function revokeOwnerActionRule(home: string, ruleId: string): { ok: true } | { ok: false; why: string } {
  if (!OWNER_ACTION_ID_PATTERN.test(ruleId)) return { ok: false, why: `"${ruleId}" is not an owner-action rule id` };
  try {
    const path = join(actionApprovalsFolder(home), `${ruleId}.json`);
    if (!lstatSync(path).isFile()) return { ok: false, why: `no owner-action rule ${ruleId}` };
    unlinkSync(path);
    return { ok: true };
  } catch {
    return { ok: false, why: `no owner-action rule ${ruleId}` };
  }
}

/** With no request id: a verified `always` rule for this action whose scope holds the repository.
 *  `ruleId` names the one rule the caller's subject proof selected; absent, the first verified
 *  rule covering the action and folder, as before. */
export function admitOwnerActionByRule(home: string, ask: Omit<OwnerActionAsk, 'head' | 'words'> & { ruleId?: string }, store: OwnerSeatKeyStore, now: Date = new Date()): OwnerActionAdmission {
  const rule = ruleFor(home, ask, store, now);
  if (rule === undefined) return { ok: false, why: 'no owner-seat always rule covers this action' };
  if (ask.claim) audit(home, `rule-${rule.rule_id}-${ask.action}-${now.getTime()}`, { rule_id: rule.rule_id, action: ask.action, root: canonicalRoot(ask.root), team: ask.team, via: 'rule', signer: rule.signer, at: now.toISOString() });
  return { ok: true, via: 'rule', ruleId: rule.rule_id, signer: rule.signer };
}

/** Records that a verified `always` rule admitted `action` for a record at `targets` (the folders
 *  the record changes), in the same shape a rule admission by the caller's own repository writes.
 *  The shared check (src/client/owner-action-step.ts) calls this only on admission. */
export function auditRuleAdmission(home: string, rule: OwnerActionRule, action: OwnerAction, targets: readonly string[], now: Date = new Date()): void {
  audit(home, `rule-${rule.rule_id}-${action}-${now.getTime()}`, {
    rule_id: rule.rule_id,
    action,
    root: targets.length === 1 ? targets[0] : [...targets],
    via: 'rule',
    signer: rule.signer,
    at: now.toISOString(),
  });
}

function audit(home: string, name: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(actionAuditFolder(home), { recursive: true, mode: 0o700 });
    writeExclusive(join(actionAuditFolder(home), `${name}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  } catch {}
}
