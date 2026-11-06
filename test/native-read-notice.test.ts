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
  alreadyReadSentence, recordNameOk, recordTextOf, signReceiptPayload, signRecord, writeReceipt, writeRecord, type RecordPayload,
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
const OTHER_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const FORMER_ID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4';
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
    kind: 'receipt', status: 'read', id, to: SEAT, root, session: SESSION, at: READ_AT, read_by: SEAT,
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
    expect(said).toContain(`${READ_ID}: already read at ${READ_AT} (${SEAT})`);
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
    expect({ code, out: read.out(), err: read.err() }).toEqual({ code: 0, out: `${READ_ID}: already read at ${READ_AT} (${SEAT})\n`, err: '' });
    expect(read.out()).toBe(`${READ_ID}: already read at ${READ_AT} (${SEAT})\n`);
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
    expect(read.out()).toBe(`no unread drops\n${READ_ID}: already read at ${READ_AT} (${SEAT})\n`);
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
    expect(text).toBe(`${READ_ID}: already read at ${READ_AT} (${SEAT})`);
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

const ROSTER = ['operator-1', 'lead', 'owner', 'orchestrator', 'seat', 'a'.repeat(64)];

function sentence(id: string, at: string, readBy: string | undefined): string {
  return alreadyReadSentence(id, at, readBy, ROSTER);
}

test('an already-read sentence keeps a known reader and an ISO time, and nothing else', () => {
  const forged = sentence(READ_ID, 'not-a-time\nINJECT', 'owner)\nFAKE');
  expect(forged).toBe(`${READ_ID}: already read (unknown)`);
  expect(forged.includes('\n')).toBe(false);
  expect(forged).not.toContain('FAKE');
  expect(forged).not.toContain('INJECT');
  expect(forged).not.toContain('owner)');

  expect(sentence(READ_ID, READ_AT, 'answered-by-send')).toBe(`${READ_ID}: already read at ${READ_AT} (answered-by-send)`);
  expect(sentence(READ_ID, READ_AT, 'channel')).toBe(`${READ_ID}: already read at ${READ_AT} (channel)`);
  expect(sentence(READ_ID, READ_AT, 'reply')).toBe(`${READ_ID}: already read at ${READ_AT} (reply)`);
  expect(sentence(READ_ID, READ_AT, 'lead-ack:owner')).toBe(`${READ_ID}: already read at ${READ_AT} (lead-ack:owner)`);
  expect(sentence(READ_ID, READ_AT, 'lead-ack:operator-1')).toBe(`${READ_ID}: already read at ${READ_AT} (lead-ack:operator-1)`);
  expect(sentence(READ_ID, READ_AT, 'operator-1')).toBe(`${READ_ID}: already read at ${READ_AT} (operator-1)`);
  expect(sentence(READ_ID, READ_AT, 'owner')).toBe(`${READ_ID}: already read at ${READ_AT} (unknown)`);
  expect(sentence(READ_ID, READ_AT, 'lead')).toBe(`${READ_ID}: already read at ${READ_AT} (unknown)`);
  expect(sentence(READ_ID, READ_AT, 'orchestrator')).toBe(`${READ_ID}: already read at ${READ_AT} (unknown)`);
  expect(sentence(READ_ID, READ_AT, undefined)).toBe(`${READ_ID}: already read at ${READ_AT} (read)`);
  expect(sentence(READ_ID, READ_AT, 'lead-ack:not a seat')).toBe(`${READ_ID}: already read at ${READ_AT} (unknown)`);
  expect(sentence(READ_ID, READ_AT, 'a'.repeat(65))).toBe(`${READ_ID}: already read at ${READ_AT} (unknown)`);
  expect(sentence(READ_ID, READ_AT, 'a'.repeat(64))).toBe(`${READ_ID}: already read at ${READ_AT} (${'a'.repeat(64)})`);
  expect(sentence('a\u200bb', READ_AT, 'seat')).toBe(`a\\u200bb: already read at ${READ_AT} (seat)`);
  expect(sentence(READ_ID, '2026-02-30T00:00:00.000Z', 'seat')).toBe(`${READ_ID}: already read (seat)`);

  const injected = sentence('aaaa\nbbbb', READ_AT, 'seat');
  expect(injected.includes('\n')).toBe(false);
  expect(injected).toBe(`aaaa\\u000abbbb: already read at ${READ_AT} (seat)`);
  expect(sentence('say"hi\\', READ_AT, 'seat')).toBe(`say\\"hi\\\\: already read at ${READ_AT} (seat)`);

  const cut = sentence('n'.repeat(250), READ_AT, 'seat');
  expect(cut.startsWith(`${'n'.repeat(200)} [cut]:`)).toBe(true);
  expect(cut).toContain(`already read at ${READ_AT} (seat)`);
  expect(cut).not.toContain('n'.repeat(201));
});

