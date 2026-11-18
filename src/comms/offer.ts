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
import type { KeyObject } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createExclusive } from '../queue/durable.ts';
import { offeredCopies, readRegularNoFollow, realFolder } from '../queue/handover.ts';
import { twinsOf } from '../queue/mail-tree.ts';
import { sameFolder } from '../send/record.ts';
import { signDomain, verifyDomain } from '../store/keys.ts';
import type { Json } from '../store/keys.ts';

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

/** What a proof is bound to: the seat's checkout, session and name, and the message key. */
export type OfferBinding = { root: string; session: string; seat: string; key: KeyObject };

/** The signing domain of a proof entry: never a message, a receipt or an approval. */
const PROOF_DOMAIN = 'team-offer-proof-v1\n';

type ProofPayload = { v: 1; kind: 'offer-proof'; root: string; session: string; seat: string; listener: string; id: string; n: number; at: string };

/**
 * Records a proving ack: the token matches a channel copy of `id` that the listener `listenerKey`
 * pushed. The entry is signed with the message key and bound to the seat, the listener and the
 * copy, so only a matching token-bearing ack can stand as proof. Returns the entry, or null when
 * the token proves nothing (no match, another incarnation's copy, a malformed token) or the log
 * cannot be written. Exclusive per copy.
 */
export function proveOffer(dropDir: string, id: string, token: unknown, listenerKey: string, binding: OfferBinding, nowMs: number = Date.now()): OfferAck | null {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const match = offeredCopies(dropDir, id).find((copy) => copy.token === token && copy.listener === listenerKey);
  if (match === undefined) return null;
  const folder = offerAckFolder(dropDir, listenerKey);
  if (folder === null) return null;
  const payload: ProofPayload = { v: 1, kind: 'offer-proof', root: binding.root, session: binding.session, seat: binding.seat, listener: listenerKey, id, n: match.n, at: new Date(nowMs).toISOString() };
  const signature = signDomain(PROOF_DOMAIN, payload as unknown as Json, binding.key);
  const made = createExclusive(join(folder, `${id}.${String(match.n)}`), `${JSON.stringify({ payload, signature })}\n`);
  return made === 'failed' ? null : { id, n: match.n, atMs: nowMs };
}

/**
 * The listener's proving acks, oldest first. Each entry is read without following a link, its
 * signature verified under the proof domain, its binding checked against this seat and listener,
 * and its copy matched to a channel copy this listener pushed. Anything else proves nothing. A
 * log that cannot be listed is empty.
 */
export function offerAcks(dropDir: string, listenerKey: string, binding: OfferBinding): OfferAck[] {
  const folder = offerAckFolder(dropDir, listenerKey);
  if (folder === null) return [];
  // Confined to the seat's stamped folder: the log and its parent are real folders, not links.
  if (!realFolder(dirname(folder)) || !realFolder(folder)) return [];
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const out: OfferAck[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const text = readRegularNoFollow(join(folder, name));
    if (text === null) continue;
    try {
      const parsed = JSON.parse(text) as { payload?: ProofPayload; signature?: unknown };
      const payload = parsed.payload;
      if (payload === undefined || typeof parsed.signature !== 'string') continue;
      if (payload.v !== 1 || payload.kind !== 'offer-proof' || typeof payload.id !== 'string' || typeof payload.n !== 'number' || typeof payload.at !== 'string') continue;
      if (!verifyDomain(PROOF_DOMAIN, payload as unknown as Json, parsed.signature, binding.key)) continue;
      if (!sameFolder(payload.root, binding.root) || payload.session !== binding.session || payload.seat !== binding.seat || payload.listener !== listenerKey) continue;
      if (name !== `${payload.id}.${String(payload.n)}`) continue;
      if (!offeredCopies(dropDir, payload.id).some((copy) => copy.n === payload.n && copy.listener === listenerKey)) continue;
      const atMs = Date.parse(payload.at);
      if (!Number.isFinite(atMs)) continue;
      out.push({ id: payload.id, n: payload.n, atMs });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}
