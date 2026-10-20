import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptySession, LOCK_FILE, readState, STATE_FILE, updateState, type State } from '../src/state.ts';
import {
  acquireWatchAuthority,
  releaseWatchAuthority,
  renewWatchAuthority,
} from '../src/watch/epoch-store.ts';
import {
  isWatchEpoch,
  mintWatchEpoch,
  WATCH_AUTHORITY_FUTURE_SKEW_MS,
  WATCH_AUTHORITY_MAX_AGE_MS,
} from '../src/watch/epoch.ts';

const T0 = Date.parse('2026-10-20T03:00:00.000Z');
const at = (ms: number): Date => new Date(ms);
const iso = (ms: number): string => new Date(ms).toISOString();

let dir = '';
let agents = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watch-epoch-store-'));
  agents = join(dir, '.agents');
  mkdirSync(agents, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function current(session = 'crew'): { pid?: number; heartbeat: string; epoch?: string } | undefined {
  return readState(agents).sessions[session]?.watch;
}

function seed(watch: { pid?: number; heartbeat: string; epoch?: string }, session = 'crew'): void {
  updateState(agents, (state: State) => {
    (state.sessions[session] ??= emptySession()).watch = watch;
  });
}

function holdLock(): void {
  writeFileSync(join(agents, LOCK_FILE), '1\n');
}

describe('acquire', () => {
  test('an empty session is claimed, with this runtime pid and a fresh epoch', () => {
    const result = acquireWatchAuthority(agents, 'crew', { now: at(T0) });
    expect(result.kind).toBe('acquired');
    if (result.kind !== 'acquired') return;
    expect(result.replaced).toBe(false);
    expect(result.authority.pid).toBe(process.pid);
    expect(isWatchEpoch(result.authority.epoch)).toBe(true);
    expect(result.authority.heartbeat).toBe(iso(T0));
    expect(current()).toEqual(result.authority);
  });

  test('a live pid from another process holds it, and nothing is written', () => {
    const epoch = mintWatchEpoch();
    seed({ pid: 999_999, heartbeat: iso(T0), epoch });
    const result = acquireWatchAuthority(agents, 'crew', { now: at(T0 + 1_000), alive: () => true });
    expect(result).toEqual({ kind: 'held', holder: { pid: 999_999, epoch, heartbeat: iso(T0) } });
    expect(current()).toEqual({ pid: 999_999, heartbeat: iso(T0), epoch });
  });

  test('a live pane record with no epoch holds it too', () => {
    seed({ pid: 999_999, heartbeat: iso(T0) });
    const result = acquireWatchAuthority(agents, 'crew', { now: at(T0 + 1_000), alive: () => true });
    expect(result.kind).toBe('held');
    expect(current()).toEqual({ pid: 999_999, heartbeat: iso(T0) });
  });

  test('a fresh epoch record with no pid holds it mid-handoff', () => {
    const epoch = mintWatchEpoch();
    seed({ heartbeat: iso(T0), epoch });
    const result = acquireWatchAuthority(agents, 'crew', { now: at(T0 + 1_000) });
    expect(result.kind).toBe('held');
    expect(current()).toEqual({ heartbeat: iso(T0), epoch });
  });

  test('a dead holder is replaced with a new epoch', () => {
    const old = mintWatchEpoch();
    seed({ pid: 999_999, heartbeat: iso(T0), epoch: old });
    const result = acquireWatchAuthority(agents, 'crew', { now: at(T0 + 60_000), alive: () => false });
    expect(result.kind).toBe('acquired');
    if (result.kind !== 'acquired') return;
    expect(result.replaced).toBe(true);
    expect(result.authority.epoch).not.toBe(old);
    expect(result.authority.pid).toBe(process.pid);
    expect(current()).toEqual(result.authority);
  });

  test('a stale pane record with a dead pid is replaced', () => {
    seed({ pid: 999_999, heartbeat: iso(T0) });
    const result = acquireWatchAuthority(agents, 'crew', { now: at(T0 + 60_000), alive: () => false });
    expect(result.kind).toBe('acquired');
    if (result.kind !== 'acquired') return;
    expect(result.replaced).toBe(true);
  });

  test('a record with no pid and no readable authority holds rather than being taken over', () => {
    seed({ heartbeat: iso(T0) });
    const result = acquireWatchAuthority(agents, 'crew', { now: at(T0 + 1_000) });
    expect(result.kind).toBe('held');
    expect(current()).toEqual({ heartbeat: iso(T0) });
  });

  test('a pid-less authority is unknown even when its heartbeat is old', () => {
    const epoch = mintWatchEpoch();
    seed({ epoch, heartbeat: iso(T0) });
    const result = acquireWatchAuthority(agents, 'crew', { now: at(T0 + 60_000) });
    expect(result.kind).toBe('held');
    expect(current()).toEqual({ epoch, heartbeat: iso(T0) });
  });

  test('a record the read door dropped still refuses acquire, and the file is left as it stood', () => {
    writeFileSync(join(agents, STATE_FILE), JSON.stringify({
      format: 1,
      sessions: { crew: { watch: { pid: 4242, heartbeat: 42 } } },
    }));
    const before = readFileSync(join(agents, STATE_FILE), 'utf8');
    const result = acquireWatchAuthority(agents, 'crew', { now: at(T0) });
    expect(result).toEqual({ kind: 'held', holder: { pid: 4242 } });
    expect(readFileSync(join(agents, STATE_FILE), 'utf8')).toBe(before);
    expect(current()).toBeUndefined();
  });

  test('a corrupt state refuses acquire and is left exactly as it stood', () => {
    writeFileSync(join(agents, STATE_FILE), '{not json');
    expect(() => acquireWatchAuthority(agents, 'crew', { now: at(T0) })).toThrow();
    expect(readFileSync(join(agents, STATE_FILE), 'utf8')).toBe('{not json');
    expect(existsSync(join(agents, LOCK_FILE))).toBe(false);
  });

  test('a stale fenced record of this runtime is an old host and is not re-acquired', () => {
    const epoch = mintWatchEpoch();
    seed({ pid: process.pid, epoch, heartbeat: iso(T0) });
    const result = acquireWatchAuthority(agents, 'crew', { now: at(T0 + WATCH_AUTHORITY_MAX_AGE_MS + 1) });
    expect(result.kind).toBe('held');
    expect(current()).toEqual({ pid: process.pid, epoch, heartbeat: iso(T0) });
  });

  test('a malformed epoch never becomes permission for a silent takeover', () => {
    seed({ heartbeat: iso(T0), epoch: 'watch_NOTHEX' });
    const result = acquireWatchAuthority(agents, 'crew', { now: at(T0 + 1_000) });
    expect(result.kind).toBe('held');
    expect(current()).toEqual({ heartbeat: iso(T0) });
  });

  test('a held state lock is busy, and acquire writes nothing', () => {
    holdLock();
    expect(acquireWatchAuthority(agents, 'crew', { now: at(T0) })).toEqual({ kind: 'busy' });
    expect(existsSync(join(agents, STATE_FILE))).toBe(false);
    expect(readFileSync(join(agents, LOCK_FILE), 'utf8')).toBe('1\n');
  });

  test('this runtime may replace its own record, and the old epoch stops working', () => {
    const first = acquireWatchAuthority(agents, 'crew', { now: at(T0) });
    expect(first.kind).toBe('acquired');
    if (first.kind !== 'acquired') return;
    const second = acquireWatchAuthority(agents, 'crew', { now: at(T0 + 1_000) });
    expect(second.kind).toBe('acquired');
    if (second.kind !== 'acquired') return;
    expect(second.replaced).toBe(true);
    expect(second.authority.epoch).not.toBe(first.authority.epoch);
    expect(renewWatchAuthority(agents, 'crew', first.authority.epoch, { now: at(T0 + 2_000) })).toEqual({ kind: 'lost' });
    expect(current()?.epoch).toBe(second.authority.epoch);
  });
});

describe('renew', () => {
  test('the holder renews its heartbeat and keeps the epoch', () => {
    const acquired = acquireWatchAuthority(agents, 'crew', { now: at(T0) });
    if (acquired.kind !== 'acquired') throw new Error('acquire failed');
    const renewed = renewWatchAuthority(agents, 'crew', acquired.authority.epoch, { now: at(T0 + 5_000) });
    expect(renewed).toEqual({
      kind: 'renewed',
      authority: { pid: process.pid, epoch: acquired.authority.epoch, heartbeat: iso(T0 + 5_000) },
    });
    if (renewed.kind !== 'renewed') throw new Error('renew failed');
    expect(current()).toEqual(renewed.authority);
  });

  test('an expired proof is not renewed, and the record stays as it was', () => {
    const acquired = acquireWatchAuthority(agents, 'crew', { now: at(T0) });
    if (acquired.kind !== 'acquired') throw new Error('acquire failed');
    expect(renewWatchAuthority(agents, 'crew', acquired.authority.epoch, { now: at(T0 + WATCH_AUTHORITY_MAX_AGE_MS + 1) })).toEqual({ kind: 'lost' });
    expect(current()).toEqual(acquired.authority);
  });

  test('the freshness edge still renews, inclusive', () => {
    const acquired = acquireWatchAuthority(agents, 'crew', { now: at(T0) });
    if (acquired.kind !== 'acquired') throw new Error('acquire failed');
    expect(renewWatchAuthority(agents, 'crew', acquired.authority.epoch, { now: at(T0 + WATCH_AUTHORITY_MAX_AGE_MS) })).toEqual({
      kind: 'renewed',
      authority: { pid: process.pid, epoch: acquired.authority.epoch, heartbeat: iso(T0 + WATCH_AUTHORITY_MAX_AGE_MS) },
    });
  });

  test('a proof stamped too far in the future is not renewed', () => {
    const acquired = acquireWatchAuthority(agents, 'crew', { now: at(T0) });
    if (acquired.kind !== 'acquired') throw new Error('acquire failed');
    expect(renewWatchAuthority(agents, 'crew', acquired.authority.epoch, { now: at(T0 - WATCH_AUTHORITY_FUTURE_SKEW_MS - 1) })).toEqual({ kind: 'lost' });
    expect(current()).toEqual(acquired.authority);
  });

  test('an unreadable heartbeat is not renewed', () => {
    const epoch = mintWatchEpoch();
    seed({ pid: process.pid, epoch, heartbeat: 'not a time' });
    expect(renewWatchAuthority(agents, 'crew', epoch, { now: at(T0) })).toEqual({ kind: 'lost' });
    expect(current()).toEqual({ pid: process.pid, epoch, heartbeat: 'not a time' });
  });

  test('a successor epoch makes the old holder lost, and its beat writes nothing', () => {
    const acquired = acquireWatchAuthority(agents, 'crew', { now: at(T0) });
    if (acquired.kind !== 'acquired') throw new Error('acquire failed');
    const successor = mintWatchEpoch();
    seed({ pid: process.pid, epoch: successor, heartbeat: iso(T0 + 1_000) });
    expect(renewWatchAuthority(agents, 'crew', acquired.authority.epoch, { now: at(T0 + 5_000) })).toEqual({ kind: 'lost' });
    expect(current()).toEqual({ pid: process.pid, epoch: successor, heartbeat: iso(T0 + 1_000) });
  });

  test('a record another pid wrote is lost even when the epoch matches', () => {
    const epoch = mintWatchEpoch();
    seed({ pid: process.pid + 1, epoch, heartbeat: iso(T0) });
    expect(renewWatchAuthority(agents, 'crew', epoch, { now: at(T0 + 5_000) })).toEqual({ kind: 'lost' });
    expect(current()).toEqual({ pid: process.pid + 1, epoch, heartbeat: iso(T0) });
  });

  test('a value that is not an epoch never renews a record with no epoch', () => {
    seed({ pid: process.pid, heartbeat: iso(T0) });
    expect(renewWatchAuthority(agents, 'crew', 'watch_short', { now: at(T0 + 5_000) })).toEqual({ kind: 'lost' });
    expect(current()).toEqual({ pid: process.pid, heartbeat: iso(T0) });
  });

  test('a held state lock is busy, not lost, and leaves the record as it was', () => {
    const acquired = acquireWatchAuthority(agents, 'crew', { now: at(T0) });
    if (acquired.kind !== 'acquired') throw new Error('acquire failed');
    holdLock();
    expect(renewWatchAuthority(agents, 'crew', acquired.authority.epoch, { now: at(T0 + 5_000) })).toEqual({ kind: 'busy' });
    expect(current()).toEqual(acquired.authority);
  });
});

describe('release', () => {
  test('the holder clears its own record, and a second release is lost', () => {
    const acquired = acquireWatchAuthority(agents, 'crew', { now: at(T0) });
    if (acquired.kind !== 'acquired') throw new Error('acquire failed');
    expect(releaseWatchAuthority(agents, 'crew', acquired.authority.epoch)).toEqual({ kind: 'released' });
    expect(current()).toBeUndefined();
    expect(releaseWatchAuthority(agents, 'crew', acquired.authority.epoch)).toEqual({ kind: 'lost' });
  });

  test('an old epoch cannot clear a successor record', () => {
    const acquired = acquireWatchAuthority(agents, 'crew', { now: at(T0) });
    if (acquired.kind !== 'acquired') throw new Error('acquire failed');
    const successor = mintWatchEpoch();
    seed({ pid: process.pid, epoch: successor, heartbeat: iso(T0 + 1_000) });
    expect(releaseWatchAuthority(agents, 'crew', acquired.authority.epoch)).toEqual({ kind: 'lost' });
    expect(current()).toEqual({ pid: process.pid, epoch: successor, heartbeat: iso(T0 + 1_000) });
  });

  test('a matched epoch on another pid is not cleared by this runtime', () => {
    const epoch = mintWatchEpoch();
    seed({ pid: process.pid + 1, epoch, heartbeat: iso(T0) });
    expect(releaseWatchAuthority(agents, 'crew', epoch)).toEqual({ kind: 'lost' });
    expect(current()).toEqual({ pid: process.pid + 1, epoch, heartbeat: iso(T0) });
  });

  test('a held state lock is busy, and the record is not cleared on that attempt', () => {
    const acquired = acquireWatchAuthority(agents, 'crew', { now: at(T0) });
    if (acquired.kind !== 'acquired') throw new Error('acquire failed');
    holdLock();
    expect(releaseWatchAuthority(agents, 'crew', acquired.authority.epoch)).toEqual({ kind: 'busy' });
    expect(current()).toEqual(acquired.authority);
  });
});
