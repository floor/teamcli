// One process's parent and command name read straight from the macOS kernel, through `bun:ffi`:
// `proc_pidinfo(PROC_PIDTBSDINFO)` for the parent and `sysctl(KERN_PROCARGS2)` for argv[0]. This
// is the same evidence `ps -o ppid=,comm=` prints (its `comm` is argv[0] as the process holds it,
// a title a process rewrote included), without starting a child for every caller lookup.
//
// Reads only pid, parent and argv[0]: never the other arguments and never the environment, both
// of which share the KERN_PROCARGS2 page and are discarded unread past argv[0].
//
// Another user's process (the terminal's root-owned `login`, launchd's helpers): the kernel
// refuses its argument page to this user, while `ps` (set-uid) still prints its argv[0]. For
// those the short BSD record's `pbsi_comm` stands in, only when it is certainly whole (shorter
// than the kernel's 16-byte limit, so never cut). Compared on this Mac against `ps -ax` for every
// other-user process that answers (2026-11-17): the parent and the name matched in every case.
// Seat identity compares ancestor names only to user programs (`herdr`, `codex`), which never
// run under another user, so this stand-in cannot place or refuse a caller differently.
//
// Binding can fail (plain Node, another platform, a libSystem this build cannot open), and an
// own process can be gone or unreadable. Every such case answers `undefined`: the caller then
// reads the table through `ps` exactly as before, so this reader adds no new way to fail.
import { createRequire } from 'node:module';

/** The parent and the command name `ps -o comm=` prints for one process. */
export type KernelProcess = { ppid: number; argv0: string };

type Bound = (pid: number) => KernelProcess | null;

let bound: Bound | null | undefined;

// struct proc_bsdinfo (sys/proc_info.h): 136 bytes; pbi_ppid is the fifth uint32.
const PROC_PIDTBSDINFO = 3;
// struct proc_bsdshortinfo: 64 bytes; pbsi_ppid at 4, pbsi_comm[16] at 16, pbsi_uid at 36.
const PROC_PIDT_SHORTBSDINFO = 13;
const SHORT_SIZE = 64;
const SHORT_PPID_OFFSET = 4;
const SHORT_COMM_OFFSET = 16;
const SHORT_UID_OFFSET = 36;
const MAXCOMLEN = 16;
const BSDINFO_SIZE = 136;
const BSDINFO_PPID_OFFSET = 16;
// CTL_KERN, KERN_PROCARGS2 (sys/sysctl.h).
const CTL_KERN = 1;
const KERN_PROCARGS2 = 49;
// The kernel's argument page is at most ARG_MAX (1 MiB on current macOS); argv[0] sits right
// after the exec path at the front, so a page this size holds it for any process.
const ARGS_BYTES = 1 << 20;

/**
 * argv[0] from one KERN_PROCARGS2 page: a 4-byte argc, the exec path, NUL padding, then argv[0].
 * Null when the page is too short to hold one, names no arguments, or the bytes are not that
 * shape. Exported for tests.
 */
export function argv0OfProcArgs(page: Uint8Array, length: number): string | null {
  const end = Math.min(length, page.length);
  if (end < 4) return null;
  const argc = new DataView(page.buffer, page.byteOffset, page.byteLength).getInt32(0, true);
  if (argc < 1) return null;
  let at = 4;
  while (at < end && page[at] !== 0) at += 1; // the exec path
  while (at < end && page[at] === 0) at += 1; // its padding
  if (at >= end) return null;
  let stop = at;
  while (stop < end && page[stop] !== 0) stop += 1;
  if (stop >= end) return null; // argv[0] must end inside the page
  const text = new TextDecoder('utf-8', { fatal: false }).decode(page.subarray(at, stop));
  return text === '' ? null : text;
}

/**
 * Whether this process runs under a Seatbelt profile: `sandbox_check(pid, NULL, SANDBOX_FILTER_NONE)`
 * answers non-zero for a sandboxed process. A check that cannot be made counts as confined, so
 * the walk falls back to `ps`, the reader every caller used before this one. Exported for tests.
 */
export function confinedBySeatbelt(check: (...args: unknown[]) => number): boolean {
  try {
    return check(process.pid, null, 0) !== 0;
  } catch {
    return true;
  }
}

