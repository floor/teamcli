// The at-least-once hand-over (rfc-event-comms E7b).
//
// A stamped record (`lvl: 3`, src/send/record.ts) is delivered until its recipient acknowledges
// it: settlement is the recipient's ack, a reply or a lead's clearance (`isRead` for a stamped
// record), never a writer-side read. Every copy of it that any leg or reader hands over carries one
// header naming the message and its delivery number, and every copy after the first says it is a
// re-send, so no copy is ever silent, whatever order the copies arrive in (R4.1).
//
// Delivery history, one folder per message, never rewritten:
//   <dropDir>/.exposures/<id>/<n>   created exclusively and durably (file and folder fsync)
//                                   immediately before the copy numbered n leaves; the leg is inside
// The number is taken by the exclusive create itself: two copies racing for n, on any two legs, both try `<n>`
// and the loser moves on to n+1, so a number is used once. A history that cannot be read or
// written is unknown, and no copy leaves (the record stays due; R2.2 X3 defer).
//
// Retry (R3.4): a stamped record that is not settled is due again once `backoff(n)` has passed
// since its newest attempt: 60 s, doubling, capped at 30 minutes, with no attempt limit and no
// last day. The send's own delivery is the first attempt; each re-send attempt is reserved
// durably beside the history (`.exposures/<id>/.attempt-<k>`) before it is dispatched, so two
// hosts never dispatch the same attempt. One scheduler asks `resendDue` (src/queue/resend.ts).
//
// This module is inside the comms boundary: only the legs and the deliberate readers call it,
// and no other module writes under `.exposures/` (test/handover-boundary.test.ts).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createExclusive, ensureFolder } from './durable.ts';
import { seatFolderOf } from '../send/drop-folder.ts';

export const EXPOSURES = '.exposures';

/** The legs and readers a copy can leave through, as history names them. */
export type CopyLeg = 'channel' | 'typed' | 'native' | 'socket' | 'read' | 'pointer';

/** One name per number, whatever the leg (the leg is in the file): two legs that read the same
 *  history race for the same name, and exactly one of them wins it. */
const COPY_NAME = /^([1-9][0-9]{0,8})$/;

/** First retry after 60 s, doubling, never longer than 30 minutes; no attempt limit. */
export const FIRST_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 30 * 60_000;

export function backoffMs(copies: number): number {
  if (copies <= 0) return 0;
  const doubled = FIRST_BACKOFF_MS * 2 ** Math.min(copies - 1, 16);
  return Math.min(doubled, MAX_BACKOFF_MS);
}

function historyFolder(dropDir: string, id: string): string {
  // E7b revision 3: the history sits in the seat folder of the record's own tree.
  return join(seatFolderOf(dropDir, id), EXPOSURES, id);
}

export type CopyHistory = { copies: number; lastMs: number | null };

/** The message's copies so far: their count (the highest number taken) and the newest one's
 *  time. `unknown` when the folder or an entry cannot be read; a missing folder is no copies. */
export function copyHistory(dropDir: string, id: string): CopyHistory | 'unknown' {
  let names: string[];
  try {
    names = readdirSync(historyFolder(dropDir, id));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { copies: 0, lastMs: null } : 'unknown';
  }
  let copies = 0;
  let lastMs: number | null = null;
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const match = COPY_NAME.exec(name);
    if (match === null) continue;
    const n = Number(match[1]);
    if (n > copies) copies = n;
    let mtime: number;
    try {
      mtime = statSync(join(historyFolder(dropDir, id), name)).mtimeMs;
    } catch {
      return 'unknown';
    }
    if (lastMs === null || mtime > lastMs) lastMs = mtime;
  }
  return { copies, lastMs };
}

/**
 * Takes the next delivery number for one copy, durably, immediately before it leaves. Null when
 * the history cannot be read or written: the caller sends no copy now (the record stays due).
 */
export function takeCopyNumber(dropDir: string, id: string, leg: CopyLeg, nowMs: number = Date.now()): number | null {
  const folder = historyFolder(dropDir, id);
  if (!ensureFolder(join(seatFolderOf(dropDir, id), EXPOSURES)) || !ensureFolder(folder)) return null;
  const seen = copyHistory(dropDir, id);
  if (seen === 'unknown') return null;
  for (let n = seen.copies + 1; n <= seen.copies + 8; n++) {
    const made = createExclusive(join(folder, String(n)), `${JSON.stringify({ v: 1, n, leg, at: new Date(nowMs).toISOString() })}\n`);
    if (made === 'created') return n;
    if (made === 'failed') return null;
    // `exists`: a rival took n; try the next number.
  }
  return null;
}

/**
 * The re-send scheduler's attempts at one message, beside its history: one dot-named file per
 * attempt, `.attempt-<k>`, created exclusively and durably (file and folder fsync) immediately
 * BEFORE the offer is dispatched, and never rewritten. Two hosts racing for the same due attempt
 * both try `<k>`; exactly one creates it and dispatches, the other offers nothing. The outcome,
 * when the offer returns, is a second file `.attempt-<k>.done` naming the copy it carried, if any.
 * A dot name is never a numbered copy (`copyHistory` skips it).
 */
const ATTEMPT_NAME = /^\.attempt-([1-9][0-9]{0,8})$/;

