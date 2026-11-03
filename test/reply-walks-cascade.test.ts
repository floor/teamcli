// `team reply` delivers through the owner's cascade: the receiving seat's channel-class legs,
// then the sender-posted webhook, then the profile-gated typed wake, with the bus inbox under all
// of them. The reply rules themselves are unchanged — admission, the thread, and the read the
// answer marks — so these scenes pin the delivery half only: the leg the reply took is the leg it
// prints, a socket that refuses falls to the webhook behind it, the read receipts still land, and
// a record addressed to another seat is still refused before any frame is dialed.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { runReply, type ReplyHost } from '../src/commands/reply.ts';
import type { SendHost } from '../src/commands/send.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { signedReceiptOf, verifyReceipt } from '../src/send/record.ts';
import { readHistory } from '../src/send/history.ts';
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
