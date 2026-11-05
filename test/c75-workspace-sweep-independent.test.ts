// Independent verification of C7.5 item 3: vacated workspaces are swept, and a team keeps one Bus
// (src/commands/up.ts, src/commands/remove.ts, src/launch/plan.ts, src/launch/execute.ts).
//
// The terminal host, its process table and its screens are synthetic. No live host, CLI, or
// process signal is invoked.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { realSources as downSources } from '../src/commands/down.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState, type SeatState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { busLabel } from '../src/watch/pane.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T09:30:00Z');
const SESSION = 'acme';
const LEAD = 'lead';
const WORKER = 'worker';
const HANDLE = 'seat_0123456789ab';
const SES = 'ses_a1b2c3d4e5f6';
const PANE = 'fixture-pane-one';
const SPACE = 'fixture-space';
const NEW_PANE = 'fixture-pane-new';
const NEW_SPACE = 'fixture-space-new';
const OTHER_PANE = 'fixture-pane-other';
const OTHER_SPACE = 'fixture-space-other';
const HUMAN_PANE = 'fixture-pane-human';
const HUMAN_SPACE = 'fixture-space-human';
const WATCH_PANE = 'fixture-watch-pane';
const RECORDED = { shell: 100, cli: [200] };
const LAUNCH = 'claude --model claude-sonnet-5-5';
const BUS = busLabel('acme');
const BUS_ONE = 'fixture-bus-space-one';
const BUS_PANE_ONE = 'fixture-bus-pane-one';
const BUS_TWO = 'fixture-bus-space-two';
const BUS_PANE_TWO = 'fixture-bus-pane-two';
const WORKING = readFileSync(new URL('./fixtures/claude-code/2.1.302/working.txt', import.meta.url), 'utf8');
const UNSENT = claudeBox('draft line');

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function teamText(worker: 'declared' | 'stopped' | 'absent'): string {
  const seat = worker === 'absent'
    ? ''
    : `  - role: implementer
    name: ${WORKER}
    label: ${WORKER}
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: ${LAUNCH}
${worker === 'stopped' ? '    stopped: true\n' : ''}`;
  return `format: 1
project: acme
coordinator: ${LEAD}
operator: ${LEAD}
session: ${SESSION}
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${LEAD}
    label: ${LEAD}
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
    human: true
${seat}`;
}

function setup(worker: 'declared' | 'stopped' | 'absent'): void {
  const text = teamText(worker);
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
}

function seedWatch(): void {
  updateState(dir, (file) => {
    const session = (file.sessions[SESSION] ??= emptySession());
    session.watch = { heartbeat: NOW.toISOString(), pane: WATCH_PANE };
  });
}

