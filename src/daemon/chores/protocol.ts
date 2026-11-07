// The contract between the machine daemon and one chores child.
//
// The daemon owns the heartbeat, the machine socket and the health answer; a chores child owns
// the heavy per-root work — the fallback sweep and retirement, the reconcile scans, the presence
// history step and publisher, and a hosted watch's reads — and answers its heartbeat on time
// whatever that work is doing. One line of JSON is one frame in each direction, framed by a
// newline and bounded, and a child that stops answering its own heartbeat is ended and restarted
// by the supervisor, never waited for.
//
// Nothing here is a command line or a setting: a child is started only by the daemon's spawner
// through a one-use token, and the daemon's own policy decides where the chores run.

import type { TeamFile } from '../../file/types.ts';
import type { HostedWatchState } from '../../watch/hosted.ts';
import type { PresenceSourceStatus } from '../presence/health.ts';

/** The route's hosted watch, when the child was started to carry one. The path is the team file
 *  the daemon itself loaded: the watch's binding is that file's identity, so it crosses the token
 *  exactly as the daemon resolved it and is never re-derived from the child's working directory. */
export type ChoresWatchRoute = {
  teamFile: string;
  /** Whether the daemon relays per-seat presence health with every beat. False leaves the
   *  watch's presence answer unknown, exactly as a daemon without presence hosting does. */
  presence: boolean;
};

/** How the child was started: the roots it serves and the limits its supervisor gave it. The
 *  token file carries this; a child reads it once and serves from it. */
export type ChoresChildRoute = {
  root: string;
  team: string;
  session: string;
  /** The team file's folder, where the seat state door and the presence spool live. The daemon
   *  reads it from the loader's own path, so the child's presence pass reads the same store. */
  stateDir?: string;
  /** The validated team file the daemon hosted this root with, carried so the child's chores
   *  read the same snapshot instead of reading the file again. Absent in a hand-built token,
   *  where the pass reads the root's team file itself. */
  teamFile?: TeamFile;
  /** The hosted watch this child carries for the root. Absent: the root's watch stays on the
   *  daemon's own loop, exactly as before the isolation. */
  watch?: ChoresWatchRoute;
};

/** One declared seat's presence health as the daemon measured it at the beat it carries. The
 *  child answers its watch's dispatcher from the latest snapshot; no proof or badge crosses.
 *  `reason` is the daemon's measured detail when it answered unhealthy: display only, carried so
 *  the stuck report can name the channel in the daemon's own words. */
export type ChoresWatchSeatHealth = { seat: string; healthy: boolean; reason?: string | null };

/** One seat's runtime reading as the daemon measured it, or the reason it could not be taken.
 *  The child reconciles it against the canonical projection; the daemon keeps the source, its
 *  live health answer and the final re-check, so only the measured words cross the frame. */
export type ChoresPresenceReading =
  | { seat: string; status: ChoresPresenceStatus }
  | { seat: string; failed: string };

/** The JSON-safe fields of a presence source reading: the source's own measured words, exactly
 *  as the daemon holds them in memory. */
export type ChoresPresenceStatus = PresenceSourceStatus;

/** One seat's reconciliation result: the staged identity that reached both the canonical
 *  projection and the applied fence, or why it did not. */
export type ChoresPresenceProof =
  | { seat: string; id: string; binding: string }
  | { seat: string; miss: string };

/** The machine-scoped chores one child runs beside its roots: work whose subjects span roots, so
 *  no route's word speaks for it. The reminder beat is the one such chore: it reads the entity
 *  record, resolves every address and sends, all on this child's loop. A child started for it
 *  alone names no routes. */
export type ChoresMachineConfig = {
  reminders: {
    /** The canonical checkouts the daemon hosts: a reminder target outside them is refused when
     *  the list is read, exactly as the daemon's own inline reader refuses it. */
    hosted: string[];
  };
};

export type ChoresChildConfig = {
  version: 1;
  /** The home the daemon resolved; also the child's `HOME`, so both processes read one machine
   *  folder and one policy store. */
  home: string;
  /** The daemon's heartbeat interval: the child sends one heartbeat per beat, and the
   *  supervisor ends it after the configured number of missed beats. */
  beatMs: number;
  /** How long one slice of a pass may run before it yields to the event loop. */
  sliceMs: number;
  /** The daemon's own start instant, so a reader can compare the two records. */
  since: string;
  /** Every root this child serves. A per-root child names one; a shared child names the idle
   *  roots its policy grouped; a child that runs only the machine chores names none. */
  routes: ChoresChildRoute[];
  /** The seat-health watchdog. Absent or false: this child does not read seats or start a restart. */
  seatHealth?: boolean;
  /** The machine-scoped chores this child runs beside its routes. Absent, the child carries the
   *  root work alone, exactly as before the machine chores moved here. */
  machine?: ChoresMachineConfig;
};

