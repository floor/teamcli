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
// channel server of this level, which runs this scheduler. Whatever either host believes, an
// attempt is reserved durably and exclusively before it is dispatched (`reserveAttempt`), so two
// hosts at one due boundary dispatch it once. A dark root has no stamped folder, so neither host
// finds anything to offer there.
import type { KeyObject } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { stampedListing } from './mail-tree.ts';
import { ACTOR_LEVEL } from './floor.ts';
import { copyHistory, noteAttemptOutcome, reserveAttempt, resendDue } from './handover.ts';
import { inboxLive } from '../mcp/inbox.ts';
import { isRecordSidecarName, recordStampAt, stampedSettled, type StatusContext } from '../send/record.ts';

/** At most this many records are offered to one seat in one pass; the rest stay due. */
export const RESEND_PER_PASS = 3;

const RECORD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One seat as the scheduler reads it: its legacy seat folder (the stamped one is found from it),
 *  the context its settlement is read under, and the message key. */
export type ResendSeat = { dropDir: string; context: StatusContext; key: KeyObject };

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
    if (recordStampAt(listing.folder, name) !== true) continue;
    if (stampedSettled(listing.folder, name, seat.context, seat.key)) continue;
    if (!resendDue(listing.folder, name, nowMs, arrived)) continue;
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
export function channelOwnsSeat(input: { dropDir: string; root: string; session: string; seat: string; walkTakesChannel: boolean }): boolean {
  if (!input.walkTakesChannel) return false;
  const live = inboxLive(input.dropDir, input.root, input.session, input.seat);
  return live.live && live.listener.channel === true && (live.listener.level ?? 0) >= ACTOR_LEVEL;
}

/** What the seat's adapter did with one offer: the leg that took it, or null when none did. */
export type ResendOffer = (id: string) => Promise<string | null>;

/** One offer's outcome: its attempt, the copy number it carried (null when none) and its leg. */
export type ResendResult = { id: string; attempt: number; copy: number | null; via: string | null };

/**
 * One pass for one seat (`host` names it in the attempt record): each due record (up to `limit`)
 * has its attempt reserved durably and exclusively, its settlement read once more, and only then
 * is the offer dispatched; the attempt's outcome is noted after. A record whose attempt a rival
 * host reserved first is skipped. One record's failure never stops the pass: it stays due.
 */
export async function resendPass(seat: ResendSeat, nowMs: number, offer: ResendOffer, host: string, limit = RESEND_PER_PASS): Promise<ResendResult[]> {
  const listing = stampedListing(seat.dropDir);
  if (listing === null || listing === 'unreadable') return [];
  const started = Date.now();
  const results: ResendResult[] = [];
  for (const id of resendCandidates(seat, nowMs).slice(0, Math.max(0, limit))) {
    const at = nowMs + (Date.now() - started);
    const attempt = reserveAttempt(listing.folder, id, host, at);
    if (attempt === null) continue;
    if (stampedSettled(listing.folder, id, seat.context, seat.key)) {
      noteAttemptOutcome(listing.folder, id, attempt, { copy: null, via: null, settled: true });
      continue;
    }
    const before = copyHistory(listing.folder, id);
    let via: string | null = null;
    try {
      via = await offer(id);
    } catch {
      via = null;
    }
    const after = copyHistory(listing.folder, id);
    const copy = before !== 'unknown' && after !== 'unknown' && after.copies > before.copies ? after.copies : null;
    noteAttemptOutcome(listing.folder, id, attempt, { copy, via });
    results.push({ id, attempt, copy, via });
  }
  return results;
}
