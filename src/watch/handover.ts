// The hand-over request one watch leaves for the other, kept beside the session state it
// concerns. A daemon-hosted watch that finds a live pane watch holding its route writes the
// request; the pane watch reads it at the top of its next pass and leaves through its own loop,
// deleting only its own record. The daemon's next fixed beat then acquires. It is a request, not
// an authority: the reader acts on nothing it cannot scope to its own route and session, nothing
// whose daemon is not alive, and nothing whose beat is not fresh. No process is ever signalled
// from this module, and a request that cannot be read is never permission to take over.
//
// The file is separate from the session state on purpose: the state reader drops fields it does
// not know, so a request written there could be erased by an ordinary pane beat. It is written
// atomically and 0600, and its freshness window is measured on the daemon's own fixed liveness
// beat (5 s), never on a watch rhythm: a sweep may be a day long, but a hosting daemon beats
// every five seconds while it waits.
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The request file's name inside the route's own state folder (beside `team.state.json`). */
export const WATCH_HANDOVER_FILE = 'watch-handover.json';

/** Six fixed daemon beats: a request older than this names no daemon that is still asking. */
export const WATCH_HANDOVER_MAX_AGE_MS = 30_000;

/** A beat more than this far in the future is a clock that ran ahead, not a live request. */
export const WATCH_HANDOVER_FUTURE_SKEW_MS = 5_000;

/** What a hosting daemon asks a pane watch to do: leave the route's session watch to it. */
export type WatchHandover = {
  format: 1;
  kind: 'watch-handover';
  /** The canonical checkout root the request is scoped to. */
  root: string;
  /** The team-file session the request is scoped to. */
  session: string;
  /** The hosting daemon's process. Never a watch process and never read from argv. */
  pid: number;
  /** When the first request for this transfer was written; kept across refreshes. */
  requestedAt: string;
  /** The daemon's latest fixed beat while it still wanted the transfer. */
  heartbeat: string;
};

export type WatchHandoverRead =
  | { kind: 'none' }
  | { kind: 'unreadable'; why: string }
  | { kind: 'request'; request: WatchHandover };

export function handoverPath(stateDir: string): string {
  return join(stateDir, WATCH_HANDOVER_FILE);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** The request as this build can read it, or why it cannot. Malformed fields are never repaired:
 *  an unreadable request is ignored, not guessed at. */
export function readWatchHandover(stateDir: string): WatchHandoverRead {
  const path = handoverPath(stateDir);
  if (!existsSync(path)) return { kind: 'none' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { kind: 'unreadable', why: 'the hand-over request is not readable JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unreadable', why: 'the hand-over request is not a JSON object' };
  }
  const entry = parsed as Record<string, unknown>;
  if (entry.format !== 1 || entry.kind !== 'watch-handover') {
    return { kind: 'unreadable', why: 'the hand-over request is not this build\'s format' };
  }
  if (!text(entry.root) || !text(entry.session)) {
    return { kind: 'unreadable', why: 'the hand-over request names no route' };
  }
  if (typeof entry.pid !== 'number' || !Number.isInteger(entry.pid) || entry.pid <= 0) {
    return { kind: 'unreadable', why: 'the hand-over request names no process' };
  }
  if (!text(entry.requestedAt) || !text(entry.heartbeat)) {
    return { kind: 'unreadable', why: 'the hand-over request carries no beat' };
  }
  return {
    kind: 'request',
    request: {
      format: 1,
      kind: 'watch-handover',
      root: entry.root,
      session: entry.session,
      pid: entry.pid,
      requestedAt: entry.requestedAt,
      heartbeat: entry.heartbeat,
    },
  };
}

/**
 * Writes or refreshes the request, atomically and 0600. `requestedAt` is passed back by the
 * daemon on every refresh so the file remembers when the transfer began; the heartbeat is always
 * this call's own clock. A failed write throws: the caller decides what an unwritten request
 * means, and this module never pretends it was left.
 */
export function writeWatchHandover(
  stateDir: string,
  input: { root: string; session: string; pid: number; now: Date; requestedAt?: string },
): WatchHandover {
  const request: WatchHandover = {
    format: 1,
    kind: 'watch-handover',
    root: input.root,
    session: input.session,
    pid: input.pid,
    requestedAt: input.requestedAt ?? input.now.toISOString(),
    heartbeat: input.now.toISOString(),
  };
  const path = handoverPath(stateDir);
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    // A write that did not land leaves no half-request behind: the temporary is removed when it
    // exists, and the failure is the caller's to report.
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to remove, or nothing this process may remove; the original failure is the news.
    }
    throw error;
  }
  return request;
}

/** Removes the request. Absent is success; any other failure is returned as its reason so a
 *  caller can log it without turning cleanup into a failure of the watch it was ending. */
export function clearWatchHandover(stateDir: string): string | undefined {
  const path = handoverPath(stateDir);
  try {
    unlinkSync(path);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return error instanceof Error ? error.message : String(error);
  }
}

/** The canonical form of a root, or null when it cannot be read: a request scoped to a root this
 *  reader cannot resolve is never its own. */
function canonical(root: string): string | null {
  try {
    return realpathSync(root);
  } catch {
    return null;
  }
}

/**
 * Whether this reader may act on the request: the same checkout and session, a live requesting
 * process, and a beat no older than the fixed window. `undefined` is every other case — absent,
 * unreadable, another route's, another session's, a dead daemon's, an aged one — and none of them
 * is permission to stand down or to take over.
 */
export function actingWatchHandover(input: {
  read: WatchHandoverRead;
  root: string;
  session: string;
  alive(pid: number): boolean;
  now: number;
}): WatchHandover | undefined {
  if (input.read.kind !== 'request') return undefined;
  const { request } = input.read;
  if (request.session !== input.session) return undefined;
  const mine = canonical(input.root);
  const theirs = canonical(request.root);
  if (mine === null || theirs === null || mine !== theirs) return undefined;
  const beat = Date.parse(request.heartbeat);
  if (!Number.isFinite(beat)) return undefined;
  const age = input.now - beat;
  if (age > WATCH_HANDOVER_MAX_AGE_MS || age < -WATCH_HANDOVER_FUTURE_SKEW_MS) return undefined;
  if (!Number.isInteger(request.pid) || request.pid <= 0) return undefined;
  return input.alive(request.pid) ? request : undefined;
}
