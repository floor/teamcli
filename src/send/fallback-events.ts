// The fallback episode: what TeamCLI records when the delivery order is exhausted.
//
// A send walks its delivery legs in order and appends one transport fact per attempt. This
// module turns those facts into the two signals the owner asked for:
//
//   1. The instant the last live route fails, one event — `message.held`, routed by the existing
//      default `['sender', 'lead']`. Its actual fanout is the sender, every lead of the receiver's
//      team, and the addressed recipient: the payload names the recipient in `to`, as the existing
//      reconcile emitters do, and the bus delivers an event addressed to a seat as well as one a
//      routing word selects (`matchesSubscriber`). Nothing is emitted before that point, and
//      nothing per failed route.
//   2. If no delivery follows within the owner's policy delay — the canonical
//      `delivery-escalation` for the receiving seat's own chain, read by the shared resolver
//      (`deliveryEscalationDelay`), with an explicit shorter legacy
//      `unreachable_threshold_seconds` as a cap and an unreadable chain leaving the episode
//      pending — one escalation to the main (entity) orchestrator: an event addressed to that
//      seat and one signed mailbox record. A later delivery cancels the pending escalation. The
//      escalation event goes to the orchestrator (addressed), the sender and the receiver team's
//      lead, by the same routing.
//
// Every attempt is appended whole to a durable ledger in the project's state store
// (`fallback-attempts-<key>.jsonl`, one JSON line per fact, never rotated). The marker beside the
// message record (`<root>/.agents/send-drops/<session>/<seat>/<id>.fallback.json`) keeps a
// bounded summary of recent attempts plus the lifecycle: `allFailedAt`, `dueAt`, `escalatedAt`,
// `escalatedTo` and a pending `outbox` intent. The marker, not the event log, is the replay-
// lifetime proof: the log rotates and `appendEvent`'s dedup index is rebuilt from whatever
// segments survived, so a second process or a restart could otherwise see an empty index.
//
// Each event this module emits is also recorded, with its signed record, in the episode's
// publication ledger (`fallback-published-<key>.jsonl`, append-only) immediately after the append
// and before the marker's intent clears. That record is what keeps replay dedup alive when the
// event-log segments holding the event are dropped by retention: recovery finds the published
// record and appends nothing.
//
// Publication is at-least-once, not globally exactly-once. The ledger deduplicates a retry once
// its line lands; a crash between the append and that line leaves `appendEvent`'s
// retained-history dedup as the only guard. Single effect therefore rests on the receiver and the
// subscriber deduplicating over the replay lifetime by the deterministic event identity — every
// attempt carries the same record id — and this module makes no global exactly-once claim. There
// is deliberately one ledger per concern (attempts, publications); none exists merely to narrow
// that crash gap.
//
// A call takes a lock on the episode's canonical key (a directory under the store's `locks/`,
// held by `withLock`), so attempts, a due escalation and a delivery cannot interleave their
// read-modify-write. The event is emitted through an outbox intent written to the marker first:
// a crash between the intent and the append leaves the intent for the next pass, and
// `appendEvent`'s deterministic record id makes the retry a duplicate rather than a second event.
// A delivery arriving in that window cancels the intent: the message is not undelivered.
//
// The key is (canonical recipient, message id). The record digest is an immutable value of that
// key, checked on every fact: a fact that reuses the key with another digest is a conflict and
// writes nothing. It is never an extra dimension of the key. Every deterministic id this module
// mints — event record id and mailbox id — hashes the canonical key, so one message id sent to
// two recipients in one session cannot share an event or a mailbox record. The recipient is the
// one TeamCLI verified (team, seat, registry id, session, root); the sender is the verified
// `Caller` the host passes beside the fact. Nothing here reads an identity out of a payload.
//
// A transport receipt is stored as it came, as an object: `stored` with its id,
// `maybe-consumed`, or — when the transport returned none — explicit `unknown`. None of these is
// a read, and none advances a message status. A transport fact never says `answered` or `read`.
// The route is the delivery order's own word (a string): this module imposes no order and no
// socket-first rule.
//
// Scope: no enqueue, claim or consume — the queue belongs to the delivery-queue owner — and no
// import of the relay package before its SHA lands. The host adapts its transport fact to
// `TransportFact` and calls `noteTransport`; a daemon calls `escalateDue` to resume pending
// episodes. Routing and delay are TeamCLI's, resolved from the signed chain; the transport
// receives neither.
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logTag, type Caller } from '../caller.ts';
import { appendEvent, verifySignedEvent, type EventAppendInput, type SignedEventRecord } from '../bus/log.ts';
import { writeRuntimeMailboxRecord } from '../bus/owner.ts';
import { readEntityOrchestrator, type EntityOrchestrator } from '../bus/seats.ts';
import { recordDir } from '../commands/messages.ts';
import { projectIdOfTeam } from '../dev_mode.ts';
import type { TeamFile } from '../file/types.ts';
import { deliveryEscalationDelay, type DeliveryEscalationSource } from '../policy/delivery.ts';
import { teamIdOf } from '../registry/teams.ts';
import { withLock } from '../state.ts';
import { appendStoreLine, ensureStoreLadder, historyPath, readNoFollow } from './history.ts';
import { dropMessage } from './native.ts';

/** The receiver as TeamCLI verified it: the registry team and seat, the seat's registry id when
 *  one exists, the session the seat stands in, and the checkout the record is written under. */
export type CanonicalRecipient = {
  team: string;
  seat: string;
  toId: string | null;
  session: string;
  root: string;
};

/** The delivery order's own name for the leg an attempt took. Opaque here: TeamCLI's order is
 *  preserved exactly as the host walked it, socket first only when the order says so. */
