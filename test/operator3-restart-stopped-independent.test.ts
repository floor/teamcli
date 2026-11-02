import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import * as child from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Caller } from '../src/caller.ts';
import type { RestartSources } from '../src/commands/restart.ts';
import type { Launch, UpSources } from '../src/commands/up.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Io } from '../src/io.ts';
const fixturePrefix = join(realpathSync(tmpdir()), 'o3restart-');
const forbidden: string[] = [];
const kill = spyOn(process, 'kill').mockImplementation(((pid: number, signal: any) => {
  if (pid === process.pid && signal === 0) return true;
  forbidden.push('signal'); throw Error('independent fixture refused a signal');
}) as typeof process.kill);
const realExec = child.execFileSync;
const exec = spyOn(child, 'execFileSync').mockImplementation(((command: any, args: any, options: any) => {
  if (command === 'git' && options?.cwd?.startsWith(fixturePrefix)) return realExec(command, args, options);
  if (command === 'ps') return ''; // Synthetic unavailable ancestry; never read another process.
  forbidden.push(String(command)); throw Error('independent fixture refused an external command');
}) as typeof child.execFileSync);
const spawn = spyOn(child, 'spawn').mockImplementation((() => { forbidden.push('spawn'); throw Error('no external launches'); }) as typeof child.spawn);
const spawnSync = spyOn(child, 'spawnSync').mockImplementation((() => { forbidden.push('spawnSync'); throw Error('no external editors'); }) as typeof child.spawnSync);
afterEach(() => { expect(forbidden.splice(0)).toEqual([]); });
afterAll(() => { kill.mockRestore(); exec.mockRestore(); spawn.mockRestore(); spawnSync.mockRestore(); });
const { setHerdrRun } = await import('../src/herdr.ts');
setHerdrRun(args => {
  if (args.join(' ') !== 'pane process-info --pane pane-new') forbidden.push('unexpected terminal-host call');
  throw Error('synthetic pane has no process identity');
});
afterAll(() => { setHerdrRun(null); });
const { runRestart } = await import('../src/commands/restart.ts');
const { runUp } = await import('../src/commands/up.ts');
const { runConfig } = await import('../src/commands/config.ts');
const { emptySession, LOG_FILE, readState, updateState } = await import('../src/state.ts');
const { intoRegistry, underRegistry } = await import('./helpers/registry-team.ts');
const { readTeamConfig } = await import('../src/file/team-config.ts');
const { readTeamText } = await import('../src/file/team-text.ts');
const { CLAUDE_IDLE } = await import('./helpers.ts');
const now = () => new Date('2026-11-02T09:00:00Z');
const session = 'revival-independent';
const lead: Caller = { kind: 'seat', name: 'captain', pane: 'pane-captain', session };
const worker: Caller = { kind: 'seat', name: 'observer', pane: 'pane-observer', session };
const foreign: Caller = { kind: 'seat', name: 'captain', pane: 'pane-foreign', session: 'foreign-team' };
function world(dev = false, pausedExtra = '') {
  const base = realpathSync(mkdtempSync(fixturePrefix)), home = join(base, 'home'), root = join(base, 'checkout'), dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true }); mkdirSync(home);
  child.execFileSync('git', ['init', '-q'], { cwd: root });
  const file = join(dir, 'team.yaml');
  const seat = (name: string, role: string, extra = '') => `  - role: ${role}\n    name: ${name}\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n${extra}`;
  writeFileSync(file, `format: 1\nproject: revival-independent\nsession: ${session}\noperator: captain\ntrust:\n  - ${join(home, ".config/team/lobby")}\n  - ${root}\nworkspace:\n  mode: shared\nseats:\n` + seat('captain', 'orchestrator', '    leads: true\n') + seat('observer', 'worker') + seat('paused', 'worker', '    stopped: true\n' + pausedExtra));
  intoRegistry(root, home); unlinkSync(file);
  updateState(dir, state => {
    const current = state.sessions[session] = emptySession();
    current.seats.captain = { stage: 'ready', pane: 'pane-captain' };
    current.seats.observer = { stage: 'ready', pane: 'pane-observer' };
  });
  const stopped = () => { const got = readTeamConfig(root, { home }); if (!got.ok) throw Error('fixture team unreadable'); return got.team.seats.find(s => s.name === 'paused')!.stopped === true; };
  const text = () => readTeamText(file, { home });
  const io = (caller: Caller) => {
    let out = '', err = '';
    const value: Io = { cwd: root, caller, env: { HOME: home, TEAM_CONFIG_SOURCE: 'registry', TEAMCLI_DEV_MODE: dev ? '1' : '0' },
      stdinIsTTY: false, stdoutIsTTY: false, stdout: t => { out += t; }, stderr: t => { err += t; } };
    return { value, output: () => out + err };
  };
  return { base, home, root, dir, file, stopped, text, io };
}
function harness(w: ReturnType<typeof world>, failure: 'none' | 'create' | 'run' = 'none') {
  const agents: HerdrAgent[] = [
    { name: 'captain', pane: 'pane-captain', workspace: 'ws-captain', agent: 'claude-code', status: 'idle', cwd: w.root },
    { name: 'observer', pane: 'pane-observer', workspace: 'ws-observer', agent: 'claude-code', status: 'idle', cwd: w.root },
  ];
  const launched: string[] = [], markAtLaunch: boolean[] = [];
  let created = 0;
  const launch: Launch = {
    sessionState: () => 'running', startServer: () => true, sessionUp: () => true,
    createWorkspace: () => { created++; markAtLaunch.push(w.stopped()); return failure === 'create' ? null : { pane: 'pane-new', workspace: 'ws-new' }; },
    paneRun: (_session, pane, command) => {
      launched.push(command); if (failure === 'run') return false;
      agents.push({ name: null, pane, workspace: 'ws-new', agent: 'claude-code', status: 'idle', cwd: w.root }); return true;
    },
    renameAgent: (_session, pane, name) => { const item = agents.find(a => a.pane === pane); if (item) item.name = name; return true; },
    closeWorkspace: () => true, agentPanes: () => agents.map(a => a.pane), agents: () => agents,
    paneText: () => CLAUDE_IDLE, agentStatus: () => 'idle', foreground: () => ['claude'], shellBack: () => false,
    typeText: () => { throw Error('unexpected fake pane text'); }, pressEnter: () => { throw Error('unexpected fake pane enter'); },
    sleep: async () => {}, now,
  };
  const doctor = { home: w.home, version: () => '2.1.288', onPath: () => true, loggedIn: () => true,
    herdrVersion: () => '0.7.1', sessionRunning: () => true, now };
  const sources: RestartSources = {
    home: w.home, now, sessionRunning: () => true, sessionState: () => 'running',
    agents: () => agents, workspaces: () => agents.map(a => ({ id: a.workspace })), alive: () => true,
    screen: () => ({ kind: 'idle' }), screenText: () => CLAUDE_IDLE, status: () => 'idle', foreground: () => ['claude'],
    sleep: async () => {}, doctor, upLaunch: launch, standing: () => ({ kind: 'none' }),
    machine: () => ({ loadPerCore: 0.1, memoryFree: 80, diskFree: 100e9, swapTotal: 0, swapFree: 0, swapUsed: 0 }),
    launch: { sendKey: () => { throw Error('unexpected fake stop key'); }, typeText: () => { throw Error('unexpected stop text'); }, pressEnter: () => false,
      agentPanes: () => agents.map(a => a.pane), closeWorkspace: () => true, stopSession: () => true, deleteSession: () => true,
      kill: () => { throw Error('unexpected fake kill'); }, sleep: async () => {}, now },
  };
  return { sources, launch, doctor, launched, markAtLaunch, created: () => created };
}
for (const dev of [false, true]) {
  test(`own lead clears exactly the stopped key without a card; dev mode ${dev}`, () => underRegistry(async () => {
    const w = world(dev), io = w.io(lead), before = w.text();
    expect(await runConfig(['unset', 'seats.paused.stopped'], io.value, { home: w.home, now, env: io.value.env, present: false })).toBe(0);
    expect(w.stopped()).toBe(false); expect(w.text()).toBe(before.replace('    stopped: true\n', ''));
  }));
  test(`own lead revives through restart; dev mode ${dev}`, () => underRegistry(async () => {
    const w = world(dev), h = harness(w), io = w.io(lead);
    const exit = await runRestart(['paused'], io.value, h.sources);
    expect({ exit, output: exit ? io.output() : '' }).toEqual({ exit: 0, output: '' });
    expect(w.stopped()).toBe(false); expect(h.created()).toBe(1); expect(h.launched.length).toBe(1);
    expect(h.markAtLaunch).toEqual([false]); expect(readState(w.dir).sessions[session]?.seats.paused?.stage).toBe('ready');
  }));
  for (const [label, caller] of [['worker', worker], ['foreign lead', foreign]] as const) {
    test(`${label} cannot clear or restart a stopped seat; dev mode ${dev}`, () => underRegistry(async () => {
      const w = world(dev), before = w.text(), h = harness(w), io = w.io(caller);
      expect(await runConfig(['unset', 'seats.paused.stopped'], io.value, { home: w.home, now, env: io.value.env, present: false })).not.toBe(0);
      expect(await runRestart(['paused'], io.value, h.sources)).not.toBe(0);
      expect(w.text()).toBe(before); expect(h.created()).toBe(0); expect(h.launched).toEqual([]);
    }));
  }
}
const ordinaryLeadEdits = [
  ['set', 'seats.paused.stopped', 'false'],
  ['unset', 'seats.paused'],
  ['unset', 'seats.paused.leads'],
];
for (const args of ordinaryLeadEdits) for (const dev of [false, true]) {
  test(`ordinary config ${args.join(' ')} ${dev ? 'uses the established dev-mode lift' : 'requires the owner'}`, () => underRegistry(async () => {
    const w = world(dev, args[1] === 'seats.paused.leads' ? '    leads: false\n' : ''), before = w.text(), io = w.io(lead);
    const exit = await runConfig(args, io.value, { home: w.home, now, env: io.value.env, present: false });
    if (dev) {
      expect(exit).toBe(0);
      expect(io.output()).toContain('warning:'); expect(io.output()).toContain('dev mode continues');
      const audit = readFileSync(join(w.dir, LOG_FILE), 'utf8');
      expect(audit).toContain('config'); expect(audit).toContain('captain'); expect(audit).toContain('dev mode');
    } else {
      expect(exit).not.toBe(0); expect(w.text()).toBe(before);
      expect(io.output()).not.toContain('dev mode continues');
    }
  }));
}
for (const args of [['unset', 'seats.paused.launch'], ['unset', 'seats.missing.stopped']]) {
  test(`dev mode preserves schema or target refusal for ${args.join(' ')}`, () => underRegistry(async () => {
    const w = world(true), before = w.text(), io = w.io(lead);
    expect(await runConfig(args, io.value, { home: w.home, now, env: io.value.env, present: false })).not.toBe(0);
    expect(w.text()).toBe(before);
  }));
}
test('up keeps the stopped seat outside its launch plan', () => underRegistry(async () => {
  const w = world(), h = harness(w), io = w.io({ kind: 'owner' });
  const sources: UpSources = { home: w.home, sessionRunning: () => true, sessionState: () => 'running', agents: h.sources.agents,
    doctor: h.doctor, machine: h.sources.machine, now, standing: () => ({ kind: 'none' }), launch: h.launch };
  const exit = await runUp(['--dry-run', '--json'], io.value, sources);
  expect(exit).toBe(0); expect(w.stopped()).toBe(true); expect(h.created()).toBe(0);
  const document = JSON.parse(io.output());
  expect(document.plan.some((step: { step: string; detail: string }) => step.step === 'skip' && step.detail.startsWith('paused: stopped'))).toBe(true);
  expect(document.plan.filter((step: { seat?: string; step: string }) => step.seat === 'paused' && step.step !== 'skip')).toEqual([]);
}));
for (const failure of ['create', 'run'] as const) {
  test(`a failed ${failure} launch retains the stopped mark`, () => underRegistry(async () => {
    const w = world(), h = harness(w, failure), io = w.io(lead);
    expect(await runRestart(['paused'], io.value, h.sources)).not.toBe(0);
    expect(h.created()).toBe(1); expect(h.launched.length).toBe(failure === 'run' ? 1 : 0);
    expect(w.stopped()).toBe(true); expect(readState(w.dir).sessions[session]?.seats.paused?.stage).not.toBe('ready');
  }));
}
test('the owner can revive without a card', () => underRegistry(async () => {
  const w = world(), h = harness(w), io = w.io({ kind: 'owner' });
  expect(await runRestart(['paused'], io.value, h.sources)).toBe(0); expect(w.stopped()).toBe(false);
}));
