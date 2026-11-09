// A restored seat is put back on the line the record holds. A GLM seat the host brought back as
// plain claude — the captured idle screen names another model than the record — is exited in its
// own pane and launched again from that recorded line, resumed. The line the record keeps after
// the launch names no resume id. A claude seat whose record declares a channel, and whose channel
// answers nothing, is launched again when it is idle, and the channel answers once that line
// runs. The same seat while it is working, or while its box holds unsent text, is left where it
// stands: the one step is logged and nothing is typed. The session each scene starts from is the
// captured one, and the screens are the captured claude frames.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { CHANNEL_FLAG, CHANNEL_SERVER } from '../src/mcp/channel.ts';
import { ensureInboxFolder, inboxLive, writeListener } from '../src/mcp/inbox.ts';
import { namedResumeTarget } from '../src/profiles/profile.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { LOG_FILE, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, claudeBox, fixtureBase, gitEnv, recordRenames, testIo } from './helpers.ts';

const NOW = new Date('2026-11-08T12:00:00Z');
const SESSION = 'crate';
const GLM_LAUNCH = 'claude-glm.sh';
const CHANNEL_LAUNCH = `claude ${CHANNEL_FLAG} server:${CHANNEL_SERVER}`;
const CONVERSATION = 'conversation-slate';
const STEP = 'its channel did not reconnect; the one step is to open /mcp in its pane';
const RECORDED: PaneProcesses = { shell: 100, foreground: [200] };
const RESTORED: PaneProcesses = { shell: 101, foreground: [201] };

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
  launch: string;
  vendor: string;
  model: string;
  version: string;
  session: string | null;
};

type Scene = {
  root: string;
  home: string;
  dir: string;
  spec: SeatSpec;
};

function scene(spec: SeatSpec): Scene {
  const base = fixtureBase('.restore-relaunch-');
  owned.push(base);
  const root = join(base, 'crate');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
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
    cli: claude-code
    vendor: ${spec.vendor}
    model: ${spec.model}
    version: "${spec.version}"
    launch: ${spec.launch}
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
    cli: 'claude-code',
    launcher: null,
    launch: spec.launch,
    reach: {
      team: id,
      seat: spec.name,
      session: SESSION,
      pane: spec.pane,
      address: null,
      ...(spec.session === null ? {} : { agent_session: spec.session }),
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
  held.cli = 'claude-code';
  held.launch_line = spec.launch;
  held.model = spec.model;
  held.version = spec.version;
  if (spec.session === null) delete held.agent_session;
  else held.agent_session = spec.session;
  shape.seats = { [spec.name]: held };
  shape.watch = capturedWatch();
  shape.launched_file = join(dir, 'team.yaml');
  updateState(dir, (state) => {
    state.sessions[SESSION] = shape as never;
  });
  return { root, home, dir, spec };
}

type Face = {
  status?: string;
  screen?: string;
  /** The recorded channel line, once it actually runs, is the channel answering. */
  answer?: boolean;
};

type Trace = {
  typed: string[];
  runs: { pane: string; command: string }[];
  closed: string[];
  created: string[];
};

function hostFor(made: Scene, face: Face = {}): { sources: UpSources; trace: Trace } {
  const trace: Trace = { typed: [], runs: [], closed: [], created: [] };
  const { spec } = made;
  let exited = false;
  const madePanes = new Map<string, string>();
  const madeSpaces = new Map<string, string[]>();
  const agents = (): HerdrAgent[] => {
    const listed: HerdrAgent[] = [{
      name: null,
      agent: 'claude',
      pane: spec.pane,
      workspace: spec.workspace,
      status: face.status ?? 'idle',
      cwd: made.root,
      ...(spec.session === null ? {} : { session: spec.session }),
    }];
    for (const [workspace, panes] of madeSpaces.entries()) {
      for (const pane of panes) {
        listed.push({ name: null, agent: 'claude', pane, workspace, status: 'idle', cwd: made.root });
      }
    }
    return listed;
  };
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      const pane = `pane-made-${trace.created.length + 1}`;
      const workspace = `ws-made-${trace.created.length + 1}`;
      trace.created.push(label);
      madePanes.set(pane, CLAUDE_IDLE);
      madeSpaces.set(workspace, [pane]);
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      trace.runs.push({ pane, command });
      if (face.answer === true && command.includes(CHANNEL_FLAG)) {
        const drop = ensureInboxFolder(made.root, SESSION, spec.name);
        if (drop === null) return false;
        const wrote = writeListener(drop, {
          v: 1,
          seat: spec.name,
          session: SESSION,
          root: made.root,
          cli: 'claude-code',
          pid: process.pid,
          ts: NOW.toISOString(),
          channel: true,
        });
        if (!wrote) return false;
      }
      madePanes.set(pane, CLAUDE_IDLE);
      exited = false;
      return true;
    },
    typeText(_session, pane, text) {
      trace.typed.push(text);
      if (pane === spec.pane && text === '/exit') exited = true;
      return true;
    },
    pressEnter: () => true,
    renameWorkspace: () => true,
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    agentPanes: () => [spec.pane, ...madePanes.keys()],
    agents,
    workspacePanes(_session, workspace) {
      if (workspace === spec.workspace) return [spec.pane];
      return madeSpaces.get(workspace) ?? null;
    },
    paneText: (_session, pane) => {
      if (pane === spec.pane) return face.screen ?? CLAUDE_IDLE;
      return madePanes.get(pane) ?? CLAUDE_IDLE;
    },
    foreground: () => ['claude'],
    processInfo: (_session, pane) => {
      if (pane === spec.pane && exited) return { shell: RESTORED.shell, foreground: [RESTORED.shell] };
      if (pane === spec.pane) return RESTORED;
      return { shell: RESTORED.shell, foreground: [201] };
    },
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

function seatOf(made: Scene) {
  return readState(made.dir).sessions[SESSION]?.seats[made.spec.name];
}

function said(made: Scene, io: { out: string; err: string }): string {
  let logged = '';
  try {
    logged = readFileSync(join(made.dir, LOG_FILE), 'utf8');
  } catch {
    logged = '';
  }
  return `${io.out}\n${io.err}\n${logged}`;
}

const glm = (): SeatSpec => ({
  name: 'slate',
  pane: 'pane-slate',
  workspace: 'ws-slate',
  launch: GLM_LAUNCH,
  vendor: 'zhipu',
  model: 'GLM',
  version: '5.3',
  session: CONVERSATION,
});

const channel = (): SeatSpec => ({
  name: 'pebble',
  pane: 'pane-pebble',
  workspace: 'ws-pebble',
  launch: CHANNEL_LAUNCH,
  vendor: 'anthropic',
  model: 'Claude Opus',
  version: '5.5',
  session: CONVERSATION,
});

test('a GLM seat restored as plain claude is exited and relaunched from its recorded line, and the record keeps no resume id', async () => {
  const made = scene(glm());
  const host = hostFor(made);
  const io = testIo(made.root, { kind: 'owner' });
  expect(await runUp([], io, host.sources), `${io.out}\n${io.err}`).toBe(0);
  expect(host.trace.typed).toEqual(['/exit']);
  expect(host.trace.closed).toEqual([]);
  const runs = seatRuns(host.trace);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.pane).toBe('pane-slate');
  expect(runs[0]?.command.startsWith(GLM_LAUNCH)).toBe(true);
  expect(runs[0]?.command).toContain(`--resume ${CONVERSATION}`);
  const line = seatOf(made)?.launch_line ?? '';
  expect(line.startsWith(GLM_LAUNCH)).toBe(true);
  expect(namedResumeTarget('claude-code', line)).toBeNull();
  expect(line).not.toContain(CONVERSATION);
  expect(line).not.toContain('--resume');
  expect(seatOf(made)?.pane).toBe('pane-slate');
  expect(seatOf(made)?.stage).toBe('ready');
});

