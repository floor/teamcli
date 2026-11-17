// 17 Nov restart: a Claude Code seat behind a launcher script (an alternate endpoint: DeepSeek)
// was resumed bare by the terminal host, kept its name and pane, and every turn failed on the
// model ("There's an issue with the selected model (deepseek-flash)"). `team up` adopted it as
// "restored; left as it is". A restored launcher seat is relaunched in place from its own line,
// carrying the conversation. Synthetic CLI, pids, screens and clock; no live host or process.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { codexEndpointSocket, type ManagedEndpointRead } from '../src/launch/codex-endpoint.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { gitEnv, shortSocketBase, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T03:20:00Z');
const SESSION = 'acme';
const SEAT = 'worker';
const OTHER = 'fixture-other-seat';
const HANDLE = 'seat_0123456789ab';
const BINDING = 'prs_0123456789ab';
const THREAD = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
const PANE = 'fixture-pane-one';
const SPACE = 'fixture-space';
const RECORDED = { shell: 100, cli: [200] };
const RESTORED: PaneProcesses = { shell: 101, foreground: [201] };
const APP_URL = 'unix:///tmp/fixture-app.sock';
const CLEAN = readFileSync(new URL('./fixtures/claude-code/2.1.319/idle.txt', import.meta.url), 'utf8').replaceAll('k3-256k', 'deepseek-flash');
// The 17 Nov screen: the turn answered with the model failure, back at an idle prompt.
const FAILED = CLEAN.replace(
  '\n\n────',
  "\n⏺ There's an issue with the selected model (deepseek-flash). It may not exist or you may not have access to it. Run /model to pick a different model.\n────",
);
const IDLE = FAILED;
const WRAPPER = 'zsh claude-deepseek.sh';

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

let launchLine = WRAPPER;

