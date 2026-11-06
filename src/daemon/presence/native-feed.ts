// Default-off native feed. Production has no trusted turn/lane/gate registration yet:
// adapters may refuse, but no payload can enroll itself. Every emitted gate is unknown.
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { userInfo } from 'node:os';
import { daemonStateAlive, readDaemonState } from '../state.ts';
import { daemonStatePath } from '../paths.ts';
import { appendEvent, type EventAppendInput } from '../../bus/log.ts';
import { currentBriefClaim } from '../../launch/general-brief.ts';
import { placementOf } from '../../mcp/serve.ts';
import type { Io } from '../../io.ts';
import { readState } from '../../state.ts';
import { adaptClaudeHook } from '../../status/claude-hook-adapter.ts';
import { adaptCodexFrame } from '../../status/codex-event-adapter.ts';
import { establishContext, initialNativeCandidate, reduceNativeObservation, type LogicalContext, type NativeCandidateState } from '../../status/native-observation.ts';
import { isPresenceBinding, isPresenceTime, PRESENCE_ID, presenceId, presenceFutureBeyond } from './contract.ts';
import { presencePaths } from './spool.ts';

type Source = 'claude-hook' | 'codex-frame';
const REASONS = new Set(['payload_shape', 'payload_limit', 'event', 'schema', 'notification',
  'missing_envelope', 'envelope_shape', 'missing_correlation', 'correlation_mismatch',
  'identifier_contract', 'unbound_permission', 'session_reason', 'frame_shape', 'frame_limit',
  'response', 'error', 'request', 'ambiguous_cleanup', 'method', 'missing_context']);
type Receipt = { v: 1; id: string; ts: string; session: string; seat: string; binding: string; epoch: string | null; source: Source; reason: string };
type Identity = { stateDir: string; session: string; seat: string; binding: string };
type Marker = { v: 1; binding: string; epoch: string | null; owner: string; daemon: string; expires: number };
type Cursor = { seq: number; last: string | null; pending: { receipt: string; event: EventAppendInput } | null };

function boundedJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(4097);
    if (!fstatSync(fd).isFile()) throw new Error('record_shape');
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count > 4096) throw new Error('record_limit');
    return JSON.parse(buffer.subarray(0, count).toString('utf8')) as unknown;
  } finally { closeSync(fd); }
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.new.${randomBytes(8).toString('hex')}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
}

function shape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function launch(identity: Identity): { binding: string; epoch: string | null } | null {
  try {
    const state = readState(identity.stateDir).sessions[identity.session];
    const seat = state?.seats[identity.seat];
    if (!isPresenceBinding(seat?.presence_binding) || seat.presence_binding !== identity.binding) return null;
    return { binding: seat.presence_binding, epoch: currentBriefClaim(state?.briefs?.[identity.seat])?.epoch ?? null };
  } catch { return null; }
}

function paths(identity: Pick<Identity, 'stateDir' | 'session' | 'seat'>) {
  const base = presencePaths(identity.stateDir, identity.session, identity.seat);
  return base === null ? null : { root: base.root, marker: join(base.root, 'status-feed.json'), spool: join(base.root, 'status-spool') };
}

