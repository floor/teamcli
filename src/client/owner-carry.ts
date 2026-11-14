// Owner requests carried as files between a machine whose owner seat is pinned and the machine that
// holds the owner's signers, until the machine link exists. An agent copies the files; it can
// read them, and none of them grants anything on its own.
//
//   on the pinned machine   `--request` records the request as always, naming this machine in its
//                           signed parameters; `team approvals export <id> --out <file>` writes
//                           it as a request file;
//   on the signer machine   `team approvals sign --from <file>` records it as a foreign request
//                           (the owner page shows its card, which names the machine), the owner
//                           answers with the same Touch ID card or passkey as any other request,
//                           and the signed answer is written as an answer file;
//   back on the pinned one  `team approvals answer --from <file>` verifies the answer against the
//                           pinned owner seat and records it; the command runs with
//                           `--approval <id>` exactly as on any machine.
//
// Formats reused: the owner-action request record and its parameter hash, the signed owner-seat
// answer (`team-owner-seat-answer-v2`) and its passkey challenge, the owner-seat inbox card, the
// answer window and the single-use claim. Added: the two file envelopes below, which carry those
// records unchanged and are themselves unsigned; every check is made on what they carry.

import { closeSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  boundOwnerActionAnswer,
  heldOwnerActionAnswer,
  ownerActionBindingProblem,
  ownerActionDeadline,
  ownerActionRecordOf,
  readOwnerActionRecord,
  carriedAnswerTimeProblem,
  carriedRequestTimeProblem,
  approveOwnerActions,
  carriedOwnerAnswerCheck,
  recordCarriedOwnerAnswer,
  recordForeignOwnerAction,
  OWNER_ACTION_ID_PATTERN,
  type OwnerActionRecord,
} from './owner-action.ts';
import {
  CARRIED_FILE_MAX_BYTES,
  readMachine,
  readOwnerPin,
  requestMachineProblem,
  validMachineBinding,
  type MachineBinding,
} from './owner-pin.ts';
import { ownerMachinePinned } from './owner-pin-path.ts';
import { readOwnerSeat, type OwnerSeatAnswer, type OwnerSeatKeyStore, type SignedOwnerAnswer } from './owner-seat.ts';

export const OWNER_REQUEST_FILE_FORMAT = 'team-owner-request-file-v1';
export const OWNER_ANSWER_FILE_FORMAT = 'team-owner-answer-file-v1';

/** A request of a pinned machine, as a file: the record exactly as that machine holds it. */
export type OwnerRequestFile = {
  format: typeof OWNER_REQUEST_FILE_FORMAT;
  machine: MachineBinding;
  /** The fingerprint of the owner seat that machine pinned, so the signer machine can tell a stale pin. */
  owner_seat: string;
  request: OwnerActionRecord;
};

/** The owner's signed answer to one carried request, as a file. */
export type OwnerAnswerFile = {
  format: typeof OWNER_ANSWER_FILE_FORMAT;
  machine: MachineBinding;
  request_id: string;
  answer: SignedOwnerAnswer;
};

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reads one carried file: a plain file, small, whole JSON. A link, a folder or a large file is refused unread. */
export function readCarriedFile(cwd: string, path: string): { ok: true; value: unknown } | { ok: false; why: string } {
  const full = resolve(cwd, path);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return { ok: false, why: `${path} cannot be read` };
  }
  if (!stat.isFile()) return { ok: false, why: `${path} is not a plain file` };
  if (stat.size > CARRIED_FILE_MAX_BYTES) return { ok: false, why: `${path} is larger than a carried file can be` };
  try {
    return { ok: true, value: JSON.parse(readFileSync(full, 'utf8')) };
  } catch {
    return { ok: false, why: `${path} is not whole JSON` };
  }
}

/** Writes one carried file, created new (never over an existing file), readable by this user only. */
export function writeCarriedFile(cwd: string, path: string, value: unknown): { ok: true; path: string } | { ok: false; why: string } {
  const full = resolve(cwd, path);
  let fd: number;
  try {
    fd = openSync(full, 'wx', 0o600);
  } catch (error) {
    return { ok: false, why: (error as NodeJS.ErrnoException).code === 'EEXIST' ? `${path} exists already; nothing was written` : `${path} cannot be written` };
  }
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  return { ok: true, path: full };
}

