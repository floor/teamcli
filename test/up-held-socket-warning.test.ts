// `team up`'s delivery warning for a seat it keeps: the class is read from the records the last
// launch left, and a cross-session socket whose box held the last frame is no wake. The seat is
// then reported as one time-bound work is never dispatched to, exactly like a pull-on-turn seat.
// The run is a dry run: the plan is made and nothing is launched, closed or typed into.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { CallerSources, Process } from '../src/caller.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { declaredInboundOf, heldSocketPath, recordHeldSocket } from '../src/send/inbound.ts';
import { emptySession, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-31T09:00:00Z');
const SESSION = 'alpha';
const WARNING = 'worker is a reviewer seat and claude-code cannot be woken while it is idle; time-bound work is never dispatched to it';

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: 'ignore', env: gitEnv(),
  });
}

/** A lead whose pane is a person's, and the reviewer these scenes read: kept by the run, with a
 *  launch record and a pane process a previous launch left. */
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
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    human: true
  - role: reviewer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
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

/** The record the last launch left for the reviewer, and the pane process that is still its own. */
function record(): void {
  updateState(dir, (state) => {
    state.sessions[SESSION] = {
      ...emptySession(),
      seats: {
        worker: {
          stage: 'ready',
          pane: 'fixture-pane-1',
          workspace: 'fixture-ws-1',
          launched: { shell: 100, cli: [200] },
          cli: 'claude-code',
          launch_line: 'claude --model claude-opus-5-5',
        },
      },
    };
  });
}

const TERMINAL: Process[] = [{ pid: 50, name: 'zsh' }, { pid: 40, name: 'login' }, { pid: 30, name: 'Terminal' }];

/** The owner at a terminal outside the terminal host: the run every gate admits. */
function ownerIo(): ReturnType<typeof testIo> {
  const io = testIo(root);
  const sources: CallerSources = {
    ancestors: () => TERMINAL,
    agents: () => { throw new Error('the walk asked the terminal host for a session'); },
    paneRootPid: () => { throw new Error('the walk asked the terminal host for a pane root'); },
    env: {},
    stdinIsTTY: true,
  };
  io.callerSources = () => sources;
  return io;
}

function doctor(): DoctorSources {
  return {
    version: () => '2.1.289',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
  };
}

/** The running session the kept seat lives in: its pane still holds the recorded launch, and its
 *  screen shows the model the seat was signed to run. */
function upSources(): UpSources {
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'fixture-pane-new', workspace: 'fixture-ws-new' }),
    paneRun: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => ['fixture-pane-1'],
    agents: (_session: string) => [{ name: 'worker', pane: 'fixture-pane-1', agent: 'claude', workspace: 'fixture-ws-1', status: 'idle', cwd: null }],
    processInfo: (_session: string, pane: string) => (pane === 'fixture-pane-1' ? { shell: 100, foreground: [200] } : null),
    paneText: () => CLAUDE_IDLE,
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
  return {
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: (session: string) => launch.agents(session),
    home,
    doctor: doctor(),
    launch,
    now: () => NOW,
  };
}

/** The launch's socket: generated settings that declare accept, a registry record naming an
 *  address standing in the seat's pane, and the socket itself. The settings are written first and
 *  backdated, so the socket does not predate its declaration. */
function socketSeat(): void {
  mkdirSync(join(dir, 'hooks', SESSION), { recursive: true });
  const settings = join(dir, 'hooks', SESSION, 'worker.json');
  writeFileSync(settings, '{"crossSessionInbound":"accept"}\n');
  const backdated = new Date(NOW.getTime() - 60_000);
  utimesSync(settings, backdated, backdated);
  const socket = join(base, 'worker.sock');
  writeFileSync(socket, '');
  registerAgent(home, {
    name: 'worker',
    signing: { model: 'Claude Opus', version: '5.5', role: 'reviewer' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: teamIdOf(root), seat: 'worker', session: SESSION, pane: 'fixture-pane-1', address: socket },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-held-socket-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  git(root, 'init', '-q', '-b', 'main');
  setup();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("up's delivery warning for a seat it keeps", () => {
  test('a standing socket is a wake, and the held box is not: the warning follows the class', async () => {
    record();
    socketSeat();
    // Control: the recorded address stands and no mark is under the declaration, so the kept
    // reviewer is push-class and no warning is owed.
    const before = ownerIo();
    expect(await runUp(['--dry-run'], before, upSources())).toBe(0);
    expect(before.out).not.toContain('cannot be woken while it is idle');

    // The box held the last frame under the declaration now in force: the send would not dial,
    // so the kept seat cannot be woken while idle and the run says so.
    recordHeldSocket(
      heldSocketPath(dir, SESSION, 'worker'),
      declaredInboundOf({ dir, root, session: SESSION, seat: 'worker', launch: 'claude --model claude-opus-5-5' }),
      NOW,
    );
    const after = ownerIo();
    expect(await runUp(['--dry-run'], after, upSources())).toBe(0);
    expect(after.out).toContain(`! ${WARNING}\n`);
  });
});
