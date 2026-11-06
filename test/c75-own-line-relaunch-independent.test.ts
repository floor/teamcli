// Independent verification of C7.5 item 7: a restored wrapper seat is relaunched in the same
// pane (src/commands/up.ts, src/launch/plan.ts, src/launch/execute.ts, src/launch/restore-proof.ts).
//
// The relaunch exits the bare CLI, waits until that pane's own shell is the only process,
// reads the pane again, and runs the seat's own launch line there with --resume. It does not
// create or close a workspace. A pane that does not return to its shell is left untouched.
// The launcher name is synthetic. The terminal host, its process table and its screens are
// synthetic. No live host, CLI, or process signal is invoked.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { findAgent, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, recordRenames, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T02:10:00Z');
const SESSION = 'acme';
const SEAT = 'worker';
const PANE = 'pane-restored';
const WORKSPACE = 'ws-restored';
const RECORDED = { shell: 100, cli: [200] };
const RESTORED: PaneProcesses = { shell: 101, foreground: [201] };
const SHELL: PaneProcesses = { shell: RESTORED.shell, foreground: [RESTORED.shell] };
const SESSION_ID = 'ses_claude';
const OTHER_SESSION = 'ses_other';
const EXIT_TEXT = '/exit';
const DRIFTED = CLAUDE_IDLE.replace('Opus 5.5 · Acme billing', 'deepseek-v3 · API Usage Billing');

type Spec = { launch: string; vendor: string; model: string; version: string };
const WRAPPER: Spec = { launch: 'team-deepseek', vendor: 'deepseek', model: 'DeepSeek Flash', version: 'V4.1' };
const BARE: Spec = { launch: 'claude --model claude-opus-5-5', vendor: 'anthropic', model: 'Claude Opus', version: '5.5' };

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

function teamText(spec: Spec): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
    human: true
  - role: implementer
    name: ${SEAT}
    label: ${SEAT}
    cli: claude-code
    vendor: ${spec.vendor}
    model: ${spec.model}
    version: "${spec.version}"
    launch: ${spec.launch}
