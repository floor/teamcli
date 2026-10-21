// The daemon's presence activity reconciler: the one writer that turns the ingester's sequenced
// transitions into the canonical activity clock an idle claim compares.
//
// Two clocks stay separate. The projection (`current.json`) is what a runtime last reported; the
// transition feed is every applied line, in order. The canonical clock is the persisted
// `state.seats[seat].last_active` that `captureIdleClaim` compares for equality. Only this module
// moves that clock from presence, and only forward: an applied `turn-start` or `turn-end` line of
// the seat's current runtime binding stamps the event's own instant when it is newer than the
// stored value. Nothing stamps on repeated observation, on a replay, on a `human-wait` or
// `session-end` line, or on a predecessor incarnation's line. A new fence field alone would leave
// an old claim's exact `last_active` untouched and therefore permanently spendable, so the clock
// itself moves.
//
// The applied fence (`presence_applied`) names the newest applied current-binding line this
// writer reconciled: `seat_id`, `binding`, `seq` and the writer's `applied_at`. A consumer requires
// it to equal the current projection exactly; a fence that is ahead or behind holds. A
// `waiting-for-a-person` or `gone` line moves the fence without moving the clock: the state is
// known, the seat simply did no work.
//
// The scan cursor (`presence_scan`) is the reader's resume point, persisted separately from the
// fence. It advances over every line read, applied or not, current binding or not, so a line that
// never became the projection cannot hold the reader on it forever.
//
// Every apply is one `updateState` with `waitMs: 0`: a busy state file writes nothing this beat and
// the same batch is read again on the next. The batch per call is the reader's own bound (records
// and bytes), so a long log is caught up over several beats, never in one pass.
import { readdir } from 'node:fs/promises';
import { LockBusyError, isSeatId, readState, updateState, type SeatState } from '../../state.ts';
import { isPresenceBinding, type PresenceLogLine } from './contract.ts';
import { readPresenceTransitions } from './read.ts';
import { isPresenceSeatName, presenceSessionDir } from './spool.ts';

/** The events that prove the seat did work. The other two move the fence, never the clock. */
export const PRESENCE_ACTIVITY_EVENTS = ['turn-start', 'turn-end'] as const;

export type PresenceActivityInput = {
  /** The team file's folder (today `.agents`), never the checkout root. */
  stateDir: string;
  session: string;
  /** Test seam: read exactly these seats instead of the presence session folder's seat folders. */
  seats?: readonly string[];
  maxRecords?: number;
  maxBytes?: number;
};

export type PresenceActivitySeat = {
  seat: string;
  /** Transitions the reader returned this call. */
  read: number;
  /** Of those, applied lines of the current binding this writer reconciled. */
  reconciled: number;
  /** The event instant `last_active` moved to, when it moved. */
  stamped: string | null;
  /** The applied fence's seq after the call, or null when the seat has none. */
  fence: number | null;
  /** The scan cursor's seq after the call. */
  cursor: number;
  /** The state lock was held: nothing was applied and nothing was written. */
  busy: boolean;
  /** The seat's transition log could not be read; its cursor and canonical state stand. */
  bad: string | null;
};

export type PresenceActivityResult = {
  seats: PresenceActivitySeat[];
  /** The state file could not be read or written; no presence apply happened. */
  failed: string | null;
};

export type PresenceActivityStep = (at: Date) => Promise<PresenceActivityResult>;

type ScanCursor = { binding: string | null; seq: number; offset: number };

