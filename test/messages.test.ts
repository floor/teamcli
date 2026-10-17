import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRoot } from '../src/file/load.ts';
import { messageFile, plantMessage, receiptFile, runMessages, type MessagePayload } from '../src/commands/messages.ts';
import { keyFingerprint, keyOf, MESSAGE_DOMAIN, messageKeyOf, messageKeyPath, signDomain } from '../src/store/keys.ts';
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

/** The one waiting record of the fixture, at the pinned instant, as the reading prints it. */
const SHOWN = `team acme, session "acme"
  ID  FROM     TO    SENT    STATUS
  m1  harness  lead  0s ago  shown

lead/m1:
${BODY}

1 message(s)
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
      out: 'team acme, session "acme"\n  ID  FROM  TO  SENT  STATUS\n\nnote: nothing is waiting\n\n0 message(s)\n',
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
      out: 'team acme, session "acme"\n  ID  FROM  TO  SENT  STATUS\n\nnote: nothing is waiting\n\n0 message(s)\n',
      err: '',
    });
    expect(readFileSync(receiptFile(record.root, 'lead', 'm1'), 'utf8')).toBe(receipt);
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

1 message(s)
`);
    expect(result.err).toBe('');
    expect(existsSync(receiptFile(record.root, 'lead', 'm1'))).toBe(false);
    expect(existsSync(messageFile(record.root, 'lead', 'm1'))).toBe(true);
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

1 message(s)
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

1 message(s)
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

1 message(s)
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

1 message(s)
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

1 message(s)
`);
    expect(result.err).toBe('');
    expect(existsSync(receiptFile(found, 'lead', 'm1'))).toBe(false);
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

    const notARepo = await runJson(['--json'], base);
    expect(notARepo.code).toBe(2);
    expect(notARepo.err).toBe('');
    assertJsonErrorShape(notARepo.out, { id: 'messages.not-a-repo', messageContains: 'not inside a git repository' });

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
});
