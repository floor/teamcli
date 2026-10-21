// S0a acceptance: `team up` reads which watch owns the route and repairs only what is actually
// missing or stale. A hosted watch that is not standing by suppresses the pane watch; a pane
// record with a live process behind an old heartbeat is stopped and replaced once; a healthy
// pane watch is left alone. The fake Launch records workspace creates and kills; no pane, owner
// home or live service is touched.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../../src/approve/command.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import type { DaemonHealth } from '../../src/daemon/health.ts';
import type { DaemonRootState } from '../../src/daemon/state.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import type { HostedWatchState } from '../../src/watch/hosted.ts';
import { CLAUDE_IDLE, testIo } from '../helpers.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8').replace('parked: true', 'stopped: true');
const FILE = ['--file', '.agents/team.yaml'];
const NOW = new Date('2026-10-03T14:02:00Z');
const SESSION = 'acme-web';
const FRESH = new Date(NOW.getTime() - 30_000).toISOString();
const OLD = new Date(NOW.getTime() - 5 * 60_000).toISOString();

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'b2-up-watch-health-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE.replace(
    /trust:[\s\S]*?workspace:/,
    `trust:\n  - ~/.config/team/lobby\n  - ${root}\n  - ${join(base, 'worktrees')}\n\nworkspace:`,
  ));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function approve(): Promise<void> {
  const io = testIo(root, { kind: 'owner' });
  expect(await runApprove(FILE, io, { ask: async () => '5', waiting: () => 'empty', now: () => NOW, home })).toBe(0);
}

function agent(name: string, pane: string): HerdrAgent {
  return { name, agent: 'claude', pane, workspace: pane.split(':')[0] ?? pane, status: 'idle', cwd: null };
}

type World = {
  launch: Launch;
  creates: string[];
  kills: number[];
  session: 'absent' | 'running';
  workspaceList(): { id: string; label: string }[];
};

