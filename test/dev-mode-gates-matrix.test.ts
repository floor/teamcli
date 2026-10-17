// The dev-mode gates matrix. TEAMCLI_DEV_MODE=1 turns a command's caller gate into a warning
// (a log line beside it where the command logs) and the run continues past it; unset, every gate
// refuses as always. `grant`, `delegate`, `revoke` and `approve` are owner-only in every mode.
// Every file, caller and pane below is synthetic.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runApprove, type ApproveSources } from '../src/approve/command.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runDelegate } from '../src/commands/delegate.ts';
import { runDown, type DownLaunch, type DownSources } from '../src/commands/down.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runInit } from '../src/commands/init.ts';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import { runRevoke } from '../src/commands/revoke.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { readState } from '../src/state.ts';
import type { Screen } from '../src/watch/screen.ts';
import { claudeBox, CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const IDLE = CLAUDE_IDLE;
const NOW = new Date('2026-10-15T12:00:00Z');
const UNPLACED = { kind: 'unplaced' as const, reason: 'it runs under herdr' };

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function file(root: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

function repo(builder: (root: string) => string = file): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-dev-matrix-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), builder(root));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { root, home };
}

/** A repository with no team file and a home of its own beside it: `init`'s starting point. */
function emptyRepo(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-dev-matrix-init-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { root, home };
}

function approve(home: string, root: string): void {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: readFileSync(join(root, '.agents', 'team.yaml'), 'utf8') },
    loaded.team.seats,
    home,
    NOW,
  );
}

function doctor(home: string): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

/** The launch world `team up` mounts into: every pane it makes is idle and named. */
function upWorld(): { launch: Launch; runs: { pane: string; command: string }[] } {
  const panes: string[] = [];
  const runs: { pane: string; command: string }[] = [];
  let n = 0;
  const launch: Launch = {
    sessionState: () => 'absent',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      n += 1;
      const pane = `w${n}:p1`;
      panes.push(pane);
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      runs.push({ pane, command });
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => panes,
    agents: () => [],
    paneText: () => IDLE,
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
    spawnWatch: () => 1,
  };
  return { launch, runs };
}

function upSources(home: string, launch: Launch): UpSources {
  return {
    sessionRunning: () => false,
    sessionState: () => 'absent',
    agents: () => [],
    home,
    doctor: doctor(home),
    launch,
    now: () => NOW,
  };
}

function downSources(home: string, stopped: { n: number }): DownSources {
  return {
    sessionRunning: () => true,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => [],
    now: () => NOW,
    sleep: async () => {},
    home,
    launch: {
      typeText: () => true,
      sendKey: () => true,
      pressEnter: () => true,
      agentPanes: () => [],
      closeWorkspace: () => true,
      stopSession: () => {
        stopped.n += 1;
        return true;
      },
      deleteSession: () => true,
      kill: () => true,
      sleep: async () => {},
      now: () => NOW,
    },
  };
}

/** `add`'s sources. `live` is the session the run reads once the gate is behind it; every scene
 *  stops at or before that read, so the launch, the agents and the workspaces never matter. */
function addSources(home: string, live: 'running' | 'stopped' | null): AddSources {
  return {
    home,
    sessionState: () => live,
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(home),
    now: () => NOW,
    launch: upWorld().launch,
  };
}

/** `restart`'s sources: the stop world's shape plus restart's own launch, session read and
 *  doctor. `live` is the herdr answer past the gate; the scenes stop at or before it. */
function restartSources(home: string, live: 'running' | 'stopped' | null): RestartSources {
  return {
    home,
    sessionRunning: () => true,
    agents: () => [],
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => [],
    now: () => NOW,
    sleep: async () => {},
    launch: {
      typeText: () => true,
      sendKey: () => true,
      pressEnter: () => true,
      agentPanes: () => [],
      closeWorkspace: () => true,
      stopSession: () => false,
      deleteSession: () => false,
      kill: () => false,
      sleep: async () => {},
      now: () => NOW,
    },
    sessionState: () => live,
    workspaces: () => [],
    upLaunch: upWorld().launch,
    doctor: doctor(home),
  };
}

