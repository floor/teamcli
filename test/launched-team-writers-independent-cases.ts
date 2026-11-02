// A stale launch pointer remains on disk while the registry changes under it.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runDown } from '../src/commands/down.ts';
import { runRemove } from '../src/commands/remove.ts';
import { runRename } from '../src/commands/rename.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { runWorktree } from '../src/commands/worktree.ts';
import { noteLaunchedPane, launchedTeamFile } from '../src/file/launched-file.ts';
import { markStopped } from '../src/file/lines.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { writeTeamText } from '../src/file/team-text.ts';
import { teamConfigRecordPath } from '../src/registry/team-config-store.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState, STATE_FILE } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';
import { intoRegistry, storedTeam, underRegistry } from './helpers/registry-team.ts';
import { assertIndependentHome, releaseIndependentFixture } from './launched-team-writers-home-fixture.ts';

const NOW = new Date('2026-11-01T20:00:00.000Z');
const created: string[] = [];
function folder(path: string) { const mask = process.umask(0); try { mkdirSync(path, { recursive: true, mode: 0o700 }); } finally { process.umask(mask); } }
afterEach(() => { for (const path of created.splice(0)) releaseIndependentFixture(path); });
test('all product imports follow creation of the suite child HOME', assertIndependentHome);
function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'launched-writers-'))); created.push(base);
  const home = join(base, 'home'), root = join(base, 'project'), dir = join(root, '.agents'), file = join(dir, 'team.yaml'), lobby = join(home, '.config/team/lobby');
  folder(dir); folder(lobby); folder(join(process.env.HOME!, '.config/team/lobby'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  const yaml = `format: 1\nproject: launched-fixture\noperator: captain\nsession: launch-session\nworkspace:\n  mode: shared\ntrust:\n  - ${root}\n  - ${lobby}\n  - ${join(process.env.HOME!, '.config/team/lobby')}\nseats:\n` + ['captain', 'worker'].map(name => `  - name: ${name}\n    role: ${name === 'captain' ? 'orchestrator' : 'implementer'}\n${name === 'captain' ? '    leads: true\n' : ''}    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n`).join('');
  writeFileSync(file, yaml);
  const loaded = readTeamConfig(root, { file, home }); if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(storePath(loaded.team.project, root, home), { approval: approvalOf(loaded.team, root, NOW), file: yaml }, loaded.team.seats, home);
  intoRegistry(root, home);
  updateState(dir, state => { const session = state.sessions['launch-session'] ??= emptySession(); session.launched_file = file; session.seats.captain = { stage: 'ready', pane: 'caller-pane', workspace: 'caller-workspace' }; });
  noteLaunchedPane(home, file, 'caller-pane', 'launch-session');
  return { base, home, root, dir, file, lobby, yaml, record: teamConfigRecordPath(home, teamIdOf(root)) };
}
type World = ReturnType<typeof world>;
function seatIo(w: World) { return testIo(w.lobby, { kind: 'seat', name: 'captain', pane: 'caller-pane', session: 'launch-session' }); }
function fake(w: World) {
  const effects: string[] = []; let clock = NOW.getTime();
  const forbidden = (name: string) => (..._args: unknown[]): never => { effects.push(name); throw new Error(`unexpected synthetic host effect: ${name}`); };
  const agents = () => [{ name: 'captain', agent: 'claude-code', pane: 'caller-pane', workspace: 'caller-workspace', status: 'idle', cwd: w.lobby }];
  const now = () => new Date(clock), sleep = async (ms: number) => { clock += ms; };
  const up: Launch = { sessionState: () => 'running', startServer: forbidden('server'), sessionUp: () => true, createWorkspace: forbidden('create'), paneRun: forbidden('launch'), renameAgent: forbidden('rename'), closeWorkspace: forbidden('close'), agentPanes: () => ['caller-pane'], agents, paneText: () => CLAUDE_IDLE, foreground: () => ['claude'], now, sleep };
  const machine = () => ({ loadPerCore: 0.1, memoryFree: 80, diskFree: 1024 ** 4, swapTotal: 1024 ** 3, swapFree: 1024 ** 3, swapUsed: 0, pressure: 'normal' as const });
  const doctor = { machine, home: w.home, version: () => '2.1.302', onPath: () => true, loggedIn: () => true, herdrVersion: () => '0.7.1', sessionRunning: () => true, now };
  const sources: RestartSources = { home: w.home, sessionRunning: () => true, sessionState: () => 'running', agents, workspaces: () => [{ id: 'caller-workspace' }], alive: () => false, screen: () => ({ kind: 'idle' }), screenText: () => CLAUDE_IDLE, status: () => 'idle', foreground: () => ['claude'], foregroundCwd: () => w.lobby, now, sleep, upLaunch: up, doctor, machine,
    launch: { typeText: forbidden('type'), pressEnter: forbidden('enter'), sendKey: forbidden('key'), agentPanes: () => ['caller-pane'], closeWorkspace: forbidden('close'), stopSession: forbidden('stop'), deleteSession: forbidden('delete-session'), kill: forbidden('signal'), now, sleep } };
  const add: AddSources = { home: w.home, sessionState: () => 'running', agents, workspaces: sources.workspaces, doctor, machine, now, launch: up };
  return { effects, sources, add, now, forbidden };
}
function stopInRegistry(w: World): void {
  const current = storedTeam(w.root, w.home); if (!current) throw new Error('missing synthetic record');
  expect(writeTeamText(w.file, markStopped(current.text, 'worker'), { home: w.home, command: 'remove' })).toEqual({ ok: true, target: 'registry' });
  expect(readFileSync(w.file, 'utf8')).toBe(w.yaml);
}
for (const json of [false, true]) test(`a launched-pane restart sees the registry-only stop (${json ? 'JSON' : 'plain'})`, async () => underRegistry(async () => {
  const w = world(), f = fake(w); stopInRegistry(w); const io = seatIo(w);
  expect(launchedTeamFile(io, w.home)).toBe(w.file);
  const code = await runRestart(['worker', '--dry-run', ...(json ? ['--json'] : [])], io, f.sources);
  expect(code, io.out + io.err).toBe(1);
  if (json) expect(JSON.parse(io.out).error.id).toBe('restart.signed-off');
  else expect(io.err).toContain('worker is signed off');
  expect(f.effects).toEqual([]); expect(readFileSync(w.file, 'utf8')).toBe(w.yaml);
}));

test('actual remove --keep writes the record, and a subsequent pane restart refuses the stopped seat', async () => underRegistry(async () => {
  const w = world(), f = fake(w), remove = seatIo(w);
  expect(await runRemove(['worker', '--keep'], remove, f.sources), remove.out + remove.err).toBe(0);
  expect(storedTeam(w.root, w.home)?.text).toContain('stopped: true'); expect(readFileSync(w.file, 'utf8')).toBe(w.yaml);
  const io = seatIo(w); expect(await runRestart(['worker', '--dry-run', '--json'], io, f.sources), io.out + io.err).toBe(1);
  expect(JSON.parse(io.out).error.id).toBe('restart.signed-off'); expect(f.effects).toEqual([]);
}));

for (const snapshot of [false, true]) test(`explicit --file retains its ${snapshot ? 'snapshot' : 'conventional'} file over a stopped registry`, async () => underRegistry(async () => {
  const w = world(), f = fake(w);
  stopInRegistry(w);
  const named = snapshot ? join(w.dir, 'explicit.yaml') : w.file; if (snapshot) writeFileSync(named, w.yaml);
  const before = readFileSync(w.record), io = testIo(w.root, { kind: 'owner' });
  const code = await runRestart(['worker', '--dry-run', '--file', named], io, f.sources);
  expect(code, io.out + io.err).toBe(0); expect(io.out).toContain('worker'); expect(io.out).not.toContain('signed off');
  expect(readFileSync(w.record)).toEqual(before); expect(readFileSync(w.file, 'utf8')).toBe(w.yaml); expect(f.effects).toEqual([]);
}));

test('an alternate launched snapshot is still that file, independent of the checkout registry', async () => underRegistry(async () => {
  const w = world(), f = fake(w), alternate = join(w.dir, 'snapshot.yaml'); writeFileSync(alternate, markStopped(w.yaml, 'worker'));
  updateState(w.dir, state => { state.sessions['launch-session']!.launched_file = alternate; }); noteLaunchedPane(w.home, alternate, 'caller-pane', 'launch-session');
  const io = seatIo(w); expect(launchedTeamFile(io, w.home)).toBe(alternate);
  expect(await runRestart(['worker', '--dry-run'], io, f.sources), io.out + io.err).toBe(1); expect(io.err).toContain('signed off'); expect(f.effects).toEqual([]);
}));

test('the file source setting keeps the launch pointer on its existing file', async () => underRegistry(async () => {
  const w = world(), f = fake(w); stopInRegistry(w); const previous = process.env.TEAM_CONFIG_SOURCE;
  process.env.TEAM_CONFIG_SOURCE = 'file';
  try { const io = seatIo(w); expect(await runRestart(['worker', '--dry-run'], io, f.sources), io.err + io.out).toBe(0); expect(io.out).not.toContain('signed off'); expect(f.effects).toEqual([]); }
  finally { if (previous === undefined) delete process.env.TEAM_CONFIG_SOURCE; else process.env.TEAM_CONFIG_SOURCE = previous; }
}));

for (const command of ['restart', 'add', 'remove', 'rename', 'down', 'worktree'] as const) test(`${command}: an unreadable registry is refused before host effects or stale-file fallback`, async () => underRegistry(async () => {
  const w = world(), f = fake(w); writeFileSync(w.record, '{invalid record\n'); const before = readFileSync(w.record), state = readFileSync(join(w.dir, STATE_FILE)), io = seatIo(w);
  expect(launchedTeamFile(io, w.home)).toBe(w.file);
  let code: number;
  switch (command) {
    case 'restart': code = await runRestart(['worker', '--dry-run'], io, f.sources); break;
    case 'add': code = await runAdd(['extra', '--like', 'worker', '--dry-run'], io, f.add); break;
    case 'remove': code = await runRemove(['worker', '--keep'], io, f.sources); break;
    case 'rename': code = await runRename(['worker', 'renamed-worker'], io, { home: w.home, now: f.now, renameAgent: f.forbidden('rename') }); break;
    case 'down': code = await runDown(['--dry-run'], io, f.sources); break;
    case 'worktree': code = await runWorktree(['list'], io, { home: w.home, now: f.now, setup: f.forbidden('setup') }); break;
  }
  expect(code).not.toBe(0); expect(io.out + io.err).toContain("registry's record"); expect(io.out + io.err).toContain('cannot be read');
  expect(f.effects).toEqual([]); expect(readFileSync(w.record)).toEqual(before); expect(readFileSync(w.file, 'utf8')).toBe(w.yaml); expect(readFileSync(join(w.dir, STATE_FILE))).toEqual(state);
}));
