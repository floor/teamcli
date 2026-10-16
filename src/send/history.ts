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

export type HistoryOutcome = 'delivered' | 'held' | 'not-submitted' | 'unreachable' | 'answered' | 'timeout';

export type HistoryEntry = {
  ts: string;
  from: string;
  to: string;
  body: string;
  id: string;
  outcome: string;
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
function fileProblem(at: string): string | null {
  const held = heldAt(at);
  if (held.kind === 'missing') return null;
  if (held.kind === 'link') return 'a symbolic link was found and not followed';
  if (held.kind === 'fifo') return 'a FIFO was found and not followed';
  if (held.kind === 'folder') return 'the history log path is a directory';
  if (held.kind !== 'file') return 'the history log path is not a regular file';
  if (process.getuid !== undefined && held.uid !== process.getuid()) return "another user's file";
  return null;
}

/**
 * Ensures `<home>/.config`, `<home>/.config/team`, and `<storeDir>` exist as real directories
 * of this user's, with `<storeDir>` at mode 0700. Never walks through a symbolic link.
 */
function ensureStoreLadder(storeDir: string, home: string): string | null {
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
  const storeDir = storePath(project, root, home);
  const ladderErr = ensureStoreLadder(storeDir, home);
  if (ladderErr !== null) return { ok: false, reason: ladderErr };

  const path = join(storeDir, HISTORY_FILE);
  const targetErr = fileProblem(path);
  if (targetErr !== null) return { ok: false, reason: targetErr };

  const record: HistoryEntry = {
    ts: entry.ts,
    from: entry.from,
    to: entry.to,
    body: entry.body,
    id: entry.id,
    outcome: entry.outcome,
  };
  const line = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.from(line, 'utf8');

  try {
    const current = heldAt(path);
    if (current.kind === 'file') {
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
  return {
    ts: obj.ts,
    from: obj.from,
    to: obj.to,
    body: obj.body,
    id: obj.id,
    outcome: obj.outcome,
  };
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