/**
 * On a machine whose owner seat is pinned: one waiting request of this machine, as a request file.
 * The request must name this machine, be inside its answer window, and hold no answer yet.
 */
export function ownerRequestFile(home: string, id: string, store: OwnerSeatKeyStore, now: Date = new Date()): { ok: true; file: OwnerRequestFile } | { ok: false; why: string } {
  const pin = readOwnerPin(home);
  if (pin.kind === 'none') return { ok: false, why: "this machine's owner seat is not pinned from another machine; its requests are answered here" };
  if (pin.kind === 'refused') return { ok: false, why: pin.why };
  const record = readOwnerActionRecord(home, id);
  if (typeof record === 'string') return { ok: false, why: record };
  const elsewhere = requestMachineProblem(home, record.params.machine, id, record.params.account);
  if (elsewhere !== null) return { ok: false, why: elsewhere };
  const binding = ownerActionBindingProblem(home, record);
  if (binding !== null) return { ok: false, why: binding };
  if (ownerActionDeadline(home, record, store, now) <= now.getTime()) return { ok: false, why: `request ${id} expired at ${record.expires_at}` };
  if (heldOwnerActionAnswer(home, record, store, now) !== null) return { ok: false, why: `request ${id} is answered already` };
  return { ok: true, file: { format: OWNER_REQUEST_FILE_FORMAT, machine: record.params.machine!, owner_seat: pin.fingerprint, request: record } };
}

/** A request file, whole: its record verifies against its own hash and names the machine the file names. */
export function readOwnerRequestFile(raw: unknown): { ok: true; file: OwnerRequestFile } | { ok: false; why: string } {
  if (!plainObject(raw) || raw.format !== OWNER_REQUEST_FILE_FORMAT) return { ok: false, why: `the file is not a ${OWNER_REQUEST_FILE_FORMAT} record` };
  if (!validMachineBinding(raw.machine)) return { ok: false, why: 'the request file names no machine this build can read' };
  if (typeof raw.owner_seat !== 'string' || !/^[0-9a-f]{64}$/.test(raw.owner_seat)) return { ok: false, why: 'the request file names no owner seat fingerprint' };
  if (!plainObject(raw.request) || typeof raw.request.request_id !== 'string') return { ok: false, why: 'the request file carries no request' };
  const record = ownerActionRecordOf(raw.request, raw.request.request_id);
  if (typeof record === 'string') return { ok: false, why: record };
  if (typeof record.created !== 'string' || (record.expires_at !== null && typeof record.expires_at !== 'string')) return { ok: false, why: `request ${record.request_id} carries no answer window` };
  const machine = record.params.machine;
  if (machine === undefined || machine.id !== raw.machine.id || machine.name !== raw.machine.name) return { ok: false, why: `request ${record.request_id} does not name the machine its file names` };
  return { ok: true, file: { format: OWNER_REQUEST_FILE_FORMAT, machine, owner_seat: raw.owner_seat, request: record } };
}

/**
 * What the signer machine asks of one carried request before its card is recorded or shown: this
 * machine holds the owner's signers, the request is another machine's, it carries its signed
 * window and full argument words, it is dated no later than now, and its window is open.
 */
function carriedRequestProblem(home: string, file: OwnerRequestFile, store: OwnerSeatKeyStore, now: Date): string | null {
  if (ownerMachinePinned(home)) return "this machine's owner seat is pinned from another machine: it holds no owner signer to answer with";
  if (readOwnerSeat(home) === null) return 'no owner seat is registered on this machine';
  const here = readMachine(home);
  if (here !== null && here.id === file.machine.id) return `request ${file.request.request_id} is this machine's own; it is answered here, not carried`;
  // Before its card is recorded or shown: the signed window and the full argument words, each
  // action's hash matching the words the card will show (checked as the file was read).
  const binding = ownerActionBindingProblem(home, file.request);
  if (binding !== null) return binding;
  // A request dated ahead of this machine's clock would keep its window open for as long as it
  // says: it is never recorded or signed here.
  const dated = carriedRequestTimeProblem(file.request, now);
  if (dated !== null) return dated;
  if (ownerActionDeadline(home, file.request, store, now) <= now.getTime()) return `request ${file.request.request_id} expired at ${file.request.expires_at}`;
  return null;
}

