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
import { createHash, type Hash, type KeyObject } from 'node:crypto';
import { dirname, join } from 'node:path';
import { heldAt } from '../launch/rules-file.ts';
import { logLine } from '../log.ts';
import { ensureStoreLadder, readNoFollow } from '../send/history.ts';
import { acquireLock, LOCK_FILE, LockBusyError, withLock, writeAtomic } from '../state.ts';
import {
  messageKeyOf,
  messageKeyState,
  signDomain,
  verifyDomain,
  type Json,
} from '../store/keys.ts';
import { storePath, storesFolder } from '../store/store.ts';
import {
  DEFAULT_EVENT_RETENTION_SECONDS,
  EVENT_LOG_KEPT,
  EVENT_LOG_TOTAL_BYTES,
  isEventKind,
  type EventKind,
} from './kinds.ts';
import { eventLogSettingsFor } from './log-settings.ts';
import {
  INDEX_SUFFIX,
  SEAL_DOMAIN,
  SEAL_FORMAT,
  SEAL_SUFFIX,
  buildSegmentIndex,
  indexPathOf,
  keyPrintOfKey,
  readSeal,
  sealDigestOf,
  sealPayloadOf,
  sealPathOf,
  sealSegment,
  type SealFields,
  type SegmentIndexEntry,
  type StoredSeal,
} from './seal.ts';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export const EVENT_DOMAIN = 'team.event.v1\n';
export const EVENT_LOG_FILE = 'events.jsonl';
/** One segment reaches this size before it rotates, in a root whose team file names no smaller
 *  policy word; a team's `bus.segment_mb` replaces it through `eventLogSettingsFor`. */
export const MAX_EVENT_LOG_BYTES = 100_000_000;
export { EVENT_LOG_KEPT, EVENT_LOG_TOTAL_BYTES } from './kinds.ts';

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
  /** On a typed wake's `leg.tried`: the two measurements the bound is read from, both counted
   *  from the moment the message was staged. `submit_ms` ends at the first read that showed the
   *  wake's line gone after Enter (the gated point); `working_ms` ends at the profile's working
   *  screen and is reported only. Either is absent when no read showed it. */
  submit_ms?: number;
  working_ms?: number;
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

/** The bytes the retained set holds on disk: the live segment and every sealed slot inside the
 *  reader's bound, the same files `readEvents` walks. A slot that is not a regular file of this
 *  user's contributes nothing; the size is a stat, never a read, so a near-cap note costs one
 *  stat per retained slot and never touches a segment's bytes. */
export function retainedLogBytes(
  project: string,
  root: string,
  home: string,
  options: { kept?: number } = {},
): number {
  const kept = options.kept ?? eventLogSettingsFor(root, home).kept;
  const path = join(storePath(project, root, home), EVENT_LOG_FILE);
  let total = 0;
  for (let n = kept - 1; n >= 0; n--) {
    const at = n === 0 ? path : `${path}.${String(n)}`;
    if (heldAt(at).kind !== 'file') continue;
    total += sizeOfFile(at);
  }
  return total;
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

/** Removes a dropped segment's sidecars with it: a seal whose segment is gone must not outlive it
 *  and be mistaken for the next segment's. */
function unlinkSidecars(segment: string): void {
  for (const suffix of [SEAL_SUFFIX, INDEX_SUFFIX]) {
    try {
      unlinkSync(`${segment}${suffix}`);
    } catch {
      // Missing is the ordinary case for a segment sealed by an older build.
    }
  }
}

/** What a rotation needs to re-sign a seal for the slot its segment just moved to. */
type SealSigner = { storeDir: string; key: KeyObject; keyPrint: string };

/** Whether a sealed segment still agrees with its own seal as far as the start check may look
 *  without reading sealed bytes: the file is there at the sealed size, and its index matches the
 *  signed triple — byte count, line count and SHA-256 digest. A re-sign is a sealing act, so it
 *  signs only a segment this check still holds for; a same-length in-place edit of the segment
 *  itself stays undetected until its bytes are next read, as the design states. */
function sealedSegmentAgrees(segmentPath: string, seal: StoredSeal): boolean {
  if (heldAt(segmentPath).kind !== 'file') return false;
  if (sizeOfFile(segmentPath) !== seal.bytes) return false;
  const text = readNoFollow(indexPathOf(segmentPath));
  if (text === null) return false;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length !== seal.index.bytes) return false;
  if (createHash('sha256').update(bytes).digest('hex') !== seal.index.digest) return false;
  return text.split('\n').length - 1 === seal.index.lines;
}

/** Carries one moved seal to its new slot. A seal names its segment, so a shifted segment needs
 *  its seal re-signed for the new name and for its predecessor's new `sealDigest`; `previous`
 *  undefined keeps the seal's own predecessor, a digest names the predecessor re-signed in this
 *  pass, and null moves the sidecar untouched — a predecessor that is present but unsealed
 *  blocks this seal and every later one, and the moved file fails its name check beside the new
 *  segment, which is what "unsealed" means. A seal whose segment no longer matches its own
 *  signed claim is never re-signed; it moves untouched for the same reason. Returns the seal's
 *  digest at the new slot, or null when it was not re-signed. */
function moveSeal(
  from: string,
  to: string,
  fromSlot: number,
  toSlot: number,
  signer: SealSigner | undefined,
  previous: string | null | undefined,
): string | null {
  const movedVerbatim = (): string | null => {
    if (existsSync(sealPathOf(from))) {
      renameSync(sealPathOf(from), sealPathOf(to));
      try {
        chmodSync(sealPathOf(to), 0o600);
      } catch {
        // The reader refuses a file it cannot hold; the move stands.
      }
    }
    return null;
  };
  if (signer === undefined || previous === null) return movedVerbatim();
  const seal = readSeal(
    from,
    `${EVENT_LOG_FILE}.${String(fromSlot)}`,
    signer.storeDir,
    signer.keyPrint,
    signer.key,
  );
  if (seal === null) return movedVerbatim();
  // The segment and its index already sit at the new slot when this runs; both are checked
  // against the seal's own signed claim before it is carried to a fresh signature.
  if (!sealedSegmentAgrees(to, seal)) return movedVerbatim();
  const fields: SealFields = {
    format: seal.format,
    keyPrint: seal.keyPrint,
    store: seal.store,
    segment: `${EVENT_LOG_FILE}.${String(toSlot)}`,
    firstSeq: seal.firstSeq,
    lastSeq: seal.lastSeq,
    lines: seal.lines,
    bytes: seal.bytes,
    digest: seal.digest,
    previous: previous === undefined ? seal.previous : previous,
    sealedAt: seal.sealedAt,
    index: seal.index,
  };
  const sealDigest = sealDigestOf(fields);
  const signature = signDomain(SEAL_DOMAIN, sealPayloadOf(fields), signer.key);
  writeAtomic(sealPathOf(to), `${JSON.stringify({ ...sealPayloadOf(fields), sealDigest, signature })}\n`);
  try {
    unlinkSync(sealPathOf(from));
  } catch {
    // The stale name beside the old slot fails its own name check; an orphan is not trusted.
  }
  return sealDigest;
}

function rotateEventLog(
  path: string,
  kept: number = EVENT_LOG_KEPT,
  signer?: SealSigner,
): string | null {
  for (let n = 1; n < kept; n++) {
    const slot = `${path}.${String(n)}`;
    const problem = fileProblem(slot);
    if (problem !== null) return problem;
  }
  const oldest = `${path}.${String(kept - 1)}`;
  if (existsSync(oldest)) {
    unlinkSidecars(oldest);
    unlinkSync(oldest);
  }
  // A moved seal names its predecessor at the new slot: the seal re-signed in the previous
  // iteration. The oldest retained slot's predecessor was just dropped, so its seal keeps the
  // predecessor it already names — a break a retained drop record declares.
  let predecessor: string | null | undefined = undefined;
  for (let n = kept - 2; n >= 1; n--) {
    const from = `${path}.${String(n)}`;
    const to = `${path}.${String(n + 1)}`;
    if (!existsSync(from)) {
      predecessor = undefined;
      continue;
    }
    renameSync(from, to);
    chmodSync(to, 0o600);
    // The index holds no name of its own; it travels with the segment untouched.
    if (existsSync(`${from}${INDEX_SUFFIX}`)) {
      renameSync(`${from}${INDEX_SUFFIX}`, `${to}${INDEX_SUFFIX}`);
      try {
        chmodSync(`${to}${INDEX_SUFFIX}`, 0o600);
      } catch {
        // The reader's triple check refuses a file it cannot read; the move stands.
      }
    }
    predecessor = moveSeal(from, to, n, n + 1, signer, predecessor);
  }
  if (existsSync(path)) {
    renameSync(path, `${path}.1`);
    chmodSync(`${path}.1`, 0o600);
  }
  return null;
}

/** A predecessor segment's seal digest, read before a rotation can move or drop it. */
function sealDigestOfSlot(
  path: string,
  slot: number,
  storeDir: string,
  home: string,
): { existed: boolean; sealDigest: string | null } {
  const segmentPath = `${path}.${String(slot)}`;
  if (heldAt(segmentPath).kind !== 'file') return { existed: false, sealDigest: null };
  const state = messageKeyState(home);
  if (state.kind !== 'key') return { existed: true, sealDigest: null };
  const seal = readSeal(
    segmentPath,
    `${EVENT_LOG_FILE}.${String(slot)}`,
    storeDir,
    keyPrintOfKey(state.key),
    state.key,
  );
  return { existed: true, sealDigest: seal?.sealDigest ?? null };
}

/** Seals the segment a rotation just closed, leaving it unsealed when the chain cannot carry it:
 *  a predecessor segment that carries no valid seal blocks this seal and every later one, and a
 *  drop with no sealed predecessor breaks the chain the same way. Best effort by construction —
 *  rotation never fails over a seal. */
function sealRotatedSegment(
  path: string,
  kept: number,
  storeDir: string,
  home: string,
  droppedPredecessor: { existed: boolean; sealDigest: string | null } | null,
): void {
  const state = messageKeyState(home);
  if (state.kind !== 'key') return;
  const keyPrint = keyPrintOfKey(state.key);
  let previous: string | null;
  if (kept > 2) {
    const predecessor = `${path}.2`;
    if (heldAt(predecessor).kind === 'file') {
      const seal = readSeal(predecessor, `${EVENT_LOG_FILE}.2`, storeDir, keyPrint, state.key);
      if (seal === null) return;
      previous = seal.sealDigest;
    } else {
      // No `.2` is the chain root only when nothing older survived the rotation; a surviving
      // segment below a hole means the chain is already broken.
      for (let n = 3; n < kept; n++) {
        if (heldAt(`${path}.${String(n)}`).kind === 'file') return;
      }
      previous = null;
    }
  } else {
    // The oldest slot this rotation dropped: its seal carries the chain across a declared drop.
    if (droppedPredecessor === null) return;
    if (droppedPredecessor.existed && droppedPredecessor.sealDigest === null) return;
    previous = droppedPredecessor.sealDigest;
  }
  sealSegment(`${path}.1`, `${EVENT_LOG_FILE}.1`, storeDir, keyPrint, state.key, previous);
}

/** Rotates the live file once, dropping the oldest slot and sealing the segment just closed. The
 *  dropped slot's verified range is captured before it is unlinked; a rotation problem is
 *  returned to the caller, a seal failure is not. */
