// Body exposure (rfc-event-comms §3, step E6), built on E5's one read claim
// (src/send/read-claim.ts), not on a second mechanism.
//
// A leg about to carry a message's body to the model (the channel frame, a typed inline wake, a
// native or socket frame) takes the message's exclusive read claim with an owner of its own:
// `expose:<leg>:<msg_id>:<nonce>`, unique to this one hand-over. The owner file is durable before
// the claim returns, so before the body leaves. The hand-over is then settled exactly once:
//
//   E1 claim     claimRead(owner) — durable owner file; a refused claim means POINTER, no body.
//   E2 hand-over the leg carries the body (the caller's own step).
//   E3 settle    `handedOver: 'yes'`     → seal the `read` receipt through the same claim (adopt),
//                                          then remove the owned claim (durable). A seal that fails
//                                          keeps the claim: the body stays exposed-unconfirmed.
//                `handedOver: 'no'`      → nothing left the process: remove the owned claim (the
//                                          message is not exposed and may be offered again).
//                `handedOver: 'unknown'` → keep the claim: exposed-unconfirmed.
//
// A claim whose owner is an `expose:` owner is never adopted by another reader. Every automatic
// reader that meets it gets a pointer and no body (`team messages`, the inbox read, `drops --read`
// all go through `claimRead`); the deliberate reread (`team show`) prints the body and writes no
// read receipt. The seal is a handle on the decision, never a new decision: a second hand-over of
// the same message on any leg finds the owned claim (or the sealed receipt) and gets a pointer.
//
// Floor: only an ACTIVE root takes these claims (the fence is created). A dark, fenced or unknown
// root takes none and the legs behave as before E6; an owned claim that already stands is still
// honoured by every reader, whatever the floor.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { claimRead, ownerOfClaim, READ_CLAIMS, removeOwnedClaim } from '../send/read-claim.ts';
import { lstatSync } from 'node:fs';
import { receiptFile } from '../send/record.ts';
import { ensureFolder } from './durable.ts';
import { mayCreateFence } from './floor.ts';

export type BodyLeg = 'channel' | 'typed' | 'native' | 'socket';

const EXPOSE_PREFIX = 'expose:';

/** Whether a claim owner is a leg's body exposure (never adopted by another reader). */
export function isExposeOwner(owner: string | null | 'unknown'): boolean {
  return typeof owner === 'string' && owner.startsWith(EXPOSE_PREFIX);
}

export type ExposureTarget = { dropDir: string; root: string; session: string; seat: string; msgId: string };

export type ExposureHandle = {
  kind: 'expose';
  owner: string;
  /** E3: settles the hand-over once. `seal` publishes the read receipt for 'yes'. */
  settle(handedOver: 'yes' | 'no' | 'unknown', seal: (owner: string) => boolean): void;
};

export type ExposureDecision =
  | ExposureHandle
  /** Another hand-over holds or held the body: carry a pointer, write no read. */
  | { kind: 'pointer'; why: string }
  /** No fence applies (the root is not active): the leg behaves as before E6. */
  | { kind: 'legacy' };

/**
 * E1, taken by the leg immediately before it builds the frame that carries the body. On an active
 * root, `expose` only when this call took a fresh owned claim; every refusal is a pointer.
 */
export function exposeBody(target: ExposureTarget, leg: BodyLeg, home: string): ExposureDecision {
  const standing = ownerOfClaim(target.dropDir, target.msgId);
  if (standing === 'unknown') return { kind: 'pointer', why: 'the message read claim cannot be read' };
  if (isExposeOwner(standing)) return { kind: 'pointer', why: 'already shown by another hand-over' };
  if (!mayCreateFence(target.root, home, 'exposure')) return { kind: 'legacy' };
  const owner = `${EXPOSE_PREFIX}${leg}:${target.msgId}:${randomBytes(6).toString('hex')}`;
  // The claim folder chain is made durable before the owner file can be (§3 first write).
  if (!ensureFolder(join(target.dropDir, READ_CLAIMS))) return { kind: 'pointer', why: 'the read claim folder could not be made durable' };
  const claim = claimRead(target.dropDir, target.msgId, owner);
  if (!claim.ok) return { kind: 'pointer', why: claim.why === 'recovering' ? 'already shown by another hand-over' : `the read claim was not taken (${claim.why})` };
  // Under the claim, a body is granted only on positive proof of no earlier exposure: both receipt
  // names (`read`, which a lead's clearance also holds, and `replied`) are proven absent. Any
  // entry there, verifying or not, readable or not, is an earlier exposure this hand-over cannot
  // rule out (the inbox reader's occupied-name rule), and an unreadable name is never absence.
  const prior = priorExposure(target.dropDir, target.msgId);
  if (prior !== null) {
    claim.release();
    return { kind: 'pointer', why: prior };
  }
  // The lock is let go at once; the durable owner file is the fence from here on.
  claim.keep();
  let settled = false;
  return {
    kind: 'expose',
    owner,
    settle: (handedOver, seal) => {
      if (settled) return;
      settled = true;
      if (handedOver === 'unknown') return;
      if (handedOver === 'no') {
        removeOwnedClaim(target.dropDir, target.msgId, owner);
        return;
      }
      if (seal(owner)) removeOwnedClaim(target.dropDir, target.msgId, owner);
    },
  };
}

/** Null only when both receipt names are proven absent (`ENOENT`); otherwise why a body may not
 *  go out. Only "no such file" counts as absent: any other lstat error, or any entry at all, keeps
 *  the body back. */
export function priorExposure(dropDir: string, msgId: string): string | null {
  for (const status of ['read', 'replied'] as const) {
    let path: string;
    try {
      path = receiptFile(dropDir, msgId, status);
    } catch {
      return `the ${status} receipt name cannot be resolved`;
    }
    try {
      lstatSync(path);
      return status === 'read' ? 'already read or cleared' : 'already replied to';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return `the ${status} receipt name cannot be read`;
    }
  }
  return null;
}

/** The pointer text an automatic leg carries instead of a body (§3). */
export function exposurePointer(msgId: string, seq: number | null): string {
  return `message ${msgId}${seq === null ? '' : ` (seq ${String(seq)})`}: already shown, or reread it with \`team show ${msgId}\``;
}
