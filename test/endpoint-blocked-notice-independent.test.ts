// A Codex endpoint that is down writes one signed notice to the lead, across sends and replies.
// After that endpoint is listening again, the next outage writes one new notice. The notice
// reaches the lead through the drop. Channel admission refuses a runtime record.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { runSend, walkReplyDelivery, type SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { admitChannelDelivery } from '../src/mcp/channel-admit.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { signedRecordOf, verifyRecord } from '../src/send/record.ts';
import { defaultNaming } from '../src/send/names.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, shortSocketBase, testIo } from './helpers.ts';

const NOW = new Date('2026-11-06T16:40:00.000Z');
const SESSION = 'scratch';
const LEAD = 'guide';
const SEAT = 'hand';
const THREAD = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
const BINDING = 'prs_0123456789ab';
const RUNTIME_FROM = 'runtime';
const RUNTIME_RULE = "the team's unread-message report";

let scratch = '';
let socketDir = '';

afterEach(() => {
  const paths = [scratch, socketDir].filter((path) => path !== '');
  if (paths.length > 0) discardFixtures(paths, { roots: [dirname(scratch || paths[0]!), shortSocketBase()] });
  scratch = '';
  socketDir = '';
});

function leadDrops(root: string): string[] {
  const dir = join(root, '.agents', 'send-drops', SESSION, LEAD);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => !name.startsWith('.'));
}

function prepare(): { root: string; home: string; sockets: string; binDir: string; socketPath: string } {
  scratch = fixtureBase('endpoint-notice-');
  socketDir = mkdtempSync(join(shortSocketBase(), 'epn-'));
  const home = join(scratch, 'home');
  const root = join(scratch, 'repo');
  const sockets = join(scratch, 'sockets');
  const binDir = join(scratch, 'bin');
  const socketPath = join(socketDir, 'app.sock');
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q'], {
    cwd: root,
    env: gitEnv(),
    stdio: 'ignore',
  });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
session: ${SESSION}
coordinator: ${LEAD}
operator: ${LEAD}
workspace:
  mode: shared
  base: main
trust:
  - ${lobbyDir(home)}
  - ${root}
seats:
  - role: coordinator
    name: ${LEAD}
    label: ${LEAD}
    cli: claude-code
    vendor: example
    model: Example
    version: "1"
    launch: claude
  - role: implementer
    name: ${SEAT}
    label: ${SEAT}
    cli: codex
    vendor: example
    model: Example
    version: "1"
    launch: codex
    delivery_order: [native, drop]
`, { mode: 0o600 });
  writeFileSync(join(root, '.agents', 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: {
      [SESSION]: {
        seats: {
          [SEAT]: {
            id: 'seat_123456789abc',
            stage: 'ready',
            pane: 'fixture-pane-one',
            agent_session: THREAD,
            presence_binding: BINDING,
            codex_endpoint: {
              url: `unix://${socketPath}`,
              binding: BINDING,
              pid: 4242,
              started_at: '2026-11-06T16:39:00.000Z',
            },
          },
        },
        worktrees: {},
      },
    },
  })}\n`, { mode: 0o600 });
  registerAgent(home, {
    name: SEAT,
    signing: { model: 'Example', version: '1', role: 'implementer' },
    lab: 'test',
    cli: 'codex',
    launcher: null,
    launch: 'codex',
    seat_handle: 'seat_123456789abc',
    reach: {
      team: teamIdOf(root),
      seat: SEAT,
      session: SESSION,
      agent_session: THREAD,
      pane: 'fixture-pane-one',
      address: null,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  writeFileSync(join(binDir, 'codex'), `#!/bin/sh
