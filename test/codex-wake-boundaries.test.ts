// Independent synthetic send scenes: an active runtime, webhook-only routing and a real local bus.
// process.kill is fenced before each scene; no signal or real CLI can leave this file.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startBus, type BusHandle } from '../src/bus/server.ts';
import { makeWebhookDelivery } from '../src/bus/webhook.ts';
import { runSend } from '../src/commands/send.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { fake, owner, world, type World } from './send-native-fixtures.ts';

const thread = '019b1234-5678-7000-8000-123456789abc';
const id = '614bf319-80c6-4dc7-9661-807d7ac38b08';
let at: World, short: string;
let bus: BusHandle | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let saved: Record<string, string | undefined>;
let kill: ReturnType<typeof spyOn<typeof process, 'kill'>>;
const keys = ['PATH', 'CODEX_HOME', 'WAKE_QUEUE_LOG', 'WAKE_QUEUE_EXIT'];
beforeEach(() => {
  kill = spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal !== 0) throw new Error(`signal blocked: ${pid} ${String(signal)}`);
    return true;
  });
  saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  at = world(['native', 'drop']);
  short = mkdtempSync('/tmp/wake-proof-');
  mkdirSync(join(short, 'bin')); mkdirSync(join(short, 'app-server-control'));
  process.env.CODEX_HOME = short;
  process.env.WAKE_QUEUE_LOG = join(short, 'queue.jsonl');
  process.env.WAKE_QUEUE_EXIT = '0';
  const program = join(short, 'queue.ts');
  writeFileSync(program, `import {appendFileSync} from 'node:fs'; appendFileSync(process.env.WAKE_QUEUE_LOG!, JSON.stringify(process.argv.slice(2))+'\\n'); process.exit(Number(process.env.WAKE_QUEUE_EXIT));`);
  writeFileSync(join(short, 'bin', 'codex'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${program}' "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${join(short, 'bin')}:${saved.PATH ?? ''}`;
  updateState(at.dir, state => {
    const session = state.sessions.acme ??= emptySession();
    session.seats.native = { stage: 'ready', id: 'seat_222222222222', pane: 'fixture-pane', agent_session: thread };
  });
  registerAgent(at.home, {
    name: 'native', signing: { model: 'Test', version: '1', role: 'reviewer' }, lab: 'test', cli: 'codex', launcher: null,
    launch: 'codex -m test', seat_handle: 'seat_222222222222',
    reach: { team: teamIdOf(at.root), seat: 'native', session: 'acme', agent_session: thread, pane: 'fixture-pane', address: null },
    mcp: [], skills: [], lifecycle: 'running', by: 'owner',
  });
});
afterEach(async () => {
  if (bus) await bus.close(); bus = undefined;
  if (server) await server.stop(true); server = undefined;
  for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  kill.mockRestore();
  at.cleanup(); rmSync(short, { recursive: true, force: true });
});
function hook(dropOnly = false) {
  const url = join(short, 'hook-url'), secret = join(short, 'hook-secret');
  writeFileSync(url, 'http://127.0.0.1:1/synthetic-only\n');
  writeFileSync(secret, 'fixture-only-secret\n', { mode: 0o600 });
  const file = join(at.dir, 'team.yaml');
  let text = readFileSync(file, 'utf8').replace('    launch: codex -m test\n',
    `    launch: codex -m test\n    webhook:\n      url_file: ${JSON.stringify(url)}\n      secret_file: ${JSON.stringify(secret)}\n`);
  if (dropOnly) text = text.replace('delivery_order: [native, drop]', 'delivery_order: [drop]');
  writeFileSync(file, text);
}
function appServer() {
  const reads: unknown[] = [];
  server = Bun.serve({
    unix: join(short, 'app-server-control', 'app-server-control.sock'),
    fetch(req, srv) { if (srv.upgrade(req, { data: undefined })) return; return new Response('upgrade required', { status: 400 }); },
    websocket: { message(ws, message) {
      const rpc = JSON.parse(String(message));
      if (rpc.method === 'initialize') ws.send(JSON.stringify({ id: rpc.id, result: {} }));
      if (rpc.method === 'thread/read') {
        reads.push(rpc.params);
        ws.send(JSON.stringify({ id: rpc.id, result: { thread: { id: rpc.params.threadId,
          status: { type: 'active', activeFlags: ['waitingOnUserInput'] }, canAcceptDirectInput: true } } }));
      }
    } },
  });
  return reads;
}
async function send(ending = 'sent (unconfirmed)') {
  const io = owner(at.root);
  const host = fake(at, {
    sendId: () => id, inboxGraceMs: 5,
    agents: () => [{ name: 'native', pane: 'fixture-pane', cli: 'codex' }],
    native: { typeText: () => { throw new Error('typing blocked'); }, pressEnter: () => { throw new Error('Enter blocked'); },
      status: () => 'working', wait: async () => {}, paneText: () => '' },
  });
  const code = await runSend(['native', 'independent wake body'], io, host);
  expect(code, io.err).toBe(0);
  expect(io.out).toContain(ending);
  const drop = join(at.dir, 'send-drops', 'acme', 'native', id);
  expect(existsSync(drop)).toBe(true);
  expect(existsSync(`${drop}.read.json`)).toBe(false);
  expect(readFileSync(drop, 'utf8')).toContain('independent wake body');
  return io;
}
function calls(): string[][] {
  return existsSync(process.env.WAKE_QUEUE_LOG!) ? readFileSync(process.env.WAKE_QUEUE_LOG!, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}
for (const withHook of [false, true]) test(`an active Codex runtime accepts exactly one pointer${withHook ? ' beside an unused webhook' : ''}`, async () => {
  if (withHook) hook();
  const reads = appServer();
  const io = await send();
  expect(reads).toEqual([{ threadId: thread, includeTurns: false }]);
  expect(calls()).toEqual([[ 'queue', '--remote', `unix://${join(short, 'app-server-control', 'app-server-control.sock')}`, '--thread', thread, '--message', expect.stringContaining(id) ]]);
  expect(io.out).toContain('woken through its runtime queue');
  expect(io.out).not.toContain('queued; its webhook fires');
});
test('webhook-only Codex without a bus keeps the unread drop and makes no wake claim', async () => {
  hook(true);
  const io = await send('queued, not woken');
  expect(calls()).toEqual([]);
  expect(io.out).toContain('queued; its webhook fires when the bus takes it');
  expect(io.out).not.toContain('woken through');
});
test('a real bus announces the Codex drop once to its synthetic webhook', async () => {
  hook(true);
  const loaded = readTeamConfig(at.root, { home: at.home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const posts: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return new Response(null, { status: 204 });
  }) as typeof fetch;
  const result = await startBus({ root: at.root, home: at.home, team: loaded.team, stderr: () => {},
    reconcileIntervalMs: 3_600_000, deliver: makeWebhookDelivery({ team: loaded.team, fetch: fetcher }) });
  expect(result.kind).toBe('serving');
  if (result.kind !== 'serving') throw new Error('synthetic bus did not start');
  bus = result.handle;
  const io = await send('queued, not woken');
  // The bus takes the arrival and posts it. The send's own webhook post was tried first and
  // provably failed (the fixture's closed port), so the released claim lets the bus carry it and
  // the line keeps the queued words.
  expect(io.out).toContain('queued; its webhook fires when the bus takes it');
  expect(io.out).not.toContain('woken through its event adapter');
  expect(posts).toHaveLength(1);
  expect(posts[0]?.body).toEqual(expect.objectContaining({ event: expect.objectContaining({ payload: expect.objectContaining({ kind: 'message.arrived', to: 'native', record_id: id }) }) }));
  expect(calls()).toEqual([]);
});
test('a refused native queue beside a bus-less webhook reports the remaining route', async () => {
  hook(); appServer(); process.env.WAKE_QUEUE_EXIT = '1';
  const io = await send('queued, not woken');
  expect(calls()).toHaveLength(1);
  expect(io.out).toContain('(drop,');
  expect(io.out).toContain('queued; its webhook fires when the bus takes it');
  expect(io.out).not.toContain('woken through its runtime queue');
});
