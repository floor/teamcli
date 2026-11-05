// `team messages`: verify a record that is already waiting, publish the read receipt that proves
// it was served, and only then print its body. The signed read receipt is the per-id gate every
// reader shares — this command, `team drops --read` and `inbox_read` — so the receipt is written
// with an exclusive link and flushed before the body, and a record another reader already served
// is skipped. An entry at a receipt name that does not verify is held, never replaced.
//
// A run serves one mailbox: the owner's, or the seat its caller is placed as. Records for other
// seats share the transport tree, and they are listed read-only — a `waiting` row, no body, no
// receipt — because a receipt is the read that proves exposure, and only the addressed seat's
// reader may spend its mail. A caller the placement cannot resolve reads nothing at all.
//
// A send of this version writes a signed record into the recipient's transport tree,
// `<root>/.agents/send-drops/<session>/<seat>/<id>` (`src/send/record.ts`), and this command reads
// it there. The older `.agents/messages/<seat>/<id>.json` store is still read, read-only, so a
// record a previous build left verifies the same way; nothing writes it any more. The signature
// is integrity: every seat runs as the owner-user, so it is not proof of who sent it.
import { type KeyObject } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readArgs } from '../args.ts';
import { raiseRefusalEvent } from '../bus/refusals.ts';
import { describeCaller, judgeCallerIn, type Caller } from '../caller.ts';
import { runClientMessages } from '../client/inbox.ts';
import { isNoRepository, withoutFileOffer } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Command, Io } from '../io.ts';
import { isGeneralBriefRecord } from '../launch/general-brief.ts';
import { heldAt, type Held } from '../launch/rules-file.ts';
import {
  contextLine,
  formatRelativeTime,
  hasJsonFlag,
  pluralCount,
  renderDifferences,
  renderNotes,
  renderTable,
  summaryCounts,
  ttyStyle,
  toJsonDifference,
  writeJson,
  writeJsonError,
  type OutputDifference,
} from '../output/index.ts';
import { teamIdOf } from '../registry/teams.ts';
import { compareSeatNames } from '../seat-names.ts';
import { namingFor, senderDisplayName, type SenderNaming } from '../send/names.ts';
import { writeAtomic } from '../state.ts';
import {
  messageKeyOf,
  messageKeyState,
  MESSAGE_DOMAIN,
  RECEIPT_DOMAIN,
  signDomain,
  verifyDomain,
  type Json,
} from '../store/keys.ts';
import {
  isRead,
  recordAuthOfSealed,
  recordFile,
  sealedRecordOf,
  signedRecordOf,
  verifiedRecordAt,
  type RecordPayload,
  type RecordReader,
  type SignedRecord,
} from '../send/record.ts';
import { publishRecordRead } from '../send/read-receipt.ts';
import { noteUnread } from '../send/unread-hint.ts';

export const USAGE = `Usage: team messages [--json]
Usage: team messages --client <grant-file> --key <key-file> [--since <id>] [--ack <id>] [--limit <n>] [--request-id <id>] [--follow] [--json]

Exits 0 when the inbox is read, 1 when the caller, team file, or message record is refused, 2 when the invocation can't be read or this folder is neither a checkout nor a team root.
`;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** The owner's mailbox folder, `.agents/messages/owner/`. It is spelled here rather than imported
 *  from `src/bus/owner.ts`: that module imports this one for `messageFile`, so importing its
 *  constant back would close a cycle. The Runtime writes the owner's signed records under this
 *  name, and the owner's own call is the only reader it is scoped to. */
const OWNER_MAILBOX = 'owner';

/** The payload the older `.agents/messages` store holds. New sends write a signed record into
 *  the transport tree instead; this shape is read, never written. */
export type MessagePayload = {
  kind: 'message';
  id: string;
  to: string;
  root: string;
  session: string;
  at: string;
  body: string;
  from: string;
};

/** The receipt the older store's read writes. New reads write `src/send/record.ts`'s receipt,
 *  which carries its status. */
export type LegacyReceiptPayload = {
  kind: 'receipt';
  id: string;
  to: string;
  root: string;
  session: string;
  at: string;
};

export type MessagesSources = {
  home: string;
  now(): Date;
  /** The pause between `--follow` reads; tests hand in one that resolves at once. */
  followWait?(): Promise<void>;
  /** How many reads a `--follow` run makes before it returns; absent: until it is stopped. */
  followReads?: number;
};

/** The pause between two `--follow` reads: short, so a reply prints within a few seconds without a replay record every second. */
export const FOLLOW_INTERVAL_MS = 3000;

export const realSources: MessagesSources = { home: homedir(), now: () => new Date() };

export const messages: Command = (argv, io) => runMessages(argv, io, realSources);
export default messages;

/** `.agents/messages/<seat>/<id>.json`: the store a previous build wrote. The filename is the
 *  id; the directory is the recipient. */
export function messageFile(root: string, seat: string, id: string): string {
  return join(root, '.agents', 'messages', seat, `${id}.json`);
}

export function receiptFile(root: string, seat: string, id: string): string {
  return join(root, '.agents', 'messages', seat, `${id}.read.json`);
}

/** The folder a session's records live in: `<root>/.agents/send-drops/<session>/<seat>`. */
export function recordDir(root: string, session: string, seat: string): string {
  return join(root, '.agents', 'send-drops', session, seat);
}

/** One candidate file: a signed record in the transport tree, or a legacy message file. */
type Candidate = {
  store: 'record' | 'legacy';
  seat: string;
  id: string;
  path: string;
  /** The session directory the record was found under (records only). */
  session?: string;
};

export type Unacked = { id: string; to: string; at: string };

/** One unread message with what its wake line shows: the sender the signed record carries, the
 *  body the summary is read from, and the sender's own subject when one was written. */
export type UnackedMessage = Unacked & {
  from: string;
  from_id: string | null;
  body: string;
  subject?: string;
};

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Two spellings of one folder: the real paths where both can be read, the strings otherwise. */
export function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string';
}

