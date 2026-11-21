// The channel proof probe (the Claude adapter §2.1–2.2, before activation).
//
// A Claude seat's channel is proven only by an ack that carries the offer token of a stamped copy
// its own live listener pushed (src/comms/offer.ts). On a dark root no ordinary record is stamped,
// so nothing is ever pushed with a token, and a seat whose pane is protected (the entity's main
// orchestrator, a human pane) has no typed-pointer proof either: `team queues activate` refuses it
// for good. The probe breaks that circle without weakening the rule: `team queues prove` places
// one signed, stamped record for such a seat. The seat's own channel server pushes it like any
// stamped arrival, with a fresh offer token in its meta; the seat's ack with that token writes the
// listener's token-ack log, and the next `team queues activate` reads the proof there. An ack
// without the token settles the probe and proves nothing, exactly as for any other message.
//
// The probe is the only record a probe principal signs: `from: runtime`, no agent id, and the
// probe rule. Channel admission names this exact triple (src/mcp/channel-admit.ts), as it names
// the general brief's. It carries no instruction beyond the ack.
import { randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { offeringListeners } from '../comms/offer.ts';
import { appendDeliverySync } from './append.ts';
import { queueLog } from './log.ts';
import { seatDropDir, stampedListing } from './mail-tree.ts';
import { DELIVERY_LEVEL, isRecordSidecarName, readRecord, recordNameOk, signRecord, stampedSettled, verifyRecord, writeRecord, type RecordPayload } from '../send/record.ts';

/** The principal a probe is signed as: the runtime, never a seat or the owner. */
export const CHANNEL_PROBE_FROM = 'runtime';

/** The rule every probe carries, and the only rule channel admission accepts for the principal. */
export const CHANNEL_PROBE_RULE = 'a channel proof probe (team queues prove)';

/** A probe still unsettled and pushed by no other listener stands this long before another. */
export const PROBE_PENDING_MS = 10 * 60_000;

/** The probe's whole body: what it is, and the one thing it asks. */
export const CHANNEL_PROBE_BODY = 'TeamCLI channel proof probe. Acknowledge it with the ack tool, passing the id and offer from this notification\'s meta. Nothing else to do.';

/** Whether a verified payload is a channel probe. */
export function isChannelProbe(payload: Pick<RecordPayload, 'from' | 'from_id' | 'rule'>): boolean {
  return payload.from === CHANNEL_PROBE_FROM && payload.from_id === null && payload.rule === CHANNEL_PROBE_RULE;
}

/**
 * The seat's probe that can still prove the current listener: a verified probe, unsettled, placed
 * within `PROBE_PENDING_MS`, and either not yet pushed or pushed by this listener. Null when there
 * is none. A probe another (earlier) listener took is no longer pending for this one: a server
 * leaves mail already waiting at its start to `inbox_check`, so only a fresh probe reaches it.
 */
export function pendingProbe(input: { root: string; session: string; seat: string; key: KeyObject; listenerKey: string; nowMs: number; lead?: string }): string | null {
  const dropDir = seatDropDir(input.root, input.session, input.seat);
  const listing = stampedListing(dropDir);
  if (listing === null || listing === 'unreadable') return null;
  for (const name of listing.names) {
    if (name.startsWith('.') || isRecordSidecarName(name) || !recordNameOk(name)) continue;
    let arrived: number;
    try {
      const stat = lstatSync(join(listing.folder, name));
      if (!stat.isFile()) continue;
      arrived = stat.mtimeMs;
    } catch {
      continue;
    }
    if (input.nowMs - arrived > PROBE_PENDING_MS) continue;
    const read = readRecord(join(listing.folder, name), name);
    if (!read.ok || read.record === null || !verifyRecord(read.record, input.key)) continue;
    const payload = read.record.payload;
    if (!isChannelProbe(payload) || payload.to !== input.seat || payload.session !== input.session) continue;
    if (stampedSettled(listing.folder, name, { to: input.seat, root: input.root, session: input.session, ...(input.lead === undefined ? {} : { lead: input.lead }) }, input.key)) continue;
    const copies = offeringListeners(listing.folder, name);
    if (copies.length === 0 || copies.includes(input.listenerKey)) return name;
  }
  return null;
}

/**
 * Places one probe for the seat: a signed record stamped at the delivery level, written into the
 * seat's stamped folder through the queue's commit, as every stamped record is. Returns its id.
 */
export function placeChannelProbe(input: { home: string; root: string; session: string; seat: string; now: Date }): { ok: true; id: string } | { ok: false; reason: string } {
  let root: string;
  try {
    root = realpathSync(input.root);
  } catch {
    return { ok: false, reason: 'the checkout cannot be resolved' };
  }
  const id = randomUUID();
  const payload: RecordPayload = {
    kind: 'message', id, to: input.seat, to_id: null, root, session: input.session, at: input.now.toISOString(),
    body: CHANNEL_PROBE_BODY, from: CHANNEL_PROBE_FROM, from_id: null, rule: CHANNEL_PROBE_RULE, thread: id,
    lvl: DELIVERY_LEVEL,
  };
  let signed;
  try {
    signed = signRecord(payload, input.home);
  } catch {
    return { ok: false, reason: 'no message key' };
  }
  const dropDir = seatDropDir(root, input.session, input.seat);
  try {
    const { value: written } = appendDeliverySync({ dropDir, record: signed }, () => {
      const result = writeRecord(dropDir, signed);
      return { ok: result.ok, value: result };
    }, { home: input.home, log: queueLog(dropDir) });
    if (!written.ok) return { ok: false, reason: written.reason };
  } catch {
    return { ok: false, reason: 'the probe could not be written' };
  }
  return { ok: true, id };
}
