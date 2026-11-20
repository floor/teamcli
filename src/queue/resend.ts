// The one re-send scheduler of the at-least-once contract (rfc-event-comms E7b, R3.4).
//
// Every stamped record that is not settled (its recipient's ack, a reply, or a lead's or the
// owner's clearance; `stampedSettled`) is offered again through the seat's current adapter once
// its backoff has passed: 60 s, doubling, capped at 30 minutes, with no attempt limit and no last
// day (`resendDue`, src/queue/handover.ts). The schedule is read from the delivery history and
// the offer ledger beside it, never from a per-leg ladder, so every leg type is covered the same
// way: a native queue, a typed wake, a socket frame and a channel push each take the next
// numbered copy when they carry the body, and a drop-only seat's copy is its next inbox read.
//
// The scheduler runs in two hosts. The watch's unread pass offers through the seat's resolved
// delivery walk, whatever adapter it names; the seat's own channel server offers by its push,
// because only it can write to its session. Which host owns a seat is one rule both ask
// (`channelOwnsSeat`): the seat's resolved walk takes the channel, and the live listener is a
// channel server of this level, which runs this scheduler. A candidate list is only a hint: the
// due decision and the attempt reservation are one critical section under the seat lock
// (`reserveDue`): the history and the attempts are read again there, the attempt k = 1 + attempts
// is created exclusively and durably, and the lock is let go before the offer is dispatched. So a
// stale decision, in either host, reserves nothing. A dark root has no stamped folder, so neither
// host finds anything to offer there.
import type { KeyObject } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { join } from 'node:path';
import { stampedListing } from './mail-tree.ts';
import { ACTOR_LEVEL } from './floor.ts';
import { attemptTimes, backoffMs, copyHistory, firstChannelOffer, newestOffer, noteAttemptOutcome, reserveAttempt, resendDue } from './handover.ts';
import { floorState } from './floor.ts';
import { inboxLive } from '../mcp/inbox.ts';
import { channelAborted, channelPushed } from '../mcp/channel.ts';
import { listenerKeyOf, offerAcks } from '../comms/offer.ts';
import { isRecordSidecarName, recordStampAt, stampedSettled, type StatusContext } from '../send/record.ts';

/** At most this many records are offered to one seat in one pass; the rest stay due. */
export const RESEND_PER_PASS = 3;

const RECORD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One seat as the scheduler reads it: its legacy seat folder (the stamped one is found from it),
 *  the context its settlement is read under (`to` and `session` name the seat), the message key,
 *  and the team's `.agents` folder, where the seat lock lives. */
export type ResendSeat = {
  dropDir: string;
  context: StatusContext;
  key: KeyObject;
  agentsDir: string;
  /** The Claude adapter (§2.3), for a claude-code seat on an active root: whether the seat is
   *  unproven now. A record whose newest offer went by the channel is then due at once. */
  unproven?: () => boolean;
  /** Only these records are offered (the Claude adapter: a proven seat's overdue records). */
  only?: ReadonlySet<string>;
};

/** How long a channel offer may stay unsettled before the seat is unproven (§2.3). */
export const CHANNEL_OVERDUE_MS = 90_000;

/** Why a claude-code seat's channel is not proven, or null when it is (the doctor's words). */
export type ChannelUnproven = 'no listener' | 'unproven since launch' | 'overdue offer';

/**
 * The Claude adapter's one fact, read live at each decision (§2.1): a live inbox listener of this
 * level for the seat declares the channel, that listener's token-ack log holds at least one ack
 * that carried a valid offer (src/comms/offer.ts), and no channel offer of this seat is overdue —
 * a record still unsettled 90 s after its newest offer started (the attempt's reservation, or the
 * record's arrival for the send's own first offer) with no proving ack from this listener for a
 * copy taken after that start. Nothing is stored; every unknown reads as not proven.
 */
export function channelUnproven(input: { dropDir: string; root: string; session: string; seat: string; context: StatusContext; key: KeyObject; nowMs: number }): ChannelUnproven | null {
  const live = inboxLive(input.dropDir, input.root, input.session, input.seat);
  if (!live.live || live.listener.channel !== true || (live.listener.level ?? 0) < ACTOR_LEVEL) return 'no listener';
  const listenerKey = listenerKeyOf(live.listener);
  const acks = offerAcks(input.dropDir, listenerKey, { root: input.root, session: input.session, seat: input.seat, key: input.key });
  if (acks.length === 0) return 'unproven since launch';
  const overdue = overdueChannelRecords(input);
  if (overdue === 'unreadable') return 'overdue offer';
  // A proving ack from this listener taken after an overdue offer's start: the channel works for
  // new traffic again. The overdue record itself stays owed a pointer (`overdueChannelRecords`).
  for (const start of overdue.values()) if (!acks.some((ack) => ack.atMs >= start)) return 'overdue offer';
  return null;
}

