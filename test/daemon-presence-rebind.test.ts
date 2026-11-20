// The daemon's Codex presence sources follow the seat's incarnation (fix/presence-rebind).
//
// Under the real machine host, the production source factory (no `presenceSubscriptions`), the
// real ingester, activity reconciler and publisher, and a real Unix-socket WebSocket app-server
// fake (the frame shapes of test/codex-presence-source.test.ts):
// 1. A seat relaunched under a new presence binding gets its successor's source in the same pass:
//    the old one is retired, the new endpoint is attached, its baseline reaches the projection,
//    a `presence.changed` record for the new binding is published, and the seat serves again.
//    Before the fix the source started at daemon start stopped on `binding-changed` for good.
// 2. A Codex seat that was not up when the daemon started (its state named no agent session yet,
//    the reboot case) is resolved again on the retry and attached once its launch recorded it.
//    Before the fix the placeholder answered unproven for the daemon's whole run.
// 3. A source that stopped under its own binding (the state was unreadable for a moment, which
//    the source reads as a binding it cannot confirm) is started again on the retry.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PRESENCE_REBIND_RETRY_MS, startMachineDaemon, type StartMachineDaemonInput } from '../src/daemon/host.ts';
import { presencePaths } from '../src/daemon/presence/spool.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { STATE_FILE } from '../src/state.ts';
import { readEvents } from '../src/bus/log.ts';

const TEAM = `format: 1
project: acme-web
session: crew
coordinator: crew-lead
operator: crew-op
workspace:
  mode: shared
seats:
  - role: coordinator
    name: crew-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: crew-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: worker
    name: worker-1
    cli: codex
    vendor: openai
    model: GPT-5
    version: "5"
    launch: codex
`;

const SEAT = 'worker-1';
const HANDLE = 'seat_0123456789ab';
const THREAD = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
const FIRST = 'prs_0123456789ab';
const SECOND = 'prs_ba9876543210';
const LEAD_BINDING = 'prs_fedcba987654';

type World = { base: string; root: string; dir: string; home: string };

let world: World | null = null;
let cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch { /* one failed cleanup must not hide another */ }
  }
  cleanups = [];
  if (world !== null) rmSync(world.base, { recursive: true, force: true });
  world = null;
});

function makeWorld(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tp-rebind-')));
  const root = join(base, 'repo');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(dir, 'team.yaml'), TEAM);
  registerAgent(home, {
    name: SEAT,
    signing: { model: 'GPT-5', version: '5', role: 'worker' },
    lab: 'openai',
    cli: 'codex',
    launcher: null,
    launch: 'codex',
    seat_handle: HANDLE,
    reach: {
      team: teamIdOf(root), seat: SEAT, session: 'crew',
      pane: null, address: null, agent_session: THREAD,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  });
  world = { base, root, dir, home };
  return world;
}

/** The seat's state as a launch leaves it: its binding and, once recorded, its agent session. */
function writeSeatState(dir: string, binding: string, agentSession: string | null): void {
  const seat: Record<string, unknown> = { id: HANDLE, stage: 'ready', presence_binding: binding };
  if (agentSession !== null) seat.agent_session = agentSession;
  writeFileSync(join(dir, STATE_FILE), `${JSON.stringify({
    format: 1,
    sessions: {
      crew: {
        seats: { 'crew-lead': { stage: 'ready', presence_binding: LEAD_BINDING }, [SEAT]: seat },
        worktrees: {},
      },
    },
  })}\n`);
}

