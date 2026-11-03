// The release bounds of a send's own arrival post: how long the person's `team send` waits on the
// receiving seat's routine before it reports the answer unknown. The post is a wake beside a
// record that is already durable and staged for the bus and the seat's pull, so it is off the
// critical path; three seconds gives an endpoint that answers in one to two seconds its full
// answer instead of an `unknown` it never had. The bounds are the policy's range, not the bus's:
// the bus delivery keeps its own, longer budget (`WEBHOOK_POLICY` in `src/bus/webhook.ts`).
export const WEBHOOK_SENDER_DEADLINE_MS = 3000;

/** The least a level may name: half a second, so a declared send bound still reads some answer. */
export const WEBHOOK_SENDER_DEADLINE_MIN_MS = 500;

/** The most a level may name: ten seconds, the policy's ceiling for a slow routine. */
export const WEBHOOK_SENDER_DEADLINE_MAX_MS = 10_000;
