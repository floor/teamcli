// The idle-episode claim store: the watch's one direct-work attempt is spent and answered in the
// team state file, under the state lock every other writer uses. The record's shape and its read
// door live in claim-record.ts; this module is the only writer.
//
// Every operation is one `updateState` call with `waitMs: 0`: a watch pass must never wait on a
// writer, and `LockBusyError` is the primitive's own contention answer. A busy capture pushes
// nothing this pass; a busy settle leaves the claim `pending`, which every later pass and every
// new host holds; a busy end leaves claims standing, and a new episode's different `idle_since`
// overwrites at capture. A state file that cannot be read at all fails closed the same way: the
// operation answers `failed`, nothing is written, and nothing is pushed.
//
// Capture rechecks the persisted `last_active` under the lock against the stamp the pass read:
// a snapshot that no longer matches is a stale episode, and the wrong episode is never spent.
import { randomBytes } from 'node:crypto';
import { LockBusyError, updateState, type SessionState } from '../state.ts';
import {
  isIdleClaim,
  type IdleClaim,
  type IdleClaimEntry,
} from './claim-record.ts';

/** The claim a pass snapshot holds for a seat, or undefined. Pure: no lock, no read. */
export function idleClaimOf(state: SessionState, seat: string): IdleClaimEntry | undefined {
  return state.idle_claims?.[seat];
}

/** A fresh compare-and-set fence for one capture: 16 lowercase hex, minted per capture. */
export function mintClaimId(): string {
  return randomBytes(8).toString('hex');
}

export type IdleCaptureResult =
  | { kind: 'captured'; claim: IdleClaim }
  | { kind: 'held'; entry: IdleClaimEntry }
  | { kind: 'stale' }
  | { kind: 'busy' }
  | { kind: 'failed'; why: string };

/**
 * Captures this episode's one attempt, before any push. Under the lock:
 * - the session's seat must exist and its persisted `last_active` must equal `idle_since`
 *   exactly; otherwise `stale` and nothing is written (the pass read an older snapshot);
 * - a standing entry of this same `idle_since` — readable or not — answers `held`, so a
 *   malformed claim is a hold rather than an absence;
 * - a readable claim of another `idle_since` is a trusted episode end: it is replaced (capture
 *   handles the overwrite; `endIdleClaims` is the prune, not a precondition);
 * - otherwise the claim is written `pending` with a fresh `claim_id` and `captured`.
 */
export function captureIdleClaim(
  dir: string,
  input: { session: string; seat: string; idle_since: string; at: Date },
): IdleCaptureResult {
  try {
    return updateState(dir, (state): IdleCaptureResult => {
      const session = state.sessions[input.session];
      if (session === undefined || session.seats?.[input.seat]?.last_active !== input.idle_since) {
        return { kind: 'stale' };
      }
      const standing = session.idle_claims?.[input.seat];
      if (standing !== undefined) {
        if (!isIdleClaim(standing) || standing.idle_since === input.idle_since) {
          return { kind: 'held', entry: standing };
        }
        // A readable claim of a different episode: the old episode ended, the new one is owed
        // its own attempt. Replaced below.
      }
      const claim: IdleClaim = {
        claim_id: mintClaimId(),
        idle_since: input.idle_since,
        state: 'pending',
        claimed_at: input.at.toISOString(),
      };
      (session.idle_claims ??= {})[input.seat] = claim;
      return { kind: 'captured', claim };
    }, { waitMs: 0, writeWhen: (result) => result.kind === 'captured' });
  } catch (error) {
    if (error instanceof LockBusyError) return { kind: 'busy' };
    return { kind: 'failed', why: error instanceof Error ? error.message : String(error) };
  }
}

export type IdleSettleInput = {
  session: string;
  seat: string;
  idle_since: string;
  claim_id: string;
  at: Date;
} & (
  | { outcome: 'accepted' }
  | { outcome: 'refused' }
  | { outcome: 'pickup'; claimed: boolean }
  | { outcome: 'unknown' }
);