export type SignOutcome =
  | { ok: true; kind: 'answered'; file: OwnerAnswerFile; choice: OwnerSeatAnswer['choice']; signer: string; fresh: boolean; stalePin: boolean }
  | { ok: true; kind: 'waiting'; text: string; fresh: boolean; stalePin: boolean }
  | { ok: false; why: string };

/**
 * On the machine that holds the owner's signers: records a carried request (idempotent) and returns
 * the answer file once the owner has answered. `answer` signs now — the same card and the same
 * answer `approveOwnerAction` makes for any request (Touch ID, or a passkey assertion) — and with
 * none, an answer the owner already gave on the owner page is returned, or the card waits there.
 * `fingerprint` is this machine's own owner seat fingerprint, to say when the other machine pinned
 * another one.
 */
export function signCarriedRequest(
  home: string,
  file: OwnerRequestFile,
  store: OwnerSeatKeyStore,
  now: Date,
  answer: ((record: OwnerActionRecord) => { ok: true } | { ok: false; why: string }) | null,
  fingerprint: string | null,
): SignOutcome {
  const problem = carriedRequestProblem(home, file, store, now);
  if (problem !== null) return { ok: false, why: problem };
  const stalePin = fingerprint !== null && fingerprint !== file.owner_seat;
  const recorded = recordForeignOwnerAction(home, file.request, now);
  if (!recorded.ok) return recorded;
  const record = readOwnerActionRecord(home, file.request.request_id);
  if (typeof record === 'string') return { ok: false, why: record };
  let held = heldOwnerActionAnswer(home, record, store, now);
  if (held === null && answer !== null) {
    if (ownerActionDeadline(home, record, store, now) <= now.getTime()) return { ok: false, why: `request ${record.request_id} expired at ${record.expires_at}` };
    const signed = answer(record);
    if (!signed.ok) return signed;
    held = heldOwnerActionAnswer(home, record, store, now);
    if (held === null) return { ok: false, why: `the answer to ${record.request_id} was signed but does not verify here` };
  }
  if (held === null) return { ok: true, kind: 'waiting', text: recorded.text, fresh: recorded.fresh, stalePin };
  const bound = boundOwnerActionAnswer(home, held, record, store, now);
  if (!bound.ok) return bound;
  return {
    ok: true,
    kind: 'answered',
    file: { format: OWNER_ANSWER_FILE_FORMAT, machine: file.machine, request_id: record.request_id, answer: held },
    choice: bound.answer.choice,
    signer: bound.signer,
    fresh: recorded.fresh,
    stalePin,
  };
}

/**
 * Back on the machine whose owner seat is pinned: records one carried answer. It must be for a
 * request this machine holds and names, inside its window, signed by a pinned and accepted signer
 * over exactly that request, and not yet answered or run. The command then runs with
 * `--approval <id>`, which checks all of it again and claims the request single-use.
 */
export function acceptCarriedAnswer(home: string, raw: unknown, store: OwnerSeatKeyStore, now: Date = new Date()): { ok: true; id: string; choice: OwnerSeatAnswer['choice']; signer: string; fingerprint: string; record: OwnerActionRecord } | { ok: false; why: string } {
  const checked = checkCarriedAnswer(home, raw, store, now);
  if (!checked.ok) return checked;
  const recorded = recordCarriedOwnerAnswer(home, checked.record, checked.signed, store, now);
  if (!recorded.ok) return recorded;
  return { ok: true, id: checked.id, choice: recorded.answer.choice, signer: recorded.signer, fingerprint: checked.fingerprint, record: checked.record };
}

type CheckedAnswer = { ok: true; id: string; record: OwnerActionRecord; signed: SignedOwnerAnswer; choice: OwnerSeatAnswer['choice']; signer: string; fingerprint: string };

