// Durable, sequence-numbered, Ed25519-signed event log (`events.jsonl`, `.1`, `.2`) inside
// `<home>/.config/team/<project>-<hash>/` (RFC 002 Amendment 01 §4.1, §4.2, §7).
//
// Every event is signed under `EVENT_DOMAIN` with the checkout's message key (`messageKeyOf`).
// The log mints monotonically increasing sequence numbers (`seq: 1, 2, ...`), writes atomically
// at mode 0600 without following symbolic links, and rotates at `MAX_EVENT_LOG_BYTES` keeping
// `EVENT_LOG_KEPT` files. When a subscriber's cursor is older than the oldest sequence retained
// in the rotated log (`cursor > 0 && cursor < oldestSeq`), `readEventsFromCursor` answers `gap`
// with `oldest_seq` so the subscriber resyncs from the underlying records before following on.
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { heldAt } from '../launch/rules-file.ts';
import { ensureStoreLadder, readNoFollow } from '../send/history.ts';
import {
  messageKeyOf,
  messageKeyState,
  signDomain,
  verifyDomain,
  type Json,
} from '../store/keys.ts';
import { storePath, storesFolder } from '../store/store.ts';
import { isEventKind, type EventKind } from './kinds.ts';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export const EVENT_DOMAIN = 'team.event.v1\n';
export const EVENT_LOG_FILE = 'events.jsonl';
export const MAX_EVENT_LOG_BYTES = 1_000_000;
export const EVENT_LOG_KEPT = 3;

export type EventPayload = {
  v: 1;
  seq: number;
  ts: string;
  kind: EventKind;
  session: string;
  record_id: string;
  from?: string;
  to?: string;
  seat?: string;
  subject?: string;
  thread?: string;
  via?: string;
  reason?: string;
  prompt?: string;
  rule?: string;
};

export type SignedEventRecord = {
  payload: EventPayload;
  signature: string;
};

export type EventAppendInput = Omit<EventPayload, 'v' | 'seq'>;

export type EventAppendResult =
  | { ok: true; record: SignedEventRecord; duplicate: boolean; path: string }
  | { ok: false; reason: string };

export type EventReadResult =
  | {
      ok: true;
      events: SignedEventRecord[];
      unverified: number;
      oldestSeq: number | null;
      newestSeq: number | null;
      path: string;
    }
  | { ok: false; reason: string };

export type CursorReadResult =
  | {
      ok: true;
      kind: 'events';
      events: SignedEventRecord[];
      cursor: number;
      oldestSeq: number | null;
      newestSeq: number | null;
    }
  | {
      ok: true;
      kind: 'gap';
      oldest_seq: number;
      newest_seq: number;
    }
  | { ok: false; reason: string };

export function eventLogPath(project: string, root: string, home: string): string {
  return join(storePath(project, root, home), EVENT_LOG_FILE);
}

function ladderProblem(at: string): string | null {
  const held = heldAt(at);
  if (held.kind === 'missing') return null;
  if (held.kind === 'link') return 'a symbolic link was found and not followed';
  if (held.kind === 'fifo') return 'a FIFO was found and not followed';
  if (held.kind !== 'folder') return 'the state folder path is not a directory';
  if (process.getuid !== undefined && held.uid !== process.getuid()) return "another user's folder";
  return null;
}

function fileProblem(at: string): string | null {
  const held = heldAt(at);
  if (held.kind === 'missing') return null;
  if (held.kind === 'link') return 'a symbolic link was found and not followed';
  if (held.kind === 'fifo') return 'a FIFO was found and not followed';
  if (held.kind === 'folder') return 'the event log path is a directory';
  if (held.kind !== 'file') return 'the event log path is not a regular file';
  if (process.getuid !== undefined && held.uid !== process.getuid()) return "another user's file";
  return null;
}

