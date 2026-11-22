// The kernel's advisory file lock, `flock(2)`, bound from libc through `bun:ffi`. A lock taken
// here is held by the open file description: the kernel drops it when the descriptor closes or
// the process dies, so a holder that is gone never needs to be judged, renamed or broken.
//
// Binding can fail (plain Node, a libc this build cannot open). `flockBound()` says so; callers
// that need exclusion then do the safe thing they document, never a plain-file substitute.
import { createRequire } from 'node:module';

export const LOCK_EX = 2;
export const LOCK_NB = 4;
export const LOCK_UN = 8;

type Flock = (fd: number, operation: number) => number;

let flockImpl: Flock | null | undefined;

function bindFlock(): Flock | null {
  try {
    const req = createRequire(import.meta.url);
    if (process.versions.bun !== undefined) {
      const ffi = req('bun:ffi') as {
        dlopen: (
          library: string,
          symbols: Record<string, { args: unknown[]; returns: unknown }>,
        ) => { symbols: { flock: Flock } };
        FFIType: { i32: unknown };
      };
      const library = process.platform === 'linux' ? 'libc.so.6' : 'libSystem.B.dylib';
      const lib = ffi.dlopen(library, {
        flock: { args: [ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
      });
      return (fd, operation) => lib.symbols.flock(fd, operation);
    }
  } catch {
    return null;
  }
  return null;
}

/** Whether `flock` could be bound in this process. Bound once, on first use. */
export function flockBound(): boolean {
  if (flockImpl === undefined) flockImpl = bindFlock();
  return flockImpl !== null;
}

/** Exclusive non-blocking flock on `fd`: true when this descriptor now holds it. False when
 *  another holds it, or when flock cannot be bound (ask `flockBound()` to tell the two apart). */
export function flockExclusive(fd: number): boolean {
  if (!flockBound()) return false;
  return (flockImpl as Flock)(fd, LOCK_EX | LOCK_NB) === 0;
}