export type TransportRoute = string;

/** The words a transport fact may use. No `answered` and no `read`: a transport carries, it does
 *  not read. `held` means the record was stored but no seat was woken. */
export type AttemptOutcome = 'delivered' | 'held' | 'timeout' | 'unreachable' | 'refused';

/** What the transport returned for an attempt, kept typed. A missing receipt is explicit
 *  `unknown`, never an empty string; `maybe-consumed` says a kernel write may have landed and no
 *  acknowledgement came back, so a retry may duplicate. None of these is proof of consumption. */
export type RelayReceipt =
  | { kind: 'unknown' }
  | { kind: 'maybe-consumed' }
  | { kind: 'stored'; id: string };

/** One attempt, as the host hands it in after a live route failed, held, or delivered. */
export type TransportFact = {
  recipient: CanonicalRecipient;
  /** The message id, never re-minted; half of the episode key. */
  messageId: string;
  /** The digest of the signed record bytes. Checked as a value of the key, never a key part. */
  recordDigest: string;
  route: TransportRoute;
  outcome: AttemptOutcome;
  /** ISO, the TeamCLI clock. */
  at: string;
  /** The bounded attempt's duration. */
  ms: number;
  reason?: string;
  receipt?: RelayReceipt;
  /** Whether the order still holds a live route after this one. A `held` or failed attempt with a
   *  live route left is a continuation; only the last route's failure is exhaustion. */
  liveRoutesRemain: boolean;
};

/** Everything the callbacks share: the verified sender, the team file in force, the checkout and
 *  home the record and the log live under, and the clock. `orchestrator` lets a host that already
 *  resolved the entity lead pass it in; absent, the registry answers (or names none).
 *  `recipientTeam` is the receiving team's validated file when the receiver stands in another
 *  checkout: the escalation delay reads the receiver's chain, never the sender's, so a
 *  cross-root episode without it stays pending instead of borrowing this team's policy. */
export type FallbackContext = {
  caller: Caller;
  team: TeamFile;
  root: string;
  home: string;
  now: () => Date;
  orchestrator?: EntityOrchestrator | null;
  recipientTeam?: TeamFile;
};

/** One attempt, as the marker's bounded summary keeps it. The durable ledger keeps every one. */
export type AttemptRecord = {
  route: TransportRoute;
  outcome: AttemptOutcome;
  at: string;
  ms: number;
  reason?: string;
  receipt: RelayReceipt;
};

/** An event the episode decided to emit, written to the marker before the append: the outbox. A
 *  crash before the event goes out leaves the intent for the next pass to retry. */
export type EventIntent = {
  kind: 'all-failed' | 'escalated';
  recordId: string;
  at: string;
  /** The route whose failure ended the order, on an all-failed intent. */
  route?: string;
  /** The escalation sentence, fixed when the intent is formed so a retry repeats it exactly. */
  reason?: string;
};

/** The episode's durable state, written beside the record. The recipient is part of the identity,
 *  so a marker found by a scan is checked against the fact that names it. */
export type FallbackMarker = {
  format: 1;
  messageId: string;
  recipient: CanonicalRecipient;
  recordDigest: string;
  /** The sender's log tag, fixed at the first fact: a restart reuses it for the escalation. */
  sender: string;
  status: 'trying' | 'all-failed' | 'delivered';
  /** The most recent attempts: a summary. `attemptLedgerFileName` names the full ledger. */
  attempts: AttemptRecord[];
  allFailedAt?: string;
  /** ISO: the first instant the delayed escalation may fire. Cleared by a delivery. */
  dueAt?: string;
  /** ISO: when the main escalation was decided. Its presence is what makes a repeat a no-op. */
  escalatedAt?: string;
  /** The entity lead the escalation was addressed to, fixed with `escalatedAt` so a retry after a
   *  restart reaches the same seat even if the registry moved. */
  escalatedTo?: EntityOrchestrator;
  /** An event decided but not yet confirmed appended. Cleared once the append returns. */
  outbox?: EventIntent;
  receipt: RelayReceipt;
  updatedAt: string;
};

/** The result of one transport fact. `duplicate` means the episode already recorded this state
 *  and nothing new was emitted. A conflict writes nothing at all. */
export type FallbackNote =
  | {
      ok: true;
      state: 'continued' | 'delivered' | 'duplicate' | 'all-failed';
      marker: FallbackMarker;
      /** An event confirmed during this call: the exhaustion event, or an intent a crash left. */
      event?: SignedEventRecord;
      /** Whether the event append found its record already in the retained log. */
      eventDuplicate: boolean;
      /** The pending main escalation's instant, when one is scheduled. */
      dueAt: string | null;
      /** Why the policy delay could not be resolved; the episode is still recorded and a later
       *  `escalateDue` pass retries the resolution. */
      policyRefusal?: string;
    }
  | { ok: false; kind: 'conflict' | 'marker'; reason: string };

export type EscalationEntry = {
  messageId: string;
  recipient: CanonicalRecipient;
  event: SignedEventRecord;
  /** Whether the escalation event was already in the retained log (an append that ran twice). */
  duplicate: boolean;
  /** The orchestrator's mailbox record, when one was written. */
  mailbox: string | null;
};

export type EscalationReport = {
  escalated: EscalationEntry[];
  refused: { messageId: string; recipient: CanonicalRecipient; reason: string }[];
  /** Markers a pass found but could not trust. They are reported, never overwritten. */
  unreadable: string[];
  /** How many trusted markers the pass read, due or not. */
  scanned: number;
};

/** The most attempts the marker keeps as a summary. The ledger keeps every one; this bound only
 *  keeps the marker legible and its writes small. */