/** Every check `acceptCarriedAnswer` makes on one carried answer, writing nothing. */
function checkCarriedAnswer(home: string, raw: unknown, store: OwnerSeatKeyStore, now: Date): CheckedAnswer | { ok: false; why: string } {
  if (!plainObject(raw) || raw.format !== OWNER_ANSWER_FILE_FORMAT) return { ok: false, why: `the file is not a ${OWNER_ANSWER_FILE_FORMAT} record` };
  if (typeof raw.request_id !== 'string' || !OWNER_ACTION_ID_PATTERN.test(raw.request_id)) return { ok: false, why: 'the answer file names no owner-seat request' };
  if (!validMachineBinding(raw.machine)) return { ok: false, why: 'the answer file names no machine this build can read' };
  if (!plainObject(raw.answer)) return { ok: false, why: 'the answer file carries no answer' };
  const id = raw.request_id;
  const pin = readOwnerPin(home);
  if (pin.kind === 'none') return { ok: false, why: "this machine's owner seat is not pinned from another machine; an answer is given here, not carried" };
  if (pin.kind === 'refused') return { ok: false, why: pin.why };
  const record = readOwnerActionRecord(home, id);
  if (typeof record === 'string') return { ok: false, why: record };
  const elsewhere = requestMachineProblem(home, record.params.machine, id, record.params.account);
  if (elsewhere !== null) return { ok: false, why: elsewhere };
  if (raw.machine.id !== record.params.machine!.id) return { ok: false, why: `the answer file is for machine ${raw.machine.name} (${raw.machine.id}), not this one` };
  const deadline = ownerActionDeadline(home, record, store, now);
  if (deadline <= now.getTime()) return { ok: false, why: `request ${id} expired at ${record.expires_at}` };
  const signed = raw.answer as unknown as SignedOwnerAnswer;
  const answerAt = Date.parse(String((signed.owner_seat_answer as { at?: unknown } | undefined)?.at));
  if (!(answerAt <= deadline)) return { ok: false, why: `the answer to ${id} was given after the request expired` };
  // Made no later than now, and answered inside its signed window, not ahead of this machine's clock.
  const dated = carriedRequestTimeProblem(record, now) ?? carriedAnswerTimeProblem(record, (signed.owner_seat_answer as { at?: unknown } | undefined)?.at, now);
  if (dated !== null) return { ok: false, why: dated };
  const checked = carriedOwnerAnswerCheck(home, record, signed, store, now);
  if (!checked.ok) return checked;
  return { ok: true, id, record, signed, choice: checked.answer.choice, signer: checked.signer, fingerprint: pin.fingerprint };
}

// Several requests carried together, so the owner answers them with one card and one user-presence
// prompt. A batch is an envelope around the same records and the same signed answers: each request
// keeps its own id, binding, window and single-use claim, and each answer is its own signature over
// its own request, recorded and spent as if it had been carried alone. A batch names one machine
// and one account; a member that names another, or that does not pass every check a single request
// passes, refuses the whole batch at every step. The owner's one prompt listed the whole set, and a
// file that no longer holds what that prompt listed is no longer what the owner answered: nothing
// in it is signed, and no answer from it is recorded. One file, one decision.

export const OWNER_REQUEST_BATCH_FORMAT = 'team-owner-request-batch-v1';
export const OWNER_ANSWER_BATCH_FORMAT = 'team-owner-answer-batch-v1';
/** The most requests one batch carries: one card stays short enough to read before it is signed. */
export const OWNER_BATCH_MAX = 16;

export type OwnerRequestBatchFile = {
  format: typeof OWNER_REQUEST_BATCH_FORMAT;
  machine: MachineBinding;
  owner_seat: string;
  requests: OwnerActionRecord[];
};

export type OwnerAnswerBatchFile = {
  format: typeof OWNER_ANSWER_BATCH_FORMAT;
  machine: MachineBinding;
  answers: { request_id: string; answer: SignedOwnerAnswer }[];
};

function batchSizeProblem(count: number): string | null {
  if (count < 2) return 'a batch carries two requests or more; one request is carried on its own';
  if (count > OWNER_BATCH_MAX) return `a batch carries at most ${OWNER_BATCH_MAX} requests`;
  return null;
}

/** The account a request names, as one comparable word: none is its own value. */
function accountOf(record: OwnerActionRecord): string {
  return record.params.account === undefined ? '' : `account:${record.params.account}`;
}

/**
 * On a machine whose owner seat is pinned: several waiting requests of this machine, as one batch
 * file. Each must pass exactly what `ownerRequestFile` asks of one, and they must all name this
 * machine and the same account.
 */
