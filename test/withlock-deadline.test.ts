// The lock's deadline bounds every way it can wait, not only a live holder. A lock that cannot
// be read, a takeover that keeps failing, or a holderless lock whose mtime is ahead of the clock
// used to spin past `waitMs` forever; each scene below runs the acquisition in a child, so a
// regression is killed by a watchdog and named as a hang instead of stalling the suite.
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCK_FILE, withLock } from '../src/state.ts';
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