function bind(): Bound | null {
  if (process.platform !== 'darwin' || process.versions.bun === undefined) return null;
  try {
    const req = createRequire(import.meta.url);
    const ffi = req('bun:ffi') as {
      dlopen: (
        library: string,
        symbols: Record<string, { args: unknown[]; returns: unknown }>,
      ) => { symbols: Record<string, (...args: unknown[]) => number> };
      FFIType: Record<string, unknown>;
      ptr: (view: ArrayBufferView) => unknown;
    };
    const T = ffi.FFIType;
    const lib = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
      proc_pidinfo: { args: [T.i32, T.i32, T.u64, T.ptr, T.i32], returns: T.i32 },
      sysctl: { args: [T.ptr, T.u32, T.ptr, T.ptr, T.ptr, T.u64], returns: T.i32 },
      sandbox_check: { args: [T.i32, T.ptr, T.i32], returns: T.i32 },
    });
    // A process its Seatbelt profile confines is never read this way: such a profile may let
    // `proc_pidinfo` answer for processes outside it while `ps` is refused, and the confined-seat
    // placement and its outbox relay (src/placement/confined.ts, src/send/confined-outbox.ts) are
    // read only when the parent walk fails. Reading the chain here would place a confined seat by
    // its walk and send it down the direct path, whose writes its sandbox refuses.
    if (confinedBySeatbelt(lib.symbols.sandbox_check as (...a: unknown[]) => number)) return null;
    const short = new Uint8Array(SHORT_SIZE);
    const shortView = new DataView(short.buffer);
    const ownUid = typeof process.getuid === 'function' ? process.getuid() : -1;
    const info = new Uint8Array(BSDINFO_SIZE);
    const infoView = new DataView(info.buffer);
    const page = new Uint8Array(ARGS_BYTES);
    const mib = new Int32Array(3);
    const size = new BigUint64Array(1);
    const proc_pidinfo = lib.symbols.proc_pidinfo as (...a: unknown[]) => number;
    const sysctl = lib.symbols.sysctl as (...a: unknown[]) => number;
    const otherUser = (pid: number): KernelProcess | null => {
      if (proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, ffi.ptr(short), SHORT_SIZE) !== SHORT_SIZE) return null;
      const uid = shortView.getUint32(SHORT_UID_OFFSET, true);
      if (ownUid < 0 || uid === ownUid) return null;
      const comm = short.subarray(SHORT_COMM_OFFSET, SHORT_COMM_OFFSET + MAXCOMLEN);
      const end = comm.indexOf(0);
      if (end <= 0 || end >= MAXCOMLEN - 1) return null; // empty, or possibly cut at the limit
      const name = new TextDecoder('utf-8', { fatal: false }).decode(comm.subarray(0, end));
      return { ppid: shortView.getUint32(SHORT_PPID_OFFSET, true), argv0: name };
    };
    return (pid) => {
      if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ffi.ptr(info), BSDINFO_SIZE) !== BSDINFO_SIZE) return otherUser(pid);
      const ppid = infoView.getUint32(BSDINFO_PPID_OFFSET, true);
      mib[0] = CTL_KERN;
      mib[1] = KERN_PROCARGS2;
      mib[2] = pid;
      size[0] = BigInt(page.length);
      if (sysctl(ffi.ptr(mib), 3, ffi.ptr(page), ffi.ptr(size), null, 0) !== 0) return otherUser(pid);
      const argv0 = argv0OfProcArgs(page, Number(size[0]));
      return argv0 === null ? null : { ppid, argv0 };
    };
  } catch {
    return null;
  }
}

/**
 * One process from the kernel, or `undefined` when this process cannot read it that way: not
 * macOS under Bun, the binding failed, or the kernel refused or no longer holds the pid. An
 * `undefined` answer says nothing about the process; the caller reads it through `ps` instead.
 */
export function kernelProcess(pid: number): KernelProcess | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (override !== undefined) return override === null ? undefined : override(pid);
  if (bound === undefined) bound = bind();
  if (bound === null) return undefined;
  try {
    return bound(pid) ?? undefined;
  } catch {
    return undefined;
  }
}

let override: ((pid: number) => KernelProcess | undefined) | null | undefined;

/** Tests only: `null` turns the kernel reader off (every read goes through `ps`), a function
 *  stands in for it, `undefined` restores the real one. */
export function setKernelProcessForTests(reader: ((pid: number) => KernelProcess | undefined) | null | undefined): void {
  override = reader;
}

/** Whether the kernel reader is bound in this process (for tests and diagnostics). */
export function kernelProcessBound(): boolean {
  if (bound === undefined) bound = bind();
  return bound !== null;
}
