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
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createExclusive, ensureFolder } from './durable.ts';
import { seatFolderOf } from '../send/drop-folder.ts';

export const EXPOSURES = '.exposures';

/** The legs and readers a copy can leave through, as history names them. */
export type CopyLeg = 'channel' | 'typed' | 'native' | 'socket' | 'webhook' | 'read' | 'pointer';

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
export function takeCopyNumber(dropDir: string, id: string, leg: CopyLeg, nowMs: number = Date.now(), offer?: ChannelOffer): number | null {
  const folder = historyFolder(dropDir, id);
  if (!ensureFolder(join(seatFolderOf(dropDir, id), EXPOSURES)) || !ensureFolder(folder)) return null;
  const seen = copyHistory(dropDir, id);
  if (seen === 'unknown') return null;
  // A channel copy keeps its offer token and the listener that pushed it beside its number
  // (the Claude adapter §2.2). No reader prints a history entry.
  const extra = leg === 'channel' && offer !== undefined ? { offer: offer.token, listener: offer.listener } : {};
  for (let n = seen.copies + 1; n <= seen.copies + 8; n++) {
    const made = createExclusive(join(folder, String(n)), `${JSON.stringify({ v: 1, n, leg, at: new Date(nowMs).toISOString(), ...extra })}\n`);
    if (made === 'created') return n;
    if (made === 'failed') return null;
    // `exists`: a rival took n; try the next number.
  }
  return null;
}

