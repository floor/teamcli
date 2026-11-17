// `team up --retie` on an agy seat whose record stopped at `launched` with no conversation id on
// either side (floor's tester-gemini after the 2026-11-17 restart): the pane in the seat's own
// worktree, agy alone in its workspace at an idle prompt drawing the permission-mode hint, is
// re-tied; the same pane outside the worktree, or claimed by another record, is not. Synthetic.
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
const IDLE = readFileSync(new URL('./fixtures/antigravity/1.5.10/idle-auto-mode.txt', import.meta.url), 'utf8');
const UNSENT = readFileSync(new URL('./fixtures/codex/0.161.0/unsent.txt', import.meta.url), 'utf8');

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;
let seatCwd: string | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function teamText(): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
trust:
  - ${lobby}
  - ${root}
${seatCwd !== undefined && seatCwd.startsWith('../') ? `  - ${join(root, seatCwd)}\n` : ''}workspace:
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
    cli: antigravity
    vendor: google
    model: Gemini Flash
    version: "3.8"
    launch: agy
${seatCwd === undefined ? '' : `    cwd: ${seatCwd}\n`}`;
}

function ownedUrl(): string {
  const socket = codexEndpointSocket(dir, SESSION, SEAT, BINDING);
  if (socket === null) throw new Error('the fixture state folder is too long for an owned endpoint path');
  return socket.url;
}

function record(opts: { session?: string | null; endpoint?: boolean; stage?: 'ready' | 'launched'; registrySession?: string | null } = {}): void {
  const session = opts.session === undefined ? THREAD : opts.session;
  const registrySession = opts.registrySession === undefined ? session : opts.registrySession;
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
      ...(endpoint
        ? {
            presence_binding: BINDING,
            codex_endpoint: { url: ownedUrl(), binding: BINDING, pid: 4242, started_at: NOW.toISOString() },
          }
        : {}),
    };
  });
  registerAgent(home, {
    name: SEAT,
    signing: { model: 'Gemini Flash', version: '3.8', role: 'implementer' },
    lab: 'google',
    cli: 'antigravity',
    launcher: null,
    launch: 'agy',
    reach: {
      team: teamIdOf(root),
      seat: SEAT,
      session: SESSION,
      pane: PANE,
      address: null,
      ...(registrySession === null ? {} : { agent_session: registrySession }),
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
  cwd?: string;
};

function sources(scene: Scene = {}): { sources: UpSources; trace: Trace } {
  const trace: Trace = { created: [], closed: [], typed: [], runs: [], renamed: [], managed: [] };
  let exited = false;
  let listedName = scene.name === undefined ? null : scene.name;
  const agents = (): HerdrAgent[] | null => [{
    name: listedName,
    agent: 'agy',
    pane: PANE,
    workspace: SPACE,
    status: scene.status ?? 'idle',
    cwd: scene.cwd ?? root,
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
    foreground: () => (exited ? ['zsh'] : ['agy']),
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
  seatCwd = undefined;
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


const RETIE = ['--retie'];

function worktree(): string {
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const seat = loaded.team.seats.find((candidate) => candidate.name === SEAT);
  if (seat === undefined || seat.cwd === '.') throw new Error('the fixture seat has no folder of its own');
  const folder = join(root, seat.cwd);
  mkdirSync(folder, { recursive: true });
  return realpathSync(folder);
}

test('--retie re-ties an unready id-less agy seat in its own worktree and records it ready', async () => {
  seatCwd = 'worktrees/worker';
  setup();
  record({ session: null, endpoint: false, stage: 'launched' });
  const made = sources({ name: null, session: null, cwd: worktree() });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp(RETIE, io, made.sources), said(io)).toBe(0);
  expect(made.trace.typed).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.renamed).toEqual([{ pane: PANE, name: SEAT }]);
  expect(seatState()?.stage).toBe('ready');
});

test('--retie leaves the same pane outside the seat\'s worktree untied', async () => {
  seatCwd = 'worktrees/worker';
  setup();
  record({ session: null, endpoint: false, stage: 'launched' });
  worktree();
  const made = sources({ name: null, session: null, cwd: root });
  const io = testIo(root, { kind: 'owner' });
  await runUp(RETIE, io, made.sources);
  expect(made.trace.renamed).toEqual([]);
  expect(seatState()?.stage).toBe('launched');
});

const OTHER_ID = '019a0000-aaaa-7bbb-8ccc-000000000009';

test('state naming A and the registry naming B is a refusal, never the id-less case', async () => {
  seatCwd = 'worktrees/worker';
  setup();
  record({ session: THREAD, registrySession: OTHER_ID, endpoint: false, stage: 'launched' });
  const made = sources({ name: null, session: null, cwd: worktree() });
  const io = testIo(root, { kind: 'owner' });
  await runUp(RETIE, io, made.sources);
  expect(made.trace.renamed).toEqual([]);
  expect(seatState()?.stage).toBe('launched');
});

test('a registry binding refused as no session token is not the id-less case', async () => {
  seatCwd = 'worktrees/worker';
  setup();
  record({ session: null, registrySession: 'not a session token', endpoint: false, stage: 'launched' });
  const made = sources({ name: null, session: null, cwd: worktree() });
  const io = testIo(root, { kind: 'owner' });
  await runUp(RETIE, io, made.sources);
  expect(made.trace.renamed).toEqual([]);
  expect(seatState()?.stage).toBe('launched');
});