/** `register` past its gate: the session runs and herdr places no agent of the seat's name. */
function registerSources(home: string): RegisterSources {
  return {
    home,
    sessionState: () => 'running',
    agents: () => [],
    processInfo: () => null,
    paneText: () => null,
    now: () => NOW,
  };
}

// --- up ---------------------------------------------------------------------------------------
// The caller gate is the placement line: `up` is the owner's, run from a terminal outside herdr.

test('up: unset, the caller gate refuses; set, it is a warning and the mount continues', async () => {
  const refused = repo();
  const refusedWorld = upWorld();
  const refusedIo = testIo(refused.root, UNPLACED);
  const refusedCode = await runUp([], refusedIo, upSources(refused.home, refusedWorld.launch));
  expect(refusedCode).toBe(1);
  expect(refusedIo.err).toBe('deny\n');
  expect(refusedIo.out).toBe('');
  expect(refusedWorld.runs).toEqual([]);

  const mounted = repo();
  const mountedWorld = upWorld();
  const mountedIo = testIo(mounted.root, UNPLACED);
  mountedIo.env = { TEAMCLI_DEV_MODE: '1' };
  const mountedCode = await runUp([], mountedIo, upSources(mounted.home, mountedWorld.launch));
  expect(mountedCode).toBe(0);
  expect(mountedIo.err).toContain('team up: warning:');
  expect(mountedIo.err).toContain('only the owner or `leads` starts the team; this call is unplaced (it runs under herdr)');
  expect(mountedIo.err).not.toContain('team up: only the owner or `leads` starts the team');
  expect(mountedWorld.runs.map((run) => run.command).join('\n')).toContain('claude --model claude-opus-5-5');
  expect(readState(join(mounted.root, '.agents')).sessions.acme?.seats.lead?.stage).toBe('ready');
});

// --- down -------------------------------------------------------------------------------------

test('down: unset, the caller gate refuses; set, it is a warning and the stop continues', async () => {
  const placement = 'only the owner or `leads` stops the team; this call is unplaced (it runs under herdr)';
  const refused = repo();
  approve(refused.home, refused.root);
  const refusedStopped = { n: 0 };
  const refusedIo = testIo(refused.root, UNPLACED);
  const refusedCode = await runDown([], refusedIo, downSources(refused.home, refusedStopped));
  expect(refusedCode).toBe(1);
  expect(refusedIo.err).toContain(`team down: ${placement}\n`);
  expect(refusedStopped.n).toBe(0);

  const stoppedRepo = repo();
  approve(stoppedRepo.home, stoppedRepo.root);
  const didStop = { n: 0 };
  const stoppedIo = testIo(stoppedRepo.root, UNPLACED);
  stoppedIo.env = { TEAMCLI_DEV_MODE: '1' };
  const stoppedCode = await runDown([], stoppedIo, downSources(stoppedRepo.home, didStop));
  expect(stoppedCode).toBe(0);
  expect(stoppedIo.err).toContain('team down: warning:');
  expect(stoppedIo.err).toContain(placement);
  expect(stoppedIo.err).not.toContain(`team down: ${placement}`);
  expect(didStop.n).toBe(1);
});

// --- remove -----------------------------------------------------------------------------------
// `remove`'s dev-mode gate is the owner-only `--abandon`; the ordinary caller gate and every
// other refusal stay as they are.

const REMOVE_FILE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
  base: main
seats:
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const REMOVE_DELEGATES = `delegates:
  - pane: main/w1:p1
    commands: [add, remove]
`;

const pilot = { kind: 'seat' as const, name: 'pilot', pane: 'w1:p1', session: 'main' };
const passed = { kind: 'passed' as const, pane: 'main/w1:p1' };

