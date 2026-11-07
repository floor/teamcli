// The channel leg: a message the seat's own inbox server pushes to its CLI. A transport marker
// records the reservation; only a separate signed consumer receipt proves a read.
//
// The channel is a development mode of the seat's launch, not a second transport an operator
// turns on separately: the seat's launch line carries the development-channels flag and names
// this team server, and the server then declares `experimental["claude/channel"]` and pushes one
// `notifications/claude/channel` per message that arrives after it starts. The body and the
// meta travel together; the signed record stays in the inbox for `inbox_read` and for every later
// reader, untouched. The server leaves a `<id>.channel-push.json` reservation beside the record,
// which the sender reads to end its walk as `sent (channel)`. Stdio handoff is not a read: the
// signed receipt waits for explicit client acknowledgement, inbox read or reply.
//
// A pushed message with no signed `read` receipt after the confirmation window is the one case
// the watch redelivers. It redelivers exactly once (`redelivered: channel unconfirmed`), and only
// for an id with no receipt: an acknowledged message is never touched again.
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, fstatSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** The launch flag that loads a development channel, and the value that names this server. */
export const CHANNEL_FLAG = '--dangerously-load-development-channels';
export const CHANNEL_SERVER = 'team-inbox';

/** The capability a channel server declares, and the notification method the client renders. */
export const CHANNEL_CAPABILITY = 'claude/channel';
export const CHANNEL_METHOD = 'notifications/claude/channel';

/** The server's reservation beside a pushed record. It is not a read receipt: only a signed
 *  consumer receipt proves a read. */
export const CHANNEL_PUSH_RECEIPT = 'channel-push';
export const CHANNEL_PUSH_STATUS = 'sent (channel)';

/** The marker a sender leaves at the push marker's name when its own walk already wakes the seat
 *  through another leg. Any marker-aware serving server treats a marker for the id as a push and
 *  skips it — including a long-lived server running an install this sender has already replaced,
 *  whose own push after the fallback would be a second wake; a build older than this rule cannot
 *  honor it. It is not a push, and the sender's own wait never reads it as one. */
export const CHANNEL_HELD_RECEIPT = 'channel-held';

/** How long a send waits for the server's push marker: the server polls its inbox on a short
 *  timer, so this is several polls, never a wait on the seat. */
export const CHANNEL_PUSH_GRACE_MS = 2_000;

/** How often the serving inbox looks for a record it has not pushed yet when no bus is running. */
export const CHANNEL_TICK_MS = 250;

/** How often a serving inbox with a live bus subscription still reads its inbox whole: the bus
 *  carries each arrival at once, and this slow pass catches a sender that could not reach it. */
export const CHANNEL_SAFETY_MS = 5_000;

/** How long a pushed message waits for its signed read receipt before the watch redelivers it
 *  through the next leg. Three minutes is long enough for a handling turn, short enough that a
 *  lost push is not lost for the ten-minute inbox fallback. */
export const CHANNEL_CONFIRM_MS = 3 * 60_000;

/** The reason a push was redelivered, as the marker's own `redelivered` value: the channel had
 *  no signed receipt when its confirmation window ended. */
export const CHANNEL_UNCONFIRMED = 'channel unconfirmed';

/** The note a redelivery records, on the marker and on the history line. */
export const CHANNEL_UNCONFIRMED_REASON = `redelivered: ${CHANNEL_UNCONFIRMED}`;

/** The read receipt's `read_by` for an acknowledgement made through the channel tool. */
export const CHANNEL_READ_BY = 'channel';

/** The one sentence the server gives its client when the channel is on. The model acknowledges
 *  the id from the notification's meta in the same turn, before it reads or acts on anything. */
export const CHANNEL_INSTRUCTIONS =
  'When a channel notification arrives, call the ack tool with the id from its meta in the same handling turn, before you read the message or act on it.';

/**
 * Whether a launch line starts its CLI with the development channel naming this team server.
 * The flag is the one measured on the client; its value is `server:<name>`, one or more of them,
 * comma-separated. Any other spelling, or a line without the flag, is no channel at all.
 */
