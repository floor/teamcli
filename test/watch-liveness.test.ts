// The shared watch-liveness reading: the pane health `up` and `check` act on, the hand-over
// guard kept conservative, and the sitting that decides whether a hosted watch owns the route.
// Pure scenes: no daemon, no socket and no pane is touched.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonHealth } from '../src/daemon/health.ts';
import type { DaemonRootState } from '../src/daemon/state.ts';
import type { HostedWatchState } from '../src/watch/hosted.ts';
import { paneWatchCheckNotes } from '../src/daemon/watch_display.ts';
import { watchSitting, type PaneWatchRecord } from '../src/watch/liveness.ts';
import { paneWatchHealth, watchIdentity, watchRunning } from '../src/watch/pane.ts';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const INTERVAL = 60;
const options = { alive: () => false, now: NOW, interval: INTERVAL };
const FRESH = new Date(NOW - 30_000).toISOString();
const OLD = new Date(NOW - 5 * 60_000).toISOString();

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

test('a missing record is missing, never dead', () => {
  expect(paneWatchHealth(undefined, options)).toEqual({ state: 'missing' });
});

test('an alive process with a fresh beat is live', () => {
  expect(paneWatchHealth({ pid: 4242, heartbeat: FRESH }, { ...options, alive: () => true }))
    .toEqual({ state: 'live', pid: 4242, heartbeat: FRESH });
});

test('an alive process behind an old beat is stale, not running', () => {
  expect(paneWatchHealth({ pid: 4242, heartbeat: OLD }, { ...options, alive: () => true }))
    .toEqual({ state: 'stale', why: 'heartbeat-old', pid: 4242, heartbeat: OLD });
});

test('an alive process with an unreadable beat is stale for that reason', () => {
  expect(paneWatchHealth({ pid: 4242, heartbeat: 'not-a-time' }, { ...options, alive: () => true }))
    .toEqual({ state: 'stale', why: 'unreadable', pid: 4242, heartbeat: null });
});

test('a recorded process that is gone is dead even with a fresh beat', () => {
  expect(paneWatchHealth({ pid: 4242, heartbeat: FRESH }, options))
    .toEqual({ state: 'dead', pid: 4242, heartbeat: FRESH });
});

test('before a pid is recorded, the pane and a fresh beat make it live', () => {
  expect(paneWatchHealth({ heartbeat: FRESH, pane: 'w1:p1', workspace: 'w1' }, options))
    .toEqual({ state: 'live', pid: null, heartbeat: FRESH, pane: 'w1:p1', workspace: 'w1' });
});

test('before a pid is recorded, an old beat is stale', () => {
  expect(paneWatchHealth({ heartbeat: OLD, pane: 'w1:p1' }, options))
    .toEqual({ state: 'stale', why: 'heartbeat-old', pid: null, heartbeat: OLD, pane: 'w1:p1' });
});

test('a record with neither a pid nor a pane is stale with no process to stop', () => {
  expect(paneWatchHealth({ heartbeat: FRESH }, options))
    .toEqual({ state: 'stale', why: 'no-process', pid: null, heartbeat: FRESH });
});

test('the hand-over guard still counts a live pid behind an old beat', () => {
  expect(watchRunning({ pid: 4242, heartbeat: OLD }, { ...options, alive: () => true })).toBe(true);
  expect(watchRunning({ pid: 4242, heartbeat: OLD }, options)).toBe(false);
  expect(watchRunning({ heartbeat: FRESH, pane: 'w1:p1' }, options)).toBe(true);
  expect(watchRunning({ heartbeat: OLD, pane: 'w1:p1' }, options)).toBe(false);
  expect(watchRunning(undefined, options)).toBe(false);
});

function root(over: Partial<DaemonRootState> = {}): DaemonRootState {
  return { root: '/work/acme', team: 'acme', send: 'serving', bus: 'serving', why: null, ...over };
}

function hosted(over: Partial<HostedWatchState> = {}): HostedWatchState {
  return {
    routeId: 'route-acme',
    root: '/work/acme',
    team: 'acme',
    session: 'acme',
    phase: 'running',
    startedAt: '2026-10-21T11:00:00Z',
    lastCycleAt: '2026-10-21T11:59:30Z',
    lastCycleOutcome: 'pass',
    cycles: 12,
    failures: 0,
    effects: 'blocked',
    required: true,
    why: null,
    ...over,
  };
}

function health(over: Partial<DaemonHealth> = {}): DaemonHealth {
  return {
    daemon: 'teamcli',
    socket: '/work/daemon.sock',
    state: 'running',
    running: true,
    pid: 42,
    uid: 501,
    since: '2026-10-21T10:00:00Z',
    startedBy: 'service-manager',
    version: '0.5.4',
    heartbeatAt: '2026-10-21T11:59:58Z',
    features: { broker: 'absent' },
    stuck: [],
    roots: [],
    probe: { state: 'answered', at: '2026-10-21T12:00:00Z' },
    why: null,
    ...over,
  };
}

const sitting = (daemon: DaemonHealth | undefined, pane?: PaneWatchRecord, rootPath = '/work/acme') =>
  watchSitting({
    daemon,
    root: rootPath,
    pane,
    alive: (pid) => pid === 4242,
    now: NOW,
    interval: INTERVAL,
  });

test('with no daemon reading the pane watch is the only sitting', () => {
  expect(sitting(undefined, { pid: 4242, heartbeat: FRESH }))
    .toEqual({ kind: 'pane', health: { state: 'live', pid: 4242, heartbeat: FRESH } });
});

/** A real directory: the route lookup canonicalizes the root, as `up` and `check` pass it. */
function routeRoot(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'b2-liveness-root-')));
  made.push(base);
  return base;
}

