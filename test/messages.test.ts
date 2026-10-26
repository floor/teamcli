import { afterEach, describe, expect, test } from 'bun:test';
import { execSync, spawn } from 'node:child_process';
import { type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEvents } from '../src/bus/log.ts';
import { findRoot } from '../src/file/load.ts';
import { messageFile, plantMessage, plantRecord, receiptFile, recordDir, runMessages, type MessagePayload } from '../src/commands/messages.ts';
import { generalBriefRecord } from '../src/launch/general-brief.ts';
import { listUnread, readMessage } from '../src/mcp/inbox.ts';
import { receiptFile as recordReceiptFile, signReceiptPayload, signRecord, statusOf, writeReceipt, writeRecord } from '../src/send/record.ts';
import { keyFingerprint, keyOf, MESSAGE_DOMAIN, messageKeyOf, messageKeyPath, messageKeyState, signDomain } from '../src/store/keys.ts';
import { MESSAGES_OUTPUT_SCHEMA } from '../src/output/index.ts';
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
`;

const BODY = 'the message body itself';
const NOW = new Date('2026-10-04T09:00:00.000Z');
const HERE = dirname(fileURLToPath(import.meta.url));
const moduleUrl = (relative: string): string => pathToFileURL(join(HERE, '..', relative)).href;

/** The one waiting record of the fixture, at the pinned instant, as the reading prints it. */
const SHOWN = `team acme, session "acme"
  ID  FROM     TO    SENT    STATUS
  m1  harness  lead  0s ago  shown

lead/m1:
${BODY}

1 message
`;

let base: string;
let root: string;
let home: string;

function payload(over: Partial<MessagePayload> = {}): MessagePayload {
  const found = findRoot(root);
  if (!found) throw new Error('not a checkout');
  return {
    kind: 'message',
    id: 'm1',
    to: 'lead',
    root: found,
    session: 'acme',
    at: '2026-10-04T09:00:00.000Z',
    body: BODY,
    from: 'harness',
    ...over,
  };
}

async function run(argv: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, { kind: 'owner' });
  const code = await runMessages(argv, io, { home, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

describe('team messages', () => {
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function project(): void {
    base = mkdtempSync(join(tmpdir(), 'team-messages-'));
    root = join(base, 'acme');
    home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    execSync('git init -q -b main', { cwd: root });
    writeTeam();
  }

  function writeTeam(): void {
    writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  }

  test('an empty mailbox prints a heading, a note and the zero summary, and creates no key', async () => {
    project();
    const result = await run();
    expect(result).toEqual({
      code: 0,
      out: 'team acme, session "acme"\n  ID  FROM  TO  SENT  STATUS\n\nnote: nothing is waiting\n\n0 messages\n',
      err: '',
    });
    expect(existsSync(messageKeyPath(home))).toBe(false);
    expect(existsSync(join(home, '.config', 'team-key', 'key.json'))).toBe(false);
  });

  test('the approval key and the message key are different files', () => {
    project();
    const approval = keyOf(home);
    expect(existsSync(messageKeyPath(home))).toBe(false);
    const message = messageKeyOf(home);
    expect(keyFingerprint(approval)).not.toBe(keyFingerprint(message));
    expect(existsSync(join(home, '.config', 'team-key', 'key.json'))).toBe(true);
    expect(existsSync(messageKeyPath(home))).toBe(true);
  });

  test('a body that fails to print leaves no receipt, and a retry shows it', async () => {
    project();
    const record = payload();
    plantMessage(home, record.root, 'lead', 'm1', record);
    const io = testIo(root, { kind: 'owner' });
    io.stdout = () => { throw new Error('stdout failed'); };
    await expect(runMessages([], io, { home, now: () => new Date('2026-10-04T09:00:00.000Z') })).rejects.toThrow('stdout failed');
    expect(existsSync(receiptFile(record.root, 'lead', 'm1'))).toBe(false);
    const again = await run();
    expect(again).toEqual({ code: 0, out: SHOWN, err: '' });
    expect(existsSync(receiptFile(record.root, 'lead', 'm1'))).toBe(true);
  });

  test('a verifying record prints the body and writes the receipt in the same step', async () => {
    project();
    const record = payload();
    plantMessage(home, record.root, 'lead', 'm1', record);
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.out).toBe(SHOWN);
    expect(result.err).toBe('');
    const receipt = readFileSync(receiptFile(record.root, 'lead', 'm1'), 'utf8');
    expect(receipt).toContain('"kind": "receipt"');
    expect(receipt).toContain('"id": "m1"');
    expect(receipt).toContain('"to": "lead"');
    const again = await run();
    expect(again).toEqual({
      code: 0,
      out: 'team acme, session "acme"\n  ID  FROM  TO  SENT  STATUS\n\nnote: nothing is waiting\n\n0 messages\n',
      err: '',
    });
    expect(readFileSync(receiptFile(record.root, 'lead', 'm1'), 'utf8')).toBe(receipt);
  });

  test('a folder that is not a checkout reads the team root it holds', async () => {
    project();
    // The team root is this folder itself: no checkout names it, and the owner's mailbox is
    // `.agents/team.yaml` beside the process. The record binds to that root, so the read proves
    // the root the command resolved is the plain one, not a checkout found somewhere above.
    mkdirSync(join(base, 'plain'), { recursive: true });
    const plain = realpathSync(join(base, 'plain'));
    mkdirSync(join(plain, '.agents'), { recursive: true });
    writeFileSync(join(plain, '.agents', 'team.yaml'), TEAM);
    plantRecord(home, plain, 'acme', 'lead', 'm1', BODY, { from: 'harness', at: '2026-10-04T09:00:00.000Z' });
    const io = testIo(plain, { kind: 'owner' });
    expect(await runMessages([], io, { home, now: () => NOW })).toBe(0);
    expect(io.out).toBe(SHOWN);
    expect(io.err).toBe('');
    expect(existsSync(join(recordDir(plain, 'acme', 'lead'), 'm1.read.json'))).toBe(true);
  });

  test('a bad signature prints no body and writes no receipt', async () => {
    project();
    const record = payload();
    plantMessage(home, record.root, 'lead', 'm1', record, signDomain(MESSAGE_DOMAIN, record, keyOf(home)));
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.out).toBe(`team acme, session "acme"
  ID  FROM     TO    SENT    STATUS
  m1  harness  lead  0s ago  refused