export function channelLaunchEnabled(launch: string | undefined | null, server: string = CHANNEL_SERVER): boolean {
  if (typeof launch !== 'string' || launch.trim() === '') return false;
  const words = launch.trim().split(/\s+/);
  const chosen = `server:${server}`;
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at]!;
    if (word === CHANNEL_FLAG) {
      const value = words[at + 1];
      if (value !== undefined && value.split(',').includes(chosen)) return true;
      continue;
    }
    if (word.startsWith(`${CHANNEL_FLAG}=`)) {
      if (word.slice(CHANNEL_FLAG.length + 1).split(',').includes(chosen)) return true;
    }
  }
  return false;
}

/** The push marker's path: the record's own name, then the marker's suffix. */
export function channelPushPath(dropDir: string, id: string): string {
  return join(dropDir, `${id}.${CHANNEL_PUSH_RECEIPT}.json`);
}

/** Whether a marker for exactly this id is present and readable. The marker is either the
 *  server's push or the sender's held marker; both say this id is not to be pushed. A file that
 *  does not parse, or that names another id, is no marker. */
export function channelPushHeld(dropDir: string, id: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(channelPushPath(dropDir, id), 'utf8')) as { id?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.id === id;
  } catch {
    return false;
  }
}

/** Whether the server itself wrote the push marker for this id. The sender's held marker sits at
 *  the same name but is not a push: the channel leg has not delivered anything when only that one
 *  is there, and its walk goes on. */
export function channelPushed(dropDir: string, id: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(channelPushPath(dropDir, id), 'utf8')) as { id?: unknown; kind?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.id === id && parsed.kind !== CHANNEL_HELD_RECEIPT;
  } catch {
    return false;
  }
}


/** Whether the server recorded a completed notification write for this id. A reservation, a held
 *  marker, or a marker left behind when the seat lost liveness is not a delivery. */
export function channelNotified(dropDir: string, id: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(channelPushPath(dropDir, id), 'utf8')) as { id?: unknown; kind?: unknown; notified?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.id === id && parsed.kind !== CHANNEL_HELD_RECEIPT && parsed.notified === true;
  } catch {
    return false;
  }
}

/** Records that the notification line was written. Never creates the marker and never turns a
 *  held marker into a delivery: only the server's own reservation can become a completed write. */
export function markChannelNotified(dropDir: string, id: string): boolean {
  const path = channelPushPath(dropDir, id);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown; kind?: unknown };
    if (parsed === null || typeof parsed !== 'object' || parsed.id !== id || parsed.kind === CHANNEL_HELD_RECEIPT) return false;
    const next = { ...parsed, notified: true };
    // A reader must see the previous marker or the completed one, never a truncated rewrite.
    writeFileSync(tmp, `${JSON.stringify(next)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // The marker at `path` was not replaced.
    }
    return false;
  }
}

/** Written inside the commit lock before the notification line. It means the line was about to
 *  leave or did leave, including when the completion flag could not be published. It is not
 *  itself a successful delivery, and it is not permission for another leg. */
export function channelEmittedPath(dropDir: string, id: string): string {
  return join(dropDir, `${id}.channel-emitted`);
}

export function channelEmitted(dropDir: string, id: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(channelEmittedPath(dropDir, id), 'utf8')) as { id?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.id === id;
  } catch {
    return false;
  }
}

export function recordChannelEmitted(dropDir: string, id: string, at: string): boolean {
  try {
    writeFileSync(channelEmittedPath(dropDir, id), `${JSON.stringify({ v: 1, id, at })}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** The sender's abort beside a reservation: an in-flight server must not write the notification
 *  after the sender has taken another leg. It is not a push and not a delivery. */
export function channelAbortPath(dropDir: string, id: string): string {
  return join(dropDir, `${id}.channel-abort`);
}

export function channelAborted(dropDir: string, id: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(channelAbortPath(dropDir, id), 'utf8')) as { id?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.id === id;
  } catch {
    return false;
  }
}

