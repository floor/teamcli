// A record read that is also the folder check. Each folder is opened from the one above it,
// without following a link, and the record is opened from the last folder. A path opened by
// name walks the chain again, so the open here is the one the bus uses.
//
// The open is `openat` through the FFI when the process runs under Bun — every test here and
// the daemon run from source — because a chain of held descriptors is the one open a rename
// cannot redirect: each folder is opened from the descriptor of the one above it. The built
// CLI runs on node, which has no `openat` and no FFI, so it walks the chain by opening each
// prefix with O_NOFOLLOW: at each open the component was no link, and the record is read from
// the descriptor that open produced. That is the one difference between the two runtimes — the
// dirfd chain holds each folder it has checked, the prefix walk resolves the path again below
// it — and it is stated here so a reader of either runtime knows which guarantee it has.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { sealedRecordOf, type SealedRead } from '../send/record.ts';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const ENOENT = 2;
const ENOTDIR = 20;
const ELOOP = process.platform === 'linux' ? 40 : 62;

/** What one step of the chain can say: the descriptor it opened, or the refusal word. The two
 *  runtimes produce these from their own opens; everything past the open is shared. */
type Step = { fd: number } | 'missing' | 'link' | 'unreadable';

/** One runtime's way of opening the chain, made for one root: `root` opens the checkout's own
 *  folder; `child` opens `name` in the folder the last open produced — under Bun through its
 *  descriptor, under node as the next prefix, which the walk hands in for exactly that. */
interface Chain {
  root: () => Step;
  child: (dirfd: number | null, name: string, flags: number, prefix: readonly string[]) => Step;
}

/** The shape of `bun:ffi` this module uses, so the built CLI — which never runs this code —
 *  compiles without Bun's types and without resolving the module. */
interface BunFfi {
  dlopen: (
    library: string,
    symbols: Record<string, { args: unknown[]; returns: unknown }>,
  ) => {
    symbols: {
      openat: (dirfd: number, path: Buffer, flags: number) => number;
      __errno_location?: () => number;
      __error?: () => number;
    };
  };
  read: { i32(address: number, offset: number): number };
  FFIType: { i32: unknown; cstring: unknown; ptr: unknown };
}

/** The loaded FFI, or null before the first Bun-side read. `bun:ffi` is required only under
 *  Bun, and only once: the built CLI runs on node and must typecheck and run without it. */
let ffi: { openat: (dirfd: number, path: Buffer, flags: number) => number; errno: () => number } | null = null;

function bunChain(root: string): Chain {
  if (ffi === null) {
    const loaded = require('bun:ffi') as BunFfi;
    const libc = process.platform === 'linux'
      ? loaded.dlopen('libc.so.6', {
          openat: { args: [loaded.FFIType.i32, loaded.FFIType.cstring, loaded.FFIType.i32], returns: loaded.FFIType.i32 },
          __errno_location: { args: [], returns: loaded.FFIType.ptr },
        })
      : loaded.dlopen('libSystem.B.dylib', {
          openat: { args: [loaded.FFIType.i32, loaded.FFIType.cstring, loaded.FFIType.i32], returns: loaded.FFIType.i32 },
          __error: { args: [], returns: loaded.FFIType.ptr },
        });
    const errnoAt = process.platform === 'linux'
      ? libc.symbols.__errno_location!
      : libc.symbols.__error!;
    ffi = {
      openat: libc.symbols.openat,
      errno: () => loaded.read.i32(errnoAt(), 0),
    };
  }
  const { openat, errno } = ffi;
  const child = (dirfd: number | null, name: string, flags: number): Step => {
    if (dirfd === null) throw new Error('the chain holds no folder to open from');
    const fd = openat(dirfd, Buffer.from(`${name}\0`), flags);
    if (fd >= 0) return { fd };
    const code = errno();
    if (code === ENOENT) return 'missing';
    if (code === ELOOP || code === ENOTDIR) return 'link';
    return 'unreadable';
  };
  return {
    root: () => {
      try {
        return { fd: openSync(root, constants.O_RDONLY | DIRECTORY) };
      } catch {
        return 'unreadable';
      }
    },
    child: (dirfd, name, flags) => child(dirfd, name, flags),
  };
}

/** The node walk: each prefix is opened with O_NOFOLLOW, so a link anywhere in the chain is
 *  refused at its own open. The descriptor the last open produced is the one read. */
function nodeChain(root: string): Chain {
  const open = (path: string, flags: number): Step => {
    try {
      return { fd: openSync(path, flags) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return 'missing';
      if (code === 'ELOOP' || code === 'ENOTDIR') return 'link';
      return 'unreadable';
    }
  };
  return {
    root: () => open(root, constants.O_RDONLY | DIRECTORY),
    child: (_dirfd: number | null, name: string, flags: number, prefix: readonly string[]) =>
      open(join(root, ...prefix, name), flags),
  };
}

/** The chain the bus reads through: the FFI dirfd chain under Bun, the prefix walk on node. */
export const nodeFolderChain = nodeChain;

/**
 * The signed envelope at `folders`/`name` under `root`. A missing record is `sealed: null`.
 * A link in the chain is not followed. Anything else that cannot be opened is not a record.
 */
export function readSealedRelative(root: string, folders: readonly string[], name: string): SealedRead {
  return readThrough(process.versions.bun !== undefined ? bunChain(root) : nodeChain(root), root, folders, name);
}

/** The same read through a handed-in chain, so the tests hold both runtimes' walks to the one
 *  contract. */
export function readThrough(chain: Chain, root: string, folders: readonly string[], name: string): SealedRead {
  if (NOFOLLOW === 0 || DIRECTORY === 0) return { ok: false, reason: 'the record could not be read' };
  const segments = [...folders, name];
  if (segments.some((part) => part === '' || part === '.' || part === '..' || part.includes('/') || part.includes('\0'))) {
    return { ok: false, reason: 'the record could not be read' };
  }
  const opened: number[] = [];
  const first = chain.root();
  if (typeof first === 'string') return { ok: false, reason: 'the record could not be read' };
  opened.push(first.fd);
  let dirfd: number | null = first.fd;
  try {
    for (let index = 0; index < segments.length; index += 1) {
      const last = index === segments.length - 1;
      const step = chain.child(dirfd, segments[index]!, constants.O_RDONLY | NOFOLLOW | (last ? 0 : DIRECTORY), segments.slice(0, index));
      if (step === 'missing') return { ok: true, sealed: null };
      if (step === 'link') return { ok: false, reason: 'a symbolic link was found and not followed' };
      if (step === 'unreadable') return { ok: false, reason: 'the record could not be read' };
      opened.push(step.fd);
      if (!last) dirfd = step.fd;
    }
    const file = opened[opened.length - 1]!;
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
    for (const fd of opened.reverse()) {
      try {
        closeSync(fd);
      } catch {
        // Closed already, or never a descriptor.
      }
    }
  }
}