export function ownerRequestBatchFile(home: string, ids: readonly string[], store: OwnerSeatKeyStore, now: Date = new Date()): { ok: true; file: OwnerRequestBatchFile } | { ok: false; why: string } {
  const size = batchSizeProblem(ids.length);
  if (size !== null) return { ok: false, why: size };
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined) return { ok: false, why: `"${repeated}" is named twice; nothing was written` };
  const files: OwnerRequestFile[] = [];
  for (const id of ids) {
    const made = ownerRequestFile(home, id, store, now);
    if (!made.ok) return { ok: false, why: `${made.why}; nothing was written` };
    files.push(made.file);
  }
  const first = files[0]!;
  const mixed = sameMachineAndAccount(files.map((one) => one.request), first.machine);
  if (mixed !== null) return { ok: false, why: `${mixed}; nothing was written` };
  return { ok: true, file: { format: OWNER_REQUEST_BATCH_FORMAT, machine: first.machine, owner_seat: first.owner_seat, requests: files.map((one) => one.request) } };
}

/** Why a set of records is not one machine's and one account's, or null. */
function sameMachineAndAccount(records: readonly OwnerActionRecord[], machine: MachineBinding): string | null {
  for (const record of records) {
    const named = record.params.machine;
    if (named === undefined || named.id !== machine.id || named.name !== machine.name) return `request ${record.request_id} names another machine than the batch: a batch carries one machine's requests`;
  }
  const account = accountOf(records[0]!);
  const other = records.find((record) => accountOf(record) !== account);
  if (other !== undefined) return `request ${other.request_id} names another account than the batch: a batch carries one account's requests`;
  return null;
}

/** A batch request file, whole: every member reads as a request file of the batch's machine would. */
export function readOwnerRequestBatchFile(raw: unknown): { ok: true; batch: OwnerRequestBatchFile; members: OwnerRequestFile[] } | { ok: false; why: string } {
  if (!plainObject(raw) || raw.format !== OWNER_REQUEST_BATCH_FORMAT) return { ok: false, why: `the file is not a ${OWNER_REQUEST_BATCH_FORMAT} record` };
  if (!validMachineBinding(raw.machine)) return { ok: false, why: 'the batch file names no machine this build can read' };
  if (!Array.isArray(raw.requests)) return { ok: false, why: 'the batch file carries no requests' };
  const size = batchSizeProblem(raw.requests.length);
  if (size !== null) return { ok: false, why: size };
  const members: OwnerRequestFile[] = [];
  for (const request of raw.requests as unknown[]) {
    const one = readOwnerRequestFile({ format: OWNER_REQUEST_FILE_FORMAT, machine: raw.machine, owner_seat: raw.owner_seat, request });
    if (!one.ok) return { ok: false, why: `${one.why}; nothing in the batch is signed` };
    members.push(one.file);
  }
  const ids = members.map((one) => one.request.request_id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined) return { ok: false, why: `request ${repeated} is in the batch twice; nothing in the batch is signed` };
  const mixed = sameMachineAndAccount(members.map((one) => one.request), raw.machine);
  if (mixed !== null) return { ok: false, why: `${mixed}; nothing in the batch is signed` };
  const machine = members[0]!.machine;
  return { ok: true, batch: { format: OWNER_REQUEST_BATCH_FORMAT, machine, owner_seat: members[0]!.owner_seat, requests: members.map((one) => one.request) }, members };
}

export type BatchSignOutcome =
  | { ok: true; kind: 'answered'; file: OwnerAnswerBatchFile; answered: { id: string; choice: OwnerSeatAnswer['choice']; signer: string }[]; prompts: number; stalePin: boolean }
  | { ok: true; kind: 'waiting'; waiting: string[]; stalePin: boolean }
  | { ok: false; why: string };

/**
 * On the machine that holds the owner's signers: records every request of a batch (each one as
 * `signCarriedRequest` records one), then, with `word`, signs the ones not answered yet under one
 * prompt that lists them all. Every member is checked before any is recorded or signed; one that
 * fails refuses the batch. With no word, the batch is answered once every member holds an answer
 * the owner gave on the owner page, and waits otherwise.
 */