difference: lead/m1 does not verify: the signature is not the message key's
  repair: remove .agents/messages/lead/m1.json, or have the sender re-send it
  who: any seat

1 message
`);
    expect(result.err).toBe('');
    expect(existsSync(receiptFile(record.root, 'lead', 'm1'))).toBe(false);
    expect(existsSync(messageFile(record.root, 'lead', 'm1'))).toBe(true);

    // The owner hears the refusal as its rule and object — the record's id, its seat and its
    // mailbox path — and never the body the bad record holds.
    const events = readEvents('acme', root, home);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const refused = events.events.filter((event) => event.payload.kind === 'record.invalid');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.payload).toMatchObject({
      session: 'acme',
      rule: 'signature',
      seat: 'lead',
      subject: 'm1',
      reason: '.agents/messages/lead/m1.json',
    });
    expect(JSON.stringify(refused[0]!.payload)).not.toContain(BODY);

    // The same refusal in the same window is not raised again, and writes no second log line:
    // the first occurrence is the one the operational log carries.
    const again = await run();
    expect(again.code).toBe(1);
    const later = readEvents('acme', root, home);
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    expect(later.events.filter((event) => event.payload.kind === 'record.invalid')).toHaveLength(1);
    const log = readFileSync(join(root, '.agents', 'team.log'), 'utf8');
    expect(log.split('\n').filter((line) => line.includes('refusal [lead] record.invalid signature')).length).toBe(1);
  });

  test('a copy under a new id does not verify', async () => {
    project();
    const record = payload();
    plantMessage(home, record.root, 'lead', 'm2', record);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.out).toBe(`team acme, session "acme"
  ID  FROM     TO    SENT    STATUS
  m2  harness  lead  0s ago  refused

difference: lead/m2 does not verify: its id is m1, and the filename is the id
  repair: move .agents/messages/lead/m2.json to .agents/messages/lead/m1.json, or remove it
  who: any seat

1 message
`);
    expect(result.err).toBe('');
    expect(existsSync(receiptFile(record.root, 'lead', 'm2'))).toBe(false);
  });

  test('a copy into another seat\'s directory does not verify', async () => {
    project();
    const record = payload();
    plantMessage(home, record.root, 'worker', 'm1', record);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.out).toBe(`team acme, session "acme"
  ID  FROM     TO    SENT    STATUS
  m1  harness  lead  0s ago  refused

difference: worker/m1 does not verify: it is addressed to lead
  repair: move .agents/messages/worker/m1.json to .agents/messages/lead/m1.json, or remove it
  who: any seat

1 message
`);
    expect(result.err).toBe('');
    expect(existsSync(receiptFile(record.root, 'worker', 'm1'))).toBe(false);
  });

  test('a record bound to another checkout or another session does not verify', async () => {
    project();
    const found = findRoot(root);
    if (!found) throw new Error('not a checkout');
    plantMessage(home, found, 'lead', 'm1', payload({ root: '/tmp/elsewhere' }));
    const rootRefusal = await run();
    expect(rootRefusal.out).toBe(`team acme, session "acme"
  ID  FROM     TO    SENT    STATUS
  m1  harness  lead  0s ago  refused

difference: lead/m1 does not verify: it is bound to another checkout
  repair: remove .agents/messages/lead/m1.json: it is bound to another checkout
  who: any seat

1 message
`);
    expect(rootRefusal.err).toBe('');
    expect(existsSync(receiptFile(found, 'lead', 'm1'))).toBe(false);
    rmSync(messageFile(found, 'lead', 'm1'));
    plantMessage(home, found, 'lead', 'm1', payload({ session: 'other' }));
    const sessionRefusal = await run();
    expect(sessionRefusal.out).toBe(`team acme, session "acme"
  ID  FROM     TO    SENT    STATUS
  m1  harness  lead  0s ago  refused

