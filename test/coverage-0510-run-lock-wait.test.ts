// The session mutator lock stands aside for another run and then takes it: `waitMs: 0` refuses
// without a single sleep, a holder that releases during the wait is replaced by this run, and a
// holder that keeps the lock is refused once the wait is spent.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRunLock, acquireRunLockWithin } from '../src/launch/run-lock.ts';

let dir: string;
const session = 'acme';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-run-lock-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the run lock a second mutating run meets', () => {
  test('waitMs zero refuses at the first reading, without sleeping', async () => {
    const held = acquireRunLock(dir, session);
    if ('held' in held) throw new Error(`the fixture could not take the lock: ${String(held.held)}`);
    try {
      const attempt = await acquireRunLockWithin(dir, session, {
        waitMs: 0,
        sleep: async () => {
          throw new Error('a zero wait must not sleep');
        },
      });
      expect('held' in attempt).toBe(true);
      if ('held' in attempt) expect(attempt.held).toBe(process.pid);
    } finally {
      held.release();
    }
  });

  test('a holder that releases during the wait is replaced by this run', async () => {
    const held = acquireRunLock(dir, session);
    if ('held' in held) throw new Error(`the fixture could not take the lock: ${String(held.held)}`);
    let sleeps = 0;
    const waiting = await acquireRunLockWithin(dir, session, {
      waitMs: 1000,
      pollMs: 10,
      sleep: async () => {
        sleeps += 1;
        held.release();
      },
    });
    expect(sleeps).toBe(1);
    expect('held' in waiting).toBe(false);
    if ('held' in waiting) throw new Error(`the wait did not take the freed lock: ${String(waiting.held)}`);
    // The returned lock is really held: a contender is refused while it stands.
    const blocked = acquireRunLock(dir, session);
    expect('held' in blocked).toBe(true);
    if ('held' in blocked) expect(blocked.held).toBe(process.pid);
    waiting.release();
    // Released for real: the next acquisition is not refused.
    const again = acquireRunLock(dir, session);
    expect('held' in again).toBe(false);
    if (!('held' in again)) again.release();
  });

  test('a holder that keeps the lock is refused once the wait is spent', async () => {
    const held = acquireRunLock(dir, session);
    if ('held' in held) throw new Error(`the fixture could not take the lock: ${String(held.held)}`);
    const budget: number[] = [];
    try {
      const attempt = await acquireRunLockWithin(dir, session, {
        waitMs: 25,
        pollMs: 10,
        sleep: async (ms) => {
          budget.push(ms);
        },
      });
      // The whole wait is spent in poll steps, the last one only what remains: never past waitMs.
      expect(budget).toEqual([10, 10, 5]);
      expect('held' in attempt).toBe(true);
      if ('held' in attempt) expect(attempt.held).toBe(process.pid);
    } finally {
      held.release();
    }
    const after = acquireRunLock(dir, session);
    expect('held' in after).toBe(false);
    if (!('held' in after)) after.release();
  });
});
