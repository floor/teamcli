// The Codex presence source, against a real Unix-socket WebSocket JSON-RPC app-server.
//
// What is fixture and what is production: the transport, the state machine, the mapper, the spool
// writer and the source.json diagnostic are the production modules; only the app-server is a
// fake. Its frame shapes are the ones measured on this machine on 2026-10-20 with
// `codex-cli 0.161.0` while `codex app-server daemon version` reported app-server `0.163.0`:
//
//   thread/started          {thread:{id:<bound>,status:{type:'idle'},...},...}
//   thread/status/changed   {threadId:<bound>,status:{type:'active',activeFlags:[]}}
//   thread/status/changed   {threadId:<bound>,status:{type:'idle'}}
//   thread/name/updated     {threadId:<bound>,threadName:'...'}
//
// A passive second client (initialize + initialized only; no thread/read, no prompt) received
// those frames for a scratch TUI turn, and also received another thread's lifecycle frames. No
// turn/started, turn/completed or waiting flag arrived: the probe never exercised a wait, so
// those are untested rather than shown to fail, and the source's coverage says so. The thread id
// here is synthetic; the shapes are the measured ones.
//
// Scenes:
// 1. Qualify on a validated baseline; filter exact-thread traffic; dedupe repeated idle; a quiet
//    stream stays healthy with no evidence-age expiry.
// 2. A bound transition received after thread/read was written is never overwritten by the
//    baseline response.
// 3. A transport loss keeps the gap; a reconnect baseline requalifies current state and the gap
//    stays true.
// 4. thread/closed stages session-end, goes terminal gone, and a later socket close cannot
//    downgrade it.
// 5. close stops admissions synchronously while a baseline response is still in flight; the
//    in-flight step settles stopped and no late frame is staged.
// 6. The managed binding changing under a live source stops admissions before a late frame.
// 7. Target resolution: skip when native is not expected, unproven when it is expected and
//    cannot be attached, and the exact target when every piece is present.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import {
  CODEX_RETRY_MS,
  codexPresenceFor,
  codexPresenceTarget,
  type CodexPresenceSource,
  type CodexPresenceSourceState,
} from '../src/daemon/presence/codex-source.ts';
import { presencePaths } from '../src/daemon/presence/spool.ts';

const NOW = new Date('2026-10-19T04:00:00.000Z');
const SESSION = 'teamcli';
const SEAT = 'builder-4';
const BINDING = 'prs_0123456789ab';
const NEXT_BINDING = 'prs_ba9876543210';
const THREAD = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
const OTHER_THREAD = '019a0000-1111-7222-8333-444455556666';

type Scene = {
  base: string;
  root: string;
  dir: string;
  home: string;
  socketPath: string;
  clock: { at: Date };
};

let live: string | null = null;

afterEach(() => {
  if (live !== null) rmSync(live, { recursive: true, force: true });
  live = null;
});

/** One Codex seat bound to THREAD with a valid presence binding. The registry record is only
 *  written where a scene needs the target resolver to consider a native session expected. */
function makeScene(options: { agentSession?: string | null } = {}): Scene {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'codex-presence-source-')));
  live = base;
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeState(dir, { binding: BINDING, agentSession: options.agentSession === undefined ? THREAD : options.agentSession });
  return { base, root, dir, home, socketPath: join(base, 'control.sock'), clock: { at: NOW } };
}

function writeState(
  dir: string,
  options: { binding: string; agentSession?: string | null },
): void {
  const seat: Record<string, unknown> = {
    id: 'seat_123456789abc',
    stage: 'ready',
    presence_binding: options.binding,
  };
  if (options.agentSession !== undefined && options.agentSession !== null) {
    seat.agent_session = options.agentSession;
  }
  writeFileSync(
    join(dir, 'team.state.json'),
    `${JSON.stringify({
      format: 1,
      sessions: { [SESSION]: { seats: { [SEAT]: seat }, worktrees: {} } },
    }, null, 2)}\n`,
  );
}

