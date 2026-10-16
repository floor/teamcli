// TEAMCLI_BYPASS: the named, scoped form of the dev-mode waivers. `project:<name>` covers the
// acts on that team file's project, `seat:<name>` the acts about that seat, and `all` the whole
// reach `TEAMCLI_DEV_MODE=1` has. A scope that matches nothing — a different project, another
// seat, a malformed entry — leaves every refusal where it is. Every waiver still prints its
// warning, now naming the scope that made it. Nothing durable is written, as with dev mode.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { bypassScopes, matchBypass } from '../src/bypass.ts';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { keyFolder } from '../src/store/keys.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { readState } from '../src/state.ts';
import { gitEnv, testIo } from './helpers.ts';

const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
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

function repo(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-scoped-bypass-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), file(root));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { root, home };
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

function world(): { launch: Launch; runs: { pane: string; command: string }[] } {
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

function sources(home: string, launch: Launch): UpSources {
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

/** Approval records, the signing key, and a grant file. A rules file or a pane pointer is a mount. */
function approvalArtifacts(home: string, root: string): string[] {
  const found: string[] = [];
  if (existsSync(keyFolder(home))) found.push(keyFolder(home));
  const store = storePath('acme', root, home);
  for (const name of ['approval.json', 'approved.yaml']) {
    const path = join(store, name);
    if (existsSync(path)) found.push(path);
  }
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (name === 'approval.json' || name === 'approved.yaml' || name === 'grant.json') found.push(path);
      try {
        if (statSync(path).isDirectory()) walk(path);
      } catch {
        // A name that vanished between the read and the stat is not an artifact.
      }
    }
  };
  walk(home);
  return found;
}

/** Bytes of every approval, key, and grant under home. A rules file is not one of these. */
function durableBytes(home: string): string {
  const found: string[] = [];
  const take = (path: string) => {
    found.push(`${path}\n${readFileSync(path)}`);
  };
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let directory = false;
      try {
        directory = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (directory) walk(path);
      else if (name === 'approval.json' || name === 'approved.yaml' || name === 'grant.json') take(path);
    }
  };
  walk(home);
  const keys = keyFolder(home);
  if (existsSync(keys)) {
    const walkKey = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walkKey(path);
        else take(path);
      }
    };
    walkKey(keys);
  }
  return found.sort().join('\n---\n');
}

function approve(home: string, root: string): void {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  const text = readFileSync(join(root, '.agents', 'team.yaml'), 'utf8');
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
}

test('the project scope mounts an unapproved file, and its warning names the scope', async () => {
  const { root, home } = repo();
  const before = durableBytes(home);
  const made = world();
  const io = testIo(root, UNPLACED);
  io.env = { TEAMCLI_BYPASS: 'project:acme' };
  const code = await runUp([], io, sources(home, made.launch));
  expect(code).toBe(0);
  expect(io.err).toContain('team up: warning:');
  expect(io.err).toContain('only the owner runs `up`, from a terminal outside herdr; this call is unplaced (it runs under herdr)');
  expect(io.err).toContain('the scoped bypass continues (TEAMCLI_BYPASS project "acme")');
  expect(io.err).not.toContain('team approve');
  expect(made.runs.map((run) => run.command).join('\n')).toContain('claude --model claude-opus-5-5');
  expect(readState(join(root, '.agents')).sessions.acme?.seats.lead?.stage).toBe('ready');
  expect(durableBytes(home)).toBe(before);
  expect(approvalArtifacts(home, root)).toEqual([]);
});

test('the same run under another project refuses, with no warning', async () => {
  const { root, home } = repo();
  const made = world();
  const io = testIo(root, UNPLACED);
  io.env = { TEAMCLI_BYPASS: 'project:other' };
  const code = await runUp([], io, sources(home, made.launch));
  expect(code).toBe(1);
  expect(io.err).toBe('deny\n');
  expect(io.out).toBe('');
  expect(made.runs).toEqual([]);
  expect(approvalArtifacts(home, root)).toEqual([]);
});

