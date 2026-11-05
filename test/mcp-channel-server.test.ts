// The seat's inbox server as a Claude Code channel: a launch that carries the development
// channel naming `team-inbox` makes the server declare `experimental["claude/channel"]`, push
// each message that arrives after it starts as one `notifications/claude/channel`. A push is a
// transport reservation, never a consumer read. The `ack` tool writes the same signed receipt as
// `team ack` with `read_by: channel`; inbox reads also settle pushed messages. An ignored push
// survives server restart and remains eligible for the watch's bounded recovery.
// A launch without the flag is the ordinary inbox server: no capability, no instructions, no
// push, no ack. Fixtures only: synthetic folders, a synthetic home, and a launch line this test
// writes; no live session is touched.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenerPath, receiptPath } from '../src/mcp/inbox.ts';
import { CHANNEL_CONFIRM_MS, CHANNEL_UNCONFIRMED, channelPushPath } from '../src/mcp/channel.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { runReply } from '../src/commands/reply.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { markPending, readPending } from '../src/send/pending.ts';
import { signRecord, verifyReceipt, type RecordPayload, type SignedReceipt } from '../src/send/record.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { retryHeldDrops, type RetryScene } from '../src/watch/retry.ts';
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
  - role: worker
    name: worker
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;
}

type Place = {
  root: string;
  home: string;
  dropDir: string;
  leadId: string;
  workerId: string;
  cleanup(): void;
};

