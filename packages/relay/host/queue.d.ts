// Types for the standalone durable host queue (queue.js). Plain data and Node builtins only;
// no TeamCLI import, no service, no auth. The caller supplies a recipient taken from verified
// admission; that value is trusted data, never an authorization token.

/** The structural message the relay stores: an opaque signed record, plus the optional complete
 *  newline-terminated frame. `record` is never a socket frame. */
export type HostMessage = { id: string; record: string; frame?: string };

/** The trusted result of verified admission. Plain data; the queue never treats it as proof. */
export type VerifiedScope = { recipient: string };

/** The dedup key: canonical verified recipient plus message id. The digest is not part of it. */
export type RelayKey = { recipient: string; messageId: string };

/** A fencing token for one reservation. A newer epoch supersedes an older reservation. */
export type ClaimToken = { epoch: number; opaque: string };

export type EnqueueVerdict =
  | { verdict: 'new'; digest: string; at: string }
  | { verdict: 'duplicate'; digest: string; at: string }
  | { verdict: 'conflict'; at: string };

export type ClaimVerdict =
  | { verdict: 'claimed'; key: RelayKey; token: ClaimToken; message: HostMessage }
  | { verdict: 'empty' }
  /** A reservation is present or an older reservation could not be ruled out; nothing is
   *  returned and no automatic redelivery happens. */
  | { verdict: 'ambiguous'; since: string }
  | { verdict: 'unreadable'; at: string };

export type FinishVerdict =
  | { verdict: 'acked'; at: string }
  | { verdict: 'released'; at: string }
  /** The presented key and token no longer match a live reservation. */
  | { verdict: 'stale-token'; at: string }
  | { verdict: 'unknown-message'; at: string }
  | { verdict: 'unreadable'; at: string };

/**
 * Evidence for recovery, from the receiver's atomic per-message-id gate. A plain "no record" is
 * not evidence: only a gate that definitively closed the message as processed or unprocessed
 * counts, because an old callback may still be in flight until the caller fences it.
 */
export type RecoveryEvidence =
  | { kind: 'receiver-gate-processed'; at: string }
  | { kind: 'receiver-gate-unprocessed'; at: string };

export type RecoverInput = {
  key: RelayKey;
  /** The reservation being recovered. A recovery with a superseded token is refused. */
  token: ClaimToken;
  /** The trusted caller attests the old runtime is stopped and cannot still complete. */
  fenced: boolean;
  evidence: RecoveryEvidence;
};

export type RecoveryVerdict =
  | { verdict: 'redeliverable'; epoch: number }
  | { verdict: 'consumed'; at: string }
  /** Not fenced, so the guess stays ambiguous; the reservation is left untouched. */
  | { verdict: 'ambiguous'; since: string }
  | { verdict: 'not-reserved'; at: string }
  | { verdict: 'stale-token'; at: string }
  | { verdict: 'unknown-message'; at: string }
  | { verdict: 'unreadable'; at: string };

export type HostQueueOptions = {
  /** The durable store folder; created 0700 when missing. */
  dir: string;
  now?: () => Date;
};

export type HostQueue = {
  enqueue(input: { scope: VerifiedScope; message: HostMessage }): Promise<EnqueueVerdict>;
  claim(scope: VerifiedScope): Promise<ClaimVerdict>;
  ack(key: RelayKey, token: ClaimToken): Promise<FinishVerdict>;
  release(key: RelayKey, token: ClaimToken): Promise<FinishVerdict>;
  recover(input: RecoverInput): Promise<RecoveryVerdict>;
};

export function createHostQueue(options: HostQueueOptions): HostQueue;