function teamText(): string {
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
    vendor: deepseek
    model: DeepSeek Flash
    version: "4.0"
    launch: ${launchLine}
`;
}

function ownedUrl(): string {
  const socket = codexEndpointSocket(dir, SESSION, SEAT, BINDING);
  if (socket === null) throw new Error('the fixture state folder is too long for an owned endpoint path');
  return socket.url;
}

function record(opts: { session?: string | null; endpoint?: boolean; stage?: 'ready' | 'launched' } = {}): void {
  const session = opts.session === undefined ? THREAD : opts.session;
  const endpoint = opts.endpoint !== false;
  updateState(dir, (state) => {
    const held = (state.sessions[SESSION] ??= emptySession());
    held.seats[SEAT] = {
      stage: opts.stage ?? 'ready',
      id: HANDLE,
      pane: PANE,
      workspace: SPACE,
      launched: RECORDED,
      ...(session === null ? {} : { agent_session: session }),
      ...(endpoint ? {} : {}),
    };
  });
  registerAgent(home, {
    name: SEAT,
    signing: { model: 'DeepSeek Flash', version: '4.0', role: 'implementer' },
    lab: 'deepseek',
    cli: 'claude-code',
    launcher: null,
    launch: launchLine,
    reach: {
      team: teamIdOf(root),
      seat: SEAT,
      session: SESSION,
      pane: PANE,
      address: null,
      ...(session === null ? {} : { agent_session: session }),
    },
    seat_handle: HANDLE,
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
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

type Trace = {
  created: string[];
  closed: string[];
  typed: string[];
  runs: { pane: string; command: string }[];
  renamed: { pane: string; name: string }[];
  managed: { dir: string; seat: string }[];
};

type Scene = {
  name?: string | null;
  session?: string | null;
  status?: string;
  process?: PaneProcesses;
  screen?: string;
  socket?: boolean;
  alive?: boolean;
  startOf?: number | null;
  managed?: ManagedEndpointRead;
};

function sources(scene: Scene = {}): { sources: UpSources; trace: Trace } {
  const trace: Trace = { created: [], closed: [], typed: [], runs: [], renamed: [], managed: [] };
  let exited = false;
  let listedName = scene.name === undefined ? null : scene.name;
  const agents = (): HerdrAgent[] | null => [{
    name: listedName,
    agent: 'claude',
    pane: PANE,
    workspace: SPACE,
    status: scene.status ?? 'idle',
    cwd: root,
    ...(scene.session === null ? {} : { session: scene.session ?? THREAD }),
  }];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      trace.created.push(label);
      return { pane: 'fixture-pane-made', workspace: 'fixture-space-made' };
    },
    paneRun(_session, pane, command) {
      trace.runs.push({ pane, command });
      exited = false;
      return true;
    },
    typeText(_session, pane, text) {
      trace.typed.push(text);
      if (pane === PANE && text === '/exit') exited = true;
      return true;
    },
    pressEnter: () => true,
    sendKey: () => true,
    renameAgent(_session, pane, name) {
      trace.renamed.push({ pane, name });
      listedName = name;
      return true;
    },
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    agentPanes: () => [PANE],
    agents,
    workspacePanes: (_session, workspace) => (workspace === SPACE ? [PANE] : null),
    paneText: () => scene.screen ?? IDLE,
    foreground: () => (exited ? ['zsh'] : ['claude']),
    processInfo: (_session, pane) => {
      if (pane === PANE && scene.process !== undefined) return scene.process;
      if (pane === PANE && exited) return { shell: RESTORED.shell, foreground: [RESTORED.shell] };
      return RESTORED;
    },
    codexEndpoint: {
      async managed(input) {
        trace.managed.push({ dir: input.dir, seat: input.seat });
        return scene.managed ?? { kind: 'up', url: APP_URL, started: true };
      },
      stop: () => ({ stopped: true }),
    },
    sleep: async () => {},
    now: () => NOW,
  };
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
      workspaces: () => [{ id: SPACE, label: SEAT }],
      home,
      doctor,
      launch,
      now: () => NOW,
      codexEndpoint: {
        alive: () => scene.alive ?? false,
        startOf: () => (scene.startOf === undefined ? NOW.getTime() - 30_000 : scene.startOf),
        isSocket: () => scene.socket ?? false,
      },
    },
    trace,
  };
}

const seatState = () => readState(dir).sessions[SESSION]?.seats[SEAT];
const said = (io: { out: string; err: string }): string => `${io.out}${io.err}`;
const seatRuns = (trace: Trace): Trace['runs'] => trace.runs.filter((run) => run.pane === PANE);
const firstWord = (command: string): string => command.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, '').split(/\s/)[0] ?? '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(shortSocketBase(), 'c75ep-')));
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
  discardFixtures([base], { roots: [shortSocketBase()] });
});

test('a restored DeepSeek wrapper seat is relaunched in place through its own line', async () => {
  setup();
  record();
  const made = sources({ name: SEAT });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.typed).toEqual(['/exit']);
  expect(made.trace.closed).toEqual([]);
  expect(made.trace.created.filter((label) => label === SEAT)).toEqual([]);
  expect(seatRuns(made.trace)).toHaveLength(1);
  expect(seatRuns(made.trace)[0]?.pane).toBe(PANE);
  expect(seatRuns(made.trace)[0]?.command).toContain('claude-deepseek.sh');
  expect(seatRuns(made.trace)[0]?.command).toContain(`--resume ${THREAD}`);
  expect(said(io)).not.toContain('restored; left as it is');
  expect(seatState()?.stage).toBe('ready');
  expect(seatState()?.pane).toBe(PANE);
});

test('a restored wrapper seat whose turns do not fail is adopted where it stands', async () => {
  setup();
  record();
  const made = sources({ name: SEAT, screen: CLEAN });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.typed).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(said(io)).toContain('restored; left as it is');
});

test('a restored seat whose line is the bare CLI is still adopted where it stands', async () => {
  launchLine = 'claude --model opus';
  try {
    setup();
    record();
    const made = sources({ name: SEAT });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, made.sources), said(io)).toBe(0);
    expect(made.trace.typed).toEqual([]);
    expect(seatRuns(made.trace)).toEqual([]);
  } finally {
    launchLine = WRAPPER;
  }
});

test('a working restored wrapper seat is held, never exited', async () => {
  setup();
  record();
  const made = sources({ name: SEAT, status: 'working' });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.typed).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(said(io)).toContain('the process in its pane is working; nothing closed');
});
