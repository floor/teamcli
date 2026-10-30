import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { heldAt } from '../launch/rules-file.ts';
import { storePath, storesFolder } from '../store/store.ts';

/** `O_NOFOLLOW` is POSIX: 0 on platforms without it, while `heldAt` (`lstat`) still guards every open. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The file inside `<project state folder>/` that holds the durable message history. */
export const HISTORY_FILE = 'messages.jsonl';

/** Rotate at 1 MB and keep three files (`messages.jsonl`, `.1`, `.2`), matching `src/log.ts`. */
export const MAX_HISTORY_BYTES = 1_000_000;
export const HISTORY_KEPT = 3;

export type HistoryOutcome =
  | 'delivered'
  | 'delivered (read)'
  | 'sent (unconfirmed)'
  | 'sent (channel)'
  | 'held'
  | 'queued (receiver busy)'
  | 'not-submitted'
  | 'unreachable'
  | 'answered'
  | 'timeout';

/**
 * A message's status, derived from the receipts beside its record and moving forward only
 * (`src/send/record.ts` reads them). The attempt outcomes above are not statuses: a send that
 * was held, timed out or found no reachable leg still leaves a record whose status is `sent`
 * until a receipt says otherwise.
 */
export type MessageStatus = 'sent' | 'held' | 'delivered' | 'read' | 'replied';

/** The statuses in the one order they move; a later receipt is the one that stands. */
export const STATUS_ORDER: readonly MessageStatus[] = ['sent', 'held', 'delivered', 'read', 'replied'];

/** The status a history line's own outcome implies, when no receipt is at hand (the feed's
 *  `--json` reading). Only the outcome words that name a status map to one; every attempt
 *  outcome maps to `sent`, the record's status until a receipt lands. */
export function statusOfOutcome(outcome: string): MessageStatus {
  switch (outcome) {
    case 'delivered (read)':
      return 'read';
    case 'delivered':
      return 'delivered';
    case 'held':
      return 'held';
    case 'answered':
      return 'replied';
    default:
      return 'sent';
  }
}

export type HistoryEntry = {
  ts: string;
  from: string;
  to: string;
  body: string;
  id: string;
  outcome: string;
  /** The team the sender sits in, by team id, written by the send that made the line. The feed
   *  needs it to read a sender from another team by its address: without it a seat name shared
   *  with a local seat would read as the local nickname. A line written before this field (or by
   *  a reader's own seam, a brief or an audit) carries none, and the feed prints the plain seat
   *  name rather than guessing a team. */
  from_team?: string;
  /** The address the caller wrote, when it was not the resolved seat's own name: a `@<nickname>`,
   *  a `<seat|nickname>@<team>`, `lead@<team>`, or an agent id. It lets a reader see what was
   *  addressed beside `to`, the seat it resolved to. */
  spec?: string;
  /** The registry id (`agt_…`) the spec resolved to, written with `spec`; the canonical form
   *  records and scripts use. */
  resolved?: string;
  /** Send to outcome in whole milliseconds, written when the sender measured it. */
  ms?: number;
  /** The path the message travelled: `typed` (a composer trigger) or `socket` (a frame); absent when it never left the sender. */
  via?: string;
  /** The legs of the delivery order that did not take the send, each `<leg>: <reason>`, in the
   *  order they were tried; absent when the walk had none to pass on — the leg that carried the
   *  send was reached without a failure behind it, or there was no walk at all. */
  failed?: string[];
  /** One short qualifier the outcome word cannot carry alone: `trigger taken, no read receipt yet`
   *  on a typed send whose trigger left the composer, and `taken but never acted on` when the
   *  watch's later look found no sign either. */
  note?: string;
  /** The thread the message belongs to: the first message's id, on every line a send writes. */
  thread?: string;
  /** On a reply's line, the id of the record it answers. */
  in_reply_to?: string;
};

export type HistoryWrite =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export type HistoryRead =
  | { ok: true; entries: HistoryEntry[]; path: string }
  | { ok: false; reason: string };

/**
 * `<home>/.config/team/<project>-<hash>/messages.jsonl`: inside the project's state folder,
 * never in a lobby and never in the repository checkout.
 */
