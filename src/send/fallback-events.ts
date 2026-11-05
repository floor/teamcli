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
// Every attempt is appended whole to a durable ledger in the receiving team's state store
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
// read-modify-write. A caller that must not wait — the send whose record is already durable —
// calls `noteTransportSoon`; a busy key then defers the fact whole to a note beside the record,
// and `drainDeferredNotes` records it on a later pass under the same lock. The note carries the
// sender tag too, so a note that is the episode's first fact creates the same marker a locked
// call would have. The event is emitted through an outbox intent written to the marker first:
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
import { type Dir, existsSync, lstatSync, mkdirSync, opendirSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { logTag, type Caller } from '../caller.ts';
import { appendEvent, verifySignedEvent, type EventAppendInput, type SignedEventRecord } from '../bus/log.ts';
import { writeRuntimeMailboxRecord } from '../bus/owner.ts';
import { readEntityOrchestrator, type EntityOrchestrator } from '../bus/seats.ts';
import { recordDir } from '../commands/messages.ts';
import { projectIdOfTeam } from '../dev_mode.ts';
import type { TeamFile } from '../file/types.ts';
import { deliveryEscalationDelay, type DeliveryEscalationSource } from '../policy/delivery.ts';
import { eventThresholdsInForce } from '../policy/thresholds.ts';
import { teamIdOf } from '../registry/teams.ts';
import { LockBusyError, reclaimLockDir, withLock } from '../state.ts';
import { messageKeyState } from '../store/keys.ts';
import { appendStoreLine, ensureFoldersBelow, ensureStoreLadder, historyPath, readNoFollow } from './history.ts';
import { dropMessage } from './native.ts';
import { readSealedRecord, recordAuthOfSealed, recordFile, sameFolder } from './record.ts';

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

/** What an escalation pass needs: everything `noteTransport` takes except the sender's verified
 *  `Caller`. A pass fires markers a host already recorded and never invents an identity — the
 *  event's sender is the tag fixed in the marker at its first fact — so a caller-free daemon can
 *  schedule due escalations without fabricating an owner or a seat. Transport facts still require
 *  the full `FallbackContext`. */
export type EscalationContext = Omit<FallbackContext, 'caller'>;

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
  /** Episodes this pass skipped because another live holder kept their key lock: ordinary
   *  contention, left to the next pass, never an event or a refusal. */
  deferred: { messageId: string; recipient: CanonicalRecipient }[];
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

/** A note deferred beside the record when the episode's key was busy: the fact a caller would
 *  have recorded, named by its own digest so a retried fact rewrites one file, not two. */
export function deferredNotePathOf(recipient: CanonicalRecipient, messageId: string, factId: string): string {
  return join(recordDir(recipient.root, recipient.session, recipient.seat), `${messageId}.fallback-note-${factId}.json`);
}

/** How a deferred note names itself: the marker's own folder, and only these files. */
const DEFERRED_NOTE_NAME = /\.fallback-note-[0-9a-f]{16}\.json$/;

/** The episode's publication ledger: each event confirmed appended is recorded here with its
 *  signed record, so replay dedup outlives the event log's retention. Append-only, never rotated. */
export function publicationLedgerFileName(recipient: CanonicalRecipient, messageId: string): string {
  return `fallback-published-${episodeHash(recipient, messageId)}.jsonl`;
}

/** Where the store keeps a retired episode's marker and attempt ledger. The publication ledger is
 *  never archived: replay dedup must outlive the episode. */
export const FALLBACK_ARCHIVE_DIR = 'fallback-archive';

function episodeArchiveMarkerPath(storeDir: string, recipient: CanonicalRecipient, messageId: string): string {
  return join(storeDir, FALLBACK_ARCHIVE_DIR, 'markers', `${episodeHash(recipient, messageId)}.json`);
}

function episodeArchiveAttemptsPath(storeDir: string, recipient: CanonicalRecipient, messageId: string): string {
  return join(storeDir, FALLBACK_ARCHIVE_DIR, 'attempts', attemptLedgerFileName(recipient, messageId));
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
  ctx: EscalationContext,
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
    return withKeyLock(ctx, fact.recipient, fact.messageId, () => noteLocked(ctx, fact, logTag(ctx.caller)));
  } catch (error) {
    return { ok: false, kind: 'marker', reason: errorMessage(error) };
  }
}

/** A fact written beside the record because the episode's key was busy: the send may return, and
 *  the next `drainDeferredNotes` pass records it under the same lock, exactly once. */
export type DeferredNote = { ok: true; state: 'deferred'; notePath: string };

/**
 * Record one transport fact without waiting on the episode's key. A free key records it exactly
 * as `noteTransport` does and answers the recorder's own result; a key another live holder keeps
 * writes the fact whole to a note beside the record and answers `deferred` at once, so a caller
 * whose record is already durable — a send — never blocks its own line on a busy episode. The
 * drain pass records the note under the same lock; the sender tag rides along so a note that is
 * the episode's first fact creates the same marker a locked call would have fixed.
 *
 * The bus append inside the note is taken with `lockWaitMs: 0` too: a first exhaustion writes its
 * intent into the marker, and a log another live holder keeps leaves that intent for the next
 * pass instead of pausing the send on a busy event lock for the lock's whole budget.
 *
 * A refusal that is not contention (a conflict, a ledger that cannot be written) answers exactly
 * as `noteTransport` would; only contention defers.
 */
export function noteTransportSoon(ctx: FallbackContext, fact: TransportFact): FallbackNote | DeferredNote {
  const problem = factProblem(fact);
  if (problem !== null) return { ok: false, kind: 'marker', reason: problem };
  try {
    return withKeyLock(ctx, fact.recipient, fact.messageId, () => noteLocked(ctx, fact, logTag(ctx.caller), { lockWaitMs: 0 }), 0);
  } catch (error) {
    if (!(error instanceof LockBusyError)) return { ok: false, kind: 'marker', reason: errorMessage(error) };
    // The fact is durable on disk before this returns, so nothing is lost by deferring it.
    try {
      return deferNote(ctx, fact);
    } catch (writeError) {
      return { ok: false, kind: 'marker', reason: errorMessage(writeError) };
    }
  }
}

/** Write the fact whole beside the record, for the next drain pass. A same-fact rewrite lands on
 *  the same name; the file is swapped in whole, so a reader never sees half a fact. */