function registerBoundAgent(scene: Scene): void {
  registerAgent(scene.home, {
    name: SEAT,
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test',
    cli: 'codex',
    launcher: null,
    launch: 'codex -m gpt-6-sol',
    seat_handle: 'seat_123456789abc',
    reach: {
      team: teamIdOf(scene.root),
      seat: SEAT,
      session: SESSION,
      agent_session: THREAD,
      pane: null,
      address: null,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
}

/** The spool's records, sorted by id (which starts with the event instant). */
function spoolRecords(dir: string): { event: string; ts: string; source: string }[] {
  const paths = presencePaths(dir, SESSION, SEAT);
  if (paths === null || !existsSync(paths.spool)) return [];
  const files: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.json')) files.push(path);
    }
  };
  walk(paths.spool);
  return files
    .sort()
    .map((path) => JSON.parse(readFileSync(path, 'utf8')) as { event: string; ts: string; source: string });
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type ServerHandle = {
  socketPath: string;
  requests: { method: string; threadId?: string }[];
  push(notification: unknown): void;
  drop(): void;
  close(): Promise<void>;
};

function serverFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function clientFrames(buffer: Buffer): { texts: string[]; rest: Buffer } {
  const texts: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset] as number;
    const second = buffer[offset + 1] as number;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLen = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }
    const maskLen = masked ? 4 : 0;
    const total = headerLen + maskLen + length;
    if (offset + total > buffer.length) break;
    const start = offset + headerLen + maskLen;
    if (opcode === 0x1) {
      if (masked) {
        const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4);
        const payload = Buffer.alloc(length);
        for (let i = 0; i < length; i += 1) payload[i] = (buffer[start + i] as number) ^ (mask[i % 4] as number);
        texts.push(payload.toString('utf8'));
      } else {
        texts.push(buffer.subarray(start, start + length).toString('utf8'));
      }
    }
    offset += total;
  }
  return { texts, rest: buffer.subarray(offset) };
}

/** A real Unix-socket WebSocket JSON-RPC app-server. `threadRead` may push frames to this
 *  connection before answering, or answer 'hold' to keep the baseline outstanding. */
