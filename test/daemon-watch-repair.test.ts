// The repair a missing or stale watch names, read from the daemon's own health reading: a
// running daemon records whether it was started with --watch, and only its own `off` names it.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { daemonStatePath } from '../src/daemon/paths.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import { daemonHostsNoWatch, WATCH_HOSTING_REPAIR, WATCH_MISSING_REPAIR as WATCH_REPAIR, watchRepairOf } from '../src/daemon/watch_display.ts';

function health(watch: 'on' | 'off' | undefined, state: DaemonHealth['state'] = 'running'): DaemonHealth {
  return {
    daemon: 'teamcli',
    socket: 'socket-repair',
    state,
    running: state === 'running',
    pid: state === 'running' ? 7 : null,
    uid: null,
    since: null,
    startedBy: null,
    version: '1',
    gitHead: null,
    heartbeatAt: null,
    heartbeatSeconds: 5,
    features: watch === undefined ? { broker: 'absent' } : { broker: 'absent', watch },
    stuck: [],
    roots: [],
  } as unknown as DaemonHealth;
}

test('a running daemon that records it was started without --watch hosts none, and the repair names --watch', () => {
  const reading = health('off');
  expect(daemonHostsNoWatch(reading)).toBe(true);
  expect(watchRepairOf(reading)).toBe(WATCH_HOSTING_REPAIR);
  expect(WATCH_HOSTING_REPAIR).toContain('team daemon install --watch');
});

test('a daemon started with --watch keeps the generic repair, whatever its roots show', () => {
  const reading = health('on');
  expect(daemonHostsNoWatch(reading)).toBe(false);
  expect(watchRepairOf(reading)).toBe(WATCH_REPAIR);
});

test('no reading, a daemon that is not running, or an older build with no watch word proves nothing', () => {
  expect(watchRepairOf(null)).toBe(WATCH_REPAIR);
  expect(watchRepairOf(undefined)).toBe(WATCH_REPAIR);
  expect(daemonHostsNoWatch(health('off', 'not-running'))).toBe(false);
  expect(daemonHostsNoWatch(health(undefined))).toBe(false);
});

test('the state record keeps the run's watch word, and an older record without one reads as not known', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'team-watch-word-')));
  try {
    const base = {
      format: 1,
      pid: 4242,
      uid: 501,
      since: '2026-11-14T10:00:00.000Z',
      startedBy: 'service-manager',
      version: '0.5.22',
      heartbeatAt: '2026-11-14T10:00:05.000Z',
      socket: 'socket-watch-word',
      stuck: [],
      roots: [],
    };
    const write = (features: Record<string, unknown>): void => {
      writeFileSync(daemonStatePath(home), `${JSON.stringify({ ...base, features })}\n`, { mode: 0o600 });
    };
    mkdirSync(dirname(daemonStatePath(home)), { recursive: true, mode: 0o700 });
    write({ broker: 'absent', watch: 'off' });
    const off = readDaemonState(home);
    expect(off.kind === 'ok' ? off.state.features : null).toEqual({ broker: 'absent', watch: 'off' });
    write({ broker: 'absent' });
    const older = readDaemonState(home);
    expect(older.kind === 'ok' ? older.state.features : null).toEqual({ broker: 'absent' });
    write({ broker: 'absent', watch: 'sometimes' });
    const odd = readDaemonState(home);
    expect(odd.kind === 'ok' ? odd.state.features : null).toEqual({ broker: 'absent' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
