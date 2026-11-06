// The lock's deadline bounds every way it can wait, not only a live holder. A lock that cannot
// be read, a takeover that keeps failing, or a holderless lock whose mtime is ahead of the clock
// used to spin past `waitMs` forever; each scene below runs the acquisition in a child, so a
// regression is killed by a watchdog and named as a hang instead of stalling the suite.
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCK_FILE, LockBusyError, withLock } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const base = mkdtempSync(join(tmpdir(), 'withlock-deadline-'));
afterAll(() => discardFixtures([base]));

const RUNNER = join(import.meta.dir, 'withlock-deadline-run.ts');
const WATCHDOG_MS = 3_000;

/** A pid no process holds: the shell that printed it has exited. */
function deadPid(): number {
  return Number(execFileSync('sh', ['-c', 'echo $$']).toString().trim());
}

type Attempt = { hung: boolean; code: number | null; out: string; err: string };

async function attempt(dir: string, waitMs: number): Promise<Attempt> {
  const child = Bun.spawn([process.execPath, RUNNER, dir, String(waitMs)], { stdout: 'pipe', stderr: 'pipe' });
  const exited = Promise.race([
    child.exited.then((code) => ({ hung: false, code })),
    new Promise<{ hung: boolean; code: number | null }>((resolve) => {
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ hung: true, code: null });
      }, WATCHDOG_MS);
    }),
  ]);
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { ...(await exited), out, err };
}

/** The child's one word and its own elapsed milliseconds. */
function outcome(result: Attempt): { word: string; ms: number } {
  const [word, ms] = result.out.trim().split(' ');
  return { word: word ?? '', ms: Number(ms) };
}

/** A process that stays alive until `end`, so a lock can name a holder that really runs. */
function sleeper(): { pid: number; end: () => Promise<void> } {
  const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
  return {
    pid: child.pid,
    end: async () => {
      child.kill('SIGKILL');
      await child.exited;
    },
  };
}

/** Runs `work` with `Atomics.wait` counted, so a scene proves whether the call slept rather than
 *  inferring it from elapsed time under whatever load the machine carries. */
function recordWaits<T>(work: () => T): { value: T | undefined; error: unknown; waits: number } {
  const realWait = Atomics.wait;
  let waits = 0;
  (Atomics as unknown as { wait: typeof Atomics.wait }).wait = ((array: Int32Array, index: number, value: number, timeout?: number) => {
    waits += 1;
    return realWait(array, index, value, timeout);
  }) as typeof Atomics.wait;
  try {
    try {
      return { value: work(), error: undefined, waits };
    } catch (error) {
      return { value: undefined, error, waits };
    }
  } finally {
    (Atomics as unknown as { wait: typeof Atomics.wait }).wait = realWait;
  }
}

test('an unremovable lock held by a dead process throws LockBusyError at the deadline', async () => {
  const dir = join(base, 'unremovable');
  mkdirSync(dir, { mode: 0o700 });
  const dead = deadPid();
  writeFileSync(join(dir, LOCK_FILE), `${String(dead)}\n`);
  // No write on the folder: the dead holder's file cannot be renamed aside, so the takeover keeps
  // failing and only the deadline can end the attempt.
  chmodSync(dir, 0o500);
  try {
    const result = await attempt(dir, 50);
    expect(result.hung).toBe(false);
    expect(result.err).toBe('');
    expect(result.code).toBe(1);
    const { word, ms } = outcome(result);
    expect(word).toBe('LockBusyError');
    expect(ms).toBeLessThan(2_000);
    // A refused attempt writes nothing: the dead holder's key is still the lock.
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe(`${String(dead)}\n`);
  } finally {
    chmodSync(dir, 0o700);
  }
}, 6_000);

test('a lock whose key cannot be read throws LockBusyError at the deadline', async () => {
  const dir = join(base, 'unreadable-key');
  mkdirSync(dir, { mode: 0o700 });
  // A folder where the key file belongs: reading it fails with EISDIR, not ENOENT.
  mkdirSync(join(dir, LOCK_FILE));
  const result = await attempt(dir, 50);
  expect(result.hung).toBe(false);
  expect(result.code).toBe(1);
  const { word, ms } = outcome(result);
  expect(word).toBe('LockBusyError');
  expect(ms).toBeLessThan(2_000);
});

test('a holderless key with its mtime ahead of the clock throws at the deadline', async () => {
  const dir = join(base, 'mtime-ahead');
  mkdirSync(dir, { mode: 0o700 });
  const key = join(dir, LOCK_FILE);
  writeFileSync(key, '');
  const ahead = new Date(Date.now() + 60_000);
  utimesSync(key, ahead, ahead);
  const result = await attempt(dir, 50);
  expect(result.hung).toBe(false);
  expect(result.code).toBe(1);
  const { word, ms } = outcome(result);
  expect(word).toBe('LockBusyError');
  expect(ms).toBeLessThan(2_000);
  // The young-looking key is nobody's to remove; the refusal leaves it in place.
  expect(existsSync(key)).toBe(true);
});