export type AttemptLedger = { attempts: number; lastMs: number | null };

/** The scheduler's attempts so far and the newest one's time. A folder that cannot be listed is
 *  no attempts; an attempt file that cannot be read counts with its file time. */
export function attemptLedger(dropDir: string, id: string): AttemptLedger {
  const folder = historyFolder(dropDir, id);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return { attempts: 0, lastMs: null };
  }
  let attempts = 0;
  let lastMs: number | null = null;
  for (const name of names) {
    const match = ATTEMPT_NAME.exec(name);
    if (match === null) continue;
    const k = Number(match[1]);
    if (k > attempts) attempts = k;
    let at = Number.NaN;
    try {
      at = Date.parse((JSON.parse(readFileSync(join(folder, name), 'utf8')) as { at?: unknown }).at as string);
    } catch {
      // Read by its file time below.
    }
    if (!Number.isFinite(at)) {
      try {
        at = statSync(join(folder, name)).mtimeMs;
      } catch {
        continue;
      }
    }
    if (lastMs === null || at > lastMs) lastMs = at;
  }
  return { attempts, lastMs };
}

/**
 * Reserves the next attempt, durably, before its offer is dispatched. Null when a rival host took
 * that attempt first, or when the history cannot be written: the caller offers nothing now (the
 * record stays due, and a crash after this reservation still counts and spaces the attempt).
 */
export function reserveAttempt(dropDir: string, id: string, host: string, nowMs: number): number | null {
  const folder = historyFolder(dropDir, id);
  if (!ensureFolder(join(seatFolderOf(dropDir, id), EXPOSURES)) || !ensureFolder(folder)) return null;
  const k = attemptLedger(dropDir, id).attempts + 1;
  const made = createExclusive(join(folder, `.attempt-${String(k)}`), `${JSON.stringify({ v: 1, k, host, at: new Date(nowMs).toISOString() })}\n`);
  return made === 'created' ? k : null;
}

/** Records what attempt `k` carried: the copy number it took (null for none) and its leg. Best
 *  effort and exclusive: the reservation alone already counts and spaces the attempt. */
export function noteAttemptOutcome(dropDir: string, id: string, k: number, outcome: { copy: number | null; via: string | null; settled?: true }): void {
  const folder = historyFolder(dropDir, id);
  createExclusive(join(folder, `.attempt-${String(k)}.done`), `${JSON.stringify({ v: 1, k, ...outcome })}\n`);
}

/**
 * Whether a stamped, unsettled record is due for another offer now (R3.4). The send's own
 * delivery is attempt one; each scheduler attempt adds one, and a numbered copy (whoever took it:
 * a leg of an attempt, or the seat's own read) only moves the clock, never the count. The wait is
 * `backoffMs(1 + attempts)` from the newest of: the newest copy, the newest attempt, the record's
 * arrival (`arrivedMs`). So copy 1 then an offer that carried nothing waits 120 s, and a crash
 * after a reservation still spaces the next one.
 */
export function resendDue(dropDir: string, id: string, nowMs: number, arrivedMs: number | null): boolean {
  const seen = copyHistory(dropDir, id);
  const lastCopy = seen === 'unknown' ? null : seen.lastMs;
  const ledger = attemptLedger(dropDir, id);
  const times = [lastCopy, ledger.lastMs, arrivedMs].filter((one): one is number => one !== null);
  if (times.length === 0) return true;
  return nowMs - Math.max(...times) >= backoffMs(1 + ledger.attempts);
}

/** The header line every copy of a stamped record carries (R4.1). */
export function deliveryHeader(id: string, n: number): string {
  return n <= 1
    ? `message ${id} · delivery 1`
    : `message ${id} · delivery ${String(n)} — a re-send; an earlier delivery of this message may already have arrived or may still arrive`;
}

/** The line that ends every copy: the one act that settles the message. */
export function ackLine(id: string): string {
  return `Acknowledge it with \`team ack ${id}\` once you have read it; until then it is delivered again.`;
}

/** One copy's text: the header, the text the leg carries, and the ack line. */
export function wrapCopy(text: string, id: string, n: number): string {
  return `${deliveryHeader(id, n)}\n\n${text}\n\n${ackLine(id)}`;
}

/** The copy's text with its header and ack line taken off again, for a check that compares a
 *  carried copy with the record's own body. Text without them is returned unchanged. */
export function unwrapCopy(text: string, id: string): string {
  const head = `message ${id} · delivery `;
  if (!text.startsWith(head)) return text;
  const start = text.indexOf('\n\n');
  const tail = `\n\n${ackLine(id)}`;
  if (start < 0 || !text.endsWith(tail)) return text;
  return text.slice(start + 2, text.length - tail.length);
}

/**
 * The copy a reader or relay hands over: unchanged for an unstamped record; numbered for a stamped
 * one. When the number cannot be taken, the copy still names its message and says it may be a
 * re-send, so it is never silent (R4.1).
 */
export function copyFor(text: string, dropDir: string, id: string, stamped: boolean, leg: CopyLeg): string {
  if (!stamped) return text;
  const n = takeCopyNumber(dropDir, id, leg);
  if (n !== null) return wrapCopy(text, id, n);
  return `message ${id} · delivery not recorded — this may be a re-send\n\n${text}\n\n${ackLine(id)}`;
}
