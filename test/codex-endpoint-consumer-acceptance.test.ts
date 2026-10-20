// Independent acceptance for the managed Codex endpoint consumer at a14da61d8 (source
// 86ec1242e, shared record helper cc6016621).
//
// Every world is synthetic: a scratch team, a scratch state, a real Unix-socket WebSocket
// app-server answering the readiness probe, and a scratch `codex` process first on PATH that
// records one argv per queue call. No live seat, pane, service, owner home or credential file is
// read, and no real CLI runs.
//
// The scenes cover the one endpoint a managed seat is reached at: the record's exact URL is the
// one probed and the one the queue is handed; an explicit remote naming that same endpoint is
// accepted while one naming another is refused; a record from a predecessor incarnation, a
// malformed record, a record with no current binding, an absent record on a bound seat, an
// unreadable state file and an unreadable team file all hold before any probe connection or
// queue process; and a seat with no binding and no record keeps the measured default endpoint —
// the legacy fallback is only for an unbound seat.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';

import { entitiesPath } from '../src/entities.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { deliverCodexNativeRoute } from '../src/send/push-adapters/codex-relay.ts';
import { pushPointer } from '../src/send/push.ts';

const NOW = new Date('2026-10-20T04:00:00.000Z');
const MESSAGE_ID = '11111111-2222-4333-8444-555555555555';
const THREAD_ID = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
const SESSION = 'teamcli';
const SEAT = 'builder-3';
const RECORD_BINDING = 'prs_0123456789ab';
const PREDECESSOR = 'prs_ffffffffffff';

type Scene = {
  base: string;
  root: string;
  dir: string;
  home: string;
  codexHome: string;
  binDir: string;
  queueLog: string;
  dropDir: string;
};

const live: string[] = [];

afterEach(() => {
  for (const base of live.splice(0)) rmSync(base, { recursive: true, force: true });
});

/** One team, one Codex seat bound to THREAD_ID in the registry and the state, and a scratch
 *  `codex` recorder. The state starts with no managed-launch fields; each scene adds them. */