export const MARKER_ATTEMPT_LIMIT = 16;

/** `(canonical recipient, message id)`, with NUL separators so no two tuples can spell one key. */
export function fallbackKeyOf(recipient: CanonicalRecipient, messageId: string): string {
  return [recipient.team, recipient.seat, recipient.session, recipient.root, messageId].join('\u0000');
}

/** A stable 16-hex digest of the episode key, for ids and file names. */
function episodeHash(recipient: CanonicalRecipient, messageId: string): string {
  return createHash('sha256').update(fallbackKeyOf(recipient, messageId)).digest('hex').slice(0, 16);
}

/** The marker's path: a derivative file beside the message record. */
export function markerPathOf(recipient: CanonicalRecipient, messageId: string): string {
  return join(recordDir(recipient.root, recipient.session, recipient.seat), `${messageId}.fallback.json`);
}

/** The full attempt ledger's file name in the project's state store. Append-only, never rotated. */
export function attemptLedgerFileName(recipient: CanonicalRecipient, messageId: string): string {
  return `fallback-attempts-${episodeHash(recipient, messageId)}.jsonl`;
}

/** The episode's publication ledger: each event confirmed appended is recorded here with its
 *  signed record, so replay dedup outlives the event log's retention. Append-only, never rotated. */
export function publicationLedgerFileName(recipient: CanonicalRecipient, messageId: string): string {
  return `fallback-published-${episodeHash(recipient, messageId)}.jsonl`;
}

/** The event record id of the immediate all-failed event: deterministic per episode, and derived
 *  from the canonical recipient as well as the message id, so two recipients of one message id in
 *  one session never share an event key. */
export function allFailedRecordId(recipient: CanonicalRecipient, messageId: string): string {
  return `fallback:all-failed:${episodeHash(recipient, messageId)}`;
}

/** The event record id of the delayed main escalation: deterministic per episode. */
export function escalatedRecordId(recipient: CanonicalRecipient, messageId: string): string {
  return `fallback:main-escalated:${episodeHash(recipient, messageId)}`;
}

/** The mailbox id of the delayed main escalation. A hash keeps the name safe whatever the message
 *  id holds, and deterministic, so `once: true` finds an earlier publication. */
export function escalationMailboxId(recipient: CanonicalRecipient, messageId: string): string {
  return `evt-fallback-${episodeHash(recipient, messageId)}`;
}

/** The resolved main-escalation delay. `ms` is null exactly when the receiving seat's chain would
 *  not resolve; `source` names which word answered, as the shared resolver names it. */
export type EscalationDelay = {
  ms: number | null;
  seconds?: number;
  source?: DeliveryEscalationSource;
  refusal?: string;
};

/**
 * Resolve the main-escalation delay from the receiving seat's own policy chain through the one
 * shared reader, `deliveryEscalationDelay`: the canonical `delivery-escalation`, an explicit
 * shorter legacy `event-unreachable-threshold-seconds` as a cap, and the canonical 300 s release
 * default otherwise. The chain read is the recipient's — its root, team and seat — never the
 * sender's: a receiver in another root without its own team file in hand stays pending rather
 * than reading the sender's chain. An unreadable or invalid chain schedules nothing and says why
 * — never a fallback delay — and the episode is still recorded; a later pass under a readable
 * chain schedules it from the original failure time. This module implements no route timing and
 * no compatibility rule of its own.
 */
export function escalationDelayOf(
  ctx: FallbackContext,
  recipient: CanonicalRecipient,
  at: string,
): EscalationDelay {
  const team = ctx.recipientTeam ?? (recipient.root === ctx.root ? ctx.team : null);
  if (team === null) {
    return {
      ms: null,
      refusal: `no team file is in hand for the receiver's root ${recipient.root}: the sender's chain is never read for another team`,
    };
  }
  const resolved = deliveryEscalationDelay({
    home: ctx.home,
    entity: team.entity ?? '',
    projectId: projectIdOfTeam(ctx.home, team, recipient.root) ?? '',
    root: recipient.root,
    team,
    seat: recipient.seat,
    now: new Date(at),
  });
  if (!resolved.ok) return { ms: null, refusal: resolved.why };
  return { ms: resolved.seconds * 1000, seconds: resolved.seconds, source: resolved.source };
}

/**
 * Record one transport fact in the message's fallback episode.
 *
 * The episode key is (recipient, messageId); `recordDigest` must match a marker already there, or
 * the call refuses as a conflict and writes nothing. The attempt is appended to the durable
 * ledger first; a ledger that cannot be written refuses the call, so no attempt goes unrecorded.
 * A delivered fact ends the episode, cancels any pending escalation and cancels an event intent
 * a crash left behind. A failed or held fact while the order still holds a live route is a
 * continuation. The first failure with no live route left writes a durable all-failed intent and
 * appends exactly one `message.held` event; any later fact for a finished episode is a duplicate
 * and appends no second event, including after a restart and after the event log rotated away.
 *
 * The whole read-modify-write holds the episode's key lock, so a concurrent attempt, escalation
 * or delivery cannot overwrite or reopen it.
 */
export function noteTransport(ctx: FallbackContext, fact: TransportFact): FallbackNote {
  const problem = factProblem(fact);
  if (problem !== null) return { ok: false, kind: 'marker', reason: problem };
  try {
    return withKeyLock(ctx, fact.recipient, fact.messageId, () => noteLocked(ctx, fact));
  } catch (error) {
    return { ok: false, kind: 'marker', reason: errorMessage(error) };
  }
}

