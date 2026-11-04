// `team reply` delivers through the owner's cascade: the receiving seat's channel-class legs,
// then the sender-posted webhook, then the profile-gated typed wake, with the bus inbox under all
// of them. The reply rules themselves are unchanged — admission, the thread, and the read the
// answer marks — so these scenes pin the delivery half only: the leg the reply took is the leg it
// prints, a socket that refuses falls to the webhook behind it, the read receipts still land, and
// a record addressed to another seat is still refused before any frame is dialed.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { runReply, type ReplyHost } from '../src/commands/reply.ts';
import { runSend, walkReplyDelivery, type SendHost } from '../src/commands/send.ts';
import { entitiesPath } from '../src/entities.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { acquireSeatLock } from '../src/launch/seat-lock.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { readHistory } from '../src/send/history.ts';
import { defaultNaming } from '../src/send/names.ts';
import type { HeadlessResumeSpawn } from '../src/send/push-adapters.ts';
import { pushPointer } from '../src/send/push.ts';
import { readRecord, signClose, signedReceiptOf, verifyReceipt, writeClose } from '../src/send/record.ts';
import type { TypedWakeHost } from '../src/send/typed-wake.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';
import { NOW, fake, world, type World } from './send-native-fixtures.ts';

const SENT = '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d';
const REPLY = '3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

let made: World | null = null;
const stops: (() => unknown)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  made?.cleanup();
  made = null;
});

/** The receiving seat's launch-effective declaration, at the settings path its launch names,
 *  and the socket its pane exposes. The settings file predates the socket, so the session was
 *  started after the declaration took effect. */
function declareSeat(at: World, seat: string, policy: string | null): void {
  const path = cliHookSettingsPath(at.dir, 'acme', seat);
  if (path === null) throw new Error(`the fixture declares no settings path for ${seat}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: policy }));
  writeFileSync(join(at.sockets, '222.sock'), '');
  const declaredAt = Date.now() - 60_000;
  utimesSync(path, new Date(declaredAt), new Date(declaredAt));
}

/** What the answered record says: one message from `from`, waiting in the owner's folder. */
function sentToOwner(at: World, from: string): void {
  plantRecord(at.home, at.root, 'acme', 'owner', SENT, 'question from the seat', {
    from,
    at: NOW.toISOString(),
  });
}

type Result = { code: number; out: string; err: string; host: SendHost & { frames: string[] } };

async function run(
  at: World,
  patch: Partial<SendHost>,
  caller: Caller = { kind: 'owner' },
): Promise<Result> {
  const io = testIo(at.root, caller);
  const send = fake(at, patch);
  const host: ReplyHost = { home: at.home, now: () => NOW, newId: () => REPLY, send };
  const code = await runReply([SENT, 'the answer'], io, host);
  return { code, out: io.out, err: io.err, host: send };
}

/** A loopback listener the receiving seat's webhook row names; every request is recorded. */
function receiver(): { url: string; hits: { method: string; body: string }[] } {
  const hits: { method: string; body: string }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      hits.push({ method: request.method, body: await request.text() });
      return Response.json({ ok: true });
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/routine`, hits };
}

