// S0a acceptance: once the machine daemon's hosted watch owns a route, `up` closes every legacy
// `Watch · <team>` workspace whose panes hold no live process, and leaves alone a workspace a
// process still holds, a workspace that cannot be read, and every workspace when no hosted watch
// owns the route. A dry run says what it would close and closes nothing. The fake Launch records
// workspace creates, closes and kills; no pane, owner home or live service is touched.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../src/approve/command.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import type { DaemonRootState } from '../src/daemon/state.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { PaneProcesses } from '../src/herdr.ts';
import type { HostedWatchState } from '../src/watch/hosted.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

// The synthetic roster names the model shown by the shared idle capture for every fake CLI.
const EXAMPLE = readFileSync(join(import.meta.dir, 'fixtures/example.yaml'), 'utf8')
  .replace('parked: true', 'stopped: true')
  .replace('vendor: deepseek', 'vendor: anthropic')
  .replace('model: DeepSeek Flash', 'model: Claude Opus')
  .replace('version: "V4.1"', 'version: "5.5"')
  .replace('display: DeepSeek V4.1 Flash', 'display: Claude Opus 5.5')
  .replace('launch: team-deepseek', 'launch: claude --model claude-opus-5-5');
const FILE = ['--file', '.agents/team.yaml'];
const NOW = new Date('2026-10-03T14:02:00Z');
const SESSION = 'acme-web';
const WATCH_LABEL = 'Watch · acme-web';

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'b2-up-daemon-watch-')));
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
  closes: string[];
  kills: number[];
  session: 'absent' | 'running';
  processes: Map<string, PaneProcesses>;
  unreadable: Set<string>;
  /** The workspaces the fake terminal host still knows, by id and label, in creation order. */
  list(): { id: string; label: string }[];
  /** The workspace id and pane a label was created under. */
  place(label: string): { workspace: string; pane: string } | null;
};