export function historyPath(project: string, root: string, home: string): string {
  return join(storePath(project, root, home), HISTORY_FILE);
}

/**
 * Checks a directory in the state-folder ladder without following a symbolic link.
 * Missing levels are created by the caller one level at a time at mode 0700.
 */
function ladderProblem(at: string): string | null {
  const held = heldAt(at);
  if (held.kind === 'missing') return null;
  if (held.kind === 'link') return 'a symbolic link was found and not followed';
  if (held.kind === 'fifo') return 'a FIFO was found and not followed';
  if (held.kind !== 'folder') return 'the state folder path is not a directory';
  if (process.getuid !== undefined && held.uid !== process.getuid()) return "another user's folder";
  return null;
}

/**
 * Checks what stands at a history file path (`messages.jsonl`, `.1`, `.2`) with `lstat`.
 * Anything other than a regular file owned by this user is refused and never followed.
 */
function fileProblem(at: string, label = 'history log'): string | null {
  const held = heldAt(at);
  if (held.kind === 'missing') return null;
  if (held.kind === 'link') return 'a symbolic link was found and not followed';
  if (held.kind === 'fifo') return 'a FIFO was found and not followed';
  if (held.kind === 'folder') return `the ${label} path is a directory`;
  if (held.kind !== 'file') return `the ${label} path is not a regular file`;
  if (process.getuid !== undefined && held.uid !== process.getuid()) return "another user's file";
  return null;
}

/**
 * Ensures `<home>/.config`, `<home>/.config/team`, and `<storeDir>` exist as real directories
 * of this user's, with `<storeDir>` at mode 0700. Never walks through a symbolic link. Shared
 * with the pending records (`pending.ts`), which live in the same store beside the history.
 */
export function ensureStoreLadder(storeDir: string, home: string): string | null {
  const stateRoot = storesFolder(home);
  const configDir = dirname(stateRoot);
  const levels: Array<{ at: string; seal: boolean }> = [
    { at: configDir, seal: false },
    { at: stateRoot, seal: false },
    { at: storeDir, seal: true },
  ];
  for (const level of levels) {
    const held = heldAt(level.at);
    if (held.kind === 'missing') {
      try {
        // Import mkdirSync lazily or use node:fs; created one level at a time so no parent link is traversed.
        createDir0700(level.at);
      } catch {
        return 'the state folder could not be created';
      }
    } else {
      const problem = ladderProblem(level.at);
      if (problem !== null) return problem;
      if (level.seal && held.kind === 'folder' && held.mode !== 0o700) {
        try {
          chmodSync(level.at, 0o700);
        } catch {
          return 'the state folder permissions could not be set to 0700';
        }
      }
    }
  }
  return null;
}

import { mkdirSync } from 'node:fs';

