// `team messages`: verify a record that is already waiting, print its body, and write the receipt.
// Nothing in this build writes the first real record. A report still leaves as the watch's nudge.
// The signature is integrity: every seat runs as the owner-user, so it is not proof of who sent it.
import { type KeyObject } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readArgs } from '../args.ts';
import { findRoot, loadTeamFile, NOT_A_REPO_NO_FILE } from '../file/load.ts';
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
import { compareSeatNames } from '../seat-names.ts';
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

export const USAGE = `Usage: team messages [--json]

Exits 0 when the inbox is read, 1 when the caller, team file, or message record is refused, 2 when the invocation can't be read or this folder is not a git repository.
`;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

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

export type ReceiptPayload = {
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

/** `.agents/messages/<seat>/<id>.json`. The filename is the id; the directory is the recipient. */
export function messageFile(root: string, seat: string, id: string): string {
  return join(root, '.agents', 'messages', seat, `${id}.json`);
}

export function receiptFile(root: string, seat: string, id: string): string {
  return join(root, '.agents', 'messages', seat, `${id}.read.json`);
}

type Candidate = { seat: string; id: string; path: string };

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

/** The payload a message signature covers, or null when the file is not that shape. */
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

function receiptMatches(path: string, seat: string, id: string, root: string, session: string, key: KeyObject): boolean {
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

function candidates(root: string): Candidate[] {
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
      out.push({ seat, id, path });
    }
  }
  return out;
}

/**
 * Records with no verifying receipt. A missing message key yields nothing: a signature cannot
 * be checked, and this read does not create the key. The watch rings from this list.
 */
export function listUnacked(root: string, session: string, home: string): Unacked[] {
  const state = messageKeyState(home);
  if (state.kind !== 'key') return [];
  const out: Unacked[] = [];
  for (const candidate of candidates(root)) {
    if (receiptMatches(receiptFile(root, candidate.seat, candidate.id), candidate.seat, candidate.id, root, session, state.key)) continue;
    const parsed = readJson(candidate.path);
    const payload = messagePayload(parsed);
    if (!payload || !isRecord(parsed) || !text(parsed.signature)) continue;
    if (payload.id !== candidate.id || payload.to !== candidate.seat) continue;
    if (payload.session !== session || !samePath(payload.root, root)) continue;
    if (!verifyDomain(MESSAGE_DOMAIN, payload as Json, parsed.signature, state.key)) continue;
    out.push({ id: candidate.id, to: candidate.seat, at: payload.at });
  }
  return out;
}

/**
 * Writes one record the way a sender would, signing with the message key. The message key is
 * created here when it does not exist yet. Tests and the evidence harness are the only callers;
 * no command writes a record.
 */
export function plantMessage(home: string, root: string, seat: string, id: string, payload: MessagePayload, signature?: string): void {
  const key = messageKeyOf(home);
  const signed = signature ?? signDomain(MESSAGE_DOMAIN, payload as Json, key);
  const path = messageFile(root, seat, id);
  mkdirSync(join(root, '.agents', 'messages', seat), { recursive: true });
  writeAtomic(path, `${JSON.stringify({ payload, signature: signed }, null, 2)}\n`);
}

type Problem = { kind: 'shape' | 'id' | 'seat' | 'root' | 'session' | 'signature'; text: string };

function problemOf(candidate: Candidate, root: string, session: string, key: KeyObject): Problem | MessagePayload {
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
  return payload;
}

function writeReceipt(home: string, root: string, payload: MessagePayload, at: string): void {
  const receipt: ReceiptPayload = {
    kind: 'receipt',
    id: payload.id,
    to: payload.to,
    root: payload.root,
    session: payload.session,
    at,
  };
  const key = messageKeyState(home);
  if (key.kind !== 'key') throw new Error('the message key disappeared before the receipt was signed');
  const signature = signDomain(RECEIPT_DOMAIN, receipt as Json, key.key);
  writeAtomic(receiptFile(root, payload.to, payload.id), `${JSON.stringify({ payload: receipt, signature }, null, 2)}\n`);
}

/** The mailbox row the table prints and `--json` carries. A record that does not verify is a row
 *  with `status: "refused"` — it is still in the inbox, and its difference says why it was not
 *  shown. `from`, `to` and `sent` come from the payload when one can be read, and are null when
 *  the file is not a message at all. */