/** The payload a legacy message signature covers, or null when the file is not that shape. */
export function messagePayload(value: unknown): MessagePayload | null {
  if (!isRecord(value)) return null;
  const payload = value.payload;
  if (!isRecord(payload)) return null;
  if (payload.kind !== 'message') return null;
  if (!text(payload.id) || !text(payload.to) || !text(payload.root) || !text(payload.session)) return null;
  if (!text(payload.at) || !text(payload.body) || !text(payload.from)) return null;
  if (!text(value.signature)) return null;
  return payload as MessagePayload;
}

export function legacyReceiptMatches(path: string, seat: string, id: string, root: string, session: string, key: KeyObject): boolean {
  if (!isFile(path)) return false;
  const parsed = readJson(path);
  if (!isRecord(parsed) || !isRecord(parsed.payload) || !text(parsed.signature)) return false;
  const payload = parsed.payload;
  if (payload.kind !== 'receipt') return false;
  if (payload.id !== id || payload.to !== seat || payload.session !== session) return false;
  if (!text(payload.root) || !samePath(payload.root, root)) return false;
  if (!text(payload.at)) return false;
  return verifyDomain(RECEIPT_DOMAIN, payload as Json, parsed.signature, key);
}

function legacyCandidates(root: string): Candidate[] {
  const dir = join(root, '.agents', 'messages');
  if (!isDir(dir)) return [];
  const out: Candidate[] = [];
  // Seat directories in the seats' own order, not the filesystem's string order: builder-9
  // before builder-10 before builder-100. Message ids inside a seat keep their code-unit sort.
  for (const seat of readdirSync(dir).sort(compareSeatNames)) {
    if (!NAME.test(seat)) continue;
    const seatDir = join(dir, seat);
    if (!isDir(seatDir)) continue;
    for (const name of readdirSync(seatDir).sort()) {
      if (!name.endsWith('.json') || name.endsWith('.read.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!NAME.test(id)) continue;
      const path = join(seatDir, name);
      if (!isFile(path)) continue;
      out.push({ store: 'legacy', seat, id, path });
    }
  }
  return out;
}

/** The marker names left beside a record; none of them is a message. A send leaves the pending,
 *  taken, read and receipt names; the unread watch leaves `.wake` beside a message whose one wake
 *  line it typed and `.reported` beside one whose sender and lead it told. A `.new` name is the
 *  private temp `publishReadReceipt` writes in this folder before it links the receipt: it is
 *  JSON, and it matches a record's name shape, but it is not a record. Listing it would refuse
 *  a message that was never sent whenever a read and `team messages` cross. */
function isMarkerName(name: string): boolean {
  return name.endsWith('.pending') || name.endsWith('.taken') || name.endsWith('.read')
    || name.endsWith('.wake') || name.endsWith('.reported') || name.endsWith('.json')
    || name.endsWith('.new');
}

/** The prefix a work nudge's file carries: the watch writes it into the same folder, and it is a
 *  prompt for the seat, not a message record (`work-<uuid>`). */
const WORK_PREFIX = 'work-';

/** The signed records in `<root>/.agents/send-drops/<session>/<seat>/<id>`. A name that is not a
 *  record's id — a pending marker, a taken marker, an inbox receipt, the unread watch's wake or
 *  report marker, a receipt publisher's `.new` temp, a work nudge — is not a candidate. The names
 *  alone are returned here; whether a regular file at one is JSON is read by each caller. */
function recordNames(root: string, session: string): Candidate[] {
  const dir = join(root, '.agents', 'send-drops', session);
  if (!isDir(dir)) return [];
  const out: Candidate[] = [];
  for (const seat of readdirSync(dir).sort(compareSeatNames)) {
    if (!NAME.test(seat)) continue;
    const seatDir = join(dir, seat);
    if (!isDir(seatDir)) continue;
    for (const name of readdirSync(seatDir).sort()) {
      if (!NAME.test(name) || isMarkerName(name) || name.startsWith(WORK_PREFIX)) continue;
      const path = join(seatDir, name);
      if (!isFile(path)) continue;
      out.push({ store: 'record', seat, id: name, path, session });
    }
  }
  return out;
}

/** The record candidates `team messages` lists. A body file written before the record spine is
 *  plain text: it stays in the folder for its seat to read, but it names no message, so the
 *  inbox neither shows nor refuses it. A JSON file is held to the record's shape. The unacked
 *  read does not need this look up front: it reads each record once, after the receipt, and a
 *  file that is not JSON is no more a record there. */
function recordCandidates(root: string, session: string): Candidate[] {
  return recordNames(root, session).filter((candidate) => readJson(candidate.path) !== undefined);
}

function candidates(root: string, session: string): Candidate[] {
  return [...recordCandidates(root, session), ...legacyCandidates(root)];
}

/** Whether the record at `candidate` is already served: a signed `read` or `replied` receipt
 *  verifies for this message and inbox. A reply counts as the read that came before it, the same
 *  answer `readMessage`, `team drops` and the watch share, so no reader shows a body again and the
 *  watch does not ring for a message that was already answered. */
function recordReadHeld(candidate: Candidate, root: string, session: string, key: KeyObject): boolean {
  const context = { to: candidate.seat, root, session: candidate.session ?? session };
  return isRead(recordDir(root, context.session, candidate.seat), candidate.id, context, key);
}

/**
 * The payload of a record another user owns, read the way this list read every record before the
 * pass's shared reader existed: the file as JSON, then its envelope and the signature over its
 * own payload. The strict reader refuses such a file before it opens it, and with that refusal
 * standing alone the record would leave the unacked list even though the slow read listed it.
 * Only that refusal falls back: the file must be a regular file this user does not own, so a
 * record this user owns is never read twice and a link, a folder or a FIFO is refused as the
 * reader refuses it.
 */
function foreignRecordPayload(path: string, key: KeyObject): RecordPayload | null {
  const held = heldAt(path);
  if (held.kind !== 'file') return null;
  if (process.getuid === undefined || held.uid === process.getuid()) return null;
  const sealed = sealedRecordOf(readJson(path));
  if (sealed === null) return null;
  const auth = recordAuthOfSealed(sealed, key);
  return auth.kind === 'ok' ? auth.value.payload : null;
}

/**
 * Records with no verifying read receipt, with the fields a wake line reads. A missing message
 * key yields nothing: a signature cannot be checked, and this read does not create the key. The
 * watch rings from this list. The receipt is checked before the record is read, and the record is
 * read once: `records` lets a caller scanning several folders in one pass hand in the reader that
 * keeps that read for the pass. The one record that reader refuses by ownership — a regular file
 * that belongs to another user — is read the slow way here, so it stays waiting mail exactly as
 * it did before the shared reader took that read.
 */
export function listUnackedMessages(
  root: string,
  session: string,
  home: string,
  records?: RecordReader,
): UnackedMessage[] {
  const state = messageKeyState(home);
  if (state.kind !== 'key') return [];
  const readRecordAt: RecordReader = records ?? ((path, id) => verifiedRecordAt(path, id, state.key));
  const out: UnackedMessage[] = [];
  for (const candidate of [...recordNames(root, session), ...legacyCandidates(root)]) {
    if (candidate.store === 'legacy') {
      if (legacyReceiptMatches(receiptFile(root, candidate.seat, candidate.id), candidate.seat, candidate.id, root, session, state.key)) continue;
      const parsed = readJson(candidate.path);
      const payload = messagePayload(parsed);
      if (!payload || !isRecord(parsed) || !text(parsed.signature)) continue;
      if (payload.id !== candidate.id || payload.to !== candidate.seat) continue;
      if (payload.session !== session || !samePath(payload.root, root)) continue;
      if (!verifyDomain(MESSAGE_DOMAIN, payload as Json, parsed.signature, state.key)) continue;
      // A legacy message carries no agent id and no subject: its sender is its signed `from`.
      out.push({ id: candidate.id, to: candidate.seat, at: payload.at, from: payload.from, from_id: null, body: payload.body });
      continue;
    }
    if (recordReadHeld(candidate, root, session, state.key)) continue;
    const payload = readRecordAt(candidate.path, candidate.id) ?? foreignRecordPayload(candidate.path, state.key);
    if (payload === null) continue;
    // The complete raw payload authenticates before any field this list would report is read.
    if (payload.id !== candidate.id || payload.to !== candidate.seat) continue;
    if (payload.session !== (candidate.session ?? session) || !samePath(payload.root, root)) continue;
    out.push({
      id: candidate.id,
      to: candidate.seat,
      at: payload.at,
      from: payload.from,
      from_id: payload.from_id,
      body: payload.body,
      ...(payload.subject === undefined ? {} : { subject: payload.subject }),
    });
  }
  return out;
}

/** The ids of the records with no verifying read receipt: the ring's recheck. */
export function listUnacked(root: string, session: string, home: string): Unacked[] {
  return listUnackedMessages(root, session, home).map((record) => ({ id: record.id, to: record.to, at: record.at }));
}

/**
 * Writes one legacy record the way a previous sender did, signing with the message key. Tests
 * and the evidence harness are the only callers; only the transport tree is written by a send.
 */
export function plantMessage(home: string, root: string, seat: string, id: string, payload: MessagePayload, signature?: string): void {
  const key = messageKeyOf(home);
  const signed = signature ?? signDomain(MESSAGE_DOMAIN, payload as Json, key);
  const path = messageFile(root, seat, id);
  mkdirSync(join(root, '.agents', 'messages', seat), { recursive: true });
  writeAtomic(path, `${JSON.stringify({ payload, signature: signed }, null, 2)}\n`);
}

/**
 * Writes one signed record into the transport tree as a sender would. Tests and the evidence
 * harness are the only callers; a send builds and signs its own record (`src/send/record.ts`).
 */
export function plantRecord(
  home: string,
  root: string,
  session: string,
  seat: string,
  id: string,
  body: string,
  fields: Partial<Pick<RecordPayload, 'from' | 'from_id' | 'to_id' | 'rule' | 'at' | 'thread' | 'in_reply_to'>> = {},
): string {
  const key = messageKeyOf(home);
  const at = fields.at ?? new Date().toISOString();
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: seat,
    to_id: fields.to_id ?? null,
    root,
    session,
    at,
    body,
    from: fields.from ?? 'lead',
    from_id: fields.from_id ?? null,
    rule: fields.rule ?? 'the lead to a seat of its own team',
    thread: fields.thread ?? id,
    ...(fields.in_reply_to !== undefined ? { in_reply_to: fields.in_reply_to } : {}),
  };
  const record: SignedRecord = { payload, signature: signDomain(MESSAGE_DOMAIN, payload as unknown as Json, key) };
  const dir = recordDir(root, session, seat);
  mkdirSync(dir, { recursive: true });
  const path = recordFile(dir, id);
  writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
  // The helper writes what a send writes: the record and the recipient's unread index entry
  // naming it, so a fixture reads exactly as a landed drop does.
  noteUnread(dir, payload.from, id, at);
  return path;
}

type Problem = { kind: 'shape' | 'id' | 'seat' | 'root' | 'session' | 'signature' | 'unsupported'; text: string };

type Verified = { from: string; from_id: string | null; to: string; at: string; body: string };

function recordProblem(candidate: Candidate, root: string, session: string, key: KeyObject): Problem | Verified {
  const where = `${candidate.seat}/${candidate.id}`;
  const sealed = sealedRecordOf(readJson(candidate.path));
  if (sealed === null) return { kind: 'shape', text: `${where} does not verify: the record is not a message record` };
  // Authentication covers the complete raw payload before a single field decides attribution:
  // a record whose bytes were changed after signing is a signature refusal whatever its fields
  // now claim, and a signed record carrying fields this version does not read is refused on
  // that ground, never reported as a signature failure and never interpreted.
  const auth = recordAuthOfSealed(sealed, key);
  if (auth.kind === 'shape') return { kind: 'shape', text: `${where} does not verify: the record is not a message record` };
  if (auth.kind === 'tampered') return { kind: 'signature', text: `${where} does not verify: the signature is not the message key's` };
  if (auth.kind === 'unsupported') {
    return { kind: 'unsupported', text: `${where} does not verify: it is signed, and this version cannot read it: ${auth.reason}` };
  }
  const payload = auth.value.payload;
  if (payload.id !== candidate.id) {
    return { kind: 'id', text: `${where} does not verify: its id is ${payload.id}, and the filename is the id` };
  }
  if (payload.to !== candidate.seat) {
    return { kind: 'seat', text: `${where} does not verify: it is addressed to ${payload.to}` };
  }
  if (!samePath(payload.root, root)) {
    return { kind: 'root', text: `${where} does not verify: it is bound to another checkout` };
  }
  if (payload.session !== (candidate.session ?? session)) {
    return { kind: 'session', text: `${where} does not verify: it is bound to session ${JSON.stringify(payload.session)}` };
  }
  return { from: payload.from, from_id: payload.from_id, to: payload.to, at: payload.at, body: payload.body };
}

function problemOf(candidate: Candidate, root: string, session: string, key: KeyObject): Problem | Verified {
  if (candidate.store === 'record') return recordProblem(candidate, root, session, key);
  const where = `${candidate.seat}/${candidate.id}`;
  const parsed = readJson(candidate.path);
  const payload = messagePayload(parsed);
  if (!payload || !isRecord(parsed)) return { kind: 'shape', text: `${where} does not verify: the record is not a message` };
  if (payload.id !== candidate.id) {
    return { kind: 'id', text: `${where} does not verify: its id is ${payload.id}, and the filename is the id` };
  }
  if (payload.to !== candidate.seat) {
    return { kind: 'seat', text: `${where} does not verify: it is addressed to ${payload.to}` };
  }
  if (!samePath(payload.root, root)) {
    return { kind: 'root', text: `${where} does not verify: it is bound to another checkout` };
  }
  if (payload.session !== session) {
    return { kind: 'session', text: `${where} does not verify: it is bound to session ${JSON.stringify(payload.session)}` };
  }
  if (!verifyDomain(MESSAGE_DOMAIN, payload as Json, parsed.signature as string, key)) {
    return { kind: 'signature', text: `${where} does not verify: the signature is not the message key's` };
  }
  // The older store never carried the sender's registry id.
  return { from: payload.from, from_id: null, to: payload.to, at: payload.at, body: payload.body };
}

/**
 * The gate a transport-tree body passes before it is printed. The signed `read` receipt is the
 * per-id fact every reader races to create, and it is published with `link` — exclusive and
 * no-clobber — and flushed before the body is shown, so at most one `team messages` read, `team
 * drops --read` or `inbox_read` returns the content, and the receipt that proves the exposure
 * survives a crash that follows it. `team messages` used to print first and write the receipt
 * after, which let a concurrent automatic read return the same body twice, and let a check-then-
 * rename replace the automatic reader's receipt.
 *
 * `served` is another reader's valid `read` or `replied` receipt: the id already went out, and
 * this run skips it without a row. A file at the read or replied receipt name that does not
 * verify for this message is uncertainty — it may hide a read that happened — so the run shows no
 * body, leaves the entry exactly as it is, and reports it as a refused row. The same holds for a
 * link, a FIFO or a folder at either name. A receipt this reader publishes but cannot make durable
 * is not proof either: the body is not shown, the id is spent, and the refusal says so.
 */
type ReadGate =
  | { kind: 'shown' }
  | { kind: 'served' }
  | { kind: 'refused'; what: string; repair: string };

/** The relative path of one record's receipt, as the caller reads it in a repair line. */
function recordReceiptPath(candidate: Candidate, status: 'read' | 'replied'): string {
  return `${mailboxPath(candidate)}.${status}.json`;
}

/** A refused gate outcome for an entry at a receipt name the run will not touch. The entry is
 *  preserved: it may be the only evidence a body was exposed, so nothing here deletes or repairs
 *  it, and the repair line sends the caller to look at it, not to remove it blindly. */
function heldReceipt(candidate: Candidate, status: 'read' | 'replied', entry: Exclude<Held['kind'], 'missing'>): ReadGate {
  return {
    kind: 'refused',
    what: entry === 'file'
      ? `${candidate.seat}/${candidate.id} was not shown: the ${status} receipt name is held by a file that does not verify for this message`
      : `${candidate.seat}/${candidate.id} was not shown: the ${status} receipt path is held by something that is not a file`,
    repair: `inspect ${recordReceiptPath(candidate, status)}: it is left as it is, because it may record a read that already happened`,
  };
}

/** The shared receipt act (`publishRecordRead`), in this command's words: a published receipt is
 *  the right to show the body; a valid receipt another reader wrote is `served`, with no body
 *  printed; an entry at a receipt name is left exactly as it is; and a receipt this run could not
 *  confirm is a refusal that names why, never a body. */
function openRecord(
  candidate: Candidate,
  root: string,
  session: string,
  home: string,
  key: KeyObject,
  at: string,
): ReadGate {
  const recordSession = candidate.session ?? session;
  const outcome = publishRecordRead({
    dropDir: recordDir(root, recordSession, candidate.seat),
    id: candidate.id,
    to: candidate.seat,
    root,
    session: recordSession,
    home,
    key,
    at,
  });
  if (outcome.kind === 'published') return { kind: 'shown' };
  if (outcome.kind === 'served') return { kind: 'served' };
  if (outcome.kind === 'held') return heldReceipt(candidate, outcome.status, outcome.entry);
  if (outcome.reason === 'changed') {
    return {
      kind: 'refused',
      what: `${candidate.seat}/${candidate.id} was not shown: the read receipt name changed while it was being published`,
      repair: 'run team messages again',
    };
  }
  if (outcome.reason === 'write') {
    return {
      kind: 'refused',
      what: `${candidate.seat}/${candidate.id} was not shown: the read receipt could not be written`,
      repair: 'run team messages again once the receipt folder can be written',
    };
  }
  // The receipt must survive a crash before the body is shown. A receipt that cannot be flushed is
  // not proof: the id stays spent, and this run shows nothing.
  return {
    kind: 'refused',
    what: `${candidate.seat}/${candidate.id} was not shown: the read receipt could not be made durable`,
    repair: 'leave the receipt in place: it already records this read, and the message stays spent',
  };
}

/**
 * Writes the read receipt for an older-store message that was shown. That store keeps its own
 * receipt shape and its print-then-write order; only transport-tree records pass `openRecord`.
 */
function writeReadReceipt(home: string, candidate: Candidate, root: string, session: string, at: string): void {
  const receipt: LegacyReceiptPayload = {
    kind: 'receipt',
    id: candidate.id,
    to: candidate.seat,
    root,
    session,
    at,
  };
  const key = messageKeyState(home);
  if (key.kind !== 'key') throw new Error('the message key disappeared before the receipt was signed');
  const signature = signDomain(RECEIPT_DOMAIN, receipt as Json, key.key);
  writeAtomic(receiptFile(root, candidate.seat, candidate.id), `${JSON.stringify({ payload: receipt, signature }, null, 2)}\n`);
}

/** The mailbox row the table prints and `--json` carries. A record that does not verify is a row
 *  with `status: "refused"` — it is still in the inbox, and its difference says why it was not
 *  shown. `from`, `to` and `sent` come from the payload when one can be read, and are null when
 *  the file is not a message at all. */
type MailboxRow = {
  id: string;
  seat: string;
  from: string | null;
  /** The sender's registry id, when the record carries one. The table resolves it to the
   *  project's readable name; the JSON row keeps the record's own `from`. */
  from_id: string | null;
  to: string | null;
  sent: string | null;
  sent_display: string;
  status: 'shown' | 'refused' | 'waiting';
  /** The verified body: a served record's on a `shown` row, and, in the owner's reading only, a
   *  record of another mailbox on its `waiting` row. The owner reading is read-only — it carries
   *  the body and publishes no receipt — and a seat's reading never carries another mailbox's
   *  body at all. A record that does not verify carries none, whatever the caller. */
  body?: string;
};

/** The record's path as the caller reads it in the refusal's repair. */
function mailboxPath(candidate: Candidate): string {
  if (candidate.store === 'record') {
    return `.agents/send-drops/${candidate.session ?? ''}/${candidate.seat}/${candidate.id}`;
  }
  return `.agents/messages/${candidate.seat}/${candidate.id}.json`;
}

/**
 * The mailbox a placed caller reads. The owner reads the owner's mailbox; a seat reads the one
 * named for it; every other placement — a no-terminal owner, an agentless pane, a caller the walk
 * cannot place — names none, and the run refuses instead of guessing. The mailbox is a record
 * folder's seat name, which is exactly what a send addressed, so one seat's read cannot spend
 * another's record.
 */
export function mailboxOf(caller: Caller): string | null {
  if (caller.kind === 'owner') return OWNER_MAILBOX;
  if (caller.kind === 'seat') return caller.name;
  return null;
}

/**
 * The row one record waits under when it is addressed to another mailbox. The fields are the
 * read-only verification's when a key is present and the record verifies, and null otherwise;
 * `to` is the folder the record waits in. There is no receipt, no difference and no event — the
 * record belongs to the addressed mailbox's own reader, and this reading only says it is there.
 * `withBody` is the owner's reading, which carries the verified body as it does for any mailbox:
 * the whole session is plainly readable to the owner, so hiding the bytes would only hide what
 * the reader can already open. A seat's reading never asks for it, and a record that does not
 * verify has no body to carry either way.
 */
function waitingRow(
  candidate: Candidate,
  root: string,
  session: string,
  key: KeyObject | null,
  now: Date,
  withBody: boolean,
): MailboxRow {
  const verified = key === null ? null : problemOf(candidate, root, session, key);
  const fields = verified !== null && !('text' in verified) ? verified : null;
  return {
    id: candidate.id,
    seat: candidate.seat,
    from: fields?.from ?? null,
    from_id: fields?.from_id ?? null,
    to: candidate.seat,
    sent: fields?.at ?? null,
    sent_display: formatRelativeTime(fields?.at, now),
    status: 'waiting',
    ...(withBody && fields !== null ? { body: fields.body } : {}),
  };
}

/** The note a reading carries when records for other mailboxes are listed beside its own. A
 *  seat's reading lists them without their bodies; the owner's reading shows the verified body
 *  read-only. Both notes end on the same fact: no receipt is written for another mailbox. */
function otherMailboxNote(count: number, withBodies: boolean): string {
  if (withBodies) {
    return count === 1
      ? '1 message addressed to another mailbox is waiting; it is shown read-only, and no receipt is written for it.'
      : `${count} messages addressed to another mailbox are waiting; they are shown read-only, and no receipts are written for them.`;
  }
  return count === 1
    ? '1 message addressed to another mailbox is waiting; it is listed without its body, and no receipt is written for it.'
    : `${count} messages addressed to another mailbox are waiting; they are listed without their bodies, and no receipts are written for them.`;
}

/** What an unverifying record's repair is, per failed check. It names the file the caller already
 *  sees in the table; moving it where its own payload says it belongs is the repair for a misfiled
 *  record, and removing it is the repair for one nothing can make verify. */
function repairOf(candidate: Candidate, problem: Problem, payload: MessagePayload | RecordPayload | null): string {
  const path = mailboxPath(candidate);
  const moveTarget = (seat: string, id: string): string =>
    candidate.store === 'record'
      ? `.agents/send-drops/${candidate.session ?? ''}/${seat}/${id}`
      : `.agents/messages/${seat}/${id}.json`;
  switch (problem.kind) {
    case 'id':
      return payload
        ? `move ${path} to ${moveTarget(candidate.seat, payload.id)}, or remove it`
        : `remove ${path}, or restore it from the sender`;
    case 'seat':
      return payload
        ? `move ${path} to ${moveTarget(payload.to, candidate.id)}, or remove it`
        : `remove ${path}, or restore it from the sender`;
    case 'root':
      return `remove ${path}: it is bound to another checkout`;
    case 'session':
      return `remove ${path}: it is bound to another session`;
    case 'signature':
      return `remove ${path}, or have the sender re-send it`;
    case 'unsupported':
      return `upgrade team to read ${path}, or remove it and have the sender re-send it in this version's fields`;
    default:
      return `remove ${path}, or restore it from the sender`;
  }
}

/** The body as lines, without a trailing empty line: the document joins them, so the body's own
 *  lines are exactly what the caller reads. */
function bodyLines(body: string): string[] {
  const trimmed = body.endsWith('\n') ? body.slice(0, -1) : body;
  return trimmed.split('\n');
}

/**
 * Verifies every unacked record and prints each body that verifies. For a record in the transport
 * tree the read receipt is published and flushed first (`openRecord`), so the exposure and its
 * proof are one ordered act and a receipt that cannot be made durable shows no body. The older
 * store's body prints first and its receipt is written after `io.stdout` returns, as it always
 * was. A record that does not verify prints no body and writes nothing; it is a `refused` row and
 * a difference, and the run exits 1. A record another reader already served is skipped silently.
 * An empty mailbox is a `0 messages` reading with the note that nothing is waiting, and creates
 * no key. The run serves one mailbox: the owner's, or the seat the caller is placed as, and the
 * receipt records that the addressed party's reader was shown the body. Records for other
 * mailboxes are listed as `waiting` rows with no receipt: a seat's reading carries no body for
 * them, and the owner's reading carries the verified body read-only. A caller the placement
 * cannot resolve is refused before anything is listed.
 */
export async function runMessages(argv: string[], io: Io, sources: MessagesSources = realSources): Promise<number> {
  // Raw argv, before the parser: `--nope --json` and `--json=1` must still answer with the
  // structured error document, and the parser errors before its flag set sees them.
  const json = hasJsonFlag(argv);
  // The client read is dispatched on raw argv, before the seat parser and before any team file:
  // a client's identity is the grant and the key, never the folder this runs in, so no seat-path
  // reading may run first. The closed client option set is parsed by its own command module.
  const clientFlag = argv.some((arg) => arg === '--client' || arg.startsWith('--client='));
  const keyFlag = argv.some((arg) => arg === '--key' || arg.startsWith('--key='));
  if (clientFlag || keyFlag) {
    const parse = (words: string[]) => readArgs(words, ['client', 'key', 'since', 'ack', 'limit', 'request-id'], ['json', 'follow']);
    const parsed = parse(argv);
    if (parsed.error === undefined && parsed.flags.has('follow')) {
      return followClientMessages(argv.filter((arg) => arg !== '--follow'), io, sources, json, parse);
    }
    return runClientMessages(parsed, io, sources, json);
  }
  const args = readArgs(argv, [], ['json']);
  if (args.error || args.rest.length) {
    const problem = args.error ?? `unexpected "${args.rest[0]}"`;
    if (json) {
      // The structured face: the refusal row's own id, stderr empty, the exit unchanged.
      writeJsonError(io, 'messages.invocation', problem, null);
    } else {
      io.stderr(`team messages: ${problem}\n${USAGE}`);
    }
    // exit: messages.invocation
    return 2;
  }
  // The folder is resolved the way every command resolves it: the checkout git names, or, in a
  // folder that is not a repository, the plain team root this folder holds (`.agents/team.yaml`
  // beside it). A folder that is neither is the no-repository refusal — `team messages` takes no
  // `--file`, so the shared sentence must not offer one — and any other unreadable file keeps its
  // own exit.
  const loaded = readTeamConfig(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    const problem = loaded.errors[0];
    const message = problem?.message ?? 'the team file can\'t be read';
    if (problem !== undefined && isNoRepository(problem)) {
      const shown = withoutFileOffer(message);
      if (json) {
        writeJsonError(io, 'messages.not-a-repo', shown, null);
      } else {
        io.stderr(`team messages: ${shown}\n`);
      }
      // exit: messages.not-a-repo
      return 2;
    }
    if (json) {
      writeJsonError(io, 'messages.file', message, null);
    } else {
      io.stderr(`team messages: ${message}\n`);
    }
    // exit: messages.file
    return 1;
  }
  const root = loaded.root;
  const session = loaded.team.session;
  // Who is reading: the owner's mailbox, or the seat this call is placed as in the team's own
  // session, by the same placement `team send` and `team ack` judge. A caller that placement
  // cannot resolve reads no mailbox — no body shown, no receipt published — so one seat's run
  // can never spend another seat's mail.
  const placed = judgeCallerIn(io, dirname(loaded.path), loaded.team).caller;
  const mailbox = mailboxOf(placed);
  if (mailbox === null) {
    const why = `only the owner or a seat of this session reads a mailbox; this call is ${describeCaller(placed)}`;
    if (json) {
      writeJsonError(io, 'messages.caller', why, null);
    } else {
      io.stderr(`team messages: ${why}\n`);
    }
    // exit: messages.caller
    return 1;
  }
  // The owner's reading is the whole session's: its waiting rows carry the verified body of
  // another mailbox (read-only, with no receipt). A seat's reading carries only its own bodies.
  const ownerView = placed.kind === 'owner';
  // The table's FROM cell is the readable name the project's `sender_name` asks for; the row's
  // `from` stays the record's own value, which is what `--json` carries.
  const naming = namingFor({ home: sources.home, root, viewerTeam: teamIdOf(root), file: loaded.team });
  const state = messageKeyState(sources.home);
  const waiting = candidates(root, session).filter((candidate) => {
    if (state.kind !== 'key') return true;
    if (candidate.store === 'record') return !recordReadHeld(candidate, root, session, state.key);
    return !legacyReceiptMatches(receiptFile(root, candidate.seat, candidate.id), candidate.seat, candidate.id, root, session, state.key);
  });
  if (waiting.length === 0) {
    // An empty inbox is a reading, not a refusal: the table has its headers and no rows, the note
    // says nothing is waiting, and the summary counts zero. No key is created.
    const emptyRows: MailboxRow[] = [];
    if (json) {
      writeJson(io, 'team.messages', {
        format: 1 as const,
        project: loaded.team.project,
        session,
        rows: emptyRows,
        notes: ['nothing is waiting'],
        differences: [],
        summary: summaryCounts([]),
        counts: { messages: 0, shown: 0, refused: 0, waiting: 0 },
      });
    } else {
      io.stdout(renderMailbox(loaded.team.project, session, emptyRows, [], ['nothing is waiting'], ttyStyle(io), naming));
    }
    // exit: messages.none
    return 0;
  }
  // Records for other mailboxes are listed read-only and need no key. Records for this call's
  // own mailbox cannot be verified without one, so a keyless run with any of its own refuses
  // before it lists anything, exactly as it did.
  const own = waiting.filter((candidate) => candidate.seat === mailbox);
  const otherCount = waiting.length - own.length;
  if (state.kind !== 'key' && own.length > 0) {
    const why = state.kind === 'missing' ? 'no message key; nothing was shown' : `${state.why}; nothing was shown`;
    if (json) {
      writeJsonError(io, 'messages.key', why, null);
    } else {
      io.stderr(`team messages: ${why}\n`);
    }
    // exit: messages.key
    return 1;
  }
  const key = state.kind === 'key' ? state.key : null;
  const now = sources.now();
  const rows: MailboxRow[] = [];
  /** How many records this reading served: a waiting row, even one the owner reads the body of,
   *  is not shown and never counts here. */
  let shownCount = 0;
  /** Older-store messages, whose body prints first and whose receipt is written after stdout. */
  const legacyShown: Candidate[] = [];
  const differences: OutputDifference[] = [];
  /** Seats whose waiting general seat brief this mailbox does not serve, in first-seen order. */
  const briefSeats: string[] = [];
  for (const candidate of waiting) {
    if (candidate.seat !== mailbox) {
      // Addressed to another mailbox: listed, never shown, never receipted. The owner's reading
      // carries the verified body; a seat's never does.
      rows.push(waitingRow(candidate, root, session, key, now, ownerView));
      continue;
    }
    // Every record of this mailbox reaching here is the key's to verify: a keyless run with one
    // was refused above.
    if (key === null) continue;
    const result = problemOf(candidate, root, session, key);
    const recordPayload =
      candidate.store === 'record' ? (signedRecordOf(readJson(candidate.path))?.payload ?? null) : null;
    const parsedLike = candidate.store === 'record' ? recordPayload : messagePayload(readJson(candidate.path));
    if ('text' in result) {
      rows.push({
        id: candidate.id,
        seat: candidate.seat,
        from: parsedLike?.from ?? null,
        from_id: parsedLike !== null && 'from_id' in parsedLike ? (parsedLike.from_id as string | null) : null,
        to: parsedLike?.to ?? null,
        sent: parsedLike?.at ?? null,
        sent_display: formatRelativeTime(parsedLike?.at, now),
        status: 'refused',
      });
      differences.push({ what: result.text, repair: repairOf(candidate, result, parsedLike), who: 'any seat' });
      // The refusal is raised to the owner as its rule and object — the record's id, its seat
      // and its path — and never its content.
      raiseRefusalEvent({
        project: loaded.team.project,
        root,
        home: sources.home,
        session,
        kind: 'record.invalid',
        rule: result.kind,
        object: { id: candidate.id, seat: candidate.seat, path: mailboxPath(candidate) },
        now,
      });
      continue;
    }
    if (recordPayload !== null && isGeneralBriefRecord(recordPayload)) {
      // A brief's read is bound to the seat's current claim and belongs to the seat's own reader.
      // This checkout-wide mailbox writes no receipt for one, so the seat's reader still serves it.
      if (!briefSeats.includes(candidate.seat)) briefSeats.push(candidate.seat);
      continue;
    }
    if (candidate.store === 'record') {
      // The receipt is published and flushed before the body: one reader wins the id, and the
      // proof of exposure survives a crash that follows it.
      const gate = openRecord(candidate, root, session, sources.home, key, sources.now().toISOString());
      if (gate.kind === 'served') continue; // another reader already spent this id: no row, no body
      if (gate.kind === 'refused') {
        rows.push({
          id: candidate.id,
          seat: candidate.seat,
          from: result.from,
          from_id: result.from_id,
          to: result.to,
          sent: result.at,
          sent_display: formatRelativeTime(result.at, now),
          status: 'refused',
        });
        differences.push({ what: gate.what, repair: gate.repair, who: 'any seat' });
        continue;
      }
    }
    const row: MailboxRow = {
      id: candidate.id,
      seat: candidate.seat,
      from: result.from,
      from_id: result.from_id,
      to: result.to,
      sent: result.at,
      sent_display: formatRelativeTime(result.at, now),
      status: 'shown',
      body: result.body,
    };
    rows.push(row);
    shownCount += 1;
    if (candidate.store === 'legacy') legacyShown.push(candidate);
  }
  const notes = briefSeats.map(
    (seat) => `${seat}: the general seat brief is not shown here; the seat's own turn-start reader serves it.`,
  );
  if (otherCount > 0) notes.push(otherMailboxNote(otherCount, ownerView));
  if (json) {
    writeJson(io, 'team.messages', {
      format: 1 as const,
      project: loaded.team.project,
      session,
      rows: rows.map((row) => ({
        id: row.id,
        from: row.from,
        to: row.to,
        sent: row.sent,
        sent_display: row.sent_display,
        status: row.status,
        ...(row.body !== undefined ? { body: row.body } : {}),
      })),
      notes,
      differences: differences.map(toJsonDifference),
      // The envelope's `summary` is the reading's difference counts, the stable key every reading
      // envelope carries; the table's own counts live beside it under `counts`.
      summary: summaryCounts(differences),
      counts: {
        messages: rows.length,
        shown: shownCount,
        refused: differences.length,
        waiting: otherCount,
      },
    });
  } else {
    io.stdout(renderMailbox(loaded.team.project, session, rows, differences, notes, ttyStyle(io), naming));
  }
  // The older store keeps its original order: its body printed first, so its receipt is written
  // after stdout returns. Transport-tree records published and flushed theirs before the body.
  for (const candidate of legacyShown) {
    writeReadReceipt(sources.home, candidate, root, session, sources.now().toISOString());
  }
  if (differences.length > 0) {
    // exit: messages.shape
    // exit: messages.id
    // exit: messages.seat
    // exit: messages.root
    // exit: messages.session
    // exit: messages.signature
    return 1;
  }
  // exit: messages.shown
  return 0;
}

/** The reading's plain text: the context line, the `ID  FROM  TO  SENT  STATUS` table, each body
 *  under its own `<seat>/<id>:` heading — in table order, which is the order the bodies were
 *  always printed — the notes and differences, and the closing `<n> message` / `<n> messages`
 *  line. A row carries a body when it was shown, and in the owner's reading a `waiting` row of
 *  another mailbox carries its verified body too. */
function renderMailbox(
  project: string,
  session: string,
  rows: readonly MailboxRow[],
  differences: readonly OutputDifference[],
  notes: readonly string[],
  style: ReturnType<typeof ttyStyle>,
  naming: SenderNaming,
): string {
  const lines = [contextLine(project, session)];
  const readableFrom = (row: MailboxRow): string | null =>
    row.from === null ? null : senderDisplayName({ seat: row.from, id: row.from_id }, naming);
  lines.push(
    ...renderTable({
      headers: ['ID', 'FROM', 'TO', 'SENT', 'STATUS'],
      rows: rows.map((row) => [row.id, readableFrom(row), row.to, row.sent_display, row.status]),
      indent: '  ',
      style,
    }),
  );
  for (const row of rows) {
    if (row.body === undefined) continue;
    lines.push('', `${row.seat}/${row.id}:`, ...bodyLines(row.body));
  }
  if (notes.length > 0) lines.push('', ...renderNotes(notes));
  if (differences.length > 0) lines.push('', ...renderDifferences(differences, style));
  lines.push('', pluralCount(rows.length, 'message'));
  return `${lines.join('\n')}\n`;
}

/**
 * `team messages --client … --follow`: the same signed, replay-checked client read, repeated,
 * printing each reply on the client's thread once, as soon as a read finds it. Every read is an
 * ordinary `runClientMessages` call with its own request id and `--since` the last reply printed,
 * so the follow mode admits nothing a single read would not. A refused read ends the follow with
 * its own exit and reason. Text mode prints one line per reply; `--json` prints one JSON row per line.
 */
export async function followClientMessages(
  argv: string[],
  io: Io,
  sources: MessagesSources,
  json: boolean,
  parse: (words: string[]) => ReturnType<typeof readArgs>,
): Promise<number> {
  const base = argv.filter((arg) => arg !== '--json');
  const sinceAt = base.indexOf('--since');
  let cursor: string | null = sinceAt >= 0 ? (base[sinceAt + 1] ?? null) : null;
  const rest = sinceAt >= 0 ? [...base.slice(0, sinceAt), ...base.slice(sinceAt + 2)] : base;
  if (rest.includes('--ack') || rest.includes('--request-id')) {
    // The client read's own usage refusal, with its own exit.
    return runClientMessages({ ...parse(rest), error: '--follow takes neither --ack nor --request-id: each read signs its own request' }, io, sources, json);
  }
  const wait = sources.followWait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, FOLLOW_INTERVAL_MS)));
  let first = true;
  let stopped = false;
  for (let read = 0; sources.followReads === undefined || read < sources.followReads; read += 1) {
    if (read > 0) await wait();
    let out = '';
    let err = '';
    const quiet: Io = { ...io, stdout: (text) => { out += text; }, stderr: (text) => { err += text; } };
    const code = runClientMessages(
      parse([...rest, ...(cursor === null ? [] : ['--since', cursor]), '--json']),
      quiet,
      sources,
      true,
    );
    if (first) {
      // The declared key-isolation line, once per follow run.
      const line = err.split('\n')[0];
      if (line) io.stderr(`${line}\n`);
      first = false;
    }
    let doc: { rows?: { id: string; from: string; sent: string; status: string; body?: string }[]; error?: { message: string } } = {};
    try {
      doc = JSON.parse(out) as typeof doc;
    } catch {
      doc = {};
    }
    if (code !== 0) {
      io.stderr(`team messages: follow stopped: ${doc.error?.message ?? (err.split('\n').slice(1).join(' ').trim() || 'the read was refused')}\n`);
      stopped = true;
      break;
    }
    for (const row of doc.rows ?? []) {
      if (row.status !== 'shown') continue;
      if (json) io.stdout(`${JSON.stringify({ id: row.id, from: row.from, sent: row.sent, body: row.body ?? null })}\n`);
      else io.stdout(`${row.sent} reply ${row.id} from ${row.from}: ${(row.body ?? '').replace(/\s+/g, ' ').trim()}\n`);
      cursor = row.id;
    }
  }
  // The follow ends with one last ordinary read, whose exit is the run's: a refusal answers with
  // its own id and reason, and a follow a test bounded ends with the read's clean exit. Its rows are
  // already printed, so its output goes nowhere unless it refuses.
  const last: Io = stopped ? io : { ...io, stdout: () => {}, stderr: () => {} };
  return runClientMessages(parse([...rest, ...(cursor === null ? [] : ['--since', cursor])]), last, sources, stopped ? json : true);
}
