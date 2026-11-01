// Reconciliation pass for the event bus (RFC 002 Amendment 01 §4.2).
//
// Runs at bus startup and every `reconcile-interval` seconds. Scans the project's durable
// records — `.agents/send-drops/<session>/<seat>`, `.agents/messages/<seat>`, `messages.jsonl`,
// and `.agents/team.state.json` — for message records, receipts, and seat states that have no
// corresponding event in `events.jsonl`, and appends the missing events idempotently. A tool
// that crashed between writing its record and publishing to the bus loses time, never the event.
//
// The pass is a sequence of small steps, not one blocking call. `reconcileSteps` yields after
// every record it examines; `reconcilePassAsync` runs those steps in slices and gives the event
// loop a turn between them, so a large store never stops the bus, the daemon's heartbeat or a
// send endpoint's liveness answer. `reconcilePass` drains the same steps without yielding, for
// callers that want the whole pass before they move on.
//
// A pass also remembers what it already read and verified. Per-folder entries are keyed by the
// file's own stat stamp (inode, size, mtime, ctime): an unchanged record is raised from that
// cache — a map lookup in the log, not a read, a parse or a signature check — and only a changed
// or new file is read again. The log read itself is reused while the retained log files are
// unchanged, and so is the parsed history. Correctness does not move: every record is still
// raised on every pass (the dedupe set decides), read-once receipts keep their sender, and a
// receipt that arrives in a later pass than its record still carries that record's sender.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  configChangedRecordId,
  appendConfigChanged,
  type ConfigChange,
} from '../config/events.ts';
import {
  readEntityConfigSource,
  readProjectConfigSource,
  readSeatConfigSource,
  readTeamConfigSource,
  type ConfigSourceRead,
} from '../config/sources.ts';
import { getTeam, teamIdOf } from '../registry/teams.ts';
import { markOrphanedSeats } from '../registry/sync.ts';
import { HISTORY_KEPT, readHistory, type HistoryEntry } from '../send/history.ts';
import { readPending } from '../send/pending.ts';
import { readState } from '../state.ts';
import {
  MESSAGE_DOMAIN,
  messageKeyState,
  RECEIPT_DOMAIN,
  verifyDomain,
  type Json,
} from '../store/keys.ts';
import { compareSeatNames } from '../seat-names.ts';
import { DEFAULT_HELD_THRESHOLD_SECONDS } from './kinds.ts';
import {
  appendEvent,
  EVENT_LOG_KEPT,
  readEvents,
  type EventAppendInput,
  type SignedEventRecord,
} from './log.ts';
import { isOwnerDigestRecord } from './owner.ts';

export type ReconcileOptions = {
  project: string;
  root: string;
  session: string;
  home: string;
  now?: Date;
  maxBytes?: number;
  kept?: number;
  heldThresholdSeconds?: number;
  onEvent?: (record: SignedEventRecord) => void;
  /** The caches and counters a sequence of passes shares. Absent, every pass starts empty, which
   *  is exactly the old behavior. */
  state?: ReconcileState;
  /** How long `reconcilePassAsync` runs before it gives the event loop a turn. 0 yields at every
   *  step, which a scene uses to prove the pass yields at all; a negative value never yields. */
  sliceMs?: number;
  /** How long an append waits for the event lock. Omitted, it waits the lock's own budget (the
   *  sync driver's behavior); 0 makes every append non-blocking, and a held lock defers the
   *  record to the async driver's own wait instead of freezing the loop. */
  appendWaitMs?: number;
  /** How long `reconcilePassAsync` keeps retrying a deferred append while the lock is held. Past
   *  it the pass returns; the cursors it did not advance make the next pass try again. */
  appendRetryMs?: number;
  /** Aborting stops the pass before its next append and between slices. The bus aborts it when
   *  it closes, so a closing bus writes no event after `close` resolves; every cursor the pass
   *  did not advance past a record leaves that record for the next pass, in another process. */
  signal?: AbortSignal;
};

export type ReconcileResult =
  | {
      ok: true;
      raised: SignedEventRecord[];
      /** The log signatures this pass checked; a pass that extends the bus's verification
       *  checkpoint checks only the records appended since it. */
      checked: number;
      /** Whether this pass had to verify the whole retained log. */
      full: boolean;
    }
  | { ok: false; reason: string; cancelled?: true };

/** A pass stopped by its caller's abort signal. It is not a failure: every append it made
 *  landed, and every record it did not reach is still in the log's future because no cursor
 *  advanced past it. */
function cancelledResult(): ReconcileResult {
  return { ok: false, cancelled: true, reason: 'the pass was cancelled' };
}

/** What one pass did, and what it could reuse. Reset at the start of every pass except
 *  `passes`, which counts them; `yields` counts the turns `reconcilePassAsync` gave the loop. */
