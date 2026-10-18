// The thread spine (§3.4): the first message's id is the thread, every record carries `thread`,
// and a reply's record and history line carry the id it answers. The feed shows a reply's
// DETAIL as `re <id>: <body>` and its derived status as `replied`; a line that does not carry
// the thread keeps the value an older line for the same message recorded.
//
// Fixtures only: a scratch checkout, a scratch home, and history lines written by hand.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFeed } from '../src/commands/feed.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { FEED_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { appendHistory, historyPath, readHistory } from '../src/send/history.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { testIo } from './helpers.ts';
import { assertMatchesOutputSchema } from './helpers/output.ts';

const NOW = new Date('2026-10-18T15:30:00.000Z');
let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function teamFile(root: string, lobby: string): string {
  return `format: 1
project: acme
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
`;
}

function world(): { root: string; home: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-thread-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamFile(root, lobbyDir(home)));
  return { root, home };
}

function hostFor(home: string, patch: Partial<SendHost> = {}): SendHost {
  return {
    agents: () => [],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: join(home, 'sockets'),
    deliver: async () => ({ ok: false, reason: 'no socket is dialled in this world' }),
    native: { typeText: () => true, pressEnter: () => true, status: () => 'idle', wait: async () => {} },
    now: () => NOW,
    home,
    // The drop leg writes the record and types nothing: the thread assertions need no pane.
    delivery: { team: ['drop'] },
    ...patch,
  };
}

type FeedDoc = { events: Array<Record<string, unknown>> };

describe('a first message opens its own thread', () => {
  test('the record and the history line name the message as its thread, and no record it answers', async () => {
    const { root, home } = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runSend(['lead', 'hello', '--json'], io, hostFor(home));
    if (code !== 0) throw new Error(`${io.out}${io.err}`);

    const doc = JSON.parse(io.out) as { ids: { sent: string } };
    const id = doc.ids.sent;
    const recordPath = join(root, '.agents', 'send-drops', 'acme', 'lead', id);
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      payload: { thread: string; in_reply_to?: string };
    };
    expect(record.payload.thread).toBe(id);
    expect(record.payload.in_reply_to).toBeUndefined();

    const history = readHistory('acme', root, home);
    if (!history.ok) throw new Error(history.reason);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.thread).toBe(id);
    expect(history.entries[0]?.in_reply_to).toBeUndefined();
  });
});

describe('a reply line carries the thread and the record it answers', () => {
  const THREAD = 'aaaaaaaa-1111-4222-8333-444455556666';
  const ANSWER = 'bbbbbbbb-1111-4222-8333-444455556666';

  function seed(root: string, home: string): void {
    const first = appendHistory('acme', root, home, {
      ts: '2026-10-18T15:00:00.000Z',
      from: 'owner',
      to: 'lead',
      body: 'from the owner\n\nquestion',
      id: THREAD,
      thread: THREAD,
      outcome: 'delivered',
      via: 'drop',
    });
    if (!first.ok) throw new Error(first.reason);
    const reply = appendHistory('acme', root, home, {
      ts: '2026-10-18T15:01:00.000Z',
      from: 'lead',
      to: 'owner',
      body: 'answer',
      id: ANSWER,
      thread: THREAD,
      in_reply_to: THREAD,
      outcome: 'answered',
      via: 'socket',
    });
    if (!reply.ok) throw new Error(reply.reason);
  }

  test('the history file round-trips both fields', () => {
    const { root, home } = world();
    seed(root, home);
    const read = readHistory('acme', root, home);
    if (!read.ok) throw new Error(read.reason);
    expect(read.entries.map((entry) => [entry.thread, entry.in_reply_to])).toEqual([
      [THREAD, undefined],
      [THREAD, THREAD],
    ]);
    const raw = readFileSync(historyPath('acme', root, home), 'utf8');
    expect(raw).toContain(`"thread":"${THREAD}"`);
  });

  test('the feed derives `replied` and names the record answered, in JSON and in the table', async () => {
    const { root, home } = world();
    seed(root, home);

    const jsonIo = testIo(root);
    expect(await runFeed(['--json'], jsonIo, { home })).toBe(0);
    const doc = assertMatchesOutputSchema<FeedDoc>(jsonIo.out, FEED_OUTPUT_SCHEMA);
    expect(doc.events).toHaveLength(2);
    expect(doc.events[0]).toMatchObject({ id: THREAD, outcome: 'delivered', status: 'delivered', thread: THREAD });
    expect(doc.events[1]).toMatchObject({
      id: ANSWER,
      outcome: 'answered',
      status: 'replied',
      thread: THREAD,
      in_reply_to: THREAD,
    });

    const textIo = testIo(root);
    expect(await runFeed([], textIo, { home })).toBe(0);
    expect(textIo.out).toContain(`re ${THREAD}: answer`);
  });

  test('a later line for one message without the thread keeps the value an older line gave', async () => {
    const { root, home } = world();
    const first = appendHistory('acme', root, home, {
      ts: '2026-10-18T15:00:00.000Z',
      from: 'owner',
      to: 'lead',
      body: 'from the owner\n\nquestion',
      id: THREAD,
      thread: THREAD,
      in_reply_to: 'cccccccc-1111-4222-8333-444455556666',
      outcome: 'sent (unconfirmed)',
      via: 'mcp-inbox',
    });
    if (!first.ok) throw new Error(first.reason);
    // The watch's later receipt promotion, written before this version carried the thread.
    const later = appendHistory('acme', root, home, {
      ts: '2026-10-18T15:02:00.000Z',
      from: 'owner',
      to: 'lead',
      body: 'from the owner\n\nquestion',
      id: THREAD,
      outcome: 'delivered (read)',
      via: 'mcp-inbox',
    });
    if (!later.ok) throw new Error(later.reason);

    const io = testIo(root);
    expect(await runFeed(['--json'], io, { home })).toBe(0);
    const doc = assertMatchesOutputSchema<FeedDoc>(io.out, FEED_OUTPUT_SCHEMA);
    expect(doc.events).toHaveLength(1);
    expect(doc.events[0]).toMatchObject({
      outcome: 'delivered (read)',
      status: 'read',
      thread: THREAD,
      in_reply_to: 'cccccccc-1111-4222-8333-444455556666',
    });
  });
});
