// C7.5 item 3: the workspace a seat vacated is swept.
//
// The orders this file pins:
//
// - a seat the file stops keeps its record, and the workspace that record names is closed after
//   the host is read again at the close — never from the plan's minutes-old list;
// - only a workspace whose panes each hold their own shell alone, with no other seat's name on
//   any of them, is closed; a process beside a shell, another seat's record, or an unreadable
//   panes list leaves it exactly as it is, and the run says why;
// - a record the file no longer declares is swept the same way, and so is the workspace a
//   host-moved record leaves behind — after the seat is ready on its replacement;
// - a human seat's record is never moved or swept, a workspace whose pane list reads empty is
//   not closed, and no workspace holding the pane the command runs in is closed;
// - `team remove` sweeps the workspace of a seat herdr no longer lists before its record goes.
//
// Every pane, workspace, process reading, screen and conversation here is a synthetic fixture:
// no live terminal host, registry, provider or pane is read.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { realSources as downSources } from '../src/commands/down.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { upPlan, type UpSeat } from '../src/launch/plan.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState, type SeatState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T09:30:00Z');
const SESSION = 'acme';
const LEAD = 'lead';
const WORKER = 'worker';
const HANDLE = 'seat_0123456789ab';
const SES = 'ses_a1b2c3d4e5f6';
// The seat's own pane and workspace, as its launch recorded them, and the ones a replacement
// this run makes gets. Neutral ids: the fixtures name no real terminal host's pane.
const PANE = 'fixture-pane-one';
const SPACE = 'fixture-space';
const NEW_PANE = 'fixture-pane-new';
const NEW_SPACE = 'fixture-space-new';
const OTHER_PANE = 'fixture-pane-other';
const OTHER_SPACE = 'fixture-space-other';
// The pane the command itself runs in, when the scene places one.
const CALLER_PANE = 'fixture-pane-caller';
const WATCH_PANE = 'fixture-watch-pane';
const RECORDED = { shell: 100, cli: [200] };
const A = { model: 'Claude Sonnet', version: '5.5', launch: 'claude --model claude-sonnet-5-5' };

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

