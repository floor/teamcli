// Exposure claims (rfc-event-comms §3, step E6).
//
// An automatic leg that would put a message body in front of the model first creates the
// message's exposure claim; only its creator exposes the body. The claim is per canonical message,
// outside every queue generation, so replacing a generation never resets it:
//   .agents/exposures/<session>/<recipient>/<msg_id>.exposed        (a launch brief: <msg_id>@<epoch>)
// It is a signed record, created exclusively and durably (file and folder fsynced) BEFORE the body
// leaves, and never replaced or removed.
//
// The decision, one function for every automatic exposer:
//   active root            create the claim; `expose` only when this call created it; `pointer`
//                          when a verifying claim already stands; `pointer` when the claim cannot be
//                          made or read (fail closed: no body without a durable claim).
//   fenced or unknown root no new claim is made; a verifying claim that stands still means
//                          `pointer` (every existing fence stays honoured); none standing means the
//                          legacy behaviour (`legacy`), exactly as before E6.
//   dark root              the claim is written in shadow and decides nothing: `legacy`.
// A deliberate reread (`team show`, inbox `--again`) is not an exposure and never calls this.
import { join } from 'node:path';
import { messageKeyOf, messageKeyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { createExclusive, readFence, type DurableFaults } from './durable.ts';
import { floorState } from './floor.ts';

export const EXPOSURE_DOMAIN = 'team-exposure-v1\n';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ExposureTarget = { root: string; session: string; seat: string; msg_id: string; epoch?: string };

export type ExposurePayload = {
  v: 1;
  kind: 'exposure';
  root: string;
  session: string;
  seat: string;
  msg_id: string;
  epoch: string | null;
  actor: string;
  at: string;
};

export type ExposureDecision =
  /** This call created the claim: expose the body once. */
  | { kind: 'expose' }
  /** A claim stands, or none could be made on an active root: send a pointer, never the body. */
  | { kind: 'pointer'; why: string }
  /** No fence applies (dark root, or no claim standing on a fenced or unknown root): legacy. */
  | { kind: 'legacy' };

function keyOf(target: ExposureTarget): string | null {
  if (!NAME.test(target.session) || !NAME.test(target.seat) || !NAME.test(target.msg_id)) return null;
  if (target.epoch === undefined) return target.msg_id;
  return NAME.test(target.epoch) ? `${target.msg_id}@${target.epoch}` : null;
}

export function exposurePath(target: ExposureTarget): string | null {
  const key = keyOf(target);
  return key === null ? null : join(target.root, '.agents', 'exposures', target.session, target.seat, `${key}.exposed`);
}

/** The claim that stands for `target`: `absent` (proved by ENOENT), `held` (verifies and is bound to
 *  this target), or `unknown` (unreadable, not verifying, or bound elsewhere: never absent). */
export function exposureClaimOf(target: ExposureTarget, home: string): 'absent' | 'held' | 'unknown' {
  const read = exposureRecordOf(target, home);
  return read === 'absent' || read === 'unknown' ? read : 'held';
}

/** The verifying claim's payload, or `absent` / `unknown` exactly as `exposureClaimOf`. */
export function exposureRecordOf(target: ExposureTarget, home: string): 'absent' | 'unknown' | ExposurePayload {
  const path = exposurePath(target);
  if (path === null) return 'unknown';
  const text = readFence(path);
  if (text === null) return 'unknown';
  if (text === '') return 'absent';
  let record: { payload?: ExposurePayload; signature?: unknown };
  try {
    record = JSON.parse(text) as typeof record;
  } catch {
    return 'unknown';
  }
  const payload = record.payload;
  if (!payload || payload.kind !== 'exposure' || payload.v !== 1 || typeof record.signature !== 'string') return 'unknown';
  if (payload.root !== target.root || payload.session !== target.session || payload.seat !== target.seat
    || payload.msg_id !== target.msg_id || payload.epoch !== (target.epoch ?? null)) return 'unknown';
  const key = messageKeyState(home);
  if (key.kind !== 'key') return 'unknown';
  return verifyDomain(EXPOSURE_DOMAIN, payload as unknown as Json, record.signature, key.key) ? payload : 'unknown';
}

function writeClaim(target: ExposureTarget, actor: string, home: string, faults?: DurableFaults): 'created' | 'exists' | 'failed' {
  const path = exposurePath(target);
  if (path === null) return 'failed';
  const payload: ExposurePayload = {
    v: 1,
    kind: 'exposure',
    root: target.root,
    session: target.session,
    seat: target.seat,
    msg_id: target.msg_id,
    epoch: target.epoch ?? null,
    actor,
    at: new Date().toISOString(),
  };
  let signature: string;
  try {
    signature = signDomain(EXPOSURE_DOMAIN, payload as unknown as Json, messageKeyOf(home));
  } catch {
    return 'failed';
  }
  return createExclusive(path, `${JSON.stringify({ payload, signature })}\n`, faults);
}

/**
 * The exposure decision for one automatic body exposure, taken immediately before the body leaves.
 * Nothing that can fail sits between a returned `expose` and the hand-over in the caller.
 */
export function decideExposure(target: ExposureTarget, actor: string, home: string, faults?: DurableFaults): ExposureDecision {
  const state = floorState(target.root, home);
  if (state.kind === 'active') {
    const made = writeClaim(target, actor, home, faults);
    if (made === 'created') return { kind: 'expose' };
    if (made === 'failed') return { kind: 'pointer', why: 'the exposure claim could not be made durable' };
    const held = exposureRecordOf(target, home);
    // The same operation coming back (a relayed read's recovery re-entering its own read) continues
    // its own exposure: one operation, one claim, one body. Any other actor gets the pointer.
    if (typeof held === 'object' && operationActor(actor) && held.actor === actor) return { kind: 'expose' };
    return { kind: 'pointer', why: typeof held === 'object' ? 'already shown by another leg' : 'an exposure claim that cannot be verified stands' };
  }
  if (state.kind === 'dark') {
    // Shadow: written so a later activation finds the history, and decides nothing now.
    writeClaim(target, actor, home, faults);
    return { kind: 'legacy' };
  }
  // Fenced or unknown: no new fence; an existing one is still honoured.
  const held = exposureRecordOf(target, home);
  if (typeof held === 'object') {
    if (operationActor(actor) && held.actor === actor) return { kind: 'expose' };
    return { kind: 'pointer', why: 'already shown by another leg' };
  }
  if (held === 'unknown') return { kind: 'pointer', why: 'an exposure claim that cannot be read stands' };
  return { kind: 'legacy' };
}

/** An actor that names one operation (a relayed read's owner), not a kind of reader. */
function operationActor(actor: string): boolean {
  return actor.startsWith('relay:') || actor.startsWith('delivered:');
}

/** The leg that carries a body to the model, for `bodyExposure`. */
export type BodyLeg = 'channel' | 'typed' | 'native' | 'socket';

/** The actor one leg's delivery of one message claims under. The same leg recording its own
 *  delivery afterwards (`recordDeliveredBody`) continues that exposure; any other leg gets a
 *  pointer. */
export function bodyActor(leg: BodyLeg, msgId: string): string {
  return `delivered:${leg}:${msgId}`;
}

/** The exposure decision for a leg about to carry `msgId`'s body (§3), taken before the body leaves. */
export function bodyExposure(target: { root: string; session: string; seat: string; msgId: string }, leg: BodyLeg, home: string): ExposureDecision {
  return decideExposure({ root: target.root, session: target.session, seat: target.seat, msg_id: target.msgId }, bodyActor(leg, target.msgId), home);
}

/** The pointer text an automatic leg sends instead of a body (§3). */
export function exposurePointer(msgId: string, seq: number | null): string {
  return `message ${msgId}${seq === null ? '' : ` (seq ${String(seq)})`}: already shown, or reread it with \`team show ${msgId}\``;
}