export function recordChannelAbort(dropDir: string, id: string, at: string, reason: string): boolean {
  try {
    writeFileSync(channelAbortPath(dropDir, id), `${JSON.stringify({ v: 1, id, at, reason })}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** The sender's marker: its walk takes the message on another leg, so no serving channel may
 *  push it. `reason` says which walk left it; `at` is the sender's clock, not a push time. */
export type ChannelHeldReceipt = {
  v: 1;
  kind: 'channel-held';
  id: string;
  at: string;
  reason: string;
};

/**
 * Writes the sender's held marker whole, mode 0600. `wx` is the reservation: a marker already at
 * the name is the server's push of the same id, and a push that already happened is never
 * replaced. False when the marker could not be written or one was already there — the send goes
 * on either way; the marker only ever prevents a later push.
 */
export function recordChannelHeld(dropDir: string, receipt: ChannelHeldReceipt): boolean {
  try {
    writeFileSync(channelPushPath(dropDir, receipt.id), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}


/** The lock the server holds across its abort check, notification write, and completion flag,
 *  and the sender holds across the same check before it takes another leg. A check and a write
 *  on either side with the lock released between them is a live duplicate, not only a crash.
 *  The lock name is published only after the owner record is durable. An empty or malformed
 *  name is not reclaimed: unknown ownership stays blocked. A time grace is not ownership. */
export function channelCommitLockPath(dropDir: string, id: string): string {
  return join(dropDir, `${id}.channel-commit.lock`);
}

/** Test seams. Production calls pass none. */
export type ChannelCommitHooks = {
  /** After the private owner record is durable, before the lock name is published. */
  beforePublish?: () => void;
  /** After this holder has recorded its inode, before the lock name is removed. */
  beforeRelease?: () => void;
  /** The owner-record write fails after the private file is created. */
  failOwnerWrite?: boolean;
  /** While this holder owns the reclaim. A rival here stays out. When flock is bound, the lock is
   *  still the dead record. When it is not, the lock already names this holder. */
  beforeLockRename?: () => void;
  /** Pid of the external hold used when flock cannot be bound. */
  helperPid?: (pid: number) => void;
  /** How long to wait for the external hold to publish. Production waits two seconds. */
  helperWaitMs?: number;
  /** Force the plain-filesystem recovery used when flock cannot be bound. */
  skipFlock?: boolean;
};

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function pauseMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The private file is already gone.
  }
}

/** Publishes the lock name only after the owner pid is durable in a private file. A contender
 *  never sees an empty lock name. `failOwnerWrite` closes the private descriptor and leaves no
 *  lock name. */
function takeChannelCommit(dropDir: string, id: string, hooks?: ChannelCommitHooks): number | 'busy' {
  const lock = channelCommitLockPath(dropDir, id);
  const prep = join(dropDir, `${id}.channel-commit.prep-${process.pid}-${randomBytes(4).toString('hex')}`);
  let fd: number;
  try {
    fd = openSync(prep, 'wx');
  } catch {
    return 'busy';
  }
  try {
    if (hooks?.failOwnerWrite === true) throw new Error('owner write failed');
    writeFileSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
  } catch {
    closeSync(fd);
    discard(prep);
    return 'busy';
  }
  hooks?.beforePublish?.();
  try {
    linkSync(prep, lock);
  } catch {
    closeSync(fd);
    discard(prep);
    return 'busy';
  }
  try {
    const mine = fstatSync(fd);
    const published = statSync(lock);
    if (mine.dev !== published.dev || mine.ino !== published.ino) {
      closeSync(fd);
      discard(prep);
      return 'busy';
    }
  } catch {
    closeSync(fd);
    discard(prep);
    return 'busy';
  }
  discard(prep);
  return fd;
}

const LOCK_EX = 2;
const LOCK_NB = 4;

type Flock = (fd: number, operation: number) => number;

let flockImpl: Flock | null | undefined;

/** Exclusive non-blocking flock. A live holder's claim stays at its public name, so recovery
 *  never renames it aside and never has a name to restore over a successor. */
function flockExclusive(fd: number): boolean {
  if (flockImpl === undefined) flockImpl = bindFlock();
  if (flockImpl === null) return false;
  return flockImpl(fd, LOCK_EX | LOCK_NB) === 0;
}

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

/** Claims this process already holds. A second attempt in the same process cannot wait on its
 *  own flock, so the set keeps that attempt from publishing another claim or renaming the lock. */
const heldClaims = new Set<string>();

function claimPath(dropDir: string, id: string): string {
  return join(dropDir, `${id}.channel-commit.reclaim`);
}

/** Creates a claim, locks it, and only then publishes the name. The lock is already held when
 *  any other opener can see the file. */
function createHeldClaim(dropDir: string, id: string): number | 'busy' {
  const claim = claimPath(dropDir, id);
  if (heldClaims.has(claim)) return 'busy';
  const prep = join(dropDir, `${id}.channel-commit.prep-${process.pid}-${randomBytes(4).toString('hex')}`);
  let fd: number;
  try {
    fd = openSync(prep, 'wx');
  } catch {
    return 'busy';
  }
  let linked = false;
  try {
    writeFileSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    if (!flockExclusive(fd)) throw new Error('claim lock unavailable');
    linkSync(prep, claim);
    linked = true;
    const mine = fstatSync(fd);
    const published = statSync(claim);
    if (mine.dev !== published.dev || mine.ino !== published.ino) throw new Error('claim inode changed');
  } catch {
    closeSync(fd);
    discard(prep);
    if (linked) discard(claim);
    return 'busy';
  }
  discard(prep);
  heldClaims.add(claim);
  return fd;
}

/** Adopts a claim left by a dead pid, including a hard link of that dead lock. A live pid is
 *  left untouched: its name is not renamed and not replaced. */
function adoptHeldClaim(dropDir: string, id: string): number | 'busy' {
  const claim = claimPath(dropDir, id);
  if (heldClaims.has(claim)) return 'busy';
  let fd: number;
  try {
    fd = openSync(claim, 'r');
  } catch {
    return 'busy';
  }
  if (!flockExclusive(fd)) {
    closeSync(fd);
    return 'busy';
  }
  let holder = NaN;
  let mineDev = 0;
  let mineIno = 0;
  try {
    const info = fstatSync(fd);
    mineDev = info.dev;
    mineIno = info.ino;
    holder = Number(readFileSync(fd, 'utf8').trim());
    const now = statSync(claim);
    if (now.dev !== mineDev || now.ino !== mineIno) throw new Error('claim was replaced');
  } catch {
    closeSync(fd);
    return 'busy';
  }
  if (!Number.isInteger(holder) || holder <= 0 || pidAlive(holder)) {
    closeSync(fd);
    return 'busy';
  }
  heldClaims.add(claim);
  return fd;
}

function flockWorks(hooks?: ChannelCommitHooks): boolean {
  if (hooks?.skipFlock === true) return false;
  if (flockImpl === undefined) flockImpl = bindFlock();
  return flockImpl !== null;
}

const FLOCK_HELPER = `import errno, fcntl, os, select, sys
claim, lock, pid, status, go, prep = sys.argv[1:]
parent = int(pid)

def write_status(text):
    out = os.open(status, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(out, text.encode())
    os.close(out)

def alive(n):
    try:
        os.kill(n, 0)
    except OSError as err:
        return err.errno == errno.EPERM
    return True

def dead_lock():
    try:
        raw = open(lock, 'rb').read().decode().strip()
    except OSError:
        return False
    if not raw.isdigit():
        return False
    holder = int(raw)
    return holder > 0 and not alive(holder)

fd = os.open(claim, os.O_RDONLY)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    write_status('busy')
    raise SystemExit
write_status('held')
while not os.path.exists(go):
    ready, _, _ = select.select([sys.stdin], [], [], 0.05)
    if not ready:
        continue
    if sys.stdin.buffer.read(1) == b'':
        raise SystemExit
if not dead_lock():
    write_status('aborted')
    raise SystemExit
stall = claim + '.stall'
while os.path.exists(stall):
    ready, _, _ = select.select([sys.stdin], [], [], 0.05)
    if ready and sys.stdin.buffer.read(1) == b'':
        raise SystemExit
pfd = os.open(prep, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.write(pfd, (str(parent) + chr(10)).encode())
os.fsync(pfd)
os.close(pfd)
try:
    os.rename(prep, lock)
except OSError:
    try:
        os.unlink(prep)
    except OSError:
        pass
    write_status('aborted')
    raise SystemExit
write_status('published')
sys.stdin.buffer.read()
`;

function readHelperStatus(path: string, accept: readonly string[], waitMs = 2_000): string | null {
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    try {
      const text = readFileSync(path, 'utf8').trim();
      if (accept.includes(text)) return text;
    } catch {
      // The helper has not written the status yet.
    }
    pauseMs(5);
  }
  return null;
}

function helperDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  const probed = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const stat = (probed.stdout ?? '').trim();
  return stat === '' || stat.startsWith('Z');
}

function stopHelper(child: ChildProcess): void {
  const pid = child.pid;
  try {
    child.stdin?.end();
  } catch {
    // The pipe is already closed.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The helper has already exited.
  }
  if (pid === undefined) return;
  const started = Date.now();
  while (Date.now() - started < 1_000) {
    if (helperDead(pid)) return;
    pauseMs(5);
  }
}

function holdClaim(dropDir: string, id: string): number | 'busy' {
  const created = createHeldClaim(dropDir, id);
  if (created !== 'busy') return created;
  return adoptHeldClaim(dropDir, id);
}

function releaseHeldClaim(claim: string, fd: number): void {
  heldClaims.delete(claim);
  try {
    const mine = fstatSync(fd);
    const now = statSync(claim);
    if (mine.dev === now.dev && mine.ino === now.ino) unlinkSync(claim);
  } catch {
    // The name is already gone, or it no longer refers to the inode we held.
  }
  closeSync(fd);
}

/** Reclaims a dead lock when this process cannot bind flock. The helper holds the claim and is
 *  the only one that renames the lock. If the helper dies, this process does not rename. */
function reclaimHeldByHelper(dropDir: string, id: string, hooks?: ChannelCommitHooks): number | 'busy' {
  const claim = claimPath(dropDir, id);
  const lock = channelCommitLockPath(dropDir, id);
  if (heldClaims.has(claim)) return 'busy';
  let created = false;
  try {
    readFileSync(claim);
  } catch {
    const prep = join(dropDir, `${id}.channel-commit.prep-${process.pid}-${randomBytes(4).toString('hex')}`);
    let prepFd: number;
    try {
      prepFd = openSync(prep, 'wx');
    } catch {
      return 'busy';
    }
    let linked = false;
    try {
      writeFileSync(prepFd, `${process.pid}\n`);
      fsyncSync(prepFd);
      linkSync(prep, claim);
      linked = true;
    } catch {
      closeSync(prepFd);
      discard(prep);
      if (linked) discard(claim);
      return 'busy';
    }
    closeSync(prepFd);
    discard(prep);
    created = true;
  }
  const status = join(dropDir, `${id}.channel-commit.prep-${process.pid}-${randomBytes(4).toString('hex')}`);
  const go = join(dropDir, `${id}.channel-commit.prep-${process.pid}-${randomBytes(4).toString('hex')}`);
  const prep = join(dropDir, `${id}.channel-commit.prep-${process.pid}-${randomBytes(4).toString('hex')}`);
  const helper = spawn('/usr/bin/python3', ['-c', FLOCK_HELPER, claim, lock, String(process.pid), status, go, prep], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  helper.on('error', () => {
    // A missing helper fails closed through the status wait.
  });
  let accepted = false;
  let marked: { dev: number; ino: number } | null = null;
  try {
    const answer = readHelperStatus(status, ['held', 'busy']);
    if (answer !== 'held') {
      if (created) discard(claim);
      return 'busy';
    }
    heldClaims.add(claim);
    let holder = NaN;
    try {
      marked = statSync(claim);
      holder = Number(readFileSync(claim, 'utf8').trim());
    } catch {
      if (created) discard(claim);
      return 'busy';
    }
    const ours = created && holder === process.pid;
    if (Number.isInteger(holder) && holder > 0 && pidAlive(holder) && !ours) return 'busy';
    accepted = true;
    if (!lockIsDead(lock)) return 'busy';
    writeFileSync(go, '1\n');
    const published = readHelperStatus(status, ['published', 'aborted'], hooks?.helperWaitMs);
    if (published !== 'published') stopHelper(helper);
    let fd: number;
    try {
      fd = openSync(lock, 'r');
    } catch {
      return 'busy';
    }
    try {
      const now = Number(readFileSync(fd, 'utf8').trim());
      if (now !== process.pid) {
        closeSync(fd);
        return 'busy';
      }
      const mine = fstatSync(fd);
      const at = statSync(lock);
      if (mine.dev !== at.dev || mine.ino !== at.ino) {
        closeSync(fd);
        return 'busy';
      }
    } catch {
      closeSync(fd);
      return 'busy';
    }
    if (typeof helper.pid === 'number') hooks?.helperPid?.(helper.pid);
    hooks?.beforeLockRename?.();
    return fd;
  } finally {
    heldClaims.delete(claim);
    stopHelper(helper);
    discard(status);
    discard(go);
    discard(prep);
    if (accepted && marked !== null) {
      try {
        const now = statSync(claim);
        if (now.dev === marked.dev && now.ino === marked.ino) unlinkSync(claim);
      } catch {
        // The claim name is already gone, or it no longer refers to the inode we held.
      }
    }
  }
}

/** Replaces the dead lock in one rename, so the lock name is never absent. */
function replaceDeadLock(dropDir: string, id: string): number | 'busy' {
  const lock = channelCommitLockPath(dropDir, id);
  const prep = join(dropDir, `${id}.channel-commit.prep-${process.pid}-${randomBytes(4).toString('hex')}`);
  let fd: number;
  try {
    fd = openSync(prep, 'wx');
  } catch {
    return 'busy';
  }
  try {
    writeFileSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
  } catch {
    closeSync(fd);
    discard(prep);
    return 'busy';
  }
  try {
    renameSync(prep, lock);
  } catch {
    closeSync(fd);
    discard(prep);
    return 'busy';
  }
  try {
    const mine = fstatSync(fd);
    const published = statSync(lock);
    if (mine.dev !== published.dev || mine.ino !== published.ino) {
      closeSync(fd);
      return 'busy';
    }
  } catch {
    closeSync(fd);
    return 'busy';
  }
  return fd;
}

function lockIsDead(lock: string): boolean {
  let fd: number;
  try {
    fd = openSync(lock, 'r');
  } catch {
    return false;
  }
  try {
    const holder = Number(readFileSync(fd, 'utf8').trim());
    return Number.isInteger(holder) && holder > 0 && !pidAlive(holder);
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** A dead positive pid can be reclaimed. An empty, partial, or live record cannot. The reclaim
 *  claim stays at its public name for the whole replacement. A live claim is not moved. The dead
 *  lock is replaced by one rename, so a third taker never sees the name absent. */
function reclaimChannelCommit(dropDir: string, id: string, hooks?: ChannelCommitHooks): number | 'busy' {
  const lock = channelCommitLockPath(dropDir, id);
  if (!lockIsDead(lock)) return 'busy';
  if (!flockWorks(hooks)) return reclaimHeldByHelper(dropDir, id, hooks);
  const claimFd = holdClaim(dropDir, id);
  if (claimFd === 'busy') return 'busy';
  const claim = claimPath(dropDir, id);
  try {
    if (!lockIsDead(lock)) return 'busy';
    hooks?.beforeLockRename?.();
    if (!lockIsDead(lock)) return 'busy';
    return replaceDeadLock(dropDir, id);
  } finally {
    releaseHeldClaim(claim, claimFd);
  }
}

function tryChannelCommit(dropDir: string, id: string, hooks?: ChannelCommitHooks): number | 'busy' {
  const created = takeChannelCommit(dropDir, id, hooks);
  if (created !== 'busy') return created;
  return reclaimChannelCommit(dropDir, id, hooks);
}

function releaseChannelCommit(fd: number, path: string, hooks?: ChannelCommitHooks): void {
  let held: { dev: number; ino: number } | null = null;
  try {
    const info = fstatSync(fd);
    held = { dev: info.dev, ino: info.ino };
  } catch {
    held = null;
  }
  hooks?.beforeRelease?.();
  closeSync(fd);
  if (held === null) return;
  try {
    const now = statSync(path);
    if (now.dev === held.dev && now.ino === held.ino) unlinkSync(path);
  } catch {
    // The inode we held is already gone. A replacement at this path belongs to its creator.
  }
}

function lockHolder(dropDir: string, id: string): number | null {
  try {
    const holder = Number(readFileSync(channelCommitLockPath(dropDir, id), 'utf8').trim());
    return Number.isInteger(holder) && holder > 0 ? holder : null;
  } catch {
    return null;
  }
}

/** True when the lock name exists and is not a dead positive pid. An empty or malformed record
 *  stays blocked. A missing name is not busy. */
export function channelCommitActive(dropDir: string, id: string): boolean {
  try {
    const holder = Number(readFileSync(channelCommitLockPath(dropDir, id), 'utf8').trim());
    if (!Number.isInteger(holder) || holder <= 0) return true;
    return pidAlive(holder);
  } catch {
    return false;
  }
}

/** Runs `work` while this process holds the commit lock. `busy` means the name is held, unknown,
 *  or not reclaimable. A dead positive pid may be replaced. A live holder is waited out. */
export function withChannelCommit<T>(dropDir: string, id: string, work: () => T, hooks?: ChannelCommitHooks): T | 'busy' {
  const path = channelCommitLockPath(dropDir, id);
  let fd: number | 'busy' = 'busy';
  // Without flock the reclaim spawns a helper and waits for it. One attempt: repeating that
  // wait across the live-holder retries would block for the helper's whole window each time.
  const attempts = flockWorks(hooks) ? 50 : 1;
  for (let at = 0; at < attempts; at += 1) {
    fd = tryChannelCommit(dropDir, id, at === 0 ? hooks : undefined);
    if (fd !== 'busy') break;
    if (lockHolder(dropDir, id) === process.pid) return 'busy';
    if (!channelCommitActive(dropDir, id)) break;
    if (at + 1 < attempts) pauseMs(20);
  }
  if (fd === 'busy') return 'busy';
  try {
    return work();
  } finally {
    releaseChannelCommit(fd, path, hooks);
  }
}

/**
 * Before another leg: a completed notification stays the delivery. The decision and the guard
 * writes share the commit lock with the server's write. A reserved name is not success. When
 * neither guard can be written, the result is `unguarded` and the caller must not start another
 * leg: reporting a hold that was not written would let both sides deliver.
 */
export function reserveChannelFallback(dropDir: string, receipt: ChannelHeldReceipt): 'notified' | 'held' | 'unguarded' | 'uncertain' {
  const claim = withChannelCommit(dropDir, receipt.id, () => {
    if (channelNotified(dropDir, receipt.id)) return 'notified' as const;
    if (channelEmitted(dropDir, receipt.id)) return 'uncertain' as const;
    const aborted = recordChannelAbort(dropDir, receipt.id, receipt.at, receipt.reason);
    if (channelNotified(dropDir, receipt.id)) return 'notified' as const;
    if (channelEmitted(dropDir, receipt.id)) return 'uncertain' as const;
    const held = recordChannelHeld(dropDir, receipt);
    if (channelNotified(dropDir, receipt.id)) return 'notified' as const;
    if (channelEmitted(dropDir, receipt.id)) return 'uncertain' as const;
    if (aborted || held || channelAborted(dropDir, receipt.id) || channelPushHeld(dropDir, receipt.id)) return 'held' as const;
    return 'unguarded' as const;
  });
  return claim === 'busy' ? 'unguarded' : claim;
}

/** The marker the server reserves before one channel notification. The meta joins the
 *  reservation to its intended message; the marker alone proves neither handoff nor read. */
export type ChannelPushReceipt = {
  v: 1;
  kind: 'channel-push';
  id: string;
  seat: string;
  session: string;
  root: string;
  at: string;
  meta: { id: string; from: string; seat: string; team: string };
  content_sha256: string;
  status: typeof CHANNEL_PUSH_STATUS;
  /** Present only after the notification line was written. A marker without it is a reservation. */
  notified?: true;
};

/**
 * Writes the push marker whole, mode 0600. `wx` is the reservation: a marker already at the name
 * belongs to an earlier reservation of the same id, and the second write is refused rather than
 * replacing it. False when the marker could not be written or was already there: the caller
 * must not write a notification without winning this reservation.
 */
export function recordChannelPush(dropDir: string, receipt: ChannelPushReceipt): boolean {
  try {
    writeFileSync(channelPushPath(dropDir, receipt.id), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
