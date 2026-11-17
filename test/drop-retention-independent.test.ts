// An acknowledgement (a reply's receipt), and a read one older than two days, moves with
// its receipts into send-drops/<session>/<seat>/archive/<YYYY-MM>/ and is never deleted. An
// ordinary read under two days is not an acknowledgement and stays, and so does an unread
// message. The one-time
// migration lists, with --dry-run, what it would move and which unread drops it would mark
// read — those delivered before the seat's channel start — and writes nothing. Without the
// flag it moves them and writes one audit line. Homes and pane names are synthetic.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runAck } from '../src/commands/ack.ts';
import { runDrops } from '../src/commands/drops.ts';
import { recordDir } from '../src/commands/messages.ts';
import { recordHits, runReply } from '../src/commands/reply.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { peekMessage, writeListener } from '../src/mcp/inbox.ts';
import { runInboxRetention } from '../src/send/inbox-retention.ts';
import {
  receiptFile,
  RECORD_KIND,
  signReceiptPayload,
  signRecord,
  statusOf,
  writeReceipt,
  writeRecord,
  type RecordPayload,
} from '../src/send/record.ts';
import { emptySession, LOG_FILE, updateState } from '../src/state.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { testIo } from './helpers.ts';
import { world, type World } from './send-native-fixtures.ts';

const RUN = new Date('2026-11-08T15:00:00.000Z');
const CHANNEL_START = '2026-11-08T12:00:00.000Z';
const SEAT = 'lead';
const SESSION = 'acme';
const PANE = 'pane-lead';
const ACKED = 'a11ce000-0000-4000-8000-0000000000a1';
const OLD_READ = '01d0e000-0000-4000-8000-0000000000b1';
const YOUNG_READ = '7a0e0000-0000-4000-8000-0000000000c1';
const UNREAD_AFTER = '0a0e0000-0000-4000-8000-0000000000d1';
const UNREAD_BEFORE = 'bef0e000-0000-4000-8000-0000000000e1';
const SENT_ONLY = '5e110000-0000-4000-8000-0000000000e2';

const owned: string[] = [];
afterEach(() => {
  const paths = owned.splice(0);
  discardFixtures(paths, { roots: paths.map((path) => dirname(path)) });
});

function keep(made: World): World {
  owned.push(dirname(made.root));
  return made;
}

function open(): World {
  const made = keep(world(null));
  chmodSync(lobbyDir(made.home), 0o700);
  return made;
}

function drop(made: World): string {
  return recordDir(made.root, SESSION, SEAT);
}

/** `read` is an ordinary read: no `read_by`, and not an acknowledgement. `channel` names the
 *  channel. `replied` is the acknowledgement a reply leaves. `delivered` is proof the drop
 *  was handed over, and it is not itself a read. */
function plant(made: World, id: string, at: string, receipt?: 'read' | 'channel' | 'replied' | 'delivered', from = 'owner'): Buffer {
  const payload: RecordPayload = {
    kind: RECORD_KIND,
    id,
    to: SEAT,
    to_id: null,
    root: made.root,
    session: SESSION,
    at,
    body: `from the owner\n\n${id}\n`,
    from,
    from_id: null,
    rule: 'the owner',
    thread: id,
  };
  const dir = drop(made);
  const written = writeRecord(dir, signRecord(payload, made.home));
  if (!written.ok) throw new Error(written.reason);
  if (receipt !== undefined) {
    const status = receipt === 'replied' || receipt === 'delivered' ? receipt : 'read';
    const signed = signReceiptPayload({
      kind: 'receipt',
      status,
      id,
      to: SEAT,
      root: made.root,
      session: SESSION,
      at,
      ...(receipt === 'channel' ? { read_by: 'channel' } : {}),
    }, made.home);
    const kept = writeReceipt(dir, signed, made.home);
    if (!kept.ok) throw new Error(kept.reason);
  }
  return readFileSync(join(dir, id));
}

function listen(made: World): void {
  const dir = drop(made);
  mkdirSync(dir, { recursive: true });
  const wrote = writeListener(dir, {
    v: 1,
    seat: SEAT,
    session: SESSION,
    root: made.root,
    cli: 'claude-code',
    pid: 4242,
    ts: CHANNEL_START,
    channel: true,
  });
  if (!wrote) throw new Error('the channel start was not written');
}

