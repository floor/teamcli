// The at-least-once hand-over (rfc-event-comms E7b).
//
// A stamped record (`lvl: 3`, src/send/record.ts) is delivered until its recipient acknowledges
// it: settlement is the recipient's ack, a reply or a lead's clearance (`isRead` for a stamped
// record), never a writer-side read. Every copy of it that any leg or reader hands over carries one
// header naming the message and its delivery number, and every copy after the first says it is a
// re-send, so no copy is ever silent, whatever order the copies arrive in (R4.1).
//
// Delivery history, one folder per message, never rewritten:
//   <dropDir>/.exposures/<id>/<n>.<leg>   created exclusively and durably (file and folder fsync)
//                                         immediately before the copy numbered n leaves
// The number is taken by the exclusive create itself: two copies racing for n both try `<n>.*`
// and the loser moves on to n+1, so a number is used once. A history that cannot be read or
// written is unknown, and no copy leaves (the record stays due; R2.2 X3 defer).
//
// Retry (R3.4): a stamped record that is not settled is due again once `backoff(n)` has passed
// since its newest copy: 60 s, doubling, capped at 30 minutes, with no attempt limit. The legs'
// own ladders (src/watch/unread.ts) and the channel server's redelivery pass ask `deliveryDue`.
//
// This module is inside the comms boundary: only the legs and the deliberate readers call it,
// and no other module writes under `.exposures/` (test/handover-boundary.test.ts).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createExclusive, ensureFolder } from './durable.ts';

export const EXPOSURES = '.exposures';

/** The legs and readers a copy can leave through, as history names them. */
export type CopyLeg = 'channel' | 'typed' | 'native' | 'socket' | 'read' | 'pointer';

const COPY_NAME = /^([1-9][0-9]{0,8})\.(channel|typed|native|socket|read|pointer)$/;

/** First retry after 60 s, doubling, never longer than 30 minutes; no attempt limit. */
export const FIRST_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 30 * 60_000;

export function backoffMs(copies: number): number {
  if (copies <= 0) return 0;
  const doubled = FIRST_BACKOFF_MS * 2 ** Math.min(copies - 1, 16);
  return Math.min(doubled, MAX_BACKOFF_MS);
}

function historyFolder(dropDir: string, id: string): string {
  return join(dropDir, EXPOSURES, id);
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
  if (!ensureFolder(join(dropDir, EXPOSURES)) || !ensureFolder(folder)) return null;
  const seen = copyHistory(dropDir, id);
  if (seen === 'unknown') return null;
  for (let n = seen.copies + 1; n <= seen.copies + 8; n++) {
    const made = createExclusive(join(folder, `${String(n)}.${leg}`), `${JSON.stringify({ v: 1, n, leg, at: new Date(nowMs).toISOString() })}\n`);
    if (made === 'created') return n;
    if (made === 'failed') return null;
    // `exists`: a rival took n; try the next number.
  }
  return null;
}

/** Whether a stamped, unsettled record is due for another copy now. Unknown history is due (the
 *  caller's own take then refuses until the history reads again). */
export function deliveryDue(dropDir: string, id: string, nowMs: number): boolean {
  const seen = copyHistory(dropDir, id);
  if (seen === 'unknown') return true;
  if (seen.copies === 0 || seen.lastMs === null) return true;
  return nowMs - seen.lastMs >= backoffMs(seen.copies);
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
