// The presence consumer: what the daemon-owned presence store proves about a seat, and when that
// proof is strong enough to dispatch work. The store is written by a runtime hook, an event
// adapter or the daemon's own launch record; this module only reads it. A reading is trusted only
// when the projection is current for this seat's incarnation, the canonical activity fence shows
// that exact sequence applied to the persisted clock, and the channel is known healthy. Anything
// else is unproven: the caller holds without pruning claims, writing notices or typing.
//
// `terminal-host` never appears in a record the store serves (the contract refuses it on read);
// it is a label the fallback reading carries when the native channel is explicitly absent or
// unsupported. A malformed record, an unknown event, a binding mismatch or a missing fence is
// never rescued by a screen.
import {
  PRESENCE_FUTURE_SKEW_MS,
  PRESENCE_STATE_OF,
  isPresenceBinding,
  isPresenceEvent,
  isPresenceTime,
  isPresenceWriterSource,
  presenceFutureBeyond,
  type PresenceReading,
  type PresenceWriterSource,
} from '../daemon/presence/contract.ts';
import { readPresenceCurrent } from '../daemon/presence/read.ts';
import { presencePaths } from '../daemon/presence/spool.ts';

/** The seat facts a presence verdict is taken against. `fence` is the canonical activity fence as
 *  persisted on the seat record (`presence_applied`), never a value carried by the projection. */
export type PresenceSeat = {
  seat: string;
  /** `state.seats[seat].id`, the managed seat handle. */
  seatId: string | null;
  /** `state.seats[seat].presence_binding`, the current runtime incarnation. */
  binding: string | null;
  /** `state.seats[seat].presence_applied`, validated by the verdict. */
  fence: unknown;
  /** `state.seats[seat].last_active`, the canonical claim stamp. */
  lastActive: string | undefined;
  /** Injected: the daemon's current ownership, a fixed health bound or a live RPC answer. */
  channelHealthy: boolean;
};

/** The canonical activity fence: the native transition applied to the persisted activity clock.
 *  Written by the activity reconciler, read and proved here, never written or repaired by this
 *  module. Shape is checked structurally because the state field is the reconciler's to land. */
export type ActivityFence = {
  seat_id: string;
  binding: string;
  seq: number;
  applied_at: string;
};

export type PresenceRead =
  | { kind: 'native'; reading: PresenceReading }
  /** No projection for the seat: the labelled terminal-host fallback is licensed. */
  | { kind: 'absent'; why: string }
  /** This build has no channel that can answer for the seat: the fallback is licensed. */
  | { kind: 'unsupported'; why: string }
  /** The record exists but cannot be trusted: never fallback, never an idle wake. */
  | { kind: 'invalid'; why: string };

export type PresenceVerdict =
  | { idle: true; source: PresenceWriterSource; nativeSince: string; observedAt: string }
  | {
      idle: false;
      reason: 'working' | 'waiting-for-a-person' | 'gone' | 'too-recent' | 'invalid';
      why: string;
    }
  | { idle: false; reason: 'fallback-absent' | 'fallback-unsupported'; why: string };

export type PresenceClock = { now: Date; thresholdSeconds: number };

/**
 * Reads one `current.json` per seat name, outside the synchronous report. A file that cannot be
 * read whole, or a seat/session that cannot name a presence folder, is carried as its own kind so
 * the report can tell an explicit absence from a malformed record. No channel record is read
 * here: health is injected by the caller.
 */
export async function prefetchPresence(input: {
  stateDir: string;
  session: string;
  seatNames: readonly string[];
}): Promise<ReadonlyMap<string, PresenceRead>> {
  const reads = new Map<string, PresenceRead>();
  for (const seat of input.seatNames) {
    if (presencePaths(input.stateDir, input.session, seat) === null) {
      reads.set(seat, { kind: 'unsupported', why: 'the session or seat cannot name a presence folder' });
      continue;
    }
    const read = await readPresenceCurrent(input.stateDir, input.session, seat);
    if (read.kind === 'ok') {
      reads.set(seat, { kind: 'native', reading: read.value });
    } else if (read.kind === 'absent') {
      reads.set(seat, { kind: 'absent', why: 'the seat has no current presence projection' });
    } else {
      reads.set(seat, { kind: 'invalid', why: read.why });
    }
  }
  return reads;
}

/** The persisted canonical fence, read structurally: the field belongs to the reconciler that
 *  writes it, so a state record without it is simply unfenced. */
export function fenceAt(record: unknown): unknown {
  if (record === null || typeof record !== 'object') return undefined;
  return (record as { presence_applied?: unknown }).presence_applied;
}

function invalid(why: string): PresenceVerdict {
  return { idle: false, reason: 'invalid', why };
}

function parseFence(value: unknown): ActivityFence | string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'the canonical activity fence is absent on the seat record';
  }
  const fence = value as Record<string, unknown>;
  if (typeof fence.seat_id !== 'string' || fence.seat_id === '') {
    return 'the canonical activity fence names no seat id';
  }
  if (!isPresenceBinding(fence.binding)) {
    return 'the canonical activity fence binding is not prs_<12 lowercase hex>';
  }
  if (typeof fence.seq !== 'number' || !Number.isInteger(fence.seq) || fence.seq < 1) {
    return 'the canonical activity fence seq is not a positive integer';
  }
  if (!isPresenceTime(fence.applied_at)) {
    return 'the canonical activity fence applied_at is not a UTC instant';
  }
  return { seat_id: fence.seat_id, binding: fence.binding, seq: fence.seq, applied_at: fence.applied_at };
}

