// The channel's offer token (the Claude adapter §2.2): the only addition to the channel.
//
// Each channel push of a stamped copy carries `meta.offer`, a fresh random token, kept beside
// that copy in its delivery history (`.exposures/<id>/<n>`, src/queue/handover.ts) with the
// listener incarnation that pushed it. The `ack` tool takes the token back. An ack whose token
// matches a channel copy THIS listener pushed is appended to the listener's token-ack log, in its
// stamped seat folder: that, and only that, proves the channel reaches the session. An ack without
// the token, or with another copy's or another incarnation's, still settles the message and
// proves nothing.
//
// The token is never printed: no reader, pointer, hook or status line reads the history entry or
// the log. A new incarnation (a restart, a reboot, a resume without the flag) has a new listener
// key and an empty log, so it starts unproven.
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExclusive } from '../queue/durable.ts';
import { offeredCopies } from '../queue/handover.ts';
import { twinsOf } from '../queue/mail-tree.ts';

/** The log folder, beside the stamped seat folder's own records (a dot name is never a record). */
export const OFFER_ACKS = '.offer-acks';

const TOKEN = /^[0-9a-f]{32}$/;

/** A fresh offer token. */
export function newOfferToken(): string {
  return randomBytes(16).toString('hex');
}

/** One listener incarnation's key: its pid and the time its marker was written. */
export function listenerKeyOf(listener: { pid: number; ts: string }): string {
  return `${String(listener.pid)}@${listener.ts}`;
}

/** The folder name a listener key is filed under: one directory entry, no separator. */
function keyFolderName(key: string): string {
  return key.replace(/[^0-9A-Za-z@.-]/g, '_');
}

/** The listener's token-ack log folder, in the seat's stamped folder; null for no seat folder. */
export function offerAckFolder(dropDir: string, listenerKey: string): string | null {
  const twins = twinsOf(dropDir);
  if (twins === null) return null;
  return join(twins.stamped, OFFER_ACKS, keyFolderName(listenerKey));
}

/** One proving ack, as the log keeps it. */
export type OfferAck = { id: string; n: number; atMs: number };

/**
 * Records a proving ack: the token matches a channel copy of `id` that the listener `listenerKey`
 * pushed. Returns the entry written, or null when the token proves nothing (no match, another
 * incarnation's copy, a malformed token) or the log cannot be written. Exclusive per copy.
 */
export function proveOffer(dropDir: string, id: string, token: unknown, listenerKey: string, nowMs: number = Date.now()): OfferAck | null {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const match = offeredCopies(dropDir, id).find((copy) => copy.token === token && copy.listener === listenerKey);
  if (match === undefined) return null;
  const folder = offerAckFolder(dropDir, listenerKey);
  if (folder === null) return null;
  const entry: OfferAck = { id, n: match.n, atMs: nowMs };
  const made = createExclusive(join(folder, `${id}.${String(match.n)}`), `${JSON.stringify({ v: 1, id, n: match.n, at: new Date(nowMs).toISOString() })}\n`);
  return made === 'failed' ? null : entry;
}

/** The listener's proving acks, oldest first. A log that cannot be listed is empty. */
export function offerAcks(dropDir: string, listenerKey: string): OfferAck[] {
  const folder = offerAckFolder(dropDir, listenerKey);
  if (folder === null) return [];
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const out: OfferAck[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(folder, name), 'utf8')) as { id?: unknown; n?: unknown; at?: unknown };
      if (typeof parsed.id !== 'string' || typeof parsed.n !== 'number' || typeof parsed.at !== 'string') continue;
      const atMs = Date.parse(parsed.at);
      if (!Number.isFinite(atMs)) continue;
      out.push({ id: parsed.id, n: parsed.n, atMs });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}