function recordReady(seat: string = WORKER, pane: string = PANE, workspace: string = SPACE): void {
  const held: SeatState = {
    stage: 'ready',
    id: HANDLE,
    pane,
    workspace,
    launched: RECORDED,
    agent_session: SES,
    model: 'Claude Sonnet',
    version: '5.5',
    launch_line: LAUNCH,
  };
  updateState(dir, (file) => {
    const session = (file.sessions[SESSION] ??= emptySession());
    session.seats[seat] = held;
  });
  if (seat !== WORKER) return;
  registerAgent(home, {
    name: WORKER,
    signing: { model: 'Claude Sonnet', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: LAUNCH,
    reach: { team: teamIdOf(root), seat: WORKER, session: SESSION, pane, address: null, agent_session: SES },
    seat_handle: HANDLE,
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

const seatState = (seat: string = WORKER): SeatState | undefined => readState(dir).sessions[SESSION]?.seats[seat];
const said = (io: { out: string; err: string }): string => `${io.out}${io.err}`;

type PaneSeed = {
  workspace?: string;
  name?: string | null;
  session?: string | null;
  status?: string;
  screen?: string;
  process: { shell: number; foreground: number[] } | null;
};

type Trace = { created: string[]; closed: string[]; runs: { pane: string; command: string }[]; events: string[] };

function makeWorld(input: {
  panes: Record<string, PaneSeed>;
  labels?: Record<string, string>;
  unreadable?: readonly string[];
  processRead?: (pane: string, read: (pane: string) => PaneSeed['process']) => PaneSeed['process'];
  busAlive?: boolean;
  bus?: Record<string, { workspace: string; process: { shell: number; foreground: number[] } | null }>;
}): { sources: UpSources; trace: Trace } {
  const trace: Trace = { created: [], closed: [], runs: [], events: [] };
  type Held = Required<Omit<PaneSeed, 'process'>> & { process: PaneSeed['process'] };
  const panes = new Map<string, Held>();
  const put = (id: string, seed: PaneSeed, workspace: string): void => {
    panes.set(id, {
      workspace,
      name: seed.name ?? null,
      session: seed.session ?? null,
      status: seed.status ?? 'idle',
      screen: seed.screen ?? '',
      process: seed.process,
    });
  };
  for (const [id, seed] of Object.entries(input.panes)) put(id, seed, seed.workspace ?? SPACE);
  for (const [id, seed] of Object.entries(input.bus ?? {})) put(id, { process: seed.process }, seed.workspace);
  const labels = new Map<string, string>(Object.entries(input.labels ?? { [SPACE]: WORKER }));
  for (const seed of Object.values(input.bus ?? {})) labels.set(seed.workspace, BUS);
  const agents = () => [...panes.entries()]
    .filter(([, pane]) => pane.name !== null)
    .map(([id, pane]) => ({
      name: pane.name,
      agent: 'claude',
      pane: id,
      workspace: pane.workspace,
      status: pane.status,
      cwd: root,
      ...(pane.session === null ? {} : { session: pane.session }),
    }));
  const processOf = (pane: string): PaneSeed['process'] => panes.get(pane)?.process ?? null;
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      trace.created.push(label);
      trace.events.push(`create:${label}`);
      labels.set(NEW_SPACE, label);
      panes.set(NEW_PANE, { workspace: NEW_SPACE, name: null, session: null, status: 'idle', screen: '', process: null });
      return { pane: NEW_PANE, workspace: NEW_SPACE };
    },
    paneRun(_session, pane, command) {
      trace.runs.push({ pane, command });
      trace.events.push(`run:${pane}`);
      const held = panes.get(pane);
      if (held === undefined) return false;
      held.screen = CLAUDE_IDLE;
      held.status = 'idle';
      held.process = { shell: held.process?.shell ?? 400, foreground: [1000 + trace.runs.length] };
      return true;
    },
    renameAgent(_session, pane, name) {
      const held = panes.get(pane);
      if (held === undefined) return false;
      held.name = name;
      return true;
    },
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      trace.events.push(`close:${workspace}`);
      labels.delete(workspace);
      for (const [id, held] of panes) if (held.workspace === workspace) panes.delete(id);
      return true;
    },
    agentPanes: () => [...panes.keys()],
    agents,
    workspacePanes: (_session, workspace) =>
      input.unreadable?.includes(workspace)
        ? null
        : [...panes.entries()].filter(([, held]) => held.workspace === workspace).map(([id]) => id),
    paneText: (_session, pane) => panes.get(pane)?.screen ?? null,
    typeText: () => true,
    pressEnter: () => true,
    agentStatus: (_session, pane) => panes.get(pane)?.status ?? null,
    foreground: (_session, pane) => {
      const held = panes.get(pane);
      if (held === undefined || held.process === null) return null;
      return held.process.foreground.map(() => 'claude');
    },
    processInfo: (_session, pane) => (input.processRead === undefined ? processOf(pane) : input.processRead(pane, processOf)),
    sleep: async () => {},
    now: () => NOW,
  };
  const doctor: DoctorSources = {
    version: () => '2.1.289',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
  };
  return {
    sources: {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents,
      workspaces: () => [...labels.entries()].map(([id, label]) => ({ id, label })),
      ...(input.busAlive === undefined ? {} : { busAlive: async () => input.busAlive === true }),
      home,
      doctor,
      launch,
      now: () => NOW,
      sleep: async () => {},
    },
    trace,
  };
}

const bare = (shell: number): PaneSeed['process'] => ({ shell, foreground: [shell] });
const idleScreen = CLAUDE_IDLE.replaceAll('Opus 5.5', 'Sonnet 5.5');

function stoppedBare(): { sources: UpSources; trace: Trace } {
  return makeWorld({ panes: { [PANE]: { process: bare(RECORDED.shell) } } });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'c75-sweep-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'synthetic\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'initial');
});

