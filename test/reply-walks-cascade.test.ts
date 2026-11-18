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
  reply: Partial<ReplyHost> = {},
): Promise<Result> {
  const io = testIo(at.root, caller);
  const send = fake(at, patch);
  const host: ReplyHost = { home: at.home, now: () => NOW, newId: () => REPLY, send, ...reply };
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

test('probe 4: a locked target seat is queued, not refused, and its webhook posts its one arrival', async () => {
  // The receiving seat's lock is another command's — a watch child mid-wake — so the reply is
  // written without it and walked: the record is the message, the webhook row still posts its
  // one arrival, and no pane is typed while the holder has the seat.
  const hook = receiver();
  const hookPaths = hookFiles(hook.url);
  stops.push(() => rmSync(dirname(hookPaths.urlFile), { recursive: true, force: true }));

  made = world(['drop'], [{ name: 'iris', role: 'remote', cli: 'gemini', launch: 'gemini', webhook: hookPaths }]);
  sentToOwner(made, 'iris');

  const heldLock = acquireSeatLock(made.dir, 'acme', 'iris');
  if (!('release' in heldLock)) throw new Error('expected seat lock to be acquired');
  try {
    const busyRes = await run(made, { agents: () => [{ name: 'iris', pane: 'pane-iris' }] });
    expect(busyRes.code).toBe(0);
    expect(busyRes.err).toBe('');
    expect(busyRes.out).toMatch(/^team acme, session "acme"\niris: delivered \(webhook, \d+ ms\)\n$/);
    expect(busyRes.host.frames).toEqual([]);
    expect(hook.hits).toHaveLength(1);
    expect(existsSync(join(recordDir(made.root, 'acme', 'iris'), REPLY))).toBe(true);
  } finally {
    heldLock.release();
  }
});

test('probe 5: webhook is posted at most once when reply webhook walks race on the same claim', async () => {
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

  // Two concurrent webhook walks racing on the same reply record:
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
    sender: { teamId: teamIdOf(made.root), project: 'acme' },
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
    sender: { teamId: teamIdOf(made.root), project: 'acme' },
    address: null,
    who: 'owner',
  });
  expect(afterPostedWalk.via).toBe('webhook');
  expect(afterPostedWalk.unconfirmed).toBe(false);
  expect(afterPostedWalk.summary).toMatch(/^iris: delivered \(webhook, \d+ ms\)$/);
  expect(hits).toHaveLength(1);
});

