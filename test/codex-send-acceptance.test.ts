// Acceptance: the ordinary send's Codex native route, through `runSend`'s own walk.
//
// A Codex seat's `native` leg is its runtime queue: a bounded live `thread/read` readiness probe
// on the app-server control socket decides, and only an idle thread that explicitly accepts
// direct input is handed one pointer line. The probe and the queue read one endpoint — the
// control socket under `CODEX_HOME` when the queue's process names one — so the probe can never
// vouch for one daemon while the pointer goes to another. Every scene here runs the production
// walk and adapter: only two things are fixtures. The app-server is a real Unix-socket WebSocket
// JSON-RPC server answering `initialize` / `initialized` / `thread/read` in a scratch
// `CODEX_HOME`, and the `codex` process is a scratch recorder placed first on `PATH`, since this
// suite never runs the owner's CLI. Nothing is typed into a pane, and no live session is touched.
//
// Scenes:
// 1. Ready: same bound thread, idle, explicit accepts -> one `codex queue --remote unix://<the
//    probed socket>` line; the send ends `sent (unconfirmed) (native, ...)`, never read, and the
//    staged record, the fallback marker and the history line all carry the one message id.
// 2-4. Would-hold (active thread), a reply for another thread, and an idle thread with no
//    accepts reading: the probe aborts before any queue process, the walk falls back to the drop
//    file, and the same id/record, the native attempt in the fallback marker, and the `failed`
//    reason on the history line are all the production walk's own.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { entitiesPath } from '../src/entities.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { readHistory } from '../src/send/history.ts';
import { pushPointer } from '../src/send/push.ts';
import { recordBody, testIo } from './helpers.ts';

const NOW = new Date('2026-10-20T04:00:00.000Z');
const MESSAGE_ID = '11111111-2222-4333-8444-555555555555';
const THREAD_ID = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
const SESSION = 'teamcli';
const SEAT = 'builder-3';

type Scene = {
  base: string;
  root: string;
  dir: string;
  home: string;
  sockets: string;
  codexHome: string;
  binDir: string;
  queueLog: string;
  dropDir: string;
};

let live: string | null = null;

afterEach(() => {
  if (live !== null) rmSync(live, { recursive: true, force: true });
  live = null;
});

/** One team, one Codex seat bound to `THREAD_ID`, and a delivery order that names the native leg
 *  first with the drop leg behind it — the receiving seat's own chain, read from its file. */