test('a seat scope never covers a whole-team up, and `all` is the dev-mode reach', async () => {
  const seatScoped = repo();
  const seatWorld = world();
  const seatIo = testIo(seatScoped.root, UNPLACED);
  seatIo.env = { TEAMCLI_BYPASS: 'seat:lead' };
  expect(await runUp([], seatIo, sources(seatScoped.home, seatWorld.launch))).toBe(1);
  expect(seatIo.err).toBe('deny\n');
  expect(seatWorld.runs).toEqual([]);

  const allScoped = repo();
  const allWorld = world();
  const allIo = testIo(allScoped.root, UNPLACED);
  allIo.env = { TEAMCLI_BYPASS: 'all' };
  expect(await runUp([], allIo, sources(allScoped.home, allWorld.launch))).toBe(0);
  expect(allIo.err).toContain('the scoped bypass continues (TEAMCLI_BYPASS)');
  expect(allIo.err).not.toContain('team approve');
  expect(allWorld.runs.map((run) => run.command).join('\n')).toContain('claude --model claude-opus-5-5');
});

test('with dev mode set beside it, the bypass is not read: dev mode keeps its own words', async () => {
  const { root, home } = repo();
  const made = world();
  const io = testIo(root, UNPLACED);
  io.env = { TEAMCLI_DEV_MODE: '1', TEAMCLI_BYPASS: 'project:acme' };
  const code = await runUp([], io, sources(home, made.launch));
  expect(code).toBe(0);
  expect(io.err).toContain('team up: warning:');
  expect(io.err).not.toContain('the scoped bypass');
  expect(made.runs.map((run) => run.command).join('\n')).toContain('claude --model claude-opus-5-5');
  expect(readState(join(root, '.agents')).sessions.acme?.seats.lead?.stage).toBe('ready');
});

test('an approved file that has since changed mounts under the matching project, and the scope is named', async () => {
  const { root, home } = repo();
  approve(home, root);
  const path = join(root, '.agents', 'team.yaml');
  writeFileSync(path, readFileSync(path, 'utf8').replace(
    'claude --model claude-opus-5-5',
    'claude --model claude-opus-5-5 --live-mount',
  ));
  const before = durableBytes(home);
  const made = world();
  const io = testIo(root, UNPLACED);
  io.env = { TEAMCLI_BYPASS: 'project:acme' };
  const code = await runUp([], io, sources(home, made.launch));
  expect(code).toBe(0);
  expect(io.err).toContain('team up: warning:');
  expect(io.err).toContain('the scoped bypass continues (TEAMCLI_BYPASS project "acme")');
  expect(io.err).not.toContain('not the approved one');
  expect(io.err).not.toContain('team approve');
  expect(made.runs.map((run) => run.command).join('\n')).toContain('--live-mount');
  expect(readState(join(root, '.agents')).sessions.acme?.seats.lead?.stage).toBe('ready');
  expect(durableBytes(home)).toBe(before);
  expect(durableBytes(home)).not.toContain('grant.json');
});

