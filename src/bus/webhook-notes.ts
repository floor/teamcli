// The lines `team check` and `team status` print about webhook delivery: one sentence for a seat
// whose last delivery did not arrive, and one for the posts a send left in flight with no bus
// serving the root to finish them. Two functions, so both commands say the same thing in the same
// words. The delivery reading is the bus's own record in the state (`src/bus/webhook-record.ts`);
// the send's words were computed before the bus saw the record, so this is where the outcome is
// read afterwards. The unfinished reading is the drop folders themselves: the claims a send and a
// bus pass leave beside the records, and which of them nobody may post again.
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Seat } from '../file/types.ts';
import type { SessionState, WebhookDeliveryRecord } from '../state.ts';
import { busHealth } from './server.ts';

function attemptsWord(count: number): string {
  return `${String(count)} attempt${count === 1 ? '' : 's'}`;
}

/** One note's sentence after the seat's name: what the delivery ended as, when, and why. */
function deliveryWords(delivery: WebhookDeliveryRecord): string {
  if (delivery.outcome === 'refused') {
    return `was not posted at ${delivery.at}: ${delivery.reason}`;
  }
  const what = delivery.outcome === 'failed'
    ? `failed after ${attemptsWord(delivery.attempts)}`
    : `was sent with its response unknown after ${attemptsWord(delivery.attempts)}`;
  return `${what} at ${delivery.at}: ${delivery.reason}`;
}

/**
 * One line per declared seat whose last webhook delivery did not arrive, in the same words for
 * `team status` and `team check`: the outcome, the attempt count, the fixed-words reason and the
 * instant the delivery ended. A delivered record draws no line, and a later delivery replaces the
 * record, so a failure clears itself the next time the routine takes a record.
 */
export function webhookDeliveryNotes(seats: readonly Seat[], state: SessionState): string[] {
  const notes: string[] = [];
  for (const seat of seats) {
    const delivery = state.seats[seat.name]?.webhook_delivery;
    if (delivery === undefined || delivery.outcome === 'delivered') continue;
    notes.push(
      `${seat.name}: its last webhook delivery did not arrive: it ${deliveryWords(delivery)}; the delivery left the drop record for the seat's own pull`,
    );
  }
  return notes;
}

/** The claim both posters hold while their request is in flight: `<id>.posting` beside the record.
 *  One left in `sent` says the bytes may have reached the routine, so nothing posts the record
 *  again and the delivery's outcome is never read — a bus pass finishes it, and with no bus
 *  serving the root, nothing does. */
const CLAIM_SUFFIX = '.posting';

/** The `sent` claims in one seat's drop folder, counted from the files a reader may trust: a
 *  regular file this user owns, whose name is a claim and whose bytes name the state. A linked
 *  file, another user's file or one that does not parse is not counted — the note names what was
 *  read, never what could not be. */
function sentClaimsIn(dropDir: string): number {
  let names: string[];
  try {
    names = readdirSync(dropDir);
  } catch {
    return 0;
  }
  let count = 0;
  for (const name of names) {
    if (!name.endsWith(CLAIM_SUFFIX)) continue;
    try {
      const held = lstatSync(join(dropDir, name));
      if (!held.isFile()) continue;
      if (process.getuid !== undefined && held.uid !== process.getuid()) continue;
      const parsed = JSON.parse(readFileSync(join(dropDir, name), 'utf8')) as { state?: unknown };
      if (parsed.state === 'sent') count += 1;
    } catch {
      // An unreadable claim proves nothing and is not counted.
    }
  }
  return count;
}

/** Every `sent` claim under the root's drop folders, each session's and each seat's folder
 *  proven by its real path first: a linked ancestor could lead into another checkout, and a
 *  claim there is not this root's to report. */
function sentClaims(root: string): number {
  let drops: string;
  try {
    const realRoot = realpathSync(root);
    drops = join(realRoot, '.agents', 'send-drops');
    if (realpathSync(drops) !== drops) return 0;
  } catch {
    return 0;
  }
  let sessions: string[];
  try {
    sessions = readdirSync(drops);
  } catch {
    return 0;
  }
  let count = 0;
  for (const session of sessions) {
    const sessionDir = join(drops, session);
    try {
      if (realpathSync(sessionDir) !== sessionDir || !lstatSync(sessionDir).isDirectory()) continue;
    } catch {
      continue;
    }
    let seats: string[];
    try {
      seats = readdirSync(sessionDir);
    } catch {
      continue;
    }
    for (const seat of seats) {
      const seatDir = join(sessionDir, seat);
      try {
        if (realpathSync(seatDir) !== seatDir || !lstatSync(seatDir).isDirectory()) continue;
      } catch {
        continue;
      }
      count += sentClaimsIn(seatDir);
    }
  }
  return count;
}

export type UnfinishedWebhookInput = {
  root: string;
  /** Whether a recorded bus process answers: the reading `team status` and `team check` use. */
  alive: (pid: number) => boolean;
};

/**
 * One line for the webhook posts a send left in flight — claims in `sent`, whose request may have
 * reached the routine and whose answer was not read — when no bus is serving the root: a bus pass
 * is what finishes such a claim, and with none serving, nothing will. The line clears once a bus
 * serves the root: its own pass records the outcome, and the note has nothing left to say. A
 * serving bus, a root with no drop folder and a claim still in `claimed` all draw no line. The
 * line is a reading: it changes no count and no exit, and it never reports a post as delivered.
 */
export function unfinishedWebhookNotes(input: UnfinishedWebhookInput): string[] {
  if (busHealth(input.root, input.alive).kind === 'running') return [];
  const count = sentClaims(input.root);
  if (count === 0) return [];
  const posts = count === 1 ? '1 webhook post awaits' : `${String(count)} webhook posts await`;
  return [`${posts} a bus that isn't serving (${input.root})`];
}
