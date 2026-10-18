// `team messages`: verify a record that is already waiting, print its body, and write the read
// receipt that makes its status move.
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
import { isNoRepository, loadTeamFile, withoutFileOffer } from '../file/load.ts';
import type { Command, Io } from '../io.ts';
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
  receiptFile as recordReceiptFile,
  receiptHolds,
  recordFile,
  signedRecordOf,
  signReceiptPayload,
  verifyRecord,
  writeReceipt,
  type ReceiptPayload,
  type ReceiptStatus,
  type RecordPayload,
  type SignedRecord,
} from '../send/record.ts';

export const USAGE = `Usage: team messages [--json]

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

/** Whether the record at `candidate` already has a verifying read receipt: the one receipt module's
 *  answer, shared with the inbox, `team drops` and the watch. */
function recordReadHeld(candidate: Candidate, root: string, session: string, key: KeyObject): boolean {
  const path = recordReceiptFile(
    recordDir(root, candidate.session ?? session, candidate.seat),
    candidate.id,
    'read' as ReceiptStatus,
  );
  return receiptHolds(
    path,
    candidate.id,
    'read',
    { to: candidate.seat, root, session: candidate.session ?? session },
    key,
  );
}

/**
 * Records with no verifying read receipt. A missing message key yields nothing: a signature
 * cannot be checked, and this read does not create the key. The watch rings from this list.
 */
export function listUnacked(root: string, session: string, home: string): Unacked[] {
  const state = messageKeyState(home);
  if (state.kind !== 'key') return [];
  const out: Unacked[] = [];
  for (const candidate of candidates(root, session)) {
    if (candidate.store === 'legacy') {
      if (legacyReceiptMatches(receiptFile(root, candidate.seat, candidate.id), candidate.seat, candidate.id, root, session, state.key)) continue;
      const parsed = readJson(candidate.path);
      const payload = messagePayload(parsed);
      if (!payload || !isRecord(parsed) || !text(parsed.signature)) continue;
      if (payload.id !== candidate.id || payload.to !== candidate.seat) continue;
      if (payload.session !== session || !samePath(payload.root, root)) continue;
      if (!verifyDomain(MESSAGE_DOMAIN, payload as Json, parsed.signature, state.key)) continue;
      out.push({ id: candidate.id, to: candidate.seat, at: payload.at });
      continue;
    }
    if (recordReadHeld(candidate, root, session, state.key)) continue;
    const record = signedRecordOf(readJson(candidate.path));
    if (record === null) continue;
    const payload = record.payload;
    if (payload.id !== candidate.id || payload.to !== candidate.seat) continue;
    if (payload.session !== (candidate.session ?? session) || !samePath(payload.root, root)) continue;
    if (!verifyRecord(record, state.key)) continue;
    out.push({ id: candidate.id, to: candidate.seat, at: payload.at });
  }
  return out;
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
 * Writes the read receipt for a record that was shown. The receipt carries its status
 * (`read`), is signed with the message key, and is write-once; the older store keeps its own
 * receipt shape.
 */
function writeReadReceipt(home: string, candidate: Candidate, payload: Verified, root: string, session: string, at: string): void {
  if (candidate.store === 'record') {
    const receipt: ReceiptPayload = {
      kind: 'receipt',
      status: 'read',
      id: candidate.id,
      to: candidate.seat,
      root,
      session: candidate.session ?? session,
      at,
    };
    const signed = signReceiptPayload(receipt, home);
    const written = writeReceipt(recordDir(root, candidate.session ?? session, candidate.seat), signed, home);
    if (!written.ok) throw new Error('the read receipt could not be written');
    return;
  }
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
 * Verifies every unacked record, prints each body that verifies, and writes its receipt in the
 * same step. A record that does not verify prints no body and writes nothing; it is a `refused`
 * row and a difference, and the run exits 1. An empty mailbox is a `0 messages` reading with
 * the note that nothing is waiting, and creates no key. Anyone in the checkout may run it: the
 * ring asks the recipient's pane, and the receipt records that a process was shown the body.
 */
export async function runMessages(argv: string[], io: Io, sources: MessagesSources = realSources): Promise<number> {
  const args = readArgs(argv, [], ['json']);
  // Raw argv, before the parser: `--nope --json` and `--json=1` must still answer with the
  // structured error document, and the parser errors before its flag set sees them.
  const json = hasJsonFlag(argv);
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
  /** The body of each record that verified, by `<store>/<seat>/<id>`: the table's key, so the
   *  body the run prints and the body its `--json` row carries are one value. */
  const bodies = new Map<string, string>();
  const verified: { candidate: Candidate; payload: Verified }[] = [];
  const differences: OutputDifference[] = [];
  const rowKey = (candidate: Candidate): string => `${candidate.store}/${candidate.seat}/${candidate.id}`;
  for (const candidate of waiting) {
    const result = problemOf(candidate, root, session, state.key);
    const parsedLike = candidate.store === 'record'
      ? (signedRecordOf(readJson(candidate.path))?.payload ?? null)
      : messagePayload(readJson(candidate.path));
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
    rows.push({
      id: candidate.id,
      seat: candidate.seat,
      from: result.from,
      from_id: result.from_id,
      to: result.to,
      sent: result.at,
      sent_display: formatRelativeTime(result.at, now),
      status: 'shown',
    });
    bodies.set(rowKey(candidate), result.body);
    verified.push({ candidate, payload: result });
  }
  if (json) {
    writeJson(io, 'team.messages', {
      format: 1 as const,
      project: loaded.team.project,
      session,
      rows: rows.map((row, index) => {
        const candidate = waiting[index];
        const body = candidate === undefined ? undefined : bodies.get(rowKey(candidate));
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
      notes: [],
      differences: differences.map(toJsonDifference),
      // The envelope's `summary` is the reading's difference counts, the stable key every reading
      // envelope carries; the table's own counts live beside it under `counts`.
      summary: summaryCounts(differences),
      counts: {
        messages: rows.length,
        shown: verified.length,
        refused: differences.length,
      },
    });
  } else {
    io.stdout(renderMailbox(loaded.team.project, session, rows, verified.map((one) => ({ candidate: one.candidate, body: one.payload.body })), differences, [], ttyStyle(io), naming));
  }
  // The receipt means the body was shown. `io.stdout` returning is that boundary: a throw leaves
  // no receipt, and the record stays unacked.
  for (const one of verified) {
    writeReadReceipt(sources.home, one.candidate, one.payload, root, session, sources.now().toISOString());
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
