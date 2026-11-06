// Independent verification of C7.5 item 11: a restored Codex seat whose managed endpoint died is
// relaunched in its own pane (src/commands/up.ts, src/launch/execute.ts). The Codex binary, the
// endpoint socket, the pid and the clock are synthetic. No live host, CLI, or process signal
// is invoked.
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
const IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol')
  .replace('GPT-5.6-Terra', 'GPT-6.1-Sol');
const UNSENT = readFileSync(new URL('./fixtures/codex/0.161.0/unsent.txt', import.meta.url), 'utf8');

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
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
`;
}

function ownedUrl(): string {
  const socket = codexEndpointSocket(dir, SESSION, SEAT, BINDING);
  if (socket === null) throw new Error('the fixture state folder is too long for an owned endpoint path');
  return socket.url;
}

function record(opts: { session?: string | null; endpoint?: boolean } = {}): void {
  const session = opts.session === undefined ? THREAD : opts.session;
  const endpoint = opts.endpoint !== false;
  updateState(dir, (state) => {
    const held = (state.sessions[SESSION] ??= emptySession());
    held.seats[SEAT] = {
      stage: 'ready',
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
    signing: { model: 'GPT Sol', version: '6.1', role: 'implementer' },
    lab: 'openai',
    cli: 'codex',
    launcher: null,
    launch: 'codex -m gpt-6.1-sol',
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
  const agents = (): HerdrAgent[] | null => [{
    name: scene.name === undefined ? null : scene.name,
    agent: 'codex',
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
    foreground: () => (exited ? ['zsh'] : ['codex']),
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

test('a dead endpoint relaunches the seat in place on a freshly ensured endpoint', async () => {
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
  expect(firstWord(seatRuns(made.trace)[0]?.command ?? '')).toBe('codex');
  expect(seatRuns(made.trace)[0]?.command).toContain(`resume ${THREAD}`);
  expect(seatRuns(made.trace)[0]?.command).toContain(`--remote ${APP_URL}`);
  expect(made.trace.managed).toEqual([{ dir, seat: SEAT }]);
  expect(seatState()?.stage).toBe('ready');
  expect(seatState()?.pane).toBe(PANE);
  expect(seatState()?.workspace).toBe(SPACE);
});

test('a name-cleared seat whose endpoint died is relaunched in place without a resume', async () => {
  setup();
  record({ session: null });
  const made = sources({ name: null, session: null });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.typed).toEqual(['/exit']);
  expect(made.trace.closed).toEqual([]);
  expect(seatRuns(made.trace)).toHaveLength(1);
  expect(seatRuns(made.trace)[0]?.pane).toBe(PANE);
  expect(firstWord(seatRuns(made.trace)[0]?.command ?? '')).toBe('codex');
  expect(seatRuns(made.trace)[0]?.command).not.toContain('resume');
  expect(seatRuns(made.trace)[0]?.command).toContain(`--remote ${APP_URL}`);
  expect(made.trace.managed).toEqual([{ dir, seat: SEAT }]);
  expect(seatState()?.stage).toBe('ready');
  expect(seatState()?.pane).toBe(PANE);
});

test('an endpoint that will not start leaves the seat out, with no --no-daemon launch', async () => {
  setup();
  record();
  const made = sources({
    name: SEAT,
    managed: { kind: 'unmanaged', why: 'the app-server could not start' },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).not.toBe(0);
  expect(made.trace.typed).toEqual(['/exit']);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(said(io)).toContain('the managed Codex endpoint was not started: the app-server could not start');
  expect(seatState()?.stage).toBe('launched');
  expect(seatState()?.pane).toBe(PANE);
});

test('a live endpoint is adopted and never relaunched', async () => {
  setup();
  record({ session: null });
  const made = sources({ name: null, session: null, socket: true, alive: true });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.typed).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.managed).toEqual([]);
  expect(made.trace.closed).toEqual([]);
  expect(made.trace.renamed).toEqual([{ pane: PANE, name: SEAT }]);
  expect(seatState()?.stage).toBe('ready');
  expect(seatState()?.pane).toBe(PANE);
});

test('an absent endpoint record is relaunched onto a fresh one', async () => {
  setup();
  record({ session: null, endpoint: false });
  const made = sources({ name: null, session: null, socket: true, alive: true });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.typed).toEqual(['/exit']);
  expect(seatRuns(made.trace)).toHaveLength(1);
  expect(seatRuns(made.trace)[0]?.command).toContain(`--remote ${APP_URL}`);
  expect(seatRuns(made.trace)[0]?.command).not.toContain('--no-daemon');
  expect(made.trace.managed).toEqual([{ dir, seat: SEAT }]);
  expect(seatState()?.stage).toBe('ready');
  expect(seatState()?.pane).toBe(PANE);
});

test('an unreadable endpoint start is adopted', async () => {
  setup();
  record({ session: null });
  const made = sources({ name: null, session: null, socket: true, alive: true, startOf: null });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.typed).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.managed).toEqual([]);
  expect(made.trace.renamed).toEqual([{ pane: PANE, name: SEAT }]);
});

test('a working pane with a dead endpoint is left untouched', async () => {
  setup();
  record();
  const made = sources({ name: SEAT, status: 'working' });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(0);
  expect(made.trace.typed).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.closed).toEqual([]);
  expect(made.trace.managed).toEqual([]);
  expect(said(io)).toContain('the process in its pane is working; nothing closed');
  expect(seatState()?.pane).toBe(PANE);
  expect(seatState()?.launched).toEqual(RECORDED);
});

test('unsent text with a dead endpoint is left untouched', async () => {
  setup();
  record();
  const made = sources({ name: SEAT, screen: UNSENT });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(1);
  expect(made.trace.typed).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.managed).toEqual([]);
  expect(made.trace.closed).toEqual([]);
  expect(said(io)).toContain(`the process in its pane holds unsent text; nothing closed (send or clear it there, or run team remove ${SEAT})`);
  expect(seatState()?.pane).toBe(PANE);
  expect(seatState()?.launched).toEqual(RECORDED);
});

test('an exit the pane never answers leaves the record untouched', async () => {
  setup();
  record();
  const made = sources({ name: SEAT, process: RESTORED });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(1);
  expect(made.trace.typed).toEqual(['/exit']);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.managed).toEqual([]);
  expect(made.trace.closed).toEqual([]);
  expect(said(io)).toContain('its pane was not back at its shell in 30 s; left as it is');
  expect(seatState()?.stage).toBe('ready');
  expect(seatState()?.pane).toBe(PANE);
  expect(seatState()?.launched).toEqual(RECORDED);
  expect(seatState()?.codex_endpoint?.url).toBe(ownedUrl());
});

test('a pane named for another seat is left untouched', async () => {
  setup();
  record();
  const made = sources({ name: OTHER });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), said(io)).toBe(1);
  expect(made.trace.typed).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.managed).toEqual([]);
  expect(made.trace.closed).toEqual([]);
  expect(made.trace.renamed).toEqual([]);
  expect(said(io)).toContain(`its pane is named ${OTHER}; team never adopts a pane another seat owns`);
  expect(seatState()?.pane).toBe(PANE);
  expect(seatState()?.launched).toEqual(RECORDED);
});