/** Host to child. A `tick` is a liveness nudge and the daemon's own beat instant; a due pass is
 *  the child's decision, so a late nudge never runs one twice. A `presence` nudge carries the
 *  daemon's measured source readings for one root after that root's ingest step resolved: the
 *  child then runs the activity, reconcile and publish steps the daemon used to run inline.
 *  A `watch-beat` is the daemon's watch beat for one root: it renews that route's authority and
 *  settles its due waits, and it carries the presence health the daemon measured for the route
 *  on this beat (null when it hosts no presence for the root). A `watch-fault` asks the child to
 *  end that route's run at its own seam, exactly as the daemon's own diagnostic would. */
export type ChoresHostMessage =
  | { type: 'tick'; id: string; at: string }
  | { type: 'presence'; id: string; root: string; at: string; readings: ChoresPresenceReading[] }
  | { type: 'watch-beat'; root: string; at: string; presence: ChoresWatchSeatHealth[] | null }
  | { type: 'watch-fault'; root: string; why: string }
  | { type: 'stop'; why: string };

/** What one root's pass did: its own clock, the chore it ran and how long that took, and the
 *  notes a reader should see. `notes` are plain lines (counts, a deferred lock, a fingerprint
 *  this pass could not read), never structured effects: the steps that append or publish carry
 *  their own messages. `chore` and `ms` are display evidence for the status row; absent on a
 *  frame that carries neither, which is not a reason to drop it. */
export type ChoresRootPass = {
  root: string;
  at: string;
  notes: string[];
  chore: string | null;
  ms: number | null;
};

/** The child's own marker-cache reading at one heartbeat: how many marker files it read afresh,
 *  how many it answered from a stamp, and how many stamps it holds now. The cache is a stat
 *  prefilter in the child's memory and never decides an outcome; the counts are display
 *  evidence for why a sweep is busy. */
export type ChoresMarkerCache = { read: number; reused: number; cached: number };

/** Child to host. `heartbeat` is sent every beat whether or not a pass is running; `rssBytes` is
 *  the child's own resident size at that instant, so the daemon's record and `team daemon status`
 *  can report what one child costs, and `markerCache` is the sweep's own stat-cache reading at
 *  the same instant, so a reader can see why a sweep is busy. `pass` reports finished per-root
 *  work; `note` is a diagnostic line the host writes to its own log. `watch-state` mirrors one
 *  hosted watch's whole state after a beat or a fault, so the daemon's own record carries what
 *  the child proved rather than a guess; `watch-pulse` is one cross-route beat a hosted pass
 *  carried to the others; `watch-cycle` marks one hosted watch pass that finished its loop turn; and
 *  `watch-fault-result` answers a diagnostic once its run has left its seam (`left`) or the
 *  child had no run to end (`refused`). */
export type ChoresChildMessage =
  | { type: 'ready'; pid: number; at: string }
  /** One line the machine reminder beat wrote — the list's refusals, a fire's count, a send's
   *  own words. The host logs it as written: the line already names its subject, and a prefix
   *  naming the child would read as if the root work had said it. */
  | { type: 'reminder-note'; text: string }
  | {
      type: 'heartbeat';
      at: string;
      rssBytes: number;
      busy: string | null;
      /** The child's own marker cache at this beat; null when its frame carried none. */
      markerCache: ChoresMarkerCache | null;
      /** The CPU time the machine has charged this child, in milliseconds, as the child read it
       *  from its own process at this beat. The supervisor judges a silent child against the
       *  latest number it has heard, so a healthy beat costs the daemon no process query; absent
       *  on an older child's frame, which is no reason to drop the beat. */
      cpuMs?: number | null;
    }
  | { type: 'pass'; passes: ChoresRootPass[] }
  | {
      type: 'presence-result';
      id: string;
      root: string;
      at: string;
      proofs: ChoresPresenceProof[];
      notes: string[];
      /** How long the presence pass took; null when the frame carried no duration. */
      ms: number | null;
    }
  | { type: 'watch-state'; root: string; state: HostedWatchState }
  | { type: 'watch-pulse'; root: string; at: string }
  | { type: 'watch-cycle'; root: string; at: string }
  | { type: 'watch-fault-result'; root: string; outcome: 'left' | 'refused'; why: string }
  | { type: 'note'; text: string }
  | { type: 'stopped'; why: string };