/** Whether `path` is a real folder: present, a directory, and not a link. */
export function realFolder(path: string): boolean {
  try {
    const held = lstatSync(path);
    return held.isDirectory() && !held.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether the whole folder chain of a message's history is real folders, from the mail tree
 *  down (`<tree>/<session>/<seat>/.exposures/<id>`): no link anywhere on it. */
export function historyChainReal(dropDir: string, id: string): boolean {
  const seat = seatFolderOf(dropDir, id);
  return [dirname(dirname(seat)), dirname(seat), seat, join(seat, EXPOSURES), historyFolder(dropDir, id)].every(realFolder);
}

/** The largest proof or history entry read: these are a few hundred bytes. */
const ENTRY_MAX = 16_384;

/** A regular file's text, opened without following a final link and bounded in size; null for
 *  a link, a folder, a device, a fifo, an oversized file or any read failure. */
export function readRegularNoFollow(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const held = fstatSync(fd);
    if (!held.isFile() || held.size > ENTRY_MAX) return null;
    const buffer = Buffer.alloc(held.size);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return read === buffer.length ? buffer.toString('utf8') : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The offer a channel copy carries (the Claude adapter §2.2): a fresh random token, and the
 *  listener incarnation that pushed it (`<pid>@<listener ts>`). */
export type ChannelOffer = { token: string; listener: string };

/** One channel copy's offer, as its history entry keeps it. */
export type OfferedCopy = { n: number; token: string; listener: string; atMs: number };

/** The channel copies of one message that carry an offer token, in number order. A history that
 *  cannot be read, and an entry that cannot be parsed, offer nothing. */
export function offeredCopies(dropDir: string, id: string): OfferedCopy[] {
  const folder = historyFolder(dropDir, id);
  // Confined to the seat's own tree: every folder from the mail tree down is real, never a link,
  // and each entry is a bounded regular file opened without following a link.
  if (!historyChainReal(dropDir, id)) return [];
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const out: OfferedCopy[] = [];
  for (const name of names) {
    const match = COPY_NAME.exec(name);
    if (match === null) continue;
    try {
      const text = readRegularNoFollow(join(folder, name));
      if (text === null) continue;
      const entry = JSON.parse(text) as { leg?: unknown; offer?: unknown; listener?: unknown; at?: unknown };
      if (entry.leg !== 'channel' || typeof entry.offer !== 'string' || typeof entry.listener !== 'string') continue;
      const atMs = Date.parse(typeof entry.at === 'string' ? entry.at : '');
      out.push({ n: Number(match[1]), token: entry.offer, listener: entry.listener, atMs: Number.isFinite(atMs) ? atMs : 0 });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.n - b.n);
}

/** The scheduler's reserved attempts, with their times, in number order (withdrawn ones out). */
export function attemptTimes(dropDir: string, id: string): { k: number; atMs: number; channel: boolean }[] | 'unknown' {
  const folder = historyFolder(dropDir, id);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : 'unknown';
  }
  // Read only inside the seat tree, bounded and without following a link: an entry that cannot be
  // read that way makes the whole ledger unknown, and an unknown authorizes no new effect.
  if (!historyChainReal(dropDir, id)) return 'unknown';
  const present = new Set(names);
  const out: { k: number; atMs: number; channel: boolean }[] = [];
  for (const name of names) {
    const match = ATTEMPT_NAME.exec(name);
    if (match === null) continue;
    const text = readRegularNoFollow(join(folder, name));
    if (text === null) return 'unknown';
    let done: { via?: unknown; withdrawn?: unknown } | null = null;
    if (present.has(`${name}.done`)) {
      const doneText = readRegularNoFollow(join(folder, `${name}.done`));
      if (doneText === null) return 'unknown';
      try {
        done = JSON.parse(doneText) as { via?: unknown; withdrawn?: unknown };
      } catch {
        return 'unknown';
      }
      if (done.withdrawn === true) continue;
    }
    let entry: { at?: unknown; host?: unknown };
    try {
      entry = JSON.parse(text) as { at?: unknown; host?: unknown };
    } catch {
      return 'unknown';
    }
    const at = Date.parse(entry.at as string);
    if (!Number.isFinite(at)) return 'unknown';
    // A channel attempt: reserved by the channel server, or noted as taken by the channel.
    out.push({ k: Number(match[1]), atMs: at, channel: entry.host === 'channel' || done?.via === 'channel' });
  }
  return out.sort((a, b) => a.k - b.k);
}

/** The legs the message's numbered copies left through, in number order. */
export function copyLegs(dropDir: string, id: string): CopyLeg[] | 'unknown' {
  const folder = historyFolder(dropDir, id);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : 'unknown';
  }
  if (!historyChainReal(dropDir, id)) return 'unknown';
  const legs: { n: number; leg: CopyLeg }[] = [];
  for (const name of names) {
    const match = COPY_NAME.exec(name);
    if (match === null) continue;
    const text = readRegularNoFollow(join(folder, name));
    if (text === null) return 'unknown';
    try {
      const leg = (JSON.parse(text) as { leg?: unknown }).leg;
      if (typeof leg === 'string') legs.push({ n: Number(match[1]), leg: leg as CopyLeg });
    } catch {
      return 'unknown';
    }
  }
  return legs.sort((a, b) => a.n - b.n).map((one) => one.leg);
}

/** The legs a send's own first offer takes when it is not the adapter's channel push. */
const OTHER_FIRST_LEGS: readonly CopyLeg[] = ['typed', 'native', 'socket', 'webhook'];

/**
 * Whether the send's own first offer went by the channel: its first offering copy is not one of
 * another adapter's legs. A seat's own reads and the scheduler's pointers come after the first
 * offer and never stand for it, and a push that stalled before its number left no copy at all. A
 * history that cannot be read reads as the channel, so the seat is held unproven, not trusted.
 */
function firstOfferByChannel(dropDir: string, id: string): boolean {
  const legs = copyLegs(dropDir, id);
  if (legs === 'unknown') return true;
  const first = legs.find((leg) => leg !== 'read' && leg !== 'pointer');
  return first === undefined || !OTHER_FIRST_LEGS.includes(first);
}

/**
 * The message's newest offer (the Claude adapter §2.3, the one clock): its start and whether it
 * went by the channel. With scheduler attempts, it is the newest attempt: its reservation time,
 * and channel when the channel server reserved it or noted it taken. Without any, it is the
 * send's own first offer at the record's arrival.
 */
export function newestOffer(dropDir: string, id: string, arrivedMs: number): { startMs: number; channel: boolean } {
  const read = attemptTimes(dropDir, id);
  // An unknown ledger moves no clock and changes no adapter: the record waits for its backoff.
  if (read === 'unknown') return { startMs: arrivedMs, channel: false };
  const attempts = read;
  const newest = attempts.reduce<{ k: number; atMs: number; channel: boolean } | null>((best, one) => (best === null || one.k > best.k ? one : best), null);
  if (newest !== null) return { startMs: newest.atMs, channel: newest.channel };
  return { startMs: arrivedMs, channel: firstOfferByChannel(dropDir, id) };
}

/**
 * The start of the message's first channel offer that is still outstanding (§2.3): the send's own
 * first offer at arrival when it went by the channel, else the earliest channel attempt. A later
 * offer — a pointer, or another channel push — never moves this deadline. Null when no offer of
 * the message went by the channel.
 */
export function firstChannelOffer(dropDir: string, id: string, arrivedMs: number): number | null | 'unknown' {
  const attempts = attemptTimes(dropDir, id);
  const legs = copyLegs(dropDir, id);
  if (attempts === 'unknown' || legs === 'unknown') return 'unknown';
  if (firstOfferByChannel(dropDir, id)) return arrivedMs;
  const channel = attempts.filter((one) => one.channel).map((one) => one.atMs);
  return channel.length === 0 ? null : Math.min(...channel);
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
 *  no attempts; an attempt file that cannot be read counts with its file time. A withdrawn
 *  attempt (`withdrawAttempt`: nothing left this process for it) counts for neither. */
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
  const present = new Set(names);
  for (const name of names) {
    const match = ATTEMPT_NAME.exec(name);
    if (match === null) continue;
    if (present.has(`${name}.done`) && withdrawn(join(folder, `${name}.done`))) continue;
    attempts += 1;
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
  const k = highestAttempt(folder) + 1;
  const made = createExclusive(join(folder, `.attempt-${String(k)}`), `${JSON.stringify({ v: 1, k, host, at: new Date(nowMs).toISOString() })}\n`);
  return made === 'created' ? k : null;
}

function withdrawn(path: string): boolean {
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { withdrawn?: unknown }).withdrawn === true;
  } catch {
    return false;
  }
}

/** The highest attempt number reserved, withdrawn ones included: a number is used once. */
function highestAttempt(folder: string): number {
  let highest = 0;
  try {
    for (const name of readdirSync(folder)) {
      const match = ATTEMPT_NAME.exec(name);
      if (match !== null && Number(match[1]) > highest) highest = Number(match[1]);
    }
  } catch {
    // An unlistable folder: the exclusive create below refuses a taken number anyway.
  }
  return highest;
}

/** Withdraws attempt `k`: nothing left this process for it (a typed request whose pointer was
 *  never typed), so it neither counts nor moves the clock, and the record stays due. Exclusive:
 *  an attempt whose outcome is already noted is not withdrawn. */
export function withdrawAttempt(dropDir: string, id: string, k: number): void {
  createExclusive(join(historyFolder(dropDir, id), `.attempt-${String(k)}.done`), `${JSON.stringify({ v: 1, k, withdrawn: true })}\n`);
}

/** Records what attempt `k` carried: the copy number it took (null for none) and its leg. Best
 *  effort and exclusive: the reservation alone already counts and spaces the attempt. */
export function noteAttemptOutcome(dropDir: string, id: string, k: number, outcome: { copy: number | null; via: string | null; settled?: true }): void {
  const folder = historyFolder(dropDir, id);
  createExclusive(join(folder, `.attempt-${String(k)}.done`), `${JSON.stringify({ v: 1, k, ...outcome })}\n`);
}

/** Takes exactly delivery number `n` for one copy, durably: true only when this call created it
 *  (a rival that took `n` first, or a history that cannot be written, takes nothing). For a copy
 *  whose text already names its number, such as a re-send's typed pointer. */
export function takeExactCopyNumber(dropDir: string, id: string, leg: CopyLeg, n: number, nowMs: number = Date.now()): boolean {
  const folder = historyFolder(dropDir, id);
  if (!ensureFolder(join(seatFolderOf(dropDir, id), EXPOSURES)) || !ensureFolder(folder)) return false;
  return createExclusive(join(folder, String(n)), `${JSON.stringify({ v: 1, n, leg, at: new Date(nowMs).toISOString() })}\n`) === 'created';
}

/**
 * Whether a stamped, unsettled record is due for another offer now (R3.4). The send's own
 * delivery is attempt one; each scheduler attempt adds one, and a numbered copy (whoever took it:
 * a leg of an attempt, or the seat's own read) only moves the clock, never the count. The wait is
 * `backoffMs(1 + attempts)` from the newest of: the newest copy, the newest attempt, the record's
 * arrival (`arrivedMs`). So copy 1 then an offer that carried nothing waits 120 s, and a crash
 * after a reservation still spaces the next one.
 */
export function resendDue(dropDir: string, id: string, nowMs: number, arrivedMs: number | null, adapterChanged = false): boolean {
  // The Claude adapter §2.3: a record whose newest offer went by the channel, at a seat that is
  // now unproven, is due at once, so the pointer follows within one sweep.
  if (adapterChanged) return true;
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
