// `team reply` delivers through the same walk a send makes, including the legs that belong to
// the receiving runtime: a Codex seat's own runtime queue and a Gemini/Cursor headless resume.
// Every scene here is synthetic: the app-server is a scratch Unix-socket WebSocket JSON-RPC
// server, the `codex` process is a scratch recorder on `PATH`, and the headless resume is an
// injected spawn. No owner CLI home is read, no live session is touched, and nothing is typed
// into a pane.
//
// The scenes are the measured gap's: before the shared walk, a reply to a Codex seat walked the
// typed leg first, refused on a working screen, and left the record in the mailbox, while a send
// to the same seat queued one pointer line. They now share the one order resolution.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { plantRecord } from '../src/commands/messages.ts';
import { runReply, type ReplyHost } from '../src/commands/reply.ts';
import type { SendHost } from '../src/commands/send.ts';
import { entitiesPath } from '../src/entities.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { readHistory } from '../src/send/history.ts';
import type { HeadlessResumeSpawn } from '../src/send/push-adapters.ts';
import { pushPointer } from '../src/send/push.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-04T04:00:00.000Z');
const SENT = '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d';
const REPLY = '3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const THREAD_ID = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
const AGENT_SESSION = 'ses_gemini_019a0000';
const SESSION = 'acme';
const CLAUDE_SKIP = "unavailable; the native leg is the sending session's own SendMessage";

type Scene = {
  base: string;
  root: string;
  dir: string;
  home: string;
  sockets: string;
  codexHome: string;
  binDir: string;
  queueLog: string;
  seat: string;
  cli: string;
};

let live: string | null = null;
afterEach(() => {
  if (live !== null) rmSync(live, { recursive: true, force: true });
  live = null;
});

/** One team and one receiving seat. A Codex or Gemini seat gets the state row and the registry
 *  record that bind its runtime session; a Claude Code seat needs neither. The scratch `codex`
 *  process records one unit-separated argv per line and exits 0 — queue acceptance — and is
 *  never a real CLI. */
function makeScene(config: {
  seat: string;
  cli: 'codex' | 'gemini' | 'claude-code';
  launch: string;
  order: readonly string[] | null;
  agentSession?: string;
}): Scene {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'reply-walks-native-')));
  live = base;
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  const codexHome = join(base, 'codex-home');
  const binDir = join(base, 'bin');
  const queueLog = join(base, 'queue.log');
  const lobby = resolveLobby(home, { entity: 'floor' });
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
    name: ${config.seat}
    cli: ${config.cli}
    vendor: test
    model: Test
    version: "1"
    launch: ${config.launch}
${config.order === null ? '' : `delivery_order: [${config.order.join(', ')}]\n`}`,
  );
  if (config.agentSession !== undefined) {
    writeFileSync(
      join(dir, 'team.state.json'),
      `${JSON.stringify({
        format: 1,
        sessions: {
          [SESSION]: {
            seats: {
              [config.seat]: {
                id: 'seat_123456789abc',
                stage: 'ready',
                pane: 'fixture-pane-1',
                agent_session: config.agentSession,
              },
            },
            worktrees: {},
          },
        },
      })}\n`,
    );
    registerAgent(home, {
      name: config.seat,
      signing: { model: 'Test', version: '1', role: 'implementer' },
      lab: 'test',
      cli: config.cli,
      launcher: null,
      launch: config.launch,
      seat_handle: 'seat_123456789abc',
      reach: {
        team: teamIdOf(root),
        seat: config.seat,
        session: SESSION,
        agent_session: config.agentSession,
        pane: 'fixture-pane-1',
        address: null,
      },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'owner',
    });
  }
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
  return { base, root, dir, home, sockets, codexHome, binDir, queueLog, seat: config.seat, cli: config.cli };
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

type AppServer = {
  socketPath: string;
  requests: { method: string; threadId?: string }[];
  close: () => Promise<void>;
};

/** A real Unix-socket WebSocket JSON-RPC app-server: the handshake the probe performs, then
 *  `initialize` -> `initialized` -> `thread/read`, answering with `reply(threadId)`. */
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
          socket.write(serverFrame(JSON.stringify({ id: 'thread_read', result: { thread: reply(threadId) } })));
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

/** The sending side of a reply: no live pane unless the scene gives one, no socket leg, and the
 *  same bounded grace a send uses. The typed pane mock throws when reached, so a scene proves
 *  the leg was never attempted by passing at all. */
function hostFor(scene: Scene, patch: Partial<SendHost> = {}): SendHost {
  return {
    agents: () => [],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: scene.sockets,
    deliver: async () => ({ ok: false, reason: 'no socket leg stands in this order' }),
    native: {
      typeText: () => {
        throw new Error('the typed leg must not run in this scene');
      },
      pressEnter: () => false,
      status: () => 'working',
      wait: async () => {},
      paneText: () => '',
    },
    now: () => NOW,
    home: scene.home,
    inboxGraceMs: 20,
    ...patch,
  };
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
  const pointer = pushPointer(REPLY, { seat: 'owner', team: teamIdOf(scene.root) });
  if (pointer === null) throw new Error('the pointer could not be built');
  return pointer;
}

type Result = { code: number; out: string; err: string };

async function replyTo(scene: Scene, host: SendHost, caller: Caller = { kind: 'owner' }): Promise<Result> {
  const io = testIo(scene.root, caller);
  const replyHost: ReplyHost = { home: scene.home, now: () => NOW, newId: () => REPLY, send: host };
  const code = await runReply([SENT, 'the answer'], io, replyHost);
  return { code, out: io.out, err: io.err };
}

/** The answered record waits in the owner's folder, one message from the receiving seat. */
function sentToOwner(scene: Scene): void {
  plantRecord(scene.home, scene.root, SESSION, 'owner', SENT, 'question from the seat', {
    from: scene.seat,
    at: NOW.toISOString(),
  });
}

function lastEntry(scene: Scene): Record<string, unknown> {
  const history = readHistory(SESSION, scene.root, scene.home);
  if (!history.ok) throw new Error(history.reason);
  const entry = history.entries.at(-1);
  if (entry === undefined) throw new Error('no history entry');
  return entry as unknown as Record<string, unknown>;
}

async function withCodexRuntime(scene: Scene, run: (server: AppServer) => Promise<void>): Promise<void> {
  const server = await startAppServer(
    join(scene.codexHome, 'app-server-control', 'app-server-control.sock'),
    (threadId) => ({ id: threadId, status: { type: 'idle' }, canAcceptDirectInput: true }),
  );
  const saved = installEnv(scene);
  try {
    await run(server);
  } finally {
    restoreEnv(saved);
    await server.close();
  }
}

test('a reply to a Codex seat with no live pane takes its runtime queue, as a send does', async () => {
  const scene = makeScene({ seat: 'native', cli: 'codex', launch: 'codex -m test', order: null, agentSession: THREAD_ID });
  sentToOwner(scene);
  await withCodexRuntime(scene, async (server) => {
    const result = await replyTo(scene, hostFor(scene));

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toMatch(
      /^team acme, session "acme"\nnative: queued to its native runtime \(drop \d+ characters\); no receipt within 20 ms\n$/,
    );
    expect(queueCalls(scene.queueLog)).toEqual([
      ['queue', '--remote', `unix://${server.socketPath}`, '--thread', THREAD_ID, '--message', pointerOf(scene)],
    ]);
    expect(server.requests).toEqual([
      { method: 'initialize' },
      { method: 'thread/read', threadId: THREAD_ID },
    ]);
    expect(lastEntry(scene)).toMatchObject({ id: REPLY, via: 'native', outcome: 'sent (unconfirmed)' });
  });
});