function rotateEventLog(path: string, kept: number = EVENT_LOG_KEPT): string | null {
  for (let n = 1; n < kept; n++) {
    const slot = `${path}.${String(n)}`;
    const problem = fileProblem(slot);
    if (problem !== null) return problem;
  }
  const oldest = `${path}.${String(kept - 1)}`;
  if (existsSync(oldest)) {
    unlinkSync(oldest);
  }
  for (let n = kept - 2; n >= 1; n--) {
    const from = `${path}.${String(n)}`;
    const to = `${path}.${String(n + 1)}`;
    if (existsSync(from)) {
      renameSync(from, to);
      chmodSync(to, 0o600);
    }
  }
  if (existsSync(path)) {
    renameSync(path, `${path}.1`);
    chmodSync(`${path}.1`, 0o600);
  }
  return null;
}

const OPTIONAL_STRING_FIELDS = [
  'from',
  'to',
  'seat',
  'subject',
  'thread',
  'via',
  'reason',
  'prompt',
  'rule',
] as const;

const ALLOWED_PAYLOAD_KEYS = new Set<string>([
  'v',
  'seq',
  'ts',
  'kind',
  'session',
  'record_id',
  ...OPTIONAL_STRING_FIELDS,
]);

export function parseEventPayload(value: unknown): EventPayload | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_PAYLOAD_KEYS.has(key)) return null;
  }
  if (obj.v !== 1) return null;
  if (typeof obj.seq !== 'number' || !Number.isInteger(obj.seq) || obj.seq < 1) return null;
  if (typeof obj.ts !== 'string' || obj.ts === '' || !Number.isFinite(Date.parse(obj.ts))) return null;
  if (!isEventKind(obj.kind)) return null;
  if (typeof obj.session !== 'string' || obj.session === '') return null;
  if (typeof obj.record_id !== 'string' || obj.record_id === '') return null;

  const payload: EventPayload = {
    v: 1,
    seq: obj.seq,
    ts: obj.ts,
    kind: obj.kind,
    session: obj.session,
    record_id: obj.record_id,
  };
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (field in obj && obj[field] !== undefined) {
      if (typeof obj[field] !== 'string' || obj[field] === '') return null;
      payload[field] = obj[field] as string;
    }
  }
  return payload;
}

export function parseSignedEventLine(raw: string): SignedEventRecord | null {
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
  const keys = Object.keys(obj);
  if (keys.length !== 2 || !keys.every((k) => k === 'payload' || k === 'signature')) return null;
  if (typeof obj.signature !== 'string' || obj.signature === '') return null;
  const payload = parseEventPayload(obj.payload);
  if (payload === null) return null;
  return { payload, signature: obj.signature };
}

export function verifySignedEvent(record: SignedEventRecord, home: string): boolean {
  const state = messageKeyState(home);
  if (state.kind !== 'key') return false;
  return verifyDomain(EVENT_DOMAIN, record.payload as unknown as Json, record.signature, state.key);
}

/** Reads all retained event log files (`events.jsonl.2`, `.1`, `events.jsonl`) in sequence order,
 *  verifying each record's signature against the checkout's message key. Unverified or malformed
 *  lines are counted in `unverified` and never returned as events. */
export function readEvents(
  project: string,
  root: string,
  home: string,
  options: { kept?: number } = {},
): EventReadResult {
  const kept = options.kept ?? EVENT_LOG_KEPT;
  const storeDir = storePath(project, root, home);
  const stateRoot = storesFolder(home);
  const configDir = dirname(stateRoot);
  for (const level of [configDir, stateRoot, storeDir]) {
    const problem = ladderProblem(level);
    if (problem !== null) return { ok: false, reason: problem };
  }

  const path = join(storeDir, EVENT_LOG_FILE);
  const files: string[] = [];
  for (let n = kept - 1; n >= 1; n--) {
    files.push(`${path}.${String(n)}`);
  }
  files.push(path);

  const keyState = messageKeyState(home);
  const events: SignedEventRecord[] = [];
  let unverified = 0;

  for (const candidate of files) {
    const problem = fileProblem(candidate);
    if (problem !== null) return { ok: false, reason: problem };
    if (heldAt(candidate).kind === 'missing') continue;
    const text = readNoFollow(candidate);
    if (text === null) return { ok: false, reason: 'the event log could not be read' };
    for (const rawLine of text.split('\n')) {
      if (rawLine.trim() === '') continue;
      const parsed = parseSignedEventLine(rawLine);
      if (parsed === null) {
        unverified += 1;
        continue;
      }
      if (keyState.kind !== 'key' || !verifyDomain(EVENT_DOMAIN, parsed.payload as unknown as Json, parsed.signature, keyState.key)) {
        unverified += 1;
        continue;
      }
      events.push(parsed);
    }
  }

  const oldestSeq = events.length > 0 ? events[0]!.payload.seq : null;
  const newestSeq = events.length > 0 ? events[events.length - 1]!.payload.seq : null;
  return { ok: true, events, unverified, oldestSeq, newestSeq, path };
}

