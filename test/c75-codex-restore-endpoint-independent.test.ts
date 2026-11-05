// A Codex seat a terminal-host restore brings back still runs its CLI, but the managed app-server
// its launch owned died with the host. Adopting the pane (the restore sweep's "restored and
// re-tied" path) would leave the seat on Codex's own endpoint, so `team up` relaunches it in
// place instead: the pane's CLI is exited cleanly, nothing is closed or made, and the seat's own
// launch line runs in the same pane — the launch then ensures a fresh endpoint and attaches to it
// with `--remote`, or falls back to `--no-daemon` when it cannot start. A seat whose recorded
// endpoint is still live is adopted exactly as before, and an unreadable liveness reading is
// never repaired on a guess. The exit timeout, a working pane and an unsent box keep the guards
// the own-line path already has.
//
// Every pane, socket, pid and home here is synthetic; no live herdr session or CLI home is read.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { codexEndpointSocket, type ManagedEndpointRead } from '../src/launch/codex-endpoint.ts';
import { findAgent, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, shortSocketBase, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T03:20:00Z');
const SESSION = 'acme';
const SEAT = 'worker';
const HANDLE = 'seat_0123456789ab';
const BINDING = 'prs_0123456789ab';
const THREAD = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
// Neutral place ids: a restore keeps the pane and the workspace, never a name.
const PANE = 'pane-restored';
const WORKSPACE = 'ws-restored';
// The record a managed launch wrote before the host restore: places, pids and the endpoint.
const RECORD = { stage: 'ready' as const, id: HANDLE, pane: PANE, workspace: WORKSPACE, launched: { shell: 100, cli: [200] } };
// The pids the pane holds now: the host restored the process, so they are not the launched ones.
const RESTORED: PaneProcesses = { shell: 101, foreground: [201] };
// The endpoint a fresh managed launch hands back in this scene.
const APP_URL = 'unix:///private/tmp/scene-app.sock';
// The captured idle screen, with the banner naming the model this scene's file declares.
const IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol')
  .replace('GPT-5.6-Terra', 'GPT-6.1-Sol');

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

/** One launchable Codex seat, alone in its team. The lead is a human pane, so the seat under
 *  test is never a lead: a lead's model drift is refused, never cycled. */
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

/** The URL the seat's own managed launch owns for `BINDING`. */
function ownedUrl(): string {
  const socket = codexEndpointSocket(dir, SESSION, SEAT, BINDING);
  if (socket === null) throw new Error('the fixture state folder is too long for an owned endpoint path');
  return socket.url;
}

/** The state and the registry record the launch left. `session` is the conversation both sides
 *  name; null leaves both sides sessionless (the weak, `cli` proof). */
function record(opts: { session?: string | null } = {}): void {
  const session = opts.session === undefined ? THREAD : opts.session;
  updateState(dir, (state) => {
    const held = (state.sessions[SESSION] ??= emptySession());
    held.seats[SEAT] = {
      ...RECORD,
      ...(session === null ? {} : { agent_session: session }),
      presence_binding: BINDING,
      codex_endpoint: { url: ownedUrl(), binding: BINDING, pid: 4242, started_at: NOW.toISOString() },
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
  /** The entry's name: null (the restore cleared it) unless a scene says otherwise. */
  name?: string | null;
  /** The session the entry reports; null omits it as the host does when it reports none. */
  session?: string | null;
  status?: string;
  /** The recorded pane's process reading; the restored one unless a scene says otherwise. */
  process?: PaneProcesses;
  /** The recorded pane's screen; the idle capture unless a scene says otherwise. */
  screen?: string;
  /** The recorded endpoint's liveness, as the host's own readings would say. The default is a
   *  socket that is gone: the app-server died with the host. */
  socket?: boolean;
  alive?: boolean;
  startOf?: number | null;
  /** What a fresh managed launch hands back; `up` unless a scene says otherwise. */
  managed?: ManagedEndpointRead;
};

/** The readings one run takes: herdr lists the recorded pane (named or not) and the process in
 *  it is the restored one, replaced against the record. */
function sources(scene: Scene = {}): { sources: UpSources; trace: Trace } {
  const trace: Trace = { created: [], closed: [], typed: [], runs: [], renamed: [], managed: [] };
  const made = new Map<string, string>();
  const madeSpaces = new Map<string, string[]>();
  // The CLI the restore left was exited by the run's own typing: the pane is its shell alone
  // from then until the seat's launch command runs in it.
  let exited = false;
  const agents = (): HerdrAgent[] | null => [{
    name: scene.name === undefined ? null : scene.name,
    agent: 'codex',
    pane: PANE,
    workspace: WORKSPACE,
    status: scene.status ?? 'idle',
    cwd: root,
    ...(scene.session === null ? {} : { session: scene.session ?? THREAD }),
  }];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      const pane = `made-${trace.created.length + 1}`;
      const workspace = `ws-${trace.created.length + 1}`;
      trace.created.push(label);
      made.set(pane, IDLE);
      madeSpaces.set(workspace, [pane]);
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      trace.runs.push({ pane, command });
      made.set(pane, IDLE);
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
    agentPanes: () => [PANE, ...made.keys()],
    agents,
    workspacePanes(_session, workspace) {
      if (workspace === WORKSPACE) return [PANE];
      return madeSpaces.get(workspace) ?? null;
    },
    paneText: (_session, pane) => (pane === PANE && scene.screen !== undefined ? scene.screen : made.get(pane) ?? IDLE),
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
      workspaces: () => [{ id: WORKSPACE, label: SEAT }],
      home,
      doctor,
      launch,
      now: () => NOW,
      // The endpoint liveness seam: the same three readings `team check` judges a managed
      // endpoint by. The default record names a socket that is gone.
      codexEndpoint: {
        alive: () => scene.alive ?? false,
        startOf: () => (scene.startOf === undefined ? NOW.getTime() - 30_000 : scene.startOf),
        isSocket: () => scene.socket ?? false,
      },
    },
    trace,
  };
}

/** What the run left in the seat's record. */
const seatState = () => readState(dir).sessions[SESSION]?.seats[SEAT];

/** Effects on the seat alone: a run also starts the team's watch, in a workspace of its own. */
const seatCreated = (trace: Trace): string[] => trace.created.filter((label) => label === SEAT);
/** The commands run in a pane other than the team's own watch or bus. */
const seatRuns = (trace: Trace): Trace['runs'] =>
  trace.runs.filter((run) => !/\/src\/cli\.ts (watch|bus)\b/.test(run.command));
/** A launch line's first word, after any environment assignments the launcher prefixes. */
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
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

test('a named restored Codex seat whose endpoint died is relaunched in place and attached to a fresh one', async () => {
  setup();
  record();
  // The plan exits Codex in its recorded pane and launches the seat again there: no workspace is
  // closed, none is made, and the conversation the records name is carried.
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, sources({ name: SEAT }).sources)).toBe(0);
  expect(dry.out).not.toContain(`workspace close ${WORKSPACE}`);
  expect(dry.out).not.toContain(`--label ${SEAT}`);
  expect(dry.out).toContain(`pane run ${PANE} /exit`);
  expect(dry.out).toContain('its recorded Codex endpoint is not live; exited in place and launched again here with its own endpoint');
  expect(dry.out).toContain(`resume ${THREAD}`);
  expect(seatState()?.launched).toEqual(RECORD.launched);

  const made = sources({ name: SEAT });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  expect(made.trace.closed).toEqual([]);
  expect(seatCreated(made.trace)).toEqual([]);
  expect(made.trace.typed).toEqual(['/exit']);
  // Exactly one launch, in the recorded pane, through the seat's own binary, carrying the
  // conversation and attaching to the endpoint the launch started.
  expect(seatRuns(made.trace)).toHaveLength(1);
  expect(seatRuns(made.trace)[0]?.pane).toBe(PANE);
  expect(firstWord(seatRuns(made.trace)[0]?.command ?? '')).toBe('codex');
  expect(seatRuns(made.trace)[0]?.command).toContain(`resume ${THREAD}`);
  expect(seatRuns(made.trace)[0]?.command).toContain(`--remote ${APP_URL}`);
  expect(made.trace.managed).toEqual([{ dir, seat: SEAT }]);
  expect(made.trace.renamed).toEqual([{ pane: PANE, name: SEAT }]);
  expect(seatState()?.stage).toBe('ready');
  expect(seatState()?.pane).toBe(PANE);
  expect(seatState()?.workspace).toBe(WORKSPACE);
  expect(io.err).not.toContain('endpoint was not started');
});