function createDir0700(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

/**
 * Rotates `messages.jsonl` -> `.1` -> `.2`, keeping at most `HISTORY_KEPT` files (`3` total)
 * and enforcing mode 0600 on every rotated file. Refuses if any rotated slot holds a link or non-file.
 */
function rotateHistory(path: string): string | null {
  for (let n = 1; n < HISTORY_KEPT; n++) {
    const slot = `${path}.${String(n)}`;
    const problem = fileProblem(slot);
    if (problem !== null) return problem;
  }
  const oldest = `${path}.${String(HISTORY_KEPT - 1)}`;
  if (existsSync(oldest)) {
    unlinkSync(oldest);
  }
  for (let n = HISTORY_KEPT - 2; n >= 1; n--) {
    const from = `${path}.${String(n)}`;
    const to = `${path}.${String(n + 1)}`;
    if (existsSync(from)) {
      renameSync(from, to);
      chmodSync(to, 0o600);
    }
  }
  renameSync(path, `${path}.1`);
  chmodSync(`${path}.1`, 0o600);
  return null;
}

/**
 * Appends one JSONL record `{ts, from, to, body, id, outcome}` to `<storeDir>/messages.jsonl`
 * at mode 0600 without following symbolic links. Rotates at 1 MB keeping 3 files at mode 0600.
 */
export function appendHistory(project: string, root: string, home: string, entry: HistoryEntry): HistoryWrite {
  const record: HistoryEntry = {
    ts: entry.ts,
    from: entry.from,
    to: entry.to,
    body: entry.body,
    id: entry.id,
    outcome: entry.outcome,
  };
  // Written only when the run recorded them, so a plain line keeps its exact older shape.
  if (entry.from_team !== undefined) record.from_team = entry.from_team;
  if (entry.spec !== undefined) record.spec = entry.spec;
  if (entry.resolved !== undefined) record.resolved = entry.resolved;
  if (entry.ms !== undefined) record.ms = entry.ms;
  if (entry.via !== undefined) record.via = entry.via;
  if (entry.failed !== undefined && entry.failed.length > 0) record.failed = entry.failed;
  if (entry.note !== undefined) record.note = entry.note;
  if (entry.thread !== undefined) record.thread = entry.thread;
  if (entry.in_reply_to !== undefined) record.in_reply_to = entry.in_reply_to;
  return appendStoreLine(project, root, home, HISTORY_FILE, record);
}

/**
 * One already-composed record, appended as one JSON line to `fileName` inside the project's
 * state folder — the one sink every JSONL stream beside `messages.jsonl` writes through, so
 * the ladder, the `lstat` guards, mode 0600 and the 1 MB rotation stay one implementation for
 * all of them.
 */
export function appendStoreLine(
  project: string,
  root: string,
  home: string,
  fileName: string,
  record: Record<string, unknown>,
  options: { rotate?: boolean; label?: string } = {},
): HistoryWrite {
  const storeDir = storePath(project, root, home);
  const ladderErr = ensureStoreLadder(storeDir, home);
  if (ladderErr !== null) return { ok: false, reason: ladderErr };

  const path = join(storeDir, fileName);
  const targetErr = fileProblem(path, options.label);
  if (targetErr !== null) return { ok: false, reason: targetErr };

  const line = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.from(line, 'utf8');

  try {
    const current = heldAt(path);
    // A registry that is append-only (`sessions.jsonl`) passes `rotate: false`: the history's
    // rotation would drop its oldest lines, and its lines are records, not a feed.
    if (options.rotate !== false && current.kind === 'file') {
      const size = statSync(path).size;
      if (size > 0 && size + bytes.length > MAX_HISTORY_BYTES) {
        const rotateErr = rotateHistory(path);
        if (rotateErr !== null) return { ok: false, reason: rotateErr };
      }
    }

    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return { ok: false, reason: 'the history log path is not a regular file' };
      if ((stat.mode & 0o777) !== 0o600) {
        fchmodSync(fd, 0o600);
      }
      for (let wrote = 0; wrote < bytes.length;) {
        wrote += writeSync(fd, bytes, wrote, bytes.length - wrote);
      }
    } finally {
      closeSync(fd);
    }
    return { ok: true, path };
  } catch {
    return { ok: false, reason: 'the history log could not be written' };
  }
}

/** Reads a regular file with `O_RDONLY | O_NOFOLLOW`. Returns null on any fault. */
export function readNoFollow(path: string): string | null {
  const problem = fileProblem(path);
  if (problem !== null) return null;
  if (heldAt(path).kind === 'missing') return '';
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(8192);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Parses one JSONL line into a `HistoryEntry`, or null when malformed. */
export function parseHistoryLine(raw: string): HistoryEntry | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.ts !== 'string' ||
    typeof obj.from !== 'string' ||
    typeof obj.to !== 'string' ||
    typeof obj.body !== 'string' ||
    typeof obj.id !== 'string' ||
    typeof obj.outcome !== 'string'
  ) {
    return null;
  }
  const entry: HistoryEntry = {
    ts: obj.ts,
    from: obj.from,
    to: obj.to,
    body: obj.body,
    id: obj.id,
    outcome: obj.outcome,
  };
  // `from_team`, `spec`, `resolved`, `ms`, `via`, `failed` and `note` are optional: a line with a wrong-typed one keeps its other fields.
  if (typeof obj.from_team === 'string' && obj.from_team !== '') {
    entry.from_team = obj.from_team;
  }
  if (typeof obj.spec === 'string' && obj.spec !== '') {
    entry.spec = obj.spec;
  }
  if (typeof obj.resolved === 'string' && obj.resolved !== '') {
    entry.resolved = obj.resolved;
  }
  if (typeof obj.ms === 'number' && Number.isFinite(obj.ms) && obj.ms >= 0) {
    entry.ms = obj.ms;
  }
  if (typeof obj.via === 'string' && obj.via !== '') {
    entry.via = obj.via;
  }
  if (Array.isArray(obj.failed) && obj.failed.length > 0 && obj.failed.every((one) => typeof one === 'string')) {
    entry.failed = obj.failed as string[];
  }
  if (typeof obj.note === 'string' && obj.note !== '') {
    entry.note = obj.note;
  }
  if (typeof obj.thread === 'string' && obj.thread !== '') {
    entry.thread = obj.thread;
  }
  if (typeof obj.in_reply_to === 'string' && obj.in_reply_to !== '') {
    entry.in_reply_to = obj.in_reply_to;
  }
  return entry;
}

