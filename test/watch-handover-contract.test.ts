// A pane watch recorded with an old heartbeat is not replaced by another pane. The daemon's
// hosted watch is the watch: `up` opens no watch pane and never signals a pid it cannot prove
// is the watch. A dead pane record is cleared once the daemon hosts this session. These scenes
// drive the real `runUp` over a scratch root, a controlled clock and a fake terminal host that
// only records what was asked of it: no pane, service, owner home or live watch is touched.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { type Launch, runUp, type UpSources } from '../src/commands/up.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { PaneProcesses } from '../src/herdr.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import type { HostedWatchState } from '../src/watch/hosted.ts';
import { testIo } from './helpers.ts';

const SESSION = 'handover';
const NOW = new Date('2026-10-14T09:30:00Z');
/** The pid the stale record names. Nothing in this file ever signals a real process. */
const STALE_PID = 6412;
const WATCH_LABEL = 'Watch · handover-lab';
const WATCH_COMMAND = 'handover-watch-command';
const OLD_BEAT = new Date(NOW.getTime() - 10 * 60_000).toISOString();
const STALE_PANE = 'w7:p1';
const STALE_WORKSPACE = 'w7';

let base: string;
let root: string;
let home: string;

function teamText(): string {
  return `format: 1
project: handover-lab
session: ${SESSION}
coordinator: handover-lead
operator: handover-lead
trust:
  - ${join(home, '.config', 'team', 'lobby')}
  - ${root}
workspace:
  mode: shared
watch:
  interval: 120s
seats:
  - role: coordinator
    name: handover-lead
    label: handover-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    human: true
`;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 't2-s0-handover-')));
  root = join(base, 'handover-lab');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText());
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Writes the watch record the scene is about, as a previous run would have left it. */
function recorded(watch: { pid?: number; heartbeat: string; pane?: string; workspace?: string } | null): void {
  updateState(join(root, '.agents'), (state) => {
    const session = emptySession();
    if (watch !== null) session.watch = watch;
    state.sessions[SESSION] = { ...session, started: { at: OLD_BEAT, by: 'owner' } };
  });
}

function health(over: Partial<DaemonHealth>): DaemonHealth {
  return {
    daemon: 'teamcli',
    socket: join(home, 'daemon.sock'),
    state: 'running',
    running: true,
    pid: 8123,
    uid: 501,
    since: '2026-10-14T08:00:00Z',
    startedBy: 'service-manager',
    version: '0.5.4',
    gitHead: null,
    heartbeatAt: '2026-10-14T09:29:58Z',
    heartbeatSeconds: null,
    features: null,
    stuck: [],
    roots: [],
    probe: { state: 'answered', at: NOW.toISOString() },
    why: null,
    ...over,
  };
}

function hostedWatch(): HostedWatchState {
  const canonical = realpathSync(root);
  return {
    routeId: 'route-handover',
    root: canonical,
    team: 'handover-lab',
    session: SESSION,
    phase: 'running',
    startedAt: '2026-10-14T08:00:00Z',
    lastCycleAt: '2026-10-14T09:29:00Z',
    lastCycleOutcome: 'pass',
    cycles: 4,
    failures: 0,
    effects: 'open',
    required: true,
    why: null,
  };
}

/** The daemon hosts this session's watch. `up` reads this and opens no pane watch beside it. */
const hostedDaemon = async () => health({
  roots: [{
    root: realpathSync(root),
    team: 'handover-lab',
    send: 'serving',
    bus: 'serving',
    why: null,
    watch: hostedWatch(),
  }],
});
const unknownDaemon = async () =>
  health({
    state: 'unknown',
    running: null,
    pid: null,
    probe: { state: 'unknown', at: NOW.toISOString(), reason: 'the record could not be read' },
    why: 'the record could not be read',
  });

type Liveness = {
  /** The pane's process identity when the run reads it. Null models an unreadable pane. */
  identity?: PaneProcesses | null;
  /** Whether the signal is accepted by the host (delivery only: it says nothing about exit). */
  accepted?: boolean;
  /** How many times the process is still observed alive after an accepted signal. Absent: forever. */
  aliveReadsAfterSignal?: number;
};