export type ReconcileStats = {
  passes: number;
  /** Record files whose content this pass read (drop records and signed records). */
  filesRead: number;
  /** Files whose content this pass did not read because their stat stamp was unchanged. */
  filesReused: number;
  /** Signed records this pass verified against the key. */
  verifies: number;
  /** Signed records whose verification result came from the cache. */
  verifiesReused: number;
  yields: number;
};

type DropEntry = { kind: 'drop'; from?: string; ts?: string; thread?: string; at: string };
type ReceiptEntry = { kind: 'receipt'; receipt: 'delivered' | 'read' | 'replied'; id: string; at: string };
type MessageEntry = {
  kind: 'message';
  keyPrint: string;
  verified: boolean;
  from?: string;
  at: string;
  ownerDigest: boolean;
};
type SignedReceiptEntry = { kind: 'signed-receipt'; keyPrint: string; verified: boolean; id: string; at: string };
type CachedEntry = DropEntry | ReceiptEntry | MessageEntry | SignedReceiptEntry;

type FileCache = { stamp: string; entry: CachedEntry };
type DirCache = { stamp: string; names: string[]; files: Map<string, FileCache> };
type LogCache = {
  path: string;
  kept: number;
  stamp: string;
  checked: number;
  full: boolean;
  seen: Set<string>;
  configSeen: Set<string>;
  lastSeatEventTs: Map<string, string>;
  /** Per delivery target and record id, the sender its `message.arrived` event carries. The log
   *  is the durable place this answer lives: it outlives the drop file that was taken and the
   *  process that first read it, so a receipt that arrives in a later pass — or after a
   *  reconnect — still names the sender. */
  arrivedFrom: Map<string, string>;
};
type HistoryCache = { path: string; stamp: string; entries: HistoryEntry[] };

/** An append the pass could not make because another process held the event lock. The async
 *  driver retries it with its own wait, so the record is neither lost nor allowed to freeze the
 *  loop; the sync driver's blocking append never produces one. */
type DeferredAppend =
  | { kind: 'event'; input: EventAppendInput }
  | { kind: 'config'; change: ConfigChange };

/** The caches one bus keeps between passes. It is plain state: nothing here is saved to disk,
 *  and a new bus process starts with an empty one, which only costs it one full first pass. */
export type ReconcileState = {
  dirs: Map<string, DirCache>;
  /** Per drop folder, the sender each record id carried when the pass saw it. Held across passes
   *  so a receipt that arrives after its record was taken still names the sender; pruned to the
   *  ids the current listing still holds on every pass. When that is not enough — a quiet pass
   *  in between, or a restart — the sender comes from the arrival event in the log. */
  senders: Map<string, Map<string, string>>;
  /** The same map for signed mailboxes. */
  signedSenders: Map<string, Map<string, string>>;
  log: LogCache | null;
  history: HistoryCache | null;
  /** Appends this pass deferred on a held event lock; empty after the async driver retries them
   *  or gives up, and reset at the start of every pass. */
  deferred: DeferredAppend[];
  stats: ReconcileStats;
};

export function createReconcileState(): ReconcileState {
  return {
    dirs: new Map(),
    senders: new Map(),
    signedSenders: new Map(),
    log: null,
    history: null,
    deferred: [],
    stats: { passes: 0, filesRead: 0, filesReused: 0, verifies: 0, verifiesReused: 0, yields: 0 },
  };
}

const RECORD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
/** The share of the event loop one async pass takes between turns. */
export const DEFAULT_RECONCILE_SLICE_MS = 8;
/** How long the async driver keeps retrying a deferred append while the event lock is held: the
 *  same budget the synchronous lock wait would spend. Past it the next pass tries again. */
export const DEFAULT_APPEND_RETRY_MS = 5_000;
/** The pause between two attempts at a held lock; the event loop is free between attempts. */
const APPEND_RETRY_STEP_MS = 50;

function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function parseDropSender(raw: string): { from?: string; ts?: string; thread?: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const payload =
        parsed.payload !== null && typeof parsed.payload === 'object' && !Array.isArray(parsed.payload)
          ? (parsed.payload as Record<string, unknown>)
          : parsed;
      const from = typeof payload.from === 'string' && payload.from !== '' ? payload.from : undefined;
      const ts =
        typeof payload.ts === 'string' && payload.ts !== ''
          ? payload.ts
          : typeof payload.at === 'string' && payload.at !== ''
            ? payload.at
            : undefined;
      const thread = typeof payload.thread === 'string' && payload.thread !== '' ? payload.thread : undefined;
      return {
        ...(from !== undefined ? { from } : {}),
        ...(ts !== undefined ? { ts } : {}),
        ...(thread !== undefined ? { thread } : {}),
      };
    } catch {
      // fall through to header parsing
    }
  }
  const firstLine = raw.split('\n', 1)[0] ?? '';
  if (firstLine.startsWith('from the owner')) {
    return { from: 'owner' };
  }
  const match = /^from (?:the file's seat |seat )?([A-Za-z0-9._-]+)/.exec(firstLine);
  if (match?.[1] !== undefined) {
    return { from: match[1] };
  }
  return {};
}

