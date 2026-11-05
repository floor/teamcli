import { randomBytes } from 'node:crypto';
import { accessSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBootTime } from '../watch/machine.ts';
import { processStartOf } from '../watch/pane.ts';

/**
 * One exclusive lock per session and seat, so `answer` and the launch that resumes the
 * same seat cannot both act. The lock is `<state dir>/seat-locks/<session>/<seat>`, and
 * it holds an owner token, `<pid> <nonce> <startedAtMs>`: the taker's pid, a nonce, and
 * the instant its process started, in epoch milliseconds. The start is omitted only when
 * it cannot be read, and a token written before locks recorded it has just the first two.
 *
 * Acquisition is one atomic step whose content is already complete: the token is written
 * into a private temp file, then `link`ed onto the lock path. `link` either creates the
 * name or fails with `EEXIST`, so any process that can see the lock path reads the whole
 * token — there is no instant at which the lock exists and is empty, which is the window
 * the open-then-write lock had (a second taker read the empty file as pid 0, renamed it
 * away and took a fresh one, and the first taker then wrote into its unlinked inode and
 * proceeded). A lock whose token cannot be read or parsed is **held**: it is never renamed
 * or removed, so a corrupt lock refuses callers instead of admitting two.
 *
 * A live pid is not proof of ownership: after a reboot the OS hands the same numbers to
 * unrelated processes. A token that records its writer's start is held only while the
 * process at its pid started when the token says, and is stale when that process started
 * at any other time. A token with no start to compare is stale only when its file
 * predates this boot — written since, it belongs to a command this boot started, whatever
 * the history of its pid — and stays held when this boot's instant cannot be read. A live
 * pid whose start cannot be read is held too: it cannot be shown to be another process.
 *
 * A stale lock is taken over by the taker that wins a second, exclusive `link` on
 * `<path>.steal`. The claim serialises the takeover's read-check-unlink-publish sequence:
 * without it, two takers can both read the stale token, the faster one removes it and
 * publishes, and the slower one then removes the fresh lock (its re-read is not atomic
 * with its unlink) and publishes its own, leaving two holders. Only the claim's holder may
 * remove the lock path, and only when the token still reads exactly the same as when it
 * was judged stale; if another taker published in the meantime, the claim holder leaves
 * that lock alone and is refused. A claim left by a crashed taker is judged by the same
 * rule and dropped by the next taker. Release compares the whole token, so it can only
 * remove a lock this process published.
 *
 * The steps are injectable so a test can stop a taker between any two of them and run
 * another taker in that instant, deterministically.
 */
export function seatLockPath(dir: string, session: string, seat: string): string {
  return join(dir, 'seat-locks', session, seat);
}

export type LockSteps = {
  /** Creates the session's lock folder. */
  prepare(folder: string): void;
  /** Writes `token` in full to a private temp path beside `target` and returns that path. */
  stage(target: string, token: string): string;
  /** Publishes `from` at `to` in one step; throws `EEXIST` when `to` exists. */
  publish(from: string, to: string): void;
  /** The text at `path`, or null when it is absent or cannot be read. */
  read(path: string): string | null;
  /** Whether `path` exists, even when it cannot be read. */
  exists(path: string): boolean;
  /** Best-effort removal. */
  drop(path: string): void;
  /** The instant `path` was last written, in epoch milliseconds; null when it can't be read. */
  writtenAt(path: string): number | null;
  /** Whether a pid names a live process; `EPERM` counts as live. */
  alive(pid: number): boolean;
  /** The instant the process at `pid` started, in epoch milliseconds; null when it can't be read. */
  startOf(pid: number): number | null;
  /** The instant this machine booted, in epoch milliseconds; null when it can't be read. */
  bootTime(): number | null;
  pid(): number;
  nonce(): string;
};

/** This process's own start, read once; undefined until the first lock asks for it. */
let ownStart: number | null | undefined;
/** This boot's instant, read once; undefined until the first start-less token asks for it. */
let boot: number | null | undefined;

