// The state's copy of a seat's last webhook delivery: the bus writes it after every scheduled
// delivery, so `team check` and `team status` can name one the send could not have known about —
// the send computed its words before the bus ever saw the record. The record is evidence, never a
// gate: a locked, unreadable or missing state loses this one reading and nothing else.
import { updateState } from '../state.ts';
import type { SignedEventRecord } from './log.ts';
import type { WebhookFacts } from './webhook.ts';

/**
 * Records one delivery's facts on the seat's row. Only a row that already exists is written: the
 * state records launches, and a delivery is not one, so a seat the state does not hold (a seat the
 * file declares but no launch recorded) is left alone rather than invented. The write never waits
 * for the state lock — the bus's pass must not block on a writer — and a lock held elsewhere drops
 * the reading for this delivery.
 */
export function recordWebhookDelivery(
  stateDir: string,
  session: string,
  seat: string,
  record: SignedEventRecord,
  facts: WebhookFacts,
  now: () => Date = () => new Date(),
): void {
  try {
    updateState(stateDir, (state) => {
      const row = state.sessions[session]?.seats[seat];
      if (row === undefined) return false;
      row.webhook_delivery = {
        record_id: record.payload.record_id,
        at: now().toISOString(),
        outcome: facts.outcome,
        attempts: facts.attempts,
        reason: facts.reason,
      };
      return true;
    }, { waitMs: 0, writeWhen: (wrote) => wrote });
  } catch {
    // A state that cannot be written now keeps the delivery's own answer, which is unaffected.
  }
}