export function signCarriedBatch(
  home: string,
  members: readonly OwnerRequestFile[],
  store: OwnerSeatKeyStore,
  now: Date,
  word: string | null,
  signer: string | undefined,
  fingerprint: string | null,
): BatchSignOutcome {
  for (const member of members) {
    const problem = carriedRequestProblem(home, member, store, now);
    if (problem !== null) return { ok: false, why: `${problem}; nothing in the batch is signed` };
  }
  const machine = members[0]!.machine;
  const stalePin = fingerprint !== null && fingerprint !== members[0]!.owner_seat;
  for (const member of members) {
    const recorded = recordForeignOwnerAction(home, member.request, now);
    if (!recorded.ok) return { ok: false, why: `${recorded.why}; nothing in the batch is signed` };
  }
  const records: OwnerActionRecord[] = [];
  for (const member of members) {
    const record = readOwnerActionRecord(home, member.request.request_id);
    if (typeof record === 'string') return { ok: false, why: record };
    records.push(record);
  }
  const unanswered = records.filter((record) => heldOwnerActionAnswer(home, record, store, now) === null);
  let prompts = 0;
  if (unanswered.length > 0) {
    if (word === null) return { ok: true, kind: 'waiting', waiting: unanswered.map((record) => record.request_id), stalePin };
    const title = `${unanswered.length} requests from machine ${machine.name}`;
    const signed = approveOwnerActions(home, unanswered.map((record) => record.request_id), word, store, now, { ...(signer === undefined ? {} : { signer }), title });
    if (!signed.ok) return signed;
    prompts = signed.prompts;
  }
  const answers: OwnerAnswerBatchFile['answers'] = [];
  const answered: { id: string; choice: OwnerSeatAnswer['choice']; signer: string }[] = [];
  for (const record of records) {
    const held = heldOwnerActionAnswer(home, record, store, now);
    if (held === null) return { ok: false, why: `the answer to ${record.request_id} was signed but does not verify here` };
    const bound = boundOwnerActionAnswer(home, held, record, store, now);
    if (!bound.ok) return bound;
    answers.push({ request_id: record.request_id, answer: held });
    answered.push({ id: record.request_id, choice: bound.answer.choice, signer: bound.signer });
  }
  return { ok: true, kind: 'answered', file: { format: OWNER_ANSWER_BATCH_FORMAT, machine, answers }, answered, prompts, stalePin };
}

/**
 * Back on the machine whose owner seat is pinned: records every answer of a batch. Each answer is
 * checked exactly as `acceptCarriedAnswer` checks one, all of them before any is recorded; one that
 * fails refuses the batch and records none. Each request then runs with its own `--approval <id>`.
 */
export function acceptCarriedAnswerBatch(home: string, raw: unknown, store: OwnerSeatKeyStore, now: Date = new Date()): { ok: true; answered: { id: string; choice: OwnerSeatAnswer['choice']; signer: string }[]; fingerprint: string } | { ok: false; why: string } {
  if (!plainObject(raw) || raw.format !== OWNER_ANSWER_BATCH_FORMAT) return { ok: false, why: `the file is not a ${OWNER_ANSWER_BATCH_FORMAT} record` };
  if (!validMachineBinding(raw.machine)) return { ok: false, why: 'the batch answer file names no machine this build can read' };
  if (!Array.isArray(raw.answers)) return { ok: false, why: 'the batch answer file carries no answers' };
  const size = batchSizeProblem(raw.answers.length);
  if (size !== null) return { ok: false, why: size };
  const checked: CheckedAnswer[] = [];
  for (const entry of raw.answers as unknown[]) {
    if (!plainObject(entry)) return { ok: false, why: 'the batch answer file carries an entry that is not an answer; no answer was recorded' };
    const one = checkCarriedAnswer(home, { format: OWNER_ANSWER_FILE_FORMAT, machine: raw.machine, request_id: entry.request_id, answer: entry.answer }, store, now);
    if (!one.ok) return { ok: false, why: `${one.why}; no answer in the batch was recorded` };
    checked.push(one);
  }
  const ids = checked.map((one) => one.id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined) return { ok: false, why: `request ${repeated} is in the batch twice; no answer in the batch was recorded` };
  const mixed = sameMachineAndAccount(checked.map((one) => one.record), raw.machine);
  if (mixed !== null) return { ok: false, why: `${mixed}; no answer in the batch was recorded` };
  const answered: { id: string; choice: OwnerSeatAnswer['choice']; signer: string }[] = [];
  for (const one of checked) {
    const recorded = recordCarriedOwnerAnswer(home, one.record, one.signed, store, now);
    if (!recorded.ok) return { ok: false, why: answered.length === 0 ? `${recorded.why}; no answer in the batch was recorded` : `${recorded.why}; ${answered.map((done) => done.id).join(', ')} recorded before it` };
    answered.push({ id: one.id, choice: recorded.answer.choice, signer: recorded.signer });
  }
  return { ok: true, answered, fingerprint: checked[0]!.fingerprint };
}