/**
 * Reads one state folder's history log (`messages.jsonl.2`, `messages.jsonl.1`, `messages.jsonl`)
 * in chronological order without following symbolic links.
 */
export function readStoreHistory(storeDir: string, home: string): HistoryRead {
  const stateRoot = storesFolder(home);
  const configDir = dirname(stateRoot);
  for (const level of [configDir, stateRoot, storeDir]) {
    const problem = ladderProblem(level);
    if (problem !== null) return { ok: false, reason: problem };
  }

  const path = join(storeDir, HISTORY_FILE);
  const files: string[] = [];
  for (let n = HISTORY_KEPT - 1; n >= 1; n--) {
    files.push(`${path}.${String(n)}`);
  }
  files.push(path);

  const entries: HistoryEntry[] = [];
  for (const candidate of files) {
    const problem = fileProblem(candidate);
    if (problem !== null) return { ok: false, reason: problem };
    if (heldAt(candidate).kind === 'missing') continue;
    const text = readNoFollow(candidate);
    if (text === null) return { ok: false, reason: 'the history log could not be read' };
    for (const line of text.split('\n')) {
      const entry = parseHistoryLine(line);
      if (entry !== null) entries.push(entry);
    }
  }
  return { ok: true, entries, path };
}

/**
 * Reads the project's history log (`messages.jsonl.2`, `messages.jsonl.1`, `messages.jsonl`)
 * in chronological order without following symbolic links.
 */
export function readHistory(project: string, root: string, home: string): HistoryRead {
  return readStoreHistory(storePath(project, root, home), home);
}

export type StoreLinesRead =
  | { ok: true; lines: string[] }
  | { ok: false; reason: string };

/**
 * Reads one JSONL stream beside `messages.jsonl` in a project state folder, with the same
 * ladder and `lstat` guards, without following a link and without rotating anything. A missing
 * file is no lines. `label` names the stream in a refusal ("the session registry path ...").
 */
export function readStoreLines(
  storeDir: string,
  fileName: string,
  home: string,
  label = 'history log',
): StoreLinesRead {
  const stateRoot = storesFolder(home);
  const configDir = dirname(stateRoot);
  for (const level of [configDir, stateRoot, storeDir]) {
    const problem = ladderProblem(level);
    if (problem !== null) return { ok: false, reason: problem };
  }
  const path = join(storeDir, fileName);
  const problem = fileProblem(path, label);
  if (problem !== null) return { ok: false, reason: problem };
  if (heldAt(path).kind === 'missing') return { ok: true, lines: [] };
  const text = readNoFollow(path);
  if (text === null) return { ok: false, reason: `the ${label} could not be read` };
  return { ok: true, lines: text.split('\n') };
}

/**
 * Every project state folder under `<home>/.config/team`, in name order, never `lobby` or
 * `lobbies` and never a symbolic link. A folder the machine cannot read refuses the whole
 * listing rather than answering with a partial one.
 */
