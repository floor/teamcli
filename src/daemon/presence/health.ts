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

/**
 * The ingester's own typed answer for one finished step. Completion is never success: a step can
 * resolve while the log is faulted, the index is unreadable or an append is unrecovered, and the
 * ingester reports failures through its result rather than by throwing. Until the ingester module
 * carries `healthy`, an absent answer is not healthy, so a faulted log can never keep an old
 * projection trusted. A step that still has known backlog pending is not current either: the
 * consumer must see false until the channel has caught up.
 */
export function presenceStepHealth(result: { healthy?: unknown; pending?: unknown }): boolean {
  return result.healthy === true && result.pending === false;
}

export type PresenceChannelHealth = {
  /** Records one finished step's typed channel answer at the instant it finished. The answer is
   *  the ingester's own (`presenceStepHealth`), never inferred from the step merely resolving.
   *  `why` is display detail for a false answer; it never participates in the verdict. */
  stepped(ok: boolean, at: Date, why?: string | null): void;
  /** Whether a successful step finished inside the grace window and nothing failed since. */
  healthy(at: Date): boolean;
  /** Why the answer at `at` is not healthy, for display; null when it is healthy. Never a
   *  substitute for `healthy`: no step, a false step and an aged-out step all answer false. */
  reason(at: Date): string | null;
};

export function createPresenceChannelHealth(
  graceMs = PRESENCE_HEALTH_GRACE_MS,
): PresenceChannelHealth {
  let lastOkAt: number | null = null;
  let lastStepOk = false;
  let lastWhy: string | null = null;
  const healthy = (at: Date): boolean => {
    if (!lastStepOk || lastOkAt === null) return false;
    const age = at.getTime() - lastOkAt;
    return age >= 0 && age <= graceMs;
  };
  return {
    stepped(ok, at, why = null) {
      lastStepOk = ok;
      lastWhy = ok ? null : why;
      if (ok) lastOkAt = at.getTime();
    },
    healthy,
    reason(at) {
      if (healthy(at)) return null;
      if (!lastStepOk) return lastWhy ?? 'the presence channel did not answer healthy';
      return 'no presence step finished inside the liveness window';
    },
  };
}