function rotateLive(
  path: string,
  kept: number,
  storeDir: string,
  home: string,
  cause: 'age' | 'rotation',
): { dropped: DroppedSegment | null; problem: string | null } {
  const predecessor = kept === 2 ? sealDigestOfSlot(path, 1, storeDir, home) : null;
  const dropped = captureOldestSlot(path, kept, home, cause);
  const keyState = messageKeyState(home);
  const signer =
    keyState.kind === 'key'
      ? { storeDir, key: keyState.key, keyPrint: keyPrintOfKey(keyState.key) }
      : undefined;
  const problem = rotateEventLog(path, kept, signer);
  if (problem !== null) return { dropped: null, problem };
  try {
    sealRotatedSegment(path, kept, storeDir, home, predecessor);
  } catch {
    // The segment stays unsealed and is read and verified in full, as before seals existed.
  }
  return { dropped, problem: null };
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
function sealIdleLiveFile(
  path: string,
  home: string,
  kept: number,
  cutoffMs: number,
  storeDir: string,
): DroppedSegment | null {
  const writtenAt = writtenAtFile(path);
  if (writtenAt === null || writtenAt >= cutoffMs || sizeOfFile(path) === 0) return null;
  const rotated = rotateLive(path, kept, storeDir, home, 'age');
  if (rotated.problem !== null) throw new Error(rotated.problem);
  return rotated.dropped;
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
    // Zero is the explicit keep-all word: no age bound, so the size cap alone drops.
    const tooOld = retentionSeconds > 0 && segment.writtenAt < cutoff;
    if (!overCap && !tooOld) break;
    const range = verifiedRangeOf(segment.path, home);
    try {
      unlinkSidecars(segment.path);
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

/** Removes a seal or an index whose segment is gone. An older build prunes a segment without
 *  knowing the sidecars a newer build wrote beside it, so a downgrade can leave a seal pointing
 *  at nothing; the orphan is never read as evidence, and a missing segment is judged by the drop
 *  records that remain. Each removal is written once to the team log, and a sidecar that cannot
 *  be removed is left for the next sweep. Callers hold the append lock: a rotation moves a
 *  segment and its sidecars in separate steps, and a sweep between them would remove a live
 *  index. Best effort: the sweep never fails its caller. */
export function sweepOrphanedSidecars(
  project: string,
  root: string,
  home: string,
  options: { kept?: number } = {},
): string[] {
  const kept = options.kept ?? eventLogSettingsFor(root, home).kept;
  const path = eventLogPath(project, root, home);
  const segments: { segment: string; name: string }[] = [{ segment: path, name: EVENT_LOG_FILE }];
  for (let n = 1; n <= kept - 1; n++) {
    segments.push({ segment: `${path}.${String(n)}`, name: `${EVENT_LOG_FILE}.${String(n)}` });
  }
  const removed: string[] = [];
  for (const { segment, name } of segments) {
    if (heldAt(segment).kind !== 'missing') continue;
    for (const suffix of [SEAL_SUFFIX, INDEX_SUFFIX]) {
      const sidecar = `${segment}${suffix}`;
      if (heldAt(sidecar).kind !== 'file') continue;
      try {
        unlinkSync(sidecar);
      } catch {
        continue;
      }
      removed.push(`${name}${suffix}`);
      logLine(join(root, '.agents'), 'bus', 'event-log', `removed orphan ${name}${suffix}`);
    }
  }
  return removed;
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
  options: EventLogRetention & { kept?: number; session?: string; lockWaitMs?: number } = {},
): void {
  try {
    // The team's words answer whatever the caller left out; a caller that names all three is
    // never sent through the policy store.
    const settings =
      options.kept === undefined || options.retentionSeconds === undefined
        ? eventLogSettingsFor(root, home)
        : null;
    const kept = options.kept ?? settings?.kept ?? EVENT_LOG_KEPT;
    const retentionSeconds =
      options.retentionSeconds ?? settings?.retentionSeconds ?? DEFAULT_EVENT_RETENTION_SECONDS;
    const retention: EventLogRetention = {
      ...(options.maxTotalBytes !== undefined ? { maxTotalBytes: options.maxTotalBytes } : {}),
      retentionSeconds,
    };
    const storeDir = storePath(project, root, home);
    if (ensureStoreLadder(storeDir, home) !== null) return;
    // The whole pass holds the append lock: its rotation and drops move the retained files the
    // append scans, and its declaration precomputes a sequence override before appending. A
    // writer that slipped between those two steps could mint that same sequence.
    // A key already held answers busy immediately when the caller asked not to wait. Pausing
    // here holds the loop for the default, including the start path before the bus is serving.
    withEventLock(storeDir, () => {
      const path = eventLogPath(project, root, home);
      const drops: DroppedSegment[] = [];
      // Under keep-all there is no age to seal against; the live segment is bounded by its size.
      if (retentionSeconds > 0) {
        const sealed = sealIdleLiveFile(path, home, kept, Date.now() - retentionSeconds * 1_000, storeDir);
        if (sealed !== null) drops.push(sealed);
      }
      drops.push(...pruneSealed(path, home, kept, retention));
      // Sidecars whose segment a downgrade (or an older build's prune) removed stay behind in
      // slots retention never reaches; the sweep runs under this same lock so it cannot catch a
      // rotation between the segment rename and its sidecar moves.
      sweepOrphanedSidecars(project, root, home, { kept });
      declareDrop(project, root, home, kept, retention, drops, options.session ?? project);
    }, options.lockWaitMs);
  } catch (error) {
    // A busy key is the caller's to retry. Any other failure stays best-effort.
    if (error instanceof LockBusyError) throw error;
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
const OPTIONAL_MEASURE_FIELDS = ['ms', 'submit_ms', 'working_ms'] as const;

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
  /** Where the digested bytes end, when they are one contiguous run from the start of the
   *  retained log (`null` otherwise): the caught-up read hashes just those bytes instead of
   *  parsing every retained line to rebuild the digest. */
  prefix: PrefixMark | null;
};

type PrefixMark = { file: number; end: number; parsed: number };

const readCheckpoints = new Map<string, ReadCheckpoint>();

type RetainedLine = { file: number; end: number; raw: string; parsed: SignedEventRecord | null };

/** SHA-256 over the raw lines of every record at or below `upTo`, in retained order, yielding a
 *  slice at a time. File boundaries are not part of the digest: a rotation that keeps every byte
 *  keeps the digest, while a segment dropped or a file rewritten changes it. */
function* prefixDigestSteps(lines: RetainedLine[], upTo: number): Generator<void, string, void> {
  const hash = createHash('sha256');
  let seen = 0;
  for (const line of lines) {
    seen += 1;
    if (seen % READ_EVENTS_SLICE_LINES === 0) yield;
    if (line.parsed === null || line.parsed.payload.seq > upTo) continue;
    hash.update(line.raw, 'utf8');
    hash.update('\n', 'utf8');
  }
  return hash.digest('hex');
}

/** The checkpoint's digest, and the byte run it covers when that run is contiguous from the start
 *  of the retained log. Only a record that parsed and sits at or below `upTo` is digested, so a
 *  run containing an unparsable or higher line is not a byte range and carries no mark; the next
 *  read then parses in full, exactly as before. */
function* prefixDigestAndMarkSteps(
  lines: RetainedLine[],
  upTo: number,
): Generator<void, { digest: string; prefix: PrefixMark | null }, void> {
  const hash = createHash('sha256');
  let parsed = 0;
  let last: { file: number; end: number } | null = null;
  let gap = false;
  let contiguous = true;
  let seen = 0;
  for (const line of lines) {
    seen += 1;
    if (seen % READ_EVENTS_SLICE_LINES === 0) yield;
    if (line.parsed === null || line.parsed.payload.seq > upTo) {
      gap = true;
      continue;
    }
    // An excluded line anywhere before a digested one means the digested bytes are not the run
    // from the file's start, so no byte range can stand in for them.
    if (gap) contiguous = false;
    gap = false;
    hash.update(line.raw, 'utf8');
    hash.update('\n', 'utf8');
    parsed += 1;
    last = { file: line.file, end: line.end };
  }
  const digest = hash.digest('hex');
  return {
    digest,
    prefix: contiguous && last !== null ? { file: last.file, end: last.end, parsed } : null,
  };
}

const PREFIX_HASH_CHUNK = 64 * 1024;

/** Hashes the byte run a checkpoint's mark covers, reproducing the per-line digest exactly: each
 *  covered line's raw bytes and the newline the digest appends after it. Returns the un-finalized
 *  hash beside its digest, so a read can continue it with the appended lines and learn the next
 *  checkpoint's digest without hashing the prefix twice. Null when the run cannot be read. */
function* prefixHashSteps(
  texts: (string | null)[],
  prefix: PrefixMark,
): Generator<void, { hash: Hash; digest: string } | null, void> {
  if (prefix.file >= texts.length) return null;
  const hash = createHash('sha256');
  for (let file = 0; file <= prefix.file; file += 1) {
    const text = texts[file];
    if (text === undefined || text === null) return null;
    const end = file === prefix.file ? prefix.end : text.length;
    if (end > text.length) return null;
    let at = 0;
    while (at < end) {
      const stop = Math.min(end, at + PREFIX_HASH_CHUNK);
      hash.update(text.slice(at, stop), 'utf8');
      at = stop;
      yield;
    }
    // The digest appends a newline after every line including the last of a file, so a file
    // whose last line has no newline contributes one more byte.
    if (end > 0 && text[end - 1] !== '\n') hash.update('\n', 'utf8');
  }
  try {
    return { hash, digest: hash.copy().digest('hex') };
  } catch {
    // No copy in this runtime: the caller reads in full rather than hashing twice.
    return null;
  }
}

/** The caught-up read: the in-memory checkpoint's digest still covers the retained bytes it was
 *  built from, so only the lines after its mark are parsed and checked, and only those over its
 *  sequence are checked against the key. Null when the bytes no longer hash to the checkpoint
 *  (an append that is really a rewrite, a trim, a rotation), and the caller verifies in full. */
type IncrementalRead = {
  events: SignedEventRecord[];
  unverified: number;
  checked: number;
  digest: string;
  prefix: PrefixMark | null;
};

function* incrementalReadSteps(
  texts: (string | null)[],
  checkpoint: ReadCheckpoint & { prefix: PrefixMark },
  keyState: ReturnType<typeof messageKeyState>,
): Generator<void, IncrementalRead | null, void> {
  const hashed = yield* prefixHashSteps(texts, checkpoint.prefix);
  if (hashed === null || hashed.digest !== checkpoint.digest) return null;
  const events = checkpoint.events.slice();
  let unverified = 0;
  let checked = 0;
  let prefixParsed = checkpoint.prefix.parsed;
  let tailBroken = 0;
  const tail: RetainedLine[] = [];
  for (let file = checkpoint.prefix.file; file < texts.length; file += 1) {
    const text = texts[file];
    if (text === null || text === undefined) continue;
    let position = file === checkpoint.prefix.file ? checkpoint.prefix.end : 0;
    if (position > text.length) return null;
    let seen = 0;
    while (position < text.length) {
      const newline = text.indexOf('\n', position);
      const end = newline < 0 ? text.length : newline;
      const raw = text.slice(position, end);
      position = newline < 0 ? text.length : newline + 1;
      if (raw.trim() === '') continue;
      tail.push({ file, end: position, raw, parsed: parseSignedEventLine(raw) });
      seen += 1;
      if (seen % READ_EVENTS_SLICE_LINES === 0) yield;
    }
  }
  let verifiedSeen = 0;
  for (const line of tail) {
    verifiedSeen += 1;
    if (verifiedSeen % READ_EVENTS_SLICE_LINES === 0) yield;
    if (line.parsed === null) {
      tailBroken += 1;
      continue;
    }
    if (line.parsed.payload.seq <= checkpoint.seq) {
      prefixParsed += 1;
      continue;
    }
    checked += 1;
    if (
      keyState.kind !== 'key' ||
      !verifyDomain(EVENT_DOMAIN, line.parsed.payload as unknown as Json, line.parsed.signature, keyState.key)
    ) {
      unverified += 1;
      continue;
    }
    events.push(line.parsed);
  }
  // A parsed record at or below the checkpoint's sequence that the checkpoint does not hold was
  // unverified when it was built, and its bytes have not changed since, so it still is.
  unverified += prefixParsed - checkpoint.events.length;
  unverified += tailBroken;
  const highest = events.reduce((max, event) => Math.max(max, event.payload.seq), 0);
  if (tail.length === 0) {
    return { events, unverified, checked, digest: checkpoint.digest, prefix: checkpoint.prefix };
  }
  let digest = checkpoint.digest;
  let prefix: PrefixMark | null = checkpoint.prefix;
  let qualifying = 0;
  let gap = false;
  let contiguous = true;
  let last: { file: number; end: number } | null = null;
  let hashedSeen = 0;
  for (const line of tail) {
    hashedSeen += 1;
    if (hashedSeen % READ_EVENTS_SLICE_LINES === 0) yield;
    if (line.parsed === null || line.parsed.payload.seq > highest) {
      gap = true;
      continue;
    }
    if (gap) contiguous = false;
    gap = false;
    hashed.hash.update(line.raw, 'utf8');
    hashed.hash.update('\n', 'utf8');
    qualifying += 1;
    last = { file: line.file, end: line.end };
  }
  digest = hashed.hash.digest('hex');
  prefix =
    qualifying === 0
      ? checkpoint.prefix
      : contiguous && last !== null
        ? { file: last.file, end: last.end, parsed: checkpoint.prefix.parsed + qualifying }
        : null;
  return { events, unverified, checked, digest, prefix };
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

/** The retained lines one slice of a read parses, verifies or hashes before yielding, and the
 *  budget a sliced read may hold the loop before it gives a turn back. A slice stays in the tens
 *  of milliseconds on a retained log at the size cap. */
const READ_EVENTS_SLICE_LINES = 64;
const READ_EVENTS_SLICE_MS = 2;

/** What this process last read from one retained store: the files it read, their stamps, and the
 *  verified result. A read whose files are all unchanged answers from memory. Anything else — a
 *  rotation, an append, a dropped segment, a rewritten file, a key change — falls back to the
 *  retained-line read: an append is not distinguishable from an in-place rewrite by stamp alone
 *  (both change size and time, and a rewrite keeps the inode), and only re-reading the retained
 *  lines re-checks the bytes the verified digest covers. */
type ReadIndex = {
  keyPrint: string;
  kept: number;
  files: { path: string; stamp: LogFileStamp | null }[];
  result: Extract<EventReadResult, { ok: true }>;
};

const readIndexes = new Map<string, ReadIndex>();

function drainSteps<T>(steps: Generator<void, T, void>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** Drains a sliced read, giving the event loop a turn whenever a slice has used its budget. */
async function driveSteps<T>(steps: Generator<void, T, void>): Promise<T> {
  let since = performance.now();
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
    if (performance.now() - since < READ_EVENTS_SLICE_MS) continue;
    await new Promise<void>((done) => setImmediate(done));
    since = performance.now();
  }
}

/** One retained sealed slot as start verification found it. `sealed` means the seal verified,
 *  the segment's size matches the seal and the index matches the signed triple; anything else is
 *  `unsealed` (with the reason) or `missing`, and an untrusted slot breaks the chain of every
 *  newer seal. */
export type SealCheck = {
  name: string;
  slot: number;
  path: string;
  state: 'sealed' | 'unsealed' | 'missing';
  why?: 'no-seal' | 'bad-seal' | 'size' | 'index' | 'chain';
  seal?: StoredSeal;
  entries?: SegmentIndexEntry[];
};

export type SealCheckResult =
  | {
      ok: true;
      /** The retained slots present, oldest first, up to the newest sealed one. */
      segments: SealCheck[];
      /** The open segment, stat'd but never read here: it is the one segment a start reads. */
      open: { path: string; size: number } | null;
      /** One line per untrusted segment, for the `.agents/team.log` report. */
      problems: string[];
    }
  | { ok: false; reason: string };

/** The companion index, read and checked against the seal's signed triple before any offset in
 *  it is trusted. Null when the file is missing, changed, or holds a line this build cannot
 *  spell — the segment is then unsealed for the read, exactly like a bad seal. */
function verifiedIndexEntries(segmentPath: string, seal: StoredSeal): SegmentIndexEntry[] | null {
  const text = readNoFollow(indexPathOf(segmentPath));
  if (text === null) return null;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length !== seal.index.bytes) return null;
  if (createHash('sha256').update(bytes).digest('hex') !== seal.index.digest) return null;
  const entries: SegmentIndexEntry[] = [];
  let lastOffset = -1;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    if (typeof row['seq'] !== 'number' || !Number.isInteger(row['seq']) || row['seq'] < 1) return null;
    if (typeof row['offset'] !== 'number' || !Number.isInteger(row['offset']) || row['offset'] < 0) return null;
    if (typeof row['kind'] !== 'string' || typeof row['record_id'] !== 'string' || typeof row['session'] !== 'string') {
      return null;
    }
    const offset = row['offset'];
    if (offset <= lastOffset || offset >= seal.bytes) return null;
    lastOffset = offset;
    entries.push(row as unknown as SegmentIndexEntry);
  }
  return entries.length === seal.index.lines ? entries : null;
}

/**
 * Verifies the retained sealed set at start without reading one byte of a sealed segment: every
 * seal is read, checked for format, key print, store, segment name and signature, then chained
 * oldest to newest. A segment is trusted only when its seal verifies, its file is present at the
 * sealed byte count and its index matches the signed triple. A missing, unreadable or mismatched
 * seal or index, a changed size, or a predecessor that is not itself a trusted sealed segment
 * marks the slot unsealed; the caller reads it in full through the ordinary verified path. The
 * open segment is stat'd and named here, never read.
 */
export function verifyEventLogSeals(
  project: string,
  root: string,
  home: string,
  options: { kept?: number } = {},
): SealCheckResult {
  const kept = options.kept ?? eventLogSettingsFor(root, home).kept;
  const storeDir = storePath(project, root, home);
  const stateRoot = storesFolder(home);
  const configDir = dirname(stateRoot);
  for (const level of [configDir, stateRoot, storeDir]) {
    const problem = ladderProblem(level);
    if (problem !== null) return { ok: false, reason: problem };
  }

  const path = join(storeDir, EVENT_LOG_FILE);
  for (let n = kept - 1; n >= 1; n--) {
    const problem = fileProblem(`${path}.${String(n)}`);
    if (problem !== null) return { ok: false, reason: problem };
  }
  const openProblem = fileProblem(path);
  if (openProblem !== null) return { ok: false, reason: openProblem };

  const keyState = messageKeyState(home);
  const key = keyState.kind === 'key' ? keyState.key : null;
  const keyPrint = keyPrintOf(home);

  // The oldest slot present is where the retained chain begins; slots above it were never
  // reached, so their absence is not a hole. A gap below it is.
  let oldestPresent = 0;
  for (let n = kept - 1; n >= 1; n--) {
    if (heldAt(`${path}.${String(n)}`).kind === 'file') {
      oldestPresent = n;
      break;
    }
  }

  const segments: SealCheck[] = [];
  const problems: string[] = [];
  // The slot processed just before: its seal digest and whether that seal is trusted.
  let predecessor: { digest: string; trusted: boolean } | null = null;
  for (let n = oldestPresent; n >= 1; n--) {
    const segmentPath = `${path}.${String(n)}`;
    const name = `${EVENT_LOG_FILE}.${String(n)}`;
    if (heldAt(segmentPath).kind !== 'file') {
      segments.push({ name, slot: n, path: segmentPath, state: 'missing' });
      problems.push(`${name}: segment file is missing`);
      predecessor = { digest: '', trusted: false };
      continue;
    }
    const seal = readSeal(segmentPath, name, storeDir, keyPrint, key);
    if (seal === null) {
      const why = existsSync(sealPathOf(segmentPath)) ? 'bad-seal' : 'no-seal';
      segments.push({ name, slot: n, path: segmentPath, state: 'unsealed', why });
      problems.push(`${name}: ${why === 'no-seal' ? 'seal file is missing' : 'seal does not verify'}`);
      predecessor = { digest: '', trusted: false };
      continue;
    }
    const size = sizeOfFile(segmentPath);
    if (size !== seal.bytes) {
      segments.push({ name, slot: n, path: segmentPath, state: 'unsealed', why: 'size' });
      problems.push(`${name}: size ${String(size)} differs from the sealed ${String(seal.bytes)}`);
      predecessor = { digest: seal.sealDigest, trusted: false };
      continue;
    }
    const entries = verifiedIndexEntries(segmentPath, seal);
    if (entries === null) {
      segments.push({ name, slot: n, path: segmentPath, state: 'unsealed', why: 'index' });
      problems.push(`${name}: index does not match its seal`);
      predecessor = { digest: seal.sealDigest, trusted: false };
      continue;
    }
    if (predecessor !== null && (!predecessor.trusted || seal.previous !== predecessor.digest)) {
      segments.push({ name, slot: n, path: segmentPath, state: 'unsealed', why: 'chain' });
      problems.push(`${name}: predecessor is not a trusted sealed segment`);
      predecessor = { digest: seal.sealDigest, trusted: false };
      continue;
    }
    segments.push({ name, slot: n, path: segmentPath, state: 'sealed', seal, entries });
    predecessor = { digest: seal.sealDigest, trusted: true };
  }

  const open = heldAt(path).kind === 'file' ? { path, size: sizeOfFile(path) } : null;
  return { ok: true, segments, open, problems };
}

type SealSetCache = { stamp: string; value: SealCheckResult };

const sealSetChecks = new Map<string, SealSetCache>();

function stampText(stamp: LogFileStamp | null): string {
  return stamp === null ? '-' : `${String(stamp.ino)}:${String(stamp.size)}:${String(stamp.mtimeMs)}:${String(stamp.ctimeMs)}`;
}

/** A stamp of every file the seal check reads or stats: each retained segment, its seal and its
 *  index, then the open segment. Any change to one of them makes the check run again, and nothing
 *  else does. */
function sealSetStamp(project: string, root: string, home: string, kept: number): string {
  const path = eventLogPath(project, root, home);
  const parts: string[] = [];
  for (let n = kept - 1; n >= 1; n--) {
    const segment = `${path}.${String(n)}`;
    parts.push(stampText(fileStamp(segment)));
    parts.push(stampText(fileStamp(sealPathOf(segment))));
    parts.push(stampText(fileStamp(indexPathOf(segment))));
  }
  parts.push(stampText(fileStamp(path)));
  return parts.join('|');
}

/**
 * `verifyEventLogSeals` for a caller that asks repeatedly over an unchanged set: the answer is
 * kept until a segment, a seal or an index changes. The check itself never reads a segment's
 * bytes, so its stamp is those files' own identity — rotation, a re-seal, a prune or a tampered
 * sidecar all move it.
 */
export function verifyEventLogSealsCached(
  project: string,
  root: string,
  home: string,
  options: { kept?: number } = {},
): SealCheckResult {
  const kept = options.kept ?? eventLogSettingsFor(root, home).kept;
  const cacheKey = `${storePath(project, root, home)}\u0000${String(kept)}\u0000${keyPrintOf(home)}`;
  const stamp = sealSetStamp(project, root, home, kept);
  const cached = sealSetChecks.get(cacheKey);
  if (cached !== undefined && cached.stamp === stamp) return cached.value;
  const value = verifyEventLogSeals(project, root, home, { kept });
  sealSetChecks.set(cacheKey, { stamp, value });
  return value;
}

/** Whether every line of one closed segment parses as a signed event and verifies under the
 *  message key, sliced so a large segment never holds the event loop: the parse and signature
 *  check give a turn every `sliceLines` lines. A segment that is empty, has no trailing newline,
 *  or carries one line the key does not hold for is never sealed. */
function* segmentLinesVerifySteps(
  path: string,
  key: KeyObject,
  sliceLines: number,
  signal?: AbortSignal,
): Generator<void, boolean, void> {
  const text = readNoFollow(path);
  if (text === null || text.length === 0 || !text.endsWith('\n')) return false;
  const slice = Math.max(1, Math.floor(sliceLines));
  let lines = 0;
  let seen = 0;
  let position = 0;
  while (position < text.length) {
    const newline = text.indexOf('\n', position);
    const end = newline < 0 ? text.length : newline;
    const raw = text.slice(position, end);
    position = newline < 0 ? text.length : newline + 1;
    if (raw.trim() === '') continue;
    seen += 1;
    if (seen % slice === 0) yield;
    if (signal?.aborted === true) return false;
    const parsed = parseSignedEventLine(raw);
    if (parsed === null) return false;
    if (!verifyDomain(EVENT_DOMAIN, parsed.payload as unknown as Json, parsed.signature, key)) {
      return false;
    }
    lines += 1;
  }
  return lines > 0;
}

type PreparedOpenChunk = {
  bytes: Buffer;
  indexText: string;
  lines: number;
  firstSeq: number;
  lastSeq: number;
  declaredOldest: number | null;
  digest: string;
  index: { bytes: number; lines: number; digest: string };
  session: string;
};

/**
 * Seals the segments a store written before seals existed left behind, one segment at a time and
 * sliced, and splits an oversized open `events.jsonl` (`size >= segmentBytes`, written under an
 * older segment bound) into sealed `segmentBytes` segments: every candidate is read and verified in
 * full first, with a turn to the event loop every `sliceLines` lines, and the append lock is taken
 * only for the atomic commit itself. Each seal names the digest of the seal before it, so the chain
 * is complete oldest first. A segment that cannot be sealed — an unverifiable line, a file that
 * moved while it was read — stops the pass, so nothing newer is sealed onto a broken chain. A
 * segment whose seal exists but does not hold is never re-sealed, because signing it again would
 * launder exactly what the failed check refuses. Sealing is idempotent: a sealed segment is skipped
 * and its sidecars are never rewritten.
 */
export function* sealUnsealedSegmentsSteps(
  project: string,
  root: string,
  home: string,
  options: {
    kept?: number;
    segmentBytes?: number;
    retentionSeconds?: number;
    maxTotalBytes?: number;
    session?: string;
    signal?: AbortSignal;
    sliceLines?: number;
  } = {},
): Generator<void, string[], void> {
  const settings =
    options.kept === undefined ? eventLogSettingsFor(root, home) : null;
  const kept = options.kept ?? settings!.kept;
  const storeDir = storePath(project, root, home);
  const sliceLines = options.sliceLines ?? READ_EVENTS_SLICE_LINES;
  const keyState = messageKeyState(home);
  if (keyState.kind !== 'key') return [];
  const keyPrint = keyPrintOf(home);
  const isAborted = (): boolean => options.signal?.aborted === true;
  const sealed: string[] = [];
  const checked = verifyEventLogSeals(project, root, home, { kept });
  if (!checked.ok) return [];
  let previous: string | null = null;
  let chainOpen = true;
  for (const segment of checked.segments) {
    if (!chainOpen || isAborted()) break;
    if (segment.state === 'sealed') {
      if (segment.seal === undefined) {
        chainOpen = false;
        continue;
      }
      previous = segment.seal.sealDigest;
      continue;
    }
    if (segment.state !== 'unsealed' || segment.why !== 'no-seal') {
      chainOpen = false;
      continue;
    }
    // The verification runs without the lock; the lock below covers only the seal write, and a
    // segment whose bytes moved since it was verified is refused by the stamp check.
    const stamp = fileStamp(segment.path);
    if (stamp === null || !(yield* segmentLinesVerifySteps(segment.path, keyState.key, sliceLines, options.signal))) {
      chainOpen = false;
      continue;
    }
    const written: { seal: StoredSeal | null } = { seal: null };
    try {
      // A held key defers the whole migration. Swallowing the busy answer and continuing would
      // look like a finished attempt, and this process would never seal the segment.
      withEventLock(
        storeDir,
        () => {
          if (!sameStamp(stamp, fileStamp(segment.path))) return;
          written.seal = sealSegment(segment.path, segment.name, storeDir, keyPrint, keyState.key, previous);
        },
        0,
      );
    } catch (error) {
      if (error instanceof LockBusyError) throw error;
      chainOpen = false;
      continue;
    }
    if (written.seal === null) {
      // A file that moved since its verification keeps its slot unsealed and stops the chain; a
      // later pass reads and seals what then sits there.
      chainOpen = false;
      continue;
    }
    previous = written.seal.sealDigest;
    sealed.push(segment.name);
    logLine(join(root, '.agents'), 'bus', 'event-log', `sealed ${segment.name}`);
    yield;
  }

  // An open `events.jsonl` left over from a larger segment bound (`size >= segmentBytes`) is
  // verified and indexed in slices outside the event lock. The chunk bytes are written to pending
  // names while the lock is held, one segment per turn, and the live names change only in the
  // commit that follows: until that commit the open file is still the whole readable log. A
  // crash before the commit leaves that file and names a reader does not look at.
  const openCandidate = checked.open;
  if (
    chainOpen &&
    kept >= 2 &&
    !isAborted() &&
    openCandidate !== null &&
    (options.segmentBytes !== undefined || openCandidate.size >= 1_000_000)
  ) {
    const fullSettings =
      options.segmentBytes !== undefined && options.retentionSeconds !== undefined
        ? null
        : (settings ?? eventLogSettingsFor(root, home));
    const segmentBytes = options.segmentBytes ?? fullSettings!.segmentBytes;
    const retentionSeconds = options.retentionSeconds ?? fullSettings!.retentionSeconds;
    const retention: EventLogRetention = {
      ...(options.maxTotalBytes !== undefined ? { maxTotalBytes: options.maxTotalBytes } : {}),
      retentionSeconds,
    };
    const openPath = openCandidate.path;
    const openStamp = fileStamp(openPath);
    const openBytes =
      segmentBytes > 0 && openCandidate.size >= segmentBytes ? yield* readBytesYielding(openPath) : null;
    const openStampAfter = fileStamp(openPath);
    if (
      openBytes !== null &&
      sameStamp(openStamp, openStampAfter) &&
      openBytes.length >= segmentBytes &&
      openBytes[openBytes.length - 1] === BYTE_NEWLINE
    ) {
      const slice = Math.max(1, Math.floor(sliceLines));
      const chunkRanges: {
        start: number;
        end: number;
        firstSeq: number;
        lastSeq: number;
        declaredOldest: number | null;
        session: string;
      }[] = [];
      let chunkStart = 0;
      let chunkEnd = 0;
      let firstSeq = 0;
      let lastSeq = 0;
      let declaredOldest: number | null = null;
      let chunkSession = options.session ?? project;
      let seen = 0;
      let position = 0;
      while (position < openBytes.length) {
        const newline = openBytes.indexOf(BYTE_NEWLINE, position);
        if (newline < 0) break;
        const nextPos = newline + 1;
        const raw = openBytes.toString('utf8', position, newline);
        if (raw.trim() === '') break;
        seen += 1;
        if (seen % slice === 0) yield;
        if (isAborted()) return sealed;
        const parsed = parseSignedEventLine(raw);
        if (
          parsed === null ||
          !verifyDomain(EVENT_DOMAIN, parsed.payload as unknown as Json, parsed.signature, keyState.key)
        ) {
          break;
        }
        if (chunkEnd > chunkStart && nextPos - chunkStart > segmentBytes) {
          chunkRanges.push({
            start: chunkStart,
            end: chunkEnd,
            firstSeq,
            lastSeq,
            declaredOldest,
            session: chunkSession,
          });
          chunkStart = position;
          chunkEnd = 0;
          declaredOldest = null;
        }
        if (chunkEnd <= chunkStart) {
          firstSeq = parsed.payload.seq;
        }
        chunkEnd = nextPos;
        lastSeq = parsed.payload.seq;
        chunkSession = parsed.payload.session;
        const declared = parsed.payload.dropped_oldest_seq;
        if (parsed.payload.kind === 'team.event-log-dropped' && declared !== undefined) {
          declaredOldest = declaredOldest === null ? declared : Math.min(declaredOldest, declared);
        }
        if (chunkEnd - chunkStart >= segmentBytes) {
          chunkRanges.push({
            start: chunkStart,
            end: chunkEnd,
            firstSeq,
            lastSeq,
            declaredOldest,
            session: chunkSession,
          });
          chunkStart = nextPos;
          chunkEnd = nextPos;
          declaredOldest = null;
        }
        position = nextPos;
      }

      if (chunkRanges.length > 0) {
        const preparedChunks: PreparedOpenChunk[] = [];
        let validChunks = true;
        for (const range of chunkRanges) {
          if (isAborted()) return sealed;
          const chunkBytes = openBytes.subarray(range.start, range.end);
          const built = buildSegmentIndex(chunkBytes);
          if (built === null) {
            validChunks = false;
            break;
          }
          const indexBytes = Buffer.from(built.text, 'utf8');
          preparedChunks.push({
            bytes: chunkBytes,
            indexText: built.text,
            lines: built.entries.length,
            firstSeq: range.firstSeq,
            lastSeq: range.lastSeq,
            declaredOldest: range.declaredOldest,
            digest: createHash('sha256').update(chunkBytes).digest('hex'),
            index: {
              bytes: indexBytes.length,
              lines: built.entries.length,
              digest: createHash('sha256').update(indexBytes).digest('hex'),
            },
            session: range.session,
          });
          yield;
        }

        if (validChunks && !isAborted()) {
          const splitOffset = chunkRanges[chunkRanges.length - 1]!.end;
          const splitSealed: string[] = [];
          const lockDir = join(storeDir, 'locks', 'events');
          let release: (() => void) | null = null;
          const pendingPaths: string[] = [];
          const published: string[] = [];
          let openReplaced = false;
          try {
            // The key stays held across the yields below. Another process sees the lock file.
            // Another turn in this process takes the busy answer, because the hold is marked
            // yielding for each turn the loop is free. The drop declaration runs later, on the
            // commit turn, which is not yielding, so it still appends under this hold.
            // A key already held is busy immediately. Waiting here would pause the loop for the
            // whole default, so the split waits for the next pass instead.
            release = acquireLock(lockDir, { waitMs: 0 });
            heldEventLocks.add(lockDir);
            const moved = !sameStamp(openStampAfter, fileStamp(openPath));
            const rechecked = moved ? null : verifyEventLogSeals(project, root, home, { kept });
            let currentPrev: string | null = null;
            let chainOpenForSplit = !moved && rechecked !== null && rechecked.ok;
            if (chainOpenForSplit && rechecked !== null && rechecked.ok) {
              for (const seg of rechecked.segments) {
                if (seg.state !== 'sealed' || seg.seal === undefined) {
                  chainOpenForSplit = false;
                  break;
                }
                currentPrev = seg.seal.sealDigest;
              }
            }
            if (chainOpenForSplit && currentPrev === previous) {
              const maxClosed = kept - 1;
              const totalChunks = preparedChunks.length;
              const drops: DroppedSegment[] = [];
              const openMtimeMs = Math.floor(statSync(openPath).mtimeMs);
              const signer: SealSigner = { storeDir, key: keyState.key, keyPrint };

              for (let i = 0; i < totalChunks; i++) {
                if (isAborted()) break;
                const chunk = preparedChunks[i]!;
                const slot = totalChunks - i;
                if (slot > maxClosed) continue;
                const pending = `${openPath}.pending-${String(slot)}`;
                writeAtomic(pending, chunk.bytes.toString('utf8'));
                writeAtomic(`${pending}${INDEX_SUFFIX}`, chunk.indexText);
                pendingPaths.push(pending);
                yield* yieldEventLock(lockDir);
              }

              if (!isAborted()) {
                let chainPredecessor: string | null | undefined = undefined;
                for (let n = maxClosed; n >= Math.max(1, maxClosed - totalChunks + 1); n--) {
                  const slotPath = `${openPath}.${String(n)}`;
                  if (heldAt(slotPath).kind !== 'file') continue;
                  const existingSeal = readSeal(
                    slotPath,
                    `${EVENT_LOG_FILE}.${String(n)}`,
                    storeDir,
                    keyPrint,
                    keyState.key,
                  );
                  const range = verifiedRangeOf(slotPath, home);
                  drops.push({
                    name: `${EVENT_LOG_FILE}.${String(n)}`,
                    bytes: sizeOfFile(slotPath),
                    oldestSeq: range?.oldest ?? null,
                    newestSeq: range?.newest ?? null,
                    declaredOldest: range?.declaredOldest ?? null,
                    bounds: ['rotation'],
                  });
                  chainPredecessor = existingSeal?.sealDigest ?? null;
                  unlinkSidecars(slotPath);
                  unlinkSync(slotPath);
                }

                for (let n = maxClosed - totalChunks; n >= 1; n--) {
                  const from = `${openPath}.${String(n)}`;
                  const to = `${openPath}.${String(n + totalChunks)}`;
                  if (!existsSync(from)) {
                    chainPredecessor = undefined;
                    continue;
                  }
                  renameSync(from, to);
                  chmodSync(to, 0o600);
                  if (existsSync(`${from}${INDEX_SUFFIX}`)) {
                    renameSync(`${from}${INDEX_SUFFIX}`, `${to}${INDEX_SUFFIX}`);
                    try {
                      chmodSync(`${to}${INDEX_SUFFIX}`, 0o600);
                    } catch {
                      // The reader's triple check refuses a file it cannot read; the move stands.
                    }
                  }
                  chainPredecessor = moveSeal(from, to, n, n + totalChunks, signer, chainPredecessor);
                }

                let pred: string | null = chainPredecessor === undefined ? previous : chainPredecessor;
                for (let i = 0; i < totalChunks; i++) {
                  const chunk = preparedChunks[i]!;
                  const slot = totalChunks - i;
                  const segmentName = `${EVENT_LOG_FILE}.${String(slot)}`;
                  const fields: SealFields = {
                    format: SEAL_FORMAT,
                    keyPrint,
                    store: storeDir,
                    segment: segmentName,
                    firstSeq: chunk.firstSeq,
                    lastSeq: chunk.lastSeq,
                    lines: chunk.lines,
                    bytes: chunk.bytes.length,
                    digest: chunk.digest,
                    previous: pred,
                    sealedAt: openMtimeMs,
                    index: chunk.index,
                  };
                  const sealDigest = sealDigestOf(fields);
                  pred = sealDigest;
                  if (slot > maxClosed) {
                    drops.push({
                      name: `${EVENT_LOG_FILE}.${String(maxClosed)}`,
                      bytes: chunk.bytes.length,
                      oldestSeq: chunk.firstSeq,
                      newestSeq: chunk.lastSeq,
                      declaredOldest: chunk.declaredOldest,
                      bounds: ['rotation'],
                    });
                    continue;
                  }
                  const slotPath = `${openPath}.${String(slot)}`;
                  const pending = `${openPath}.pending-${String(slot)}`;
                  const signature = signDomain(SEAL_DOMAIN, sealPayloadOf(fields), keyState.key);
                  renameSync(pending, slotPath);
                  chmodSync(slotPath, 0o600);
                  published.push(slotPath);
                  if (existsSync(`${pending}${INDEX_SUFFIX}`)) {
                    renameSync(`${pending}${INDEX_SUFFIX}`, indexPathOf(slotPath));
                    try {
                      chmodSync(indexPathOf(slotPath), 0o600);
                    } catch {
                      // The reader's triple check refuses a file it cannot read; the move stands.
                    }
                  }
                  writeAtomic(
                    sealPathOf(slotPath),
                    `${JSON.stringify({ ...sealPayloadOf(fields), sealDigest, signature })}\n`,
                  );
                  splitSealed.push(segmentName);
                }

                writeAtomic(openPath, openBytes.subarray(splitOffset).toString('utf8'));
                openReplaced = true;
                try {
                  drops.push(...pruneSealed(openPath, home, kept, retention));
                } catch {
                  // Retention never fails the split pass.
                }
                try {
                  declareDrop(
                    project,
                    root,
                    home,
                    kept,
                    { ...retention, maxBytes: segmentBytes },
                    drops,
                    options.session ?? preparedChunks[preparedChunks.length - 1]!.session,
                  );
                } catch {
                  // Retention never fails the split pass.
                }
              }
            }
          } catch (error) {
            // A write failure leaves the open log readable for the next pass. A busy key is
            // the caller's to retry; swallowing it would look like a finished attempt.
            if (error instanceof LockBusyError) throw error;
          } finally {
            if (!openReplaced) {
              for (const slotPath of published) {
                try { unlinkSync(slotPath); } catch { /* the next pass seals what remains */ }
                try { unlinkSync(indexPathOf(slotPath)); } catch { /* sidecar of a slot just removed */ }
                try { unlinkSync(sealPathOf(slotPath)); } catch { /* sidecar of a slot just removed */ }
              }
              for (const pending of pendingPaths) {
                try { unlinkSync(pending); } catch { /* already renamed, or never written */ }
                try { unlinkSync(`${pending}${INDEX_SUFFIX}`); } catch { /* already renamed */ }
              }
            }
            heldEventLocks.delete(lockDir);
            eventLockYielding.delete(lockDir);
            if (release !== null) release();
          }
          for (const name of splitSealed) {
            sealed.push(name);
            logLine(join(root, '.agents'), 'bus', 'event-log', `sealed ${name}`);
          }
        }
      }
    }
  }
  return sealed;
}

/** The blocking form of `sealUnsealedSegmentsSteps`: for a caller that can wait out the whole
 *  pass. The bus's own first read drives the sliced form so its loop keeps serving. */
export function sealUnsealedSegments(
  project: string,
  root: string,
  home: string,
  options: {
    kept?: number;
    segmentBytes?: number;
    retentionSeconds?: number;
    maxTotalBytes?: number;
    session?: string;
    signal?: AbortSignal;
    sliceLines?: number;
  } = {},
): string[] {
  return drainSteps(sealUnsealedSegmentsSteps(project, root, home, options));
}

/** What a hydrated record contributes to the reconcile and presence sets: the fields those passes
 *  ask of a verified record, without its signature or its byte offset. */
export type EventBrief = {
  seq: number;
  kind: string;
  record_id: string;
  session: string;
  seat?: string;
  ts?: string;
  from?: string;
  to?: string;
};

export type EventIndexReadResult =
  | {
      ok: true;
      entries: EventBrief[];
      /** Record signatures this read checked itself. A hydrated sealed segment contributes none;
       *  the lines of the open segment are checked one by one as before. */
      checked: number;
      full: boolean;
      path: string;
      oldestSeq: number | null;
      newestSeq: number | null;
      unverified: number;
      /** Present retained segments this read could not trust a seal for. The caller seals them
       *  once its verified read is done; zero on a fully sealed store. */
      unsealed: number;
      /** The newest sequence the sealed set vouches for, or null when a present segment is not
       *  sealed. A cursor at or above it can be answered from the open segment alone. */
      sealedNewestSeq: number | null;
    }
  | { ok: false; reason: string };

function briefOfEntry(entry: SegmentIndexEntry): EventBrief {
  const brief: EventBrief = {
    seq: entry.seq,
    kind: entry.kind,
    record_id: entry.record_id,
    session: entry.session,
  };
  if (entry.seat !== undefined) brief.seat = entry.seat;
  if (entry.ts !== undefined) brief.ts = entry.ts;
  if (entry.from !== undefined) brief.from = entry.from;
  if (entry.to !== undefined) brief.to = entry.to;
  return brief;
}

function briefOfRecord(record: SignedEventRecord): EventBrief {
  const { payload } = record;
  const brief: EventBrief = {
    seq: payload.seq,
    kind: payload.kind,
    record_id: payload.record_id,
    session: payload.session,
  };
  if (payload.seat !== undefined) brief.seat = payload.seat;
  if (payload.ts !== undefined) brief.ts = payload.ts;
  if (payload.from !== undefined) brief.from = payload.from;
  if (payload.to !== undefined) brief.to = payload.to;
  return brief;
}

type HydratedStore = {
  keyPrint: string;
  kept: number;
  seals: string;
  openStamp: LogFileStamp | null;
  result: Extract<EventIndexReadResult, { ok: true }>;
  /** The sealed segments' briefs alone, kept so an append to the open segment re-reads only it. */
  sealedEntries: EventBrief[];
  sealedNewestSeq: number | null;
  /** The verified open records behind this hydration, for a caller that needs whole records. */
  openRecords: SignedEventRecord[];
};

const hydratedStores = new Map<string, HydratedStore>();

type OpenRecords = { records: SignedEventRecord[]; checked: number; unverified: number };

/** The open segment parsed and verified line by line, sliced: the one segment of a sealed store
 *  whose bytes a reader still reads. A line whose signature does not verify is counted, never
 *  returned. A missing or empty file contributes nothing; a file that exists and cannot be read
 *  answers null. */
function* openRecordsSteps(
  path: string,
  keyState: ReturnType<typeof messageKeyState>,
  sliceLines: number,
): Generator<void, OpenRecords | null, void> {
  if (heldAt(path).kind !== 'file' || sizeOfFile(path) === 0) {
    return { records: [], checked: 0, unverified: 0 };
  }
  const text = readNoFollow(path);
  if (text === null) return null;
  yield;
  const slice = Math.max(1, Math.floor(sliceLines));
  const records: SignedEventRecord[] = [];
  let checked = 0;
  let unverified = 0;
  let position = 0;
  let seen = 0;
  while (position < text.length) {
    const newline = text.indexOf('\n', position);
    const end = newline < 0 ? text.length : newline;
    const raw = text.slice(position, end);
    position = newline < 0 ? text.length : newline + 1;
    if (raw.trim() === '') continue;
    seen += 1;
    if (seen % slice === 0) yield;
    const parsed = parseSignedEventLine(raw);
    checked += 1;
    if (
      parsed === null ||
      keyState.kind !== 'key' ||
      !verifyDomain(EVENT_DOMAIN, parsed.payload as unknown as Json, parsed.signature, keyState.key)
    ) {
      unverified += 1;
      continue;
    }
    records.push(parsed);
  }
  return { records, checked, unverified };
}

/**
 * The dedupe view of the retained log for the reconcile pass: every sealed segment contributes
 * its signed index, and only the open segment's bytes are read and checked line by line. The
 * sealed set is verified by `verifyEventLogSealsCached` first; a segment that is present but
 * unsealed sends the whole read through the ordinary verified path, so hydration is a saving over
 * a sealed log, never a way around verification. The result is cached per store until a seal, a
 * segment or the open file changes; an append to an unchanged sealed set re-reads only the open
 * segment.
 */
export function hydrateEventLog(
  project: string,
  root: string,
  home: string,
  options: { kept?: number } = {},
): EventIndexReadResult {
  return drainSteps(hydrateEventLogSteps(project, root, home, options));
}

export function* hydrateEventLogSteps(
  project: string,
  root: string,
  home: string,
  options: { kept?: number } = {},
): Generator<void, EventIndexReadResult, void> {
  const kept = options.kept ?? eventLogSettingsFor(root, home).kept;
  const checked = verifyEventLogSealsCached(project, root, home, { kept });
  if (!checked.ok) return checked;

  const keyState = messageKeyState(home);
  const keyPrint = keyPrintOf(home);
  const path = checked.open?.path ?? eventLogPath(project, root, home);
  const openStamp = fileStamp(path);
  const sealKey = checked.segments
    .map((segment) => `${segment.name}:${segment.state}:${segment.seal?.sealDigest ?? ''}`)
    .join('|');
  const cacheKey = `${storePath(project, root, home)}\u0000${String(kept)}`;
  const cached = hydratedStores.get(cacheKey);
  const sameSeals =
    cached !== undefined &&
    cached.keyPrint === keyPrint &&
    cached.kept === kept &&
    cached.seals === sealKey;
  if (sameSeals && sameStamp(cached.openStamp, openStamp)) {
    // No seal and no retained byte moved since this process hydrated them.
    return { ...cached.result, checked: 0, full: false };
  }

  // With no sealed segment there is nothing to hydrate, and a present segment without a trusted
  // seal carries records this index cannot vouch for: read the retained log the ordinary way,
  // which verifies every record it returns and keeps the checkpoint rules it always had.
  const unsealed = checked.segments.filter((segment) => segment.state === 'unsealed').length;
  if (checked.segments.length === 0 || unsealed > 0) {
    const read = yield* readEventsSteps(project, root, home, { kept });
    if (!read.ok) return read;
    const entries: EventBrief[] = [];
    let mapped = 0;
    for (const event of read.events) {
      entries.push(briefOfRecord(event));
      mapped += 1;
      if (mapped % READ_EVENTS_SLICE_LINES === 0) yield;
    }
    return {
      ok: true,
      entries,
      checked: read.checked,
      full: read.full,
      path: read.path,
      oldestSeq: read.oldestSeq,
      newestSeq: read.newestSeq,
      unverified: read.unverified,
      unsealed,
      sealedNewestSeq: null,
    };
  }

  let sealedEntries: EventBrief[];
  let sealedNewestSeq: number | null;
  if (sameSeals) {
    sealedEntries = cached.sealedEntries;
    sealedNewestSeq = cached.sealedNewestSeq;
  } else {
    sealedEntries = [];
    sealedNewestSeq = null;
    let seenSealed = 0;
    for (const segment of checked.segments) {
      if (segment.state !== 'sealed' || segment.entries === undefined) continue;
      for (const entry of segment.entries) {
        sealedEntries.push(briefOfEntry(entry));
        seenSealed += 1;
        if (seenSealed % READ_EVENTS_SLICE_LINES === 0) yield;
      }
      sealedNewestSeq = segment.seal?.lastSeq ?? sealedNewestSeq;
      yield;
    }
  }

  const open = yield* openRecordsSteps(path, keyState, READ_EVENTS_SLICE_LINES);
  if (open === null) return { ok: false, reason: 'the event log could not be read' };
  const entries = sealedEntries.slice();
  let seenOpen = 0;
  for (const record of open.records) {
    entries.push(briefOfRecord(record));
    seenOpen += 1;
    if (seenOpen % READ_EVENTS_SLICE_LINES === 0) yield;
  }

  const result: Extract<EventIndexReadResult, { ok: true }> = {
    ok: true,
    entries,
    checked: open.checked,
    full: false,
    path,
    oldestSeq: entries.length > 0 ? entries[0]!.seq : null,
    newestSeq: entries.length > 0 ? entries[entries.length - 1]!.seq : null,
    unverified: open.unverified,
    unsealed: 0,
    sealedNewestSeq,
  };
  if (keyState.kind === 'key' && open.unverified === 0) {
    hydratedStores.set(cacheKey, {
      keyPrint,
      kept,
      seals: sealKey,
      openStamp,
      result,
      sealedEntries,
      sealedNewestSeq,
      openRecords: open.records,
    });
  } else {
    hydratedStores.delete(cacheKey);
  }
  return result;
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
  return drainSteps(readEventsSteps(project, root, home, options));
}

/** The same read, sliced: a read of a large retained log answers its caller without holding the
 *  event loop for the whole verification. */
export async function readEventsSliced(
  project: string,
  root: string,
  home: string,
  options: { kept?: number } = {},
): Promise<EventReadResult> {
  return driveSteps(readEventsSteps(project, root, home, options));
}

export function* readEventsSteps(
  project: string,
  root: string,
  home: string,
  options: { kept?: number } = {},
): Generator<void, EventReadResult, void> {
  // A reader that was not told the set's bound reads the team's segment-size word the way an
  // append does; the count follows the same segment size, so both sides see the same files.
  const kept = options.kept ?? eventLogSettingsFor(root, home).kept;
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

  for (const candidate of files) {
    const problem = fileProblem(candidate);
    if (problem !== null) return { ok: false, reason: problem };
  }

  const keyState = messageKeyState(home);
  const keyPrint = keyPrintOf(home);
  const cacheKey = `${storeDir}\u0000${String(kept)}`;
  const stamps = files.map((candidate) => fileStamp(candidate));
  const remember = (result: Extract<EventReadResult, { ok: true }>): void => {
    readIndexes.set(cacheKey, {
      keyPrint,
      kept,
      files: files.map((candidate, at) => ({ path: candidate, stamp: stamps[at] ?? null })),
      result,
    });
  };

  const cached = readIndexes.get(cacheKey);
  const sameShape =
    cached !== undefined &&
    keyState.kind === 'key' &&
    cached.keyPrint === keyPrint &&
    cached.kept === kept &&
    cached.files.length === files.length &&
    cached.files.every((file, at) => file.path === files[at]);
  if (
    sameShape &&
    cached !== undefined &&
    cached.files.every((file, at) => sameStamp(file.stamp, stamps[at] ?? null))
  ) {
    // No retained byte moved since this process read and verified them: the answer is the one
    // read then, and nothing was checked by this call.
    return { ...cached.result, checked: 0, full: false };
  }

  // Snapshot first: every retained file's bytes are read before the first yield, so a rotation
  // between two files cannot drop a middle segment and leave a silent hole in this read.
  const texts: (string | null)[] = [];
  for (const candidate of files) {
    if (heldAt(candidate).kind === 'missing') {
      texts.push(null);
      continue;
    }
    const text = readNoFollow(candidate);
    if (text === null) return { ok: false, reason: 'the event log could not be read' };
    texts.push(text);
  }

  const checkpoint = readCheckpoints.get(cacheKey);

  let incremental: IncrementalRead | null = null;
  if (checkpoint !== undefined && checkpoint.keyPrint === keyPrint && checkpoint.prefix !== null) {
    incremental = yield* incrementalReadSteps(texts, { ...checkpoint, prefix: checkpoint.prefix }, keyState);
  }

  const lines: RetainedLine[] = [];
  if (incremental === null) {
    for (const [file, text] of texts.entries()) {
      if (text === null) continue;
      let position = 0;
      let seen = 0;
      while (position < text.length) {
        const newline = text.indexOf('\n', position);
        const end = newline < 0 ? text.length : newline;
        const rawLine = text.slice(position, end);
        position = newline < 0 ? text.length : newline + 1;
        if (rawLine.trim() === '') continue;
        lines.push({ file, end: position, raw: rawLine, parsed: parseSignedEventLine(rawLine) });
        seen += 1;
        if (seen % READ_EVENTS_SLICE_LINES === 0) yield;
      }
    }
  }

  const verifyAll = function* (): Generator<
    void,
    { events: SignedEventRecord[]; unverified: number; checked: number },
    void
  > {
    const verified: SignedEventRecord[] = [];
    let unverified = 0;
    let checked = 0;
    let seen = 0;
    for (const line of lines) {
      seen += 1;
      if (seen % READ_EVENTS_SLICE_LINES === 0) yield;
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
  let matched = false;
  if (incremental === null && checkpoint !== undefined && checkpoint.keyPrint === keyPrint) {
    matched = (yield* prefixDigestSteps(lines, checkpoint.seq)) === checkpoint.digest;
  }
  let storedMatched = false;
  if (
    incremental === null &&
    stored !== null &&
    keyState.kind === 'key' &&
    stored.keyPrint === keyPrint &&
    stored.kept === kept &&
    stored.store === storeDir
  ) {
    storedMatched = (yield* prefixDigestSteps(lines, stored.seq)) === stored.digest;
  }
  if (incremental !== null) {
    // The checkpoint's bytes still hash to its digest: only the lines after its mark were parsed,
    // and only the records over its sequence were checked against the key.
    events = incremental.events;
    unverified = incremental.unverified;
    checked = incremental.checked;
    full = false;
  } else if (matched && checkpoint !== undefined) {
    // Every retained record at or below the checkpoint's sequence is byte for byte the one it was
    // verified as; only the records past it are checked now. A parsed record at or below the
    // sequence that the checkpoint does not hold was unverified when it was built, and the bytes
    // have not changed since, so it is still unverified.
    full = false;
    events = checkpoint.events.slice();
    unverified = 0;
    checked = 0;
    let prefixParsed = 0;
    let seen = 0;
    for (const line of lines) {
      seen += 1;
      if (seen % READ_EVENTS_SLICE_LINES === 0) yield;
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
  } else if (storedMatched && stored !== null && keyState.kind === 'key') {
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
    let seen = 0;
    for (const line of lines) {
      seen += 1;
      if (seen % READ_EVENTS_SLICE_LINES === 0) yield;
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
    ({ events, unverified, checked } = yield* verifyAll());
  }

  const highest = events.reduce((max, event) => Math.max(max, event.payload.seq), 0);
  let digested: { digest: string; prefix: PrefixMark | null } | null =
    incremental === null ? null : { digest: incremental.digest, prefix: incremental.prefix };
  if (digested === null) {
    digested = yield* prefixDigestAndMarkSteps(lines, highest);
  }
  readCheckpoints.set(cacheKey, {
    keyPrint,
    seq: highest,
    digest: digested.digest,
    events: events.slice(),
    prefix: digested.prefix,
  });

  // What this read verified is what the next process may lean on. A checkpoint cannot record which
  // prefix records were unverified, so the file is written only when this read left none; a real
  // key is required for any of it to mean anything; and an empty log has nothing to cover. An
  // unchanged checkpoint is left as it is, so a quiet read does not rewrite the file.
  if (
    unverified === 0 &&
    keyState.kind === 'key' &&
    highest >= 1 &&
    (stored === null || stored.seq !== highest || stored.digest !== digested.digest)
  ) {
    writeStoredCheckpoint(
      storeDir,
      { format: VERIFY_CHECKPOINT_FORMAT, keyPrint, kept, seq: highest, digest: digested.digest, store: storeDir },
      keyState.key,
    );
  }

  const oldestSeq = events.length > 0 ? events[0]!.payload.seq : null;
  const newestSeq = events.length > 0 ? events[events.length - 1]!.payload.seq : null;
  const result: Extract<EventReadResult, { ok: true }> = {
    ok: true,
    events,
    unverified,
    checked,
    full,
    oldestSeq,
    newestSeq,
    path,
  };
  if (keyState.kind === 'key' && unverified === 0) {
    // The next read of this store, if no retained byte moved, may answer from this result. A read
    // that left a line unverified is not kept, so that line is checked again on the next read.
    remember(result);
  } else {
    readIndexes.delete(cacheKey);
  }
  return result;
}

/** What a matching read may ask of one record before any sealed byte is read: the kind and the
 *  record id, the two fields a sealed segment's index carries and its seal signs. A predicate
 *  never sees a payload the reader has not verified. */
export type EventBriefFilter = (entry: { kind: string; record_id: string }) => boolean;

/** The retained records whose kind or record id satisfies `filter`, read through the sealed
 *  segments' signed indexes: for every matching index entry only that entry's own line is read
 *  and its signature verified, and the open segment is read whole, line by line, as every read
 *  does. Nothing is appended and nothing is written.
 *
 *  The index is trusted only where `verifyEventLogSealsCached` trusts its seal: a signed index
 *  triple, chained to the trusted segment before it. When no segment is sealed, a present
 *  segment is unsealed or missing, there is no key to check a candidate line with, or a candidate
 *  line no longer parses as the record the index named under the key's signature, the read falls
 *  back to the ordinary verified read of the whole retained log and filters it, so no answer
 *  rests on an index the seal does not vouch for. */
export function readEventsMatching(
  project: string,
  root: string,
  home: string,
  filter: EventBriefFilter,
  options: { kept?: number } = {},
): EventReadResult {
  return drainSteps(readEventsMatchingSteps(project, root, home, filter, options));
}

function* readEventsMatchingSteps(
  project: string,
  root: string,
  home: string,
  filter: EventBriefFilter,
  options: { kept?: number },
): Generator<void, EventReadResult, void> {
  const kept = options.kept ?? eventLogSettingsFor(root, home).kept;
  const checked = verifyEventLogSealsCached(project, root, home, { kept });
  if (!checked.ok) return checked;

  const keyState = messageKeyState(home);
  // Every present segment must be trusted, seal and index both: a hole in the chain leaves a
  // stretch of the retained history no index accounts for, so the whole read stays ordinary.
  const trusted =
    checked.segments.length > 0
    && checked.segments.every((segment) => segment.state === 'sealed' && segment.entries !== undefined);
  if (!trusted || keyState.kind !== 'key') {
    const read = yield* readEventsSteps(project, root, home, { kept });
    if (!read.ok) return read;
    return { ...read, events: read.events.filter((record) => filter(record.payload)) };
  }

  const events: SignedEventRecord[] = [];
  let checkedLines = 0;
  let disagree = false;
  for (const segment of checked.segments) {
    if (segment.state !== 'sealed' || segment.entries === undefined) continue;
    for (const entry of segment.entries) {
      if (!filter(entry)) continue;
      checkedLines += 1;
      const raw = readLineAt(segment.path, entry.offset);
      const parsed = raw === null ? null : parseSignedEventLine(raw);
      if (
        parsed === null
        || parsed.payload.seq !== entry.seq
        || parsed.payload.kind !== entry.kind
        || parsed.payload.record_id !== entry.record_id
        || !verifyDomain(EVENT_DOMAIN, parsed.payload as unknown as Json, parsed.signature, keyState.key)
      ) {
        // The index named a line this segment no longer holds as that signed record: the sealed
        // bytes and the index disagree, so the answer comes from the whole retained log instead.
        disagree = true;
        break;
      }
      events.push(parsed);
    }
    if (disagree) break;
    yield;
  }
  if (disagree) {
    const read = yield* readEventsSteps(project, root, home, { kept });
    if (!read.ok) return read;
    return { ...read, events: read.events.filter((record) => filter(record.payload)) };
  }

  const path = checked.open?.path ?? eventLogPath(project, root, home);
  const open = yield* openRecordsSteps(path, keyState, READ_EVENTS_SLICE_LINES);
  if (open === null) return { ok: false, reason: 'the event log could not be read' };
  for (const record of open.records) {
    if (filter(record.payload)) events.push(record);
  }
  return {
    ok: true,
    events,
    unverified: open.unverified,
    checked: checkedLines + open.checked,
    full: false,
    oldestSeq: events.length > 0 ? events[0]!.payload.seq : null,
    newestSeq: events.length > 0 ? events[events.length - 1]!.payload.seq : null,
    path,
  };
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
  return drainSteps(readEventsFromCursorSteps(project, root, home, cursor, options));
}

/** The same cursor read, sliced: a busy or cold large retained log never holds the event loop for
 *  the whole scan. */
export async function readEventsFromCursorSliced(
  project: string,
  root: string,
  home: string,
  cursor: number,
  options: { kept?: number } = {},
): Promise<CursorReadResult> {
  return driveSteps(readEventsFromCursorSteps(project, root, home, cursor, options));
}

/** The cursor answer built from the open segment's verified records: only records past the cursor
 *  are returned, and a cursor past every record stays where it is. `newestSeq` falls back to the
 *  sealed set's newest when the open file is empty. */
function tailCursorResult(
  records: SignedEventRecord[],
  hydrated: Extract<EventIndexReadResult, { ok: true }>,
  cursor: number,
  checked: number,
  unverified: number,
): CursorReadResult {
  const events = records.filter((record) => record.payload.seq > cursor);
  const newestSeq = records.length > 0
    ? records[records.length - 1]!.payload.seq
    : hydrated.sealedNewestSeq;
  const nextCursor = events.length > 0
    ? events[events.length - 1]!.payload.seq
    : (newestSeq !== null && newestSeq > cursor ? newestSeq : cursor);
  return {
    ok: true,
    kind: 'events',
    events,
    cursor: nextCursor,
    oldestSeq: hydrated.oldestSeq,
    newestSeq,
    checked,
    full: false,
    unverified,
  };
}

export function* readEventsFromCursorSteps(
  project: string,
  root: string,
  home: string,
  cursor: number,
  options: { kept?: number } = {},
): Generator<void, CursorReadResult, void> {
  const kept = options.kept ?? eventLogSettingsFor(root, home).kept;
  const path = eventLogPath(project, root, home);
  let anySeal = false;
  for (let n = kept - 1; n >= 1; n--) {
    if (heldAt(sealPathOf(`${path}.${String(n)}`)).kind === 'file') {
      anySeal = true;
      break;
    }
  }
  // A cursor at or past the sealed set's newest record needs no sealed byte: the seals vouch for
  // that history, and only the open segment can hold what the cursor has not seen. A cursor
  // inside the history, an unsealed segment or a store with no seal takes the ordinary verified
  // read below, with its gap and retention rules unchanged.
  if (cursor > 0 && anySeal) {
    const hydrated = yield* hydrateEventLogSteps(project, root, home, { kept });
    if (!hydrated.ok) return hydrated;
    if (
      hydrated.unsealed === 0 &&
      hydrated.sealedNewestSeq !== null &&
      hydrated.oldestSeq !== null &&
      cursor >= hydrated.sealedNewestSeq
    ) {
      // The hydration just parsed the open segment (or answered from its cache while that file
      // was unchanged): those verified records answer this cursor without a second read.
      const cacheKey = `${storePath(project, root, home)}\u0000${String(kept)}`;
      const entry = hydratedStores.get(cacheKey);
      if (
        entry !== undefined &&
        entry.keyPrint === keyPrintOf(home) &&
        entry.sealedNewestSeq === hydrated.sealedNewestSeq &&
        entry.result.oldestSeq === hydrated.oldestSeq &&
        sameStamp(entry.openStamp, fileStamp(path))
      ) {
        return tailCursorResult(entry.openRecords, hydrated, cursor, hydrated.checked, hydrated.unverified);
      }
      const open = yield* openRecordsSteps(path, messageKeyState(home), READ_EVENTS_SLICE_LINES);
      if (open === null) return { ok: false, reason: 'the event log could not be read' };
      return tailCursorResult(open.records, hydrated, cursor, open.checked, open.unverified);
    }
  }
  const read = yield* readEventsSteps(project, root, home, { kept });
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
  const unseen: SignedEventRecord[] = [];
  let seen = 0;
  for (const entry of events) {
    seen += 1;
    if (seen % READ_EVENTS_SLICE_LINES === 0) yield;
    if (entry.payload.seq > cursor) unseen.push(entry);
  }
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

/** One retained log file as the append index last saw it: identity, size and both change times, so
 *  an unchanged file is not read again and a file that only grew is read from where the index
 *  stopped. The inode change time is kept because a writer can put a file's size and modification
 *  time back after rewriting it in place; only the change time cannot be restored. */
type LogFileStamp = { ino: number; size: number; mtimeMs: number; ctimeMs: number };

/** Where one retained line starts: the index of its file in retained order and the byte offset of
 *  its first character. */
type LinePlace = { file: number; offset: number };

/** The places a record id was seen at: one line, or several when the id was written more than
 *  once (another kind or session may hold the same id; retention never rewrites a kept line). */
type IdPlaces = LinePlace | LinePlace[];

/** One append's dedupe key and the id a line would spell to hold it. */
type WantedKey = { key: string; recordId: string };

/** What an append asks the index for: one key (an ordinary append), every key (`declareDrop`
 *  carries the declared segment floor forward from all retained drop records), or nothing (an
 *  append that does not deduplicate and needs only the newest sequence). */
type IndexRequest = WantedKey | 'all' | null;

type SealedIndexBuffer = {
  seal: StoredSeal;
  indexBytes: Buffer;
};

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
  /** The candidate line places for each record id this index has searched (or for every record id
   *  when `idsComplete` is true). */
  ids: Map<string, IdPlaces>;
  idsComplete: boolean;
  coveredIds: Set<string>;
  sealedByFile: Map<number, SealedIndexBuffer>;
  unsealedChunks: { file: number; base: number; bytes: Buffer }[];
  named: Set<string>;
  /** Where the live file's complete lines end: the next tail read starts here, so a line a writer
   *  left half-written is read whole once it completes. */
  offset: number;
  newestSeq: number | null;
  path: string;
};

const appendIndexes = new Map<string, AppendIndex>();

/** What the append index has read since this process started or the last reset: whole retained
 *  files and tails of them, the single lines a place lookup fetched, and the bytes all of those
 *  held. A key this index has not searched for costs one line after the one-pass id map is
 *  built, never a pass over the files. */
let appendIndexFileReads = 0;
let appendIndexLineReads = 0;
let appendIndexBytesRead = 0;

/** The append index's read counts. A diagnostic, and the witness a test reads to hold the index
 *  to one pass over the retained bytes: the bytes it read for a whole first pass stay near the
 *  size of the retained log instead of growing with every key the pass appends. */
export function appendIndexReads(): { files: number; lines: number; bytes: number } {
  return { files: appendIndexFileReads, lines: appendIndexLineReads, bytes: appendIndexBytesRead };
}

export function resetAppendIndexReads(): void {
  appendIndexFileReads = 0;
  appendIndexLineReads = 0;
  appendIndexBytesRead = 0;
}

/** The append locks this process holds, by lock directory. Append is synchronous, so a set is
 *  the whole reentrancy state: the nested drop declaration's append runs under the lock its
 *  caller already holds instead of waiting on itself. */
const heldEventLocks = new Set<string>();
/** Set while a holder has yielded the event loop and still holds the key. A nested append on
 *  that turn would write into the middle of a seal commit, so it answers busy. A nested call
 *  on the turn that is not yielding — the drop declaration — still runs under the hold. */
const eventLockYielding = new Set<string>();

/** Runs `work` under the store's event lock. A call made while this process already holds the
 *  lock and has not yielded — the drop declaration's append, from inside an append or from the
 *  prune pass — runs directly under the lock its caller holds. */
function withEventLock<T>(storeDir: string, work: () => T, lockWaitMs?: number): T {
  const lockDir = join(storeDir, 'locks', 'events');
  if (heldEventLocks.has(lockDir)) {
    if (eventLockYielding.has(lockDir)) throw new LockBusyError(join(lockDir, LOCK_FILE), process.pid);
    return work();
  }
  return withLock(
    lockDir,
    () => {
      heldEventLocks.add(lockDir);
      try {
        return work();
      } finally {
        heldEventLocks.delete(lockDir);
        eventLockYielding.delete(lockDir);
      }
    },
    lockWaitMs === undefined ? {} : { waitMs: lockWaitMs },
  );
}

/** Yields one turn while `lockDir` stays held. Other writers in this process answer busy for
 *  that turn; the key stays on disk, so another process cannot take it either. */
function* yieldEventLock(lockDir: string): Generator<void, void, void> {
  eventLockYielding.add(lockDir);
  try {
    yield;
  } finally {
    eventLockYielding.delete(lockDir);
  }
}

function eventKey(payload: Pick<EventPayload, 'kind' | 'record_id' | 'session'>): string {
  return `${payload.kind}\u0000${payload.record_id}\u0000${payload.session}`;
}

function fileStamp(path: string): LogFileStamp | null {
  if (heldAt(path).kind !== 'file') return null;
  try {
    const stat = statSync(path);
    return { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } catch {
    return null;
  }
}

function sameStamp(a: LogFileStamp | null, b: LogFileStamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** The message key the index was built under: a key change invalidates every verification. */
function keyPrintOf(home: string): string {
  const state = messageKeyState(home);
  if (state.kind !== 'key') return 'none';
  return keyPrintOfKey(state.key);
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

const RECORD_ID_MARK = Buffer.from('"record_id"', 'utf8');
const BYTE_QUOTE = 0x22;
const BYTE_COLON = 0x3a;
const BYTE_TAB = 0x09;
const BYTE_SPACE = 0x20;
const BYTE_NEWLINE = 0x0a;

function addPlace(into: Map<string, IdPlaces>, recordId: string, place: LinePlace): void {
  const held = into.get(recordId);
  if (held === undefined) into.set(recordId, place);
  else if (Array.isArray(held)) held.push(place);
  else into.set(recordId, [held, place]);
}

function isRecordIdByte(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x3a ||
    byte === 0x2e ||
    byte === 0x5f ||
    byte === 0x2d
  );
}

/** Indexes one stretch of retained bytes by the record id every line spells, recording where
 *  each line starts (`base` is where the stretch starts in its file). A line this code wrote
 *  holds `"record_id"` and the id literally — every admitted id is an ASCII token
 *  (`EVENT_RECORD_ID`), so `JSON.stringify` escapes none of its characters — and every
 *  occurrence in a line is taken, so an id quoted inside another field cannot hide the real
 *  one. A place is only a candidate: the line is parsed and its signature verified when a key
 *  is searched. */
function indexRecordIds(bytes: Buffer, file: number, base: number, into: Map<string, IdPlaces>): void {
  let lineStart = 0;
  for (;;) {
    const newline = bytes.indexOf(BYTE_NEWLINE, lineStart);
    const lineEnd = newline < 0 ? bytes.length : newline;
    let mark = bytes.indexOf(RECORD_ID_MARK, lineStart);
    while (mark >= 0 && mark < lineEnd) {
      let at = mark + RECORD_ID_MARK.length;
      while (at < lineEnd && (bytes[at] === BYTE_SPACE || bytes[at] === BYTE_TAB)) at += 1;
      if (at < lineEnd && bytes[at] === BYTE_COLON) {
        at += 1;
        while (at < lineEnd && (bytes[at] === BYTE_SPACE || bytes[at] === BYTE_TAB)) at += 1;
        if (at < lineEnd && bytes[at] === BYTE_QUOTE) {
          const close = bytes.indexOf(BYTE_QUOTE, at + 1);
          if (close > at + 1 && close < lineEnd) {
            const recordId = bytes.toString('utf8', at + 1, close);
            if (EVENT_RECORD_ID.test(recordId)) addPlace(into, recordId, { file, offset: base + lineStart });
            mark = bytes.indexOf(RECORD_ID_MARK, close + 1);
            continue;
          }
        }
      }
      mark = bytes.indexOf(RECORD_ID_MARK, mark + 1);
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
}

/** Finds every line in `bytes` where `wantedRecordId` occurs as a token and records the line's
 *  start offset in `into`. Because `wantedRecordId` can appear inside another event's payload (for
 *  example quoted inside `reason` on an earlier unrelated line), every matching line is recorded in
 *  retained order and `findIndexedRecord` parses and verifies each candidate until one matches both
 *  the event key and signature or none are left. */
function indexWantedRecordIdInChunk(
  bytes: Buffer,
  file: number,
  base: number,
  wantedRecordId: string,
  into: Map<string, IdPlaces>,
): void {
  if (wantedRecordId === '' || bytes.length === 0) return;
  const needle = Buffer.from(wantedRecordId, 'utf8');
  let searchFrom = 0;
  while (searchFrom < bytes.length) {
    const hit = bytes.indexOf(needle, searchFrom);
    if (hit < 0) break;
    const beforeOk = hit === 0 || !isRecordIdByte(bytes[hit - 1]!);
    const afterIdx = hit + needle.length;
    const afterOk = afterIdx >= bytes.length || !isRecordIdByte(bytes[afterIdx]!);
    if (!beforeOk || !afterOk) {
      searchFrom = hit + 1;
      continue;
    }
    const lineStart = hit === 0 ? 0 : bytes.lastIndexOf(BYTE_NEWLINE, hit - 1) + 1;
    const newline = bytes.indexOf(BYTE_NEWLINE, hit + needle.length);
    const lineEnd = newline < 0 ? bytes.length : newline;
    addPlace(into, wantedRecordId, { file, offset: base + lineStart });
    searchFrom = lineEnd + 1;
  }
}

/** Reads one whole retained file without following a link, yielding between chunks so a large
 *  open log does not hold the event loop for the read. Null when it cannot be read that way.
 *  The descriptor stays open across a yield and closes when the generator finishes or is closed. */
function* readBytesYielding(path: string): Generator<void, Buffer | null, void> {
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
    const buf = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, position);
      if (n <= 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
      position += n;
      yield;
    }
    return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Reads one whole retained file without following a link. Null when it cannot be read that way. */
function readBytesNoFollow(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size === 0) return Buffer.alloc(0);
    const bytes = Buffer.allocUnsafe(stat.size);
    let position = 0;
    while (position < stat.size) {
      const n = readSync(fd, bytes, position, stat.size - position, position);
      if (n <= 0) break;
      position += n;
    }
    const tail: Buffer[] = [];
    for (;;) {
      const extra = Buffer.allocUnsafe(64 * 1024);
      const n = readSync(fd, extra, 0, extra.length, position);
      if (n <= 0) break;
      tail.push(extra.subarray(0, n));
      position += n;
    }
    const base = position <= stat.size ? bytes.subarray(0, position) : bytes;
    return tail.length === 0 ? base : Buffer.concat([base, ...tail]);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The line that starts at `offset` in one retained file, without its newline, read without
 *  following a link. Null when the file no longer holds a line there. */
function readLineAt(path: string, offset: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= offset) return null;
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(8192);
    let position = offset;
    while (position < stat.size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, stat.size - position), position);
      if (n === 0) break;
      const newline = buf.subarray(0, n).indexOf(BYTE_NEWLINE);
      if (newline >= 0) {
        chunks.push(Buffer.from(buf.subarray(0, newline)));
        return Buffer.concat(chunks).toString('utf8');
      }
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

/** The last line of one stretch that verifies, walked backwards from the end, so a file of any
 *  size costs one parse when its newest line is a record — the ordinary case. Null when the
 *  stretch holds no verified record, and the caller then looks at an older file exactly as a
 *  full scan would. */
function lastVerifiedLineOf(
  bytes: Buffer,
  keyState: ReturnType<typeof messageKeyState>,
): SignedEventRecord | null {
  if (keyState.kind !== 'key') return null;
  let end = bytes.length;
  while (end > 0) {
    while (end > 0 && (bytes[end - 1] === BYTE_NEWLINE || bytes[end - 1] === 0x0d)) end -= 1;
    if (end === 0) break;
    const start = bytes.lastIndexOf(BYTE_NEWLINE, end - 1) + 1;
    const raw = bytes.toString('utf8', start, end);
    if (raw.trim() !== '') {
      const parsed = parseSignedEventLine(raw);
      if (parsed !== null && verifyDomain(EVENT_DOMAIN, parsed.payload as unknown as Json, parsed.signature, keyState.key)) {
        return parsed;
      }
    }
    end = start;
  }
  return null;
}

/** The first retained record for `wanted`, read at the places the id map holds for its record id
 *  and checked exactly as a scan checks a line: parse, the same key, a verifying signature.
 *  Places are in retained order, so the first match is the one a full scan finds. */
function findIndexedRecord(
  index: AppendIndex,
  files: string[],
  wanted: WantedKey,
  keyState: ReturnType<typeof messageKeyState>,
): SignedEventRecord | null {
  if (keyState.kind !== 'key') return null;
  const held = index.ids.get(wanted.recordId);
  if (held === undefined) return null;
  const places = Array.isArray(held) ? held : [held];
  for (const place of places) {
    const path = files[place.file];
    if (path === undefined) continue;
    appendIndexLineReads += 1;
    const raw = readLineAt(path, place.offset);
    if (raw === null) continue;
    appendIndexBytesRead += Buffer.byteLength(raw, 'utf8');
    const parsed = parseSignedEventLine(raw);
    if (parsed === null) continue;
    if (eventKey(parsed.payload) !== wanted.key) continue;
    if (!verifyDomain(EVENT_DOMAIN, parsed.payload as unknown as Json, parsed.signature, keyState.key)) continue;
    return parsed;
  }
  return null;
}

/** The companion `.index.jsonl` buffer, read and checked against the seal's signed byte count and
 *  SHA-256 digest without parsing every JSON line on a cold append. Null when the file is missing
 *  or does not match its seal. */
function verifiedIndexBytes(segmentPath: string, seal: StoredSeal): Buffer | null {
  const bytes = readBytesNoFollow(indexPathOf(segmentPath));
  if (bytes === null) return null;
  if (bytes.length !== seal.index.bytes) return null;
  if (createHash('sha256').update(bytes).digest('hex') !== seal.index.digest) return null;
  if (seal.index.lines < 1 || bytes.length === 0 || bytes[bytes.length - 1] !== BYTE_NEWLINE) return null;
  return bytes;
}

type SealAppendCache = { stamp: string; value: Map<string, SealedIndexBuffer> };

const sealAppendChecks = new Map<string, SealAppendCache>();

function sealAppendStamp(files: string[], stamps: (LogFileStamp | null)[]): string {
  const parts: string[] = [];
  for (let at = 0; at < files.length - 1; at += 1) {
    const segStamp = stamps[at] ?? null;
    if (segStamp === null) {
      parts.push('-');
      continue;
    }
    const segment = files[at]!;
    parts.push(
      `${stampText(segStamp)}:${stampText(fileStamp(sealPathOf(segment)))}:${stampText(fileStamp(indexPathOf(segment)))}`,
    );
  }
  return parts.join('|');
}

/** Verifies each retained segment's seal chain and `.index.jsonl` SHA-256 digest, returning the
 *  verified `.index.jsonl` buffers keyed by segment path. Cached by `sealAppendStamp` so repeated
 *  appends in the same process reuse the verified buffers while sidecars and segment sizes are
 *  unchanged. */
function sealedSegmentsForAppendCached(
  storeDir: string,
  kept: number,
  files: string[],
  stamps: (LogFileStamp | null)[],
  keyState: ReturnType<typeof messageKeyState>,
  keyPrint: string,
): Map<string, SealedIndexBuffer> {
  const cacheKey = `${storeDir}\u0000${String(kept)}\u0000${keyPrint}`;
  const stamp = sealAppendStamp(files, stamps);
  const cached = sealAppendChecks.get(cacheKey);
  if (cached !== undefined && cached.stamp === stamp) return cached.value;

  const value = new Map<string, SealedIndexBuffer>();
  const key = keyState.kind === 'key' ? keyState.key : null;
  const closedCount = files.length - 1;

  let oldestPresentAt = closedCount;
  for (let at = 0; at < closedCount; at += 1) {
    if (stamps[at] !== null && stamps[at] !== undefined) {
      oldestPresentAt = at;
      break;
    }
  }

  let predecessor: { digest: string; trusted: boolean } | null = null;
  for (let at = oldestPresentAt; at < closedCount; at += 1) {
    const slot = kept - 1 - at;
    const segmentPath = files[at]!;
    const name = `${EVENT_LOG_FILE}.${String(slot)}`;
    const segStamp = stamps[at] ?? null;
    if (segStamp === null) {
      predecessor = { digest: '', trusted: false };
      continue;
    }
    const seal = readSeal(segmentPath, name, storeDir, keyPrint, key);
    if (seal === null) {
      predecessor = { digest: '', trusted: false };
      continue;
    }
    if (segStamp.size !== seal.bytes) {
      predecessor = { digest: seal.sealDigest, trusted: false };
      continue;
    }
    const indexBytes = verifiedIndexBytes(segmentPath, seal);
    if (indexBytes === null) {
      predecessor = { digest: seal.sealDigest, trusted: false };
      continue;
    }
    if (predecessor !== null && (!predecessor.trusted || seal.previous !== predecessor.digest)) {
      predecessor = { digest: seal.sealDigest, trusted: false };
      continue;
    }
    value.set(segmentPath, { seal, indexBytes });
    predecessor = { digest: seal.sealDigest, trusted: true };
  }

  sealAppendChecks.set(cacheKey, { stamp, value });
  return value;
}

/** Searches a SHA-256-verified `.index.jsonl` buffer for every occurrence of `wantedRecordId`,
 *  parsing each candidate line and recording its offset in `into` and its key in `named`. Returns
 *  false if a candidate line is malformed or names an out-of-range offset, so the caller can fall
 *  back to reading the segment whole. */
function indexWantedRecordIdInSealedIndex(
  indexBytes: Buffer,
  file: number,
  seal: StoredSeal,
  wantedRecordId: string,
  into: Map<string, IdPlaces>,
  named: Set<string>,
): boolean {
  if (wantedRecordId === '' || indexBytes.length === 0) return true;
  const idToken = Buffer.from(`"${wantedRecordId}"`, 'utf8');
  let searchFrom = 0;
  while (searchFrom < indexBytes.length) {
    const hit = indexBytes.indexOf(idToken, searchFrom);
    if (hit < 0) break;
    const lineStart = hit === 0 ? 0 : indexBytes.lastIndexOf(BYTE_NEWLINE, hit - 1) + 1;
    const newline = indexBytes.indexOf(BYTE_NEWLINE, hit + idToken.length);
    const lineEnd = newline < 0 ? indexBytes.length : newline;
    const raw = indexBytes.toString('utf8', lineStart, lineEnd);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    const row = parsed as Record<string, unknown>;
    if (typeof row['seq'] !== 'number' || !Number.isInteger(row['seq']) || row['seq'] < 1) return false;
    if (
      typeof row['offset'] !== 'number' ||
      !Number.isInteger(row['offset']) ||
      row['offset'] < 0 ||
      row['offset'] >= seal.bytes
    ) {
      return false;
    }
    if (typeof row['kind'] !== 'string' || typeof row['record_id'] !== 'string' || typeof row['session'] !== 'string') {
      return false;
    }
    if (row['record_id'] === wantedRecordId) {
      addPlace(into, row['record_id'], { file, offset: row['offset'] });
      named.add(`${row['kind']}\u0000${row['record_id']}\u0000${row['session']}`);
    }
    searchFrom = lineEnd + 1;
  }
  return true;
}

/** Rebuild the whole retained id map from every file when a sealed index disagrees with its
 *  segment line. */
function rebuildFullAppendIndex(
  index: AppendIndex,
  files: string[],
  keyState: ReturnType<typeof messageKeyState>,
): boolean {
  index.ids.clear();
  index.duplicates.clear();
  index.covered.clear();
  index.coveredIds.clear();
  index.sealedByFile.clear();
  index.unsealedChunks.length = 0;
  index.named.clear();
  index.idsComplete = true;
  index.newestSeq = null;
  index.offset = 0;
  const last = files.length - 1;
  for (const [at, candidate] of files.entries()) {
    if (heldAt(candidate).kind === 'missing') continue;
    appendIndexFileReads += 1;
    const bytes = readBytesNoFollow(candidate);
    if (bytes === null) return false;
    appendIndexBytesRead += bytes.length;
    indexRecordIds(bytes, at, 0, index.ids);
    const newest = lastVerifiedLineOf(bytes, keyState);
    if (newest !== null) index.newestSeq = newest.payload.seq;
    if (at === last) {
      const complete =
        bytes.length > 0 && bytes[bytes.length - 1] !== BYTE_NEWLINE
          ? bytes.lastIndexOf(BYTE_NEWLINE) + 1
          : bytes.length;
      index.offset = Math.max(0, complete);
    }
  }
  return true;
}

/** What `appendEvent` needs from the retained log, kept across appends: the first verified record
 *  for the key this append is about to write, and the last verified sequence. The first look
 *  verifies each sealed segment's `.seal.json` and checks its `.index.jsonl` buffer against the
 *  seal's signed SHA-256 digest, searches the verified index buffers and the open segment's bytes
 *  for every occurrence of the record id, and reads and verifies only the candidate lines that can
 *  answer that key — so a fresh process appends to a log of any retained size without reading a
 *  sealed segment's bytes or parsing every index line. A segment without a trusted seal is still
 *  read whole. Each later look reads only the bytes appended to `events.jsonl` since the last one,
 *  so a growing session costs O(bytes). A key this process has not searched for is searched when
 *  it is first appended; a caller that needs every key (the retention declaration) asks for the
 *  whole map and verifies everything once. A rotated or rewritten file — or a changed key — falls
 *  back to a fresh scan. */
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
  const keyPrint = keyState.kind === 'key' ? keyPrintOfKey(keyState.key) : 'none';
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
    stamps[last]!.size > cached.offset;
  if (cached !== undefined && grew) {
    // Only the live file moved, and only forward: the bytes past the last complete line are read
    // once, verified, and added to the id map, instead of re-reading the retained files.
    const tail = readTailNoFollow(path, cached.offset);
    appendIndexFileReads += 1;
    if (tail !== null) appendIndexBytesRead += Buffer.byteLength(tail, 'utf8');
    if (tail !== null && (tail === '' || tail.endsWith('\n'))) {
      const bytes = Buffer.from(tail, 'utf8');
      const fresh = verifyInto(tail, keyState, cached.duplicates, cached.covered);
      if (fresh.length > 0) cached.newestSeq = fresh[fresh.length - 1]!.payload.seq;
      if (cached.idsComplete) {
        indexRecordIds(bytes, last, cached.offset, cached.ids);
      } else {
        for (const id of cached.coveredIds) {
          indexWantedRecordIdInChunk(bytes, last, cached.offset, id, cached.ids);
        }
        cached.unsealedChunks.push({ file: last, base: cached.offset, bytes });
      }
      cached.offset += bytes.length;
      cached.files[last] = fileStamp(path) ?? stamps[last] ?? null;
      if (answers(cached)) return { ok: true, index: cached };
      if (wantedKey !== null) return extendIndex(cached, files, wantedKey, keyState);
    }
  }

  // No index this process can use. A sealed segment's signed index already names every record it
  // holds, and its seal vouches for both: the candidate places for `wantedKey` and the newest
  // sequence come from those verified `.index.jsonl` buffers, so a fresh process reads only the
  // open segment whole and the candidate lines the append's own key can start at. A retained
  // segment without a trusted seal is read whole, exactly as before. A whole-key request (the
  // retention declaration) keeps its one walk over every retained file.
  const index: AppendIndex = {
    keyPrint,
    files: stamps,
    duplicates: new Map(),
    covered: new Set(),
    coveredAll: wantAll,
    ids: new Map(),
    idsComplete: wantAll,
    coveredIds: new Set(),
    sealedByFile: new Map(),
    unsealedChunks: [],
    named: new Set(),
    offset: 0,
    newestSeq: null,
    path,
  };
  if (wantedKey !== null && !wantAll) {
    index.coveredIds.add(wantedKey.recordId);
  }
  const sealed = wantAll
    ? new Map<string, SealedIndexBuffer>()
    : sealedSegmentsForAppendCached(storeDir, kept, files, stamps, keyState, keyPrint);
  const noteOpen = (at: number, bytes: Buffer): void => {
    if (at !== last) return;
    // Only the live file can end in a line a writer is still finishing; the next tail read starts
    // at the last complete line so that line comes back whole.
    const complete = bytes.length > 0 && bytes[bytes.length - 1] !== BYTE_NEWLINE
      ? bytes.lastIndexOf(BYTE_NEWLINE) + 1
      : bytes.length;
    index.offset = Math.max(0, complete);
  };
  for (const [at, candidate] of files.entries()) {
    // The open segment is never a sealed one: its bytes are read and verified line by line.
    const sealedBuf = at === last ? undefined : sealed.get(candidate);
    if (sealedBuf !== undefined) {
      let ok = true;
      if (wantedKey !== null) {
        ok = indexWantedRecordIdInSealedIndex(
          sealedBuf.indexBytes,
          at,
          sealedBuf.seal,
          wantedKey.recordId,
          index.ids,
          index.named,
        );
      }
      if (ok) {
        index.sealedByFile.set(at, sealedBuf);
        index.newestSeq = sealedBuf.seal.lastSeq;
        continue;
      }
    }
    if (stamps[at] === null) continue;
    appendIndexFileReads += 1;
    const bytes = readBytesNoFollow(candidate);
    if (bytes === null) return { ok: false, reason: 'the event log could not be read' };
    appendIndexBytesRead += bytes.length;
    if (wantAll) {
      indexRecordIds(bytes, at, 0, index.ids);
      const verified = verifyInto(bytes.toString('utf8'), keyState, index.duplicates, index.covered);
      if (verified.length > 0) index.newestSeq = verified[verified.length - 1]!.payload.seq;
      continue;
    }
    index.unsealedChunks.push({ file: at, base: 0, bytes });
    if (wantedKey !== null) {
      indexWantedRecordIdInChunk(bytes, at, 0, wantedKey.recordId, index.ids);
    }
    const newest = lastVerifiedLineOf(bytes, keyState);
    if (newest !== null) index.newestSeq = newest.payload.seq;
    noteOpen(at, bytes);
  }
  let found: SignedEventRecord | null = null;
  let searched = false;
  if (wantedKey !== null && !wantAll) {
    found = findIndexedRecord(index, files, wantedKey, keyState);
    searched = true;
    if (found !== null) index.duplicates.set(wantedKey.key, found);
    // The seal named this record, and its own line no longer verifies as the index says: the
    // index disagrees with the segment, so no answer may rest on it. The ordinary verified walk
    // over every retained file below answers as it always did.
    else if (keyState.kind === 'key' && index.named.has(wantedKey.key)) {
      searched = false;
      if (!rebuildFullAppendIndex(index, files, keyState)) {
        return { ok: false, reason: 'the event log could not be read' };
      }
    }
  }
  if (wantedKey !== null) {
    if (!searched) found = findIndexedRecord(index, files, wantedKey, keyState);
    if (found !== null) index.duplicates.set(wantedKey.key, found);
    index.covered.add(wantedKey.key);
  }
  appendIndexes.set(cacheKey, index);
  return { ok: true, index };
}

/** Answers an index for a key this process has not searched for yet: a byte search in the cached
 *  verified `.index.jsonl` buffers and unsealed chunks for `wanted.recordId`, then a read of the
 *  candidate lines that id starts, instead of a pass over the retained files. The newest sequence
 *  stays as the index has it: the caller already matched the file stamps under the event lock. */
function extendIndex(
  index: AppendIndex,
  files: string[],
  wanted: WantedKey,
  keyState: ReturnType<typeof messageKeyState>,
): { ok: true; index: AppendIndex } | { ok: false; reason: string } {
  if (!index.idsComplete && !index.coveredIds.has(wanted.recordId)) {
    index.coveredIds.add(wanted.recordId);
    const last = files.length - 1;
    let indexOk = true;
    for (let at = 0; at <= last; at += 1) {
      const sealedBuf = index.sealedByFile.get(at);
      if (sealedBuf !== undefined) {
        if (
          !indexWantedRecordIdInSealedIndex(
            sealedBuf.indexBytes,
            at,
            sealedBuf.seal,
            wanted.recordId,
            index.ids,
            index.named,
          )
        ) {
          indexOk = false;
          break;
        }
        continue;
      }
      for (const chunk of index.unsealedChunks) {
        if (chunk.file !== at) continue;
        indexWantedRecordIdInChunk(chunk.bytes, chunk.file, chunk.base, wanted.recordId, index.ids);
      }
    }
    if (!indexOk && !rebuildFullAppendIndex(index, files, keyState)) {
      return { ok: false, reason: 'the event log could not be read' };
    }
  }
  let found = findIndexedRecord(index, files, wanted, keyState);
  if (found === null && keyState.kind === 'key' && index.named.has(wanted.key)) {
    if (!rebuildFullAppendIndex(index, files, keyState)) {
      return { ok: false, reason: 'the event log could not be read' };
    }
    found = findIndexedRecord(index, files, wanted, keyState);
  }
  if (found !== null) index.duplicates.set(wanted.key, found);
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
     *  dropping pass uses this so declaring a drop cannot drop again. When `'cap'`, a sender step
     *  (`appendStep`) skips rotation, sealing, pruning, and drop declarations while the retained
     *  bytes stay below `maxTotalBytes` (`EVENT_LOG_TOTAL_BYTES`, 100 MB), and runs the full
     *  retaining path once the retained bytes reach that cap. */
    retain?: boolean | 'cap';
    /** How long the append waits for the event lock. Omitted, it waits the lock's own budget;
     *  0 tries once and answers `busy` instead of pausing, so a caller on an event loop can
     *  defer the record without freezing the loop. */
    lockWaitMs?: number;
  } = {},
): EventAppendResult {
  // The team's words answer whatever the caller left out; a caller that names the size, the set
  // and the window is never sent through the policy store. A record that performs no retention
  // (`retain: false`) needs only the set bound, so its append skips the chain too.
  const settingsNeeded =
    options.kept === undefined ||
    (options.retain !== false &&
      (options.maxBytes === undefined || options.retentionSeconds === undefined));
  const settings = settingsNeeded ? eventLogSettingsFor(root, home) : null;
  const maxBytes = options.maxBytes ?? settings?.segmentBytes ?? MAX_EVENT_LOG_BYTES;
  const kept = options.kept ?? settings?.kept ?? EVENT_LOG_KEPT;
  const retentionSeconds =
    options.retentionSeconds ?? settings?.retentionSeconds ?? DEFAULT_EVENT_RETENTION_SECONDS;
  const retention: EventLogRetention = {
    ...(options.maxTotalBytes !== undefined ? { maxTotalBytes: options.maxTotalBytes } : {}),
    retentionSeconds,
  };
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
  // A holder that has yielded still owns the key; an append from another turn answers busy
  // instead of writing into that commit.
  const lockDir = join(storeDir, 'locks', 'events');
  if (!heldEventLocks.has(lockDir) || eventLockYielding.has(lockDir)) {
    try {
      return withEventLock(
        storeDir,
        () =>
          appendEvent(project, root, home, input, {
            ...options,
            maxBytes,
            kept,
            retentionSeconds,
          }),
        options.lockWaitMs,
      );
    } catch (error) {
      if (error instanceof LockBusyError) {
        return { ok: false, busy: true, reason: 'the event log is busy; the record was not written' };
      }
      throw error;
    }
  }

  const path = join(storeDir, EVENT_LOG_FILE);
  const retainMode = options.retain ?? true;
  const maxTotal = retention.maxTotalBytes ?? EVENT_LOG_TOTAL_BYTES;
  let retain = retainMode === true;
  const drops: DroppedSegment[] = [];
  /** Declares whatever this append rotated away, on every exit that does not reach the write's
   *  own declaration. Best effort: retention never fails the caller. */
  const declare = (): void => {
    if (drops.length === 0) return;
    try {
      declareDrop(project, root, home, kept, { ...retention, maxBytes }, drops, input.session);
    } catch {
      // The caller's own result stands either way.
    }
  };

  // A live file already at or past the segment bound rotates before this append's index is
  // built: the index then reads the set it will keep answering for, instead of reading the live
  // file and re-reading it as the just-sealed segment on the next append. A file that still has
  // room is left to the write path below, which knows the exact line length. Below the total cap
  // (`maxTotal`), a sender (`retain: 'cap'`) or an unmigrated open file (`>= 2 * maxBytes`) leaves
  // rotation to the daemon's housekeeping; once retained bytes reach `maxTotal`, the append runs
  // the full retaining path so the cap holds even when the daemon is down.
  if (retainMode === true) {
    try {
      const current = heldAt(path);
      if (current.kind === 'file') {
        const size = statSync(path).size;
        const unmigratedBelowCap =
          maxBytes >= 1_000 &&
          size >= maxBytes * 2 &&
          retainedLogBytes(project, root, home, { kept }) < maxTotal;
        if (size > 0 && size >= maxBytes && !unmigratedBelowCap) {
          const rotated = rotateLive(path, kept, storeDir, home, 'rotation');
          if (rotated.problem !== null) return { ok: false, reason: rotated.problem };
          if (rotated.dropped !== null) drops.push(rotated.dropped);
          // Leave the new live segment in place, empty. The index built below then reads the set
          // it will keep answering for; its next look reads only this file's appended bytes
          // instead of re-reading the segment the rotation just sealed.
          try {
            closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | NOFOLLOW, 0o600));
          } catch {
            // The write below creates the file when this cannot.
          }
        }
      }
    } catch {
      // Retention never fails an append: the write below carries on.
    }
  }

  // The index answers for one key at a time: a fresh process reads each retained file once and
  // verifies only the lines that can hold the record it is about to append — plus the newest
  // line, for the sequence — instead of every record retention kept.
  const wanted: WantedKey | null = deduplicate ? { key: eventKey(input), recordId: input.record_id } : null;
  const indexed = appendIndexOf(project, root, home, kept, wanted);
  if (!indexed.ok) {
    declare();
    return indexed;
  }

  if (deduplicate) {
    const found = indexed.index.duplicates.get(eventKey(input));
    if (found !== undefined) {
      declare();
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
  const targetErr = fileProblem(path);
  if (targetErr !== null) return { ok: false, reason: targetErr };

  const line = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.from(line, 'utf8');

  try {
    if (retainMode !== false) {
      let totalRetainedBytes = 0;
      for (const stamp of indexed.index.files) {
        if (stamp !== null) totalRetainedBytes += stamp.size;
      }
      const atCap = totalRetainedBytes >= maxTotal || totalRetainedBytes + bytes.length > maxTotal;
      if (atCap) retain = true;
      const current = heldAt(path);
      const currentSize = current.kind === 'file' ? statSync(path).size : 0;
      const unmigratedBelowCap = maxBytes >= 1_000 && currentSize >= maxBytes * 2 && !atCap;
      if (retain && !unmigratedBelowCap) {
        // An idle live file is sealed first, so the append starts a new segment and the records the
        // old one holds are dropped by the prune below as one past-the-window segment.
        try {
          if (retentionSeconds > 0) {
            const sealed = sealIdleLiveFile(path, home, kept, Date.now() - retentionSeconds * 1_000, storeDir);
            if (sealed !== null) drops.push(sealed);
          }
        } catch {
          // Retention never fails an append: the write below carries on.
        }
        if (heldAt(path).kind === 'file') {
          const size = statSync(path).size;
          if (size > 0 && size + bytes.length > maxBytes) {
            const rotated = rotateLive(path, kept, storeDir, home, 'rotation');
            if (rotated.problem !== null) return { ok: false, reason: rotated.problem };
            if (rotated.dropped !== null) drops.push(rotated.dropped);
          }
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
        drops.push(...pruneSealed(path, home, kept, retention));
      } catch {
        // Retention never fails an append: the record is written either way.
      }
      try {
        declareDrop(project, root, home, kept, { ...retention, maxBytes }, drops, input.session);
      } catch {
        // Retention never fails an append: the record is written either way.
      }
    }
    return { ok: true, record, duplicate: false, path };
  } catch {
    if (drops.length > 0) {
      try {
        declareDrop(project, root, home, kept, { ...retention, maxBytes }, drops, input.session);
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
