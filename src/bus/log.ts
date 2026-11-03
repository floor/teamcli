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
import { createHash, type KeyObject } from 'node:crypto';
import { dirname, join } from 'node:path';
import { heldAt } from '../launch/rules-file.ts';
import { logLine } from '../log.ts';
import { ensureStoreLadder, readNoFollow } from '../send/history.ts';
import { LockBusyError, withLock, writeAtomic } from '../state.ts';
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
  /** On `config.changed`: the key and the level the signed record was written at. */
  config_key?: string;
  config_level?: string;
  /** The value before and after, in words (an order as its legs). An unset carries the old value
   *  only; a change the reconcile pass appends carries the new one only, because the record holds
   *  no history. */
  config_old?: string;
  config_new?: string;
  /** On `presence.changed`: one applied, current-runtime-binding transition from a seat's
   *  presence log. The four presence words and the event that establishes them are carried
   *  exactly; `presence_seq` is the per-seat presence log's own sequence and `presence_event_id`
   *  is that log's record id, so the bus record's identity is reproducible on a replay. */
  presence_state?: string;
  presence_event?: string;
  presence_source?: string;
  presence_binding?: string;
  presence_event_id?: string;
  presence_observed_at?: string;
  presence_seq?: number;
  /** On a message step (`message.staged`, `webhook.posted`, `leg.tried`, `wake.retried`): the
   *  step's own machine word — the walk's (`delivered`, `refused`, `unreachable`, `held`,
   *  `timeout`) or the webhook post's (`posted`, `failed`, `unknown`) — never free text. A reader
   *  that does not know the word still prints it; nothing routes on it. */
  outcome?: string;
  /** On a message step: milliseconds the step itself took, measured by the writer. Zero is a real
   *  measurement (a refusal decided before anything was dialed), so it is kept apart from the
   *  sequence fields, which start at one. */
  ms?: number;
  /** On a `config.changed` the reconcile pass appended for a signed record it found without one:
   *  `true`, so a reader can tell an event raised at write time from one raised after a crash. */
  reconciled?: string;
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
  /** `busy` marks the one failure that is worth retrying: another process held the event lock
   *  for the whole wait, so the record was never looked at. */
  | { ok: false; reason: string; busy?: true };

export type EventReadResult =
  | {
      ok: true;
      events: SignedEventRecord[];
      unverified: number;
      /** The signatures this read checked. A read that extended a matching checkpoint checks only
       *  the records after its last verified sequence; a full read checks every record. */
      checked: number;
      /** Whether this read verified the whole retained log, because no checkpoint was kept for it
       *  or the checkpoint did not match the retained bytes (a trim, a rewrite, another key). */
      full: boolean;
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
      checked: number;
      full: boolean;
      /** Lines read alongside the verified events whose signature did not verify. They are
       *  skipped, never returned, and this count is the reader's honest disclosure of them. */
      unverified: number;
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
  const indexed = appendIndexOf(project, root, home, kept, 'all');
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
    const storeDir = storePath(project, root, home);
    if (ensureStoreLadder(storeDir, home) !== null) return;
    // The whole pass holds the append lock: its rotation and drops move the retained files the
    // append scans, and its declaration precomputes a sequence override before appending. A
    // writer that slipped between those two steps could mint that same sequence.
    withEventLock(storeDir, () => {
      const path = eventLogPath(project, root, home);
      const drops: DroppedSegment[] = [];
      const sealed = sealIdleLiveFile(path, home, kept, Date.now() - retentionSeconds * 1_000);
      if (sealed !== null) drops.push(sealed);
      drops.push(...pruneSealed(path, home, kept, options));
      declareDrop(project, root, home, kept, options, drops, options.session ?? project);
    });
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
  'config_key',
  'config_level',
  'config_old',
  'config_new',
  'reconciled',
  'outcome',
  'presence_state',
  'presence_event',
  'presence_source',
  'presence_binding',
  'presence_event_id',
  'presence_observed_at',
] as const;

const OPTIONAL_SEQUENCE_FIELDS = ['dropped_oldest_seq', 'dropped_newest_seq', 'presence_seq'] as const;

/** Measured quantities carry a zero legitimately: an attempt refused before it dialed took no
 *  time. They are not sequences, and the one-based check above would refuse the honest value. */