/** Reads events after `cursor` (`seq > cursor`). When `cursor > 0` is older than the oldest
 *  event retained in the rotated log (`cursor < oldestSeq`), returns `{ kind: 'gap', oldest_seq }`
 *  so the subscriber knows to resync from the records before following on (Amendment 01 §4.2). */
export function readEventsFromCursor(
  project: string,
  root: string,
  home: string,
  cursor: number,
  options: { kept?: number } = {},
): CursorReadResult {
  const read = readEvents(project, root, home, options);
  if (!read.ok) return read;
  const { events, oldestSeq, newestSeq } = read;
  if (cursor > 0 && oldestSeq !== null && cursor < oldestSeq) {
    return {
      ok: true,
      kind: 'gap',
      oldest_seq: oldestSeq,
      newest_seq: newestSeq ?? oldestSeq,
    };
  }
  const unseen = events.filter((entry) => entry.payload.seq > cursor);
  const nextCursor = unseen.length > 0 ? unseen[unseen.length - 1]!.payload.seq : (newestSeq !== null && newestSeq > cursor ? newestSeq : cursor);
  return {
    ok: true,
    kind: 'events',
    events: unseen,
    cursor: nextCursor,
    oldestSeq,
    newestSeq,
  };
}

/** One retained log file as the append index last saw it: identity and size, so an unchanged file
 *  is not read again and a file that only grew is read from where the index stopped. */
type LogFileStamp = { ino: number; size: number; mtimeMs: number };

type AppendIndex = {
  keyPrint: string;
  files: (LogFileStamp | null)[];
  /** The first verified record for each `(kind, record_id, session)`, in retained order. */
  duplicates: Map<string, SignedEventRecord>;
  newestSeq: number | null;
  path: string;
};

const appendIndexes = new Map<string, AppendIndex>();

function eventKey(payload: Pick<EventPayload, 'kind' | 'record_id' | 'session'>): string {
  return `${payload.kind}\u0000${payload.record_id}\u0000${payload.session}`;
}

