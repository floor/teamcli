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

/** Takes the session mutator lock for `session`, or reports who holds it. */
export function acquireRunLock(dir: string, session: string): SeatLock {
  return acquireSeatLock(dir, session, RUN_LOCK);
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