const OPTIONAL_MEASURE_FIELDS = ['ms'] as const;

/** The shape every event's `record_id` must have: a generated token — a UUID, a digest, or a
 *  colon-joined name — never free text. The append index searches a retained line for the id as a
 *  literal substring before parsing it (`findVerifiedRecord`), which is sound only while
 *  `JSON.stringify` leaves every character of the id unescaped: an id holding a quote or a
 *  backslash would spell differently in the serialized line, and the search could miss the very
 *  record the append is a duplicate of. Parse refuses an id outside this charset for that reason,
 *  so the lemma is enforced where a payload enters, not assumed where a line is searched. */
export const EVENT_RECORD_ID = /^[A-Za-z0-9:._-]{1,200}$/;

const ALLOWED_PAYLOAD_KEYS = new Set<string>([
  'v',
  'seq',
  'ts',
  'kind',
  'session',
  'record_id',
  ...OPTIONAL_STRING_FIELDS,
  ...OPTIONAL_SEQUENCE_FIELDS,
  ...OPTIONAL_MEASURE_FIELDS,
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
  if (typeof obj.record_id !== 'string' || !EVENT_RECORD_ID.test(obj.record_id)) return null;

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
  for (const field of OPTIONAL_MEASURE_FIELDS) {
    if (field in obj && obj[field] !== undefined) {
      const value = obj[field];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
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

/** The verification checkpoint kept for one retained log: the highest sequence this process
 *  verified, a SHA-256 over the raw lines of every retained record at or below it, and the verified
 *  records themselves. Reconcile passes and subscriptions reuse it instead of checking signatures
 *  they have already checked. The digest is what makes that safe: the bytes it covers are the ones
 *  the checkpoint was built from, so a trim, a rewrite, a deleted record, or one altered in place
 *  changes it, and the read that sees the change verifies the whole log again. */
type ReadCheckpoint = {
  keyPrint: string;
  seq: number;
  digest: string;
  events: SignedEventRecord[];
};

const readCheckpoints = new Map<string, ReadCheckpoint>();

type RetainedLine = { raw: string; parsed: SignedEventRecord | null };

/** SHA-256 over the raw lines of every record at or below `upTo`, in retained order. File
 *  boundaries are not part of the digest: a rotation that keeps every byte keeps the digest, while
 *  a segment dropped or a file rewritten changes it. */
function prefixDigest(lines: RetainedLine[], upTo: number): string {
  const hash = createHash('sha256');
  for (const line of lines) {
    if (line.parsed === null || line.parsed.payload.seq > upTo) continue;
    hash.update(line.raw, 'utf8');
    hash.update('\n', 'utf8');
  }
  return hash.digest('hex');
}

/** The verification checkpoint as it survives its process: the same key print and prefix digest
 *  for a fixed retained-file count and one store, signed under the message key, written beside the
 *  log by a read that verified every retained record. A later process verifies only the records
 *  past `seq`; the signature over every field and the digest over the retained bytes are both
 *  checked first, so a recomputed digest, a rewritten field, a trim, a dropped segment, another
 *  key, or another store is a miss and that read verifies in full.
 *
 *  It is trusted local state: the signature is an integrity control against a mistaken agent, not
 *  containment against a hostile same-user process — a reader of the message key is outside that
 *  model (docs/internal/events.md §6). A stale or mismatching checkpoint is only ever a miss, and
 *  the record is never trusted for anything a full verify would decide. */
const VERIFY_CHECKPOINT_FILE = 'verify-checkpoint.json';
const VERIFY_CHECKPOINT_FORMAT = 1;
/** Its own domain, so a checkpoint signature can never be read as an event signature or the
 *  reverse, even though both use the message key. */
const CHECKPOINT_DOMAIN = 'teamcli bus verify-checkpoint v1\n';

type CheckpointFields = {
  format: number;
  keyPrint: string;
  kept: number;
  seq: number;
  digest: string;
  store: string;
};

type StoredCheckpoint = CheckpointFields & { signature: string };

/** The fields the signature covers, built the same way when the file is written and when it is
 *  read, so no field — not the key print, the retained count, the sequence, the digest, or the
 *  store the checkpoint describes — can be changed without the message key. */
function checkpointPayload(fields: CheckpointFields): Json {
  return {
    format: fields.format,
    keyPrint: fields.keyPrint,
    kept: fields.kept,
    seq: fields.seq,
    digest: fields.digest,
    store: fields.store,
  };
}

/** The stored checkpoint, or null when there is none, it is not the shape this build wrote, or its
 *  signature does not verify under the message key. Read without following a link; with no key
 *  there is no trust to extend. A partial, unparsable, foreign, or altered file is a miss, never a
 *  guess: the caller still compares the key print, the retained count, and the store the file
 *  names against the read it is serving. */
function readStoredCheckpoint(storeDir: string, keyState: ReturnType<typeof messageKeyState>): StoredCheckpoint | null {
  if (keyState.kind !== 'key') return null;
  const text = readNoFollow(join(storeDir, VERIFY_CHECKPOINT_FILE));
  if (text === null || text === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Partial<StoredCheckpoint>;
  if (record.format !== VERIFY_CHECKPOINT_FORMAT) return null;
  if (typeof record.keyPrint !== 'string') return null;
  if (typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest)) return null;
  if (typeof record.kept !== 'number' || !Number.isInteger(record.kept) || record.kept < 1) return null;
  if (typeof record.seq !== 'number' || !Number.isInteger(record.seq) || record.seq < 1) return null;
  if (typeof record.store !== 'string' || record.store === '') return null;
  if (typeof record.signature !== 'string') return null;
  const fields: CheckpointFields = {
    format: VERIFY_CHECKPOINT_FORMAT,
    keyPrint: record.keyPrint,
    kept: record.kept,
    seq: record.seq,
    digest: record.digest,
    store: record.store,
  };
  if (!verifyDomain(CHECKPOINT_DOMAIN, checkpointPayload(fields), record.signature, keyState.key)) return null;
  return { ...fields, signature: record.signature };
}

/** Writes the checkpoint beside the log, signed under the message key, atomically and best
 *  effort: it only saves work on the next read, so a store that cannot take it keeps verifying in
 *  full instead of failing. */
function writeStoredCheckpoint(storeDir: string, fields: CheckpointFields, key: KeyObject): void {
  try {
    const signature = signDomain(CHECKPOINT_DOMAIN, checkpointPayload(fields), key);
    writeAtomic(join(storeDir, VERIFY_CHECKPOINT_FILE), `${JSON.stringify({ ...fields, signature })}\n`);
  } catch {
    // The log is intact without it.
  }
}

/** Reads all retained event log files (`events.jsonl.2`, `.1`, `events.jsonl`) in sequence order,
 *  verifying each record's signature against the checkout's message key. Unverified or malformed
 *  lines are counted in `unverified` and never returned as events.
 *
 *  Verification is incremental: the retained lines at or below a checkpoint's last verified
 *  sequence are pinned by its digest, and only the records after it are checked against the key.
 *  The process keeps its checkpoint in memory; a process that has none reads the one written
 *  beside the log, signed under the message key, and only a read that verified every retained
 *  record writes that file. When the log has no checkpoint, the key changed, the signature does
 *  not verify, or the digest does not match the retained bytes, the whole log is verified
 *  (`full: true`) and the checkpoint is rebuilt. */
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

  const lines: RetainedLine[] = [];
  for (const candidate of files) {
    const problem = fileProblem(candidate);
    if (problem !== null) return { ok: false, reason: problem };
    if (heldAt(candidate).kind === 'missing') continue;
    const text = readNoFollow(candidate);
    if (text === null) return { ok: false, reason: 'the event log could not be read' };
    for (const rawLine of text.split('\n')) {
      if (rawLine.trim() === '') continue;
      lines.push({ raw: rawLine, parsed: parseSignedEventLine(rawLine) });
    }
  }

  const keyState = messageKeyState(home);
  const keyPrint = keyPrintOf(home);
  const cacheKey = `${storeDir}\u0000${String(kept)}`;
  const checkpoint = readCheckpoints.get(cacheKey);

  const verifyAll = (): { events: SignedEventRecord[]; unverified: number; checked: number } => {
    const verified: SignedEventRecord[] = [];
    let unverified = 0;
    let checked = 0;
    for (const line of lines) {
      if (line.parsed === null) {
        unverified += 1;
        continue;
      }
      checked += 1;
      if (keyState.kind !== 'key' || !verifyDomain(EVENT_DOMAIN, line.parsed.payload as unknown as Json, line.parsed.signature, keyState.key)) {
        unverified += 1;
        continue;
      }
      verified.push(line.parsed);
    }
    return { events: verified, unverified, checked };
  };

  let events: SignedEventRecord[];
  let unverified: number;
  let checked: number;
  let full = true;
  const stored = readStoredCheckpoint(storeDir, keyState);
  const matched =
    checkpoint !== undefined &&
    checkpoint.keyPrint === keyPrint &&
    prefixDigest(lines, checkpoint.seq) === checkpoint.digest;
  if (matched && checkpoint !== undefined) {
    // Every retained record at or below the checkpoint's sequence is byte for byte the one it was
    // verified as; only the records past it are checked now. A parsed record at or below the
    // sequence that the checkpoint does not hold was unverified when it was built, and the bytes
    // have not changed since, so it is still unverified.
    full = false;
    events = checkpoint.events.slice();
    unverified = 0;
    checked = 0;
    let prefixParsed = 0;
    for (const line of lines) {
      if (line.parsed === null) {
        unverified += 1;
        continue;
      }
      if (line.parsed.payload.seq <= checkpoint.seq) {
        prefixParsed += 1;
        continue;
      }
      checked += 1;
      if (keyState.kind !== 'key' || !verifyDomain(EVENT_DOMAIN, line.parsed.payload as unknown as Json, line.parsed.signature, keyState.key)) {
        unverified += 1;
        continue;
      }
      events.push(line.parsed);
    }
    unverified += prefixParsed - checkpoint.events.length;
  } else if (
    stored !== null &&
    keyState.kind === 'key' &&
    stored.keyPrint === keyPrint &&
    stored.kept === kept &&
    stored.store === storeDir &&
    prefixDigest(lines, stored.seq) === stored.digest
  ) {
    // Another process verified every retained record at or below this sequence on bytes that
    // still hash to its digest, and it writes the file only when that read left nothing
    // unverified, so the whole prefix is one verified block. The file's signature verified under
    // the same key print this read holds, so no field and no byte it covers was altered by a
    // writer without the key. Only the records past it are checked against the key now; a parsed
    // record inside the prefix is returned, because none of them were unverified when the file
    // was written.
    full = false;
    events = [];
    unverified = 0;
    checked = 0;
    for (const line of lines) {
      if (line.parsed === null) {
        unverified += 1;
        continue;
      }
      if (line.parsed.payload.seq <= stored.seq) {
        events.push(line.parsed);
        continue;
      }
      checked += 1;
      if (!verifyDomain(EVENT_DOMAIN, line.parsed.payload as unknown as Json, line.parsed.signature, keyState.key)) {
        unverified += 1;
        continue;
      }
      events.push(line.parsed);
    }
  } else {
    ({ events, unverified, checked } = verifyAll());
  }

  const highest = events.reduce((max, event) => Math.max(max, event.payload.seq), 0);
  const digest = prefixDigest(lines, highest);
  readCheckpoints.set(cacheKey, { keyPrint, seq: highest, digest, events: events.slice() });

  // What this read verified is what the next process may lean on. A checkpoint cannot record which
  // prefix records were unverified, so the file is written only when this read left none; a real
  // key is required for any of it to mean anything; and an empty log has nothing to cover. An
  // unchanged checkpoint is left as it is, so a quiet read does not rewrite the file.
  if (
    unverified === 0 &&
    keyState.kind === 'key' &&
    highest >= 1 &&
    (stored === null || stored.seq !== highest || stored.digest !== digest)
  ) {
    writeStoredCheckpoint(
      storeDir,
      { format: VERIFY_CHECKPOINT_FORMAT, keyPrint, kept, seq: highest, digest, store: storeDir },
      keyState.key,
    );
  }

  const oldestSeq = events.length > 0 ? events[0]!.payload.seq : null;
  const newestSeq = events.length > 0 ? events[events.length - 1]!.payload.seq : null;
  return { ok: true, events, unverified, checked, full, oldestSeq, newestSeq, path };
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
    checked: read.checked,
    full: read.full,
    unverified: read.unverified,
  };
}

/** One retained log file as the append index last saw it: identity and size, so an unchanged file
 *  is not read again and a file that only grew is read from where the index stopped. */
type LogFileStamp = { ino: number; size: number; mtimeMs: number };

/** One append's dedupe key and the id a line would spell to hold it. */
type WantedKey = { key: string; recordId: string };

/** What an append asks the index for: one key (an ordinary append), every key (`declareDrop`
 *  carries the declared segment floor forward from all retained drop records), or nothing (an
 *  append that does not deduplicate and needs only the newest sequence). */
type IndexRequest = WantedKey | 'all' | null;

type AppendIndex = {
  keyPrint: string;
  files: (LogFileStamp | null)[];
  /** The first verified record for each `(kind, record_id, session)` this process has searched
   *  the retained log for, in retained order. A key the map does not hold is absent from the
   *  retained log only when `covered` vouches for the search. */
  duplicates: Map<string, SignedEventRecord>;
  /** Keys whose presence or absence in the retained log this index has established. */
  covered: Set<string>;
  /** Every possible key is covered: the whole retained log was verified. */
  coveredAll: boolean;
  newestSeq: number | null;
  path: string;
};

const appendIndexes = new Map<string, AppendIndex>();

/** The append locks this process holds, by lock directory. Append is synchronous, so a set is
 *  the whole reentrancy state: the nested drop declaration's append runs under the lock its
 *  caller already holds instead of waiting on itself. */
const heldEventLocks = new Set<string>();

/** Runs `work` under the store's event lock. A call made while this process already holds the
 *  lock — the drop declaration's append, from inside an append or from the prune pass — runs
 *  directly under the lock its caller holds. */
function withEventLock<T>(storeDir: string, work: () => T, lockWaitMs?: number): T {
  const lockDir = join(storeDir, 'locks', 'events');
  if (heldEventLocks.has(lockDir)) return work();
  return withLock(
    lockDir,
    () => {
      heldEventLocks.add(lockDir);
      try {
        return work();
      } finally {
        heldEventLocks.delete(lockDir);
      }
    },
    lockWaitMs === undefined ? {} : { waitMs: lockWaitMs },
  );
}

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
 *  `readEvents`. Every key it verifies is added to `covered`. */
function verifyInto(
  text: string,
  keyState: ReturnType<typeof messageKeyState>,
  into: Map<string, SignedEventRecord>,
  covered?: Set<string>,
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
    covered?.add(key);
  }
  return out;
}

/** The last record in one stretch of the log that verifies: the walk starts at the end and stops
 *  at the first verified line, so the newest sequence costs one verification per file instead of
 *  one per record. Null when the stretch holds no verified record, and the caller then looks at
 *  an older file exactly as a full scan would. */
function lastVerifiedRecord(
  lines: string[],
  keyState: ReturnType<typeof messageKeyState>,
): SignedEventRecord | null {
  if (keyState.kind !== 'key') return null;
  for (let at = lines.length - 1; at >= 0; at--) {
    const raw = lines[at]!;
    if (raw.trim() === '') continue;
    const parsed = parseSignedEventLine(raw);
    if (parsed === null) continue;
    if (verifyDomain(EVENT_DOMAIN, parsed.payload as unknown as Json, parsed.signature, keyState.key)) {
      return parsed;
    }
  }
  return null;
}

/** The first record in one stretch of the log that verifies under `wanted.key`. Only a line that
 *  spells the wanted id literally is parsed: every id this log admits is a generated token
 *  (`EVENT_RECORD_ID`, enforced by `parseEventPayload`), so `JSON.stringify` escapes none of its
 *  characters and a line this code wrote for that id always holds it as a substring. A matching
 *  line that does not verify is skipped, exactly as the full scan skips it. */
function findVerifiedRecord(
  lines: string[],
  wanted: WantedKey,
  keyState: ReturnType<typeof messageKeyState>,
): SignedEventRecord | null {
  if (keyState.kind !== 'key') return null;
  for (const raw of lines) {
    if (raw === '' || !raw.includes(wanted.recordId)) continue;
    const parsed = parseSignedEventLine(raw);
    if (parsed === null) continue;
    if (eventKey(parsed.payload) !== wanted.key) continue;
    if (!verifyDomain(EVENT_DOMAIN, parsed.payload as unknown as Json, parsed.signature, keyState.key)) continue;
    return parsed;
  }
  return null;
}

/** What `appendEvent` needs from the retained log, kept across appends: the first verified record
 *  for the key this append is about to write, and the last verified sequence. The first look reads
 *  each retained file once and verifies only the lines that can answer that key — plus the newest
 *  line of each file, for the sequence — so a fresh process appends to a log of any retained size
 *  without re-verifying every record it kept. Each later look reads only the bytes appended to
 *  `events.jsonl` since the last one, so a growing session costs O(bytes). A key this process has
 *  not searched for is searched when it is first appended; a caller that needs every key (the
 *  retention declaration) asks for the whole map and verifies everything once. A rotated or
 *  rewritten file — or a changed key — falls back to a fresh scan. */
function appendIndexOf(
  project: string,
  root: string,
  home: string,
  kept: number,
  request: IndexRequest,
): { ok: true; index: AppendIndex } | { ok: false; reason: string } {
  const wantedKey = request !== null && typeof request === 'object' ? request : null;
  const wantAll = request === 'all';
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
  const answers = (index: AppendIndex): boolean =>
    wantedKey !== null ? index.coveredAll || index.covered.has(wantedKey.key) : !wantAll || index.coveredAll;
  const sameFiles =
    cached !== undefined &&
    cached.keyPrint === keyPrint &&
    cached.files.length === stamps.length &&
    cached.files.every((stamp, at) => sameStamp(stamp, stamps[at] ?? null));
  if (cached !== undefined && sameFiles) {
    if (answers(cached)) return { ok: true, index: cached };
    if (wantedKey !== null) return extendIndex(cached, files, wantedKey, keyState);
    // A whole-key map is wanted and this index knows one key: the full scan below answers it.
  }

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
      const fresh = verifyInto(tail, keyState, cached.duplicates, cached.covered);
      if (fresh.length > 0) cached.newestSeq = fresh[fresh.length - 1]!.payload.seq;
      cached.files[last] = fileStamp(path) ?? stamps[last] ?? null;
      if (answers(cached)) return { ok: true, index: cached };
      if (wantedKey !== null) return extendIndex(cached, files, wantedKey, keyState);
    }
  }

  // No index this process can use. A whole-key map reads and verifies every retained line; the
  // ordinary request reads each file once and verifies the newest line of each (for the sequence)
  // and the lines that can hold the wanted record, and nothing else.
  const index: AppendIndex = {
    keyPrint,
    files: stamps,
    duplicates: new Map(),
    covered: new Set(),
    coveredAll: wantAll,
    newestSeq: null,
    path,
  };
  for (const candidate of files) {
    if (heldAt(candidate).kind === 'missing') continue;
    const text = readNoFollow(candidate);
    if (text === null) return { ok: false, reason: 'the event log could not be read' };
    if (wantAll) {
      const verified = verifyInto(text, keyState, index.duplicates, index.covered);
      if (verified.length > 0) index.newestSeq = verified[verified.length - 1]!.payload.seq;
      continue;
    }
    const lines = text.split('\n');
    const newest = lastVerifiedRecord(lines, keyState);
    if (newest !== null) index.newestSeq = newest.payload.seq;
    if (wantedKey !== null && !index.duplicates.has(wantedKey.key)) {
      const found = findVerifiedRecord(lines, wantedKey, keyState);
      if (found !== null) index.duplicates.set(wantedKey.key, found);
    }
  }
  if (wantedKey !== null) index.covered.add(wantedKey.key);
  appendIndexes.set(cacheKey, index);
  return { ok: true, index };
}

