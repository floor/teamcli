// The display's read of the daemon's presence projection. The daemon owns the log and the
// atomic `current.json`; this module asks one question per seat at display time: does a
// projection exist, what does it say, and is it qualified as live?
//
// Live is the contract's own test (`presenceLive`): the projection's binding must be the one the
// seat's state records, and the route's presence channel must be healthy by a *fresh* answer
// from the daemon that owns it — never the persisted `status.json` word, which can outlive the
// channel it describes. A projection that exists under this incarnation but is not live is
// still the runtime's last known word, and the display keeps showing it; a projection a
// predecessor launch wrote is not this seat's reading at all, and only a genuinely absent
// projection lets the labelled terminal-host screen answer. A malformed projection is reported
// as bad so the caller can show unknown from presence, never a screen's guess in its place.
import { readFileSync } from 'node:fs';
import {
  isPresenceBinding,
  presenceLive,
  readPresenceReading,
} from '../daemon/presence/contract.ts';
import { presencePaths } from '../daemon/presence/spool.ts';
import type { PresenceObservation } from './state.ts';

export type PresenceProjectionRead =
  | { kind: 'absent' }
  /** A projection exists, but under another runtime incarnation: not this seat's reading, and
   *  the screen may answer in its place. */
  | { kind: 'predecessor' }
  | { kind: 'bad'; why: string }
  | { kind: 'ok'; observation: PresenceObservation };

/** The projection file is the reading, even when it is not live — but only under the binding the
 *  seat's state records. Absent (or a predecessor's file) is the one case that permits a
 *  terminal-host fallback. */
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
  // wrote is not this seat's reading, however fresh it is. A value that is not a binding is
  // simply no fence to open.
  if (!isPresenceBinding(binding)) return { kind: 'predecessor' };
  if (read.reading.binding !== binding) return { kind: 'predecessor' };
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
 * How far a route's `checkedAt` may sit from the probe answer that carried it. The daemon stamps
 * the request instant and the display asks with the health op's 500 ms bound; five seconds covers
 * a slow local answer without ever accepting a record from an earlier probe.
 */
const PRESENCE_CHECKED_AT_WINDOW_MS = 5_000;

/**
 * Whether the display may mark this session's projections live. The answer is the fresh daemon
 * health snapshot's per-route verdict — only `serving` and `healthy` with the same session count,
 * and only when its `checkedAt` belongs to the probe this reading answered. A pending route, a
 * route the daemon is not hosting, a malformed or stale record all leave the display at last
 * known. Default closed: a health answer without a verdict proves nothing.
 */
export function presenceChannelHealthy(
  reading: PresenceHealthReading,
  root: string,
  session: string,
): boolean {
  if (reading.probe.state !== 'answered') return false;
  const verdict = reading.roots.find((entry) => entry.root === root)?.presence;
  if (verdict === undefined) return false;
  if (verdict.state !== 'serving' || verdict.healthy !== true) return false;
  if (verdict.session !== session) return false;
  if (typeof verdict.checkedAt !== 'string') return false;
  const checkedAt = Date.parse(verdict.checkedAt);
  const answeredAt = Date.parse(reading.probe.at);
  if (!Number.isFinite(checkedAt) || !Number.isFinite(answeredAt)) return false;
  return Math.abs(answeredAt - checkedAt) <= PRESENCE_CHECKED_AT_WINDOW_MS;
}


