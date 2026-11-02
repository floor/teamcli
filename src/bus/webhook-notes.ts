// The line `team check` and `team status` print for a seat whose last webhook delivery did not
// arrive: one function, so both commands say the same thing in the same words. The reading is
// the bus's own record in the state (`src/bus/webhook-record.ts`); the send's words were computed
// before the bus saw the record, so this is where the outcome is read afterwards.
import type { Seat } from '../file/types.ts';
import type { SessionState, WebhookDeliveryRecord } from '../state.ts';

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
