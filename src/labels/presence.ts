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
  return Math.abs(at - checkedAt) <= PRESENCE_HEALTH_GRACE_MS;
}


