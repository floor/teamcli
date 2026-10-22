// The seat's inbox server as a Claude Code channel: a launch that carries the development
// channel naming `team-inbox` makes the server declare `experimental["claude/channel"]`, push
// each message that arrives after it starts as one `notifications/claude/channel`, and serve the
// `ack` tool that writes the same signed read receipt as `team ack` with `read_by: channel`.
// A launch without the flag is the ordinary inbox server: no capability, no instructions, no
// push, no ack. Fixtures only: synthetic folders, a synthetic home, and a launch line this test
// writes; no live session is touched.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenerPath, receiptPath } from '../src/mcp/inbox.ts';
import { channelPushPath } from '../src/mcp/channel.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { signRecord, verifyReceipt, type SignedReceipt } from '../src/send/record.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const SESSION = 'acme';
const FLAG = '--dangerously-load-development-channels server:team-inbox';
const PUSHED_ID = 'aaaaaaaa-0000-4000-8000-000000000101';
const ACKED_ID = 'bbbbbbbb-0000-4000-8000-000000000102';
const UNKNOWN_ID = 'cccccccc-0000-4000-8000-000000000103';

function teamText(launch: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: ${launch}
`;
}

type Place = {
  root: string;
  home: string;
  dropDir: string;
  cleanup(): void;
};

function place(launch = `claude ${FLAG}`): Place {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-channel-')));
  mkdirSync(join(root, '.agents'));
  mkdirSync(join(root, 'home'), { mode: 0o700 });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText(launch));
  return {
    root,
    home: join(root, 'home'),
    dropDir: join(root, '.agents', 'send-drops', SESSION, 'lead'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A message record signed by this fixture's home, under `id`, in the lead's inbox. */
function signed(at: Place, id: string, body: string): void {
  const record = signRecord({
    kind: 'message',
    id,
    to: 'lead',
    to_id: null,
    root: realpathSync(at.root),
    session: SESSION,
    at: '2026-10-22T09:00:00.000Z',
    body,
    from: 'worker',
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, at.home);
  mkdirSync(at.dropDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(at.dropDir, id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function queue(): { lines: AsyncIterable<string>; write(line: string): void; push(line: string): void; end(): void; replies: string[] } {
  const pending: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const replies: string[] = [];
  const lines = (async function* () {
    for (;;) {
      if (pending.length > 0) {
        yield pending.shift()!;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  const bump = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return {
    lines,
    write: (line) => replies.push(line),
    push: (line) => {
      pending.push(line);
      bump();
    },
    end: () => {
      ended = true;
      bump();
    },
    replies,
  };
}

function call(id: string, name: string, args?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, ...(args ? { arguments: args } : {}) } });
}

function notice(replies: readonly string[]): Record<string, any>[] {
  return replies
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((one) => one.method === 'notifications/claude/channel');
}

async function until(check: () => boolean, limit = 400): Promise<void> {
  for (let at = 0; at < limit && !check(); at += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function preloaded(root: string, home: string, lines: readonly string[]) {
  const io = testIo(root);
  const replies: string[] = [];
  const code = await runMcpServe({ seat: 'lead', session: SESSION }, io, {
    lines: (async function* () {
      for (const line of lines) yield line;
    })(),
    write: (line) => replies.push(line),
  }, { home });
  return { code, io, replies: replies.map((line) => JSON.parse(line) as Record<string, any>) };
}

describe('the channel declaration', () => {
  test('a launch with the development channel declares claude/channel, its one instruction, and ack', async () => {
    const at = place();
    try {
      const { code, io, replies } = await preloaded(at.root, at.home, [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      ]);
      expect(code).toBe(0);
      expect(io.out).toBe('');
      expect(io.err).toBe('');
      expect(replies[0]!.result.capabilities).toEqual({ tools: {}, experimental: { 'claude/channel': {} } });
      // The launch's protocol negotiation is pinned to the legacy revision, and the declaration
      // answers in the same one: the channel is loaded on 2024-11-05, never a newer revision.
      expect(replies[0]!.result.protocolVersion).toBe('2024-11-05');
      expect(replies[0]!.result.instructions).toContain('call the ack tool');
      expect(replies[1]!.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['inbox_check', 'inbox_read', 'ack']);
    } finally {
      at.cleanup();
    }
  });

  test('a launch without the flag is the ordinary inbox server: no capability, no instructions, no ack', async () => {
    const at = place('claude');
    try {
      const { replies } = await preloaded(at.root, at.home, [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      ]);
      expect(replies[0]!.result.capabilities).toEqual({ tools: {} });
      expect(replies[0]!.result).not.toHaveProperty('instructions');
      expect(replies[1]!.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['inbox_check', 'inbox_read']);
    } finally {
      at.cleanup();
    }
  });
});

describe('the push', () => {
  test('a record that arrives while the server runs is pushed once, with its header and id-only meta', async () => {
    const at = place();
    try {
      const io = testIo(at.root);
      const feed = queue();
      const running = runMcpServe({ seat: 'lead', session: SESSION }, io, feed, { home: at.home });
      await until(() => existsSync(listenerPath(at.dropDir)));
      // Nothing waiting at startup is pushed: a fresh session starts quiet.
      signed(at, PUSHED_ID, 'from a worker — admitted by: the owner\n\nhello there');
      await until(() => notice(feed.replies).length >= 1);
      const pushed = notice(feed.replies);
      expect(pushed).toHaveLength(1);
      expect(pushed[0]!.params.meta).toEqual({ id: PUSHED_ID, from: 'worker', seat: 'lead', team: 'acme' });
      const content = pushed[0]!.params.content as string;
      // The content opens with the message-display header, then the signed body whole.
      expect(content.split('\n')[0]).toContain('worker');
      expect(content).toContain('hello there');
      const marker = JSON.parse(readFileSync(channelPushPath(at.dropDir, PUSHED_ID), 'utf8')) as Record<string, unknown>;
      expect(marker).toMatchObject({ v: 1, kind: 'channel-push', id: PUSHED_ID, seat: 'lead', session: SESSION, status: 'sent (channel)' });
      expect(String(marker.content_sha256)).toHaveLength(64);
      expect(statSync(channelPushPath(at.dropDir, PUSHED_ID)).mode & 0o777).toBe(0o600);
      // The signed record is untouched: no receipt was written by the push.
      expect(existsSync(receiptPath(at.dropDir, PUSHED_ID))).toBe(false);
      // A record already holding a marker is never pushed a second time.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(notice(feed.replies)).toHaveLength(1);
      feed.end();
      expect(await running).toBe(0);
    } finally {
      at.cleanup();
    }
  });

  test('ack writes the signed read receipt with read_by channel, and the message is not pushed again', async () => {
    const at = place();
    try {
      const io = testIo(at.root);
      const feed = queue();
      const running = runMcpServe({ seat: 'lead', session: SESSION }, io, feed, { home: at.home });
      await until(() => existsSync(listenerPath(at.dropDir)));
      signed(at, ACKED_ID, 'from a worker — admitted by: the owner\n\nack me');
      await until(() => notice(feed.replies).length >= 1);
      feed.push(call('7', 'ack', { id: ACKED_ID }));
      await until(() => feed.replies.some((line) => JSON.parse(line).id === '7'));
      const answer = feed.replies.map((line) => JSON.parse(line) as Record<string, any>).find((one) => one.id === '7')!;
      expect(answer.result.isError).toBeUndefined();
      const receipt = JSON.parse(readFileSync(receiptPath(at.dropDir, ACKED_ID), 'utf8')) as SignedReceipt;
      expect(receipt.payload).toMatchObject({ kind: 'receipt', status: 'read', id: ACKED_ID, to: 'lead', session: SESSION, read_by: 'channel' });
      const key = messageKeyState(at.home);
      expect(key.kind).toBe('key');
      if (key.kind !== 'key') throw new Error('the fixture home holds no message key');
      expect(verifyReceipt(receipt, key.key)).toBe(true);
      const before = notice(feed.replies).length;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(notice(feed.replies)).toHaveLength(before);
      feed.end();
      expect(await running).toBe(0);
    } finally {
      at.cleanup();
    }
  });

  test('an ack for an id this inbox does not hold is refused, and writes nothing', async () => {
    const at = place();
    try {
      const io = testIo(at.root);
      const feed = queue();
      const running = runMcpServe({ seat: 'lead', session: SESSION }, io, feed, { home: at.home });
      await until(() => existsSync(listenerPath(at.dropDir)));
      feed.push(call('8', 'ack', { id: UNKNOWN_ID }));
      await until(() => feed.replies.some((line) => JSON.parse(line).id === '8'));
      const answer = feed.replies.map((line) => JSON.parse(line) as Record<string, any>).find((one) => one.id === '8')!;
      expect(answer.result.isError).toBe(true);
      expect(existsSync(receiptPath(at.dropDir, UNKNOWN_ID))).toBe(false);
      feed.end();
      expect(await running).toBe(0);
    } finally {
      at.cleanup();
    }
  });
});
