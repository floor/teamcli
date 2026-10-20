// The daemon's own answer to "is this route's presence channel healthy right now?".
//
// Nothing in the store can answer it: `status.json` records what a writer said last, and its
// `serving` word must never be believed on its own. The only truthful source is the process that
// owns the route and runs its ingester: it knows whether a pass has finished recently, and a pass
// that hung ages the answer to unknown instead of claiming the channel still serves. This module
// is that fixed liveness, kept in memory and never persisted.

/**
 * How long a finished pass vouches for the channel. The production pass runs every 250 ms; eight
 * missed passes mean a step is hung or the loop is not running, and the honest answer is no.
 */
export const PRESENCE_HEALTH_GRACE_MS = 2_000;

export type PresenceChannelHealth = {
  /** Records the outcome of one ingester step at the instant it finished. A refusal is a step
   *  that threw; the store refusing individual records is not a dead channel and stays healthy. */
  stepped(ok: boolean, at: Date): void;
  /** Whether a successful step finished inside the grace window and nothing failed since. */
  healthy(at: Date): boolean;
};

export function createPresenceChannelHealth(
  graceMs = PRESENCE_HEALTH_GRACE_MS,
): PresenceChannelHealth {
  let lastOkAt: number | null = null;
  let lastStepOk = false;
  return {
    stepped(ok, at) {
      lastStepOk = ok;
      if (ok) lastOkAt = at.getTime();
    },
    healthy(at) {
      if (!lastStepOk || lastOkAt === null) return false;
      const age = at.getTime() - lastOkAt;
      return age >= 0 && age <= graceMs;
    },
  };
}
