// Real loopback receivers and synthetic stores only. No pane, service or owner credentials.
import { afterEach, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConfig } from '../src/commands/config.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { appendEvent, readEvents, type EventAppendInput, type SignedEventRecord } from '../src/bus/log.ts';
import { publishToBus, startBus, type BusHandle } from '../src/bus/server.ts';
import { emptySession, updateState } from '../src/state.ts';
import { signRecord, type RecordPayload } from '../src/send/record.ts';
import { testIo } from './helpers.ts';
const deliveryPath = new URL('../src/bus/webhook.ts', import.meta.url);
const routePath = new URL('../src/send/webhook.ts', import.meta.url);
const deliveryApi = fs.existsSync(deliveryPath) ? await import(deliveryPath.href) as typeof import('../src/bus/webhook.ts') : null;
const routeApi = fs.existsSync(routePath) ? await import(routePath.href) as typeof import('../src/send/webhook.ts') : null;
function delivery() { assert.ok(deliveryApi, 'the shipped webhook delivery module must exist'); return deliveryApi; }
const bases: string[] = [];
const buses: BusHandle[] = [];
const receivers: { stop(closeActiveConnections?: boolean): void }[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const bus of buses.splice(0)) await bus.close();
  for (const receiver of receivers.splice(0)) receiver.stop(true);
  const owned = bases.splice(0); if (owned.length) execFileSync('trash', owned, { timeout: 20_000 });
}, 30_000);
const NOW = new Date('2026-11-01T16:00:00Z');
const TEXT = `format: 1
project: hook-scene
session: hooks
operator: lead
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    leads: true
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: fixture
  - role: worker
    name: routine
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: fixture
delivery_order: [drop]
`;
function world() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'wi-'))); bases.push(base);
  const root = join(base, 'r'); const dir = join(root, '.agents'); const home = join(base, 'h');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' }); fs.writeFileSync(join(dir, 'team.yaml'), TEXT);
  updateState(dir, state => { const session = emptySession();
    session.seats.routine = { stage: 'ready', pane: 'synthetic-routine', workspace: 'synthetic-workspace' }; state.sessions.hooks = session; });
  const secret = 'synthetic-hook-secret-' + 'value-never-in-a-record';
  const webhook = { urlFile: join(base, 'url-value'), secretFile: join(base, 'secret-value') };
  fs.writeFileSync(webhook.urlFile, 'http://127.0.0.1:1/not-listening\n', { mode: 0o600 });
  fs.writeFileSync(webhook.secretFile, secret + '\n', { mode: 0o600 });
  return { base, root, dir, home, webhook, secret };
}
type World = ReturnType<typeof world>;
function load(w: World) {
  const result = validateTeamFile(fs.readFileSync(join(w.dir, 'team.yaml'), 'utf8'));
  if (!result.ok) throw new Error(JSON.stringify(result.errors)); return result.team;
}
async function configure(w: World) {
  const io = testIo(w.root, { kind: 'owner' }); io.stdinIsTTY = true; io.env = { HOME: w.home };
  const value = JSON.stringify({ url_file: w.webhook.urlFile, secret_file: w.webhook.secretFile });
  const code = await runConfig(['set', 'seats.routine.webhook', value], io, { home: w.home, env: { HOME: w.home }, present: false });
  expect(code, io.err + io.out).toBe(0);
  return { io, team: load(w) };
}
function drop(w: World, id: string) {
  const dir = join(w.dir, 'send-drops', 'hooks', 'routine'); fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, id); fs.writeFileSync(path, JSON.stringify({ from: 'lead', ts: NOW.toISOString(), thread: id, body: 'synthetic webhook body' })); return path;
}
/** The signed record a send stages; a published arrival is held to it. */
function sealedDrop(w: World, id: string) {
  const dir = join(w.dir, 'send-drops', 'hooks', 'routine'); fs.mkdirSync(dir, { recursive: true });
  const payload: RecordPayload = {
    kind: 'message', id, to: 'routine', to_id: null, root: w.root, session: 'hooks',
    at: NOW.toISOString(), body: 'synthetic webhook body', from: 'lead', from_id: null,
    rule: 'fixture', thread: id,
  };
  const path = join(dir, id); fs.writeFileSync(path, JSON.stringify(signRecord(payload, w.home), null, 2)); return path;
}
function input(id: string, kind: EventAppendInput['kind'] = 'message.arrived'): EventAppendInput {
  return { kind, ts: NOW.toISOString(), session: 'hooks', record_id: id, from: 'lead', to: 'routine' };
}
function event(w: World, id: string): SignedEventRecord {
  const result = appendEvent('hook-scene', w.root, w.home, input(id));
  if (!result.ok) throw new Error(result.reason); return result.record;
}
async function until(check: () => boolean, budget = 2000) {
  const end = performance.now() + budget; while (!check()) {
    if (performance.now() >= end) throw new Error('the synthetic receiver did not observe the expected request');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
type Post = { at: number; method: string; authorization: string | null; body: string };
function receiver(reply: (request: Request, posts: Post[]) => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  const posts: Post[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: async request => { posts.push({ at: performance.now(), method: request.method, authorization: request.headers.get('authorization'), body: await request.text() }); return reply(request, posts); },
    error: () => new Response('synthetic failure', { status: 500 }),
  }); receivers.push(server);
  return { posts, server, url: 'http://127.0.0.1:' + server.port + '/synthetic-webhook' };
}
function use(w: World, url: string) { fs.writeFileSync(w.webhook.urlFile, url + '\n'); }
function bodyAndLogs(w: World, reports: string[] = []) {
  const read = readEvents('hook-scene', w.root, w.home); if (!read.ok) throw new Error(read.reason);
  const logPath = join(w.dir, 'team.log'); return JSON.stringify(read.events) + reports.join('\n') + (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');
}
async function bus(w: World, stderr: (text: string) => void = () => {}) {
  const result = await startBus({ root: w.root, home: w.home, team: load(w), stderr, reconcileIntervalMs: 0 });
  expect(result.kind).toBe('serving'); if (result.kind !== 'serving') throw new Error('synthetic bus did not start');
  buses.push(result.handle); return result.handle;
}

test('team config set accepts absolute URL and secret file paths and persists paths only', async () => {
  const w = world(); const { io, team } = await configure(w);
  expect(team.seats.find(seat => seat.name === 'routine')!.webhook).toEqual(w.webhook);
  const stored = fs.readFileSync(join(w.dir, 'team.yaml'), 'utf8');
  expect(stored).toContain(w.webhook.urlFile); expect(stored).toContain(w.webhook.secretFile);
  expect(stored + io.out + io.err).not.toContain(w.secret);
});
for (const key of ['url_file', 'secret_file']) {
  test('team config set refuses a relative ' + key + ' without changing the file', async () => {
    const w = world(); const before = fs.readFileSync(join(w.dir, 'team.yaml'), 'utf8');
    const io = testIo(w.root, { kind: 'owner' }); io.env = { HOME: w.home }; io.stdinIsTTY = true;
    const value = { url_file: w.webhook.urlFile, secret_file: w.webhook.secretFile, [key]: 'relative-value' };
    expect(await runConfig(['set', 'seats.routine.webhook', JSON.stringify(value)], io, { home: w.home, env: { HOME: w.home }, present: false })).toBe(1);
    expect(io.out + io.err).toContain('absolute'); expect(fs.readFileSync(join(w.dir, 'team.yaml'), 'utf8')).toBe(before);
  });
}
test('the actual bus posts each accepted published arrival once, with the secret only in its header', async () => {
  const w = world(); const held = receiver(); use(w, held.url); await configure(w); await bus(w);
  const path = sealedDrop(w, 'published-one'); const before = fs.readFileSync(path, 'utf8');
  const first = await publishToBus(w.root, input('published-one')); expect(first.kind).toBe('published');
  await until(() => held.posts.length === 1);
  expect(held.posts[0]!.method).toBe('POST'); expect(held.posts[0]!.authorization).toBe('Bearer ' + w.secret);
  expect(JSON.parse(held.posts[0]!.body)).toMatchObject({ v: 1, event: { payload: { kind: 'message.arrived', record_id: 'published-one', to: 'routine' } } });
  expect(held.posts[0]!.body + bodyAndLogs(w)).not.toContain(w.secret); expect(fs.readFileSync(path, 'utf8')).toBe(before);
  const again = await publishToBus(w.root, input('published-one')); expect(again.kind).toBe('published');
  if (again.kind === 'published') expect(again.duplicate).toBe(true);
  await publishToBus(w.root, input('published-one:read', 'message.read'));
  await new Promise(resolve => setTimeout(resolve, 50)); expect(held.posts).toHaveLength(1);
});
test('startup and later reconciliation each post an unseen arrival once', async () => {
  const w = world(); const held = receiver(); use(w, held.url); await configure(w); sealedDrop(w, 'startup-one'); sealedDrop(w, 'startup-two');
  const owned = await bus(w); await until(() => held.posts.length === 2);
  expect(await owned.reconcileNow()).toEqual([]); sealedDrop(w, 'later-one'); await owned.reconcileNow();
  await until(() => held.posts.length === 3); expect(await owned.reconcileNow()).toEqual([]);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(held.posts.map(post => JSON.parse(post.body).event.payload.record_id).sort()).toEqual(['later-one', 'startup-one', 'startup-two']);
});
for (const status of [200, 202, 299]) {
  test('HTTP ' + status + ' is delivered after one loopback POST', async () => {
    const w = world(); const held = receiver(() => new Response('synthetic answer', { status })); use(w, held.url);
    const path = drop(w, 'success'); const before = fs.readFileSync(path, 'utf8'); const reports: string[] = [];
    const outcome = await delivery().deliverWebhook({ seat: 'routine', webhook: w.webhook, record: event(w, 'success'), report: text => reports.push(text) });
    expect(outcome).toBe('delivered'); expect(held.posts).toHaveLength(1); expect(reports).toEqual([]);
    expect(held.posts[0]!.body + bodyAndLogs(w, reports)).not.toContain(w.secret); expect(fs.readFileSync(path, 'utf8')).toBe(before);
  });
}
test('non-2xx is reported once and never asked again, and the drop is preserved', async () => {
  const w = world(); const held = receiver(() => new Response('synthetic rejection', { status: 503 })); use(w, held.url);
  const path = drop(w, 'rejected'); const before = fs.readFileSync(path, 'utf8'); const reports: string[] = [];
  expect(await delivery().deliverWebhook({ seat: 'routine', webhook: w.webhook, record: event(w, 'rejected'), report: text => reports.push(text) })).toBe('failed');
  // The routine answered: the body reached it, so a second POST could start a second run.
  expect(held.posts).toHaveLength(1);
  expect(reports.join('\n')).toContain('after 1 attempt'); expect(reports.join('\n')).toContain('HTTP 503');
  expect(held.posts.map(post => post.body).join('') + bodyAndLogs(w, reports)).not.toContain(w.secret);
  expect(fs.readFileSync(path, 'utf8')).toBe(before);
}, 20_000);
test('a timeout is one request, reported as sent with its response unknown, and never a retry', async () => {
  const w = world(); const waits: number[] = []; const reports: string[] = []; let attempts = 0;
  const held = receiver(() => new Promise<Response>(resolve => releases.push(() => resolve(new Response('released')))));
  use(w, held.url);
  const path = drop(w, 'timeout'); const before = fs.readFileSync(path, 'utf8');
  const realFetch: typeof fetch = ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => { attempts += 1; return fetch(url, init); }) as typeof fetch;
  const outcome = await delivery().deliverWebhook({ seat: 'routine', webhook: w.webhook, record: event(w, 'timeout'),
    policy: { timeoutMs: 80 }, fetch: realFetch, sleep: async ms => { waits.push(ms); }, report: text => reports.push(text) });
  // The body may have reached the routine before the bound: no second POST, no wait.
  expect(outcome).toBe('sent-unknown'); expect(attempts).toBe(1); expect(waits).toEqual([]);
  expect(held.posts).toHaveLength(1);
  expect(reports.join('\n')).toContain('sent, response unknown'); expect(reports.join('\n')).toContain('not retried');
  expect(bodyAndLogs(w, reports)).not.toContain(w.secret);
  expect(fs.readFileSync(path, 'utf8')).toBe(before);
}, 10_000);
test('a refused connection is retried three times with the policy backoff and reported failed', async () => {
  const w = world(); const waits: number[] = []; const reports: string[] = []; let attempts = 0;
  const held = receiver(); use(w, held.url); held.server.stop(true);
  const path = drop(w, 'no-connection'); const before = fs.readFileSync(path, 'utf8');
  const realFetch: typeof fetch = ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => { attempts += 1; return fetch(url, init); }) as typeof fetch;
  const outcome = await delivery().deliverWebhook({ seat: 'routine', webhook: w.webhook, record: event(w, 'no-connection'),
    policy: { timeoutMs: 80 }, fetch: realFetch, sleep: async ms => { waits.push(ms); }, report: text => reports.push(text) });
  // The request provably never left: every attempt was made, and the last one is the report.
  expect(outcome).toBe('failed'); expect(attempts).toBe(3); expect(waits).toEqual([1000, 4000]);
  expect(reports.join('\n')).toContain('after 3 attempts'); expect(reports.join('\n')).toContain('could not connect (');
  expect(bodyAndLogs(w, reports)).not.toContain(w.secret);
  expect(fs.readFileSync(path, 'utf8')).toBe(before);
}, 10_000);