/** Answers an index for a key this process has not searched for yet: one pass over the retained
 *  files, verifying only the lines that can hold it. The newest sequence stays as the index has
 *  it: the caller already matched the file stamps this pass reads, under the event lock. */
function extendIndex(
  index: AppendIndex,
  files: string[],
  wanted: WantedKey,
  keyState: ReturnType<typeof messageKeyState>,
): { ok: true; index: AppendIndex } | { ok: false; reason: string } {
  for (const candidate of files) {
    if (heldAt(candidate).kind === 'missing') continue;
    const text = readNoFollow(candidate);
    if (text === null) return { ok: false, reason: 'the event log could not be read' };
    const found = findVerifiedRecord(text.split('\n'), wanted, keyState);
    if (found !== null) {
      index.duplicates.set(wanted.key, found);
      index.covered.add(wanted.key);
      return { ok: true, index };
    }
  }
  index.covered.add(wanted.key);
  return { ok: true, index };
}

/** Appends one signed event to `<storeDir>/events.jsonl` at mode 0600, minting the next sequence
 *  number (`seq = newestSeq + 1`). When `deduplicate` is true (the default), if a verified event
 *  with the same `(kind, record_id, session)` is already present in the retained log, returns it
 *  with `duplicate: true` without writing a second record. */
