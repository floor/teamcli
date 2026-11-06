// The per-seat presence reconciliation the daemon used to hold inline.
//
// The daemon's main loop and a root's chores child both need the same three answers: the seat's
// current managed binding, the canonical projection plus its applied fence, and the verdict that
// a runtime source's staged identity reached both. They live here so the two processes read the
// same state door and apply the same rules; the caller supplies the reading, the instant and the
// daemon epoch, and this module never samples a source.
import { readFileSync } from 'node:fs';
import { isSeatId, readState, type State } from '../../state.ts';
import { isPresenceBinding, readPresenceReading } from './contract.ts';
import { presencePaths } from './spool.ts';
import type { PresenceCanonicalPosition, PresenceSourceStatus } from './health.ts';
import { reconcilePresenceProof } from './health.ts';

/** The seat's managed binding in a state already read. A missing seat record or an absent
 *  binding means no continuity may be granted. */
export function presenceBindingFrom(state: State, session: string, seat: string): string | null {
  const record = state.sessions[session]?.seats?.[seat];
  return record !== undefined && isPresenceBinding(record.presence_binding)
    ? record.presence_binding
    : null;
}

/** The seat's current managed binding, read at the moment of use. A missing seat record, an
 *  absent binding or an unreadable team state means no continuity may be granted: the source's
 *  own binding is then fenced against nothing. */
export function currentPresenceBinding(stateDir: string, session: string, seat: string): string | null {
  try {
    return presenceBindingFrom(readState(stateDir), session, seat);
  } catch {
    return null;
  }
}

/** The exact canonical position for one seat: the applied projection (`current.json`) and the
 *  activity reconciler's applied fence, read together from the same state door. Both must name
 *  the same applied line; a projection the ingester wrote but activity has not fenced yet is
 *  deliberately not enough. */
export function canonicalSeatOf(
  stateDir: string,
  session: string,
  seat: string,
): { canonical: PresenceCanonicalPosition | null; why: string | null } {
  let record;
  try {
    record = readState(stateDir).sessions[session]?.seats?.[seat];
  } catch {
    return { canonical: null, why: 'the team state could not be read' };
  }
  if (record === undefined) return { canonical: null, why: 'the seat has no state record' };
  if (!isSeatId(record.id)) return { canonical: null, why: 'the seat record names no seat id' };
  if (!isPresenceBinding(record.presence_binding)) {
    return { canonical: null, why: 'the seat records no valid presence binding' };
  }
  const fence = record.presence_applied;
  if (fence === undefined) return { canonical: null, why: 'the seat records no applied presence fence' };
  if (fence.seat_id !== record.id || !isPresenceBinding(fence.binding)
    || !Number.isInteger(fence.seq) || fence.seq < 1) {
    return { canonical: null, why: 'the applied presence fence is not readable' };
  }
  const paths = presencePaths(stateDir, session, seat);
  if (paths === null) return { canonical: null, why: 'the seat cannot name a presence folder' };
  let text: string;
  try {
    text = readFileSync(paths.current, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      canonical: null,
      why: code === 'ENOENT'
        ? 'the seat has no canonical presence projection yet'
        : 'the canonical presence projection could not be read',
    };
  }
  const read = readPresenceReading(text);
  if (read.kind !== 'ok') return { canonical: null, why: read.why };
  return {
    canonical: {
      id: read.reading.id,
      binding: read.reading.binding,
      seq: read.reading.seq,
      seatId: record.id,
      fence: { seat_id: fence.seat_id, binding: fence.binding, seq: fence.seq },
    },
    why: null,
  };
}

/** One seat's reconciliation: a source reading (or the reason it could not be taken) against
 *  the canonical projection and the applied fence. A reading that answers for another seat is
 *  refused exactly as a missing one is. */
export function reconcileSeatProof(input: {
  stateDir: string;
  session: string;
  seat: string;
  /** The source's own reading, or the reason sampling it failed. */
  reading: PresenceSourceStatus | { failed: string };
  at: Date;
}): { ok: true; proof: { id: string; binding: string } } | { ok: false; why: string } {
  if ('failed' in input.reading) return { ok: false, why: input.reading.failed };
  if (input.reading.seat !== input.seat) {
    return { ok: false, why: 'the runtime source answered for another seat' };
  }
  const canonical = canonicalSeatOf(input.stateDir, input.session, input.seat);
  return reconcilePresenceProof({
    source: input.reading,
    canonical: canonical.canonical,
    canonicalWhy: canonical.why,
    currentBinding: currentPresenceBinding(input.stateDir, input.session, input.seat),
    at: input.at,
  });
}
