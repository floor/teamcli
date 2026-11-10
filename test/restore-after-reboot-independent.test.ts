// Drop this file in as test/restore-after-reboot-independent.test.ts.
// After a host restore, every seat is named again. A pane that kept its id is matched by the
// record. A pane with a new id is matched by the running CLI and the recorded conversation, never
// by the pane's title. A worker on the incompatible-feature dialog is relaunched without
// the retired false pin or a dialog choice; a lead stays open and status names it. A channel seat is
// reconnected, or named with the one step that reconnects it. The session each scene starts
// from is the captured one: seat and pane names are replaced where the scene needs its own,
// and the rest of the record stays. A hosted watch that is already active is not given a pane.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { placeCaller, type CallerSources } from '../src/caller.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { runStatus } from '../src/commands/status.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { setHerdrCapture, setHerdrRun, type HerdrAgent } from '../src/herdr.ts';
import { pinnedWords } from '../src/launch/features.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { CHANNEL_FLAG, CHANNEL_SERVER } from '../src/mcp/channel.ts';
import { planChannelPair, publishChannelPair } from '../src/mcp/launch-config.ts';
import { ensureInboxFolder, inboxLive, writeListener } from '../src/mcp/inbox.ts';
import { profileFor } from '../src/profiles/profile.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { registeredRootOf, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, LOG_FILE, readState, updateState } from '../src/state.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { canonicalRoot } from '../src/daemon/routes.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, fixtureBase, gitEnv, testIo } from './helpers.ts';

const SESSION = 'crate';
const CONVERSATION = 'conversation-cobble';
const PEBBLE_CONVERSATION = 'conversation-pebble';
const SAME = 'pane-pebble';
const BEFORE = 'pane-cobble-before';
const AFTER = 'pane-cobble-after';
const CHANNEL_LAUNCH = `claude ${CHANNEL_FLAG} server:${CHANNEL_SERVER}`;
// Codex's startup dialog, the profile's not-started screen: the title once, then the option
// rows, the marker on the first. A title alone is not that screen.
const FEATURE_SCREEN = [
  '',
  '  Background server has incompatible feature settings',
  '',
  '  The running background server was started with different feature settings.',
  '',
  '› 1. Run without daemon this time',
  '  2. Restart with these settings',
  '  3. Cancel',
  '',
  '  Press enter to confirm or esc to cancel',
].join('\n');

const owned: string[] = [];
afterEach(() => {
  setHerdrRun(null);
  setHerdrCapture(null);
  const paths = owned.splice(0);
  discardFixtures(paths, { roots: paths.map((path) => dirname(path)) });
});

type Restored = { root: string; home: string; dir: string };

type CapturedSeat = Record<string, unknown>;
type CapturedSession = {
  seats: Record<string, CapturedSeat>;
  watch?: { pane?: string; heartbeat?: string; workspace?: string; pid?: number };
  launched_file?: string;
} & Record<string, unknown>;

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

function readyCaptured(session: CapturedSession): CapturedSeat {
  const found = Object.values(session.seats).find((seat) => seat.stage === 'ready');
  if (found === undefined) throw new Error('the captured session has no ready seat');
  return structuredClone(found);
}

