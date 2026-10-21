// Independent review probe for the corrected real-sender acceptance at f5aec0e79.
//
// It does not replay those scenes. It drives the production `runSend` with its own fixtures and
// its own Unix app-server, which counts every accepted connection as well as every JSON-RPC
// method, and its own scratch `codex` queue recorder. The claims checked are the corrected ones:
//
// 1. A managed seat's recorded URL is the one endpoint: the live probe reads it and the queue
//    process is handed `unix://<the same path>` verbatim, one connection, initialize then
//    thread/read. A live decoy daemon at the queue process's inherited CODEX_HOME gets no
//    connection at all, so the shared default cannot have been used instead.
// 2-4. A record bound to a predecessor, a managed binding with no record, and unreadable seat
//    state each hold the native leg before either operation: zero connections at the recorded
//    (would-be) endpoint and at the CODEX_HOME default, zero queue invocations, the drop leg takes
//    the send, and the fallback marker names the product's own reason while the history line
//    carries the same message id.
// 5. An unmanaged seat (no presence binding, no record) keeps the measured default: the probe
//    reads and the queue is handed the CODEX_HOME-derived control socket, unchanged.
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
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-20T04:00:00.000Z');
const MESSAGE_ID = '99999999-8888-4777-8666-555555555555';
const THREAD_ID = '019a0000-bbbb-7ccc-8ddd-eeeeffff0000';
const SESSION = 'teamcli';
const SEAT = 'probe-seat';
const BINDING = 'prs_0123456789ab';
const PREDECESSOR = 'prs_ffffffffffff';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

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

/** One team, one Codex seat bound to `THREAD_ID`, delivery order native then drop, a scratch
 *  `codex` recorder first on PATH, and (until a scene adds it) no managed seat state. */
function makeScene(): Scene {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'b4-epl-')));
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
  // The scratch `codex` process records one argv per line (unit-separated) and exits 0; the
  // adapter reads that as queue acceptance. No real CLI is ever invoked.
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

/** Adds managed-launch fields to this fixture's seat state. */
function setSeatState(scene: Scene, extras: Record<string, unknown>): void {
  const path = join(scene.dir, 'team.state.json');
  const state = JSON.parse(readFileSync(path, 'utf8')) as {
    sessions: Record<string, { seats: Record<string, Record<string, unknown>> }>;
  };
  Object.assign(state.sessions[SESSION]!.seats[SEAT]!, extras);
  writeFileSync(path, `${JSON.stringify(state)}\n`);
}

function endpointRecord(socketPath: string, binding: string): Record<string, unknown> {
  return {
    url: `unix://${socketPath}`,
    binding,
    pid: 4242,
    started_at: '2026-10-20T03:59:00.000Z',
  };
}

function codexHomeSocket(scene: Scene): string {
  return join(scene.codexHome, 'app-server-control', 'app-server-control.sock');
}

// ---- the independent app-server: a real Unix-socket WebSocket JSON-RPC recorder --------------

type AppServer = {
  socketPath: string;
  /** Every accepted connection, whether or not it completed a handshake. */
  connections: number;
  methods: { method: string; threadId?: string }[];
  close: () => Promise<void>;
};

/** Unmask and return the client's text frames; the client always masks. */
function clientFrames(buffer: Buffer): { texts: string[]; rest: Buffer } {
  const texts: string[] = [];
  let at = 0;
  while (at + 2 <= buffer.length) {
    const first = buffer[at] as number;
    const second = buffer[at + 1] as number;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (at + 4 > buffer.length) break;
      length = buffer.readUInt16BE(at + 2);
      header = 4;
    } else if (length === 127) {
      if (at + 10 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(at + 2));
      header = 10;
    }
    const maskLen = masked ? 4 : 0;
    const total = header + maskLen + length;
    if (at + total > buffer.length) break;
    if (opcode === 0x1) {
      const start = at + header + maskLen;
      const payload = Buffer.alloc(length);
      if (masked) {
        const mask = buffer.subarray(at + header, at + header + 4);
        for (let i = 0; i < length; i += 1) {
          payload[i] = (buffer[start + i] as number) ^ (mask[i % 4] as number);
        }
      } else {
        buffer.copy(payload, 0, start, start + length);
      }
      texts.push(payload.toString('utf8'));
    }
    at += total;
  }
  return { texts, rest: buffer.subarray(at) };
}

function serverFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

/** A Unix-socket WebSocket JSON-RPC app-server answering the handshake `thread/read` probe
 *  performs, and recording both every connection and every method it was asked. */
