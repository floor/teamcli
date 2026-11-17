// What the macOS kernel says about the client on the other end of the send host's socket, read
// through `bun:ffi` (rfc-bus-send-server §2.3). Nothing here trusts a word the client wrote:
//   - `getsockopt(SOL_LOCAL, LOCAL_PEERCRED)`: the peer's effective uid;
//   - `getsockopt(SOL_LOCAL, LOCAL_PEERPID)`: the peer's pid;
//   - `proc_pidinfo(PROC_PIDTBSDINFO)`: its parent, uid and start time;
//   - `proc_pidinfo(PROC_PIDVNODEPATHINFO)`: its current directory;
//   - `sandbox_check(pid, NULL, 0)`: whether a Seatbelt profile confines it.
// Never the peer's arguments or environment. Every read that cannot be made answers null (or
// "confined" for the sandbox check), and the host then hands the line back to the client.
import { createRequire } from 'node:module';

export type PeerCredentials = { uid: number; pid: number };
export type PeerProcess = { ppid: number; uid: number; startSec: bigint; startUsec: bigint };

export type PeerReader = {
  credentials(fd: number): PeerCredentials | null;
  process(pid: number): PeerProcess | null;
  cwd(pid: number): string | null;
  confined(pid: number): boolean;
};

const SOL_LOCAL = 0;
const LOCAL_PEERCRED = 1;
const LOCAL_PEERPID = 2;
// struct xucred: cr_version (u32), cr_uid (u32), cr_ngroups (i16), cr_groups[16] (u32) = 76 bytes.
const XUCRED_SIZE = 76;
const XUCRED_UID_OFFSET = 4;
// struct proc_bsdinfo, 136 bytes: pbi_ppid at 16, pbi_uid at 20, pbi_start_tvsec at 120,
// pbi_start_tvusec at 128.
const PROC_PIDTBSDINFO = 3;
const BSDINFO_SIZE = 136;
// struct proc_vnodepathinfo: two vnode_info_path (152-byte vnode_info + 1024-byte path); the
// current directory's path is the first, at 152.
const PROC_PIDVNODEPATHINFO = 9;
const VNODEPATHINFO_SIZE = 2352;
const CDIR_PATH_OFFSET = 152;
const MAXPATHLEN = 1024;

let bound: PeerReader | null | undefined;
let override: PeerReader | null | undefined;

function bind(): PeerReader | null {
  if (process.platform !== 'darwin' || process.versions.bun === undefined) return null;
  try {
    const req = createRequire(import.meta.url);
    const ffi = req('bun:ffi') as {
      dlopen: (library: string, symbols: Record<string, { args: unknown[]; returns: unknown }>) => { symbols: Record<string, (...args: unknown[]) => number> };
      FFIType: Record<string, unknown>;
      ptr: (view: ArrayBufferView) => unknown;
    };
    const T = ffi.FFIType;
    const lib = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
      getsockopt: { args: [T.i32, T.i32, T.i32, T.ptr, T.ptr], returns: T.i32 },
      proc_pidinfo: { args: [T.i32, T.i32, T.u64, T.ptr, T.i32], returns: T.i32 },
      sandbox_check: { args: [T.i32, T.ptr, T.i32], returns: T.i32 },
    });
    const getsockopt = lib.symbols.getsockopt!;
    const proc_pidinfo = lib.symbols.proc_pidinfo!;
    const sandbox_check = lib.symbols.sandbox_check!;
    return {
      credentials(fd) {
        const cred = new Uint8Array(XUCRED_SIZE);
        const credLen = new Uint32Array([XUCRED_SIZE]);
        if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, ffi.ptr(cred), ffi.ptr(credLen)) !== 0) return null;
        const pid = new Int32Array(1);
        const pidLen = new Uint32Array([4]);
        if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, ffi.ptr(pid), ffi.ptr(pidLen)) !== 0) return null;
        const uid = new DataView(cred.buffer).getUint32(XUCRED_UID_OFFSET, true);
        return pid[0]! > 1 ? { uid, pid: pid[0]! } : null;
      },
      process(pid) {
        const info = new Uint8Array(BSDINFO_SIZE);
        if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ffi.ptr(info), BSDINFO_SIZE) !== BSDINFO_SIZE) return null;
        const view = new DataView(info.buffer);
        return {
          ppid: view.getUint32(16, true),
          uid: view.getUint32(20, true),
          startSec: view.getBigUint64(120, true),
          startUsec: view.getBigUint64(128, true),
        };
      },
      cwd(pid) {
        const info = new Uint8Array(VNODEPATHINFO_SIZE);
        if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, ffi.ptr(info), VNODEPATHINFO_SIZE) !== VNODEPATHINFO_SIZE) return null;
        const path = info.subarray(CDIR_PATH_OFFSET, CDIR_PATH_OFFSET + MAXPATHLEN);
        const end = path.indexOf(0);
        if (end <= 0) return null;
        return new TextDecoder('utf-8', { fatal: true }).decode(path.subarray(0, end));
      },
      confined(pid) {
        try {
          return sandbox_check(pid, null, 0) !== 0;
        } catch {
          return true;
        }
      },
    };
  } catch {
    return null;
  }
}

/** The kernel reader, or null where it cannot be bound (not macOS under Bun). */
export function peerReader(): PeerReader | null {
  if (override !== undefined) return override;
  if (bound === undefined) bound = bind();
  return bound;
}

/** Tests only: a reader that stands in for the kernel, `null` for none, `undefined` restores. */
export function setPeerReaderForTests(reader: PeerReader | null | undefined): void {
  override = reader;
}

/** The file descriptor under one accepted `node:net` socket, or null when it cannot be read. */
export function socketFd(socket: unknown): number | null {
  const handle = (socket as { _handle?: { fd?: unknown } } | null)?._handle;
  const fd = handle?.fd;
  return typeof fd === 'number' && Number.isInteger(fd) && fd >= 0 ? fd : null;
}