/** A receipt's own name says what it is and which record it belongs to; its bytes are never
 *  read. Returns null for anything that is not one of the three receipts. */
function receiptOf(file: string): { receipt: 'delivered' | 'read' | 'replied'; id: string } | null {
  for (const receipt of ['delivered', 'read', 'replied'] as const) {
    for (const suffix of [`.${receipt}.json`, `.${receipt}`]) {
      if (file.endsWith(suffix)) return { receipt, id: file.slice(0, -suffix.length) };
    }
  }
  return null;
}

function fileStampOf(path: string): { stamp: string; mtimeIso: string } | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return null;
    return {
      stamp: `${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeMs)}:${String(stat.ctimeMs)}`,
      mtimeIso: new Date(stat.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

function oneStamp(path: string): string {
  try {
    const stat = lstatSync(path);
    return `${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeMs)}:${String(stat.ctimeMs)}`;
  } catch {
    return 'missing';
  }
}

/** The stat signature of a retained log or history: the live file plus every rotated segment. A
 *  rotation moves the live file and rewrites a segment, so any change to the set changes this. */
function retainedStamp(path: string, kept: number): string {
  const parts: string[] = [];
  for (let n = kept - 1; n >= 1; n--) parts.push(oneStamp(`${path}.${String(n)}`));
  parts.push(oneStamp(path));
  return parts.join('|');
}

/** The directory's listing, reused whole while its own stat stamp is unchanged: a directory's
 *  mtime moves when an entry is added or removed. Each file's stamp is still checked below, so a
 *  record rewritten under the same name is read again. */
function listDir(state: ReconcileState, dir: string, visited: Set<string>): string[] | null {
  let signature: string;
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory()) {
      state.dirs.delete(dir);
      return null;
    }
    signature = `${String(stat.ino)}:${String(stat.mtimeMs)}:${String(stat.ctimeMs)}`;
  } catch {
    // A folder this pass cannot stat is gone or no longer a folder: its cached listing is no
    // longer a fact, so the next pass that finds it lists it again from scratch.
    state.dirs.delete(dir);
    return null;
  }
  visited.add(dir);
  const cached = state.dirs.get(dir);
  if (cached !== undefined && cached.stamp === signature) return cached.names;
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return null;
  }
  const files = new Map<string, FileCache>();
  if (cached !== undefined) {
    for (const name of names) {
      const hit = cached.files.get(name);
      if (hit !== undefined) files.set(name, hit);
    }
  }
  state.dirs.set(dir, { stamp: signature, names, files });
  return names;
}

function cachedEntry(state: ReconcileState, dir: string, name: string, stamp: string): CachedEntry | null {
  const hit = state.dirs.get(dir)?.files.get(name);
  return hit !== undefined && hit.stamp === stamp ? hit.entry : null;
}

function storeEntry(state: ReconcileState, dir: string, name: string, stamp: string, entry: CachedEntry): void {
  state.dirs.get(dir)?.files.set(name, { stamp, entry });
}

/** The key's public half as a stable print: a re-verified record stays verified only against the
 *  key that verified it. */
function keyPrintOf(keyState: ReturnType<typeof messageKeyState>): string {
  if (keyState.kind !== 'key') return '';
  try {
    const jwk = keyState.key.export({ format: 'jwk' }) as { x?: string };
    return typeof jwk.x === 'string' ? jwk.x : '';
  } catch {
    return '';
  }
}

/**
 * The pass as a sequence of steps. Every `yield` is a point where the caller may give the event
 * loop a turn; the caller's pacing never changes what the pass reads or raises.
 */