/** A human lead, and the implementer these scenes sweep — stopped in the file, removed from it,
/// or declared and moved by the host, per scene. */
function teamText(input: { worker: 'declared' | 'stopped' | 'absent' | 'human' }): string {
  const worker = input.worker === 'absent'
    ? ''
    : `  - role: implementer
    name: ${WORKER}
    label: ${WORKER}
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
${input.worker === 'stopped' ? '    stopped: true\n' : ''}${input.worker === 'human' ? '    human: true\n' : ''}`;
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
${worker}`;
}

function setup(text: string): void {
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

/** A live pane watch already carries this route: no watch step, no watch workspace. */
function seedWatch(): void {
  updateState(dir, (file) => {
    const session = (file.sessions[SESSION] ??= emptySession());
    session.watch = { heartbeat: NOW.toISOString(), pane: WATCH_PANE };
  });
}

/** The record a launch left: the worker ready on PANE/SPACE, bound to the conversation SES. */
function recordReady(): void {
  const held: SeatState = {
    stage: 'ready',
    id: HANDLE,
    pane: PANE,
    workspace: SPACE,
    launched: RECORDED,
    agent_session: SES,
    model: A.model,
    version: A.version,
    launch_line: A.launch,
  };
  updateState(dir, (file) => {
    const session = (file.sessions[SESSION] ??= emptySession());
    session.seats[WORKER] = held;
  });
  registerAgent(home, {
    name: WORKER,
    signing: { model: A.model, version: A.version, role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: A.launch,
    reach: { team: teamIdOf(root), seat: WORKER, session: SESSION, pane: PANE, address: null, agent_session: SES },
    seat_handle: HANDLE,
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

const seatState = (): SeatState | undefined => readState(dir).sessions[SESSION]?.seats[WORKER];

/** The captured Claude Code idle screen, its banner naming the model the line asked for. */
const idleFor = (command: string): string => {
  const model = /--model(?:=|\s+)['"]?([A-Za-z0-9._-]+)/.exec(command)?.[1] ?? '';
  const family = model.includes('sonnet') ? 'Sonnet' : model.includes('haiku') ? 'Haiku' : 'Opus';
  return CLAUDE_IDLE.replaceAll('Opus 5.5', `${family} 5.5`);
};
const sessionFor = (command: string): string | null =>
  /(?:--resume|--session-id)(?:=|\s+)['"]?([A-Za-z0-9][A-Za-z0-9._:-]*)/.exec(command)?.[1] ?? null;

type PaneSeed = {
  workspace?: string;
  name?: string | null;
  session?: string | null;
  status?: string;
  screen?: string;
  /** What the pane's process read says; null is herdr showing the pane with no process in it. */
  process: { shell: number; foreground: number[] } | null;
};

type RunTrace = {
  created: string[];
  closed: string[];
  runs: { pane: string; command: string }[];
  /** One line per create, launch and close, in the order the run made them. */
  events: string[];
};

// What this run can see, as the host lists it. `unreadable` seeds a workspace whose pane list
// cannot be read; `empty` one the host lists with no panes; `processRead` overrides the fresh
// read of one pane (the plan's reading and the close's reading can then differ, which is how a
// re-read is proven).
function makeWorld(input: {
  panes: Record<string, PaneSeed>;
  labels?: Record<string, string>;
  unreadable?: readonly string[];
  empty?: readonly string[];
  processRead?: (pane: string, read: (pane: string) => PaneSeed['process']) => PaneSeed['process'];
  closeFails?: boolean;
}): { sources: UpSources; trace: RunTrace } {
  const trace: RunTrace = { created: [], closed: [], runs: [], events: [] };
  type Held = Required<Omit<PaneSeed, 'process'>> & { process: PaneSeed['process'] };
  const panes = new Map<string, Held>();
  for (const [id, seed] of Object.entries(input.panes)) {
    panes.set(id, {
      workspace: seed.workspace ?? SPACE,
      name: seed.name ?? null,
      session: seed.session ?? null,
      status: seed.status ?? 'idle',
      screen: seed.screen ?? '',
      process: seed.process,
    });
  }
  const labels = new Map<string, string>(Object.entries(input.labels ?? { [SPACE]: WORKER }));
  let made = 0;
  const list = () => [...panes.entries()];
  const agents = () => list()
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
  const processInfo = (pane: string): PaneSeed['process'] => input.processRead === undefined
    ? processOf(pane)
    : input.processRead(pane, processOf);
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      made += 1;
      trace.created.push(label);
      trace.events.push(`create:${NEW_SPACE}`);
      labels.set(NEW_SPACE, label);
      panes.set(NEW_PANE, { workspace: NEW_SPACE, name: null, session: null, status: 'idle', screen: '', process: null });
      return { pane: NEW_PANE, workspace: NEW_SPACE };
    },
    paneRun(_session, pane, command) {
      trace.runs.push({ pane, command });
      trace.events.push(`run:${pane}`);
      const held = panes.get(pane);
      if (held === undefined) return false;
      held.screen = idleFor(command);
      held.session = sessionFor(command);
      held.status = 'idle';
      held.process = { shell: held.process?.shell ?? 400 + made, foreground: [1000 + trace.runs.length] };
      return true;
    },
    renameAgent(_session, pane, name) {
      const held = panes.get(pane);
      if (held === undefined) return false;
      held.name = name;
      return true;
    },
    closeWorkspace(_session, workspace) {
      if (input.closeFails === true) return false;
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
        : input.empty?.includes(workspace)
          ? []
          : list().filter(([, held]) => held.workspace === workspace).map(([id]) => id),
    paneText: (_session, pane) => panes.get(pane)?.screen ?? null,
    typeText: () => true,
    pressEnter: () => true,
    agentStatus: (_session, pane) => panes.get(pane)?.status ?? null,
    foreground: (_session, pane) => {
      const held = panes.get(pane);
      if (held === undefined || held.process === null) return null;
      return held.process.foreground.map(() => 'claude');
    },
    shellBack: (_session, pane) => {
      const held = panes.get(pane);
      if (held === undefined || held.process === null) return null;
      return held.process.foreground.length > 0 && held.process.foreground.every((pid) => pid === held.process!.shell);
    },
    processInfo: (_session, pane) => processInfo(pane),
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
      home,
      doctor,
      launch,
      now: () => NOW,
      sleep: async () => {},
    },
    trace,
  };
}

const workerRuns = (trace: RunTrace) => trace.runs.filter((run) => run.pane === PANE);

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-workspace-sweep-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

test('a stopped seat keeps its record and has its vacated workspace closed', async () => {
  setup(teamText({ worker: 'stopped' }));
  seedWatch();
  recordReady();
  // The seat's pane is back at its own shell, and the workspace still lists it.
  const made = makeWorld({ panes: { [PANE]: { process: { shell: RECORDED.shell, foreground: [RECORDED.shell] } } } });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  // One close, of the recorded workspace; nothing created, nothing launched.
  expect(made.trace.closed).toEqual([SPACE]);
  expect(made.trace.created).toEqual([]);
  expect(made.trace.runs).toEqual([]);
  expect(`${io.out}${io.err}`).toContain(`worker: its workspace ${SPACE} was closed`);

  // The record is kept: a stopped seat is not a removed one.
  expect(seatState()?.stage).toBe('ready');
  expect(seatState()?.pane).toBe(PANE);
});

test('a pane holding a process beside its shell is never closed over', async () => {
  setup(teamText({ worker: 'stopped' }));
  seedWatch();
  recordReady();
  // The recorded shell is in front, and so is a process beside it: not a bare pane.
  const made = makeWorld({ panes: { [PANE]: { process: { shell: RECORDED.shell, foreground: [RECORDED.shell, 900] } } } });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  expect(made.trace.closed).toEqual([]);
  expect(`${io.out}${io.err}`).toContain(`worker: its workspace ${SPACE} holds a process beside its shell; left as it is`);
});

test('a record the file no longer declares has its workspace swept', async () => {
  setup(teamText({ worker: 'absent' }));
  seedWatch();
  recordReady();
  const made = makeWorld({ panes: { [PANE]: { process: { shell: RECORDED.shell, foreground: [RECORDED.shell] } } } });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  expect(made.trace.closed).toEqual([SPACE]);
  expect(`${io.out}${io.err}`).toContain(`worker: its workspace ${SPACE} was closed`);
  // The record is not this run's to drop: only the workspace was vacated.
  expect(seatState()?.pane).toBe(PANE);
});

test('a workspace another seat record still names is left as it is', async () => {
  setup(teamText({ worker: 'absent' }));
  seedWatch();
  recordReady();
  // The lead's own record names the same workspace: it is not the removed seat's to lose.
  updateState(dir, (file) => {
    const session = (file.sessions[SESSION] ??= emptySession());
    session.seats[LEAD] = { stage: 'ready', pane: OTHER_PANE, workspace: SPACE };
  });
  const made = makeWorld({
    panes: {
      [PANE]: { process: { shell: RECORDED.shell, foreground: [RECORDED.shell] } },
      [OTHER_PANE]: { process: { shell: 300, foreground: [300] } },
    },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  expect(made.trace.closed).toEqual([]);
  expect(`${io.out}${io.err}`).toContain(`worker: its workspace ${SPACE} is named by another seat's record; left as it is`);
});