/** One frame's bound in each direction. A frame past it is a protocol fault, not a message: the
 *  only bulk the contract carries is per-root notes, which are a handful of lines. */
export const CHORES_FRAME_LIMIT = 64 * 1024;

const PRESENCE_CHANNELS = new Set<string>(['connecting', 'connected', 'unknown', 'gone', 'stopped']);
const PRESENCE_STREAMS = new Set<string>(['uninitialized', 'initialized', 'lost']);
const PRESENCE_BASELINES = new Set<string>(['pending', 'read', 'failed']);

/** Parses one frame; null when it is not a JSON object. The caller bounds the length first. */
export function parseChoresFrame(line: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** Reads one JSON-safe presence status, or null for one this contract does not carry. */
function readPresenceStatus(raw: unknown): ChoresPresenceStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.seat !== 'string' || entry.seat === '') return null;
  if (typeof entry.binding !== 'string' || typeof entry.threadId !== 'string') return null;
  if (typeof entry.channel !== 'string' || !PRESENCE_CHANNELS.has(entry.channel)) return null;
  if (typeof entry.stream !== 'string' || !PRESENCE_STREAMS.has(entry.stream)) return null;
  if (typeof entry.baseline !== 'string' || !PRESENCE_BASELINES.has(entry.baseline)) return null;
  if (!(entry.evidenceAt === null || typeof entry.evidenceAt === 'string')) return null;
  if (entry.stagedEventId !== undefined && !(entry.stagedEventId === null || typeof entry.stagedEventId === 'string')) return null;
  if (entry.why !== undefined && !(entry.why === null || typeof entry.why === 'string')) return null;
  if (entry.reason !== undefined && !(entry.reason === null || typeof entry.reason === 'string')) return null;
  return {
    seat: entry.seat,
    binding: entry.binding,
    threadId: entry.threadId,
    channel: entry.channel as ChoresPresenceStatus['channel'],
    stream: entry.stream as ChoresPresenceStatus['stream'],
    baseline: entry.baseline as ChoresPresenceStatus['baseline'],
    evidenceAt: entry.evidenceAt as string | null,
    ...(entry.stagedEventId === undefined ? {} : { stagedEventId: entry.stagedEventId as string | null }),
    ...(entry.why === undefined ? {} : { why: entry.why as string | null }),
    ...(entry.reason === undefined ? {} : { reason: entry.reason as string | null }),
  };
}

/** Reads one seat-health row the daemon relayed, or null for one this contract does not carry. */
function readSeatHealth(raw: unknown): ChoresWatchSeatHealth | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.seat !== 'string' || entry.seat === '') return null;
  if (typeof entry.healthy !== 'boolean') return null;
  return {
    seat: entry.seat,
    healthy: entry.healthy,
    ...(typeof entry.reason === 'string' && entry.reason !== '' ? { reason: entry.reason } : {}),
  };
}

/** Reads one marker-cache reading a child reported, or null for one a reader must not trust.
 *  Every count is a whole number that cannot be negative: the row is display evidence, and a
 *  malformed reading is dropped rather than shown as a guess. */
function readMarkerCache(raw: unknown): ChoresMarkerCache | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  for (const key of ['read', 'reused', 'cached'] as const) {
    if (!Number.isInteger(entry[key]) || (entry[key] as number) < 0) return null;
  }
  return {
    read: entry.read as number,
    reused: entry.reused as number,
    cached: entry.cached as number,
  };
}

const WATCH_PHASES = new Set<string>(['starting', 'running', 'standby', 'stopping', 'stopped', 'failed']);

/** Reads one hosted watch's state as the child reported it, or null for a frame a reader must
 *  not trust. Every field is checked: the daemon's record and its fault diagnostic both act on
 *  what this returns. */
