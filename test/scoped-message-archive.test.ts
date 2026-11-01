// `team ack --seat <s> --older-than <dur>` and `team archive --seat <s> --older-than <dur>`: the
// two scoped calls a lead makes for a stopped seat. The ack writes the seat's signed read receipt
// for every due record; the archive moves only the families whose read receipt verifies and whose
// newest file is older than the window, and nothing else — the general brief, a fresh record, an
// unread record and a delivered-only family all stay. The plain-text drops an earlier build wrote
// are moved with the rest but never served, never acknowledged and never given a receipt. Both
// calls refuse a seat that is not the owner's or a lead's, and a dry run writes nothing at all.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runAck, type AckHost } from '../src/commands/ack.ts';
import { runArchive } from '../src/commands/archive.ts';
import type { DownSources } from '../src/commands/down.ts';
import { listUnackedMessages, plantMessage, plantRecord, recordDir, runMessages } from '../src/commands/messages.ts';
import { GENERAL_BRIEF_FROM, GENERAL_BRIEF_RULE } from '../src/launch/general-brief.ts';
import { receiptFile, signReceiptPayload, writeReceipt } from '../src/send/record.ts';
import { messageKeyOf, signDomain, RECEIPT_DOMAIN, type Json } from '../src/store/keys.ts';
import { updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const DATE = NOW_ISO.slice(0, 10);
const STALE = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);

const STALE_ID = '11111111-2222-4333-8444-555555555555';
const BRIEF_ID = '22222222-3333-4444-8555-666666666666';
const FRESH_READ_ID = '33333333-4444-4555-8666-777777777777';
const FRESH_UNREAD_ID = '44444444-5555-4666-8777-888888888888';
const DRY_ID = '55555555-6666-4777-8888-999999999999';
const BODY_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const LEGACY_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

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

const OWNER: Caller = { kind: 'owner' };
const LEAD: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
const WORKER: Caller = { kind: 'seat', name: 'worker', pane: 'pane-worker', session: 'acme' };

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-scoped-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  place('lead', 'pane-lead');
  place('worker', 'pane-worker');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function place(name: string, pane: string): void {
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme ??= { seats: {}, worktrees: {} };
    state.sessions.acme.seats[name] = { stage: 'ready', pane };
  });
}

function sent(seat: string, id: string, fields: Parameters<typeof plantRecord>[6] = {}): string {
  return plantRecord(home, root, 'acme', seat, id, 'a body for the seat\n\nthe second line', { at: NOW_ISO, from: 'lead', ...fields });
}

/** The signed read receipt `team ack` writes, at the pinned clock. */
function acknowledge(seat: string, id: string): void {
  const receipt = signReceiptPayload({ kind: 'receipt', status: 'read', id, to: seat, root, session: 'acme', at: NOW_ISO }, home);
  const written = writeReceipt(recordDir(root, 'acme', seat), receipt, home);
  if (!written.ok) throw new Error(written.reason);
}

/** Every file of one family at one mtime, so the window is the test's and not the runner's. */
function age(seat: string, id: string, at: Date): void {
  const dir = recordDir(root, 'acme', seat);
  for (const name of readdirSync(dir)) {
    if (name === id || name.startsWith(`${id}.`)) utimesSync(join(dir, name), at, at);
  }
}

function live(seat: string, id: string): string {
  return join(recordDir(root, 'acme', seat), id);
}

function archived(seat: string, id: string): string {
  return join(root, '.agents', 'send-drops-archive', DATE, 'acme', seat, id);
}

function manifestFolder(): string {
  return join(root, '.agents', 'archive-manifests', DATE);
}

async function ack(argv: string[], caller: Caller = OWNER): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
  const code = await runAck(argv, io, { home, now: () => NOW } satisfies AckHost);
  return { code, out: io.out, err: io.err };
}

