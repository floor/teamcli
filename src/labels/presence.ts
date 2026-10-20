// The display's read of the daemon's presence projection. The daemon owns the log and the
// atomic `current.json`; this module asks one question per seat at display time: does a
// projection exist, what does it say, and is it qualified as live?
//
// Live is the contract's own test (`presenceLive`): the projection's binding must be the one the
// seat's state records, and the route's presence channel must be healthy by a *fresh* answer
// from the daemon that owns it — never the persisted `status.json` word, which can outlive the
// channel it describes. A projection that exists under this incarnation but is not live is
// still the runtime's last known word, and the display keeps showing it. A projection the
// seat's recorded binding does not fence to *this* incarnation — missing, malformed, or a
// predecessor's — is invalid: it is an existing projection, never genuine absence, so no screen
// answers in its place and the caller shows unknown from presence. Only a genuinely absent
// projection lets the labelled terminal-host screen answer.
import { readFileSync } from 'node:fs';
import {
  isPresenceBinding,
  presenceLive,
  readPresenceReading,
} from '../daemon/presence/contract.ts';
import { presencePaths } from '../daemon/presence/spool.ts';
import { PRESENCE_HEALTH_GRACE_MS } from '../daemon/presence/health.ts';
import type { PresenceObservation } from './state.ts';

export type PresenceProjectionRead =
  | { kind: 'absent' }
  /** A projection exists, but the seat's recorded binding cannot fence it to this runtime
   *  incarnation: it is invalid as this seat's reading, and no screen answers in its place. */
  | { kind: 'invalid'; why: string }
  | { kind: 'bad'; why: string }
  | { kind: 'ok'; observation: PresenceObservation };

/** The projection file is the reading, even when it is not live — but only under the binding the
 *  seat's state records. Absent is the one case that permits a terminal-host fallback; an
 *  existing projection this incarnation cannot claim is invalid, never absence. */
export function readPresenceForSeat(
  stateDir: string,
  session: string,
  seat: string,
  binding: unknown,
  channelHealthy: boolean,
): PresenceProjectionRead {
  const paths = presencePaths(stateDir, session, seat);
  if (paths === null) return { kind: 'absent' };
  let text: string;
  try {
    text = readFileSync(paths.current, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'bad', why: 'the presence projection could not be read' };
  }
  const read = readPresenceReading(text);
  if (read.kind !== 'ok') return { kind: 'bad', why: read.why };
  // The fence: a session and seat are reused across launches, so a projection a predecessor
  // wrote, or one the state cannot fence at all, is not this seat's reading, however fresh it
  // is. It is an existing projection, not absence: no screen may answer in its place.
  if (!isPresenceBinding(binding)) {
    return { kind: 'invalid', why: 'the seat records no runtime binding to fence the projection' };
  }
  if (read.reading.binding !== binding) {
    return { kind: 'invalid', why: 'the projection belongs to another runtime incarnation' };
  }
  return {
    kind: 'ok',
    observation: {
      state: read.reading.state,
      source: read.reading.source,
      event: read.reading.event,
      since: read.reading.since,
      live: presenceLive(read.reading, binding, channelHealthy),
    },
  };
}

/**
 * A route's presence verdict inside the daemon health answer (the frozen read-only shape):
 * `checkedAt` is the snapshot's own request instant, and the verdict describes the daemon's
 * in-memory route, never a persisted record. A route the daemon does not host has none.
 * A persisted close record (`state: 'pending'` with no `healthy`) also lands under `presence`
 * on the state root; reading the fields defensively is what keeps it from ever being proof.
 */
export type PresenceRouteVerdict = {
  session?: unknown;
  state?: unknown;
  healthy?: unknown;
  checkedAt?: unknown;
  why?: unknown;
  /** The route's fresh per-seat runtime answers; absent on a hook-only route. */
  seats?: unknown;
};

