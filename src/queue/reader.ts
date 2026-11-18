// The E7 reader switch (rfc-event-comms §10, step E7).
//
// The queue becomes the order a seat reads its mail in, team by team, behind a capability flag.
// The canonical records never move, and the receipts that settle a message stay the ones every
// reader already honours (`read`, `replied`, a lead's clearance). So the switch changes one thing:
// a listing's ORDER and the seq each message is offered at. It never changes WHICH messages wait.
//
// The switch is the signed READER record under `<root>/.agents/queues/`, written beside the floor
// files and under the same activation lock:
//
//   R0 prove    the root is ACTIVE at level >= READER_LEVEL (so every live actor reports a level
//               that knows the switch: mixed versions keep the root dark and every reader legacy),
//               and every seat queue of the root passes `seatQueueCheck` (no hole, no unread record
//               without a committed verifying entry, pending dual writes drained, quarantine empty).
//   R1 record   READER created exclusively, signed, durable (file and folder fsynced). A crash
//               before the link leaves the switch off; after the fsync it is on.
//   off         READER removed durably. Rollback mid-traffic: the next listing is legacy, and no
//               message moves or disappears, because the set never depended on the switch.
//
// A listing in queue order needs, at read time, every one of: READER verifies, the floor is ACTIVE
// at >= READER_LEVEL, a snapshot of the seat's journal taken under its queue lock is durable and
// whole, no reserved hole at or below the highest listed seq, and every listed message holds a
// committed entry that verifies for this root, session, seat and generation. Anything unknown,
// missing or contradictory answers `legacy` with the reason: the legacy listing is the full set,
// so falling back can delay order, never hide a message (fail closed toward visibility).

import { join } from 'node:path';
import { messageKeyOf, messageKeyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { committedSnapshot, readEntry, queueBaseOf } from './append.ts';
import { createExclusive, readFence, removeDurable, type DurableFaults } from './durable.ts';
import { floorState, queuesFolder, seatDropFolders, withActivationLock, type FloorActor } from './floor.ts';
import { drainPendingReceipts, quarantinedPending } from './receipt-store.ts';

/** The level a root must be active at before the switch may be on. */
export const READER_LEVEL = 3;

export const READER_DOMAIN = 'team-queue-reader-v1\n';
const READER = 'READER';

type ReaderPayload = { v: 1; kind: 'queue-reader'; root: string; level: number; at: string };

export type ReaderSwitch = { kind: 'on' } | { kind: 'off' } | { kind: 'unknown'; why: string };

/** The switch as it stands, verified with this home's key and bound to `root`. */
export function readerSwitch(root: string, home: string): ReaderSwitch {
  const text = readFence(join(queuesFolder(root), READER));
  if (text === null) return { kind: 'unknown', why: 'the reader switch cannot be read' };
  if (text === '') return { kind: 'off' };
  let record: { payload?: ReaderPayload; signature?: unknown };
  try {
    record = JSON.parse(text) as typeof record;
  } catch {
    return { kind: 'unknown', why: 'the reader switch does not parse' };
  }
  const payload = record?.payload;
  if (!payload || payload.kind !== 'queue-reader' || payload.v !== 1 || typeof record.signature !== 'string') {
    return { kind: 'unknown', why: 'the reader switch has no shape this build reads' };
  }
  if (payload.root !== root) return { kind: 'unknown', why: 'the reader switch names another root' };
  const key = messageKeyState(home);
  if (key.kind !== 'key') return { kind: 'unknown', why: 'the message key cannot be read' };
  if (!verifyDomain(READER_DOMAIN, payload as unknown as Json, record.signature, key.key)) return { kind: 'unknown', why: 'the reader switch does not verify' };
  return { kind: 'on' };
}

export type SeatBinding = { root: string; session: string; seat: string };

export type SeatCheck =
  | { kind: 'complete'; generation: string; committed: number; pending: number; quarantined: number }
  | { kind: 'incomplete'; why: string };

/**
 * Whether a seat's queue can be trusted for its order. `unread` are the ids waiting in the seat's
 * folder (the legacy listing's set). Drains the seat's pending dual writes first.
 */
export function seatQueueCheck(dropDir: string, binding: SeatBinding, unread: readonly string[], home: string): SeatCheck {
  if (queueBaseOf(dropDir) === null) return { kind: 'incomplete', why: 'the folder has no queue' };
  const drained = drainPendingReceipts(dropDir, home);
  if (drained.unknown) return { kind: 'incomplete', why: 'the pending receipts cannot be listed' };
  if (drained.left > 0) return { kind: 'incomplete', why: `${String(drained.left)} pending receipt(s) are not drained` };
  const quarantined = quarantinedPending(dropDir);
  if (quarantined === null) return { kind: 'incomplete', why: 'the receipt quarantine cannot be listed' };
  if (quarantined.length > 0) return { kind: 'incomplete', why: `${String(quarantined.length)} quarantined receipt marker(s) are not accounted for` };
  const order = orderOf(dropDir, binding, unread, home);
  if (order.kind === 'legacy') return { kind: 'incomplete', why: order.why };
  return { kind: 'complete', generation: order.generation, committed: order.seq.size, pending: 0, quarantined: 0 };
}

export type ReaderOrder =
  | { kind: 'queue'; generation: string; seq: Map<string, number> }
  | { kind: 'legacy'; why: string };

/** The queue order for `ids` (a listing's set), or the reason the listing stays legacy. */
function orderOf(dropDir: string, binding: SeatBinding, ids: readonly string[], home: string): ReaderOrder {
  const snapshot = committedSnapshot(dropDir);
  if (snapshot === null) return { kind: 'legacy', why: 'the queue journal is not readable now' };
  const base = queueBaseOf(dropDir);
  if (base === null) return { kind: 'legacy', why: 'the folder has no queue' };
  const seq = new Map<string, number>();
  let highest = 0;
  for (const id of ids) {
    const at = snapshot.committed.get(id);
    if (at === undefined) return { kind: 'legacy', why: `message ${id} has no committed queue entry` };
    const entry = readEntry(join(base, snapshot.generation), at, { root: binding.root, session: binding.session, seat: binding.seat, generation: snapshot.generation }, home);
    if (entry === null || entry.payload.msg_id !== id) return { kind: 'legacy', why: `message ${id}'s queue entry does not verify` };
    seq.set(id, at);
    if (at > highest) highest = at;
  }
  const hole = snapshot.holes.find(at => at <= highest);
  if (hole !== undefined) return { kind: 'legacy', why: `seq ${String(hole)} is still reserved` };
  return { kind: 'queue', generation: snapshot.generation, seq };
}

/**
 * The order a listing of `ids` is offered in. `queue` only when the switch is on, the root is
 * active at the reader level, and the seat's queue holds every id; `legacy` with the reason
 * otherwise. Never throws.
 */
export function readerOrder(dropDir: string, binding: SeatBinding, ids: readonly string[], home: string): ReaderOrder {
  try {
    const flag = readerSwitch(binding.root, home);
    if (flag.kind === 'off') return { kind: 'legacy', why: 'the reader switch is off' };
    if (flag.kind === 'unknown') return { kind: 'legacy', why: flag.why };
    const floor = floorState(binding.root, home);
    if (floor.kind !== 'active') return { kind: 'legacy', why: `the root is ${floor.kind}` };
    if (floor.level < READER_LEVEL) return { kind: 'legacy', why: `the root is active at level ${String(floor.level)}, below the reader level ${String(READER_LEVEL)}` };
    return orderOf(dropDir, binding, ids, home);
  } catch (error) {
    return { kind: 'legacy', why: `the queue order cannot be read (${(error as Error).message})` };
  }
}

export type SwitchOutcome =
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'refused'; why: string; seats?: { dropDir: string; why: string }[] }
  | { kind: 'busy' }
  | { kind: 'failed'; why: string };

