// `team up <seat>`, and a plain `team up` that leaves alone what it cannot prove or was told to
// leave: a seat stopped on its own while its team runs (only its handle retained), and a seat whose
// own launched process still runs on its pane short of ready (a CLI herdr does not detect). The
// A live dry run planned the second into its live TUI and started the first, stopped
// on purpose. The Cursor fixture frame is reused; panes, processes and the clock are synthetic.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runStatus } from '../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import type { Live } from '../src/status/compare.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T09:15:00Z');
const SESSION = 'acme';
const SEAT = 'worker';
const PANE = 'fixture-pane-one';
const WORKSPACE = 'fixture-space';
const GROK_IDLE = readFileSync(new URL('./fixtures/cursor/2026.10.16/idle.txt', import.meta.url), 'utf8');
const SESSION_ID = 'ses_grok_live';
// The record a launch wrote before the host restore: the pane, the workspace, the pids then.
const RECORD = { stage: 'ready' as const, pane: PANE, workspace: WORKSPACE, launched: { shell: 100, cli: [200] } };
// The pids the pane holds now: the host restored the process, so they are not the launched ones.
const RESTORED = { shell: 101, foreground: [201] };
const RESTORED_LINE = 'restored; left as it is';
const DAEMON_PID = 7;
const EPOCH = `watch_${'cd'.repeat(16)}`;

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
coordinator: ${SEAT}
operator: ${SEAT}
session: ${SESSION}
trust:
  - ${lobby}
  - ${root}
  - ${join(base, 'worker-own')}
  - ${join(base, 'helper-own')}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${SEAT}
    label: ${SEAT}
    cli: cursor
    vendor: cursor
    model: Grok
    version: "4.7"
    cwd: ../worker-own
    launch: cursor-agent --model grok-4.7-high
  - role: implementer
    name: helper
    label: helper
    cli: cursor
    vendor: cursor
    model: Grok
    version: "4.7"
    cwd: ../helper-own
    launch: cursor-agent --model grok-4.7-high
