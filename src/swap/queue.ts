// The queued model swap: one record per seat at the top of the team state, written by
// `team swap`, carried out by the watch at the seat's boundary (Policies rule 11,
// OD-20261019-02 and -03). The queue is the project's, like the hold and the pause: it outlives
// `down` and `up`, and the same record serves any change that needs a restart (`reason` says
// which command asked).

import { readState, updateState, type QueuedSwap, type State, type SwapModel } from '../state.ts';

export type QueueRequest = {
  seat: string;
  from: SwapModel;
  to: QueuedSwap['to'];
  reason: QueuedSwap['reason'];
  /** The swap-wait-seconds in force for this seat. */
  waitSeconds: number;
  /** What the swap waits for, in the words `status` prints under the seat's row. */
  waitFor: string;
  /** The model-rule value in force when a rule-driven swap was queued. */
  rule?: string;
  now: Date;
};

/** The queue in seat order, so two readers print the same list. */
export function queuedSwaps(state: State, teamSeats?: ReadonlySet<string>): Array<[string, QueuedSwap]> {
  return Object.entries(state.swaps ?? {})
    .filter(([seat]) => teamSeats === undefined || teamSeats.has(seat))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

export function queuedSwap(state: State, seat: string): QueuedSwap | null {
  return state.swaps?.[seat] ?? null;
}

/** Queues (or replaces) one seat's swap and returns the record written. The deadline is the
 *  request's own wait from `now`; queueing again restarts the wait and the record. */
export function enqueueSwap(dir: string, request: QueueRequest): QueuedSwap {
  const queuedAt = request.now.toISOString();
  const deadline = new Date(request.now.getTime() + request.waitSeconds * 1000).toISOString();
  const record: QueuedSwap = {
    from: request.from,
    to: request.to,
    reason: request.reason,
    queuedAt,
    deadline,
    waitFor: request.waitFor,
    ...(request.rule !== undefined ? { rule: request.rule } : {}),
  };
  return updateState(dir, (state) => {
    state.swaps = { ...(state.swaps ?? {}), [request.seat]: record };
    return record;
  });
}

/** Takes one seat's swap out of the queue; null when it held none. */
export function cancelSwap(dir: string, seat: string): QueuedSwap | null {
  return updateState(dir, (state) => {
    const held = state.swaps?.[seat] ?? null;
    if (held && state.swaps) {
      delete state.swaps[seat];
      if (Object.keys(state.swaps).length === 0) delete state.swaps;
    }
    return held;
  });
}

/** Marks one seat's swap forced by `by` at `now`, keeping the rest of the record. */
export function forceSwap(dir: string, seat: string, by: string, now: Date): QueuedSwap | null {
  return updateState(dir, (state) => {
    const held = state.swaps?.[seat];
    if (!held) return null;
    held.forced = { by, at: now.toISOString() };
    return held;
  });
}

/**
 * Whether a swap runs on this pass. A forced swap and a broken seat's swap run at once; every
 * other one runs at the boundary the watch observed — quiet, no turn, no dialog, no task — and
 * past its deadline at the next pause between two turns, which is the same observation minus
 * the task condition. The caller owns that observation; the queue owns the rule.
 */
export function swapDue(
  swap: QueuedSwap,
  observed: { working: boolean; prompt: boolean; boundary: boolean; broken: boolean },
  now: Date,
): boolean {
  if (swap.forced) return true;
  if (observed.broken) return true;
  if (observed.boundary) return true;
  const pastDeadline = Date.parse(swap.deadline) <= now.getTime();
  return pastDeadline && !observed.working && !observed.prompt;
}

/** The one line every reader prints for a queued swap (`team status`, `team swap`). */
export function swapLine(seat: string, swap: QueuedSwap, now: Date): string {
  const from = `${swap.from.vendor} ${swap.from.model} ${swap.from.version}`;
  const to = `${swap.to.vendor} ${swap.to.model} ${swap.to.version}`;
  const parts = [
    `${seat}: ${from} -> ${to} (${swap.reason === 'model-rule' ? 'the entity model rule' : swap.reason})`,
    `queued ${swap.queuedAt}`,
    swap.forced
      ? `forced by ${swap.forced.by} at ${swap.forced.at}`
      : `waits for ${swap.waitFor}`,
  ];
  if (!swap.forced) {
    const left = Math.ceil((Date.parse(swap.deadline) - now.getTime()) / 1000);
    parts.push(left > 0 ? `runs by ${swap.deadline}` : 'past its wait: next pause between two turns');
  }
  return parts.join(', ');
}

/** Re-reads one project's queue without the lock, for readers that already hold a state. */
export function queueOf(dir: string): Array<[string, QueuedSwap]> {
  return queuedSwaps(readState(dir));
}
