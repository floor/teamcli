// The send walk's fallback episode: one signed record, staged once before any route attempt,
// whose digest and message id every attempt carries, and one fact per route the walk tried.
// The recorder owns the durable episode (ledger, marker, events, the delayed escalation); this
// module only assembles its context from what the walk already verified, so a send holds one
// episode rather than re-resolving the receiver at every route.
import { createHash } from 'node:crypto';
import type { Caller } from '../caller.ts';
import type { TeamFile } from '../file/types.ts';
import {
  noteTransport,
  type AttemptOutcome,
  type CanonicalRecipient,
  type FallbackContext,
  type FallbackNote,
  type RelayReceipt,
  type TransportFact,
} from './fallback-events.ts';

/** The receiver as the walk resolved and verified it: the receiving team's project, the seat,
 *  its registry id when one exists, its session, and the checkout its records live under. */
export type WalkRecipient = {
  team: string;
  seat: string;
  toId: string | null;
  session: string;
  root: string;
};

/** One route attempt, as the walk made it. */
export type WalkAttempt = {
  route: string;
  outcome: AttemptOutcome;
  /** Whether a route still stands behind this one: only the last route's failure is exhaustion. */
  liveRoutesRemain: boolean;
  at: Date;
  ms: number;
  reason?: string;
  receipt?: RelayReceipt;
};

export type FallbackWalk = {
  messageId: string;
  recordDigest: string;
  /** Record one attempt. The answer is the recorder's; a refusal changes nothing about the
   *  send, and it is the caller's to report. */
  note(attempt: WalkAttempt): FallbackNote;
};

/** The digest of the signed record's bytes: the episode's checked value, never a key part. */
export function recordDigestOf(record: string): string {
  return createHash('sha256').update(record).digest('hex');
}

export function beginFallbackWalk(input: {
  caller: Caller;
  /** The sending team's validated file. */
  team: TeamFile;
  /** The sending run's root: the sender's chain is read here, never the receiver's. */
  root: string;
  home: string;
  now: () => Date;
  recipient: WalkRecipient;
  messageId: string;
  /** The signed record's bytes, exactly as staged. */
  record: string;
  /** The receiving team's own file, when the receiver stands in another checkout. */
  recipientTeam?: TeamFile;
}): FallbackWalk {
  const recipient: CanonicalRecipient = { ...input.recipient };
  const recordDigest = recordDigestOf(input.record);
  const ctx: FallbackContext = {
    caller: input.caller,
    team: input.team,
    root: input.root,
    home: input.home,
    now: input.now,
    ...(input.recipientTeam === undefined ? {} : { recipientTeam: input.recipientTeam }),
  };
  return {
    messageId: input.messageId,
    recordDigest,
    note(attempt: WalkAttempt): FallbackNote {
      const fact: TransportFact = {
        recipient,
        messageId: input.messageId,
        recordDigest,
        route: attempt.route,
        outcome: attempt.outcome,
        at: attempt.at.toISOString(),
        ms: attempt.ms,
        liveRoutesRemain: attempt.liveRoutesRemain,
        ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
        ...(attempt.receipt === undefined ? {} : { receipt: attempt.receipt }),
      };
      return noteTransport(ctx, fact);
    },
  };
}