export function readWatchState(raw: unknown): HostedWatchState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  for (const key of ['routeId', 'root', 'team', 'session', 'startedAt'] as const) {
    if (typeof entry[key] !== 'string' || entry[key] === '') return null;
  }
  if (typeof entry.phase !== 'string' || !WATCH_PHASES.has(entry.phase)) return null;
  if (!(entry.lastCycleAt === null || (typeof entry.lastCycleAt === 'string' && entry.lastCycleAt !== ''))) return null;
  if (!(entry.lastCycleOutcome === null || entry.lastCycleOutcome === 'pass' || entry.lastCycleOutcome === 'failed')) return null;
  if (!Number.isInteger(entry.cycles) || (entry.cycles as number) < 0) return null;
  if (!Number.isInteger(entry.failures) || (entry.failures as number) < 0) return null;
  if (entry.effects !== 'blocked' && entry.effects !== 'open') return null;
  if (typeof entry.required !== 'boolean') return null;
  if (!(entry.why === null || typeof entry.why === 'string')) return null;
  return {
    routeId: entry.routeId as string,
    root: entry.root as string,
    team: entry.team as string,
    session: entry.session as string,
    phase: entry.phase as HostedWatchState['phase'],
    startedAt: entry.startedAt as string,
    lastCycleAt: entry.lastCycleAt as string | null,
    lastCycleOutcome: entry.lastCycleOutcome as HostedWatchState['lastCycleOutcome'],
    cycles: entry.cycles as number,
    failures: entry.failures as number,
    effects: entry.effects as HostedWatchState['effects'],
    required: entry.required,
    why: entry.why as string | null,
  };
}

/** Reads a host frame the child understands, or null for one it must not act on. */
export function readHostMessage(raw: Record<string, unknown>): ChoresHostMessage | null {
  if (raw.type === 'tick' && typeof raw.id === 'string' && raw.id !== '' && typeof raw.at === 'string' && raw.at !== '') {
    return { type: 'tick', id: raw.id, at: raw.at };
  }
  if (raw.type === 'presence' && typeof raw.id === 'string' && raw.id !== ''
    && typeof raw.root === 'string' && raw.root !== ''
    && typeof raw.at === 'string' && raw.at !== '' && Array.isArray(raw.readings)) {
    const readings: ChoresPresenceReading[] = [];
    for (const item of raw.readings) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const entry = item as Record<string, unknown>;
      if (typeof entry.seat !== 'string' || entry.seat === '') return null;
      if (typeof entry.failed === 'string') {
        readings.push({ seat: entry.seat, failed: entry.failed });
        continue;
      }
      const status = readPresenceStatus(entry.status);
      if (status === null) return null;
      readings.push({ seat: entry.seat, status });
    }
    return { type: 'presence', id: raw.id, root: raw.root, at: raw.at, readings };
  }
  if (raw.type === 'watch-beat' && typeof raw.root === 'string' && raw.root !== ''
    && typeof raw.at === 'string' && raw.at !== ''
    && (raw.presence === null || Array.isArray(raw.presence))) {
    let presence: ChoresWatchSeatHealth[] | null = null;
    if (Array.isArray(raw.presence)) {
      presence = [];
      for (const item of raw.presence) {
        const seat = readSeatHealth(item);
        if (seat === null) return null;
        presence.push(seat);
      }
    }
    return { type: 'watch-beat', root: raw.root, at: raw.at, presence };
  }
  if (raw.type === 'watch-fault' && typeof raw.root === 'string' && raw.root !== ''
    && typeof raw.why === 'string' && raw.why !== '') {
    return { type: 'watch-fault', root: raw.root, why: raw.why };
  }
  if (raw.type === 'stop' && typeof raw.why === 'string') return { type: 'stop', why: raw.why };
  return null;
}