function scene(): World {
  const made = open();
  plant(made, ACKED, '2026-11-08T10:00:00.000Z', 'replied', 'helper');
  plant(made, OLD_READ, '2026-10-01T00:00:00.000Z', 'channel');
  plant(made, YOUNG_READ, '2026-11-07T00:00:00.000Z', 'channel');
  plant(made, UNREAD_AFTER, '2026-11-08T13:00:00.000Z');
  plant(made, UNREAD_BEFORE, '2026-11-08T11:00:00.000Z', 'delivered');
  plant(made, SENT_ONLY, '2026-11-08T11:30:00.000Z');
  listen(made);
  return made;
}

function archived(made: World, id: string, at: string): string {
  return join(drop(made), 'archive', at.slice(0, 7), id);
}

function place(made: World): void {
  updateState(made.dir, (state) => {
    const session = state.sessions.acme ?? (state.sessions.acme = emptySession());
    session.seats.lead = { stage: 'ready', pane: PANE };
  });
}

test('a dry run lists the move and the reads it would mark, and writes nothing', () => {
  const made = scene();
  const dir = drop(made);
  const before = readdirSync(dir).sort();
  const bytes = readFileSync(join(dir, ACKED));
  const report = runInboxRetention(made.root, { now: RUN, home: made.home, dryRun: true });
  expect(report.move.slice().sort()).toEqual([ACKED, OLD_READ].sort());
  expect(report.markRead).toEqual([UNREAD_BEFORE]);
  expect(report.markRead).not.toContain(SENT_ONLY);
  expect(readdirSync(dir).sort()).toEqual(before);
  expect(readFileSync(join(dir, ACKED))).toEqual(bytes);
  expect(existsSync(join(dir, 'archive'))).toBe(false);
  expect(existsSync(receiptFile(dir, UNREAD_BEFORE, 'read'))).toBe(false);
  expect(existsSync(receiptFile(dir, UNREAD_BEFORE, 'delivered'))).toBe(true);
  expect(existsSync(receiptFile(dir, SENT_ONLY, 'read'))).toBe(false);
  expect(existsSync(receiptFile(dir, SENT_ONLY, 'delivered'))).toBe(false);
  expect(existsSync(join(made.dir, LOG_FILE))).toBe(false);
});

