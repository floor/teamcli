// A record read that is also the folder check. Each folder is opened from the one above it,
// without following a link, and the record is opened from the last folder. A path opened by
// name walks the chain again, so the open here is the one the bus uses.
import { dlopen, FFIType, read } from 'bun:ffi';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { sealedRecordOf, type SealedRead } from '../send/record.ts';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const ENOENT = 2;
const ENOTDIR = 20;
const ELOOP = process.platform === 'linux' ? 40 : 62;

const libc = process.platform === 'linux'
  ? dlopen('libc.so.6', {
      openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    })
  : dlopen('libSystem.B.dylib', {
      openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });

function errno(): number {
  const at = process.platform === 'linux'
    ? (libc.symbols as { __errno_location(): number }).__errno_location()
    : (libc.symbols as { __error(): number }).__error();
  return read.i32(at, 0);
}

function openChild(dirfd: number, name: string, flags: number): number | null {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) return null;
  return libc.symbols.openat(dirfd, Buffer.from(`${name}\0`), flags);
}

function closeAll(fds: number[]): void {
  for (const fd of fds.reverse()) {
    try {
      closeSync(fd);
    } catch {
      // Closed already, or never a descriptor.
    }
  }
}

/**
 * The signed envelope at `folders`/`name` under `root`. A missing record is `sealed: null`.
 * A link in the chain is not followed. Anything else that cannot be opened is not a record.
 */
export function readSealedRelative(root: string, folders: readonly string[], name: string): SealedRead {
  if (NOFOLLOW === 0 || DIRECTORY === 0) return { ok: false, reason: 'the record could not be read' };
  let dirfd: number;
  try {
    dirfd = openSync(root, constants.O_RDONLY | DIRECTORY);
  } catch {
    return { ok: false, reason: 'the record could not be read' };
  }
  const opened = [dirfd];
  try {
    for (const folder of folders) {
      const next = openChild(dirfd, folder, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
      if (next === null) return { ok: false, reason: 'the record could not be read' };
      if (next < 0) {
        const code = errno();
        if (code === ENOENT) return { ok: true, sealed: null };
        if (code === ELOOP || code === ENOTDIR) return { ok: false, reason: 'a symbolic link was found and not followed' };
        return { ok: false, reason: 'the record could not be read' };
      }
      opened.push(next);
      dirfd = next;
    }
    const file = openChild(dirfd, name, constants.O_RDONLY | NOFOLLOW);
    if (file === null) return { ok: false, reason: 'the record could not be read' };
    if (file < 0) {
      const code = errno();
      if (code === ENOENT) return { ok: true, sealed: null };
      if (code === ELOOP || code === ENOTDIR) return { ok: false, reason: 'a symbolic link was found and not followed' };
      return { ok: false, reason: 'the record could not be read' };
    }
    opened.push(file);
    const stat = fstatSync(file);
    if (!stat.isFile()) return { ok: false, reason: 'the record is not a regular file' };
    if (process.getuid !== undefined && stat.uid !== process.getuid()) return { ok: false, reason: "another user's file" };
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(8192);
    for (;;) {
      const n = readSync(file, buf, 0, buf.length, null);
      if (n === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'the record is not JSON' };
    }
    const sealed = sealedRecordOf(parsed);
    if (sealed === null) return { ok: false, reason: 'the record is not a signed record' };
    return { ok: true, sealed };
  } catch {
    return { ok: false, reason: 'the record could not be read' };
  } finally {
    closeAll(opened);
  }
}