/** Reads a child frame the supervisor understands, or null for one it drops as malformed. */
export function readChildMessage(raw: Record<string, unknown>): ChoresChildMessage | null {
  switch (raw.type) {
    case 'ready':
      if (!Number.isInteger(raw.pid) || (raw.pid as number) <= 0) return null;
      if (typeof raw.at !== 'string' || raw.at === '') return null;
      return { type: 'ready', pid: raw.pid as number, at: raw.at };
    case 'heartbeat': {
      if (typeof raw.at !== 'string' || raw.at === '') return null;
      if (typeof raw.rssBytes !== 'number' || !Number.isFinite(raw.rssBytes) || raw.rssBytes < 0) return null;
      if (!(raw.busy === null || typeof raw.busy === 'string')) return null;
      // A frame that carries a cache reading must carry a sound one; a frame without the field
      // is an older child's beat, and its silence is not a malformed reading.
      let markerCache: ChoresMarkerCache | null = null;
      if (raw.markerCache !== undefined && raw.markerCache !== null) {
        markerCache = readMarkerCache(raw.markerCache);
        if (markerCache === null) return null;
      }
      // The child's own CPU total is display-and-liveness evidence, never frame validity: a
      // frame without the field is an older child's beat, and one that carries a malformed value
      // is dropped like any other malformed reading.
      let cpuMs: number | null = null;
      if (raw.cpuMs !== undefined && raw.cpuMs !== null) {
        if (typeof raw.cpuMs !== 'number' || !Number.isFinite(raw.cpuMs) || raw.cpuMs < 0) return null;
        cpuMs = raw.cpuMs;
      }
      return {
        type: 'heartbeat',
        at: raw.at,
        rssBytes: raw.rssBytes,
        busy: raw.busy as string | null,
        markerCache,
        cpuMs,
      };
    }
    case 'pass': {
      if (!Array.isArray(raw.passes)) return null;
      const passes: ChoresRootPass[] = [];
      for (const item of raw.passes) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const entry = item as Record<string, unknown>;
        if (typeof entry.root !== 'string' || entry.root === '') return null;
        if (typeof entry.at !== 'string' || entry.at === '') return null;
        if (!Array.isArray(entry.notes) || entry.notes.some((note) => typeof note !== 'string')) return null;
        let chore: string | null = null;
        if (entry.chore !== undefined && entry.chore !== null) {
          if (typeof entry.chore !== 'string' || entry.chore === '') return null;
          chore = entry.chore;
        }
        let ms: number | null = null;
        if (entry.ms !== undefined && entry.ms !== null) {
          if (typeof entry.ms !== 'number' || !Number.isFinite(entry.ms) || entry.ms < 0) return null;
          ms = entry.ms;
        }
        passes.push({ root: entry.root, at: entry.at, notes: entry.notes as string[], chore, ms });
      }
      return { type: 'pass', passes };
    }
    case 'presence-result': {
      if (typeof raw.id !== 'string' || raw.id === '') return null;
      if (typeof raw.root !== 'string' || raw.root === '') return null;
      if (typeof raw.at !== 'string' || raw.at === '') return null;
      if (!Array.isArray(raw.proofs)) return null;
      if (!Array.isArray(raw.notes) || raw.notes.some((note) => typeof note !== 'string')) return null;
      const proofs: ChoresPresenceProof[] = [];
      for (const item of raw.proofs) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const entry = item as Record<string, unknown>;
        if (typeof entry.seat !== 'string' || entry.seat === '') return null;
        if (typeof entry.id === 'string' && typeof entry.binding === 'string') {
          proofs.push({ seat: entry.seat, id: entry.id, binding: entry.binding });
        } else if (typeof entry.miss === 'string') {
          proofs.push({ seat: entry.seat, miss: entry.miss });
        } else {
          return null;
        }
      }
      let ms: number | null = null;
      if (raw.ms !== undefined && raw.ms !== null) {
        if (typeof raw.ms !== 'number' || !Number.isFinite(raw.ms) || raw.ms < 0) return null;
        ms = raw.ms;
      }
      return {
        type: 'presence-result',
        id: raw.id,
        root: raw.root,
        at: raw.at,
        proofs,
        notes: raw.notes as string[],
        ms,
      };
    }
    case 'watch-state': {
      if (typeof raw.root !== 'string' || raw.root === '') return null;
      const state = readWatchState(raw.state);
      if (state === null || state.root !== raw.root) return null;
      return { type: 'watch-state', root: raw.root, state };
    }
    case 'watch-pulse':
      if (typeof raw.root !== 'string' || raw.root === '') return null;
      if (typeof raw.at !== 'string' || raw.at === '') return null;
      return { type: 'watch-pulse', root: raw.root, at: raw.at };
    case 'watch-cycle':
      if (typeof raw.root !== 'string' || raw.root === '') return null;
      if (typeof raw.at !== 'string' || raw.at === '') return null;
      return { type: 'watch-cycle', root: raw.root, at: raw.at };
    case 'watch-fault-result':
      if (typeof raw.root !== 'string' || raw.root === '') return null;
      if (raw.outcome !== 'left' && raw.outcome !== 'refused') return null;
      if (typeof raw.why !== 'string' || raw.why === '') return null;
      return { type: 'watch-fault-result', root: raw.root, outcome: raw.outcome, why: raw.why };
    case 'note':
      return typeof raw.text === 'string' ? { type: 'note', text: raw.text } : null;
    case 'reminder-note':
      return typeof raw.text === 'string' && raw.text !== '' ? { type: 'reminder-note', text: raw.text } : null;
    case 'stopped':
      return typeof raw.why === 'string' ? { type: 'stopped', why: raw.why } : null;
    default:
      return null;
  }
}
