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
import type { PresenceSourceStatus } from '../presence/health.ts';

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
};

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
   *  roots its policy grouped. */
  routes: ChoresChildRoute[];
};

/** Host to child. A `tick` is a liveness nudge and the daemon's own beat instant; a due pass is
 *  the child's decision, so a late nudge never runs one twice. A `presence` nudge carries the
 *  daemon's measured source readings for one root after that root's ingest step resolved: the
 *  child then runs the activity, reconcile and publish steps the daemon used to run inline. */
export type ChoresHostMessage =
  | { type: 'tick'; id: string; at: string }
  | { type: 'presence'; id: string; root: string; at: string; readings: ChoresPresenceReading[] }
  | { type: 'stop'; why: string };

/** What one root's pass did: its own clock and the notes a reader should see. `notes` are plain
 *  lines (counts, a deferred lock, a fingerprint this pass could not read), never structured
 *  effects: the steps that append or publish carry their own messages. */
export type ChoresRootPass = { root: string; at: string; notes: string[] };

/** Child to host. `heartbeat` is sent every beat whether or not a pass is running; `rssBytes` is
 *  the child's own resident size at that instant, so the daemon's record and `team daemon status`
 *  can report what one child costs. `pass` reports finished per-root work; `note` is a diagnostic
 *  line the host writes to its own log. */
export type ChoresChildMessage =
  | { type: 'ready'; pid: number; at: string }
  | { type: 'heartbeat'; at: string; rssBytes: number; busy: string | null }
  | { type: 'pass'; passes: ChoresRootPass[] }
  | { type: 'presence-result'; id: string; root: string; at: string; proofs: ChoresPresenceProof[]; notes: string[] }
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
      return { type: 'heartbeat', at: raw.at, rssBytes: raw.rssBytes, busy: raw.busy as string | null };
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
        passes.push({ root: entry.root, at: entry.at, notes: entry.notes as string[] });
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
      return { type: 'presence-result', id: raw.id, root: raw.root, at: raw.at, proofs, notes: raw.notes as string[] };
    }
    case 'note':
      return typeof raw.text === 'string' ? { type: 'note', text: raw.text } : null;
    case 'stopped':
      return typeof raw.why === 'string' ? { type: 'stopped', why: raw.why } : null;
    default:
      return null;
  }
}