function restored(conversation?: string): Restored {
  const base = fixtureBase('.restore-after-reboot-');
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
  const id = teamIdOf(root);
  writeFileSync(join(dir, 'team.yaml'), `format: 1
project: crate
coordinator: pebble
operator: pebble
session: crate
workspace:
  mode: shared
trust:
  - ${JSON.stringify(lobby)}
  - ${JSON.stringify(root)}
seats:
  - role: coordinator
    name: pebble
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: ${JSON.stringify(CHANNEL_LAUNCH)}
  - role: implementer
    name: cobble
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
`);
  const pebble = registerAgent(home, {
    name: 'Pebble',
    signing: { model: 'Test', version: '1', role: 'coordinator' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: CHANNEL_LAUNCH,
    // Restoring an unnamed positive pane requires the conversation its registry record holds.
    reach: { team: id, seat: 'pebble', session: SESSION, pane: SAME, address: null,
      ...(conversation === undefined ? {} : { agent_session: conversation }) },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  const cobble = registerAgent(home, {
    name: 'Cobble',
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test-lab',
    cli: 'codex',
    launcher: null,
    launch: 'codex',
    reach: { team: id, seat: 'cobble', session: SESSION, pane: BEFORE, address: null, agent_session: CONVERSATION },
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
    roster: [
      { agent: pebble.id, seat: 'pebble', role: 'coordinator', leads: true },
      { agent: cobble.id, seat: 'cobble', role: 'implementer', leads: false },
    ],
    lifecycle: 'running',
  });
  const shape = capturedSession();
  const pebbleSeat = readyCaptured(shape);
  const cobbleSeat = readyCaptured(shape);
  delete pebbleSeat.agent_session;
  pebbleSeat.stage = 'ready';
  pebbleSeat.pane = SAME;
  pebbleSeat.cli = 'claude-code';
  pebbleSeat.launch_line = CHANNEL_LAUNCH;
  delete pebbleSeat.workspace;
  cobbleSeat.stage = 'ready';
  cobbleSeat.pane = BEFORE;
  cobbleSeat.workspace = 'ws-cobble';
  cobbleSeat.launched = { shell: 100, cli: [200] };
  cobbleSeat.agent_session = CONVERSATION;
  cobbleSeat.cli = 'codex';
  cobbleSeat.launch_line = 'codex';
  shape.seats.pebble = pebbleSeat;
  shape.seats.cobble = cobbleSeat;
  shape.watch = capturedWatch();
  shape.launched_file = join(dir, 'team.yaml');
  updateState(dir, (state) => {
    state.sessions[SESSION] = shape as never;
  });
  return { root, home, dir };
}

function unnamed(pane: string, conversation?: string): HerdrAgent {
  return {
    name: null,
    agent: null,
    pane,
    workspace: 'decoy-title',
    status: 'idle',
    cwd: null,
    ...(conversation === undefined ? {} : { session: conversation }),
  };
}

function sources(home: string, agent: HerdrAgent, processName: string): CallerSources {
  return {
    ancestors: () => [
      { pid: 80, name: processName },
      { pid: 70, name: 'zsh' },
      { pid: 50, name: 'herdr' },
      { pid: 1, name: 'launch' },
    ],
    agents: () => [agent],
    paneRootPid: (pane) => (pane === agent.pane ? 70 : null),
    env: { HERDR_PANE_ID: agent.pane },
    stdinIsTTY: true,
    home,
    paneProcesses: () => ({ shell: 70, foreground: [80] }),
    foreground: () => [processName],
    seatAtPane: () => null,
  };
}

const commands: string[][] = [];
const typed: string[] = [];

function scriptHost(conversation?: string): void {
  commands.length = 0;
  typed.length = 0;
  const named: { pane: string; name: string }[] = [];
  setHerdrRun((args) => {
    commands.push([...args]);
    if (args[0] === 'agent' && args[1] === 'list') {
      return {
        agents: named.map((one) => ({
          name: one.name,
          pane_id: one.pane,
          workspace_id: 'ws-crate',
          agent: 'claude',
          agent_status: 'idle',
          ...(one.pane === SAME && conversation !== undefined ? { agent_session: conversation } : {}),
        })),
      };
    }
    return { agents: [] };
  });
  setHerdrCapture((args) => {
    commands.push([...args]);
    if (args[0] === 'agent' && args[1] === 'rename' && typeof args[2] === 'string' && typeof args[3] === 'string') {
      named.push({ pane: args[2], name: args[3] });
    }
    if (args.some((word) => word.includes('run without daemon'))) typed.push(args.join(' '));
    return JSON.stringify({ result: true });
  });
}

function approvedCobble(made: Restored, worker = false): Date {
  const file = `format: 1
project: crate
coordinator: ${worker ? 'pebble' : 'cobble'}
operator: ${worker ? 'pebble' : 'cobble'}
session: crate
workspace:
  mode: shared
trust:
  - ${JSON.stringify(lobbyDir(made.home))}
  - ${JSON.stringify(made.root)}
seats:
${worker ? `  - role: orchestrator
    name: pebble
    leads: true
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    human: true
` : ''}  - role: ${worker ? 'implementer' : 'coordinator'}
    name: cobble
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
`;
  writeFileSync(join(made.dir, 'team.yaml'), file);
  const loaded = loadTeamFile(made.root, { file: join(made.dir, 'team.yaml'), home: made.home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const now = new Date('2026-11-08T12:00:00Z');
  writeApproval(
    storePath(loaded.team.project, loaded.root, made.home),
    { approval: approvalOf(loaded.team, loaded.root, now), file },
    loaded.team.seats,
    made.home,
  );
  return now;
}

function movedCodex(): HerdrAgent {
  const moved = unnamed(AFTER, CONVERSATION);
  moved.agent = 'codex';
  moved.workspace = 'ws-cobble';
  return moved;
}

/** The host `up` reads for a pane whose id is new: the running CLI and the recorded conversation
 *  match, and a rename is recorded on the pane the host names. */
function restoreHost(
  made: Restored,
  moved: HerdrAgent,
  now: Date,
  renamed: { pane: string; name: string }[],
  paneText: (session: string, pane: string) => string,
): UpSources {
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'pane-made', workspace: 'ws-made' }),
    paneRun: () => true,
    renameAgent(_session, pane, name) {
      renamed.push({ pane, name });
      if (pane === moved.pane) moved.name = name;
      return true;
    },
    closeWorkspace: () => true,
    agentPanes: () => [AFTER],
    agents: () => [moved],
    paneText,
    foreground: (_session, pane) => (pane === AFTER ? ['codex'] : null),
    processInfo: (_session, pane) => {
      if (pane === AFTER) return { shell: 101, foreground: [201] };
      if (pane === BEFORE) return { shell: 100, foreground: [200] };
      return null;
    },
    now: () => now,
    sleep: async () => {},
  };
  const doctor: DoctorSources = {
    version: () => '0.0.0-test',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.0.0-test',
    sessionRunning: () => true,
    now: () => now,
    home: made.home,
  };
  return {
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => [moved],
    workspaces: () => [{ id: 'ws-cobble', label: 'cobble' }],
    home: made.home,
    doctor,
    launch,
    now: () => now,
    sleep: async () => {},
  };
}

test('a restored host names every seat again, including a pane whose id is new', async () => {
  const made = restored(PEBBLE_CONVERSATION);
  scriptHost(PEBBLE_CONVERSATION);
  const same = placeCaller(sources(made.home, unnamed(SAME, PEBBLE_CONVERSATION), 'claude'), SESSION);
  expect(same).toEqual({ kind: 'seat', name: 'pebble', pane: SAME, session: SESSION });
  const log = readFileSync(join(made.dir, LOG_FILE), 'utf8');
  expect(log).toContain(`re-applied the herdr name on pane ${SAME}`);
  expect(log).not.toContain('decoy-title');
  expect(workspaceLabel({ name: 'pebble', role: 'coordinator', label: 'Test 1' })).toBe('pebble · coordinator');
  expect(workspaceLabel({ name: 'cobble', role: 'implementer', label: 'Test 1' })).toBe('cobble · implementer');

  const now = approvedCobble(made);
  const moved = movedCodex();
  const renamed: { pane: string; name: string }[] = [];
  const host = restoreHost(made, moved, now, renamed, () => 'ready\n');
  const io = testIo(made.root, { kind: 'owner' });
  expect(await runUp([], io, host), `${io.out}\n${io.err}`).toBe(0);
  expect(renamed).toContainEqual({ pane: AFTER, name: 'cobble' });
  const placed = placeCaller(sources(made.home, moved, 'codex'), SESSION);
  expect(placed).toEqual({ kind: 'seat', name: 'cobble', pane: AFTER, session: SESSION });
});

test('a Codex seat on the incompatible-feature dialog is relaunched and no option is chosen', async () => {
  const made = restored();
  // Dialog recovery leaves lead panes alone; this positive repair targets a worker.
  const now = approvedCobble(made, true);
  const dialog = movedCodex();
  const dry = testIo(made.root, { kind: 'owner' });
  const planned = restoreHost(made, dialog, now, [], (_session, pane) => (
    pane === AFTER ? FEATURE_SCREEN : 'ready\n'
  ));
  expect(await runUp(['--dry-run'], dry, planned), `${dry.out}\n${dry.err}`).toBe(0);
  const pins = pinnedWords(profileFor('codex')?.features ?? []);
  // Dialog recovery relaunches without the retired fixed false pair.
  expect(pins).toEqual([]);
  expect(dry.out).toContain('closed without choosing a dialog option; launched again with the coordination flag');
  expect(dry.out).not.toContain('features.mcp_oauth_refresh_coordination=false');
  expect(dry.out).not.toContain('send-keys');
  expect(dry.out).not.toContain('run without daemon');

  const moved = movedCodex();
  const renamed: { pane: string; name: string }[] = [];
  const host = restoreHost(made, moved, now, renamed, () => 'ready\n');
  const io = testIo(made.root, { kind: 'owner' });
  expect(await runUp([], io, host), `${io.out}\n${io.err}`).toBe(0);
  expect(renamed).toContainEqual({ pane: AFTER, name: 'cobble' });
  const placed = placeCaller(sources(made.home, moved, 'codex'), SESSION);
  expect(placed).toEqual({ kind: 'seat', name: 'cobble', pane: AFTER, session: SESSION });
});

test('a lead on the Codex settings dialog stays open and status names the dialog', async () => {
  const made = restored();
  const now = approvedCobble(made);
  const dialog = movedCodex();
  const host = restoreHost(made, dialog, now, [], (_session, pane) => (
    pane === AFTER ? FEATURE_SCREEN : 'ready\n'
  ));
  if (!host.launch) throw new Error('the fixture holds no launch surface');
  const closed: string[] = [];
  const launched: string[] = [];
  const inputs: string[] = [];
  host.launch.closeWorkspace = (_session, workspace) => { closed.push(workspace); return true; };
  host.launch.paneRun = (_session, _pane, command) => { launched.push(command); return true; };
  host.launch.typeText = (_session, _pane, text) => { inputs.push(text); return true; };
  host.launch.pressEnter = () => { inputs.push('enter'); return true; };
  host.launch.sendKey = (_session, _pane, key) => { inputs.push(key); return true; };
  scriptHost();
  const io = testIo(made.root, { kind: 'owner' });
  // Dialog recovery protects the lead from automatic repair and leaves every input untouched.
  expect(await runUp([], io, host), `${io.out}\n${io.err}`).toBe(0);
  expect(closed).toEqual([]);
  expect(launched).toEqual([]);
  expect(inputs).toEqual([]);
  expect(commands.some((args) => args.includes('send-keys'))).toBe(false);
  expect(readState(made.dir).sessions[SESSION]?.seats.cobble?.pane).toBe(AFTER);

  const status = testIo(made.root, { kind: 'owner' });
  const noKeys = () => { throw new Error('this synthetic status scene uses no credential store'); };
  expect(await runStatus(['--file', join(made.dir, 'team.yaml'), '--json'], status, {
    home: made.home,
    now: () => now,
    branch: () => 'main',
    standing: (root) => approvalStanding(root, made.home),
    ownerSeatStore: {
      name: 'synthetic', available: () => false,
      create: noKeys, publicKey: noKeys, sign: noKeys, pinSet: noKeys, pinGet: noKeys,
    },
    live: () => ({
      running: true,
      agents: [{ ...dialog, name: 'cobble' }],
      workspaces: [{ id: 'ws-cobble', label: 'cobble' }],
      screens: { [AFTER]: FEATURE_SCREEN },
      processes: { [AFTER]: { shell: 101, foreground: [201] } },
      foreground: { [AFTER]: ['codex'] },
    }),
  }), `${status.out}\n${status.err}`).toBe(1);
  const report = JSON.parse(status.out) as {
    rows: { name: string; state: string; pane: string }[];
    differences: { what: string; repair: string }[];
  };
  expect(report.rows.find((row) => row.name === 'cobble')).toMatchObject({
    state: 'Codex settings dialog', pane: AFTER,
  });
  expect(report.differences.find((row) => row.what === 'cobble: Codex settings dialog')).toBeDefined();
});

test('a reboot leaves the daemon watch active and starts no watch pane, and the bus is back with its root', async () => {
  const made = restored();
  const now = approvedCobble(made);
  const canonical = canonicalRoot(made.root);
  if (canonical === null) throw new Error('the fixture root cannot be resolved');
  const recordedWatch = readState(made.dir).sessions[SESSION]?.watch;
  if (recordedWatch?.pane === undefined) throw new Error('the captured watch has no pane');
  const roots: DaemonHealth['roots'] = [{
    root: canonical,
    team: 'crate',
    send: 'serving',
    bus: 'failed',
    why: null,
    watch: {
      routeId: 'route-crate',
      root: canonical,
      team: 'crate',
      session: SESSION,
      phase: 'running',
      startedAt: now.toISOString(),
      lastCycleAt: now.toISOString(),
      lastCycleOutcome: 'pass',
      cycles: 1,
      failures: 0,
      effects: 'open',
      required: true,
      why: null,
    },
  }];
  const created: string[] = [];
  const runs: string[] = [];
  const cobble = unnamed(BEFORE, CONVERSATION);
  cobble.name = 'cobble';
  cobble.agent = 'codex';
  cobble.workspace = 'ws-cobble';
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      created.push(label);
      if (label === 'Watch · crate') return { pane: 'pane-watch-after', workspace: 'ws-watch-after' };
      if (label === 'Bus · crate') return { pane: 'pane-bus', workspace: 'ws-bus' };
      return { pane: 'pane-made', workspace: 'ws-made' };
    },
    paneRun(_session, _pane, command) {
      runs.push(command);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [BEFORE],
    agents: () => [cobble],
    paneText: () => 'ready\n',
    foreground: (_session, pane) => (pane === BEFORE ? ['codex'] : null),
    processInfo: (_session, pane) => (pane === BEFORE ? { shell: 100, foreground: [200] } : null),
    now: () => now,
    sleep: async () => {},
  };
  const doctor: DoctorSources = {
    version: () => '0.0.0-test',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.0.0-test',
    sessionRunning: () => true,
    now: () => now,
    home: made.home,
  };
  const health: DaemonHealth = {
    daemon: 'teamcli',
    socket: 'socket-crate',
    state: 'running',
    running: true,
    pid: 7,
    uid: null,
    since: null,
    startedBy: null,
    version: null,
    gitHead: null,
    heartbeatAt: null,
    heartbeatSeconds: null,
    features: null,
    stuck: [],
    roots,
    probe: { state: 'answered', at: now.toISOString() },
    why: null,
  };
  const host: UpSources = {
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => [cobble],
    workspaces: () => [{ id: 'ws-cobble', label: 'cobble' }],
    home: made.home,
    doctor,
    launch,
    now: () => now,
    sleep: async () => {},
    alive: () => false,
    busAlive: async () => false,
    daemonHealth: async () => health,
  };
  const io = testIo(made.root, { kind: 'owner' });
  expect(await runUp([], io, host), `${io.out}\n${io.err}`).toBe(0);
  const hosted = roots.find((item) => item.root === canonical)?.watch;
  expect(hosted?.phase).toBe('running');
  expect(hosted?.session).toBe(SESSION);
  expect(created.filter((label) => label === 'Watch · crate')).toEqual([]);
  expect(runs.filter((command) => command.includes('team watch'))).toHaveLength(0);
  const left = readState(made.dir).sessions[SESSION];
  expect(left?.watch?.workspace).toBe(recordedWatch.workspace);
  expect(left?.watch?.pane).toBeUndefined();
  expect(left?.watch?.pid).toBeUndefined();
  expect(readFileSync(join(made.dir, LOG_FILE), 'utf8')).toContain(
    `cleared pane watch ${recordedWatch.pane}: the daemon hosts this session's watch`,
  );
  expect(created.filter((label) => label === 'Bus · crate')).toEqual(['Bus · crate']);
  expect(runs.filter((command) => command.trim().split(/\s+/).at(-1) === 'bus')).toHaveLength(1);
  expect(left?.bus?.pane).toBe('pane-bus');
  expect(roots.map((root) => root.root)).toContain(canonical);
});

/** Approves the team file the fixture wrote, pebble's channel launch included. */
function approvedAsWritten(made: Restored): Date {
  const path = join(made.dir, 'team.yaml');
  const file = readFileSync(path, 'utf8');
  const loaded = loadTeamFile(made.root, { file: path, home: made.home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const now = new Date('2026-11-08T12:00:00Z');
  writeApproval(
    storePath(loaded.team.project, loaded.root, made.home),
    { approval: approvalOf(loaded.team, loaded.root, now), file },
    loaded.team.seats,
    made.home,
  );
  return now;
}

const CHANNEL_STEP = 'its channel did not reconnect; the one step is to open /mcp in its pane';

/** An idle channel seat whose listener never answers, or the same seat while it is working.
 *  The recorded line is the file's channel launch. A working seat keeps the conversation the
 *  record names, so the pane stays proven while it is busy. */
function channelHost(made: Restored, now: Date, busy: boolean): { sources: UpSources; runs: string[]; typed: string[] } {
  const runs: string[] = [];
  const typed: string[] = [];
  let exited = false;
  updateState(made.dir, (state) => {
    const session = state.sessions[SESSION] ?? (state.sessions[SESSION] = emptySession());
    const prior = session.seats.pebble ?? {};
    session.seats.pebble = {
      ...prior,
      stage: 'ready',
      pane: SAME,
      workspace: 'ws-pebble',
      launched: { shell: 90, cli: [190] },
      cli: 'claude-code',
      launch_line: CHANNEL_LAUNCH,
      ...(busy ? { agent_session: CONVERSATION } : {}),
    };
    if (!busy) delete session.seats.pebble.agent_session;
  });
  const pebble = unnamed(SAME, busy ? CONVERSATION : undefined);
  pebble.agent = 'claude';
  pebble.workspace = 'ws-pebble';
  pebble.status = busy ? 'working' : 'idle';
  const cobble = unnamed(BEFORE, CONVERSATION);
  cobble.name = 'cobble';
  cobble.agent = 'codex';
  cobble.workspace = 'ws-cobble';
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'pane-made', workspace: 'ws-made' }),
    paneRun(_session, _pane, command) {
      runs.push(command);
      if (!command.includes(CHANNEL_FLAG)) return true;
      const drop = ensureInboxFolder(made.root, SESSION, 'pebble');
      if (drop === null) return false;
      return writeListener(drop, {
        v: 1,
        seat: 'pebble',
        session: SESSION,
        root: made.root,
        cli: 'claude-code',
        pid: process.pid,
        ts: now.toISOString(),
        channel: true,
      });
    },
    typeText(_session, _pane, text) {
      typed.push(text);
      if (text === '/exit') exited = true;
      return true;
    },
    pressEnter: () => true,
    renameAgent(_session, pane, name) {
      if (pane === SAME) pebble.name = name;
      return true;
    },
    closeWorkspace: () => true,
    agentPanes: () => [SAME, BEFORE],
    agents: () => [pebble, cobble],
    workspacePanes: (_session, workspace) => {
      if (workspace === 'ws-pebble') return [SAME];
      if (workspace === 'ws-cobble') return [BEFORE];
      return null;
    },
    paneText: () => CLAUDE_IDLE,
    foreground: (_session, pane) => (pane === SAME ? ['claude'] : pane === BEFORE ? ['codex'] : null),
    processInfo: (_session, pane) => {
      if (pane === SAME && exited) return { shell: 91, foreground: [91] };
      if (pane === SAME) return { shell: 91, foreground: [191] };
      if (pane === BEFORE) return { shell: 100, foreground: [200] };
      return null;
    },
    now: () => now,
    sleep: async () => {},
  };
  const doctor: DoctorSources = {
    version: () => '0.0.0-test',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.0.0-test',
    sessionRunning: () => true,
    now: () => now,
    home: made.home,
  };
  return {
    runs,
    typed,
    sources: {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => [pebble, cobble],
      workspaces: () => [
        { id: 'ws-pebble', label: 'pebble' },
        { id: 'ws-cobble', label: 'cobble' },
      ],
      home: made.home,
      doctor,
      launch,
      now: () => now,
      sleep: async () => {},
    },
  };
}