export function listStoreDirs(home: string): { ok: true; dirs: string[] } | { ok: false; reason: string } {
  const stateRoot = storesFolder(home);
  const configDir = dirname(stateRoot);
  for (const level of [configDir, stateRoot]) {
    const problem = ladderProblem(level);
    if (problem !== null) return { ok: false, reason: problem };
  }
  if (heldAt(stateRoot).kind === 'missing') return { ok: true, dirs: [] };

  let names: string[];
  try {
    names = readdirSync(stateRoot).sort();
  } catch {
    return { ok: false, reason: 'the state folder could not be read' };
  }
  const dirs: string[] = [];
  for (const name of names) {
    if (name === 'lobby' || name === 'lobbies') continue;
    if (!STORE_DIR_NAME.test(name)) continue;
    const dir = join(stateRoot, name);
    if (ladderProblem(dir) !== null) continue;
    if (heldAt(dir).kind !== 'folder') continue;
    dirs.push(dir);
  }
  return { ok: true, dirs };
}

const STORE_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*-[0-9a-f]{12}$/;

/**
 * Reads `messages.jsonl` across every project state folder under `<home>/.config/team`
 * (never entering `lobby` or `lobbies`), sorted chronologically.
 */
export function readAllHistories(home: string): { ok: true; entries: HistoryEntry[] } | { ok: false; reason: string } {
  const stateRoot = storesFolder(home);
  const configDir = dirname(stateRoot);
  for (const level of [configDir, stateRoot]) {
    const problem = ladderProblem(level);
    if (problem !== null) return { ok: false, reason: problem };
  }
  if (heldAt(stateRoot).kind === 'missing') return { ok: true, entries: [] };

  let names: string[];
  try {
    names = readdirSync(stateRoot).sort();
  } catch {
    return { ok: false, reason: 'the state folder could not be read' };
  }

  const all: HistoryEntry[] = [];
  for (const name of names) {
    if (name === 'lobby' || name === 'lobbies') continue;
    if (!STORE_DIR_NAME.test(name)) continue;
    const dir = join(stateRoot, name);
    const read = readStoreHistory(dir, home);
    if (!read.ok) return read;
    for (const entry of read.entries) all.push(entry);
  }
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { ok: true, entries: all };
}

/**
 * Re-keys `from` and `to` in the project's history log (`messages.jsonl`, `.1`, `.2`) when a
 * seat is renamed, preserving `spec` (recording the prior seat name when `to` was rewritten and
 * `spec` was absent) so `team feed --seat <new-seat>` finds the seat's entire history.
 */
export function renameSeatHistory(
  project: string,
  root: string,
  home: string,
  fromSeat: string,
  toSeat: string,
): number {
  const storeDir = storePath(project, root, home);
  if (ladderProblem(storeDir) !== null || heldAt(storeDir).kind !== 'folder') return 0;
  const base = join(storeDir, HISTORY_FILE);
  const candidates: string[] = [];
  for (let n = HISTORY_KEPT - 1; n >= 1; n--) candidates.push(`${base}.${String(n)}`);
  candidates.push(base);

  let updated = 0;
  for (const candidate of candidates) {
    if (fileProblem(candidate) !== null || heldAt(candidate).kind !== 'file') continue;
    const text = readNoFollow(candidate);
    if (text === null) continue;
    let fileChanged = false;
    const nextLines = text.split('\n').map((raw) => {
      const entry = parseHistoryLine(raw);
      if (!entry) return raw;
      let changed = false;
      const next: HistoryEntry = { ...entry };
      if (next.from === fromSeat) {
        next.from = toSeat;
        changed = true;
      }
      if (next.to === fromSeat) {
        if (next.spec === undefined) next.spec = fromSeat;
        next.to = toSeat;
        changed = true;
      }
      if (!changed) return raw;
      fileChanged = true;
      updated += 1;
      return JSON.stringify(next);
    });
    if (!fileChanged) continue;
    const tmp = `${candidate}.${process.pid}.rename.tmp`;
    const bytes = Buffer.from(nextLines.join('\n'), 'utf8');
    try {
      const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o600);
      try {
        fchmodSync(fd, 0o600);
        for (let wrote = 0; wrote < bytes.length;) {
          wrote += writeSync(fd, bytes, wrote, bytes.length - wrote);
        }
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, candidate);
      chmodSync(candidate, 0o600);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  }
  return updated;
}

