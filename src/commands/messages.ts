// `team messages`: verify a record that is already waiting, publish the read receipt that proves
// it was served, and only then print its body. The signed read receipt is the per-id gate every
// reader shares — this command, `team drops --read` and `inbox_read` — so the receipt is written
// with an exclusive link and flushed before the body, and a record another reader already served
// is skipped. An entry at a receipt name that does not verify is held, never replaced.
//
// A send of this version writes a signed record into the recipient's transport tree,
// `<root>/.agents/send-drops/<session>/<seat>/<id>` (`src/send/record.ts`), and this command reads
// it there. The older `.agents/messages/<seat>/<id>.json` store is still read, read-only, so a
// record a previous build left verifies the same way; nothing writes it any more. The signature
// is integrity: every seat runs as the owner-user, so it is not proof of who sent it.
import { type KeyObject } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readArgs } from '../args.ts';
import { raiseRefusalEvent } from '../bus/refusals.ts';
import { runClientMessages } from '../client/inbox.ts';
import { isNoRepository, loadTeamFile, withoutFileOffer } from '../file/load.ts';
import type { Command, Io } from '../io.ts';
import { isGeneralBriefRecord } from '../launch/general-brief.ts';
import { type Held } from '../launch/rules-file.ts';
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
  recordFile,
  signedRecordOf,
  verifyRecord,
  type RecordPayload,
  type SignedRecord,
} from '../send/record.ts';
import { publishRecordRead } from '../send/read-receipt.ts';

export const USAGE = `Usage: team messages [--json]
Usage: team messages --client <grant-file> --key <key-file> [--since <id>] [--ack <id>] [--limit <n>] [--request-id <id>] [--json]

Exits 0 when the inbox is read, 1 when the caller, team file, or message record is refused, 2 when the invocation can't be read or this folder is neither a checkout nor a team root.
`;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

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
};

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

