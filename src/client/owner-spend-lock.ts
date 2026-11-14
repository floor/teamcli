// One spend at a time on a machine whose accounts share one owner: the owner helper holds an
// exclusive lock on a file in its own folder while it judges and spends, so a burst of calls is
// served one by one. A call that cannot take the lock within its deadline spends nothing. The lock
// is the system's own file lock (released by the system when the helper exits, however it exits),
// taken without waiting and tried again until the deadline. Bun has no call for it, so it is
// called from the system library.
import { dlopen, FFIType } from 'bun:ffi';
import { closeSync, openSync } from 'node:fs';

const LOCK_EX = 2;
const LOCK_NB = 4;

type Flock = (fd: number, operation: number) => number;
let flock: Flock | null = null;

function systemFlock(): Flock {
  if (flock === null) {
    const library = process.platform === 'linux' ? 'libc.so.6' : '/usr/lib/libSystem.B.dylib';
    const opened = dlopen(library, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    flock = (fd, operation) => opened.symbols.flock(fd, operation) as number;
  }
  return flock;
}

/** Takes the spend lock at `path`, trying until `waitMs` has passed. The lock is held until the
 *  process exits (or `release` is called). */
export function holdSpendLock(path: string, waitMs: number): { ok: true; release: () => void } | { ok: false; why: string } {
  let fd: number;
  try {
    fd = openSync(path, 'a', 0o600);
  } catch {
    return { ok: false, why: 'the spend lock cannot be opened; nothing was spent' };
  }
  const until = Date.now() + waitMs;
  try {
    const lock = systemFlock();
    while (true) {
      if (lock(fd, LOCK_EX | LOCK_NB) === 0) return { ok: true, release: () => closeSync(fd) };
      if (Date.now() >= until) break;
      Bun.sleepSync(25);
    }
  } catch {
    closeSync(fd);
    return { ok: false, why: 'the spend lock cannot be taken; nothing was spent' };
  }
  closeSync(fd);
  return { ok: false, why: 'another spend is running on this machine and did not finish in time; nothing was spent, try again' };
}
