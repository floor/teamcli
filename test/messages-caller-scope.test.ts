// One seat's `team messages` reads one mailbox. The record stores are shared by the whole
// session — every seat's folder sits under one transport tree — so a reader that served every
// record it found spent the mail of every other seat: the receipt is the read-once gate, and a
// receipt written by the wrong reader means the addressed seat never sees the body. These scenes
// hold the caller to its own mailbox: its records are served, every other record is listed as
// `waiting` with no body and no receipt, and a caller the placement cannot resolve reads nothing.
import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import {
  plantMessage,
  plantRecord,
  receiptFile,
  recordDir,
  runMessages,
  type MessagePayload,
} from '../src/commands/messages.ts';
import { findRoot } from '../src/file/load.ts';
import { listUnread } from '../src/mcp/inbox.ts';
import { MESSAGES_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { messageKeyOf, messageKeyPath, messageKeyState } from '../src/store/keys.ts';
import { receiptFile as recordReceiptFile, statusOf } from '../src/send/record.ts';
import { testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
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
    name: orchestrator
    label: orchestrator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const AT = '2026-10-04T09:00:00.000Z';
const NOW = new Date(AT);

/** The seats the scenes place, each in its own pane of the fixture's session. */
const LEAD: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
const WORKER: Caller = { kind: 'seat', name: 'worker', pane: 'pane-worker', session: 'acme' };

const OTHER_NOTE = '2 messages addressed to another mailbox are waiting; they are listed without their bodies, and no receipts are written for them.';
/** The owner's own reading: the whole session is plainly readable to the owner, so its rows carry
 *  the verified bodies; what the owner's run never does is spend another mailbox's id. */
const OWNER_OTHER_NOTE_ONE = '1 message addressed to another mailbox is waiting; it is shown read-only, and no receipt is written for it.';
const OWNER_OTHER_NOTE_TWO = '2 messages addressed to another mailbox are waiting; they are shown read-only, and no receipts are written for them.';

type MessagesDoc = {
  format: number;
  project: string;
  session: string;
  rows: { id: string; from: string | null; to: string | null; sent: string | null; sent_display: string; status: string; body?: string }[];
  notes: string[];
  differences: { what: string; repair: string; who: string }[];
  counts: { messages: number; shown: number; refused: number; waiting: number };
};

let base: string;
let root: string;
let home: string;

function project(): void {
  base = mkdtempSync(join(tmpdir(), 'team-messages-caller-scope-'));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
}

function found(): string {
  const found = findRoot(root);
  if (!found) throw new Error('not a checkout');
  return found;
}

function payload(over: Partial<MessagePayload> = {}): MessagePayload {
  return {
    kind: 'message',
    id: 'e1',
    to: 'owner',
    root: found(),
    session: 'acme',
    at: AT,
    body: 'for the owner',
    from: 'runtime',
    ...over,
  };
}

async function run(argv: string[] = [], caller: Caller = LEAD): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
  const code = await runMessages(argv, io, { home, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

/** The message key the fixture wrote, for reading a receipt's status the way every reader does. */
function messageKey(): ReturnType<typeof messageKeyOf> {
  const state = messageKeyState(home);
  if (state.kind !== 'key') throw new Error('the fixture wrote no message key');
  return state.key;
}

describe('team messages reads only the caller\'s mailbox', () => {
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test('the lead\'s record is served, and the worker\'s and the orchestrator\'s stay waiting and unread', async () => {
    project();
    const where = found();
    // Records for three different mailboxes, written the way a send writes them. The other
    // seats' ids have the shape a real send writes, so their own inbox readers can see them.
    const workerId = 'b1e0a2c3-4d5f-4a6b-8c9d-0e1f2a3b4c5d';
    const orchestratorId = '0a1b2c3d-4e5f-4a0b-9c1d-2e3f4a5b6c7d';
    plantRecord(home, where, 'acme', 'lead', 'a1', 'for the lead', { from: 'harness', at: AT });
    plantRecord(home, where, 'acme', 'worker', workerId, 'for the worker', { from: 'harness', at: AT });
    plantRecord(home, where, 'acme', 'orchestrator', orchestratorId, 'for the orchestrator', { from: 'harness', at: AT });

    const result = await run(['--json'], LEAD);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const doc = assertMatchesOutputSchema<MessagesDoc>(result.out, MESSAGES_OUTPUT_SCHEMA);
    // Candidate order is the seats' own order: lead, orchestrator, worker.
    expect(doc.rows).toEqual([
      { id: 'a1', from: 'harness', to: 'lead', sent: AT, sent_display: '0s ago', status: 'shown', body: 'for the lead' },
      { id: orchestratorId, from: 'harness', to: 'orchestrator', sent: AT, sent_display: '0s ago', status: 'waiting' },
      { id: workerId, from: 'harness', to: 'worker', sent: AT, sent_display: '0s ago', status: 'waiting' },
    ]);
    expect(doc.counts).toEqual({ messages: 3, shown: 1, refused: 0, waiting: 2 });
    expect(doc.notes).toEqual([OTHER_NOTE]);
    expect(doc.differences).toEqual([]);
    // No other mailbox's body is anywhere in the document, whatever its row says.
    expect(result.out).not.toContain('for the worker');
    expect(result.out).not.toContain('for the orchestrator');

    // The lead's id is spent; the other two are untouched and still unread for their seats.
    expect(statusOf(recordDir(where, 'acme', 'lead'), 'a1', { to: 'lead', root: where, session: 'acme' }, messageKey())).toBe('read');
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'worker'), workerId, 'read'))).toBe(false);
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'orchestrator'), orchestratorId, 'read'))).toBe(false);
    expect(listUnread(recordDir(where, 'acme', 'worker'), { to: 'worker', root: where, session: 'acme' }, home).map((one) => one.id)).toEqual([workerId]);
    expect(listUnread(recordDir(where, 'acme', 'orchestrator'), { to: 'orchestrator', root: where, session: 'acme' }, home).map((one) => one.id)).toEqual([orchestratorId]);
  });

  test('the text reading prints the caller\'s body, one waiting row per other mailbox, and the note', async () => {
    project();
    const where = found();
    plantRecord(home, where, 'acme', 'lead', 'a1', 'for the lead', { from: 'harness', at: AT });
    plantRecord(home, where, 'acme', 'worker', 'b1', 'for the worker', { from: 'harness', at: AT });

    const result = await run([], LEAD);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain('lead/a1:\nfor the lead');
    expect(result.out).not.toContain('for the worker');
    expect(result.out).toContain('b1');
    expect(result.out).toContain('waiting');
    expect(result.out).toContain(
      'note: 1 message addressed to another mailbox is waiting; it is listed without its body, and no receipt is written for it.',
    );
    expect(result.out.endsWith('2 messages\n')).toBe(true);
  });

  test('the owner\'s mailbox is the owner\'s: its record is served and a seat\'s record stays waiting', async () => {
    project();
    const where = found();
    plantMessage(home, where, 'owner', 'e1', payload());
    plantRecord(home, where, 'acme', 'lead', 'a1', 'for the lead', { from: 'harness', at: AT });

    const result = await run(['--json'], { kind: 'owner' });
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const doc = assertMatchesOutputSchema<MessagesDoc>(result.out, MESSAGES_OUTPUT_SCHEMA);
    // Transport-tree records list before the older store's, as they always did. The owner reads
    // the whole session: the lead's record carries its verified body, and is still not served —
    // a waiting row publishes no receipt, so the lead's own reader still finds it.
    expect(doc.rows).toEqual([
      { id: 'a1', from: 'harness', to: 'lead', sent: AT, sent_display: '0s ago', status: 'waiting', body: 'for the lead' },
      { id: 'e1', from: 'runtime', to: 'owner', sent: AT, sent_display: '0s ago', status: 'shown', body: 'for the owner' },
    ]);
    expect(doc.counts).toEqual({ messages: 2, shown: 1, refused: 0, waiting: 1 });
    expect(doc.notes).toEqual([OWNER_OTHER_NOTE_ONE]);
    expect(existsSync(receiptFile(where, 'owner', 'e1'))).toBe(true);
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'lead'), 'a1', 'read'))).toBe(false);
  });

  test('the owner reads another mailbox\'s verified body read-only, and a record that does not verify stays body-less', async () => {
    project();
    const where = found();
    const workerId = 'c2f1b3d4-5e6a-4b7c-9d0e-1f2a3b4c5d6e';
    const tamperedId = 'd3a2c4e5-6f7b-4c8d-9e1f-2a3b4c5d6e7f';
    plantRecord(home, where, 'acme', 'worker', workerId, 'for the worker', { from: 'harness', at: AT });
    plantRecord(home, where, 'acme', 'lead', tamperedId, 'for the lead', { from: 'harness', at: AT });
    // Altered after signing: its signature no longer holds, so not even the owner's reading
    // carries a body for it, and no difference is raised — the record still belongs to the
    // lead's own reader, which will report it when it reads.
    const tampered = join(recordDir(where, 'acme', 'lead'), tamperedId);
    writeFileSync(tampered, readFileSync(tampered, 'utf8').replace('for the lead', 'for the lead, altered'));

    const result = await run(['--json'], { kind: 'owner' });
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const doc = assertMatchesOutputSchema<MessagesDoc>(result.out, MESSAGES_OUTPUT_SCHEMA);
    // Candidate order is the seats' own order: lead before worker.
    expect(doc.rows).toEqual([
      { id: tamperedId, from: null, to: 'lead', sent: null, sent_display: '-', status: 'waiting' },
      { id: workerId, from: 'harness', to: 'worker', sent: AT, sent_display: '0s ago', status: 'waiting', body: 'for the worker' },
    ]);
    expect(doc.counts).toEqual({ messages: 2, shown: 0, refused: 0, waiting: 2 });
    expect(doc.notes).toEqual([OWNER_OTHER_NOTE_TWO]);
    expect(doc.differences).toEqual([]);

    // The owner's reading spends neither record: both mailboxes still have their mail.
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'worker'), workerId, 'read'))).toBe(false);
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'lead'), tamperedId, 'read'))).toBe(false);

    // The text reading shows the same two rows, the verified body under its own heading, no
    // body for the altered record, and the note that says no receipt was written.
    const text = await run([], { kind: 'owner' });
    expect(text.code).toBe(0);
    expect(text.out).toContain(`worker/${workerId}:\nfor the worker`);
    expect(text.out).not.toContain('for the lead, altered');
    expect(text.out).toContain('note: 2 messages addressed to another mailbox are waiting; they are shown read-only, and no receipts are written for them.');
    expect(text.out.endsWith('2 messages\n')).toBe(true);
  });

  test('a caller the placement cannot resolve reads nothing and publishes nothing', async () => {
    project();
    const where = found();
    plantRecord(home, where, 'acme', 'lead', 'a1', 'for the lead', { from: 'harness', at: AT });
    plantRecord(home, where, 'acme', 'worker', 'b1', 'for the worker', { from: 'harness', at: AT });
    // Planting writes a message key of its own; it is taken away so the refusal has to stand
    // on its own: a refused caller neither shows nor verifies anything, and creates no key.
    rmSync(messageKeyPath(home), { force: true });

    const unplaced = await run(['--json'], { kind: 'unplaced', reason: 'its parent processes can\'t be read to the top' });
    expect(unplaced.code).toBe(1);
    expect(unplaced.err).toBe('');
    assertJsonErrorShape(unplaced.out, {
      id: 'messages.caller',
      messageContains: 'only the owner or a seat of this session reads a mailbox',
    });
    expect(unplaced.out).not.toContain('for the lead');

    // An owner who does not run on a terminal is not placed either: it gets the same refusal.
    const noTty = await run([], { kind: 'owner-no-tty' });
    expect(noTty.code).toBe(1);
    expect(noTty.out).toBe('');
    expect(noTty.err).toContain('only the owner or a seat of this session reads a mailbox');
    expect(noTty.err).toContain('unplaced (it doesn\'t run on a terminal)');

    // Neither refusal served anything or created a key.
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'lead'), 'a1', 'read'))).toBe(false);
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'worker'), 'b1', 'read'))).toBe(false);
    expect(existsSync(messageKeyPath(home))).toBe(false);
  });

  test('without a message key only other mailboxes\' records list, and the run creates no key', async () => {
    project();
    const where = found();
    plantRecord(home, where, 'acme', 'worker', 'b1', 'for the worker', { from: 'harness', at: AT });
    // The key the fixture wrote is taken away: a keyless run can verify nothing, and verifies
    // nothing it is not addressed; the worker's record is listed, not read.
    messageKeyOf(home);
    rmSync(messageKeyPath(home), { force: true });

    const result = await run(['--json'], LEAD);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const doc = assertMatchesOutputSchema<MessagesDoc>(result.out, MESSAGES_OUTPUT_SCHEMA);
    expect(doc.rows).toEqual([
      { id: 'b1', from: null, to: 'worker', sent: null, sent_display: '-', status: 'waiting' },
    ]);
    expect(doc.counts).toEqual({ messages: 1, shown: 0, refused: 0, waiting: 1 });
    expect(existsSync(messageKeyPath(home))).toBe(false);
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'worker'), 'b1', 'read'))).toBe(false);
  });

  test('the older store is scoped the same way: a seat reads its own folder, not the owner\'s', async () => {
    project();
    const where = found();
    plantMessage(home, where, 'worker', 'w1', payload({ id: 'w1', to: 'worker', body: 'for the worker', from: 'lead' }));
    plantMessage(home, where, 'owner', 'e1', payload());

    const result = await run(['--json'], WORKER);
    expect(result.code).toBe(0);
    const doc = assertMatchesOutputSchema<MessagesDoc>(result.out, MESSAGES_OUTPUT_SCHEMA);
    // Both records live in the older store, which sorts by mailbox name: owner before worker.
    expect(doc.rows).toEqual([
      { id: 'e1', from: 'runtime', to: 'owner', sent: AT, sent_display: '0s ago', status: 'waiting' },
      { id: 'w1', from: 'lead', to: 'worker', sent: AT, sent_display: '0s ago', status: 'shown', body: 'for the worker' },
    ]);
    expect(existsSync(receiptFile(where, 'worker', 'w1'))).toBe(true);
    expect(existsSync(receiptFile(where, 'owner', 'e1'))).toBe(false);
  });
});
