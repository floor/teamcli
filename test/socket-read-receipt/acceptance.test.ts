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

/** Leads wake at 180 seconds, independently of the ordinary seat delivery order. */
const N = 180;

let made: World | null = null;
afterEach(() => {
  made?.cleanup();
  made = null;
});

function ownerIo(root: string) {
  return testIo(root, { kind: 'owner' });
}