type PendingSeat = {
  seat: string;
  base: ScanCursor;
  transitions: PresenceLogLine[];
  nextSeq: number;
  nextOffset: number;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function cursorOf(seat: SeatState | undefined): ScanCursor {
  const scan = seat?.presence_scan;
  if (scan === undefined || scan === null || typeof scan !== 'object') {
    return { binding: null, seq: 0, offset: 0 };
  }
  return {
    binding: isPresenceBinding(scan.binding) ? scan.binding : null,
    seq: Number.isInteger(scan.seq) && scan.seq >= 0 ? scan.seq : 0,
    offset: Number.isInteger(scan.offset) && scan.offset >= 0 ? scan.offset : 0,
  };
}

/** Whether `next` is forward of `stored` in the log. Equal pairs are the same position. */
function forwardOf(next: { seq: number; offset: number }, stored: ScanCursor): boolean {
  return next.seq > stored.seq || (next.seq === stored.seq && next.offset > stored.offset);
}

/** The seat folders that actually hold presence state. A missing session folder is no seats, not
 *  an error: presence starts with the first valid spool. */
async function seatsUnder(stateDir: string, session: string): Promise<string[] | { bad: string }> {
  const folder = presenceSessionDir(stateDir, session);
  if (folder === null) return [];
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return [];
    return { bad: `the presence session folder could not be read: ${messageOf(error)}` };
  }
  return entries
    .filter((entry) => entry.isDirectory() && isPresenceSeatName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function unchanged(seat: string, base: ScanCursor, overrides: Partial<PresenceActivitySeat> = {}): PresenceActivitySeat {
  return {
    seat,
    read: 0,
    reconciled: 0,
    stamped: null,
    fence: null,
    cursor: base.seq,
    busy: false,
    bad: null,
    ...overrides,
  };
}

/**
 * Builds one route's activity reconciler. It reads the canonical state and the transition log,
 * both asynchronous and bounded, then applies every seat's batch in one locked write. The
 * write itself is the existing synchronous state read-modify-write under the zero-wait lock:
 * the same limit every other state writer has. A call with nothing new
 * writes nothing.
 */
export function createPresenceActivity(input: PresenceActivityInput): PresenceActivityStep {
  const stateDir = input.stateDir;
  const session = input.session;

  return async function step(at: Date): Promise<PresenceActivityResult> {
    let state;
    try {
      state = readState(stateDir);
    } catch (error) {
      return { seats: [], failed: messageOf(error) };
    }
    let seats: string[];
    if (input.seats !== undefined) {
      seats = [...input.seats];
    } else {
      const found = await seatsUnder(stateDir, session);
      if (!Array.isArray(found)) return { seats: [], failed: found.bad };
      seats = found;
    }

    const reported: PresenceActivitySeat[] = [];
    const pending: PendingSeat[] = [];
    for (const seat of seats) {
      const base = cursorOf(state.sessions[session]?.seats?.[seat]);
      const read = await readPresenceTransitions({
        stateDir,
        session,
        seat,
        afterSeq: base.seq,
        afterOffset: base.offset,
        ...(input.maxRecords === undefined ? {} : { maxRecords: input.maxRecords }),
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
      });
      if (read.kind === 'bad') {
        reported.push(unchanged(seat, base, { bad: read.why }));
        continue;
      }
      pending.push({
        seat,
        base,
        transitions: read.transitions,
        nextSeq: read.nextSeq,
        nextOffset: read.nextOffset,
      });
    }
    if (pending.length === 0) return { seats: reported, failed: null };

    try {
      const applied = updateState(stateDir, (locked) => {
        const results: PresenceActivitySeat[] = [];
        let changed = false;
        for (const one of pending) {
          const seatState = locked.sessions[session]?.seats?.[one.seat];
          if (seatState === undefined) {
            // Only an existing seat record is reconciled: presence never creates a seat.
            results.push(unchanged(one.seat, one.base));
            continue;
          }
          const stored = cursorOf(seatState);
          if (stored.seq > one.base.seq || (stored.seq === one.base.seq && stored.offset > one.base.offset)) {
            // A later write already consumed this batch; the next beat reads past it.
            results.push(unchanged(one.seat, stored));
            continue;
          }
          let stamped: string | null = null;
          let fence: number | null = null;
          let reconciled = 0;
          for (const line of one.transitions) {
            if (!line.applied) continue;
            const binding = seatState.presence_binding;
            if (!isPresenceBinding(binding) || line.binding !== binding) continue;
            reconciled += 1;
            if (line.event === 'turn-start' || line.event === 'turn-end') {
              const eventAt = Date.parse(line.ts);
              const current = seatState.last_active === undefined ? Number.NaN : Date.parse(seatState.last_active);
              if (!Number.isFinite(current) || eventAt > current) {
                seatState.last_active = line.ts;
                stamped = line.ts;
              }
            }
            if (isSeatId(seatState.id)) {
              seatState.presence_applied = {
                seat_id: seatState.id,
                binding: line.binding,
                seq: line.seq,
                applied_at: at.toISOString(),
              };
              fence = line.seq;
            }
          }
          let cursor = stored.seq;
          let cursorChanged = false;
          if (forwardOf({ seq: one.nextSeq, offset: one.nextOffset }, stored)) {
            seatState.presence_scan = {
              binding: isPresenceBinding(seatState.presence_binding) ? seatState.presence_binding : null,
              seq: one.nextSeq,
              offset: one.nextOffset,
            };
            cursor = one.nextSeq;
            cursorChanged = true;
          }
          if (stamped !== null || reconciled > 0 || cursorChanged) changed = true;
          results.push({
            seat: one.seat,
            read: one.transitions.length,
            reconciled,
            stamped,
            fence: fence ?? seatState.presence_applied?.seq ?? null,
            cursor,
            busy: false,
            bad: null,
          });
        }
        return { results, changed };
      }, { waitMs: 0, writeWhen: (result) => result.changed });
      return { seats: [...reported, ...applied.results], failed: null };
    } catch (error) {
      if (error instanceof LockBusyError) {
        return {
          seats: [
            ...reported,
            ...pending.map((one) => unchanged(one.seat, one.base, { read: one.transitions.length, busy: true })),
          ],
          failed: null,
        };
      }
      return { seats: reported, failed: messageOf(error) };
    }
  };
}