for (const file of ['url', 'secret'] as const) {
  for (const variant of ['symlink', 'directory', 'empty', 'control'] as const) {
    test('the ' + file + ' ' + variant + ' refusal is plain and never echoes values', async () => {
      const w = world(); const key = file === 'url' ? 'urlFile' : 'secretFile';
      let forbidden = file === 'url' ? fs.readFileSync(w.webhook.urlFile, 'utf8').trim() : w.secret;
      if (variant === 'symlink') {
        const target = w.webhook[key]; const link = join(w.base, 'link-value'); fs.symlinkSync(target, link); w.webhook[key] = link;
      } else if (variant === 'directory') {
        const path = join(w.base, 'directory-value'); fs.mkdirSync(path); w.webhook[key] = path;
      } else if (variant === 'empty') fs.writeFileSync(w.webhook[key], '');
      else {
        forbidden = file === 'url' ? 'http://127.0.0.1/hidden-control-A\rhidden-control-B' : 'hidden-control-A\nhidden-control-B';
        fs.writeFileSync(w.webhook[key], forbidden);
      }
      const route = routeApi?.webhookRouteOf(w.webhook); expect(route?.ok).toBe(false);
      if (!route || route.ok) throw new Error('expected a refused route');
      expect(route.reason.toLowerCase()).toContain(variant === 'symlink' ? 'unreadable' : variant === 'directory' ? 'directory' : variant === 'empty' ? 'empty' : 'control');
      const reports: string[] = [];
      expect(await delivery().deliverWebhook({ seat: 'routine', webhook: w.webhook, record: event(w, 'refused'), report: text => reports.push(text) })).toBe('refused');
      for (const text of [route.reason, ...reports]) {
        expect(text).not.toContain(w.secret);
        if (variant !== 'empty') expect(text).not.toContain(forbidden);
        expect(text).not.toContain('hidden-control-A'); expect(text).not.toContain('hidden-control-B');
      }
    });
  }
}
for (const mode of [0o640, 0o604]) {
  test('group/other mode ' + mode.toString(8) + ' is refused without showing the secret', async () => {
    const w = world(); const path = join(w.base, 'mode-value'); fs.writeFileSync(path, w.secret + '\n', { mode, flag: 'wx' }); w.webhook.secretFile = path;
    expect(fs.statSync(path).mode & 0o777).toBe(mode);
    const route = routeApi?.webhookRouteOf(w.webhook); expect(route?.ok).toBe(false);
    if (!route || route.ok) throw new Error('expected mode refusal');
    expect(route.reason).toContain('group or others'); expect(route.reason).toContain('0' + mode.toString(8)); expect(route.reason).not.toContain(w.secret);
  });
}
for (const value of ['http://synthetic-user:synthetic-password@127.0.0.1:1/private-path', 'ftp://127.0.0.1/unsupported-path']) {
  test('an unsafe URL is refused in plain words with no URL value echoed: ' + value.split(':')[0], () => {
    const w = world(); fs.writeFileSync(w.webhook.urlFile, value + '\n');
    const route = routeApi?.webhookRouteOf(w.webhook); expect(route?.ok).toBe(false);
    if (!route || route.ok) throw new Error('expected URL refusal');
    expect(route.reason).toMatch(/credentials|http\(s\)/); expect(route.reason).not.toContain(value);
    expect(route.reason).not.toContain('synthetic-password'); expect(route.reason).not.toContain('private-path');
  });
}
for (const file of ['url', 'secret'] as const) {
  test('a ' + file + ' FIFO refuses quickly in both the route reader and actual bus fan-out', async () => {
    const w = world(); const fifo = join(w.base, 'fifo-value');
    execFileSync('python3', ['-c', 'import os,sys; os.mkfifo(sys.argv[1], 0o600)', fifo]);
    w.webhook[file === 'url' ? 'urlFile' : 'secretFile'] = fifo;
    await configure(w);
    sealedDrop(w, 'fifo-probe');
    const began = performance.now();
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./webhook-fifo-independent-worker.ts', import.meta.url)), JSON.stringify({ root: w.root, home: w.home, webhook: w.webhook })], {
      env: { ...process.env, HOME: w.home }, encoding: 'utf8', timeout: 4000,
    });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0); expect(performance.now() - began).toBeLessThan(3000);
    const result = JSON.parse(child.stdout) as { refused: boolean; reason: string; publish: string; reports: string[] };
    expect(result.refused).toBe(true); expect(result.reason).toContain('FIFO'); expect(result.publish).toBe('published');
    expect(JSON.stringify(result)).not.toContain(w.secret);
  }, 10_000);
}
test('fan-out returns while a real webhook response is pending', async () => {
  const w = world(); const held = receiver(() => new Promise<Response>(resolve => releases.push(() => resolve(new Response('done', { status: 202 })))));
  use(w, held.url); await configure(w); await bus(w); sealedDrop(w, 'pending-response'); let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5); const began = performance.now();
  try {
    const result = await publishToBus(w.root, input('pending-response'), { deadlineMs: 500 });
    expect(result.kind).toBe('published'); expect(performance.now() - began).toBeLessThan(450);
    await until(() => held.posts.length === 1); await new Promise(resolve => setTimeout(resolve, 30)); expect(ticks).toBeGreaterThanOrEqual(2);
  } finally { clearInterval(timer); }
});
test('a refused adapter whose reporter throws cannot throw through publish', async () => {
  const w = world(); fs.writeFileSync(w.webhook.secretFile, ''); await configure(w);
  await bus(w, () => { throw new Error('synthetic reporter failure'); });
  sealedDrop(w, 'reporter-refusal');
  expect((await publishToBus(w.root, input('reporter-refusal'))).kind).toBe('published');
});
test('send dry-run names the actual webhook route and leaves no drop or pane effect', async () => {
  const w = world(); const held = receiver(); use(w, held.url); await configure(w);
  const io = testIo(w.root, { kind: 'owner' }); io.env = { HOME: w.home }; let paneEffects = 0;
  const host: SendHost = { home: w.home, now: () => NOW, socketsDir: join(w.base, 'sockets'),
    agents: () => [{ name: 'routine', pane: 'synthetic-routine', cli: 'codex' }], processInfo: () => null,
    deliver: async () => { paneEffects += 1; return { ok: false, reason: 'synthetic delivery forbidden' }; },
    native: { typeText: () => { paneEffects += 1; return false; }, pressEnter: () => { paneEffects += 1; return false; }, status: () => 'idle', wait: async () => {} },
  };
  expect(await runSend(['routine', 'synthetic dry body', '--dry-run'], io, host), io.err + io.out).toBe(0);
  // No bus serves this world, and the adapter fires only when one announces the record: the
  // preview names the route without claiming a wake the send cannot make.
  expect(io.out).toContain('queued; its webhook fires when the bus takes it');
  expect(io.out).not.toContain('woken through its webhook adapter'); expect(io.out + io.err).not.toContain(w.secret);
  expect(paneEffects).toBe(0); expect(held.posts).toEqual([]); expect(fs.existsSync(join(w.dir, 'send-drops'))).toBe(false);
});
