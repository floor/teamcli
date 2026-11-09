// One watch per team, and it is the daemon's. `up` makes no watch pane and no workspace
// labelled Watch. A `team watch` in a pane only prints the daemon's watch for the session.
// A restore that finds the daemon's watch active clears a dead pane-watch record in one
// audit line. A pane that runs `team watch` beside a live daemon watch never owns it.
// An owner, a seat and an unqualified pane each leave the record alone. Status shows a live
// daemon's health. A dry run and a refused up write nothing. A cleanup that races a daemon
// taking the record over keeps the new live pid. Synthetic panes. The daemon reading is
// injected; no live daemon and no live CLI.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { approvalOf } from '../src/approve/approval.ts';
import { runStatus } from '../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { canonicalRoot } from '../src/daemon/routes.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { LOG_FILE, emptySession, readState, updateState } from '../src/state.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { unreadMachine } from '../src/watch/machine.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const SESSION = 'crate';
const PANE = 'pane-pebble';
const VIEW = 'pane-view';
const PID = 515;
const DEAD_PID = 404;
const LIVE_PID = 909;
const EPOCH = `watch_${'ab'.repeat(16)}`;
const NOW = new Date('2026-11-08T12:00:00.000Z');

const owned: string[] = [];
let priorHome: string | undefined;
let homeSet = false;

afterEach(() => {
  if (homeSet) {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    homeSet = false;
  }
  const paths = owned.splice(0);
  discardFixtures(paths, { roots: paths.map((path) => dirname(path)) });
});

type Held = { root: string; home: string; dir: string };

