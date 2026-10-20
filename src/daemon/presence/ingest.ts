// The daemon's presence ingester: one instance per canonical route, created and driven by the
// machine daemon after it owns its lock (B5's host owns the shared 250 ms timer, the one-in-flight
// guard per route and cleanup). This module never starts a timer, a service or a second daemon.
//
// One step is a bounded asynchronous batch: a spool folder is listed, at most `maxRecords`
// records are considered, and at most `maxRecordBytes` is read from any one record. A step never
// scans the whole log: the durable index (ids already applied, the last seq, the newest line) is
// loaded once per seat, chunked with awaits so other routes keep running, and every later step
// appends from memory. A load that fails for I/O is retried after a short delay, not on every
// beat; a log that is structurally corrupt is faulted once and left alone.
//
// Durability boundary (stated exactly, no more): a record is consumed from the spool only after
// its line was appended and fsynced. The log is the source of truth; `current.json` is rebuilt
// from it whenever the two disagree, including after a crash between append and projection write.
// At startup every id in the log is in the dedupe set, so a replayed spool file — old or new —
// never appends a second line. An incomplete trailing line (a crash mid-append) is truncated
// before the next append. This is at-most-once *within one log this daemon owned*; concurrent
// writers are excluded by the daemon's own single-instance ownership, not by this module.
//
// Close quiesces: it refuses new steps, awaits the one in-flight step, and only then writes the
// final `stopped` channel record and resolves. It never releases anything early and has no
// timeout; if an fs write cannot complete, close stays pending, which is the honest state.
import { constants, type Dirent } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, truncate, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { STATE_FILE } from '../../state.ts';
import {
  PRESENCE_FORMAT, PRESENCE_STATE_OF, isPresenceBinding, presenceFutureBeyond, presenceNewer,
  readPresenceLogLine, readPresenceReading, readPresenceRecord,
  type PresenceLogLine, type PresenceReading, type PresenceRecord, type PresenceStatus,
} from './contract.ts';
import {
  isPresenceSeatName, presencePaths, presenceSessionDir, presenceStatusPath, type PresencePaths,
} from './spool.ts';

/** The bounded batch defaults the daemon host should pass through unchanged. */
export const PRESENCE_MAX_RECORDS_PER_STEP = 64;
export const PRESENCE_MAX_RECORD_BYTES = 64 * 1024;
export const PRESENCE_LOG_CHUNK_BYTES = 64 * 1024;
/** The ingester's own channel record is refreshed at most this often when nothing changes. */
export const PRESENCE_STATUS_HEARTBEAT_MS = 5_000;
/** A failed index load is retried after this delay, never on every beat. */
export const PRESENCE_LOAD_RETRY_MS = 5_000;

export type PresenceRefusal = { seat: string; id: string; why: string };

/** What one bounded step did. `pending` means a later step has more spool work on this route. */
export type PresenceIngestResult = {
  ingested: PresenceLogLine[];
  rejected: PresenceRefusal[];
  stale: PresenceRefusal[];
  repaired: string[];
  errors: PresenceRefusal[];
  pending: boolean;
  closed: boolean;
};

export type PresenceIngestInput = {
  /** The team file's folder (today `.agents`), never the checkout root. */
  stateDir: string;
  session: string;
  maxRecords?: number;
  maxRecordBytes?: number;
  now?: () => Date;
  /** The durable line writer. Production uses the fsync'd append above; a test replaces it to
   *  stage the failure this module must survive: bytes that landed while fsync failed. */
  append?: (path: string, line: PresenceLogLine) => Promise<void>;
};

export type PresenceCloseResult = { quiesced: true };

export type PresenceIngester = {
  /** One bounded, asynchronous batch. A call while a step is in flight returns that same step,
   *  so there is never more than one in-flight batch per route. After `close()` it returns a
   *  closed result without doing work. */
  step(): Promise<PresenceIngestResult>;
  /** Refuses new steps, awaits the in-flight one (including any write already started), then
   *  writes the final channel record. Resolves only when no further write can start. */
  close(): Promise<PresenceCloseResult>;
  isClosed(): boolean;
};

