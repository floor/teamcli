// The socket leg's delivery, and the frame header an accepted delivery carries.
//
// A taken socket frame is a delivery, and a delivery is not a read: only the seat writes the
// signed `<id>.read.json` receipt that proves one. Acceptance writes none, so the record stays
// unread — `team drops --read` serves it, `team messages` lists it as unacked, the watch's
// unread pass wakes it at N, and the sender's mailbox and the lead are told at 2N. The seat's
// own read then writes the receipt and settles it. A frame the box held proves nothing either:
// no receipt, and the watch's one retry still comes after the normal window.
//
// The accepted frame ends with the reader line ADR D3 pins: it names the message id twice —
// `team reply <id>` answers and marks it read, `team ack <id>` marks it read with no answer —
// so a seat that saw the frame can settle the record it carries. The frame opens with
// `Message from <name> (<seat>@<team>)`, the sender's nickname (its seat name when none stands)
// resolved from the signed record. It is display only: the signed record keeps its own
// `from … — admitted by: …` line, and the typed-wake line is unchanged.
// No live session, socket or owner home: the host's deliver is a fake, and the pane is a string.
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { listUnacked } from '../../src/commands/messages.ts';
import { runDrops } from '../../src/commands/drops.ts';
import { runSend } from '../../src/commands/send.ts';
import { readerLine } from '../../src/send/frame.ts';
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
  LEAD_PANE,
  NOW,
  readReceipt,
  receiptVerifies,
  recordLead,
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

test('an accepted socket frame writes no receipt and leaves the record unread', async () => {
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
  // The frame's own last line names the record's shortest unique id prefix, once.
  const content = frameOf(host.frames).content;
  const reader = readerLine(record.id);
  expect(content.split('\n').at(-1)).toBe(reader);
  expect(content.split('\n').filter((line) => line === reader)).toHaveLength(1);
  // The frame was taken: that is the delivery, and it writes no receipt. Only the seat writes a
  // read receipt, so the record derives `sent` and stays in the reader's unread list.
  expect(readReceipt(drops, record.id)).toBeNull();
  expect(statusAt(one, 'lead', record.id)).toBe('sent');
  expect(unreadAt(one).map((message) => message.id)).toEqual([record.id]);
});

test('an accepted socket delivery stays unread until the seat reads it, and that read settles it', async () => {
  const one = world(['socket']);
  made = one;
  declareEntity(one);
  acceptSocket(one);
  const host = hostOf(one, book());
  const drops = dropsOf(one);
  expect(await runSend(['lead', 'the socket note'], ownerIo(one.root), host)).toBe(0);
  const record = recordOf(drops);

  // The watch's ring reads `listUnacked`: with no receipt the record is still listed.
  expect(listUnacked(one.root, 'acme', one.home).map((message) => message.id)).toEqual([record.id]);

  // The seat's own read serves the body and writes the signed receipt that proves it. The read
  // places its caller, so the state records the lead's standing as its launch would.
  recordLead(one);
  const readIo = testIo(one.root, { kind: 'seat', name: 'lead', pane: LEAD_PANE, session: 'acme' });
  const read = await runDrops(['--read', '--seat', 'lead', '--session', 'acme'], readIo, { home: one.home });
  expect(read).toBe(0);
  expect(readIo.out).toContain('the socket note');
  expect(readIo.err).toBe('');
  expect(receiptVerifies(drops, record.id, one.home)).toBe(true);
  expect(statusAt(one, 'lead', record.id)).toBe('read');
  expect(unreadAt(one)).toEqual([]);
  expect(listUnacked(one.root, 'acme', one.home)).toEqual([]);
});

test('a socket delivery no seat reads is woken at the window and reported at twice it', async () => {
  const one = world(['socket']);
  made = one;
  declareEntity(one);
  acceptSocket(one);
  const host = hostOf(one, book());
  const drops = dropsOf(one);
  expect(await runSend(['lead', 'the socket note'], ownerIo(one.root), host)).toBe(0);
  const record = recordOf(drops);

  // Past the window the unread pass wakes the record like any other. No pane messaging: the
  // typed leg is refused, so nothing is typed and no wake marker is spent.
  const wakeBook = book();
  await wakeUnreadDrops(sceneOf(one, wakeBook, new Date(NOW.getTime() + (N + 1) * 1000)), { unreadAfter: N });
  expect(wakeBook.typed).toEqual([]);
  expect(wakeBook.enters).toBe(0);
  expect(existsSync(wakePath(drops, record.id))).toBe(false);

  // Past twice the window, and still unread, the sender and the lead are told.
  reportUnreadDrops(sceneOf(one, book(), new Date(NOW.getTime() + (2 * N + 1) * 1000)), { unreadAfter: N });
  expect(existsSync(reportedPath(drops, record.id))).toBe(true);
});

test('a socket-taken frame under a held dialog writes no receipt, and the one watch retry still comes after the window', async () => {
  const one = world(['socket']);
  made = one;
  declareEntity(one);
  acceptSocket(one);
  const pane = book(HELD_SCREEN);
  const host = hostOf(one, pane);
  const drops = dropsOf(one);

  const code = await runSend(['lead', 'the held note'], ownerIo(one.root), host);

  // The screen shows a held-message dialog, but a taken frame ends the sender's work before any
  // look: the send reports `delivered (socket)`, nothing is typed, and nothing is a read. The
  // dialog — if the seat is in one — is the daemon's held step to see and mark.
  expect(code).toBe(0);
  expect(host.frames.length).toBe(1);
  // One look, and it is the quota preflight every send makes; no held-dialog probe runs here.
  expect(pane.reads).toBe(1);
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
  // No pane messaging: the watch types nothing after the window either, and nothing is a read.
  expect(due.typed).toEqual([]);
  expect(due.enters).toBe(0);
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
  // The frame opens with the compact header; the signed record keeps its own attribution line.
  const lines = frame.content.split('\n');
  expect(lines[0]).toBe('from Bea (to orchestrator):');
  expect(lines[1]).toBe('');
  expect(record.body.startsWith('from Bea — admitted by: ')).toBe(true);
  expect(record.raw).not.toContain('Message from Bea');
  // The message body follows the compact header under one blank line.
  expect(frame.content).toContain('from Bea (to orchestrator):\n\na note');
  // And the frame closes with the reader line naming the record's own id prefix.
  expect(frame.content.split('\n').at(-1)).toBe(readerLine(record.id));
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
  expect(frame.content.split('\n')[0]).toBe('from helper (to orchestrator):');
  expect(frame.content.split('\n').at(-1)).toBe(readerLine(record.id));
  expect(record.body.startsWith('from helper — admitted by: ')).toBe(true);
  expect(record.raw).not.toContain('Message from helper');
});
