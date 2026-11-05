// C7.5 item 2: a dead seat's relaunch keeps to its own workspace.
//
// The three orders this file pins:
//
// - a recorded pane the host still shows at its shell (`verdict === 'gone'`) is relaunched in
//   that same pane: no workspace is created, and nothing is closed;
// - a pane the host did not restore gets its replacement created first, launched and made
//   ready, and only then is the recorded workspace closed — never before;
// - a recorded workspace the host still lists with another pane in it is left exactly as it
//   is, and the run says so instead of closing it;
// - a pane that is not its own bare shell — another process beside it, a name the host gives
//   another seat — is never typed into, and a pane the close cannot read is never closed.
//
// Every pane, workspace, process reading, screen and conversation here is a synthetic fixture:
// no live terminal host, registry, provider or pane is read. The pane's model and the
// conversation it runs are read back from the command the fake took, never asserted into place.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { TeamFile } from '../src/file/types.ts';
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

/** A human lead and the implementer these scenes relaunch. */
function teamText(): string {
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
  - role: implementer
    name: ${WORKER}
    label: ${WORKER}
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
`;
}

function setup(): void {
  const text = teamText();
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
    // A live pane watch already carries this route: these scenes are about the seat's own
    // workspace, and this run must start no watch of its own beside it.
    session.watch = { heartbeat: NOW.toISOString(), pane: 'fixture-watch-pane' };
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

type PaneFixture = {
  screen: string;
  session: string | null;
  workspace: string;
  name: string | null;
  status: string;
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

// What this run can see, as the host lists it. `extra` seeds a second pane in the recorded
// workspace (the owner's own shell, say); `process` is what the recorded pane's process read
// says at the start of the run; null is a pane the restore did not bring back.
function makeWorld(first: {
  screen?: string;
  process: PaneFixture['process'];
  name?: string | null;
  extra?: { pane: string; process: PaneFixture['process'];
  };
}): { sources: UpSources; trace: RunTrace } {
  const trace: RunTrace = { created: [], closed: [], runs: [], events: [] };
  const panes = new Map<string, PaneFixture>();
  const labels = new Map<string, string>();
  const seed = (pane: string, over: Partial<PaneFixture>): void => {
    panes.set(pane, {
      screen: '', session: null, workspace: SPACE, name: null, status: 'idle', process: null, ...over,
    });
  };
  seed(PANE, { screen: first.screen ?? '', process: first.process, name: first.name ?? null });
  labels.set(SPACE, WORKER);
  if (first.extra) seed(first.extra.pane, { process: first.extra.process, status: 'idle' });
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
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      made += 1;
      trace.created.push(label);
      trace.events.push(`create:${NEW_SPACE}`);
      labels.set(NEW_SPACE, label);
      panes.set(NEW_PANE, { screen: '', session: null, workspace: NEW_SPACE, name: null, status: 'idle', process: null });
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
      trace.closed.push(workspace);
      trace.events.push(`close:${workspace}`);
      labels.delete(workspace);
      for (const [id, held] of panes) if (held.workspace === workspace) panes.delete(id);
      return true;
    },
    agentPanes: () => [...panes.keys()],
    agents,
    workspacePanes: (_session, workspace) =>
      list().filter(([, held]) => held.workspace === workspace).map(([id]) => id),
    paneText: (_session, pane) => panes.get(pane)?.screen ?? null,
    typeText: () => true,
    pressEnter: () => true,
    agentStatus: (_session, pane) => panes.get(pane)?.status ?? null,
    foreground: (_session, pane) => {
      const held = panes.get(pane);
      return held === undefined ? null : 'claude' as never;
    },
    shellBack: (_session, pane) => {
      const held = panes.get(pane);
      if (held === undefined || held.process === null) return null;
      return held.process.foreground.length > 0 && held.process.foreground.every((pid) => pid === held.process!.shell);
    },
    processInfo: (_session, pane) => panes.get(pane)?.process ?? null,
    sleep: async () => {},
    now: () => NOW,
  };
  // The pane's foreground argv0 names: whatever pids are in front run the CLI this fixture
  // launches; a pane whose reading is the shell alone names none, and a vanished pane no names.
  launch.foreground = (_session, pane) => {
    const held = panes.get(pane);
    if (held === undefined || held.process === null) return null;
    return held.process.foreground.map(() => 'claude');
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
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-repair-own-workspace-')));
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
  setup();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

test('a pane the host still shows at its shell is relaunched in that same pane', async () => {
  recordReady();
  // The shell is back in the seat's own pane: its recorded shell in front, no CLI, no name.
  const made = makeWorld({ process: { shell: 100, foreground: [100] } });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  // One launch, in the recorded pane; nothing created, nothing closed.
  expect(made.trace.runs).toHaveLength(1);
  expect(workerRuns(made.trace)).toHaveLength(1);
  expect(made.trace.created).toEqual([]);
  expect(made.trace.closed).toEqual([]);
  expect(made.trace.events).toEqual([`run:${PANE}`]);

  // The record keeps its own pane and workspace, and the process it now runs is the new one.
  const held = seatState();
  expect(held?.stage).toBe('ready');
  expect(held?.pane).toBe(PANE);
  expect(held?.workspace).toBe(SPACE);
  expect(held?.launched?.cli).toEqual([1001]);
  expect(`${io.out}${io.err}`).not.toContain('left out');
});

test('a pane the host did not restore is replaced first, and its workspace closes only after the seat is ready', async () => {
  recordReady();
  // The recorded pane is still listed by the host but holds no process at all: the restore did
  // not bring its program back. The workspace is still listed beside it.
  const made = makeWorld({ process: null });
  // The plan's reading finds nothing in the old pane; by the close the host has the pane back
  // at its shell. The close re-reads the pane, and only that fresh reading decides the close.
  const read = made.sources.launch!.processInfo!;
  let reads = 0;
  made.sources.launch!.processInfo = (session, pane) => {
    if (pane !== PANE) return read(session, pane);
    reads += 1;
    return reads === 1 ? null : { shell: RECORDED.shell, foreground: [RECORDED.shell] };
  };
  let readyAtClose: { stage?: string; pane?: string; workspace?: string } = {};
  const closer = made.sources.launch!.closeWorkspace;
  made.sources.launch!.closeWorkspace = (session, workspace) => {
    const held = seatState();
    readyAtClose = { stage: held?.stage, pane: held?.pane, workspace: held?.workspace };
    return closer(session, workspace);
  };
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  // The replacement was created and launched before the old workspace closed, and the seat was
  // already ready on its new pane when the close was made.
  const order = made.trace.events;
  expect(order.indexOf(`create:${NEW_SPACE}`)).toBeLessThan(order.indexOf(`run:${NEW_PANE}`));
  expect(order.indexOf(`run:${NEW_PANE}`)).toBeLessThan(order.indexOf(`close:${SPACE}`));
  expect(made.trace.closed).toEqual([SPACE]);
  expect(readyAtClose).toEqual({ stage: 'ready', pane: NEW_PANE, workspace: NEW_SPACE });

  // The seat itself lives on its replacement; the old pane was resumed by its recorded line.
  const held = seatState();
  expect(held?.stage).toBe('ready');
  expect(held?.pane).toBe(NEW_PANE);
  expect(held?.workspace).toBe(NEW_SPACE);
  expect(made.trace.runs[0]?.command).toContain(`--resume ${SES}`);
  expect(`${io.out}${io.err}`).toContain('its recorded workspace');
});

test('a recorded workspace holding another pane is left as it is, and the run says why', async () => {
  recordReady();
  // The owner's own shell sits in the recorded workspace beside the seat's dead pane: the
  // workspace is the host's to keep, and closing it would close that shell too.
  const made = makeWorld({ process: null, extra: { pane: OTHER_PANE, process: { shell: 300, foreground: [300] } } });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  expect(made.trace.closed).toEqual([]);
  expect(made.trace.created).toHaveLength(1);
  expect(seatState()?.stage).toBe('ready');
  expect(`${io.out}${io.err}`).toContain(`its recorded workspace ${SPACE} holds other panes; left as it is`);
});

test('a pane with another process beside its own shell is not typed into', async () => {
  recordReady();
  // The recorded shell is in front, and so is a process the record does not name. `gone` holds
  // for this reading, but the pane is not bare: a launch line typed here would land in whatever
  // that other process is.
  const made = makeWorld({ process: { shell: RECORDED.shell, foreground: [RECORDED.shell, 900] } });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(1);

  // Nothing was typed, created or closed, and the record is exactly as it was.
  expect(made.trace.runs).toEqual([]);
  expect(made.trace.created).toEqual([]);
  expect(made.trace.closed).toEqual([]);
  expect(seatState()).toMatchObject({ stage: 'ready', pane: PANE, launched: RECORDED });
  expect(`${io.out}${io.err}`)
    .toContain('the process in its pane is not the one team launched; nothing launched, nothing closed');
});

test('a recorded pane whose process cannot be read is never closed', async () => {
  recordReady();
  // The recorded pane did not come back: the seat is replaced first, and the recorded workspace
  // is left to close last. The close's own reading finds nothing in the old pane — it cannot be
  // read — so the workspace is left exactly as it is.
  const made = makeWorld({ process: null });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  expect(made.trace.created).toHaveLength(1);
  expect(made.trace.closed).toEqual([]);
  expect(`${io.out}${io.err}`)
    .toContain(`its recorded workspace ${SPACE} holds a pane that could not be read; left as it is`);
  expect(seatState()).toMatchObject({ stage: 'ready', pane: NEW_PANE, workspace: NEW_SPACE });
});

test('a pane the host names for another seat is not typed into', async () => {
  recordReady();
  // The recorded pane is back at its own shell, and the host names another seat on it: the
  // pane is that seat's, and this seat's launch line is never typed there.
  const made = makeWorld({ process: { shell: RECORDED.shell, foreground: [RECORDED.shell] }, name: 'fixture-other-seat' });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(1);

  expect(made.trace.runs).toEqual([]);
  expect(made.trace.created).toEqual([]);
  expect(made.trace.closed).toEqual([]);
  expect(seatState()).toMatchObject({ stage: 'ready', pane: PANE, launched: RECORDED });
  expect(`${io.out}${io.err}`).toContain('its pane is named for another seat; nothing launched, nothing closed');
});

test('a pane the host names for another seat is never closed', async () => {
  recordReady();
  // The plan sees the old pane gone; by the close the host has it back at its shell and names
  // another seat on it. The close re-reads the pane and the list, and the workspace is left.
  const made = makeWorld({ process: null });
  const read = made.sources.launch!.processInfo!;
  let reads = 0;
  made.sources.launch!.processInfo = (session, pane) => {
    if (pane !== PANE) return read(session, pane);
    reads += 1;
    return reads === 1 ? null : { shell: RECORDED.shell, foreground: [RECORDED.shell] };
  };
  const agentsNow = made.sources.launch!.agents;
  made.sources.launch!.agents = (session) => {
    const seen = agentsNow(session) ?? [];
    // Once this run has made the replacement, the host also names another seat on the old pane.
    return made.trace.created.length > 0
      ? [...seen, { name: 'fixture-other-seat', agent: 'claude', pane: PANE, workspace: SPACE, status: 'idle', cwd: root }]
      : seen;
  };
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  expect(made.trace.created).toHaveLength(1);
  expect(made.trace.closed).toEqual([]);
  expect(`${io.out}${io.err}`)
    .toContain(`its recorded workspace ${SPACE} holds a pane named for another seat; left as it is`);
  expect(seatState()).toMatchObject({ stage: 'ready', pane: NEW_PANE, workspace: NEW_SPACE });
});