type Host = {
  launch: Launch;
  kills: number[];
  creates: string[];
  runs: { pane: string; command: string }[];
  /** Makes the recorded process disappear between two runs, as an exit after a hold would. */
  gone: boolean;
  alive(pid: number): boolean;
};

function world(options: Liveness): Host {
  const made: Host = { launch: {} as Launch, kills: [], creates: [], runs: [], gone: false, alive: () => false };
  let n = 0;
  let clock = NOW.getTime();
  let delivered = false;
  let readsAfterSignal = 0;
  const panes = new Map<string, { text: string; running: boolean }>();
  const identity = options.identity === undefined ? { shell: 9001, foreground: [STALE_PID] } : options.identity;
  made.launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      n += 1;
      const pane = `w${String(n)}:p1`;
      panes.set(pane, { text: '', running: false });
      made.creates.push(label);
      return { pane, workspace: `w${String(n)}` };
    },
    paneRun(_session, pane, command) {
      const known = panes.get(pane);
      if (known) known.running = true;
      made.runs.push({ pane, command });
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.running).map(([pane]) => pane),
    agents: () => [],
    workspacePanes: (_session, workspace) => [...panes.keys()].filter((pane) => pane.startsWith(`${workspace}:`)),
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude'],
    processInfo: () => identity,
    focus: () => true,
    deleteSession: () => true,
    kill(pid: number) {
      made.kills.push(pid);
      const accepted = options.accepted ?? true;
      if (accepted) delivered = true;
      return accepted;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  } as Launch;
  made.alive = (pid: number): boolean => {
    if (pid !== STALE_PID) return false;
    if (made.gone) return false;
    if (!delivered) return true;
    readsAfterSignal += 1;
    const allowed = options.aliveReadsAfterSignal;
    if (allowed === undefined) return true;
    return readsAfterSignal <= allowed;
  };
  return made;
}

function sources(made: Host, daemon: () => Promise<DaemonHealth>): UpSources {
  const loaded = loadTeamFile(root, { file: '.agents/team.yaml', home });
  if (!loaded.ok) throw new Error(`the authored team file did not load: ${loaded.errors.map((one) => one.message).join('; ')}`);
  return {
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [{ id: STALE_WORKSPACE, label: WATCH_LABEL }],
    home,
    // The run's clock starts at the scene's instant and moves with the sleep the run asks for, so
    // a bounded exit wait sees time pass instead of a frozen reading.
    now: made.launch.now,
    sleep: made.launch.sleep,
    alive: (pid) => made.alive(pid),
    watchCommand: () => WATCH_COMMAND,
    daemonHealth: daemon,
    standing: () => verifiedOf(loaded.team, loaded.path, root, NOW),
    machine: () => ({
      loadPerCore: 0.2,
      memoryFree: 80,
      diskFree: 200e9,
      swapTotal: 10e9,
      swapFree: 9e9,
      swapUsed: 1e9,
    }),
    launch: made.launch,
  } as UpSources;
}

async function up(made: Host, daemon: () => Promise<DaemonHealth>): Promise<{ code: number; out: string }> {
  const io = testIo(root, { kind: 'owner' });
  const code = await runUp(['--file', '.agents/team.yaml'], io, sources(made, daemon));
  return { code, out: io.out + io.err };
}

/** Starts one run's worth of counting over again, for a scene with two runs. */
function fresh(made: Host): void {
  made.kills.length = 0;
  made.creates.length = 0;
  made.runs.length = 0;
}

const watchRuns = (made: Host) => made.runs.filter((one) => one.command === WATCH_COMMAND);
const watchWorkspaces = (made: Host) => made.creates.filter((label) => label === WATCH_LABEL);

function watchRecord(): { pane?: string; pid?: number; heartbeat?: string } | undefined {
  return readState(join(root, '.agents')).sessions[SESSION]?.watch;
}

function teamLog(): string {
  try {
    return readFileSync(join(root, '.agents/team.log'), 'utf8');
  } catch {
    return '';
  }
}

