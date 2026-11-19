// Process ancestry metadata only: no argument-page or environment reader is used here.
// Darwin's proc_bsdinfo layout is from the installed SDK's sys/proc_info.h: pid at 12,
// ppid at 16, start seconds at 120 and start microseconds at 128 (136 bytes total).
// Linux supplies ppid and start ticks in fields 4 and 22 of /proc/<pid>/stat. Birth values
// are compared only with other values from this reader, never across platform clocks.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export type ProcessParent = { pid: number; ppid: number; birth: number };

function valid(pid: number, ppid: number, birth: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid) && ppid >= 0
    && Number.isSafeInteger(birth) && birth > 0;
}

export function parentOfBsdInfo(bytes: Uint8Array, expectedPid: number): ProcessParent | null {
  if (bytes.length !== 136) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pid = view.getUint32(12, true);
  const ppid = view.getUint32(16, true);
  const micros = view.getBigUint64(128, true);
  if (pid !== expectedPid || micros >= 1_000_000n) return null;
  const birth = Number(view.getBigUint64(120, true) * 1_000_000n + micros);
  return valid(pid, ppid, birth) ? { pid, ppid, birth } : null;
}

export function parentOfProcStat(text: string, expectedPid: number): ProcessParent | null {
  const head = /^(\d+) \(/.exec(text);
  const end = text.lastIndexOf(')');
  if (head === null || end < head[0].length) return null;
  const pid = Number(head[1]);
  const fields = text.slice(end + 1).trim().split(/\s+/);
  if (!/^\d+$/.test(fields[1] ?? '') || !/^\d+$/.test(fields[19] ?? '')) return null;
  const ppid = Number(fields[1]);
  const birth = Number(fields[19]);
  return pid === expectedPid && valid(pid, ppid, birth) ? { pid, ppid, birth } : null;
}

type Reader = (pid: number) => ProcessParent | null;
let native: Reader | null | undefined;

function bind(): Reader | null {
  if (process.platform !== 'darwin' || process.versions.bun === undefined) return null;
  try {
    const ffi = createRequire(import.meta.url)('bun:ffi');
    const lib = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
      proc_pidinfo: { args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.u64, ffi.FFIType.ptr, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
    });
    const bytes = new Uint8Array(136);
    return pid => lib.symbols.proc_pidinfo(pid, 3, 0, ffi.ptr(bytes), bytes.length) === bytes.length
      ? parentOfBsdInfo(bytes, pid) : null;
  } catch {
    return null;
  }
}

/** A parent and birth from the same kernel record. Unavailable metadata proves no ancestry. */
export function readProcessParent(pid: number): ProcessParent | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') return parentOfProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'), pid);
    if (native === undefined) native = bind();
    return native?.(pid) ?? null;
  } catch {
    return null;
  }
}
