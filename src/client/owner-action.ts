// Lifecycle actions approved by the owner seat: `team import`, `team add` and `team up` (and
// `team init`, bundled with `up` so one answer starts a new team) run for a caller that is not the
// owner at a terminal once the owner seat has signed for exactly that action. The flow is the one
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
import { presentOwnerRequest } from './owner-page-link.ts';
import { deliverToOwnerSeat, readOwnerSeat, replaceOwnerSeatMessage, signOwnerAnswer, verifyOwnerAnswer, type OwnerSeatAnswer, type OwnerSeatKeyStore, type SignedOwnerAnswer } from './owner-seat.ts';
import { actionApprovalsFolder, actionAuditFolder, actionRequestsFolder } from './team-create.ts';

export const OWNER_ACTIONS = ['team-create', 'team-import', 'team-add', 'team-up', 'team-send', 'team-down', 'team-bus', 'team-revoke-approval', 'team-forget'] as const;
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
  /** Who asked: the caller's log label. A signer of that name cannot answer it. */
  requested_by: string;
  /** Every caller folded into one card. Set only when more than one asked, and part of the hash then. */
  requesters?: string[];
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
    if (word === '--approval') { i++; continue; }
    if (word.startsWith('--approval=')) continue;
    out.push(word);
  }
  return out;
}

export function actionArgsHash(action: OwnerAction, words: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ action, words }), 'utf8').digest('hex');
}

export function ownerActionHash(p: OwnerActionParams): string {
  const args: Record<string, string> = {};
  for (const key of Object.keys(p.args).sort()) args[key] = p.args[key as OwnerAction]!;
  // `words` is part of the hash when the request carries it, so one signature binds each
  // action's argument list. A record written before the field existed hashes as it did then.
  const body: Record<string, unknown> = { kind: p.kind, actions: [...p.actions], root: p.root, team: p.team, head: p.head, args, requested_by: p.requested_by };
  if (p.words !== undefined) {
    const words: Record<string, string[]> = {};
    for (const key of Object.keys(p.words).sort()) words[key] = [...(p.words[key as OwnerAction] ?? [])];
    body.words = words;
  }
  if (p.requesters !== undefined) body.requesters = [...p.requesters].sort();
  return createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
}

function askedBy(params: OwnerActionParams): readonly string[] {
  return params.requesters ?? [params.requested_by];
}

function requestExpired(expires: string | null, now: Date): boolean {
  return expires !== null && Date.parse(expires) <= now.getTime();
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
  'team-add': 'add a seat',
  'team-up': 'start the team',
  'team-send': 'send a message',
  'team-down': 'stop the team',
  'team-bus': 'start the bus',
  'team-revoke-approval': 'revoke an approval rule',
  'team-forget': 'forget a team record',
};