function removeWorld(home: string, screen: Screen = { kind: 'idle' }, status = 'idle'): {
  sources: RemoveSources;
  typed: string[];
  keys: string[];
  closed: string[];
  agents: HerdrAgent[];
  running: boolean[];
} {
  const typed: string[] = [];
  const keys: string[] = [];
  const closed: string[] = [];
  let sent = false;
  let box: string | undefined = claudeBox('');
  const agents: HerdrAgent[] = [];
  const running: boolean[] = [];
  let clock = 0;
  const launch: DownLaunch = {
    typeText: (_session, _pane, text) => { typed.push(text); box = claudeBox(text); return true; },
    sendKey: (_session, _pane, key) => { keys.push(key); box = claudeBox(''); return true; },
    pressEnter: () => { sent = true; return true; },
    agentPanes: () => agents.map((agent) => agent.pane),
    closeWorkspace: (_session, workspace) => { closed.push(workspace); return true; },
    stopSession: () => false,
    deleteSession: () => false,
    kill: () => false,
    sleep: async (ms) => { clock += ms; },
    now: () => new Date(clock),
  };
  const sources: RemoveSources = {
    home,
    sessionRunning: () => true,
    agents: () => agents,
    alive: () => false,
    screen: () => screen,
    screenText: () => box,
    status: () => status,
    now: () => new Date(clock),
    sleep: async (ms) => { clock += ms; },
    launch,
    foreground: () => (running[0] === true ? ['claude'] : sent || running[0] === false ? [] : ['claude']),
  };
  return { sources, typed, keys, closed, agents, running };
}

test('remove --abandon: unset, the owner-only gate refuses; set, it is a warning and the close continues', async () => {
  const { root, home } = repo(() => REMOVE_FILE + REMOVE_DELEGATES);
  approve(home, root);

  const refused = removeWorld(home);
  refused.agents.push({ name: 'worker', agent: 'claude', pane: 'w3:p1', workspace: 'w3', status: 'idle', cwd: null });
  const refusedIo = testIo(root, pilot);
  const refusedCode = await runRemove(['worker', '--abandon'], refusedIo, { ...refused.sources, delegateGate: () => passed });
  expect(refusedCode).toBe(1);
  expect(refusedIo.err).toBe('team remove: only the owner abandons a seat, from a terminal outside herdr\n');
  expect(refused.closed).toEqual([]);

  const continued = removeWorld(home);
  continued.agents.push({ name: 'worker', agent: 'claude', pane: 'w3:p1', workspace: 'w3', status: 'idle', cwd: null });
  const continuedIo = testIo(root, pilot);
  continuedIo.env = { ...continuedIo.env, TEAMCLI_DEV_MODE: '1' };
  const continuedCode = await runRemove(['worker', '--abandon'], continuedIo, { ...continued.sources, delegateGate: () => passed });
  expect(continuedCode).toBe(0);
  expect(continuedIo.err).toContain('team remove: warning: only the owner abandons a seat, from a terminal outside herdr; dev mode continues\n');
  expect(continued.closed).toContain('w3');
});

// --- add --------------------------------------------------------------------------------------
// Past the gate under dev mode the run reads the session next: with it stopped, that reading
// refuses — which a run still standing at the gate could never say. The exact `1` is the mode;
// `true` is not it.

const ADD_LINE = 'only the owner or a standing grant (delegate) runs it; this call is unplaced (it runs under herdr)';
const RESTART_LINE = 'only the owner or `leads` restarts a seat; this call is unplaced (it runs under herdr)';
const INIT_LINE = 'only the owner runs init, from a terminal outside herdr; this call is unplaced (it runs under herdr)';

