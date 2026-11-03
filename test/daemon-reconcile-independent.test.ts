// Independent reconciliation and endpoint supervision scenes. All stores, sockets and daemon
// instances belong to these scenes; terminal reads and writes are replaced by inert sources.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as reconcile from '../src/bus/reconcile.ts';
import type { ReconcileOptions, ReconcileResult } from '../src/bus/reconcile.ts';
import { readEvents, type SignedEventRecord } from '../src/bus/log.ts';
import { startBus, type BusHandle } from '../src/bus/server.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { runDaemon } from '../src/commands/daemon.ts';
import { runStatus } from '../src/commands/status.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { daemonHealthy, daemonNotes, daemonProblemNotes } from '../src/daemon/health_display.ts';
import { startMachineDaemon, type MachineDaemon } from '../src/daemon/host.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { listUnread, readMessage } from '../src/mcp/inbox.ts';
import { startSendDaemon, type DaemonHost, type SendDaemonHandle } from '../src/send/daemon.ts';
import { signRecord, signReceiptPayload, writeRecord } from '../src/send/record.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { storePath } from '../src/store/store.ts';
import { emptySession, LOCK_FILE, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-01T14:40:00Z');
const SESSION = 'gather';
const TEXT = `format: 1
project: meadow
session: gather
operator: lead
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;
const bases: string[] = [];
const machines: MachineDaemon[] = [];
const buses: BusHandle[] = [];
afterEach(async () => {
  for (const bus of buses.splice(0)) await bus.close();
  for (const machine of machines.splice(0)) await machine.close();
  for (const base of bases.splice(0)) fs.rmSync(base, { recursive: true, force: true });
});

function world() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ri-')));
  bases.push(base);
  const root = join(base, 'r');
  const dir = join(root, '.agents');
  const home = join(base, 'h');
  const drops = join(dir, 'send-drops', SESSION, 'lead');
  const signed = join(dir, 'messages', 'lead');
  fs.mkdirSync(drops, { recursive: true });
  fs.mkdirSync(signed, { recursive: true });
  fs.mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(join(dir, 'team.yaml'), TEXT);
  updateState(dir, state => { state.sessions[SESSION] = emptySession(); });
  messageKeyOf(home);
  const loaded = validateTeamFile(TEXT);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  let paneEffects = 0;
  const never = () => { paneEffects += 1; return false; };
  const sendHost: DaemonHost = {
    home, now: () => new Date(), socketsDir: join(base, 'sockets'),
    agents: () => [], processInfo: () => null,
    deliver: async () => { paneEffects += 1; return { ok: false, reason: 'synthetic delivery closed' }; },
    native: { typeText: never, pressEnter: never, sendKey: never, status: () => null, paneText: () => null, wait: async () => {} },
  };
  const options: ReconcileOptions = { project: 'meadow', root, session: SESSION, home, now: NOW };
  return { base, root, dir, home, drops, signed, team: loaded.team, sendHost, options, paneEffects: () => paneEffects };
}
type World = ReturnType<typeof world>;
type AsyncOptions = ReconcileOptions & { state?: unknown; sliceMs?: number };
// The baseline has the synchronous public pass only. Drain that same pass there, so the
// heartbeat and file-read assertions expose its behavior instead of failing at module import.
const driver = reconcile as unknown as {
  createReconcileState?: () => unknown;
  reconcilePassAsync?: (options: AsyncOptions) => Promise<ReconcileResult>;
};
function passes(w: World) {
  const state = driver.createReconcileState?.() as AsyncOptions['state'];
  return async () => {
    const options = { ...w.options, state, sliceMs: 1 };
    const result = driver.reconcilePassAsync === undefined
      ? reconcile.reconcilePass(options)
      : await driver.reconcilePassAsync(options);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    return result.raised;
  };
}
function drop(w: World, id: string, from = 'lead') {
  const path = join(w.drops, id);
  const signed = signRecord({ kind: 'message', id, to: 'lead', to_id: null, root: w.root, session: SESSION,
    at: NOW.toISOString(), body: 'synthetic ' + id, from, from_id: null, rule: 'synthetic scene', thread: id }, w.home);
  fs.writeFileSync(path, JSON.stringify(signed));
  return path;
}
function signedMessage(w: World, id: string) {
  return signRecord({ kind: 'message', id, to: 'lead', to_id: null, root: w.root, session: SESSION,
    at: NOW.toISOString(), body: 'synthetic body ' + id, from: 'sender-fixture', from_id: null,
    rule: 'synthetic scene', thread: id }, w.home);
}
function events(w: World): SignedEventRecord[] {
  const read = readEvents('meadow', w.root, w.home);
  expect(read.ok).toBe(true);
  return read.ok ? read.events : [];
}
function recordReads(w: World) {
  // A record's bytes are read through one no-follow open; the path it names is what this records.
  const original = fs.openSync;
  const paths: string[] = [];
  const spy = spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (typeof args[0] === 'string' && (args[0].startsWith(w.drops + '/') || args[0].startsWith(w.signed + '/'))) paths.push(args[0]);
    return Reflect.apply(original, fs, args);
  }) as typeof fs.openSync);
  return { paths, restore: () => spy.mockRestore() };
}
async function until(predicate: () => boolean, milliseconds = 1000) {
  const deadline = performance.now() + milliseconds;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('synthetic condition did not arrive');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function machine(w: World, extra: Partial<Parameters<typeof startMachineDaemon>[0]> = {}) {
  const result = await startMachineDaemon({ home: w.home, roots: [w.root], version: 'fixture', heartbeatMs: 10,
    sendHost: w.sendHost, restoreSweep: false, ...extra });
  expect(result.kind).toBe('serving');
  if (result.kind !== 'serving') throw new Error('scratch daemon did not start: ' + result.kind);
  machines.push(result.daemon);
  return result.daemon;
}

test('the persisted heartbeat advances during the initial reconciliation of 2200 records', async () => {
  const w = world();
  for (let n = 0; n < 2200; n += 1) drop(w, 'bulk-' + String(n).padStart(4, '0'));
  let startFinished = false;
  const beats = new Set<string>();
  const observer = setInterval(() => {
    if (startFinished) return;
    const state = readDaemonState(w.home);
    if (state.kind === 'ok' && state.state.roots.some(root => root.root === w.root)) beats.add(state.state.heartbeatAt);
  }, 2);
  try {
    await machine(w, { sendStart: async () => ({ kind: 'already-running', socketPath: join(w.base, 'unused-send.sock'), pid: process.pid }) });
    startFinished = true;
    expect(beats.size).toBeGreaterThanOrEqual(2);
    expect(events(w).filter(event => event.payload.kind === 'message.arrived' && event.payload.record_id.startsWith('bulk-'))).toHaveLength(2200);
    expect(w.paneEffects()).toBe(0);
  } finally { clearInterval(observer); }
}, 20_000);

test('an unchanged pass reads no drop or signed-record bytes a second time', async () => {
  const w = world();
  for (let n = 0; n < 48; n += 1) drop(w, 'cached-' + n);
  for (let n = 0; n < 7; n += 1) fs.writeFileSync(join(w.signed, 'signed-' + n + '.json'), JSON.stringify(signedMessage(w, 'signed-' + n)));
  const pass = passes(w);
  const reads = recordReads(w);
  try {
    const first = await pass();
    expect(first.filter(event => event.payload.kind === 'message.arrived')).toHaveLength(55);
    expect(reads.paths.length).toBeGreaterThanOrEqual(55);
    reads.paths.splice(0);
    expect(await pass()).toEqual([]);
    expect(reads.paths).toEqual([]);
  } finally { reads.restore(); }
});

test('a changed record under the same name is re-read while its unchanged neighbors are reused', async () => {
  const w = world();
  const changed = drop(w, 'mutable', 'old-sender');
  for (let n = 0; n < 12; n += 1) drop(w, 'neighbor-' + n);
  const pass = passes(w);
  await pass();
  drop(w, 'mutable', 'fresh-sender-with-new-bytes');
  fs.writeFileSync(join(w.drops, 'mutable.read.json'), '{}');
  const reads = recordReads(w);
  try {
    const raised = await pass();
    expect(reads.paths).toEqual([changed]);
    expect(raised.filter(event => event.payload.record_id === 'mutable:read').map(event => event.payload.from)).toEqual(['fresh-sender-with-new-bytes']);
    expect(raised.some(event => event.payload.kind === 'message.arrived')).toBe(false);
    expect(await pass()).toEqual([]);
  } finally { reads.restore(); }
});

for (const receipt of ['read', 'replied'] as const) {
  test('a late ' + receipt + ' receipt keeps the sender after the original drop is taken and is raised once', async () => {
    const w = world();
    const original = drop(w, 'late-item', 'departed-sender');
    const pass = passes(w);
    await pass();
    fs.unlinkSync(original);
    fs.writeFileSync(join(w.drops, 'late-item.' + receipt + '.json'), '{}');
    const raised = await pass();
    expect(raised.filter(event => event.payload.kind === 'message.' + receipt).map(event => ({ id: event.payload.record_id, from: event.payload.from })))
      .toEqual([{ id: 'late-item:' + receipt, from: 'departed-sender' }]);
    expect(await pass()).toEqual([]);
    expect(events(w).filter(event => event.payload.record_id === 'late-item:' + receipt)).toHaveLength(1);
  });
}

test('a late signed read receipt retains its removed message sender', async () => {
  const w = world();
  const id = 'signed-late';
  const path = join(w.signed, id + '.json');
  fs.writeFileSync(path, JSON.stringify(signedMessage(w, id)));
  const pass = passes(w);
  await pass();
  fs.unlinkSync(path);
  fs.writeFileSync(join(w.signed, id + '.read.json'), JSON.stringify(signReceiptPayload({
    kind: 'receipt', status: 'read', id, to: 'lead', root: w.root, session: SESSION, at: NOW.toISOString(),
  }, w.home)));
  const raised = await pass();
  expect(raised.filter(event => event.payload.kind === 'message.read').map(event => event.payload.from)).toEqual(['sender-fixture']);
  expect(await pass()).toEqual([]);
});

test('reconciliation never re-exposes a message whose first read spent its signed receipt', async () => {
  const w = world();
  const id = '11111111-2222-4333-8444-555555555555';
  const signed = signedMessage(w, id);
  expect(writeRecord(w.drops, signed).ok).toBe(true);
  const pass = passes(w);
  await pass();
  const target = { root: w.root, seat: 'lead', session: SESSION, dropDir: w.drops };
  const first = readMessage(target, id, w.home);
  expect(first).toMatchObject({ ok: true });
  expect(JSON.stringify(first)).toContain('synthetic body ' + id);
  await pass();
  await pass();
  const second = readMessage(target, id, w.home);
  expect(JSON.stringify(second)).not.toContain('synthetic body ' + id);
  expect(listUnread(w.drops, { root: w.root, to: 'lead', session: SESSION }, w.home)).toEqual([]);
  expect(events(w).filter(event => event.payload.record_id === id + ':read')).toHaveLength(1);
});

test('closing this daemon\'s own send listener causes a new listener to be started', async () => {
  const w = world();
  const started: SendDaemonHandle[] = [];
  const host = await machine(w, { sendStart: async input => {
    const result = await startSendDaemon({ ...input, socketPath: join(w.base, 'send.sock'), lockPath: join(w.base, 'send.lock') });
    if (result.kind === 'serving') started.push(result.handle);
    return result;
  } });
  expect(started).toHaveLength(1);
  await started[0]!.close();
  await until(() => started.length >= 2 && host.roots[0]!.send === 'serving');
  expect(host.roots[0]!.send).toBe('serving');
  expect(started).toHaveLength(2);
  expect(w.paneEffects()).toBe(0);
});

test('persistent endpoint failure ends the foreground command non-zero and reports fatal once', async () => {
  const w = world();
  const io = testIo(w.root, { kind: 'owner' });
  let fatals = 0;
  let closes = 0;
  let starts = 0;
  const code = await runDaemon(['run', '--root', w.root], io, {
    home: w.home, version: 'fixture', sendHost: w.sendHost, heartbeatMs: 10,
    start: async input => {
      const options = { ...input, restoreSweep: false,
        sendStart: async () => { starts += 1; return { kind: 'bind-failed' as const, reason: 'synthetic bind failure' }; },
        sendRestart: { giveUp: 2, backoffMs: () => 1 },
        onFatal: (why: string) => { fatals += 1; (input as { onFatal?: (why: string) => void }).onFatal?.(why); },
      };
      const result = await startMachineDaemon(options);
      if (result.kind === 'serving') {
        machines.push(result.daemon);
        const original = result.daemon.close.bind(result.daemon);
        result.daemon.close = async () => { closes += 1; await original(); };
      }
      return result;
    },
    stop: end => { const timer = setTimeout(end, 400); return () => clearTimeout(timer); },
  });
  expect(code).toBe(1);
  expect(fatals).toBe(1);
  expect(starts).toBe(3);
  expect(closes).toBe(1);
  expect(io.out).not.toContain('team daemon: stopped\n');
  expect(w.paneEffects()).toBe(0);
});

test('a fatal reported before startup resolves still closes once and returns non-zero', async () => {
  const w = world();
  let closes = 0;
  let stopHooks = 0;
  const io = testIo(w.root, { kind: 'owner' });
  const code = await runDaemon(['run'], io, {
    home: w.home, version: 'fixture',
    start: async input => {
      (input as { onFatal?: (why: string) => void }).onFatal?.('synthetic early fatal');
      return { kind: 'serving', daemon: {
        socketPath: join(w.base, 'unused.sock'), roots: [], routes: [],
        close: async () => { closes += 1; }, health: () => { throw new Error('no synthetic probe expected'); },
      } };
    },
    stop: end => { stopHooks += 1; queueMicrotask(end); return () => {}; },
  });
  expect(code).toBe(1);
  expect(closes).toBe(1);
  expect(stopHooks).toBe(0);
  expect(io.err).toContain('synthetic early fatal');
});

type EndpointRoot = DaemonHealth['roots'][number] & { sendFailedAt?: string; busFailedAt?: string };
function health(w: World, endpoint: 'send' | 'bus', failedAt: string | undefined): DaemonHealth {
  const root: EndpointRoot = { root: w.root, team: 'meadow', send: 'serving', bus: 'serving', why: 'synthetic endpoint failure' };
  root[endpoint] = 'failed';
  if (failedAt !== undefined) root[endpoint === 'send' ? 'sendFailedAt' : 'busFailedAt'] = failedAt;
  return {
    daemon: 'teamcli', socket: join(w.home, 'unused.sock'), state: 'running', running: true,
    pid: 123456789, uid: 12345, since: new Date(NOW.getTime() - 600_000).toISOString(), startedBy: 'service-manager',
    version: 'fixture', gitHead: null, heartbeatAt: NOW.toISOString(), features: { broker: 'absent' },
    heartbeatSeconds: null,
    roots: [root], stuck: [], probe: { state: 'answered', at: NOW.toISOString() }, why: null,
  };
}
for (const endpoint of ['send', 'bus'] as const) {
  for (const command of ['status', 'check'] as const) {
    for (const json of [true, false]) {
      test(command + ' names a failed ' + endpoint + ' endpoint, its 2m age and owner repair: json=' + json, async () => {
        const w = world();
        const io = testIo(w.root, { kind: 'owner' });
        const reading = health(w, endpoint, new Date(NOW.getTime() - 125_000).toISOString());
        const common = { home: w.home, now: () => NOW, branch: () => 'main', standing: () => ({ kind: 'none' as const }),
          live: () => ({ running: false, agents: [], workspaces: [], screens: {} }) };
        const code = command === 'status'
          ? await runStatus(json ? ['--json'] : [], io, { ...common, daemonHealth: async () => reading })
          : runTeamCheck({ json }, io, { ...common, daemon: reading, alive: () => false });
        expect(code).toBe(1);
        if (json) {
          const doc = JSON.parse(io.out) as { differences: { what: string; repair: string; who: string }[] };
          const endpointRows = doc.differences.filter(row => row.what.startsWith('machine daemon ' + endpoint + ' endpoint'));
          expect(endpointRows).toEqual([{
            what: 'machine daemon ' + endpoint + ' endpoint for ' + w.root + ': synthetic endpoint failure, failing for 2m',
            repair: 'team daemon install', who: 'the owner',
          }]);
        } else {
          expect(io.out).toContain('machine daemon ' + endpoint + ' endpoint for ' + w.root + ': synthetic endpoint failure, failing for 2m');
          expect(io.out).toContain('repair: team daemon install');
        }
        expect(io.err).toBe('');
      });
    }
  }
}

for (const invalidAt of [undefined, 'not-a-clock', new Date(NOW.getTime() + 1000).toISOString()]) {
  test('the endpoint reading invents no age for ' + String(invalidAt), async () => {
    const w = world();
    const io = testIo(w.root, { kind: 'owner' });
    await runStatus([], io, { home: w.home, now: () => NOW, branch: () => 'main', standing: () => ({ kind: 'none' }),
      live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
      daemonHealth: async () => health(w, 'send', invalidAt),
    });
    expect(io.out).not.toContain('failing for');
  });
}

function holdEventLock(w: World) {
  const folder = join(storePath('meadow', w.root, w.home), 'locks', 'events');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, LOCK_FILE);
  const owner = String(process.pid) + '\n';
  fs.writeFileSync(path, owner, { flag: 'wx', mode: 0o600 });
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (fs.existsSync(path) && fs.readFileSync(path, 'utf8') === owner) fs.unlinkSync(path);
  };
}

for (const mode of ['sync', 'async'] as const) {
  test('a refused seat-event append is retried on the next ' + mode + ' pass with the same cache', async () => {
    const w = world();
    const state = driver.createReconcileState?.() as AsyncOptions['state'];
    const options = { ...w.options, state, sliceMs: 0, appendWaitMs: 0, appendRetryMs: 0 };
    const run = () => mode === 'sync' ? Promise.resolve(reconcile.reconcilePass(options)) : driver.reconcilePassAsync!(options);
    expect((await run()).ok).toBe(true);
    updateState(w.dir, file => {
      file.sessions[SESSION]!.seats.lead = { stage: 'ready', last_active: NOW.toISOString() };
    });
    const unlock = holdEventLock(w);
    try {
      expect((await run()).ok).toBe(true);
      expect(events(w).some(event => event.payload.kind === 'seat.working')).toBe(false);
    } finally { unlock(); }
    const retry = await run();
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error(retry.reason);
    expect(retry.raised.filter(event => event.payload.kind === 'seat.working').map(event => ({ seat: event.payload.seat, ts: event.payload.ts })))
      .toEqual([{ seat: 'lead', ts: NOW.toISOString() }]);
    expect((await run()).ok).toBe(true);
    expect(events(w).filter(event => event.payload.kind === 'seat.working')).toHaveLength(1);
  }, 15_000);
}

test('a contended event lock lets timers run and its append lands after the timer releases it', async () => {
  const w = world();
  const state = driver.createReconcileState?.() as AsyncOptions['state'];
  const options = { ...w.options, state, sliceMs: 0, appendRetryMs: 600 };
  expect((await driver.reconcilePassAsync!(options)).ok).toBe(true);
  drop(w, 'contended-record');
  const unlock = holdEventLock(w);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  const writer = setTimeout(unlock, 75);
  const began = performance.now();
  let result: ReconcileResult;
  try { result = await driver.reconcilePassAsync!(options); }
  finally { clearInterval(timer); clearTimeout(writer); unlock(); }
  const elapsed = performance.now() - began;
  expect(elapsed).toBeLessThan(1500);
  expect(ticks).toBeGreaterThanOrEqual(2);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.raised.some(event => event.payload.record_id === 'contended-record')).toBe(true);
}, 15_000);

async function bus(w: World) {
  const started = await startBus({ root: w.root, team: w.team, home: w.home, stderr: () => {}, reconcileIntervalMs: 0 });
  expect(started.kind).toBe('serving');
  if (started.kind !== 'serving') throw new Error('owned bus did not start: ' + started.kind);
  buses.push(started.handle);
  return started.handle;
}

test('a bus writes nothing after close resolves while its reconciliation was in flight', async () => {
  const w = world();
  const first = await bus(w);
  for (let n = 0; n < 200; n += 1) drop(w, 'close-flight-' + String(n).padStart(3, '0'));
  const running = first.reconcileNow();
  await first.close();
  const atClose = events(w);
  await running;
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(events(w)).toEqual(atClose);
  // Cancellation may leave records for the next process. A new bus must recover all of them,
  // exactly once, rather than claiming that close completed a pass it deliberately stopped.
  const replacement = await bus(w);
  expect(events(w).filter(event => event.payload.record_id.startsWith('close-flight-'))).toHaveLength(200);
  expect(await replacement.reconcileNow()).toEqual([]);
});

test('reconcileNow cannot restart a closed bus or append a record that arrived after close', async () => {
  const w = world();
  const owned = await bus(w);
  await owned.close();
  const before = events(w);
  drop(w, 'after-close');
  expect(await owned.reconcileNow()).toEqual([]);
  expect(events(w)).toEqual(before);
});

for (const endpoint of ['send', 'bus'] as const) {
  test('health retains the failed ' + endpoint + ' endpoint without an optional failure timestamp', () => {
    const w = world();
    const reading = health(w, endpoint, undefined);
    expect(daemonHealthy(reading)).toBe(false);
    const detail = endpoint + ' for ' + w.root + ': synthetic endpoint failure';
    expect(daemonNotes(reading).join('\n')).toContain(detail);
    expect(daemonProblemNotes(reading).join('\n')).toContain(detail);
    expect(daemonNotes(reading).join('\n')).not.toContain('failing for');
  });
  for (const command of ['status', 'check'] as const) {
    for (const json of [true, false]) {
      test(command + ' preserves an older failed ' + endpoint + ' endpoint without inventing an age: json=' + json, async () => {
        const w = world();
        const io = testIo(w.root, { kind: 'owner' });
        const reading = health(w, endpoint, undefined);
        const common = { home: w.home, now: () => NOW, branch: () => 'main', standing: () => ({ kind: 'none' as const }),
          live: () => ({ running: false, agents: [], workspaces: [], screens: {} }) };
        const code = command === 'status'
          ? await runStatus(json ? ['--json'] : [], io, { ...common, daemonHealth: async () => reading })
          : runTeamCheck({ json }, io, { ...common, daemon: reading, alive: () => false });
        expect(code).toBe(1);
        const what = 'machine daemon ' + endpoint + ' endpoint for ' + w.root + ': synthetic endpoint failure';
        if (json) {
          const doc = JSON.parse(io.out) as { differences: { what: string; repair: string; who: string }[] };
          expect(doc.differences.filter(row => row.what.startsWith('machine daemon ' + endpoint + ' endpoint')))
            .toEqual([{ what, repair: 'team daemon install', who: 'the owner' }]);
        } else {
          expect(io.out).toContain('difference: ' + what);
          expect(io.out).toContain('repair: team daemon install');
        }
        expect(io.out).not.toContain('failing for');
        expect(io.err).toBe('');
      });
    }
  }
}

function freshProcessPass(w: World) {
  const output = execFileSync(process.execPath, [
    fileURLToPath(new URL('./daemon-reconcile-receipt-worker.ts', import.meta.url)), JSON.stringify(w.options),
  ], { encoding: 'utf8', env: { ...process.env, HOME: w.home }, timeout: 10_000 });
  return JSON.parse(output) as { first: SignedEventRecord[]; second: SignedEventRecord[] };
}
for (const receipt of ['read', 'replied'] as const) {
  for (const restart of [false, true]) {
    test('a late ' + receipt + ' keeps its sender after two quiet passes; fresh process=' + restart, async () => {
      const w = world();
      const original = drop(w, 'quiet-late', 'durable-sender');
      const pass = passes(w);
      await pass();
      fs.unlinkSync(original);
      expect(await pass()).toEqual([]);
      expect(await pass()).toEqual([]);
      fs.writeFileSync(join(w.drops, 'quiet-late.' + receipt + '.json'), '{}');
      const result = restart ? freshProcessPass(w) : { first: await pass(), second: await pass() };
      expect(result.first.filter(event => event.payload.kind === 'message.' + receipt).map(event => ({ id: event.payload.record_id, from: event.payload.from, to: event.payload.to })))
        .toEqual([{ id: 'quiet-late:' + receipt, from: 'durable-sender', to: 'lead' }]);
      expect(result.second).toEqual([]);
      expect(events(w).filter(event => event.payload.record_id === 'quiet-late:' + receipt)).toHaveLength(1);
    });
  }
}
for (const restart of [false, true]) {
  test('a late signed read keeps its sender after quiet passes; fresh process=' + restart, async () => {
    const w = world();
    const id = 'quiet-signed';
    const original = join(w.signed, id + '.json');
    fs.writeFileSync(original, JSON.stringify(signedMessage(w, id)));
    const pass = passes(w);
    await pass();
    fs.unlinkSync(original);
    expect(await pass()).toEqual([]);
    expect(await pass()).toEqual([]);
    fs.writeFileSync(join(w.signed, id + '.read.json'), JSON.stringify(signReceiptPayload({
      kind: 'receipt', status: 'read', id, to: 'lead', root: w.root, session: SESSION, at: NOW.toISOString(),
    }, w.home)));
    const result = restart ? freshProcessPass(w) : { first: await pass(), second: await pass() };
    expect(result.first.filter(event => event.payload.kind === 'message.read').map(event => event.payload.from)).toEqual(['sender-fixture']);
    expect(result.second).toEqual([]);
    expect(events(w).filter(event => event.payload.record_id === id + ':read')).toHaveLength(1);
  });
}

// Hold the real event lock until every input has reached the deferred queue. This separates
// scan pacing from drain pacing without replacing the append or its persistence boundary.
async function deferredScene(count: number, run: (w: World, state: reconcile.ReconcileState, unlock: () => void) => Promise<void>) {
  const w = world();
  const state = reconcile.createReconcileState();
  expect((await reconcile.reconcilePassAsync({ ...w.options, state })).ok).toBe(true);
  for (let n = 0; n < count; n += 1) drop(w, 'deferred-scene-' + String(n).padStart(3, '0'));
  const unlock = holdEventLock(w);
  let deferredCount = 0;
  const release = setInterval(() => {
    deferredCount = Math.max(deferredCount, state.deferred.length);
    if (deferredCount >= count) unlock();
  }, 1);
  try {
    await run(w, state, unlock);
    expect(deferredCount).toBe(count);
  } finally { clearInterval(release); unlock(); }
}

test('timers advance between the first and last fan-out of 200 deferred appends', async () => {
  await deferredScene(200, async (w, state) => {
    let ticks = 0;
    let firstTick: number | null = null;
    let lastTick = 0;
    const fanned: string[] = [];
    const timer = setInterval(() => { ticks += 1; }, 1);
    try {
      const result = await reconcile.reconcilePassAsync({ ...w.options, state, sliceMs: 1, appendRetryMs: 5000,
        onEvent: record => {
          if (!record.payload.record_id.startsWith('deferred-scene-')) return;
          firstTick ??= ticks;
          lastTick = ticks;
          fanned.push(record.payload.record_id);
        },
      });
      expect(result.ok).toBe(true);
    } finally { clearInterval(timer); }
    expect(fanned).toHaveLength(200);
    expect(new Set(fanned).size).toBe(200);
    expect(lastTick - firstTick!).toBeGreaterThanOrEqual(2);
    expect(events(w).filter(record => record.payload.record_id.startsWith('deferred-scene-'))).toHaveLength(200);
    const again = await reconcile.reconcilePassAsync({ ...w.options, state, sliceMs: 1 });
    expect(again.ok && again.raised).toEqual([]);
  });
}, 15_000);

test('aborting the first deferred callback writes no later item and a fresh pass recovers the rest once', async () => {
  await deferredScene(7, async (w, state) => {
    const abort = new AbortController();
    const first: string[] = [];
    await reconcile.reconcilePassAsync({ ...w.options, state, sliceMs: 1, appendRetryMs: 5000, signal: abort.signal,
      onEvent: record => {
        if (!record.payload.record_id.startsWith('deferred-scene-')) return;
        first.push(record.payload.record_id);
        abort.abort();
      },
    });
    expect(first).toHaveLength(1);
    const atReturn = events(w).filter(record => record.payload.record_id.startsWith('deferred-scene-'));
    expect(atReturn.map(record => record.payload.record_id)).toEqual(first);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(events(w).filter(record => record.payload.record_id.startsWith('deferred-scene-'))).toEqual(atReturn);
    const recovered: string[] = [];
    const next = await reconcile.reconcilePassAsync({ ...w.options, state, sliceMs: 1,
      onEvent: record => { if (record.payload.record_id.startsWith('deferred-scene-')) recovered.push(record.payload.record_id); },
    });
    expect(next.ok).toBe(true);
    expect(recovered).toHaveLength(6);
    expect(recovered).not.toContain(first[0]!);
    expect(new Set([...first, ...recovered]).size).toBe(7);
    expect(events(w).filter(record => record.payload.record_id.startsWith('deferred-scene-'))).toHaveLength(7);
    const again = await reconcile.reconcilePassAsync({ ...w.options, state, sliceMs: 1 });
    expect(again.ok && again.raised).toEqual([]);
  });
}, 15_000);


test('an abort delivered during the deferred yield stops the next append and preserves recovery', async () => {
  await deferredScene(7, async (w, state) => {
    const abort = new AbortController();
    const first: string[] = [];
    let abortDelivered = false;
    await reconcile.reconcilePassAsync({ ...w.options, state, sliceMs: 0, appendRetryMs: 5000, signal: abort.signal,
      onEvent: record => {
        if (!record.payload.record_id.startsWith('deferred-scene-')) return;
        first.push(record.payload.record_id);
        if (first.length === 1) setImmediate(() => { abortDelivered = true; abort.abort(); });
      },
    });
    expect(abortDelivered).toBe(true);
    expect(first).toHaveLength(1);
    const atReturn = events(w).filter(record => record.payload.record_id.startsWith('deferred-scene-'));
    expect(atReturn.map(record => record.payload.record_id)).toEqual(first);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(events(w).filter(record => record.payload.record_id.startsWith('deferred-scene-'))).toEqual(atReturn);
    const recovered: string[] = [];
    const next = await reconcile.reconcilePassAsync({ ...w.options, state, sliceMs: 0,
      onEvent: record => { if (record.payload.record_id.startsWith('deferred-scene-')) recovered.push(record.payload.record_id); },
    });
    expect(next.ok).toBe(true);
    expect(recovered).toHaveLength(6);
    expect(recovered).not.toContain(first[0]!);
    expect(new Set([...first, ...recovered]).size).toBe(7);
    expect(events(w).filter(record => record.payload.record_id.startsWith('deferred-scene-'))).toHaveLength(7);
    const again = await reconcile.reconcilePassAsync({ ...w.options, state, sliceMs: 0 });
    expect(again.ok && again.raised).toEqual([]);
  });
}, 15_000);