/**
 * The seat's stamped records whose first outstanding channel offer is overdue (§2.3): unsettled
 * 90 s after that offer started (the record's arrival, or the earliest channel attempt). A pointer
 * or a later push never moves the deadline, and a proving ack for another message never excuses
 * it: each stays owed a pointer until it settles. Maps id to that start; `unreadable` for a
 * stamped folder that cannot be listed.
 */
export function overdueChannelRecords(input: { dropDir: string; context: StatusContext; key: KeyObject; nowMs: number; givenUp?: boolean }): Map<string, number> | 'unreadable' {
  const out = new Map<string, number>();
  const listing = stampedListing(input.dropDir);
  if (listing === 'unreadable') return 'unreadable';
  if (listing === null) return out;
  for (const name of listing.names) {
    if (name.startsWith('.') || isRecordSidecarName(name) || !RECORD_NAME.test(name)) continue;
    let arrived: number;
    try {
      const stat = lstatSync(join(listing.folder, name));
      if (!stat.isFile()) continue;
      arrived = stat.mtimeMs;
    } catch {
      continue;
    }
    if (recordStampAt(listing.folder, name) !== true) continue;
    const start = firstChannelOffer(listing.folder, name, arrived);
    // With `givenUp`, a channel leg its sender gave up before any push is owed its pointer at once:
    // no offer is in flight. It never makes the channel itself unproven (`channelUnproven`).
    const givenUp = input.givenUp === true && start !== 'unknown' && channelOfferGivenUp(listing.folder, name);
    // An unreadable history authorizes nothing: the record is not listed as overdue.
    if (!givenUp && (start === null || start === 'unknown' || input.nowMs - start < CHANNEL_OVERDUE_MS)) continue;
    if (stampedSettled(listing.folder, name, input.context, input.key)) continue;
    out.set(name, givenUp ? (start ?? arrived) : start as number);
  }
  return out;
}

/** Whether the send's own channel leg gave this record up before the channel ever pushed it: the
 *  sender's abort stands, no server push marker does, and no copy was handed out. Nothing is in
 *  flight for the seat, so a proven seat's pointer is due at once rather than at an offer's 90 s
 *  deadline that never started. An unreadable history is not this. */
export function channelOfferGivenUp(folder: string, id: string): boolean {
  if (!channelAborted(folder, id) || channelPushed(folder, id)) return false;
  const copies = copyHistory(folder, id);
  return copies !== 'unknown' && copies.copies === 0;
}

