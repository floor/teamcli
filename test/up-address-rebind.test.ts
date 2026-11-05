// The address `team up` records without a restart (delivery reliability): a seat whose record
// names its launch but not the socket its session answers at stays pull-only — every send to it
// goes to its drop folder. The run reads each live pane once, through the same seam its own
// steps used, and writes the socket the reading proves. The record's own identity is the gate,
// and it is the security rule of this file: a pane whose process is not the one team launched,
// or a record that names no process at all, is never given an address — a send that dialed one
// would wake a process this record cannot name.
//
// Every pane, process reading, socket and registry here is a synthetic fixture: no live terminal
// host, no socket of the machine's own, and no provider is read.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { findAgent, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState, type SeatState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T11:00:00Z');
const SESSION = 'acme';
const LEAD = 'lead';
const WORKER = 'worker';
const HANDLE = 'seat_0123456789ab';
const SES = 'ses_a1b2c3d4e5f6';
const MODEL = 'Claude Opus';
const VERSION = '5.5';
const LAUNCH = 'claude --model claude-opus-5-5';
// The seat's own pane and workspace, as its launch recorded them. Neutral ids: the fixtures name
// no real terminal host's pane.
const PANE = 'fixture-pane-one';
const SPACE = 'fixture-space';
const RECORDED = { shell: 100, cli: [200] };

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;
let sockets: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: 'ignore', env: gitEnv(),
  });
}

