// Automatic transport-drop archive and reclamation pass for the chores child.
//
// Slice 1 moves retired drops and their companion sidecars from `<root>/.agents/send-drops/<session>/<seat>/`
// into `<root>/.agents/send-drops/.archive/<YYYY-MM-DD>/<session>/<seat>/`, accompanied by a signed
// manifest record under `<root>/.agents/send-drops/.archive/<YYYY-MM-DD>/manifest-<stamp>.json`.
// Slice 3 reclaims archived drop families inside `<root>/.agents/send-drops/.archive/<YYYY-MM-DD>/<session>/<seat>/`
// once they pass the long archive window, verifying the signed manifest and every file's SHA-256
// digest and byte length before unlinking via held directory descriptors while keeping the signed
// manifest record intact.
//
// Safety rules:
// 1. Only a verified message record with a verified read or replied receipt (`isRead`) and no
//    `.pending`, `.taken`, `.fallback.json` or `.fallback-note-*` marker, whose signed `at`
//    timestamps (record and verified receipts) are older than the resolved retention window, may
//    move. Unread drops, general briefs and client records never move.
// 2. Never follow a symbolic link, never leave `<root>/.agents/send-drops`, and refuse the whole
//    pass before moving anything if any link, non-regular entry, foreign-owned entry or unexpected
//    file name appears anywhere in the tree.
// 3. Source and destination directories are opened step-by-step from `send-drops` with
//    `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` (`openat`/`mkdirat` via the host C library FFI in both
//    supported JS runtimes) and held open across the pass; moves use `renameatx_np(..., RENAME_EXCL)`
//    / `renameat2(..., RENAME_NOREPLACE)` relative to the held directory descriptors (and the
//    manifest is created with `openat(..., O_CREAT | O_EXCL | O_NOFOLLOW)` plus `fchmodSync(fd, 0o600)`),
//    with parent-chain `(dev, ino)` re-verification and automatic rollback if any directory in the
//    chain was swapped after the check. When relative directory-descriptor moves are unavailable on
//    the current runtime, the pass refuses before any folder creation or rename.
// 4. Within each family, the record and non-receipt sidecars move first and the read/replied
//    receipts move last. If the pass stops at a slice boundary or fails on a later family, every
//    family that left the live folder is recorded in a signed manifest and named in the report.
// 5. `.unread.json` stays in the live seat folder: unread ids stay untouched, and any stale entry
//    naming a drop that was just archived is pruned atomically.
import { createHash, type KeyObject } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { SweepSlices } from '../daemon/fallback-sweep.ts';
import { projectIdOfTeam } from '../dev_mode.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import { folderProblem, folderProblemAt } from '../held.ts';
import { GENERAL_BRIEF_FROM, GENERAL_BRIEF_RULE, isGeneralBriefRecord } from '../launch/general-brief.ts';
import { heldAt } from '../launch/rules-file.ts';
import { channelCommitActive } from '../mcp/channel.ts';
import { currentClaimIn } from '../mcp/inbox.ts';
import { DAEMON_BACKLOG_DEFAULTS, eventThresholdsInForce } from '../policy/index.ts';
import { messageKeyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import type { MovedFile } from './message-archive.ts';
import {
  closeAuthOf,
  receiptAuthOf,
  recordAuthOf,
  sameFolder,
  type ReceiptStatus,
  type RecordPayload,
} from './record.ts';

export const DROP_ARCHIVE_DOMAIN = 'teamcli-drop-archive-v1\0';
export const DROP_ARCHIVE_DIR = '.archive';

/** Default steady-state limit per pass, matching `FALLBACK_STORE_PASS_LIMIT`. */
export const DROP_ARCHIVE_PASS_LIMIT = 256;

/** Multiplier applied to the live retention window to compute the long archive window. */
export const DROP_ARCHIVE_LONG_WINDOW_MULTIPLIER = 3;

/** Minimum long archive window (90 days) before archived drops are eligible for reclamation. */
export const DROP_ARCHIVE_MIN_LONG_WINDOW_MS = 90 * 86_400_000;

const NOFOLLOW = constants.O_NOFOLLOW ?? 0x0100;
const DIRECTORY = constants.O_DIRECTORY ?? 0x100000;
const EEXIST = 17;
const ENOTDIR = 20;
const ELOOP = process.platform === 'linux' ? 40 : 62;
const RENAME_EXCL = 0x00000004;
const RENAME_NOREPLACE = 1;
const AT_REMOVEDIR = process.platform === 'linux' ? 0x200 : 0x0080;

const RECORD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const WORK_PREFIX = 'work-';

/** Sidecars moved after the message record and before the read/replied receipts. */
const PRE_RECEIPT_SUFFIXES: readonly string[] = [
  '.wake',
  '.wake-try',
  '.reported',
  '.draft',
  '.closed.json',
  '.channel-push.json',
  '.held.json',
  '.delivered.json',
  '.held',
  '.delivered',
];

/** Terminal receipts moved last so a crash never leaves the message record without its receipt. */
const RECEIPT_SUFFIXES: readonly string[] = [
  '.replied',
  '.read',
  '.replied.json',
  '.read.json',
];

/** Known fixed sidecar suffixes that may legitimately sit beside a message id in a seat folder. */
const KNOWN_SIDECAR_SUFFIXES: readonly string[] = [
  ...PRE_RECEIPT_SUFFIXES,
  ...RECEIPT_SUFFIXES,
  '.pending',
  '.taken',
  '.fallback.json',
  // The commit lock is a synchronization file. It is expected beside a record and it is never
  // moved: archiving it would free the name while a holder still has the inode.
  '.channel-commit.lock',
];

const FALLBACK_NOTE_SUFFIX = /^\.fallback-note-[0-9a-f]{16}\.json$/;
const RECEIPT_TEMP_SUFFIX = /^\.(?:read|replied|delivered|held)\.json\.[0-9]+\.[0-9a-f]+\.new$/;
const UNREAD_TEMP_NAME = /^\.unread\.json\.[0-9]+\.tmp$/;
const RESERVE_TEMP_NAME = /^\.[0-9]+\.[0-9a-f]+\.tmp$/;

export type DropArchiveFamily = {
  session: string;
  seat: string;
  id: string;
  files: MovedFile[];
};

export type DropArchivePayload = {
  kind: 'drop-archive';
  format: 1;
  root: string;
  date: string;
  at: string;
  families: DropArchiveFamily[];
};

export type SignedDropArchive = {
  payload: DropArchivePayload;
  signature: string;
};

/**
 * Relative directory-descriptor operations bound from the host C library via FFI (`bun:ffi` or
 * `node:ffi`). When unavailable (`null`), the archive pass refuses before any rename.
 */
export type RelativeDirOps = {
  openat: (dirfd: number, name: string, flags: number, mode?: number) => { fd: number; errno: number };
  mkdirat: (dirfd: number, name: string, mode: number) => { ok: boolean; errno: number };
  renameatExcl: (fromfd: number, fromName: string, tofd: number, toName: string) => { ok: boolean; errno: number };
  renameatReplace: (fromfd: number, fromName: string, tofd: number, toName: string) => { ok: boolean; errno: number };
  unlinkat: (dirfd: number, name: string) => { ok: boolean; errno: number };
  rmdirat?: (dirfd: number, name: string) => { ok: boolean; errno: number };
};

export type DropRetirementInput = {
  root: string;
  home: string;
  team?: TeamFile;
  at: Date;
  /** Override the retention window in ms; absent, resolves `event-retention-days` for the root. */
  olderThanMs?: number;
  /** Override the long archive window in ms before archived drops are reclaimed; absent, uses `max(retentionMs * 3, 90d)`. */
  archiveOlderThanMs?: number;
  limit?: number;
  backlogAbove?: number;
  backlogLimit?: number;
  /** Override or disable relative directory-descriptor operations (`null` forces the unavailable-FFI refusal). */
  atFfi?: RelativeDirOps | null;
};

export type DropRetirementReport = {
  at: string;
  archived: DropArchiveFamily[];
  reclaimed: DropArchiveFamily[];
  manifestPath: string | null;
  scanned: number;
  stayed: number;
  refused: string | null;
};

/** Shape of `bun:ffi` used when running under Bun, so `tsc -p tsconfig.build.json` compiles without Bun types. */
interface BunFfi {
  dlopen: (
    library: string,
    symbols: Record<string, { args: unknown[]; returns: unknown }>,
  ) => {
    symbols: {
      openat: (dirfd: number, path: Buffer, flags: number, mode: number) => number;
      mkdirat: (dirfd: number, path: Buffer, mode: number) => number;
      renameat: (fromfd: number, from: Buffer, tofd: number, to: Buffer) => number;
      renameatx_np?: (fromfd: number, from: Buffer, tofd: number, to: Buffer, flags: number) => number;
      renameat2?: (fromfd: number, from: Buffer, tofd: number, to: Buffer, flags: number) => number;
      unlinkat: (dirfd: number, path: Buffer, flags: number) => number;
      __errno_location?: () => number;
      __error?: () => number;
    };
  };
  read: { i32(address: number, offset: number): number };
  FFIType: { i32: unknown; u32: unknown; cstring: unknown; ptr: unknown };
}

/** Shape of `node:ffi` when available in the host Node runtime. */
interface NodeFfi {
  dlopen: (
    library: string,
    definitions: Record<string, { arguments: string[]; return: string }>,
  ) => {
    functions: {
      openat: (dirfd: number, path: string, flags: number, mode: number) => number;
      mkdirat: (dirfd: number, path: string, mode: number) => number;
      renameat: (fromfd: number, from: string, tofd: number, to: string) => number;
      renameatx_np?: (fromfd: number, from: string, tofd: number, to: string, flags: number) => number;
      renameat2?: (fromfd: number, from: string, tofd: number, to: string, flags: number) => number;
      unlinkat: (dirfd: number, path: string, flags: number) => number;
      __errno_location?: () => bigint;
      __error?: () => bigint;
    };
  };
  getInt32: (address: bigint, offset: number) => number;
}

let cachedDirOps: RelativeDirOps | null | undefined;

function cstr(name: string): Buffer {
  return Buffer.from(`${name}\0`, 'utf8');
}

function loadBunDirOps(req: NodeRequire): RelativeDirOps {
  const ffi = req('bun:ffi') as BunFfi;
  const hasErrnoLocation = process.platform === 'linux';
  const lib = hasErrnoLocation
    ? ffi.dlopen('libc.so.6', {
        openat: {
          args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32, ffi.FFIType.i32],
          returns: ffi.FFIType.i32,
        },
        mkdirat: {
          args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32],
          returns: ffi.FFIType.i32,
        },
        renameat: {
          args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32, ffi.FFIType.cstring],
          returns: ffi.FFIType.i32,
        },
        renameat2: {
          args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.u32],
          returns: ffi.FFIType.i32,
        },
        unlinkat: {
          args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32],
          returns: ffi.FFIType.i32,
        },
        __errno_location: { args: [], returns: ffi.FFIType.ptr },
      })
    : ffi.dlopen('libSystem.B.dylib', {
        openat: {
          args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32, ffi.FFIType.i32],
          returns: ffi.FFIType.i32,
        },
        mkdirat: {
          args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32],
          returns: ffi.FFIType.i32,
        },
        renameat: {
          args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32, ffi.FFIType.cstring],
          returns: ffi.FFIType.i32,
        },
        renameatx_np: {
          args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.u32],
          returns: ffi.FFIType.i32,
        },
        unlinkat: {
          args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32],
          returns: ffi.FFIType.i32,
        },
        __error: { args: [], returns: ffi.FFIType.ptr },
      });
  const errnoFn = hasErrnoLocation ? lib.symbols.__errno_location! : lib.symbols.__error!;
  const readErrno = (): number => ffi.read.i32(errnoFn(), 0);
  return {
    openat: (dirfd, name, flags, mode = 0) => {
      const fd = lib.symbols.openat(dirfd, cstr(name), flags, mode);
      return { fd, errno: fd < 0 ? readErrno() : 0 };
    },
    mkdirat: (dirfd, name, mode) => {
      const rc = lib.symbols.mkdirat(dirfd, cstr(name), mode);
      return { ok: rc === 0, errno: rc < 0 ? readErrno() : 0 };
    },
    renameatExcl: (fromfd, fromName, tofd, toName) => {
      const rc = hasErrnoLocation
        ? lib.symbols.renameat2!(fromfd, cstr(fromName), tofd, cstr(toName), RENAME_NOREPLACE)
        : lib.symbols.renameatx_np!(fromfd, cstr(fromName), tofd, cstr(toName), RENAME_EXCL);
      return { ok: rc === 0, errno: rc < 0 ? readErrno() : 0 };
    },
    renameatReplace: (fromfd, fromName, tofd, toName) => {
      const rc = lib.symbols.renameat(fromfd, cstr(fromName), tofd, cstr(toName));
      return { ok: rc === 0, errno: rc < 0 ? readErrno() : 0 };
    },
    unlinkat: (dirfd, name) => {
      const rc = lib.symbols.unlinkat(dirfd, cstr(name), 0);
      return { ok: rc === 0, errno: rc < 0 ? readErrno() : 0 };
    },
    rmdirat: (dirfd, name) => {
      const rc = lib.symbols.unlinkat(dirfd, cstr(name), AT_REMOVEDIR);
      return { ok: rc === 0, errno: rc < 0 ? readErrno() : 0 };
    },
  };
}