async function startAppServer(
  socketPath: string,
  options: {
    threadRead?: (threadId: string, handle: { push(notification: unknown): void }) => unknown | 'hold';
    replies?: unknown[];
  } = {},
): Promise<ServerHandle> {
  const requests: { method: string; threadId?: string }[] = [];
  const open = new Set<Socket>();
  const replies = [...(options.replies ?? [])];
  const server: Server = createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => {});
    let buffer: Buffer = Buffer.alloc(0);
    let upgraded = false;
    const push = (notification: unknown): void => {
      if (!socket.destroyed) socket.write(serverFrame(JSON.stringify(notification)));
    };
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 4);
        const key = /^sec-websocket-key:\s*(\S+)\s*$/im.exec(head)?.[1];
        if (key === undefined) {
          socket.destroy();
          return;
        }
        const accept = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        upgraded = true;
      }
      const decoded = clientFrames(buffer);
      buffer = decoded.rest;
      for (const raw of decoded.texts) {
        let msg: { id?: unknown; method?: unknown; params?: { threadId?: unknown } };
        try {
          msg = JSON.parse(raw) as typeof msg;
        } catch {
          continue;
        }
        if (typeof msg.method === 'string' && msg.id === undefined) {
          requests.push({ method: msg.method });
          continue;
        }
        if (msg.id === 'initialize') {
          requests.push({ method: 'initialize' });
          socket.write(serverFrame(JSON.stringify({ id: 'initialize', result: {} })));
        } else if (msg.id === 'thread_read') {
          const threadId = typeof msg.params?.threadId === 'string' ? msg.params.threadId : '';
          requests.push({ method: 'thread/read', threadId });
          const queued = replies.shift();
          const reply = options.threadRead !== undefined
            ? options.threadRead(threadId, { push })
            : (queued ?? { type: 'idle' });
          if (reply !== 'hold') {
            socket.write(
              serverFrame(JSON.stringify({ id: 'thread_read', result: { thread: { id: threadId, status: reply } } })),
            );
          }
        }
      }
    });
  });
  mkdirSync(dirname(socketPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    requests,
    push: (notification: unknown) => {
      for (const socket of open) {
        if (!socket.destroyed) socket.write(serverFrame(JSON.stringify(notification)));
      }
    },
    drop: () => {
      for (const socket of open) socket.destroy();
    },
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function startSource(scene: Scene, server: ServerHandle): CodexPresenceSource {
  const started = codexPresenceFor({
    target: {
      stateDir: scene.dir,
      session: SESSION,
      seat: SEAT,
      binding: BINDING,
      threadId: THREAD,
      endpoint: `unix://${server.socketPath}`,
    },
    policy: 'on',
    feature: true,
    now: () => scene.clock.at,
  });
  if (started.kind !== 'subscribed') throw new Error(`the source refused to start: ${started.why}`);
  return started.source;
}

const statusOf = (source: CodexPresenceSource, scene: Scene): CodexPresenceSourceState =>
  source.status(scene.clock.at);

const active = (threadId = THREAD) => ({
  method: 'thread/status/changed',
  params: { threadId, status: { type: 'active', activeFlags: [] } },
});

const idle = (threadId = THREAD) => ({
  method: 'thread/status/changed',
  params: { threadId, status: { type: 'idle' } },
});

describe('the Codex presence source', () => {
  test('qualifies on a validated baseline, filters the exact thread, and never expires a quiet stream', async () => {
    const scene = makeScene();
    const server = await startAppServer(scene.socketPath);
    try {
      const source = startSource(scene, server);
      const first = await source.step(NOW);
      expect(first.channel).toBe('connected');
      expect(first.stream).toBe('initialized');
      expect(first.baseline).toBe('read');
      expect(first.evidenceAt).toBe(NOW.toISOString());
      expect(first.lastRefreshAt).toBe(NOW.toISOString());
      expect(first.events).toBe(1);
      expect(first.coverage).toEqual({ statusChanged: 'measured', turnFrames: 'unproven', waitingFlags: 'unproven' });
      expect(spoolRecords(scene.dir).map((record) => record.event)).toEqual(['turn-end']);
      expect(server.requests.map((request) => request.method)).toEqual(['initialize', 'initialized', 'thread/read']);

      const paths = presencePaths(scene.dir, SESSION, SEAT);
      expect(paths).not.toBeNull();
      const diagnostic = JSON.parse(readFileSync(join(paths!.root, 'source.json'), 'utf8')) as Record<string, unknown>;
      expect(diagnostic).toMatchObject({
        v: 1,
        session: SESSION,
        seat: SEAT,
        binding: BINDING,
        threadId: THREAD,
        channel: 'connected',
        evidenceAt: NOW.toISOString(),
      });
      expect(Object.keys(diagnostic)).not.toContain('endpoint');

      server.push(active(OTHER_THREAD));
      await waitFor('the other thread to be counted', () => statusOf(source, scene).otherThread === 1);
      expect(statusOf(source, scene).events).toBe(1);
      expect(spoolRecords(scene.dir).map((record) => record.event)).toEqual(['turn-end']);

      scene.clock.at = new Date(NOW.getTime() + 1_000);
      server.push(active());
      await waitFor('the bound active frame', () => statusOf(source, scene).events === 2);
      expect(statusOf(source, scene).evidenceAt).toBe(scene.clock.at.toISOString());
      expect(spoolRecords(scene.dir).map((record) => record.event)).toEqual(['turn-end', 'turn-start']);

      scene.clock.at = new Date(NOW.getTime() + 2_000);
      server.push(idle());
      await waitFor('the bound idle frame', () => statusOf(source, scene).events === 3);
      scene.clock.at = new Date(NOW.getTime() + 3_000);
      server.push(idle());
      await waitFor('the repeated idle receipt', () => statusOf(source, scene).evidenceAt === scene.clock.at.toISOString());
      expect(statusOf(source, scene).events).toBe(3);
      expect(spoolRecords(scene.dir).map((record) => record.event)).toEqual(['turn-end', 'turn-start', 'turn-end']);

      // No polling and no evidence-age expiry: an hour of silence is still a connected channel.
      const quiet = source.status(new Date(NOW.getTime() + 3_600_000));
      expect(quiet.channel).toBe('connected');
      expect(quiet.events).toBe(3);
      expect(server.requests.filter((request) => request.method === 'thread/read')).toHaveLength(1);

      expect(await source.close()).toEqual({ quiesced: true });
      expect(statusOf(source, scene).channel).toBe('stopped');
    } finally {
      await server.close();
    }
  });

  test('a baseline response never overwrites a newer stream transition', async () => {
    const scene = makeScene();
    const server = await startAppServer(scene.socketPath, {
      threadRead: (_threadId, handle) => {
        handle.push(active());
        return { type: 'idle' };
      },
    });
    try {
      const source = startSource(scene, server);
      const state = await source.step(NOW);
      expect(state.channel).toBe('connected');
      expect(state.baseline).toBe('read');
      expect(state.events).toBe(1);
      expect(spoolRecords(scene.dir).map((record) => record.event)).toEqual(['turn-start']);
      expect(await source.close()).toEqual({ quiesced: true });
    } finally {
      await server.close();
    }
  });

  test('a transport loss keeps the gap and a reconnect baseline requalifies', async () => {
    const scene = makeScene();
    const server = await startAppServer(scene.socketPath, {
      replies: [{ type: 'idle' }, { type: 'active', activeFlags: [] }],
    });
    try {
      const source = startSource(scene, server);
      const first = await source.step(NOW);
      expect(first.channel).toBe('connected');
      expect(first.gap).toBe(false);
      expect(first.events).toBe(1);
      const readsBefore = server.requests.filter((request) => request.method === 'thread/read').length;

      server.drop();
      await waitFor('the lost channel', () => statusOf(source, scene).channel === 'unknown');
      const lost = statusOf(source, scene);
      expect(lost.gap).toBe(true);
      expect(lost.stream).toBe('lost');
      expect(lost.baseline).toBe('read');
      expect(lost.reason).toBe('transport-disconnected');

      // Not due yet: step is a read-only answer and opens no socket.
      const early = await source.step(scene.clock.at);
      expect(early.channel).toBe('unknown');
      expect(server.requests.filter((request) => request.method === 'thread/read').length).toBe(readsBefore);

      scene.clock.at = new Date(scene.clock.at.getTime() + CODEX_RETRY_MS + 1);
      const second = await source.step(scene.clock.at);
      expect(second.channel).toBe('connected');
      expect(second.baseline).toBe('read');
      expect(second.gap).toBe(true);
      expect(second.events).toBe(2);
      expect(spoolRecords(scene.dir).map((record) => record.event)).toEqual(['turn-end', 'turn-start']);
      expect(await source.close()).toEqual({ quiesced: true });
    } finally {
      await server.close();
    }
  });

  test('thread/closed stages session-end and gone is terminal across a later socket close', async () => {
    const scene = makeScene();
    const server = await startAppServer(scene.socketPath);
    try {
      const source = startSource(scene, server);
      await source.step(NOW);
      scene.clock.at = new Date(NOW.getTime() + 1_000);
      server.push({ method: 'thread/closed', params: { threadId: THREAD } });
      await waitFor('the gone channel', () => statusOf(source, scene).channel === 'gone');
      const gone = statusOf(source, scene);
      expect(gone.reason).toBe('thread-closed');
      expect(gone.evidenceAt).toBe(scene.clock.at.toISOString());
      expect(spoolRecords(scene.dir).map((record) => record.event)).toEqual(['turn-end', 'session-end']);

      server.drop();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(statusOf(source, scene).channel).toBe('gone');
      const reads = server.requests.filter((request) => request.method === 'thread/read').length;
      await source.step(new Date(scene.clock.at.getTime() + 60_000));
      expect(server.requests.filter((request) => request.method === 'thread/read').length).toBe(reads);

      expect(await source.close()).toEqual({ quiesced: true });
      expect(statusOf(source, scene).channel).toBe('gone');
    } finally {
      await server.close();
    }
  });

  test('close stops admissions synchronously while the baseline is in flight', async () => {
    const scene = makeScene();
    const server = await startAppServer(scene.socketPath, { threadRead: () => 'hold' });
    try {
      const source = startSource(scene, server);
      const pending = source.step(NOW);
      await waitFor('the outstanding baseline', () => server.requests.some((request) => request.method === 'thread/read'));
      expect(statusOf(source, scene).baseline).toBe('pending');

      expect(await source.close()).toEqual({ quiesced: true });
      const settled = await pending;
      expect(settled.channel).toBe('stopped');
      expect(settled.reason).toBe('source-stopped');

      // The key is released only by close: a second start for the same target is accepted now.
      const again = codexPresenceFor({
        target: {
          stateDir: scene.dir,
          session: SESSION,
          seat: SEAT,
          binding: BINDING,
          threadId: THREAD,
          endpoint: `unix://${server.socketPath}`,
        },
        policy: 'on',
        feature: true,
        now: () => scene.clock.at,
      });
      expect(again.kind).toBe('subscribed');
      if (again.kind === 'subscribed') await again.source.close();

      expect(spoolRecords(scene.dir)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test('a changed managed binding stops the source before a late frame is admitted', async () => {
    const scene = makeScene();
    const server = await startAppServer(scene.socketPath);
    try {
      const source = startSource(scene, server);
      await source.step(NOW);
      expect(statusOf(source, scene).events).toBe(1);

      writeState(scene.dir, { binding: NEXT_BINDING, agentSession: THREAD });
      scene.clock.at = new Date(NOW.getTime() + 1_000);
      server.push(active());
      await waitFor('the binding stop', () => statusOf(source, scene).reason === 'binding-changed');
      const stopped = statusOf(source, scene);
      expect(stopped.channel).toBe('unknown');
      expect(stopped.gap).toBe(true);
      expect(stopped.events).toBe(1);
      expect(spoolRecords(scene.dir).map((record) => record.event)).toEqual(['turn-end']);

      server.push(active());
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(statusOf(source, scene).events).toBe(1);
      expect(await source.close()).toEqual({ quiesced: true });
    } finally {
      await server.close();
    }
  });

  test('target resolution skips absent native sources and marks expected-but-unattachable seats unproven', async () => {
    const scene = makeScene({ agentSession: null });
    const unresolved = codexPresenceTarget({
      enabled: true,
      home: scene.home,
      stateDir: scene.dir,
      root: scene.root,
      herdrSession: SESSION,
      session: SESSION,
      seat: { name: SEAT, cli: 'codex' },
      endpoint: `unix://${join(scene.base, 'control.sock')}`,
      codexDaemon: 'on',
    });
    // No registry record at all: native presence is not expected, so a hook/screen fallback is
    // the legitimate answer rather than an unproven seat.
    expect(unresolved.kind).toBe('skip');

    registerBoundAgent(scene);
    const expected = codexPresenceTarget({
      enabled: true,
      home: scene.home,
      stateDir: scene.dir,
      root: scene.root,
      herdrSession: SESSION,
      session: SESSION,
      seat: { name: SEAT, cli: 'codex' },
      endpoint: `unix://${join(scene.base, 'control.sock')}`,
      codexDaemon: 'on',
    });
    expect(expected.kind).toBe('unproven');

    writeState(scene.dir, { binding: BINDING, agentSession: THREAD });
    const off = codexPresenceTarget({
      enabled: true,
      home: scene.home,
      stateDir: scene.dir,
      root: scene.root,
      herdrSession: SESSION,
      session: SESSION,
      seat: { name: SEAT, cli: 'codex' },
      endpoint: `unix://${join(scene.base, 'control.sock')}`,
      codexDaemon: 'off',
    });
    expect(off.kind).toBe('unproven');

    const noEndpoint = codexPresenceTarget({
      enabled: true,
      home: scene.home,
      stateDir: scene.dir,
      root: scene.root,
      herdrSession: SESSION,
      session: SESSION,
      seat: { name: SEAT, cli: 'codex' },
      endpoint: null,
      codexDaemon: 'on',
    });
    expect(noEndpoint.kind).toBe('unproven');

    const target = codexPresenceTarget({
      enabled: true,
      home: scene.home,
      stateDir: scene.dir,
      root: scene.root,
      herdrSession: SESSION,
      session: SESSION,
      seat: { name: SEAT, cli: 'codex' },
      endpoint: `unix://${join(scene.base, 'control.sock')}`,
      codexDaemon: 'on',
    });
    expect(target).toEqual({
      kind: 'target',
      target: {
        stateDir: scene.dir,
        session: SESSION,
        seat: SEAT,
        binding: BINDING,
        threadId: THREAD,
        endpoint: `unix://${join(scene.base, 'control.sock')}`,
      },
    });

    const notCodex = codexPresenceTarget({
      enabled: true,
      home: scene.home,
      stateDir: scene.dir,
      root: scene.root,
      herdrSession: SESSION,
      session: SESSION,
      seat: { name: SEAT, cli: 'claude-code' },
      endpoint: `unix://${join(scene.base, 'control.sock')}`,
      codexDaemon: 'on',
    });
    expect(notCodex.kind).toBe('skip');
  });
});
