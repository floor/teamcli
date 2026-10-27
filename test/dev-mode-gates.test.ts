// TEAMCLI_DEV_MODE=1 says the "who may run it" gate of `add`, `restart` and `init` once, as a
// stderr warning, and the run continues — exactly as `up` does: the warning is logged where the
// call runs, and a dry run says the refusal it would give beside the one command that unblocks
// it. Unset, and any value but `1`, leaves each refusal where it is; every other refusal — the
// target's, the flags' — stays a refusal in both modes. The approval is the one more gate the
// fold covers: in dev mode the live file counts as approved for `add`, warned and logged the
// same way. `grant`, `delegate`, `revoke` and `approve` never honour dev mode.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runInit } from '../src/commands/init.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T09:00:00Z');
// A seat of the team's own session that is neither its orchestrator nor its operator: the one
// caller the gate refuses, whatever its placement.
const HELPER = { kind: 'seat' as const, name: 'helper', pane: 'w2:p1', session: 'acme' };

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A repository, a home beside it, and nothing else written yet. */
function base(name: string): { root: string; home: string } {
  const held = realpathSync(mkdtempSync(join(tmpdir(), name)));
  dirs.push(held);
  const root = join(held, 'acme');
  const home = join(held, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { root, home };
}

/** That repository with a team file whose orchestrator and operator are `lead`: any other seat
 *  is the gate's refusal. `init`'s scenes start from `base` alone, with no file to find. */
function repo(): { root: string; home: string } {
  const made = base('team-dev-mode-gates-');
  mkdirSync(join(made.root, '.agents'), { recursive: true });
  writeFileSync(join(made.root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${made.root}
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
`);
  return made;
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

/** The launcher every source needs a value for. None of these scenes reaches it: each stops at
 *  the gate or at the refusal just past it. */
function launch(): Launch {
  return {
    sessionState: () => 'absent',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'w1:p1', workspace: 'w1' }),
    paneRun: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [],
    agents: () => [],
    paneText: () => '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
}

function addSources(home: string, extra: Partial<AddSources> = {}): AddSources {
  return {
    home,
    sessionState: () => 'absent',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(home),
    now: () => NOW,
    launch: launch(),
    ...extra,
  };
}

function restartSources(home: string): RestartSources {
  return {
    home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['claude'],
    now: () => NOW,
    sleep: async () => {},
    upLaunch: launch(),
    doctor: doctor(home),
    // A file with no record is not in force, and not refused for it: the gate is what these
    // scenes ask about, so the record is held out of the way.
    standing: () => ({ kind: 'none' }),
  };
}

const ADD_LINE = 'only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is helper';
const RESTART_LINE = 'only the owner or `leads` restarts a seat; this call is helper';
const INIT_LINE = 'only the owner runs this, from a terminal outside herdr; this call is helper';

test('add: unset and any value but 1 refuse the helper; 1 warns, logs and continues', async () => {
  const refused = repo();
  const bare = testIo(refused.root, HELPER);
  expect(await runAdd(['worker'], bare, addSources(refused.home))).toBe(1);
  expect(bare.err).toBe(`team add: ${ADD_LINE}\n`);
  expect(bare.out).toBe('');
  expect(existsSync(join(refused.root, '.agents', 'team.log'))).toBe(false);

  const truthy = repo();
  const other = testIo(truthy.root, HELPER);
  other.env = { TEAMCLI_DEV_MODE: 'true' };
  expect(await runAdd(['worker'], other, addSources(truthy.home))).toBe(1);
  expect(other.err).toBe(`team add: ${ADD_LINE}\n`);

  const warned = repo();
  const io = testIo(warned.root, HELPER);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  // The approval is folded too: in dev mode the live file stands in for the record, so the run
  // passes that gate as well and stops at the target's own refusal (no such seat). That is what
  // proves both gates said their lines and continued rather than deciding.
  expect(await runAdd(['worker'], io, addSources(warned.home, { standing: () => ({ kind: 'legacy' }) }))).toBe(1);
  expect(io.err).toBe(
    `team add: warning: ${ADD_LINE}; dev mode continues\n`
    + `team add: warning: approved before records were signed; the live team file ${join(warned.root, '.agents', 'team.yaml')} counts as approved; dev mode continues\n`
    + 'team add: the file has no seat "worker"\n',
  );
  expect(io.out).toBe('');
  expect(readFileSync(join(warned.root, '.agents', 'team.log'), 'utf8'))
    .toBe(`${NOW.toISOString()} add [helper] warning: ${ADD_LINE}; dev mode continues\n`
      + `${NOW.toISOString()} add [helper] warning: approved before records were signed; the live team file ${join(warned.root, '.agents', 'team.yaml')} counts as approved; dev mode continues\n`);
});

test('add: a dry run says what it would refuse and the one command that unblocks it', async () => {
  const made = repo();
  const io = testIo(made.root, HELPER);
  expect(await runAdd(['worker', '--dry-run'], io, addSources(made.home))).toBe(1);
  expect(io.err).toBe('');
  expect(io.out).toBe(`! add would refuse: ${ADD_LINE}\n`
    + '! to unblock: an approved delegate runs `team add worker` from its own pane when team config names one; otherwise the owner runs it from this folder, at a terminal outside herdr\n');
  expect(existsSync(join(made.root, '.agents', 'team.log'))).toBe(false);
});

test('restart: unset refuses the helper; 1 warns, logs and continues', async () => {
  const refused = repo();
  const bare = testIo(refused.root, HELPER);
  expect(await runRestart(['worker'], bare, restartSources(refused.home))).toBe(1);
  expect(bare.err).toBe(`team restart: ${RESTART_LINE}\n`);
  expect(bare.out).toBe('');

  const warned = repo();
  const io = testIo(warned.root, HELPER);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runRestart(['worker'], io, restartSources(warned.home))).toBe(1);
  expect(io.err).toBe(`team restart: warning: ${RESTART_LINE}; dev mode continues\n`
    + 'team restart: worker is not a signed declared seat\n');
  expect(io.out).toBe('');
  expect(readFileSync(join(warned.root, '.agents', 'team.log'), 'utf8'))
    .toBe(`${NOW.toISOString()} restart [helper] warning: ${RESTART_LINE}; dev mode continues\n`);
});

test('restart: a dry run says what it would refuse and the one command that unblocks it', async () => {
  const made = repo();
  const io = testIo(made.root, HELPER);
  expect(await runRestart(['worker', '--dry-run'], io, restartSources(made.home))).toBe(1);
  expect(io.err).toBe('');
  expect(io.out).toBe(`! restart would refuse: ${RESTART_LINE}\n`
    + '! to unblock: a `leads` seat runs `team restart worker` from its own pane (the owner runs it from this folder, at a terminal outside herdr)\n');
  expect(existsSync(join(made.root, '.agents', 'team.log'))).toBe(false);
});

test('init: unset refuses without writing; 1 warns, writes the skeleton and logs', async () => {
  const refused = base('team-dev-mode-gates-init-');
  const bare = testIo(refused.root, HELPER);
  expect(await runInit([], bare, refused.home, undefined, { loggedIn: () => true, now: () => NOW })).toBe(1);
  expect(bare.err).toBe(`team init: ${INIT_LINE}\n`);
  expect(existsSync(join(refused.root, '.agents'))).toBe(false);

  const made = base('team-dev-mode-gates-init-');
  const io = testIo(made.root, HELPER);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runInit([], io, made.home, undefined, { loggedIn: () => true, now: () => NOW })).toBe(0);
  expect(io.err).toBe(`team init: warning: ${INIT_LINE}; dev mode continues\n`);
  expect(io.out).toContain('Wrote .agents/team.yaml');
  expect(existsSync(join(made.root, '.agents', 'team.yaml'))).toBe(true);
  expect(readFileSync(join(made.root, '.agents', 'team.log'), 'utf8'))
    .toContain(`${NOW.toISOString()} init [helper] warning: ${INIT_LINE}; dev mode continues\n`);
});