export type PresenceHealthRoot = {
  root: string;
  presence?: PresenceRouteVerdict;
};

/** The part of the daemon health reading qualification needs: the roots it carried and the
 *  probe that produced them. A refused, unanswered or unknown probe proves nothing. */
export type PresenceHealthReading = {
  roots: readonly PresenceHealthRoot[];
  probe: { state: string; at: string };
};

/**
 * How far a route's `checkedAt`, and the probe answer that carried it, may sit from the display's
 * own instant. It is the daemon's shared bound, imported from src/daemon/presence/health.ts —
 * the same window a finished presence step vouches for its channel. An answer outside it is an
 * earlier probe's snapshot, never proof of live now.
 */
export { PRESENCE_HEALTH_GRACE_MS };

/** One fresh per-seat answer, held to the daemon client's strict reading: `serving` with
 *  `healthy: true` is the only proof, and a serving seat names the binding it was sampled for. */
export type PresenceSeatHealth = {
  healthy: boolean;
  /** The current managed binding at the sample; a serving entry always names one. */
  binding: string | null;
};

export type PresenceSeatsRead =
  /** The route carries no seat list: a hook-only route, whose own verdict is the answer. */
  | { kind: 'absent' }
  /** The seat list is malformed, or the route verdict that carried it is not fresh: no seat
   *  in it may be called live, and the route's own health is not proof either. */
  | { kind: 'invalid'; why: string }
  | { kind: 'listed'; seats: ReadonlyMap<string, PresenceSeatHealth> };

/**
 * The strict client-side reading of a route's `seats`: one entry per seat, no repeats, a
 * closed state word, `healthy` exactly when serving, a valid binding or null, and a pending
 * entry that says what it waits for. Anything else is dropped whole, never partly served.
 */
function seatsOf(verdict: PresenceRouteVerdict): PresenceSeatsRead {
  const raw = verdict.seats;
  if (raw === undefined) return { kind: 'absent' };
  if (!Array.isArray(raw) || raw.length === 0) {
    return { kind: 'invalid', why: 'the seat list is not a non-empty list' };
  }
  const seats = new Map<string, PresenceSeatHealth>();
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { kind: 'invalid', why: 'a seat entry is not an object' };
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.seat !== 'string' || entry.seat === '' || seats.has(entry.seat)) {
      return { kind: 'invalid', why: 'a seat entry does not name one unique seat' };
    }
    if (entry.state !== 'serving' && entry.state !== 'pending') {
      return { kind: 'invalid', why: 'a seat entry names no known state' };
    }
    if (typeof entry.healthy !== 'boolean') {
      return { kind: 'invalid', why: 'a seat entry healthy flag is not a boolean' };
    }
    if ((entry.state === 'serving') !== entry.healthy) {
      return { kind: 'invalid', why: 'a seat entry state and healthy flag disagree' };
    }
    if (!(entry.binding === null || isPresenceBinding(entry.binding))) {
      return { kind: 'invalid', why: 'a seat entry carries no valid binding' };
    }
    if (!(entry.why === null || typeof entry.why === 'string')) {
      return { kind: 'invalid', why: 'a seat entry why is not text or null' };
    }
    if (entry.state === 'pending' && (typeof entry.why !== 'string' || entry.why === '')) {
      return { kind: 'invalid', why: 'a pending seat entry says nothing about what it waits for' };
    }
    if (entry.state === 'serving' && entry.binding === null) {
      return { kind: 'invalid', why: 'a serving seat entry names no binding' };
    }
    seats.set(entry.seat, {
      healthy: entry.healthy,
      binding: entry.binding as string | null,
    });
  }
  return { kind: 'listed', seats };
}

/** The route's per-seat answers when its verdict is fresh and serving; every other answer is
 *  invalid for qualification. A hook-only route (no `seats`) stays `absent`. */