test('a receipt naming owner or a seat the team does not have says unknown', async () => {
  const held = world();
  try {
    writeBody(held.root, held.home, held.dropDir, READ_ID, ALREADY);
    const owner = writeReceipt(held.dropDir, signReceiptPayload({
      kind: 'receipt', status: 'read', id: READ_ID, to: SEAT, root: held.root, session: SESSION, at: READ_AT, read_by: 'owner',
    }, held.home), held.home);
    if (!owner.ok) throw new Error(owner.reason);
    writeBody(held.root, held.home, held.dropDir, OTHER_ID, UNREAD);
    const stranger = writeReceipt(held.dropDir, signReceiptPayload({
      kind: 'receipt', status: 'read', id: OTHER_ID, to: SEAT, root: held.root, session: SESSION, at: READ_AT, read_by: 'stranger',
    }, held.home), held.home);
    if (!stranger.ok) throw new Error(stranger.reason);
    const first = seatIo(held.root, held.home);
    expect(await runDrops(['--read', '--seat', SEAT, '--id', READ_ID], first.io, { home: held.home })).toBe(0);
    expect(first.out()).toBe(`${READ_ID}: already read at ${READ_AT} (unknown)\n`);
    expect(first.out()).not.toContain('(owner)');
    expect(first.out()).not.toContain(ALREADY);
    const second = seatIo(held.root, held.home);
    expect(await runDrops(['--read', '--seat', SEAT, '--id', OTHER_ID], second.io, { home: held.home })).toBe(0);
    expect(second.out()).toBe(`${OTHER_ID}: already read at ${READ_AT} (unknown)\n`);
    expect(second.out()).not.toContain('(stranger)');
    expect(second.out()).not.toContain(UNREAD);
  } finally {
    discardFixtures([held.root], { roots: [dirname(held.root)] });
  }
});

test('a receipt naming a seat this team no longer lists says unknown', async () => {
  const held = world();
  try {
    writeBody(held.root, held.home, held.dropDir, FORMER_ID, ALREADY);
    const former = writeReceipt(held.dropDir, signReceiptPayload({
      kind: 'receipt', status: 'read', id: FORMER_ID, to: SEAT, root: held.root, session: SESSION, at: READ_AT, read_by: 'builder-9',
    }, held.home), held.home);
    if (!former.ok) throw new Error(former.reason);
    const read = seatIo(held.root, held.home);
    expect(await runDrops(['--read', '--seat', SEAT, '--id', FORMER_ID], read.io, { home: held.home })).toBe(0);
    expect(read.out()).toBe(`${FORMER_ID}: already read at ${READ_AT} (unknown)\n`);
    expect(read.out()).not.toContain('builder-9');
    expect(read.out()).not.toContain(ALREADY);
  } finally {
    discardFixtures([held.root], { roots: [dirname(held.root)] });
  }
});

test('a record name refuses a control character and a name past the file-name cap', () => {
  expect(recordNameOk('a\nb')).toBe(false);
  expect(recordNameOk('a\rb')).toBe(false);
  expect(recordNameOk('a\u001bb')).toBe(false);
  expect(recordNameOk('a\u2028b')).toBe(false);
  expect(recordNameOk('x'.repeat(256))).toBe(false);
  expect(recordNameOk('x'.repeat(255))).toBe(true);
  expect(recordNameOk(READ_ID)).toBe(true);
});