function world(): World {
  const state: World = {
    launch: {} as Launch,
    creates: [],
    closes: [],
    kills: [],
    session: 'absent',
    processes: new Map(),
    unreadable: new Set(),
    list: () => [...spaces].map(([id, label]) => ({ id, label })),
    place(label) {
      for (const [id, text] of spaces) {
        if (text !== label) continue;
        const pane = [...panes.keys()].find((one) => one.startsWith(`${id}:`)) ?? null;
        return pane === null ? null : { workspace: id, pane };
      }
      return null;
    },
  };
  let clock = NOW.getTime();
  let n = 0;
  let foreground = 1000;
  const panes = new Map<string, { text: string; agent: boolean; workspace: string; name: string | null }>();
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
      const pane = `fixture${String(n)}:p1`;
      panes.set(pane, { text: CLAUDE_IDLE, agent: false, workspace: `fixture${String(n)}`, name: null });
      spaces.set(`fixture${String(n)}`, label);
      state.creates.push(label);
      return { pane, workspace: `fixture${String(n)}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (!known) return false;
      known.agent = true;
      foreground += 1;
      state.processes.set(pane, { shell: 900, foreground: [900, foreground] });
      return true;
    },
    renameAgent(_session, pane, name) {
      const known = panes.get(pane);
      if (known) known.name = name;
      return true;
    },
    closeWorkspace(_session, workspace) {
      state.closes.push(workspace);
      spaces.delete(workspace);
      for (const pane of [...panes.keys()]) if (pane.startsWith(`${workspace}:`)) panes.delete(pane);
      return true;
    },
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [...panes].flatMap(([id, pane]) => pane.name === null ? [] : [agent(pane.name, id)]),
    workspacePanes: (_session, workspace) => state.unreadable.has(workspace)
      ? null
      : [...panes.keys()].filter((pane) => pane.startsWith(`${workspace}:`)),
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    processInfo: (_session, pane) => state.processes.get(pane) ?? null,
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
    workspaces: () => made.list(),
    home,
    now: made.launch.now,
    sleep: made.launch.sleep,
    launch: made.launch,
    ...extra,
  };
}

const statePath = () => join(root, '.agents/team.state.json');

const alive = () => [
  agent('claude-coordinator-acme', 'fixture1:p1'),
  agent('deepseek-acme', 'fixture2:p1'),
  agent('deepseek-acme-2', 'fixture3:p1'),
];

/** An approved first run, which plans and starts the pane watch in its own workspace. */
async function baseline(): Promise<World> {
  await approve();
  const made = world();
  expect(await runUp(FILE, testIo(root, { kind: 'owner' }), sources({}, made))).toBe(0);
  return made;
}

/** Drops the pane watch's record, as a watch that exited leaves it. */
function forgetPaneWatch(): void {
  const seeded = JSON.parse(readFileSync(statePath(), 'utf8')) as {
    sessions: Record<string, { watch?: unknown }>;
  };
  delete seeded.sessions[SESSION]!.watch;
  writeFileSync(statePath(), JSON.stringify(seeded));
}

/** The pane that runs the watch (or held it before it exited). */
function watchPane(made: World): string {
  const place = made.place(WATCH_LABEL);
  if (place === null) throw new Error('the baseline started no watch workspace');
  return place.pane;
}

/** A second run with every seat already standing, as the two-run scenes run it. */
async function second(
  made: World,
  extra: Partial<UpSources>,
  args: string[] = FILE,
  io = testIo(root, { kind: 'owner' }),
): Promise<{ code: number; io: ReturnType<typeof testIo> }> {
  made.launch.agents = alive;
  made.creates.length = 0;
  made.closes.length = 0;
  made.kills.length = 0;
  const code = await runUp(args, io, sources({
    sessionState: () => 'running',
    agents: alive,
    ...extra,
  }, made));
  return { code, io };
}

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
    gitHead: null,
    heartbeatAt: '2026-10-03T14:01:58Z',
    heartbeatSeconds: null,
    features: { broker: 'absent' },
    stuck: [],
    roots: [],
    probe: { state: 'answered', at: NOW.toISOString() },
    why: null,
    ...over,
  };
}

const daemon = (reading: DaemonHealth) => async () => reading;
const hostedDaemon = () => daemon(health({ roots: [route({ watch: hosted() })] }));

const teamLog = () => readFileSync(join(root, '.agents/team.log'), 'utf8');

describe('a hosted watch closes the legacy watch workspace it replaced', () => {
  test('a workspace whose process is gone is closed once, and the log says so', async () => {
    const made = await baseline();
    const place = made.place(WATCH_LABEL);
    if (place === null) throw new Error('the baseline started no watch workspace');
    // The pane watch exited and its shell came back: the pane holds no process of its own.
    made.processes.set(place.pane, { shell: 900, foreground: [900] });
    const { code, io } = await second(made, { daemonHealth: hostedDaemon() });
    expect(code).toBe(0);
    expect(made.closes).toEqual([place.workspace]);
    expect(`${io.out}${io.err}`).toContain('team up: closed 1 legacy watch workspace with no live process');
    expect(teamLog()).toContain('closed 1 legacy watch workspace with no live process');
    expect(made.creates).toEqual([]);
  });

  test('a workspace a process still holds is left for the hand-over', async () => {
    const made = await baseline();
    const pane = watchPane(made);
    made.processes.set(pane, { shell: 900, foreground: [900, 7777] });
    const { code, io } = await second(made, { daemonHealth: hostedDaemon() });
    expect(code).toBe(0);
    expect(made.closes).toEqual([]);
    expect(`${io.out}${io.err}`).not.toContain('legacy watch workspace');
  });

  test('a workspace whose panes cannot be read is left alone', async () => {
    const made = await baseline();
    const place = made.place(WATCH_LABEL);
    if (place === null) throw new Error('no watch workspace');
    made.unreadable.add(place.workspace);
    const { code } = await second(made, { daemonHealth: hostedDaemon() });
    expect(code).toBe(0);
    expect(made.closes).toEqual([]);
  });

  test('no hosted watch owns the route: a pane sitting closes nothing', async () => {
    const made = await baseline();
    forgetPaneWatch();
    made.processes.set(watchPane(made), { shell: 900, foreground: [900] });
    const { code } = await second(made, {});
    expect(code).toBe(0);
    expect(made.closes).toEqual([]);
  });

  test('a dry run says what it would close and closes nothing', async () => {
    const made = await baseline();
    forgetPaneWatch();
    made.processes.set(watchPane(made), { shell: 900, foreground: [900] });
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp([...FILE, '--dry-run'], io, sources({ daemonHealth: hostedDaemon() }, made));
    expect(code).toBe(0);
    expect(made.closes).toEqual([]);
    expect(io.out).toContain(
      "watch: the machine daemon hosts this route's watch; 1 legacy watch workspace with no live process would be closed",
    );
  });
});
