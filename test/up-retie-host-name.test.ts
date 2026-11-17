// `team up --retie` (and a plain `team up`) on a ready seat whose own launched process still runs
// on its recorded pane but whose host name is gone. A machine restart left a Codex tester that
// way: `--retie` said "already ready; left as it is" while `team status` read the pane `wrong
// name`, and the repair was a hand `herdr agent rename`. The pane is now renamed back by the
// adoption's own proof, run again at execution with the recorded process accepted; a pane named
// for another seat, or one whose process is not the launched one, is never renamed by this path.
// The Cursor fixture frame is reused; panes, processes and the clock are synthetic.
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
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-retie-name-')));
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


// The launched pids themselves: the process team started is still the one on the pane.
const SAME = { shell: RECORD.launched.shell, foreground: RECORD.launched.cli };
const RENAMED = `${PANE}=${SEAT}`;

for (const flags of [['--retie'], []] as const) {
  const run = flags.length ? 'team up --retie' : 'team up';
  test(`${run}: a ready seat that lost only its host name is renamed back, nothing else done`, async () => {
    record();
    const dry = testIo(root, { kind: 'owner' });
    expect(await runUp([...flags, '--dry-run'], dry, sources(SESSION_ID, { name: null, processes: SAME }).sources)).toBe(0);
    expect(dry.out).toContain('its host name was gone and its own launched process still runs there');
    expect(dry.out).not.toContain(`${SEAT}: already ready`);

    const made = sources(SESSION_ID, { name: null, processes: SAME });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([...flags], io, made.sources), io.out + io.err).toBe(0);
    expect(made.trace.renamed).toEqual([RENAMED]);
    expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [], runs: [] });
    expect(seatState()?.launched).toEqual(RECORD.launched);
    expect(seatState()?.stage).toBe('ready');
  });

  test(`${run}: a seat whose host name is in place is left as it is, with no rename`, async () => {
    record();
    const made = sources(SESSION_ID, { processes: SAME });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([...flags], io, made.sources), io.out + io.err).toBe(0);
    expect(made.trace.renamed).toEqual([]);
  });

  test(`${run}: a pane named for something else is never renamed by this path`, async () => {
    record();
    const made = sources(SESSION_ID, { name: 'someone-else', processes: SAME });
    const io = testIo(root, { kind: 'owner' });
    await runUp([...flags], io, made.sources);
    expect(made.trace.renamed).toEqual([]);
    expect(touchedSeat(made.trace).closed).toEqual([]);
  });

  test(`${run}: an unnamed pane running another conversation is not renamed`, async () => {
    record();
    const made = sources('ses_other', { name: null, processes: SAME });
    const io = testIo(root, { kind: 'owner' });
    await runUp([...flags], io, made.sources);
    expect(made.trace.renamed).toEqual([]);
    expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [], runs: [] });
  });
}
