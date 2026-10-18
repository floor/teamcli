// `team reply`: one signed record on the thread it answers, or a close beside the record it
// ends. A reply is judged by the send rules with the reply rule asked last (`reply-on-open-thread`,
// draft 3 §7); a thread ends on `team reply --close` or when `thread-ttl` passes with no record,
// and a reply on a closed thread opens a new one that cites it (§3.5). The record answered is the
// signed one in this checkout's session, addressed to the caller, in the caller's own folder.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { runReply, USAGE, type ReplyHost } from '../src/commands/reply.ts';
import { EVENT_THRESHOLDS } from '../src/policy/events.ts';
import { REPLY_RULE } from '../src/send/admit.ts';
import { readHistory } from '../src/send/history.ts';
import { signedCloseOf, signedReceiptOf, verifyClose, verifyReceipt } from '../src/send/record.ts';
import { messageKeyOf, messageKeyState } from '../src/store/keys.ts';
import { updateState } from '../src/state.ts';
import { recordAt, testIo } from './helpers.ts';

const NOW = new Date('2026-10-18T15:30:00.000Z');
const NOW_ISO = NOW.toISOString();
const HOUR = 60 * 60 * 1000;

const SENT = '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d';
const SENT_B = '1f1e1d1c-1b1a-4a4b-8c8d-9e9f0a1b2c3d';
const SENT_C = '2e2d2c2b-2a29-4a4b-8c8d-9e9f0a1b2c3d';
const REPLY = '3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const REPLY_B = '4b4c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: helper
    label: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reply-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function host(patch: Partial<ReplyHost> = {}): ReplyHost {
  return { home, now: () => NOW, ...patch };
}

async function run(
  argv: string[],
  caller: Caller = { kind: 'owner' },
  patch: Partial<ReplyHost> = {},
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
  const code = await runReply(argv, io, host(patch));
  return { code, out: io.out, err: io.err };
}

/** The state record a placed seat is judged by: the pane the fixture's caller runs on. */
function place(name: string, pane: string): void {
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = { seats: { [name]: { stage: 'ready' as const, pane } } } as never;
  });
}

/** A record `team send` would have written: signed, in the addressee's folder, on its thread. */
function sentTo(seat: string, id: string, fields: Parameters<typeof plantRecord>[6] = {}): string {
  const from = fields.from ?? 'worker';
  const header = from === 'owner'
    ? 'from the owner — admitted by: the owner\n'
    : `from the file's seat ${from} (no registry record yet) — admitted by: a seat to its own team's orchestrator\n`;
  return plantRecord(home, root, 'acme', seat, id, `${header}\nquestion`, { at: NOW_ISO, ...fields });
}