/**
 * The proof. A native reading is current only for the seat's own incarnation, with the exact
 * projection sequence applied to the canonical activity clock, on a healthy channel, and with
 * timestamps that are not in the future. A record from a predecessor binding, a stale or
 * unapplied fence, a missing managed identity or an unreadable channel is `invalid` and must
 * hold the dispatcher. `observedAt` is an ingest instant, not a heartbeat: old age alone never
 * expires a state.
 */
export function presenceVerdict(read: PresenceRead, seat: PresenceSeat, clock: PresenceClock): PresenceVerdict {
  if (read.kind === 'absent') return { idle: false, reason: 'fallback-absent', why: read.why };
  if (read.kind === 'unsupported') return { idle: false, reason: 'fallback-unsupported', why: read.why };
  if (read.kind === 'invalid') return invalid(read.why);

  const reading = read.reading;
  const now = clock.now.getTime();
  // The committed reader already refuses these, and the consumer re-proves them so a record that
  // reached it another way cannot be served: only a writer source, a published event, and the
  // one event→state mapping the contract names.
  if (!isPresenceWriterSource(reading.source)) {
    return invalid('the native reading carries a source no runtime writes');
  }
  if (!isPresenceEvent(reading.event)) {
    return invalid('the native reading names no contract event');
  }
  if (PRESENCE_STATE_OF[reading.event] !== reading.state) {
    return invalid('the native reading state does not match its event');
  }
  if (!isPresenceBinding(seat.binding)) {
    return invalid('the seat has no current runtime binding, so the projection cannot be shown current');
  }
  if (reading.binding !== seat.binding) {
    return invalid('the projection was emitted by a predecessor runtime binding');
  }
  if (seat.seatId === null || seat.seatId === '') {
    return invalid('the seat has no managed identity, so its presence cannot be fenced');
  }
  const fence = parseFence(seat.fence);
  if (typeof fence === 'string') return invalid(fence);
  if (fence.seat_id !== seat.seatId) {
    return invalid('the canonical activity fence names another managed seat');
  }
  if (fence.binding !== reading.binding) {
    return invalid('the canonical activity fence was applied on another incarnation');
  }
  if (fence.seq !== reading.seq) {
    return invalid(
      `the canonical activity fence is at seq ${fence.seq} while the projection carries seq ${reading.seq}`,
    );
  }
  if (presenceFutureBeyond(fence.applied_at, clock.now)) {
    return invalid('the canonical activity fence applied_at is in the future');
  }
  if (!seat.channelHealthy) {
    return invalid('the presence channel is not known healthy this pass');
  }
  if (presenceFutureBeyond(reading.observedAt, clock.now)) {
    return invalid('the projection observedAt is in the future');
  }
  if (presenceFutureBeyond(reading.since, clock.now)) {
    return invalid('the projection since is in the future');
  }
  if (Date.parse(reading.since) - Date.parse(reading.observedAt) > PRESENCE_FUTURE_SKEW_MS) {
    return invalid('the projection since is later than its own ingest instant');
  }
  // The id embeds the winning event's instant (`<ts>-<8 hex>`). The committed reader does not
  // check that agreement yet (B4's followup); a mismatch is refused here either way, because a
  // projection whose state began at one instant and claims another is not a coherent reading.
  if (reading.id.slice(0, -9) !== reading.since) {
    return invalid('the projection since disagrees with the event instant in its id');
  }
  const parsedLastActive = seat.lastActive === undefined ? Number.NaN : Date.parse(seat.lastActive);
  const lastActive = Number.isFinite(parsedLastActive) ? parsedLastActive : null;
  if (lastActive !== null && lastActive - now > PRESENCE_FUTURE_SKEW_MS) {
    return invalid('the persisted activity stamp is in the future');
  }
  // A waiting or gone transition advances the fence but not the activity clock: those states are
  // known non-idle without a newer canonical stamp. Only idle eligibility needs both clocks.
  if (reading.state === 'working') {
    return { idle: false, reason: 'working', why: 'the runtime reports a turn running' };
  }
  if (reading.state === 'waiting-for-a-person') {
    return { idle: false, reason: 'waiting-for-a-person', why: 'the runtime waits for a person' };
  }
  if (reading.state === 'gone') {
    return { idle: false, reason: 'gone', why: 'the runtime session ended' };
  }
  if (lastActive === null) {
    return invalid('the seat has no parseable persisted activity stamp for this incarnation');
  }
  if (lastActive < Date.parse(reading.since) - PRESENCE_FUTURE_SKEW_MS) {
    return invalid('the persisted activity stamp predates the transition the projection carries');
  }
  const window = clock.thresholdSeconds * 1000;
  if (now - lastActive < window || now - Date.parse(reading.since) < window) {
    return {
      idle: false,
      reason: 'too-recent',
      why: 'the idle window has not elapsed on both the persisted and native clocks',
    };
  }
  return { idle: true, source: reading.source, nativeSince: reading.since, observedAt: reading.observedAt };
}