test('a seat the host moved is adopted first, and its old workspace closes after it', async () => {
  setup(teamText({ worker: 'declared' }));
  seedWatch();
  recordReady();
  // The recorded pane is still listed by the host but holds nothing; the host restored the seat
  // on another pane in another workspace, named for it and carrying its recorded conversation.
  let madeReads = 0;
  const made = makeWorld({
    panes: {
      [PANE]: { process: null },
      [OTHER_PANE]: {
        workspace: OTHER_SPACE,
        name: WORKER,
        session: SES,
        status: 'idle',
        screen: idleFor(A.launch),
        process: { shell: 500, foreground: [900] },
      },
    },
    labels: { [SPACE]: WORKER, [OTHER_SPACE]: WORKER },
    // The plan reads the old pane as gone (no process); by the close the host has it back at
    // its shell. Only that fresh reading decides the close.
    processRead: (pane, read) => {
      if (pane !== PANE) return read(pane);
      madeReads += 1;
      return madeReads === 1 ? null : { shell: RECORDED.shell, foreground: [RECORDED.shell] };
    },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  // The record moved to the pane the host names, with the pids it holds now.
  const held = seatState();
  expect(held?.stage).toBe('ready');
  expect(held?.pane).toBe(OTHER_PANE);
  expect(held?.workspace).toBe(OTHER_SPACE);
  expect(held?.launched).toEqual({ shell: 500, cli: [900] });

  // The old workspace closed, and nothing was created or launched for the seat.
  expect(made.trace.created).toEqual([]);
  expect(workerRuns(made.trace)).toEqual([]);
  expect(made.trace.closed).toEqual([SPACE]);
  expect(`${io.out}${io.err}`).toContain(`worker: its workspace ${SPACE} was closed`);
});

test('a vacated workspace whose panes cannot be read is left as it is', async () => {
  setup(teamText({ worker: 'declared' }));
  seedWatch();
  recordReady();
  const made = makeWorld({
    panes: {
      [PANE]: { process: null },
      [OTHER_PANE]: {
        workspace: OTHER_SPACE,
        name: WORKER,
        session: SES,
        status: 'idle',
        screen: idleFor(A.launch),
        process: { shell: 500, foreground: [900] },
      },
    },
    labels: { [SPACE]: WORKER, [OTHER_SPACE]: WORKER },
    unreadable: [SPACE],
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  expect(made.trace.closed).toEqual([]);
  expect(`${io.out}${io.err}`).toContain(`worker: its workspace ${SPACE} could not be read; left as it is`);
});

test('a workspace whose pane list reads empty is left as it is', async () => {
  setup(teamText({ worker: 'stopped' }));
  seedWatch();
  recordReady();
  // The host answers with an empty pane list: nothing in the workspace was read, so nothing
  // proves it bare.
  const made = makeWorld({
    panes: { [PANE]: { process: { shell: RECORDED.shell, foreground: [RECORDED.shell] } } },
    empty: [SPACE],
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  expect(made.trace.closed).toEqual([]);
  expect(`${io.out}${io.err}`).toContain(`worker: its workspace ${SPACE} could not be read; left as it is`);
});

test('a human seat with a state record is never moved, swept or closed over', async () => {
  setup(teamText({ worker: 'human' }));
  seedWatch();
  recordReady();
  // The host moved the old pane's occupant: a pane named for the seat sits in another workspace,
  // which for a launched seat would be an adoption with the old workspace swept behind it.
  const made = makeWorld({
    panes: {
      [PANE]: { process: null },
      [OTHER_PANE]: {
        workspace: OTHER_SPACE,
        name: WORKER,
        session: SES,
        status: 'idle',
        screen: idleFor(A.launch),
        process: { shell: 500, foreground: [900] },
      },
    },
    labels: { [SPACE]: WORKER, [OTHER_SPACE]: WORKER },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  // A human's pane is not ours to move, and its record stays where it was.
  expect(made.trace.closed).toEqual([]);
  expect(made.trace.created).toEqual([]);
  expect(seatState()?.pane).toBe(PANE);
  expect(seatState()?.workspace).toBe(SPACE);
  expect(`${io.out}${io.err}`).toContain("the pane is a human's; nothing is launched into it or typed into it; left as it is");
  // No sweep was even considered: the plan holds no close for a human's workspace, so the run
  // never reaches the sweep's own refusal either.
  expect(`${io.out}${io.err}`).not.toContain(`its workspace ${SPACE} was left as it is; the seat is not ready on a replacement`);
});

test('a human or granted seat carrying a sweep adds no sweep step', () => {
  const seatOf = (name: string, extra: Partial<UpSeat>): UpSeat => ({
    name,
    cli: 'claude-code',
    launch: 'claude',
    cwd: '.',
    label: name,
    repairLine: '',
    stopped: false,
    rules: '',
    ...extra,
  });
  const plan = upPlan({
    root: '/r',
    session: 'scratch',
    sessionRunning: true,
    watchAlive: true,
    watchLabel: 'Watch · scratch',
    seats: [
      seatOf('lead', { human: true, sweep: { workspace: SPACE } }),
      seatOf('kept', { grantKeep: 'left as it is', sweep: { workspace: OTHER_SPACE } }),
      seatOf('worker', { stopped: true, sweep: { workspace: NEW_SPACE } }),
    ],
  });
  // Only the stopped seat's workspace is swept: a human's is not ours to close, and a granted
  // seat's panes are left as they are.
  const swept = plan.flatMap((step) => (step.do?.do === 'sweep' ? [step.do] : []));
  expect(swept).toEqual([{ do: 'sweep', seat: 'worker', workspace: NEW_SPACE, cli: 'claude-code' }]);
});

test('a workspace holding the pane this command runs in is left as it is', async () => {
  setup(teamText({ worker: 'stopped' }));
  seedWatch();
  recordReady();
  // Both panes are back at their own shells; one of them is the pane this run was started in.
  const made = makeWorld({
    panes: {
      [PANE]: { process: { shell: RECORDED.shell, foreground: [RECORDED.shell] } },
      [CALLER_PANE]: { process: { shell: 300, foreground: [300] } },
    },
  });
  const io = testIo(root, { kind: 'owner' });
  io.env.HERDR_PANE_ID = CALLER_PANE;
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  // Closing it would close the terminal the command is running in.
  expect(made.trace.closed).toEqual([]);
  expect(`${io.out}${io.err}`).toContain(`worker: its workspace ${SPACE} holds the pane this command runs in; left as it is`);
});

test('team remove sweeps the workspace of a seat herdr no longer lists', async () => {
  setup(teamText({ worker: 'declared' }));
  seedWatch();
  recordReady();
  const closed: string[] = [];
  const panes = new Map<string, PaneSeed>([
    [PANE, { workspace: SPACE, name: null, session: null, status: 'idle', screen: '', process: { shell: RECORDED.shell, foreground: [RECORDED.shell] } }],
  ]);
  const launch = {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => [...panes.keys()],
    closeWorkspace: (_session: string, workspace: string) => {
      closed.push(workspace);
      return true;
    },
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };
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
    launch,
  };
  const io = testIo(root, { kind: 'owner' });
  expect(await runRemove(['worker'], io, sources), `remove said:\n${io.out}\n${io.err}`).toBe(0);

  expect(closed).toEqual([SPACE]);
  expect(`${io.out}${io.err}`).toContain(`worker: its workspace ${SPACE} was closed`);
  expect(seatState()).toBeUndefined();
});

test('team remove leaves a workspace holding the pane it runs in', async () => {
  setup(teamText({ worker: 'declared' }));
  seedWatch();
  recordReady();
  const closed: string[] = [];
  const panes = new Map<string, PaneSeed>([
    [PANE, { workspace: SPACE, name: null, session: null, status: 'idle', screen: '', process: { shell: RECORDED.shell, foreground: [RECORDED.shell] } }],
    [CALLER_PANE, { workspace: SPACE, name: null, session: null, status: 'idle', screen: '', process: { shell: 300, foreground: [300] } }],
  ]);
  const launch = {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => [...panes.keys()],
    closeWorkspace: (_session: string, workspace: string) => {
      closed.push(workspace);
      return true;
    },
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };
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
    launch,
  };
  const io = testIo(root, { kind: 'owner' });
  io.env.HERDR_PANE_ID = CALLER_PANE;
  expect(await runRemove(['worker'], io, sources), `remove said:\n${io.out}\n${io.err}`).toBe(0);

  // The removal goes on, but the terminal it runs in is not closed under it.
  expect(closed).toEqual([]);
  expect(`${io.out}${io.err}`).toContain(`worker: its workspace ${SPACE} holds the pane this command runs in; left as it is`);
  expect(seatState()).toBeUndefined();
});
