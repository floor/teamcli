// The first daemon after a machine restart starts again the sessions that ran when the machine
// went down, and only those: the record must predate this boot, and a later daemon in the same
// boot finds a newer record and starts nothing.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootSessionsToStart,
  bootTimeMs,
  readSessionsRunning,
  sessionsRunningPath,
  writeSessionsRunning,
} from '../src/daemon/restore/boot-sessions.ts';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'boot-sessions-')));
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

test('the record round-trips, sorted and without repeats', () => {
  expect(writeSessionsRunning(home, ['material', 'floor', 'floor'], 1_000)).toBe(true);
  expect(readSessionsRunning(home)).toEqual({ at: 1_000, running: ['floor', 'material'] });
});

test('a missing or malformed record names nothing', () => {
  expect(readSessionsRunning(home)).toBeNull();
  writeFileSync(sessionsRunningPath(home), '{"at":"x","running":["a"]}');
  expect(readSessionsRunning(home)).toBeNull();
  writeFileSync(sessionsRunningPath(home), '{"at":5,"running":["a",""]}');
  expect(readSessionsRunning(home)).toBeNull();
  writeFileSync(sessionsRunningPath(home), 'not json');
  expect(readSessionsRunning(home)).toBeNull();
});

test('only a record written before this boot names sessions to start', () => {
  const record = { at: 10_000, running: ['floor', 'material'] };
  expect(bootSessionsToStart(record, 20_000)).toEqual(['floor', 'material']);
  // Written during this boot (a daemon restarted later): nothing.
  expect(bootSessionsToStart(record, 10_000)).toEqual([]);
  expect(bootSessionsToStart(record, 5_000)).toEqual([]);
  // Either reading missing: nothing.
  expect(bootSessionsToStart(null, 20_000)).toEqual([]);
  expect(bootSessionsToStart(record, null)).toEqual([]);
});

test('the boot time is read from kern.boottime, and anything else is null', () => {
  expect(bootTimeMs(() => '{ sec = 1763403968, usec = 123456 } Mon Nov 17 18:26:08 2026\n')).toBe(1_763_403_968_000);
  expect(bootTimeMs(() => 'garbage')).toBeNull();
  expect(bootTimeMs(() => { throw new Error('no sysctl'); })).toBeNull();
  expect(bootTimeMs(() => '{ sec = 0, usec = 0 }')).toBeNull();
});
