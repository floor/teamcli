import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import * as child from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import type { UpSources } from '../src/commands/up.ts';
import type { HostedWatch } from '../src/daemon/watch.ts';

// Guards precede production imports. No process is launched or signalled by a scene.
const forbidden: string[] = [];
const kill = spyOn(process, 'kill').mockImplementation(((pid: number, signal: any) => {
  if (pid === process.pid && signal === 0) return true;
  forbidden.push('signal'); throw Error('independent scene refused a signal');
}) as typeof process.kill);
const realExec = child.execFileSync;
const exec = spyOn(child, 'execFileSync').mockImplementation(((command: any, args: any, options: any) => {
  if (command === 'git' && options?.cwd?.startsWith('/private/tmp/o3registry-')) return realExec(command, args, options);
  if (command === 'ps') return ''; // Synthetic unavailable ancestry; never run a process reader.
  forbidden.push(String(command)); throw Error('independent scene refused an external command');
}) as typeof child.execFileSync);
const spawn = spyOn(child, 'spawn').mockImplementation((() => {
  forbidden.push('spawn'); throw Error('independent scene refused an external launch');
}) as typeof child.spawn);
const { intoRegistry, underRegistry } = await import('./helpers/registry-team.ts');
const { routeOf } = await import('../src/daemon/routes.ts');
const { hostedWatchAuthority } = await import('../src/daemon/watch-authority.ts');
const { createHostedWatch } = await import('../src/daemon/watch.ts');
const { emptySession, readState, updateState } = await import('../src/state.ts');
const { runRestoreSweepForRoute } = await import('../src/launch/restore-sweep.ts');
const { readTeamConfig } = await import('../src/file/team-config.ts');
const { verifyWatchAuthority, WATCH_DIRECT_WORK } = await import('../src/watch/authority.ts');
const { mintWatchEpoch, WATCH_AUTHORITY_MAX_AGE_MS } = await import('../src/watch/epoch.ts');
const hosts: HostedWatch[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop('independent scene complete');
  expect(forbidden.splice(0)).toEqual([]);
});
afterAll(() => { kill.mockRestore(); exec.mockRestore(); spawn.mockRestore(); });
const session = 'independent-session';
const team = `format: 1
project: independent-registry
session: independent-session
operator: captain
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: captain
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: worker
    name: analyst
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;
function world(stale: boolean) {
  const folder = mkdtempSync('/private/tmp/o3registry-');
  const root = join(folder, 'checkout'), home = join(folder, 'home'), dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true }); mkdirSync(home);
  child.execFileSync('git', ['init', '-q'], { cwd: root });
  const file = join(dir, 'team.yaml'); writeFileSync(file, team);
  intoRegistry(root, home);
  if (stale) writeFileSync(file, team.replaceAll('independent-session', 'retired-session').replace('independent-registry', 'retired-team'));
  else if (existsSync(file)) unlinkSync(file);
  updateState(dir, state => { state.sessions[session] = emptySession(); });
  let clock = Date.parse('2026-11-02T08:00:00Z');
  const now = () => new Date(clock);
  let delayed = false, refusedWhileBlocked: boolean | undefined;
  let block = false;
  const sources: WatchSources = {
    home, now, pid: process.pid, alive: pid => pid === process.pid,
    live: () => {
      if (block && !delayed) {
        delayed = true; clock += WATCH_AUTHORITY_MAX_AGE_MS + 1;
        const epoch = readState(dir).sessions[session]!.watch!.epoch!;
        refusedWhileBlocked = !verifyWatchAuthority({ root, home, session, epoch, purpose: WATCH_DIRECT_WORK, now: now() }).ok;
      }
      return { running: true, agents: [], workspaces: [], screens: {} };
    },
    machine: () => ({ loadPerCore: 0.1, memoryFree: 75, diskFree: 100e9, swapTotal: 0, swapFree: 0, swapUsed: 0 }),
    standing: () => ({ kind: 'none' }), readChecks: () => [],
    screen: () => null, status: () => null, foreground: () => null, processes: () => null,
    typeText: () => { throw Error('pane write'); }, pressEnter: () => { throw Error('pane enter'); }, sendKey: () => { throw Error('pane key'); },
    notify: () => { throw Error('notification'); }, sleep: async () => {}, wait: async () => false,
  };
  return { root, home, dir, file, now, sources, advance: (ms: number) => { clock += ms; },
    block: () => { block = true; }, refusedWhileBlocked: () => refusedWhileBlocked };
}
async function settle() { for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0)); }
function start(w: ReturnType<typeof world>) {
  const route = routeOf(w.root, 'independent-registry', session, ['captain', 'analyst']);
  const logs: string[] = [];
  const build = hostedWatchAuthority({ route, teamFile: w.file, base: w.sources, now: w.now,
    alive: pid => pid === process.pid, log: text => logs.push(text) });
  const host = createHostedWatch({ route, ...build, onTick: build.tick, now: w.now }); hosts.push(host);
  return { host, logs };
}
for (const stale of [false, true]) {
  test(`registry ${stale ? 'with stale file' : 'without file'} supplies the restore route`, () => underRegistry(async () => {
    const w = world(stale), reads: string[] = [];
    const loaded = readTeamConfig(w.root, { home: w.home });
    expect(loaded.ok && loaded.team.session).toBe(session);
    // A recorded seat makes this a restore candidate. The fake host is absent, so no launch follows.
    updateState(w.dir, state => { state.sessions[session]!.seats.analyst = { pane: 'fixture-pane', stage: 'launched' }; });
    const result = await runRestoreSweepForRoute({ root: w.root, home: w.home,
      sources: { home: w.home, sessionState: (value: string) => { reads.push(value); return 'absent'; } } as UpSources });
    expect(result).toEqual({ kind: 'not-running', state: 'absent' }); expect(reads).toEqual([session]);
  }));
  test(`registry ${stale ? 'with stale file' : 'without file'} keeps cycling after a long blocked pass`, () => underRegistry(async () => {
    const w = world(stale); w.block(); const { host } = start(w);
    const before = readState(w.dir).sessions[session]!.watch!;
    await settle();
    expect(w.refusedWhileBlocked()).toBe(true);
    host.tick(w.now()); await settle();
    const renewed = readState(w.dir).sessions[session]?.watch;
    expect(renewed?.epoch).toBe(before.epoch); expect(renewed?.heartbeat).toBe(w.now().toISOString());
    expect(host.state().cycles).toBeGreaterThanOrEqual(1);
    const cycles = host.state().cycles;
    w.advance(600000); host.tick(w.now()); await settle();
    expect(host.state().cycles).toBeGreaterThan(cycles); expect(host.state().failures).toBe(0);
    expect(host.state().effects).toBe('blocked');
  }));
}
test('a successor epoch closes the old hosted watch and survives its cleanup', () => underRegistry(async () => {
  const w = world(false), { host } = start(w); await settle();
  expect(host.state().cycles).toBe(1);
  const previous = readState(w.dir).sessions[session]!.watch!;
  const next = mintWatchEpoch();
  updateState(w.dir, state => { state.sessions[session]!.watch = { ...previous, epoch: next, heartbeat: w.now().toISOString() }; });
  host.tick(w.now()); await settle();
  expect(host.state().phase).toBe('stopped'); expect(host.state().effects).toBe('blocked');
  expect(readState(w.dir).sessions[session]?.watch?.epoch).toBe(next);
  expect(verifyWatchAuthority({ root: w.root, home: w.home, session, epoch: previous.epoch!, purpose: WATCH_DIRECT_WORK, now: w.now() }).ok).toBe(false);
}));
test('the effect proof keeps its exact fifteen-second freshness boundary', () => underRegistry(async () => {
  const w = world(false), { host } = start(w); await settle();
  const epoch = readState(w.dir).sessions[session]!.watch!.epoch!;
  const proof = () => verifyWatchAuthority({ root: w.root, home: w.home, session, epoch, purpose: WATCH_DIRECT_WORK, now: w.now() });
  expect(WATCH_AUTHORITY_MAX_AGE_MS).toBe(15000); w.advance(15000); expect(proof().ok).toBe(true);
  w.advance(1); expect(proof().ok).toBe(false);
  host.tick(w.now()); expect(proof().ok).toBe(true);
}));
