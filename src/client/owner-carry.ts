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