test('add: unset, the caller gate refuses; set, it warns, logs and the run reads on', async () => {
  const refused = repo();
  const refusedIo = testIo(refused.root, UNPLACED);
  expect(await runAdd(['worker'], refusedIo, addSources(refused.home, 'stopped'))).toBe(1);
  expect(refusedIo.err).toBe(`team add: ${ADD_LINE}\n`);
  expect(refusedIo.out).toBe('');
  expect(existsSync(join(refused.root, '.agents', 'team.log'))).toBe(false);

  const truthy = repo();
  const truthyIo = testIo(truthy.root, UNPLACED);
  truthyIo.env = { ...truthyIo.env, TEAMCLI_DEV_MODE: 'true' };
  expect(await runAdd(['worker'], truthyIo, addSources(truthy.home, 'stopped'))).toBe(1);
  expect(truthyIo.err).toBe(`team add: ${ADD_LINE}\n`);

  const readOn = repo();
  const readIo = testIo(readOn.root, UNPLACED);
  readIo.env = { ...readIo.env, TEAMCLI_DEV_MODE: '1' };
  expect(await runAdd(['worker'], readIo, addSources(readOn.home, 'stopped'))).toBe(1);
  // The warning is the gate moved aside; the line after it is the run having moved with it.
  expect(readIo.err).toBe(
    `team add: warning: ${ADD_LINE}; dev mode continues\n`
    + 'team add: session acme is stopped; clear it with `herdr session delete acme`\n',
  );
  expect(readIo.out).toBe('');
  expect(readFileSync(join(readOn.root, '.agents', 'team.log'), 'utf8'))
    .toBe(`${NOW.toISOString()} add [unplaced (it runs under herdr)] warning: ${ADD_LINE}; dev mode continues\n`);
});

// --- restart ----------------------------------------------------------------------------------
// Past the gate under dev mode the restart reads herdr next: with no answer it refuses there,
// which only a run that moved past the gate can say.

test('restart: unset, the caller gate refuses; set, it warns, logs and the run reads on', async () => {
  const refused = repo();
  approve(refused.home, refused.root);
  const refusedIo = testIo(refused.root, UNPLACED);
  expect(await runRestart(['lead'], refusedIo, restartSources(refused.home, null))).toBe(1);
  expect(refusedIo.err).toBe(`team restart: ${RESTART_LINE}\n`);
  expect(refusedIo.out).toBe('');
  expect(existsSync(join(refused.root, '.agents', 'team.log'))).toBe(false);

  const readOn = repo();
  approve(readOn.home, readOn.root);
  const readIo = testIo(readOn.root, UNPLACED);
  readIo.env = { ...readIo.env, TEAMCLI_DEV_MODE: '1' };
  expect(await runRestart(['lead'], readIo, restartSources(readOn.home, null))).toBe(1);
  expect(readIo.err).toBe(`team restart: warning: ${RESTART_LINE}; dev mode continues\nteam restart: herdr doesn't answer\n`);
  expect(readIo.out).toBe('');
  expect(readFileSync(join(readOn.root, '.agents', 'team.log'), 'utf8'))
    .toBe(`${NOW.toISOString()} restart [unplaced (it runs under herdr)] warning: ${RESTART_LINE}; dev mode continues\n`);
});

// --- init -------------------------------------------------------------------------------------
// Under dev mode the gate warns and `init` writes the team file it was there to write; unset,
// nothing is written at all.

test('init: unset, the caller gate refuses and nothing is written; set, it warns, logs and writes', async () => {
  const refused = emptyRepo();
  const refusedIo = testIo(refused.root, UNPLACED);
  expect(await runInit([], refusedIo, refused.home, undefined, { loggedIn: () => true, now: () => NOW })).toBe(1);
  expect(refusedIo.err).toBe(`team init: ${INIT_LINE}\n`);
  expect(existsSync(join(refused.root, '.agents'))).toBe(false);

  const wrote = emptyRepo();
  const wroteIo = testIo(wrote.root, UNPLACED);
  wroteIo.env = { ...wroteIo.env, TEAMCLI_DEV_MODE: '1' };
  expect(await runInit([], wroteIo, wrote.home, undefined, { loggedIn: () => true, now: () => NOW })).toBe(0);
  expect(wroteIo.err).toBe(`team init: warning: ${INIT_LINE}; dev mode continues\n`);
  expect(existsSync(join(wrote.root, '.agents', 'team.yaml'))).toBe(true);
  expect(readFileSync(join(wrote.root, '.agents', 'team.log'), 'utf8'))
    .toContain(`${NOW.toISOString()} init [unplaced (it runs under herdr)] warning: ${INIT_LINE}; dev mode continues\n`);
});

// --- register ---------------------------------------------------------------------------------
// Past the gate under dev mode the run reads the file and herdr next: the session is running,
// herdr places no agent of the name, and that refusal — which dev mode never lifts — is the line
// that shows the run moved past the gate. The warning is stderr-only: `register` logs when a
// registration completes, and none did.

