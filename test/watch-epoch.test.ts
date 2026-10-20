import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptySession, readState, updateState, type State } from '../src/state.ts';
import {
  isWatchEpoch,
  mintWatchEpoch,
  WATCH_AUTHORITY_FUTURE_SKEW_MS,
  WATCH_AUTHORITY_MAX_AGE_MS,
  watchEpochCurrent,
} from '../src/watch/epoch.ts';
import { beatWatch } from '../src/watch/pane.ts';

const T0 = Date.parse('2026-10-20T03:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

let dir = '';
let agents = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watch-epoch-'));
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

describe('the epoch a host captures', () => {
  test('a mint is watch_ and 32 lowercase hex digits, and every mint is new', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 128; i++) {
      const epoch = mintWatchEpoch();
      expect(epoch).toMatch(/^watch_[0-9a-f]{32}$/);
      expect(isWatchEpoch(epoch)).toBe(true);
      expect(seen.has(epoch)).toBe(false);
      seen.add(epoch);
    }
    // The shape is closed: variants of a minted epoch are not epochs.
    expect(isWatchEpoch('watch_0123456789ABCDEF0123456789abcdef')).toBe(false);
    expect(isWatchEpoch('watch_0123456789abcdef')).toBe(false);
    expect(isWatchEpoch('epoch_0123456789abcdef0123456789abcdef')).toBe(false);
    expect(isWatchEpoch(null)).toBe(false);
    expect(isWatchEpoch(42)).toBe(false);
  });

  test('freshness uses the fixed window on both edges, inclusive', () => {
    const epoch = mintWatchEpoch();
    const record = { epoch, heartbeat: iso(T0) };
    expect(watchEpochCurrent(record, T0)).toBe(true);
    expect(watchEpochCurrent(record, T0 + WATCH_AUTHORITY_MAX_AGE_MS)).toBe(true);
    expect(watchEpochCurrent(record, T0 + WATCH_AUTHORITY_MAX_AGE_MS + 1)).toBe(false);
    expect(watchEpochCurrent(record, T0 - WATCH_AUTHORITY_FUTURE_SKEW_MS)).toBe(true);
    expect(watchEpochCurrent(record, T0 - WATCH_AUTHORITY_FUTURE_SKEW_MS - 1)).toBe(false);
  });

  test('freshness needs a well-formed epoch and a parseable heartbeat', () => {
    expect(watchEpochCurrent({ heartbeat: iso(T0) }, T0)).toBe(false);
    expect(watchEpochCurrent({ epoch: 'not-an-epoch', heartbeat: iso(T0) }, T0)).toBe(false);
    expect(watchEpochCurrent({ epoch: mintWatchEpoch(), heartbeat: 'not a time' }, T0)).toBe(false);
    expect(watchEpochCurrent({ epoch: mintWatchEpoch() }, T0)).toBe(false);
    expect(watchEpochCurrent(undefined, T0)).toBe(false);
  });
});

describe('the state record and the heartbeat', () => {
  test('an unreadable epoch is dropped at the read door, and the record stays a pane record', () => {
    writeFileSync(join(agents, 'team.state.json'), JSON.stringify({
      format: 1,
      sessions: { crew: { watch: { pid: 4242, heartbeat: iso(T0), epoch: 'watch_NOTHEX' } } },
    }));
    expect(current()).toEqual({ pid: 4242, heartbeat: iso(T0) });
  });

  test('a well-formed epoch survives the read door', () => {
    const epoch = mintWatchEpoch();
    writeFileSync(join(agents, 'team.state.json'), JSON.stringify({
      format: 1,
      sessions: { crew: { watch: { pid: 4242, heartbeat: iso(T0), epoch } } },
    }));
    expect(current()).toEqual({ pid: 4242, heartbeat: iso(T0), epoch });
  });

  test('a watch record whose heartbeat is not text is not a watch', () => {
    writeFileSync(join(agents, 'team.state.json'), JSON.stringify({
      format: 1,
      sessions: { crew: { watch: { pid: 4242, heartbeat: 42 } } },
    }));
    expect(current()).toBeUndefined();
  });

  test('a heartbeat pass keeps the epoch of the same pid and never adopts another pid\'s', () => {
    const epoch = mintWatchEpoch();
    seed({ pid: process.pid, heartbeat: iso(T0), epoch });
    beatWatch(agents, 'crew', process.pid, iso(T0 + 5_000), 'keep');
    expect(current()).toEqual({ pid: process.pid, heartbeat: iso(T0 + 5_000), epoch });

    seed({ pid: process.pid + 1, heartbeat: iso(T0), epoch });
    beatWatch(agents, 'crew', process.pid, iso(T0 + 5_000), 'keep');
    expect(current()).toEqual({ pid: process.pid + 1, heartbeat: iso(T0), epoch });
  });

  test('a pane beat leaves a pid-less mid-handoff epoch untouched', () => {
    const epoch = mintWatchEpoch();
    seed({ heartbeat: iso(T0), epoch });
    beatWatch(agents, 'crew', process.pid, iso(T0 + 5_000), 'keep');
    expect(current()).toEqual({ heartbeat: iso(T0), epoch });
  });
});