/** The two files the seat row names: the routine's URL, and a 0600 secret the POST carries. */
function hookFiles(url: string): { urlFile: string; secretFile: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reply-cascade-')));
  const urlFile = join(base, 'hook-url');
  const secretFile = join(base, 'hook-secret');
  writeFileSync(urlFile, `${url}\n`);
  writeFileSync(secretFile, 'synthetic-secret-value\n', { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  return { urlFile, secretFile };
}

test('a reply to a socket-reachable seat reports the socket leg and leaves the signed copy', async () => {
  made = world(null);
  declareSeat(made, 'helper', 'accept');
  sentToOwner(made, 'helper');
  const result = await run(made, { agents: () => [{ name: 'helper', pane: 'pane-helper' }] });

  expect(result.code).toBe(0);
  expect(result.err).toBe('');
  expect(result.out).toBe('team acme, session "acme"\nhelper: delivered (socket)\n');
  expect(result.host.frames).toHaveLength(1);
  const frame = JSON.parse(result.host.frames[0] as string) as { message: { content: string }; msg_id: string };
  expect(frame.msg_id).toBe(REPLY);
  expect(frame.message.content).toContain('the answer');
  // The durable copy waits in the receiving seat's folder under the frame's own id.
  expect(existsSync(join(recordDir(made.root, 'acme', 'helper'), REPLY))).toBe(true);

  const history = readHistory('acme', made.root, made.home);
  if (!history.ok) throw new Error(history.reason);
  expect(history.entries.at(-1)).toMatchObject({
    id: REPLY,
    thread: SENT,
    in_reply_to: SENT,
    outcome: 'delivered',
    via: 'socket',
  });
});

test('a reply still marks the record read when a wake leg takes it', async () => {
  made = world(null);
  declareSeat(made, 'helper', 'accept');
  sentToOwner(made, 'helper');
  const result = await run(made, { agents: () => [{ name: 'helper', pane: 'pane-helper' }] });
  expect(result.code).toBe(0);

  // ADR `zeus-message-path`, D3: answering is a read, whatever leg carried the answer.
  const read = signedReceiptOf(JSON.parse(readFileSync(join(recordDir(made.root, 'acme', 'owner'), `${SENT}.read.json`), 'utf8')));
  if (read === null) throw new Error('no read receipt was written');
  expect(read.payload.read_by).toBe('reply');
  const key = messageKeyState(made.home);
  if (key.kind !== 'key') throw new Error(key.kind);
  expect(verifyReceipt(read, key.key)).toBe(true);
  expect(existsSync(join(recordDir(made.root, 'acme', 'owner'), `${SENT}.replied.json`))).toBe(true);
});

test('a reply to a seat whose socket refuses falls to the webhook behind it', async () => {
  const hook = receiver();
  made = world(['socket', 'drop'], [{ name: 'iris', role: 'remote', webhook: hookFiles(hook.url) }]);
  declareSeat(made, 'iris', 'refuse');
  sentToOwner(made, 'iris');
  const result = await run(made, { agents: () => [{ name: 'iris', pane: 'pane-iris' }] });

  expect(result.code).toBe(0);
  // The post's own duration is the sender's wall clock, so the scene pins its shape.
  expect(result.out).toMatch(/^team acme, session "acme"\niris: delivered \(webhook, \d+ ms\)\n$/);
  // The socket refused at its declaration: no frame was dialed, and the routine took the reply.
  expect(result.host.frames).toHaveLength(0);
  expect(hook.hits).toHaveLength(1);
  expect(hook.hits[0]?.method).toBe('POST');
  expect(hook.hits[0]?.body).toContain(REPLY);

  const history = readHistory('acme', made.root, made.home);
  if (!history.ok) throw new Error(history.reason);
  const line = history.entries.at(-1) as { via?: string; failed?: string[] };
  expect(line.via).toBe('webhook');
  expect(line.failed?.some((why) => why.startsWith('socket: the receiving Claude session declares crossSessionInbound refuse'))).toBe(true);
});

test('a reply outside the allowed direction is still refused, and no frame is dialed', async () => {
  made = world(null);
  declareSeat(made, 'lead', 'accept');
  // The record sits in lead's folder, addressed to lead: the owner is not its addressee.
  plantRecord(made.home, made.root, 'acme', 'lead', SENT, 'question for lead', {
    from: 'worker',
    at: NOW.toISOString(),
  });
  const result = await run(made, { agents: () => [{ name: 'lead', pane: 'pane-lead' }] });

  expect(result.code).toBe(1);
  expect(result.err).toBe(`team reply: record ${SENT} is addressed to lead, not to owner\n`);
  expect(result.host.frames).toHaveLength(0);
});

const MUSE_FIXTURES = join(import.meta.dir, 'fixtures', 'muse', '1.4.11');
const MUSE_IDLE = readFileSync(join(MUSE_FIXTURES, 'idle.txt'), 'utf8');
const MUSE_WORKING = readFileSync(join(MUSE_FIXTURES, 'working-synthetic.txt'), 'utf8');
const CODEX_FIXTURES = join(import.meta.dir, 'fixtures', 'codex', '0.157.0');
const CODEX_IDLE = readFileSync(join(CODEX_FIXTURES, 'idle.txt'), 'utf8');
const CODEX_WORKING = readFileSync(join(CODEX_FIXTURES, 'working.txt'), 'utf8');

function museHolding(text: string): string {
  return MUSE_IDLE.replace('❯\n', `❯ ${text}\n`);
}

function codexHolding(text: string): string {
  return CODEX_IDLE.replace('› Ask Codex to do anything', `› ${text}`);
}

function wakeFake(
  screen: (read: number, enters: number, typed: readonly string[]) => string | null,
): { host: TypedWakeHost; typed: string[]; enters: number; reads: number } {
  const typed: string[] = [];
  const state = { enters: 0, reads: 0 };
  const host: TypedWakeHost = {
    read: () => screen(state.reads++, state.enters, typed),
    type: (_pane: string, text: string) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      state.enters += 1;
      return true;
    },
    wait: async () => {},
  };
  return {
    host,
    typed,
    get enters() {
      return state.enters;
    },
    get reads() {
      return state.reads;
    },
  };
}

function assertSingleReceiptsOnAnsweredRecord(
  home: string,
  root: string,
  session: string,
  replierSeat: string,
  answeredId: string,
  targetSeat: string,
  replyId: string,
): void {
  const keyState = messageKeyState(home);
  if (keyState.kind !== 'key') throw new Error(keyState.kind);
  const replierDir = recordDir(root, session, replierSeat);
  const sidecars = readdirSync(replierDir)
    .filter((name) => name.startsWith(`${answeredId}.`))
    .sort();
  expect(sidecars).toEqual([`${answeredId}.read.json`, `${answeredId}.replied.json`]);

  const readReceipt = signedReceiptOf(JSON.parse(readFileSync(join(replierDir, `${answeredId}.read.json`), 'utf8')));
  expect(readReceipt).not.toBeNull();
  expect(verifyReceipt(readReceipt!, keyState.key)).toBe(true);
  expect(readReceipt!.payload).toMatchObject({
    kind: 'receipt',
    status: 'read',
    id: answeredId,
    to: replierSeat,
    session,
    read_by: 'reply',
  });

  const repliedReceipt = signedReceiptOf(JSON.parse(readFileSync(join(replierDir, `${answeredId}.replied.json`), 'utf8')));
  expect(repliedReceipt).not.toBeNull();
  expect(verifyReceipt(repliedReceipt!, keyState.key)).toBe(true);
  expect(repliedReceipt!.payload).toMatchObject({
    kind: 'receipt',
    status: 'replied',
    id: answeredId,
    to: replierSeat,
    session,
  });

  // The receiving seat's folder holds the reply record itself and zero premature receipts for it.
  const targetDir = recordDir(root, session, targetSeat);
  expect(existsSync(join(targetDir, replyId))).toBe(true);
  const targetSidecars = readdirSync(targetDir).filter(
    (name) => name.startsWith(`${replyId}.`) && (name.endsWith('.read.json') || name.endsWith('.replied.json')),
  );
  expect(targetSidecars).toEqual([]);
}

test('probe 1 & 3: reply across wake classes (socket, webhook, typed wake, pull-only) takes the expected leg and writes read + replied receipts exactly once', async () => {
  // 1. Socket wake class (claude-code with inbound: accept + live socket) -> via: 'socket'
  {
    const w = world(null);
    stops.push(w.cleanup);
    declareSeat(w, 'helper', 'accept');
    sentToOwner(w, 'helper');
    const res = await run(w, { agents: () => [{ name: 'helper', pane: 'pane-helper' }] });
    expect(res.code).toBe(0);
    expect(res.out).toBe('team acme, session "acme"\nhelper: delivered (socket)\n');
    expect(res.host.frames).toHaveLength(1);
    const hist = readHistory('acme', w.root, w.home);
    if (!hist.ok) throw new Error(hist.reason);
    expect(hist.entries.at(-1)).toMatchObject({ id: REPLY, via: 'socket', outcome: 'delivered' });
    assertSingleReceiptsOnAnsweredRecord(w.home, w.root, 'acme', 'owner', SENT, 'helper', REPLY);
  }

  // 2. Webhook wake class (seat declares webhook row, no socket) -> via: 'webhook'
  {
    const hook = receiver();
    const hookPaths = hookFiles(hook.url);
    stops.push(() => rmSync(dirname(hookPaths.urlFile), { recursive: true, force: true }));
    const w = world(['drop'], [{ name: 'iris', role: 'remote', cli: 'gemini', launch: 'gemini', webhook: hookPaths }]);
    stops.push(w.cleanup);
    sentToOwner(w, 'iris');
    const res = await run(w, { agents: () => [{ name: 'iris', pane: 'pane-iris' }] });
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^team acme, session "acme"\niris: delivered \(webhook, \d+ ms\)\n$/);
    expect(res.host.frames).toHaveLength(0);
    expect(hook.hits).toHaveLength(1);
    const hist = readHistory('acme', w.root, w.home);
    if (!hist.ok) throw new Error(hist.reason);
    expect(hist.entries.at(-1)).toMatchObject({ id: REPLY, via: 'webhook', outcome: 'delivered' });
    assertSingleReceiptsOnAnsweredRecord(w.home, w.root, 'acme', 'owner', SENT, 'iris', REPLY);
  }

  // 3. Typed wake class (profile with typed_wake: screen, idle -> working screen) -> via: 'typed'
  {
    const w = world(['typed', 'drop'], [{ name: 'muse', role: 'implementer', cli: 'muse', launch: 'muse' }]);
    stops.push(w.cleanup);
    sentToOwner(w, 'muse');
    const pane = wakeFake((read, enters, typed) =>
      enters > 0 ? MUSE_WORKING : read < 2 ? MUSE_IDLE : museHolding(typed[typed.length - 1] ?? ''),
    );
    const res = await run(w, {
      agents: () => [{ name: 'muse', pane: 'pane-muse' }],
      typedWake: () => pane.host,
    });
    expect(res.code).toBe(0);
    expect(res.out).toBe('team acme, session "acme"\nmuse: delivered (typed wake)\n');
    expect(res.host.frames).toHaveLength(0);
    expect(pane.typed).toHaveLength(1);
    expect(pane.typed[0]).toContain('Read it with: team drops --read.');
    expect(pane.enters).toBe(1);
    const hist = readHistory('acme', w.root, w.home);
    if (!hist.ok) throw new Error(hist.reason);
    expect(hist.entries.at(-1)).toMatchObject({
      id: REPLY,
      via: 'typed',
      outcome: 'delivered (typed wake)',
    });
    assertSingleReceiptsOnAnsweredRecord(w.home, w.root, 'acme', 'owner', SENT, 'muse', REPLY);
  }

  // 4. Pull-only wake class (gemini: delivery: pull-on-turn, typedWake: null, no socket/webhook) -> via: 'drop'
  {
    const w = world(null, [{ name: 'gem', role: 'reviewer', cli: 'gemini', launch: 'gemini' }]);
    stops.push(w.cleanup);
    sentToOwner(w, 'gem');
    const pane = wakeFake(() => MUSE_IDLE);
    const res = await run(w, {
      agents: () => [{ name: 'gem', pane: 'pane-gem' }],
      typedWake: () => pane.host,
    });
    expect(res.code).toBe(0);
    expect(res.out).toBe('team acme, session "acme"\ngem: delivered (drop)\n');
    expect(res.host.frames).toHaveLength(0);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const hist = readHistory('acme', w.root, w.home);
    if (!hist.ok) throw new Error(hist.reason);
    expect(hist.entries.at(-1)).toMatchObject({
      id: REPLY,
      via: 'drop',
      outcome: 'delivered',
      failed: ["typed: typing into a seat's pane is never a delivery: messages go through the bus and an event adapter"],
    });
    assertSingleReceiptsOnAnsweredRecord(w.home, w.root, 'acme', 'owner', SENT, 'gem', REPLY);
  }
});

function wsServerFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function wsClientFrames(buffer: Buffer): { texts: string[]; rest: Buffer } {
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

async function startCodexAppServer(socketPath: string, threadId: string): Promise<{
  requests: { method: string; threadId?: string }[];
  close: () => Promise<void>;
}> {
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
      const decoded = wsClientFrames(buffer);
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
          socket.write(wsServerFrame(JSON.stringify({ id: 'initialize', result: {} })));
        } else if (msg.id === 'thread_read') {
          const asked = typeof msg.params?.threadId === 'string' ? msg.params.threadId : '';
          requests.push({ method: 'thread/read', threadId: asked });
          socket.write(
            wsServerFrame(
              JSON.stringify({
                id: 'thread_read',
                result: {
                  thread: {
                    id: threadId,
                    status: { type: 'idle' },
                    canAcceptDirectInput: true,
                  },
                },
              }),
            ),
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
    requests,
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('probe 1 (Codex runtime queue, Gemini headless-resume, and codex_daemon off): reply takes native runtime queue for Codex, headless-resume for Gemini, and typed-first when codex_daemon is off', async () => {
  const threadId = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
  const geminiSessionId = 'ses_gemini_019a0000';
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'reply-codex-cascade-')));
  stops.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  const codexHome = join(base, 'codex-home');
  const binDir = join(base, 'bin');
  const queueLog = join(base, 'queue.log');
  const lobby = resolveLobby(home, { entity: 'corp' });
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(entitiesPath(home)), { recursive: true });
  writeFileSync(entitiesPath(home), `corp:\n  roots:\n    - ${JSON.stringify(base)}\n`);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });

  const writeTeamOrder = (orderLine: string) => {
    writeFileSync(
      join(dir, 'team.yaml'),
      `format: 1
project: acme
entity: corp
coordinator: lead
operator: lead
session: acme
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
  - role: reviewer
    name: native
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m gpt-6-sol
  - role: implementer
    name: gem
    cli: gemini
    vendor: test
    model: Test
    version: "1"
    launch: gemini -m gemini-pro
${orderLine}`,
    );
  };
  writeTeamOrder('delivery_order: [native, drop]\n');
  writeFileSync(
    join(dir, 'team.state.json'),
    `${JSON.stringify({
      format: 1,
      sessions: {
        acme: {
          seats: {
            native: { id: 'seat_123456789abc', stage: 'ready', pane: 'pane-native', agent_session: threadId },
            gem: { id: 'seat_abcdef012345', stage: 'ready', pane: 'pane-gem', agent_session: geminiSessionId },
          },
          worktrees: {},
        },
      },
    })}\n`,
  );
  const codexAgent = registerAgent(home, {
    name: 'native',
    signing: { model: 'Test', version: '1', role: 'reviewer' },
    lab: 'test',
    cli: 'codex',
    launcher: null,
    launch: 'codex -m gpt-6-sol',
    seat_handle: 'seat_123456789abc',
    reach: {
      team: teamIdOf(root),
      seat: 'native',
      session: 'acme',
      agent_session: threadId,
      pane: 'pane-native',
      address: null,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  registerAgent(home, {
    name: 'gem',
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test',
    cli: 'gemini',
    launcher: null,
    launch: 'gemini -m gemini-pro',
    seat_handle: 'seat_abcdef012345',
    reach: {
      team: teamIdOf(root),
      seat: 'gem',
      session: 'acme',
      agent_session: geminiSessionId,
      pane: 'pane-gem',
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

  const socketPath = join(codexHome, 'app-server-control', 'app-server-control.sock');
  const appServer = await startCodexAppServer(socketPath, threadId);
  stops.push(() => appServer.close());

  const savedPath = process.env.PATH;
  const savedCodexHome = process.env.CODEX_HOME;
  const savedQueueLog = process.env.CODEX_QUEUE_LOG;
  process.env.PATH = `${binDir}:${savedPath ?? ''}`;
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_QUEUE_LOG = queueLog;
  try {
    // A. `team send` and `team reply` to the Codex seat with `delivery_order: [native, drop]` both wake via `native` (runtime queue).
    const sendHost: SendHost = {
      agents: () => [{ name: 'native', pane: 'pane-native', cli: 'codex' }],
      processInfo: () => ({ shell: 111, foreground: [222] }),
      socketsDir: sockets,
      deliver: async () => ({ ok: false, reason: 'no socket' }),
      native: {
        typeText: () => false,
        pressEnter: () => false,
        status: () => 'idle',
        wait: async () => {},
        paneText: () => '',
      },
      now: () => NOW,
      home,
      sendId: () => '11111111-2222-4333-8444-555555555555',
      inboxGraceMs: 10,
    };
    const sendIo = testIo(root, { kind: 'owner' });
    const sendCode = await runSend(['native', 'ping from send'], sendIo, sendHost);
    expect(sendCode).toBe(0);
    expect(appServer.requests.some((r) => r.method === 'thread/read' && r.threadId === threadId)).toBe(true);
    const sendQueueLines = readFileSync(queueLog, 'utf8').trim().split('\n').filter(Boolean);
    expect(sendQueueLines).toHaveLength(1);
    const histAfterSend = readHistory('acme', root, home);
    if (!histAfterSend.ok) throw new Error(histAfterSend.reason);
    expect(histAfterSend.entries.at(-1)).toMatchObject({
      id: '11111111-2222-4333-8444-555555555555',
      to: 'native',
      via: 'native',
      outcome: 'sent (unconfirmed)',
    });

    appServer.requests.length = 0;
    writeFileSync(queueLog, '');
    plantRecord(home, root, 'acme', 'owner', SENT, 'question from codex seat', {
      from: 'native',
      at: NOW.toISOString(),
    });
    const replyIo = testIo(root, { kind: 'owner' });
    const replyCode = await runReply([SENT, 'answer to codex seat'], replyIo, {
      home,
      now: () => NOW,
      newId: () => REPLY,
      send: sendHost,
    });
    expect(replyCode).toBe(0);
    expect(replyIo.out).toMatch(
      /^team acme, session "acme"\nnative: queued to its native runtime \(drop \d+ characters\); no receipt within 10 ms\n$/,
    );
    expect(appServer.requests).toEqual([
      { method: 'initialize' },
      { method: 'thread/read', threadId },
    ]);
    const replyQueueLines = readFileSync(queueLog, 'utf8').trim().split('\n').filter(Boolean);
    expect(replyQueueLines).toHaveLength(1);
    const histAfterReply = readHistory('acme', root, home);
    if (!histAfterReply.ok) throw new Error(histAfterReply.reason);
    expect(histAfterReply.entries.at(-1)).toMatchObject({
      id: REPLY,
      to: 'native',
      via: 'native',
      outcome: 'sent (unconfirmed)',
    });
    assertSingleReceiptsOnAnsweredRecord(home, root, 'acme', 'owner', SENT, 'native', REPLY);

    // B. With default (unwritten) `delivery_order` and `codex-daemon: on` (signed default),
    // a mid-turn Codex seat (`CODEX_WORKING`) is woken through the runtime queue (`via: 'native'`), never typed at.
    writeTeamOrder('');
    appServer.requests.length = 0;
    writeFileSync(queueLog, '');
    const SENT_2 = '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3e';
    const REPLY_2 = '3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e';
    plantRecord(home, root, 'acme', 'owner', SENT_2, 'second question from codex seat', {
      from: 'native',
      at: NOW.toISOString(),
    });
    const busyPane = wakeFake(() => CODEX_WORKING);
    const replyBusyIo = testIo(root, { kind: 'owner' });
    const replyBusyCode = await runReply([SENT_2, 'answer while codex working'], replyBusyIo, {
      home,
      now: () => NOW,
      newId: () => REPLY_2,
      send: { ...sendHost, typedWake: () => busyPane.host },
    });
    expect(replyBusyCode).toBe(0);
    expect(replyBusyIo.out).toMatch(
      /^team acme, session "acme"\nnative: queued to its native runtime \(drop \d+ characters\); no receipt within 10 ms\n$/,
    );
    expect(appServer.requests).toContainEqual({ method: 'thread/read', threadId });
    expect(readFileSync(queueLog, 'utf8').trim().split('\n').filter(Boolean)).toHaveLength(1);
    expect(busyPane.typed).toEqual([]);
    expect(busyPane.enters).toBe(0);
    const histAfterBusy = readHistory('acme', root, home);
    if (!histAfterBusy.ok) throw new Error(histAfterBusy.reason);
    expect(histAfterBusy.entries.at(-1)).toMatchObject({
      id: REPLY_2,
      to: 'native',
      via: 'native',
      outcome: 'sent (unconfirmed)',
    });
    assertSingleReceiptsOnAnsweredRecord(home, root, 'acme', 'owner', SENT_2, 'native', REPLY_2);

    // C. Gemini seat without a webhook (`delivery_order: [headless-resume, drop]`) takes `headless-resume` with a faked runtime.
    writeTeamOrder('delivery_order: [headless-resume, drop]\n');
    const SENT_GEM = '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c41';
    const REPLY_GEM = '3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c61';
    plantRecord(home, root, 'acme', 'owner', SENT_GEM, 'question from gemini seat', {
      from: 'gem',
      at: NOW.toISOString(),
    });
    const spawns: { binary: string; args: readonly string[] }[] = [];
    const fakeSpawn: HeadlessResumeSpawn = (binary, args) => {
      spawns.push({ binary, args });
      return { status: 0, stdout: '', stderr: '' };
    };
    const gemIo = testIo(root, { kind: 'owner' });
    const gemCode = await runReply([SENT_GEM, 'answer to gemini via headless resume'], gemIo, {
      home,
      now: () => NOW,
      newId: () => REPLY_GEM,
      send: { ...sendHost, headlessResumeSpawn: fakeSpawn },
    });
    expect(gemCode).toBe(0);
    expect(gemIo.out).toMatch(
      /^team acme, session "acme"\ngem: resumed headlessly \(drop \d+ characters\); no receipt within 10 ms\n$/,
    );
    const expectedPointer = pushPointer(REPLY_GEM, { seat: 'owner', team: teamIdOf(root) });
    expect(spawns).toEqual([
      { binary: 'gemini', args: ['--approval-mode', 'yolo', '--resume', geminiSessionId, '-p', expectedPointer!] },
    ]);
    const histAfterGem = readHistory('acme', root, home);
    if (!histAfterGem.ok) throw new Error(histAfterGem.reason);
    expect(histAfterGem.entries.at(-1)).toMatchObject({
      id: REPLY_GEM,
      to: 'gem',
      via: 'headless-resume',
      outcome: 'sent (unconfirmed)',
    });
    assertSingleReceiptsOnAnsweredRecord(home, root, 'acme', 'owner', SENT_GEM, 'gem', REPLY_GEM);

    // D. Codex seat with `codex_daemon: off` (signed seat policy) and default (unwritten) `delivery_order`
    // behaves as before (`typed` first, never probing the app-server or calling `codex queue`).
    writeTeamOrder('');
    const policyWrite = writePolicySet(
      home,
      { level: 'seat', target: codexAgent.id, name: 'codex-daemon', value: 'off' },
      { now: NOW },
    );
    if (!policyWrite.ok) throw new Error(policyWrite.why);

    appServer.requests.length = 0;
    writeFileSync(queueLog, '');
    const SENT_3 = '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3f';
    const REPLY_3 = '3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5f';
    plantRecord(home, root, 'acme', 'owner', SENT_3, 'third question from codex seat with daemon off', {
      from: 'native',
      at: NOW.toISOString(),
    });
    const idlePane = wakeFake((read, enters, typed) =>
      enters > 0 ? CODEX_WORKING : read < 2 ? CODEX_IDLE : codexHolding(typed[typed.length - 1] ?? ''),
    );
    const replyIdleIo = testIo(root, { kind: 'owner' });
    const replyIdleCode = await runReply([SENT_3, 'answer while codex idle with daemon off'], replyIdleIo, {
      home,
      now: () => NOW,
      newId: () => REPLY_3,
      send: { ...sendHost, typedWake: () => idlePane.host },
    });
    expect(replyIdleCode).toBe(0);
    expect(replyIdleIo.out).toBe('team acme, session "acme"\nnative: delivered (typed wake)\n');
    expect(appServer.requests).toEqual([]);
    expect(readFileSync(queueLog, 'utf8')).toBe('');
    expect(idlePane.typed).toHaveLength(1);
    expect(idlePane.enters).toBe(1);
    const histAfterIdle = readHistory('acme', root, home);
    if (!histAfterIdle.ok) throw new Error(histAfterIdle.reason);
    expect(histAfterIdle.entries.at(-1)).toMatchObject({
      id: REPLY_3,
      to: 'native',
      via: 'typed',
      outcome: 'delivered (typed wake)',
    });
    assertSingleReceiptsOnAnsweredRecord(home, root, 'acme', 'owner', SENT_3, 'native', REPLY_3);

    // And when `codex_daemon: off` + working screen, `typed` fails and falls to `drop` (0 queue calls).
    const SENT_4 = '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c42';
    const REPLY_4 = '3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c62';
    plantRecord(home, root, 'acme', 'owner', SENT_4, 'fourth question while codex working and daemon off', {
      from: 'native',
      at: NOW.toISOString(),
    });
    const offBusyPane = wakeFake(() => CODEX_WORKING);
    const replyOffBusyIo = testIo(root, { kind: 'owner' });
    const replyOffBusyCode = await runReply([SENT_4, 'answer while codex working and daemon off'], replyOffBusyIo, {
      home,
      now: () => NOW,
      newId: () => REPLY_4,
      send: { ...sendHost, typedWake: () => offBusyPane.host },
    });
    expect(replyOffBusyCode).toBe(0);
    expect(replyOffBusyIo.out).toBe('team acme, session "acme"\nnative: delivered (drop)\n');
    expect(appServer.requests).toEqual([]);
    expect(readFileSync(queueLog, 'utf8')).toBe('');
    const histAfterOffBusy = readHistory('acme', root, home);
    if (!histAfterOffBusy.ok) throw new Error(histAfterOffBusy.reason);
    expect(histAfterOffBusy.entries.at(-1)).toMatchObject({
      id: REPLY_4,
      to: 'native',
      via: 'drop',
      outcome: 'delivered',
      failed: ['typed: the first read showed working, not an empty idle prompt; nothing was typed'],
    });
    assertSingleReceiptsOnAnsweredRecord(home, root, 'acme', 'owner', SENT_4, 'native', REPLY_4);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    if (savedQueueLog === undefined) delete process.env.CODEX_QUEUE_LOG;
    else process.env.CODEX_QUEUE_LOG = savedQueueLog;
  }
});

test('probe 2: refused replies (wrong direction, not admitted, thread mismatch) never dial a socket, post a webhook, or type into a pane', async () => {
  const hook = receiver();
  const hookPaths = hookFiles(hook.url);
  stops.push(() => rmSync(dirname(hookPaths.urlFile), { recursive: true, force: true }));

  // Armed target world: socket + webhook + typedWake all ready to fire if walkReplyDelivery were reached.
  const w = world(
    ['socket', 'typed', 'drop'],
    [{ name: 'iris', role: 'implementer', cli: 'claude-code', launch: 'claude', webhook: hookPaths }],
  );
  stops.push(w.cleanup);
  declareSeat(w, 'iris', 'accept');
  declareSeat(w, 'lead', 'accept');
  const pane = wakeFake((read, enters, typed) =>
    enters > 0 ? MUSE_WORKING : read < 2 ? MUSE_IDLE : museHolding(typed[typed.length - 1] ?? ''),
  );
  const armedPatch: Partial<SendHost> = {
    agents: () => [
      { name: 'iris', pane: 'pane-iris' },
      { name: 'lead', pane: 'pane-lead' },
    ],
    typedWake: () => pane.host,
  };

  // 1. Wrong direction: record in `lead`'s folder addressed to `lead`, answered by `owner`.
  plantRecord(w.home, w.root, 'acme', 'lead', SENT, 'for lead only', {
    from: 'iris',
    at: NOW.toISOString(),
  });
  const wrongDir = await run(w, armedPatch, { kind: 'owner' });
  expect(wrongDir.code).toBe(1);
  expect(wrongDir.err).toContain(`record ${SENT} is addressed to lead, not to owner`);
  expect(wrongDir.host.frames).toEqual([]);
  expect(hook.hits).toEqual([]);
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);

  // 2a. Not admitted (undeclared sender seat `ghost` on answered record).
  const SENT_GHOST = '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c40';
  plantRecord(w.home, w.root, 'acme', 'owner', SENT_GHOST, 'from ghost', {
    from: 'ghost',
    at: NOW.toISOString(),
  });
  const ghostIo = testIo(w.root, { kind: 'owner' });
  const ghostSend = fake(w, armedPatch);
  const ghostCode = await runReply([SENT_GHOST, 'answer ghost'], ghostIo, {
    home: w.home,
    now: () => NOW,
    newId: () => REPLY,
    send: ghostSend,
  });
  expect(ghostCode).toBe(1);
  expect(ghostIo.err).toContain('ghost: it is not a declared seat');
  expect(ghostSend.frames).toEqual([]);
  expect(hook.hits).toEqual([]);
  expect(pane.typed).toEqual([]);

  // 2b & 3. Cross-team main-orchestrator thread mismatch and admission refusal:
  // Set up head team (`corp`, project: `corp`, entity: `corp`, orchestrator: `lead`) and sub-team
  // (`sub`, project: `sub`, entity: `corp`, seats: `lead`, `helper`).
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'reply-refused-cross-')));
  stops.push(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const headRoot = join(base, 'corp');
  const subRoot = join(base, 'sub');
  const sockets = join(base, 'sockets');
  const lobby = resolveLobby(home, { entity: 'corp' });
  mkdirSync(join(headRoot, '.agents'), { recursive: true });
  mkdirSync(join(subRoot, '.agents'), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(entitiesPath(home)), { recursive: true });
  writeFileSync(entitiesPath(home), `corp:\n  roots:\n    - ${JSON.stringify(base)}\n`);
  execFileSync('git', ['init', '-q'], { cwd: headRoot, stdio: 'ignore' });
  execFileSync('git', ['init', '-q'], { cwd: subRoot, stdio: 'ignore' });

  const headHookPaths = hookFiles(hook.url);
  stops.push(() => rmSync(dirname(headHookPaths.urlFile), { recursive: true, force: true }));
  writeFileSync(
    join(headRoot, '.agents', 'team.yaml'),
    `format: 1
project: corp
entity: corp
coordinator: lead
operator: lead
session: corp
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${headRoot}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    inbound: accept
    webhook:
      url_file: ${JSON.stringify(headHookPaths.urlFile)}
      secret_file: ${JSON.stringify(headHookPaths.secretFile)}
`,
  );
  writeFileSync(
    join(subRoot, '.agents', 'team.yaml'),
    `format: 1
project: sub
entity: corp
coordinator: lead
operator: lead
session: sub
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${subRoot}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: helper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: localonly
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`,
  );

  const headTeamId = teamIdOf(headRoot);
  const subTeamId = teamIdOf(subRoot);
  const headLead = registerAgent(home, {
    name: 'lead',
    signing: { model: 'Test', version: '1', role: 'coordinator' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: headTeamId, seat: 'lead', session: 'corp', pane: 'pane-head-lead', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  const subHelper = registerAgent(home, {
    name: 'helper',
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: subTeamId, seat: 'helper', session: 'sub', pane: 'pane-sub-helper', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  upsertTeam(home, headTeamId, {
    project: 'corp',
    entity: 'corp',
    root: headRoot,
    session: 'corp',
    lifecycle: 'running',
    roster: [{ agent: headLead.id, seat: 'lead', role: 'coordinator', leads: true }],
  });
  upsertTeam(home, subTeamId, {
    project: 'sub',
    entity: 'corp',
    root: subRoot,
    session: 'sub',
    lifecycle: 'running',
    roster: [{ agent: subHelper.id, seat: 'helper', role: 'implementer' }],
  });
  writeFileSync(
    join(subRoot, '.agents', 'team.state.json'),
    `${JSON.stringify({
      format: 1,
      sessions: {
        sub: {
          seats: {
            helper: { id: 'seat_sub_helper', stage: 'ready', pane: 'pane-sub-helper' },
            localonly: { id: 'seat_sub_local', stage: 'ready', pane: 'pane-sub-local' },
          },
          worktrees: {},
        },
      },
    })}\n`,
  );
  // Arm socket on head team's `lead` seat so any leaked walk would dial a frame or post a webhook.
  const headSettings = cliHookSettingsPath(join(headRoot, '.agents'), 'corp', 'lead');
  if (headSettings === null) throw new Error('missing head settings path');
  mkdirSync(dirname(headSettings), { recursive: true });
  writeFileSync(headSettings, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeFileSync(join(sockets, '222.sock'), '');
  const declaredAt = Date.now() - 60_000;
  utimesSync(headSettings, new Date(declaredAt), new Date(declaredAt));

  const crossFrames: string[] = [];
  const crossSendHost: SendHost = {
    agents: () => [{ name: 'lead', pane: 'pane-head-lead' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: sockets,
    deliver: async (_sock, frame) => {
      crossFrames.push(frame);
      return { ok: true };
    },
    native: {
      typeText: () => false,
      pressEnter: () => false,
      status: () => null,
      wait: async () => {},
    },
    typedWake: () => pane.host,
    now: () => NOW,
    home,
  };

  // 3a. Thread mismatch: record from main orchestrator `lead` cites a thread `FOREIGN_THREAD` whose
  // opening record was sent by `helper` (not by the entity's main orchestrator).
  const FOREIGN_THREAD = '10000000-0000-4000-8000-000000000001';
  const BAD_THREAD_MSG = '10000000-0000-4000-8000-000000000002';
  plantRecord(home, subRoot, 'sub', 'helper', FOREIGN_THREAD, 'opened by helper itself', {
    from: 'helper',
    from_id: subHelper.id,
    thread: FOREIGN_THREAD,
    at: NOW.toISOString(),
  });
  plantRecord(home, subRoot, 'sub', 'helper', BAD_THREAD_MSG, 'follow-up claiming foreign thread', {
    from: 'lead',
    from_id: headLead.id,
    thread: FOREIGN_THREAD,
    at: NOW.toISOString(),
  });
  const subCaller: Caller = { kind: 'seat', name: 'helper', pane: 'pane-sub-helper', session: 'sub' };
  const mismatchIo = testIo(subRoot, subCaller);
  const mismatchCode = await runReply([BAD_THREAD_MSG, 'reply on mismatched thread'], mismatchIo, {
    home,
    now: () => NOW,
    newId: () => REPLY,
    send: crossSendHost,
  });
  expect(mismatchCode).toBe(1);
  expect(mismatchIo.err).toContain(`lead: the thread ${FOREIGN_THREAD} was not opened by the entity's main orchestrator`);
  expect(crossFrames).toEqual([]);
  expect(hook.hits).toEqual([]);
  expect(pane.typed).toEqual([]);

  // 3b. Closed main-orchestrator thread refusal: main orchestrator opened `OPEN_THREAD`, then it was closed,
  // and a later record on `OPEN_THREAD` is answered.
  const OPEN_THREAD = '10000000-0000-4000-8000-000000000003';
  const OPEN_THREAD_LATER = '10000000-0000-4000-8000-000000000005';
  plantRecord(home, subRoot, 'sub', 'helper', OPEN_THREAD, 'opened by main orchestrator', {
    from: 'lead',
    from_id: headLead.id,
    thread: OPEN_THREAD,
    at: NOW.toISOString(),
  });
  const closeIo = testIo(subRoot, subCaller);
  expect(await runReply([OPEN_THREAD, '--close'], closeIo, { home, now: () => NOW })).toBe(0);
  plantRecord(home, subRoot, 'sub', 'helper', OPEN_THREAD_LATER, 'later note on closed thread', {
    from: 'lead',
    from_id: headLead.id,
    thread: OPEN_THREAD,
    at: NOW.toISOString(),
  });
  const closedIo = testIo(subRoot, subCaller);
  const closedCode = await runReply([OPEN_THREAD_LATER, 'reply on closed orchestrator thread'], closedIo, {
    home,
    now: () => NOW,
    newId: () => REPLY,
    send: crossSendHost,
  });
  expect(closedCode).toBe(1);
  expect(closedIo.err).toContain("a seat answers the entity's main orchestrator only on the open thread that orchestrator opened, and never opens one");
  expect(crossFrames).toEqual([]);
  expect(hook.hits).toEqual([]);
  expect(pane.typed).toEqual([]);

  // 2b. Not admitted: cross-team reply from a declared seat (`localonly`) with no registered agent
  // record in `agents.yaml` is refused by `admissionOf` (`no rule admits the send`).
  const ADMIT_THREAD = '10000000-0000-4000-8000-000000000004';
  plantRecord(home, subRoot, 'sub', 'localonly', ADMIT_THREAD, 'opened by main orchestrator', {
    from: 'lead',
    from_id: headLead.id,
    thread: ADMIT_THREAD,
    at: NOW.toISOString(),
  });
  const localOnlyCaller: Caller = { kind: 'seat', name: 'localonly', pane: 'pane-sub-local', session: 'sub' };
  const notAdmittedIo = testIo(subRoot, localOnlyCaller);
  const notAdmittedCode = await runReply([ADMIT_THREAD, 'reply when not admitted'], notAdmittedIo, {
    home,
    now: () => NOW,
    newId: () => REPLY,
    send: crossSendHost,
  });
  expect(notAdmittedCode).toBe(1);
  expect(notAdmittedIo.err).toContain('no rule admits the send');
  expect(crossFrames).toEqual([]);
  expect(hook.hits).toEqual([]);
  expect(pane.typed).toEqual([]);
});

test('probe 4: webhook is posted at most once when reply webhook walks race on the same claim, and a locked target seat posts nothing', async () => {
  // Barrier webhook server: holds the first HTTP POST until released so a racing walk hits the active `.posting` claim.
  const hits: { method: string; body: string }[] = [];
  let releaseFirstPost!: () => void;
  let hookUrl = '';
  const firstPostArrived = new Promise<void>((resolve) => {
    let notified = false;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const body = await request.text();
        hits.push({ method: request.method, body });
        if (!notified) {
          notified = true;
          resolve();
          await new Promise<void>((r) => {
            releaseFirstPost = r;
          });
        }
        return Response.json({ ok: true });
      },
    });
    stops.push(() => server.stop(true));
    hookUrl = `http://127.0.0.1:${server.port}/routine`;
  });
  const hookPaths = hookFiles(hookUrl);
  stops.push(() => rmSync(dirname(hookPaths.urlFile), { recursive: true, force: true }));

  made = world(['drop'], [{ name: 'iris', role: 'remote', cli: 'gemini', launch: 'gemini', webhook: hookPaths }]);
  sentToOwner(made, 'iris');

  // 1. If the target seat lock is held by a concurrent operation, `runReply` refuses before writing or posting.
  const heldLock = acquireSeatLock(made.dir, 'acme', 'iris');
  if (!('release' in heldLock)) throw new Error('expected seat lock to be acquired');
  try {
    const busyRes = await run(made, { agents: () => [{ name: 'iris', pane: 'pane-iris' }] });
    expect(busyRes.code).toBe(1);
    expect(busyRes.err).toContain('iris: another command holds it');
    expect(hits).toEqual([]);
  } finally {
    heldLock.release();
  }

  // 2. Two concurrent webhook walks racing on the same reply record:
  // Run `runReply` once to start the first webhook POST (which pauses inside the HTTP handler with `<REPLY>.posting` held),
  // then race a second `walkReplyDelivery` on the exact same signed reply record while the first POST is in flight.
  const firstReplyPromise = run(made, { agents: () => [{ name: 'iris', pane: 'pane-iris' }] });
  await firstPostArrived;

  const loaded = readTeamConfig(made.root, { home: made.home });
  if (!loaded.ok) throw new Error('failed to load team config');
  const storedReply = readRecord(join(recordDir(made.root, 'acme', 'iris'), REPLY));
  if (!storedReply.ok || storedReply.record === null) throw new Error('expected reply record on disk');

  const racingWalk = await walkReplyDelivery({
    io: testIo(made.root),
    host: fake(made, { agents: () => [{ name: 'iris', pane: 'pane-iris' }] }),
    dir: made.dir,
    root: made.root,
    project: 'acme',
    session: 'acme',
    seat: 'iris',
    cli: 'gemini',
    payload: storedReply.record.payload,
    naming: defaultNaming(),
    file: loaded.team,
    sender: { teamId: teamIdOf(made.root), project: 'acme', label: null },
    address: null,
    who: 'owner',
  });
  expect(racingWalk.via).toBe('webhook');
  expect(racingWalk.unconfirmed).toBe(true);
  expect(racingWalk.summary).toMatch(/^iris: sent \(unconfirmed\) \(webhook, \d+ ms; the bus is posting it\)$/);
  // Still only 1 HTTP POST while in flight.
  expect(hits).toHaveLength(1);

  releaseFirstPost();
  const firstReply = await firstReplyPromise;
  expect(firstReply.code).toBe(0);
  expect(firstReply.out).toMatch(/^team acme, session "acme"\niris: delivered \(webhook, \d+ ms\)\n$/);
  expect(hits).toHaveLength(1);

  // 3. A subsequent walk after `<REPLY>.posted` is on disk sees `already-posted` and makes no second HTTP POST.
  const afterPostedWalk = await walkReplyDelivery({
    io: testIo(made.root),
    host: fake(made, { agents: () => [{ name: 'iris', pane: 'pane-iris' }] }),
    dir: made.dir,
    root: made.root,
    project: 'acme',
    session: 'acme',
    seat: 'iris',
    cli: 'gemini',
    payload: storedReply.record.payload,
    naming: defaultNaming(),
    file: loaded.team,
    sender: { teamId: teamIdOf(made.root), project: 'acme', label: null },
    address: null,
    who: 'owner',
  });
  expect(afterPostedWalk.via).toBe('webhook');
  expect(afterPostedWalk.unconfirmed).toBe(false);
  expect(afterPostedWalk.summary).toMatch(/^iris: delivered \(webhook, \d+ ms\)$/);
  expect(hits).toHaveLength(1);
});

