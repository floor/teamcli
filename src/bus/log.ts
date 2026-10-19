// Durable, sequence-numbered, Ed25519-signed event log (`events.jsonl`, `.1`, `.2`) inside
// `<home>/.config/team/<project>-<hash>/` (RFC 002 Amendment 01 §4.1, §4.2, §7).
//
// Every event is signed under `EVENT_DOMAIN` with the checkout's message key (`messageKeyOf`).
// The log mints monotonically increasing sequence numbers (`seq: 1, 2, ...`), writes atomically
// at mode 0600 without following symbolic links, and rotates at `MAX_EVENT_LOG_BYTES` keeping
// `EVENT_LOG_KEPT` files. A segment is retained for the event thresholds' window (30 days) and
// the team's log never holds more than `EVENT_LOG_TOTAL_BYTES` (100 MB); past either, the oldest
// sealed segment is dropped, whole and unrewritten; the pass writes one `.agents/team.log` line
// and appends one signed `team.event-log-dropped` record naming the dropped sequence range and
// whether the age window or a size bound dropped it, so a reader and a gap-resync see a declared
// hole rather than an unexplained one.
// When records between a subscriber's cursor and the oldest retained sequence are missing
// (`cursor + 1 < oldestSeq`), `readEventsFromCursor` answers `gap` with `oldest_seq` so the
// subscriber resyncs from the underlying records before following on; a window every retained
// drop record covers also carries `reason: 'retention'`.
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
import { logLine } from '../log.ts';
import { ensureStoreLadder, readNoFollow } from '../send/history.ts';
import {
  messageKeyOf,
  messageKeyState,
  signDomain,
  verifyDomain,
  type Json,
} from '../store/keys.ts';
import { storePath, storesFolder } from '../store/store.ts';
import { DEFAULT_EVENT_RETENTION_SECONDS, isEventKind, type EventKind } from './kinds.ts';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export const EVENT_DOMAIN = 'team.event.v1\n';
export const EVENT_LOG_FILE = 'events.jsonl';
/** One segment reaches this size before it rotates. */
export const MAX_EVENT_LOG_BYTES = 100_000_000;
/** The live file and one sealed segment. */
export const EVENT_LOG_KEPT = 2;
/** The most the team's retained event log may hold, across its files. */
export const EVENT_LOG_TOTAL_BYTES = 100_000_000;

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
  /** On `team.event-log-dropped`: the oldest sequence retention has dropped (carried forward
   *  across declarations) and the newest sequence the declaring pass dropped. */
  dropped_oldest_seq?: number;
  dropped_newest_seq?: number;
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
      /** Set when retained drop records cover the whole missing range: the hole is retention,
       *  not an unexplained loss. `dropped_oldest_seq`/`dropped_newest_seq` name that range. */
      reason?: 'retention';
      dropped_oldest_seq?: number;
      dropped_newest_seq?: number;
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

/** The retention window a pass applies: the age a segment is kept after its last write, and the
 *  most the retained files together may hold. Both default to the shipping values. */
export type EventLogRetention = {
  maxTotalBytes?: number;
  retentionSeconds?: number;
};