export function ownerActionSummary(p: OwnerActionParams): string {
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
  const params: OwnerActionParams = {
    kind: 'owner-action',
    actions,
    root: canonicalRoot(first.root),
    team: first.team,
    head: first.head,
    args,
    words,
    requested_by: requesters.length === 1 ? requesters[0]! : requesters.join(', '),
    ...(requesters.length > 1 ? { requesters } : {}),
  };
  return {
    request_id: prior?.request_id ?? `oa_${randomBytes(12).toString('hex')}`,
    params,
    params_sha256: ownerActionHash(params),
    created: prior?.created ?? now.toISOString(),
    expires_at: prior?.expires_at === undefined ? requestExpiry(home, now) : prior.expires_at,
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
 * Records one request and drops its confirmation in the owner seat inbox. Refused with no owner seat.
 * Two callers that overlap on the lock share one card and one signature. Two calls in sequence stay
 * two requests: a join is taken only when the card's epoch is newer than the epoch this call read
 * before it waited.
 */
export function createOwnerActionRequest(
  home: string,
  input: OwnerActionRequestInput,
  now: Date = new Date(),
  open?: (url: string) => void,
): { ok: true; record: OwnerActionRecord; inbox: string | null; text: string; page: 'live' | 'closed' } | { ok: false; why: string } {
  if (readOwnerSeat(home) === null) return { ok: false, why: 'no owner seat is registered, so no owner-seat approval is possible; the owner registers one on the owner page (team owner-seat serve)' };
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
  const args: OwnerActionRequestInput['args'] = {};
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
    const record = JSON.parse(readFileSync(path, 'utf8')) as OwnerActionRecord;
    if (record.request_id !== id || record.params?.kind !== 'owner-action') return `request ${id} is not an owner-seat request`;
    if (ownerActionHash(record.params) !== record.params_sha256) return `request ${id}'s parameters do not match its hash`;
    return record;
  } catch {
    return `no owner-seat request ${id} can be read`;
  }
}

function boundAnswer(home: string, signed: SignedOwnerAnswer, record: OwnerActionRecord, store: OwnerSeatKeyStore, now: Date): { ok: true; answer: OwnerSeatAnswer; signer: string } | { ok: false; why: string } {
  const verified = verifyOwnerAnswer(home, signed, store, now);
  if (!verified.ok) return verified;
  const a = verified.answer;
  if (a.kind !== 'owner-action' || a.request_id !== record.request_id || a.params_sha256 !== record.params_sha256) return { ok: false, why: `the owner-seat answer is not bound to request ${record.request_id} and its parameters` };
  if (askedBy(record.params).includes(verified.signer.name)) return { ok: false, why: `signer "${verified.signer.name}" asked for request ${record.request_id}; no principal approves its own request` };
  return { ok: true, answer: a, signer: verified.signer.name };
}

/** The owner seat answers one request; `always` also stores a rule for the parent folder. */
export function approveOwnerAction(
  home: string,
  id: string,
  word: string,
  store: OwnerSeatKeyStore,
  now: Date = new Date(),
  via: { signer?: string; assertion?: { authenticator_data: string; client_data_json: string; signature: string } } = {},
): { ok: true; choice: 'once' | 'always' | 'deny'; ruleId?: string } | { ok: false; why: string } {
  const choice = answerChoiceOf(word);
  if (choice === null) return { ok: false, why: `"${word}" is not an answer: oui/approved/yes, always, or non/deny` };
  const record = readOwnerActionRecord(home, id);
  if (typeof record === 'string') return { ok: false, why: record };
  if (requestExpired(record.expires_at, now)) return { ok: false, why: `request ${id} expired at ${record.expires_at}` };
  const seat = readOwnerSeat(home);
  if (seat === null) return { ok: false, why: 'no owner seat is registered' };
  if (via.signer !== undefined && askedBy(record.params).includes(via.signer)) return { ok: false, why: `signer "${via.signer}" asked for request ${id}; no principal approves its own request` };
  const answer: OwnerSeatAnswer = {
    kind: 'owner-action', request_id: id, params_sha256: record.params_sha256, choice, team: seat.team, seat: 'owner', at: now.toISOString(),
    ...(choice === 'always' ? { scope: dirname(record.params.root) } : {}),
  };
  const signed = signOwnerAnswer(home, answer, via.signer, store, `TeamCLI: ${choice} — ${ownerActionSummary(record.params)}`, via.assertion);
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
  if (choice === 'always') {
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
  for (const name of names) {
    const id = name.slice(0, -5);
    try {
      const path = join(actionApprovalsFolder(home), name);
      if (!lstatSync(path).isFile()) throw new Error('kind');
      const file = JSON.parse(readFileSync(path, 'utf8')) as SignedOwnerAnswer & { params: OwnerActionParams };
      const p = file.params;
      if (p === undefined || p.kind !== 'owner-action') throw new Error('params');
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

export type OwnerActionAdmission = { ok: true; via: 'owner-seat' | 'rule' | 'charter'; requestId?: string; ruleId?: string; signer: string } | { ok: false; why: string };

/**
 * Admits one action run under request `id`: the request is whole, unexpired, names this action,
 * repository, team, HEAD and arguments, and holds a verified owner-seat answer bound to it — or a
 * verified `always` rule covers it. A real run claims the action single-use and writes an audit.
 */
export function admitOwnerAction(home: string, id: string, ask: OwnerActionAsk, store: OwnerSeatKeyStore, now: Date = new Date()): OwnerActionAdmission {
  const record = readOwnerActionRecord(home, id);
  if (typeof record === 'string') return { ok: false, why: record };
  const p = record.params;
  if (!p.actions.includes(ask.action)) return { ok: false, why: `request ${id} does not approve ${ask.action} (it names ${p.actions.join(', ')})` };
  if (p.root !== canonicalRoot(ask.root)) return { ok: false, why: `request ${id} is for ${p.root}, not this repository` };
  if (p.team !== ask.team) return { ok: false, why: `request ${id} is for team "${p.team}", not "${ask.team}"` };
  if (p.head !== null && p.head !== ask.head) return { ok: false, why: `request ${id} was approved at HEAD ${p.head.slice(0, 12)}; HEAD is now ${ask.head?.slice(0, 12) ?? 'unknown'}` };
  if (p.args[ask.action] !== actionArgsHash(ask.action, ask.words)) return { ok: false, why: `request ${id} was approved for other ${ask.action} arguments` };
  if (requestExpired(record.expires_at, now)) return { ok: false, why: `request ${id} expired at ${record.expires_at}` };
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
    if (record.expires_at !== null && !(Date.parse(bound.answer.at) <= Date.parse(record.expires_at))) return { ok: false, why: `the owner-seat answer to ${id} was given after the request expired` };
    if (bound.answer.choice === 'deny') return { ok: false, why: `the owner seat denied request ${id}` };
    admitted = { ok: true, via: 'owner-seat', requestId: id, signer: bound.signer };
  } else {
    const rule = ruleFor(home, ask, store, now);
    if (rule === undefined) return { ok: false, why: `request ${id} has no owner-seat answer yet; the owner answers it on the owner page` };
    admitted = { ok: true, via: 'rule', requestId: id, ruleId: rule.rule_id, signer: rule.signer };
  }
  if (!ask.claim) return admitted;
  const used = writeExclusive(join(actionRequestsFolder(home), `${id}.used-${ask.action}`), `${now.toISOString()}\n`);
  if (used !== 'written') return { ok: false, why: used === 'exists' ? `request ${id} was already used for ${ask.action}: an approval is single-use` : `request ${id} could not be claimed` };
  audit(home, `${id}.${ask.action}`, { request_id: id, action: ask.action, params: p, params_sha256: record.params_sha256, via: admitted.via, signer: admitted.signer, ...(admitted.ruleId ? { rule_id: admitted.ruleId } : {}), at: now.toISOString() });
  return admitted;
}

function ruleFor(home: string, ask: Pick<OwnerActionAsk, 'action' | 'root' | 'team'>, store: OwnerSeatKeyStore, now: Date): OwnerActionRule | undefined {
  const root = canonicalRoot(ask.root);
  return listOwnerActionRules(home, store, now).rules.find((r) => r.actions.includes(ask.action) && r.scope === dirname(root));
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

/** With no request id: a verified `always` rule for this action whose scope holds the repository. */
export function admitOwnerActionByRule(home: string, ask: Omit<OwnerActionAsk, 'head' | 'words'>, store: OwnerSeatKeyStore, now: Date = new Date()): OwnerActionAdmission {
  const rule = ruleFor(home, ask, store, now);
  if (rule === undefined) return { ok: false, why: 'no owner-seat always rule covers this action' };
  if (ask.claim) audit(home, `rule-${rule.rule_id}-${ask.action}-${now.getTime()}`, { rule_id: rule.rule_id, action: ask.action, root: canonicalRoot(ask.root), team: ask.team, via: 'rule', signer: rule.signer, at: now.toISOString() });
  return { ok: true, via: 'rule', ruleId: rule.rule_id, signer: rule.signer };
}

function audit(home: string, name: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(actionAuditFolder(home), { recursive: true, mode: 0o700 });
    writeExclusive(join(actionAuditFolder(home), `${name}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  } catch {}
}
