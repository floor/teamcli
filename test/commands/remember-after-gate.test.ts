// Remembering the team file waits until the caller gate has allowed the run. A refusal leaves
// the state file byte for byte as it was; an allowed run still stores the file it loaded, at the
// clock reading taken after the gate.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import type { Caller } from '../../src/caller.ts';
import { runDown, type DownLaunch, type DownSources } from '../../src/commands/down.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { runWatch, type WatchSources } from '../../src/commands/watch.ts';
import { seatLockPath } from '../../src/launch/seat-lock.ts';
import { emptySession, readState, STATE_FILE, updateState } from '../../src/state.ts';
import { testIo } from '../helpers.ts';

const EXAMPLE = readFileSync(new URL('../fixtures/example.yaml', import.meta.url), 'utf8');
const T0 = Date.parse('2026-10-06T10:00:00.000Z');
const SESSION = 'acme-web';
const WORKER: Caller = { kind: 'seat', name: 'deepseek-acme', pane: 'w3:p1', session: SESSION };
const LEAD: Caller = { kind: 'seat', name: 'claude-coordinator-acme', pane: 'w1:p1', session: SESSION };

let base: string;
let root: string;
let home: string;
let dir: string;
let file: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-remember-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  dir = join(root, '.agents');
  file = join(dir, 'team.yaml');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  writeFileSync(file, EXAMPLE);
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, new Date(T0)), file: readFileSync(file, 'utf8') },
    loaded.team.seats,
    home,
    new Date(T0),
  );
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A clock that moves a second per read, so the reading before the gate and the one after it differ. */
function clock(): { now: () => Date; at: (nth: number) => string } {
  let n = 0;
  return {
    now: () => new Date(T0 + n++ * 1000),
    at: (nth) => new Date(T0 + nth * 1000).toISOString(),
  };
}

function seed(seats: Record<string, string>): string {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    for (const [name, pane] of Object.entries(seats)) {
      session.seats[name] = { stage: 'ready', pane, workspace: pane.split(':')[0] ?? pane };
    }
  });
  return readFileSync(join(dir, STATE_FILE), 'utf8');
}

function downSources(now: () => Date, running: boolean): DownSources {
  return {
    sessionRunning: () => running,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['claude'],
    now,
    home,
  };
}

function launch(now: () => Date): DownLaunch {
  return {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => [],
    closeWorkspace: () => true,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now,
  };
}

function watchSources(now: () => Date): WatchSources {
  return {
    live: () => null,
    machine: () => ({ loadPerCore: 0, memoryFree: 50, diskFree: 1, swapTotal: 2, swapFree: 1, swapUsed: 0 }),
    standing: () => ({ kind: 'none' }),
    readChecks: () => [],
    screen: () => null,
    status: () => null,
    foreground: () => null,
    typeText: () => false,
    pressEnter: () => false,
    sleep: async () => {},
    notify: () => {},
    now,
    wait: async () => false,
    alive: () => false,
    pid: 4242,
  };
}

