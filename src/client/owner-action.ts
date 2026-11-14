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

import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { charterLifetime } from '../charter/check.ts';
import { answerChoiceOf, approvalRuleExpired } from './emission.ts';
import { answerCard, cardPrompt, ownerActionCard, PROMPT_MAX, type ApprovalCard } from './approval-card.ts';
import { presentOwnerRequest } from './owner-page-link.ts';
import { answerDeadline, deliverToOwnerSeat, readOwnerSeat, replaceOwnerSeatMessage, signOwnerAnswer, verifyOwnerAnswer, type AnswerWindow, type OwnerSeatAnswer, type OwnerSeatKeyStore, type SignedOwnerAnswer } from './owner-seat.ts';
import { accountBindingOf, claimInLedger, ledgerSpent, machineBindingOf, readOwnerPin, requestMachineProblem, verifyPinnedOwnerAnswer } from './owner-pin.ts';
import { ownerSpendShared, spendThroughHelper } from './owner-spend-client.ts';
import { ownerMachinePinned } from './owner-pin-path.ts';
import { actionApprovalsFolder, actionAuditFolder, actionRequestsFolder } from './team-create.ts';
import {
  actionArgsHash,
  carriedAnswerTimeProblem,
  carriedBindingProblem,
  carriedRequestTimeProblem,
  OWNER_ACTION_ID_PATTERN,
  OWNER_ACTION_TTL_MS,
  OWNER_ACTIONS,
  ownerActionHash,
  ownerActionRecordOf,
  type OwnerAction,
  type OwnerActionParams,
  type OwnerActionRecord,
} from './owner-request-record.ts';

export { actionArgsHash, carriedAnswerTimeProblem, carriedBindingProblem, carriedRequestTimeProblem, OWNER_ACTION_ID_PATTERN, OWNER_ACTION_TTL_MS, OWNER_ACTIONS, ownerActionHash, ownerActionRecordOf };
export type { OwnerAction, OwnerActionParams, OwnerActionRecord };

/**
 * The actions an answer admits exactly once and never as a standing rule: an entity's own record
 * and the machine daemon. An `always` answer to one is refused before it is signed, no rule is
 * kept for one, and a rule that names one admits nothing; only a signed answer to the request
 * itself runs it, on every machine.
 */
export const EXACT_ANSWER_ACTIONS: ReadonlySet<OwnerAction> = new Set<OwnerAction>(['team-entity-config', 'team-daemon']);

function exactOnly(actions: readonly OwnerAction[]): boolean {
  return actions.some((action) => EXACT_ANSWER_ACTIONS.has(action));
}

/** Why a request is refused for bundling an exact-answer action with another, or null. Such an
 *  action's card shows its one exact change, and a bundle's card cannot: it is never bundled. */
export function exactBundleProblem(actions: readonly OwnerAction[], id?: string): string | null {
  if (actions.length > 1 && exactOnly(actions)) return `${id === undefined ? 'the request' : `request ${id}`} bundles ${actions.filter((action) => EXACT_ANSWER_ACTIONS.has(action)).join(', ')} with other actions; an entity's record or the machine daemon is asked for on its own`;
  return null;
}

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
  'team-entity-config': "change an entity's record",
  'team-daemon': 'change the machine daemon',
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
  // A request bound outside a repository: the machine daemon of one home, or one entity's record
  // in the owner's file. It names that home or file folder, and no team.
  if (p.actions.length === 1 && (p.actions[0] === 'team-daemon' || p.actions[0] === 'team-entity-config')) {
    const action = p.actions[0];
    const words = p.words?.[action] ?? [];
    const what = `${ACTION_WORDS[action]}${words.length > 0 ? ` (${words.join(' ')})` : ''}`;
    return action === 'team-daemon'
      ? `${p.requested_by} asks to ${what} — home ${p.root}.`
      : `${p.requested_by} asks to ${what} — "${p.team}" in ${p.root}.`;
  }
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
  // A request for an exact-answer action is never folded into another card, nor another into it.
  if (exactOnly(a.actions) || exactOnly(b.actions)) return false;
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
  // On a machine whose accounts share one owner, the account it was made by, the same way.
  const account = prior?.params.account ?? accountBindingOf(home) ?? undefined;
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
    ...(account !== undefined ? { account } : {}),
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
  const bundled = exactBundleProblem(actions);
  if (bundled !== null) return { ok: false, why: bundled };
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