/** The payload one append writes for an input at a sequence, validated: null when any field
 *  would make the record unreadable. Shared with `signEventRecord`, so an envelope signed for a
 *  POST carries exactly the fields an append would have written for the same input and sequence. */
function eventPayloadOf(input: EventAppendInput, seq: number): EventPayload | null {
  const candidate: EventPayload = {
    v: 1,
    seq,
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
  for (const field of OPTIONAL_MEASURE_FIELDS) {
    if (input[field] !== undefined) {
      candidate[field] = input[field];
    }
  }
  return parseEventPayload(candidate);
}

/** Signs one event record without appending it: the envelope a send posts to a seat's webhook
 *  adapter, which needs the bus's body even when no bus is there to append the arrival. The
 *  record never enters the log — the bus stays the only appender — so its sequence is the
 *  caller's to name, and the caller names one that cannot be mistaken for a log position.
 *  Null when the payload or the message key is unusable. */
export function signEventRecord(
  input: EventAppendInput,
  seq: number,
  home: string,
): SignedEventRecord | null {
  const payload = eventPayloadOf(input, seq);
  if (payload === null) return null;
  try {
    return { payload, signature: signDomain(EVENT_DOMAIN, payload as unknown as Json, messageKeyOf(home)) };
  } catch {
    return null;
  }
}

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
    /** How long the append waits for the event lock. Omitted, it waits the lock's own budget;
     *  0 tries once and answers `busy` instead of pausing, so a caller on an event loop can
     *  defer the record without freezing the loop. */
    lockWaitMs?: number;
  } = {},
): EventAppendResult {
  const maxBytes = options.maxBytes ?? MAX_EVENT_LOG_BYTES;
  const kept = options.kept ?? EVENT_LOG_KEPT;
  const deduplicate = options.deduplicate ?? true;

  // Refused before the store is touched, with the reason a caller can act on. Parse holds the same
  // line, so a record this check admits is one every reader will admit too.
  if (typeof input.record_id !== 'string' || !EVENT_RECORD_ID.test(input.record_id)) {
    return {
      ok: false,
      reason: 'the record id is not a generated token: letters, digits, ":", ".", "_" and "-", 200 at most',
    };
  }

  if (heldAt(home).kind === 'missing') {
    mkdirSync(home, { recursive: true });
  }
  const storeDir = storePath(project, root, home);
  const ladderErr = ensureStoreLadder(storeDir, home);
  if (ladderErr !== null) return { ok: false, reason: ladderErr };

  // Allocation and the append it stamps are one critical section across processes: two writers
  // that scan the same newest sequence would otherwise mint it twice, and one of the two records
  // would then be invisible to every cursor reader. A call made from inside this lock (the drop
  // declaration) skips the wrapper below and runs the append under the lock its caller holds.
  const lockDir = join(storeDir, 'locks', 'events');
  if (!heldEventLocks.has(lockDir)) {
    try {
      return withEventLock(storeDir, () => appendEvent(project, root, home, input, options), options.lockWaitMs);
    } catch (error) {
      if (error instanceof LockBusyError) {
        return { ok: false, busy: true, reason: 'the event log is busy; the record was not written' };
      }
      throw error;
    }
  }

  // The index answers for one key at a time: a fresh process reads each retained file once and
  // verifies only the lines that can hold the record it is about to append — plus the newest
  // line, for the sequence — instead of every record retention kept.
  const wanted: WantedKey | null = deduplicate ? { key: eventKey(input), recordId: input.record_id } : null;
  const indexed = appendIndexOf(project, root, home, kept, wanted);
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
  const validated = eventPayloadOf(input, nextSeq);
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
