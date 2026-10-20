import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWatchHost } from '../src/watch/authority-lifecycle.ts';
import { emptySession, LOCK_FILE, readState, STATE_FILE, updateState, type State } from '../src/state.ts';
import { mintWatchEpoch, WATCH_AUTHORITY_MAX_AGE_MS } from '../src/watch/epoch.ts';

const T0 = Date.parse('2026-10-20T04:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

let dir = '';
let agents = '';
let nowMs = T0;
let otherAlive = true;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watch-lifecycle-'));
  agents = join(dir, '.agents');
  mkdirSync(agents, { recursive: true });
  nowMs = T0;
  otherAlive = true;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function host() {
  return createWatchHost(agents, 'crew', { now: () => new Date(nowMs), alive: () => otherAlive });
}

function current(session = 'crew'): { pid?: number; heartbeat: string; epoch?: string } | undefined {
  return readState(agents).sessions[session]?.watch;
}

function seed(watch: { pid?: number; heartbeat: string; epoch?: string }): void {
  updateState(agents, (state: State) => {
    (state.sessions.crew ??= emptySession()).watch = watch;
  });
}

function holdLock(): void {
  writeFileSync(join(agents, LOCK_FILE), '1\n');
}

function releaseLock(): void {
  rmSync(join(agents, LOCK_FILE));
}

describe('standby', () => {
  test('a host that never started owns nothing and ticks nothing', () => {
    const watch = host();
    expect(watch.report()).toEqual({ phase: 'standby', why: 'not-started' });
    expect(watch.phase()).toBe('standby');
    expect(watch.tick()).toEqual({ phase: 'standby', why: 'not-started' });
    expect(existsSync(join(agents, STATE_FILE))).toBe(false);
  });

  test('a held record is reported and never retried on a tick', () => {
    const epoch = mintWatchEpoch();
    seed({ pid: 999_999, heartbeat: iso(T0), epoch });
    const before = readFileSync(join(agents, STATE_FILE), 'utf8');
    const watch = host();
    expect(watch.start()).toEqual({ phase: 'standby', why: 'held', holder: { pid: 999_999, epoch, heartbeat: iso(T0) } });
    expect(watch.tick()).toEqual({ phase: 'standby', why: 'held', holder: { pid: 999_999, epoch, heartbeat: iso(T0) } });
    expect(readFileSync(join(agents, STATE_FILE), 'utf8')).toBe(before);
  });

  test('an explicit restart may acquire once the standing pid is gone', () => {
    const old = mintWatchEpoch();
    seed({ pid: 999_999, heartbeat: iso(T0), epoch: old });
    const watch = host();
    expect(watch.start().phase).toBe('standby');
    otherAlive = false;
    nowMs = T0 + 1_000;
    const second = watch.start();
    expect(second.phase).toBe('authoritative');
    if (second.phase !== 'authoritative') return;
    expect(second.epoch).not.toBe(old);
    expect(current()).toEqual({ pid: process.pid, epoch: second.epoch, heartbeat: iso(T0 + 1_000) });
  });

  test('a held state lock is busy, and the next tick tries once more', () => {
    holdLock();
    const watch = host();
    expect(watch.start()).toEqual({ phase: 'standby', why: 'busy' });
    releaseLock();
    const started = watch.tick();
    expect(started.phase).toBe('authoritative');
    if (started.phase !== 'authoritative') return;
    expect(current()?.epoch).toBe(started.epoch);
  });

  test('a refused read is reported, never retried and never written over', () => {
    writeFileSync(join(agents, STATE_FILE), '{not json');
    const watch = host();
    const refused = watch.start();
    expect(refused.phase).toBe('standby');
    if (refused.phase !== 'standby' || refused.why !== 'refused') throw new Error('not refused');
    expect(refused.error).toMatch(/not valid JSON/);
    expect(watch.tick()).toEqual(refused);
    expect(readFileSync(join(agents, STATE_FILE), 'utf8')).toBe('{not json');
  });
});

describe('authoritative', () => {
  test('start acquires, and the captured epoch is the record', () => {
    const watch = host();
    const started = watch.start();
    expect(started).toEqual({ phase: 'authoritative', epoch: current()?.epoch ?? '', renewedAt: iso(T0) });
    if (started.phase !== 'authoritative') return;
    expect(current()).toEqual({ pid: process.pid, epoch: started.epoch, heartbeat: iso(T0) });
    expect(watch.start()).toEqual(started);
  });

  test('a tick renews the heartbeat and keeps the epoch', () => {
    const watch = host();
    const started = watch.start();
    if (started.phase !== 'authoritative') throw new Error('start failed');
    nowMs = T0 + 5_000;
    expect(watch.tick()).toEqual({ phase: 'authoritative', epoch: started.epoch, renewedAt: iso(T0 + 5_000) });
    expect(current()).toEqual({ pid: process.pid, epoch: started.epoch, heartbeat: iso(T0 + 5_000) });
  });

  test('a busy renew changes nothing, and a busy tick never extends an expired proof', () => {
    const watch = host();
    const started = watch.start();
    if (started.phase !== 'authoritative') throw new Error('start failed');
    nowMs = T0 + 14_000;
    holdLock();
    expect(watch.tick()).toEqual(started);
    expect(current()).toEqual({ pid: process.pid, epoch: started.epoch, heartbeat: iso(T0) });
    releaseLock();
    // The proof is still the T0 one: the busy tick did not extend it, so this renew is lost.
    nowMs = T0 + WATCH_AUTHORITY_MAX_AGE_MS + 1;
    expect(watch.tick()).toEqual({ phase: 'draining', epoch: started.epoch, why: 'lost' });
    expect(current()).toEqual({ pid: process.pid, epoch: started.epoch, heartbeat: iso(T0) });
  });

  test('a busy tick whose captured proof has lapsed drains on that same tick', () => {
    const watch = host();
    const started = watch.start();
    if (started.phase !== 'authoritative') throw new Error('start failed');
    nowMs = T0 + WATCH_AUTHORITY_MAX_AGE_MS + 1;
    holdLock();
    expect(watch.tick()).toEqual({ phase: 'draining', epoch: started.epoch, why: 'lost' });
    expect(watch.phase()).toBe('draining');
    expect(current()).toEqual({ pid: process.pid, epoch: started.epoch, heartbeat: iso(T0) });
    releaseLock();
  });

  test('a clock failure drains with its reason instead of throwing', () => {
    let calls = 0;
    const watch = createWatchHost(agents, 'crew', {
      now: () => {
        calls += 1;
        if (calls > 1) throw new Error('clock unavailable');
        return new Date(T0);
      },
      alive: () => otherAlive,
    });
    const started = watch.start();
    if (started.phase !== 'authoritative') throw new Error('start failed');
    const drained = watch.tick();
    expect(drained.phase).toBe('draining');
    if (drained.phase !== 'draining') return;
    expect(drained.error).toMatch(/clock unavailable/);
    expect(current()).toEqual({ pid: process.pid, epoch: started.epoch, heartbeat: iso(T0) });
  });

  test('an expired proof with no contention is lost and drains at once', () => {
    const watch = host();
    const started = watch.start();
    if (started.phase !== 'authoritative') throw new Error('start failed');
    nowMs = T0 + WATCH_AUTHORITY_MAX_AGE_MS + 1;
    expect(watch.tick()).toEqual({ phase: 'draining', epoch: started.epoch, why: 'lost' });
    expect(watch.phase()).toBe('draining');
  });

  test('an unreadable record drains rather than continuing on unproven authority', () => {
    const watch = host();
    const started = watch.start();
    if (started.phase !== 'authoritative') throw new Error('start failed');
    writeFileSync(join(agents, STATE_FILE), '{not json');
    const drained = watch.tick();
    expect(drained.phase).toBe('draining');
    if (drained.phase !== 'draining') return;
    expect(drained.why).toBe('lost');
    expect(drained.error).toMatch(/not valid JSON/);
    expect(readFileSync(join(agents, STATE_FILE), 'utf8')).toBe('{not json');
  });

  test('a successor record makes the host drain, and the run never re-acquires', () => {
    const watch = host();
    const started = watch.start();
    if (started.phase !== 'authoritative') throw new Error('start failed');
    const successor = mintWatchEpoch();
    seed({ pid: process.pid, epoch: successor, heartbeat: iso(T0 + 1_000) });
    nowMs = T0 + 5_000;
    expect(watch.tick()).toEqual({ phase: 'draining', epoch: started.epoch, why: 'lost' });
    const after = readFileSync(join(agents, STATE_FILE), 'utf8');
    expect(watch.tick()).toEqual({ phase: 'draining', epoch: started.epoch, why: 'lost' });
    expect(watch.start()).toEqual({ phase: 'draining', epoch: started.epoch, why: 'lost' });
    expect(readFileSync(join(agents, STATE_FILE), 'utf8')).toBe(after);
    expect(current()).toEqual({ pid: process.pid, epoch: successor, heartbeat: iso(T0 + 1_000) });
  });
});

describe('cleanup', () => {
  test('stop releases the captured record, and a second stop reports the same release', () => {
    const watch = host();
    const started = watch.start();
    if (started.phase !== 'authoritative') throw new Error('start failed');
    expect(watch.stop()).toEqual({ phase: 'released', epoch: started.epoch, why: 'released' });
    expect(current()).toBeUndefined();
    expect(watch.stop()).toEqual({ phase: 'released', epoch: started.epoch, why: 'released' });
    expect(watch.tick()).toEqual({ phase: 'released', epoch: started.epoch, why: 'released' });
  });

  test('a busy stop is an honest release-pending, and a tick retries only that release', () => {
    const watch = host();
    const started = watch.start();
    if (started.phase !== 'authoritative') throw new Error('start failed');
    holdLock();
    expect(watch.stop()).toEqual({ phase: 'releasing', epoch: started.epoch, why: 'busy' });
    expect(current()).toEqual({ pid: process.pid, epoch: started.epoch, heartbeat: iso(T0) });
    releaseLock();
    expect(watch.tick()).toEqual({ phase: 'released', epoch: started.epoch, why: 'released' });
    expect(current()).toBeUndefined();
  });

  test('a release that lost the record reports lost and never touches the successor', () => {
    const watch = host();
    const started = watch.start();
    if (started.phase !== 'authoritative') throw new Error('start failed');
    const successor = mintWatchEpoch();
    seed({ pid: process.pid, epoch: successor, heartbeat: iso(T0 + 1_000) });
    expect(watch.stop()).toEqual({ phase: 'released', epoch: started.epoch, why: 'lost' });
    expect(current()).toEqual({ pid: process.pid, epoch: successor, heartbeat: iso(T0 + 1_000) });
  });

  test('stopping a draining host reports lost without a release attempt', () => {
    const watch = host();
    const started = watch.start();
    if (started.phase !== 'authoritative') throw new Error('start failed');
    const successor = mintWatchEpoch();
    seed({ pid: process.pid, epoch: successor, heartbeat: iso(T0 + 1_000) });
    nowMs = T0 + 5_000;
    watch.tick();
    const before = readFileSync(join(agents, STATE_FILE), 'utf8');
    expect(watch.stop()).toEqual({ phase: 'released', epoch: started.epoch, why: 'lost' });
    expect(readFileSync(join(agents, STATE_FILE), 'utf8')).toBe(before);
  });

  test('stopping a standby host changes nothing', () => {
    seed({ heartbeat: iso(T0) });
    const before = readFileSync(join(agents, STATE_FILE), 'utf8');
    const watch = host();
    const held = watch.start();
    expect(watch.stop()).toEqual(held);
    expect(readFileSync(join(agents, STATE_FILE), 'utf8')).toBe(before);
  });

  test('a released host never starts again', () => {
    const watch = host();
    const started = watch.start();
    if (started.phase !== 'authoritative') throw new Error('start failed');
    watch.stop();
    expect(watch.start()).toEqual({ phase: 'released', epoch: started.epoch, why: 'released' });
    expect(current()).toBeUndefined();
  });
});