export function* reconcileSteps(options: ReconcileOptions): Generator<void, ReconcileResult, void> {
  const { project, root, session, home } = options;
  const state = options.state ?? createReconcileState();
  const stats = state.stats;
  stats.passes += 1;
  stats.filesRead = 0;
  stats.filesReused = 0;
  stats.verifies = 0;
  stats.verifiesReused = 0;
  stats.yields = 0;
  // Deferred appends belong to the previous pass's async retry; a new pass starts its own list.
  state.deferred = [];
  const visited = new Set<string>();
  const nowDate = options.now ?? new Date();
  const nowIso = nowDate.toISOString();
  const nowMs = nowDate.getTime();
  const heldThresholdMs = (options.heldThresholdSeconds ?? DEFAULT_HELD_THRESHOLD_SECONDS) * 1000;

  // The retained log is read as a whole only when one of its files changed. Until then the
  // dedupe sets it produced are still exactly the log's answer, and the log read — which parses
  // every retained line — is skipped.
  let existing: ReturnType<typeof readEvents>;
  let cachedLog = state.log;
  if (cachedLog !== null) {
    const stamp = retainedStamp(cachedLog.path, cachedLog.kept);
    if (stamp !== cachedLog.stamp) cachedLog = null;
  }
  if (cachedLog === null) {
    existing = readEvents(project, root, home, { kept: options.kept });
    if (!existing.ok) return existing;
    const kept = options.kept ?? EVENT_LOG_KEPT;
    cachedLog = {
      path: existing.path,
      kept,
      stamp: retainedStamp(existing.path, kept),
      checked: existing.checked,
      full: existing.full,
      seen: new Set<string>(),
      configSeen: new Set<string>(),
      lastSeatEventTs: new Map<string, string>(),
      arrivedFrom: new Map<string, string>(),
    };
    for (const entry of existing.events) {
      if (entry.payload.kind === 'config.changed') cachedLog.configSeen.add(entry.payload.record_id);
      if (entry.payload.session !== session) continue;
      cachedLog.seen.add(`${entry.payload.kind}\0${entry.payload.record_id}`);
      if (
        entry.payload.kind === 'message.arrived' &&
        entry.payload.to !== undefined &&
        entry.payload.from !== undefined
      ) {
        cachedLog.arrivedFrom.set(`${entry.payload.to}\0${entry.payload.record_id}`, entry.payload.from);
      }
      if (entry.payload.seat !== undefined) {
        const prev = cachedLog.lastSeatEventTs.get(entry.payload.seat);
        if (prev === undefined || Date.parse(entry.payload.ts) >= Date.parse(prev)) {
          cachedLog.lastSeatEventTs.set(entry.payload.seat, entry.payload.ts);
        }
      }
    }
    state.log = cachedLog;
  }

  // A seat whose declaration is gone keeps its record and every signed setting: the bootstrap
  // ruling asks for an observable mark instead of a delete, and this pass is where the removal
  // is first seen. A team file that does not load marks nothing.
  try {
    markOrphanedSeats(home, root, nowDate);
  } catch {
    // The next pass retries; a registry this pass cannot write does not fail the reconcile.
  }

  const seen = cachedLog.seen;
  const configSeen = cachedLog.configSeen;
  const lastSeatEventTs = cachedLog.lastSeatEventTs;
  const arrivedFrom = cachedLog.arrivedFrom;

  const raised: SignedEventRecord[] = [];

  // The async driver asks for non-blocking appends: a held lock becomes a deferred record that
  // the driver retries with its own wait, never a pause here that freezes the event loop.
  const defersBusy = options.appendWaitMs !== undefined && options.appendWaitMs <= 0;
  const aborted = (): boolean => options.signal?.aborted === true;
  const raise = (input: EventAppendInput): boolean => {
    // A cancelled pass appends nothing more: its caller is closing, and a record written after
    // that would outlive the bus's own lifetime.
    if (aborted()) return false;
    const key = `${input.kind}\0${input.record_id}`;
    if (seen.has(key)) return true;
    const res = appendEvent(project, root, home, input, {
      maxBytes: options.maxBytes,
      kept: options.kept,
      deduplicate: true,
      ...(options.appendWaitMs !== undefined ? { lockWaitMs: options.appendWaitMs } : {}),
    });
    if (res.ok) {
      seen.add(key);
      if (!res.duplicate) {
        raised.push(res.record);
        options.onEvent?.(res.record);
      }
      return true;
    }
    if (res.busy === true && defersBusy) {
      state.deferred.push({ kind: 'event', input });
      return false;
    }
    // Any other failure is left to the next pass; the caller advances no cursor past it.
    return false;
  };

  // 1. Scan `.agents/send-drops/<session>/<seat>` for drop files, `.pending` markers, and receipts.
  const sessionDropsDir = join(root, '.agents', 'send-drops', session);
  const dropSeatNames = listDir(state, sessionDropsDir, visited);
  if (dropSeatNames !== null) {
    const seats = [...dropSeatNames].sort(compareSeatNames);
    for (const seat of seats) {
      if (!RECORD_NAME.test(seat)) continue;
      const seatDir = join(sessionDropsDir, seat);
      if (!isRealDir(seatDir)) continue;
      visited.add(seatDir);

      const files = listDir(state, seatDir, visited) ?? [];

      const sendersById = new Map<string, string>();
      const previousSenders = state.senders.get(seatDir);

      for (const file of files) {
        if (file.startsWith('.')) continue;
        if (
          file.endsWith('.tmp') ||
          file.endsWith('.pending') ||
          file.endsWith('.taken') ||
          file.endsWith('.read') ||
          file.endsWith('.read.json') ||
          file.endsWith('.delivered') ||
          file.endsWith('.delivered.json') ||
          file.endsWith('.replied') ||
          file.endsWith('.replied.json') ||
          // The fallback episode's marker beside a message record: a summary of route
          // attempts, never a record some seat was sent.
          file.endsWith('.fallback.json')
        ) {
          continue;
        }
        const fullPath = join(seatDir, file);
        const fresh = fileStampOf(fullPath);
        if (fresh === null) continue;
        const id = file.endsWith('.json') ? file.slice(0, -'.json'.length) : file;
        if (!RECORD_NAME.test(id)) continue;

        let entry = cachedEntry(state, seatDir, file, fresh.stamp);
        if (entry === null || entry.kind !== 'drop') {
          let raw = '';
          try {
            raw = readFileSync(fullPath, 'utf8');
          } catch {
            continue;
          }
          stats.filesRead += 1;
          entry = { kind: 'drop', at: fresh.mtimeIso, ...parseDropSender(raw) };
          storeEntry(state, seatDir, file, fresh.stamp, entry);
        } else {
          stats.filesReused += 1;
        }
        if (entry.from !== undefined) sendersById.set(id, entry.from);

        raise({
          ts: entry.ts ?? entry.at,
          kind: 'message.arrived',
          session,
          record_id: id,
          to: seat,
          ...(entry.from !== undefined ? { from: entry.from } : {}),
          ...(entry.thread !== undefined ? { thread: entry.thread } : {}),
        });
        yield;
      }

      // Check `.pending` held drops in the seat's drop folder.
      for (const pending of readPending(seatDir)) {
        sendersById.set(pending.id, pending.from);
        raise({
          ts: pending.ts,
          kind: 'message.arrived',
          session,
          record_id: pending.id,
          from: pending.from,
          to: pending.to,
        });
        if (pending.leg !== 'mcp-inbox') {
          const heldAgeMs = nowMs - Date.parse(pending.ts);
          if (!Number.isFinite(heldAgeMs) || heldAgeMs >= heldThresholdMs) {
            raise({
              ts: pending.ts,
              kind: 'message.held',
              session,
              record_id: `${pending.id}:held`,
              from: pending.from,
              to: pending.to,
            });
          }
        }
        yield;
      }

      // Check receipts (`.delivered`, `.read`, `.replied`) beside drops. A receipt's stat stamp
      // is enough to raise it; only a new or touched file is stamped again. The sender comes from
      // this listing, from the map the preceding pass left, or — after any number of quiet passes,
      // or a restart — from the arrival event the log still holds for that record.
      for (const file of files) {
        if (file.startsWith('.')) continue;
        const fullPath = join(seatDir, file);
        const receipt = receiptOf(file);
        if (receipt === null || !RECORD_NAME.test(receipt.id)) continue;
        const fresh = fileStampOf(fullPath);
        if (fresh === null) continue;
        let entry = cachedEntry(state, seatDir, file, fresh.stamp);
        if (entry === null || entry.kind !== 'receipt') {
          entry = { kind: 'receipt', receipt: receipt.receipt, id: receipt.id, at: fresh.mtimeIso };
          storeEntry(state, seatDir, file, fresh.stamp, entry);
        } else {
          stats.filesReused += 1;
        }
        const from = sendersById.get(entry.id) ?? previousSenders?.get(entry.id) ?? arrivedFrom.get(`${seat}\0${entry.id}`);
        raise({
          ts: entry.at,
          kind: entry.receipt === 'delivered' ? 'message.delivered' : entry.receipt === 'read' ? 'message.read' : 'message.replied',
          session,
          record_id: `${entry.id}:${entry.receipt}`,
          to: seat,
          ...(from !== undefined ? { from } : {}),
        });
        yield;
      }

      state.senders.set(seatDir, sendersById);
    }
  }

  // 2. Scan signed `.agents/messages/<seat>` records and `.read.json` receipts.
  const messagesDir = join(root, '.agents', 'messages');
  const keyState = messageKeyState(home);
  const signedSeatNames = listDir(state, messagesDir, visited);
  if (signedSeatNames !== null && keyState.kind === 'key') {
    const keyPrint = keyPrintOf(keyState);
    const seats = [...signedSeatNames].sort(compareSeatNames);
    for (const seat of seats) {
      if (!RECORD_NAME.test(seat)) continue;
      const seatDir = join(messagesDir, seat);
      if (!isRealDir(seatDir)) continue;
      visited.add(seatDir);
      const files = listDir(state, seatDir, visited) ?? [];
      const messageSenders = new Map<string, string>();
      const previousSenders = state.signedSenders.get(seatDir);
      for (const file of files) {
        if (!file.endsWith('.json') || file.endsWith('.read.json')) continue;
        const id = file.slice(0, -'.json'.length);
        if (!RECORD_NAME.test(id)) continue;
        const fullPath = join(seatDir, file);
        const fresh = fileStampOf(fullPath);
        if (fresh === null) continue;
        let entry = cachedEntry(state, seatDir, file, fresh.stamp);
        if (entry === null || entry.kind !== 'message' || entry.keyPrint !== keyPrint) {
          let next: MessageEntry = { kind: 'message', keyPrint, verified: false, at: nowIso, ownerDigest: false };
          try {
            const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as Record<string, unknown>;
            const payload = parsed.payload as Record<string, unknown> | undefined;
            const sig = parsed.signature;
            if (payload && typeof sig === 'string') {
              stats.verifies += 1;
              if (
                payload.kind === 'message' &&
                payload.id === id &&
                payload.to === seat &&
                payload.session === session &&
                verifyDomain(MESSAGE_DOMAIN, payload as unknown as Json, sig, keyState.key)
              ) {
                const from = typeof payload.from === 'string' ? payload.from : undefined;
                const at = typeof payload.at === 'string' ? payload.at : nowIso;
                next = {
                  kind: 'message',
                  keyPrint,
                  verified: true,
                  at,
                  ownerDigest: isOwnerDigestRecord(id, from),
                  ...(from !== undefined ? { from } : {}),
                };
              }
            }
          } catch {
            // An unreadable record stayed unraised before; the cached verdict keeps it that way
            // until its bytes change.
          }
          entry = next;
          stats.filesRead += 1;
          storeEntry(state, seatDir, file, fresh.stamp, entry);
        } else {
          stats.filesReused += 1;
          stats.verifiesReused += 1;
        }
        if (!entry.verified) continue;
        const from = entry.from;
        if (from !== undefined) messageSenders.set(id, from);
        // The Runtime writes its own owner delivery summaries into the same mailbox. A digest is
        // a summary of events already in the log, not a message: raising `message.arrived` for it
        // would deliver it again, and the next pass would summarize that summary, forever.
        if (entry.ownerDigest) continue;
        raise({
          ts: entry.at,
          kind: 'message.arrived',
          session,
          record_id: id,
          to: seat,
          ...(from !== undefined ? { from } : {}),
        });
        yield;
      }
      for (const file of files) {
        if (!file.endsWith('.read.json')) continue;
        const id = file.slice(0, -'.read.json'.length);
        if (!RECORD_NAME.test(id)) continue;
        const fullPath = join(seatDir, file);
        const fresh = fileStampOf(fullPath);
        if (fresh === null) continue;
        let entry = cachedEntry(state, seatDir, file, fresh.stamp);
        if (entry === null || entry.kind !== 'signed-receipt' || entry.keyPrint !== keyPrint) {
          let next: SignedReceiptEntry = { kind: 'signed-receipt', keyPrint, verified: false, id, at: nowIso };
          try {
            const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as Record<string, unknown>;
            const payload = parsed.payload as Record<string, unknown> | undefined;
            const sig = parsed.signature;
            if (payload && typeof sig === 'string') {
              stats.verifies += 1;
              if (
                payload.kind === 'receipt' &&
                payload.id === id &&
                payload.to === seat &&
                payload.session === session &&
                verifyDomain(RECEIPT_DOMAIN, payload as unknown as Json, sig, keyState.key)
              ) {
                next = {
                  kind: 'signed-receipt',
                  keyPrint,
                  verified: true,
                  id,
                  at: typeof payload.at === 'string' ? payload.at : nowIso,
                };
              }
            }
          } catch {
            // Same rule as a signed message: an unreadable record raises nothing.
          }
          entry = next;
          stats.filesRead += 1;
          storeEntry(state, seatDir, file, fresh.stamp, entry);
        } else {
          stats.filesReused += 1;
          stats.verifiesReused += 1;
        }
        if (!entry.verified) continue;
        const from = messageSenders.get(id) ?? previousSenders?.get(id) ?? arrivedFrom.get(`${seat}\0${id}`);
        raise({
          ts: entry.at,
          kind: 'message.read',
          session,
          record_id: `${id}:read`,
          to: seat,
          ...(from !== undefined ? { from } : {}),
        });
        yield;
      }
      state.signedSenders.set(seatDir, messageSenders);
    }
  }

  // 3. Scan `messages.jsonl` history entries for outcomes not yet reflected in `events.jsonl`.
  if (state.history !== null) {
    const stamp = retainedStamp(state.history.path, HISTORY_KEPT);
    if (stamp !== state.history.stamp) state.history = null;
  }
  if (state.history === null) {
    const read = readHistory(project, root, home);
    if (read.ok) {
      state.history = { path: read.path, stamp: retainedStamp(read.path, HISTORY_KEPT), entries: read.entries };
    }
  }
  const history = state.history;
  if (history !== null) {
    for (const entry of history.entries) {
      raise({
        ts: entry.ts,
        kind: 'message.arrived',
        session,
        record_id: entry.id,
        from: entry.from,
        to: entry.to,
        ...(entry.via !== undefined ? { via: entry.via } : {}),
      });
      if (entry.outcome === 'delivered') {
        raise({
          ts: entry.ts,
          kind: 'message.delivered',
          session,
          record_id: `${entry.id}:delivered`,
          from: entry.from,
          to: entry.to,
          ...(entry.via !== undefined ? { via: entry.via } : {}),
        });
      } else if (entry.outcome === 'delivered (read)') {
        raise({
          ts: entry.ts,
          kind: 'message.delivered',
          session,
          record_id: `${entry.id}:delivered`,
          from: entry.from,
          to: entry.to,
          ...(entry.via !== undefined ? { via: entry.via } : {}),
        });
        raise({
          ts: entry.ts,
          kind: 'message.read',
          session,
          record_id: `${entry.id}:read`,
          from: entry.from,
          to: entry.to,
          ...(entry.via !== undefined ? { via: entry.via } : {}),
        });
      } else if (entry.outcome === 'answered') {
        raise({
          ts: entry.ts,
          kind: 'message.replied',
          session,
          record_id: `${entry.id}:replied`,
          from: entry.from,
          to: entry.to,
        });
      } else if (entry.outcome === 'held') {
        const heldAgeMs = nowMs - Date.parse(entry.ts);
        if (!Number.isFinite(heldAgeMs) || heldAgeMs >= heldThresholdMs) {
          raise({
            ts: entry.ts,
            kind: 'message.held',
            session,
            record_id: `${entry.id}:held`,
            from: entry.from,
            to: entry.to,
          });
        }
      } else if (entry.outcome === 'unreachable') {
        raise({
          ts: entry.ts,
          kind: 'seat.unreachable',
          session,
          record_id: `${entry.id}:unreachable`,
          seat: entry.to,
          subject: entry.to,
        });
      }
      yield;
    }
  }

  // 4. Scan `.agents/team.state.json` for seat state transitions newer than their last event.
  const stateFile = readState(join(root, '.agents'));
  const sessionState = stateFile.sessions[session];
  if (sessionState !== undefined) {
    const seatNames = Object.keys(sessionState.seats).sort(compareSeatNames);
    for (const seatName of seatNames) {
      const seatRecord = sessionState.seats[seatName];
      if (!seatRecord) continue;
      const activeTs = seatRecord.last_active;
      if (typeof activeTs !== 'string' || !Number.isFinite(Date.parse(activeTs))) continue;
      const prevTs = lastSeatEventTs.get(seatName);
      if (prevTs !== undefined && Date.parse(activeTs) <= Date.parse(prevTs)) continue;
      const kind = seatRecord.stage === 'ready' ? 'seat.working' : 'seat.idle';
      const persisted = raise({
        ts: activeTs,
        kind,
        session,
        record_id: `seat:${seatName}:${seatRecord.stage}:${activeTs}`,
        seat: seatName,
        subject: seatName,
      });
      // The watermark moves only once the event is in the log, or was already there. A refused
      // append leaves it behind, so the next pass raises the same transition again instead of
      // treating an event that was never written as delivered.
      if (persisted) lastSeatEventTs.set(seatName, activeTs);
      yield;
    }
  }

  // 5. Scan the four signed settings records for a signed generation with no `config.changed`
  //    event. A write that crashed between replacing its record and appending
  //    its event loses time, not the event: the pass appends one marked reconciled, once.
  {
    const teamId = teamIdOf(root);
    let teamRecord: ReturnType<typeof getTeam> = null;
    try {
      teamRecord = getTeam(home, teamId);
    } catch {
      teamRecord = null;
    }
    if (teamRecord !== null) {
      const sources: { read: ConfigSourceRead; seat?: string }[] = [];
      if (teamRecord.entity) sources.push({ read: readEntityConfigSource(home, teamRecord.entity) });
      if (teamRecord.projectId) sources.push({ read: readProjectConfigSource(home, teamRecord.projectId) });
      sources.push({ read: readTeamConfigSource(home, teamId) });
      for (const line of teamRecord.roster) {
        sources.push({ read: readSeatConfigSource(home, line.agent, line.seat), seat: line.seat });
      }
      for (const source of sources) {
        // A record that does not verify raises nothing: a pass that cannot read a signed value
        // does not invent an event for it.
        if (!source.read.ok) continue;
        for (const setting of source.read.settings) {
          const recordId = configChangedRecordId(setting);
          if (configSeen.has(recordId)) continue;
          const change: ConfigChange = {
            ts: setting.date,
            session,
            level: setting.level,
            target: setting.target,
            key: setting.key,
            // The record keeps the value, not the value it replaced.
            old: null,
            value: setting.value,
            generation: setting.generation,
            from: 'owner',
            ...(source.seat !== undefined ? { seat: source.seat, subject: source.seat } : {}),
            reconciled: true,
          };
          if (aborted()) return cancelledResult();
          const res = appendConfigChanged(project, root, home, change, {
            ...(options.appendWaitMs !== undefined ? { lockWaitMs: options.appendWaitMs } : {}),
          });
          if (!res.ok) {
            // A held lock is worth retrying in this process; the setting stays unseen otherwise,
            // so the next pass raises it again when the lock has not freed either.
            if (res.busy === true && defersBusy) state.deferred.push({ kind: 'config', change });
            continue;
          }
          configSeen.add(recordId);
          if (!res.duplicate) {
            raised.push(res.record);
            options.onEvent?.(res.record);
          }
        }
        yield;
      }
    }
  }

  // A folder that disappeared takes its caches with it; a sender map for a folder this pass did
  // not list is no longer a fact about the current records.
  for (const key of state.dirs.keys()) {
    if (!visited.has(key)) state.dirs.delete(key);
  }
  for (const key of state.senders.keys()) {
    if (!visited.has(key)) state.senders.delete(key);
  }
  for (const key of state.signedSenders.keys()) {
    if (!visited.has(key)) state.signedSenders.delete(key);
  }

  return { ok: true, raised, checked: cachedLog.checked, full: cachedLog.full };
}