exit 0
`, { mode: 0o755 });
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return { root: realpathSync(root), home, sockets, binDir, socketPath };
}

function hostOf(home: string, sockets: string): SendHost {
  return {
    agents: () => [{ name: SEAT, pane: 'fixture-pane-one', cli: 'codex' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: sockets,
    deliver: async () => {
      throw new Error('the socket was dialed');
    },
    native: {
      typeText: () => false,
      pressEnter: () => false,
      status: () => 'idle',
      wait: async () => {},
      paneText: () => '',
    },
    now: () => NOW,
    home,
    inboxGraceMs: 20,
  };
}

function withCodex(binDir: string, run: () => Promise<void>): Promise<void> {
  const saved = {
    path: process.env.PATH,
    codexHome: process.env.CODEX_HOME,
  };
  process.env.PATH = `${binDir}:${saved.path ?? ''}`;
  process.env.CODEX_HOME = dirname(binDir);
  return run().finally(() => {
    if (saved.path === undefined) delete process.env.PATH;
    else process.env.PATH = saved.path;
    if (saved.codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved.codexHome;
  });
}

function serverFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
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
    }
    const maskLen = masked ? 4 : 0;
    const total = headerLen + maskLen + length;
    if (offset + total > buffer.length) break;
    const start = offset + headerLen + maskLen;
    if (opcode === 0x1 && masked) {
      const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      const payload = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) payload[i] = (buffer[start + i] as number) ^ (mask[i % 4] as number);
      texts.push(payload.toString('utf8'));
    }
    offset += total;
  }
  return { texts, rest: buffer.subarray(offset) };
}

async function listen(socketPath: string): Promise<{ close: () => Promise<void> }> {
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
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
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
          socket.write(serverFrame(JSON.stringify({ id: 'initialize', result: {} })));
        } else if (msg.id === 'thread_read') {
          const threadId = typeof msg.params?.threadId === 'string' ? msg.params.threadId : THREAD;
          socket.write(serverFrame(JSON.stringify({
            id: 'thread_read',
            result: { thread: { id: threadId, status: { type: 'idle' }, canAcceptDirectInput: true } },
          })));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (existsSync(socketPath)) unlinkSync(socketPath);
    },
  };
}

async function replyOnce(root: string, home: string, sockets: string, id: string): Promise<void> {
  await walkReplyDelivery({
    io: testIo(root, { kind: 'owner' }),
    host: hostOf(home, sockets),
    dir: join(root, '.agents'),
    root,
    project: 'acme',
    session: SESSION,
    seat: SEAT,
    cli: 'codex',
    file: null,
    address: null,
    who: LEAD,
    sender: { teamId: teamIdOf(root), project: 'acme', label: LEAD },
    naming: defaultNaming(teamIdOf(root)),
    payload: {
      kind: 'message',
      id,
      to: SEAT,
      to_id: null,
      root,
      session: SESSION,
      at: NOW.toISOString(),
      body: 'from guide — admitted by: a seat of its own team\n\nreply',
      from: LEAD,
      from_id: null,
      rule: 'a seat of its own team',
      thread: id,
    },
  });
}

function signedNotices(root: string, home: string): { from: string; rule: string }[] {
  return leadDrops(root).map((name) => {
    const sealed = signedRecordOf(JSON.parse(readFileSync(join(root, '.agents', 'send-drops', SESSION, LEAD, name), 'utf8')));
    expect(sealed, name).not.toBeNull();
    if (sealed === null) return { from: '', rule: '' };
    expect(verifyRecord(sealed, messageKeyOf(home))).toBe(true);
    return { from: sealed.payload.from, rule: sealed.payload.rule };
  });
}

test('a down endpoint writes one notice across sends and replies, then one more after it recovers', async () => {
  const scene = prepare();
  await withCodex(scene.binDir, async () => {
    const host = hostOf(scene.home, scene.sockets);
    const first = testIo(scene.root, { kind: 'owner' });
    expect(await runSend([SEAT, 'one'], first, host), first.out + first.err).toBe(0);
    const second = testIo(scene.root, { kind: 'owner' });
    expect(await runSend([SEAT, 'two'], second, host), second.out + second.err).toBe(0);
    await replyOnce(scene.root, scene.home, scene.sockets, '33333333-0000-4000-8000-000000000301');
    await replyOnce(scene.root, scene.home, scene.sockets, '33333333-0000-4000-8000-000000000302');
    expect(leadDrops(scene.root)).toHaveLength(1);
    const notices = signedNotices(scene.root, scene.home);
    expect(notices).toEqual([{ from: RUNTIME_FROM, rule: RUNTIME_RULE }]);

    const server = await listen(scene.socketPath);
    try {
      const recovered = testIo(scene.root, { kind: 'owner' });
      expect(await runSend([SEAT, 'listening'], recovered, host), recovered.out + recovered.err).toBe(0);
    } finally {
      await server.close();
    }
    expect(leadDrops(scene.root)).toHaveLength(1);

    const again = testIo(scene.root, { kind: 'owner' });
    expect(await runSend([SEAT, 'down again'], again, host), again.out + again.err).toBe(0);
    await replyOnce(scene.root, scene.home, scene.sockets, '33333333-0000-4000-8000-000000000303');
    expect(leadDrops(scene.root)).toHaveLength(2);
    expect(signedNotices(scene.root, scene.home).every((notice) => notice.from === RUNTIME_FROM && notice.rule === RUNTIME_RULE)).toBe(true);
  });
});

test('channel admission refuses a runtime record', () => {
  const scene = prepare();
  const loaded = loadTeamFile(scene.root, { home: scene.home });
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const refused = admitChannelDelivery({
    payload: { from: RUNTIME_FROM, from_id: null, to: LEAD, to_id: null, rule: RUNTIME_RULE },
    home: scene.home,
    root: scene.root,
    session: SESSION,
    seat: LEAD,
    team: loaded.team,
  });
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.why).toContain('must name its recipient agent id');
});