export type IdleSettleResult =
  | { kind: 'settled'; claim: IdleClaim; changed: boolean }
  | { kind: 'gone' }
  | { kind: 'busy' }
  | { kind: 'failed'; why: string };

/**
 * Records one answer on the claim this exact capture made. The `claim_id` and `idle_since` must
 * both match the stored record, so a late result can never land on a later capture of the same
 * stamp (an ended episode is never resurrected). Transitions are guarded: `accepted`, `refused`
 * and `unknown` settle only a `pending` claim; `pickup` settles only an `inflight` one.
 * `accepted` stores `wake_at`; `refused` and a failed `pickup` store the notice the claim still
 * owes; `unknown` keeps the claim `pending` — held, never retried — and stores its notice.
 */
export function settleIdleClaim(dir: string, input: IdleSettleInput): IdleSettleResult {
  try {
    return updateState(dir, (state): IdleSettleResult => {
      const claim = state.sessions[input.session]?.idle_claims?.[input.seat];
      if (claim === undefined || !isIdleClaim(claim)) return { kind: 'gone' };
      if (claim.claim_id !== input.claim_id || claim.idle_since !== input.idle_since) return { kind: 'gone' };
      const at = input.at.toISOString();
      switch (input.outcome) {
        case 'accepted':
          if (claim.state !== 'pending') return { kind: 'gone' };
          claim.state = 'inflight';
          claim.wake_at = at;
          break;
        case 'refused':
          if (claim.state !== 'pending') return { kind: 'gone' };
          claim.state = 'refused';
          claim.notice = 'refused';
          break;
        case 'pickup':
          if (claim.state !== 'inflight') return { kind: 'gone' };
          claim.state = 'done';
          if (input.claimed) delete claim.notice;
          else claim.notice = 'stalled';
          break;
        case 'unknown':
          if (claim.state !== 'pending') return { kind: 'gone' };
          if (claim.notice === 'unknown') return { kind: 'settled', claim, changed: false };
          claim.notice = 'unknown';
          break;
      }
      return { kind: 'settled', claim, changed: true };
    }, { waitMs: 0, writeWhen: (result) => result.kind === 'settled' && result.changed });
  } catch (error) {
    if (error instanceof LockBusyError) return { kind: 'busy' };
    return { kind: 'failed', why: error instanceof Error ? error.message : String(error) };
  }
}

export type IdleEndResult =
  | { kind: 'ended'; removed: number }
  | { kind: 'busy' }
  | { kind: 'failed'; why: string };

/**
 * Ends every claim of this session whose seat the actionable reading no longer counts, under the
 * lock. Presence, not readability, keeps an entry: a seat still in `current` keeps its claim
 * whatever shape it has, and a claim whose `idle_since` differs is kept too — capture replaces it
 * on the next attempt, so pruning can never be the thing that erases a hold. The map is written
 * only when an entry was removed.
 */
export function endIdleClaims(
  dir: string,
  input: { session: string; current: readonly { seat: string; idle_since: string }[] },
): IdleEndResult {
  try {
    return updateState(dir, (state): IdleEndResult => {
      const claims = state.sessions[input.session]?.idle_claims;
      if (claims === undefined) return { kind: 'ended', removed: 0 };
      const eligible = new Set(input.current.map((one) => one.seat));
      let removed = 0;
      for (const seat of Object.keys(claims)) {
        if (eligible.has(seat)) continue;
        delete claims[seat];
        removed++;
      }
      return { kind: 'ended', removed };
    }, { waitMs: 0, writeWhen: (result) => result.kind === 'ended' && result.removed > 0 });
  } catch (error) {
    if (error instanceof LockBusyError) return { kind: 'busy' };
    return { kind: 'failed', why: error instanceof Error ? error.message : String(error) };
  }
}