function noteLocked(ctx: FallbackContext, fact: TransportFact): FallbackNote {
  const path = markerPathOf(fact.recipient, fact.messageId);
  const read = markerAt(path);
  if (read.kind === 'unreadable') return { ok: false, kind: 'marker', reason: read.reason };
  let marker = read.marker;

  if (marker !== null) {
    if (!sameRecipient(marker.recipient, fact.recipient)) {
      return {
        ok: false,
        kind: 'conflict',
        reason: `fallback: ${fact.messageId} already names another recipient than ${fact.recipient.seat}`,
      };
    }
    if (marker.recordDigest !== fact.recordDigest) {
      return {
        ok: false,
        kind: 'conflict',
        reason: `fallback: ${fact.messageId} already records another digest than this record`,
      };
    }
  } else {
    marker = {
      format: 1,
      messageId: fact.messageId,
      recipient: fact.recipient,
      recordDigest: fact.recordDigest,
      sender: logTag(ctx.caller),
      status: 'trying',
      attempts: [],
      receipt: { kind: 'unknown' },
      updatedAt: fact.at,
    };
  }

  const receipt = normalizeReceipt(fact.receipt);
  const attempt: AttemptRecord = {
    route: fact.route,
    outcome: fact.outcome,
    at: fact.at,
    ms: fact.ms,
    ...(fact.reason !== undefined ? { reason: fact.reason } : {}),
    receipt,
  };

  // Every attempt is recorded whole, before any state moves. A ledger that cannot be written
  // refuses the call; the host may retry the same fact.
  const ledger = appendStoreLine(
    ctx.team.project,
    fact.recipient.root,
    ctx.home,
    attemptLedgerFileName(fact.recipient, fact.messageId),
    {
      ts: fact.at,
      messageId: fact.messageId,
      recipient: fact.recipient,
      recordDigest: fact.recordDigest,
      route: fact.route,
      outcome: fact.outcome,
      ms: fact.ms,
      ...(fact.reason !== undefined ? { reason: fact.reason } : {}),
      receipt,
    },
    { rotate: false, label: 'the fallback attempt ledger' },
  );
  if (!ledger.ok) {
    return { ok: false, kind: 'marker', reason: `the attempt was not recorded: ${ledger.reason}` };
  }

  const wasDelivered = marker.status === 'delivered';
  marker.attempts = [...marker.attempts, attempt].slice(-MARKER_ATTEMPT_LIMIT);
  marker.receipt = receipt;
  marker.updatedAt = fact.at;

  if (fact.outcome === 'delivered') {
    if (!wasDelivered) {
      marker.status = 'delivered';
      delete marker.dueAt;
    }
    // Recovery cancels a pending escalation — one a restart had already scheduled included —
    // because the message is not undelivered after all. The immediate all-failed event is an
    // invariant of the episode, not a prediction: an intent a crash left is still drained, even
    // though the message has now arrived.
    if (marker.outbox?.kind === 'escalated') delete marker.outbox;
    let flushed: FlushResult;
    try {
      flushed = flushOutbox(ctx, marker, path);
    } catch (error) {
      return { ok: false, kind: 'marker', reason: errorMessage(error) };
    }
    if (!flushed.ok) return { ok: false, kind: 'marker', reason: flushed.reason };
    const wrote = writeMarker(path, marker);
    if (!wrote.ok) return { ok: false, kind: 'marker', reason: wrote.reason };
    return {
      ok: true,
      state: wasDelivered ? 'duplicate' : 'delivered',
      marker,
      ...(flushed.event !== null ? { event: flushed.event } : {}),
      eventDuplicate: flushed.duplicate,
      dueAt: marker.dueAt ?? null,
    };
  }

  // An intent an earlier process wrote before its event went out is retried now, under this key's
  // lock. A delivery above cancelled one instead.
  let drained: FlushResult;
  try {
    drained = flushOutbox(ctx, marker, path);
  } catch (error) {
    return { ok: false, kind: 'marker', reason: errorMessage(error) };
  }
  if (!drained.ok) return { ok: false, kind: 'marker', reason: drained.reason };
  const eventFields = drained.event === null ? {} : { event: drained.event };

  if (wasDelivered) {
    const wrote = writeMarker(path, marker);
    if (!wrote.ok) return { ok: false, kind: 'marker', reason: wrote.reason };
    return {
      ok: true,
      state: 'duplicate',
      marker,
      eventDuplicate: drained.duplicate,
      dueAt: marker.dueAt ?? null,
      ...eventFields,
    };
  }

  if (marker.allFailedAt !== undefined) {
    // The marker, not the rotated log, is what makes this a repeat.
    const wrote = writeMarker(path, marker);
    if (!wrote.ok) return { ok: false, kind: 'marker', reason: wrote.reason };
    return {
      ok: true,
      state: 'duplicate',
      marker,
      eventDuplicate: drained.duplicate,
      dueAt: marker.dueAt ?? null,
      ...eventFields,
    };
  }

  if (fact.liveRoutesRemain) {
    marker.status = 'trying';
    const wrote = writeMarker(path, marker);
    if (!wrote.ok) return { ok: false, kind: 'marker', reason: wrote.reason };
    return {
      ok: true,
      state: 'continued',
      marker,
      eventDuplicate: drained.duplicate,
      dueAt: marker.dueAt ?? null,
      ...eventFields,
    };
  }

  // First exhaustion: schedule, then persist the event intent, then emit it. A crash after the
  // intent and before the append leaves an episode the next pass drains.
  marker.status = 'all-failed';
  marker.allFailedAt = fact.at;
  const delay = escalationDelayOf(ctx, fact.recipient, fact.at);
  if (delay.ms !== null) marker.dueAt = new Date(Date.parse(fact.at) + delay.ms).toISOString();
  else delete marker.dueAt;
  marker.outbox = {
    kind: 'all-failed',
    recordId: allFailedRecordId(fact.recipient, fact.messageId),
    at: fact.at,
    route: fact.route,
  };
  const intent = writeMarker(path, marker);
  if (!intent.ok) return { ok: false, kind: 'marker', reason: intent.reason };

  let flushed: FlushResult;
  try {
    flushed = flushOutbox(ctx, marker, path);
  } catch (error) {
    return { ok: false, kind: 'marker', reason: errorMessage(error) };
  }
  if (!flushed.ok) return { ok: false, kind: 'marker', reason: flushed.reason };
  return {
    ok: true,
    state: 'all-failed',
    marker,
    ...(flushed.event !== null ? { event: flushed.event } : {}),
    eventDuplicate: flushed.duplicate,
    dueAt: marker.dueAt ?? null,
    ...(delay.refusal !== undefined ? { policyRefusal: delay.refusal } : {}),
  };
}

