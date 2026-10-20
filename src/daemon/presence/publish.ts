// The daemon's presence publisher: the one writer that copies applied, current-binding presence
// transitions from a seat's durable log to the team bus event log.
//
// Two logs, two owners. The per-seat `events.jsonl` (written by the presence ingester) stays the
// durable source; the bus event log is the publication target every bus reader and feed already
// verifies. This module never opens the bus log, its rotation or its retention directly: every
// append goes through `appendEvent` (`src/bus/log.ts`), under the route's canonical root, with
// deduplication on. The record id is deterministic from the seat, the binding, the presence log
// sequence and the runtime event id, so a replay after a daemon restart answers `duplicate: true`
// for every transition the bus log still retains.
//
// The cursor is in memory only, per seat; there is no new durable publisher state. On a daemon's
// first pass it is `(0, 0)`, so the durable log is replayed from its beginning and stable ids
// dedupe the history the bus log kept. A batch's cursor commits only after every line in it was
// published, answered duplicate, or skipped as a non-applied or predecessor-binding line. If an
// append fails, the cursor holds before that batch and the next attempt after a backoff re-reads
// it; the lines already published answer duplicate, so nothing is lost and no success is
// invented. The daemon's own 250 ms presence pass performs the retry: this module starts no timer
// and keeps no queue.
//
// Honest crash window: the presence line is durable before publication. A crash or a write failure
// between the two leaves that transition unpublished until a later pass or daemon run re-reads the
// durable log. No stronger exactly-once claim is made than replay dedupe proves.
//
// The current managed binding is re-read from the state record immediately before every append and
// again before a cursor advance, never only before the awaited log read: a binding that changes
// while the read is in flight turns the older binding's applied lines into old lines, which are
// skipped rather than published as the successor's. Publication failure is reported in the step
// result and logged by the host; it is never folded into the native channel's health.
import { readdir } from 'node:fs/promises';
import { appendEvent, type EventAppendInput } from '../../bus/log.ts';
import { readState, type SeatState } from '../../state.ts';
import { isPresenceBinding, type PresenceLogLine } from './contract.ts';
import { readPresenceTransitions } from './read.ts';
import { isPresenceSeatName, presenceSessionDir } from './spool.ts';

/** The closed-table kind one published transition carries. */
export const PRESENCE_PUBLISH_KIND = 'presence.changed' as const;

/** The failure backoff; the existing presence pass retries the seat after it, no new timer. */
export const PRESENCE_PUBLISH_RETRY_MS = 5_000;

export type PresencePublisherInput = {
  /** The team file's folder (today `.agents`), never the checkout root. */
  stateDir: string;
  session: string;
  /** The route team file's project name and canonical root: the bus log's store path is keyed by
   *  both, so the publisher must use exactly the route's own. */
  project: string;
  root: string;
  home: string;
  /** Test seam: publish exactly these seats instead of the presence session folder's seat
   *  folders. */
  seats?: readonly string[];
  maxRecords?: number;
  maxBytes?: number;
  retryMs?: number;
};

export type PresencePublishSeat = {
  seat: string;
  /** Transitions the bounded reader returned this call. */
  read: number;
  /** Applied current-binding lines newly appended this call. */
  published: number;
  /** Applied current-binding lines the bus log already held (a replay or a retried batch). */
  duplicate: number;
  /** Lines read and consumed without publishing: not applied, another binding, another session. */
  skipped: number;
  /** The committed presence seq after the call. */
  cursor: number;
  /** The last append's refusal; the cursor holds before that batch. */
  failure: string | null;
  /** When the next attempt may run after a failure, or null. */
  retryAt: number | null;
  /** The seat's durable log could not be read; the cursor stands. */
  bad: string | null;
};

export type PresencePublishResult = {
  seats: PresencePublishSeat[];
  /** The presence seat folders could not be listed. */
  failed: string | null;
};

export type PresencePublisherStep = (at: Date) => Promise<PresencePublishResult>;

type Cursor = { seq: number; offset: number; retryAt: number };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** The seat folders that hold presence state, the same enumeration the activity reconciler uses.
 *  A missing session folder is no seats, not an error: presence starts with the first spool. */
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

/** Whether `next` is forward of `stored` in the log. Equal pairs are the same position. */
function forwardOf(next: { seq: number; offset: number }, stored: Cursor): boolean {
  return next.seq > stored.seq || (next.seq === stored.seq && next.offset > stored.offset);
}

/** The identity one transition publishes under. Deterministic by construction, so a replay of the
 *  same durable line dedupes in the bus log. */
export function presenceRecordIdOf(seat: string, line: Pick<PresenceLogLine, 'binding' | 'seq' | 'id'>): string {
  return `presence:${seat}:${line.binding}:${String(line.seq)}:${line.id}`;
}

