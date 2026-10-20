// `team ack <id>`: one signed read receipt beside the message it names, with no body printed.
//
// The receipt is the same gate `team messages` publishes before it shows a body, so the message
// stops waiting for its addressee: `team drops` no longer lists it, and the unread watch neither
// wakes it nor reports it. A `replied` receipt is the read that came before the answer and serves
// the id too. The record is found and judged the way `team reply` finds it — verified, addressed
// to the caller, in the addressee's own folder — and an entry at a receipt name this build did not
// sign is left exactly as it is.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runAck, USAGE, type AckHost } from '../src/commands/ack.ts';
import { plantRecord, recordDir, runMessages } from '../src/commands/messages.ts';
import { listUnread, receiptPath } from '../src/mcp/inbox.ts';
import { receiptFile, recordFile, signedReceiptOf, signReceiptPayload, verifyReceipt, writeReceipt } from '../src/send/record.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-18T15:30:00.000Z');
const NOW_ISO = NOW.toISOString();

const SENT = '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d';

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
`;

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-ack-')));
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

function host(now: Date = NOW): AckHost {
  return { home, now: () => now };
}

async function run(
  argv: string[],
  caller: Caller = { kind: 'owner' },
  now: Date = NOW,
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
  const code = await runAck(argv, io, host(now));
  return { code, out: io.out, err: io.err };
}

/** The state record a placed seat is judged by: the pane the fixture's caller runs on. */
function place(name: string, pane: string): void {
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = { seats: { [name]: { stage: 'ready' as const, pane } } } as never;
  });
}

/** A record `team send` would have written: signed, in the addressee's folder. */
function sentTo(seat: string, id: string, fields: Parameters<typeof plantRecord>[6] = {}): string {
  return plantRecord(home, root, 'acme', seat, id, 'from the lead\n\na question', { at: NOW_ISO, from: 'lead', ...fields });
}

function readReceipt(seat: string): string {
  const receipt = signedReceiptOf(JSON.parse(readFileSync(receiptFile(recordDir(root, 'acme', seat), SENT, 'read'), 'utf8')));
  if (receipt === null) throw new Error('no read receipt');
  return JSON.stringify(receipt);
}

describe('team ack marks one message read without printing it', () => {
  test('the owner acknowledges a message to itself: a signed read receipt, and no body in the output', async () => {
    sentTo('owner', SENT);
    const result = await run([SENT]);

    expect(result).toEqual({ code: 0, out: 'team acme, session "acme"\n' + SENT + ': read\n', err: '' });
    expect(result.out.includes('a question')).toBe(false);
    const signed = signedReceiptOf(JSON.parse(readFileSync(receiptFile(recordDir(root, 'acme', 'owner'), SENT, 'read'), 'utf8')));
    expect(signed).not.toBeNull();
    expect(verifyReceipt(signed!, messageKeyOf(home))).toBe(true);
    expect(signed!.payload).toEqual({ kind: 'receipt', status: 'read', id: SENT, to: 'owner', root, session: 'acme', at: NOW_ISO });
    // The message is no longer waiting, and the next read serves no body.
    expect(listUnread(recordDir(root, 'acme', 'owner'), { to: 'owner', root, session: 'acme' }, home)).toEqual([]);
    const io = testIo(root, { kind: 'owner' });
    expect(await runMessages([], io, { home, now: () => NOW })).toBe(0);
    expect(io.out).toContain('nothing is waiting');
  });

  test('a second acknowledgement is idempotent: exit 0, the first receipt byte for byte, nothing rewritten', async () => {
    sentTo('owner', SENT);
    expect((await run([SENT])).code).toBe(0);
    const first = readFileSync(receiptFile(recordDir(root, 'acme', 'owner'), SENT, 'read'), 'utf8');
    // A later clock would rewrite the receipt's `at` if this run published a second one.
    const again = await run([SENT], { kind: 'owner' }, new Date(NOW.getTime() + 60_000));

    expect(again.code).toBe(0);
    expect(again.err).toBe('');
    expect(again.out).toBe(`team acme, session "acme"\n${SENT}: read\n`);
    expect(readFileSync(receiptFile(recordDir(root, 'acme', 'owner'), SENT, 'read'), 'utf8')).toBe(first);
  });

  test('a replied receipt already serves the id: ack leaves it as the read and writes no read receipt', async () => {
    sentTo('owner', SENT);
    const replied = signReceiptPayload({ kind: 'receipt', status: 'replied', id: SENT, to: 'owner', root, session: 'acme', at: NOW_ISO }, home);
    expect(writeReceipt(recordDir(root, 'acme', 'owner'), replied, home).ok).toBe(true);

    const result = await run([SENT]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`team acme, session "acme"\n${SENT}: read\n`);
    expect(existsSync(receiptFile(recordDir(root, 'acme', 'owner'), SENT, 'read'))).toBe(false);
  });

  test('a seat acknowledges a message to it on its own pane: the receipt names that seat', async () => {
    sentTo('worker', SENT);
    place('worker', 'w2:p1');
    const result = await run([SENT], { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' });

    expect(result).toEqual({ code: 0, out: `team acme, session "acme"\n${SENT}: read\n`, err: '' });
    const signed = signedReceiptOf(JSON.parse(readFileSync(receiptFile(recordDir(root, 'acme', 'worker'), SENT, 'read'), 'utf8')));
    expect(signed!.payload.to).toBe('worker');
    expect(verifyReceipt(signed!, messageKeyOf(home))).toBe(true);
  });

  test('a seat on another pane than the one the state records is refused, and writes nothing', async () => {
    sentTo('worker', SENT);
    place('worker', 'w2:p1');
    const result = await run([SENT], { kind: 'seat', name: 'worker', pane: 'w9:p9', session: 'acme' });

    expect(result.code).toBe(1);
    expect(result.err).toContain('is not this call on its own pane and session');
    expect(existsSync(receiptFile(recordDir(root, 'acme', 'worker'), SENT, 'read'))).toBe(false);
  });

  test('a record addressed to another seat is refused: one seat never spends another seat\'s mail', async () => {
    sentTo('worker', SENT);
    const result = await run([SENT]);

    expect(result.code).toBe(1);
    expect(result.err).toBe(`team ack: record ${SENT} is addressed to worker, not to owner\n`);
    expect(existsSync(receiptFile(recordDir(root, 'acme', 'worker'), SENT, 'read'))).toBe(false);
  });

  test('a record addressed to the caller but sitting in another seat\'s folder is refused', async () => {
    sentTo('owner', SENT);
    const from = recordFile(recordDir(root, 'acme', 'owner'), SENT);
    const into = join(recordDir(root, 'acme', 'worker'), SENT);
    mkdirSync(recordDir(root, 'acme', 'worker'), { recursive: true });
    renameSync(from, into);

    const result = await run([SENT]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('it waits in another seat\'s folder');
    expect(existsSync(receiptFile(recordDir(root, 'acme', 'worker'), SENT, 'read'))).toBe(false);
  });

  test('an unsigned file at the read receipt name is held, never replaced', async () => {
    sentTo('owner', SENT);
    const held = receiptFile(recordDir(root, 'acme', 'owner'), SENT, 'read');
    writeFileSync(held, '{"payload":{},"signature":"deadbeef"}\n');
    const io = testIo(root, { kind: 'owner' });
    const code = await runAck([SENT, '--json'], io, host());

    expect(code).toBe(1);
    const doc = JSON.parse(io.out) as { error: { id: string; message: string; repair: string } };
    expect(doc.error.id).toBe('ack.refused');
    expect(doc.error.message).toContain('the read receipt name is held by a file that does not verify for this message');
    expect(doc.error.repair).toContain('inspect .agents/send-drops/acme/owner/');
    expect(readFileSync(held, 'utf8')).toBe('{"payload":{},"signature":"deadbeef"}\n');
  });

  test('the id is looked up first: an id nothing holds is refused without writing, and an earlier build\'s mail is read elsewhere', async () => {
    const missing = await run([SENT]);
    expect(missing.code).toBe(1);
    expect(missing.err).toBe(`team ack: no record named ${SENT} waits in this project's session "acme"\n`);

    mkdirSync(join(root, '.agents', 'messages', 'owner'), { recursive: true });
    writeFileSync(join(root, '.agents', 'messages', 'owner', `${SENT}.json`), '{}\n');
    const legacy = await run([SENT]);
    expect(legacy.code).toBe(1);
    expect(legacy.err).toContain('written by an earlier build');
  });

  test('the JSON document carries the record, the addressee and whether this run wrote the receipt', async () => {
    sentTo('owner', SENT);
    const firstIo = testIo(root, { kind: 'owner' });
    expect(await runAck([SENT, '--json'], firstIo, host())).toBe(0);
    const first = JSON.parse(firstIo.out) as Record<string, unknown>;
    expect(first).toMatchObject({
      schema: { name: 'team.ack', version: 1 },
      format: 1,
      status: 'read',
      action_summary: `${SENT}: read`,
      project: 'acme',
      session: 'acme',
      record: SENT,
      to: 'owner',
      thread: SENT,
      written: true,
      at: NOW_ISO,
    });
    const secondIo = testIo(root, { kind: 'owner' });
    expect(await runAck([SENT, '--json'], secondIo, host())).toBe(0);
    expect((JSON.parse(secondIo.out) as Record<string, unknown>).written).toBe(false);
  });

  test('the invocation is read strictly: a missing id, a second word, a bad id and an unknown flag all exit 2', async () => {
    for (const argv of [[], [SENT, 'extra'], ['no/record'], ['--nope']]) {
      const result = await run(argv);
      expect(result.code).toBe(2);
      expect(result.err.startsWith('team ack: ')).toBe(true);
    }
    const usage = await run([]);
    expect(usage.err).toContain(USAGE);
  });

  test('a team file that cannot be read exits 2 before any record is looked up', async () => {
    writeFileSync(join(root, '.agents', 'team.yaml'), 'format: [\n');
    const result = await run([SENT]);
    expect(result.code).toBe(2);
    expect(result.err.startsWith('team ack: ')).toBe(true);
  });
});

describe('an acknowledged message stops ringing', () => {
  test('listUnread no longer waits on it, and team drops reports nothing', async () => {
    sentTo('owner', SENT);
    const context = { to: 'owner', root, session: 'acme' };
    expect(listUnread(recordDir(root, 'acme', 'owner'), context, home)).toHaveLength(1);
    expect((await run([SENT])).code).toBe(0);
    expect(listUnread(recordDir(root, 'acme', 'owner'), context, home)).toEqual([]);
    // The signed receipt is the one path `team drops` consults, and the file it reads is the
    // receipt at the message's own name.
    expect(existsSync(receiptPath(recordDir(root, 'acme', 'owner'), SENT))).toBe(true);
  });
});