describe('down remembers only after the caller gate', () => {
  test('a caller the ordinary rule refuses leaves the state file untouched', async () => {
    const before = seed({ 'deepseek-acme': 'w3:p1' });
    const io = testIo(root, WORKER);
    const code = await runDown([], io, downSources(() => new Date(T0), true));
    expect(code).toBe(1);
    expect(io.err).toContain('only the owner or `leads` stops the team');
    expect(readFileSync(join(dir, STATE_FILE), 'utf8')).toBe(before);
  });

  test('a refused --abandon leaves the state file untouched', async () => {
    const before = seed({ 'claude-coordinator-acme': 'w1:p1' });
    const io = testIo(root, LEAD);
    const code = await runDown(['--abandon'], io, downSources(() => new Date(T0), true));
    expect(code).toBe(1);
    expect(io.err).toContain('only the owner abandons a team');
    expect(readFileSync(join(dir, STATE_FILE), 'utf8')).toBe(before);
  });

  test('an allowed run still remembers the file, at the reading taken after the gate', async () => {
    seed({ 'deepseek-acme': 'w3:p1' });
    const ticks = clock();
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown([], io, downSources(ticks.now, false));
    expect(code).toBe(0);
    expect(io.out).toContain('is not running');
    const remembered = readState(dir).last_valid;
    expect(remembered?.file).toBe(EXAMPLE);
    expect(remembered?.read_at).toBe(ticks.at(1));
  });

  test('a dry run leaves the state file untouched', async () => {
    const before = seed({ 'deepseek-acme': 'w3:p1' });
    const idle = testIo(root, { kind: 'owner' });
    expect(await runDown(['--dry-run'], idle, downSources(() => new Date(T0), false))).toBe(0);
    expect(idle.out).toContain('dry run: nothing was run');
    expect(readFileSync(join(dir, STATE_FILE), 'utf8')).toBe(before);
    const running = testIo(root, { kind: 'owner' });
    expect(await runDown(['--dry-run'], running, downSources(() => new Date(T0), true))).toBe(0);
    expect(readFileSync(join(dir, STATE_FILE), 'utf8')).toBe(before);
  });

  test('a held run lock leaves the state file untouched', async () => {
    const before = seed({ 'deepseek-acme': 'w3:p1' });
    mkdirSync(join(dir, 'seat-locks', SESSION), { recursive: true });
    writeFileSync(seatLockPath(dir, SESSION, '.run'), `${process.pid} 0a1b2c3d\n`);
    const now = () => new Date(T0);
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown([], io, { ...downSources(now, true), launch: launch(now) });
    expect(code).toBe(1);
    expect(io.err).toContain('another session-mutating run is holding');
    expect(readFileSync(join(dir, STATE_FILE), 'utf8')).toBe(before);
  });
});

describe('watch remembers only after the flag gate', () => {
  test('--no-nudge from a seat leaves the state file untouched', async () => {
    const before = seed({ 'deepseek-acme': 'w3:p1' });
    const io = testIo(root, WORKER);
    const code = await runWatch(['--no-nudge'], io, watchSources(() => new Date(T0)));
    expect(code).toBe(1);
    expect(io.err).toContain('--no-nudge and --no-notify are the owner\'s');
    expect(readFileSync(join(dir, STATE_FILE), 'utf8')).toBe(before);
  });

  test('--no-notify from a seat leaves the state file untouched', async () => {
    const before = seed({ 'deepseek-acme': 'w3:p1' });
    const io = testIo(root, WORKER);
    const code = await runWatch(['--no-notify'], io, watchSources(() => new Date(T0)));
    expect(code).toBe(1);
    expect(io.err).toContain('--no-nudge and --no-notify are the owner\'s');
    expect(readFileSync(join(dir, STATE_FILE), 'utf8')).toBe(before);
  });

  test('an allowed run still remembers the file, at the reading taken after the gate', async () => {
    const ticks = clock();
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch([], io, watchSources(ticks.now));
    expect(code).toBe(0);
    const remembered = readState(dir).last_valid;
    expect(remembered?.file).toBe(EXAMPLE);
    expect(remembered?.read_at).toBe(ticks.at(1));
  });

  test('a watch that is already running leaves the state file untouched', async () => {
    updateState(dir, (state) => {
      const session = (state.sessions[SESSION] ??= emptySession());
      session.watch = { pid: 99, heartbeat: '2026-10-06T09:00:00.000Z' };
    });
    const before = readFileSync(join(dir, STATE_FILE), 'utf8');
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch([], io, { ...watchSources(() => new Date(T0)), alive: (pid) => pid === 99 });
    expect(code).toBe(1);
    expect(io.err).toContain('a watch already runs');
    expect(readFileSync(join(dir, STATE_FILE), 'utf8')).toBe(before);
  });
});