test('the first attempt still runs with waitMs 0, before any deadline can refuse it', () => {
  const dir = join(base, 'free');
  mkdirSync(dir, { mode: 0o700 });
  expect(withLock(dir, () => 'ran', { waitMs: 0 })).toBe('ran');
  expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
});

test('a dead holder is still taken over with waitMs 0, on the pass after the takeover', () => {
  const dir = join(base, 'dead');
  mkdirSync(dir, { mode: 0o700 });
  const dead = deadPid();
  writeFileSync(join(dir, LOCK_FILE), `${String(dead)}\n`);
  const stale: number[] = [];
  expect(withLock(dir, () => 'ran', { waitMs: 0, onStale: (pid) => stale.push(pid) })).toBe('ran');
  expect(stale).toEqual([dead]);
  expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
});

// `waitMs: 0` is one attempt, not a short wait: a caller that asked for none must not sleep in
// `Atomics.wait` on the way to its refusal. The count is the mechanism itself, so these scenes do
// not depend on the machine's pace the way an elapsed-milliseconds bound would.
test('waitMs 0 answers a key it cannot read without waiting', () => {
  const dir = join(base, 'unreadable-key-immediate');
  mkdirSync(dir, { mode: 0o700 });
  // A folder where the key file belongs: reading it fails with EISDIR, not ENOENT.
  mkdirSync(join(dir, LOCK_FILE));
  const run = recordWaits(() => withLock(dir, () => 'ran', { waitMs: 0 }));
  expect(run.error).toBeInstanceOf(LockBusyError);
  expect((run.error as Error).message).toContain('not readable yet');
  expect(run.waits).toBe(0);
});

test('waitMs 0 refuses an unremovable dead-holder lock without waiting', () => {
  const dir = join(base, 'unremovable-immediate');
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, LOCK_FILE), `${String(deadPid())}\n`);
  // No write on the folder: the dead holder's key cannot be renamed aside, so the takeover is
  // refused, and the refusal must not pause first.
  chmodSync(dir, 0o500);
  try {
    const run = recordWaits(() => withLock(dir, () => 'ran', { waitMs: 0 }));
    expect(run.error).toBeInstanceOf(LockBusyError);
    expect(run.waits).toBe(0);
  } finally {
    chmodSync(dir, 0o700);
  }
});

test('waitMs 0 refuses a young holderless key without waiting', () => {
  const dir = join(base, 'young-immediate');
  mkdirSync(dir, { mode: 0o700 });
  const key = join(dir, LOCK_FILE);
  writeFileSync(key, '');
  const ahead = new Date(Date.now() + 60_000);
  utimesSync(key, ahead, ahead);
  const run = recordWaits(() => withLock(dir, () => 'ran', { waitMs: 0 }));
  expect(run.error).toBeInstanceOf(LockBusyError);
  expect(run.waits).toBe(0);
});

// A refusal names the holder the key shows now, never one that has departed: the message is read
// by someone deciding what to retry, and a dead pid sends them at a process that no longer exists.
test('a refusal does not name a holder that has since died', async () => {
  const dir = join(base, 'departed-holder');
  mkdirSync(dir, { mode: 0o700 });
  const key = join(dir, LOCK_FILE);
  const holder = sleeper();
  writeFileSync(key, `${String(holder.pid)}\n`);
  const attemptPromise = attempt(dir, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await holder.end();
  // The key now names nobody and reads young forever, so only the deadline ends the wait.
  writeFileSync(key, '');
  const ahead = new Date(Date.now() + 60_000);
  utimesSync(key, ahead, ahead);
  const result = await attemptPromise;
  expect(result.hung).toBe(false);
  expect(outcome(result).word).toBe('LockBusyError');
  expect(result.out).toContain('not readable yet');
  expect(result.out).not.toContain(`pid ${String(holder.pid)})`);
}, 6_000);

test('a refusal names the live holder the key shows when it is made', async () => {
  const dir = join(base, 'replaced-holder');
  mkdirSync(dir, { mode: 0o700 });
  const key = join(dir, LOCK_FILE);
  const first = sleeper();
  writeFileSync(key, `${String(first.pid)}\n`);
  const attemptPromise = attempt(dir, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = sleeper();
  writeFileSync(key, `${String(second.pid)}\n`);
  const result = await attemptPromise;
  await first.end();
  await second.end();
  expect(result.hung).toBe(false);
  expect(outcome(result).word).toBe('LockBusyError');
  expect(result.out).toContain(`pid ${String(second.pid)})`);
  expect(result.out).not.toContain(`pid ${String(first.pid)})`);
}, 6_000);