test('an acknowledged message and a read one older than two days move with their receipts', async () => {
  const made = scene();
  const dir = drop(made);
  const ackedBytes = readFileSync(join(dir, ACKED));
  const oldBytes = readFileSync(join(dir, OLD_READ));
  const youngBytes = readFileSync(join(dir, YOUNG_READ));
  const report = runInboxRetention(made.root, { now: RUN, home: made.home });
  expect(report.move.slice().sort()).toEqual([ACKED, OLD_READ].sort());
  expect(report.markRead).toEqual([UNREAD_BEFORE]);
  expect(report.markRead).not.toContain(SENT_ONLY);

  const ackedAt = archived(made, ACKED, '2026-11-08T10:00:00.000Z');
  const oldAt = archived(made, OLD_READ, '2026-10-01T00:00:00.000Z');
  expect(readFileSync(ackedAt)).toEqual(ackedBytes);
  expect(readFileSync(oldAt)).toEqual(oldBytes);
  expect(existsSync(receiptFile(dirname(ackedAt), ACKED, 'replied'))).toBe(true);
  expect(existsSync(receiptFile(dirname(oldAt), OLD_READ, 'read'))).toBe(true);
  expect(existsSync(join(dir, ACKED))).toBe(false);
  expect(existsSync(join(dir, OLD_READ))).toBe(false);

  expect(existsSync(join(dir, YOUNG_READ))).toBe(true);
  expect(readFileSync(join(dir, YOUNG_READ))).toEqual(youngBytes);
  expect(existsSync(archived(made, YOUNG_READ, '2026-11-07T00:00:00.000Z'))).toBe(false);
  expect(existsSync(join(dir, UNREAD_AFTER))).toBe(true);
  expect(existsSync(receiptFile(dir, UNREAD_AFTER, 'read'))).toBe(false);
  expect(existsSync(join(dir, UNREAD_BEFORE))).toBe(true);
  expect(existsSync(receiptFile(dir, UNREAD_BEFORE, 'delivered'))).toBe(true);
  expect(existsSync(receiptFile(dir, UNREAD_BEFORE, 'read'))).toBe(true);
  expect(existsSync(join(dir, SENT_ONLY))).toBe(true);
  expect(existsSync(receiptFile(dir, SENT_ONLY, 'read'))).toBe(false);
  expect(existsSync(archived(made, UNREAD_BEFORE, '2026-11-08T11:00:00.000Z'))).toBe(false);

  const log = readFileSync(join(made.dir, LOG_FILE), 'utf8').trim().split('\n');
  expect(log).toHaveLength(1);
  expect(log[0]).toContain(ACKED);
  expect(log[0]).toContain(OLD_READ);

  const key = messageKeyState(made.home);
  if (key.kind !== 'key') throw new Error('the fixture has no message key');
  const context = { to: SEAT, root: made.root, session: SESSION };
  expect(statusOf(dirname(ackedAt), ACKED, context, key.key)).toBe('replied');
  expect(statusOf(dirname(oldAt), OLD_READ, context, key.key)).toBe('read');
  expect(statusOf(dir, YOUNG_READ, context, key.key)).toBe('read');
  expect(statusOf(dir, UNREAD_AFTER, context, key.key)).toBe('sent');
  expect(statusOf(dir, UNREAD_BEFORE, context, key.key)).toBe('read');
  expect(statusOf(dir, SENT_ONLY, context, key.key)).toBe('sent');
  expect(recordHits(made.root, SESSION, ACKED)).toEqual([{ seat: SEAT, path: ackedAt }]);

  place(made);
  const caller = { kind: 'seat' as const, name: SEAT, pane: PANE, session: SESSION };
  const drops = testIo(made.root, caller);
  expect(await runDrops(['--read', '--seat', SEAT, '--session', SESSION, '--id', ACKED], drops, { home: made.home }), drops.err + drops.out).toBe(0);
  expect(drops.err + drops.out).toContain(`${ACKED}: already read`);
  const ack = testIo(made.root, caller);
  expect(await runAck([ACKED], ack, { home: made.home, now: () => RUN }), ack.err + ack.out).toBe(0);
  expect(ack.err + ack.out).toContain(`${ACKED}: read`);
  expect(ack.err + ack.out).not.toContain('another seat\'s folder');
  const reply = testIo(made.root, caller);
  expect(await runReply([ACKED, 'the answer stays with the record'], reply, { home: made.home, now: () => RUN }), reply.err + reply.out).toBe(0);
  expect(reply.err + reply.out).toContain('team acme, session "acme"');
  expect(reply.err + reply.out).not.toContain('another seat\'s folder');
  expect(reply.err + reply.out).not.toContain('nothing was written');
  const peeked = peekMessage(
    { dropDir: dir, root: made.root, seat: SEAT, session: SESSION, lead: SEAT },
    ACKED,
    made.home,
    [SEAT],
  );
  const shown = peeked.ok ? peeked.body : peeked.reason;
  expect(shown).toContain(ACKED);
  expect(shown).not.toContain('no message');
});

test('a folder of a thousand files keeps every file that is not due', () => {
  // Far above the 256-file pass limit: what a large folder proves, this size proves.
  const made = open();
  const dir = drop(made);
  const ackedBytes = plant(made, ACKED, '2026-11-08T10:00:00.000Z', 'replied', 'helper');
  listen(made);
  const bulk: string[] = [];
  for (let n = 0; n < 1_000; n += 1) {
    const name = `bulk-${String(n).padStart(5, '0')}`;
    bulk.push(name);
    writeFileSync(join(dir, name), 'x');
  }
  const report = runInboxRetention(made.root, { now: RUN, home: made.home });
  expect(report.move).toEqual([ACKED]);
  expect(report.markRead).toEqual([]);
  for (const name of bulk) expect(existsSync(join(dir, name))).toBe(true);
  expect(existsSync(join(dir, ACKED))).toBe(false);
  expect(readFileSync(archived(made, ACKED, '2026-11-08T10:00:00.000Z')).toString('hex')).toBe(ackedBytes.toString('hex'));
});

