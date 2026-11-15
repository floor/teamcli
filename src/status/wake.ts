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
  /** How many messages wait unread in the seat's inbox; zero when none waits, and null when the
   *  home that holds the read receipts could not be named. */
  unread: number | null;
  /** The age of the oldest unread drop in the seat's inbox, in seconds; null when nothing waits
   *  or the home that holds the read receipts could not be named. */
  oldest_unread_seconds: number | null;
  /** Plain-text drops an earlier build wrote: never served, counted apart from `unread`. */
  legacy_unsigned?: number;
  /** Seconds since a message to this seat last proved it can be reached: delivered, or read on
   *  its receipt. Absent when the history holds none for the seat (or was not read). */
  last_wake_seconds?: number;
  /** Seconds since a send to this seat last ended undelivered or unwoken with no later proof:
   *  the seat's route failed and nothing has reached it since. Absent otherwise. */
  wake_failed_seconds?: number;
};

/** What a history line says about reaching its seat: proof that a message got through, a send
 *  that did not reach it, or nothing (a send still in flight, a hold, a reply wait that timed out:
 *  a timeout does not say whether the message itself was taken). */
export function wakeEvidenceOf(outcome: string): 'proven' | 'failed' | null {
  if (outcome === 'delivered-but-blocked') return null;
  if (outcome.startsWith('delivered') || outcome === 'answered') return 'proven';
  if (
    outcome === 'not delivered' || outcome === 'unreachable' || outcome.startsWith('wake not taken')
    || outcome.startsWith('queued, not woken') || outcome === 'not-submitted'
  ) return 'failed';
  return null;
}

/** The last proof and the last unanswered failure of reaching one seat, from the history lines
 *  addressed to it, in seconds before `now`. A failure is answered only by proof for the same
 *  message, or for a message first sent after it: a receipt promoted late for an older message
 *  never clears a newer failure. */
export function wakeHealthOf(
  entries: readonly { ts: string; to: string; outcome: string; id?: string }[],
  seat: string,
  now: Date,
): { last_wake_seconds?: number; wake_failed_seconds?: number } {
  const firstSent = new Map<string, number>();
  const ownLines: { at: number; kind: 'proven' | 'failed'; id: string | undefined }[] = [];
  for (const entry of entries) {
    if (entry.to !== seat) continue;
    const at = Date.parse(entry.ts);
    if (!Number.isFinite(at)) continue;
    if (entry.id !== undefined && !(firstSent.get(entry.id)! <= at)) firstSent.set(entry.id, at);
    const kind = wakeEvidenceOf(entry.outcome);
    if (kind !== null) ownLines.push({ at, kind, id: entry.id });
  }
  const sentAt = (line: { at: number; id: string | undefined }) => (line.id === undefined ? line.at : firstSent.get(line.id) ?? line.at);
  let proven = -Infinity;
  for (const line of ownLines) if (line.kind === 'proven' && line.at > proven) proven = line.at;
  let failed = -Infinity;
  for (const line of ownLines) {
    if (line.kind !== 'failed' || line.at <= failed) continue;
    const failedSent = sentAt(line);
    const answered = ownLines.some((other) => other.kind === 'proven'
      && ((line.id !== undefined && other.id === line.id) || sentAt(other) > failedSent));
    if (!answered) failed = line.at;
  }
  const age = (at: number) => Math.max(0, Math.floor((now.getTime() - at) / 1000));
  return {
    ...(Number.isFinite(proven) ? { last_wake_seconds: age(proven) } : {}),
    ...(Number.isFinite(failed) ? { wake_failed_seconds: age(failed) } : {}),
  };
}

/** One seat's wakeability reading: where its records live, its declared row and runtime record,
 *  the registry home, the team's lead seat (a clearance signed by that seat settles here; a
 *  caller that does not name it settles only the owner's clearances), and the instant the unread
 *  age is measured from. */
export type SeatWakeInput = SeatDeliveryInput & {
  now: Date;
  lead?: string;
  /** The project's message history, read once by the caller: the row's last proven wake and
   *  any failure since come from it. Absent: the row carries neither. */
  history?: readonly { ts: string; to: string; outcome: string; id?: string }[];
};

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
  /** The watch may type its retry for this seat (`typed_wake` and `watch_wake` on): a note
   *  that says the retry has not delivered must never say nothing wakes the seat. */
  watchWake: boolean;
};

export function seatWakeReadingOf(input: SeatWakeInput): SeatWakeReading {
  const delivery = seatDeliveryClass(input);
  const dropDir = join(input.dir, 'send-drops', input.session, input.seat);
  const listener = inboxLive(dropDir, input.root, input.session, input.seat).live;
  let oldest: number | null = null;
  let unreadCount: number | null = null;
  let legacyCount = 0;
  if (input.home !== undefined) {
    const listed = listUnread(
      dropDir,
      {
        to: input.seat,
        root: input.root,
        session: input.session,
        ...(input.lead === undefined ? {} : { lead: input.lead }),
      },
      input.home,
      undefined,
      undefined,
      { legacy: 'include' },
    );
    // A plain-text drop an earlier build wrote is never served: it is counted on its own, and the
    // unread count is the mail a reader can serve.
    const unread = listed.filter((one) => one.legacy !== true);
    legacyCount = listed.length - unread.length;
    unreadCount = unread.length;
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
      unread: unreadCount,
      oldest_unread_seconds: oldest,
      ...(legacyCount > 0 ? { legacy_unsigned: legacyCount } : {}),
      ...(input.history === undefined ? {} : wakeHealthOf(input.history, input.seat, input.now)),
    },
    words: delivery.words,
    watchWake: delivery.evidence.watchWake,
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
  if (wake.legacy_unsigned !== undefined) notes.push(`${String(wake.legacy_unsigned)} unsigned old drop(s), not served`);
  if (wake.wake_failed_seconds !== undefined) notes.push(`last send not delivered ${wakeAge(wake.wake_failed_seconds)} ago`);
  if (wake.last_wake_seconds !== undefined) notes.push(`last reached ${wakeAge(wake.last_wake_seconds)} ago`);
  const word = `${wake.wakeable ? '' : '!'}${wake.class}`;
  return notes.length === 0 ? word : `${word} (${notes.join(', ')})`;
}