/**
 * Fire the delayed main escalation for every episode whose `dueAt` has passed and whose delivery
 * has not followed, and retry event intents a crash left pending. The scan reads markers under
 * `ctx.root`; an episode is processed under its own key lock and re-read inside it, so a pass
 * running beside a send cannot fire twice or act on a stale marker.
 *
 * Idempotent: `escalatedAt` in the marker makes a second call — in this process, after a restart,
 * or after the event log rotated — write nothing. A delivery that arrived first has already
 * cleared `dueAt` and any intent. When the entity orchestrator does not resolve, the entry is
 * refused and left pending, so a pass under a repaired registry can still raise it. When the
 * escalation delay cannot be resolved, no escalation is scheduled — fail closed — and the refusal
 * is reported; a later pass under a readable chain schedules it from the original failure time.
 */
export function escalateDue(ctx: FallbackContext, options: { at?: Date } = {}): EscalationReport {
  const at = options.at ?? ctx.now();
  const atIso = at.toISOString();
  const report: EscalationReport = { escalated: [], refused: [], unreadable: [], scanned: 0 };

  for (const found of markersUnder(ctx.root)) {
    if (found.kind === 'unreadable') {
      report.unreadable.push(found.path);
      continue;
    }
    const { recipient, messageId } = found.marker;
    let step: EscalationStep;
    try {
      step = withKeyLock(ctx, recipient, messageId, () => escalateOne(ctx, recipient, messageId, at, atIso));
    } catch (error) {
      step = { kind: 'refused', reason: errorMessage(error) };
    }
    if (step.kind === 'none') continue;
    report.scanned += 1;
    if (step.kind === 'unreadable') report.unreadable.push(step.path);
    else if (step.kind === 'refused') report.refused.push({ messageId, recipient, reason: step.reason });
    else if (step.kind === 'escalated') report.escalated.push(step.entry);
  }
  return report;
}

type EscalationStep =
  | { kind: 'none' }
  | { kind: 'idle' }
  | { kind: 'unreadable'; path: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'escalated'; entry: EscalationEntry };

function escalateOne(
  ctx: FallbackContext,
  recipient: CanonicalRecipient,
  messageId: string,
  at: Date,
  atIso: string,
): EscalationStep {
  const path = markerPathOf(recipient, messageId);
  const read = markerAt(path);
  if (read.kind === 'unreadable') return { kind: 'unreadable', path };
  if (read.kind === 'none') return { kind: 'none' };
  const marker = read.marker;
  if (!sameRecipient(marker.recipient, recipient) || marker.messageId !== messageId) {
    return { kind: 'refused', reason: `${path}: the marker names another episode` };
  }

  // A pending intent comes first, whatever the state: a crash before an event is retried here.
  // An escalation intent on an already-delivered episode is cancelled instead: the delivery came
  // first, so the escalation never went out and must not now.
  if (marker.status === 'delivered' && marker.outbox?.kind === 'escalated') {
    delete marker.outbox;
    const cancelled = writeMarker(path, marker);
    if (!cancelled.ok) return { kind: 'refused', reason: cancelled.reason };
  }
  const drained = flushOutbox(ctx, marker, path);
  if (!drained.ok) return { kind: 'refused', reason: drained.reason };
  if (drained.kind === 'escalated' && drained.event !== null) {
    return {
      kind: 'escalated',
      entry: {
        messageId,
        recipient,
        event: drained.event,
        duplicate: drained.duplicate,
        mailbox: drained.mailbox,
      },
    };
  }

  if (marker.status !== 'all-failed') return { kind: 'idle' };
  if (marker.escalatedAt !== undefined) return { kind: 'idle' };

  if (marker.dueAt === undefined) {
    // The first pass ran under an unreadable policy and scheduled nothing. Retry the resolution
    // now, from the original failure instant, and keep the episode unscheduled while it refuses.
    const delay = escalationDelayOf(ctx, marker.recipient, marker.allFailedAt ?? atIso);
    if (delay.ms === null) {
      return { kind: 'refused', reason: `the escalation delay is unreadable: ${delay.refusal ?? 'no delay resolved'}` };
    }
    marker.dueAt = new Date(Date.parse(marker.allFailedAt ?? atIso) + delay.ms).toISOString();
    const wrote = writeMarker(path, marker);
    if (!wrote.ok) return { kind: 'refused', reason: wrote.reason };
  }
  const due = Date.parse(marker.dueAt);
  if (!Number.isFinite(due) || due > at.getTime()) return { kind: 'idle' };

  const orchestrator =
    ctx.orchestrator !== undefined
      ? ctx.orchestrator
      : readEntityOrchestrator(ctx.home, teamIdOf(marker.recipient.root));
  if (orchestrator === null) {
    return { kind: 'refused', reason: `no main orchestrator resolves for ${marker.recipient.team}` };
  }

  const seconds = Math.round((at.getTime() - Date.parse(marker.allFailedAt ?? atIso)) / 1000);
  marker.escalatedAt = atIso;
  marker.escalatedTo = orchestrator;
  marker.updatedAt = atIso;
  marker.outbox = {
    kind: 'escalated',
    recordId: escalatedRecordId(recipient, messageId),
    at: atIso,
    reason: `still undelivered after ${seconds}s: all live routes failed`,
  };
  const intent = writeMarker(path, marker);
  if (!intent.ok) return { kind: 'refused', reason: intent.reason };

  const flushed = flushOutbox(ctx, marker, path);
  if (!flushed.ok) return { kind: 'refused', reason: flushed.reason };
  if (flushed.event === null) return { kind: 'refused', reason: `${path}: the escalation intent emitted no event` };
  return {
    kind: 'escalated',
    entry: { messageId, recipient, event: flushed.event, duplicate: flushed.duplicate, mailbox: flushed.mailbox },
  };
}

