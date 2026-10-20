// The queued model swap: one record per seat at the top of the team state, written by
// `team swap`, carried out by the watch at the seat's boundary (Policies rule 11,
// OD-20261019-02 and -03). The queue is the project's, like the hold and the pause: it outlives
// `down` and `up`, and the same record serves any change that needs a restart (`reason` says
// which command asked).

import { join } from 'node:path';
import { supportsSessionResume } from '../profiles/profile.ts';
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

/** The model fields a seat declares now, as the record's `from`: the file's words at queue
 *  time, which the run compares the new screen's read-back with. */
export function swapModelOf(seat: { cli: string; vendor: string; model: string; version: string; display: string }): SwapModel {
  return { cli: seat.cli, vendor: seat.vendor, model: seat.model, version: seat.version, display: seat.display };
}

/** The queue in seat order, so two readers print the same list. */
export function queuedSwaps(state: State, teamSeats?: ReadonlySet<string>): Array<[string, QueuedSwap]> {
  return Object.entries(state.swaps ?? {})
    .filter(([seat]) => teamSeats === undefined || teamSeats.has(seat))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

export function queuedSwap(state: State, seat: string): QueuedSwap | null {
  return state.swaps?.[seat] ?? null;
}

/**
 * Whether the swap's launch must be given a handover instead of the recorded conversation:
 * the CLI changes, or the target CLI keeps no session to resume. The decision is the profile's
 * fact plus the two declarations, so the record and the run read one rule.
 */
export function needsHandover(from: SwapModel, to: QueuedSwap['to']): boolean {
  return from.cli !== to.cli || !supportsSessionResume(to.cli);
}

/** The path a swap's handover is written at: the project's `handovers` folder, named for the
 *  seat and the queueing instant. A queued record keeps the path, so a run retried after a busy
 *  turn looks for the same file and a retry never types over one already written. */
export function handoverPath(dir: string, seat: string, now: Date): string {
  return join(dir, 'handovers', `${seat}-${now.toISOString().replace(/[:.]/g, '-')}.md`);
}

/** Queues (or replaces) one seat's swap and returns the record written. The deadline is the
 *  request's own wait from `now`; queueing again restarts the wait and the record. A swap whose
 *  CLI changes — or whose target CLI cannot resume — names its handover now, in the record. */
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
    ...(needsHandover(request.from, request.to) ? { handover: handoverPath(dir, request.seat, request.now) } : {}),
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
 * Takes one seat's swap out of the queue once its run is done. Only the record the run read is
 * removed (`queuedAt` names it): a swap queued again while the run was stopping and launching
 * the seat is a new request and stays. Null when the queue holds no such record.
 */
export function finishSwap(dir: string, seat: string, queuedAt: string): QueuedSwap | null {
  return updateState(dir, (state) => {
    const held = state.swaps?.[seat];
    if (!held || held.queuedAt !== queuedAt) return null;
    delete state.swaps?.[seat];
    if (state.swaps && Object.keys(state.swaps).length === 0) delete state.swaps;
    return held;
  });
}

/**
 * Records the handover path a run named for a swap queued without one (the CLI was the same,
 * so the record expected a resume, and the registry held no session id). Pinned to `queuedAt`
 * for the same reason `finishSwap` is: a record queued again is not this run's.
 */
export function noteHandover(dir: string, seat: string, queuedAt: string, path: string): QueuedSwap | null {
  return updateState(dir, (state) => {
    const held = state.swaps?.[seat];
    if (!held || held.queuedAt !== queuedAt) return null;
    held.handover = path;
    return held;
  });
}

/**
 * Whether a swap runs on this pass. An explicit force is the owner's own instruction for this
 * record and runs at once; every automatic route — a broken screen, the observed boundary
 * (quiet, no turn, no dialog, no task) and the past-deadline pause between two turns — waits
 * while the native presence proof holds the seat. The caller owns that observation; the queue
 * owns the rule.
 */
export function swapDue(
  swap: QueuedSwap,
  observed: { working: boolean; prompt: boolean; boundary: boolean; broken: boolean; unsent: boolean; nativeHeld?: boolean },
  now: Date,
): boolean {
  if (swap.forced) return true;
  // A runtime turn, a person wait, a session end or an unproven record is not a pause between
  // two turns: no automatic flag below may stop such a seat.
  if (observed.nativeHeld === true) return false;
  if (observed.broken) return true;
  if (observed.boundary) return true;
  const pastDeadline = Date.parse(swap.deadline) <= now.getTime();
  return pastDeadline && !observed.working && !observed.prompt && !observed.unsent;
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