/** Hook gate: placement is proved before the caller reads any additional stdin. */
export function nativeHookEnabled(identity: Identity, io: Io, placed = placementOf,
  readHome: () => string = () => userInfo().homedir): boolean {
  try {
    const one = paths(identity);
    if (one === null) return false;
    const marker = boundedJson(one.marker);
    const held = launch(identity);
    if (held === null || !shape(marker, ['v', 'binding', 'epoch', 'owner', 'daemon', 'expires']) || marker.v !== 1
      || typeof marker.owner !== 'string' || !/^[a-f0-9]{32}$/.test(marker.owner)
      || typeof marker.expires !== 'number' || marker.expires <= Date.now() || marker.expires > Date.now() + 5000
      || marker.binding !== identity.binding || marker.binding !== held.binding || marker.epoch !== held.epoch) return false;
    // HOME and marker fields cannot redirect this authority to a seat-writable fake record.
    // os.userInfo().homedir is OS-provided; tests inject a home without querying the account.
    const home = readHome();
    const daemonPath = daemonStatePath(home);
    if (lstatSync(daemonPath).isSymbolicLink()) return false;
    const inCheckout = relative(realpathSync(dirname(identity.stateDir)), realpathSync(daemonPath));
    if (inCheckout === '' || (!isAbsolute(inCheckout) && inCheckout !== '..' && !inCheckout.startsWith(`..${sep}`))) return false;
    const daemon = readDaemonState(home);
    if (daemon.kind !== 'ok' || daemon.state.nativeFeedOwner !== marker.daemon || !daemonStateAlive(daemon.state)) return false;
    return placed(io, identity.stateDir, identity.session, identity.seat).ok && launch(identity)?.epoch === held.epoch;
  } catch { return false; }
}

/** Test seam only. Production callers supply no envelope or context. No registration endpoint. */
export function nativeCandidateFromText(state: NativeCandidateState, source: Source, text: unknown,
  registration?: { context: LogicalContext; envelope: unknown }): { state: NativeCandidateState; reason: string } {
  const adapted = source === 'claude-hook' ? adaptClaudeHook(text, registration?.envelope) : adaptCodexFrame(text, registration?.envelope);
  if (adapted.status !== 'normalized') return { state, reason: adapted.reason };
  if (registration === undefined) return { state, reason: 'missing_context' };
  let candidate = state;
  if (candidate.context === null) candidate = establishContext(candidate, registration.context).state;
  const reduced = reduceNativeObservation(candidate, adapted.observation);
  return { state: reduced.state, reason: reduced.outcome.reason };
}

function stage(identity: Identity, source: Source, reason: string, epoch?: string | null): boolean {
  const held = launch(identity);
  if (held === null || (epoch !== undefined && held.epoch !== epoch) || !REASONS.has(reason)) return false;
  const one = paths(identity);
  if (one === null) return false;
  try {
    mkdirSync(one.spool, { recursive: true, mode: 0o700 });
    const ts = new Date().toISOString();
    const id = presenceId(ts);
    if (id === null) return false;
    const record: Receipt = { v: 1, id, ts, session: identity.session, seat: identity.seat, binding: identity.binding, epoch: held.epoch, source, reason };
    atomicJson(join(one.spool, `${id}.json`), record);
    return true;
  } catch { return false; }
}

/** Called only after the hook's marker/placement/claim gate. No payload or provider ids persist. */
export function stageNativeHook(identity: Identity, text: unknown, io: Io, readHome?: () => string): boolean {
  const held = launch(identity);
  if (held === null || !nativeHookEnabled(identity, io, undefined, readHome)) return false;
  const reduced = nativeCandidateFromText(initialNativeCandidate(), 'claude-hook', text);
  return stage(identity, 'claude-hook', REASONS.has(reduced.reason) ? reduced.reason : 'missing_context', held.epoch);
}

function receiptOf(value: unknown, identity: Identity, name: string): Receipt | null {
  const held = launch(identity);
  if (held === null || !shape(value, ['v', 'id', 'ts', 'session', 'seat', 'binding', 'epoch', 'source', 'reason']) || value.v !== 1
    || typeof value.id !== 'string' || !PRESENCE_ID.test(value.id) || name !== `${value.id}.json`
    || !isPresenceTime(value.ts) || value.id.slice(0, -9) !== value.ts
    || presenceFutureBeyond(value.ts, new Date())
    || value.session !== identity.session || value.seat !== identity.seat || value.binding !== identity.binding
    || value.epoch !== held.epoch
    || (value.source !== 'claude-hook' && value.source !== 'codex-frame')
    || typeof value.reason !== 'string' || !REASONS.has(value.reason)) return null;
  return value as Receipt;
}

export type NativeFeed = { step(): void; codexFrame(identity: Identity, text: string): void; close(): void };

