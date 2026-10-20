// Independent acceptance for the Codex runtime presence source: base f8522304a (and its
// integration fdc457174), same file against the fix fd2fd9202. The transport is a real Unix-socket
// WebSocket JSON-RPC app-server fixture (the frame shapes pinned by the measured capture in the
// source's own test file); the source, mapper and spool writer are production modules. Synthetic
// /private/tmp scene only: no live Codex, pane, session or credential is touched.
//
// The scenes hold the source to the consumer's required answer:
//   - a bound `notLoaded` / `systemError` / unrecognized status is the current measured state, so
//     it holds the seat unproven; it never leaves a previous idle reading healthy;
//   - a working transition whose durable stage fails holds the seat unproven (stage-failed, with
//     the gap made explicit), and a later successful stage returns it to connected;
//   - a reconnect baseline stages the same idle word afresh, so the durable idle-since is the
//     reconnect instant and never the instant before a window whose transitions are missing;
//   - a stream verdict received after `thread/read` was written outranks the baseline snapshot:
//     an unknown status (or a failed stage) is never requalified to connected by the response.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import {
  CODEX_RETRY_MS,
  codexPresenceFor,
  type CodexPresenceSource,
  type CodexPresenceSourceState,
} from '../src/daemon/presence/codex-source.ts';
import { presencePaths } from '../src/daemon/presence/spool.ts';

const SESSION = 'teamcli';
const SEAT = 'builder-4';
const BINDING = 'prs_0123456789ab';
const THREAD = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
const NOW = new Date('2026-10-20T05:00:00.000Z');
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

type Scene = {
  base: string;
  dir: string;
  socketPath: string;
  clock: { at: Date };
};

let live: string | null = null;

afterEach(() => {
  if (live !== null) rmSync(live, { recursive: true, force: true });
  live = null;
});

/** One Codex seat bound to THREAD with a valid presence binding, in a synthetic agents folder. */
function makeScene(): Scene {
  const base = realpathSync(mkdtempSync('/private/tmp/b7-codex-accept-'));
  live = base;
  const dir = join(base, 'acme', '.agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: {
      [SESSION]: {
        seats: { [SEAT]: { id: 'seat_123456789abc', stage: 'ready', presence_binding: BINDING } },
        worktrees: {},
      },
    },
  }, null, 2)}\n`);
  return { base, dir, socketPath: join(base, 'control.sock'), clock: { at: NOW } };
}

/** The durable spool records for the seat, oldest first (record ids start with the event instant). */
function staged(dir: string): { id: string; event: string; ts: string; source: string }[] {
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
  return files.sort().map((path) => JSON.parse(readFileSync(path, 'utf8')) as {
    id: string; event: string; ts: string; source: string;
  });
}

async function waitUntil(what: string, check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type ServerHandle = {
  requests: { method: string; threadId?: string }[];
  push(notification: unknown): void;
  drop(): void;
  close(): Promise<void>;
};

function frame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function frames(buffer: Buffer): { texts: string[]; rest: Buffer } {
  const texts: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset] as number;
    const second = buffer[offset + 1] as number;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      header = 10;
    }
    const mask = masked ? 4 : 0;
    const total = header + mask + length;
    if (offset + total > buffer.length) break;
    const start = offset + header + mask;
    if (opcode === 0x1) {
      if (masked) {
        const key = buffer.subarray(offset + header, offset + header + 4);
        const payload = Buffer.alloc(length);
        for (let i = 0; i < length; i += 1) payload[i] = (buffer[start + i] as number) ^ (key[i % 4] as number);
        texts.push(payload.toString('utf8'));
      } else {
        texts.push(buffer.subarray(start, start + length).toString('utf8'));
      }
    }
    offset += total;
  }
  return { texts, rest: buffer.subarray(offset) };
}

/** A Unix-socket WebSocket JSON-RPC app-server. `threadRead` may push notifications to the open
 *  connection before its response (the baseline race), and its return value is the snapshot. */
async function startAppServer(
  socketPath: string,
  threadRead?: (threadId: string, push: (notification: unknown) => void) => unknown,
): Promise<ServerHandle> {
  const requests: { method: string; threadId?: string }[] = [];
  const open = new Set<Socket>();
  const server: Server = createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => {});
    let buffer: Buffer = Buffer.alloc(0);
    let upgraded = false;
    const push = (notification: unknown): void => {
      if (!socket.destroyed) socket.write(frame(JSON.stringify(notification)));
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
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
      }
      const decoded = frames(buffer);
      buffer = decoded.rest;
      for (const raw of decoded.texts) {
        let message: { id?: unknown; method?: unknown; params?: { threadId?: unknown } };
        try { message = JSON.parse(raw) as typeof message; } catch { continue; }
        if (typeof message.method === 'string' && message.id === undefined) {
          requests.push({ method: message.method });
          continue;
        }
        if (message.id === 'initialize') {
          requests.push({ method: 'initialize' });
          socket.write(frame(JSON.stringify({ id: 'initialize', result: {} })));
        } else if (message.id === 'thread_read') {
          const threadId = typeof message.params?.threadId === 'string' ? message.params.threadId : '';
          requests.push({ method: 'thread/read', threadId });
          const status = threadRead === undefined ? { type: 'idle' } : threadRead(threadId, push);
          socket.write(frame(JSON.stringify({ id: 'thread_read', result: { thread: { id: threadId, status } } })));
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
    requests,
    push: (notification: unknown) => {
      for (const socket of open) if (!socket.destroyed) socket.write(frame(JSON.stringify(notification)));
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

function startSource(scene: Scene, _server: ServerHandle): CodexPresenceSource {
  const started = codexPresenceFor({
    target: {
      stateDir: scene.dir,
      session: SESSION,
      seat: SEAT,
      binding: BINDING,
      threadId: THREAD,
      endpoint: `unix://${scene.socketPath}`,
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

