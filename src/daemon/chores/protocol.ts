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

/** How the child was started: the roots it serves and the limits its supervisor gave it. The
 *  token file carries this; a child reads it once and serves from it. */
export type ChoresChildRoute = {
  root: string;
  team: string;
  session: string;
  /** The validated team file the daemon hosted this root with, carried so the child's chores
   *  read the same snapshot instead of reading the file again. Absent in a hand-built token,
   *  where the pass reads the root's team file itself. */
  teamFile?: TeamFile;
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
   *  roots its policy grouped. */
  routes: ChoresChildRoute[];
};

/** Host to child. A `tick` is a liveness nudge and the daemon's own beat instant; a due pass is
 *  the child's decision, so a late nudge never runs one twice. */
export type ChoresHostMessage =
  | { type: 'tick'; id: string; at: string }
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
  | { type: 'note'; text: string }
  | { type: 'stopped'; why: string };

/** One frame's bound in each direction. A frame past it is a protocol fault, not a message: the
 *  only bulk the contract carries is per-root notes, which are a handful of lines. */
export const CHORES_FRAME_LIMIT = 64 * 1024;

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

/** Reads a host frame the child understands, or null for one it must not act on. */
export function readHostMessage(raw: Record<string, unknown>): ChoresHostMessage | null {
  if (raw.type === 'tick' && typeof raw.id === 'string' && raw.id !== '' && typeof raw.at === 'string' && raw.at !== '') {
    return { type: 'tick', id: raw.id, at: raw.at };
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
    case 'note':
      return typeof raw.text === 'string' ? { type: 'note', text: raw.text } : null;
    case 'stopped':
      return typeof raw.why === 'string' ? { type: 'stopped', why: raw.why } : null;
    default:
      return null;
  }
}