test('a declared [native, drop] order is walked native first by a reply too', async () => {
  const scene = makeScene({
    seat: 'native',
    cli: 'codex',
    launch: 'codex -m test',
    order: ['native', 'drop'],
    agentSession: THREAD_ID,
  });
  sentToOwner(scene);
  await withCodexRuntime(scene, async (server) => {
    const result = await replyTo(scene, hostFor(scene));

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(queueCalls(scene.queueLog)).toEqual([
      ['queue', '--remote', `unix://${server.socketPath}`, '--thread', THREAD_ID, '--message', pointerOf(scene)],
    ]);
    expect(lastEntry(scene)).toMatchObject({ id: REPLY, via: 'native', outcome: 'sent (unconfirmed)' });
  });
});

test('a mid-turn Codex seat is queued through its runtime, never typed at', async () => {
  const scene = makeScene({ seat: 'native', cli: 'codex', launch: 'codex -m test', order: null, agentSession: THREAD_ID });
  sentToOwner(scene);
  await withCodexRuntime(scene, async (server) => {
    const result = await replyTo(
      scene,
      hostFor(scene, {
        agents: () => [{ name: 'native', pane: 'fixture-pane-1', cli: 'codex' }],
      }),
    );

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(queueCalls(scene.queueLog)).toHaveLength(1);
    expect(server.requests).toContainEqual({ method: 'thread/read', threadId: THREAD_ID });
    expect(lastEntry(scene)).toMatchObject({ id: REPLY, via: 'native' });
  });
});

test('a reply to a Gemini seat with no webhook resumes its own session headlessly', async () => {
  const scene = makeScene({
    seat: 'gemini-seat',
    cli: 'gemini',
    launch: 'gemini -m test',
    order: ['headless-resume', 'drop'],
    agentSession: AGENT_SESSION,
  });
  sentToOwner(scene);
  const spawns: { binary: string; args: readonly string[] }[] = [];
  const spawn: HeadlessResumeSpawn = (binary, args) => {
    spawns.push({ binary, args });
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = await replyTo(scene, hostFor(scene, { headlessResumeSpawn: spawn }));

  expect(result.code).toBe(0);
  expect(result.err).toBe('');
  expect(result.out).toMatch(
    /^team acme, session "acme"\ngemini-seat: resumed headlessly \(drop \d+ characters\); no receipt within 20 ms\n$/,
  );
  expect(spawns).toEqual([
    { binary: 'gemini', args: ['--approval-mode', 'yolo', '--resume', AGENT_SESSION, '-p', pointerOf(scene)] },
  ]);
  expect(lastEntry(scene)).toMatchObject({ id: REPLY, via: 'headless-resume', outcome: 'sent (unconfirmed)' });
});

test('a Claude Code seat keeps the native skip, with its true reason', async () => {
  const scene = makeScene({ seat: 'helper', cli: 'claude-code', launch: 'claude', order: ['native', 'drop'] });
  sentToOwner(scene);
  const result = await replyTo(scene, hostFor(scene));

  expect(result.code).toBe(0);
  expect(result.err).toBe('');
  expect(result.out).toBe('team acme, session "acme"\nhelper: delivered (drop)\n');
  const entry = lastEntry(scene);
  expect(entry).toMatchObject({ id: REPLY, via: 'drop' });
  expect((entry.failed as string[] | undefined)?.some((why) => why === `native: ${CLAUDE_SKIP}`)).toBe(true);
});