export type SwitchOptions = {
  home: string;
  /** The live actors, read fresh right before the record (R0). */
  actors: () => FloorActor[] | null;
  /** The unread ids of one seat folder (the legacy listing's set). */
  unreadOf: (dropDir: string) => { binding: SeatBinding; ids: string[] } | null;
  now?: () => Date;
  faults?: DurableFaults;
};

/** Turns the switch on (R0–R1) or off, under the activation lock. */
export function setReaderSwitch(root: string, on: boolean, options: SwitchOptions): SwitchOutcome {
  const result = withActivationLock(root, (): SwitchOutcome => {
    if (!on) {
      return removeDurable(join(queuesFolder(root), READER)) === 'removed' ? { kind: 'off' } : { kind: 'failed', why: 'the reader switch could not be removed' };
    }
    const floor = floorState(root, options.home);
    if (floor.kind !== 'active') return { kind: 'refused', why: `the root is ${floor.kind}, not active` };
    if (floor.level < READER_LEVEL) return { kind: 'refused', why: `the root is active at level ${String(floor.level)}, below the reader level ${String(READER_LEVEL)}` };
    const blocked: { dropDir: string; why: string }[] = [];
    for (const dropDir of seatDropFolders(root)) {
      const unread = options.unreadOf(dropDir);
      if (unread === null) {
        blocked.push({ dropDir, why: 'the seat folder cannot be listed' });
        continue;
      }
      const check = seatQueueCheck(dropDir, unread.binding, unread.ids, options.home);
      if (check.kind === 'incomplete') blocked.push({ dropDir, why: check.why });
    }
    if (blocked.length > 0) return { kind: 'refused', why: 'a seat queue is not complete', seats: blocked };
    // The actors are proved last, with nothing awaited before the record.
    const actors = options.actors();
    if (actors === null) return { kind: 'refused', why: 'the live actors cannot be read' };
    const below = actors.filter(actor => actor.level === null || actor.level < READER_LEVEL);
    if (below.length > 0) return { kind: 'refused', why: `an actor below the reader level is live (${below.map(actor => actor.name).join(', ')})` };
    const payload: ReaderPayload = { v: 1, kind: 'queue-reader', root, level: READER_LEVEL, at: (options.now?.() ?? new Date()).toISOString() };
    let signature: string;
    try {
      signature = signDomain(READER_DOMAIN, payload as unknown as Json, messageKeyOf(options.home));
    } catch (error) {
      return { kind: 'failed', why: `the reader switch cannot be signed (${(error as Error).message})` };
    }
    const made = createExclusive(join(queuesFolder(root), READER), `${JSON.stringify({ payload, signature })}\n`, options.faults);
    if (made === 'failed') return { kind: 'failed', why: 'the reader switch could not be made durable' };
    return { kind: 'on' };
  });
  return result;
}