function world(): World {
  const state: World = {
    launch: {} as Launch,
    creates: [],
    kills: [],
    session: 'absent',
    workspaceList: () => [...spaces].map(([id, label]) => ({ id, label })),
  };
  let clock = NOW.getTime();
  let n = 0;
  const panes = new Map<string, { text: string; agent: boolean }>();
  const spaces = new Map<string, string>();
  state.launch = {
    sessionState: () => state.session,
    startServer() {
      state.session = 'running';
      return true;
    },
    sessionUp: () => state.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n += 1;
      const pane = `w${String(n)}:p1`;
      panes.set(pane, { text: CLAUDE_IDLE, agent: false });
      spaces.set(`w${String(n)}`, label);
      state.creates.push(label);
      return { pane, workspace: `w${String(n)}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes: (_session, workspace) => [...panes.keys()].filter((pane) => pane.startsWith(`${workspace}:`)),
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    focus: () => true,
    deleteSession: () => true,
    kill(pid) {
      state.kills.push(pid);
      return true;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return state;
}

function sources(extra: Partial<UpSources>, made: World): UpSources {
  return {
    sessionRunning: () => made.session === 'running',
    agents: () => [],
    workspaces: () => made.workspaceList(),
    home,
    now: made.launch.now,
    sleep: made.launch.sleep,
    launch: made.launch,
    ...extra,
  };
}

const statePath = () => join(root, '.agents/team.state.json');

const alive = () => [
  agent('claude-coordinator-acme', 'w1:p1'),
  agent('deepseek-acme', 'w2:p1'),
  agent('deepseek-acme-2', 'w3:p1'),
];

/** An approved first run, whose state is then edited to the watch record under test. */
async function baseline(watch: { pid?: number; heartbeat: string } | null): Promise<World> {
  await approve();
  const made = world();
  expect(await runUp(FILE, testIo(root, { kind: 'owner' }), sources({}, made))).toBe(0);
  const seeded = JSON.parse(readFileSync(statePath(), 'utf8')) as {
    sessions: Record<string, { watch?: unknown }>;
  };
  if (watch === null) delete seeded.sessions[SESSION]!.watch;
  else seeded.sessions[SESSION]!.watch = watch;
  writeFileSync(statePath(), JSON.stringify(seeded));
  return made;
}

/** A second run with every seat already standing, as the two-run scenes run it. */
async function second(made: World, extra: Partial<UpSources>): Promise<number> {
  made.launch.agents = alive;
  made.creates.length = 0;
  made.kills.length = 0;
  return runUp(FILE, testIo(root, { kind: 'owner' }), sources({
    sessionState: () => 'running',
    agents: alive,
    ...extra,
  }, made));
}

const watchCreates = (made: World) => made.creates.filter((label) => label.startsWith('Watch · ')).length;

function route(over: Partial<DaemonRootState> = {}): DaemonRootState {
  return { root: realpathSync(root), team: SESSION, send: 'serving', bus: 'serving', why: null, ...over };
}

function hosted(over: Partial<HostedWatchState> = {}): HostedWatchState {
  return {
    routeId: `route-${SESSION}`,
    root: realpathSync(root),
    team: SESSION,
    session: SESSION,
    phase: 'running',
    startedAt: '2026-10-03T13:00:00Z',
    lastCycleAt: '2026-10-03T14:01:30Z',
    lastCycleOutcome: 'pass',
    cycles: 20,
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
    since: '2026-10-03T13:00:00Z',
    startedBy: 'service-manager',
    version: '0.5.4',
    heartbeatAt: '2026-10-03T14:01:58Z',
    features: { broker: 'absent' },
    stuck: [],
    roots: [],
    probe: { state: 'answered', at: NOW.toISOString() },
    why: null,
    ...over,
  };
}

const daemon = (reading: DaemonHealth) => async () => reading;

describe('a missing or dead pane watch is replaced once', () => {
  test('no record at all starts one watch', async () => {
    const made = await baseline(null);
    expect(await second(made, { daemonHealth: daemon(health({ state: 'not-running', running: false, pid: null, probe: { state: 'refused', at: NOW.toISOString(), code: 'ECONNREFUSED', message: 'no daemon' } })) })).toBe(0);
    expect(watchCreates(made)).toBe(1);
    expect(made.kills).toEqual([]);
  });

  test('a recorded process that is gone starts one and kills nothing', async () => {
    const made = await baseline({ pid: 4242, heartbeat: FRESH });
    expect(await second(made, { alive: () => false, daemonHealth: daemon(health()) })).toBe(0);
    expect(watchCreates(made)).toBe(1);
    expect(made.kills).toEqual([]);
  });
});

describe('a live process behind an old heartbeat is stale and is replaced', () => {
  test('the plan kills the recorded pid before starting the replacement', async () => {
    const made = await baseline({ pid: 4242, heartbeat: OLD });
    expect(await second(made, { alive: (pid) => pid === 4242, daemonHealth: daemon(health()) })).toBe(0);
    expect(made.kills).toEqual([4242]);
    expect(watchCreates(made)).toBe(1);
  });
});

describe('a healthy watch is left alone', () => {
  test('a live pane watch with a fresh beat starts no second one', async () => {
    const made = await baseline({ pid: 4242, heartbeat: FRESH });
    expect(await second(made, { alive: (pid) => pid === 4242, daemonHealth: daemon(health()) })).toBe(0);
    expect(watchCreates(made)).toBe(0);
    expect(made.kills).toEqual([]);
  });
});

describe('a hosted watch owns the route in every phase but standby', () => {
  test('a running hosted watch plans no pane watch beside it', async () => {
    const made = await baseline(null);
    const at = realpathSync(root);
    expect(await second(made, { daemonHealth: daemon(health({ roots: [route({ watch: hosted() })] })) })).toBe(0);
    expect(watchCreates(made)).toBe(0);
  });

  test('a stopped hosted watch stays authoritative', async () => {
    const made = await baseline(null);
    expect(await second(made, { daemonHealth: daemon(health({ roots: [route({ watch: hosted({ phase: 'stopped', why: 'stopped by the owner' }) })] })) })).toBe(0);
    expect(watchCreates(made)).toBe(0);
  });

  test('a standing-by hosted watch yields to a missing pane and one is started', async () => {
    const made = await baseline(null);
    expect(await second(made, { daemonHealth: daemon(health({ roots: [route({ watch: hosted({ phase: 'standby', why: 'a pane watch owns the session' }) })] })) })).toBe(0);
    expect(watchCreates(made)).toBe(1);
  });
});

describe('a daemon reading that cannot tell starts nothing', () => {
  test('an unknown reading with no record plans no pane watch', async () => {
    const made = await baseline(null);
    expect(await second(made, { daemonHealth: daemon(health({ state: 'unknown', running: null, roots: [], probe: { state: 'unknown', at: NOW.toISOString(), reason: 'unreadable state' }, why: 'unreadable state' })) })).toBe(0);
    expect(watchCreates(made)).toBe(0);
    expect(made.kills).toEqual([]);
  });

  test('an unknown reading with a stale live pane record neither repairs nor kills', async () => {
    const made = await baseline({ pid: 4242, heartbeat: OLD });
    expect(await second(made, { alive: (pid) => pid === 4242, daemonHealth: daemon(health({ state: 'unknown', running: null, roots: [], probe: { state: 'unknown', at: NOW.toISOString(), reason: 'unreadable state' }, why: 'unreadable state' })) })).toBe(0);
    expect(watchCreates(made)).toBe(0);
    expect(made.kills).toEqual([]);
  });

  test('an unknown reading leaves a live pane watch alone', async () => {
    const made = await baseline({ pid: 4242, heartbeat: FRESH });
    expect(await second(made, { alive: (pid) => pid === 4242, daemonHealth: daemon(health({ state: 'unknown', running: null, roots: [], probe: { state: 'unknown', at: NOW.toISOString(), reason: 'unreadable state' }, why: 'unreadable state' })) })).toBe(0);
    expect(watchCreates(made)).toBe(0);
  });
});