test('an idle channel seat with no live channel is relaunched from its recorded line, and the channel answers', async () => {
  const made = restored();
  // The restored default channel keeps its unique registered root and the lead's own project pair.
  expect(registeredRootOf(made.home, 'pebble', SESSION)).toEqual({ ok: true, root: made.root, session: SESSION });
  const prepared = publishChannelPair(planChannelPair({ root: made.root, cwd: made.root, seat: 'pebble', session: SESSION }, false), () => {});
  if (!prepared.ok) throw new Error(prepared.reason);
  prepared.lease.release();
  const now = approvedAsWritten(made);
  const host = channelHost(made, now, false);
  const drop = join(made.dir, 'send-drops', SESSION, 'pebble');
  expect(inboxLive(drop, made.root, SESSION, 'pebble').live).toBe(false);
  const io = testIo(made.root, { kind: 'owner' });
  expect(await runUp([], io, host.sources), `${io.out}\n${io.err}`).toBe(0);
  const launched = host.runs.filter((command) => command.includes(CHANNEL_FLAG));
  expect(launched).toHaveLength(1);
  expect(launched[0]).toContain(CHANNEL_LAUNCH);
  expect(host.typed).toEqual(['/exit']);
  const live = inboxLive(drop, made.root, SESSION, 'pebble');
  expect(live.live).toBe(true);
  if (live.live) expect(live.listener.channel).toBe(true);
  const pebble = unnamed(SAME);
  pebble.name = 'pebble';
  pebble.agent = 'claude';
  pebble.workspace = 'ws-pebble';
  const placed = placeCaller(sources(made.home, pebble, 'claude'), SESSION);
  expect(placed).toEqual({ kind: 'seat', name: 'pebble', pane: SAME, session: SESSION });
});

test('a busy channel seat with no live channel is left alone, and the one step is logged', async () => {
  const made = restored();
  const now = approvedAsWritten(made);
  const host = channelHost(made, now, true);
  const drop = join(made.dir, 'send-drops', SESSION, 'pebble');
  const io = testIo(made.root, { kind: 'owner' });
  expect(await runUp([], io, host.sources), `${io.out}\n${io.err}`).toBe(0);
  expect(host.typed).toEqual([]);
  expect(host.runs.filter((command) => command.includes(CHANNEL_FLAG))).toEqual([]);
  let logged = '';
  try {
    logged = readFileSync(join(made.dir, LOG_FILE), 'utf8');
  } catch {
    logged = '';
  }
  expect(`${io.out}\n${io.err}\n${logged}`).toContain(CHANNEL_STEP);
  expect(inboxLive(drop, made.root, SESSION, 'pebble').live).toBe(false);
});