function fileStamp(path: string): LogFileStamp | null {
  if (heldAt(path).kind !== 'file') return null;
  try {
    const stat = statSync(path);
    return { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function sameStamp(a: LogFileStamp | null, b: LogFileStamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** The message key the index was built under: a key change invalidates every verification. */
function keyPrintOf(home: string): string {
  const state = messageKeyState(home);
  if (state.kind !== 'key') return 'none';
  return createHash('sha256').update(state.key.export({ type: 'pkcs8', format: 'pem' })).digest('hex');
}

/** Reads the bytes after `from` without following a link. Null when the file cannot be read that
 *  way (the caller then reads it whole). */
function readTailNoFollow(path: string, from: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < from) return null;
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(8192);
    let position = from;
    while (position < stat.size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, stat.size - position), position);
      if (n === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
      position += n;
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Verifies the records in one stretch of the log, adding each to `into` when it is the first of
 *  its key, and returns them in order. Malformed and unverified lines are skipped, as in
 *  `readEvents`. */
function verifyInto(
  text: string,
  keyState: ReturnType<typeof messageKeyState>,
  into: Map<string, SignedEventRecord>,
): SignedEventRecord[] {
  const out: SignedEventRecord[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.trim() === '') continue;
    const parsed = parseSignedEventLine(rawLine);
    if (parsed === null) continue;
    if (keyState.kind !== 'key' || !verifyDomain(EVENT_DOMAIN, parsed.payload as unknown as Json, parsed.signature, keyState.key)) {
      continue;
    }
    out.push(parsed);
    const key = eventKey(parsed.payload);
    if (!into.has(key)) into.set(key, parsed);
  }
  return out;
}

/** What `appendEvent` needs from the retained log, kept across appends: the first verified record
 *  per `(kind, record_id, session)` and the last verified sequence. The first look reads every
 *  retained file; each later look reads only the bytes appended to `events.jsonl` since the last
 *  one, so a growing session costs O(bytes) rather than re-verifying the whole log per publish. A
 *  rotated or rewritten file — or a changed key — falls back to the full read. */
function appendIndexOf(
  project: string,
  root: string,
  home: string,
  kept: number,
): { ok: true; index: AppendIndex } | { ok: false; reason: string } {
  const storeDir = storePath(project, root, home);
  const stateRoot = storesFolder(home);
  const configDir = dirname(stateRoot);
  for (const level of [configDir, stateRoot, storeDir]) {
    const problem = ladderProblem(level);
    if (problem !== null) return { ok: false, reason: problem };
  }

  const path = join(storeDir, EVENT_LOG_FILE);
  const files: string[] = [];
  for (let n = kept - 1; n >= 1; n--) files.push(`${path}.${String(n)}`);
  files.push(path);
  for (const candidate of files) {
    const problem = fileProblem(candidate);
    if (problem !== null) return { ok: false, reason: problem };
  }

  const keyState = messageKeyState(home);
  const keyPrint = keyPrintOf(home);
  const stamps = files.map((candidate) => fileStamp(candidate));
  const cacheKey = `${storeDir}\u0000${String(kept)}`;
  const cached = appendIndexes.get(cacheKey);
  const sameFiles =
    cached !== undefined &&
    cached.keyPrint === keyPrint &&
    cached.files.length === stamps.length &&
    cached.files.every((stamp, at) => sameStamp(stamp, stamps[at] ?? null));
  if (cached !== undefined && sameFiles) return { ok: true, index: cached };

  const last = files.length - 1;
  const grew =
    cached !== undefined &&
    cached.keyPrint === keyPrint &&
    cached.files.length === stamps.length &&
    cached.files.slice(0, last).every((stamp, at) => sameStamp(stamp, stamps[at] ?? null)) &&
    cached.files[last] !== null &&
    stamps[last] !== null &&
    cached.files[last]!.ino === stamps[last]!.ino &&
    stamps[last]!.size >= cached.files[last]!.size;
  if (cached !== undefined && grew) {
    const previousSize = cached.files[last]!.size;
    const tail = readTailNoFollow(path, previousSize);
    if (tail !== null && (tail === '' || tail.endsWith('\n'))) {
      const fresh = verifyInto(tail, keyState, cached.duplicates);
      if (fresh.length > 0) cached.newestSeq = fresh[fresh.length - 1]!.payload.seq;
      cached.files[last] = fileStamp(path) ?? stamps[last] ?? null;
      return { ok: true, index: cached };
    }
  }

  const duplicates = new Map<string, SignedEventRecord>();
  let newestSeq: number | null = null;
  for (const candidate of files) {
    if (heldAt(candidate).kind === 'missing') continue;
    const text = readNoFollow(candidate);
    if (text === null) return { ok: false, reason: 'the event log could not be read' };
    const verified = verifyInto(text, keyState, duplicates);
    if (verified.length > 0) newestSeq = verified[verified.length - 1]!.payload.seq;
  }
  const index: AppendIndex = { keyPrint, files: stamps, duplicates, newestSeq, path };
  appendIndexes.set(cacheKey, index);
  return { ok: true, index };
}

/** Appends one signed event to `<storeDir>/events.jsonl` at mode 0600, minting the next sequence
 *  number (`seq = newestSeq + 1`). When `deduplicate` is true (the default), if a verified event
 *  with the same `(kind, record_id, session)` is already present in the retained log, returns it
 *  with `duplicate: true` without writing a second record. */
export function appendEvent(
  project: string,
  root: string,
  home: string,
  input: EventAppendInput,
  options: { maxBytes?: number; kept?: number; deduplicate?: boolean; seqOverride?: number } = {},
): EventAppendResult {
  const maxBytes = options.maxBytes ?? MAX_EVENT_LOG_BYTES;
  const kept = options.kept ?? EVENT_LOG_KEPT;
  const deduplicate = options.deduplicate ?? true;

  if (heldAt(home).kind === 'missing') {
    mkdirSync(home, { recursive: true });
  }
  const storeDir = storePath(project, root, home);
  const ladderErr = ensureStoreLadder(storeDir, home);
  if (ladderErr !== null) return { ok: false, reason: ladderErr };

  const indexed = appendIndexOf(project, root, home, kept);
  if (!indexed.ok) return indexed;

  if (deduplicate) {
    const found = indexed.index.duplicates.get(eventKey(input));
    if (found !== undefined) {
      return { ok: true, record: found, duplicate: true, path: indexed.index.path };
    }
  }

  // If the current file rotated earlier and `newestSeq` is null, start at 1; otherwise strictly
  // increment from the highest sequence seen across the retained files.
  const nextSeq = options.seqOverride ?? ((indexed.index.newestSeq ?? 0) + 1);
  const candidate: EventPayload = {
    v: 1,
    seq: nextSeq,
    ts: input.ts,
    kind: input.kind,
    session: input.session,
    record_id: input.record_id,
  };
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (input[field] !== undefined && input[field] !== '') {
      candidate[field] = input[field];
    }
  }
  const validated = parseEventPayload(candidate);
  if (validated === null) return { ok: false, reason: 'the event payload is invalid' };

  let signature: string;
  try {
    const key = messageKeyOf(home);
    signature = signDomain(EVENT_DOMAIN, validated as unknown as Json, key);
  } catch {
    return { ok: false, reason: 'the event could not be signed with the message key' };
  }

  const record: SignedEventRecord = { payload: validated, signature };
  const path = join(storeDir, EVENT_LOG_FILE);
  const targetErr = fileProblem(path);
  if (targetErr !== null) return { ok: false, reason: targetErr };

  const line = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.from(line, 'utf8');

  try {
    const current = heldAt(path);
    if (current.kind === 'file') {
      const size = statSync(path).size;
      if (size > 0 && size + bytes.length > maxBytes) {
        const rotateErr = rotateEventLog(path, kept);
        if (rotateErr !== null) return { ok: false, reason: rotateErr };
      }
    }

    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return { ok: false, reason: 'the event log path is not a regular file' };
      if ((stat.mode & 0o777) !== 0o600) {
        fchmodSync(fd, 0o600);
      }
      for (let wrote = 0; wrote < bytes.length; ) {
        wrote += writeSync(fd, bytes, wrote, bytes.length - wrote);
      }
    } finally {
      closeSync(fd);
    }
    return { ok: true, record, duplicate: false, path };
  } catch {
    return { ok: false, reason: 'the event log could not be written' };
  }
}

/** Subscriber-side monotonic sequence filter (Amendment 01 §4.1): applies events in sequence
 *  order and drops any duplicate or reordered event whose `seq <= cursor`. */
export type SequenceTracker = {
  readonly cursor: number;
  accept(event: SignedEventRecord | EventPayload): boolean;
  reset(cursor: number): void;
};

export function createSequenceTracker(initialCursor = 0): SequenceTracker {
  let current = initialCursor;
  return {
    get cursor() {
      return current;
    },
    accept(event: SignedEventRecord | EventPayload): boolean {
      const seq = 'payload' in event ? event.payload.seq : event.seq;
      if (!Number.isInteger(seq) || seq <= current) return false;
      current = seq;
      return true;
    },
    reset(cursor: number): void {
      current = cursor;
    },
  };
}