test('an adopted Codex seat (name cleared, no conversation) is relaunched in place too', async () => {
  setup();
  record({ session: null });
  // The weak proof: the CLI alone in its workspace at an idle prompt. No conversation is proven,
  // so the launch carries none — but the dead endpoint still means the pane is not adopted.
  const made = sources({ name: null, session: null });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  expect(made.trace.typed).toEqual(['/exit']);
  expect(made.trace.closed).toEqual([]);
  expect(seatCreated(made.trace)).toEqual([]);
  expect(seatRuns(made.trace)).toHaveLength(1);
  expect(seatRuns(made.trace)[0]?.pane).toBe(PANE);
  expect(firstWord(seatRuns(made.trace)[0]?.command ?? '')).toBe('codex');
  expect(seatRuns(made.trace)[0]?.command).not.toContain('resume');
  expect(seatRuns(made.trace)[0]?.command).toContain(`--remote ${APP_URL}`);
  expect(made.trace.managed).toEqual([{ dir, seat: SEAT }]);
  expect(made.trace.renamed).toEqual([{ pane: PANE, name: SEAT }]);
  expect(seatState()?.stage).toBe('ready');
  expect(seatState()?.pane).toBe(PANE);
});

test('a restored seat whose recorded endpoint is still live is adopted and never relaunched', async () => {
  setup();
  record({ session: null });
  // The socket answers, the recorded pid is alive and its start instant is the record's: the
  // endpoint the seat came back on is the launch's own, so the pane is adopted as it is.
  const made = sources({ name: null, session: null, socket: true, alive: true });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  expect(made.trace.typed).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.managed).toEqual([]);
  expect(made.trace.closed).toEqual([]);
  expect(seatCreated(made.trace)).toEqual([]);
  expect(made.trace.renamed).toEqual([{ pane: PANE, name: SEAT }]);
  expect(seatState()?.stage).toBe('ready');
  expect(seatState()?.launched).toEqual({ shell: RESTORED.shell, cli: RESTORED.foreground });
});