function samePath(a: string, b: string): boolean {
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
function messagePayload(value: unknown): MessagePayload | null {
  if (!isRecord(value)) return null;
  const payload = value.payload;
  if (!isRecord(payload)) return null;
  if (payload.kind !== 'message') return null;
  if (!text(payload.id) || !text(payload.to) || !text(payload.root) || !text(payload.session)) return null;
  if (!text(payload.at) || !text(payload.body) || !text(payload.from)) return null;
  if (!text(value.signature)) return null;
  return payload as MessagePayload;
}

function legacyReceiptMatches(path: string, seat: string, id: string, root: string, session: string, key: KeyObject): boolean {
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

/** The marker names a send leaves beside a record; none of them is a message. */
function isMarkerName(name: string): boolean {
  return name.endsWith('.pending') || name.endsWith('.taken') || name.endsWith('.read') || name.endsWith('.json');
}

/** The prefix a work nudge's file carries: the watch writes it into the same folder, and it is a
 *  prompt for the seat, not a message record (`work-<uuid>`). */
const WORK_PREFIX = 'work-';

/** The signed records in `<root>/.agents/send-drops/<session>/<seat>/<id>`. A name that is not a
 *  record's id — a pending marker, a taken marker, an inbox receipt, a work nudge — is not a
 *  candidate. */
function recordCandidates(root: string, session: string): Candidate[] {
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
      // A body file written before the record spine is plain text. It stays in the folder for
      // its seat to read, but it names no message: the inbox neither shows nor refuses it. A
      // JSON file is held to the record's shape.
      if (readJson(path) === undefined) continue;
      out.push({ store: 'record', seat, id: name, path, session });
    }
  }
  return out;
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
 * Records with no verifying read receipt, with the fields a wake line reads. A missing message
 * key yields nothing: a signature cannot be checked, and this read does not create the key. The
 * watch rings from this list.
 */
export function listUnackedMessages(root: string, session: string, home: string): UnackedMessage[] {
  const state = messageKeyState(home);
  if (state.kind !== 'key') return [];
  const out: UnackedMessage[] = [];
  for (const candidate of candidates(root, session)) {
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
    const record = signedRecordOf(readJson(candidate.path));
    if (record === null) continue;
    const payload = record.payload;
    if (payload.id !== candidate.id || payload.to !== candidate.seat) continue;
    if (payload.session !== (candidate.session ?? session) || !samePath(payload.root, root)) continue;
    if (!verifyRecord(record, state.key)) continue;
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
  return path;
}

type Problem = { kind: 'shape' | 'id' | 'seat' | 'root' | 'session' | 'signature'; text: string };

type Verified = { from: string; from_id: string | null; to: string; at: string; body: string };

function recordProblem(candidate: Candidate, root: string, session: string, key: KeyObject): Problem | Verified {
  const where = `${candidate.seat}/${candidate.id}`;
  const record = signedRecordOf(readJson(candidate.path));
  if (record === null) return { kind: 'shape', text: `${where} does not verify: the record is not a message record` };
  const payload = record.payload;
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
  if (!verifyRecord(record, key)) {
    return { kind: 'signature', text: `${where} does not verify: the signature is not the message key's` };
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
  status: 'shown' | 'refused';
};

/** The record's path as the caller reads it in the refusal's repair. */
function mailboxPath(candidate: Candidate): string {
  if (candidate.store === 'record') {
    return `.agents/send-drops/${candidate.session ?? ''}/${candidate.seat}/${candidate.id}`;
  }
  return `.agents/messages/${candidate.seat}/${candidate.id}.json`;
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
 * no key. Anyone in the checkout may run it: the ring asks the recipient's pane, and the receipt
 * records that a process was shown the body.
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
    return runClientMessages(
      readArgs(argv, ['client', 'key', 'since', 'ack', 'limit', 'request-id'], ['json']),
      io,
      sources,
      json,
    );
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
  const loaded = loadTeamFile(io.cwd, { home: sources.home });
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
        counts: { messages: 0, shown: 0, refused: 0 },
      });
    } else {
      io.stdout(renderMailbox(loaded.team.project, session, emptyRows, [], [], ['nothing is waiting'], ttyStyle(io), naming));
    }
    // exit: messages.none
    return 0;
  }
  if (state.kind !== 'key') {
    const why = state.kind === 'missing' ? 'no message key; nothing was shown' : `${state.why}; nothing was shown`;
    if (json) {
      writeJsonError(io, 'messages.key', why, null);
    } else {
      io.stderr(`team messages: ${why}\n`);
    }
    // exit: messages.key
    return 1;
  }
  const now = sources.now();
  const rows: MailboxRow[] = [];
  /** The body each shown row carries, keyed by the row itself: a refused or served candidate
   *  never shifts a body onto another row. */
  const bodyOf = new Map<MailboxRow, string>();
  /** The bodies in print order, for the text reading. */
  const shownBodies: { candidate: Candidate; body: string }[] = [];
  /** Older-store messages, whose body prints first and whose receipt is written after stdout. */
  const legacyShown: Candidate[] = [];
  const differences: OutputDifference[] = [];
  /** Seats whose waiting general seat brief this mailbox does not serve, in first-seen order. */
  const briefSeats: string[] = [];
  for (const candidate of waiting) {
    const result = problemOf(candidate, root, session, state.key);
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
      const gate = openRecord(candidate, root, session, sources.home, state.key, sources.now().toISOString());
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
    };
    rows.push(row);
    bodyOf.set(row, result.body);
    shownBodies.push({ candidate, body: result.body });
    if (candidate.store === 'legacy') legacyShown.push(candidate);
  }
  const notes = briefSeats.map(
    (seat) => `${seat}: the general seat brief is not shown here; the seat's own turn-start reader serves it.`,
  );
  if (json) {
    writeJson(io, 'team.messages', {
      format: 1 as const,
      project: loaded.team.project,
      session,
      rows: rows.map((row) => {
        const body = bodyOf.get(row);
        return {
          id: row.id,
          from: row.from,
          to: row.to,
          sent: row.sent,
          sent_display: row.sent_display,
          status: row.status,
          ...(body !== undefined ? { body } : {}),
        };
      }),
      notes,
      differences: differences.map(toJsonDifference),
      // The envelope's `summary` is the reading's difference counts, the stable key every reading
      // envelope carries; the table's own counts live beside it under `counts`.
      summary: summaryCounts(differences),
      counts: {
        messages: rows.length,
        shown: shownBodies.length,
        refused: differences.length,
      },
    });
  } else {
    io.stdout(renderMailbox(loaded.team.project, session, rows, shownBodies, differences, notes, ttyStyle(io), naming));
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

/** The reading's plain text: the context line, the `ID  FROM  TO  SENT  STATUS` table, each shown
 *  body under its own `<seat>/<id>:` heading, the notes and differences, and the closing
 *  `<n> message` / `<n> messages` line. */
function renderMailbox(
  project: string,
  session: string,
  rows: readonly MailboxRow[],
  bodies: readonly { candidate: Candidate; body: string }[],
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
  for (const one of bodies) {
    lines.push('', `${one.candidate.seat}/${one.candidate.id}:`, ...bodyLines(one.body));
  }
  if (notes.length > 0) lines.push('', ...renderNotes(notes));
  if (differences.length > 0) lines.push('', ...renderDifferences(differences, style));
  lines.push('', pluralCount(rows.length, 'message'));
  return `${lines.join('\n')}\n`;
}