/** The seat's stamped records that are unsettled and due now, oldest arrival first. */
export function resendCandidates(seat: ResendSeat, nowMs: number): string[] {
  const listing = stampedListing(seat.dropDir);
  if (listing === null || listing === 'unreadable') return [];
  const due: { id: string; arrived: number }[] = [];
  for (const name of listing.names) {
    if (name.startsWith('.') || isRecordSidecarName(name) || !RECORD_NAME.test(name)) continue;
    let arrived: number;
    try {
      const stat = lstatSync(join(listing.folder, name));
      if (!stat.isFile()) continue;
      arrived = stat.mtimeMs;
    } catch {
      continue;
    }
    if (!dueNow(listing.folder, name, seat, nowMs, arrived)) continue;
    due.push({ id: name, arrived });
  }
  return due.sort((a, b) => a.arrived - b.arrived || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((one) => one.id);
}

/**
 * The one ownership rule (both hosts ask it): the seat's channel server owns its re-sends exactly
 * when the seat's resolved walk takes the channel (`walkTakesChannel`, the send walk's own answer)
 * and the seat's live inbox listener is a channel server at this level, which runs this scheduler.
 * A live listener of an older build, which cannot see the stamped folder, owns nothing: the watch
 * offers for that seat.
 */
export function channelOwnsSeat(input: {
  dropDir: string;
  root: string;
  session: string;
  seat: string;
  walkTakesChannel: boolean;
  /** The Claude adapter (§2.1): for a claude-code seat on an active root, ownership is
   *  `channelUnproven(...) === null`, read live; the walk's answer is not asked. */
  adapter?: { cli: string; webhook?: boolean; home: string; context: StatusContext; key: KeyObject; nowMs: number };
}): boolean {
  if (input.adapter !== undefined && claudeAdapterRoot(input.adapter.cli, input.root, input.adapter.home, input.adapter.webhook === true)) {
    return channelUnproven({ dropDir: input.dropDir, root: input.root, session: input.session, seat: input.seat, context: input.adapter.context, key: input.adapter.key, nowMs: input.adapter.nowMs }) === null;
  }
  if (!input.walkTakesChannel) return false;
  const live = inboxLive(input.dropDir, input.root, input.session, input.seat);
  return live.live && live.listener.channel === true && (live.listener.level ?? 0) >= ACTOR_LEVEL;
}

/** Whether the Claude adapter decides this seat's offers: a claude-code seat with a pane (a seat
 *  that declares a webhook row is a routine, reached by its webhook as before) on a root that is
 *  not dark (an unreadable floor reads as active, as the stamp does). */
export function claudeAdapterRoot(cli: string, root: string, home: string, webhook = false): boolean {
  if (cli !== 'claude-code' || webhook) return false;
  try {
    return floorState(root, home).kind !== 'dark';
  } catch {
    return true;
  }
}

function dueNow(folder: string, id: string, seat: ResendSeat, nowMs: number, arrived: number): boolean {
  if (seat.only !== undefined && !seat.only.has(id)) return false;
  if (recordStampAt(folder, id) !== true || stampedSettled(folder, id, seat.context, seat.key)) return false;
  // The Claude adapter's seats (the watch binds `unproven`, or the proven seat's `only` set) keep
  // the pointer clock alone (§2.3): an unreadable history declines the attempt before any other
  // history read; the first pointer since the first channel offer is due at once while the seat is
  // unproven, or at that offer's 90 s deadline once it is proven; each later one waits
  // `backoffMs(1 + pointers)` from the newest pointer attempt. A copy never moves this clock.
  if (seat.only !== undefined || seat.unproven !== undefined) {
    const start = firstChannelOffer(folder, id, arrived);
    const attempts = attemptTimes(folder, id);
    if (start === 'unknown' || attempts === 'unknown') return false;
    const pointers = attempts.filter((one) => !one.channel && (start === null || one.atMs >= start));
    if (pointers.length === 0) {
      if (seat.only !== undefined) {
        // The send's channel offer was given up before any push: nothing is in flight, so the
        // pointer is due at once; otherwise the offer's 90 s deadline.
        if (channelOfferGivenUp(folder, id)) return true;
        return start !== null && nowMs - start >= CHANNEL_OVERDUE_MS;
      }
      return seat.unproven !== undefined && seat.unproven();
    }
    const newest = Math.max(...pointers.map((one) => one.atMs));
    return nowMs - newest >= backoffMs(1 + pointers.length);
  }
  return resendDue(folder, id, nowMs, arrived);
}

/**
 * The due decision and the reservation, as one critical section under the seat lock: the record,
 * its settlement, its history and its attempts are read again under the lock, and only if it is
 * due now is attempt k = 1 + attempts created, exclusively and durably. The lock is let go before
 * the caller dispatches. Null when the lock is not taken, the record is no longer due (a stale
 * decision), or the reservation cannot be made: nothing is offered.
 */
export function reserveDue(seat: ResendSeat, id: string, nowMs: number, host: string): number | null {
  const listing = stampedListing(seat.dropDir);
  if (listing === null || listing === 'unreadable') return null;
  const lock = acquireSeatLock(seat.agentsDir, seat.context.session, seat.context.to);
  if (!('release' in lock)) return null;
  try {
    let arrived: number;
    try {
      const stat = lstatSync(join(listing.folder, id));
      if (!stat.isFile()) return null;
      arrived = stat.mtimeMs;
    } catch {
      return null;
    }
    if (!dueNow(listing.folder, id, seat, nowMs, arrived)) return null;
    return reserveAttempt(listing.folder, id, host, nowMs);
  } finally {
    lock.release();
  }
}

/** What the seat's adapter did with one offer: the leg that took it, or null when none did, or
 *  `TYPED_REQUESTED`: the walk stopped at its typed leg and asked the watch's typed wake, whose
 *  outcome is not known yet. Its attempt is then noted by the caller once the pointer was typed
 *  (`noteAttemptOutcome`), or withdrawn (`withdrawAttempt`) when it was not. */
export type ResendOffer = (id: string) => Promise<string | null>;

export const TYPED_REQUESTED = 'typed-requested';

/** One offer's outcome: its attempt, the copy number it carried (null when none) and its leg. */
export type ResendResult = { id: string; attempt: number; copy: number | null; via: string | null };

/**
 * One pass for one seat (`host` names it in the attempt record): each candidate (up to `limit`) is
 * decided and reserved under the seat lock (`reserveDue`), and only a reserved attempt is
 * dispatched, outside the lock; its outcome is noted after. One record's failure never stops the
 * pass: it stays due.
 */
export async function resendPass(seat: ResendSeat, nowMs: number, offer: ResendOffer, host: string, limit = RESEND_PER_PASS): Promise<ResendResult[]> {
  const listing = stampedListing(seat.dropDir);
  if (listing === null || listing === 'unreadable') return [];
  const started = Date.now();
  const results: ResendResult[] = [];
  for (const id of resendCandidates(seat, nowMs).slice(0, Math.max(0, limit))) {
    const at = nowMs + (Date.now() - started);
    const attempt = reserveDue(seat, id, at, host);
    if (attempt === null) continue;
    const before = copyHistory(listing.folder, id);
    let via: string | null = null;
    try {
      via = await offer(id);
    } catch {
      via = null;
    }
    const after = copyHistory(listing.folder, id);
    const copy = before !== 'unknown' && after !== 'unknown' && after.copies > before.copies ? after.copies : null;
    if (via !== TYPED_REQUESTED) noteAttemptOutcome(listing.folder, id, attempt, { copy, via });
    results.push({ id, attempt, copy, via });
  }
  return results;
}