const bound = (status: unknown) => ({
  method: 'thread/status/changed',
  params: { threadId: THREAD, status },
});

const active = bound({ type: 'active', activeFlags: [] });

describe('the Codex presence source keeps every unmeasured state unproven', () => {
  test('a not-loaded, system-error or unrecognized bound status is never the old idle word', async () => {
    const scene = makeScene();
    const server = await startAppServer(scene.socketPath);
    const source = startSource(scene, server);
    try {
      const baseline = await source.step(NOW);
      expect(baseline).toMatchObject({ channel: 'connected', events: 1, baseline: 'read' });
      expect(staged(scene.dir).map((record) => record.event)).toEqual(['turn-end']);

      scene.clock.at = at(1_000);
      server.push(bound({ type: 'notLoaded' }));
      await waitUntil('the notLoaded receipt', () => statusOf(source, scene).ignored === 1);
      expect(statusOf(source, scene)).toMatchObject({
        channel: 'unknown', reason: 'thread-not-loaded', events: 1, evidenceAt: at(1_000).toISOString(),
      });

      scene.clock.at = at(2_000);
      server.push(bound({ type: 'systemError' }));
      await waitUntil('the systemError receipt', () => statusOf(source, scene).ignored === 2);
      expect(statusOf(source, scene)).toMatchObject({
        channel: 'unknown', reason: 'system-error', events: 1, evidenceAt: at(2_000).toISOString(),
      });

      // A status type this build does not know is not working either; it holds the channel with
      // its own reason and does not claim a measured instant.
      scene.clock.at = at(3_000);
      server.push(bound({ type: 'hibernating' }));
      await waitUntil('the unrecognized receipt', () => statusOf(source, scene).ignored === 3);
      expect(statusOf(source, scene)).toMatchObject({
        channel: 'unknown', reason: 'status-unrecognized', events: 1, evidenceAt: at(2_000).toISOString(),
      });
      expect(staged(scene.dir).map((record) => record.event)).toEqual(['turn-end']);
    } finally {
      await source.close();
      await server.close();
    }
  });

  test('a working transition that cannot be staged holds unproven, then recovers on a staged one', async () => {
    const scene = makeScene();
    const server = await startAppServer(scene.socketPath);
    const source = startSource(scene, server);
    const paths = presencePaths(scene.dir, SESSION, SEAT);
    try {
      expect(paths).not.toBeNull();
      await source.step(NOW);
      expect(statusOf(source, scene)).toMatchObject({ channel: 'connected', events: 1 });

      // The spool cannot take a record; the measured turn-start must not leave the old idle word
      // healthy, and the gap is made explicit.
      chmodSync(paths!.spool, 0o500);
      scene.clock.at = at(1_000);
      server.push(active);
      await waitUntil('the failed stage', () => statusOf(source, scene).ignored === 1);
      expect(statusOf(source, scene)).toMatchObject({
        channel: 'unknown', reason: 'stage-failed', gap: true, events: 1,
      });
      expect(staged(scene.dir).map((record) => record.event)).toEqual(['turn-end']);

      // Once the writer can stage again, the same measured transition is accepted and the seat
      // returns to connected: the hold is not sticky.
      chmodSync(paths!.spool, 0o700);
      scene.clock.at = at(2_000);
      server.push(active);
      await waitUntil('the staged turn-start', () => statusOf(source, scene).events === 2);
      expect(statusOf(source, scene)).toMatchObject({ channel: 'connected', reason: null, gap: true });
      // A live event's record instant is its wall-clock receipt, so compare the staged set, not
      // an id order that mixes it with the fixture's baseline clock.
      expect(staged(scene.dir).map((record) => record.event).sort()).toEqual(['turn-end', 'turn-start']);
    } finally {
      try { chmodSync(paths!.spool, 0o700); } catch { /* already restored or removed */ }
      await source.close();
      await server.close();
    }
  });

  test('a reconnect baseline reanchors the same idle word across the gap', async () => {
    const scene = makeScene();
    const server = await startAppServer(scene.socketPath);
    const source = startSource(scene, server);
    try {
      await source.step(NOW);
      const first = staged(scene.dir);
      expect(first.map((record) => record.event)).toEqual(['turn-end']);
      expect(first[0]?.ts).toBe(NOW.toISOString());

      server.drop();
      await waitUntil('the transport loss', () => statusOf(source, scene).channel === 'unknown'
        && statusOf(source, scene).gap === true);

      // The reconnect's baseline says idle again, but the old idle-since instant predates a
      // window whose transitions are missing: it must be staged afresh at the reconnect instant.
      scene.clock.at = new Date(NOW.getTime() + CODEX_RETRY_MS + 1_000);
      const reconnected = await source.step(scene.clock.at);
      expect(reconnected).toMatchObject({ channel: 'connected', gap: true, events: 2 });
      const records = staged(scene.dir);
      expect(records.map((record) => record.event)).toEqual(['turn-end', 'turn-end']);
      expect(records[0]?.ts).toBe(NOW.toISOString());
      expect(records[1]?.ts).toBe(scene.clock.at.toISOString());
      expect(records[1]?.id).not.toBe(records[0]?.id);
    } finally {
      await source.close();
      await server.close();
    }
  });

  test('a newer unknown status is not requalified by the baseline response', async () => {
    const scene = makeScene();
    const server = await startAppServer(scene.socketPath, (_threadId, push) => {
      push(bound({ type: 'notLoaded' }));
      return { type: 'idle' };
    });
    const source = startSource(scene, server);
    try {
      const state = await source.step(NOW);
      // The response proves the attachment (baseline read, stream initialized) but the newer
      // stream verdict is unknown; the baseline snapshot must not overwrite it.
      expect(state).toMatchObject({
        channel: 'unknown', reason: 'thread-not-loaded', baseline: 'read', stream: 'initialized', events: 0,
      });
      expect(staged(scene.dir)).toEqual([]);
    } finally {
      await source.close();
      await server.close();
    }
  });

  test('a failed stage during the baseline race is not requalified either', async () => {
    const scene = makeScene();
    const paths = presencePaths(scene.dir, SESSION, SEAT);
    expect(paths).not.toBeNull();
    mkdirSync(paths!.spool, { recursive: true, mode: 0o700 });
    chmodSync(paths!.spool, 0o500);
    const server = await startAppServer(scene.socketPath, (_threadId, push) => {
      push(active);
      return { type: 'idle' };
    });
    const source = startSource(scene, server);
    try {
      const state = await source.step(NOW);
      expect(state).toMatchObject({
        channel: 'unknown', reason: 'stage-failed', gap: true, baseline: 'read', stream: 'initialized', events: 0,
      });
      expect(staged(scene.dir)).toEqual([]);
    } finally {
      try { chmodSync(paths!.spool, 0o700); } catch { /* already restored or removed */ }
      await source.close();
      await server.close();
    }
  });
});