export const lockSteps: LockSteps = {
  prepare: (folder) => {
    mkdirSync(folder, { recursive: true });
  },
  stage: (target, token) => {
    const path = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(path, `${token}\n`, { flag: 'wx' });
    return path;
  },
  publish: (from, to) => {
    linkSync(from, to);
  },
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  exists: (path) => {
    try {
      accessSync(path);
      return true;
    } catch {
      return false;
    }
  },
  drop: (path) => {
    try {
      unlinkSync(path);
    } catch {
      // Already gone, or never there.
    }
  },
  writtenAt: (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  startOf: (pid) => {
    if (pid !== process.pid) return processStartOf(pid);
    // A process's own start instant never changes, so it is read once per process: the lock is
    // taken and released many times in one run, and the reading is a command away.
    if (ownStart === undefined) ownStart = processStartOf(pid);
    return ownStart;
  },
  bootTime: () => {
    // This machine cannot boot again under this process, so one reading serves every lock.
    if (boot === undefined) boot = readBootTime();
    return boot;
  },
  pid: () => process.pid,
  nonce: () => randomBytes(6).toString('hex'),
};

/** How far a live process's start may sit from the instant a token records. The start line is
 *  read at one-second resolution, so two readings of one process can be a rounding apart. */
const START_TOLERANCE_MS = 2_000;

type Owner = { pid: number; token: string; startedAt: number | null };

/** The owner a lock's text names, or null for anything that is not one complete token. A token
 *  from before starts were recorded has no third field, and its start reads as null. */
function parseToken(text: string | null): Owner | null {
  if (text === null) return null;
  const token = text.trim();
  const match = /^([1-9]\d*) ([0-9a-f]+)(?: (\d+))?$/.exec(token);
  if (!match) return null;
  return { pid: Number(match[1]), token, startedAt: match[3] === undefined ? null : Number(match[3]) };
}

/**
 * Whether a token still names the process that wrote it. `stillHeld` decides a lock's take-over
 * and a claim's, by the rule in the module comment: a dead pid is stale; a recorded start must
 * match the live process's; a start-less token holds unless its file predates this boot; and any
 * fact that cannot be read leaves the lock held, never taken for a stale one.
 */
function stillHeld(owner: Owner, path: string, steps: LockSteps): boolean {
  if (!steps.alive(owner.pid)) return false;
  if (owner.startedAt !== null) {
    const live = steps.startOf(owner.pid);
    return live === null || Math.abs(live - owner.startedAt) <= START_TOLERANCE_MS;
  }
  const boot = steps.bootTime();
  if (boot === null) return true;
  const written = steps.writtenAt(path);
  return written === null || written >= boot;
}

/** The lock's live-holder arm: whose it is, and the start the token records. */
export type LockHolder = { held: number; startedAt: number | null };

export type SeatLock = { release(): void } | LockHolder;

/**
 * Takes the lock, or reports the live holder it found: the pid and the start the token records,
 * or pid -1 for a lock that cannot be read or parsed (held, never taken over).
 */
export function acquireSeatLock(dir: string, session: string, seat: string, overrides?: Partial<LockSteps>): SeatLock {
  const steps: LockSteps = { ...lockSteps, ...overrides };
  const path = seatLockPath(dir, session, seat);
  const claimPath = `${path}.steal`;
  steps.prepare(join(dir, 'seat-locks', session));
  const pid = steps.pid();
  const startedAt = steps.startOf(pid);
  const token = startedAt === null ? `${pid} ${steps.nonce()}` : `${pid} ${steps.nonce()} ${String(Math.round(startedAt))}`;
  const mine = steps.stage(path, token);

  const done = (): SeatLock => ({
    release: () => {
      if (parseToken(steps.read(path))?.token === token) steps.drop(path);
      steps.drop(mine);
    },
  });
  const held = (holderPid = -1, holderStart: number | null = null): SeatLock => {
    steps.drop(mine);
    return { held: holderPid, startedAt: holderStart };
  };

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      steps.publish(mine, path);
      steps.drop(mine);
      return done();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const text = steps.read(path);
    if (text === null) {
      // Unreadable is held, never stale; gone means the name is free again.
      if (steps.exists(path)) return held();
      continue;
    }
    const owner = parseToken(text);
    if (!owner) return held();
    if (stillHeld(owner, path, steps)) return held(owner.pid, owner.startedAt);
    if (!claim(claimPath, token, steps)) return held();
    try {
      const now = steps.read(path);
      if (now === null ? steps.exists(path) : now.trim() !== owner.token) {
        // The lock changed under the claim: someone else owns it now. Leave it.
        return held();
      }
      steps.drop(path);
      try {
        steps.publish(mine, path);
        steps.drop(mine);
        return done();
      } catch {
        // Another taker published in the free window; it owns the lock.
        return held();
      }
    } finally {
      steps.drop(claimPath);
    }
  }
  return held();
}

/**
 * Whether a lock is held right now, read without taking it: its holder, or null when no live
 * holder keeps it. A caller that must not wait on a lock — the send fast path, deciding whether
 * to walk the socket or the typed path — asks this rather than asking whether the lock's file
 * exists: a file a dead or replaced process left behind holds nothing.
 */
export function seatLockHolder(dir: string, session: string, seat: string, overrides?: Partial<LockSteps>): LockHolder | null {
  const steps: LockSteps = { ...lockSteps, ...overrides };
  const path = seatLockPath(dir, session, seat);
  const text = steps.read(path);
  if (text === null) return steps.exists(path) ? { held: -1, startedAt: null } : null;
  const owner = parseToken(text);
  if (!owner) return { held: -1, startedAt: null };
  return stillHeld(owner, path, steps) ? { held: owner.pid, startedAt: owner.startedAt } : null;
}

/**
 * How a refusal names a lock's holder: the pid and, when the token records one, its start time —
 * the two facts that tell a live holder from a pid the OS has handed to another process. An
 * unreadable lock names neither.
 */
export function holderText(lock: LockHolder): string {
  if (lock.held === -1) return 'an unreadable lock';
  return lock.startedAt === null
    ? `pid ${String(lock.held)}`
    : `pid ${String(lock.held)}, started ${new Date(lock.startedAt).toISOString()}`;
}

/** Wins the right to take over one stale lock, or loses to a taker that already has it. */
function claim(claimPath: string, token: string, steps: LockSteps): boolean {
  const text = steps.read(claimPath);
  if (text !== null) {
    const owner = parseToken(text);
    if (owner && stillHeld(owner, claimPath, steps)) return false;
    steps.drop(claimPath);
  } else if (steps.exists(claimPath)) {
    steps.drop(claimPath);
  }
  const mine = steps.stage(claimPath, token);
  try {
    steps.publish(mine, claimPath);
    return true;
  } catch {
    return false;
  } finally {
    steps.drop(mine);
  }
}