type FlushResult =
  | { ok: true; kind: EventIntent['kind'] | null; event: SignedEventRecord | null; duplicate: boolean; mailbox: string | null }
  | { ok: false; reason: string };

/**
 * Emit the marker's pending intent, then clear it. Called under the episode's key lock. A
 * confirmed append is first recorded with its signed record in the episode's publication ledger,
 * which retention never removes, so a retry finds the published record even after the event log's
 * segments rotated and appends nothing. The deterministic record id makes a retry within retained
 * history an `appendEvent` duplicate; the mailbox is `once`, so a retry after a mailbox failure
 * finds the first record. The intent stays in the marker until both writes return, so a crash in
 * this function is retried next pass.
 */
function flushOutbox(ctx: FallbackContext, marker: FallbackMarker, path: string): FlushResult {
  const intent = marker.outbox;
  if (intent === undefined) return { ok: true, kind: null, event: null, duplicate: false, mailbox: null };

  let input: EventAppendInput;
  let mailbox: string | null = null;
  if (intent.kind === 'all-failed') {
    input = {
      ts: intent.at,
      kind: 'message.held',
      session: marker.recipient.session,
      record_id: intent.recordId,
      from: marker.sender,
      to: marker.recipient.seat,
      seat: marker.recipient.seat,
      thread: marker.messageId,
      via: intent.route ?? 'fallback',
      reason: 'all live routes failed',
    };
  } else {
    const target = marker.escalatedTo;
    if (target === undefined) {
      return { ok: false, reason: `fallback: ${marker.messageId} has an escalation intent with no recorded target` };
    }
    input = {
      ts: intent.at,
      kind: 'message.held',
      session: marker.recipient.session,
      record_id: intent.recordId,
      from: marker.sender,
      to: target.seat,
      seat: marker.recipient.seat,
      thread: marker.messageId,
      via: 'fallback',
      reason: intent.reason ?? 'still undelivered: all live routes failed',
    };
  }

  // A confirmed append is recorded with its signed record in the episode's publication ledger
  // before the marker changes. The event log's own dedup only sees the segments retention kept;
  // this ledger outlives them, so a recovery after rotation appends nothing and reuses the record.
  const published = publicationOf(ctx, marker.recipient, marker.messageId, intent.recordId);
  if (published.kind === 'unreadable') return { ok: false, reason: published.reason };
  let appendedRecord: SignedEventRecord;
  let duplicate: boolean;
  if (published.kind === 'ok') {
    appendedRecord = published.record;
    duplicate = true;
  } else {
    const result = appendEvent(ctx.team.project, marker.recipient.root, ctx.home, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    appendedRecord = result.record;
    duplicate = result.duplicate;
    const recorded = recordPublication(ctx, marker, intent, result.record);
    if (!recorded.ok) return { ok: false, reason: recorded.reason };
  }

  if (intent.kind === 'escalated') {
    const target = marker.escalatedTo!;
    // An orchestrator that is the recipient itself is reached by the event alone; a mailbox
    // record to the same seat would be a second copy of it.
    if (target.seat !== marker.recipient.seat) {
      const wrote = writeRuntimeMailboxRecord({
        root: target.root,
        home: ctx.home,
        to: target.seat,
        id: escalationMailboxId(marker.recipient, marker.messageId),
        text: intent.reason ?? `all live routes to ${marker.recipient.seat} failed; message ${marker.messageId} is still undelivered`,
        session: target.session,
        at: intent.at,
        once: true,
      });
      if (!wrote.ok) {
        // The event stands; the intent stays, so the next pass retries the mailbox.
        return { ok: false, reason: wrote.error };
      }
      mailbox = wrote.path;
    }
  }

  delete marker.outbox;
  const wrote = writeMarker(path, marker);
  if (!wrote.ok) return { ok: false, reason: wrote.reason };
  return { ok: true, kind: intent.kind, event: appendedRecord, duplicate, mailbox };
}

type PublicationRead =
  | { kind: 'ok'; record: SignedEventRecord }
  | { kind: 'none' }
  | { kind: 'unreadable'; reason: string };

function publicationPathOf(ctx: FallbackContext, recipient: CanonicalRecipient, messageId: string): string {
  return join(
    dirname(historyPath(ctx.team.project, recipient.root, ctx.home)),
    publicationLedgerFileName(recipient, messageId),
  );
}

/** Find the signed record this episode already published under `recordId`. A ledger that exists
 *  but cannot be read stops the caller: re-appending from a guess could duplicate the event. */
function publicationOf(
  ctx: FallbackContext,
  recipient: CanonicalRecipient,
  messageId: string,
  recordId: string,
): PublicationRead {
  const path = publicationPathOf(ctx, recipient, messageId);
  const text = readNoFollow(path);
  if (text === null) return { kind: 'unreadable', reason: `${path}: the publication ledger could not be read` };
  let found: SignedEventRecord | null = null;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { kind: 'unreadable', reason: `${path}: the publication ledger is not JSON lines` };
    }
    if (parsed === null || typeof parsed !== 'object') {
      return { kind: 'unreadable', reason: `${path}: a publication line has an unknown shape` };
    }
    const entry = parsed as Record<string, unknown>;
    if (entry.recordId !== recordId) continue;
    const record = signedRecordOf(entry.record);
    if (record === null || !verifies(record, ctx.home)) {
      return { kind: 'unreadable', reason: `${path}: the published record is not a verified event` };
    }
    found = record;
  }
  return found === null ? { kind: 'none' } : { kind: 'ok', record: found };
}