difference: lead/m1 does not verify: it is bound to session "other"
  repair: remove .agents/messages/lead/m1.json: it is bound to another session
  who: any seat

1 message
`);
    expect(sessionRefusal.err).toBe('');
    expect(existsSync(receiptFile(found, 'lead', 'm1'))).toBe(false);
  });

  test('a record that is not a message prints no body', async () => {
    project();
    messageKeyOf(home);
    const found = findRoot(root);
    if (!found) throw new Error('not a checkout');
    mkdirSync(join(found, '.agents', 'messages', 'lead'), { recursive: true });
    writeFileSync(join(found, '.agents', 'messages', 'lead', 'm1.json'), '{}\n');
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.out).toBe(`team acme, session "acme"
  ID  FROM  TO  SENT  STATUS
  m1  -     -   -     refused

difference: lead/m1 does not verify: the record is not a message
  repair: remove .agents/messages/lead/m1.json, or restore it from the sender
  who: any seat

1 message
`);
    expect(result.err).toBe('');
    expect(existsSync(receiptFile(found, 'lead', 'm1'))).toBe(false);
  });

  test('the unread watch\'s own wake and report markers are not message differences', async () => {
    project();
    messageKeyOf(home);
    const found = findRoot(root);
    if (!found) throw new Error('not a checkout');
    const dropDir = recordDir(found, 'acme', 'lead');
    mkdirSync(dropDir, { recursive: true });
    // The unread watch reserves `<id>.wake` beside a message whose wake line it typed and
    // `<id>.reported` beside one whose sender and lead it told. Both are its own JSON markers,
    // not records: the scan must leave them alone rather than offer to remove them.
    const id = '11111111-1111-4111-8111-111111111111';
    for (const suffix of ['.wake', '.reported']) {
      writeFileSync(
        join(dropDir, `${id}${suffix}`),
        `${JSON.stringify({ id, at: NOW.toISOString(), state: 'reserved' })}\n`,
      );
    }
    const result = await run();
    expect(result).toEqual({
      code: 0,
      out: 'team acme, session "acme"\n  ID  FROM  TO  SENT  STATUS\n\nnote: nothing is waiting\n\n0 messages\n',
      err: '',
    });
    for (const suffix of ['.wake', '.reported']) expect(existsSync(join(dropDir, `${id}${suffix}`))).toBe(true);
  });

  test('seats print in seat order: builder-2, builder-9, builder-10, builder-100', async () => {
    project();
    // Planted in a deliberately wrong order: the filesystem's string order would print
    // builder-100 and builder-10 before builder-2 and builder-9.
    for (const seat of ['builder-100', 'builder-10', 'builder-2', 'builder-9', 'builder']) {
      plantMessage(home, root, seat, 'm1', payload({ to: seat, body: `body from ${seat}` }));
    }
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const seats = ['builder', 'builder-2', 'builder-9', 'builder-10', 'builder-100'];
    const rows = seats.map((seat) => `  m1  harness  ${seat.padEnd(11)}  0s ago  shown`).join('\n');
    const bodies = seats.map((seat) => `${seat}/m1:\nbody from ${seat}\n`).join('\n');
    expect(result.out).toBe(
      `team acme, session "acme"\n  ID  FROM     TO           SENT    STATUS\n${rows}\n\n${bodies}\n5 messages\n`,
    );
  });

  test('a waiting record and no message key shows nothing and creates no key', async () => {
    project();
    const found = findRoot(root);
    if (!found) throw new Error('not a checkout');
    mkdirSync(join(found, '.agents', 'messages', 'lead'), { recursive: true });
    writeFileSync(join(found, '.agents', 'messages', 'lead', 'm1.json'), '{}\n');
    const result = await run();
    expect(result).toEqual({ code: 1, out: '', err: 'team messages: no message key; nothing was shown\n' });
    expect(existsSync(messageKeyPath(home))).toBe(false);
    expect(existsSync(receiptFile(found, 'lead', 'm1'))).toBe(false);
  });

  async function runJson(argv: string[] = ['--json'], cwd = root): Promise<{ code: number; out: string; err: string }> {
    const io = testIo(cwd, { kind: 'owner' });
    const code = await runMessages(argv, io, { home, now: () => NOW });
    return { code, out: io.out, err: io.err };
  }

  type MessagesDoc = {
    schema: { name: string; version: number };
    format: number;
    project: string;
    session: string;
    rows: { id: string; from: string | null; to: string | null; sent: string | null; sent_display: string; status: string; body?: string }[];
    notes: string[];
    differences: { what: string; repair: string; who: string }[];
    summary: { differences: number; owner_differences: number };
    counts: { messages: number; shown: number; refused: number };
  };

  test('--json prints the empty inbox as one document, registered as team.messages', async () => {
    project();
    const result = await runJson();
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const doc = assertMatchesOutputSchema<MessagesDoc>(result.out, MESSAGES_OUTPUT_SCHEMA);
    expect(doc.schema).toEqual({ name: 'team.messages', version: 1 });
    expect(doc).toMatchObject({
      format: 1,
      project: 'acme',
      session: 'acme',
      rows: [],
      notes: ['nothing is waiting'],
      differences: [],
      summary: { differences: 0, owner_differences: 0 },
      counts: { messages: 0, shown: 0, refused: 0 },
    });
  });

  test('--json carries each shown body and the summary its table prints', async () => {
    project();
    const record = payload();
    plantMessage(home, record.root, 'lead', 'm1', record);
    const result = await runJson();
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const doc = assertMatchesOutputSchema<MessagesDoc>(result.out, MESSAGES_OUTPUT_SCHEMA);
    expect(doc.rows).toEqual([{
      id: 'm1',
      from: 'harness',
      to: 'lead',
      sent: '2026-10-04T09:00:00.000Z',
      sent_display: '0s ago',
      status: 'shown',
      body: BODY,
    }]);
    expect(doc.summary).toEqual({ differences: 0, owner_differences: 0 });
    expect(doc.counts).toEqual({ messages: 1, shown: 1, refused: 0 });
    expect(existsSync(receiptFile(record.root, 'lead', 'm1'))).toBe(true);
  });

  test('--json carries a refused record as a row and a difference, with no body', async () => {
    project();
    const record = payload();
    plantMessage(home, record.root, 'lead', 'm1', record, signDomain(MESSAGE_DOMAIN, record, keyOf(home)));
    const result = await runJson();
    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    const doc = assertMatchesOutputSchema<MessagesDoc>(result.out, MESSAGES_OUTPUT_SCHEMA);
    expect(doc.rows).toEqual([{
      id: 'm1',
      from: 'harness',
      to: 'lead',
      sent: '2026-10-04T09:00:00.000Z',
      sent_display: '0s ago',
      status: 'refused',
    }]);
    expect(doc.differences).toEqual([{
      what: "lead/m1 does not verify: the signature is not the message key's",
      repair: 'remove .agents/messages/lead/m1.json, or have the sender re-send it',
      who: 'any seat',
    }]);
    expect(doc.summary).toEqual({ differences: 1, owner_differences: 0 });
    expect(doc.counts).toEqual({ messages: 1, shown: 0, refused: 1 });
    expect(existsSync(receiptFile(record.root, 'lead', 'm1'))).toBe(false);
  });

  test('--json refusals are the structured error envelope, with stderr empty', async () => {
    project();
    const invocation = await runJson(['--json', 'extra']);
    expect(invocation.code).toBe(2);
    expect(invocation.err).toBe('');
    assertJsonErrorShape(invocation.out, { id: 'messages.invocation', messageContains: 'unexpected' });

    // --json read from raw argv: the parser's own error must not lose the structured face.
    for (const [argv, messageContains] of [
      [['--nope', '--json'], 'unknown option --nope'],
      [['--json=1'], 'unknown option --json'],
    ] as const) {
      const bad = await runJson([...argv]);
      expect(bad.code).toBe(2);
      expect(bad.err).toBe('');
      assertJsonErrorShape(bad.out, { id: 'messages.invocation', messageContains });
    }

    const notARepo = await runJson(['--json'], base);
    expect(notARepo.code).toBe(2);
    expect(notARepo.err).toBe('');
    assertJsonErrorShape(notARepo.out, { id: 'messages.not-a-repo', messageContains: 'not inside a git repository: run team from a project' });
    expect(notARepo.out).not.toContain('--file');

    rmSync(join(root, '.agents', 'team.yaml'));
    const file = await runJson();
    expect(file.code).toBe(1);
    expect(file.err).toBe('');
    assertJsonErrorShape(file.out, { id: 'messages.file', messageContains: 'no team file here' });
  });

  test('--json with a waiting record and no message key is the messages.key envelope', async () => {
    project();
    const found = findRoot(root);
    if (!found) throw new Error('not a checkout');
    mkdirSync(join(found, '.agents', 'messages', 'lead'), { recursive: true });
    writeFileSync(join(found, '.agents', 'messages', 'lead', 'm1.json'), '{}\n');
    const result = await runJson();
    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    assertJsonErrorShape(result.out, { id: 'messages.key', messageContains: 'no message key' });
  });

  // One receipt shape, whichever reader comes first: `inbox_read` and `team messages` both write
  // the signed `read` status receipt at `<id>.read.json`, and both know a message is read only
  // when that receipt verifies. The three orders below are the ones a seat can produce, and the
  // status can only move forward: a late reader never undoes a receipt already on disk.
  const ID = '7a6b5c4d-3e2f-418a-9b7c-6d5e4f3a2b1c';

  /** One transport-tree record and the inbox that serves it. */
  function recordScene(): { found: string; dropDir: string; context: { to: string; root: string; session: string } } {
    project();
    const found = findRoot(root);
    if (!found) throw new Error('not a checkout');
    plantRecord(home, found, 'acme', 'lead', ID, BODY, { at: '2026-10-04T09:00:00.000Z' });
    return {
      found,
      dropDir: recordDir(found, 'acme', 'lead'),
      context: { to: 'lead', root: found, session: 'acme' },
    };
  }

  function messageKey(): KeyObject {
    const state = messageKeyState(home);
    if (state.kind !== 'key') throw new Error('the fixture wrote no message key');
    return state.key;
  }

  test('an inbox read then team messages: the same signed receipt answers both', async () => {
    const scene = recordScene();
    const key = messageKey();

    const read = readMessage({ dropDir: scene.dropDir, root: scene.found, seat: 'lead', session: 'acme' }, ID, home);
    expect(read).toEqual({ ok: true, body: BODY });
    const receiptPath = recordReceiptFile(scene.dropDir, ID, 'read');
    const receipt = readFileSync(receiptPath, 'utf8');
    expect(statusOf(scene.dropDir, ID, scene.context, key)).toBe('read');

    // `team messages` sees the inbox's receipt and finds nothing waiting: it never shows the
    // message as `sent` again, and it does not rewrite the receipt.
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.out).toBe('team acme, session "acme"\n  ID  FROM  TO  SENT  STATUS\n\nnote: nothing is waiting\n\n0 messages\n');
    expect(readFileSync(receiptPath, 'utf8')).toBe(receipt);
    expect(listUnread(scene.dropDir, scene.context, home)).toEqual([]);
  });

  test('team messages first, then an inbox read: the inbox adds nothing and the status stays read', async () => {
    const scene = recordScene();
    const key = messageKey();

    const result = await run();
    expect(result.code).toBe(0);
    expect(result.out).toContain(BODY);
    const receiptPath = recordReceiptFile(scene.dropDir, ID, 'read');
    const receipt = readFileSync(receiptPath, 'utf8');
    expect(statusOf(scene.dropDir, ID, scene.context, key)).toBe('read');

    const read = readMessage({ dropDir: scene.dropDir, root: scene.found, seat: 'lead', session: 'acme' }, ID, home);
    // The receipt `team messages` already wrote proves the body went out: the inbox returns no
    // second copy, so the content is exposed at most once across both readers.
    expect(read).toEqual({
      ok: false,
      reason: `message ${JSON.stringify(ID)} was already served in this inbox`,
      served: 'already-served',
    });
    expect(readFileSync(receiptPath, 'utf8')).toBe(receipt);
    expect(statusOf(scene.dropDir, ID, scene.context, key)).toBe('read');
    expect(listUnread(scene.dropDir, scene.context, home)).toEqual([]);

    // A second `team messages` has nothing left to show either.
    const again = await run();
    expect(again.out).toBe('team acme, session "acme"\n  ID  FROM  TO  SENT  STATUS\n\nnote: nothing is waiting\n\n0 messages\n');
  });

  test('a read after a receipt already exists never lowers it', async () => {
    const scene = recordScene();
    const key = messageKey();

    // A `replied` receipt is the highest status; a read that arrives late must not move it back.
    const replied = writeReceipt(scene.dropDir, signReceiptPayload({
      kind: 'receipt',
      status: 'replied',
      id: ID,
      to: 'lead',
      root: scene.found,
      session: 'acme',
      at: '2026-10-04T09:05:00.000Z',
    }, home), home);
    expect(replied.ok).toBe(true);
    expect(statusOf(scene.dropDir, ID, scene.context, key)).toBe('replied');

    const read = readMessage({ dropDir: scene.dropDir, root: scene.found, seat: 'lead', session: 'acme' }, ID, home);
    // A `replied` receipt proves the body was served before the reply: no second copy is shown,
    // and no `read` receipt is written over the higher status.
    expect(read).toEqual({
      ok: false,
      reason: `message ${JSON.stringify(ID)} was already served in this inbox`,
      served: 'already-served',
    });
    expect(statusOf(scene.dropDir, ID, scene.context, key)).toBe('replied');
    expect(existsSync(recordReceiptFile(scene.dropDir, ID, 'read'))).toBe(false);
    expect(listUnread(scene.dropDir, scene.context, home)).toEqual([]);

    // Write-once: the repeat read leaves the durable status exactly where the replied receipt
    // put it, and still returns no body.
    const receipt = readFileSync(recordReceiptFile(scene.dropDir, ID, 'replied'), 'utf8');
    expect(readMessage({ dropDir: scene.dropDir, root: scene.found, seat: 'lead', session: 'acme' }, ID, home)).toEqual({
      ok: false,
      reason: `message ${JSON.stringify(ID)} was already served in this inbox`,
      served: 'already-served',
    });
    expect(readFileSync(recordReceiptFile(scene.dropDir, ID, 'replied'), 'utf8')).toBe(receipt);
  });

  // The seat-drop reader now shares the inbox's exclusive publication: a read or replied receipt
  // already serves the id, and an entry at either receipt name that does not verify is held rather
  // than repaired. These scenes keep the body count honest on both sides of the gate.
  test('a replied receipt already serves the id: team messages shows nothing and writes nothing', async () => {
    const scene = recordScene();
    const replied = writeReceipt(scene.dropDir, signReceiptPayload({
      kind: 'receipt',
      status: 'replied',
      id: ID,
      to: 'lead',
      root: scene.found,
      session: 'acme',
      at: '2026-10-04T09:05:00.000Z',
    }, home), home);
    expect(replied.ok).toBe(true);
    const before = readFileSync(recordReceiptFile(scene.dropDir, ID, 'replied'), 'utf8');

    const result = await run();
    expect(result.code).toBe(0);
    expect(result.out).toBe('team acme, session "acme"\n  ID  FROM  TO  SENT  STATUS\n\nnote: nothing is waiting\n\n0 messages\n');
    expect(result.out).not.toContain(BODY);
    expect(readFileSync(recordReceiptFile(scene.dropDir, ID, 'replied'), 'utf8')).toBe(before);
    expect(existsSync(recordReceiptFile(scene.dropDir, ID, 'read'))).toBe(false);
  });

  test('a damaged read receipt is held: no body, no rewrite, and the difference names it', async () => {
    const scene = recordScene();
    const path = recordReceiptFile(scene.dropDir, ID, 'read');
    const damaged = '{ not a receipt\n';
    writeFileSync(path, damaged, { mode: 0o600 });

    const result = await run();
    expect(result.code).toBe(1);
    expect(result.out).toContain(`lead/${ID}`);
    expect(result.out).toContain('the read receipt name is held by a file that does not verify for this message');
    expect(result.out).toContain(`repair: inspect .agents/send-drops/acme/lead/${ID}.read.json: it is left as it is`);
    expect(result.out).not.toContain(BODY);
    expect(readFileSync(path, 'utf8')).toBe(damaged);
  });

  test('a read receipt signed for another seat is held: no body, preserved', async () => {
    const scene = recordScene();
    const foreign = signReceiptPayload({
      kind: 'receipt',
      status: 'read',
      id: ID,
      to: 'worker',
      root: scene.found,
      session: 'acme',
      at: '2026-10-04T08:00:00.000Z',
    }, home);
    const written = writeReceipt(scene.dropDir, foreign, home);
    expect(written.ok).toBe(true);
    const path = recordReceiptFile(scene.dropDir, ID, 'read');
    const before = readFileSync(path, 'utf8');

    const result = await run();
    expect(result.code).toBe(1);
    expect(result.out).toContain('the read receipt name is held by a file that does not verify for this message');
    expect(result.out).not.toContain(BODY);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('a damaged replied receipt is held: the read shows no body and leaves it alone', async () => {
    const scene = recordScene();
    const path = recordReceiptFile(scene.dropDir, ID, 'replied');
    const damaged = '{ not a receipt\n';
    writeFileSync(path, damaged, { mode: 0o600 });

    const result = await run();
    expect(result.code).toBe(1);
    expect(result.out).toContain('the replied receipt name is held by a file that does not verify for this message');
    expect(result.out).not.toContain(BODY);
    expect(readFileSync(path, 'utf8')).toBe(damaged);
    expect(existsSync(recordReceiptFile(scene.dropDir, ID, 'read'))).toBe(false);
  });

  test('one held receipt refuses only its own record, and --json keeps bodies and counts aligned', async () => {
    const scene = recordScene();
    const second = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
    plantRecord(home, scene.found, 'acme', 'lead', second, 'the second body', { at: '2026-10-04T09:00:00.000Z' });
    const damagedPath = recordReceiptFile(scene.dropDir, ID, 'read');
    const damaged = '{ not a receipt\n';
    writeFileSync(damagedPath, damaged, { mode: 0o600 });

    const result = await runJson();
    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    const doc = assertMatchesOutputSchema<MessagesDoc>(result.out, MESSAGES_OUTPUT_SCHEMA);
    const refused = doc.rows.find((row) => row.id === ID);
    const shown = doc.rows.find((row) => row.id === second);
    expect(refused).toMatchObject({ status: 'refused' });
    expect(refused).not.toHaveProperty('body');
    expect(shown).toMatchObject({ status: 'shown', body: 'the second body' });
    expect(doc.differences.map((difference) => difference.what)).toEqual([
      `lead/${ID} was not shown: the read receipt name is held by a file that does not verify for this message`,
    ]);
    expect(doc.counts).toEqual({ messages: 2, shown: 1, refused: 1 });
    expect(doc.summary).toEqual({ differences: 1, owner_differences: 0 });
    expect(readFileSync(damagedPath, 'utf8')).toBe(damaged);
  });

  test('an unwritable receipt folder shows no body, and the id is served once it can be written', async () => {
    const scene = recordScene();
    chmodSync(scene.dropDir, 0o500);
    try {
      const result = await run();
      expect(result.code).toBe(1);
      expect(result.out).toContain('the read receipt could not be written');
      expect(result.out).not.toContain(BODY);
    } finally {
      chmodSync(scene.dropDir, 0o700);
    }
    expect(existsSync(recordReceiptFile(scene.dropDir, ID, 'read'))).toBe(false);

    const again = await run();
    expect(again.code).toBe(0);
    expect(again.out).toContain(BODY);
    expect(statusOf(scene.dropDir, ID, scene.context, messageKey())).toBe('read');
  });

  /** A real child process that runs the manual reader after a barrier file appears. */
  function messagesChild(atBase: string): string {
    const script = join(atBase, 'messages-child.ts');
    writeFileSync(script, `import { existsSync } from 'node:fs';
