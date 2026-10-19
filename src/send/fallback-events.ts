// The fallback episode: what TeamCLI records when the delivery order is exhausted.
//
// A send walks its delivery legs in order and appends one transport fact per attempt. This
// module turns those facts into the two signals the owner asked for:
//
//   1. The instant the last live route fails, one event — `message.held`, routed by the existing
//      default `['sender', 'lead']`, so the sender and the receiver's lead hear it. Nothing is
//      emitted before that, and nothing per failed route.
//   2. If no delivery follows within the owner's policy delay
//      (`unreachable_threshold_seconds`, resolved by `eventThresholdsInForce`), one escalation to
//      the main — entity — orchestrator: an event addressed to that seat and one signed mailbox
//      record. A later delivery cancels the pending escalation.
//
// Episode state is a derivative file beside the message record:
// `<root>/.agents/send-drops/<session>/<seat>/<id>.fallback.json`, the same shape as a thread's
// `<id>.closed.json`. That file, not the event log, is the replay-lifetime proof: the log rotates
// and `appendEvent`'s dedup index is rebuilt from whatever segments survived, so a second process
// or a restart could otherwise see an empty index. The marker remembers `allFailedAt`,
// `dueAt` and `escalatedAt`, so a restart resumes a due escalation and repeats write nothing.
//
// The key is (canonical recipient, message id). The record digest is an immutable value of that
// key, checked on every fact: a fact that reuses the key with another digest is a conflict and
// writes nothing. It is never an extra dimension of the key. The recipient is the one TeamCLI
// verified (team, seat, registry id, session, root); the sender is the verified `Caller` the host
// passes beside the fact. Nothing here reads an identity out of a payload.
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
import { appendEvent, type EventAppendInput, type SignedEventRecord } from '../bus/log.ts';
import { writeRuntimeMailboxRecord } from '../bus/owner.ts';
import { readEntityOrchestrator, type EntityOrchestrator } from '../bus/seats.ts';
import { recordDir } from '../commands/messages.ts';
import type { TeamFile } from '../file/types.ts';
import { eventThresholdsInForce } from '../policy/thresholds.ts';
import { teamIdOf } from '../registry/teams.ts';
import { readNoFollow } from './history.ts';
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
 *  resolved the entity lead pass it in; absent, the registry answers (or names none). */
export type FallbackContext = {
  caller: Caller;
  team: TeamFile;
  root: string;
  home: string;
  now: () => Date;
  orchestrator?: EntityOrchestrator | null;
};