function makeScene(): Scene {
  const base = realpathSync(mkdtempSync('/private/tmp/b7-codex-endpoint-'));
  live.push(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const codexHome = join(base, 'codex-home');
  const binDir = join(base, 'bin');
  const queueLog = join(base, 'queue.log');
  const lobby = resolveLobby(home, { entity: 'floor' });
  const dropDir = join(dir, 'send-drops', SESSION, SEAT);
  mkdirSync(dir, { recursive: true });
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
  return { base, root, dir, home, codexHome, binDir, queueLog, dropDir };
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

/** A real Unix-socket WebSocket JSON-RPC app-server: `initialize`, then `thread/read` answering
 *  with an idle thread that accepts direct input. */
async function startAppServer(socketPath: string): Promise<AppServer> {
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
          socket.write(serverFrame(JSON.stringify({
            id: 'thread_read',
            result: { thread: { id: threadId, status: { type: 'idle' }, canAcceptDirectInput: true } },
          })));
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

function pointerOf(scene: Scene): string {
  const pointer = pushPointer(MESSAGE_ID, { seat: 'owner', team: teamIdOf(scene.root) });
  if (pointer === null) throw new Error('the pointer could not be built');
  return pointer;
}

function nativeTarget(scene: Scene, remote?: string) {
  return {
    route: 'native' as const,
    runtime: 'codex' as const,
    copy: { dir: scene.dropDir, name: MESSAGE_ID },
    root: scene.root,
    home: scene.home,
    session: SESSION,
    seat: SEAT,
    sender: { seat: 'owner', team: teamIdOf(scene.root) },
    ...(remote === undefined ? {} : { remote }),
  };
}

function nativeAttemptOptions(extra: Record<string, unknown> = {}) {
  return {
    now: () => NOW,
    startedAt: NOW.getTime(),
    routeStartedAt: NOW.getTime(),
    deliveryTimeout: 10_000,
    liveRoutesRemain: true,
    skipStage: true,
    liveProbe: true,
    ...extra,
  };
}

/** Merges managed-launch fields onto the seat's state record, preserving the rest. */
function setSeatFields(scene: Scene, extras: Record<string, unknown>): void {
  const path = join(scene.dir, 'team.state.json');
  const state = JSON.parse(readFileSync(path, 'utf8')) as {
    sessions: Record<string, { seats: Record<string, Record<string, unknown>> }>;
  };
  Object.assign(state.sessions[SESSION]!.seats[SEAT]!, extras);
  writeFileSync(path, `${JSON.stringify(state)}\n`);
}

type SavedEnv = { path?: string; codexHome?: string; queueLog?: string };

function installEnv(scene: Scene): SavedEnv {
  const saved: SavedEnv = {
    path: process.env.PATH,
    codexHome: process.env.CODEX_HOME,
    queueLog: process.env.CODEX_QUEUE_LOG,
  };
  process.env.PATH = `${scene.binDir}:${saved.path ?? ''}`;
  process.env.CODEX_HOME = scene.codexHome;
  process.env.CODEX_QUEUE_LOG = scene.queueLog;
  return saved;
}

function restoreEnv(saved: SavedEnv): void {
  if (saved.path === undefined) delete process.env.PATH;
  else process.env.PATH = saved.path;
  if (saved.codexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved.codexHome;
  if (saved.queueLog === undefined) delete process.env.CODEX_QUEUE_LOG;
  else process.env.CODEX_QUEUE_LOG = saved.queueLog;
}

async function deliver(
  scene: Scene,
  remote?: string,
  extra: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof deliverCodexNativeRoute>>> {
  const saved = installEnv(scene);
  try {
    return await deliverCodexNativeRoute(
      nativeTarget(scene, remote),
      { id: MESSAGE_ID, record: '{}' },
      nativeAttemptOptions(extra),
    );
  } finally {
    restoreEnv(saved);
  }
}

type Attempt = Awaited<ReturnType<typeof deliverCodexNativeRoute>>;
type HeldAttempt = Exclude<Attempt, { outcome: 'enqueue' }>;

/** Narrows a held attempt, failing loudly if the route actually enqueued something. */
function held(attempt: Attempt): HeldAttempt {
  if (attempt.outcome === 'enqueue') throw new Error('expected a hold, but the route enqueued the pointer');
  return attempt;
}

function recordedState(socketPath: string, recordBinding: string, seatBinding: string): Record<string, unknown> {
  return {
    presence_binding: seatBinding,
    codex_endpoint: {
      url: `unix://${socketPath}`,
      binding: recordBinding,
      pid: 4242,
      started_at: '2026-10-20T03:59:00.000Z',
    },
  };
}

const RECORDED = (scene: Scene): string => join(scene.dir, 'state', 'codex-app-server.sock');
const DEFAULT_SOCKET = (scene: Scene): string =>
  join(scene.codexHome, 'app-server-control', 'app-server-control.sock');

describe('the managed Codex endpoint consumer (a14da61d8)', () => {
  test('the recorded endpoint is the one probed and the one the queue is handed', async () => {
    const scene = makeScene();
    const socket = RECORDED(scene);
    setSeatFields(scene, recordedState(socket, RECORD_BINDING, RECORD_BINDING));
    const server = await startAppServer(socket);
    try {
      const attempt = await deliver(scene);
      expect(attempt.outcome).toBe('enqueue');
      expect(server.requests).toEqual([
        { method: 'initialize' },
        { method: 'thread/read', threadId: THREAD_ID },
      ]);
      expect(queueCalls(scene.queueLog)).toEqual([
        ['queue', '--remote', `unix://${socket}`, '--thread', THREAD_ID, '--message', pointerOf(scene)],
      ]);
      // Only the recorded socket could have answered: the inherited CODEX_HOME default was
      // never created, and the queue names the recorded URL itself.
      expect(existsSync(DEFAULT_SOCKET(scene))).toBe(false);
    } finally {
      await server.close();
    }
  });

  test('an explicit remote naming the recorded endpoint exactly is accepted', async () => {
    const scene = makeScene();
    const socket = RECORDED(scene);
    setSeatFields(scene, recordedState(socket, RECORD_BINDING, RECORD_BINDING));
    const server = await startAppServer(socket);
    try {
      const attempt = await deliver(scene, `unix://${socket}`);
      expect(attempt.outcome).toBe('enqueue');
      expect(server.requests).toEqual([
        { method: 'initialize' },
        { method: 'thread/read', threadId: THREAD_ID },
      ]);
      expect(queueCalls(scene.queueLog)).toEqual([
        ['queue', '--remote', `unix://${socket}`, '--thread', THREAD_ID, '--message', pointerOf(scene)],
      ]);
    } finally {
      await server.close();
    }
  });

  test('an explicit remote naming another endpoint is refused before either operation', async () => {
    const scene = makeScene();
    const socket = RECORDED(scene);
    const other = join(scene.base, 'other-app-server.sock');
    setSeatFields(scene, recordedState(socket, RECORD_BINDING, RECORD_BINDING));
    const server = await startAppServer(socket);
    try {
      const attempt = await deliver(scene, `unix://${other}`);
      const refusal = held(attempt);
      expect(refusal.outcome).toBe('unsupported');
      expect(refusal.reason).toContain(`the explicit remote unix://${other} names another endpoint than the seat's recorded unix://${socket}`);
      expect(server.requests).toEqual([]);
      expect(queueCalls(scene.queueLog)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test('a record from a predecessor incarnation holds before any probe or queue', async () => {
    const scene = makeScene();
    const socket = RECORDED(scene);
    setSeatFields(scene, recordedState(socket, PREDECESSOR, RECORD_BINDING));
    const server = await startAppServer(socket);
    try {
      const attempt = await deliver(scene);
      const refusal = held(attempt);
      expect(refusal.outcome).toBe('unreachable');
      expect(refusal.reason).toContain('the endpoint record names another presence binding');
      expect(server.requests).toEqual([]);
      expect(queueCalls(scene.queueLog)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test('malformed records hold: URL, pid, start instant, array and no current binding', async () => {
    const failures: { name: string; fields: Record<string, unknown>; why: string }[] = [
      {
        name: 'url',
        fields: { presence_binding: RECORD_BINDING, codex_endpoint: { url: 'tcp://127.0.0.1:1', binding: RECORD_BINDING, pid: 1, started_at: NOW.toISOString() } },
        why: 'URL is not an absolute unix endpoint',
      },
      {
        name: 'pid',
        fields: { presence_binding: RECORD_BINDING, codex_endpoint: { url: 'unix:///tmp/x.sock', binding: RECORD_BINDING, pid: 0, started_at: NOW.toISOString() } },
        why: 'names no positive integer process',
      },
      {
        name: 'start instant',
        fields: { presence_binding: RECORD_BINDING, codex_endpoint: { url: 'unix:///tmp/x.sock', binding: RECORD_BINDING, pid: 1, started_at: 'yesterday' } },
        why: 'start instant is not a contract timestamp',
      },
      { name: 'array', fields: { presence_binding: RECORD_BINDING, codex_endpoint: [] }, why: 'endpoint record is not an object' },
      {
        name: 'no current binding',
        fields: { codex_endpoint: { url: 'unix:///tmp/x.sock', binding: RECORD_BINDING, pid: 1, started_at: NOW.toISOString() } },
        why: 'the seat records no valid current presence binding',
      },
    ];
    for (const failure of failures) {
      const scene = makeScene();
      setSeatFields(scene, failure.fields);
      const attempt = await deliver(scene);
      const refusal = held(attempt);
      expect({ name: failure.name, outcome: refusal.outcome }).toEqual({ name: failure.name, outcome: 'unreachable' });
      expect({ name: failure.name, reason: refusal.reason }).toEqual({
        name: failure.name,
        reason: expect.stringContaining(failure.why),
      });
      expect({ name: failure.name, queue: queueCalls(scene.queueLog) }).toEqual({ name: failure.name, queue: [] });
    }
  });

  test('a bound managed seat with no recorded endpoint holds instead of guessing a shared one', async () => {
    const scene = makeScene();
    setSeatFields(scene, { presence_binding: RECORD_BINDING });
    const attempt = await deliver(scene);
    const refusal = held(attempt);
    expect(refusal.outcome).toBe('unreachable');
    expect(refusal.reason).toBe(
      'the managed seat records no Codex endpoint its launch wrote; refusing the shared app-server path',
    );
    expect(queueCalls(scene.queueLog)).toEqual([]);
  });

  test('an unreadable state file and an unreadable team file both hold before any queue', async () => {
    const corruptState = makeScene();
    writeFileSync(join(corruptState.dir, 'team.state.json'), '{ this is not json\n');
    const stateAttempt = await deliver(corruptState, undefined, { codexDaemon: 'on' });
    const stateRefusal = held(stateAttempt);
    expect(stateRefusal.outcome).toBe('unreachable');
    expect(stateRefusal.reason).toContain('seat state could not be read');
    expect(queueCalls(corruptState.queueLog)).toEqual([]);

    const corruptTeam = makeScene();
    writeFileSync(join(corruptTeam.dir, 'team.yaml'), 'format: 1\nproject: [\n');
    const teamAttempt = await deliver(corruptTeam, undefined, { codexDaemon: 'on' });
    const teamRefusal = held(teamAttempt);
    expect(teamRefusal.outcome).toBe('unreachable');
    expect(teamRefusal.reason).toContain('the team file could not be read');
    expect(queueCalls(corruptTeam.queueLog)).toEqual([]);
  });

  test('a seat with no binding and no record keeps the measured default endpoint', async () => {
    const scene = makeScene();
    const socket = DEFAULT_SOCKET(scene);
    const server = await startAppServer(socket);
    try {
      const attempt = await deliver(scene);
      expect(attempt.outcome).toBe('enqueue');
      expect(server.requests).toEqual([
        { method: 'initialize' },
        { method: 'thread/read', threadId: THREAD_ID },
      ]);
      expect(queueCalls(scene.queueLog)).toEqual([
        ['queue', '--remote', `unix://${socket}`, '--thread', THREAD_ID, '--message', pointerOf(scene)],
      ]);
    } finally {
      await server.close();
    }
  });
});
