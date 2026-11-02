// Whether a seat can be reached while it is idle, as `team status` and `team seats` show it.
//
// The class a send measures is the answer, and this module only reads it (`seatDeliveryClass`)
// beside the facts a reader needs to see why: whether the seat's runtime endpoint is recorded
// and whether a conversation is bound to it, whether a live inbox listener stands in its drop
// folder, and how old its oldest unread drop is. `team send` refuses to spend a wake and a
// dispatch pass on a seat whose class is `pull-on-turn` or `none`; a table that shows the class
// lets the owner see that before the message sits unread.
//
// It lives under src/status rather than in either command because `status.ts` imports `seats.ts`
// for its expanded table: the shared reading must not make the two command modules import each
// other for this alone.
import { join } from 'node:path';
import { seatDeliveryClass, wakeableWhileIdle, type DeliveryClass, type SeatDeliveryInput } from '../launch/delivery-class.ts';
import { inboxLive, listUnread } from '../mcp/inbox.ts';

/** What one row says about reaching its seat while it is idle. */
export type SeatWake = {
  /** The class a send measures: `push`, `between-turns`, `pull-on-turn` or `none`. */
  class: DeliveryClass;
  /** Whether a message can reach the seat while it sits idle (`wakeableWhileIdle`). */
  wakeable: boolean;
  /** The seat's records bind the conversation its runtime queue is addressed by. */
  conversation: boolean;
  /** A managed app-server endpoint is recorded and bound to the seat's current presence
   *  incarnation, whether or not a conversation is bound to it. */
  endpoint: boolean;
  /** A live MCP inbox listener stands in the seat's drop folder: the inbox leg is served when
   *  the seat takes a turn. It never wakes an idle seat, and it is not a wake. */
  listener: boolean;
  /** The age of the oldest unread drop in the seat's inbox, in seconds; null when nothing waits
   *  or the home that holds the read receipts could not be named. */
  oldest_unread_seconds: number | null;
};

/** One seat's wakeability reading: where its records live, its declared row and runtime record,
 *  the registry home, and the instant the unread age is measured from. */
export type SeatWakeInput = SeatDeliveryInput & { now: Date };

/**
 * The reading for one seat. The class comes from the same `seatDeliveryClass` a send reads and
 * its refusals are built on, so the table and the walk cannot disagree; the listener is the
 * liveness-only answer `team send`'s inbox leg gets (a stale build's marker still counts as no
 * listener here — the display does not name a build), and the unread age is the oldest message
 * `listUnread` would serve. A home the caller cannot name proves no read receipts, so no message
 * is called unread from a receipt it could not check.
 */
export function seatWakeOf(input: SeatWakeInput): SeatWake {
  return seatWakeReadingOf(input).wake;
}

/** One seat's wake reading with the class's own sentence (`deliveryWords`), for a caller that
 *  prints a note about it: both come from one `seatDeliveryClass` read, so the row's cell and
 *  the note cannot split between two readings taken at different instants. */
export type SeatWakeReading = {
  wake: SeatWake;
  /** The class in plain words, without a run's wake outcome: a reading, not a send. */
  words: string;
};

export function seatWakeReadingOf(input: SeatWakeInput): SeatWakeReading {
  const delivery = seatDeliveryClass(input);
  const dropDir = join(input.dir, 'send-drops', input.session, input.seat);
  const listener = inboxLive(dropDir, input.root, input.session, input.seat).live;
  let oldest: number | null = null;
  if (input.home !== undefined) {
    const unread = listUnread(dropDir, { to: input.seat, root: input.root, session: input.session }, input.home);
    const first = unread[0];
    if (first !== undefined) {
      const at = Date.parse(first.ts);
      if (Number.isFinite(at)) oldest = Math.max(0, Math.floor((input.now.getTime() - at) / 1000));
    }
  }
  return {
    wake: {
      class: delivery.class,
      wakeable: wakeableWhileIdle(delivery.class),
      conversation: delivery.evidence.conversation,
      endpoint: delivery.evidence.endpointRecorded,
      listener,
      oldest_unread_seconds: oldest,
    },
    words: delivery.words,
  };
}

/** An age in the table's own short words: seconds, minutes, hours, days. */
export function wakeAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The cell `team status` and `team seats` print. The class is the word; a `!` marks the seat a
 * message cannot wake, so a table scan finds it before an unread drop stacks up. The notes keep
 * the facts that explain the class without a second column: an endpoint with no bound
 * conversation (there is a queue, and nothing to hand it), a live inbox (the message will be
 * served on the seat's next turn, and the seat still cannot be woken), and the oldest unread
 * drop's age.
 */
export function wakeCell(wake: SeatWake): string {
  const notes: string[] = [];
  if (wake.endpoint && !wake.conversation) notes.push('endpoint, no bound conversation');
  if (wake.listener) notes.push('inbox');
  if (wake.oldest_unread_seconds !== null) notes.push(`unread ${wakeAge(wake.oldest_unread_seconds)}`);
  const word = `${wake.wakeable ? '' : '!'}${wake.class}`;
  return notes.length === 0 ? word : `${word} (${notes.join(', ')})`;
}
