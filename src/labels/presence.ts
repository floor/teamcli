// The display's read of the daemon's presence projection. The daemon owns the log and the
// atomic `current.json`; this module asks one question per seat at display time: does a
// projection exist, what does it say, and is it qualified as live?
//
// Live is the contract's own test (`presenceLive`): the projection's binding must be the one the
// seat's state records, and the route's presence channel must be healthy by a *fresh* answer
// from the daemon that owns it — never the persisted `status.json` word, which can outlive the
// channel it describes. The fresh answer lists every declared seat with an explicit source class:
// a `runtime` seat claims its sampled channel and names the exact applied transition it vouches
// for, and the projection's own id must be exactly it — a projection ahead of the proof, or one
// the proof does not name, stays last known. A `hook` seat claims the route's ingest answer and
// names no transition; an `unknown` seat (classification itself failed) never serves. A list that
// is missing, repeated, empty or malformed is an incomplete answer, and no seat in it is live. A
// projection that exists under this incarnation but is not live is
// still the runtime's last known word, and the display keeps showing it. A projection the
// seat's recorded binding does not fence to *this* incarnation — missing, malformed, or a
// predecessor's — is invalid: it is an existing projection, never genuine absence, so no screen
// answers in its place and the caller shows unknown from presence. Only a genuinely absent
// projection lets the labelled terminal-host screen answer.
import { readFileSync } from 'node:fs';
import {
  PRESENCE_ID,
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
 *  existing projection this incarnation cannot claim is invalid, never absence.
 *
 *  `appliedEventId` is the applied transition a fresh per-seat answer vouches for, when it names
 *  one: a projection whose id is not that transition has advanced past (or never reached) the
 *  proof and stays last known. `null` is a hook seat's answer, which names none: the route's
 *  fresh ingest is the whole answer there. */
export function readPresenceForSeat(
  stateDir: string,
  session: string,
  seat: string,
  binding: unknown,
  channelHealthy: boolean,
  appliedEventId: string | null = null,
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
  // A fresh answer that names an applied transition covers exactly that projection. One that
  // has advanced past it, or a proof naming another application, is not this answer's: the
  // word is kept as last known, never promoted on the route verdict alone.
  const live = presenceLive(read.reading, binding, channelHealthy)
    && (appliedEventId === null || read.reading.id === appliedEventId);
  return {
    kind: 'ok',
    observation: {
      state: read.reading.state,
      source: read.reading.source,
      event: read.reading.event,
      since: read.reading.since,
      live,
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
 *  `healthy: true` is the only proof, and every entry states its source class explicitly. */
export type PresenceSeatHealth = {
  healthy: boolean;
  /** What the route expects of this seat: a managed native channel that needs its own applied
   *  proof, the route's hook channel, or a classification that failed. Never inferred from
   *  list membership. */
  source: 'runtime' | 'hook' | 'unknown';
  /** The current managed binding at the sample; a serving entry always names one. */
  binding: string | null;
  /** The canonical projection id the daemon proved applied for a serving `runtime` seat; a
   *  reader's projection must carry exactly this id to be live. `null` for a `hook` seat,
   *  whose answer is the route's own ingest. */
  appliedEventId: string | null;
};

export type PresenceSeatsRead =
  /** The seat list is missing, malformed, or the route verdict that carried it is not fresh:
   *  no seat in it may be called live, and the route's own health is not proof either. */
  | { kind: 'invalid'; why: string }
  | { kind: 'listed'; seats: ReadonlyMap<string, PresenceSeatHealth> };

/**
 * The strict client-side reading of a route's `seats`: the list is complete for every declared
 * seat or it is unreadable. One entry per seat, no repeats, a closed state word and source
 * class, `healthy` exactly when serving, a valid binding or null, a valid applied transition id
 * or null, and a pending entry that says what it waits for. A serving `runtime` entry names both
 * the binding and the applied transition it vouches for; a serving `hook` entry names the
 * binding and no transition; a serving `unknown` entry is a contradiction. Anything else is
 * dropped whole, never partly served.
 */
function seatsOf(verdict: PresenceRouteVerdict): PresenceSeatsRead {
  const raw = verdict.seats;
  // A complete list is the contract: a route with declared seats that carries none is an
  // incomplete answer, not a hook-only route. Only a route with no declared seats omits it,
  // and a seat this display reads was never classified by such an answer.
  if (raw === undefined) return { kind: 'invalid', why: 'the route carries no seat list' };
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
    if (entry.source !== 'runtime' && entry.source !== 'hook' && entry.source !== 'unknown') {
      return { kind: 'invalid', why: 'a seat entry names no known source class' };
    }
    if (!(entry.binding === null || isPresenceBinding(entry.binding))) {
      return { kind: 'invalid', why: 'a seat entry carries no valid binding' };
    }
    if (!(entry.appliedEventId === null
      || (typeof entry.appliedEventId === 'string' && PRESENCE_ID.test(entry.appliedEventId)))) {
      return { kind: 'invalid', why: 'a seat entry carries no valid applied transition id' };
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
    if (entry.state === 'serving' && entry.source === 'unknown') {
      return { kind: 'invalid', why: 'a serving seat entry has an unknown source class' };
    }
    if (entry.state === 'serving' && entry.source === 'runtime' && entry.appliedEventId === null) {
      return { kind: 'invalid', why: 'a serving runtime seat names no applied transition' };
    }
    seats.set(entry.seat, {
      healthy: entry.healthy,
      source: entry.source,
      binding: entry.binding as string | null,
      appliedEventId: entry.appliedEventId as string | null,
    });
  }
  return { kind: 'listed', seats };
}

/** The route's verdict when the fresh answer proves the channel current for this session: the
 *  probe answered, the route is serving and healthy, and both the verdict's `checkedAt` and the
 *  probe answer belong to the display's own instant. `undefined` otherwise. */
function freshServingVerdict(
  reading: PresenceHealthReading,
  root: string,
  session: string,
  now: Date,
): PresenceRouteVerdict | undefined {
  if (reading.probe.state !== 'answered') return undefined;
  const verdict = reading.roots.find((entry) => entry.root === root)?.presence;
  if (verdict === undefined) return undefined;
  if (verdict.state !== 'serving' || verdict.healthy !== true) return undefined;
  if (verdict.session !== session) return undefined;
  if (typeof verdict.checkedAt !== 'string') return undefined;
  const checkedAt = Date.parse(verdict.checkedAt);
  const answeredAt = Date.parse(reading.probe.at);
  const at = now.getTime();
  if (!Number.isFinite(checkedAt) || !Number.isFinite(answeredAt) || !Number.isFinite(at)) return undefined;
  // Both instants must be this display's own: an old probe's answer is a snapshot, never proof.
  if (Math.abs(at - answeredAt) > PRESENCE_HEALTH_GRACE_MS) return undefined;
  if (Math.abs(at - checkedAt) > PRESENCE_HEALTH_GRACE_MS) return undefined;
  return verdict;
}

/** The route's per-seat answers when its verdict is fresh and serving; every other answer,
 *  including a route that carries no list where the contract requires one, is invalid. */
export function presenceSeatsOf(
  reading: PresenceHealthReading,
  root: string,
  session: string,
  now: Date,
): PresenceSeatsRead {
  const verdict = freshServingVerdict(reading, root, session, now);
  if (verdict === undefined) {
    return { kind: 'invalid', why: 'the route verdict is not fresh and serving for this session' };
  }
  return seatsOf(verdict);
}

/**
 * Whether one seat's projection may be called live, and the applied transition it must carry.
 * The route must be fresh and serving, and this seat must be listed serving with exactly the
 * binding the seat's state records. Every declared seat is classified in the answer, so a
 * missing entry, a missing list or a pending entry is an incomplete answer — last known, never
 * live by route health alone.
 *
 * The entry's own source class decides the proof. A `runtime` seat vouches for the exact applied
 * transition its sample reconciled, and the projection read must carry that id. A `hook` seat is
 * qualified by the route's fresh ingest and names no transition; an `unknown` seat (the daemon
 * could not classify what the seat expected) is never serving, so it never qualifies.
 */
export type PresenceSeatProof = {
  /** Whether the route's fresh verdict may apply to this seat at all. */
  qualified: boolean;
  /** The applied transition identity the fresh answer vouches for; the projection read must
   *  carry exactly this id to be live. `null` when the entry names none (a hook seat). */
  appliedEventId: string | null;
};

export function seatPresenceProof(
  seats: PresenceSeatsRead | undefined,
  seat: string,
  binding: unknown,
): PresenceSeatProof {
  if (seats === undefined || seats.kind === 'invalid') {
    return { qualified: false, appliedEventId: null };
  }
  const entry = seats.seats.get(seat);
  if (entry === undefined) return { qualified: false, appliedEventId: null };
  if (!entry.healthy || !isPresenceBinding(binding) || entry.binding !== binding) {
    return { qualified: false, appliedEventId: null };
  }
  // Only a runtime seat's sample names an applied transition; the hook answer is the route's
  // own ingest, judged on the channel and the binding fence above.
  return {
    qualified: true,
    appliedEventId: entry.source === 'runtime' ? entry.appliedEventId : null,
  };
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
  const verdict = freshServingVerdict(reading, root, session, now);
  if (verdict === undefined) return false;
  // A route whose per-seat record is missing where the complete-list contract requires one, or
  // malformed, is not a trustworthy answer: the daemon client drops it whole, and so does the
  // display.
  return seatsOf(verdict).kind !== 'invalid';
}