async function waitUntil(what: string, check: () => boolean, ms = 6_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
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


async function start(w: World, overrides: Partial<StartMachineDaemonInput>) {
  const started = await startMachineDaemon({
    home: w.home,
    roots: [w.root],
    startedBy: 'service-manager',
    version: '0.5.3-presence-rebind-test',
    heartbeatMs: 20,
    presenceHosting: true,
    presenceEveryMs: 10,
    ...overrides,
  });
  if (started.kind !== 'serving') throw new Error(`the daemon did not start: ${started.kind}`);
  cleanups.push(async () => {
    try { await started.daemon.close(); } catch { /* the scene already closed it */ }
  });
  return started.daemon;
}

/** The published `presence.changed` bindings for the seat, oldest first. */
function publishedBindings(w: World): string[] {
  const bus = readEvents('acme-web', w.root, w.home);
  if (!bus.ok) return [];
  return bus.events
    .filter((record) => record.payload.kind === 'presence.changed' && record.payload.seat === SEAT)
    .map((record) => String(record.payload.presence_binding));
}

function diagnosticOf(w: World): Record<string, unknown> | null {
  const paths = presencePaths(w.dir, 'crew', SEAT);
  try {
    return JSON.parse(readFileSync(join(paths!.root, 'source.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe('Codex presence sources follow the seat incarnation', () => {
  test('a relaunch under a new binding is attached in the same pass and published', async () => {
    const w = makeWorld();
    const sockets: Record<string, string> = { [FIRST]: join(w.base, 'a.sock'), [SECOND]: join(w.base, 'b.sock') };
    let endpointBinding = FIRST;
    writeSeatState(w.dir, FIRST, THREAD);
    const first = await startAppServer(sockets[FIRST]!);
    cleanups.push(() => first.close());
    const clock = { at: new Date('2026-11-20T06:00:00.000Z') };
    const daemon = await start(w, {
      now: () => clock.at,
      presenceCodexEndpoint: (_route, _dir, seat) => (seat === SEAT ? `unix://${sockets[endpointBinding]!}` : null),
    });
    const seatOf = () => daemon.health().roots?.[0]?.presence?.seats?.find((seat) => seat.seat === SEAT);
    await waitUntil('the first incarnation to publish', () => publishedBindings(w).includes(FIRST));
    await waitUntil('the first incarnation to serve', () => seatOf()?.healthy === true);
    expect(seatOf()).toMatchObject({ source: 'runtime', binding: FIRST, healthy: true });

    // The relaunch: a new endpoint under a new binding, the old app-server gone.
    const second = await startAppServer(sockets[SECOND]!);
    cleanups.push(() => second.close());
    await first.close();
    endpointBinding = SECOND;
    writeSeatState(w.dir, SECOND, THREAD);

    await waitUntil('the successor to be attached', () => second.requests.some((request) => request.method === 'thread/read'));
    await waitUntil('the successor to publish', () => publishedBindings(w).includes(SECOND));
    await waitUntil('the successor to serve', () => seatOf()?.healthy === true && seatOf()?.binding === SECOND);
    // No retry wait was needed: the clock never moved, so the rebind was the binding change itself.
    expect(clock.at.toISOString()).toBe('2026-11-20T06:00:00.000Z');
    expect(diagnosticOf(w)).toMatchObject({ binding: SECOND, channel: 'connected' });
    expect(seatOf()).toMatchObject({ source: 'runtime', binding: SECOND, healthy: true, why: null });
    await daemon.close();
  }, 20_000);

  test('a Codex seat that was not up at daemon start is attached on the retry', async () => {
    const w = makeWorld();
    const socket = join(w.base, 'a.sock');
    // The reboot case: the daemon is up before the seat's launch recorded its agent session.
    writeSeatState(w.dir, FIRST, null);
    const server = await startAppServer(socket);
    cleanups.push(() => server.close());
    const clock = { at: new Date('2026-11-20T06:00:00.000Z') };
    const daemon = await start(w, {
      now: () => clock.at,
      presenceCodexEndpoint: (_route, _dir, seat) => (seat === SEAT ? `unix://${socket}` : null),
    });
    const seatOf = () => daemon.health().roots?.[0]?.presence?.seats?.find((seat) => seat.seat === SEAT);
    // The route answers unhealthy until any spool was seen, so the seat's own reason is not on
    // the health answer yet; that it is an unproven placeholder shows as no attachment at all.
    await waitUntil('the seat answer', () => seatOf()?.source === 'runtime');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seatOf()).toMatchObject({ source: 'runtime', healthy: false });
    expect(server.requests).toEqual([]);
    expect(diagnosticOf(w)).toBeNull();

    // The launch finishes and records its session; nothing is attached before the retry is due.
    writeSeatState(w.dir, FIRST, THREAD);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.requests).toEqual([]);
    clock.at = new Date(clock.at.getTime() + PRESENCE_REBIND_RETRY_MS + 1);

    await waitUntil('the seat to be attached', () => server.requests.some((request) => request.method === 'thread/read'));
    await waitUntil('the seat to publish', () => publishedBindings(w).includes(FIRST));
    await waitUntil('the seat to serve', () => seatOf()?.healthy === true);
    expect(seatOf()).toMatchObject({ source: 'runtime', binding: FIRST, healthy: true, why: null });
    await daemon.close();
  }, 20_000);

  test('a source that stopped under the same binding is started again on the retry', async () => {
    const w = makeWorld();
    const socket = join(w.base, 'a.sock');
    writeSeatState(w.dir, FIRST, THREAD);
    const server = await startAppServer(socket);
    cleanups.push(() => server.close());
    const clock = { at: new Date('2026-11-20T06:00:00.000Z') };
    const daemon = await start(w, {
      now: () => clock.at,
      presenceCodexEndpoint: (_route, _dir, seat) => (seat === SEAT ? `unix://${socket}` : null),
    });
    const seatOf = () => daemon.health().roots?.[0]?.presence?.seats?.find((seat) => seat.seat === SEAT);
    await waitUntil('the seat to serve', () => seatOf()?.healthy === true);
    const reads = () => server.requests.filter((request) => request.method === 'thread/read').length;
    expect(reads()).toBe(1);

    // A torn state write: the source cannot confirm its binding and stops admissions.
    writeFileSync(join(w.dir, STATE_FILE), '{"format":1,');
    server.push({ method: 'thread/status/changed', params: { threadId: THREAD, status: { type: 'active', activeFlags: [] } } });
    await waitUntil('the source to stop', () => diagnosticOf(w)?.reason === 'binding-changed');
    writeSeatState(w.dir, FIRST, THREAD);
    clock.at = new Date(clock.at.getTime() + PRESENCE_REBIND_RETRY_MS + 1);

    await waitUntil('the seat to be attached again', () => reads() === 2);
    await waitUntil('the seat to serve again', () => seatOf()?.healthy === true);
    expect(diagnosticOf(w)).toMatchObject({ binding: FIRST, channel: 'connected' });
    await daemon.close();
  }, 20_000);
});