/**
 * What a request must carry to be answered across machines: its machine, its signed window — whole,
 * ending, and no longer than a request's default window — and its full argument words. Asked of
 * every request on a pinned machine and of every request that names a machine, wherever it is
 * read: before its card is shown, before it is signed, when its answer is recorded, and when it
 * runs. A request on a machine with a local owner that names no machine is read as before.
 */
export function ownerActionBindingProblem(home: string, record: OwnerActionRecord): string | null {
  if (record.params.machine === undefined && !ownerMachinePinned(home)) return null;
  return carriedBindingProblem(record);
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

type AnswerVia = { signer?: string; assertion?: { authenticator_data: string; client_data_json: string; signature: string }; expect?: string };

/** One answer ready to sign: the request it answers, the unsigned answer and its card. */
export type PreparedOwnerAnswer = { record: OwnerActionRecord; answer: OwnerSeatAnswer; choice: 'once' | 'always' | 'deny'; card: ApprovalCard };

/**
 * Every check `approveOwnerAction` makes before it signs: the answer word, the request whole and
 * unchanged since it was shown, its signed window and words, what a carried request must carry,
 * its deadline, the owner seat, and that the signer did not ask for it. Nothing is signed or
 * written.
 */
export function prepareOwnerActionAnswer(home: string, id: string, word: string, store: OwnerSeatKeyStore, now: Date, via: AnswerVia = {}): { ok: true; prepared: PreparedOwnerAnswer } | { ok: false; why: string } {
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
  const bundled = exactBundleProblem(record.params.actions, id);
  if (bundled !== null) return { ok: false, why: `${bundled}; nothing was signed` };
  // Before any card is shown or signed: a request for another machine carries all it must, and
  // says it was made no later than now by this machine's clock.
  const binding = ownerActionBindingProblem(home, record);
  if (binding !== null) return { ok: false, why: binding };
  if (record.params.machine !== undefined) {
    const dated = carriedRequestTimeProblem(record, now);
    if (dated !== null) return { ok: false, why: dated };
  }
  const deadline = answerDeadline(home, actionRequestsFolder(home), id, windowOf(record), store, now, OWNER_ACTION_TTL_MS);
  if (deadline <= now.getTime()) return { ok: false, why: `request ${id} expired at ${record.expires_at}` };
  const seat = readOwnerSeat(home);
  if (seat === null) return { ok: false, why: 'no owner seat is registered' };
  if (via.signer !== undefined && askedBy(record.params).includes(via.signer)) return { ok: false, why: `signer "${via.signer}" asked for request ${id}; no principal approves its own request` };
  if (choice === 'always' && exactOnly(record.params.actions)) return { ok: false, why: `request ${id} is answered once or denied: it keeps no standing rule; nothing was signed` };
  const answer: OwnerSeatAnswer = {
    kind: 'owner-action', request_id: id, params_sha256: record.params_sha256, choice, team: seat.team, seat: 'owner', at: now.toISOString(),
    ...(choice === 'always' ? { scope: dirname(record.params.root) } : {}),
  };
  // The Touch ID prompt is the card, one line: the kind, the question, and the answer's scope.
  // The record (arguments, root, HEAD, hash) is not in it; `team approvals details` prints that.
  return { ok: true, prepared: { record, answer, choice, card: answerCard(ownerActionCard(record.params), choice) } };
}

/** Writes one signed answer for a prepared request, and its `always` rule where one is kept. */
export function recordOwnerActionAnswer(home: string, prepared: PreparedOwnerAnswer, signed: SignedOwnerAnswer, store: OwnerSeatKeyStore, now: Date): { ok: true; choice: 'once' | 'always' | 'deny'; ruleId?: string } | { ok: false; why: string } {
  const { record, choice } = prepared;
  const id = record.request_id;
  if (askedBy(record.params).includes(signed.signer)) return { ok: false, why: `signer "${signed.signer}" asked for request ${id}; no principal approves its own request` };
  const text = `${JSON.stringify(signed, null, 2)}\n`;
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
  if (choice === 'always' && record.params.machine === undefined && !exactOnly(record.params.actions)) {
    mkdirSync(actionApprovalsFolder(home), { recursive: true, mode: 0o700 });
    const rulePath = join(actionApprovalsFolder(home), `${id}.json`);
    const ruleText = `${JSON.stringify({ ...signed, params: record.params }, null, 2)}\n`;
    const ruleWritten = writeExclusive(rulePath, ruleText);
    if (ruleWritten !== 'written' && !replaceFile(rulePath, ruleText)) return { ok: false, why: `the answer was recorded but the always rule ${id} could not be written; the request can still run once` };
    return { ok: true, choice, ruleId: id };
  }
  return { ok: true, choice };
}

/** Whether the answer would be signed by the credential store's own prompt: the named signer, or
 *  the only one, is a device key. A passkey, or a signer that cannot be told, is not. */
function deviceKeySigner(home: string, name: string | undefined): boolean {
  const seat = readOwnerSeat(home);
  if (seat === null) return false;
  const signer = name === undefined ? (seat.signers.length === 1 ? seat.signers[0] : undefined) : seat.signers.find((one) => one.name === name);
  return signer !== undefined && signer.type !== 'webauthn';
}

/** The owner seat answers one request; `always` also stores a rule for the parent folder.
 *  `expect` is the parameter hash the owner was shown: a request that no longer has it is not
 *  signed. */
export function approveOwnerAction(
  home: string,
  id: string,
  word: string,
  store: OwnerSeatKeyStore,
  now: Date = new Date(),
  via: AnswerVia = {},
): { ok: true; choice: 'once' | 'always' | 'deny'; ruleId?: string } | { ok: false; why: string } {
  const ready = prepareOwnerActionAnswer(home, id, word, store, now, via);
  if (!ready.ok) return ready;
  // A card that carries an exact change is signed by the credential store only under a prompt
  // inside the budget: its change, or the short form shown in full before it. Nothing is cut to
  // fit. A passkey signer shows no such prompt: its challenge is prepared and answered on the owner
  // page, which shows the whole card, and is bound to the same record by `expect`.
  if (via.assertion === undefined && deviceKeySigner(home, via.signer) && ready.prepared.card.change !== undefined && cardPrompt(ready.prepared.card).length > PROMPT_MAX) {
    return { ok: false, why: `request ${id} does not fit the confirmation prompt; answer it on the owner page; nothing was signed` };
  }
  const signed = signOwnerAnswer(home, ready.prepared.answer, via.signer, store, cardPrompt(ready.prepared.card), via.assertion);
  if (!signed.ok) return signed;
  return recordOwnerActionAnswer(home, ready.prepared, signed.signed, store, now);
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
  const bundled = exactBundleProblem(record.params.actions, record.request_id);
  if (bundled !== null) return { ok: false, why: bundled };
  mkdirSync(actionRequestsFolder(home), { recursive: true, mode: 0o700 });
  const path = join(actionRequestsFolder(home), `${record.request_id}.json`);
  const text = `Request ${record.request_id} from machine ${record.params.machine.name}${record.params.account !== undefined ? ` (account ${record.params.account})` : ''}: ${ownerActionSummary(record.params)} Authorized? oui, always, or non.`;
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
  const checked = carriedOwnerAnswerCheck(home, record, signed, store, now);
  if (!checked.ok) return checked;
  const bound = checked;
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

/**
 * Every check `recordCarriedOwnerAnswer` makes, writing nothing: the request carries what a carried
 * request must, the answer verifies and is bound to it, the request was never spent, and no answer
 * that verifies is held for it yet. A batch of carried answers asks this of every member before it
 * records any.
 */
export function carriedOwnerAnswerCheck(home: string, record: OwnerActionRecord, signed: SignedOwnerAnswer, store: OwnerSeatKeyStore, now: Date): { ok: true; answer: OwnerSeatAnswer; signer: string } | { ok: false; why: string } {
  const id = record.request_id;
  const binding = ownerActionBindingProblem(home, record);
  if (binding !== null) return { ok: false, why: binding };
  const bound = boundAnswer(home, signed, record, store, now);
  if (!bound.ok) return bound;
  if (ledgerSpent(home, id)) return { ok: false, why: `request ${id} was already used: an approval is single-use` };
  if (heldAnswer(home, join(actionRequestsFolder(home), `${id}.seat-answer.json`), record, store, now)) return { ok: false, why: `request ${id} was already answered` };
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
      // A rule for a request of another machine never stands here, and neither does one for an
      // action only an exact answer admits.
      if (p.machine !== undefined) throw new Error('machine');
      if (exactOnly(p.actions)) throw new Error('exact');
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
  const elsewhere = requestMachineProblem(home, p.machine, id, p.account);
  if (elsewhere !== null) return { ok: false, why: elsewhere };
  // Then what it must carry to have been answered across machines: its signed window and words,
  // and a time it was made that is not ahead of this machine's clock.
  const binding = ownerActionBindingProblem(home, record);
  if (binding !== null) return { ok: false, why: binding };
  if (p.machine !== undefined) {
    const dated = carriedRequestTimeProblem(record, now);
    if (dated !== null) return { ok: false, why: dated };
  }
  if (!p.actions.includes(ask.action)) return { ok: false, why: `request ${id} does not approve ${ask.action} (it names ${p.actions.join(', ')})` };
  const bundled = exactBundleProblem(p.actions, id);
  if (bundled !== null) return { ok: false, why: bundled };
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
  let signed: SignedOwnerAnswer | null = null;
  if (answerText !== null) {
    try {
      signed = JSON.parse(answerText);
    } catch {
      return { ok: false, why: `the owner-seat answer to ${id} is not whole JSON` };
    }
    const bound = boundAnswer(home, signed!, record, store, now);
    if (!bound.ok) return bound;
    if (!(Date.parse(bound.answer.at) <= answerDeadline(home, actionRequestsFolder(home), id, windowOf(record), store, now, OWNER_ACTION_TTL_MS))) return { ok: false, why: `the owner-seat answer to ${id} was given after the request expired` };
    // An answer carried across machines was given inside the signed window, and not ahead of now.
    if (p.machine !== undefined) {
      const given = carriedAnswerTimeProblem(record, bound.answer.at, now);
      if (given !== null) return { ok: false, why: given };
    }
    // A request recorded before the signed window, answered then: its expiry is not signed, so the
    // answer stands only for the default window after its own signed time.
    if (p.window === undefined && !(now.getTime() < Date.parse(bound.answer.at) + WINDOWLESS_ANSWER_MS)) {
      return { ok: false, why: `request ${id} was recorded by an earlier build with no signed answer window; its answer stood for ${WINDOWLESS_ANSWER_MS / 60_000} minutes after it was signed, and that has passed: record it again with --request` };
    }
    if (bound.answer.choice === 'deny') return { ok: false, why: `the owner seat denied request ${id}` };
    admitted = { ok: true, via: 'owner-seat', requestId: id, signer: bound.signer };
  } else {
    // An action only an exact answer admits never falls back to a standing rule.
    const rule = EXACT_ANSWER_ACTIONS.has(ask.action) ? undefined : ruleFor(home, ask, store, now);
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
  if (pinned && ownerSpendShared(home)) {
    // A machine whose accounts share one owner: the owner helper checks the same record, answer
    // and ask again against the system pin, as the account it identifies, and spends it in that
    // account's ledger. The verdict must name exactly the record read above, which is what runs.
    if (signed === null) return { ok: false, why: `request ${id} has no owner-seat answer to spend` };
    const spent = spendThroughHelper({ record, answer: signed, ask: { action: ask.action, root: canonicalRoot(ask.root), team: ask.team, head: ask.head, args_sha256: actionArgsHash(ask.action, ask.words) } });
    if (!spent.ok) return spent;
  } else if (pinned) {
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