type MailboxRow = {
  id: string;
  seat: string;
  from: string | null;
  to: string | null;
  sent: string | null;
  sent_display: string;
  status: 'shown' | 'refused';
};

/** `.agents/messages/<seat>/<id>.json` as the caller reads it in the refusal's repair. */
function mailboxPath(candidate: Candidate): string {
  return `.agents/messages/${candidate.seat}/${candidate.id}.json`;
}

/** What an unverifying record's repair is, per failed check. It names the file the caller already
 *  sees in the table; moving it where its own payload says it belongs is the repair for a misfiled
 *  record, and removing it is the repair for one nothing can make verify. */
function repairOf(candidate: Candidate, problem: Problem, payload: MessagePayload | null): string {
  const path = mailboxPath(candidate);
  switch (problem.kind) {
    case 'id':
      return payload
        ? `move ${path} to .agents/messages/${candidate.seat}/${payload.id}.json, or remove it`
        : `remove ${path}, or restore it from the sender`;
    case 'seat':
      return payload
        ? `move ${path} to .agents/messages/${payload.to}/${candidate.id}.json, or remove it`
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
  const root = findRoot(io.cwd);
  if (!root) {
    // `team messages` takes no `--file`, so the no-repository refusal must not offer one.
    if (json) {
      writeJsonError(io, 'messages.not-a-repo', NOT_A_REPO_NO_FILE, null);
    } else {
      io.stderr(`team messages: ${NOT_A_REPO_NO_FILE}\n`);
    }
    // exit: messages.not-a-repo
    return 2;
  }
  const loaded = loadTeamFile(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    const message = loaded.errors[0]?.message ?? 'the team file can\'t be read';
    if (json) {
      writeJsonError(io, 'messages.file', message, null);
    } else {
      io.stderr(`team messages: ${message}\n`);
    }
    // exit: messages.file
    return 1;
  }
  const session = loaded.team.session;
  const state = messageKeyState(sources.home);
  const waiting = candidates(root).filter((candidate) => {
    if (state.kind !== 'key') return true;
    return !receiptMatches(receiptFile(root, candidate.seat, candidate.id), candidate.seat, candidate.id, root, session, state.key);
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
      io.stdout(renderMailbox(loaded.team.project, session, emptyRows, [], [], ['nothing is waiting'], ttyStyle(io)));
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
  /** The body of each record that verified, by `<seat>/<id>`: the table's key, so the body the
   *  run prints and the body its `--json` row carries are one value. */
  const bodies = new Map<string, string>();
  const verified: { candidate: Candidate; payload: MessagePayload }[] = [];
  const differences: OutputDifference[] = [];
  for (const candidate of waiting) {
    const result = problemOf(candidate, root, session, state.key);
    const parsed = messagePayload(readJson(candidate.path));
    if ('text' in result) {
      rows.push({
        id: candidate.id,
        seat: candidate.seat,
        from: parsed?.from ?? null,
        to: parsed?.to ?? null,
        sent: parsed?.at ?? null,
        sent_display: formatRelativeTime(parsed?.at, now),
        status: 'refused',
      });
      differences.push({ what: result.text, repair: repairOf(candidate, result, parsed), who: 'any seat' });
      continue;
    }
    rows.push({
      id: candidate.id,
      seat: candidate.seat,
      from: result.from,
      to: result.to,
      sent: result.at,
      sent_display: formatRelativeTime(result.at, now),
      status: 'shown',
    });
    bodies.set(`${candidate.seat}/${candidate.id}`, result.body);
    verified.push({ candidate, payload: result });
  }
  if (json) {
    writeJson(io, 'team.messages', {
      format: 1 as const,
      project: loaded.team.project,
      session,
      rows: rows.map((row) => {
        const body = bodies.get(`${row.seat}/${row.id}`);
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
    io.stdout(renderMailbox(loaded.team.project, session, rows, verified.map((one) => ({ candidate: one.candidate, body: one.payload.body })), differences, [], ttyStyle(io)));
  }
  // The receipt means the body was shown. `io.stdout` returning is that boundary: a throw leaves
  // no receipt, and the record stays unacked.
  for (const one of verified) {
    writeReceipt(sources.home, root, one.payload, sources.now().toISOString());
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
): string {
  const lines = [contextLine(project, session)];
  lines.push(
    ...renderTable({
      headers: ['ID', 'FROM', 'TO', 'SENT', 'STATUS'],
      rows: rows.map((row) => [row.id, row.from, row.to, row.sent_display, row.status]),
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