function place(launch = `claude ${FLAG}`): Place {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-channel-')));
  mkdirSync(join(root, '.agents'));
  mkdirSync(join(root, 'home'), { mode: 0o700 });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText(launch));
  // The state `team up` leaves: the server proves its caller stands on lead's recorded pane.
  writeFileSync(
    join(root, '.agents', 'team.state.json'),
    `${JSON.stringify({ format: 1, sessions: { [SESSION]: { seats: { lead: { stage: 'ready', pane: 'pane-lead' }, worker: { stage: 'ready', pane: 'pane-worker' } }, worktrees: {} } } })}\n`,
  );
  const home = join(root, 'home');
  const teamId = teamIdOf(root);
  // Roster membership alone cannot resolve a signed from_id: the sender lookup also requires
  // a live agent file with matching team, seat and session. Register both synthetic agents.
  const agents = (['lead', 'worker'] as const).map((seat) => registerAgent(home, {
    name: seat,
    signing: { model: 'Test', version: '1', role: seat === 'lead' ? 'coordinator' : 'worker' },
    lab: 'test', cli: 'claude-code', launcher: null,
    launch: seat === 'lead' ? launch : 'claude',
    reach: { team: teamId, seat, session: SESSION, pane: `pane-${seat}`, address: null },
    mcp: [], skills: [], lifecycle: 'running', by: 'owner',
  }));
  // A server started with no --file resolves its team from the registry record holding the seat.
  upsertTeam(home, teamId, {
    project: 'acme',
    session: SESSION,
    root,
    roster: agents.map((agent) => ({ agent: agent.id, seat: agent.reach.seat, role: agent.signing.role })),
  });
  return {
    root,
    home,
    dropDir: join(root, '.agents', 'send-drops', SESSION, 'lead'),
    leadId: agents[0]!.id,
    workerId: agents[1]!.id,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A message record signed by this fixture's home, under `id`, in the lead's inbox. */
function signed(at: Place, id: string, body: string, extra: Partial<RecordPayload> = {}): void {
  const record = signRecord({
    kind: 'message',
    id,
    to: 'lead',
    to_id: at.leadId,
    root: realpathSync(at.root),
    session: SESSION,
    at: '2026-10-22T09:00:00.000Z',
    body,
    from: 'worker',
    from_id: at.workerId,
    rule: 'the owner',
    thread: id,
    ...extra,
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

/** A fake client explicitly calls a tool; merely capturing a notification calls nothing. */
async function tool(feed: ReturnType<typeof queue>, request: string, name: string, args?: Record<string, unknown>): Promise<Record<string, any>> {
  feed.push(call(request, name, args));
  await until(() => feed.replies.some((line) => JSON.parse(line).id === request));
  const reply = feed.replies.map((line) => JSON.parse(line) as Record<string, any>).find((one) => one.id === request);
  expect(reply).toBeDefined();
  return reply!.result;
}

/** The actual watch retry path, with only its socket transport replaced by a fake client. */
function recovery(at: Place, now: Date, sockets: string[]): RetryScene {
  const loaded = loadTeamFile(at.root, { home: at.home });
  if (!loaded.ok) throw new Error('fixture team failed to load');
  return {
    dir: join(at.root, '.agents'), root: at.root, home: at.home, session: SESSION,
    team: loaded.team, now, ownPane: null,
    live: {
      running: true,
      agents: [{ name: 'lead', agent: 'claude', pane: 'pane-lead', workspace: 'first', status: 'idle', cwd: null }],
      workspaces: [], screens: {},
    },
    sources: {
      screen: () => { throw new Error('recovery must not read a pane'); },
      status: () => 'idle',
      typeText: () => { throw new Error('recovery must not type into a pane'); },
      pressEnter: () => { throw new Error('recovery must not submit a pane'); },
      sleep: async () => {},
    },
    socketRedeliver: async (_dir, drop) => {
      expect(drop.redelivered).toBe(CHANNEL_UNCONFIRMED);
      sockets.push(drop.id);
      return { ok: true };
    },
    say: () => {},
  };
}

function notice(replies: readonly string[]): Record<string, any>[] {
  return replies
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((one) => one.method === 'notifications/claude/channel');
}

async function until(check: () => boolean, limit = 400): Promise<void> {
  for (let at = 0; at < limit && !check(); at += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** The caller lead's own launch line places: the seat, on its recorded pane, in the session. */
function seatCaller(): { kind: 'seat'; name: string; pane: string; session: string } {
  return { kind: 'seat', name: 'lead', pane: 'pane-lead', session: SESSION };
}

async function preloaded(root: string, home: string, lines: readonly string[]) {
  const io = testIo(root, seatCaller());
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
      const io = testIo(at.root, seatCaller());
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
      // Capturing the stdio write is not a consumer acknowledgement. The reservation prevents
      // duplicate wakes while the inbox still lists the message as unread.
      expect(existsSync(receiptPath(at.dropDir, PUSHED_ID))).toBe(false);
      const checked = await tool(feed, '9', 'inbox_check');
      expect(JSON.parse(checked.content[0].text).unread.map((one: { id: string }) => one.id)).toEqual([PUSHED_ID]);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(notice(feed.replies)).toHaveLength(1);
      expect(existsSync(receiptPath(at.dropDir, PUSHED_ID))).toBe(false);
      feed.end();
      expect(await running).toBe(0);
    } finally {
      at.cleanup();
    }
  });

  test('the notification carries the content and meta only: no key object rides in a frame shown to an agent', async () => {
    const at = place();
    try {
      const io = testIo(at.root, seatCaller());
      const feed = queue();
      const running = runMcpServe({ seat: 'lead', session: SESSION }, io, feed, { home: at.home });
      await until(() => existsSync(listenerPath(at.dropDir)));
      signed(at, PUSHED_ID, 'from a worker — admitted by: the owner\n\nhello there');
      await until(() => notice(feed.replies).length >= 1);
      // The raw line the client receives contains content and meta alone.
      const raw = feed.replies.find((one) => (JSON.parse(one) as Record<string, any>).method === 'notifications/claude/channel')!;
      expect(raw).not.toContain('"key"');
      const params = (JSON.parse(raw) as Record<string, any>).params;
      expect(Object.keys(params)).toEqual(['content', 'meta']);
      feed.end();
      expect(await running).toBe(0);
    } finally {
      at.cleanup();
    }
  });

  test('explicit ack settles a pushed message once and prevents fallback; duplicate ack preserves the receipt', async () => {
    const at = place();
    const feed = queue();
    const running = runMcpServe({ seat: 'lead', session: SESSION }, testIo(at.root, seatCaller()), feed, { home: at.home });
    try {
      await until(() => existsSync(listenerPath(at.dropDir)));
      signed(at, PUSHED_ID, 'ack this push');
      const sent = new Date();
      markPending(at.dropDir, { id: PUSHED_ID, from: 'worker', to: 'lead', body: 'ack this push', ts: sent.toISOString(), leg: 'channel', thread: PUSHED_ID });
      await until(() => notice(feed.replies).length === 1);
      expect(notice(feed.replies)).toHaveLength(1);
      expect(existsSync(receiptPath(at.dropDir, PUSHED_ID))).toBe(false);

      const first = await tool(feed, 'first', 'ack', { id: PUSHED_ID });
      expect(first.isError).toBeUndefined();
      expect(JSON.parse(first.content[0].text)).toEqual({ acknowledged: PUSHED_ID, written: true });
      const before = readFileSync(receiptPath(at.dropDir, PUSHED_ID), 'utf8');
      const receipt = JSON.parse(before) as SignedReceipt;
      expect(receipt.payload).toMatchObject({ status: 'read', id: PUSHED_ID, read_by: 'channel', to: 'lead', session: SESSION });
      const key = messageKeyState(at.home);
      if (key.kind !== 'key') throw new Error('fixture key missing');
      expect(verifyReceipt(receipt, key.key)).toBe(true);

      const duplicate = await tool(feed, 'duplicate', 'ack', { id: PUSHED_ID });
      expect(JSON.parse(duplicate.content[0].text)).toEqual({ acknowledged: PUSHED_ID, written: false });
      expect(readFileSync(receiptPath(at.dropDir, PUSHED_ID), 'utf8')).toBe(before);
      expect(JSON.parse((await tool(feed, 'unread', 'inbox_check')).content[0].text)).toEqual({ unread: [] });
      const sockets: string[] = [];
      await retryHeldDrops(recovery(at, new Date(sent.getTime() + CHANNEL_CONFIRM_MS + 1), sockets));
      expect(sockets).toEqual([]);
      expect(readPending(at.dropDir)).toEqual([]);
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });

  test('inbox_read can consume a pushed message before ack; later ack does not replace that receipt', async () => {
    const at = place();
    const feed = queue();
    const running = runMcpServe({ seat: 'lead', session: SESSION }, testIo(at.root, seatCaller()), feed, { home: at.home });
    try {
      await until(() => existsSync(listenerPath(at.dropDir)));
      signed(at, PUSHED_ID, 'read the pushed body');
      await until(() => notice(feed.replies).length === 1);
      expect(notice(feed.replies)).toHaveLength(1);
      expect(existsSync(receiptPath(at.dropDir, PUSHED_ID))).toBe(false);
      const read = await tool(feed, 'read', 'inbox_read', { id: PUSHED_ID });
      expect(read.isError).toBeUndefined();
      expect(read.content[0].text).toBe('from worker (owner):\n\nread the pushed body');
      const before = readFileSync(receiptPath(at.dropDir, PUSHED_ID), 'utf8');
      const receipt = JSON.parse(before) as SignedReceipt;
      expect(receipt.payload.read_by).not.toBe('channel-push');
      const key = messageKeyState(at.home);
      if (key.kind !== 'key') throw new Error('fixture key missing');
      expect(verifyReceipt(receipt, key.key)).toBe(true);
      const acked = await tool(feed, 'ack-after-read', 'ack', { id: PUSHED_ID });
      expect(JSON.parse(acked.content[0].text)).toEqual({ acknowledged: PUSHED_ID, written: false });
      expect(readFileSync(receiptPath(at.dropDir, PUSHED_ID), 'utf8')).toBe(before);
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });

  test('an explicit reply settles an unacknowledged push and later ack preserves its read receipt', async () => {
    const at = place();
    const feed = queue();
    const running = runMcpServe({ seat: 'lead', session: SESSION }, testIo(at.root, seatCaller()), feed, { home: at.home });
    try {
      await until(() => existsSync(listenerPath(at.dropDir)));
      signed(at, PUSHED_ID, 'answer this push');
      await until(() => notice(feed.replies).length === 1);
      expect(notice(feed.replies)).toHaveLength(1);
      expect(existsSync(receiptPath(at.dropDir, PUSHED_ID))).toBe(false);
      const replyIo = testIo(at.root, seatCaller());
      const replied = await runReply([PUSHED_ID, 'the explicit answer'], replyIo, {
        home: at.home,
        now: () => new Date('2026-10-22T09:00:01.000Z'),
        newId: () => ACKED_ID,
      });
      expect(replied, replyIo.err).toBe(0);
      const before = readFileSync(receiptPath(at.dropDir, PUSHED_ID), 'utf8');
      const receipt = JSON.parse(before) as SignedReceipt;
      expect(receipt.payload.read_by).toBe('reply');
      const key = messageKeyState(at.home);
      if (key.kind !== 'key') throw new Error('fixture key missing');
      expect(verifyReceipt(receipt, key.key)).toBe(true);
      expect(existsSync(join(at.dropDir, `${PUSHED_ID}.replied.json`))).toBe(true);
      const answer = JSON.parse(readFileSync(join(at.root, '.agents', 'send-drops', SESSION, 'worker', ACKED_ID), 'utf8'));
      expect(answer.payload).toMatchObject({ to: 'worker', from: 'lead', thread: PUSHED_ID });
      const acked = await tool(feed, 'ack-after-reply', 'ack', { id: PUSHED_ID });
      expect(JSON.parse(acked.content[0].text)).toEqual({ acknowledged: PUSHED_ID, written: false });
      expect(readFileSync(receiptPath(at.dropDir, PUSHED_ID), 'utf8')).toBe(before);
      expect(JSON.parse((await tool(feed, 'unread-after-reply', 'inbox_check')).content[0].text)).toEqual({ unread: [] });
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });

  test('a blocked ack receipt write leaves the push unread and an explicit retry can settle it', async () => {
    const at = place();
    const feed = queue();
    const running = runMcpServe({ seat: 'lead', session: SESSION }, testIo(at.root, seatCaller()), feed, { home: at.home });
    try {
      await until(() => existsSync(listenerPath(at.dropDir)));
      signed(at, PUSHED_ID, 'retry acknowledgment after the receipt path is free');
      await until(() => notice(feed.replies).length === 1);
      expect(notice(feed.replies)).toHaveLength(1);
      const path = receiptPath(at.dropDir, PUSHED_ID);
      mkdirSync(path);
      const failed = await tool(feed, 'blocked-ack', 'ack', { id: PUSHED_ID });
      expect(failed.isError).toBe(true);
      expect(failed.content[0].text).toContain('receipt name is held');
      expect(statSync(path).isDirectory()).toBe(true);
      const checked = await tool(feed, 'still-unread', 'inbox_check');
      expect(JSON.parse(checked.content[0].text).unread.map((one: { id: string }) => one.id)).toEqual([PUSHED_ID]);
      // Move the synthetic obstruction aside without changing the message or its reservation.
      renameSync(path, join(at.root, 'held-read-name'));
      const retried = await tool(feed, 'retry-ack', 'ack', { id: PUSHED_ID });
      expect(retried.isError).toBeUndefined();
      expect(JSON.parse(retried.content[0].text)).toEqual({ acknowledged: PUSHED_ID, written: true });
      const key = messageKeyState(at.home);
      if (key.kind !== 'key') throw new Error('fixture key missing');
      expect(verifyReceipt(JSON.parse(readFileSync(path, 'utf8')) as SignedReceipt, key.key)).toBe(true);
      expect(notice(feed.replies)).toHaveLength(1);
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });

  test('an ignored notification survives restart unread and takes only one fallback after the confirmation window', async () => {
    const at = place();
    const first = queue();
    const second = queue();
    let restarted: Promise<number> | undefined;
    const running = runMcpServe({ seat: 'lead', session: SESSION }, testIo(at.root, seatCaller()), first, { home: at.home });
    try {
      await until(() => existsSync(listenerPath(at.dropDir)));
      const body = 'the fake client ignores this notification';
      signed(at, PUSHED_ID, body);
      const sent = new Date();
      markPending(at.dropDir, { id: PUSHED_ID, from: 'worker', to: 'lead', body, ts: sent.toISOString(), leg: 'channel', thread: PUSHED_ID });
      await until(() => notice(first.replies).length === 1);
      expect(notice(first.replies)).toHaveLength(1);
      expect(existsSync(receiptPath(at.dropDir, PUSHED_ID))).toBe(false);
      const reservation = readFileSync(channelPushPath(at.dropDir, PUSHED_ID), 'utf8');
      first.end();
      expect(await running).toBe(0);

      restarted = runMcpServe({ seat: 'lead', session: SESSION }, testIo(at.root, seatCaller()), second, { home: at.home });
      await until(() => existsSync(listenerPath(at.dropDir)));
      const check = await tool(second, 'after-restart', 'inbox_check');
      expect(JSON.parse(check.content[0].text).unread.map((one: { id: string }) => one.id)).toEqual([PUSHED_ID]);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(notice(second.replies)).toEqual([]);
      expect(readFileSync(channelPushPath(at.dropDir, PUSHED_ID), 'utf8')).toBe(reservation);

      const sockets: string[] = [];
      await retryHeldDrops(recovery(at, new Date(sent.getTime() + CHANNEL_CONFIRM_MS - 1), sockets));
      expect(sockets).toEqual([]);
      expect(readPending(at.dropDir)).toHaveLength(1);
      await retryHeldDrops(recovery(at, new Date(sent.getTime() + CHANNEL_CONFIRM_MS + 1), sockets));
      expect(sockets).toEqual([PUSHED_ID]);
      expect(readPending(at.dropDir)).toEqual([]);
      expect(existsSync(receiptPath(at.dropDir, PUSHED_ID))).toBe(false);
      // A new watch pass after the recovery cannot spend the same fallback twice.
      await retryHeldDrops(recovery(at, new Date(sent.getTime() + 2 * CHANNEL_CONFIRM_MS), sockets));
      expect(sockets).toEqual([PUSHED_ID]);
      const acked = await tool(second, 'late-ack', 'ack', { id: PUSHED_ID });
      expect(JSON.parse(acked.content[0].text)).toEqual({ acknowledged: PUSHED_ID, written: true });
      expect(notice(second.replies)).toEqual([]);
    } finally {
      first.end();
      second.end();
      await running;
      await restarted;
      at.cleanup();
    }
  });

  test('ack writes the signed read receipt with read_by channel for a message no push carried', async () => {
    const at = place();
    try {
      const io = testIo(at.root, seatCaller());
      const feed = queue();
      // Mail already waiting at startup is left to inbox_check, so this record is never pushed:
      // the ack is the only writer on this path.
      signed(at, ACKED_ID, 'from a worker — admitted by: the owner\n\nack me');
      const running = runMcpServe({ seat: 'lead', session: SESSION }, io, feed, { home: at.home });
      await until(() => existsSync(listenerPath(at.dropDir)));
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
      const io = testIo(at.root, seatCaller());
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

  for (const wrong of ['recipient', 'session', 'root', 'signature'] as const) {
    test(`ack still refuses a record with the wrong ${wrong} and writes no receipt`, async () => {
      const at = place();
      try {
        const extra: Partial<RecordPayload> = wrong === 'recipient' ? { to: 'elsewhere' }
          : wrong === 'session' ? { session: 'elsewhere' }
          : wrong === 'root' ? { root: join(at.root, 'elsewhere') } : {};
        signed(at, ACKED_ID, 'never acknowledged', extra);
        if (wrong === 'signature') {
          const path = join(at.dropDir, ACKED_ID);
          const record = JSON.parse(readFileSync(path, 'utf8'));
          record.payload.body = 'changed after signing';
          writeFileSync(path, JSON.stringify(record));
        }
        const { replies, code } = await preloaded(at.root, at.home, [call('bad', 'ack', { id: ACKED_ID })]);
        expect(code).toBe(0);
        expect(replies[0]!.result.isError).toBe(true);
        expect(existsSync(receiptPath(at.dropDir, ACKED_ID))).toBe(false);
      } finally {
        at.cleanup();
      }
    });
  }

  test('a superseded launch cannot acknowledge a push from its old epoch', async () => {
    const at = place();
    const statePath = join(at.root, '.agents', 'team.state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const epoch = 'run_0123456789ab';
    const claim = {
      id: UNKNOWN_ID, at: '2026-10-22T09:00:00.000Z', incarnation: 'inc_0123456789ab',
      epoch, sha256: 'a'.repeat(64), stage: 'claimed',
    };
    state.sessions[SESSION].briefs = { lead: claim };
    writeFileSync(statePath, JSON.stringify(state));
    const feed = queue();
    const running = runMcpServe({ seat: 'lead', session: SESSION, epoch }, testIo(at.root, seatCaller()), feed, { home: at.home });
    try {
      await until(() => existsSync(listenerPath(at.dropDir)));
      signed(at, PUSHED_ID, 'pushed under the original launch');
      await until(() => notice(feed.replies).length === 1);
      expect(notice(feed.replies)).toHaveLength(1);
      expect(existsSync(receiptPath(at.dropDir, PUSHED_ID))).toBe(false);
      state.sessions[SESSION].briefs.lead.epoch = 'run_ba9876543210';
      writeFileSync(statePath, JSON.stringify(state));
      const refused = await tool(feed, 'stale-ack', 'ack', { id: PUSHED_ID });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('not the seat\'s current launch epoch');
      expect(existsSync(receiptPath(at.dropDir, PUSHED_ID))).toBe(false);
    } finally {
      feed.end();
      await running;
      at.cleanup();
    }
  });
});