const REGISTER_LINE = 'only the owner or a seat of this team registers a running seat; this call is unplaced (it runs under herdr)';

test('register: unset, the caller gate refuses; set, it warns and the run reads on', async () => {
  const refused = repo();
  const refusedIo = testIo(refused.root, UNPLACED);
  expect(await runRegister(['lead'], refusedIo, registerSources(refused.home))).toBe(1);
  expect(refusedIo.err).toBe(`team register: ${REGISTER_LINE}\n`);
  expect(refusedIo.out).toBe('');
  expect(existsSync(join(refused.root, '.agents', 'team.log'))).toBe(false);

  const truthy = repo();
  const truthyIo = testIo(truthy.root, UNPLACED);
  truthyIo.env = { ...truthyIo.env, TEAMCLI_DEV_MODE: 'true' };
  expect(await runRegister(['lead'], truthyIo, registerSources(truthy.home))).toBe(1);
  expect(truthyIo.err).toBe(`team register: ${REGISTER_LINE}\n`);

  const readOn = repo();
  const readIo = testIo(readOn.root, UNPLACED);
  readIo.env = { ...readIo.env, TEAMCLI_DEV_MODE: '1' };
  expect(await runRegister(['lead'], readIo, registerSources(readOn.home))).toBe(1);
  expect(readIo.err).toBe(
    `team register: warning: ${REGISTER_LINE}\n`
    + 'team register: no agent named lead is running in session "acme"; nothing was registered\n',
  );
  expect(readIo.out).toBe('');
  expect(existsSync(join(readOn.root, '.agents', 'team.log'))).toBe(false);
});

// --- the owner-only edits ---------------------------------------------------------------------
// Dev mode waives caller gates; it never widens `grant`, `delegate`, `revoke` or `approve`.

describe('the owner-only edits are not dev-mode gates', () => {
  test('grant refuses an unplaced caller with the mode unset and with it set', async () => {
    const { root, home } = repo();
    const off = testIo(root, UNPLACED);
    expect(await runGrant(['lead', '--scope', 'up'], off, { home })).toBe(1);
    expect(off.err).toBe('team grant: only the owner runs this, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n');

    const on = testIo(root, UNPLACED);
    on.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runGrant(['lead', '--scope', 'up'], on, { home })).toBe(1);
    expect(on.err).toBe(off.err);
  });

  test('delegate refuses an unplaced caller with the mode unset and with it set', async () => {
    const { root, home } = repo();
    const off = testIo(root, UNPLACED);
    expect(await runDelegate(['main/w9:p1', '--commands', 'up'], off, { home })).toBe(1);
    expect(off.err).toBe('team delegate: only the owner runs this, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n');

    const on = testIo(root, UNPLACED);
    on.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runDelegate(['main/w9:p1', '--commands', 'up'], on, { home })).toBe(1);
    expect(on.err).toBe(off.err);
  });

  test('revoke refuses an unplaced caller with the mode unset and with it set', async () => {
    const { root, home } = repo();
    const off = testIo(root, UNPLACED);
    expect(await runRevoke(['grant'], off, { home })).toBe(1);
    expect(off.err).toBe('team revoke: only the owner runs this, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n');

    const on = testIo(root, UNPLACED);
    on.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runRevoke(['grant'], on, { home })).toBe(1);
    expect(on.err).toBe(off.err);
  });

  test('approve refuses an unplaced caller with the mode unset and with it set', async () => {
    const { root, home } = repo();
    const sources = (): ApproveSources => ({ ask: async () => null, waiting: () => 'empty', now: () => NOW, home });
    const off = testIo(root, UNPLACED);
    expect(await runApprove([], off, sources())).toBe(1);
    // The load's own warning line may precede it; the refusal is the gate's sentence, and the
    // mode changes nothing about it.
    expect(off.err).toContain('team approve: only the owner approves a team file, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n');
    expect(off.err).not.toContain('warning: only the owner');

    const on = testIo(root, UNPLACED);
    on.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runApprove([], on, sources())).toBe(1);
    expect(on.err).toBe(off.err);
  });
});
