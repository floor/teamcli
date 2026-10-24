// The socket leg's read receipt, and the frame header an accepted delivery carries.
//
// A taken socket frame is a delivery, and a delivery is not a read: the signed `<id>.read.json`
// receipt is what proves one. On acceptance the receipt is written at once, with
// `read_by: "socket delivery"`, so the record leaves the unread list — no typed wake, no ring,
// no report drop, and `team drops --read` serves nothing. A frame the box held proves nothing:
// no receipt, and the watch's one retry still comes after the normal window.
//
// The accepted frame opens with `Message from <name> (<seat>@<team>)`, the sender's nickname
// (its seat name when none stands) resolved from the signed record. It is display only: the
// signed record keeps its own `from … — admitted by: …` line, and the typed-wake line is
// unchanged.
// No live session, socket or owner home: the host's deliver is a fake, and the pane is a string.
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { listUnacked } from '../../src/commands/messages.ts';
import { runDrops } from '../../src/commands/drops.ts';
import { runSend } from '../../src/commands/send.ts';
import { readTriggerLine } from '../../src/send/native.ts';
import { reportedPath, reportUnreadDrops, wakePath, wakeUnreadDrops } from '../../src/watch/unread.ts';
import { testIo } from '../helpers.ts';
import {
  acceptSocket,
  book,
  declareEntity,
  dropsOf,
  frameOf,
  HELD_SCREEN,
  helperIo,
  hostOf,
  NOW,
  readReceipt,
  receiptVerifies,
  recordIds,
  recordOf,
  registerHelper,
  sceneOf,
  statusAt,
  unreadAt,
  world,
  type World,
} from './fixtures.ts';

/** The watch's normal unread window: its one retry lands after this many seconds. */
const N = 600;

let made: World | null = null;
afterEach(() => {
  made?.cleanup();
  made = null;
});

function ownerIo(root: string) {
  return testIo(root, { kind: 'owner' });
}

test('an accepted socket frame writes the signed read receipt, read_by socket delivery', async () => {
  const one = world(['socket']);
  made = one;
  declareEntity(one);
  acceptSocket(one);
  const host = hostOf(one, book());
  const drops = dropsOf(one);

  const code = await runSend(['lead', 'the socket note'], ownerIo(one.root), host);

  expect(code).toBe(0);
  expect(host.frames.length).toBe(1);
  const record = recordOf(drops);
  const receipt = readReceipt(drops, record.id);
  expect(receipt).not.toBeNull();
  if (receipt === null) return;
  // The receiver's folder holds a 0600 receipt beside the record, signing the read it claims.
  expect(receipt.mode).toBe(0o600);
  expect(receipt.payload).toMatchObject({
    kind: 'receipt',
    status: 'read',
    id: record.id,
    to: 'lead',
    root: one.root,
    session: 'acme',
    read_by: 'socket delivery',
  });
  expect(typeof receipt.payload.at).toBe('string');
  expect(Number.isFinite(Date.parse(receipt.payload.at as string))).toBe(true);
  expect(receiptVerifies(drops, record.id, one.home)).toBe(true);
  // The record's own receipts derive `read`; the reader's unread list is empty.
  expect(statusAt(one, 'lead', record.id)).toBe('read');
  expect(unreadAt(one)).toEqual([]);
});

test('an accepted socket delivery is not served again, typed at, rung for, or reported', async () => {
  const one = world(['socket']);
  made = one;
  declareEntity(one);
  acceptSocket(one);
  const host = hostOf(one, book());
  const drops = dropsOf(one);
  expect(await runSend(['lead', 'the socket note'], ownerIo(one.root), host)).toBe(0);
  const record = recordOf(drops);

  // The watch's ring reads `listUnacked`: the record's verifying receipt keeps it out.
  expect(listUnacked(one.root, 'acme', one.home)).toEqual([]);

  // The seat's own read serves nothing: a verifying receipt is not served twice.
  const readIo = testIo(one.root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });
  const read = await runDrops(['--read', '--seat', 'lead', '--session', 'acme'], readIo, { home: one.home });
  expect(read).toBe(0);
  expect(readIo.out).not.toContain('the socket note');
  expect(readIo.err).toBe('');

  // Past the window the unread pass types no wake, and past twice it reports nothing.
  const wakeBook = book();
  await wakeUnreadDrops(sceneOf(one, wakeBook, new Date(NOW.getTime() + (N + 1) * 1000)), { unreadAfter: N });
  expect(wakeBook.typed).toEqual([]);
  expect(wakeBook.enters).toBe(0);
  expect(existsSync(wakePath(drops, record.id))).toBe(false);
  reportUnreadDrops(sceneOf(one, book(), new Date(NOW.getTime() + (2 * N + 1) * 1000)), { unreadAfter: N });
  expect(existsSync(reportedPath(drops, record.id))).toBe(false);
  expect(recordIds(drops)).toEqual([record.id]);
  expect(listUnacked(one.root, 'acme', one.home)).toEqual([]);
});