describe('a reply is a record on the thread it answers', () => {
  test('the owner answers a seat: the record goes to the sender, cites it, and opens with its thread', async () => {
    sentTo('owner', SENT, { from: 'worker' });
    const result = await run([SENT, 'the answer'], { kind: 'owner' }, { newId: () => REPLY });

    expect(result).toEqual({ code: 0, out: 'team acme, session "acme"\nworker: replied\n', err: '' });
    const record = recordAt(join(recordDir(root, 'acme', 'worker'), REPLY));
    expect(record.payload).toEqual({
      kind: 'message',
      id: REPLY,
      to: 'worker',
      to_id: null,
      root,
      session: 'acme',
      at: NOW_ISO,
      body: `from the owner — admitted by: the owner\n\nthe answer`,
      from: 'owner',
      from_id: null,
      rule: 'the owner',
      thread: SENT,
      in_reply_to: SENT,
    });
  });

  test('the answered record moves to replied: a signed receipt beside it, where it waits', async () => {
    sentTo('owner', SENT, { from: 'worker' });
    const result = await run([SENT, 'the answer'], { kind: 'owner' }, { newId: () => REPLY });
    expect(result.code).toBe(0);

    const receipt = signedReceiptOf(JSON.parse(readFileSync(join(recordDir(root, 'acme', 'owner'), `${SENT}.replied.json`), 'utf8')));
    if (receipt === null) throw new Error('no receipt was written');
    expect(receipt.payload).toEqual({ kind: 'receipt', status: 'replied', id: SENT, to: 'owner', root, session: 'acme', at: NOW_ISO });
    const key = messageKeyState(home);
    if (key.kind !== 'key') throw new Error(key.kind);
    expect(verifyReceipt(receipt, key.key)).toBe(true);
  });

  test('the history line names the reply, its thread, the record it answers, and the drop leg', async () => {
    sentTo('owner', SENT, { from: 'worker' });
    const result = await run([SENT, 'the answer'], { kind: 'owner' }, { newId: () => REPLY });
    expect(result.code).toBe(0);

    const history = readHistory('acme', root, home);
    if (!history.ok) throw new Error(history.reason);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({
      from: 'owner',
      to: 'worker',
      body: 'from the owner — admitted by: the owner\n\nthe answer',
      id: REPLY,
      thread: SENT,
      in_reply_to: SENT,
      outcome: 'delivered',
      via: 'drop',
    });
  });

  test('a reply between two seats no other rule pairs is admitted by the reply rule', async () => {
    place('helper', 'w2:p1');
    sentTo('helper', SENT, { from: 'worker' });
    const result = await run([SENT, 'answered'], { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' }, { newId: () => REPLY });

    expect(result).toEqual({ code: 0, out: 'team acme, session "acme"\nworker: replied\n', err: '' });
    const record = recordAt(join(recordDir(root, 'acme', 'worker'), REPLY));
    expect(record.payload).toMatchObject({
      from: 'helper',
      to: 'worker',
      rule: REPLY_RULE,
      thread: SENT,
      in_reply_to: SENT,
      body: `from the file's seat helper (no registry record yet) — admitted by: ${REPLY_RULE}\n\nanswered`,
    });
  });

  test('--json writes one team.reply document, and nothing else', async () => {
    sentTo('owner', SENT_B, { from: 'worker' });
    const result = await run([SENT_B, 'ok', '--json'], { kind: 'owner' }, { newId: () => REPLY_B });
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const doc = JSON.parse(result.out) as Record<string, unknown>;
    expect(doc).toEqual({
      schema: { name: 'team.reply', version: 1 },
      format: 1,
      status: 'replied',
      action_summary: 'worker: replied',
      project: 'acme',
      session: 'acme',
      record: REPLY_B,
      thread: SENT_B,
      in_reply_to: SENT_B,
      to: 'worker',
      rule: 'the owner',
      reply: 'ok',
      at: NOW_ISO,
    });
  });
});

describe('a thread ends on --close, on the ttl, or at the cap', () => {
  test('--close writes a signed sidecar beside the record it answers, and names the thread', async () => {
    sentTo('owner', SENT, { from: 'worker' });
    const result = await run([SENT, '--close'], { kind: 'owner' });

    expect(result).toEqual({ code: 0, out: `team acme, session "acme"\n${SENT}: closed\n`, err: '' });
    const close = signedCloseOf(JSON.parse(readFileSync(join(recordDir(root, 'acme', 'owner'), `${SENT}.closed.json`), 'utf8')));
    if (close === null) throw new Error('no close was written');
    expect(close.payload).toEqual({ kind: 'thread-close', id: SENT, thread: SENT, by: 'owner', root, session: 'acme', at: NOW_ISO });
    const key = messageKeyState(home);
    if (key.kind !== 'key') throw new Error(key.kind);
    expect(verifyClose(close, key.key)).toBe(true);
  });

  test('a second close is refused, and names the thread as already closed', async () => {
    sentTo('owner', SENT, { from: 'worker' });
    expect((await run([SENT, '--close'], { kind: 'owner' })).code).toBe(0);

    const again = await run([SENT, '--close'], { kind: 'owner' });
    expect(again.code).toBe(1);
    expect(again.err).toBe(`team reply: the thread ${SENT} is already closed; nothing was written\n`);
  });

  test('a reply on a closed thread opens a new one that cites the record it answers', async () => {
    sentTo('owner', SENT, { from: 'worker' });
    expect((await run([SENT, '--close'], { kind: 'owner' })).code).toBe(0);

    const result = await run([SENT, 'one more'], { kind: 'owner' }, { newId: () => REPLY });
    expect(result.code).toBe(0);
    const record = recordAt(join(recordDir(root, 'acme', 'worker'), REPLY));
    expect(record.payload.thread).toBe(REPLY);
    expect(record.payload.in_reply_to).toBe(SENT);
  });

  test('a thread whose newest record is older than the ttl is closed by the clock', async () => {
    const past = EVENT_THRESHOLDS.thread_ttl_seconds * 1_000 + HOUR;
    sentTo('owner', SENT, { from: 'worker', at: new Date(NOW.getTime() - past).toISOString() });

    const close = await run([SENT, '--close'], { kind: 'owner' });
    expect(close.code).toBe(1);
    expect(close.err).toBe(`team reply: the thread ${SENT} ended: no record on it for 72h; nothing was written\n`);

    const result = await run([SENT, 'still here'], { kind: 'owner' }, { newId: () => REPLY });
    expect(result.code).toBe(0);
    expect(recordAt(join(recordDir(root, 'acme', 'worker'), REPLY)).payload.thread).toBe(REPLY);
  });

  test('a thread at the cap is closed, and a reply opens a new one', async () => {
    const thread = 'cap-000';
    sentTo('owner', thread, { from: 'worker', thread });
    for (let index = 1; index < EVENT_THRESHOLDS.thread_cap; index += 1) {
      sentTo('owner', `cap-${String(index).padStart(3, '0')}`, { from: 'worker', thread });
    }

    const close = await run([thread, '--close'], { kind: 'owner' });
    expect(close.code).toBe(1);
    expect(close.err).toBe(`team reply: the thread ${thread} ended at its ${String(EVENT_THRESHOLDS.thread_cap)}-record cap; nothing was written\n`);

    const result = await run([thread, 'after the cap'], { kind: 'owner' }, { newId: () => REPLY });
    expect(result.code).toBe(0);
    expect(recordAt(join(recordDir(root, 'acme', 'worker'), REPLY)).payload.thread).toBe(REPLY);
  });
});

describe('who and which record', () => {
  test('a record this session does not hold is refused, and nothing is written', async () => {
    messageKeyOf(home);
    const result = await run([SENT, 'hello'], { kind: 'owner' });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`team reply: no record named ${SENT} waits in this project's session "acme"\n`);
    expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8')).toBe(TEAM);
  });

  test('a record that does not verify is refused', async () => {
    const path = sentTo('owner', SENT, { from: 'worker' });
    const tampered = JSON.parse(readFileSync(path, 'utf8')) as { signature: string };
    tampered.signature = Buffer.alloc(64).toString('base64');
    writeFileSync(path, JSON.stringify(tampered));
    const result = await run([SENT, 'hello'], { kind: 'owner' });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`team reply: record ${SENT} does not verify against this message key\n`);
  });

  test('a record addressed to another seat is not the caller\'s to answer', async () => {
    sentTo('lead', SENT, { from: 'worker' });
    const result = await run([SENT, 'hello'], { kind: 'owner' });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`team reply: record ${SENT} is addressed to lead, not to owner\n`);
  });

  test('a message an earlier build wrote is read, not answered', async () => {
    messageKeyOf(home);
    mkdirSync(join(root, '.agents', 'messages', 'owner'), { recursive: true });
    writeFileSync(join(root, '.agents', 'messages', 'owner', `${SENT}.json`), '{}\n');
    const result = await run([SENT, 'hello'], { kind: 'owner' });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`team reply: the message ${SENT} was written by an earlier build and has no thread; it is read, not answered\n`);
  });

  test('a seat cannot answer a record the owner sent', async () => {
    place('lead', 'w1:p1');
    sentTo('lead', SENT, { from: 'owner' });
    const result = await run([SENT, 'hello'], { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`team reply: record ${SENT} was sent by the owner, and this build does not deliver a reply to the owner; nothing was written\n`);
  });

  test('a sender the file no longer declares is not reached by a reply', async () => {
    place('lead', 'w1:p1');
    sentTo('lead', SENT, { from: 'ghost' });
    const result = await run([SENT, 'hello'], { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`team reply: ghost: it is not a declared seat; the file's seats are lead, worker, helper; nothing was written\n`);
  });

  test('a caller with no terminal is refused', async () => {
    sentTo('owner', SENT, { from: 'worker' });
    const result = await run([SENT, 'hello'], { kind: 'owner-no-tty' });
    expect(result.code).toBe(1);
    expect(result.err).toBe('team reply: only the owner or a seat of this team runs this, from a terminal outside herdr or its own pane\n');
  });
});