test('team down says the placement as a warning under the matching project, and refuses under another', async () => {
  const placement = 'only the owner, the orchestrator or the operator stops the team; this call is unplaced (it runs under herdr)';
  const stopped = repo();
  approve(stopped.home, stopped.root);
  const stoppedBefore = durableBytes(stopped.home);
  const didStop = { n: 0 };
  const stoppedIo = testIo(stopped.root, UNPLACED);
  stoppedIo.env = { TEAMCLI_BYPASS: 'project:acme' };
  const stoppedCode = await runDown([], stoppedIo, downSources(stopped.home, didStop));
  expect(stoppedCode).toBe(0);
  expect(stoppedIo.err).toContain('team down: warning:');
  expect(stoppedIo.err).toContain(placement);
  expect(stoppedIo.err).toContain('the scoped bypass continues (TEAMCLI_BYPASS project "acme")');
  expect(stoppedIo.err).not.toContain('team down: only the owner, the orchestrator or the operator stops the team');
  expect(didStop.n).toBe(1);
  expect(durableBytes(stopped.home)).toBe(stoppedBefore);

  const refused = repo();
  approve(refused.home, refused.root);
  const refusedBefore = durableBytes(refused.home);
  const refusedStopped = { n: 0 };
  const refusedIo = testIo(refused.root, UNPLACED);
  refusedIo.env = { TEAMCLI_BYPASS: 'project:other' };
  const refusedCode = await runDown([], refusedIo, downSources(refused.home, refusedStopped));
  expect(refusedCode).toBe(1);
  expect(refusedIo.err).toBe(`team down: ${placement}\n`);
  expect(refusedIo.err).not.toContain('the scoped bypass');
  expect(refusedStopped.n).toBe(0);
  expect(durableBytes(refused.home)).toBe(refusedBefore);

  const both = repo();
  approve(both.home, both.root);
  const bothStopped = { n: 0 };
  const bothIo = testIo(both.root, UNPLACED);
  bothIo.env = { TEAMCLI_DEV_MODE: '1', TEAMCLI_BYPASS: 'project:acme' };
  expect(await runDown([], bothIo, downSources(both.home, bothStopped))).toBe(0);
  expect(bothIo.err).not.toContain('the scoped bypass');
  expect(bothStopped.n).toBe(1);
});

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

test('a malformed value bypasses nothing on the real run', async () => {
  for (const value of ['1', 'project:', 'seat: ', 'nonsense', '', 'project: acme ']) {
    const { root, home } = repo();
    const made = world();
    const io = testIo(root, UNPLACED);
    io.env = { TEAMCLI_BYPASS: value };
    const code = await runUp([], io, sources(home, made.launch));
    expect(`${value}: ${code}`).toBe(`${value}: 1`);
    expect(io.err).toBe('deny\n');
    expect(made.runs).toEqual([]);
  }
});

test('the scope parser reads only the three forms, trimmed; the matcher names what it matched', () => {
  expect(bypassScopes({})).toEqual([]);
  expect(bypassScopes({ TEAMCLI_BYPASS: '1' })).toEqual([]);
  expect(bypassScopes({ TEAMCLI_BYPASS: 'project:' })).toEqual([]);
  expect(bypassScopes({ TEAMCLI_BYPASS: 'seat:' })).toEqual([]);
  expect(bypassScopes({ TEAMCLI_BYPASS: 'nonsense, project:, ,seat: ' })).toEqual([]);
  // The name is exact: `project: acme` names ` acme`, which no team file carries.
  expect(bypassScopes({ TEAMCLI_BYPASS: 'project: acme' })).toEqual([{ kind: 'project', project: ' acme' }]);
  expect(bypassScopes({ TEAMCLI_BYPASS: ' all , project:acme,seat:lead ' })).toEqual([
    { kind: 'all' },
    { kind: 'project', project: 'acme' },
    { kind: 'seat', seat: 'lead' },
  ]);
  expect(matchBypass(bypassScopes({ TEAMCLI_BYPASS: 'project:acme' }), { project: 'acme', seat: 'lead' })).toEqual({
    kind: 'project',
    label: 'TEAMCLI_BYPASS project "acme"',
  });
  expect(matchBypass(bypassScopes({ TEAMCLI_BYPASS: 'project:acme' }), {})).toBeNull();
  expect(matchBypass(bypassScopes({ TEAMCLI_BYPASS: 'seat:lead' }), { project: 'acme', seat: 'lead' })).toEqual({
    kind: 'seat',
    label: 'TEAMCLI_BYPASS seat "lead"',
  });
  expect(matchBypass(bypassScopes({ TEAMCLI_BYPASS: 'seat:lead' }), { project: 'acme', seat: 'other' })).toBeNull();
  expect(matchBypass(bypassScopes({ TEAMCLI_BYPASS: 'all' }), {})).toEqual({ kind: 'all', label: 'TEAMCLI_BYPASS' });
});