const PLAIN_READ = '7ead0000-0000-4000-8000-0000000000f1';

test('a read under two days that was not acknowledged stays in the live folder', () => {
  const made = open();
  const at = '2026-11-07T00:00:00.000Z';
  const bytes = plant(made, PLAIN_READ, at, 'read');
  listen(made);
  const report = runInboxRetention(made.root, { now: RUN, home: made.home });
  expect(report.move).not.toContain(PLAIN_READ);
  expect(report.markRead).not.toContain(PLAIN_READ);
  expect(readFileSync(join(drop(made), PLAIN_READ)).toString('hex')).toBe(bytes.toString('hex'));
  expect(existsSync(receiptFile(drop(made), PLAIN_READ, 'read'))).toBe(true);
  expect(existsSync(archived(made, PLAIN_READ, at))).toBe(false);
  const key = messageKeyState(made.home);
  if (key.kind !== 'key') throw new Error('the fixture has no message key');
  expect(statusOf(drop(made), PLAIN_READ, { to: SEAT, root: made.root, session: SESSION }, key.key)).toBe('read');
});

const THREE_DAY_READ = '7ead0000-0000-4000-8000-0000000000f2';

test('a read two days old or more moves, though under seven: the live folder keeps two days of reads', () => {
  const made = open();
  const at = '2026-11-05T12:00:00.000Z';
  plant(made, THREE_DAY_READ, at, 'read');
  listen(made);
  const report = runInboxRetention(made.root, { now: RUN, home: made.home });
  expect(report.move).toContain(THREE_DAY_READ);
  expect(existsSync(join(drop(made), THREE_DAY_READ))).toBe(false);
  expect(existsSync(archived(made, THREE_DAY_READ, at))).toBe(true);
  // Still found, and still read, where it moved.
  const key = messageKeyState(made.home);
  if (key.kind !== 'key') throw new Error('the fixture has no message key');
  expect(statusOf(dirname(archived(made, THREE_DAY_READ, at)), THREE_DAY_READ, { to: SEAT, root: made.root, session: SESSION }, key.key)).toBe('read');
});

test('an interrupted move, the receipt linked into the archive and still live, is completed', () => {
  const made = open();
  const at = '2026-11-08T10:00:00.000Z';
  const bytes = plant(made, ACKED, at, 'replied', 'helper');
  const dir = drop(made);
  const receiptName = `${ACKED}.replied.json`;
  const liveReceipt = join(dir, receiptName);
  const destDir = join(dir, 'archive', at.slice(0, 7));
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const archivedReceipt = join(destDir, receiptName);
  linkSync(liveReceipt, archivedReceipt);
  const receiptBytes = readFileSync(liveReceipt);
  expect(statSync(liveReceipt).ino).toBe(statSync(archivedReceipt).ino);
  expect(existsSync(join(destDir, ACKED))).toBe(false);
  const report = runInboxRetention(made.root, { now: RUN, home: made.home });
  expect(report.move).toContain(ACKED);
  expect(readFileSync(join(destDir, ACKED)).toString('hex')).toBe(bytes.toString('hex'));
  expect(readFileSync(archivedReceipt)).toEqual(receiptBytes);
  expect(existsSync(join(dir, ACKED))).toBe(false);
  expect(existsSync(liveReceipt)).toBe(false);
});

test('a file already in the archive is not overwritten', () => {
  const made = open();
  const at = '2026-11-08T10:00:00.000Z';
  plant(made, ACKED, at, 'replied', 'helper');
  const dest = archived(made, ACKED, at);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  writeFileSync(dest, 'kept\n');
  const report = runInboxRetention(made.root, { now: RUN, home: made.home });
  expect(readFileSync(dest, 'utf8')).toBe('kept\n');
  expect(existsSync(join(drop(made), ACKED))).toBe(true);
  expect(report.move).not.toContain(ACKED);
});