type SeatIndex = {
  loaded: boolean;
  faulted: string | null;
  faultReported: boolean;
  retryAt: number;
  seq: number;
  seen: Set<string>;
  /** The newest applied line for `currentBinding`, or null when that binding has none yet. */
  current: PresenceLogLine | null;
  /** Which binding `current` belongs to. A successor launch moves it without a log reload. */
  currentBinding: string | null;
  selected: boolean;
  /** The newest applied line per binding, from the whole log. Filtering by the current binding
   *  keeps a predecessor's later-clocked event from gating a successor's projection. */
  newest: Map<string, PresenceLogLine>;
  projectionDirty: boolean;
};

class PresenceLogFault extends Error {}

function emptyResult(closed = false): PresenceIngestResult {
  return { ingested: [], rejected: [], stale: [], repaired: [], errors: [], pending: false, closed };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Appends one line and returns only after the kernel has it on disk. */
async function appendDurable(path: string, line: PresenceLogLine): Promise<void> {
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.write(`${JSON.stringify(line)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function readingOf(line: PresenceLogLine): PresenceReading {
  const reading: PresenceReading = {
    v: PRESENCE_FORMAT,
    seq: line.seq,
    id: line.id,
    state: line.state,
    source: line.source,
    event: line.event,
    binding: line.binding,
    since: line.ts,
    observedAt: line.observedAt,
  };
  if (line.raw !== undefined) reading.raw = line.raw;
  return reading;
}

function sameReading(reading: PresenceReading, line: PresenceLogLine): boolean {
  return reading.seq === line.seq
    && reading.id === line.id
    && reading.state === line.state
    && reading.source === line.source
    && reading.event === line.event
    && reading.binding === line.binding
    && reading.since === line.ts
    && reading.observedAt === line.observedAt
    && reading.raw === line.raw;
}

/** Replaces `current.json` atomically, 0600. */
async function writeReading(path: string, line: PresenceLogLine): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.write(`${JSON.stringify(readingOf(line))}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    try { await unlink(temporary); } catch { /* the temp file is not evidence */ }
    throw error;
  }
}

/** The canonical (ts, id) order for one batch, oldest first. Two events at the same instant are
 *  ordered by id so every replay and every projection rebuild agrees. */
function byEventOrder(a: { ts: string; id: string }, b: { ts: string; id: string }): number {
  if (presenceNewer(a, b)) return 1;
  if (presenceNewer(b, a)) return -1;
  return 0;
}

export function createPresenceIngester(input: PresenceIngestInput): PresenceIngester {
  const maxRecords = input.maxRecords ?? PRESENCE_MAX_RECORDS_PER_STEP;
  const maxRecordBytes = input.maxRecordBytes ?? PRESENCE_MAX_RECORD_BYTES;
  if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new Error('presence ingester needs maxRecords >= 1');
  if (!Number.isInteger(maxRecordBytes) || maxRecordBytes < 256) {
    throw new Error('presence ingester needs maxRecordBytes >= 256');
  }
  const now = input.now ?? (() => new Date());
  const append = input.append ?? appendDurable;
  const stateDir = input.stateDir;
  const session = input.session;
  const indexes = new Map<string, SeatIndex>();
  let inFlight: Promise<PresenceIngestResult> | null = null;
  let closing = false;
  let seatCursor = 0;
  let everSawSpool = false;
  let startedAt = '';
  let lastStepAt = '';
  let lastSuccessAt: string | null = null;
  let lastStatus: PresenceStatus | null = null;
  let lastStatusWrite = 0;

  function indexFor(seat: string): SeatIndex {
    const kept = indexes.get(seat);
    if (kept !== undefined) return kept;
    const made: SeatIndex = {
      loaded: false, faulted: null, faultReported: false, retryAt: 0,
      seq: 0, seen: new Set(), current: null, currentBinding: null, selected: false,
      newest: new Map(), projectionDirty: false,
    };
    indexes.set(seat, made);
    return made;
  }

  // The state record is re-read only when its identity changes: one stat per seat per batch
  // (and one more before every commit), never a whole-file parse on every beat. `dev`+`ino`
  // catch the atomic replace a launch performs, so a same-size write at the same timestamp
  // cannot hide behind mtime+size alone; any content re-read is keyed by the full identity.
  type BindingCache = {
    dev: number; ino: number; mtimeMs: number; size: number; seats: Map<string, string>;
  };
  let bindingCache: BindingCache | null = null;

  /** The seat's current runtime incarnation, read from the managed state record. A missing state
   *  file or a missing field is "no binding" (fail closed to last-known); a malformed state is an
   *  error that leaves the spool untouched and is retried. */
  async function bindingFor(seat: string): Promise<{ kind: 'ok'; binding: string | null } | { kind: 'error'; why: string }> {
    const path = join(stateDir, STATE_FILE);
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') {
        bindingCache = null;
        return { kind: 'ok', binding: null };
      }
      return { kind: 'error', why: `the seat state is unreadable: ${messageOf(error)}` };
    }
    if (bindingCache !== null && bindingCache.dev === info.dev && bindingCache.ino === info.ino
      && bindingCache.mtimeMs === info.mtimeMs && bindingCache.size === info.size) {
      return { kind: 'ok', binding: bindingCache.seats.get(seat) ?? null };
    }
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      return { kind: 'error', why: `the seat state is unreadable: ${messageOf(error)}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      bindingCache = null;
      return { kind: 'error', why: 'the seat state is not JSON' };
    }
    const state = parsed as { format?: unknown; sessions?: unknown } | null;
    if (!state || typeof state !== 'object' || state.format !== 1 || !state.sessions || typeof state.sessions !== 'object') {
      bindingCache = null;
      return { kind: 'error', why: 'the seat state is not a team state of format 1' };
    }
    const sessions = state.sessions as Record<string, unknown>;
    const one = sessions[session] as { seats?: unknown } | undefined;
    const seats = one !== null && typeof one === 'object' ? one.seats : undefined;
    const found = new Map<string, string>();
    if (seats !== null && typeof seats === 'object') {
      for (const [name, entry] of Object.entries(seats as Record<string, unknown>)) {
        const value = entry !== null && typeof entry === 'object'
          ? (entry as { presence_binding?: unknown }).presence_binding
          : undefined;
        if (isPresenceBinding(value)) found.set(name, value);
      }
    }
    bindingCache = { dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, size: info.size, seats: found };
    return { kind: 'ok', binding: found.get(seat) ?? null };
  }

  /** Points the projection at one binding without touching id dedupe or the global seq. A
   *  successor incarnation starts from its own newest line, even when a predecessor's event has
   *  a later clock; with no line of its own yet there is no projection to serve. */
  function selectBinding(index: SeatIndex, binding: string | null): void {
    if (index.selected && binding === index.currentBinding) return;
    index.selected = true;
    index.currentBinding = binding;
    index.current = binding === null ? null : index.newest.get(binding) ?? null;
    index.projectionDirty = true;
  }

  async function moveAside(paths: PresencePaths, kind: 'rejected' | 'stale', source: string, name: string): Promise<void> {
    const dir = kind === 'rejected' ? paths.rejected : paths.stale;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await rename(source, join(dir, name));
  }

  async function consume(path: string, seat: string, id: string, result: PresenceIngestResult): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') {
        result.errors.push({ seat, id, why: `the spool record was appended but not consumed: ${messageOf(error)}` });
      }
    }
  }

  async function refuse(
    paths: PresencePaths,
    kind: 'rejected' | 'stale',
    path: string,
    name: string,
    seat: string,
    id: string,
    why: string,
    result: PresenceIngestResult,
  ): Promise<void> {
    if (closing) return;
    try {
      await moveAside(paths, kind, path, name);
      (kind === 'rejected' ? result.rejected : result.stale).push({ seat, id, why });
    } catch (error) {
      result.errors.push({ seat, id, why: `the record could not be moved to ${kind}: ${messageOf(error)}` });
    }
  }

  async function readCandidate(
    paths: PresencePaths,
    name: string,
    seat: string,
    binding: string | null,
    result: PresenceIngestResult,
  ): Promise<PresenceRecord | null> {
    const path = join(paths.spool, name);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return null;
      result.errors.push({ seat, id: name.replace(/\.json$/, ''), why: `the spool record could not be opened: ${messageOf(error)}` });
      return null;
    }
    try {
      const stat = await handle.stat();
      const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
      if (!stat.isFile()) {
        await refuse(paths, 'rejected', path, name, seat, id, 'the spool record is not a regular file', result);
        return null;
      }
      if (stat.size > maxRecordBytes) {
        await refuse(paths, 'rejected', path, name, seat, id, `the spool record is larger than ${String(maxRecordBytes)} bytes`, result);
        return null;
      }
      const read = readPresenceRecord(await handle.readFile('utf8'));
      if (read.kind === 'bad') {
        await refuse(paths, 'rejected', path, name, seat, id, read.why, result);
        return null;
      }
      const record = read.record;
      if (`${record.id}.json` !== name) {
        await refuse(paths, 'rejected', path, name, seat, id, 'the file name is not the record id', result);
        return null;
      }
      if (record.session !== session || record.seat !== seat) {
        await refuse(paths, 'rejected', path, name, seat, id, 'the record names another session or seat', result);
        return null;
      }
      if (presenceFutureBeyond(record.ts, now())) {
        await refuse(paths, 'rejected', path, name, seat, id, 'the event time is too far in the future', result);
        return null;
      }
      if (binding === null) {
        await refuse(paths, 'stale', path, name, seat, id, 'the seat has no current runtime binding', result);
        return null;
      }
      if (record.binding !== binding) {
        await refuse(paths, 'stale', path, name, seat, id, 'the record is from a predecessor runtime incarnation', result);
        return null;
      }
      return record;
    } finally {
      await handle.close();
    }
  }

  async function reconcileProjection(
    paths: PresencePaths,
    current: PresenceLogLine | null,
    result: PresenceIngestResult,
  ): Promise<void> {
    let text: string | null = null;
    try {
      text = await readFile(paths.current, 'utf8');
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
    }
    if (current === null) {
      if (text !== null && !closing) {
        try {
          await unlink(paths.current);
          result.repaired.push(`${paths.root}: removed a projection with no log line`);
        } catch (error) {
          if (codeOf(error) !== 'ENOENT') throw error;
        }
      }
      return;
    }    if (text !== null) {
      const read = readPresenceReading(text);
      if (read.kind === 'ok' && sameReading(read.reading, current)) return;
    }
    if (closing) return;
    await writeReading(paths.current, current);
    result.repaired.push(`${paths.root}: rebuilt the projection from the log`);
  }

  /** Reconciles the selected projection. A current binding with no line of its own while the
   *  log holds another incarnation's lines is not an orphan: the existing projection stays as
   *  last-known, and the reader sees its binding differ from the state. An empty log still
   *  removes a projection with nothing behind it. */
  async function reconcileSelected(
    paths: PresencePaths,
    index: SeatIndex,
    result: PresenceIngestResult,
  ): Promise<void> {
    if (index.current === null && index.seen.size > 0) return;
    await reconcileProjection(paths, index.current, result);
  }

  /** Chunked log scan: rebuilds every id in the dedupe set, the last seq and the newest applied
   *  line *per binding*, and truncates an incomplete trailing line explicitly. A structurally
   *  corrupt line is a fault, not something this process repairs. The projection is then selected
   *  for the binding this launch actually owns, never for a predecessor's later-clocked event. */
  async function loadIndex(
    paths: PresencePaths,
    index: SeatIndex,
    binding: string | null,
    result: PresenceIngestResult,
  ): Promise<void> {
    // The scan rebuilds the view from the log: a reload after an uncertain append must not
    // inherit a single id, seq or line from the batch that happened before it.
    index.seen = new Set();
    index.newest = new Map();
    index.seq = 0;
    index.current = null;
    index.currentBinding = null;
    index.selected = false;
    index.projectionDirty = false;
    let handle;
    try {
      handle = await open(paths.log, 'r+');
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
      selectBinding(index, binding);
      await reconcileSelected(paths, index, result);
      index.projectionDirty = false;
      index.loaded = true;
      return;
    }
    try {
      const size = (await handle.stat()).size;
      let pending = Buffer.alloc(0);
      let seenBytes = 0;
      let position = 0;
      let expectedSeq = 1;
      while (position < size) {
        if (closing) return;
        const chunk = Buffer.alloc(PRESENCE_LOG_CHUNK_BYTES);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const data = pending.length === 0
          ? chunk.subarray(0, bytesRead)
          : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        let from = 0;
        for (;;) {
          const newline = data.indexOf(0x0a, from);
          if (newline === -1) break;
          const text = data.subarray(from, newline).toString('utf8');
          const line = readPresenceLogLine(text);
          if ('why' in line) throw new PresenceLogFault(`log line ${String(expectedSeq)} is not a presence line: ${line.why}`);
          if (line.seq !== expectedSeq) throw new PresenceLogFault(`log line ${String(expectedSeq)} carries seq ${String(line.seq)}`);
          if (index.seen.has(line.id)) throw new PresenceLogFault(`the log repeats event id ${line.id}`);
          index.seen.add(line.id);
          index.seq = line.seq;
          if (line.applied) {
            const known = index.newest.get(line.binding);
            if (known === undefined || presenceNewer(line, known)) index.newest.set(line.binding, line);
          }
          expectedSeq++;
          from = newline + 1;
        }
        pending = Buffer.from(data.subarray(from));
        seenBytes += from;
        if (pending.length > maxRecordBytes) {
          throw new PresenceLogFault('a log line is longer than the record limit');
        }
      }
      if (pending.length > 0) {
        if (closing) return;
        await handle.truncate(seenBytes);
        await handle.sync();
        result.repaired.push(`${paths.root}: truncated an incomplete trailing log line`);
      }
    } finally {
      await handle.close();
    }
    selectBinding(index, binding);
    await reconcileSelected(paths, index, result);
    index.projectionDirty = false;
    index.loaded = true;
  }

  async function writeStatus(
    state: PresenceStatus['state'],
    error: string | null,
    result: PresenceIngestResult | null,
    force = false,
  ): Promise<void> {
    const path = presenceStatusPath(stateDir, session);
    if (path === null || (closing && state !== 'stopped')) return;
    const at = now().toISOString();
    const stamp = Date.parse(at);
    lastStepAt = at;
    // A clean serving step is a success; a serving step that carries an error is not, and the
    // stamp keeps the last clean instant rather than advancing on every failed beat.
    if (state === 'serving' && error === null) lastSuccessAt = at;
    if (!force && lastStatus !== null && lastStatus.state === state && lastStatus.error === error
      && stamp - lastStatusWrite < PRESENCE_STATUS_HEARTBEAT_MS) {
      return;
    }
    const status: PresenceStatus = {
      v: PRESENCE_FORMAT,
      session,
      state,
      pid: process.pid,
      startedAt,
      lastStepAt,
      lastSuccessAt,
      heartbeatAt: at,
      error,
      stoppedAt: state === 'stopped' ? at : null,
    };
    try {
      // The status record is not a log line; it is written through the same atomic recipe.
      const temporary = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
      const handle = await open(temporary, 'w', 0o600);
      try {
        await handle.chmod(0o600);
        await handle.write(`${JSON.stringify(status)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      lastStatus = status;
      lastStatusWrite = stamp;
    } catch (failure) {
      if (result !== null) result.errors.push({ seat: '', id: '', why: `the channel record could not be written: ${messageOf(failure)}` });
    }
  }

  async function runOnce(): Promise<PresenceIngestResult> {
    const result = emptyResult();
    const sessionDir = presenceSessionDir(stateDir, session);
    if (sessionDir === null) return result;
    let entries: Dirent[];
    try {
      entries = await readdir(sessionDir, { withFileTypes: true });
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return result;
      const why = `the presence session folder could not be read: ${messageOf(error)}`;
      result.errors.push({ seat: '', id: '', why });
      if (everSawSpool) await writeStatus('failed', why, result);
      return result;
    }
    const seats = entries.filter((entry) => entry.isDirectory() && isPresenceSeatName(entry.name))
      .map((entry) => entry.name).sort();
    let ordered = seats;
    if (seats.length > 0) {
      const start = seatCursor % seats.length;
      ordered = [...seats.slice(start), ...seats.slice(0, start)];
      seatCursor = (seatCursor + 1) % seats.length;
    }
    let budget = maxRecords;
    let fault: string | null = null;
    for (const seat of ordered) {
      const paths = presencePaths(stateDir, session, seat);
      if (paths === null) continue;
      let spoolEntries: Dirent[];
      try {
        spoolEntries = await readdir(paths.spool, { withFileTypes: true });
      } catch (error) {
        if (codeOf(error) === 'ENOENT') continue;
        result.errors.push({ seat, id: '', why: `the spool folder could not be read: ${messageOf(error)}` });
        continue;
      }
      everSawSpool = true;
      if (closing) {
        result.closed = true;
        result.pending = true;
        break;
      }
      const names = spoolEntries
        .filter((entry) => !entry.isDirectory() && entry.name.endsWith('.json') && !entry.name.startsWith('.'))
        .map((entry) => entry.name).sort();
      // The index loads even with an empty spool: a crash after consuming a record but before
      // writing `current.json` leaves the projection stale, and the next daemon must rebuild it
      // from the log without waiting for a new event. The load selects the projection for the
      // binding this launch owns, so a predecessor's log lines never seed a successor's state.
      const index = indexFor(seat);
      if (!index.loaded) {
        if (index.retryAt > now().getTime()) {
          result.pending = result.pending || names.length > 0;
          continue;
        }
        const beforeLoad = await bindingFor(seat);
        if (beforeLoad.kind === 'error') {
          result.errors.push({ seat, id: '', why: beforeLoad.why });
          continue;
        }
        try {
          await loadIndex(paths, index, beforeLoad.binding, result);
        } catch (error) {
          if (error instanceof PresenceLogFault) {
            // Reported on the step that found it, not only on a later beat: the channel turns
            // `failed` in the same status write this step performs.
            index.loaded = true;
            index.faulted = error.message;
            index.faultReported = true;
            fault = fault ?? error.message;
            result.errors.push({ seat, id: '', why: error.message });
          } else {
            index.loaded = false;
            index.seq = 0;
            index.current = null;
            index.currentBinding = null;
            index.selected = false;
            index.newest = new Map();
            index.seen = new Set();
            index.retryAt = now().getTime() + PRESENCE_LOAD_RETRY_MS;
            result.errors.push({ seat, id: '', why: `the presence log could not be loaded: ${messageOf(error)}` });
          }
          continue;
        }
      }
      if (index.faulted !== null) {
        fault = fault ?? index.faulted;
        if (!index.faultReported) {
          result.errors.push({ seat, id: '', why: index.faulted });
          index.faultReported = true;
        }
        continue;
      }
      if (names.length > 0) {
        if (budget <= 0) {
          result.pending = true;
          break;
        }
        const take = names.slice(0, budget);
        if (take.length < names.length) result.pending = true;
        // One identity check per batch; the binding is checked again before every commit.
        const binding = await bindingFor(seat);
        if (binding.kind === 'error') {
          result.errors.push({ seat, id: '', why: binding.why });
          continue;
        }
        selectBinding(index, binding.binding);
        const candidates: PresenceRecord[] = [];
        for (const name of take) {
          const candidate = await readCandidate(paths, name, seat, binding.binding, result);
          if (candidate !== null) candidates.push(candidate);
        }
        candidates.sort(byEventOrder);
        for (const record of candidates) {
          if (closing) {
            result.closed = true;
            result.pending = true;
            break;
          }
          budget--;
          if (index.seen.has(record.id)) {
            await consume(join(paths.spool, `${record.id}.json`), seat, record.id, result);
            continue;
          }
          // Revalidate the incarnation immediately before the commit: a launch that landed
          // while this batch was being read may have minted a successor, and no cached read
          // proves which runtime is current. A predecessor record is then set aside, never
          // applied to the successor.
          const beforeCommit = await bindingFor(seat);
          if (beforeCommit.kind === 'error') {
            result.errors.push({ seat, id: record.id, why: beforeCommit.why });
            result.pending = true;
            break;
          }
          if (!index.selected || beforeCommit.binding !== index.currentBinding) {
            selectBinding(index, beforeCommit.binding);
          }
          if (beforeCommit.binding === null || record.binding !== beforeCommit.binding) {
            await refuse(
              paths, 'stale', join(paths.spool, `${record.id}.json`), `${record.id}.json`, seat, record.id,
              beforeCommit.binding === null
                ? 'the seat has no current runtime binding'
                : 'the record is from a predecessor runtime incarnation',
              result,
            );
            // The remaining candidates were read under the previous binding; the next step
            // re-lists the spool under the successor.
            result.pending = true;
            break;
          }
          const applied = index.current === null || presenceNewer(record, index.current);
          const line: PresenceLogLine = {
            ...record,
            seq: index.seq + 1,
            observedAt: now().toISOString(),
            state: PRESENCE_STATE_OF[record.event],
            applied,
          };
          try {
            await append(paths.log, line);
          } catch (error) {
            // The append outcome is unknown: the bytes may have landed (a write can succeed
            // while fsync or close fails) or a torn line may be trailing. Never append the next
            // line against an unknown tail. The spool file stays, the index is dropped, and the
            // next step rebuilds it from the durable log before appending anything; if the line
            // did land, dedupe by id consumes the replay without a second line.
            result.errors.push({ seat, id: record.id, why: `the log append failed; its outcome is unknown: ${messageOf(error)}` });
            index.loaded = false;
            index.retryAt = 0;
            result.pending = true;
            break;
          }
          index.seen.add(record.id);
          index.seq = line.seq;
          result.ingested.push(line);
          if (applied) {
            const known = index.newest.get(line.binding);
            if (known === undefined || presenceNewer(line, known)) index.newest.set(line.binding, line);
            if (line.binding === index.currentBinding) {
              index.current = line;
              index.projectionDirty = true;
            }
          }
          await consume(join(paths.spool, `${record.id}.json`), seat, record.id, result);
        }
      }
      if (index.projectionDirty) {
        try {
          // Writes the current binding's newest applied line. When that binding has no line yet,
          // a predecessor's projection stays as last-known rather than being served as current.
          await reconcileSelected(paths, index, result);
          index.projectionDirty = false;
        } catch (error) {
          result.errors.push({ seat, id: '', why: `the projection could not be written: ${messageOf(error)}` });
        }
      }
      if (budget <= 0) {
        result.pending = true;
        break;
      }
    }
    if (everSawSpool) {
      // A structurally corrupt log is a dead channel for this process, not a serving one with a
      // message; the reader sees `failed` until a restart reloads and the seat recovers.
      if (fault !== null) await writeStatus('failed', fault, result);
      else await writeStatus('serving', result.errors[0]?.why ?? null, result);
    }
    return result;
  }

  startedAt = now().toISOString();
  lastStepAt = startedAt;

  return {
    step(): Promise<PresenceIngestResult> {
      if (closing) return Promise.resolve(emptyResult(true));
      if (inFlight !== null) return inFlight;
      let run: Promise<PresenceIngestResult>;
      run = runOnce().catch((error): PresenceIngestResult => {
        const failed = emptyResult(closing);
        failed.errors.push({ seat: '', id: '', why: messageOf(error) });
        return failed;
      }).finally(() => {
        if (inFlight === run) inFlight = null;
      });
      inFlight = run;
      return run;
    },
    async close(): Promise<PresenceCloseResult> {
      closing = true;
      const pending = inFlight;
      if (pending !== null) {
        try { await pending; } catch { /* step() already turns a throw into a result */ }
      }
      if (everSawSpool) await writeStatus('stopped', null, null, true);
      return { quiesced: true };
    },
    isClosed(): boolean {
      return closing;
    },
  };
}
