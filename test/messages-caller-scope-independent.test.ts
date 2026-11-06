import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
import { receiptFile as recordReceiptFile, statusOf } from '../src/send/record.ts';
import { messageKeyOf, messageKeyPath, messageKeyState } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

const TEAM = `format: 1
project: acme
coordinator: orchestrator
operator: orchestrator
workspace:
  mode: shared
seats:
  - role: coordinator
    name: orchestrator
    label: orchestrator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker-a
    label: worker-a
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker-b
    label: worker-b
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const AT = '2026-11-04T07:55:00.000Z';
const NOW = new Date(AT);

const WORKER_A: Caller = { kind: 'seat', name: 'worker-a', pane: 'pane-a', session: 'acme' };
const WORKER_B: Caller = { kind: 'seat', name: 'worker-b', pane: 'pane-b', session: 'acme' };
const ORCHESTRATOR: Caller = { kind: 'seat', name: 'orchestrator', pane: 'pane-orch', session: 'acme' };
const OWNER: Caller = { kind: 'owner' };

type MessagesDoc = {
  format: number;
  project: string;
  session: string;
  rows: { id: string; from: string | null; to: string | null; sent: string | null; sent_display: string; status: string; sender_attribution: string; body?: string }[];
  notes: string[];
  differences: { what: string; repair: string; who: string }[];
  counts: { messages: number; shown: number; refused: number; waiting: number };
};

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'messages-caller-scope-ind-'));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function found(): string {
  const checkout = findRoot(root);
  if (!checkout) throw new Error('not a checkout');
  return checkout;
}

function payload(over: Partial<MessagePayload> = {}): MessagePayload {
  return {
    kind: 'message',
    id: 'owner-1',
    to: 'owner',
    root: found(),
    session: 'acme',
    at: AT,
    body: 'SECRET_BODY_OWNER',
    from: 'orchestrator',
    ...over,
  };
}

async function run(argv: string[], caller: Caller): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
  const code = await runMessages(argv, io, { home, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

function messageKey(): ReturnType<typeof messageKeyOf> {
  const state = messageKeyState(home);
  if (state.kind !== 'key') throw new Error('expected message key');
  return state.key;
}

describe('independent caller mailbox scope verification', () => {
  test('seat A publishes receipts only for seat A; seat B, orchestrator, and owner stay unread until each runs its own reader', async () => {
    const where = found();
    const idA = '11111111-1111-4111-8111-111111111111';
    const idB = '22222222-2222-4222-8222-222222222222';
    const idOrch = '33333333-3333-4333-8333-333333333333';

    plantRecord(home, where, 'acme', 'worker-a', idA, 'SECRET_BODY_WORKER_A', { from: 'orchestrator', at: AT });
    plantRecord(home, where, 'acme', 'worker-b', idB, 'SECRET_BODY_WORKER_B', { from: 'orchestrator', at: AT });
    plantRecord(home, where, 'acme', 'orchestrator', idOrch, 'SECRET_BODY_ORCHESTRATOR', { from: 'worker-a', at: AT });
    plantMessage(home, where, 'owner', 'owner-1', payload());

    // 1. Seat A reads in text mode: serves only worker-a, leaves 3 waiting
    const resA = await run([], WORKER_A);
    expect(resA.code).toBe(0);
    expect(resA.err).toBe('');
    expect(resA.out).toContain('orchestrator (unverified claim)');
    expect(resA.out).toContain(`worker-a/${idA}:\nfrom orchestrator (team lead):\n\nSECRET_BODY_WORKER_A`);
    expect(resA.out).not.toContain('SECRET_BODY_WORKER_B');
    expect(resA.out).not.toContain('SECRET_BODY_ORCHESTRATOR');
    expect(resA.out).not.toContain('SECRET_BODY_OWNER');
    expect(resA.out).toContain(
      'note: 3 messages addressed to another mailbox are waiting; they are listed without their bodies, and no receipts are written for them.',
    );

    // Only worker-a has a receipt; worker-b, orchestrator, and owner remain unread
    expect(statusOf(recordDir(where, 'acme', 'worker-a'), idA, { to: 'worker-a', root: where, session: 'acme' }, messageKey())).toBe('read');
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'worker-b'), idB, 'read'))).toBe(false);
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'orchestrator'), idOrch, 'read'))).toBe(false);
    expect(existsSync(receiptFile(where, 'owner', 'owner-1'))).toBe(false);
    expect(listUnread(recordDir(where, 'acme', 'worker-a'), { to: 'worker-a', root: where, session: 'acme' }, home)).toEqual([]);
    expect(listUnread(recordDir(where, 'acme', 'worker-b'), { to: 'worker-b', root: where, session: 'acme' }, home).map((m) => m.id)).toEqual([idB]);
    expect(listUnread(recordDir(where, 'acme', 'orchestrator'), { to: 'orchestrator', root: where, session: 'acme' }, home).map((m) => m.id)).toEqual([idOrch]);

    // 2. Seat A reads again in JSON mode: 0 shown, 3 waiting
    const resA2 = await run(['--json'], WORKER_A);
    expect(resA2.code).toBe(0);
    const docA2 = assertMatchesOutputSchema<MessagesDoc>(resA2.out, MESSAGES_OUTPUT_SCHEMA);
    expect(docA2.counts).toEqual({ messages: 3, shown: 0, refused: 0, waiting: 3 });
    expect(docA2.rows.map((r) => [r.to, r.status, r.body])).toEqual([
      ['orchestrator', 'waiting', undefined],
      ['worker-b', 'waiting', undefined],
      ['owner', 'waiting', undefined],
    ]);

    // 3. Seat B reads in JSON mode: serves only worker-b, leaves 2 waiting
    const resB = await run(['--json'], WORKER_B);
    expect(resB.code).toBe(0);
    const docB = assertMatchesOutputSchema<MessagesDoc>(resB.out, MESSAGES_OUTPUT_SCHEMA);
    expect(docB.counts).toEqual({ messages: 3, shown: 1, refused: 0, waiting: 2 });
    expect(docB.rows.find((r) => r.to === 'worker-b')).toMatchObject({
      id: idB,
      status: 'shown',
      body: 'SECRET_BODY_WORKER_B',
    });
    expect(resB.out).not.toContain('SECRET_BODY_ORCHESTRATOR');
    expect(resB.out).not.toContain('SECRET_BODY_OWNER');
    expect(statusOf(recordDir(where, 'acme', 'worker-b'), idB, { to: 'worker-b', root: where, session: 'acme' }, messageKey())).toBe('read');
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'orchestrator'), idOrch, 'read'))).toBe(false);

    // 4. Orchestrator reads in JSON mode: serves only orchestrator, leaves 1 waiting
    const resOrch = await run(['--json'], ORCHESTRATOR);
    expect(resOrch.code).toBe(0);
    const docOrch = assertMatchesOutputSchema<MessagesDoc>(resOrch.out, MESSAGES_OUTPUT_SCHEMA);
    expect(docOrch.counts).toEqual({ messages: 2, shown: 1, refused: 0, waiting: 1 });
    expect(docOrch.rows.find((r) => r.to === 'orchestrator')).toMatchObject({
      id: idOrch,
      status: 'shown',
      body: 'SECRET_BODY_ORCHESTRATOR',
    });
    expect(resOrch.out).not.toContain('SECRET_BODY_OWNER');
    expect(statusOf(recordDir(where, 'acme', 'orchestrator'), idOrch, { to: 'orchestrator', root: where, session: 'acme' }, messageKey())).toBe('read');
    expect(existsSync(receiptFile(where, 'owner', 'owner-1'))).toBe(false);

    // 5. Owner reads in JSON mode: serves owner-1, 0 waiting remain
    const resOwner = await run(['--json'], OWNER);
    expect(resOwner.code).toBe(0);
    const docOwner = assertMatchesOutputSchema<MessagesDoc>(resOwner.out, MESSAGES_OUTPUT_SCHEMA);
    expect(docOwner.counts).toEqual({ messages: 1, shown: 1, refused: 0, waiting: 0 });
    expect(docOwner.rows).toEqual([
      { id: 'owner-1', from: 'orchestrator', to: 'owner', sent: AT, sent_display: '0s ago', status: 'shown', sender_attribution: 'attributed', body: 'SECRET_BODY_OWNER' },
    ]);
    expect(existsSync(receiptFile(where, 'owner', 'owner-1'))).toBe(true);
  });

  test('invalid record in seat B mailbox does not cause seat A read to fail or report a refusal, but seat B refuses it', async () => {
    const where = found();
    plantRecord(home, where, 'acme', 'worker-a', 'a-clean', 'clean mail for worker-a', { from: 'orchestrator', at: AT });
    plantRecord(home, where, 'acme', 'worker-b', 'b-clean', 'clean mail for worker-b', { from: 'orchestrator', at: AT });
    const dirB = recordDir(where, 'acme', 'worker-b');
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirB, '0000-corrupt'), JSON.stringify({ payload: { broken: true }, signature: 'invalid' }));

    // Seat A reads: exits 0, shows a-clean, lists both worker-b records as waiting, 0 refused
    const resA = await run(['--json'], WORKER_A);
    expect(resA.code).toBe(0);
    const docA = assertMatchesOutputSchema<MessagesDoc>(resA.out, MESSAGES_OUTPUT_SCHEMA);
    expect(docA.counts).toEqual({ messages: 3, shown: 1, refused: 0, waiting: 2 });
    expect(docA.differences).toEqual([]);
    expect(docA.rows).toEqual([
      { id: 'a-clean', from: 'orchestrator', to: 'worker-a', sent: AT, sent_display: '0s ago', status: 'shown', sender_attribution: 'attributed', body: 'clean mail for worker-a' },
      { id: '0000-corrupt', from: null, to: 'worker-b', sent: null, sent_display: '-', status: 'waiting', sender_attribution: 'none' },
      { id: 'b-clean', from: 'orchestrator', to: 'worker-b', sent: AT, sent_display: '0s ago', status: 'waiting', sender_attribution: 'attributed' },
    ]);

    // Seat B reads: exits 1, refuses 0000-corrupt and serves b-clean
    const resB = await run(['--json'], WORKER_B);
    expect(resB.code).toBe(1);
    const docB = assertMatchesOutputSchema<MessagesDoc>(resB.out, MESSAGES_OUTPUT_SCHEMA);
    expect(docB.counts).toEqual({ messages: 2, shown: 1, refused: 1, waiting: 0 });
    expect(docB.rows).toEqual([
      { id: '0000-corrupt', from: null, to: null, sent: null, sent_display: '-', status: 'refused', sender_attribution: 'none' },
      { id: 'b-clean', from: 'orchestrator', to: 'worker-b', sent: AT, sent_display: '0s ago', status: 'shown', sender_attribution: 'attributed', body: 'clean mail for worker-b' },
    ]);
    expect(docB.differences).toHaveLength(1);
    expect(statusOf(dirB, 'b-clean', { to: 'worker-b', root: where, session: 'acme' }, messageKey())).toBe('read');
  });

  test('owner sees verified bodies of other mailboxes read-only without publishing receipts, seat sees no other body, and unverifiable record shows no body to anyone', async () => {
    const where = found();
    const idA = 'aaaa1111-1111-4111-8111-111111111111';
    const idB = 'bbbb2222-2222-4222-8222-222222222222';
    const idTampered = 'cccc3333-3333-4333-8333-333333333333';

    plantRecord(home, where, 'acme', 'worker-a', idA, 'VERIFIED_BODY_WORKER_A', { from: 'orchestrator', at: AT });
    plantMessage(home, where, 'worker-b', idB, payload({ id: idB, to: 'worker-b', body: 'VERIFIED_LEGACY_BODY_WORKER_B' }));
    plantRecord(home, where, 'acme', 'worker-a', idTampered, 'TAMPERED_SECRET_BODY', { from: 'orchestrator', at: AT });

    // Tamper with idTampered after signing so signature verification fails
    const tamperedPath = join(recordDir(where, 'acme', 'worker-a'), idTampered);
    writeFileSync(tamperedPath, readFileSync(tamperedPath, 'utf8').replace('TAMPERED_SECRET_BODY', 'TAMPERED_SECRET_BODY_ALTERED'));

    // 1. Owner reads in JSON mode: sees verified bodies for worker-a and worker-b on waiting rows,
    //    sees NO body for the tampered record, and publishes NO receipts.
    const ownerJson = await run(['--json'], OWNER);
    expect(ownerJson.code).toBe(0);
    expect(ownerJson.err).toBe('');
    const ownerDoc = assertMatchesOutputSchema<MessagesDoc>(ownerJson.out, MESSAGES_OUTPUT_SCHEMA);
    expect(ownerDoc.counts).toEqual({ messages: 3, shown: 0, refused: 0, waiting: 3 });
    expect(ownerDoc.differences).toEqual([]);
    expect(ownerDoc.notes).toEqual([
      '3 messages addressed to another mailbox are waiting; they are shown read-only, and no receipts are written for them.',
    ]);
    expect(ownerDoc.rows).toEqual([
      { id: idA, from: 'orchestrator', to: 'worker-a', sent: AT, sent_display: '0s ago', status: 'waiting', sender_attribution: 'attributed', body: 'VERIFIED_BODY_WORKER_A' },
      { id: idTampered, from: null, to: 'worker-a', sent: null, sent_display: '-', status: 'waiting', sender_attribution: 'none' },
      { id: idB, from: 'orchestrator', to: 'worker-b', sent: AT, sent_display: '0s ago', status: 'waiting', sender_attribution: 'attributed', body: 'VERIFIED_LEGACY_BODY_WORKER_B' },
    ]);
    expect(ownerJson.out).not.toContain('TAMPERED_SECRET_BODY');

    // 2. Owner reads in text mode: prints verified waiting bodies under their headings, hides tampered body, writes no receipts
    const ownerText = await run([], OWNER);
    expect(ownerText.code).toBe(0);
    expect(ownerText.out).toContain(`worker-a/${idA}:\nfrom orchestrator (team lead):\n\nVERIFIED_BODY_WORKER_A`);
    expect(ownerText.out).toContain(`worker-b/${idB}:\nfrom orchestrator:\n\nVERIFIED_LEGACY_BODY_WORKER_B`);
    expect(ownerText.out).not.toContain('TAMPERED_SECRET_BODY');
    expect(ownerText.out).toContain(
      'note: 3 messages addressed to another mailbox are waiting; they are shown read-only, and no receipts are written for them.',
    );

    // Neither owner read published any receipt, and worker-a's valid record remains unread in listUnread
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'worker-a'), idA, 'read'))).toBe(false);
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'worker-a'), idTampered, 'read'))).toBe(false);
    expect(existsSync(receiptFile(where, 'worker-b', idB))).toBe(false);
    expect(
      listUnread(recordDir(where, 'acme', 'worker-a'), { to: 'worker-a', root: where, session: 'acme' }, home)
        .map((m) => m.id)
        .sort(),
    ).toEqual([idA, idTampered]);

    // 3. Seat B reads: serves only worker-b's own body, sees NO body for worker-a (neither verified nor tampered)
    const seatBJson = await run(['--json'], WORKER_B);
    expect(seatBJson.code).toBe(0);
    const seatBDoc = assertMatchesOutputSchema<MessagesDoc>(seatBJson.out, MESSAGES_OUTPUT_SCHEMA);
    expect(seatBDoc.counts).toEqual({ messages: 3, shown: 1, refused: 0, waiting: 2 });
    expect(seatBDoc.rows).toEqual([
      { id: idA, from: 'orchestrator', to: 'worker-a', sent: AT, sent_display: '0s ago', status: 'waiting', sender_attribution: 'attributed' },
      { id: idTampered, from: null, to: 'worker-a', sent: null, sent_display: '-', status: 'waiting', sender_attribution: 'none' },
      { id: idB, from: 'orchestrator', to: 'worker-b', sent: AT, sent_display: '0s ago', status: 'shown', sender_attribution: 'attributed', body: 'VERIFIED_LEGACY_BODY_WORKER_B' },
    ]);
    expect(seatBJson.out).not.toContain('VERIFIED_BODY_WORKER_A');
    expect(seatBJson.out).not.toContain('TAMPERED_SECRET_BODY');
    expect(existsSync(receiptFile(where, 'worker-b', idB))).toBe(true);
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'worker-a'), idA, 'read'))).toBe(false);

    // 4. Seat A reads: serves worker-a's valid record (publishing its receipt) and refuses the tampered record with no body
    const seatAJson = await run(['--json'], WORKER_A);
    expect(seatAJson.code).toBe(1);
    const seatADoc = assertMatchesOutputSchema<MessagesDoc>(seatAJson.out, MESSAGES_OUTPUT_SCHEMA);
    expect(seatADoc.counts).toEqual({ messages: 2, shown: 1, refused: 1, waiting: 0 });
    expect(seatADoc.rows).toEqual([
      { id: idA, from: 'orchestrator', to: 'worker-a', sent: AT, sent_display: '0s ago', status: 'shown', sender_attribution: 'attributed', body: 'VERIFIED_BODY_WORKER_A' },
      { id: idTampered, from: 'orchestrator', to: 'worker-a', sent: AT, sent_display: '0s ago', status: 'refused', sender_attribution: 'none' },
    ]);
    expect(seatAJson.out).not.toContain('TAMPERED_SECRET_BODY');
    expect(statusOf(recordDir(where, 'acme', 'worker-a'), idA, { to: 'worker-a', root: where, session: 'acme' }, messageKey())).toBe('read');
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'worker-a'), idTampered, 'read'))).toBe(false);
  });

  test('unplaced, owner-no-tty, agentless pane, watch, and foreign-session callers read nothing and create no key', async () => {
    const where = found();
    plantRecord(home, where, 'acme', 'worker-a', 'a1', 'CONFIDENTIAL_WORKER_A', { from: 'orchestrator', at: AT });
    plantMessage(home, where, 'owner', 'owner-1', payload({ body: 'CONFIDENTIAL_OWNER' }));
    rmSync(messageKeyPath(home), { force: true });

    const refusedCallers: Caller[] = [
      { kind: 'unplaced', reason: 'its parent processes can\'t be read to the top' },
      { kind: 'owner-no-tty' },
      { kind: 'pane', pane: 'pane-agentless', session: 'acme' },
      { kind: 'watch', session: 'acme' },
    ];

    for (const caller of refusedCallers) {
      const jsonRes = await run(['--json'], caller);
      expect(jsonRes.code).toBe(1);
      expect(jsonRes.err).toBe('');
      assertJsonErrorShape(jsonRes.out, {
        id: 'messages.caller',
        messageContains: 'only the owner or a seat of this session reads a mailbox',
      });
      expect(jsonRes.out).not.toContain('CONFIDENTIAL_WORKER_A');
      expect(jsonRes.out).not.toContain('CONFIDENTIAL_OWNER');

      const textRes = await run([], caller);
      expect(textRes.code).toBe(1);
      expect(textRes.out).toBe('');
      expect(textRes.err).toContain('only the owner or a seat of this session reads a mailbox');
      expect(textRes.err).not.toContain('CONFIDENTIAL_WORKER_A');
      expect(textRes.err).not.toContain('CONFIDENTIAL_OWNER');
    }

    // Also verify a caller running under herdr in a foreign session via callerSources
    const foreignIo = testIo(root);
    delete (foreignIo as { caller?: Caller }).caller;
    foreignIo.callerSources = (queriedSession) => ({
      ancestors: () => [
        { pid: 400, name: 'claude' },
        { pid: 300, name: 'zsh' },
        { pid: 200, name: 'herdr' },
      ],
      agents: () =>
        queriedSession === 'acme'
          ? []
          : [{ name: 'worker-a', role: 'implementer', pane: 'pane-foreign', session: 'other-session' } as never],
      paneRootPid: (pane) => (queriedSession !== 'acme' && pane === 'pane-foreign' ? 300 : null),
      env: { HERDR_PANE_ID: 'pane-foreign' },
      stdinIsTTY: false,
    });
    const foreignCode = await runMessages(['--json'], foreignIo, { home, now: () => NOW });
    expect(foreignCode).toBe(1);
    assertJsonErrorShape(foreignIo.out, {
      id: 'messages.caller',
      messageContains: 'only the owner or a seat of this session reads a mailbox',
    });

    expect(existsSync(messageKeyPath(home))).toBe(false);
    expect(existsSync(recordReceiptFile(recordDir(where, 'acme', 'worker-a'), 'a1', 'read'))).toBe(false);
    expect(existsSync(receiptFile(where, 'owner', 'owner-1'))).toBe(false);
  });
});
