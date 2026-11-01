// In-process host and owned machine socket only; send, bus, presence and restore seams are inert.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import * as busApi from '../src/bus/server.ts';
import { startMachineDaemon, type MachineDaemon, type StartMachineDaemonInput, type StartMachineDaemonResult } from '../src/daemon/host.ts';
import { daemonHealth, probeDaemonHealth } from '../src/daemon/health.ts';
import { daemonSocketPath } from '../src/daemon/paths.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import type { PresenceIngestResult } from '../src/daemon/presence/ingest.ts';
import type { DaemonHost } from '../src/send/daemon.ts';
import { assertIndependentHome } from './independent-home-fixture.ts';
const NOW = new Date('2026-11-01T10:30:00.000Z');
const owned: string[] = [];
const pending: { release(): void; started: Promise<StartMachineDaemonResult> }[] = [];
const mocks: { mockRestore(): void }[] = [];
afterEach(async () => {
  try {
    for (const one of pending) one.release();
    for (const one of pending.splice(0)) { const result = await one.started; if (result.kind === 'serving') await result.daemon.close(); }
  } finally {
    for (const mock of mocks.splice(0)) mock.mockRestore();
    for (const dir of owned.splice(0)) execFileSync('trash', [dir]);
  }
});
const golden: { base: string; rows: Record<string, string> } = JSON.parse(fs.readFileSync(new URL('./fixtures/daemon-health-bind-independent-parity.json', import.meta.url), 'utf8'));
const TEXT = `format: 1
project: bind-health
session: health-scene
operator: worker
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    leads: true
    cli: claude-code
    vendor: synthetic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: worker
    cli: claude-code
    vendor: synthetic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;
function world(count = 1) {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/hbi-')); owned.push(base);
  const home = join(base, 'h'); fs.mkdirSync(home);
  const roots = Array.from({ length: count }, (_, i) => {
    const root = join(base, 'r' + i); fs.mkdirSync(join(root, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(join(root, '.agents', 'team.yaml'), TEXT.replace('project: bind-health', 'project: bind-health-' + i)); return root;
  });
  return { base, home, roots };
}
type World = ReturnType<typeof world>;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  const end = performance.now() + 2000;
  while (!check()) { if (performance.now() > end) throw new Error('the synthetic startup seam was not reached'); await new Promise(r => setTimeout(r, 2)); }
}
function fixture(w: World, options: { presence?: boolean; healthy?: boolean; hold?: boolean } = {}) {
  const gates = w.roots.map(() => deferred<busApi.StartBusResult>()); const entered: string[] = []; let steps = 0, published = 0;
  const forbidden = () => { throw new Error('real terminal-host activity is forbidden'); };
  const host: DaemonHost = { home: w.home, socketsDir: join(w.base, 'no-sockets'), now: () => NOW,
    agents: forbidden, processInfo: forbidden, deliver: forbidden,
    native: { typeText: forbidden, pressEnter: forbidden, status: forbidden, wait: forbidden, paneText: forbidden, sendKey: forbidden } };
  const mock = spyOn(busApi, 'startBus').mockImplementation(async (input): Promise<busApi.StartBusResult> => {
    expect(w.roots).toContain(input.root); entered.push(input.root);
    return options.hold ? gates[w.roots.indexOf(input.root)]!.promise : { kind: 'bind-failed', code: 'synthetic-bus' };
  }); mocks.push(mock);
  const release = () => { for (const gate of gates) gate.resolve({ kind: 'bind-failed', code: 'synthetic-bus' }); };
  const fatal: string[] = [];
  const input: StartMachineDaemonInput = { home: w.home, roots: w.roots, version: 'synthetic-bind-health', gitHead: '4'.repeat(40),
    now: () => NOW, startedBy: 'independent-test', heartbeatMs: 60_000, presenceEveryMs: 5,
    sendHost: host, sendStart: async () => ({ kind: 'locked', holderPid: null }),
    busStart: async () => { throw new Error('no bus restart is allowed in this fixture'); },
    watchHosting: false, restoreSweep: false, onFatal: why => fatal.push(why),
    presenceHosting: options.presence !== false,
    presenceSubscriptions: () => [], presenceUnproven: () => [],
    presenceIngest: () => ({
      step: async (): Promise<PresenceIngestResult> => { steps++; return { ingested: [], rejected: [], stale: [], repaired: [], errors: [], healthy: options.healthy ?? false, pending: false, closed: false }; },
      close: async () => ({ quiesced: true }), isClosed: () => false,
    }),
    presenceActivity: () => async () => ({ seats: [], failed: null }),
    presencePublish: () => async () => { published++; return { seats: [], failed: null }; },
  };
  const started = startMachineDaemon(input); pending.push({ release, started });
  return { started, entered, steps: () => steps, published: () => published, fatal, release, releaseAt: (index: number) => gates[index]!.resolve({ kind: 'bind-failed', code: 'synthetic-bus' }) };
}
function raw(w: World, version: 1 | 2, id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: daemonSocketPath(w.home) }); let text = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('the owned health endpoint did not answer')); }, 1200);
    const done = (error?: Error) => { clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(text.slice(0, text.indexOf('\n') + 1)); };
    socket.on('error', done); socket.on('connect', () => socket.write(JSON.stringify({ v: version, id, op: 'health' }) + '\n'));
    socket.on('data', data => { text += data.toString(); if (text.includes('\n')) done(); });
  });
}
function normalized(line: string, w: World) {
  let value = line.replace(`"pid":${process.pid}`, '"pid":"<pid>"').replace(`"uid":${process.getuid?.() ?? -1}`, '"uid":"<uid>"');
  for (const [i, root] of w.roots.entries()) value = value.split(JSON.stringify(root)).join(JSON.stringify('<root' + i + '>'));
  return value;
}
async function serving(result: Promise<StartMachineDaemonResult>): Promise<MachineDaemon> {
  const read = await result; expect(read.kind).toBe('serving'); if (read.kind !== 'serving') throw new Error('the owned in-process host refused'); return read.daemon;
}
function assertStarting(roots: { root: string; presence?: { state: string; healthy?: boolean; why: string | null } }[], expected: string[]) {
  expect(roots.map(r => r.root)).toEqual(expected);
  for (const root of roots) { expect(root.presence?.state).toBe('pending'); expect(root.presence?.healthy).toBe(false); expect(root.presence?.why).toContain('starting'); }
}
test('the host modules start inside the suite-owned HOME', () => { assertIndependentHome(); expect(golden.base).toBe('4af3231be85044f68677c2c894d0fd52dd7c67e6'); });
for (const version of [1, 2] as const) test(`v${version} health answers during the first root's delayed fake bus start`, async () => {
  const w = world(); const f = fixture(w, { hold: true, healthy: true }); await until(() => f.entered.length === 1);
  const line = await raw(w, version, 'during-first'); const answer = JSON.parse(line);
  expect(line).not.toContain('daemon.internal'); expect(answer.ok).toBe(true); expect(answer.id).toBe('during-first');
  expect(answer.health.pid).toBe(process.pid); assertStarting(answer.health.roots, w.roots); expect(f.steps()).toBe(0);
  const state = readDaemonState(w.home); expect(state.kind).toBe('ok'); if (state.kind === 'ok') expect(state.state.roots[0]!.bus).toBe('starting');
  f.release(); await serving(f.started);
});
test('the real health consumer reports running and pending, never serving, while startup is held', async () => {
  const w = world(); const f = fixture(w, { hold: true }); await until(() => f.entered.length === 1);
  const probe = await probeDaemonHealth(daemonSocketPath(w.home), { timeoutMs: 500, id: 'startup-client' }); expect(probe.kind).toBe('answered');
  const health = await daemonHealth(w.home, { timeoutMs: 500, now: () => NOW, id: 'startup-consumer' });
  expect(health.running).toBe(true); expect(health.state).toBe('running'); expect(health.probe.state).toBe('answered');
  assertStarting(health.roots, w.roots); expect(JSON.stringify(health)).not.toContain('daemon.internal');
});
test('a later delayed root holds every route pending until the roots loop finishes', async () => {
  const w = world(2); const f = fixture(w, { hold: true, healthy: true }); await until(() => f.entered.length === 1);
  f.releaseAt(0); await until(() => f.entered.length === 2);
  const response = JSON.parse(await raw(w, 2, 'during-second')); expect(response.ok).toBe(true); assertStarting(response.health.roots, w.roots);
  expect(f.steps()).toBe(0); f.release(); await serving(f.started); await until(() => f.published() >= 2);
  const completed = JSON.parse(await raw(w, 2, 'after-second')); expect(completed.ok).toBe(true);
  for (const root of completed.health.roots) { expect(root.presence.state).toBe('serving'); expect(root.presence.healthy).toBe(true); expect(root.presence.why).toBeNull(); }
});
test('presence hosting off keeps its old root-only health answer during startup', async () => {
  const w = world(); const f = fixture(w, { hold: true, presence: false }); await until(() => f.entered.length === 1);
  const response = JSON.parse(await raw(w, 2, 'no-presence-startup')); expect(response.ok).toBe(true);
  expect(response.health.roots).toEqual([{ root: w.roots[0] }]); expect(f.steps()).toBe(0);
});
for (const version of [1, 2] as const) for (const mode of ['no-presence', 'pending', 'healthy', 'empty'] as const) test(`post-loop bytes match the measured base: v${version} ${mode}`, async () => {
  const w = world(mode === 'empty' ? 0 : 2); const f = fixture(w, { presence: mode !== 'no-presence', healthy: mode === 'healthy' });
  const daemon = await serving(f.started);
  if (mode !== 'empty' && mode !== 'no-presence') await until(() => f.published() >= w.roots.length);
  const key = `v${version}-${mode}`; const actual = normalized(await raw(w, version, 'parity-' + key), w);
  if (process.env.TEAM_HEALTH_BIND_CAPTURE === '1') process.stdout.write('HEALTH_PARITY ' + JSON.stringify({ key, actual }) + '\n');
  expect(actual).toBe(golden.rows[key]!); expect(f.fatal).toEqual([]); await daemon.close();
});