function sizeOfFile(path: string): number {
  if (heldAt(path).kind !== 'file') return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** When the file was last written, or null when it is not a regular file this user owns. */
function writtenAtFile(path: string): number | null {
  if (heldAt(path).kind !== 'file') return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** One segment a pass dropped, with the verified sequence range it held (null when the segment
 *  held no verified record), the oldest sequence any drop record inside it had already declared,
 *  and the bounds that dropped it. */
type DroppedSegment = {
  name: string;
  bytes: number;
  oldestSeq: number | null;
  newestSeq: number | null;
  declaredOldest: number | null;
  bounds: ('age' | 'rotation' | 'total')[];
};

/** The verified sequence range of a signed log file, and the oldest sequence its drop records
 *  already declare. A segment is read this way before it is unlinked, so the drop can name the
 *  range it removes and carry forward a declaration it is about to remove. Null when the file
 *  cannot be read or holds no verified record. */
function verifiedRangeOf(
  path: string,
  home: string,
): { oldest: number; newest: number; declaredOldest: number | null } | null {
  const keyState = messageKeyState(home);
  if (keyState.kind !== 'key') return null;
  const text = readNoFollow(path);
  if (text === null) return null;
  let oldest: number | null = null;
  let newest: number | null = null;
  let declaredOldest: number | null = null;
  for (const rawLine of text.split('\n')) {
    if (rawLine.trim() === '') continue;
    const parsed = parseSignedEventLine(rawLine);
    if (parsed === null) continue;
    if (!verifyDomain(EVENT_DOMAIN, parsed.payload as unknown as Json, parsed.signature, keyState.key)) {
      continue;
    }
    const seq = parsed.payload.seq;
    oldest = oldest === null ? seq : Math.min(oldest, seq);
    newest = newest === null ? seq : Math.max(newest, seq);
    const declared = parsed.payload.dropped_oldest_seq;
    if (parsed.payload.kind === 'team.event-log-dropped' && declared !== undefined) {
      declaredOldest = declaredOldest === null ? declared : Math.min(declaredOldest, declared);
    }
  }
  return oldest === null || newest === null ? null : { oldest, newest, declaredOldest };
}

/** The oldest sealed slot a rotation is about to unlink, captured before the rotation drops it. */
function captureOldestSlot(
  path: string,
  kept: number,
  home: string,
  cause: 'age' | 'rotation',
): DroppedSegment | null {
  const name = `${EVENT_LOG_FILE}.${String(kept - 1)}`;
  const slot = `${path}.${String(kept - 1)}`;
  if (heldAt(slot).kind !== 'file') return null;
  const range = verifiedRangeOf(slot, home);
  return {
    name,
    bytes: sizeOfFile(slot),
    oldestSeq: range?.oldest ?? null,
    newestSeq: range?.newest ?? null,
    declaredOldest: range?.declaredOldest ?? null,
    bounds: [cause],
  };
}

/** Seals the live file when its last write is older than the window: every record it holds was
 *  written before the window too, so the prune that follows may drop it as one segment. Returns
 *  the oldest sealed slot the rotation dropped, if any. */
function sealIdleLiveFile(path: string, home: string, kept: number, cutoffMs: number): DroppedSegment | null {
  const writtenAt = writtenAtFile(path);
  if (writtenAt === null || writtenAt >= cutoffMs || sizeOfFile(path) === 0) return null;
  const dropped = captureOldestSlot(path, kept, home, 'age');
  const problem = rotateEventLog(path, kept);
  if (problem !== null) throw new Error(problem);
  return dropped;
}

/** Drops the oldest sealed segment while the retained bytes are over the cap or the segment was
 *  last written before the window, oldest first. The live file is kept: it holds the newest
 *  records and the next append. A dropped file is unlinked whole and a surviving one is never
 *  rewritten, so every record still read is byte for byte the one that was verified. */
function pruneSealed(path: string, home: string, kept: number, options: EventLogRetention): DroppedSegment[] {
  const retentionSeconds = options.retentionSeconds ?? DEFAULT_EVENT_RETENTION_SECONDS;
  const maxTotal = options.maxTotalBytes ?? EVENT_LOG_TOTAL_BYTES;
  const cutoff = Date.now() - retentionSeconds * 1_000;
  const sealed: { name: string; path: string; size: number; writtenAt: number }[] = [];
  let total = sizeOfFile(path);
  for (let n = kept - 1; n >= 1; n--) {
    const candidate = `${path}.${String(n)}`;
    const writtenAt = writtenAtFile(candidate);
    if (writtenAt === null) continue;
    const size = sizeOfFile(candidate);
    sealed.push({ name: `${EVENT_LOG_FILE}.${String(n)}`, path: candidate, size, writtenAt });
    total += size;
  }
  const dropped: DroppedSegment[] = [];
  for (const segment of sealed) {
    const overCap = total > maxTotal;
    const tooOld = segment.writtenAt < cutoff;
    if (!overCap && !tooOld) break;
    const range = verifiedRangeOf(segment.path, home);
    try {
      unlinkSync(segment.path);
    } catch {
      break;
    }
    total -= segment.size;
    const bounds: DroppedSegment['bounds'] = [];
    if (overCap) bounds.push('total');
    if (tooOld) bounds.push('age');
    dropped.push({
      name: segment.name,
      bytes: segment.size,
      oldestSeq: range?.oldest ?? null,
      newestSeq: range?.newest ?? null,
      declaredOldest: range?.declaredOldest ?? null,
      bounds,
    });
  }
  return dropped;
}

/** One operational record per dropping pass. The `.agents/team.log` line names every segment the
 *  pass dropped; a signed `team.event-log-dropped` event appended to the live log names the
 *  dropped sequence range — its newest sequence is this pass's, its oldest carries forward the
 *  oldest sequence retention has dropped — and whether the age window or a size bound dropped it,
 *  so a reader, the reconcile pass and a gap-resync see a declared drop rather than an unexplained
 *  hole. The event is appended after the drop with no retention of its own, so it cannot recurse.
 *  Best effort: retention never fails the caller. */
function declareDrop(
  project: string,
  root: string,
  home: string,
  kept: number,
  options: EventLogRetention & { maxBytes?: number },
  drops: DroppedSegment[],
  session: string,
): void {
  if (drops.length === 0) return;
  const retentionSeconds = options.retentionSeconds ?? DEFAULT_EVENT_RETENTION_SECONDS;
  const maxTotal = options.maxTotalBytes ?? EVENT_LOG_TOTAL_BYTES;
  const maxBytes = options.maxBytes ?? MAX_EVENT_LOG_BYTES;
  const bytes = drops.reduce((sum, drop) => sum + drop.bytes, 0);
  const bounds: string[] = [];
  if (drops.some((drop) => drop.bounds.includes('rotation'))) bounds.push(`${String(maxBytes)} bytes`);
  if (drops.some((drop) => drop.bounds.includes('total'))) bounds.push(`${String(maxTotal)} bytes`);
  if (drops.some((drop) => drop.bounds.includes('age'))) bounds.push(`${String(retentionSeconds)}s old`);
  logLine(
    join(root, '.agents'),
    'bus',
    'event-log',
    `retention dropped ${drops.map((drop) => drop.name).join(', ')} (${String(bytes)} bytes; past ${bounds.join(' or ')})`,
  );

  const named = drops.filter(
    (drop): drop is DroppedSegment & { oldestSeq: number; newestSeq: number } =>
      drop.oldestSeq !== null && drop.newestSeq !== null,
  );
  if (named.length === 0) return;
  const newest = Math.max(...named.map((drop) => drop.newestSeq));
  const byAge = drops.some((drop) => drop.bounds.includes('age'));
  const bySize = drops.some((drop) => drop.bounds.includes('rotation') || drop.bounds.includes('total'));
  const reason = byAge && bySize ? 'age or size' : byAge ? 'age' : 'size';
  const indexed = appendIndexOf(project, root, home, kept);
  const retainedNewest = indexed.ok ? indexed.index.newestSeq : null;
  // The declared floor is the oldest sequence retention has dropped, carried forward from the
  // declaration records still retained and from those inside the segments this pass removes.
  // Without it, a size-capped log would drop each declaration with the segment that held it and
  // the older holes would look undeclared.
  let floor: number | null = null;
  const lower = (value: number | null): void => {
    if (value === null) return;
    floor = floor === null ? value : Math.min(floor, value);
  };
  for (const drop of drops) {
    lower(drop.oldestSeq);
    lower(drop.declaredOldest);
  }
  if (indexed.ok) {
    for (const record of indexed.index.duplicates.values()) {
      if (record.payload.kind !== 'team.event-log-dropped') continue;
      lower(record.payload.dropped_oldest_seq ?? null);
    }
  }
  if (floor === null) return;
  const oldest: number = floor;
  appendEvent(
    project,
    root,
    home,
    {
      ts: new Date().toISOString(),
      kind: 'team.event-log-dropped',
      session,
      record_id: `retention:${String(oldest)}-${String(newest)}`,
      reason,
      dropped_oldest_seq: oldest,
      dropped_newest_seq: newest,
    },
    {
      kept,
      deduplicate: true,
      retain: false,
      ...(retainedNewest === null ? { seqOverride: newest + 1 } : {}),
    },
  );
}

/** Applies the retention window without appending: an idle live file is sealed, then the oldest
 *  sealed segments are dropped while the log is over the cap or a segment is past the age window.
 *  The bus calls this at start, so a team that comes back after an idle month drops its old
 *  segments before its first event; the pass leaves one signed drop record naming what it
 *  dropped. Best effort: retention never fails the caller. */
export function pruneEventLog(
  project: string,
  root: string,
  home: string,
  options: EventLogRetention & { kept?: number; session?: string } = {},
): void {
  try {
    const kept = options.kept ?? EVENT_LOG_KEPT;
    const retentionSeconds = options.retentionSeconds ?? DEFAULT_EVENT_RETENTION_SECONDS;
    const path = eventLogPath(project, root, home);
    const drops: DroppedSegment[] = [];
    const sealed = sealIdleLiveFile(path, home, kept, Date.now() - retentionSeconds * 1_000);
    if (sealed !== null) drops.push(sealed);
    drops.push(...pruneSealed(path, home, kept, options));
    declareDrop(project, root, home, kept, options, drops, options.session ?? project);
  } catch {
    // Dropped on purpose: reads and writes are unaffected by retention failing.
  }
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

const OPTIONAL_SEQUENCE_FIELDS = ['dropped_oldest_seq', 'dropped_newest_seq'] as const;

const ALLOWED_PAYLOAD_KEYS = new Set<string>([
  'v',
  'seq',
  'ts',
  'kind',
  'session',
  'record_id',
  ...OPTIONAL_STRING_FIELDS,
  ...OPTIONAL_SEQUENCE_FIELDS,
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
  for (const field of OPTIONAL_SEQUENCE_FIELDS) {
    if (field in obj && obj[field] !== undefined) {
      const value = obj[field];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
      payload[field] = value;
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

/** Whether the retained `team.event-log-dropped` records cover every sequence in `from`..`to`.
 *  Ranges may abut and overlap; together they must reach the whole missing window. */
function declaredDropCovers(events: SignedEventRecord[], from: number, to: number): boolean {
  const ranges: [number, number][] = [];
  for (const { payload } of events) {
    if (payload.kind !== 'team.event-log-dropped') continue;
    if (payload.dropped_oldest_seq === undefined || payload.dropped_newest_seq === undefined) continue;
    ranges.push([payload.dropped_oldest_seq, payload.dropped_newest_seq]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let reach = from - 1;
  for (const [start, end] of ranges) {
    if (start > reach + 1) break;
    if (end > reach) reach = end;
    if (reach >= to) return true;
  }
  return false;
}

/** Reads events after `cursor` (`seq > cursor`). When the records between the cursor and the
 *  oldest retained event are missing (`cursor + 1 < oldestSeq`), returns `{ kind: 'gap' }` so the
 *  subscriber resyncs from the durable records before following on (Amendment 01 §4.2). When
 *  retained drop records declare that whole window, the gap carries `reason: 'retention'` and the
 *  dropped range; an undeclared hole carries neither. */
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
  if (cursor > 0 && oldestSeq !== null && cursor + 1 < oldestSeq) {
    const droppedOldest = cursor + 1;
    const droppedNewest = oldestSeq - 1;
    return {
      ok: true,
      kind: 'gap',
      oldest_seq: oldestSeq,
      newest_seq: newestSeq ?? oldestSeq,
      ...(declaredDropCovers(events, droppedOldest, droppedNewest)
        ? { reason: 'retention' as const, dropped_oldest_seq: droppedOldest, dropped_newest_seq: droppedNewest }
        : {}),
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
  options: {
    maxBytes?: number;
    kept?: number;
    deduplicate?: boolean;
    seqOverride?: number;
    maxTotalBytes?: number;
    retentionSeconds?: number;
    /** When false the append performs no retention of its own: the drop record written by a
     *  dropping pass uses this so declaring a drop cannot drop again. */
    retain?: boolean;
  } = {},
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
  for (const field of OPTIONAL_SEQUENCE_FIELDS) {
    if (input[field] !== undefined) {
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
  const retain = options.retain ?? true;
  const drops: DroppedSegment[] = [];

  try {
    if (retain) {
      // An idle live file is sealed first, so the append starts a new segment and the records the
      // old one holds are dropped by the prune below as one past-the-window segment.
      try {
        const retentionSeconds = options.retentionSeconds ?? DEFAULT_EVENT_RETENTION_SECONDS;
        const sealed = sealIdleLiveFile(path, home, kept, Date.now() - retentionSeconds * 1_000);
        if (sealed !== null) drops.push(sealed);
      } catch {
        // Retention never fails an append: the write below carries on.
      }
      const current = heldAt(path);
      if (current.kind === 'file') {
        const size = statSync(path).size;
        if (size > 0 && size + bytes.length > maxBytes) {
          const captured = captureOldestSlot(path, kept, home, 'rotation');
          const rotateErr = rotateEventLog(path, kept);
          if (rotateErr !== null) return { ok: false, reason: rotateErr };
          if (captured !== null) drops.push(captured);
        }
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
    if (retain) {
      try {
        drops.push(...pruneSealed(path, home, kept, options));
      } catch {
        // Retention never fails an append: the record is written either way.
      }
      try {
        declareDrop(project, root, home, kept, { ...options, maxBytes }, drops, input.session);
      } catch {
        // Retention never fails an append: the record is written either way.
      }
    }
    return { ok: true, record, duplicate: false, path };
  } catch {
    if (drops.length > 0) {
      try {
        declareDrop(project, root, home, kept, { ...options, maxBytes }, drops, input.session);
      } catch {
        // The append already failed; the declaration is best effort too.
      }
    }
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