`;
}

/** The seat state a launch left before the restore, and the registry's binding of the seat to a
 *  conversation — `null` for a record that names none, as the incident's seats did. */
function record(over: Record<string, unknown> = {}, registry: { session?: string | null } = {}): void {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = { ...RECORD, ...over } as never;
  });
  registerAgent(home, {
    name: SEAT,
    signing: { model: 'Grok', version: '4.7', role: 'coordinator' },
    lab: 'cursor',
    cli: 'cursor',
    launcher: null,
    launch: 'cursor-agent --model grok-4.7-high',
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
  runs: string[];
};

/** Herdr's list naming the seat on the restored pane, attributed to the Cursor agent kind, with
 *  `live` as the conversation it reports (`undefined`: none reported); the pane's process
 *  reading is the restored one. */
function agentEntry(live: string | undefined, status = 'idle', name: string | null = SEAT): HerdrAgent {
  return {
    name, agent: 'cursor', pane: PANE, workspace: WORKSPACE, status, cwd: root,
    ...(live === undefined ? {} : { session: live }),
  };
}

function sources(
  live: string | undefined,
  opts: { agent?: string | null; foreground?: string[]; name?: string | null; processes?: { shell: number; foreground: number[] } } = {},
): { sources: UpSources; trace: Trace & { renamed: string[] } } {
  const trace: Trace & { renamed: string[] } = { created: [], closed: [], typed: [], runs: [], renamed: [] };
  let named = opts.name === undefined ? SEAT : opts.name;
  const agents = (): HerdrAgent[] => [{ ...agentEntry(live, 'idle', named), ...(opts.agent === undefined ? {} : { agent: opts.agent }) }];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      trace.created.push(label);
      return { pane: 'made-pane', workspace: 'made-space' };
    },
    paneRun(_session, _pane, command) {
      trace.runs.push(command);
      return true;
    },
    typeText(_session, _pane, text) {
      trace.typed.push(text);
      return true;
    },
    renameWorkspace: () => true,
    reportDisplayAgent: () => true,
    renameAgent(_session, pane, name) {
      trace.renamed.push(`${pane}=${name}`);
      named = name;
      return true;
    },
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    agentPanes: () => [PANE],
    agents,
    paneText: () => GROK_IDLE,
    foreground: () => opts.foreground ?? ['cursor-agent'],
    processInfo: () => opts.processes ?? RESTORED,
    sleep: async () => {},
    now: () => NOW,
  };
  const doctor: DoctorSources = {
    version: () => '2026.10.22',
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

/** The daemon hosts this session's watch: running, no pane of its own. Status reads that
 *  record instead of reporting that no watch has run. */
function hostedWatch(): DaemonHealth {
  const startedAt = NOW.toISOString();
  return {
    daemon: 'teamcli',
    socket: 'socket-acme',
    state: 'running',
    running: true,
    pid: DAEMON_PID,
    uid: null,
    since: startedAt,
    startedBy: 'manual',
    version: '1',
    gitHead: null,
    heartbeatAt: startedAt,
    heartbeatSeconds: 1,
    features: null,
    stuck: [],
    roots: [{
      root,
      team: 'acme',
      send: 'serving',
      bus: 'serving',
      why: null,
      watch: {
        routeId: 'route-acme',
        root,
        team: 'acme',
        session: SESSION,
        phase: 'running',
        startedAt,
        lastCycleAt: startedAt,
        lastCycleOutcome: 'pass',
        cycles: 1,
        failures: 0,
        effects: 'open',
        required: true,
        why: null,
      },
    }],
    probe: { state: 'answered', at: startedAt },
    why: null,
  };
}

/** The world `team status` reads after the run: the same pane, process and conversation. */
function liveWorld(live: string | undefined): Live {
  return {
    running: true,
    agents: [agentEntry(live)],
    workspaces: [{ id: WORKSPACE, label: SEAT }],
    screens: { [PANE]: GROK_IDLE },
    processes: { [PANE]: RESTORED },
  };
}

/** What the run did to the seat itself: a Watch workspace of its own is not the seat's. */
function touchedSeat(trace: Trace): { created: string[]; closed: string[]; typed: string[]; runs: string[] } {
  return {
    created: trace.created.filter((label) => label === SEAT),
    closed: trace.closed,
    typed: trace.typed,
    runs: trace.runs.filter((command) => command.includes('cursor-agent')),
  };
}

const seatState = () => readState(dir).sessions[SESSION]?.seats[SEAT];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-scoped-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const own of ['worker-own', 'helper-own']) mkdirSync(join(base, own), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  setup();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});


const SAME = { shell: RECORD.launched.shell, foreground: RECORD.launched.cli };
function retainHelper(): void {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    (session.retained_seats ??= {}).helper = { id: 'seat_aaaaaaaaaaaa' };
  });
}

test('a plain team up leaves a seat stopped on its own while its team runs', async () => {
  record();
  retainHelper();
  const made = sources(SESSION_ID, { processes: SAME });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), io.out + io.err).toBe(0);
  expect(io.out + io.err).toContain('helper: stopped on its own while the team runs; start it with team up helper');
  expect(made.trace.created.filter((label) => label === 'helper')).toEqual([]);
  expect(made.trace.runs).toEqual([]);
});

test('team up <seat> starts the named seat and leaves every other seat as it is', async () => {
  record();
  retainHelper();
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['helper', '--dry-run'], dry, sources(SESSION_ID, { processes: SAME, name: null }).sources), dry.out + dry.err).toBe(0);
  expect(dry.out).toContain(`skip ${SEAT}: not named in this run; left as it is`);
  expect(dry.out).toContain('--label helper ');
  // The unnamed seat lost its name, yet a scoped run does not rename it either.
  expect(dry.out).not.toContain(`agent rename ${PANE}`);
});

test('after a whole-team down every seat is retained and a plain team up starts them all', async () => {
  record();
  retainHelper();
  updateState(dir, (state) => {
    const session = state.sessions[SESSION]!;
    (session.retained_seats ??= {})[SEAT] = { id: 'seat_0123456789ab' };
    delete session.seats[SEAT];
  });
  const made = sources(SESSION_ID, { processes: SAME });
  made.sources.agents = () => [];
  made.sources.launch!.agents = () => [];
  const dry = testIo(root, { kind: 'owner' });
  await runUp(['--dry-run'], dry, made.sources);
  expect(dry.out).not.toContain('stopped on its own');
  expect(dry.out).toContain('--label helper ');
});

test('team up <seat> refuses a seat the file does not declare', async () => {
  record();
  const io = testIo(root, { kind: 'owner' });
  await runUp(['nobody', '--dry-run'], io, sources(SESSION_ID, { processes: SAME }).sources);
  expect(io.out).toContain('up would refuse: no declared seat nobody; nothing was started');
  const run = testIo(root, { kind: 'owner' });
  const made = sources(SESSION_ID, { processes: SAME });
  expect(await runUp(['nobody'], run, made.sources)).toBe(1);
  expect(made.trace.runs).toEqual([]);
});

test('team up <seat> takes no whole-team form', async () => {
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp(['helper', '--retie'], io, sources(SESSION_ID).sources)).toBe(2);
  expect(io.err).toContain('team up <seat> names the seats of one team to start');
});

test("a seat whose launched process still runs short of ready, unseen by herdr, is never typed into", async () => {
  record({ stage: 'launched' });
  retainHelper();
  const made = sources(SESSION_ID, { processes: SAME });
  // Herdr detects no agent on the pane (a CLI it does not know): it lists nothing there.
  made.sources.agents = () => [];
  made.sources.launch!.agents = () => [];
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, made.sources), dry.out + dry.err).toBe(0);
  expect(dry.out).toContain(`${SEAT}: its launched process still runs in pane ${PANE} but never reached ready; nothing typed into it (team restart ${SEAT} relaunches it)`);
  expect(dry.out).not.toContain(`pane run ${PANE}`);
});
