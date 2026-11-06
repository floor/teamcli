// A late native pointer for mail the seat already read. No live socket, no signal, no real runtime.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runDrops } from '../src/commands/drops.ts';
import { runMessages } from '../src/commands/messages.ts';
import type { Io } from '../src/io.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { deliverCodexNativeRoute } from '../src/send/push-adapters/codex-relay.ts';
import type { CodexSpawn } from '../src/send/push-adapters/codex.ts';
import { pushPointer } from '../src/send/push.ts';
import { TRIGGER_MAX } from '../src/send/native.ts';
import {
  recordTextOf, signReceiptPayload, signRecord, writeReceipt, writeRecord, type RecordPayload,
} from '../src/send/record.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const SEAT = 'operator-1';
const SESSION = 'morning';
const PANE = 'pane-operator-1';
const READ_AT = '2026-11-06T17:00:00.000Z';
const SENT_AT = '2026-11-06T16:00:00.000Z';
const READ_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const UNREAD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const ALREADY = 'this body was read before the pointer';
const UNREAD = 'this body is still unread';

function world(): { root: string; home: string; dropDir: string } {
  const root = fixtureBase('native-read-notice-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const home = join(root, 'home');
  const agents = join(root, '.agents');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(agents, { mode: 0o700 });
  writeFileSync(join(agents, 'team.yaml'), `format: 1
project: fixture
session: ${SESSION}
operator: ${SEAT}
workspace:
  mode: shared
seats:
  - name: lead
    role: coordinator
    cli: codex
    vendor: openai
    model: Fixture
    version: "1"
    launch: codex
    leads: true
  - name: ${SEAT}
    role: operator
    cli: codex
    vendor: openai
    model: Fixture
    version: "1"
    launch: codex
`, { mode: 0o600 });
  writeFileSync(join(agents, 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: { [SESSION]: { seats: { [SEAT]: { stage: 'ready', pane: PANE, cli: 'codex' } } } },
  }, null, 2)}\n`, { mode: 0o600 });
  return { root, home, dropDir: join(agents, 'send-drops', SESSION, SEAT) };
}

function writeBody(root: string, home: string, dropDir: string, id: string, body: string): string {
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: SEAT,
    to_id: null,
    root,
    session: SESSION,
    at: SENT_AT,
    body,
    from: 'lead',
    from_id: null,
    rule: 'a seat sends to a seat of its own team',
    thread: id,
  };
  const signed = signRecord(payload, home);
  const written = writeRecord(dropDir, signed);
  if (!written.ok) throw new Error(written.reason);
  return recordTextOf(signed);
}

function markRead(root: string, home: string, dropDir: string, id: string): void {
  const marked = writeReceipt(dropDir, signReceiptPayload({
    kind: 'receipt', status: 'read', id, to: SEAT, root, session: SESSION, at: READ_AT, read_by: 'seat',
  }, home), home);
  if (!marked.ok) throw new Error(marked.reason);
}

function seatIo(root: string, home: string): { io: Io; out: () => string; err: () => string } {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    cwd: root,
    env: { HOME: home },
    stdinIsTTY: false,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    caller: { kind: 'seat', name: SEAT, pane: PANE, session: SESSION },
  };
  return { io, out: () => stdout, err: () => stderr };
}

test('a late pointer names when it was sent, and a mixed read says the receipt and still returns the unread body', async () => {
  const held = world();
  try {
    const text = writeBody(held.root, held.home, held.dropDir, READ_ID, ALREADY);
    markRead(held.root, held.home, held.dropDir, READ_ID);
    writeBody(held.root, held.home, held.dropDir, UNREAD_ID, UNREAD);
    let queued = '';
    const spawn: CodexSpawn = (_binary, args) => {
      queued = args[args.indexOf('--message') + 1] ?? '';
      return { status: 0, stdout: '', stderr: '' };
    };
    const pointer = await deliverCodexNativeRoute(
      {
        route: 'native',
        runtime: 'codex',
        copy: { dir: held.dropDir, name: READ_ID },
        root: held.root,
        home: held.home,
        session: SESSION,
        seat: SEAT,
        sender: { seat: 'lead', team: 'fixture' },
      },
      { id: READ_ID, record: text, sentAt: SENT_AT },
      {
        now: () => new Date('2026-11-06T20:00:00.000Z'),
        deliveryTimeout: 5_000,
        liveProbe: false,
        skipStage: true,
        socketPath: join(held.root, 'codex.sock'),
        codexDaemon: 'on',
        sessionBinding: {
          kind: 'bound',
          recorded: {
            agentId: 'agt_0123456789ab',
            seatHandle: null,
            sessionId: 'thread-operator-1',
            team: 'fixture',
            seat: SEAT,
            cli: 'codex',
            herdrSession: SESSION,
            pane: PANE,
            address: null,
          },
        },
        spawn,
      },
    );
    expect(pointer.outcome).toBe('enqueue');
    expect(queued).toContain(`sent ${SENT_AT}`);
    expect(queued.length).toBeLessThanOrEqual(TRIGGER_MAX);
    expect(queued).not.toContain(ALREADY);
    const read = seatIo(held.root, held.home);
    const code = await runDrops(['--read', '--seat', SEAT], read.io, { home: held.home });
    const said = read.out() + read.err();
    expect(code).toBe(0);
    expect(said).toContain(`${READ_ID}: already read at ${READ_AT} (seat)`);
    expect(read.out()).toContain(UNREAD);
    expect(read.out()).not.toContain(ALREADY);
  } finally {
    discardFixtures([held.root], { roots: [dirname(held.root)] });
  }
});

test('team drops --read --id for a receipted id names the read and hides the body', async () => {
  const held = world();
  try {
    writeBody(held.root, held.home, held.dropDir, READ_ID, ALREADY);
    markRead(held.root, held.home, held.dropDir, READ_ID);
    const read = seatIo(held.root, held.home);
    const code = await runDrops(['--read', '--seat', SEAT, '--id', READ_ID], read.io, { home: held.home });
    expect({ code, out: read.out(), err: read.err() }).toEqual({ code: 0, out: `${READ_ID}: already read at ${READ_AT} (seat)\n`, err: '' });
    expect(read.out()).toBe(`${READ_ID}: already read at ${READ_AT} (seat)\n`);
    expect(read.err()).toBe('');
  } finally {
    discardFixtures([held.root], { roots: [dirname(held.root)] });
  }
});

test('team drops --read with nothing unread names the newest receipt', async () => {
  const held = world();
  try {
    writeBody(held.root, held.home, held.dropDir, READ_ID, ALREADY);
    markRead(held.root, held.home, held.dropDir, READ_ID);
    const read = seatIo(held.root, held.home);
    const code = await runDrops(['--read', '--seat', SEAT], read.io, { home: held.home });
    expect(code).toBe(0);
    expect(read.out()).toBe(`no unread drops\n${READ_ID}: already read at ${READ_AT} (seat)\n`);
    expect(read.out()).not.toContain(ALREADY);
  } finally {
    discardFixtures([held.root], { roots: [dirname(held.root)] });
  }
});

test('team messages shows a served id as a read row and not its body', async () => {
  const held = world();
  try {
    writeBody(held.root, held.home, held.dropDir, READ_ID, ALREADY);
    markRead(held.root, held.home, held.dropDir, READ_ID);
    const read = seatIo(held.root, held.home);
    const code = await runMessages(['--json'], read.io, { home: held.home, now: () => new Date(READ_AT) });
    expect(code).toBe(0);
    const document = JSON.parse(read.out()) as { rows: { id: string; status: string; body?: string }[] };
    expect(document.rows).toEqual([expect.objectContaining({ id: READ_ID, status: 'read' })]);
    expect(document.rows[0]?.body).toBeUndefined();
    expect(read.out()).not.toContain(ALREADY);
  } finally {
    discardFixtures([held.root], { roots: [dirname(held.root)] });
  }
});

test('inbox_read of a receipted id says when it was read and returns no body', async () => {
  const held = world();
  try {
    writeBody(held.root, held.home, held.dropDir, READ_ID, ALREADY);
    markRead(held.root, held.home, held.dropDir, READ_ID);
    const read = seatIo(held.root, held.home);
    const replies: string[] = [];
    const code = await runMcpServe({ seat: SEAT, session: SESSION, file: join(held.root, '.agents', 'team.yaml') }, read.io, {
      lines: (async function* () {
        yield JSON.stringify({
          jsonrpc: '2.0', id: '1', method: 'tools/call',
          params: { name: 'inbox_read', arguments: { id: READ_ID } },
        });
      })(),
      write: (line) => replies.push(line),
    }, { home: held.home });
    expect(code).toBe(0);
    const reply = JSON.parse(replies[0] ?? '{}') as { result?: { content?: { text: string }[]; isError?: boolean } };
    const text = reply.result?.content?.[0]?.text ?? '';
    expect(reply.result?.isError).toBeUndefined();
    expect(text).toBe(`${READ_ID}: already read at ${READ_AT} (seat)`);
    expect(text).not.toContain(ALREADY);
  } finally {
    discardFixtures([held.root], { roots: [dirname(held.root)] });
  }
});

test('the pointer keeps the send time only while the line stays within the trigger cap', () => {
  const sender = { seat: 'lead', team: 'fixture' };
  const line = pushPointer(READ_ID, sender, SENT_AT);
  expect(line).toContain(`sent ${SENT_AT}`);
  expect(line?.includes('\n')).toBe(false);
  expect((line ?? '').length).toBeLessThanOrEqual(TRIGGER_MAX);
  const wide = pushPointer(READ_ID, { seat: 'lead', team: 'f'.repeat(120) }, SENT_AT);
  expect(wide === null || (wide.length <= TRIGGER_MAX && !wide.includes(`sent ${SENT_AT}`))).toBe(true);
});