/** The whole pass, without giving the event loop a turn. */
export function reconcilePass(options: ReconcileOptions): ReconcileResult {
  const steps = reconcileSteps(options);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** One turn of the event loop: macrotasks (timers, socket I/O) and the microtask queue both get
 *  to run before the next slice of the pass. */
function yieldTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

type DeferredOutcome =
  | { state: 'written'; record: SignedEventRecord; duplicate: boolean }
  | { state: 'busy' }
  | { state: 'failed' };

/** One non-blocking attempt at a deferred append: 0 for the lock wait means a held lock answers
 *  at once instead of pausing this process. */
function tryDeferredAppend(options: ReconcileOptions, item: DeferredAppend): DeferredOutcome {
  const appended =
    item.kind === 'event'
      ? appendEvent(options.project, options.root, options.home, item.input, {
          maxBytes: options.maxBytes,
          kept: options.kept,
          deduplicate: true,
          lockWaitMs: 0,
        })
      : appendConfigChanged(options.project, options.root, options.home, item.change, { lockWaitMs: 0 });
  if (appended.ok) return { state: 'written', record: appended.record, duplicate: appended.duplicate };
  return appended.busy === true ? { state: 'busy' } : { state: 'failed' };
}

/**
 * Waits for records a pass could not append while another process held the event lock. Every
 * attempt is non-blocking and the pause between them gives the event loop a turn, so a held lock
 * costs latency, never liveness. A record still held past the budget is left for the next pass:
 * the seat watermark and config cursor were not advanced, so the pass will find it again.
 */
async function retryDeferredAppends(
  options: ReconcileOptions,
  state: ReconcileState,
  raised: SignedEventRecord[],
): Promise<void> {
  let pending = state.deferred;
  if (pending.length === 0) return;
  const deadline = performance.now() + (options.appendRetryMs ?? DEFAULT_APPEND_RETRY_MS);
  for (;;) {
    // A cancelled pass stops retrying before its next attempt; the record stays for the next
    // pass, since no cursor advanced past it.
    if (options.signal?.aborted === true) {
      state.deferred = [];
      return;
    }
    const busy: DeferredAppend[] = [];
    for (const item of pending) {
      const outcome = tryDeferredAppend(options, item);
      if (outcome.state === 'busy') busy.push(item);
      else if (outcome.state === 'written' && !outcome.duplicate) {
        // The same fan-out the pass would have made for this record.
        raised.push(outcome.record);
        options.onEvent?.(outcome.record);
      }
      // A failure that is not a held lock is left to the next pass as well.
    }
    pending = busy;
    if (pending.length === 0 || performance.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, APPEND_RETRY_STEP_MS));
  }
  state.deferred = [];
}