test('a hosted watch in any working phase owns the route', () => {
  const at = routeRoot();
  for (const phase of ['starting', 'running', 'stopping', 'stopped', 'failed'] as const) {
    const record = hosted({ phase, root: at });
    expect(sitting(health({ roots: [root({ root: at, watch: record })] }), { pid: 4242, heartbeat: OLD }, at))
      .toEqual({ kind: 'hosted', root: at, watch: record });
  }
});

test('a standing-by hosted watch yields to the pane watch', () => {
  const at = routeRoot();
  const result = sitting(
    health({ roots: [root({ root: at, watch: hosted({ phase: 'standby', root: at, why: 'a pane watch owns the session' }) })] }),
    { pid: 4242, heartbeat: FRESH },
    at,
  );
  expect(result.kind).toBe('pane');
  if (result.kind === 'pane') expect(result.health.state).toBe('live');
});

test('an unknown reading with no visible hosted record is unknown, carrying the pane health', () => {
  const result = sitting(
    health({ state: 'unknown', running: null, probe: { state: 'unknown', at: '2026-10-21T12:00:00Z', reason: 'the state record is unreadable' }, why: 'the state record is unreadable' }),
    undefined,
  );
  expect(result).toEqual({
    kind: 'unknown',
    why: 'the state record is unreadable',
    health: { state: 'missing' },
  });
});

test('the check note matrix follows the same sitting, and a hosted watch is silent', () => {
  const known = { known: true, running: true };
  expect(paneWatchCheckNotes({ kind: 'pane', health: { state: 'live', pid: 4242, heartbeat: FRESH } }, known))
    .toEqual([]);
  expect(paneWatchCheckNotes({ kind: 'pane', health: { state: 'dead', pid: 4242, heartbeat: FRESH } }, known))
    .toEqual(['watch: the recorded process 4242 is gone; the next team up starts one']);
  expect(paneWatchCheckNotes({ kind: 'pane', health: { state: 'stale', why: 'unreadable', pid: 4242, heartbeat: null } }, known))
    .toEqual(['watch: process 4242 is alive but its heartbeat is unreadable; the next team up replaces it']);
  expect(paneWatchCheckNotes({ kind: 'pane', health: { state: 'stale', why: 'no-process', pid: null, heartbeat: FRESH } }, known))
    .toEqual(['watch: recorded with no process or pane; the next team up starts one']);
  expect(paneWatchCheckNotes({ kind: 'pane', health: { state: 'missing' } }, known))
    .toEqual(['watch: none running; the next team up starts one']);
  expect(paneWatchCheckNotes({ kind: 'pane', health: { state: 'missing' } }, { known: true, running: false }))
    .toEqual([]);
  expect(paneWatchCheckNotes({ kind: 'pane', health: { state: 'missing' } }, { known: false, running: true }))
    .toEqual([]);
  expect(paneWatchCheckNotes({ kind: 'unknown', why: 'unreadable', health: { state: 'dead', pid: 4242, heartbeat: FRESH } }, { known: false, running: true }))
    .toEqual(['watch: the recorded process 4242 is gone; the daemon health cannot say whether a hosted watch owns the route']);
  expect(paneWatchCheckNotes({ kind: 'hosted', root: '/work/acme', watch: hosted() }, known)).toEqual([]);
});

test('a root reached through a link is read as its canonical route', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'b2-liveness-')));
  made.push(base);
  const real = join(base, 'acme');
  const link = join(base, 'link');
  mkdirSync(real);
  symlinkSync(real, link);
  const record = hosted({ root: real });
  expect(sitting(health({ roots: [root({ root: real, watch: record })] }), undefined, link))
    .toEqual({ kind: 'hosted', root: real, watch: record });
});

test('a recorded pid is verified only through the pane its own record names', () => {
  const inPane = (pane: string, foreground: number[], shell = 900) => (_pane: string) =>
    _pane === pane ? { shell, foreground } : null;
  expect(watchIdentity(
    { pid: 4242, pane: 'w1:p1' },
    { alive: () => true, processInfo: inPane('w1:p1', [4242]) },
  )).toEqual({ kind: 'verified', pid: 4242, pane: 'w1:p1' });
  expect(watchIdentity(
    { pid: 4242, pane: 'w1:p1' },
    { alive: () => true, processInfo: (_pane) => ({ shell: 4242, foreground: [900] }) },
  )).toEqual({ kind: 'verified', pid: 4242, pane: 'w1:p1' });
});

test('a pid that is gone has nothing to stop, and cannot be a foreign process', () => {
  expect(watchIdentity(
    { pid: 4242, pane: 'w1:p1' },
    { alive: () => false, processInfo: () => null },
  )).toEqual({ kind: 'gone' });
});

test('a pid that cannot be shown to be the watch is unproven, never signalled', () => {
  expect(watchIdentity(
    { pid: 4242 },
    { alive: () => true, processInfo: () => ({ shell: 900, foreground: [4242] }) },
  )).toEqual({ kind: 'unproven', why: 'pid 4242 is recorded with no pane' });
  expect(watchIdentity(
    { pid: 4242, pane: 'w1:p1' },
    { alive: () => true, processInfo: () => null },
  )).toEqual({ kind: 'unproven', why: 'pid 4242 is recorded in pane w1:p1, which cannot be read' });
  expect(watchIdentity(
    { pid: 4242, pane: 'w1:p1' },
    { alive: () => true, processInfo: () => ({ shell: 900, foreground: [900, 5151] }) },
  )).toEqual({ kind: 'unproven', why: 'pid 4242 is not the process in its recorded pane w1:p1' });
});