function makeScene(): Scene {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'codex-send-acceptance-')));
  live = base;
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  const codexHome = join(base, 'codex-home');
  const binDir = join(base, 'bin');
  const queueLog = join(base, 'queue.log');
  const lobby = resolveLobby(home, { entity: 'floor' });
  const dropDir = join(dir, 'send-drops', SESSION, SEAT);
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(entitiesPath(home)), { recursive: true });
  writeFileSync(entitiesPath(home), `floor:\n  roots:\n    - ${JSON.stringify(base)}\n`);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(
    join(dir, 'team.yaml'),
    `format: 1
project: acme
entity: floor
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: ${SEAT}
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m gpt-6-sol
delivery_order: [native, drop]
`,
  );
  writeFileSync(
    join(dir, 'team.state.json'),
    `${JSON.stringify({
      format: 1,
      sessions: {
        [SESSION]: {
          seats: {
            [SEAT]: { id: 'seat_123456789abc', stage: 'ready', pane: 'w1:p2', agent_session: THREAD_ID },
          },
          worktrees: {},
        },
      },
    })}\n`,
  );
  registerAgent(home, {
    name: SEAT,
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test',
    cli: 'codex',
    launcher: null,
    launch: 'codex -m gpt-6-sol',
    seat_handle: 'seat_123456789abc',
    reach: {
      team: teamIdOf(root),
      seat: SEAT,
      session: SESSION,
      agent_session: THREAD_ID,
      pane: 'w1:p2',
      address: null,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  // The scratch `codex` process: it records one argv per line (unit-separated) and exits 0,
  // which the adapter reads as queue acceptance. No real CLI is ever invoked.
  writeFileSync(
    join(binDir, 'codex'),
    `#!/bin/sh
{
  for arg in "$@"; do printf '%s\\036' "$arg"; done
  printf '\\n'
} >> "$CODEX_QUEUE_LOG"
exit 0
`,
    { mode: 0o755 },
  );
  return { base, root, dir, home, sockets, codexHome, binDir, queueLog, dropDir };
}

type AppServer = {
  socketPath: string;
  requests: { method: string; threadId?: string }[];
  close: () => Promise<void>;
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

/** The client's frames are masked; unmask and return the text ones. */
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

/** A real Unix-socket WebSocket JSON-RPC app-server: the handshake `queryCodexAppServerThreadRead`
 *  performs, then `initialize` -> `initialized` -> `thread/read`, answering with `reply(id)`. */
async function startAppServer(socketPath: string, reply: (threadId: string) => unknown): Promise<AppServer> {
  const requests: { method: string; threadId?: string }[] = [];
  const open = new Set<Socket>();
  const server: Server = createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => {});
    let buffer: Buffer = Buffer.alloc(0);
    let upgraded = false;
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
        let msg: { id?: unknown; params?: { threadId?: unknown } };
        try {
          msg = JSON.parse(raw) as typeof msg;
        } catch {
          continue;
        }
        if (msg.id === 'initialize') {
          requests.push({ method: 'initialize' });
          socket.write(serverFrame(JSON.stringify({ id: 'initialize', result: {} })));
        } else if (msg.id === 'thread_read') {
          const threadId = typeof msg.params?.threadId === 'string' ? msg.params.threadId : '';
          requests.push({ method: 'thread/read', threadId });
          socket.write(
            serverFrame(JSON.stringify({ id: 'thread_read', result: { thread: reply(threadId) } })),
          );
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
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function hostFor(scene: Scene): SendHost {
  return {
    agents: () => [{ name: SEAT, pane: 'w1:p2', cli: 'codex' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: scene.sockets,
    deliver: async () => {
      throw new Error('no socket leg stands in this order');
    },
    native: {
      typeText: () => {
        throw new Error('no typed leg stands in this order');
      },
      pressEnter: () => false,
      status: () => 'idle',
      wait: async () => {},
      paneText: () => '',
    },
    now: () => NOW,
    home: scene.home,
    sendId: () => MESSAGE_ID,
    inboxGraceMs: 20,
  };
}

function queueCalls(file: string): string[][] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const args = line.split('\x1e');
      if (args[args.length - 1] === '') args.pop();
      return args;
    });
}

/** Runs one ordinary send with `CODEX_HOME` naming the scratch app-server's own home and the
 *  scratch recorder first on `PATH`; both are restored before the assertions run. */
async function sendWith(
  scene: Scene,
  server: AppServer,
): Promise<{ code: number; out: string; err: string; calls: string[][] }> {
  const host = hostFor(scene);
  const io = testIo(scene.root, { kind: 'owner' });
  const saved = {
    path: process.env.PATH,
    codexHome: process.env.CODEX_HOME,
    queueLog: process.env.CODEX_QUEUE_LOG,
  };
  process.env.PATH = `${scene.binDir}:${saved.path ?? ''}`;
  process.env.CODEX_HOME = scene.codexHome;
  process.env.CODEX_QUEUE_LOG = scene.queueLog;
  let code: number;
  try {
    code = await runSend([SEAT, 'hello'], io, host);
  } finally {
    if (saved.path === undefined) delete process.env.PATH;
    else process.env.PATH = saved.path;
    if (saved.codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved.codexHome;
    if (saved.queueLog === undefined) delete process.env.CODEX_QUEUE_LOG;
    else process.env.CODEX_QUEUE_LOG = saved.queueLog;
    await server.close();
  }
  return { code, out: io.out, err: io.err, calls: queueCalls(scene.queueLog) };
}

function lastEntry(scene: Scene): Record<string, unknown> {
  const history = readHistory('acme', scene.root, scene.home);
  if (!history.ok) throw new Error('the history could not be read');
  const entry = history.entries[history.entries.length - 1];
  if (entry === undefined) throw new Error('no history entry');
  return entry as unknown as Record<string, unknown>;
}

function pointerOf(scene: Scene): string {
  const pointer = pushPointer(MESSAGE_ID, { seat: 'owner', team: teamIdOf(scene.root) });
  if (pointer === null) throw new Error('the pointer could not be built');
  return pointer;
}

function markerOf(scene: Scene): Record<string, unknown> {
  return JSON.parse(readFileSync(join(scene.dropDir, `${MESSAGE_ID}.fallback.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** The walk's own ledger for a send the native leg did not take: the native attempt it refused,
 *  then the drop attempt that stored the same record. */
function nativeThenDropAttempts(reason: string): unknown[] {
  return [
    {
      route: 'native',
      outcome: 'unreachable',
      at: NOW.toISOString(),
      ms: 0,
      reason,
      receipt: { id: MESSAGE_ID, kind: 'stored' },
    },
    {
      route: 'drop',
      outcome: 'held',
      at: NOW.toISOString(),
      ms: 0,
      reason: 'the record is stored; no seat was woken',
      receipt: { kind: 'unknown' },
    },
  ];
}

describe('the ordinary send native leg (Codex)', () => {
  test('an idle accepting bound thread takes one queue line on the probed endpoint; the send stays unconfirmed', async () => {
    const scene = makeScene();
    const server = await startAppServer(
      join(scene.codexHome, 'app-server-control', 'app-server-control.sock'),
      (threadId) => ({ id: threadId, status: { type: 'idle' }, canAcceptDirectInput: true }),
    );

    const { code, out, err, calls } = await sendWith(scene, server);

    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toBe(`team acme, session "${SESSION}"\n${SEAT}: sent (unconfirmed) (native, 0 ms)\n`);

    // One queue process, bound to the very socket the probe read, under the same thread.
    expect(calls).toEqual([
      ['queue', '--remote', `unix://${server.socketPath}`, '--thread', THREAD_ID, '--message', pointerOf(scene)],
    ]);
    expect(server.requests).toEqual([
      { method: 'initialize' },
      { method: 'thread/read', threadId: THREAD_ID },
    ]);

    // The staged record is under the one message id; the pointer names that id.
    expect(recordBody(join(scene.dropDir, MESSAGE_ID)).endsWith('hello')).toBe(true);
    expect(pointerOf(scene)).toContain(MESSAGE_ID);

    // The fallback marker records the native attempt as delivered to the queue — transport only.
    const marker = markerOf(scene);
    expect(marker.messageId).toBe(MESSAGE_ID);
    expect(marker.attempts).toEqual([
      expect.objectContaining({
        route: 'native',
        outcome: 'delivered',
        reason: 'pushed to codex queue; no read receipt yet',
      }),
    ]);

    // The history line: native, unconfirmed, no failure, same id.
    const entry = lastEntry(scene);
    expect(entry).toEqual(
      expect.objectContaining({
        id: MESSAGE_ID,
        from: 'owner',
        to: SEAT,
        outcome: 'sent (unconfirmed)',
        via: 'native',
        ms: 0,
      }),
    );
    expect(entry.failed).toBeUndefined();
  });

  test('a would-hold thread skips the queue and falls back to the drop, same id and native attempt recorded', async () => {
    const scene = makeScene();
    const server = await startAppServer(
      join(scene.codexHome, 'app-server-control', 'app-server-control.sock'),
      (threadId) => ({
        id: threadId,
        status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
        canAcceptDirectInput: true,
      }),
    );

    const { code, out, calls } = await sendWith(scene, server);

    expect(code).toBe(0);
    expect(out).toBe(`team acme, session "${SESSION}"\n${SEAT}: sent (unconfirmed) (drop, 0 ms)\n`);
    expect(calls).toEqual([]);

    const reason = `codex thread ${THREAD_ID} is active (waitingOnUserInput); codex queue would hold the message`;
    expect(server.requests).toEqual([
      { method: 'initialize' },
      { method: 'thread/read', threadId: THREAD_ID },
    ]);
    expect(recordBody(join(scene.dropDir, MESSAGE_ID)).endsWith('hello')).toBe(true);
    expect(markerOf(scene).attempts).toEqual(nativeThenDropAttempts(reason));
    const entry = lastEntry(scene);
    expect(entry).toEqual(
      expect.objectContaining({
        id: MESSAGE_ID,
        outcome: 'sent (unconfirmed)',
        via: 'drop',
        failed: [`native: ${reason}`],
      }),
    );
  });

  test('a reply for another thread is not a readiness answer: no queue, drop fallback', async () => {
    const scene = makeScene();
    const server = await startAppServer(
      join(scene.codexHome, 'app-server-control', 'app-server-control.sock'),
      () => ({ id: 'another-thread', status: { type: 'idle' }, canAcceptDirectInput: true }),
    );

    const { code, out, calls } = await sendWith(scene, server);

    expect(code).toBe(0);
    expect(out).toBe(`team acme, session "${SESSION}"\n${SEAT}: sent (unconfirmed) (drop, 0 ms)\n`);
    expect(calls).toEqual([]);

    const reason = `codex app-server answered for thread another-thread, not the bound thread ${THREAD_ID}`;
    expect(markerOf(scene).attempts).toEqual(nativeThenDropAttempts(reason));
    const entry = lastEntry(scene);
    expect(entry.id).toBe(MESSAGE_ID);
    expect(entry.failed).toEqual([`native: ${reason}`]);
  });

  test('an idle thread with no accepts reading is unknown, never ready: no queue, drop fallback', async () => {
    const scene = makeScene();
    const server = await startAppServer(
      join(scene.codexHome, 'app-server-control', 'app-server-control.sock'),
      (threadId) => ({ id: threadId, status: { type: 'idle' } }),
    );

    const { code, out, calls } = await sendWith(scene, server);

    expect(code).toBe(0);
    expect(out).toBe(`team acme, session "${SESSION}"\n${SEAT}: sent (unconfirmed) (drop, 0 ms)\n`);
    expect(calls).toEqual([]);

    const reason = `codex thread ${THREAD_ID} does not report whether it accepts direct input; readiness is unknown`;
    expect(markerOf(scene).attempts).toEqual(nativeThenDropAttempts(reason));
    const entry = lastEntry(scene);
    expect(entry.id).toBe(MESSAGE_ID);
    expect(entry.failed).toEqual([`native: ${reason}`]);
  });
});