function recordPublication(
  ctx: FallbackContext,
  marker: FallbackMarker,
  intent: EventIntent,
  record: SignedEventRecord,
): { ok: true } | { ok: false; reason: string } {
  const wrote = appendStoreLine(
    ctx.team.project,
    marker.recipient.root,
    ctx.home,
    publicationLedgerFileName(marker.recipient, marker.messageId),
    { ts: intent.at, recordId: intent.recordId, kind: intent.kind, record },
    { rotate: false, label: 'the fallback publication ledger' },
  );
  if (!wrote.ok) return { ok: false, reason: `the published event was not recorded: ${wrote.reason}` };
  return { ok: true };
}

function signedRecordOf(value: unknown): SignedEventRecord | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.signature !== 'string' || raw.signature === '') return null;
  if (raw.payload === null || typeof raw.payload !== 'object') return null;
  return raw as unknown as SignedEventRecord;
}

function verifies(record: SignedEventRecord, home: string): boolean {
  try {
    return verifySignedEvent(record, home);
  } catch {
    return false;
  }
}

/** The lock's directory, unique per canonical episode key, under the project's state store. */
function withKeyLock<T>(ctx: FallbackContext, recipient: CanonicalRecipient, messageId: string, work: () => T): T {
  const storeDir = dirname(historyPath(ctx.team.project, recipient.root, ctx.home));
  const ladder = ensureStoreLadder(storeDir, ctx.home);
  if (ladder !== null) throw new Error(ladder);
  return withLock(join(storeDir, 'locks', `fallback-${episodeHash(recipient, messageId)}`), work, { waitMs: 10_000 });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type MarkerRead =
  | { kind: 'none'; marker: null }
  | { kind: 'ok'; marker: FallbackMarker }
  | { kind: 'unreadable'; reason: string };

function markerAt(path: string): MarkerRead {
  const text = readNoFollow(path);
  if (text === null) return { kind: 'unreadable', reason: `${path}: the fallback marker could not be read` };
  if (text === '') return { kind: 'none', marker: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', reason: `${path}: the fallback marker is not JSON` };
  }
  const marker = markerOf(parsed);
  if (marker === null) return { kind: 'unreadable', reason: `${path}: the fallback marker has an unknown shape` };
  return { kind: 'ok', marker };
}

function writeMarker(path: string, marker: FallbackMarker): { ok: true } | { ok: false; reason: string } {
  try {
    dropMessage(dirname(path), `${marker.messageId}.fallback.json`, `${JSON.stringify(marker, null, 2)}\n`);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `${path}: ${String(error)}` };
  }
}

/** All markers under a root's transport tree, sessions and seats sorted so a pass is ordered. A
 *  marker that cannot be trusted is returned as its path, never rewritten from a guess. */
function markersUnder(root: string): ({ kind: 'ok'; path: string; marker: FallbackMarker } | { kind: 'unreadable'; path: string })[] {
  const found: ({ kind: 'ok'; path: string; marker: FallbackMarker } | { kind: 'unreadable'; path: string })[] = [];
  const base = join(root, '.agents', 'send-drops');
  for (const session of folderNames(base)) {
    const sessionDir = join(base, session);
    for (const seat of folderNames(sessionDir)) {
      const seatDir = join(sessionDir, seat);
      for (const name of fileNames(seatDir)) {
        if (!name.endsWith('.fallback.json')) continue;
        const path = join(seatDir, name);
        const read = markerAt(path);
        if (read.kind === 'ok') found.push({ kind: 'ok', path, marker: read.marker });
        else if (read.kind === 'unreadable') found.push({ kind: 'unreadable', path });
      }
    }
  }
  return found;
}

function folderNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function fileNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function sameRecipient(a: CanonicalRecipient, b: CanonicalRecipient): boolean {
  return a.team === b.team && a.seat === b.seat && a.toId === b.toId && a.session === b.session && a.root === b.root;
}

function normalizeReceipt(value: unknown): RelayReceipt {
  if (value === null || typeof value !== 'object') return { kind: 'unknown' };
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'maybe-consumed') return { kind: 'maybe-consumed' };
  if (kind === 'stored') {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id !== '') return { kind: 'stored', id };
  }
  // A receipt this module does not know — a string cast, a future kind — is explicitly unknown.
  return { kind: 'unknown' };
}

const OUTCOMES: readonly AttemptOutcome[] = ['delivered', 'held', 'timeout', 'unreachable', 'refused'];
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SEGMENT = /^[^/\\\u0000]+$/;

/** Anything the host could hand in that is not a usable fact is refused before a write, so a
 *  malformed value can never mint a marker, a ledger line or an event. */