afterEach(() => {
  discardFixtures([base], { roots: [tmpdir()] });
});

test('a stopped seat is swept only when every pane is a bare shell', async () => {
  setup('stopped');
  seedWatch();
  recordReady();
  const made = stoppedBare();
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.closed).toEqual([SPACE]);
  expect(made.trace.created).toEqual([]);
  expect(made.trace.runs).toEqual([]);
  expect(said(io)).toContain(`${WORKER}: its workspace ${SPACE} was closed`);
  expect(seatState()?.stage).toBe('ready');
  expect(seatState()?.pane).toBe(PANE);
});

test('a record the file no longer declares has its workspace swept', async () => {
  setup('absent');
  seedWatch();
  recordReady();
  const made = stoppedBare();
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.closed).toEqual([SPACE]);
  expect(said(io)).toContain(`${WORKER}: its workspace ${SPACE} was closed`);
  expect(seatState()?.pane).toBe(PANE);
});

test('a seat the host moved is ready on the replacement before its old workspace closes', async () => {
  setup('declared');
  seedWatch();
  recordReady();
  let reads = 0;
  const made = makeWorld({
    panes: {
      [PANE]: { process: null },
      [OTHER_PANE]: {
        workspace: OTHER_SPACE,
        name: WORKER,
        session: SES,
        screen: idleScreen,
        process: { shell: 500, foreground: [900] },
      },
    },
    labels: { [SPACE]: WORKER, [OTHER_SPACE]: WORKER },
    processRead: (pane, read) => {
      if (pane !== PANE) return read(pane);
      reads += 1;
      return reads === 1 ? null : bare(RECORDED.shell);
    },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(seatState()).toMatchObject({ stage: 'ready', pane: OTHER_PANE, workspace: OTHER_SPACE });
  expect(made.trace.created).toEqual([]);
  expect(made.trace.closed).toEqual([SPACE]);
  expect(made.trace.events.indexOf(`close:${SPACE}`)).toBeGreaterThanOrEqual(0);
  expect(said(io)).toContain(`${WORKER}: its workspace ${SPACE} was closed`);
});

test('another pane that is not a bare shell holds the workspace', async () => {
  setup('stopped');
  seedWatch();
  recordReady();
  const made = makeWorld({
    panes: {
      [PANE]: { process: bare(RECORDED.shell) },
      [OTHER_PANE]: { process: { shell: 300, foreground: [300, 301] } },
    },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.closed).toEqual([]);
  expect(said(io)).toContain(`${WORKER}: its workspace ${SPACE} holds a process beside its shell; left as it is`);
});

test('a pane named for another seat holds the workspace', async () => {
  setup('stopped');
  seedWatch();
  recordReady();
  const made = makeWorld({
    panes: { [PANE]: { name: 'fixture-other-seat', process: bare(RECORDED.shell) } },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.closed).toEqual([]);
  expect(said(io)).toContain(`${WORKER}: its workspace ${SPACE} holds a pane named for another seat; left as it is`);
});

test('a working screen holds the workspace', async () => {
  setup('stopped');
  seedWatch();
  recordReady();
  const made = makeWorld({
    panes: { [PANE]: { screen: WORKING, process: bare(RECORDED.shell) } },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.closed).toEqual([]);
  expect(said(io)).toContain(`${WORKER}: its workspace ${SPACE} holds a screen that is working; left as it is`);
});

test('unsent text holds the workspace', async () => {
  setup('stopped');
  seedWatch();
  recordReady();
  const made = makeWorld({
    panes: { [PANE]: { screen: UNSENT, process: bare(RECORDED.shell) } },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.closed).toEqual([]);
  expect(said(io)).toContain(`${WORKER}: its workspace ${SPACE} holds unsent text; left as it is`);
});

test('a workspace another seat record names is left as it is', async () => {
  setup('absent');
  seedWatch();
  recordReady();
  updateState(dir, (file) => {
    const session = (file.sessions[SESSION] ??= emptySession());
    session.seats[LEAD] = { stage: 'ready', pane: OTHER_PANE, workspace: SPACE };
  });
  const made = makeWorld({
    panes: {
      [PANE]: { process: bare(RECORDED.shell) },
      [OTHER_PANE]: { process: bare(300) },
    },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.closed).toEqual([]);
  expect(said(io)).toContain(`${WORKER}: its workspace ${SPACE} is named by another seat's record; left as it is`);
});

test('an unreadable host holds the workspace', async () => {
  setup('stopped');
  seedWatch();
  recordReady();
  const made = makeWorld({
    panes: { [PANE]: { process: bare(RECORDED.shell) } },
    unreadable: [SPACE],
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.closed).toEqual([]);
  expect(said(io)).toContain(`${WORKER}: its workspace ${SPACE} could not be read; left as it is`);
});

test('a human owner pane is never swept', async () => {
  setup('stopped');
  seedWatch();
  recordReady();
  recordReady(LEAD, HUMAN_PANE, HUMAN_SPACE);
  const made = makeWorld({
    panes: {
      [PANE]: { process: bare(RECORDED.shell) },
      [HUMAN_PANE]: { workspace: HUMAN_SPACE, process: bare(80) },
    },
    labels: { [SPACE]: WORKER, [HUMAN_SPACE]: LEAD },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.closed).toEqual([SPACE]);
  expect(made.trace.closed).not.toContain(HUMAN_SPACE);
  expect(said(io)).toContain(`${LEAD}: the pane is a human's; nothing is launched into it or typed into it; left as it is`);
  expect(seatState(LEAD)?.workspace).toBe(HUMAN_SPACE);
});

test('one Bus is reused and a stray workspace closes only after it answers', async () => {
  setup('absent');
  seedWatch();
  const made = makeWorld({
    panes: {},
    busAlive: false,
    bus: {
      [BUS_PANE_ONE]: { workspace: BUS_ONE, process: bare(60) },
      [BUS_PANE_TWO]: { workspace: BUS_TWO, process: bare(70) },
    },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.created).toEqual([]);
  expect(made.trace.runs.map((run) => run.pane)).toEqual([BUS_PANE_ONE]);
  expect(made.trace.runs[0]?.command).toContain('bus');
  expect(made.trace.closed).toEqual([BUS_TWO]);
  expect(made.trace.events.indexOf(`run:${BUS_PANE_ONE}`)).toBeLessThan(made.trace.events.indexOf(`close:${BUS_TWO}`));
  expect(readState(dir).sessions[SESSION]?.bus).toMatchObject({ pane: BUS_PANE_ONE, workspace: BUS_ONE });
});

test('a Bus pane holding a process beside its shell is not typed into and no second workspace is made', async () => {
  setup('absent');
  seedWatch();
  const made = makeWorld({
    panes: {},
    busAlive: false,
    bus: { [BUS_PANE_ONE]: { workspace: BUS_ONE, process: { shell: 60, foreground: [60, 61] } } },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.created).toEqual([]);
  expect(made.trace.runs).toEqual([]);
  expect(made.trace.closed).toEqual([]);
  expect(said(io)).toContain(`bus: its workspace ${BUS_ONE} holds a process beside its shell; not started there`);
  expect(readState(dir).sessions[SESSION]?.bus).toBeUndefined();
});

test('a stray Bus workspace that holds a process is left after the live Bus is up', async () => {
  setup('absent');
  seedWatch();
  const made = makeWorld({
    panes: {},
    busAlive: false,
    bus: {
      [BUS_PANE_ONE]: { workspace: BUS_ONE, process: bare(60) },
      [BUS_PANE_TWO]: { workspace: BUS_TWO, process: { shell: 70, foreground: [70, 71] } },
    },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.runs.map((run) => run.pane)).toEqual([BUS_PANE_ONE]);
  expect(made.trace.closed).toEqual([]);
  expect(said(io)).toContain(`bus: its workspace ${BUS_TWO} holds a process beside its shell; left as it is`);
});

test('a Bus that already answers sweeps a stray with no Bus step', async () => {
  setup('absent');
  seedWatch();
  updateState(dir, (file) => {
    const session = (file.sessions[SESSION] ??= emptySession());
    session.bus = { pane: BUS_PANE_ONE, workspace: BUS_ONE, started: NOW.toISOString() };
  });
  const made = makeWorld({
    panes: {},
    busAlive: true,
    bus: {
      [BUS_PANE_ONE]: { workspace: BUS_ONE, process: bare(60) },
      [BUS_PANE_TWO]: { workspace: BUS_TWO, process: bare(70) },
    },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.created).toEqual([]);
  expect(made.trace.runs).toEqual([]);
  expect(made.trace.closed).toEqual([BUS_TWO]);
  expect(said(io)).toContain(`bus: its workspace ${BUS_TWO} was closed`);
});

test('an unreadable Bus workspace starts no second one', async () => {
  setup('absent');
  seedWatch();
  const made = makeWorld({
    panes: {},
    busAlive: false,
    unreadable: [BUS_ONE],
    bus: { [BUS_PANE_ONE]: { workspace: BUS_ONE, process: bare(60) } },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.created).toEqual([]);
  expect(made.trace.runs).toEqual([]);
  expect(made.trace.closed).toEqual([]);
  expect(said(io)).toContain('could not be read');
  expect(said(io)).toContain('no second');
});

test('team remove sweeps the workspace of a seat the host no longer lists', async () => {
  setup('declared');
  seedWatch();
  recordReady();
  const closed: string[] = [];
  const panes = new Map<string, PaneSeed>([
    [PANE, { workspace: SPACE, process: bare(RECORDED.shell) }],
  ]);
  const sources: RemoveSources = {
    ...downSources,
    home,
    sessionRunning: () => true,
    agents: () => [],
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['claude'],
    foregroundCwd: () => null,
    processes: (_session, pane) => panes.get(pane)?.process ?? null,
    workspacePanes: (_session, workspace) =>
      [...panes.entries()].filter(([, held]) => held.workspace === workspace).map(([id]) => id),
    now: () => NOW,
    sleep: async () => {},
    launch: {
      typeText: () => true,
      sendKey: () => true,
      pressEnter: () => true,
      agentPanes: () => [...panes.keys()],
      closeWorkspace: (_session, workspace) => {
        closed.push(workspace);
        return true;
      },
      stopSession: () => true,
      deleteSession: () => true,
      kill: () => true,
      sleep: async () => {},
      now: () => NOW,
    },
  };
  const io = testIo(root, { kind: 'owner' });
  expect(await runRemove([WORKER], io, sources), said(io)).toBe(0);
  expect(closed).toEqual([SPACE]);
  expect(said(io)).toContain(`${WORKER}: its workspace ${SPACE} was closed`);
  expect(seatState()).toBeUndefined();
});

test('team remove leaves a human owner pane unswept', async () => {
  setup('absent');
  seedWatch();
  recordReady(LEAD, HUMAN_PANE, HUMAN_SPACE);
  const closed: string[] = [];
  const sources: RemoveSources = {
    ...downSources,
    home,
    sessionRunning: () => true,
    agents: () => [],
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['claude'],
    foregroundCwd: () => null,
    processes: () => bare(80),
    workspacePanes: () => [HUMAN_PANE],
    now: () => NOW,
    sleep: async () => {},
    launch: {
      typeText: () => true,
      sendKey: () => true,
      pressEnter: () => true,
      agentPanes: () => [HUMAN_PANE],
      closeWorkspace: (_session, workspace) => {
        closed.push(workspace);
        return true;
      },
      stopSession: () => true,
      deleteSession: () => true,
      kill: () => true,
      sleep: async () => {},
      now: () => NOW,
    },
  };
  const io = testIo(root, { kind: 'owner' });
  await runRemove([LEAD], io, sources);
  expect(closed).toEqual([]);
  expect(said(io)).not.toContain('was closed');
});
