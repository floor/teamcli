// The idle-episode claim as the state file holds it: one small record per seat that spends the
// dispatcher's single direct-work attempt in one idle episode. The record is parsed at the
// state's read door, never trusted from the file, and a value that cannot be read is kept as an
// explicit `unreadable` presence rather than dropped: a malformed claim is a hold, never an
// absence, so no reader can push work a claim may already have spent.
//
// The record is bounded: the capture's internal claim id (a compare-and-set fence, never a
// transport id), the episode stamp it was taken for, one of four states, the capture time, the
// accepted wake time when the route took it, and the notice the claim still owes. No body, task
// id, pid, host, epoch or free text is stored.
//
// This module is a leaf: state.ts imports it for the read door, and the claim store imports it
// for the record's rules. It must not import state.ts.

export const CLAIM_ID_PATTERN = /^[0-9a-f]{16}$/;

/** `pending` is captured with no recorded outcome — a crash or a held state lock here is an
 *  unknown in-flight attempt and holds the episode; `inflight` is a route that accepted at
 *  `wake_at`; `refused` is a route that refused or threw, the attempt spent; `done` is a pickup
 *  grace already handled. */
export type IdleClaimState = 'pending' | 'inflight' | 'refused' | 'done';

/** A notice the claim still owes the team lead and the main orchestrator. The intent lives with
 *  the record until the episode ends, so a stop between the write and the publication replays
 *  the same `once: true` mailbox ids instead of losing the notice. */
export type IdleClaimNotice = 'refused' | 'stalled' | 'unknown';

export type IdleClaim = {
  /** The capture's compare-and-set fence: 16 lowercase hex, minted per capture. A settle names
   *  the fence it settles, so a late result can never land on a later capture of the same stamp.
   *  It is not a transport id and never decides whether an episode is held. */
  claim_id: string;
  /** The episode's identity: the seat's persisted `last_active` stamp the reading counted. */
  idle_since: string;
  state: IdleClaimState;
  /** When the claim was captured, before any push. */
  claimed_at: string;
  /** Only with `inflight` or `done`: the pass clock at which the route accepted the wake. */
  wake_at?: string;
  /** The notice this claim owes, replayed by every pass until the episode ends. */
  notice?: IdleClaimNotice;
};

/** A claim entry the read door could not read. Its presence holds the seat: no writer replaces
 *  it while the seat remains eligible, and no dispatcher pushes for it. */
export type UnreadableIdleClaim = { unreadable: true };

export type IdleClaimEntry = IdleClaim | UnreadableIdleClaim;

/** Whether an entry is a claim this build can read, rather than an unreadable presence. */
export function isIdleClaim(entry: IdleClaimEntry | undefined): entry is IdleClaim {
  return entry !== undefined && (entry as UnreadableIdleClaim).unreadable !== true;
}

function stamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/** One entry, exactly as this build writes it, or null. A field of the wrong shape makes the
 *  whole entry unreadable: a partly trusted claim is not a claim. */
export function idleClaimOfValue(value: unknown): IdleClaim | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.claim_id !== 'string' || !CLAIM_ID_PATTERN.test(raw.claim_id)) return null;
  const idleSince = stamp(raw.idle_since);
  if (idleSince === null) return null;
  if (raw.state !== 'pending' && raw.state !== 'inflight' && raw.state !== 'refused' && raw.state !== 'done') return null;
  const claimedAt = stamp(raw.claimed_at);
  if (claimedAt === null) return null;
  const claim: IdleClaim = { claim_id: raw.claim_id, idle_since: idleSince, state: raw.state, claimed_at: claimedAt };
  if (raw.wake_at !== undefined) {
    const wakeAt = stamp(raw.wake_at);
    if (wakeAt === null) return null;
    if (raw.state !== 'inflight' && raw.state !== 'done') return null;
    claim.wake_at = wakeAt;
  }
  if (raw.notice !== undefined) {
    if (raw.notice !== 'refused' && raw.notice !== 'stalled' && raw.notice !== 'unknown') return null;
    claim.notice = raw.notice;
  }
  return claim;
}

/**
 * The whole map, as the read door keeps it. A map this build cannot read at all holds every
 * seat the session records: a presence that cannot be attributed is still a hold, and it is
 * released only by a trusted episode end (the seat leaving the reading) or manual recovery.
 * An entry that is not a claim becomes `{ unreadable: true }`; nothing is dropped to absence.
 */
export function cleanIdleClaims(value: unknown, seats: readonly string[]): Record<string, IdleClaimEntry> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const held: Record<string, IdleClaimEntry> = {};
    for (const seat of seats) held[seat] = { unreadable: true };
    return held;
  }
  const claims: Record<string, IdleClaimEntry> = {};
  for (const [seat, entry] of Object.entries(value)) {
    if (seat === '' || /[\u0000-\u001f\u007f]/.test(seat)) continue;
    claims[seat] = idleClaimOfValue(entry) ?? { unreadable: true };
  }
  return claims;
}