/**
 * The whole pass in slices. Between slices the event loop is free, so a heartbeat timer, a
 * liveness probe or an incoming request is answered while a large store is being scanned. The
 * result is the same pass `reconcilePass` returns; only the pacing differs.
 *
 * Appends are non-blocking here too: a record whose event lock is held is deferred and retried
 * on this driver's own async wait, so a contending writer slows the pass without stopping the
 * loop. The pass result carries the records that eventually landed. An aborted pass stops
 * between slices and before its next append, and answers as cancelled rather than as a failure.
 */
export async function reconcilePassAsync(options: ReconcileOptions): Promise<ReconcileResult> {
  const state = options.state ?? createReconcileState();
  const sliceMs = options.sliceMs ?? DEFAULT_RECONCILE_SLICE_MS;
  const steps = reconcileSteps({ ...options, state, appendWaitMs: 0 });
  let since = performance.now();
  for (;;) {
    // The slice boundary is also the cancellation point: the caller's abort (a closing bus)
    // stops the pass before it reads or appends anything else.
    if (options.signal?.aborted === true) return cancelledResult();
    const next = steps.next();
    if (next.done) {
      const result = next.value;
      if (result.ok) {
        await retryDeferredAppends(options, state, result.raised);
      }
      return result;
    }
    if (sliceMs < 0 || performance.now() - since < sliceMs) continue;
    state.stats.yields += 1;
    await yieldTurn();
    since = performance.now();
  }
}