function factProblem(fact: TransportFact): string | null {
  const r = fact.recipient;
  if (!SEGMENT.test(r.team) || !SEGMENT.test(r.seat) || !SEGMENT.test(r.session)) {
    return 'fallback: the recipient team, seat or session is not a usable name';
  }
  if (r.seat === '.' || r.seat === '..' || r.session === '.' || r.session === '..') {
    return 'fallback: the recipient seat or session is not a usable name';
  }
  if (typeof r.root !== 'string' || r.root === '') return 'fallback: the recipient root is missing';
  if (r.toId !== null && (typeof r.toId !== 'string' || r.toId === '')) {
    return 'fallback: the recipient id is neither null nor a name';
  }
  if (!MESSAGE_ID.test(fact.messageId)) return 'fallback: the message id is not usable';
  if (typeof fact.recordDigest !== 'string' || fact.recordDigest === '' || fact.recordDigest.length > 256) {
    return 'fallback: the record digest is missing or unusable';
  }
  if (typeof fact.route !== 'string' || fact.route === '') return 'fallback: the route is missing';
  if (!OUTCOMES.includes(fact.outcome)) return `fallback: "${String(fact.outcome)}" is not an attempt outcome`;
  if (typeof fact.at !== 'string' || !Number.isFinite(Date.parse(fact.at))) {
    return 'fallback: the attempt time is not an instant';
  }
  if (typeof fact.ms !== 'number' || !Number.isFinite(fact.ms) || fact.ms < 0) {
    return 'fallback: the attempt duration is not a duration';
  }
  if (typeof fact.liveRoutesRemain !== 'boolean') return 'fallback: liveRoutesRemain is not a boolean';
  return null;
}

/** A marker read back from disk: the shape is checked before it is trusted or rewritten. */
function markerOf(value: unknown): FallbackMarker | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.format !== 1) return null;
  if (typeof raw.messageId !== 'string' || !MESSAGE_ID.test(raw.messageId)) return null;
  const recipient = recipientOf(raw.recipient);
  if (recipient === null) return null;
  if (typeof raw.recordDigest !== 'string' || raw.recordDigest === '') return null;
  if (typeof raw.sender !== 'string' || raw.sender === '') return null;
  if (raw.status !== 'trying' && raw.status !== 'all-failed' && raw.status !== 'delivered') return null;
  if (!Array.isArray(raw.attempts)) return null;
  const attempts: AttemptRecord[] = [];
  for (const entry of raw.attempts) {
    const attempt = attemptOf(entry);
    if (attempt === null) return null;
    attempts.push(attempt);
  }
  if (typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) return null;
  const marker: FallbackMarker = {
    format: 1,
    messageId: raw.messageId,
    recipient,
    recordDigest: raw.recordDigest,
    sender: raw.sender,
    status: raw.status,
    attempts,
    receipt: normalizeReceipt(raw.receipt),
    updatedAt: raw.updatedAt,
  };
  for (const key of ['allFailedAt', 'dueAt', 'escalatedAt'] as const) {
    const stamp = raw[key];
    if (stamp === undefined) continue;
    if (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp))) return null;
    marker[key] = stamp;
  }
  const target = orchestratorOf(raw.escalatedTo);
  if (raw.escalatedTo !== undefined && target === null) return null;
  if (target !== null) marker.escalatedTo = target;
  const intent = intentOf(raw.outbox);
  if (raw.outbox !== undefined && intent === null) return null;
  if (intent !== null) marker.outbox = intent;
  return marker;
}

function recipientOf(value: unknown): CanonicalRecipient | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  for (const key of ['team', 'seat', 'session', 'root'] as const) {
    if (typeof raw[key] !== 'string' || raw[key] === '') return null;
  }
  if (raw.toId !== null && (typeof raw.toId !== 'string' || raw.toId === '')) return null;
  return {
    team: raw.team as string,
    seat: raw.seat as string,
    toId: raw.toId as string | null,
    session: raw.session as string,
    root: raw.root as string,
  };
}

function orchestratorOf(value: unknown): EntityOrchestrator | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  for (const key of ['seat', 'team', 'root', 'session'] as const) {
    if (typeof raw[key] !== 'string' || raw[key] === '') return null;
  }
  return {
    seat: raw.seat as string,
    team: raw.team as string,
    root: raw.root as string,
    session: raw.session as string,
  };
}

function intentOf(value: unknown): EventIntent | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== 'all-failed' && raw.kind !== 'escalated') return null;
  if (typeof raw.recordId !== 'string' || raw.recordId === '') return null;
  if (typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at))) return null;
  if (raw.route !== undefined && typeof raw.route !== 'string') return null;
  if (raw.reason !== undefined && typeof raw.reason !== 'string') return null;
  const intent: EventIntent = { kind: raw.kind, recordId: raw.recordId, at: raw.at };
  if (typeof raw.route === 'string') intent.route = raw.route;
  if (typeof raw.reason === 'string') intent.reason = raw.reason;
  return intent;
}

function attemptOf(value: unknown): AttemptRecord | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.route !== 'string' || raw.route === '') return null;
  if (!OUTCOMES.includes(raw.outcome as AttemptOutcome)) return null;
  if (typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at))) return null;
  if (typeof raw.ms !== 'number' || !Number.isFinite(raw.ms) || raw.ms < 0) return null;
  if (raw.reason !== undefined && typeof raw.reason !== 'string') return null;
  const attempt: AttemptRecord = {
    route: raw.route,
    outcome: raw.outcome as AttemptOutcome,
    at: raw.at,
    ms: raw.ms,
    receipt: normalizeReceipt(raw.receipt),
  };
  if (typeof raw.reason === 'string') attempt.reason = raw.reason;
  return attempt;
}