test('a claude seat restored without its channel is relaunched when idle, and the channel answers', async () => {
  const made = scene(channel());
  const drop = join(made.root, '.agents', 'send-drops', SESSION, 'pebble');
  expect(inboxLive(drop, made.root, SESSION, 'pebble').live).toBe(false);
  const host = hostFor(made, { answer: true });
  const io = testIo(made.root, { kind: 'owner' });
  expect(await runUp([], io, host.sources), `${io.out}\n${io.err}`).toBe(0);
  const runs = seatRuns(host.trace).filter((run) => run.command.includes(CHANNEL_FLAG));
  expect(runs).toHaveLength(1);
  expect(runs[0]?.command).toContain(`server:${CHANNEL_SERVER}`);
  const live = inboxLive(drop, made.root, SESSION, 'pebble');
  expect(live.live).toBe(true);
  if (live.live) expect(live.listener.channel).toBe(true);
  expect(seatOf(made)?.stage).toBe('ready');
});

test('a claude seat restored without its channel is left alone while working or holding unsent text', async () => {
  for (const face of [
    { status: 'working' },
    { screen: claudeBox('note for later') },
  ]) {
    const made = scene(channel());
    const drop = join(made.root, '.agents', 'send-drops', SESSION, 'pebble');
    const host = hostFor(made, { ...face, answer: true });
    const io = testIo(made.root, { kind: 'owner' });
    const code = await runUp([], io, host.sources);
    expect([0, 1]).toContain(code);
    expect(host.trace.typed).toEqual([]);
    expect(seatRuns(host.trace).filter((run) => run.command.includes(CHANNEL_FLAG))).toEqual([]);
    expect(said(made, io)).toContain(STEP);
    expect(inboxLive(drop, made.root, SESSION, 'pebble').live).toBe(false);
    expect(seatOf(made)?.pane).toBe('pane-pebble');
  }
});
