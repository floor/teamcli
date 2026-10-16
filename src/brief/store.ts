// A seat's brief, kept on disk beside the team file: a snapshot of the file the seat was
// handed, and one record of where that brief stands. The snapshot is copied once, so a later
// edit of the source file cannot change what the seat was given. Folders are 0700 and files
// 0600. A record that is not the shape written here reads as no record at all.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The longest brief taken, in bytes. A brief is a page of instructions, not a data file. */
export const BRIEF_MAX = 256 * 1024;

export type BriefStatus = 'assigned' | 'delivered' | 'held' | 'unreachable' | 'refused' | 'done';

const STATUSES: readonly string[] = ['assigned', 'delivered', 'held', 'unreachable', 'refused', 'done'];

export type BriefRecord = {
  id: string;
  seat: string;
  /** The source file's name only: the path it came from is not kept. */
  source: string;
  sha256: string;
  status: BriefStatus;
  assigned_by: string;
  assigned_at: string;
  delivered_at?: string;
  done_at?: string;
  done_by?: string;
  summary?: string;
};

export function briefDir(dir: string, session: string, seat: string): string {
  return join(dir, 'briefs', session, seat);
}

export function snapshotPath(dir: string, session: string, seat: string, id: string): string {
  return join(briefDir(dir, session, seat), `${id}.md`);
}

function currentPath(dir: string, session: string, seat: string): string {
  return join(briefDir(dir, session, seat), 'current.json');
}

/** What a brief file holds, or why it cannot be taken. A link, a folder, an empty file, a file
 *  over `BRIEF_MAX` and bytes that are not UTF-8 are all refused; the file is opened without
 *  following a link, and what is read is the same file the checks looked at. */
export function readBriefFile(path: string): { ok: true; text: string; sha256: string } | { ok: false; why: string } {
  let fd: number;
  try {
    if (lstatSync(path).isSymbolicLink()) return { ok: false, why: 'it is a link' };
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { ok: false, why: 'it cannot be read' };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, why: 'it is not a regular file' };
    if (stat.size === 0) return { ok: false, why: 'it is empty' };
    if (stat.size > BRIEF_MAX) return { ok: false, why: `it is over ${String(BRIEF_MAX)} bytes` };
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, read);
      if (n === 0) break;
      read += n;
    }
    const body = bytes.subarray(0, read);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      return { ok: false, why: 'it is not UTF-8 text' };
    }
    if (text.trim() === '') return { ok: false, why: 'it is empty' };
    return { ok: true, text, sha256: createHash('sha256').update(body).digest('hex') };
  } finally {
    closeSync(fd);
  }
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Writes the snapshot once; a second write under the same id throws rather than replace it. */
export function writeSnapshot(dir: string, session: string, seat: string, id: string, text: string): string {
  const path = snapshotPath(dir, session, seat, id);
  ensureDir(dirname(path));
  writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
  return path;
}

export function readCurrent(dir: string, session: string, seat: string): BriefRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(currentPath(dir, session, seat), 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  const text = (key: string): string | undefined => (typeof r[key] === 'string' ? (r[key] as string) : undefined);
  const id = text('id');
  const recSeat = text('seat');
  const source = text('source');
  const sha256 = text('sha256');
  const status = text('status');
  const by = text('assigned_by');
  const at = text('assigned_at');
  if (!id || recSeat !== seat || source === undefined || !sha256 || !status || !STATUSES.includes(status) || !by || !at) return null;
  const record: BriefRecord = { id, seat, source, sha256, status: status as BriefStatus, assigned_by: by, assigned_at: at };
  for (const key of ['delivered_at', 'done_at', 'done_by', 'summary'] as const) {
    const value = text(key);
    if (value !== undefined) record[key] = value;
  }
  return record;
}

/** Replaces the seat's record whole, through a temporary file and a rename. */
export function writeCurrent(dir: string, session: string, seat: string, record: BriefRecord): void {
  const path = currentPath(dir, session, seat);
  ensureDir(dirname(path));
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
