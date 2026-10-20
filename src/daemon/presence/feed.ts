// The read-only presence feed adapter: verified `presence.changed` records from the team bus event
// log, answered in the shape a feed consumer walks with a cursor. It reads only through
// `readEventsFromCursor` (`src/bus/log.ts`), so every record it returns verified against the
// message key and a gap is the log's own declared answer, never a guess.
//
// A presence record is accepted only whole: the payload's state must be the mapping of its own
// event, the event id must be `<event time>-<8 lowercase hex>` and embed the record's `ts`, the
// observed instant must be a contract timestamp, and the record id must be the identity the
// publisher derives from seat, binding, presence seq and event id. Any record that contradicts
// itself is dropped from the answer rather than repaired: a feed showing a guessed transition is
// worse than one that omits it. Non-presence kinds are filtered out, never surfaced here.
//
// This module is a reader only. It owns no file, appends nothing, and `src/commands/feed.ts` is
// untouched; the command-side wiring is the shared feed integration's.
import { readEventsFromCursor, type CursorReadResult } from '../../bus/log.ts';
import {
  PRESENCE_ID, PRESENCE_STATE_OF, isPresenceBinding, isPresenceEvent, isPresenceState,
  isPresenceTime, isPresenceWriterSource,
} from './contract.ts';
import { PRESENCE_PUBLISH_KIND, presenceRecordIdOf } from './publish.ts';
import { isPresenceSeatName } from './spool.ts';

export type PresenceFeedEvent = {
  /** The bus log's own sequence. */
  seq: number;
  /** The runtime event's own instant. */
  ts: string;
  session: string;
  seat: string;
  state: string;
  event: string;
  source: string;
  binding: string;
  presenceSeq: number;
  eventId: string;
  observedAt: string;
  recordId: string;
};

export type PresenceFeedResult =
  | {
      kind: 'ok';
      events: PresenceFeedEvent[];
      cursor: number;
      oldestSeq: number | null;
      newestSeq: number | null;
      /** Verified bus records whose signature did not verify; skipped, never returned. */
      unverified: number;
      /** The bus read verified the whole retained log rather than an incremental tail. */
      full: boolean;
    }
  | {
      kind: 'gap';
      oldest_seq: number;
      newest_seq: number;
      reason?: 'retention';
      dropped_oldest_seq?: number;
      dropped_newest_seq?: number;
    }
  | { kind: 'bad'; why: string };

/** One verified bus record as a feed event, or null when it contradicts the presence contract. */
function feedEventOf(payload: {
  seq: number;
  ts: string;
  session: string;
  seat?: string;
  presence_state?: string;
  presence_event?: string;
  presence_source?: string;
  presence_binding?: string;
  presence_event_id?: string;
  presence_observed_at?: string;
  presence_seq?: number;
  record_id: string;
}): PresenceFeedEvent | null {
  const { seat, presence_seq: presenceSeq, presence_event_id: eventId } = payload;
  const state = payload.presence_state;
  const event = payload.presence_event;
  const source = payload.presence_source;
  const binding = payload.presence_binding;
  if (typeof seat !== 'string' || !isPresenceSeatName(seat)) return null;
  if (!isPresenceState(state) || !isPresenceEvent(event) || !isPresenceWriterSource(source)) return null;
  if (!isPresenceBinding(binding)) return null;
  if (typeof presenceSeq !== 'number' || !Number.isInteger(presenceSeq) || presenceSeq < 1) return null;
  if (typeof eventId !== 'string' || !PRESENCE_ID.test(eventId)) return null;
  if (!isPresenceTime(payload.ts) || eventId.slice(0, -9) !== payload.ts) return null;
  if (!isPresenceTime(payload.presence_observed_at)) return null;
  // The state is the event's mapping; a hand-edited pair is refused whole.
  if (PRESENCE_STATE_OF[event] !== state) return null;
  // The record id is the publisher's derived identity; anything else is not this record's.
  if (payload.record_id !== presenceRecordIdOf(seat, { binding, seq: presenceSeq, id: eventId })) return null;
  return {
    seq: payload.seq,
    ts: payload.ts,
    session: payload.session,
    seat,
    state,
    event,
    source,
    binding,
    presenceSeq,
    eventId,
    observedAt: payload.presence_observed_at,
    recordId: payload.record_id,
  };
}

/**
 * Reads the presence feed after `after` (exclusive). Only verified `presence.changed` records are
 * returned; the bus log's cursor, retention gap and verification disclosure are passed through
 * unchanged so a follower can resync on the durable presence logs and an operator can see what
 * the read skipped.
 */
export function readPresenceFeed(
  project: string,
  root: string,
  home: string,
  options: { after?: number; kept?: number } = {},
): PresenceFeedResult {
  const after = options.after ?? 0;
  const read: CursorReadResult = readEventsFromCursor(project, root, home, after, {
    ...(options.kept === undefined ? {} : { kept: options.kept }),
  });
  if (!read.ok) return { kind: 'bad', why: read.reason };
  if (read.kind === 'gap') {
    return {
      kind: 'gap',
      oldest_seq: read.oldest_seq,
      newest_seq: read.newest_seq,
      ...(read.reason === undefined ? {} : { reason: read.reason }),
      ...(read.dropped_oldest_seq === undefined ? {} : { dropped_oldest_seq: read.dropped_oldest_seq }),
      ...(read.dropped_newest_seq === undefined ? {} : { dropped_newest_seq: read.dropped_newest_seq }),
    };
  }
  const events: PresenceFeedEvent[] = [];
  for (const record of read.events) {
    if (record.payload.kind !== PRESENCE_PUBLISH_KIND) continue;
    const event = feedEventOf(record.payload);
    if (event !== null) events.push(event);
  }
  return {
    kind: 'ok',
    events,
    cursor: read.cursor,
    oldestSeq: read.oldestSeq,
    newestSeq: read.newestSeq,
    unverified: read.unverified,
    full: read.full,
  };
}
