// One root's stuck child: a hosted watch that never leaves `starting`, or a chores child that
// has missed more heartbeats than this root allows. The daemon stops and starts only the child
// it started for that root. Three restarts in an hour is the cap; the next one is left for a
// person, and a child under the limit is never restarted.

export const STUCK_RESTARTS_PER_HOUR = 3;
export const STUCK_RESTART_WINDOW_MS = 60 * 60 * 1000;

export type StuckFacts = {
  nowMs: number;
  /** The phase the daemon last read for this root's watch. */
  watchPhase: string;
  /** When that phase began, or null when the daemon has no start instant to judge. */
  watchStartedAtMs: number | null;
  cycles: number;
  /** Heartbeats this daemon has not heard from the chores child. A count at or under the
   *  limit stays up, including one that is briefly late. */
  missed: number;
  watchStartLimitMs: number;
  childLateLimit: number;
  /** Which child a restart would stop. */
  child: 'chores' | 'watch';
};

export type StuckDecision =
  | { action: 'none' }
  | { action: 'restart'; text: string }
  | { action: 'leave'; text: string };

type RootMemory = {
  at: number[];
  /** The cap's one lead message has already been sent for the restarts still inside the window. */
  left: boolean;
};

/**
 * Remembers each root's restarts. `consider` does not record one: the caller records it only
 * after the child was actually stopped, so a restart that could not be made is not counted and
 * is tried again on a later beat.
 */
export function createStuckBook(): {
  consider(root: string, facts: StuckFacts): StuckDecision;
  committed(root: string, nowMs: number): void;
} {
  const memory = new Map<string, RootMemory>();
  const of = (root: string): RootMemory => {
    const found = memory.get(root);
    if (found !== undefined) return found;
    const fresh: RootMemory = { at: [], left: false };
    memory.set(root, fresh);
    return fresh;
  };
  return {
    consider(root: string, facts: StuckFacts): StuckDecision {
      const reason = reasonOf(facts);
      if (reason === null) return { action: 'none' };
      const entry = of(root);
      entry.at = entry.at.filter((at) => facts.nowMs - at < STUCK_RESTART_WINDOW_MS);
      if (entry.at.length < STUCK_RESTARTS_PER_HOUR) {
        entry.left = false;
        return { action: 'restart', text: lineOf(facts.child, reason, 'stopped and started again') };
      }
      if (entry.left) return { action: 'none' };
      entry.left = true;
      return { action: 'leave', text: lineOf(facts.child, reason, 'left for a person') };
    },
    committed(root: string, nowMs: number): void {
      of(root).at.push(nowMs);
    },
  };
}

/** The clause that says why this root is due, or null when neither limit has been passed.
 *  A watch with no start instant is not judged stuck: a missing clock is not a long start.
 *  A heartbeat count at the limit is still under it: only more than the limit is late. */
function reasonOf(facts: StuckFacts): string | null {
  const parts: string[] = [];
  if (facts.watchPhase === 'starting' && facts.watchStartedAtMs !== null) {
    const elapsed = facts.nowMs - facts.watchStartedAtMs;
    if (elapsed >= facts.watchStartLimitMs) {
      const secs = Math.floor(elapsed / 1000);
      const limit = Math.floor(facts.watchStartLimitMs / 1000);
      parts.push(`still starting for ${String(secs)}s, limit ${String(limit)}s, ${String(facts.cycles)} cycles`);
    }
  }
  if (facts.missed > facts.childLateLimit) {
    parts.push(`missed ${String(facts.missed)} heartbeats, limit ${String(facts.childLateLimit)}`);
  }
  return parts.length === 0 ? null : parts.join('; ');
}

function lineOf(child: StuckFacts['child'], reason: string, ending: string): string {
  const name = child === 'chores' ? 'chores child' : 'watch';
  return `${name}: ${reason}; ${ending}`;
}
