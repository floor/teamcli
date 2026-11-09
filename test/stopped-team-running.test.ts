// A stopped registry row becomes running only when this daemon's route is that row's own
// folder and the terminal host reports that row's session running. The write re-reads under
// the teams lock. Synthetic homes and folders only.
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realHerdr from '../src/herdr.ts';
import { daemonLogPath } from '../src/daemon/paths.ts';
import {
  getTeam,
  noteStoppedTeamRunning,
  noteTeam,
  setTeamLifecycle,
  teamIdOf,
  teamsFile,
  upsertTeam,
  type TeamLifecycle,
} from '../src/registry/teams.ts';

let sessionProbe: (name: string) => boolean | Promise<boolean> = () => false;

mock.module('../src/herdr.ts', () => ({
  ...realHerdr,
  sessionRunningAsync: (name: string) => Promise.resolve(sessionProbe(name)),
}));

const { startMachineDaemon } = await import('../src/daemon/host.ts');

const TEAM_YAML = `format: 1
project: fixture-crate
session: fixture-session
coordinator: pane-lead
operator: pane-operator
workspace:
  mode: shared
seats:
  - role: coordinator
    name: pane-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: pane-operator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

const trees: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  sessionProbe = () => false;
  for (const close of closers.splice(0)) await close();
  for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
});

function scratch(): { base: string; home: string; root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stopped-team-running-')));
  trees.push(base);
  const home = join(base, 'home');
  const root = join(base, 'repo');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
  return { base, home, root: realpathSync(root) };
}

function stoppedRow(home: string, root: string, session = 'fixture-session'): string {
  const said = noteTeam(
    home,
    root,
    { project: 'fixture-crate', entity: null, session, lobby: null },
    'stopped',
    'fixture',
  );
  if (said !== null) throw new Error(said);
  return teamIdOf(root);
}

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function logText(home: string): string {
  return existsSync(daemonLogPath(home)) ? readFileSync(daemonLogPath(home), 'utf8') : '';
}

async function hostStopped(home: string, root: string, calls: { n: number }): Promise<void> {
  const started = await startMachineDaemon({
    home,
    roots: [root],
    version: 'stopped-team-running',
    startedBy: 'test',
    heartbeatMs: 60_000,
    restoreRetryBudgetMs: 0,
    sendStart: async () => ({ kind: 'bind-failed', reason: 'synthetic send' }),
    initialBusStart: async () => ({ kind: 'locked' }),
    restoreSweep: async () => {
      calls.n += 1;
      return { kind: 'no-recorded-session' };
    },
  });
  expect(started.kind).toBe('serving');
  if (started.kind !== 'serving') return;
  const daemon = started.daemon;
  closers.push(() => daemon.close().then(() => undefined, () => undefined));
}

describe('a stopped team the daemon is hosting', () => {
  test('a stopped row whose session is running becomes running, with one log line', async () => {
    const { home, root } = scratch();
    const id = stoppedRow(home, root);
    sessionProbe = (name) => name === 'fixture-session';
    const calls = { n: 0 };
    await hostStopped(home, root, calls);
    await until(() => getTeam(home, id)?.lifecycle === 'running' && calls.n === 1);
    expect(getTeam(home, id)?.lifecycle).toBe('running');
    expect(calls.n).toBe(1);
    const lines = logText(home).split('\n').filter((line) => line.includes('stopped to running'));
    expect(lines).toEqual([expect.stringContaining(`registry ${root}: ${id} stopped to running`)]);
    expect(logText(home)).not.toContain('automatic restore is disabled');
  });

  test('a stopped row whose session is not running is left stopped and restore stays refused', async () => {
    const { home, root } = scratch();
    const id = stoppedRow(home, root);
    const before = readFileSync(teamsFile(home), 'utf8');
    sessionProbe = () => false;
    const calls = { n: 0 };
    await hostStopped(home, root, calls);
    await until(() => logText(home).includes('automatic restore is disabled'));
    expect(calls.n).toBe(0);
    expect(getTeam(home, id)?.lifecycle).toBe('stopped');
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
    expect(logText(home)).not.toContain('stopped to running');
    expect(logText(home)).toContain(`restore ${root}: the registry team is stopped; automatic restore is disabled`);
  });

  test('a stopped row whose stored root is another folder is left unchanged', async () => {
    const { base, home, root } = scratch();
    const id = stoppedRow(home, root);
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    upsertTeam(home, id, { root: realpathSync(elsewhere) });
    const before = readFileSync(teamsFile(home), 'utf8');
    sessionProbe = () => true;
    const calls = { n: 0 };
    await hostStopped(home, root, calls);
    await until(() => calls.n > 0 || logText(home).includes('stopped to running'));
    expect(noteStoppedTeamRunning(home, id, root, 'fixture-session')).toBe(false);
    expect(getTeam(home, id)?.lifecycle).toBe('stopped');
    expect(getTeam(home, id)?.root).toBe(realpathSync(elsewhere));
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
    expect(logText(home)).not.toContain('stopped to running');
  });

  test('an absent row is not created', () => {
    const { home, root } = scratch();
    expect(noteStoppedTeamRunning(home, teamIdOf(root), root, 'fixture-session')).toBe(false);
    expect(existsSync(teamsFile(home))).toBe(false);
    const id = stoppedRow(home, root);
    const before = readFileSync(teamsFile(home), 'utf8');
    expect(noteStoppedTeamRunning(home, 'ffffffffffff', root, 'fixture-session')).toBe(false);
    expect(getTeam(home, 'ffffffffffff')).toBeNull();
    expect(getTeam(home, id)?.lifecycle).toBe('stopped');
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
  });

  test('a defined, running, or archived row is left as it is', () => {
    const { home, root } = scratch();
    const id = stoppedRow(home, root);
    const states: readonly TeamLifecycle[] = ['defined', 'running', 'archived'];
    for (const state of states) {
      setTeamLifecycle(home, id, state);
      const before = readFileSync(teamsFile(home), 'utf8');
      expect(noteStoppedTeamRunning(home, id, root, 'fixture-session')).toBe(false);
      expect(getTeam(home, id)?.lifecycle).toBe(state);
      expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
    }
  });

  test('a session change between the proof and the lock is not promoted', async () => {
    const { home, root } = scratch();
    const id = stoppedRow(home, root);
    sessionProbe = (name) => {
      expect(name).toBe('fixture-session');
      upsertTeam(home, id, { session: 'other-session' });
      return true;
    };
    const calls = { n: 0 };
    await hostStopped(home, root, calls);
    await until(() => logText(home).includes('automatic restore is disabled'));
    expect(calls.n).toBe(0);
    expect(getTeam(home, id)?.lifecycle).toBe('stopped');
    expect(getTeam(home, id)?.session).toBe('other-session');
    expect(logText(home)).not.toContain('stopped to running');
  });

  test('a row id that is not the canonical root id is refused by the helper', () => {
    const { home, root } = scratch();
    const canonical = teamIdOf(root);
    const forged = canonical === '000000000000' ? '111111111111' : '000000000000';
    upsertTeam(home, forged, {
      project: 'fixture-crate',
      session: 'fixture-session',
      root,
      lifecycle: 'stopped',
    });
    const before = readFileSync(teamsFile(home), 'utf8');
    expect(noteStoppedTeamRunning(home, forged, root, 'fixture-session')).toBe(false);
    expect(getTeam(home, forged)?.lifecycle).toBe('stopped');
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
  });

  test('a lifecycle change during the session proof wins over the stopped reading', async () => {
    const { home, root } = scratch();
    const id = stoppedRow(home, root);
    sessionProbe = () => {
      setTeamLifecycle(home, id, 'defined');
      return true;
    };
    const calls = { n: 0 };
    await hostStopped(home, root, calls);
    await until(() => logText(home).includes('automatic restore is disabled'));
    expect(calls.n).toBe(0);
    expect(getTeam(home, id)?.lifecycle).toBe('defined');
    expect(logText(home)).not.toContain('stopped to running');
    expect(logText(home)).toContain('automatic restore is disabled');
  });
});