function eventInputOf(seat: string, session: string, line: PresenceLogLine): EventAppendInput {
  return {
    ts: line.ts,
    kind: PRESENCE_PUBLISH_KIND,
    session,
    record_id: presenceRecordIdOf(seat, line),
    seat,
    presence_state: line.state,
    presence_event: line.event,
    presence_source: line.source,
    presence_binding: line.binding,
    presence_event_id: line.id,
    presence_observed_at: line.observedAt,
    presence_seq: line.seq,
  };
}

type BindingRead =
  | { kind: 'ok'; binding: string | null }
  | { kind: 'bad'; why: string };

function noPublish(seat: string, cursor: Cursor, overrides: Partial<PresencePublishSeat> = {}): PresencePublishSeat {
  return {
    seat,
    read: 0,
    published: 0,
    duplicate: 0,
    skipped: 0,
    cursor: cursor.seq,
    failure: null,
    retryAt: cursor.retryAt === 0 ? null : cursor.retryAt,
    bad: null,
    ...overrides,
  };
}

/**
 * Builds one route's presence publisher. The daemon's presence pass calls `step` after the
 * ingester appended and the activity reconciler consumed; each call reads at most the reader's
 * bound per seat and performs synchronous bus appends. A seat's failure never holds another
 * seat's pass.
 */
export function createPresencePublisher(input: PresencePublisherInput): PresencePublisherStep {
  const stateDir = input.stateDir;
  const session = input.session;
  const retryMs = input.retryMs ?? PRESENCE_PUBLISH_RETRY_MS;
  const cursors = new Map<string, Cursor>();

  /** The seat's current managed binding, read at the moment of use. A missing seat record or an
   *  absent binding means nothing may be published for that seat: its older lines stay in the
   *  durable log. */
  const currentBindingOf = (seat: string): BindingRead => {
    let record: SeatState | undefined;
    try {
      record = readState(stateDir).sessions[session]?.seats?.[seat];
    } catch (error) {
      return { kind: 'bad', why: messageOf(error) };
    }
    if (record === undefined) return { kind: 'ok', binding: null };
    return { kind: 'ok', binding: isPresenceBinding(record.presence_binding) ? record.presence_binding : null };
  };

  return async function step(at: Date): Promise<PresencePublishResult> {
    let seats: string[];
    if (input.seats !== undefined) {
      seats = [...input.seats];
    } else {
      const found = await seatsUnder(stateDir, session);
      if (!Array.isArray(found)) return { seats: [], failed: found.bad };
      seats = found;
    }

    const reported: PresencePublishSeat[] = [];
    for (const seat of seats) {
      const cursor = cursors.get(seat) ?? { seq: 0, offset: 0, retryAt: 0 };
      if (at.getTime() < cursor.retryAt) {
        reported.push(noPublish(seat, cursor));
        continue;
      }
      const read = await readPresenceTransitions({
        stateDir,
        session,
        seat,
        afterSeq: cursor.seq,
        afterOffset: cursor.offset,
        ...(input.maxRecords === undefined ? {} : { maxRecords: input.maxRecords }),
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
      });
      if (read.kind === 'bad') {
        reported.push(noPublish(seat, cursor, { bad: read.why }));
        continue;
      }

      let published = 0;
      let duplicate = 0;
      let skipped = 0;
      let failure: string | null = null;
      for (const line of read.transitions) {
        if (!line.applied || line.session !== session) {
          skipped += 1;
          continue;
        }
        // Immediately before the append, not only before the awaited read: the binding may have
        // changed while the batch was read. An old line is consumed as a skip, never published as
        // the successor's transition.
        const current = currentBindingOf(seat);
        if (current.kind === 'bad') {
          failure = current.why;
          break;
        }
        if (current.binding === null || line.binding !== current.binding) {
          skipped += 1;
          continue;
        }
        const appended = appendEvent(input.project, input.root, input.home, eventInputOf(seat, session, line), {
          deduplicate: true,
        });
        if (!appended.ok) {
          failure = appended.reason;
          break;
        }
        if (appended.duplicate) duplicate += 1;
        else published += 1;
      }

      if (failure === null) {
        // The same recheck gates the cursor advance: a state record that cannot be read now holds
        // the batch, so its lines are re-read rather than consumed on an unknown binding.
        const current = currentBindingOf(seat);
        if (current.kind === 'bad') failure = current.why;
      }
      if (failure !== null) {
        cursor.retryAt = at.getTime() + retryMs;
        cursors.set(seat, cursor);
        reported.push(noPublish(seat, cursor, {
          read: read.transitions.length,
          published,
          duplicate,
          skipped,
          failure,
        }));
        continue;
      }
      if (forwardOf({ seq: read.nextSeq, offset: read.nextOffset }, cursor)) {
        cursor.seq = read.nextSeq;
        cursor.offset = read.nextOffset;
      }
      cursor.retryAt = 0;
      cursors.set(seat, cursor);
      reported.push(noPublish(seat, cursor, {
        read: read.transitions.length,
        published,
        duplicate,
        skipped,
      }));
    }
    return { seats: reported, failed: null };
  };
}
