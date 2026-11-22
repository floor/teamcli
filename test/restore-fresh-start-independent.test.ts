// A restored seat whose CLI has no measured resume form. When its pane holds no CLI, the repair
// starts fresh from the recorded line: one warning, one log line, and the record keeps no resume
// id. The same seat while its CLI is still in the pane is left there, and nothing is closed. A
// line that names another conversation keeps the refusal. Homes and panes are synthetic.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { LOG_FILE, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, recordRenames, testIo } from './helpers.ts';

const CURSOR_IDLE = readFileSync(new URL('./fixtures/cursor/2026.10.16/idle.txt', import.meta.url), 'utf8');
const NOW = new Date('2026-11-09T09:00:00Z');
const SESSION = 'crate';
const CONVERSATION = 'conversation-slate';
const OTHER = 'conversation-other';
const FRESH = 'started fresh: its CLI cannot resume the recorded conversation';
const RECORDED: PaneProcesses = { shell: 100, foreground: [200] };
const SHELL: PaneProcesses = { shell: 100, foreground: [100] };

const owned: string[] = [];
afterEach(() => {
  const paths = owned.splice(0);
  discardFixtures(paths, { roots: paths.map((path) => dirname(path)) });
});

type CapturedSeat = Record<string, unknown>;
type CapturedSession = { seats: Record<string, CapturedSeat> } & Record<string, unknown>;

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

function readyCaptured(): CapturedSeat {
  const found = Object.values(capturedSession().seats).find((seat) => seat.stage === 'ready');
  if (found === undefined) throw new Error('the captured session has no ready seat');
  return structuredClone(found);
}

type SeatSpec = {
  name: string;
  pane: string;
  workspace: string;
  cli: string;
  launch: string;
  vendor: string;
  model: string;
  version: string;
  session: string;
};

type Scene = { root: string; home: string; dir: string; own: string; spec: SeatSpec };

function scene(spec: SeatSpec): Scene {
  const base = fixtureBase('.restore-fresh-start-');
  owned.push(base);
  const root = join(base, 'crate');
  const home = join(base, 'home');
  const own = join(base, 'worktrees', spec.name);
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(own, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  const lobby = lobbyDir(home);
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  chmodSync(lobby, 0o700);
  const text = `format: 1
project: crate
coordinator: lead
operator: lead
session: ${SESSION}
trust:
  - ${JSON.stringify(lobby)}
  - ${JSON.stringify(root)}
  - ${JSON.stringify(own)}
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
    name: ${spec.name}
    label: ${spec.name}
    cli: ${spec.cli}
    vendor: ${spec.vendor}
    model: ${spec.model}
    version: "${spec.version}"
    launch: ${spec.launch}
    cwd: ${JSON.stringify(relative(root, own))}
`;
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
  const id = teamIdOf(root);
  const agent = registerAgent(home, {
    name: spec.name,
    signing: { model: spec.model, version: spec.version, role: 'implementer' },
    lab: spec.vendor,
    cli: spec.cli,
    launcher: null,
    launch: spec.launch,
    reach: {
      team: id,
      seat: spec.name,
      session: SESSION,
      pane: spec.pane,
      address: null,
      agent_session: spec.session,
    },
    seat_handle: 'seat_0123456789ab',
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  upsertTeam(home, id, {
    project: 'crate',
    entity: 'box',
    session: SESSION,
    root,
    lobby,
    roster: [{ agent: agent.id, seat: spec.name, role: 'implementer', leads: false }],
    lifecycle: 'running',
  });
  const shape = capturedSession();
  const held = readyCaptured();
  held.stage = 'ready';
  held.pane = spec.pane;
  held.workspace = spec.workspace;
  held.launched = { shell: RECORDED.shell, cli: [...RECORDED.foreground] };
  held.cli = spec.cli;
  held.launch_line = spec.launch;
  held.model = spec.model;
  held.version = spec.version;
  held.agent_session = spec.session;
  held.start_cwd = own;
  shape.seats = { [spec.name]: held };
  shape.watch = capturedWatch();
  shape.launched_file = join(dir, 'team.yaml');
  updateState(dir, (state) => {
    state.sessions[SESSION] = shape as never;
  });
  return { root, home, dir, own, spec };
}

type Trace = { typed: string[]; runs: { pane: string; command: string }[]; closed: string[] };

function hostFor(made: Scene, live: PaneProcesses): { sources: UpSources; trace: Trace } {
  const trace: Trace = { typed: [], runs: [], closed: [] };
  const { spec } = made;
  // A launch leaves the pane holding its own CLI. Until that run, the pane is the reading
  // the scene passed in, so a CLI that is already in front is never replaced.
  let running = false;
  const started: PaneProcesses = { shell: 300, foreground: [301] };
  const agents = (): HerdrAgent[] => [{
    name: spec.name,
    agent: spec.cli,
    pane: spec.pane,
    workspace: spec.workspace,
    status: 'idle',
    cwd: made.own,
    session: spec.session,
  }];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'pane-made', workspace: 'ws-made' }),
    paneRun(_session, pane, command) {
      trace.runs.push({ pane, command });
      if (pane === spec.pane) running = true;
      return true;
    },
    typeText(_session, _pane, text) {
      trace.typed.push(text);
      return true;
    },
    pressEnter: () => true,
    renameWorkspace: () => true,
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    agentPanes: () => [spec.pane],
    agents,
    workspacePanes: () => [spec.pane],
    paneText: () => (running && spec.cli === 'cursor' ? CURSOR_IDLE : ''),
    foreground: () => {
      const proc = running ? started : live;
      if (!proc.foreground.some((pid) => pid !== proc.shell)) return [];
      return [spec.cli === 'cursor' ? 'cursor-agent' : 'claude'];
    },
    processInfo: () => (running ? started : live),
    sleep: async () => {},
    now: () => NOW,
  };
  recordRenames(launch);
  const doctor: DoctorSources = {
    version: () => '0.0.0-test',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.0.0-test',
    sessionRunning: () => true,
    now: () => NOW,
    home: made.home,
  };
  return {
    sources: {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents,
      workspaces: () => [{ id: spec.workspace, label: spec.name }],
      home: made.home,
      doctor,
      launch,
      now: () => NOW,
      sleep: async () => {},
    },
    trace,
  };
}