function loadNodeDirOps(req: NodeRequire): RelativeDirOps {
  const ffi = req('node:ffi') as NodeFfi;
  const hasErrnoLocation = process.platform === 'linux';
  const lib = hasErrnoLocation
    ? ffi.dlopen('libc.so.6', {
        openat: { arguments: ['int32', 'string', 'int32', 'int32'], return: 'int32' },
        mkdirat: { arguments: ['int32', 'string', 'int32'], return: 'int32' },
        renameat: { arguments: ['int32', 'string', 'int32', 'string'], return: 'int32' },
        renameat2: { arguments: ['int32', 'string', 'int32', 'string', 'uint32'], return: 'int32' },
        unlinkat: { arguments: ['int32', 'string', 'int32'], return: 'int32' },
        __errno_location: { arguments: [], return: 'pointer' },
      })
    : ffi.dlopen('libSystem.B.dylib', {
        openat: { arguments: ['int32', 'string', 'int32', 'int32'], return: 'int32' },
        mkdirat: { arguments: ['int32', 'string', 'int32'], return: 'int32' },
        renameat: { arguments: ['int32', 'string', 'int32', 'string'], return: 'int32' },
        renameatx_np: { arguments: ['int32', 'string', 'int32', 'string', 'uint32'], return: 'int32' },
        unlinkat: { arguments: ['int32', 'string', 'int32'], return: 'int32' },
        __error: { arguments: [], return: 'pointer' },
      });
  const errnoFn = hasErrnoLocation ? lib.functions.__errno_location! : lib.functions.__error!;
  const readErrno = (): number => ffi.getInt32(errnoFn(), 0);
  return {
    openat: (dirfd, name, flags, mode = 0) => {
      const fd = lib.functions.openat(dirfd, name, flags, mode);
      return { fd, errno: fd < 0 ? readErrno() : 0 };
    },
    mkdirat: (dirfd, name, mode) => {
      const rc = lib.functions.mkdirat(dirfd, name, mode);
      return { ok: rc === 0, errno: rc < 0 ? readErrno() : 0 };
    },
    renameatExcl: (fromfd, fromName, tofd, toName) => {
      const rc = hasErrnoLocation
        ? lib.functions.renameat2!(fromfd, fromName, tofd, toName, RENAME_NOREPLACE)
        : lib.functions.renameatx_np!(fromfd, fromName, tofd, toName, RENAME_EXCL);
      return { ok: rc === 0, errno: rc < 0 ? readErrno() : 0 };
    },
    renameatReplace: (fromfd, fromName, tofd, toName) => {
      const rc = lib.functions.renameat(fromfd, fromName, tofd, toName);
      return { ok: rc === 0, errno: rc < 0 ? readErrno() : 0 };
    },
    unlinkat: (dirfd, name) => {
      const rc = lib.functions.unlinkat(dirfd, name, 0);
      return { ok: rc === 0, errno: rc < 0 ? readErrno() : 0 };
    },
    rmdirat: (dirfd, name) => {
      const rc = lib.functions.unlinkat(dirfd, name, AT_REMOVEDIR);
      return { ok: rc === 0, errno: rc < 0 ? readErrno() : 0 };
    },
  };
}

/**
 * Returns the relative directory-descriptor operations for the current runtime (`bun:ffi` or
 * `node:ffi`), or `null` when unavailable.
 */
export function getRelativeDirOps(): RelativeDirOps | null {
  if (cachedDirOps !== undefined) return cachedDirOps;
  const req = createRequire(import.meta.url);
  try {
    cachedDirOps =
      process.versions.bun !== undefined ? loadBunDirOps(req) : loadNodeDirOps(req);
  } catch {
    cachedDirOps = null;
  }
  return cachedDirOps;
}

type ChainStep = {
  name: string;
  path: string;
  dev: number;
  ino: number;
};

type HeldDir = {
  fd: number;
  path: string;
  dev: number;
  ino: number;
  chain: readonly ChainStep[];
};

function validSegment(part: string): boolean {
  return part !== '' && part !== '.' && part !== '..' && !part.includes('/') && !part.includes('\0');
}

function openRootDirNoFollow(
  dirPath: string,
): { ok: true; fd: number; dev: number; ino: number } | { ok: false; reason: string } {
  const held = heldAt(dirPath);
  if (held.kind === 'link') return { ok: false, reason: `${dirPath}: a symbolic link was found and not followed` };
  const problem = folderProblem(held);
  if (problem !== null) return { ok: false, reason: `${dirPath}: ${problem}` };
  if (held.kind !== 'folder') return { ok: false, reason: `${dirPath}: unexpected ${held.kind}` };

  let fd = -1;
  try {
    fd = openSync(dirPath, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR' || heldAt(dirPath).kind === 'link') {
      return { ok: false, reason: `${dirPath}: a symbolic link was found and not followed` };
    }
    return { ok: false, reason: `${dirPath}: the state folder could not be opened` };
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) {
      closeSync(fd);
      return { ok: false, reason: `${dirPath}: the state folder path is not a directory` };
    }
    if (process.getuid !== undefined && stat.uid !== process.getuid()) {
      closeSync(fd);
      return { ok: false, reason: `${dirPath}: another user's folder` };
    }
    const lstat = lstatSync(dirPath);
    if (!lstat.isDirectory() || lstat.dev !== stat.dev || lstat.ino !== stat.ino) {
      closeSync(fd);
      return { ok: false, reason: `${dirPath}: a symbolic link was found and not followed` };
    }
    return { ok: true, fd, dev: stat.dev, ino: stat.ino };
  } catch {
    try {
      closeSync(fd);
    } catch {}
    return { ok: false, reason: `${dirPath}: the state folder could not be verified` };
  }
}

function openChildDirNoFollow(
  atFfi: RelativeDirOps,
  parentFd: number,
  childPath: string,
  childName: string,
): { ok: true; fd: number; dev: number; ino: number } | { ok: false; reason: string } {
  const held = heldAt(childPath);
  if (held.kind === 'link') return { ok: false, reason: `${childPath}: a symbolic link was found and not followed` };
  const problem = folderProblem(held);
  if (problem !== null) return { ok: false, reason: `${childPath}: ${problem}` };
  if (held.kind !== 'folder') return { ok: false, reason: `${childPath}: unexpected ${held.kind}` };

  const opened = atFfi.openat(parentFd, childName, constants.O_RDONLY | DIRECTORY | NOFOLLOW, 0);
  if (opened.fd < 0) {
    if (opened.errno === ELOOP || opened.errno === ENOTDIR || heldAt(childPath).kind === 'link') {
      return { ok: false, reason: `${childPath}: a symbolic link was found and not followed` };
    }
    return { ok: false, reason: `${childPath}: the state folder could not be opened` };
  }
  const fd = opened.fd;

  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) {
      closeSync(fd);
      return { ok: false, reason: `${childPath}: the state folder path is not a directory` };
    }
    if (process.getuid !== undefined && stat.uid !== process.getuid()) {
      closeSync(fd);
      return { ok: false, reason: `${childPath}: another user's folder` };
    }
    const lstat = lstatSync(childPath);
    if (!lstat.isDirectory() || lstat.dev !== stat.dev || lstat.ino !== stat.ino) {
      closeSync(fd);
      return { ok: false, reason: `${childPath}: a symbolic link was found and not followed` };
    }
    return { ok: true, fd, dev: stat.dev, ino: stat.ino };
  } catch {
    try {
      closeSync(fd);
    } catch {}
    return { ok: false, reason: `${childPath}: the state folder could not be verified` };
  }
}

/**
 * Opens or creates a chain of subdirectories below `baseHeld` (`send-drops`), one component at a
 * time via `mkdirat` and `openat(..., O_RDONLY | O_DIRECTORY | O_NOFOLLOW)`, without ever
 * following a symbolic link. Every opened descriptor is registered in `pool` so the caller closes
 * all held descriptors in `finally`.
 */
