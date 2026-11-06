// A lead clears a stopped or retired seat's stale mail: `team ack --seat <s> --older-than <dur>`
// writes a `read_by: lead-ack:<caller>` receipt, and `team archive --seat <s> --older-than <dur>`
// moves the family it cleared. A lead-ack receipt is never the seat's own read — `isRead` and
// `statusOf` do not count it, so no reader reports `delivered (read)` — while the unread listings
// and the watch treat the message as cleared and stop serving or retrying it. Both calls refuse a
// seat that is still running, admit a stopped or retired one, and a name the team never held and
// no folder remembers is still not a seat. The history line the ack writes says who cleared it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runAck, type AckHost } from '../src/commands/ack.ts';
import { runArchive } from '../src/commands/archive.ts';
import { listDrops, runDrops } from '../src/commands/drops.ts';
import type { DownSources } from '../src/commands/down.ts';
import { listUnackedMessages, plantRecord, recordDir, runMessages } from '../src/commands/messages.ts';
import { listUnread, peekMessage, readMessage } from '../src/mcp/inbox.ts';
import { readHistory } from '../src/send/history.ts';
import {
  isRead,
  isReadOrCleared,
  leadAckReceiptAt,
  readVerifiedReceipt,
  receiptFile,
  signReceiptPayload,
  statusOf,
  writeReceipt,
} from '../src/send/record.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const DATE = NOW_ISO.slice(0, 10);
const STALE = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);

const STALE_ID = '11111111-2222-4333-8444-555555555555';
const UNREAD_ID = '22222222-3333-4444-8555-666666666666';
const FRESH_ID = '99999999-8888-4777-8666-555555555555';
const SEAT_READ_ID = '33333333-4444-4555-8666-777777777777';