test('a held socket frame writes no receipt, and the one watch retry still comes after the window', async () => {
  const one = world(['socket']);
  made = one;
  declareEntity(one);
  acceptSocket(one);
  const host = hostOf(one, book(HELD_SCREEN));
  const drops = dropsOf(one);

  const code = await runSend(['lead', 'the held note'], ownerIo(one.root), host);

  // The socket held the frame and no route stood behind it: exit 1, and nothing is a read.
  expect(code).toBe(1);
  expect(host.frames.length).toBe(1);
  const record = recordOf(drops);
  expect(readReceipt(drops, record.id)).toBeNull();
  expect(unreadAt(one).map((message) => message.id)).toEqual([record.id]);
  expect(listUnacked(one.root, 'acme', one.home).map((message) => message.id)).toEqual([record.id]);

  // Before the normal window the record is not due; after it, exactly one retry line is typed.
  const early = book();
  await wakeUnreadDrops(sceneOf(one, early, new Date(NOW.getTime() + (N - 1) * 1000)), { unreadAfter: N });
  expect(early.typed).toEqual([]);
  expect(early.enters).toBe(0);

  const due = book();
  await wakeUnreadDrops(sceneOf(one, due, new Date(NOW.getTime() + (N + 1) * 1000)), { unreadAfter: N });
  // The retry types the message-display line, its summary the held note's first line.
  const line = readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'the held note' }) as string;
  expect(due.typed).toEqual([line]);
  expect(due.enters).toBe(1);
  expect(existsSync(wakePath(drops, record.id))).toBe(true);
  // The retry is a typed line, not a read: no receipt appears behind it.
  expect(readReceipt(drops, record.id)).toBeNull();

  // One wake per message: a later pass at an idle box types nothing again.
  const later = book();
  await wakeUnreadDrops(sceneOf(one, later, new Date(NOW.getTime() + (N + 2) * 1000)), { unreadAfter: N });
  expect(later.typed).toEqual([]);
  expect(later.enters).toBe(0);
});

test('an accepted socket frame names a seat sender by nickname and seat address', async () => {
  const one = world(['socket']);
  made = one;
  acceptSocket(one);
  registerHelper(one, 'Bea');
  const host = hostOf(one, book());
  const drops = dropsOf(one);

  const code = await runSend(['lead', 'a note'], helperIo(one), host);

  expect(code).toBe(0);
  expect(host.frames.length).toBe(1);
  const frame = frameOf(host.frames);
  const record = recordOf(drops);
  expect(frame.id).toBe(record.id);
  // The accepted frame's first line is the display header alone: no colon, no summary, no rule.
  const lines = frame.content.split('\n');
  expect(lines[0]).toBe('Message from Bea (helper@acme)');
  expect(lines[1]).toBe('');
  // Display only: the signed record keeps its own attribution line, and the header is not in it.
  expect(record.body.startsWith('from Bea — admitted by: ')).toBe(true);
  expect(record.raw).not.toContain('Message from Bea');
  // The unchanged body follows the header under one blank line.
  expect(frame.content).toContain(`Message from Bea (helper@acme)\n\n${record.body}`);
});

test('an accepted socket frame falls back to the seat name when no nickname stands', async () => {
  const one = world(['socket']);
  made = one;
  acceptSocket(one);
  registerHelper(one, null);
  const host = hostOf(one, book());
  const drops = dropsOf(one);

  const code = await runSend(['lead', 'a note'], helperIo(one), host);

  expect(code).toBe(0);
  const frame = frameOf(host.frames);
  const record = recordOf(drops);
  expect(frame.content.split('\n')[0]).toBe('Message from helper (helper@acme)');
  expect(record.body.startsWith('from helper — admitted by: ')).toBe(true);
  expect(record.raw).not.toContain('Message from helper');
});