function sources(): DownSources {
  return {
    sessionRunning: () => false,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => [],
    now: () => NOW,
    sleep: async () => {},
    home,
    launch: {
      typeText: () => true,
      sendKey: () => true,
      pressEnter: () => true,
      agentPanes: () => [],
      closeWorkspace: () => true,
      stopSession: () => true,
      deleteSession: () => true,
      kill: () => true,
      sleep: async () => {},
      now: () => NOW,
    },
  };
}

async function archive(argv: string[], caller: Caller = OWNER): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
  const code = await runArchive(argv, io, sources());
  return { code, out: io.out, err: io.err };
}

describe('a stopped seat\'s stale record is acknowledged, then archived', () => {
  test('the lead ack writes the read receipt, and the archive moves the whole family with its manifest', async () => {
    sent('worker', STALE_ID);
    age('worker', STALE_ID, STALE);

    // The seat itself is not a lead: neither call runs for it, and nothing moves or is written.
    const refusedAck = await ack(['--seat', 'worker', '--older-than', '7d'], WORKER);
    expect(refusedAck.code).toBe(1);
    expect(refusedAck.err).toContain('only the owner or a seat this team marks `leads`');
    expect(existsSync(receiptFile(recordDir(root, 'acme', 'worker'), STALE_ID, 'read'))).toBe(false);
    expect(existsSync(live('worker', STALE_ID))).toBe(true);

    const acked = await ack(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(acked.code, acked.err).toBe(0);
    expect(acked.out).toContain('1 marked read');
    expect(existsSync(receiptFile(recordDir(root, 'acme', 'worker'), STALE_ID, 'read'))).toBe(true);
    // The receipt just written carries the runner's clock; the pinned window is the test's.
    age('worker', STALE_ID, STALE);

    const moved = await archive(['--seat', 'worker', '--older-than', '7d'], OWNER);
    expect(moved.code, moved.err).toBe(0);
    expect(moved.out).toContain('1 family moved (2 files)');
    expect(moved.out).toContain('manifest: .agents/archive-manifests/');
    // The record and the receipt that proves it was read left together, live and in the archive.
    expect(existsSync(live('worker', STALE_ID))).toBe(false);
    expect(existsSync(receiptFile(recordDir(root, 'acme', 'worker'), STALE_ID, 'read'))).toBe(false);
    expect(existsSync(archived('worker', STALE_ID))).toBe(true);
    expect(existsSync(join(root, '.agents', 'send-drops-archive', DATE, 'acme', 'worker', `${STALE_ID}.read.json`))).toBe(true);

    const manifests = readdirSync(manifestFolder());
    expect(manifests).toHaveLength(1);
    const rows = readFileSync(join(manifestFolder(), manifests[0] as string), 'utf8').trim().split('\n');
    expect(rows[0]?.startsWith('#')).toBe(true);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain(`.agents/send-drops/acme/worker/${STALE_ID}`);
    expect(rows[2]).toContain(`${STALE_ID}.read.json`);
  });

  test('the general brief stays, even with a read receipt that verifies', async () => {
    sent('worker', BRIEF_ID, { from: GENERAL_BRIEF_FROM, rule: GENERAL_BRIEF_RULE });
    acknowledge('worker', BRIEF_ID);
    age('worker', BRIEF_ID, STALE);

    const acked = await ack(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(acked.code, acked.err).toBe(0);
    expect(acked.out).toContain('0 marked read');
    // The brief's own receipt is its reader's, and the scoped ack wrote nothing beside it.
    expect(readdirSync(recordDir(root, 'acme', 'worker')).filter((name) => name.endsWith('.read.json'))).toEqual([`${BRIEF_ID}.read.json`]);

    const moved = await archive(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(moved.code, moved.err).toBe(0);
    expect(moved.out).toContain('nothing to move');
    expect(existsSync(live('worker', BRIEF_ID))).toBe(true);
    expect(existsSync(archived('worker', BRIEF_ID))).toBe(false);
  });

  test('a record newer than the window stays, read or unread', async () => {
    sent('worker', FRESH_READ_ID);
    acknowledge('worker', FRESH_READ_ID);
    age('worker', FRESH_READ_ID, NOW);
    sent('worker', FRESH_UNREAD_ID);
    age('worker', FRESH_UNREAD_ID, NOW);

    const acked = await ack(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(acked.code, acked.err).toBe(0);
    expect(acked.out).toContain('0 marked read');
    expect(existsSync(receiptFile(recordDir(root, 'acme', 'worker'), FRESH_UNREAD_ID, 'read'))).toBe(false);

    const moved = await archive(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(moved.code, moved.err).toBe(0);
    expect(moved.out).toContain('nothing to move');
    expect(moved.out).toContain('stay too-recent: 2');
    expect(existsSync(live('worker', FRESH_READ_ID))).toBe(true);
    expect(existsSync(live('worker', FRESH_UNREAD_ID))).toBe(true);
  });

  test('a dry run writes nothing, in either call', async () => {
    sent('worker', DRY_ID);
    age('worker', DRY_ID, STALE);

    const dryAck = await ack(['--seat', 'worker', '--older-than', '7d', '--dry-run'], LEAD);
    expect(dryAck.code, dryAck.err).toBe(0);
    expect(dryAck.out).toContain('would mark 1 read');
    expect(existsSync(receiptFile(recordDir(root, 'acme', 'worker'), DRY_ID, 'read'))).toBe(false);

    // An unread family is not a candidate: the dry archive plans nothing and writes nothing.
    const dryArchive = await archive(['--seat', 'worker', '--older-than', '7d', '--dry-run'], LEAD);
    expect(dryArchive.code, dryArchive.err).toBe(0);
    expect(dryArchive.out).toContain('nothing to move');
    expect(dryArchive.out).toContain('stay unread: 1');
    expect(existsSync(join(root, '.agents', 'send-drops-archive'))).toBe(false);
    expect(existsSync(manifestFolder())).toBe(false);
    expect(existsSync(live('worker', DRY_ID))).toBe(true);

    // The real ack, then a second dry run: the family is acknowledged and the dry run still plans
    // the same move without writing any of it.
    expect((await ack(['--seat', 'worker', '--older-than', '7d'], LEAD)).code).toBe(0);
    age('worker', DRY_ID, STALE);
    const again = await archive(['--seat', 'worker', '--older-than', '7d', '--dry-run'], LEAD);
    expect(again.code, again.err).toBe(0);
    expect(again.out).toContain('would move 1 family (2 files)');
    expect(existsSync(join(root, '.agents', 'send-drops-archive'))).toBe(false);
    expect(existsSync(manifestFolder())).toBe(false);
  });

  test('a plain-text drop is archived but never served, acked or given a receipt', async () => {
    const body = 'an earlier build\'s message body\n';
    const dir = recordDir(root, 'acme', 'worker');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, BODY_ID), body);
    utimesSync(join(dir, BODY_ID), STALE, STALE);

    // The inbox neither shows nor refuses it, and the unread list does not wait on it.
    const io = testIo(root, OWNER);
    expect(await runMessages([], io, { home, now: () => NOW })).toBe(0);
    expect(io.out).not.toContain('an earlier build');
    expect(listUnackedMessages(root, 'acme', home).map((message) => message.id)).not.toContain(BODY_ID);

    // A team that has carried messages has a message key; the body still needs none of it.
    messageKeyOf(home);
    const acked = await ack(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(acked.code, acked.err).toBe(0);
    expect(existsSync(join(dir, `${BODY_ID}.read.json`))).toBe(false);

    const moved = await archive(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(moved.code, moved.err).toBe(0);
    expect(existsSync(join(dir, BODY_ID))).toBe(false);
    expect(existsSync(archived('worker', BODY_ID))).toBe(true);
    expect(readFileSync(archived('worker', BODY_ID), 'utf8')).toBe(body);
  });

  test('the owner is admitted where the seat is not', async () => {
    sent('worker', STALE_ID);
    age('worker', STALE_ID, STALE);
    const owner = await ack(['--seat', 'worker', '--older-than', '7d'], OWNER);
    expect(owner.code, owner.err).toBe(0);
    expect(owner.out).toContain('1 marked read');
    age('worker', STALE_ID, STALE);
    expect((await archive(['--seat', 'worker', '--older-than', '7d'], WORKER)).code).toBe(1);
    expect(existsSync(live('worker', STALE_ID))).toBe(true);
    expect((await archive(['--seat', 'worker', '--older-than', '7d'], OWNER)).code).toBe(0);
    expect(existsSync(live('worker', STALE_ID))).toBe(false);
  });

  test('a scoped call needs both options, a known duration and no stop flags', async () => {
    for (const argv of [
      ['--seat', 'worker'],
      ['--older-than', '7d'],
      ['--seat', 'worker', '--older-than', 'soon'],
      ['--seat', 'worker', '--older-than', '7d', 'extra'],
    ]) expect((await ack(argv)).code).toBe(2);
    for (const argv of [
      ['--seat', 'worker'],
      ['--older-than', '7d'],
      ['--seat', 'worker', '--older-than', '7d', 'extra'],
      ['--seat', 'worker', '--older-than', '7d', '--out', 'elsewhere'],
      ['--seat', 'worker', '--older-than', '7d', '--keep-running'],
      ['--seat', 'worker', '--older-than', '7d', '--wait'],
      ['--seat', 'worker', '--older-than', '7d', '--abandon'],
      ['--seat', 'worker', '--older-than', '7d', '--session', 'other'],
    ]) expect((await archive(argv)).code).toBe(2);
  });
});

describe('the legacy store moves the same way', () => {
  test('an acknowledged legacy record and its receipt move together; an unread one stays', async () => {
    const legacyDir = join(root, '.agents', 'messages', 'worker');
    plantMessage(home, root, 'worker', LEGACY_ID, {
      kind: 'message',
      id: LEGACY_ID,
      to: 'worker',
      root,
      session: 'acme',
      at: NOW_ISO,
      body: 'the older store\'s message\n',
      from: 'lead',
    });
    const receipt = { kind: 'receipt', id: LEGACY_ID, to: 'worker', root, session: 'acme', at: NOW_ISO };
    writeFileSync(
      join(legacyDir, `${LEGACY_ID}.read.json`),
      `${JSON.stringify({ payload: receipt, signature: signDomain(RECEIPT_DOMAIN, receipt as unknown as Json, messageKeyOf(home)) }, null, 2)}\n`,
    );
    for (const name of readdirSync(legacyDir)) utimesSync(join(legacyDir, name), STALE, STALE);

    const unreadId = '88888888-9999-4aaa-8bbb-cccccccccccc';
    plantMessage(home, root, 'worker', unreadId, {
      kind: 'message',
      id: unreadId,
      to: 'worker',
      root,
      session: 'acme',
      at: NOW_ISO,
      body: 'still waiting\n',
      from: 'lead',
    });
    utimesSync(join(legacyDir, `${unreadId}.json`), STALE, STALE);

    const moved = await archive(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(moved.code, moved.err).toBe(0);
    expect(moved.out).toContain('1 family moved (2 files)');
    expect(moved.out).toContain('stay unread: 1');
    const dest = join(root, '.agents', 'messages-archive', DATE, 'worker');
    expect(existsSync(join(dest, `${LEGACY_ID}.json`))).toBe(true);
    expect(existsSync(join(dest, `${LEGACY_ID}.read.json`))).toBe(true);
    expect(existsSync(join(legacyDir, `${LEGACY_ID}.json`))).toBe(false);
    expect(existsSync(join(legacyDir, `${unreadId}.json`))).toBe(true);
  });
});