export function presenceSeatsOf(
  reading: PresenceHealthReading,
  root: string,
  session: string,
  now: Date,
): PresenceSeatsRead {
  if (!presenceChannelHealthy(reading, root, session, now)) {
    return { kind: 'invalid', why: 'the route verdict is not fresh and serving for this session' };
  }
  const verdict = reading.roots.find((entry) => entry.root === root)?.presence;
  if (verdict === undefined) return { kind: 'invalid', why: 'the route carries no presence verdict' };
  return seatsOf(verdict);
}

/**
 * Whether one seat's projection may be called live. The route must be fresh and serving, and
 * when the route carries per-seat answers this seat must be listed serving with exactly the
 * binding the seat's state records — a missing entry and a mismatched sampled binding are both
 * last known, never live by route health alone.
 *
 * The list is the daemon's native-source answers, not a census of every seat on the route: a
 * hook seat sharing the route with a native sibling is expected to be absent, and keeps the
 * route verdict. An absent list is only informative for a seat that does not expect a native
 * channel: a seat that does (`nativeExpected`) is held whether the whole list is missing or
 * only its entry — in both cases the source it expected was never classified, and there is no
 * proof to inherit. The expectation is conservative: the daemon's own policy and target
 * classification are authoritative, and an entry the daemon lists always decides over it.
 */
export function seatPresenceQualified(
  seats: PresenceSeatsRead | undefined,
  seat: string,
  binding: unknown,
  nativeExpected: boolean,
): boolean {
  if (seats === undefined || seats.kind === 'absent') return !nativeExpected;
  if (seats.kind === 'invalid') return false;
  const entry = seats.seats.get(seat);
  if (entry === undefined) return !nativeExpected;
  if (!entry.healthy) return false;
  return isPresenceBinding(binding) && entry.binding === binding;
}

/**
 * The CLIs whose presence this product samples from a managed native source. That explicit
 * classification, from the seat's own declaration, is what makes an absent seat-list entry
 * mean "expected and unproven" rather than "hook seat": the seat list itself never tells a
 * hook seat apart from a native source the daemon failed to classify. Codex is the only one
 * today; a new native runtime adds its name here, beside its source.
 */
export function nativePresenceExpected(cli: string | null | undefined): boolean {
  return cli === 'codex';
}

/**
 * Whether the display may mark this session's projections live. The answer is the fresh daemon
 * health snapshot's per-route verdict — only `serving` and `healthy` with the same session count,
 * and only when both its `checkedAt` and the probe answer that carried it belong to the display's
 * own instant, within the shared grace. A pending route, a route the daemon is not hosting, a
 * malformed or stale record and a snapshot from an earlier probe all leave the display at last
 * known. Default closed: a health answer without a verdict proves nothing.
 */
export function presenceChannelHealthy(
  reading: PresenceHealthReading,
  root: string,
  session: string,
  now: Date,
): boolean {
  if (reading.probe.state !== 'answered') return false;
  const verdict = reading.roots.find((entry) => entry.root === root)?.presence;
  if (verdict === undefined) return false;
  if (verdict.state !== 'serving' || verdict.healthy !== true) return false;
  if (verdict.session !== session) return false;
  if (typeof verdict.checkedAt !== 'string') return false;
  const checkedAt = Date.parse(verdict.checkedAt);
  const answeredAt = Date.parse(reading.probe.at);
  const at = now.getTime();
  if (!Number.isFinite(checkedAt) || !Number.isFinite(answeredAt) || !Number.isFinite(at)) return false;
  // Both instants must be this display's own: an old probe's answer is a snapshot, never proof.
  if (Math.abs(at - answeredAt) > PRESENCE_HEALTH_GRACE_MS) return false;
  if (Math.abs(at - checkedAt) > PRESENCE_HEALTH_GRACE_MS) return false;
  // A route that carries a malformed seat list is not a trustworthy record: the daemon client
  // drops it whole, and so does the display.
  return seatsOf(verdict).kind !== 'invalid';
}