/** One attempt, as the marker keeps it. The receipt is the last one stored, typed. */
export type AttemptRecord = {
  route: TransportRoute;
  outcome: AttemptOutcome;
  at: string;
  ms: number;
  reason?: string;
  receipt: RelayReceipt;
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
  attempts: AttemptRecord[];
  allFailedAt?: string;
  /** ISO: the first instant the delayed escalation may fire. Cleared by a delivery. */
  dueAt?: string;
  /** ISO: when the main escalation ran. Its presence is what makes a repeat a no-op. */
  escalatedAt?: string;
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
      /** The all-failed event, on the first exhaustion; absent on every other state. */
      event?: SignedEventRecord;
      /** Whether the event append found its record already in the retained log. */
      eventDuplicate: boolean;
      /** The pending main escalation's instant, when one is scheduled. */
      dueAt: string | null;
      /** Why the policy delay could not be resolved; the episode is still recorded, with no due
       *  instant, and a later `escalateDue` under a readable policy leaves it pending. */
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

/** `(canonical recipient, message id)`, with NUL separators so no two tuples can spell one key. */
export function fallbackKeyOf(recipient: CanonicalRecipient, messageId: string): string {
  return [recipient.team, recipient.seat, recipient.session, recipient.root, messageId].join('\u0000');
}

/** The marker's path: a derivative file beside the message record. */
export function markerPathOf(recipient: CanonicalRecipient, messageId: string): string {
  return join(recordDir(recipient.root, recipient.session, recipient.seat), `${messageId}.fallback.json`);
}

/** The event record id of the immediate all-failed event: deterministic per episode. */
export function allFailedRecordId(messageId: string): string {
  return `fallback:all-failed:${messageId}`;
}

/** The event record id of the delayed main escalation: deterministic per episode. */
export function escalatedRecordId(messageId: string): string {
  return `fallback:main-escalated:${messageId}`;
}

/** The mailbox id of the delayed main escalation. A hash keeps the name safe whatever the
 *  message id holds, and deterministic, so `once: true` finds an earlier publication. */
export function escalationMailboxId(messageId: string): string {
  return `evt-fallback-${createHash('sha256').update(messageId).digest('hex').slice(0, 16)}`;
}

/** The most attempts a marker keeps. A long episode stays legible; the state it drives is in
 *  `allFailedAt`/`dueAt`/`escalatedAt`, not in the count. */
const MAX_ATTEMPTS = 64;

/**
 * Record one transport fact in the message's fallback episode.
 *
 * The episode key is (recipient, messageId); `recordDigest` must match a marker already there, or
 * the call refuses as a conflict and writes nothing. A delivered fact ends the episode and cancels
 * any pending escalation. A failed or held fact while the order still holds a live route is a
 * continuation. The first failure with no live route left appends exactly one `message.held`
 * event and schedules the policy-delayed escalation. Any later fact for a finished episode is a
 * duplicate and appends no second event, including after a restart and after the event log has
 * rotated away from the first one.
 */
export function noteTransport(ctx: FallbackContext, fact: TransportFact): FallbackNote {
  const problem = factProblem(fact);
  if (problem !== null) return { ok: false, kind: 'marker', reason: problem };

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

  const wasDelivered = marker.status === 'delivered';
  const receipt = normalizeReceipt(fact.receipt);
  const attempt: AttemptRecord = {
    route: fact.route,
    outcome: fact.outcome,
    at: fact.at,
    ms: fact.ms,
    ...(fact.reason !== undefined ? { reason: fact.reason } : {}),
    receipt,
  };
  marker.attempts = [...marker.attempts, attempt].slice(-MAX_ATTEMPTS);
  marker.receipt = receipt;
  marker.updatedAt = fact.at;

  if (fact.outcome === 'delivered') {
    if (!wasDelivered) {
      marker.status = 'delivered';
      // Recovery cancels a pending escalation, including one a restart had already scheduled.
      delete marker.dueAt;
    }
    const wrote = writeMarker(path, marker);
    if (!wrote.ok) return { ok: false, kind: 'marker', reason: wrote.reason };
    return {
      ok: true,
      state: wasDelivered ? 'duplicate' : 'delivered',
      marker,
      eventDuplicate: false,
      dueAt: marker.dueAt ?? null,
    };
  }

  if (wasDelivered) {
    // The episode is over: the attempt is kept for the record, nothing is emitted or reopened.
    const wrote = writeMarker(path, marker);
    if (!wrote.ok) return { ok: false, kind: 'marker', reason: wrote.reason };
    return { ok: true, state: 'duplicate', marker, eventDuplicate: false, dueAt: marker.dueAt ?? null };
  }

  if (marker.allFailedAt !== undefined) {
    // The marker, not the rotated log, is what makes this a repeat.
    const wrote = writeMarker(path, marker);
    if (!wrote.ok) return { ok: false, kind: 'marker', reason: wrote.reason };
    return { ok: true, state: 'duplicate', marker, eventDuplicate: false, dueAt: marker.dueAt ?? null };
  }

  if (fact.liveRoutesRemain) {
    marker.status = 'trying';
    const wrote = writeMarker(path, marker);
    if (!wrote.ok) return { ok: false, kind: 'marker', reason: wrote.reason };
    return { ok: true, state: 'continued', marker, eventDuplicate: false, dueAt: marker.dueAt ?? null };
  }

  // First exhaustion. Schedule before the event so the persisted state explains what was emitted.
  marker.status = 'all-failed';
  marker.allFailedAt = fact.at;
  const delay = escalationDelayMs(ctx, fact.at);
  if (delay.ms !== null) marker.dueAt = new Date(Date.parse(fact.at) + delay.ms).toISOString();
  else delete marker.dueAt;

  const input: EventAppendInput = {
    ts: fact.at,
    kind: 'message.held',
    session: fact.recipient.session,
    record_id: allFailedRecordId(fact.messageId),
    from: marker.sender,
    to: fact.recipient.seat,
    seat: fact.recipient.seat,
    thread: fact.messageId,
    via: fact.route,
    reason: 'all live routes failed',
  };
  const appended = appendEvent(ctx.team.project, fact.recipient.root, ctx.home, input);
  if (!appended.ok) return { ok: false, kind: 'marker', reason: appended.reason };

  const wrote = writeMarker(path, marker);
  if (!wrote.ok) return { ok: false, kind: 'marker', reason: wrote.reason };
  return {
    ok: true,
    state: 'all-failed',
    marker,
    event: appended.record,
    eventDuplicate: appended.duplicate,
    dueAt: marker.dueAt ?? null,
    ...(delay.refusal !== undefined ? { policyRefusal: delay.refusal } : {}),
  };
}

/**
 * Fire the delayed main escalation for every episode whose `dueAt` has passed and whose delivery
 * has not followed. The scan reads markers under each root given (`ctx.root` by default); an
 * episode found in another checkout still resolves that checkout's entity lead by its own root.
 *
 * Idempotent: `escalatedAt` in the marker makes a second call — in this process, after a restart,
 * or after the event log rotated — write nothing. A delivery that arrived first has already
 * cleared `dueAt`. When the entity orchestrator does not resolve, the entry is refused and left
 * pending, so a pass under a repaired registry can still raise it.
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
    report.scanned += 1;
    const { marker, path } = found;
    if (marker.status !== 'all-failed') continue;
    if (marker.dueAt === undefined || marker.escalatedAt !== undefined) continue;
    const due = Date.parse(marker.dueAt);
    if (!Number.isFinite(due) || due > at.getTime()) continue;

    const orchestrator =
      ctx.orchestrator !== undefined
        ? ctx.orchestrator
        : readEntityOrchestrator(ctx.home, teamIdOf(marker.recipient.root));
    if (orchestrator === null) {
      report.refused.push({
        messageId: marker.messageId,
        recipient: marker.recipient,
        reason: `no main orchestrator resolves for ${marker.recipient.team}`,
      });
      continue;
    }

    const seconds = Math.round((at.getTime() - Date.parse(marker.allFailedAt ?? atIso)) / 1000);
    const input: EventAppendInput = {
      ts: atIso,
      kind: 'message.held',
      session: marker.recipient.session,
      record_id: escalatedRecordId(marker.messageId),
      from: marker.sender,
      to: orchestrator.seat,
      seat: marker.recipient.seat,
      thread: marker.messageId,
      via: 'fallback',
      reason: `still undelivered after ${seconds}s: all live routes failed`,
    };
    const appended = appendEvent(ctx.team.project, marker.recipient.root, ctx.home, input);
    if (!appended.ok) {
      report.refused.push({ messageId: marker.messageId, recipient: marker.recipient, reason: appended.reason });
      continue;
    }

    let mailbox: string | null = null;
    if (orchestrator.seat !== marker.recipient.seat) {
      const wrote = writeRuntimeMailboxRecord({
        root: orchestrator.root,
        home: ctx.home,
        to: orchestrator.seat,
        id: escalationMailboxId(marker.messageId),
        text: `all live routes to ${marker.recipient.seat} failed; message ${marker.messageId} is still undelivered after ${seconds}s`,
        session: orchestrator.session,
        at: atIso,
        once: true,
      });
      if (!wrote.ok) {
        // The event stands; leave `escalatedAt` unset so the next pass retries the mailbox.
        report.refused.push({ messageId: marker.messageId, recipient: marker.recipient, reason: wrote.error });
        continue;
      }
      mailbox = wrote.path;
    }

    marker.escalatedAt = atIso;
    marker.updatedAt = atIso;
    const wrote = writeMarker(path, marker);
    if (!wrote.ok) {
      report.refused.push({ messageId: marker.messageId, recipient: marker.recipient, reason: wrote.reason });
      continue;
    }
    report.escalated.push({
      messageId: marker.messageId,
      recipient: marker.recipient,
      event: appended.record,
      duplicate: appended.duplicate,
      mailbox,
    });
  }
  return report;
}

/** The policy delay before the main escalation. Resolved through the signed chain in force at the
 *  failure; an unreadable policy schedules nothing and says why. */
function escalationDelayMs(ctx: FallbackContext, at: string): { ms: number | null; refusal?: string } {
  const resolved = eventThresholdsInForce({
    home: ctx.home,
    root: ctx.root,
    team: ctx.team,
    now: new Date(at),
  });
  if (!resolved.ok) {
    return { ms: null, refusal: resolved.refusals.map((refusal) => refusal.message).join('; ') };
  }
  return { ms: resolved.thresholds.unreachable_threshold_seconds * 1000 };
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
 *  malformed value can never mint a marker or an event. */
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