test('a start instant this build cannot read leaves the pane adopted, never repaired on a guess', async () => {
  setup();
  record({ session: null });
  // The socket is live and the pid is alive, but the process start cannot be read: `team check`
  // says "cannot tell", and so does `team up`. Nothing is typed and nothing is launched.
  const made = sources({ name: null, session: null, socket: true, alive: true, startOf: null });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  expect(made.trace.typed).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.managed).toEqual([]);
  expect(made.trace.renamed).toEqual([{ pane: PANE, name: SEAT }]);
});

test('a working pane with a dead endpoint is left as it is, before any key is typed', async () => {
  setup();
  record();
  const made = sources({ name: SEAT, status: 'working' });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  expect(made.trace.typed).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.closed).toEqual([]);
  expect(seatCreated(made.trace)).toEqual([]);
  expect(io.err).toContain('the process in its pane is working; nothing closed');
  expect(seatState()?.launched).toEqual(RECORD.launched);
  expect(seatState()?.pane).toBe(PANE);
});

test('an exit the pane never acknowledges leaves the record and the endpoint record exactly as they were', async () => {
  setup();
  record();
  // /exit is typed, but the process reading never comes back as the shell alone: the wait runs
  // out, nothing is launched, and the record the next run reads is the one it wrote.
  const made = sources({ name: SEAT, process: RESTORED });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  expect(io.err).toContain('its pane was not back at its shell in 30 s; left as it is');
  expect(made.trace.typed).toEqual(['/exit']);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.managed).toEqual([]);
  expect(made.trace.closed).toEqual([]);
  expect(seatState()?.stage).toBe('ready');
  expect(seatState()?.pane).toBe(PANE);
  expect(seatState()?.launched).toEqual(RECORD.launched);
  expect(seatState()?.agent_session).toBe(THREAD);
  expect(seatState()?.codex_endpoint?.url).toBe(ownedUrl());
});

test('a fresh endpoint that does not come up still launches the seat, on --no-daemon', async () => {
  setup();
  record();
  const made = sources({
    name: SEAT,
    managed: { kind: 'unmanaged', why: 'the app-server could not start' },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  expect(made.trace.typed).toEqual(['/exit']);
  expect(seatRuns(made.trace)).toHaveLength(1);
  expect(seatRuns(made.trace)[0]?.pane).toBe(PANE);
  expect(firstWord(seatRuns(made.trace)[0]?.command ?? '')).toBe('codex');
  expect(seatRuns(made.trace)[0]?.command).toContain('--no-daemon');
  expect(seatRuns(made.trace)[0]?.command).not.toContain('--remote');
  expect(io.err).toContain('the managed Codex endpoint was not started: the app-server could not start');
  expect(findAgent(home, { team: teamIdOf(root), seat: SEAT })?.lifecycle).toBe('running');
  expect(seatState()?.stage).toBe('ready');
  expect(seatState()?.pane).toBe(PANE);
});
