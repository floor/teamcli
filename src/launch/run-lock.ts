import { acquireSeatLock, seatLockPath, type SeatLock } from './seat-lock.ts';

/**
 * The session mutator lock: one lock per session, under `<dir>/seat-locks/<session>/`, taken by
 * every command that mutates a session — `up`, `add`, `down`, `remove` and `reload` — before its first
 * effect and released on every exit path. A second real run is refused, never queued, and a lock
 * left by a killed run is taken over by the next one (`seat-lock.ts`). The name is a leading
 * dot, so it can never be a seat name (`file/sections/seats.ts`) and can never collide with a
 * seat's own lock.
 *
 * The order against the per-seat locks is one way only — run lock, then seat lock. A command
 * takes the run lock never while holding a seat lock.
 */
export const RUN_LOCK = '.run';

/** How long a caller that cannot begin its first effect under another run's mutation stands
 *  aside before it refuses: long enough for a stop-and-launch to finish, short enough that a
 *  person is not left waiting on a whole session restore. */
export const RUN_LOCK_WAIT_MS = 15_000;

/** The step the wait checks the lock at. */
export const RUN_LOCK_POLL_MS = 200;

/** Takes the session mutator lock for `session`, or reports who holds it. */
export function acquireRunLock(dir: string, session: string): SeatLock {
  return acquireSeatLock(dir, session, RUN_LOCK);
}

/**
 * Takes the session mutator lock, standing aside while another run holds it, and reports the
 * last holder it read once `waitMs` is spent. A second real run is still refused, never queued:
 * the wait is bounded and the refusal that follows is the one `acquireRunLock` gives. `restart`
 * is the caller that waits — its stop is its first effect, the watch's restore holds this lock
 * for a whole restore, and a refusal at the first reading is not a fair answer to a run that
 * arrived while another was merely busy. The time is counted in `pollMs` sleeps, the run's own
 * injectable sleep, so a scene that supplies one waits the counted time rather than a wall.
 */
export async function acquireRunLockWithin(
  dir: string,
  session: string,
  options: { waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SeatLock> {
  const waitMs = options.waitMs ?? RUN_LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? RUN_LOCK_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let lock = acquireRunLock(dir, session);
  for (let waited = 0; 'held' in lock && waited < waitMs; waited += pollMs) {
    await sleep(Math.min(pollMs, waitMs - waited));
    lock = acquireRunLock(dir, session);
  }
  return lock;
}

/**
 * What a run that meets the lock is told. `held` is the live pid that owns the lock, or -1 when
 * the lock cannot be read and its holder is unknown — the one case the owner has to clear by
 * hand. The sentence names no command for the holder: the lock is shared by every session
 * mutator, and the token records only a pid, so no honest text can say which command holds it.
 */
export function runLockText(held: number, session: string, dir: string): string {
  if (held > 0) {
    return `another session-mutating run is holding session ${session} (pid ${held}); try again when it is done`;
  }
  return `another session-mutating run may be holding session ${session}, and its lock cannot be read; if no run is using it, delete ${seatLockPath(dir, session, RUN_LOCK)}`;
}