/** A human lead and the implementer whose address the scenes read. */
function teamText(): string {
  return `format: 1
project: acme
coordinator: ${LEAD}
operator: ${LEAD}
session: ${SESSION}
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${LEAD}
    label: ${LEAD}
    cli: claude-code
    vendor: anthropic
    model: ${MODEL}
    version: "${VERSION}"
    launch: ${LAUNCH}
    human: true
  - role: implementer
    name: ${WORKER}
    label: ${WORKER}
    cli: claude-code
    vendor: anthropic
    model: ${MODEL}
    version: "${VERSION}"
    launch: ${LAUNCH}
`;
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

/** The record a launch left: the seat on PANE/SPACE, at the stage the scene reads, with the
 *  process identity the scene's pane reading can agree with — or none, for the old record. */
function recordWorker(over: { stage: 'ready' | 'launched'; launched?: { shell: number; cli: number[] } }): void {
  const held: SeatState = {
    stage: over.stage,
    id: HANDLE,
    pane: PANE,
    workspace: SPACE,
    ...(over.launched === undefined ? {} : { launched: over.launched }),
    agent_session: SES,
    model: MODEL,
    version: VERSION,
    launch_line: LAUNCH,
  };
  updateState(dir, (file) => {
    const session = (file.sessions[SESSION] ??= emptySession());
    session.seats[WORKER] = held;
    // A live pane watch already carries this route: no watch of this run's own is started beside
    // it, so the scene reads the seat's record and nothing else.
    session.watch = { heartbeat: NOW.toISOString(), pane: 'fixture-watch-pane' };
  });
}

/** The agent record the system keeps, with the address the scene starts from. */
function registerWorker(address: string | null): void {
  registerAgent(home, {
    name: WORKER,
    signing: { model: MODEL, version: VERSION, role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: LAUNCH,
    reach: { team: teamIdOf(root), seat: WORKER, session: SESSION, pane: PANE, address, agent_session: SES },
    seat_handle: HANDLE,
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

/** A socket on disk, stood in for by an empty file: every reader here is `existsSync` on the
 *  path. In the fixture folder, never the machine's own. */
function sock(pid: number): string {
  const path = join(sockets, `${String(pid)}.sock`);
  writeFileSync(path, '');
  return path;
}

const address = (): string | null => findAgent(home, { team: teamIdOf(root), seat: WORKER })?.reach.address ?? null;
const seat = (): SeatState | undefined => readState(dir).sessions[SESSION]?.seats[WORKER];
const said = (io: { out: string; err: string }): string => `${io.out}${io.err}`;

type World = {
  sources: UpSources;
  trace: { runs: string[]; created: string[]; closed: string[] };
  /** Every pane the run read, in order: the one reading its steps used is its address reading. */
  reads: string[];
};

/** The session this run reads: one pane, the worker's, holding the process the scene gives. */
function makeWorld(first: {
  process: { shell: number; foreground: number[] } | null;
  name: string | null;
  /** What the pane's screen reads as. Default: the captured idle prompt. */
  screen?: string;
}): World {
  const trace = { runs: [] as string[], created: [] as string[], closed: [] as string[] };
  const reads: string[] = [];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      trace.created.push(label);
      return { pane: 'fixture-pane-new', workspace: 'fixture-space-new' };
    },
    paneRun(_session, pane, command) {
      trace.runs.push(`${pane}: ${command}`);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    agentPanes: () => [PANE],
    agents: () => first.name === null
      ? []
      : [{ name: first.name, agent: 'claude', pane: PANE, workspace: SPACE, status: 'idle', cwd: root }],
    workspacePanes: () => [PANE],
    paneText: () => first.screen ?? CLAUDE_IDLE,
    foreground: () => (first.process === null ? null : ['claude']),
    processInfo(_session, pane) {
      reads.push(pane);
      return pane === PANE ? first.process : null;
    },
    shellBack: () => false,
    sleep: async () => {},
    now: () => NOW,
  };
  const doctor: DoctorSources = {
    version: () => '2.1.289',
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
      agents: () => launch.agents(SESSION),
      workspaces: () => [{ id: SPACE, label: WORKER }],
      home,
      doctor,
      launch,
      sockets,
      now: () => NOW,
      sleep: async () => {},
    },
    trace,
    reads,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-address-rebind-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  sockets = join(base, 'socks');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  mkdirSync(sockets, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  setup();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("up's address rebind", () => {
  test('a live seat this run leaves at launched records its address: nothing launched, nothing restarted', async () => {
    recordWorker({ stage: 'launched', launched: RECORDED });
    registerWorker(null);
    const live = sock(200);
    // The seat's own CLI is in front, with the pids the record names, and its screen never reads
    // as a prompt: the shape a launch that stopped before its idle prompt leaves. The detached
    // run — the daemon's sweep is one — leaves such a seat at launched rather than prompting for
    // it, and the seat is still live when the run ends.
    const made = makeWorld({
      process: { shell: 100, foreground: [200] },
      name: WORKER,
      screen: 'a screen this version has no prompt for',
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, made.sources, { nonInteractive: true }), `up said:\n${said(io)}`).toBe(1);
    expect(said(io)).toContain('left at launched');

    // No launch, no workspace made or closed: the seat was left exactly as it ran.
    expect(made.trace.runs).toEqual([]);
    expect(made.trace.created).toEqual([]);
    expect(made.trace.closed).toEqual([]);
    expect(seat()?.stage).toBe('launched');
    expect(seat()?.launched).toEqual(RECORDED);

    // The address alone was repaired, through the run's own pane reading, and it is the socket
    // the pane's own CLI pid listens on.
    expect(made.reads).toContain(PANE);
    expect(address()).toBe(live);
  });

  test('a ready seat records its address through the run\'s one pane reading', async () => {
    recordWorker({ stage: 'ready', launched: RECORDED });
    registerWorker(null);
    const live = sock(200);
    const made = makeWorld({ process: { shell: 100, foreground: [200] }, name: WORKER });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, made.sources), `up said:\n${said(io)}`).toBe(0);

    expect(made.trace.runs).toEqual([]);
    expect(seat()?.stage).toBe('ready');
    expect(address()).toBe(live);
  });

  test('a seat the run cannot tie to its pane is never given the socket that pane listens on', async () => {
    recordWorker({ stage: 'launched', launched: RECORDED });
    registerWorker(null);
    // A socket is live for the process in the pane, and the pane holds a process the record does
    // not name. Its launch record never reached ready, so the run cannot re-tie it: the seat is
    // left out, and an address here would wake a process this record cannot name.
    sock(300);
    const made = makeWorld({ process: { shell: 100, foreground: [300] }, name: null });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, made.sources), `up said:\n${said(io)}`).toBe(1);

    expect(made.trace.runs).toEqual([]);
    expect(made.trace.created).toEqual([]);
    expect(seat()?.stage).not.toBe('ready');
    expect(address()).toBeNull();
  });

  test('a ready seat whose process was never recorded is left to team register, with no address', async () => {
    recordWorker({ stage: 'ready' });
    registerWorker(null);
    // The record predates process identities. The pane runs a CLI and a socket is live, but no
    // record names that process: registering both is `team register`'s read to make, never this
    // run's guess.
    sock(200);
    const made = makeWorld({ process: { shell: 100, foreground: [200] }, name: WORKER });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, made.sources), `up said:\n${said(io)}`).toBe(0);

    expect(made.trace.runs).toEqual([]);
    expect(seat()?.stage).toBe('ready');
    expect(address()).toBeNull();
    expect(said(io)).toContain(`team register ${WORKER}`);
  });
});
