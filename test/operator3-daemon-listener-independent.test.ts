import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import * as child from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import type { MachineDaemon } from '../src/daemon/host.ts';
import type { DaemonHost } from '../src/send/daemon.ts';
const forbidden: string[] = [];
const kill = spyOn(process, 'kill').mockImplementation(((pid: number, signal: any) => {
  if (pid === process.pid && signal === 0) return true;
  forbidden.push('signal'); throw Error('independent listener scene refused a signal');
}) as typeof process.kill);
const realExec = child.execFileSync;
const exec = spyOn(child, 'execFileSync').mockImplementation(((command: any, args: any, options: any) => {
  if (command === 'git' && options?.cwd?.startsWith('/private/tmp/o3listen-')) return realExec(command, args, options);
  if (command === 'ps') return ''; // No real process inspection in these scenes.
  forbidden.push(String(command)); throw Error('no external command in listener scene');
}) as typeof child.execFileSync);
const spawn = spyOn(child, 'spawn').mockImplementation((() => { forbidden.push('spawn'); throw Error('no external launch'); }) as typeof child.spawn);
const spawnSync = spyOn(child, 'spawnSync').mockImplementation((() => { forbidden.push('spawnSync'); throw Error('no external launch'); }) as typeof child.spawnSync);
const { startMachineDaemon } = await import('../src/daemon/host.ts');
const { probeDaemonHealth } = await import('../src/daemon/health.ts');
const { hostedWatchAuthority } = await import('../src/daemon/watch-authority.ts');
const { emptySession, readState, updateState } = await import('../src/state.ts');
const { mintWatchEpoch, WATCH_AUTHORITY_MAX_AGE_MS } = await import('../src/watch/epoch.ts');
const { WATCH_DIRECT_WORK, verifyWatchAuthority } = await import('../src/watch/authority.ts');
const { setHerdrRun } = await import('../src/herdr.ts');
const { intoRegistry, underRegistry } = await import('./helpers/registry-team.ts');
setHerdrRun(() => { forbidden.push('terminal-host'); throw Error('no real terminal-host call'); });
const active: MachineDaemon[] = [];
afterEach(async () => { for (const daemon of active.splice(0)) await daemon.close(); expect(forbidden.splice(0)).toEqual([]); });
afterAll(() => { setHerdrRun(null); kill.mockRestore(); exec.mockRestore(); spawn.mockRestore(); spawnSync.mockRestore(); });
const session = 'listener-independent';
async function until(check: () => boolean, timeout = 2500) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw Error('synthetic listener did not reach the expected state'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function request(path: string, frame: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path }); let text = '';
    socket.setTimeout(1500, () => { socket.destroy(); reject(Error('own listener response timeout')); });
    socket.on('error', reject); socket.on('connect', () => socket.write(JSON.stringify(frame) + '\n'));
    socket.on('data', chunk => { text += chunk.toString(); const end = text.indexOf('\n'); if (end < 0) return; socket.destroy(); try { resolve(JSON.parse(text.slice(0, end))); } catch (error) { reject(error); } });
  });
}
function fixture(stale: boolean) {
  const base = mkdtempSync('/private/tmp/o3listen-'), home = join(base, 'h'), root = join(base, 'r'), dir = join(root, '.agents');
  mkdirSync(home); mkdirSync(dir, { recursive: true }); child.execFileSync('git', ['init', '-q'], { cwd: root });
  const file = join(dir, 'team.yaml');
  const seat = (name: string, extra = '') => `  - role: worker\n    name: ${name}\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude\n${extra}`;
  const text = `format: 1\nproject: listener-project\nsession: ${session}\noperator: captain\nworkspace:\n  mode: shared\nseats:\n` + seat('captain', '    leads: true\n') + seat('analyst');
  writeFileSync(file, text); intoRegistry(root, home);
  if (stale) writeFileSync(file, text.replace('listener-project', 'retired-project').replaceAll(session, 'retired-session'));
  else if (existsSync(file)) unlinkSync(file);
  updateState(dir, state => { state.sessions[session] = emptySession(); });
  let clock = Date.parse('2026-11-02T11:00:00Z'), delayed = false, refusedDuringGap = false;
  const now = () => new Date(clock);
  const never = (): never => { forbidden.push('pane mutation'); throw Error('no pane mutation'); };
  const sources: WatchSources = { home, now, pid: process.pid, alive: pid => pid === process.pid,
    live: () => {
      if (!delayed) { delayed = true; clock += WATCH_AUTHORITY_MAX_AGE_MS + 1;
        const epoch = readState(dir).sessions[session]!.watch!.epoch!;
        refusedDuringGap = !verifyWatchAuthority({ root, home, session, epoch, purpose: WATCH_DIRECT_WORK, now: now() }).ok;
      }
      return { running: true, agents: [], workspaces: [], screens: {} };
    },
    machine: () => ({ loadPerCore: 0.1, memoryFree: 80, diskFree: 100e9, swapTotal: 0, swapFree: 0, swapUsed: 0 }),
    standing: () => ({ kind: 'none' }), readChecks: () => [], screen: () => null, status: () => null, foreground: () => null, processes: () => null,
    typeText: never, pressEnter: never, sendKey: never, notify: never, sleep: async () => {}, wait: async () => false };
  const sendHost: DaemonHost = { home, now, agents: () => [], processInfo: () => null, socketsDir: join(base, 'synthetic-sockets'),
    deliver: async () => never(), native: { typeText: never, pressEnter: never, sendKey: never, paneText: () => null, status: () => null, wait: async () => {} } };
  return { base, home, root, dir, file, now, sources, sendHost, refusedDuringGap: () => refusedDuringGap, advance: (ms: number) => { clock += ms; } };
}
for (const stale of [false, true]) {
  test(`machine listener resolves registry ${stale ? 'despite a stale file' : 'without a file'} through routing, restore and a long-pass watch`, () => underRegistry(async () => {
    const w = fixture(stale), restore: { root: string; file?: string }[] = [], selected: string[] = [];
    const started = await startMachineDaemon({ home: w.home, roots: [w.root], version: 'independent-listener', now: w.now, heartbeatMs: 10,
      sendHost: w.sendHost, onFatal: () => { forbidden.push('fatal'); }, watchHosting: true,
      hostedWatch: (route, log) => hostedWatchAuthority({ route, teamFile: w.file, log, base: w.sources, now: w.now, alive: pid => pid === process.pid }),
      restoreSweep: async (root, file) => { restore.push({ root, ...(file === undefined ? {} : { file }) }); return { kind: 'no-recorded-session' }; },
      nextPrincipal: () => ({ kind: 'verified', seat: 'analyst', pane: 'fixture-pane' }),
      nextHandler: async input => { selected.push(input.team.session); return { ok: true, kind: 'none', why: 'nothing-takeable' }; },
    });
    expect(started.kind).toBe('serving'); if (started.kind !== 'serving') throw Error('own machine listener did not bind');
    const daemon = started.daemon; active.push(daemon);
    const answer = await probeDaemonHealth(daemon.socketPath, { id: 'independent-health' }); expect(answer.kind).toBe('answered');
    expect(daemon.routes.map(route => route.session)).toEqual([session]);
    expect(restore).toEqual([{ root: w.root }]);
    const response = await request(daemon.socketPath, { v: 2, id: 'independent-next', op: 'next', scope: { root: w.root, session, seat: 'analyst', pane: 'fixture-pane' } });
    expect(response.ok).toBe(true); expect(response.next).toEqual({ ok: true, kind: 'none', why: 'nothing-takeable' }); expect(selected).toEqual([session]);
    await until(() => (daemon.roots[0]?.watch?.cycles ?? 0) >= 1);
    expect(w.refusedDuringGap()).toBe(true);
    const epoch = readState(w.dir).sessions[session]!.watch!.epoch!;
    await until(() => readState(w.dir).sessions[session]?.watch?.heartbeat === w.now().toISOString());
    expect(readState(w.dir).sessions[session]?.watch?.epoch).toBe(epoch);
    w.advance(600000); await until(() => (daemon.roots[0]?.watch?.cycles ?? 0) >= 2);
    expect(daemon.roots[0]?.watch?.effects).toBe('blocked');
    const next = mintWatchEpoch();
    updateState(w.dir, state => { state.sessions[session]!.watch = { ...state.sessions[session]!.watch!, epoch: next, heartbeat: w.now().toISOString() }; });
    await until(() => daemon.roots[0]?.watch?.phase === 'stopped');
    expect(readState(w.dir).sessions[session]?.watch?.epoch).toBe(next);
    expect(verifyWatchAuthority({ root: w.root, home: w.home, session, epoch, purpose: WATCH_DIRECT_WORK, now: w.now() }).ok).toBe(false);
    expect((await probeDaemonHealth(daemon.socketPath, { id: 'after-watch-fence' })).kind).toBe('answered');
    await daemon.close(); active.splice(active.indexOf(daemon), 1); expect(existsSync(daemon.socketPath)).toBe(false);
    if (stale) expect(readFileSync(w.file, 'utf8')).toContain('retired-project'); else expect(existsSync(w.file)).toBe(false);
  }), 10000);
}