const LEAD_SEAT = `  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
const WORKER_SEAT = `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
${LEAD_SEAT}${WORKER_SEAT}`;
const STOPPED_TEAM = TEAM.replace(WORKER_SEAT, `${WORKER_SEAT}    stopped: true\n`);
const LEAD_ONLY_TEAM = TEAM.replace(WORKER_SEAT, '');

const OWNER: Caller = { kind: 'owner' };
const LEAD: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-lead-clear-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  place('lead', 'pane-lead');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function teamFile(text: string): void {
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
}

function place(name: string, pane: string): void {
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme ??= { seats: {}, worktrees: {} };
    state.sessions.acme.seats[name] = { stage: 'ready', pane };
  });
}

function sent(seat: string, id: string, body = 'a body for the seat\n\nthe second line'): string {
  return plantRecord(home, root, 'acme', seat, id, body, { at: NOW_ISO, from: 'lead' });
}

function contextOf(seat: string): { to: string; root: string; session: string; lead: string } {
  // The team's resolved lead, as every settle site in the commands supplies it: the checkout's
  // message key is shared by every seat, so a seat-named clearance needs the settle side's word.
  return { to: seat, root, session: 'acme', lead: 'lead' };
}

/** The payload the receipt file at `path` was signed over. */
function receiptPayloadAt(path: string): Record<string, unknown> {
  const envelope = JSON.parse(readFileSync(path, 'utf8')) as { payload?: unknown };
  if (envelope.payload === undefined || typeof envelope.payload !== 'object' || envelope.payload === null) {
    throw new Error(`not a signed receipt: ${path}`);
  }
  return envelope.payload as Record<string, unknown>;
}

/** Every file of one family at one mtime, so the window is the test's and not the runner's. */
function age(seat: string, id: string, at: Date): void {
  const dir = recordDir(root, 'acme', seat);
  for (const name of readdirSync(dir)) {
    if (name === id || name.startsWith(`${id}.`)) utimesSync(join(dir, name), at, at);
  }
}

function archived(seat: string, id: string): string {
  return join(root, '.agents', 'send-drops-archive', DATE, 'acme', seat, id);
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

describe('a lead-ack receipt is how a stopped seat\'s stale mail is cleared', () => {
  test('the scoped ack signs read_by lead-ack:<lead>, and never the seat\'s own read', async () => {
    sent('worker', STALE_ID);
    age('worker', STALE_ID, STALE);

    const acked = await ack(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(acked.code, acked.err).toBe(0);
    expect(acked.out).toContain('1 marked read');

    const path = receiptFile(recordDir(root, 'acme', 'worker'), STALE_ID, 'read');
    expect(existsSync(path)).toBe(true);
    const payload = receiptPayloadAt(path);
    expect(payload.status).toBe('read');
    expect(payload.read_by).toBe('lead-ack:lead');
    expect(payload.id).toBe(STALE_ID);
    expect(payload.to).toBe('worker');

    const key = messageKeyOf(home);
    const context = contextOf('worker');
    const dir = recordDir(root, 'acme', 'worker');
    // The seat itself has still not read it: only a `replied` receipt could make this true.
    expect(isRead(dir, STALE_ID, context, key)).toBe(false);
    expect(statusOf(dir, STALE_ID, context, key)).toBe('sent');
    // The same signed file, read as what it is: a clearance, naming who wrote it.
    const verified = readVerifiedReceipt(path, STALE_ID, 'read', context, key);
    expect(verified?.payload.read_by).toBe('lead-ack:lead');
    const cleared = leadAckReceiptAt(dir, STALE_ID, context, key);
    expect(cleared?.by).toBe('lead');
    expect(cleared?.at).toBe(payload.at as string);
    expect(isReadOrCleared(dir, STALE_ID, context, key)).toBe(true);

    // A second sweep finds nothing due and writes nothing: the name is already held. The receipt
    // just written carries the runner's clock, so the family is re-aged to the test's window and
    // the scan reports the clearance as an already-read record rather than a fresh one.
    age('worker', STALE_ID, STALE);
    const again = await ack(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(again.code, again.err).toBe(0);
    expect(again.out).toContain('0 marked read, 1 already read, 0 not due');
    expect(readdirSync(dir).filter((name) => name.endsWith('.read.json'))).toEqual([`${STALE_ID}.read.json`]);
  });

  test('a cleared message is not waiting mail: no listing, no read, no second serve', async () => {
    sent('worker', STALE_ID);
    sent('worker', UNREAD_ID, 'the unread line\n');
    age('worker', STALE_ID, STALE);
    age('worker', UNREAD_ID, STALE);

    const acked = await ack(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(acked.code, acked.err).toBe(0);
    expect(acked.out).toContain('2 marked read');

    const dir = recordDir(root, 'acme', 'worker');
    const key = messageKeyOf(home);
    const context = contextOf('worker');
    // Nothing in the folder waits: `inbox_check` and `team drops` see no unread drop.
    expect(listUnread(dir, context, home)).toEqual([]);
    const listed = listDrops(dir, key, context);
    expect(listed.kind).toBe('ok');
    if (listed.kind === 'ok') expect(listed.rows.map((row) => row.id)).not.toContain(STALE_ID);
    expect(listUnackedMessages(root, 'acme', home, undefined, 'lead').map((message) => message.id)).not.toContain(STALE_ID);

    // A returning seat that asks for the id by name is told it was already served, and gets no
    // body: a clearance is an at-most-once serving like any other.
    const read = readMessage({ dropDir: dir, root, seat: 'worker', session: 'acme', lead: 'lead' }, STALE_ID, home);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.served).toBe('already-served');
      expect(read.reason).not.toContain('does not verify');
    }

    // The unread listing that does show working mail proves the scene: a fresh record is served.
    sent('worker', FRESH_ID, 'the unread line\n');
    const io = testIo(root, OWNER);
    expect(await runMessages([], io, { home, now: () => NOW })).toBe(0);
    expect(io.out).toContain('the unread line');
    expect(io.out).not.toContain('a body for the seat');
    expect(io.err).not.toContain('a body for the seat');

    // The same clearance stays body-less for drops --read and inbox_read's peek. The watch rings
    // from the unacked list above, which already excludes the cleared id.
    const drops = testIo(root, OWNER);
    expect(await runDrops(['--read', '--seat', 'worker', '--session', 'acme'], drops, { home })).toBe(0);
    expect(`${drops.out}${drops.err}`).not.toContain('a body for the seat');
    const peeked = peekMessage({ dropDir: dir, root, seat: 'worker', session: 'acme', lead: 'lead' }, STALE_ID, home);
    expect(peeked.ok).toBe(false);
    if (!peeked.ok) expect(peeked.reason).not.toContain('a body for the seat');

    // A message the seat itself read is not a lead-ack and still counts as its own read.
    const seatRead = plantRecord(home, root, 'acme', 'worker', SEAT_READ_ID, 'read by the seat\n', { at: NOW_ISO, from: 'lead' });
    expect(seatRead.endsWith(`/${SEAT_READ_ID}`)).toBe(true);
    const receipt = signReceiptPayload({ kind: 'receipt', status: 'read', id: SEAT_READ_ID, to: 'worker', root, session: 'acme', at: NOW_ISO }, home);
    const written = writeReceipt(dir, receipt, home);
    expect(written.ok).toBe(true);
    expect(isRead(dir, SEAT_READ_ID, context, key)).toBe(true);
    expect(leadAckReceiptAt(dir, SEAT_READ_ID, context, key)).toBeNull();
  });

  test('the history line says cleared by the lead, never delivered (read)', async () => {
    sent('worker', STALE_ID);
    age('worker', STALE_ID, STALE);
    const acked = await ack(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(acked.code, acked.err).toBe(0);

    const history = readHistory('acme', root, home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    const mine = history.entries.filter((entry) => entry.id === STALE_ID);
    expect(mine.some((entry) => entry.outcome === 'cleared by lead')).toBe(true);
    expect(mine.every((entry) => entry.outcome !== 'delivered (read)')).toBe(true);
    expect(mine[0]?.to).toBe('worker');
  });

  test('the owner\'s sweep signs the owner\'s clearance, and the history says so', async () => {
    sent('worker', STALE_ID);
    age('worker', STALE_ID, STALE);
    const acked = await ack(['--seat', 'worker', '--older-than', '7d'], OWNER);
    expect(acked.code, acked.err).toBe(0);
    const path = receiptFile(recordDir(root, 'acme', 'worker'), STALE_ID, 'read');
    expect(receiptPayloadAt(path).read_by).toBe('lead-ack:owner');

    const history = readHistory('acme', root, home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.some((entry) => entry.id === STALE_ID && entry.outcome === 'cleared by owner')).toBe(true);
  });

  test('the archive moves a family the lead cleared, receipt and all', async () => {
    sent('worker', STALE_ID);
    age('worker', STALE_ID, STALE);
    expect((await ack(['--seat', 'worker', '--older-than', '7d'], LEAD)).code).toBe(0);
    // The receipt this run wrote carries the runner's mtime; the pinned window is the test's.
    age('worker', STALE_ID, STALE);

    const moved = await archive(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(moved.code, moved.err).toBe(0);
    expect(moved.out).toContain('1 family moved (2 files)');
    const live = recordDir(root, 'acme', 'worker');
    expect(existsSync(join(live, STALE_ID))).toBe(false);
    expect(existsSync(receiptFile(live, STALE_ID, 'read'))).toBe(false);
    expect(existsSync(archived('worker', STALE_ID))).toBe(true);
    const movedReceipt = join(root, '.agents', 'send-drops-archive', DATE, 'acme', 'worker', `${STALE_ID}.read.json`);
    expect(existsSync(movedReceipt)).toBe(true);
    expect(receiptPayloadAt(movedReceipt).read_by).toBe('lead-ack:lead');
  });

  test('a seat that read its own mail already is counted, not signed for', async () => {
    sent('worker', STALE_ID);
    const receipt = signReceiptPayload({ kind: 'receipt', status: 'read', id: STALE_ID, to: 'worker', root, session: 'acme', at: NOW_ISO }, home);
    expect(writeReceipt(recordDir(root, 'acme', 'worker'), receipt, home).ok).toBe(true);
    age('worker', STALE_ID, STALE);

    const acked = await ack(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(acked.code, acked.err).toBe(0);
    expect(acked.out).toContain('0 marked read, 1 already read, 0 not due');
    expect(receiptPayloadAt(receiptFile(recordDir(root, 'acme', 'worker'), STALE_ID, 'read')).read_by).toBeUndefined();

    const moved = await archive(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(moved.code, moved.err).toBe(0);
    expect(moved.out).toContain('1 family moved (2 files)');
  });
});

describe('only a seat that is not running may be cleared', () => {
  test('a running seat is refused by both scoped calls, and nothing is written or moved', async () => {
    place('worker', 'pane-worker');
    sent('worker', STALE_ID);
    age('worker', STALE_ID, STALE);

    const refusedAck = await ack(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(refusedAck.code).toBe(1);
    expect(refusedAck.err).toContain('seat worker is running; stop or retire worker before clearing its messages');
    expect(existsSync(receiptFile(recordDir(root, 'acme', 'worker'), STALE_ID, 'read'))).toBe(false);

    const refusedArchive = await archive(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(refusedArchive.code).toBe(1);
    expect(refusedArchive.err).toContain('seat worker is running; stop or retire worker before moving its messages');
    expect(existsSync(join(recordDir(root, 'acme', 'worker'), STALE_ID))).toBe(true);
  });

  test('a seat the team file stops is admitted even with a state entry left behind', async () => {
    teamFile(STOPPED_TEAM);
    place('worker', 'pane-worker');
    sent('worker', STALE_ID);
    age('worker', STALE_ID, STALE);

    const acked = await ack(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(acked.code, acked.err).toBe(0);
    expect(acked.out).toContain('1 marked read');
    expect(existsSync(receiptFile(recordDir(root, 'acme', 'worker'), STALE_ID, 'read'))).toBe(true);
  });

  test('a retired seat is admitted while its folder is there; a name with no folder is not', async () => {
    sent('worker', STALE_ID);
    age('worker', STALE_ID, STALE);
    teamFile(LEAD_ONLY_TEAM);

    const acked = await ack(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(acked.code, acked.err).toBe(0);
    expect(acked.out).toContain('1 marked read');
    age('worker', STALE_ID, STALE);
    const moved = await archive(['--seat', 'worker', '--older-than', '7d'], LEAD);
    expect(moved.code, moved.err).toBe(0);
    expect(moved.out).toContain('1 family moved (2 files)');

    // The legacy store is the other folder a retired seat may have left behind.
    mkdirSync(join(root, '.agents', 'messages', 'oldseat'), { recursive: true });
    messageKeyOf(home);
    const legacy = await ack(['--seat', 'oldseat', '--older-than', '7d'], LEAD);
    expect(legacy.code, legacy.err).toBe(0);
    expect(legacy.out).toContain('0 marked read, 0 already read, 0 not due');
    expect((await archive(['--seat', 'oldseat', '--older-than', '7d'], LEAD)).code).toBe(0);

    const ghostAck = await ack(['--seat', 'ghost', '--older-than', '7d'], LEAD);
    expect(ghostAck.code).toBe(2);
    expect(ghostAck.err).toContain('"ghost" is not a seat of this team');
    const ghostArchive = await archive(['--seat', 'ghost', '--older-than', '7d'], LEAD);
    expect(ghostArchive.code).toBe(2);
    expect(ghostArchive.err).toContain('"ghost" is not a seat of this team');
  });

  test('the running refusal comes after the caller admission: a seat that is not a lead learns nothing', async () => {
    place('worker', 'pane-worker');
    sent('worker', STALE_ID);
    age('worker', STALE_ID, STALE);
    const worker: Caller = { kind: 'seat', name: 'worker', pane: 'pane-worker', session: 'acme' };
    const refused = await ack(['--seat', 'worker', '--older-than', '7d'], worker);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('only the owner or a seat this team marks `leads`');
    expect(refused.err).not.toContain('is running');
  });
});

describe('a signed clearance must name the actor the team admits', () => {
  test('a receipt naming a seat that is not the lead settles nothing', () => {
    // Every seat signs with the checkout's one message key, so a receipt file alone proves only
    // that a seat of this checkout wrote it. A clearance therefore settles only when its actor is
    // the owner or the lead this settle site resolved, never any seat that can sign the payload.
    teamFile(STOPPED_TEAM);
    sent('worker', STALE_ID);
    const dir = recordDir(root, 'acme', 'worker');
    const receipt = signReceiptPayload({
      kind: 'receipt', status: 'read', id: STALE_ID, to: 'worker', root, session: 'acme',
      at: NOW_ISO, read_by: 'lead-ack:worker',
    }, home);
    expect(writeReceipt(dir, receipt, home).ok).toBe(true);

    const key = messageKeyOf(home);
    const context = contextOf('worker');
    expect(leadAckReceiptAt(dir, STALE_ID, context, key)).toBeNull();
    expect(isReadOrCleared(dir, STALE_ID, context, key)).toBe(false);
    // The forged clearance is not even the seat's own read: `isRead` never counted a lead-ack.
    expect(isRead(dir, STALE_ID, context, key)).toBe(false);
    expect(listUnread(dir, context, home).map((message) => message.id)).toContain(STALE_ID);
    expect(listUnackedMessages(root, 'acme', home, undefined, 'lead').map((message) => message.id)).toContain(STALE_ID);
  });

  test('a receipt naming the lead settles only where the settle side knows the lead', () => {
    teamFile(STOPPED_TEAM);
    sent('worker', STALE_ID);
    const dir = recordDir(root, 'acme', 'worker');
    const receipt = signReceiptPayload({
      kind: 'receipt', status: 'read', id: STALE_ID, to: 'worker', root, session: 'acme',
      at: NOW_ISO, read_by: 'lead-ack:lead',
    }, home);
    expect(writeReceipt(dir, receipt, home).ok).toBe(true);

    const key = messageKeyOf(home);
    expect(leadAckReceiptAt(dir, STALE_ID, contextOf('worker'), key)?.by).toBe('lead');
    // A caller that did not load the team has no word to check the name against: only the
    // owner's clearance settles blind, exactly as a reader with no team configured reads it.
    const blind = { to: 'worker', root, session: 'acme' };
    expect(leadAckReceiptAt(dir, STALE_ID, blind, key)).toBeNull();
    expect(isReadOrCleared(dir, STALE_ID, blind, key)).toBe(false);
    expect(listUnread(dir, blind, home).map((message) => message.id)).toContain(STALE_ID);
  });
});