function openSubdirChain(
  atFfi: RelativeDirOps,
  baseHeld: HeldDir,
  parts: readonly string[],
  createMissing: boolean,
  pool: number[],
): { ok: true; dir: HeldDir } | { ok: false; reason: string } {
  let curFd = baseHeld.fd;
  let curPath = baseHeld.path;
  const chain: ChainStep[] = [...baseHeld.chain];
  const intermediateFds: number[] = [];

  try {
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      if (!validSegment(part)) {
        return { ok: false, reason: `${join(curPath, part)}: invalid directory component` };
      }
      const nextPath = join(curPath, part);
      const before = heldAt(nextPath);
      if (before.kind === 'link') {
        return { ok: false, reason: `${nextPath}: a symbolic link was found and not followed` };
      }
      if (before.kind === 'missing') {
        if (!createMissing) {
          return { ok: false, reason: `${nextPath}: missing folder` };
        }
        const mk = atFfi.mkdirat(curFd, part, 0o700);
        if (!mk.ok && mk.errno !== EEXIST) {
          return { ok: false, reason: `${nextPath}: the state folder could not be created` };
        }
      }
      const step = openChildDirNoFollow(atFfi, curFd, nextPath, part);
      if (!step.ok) return step;
      if (createMissing) {
        try {
          fchmodSync(step.fd, 0o700);
        } catch {
          closeSync(step.fd);
          return { ok: false, reason: `${nextPath}: the state folder permissions could not be set to 0700` };
        }
      }
      chain.push({ name: part, path: nextPath, dev: step.dev, ino: step.ino });
      curPath = nextPath;
      curFd = step.fd;
      if (i < parts.length - 1) {
        intermediateFds.push(step.fd);
      } else {
        pool.push(step.fd);
      }
    }
    const last = chain[chain.length - 1];
    return {
      ok: true,
      dir: {
        fd: curFd,
        path: curPath,
        dev: last !== undefined ? last.dev : baseHeld.dev,
        ino: last !== undefined ? last.ino : baseHeld.ino,
        chain,
      },
    };
  } finally {
    for (const fd of intermediateFds) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Re-verifies that `baseHeld` (`send-drops`) and every component in `target.chain` still resolve
 * without symlinks to the exact same `(dev, ino)` as when `target` was opened.
 */
function verifyHeldDirChain(atFfi: RelativeDirOps, baseHeld: HeldDir, target: HeldDir): string | null {
  try {
    const baseStat = fstatSync(baseHeld.fd);
    const baseLstat = lstatSync(baseHeld.path);
    if (
      !baseStat.isDirectory() ||
      !baseLstat.isDirectory() ||
      baseStat.dev !== baseHeld.dev ||
      baseStat.ino !== baseHeld.ino ||
      baseLstat.dev !== baseHeld.dev ||
      baseLstat.ino !== baseHeld.ino
    ) {
      return `${baseHeld.path}: a symbolic link was found and not followed`;
    }
  } catch {
    return `${baseHeld.path}: a symbolic link was found and not followed`;
  }

  let curFd = baseHeld.fd;
  const opened: number[] = [];
  try {
    for (const step of target.chain) {
      const checked = openChildDirNoFollow(atFfi, curFd, step.path, step.name);
      if (!checked.ok) return checked.reason;
      opened.push(checked.fd);
      if (checked.dev !== step.dev || checked.ino !== step.ino) {
        return `${step.path}: a symbolic link was found and not followed`;
      }
      curFd = checked.fd;
    }
    const targetStat = fstatSync(target.fd);
    if (!targetStat.isDirectory() || targetStat.dev !== target.dev || targetStat.ino !== target.ino) {
      return `${target.path}: a symbolic link was found and not followed`;
    }
    return null;
  } catch {
    return `${target.path}: a symbolic link was found and not followed`;
  } finally {
    for (const fd of opened) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function moveFileBetweenHeldDirs(
  atFfi: RelativeDirOps,
  baseHeld: HeldDir,
  srcHeld: HeldDir,
  destHeld: HeldDir,
  fileName: string,
  root: string,
): { ok: true } | { ok: false; reason: string } {
  const srcPath = join(srcHeld.path, fileName);
  const destPath = join(destHeld.path, fileName);

  const srcChainProblem = verifyHeldDirChain(atFfi, baseHeld, srcHeld);
  if (srcChainProblem !== null) return { ok: false, reason: srcChainProblem };
  const destChainProblem = verifyHeldDirChain(atFfi, baseHeld, destHeld);
  if (destChainProblem !== null) return { ok: false, reason: destChainProblem };

  const existingDest = heldAt(destPath);
  if (existingDest.kind === 'link') {
    return { ok: false, reason: `${destPath}: a symbolic link was found and not followed` };
  }
  if (existingDest.kind !== 'missing') {
    return { ok: false, reason: `${destPath}: destination already holds ${fileName}` };
  }

  const moved = atFfi.renameatExcl(srcHeld.fd, fileName, destHeld.fd, fileName);
  if (!moved.ok) {
    if (heldAt(destPath).kind === 'link') {
      return { ok: false, reason: `${destPath}: a symbolic link was found and not followed` };
    }
    if (moved.errno === EEXIST) {
      return { ok: false, reason: `${destPath}: destination already holds ${fileName}` };
    }
    return {
      ok: false,
      reason: `cannot move ${relative(root, srcPath)}: errno ${String(moved.errno)}`,
    };
  }

  // Re-verify the destination parent chain after the rename; if any parent was swapped between
  // the pre-check and the rename, undo the move immediately using the held directory descriptors.
  const postChainProblem = verifyHeldDirChain(atFfi, baseHeld, destHeld);
  const postHeld = heldAt(destPath);
  if (postChainProblem !== null || postHeld.kind !== 'file') {
    undoMovedFile(atFfi, destHeld, srcHeld, fileName);
    return {
      ok: false,
      reason: postChainProblem ?? `${destPath}: a symbolic link was found and not followed`,
    };
  }
  return { ok: true };
}

function undoMovedFile(atFfi: RelativeDirOps, destHeld: HeldDir, srcHeld: HeldDir, fileName: string): void {
  atFfi.renameatReplace(destHeld.fd, fileName, srcHeld.fd, fileName);
}

function unlinkInHeldDir(atFfi: RelativeDirOps, dirHeld: HeldDir, fileName: string): void {
  atFfi.unlinkat(dirHeld.fd, fileName);
}

function unlinkFileInHeldDir(
  atFfi: RelativeDirOps,
  baseHeld: HeldDir,
  dirHeld: HeldDir,
  fileName: string,
  root: string,
): { ok: true } | { ok: false; reason: string } {
  const fullPath = join(dirHeld.path, fileName);
  const preProblem = verifyHeldDirChain(atFfi, baseHeld, dirHeld);
  if (preProblem !== null) return { ok: false, reason: preProblem };

  const held = heldAt(fullPath);
  if (held.kind === 'link') {
    return { ok: false, reason: `${fullPath}: a symbolic link was found and not followed` };
  }
  if (held.kind !== 'file') {
    return { ok: false, reason: `${fullPath}: unexpected ${held.kind}` };
  }

  const unlinked = atFfi.unlinkat(dirHeld.fd, fileName);
  if (!unlinked.ok) {
    const postProblem = verifyHeldDirChain(atFfi, baseHeld, dirHeld);
    if (postProblem !== null) return { ok: false, reason: postProblem };
    if (heldAt(fullPath).kind === 'link') {
      return { ok: false, reason: `${fullPath}: a symbolic link was found and not followed` };
    }
    return {
      ok: false,
      reason: `cannot unlink ${relative(root, fullPath)}: errno ${String(unlinked.errno)}`,
    };
  }

  const postProblem = verifyHeldDirChain(atFfi, baseHeld, dirHeld);
  if (postProblem !== null) {
    return { ok: false, reason: postProblem };
  }
  return { ok: true };
}

function restoreUnlinkedInHeldDir(
  atFfi: RelativeDirOps,
  dirHeld: HeldDir,
  fileName: string,
  bytes: Buffer,
): { ok: true } | { ok: false; reason: string } {
  const existing = atFfi.openat(dirHeld.fd, fileName, constants.O_RDONLY | NOFOLLOW, 0);
  if (existing.fd >= 0) {
    let matches = false;
    try {
      const stat = fstatSync(existing.fd);
      if (stat.isFile()) {
        const current = readFileSync(existing.fd);
        matches = current.byteLength === bytes.byteLength && current.equals(bytes);
      }
    } catch {}
    try {
      closeSync(existing.fd);
    } catch {}
    if (matches) return { ok: true };
    return {
      ok: false,
      reason: `cannot restore ${fileName}: existing file does not match verified bytes`,
    };
  }

  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
  const opened = atFfi.openat(dirHeld.fd, fileName, flags, 0o600);
  if (opened.fd < 0) {
    return {
      ok: false,
      reason: `cannot restore ${fileName}: openat errno ${String(opened.errno)}`,
    };
  }
  const fd = opened.fd;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { ok: false, reason: `cannot restore ${fileName}: not a regular file` };
    }
    fchmodSync(fd, 0o600);
    for (let wrote = 0; wrote < bytes.length;) {
      const n = writeSync(fd, bytes, wrote, bytes.length - wrote);
      if (n <= 0) {
        throw new Error('short write');
      }
      wrote += n;
    }
  } catch (error) {
    try {
      closeSync(fd);
    } catch {}
    atFfi.unlinkat(dirHeld.fd, fileName);
    return {
      ok: false,
      reason: `cannot restore ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    closeSync(fd);
  } catch (error) {
    return {
      ok: false,
      reason: `cannot restore ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true };
}

/**
 * Creates a new file with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` relative to `dirHeld.fd`,
 * sets mode `0600` on the descriptor before writing (`openat`'s 4th parameter is variadic in the
 * host C library ABI), writes `bytes`, and re-verifies the parent directory chain.
 */
function writeNewFileInHeldDir(
  atFfi: RelativeDirOps,
  baseHeld: HeldDir,
  dirHeld: HeldDir,
  fileName: string,
  bytes: Buffer,
): { ok: true; path: string } | { ok: false; code: 'eexist' | 'error'; reason: string } {
  const fullPath = join(dirHeld.path, fileName);
  const preProblem = verifyHeldDirChain(atFfi, baseHeld, dirHeld);
  if (preProblem !== null) return { ok: false, code: 'error', reason: preProblem };

  const held = heldAt(fullPath);
  if (held.kind === 'link') {
    return { ok: false, code: 'error', reason: `${fullPath}: a symbolic link was found and not followed` };
  }
  if (held.kind !== 'missing') {
    return { ok: false, code: 'eexist', reason: `${fullPath}: file already exists` };
  }

  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
  const opened = atFfi.openat(dirHeld.fd, fileName, flags, 0o600);
  if (opened.fd < 0) {
    if (opened.errno === EEXIST) {
      return { ok: false, code: 'eexist', reason: `${fullPath}: file already exists` };
    }
    if (opened.errno === ELOOP || heldAt(fullPath).kind === 'link') {
      return { ok: false, code: 'error', reason: `${fullPath}: a symbolic link was found and not followed` };
    }
    return { ok: false, code: 'error', reason: `${fullPath}: errno ${String(opened.errno)}` };
  }
  const fd = opened.fd;

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { ok: false, code: 'error', reason: `${fullPath}: not a regular file` };
    }
    fchmodSync(fd, 0o600);
    for (let wrote = 0; wrote < bytes.length;) {
      wrote += writeSync(fd, bytes, wrote, bytes.length - wrote);
    }
  } catch (error) {
    try {
      closeSync(fd);
    } catch {}
    unlinkInHeldDir(atFfi, dirHeld, fileName);
    return {
      ok: false,
      code: 'error',
      reason: `${fullPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  closeSync(fd);

  const postProblem = verifyHeldDirChain(atFfi, baseHeld, dirHeld);
  if (postProblem !== null || heldAt(fullPath).kind !== 'file') {
    unlinkInHeldDir(atFfi, dirHeld, fileName);
    return {
      ok: false,
      code: 'error',
      reason: postProblem ?? `${fullPath}: a symbolic link was found and not followed`,
    };
  }
  return { ok: true, path: fullPath };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMovedFile(value: unknown): value is MovedFile {
  if (!isRecord(value)) return false;
  return (
    typeof value.digest === 'string' &&
    value.digest !== '' &&
    typeof value.bytes === 'number' &&
    Number.isInteger(value.bytes) &&
    value.bytes >= 0 &&
    typeof value.source === 'string' &&
    value.source !== '' &&
    typeof value.dest === 'string' &&
    value.dest !== ''
  );
}

function isArchiveFamily(value: unknown): value is DropArchiveFamily {
  if (!isRecord(value)) return false;
  if (typeof value.session !== 'string' || !RECORD_NAME.test(value.session)) return false;
  if (typeof value.seat !== 'string' || !RECORD_NAME.test(value.seat)) return false;
  if (typeof value.id !== 'string' || !RECORD_NAME.test(value.id)) return false;
  if (!Array.isArray(value.files) || value.files.length === 0) return false;
  return value.files.every(isMovedFile);
}

/** Verifies a signed drop-archive manifest against `key`, returning its payload or null. */
export function verifyDropArchive(raw: unknown, key: KeyObject): DropArchivePayload | null {
  if (!isRecord(raw) || typeof raw.signature !== 'string' || raw.signature === '') return null;
  const payload = raw.payload;
  if (!isRecord(payload)) return null;
  if (payload.kind !== 'drop-archive' || payload.format !== 1) return null;
  if (typeof payload.root !== 'string' || payload.root === '') return null;
  if (typeof payload.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) return null;
  if (typeof payload.at !== 'string' || !Number.isFinite(Date.parse(payload.at))) return null;
  if (!Array.isArray(payload.families) || !payload.families.every(isArchiveFamily)) return null;
  if (!verifyDomain(DROP_ARCHIVE_DOMAIN, payload as unknown as Json, raw.signature, key)) return null;
  return payload as unknown as DropArchivePayload;
}

/** Whether `name` is an expected regular file name inside `.agents/send-drops/<session>/<seat>/`. */
function isExpectedSeatDropFile(name: string): boolean {
  if (name === '.inbox-listener' || name === '.unread.json') return true;
  if (UNREAD_TEMP_NAME.test(name) || RESERVE_TEMP_NAME.test(name)) return true;
  if (!name.includes('.')) return RECORD_NAME.test(name);
  const dot = name.indexOf('.');
  const id = name.slice(0, dot);
  const suffix = name.slice(dot);
  if (id === '' || !RECORD_NAME.test(id) || id.startsWith(WORK_PREFIX)) return false;
  if (KNOWN_SIDECAR_SUFFIXES.includes(suffix)) return true;
  if (/^\.channel-commit\.prep-[0-9]+-[0-9a-f]+$/.test(suffix)) return true;
  if (suffix === '.channel-commit.reclaim' || /^\.channel-commit\.dead-[0-9]+$/.test(suffix)) return true;
  if (/^\.channel-commit\.reclaim-aside-[0-9]+-[0-9a-f]+$/.test(suffix)) return true;
  if (suffix === '.channel-commit.reclaim.stall') return true;
  if (FALLBACK_NOTE_SUFFIX.test(suffix) || RECEIPT_TEMP_SUFFIX.test(suffix)) return true;
  return false;
}

/** Reads a regular file with `O_NOFOLLOW` relative to `dirHeld.fd` and returns its bytes, or throws. */
function readRegularNoFollowInDir(atFfi: RelativeDirOps, dirHeld: HeldDir, name: string): Buffer {
  const path = join(dirHeld.path, name);
  const held = heldAt(path);
  if (held.kind === 'link') throw new Error(`${path}: a symbolic link was found and not followed`);
  if (held.kind !== 'file') throw new Error(`${path}: not a regular file`);
  if (process.getuid !== undefined && held.uid !== process.getuid()) {
    throw new Error(`${path}: another user's file`);
  }
  const opened = atFfi.openat(dirHeld.fd, name, constants.O_RDONLY | NOFOLLOW, 0);
  if (opened.fd < 0) {
    throw new Error(
      opened.errno === ELOOP
        ? `${path}: a symbolic link was found and not followed`
        : `${path}: cannot open file`,
    );
  }
  const fd = opened.fd;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path}: not a regular file`);
    if (process.getuid !== undefined && stat.uid !== process.getuid()) {
      throw new Error(`${path}: another user's file`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function insideSendDrops(sendDropsDir: string, target: string): boolean {
  const rel = relative(sendDropsDir, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function resolveRetentionMs(
  root: string,
  home: string,
  team: TeamFile | undefined,
  at: Date,
  explicitMs: number | undefined,
): { ms: number; keepAll: boolean; refusal: null } | { ms: null; keepAll: false; refusal: string } {
  if (explicitMs !== undefined) {
    return Number.isFinite(explicitMs) && explicitMs >= 0
      ? { ms: explicitMs, keepAll: explicitMs === 0, refusal: null }
      : { ms: null, keepAll: false, refusal: 'the drop retention window is not a valid duration' };
  }
  let resolvedTeam = team;
  if (resolvedTeam === undefined) {
    const loaded = readTeamConfig(root, { home });
    if (!loaded.ok) {
      return { ms: null, keepAll: false, refusal: loaded.errors[0]?.message ?? 'the team file cannot be read' };
    }
    resolvedTeam = loaded.team;
  }
  const inForce = eventThresholdsInForce({
    home,
    entity: resolvedTeam.entity ?? '',
    projectId: projectIdOfTeam(home, resolvedTeam, root) ?? '',
    root,
    team: resolvedTeam,
    now: at,
    upToLevel: 'team',
  });
  if (!inForce.ok) {
    const why = inForce.refusals.map((r) => r.message).join('; ');
    return { ms: null, keepAll: false, refusal: why === '' ? 'the retention policy could not be read' : why };
  }
  const days = inForce.thresholds.retention_days;
  return { ms: days * 86_400_000, keepAll: days === 0, refusal: null };
}

function isClientRecord(payload: RecordPayload): boolean {
  return payload.from_client !== undefined || payload.to_client !== undefined;
}

/**
 * Verifies a receipt file in `seatHeld` for `(id, status, seat, root, session)` and returns its
 * signed `at` timestamp in ms, or null when missing, unverified, or carrying a non-finite `at`.
 */
function verifiedReceiptAtMs(
  atFfi: RelativeDirOps,
  seatHeld: HeldDir,
  id: string,
  status: ReceiptStatus,
  context: { to: string; root: string; session: string },
  key: KeyObject,
): number | null {
  let data: Buffer;
  try {
    data = readRegularNoFollowInDir(atFfi, seatHeld, `${id}.${status}.json`);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8')) as unknown;
  } catch {
    return null;
  }
  const auth = receiptAuthOf(parsed, key);
  if (auth.kind !== 'ok') return null;
  const payload = auth.value.payload;
  if (payload.id !== id || payload.status !== status) return null;
  if (payload.to !== context.to || payload.session !== context.session) return null;
  if (!sameFolder(payload.root, context.root)) return null;
  const ms = Date.parse(payload.at);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Verifies a `.closed.json` file in `seatHeld` for `(id, root, session)` and returns its signed
 * `at` timestamp in ms, or null when missing, unverified, or carrying a non-finite `at`.
 */
function verifiedCloseAtMs(
  atFfi: RelativeDirOps,
  seatHeld: HeldDir,
  id: string,
  context: { root: string; session: string },
  key: KeyObject,
): number | null {
  let data: Buffer;
  try {
    data = readRegularNoFollowInDir(atFfi, seatHeld, `${id}.closed.json`);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8')) as unknown;
  } catch {
    return null;
  }
  const auth = closeAuthOf(parsed, key);
  if (auth.kind !== 'ok') return null;
  const payload = auth.value.payload;
  if (payload.id !== id || payload.session !== context.session) return null;
  if (!sameFolder(payload.root, context.root)) return null;
  const ms = Date.parse(payload.at);
  return Number.isFinite(ms) ? ms : null;
}

type CandidateFamily = {
  session: string;
  seat: string;
  id: string;
  seatHeld: HeldDir;
  files: string[];
  newestMs: number;
};

/** Removes archived message ids from `.unread.json` in `seatHeld` while keeping all unread ids intact. */
function pruneArchivedFromUnreadHint(
  atFfi: RelativeDirOps,
  baseHeld: HeldDir,
  seatHeld: HeldDir,
  archivedIds: ReadonlySet<string>,
): string | null {
  if (archivedIds.size === 0) return null;
  const chainProblem = verifyHeldDirChain(atFfi, baseHeld, seatHeld);
  if (chainProblem !== null) return chainProblem;
  const hintPath = join(seatHeld.path, '.unread.json');
  const held = heldAt(hintPath);
  if (held.kind === 'missing') return null;
  if (held.kind === 'link') return `${hintPath}: a symbolic link was found and not followed`;
  if (held.kind !== 'file') return `${hintPath}: unexpected ${held.kind} at .unread.json`;
  if (process.getuid !== undefined && held.uid !== process.getuid()) {
    return `${hintPath}: another user's file`;
  }
  let parsed: unknown;
  try {
    const data = readRegularNoFollowInDir(atFfi, seatHeld, '.unread.json');
    parsed = JSON.parse(data.toString('utf8')) as unknown;
  } catch {
    // An unreadable hint is left untouched as it stands.
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.unread)) return null;
  const unread = parsed.unread as Record<string, unknown>;
  const nextUnread: Record<string, { entries: { id: string; at: string }[] }> = {};
  let changed = false;
  for (const [peer, rawEntry] of Object.entries(unread)) {
    if (!isRecord(rawEntry) || !Array.isArray(rawEntry.entries)) continue;
    const kept: { id: string; at: string }[] = [];
    for (const item of rawEntry.entries) {
      if (!isRecord(item) || typeof item.id !== 'string' || typeof item.at !== 'string') continue;
      if (archivedIds.has(item.id)) {
        changed = true;
        continue;
      }
      kept.push({ id: item.id, at: item.at });
    }
    if (kept.length > 0) nextUnread[peer] = { entries: kept };
  }
  if (!changed) return null;
  const tmpName = `.unread.json.${String(process.pid)}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify({ v: 1, unread: nextUnread }, null, 2)}\n`, 'utf8');
  const wrote = writeNewFileInHeldDir(atFfi, baseHeld, seatHeld, tmpName, bytes);
  if (!wrote.ok) return null;
  const moved = atFfi.renameatReplace(seatHeld.fd, tmpName, seatHeld.fd, '.unread.json');
  if (!moved.ok) {
    // Clean up the temporary file and leave the existing hint intact if the atomic swap failed.
    unlinkInHeldDir(atFfi, seatHeld, tmpName);
  }
  return null;
}

function writeArchiveManifestInHeldDir(
  atFfi: RelativeDirOps,
  baseHeld: HeldDir,
  archiveDateHeld: HeldDir,
  root: string,
  date: string,
  at: Date,
  atIso: string,
  families: DropArchiveFamily[],
  key: KeyObject,
): { ok: true; manifestPath: string } | { ok: false; reason: string } {
  if (!insideSendDrops(baseHeld.path, archiveDateHeld.path)) {
    return { ok: false, reason: 'manifest path escapes send-drops archive' };
  }
  const payload: DropArchivePayload = {
    kind: 'drop-archive',
    format: 1,
    root,
    date,
    at: atIso,
    families,
  };
  const signed: SignedDropArchive = {
    payload,
    signature: signDomain(DROP_ARCHIVE_DOMAIN, payload as unknown as Json, key),
  };
  const bytes = Buffer.from(`${JSON.stringify(signed, null, 2)}\n`, 'utf8');
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  for (let n = 1; n <= 10_000; n += 1) {
    const fileName = n === 1 ? `manifest-${stamp}.json` : `manifest-${stamp}-${String(n)}.json`;
    const candidatePath = join(archiveDateHeld.path, fileName);
    if (!insideSendDrops(baseHeld.path, candidatePath) || dirname(candidatePath) !== archiveDateHeld.path) {
      return { ok: false, reason: 'manifest path escapes send-drops archive' };
    }
    const wrote = writeNewFileInHeldDir(atFfi, baseHeld, archiveDateHeld, fileName, bytes);
    if (wrote.ok) return { ok: true, manifestPath: wrote.path };
    if (wrote.code === 'eexist') continue;
    return { ok: false, reason: `${candidatePath}: the archive manifest could not be written: ${wrote.reason}` };
  }
  return {
    ok: false,
    reason: `${archiveDateHeld.path}: the archive manifest could not be written: no free manifest name`,
  };
}

/** Directory entries read or non-candidate files skipped before yielding to the slice clock. */
const DIR_SCAN_CHUNK = 64;

function* sortedDirEntriesSteps(dirPath: string): Generator<void, string[]> {
  const names: string[] = [];
  const opened = opendirSync(dirPath);
  try {
    let scanned = 0;
    for (;;) {
      const entry = opened.readSync();
      if (entry === null) break;
      names.push(entry.name);
      scanned += 1;
      if (scanned % DIR_SCAN_CHUNK === 0) yield;
    }
  } finally {
    try {
      opened.closeSync();
    } catch {}
  }
  if (names.length >= DIR_SCAN_CHUNK) yield;
  names.sort();
  return names;
}

/**
 * Generator driving one root's drop-archive pass a step at a time. Yields between directory and
 * candidate inspections so the chores child's slice clock can yield to the event loop and answer
 * heartbeats without stalling.
 */
export function* dropRetirementSteps(
  input: DropRetirementInput,
  stateSink?: { report: DropRetirementReport },
): Generator<void, DropRetirementReport> {
  const { root, home, at } = input;
  const atIso = at.toISOString();
  const date = atIso.slice(0, 10);

  const openedFds: number[] = [];
  const archived: DropArchiveFamily[] = [];
  const reclaimed: DropArchiveFamily[] = [];
  const movedRecords: { srcHeld: HeldDir; destHeld: HeldDir; files: string[] }[] = [];
  const archivedBySeatDir = new Map<string, { seatHeld: HeldDir; ids: Set<string> }>();
  let manifestPath: string | null = null;
  let scanned = 0;
  let stayed = 0;
  let refused: string | null = null;
  let sendDropsHeld: HeldDir | null = null;
  let archiveDateHeld: HeldDir | null = null;
  let key: KeyObject | null = null;
  let finalized = false;

  const atFfi = input.atFfi !== undefined ? input.atFfi : getRelativeDirOps();

  const snapshot = (): DropRetirementReport => {
    const report: DropRetirementReport = {
      at: atIso,
      archived: [...archived],
      reclaimed: [...reclaimed],
      manifestPath,
      scanned,
      stayed,
      refused,
    };
    if (stateSink !== undefined) stateSink.report = report;
    return report;
  };

  const fail = (reason: string): DropRetirementReport => {
    refused = reason;
    return snapshot();
  };

  const rollbackAllMoved = (): void => {
    if (atFfi === null) return;
    for (let i = movedRecords.length - 1; i >= 0; i -= 1) {
      const rec = movedRecords[i]!;
      for (let j = rec.files.length - 1; j >= 0; j -= 1) {
        undoMovedFile(atFfi, rec.destHeld, rec.srcHeld, rec.files[j]!);
      }
    }
    movedRecords.length = 0;
    archived.length = 0;
    archivedBySeatDir.clear();
  };

  const finalizeMoved = (): void => {
    if (finalized) {
      snapshot();
      return;
    }
    finalized = true;
    if (
      atFfi === null ||
      archived.length === 0 ||
      sendDropsHeld === null ||
      archiveDateHeld === null ||
      key === null
    ) {
      snapshot();
      return;
    }

    // Before writing `.unread.json` updates or the signed manifest, verify that `.archive/<date>`
    // and every moved family's destination folder still resolve inside `send-drops` without any
    // symbolic link. If any archive parent was swapped for a link, roll back all moved files so no
    // family escapes or sits without a manifest.
    const dateChainProblem = verifyHeldDirChain(atFfi, sendDropsHeld, archiveDateHeld);
    if (dateChainProblem !== null) {
      rollbackAllMoved();
      if (refused === null) refused = dateChainProblem;
      snapshot();
      return;
    }
    for (const rec of movedRecords) {
      const destProblem = verifyHeldDirChain(atFfi, sendDropsHeld, rec.destHeld);
      if (destProblem !== null) {
        rollbackAllMoved();
        if (refused === null) refused = destProblem;
        snapshot();
        return;
      }
    }

    for (const { seatHeld, ids } of archivedBySeatDir.values()) {
      const problem = pruneArchivedFromUnreadHint(atFfi, sendDropsHeld, seatHeld, ids);
      if (problem !== null && refused === null) refused = problem;
    }

    const wrote = writeArchiveManifestInHeldDir(
      atFfi,
      sendDropsHeld,
      archiveDateHeld,
      root,
      date,
      at,
      atIso,
      archived,
      key,
    );
    if (!wrote.ok) {
      rollbackAllMoved();
      if (refused === null) refused = wrote.reason;
      snapshot();
      return;
    }
    manifestPath = wrote.manifestPath;
    snapshot();
  };

  snapshot();
  try {
    yield;
    const agentsDir = join(root, '.agents');
    if (heldAt(agentsDir).kind === 'missing') return snapshot();
    const agentsProblem = folderProblemAt(agentsDir);
    if (agentsProblem !== null) return fail(`${agentsDir}: ${agentsProblem}`);

    const sendDropsDir = join(agentsDir, 'send-drops');
    if (heldAt(sendDropsDir).kind === 'missing') return snapshot();
    const sendDropsProblem = folderProblemAt(sendDropsDir);
    if (sendDropsProblem !== null) return fail(`${sendDropsDir}: ${sendDropsProblem}`);

    if (atFfi === null) {
      return fail('relative directory-descriptor moves (openat/renameat) are unavailable on this runtime');
    }

    const agentsStep = openRootDirNoFollow(agentsDir);
    if (!agentsStep.ok) return fail(agentsStep.reason);
    openedFds.push(agentsStep.fd);
    const sendDropsStep = openChildDirNoFollow(atFfi, agentsStep.fd, sendDropsDir, 'send-drops');
    if (!sendDropsStep.ok) return fail(sendDropsStep.reason);
    openedFds.push(sendDropsStep.fd);
    sendDropsHeld = {
      fd: sendDropsStep.fd,
      path: sendDropsDir,
      dev: sendDropsStep.dev,
      ino: sendDropsStep.ino,
      chain: [],
    };

    // Pre-check `.archive` if it already stands in `send-drops`: a link or non-folder refuses the pass.
    const archiveRoot = join(sendDropsDir, DROP_ARCHIVE_DIR);
    if (heldAt(archiveRoot).kind !== 'missing') {
      const archiveProblem = folderProblemAt(archiveRoot);
      if (archiveProblem !== null) return fail(`${archiveRoot}: ${archiveProblem}`);
    }

    const retention = resolveRetentionMs(root, home, input.team, at, input.olderThanMs);
    if (retention.ms === null) return fail(retention.refusal);
    if (retention.keepAll) return snapshot();
    const cutoff = at.getTime() - retention.ms;
    const archiveWindowMs =
      input.archiveOlderThanMs !== undefined
        ? input.archiveOlderThanMs
        : Math.max(retention.ms * DROP_ARCHIVE_LONG_WINDOW_MULTIPLIER, DROP_ARCHIVE_MIN_LONG_WINDOW_MS);
    if (!Number.isFinite(archiveWindowMs) || archiveWindowMs < 0) {
      return fail('the drop archive retention window is not a valid duration');
    }
    const archiveCutoff = at.getTime() - archiveWindowMs;

    const keyState = messageKeyState(home);
    if (keyState.kind === 'missing') return snapshot();
    if (keyState.kind === 'unreadable') return fail(`the message key is unreadable: ${keyState.why}`);
    key = keyState.key;

    // Phase 1: Full pre-flight tree inspection + candidate discovery.
    // Any link, non-regular entry in a seat folder, foreign-owned entry, or unexpected file name
    // refuses the whole pass before a single file is moved.
    let sessionEntries: string[];
    try {
      sessionEntries = yield* sortedDirEntriesSteps(sendDropsDir);
    } catch (error) {
      return fail(`${sendDropsDir}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const candidates: CandidateFamily[] = [];

    for (const session of sessionEntries) {
      yield;
      if (session === DROP_ARCHIVE_DIR) continue;
      const sessionDir = join(sendDropsDir, session);
      if (!insideSendDrops(sendDropsDir, sessionDir) || !RECORD_NAME.test(session)) {
        return fail(`${sessionDir}: unexpected entry in send-drops`);
      }
      const sessionHeld = heldAt(sessionDir);
      if (sessionHeld.kind === 'link') {
        return fail(`${sessionDir}: a symbolic link was found and not followed`);
      }
      if (sessionHeld.kind !== 'folder') {
        return fail(`${sessionDir}: unexpected ${sessionHeld.kind} in send-drops`);
      }
      const sessionProblem = folderProblemAt(sessionDir);
      if (sessionProblem !== null) return fail(`${sessionDir}: ${sessionProblem}`);

      let seatEntries: string[];
      try {
        seatEntries = yield* sortedDirEntriesSteps(sessionDir);
      } catch (error) {
        return fail(`${sessionDir}: ${error instanceof Error ? error.message : String(error)}`);
      }

      for (const seat of seatEntries) {
        yield;
        const seatDir = join(sessionDir, seat);
        if (!insideSendDrops(sendDropsDir, seatDir) || !RECORD_NAME.test(seat)) {
          return fail(`${seatDir}: unexpected entry in session drop folder`);
        }
        const seatHeldCheck = heldAt(seatDir);
        if (seatHeldCheck.kind === 'link') {
          return fail(`${seatDir}: a symbolic link was found and not followed`);
        }
        if (seatHeldCheck.kind !== 'folder') {
          return fail(`${seatDir}: unexpected ${seatHeldCheck.kind} in session drop folder`);
        }
        const seatProblem = folderProblemAt(seatDir);
        if (seatProblem !== null) return fail(`${seatDir}: ${seatProblem}`);

        const openedSeat = openSubdirChain(atFfi, sendDropsHeld, [session, seat], false, openedFds);
        if (!openedSeat.ok) return fail(openedSeat.reason);
        const seatHeld = openedSeat.dir;

        let fileNames: string[];
        try {
          fileNames = yield* sortedDirEntriesSteps(seatDir);
        } catch (error) {
          return fail(`${seatDir}: ${error instanceof Error ? error.message : String(error)}`);
        }

        const fileSet = new Set<string>();
        const fallbackNoteIds = new Set<string>();
        for (const name of fileNames) {
          yield;
          const filePath = join(seatDir, name);
          if (!insideSendDrops(sendDropsDir, filePath)) {
            return fail(`${filePath}: path escapes send-drops`);
          }
          const held = heldAt(filePath);
          if (held.kind === 'link') {
            return fail(`${filePath}: a symbolic link was found and not followed`);
          }
          if (held.kind !== 'file') {
            return fail(`${filePath}: unexpected ${held.kind} in seat drop folder`);
          }
          if (process.getuid !== undefined && held.uid !== process.getuid()) {
            return fail(`${filePath}: another user's file`);
          }
          if (!isExpectedSeatDropFile(name)) {
            return fail(`${filePath}: unexpected file in seat drop folder`);
          }
          fileSet.add(name);
          const dot = name.indexOf('.');
          if (dot > 0 && FALLBACK_NOTE_SUFFIX.test(name.slice(dot))) {
            fallbackNoteIds.add(name.slice(0, dot));
          }
        }

        const activeClaim = currentClaimIn(root, session, seat);

        let candidateCheckCount = 0;
        for (const name of fileNames) {
          candidateCheckCount += 1;
          if (candidateCheckCount % DIR_SCAN_CHUNK === 0) yield;
          if (name.includes('.') || name.startsWith(WORK_PREFIX) || !RECORD_NAME.test(name)) continue;
          yield;
          scanned += 1;
          let recordData: Buffer;
          try {
            recordData = readRegularNoFollowInDir(atFfi, seatHeld, name);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(recordData.toString('utf8')) as unknown;
          } catch {
            stayed += 1;
            continue;
          }
          const auth = recordAuthOf(parsed, key);
          if (auth.kind !== 'ok') {
            stayed += 1;
            continue;
          }
          const payload = auth.value.payload;
          if (
            payload.id !== name ||
            payload.to !== seat ||
            payload.session !== session ||
            !sameFolder(payload.root, root)
          ) {
            stayed += 1;
            continue;
          }
          if (
            isGeneralBriefRecord(payload) ||
            (payload.from === GENERAL_BRIEF_FROM && payload.rule === GENERAL_BRIEF_RULE) ||
            activeClaim?.id === name
          ) {
            stayed += 1;
            continue;
          }
          if (isClientRecord(payload)) {
            stayed += 1;
            continue;
          }
          if (
            fileSet.has(`${name}.pending`) ||
            fileSet.has(`${name}.taken`) ||
            fileSet.has(`${name}.fallback.json`) ||
            fallbackNoteIds.has(name)
          ) {
            stayed += 1;
            continue;
          }
          // A live, initializing, or malformed commit lock owns the name. Moving the family
          // would not move that lock, and a new taker could publish another lock while the
          // holder still has the inode. An abandoned dead pid is not active and does not stay.
          if (fileSet.has(`${name}.channel-commit.lock`) && channelCommitActive(seatDir, name)) {
            stayed += 1;
            continue;
          }

          // Age uses the signed `at` timestamps only (the verified message record and its verified
          // receipts/close), never `mtime`, so a same-user `utimes` cannot retire a fresh read.
          let newestMs = Date.parse(payload.at);
          if (!Number.isFinite(newestMs)) {
            stayed += 1;
            continue;
          }
          const context = { to: seat, root, session };
          const readMs = fileSet.has(`${name}.read.json`)
            ? verifiedReceiptAtMs(atFfi, seatHeld, name, 'read', context, key)
            : null;
          const repliedMs = fileSet.has(`${name}.replied.json`)
            ? verifiedReceiptAtMs(atFfi, seatHeld, name, 'replied', context, key)
            : null;
          if (readMs === null && repliedMs === null) {
            stayed += 1;
            continue;
          }
          if (readMs !== null && readMs > newestMs) newestMs = readMs;
          if (repliedMs !== null && repliedMs > newestMs) newestMs = repliedMs;
          for (const extraStatus of ['held', 'delivered'] as const) {
            if (!fileSet.has(`${name}.${extraStatus}.json`)) continue;
            const extraMs = verifiedReceiptAtMs(atFfi, seatHeld, name, extraStatus, context, key);
            if (extraMs !== null && extraMs > newestMs) newestMs = extraMs;
          }
          if (fileSet.has(`${name}.closed.json`)) {
            const closeMs = verifiedCloseAtMs(atFfi, seatHeld, name, context, key);
            if (closeMs !== null && closeMs > newestMs) newestMs = closeMs;
          }
          if (newestMs > cutoff) {
            stayed += 1;
            continue;
          }

          const familyFiles: string[] = [
            name,
            ...PRE_RECEIPT_SUFFIXES.map((suffix) => `${name}${suffix}`).filter((f) => fileSet.has(f)),
            ...RECEIPT_SUFFIXES.map((suffix) => `${name}${suffix}`).filter((f) => fileSet.has(f)),
          ];
          candidates.push({ session, seat, id: name, seatHeld, files: familyFiles, newestMs });
        }
      }
    }

    const steadyLimit = input.limit ?? DROP_ARCHIVE_PASS_LIMIT;
    const backlogAbove = input.backlogAbove ?? DAEMON_BACKLOG_DEFAULTS.above;
    const backlogLimit = input.backlogLimit ?? DAEMON_BACKLOG_DEFAULTS.limit;

    if (candidates.length > 0) {
      candidates.sort((a, b) =>
        a.newestMs - b.newestMs ||
        a.session.localeCompare(b.session) ||
        a.seat.localeCompare(b.seat) ||
        a.id.localeCompare(b.id),
      );

      const passLimit = candidates.length > backlogAbove ? Math.max(steadyLimit, backlogLimit) : steadyLimit;
      const selected = candidates.slice(0, passLimit);

      // Phase 2: Open and hold destination archive directories (`O_RDONLY | O_DIRECTORY | O_NOFOLLOW`)
      // and hash every source file before moving anything.
      const openedDateDir = openSubdirChain(atFfi, sendDropsHeld, [DROP_ARCHIVE_DIR, date], true, openedFds);
      if (!openedDateDir.ok) return fail(openedDateDir.reason);
      archiveDateHeld = openedDateDir.dir;

      const destHeldBySeat = new Map<string, HeldDir>();
      for (const item of selected) {
        const seatKey = `${item.session}/${item.seat}`;
        if (destHeldBySeat.has(seatKey)) continue;
        const absDest = join(sendDropsDir, DROP_ARCHIVE_DIR, date, item.session, item.seat);
        if (!insideSendDrops(sendDropsDir, absDest)) {
          return fail(`${absDest}: destination escapes send-drops`);
        }
        const openedDest = openSubdirChain(
          atFfi,
          sendDropsHeld,
          [DROP_ARCHIVE_DIR, date, item.session, item.seat],
          true,
          openedFds,
        );
        if (!openedDest.ok) return fail(openedDest.reason);
        destHeldBySeat.set(seatKey, openedDest.dir);
      }

      type PreparedFamily = {
        candidate: CandidateFamily;
        destHeld: HeldDir;
        hashed: { name: string; digest: string; bytes: number }[];
      };
      const prepared: PreparedFamily[] = [];

      for (const item of selected) {
        yield;
        const destHeld = destHeldBySeat.get(`${item.session}/${item.seat}`)!;
        for (const file of item.files) {
          const destPath = join(destHeld.path, file);
          const existing = heldAt(destPath);
          if (existing.kind === 'link') {
            return fail(`${destPath}: a symbolic link was found and not followed`);
          }
          if (existing.kind !== 'missing') {
            return fail(`${destPath}: destination already holds ${file}`);
          }
        }
        const hashed: { name: string; digest: string; bytes: number }[] = [];
        for (const file of item.files) {
          try {
            const data = readRegularNoFollowInDir(atFfi, item.seatHeld, file);
            hashed.push({
              name: file,
              digest: createHash('sha256').update(data).digest('hex'),
              bytes: data.byteLength,
            });
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        }
        prepared.push({ candidate: item, destHeld, hashed });
      }

      // Phase 3: Move each family relative to the held `seatHeld.fd` and `destHeld.fd` descriptors
      // (record and non-receipt sidecars first, receipts last). If the pass stops at a slice boundary
      // or fails on a later family, `finalizeMoved()` in `finally` updates `.unread.json` and writes
      // the signed manifest for every family that completed its move.
      for (const item of prepared) {
        yield;
        const { candidate, destHeld, hashed } = item;
        const movedFiles: MovedFile[] = [];
        const movedNames: string[] = [];
        let familyFailed: string | null = null;
        for (const file of hashed) {
          const source = join(candidate.seatHeld.path, file.name);
          const dest = join(destHeld.path, file.name);
          if (!insideSendDrops(sendDropsDir, source) || !insideSendDrops(sendDropsDir, dest)) {
            familyFailed = 'archive move path escapes send-drops';
            break;
          }
          const moveRes = moveFileBetweenHeldDirs(
            atFfi,
            sendDropsHeld,
            candidate.seatHeld,
            destHeld,
            file.name,
            root,
          );
          if (!moveRes.ok) {
            familyFailed = moveRes.reason;
            break;
          }
          movedNames.push(file.name);
          movedFiles.push({
            digest: file.digest,
            bytes: file.bytes,
            source: relative(root, source).split(sep).join('/'),
            dest: relative(root, dest).split(sep).join('/'),
          });
        }
        if (familyFailed !== null) {
          for (let i = movedNames.length - 1; i >= 0; i -= 1) {
            undoMovedFile(atFfi, destHeld, candidate.seatHeld, movedNames[i]!);
          }
          refused = familyFailed;
          break;
        }
        movedRecords.push({ srcHeld: candidate.seatHeld, destHeld, files: movedNames });
        archived.push({
          session: candidate.session,
          seat: candidate.seat,
          id: candidate.id,
          files: movedFiles,
        });
        let seatEntry = archivedBySeatDir.get(candidate.seatHeld.path);
        if (seatEntry === undefined) {
          seatEntry = { seatHeld: candidate.seatHeld, ids: new Set<string>() };
          archivedBySeatDir.set(candidate.seatHeld.path, seatEntry);
        }
        seatEntry.ids.add(candidate.id);
        snapshot();
      }

      finalizeMoved();
      if (refused !== null) return snapshot();
    }

    // Phase 4 (Slice 3): Reclaim archived drop families inside `.archive/<YYYY-MM-DD>/<session>/<seat>/`
    // once they pass the long archive window, verifying the signed manifest and every file's SHA-256
    // digest and byte length before unlinking via held directory descriptors while keeping the signed
    // manifest intact.
    const archiveRootHeld = heldAt(archiveRoot);
    if (archiveRootHeld.kind === 'missing') return snapshot();
    if (archiveRootHeld.kind === 'link') {
      return fail(`${archiveRoot}: a symbolic link was found and not followed`);
    }
    const archiveRootProblem = folderProblem(archiveRootHeld);
    if (archiveRootProblem !== null) return fail(`${archiveRoot}: ${archiveRootProblem}`);
    if (archiveRootHeld.kind !== 'folder') {
      return fail(`${archiveRoot}: unexpected ${archiveRootHeld.kind}`);
    }

    const openedArchiveBase = openSubdirChain(atFfi, sendDropsHeld, [DROP_ARCHIVE_DIR], false, openedFds);
    if (!openedArchiveBase.ok) return fail(openedArchiveBase.reason);
    const archiveBaseHeld = openedArchiveBase.dir;

    let dateEntries: string[];
    try {
      dateEntries = yield* sortedDirEntriesSteps(archiveBaseHeld.path);
    } catch (error) {
      return fail(`${archiveBaseHeld.path}: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const dateEntry of dateEntries) {
      yield;
      const dateDirPath = join(archiveBaseHeld.path, dateEntry);
      if (!insideSendDrops(sendDropsDir, dateDirPath) || !/^\d{4}-\d{2}-\d{2}$/.test(dateEntry)) {
        return fail(`${dateDirPath}: unexpected entry in send-drops archive`);
      }
      const dateDirHeldCheck = heldAt(dateDirPath);
      if (dateDirHeldCheck.kind === 'link') {
        return fail(`${dateDirPath}: a symbolic link was found and not followed`);
      }
      if (dateDirHeldCheck.kind !== 'folder') {
        return fail(`${dateDirPath}: unexpected ${dateDirHeldCheck.kind} in send-drops archive`);
      }
      const dateDirProblem = folderProblemAt(dateDirPath);
      if (dateDirProblem !== null) return fail(`${dateDirPath}: ${dateDirProblem}`);

      const openedDate = openSubdirChain(
        atFfi,
        sendDropsHeld,
        [DROP_ARCHIVE_DIR, dateEntry],
        false,
        openedFds,
      );
      if (!openedDate.ok) return fail(openedDate.reason);
      const dateHeld = openedDate.dir;

      let dateChildren: string[];
      try {
        dateChildren = yield* sortedDirEntriesSteps(dateHeld.path);
      } catch (error) {
        return fail(`${dateHeld.path}: ${error instanceof Error ? error.message : String(error)}`);
      }

      const manifestNames: string[] = [];
      const archiveSessionNames: string[] = [];
      let dateChildCount = 0;
      for (const child of dateChildren) {
        dateChildCount += 1;
        if (dateChildCount % DIR_SCAN_CHUNK === 0) yield;
        const childPath = join(dateHeld.path, child);
        if (!insideSendDrops(sendDropsDir, childPath)) {
          return fail(`${childPath}: path escapes send-drops`);
        }
        if (/^manifest-[A-Za-z0-9_-]+\.json$/.test(child)) {
          manifestNames.push(child);
        } else if (RECORD_NAME.test(child)) {
          archiveSessionNames.push(child);
        } else {
          return fail(`${childPath}: unexpected entry in archive date folder`);
        }
      }

      const verifiedManifests: { name: string; payload: DropArchivePayload; atMs: number }[] = [];
      const manifestedFileSet = new Set<string>();

      for (const manifestName of manifestNames) {
        yield;
        const manifestFullPath = join(dateHeld.path, manifestName);
        const mHeld = heldAt(manifestFullPath);
        if (mHeld.kind === 'link') {
          return fail(`${manifestFullPath}: a symbolic link was found and not followed`);
        }
        if (mHeld.kind !== 'file') {
          return fail(`${manifestFullPath}: unexpected ${mHeld.kind} in archive date folder`);
        }
        if (process.getuid !== undefined && mHeld.uid !== process.getuid()) {
          return fail(`${manifestFullPath}: another user's file`);
        }
        let manifestBytes: Buffer;
        try {
          manifestBytes = readRegularNoFollowInDir(atFfi, dateHeld, manifestName);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
        let parsedManifest: unknown;
        try {
          parsedManifest = JSON.parse(manifestBytes.toString('utf8')) as unknown;
        } catch {
          return fail(`${manifestFullPath}: archive manifest is not valid JSON`);
        }
        const verified = verifyDropArchive(parsedManifest, key);
        if (
          verified === null ||
          !sameFolder(verified.root, root) ||
          verified.date !== dateEntry
        ) {
          return fail(`${manifestFullPath}: archive manifest did not verify`);
        }
        for (const family of verified.families) {
          const expectedPrefix = `.agents/send-drops/${DROP_ARCHIVE_DIR}/${dateEntry}/${family.session}/${family.seat}/`;
          for (const mf of family.files) {
            if (!mf.dest.startsWith(expectedPrefix)) {
              return fail(`${manifestFullPath}: archive manifest destination path is invalid`);
            }
            const fileName = mf.dest.slice(expectedPrefix.length);
            if (!validSegment(fileName) || !isExpectedSeatDropFile(fileName)) {
              return fail(`${manifestFullPath}: archive manifest file name is invalid`);
            }
            manifestedFileSet.add(`${family.session}/${family.seat}/${fileName}`);
          }
        }
        verifiedManifests.push({
          name: manifestName,
          payload: verified,
          atMs: Date.parse(verified.at),
        });
      }

      const archiveSessionHelds = new Map<string, HeldDir>();
      const archiveSeatHelds = new Map<string, HeldDir>();
      const presentFilesBySeat = new Map<string, Set<string>>();

      for (const session of archiveSessionNames) {
        yield;
        const sessionPath = join(dateHeld.path, session);
        const sHeldCheck = heldAt(sessionPath);
        if (sHeldCheck.kind === 'link') {
          return fail(`${sessionPath}: a symbolic link was found and not followed`);
        }
        if (sHeldCheck.kind !== 'folder') {
          return fail(`${sessionPath}: unexpected ${sHeldCheck.kind} in archive date folder`);
        }
        const sProblem = folderProblemAt(sessionPath);
        if (sProblem !== null) return fail(`${sessionPath}: ${sProblem}`);

        const openedSession = openSubdirChain(
          atFfi,
          sendDropsHeld,
          [DROP_ARCHIVE_DIR, dateEntry, session],
          false,
          openedFds,
        );
        if (!openedSession.ok) return fail(openedSession.reason);
        const sessionHeld = openedSession.dir;
        archiveSessionHelds.set(session, sessionHeld);

        let seatNames: string[];
        try {
          seatNames = yield* sortedDirEntriesSteps(sessionHeld.path);
        } catch (error) {
          return fail(`${sessionHeld.path}: ${error instanceof Error ? error.message : String(error)}`);
        }

        for (const seat of seatNames) {
          yield;
          const seatPath = join(sessionHeld.path, seat);
          if (!insideSendDrops(sendDropsDir, seatPath) || !RECORD_NAME.test(seat)) {
            return fail(`${seatPath}: unexpected entry in archive session folder`);
          }
          const seatCheck = heldAt(seatPath);
          if (seatCheck.kind === 'link') {
            return fail(`${seatPath}: a symbolic link was found and not followed`);
          }
          if (seatCheck.kind !== 'folder') {
            return fail(`${seatPath}: unexpected ${seatCheck.kind} in archive session folder`);
          }
          const seatProb = folderProblemAt(seatPath);
          if (seatProb !== null) return fail(`${seatPath}: ${seatProb}`);

          const openedSeat = openSubdirChain(
            atFfi,
            sendDropsHeld,
            [DROP_ARCHIVE_DIR, dateEntry, session, seat],
            false,
            openedFds,
          );
          if (!openedSeat.ok) return fail(openedSeat.reason);
          const seatHeld = openedSeat.dir;
          const seatKey = `${session}/${seat}`;
          archiveSeatHelds.set(seatKey, seatHeld);

          let archivedFiles: string[];
          try {
            archivedFiles = yield* sortedDirEntriesSteps(seatHeld.path);
          } catch (error) {
            return fail(`${seatHeld.path}: ${error instanceof Error ? error.message : String(error)}`);
          }

          const presentSet = new Set<string>();
          for (const fileName of archivedFiles) {
            yield;
            const filePath = join(seatHeld.path, fileName);
            if (!insideSendDrops(sendDropsDir, filePath)) {
              return fail(`${filePath}: path escapes send-drops`);
            }
            const fHeld = heldAt(filePath);
            if (fHeld.kind === 'link') {
              return fail(`${filePath}: a symbolic link was found and not followed`);
            }
            if (fHeld.kind !== 'file') {
              return fail(`${filePath}: unexpected ${fHeld.kind} in archive seat folder`);
            }
            if (process.getuid !== undefined && fHeld.uid !== process.getuid()) {
              return fail(`${filePath}: another user's file`);
            }
            if (!isExpectedSeatDropFile(fileName)) {
              return fail(`${filePath}: unexpected file in archive seat folder`);
            }
            if (!manifestedFileSet.has(`${session}/${seat}/${fileName}`)) {
              return fail(`${filePath}: archived file is not listed in a verified archive manifest`);
            }
            presentSet.add(fileName);
          }
          presentFilesBySeat.set(seatKey, presentSet);
        }
      }

      for (const manifest of verifiedManifests) {
        if (manifest.atMs > archiveCutoff) continue;
        for (const family of manifest.payload.families) {
          yield;
          const seatKey = `${family.session}/${family.seat}`;
          const presentSet = presentFilesBySeat.get(seatKey);
          if (presentSet === undefined || presentSet.size === 0) continue;

          const expectedPrefix = `.agents/send-drops/${DROP_ARCHIVE_DIR}/${dateEntry}/${family.session}/${family.seat}/`;
          const familyEntries = family.files.map((mf) => ({
            name: mf.dest.slice(expectedPrefix.length),
            mf,
          }));
          const presentCount = familyEntries.filter((e) => presentSet.has(e.name)).length;
          if (presentCount === 0) continue;

          const seatHeld = archiveSeatHelds.get(seatKey);
          if (presentCount !== familyEntries.length || seatHeld === undefined) {
            return fail(
              `${join(dateHeld.path, family.session, family.seat, family.id)}: archived family is incomplete against its signed manifest`,
            );
          }

          const verifiedBytes = new Map<string, Buffer>();
          for (const entry of familyEntries) {
            const validFamilySidecar =
              entry.name === family.id ||
              (entry.name.startsWith(`${family.id}.`) &&
                (PRE_RECEIPT_SUFFIXES.includes(entry.name.slice(family.id.length)) ||
                  RECEIPT_SUFFIXES.includes(entry.name.slice(family.id.length))));
            if (!validFamilySidecar) {
              return fail(
                `${join(seatHeld.path, entry.name)}: unexpected file name in archived family ${family.id}`,
              );
            }
            let data: Buffer;
            try {
              data = readRegularNoFollowInDir(atFfi, seatHeld, entry.name);
            } catch (error) {
              return fail(error instanceof Error ? error.message : String(error));
            }
            const digest = createHash('sha256').update(data).digest('hex');
            if (data.byteLength !== entry.mf.bytes || digest !== entry.mf.digest) {
              return fail(
                `${join(seatHeld.path, entry.name)}: archived file digest or size does not match the signed manifest`,
              );
            }
            verifiedBytes.set(entry.name, data);
          }

          // Every signed file in the family (record, read/replied/held/delivered receipts, and
          // thread-close) must verify, at least one of read or replied must be present, and every
          // verified timestamp in the family must precede `archiveCutoff` or the family is kept whole.
          const recBytes = verifiedBytes.get(family.id);
          if (recBytes === undefined) {
            return fail(
              `${join(seatHeld.path, family.id)}: archived family is missing its message record in the signed manifest`,
            );
          }
          let parsedRecord: unknown;
          try {
            parsedRecord = JSON.parse(recBytes.toString('utf8')) as unknown;
          } catch {
            return fail(`${join(seatHeld.path, family.id)}: archived record is not valid JSON`);
          }
          const recAuth = recordAuthOf(parsedRecord, key);
          if (
            recAuth.kind !== 'ok' ||
            recAuth.value.payload.id !== family.id ||
            recAuth.value.payload.to !== family.seat ||
            recAuth.value.payload.session !== family.session ||
            !sameFolder(recAuth.value.payload.root, root)
          ) {
            return fail(`${join(seatHeld.path, family.id)}: archived record did not verify`);
          }
          const recAtMs = Date.parse(recAuth.value.payload.at);
          if (!Number.isFinite(recAtMs)) {
            return fail(`${join(seatHeld.path, family.id)}: archived record timestamp is not valid`);
          }
          let newestFamilyMs = recAtMs;

          const context = { to: family.seat, root, session: family.session };
          let hasTerminalReceipt = false;
          for (const status of ['read', 'replied', 'held', 'delivered'] as const) {
            const receiptFileName = `${family.id}.${status}.json`;
            if (!verifiedBytes.has(receiptFileName)) continue;
            const receiptMs = verifiedReceiptAtMs(atFfi, seatHeld, family.id, status, context, key);
            if (receiptMs === null) {
              return fail(
                `${join(seatHeld.path, receiptFileName)}: archived receipt did not verify`,
              );
            }
            if (status === 'read' || status === 'replied') {
              hasTerminalReceipt = true;
            }
            if (receiptMs > newestFamilyMs) newestFamilyMs = receiptMs;
          }
          if (!hasTerminalReceipt) {
            return fail(
              `${join(seatHeld.path, family.id)}: archived family has no verified read or replied receipt`,
            );
          }
          const closeFileName = `${family.id}.closed.json`;
          if (verifiedBytes.has(closeFileName)) {
            const closeMs = verifiedCloseAtMs(atFfi, seatHeld, family.id, context, key);
            if (closeMs === null) {
              return fail(
                `${join(seatHeld.path, closeFileName)}: archived close record did not verify`,
              );
            }
            if (closeMs > newestFamilyMs) newestFamilyMs = closeMs;
          }

          if (newestFamilyMs > archiveCutoff) {
            continue;
          }

          // Unlink in crash-safe order: record and non-receipt sidecars first, terminal receipts last.
          // Each file name is recorded before its unlink so a swap detected after `unlinkat` removes
          // the entry still restores that file from `verifiedBytes`; any restore error stops the pass
          // and is reported in `refused`.
          const orderedNames = [
            ...familyEntries
              .map((e) => e.name)
              .filter((n) => !RECEIPT_SUFFIXES.some((s) => n === `${family.id}${s}`)),
            ...familyEntries
              .map((e) => e.name)
              .filter((n) => RECEIPT_SUFFIXES.some((s) => n === `${family.id}${s}`)),
          ];

          const unlinkedNames: string[] = [];
          let unlinkFailed: string | null = null;
          for (const fileName of orderedNames) {
            unlinkedNames.push(fileName);
            const unlinkRes = unlinkFileInHeldDir(atFfi, sendDropsHeld, seatHeld, fileName, root);
            if (!unlinkRes.ok) {
              unlinkFailed = unlinkRes.reason;
              break;
            }
          }
          if (unlinkFailed !== null) {
            const restoreErrors: string[] = [];
            for (let i = unlinkedNames.length - 1; i >= 0; i -= 1) {
              const name = unlinkedNames[i]!;
              const data = verifiedBytes.get(name);
              if (data === undefined) {
                restoreErrors.push(`cannot restore ${name}: missing verified bytes`);
                continue;
              }
              const restored = restoreUnlinkedInHeldDir(atFfi, seatHeld, name, data);
              if (!restored.ok) {
                restoreErrors.push(restored.reason);
              }
            }
            const reason =
              restoreErrors.length > 0
                ? `${unlinkFailed} (restore failed: ${restoreErrors.join('; ')})`
                : unlinkFailed;
            return fail(reason);
          }

          for (const fileName of orderedNames) {
            presentSet.delete(fileName);
          }
          reclaimed.push(family);
          snapshot();
        }
      }

      if (atFfi.rmdirat !== undefined) {
        for (const [seatKey, presentSet] of presentFilesBySeat.entries()) {
          if (presentSet.size > 0) continue;
          const [session, seat] = seatKey.split('/') as [string, string];
          const sessionHeld = archiveSessionHelds.get(session);
          const seatHeld = archiveSeatHelds.get(seatKey);
          if (
            sessionHeld !== undefined &&
            seatHeld !== undefined &&
            verifyHeldDirChain(atFfi, sendDropsHeld, sessionHeld) === null &&
            heldAt(seatHeld.path).kind === 'folder'
          ) {
            atFfi.rmdirat(sessionHeld.fd, seat);
          }
        }
        for (const [session, sessionHeld] of archiveSessionHelds.entries()) {
          if (
            verifyHeldDirChain(atFfi, sendDropsHeld, dateHeld) === null &&
            heldAt(sessionHeld.path).kind === 'folder'
          ) {
            try {
              if (readdirSync(sessionHeld.path).length === 0) {
                atFfi.rmdirat(dateHeld.fd, session);
              }
            } catch {}
          }
        }
      }
    }

    return snapshot();
  } finally {
    finalizeMoved();
    for (let i = openedFds.length - 1; i >= 0; i -= 1) {
      try {
        closeSync(openedFds[i]!);
      } catch {}
    }
  }
}

/**
 * Runs the drop-archive pass a slice at a time under `input.slices`, yielding to the chores
 * child's event loop whenever `sliceMs` elapses. Stops cleanly at the next slice boundary when
 * `slices.stopping()` is true, writing the manifest and reporting any families already moved.
 */
export async function retireDropsSliced(
  input: DropRetirementInput & { slices: SweepSlices; sliceClock?: () => number },
): Promise<DropRetirementReport> {
  const clock = input.sliceClock ?? Date.now;
  const stateSink: { report: DropRetirementReport } = {
    report: {
      at: input.at.toISOString(),
      archived: [],
      reclaimed: [],
      manifestPath: null,
      scanned: 0,
      stayed: 0,
      refused: null,
    },
  };
  const steps = dropRetirementSteps(input, stateSink);
  let sliceStart = clock();
  let step = steps.next();
  while (!step.done) {
    if (clock() - sliceStart >= input.slices.sliceMs) {
      const more = await input.slices.yield();
      if (!more || input.slices.stopping()) {
        steps.return(stateSink.report);
        return stateSink.report;
      }
      sliceStart = clock();
    }
    step = steps.next();
  }
  return step.value;
}