/** The rejected set-aside keeps as many files as one spool pass reads. */
export const STATUS_REJECTED_CAP = 64;
const STATUS_SPOOL_SWEEP_CAP = 1_024;
const STATUS_STAGING_KEEP_MS = 5 * 60_000;
const spoolSweepResume = new Map<string, string>();

function rejectedDroppedPath(root: string): string {
  return join(root, 'status-rejected-dropped.json');
}

function readRejectedDropped(root: string): number | null {
  try {
    const value = boundedJson(rejectedDroppedPath(root));
    if (!shape(value, ['dropped']) || !Number.isSafeInteger(value.dropped) || (value.dropped as number) < 0) return null;
    return value.dropped as number;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null;
  }
}

/** Keeps at most `cap` files in `status-rejected` and counts the rest. The counter sits beside
 *  the directory, so the cap cannot delete it. Returns the count after this trim. */
export function capRejected(root: string, cap = STATUS_REJECTED_CAP): number {
  const rejected = join(root, 'status-rejected');
  let names: string[] = [];
  try {
    names = readdirSync(rejected).filter((name) => !name.startsWith('.')).sort();
  } catch {
    return readRejectedDropped(root) ?? 0;
  }
  const overflow = names.length > cap ? names.length - cap : 0;
  for (const name of names.slice(0, overflow)) {
    try { unlinkSync(join(rejected, name)); } catch { /* already gone */ }
  }
  return noteRejectedDropped(root, overflow);
}

function noteRejectedDropped(root: string, count: number): number {
  const prior = readRejectedDropped(root);
  if (prior === null) return 0;
  if (count <= 0) return prior;
  const dropped = prior + count;
  try { atomicJson(rejectedDroppedPath(root), { dropped }); } catch { /* the files are already gone */ }
  return dropped;
}

function isReceiptName(name: string): boolean {
  return name.endsWith('.json') && PRESENCE_ID.test(name.slice(0, -5));
}

/** The atomic writer's exact staging form. Its inode ctime, rather than its mtime or its
 *  receipt id's timestamp, sets the sweep's five-minute retention window. */
function isReceiptStagingName(name: string): boolean {
  const suffix = /\.new\.[a-f0-9]{16}$/.exec(name);
  return suffix !== null && suffix.index + suffix[0].length === name.length
    && isReceiptName(name.slice(0, suffix.index));
}

/** Sweeps at most 1,024 names from a sorted directory snapshot per pass. The in-memory
 *  last-name cursor resumes after removed names too, and wraps so persistent entries cannot
 *  starve later junk. Receipts and recent writer staging names are preserved. Listing/sorting
 *  still scales with the directory size. No payload is read and no directory is followed
 *  or recursively removed. */
export function sweepNonId(root: string, directory: string, now = Date.now()): number {
  let names: string[];
  try { names = readdirSync(directory).sort(); }
  catch { spoolSweepResume.delete(directory); return readRejectedDropped(root) ?? 0; }
  if (names.length === 0) {
    spoolSweepResume.delete(directory);
    return readRejectedDropped(root) ?? 0;
  }
  const last = spoolSweepResume.get(directory);
  let start = 0;
  if (last !== undefined) {
    // Upper bound, rather than indexOf: the last examined name may have been removed.
    let low = 0;
    let high = names.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (names[middle]! <= last) low = middle + 1;
      else high = middle;
    }
    start = low === names.length ? 0 : low;
  }
  const stagingCutoff = now - STATUS_STAGING_KEEP_MS;
  let removed = 0;
  for (let scanned = 0; scanned < Math.min(STATUS_SPOOL_SWEEP_CAP, names.length); scanned += 1) {
    const name = names[(start + scanned) % names.length]!;
    spoolSweepResume.set(directory, name);
    if (isReceiptName(name)) continue;
    const path = join(directory, name);
    if (isReceiptStagingName(name)) {
      // Age the inode itself, never a link target. An unknown age retains the name.
      try { if (!(lstatSync(path).ctimeMs < stagingCutoff)) continue; }
      catch { continue; }
    }
    try { unlinkSync(path); removed += 1; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EISDIR' && code !== 'EPERM') continue;
      try { rmdirSync(path); removed += 1; } catch { /* non-empty or already gone */ }
    }
  }
  return noteRejectedDropped(root, removed);
}