function deferNote(ctx: FallbackContext, fact: TransportFact): DeferredNote {
  const text = JSON.stringify({ format: 1, sender: logTag(ctx.caller), fact });
  const factId = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const path = deferredNotePathOf(fact.recipient, fact.messageId, factId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, `${text}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return { ok: true, state: 'deferred', notePath: path };
}

/** `dedupe` makes a replayed fact a no-op: an attempt with the same route and instant is already
 *  in the marker, so a note whose earlier drain landed but did not unlink records nothing twice.
 *  `lockWaitMs` bounds this call's bus append: a send passes 0 so a live event-lock holder can
 *  never hold its line, and the intent the marker carries is emitted by the next pass. */
function noteLocked(
  ctx: EscalationContext,
  fact: TransportFact,
  senderTag: string,
  options: { dedupe?: boolean; lockWaitMs?: number } = {},
): FallbackNote {
  const waits = options.lockWaitMs === undefined ? {} : { lockWaitMs: options.lockWaitMs };
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
    // A retired episode is still the same episode. Its archived marker answers a fact after
    // retirement: a delivered or refused one is a duplicate that writes nothing, an expired one
    // reopens because the walk evidently was not finished, and another digest or recipient is
    // the same conflict a live marker would give.
    const archived = markerAt(
      episodeArchiveMarkerPath(storeDirOf(ctx, fact.recipient), fact.recipient, fact.messageId),
    );
    if (archived.kind === 'unreadable') return { ok: false, kind: 'marker', reason: archived.reason };
    const archivedKind = archived.kind === 'ok' ? finishedKind(archived.marker) : null;
    if (archived.kind === 'ok' && archivedKind !== null) {
      if (!sameRecipient(archived.marker.recipient, fact.recipient)) {
        return {
          ok: false,
          kind: 'conflict',
          reason: `fallback: ${fact.messageId} already names another recipient than ${fact.recipient.seat}`,
        };
      }
      if (archived.marker.recordDigest !== fact.recordDigest) {
        return {
          ok: false,
          kind: 'conflict',
          reason: `fallback: ${fact.messageId} already records another digest than this record`,
        };
      }
      if (archivedKind === 'delivered' || archivedKind === 'refused') {
        return { ok: true, state: 'duplicate', marker: archived.marker, eventDuplicate: false, dueAt: null };
      }
      marker = { ...archived.marker };
    } else {
      marker = {
        format: 1,
        messageId: fact.messageId,
        recipient: fact.recipient,
        recordDigest: fact.recordDigest,
        sender: senderTag,
        status: 'trying',
        attempts: [],
        receipt: { kind: 'unknown' },
        updatedAt: fact.at,
      };
    }
  }

  // A replayed deferred fact: the attempt already stands, so the ledger keeps one line and no
  // state moves. The instant is the fact's own, fixed when the send built it, so it is the same
  // on the replay as on the call that landed it.
  if (options.dedupe === true && marker.attempts.some((seen) => seen.route === fact.route && seen.at === fact.at)) {
    return { ok: true, state: 'duplicate', marker, eventDuplicate: false, dueAt: marker.dueAt ?? null };
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
  // refuses the call; the host may retry the same fact. The store is the receiving team's, so
  // the ledger is where the receiver's own pass archives it from.
  const ledger = appendStoreLine(
    fact.recipient.team,
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
      flushed = flushOutbox(ctx, marker, path, waits);
    } catch (error) {
      return { ok: false, kind: 'marker', reason: errorMessage(error) };
    }
    // A busy log leaves the intent standing: the delivery is recorded now and a later pass emits
    // the pending event, exactly as it would after a crash between the intent and the append.
    if (!flushed.ok && flushed.busy !== true) return { ok: false, kind: 'marker', reason: flushed.reason };
    const emitted = flushed.ok ? flushed : null;
    const wrote = writeMarker(path, marker);
    if (!wrote.ok) return { ok: false, kind: 'marker', reason: wrote.reason };
    return {
      ok: true,
      state: wasDelivered ? 'duplicate' : 'delivered',
      marker,
      ...(emitted !== null && emitted.event !== null ? { event: emitted.event } : {}),
      eventDuplicate: emitted?.duplicate ?? false,
      dueAt: marker.dueAt ?? null,
    };
  }

  // An intent an earlier process wrote before its event went out is retried now, under this key's
  // lock. A delivery above cancelled one instead.
  let drained: FlushResult;
  try {
    drained = flushOutbox(ctx, marker, path, waits);
  } catch (error) {
    return { ok: false, kind: 'marker', reason: errorMessage(error) };
  }
  if (!drained.ok && drained.busy !== true) return { ok: false, kind: 'marker', reason: drained.reason };
  const emitted = drained.ok ? drained : null;
  const eventFields = emitted !== null && emitted.event !== null ? { event: emitted.event } : {};

  if (wasDelivered) {
    const wrote = writeMarker(path, marker);
    if (!wrote.ok) return { ok: false, kind: 'marker', reason: wrote.reason };
    return {
      ok: true,
      state: 'duplicate',
      marker,
      eventDuplicate: emitted?.duplicate ?? false,
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
      eventDuplicate: emitted?.duplicate ?? false,
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
      eventDuplicate: emitted?.duplicate ?? false,
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
    flushed = flushOutbox(ctx, marker, path, waits);
  } catch (error) {
    return { ok: false, kind: 'marker', reason: errorMessage(error) };
  }
  // A busy log is not a failed note: the intent above is durable, so the episode is all-failed
  // and the next pass emits the event. A caller on an event loop passes 0 and never waits here.
  if (!flushed.ok && flushed.busy !== true) return { ok: false, kind: 'marker', reason: flushed.reason };
  const sent = flushed.ok ? flushed : null;
  return {
    ok: true,
    state: 'all-failed',
    marker,
    ...(sent !== null && sent.event !== null ? { event: sent.event } : {}),
    eventDuplicate: sent?.duplicate ?? false,
    dueAt: marker.dueAt ?? null,
    ...(delay.refusal !== undefined ? { policyRefusal: delay.refusal } : {}),
  };
}

/** What one drain pass did with the facts a busy episode key deferred. */
export type DeferredNoteDrainReport = {
  at: string;
  /** Facts recorded this pass, with the state the recorder answered. */
  drained: {
    messageId: string;
    recipient: CanonicalRecipient;
    state: 'continued' | 'delivered' | 'duplicate' | 'all-failed';
  }[];
  /** Notes a refused write, an unreadable episode or a record that does not vouch for the note
   *  kept in place; the next pass sees them again. */
  refused: { path: string; reason: string }[];
  /** Notes whose key another live holder kept: ordinary contention, left to the next pass. */
  deferred: { messageId: string; recipient: CanonicalRecipient; path: string }[];
  /** Files that do not read as a note; never deleted from a guess. */
  unreadable: string[];
  scanned: number;
};

/**
 * Record the facts a non-blocking `noteTransportSoon` deferred, then remove their notes. Each note is
 * processed under its episode's key lock with `waitMs: 0`: a key another live holder keeps is
 * deferred to the next pass, so the drain never waits on a busy message either. With
 * `lockWaitMs: 0` the note's bus append is taken the same way: a first exhaustion keeps its intent
 * in the marker for the next pass instead of pausing the drain on a busy event log. The lock makes
 * the landed note and the note's removal one step against a retry, and the recorder's own dedupe
 * by `(route, at)` makes a note whose drain landed but whose removal did not record nothing twice.
 *
 * A note is unsigned text, so nothing in it is believed: the signed record the note names — the
 * file beside it in the recipient's own folder — is read through the bus's rule first, and its
 * signed fields decide which message, seat, session and checkout the fact is about, which record
 * bytes it carries, who sent it, and when the attempt can have happened. A note the record does
 * not vouch for is refused and left where it stands: this pass creates nothing and appends
 * nothing for it. A note this pass does accept takes its sender tag from that record, never from
 * the note. An honest note always has its record: a send stages the record before it walks any
 * route, and only a busy episode key defers the fact beside it.
 */
export function drainDeferredNotes(
  ctx: EscalationContext,
  options: { at?: Date; limit?: number; lockWaitMs?: number } = {},
): DeferredNoteDrainReport {
  const steps = drainDeferredNotesSteps(ctx, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  if (!step.done) throw new Error('the pass did not run to its end');
  return step.value;
}

/**
 * The deferred-note drain one work item at a time: directory entries and notes are walked in
 * bounded chunks that yield, so a caller driving the pass a slice at a time checks its budget
 * inside the walk rather than only after the whole store folder is read.
 */
export function* drainDeferredNotesSteps(
  ctx: EscalationContext,
  options: { at?: Date; limit?: number; lockWaitMs?: number } = {},
): Generator<void, DeferredNoteDrainReport> {
  const at = options.at ?? ctx.now();
  const limit = options.limit ?? 64;
  const noteOptions = { dedupe: true, ...(options.lockWaitMs === undefined ? {} : { lockWaitMs: options.lockWaitMs }) };
  const report: DeferredNoteDrainReport = {
    at: at.toISOString(),
    drained: [],
    refused: [],
    deferred: [],
    unreadable: [],
    scanned: 0,
  };
  for (const found of yield* notesUnderSteps(ctx.root)) {
    if (report.drained.length + report.refused.length + report.deferred.length + report.unreadable.length >= limit) break;
    yield;
    report.scanned += 1;
    const note = found.text === null || found.text === '' ? null : deferredNoteOf(found.text);
    if (note === null) {
      report.unreadable.push(found.path);
      continue;
    }
    const { fact } = note;
    if (fact.recipient.root !== ctx.root) {
      report.refused.push({ path: found.path, reason: `${found.path}: the note names another root than this pass reads` });
      continue;
    }
    const record = noteRecordOf(ctx, fact, at.getTime());
    if (!record.ok) {
      report.refused.push({ path: found.path, reason: `${found.path}: ${record.reason}` });
      continue;
    }
    let step: { kind: 'landed'; state: 'continued' | 'delivered' | 'duplicate' | 'all-failed' } | { kind: 'refused'; reason: string };
    try {
      step = withKeyLock(
        ctx,
        fact.recipient,
        fact.messageId,
        () => {
          const noted = noteLocked(ctx, fact, record.from, noteOptions);
          if (!noted.ok) return { kind: 'refused' as const, reason: noted.reason };
          return { kind: 'landed' as const, state: noted.state };
        },
        0,
      );
    } catch (error) {
      if (error instanceof LockBusyError) {
        report.deferred.push({ messageId: fact.messageId, recipient: fact.recipient, path: found.path });
        continue;
      }
      report.refused.push({ path: found.path, reason: errorMessage(error) });
      continue;
    }
    if (step.kind === 'refused') {
      report.refused.push({ path: found.path, reason: step.reason });
      continue;
    }
    // The fact stands in the episode now; the note's work is done. A failed removal leaves a
    // note the next pass replays into the dedupe above, which records nothing new.
    try {
      unlinkSync(found.path);
    } catch {}
    report.drained.push({ messageId: fact.messageId, recipient: fact.recipient, state: step.state });
  }
  return report;
}

/** Every deferred note under a root's transport tree, sessions and seats sorted so a pass is
 *  ordered. `text` is null when the file cannot be read at all. */
function* notesUnderSteps(root: string): Generator<void, { path: string; text: string | null }[]> {
  const found: { path: string; text: string | null }[] = [];
  const base = join(root, '.agents', 'send-drops');
  for (const session of yield* folderNamesSteps(base)) {
    const sessionDir = join(base, session);
    for (const seat of yield* folderNamesSteps(sessionDir)) {
      const seatDir = join(sessionDir, seat);
      for (const name of yield* fileNamesSteps(seatDir, (entry) => DEFERRED_NOTE_NAME.test(entry))) {
        yield;
        const path = join(seatDir, name);
        found.push({ path, text: readNoFollow(path) });
      }
    }
  }
  return found;
}

/** A deferred note as this module wrote it: the fact and the sender tag beside it. Anything else
 *  is not trusted, and the file is left where it stands for a person to read. */
function deferredNoteOf(text: string): { sender: string; fact: TransportFact } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const raw = parsed as { format?: unknown; sender?: unknown; fact?: unknown };
  if (raw.format !== 1 || typeof raw.sender !== 'string' || raw.sender === '') return null;
  if (raw.fact === null || typeof raw.fact !== 'object') return null;
  const fact = raw.fact as TransportFact;
  if (fact.recipient === null || typeof fact.recipient !== 'object') return null;
  if (fact.reason !== undefined && typeof fact.reason !== 'string') return null;
  if (factProblem(fact) !== null) return null;
  return { sender: raw.sender, fact };
}

/** How far past the pass's own clock a note's instant may stand: the send and the pass run in
 *  different processes, and the note's fact is stamped at the send while the pass reads it a
 *  heartbeat later, so the two readings may sit a little apart. A wider claim is not a fact this
 *  checkout recorded. */
const NOTE_FUTURE_SKEW_MS = 60_000;

/**
 * What the signed record beside one deferred note vouches for, or why the note is not believed.
 * The record is the file the send staged before it walked any route — at the note's own message
 * id in the recipient's drop folder — read through the bus's rule: a regular file this user
 * owns, reached without following a link, whose signature covers the payload as parsed, and
 * whose signed id, addressee, session and checkout answer the fact's claim. Not until that holds
 * is anything taken from it, and what is taken is only what the signature covered: the record's
 * bytes are hashed and must be the note's digest, the sender is the record's own `from`, and the
 * note's instant may not stand before the record that answers it nor past the pass that reads
 * it.
 */
function noteRecordOf(
  ctx: EscalationContext,
  fact: TransportFact,
  passAtMs: number,
): { ok: true; from: string } | { ok: false; reason: string } {
  const path = recordFile(recordDir(ctx.root, fact.recipient.session, fact.recipient.seat), fact.messageId);
  const read = readSealedRecord(path);
  if (!read.ok) return { ok: false, reason: `the record beside the note cannot be read: ${read.reason}` };
  if (read.sealed === null) return { ok: false, reason: 'the record beside the note is missing' };
  const key = messageKeyState(ctx.home);
  if (key.kind === 'missing') return { ok: false, reason: 'the record beside the note cannot be verified: this checkout has no message key' };
  if (key.kind === 'unreadable') {
    return { ok: false, reason: `the record beside the note cannot be verified: the message key cannot be read (${key.why})` };
  }
  const auth = recordAuthOfSealed(read.sealed, key.key);
  if (auth.kind !== 'ok') {
    // A tampered or unsupported envelope is refused on its own ground, exactly as the bus
    // refuses it before raising anything from a record.
    return {
      ok: false,
      reason: auth.kind === 'unsupported' ? auth.reason : 'the record beside the note is not signed with this checkout\'s message key',
    };
  }
  const record = auth.value.payload;
  if (record.id !== fact.messageId) return { ok: false, reason: 'the signed record names another id than the note' };
  if (record.to !== fact.recipient.seat || record.session !== fact.recipient.session) {
    return { ok: false, reason: 'the signed record is addressed to another seat or session than the note' };
  }
  if (record.to_id !== fact.recipient.toId) return { ok: false, reason: 'the signed record names another recipient id than the note' };
  if (!sameFolder(record.root, ctx.root)) return { ok: false, reason: 'the signed record belongs to another checkout' };
  // The digest is over the record's bytes as the send staged them; a note that names another
  // digest names another episode's record, and the episode key would be checked against a value
  // the file does not carry.
  const text = readNoFollow(path);
  if (text === null) return { ok: false, reason: 'the record beside the note could not be read' };
  if (createHash('sha256').update(text).digest('hex') !== fact.recordDigest) {
    return { ok: false, reason: 'the note\'s digest is not the digest of the record beside it' };
  }
  // The record is staged before any route is walked, so an attempt cannot precede the record it
  // is about; and a fact cannot have happened after the pass that reads it.
  const notedAt = Date.parse(fact.at);
  if (notedAt < Date.parse(record.at)) return { ok: false, reason: 'the note is older than the record it names' };
  if (notedAt > passAtMs + NOTE_FUTURE_SKEW_MS) return { ok: false, reason: 'the note is dated past the pass that reads it' };
  return { ok: true, from: record.from };
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
 *
 * `lockWaitMs: 0` makes the pass non-blocking: a key another live holder keeps is reported as
 * `deferred` and left to a later pass, so a scheduler tick never waits on a busy message. The
 * same budget reaches the pass's bus append, so a busy event log is deferred as well.
 */
export function escalateDue(
  ctx: EscalationContext,
  options: { at?: Date; lockWaitMs?: number } = {},
): EscalationReport {
  const steps = escalationSteps(ctx, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  if (!step.done) throw new Error('the pass did not run to its end');
  return step.value;
}

/**
 * The escalation pass one work item at a time: it yields before each marker, so a caller that
 * must answer its own heartbeat between items can drive it a slice at a time. `escalateDue`
 * remains the one-shot form every direct caller uses; the chores child is the sliced one.
 */
export function* escalationSteps(
  ctx: EscalationContext,
  options: { at?: Date; lockWaitMs?: number } = {},
): Generator<void, EscalationReport> {
  const at = options.at ?? ctx.now();
  const atIso = at.toISOString();
  const lockWaitMs = options.lockWaitMs ?? 10_000;
  const report: EscalationReport = { escalated: [], refused: [], deferred: [], unreadable: [], scanned: 0 };

  for (const found of yield* markersUnderSteps(ctx.root)) {
    yield;
    if (found.kind === 'unreadable') {
      report.unreadable.push(found.path);
      continue;
    }
    const { recipient, messageId } = found.marker;
    // A marker with nothing to do is passed over before its key lock is taken. Every heartbeat
    // runs this pass on the daemon's one event loop, and a checkout keeps hundreds of settled
    // episodes; locking and re-reading each one starved the health probe and the hosted
    // endpoints. The read is unlocked, so a marker that changes after it waits one tick.
    if (settledAt(found.marker, at)) {
      report.scanned += 1;
      continue;
    }
    let step: EscalationStep;
    try {
      step = withKeyLock(ctx, recipient, messageId, () => escalateOne(ctx, recipient, messageId, at, atIso, lockWaitMs), lockWaitMs);
    } catch (error) {
      if (error instanceof LockBusyError) {
        // A live holder is working this episode: ordinary contention. Leave it to the next pass,
        // keep the other markers moving, and record no refusal and no event for it.
        report.deferred.push({ messageId, recipient });
        continue;
      }
      step = { kind: 'refused', reason: errorMessage(error) };
    }
    if (step.kind === 'none') continue;
    if (step.kind === 'deferred') {
      // The episode is this pass's, but the bus append met another live holder. Its intent
      // stands in the marker, so the next tick emits it; other markers keep moving.
      report.deferred.push({ messageId, recipient });
      continue;
    }
    report.scanned += 1;
    if (step.kind === 'unreadable') report.unreadable.push(step.path);
    else if (step.kind === 'refused') report.refused.push({ messageId, recipient, reason: step.reason });
    else if (step.kind === 'escalated') report.escalated.push(step.entry);
  }
  return report;
}

/** True when the locked step would find nothing to do: no pending intent, and either a delivery,
 *  a walk still trying, an escalation already decided, or a due instant still ahead. */
function settledAt(marker: FallbackMarker, at: Date): boolean {
  if (marker.outbox !== undefined) return false;
  if (marker.status === 'delivered' || marker.status === 'trying') return true;
  if (marker.escalatedAt !== undefined) return true;
  if (marker.dueAt === undefined) return false;
  const due = Date.parse(marker.dueAt);
  return Number.isFinite(due) && due > at.getTime();
}

type EscalationStep =
  | { kind: 'none' }
  | { kind: 'idle' }
  /** The pass had work, but the bus append met another live holder; the intent stands for the
   *  next tick. */
  | { kind: 'deferred'; reason: string }
  | { kind: 'unreadable'; path: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'escalated'; entry: EscalationEntry };

/** How a finished episode ended: its message arrived, its escalation went out after every live
 *  route failed, or the walk was never finished and its last fact is past retention. */
export type FinishedKind = 'delivered' | 'refused' | 'expired';

/**
 * Classify an episode as finished, or null while it still has work: a pending event intent (the
 * escalation pass must flush it first), an exhaustion no escalation has been decided for yet.
 * A `trying` episode is `expired` by kind; whether it is old enough to retire is the retention
 * word's question, not this one's.
 */
export function finishedKind(marker: FallbackMarker): FinishedKind | null {
  if (marker.outbox !== undefined) return null;
  if (marker.status === 'delivered') return 'delivered';
  if (marker.status === 'all-failed') return marker.escalatedAt !== undefined ? 'refused' : null;
  return 'expired';
}

/** The retention word in force for a receiver, in seconds, or why it could not be read. A null
 *  window with no refusal is the explicit keep-all word: no age retires an expired episode. */
export type FallbackRetention = { seconds: number | null; refusal: string | null };

/**
 * Resolve how long an unfinished episode's marker may stand from the receiver's own signed chain:
 * the canonical `event-retention-days` in days, through the same reader every event threshold
 * uses. The team is the receiver's, selected exactly as the escalation delay selects it, so a
 * cross-root episode without its receiver's file in hand reads no chain and retires nothing
 * expired. An unreadable chain fails closed: the refusal is reported and the episode stays.
 */
export function fallbackRetentionOf(
  ctx: EscalationContext,
  recipient: CanonicalRecipient,
  at: Date,
): FallbackRetention {
  const team = ctx.recipientTeam ?? (recipient.root === ctx.root ? ctx.team : null);
  if (team === null) {
    return {
      seconds: null,
      refusal: `no team file is in hand for the receiver's root ${recipient.root}: the sender's chain is never read for another team`,
    };
  }
  const inForce = eventThresholdsInForce({
    home: ctx.home,
    entity: team.entity ?? '',
    projectId: projectIdOfTeam(ctx.home, team, recipient.root) ?? '',
    root: recipient.root,
    team,
    seat: team.seats.find((seat) => seat.name === recipient.seat) ?? null,
    agentId: recipient.toId ?? null,
    now: at,
    upToLevel: 'team',
  });
  if (!inForce.ok) {
    const said = inForce.refusals.map((refusal) => refusal.message).join('; ');
    return { seconds: null, refusal: said === '' ? 'the event retention word could not be read' : said };
  }
  // Zero is the explicit keep-all word: there is no age at which an expired episode stops being
  // kept. A null window with no refusal is that choice; a refusal stays a refusal.
  const days = inForce.thresholds.retention_days;
  return { seconds: days === 0 ? null : days * 86_400, refusal: null };
}

/** One finished episode the store could retire, with the age that decides an expired one. */
export type RetirementCandidate = {
  messageId: string;
  recipient: CanonicalRecipient;
  kind: FinishedKind;
  /** Seconds from the marker's last update to the planning instant. */
  ageSeconds: number;
  /** Whether a retirement pass at this instant would retire it now. */
  eligible: boolean;
  /** An expired but not yet eligible episode's earliest retire instant; null when the retention
   *  word is unreadable and no instant can be named. */
  until: string | null;
};

export type RetirementPlan = {
  at: string;
  /** Finished episodes, oldest first. */
  candidates: RetirementCandidate[];
  /** Markers a pass found but could not trust; never rewritten. */
  unreadable: string[];
  /** Trusted markers the pass read, finished or not. */
  scanned: number;
  /** The first receiver chain the plan resolved, when an expired episode needed one. */
  retention: FallbackRetention | null;
};

/** Everything a retirement pass did, per root, for a sweep to add to its own report. */
export type RetirementReport = {
  at: string;
  retired: { messageId: string; recipient: CanonicalRecipient; kind: FinishedKind; at: string; archive: string }[];
  /** Expired episodes inside the retention window, and expired ones whose word is unreadable. */
  waiting: { messageId: string; recipient: CanonicalRecipient; ageSeconds: number; until: string | null }[];
  /** Episodes another live holder kept: ordinary contention, left to the next pass. */
  deferred: { messageId: string; recipient: CanonicalRecipient }[];
  /** Episodes that were eligible but whose retirement did not complete; the live marker stays. */
  refused: { messageId: string; recipient: CanonicalRecipient; reason: string }[];
  unreadable: string[];
  scanned: number;
  retention: FallbackRetention | null;
};

/**
 * List the store's finished episodes by age without writing anything. Delivered and refused
 * episodes are eligible at once; an expired one is eligible once its last update is at least the
 * receiver's signed `event-retention-days` old. The chain is read only when an expired episode is
 * there to judge, so a store of delivered and escalated episodes costs no policy read.
 */
export function planRetirement(ctx: EscalationContext, options: { at?: Date } = {}): RetirementPlan {
  const steps = planRetirementSteps(ctx, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  if (!step.done) throw new Error('the pass did not run to its end');
  return step.value;
}

/**
 * The retirement planning walk in bounded chunks that yield: directory reads, marker inspections
 * and candidate sorting yield along the way so a sliced caller checks its slice budget inside
 * the walk.
 */
export function* planRetirementSteps(
  ctx: EscalationContext,
  options: { at?: Date } = {},
): Generator<void, RetirementPlan> {
  const at = options.at ?? ctx.now();
  const plan: RetirementPlan = { at: at.toISOString(), candidates: [], unreadable: [], scanned: 0, retention: null };
  const words = new Map<string, FallbackRetention>();
  const ordered: { order: string; candidate: RetirementCandidate }[] = [];
  let count = 0;
  for (const found of yield* markersUnderSteps(ctx.root)) {
    count += 1;
    if (count % DIR_SCAN_CHUNK === 0) yield;
    if (found.kind === 'unreadable') {
      plan.unreadable.push(found.path);
      continue;
    }
    plan.scanned += 1;
    const kind = finishedKind(found.marker);
    if (kind === null) continue;
    const { recipient, messageId } = found.marker;
    const ageSeconds = Math.max(0, Math.round((at.getTime() - Date.parse(found.marker.updatedAt)) / 1000));
    let eligible = kind !== 'expired';
    let until: string | null = null;
    if (kind === 'expired') {
      const key = fallbackKeyOf(recipient, '');
      let word = words.get(key);
      if (word === undefined) {
        yield;
        word = fallbackRetentionOf(ctx, recipient, at);
        words.set(key, word);
      }
      if (plan.retention === null) plan.retention = word;
      if (word.seconds !== null) {
        until = new Date(Date.parse(found.marker.updatedAt) + word.seconds * 1000).toISOString();
        eligible = at.getTime() >= Date.parse(until);
      }
      // With an unreadable word, `until` stays null and the episode stays: fail closed.
    }
    ordered.push({
      order: `${found.marker.updatedAt}\u0000${messageId}\u0000${fallbackKeyOf(recipient, messageId)}`,
      candidate: { messageId, recipient, kind, ageSeconds, eligible, until },
    });
  }
  if (ordered.length >= DIR_SCAN_CHUNK) yield;
  ordered.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  if (ordered.length >= DIR_SCAN_CHUNK) yield;
  plan.candidates = ordered.map((entry) => entry.candidate);
  return plan;
}

/**
 * Retire finished episodes: move each eligible marker and its attempt ledger into the store's
 * archive, then remove the live marker. The publication ledger stays where it is — replay dedup
 * outlives the episode. Each episode is retired under its own key lock and re-read inside it, so
 * a fact or a due escalation running beside the pass is neither lost nor archived mid-write: it
 * lands first and the pass sees the new state, or it waits for the pass. Only the first `limit`
 * eligible episodes, oldest first, are retired per pass, except that a store carrying more than
 * `backlogAbove` eligible episodes takes up to `backlogLimit` instead: a store never retired before
 * carries its whole history, and the steady limit would need hours to clear it. The backlog is
 * counted among finished episodes only, so a pending or unsettled marker is never a candidate
 * whatever the limit. A retirement that does not complete leaves the live marker in place and is
 * reported; the next pass tries again.
 */
export function retireFinished(
  ctx: EscalationContext,
  options: {
    at?: Date;
    lockWaitMs?: number;
    limit?: number;
    /** Above this many eligible finished episodes, one pass retires up to `backlogLimit`. */
    backlogAbove?: number;
    backlogLimit?: number;
  } = {},
): RetirementReport {
  const steps = retirementSteps(ctx, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  if (!step.done) throw new Error('the pass did not run to its end');
  return step.value;
}

/**
 * The retirement pass one candidate at a time: it yields before each, so a caller that must
 * answer its own heartbeat between candidates can drive it a slice at a time. `retireFinished`
 * remains the one-shot form.
 */
export function* retirementSteps(
  ctx: EscalationContext,
  options: {
    at?: Date;
    lockWaitMs?: number;
    limit?: number;
    /** Above this many eligible finished episodes, one pass retires up to `backlogLimit`. */
    backlogAbove?: number;
    backlogLimit?: number;
  } = {},
): Generator<void, RetirementReport> {
  const at = options.at ?? ctx.now();
  const lockWaitMs = options.lockWaitMs ?? 10_000;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const plan = yield* planRetirementSteps(ctx, { at });
  const backlog = plan.candidates.reduce((count, candidate) => count + (candidate.eligible ? 1 : 0), 0);
  const passLimit =
    options.backlogAbove !== undefined && options.backlogLimit !== undefined && backlog > options.backlogAbove
      ? Math.max(limit, options.backlogLimit)
      : limit;
  const report: RetirementReport = {
    at: at.toISOString(),
    retired: [],
    waiting: [],
    deferred: [],
    refused: [],
    unreadable: plan.unreadable,
    scanned: plan.scanned,
    retention: plan.retention,
  };
  for (const candidate of plan.candidates) {
    yield;
    if (report.retired.length >= passLimit) break;
    if (!candidate.eligible) {
      report.waiting.push({
        messageId: candidate.messageId,
        recipient: candidate.recipient,
        ageSeconds: candidate.ageSeconds,
        until: candidate.until,
      });
      continue;
    }
    let step: RetireStep;
    try {
      step = withKeyLock(
        ctx,
        candidate.recipient,
        candidate.messageId,
        () => retireOne(ctx, candidate.recipient, candidate.messageId, at),
        lockWaitMs,
      );
    } catch (error) {
      if (error instanceof LockBusyError) {
        report.deferred.push({ messageId: candidate.messageId, recipient: candidate.recipient });
        continue;
      }
      step = { kind: 'refused', reason: errorMessage(error) };
    }
    if (step.kind === 'retired') {
      report.retired.push(step.entry);
      // The key lock's folder is what the next pass would otherwise walk forever. A folder a
      // live holder took after the pass released the key stays; the reclaim pass judges it.
      try {
        rmdirSync(join(storeDirOf(ctx, candidate.recipient), 'locks', `fallback-${episodeHash(candidate.recipient, candidate.messageId)}`));
      } catch {}
    } else if (step.kind === 'refused') {
      report.refused.push({ messageId: candidate.messageId, recipient: candidate.recipient, reason: step.reason });
    } else if (step.kind === 'waiting') {
      report.waiting.push(step.waiting);
    }
  }
  return report;
}

type RetireStep =
  | { kind: 'gone' }
  | { kind: 'retired'; entry: RetirementReport['retired'][number] }
  | { kind: 'waiting'; waiting: RetirementReport['waiting'][number] }
  | { kind: 'refused'; reason: string };

function retireOne(
  ctx: EscalationContext,
  recipient: CanonicalRecipient,
  messageId: string,
  at: Date,
): RetireStep {
  const path = markerPathOf(recipient, messageId);
  const read = markerAt(path);
  if (read.kind === 'unreadable') return { kind: 'refused', reason: read.reason };
  if (read.kind === 'none') return { kind: 'gone' };
  const marker = read.marker;
  if (!sameRecipient(marker.recipient, recipient) || marker.messageId !== messageId) {
    return { kind: 'refused', reason: `${path}: the marker names another episode` };
  }
  const kind = finishedKind(marker);
  if (kind === null) return { kind: 'gone' };
  if (kind === 'expired') {
    // Re-checked under the lock against the marker as it stands now, not the scan's copy.
    const word = fallbackRetentionOf(ctx, recipient, at);
    const ageSeconds = Math.max(0, Math.round((at.getTime() - Date.parse(marker.updatedAt)) / 1000));
    if (word.seconds === null) {
      return { kind: 'waiting', waiting: { messageId, recipient, ageSeconds, until: null } };
    }
    const until = new Date(Date.parse(marker.updatedAt) + word.seconds * 1000).toISOString();
    if (at.getTime() < Date.parse(until)) {
      return { kind: 'waiting', waiting: { messageId, recipient, ageSeconds, until } };
    }
  }
  const storeDir = storeDirOf(ctx, recipient);
  // The archive tree is checked before the first write, not left to a recursive mkdir: each
  // folder below the store must be a real directory of this user's, and a link anywhere in the
  // ladder refuses the whole retirement with the live marker untouched.
  const folderProblem = ensureFoldersBelow(storeDir, [
    FALLBACK_ARCHIVE_DIR,
    join(FALLBACK_ARCHIVE_DIR, 'markers'),
    join(FALLBACK_ARCHIVE_DIR, 'attempts'),
  ]);
  if (folderProblem !== null) return { kind: 'refused', reason: folderProblem };
  const archive = episodeArchiveMarkerPath(storeDir, recipient, messageId);
  try {
    dropMessage(dirname(archive), basename(archive), `${JSON.stringify(marker, null, 2)}\n`);
  } catch (error) {
    return { kind: 'refused', reason: `${archive}: the marker was not archived: ${errorMessage(error)}` };
  }
  const moved = moveAttemptLedger(storeDir, recipient, messageId);
  if (moved !== null) return { kind: 'refused', reason: moved };
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { kind: 'refused', reason: `${path}: the retired marker was not removed: ${errorMessage(error)}` };
    }
  }
  return { kind: 'retired', entry: { messageId, recipient, kind, at: at.toISOString(), archive } };
}

/** Move one episode's attempt ledger beside its archived marker, merging when an earlier
 *  retirement already archived one. The merge is idempotent: a source whose exact text already
 *  ends the archive was appended by a pass that then failed to remove it, so this pass only
 *  removes the source (the merge would add the same bytes again). Any other archive is rewritten
 *  atomically through the store's tmp-and-rename write. A ledger that cannot be read or written
 *  names why and leaves the episode to the next pass; the live marker is removed only after. */
function moveAttemptLedger(storeDir: string, recipient: CanonicalRecipient, messageId: string): string | null {
  const source = join(storeDir, attemptLedgerFileName(recipient, messageId));
  const text = readNoFollow(source);
  if (text === null) return `${source}: the attempt ledger could not be read; the episode stays`;
  if (text === '') return null;
  const dest = episodeArchiveAttemptsPath(storeDir, recipient, messageId);
  try {
    const existing = readNoFollow(dest);
    if (existing === null) return `${dest}: the archived attempt ledger could not be read; the episode stays`;
    if (existing === '') {
      renameSync(source, dest);
      return null;
    }
    if (!existing.endsWith(text)) {
      dropMessage(dirname(dest), basename(dest), existing + text);
    }
    unlinkSync(source);
    return null;
  } catch (error) {
    return `${source}: the attempt ledger was not archived: ${errorMessage(error)}`;
  }
}

const FALLBACK_LOCK_DIR = /^fallback-[0-9a-f]{16}$/;

/**
 * Reclaim the key-lock folders of `ctx.root`'s store whose owner is gone: an empty folder past
 * the grace (`youngMs`, 60 s by default, for an acquirer between its `mkdir` and its `open`), a
 * folder whose lock names a dead holder, and a lock file too old to be a writer still starting
 * up. A live holder's folder, a younger lock and a folder whose name is not an episode's are left
 * alone. A pass that loses an empty folder under it recreates it (`withLock`), so a reclaim never
 * breaks a sweep in flight.
 */
export function reclaimFallbackLocks(
  ctx: EscalationContext,
  options: { limit?: number; youngMs?: number } = {},
): { reclaimed: number; kept: number; scanned: number } {
  const steps = reclaimSteps(ctx, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  if (!step.done) throw new Error('the pass did not run to its end');
  return step.value;
}

/**
 * The lock-reclaim pass one lock folder at a time: it yields before each, so a caller that must
 * answer its own heartbeat between folders can drive it a slice at a time.
 */
export function* reclaimSteps(
  ctx: EscalationContext,
  options: { limit?: number; youngMs?: number } = {},
): Generator<void, { reclaimed: number; kept: number; scanned: number }> {
  const locksDir = join(dirname(historyPath(ctx.team.project, ctx.root, ctx.home)), 'locks');
  const limit = options.limit ?? 64;
  const names = yield* folderNamesSteps(locksDir, (name) => FALLBACK_LOCK_DIR.test(name));
  let reclaimed = 0;
  let kept = 0;
  let scanned = 0;
  for (const name of names.slice(0, limit)) {
    yield;
    scanned += 1;
    const result = reclaimLockDir(join(locksDir, name), { youngMs: options.youngMs });
    if (result === 'removed') reclaimed += 1;
    else if (result === 'kept') kept += 1;
  }
  return { reclaimed, kept, scanned };
}

/** The episode's store, keyed by the RECEIVING team's project over the receiving root — the
 *  same folder the receiver-side watch and sweep resolve. `CanonicalRecipient.team` is fixed to
 *  the receiver's project when the send begins, so a cross-root episode has one lock folder, one
 *  pair of ledgers and one archive whichever side acts. */
function storeDirOf(ctx: EscalationContext, recipient: CanonicalRecipient): string {
  return dirname(historyPath(recipient.team, recipient.root, ctx.home));
}

function escalateOne(
  ctx: EscalationContext,
  recipient: CanonicalRecipient,
  messageId: string,
  at: Date,
  atIso: string,
  lockWaitMs: number,
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
  const drained = flushOutbox(ctx, marker, path, { lockWaitMs });
  if (!drained.ok) {
    if (drained.busy === true) return { kind: 'deferred', reason: drained.reason };
    return { kind: 'refused', reason: drained.reason };
  }
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

  const flushed = flushOutbox(ctx, marker, path, { lockWaitMs });
  if (!flushed.ok) {
    if (flushed.busy === true) return { kind: 'deferred', reason: flushed.reason };
    return { kind: 'refused', reason: flushed.reason };
  }
  if (flushed.event === null) return { kind: 'refused', reason: `${path}: the escalation intent emitted no event` };
  return {
    kind: 'escalated',
    entry: { messageId, recipient, event: flushed.event, duplicate: flushed.duplicate, mailbox: flushed.mailbox },
  };
}

type FlushResult =
  | { ok: true; kind: EventIntent['kind'] | null; event: SignedEventRecord | null; duplicate: boolean; mailbox: string | null }
  /** `busy` marks an append a live event-lock holder kept: the intent is still in the marker, so
   *  a caller that may not wait leaves it for the next pass rather than failing the note. */
  | { ok: false; reason: string; busy?: true };

/**
 * Emit the marker's pending intent, then clear it. Called under the episode's key lock. A
 * confirmed append is first recorded with its signed record in the episode's publication ledger,
 * which retention never removes, so a retry finds the published record even after the event log's
 * segments rotated and appends nothing. The deterministic record id makes a retry within retained
 * history an `appendEvent` duplicate; the mailbox is `once`, so a retry after a mailbox failure
 * finds the first record. The intent stays in the marker until both writes return, so a crash in
 * this function is retried next pass.
 *
 * `lockWaitMs` reaches the bus append: a caller on an event loop passes 0, and a log another live
 * holder keeps answers `busy` with the intent still in the marker, for the next pass to emit.
 */
function flushOutbox(
  ctx: EscalationContext,
  marker: FallbackMarker,
  path: string,
  options: { lockWaitMs?: number } = {},
): FlushResult {
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
    const result = appendEvent(
      marker.recipient.team,
      marker.recipient.root,
      ctx.home,
      input,
      options.lockWaitMs === undefined ? {} : { lockWaitMs: options.lockWaitMs },
    );
    if (!result.ok) {
      return { ok: false, reason: result.reason, ...(result.busy === true ? { busy: true } : {}) };
    }
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

function publicationPathOf(ctx: EscalationContext, recipient: CanonicalRecipient, messageId: string): string {
  return join(
    dirname(historyPath(recipient.team, recipient.root, ctx.home)),
    publicationLedgerFileName(recipient, messageId),
  );
}

/** Find the signed record this episode already published under `recordId`. A ledger that exists
 *  but cannot be read stops the caller: re-appending from a guess could duplicate the event. */
function publicationOf(
  ctx: EscalationContext,
  recipient: CanonicalRecipient,
  messageId: string,
  recordId: string,
): PublicationRead {
  const path = publicationPathOf(ctx, recipient, messageId);
  const direct = publicationAt(path, recordId, ctx.home);
  // One release before the store key was made canonical, a cross-root episode filed this ledger
  // under the SENDING team's project over the receiving root. An episode straddling the release
  // may therefore have published under that sibling store, and honoring it is the difference
  // between one escalation and two. The canonical ledger still decides alone; only its quiet
  // `none` consults the sibling stores over the same root hash, and the bridge never refuses —
  // it can only turn `none` into the published record. It reads, never writes, and one release
  // after the key became canonical no new episode can leave a publication behind in a sibling.
  if (direct.kind !== 'none') return direct;
  // Every sibling is consulted in folder order until one holds a record that verifies for
  // this recordId: an earlier sibling holding junk, an unrelated ledger or a foreign-signed
  // record must not shadow the store that holds the real publication, or the replay would
  // publish the escalation a second time. A sibling that does not verify is passed over,
  // never a refusal — the bridge keeps its word either way.
  for (const legacy of legacyPublicationCandidates(recipient, messageId, path)) {
    const bridged = publicationAt(legacy, recordId, ctx.home);
    if (bridged.kind === 'ok') return bridged;
  }
  return direct;
}

/** The one-release bridge's candidates, in stable folder order: the episode's publication
 *  ledger under each sibling store folder of the same receiving root (the pre-fix,
 *  sender-keyed ones) that holds the file. */
function legacyPublicationCandidates(recipient: CanonicalRecipient, messageId: string, canonicalPath: string): string[] {
  const canonicalDir = dirname(canonicalPath);
  const suffix = basename(canonicalDir).match(/[0-9a-f]{12}$/);
  if (suffix === null) return [];
  const fileName = publicationLedgerFileName(recipient, messageId);
  const candidates: string[] = [];
  for (const name of folderNames(dirname(canonicalDir))) {
    if (!name.endsWith(`-${suffix[0]}`) || name === basename(canonicalDir)) continue;
    const candidate = join(dirname(canonicalDir), name, fileName);
    if (existsSync(candidate)) candidates.push(candidate);
  }
  return candidates;
}

function publicationAt(path: string, recordId: string, home: string): PublicationRead {
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
    if (record === null || !verifies(record, home)) {
      return { kind: 'unreadable', reason: `${path}: the published record is not a verified event` };
    }
    found = record;
  }
  return found === null ? { kind: 'none' } : { kind: 'ok', record: found };
}

function recordPublication(
  ctx: EscalationContext,
  marker: FallbackMarker,
  intent: EventIntent,
  record: SignedEventRecord,
): { ok: true } | { ok: false; reason: string } {
  const wrote = appendStoreLine(
    marker.recipient.team,
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

/** The lock's directory, unique per canonical episode key, under the project's state store. A
 *  caller that must not block passes `waitMs: 0`; a live holder then raises `LockBusyError`. */
function withKeyLock<T>(
  ctx: EscalationContext,
  recipient: CanonicalRecipient,
  messageId: string,
  work: () => T,
  waitMs = 10_000,
): T {
  const storeDir = storeDirOf(ctx, recipient);
  const ladder = ensureStoreLadder(storeDir, ctx.home);
  if (ladder !== null) throw new Error(ladder);
  return withLock(join(storeDir, 'locks', `fallback-${episodeHash(recipient, messageId)}`), work, { waitMs });
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

/**
 * A marker file's stamp and the read it produced. The daemon's sweep walks every hosted root on
 * each heartbeat, and most of what it finds is settled: an unchanged file is worth one stat, not a
 * read and a parse. The stamp is the file's own modification time and size, so even an in-place
 * write of the same length is caught. The cached copy only pre-filters — an episode that looks due
 * is re-read under its key lock inside `escalateOne` — so a stale stamp can never mint an event;
 * losing the stamp to a clock too coarse to move would cost at most that one re-read.
 */
type CachedMarkerRead = { mtimeMs: number; size: number; read: MarkerRead };

const markerReads = { read: 0, reused: 0 };
const markerCache = new Map<string, CachedMarkerRead>();

/** What this process's passes have read afresh, answered from a stamp, and how many stamps they
 *  hold now. A per-process diagnostic: the cache is memory, never a file. */
export function markerCacheStats(): { read: number; reused: number; cached: number } {
  return { read: markerReads.read, reused: markerReads.reused, cached: markerCache.size };
}

function markerAtCached(path: string): MarkerRead {
  let stamp: { mtimeMs: number; size: number } | null = null;
  try {
    const stat = lstatSync(path);
    // A symlink is never cached: `readNoFollow` refuses it, and a fresh read keeps saying so.
    if (stat.isFile()) stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    stamp = null;
  }
  if (stamp !== null) {
    const cached = markerCache.get(path);
    if (cached !== undefined && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) {
      markerReads.reused += 1;
      return cached.read;
    }
  }
  const read = markerAt(path);
  markerReads.read += 1;
  if (stamp === null) markerCache.delete(path);
  else markerCache.set(path, { ...stamp, read });
  return read;
}

/** Entries read from a directory or marker list before yielding to the slice clock. */
const DIR_SCAN_CHUNK = 64;

/** All markers under a root's transport tree, sessions and seats sorted so a pass is ordered. A
 *  marker that cannot be trusted is returned as its path, never rewritten from a guess. */
function* markersUnderSteps(
  root: string,
): Generator<void, ({ kind: 'ok'; path: string; marker: FallbackMarker } | { kind: 'unreadable'; path: string })[]> {
  const found: ({ kind: 'ok'; path: string; marker: FallbackMarker } | { kind: 'unreadable'; path: string })[] = [];
  const base = join(root, '.agents', 'send-drops');
  const seen = new Set<string>();
  let markerCount = 0;
  for (const session of yield* folderNamesSteps(base)) {
    const sessionDir = join(base, session);
    for (const seat of yield* folderNamesSteps(sessionDir)) {
      const seatDir = join(sessionDir, seat);
      for (const name of yield* fileNamesSteps(seatDir, (entry) => entry.endsWith('.fallback.json'))) {
        markerCount += 1;
        if (markerCount % DIR_SCAN_CHUNK === 0) yield;
        const path = join(seatDir, name);
        seen.add(path);
        const read = markerAtCached(path);
        if (read.kind === 'ok') found.push({ kind: 'ok', path, marker: read.marker });
        else if (read.kind === 'unreadable') found.push({ kind: 'unreadable', path });
      }
    }
  }
  // A marker that vanished from this root leaves the cache with it, so a long-lived daemon holds
  // stamps for the tree it just walked and nothing older.
  const prefix = `${base}${sep}`;
  let cacheScanned = 0;
  for (const path of markerCache.keys()) {
    cacheScanned += 1;
    if (cacheScanned % DIR_SCAN_CHUNK === 0) yield;
    if (path.startsWith(prefix) && !seen.has(path)) markerCache.delete(path);
  }
  return found;
}

function* folderNamesSteps(dir: string, predicate?: (name: string) => boolean): Generator<void, string[]> {
  const names: string[] = [];
  let opened: Dir | null = null;
  try {
    opened = opendirSync(dir);
  } catch {
    return [];
  }
  try {
    let scanned = 0;
    for (;;) {
      const entry = opened.readSync();
      if (entry === null) break;
      scanned += 1;
      if (scanned % DIR_SCAN_CHUNK === 0) yield;
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (predicate !== undefined && !predicate(entry.name)) continue;
      names.push(entry.name);
    }
  } catch {
    return [];
  } finally {
    try {
      opened.closeSync();
    } catch {}
  }
  if (names.length >= DIR_SCAN_CHUNK) yield;
  names.sort();
  return names;
}

function* fileNamesSteps(dir: string, predicate?: (name: string) => boolean): Generator<void, string[]> {
  const names: string[] = [];
  let opened: Dir | null = null;
  try {
    opened = opendirSync(dir);
  } catch {
    return [];
  }
  try {
    let scanned = 0;
    for (;;) {
      const entry = opened.readSync();
      if (entry === null) break;
      scanned += 1;
      if (scanned % DIR_SCAN_CHUNK === 0) yield;
      if (!entry.isFile()) continue;
      if (predicate !== undefined && !predicate(entry.name)) continue;
      names.push(entry.name);
    }
  } catch {
    return [];
  } finally {
    try {
      opened.closeSync();
    } catch {}
  }
  if (names.length >= DIR_SCAN_CHUNK) yield;
  names.sort();
  return names;
}

function folderNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
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
