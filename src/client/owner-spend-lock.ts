// One spend at a time on a machine whose accounts share one owner: the owner helper holds an
// exclusive lock on a file in its own folder while it judges and spends, so a burst of calls is
// served one by one. A call that cannot take the lock within its deadline spends nothing. The lock
// is the system's own file lock (released by the system when the helper exits, however it exits),
// taken without waiting and tried again until the deadline. Bun has no call for it, so it is
// called from the system library through `bun:ffi`, required only when a lock is taken (the
// helper runs under Bun), so the built CLI compiles without Bun's types.
import { closeSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';

const LOCK_EX = 2;
const LOCK_NB = 4;
const RETRY_MS = 25;

/** The shape of `bun:ffi` this module uses. */
interface BunFfi {
  dlopen: (library: string, symbols: Record<string, { args: unknown[]; returns: unknown }>) => { symbols: { flock: (fd: number, operation: number) => number } };
  FFIType: { i32: unknown };
}

type Flock = (fd: number, operation: number) => number;
let flock: Flock | null = null;

function systemFlock(): Flock {
  if (flock === null) {
    const ffi = createRequire(import.meta.url)('bun:ffi') as BunFfi;
    const library = process.platform === 'linux' ? 'libc.so.6' : '/usr/lib/libSystem.B.dylib';
    const opened = ffi.dlopen(library, { flock: { args: [ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 } });
    flock = (fd, operation) => opened.symbols.flock(fd, operation);
  }
  return flock;
}

/** Waits `ms` without spinning: a timed wait on a value nothing ever changes. */
const pause = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms: number): void {
  Atomics.wait(pause, 0, 0, ms);
}

/** Takes the spend lock at `path`, trying until `waitMs` has passed. The lock is held until
 *  `release` is called (or, failing that, until the process exits). */
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
      if (lock(fd, LOCK_EX | LOCK_NB) === 0) {
        let held = true;
        return { ok: true, release: () => { if (held) { held = false; closeSync(fd); } } };
      }
      if (Date.now() >= until) break;
      sleep(RETRY_MS);
    }
  } catch {
    closeSync(fd);
    return { ok: false, why: 'the spend lock cannot be taken; nothing was spent' };
  }
  closeSync(fd);
  return { ok: false, why: 'another spend is running on this machine and did not finish in time; nothing was spent, try again' };
}