import { runMessages } from ${JSON.stringify(moduleUrl('src/commands/messages.ts'))};
import { testIo } from ${JSON.stringify(pathToFileURL(join(HERE, 'helpers.ts')).href)};
const [cwd, home, barrier] = process.argv.slice(2);
while (barrier !== '' && !existsSync(barrier)) await new Promise((tick) => setTimeout(tick, 5));
const io = testIo(cwd, { kind: 'owner' });
const code = await runMessages([], io, { home, now: () => new Date() });
console.log(JSON.stringify({ code, out: io.out, err: io.err }));
`);
    return script;
  }

  /** A real child process that takes the automatic read (`inbox_read`'s gate) after the barrier. */
  function inboxReadChild(atBase: string): string {
    const script = join(atBase, 'inbox-read-child.ts');
    writeFileSync(script, `import { existsSync } from 'node:fs';
import { readMessage } from ${JSON.stringify(moduleUrl('src/mcp/inbox.ts'))};
const [dropDir, root, seat, session, home, id, barrier] = process.argv.slice(2);
while (barrier !== '' && !existsSync(barrier)) await new Promise((tick) => setTimeout(tick, 5));
console.log(JSON.stringify(readMessage({ dropDir, root, seat, session }, id, home)));
`);
    return script;
  }

  type Child = { code: number | null; out: string; err: string };

  function runInBackground(script: string, args: readonly string[]): Promise<Child> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf8');
      });
      child.on('close', (code) => resolve({ code, out, err }));
    });
  }

  test('a receipt publisher temp beside a record is not a message', async () => {
    const scene = recordScene();
    const temp = join(scene.dropDir, `${ID}.read.json.5277.6ab5ce3fc4a8.new`);
    writeFileSync(temp, '{}\n');
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain(BODY);
    expect(result.out).not.toContain('.new');
    expect(existsSync(temp)).toBe(true);
    expect(statusOf(scene.dropDir, ID, scene.context, messageKey())).toBe('read');
  });

  test('team messages and an automatic read racing one record expose exactly one body', async () => {
    const scene = recordScene();
    const barrier = join(base, 'go');
    const manual = runInBackground(messagesChild(base), [scene.found, home, barrier]);
    const automatic = runInBackground(inboxReadChild(base), [
      scene.dropDir, scene.found, 'lead', 'acme', home, ID, barrier,
    ]);
    // Both children wait at the barrier: nothing serves this id before the race starts.
    await new Promise((tick) => setTimeout(tick, 100));
    expect(existsSync(recordReceiptFile(scene.dropDir, ID, 'read'))).toBe(false);
    writeFileSync(barrier, 'go\n');
    const [manualRun, automaticRun] = await Promise.all([manual, automatic]);
    // Both children whole, so a failure names the run that caused it: the product's own stdout
    // (a refusal's difference text lives there), its stderr, and each child's exit. They travel in
    // every assertion below; a passing run prints none of it.
    const detail = [
      `manual child: exit ${String(manualRun.code)}, stdout ${JSON.stringify(manualRun.out)}, stderr ${JSON.stringify(manualRun.err)}`,
      `automatic child: exit ${String(automaticRun.code)}, stdout ${JSON.stringify(automaticRun.out)}, stderr ${JSON.stringify(automaticRun.err)}`,
    ].join('\n');
    let manualResult: { code: number; out: string; err: string };
    let automaticResult: { ok: boolean; body?: string; served?: string };
    try {
      manualResult = JSON.parse(manualRun.out) as typeof manualResult;
      automaticResult = JSON.parse(automaticRun.out) as typeof automaticResult;
    } catch {
      throw new Error(`a child printed no JSON\n${detail}`);
    }

    // The gate first, the exits last: an earlier run exited 1 with no body and the evidence was
    // lost with the child's stdout. Counted, never inferred: exactly one side returns the body.
    const exposed = (manualResult.out.includes(BODY) ? 1 : 0) + (automaticResult.body === BODY ? 1 : 0);
    expect({ exposed, detail }).toEqual({ exposed: 1, detail });
    if (automaticResult.ok) {
      expect({ body: automaticResult.body, detail }).toEqual({ body: BODY, detail });
      expect({ manualOut: manualResult.out.includes(BODY), detail }).toEqual({ manualOut: false, detail });
    } else {
      expect({ served: automaticResult.served, detail }).toEqual({ served: 'already-served', detail });
      expect({ manualOut: manualResult.out.includes(BODY), detail }).toEqual({ manualOut: true, detail });
    }
    // One signed read receipt stands, it verifies, and no publisher's temp is left behind.
    expect({ status: statusOf(scene.dropDir, ID, scene.context, messageKey()), detail })
      .toEqual({ status: 'read', detail });
    expect({ temps: readdirSync(scene.dropDir).filter((name) => name.endsWith('.new')), detail })
      .toEqual({ temps: [], detail });

    // Every exit is last, so a refusal reaches the gate checks above before it fails a run.
    expect({
      manualProduct: manualResult.code,
      manualStderr: manualResult.err,
      manualProcess: manualRun.code,
      automaticProcess: automaticRun.code,
      detail,
    }).toEqual({ manualProduct: 0, manualStderr: '', manualProcess: 0, automaticProcess: 0, detail });
  });

  // A general seat brief is waiting for the seat's own turn-start reader: its receipt is bound to
  // the seat's current claim, so this checkout-wide reading skips it rather than spend the id.
  /** One signed general seat brief waiting in `seat`'s drop folder, at the pinned instant. */
  function plantBrief(found: string, seat: string): ReturnType<typeof generalBriefRecord> {
    const brief = generalBriefRecord({
      to: seat,
      root: found,
      session: 'acme',
      at: NOW.toISOString(),
      incarnation: 'inc_aaaaaaaaaaaa',
    });
    const written = writeRecord(recordDir(found, 'acme', seat), signRecord(brief, home));
    if (!written.ok) throw new Error(written.reason);
    return brief;
  }

  test('a waiting general seat brief is skipped, and the ordinary record beside it is served', async () => {
    project();
    const found = findRoot(root);
    if (!found) throw new Error('not a checkout');
    plantRecord(home, found, 'acme', 'lead', 'm1', BODY, { from: 'harness', at: '2026-10-04T09:00:00.000Z' });
    const brief = plantBrief(found, 'worker');
    const workerDrop = recordDir(found, 'acme', 'worker');

    const result = await run();
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain(`lead/m1:\n${BODY}`);
    expect(result.out).toContain(
      "note: worker: the general seat brief is not shown here; the seat's own turn-start reader serves it.",
    );
    expect(result.out).not.toContain(brief.id);
    expect(result.out).not.toContain('admitted by:');
    expect(result.out.endsWith('1 message\n')).toBe(true);

    // The ordinary record's receipt stands; the brief's id is still waiting for its own reader.
    expect(statusOf(recordDir(found, 'acme', 'lead'), 'm1', { to: 'lead', root: found, session: 'acme' }, messageKey())).toBe('read');
    expect(existsSync(recordReceiptFile(workerDrop, brief.id, 'read'))).toBe(false);
    expect(listUnread(workerDrop, { to: 'worker', root: found, session: 'acme' }, home).map((message) => message.id)).toEqual([brief.id]);
  });

  test('a mailbox holding only a general seat brief reads zero messages and names the seat', async () => {
    project();
    const found = findRoot(root);
    if (!found) throw new Error('not a checkout');
    plantBrief(found, 'worker');

    const result = await run();
    expect(result).toEqual({
      code: 0,
      out: 'team acme, session "acme"\n  ID  FROM  TO  SENT  STATUS\n\n' +
        "note: worker: the general seat brief is not shown here; the seat's own turn-start reader serves it.\n\n" +
        '0 messages\n',
      err: '',
    });

    const json = await runJson();
    expect(json.code).toBe(0);
    expect(json.err).toBe('');
    const doc = assertMatchesOutputSchema<MessagesDoc>(json.out, MESSAGES_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({
      format: 1,
      project: 'acme',
      session: 'acme',
      rows: [],
      notes: ["worker: the general seat brief is not shown here; the seat's own turn-start reader serves it."],
      differences: [],
      summary: { differences: 0, owner_differences: 0 },
      counts: { messages: 0, shown: 0, refused: 0 },
    });
  });

  test('a general seat brief that does not verify is refused before the skip', async () => {
    project();
    const found = findRoot(root);
    if (!found) throw new Error('not a checkout');
    const brief = generalBriefRecord({
      to: 'worker',
      root: found,
      session: 'acme',
      at: NOW.toISOString(),
      incarnation: 'inc_bbbbbbbbbbbb',
    });
    // The message key exists, so the run reaches verification; the signature is the approval key's.
    messageKeyOf(home);
    const written = writeRecord(recordDir(found, 'acme', 'worker'), {
      payload: brief,
      signature: signDomain(MESSAGE_DOMAIN, brief, keyOf(home)),
    });
    if (!written.ok) throw new Error(written.reason);

    const result = await run();
    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    expect(result.out).toContain(`worker/${brief.id}`);
    expect(result.out).toContain("the signature is not the message key's");
    expect(result.out).not.toContain('the general seat brief is not shown here');
    expect(result.out).not.toContain('admitted by:');
    expect(existsSync(recordReceiptFile(recordDir(found, 'acme', 'worker'), brief.id, 'read'))).toBe(false);
  });

  test('a general seat brief already served leaves the zero-message reading unchanged', async () => {
    project();
    const found = findRoot(root);
    if (!found) throw new Error('not a checkout');
    const brief = plantBrief(found, 'worker');
    const workerDrop = recordDir(found, 'acme', 'worker');
    const served = writeReceipt(workerDrop, signReceiptPayload({
      kind: 'receipt',
      status: 'read',
      id: brief.id,
      to: 'worker',
      root: found,
      session: 'acme',
      at: '2026-10-04T09:01:00.000Z',
    }, home), home);
    expect(served.ok).toBe(true);

    expect(await run()).toEqual({
      code: 0,
      out: 'team acme, session "acme"\n  ID  FROM  TO  SENT  STATUS\n\nnote: nothing is waiting\n\n0 messages\n',
      err: '',
    });
    expect(existsSync(recordReceiptFile(workerDrop, brief.id, 'read'))).toBe(true);
  });
});