function seatRuns(trace: Trace): Trace['runs'] {
  return trace.runs.filter((run) => !/\/src\/cli\.ts (watch|bus)\b/.test(run.command));
}

function times(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const cursor = (): SeatSpec => ({
  name: 'pebble',
  pane: 'pane-pebble',
  workspace: 'ws-pebble',
  cli: 'cursor',
  launch: 'cursor-agent',
  vendor: 'cursor',
  model: 'Grok',
  version: '4.7',
  session: CONVERSATION,
});

test('a restored seat with no resume form and no CLI in its pane starts fresh from its recorded line', async () => {
  const made = scene(cursor());
  const host = hostFor(made, SHELL);
  const io = testIo(made.root, { kind: 'owner' });
  expect(await runUp([], io, host.sources), `${io.out}\n${io.err}`).toBe(0);
  const runs = seatRuns(host.trace);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.pane).toBe('pane-pebble');
  expect(runs[0]?.command.includes('cursor-agent')).toBe(true);
  expect(runs[0]?.command.includes(CONVERSATION)).toBe(false);
  expect(runs[0]?.command.includes('--resume')).toBe(false);
  expect(times(`${io.out}\n${io.err}`, FRESH)).toBe(1);
  const logged = readFileSync(join(made.dir, LOG_FILE), 'utf8');
  expect(times(logged, FRESH)).toBe(1);
  const left = readState(made.dir).sessions[SESSION]?.seats.pebble;
  expect(left?.launch_line).toBe('cursor-agent');
  expect(String(left?.launch_line ?? '').includes(CONVERSATION)).toBe(false);
  expect(host.trace.closed).toEqual([]);
});

test('the same seat is not closed while its CLI is still running in the pane', async () => {
  const made = scene(cursor());
  const host = hostFor(made, RECORDED);
  const io = testIo(made.root, { kind: 'owner' });
  expect(await runUp([], io, host.sources), `${io.out}\n${io.err}`).toBe(0);
  expect(seatRuns(host.trace)).toEqual([]);
  expect(host.trace.typed).toEqual([]);
  expect(host.trace.closed).toEqual([]);
  expect(`${io.out}\n${io.err}`.includes(FRESH)).toBe(false);
  const left = readState(made.dir).sessions[SESSION]?.seats.pebble;
  expect(left?.stage).toBe('ready');
  expect(left?.pane).toBe('pane-pebble');
  expect(left?.agent_session).toBe(CONVERSATION);
});

test('a launch line that names another conversation keeps the refusal', async () => {
  const made = scene({
    name: 'cobble',
    pane: 'pane-cobble',
    workspace: 'ws-cobble',
    cli: 'claude-code',
    launch: `claude --resume ${OTHER}`,
    vendor: 'anthropic',
    model: 'Claude Opus',
    version: '5.5',
    session: CONVERSATION,
  });
  const host = hostFor(made, SHELL);
  const io = testIo(made.root, { kind: 'owner' });
  expect(await runUp([], io, host.sources), `${io.out}\n${io.err}`).toBe(1);
  const reason = 'its launch line resumes a different conversation';
  expect(`${io.out}\n${io.err}`.includes(reason)).toBe(true);
  expect(`${io.out}\n${io.err}`.includes(FRESH)).toBe(false);
  expect(seatRuns(host.trace)).toEqual([]);
  expect(host.trace.closed).toEqual([]);
  const left = readState(made.dir).sessions[SESSION]?.seats.cobble;
  expect(left?.launch_line).toBe(`claude --resume ${OTHER}`);
  expect(left?.agent_session).toBe(CONVERSATION);
  expect(left?.pane).toBe('pane-cobble');
});