describe('the invocation', () => {
  test('an id is required', async () => {
    const result = await run([], { kind: 'owner' });
    expect(result.code).toBe(2);
    expect(result.err).toBe(`team reply: <id> is required\n${USAGE}`);
  });

  test('a reply carries text, and --close carries none', async () => {
    expect(await run([SENT], { kind: 'owner' })).toMatchObject({ code: 2 });
    const empty = await run([SENT], { kind: 'owner' });
    expect(empty.err.startsWith('team reply: a reply text is required\n')).toBe(true);

    const closing = await run([SENT, 'words', '--close'], { kind: 'owner' });
    expect(closing.code).toBe(2);
    expect(closing.err.startsWith('team reply: --close takes no text\n')).toBe(true);
  });

  test('an id that cannot name a file is refused before anything is read', async () => {
    const result = await run(['../escape', 'hello'], { kind: 'owner' });
    expect(result.code).toBe(2);
    expect(result.err.startsWith(`team reply: "../escape" is not a record id\n`)).toBe(true);
  });

  test('--json answers a refusal with the team.error document on stdout', async () => {
    messageKeyOf(home);
    const result = await run([SENT, 'hello', '--json'], { kind: 'owner' });
    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    const doc = JSON.parse(result.out) as { schema: { name: string }; error: { id: string; message: string } };
    expect(doc.schema.name).toBe('team.error');
    expect(doc.error.id).toBe('reply.refused');
    expect(doc.error.message).toContain(`no record named ${SENT}`);
  });
});
