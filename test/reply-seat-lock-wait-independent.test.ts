// Independent coverage of the general seat-lock API waiting a bounded budget.
// The clock and the sleep are injected, so a scene counts polls and never waits on wall time.
// A holder that releases inside the budget lets the next taker acquire it. A spent budget leaves the
// holder untouched and names its pid. An unreadable lock is refused at once. Every other
// production taker passes no budget; reply queues its record when the lock stays held.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { acquireSeatLock, seatLockPath, type LockSteps } from '../src/launch/seat-lock.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { NOW, world, type World } from './send-native-fixtures.ts';

const SENT = '019a4f61-5000-7000-8000-000000000001';
const REPLY = '019a4f61-5000-7000-8000-000000000002';

let made: World | null = null;

afterEach(() => {
  if (made !== null) discardFixtures([dirname(made.root)], { roots: [tmpdir()] });
  made = null;
});

function scene(): World {
  made = world(null, [{ name: 'iris', role: 'reviewer', cli: 'gemini', launch: 'gemini' }]);
  plantRecord(made.home, made.root, 'acme', 'owner', SENT, 'question from the seat', {
    from: 'iris',
    at: NOW.toISOString(),
  });
  return made;
}

function clockOf(release?: () => void): { steps: Partial<LockSteps>; sleeps: number[] } {
  let clock = 1_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    steps: {
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        release?.();
      },
    },
  };
}

/** Every acquireSeatLock call under src, skipping the function's own definition. */
function lockCalls(): { file: string; call: string }[] {
  const root = join(import.meta.dir, '..', 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else if (name.name.endsWith('.ts')) files.push(path);
    }
  };
  walk(root);
  const found: { file: string; call: string }[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    let from = 0;
    while (from < source.length) {
      const at = source.indexOf('acquireSeatLock(', from);
      if (at < 0) break;
      const before = source.slice(Math.max(0, at - 24), at);
      if (before.includes('function ')) {
        from = at + 'acquireSeatLock('.length;
        continue;
      }
      let depth = 0;
      let end = at;
      for (; end < source.length; end++) {
        const ch = source[end];
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            end += 1;
            break;
          }
        }
      }
      found.push({ file, call: source.slice(at, end) });
      from = end;
    }
  }
  return found;
}

test('a lock taker acquires once the holder releases inside the budget', () => {
  const at = scene();
  const held = acquireSeatLock(at.dir, 'acme', 'iris');
  expect('release' in held).toBe(true);
  if (!('release' in held)) throw new Error('the holder did not take the lock');
  const clock = clockOf(() => held.release());
  const result = acquireSeatLock(at.dir, 'acme', 'iris', clock.steps, { waitMs: 2_000, pollMs: 25 });
  expect('release' in result).toBe(true);
  expect(clock.sleeps).toEqual([25]);
  if ('release' in result) result.release();
});

test('a spent lock budget leaves the holder untouched and names its pid', () => {
  const at = scene();
  const held = acquireSeatLock(at.dir, 'acme', 'iris');
  expect('release' in held).toBe(true);
  if (!('release' in held)) throw new Error('the holder did not take the lock');
  const path = seatLockPath(at.dir, 'acme', 'iris');
  const before = readFileSync(path, 'utf8');
  try {
    const clock = clockOf();
    const result = acquireSeatLock(at.dir, 'acme', 'iris', clock.steps, { waitMs: 2_000, pollMs: 25 });
    expect(result).toEqual({ held: process.pid, startedAt: Number(before.trim().split(' ')[2]) });
    expect(clock.sleeps).toHaveLength(80);
    expect(clock.sleeps.every((ms) => ms === 25)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(join(recordDir(at.root, 'acme', 'iris'), REPLY))).toBe(false);
  } finally {
    held.release();
  }
});

test('an unreadable lock is refused at once, even with a lock budget', () => {
  const at = scene();
  const path = seatLockPath(at.dir, 'acme', 'iris');
  mkdirSync(path, { recursive: true });
  const clock = clockOf();
  const result = acquireSeatLock(at.dir, 'acme', 'iris', clock.steps, { waitMs: 2_000, pollMs: 25 });
  expect(result).toEqual({ held: -1, startedAt: null });
  expect(clock.sleeps).toEqual([]);
  expect(existsSync(path)).toBe(true);
  expect(existsSync(join(recordDir(at.root, 'acme', 'iris'), REPLY))).toBe(false);
});

test('every production lock taker stays at zero wait', () => {
  const calls = lockCalls();
  const waiting = calls.filter((one) => one.call.includes('waitMs'));
  expect(waiting).toHaveLength(0);
  for (const one of calls) {
    if (one.call.includes('waitMs')) continue;
    expect(one.call).not.toContain('pollMs');
  }

  const at = scene();
  const path = seatLockPath(at.dir, 'acme', 'iris');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${process.pid} deadbeef\n`);
  const clock = clockOf();
  const refused = acquireSeatLock(at.dir, 'acme', 'iris', clock.steps);
  expect(refused).toEqual({ held: process.pid, startedAt: null });
  expect(clock.sleeps).toEqual([]);
  expect(readFileSync(path, 'utf8')).toBe(`${process.pid} deadbeef\n`);
});