describe('a stale pane watch is not replaced by another pane', () => {
  test('a live record is left in place and no watch pane is opened', async () => {
    recorded({ pid: STALE_PID, heartbeat: OLD_BEAT, pane: STALE_PANE, workspace: STALE_WORKSPACE });
    const made = world({ accepted: false });
    const reading = await hostedDaemon();
    expect(reading.roots[0]?.watch).toMatchObject({ session: SESSION, phase: 'running' });
    const first = await up(made, async () => reading);

    expect(first.code).toBe(0);
    expect(made.kills).toEqual([]);
    expect(watchRuns(made)).toEqual([]);
    expect(watchWorkspaces(made)).toEqual([]);
    expect(first.out).not.toContain('watch: started');
    expect(watchRecord()).toMatchObject({ pid: STALE_PID, pane: STALE_PANE });
  });

  test('a live process is left until it is gone, and the daemon then keeps the watch', async () => {
    recorded({ pid: STALE_PID, heartbeat: OLD_BEAT, pane: STALE_PANE, workspace: STALE_WORKSPACE });
    const made = world({ accepted: true });
    const first = await up(made, hostedDaemon);

    expect(first.code).toBe(0);
    expect(made.kills).toEqual([]);
    expect(watchRuns(made)).toEqual([]);
    expect(watchWorkspaces(made)).toEqual([]);
    expect(watchRecord()).toMatchObject({ pid: STALE_PID, pane: STALE_PANE });

    // The process is gone. The next run clears the dead pane record and opens no replacement pane.
    made.gone = true;
    fresh(made);
    const second = await up(made, hostedDaemon);
    expect(second.code).toBe(0);
    expect(made.kills).toEqual([]);
    expect(watchRuns(made)).toEqual([]);
    expect(watchWorkspaces(made)).toEqual([]);
    expect(second.out).not.toContain('watch: started');
    expect(watchRecord()?.pane).toBeUndefined();
    expect(watchRecord()?.pid).toBeUndefined();
    expect(teamLog()).toContain(`cleared pane watch ${STALE_PANE}: the daemon hosts this session's watch`);
  });

  test('a process that is already gone is cleared once and no replacement pane is started', async () => {
    recorded({ pid: STALE_PID, heartbeat: OLD_BEAT, pane: STALE_PANE, workspace: STALE_WORKSPACE });
    const made = world({ accepted: true });
    made.gone = true;
    const run = await up(made, hostedDaemon);

    expect(run.code).toBe(0);
    expect(made.kills).toEqual([]);
    expect(watchRuns(made)).toEqual([]);
    expect(watchWorkspaces(made)).toEqual([]);
    expect(run.out).not.toContain('watch: started');
    expect(watchRecord()?.pane).toBeUndefined();
    expect(watchRecord()?.pid).toBeUndefined();
    expect(teamLog()).toContain(`cleared pane watch ${STALE_PANE}: the daemon hosts this session's watch`);
  });
});

describe('a pid whose identity is not proven is never signaled', () => {
  test('a live pid that is not the pane\'s watch process is left alone', async () => {
    recorded({ pid: STALE_PID, heartbeat: OLD_BEAT, pane: STALE_PANE, workspace: STALE_WORKSPACE });
    const made = world({ identity: { shell: 9001, foreground: [1731] } });
    await up(made, hostedDaemon);

    expect(made.kills).toEqual([]);
    expect(watchWorkspaces(made)).toEqual([]);
    expect(watchRecord()).toMatchObject({ pid: STALE_PID, pane: STALE_PANE });
  });

  test('an unreadable pane identity is not signaled', async () => {
    recorded({ pid: STALE_PID, heartbeat: OLD_BEAT, pane: STALE_PANE, workspace: STALE_WORKSPACE });
    const made = world({ identity: null });
    await up(made, hostedDaemon);

    expect(made.kills).toEqual([]);
    expect(watchWorkspaces(made)).toEqual([]);
    expect(watchRecord()).toMatchObject({ pid: STALE_PID, pane: STALE_PANE });
  });
});

describe('a daemon reading that cannot say holds the pane watch', () => {
  test('an unknown reading neither kills the stale pid nor starts a replacement', async () => {
    recorded({ pid: STALE_PID, heartbeat: OLD_BEAT, pane: STALE_PANE, workspace: STALE_WORKSPACE });
    const made = world({});
    await up(made, unknownDaemon);

    expect(made.kills).toEqual([]);
    expect(watchRuns(made)).toEqual([]);
    expect(watchWorkspaces(made)).toEqual([]);
    expect(watchRecord()).toMatchObject({ pid: STALE_PID, pane: STALE_PANE });
  });
});
