// Acceptance: the watch host lifecycle on top of the authority store, independent of the
// store's own fixtures. The host is driven only through its documented surface — start, tick,
// stop, report, phase — against the real state directory and lock:
//
// 1. A same-pid successor epoch drains the host on the next tick; the host never renews over it,
//    never reacquires, and its clean-up never clears the successor.
// 2. A held state lock makes renew `busy`: the captured proof keeps the host authoritative up to
//    the inclusive 15 s edge, drains it one millisecond later, and writes nothing throughout.
// 3. A busy release stays `releasing` with the same captured epoch; a repeated stop and the fixed
//    tick retry that epoch's release only. A successor that appears meanwhile is left standing.
// 4. A clock that throws, a clock that is unreadable (Invalid Date), and a state file whose read
//    fails each drain the host without touching the record; an acquire-time clock failure refuses
//    standby and writes nothing.
//
// No scheduler, sender or pane is involved: the clock and the state directory are the world.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWatchHost } from '../src/watch/authority-lifecycle.ts';
import { isWatchEpoch, mintWatchEpoch, WATCH_AUTHORITY_MAX_AGE_MS } from '../src/watch/epoch.ts';
import { emptySession, LOCK_FILE, readState, STATE_FILE, updateState } from '../src/state.ts';

const T0 = Date.parse('2026-10-20T05:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

type Watch = { pid: number; epoch: string; heartbeat: string };

let dir = '';

afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function makeDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'watch-lifecycle-acceptance-'));
  const agents = join(dir, '.agents');
  mkdirSync(agents, { recursive: true });
  return agents;
}

function stateText(agents: string): string {
  return readFileSync(join(agents, STATE_FILE), 'utf8');
}

/** A standing record written the way another host writes one: through the store's own lock. */
function seedWatch(agents: string, watch: Watch): void {
  updateState(agents, (state) => {
    (state.sessions.crew ??= emptySession()).watch = watch;
  });
}

/** A lock this live process holds: `withLock(waitMs: 0)` reports it busy at once, and it never
 *  ages into the pid-less heuristic however long the scene runs. */
function holdLock(agents: string): void {
  writeFileSync(join(agents, LOCK_FILE), `${String(process.pid)}\n`);
}

function dropLock(agents: string): void {
  rmSync(join(agents, LOCK_FILE), { force: true });
}

function startedHost(agents: string, now: () => Date): { host: ReturnType<typeof createWatchHost>; epoch: string } {
  const host = createWatchHost(agents, 'crew', { now });
  const started = host.start();
  expect(started.phase).toBe('authoritative');
  if (started.phase !== 'authoritative') throw new Error('the host did not acquire');
  expect(isWatchEpoch(started.epoch)).toBe(true);
  return { host, epoch: started.epoch };
}