async function startAppServer(
  socketPath: string,
  reply: (threadId: string) => unknown,
): Promise<AppServer> {
  const open = new Set<Socket>();
  const rec: AppServer = {
    socketPath,
    connections: 0,
    methods: [],
    close: async () => {},
  };
  const server: Server = createServer((socket) => {
    rec.connections += 1;
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
        const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
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
          rec.methods.push({ method: 'initialize' });
          socket.write(serverFrame(JSON.stringify({ id: 'initialize', result: {} })));
        } else if (msg.id === 'thread_read') {
          const threadId = typeof msg.params?.threadId === 'string' ? msg.params.threadId : '';
          rec.methods.push({ method: 'thread/read', threadId });
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
  rec.close = async () => {
    for (const socket of open) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return rec;
}

function idleAccepting(threadId: string): unknown {
  return { id: threadId, status: { type: 'idle' }, canAcceptDirectInput: true };
}

// ---- the production sender -------------------------------------------------------------------

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

/** Runs one ordinary send through `runSend`; `codexHome` is the value the sender and its queue
 *  child inherit. `server` is closed before returning, as the review harness does. */
async function sendWith(
  scene: Scene,
  server: AppServer,
  codexHome: string = scene.codexHome,
): Promise<{ code: number; out: string; err: string; calls: string[][] }> {
  const io = testIo(scene.root, { kind: 'owner' });
  const savedPath = process.env.PATH;
  const savedHome = process.env.CODEX_HOME;
  const savedLog = process.env.CODEX_QUEUE_LOG;
  process.env.PATH = `${scene.binDir}:${savedPath ?? ''}`;
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_QUEUE_LOG = scene.queueLog;
  let code: number;
  try {
    code = await runSend([SEAT, 'hello'], io, hostFor(scene));
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedHome;
    if (savedLog === undefined) delete process.env.CODEX_QUEUE_LOG;
    else process.env.CODEX_QUEUE_LOG = savedLog;
    await server.close();
  }
  return { code, out: io.out, err: io.err, calls: queueCalls(scene.queueLog) };
}

function pointerOf(scene: Scene): string {
  const pointer = pushPointer(MESSAGE_ID, { seat: 'owner', team: teamIdOf(scene.root) });
  if (pointer === null) throw new Error('the pointer could not be built');
  return pointer;
}

function nativeLine(): string {
  return `team acme, session "${SESSION}"\n${SEAT}: sent (unconfirmed) (native, 0 ms)\n`;
}

function dropLine(): string {
  return `team acme, session "${SESSION}"\n${SEAT}: sent (unconfirmed) (drop, 0 ms)\n`;
}

/** Every witness saw no connection and no method, the queue never ran, and the send fell to the
 *  drop leg under the same id with the product's own reason in the fallback ledger. */
function expectHeld(
  scene: Scene,
  sent: { code: number; out: string; err: string; calls: string[][] },
  reason: string,
  witnesses: AppServer[],
): void {
  expect(sent.code).toBe(0);
  expect(sent.err).toBe('');
  expect(sent.out).toBe(dropLine());
  expect(sent.calls).toEqual([]);
  for (const witness of witnesses) {
    expect(witness.connections).toBe(0);
    expect(witness.methods).toEqual([]);
  }
  const marker = JSON.parse(readFileSync(join(scene.dropDir, `${MESSAGE_ID}.fallback.json`), 'utf8')) as {
    attempts: { route: string; reason: string }[];
  };
  expect(marker.attempts[0]?.route).toBe('native');
  expect(marker.attempts[0]?.reason).toBe(reason);
  expect(marker.attempts[1]?.route).toBe('drop');
  expect(existsSync(join(scene.dropDir, MESSAGE_ID))).toBe(true);
  const history = readHistory('acme', scene.root, scene.home);
  expect(history.ok).toBe(true);
  if (history.ok) {
    expect(history.entries[history.entries.length - 1]?.id).toBe(MESSAGE_ID);
  }
}

describe('the real sender reaches the recorded endpoint, never the shared default', () => {
  test('a managed seat probes and queues its exact recorded URL; the CODEX_HOME decoy sees nothing', async () => {
    const scene = makeScene();
    const recordedSocket = join(scene.base, 'recorded', 'codex-app-server.sock');
    const url = `unix://${recordedSocket}`;
    setSeatState(scene, {
      presence_binding: BINDING,
      codex_endpoint: endpointRecord(recordedSocket, BINDING),
    });
    const recorded = await startAppServer(recordedSocket, idleAccepting);
    const decoyHome = join(scene.base, 'decoy-codex-home');
    const decoy = await startAppServer(
      join(decoyHome, 'app-server-control', 'app-server-control.sock'),
      idleAccepting,
    );
    let sent: Awaited<ReturnType<typeof sendWith>>;
    try {
      sent = await sendWith(scene, decoy, decoyHome);
    } finally {
      await recorded.close();
    }

    expect(sent.code).toBe(0);
    expect(sent.err).toBe('');
    expect(sent.out).toBe(nativeLine());
    // The queue process is handed the record's URL verbatim.
    expect(sent.calls).toEqual([
      ['queue', '--remote', url, '--thread', THREAD_ID, '--message', pointerOf(scene)],
    ]);
    // The probe read the very socket that URL names: one connection, initialize then thread/read.
    expect(recorded.connections).toBe(1);
    expect(recorded.methods).toEqual([
      { method: 'initialize' },
      { method: 'thread/read', threadId: THREAD_ID },
    ]);
    // The inherited shared default was not used, even though a live daemon answered there.
    expect(decoy.connections).toBe(0);
    expect(decoy.methods).toEqual([]);
  });

  test('a predecessor-bound record holds before any connection or queue, and the drop takes it', async () => {
    const scene = makeScene();
    const recordedSocket = join(scene.base, 'recorded', 'codex-app-server.sock');
    setSeatState(scene, {
      presence_binding: BINDING,
      codex_endpoint: endpointRecord(recordedSocket, PREDECESSOR),
    });
    const recorded = await startAppServer(recordedSocket, idleAccepting);
    const decoy = await startAppServer(codexHomeSocket(scene), idleAccepting);
    let sent: Awaited<ReturnType<typeof sendWith>>;
    try {
      sent = await sendWith(scene, decoy, scene.codexHome);
    } finally {
      await recorded.close();
    }
    expectHeld(
      scene,
      sent,
      "the seat's recorded Codex endpoint cannot be used (the endpoint record names another presence binding); refusing the shared app-server path",
      [recorded, decoy],
    );
  });

  test('a managed binding with no record holds instead of guessing a shared endpoint', async () => {
    const scene = makeScene();
    setSeatState(scene, { presence_binding: BINDING });
    const wouldBe = await startAppServer(join(scene.base, 'recorded', 'codex-app-server.sock'), idleAccepting);
    const decoy = await startAppServer(codexHomeSocket(scene), idleAccepting);
    let sent: Awaited<ReturnType<typeof sendWith>>;
    try {
      sent = await sendWith(scene, decoy, scene.codexHome);
    } finally {
      await wouldBe.close();
    }
    expectHeld(
      scene,
      sent,
      'the managed seat records no Codex endpoint its launch wrote; refusing the shared app-server path',
      [wouldBe, decoy],
    );
  });

  test('unreadable seat state holds before any connection or queue, and the drop takes it', async () => {
    const scene = makeScene();
    writeFileSync(join(scene.dir, 'team.state.json'), '{ not json');
    const wouldBe = await startAppServer(join(scene.base, 'recorded', 'codex-app-server.sock'), idleAccepting);
    const decoy = await startAppServer(codexHomeSocket(scene), idleAccepting);
    let sent: Awaited<ReturnType<typeof sendWith>>;
    try {
      sent = await sendWith(scene, decoy, scene.codexHome);
    } finally {
      await wouldBe.close();
    }
    expectHeld(
      scene,
      sent,
      'no trusted runtime session is recorded for this seat (seat state could not be read)',
      [wouldBe, decoy],
    );
  });

  test('an unmanaged seat keeps the measured CODEX_HOME default, unchanged', async () => {
    const scene = makeScene();
    const server = await startAppServer(codexHomeSocket(scene), idleAccepting);
    const sent = await sendWith(scene, server, scene.codexHome);
    expect(sent.code).toBe(0);
    expect(sent.err).toBe('');
    expect(sent.out).toBe(nativeLine());
    expect(sent.calls).toEqual([
      ['queue', '--remote', `unix://${server.socketPath}`, '--thread', THREAD_ID, '--message', pointerOf(scene)],
    ]);
    expect(server.connections).toBe(1);
    expect(server.methods).toEqual([
      { method: 'initialize' },
      { method: 'thread/read', threadId: THREAD_ID },
    ]);
  });
});