function world(): Held {
  const base = fixtureBase('daemon-only-watch-');
  owned.push(base);
  const root = join(base, 'crate');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (!homeSet) {
    priorHome = process.env.HOME;
    homeSet = true;
  }
  process.env.HOME = home;
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  const lobby = lobbyDir(home);
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  chmodSync(lobby, 0o700);
  const file = `format: 1
project: crate
coordinator: pebble
operator: pebble
session: ${SESSION}
workspace:
  mode: shared
trust:
  - ${JSON.stringify(lobby)}
  - ${JSON.stringify(root)}
seats:
  - role: coordinator
    name: pebble
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;
  writeFileSync(join(dir, 'team.yaml'), file);
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file },
    loaded.team.seats,
    home,
    NOW,
  );
  updateState(dir, (state) => {
    const session = state.sessions[SESSION] ?? (state.sessions[SESSION] = emptySession());
    session.seats.pebble = {
      stage: 'ready',
      pane: PANE,
      workspace: 'ws-pebble',
      launched: { shell: 100, cli: [200] },
    };
  });
  return { root, home, dir };
}

type CapturedSession = {
  seats: Record<string, Record<string, unknown>>;
  watch?: { pane?: string; heartbeat?: string; workspace?: string; pid?: number };
  launched_file?: string;
} & Record<string, unknown>;

function capturedSession(): CapturedSession {
  const parsed = JSON.parse(readFileSync(new URL('./fixtures/restore-real-state/real-session-shape.json', import.meta.url), 'utf8')) as {
    sessions: Record<string, CapturedSession>;
  };
  const session = Object.values(parsed.sessions)[0];
  if (session === undefined) throw new Error('the captured session is empty');
  return structuredClone(session);
}

function capturedWatch(): { pane: string; heartbeat: string; workspace: string } {
  const parsed = JSON.parse(readFileSync(new URL('./fixtures/restore-real-state/real-watch-records.json', import.meta.url), 'utf8')) as Record<
    string,
    { watch?: { pane?: string; heartbeat?: string; workspace?: string } }
  >;
  const watch = Object.values(parsed)[0]?.watch;
  if (watch?.pane === undefined || watch.heartbeat === undefined || watch.workspace === undefined) {
    throw new Error('the captured watch record has no pane');
  }
  return { pane: watch.pane, heartbeat: watch.heartbeat, workspace: watch.workspace };
}

function hostedHealth(root: string): DaemonHealth {
  const canonical = canonicalRoot(root);
  if (canonical === null) throw new Error('the fixture root cannot be resolved');
  return {
    daemon: 'teamcli',
    socket: 'socket-crate',
    state: 'running',
    running: true,
    pid: 7,
    uid: null,
    since: null,
    startedBy: null,
    version: '1',
    gitHead: null,
    heartbeatAt: NOW.toISOString(),
    heartbeatSeconds: 1,
    features: null,
    stuck: [],
    roots: [{
      root: canonical,
      team: 'crate',
      send: 'serving',
      bus: 'serving',
      why: null,
      watch: {
        routeId: 'route-crate',
        root: canonical,
        team: 'crate',
        session: SESSION,
        phase: 'running',
        startedAt: NOW.toISOString(),
        lastCycleAt: NOW.toISOString(),
        lastCycleOutcome: 'pass',
        cycles: 1,
        failures: 0,
        effects: 'open',
        required: true,
        why: null,
      },
    }],
    probe: { state: 'answered', at: NOW.toISOString() },
    why: null,
  };
}

function doctor(home: string): DoctorSources {
  return {
    version: () => '0.0.0-test',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.0.0-test',
    sessionRunning: () => true,
    now: () => NOW,
    home,
  };
}

function upHost(
  made: Held,
  labels: string[],
  commands: string[],
  health: DaemonHealth | null,
): UpSources {
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      labels.push(label);
      return { pane: 'pane-made', workspace: 'ws-made' };
    },
    paneRun(_session, _pane, command) {
      commands.push(command);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [PANE],
    agents: () => [{
      name: 'pebble', agent: 'claude', pane: PANE, workspace: 'ws-pebble', status: 'idle', cwd: made.root,
    }],
    paneText: () => 'ready\n',
    foreground: () => ['claude'],
    processInfo: (_session, pane) => (pane === PANE ? { shell: 100, foreground: [200] } : null),
    now: () => NOW,
    sleep: async () => {},
  };
  return {
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => [{
      name: 'pebble', agent: 'claude', pane: PANE, workspace: 'ws-pebble', status: 'idle', cwd: made.root,
    }],
    workspaces: () => [{ id: 'ws-pebble', label: 'pebble' }],
    home: made.home,
    doctor: doctor(made.home),
    launch,
    now: () => NOW,
    sleep: async () => {},
    alive: (_pid: number) => false,
    busAlive: async () => true,
    ...(health === null ? {} : { daemonHealth: async () => health }),
  };
}

type WatchRecord = { pane?: string; pid?: number; watchdog?: string };

function watchRecord(dir: string): WatchRecord {
  const session = readState(dir).sessions[SESSION];
  return {
    ...(session?.watch?.pane === undefined ? {} : { pane: session.watch.pane }),
    ...(session?.watch?.pid === undefined ? {} : { pid: session.watch.pid }),
    ...(session?.watchdog?.pane === undefined ? {} : { watchdog: session.watchdog.pane }),
  };
}

type PaneWatchSources = WatchSources & {
  daemonHealth?: (home: string) => Promise<DaemonHealth>;
};

function paneWatch(made: Held, shots: WatchRecord[]): PaneWatchSources {
  return {
    live: () => null,
    machine: () => unreadMachine(),
    standing: (root) => approvalStanding(root, made.home),
    readChecks: () => [],
    screen: () => null,
    status: () => null,
    foreground: () => null,
    typeText: () => false,
    pressEnter: () => false,
    sleep: async () => {},
    notify: () => {},
    now: () => NOW,
    wait: async () => {
      shots.push(watchRecord(made.dir));
      return false;
    },
    alive: () => false,
    pid: PID,
    ownPane: () => ({ pane: VIEW, workspace: 'ws-view' }),
    home: made.home,
    daemonHealth: async () => hostedHealth(made.root),
  };
}

function daemonLine(text: string): boolean {
  return text.split('\n').some((line) => line.includes('running in the daemon') && line.includes(SESSION));
}

test('team up creates no watch pane and no workspace labelled Watch', async () => {
  const made = world();
  const labels: string[] = [];
  const commands: string[] = [];
  const io = testIo(made.root, { kind: 'owner' });
  expect(await runUp([], io, upHost(made, labels, commands, null)), `${io.out}\n${io.err}`).toBe(0);
  expect(labels.some((label) => label.includes('Watch'))).toBe(false);
  expect(commands.some((command) => command.includes('team watch'))).toBe(false);
});

test('a pane watch prints the daemon watch for the session and writes nothing', async () => {
  const made = world();
  const before = watchRecord(made.dir);
  const shots: WatchRecord[] = [];
  const io = testIo(made.root, { kind: 'pane', pane: VIEW, session: SESSION });
  const code = await runWatch([], io, paneWatch(made, shots));
  expect(code, `${io.out}\n${io.err}`).toBe(0);
  expect(daemonLine(io.out), io.out).toBe(true);
  expect(shots.every((shot) => JSON.stringify(shot) === JSON.stringify(before))).toBe(true);
  expect(watchRecord(made.dir)).toEqual(before);
  expect(readState(made.dir).sessions[SESSION]?.watchdog).toBeUndefined();
});

test('a restore clears a dead pane watch once the daemon watch is active', async () => {
  const made = world();
  const watch = capturedWatch();
  const shape = capturedSession();
  const pebble = structuredClone(Object.values(shape.seats).find((seat) => seat.stage === 'ready') ?? {});
  delete pebble.agent_session;
  pebble.stage = 'ready';
  pebble.pane = PANE;
  pebble.workspace = 'ws-pebble';
  pebble.launched = { shell: 100, cli: [200] };
  pebble.cli = 'claude-code';
  pebble.launch_line = 'claude';
  shape.seats.pebble = pebble;
  shape.watch = { ...watch, pid: DEAD_PID, heartbeat: '2020-01-01T00:00:00.000Z' };
  shape.launched_file = join(made.dir, 'team.yaml');
  updateState(made.dir, (state) => {
    state.sessions[SESSION] = shape as never;
  });
  const health = hostedHealth(made.root);
  const labels: string[] = [];
  const commands: string[] = [];
  let priorLog = '';
  try {
    priorLog = readFileSync(join(made.dir, LOG_FILE), 'utf8');
  } catch {
    priorLog = '';
  }
  const io = testIo(made.root, { kind: 'owner' });
  expect(await runUp([], io, upHost(made, labels, commands, health)), `${io.out}\n${io.err}`).toBe(0);
  const hosted = health.roots[0]?.watch;
  expect(hosted?.phase).toBe('running');
  expect(hosted?.session).toBe(SESSION);
  expect(labels.some((label) => label.includes('Watch'))).toBe(false);
  expect(commands.some((command) => command.includes('team watch'))).toBe(false);
  const left = readState(made.dir).sessions[SESSION]?.watch;
  expect(left?.pane).toBeUndefined();
  expect(left?.pid).toBeUndefined();
  let log = '';
  try {
    log = readFileSync(join(made.dir, LOG_FILE), 'utf8');
  } catch {
    log = '';
  }
  const added = log.slice(priorLog.length).split('\n').filter((line) => /clear/i.test(line) && line.includes(watch.pane));
  expect(added, log).toHaveLength(1);
});

test('a pane watch does not become the owner while the daemon watch is live', async () => {
  const made = world();
  const shots: WatchRecord[] = [];
  const sources = paneWatch(made, shots);
  const waitBound = 2;
  let waits = 0;
  sources.wait = async () => {
    waits += 1;
    shots.push(watchRecord(made.dir));
    if (waits > waitBound) {
      throw new Error(`the watch kept waiting after ${waitBound} passes; a live daemon watch must stop the pane watch`);
    }
    return false;
  };
  const io = testIo(made.root, { kind: 'pane', pane: VIEW, session: SESSION });
  const code = await runWatch([], io, sources);
  expect(code, `${io.out}\n${io.err}`).toBe(0);
  const seen = [...shots, watchRecord(made.dir)];
  for (const shot of seen) {
    expect(shot.pane).not.toBe(VIEW);
    expect(shot.pid).not.toBe(PID);
    expect(shot.watchdog).not.toBe(VIEW);
  }
});

function sessionText(dir: string): string {
  return JSON.stringify(readState(dir).sessions[SESSION]);
}

function logText(dir: string): string {
  try {
    return readFileSync(join(dir, LOG_FILE), 'utf8');
  } catch {
    return '';
  }
}

function deadPaneWatch(made: Held): void {
  updateState(made.dir, (state) => {
    const session = state.sessions[SESSION] ?? (state.sessions[SESSION] = emptySession());
    session.watch = {
      pane: 'pane-watch-1',
      pid: DEAD_PID,
      heartbeat: '2020-01-01T00:00:00.000Z',
      workspace: 'ws-1',
    };
  });
}

test('an owner, a seat and an unqualified pane each running team watch start no pane watch and write no state', async () => {
  const made = world();
  const before = sessionText(made.dir);
  const callers = [
    { kind: 'owner' as const },
    { kind: 'seat' as const, name: 'pebble', pane: PANE, session: SESSION },
    { kind: 'pane' as const, pane: 'pane-open' },
  ];
  for (const caller of callers) {
    const labels: string[] = [];
    const commands: string[] = [];
    const shots: WatchRecord[] = [];
    const sources = paneWatch(made, shots);
    sources.createWorkspace = (_session, _cwd, label) => {
      labels.push(label);
      return { pane: 'pane-made', workspace: 'ws-made' };
    };
    sources.paneRun = (_session, _pane, command) => {
      commands.push(command);
      return true;
    };
    const io = testIo(made.root, caller);
    const code = await runWatch([], io, sources);
    expect(code, `${caller.kind}\n${io.out}\n${io.err}`).toBe(0);
    expect(labels, caller.kind).toEqual([]);
    expect(commands, caller.kind).toEqual([]);
    expect(shots, caller.kind).toEqual([]);
  }
  expect(sessionText(made.dir)).toBe(before);
});

test('a live daemon is shown on status and its health is not masked', async () => {
  const made = world();
  const health = hostedHealth(made.root);
  const io = testIo(made.root, { kind: 'owner' });
  const code = await runStatus([], io, {
    live: () => ({
      running: true,
      agents: [{ name: 'pebble', agent: 'claude', pane: PANE, workspace: 'ws-pebble', status: 'idle', cwd: made.root }],
      workspaces: [{ id: 'ws-pebble', label: 'pebble' }],
      screens: { [PANE]: 'ready\n' },
      processes: { [PANE]: { shell: 100, foreground: [200] } },
    }),
    branch: () => 'main',
    standing: (root) => approvalStanding(root, made.home),
    now: () => NOW,
    home: made.home,
    alive: () => true,
    daemonHealth: async () => health,
  });
  const text = `${io.out}\n${io.err}`;
  expect(code, text).not.toBe(2);
  expect(text).toContain('machine daemon: running');
  expect(text).toContain(`watch: running in the daemon since ${health.roots[0]?.watch?.startedAt}`);
  expect(text).not.toContain('does not host');
  expect(text).not.toContain('[masked]');
});

test('a dry run and a refused up write no state and no audit line', async () => {
  const made = world();
  deadPaneWatch(made);
  const before = sessionText(made.dir);
  const beforeLog = logText(made.dir);
  const health = hostedHealth(made.root);
  const labels: string[] = [];
  const commands: string[] = [];
  const dry = testIo(made.root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, upHost(made, labels, commands, health)), `${dry.out}\n${dry.err}`).toBe(0);
  expect(sessionText(made.dir)).toBe(before);
  expect(logText(made.dir)).toBe(beforeLog);
  const refused = testIo(made.root, { kind: 'owner-no-tty' });
  const code = await runUp([], refused, upHost(made, labels, commands, health));
  expect(code, `${refused.out}\n${refused.err}`).not.toBe(0);
  expect(sessionText(made.dir)).toBe(before);
  expect(logText(made.dir)).toBe(beforeLog);
});

test('a cleanup racing a daemon that has just taken over keeps the new live pid', async () => {
  const made = world();
  deadPaneWatch(made);
  const labels: string[] = [];
  const commands: string[] = [];
  const host = upHost(made, labels, commands, hostedHealth(made.root));
  host.alive = (pid: number) => pid === LIVE_PID;
  host.daemonHealth = async () => {
    updateState(made.dir, (state) => {
      const session = state.sessions[SESSION];
      if (session?.watch === undefined) return;
      session.watch.pid = LIVE_PID;
      session.watch.epoch = EPOCH;
      session.watch.heartbeat = NOW.toISOString();
      session.watch.pane = 'pane-daemon';
    });
    return hostedHealth(made.root);
  };
  const priorLog = logText(made.dir);
  const io = testIo(made.root, { kind: 'owner' });
  expect(await runUp([], io, host), `${io.out}\n${io.err}`).toBe(0);
  const left = readState(made.dir).sessions[SESSION]?.watch;
  expect(left?.pid).toBe(LIVE_PID);
  expect(left?.epoch).toBe(EPOCH);
  expect(left?.pane).toBe('pane-daemon');
  const added = logText(made.dir).slice(priorLog.length);
  expect(added.includes('cleared pane watch')).toBe(false);
});

const DOCTOR_REPAIR = 'run `team daemon status`, or the lead runs `team daemon install`';

async function doctorText(made: Held, health: DaemonHealth | null): Promise<string> {
  const io = testIo(made.root, { kind: 'owner' });
  const code = await runDoctor(['--file', '.agents/team.yaml'], io, {
    ...doctor(made.home),
    ...(health === null ? {} : { daemonHealth: async () => health }),
  });
  return `exit ${code}\n${io.out}${io.err}`;
}

test('a daemon hosting the watch is the watch, and a stale record or another host is a miss', async () => {
  const made = world();
  const hosted = await doctorText(made, hostedHealth(made.root));
  expect(hosted).toContain('ok    the watch is running in the daemon\n');
  expect(hosted).not.toContain('no watch has run for session');

  const other = hostedHealth(made.root);
  const otherWatch = other.roots[0]?.watch;
  if (otherWatch === undefined) throw new Error('the fixture daemon hosts no watch');
  otherWatch.session = 'other-session';
  const elsewhere = await doctorText(made, other);
  expect(elsewhere).toContain(`MISS  no watch has run for session ${SESSION}: ${DOCTOR_REPAIR}\n`);
  expect(elsewhere).not.toContain('the watch is running in the daemon');

  const down = hostedHealth(made.root);
  down.state = 'not-running';
  down.running = false;
  down.roots = [];
  const stopped = await doctorText(made, down);
  expect(stopped).toContain(`MISS  no watch has run for session ${SESSION}: ${DOCTOR_REPAIR}\n`);

  const absent = await doctorText(made, null);
  expect(absent).toContain(`MISS  no watch has run for session ${SESSION}: ${DOCTOR_REPAIR}\n`);

  updateState(made.dir, (state) => {
    const session = state.sessions[SESSION] ?? (state.sessions[SESSION] = emptySession());
    session.watch = { pid: 1, heartbeat: new Date(NOW.getTime() - 300_000).toISOString(), pane: 'pane-old' };
  });
  const stale = await doctorText(made, hostedHealth(made.root));
  expect(stale).toContain(`MISS  the watch's heartbeat is 5 min old (two intervals are 4 min): ${DOCTOR_REPAIR}\n`);
  expect(stale).not.toContain('the watch is running in the daemon');
});