describe('the watch host lifecycle', () => {
  test('a same-pid successor epoch drains the host; it never renews, reacquires or clears it', () => {
    const agents = makeDir();
    const { host, epoch } = startedHost(agents, () => new Date(T0));

    const successor: Watch = { pid: process.pid, epoch: mintWatchEpoch(), heartbeat: iso(T0) };
    seedWatch(agents, successor);
    const successorBytes = stateText(agents);

    const lost = host.tick();
    expect(lost).toEqual({ phase: 'draining', epoch, why: 'lost' });
    expect(host.report()).toEqual(lost);
    expect(host.phase()).toBe('draining');
    expect(stateText(agents)).toBe(successorBytes);

    // No reacquire from any surface once drained.
    expect(host.tick()).toEqual(lost);
    expect(host.start()).toEqual(lost);
    expect(host.phase()).toBe('draining');

    // Clean-up reports a lost release and does not clear the successor.
    expect(host.stop()).toEqual({ phase: 'released', epoch, why: 'lost' });
    expect(stateText(agents)).toBe(successorBytes);
    expect(readState(agents).sessions.crew?.watch).toEqual(successor);
  });

  test('a held state lock keeps the host authoritative to the 15 s edge, then drains it', () => {
    const agents = makeDir();
    let nowMs = T0;
    const { host, epoch } = startedHost(agents, () => new Date(nowMs));
    const recordBytes = stateText(agents);

    holdLock(agents);

    // Exactly at the edge the captured proof still stands; the busy renew wrote nothing.
    nowMs = T0 + WATCH_AUTHORITY_MAX_AGE_MS;
    expect(host.tick()).toEqual({ phase: 'authoritative', epoch, renewedAt: iso(T0) });
    expect(host.phase()).toBe('authoritative');
    expect(stateText(agents)).toBe(recordBytes);

    // One millisecond later the proof has lapsed: draining, never authoritative indefinitely.
    nowMs = T0 + WATCH_AUTHORITY_MAX_AGE_MS + 1;
    const drained = host.tick();
    expect(drained).toEqual({ phase: 'draining', epoch, why: 'lost' });
    expect(stateText(agents)).toBe(recordBytes);

    dropLock(agents);
    expect(host.tick()).toEqual(drained);
    expect(host.stop()).toEqual({ phase: 'released', epoch, why: 'lost' });
    expect(host.start()).toEqual({ phase: 'released', epoch, why: 'lost' });
    expect(host.phase()).toBe('released');
    // The stale authority record was never rewritten or cleared by the drain.
    expect(stateText(agents)).toBe(recordBytes);
  });

  test('a busy stop stays releasing on the same epoch; a successor that appears is left standing', () => {
    const agents = makeDir();
    let nowMs = T0;
    const { host, epoch } = startedHost(agents, () => new Date(nowMs));
    const recordBytes = stateText(agents);

    holdLock(agents);
    const releasing = { phase: 'releasing', epoch, why: 'busy' } as const;
    expect(host.stop()).toEqual(releasing);
    expect(stateText(agents)).toBe(recordBytes);

    // Both a repeated stop and the fixed tick retry the release only — never acquire or renew.
    nowMs = T0 + 1_000;
    expect(host.stop()).toEqual(releasing);
    expect(host.tick()).toEqual(releasing);
    expect(host.phase()).toBe('releasing');
    expect(stateText(agents)).toBe(recordBytes);

    // The lock clears and a successor takes the record before clean-up lands.
    dropLock(agents);
    const successor: Watch = { pid: process.pid, epoch: mintWatchEpoch(), heartbeat: iso(T0 + 2_000) };
    seedWatch(agents, successor);
    const successorBytes = stateText(agents);

    const done = host.tick();
    expect(done).toEqual({ phase: 'released', epoch, why: 'lost' });
    expect(host.stop()).toEqual(done);
    expect(host.start()).toEqual(done);
    expect(host.phase()).toBe('released');
    expect(stateText(agents)).toBe(successorBytes);
    expect(readState(agents).sessions.crew?.watch).toEqual(successor);
  });

  test('a clock that throws during a tick drains with its error and writes nothing', () => {
    const agents = makeDir();
    let clock: () => Date = () => new Date(T0);
    const { host, epoch } = startedHost(agents, () => clock());
    const recordBytes = stateText(agents);

    clock = () => {
      throw new Error('clock unavailable');
    };
    const drained = host.tick();
    expect(drained).toEqual({ phase: 'draining', epoch, why: 'lost', error: 'clock unavailable' });
    expect(stateText(agents)).toBe(recordBytes);

    expect(host.stop()).toEqual({ phase: 'released', epoch, why: 'lost' });
    expect(stateText(agents)).toBe(recordBytes);
  });

  test('an unreadable clock (Invalid Date) drains rather than leaving the host authoritative', () => {
    const agents = makeDir();
    let nowValue = new Date(T0);
    const { host, epoch } = startedHost(agents, () => nowValue);
    const recordBytes = stateText(agents);

    nowValue = new Date(NaN);
    expect(host.tick()).toEqual({ phase: 'draining', epoch, why: 'lost' });
    expect(stateText(agents)).toBe(recordBytes);

    expect(host.stop()).toEqual({ phase: 'released', epoch, why: 'lost' });
    expect(stateText(agents)).toBe(recordBytes);
  });

  test('a state file that cannot be read drains with its error and is left exactly as it stands', () => {
    const agents = makeDir();
    const { host, epoch } = startedHost(agents, () => new Date(T0));

    const broken = '{"format": 1, "sessions": ';
    writeFileSync(join(agents, STATE_FILE), broken);
    const drained = host.tick();
    expect(drained.phase).toBe('draining');
    if (drained.phase !== 'draining') return;
    expect(drained.epoch).toBe(epoch);
    expect(drained.why).toBe('lost');
    expect(drained.error).toBe(
      `${join(agents, STATE_FILE)} is not valid JSON; move it aside and run the command again`,
    );
    expect(readFileSync(join(agents, STATE_FILE), 'utf8')).toBe(broken);

    expect(host.stop()).toEqual({ phase: 'released', epoch, why: 'lost' });
    expect(readFileSync(join(agents, STATE_FILE), 'utf8')).toBe(broken);
  });

  test('a clock that throws during acquire refuses standby and writes nothing', () => {
    const agents = makeDir();
    const host = createWatchHost(agents, 'crew', {
      now: () => {
        throw new Error('clock unavailable');
      },
    });

    expect(host.start()).toEqual({ phase: 'standby', why: 'refused', error: 'clock unavailable' });
    expect(host.phase()).toBe('standby');
    expect(existsSync(join(agents, STATE_FILE))).toBe(false);
  });
});