`;
}

function recordSeat(spec: Spec, seatRecord: Record<string, unknown>, registry: { session?: string | null } = {}): void {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = seatRecord as never;
  });
  registerAgent(home, {
    name: SEAT,
    signing: { model: spec.model, version: spec.version, role: 'implementer' },
    lab: spec.vendor,
    cli: 'claude-code',
    launcher: null,
    launch: spec.launch,
    reach: {
      team: teamIdOf(root),
      seat: SEAT,
      session: SESSION,
      pane: PANE,
      address: null,
      ...(registry.session === null ? {} : { agent_session: registry.session ?? SESSION_ID }),
    },
    seat_handle: 'seat_0123456789ab',
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

function setup(spec: Spec): void {
  const text = teamText(spec);
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

type Trace = {
  created: string[];
  closed: string[];
  typed: string[];
  enters: string[];
  runs: { pane: string; command: string }[];
  renamed: { pane: string; name: string }[];
  events: string[];
};

type Scene = {
  name?: string | null;
  status?: string;
  session?: string | null;
  process?: PaneProcesses;
  screen?: string;
  /** The exit is offered and the CLI stays: the pane never returns to its shell. */
  stays?: boolean;
  /** The seat's own launch line is refused by the pane after the exit. */
  failLaunch?: boolean;
};

function world(scene: Scene = {}): { sources: UpSources; trace: Trace } {
  const trace: Trace = { created: [], closed: [], typed: [], enters: [], runs: [], renamed: [], events: [] };
  const made = new Map<string, string>();
  const madeSpaces = new Map<string, string[]>();
  const screen = scene.screen;
  // The bare CLI is at its shell from the moment the exit word is typed, until the launch
  // command runs in the same pane. A scene that stays never makes that reading.
  let atShell = false;
  const agents = (): HerdrAgent[] | null => [{
    name: scene.name === undefined ? null : scene.name,
    agent: 'claude',
    pane: PANE,
    workspace: WORKSPACE,
    status: scene.status ?? 'idle',
    cwd: root,
    ...(scene.session === null ? {} : { session: scene.session ?? SESSION_ID }),
  }];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      const pane = `made-${trace.created.length + 1}`;
      const workspace = `ws-${trace.created.length + 1}`;
      trace.created.push(label);
      trace.events.push(`create:${label}`);
      made.set(pane, CLAUDE_IDLE);
      madeSpaces.set(workspace, [pane]);
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      trace.runs.push({ pane, command });
      trace.events.push(`run:${pane}`);
      if (scene.failLaunch === true && command.includes('team-deepseek')) return false;
      made.set(pane, CLAUDE_IDLE);
      if (pane === PANE) atShell = false;
      return true;
    },
    typeText(_session, pane, text) {
      trace.typed.push(text);
      trace.events.push(`type:${pane}:${text}`);
      if (pane === PANE && text === EXIT_TEXT && scene.stays !== true) atShell = true;
      return true;
    },
    pressEnter(_session, pane) {
      trace.enters.push(pane);
      trace.events.push(`enter:${pane}`);
      return true;
    },
    sendKey(_session, pane, key) {
      trace.events.push(`key:${pane}:${key}`);
      return true;
    },
    renameWorkspace: () => true,
    renameAgent(_session, pane, name) {
      trace.renamed.push({ pane, name });
      return true;
    },
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      trace.events.push(`close:${workspace}`);
      return true;
    },
    agentPanes: () => [PANE, ...made.keys()],
    agents,
    workspacePanes(_session, workspace) {
      if (workspace === WORKSPACE) return [PANE];
      return madeSpaces.get(workspace) ?? null;
    },
    paneText: (_session, pane) => (pane === PANE && screen !== undefined ? screen : made.get(pane) ?? CLAUDE_IDLE),
    foreground: () => ['claude'],
    processInfo: (_session, pane) => {
      if (pane !== PANE) return { shell: 500, foreground: [500] };
      const shell = atShell;
      trace.events.push(`process:${pane}:${shell ? 'shell' : 'cli'}`);
      if (shell) return SHELL;
      return scene.process ?? RESTORED;
    },
    sleep: async () => {},
    now: () => NOW,
  };
  recordRenames(launch);
  const doctor: DoctorSources = {
    version: () => '2.1.288',
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
      workspaces: () => [{ id: WORKSPACE, label: SEAT }],
      home,
      doctor,
      launch,
      now: () => NOW,
    },
    trace,
  };
}

const seatState = () => readState(dir).sessions[SESSION]?.seats[SEAT];
const seatCreated = (trace: Trace): string[] => trace.created.filter((label) => label === SEAT);
const seatRuns = (trace: Trace): Trace['runs'] =>
  trace.runs.filter((run) => !/\/src\/cli\.ts (watch|bus)\b/.test(run.command));
const firstWord = (command: string): string => command.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, '').split(/\s/)[0] ?? '';

const readyRecord = { stage: 'ready' as const, pane: PANE, workspace: WORKSPACE, launched: RECORDED };

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'c75-own-line-')));
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

test('a wrapper seat with a proven session is relaunched in its own pane through its own line', async () => {
  setup(WRAPPER);
  recordSeat(WRAPPER, { ...readyRecord, agent_session: SESSION_ID });
  const made = world();
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `${io.out}\n${io.err}`).toBe(0);

  expect(made.trace.closed).toEqual([]);
  expect(seatCreated(made.trace)).toEqual([]);
  expect(seatRuns(made.trace)).toHaveLength(1);
  const command = seatRuns(made.trace)[0]?.command ?? '';
  expect(seatRuns(made.trace)[0]?.pane).toBe(PANE);
  expect(firstWord(command)).toBe('team-deepseek');
  expect(command).not.toMatch(/(?:^|\s)claude(?:\s|$)/);
  expect(command).toContain(`--resume ${SESSION_ID}`);

  const typedAt = made.trace.events.indexOf(`type:${PANE}:${EXIT_TEXT}`);
  const ranAt = made.trace.events.indexOf(`run:${PANE}`);
  expect(typedAt).toBeGreaterThanOrEqual(0);
  expect(ranAt).toBeGreaterThan(typedAt);
  const shellAt = made.trace.events.findIndex((event, index) => index > typedAt && index < ranAt && event === `process:${PANE}:shell`);
  expect(shellAt).toBeGreaterThan(typedAt);
  expect(made.trace.renamed).toEqual([{ pane: PANE, name: SEAT }]);

  expect(seatState()).toMatchObject({ stage: 'ready', pane: PANE, workspace: WORKSPACE });
});

test('a pane that does not return to its shell is left untouched', async () => {
  setup(WRAPPER);
  recordSeat(WRAPPER, { ...readyRecord, agent_session: SESSION_ID });
  const made = world({ stays: true });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `${io.out}\n${io.err}`).toBe(1);

  expect(made.trace.typed).toEqual([EXIT_TEXT]);
  expect(made.trace.closed).toEqual([]);
  expect(seatCreated(made.trace)).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.events.some((event) => event.startsWith(`run:${PANE}`))).toBe(false);
  expect(seatState()).toMatchObject({
    stage: 'ready',
    pane: PANE,
    workspace: WORKSPACE,
    launched: RECORDED,
    agent_session: SESSION_ID,
  });
  expect(`${io.out}${io.err}`).toContain('its pane was not back at its shell in 30 s; left as it is');
});

test('a launch that does not run after the exit keeps the seat record on its pane', async () => {
  setup(WRAPPER);
  recordSeat(WRAPPER, { ...readyRecord, agent_session: SESSION_ID });
  const made = world({ failLaunch: true });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `${io.out}\n${io.err}`).toBe(1);

  expect(made.trace.typed).toEqual([EXIT_TEXT]);
  expect(seatRuns(made.trace)).toHaveLength(1);
  expect(seatRuns(made.trace)[0]?.pane).toBe(PANE);
  expect(firstWord(seatRuns(made.trace)[0]?.command ?? '')).toBe('team-deepseek');
  expect(made.trace.closed).toEqual([]);
  expect(seatCreated(made.trace)).toEqual([]);
  expect(seatState()).toMatchObject({
    stage: 'launched',
    pane: PANE,
    workspace: WORKSPACE,
    launched: RECORDED,
    agent_session: SESSION_ID,
  });
  expect(findAgent(home, { team: teamIdOf(root), seat: SEAT })?.lifecycle).toBe('running');
});

test('a plain seat with a proven session is still adopted in place', async () => {
  setup(BARE);
  recordSeat(BARE, { ...readyRecord, agent_session: SESSION_ID });
  const made = world();
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `${io.out}\n${io.err}`).toBe(0);

  expect(made.trace.renamed).toEqual([{ pane: PANE, name: SEAT }]);
  expect(made.trace.closed).toEqual([]);
  expect(seatCreated(made.trace)).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.typed).toEqual([]);
  expect(seatState()?.pane).toBe(PANE);
  expect(seatState()?.launched).toEqual({ shell: RESTORED.shell, cli: RESTORED.foreground });
  expect(seatState()?.agent_session).toBe(SESSION_ID);
});

test('a working turn refuses the relaunch and closes nothing', async () => {
  setup(WRAPPER);
  recordSeat(WRAPPER, { ...readyRecord, agent_session: SESSION_ID });
  const made = world({ status: 'working' });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `${io.out}\n${io.err}`).toBe(0);

  expect(made.trace.closed).toEqual([]);
  expect(seatCreated(made.trace)).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.typed).toEqual([]);
  expect(seatState()?.launched).toEqual(RECORDED);
  expect(seatState()?.pane).toBe(PANE);
  expect(`${io.out}${io.err}`).toContain('the process in its pane is working; nothing closed');
});

test('unsent text refuses the relaunch and closes nothing', async () => {
  setup(WRAPPER);
  recordSeat(WRAPPER, { ...readyRecord, agent_session: SESSION_ID });
  const made = world({ screen: claudeBox(EXIT_TEXT) });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `${io.out}\n${io.err}`).toBe(1);

  expect(made.trace.closed).toEqual([]);
  expect(seatCreated(made.trace)).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.typed).toEqual([]);
  expect(seatState()?.launched).toEqual(RECORDED);
  expect(seatState()?.pane).toBe(PANE);
  expect(`${io.out}${io.err}`).toContain(
    `the process in its pane holds unsent text; nothing closed (send or clear it there, or run team remove ${SEAT})`,
  );
});

test('a launch line that cannot carry the conversation holds and closes nothing', async () => {
  const other: Spec = { ...WRAPPER, launch: `team-deepseek --resume ${OTHER_SESSION}` };
  setup(other);
  recordSeat(other, { ...readyRecord, agent_session: SESSION_ID });
  const made = world();
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `${io.out}\n${io.err}`).toBe(1);

  expect(made.trace.closed).toEqual([]);
  expect(seatCreated(made.trace)).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.typed).toEqual([]);
  expect(made.trace.renamed).toEqual([]);
  expect(seatState()?.launched).toEqual(RECORDED);
  expect(`${io.out}${io.err}`).toContain(
    'its recorded conversation cannot be resumed: its launch line resumes a different conversation; left as it is',
  );
});

test('an unnamed drifted pane keeps the conversation the records name', async () => {
  setup(WRAPPER);
  recordSeat(WRAPPER, { ...readyRecord, agent_session: SESSION_ID }, { session: null });
  const made = world({
    process: { shell: RECORDED.shell, foreground: RECORDED.cli },
    screen: DRIFTED,
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `${io.out}\n${io.err}`).toBe(0);

  expect(made.trace.closed).toEqual([WORKSPACE]);
  expect(seatCreated(made.trace)).toEqual([SEAT]);
  expect(seatRuns(made.trace)).toHaveLength(1);
  const command = seatRuns(made.trace)[0]?.command ?? '';
  expect(firstWord(command)).toBe('team-deepseek');
  expect(command).toContain(`--resume ${SESSION_ID}`);
});

test('a drifted model on a pane whose name the restore cleared is matched and relaunched', async () => {
  setup(WRAPPER);
  recordSeat(WRAPPER, readyRecord, { session: null });
  const made = world({
    process: { shell: RECORDED.shell, foreground: RECORDED.cli },
    session: null,
    screen: DRIFTED,
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `${io.out}\n${io.err}`).toBe(0);

  expect(made.trace.closed).toEqual([WORKSPACE]);
  expect(seatCreated(made.trace)).toEqual([SEAT]);
  expect(seatRuns(made.trace)).toHaveLength(1);
  const command = seatRuns(made.trace)[0]?.command ?? '';
  expect(firstWord(command)).toBe('team-deepseek');
  expect(command).not.toContain('--resume');
  expect(made.trace.renamed).toEqual([{ pane: 'made-1', name: SEAT }]);
  expect(seatState()?.pane).toBe('made-1');
});
