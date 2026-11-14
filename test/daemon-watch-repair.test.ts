// The repair a missing or stale watch names, read from the daemon's own health reading: a
// running daemon whose roots carry no hosted watch was started without --watch.
import { expect, test } from 'bun:test';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { daemonHostsNoWatch, WATCH_HOSTING_REPAIR, WATCH_MISSING_REPAIR as WATCH_REPAIR, watchRepairOf } from '../src/daemon/watch_display.ts';

function health(roots: DaemonHealth['roots'], state: DaemonHealth['state'] = 'running'): DaemonHealth {
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
    features: null,
    stuck: [],
    roots,
  } as unknown as DaemonHealth;
}

const ROOT = { root: '/fixture/root', team: 'fixture', send: 'serving', bus: 'serving', why: null } as unknown as DaemonHealth['roots'][number];
const HOSTED = { ...ROOT, watch: { phase: 'standing-by' } } as unknown as DaemonHealth['roots'][number];

test('a running daemon whose roots carry no hosted watch hosts none, and the repair names --watch', () => {
  const reading = health([ROOT, { ...ROOT, root: '/fixture/other' }]);
  expect(daemonHostsNoWatch(reading)).toBe(true);
  expect(watchRepairOf(reading)).toBe(WATCH_HOSTING_REPAIR);
  expect(WATCH_HOSTING_REPAIR).toContain('team daemon install --watch');
});

test('one hosted watch record, in any phase, proves watch hosting is on', () => {
  const reading = health([ROOT, HOSTED]);
  expect(daemonHostsNoWatch(reading)).toBe(false);
  expect(watchRepairOf(reading)).toBe(WATCH_REPAIR);
});

test('no reading, a stopped daemon, or a daemon with no root proves nothing', () => {
  expect(watchRepairOf(null)).toBe(WATCH_REPAIR);
  expect(watchRepairOf(undefined)).toBe(WATCH_REPAIR);
  expect(daemonHostsNoWatch(health([ROOT], 'not-running'))).toBe(false);
  expect(daemonHostsNoWatch(health([]))).toBe(false);
});