/** Created only in the existing --presence branch; driven by its existing pass, with no timer. */
export function createNativeFeed(input: {
  stateDir: string; session: string; seats: readonly string[]; project: string; root: string; home: string;
  daemonOwner: string;
  append?: (event: EventAppendInput) => boolean;
}): NativeFeed {
  let closed = false;
  const owner = randomBytes(16).toString('hex');
  const owned = new Map<string, string>();
  const candidates = new Map<string, { binding: string; epoch: string | null; state: NativeCandidateState; lastReason: string | null }>();
  const candidateOf = (identity: Identity) => {
    const previous = candidates.get(identity.seat);
    const epoch = launch(identity)?.epoch ?? null;
    if (previous?.binding === identity.binding) {
      if (previous.epoch !== epoch) { previous.epoch = epoch; previous.lastReason = null; }
      return previous;
    }
    const owner = { binding: identity.binding, epoch, state: initialNativeCandidate(), lastReason: null };
    candidates.set(identity.seat, owner);
    return owner;
  };
  const append = input.append ?? ((event) => appendEvent(input.project, input.root, input.home, event, { deduplicate: true, lockWaitMs: 0 }).ok);
  const removeMarker = (seat: string, onlyOwned = false): void => {
    const one = paths({ ...input, seat });
    if (one === null) return;
    try {
      if (onlyOwned && (boundedJson(one.marker) as Partial<Marker>)?.owner !== owner) return;
      unlinkSync(one.marker);
    } catch { /* absent/unreadable stays disabled */ }
  };
  const current = (seat: string): Identity | null => {
    try {
      const binding = readState(input.stateDir).sessions[input.session]?.seats[seat]?.presence_binding;
      return isPresenceBinding(binding) ? { stateDir: input.stateDir, session: input.session, seat, binding } : null;
    } catch { return null; }
  };
  const discard = (root: string, path: string, name: string): void => {
    const rejected = join(root, 'status-rejected');
    mkdirSync(rejected, { recursive: true, mode: 0o700 });
    renameSync(path, join(rejected, `${name}.${randomBytes(4).toString('hex')}`));
    capRejected(root);
  };
  const eventOf = (identity: Identity, record: Receipt, seq: number): EventAppendInput => ({
    ts: record.ts, kind: 'seat.status', session: input.session, seat: identity.seat,
    record_id: `status:${identity.seat}:${identity.binding}:${seq}`,
    status_binding: identity.binding, status_seq: seq, status_source: record.source,
    status_availability: 'correlation-unproven', status_advisory: 'unknown',
    status_continuity: 'unproven', status_gate: 'unknown',
    // No correlated session end or live process proof exists; confirmation remains needed.
    status_process_confirmation: 'needed', status_reason: record.reason,
  });
  return {
    codexFrame(identity, text) {
      if (closed || !input.seats.includes(identity.seat) || identity.stateDir !== input.stateDir
        || identity.session !== input.session || launch(identity) === null) return;
      const candidate = candidateOf(identity);
      const reduced = nativeCandidateFromText(candidate.state, 'codex-frame', text);
      candidate.state = reduced.state;
      const reason = REASONS.has(reduced.reason) ? reduced.reason : 'missing_context';
      // Token/output frames cannot flood the bus with an unchanged unknown answer. This is
      // refusal dedupe, not proof of provider sequence continuity or channel health.
      if (candidate.lastReason === reason) return;
      if (stage(identity, 'codex-frame', reason, candidate.epoch)) candidate.lastReason = reason;
    },
    step() {
      if (closed) return;
      for (const seat of input.seats) {
        // Remove predecessors before writing a marker for this pass's managed launch.
        removeMarker(seat);
        const identity = current(seat);
        if (identity === null) {
          owned.delete(seat); candidates.delete(seat);
          const stale = paths({ ...input, seat });
          if (stale !== null) spoolSweepResume.delete(stale.spool);
          continue;
        }
        candidateOf(identity);
        const one = paths(identity);
        const held = launch(identity);
        if (one === null || held === null) continue;
        try {
          mkdirSync(one.root, { recursive: true, mode: 0o700 });
          const marker: Marker = { v: 1, ...held, owner, daemon: input.daemonOwner, expires: Date.now() + 3000 };
          atomicJson(one.marker, marker);
          owned.set(seat, identity.binding);
          const cursorPath = join(one.root, `status-cursor-${identity.binding}.json`);
          let cursor: Cursor = { seq: 0, last: null, pending: null };
          try {
            const value = boundedJson(cursorPath);
            if (!shape(value, ['seq', 'last', 'pending']) || !Number.isSafeInteger(value.seq) || (value.seq as number) < 0
              || (value.last !== null && (typeof value.last !== 'string' || !PRESENCE_ID.test(value.last)))) continue;
            cursor = value as Cursor;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue; }
          // Replay exactly the persisted pending bytes; do not trust a cursor's arbitrary event.
          if (cursor.pending !== null) {
            if (!shape(cursor.pending, ['receipt', 'event']) || typeof cursor.pending.receipt !== 'string'
              || !PRESENCE_ID.test(cursor.pending.receipt) || cursor.seq < 1) continue;
            const name = `${cursor.pending.receipt}.json`;
            const path = join(one.spool, name);
            let receipt: Receipt | null;
            try { receipt = receiptOf(boundedJson(path), identity, name); } catch { receipt = null; }
            if (receipt === null) {
              // A claim/launch change invalidates the pending submission. Keep the allocated
              // publication ordinal, discard the receipt, and never replay it for a successor.
              cursor = { seq: cursor.seq, last: cursor.last, pending: null };
              atomicJson(cursorPath, cursor);
              try { discard(one.root, path, name); } catch { /* already absent */ }
            } else {
              if (JSON.stringify(cursor.pending.event) !== JSON.stringify(eventOf(identity, receipt, cursor.seq))) continue;
              if (launch(identity)?.epoch !== receipt.epoch || !append(cursor.pending.event)) continue;
              cursor = { seq: cursor.seq, last: receipt.id, pending: null };
              atomicJson(cursorPath, cursor);
            }
          }
          sweepNonId(one.root, one.spool);
          let names: string[];
          try { names = readdirSync(one.spool).filter((name) => isReceiptName(name)).sort().slice(0, 64); }
          catch { continue; }
          for (const name of names) {
            const path = join(one.spool, name);
            let receipt: Receipt | null;
            try { receipt = receiptOf(boundedJson(path), identity, name); } catch { receipt = null; }
            // Invalid/stale receipts never reach the bus, and cannot pin the bounded queue.
            if (receipt === null) { discard(one.root, path, name); continue; }
            if (receipt.id === cursor.last) { unlinkSync(path); continue; }
            if (launch(identity) === null || cursor.seq >= Number.MAX_SAFE_INTEGER) break;
            const seq = cursor.seq + 1;
            const event = eventOf(identity, receipt, seq);
            cursor = { seq, last: cursor.last, pending: { receipt: receipt.id, event } };
            atomicJson(cursorPath, cursor);
            if (launch(identity)?.epoch !== receipt.epoch || !append(event)) break;
            cursor = { seq, last: receipt.id, pending: null };
            atomicJson(cursorPath, cursor);
            unlinkSync(path);
          }
        } catch { /* fixed refusal: no payload, provider error or local path is logged */ }
      }
    },
    close() {
      closed = true;
      for (const seat of owned.keys()) removeMarker(seat, true);
      for (const seat of input.seats) {
        const one = paths({ ...input, seat });
        if (one !== null) spoolSweepResume.delete(one.spool);
      }
      owned.clear();
      candidates.clear();
    },
  };
}
