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
// A listing carries each message's seq only when, at read time: READER verifies, the floor is
// ACTIVE at >= READER_LEVEL, and ONE proof taken under the seat's queue lock (the current
// generation pointer read under that lock, the journal durable and whole, every listed message's
// committed entry verified for this root, session, seat and generation, no reserved hole at or
// below the highest listed seq) holds. Anything unknown, missing, held or contradictory answers
// `legacy` with the reason. The listing's set and order are the legacy ones for every consumer
// (the drops batch, wake ages, the wake picker keep their own time criteria); only the
// model-facing inbox listing is offered in seq order (`inQueueOrder`). So a fallback can delay
// order, never hide a message (fail closed toward visibility).
//
// `seatQueueCheck` is read-only by default (`team queues status`); only the authorized switch
// path drains pending dual writes. The switch needs an ACTIVE root, and activation stays dark
// until E7b (activation and the managed launch boundary) passes its own review.

import { join } from 'node:path';
import { messageKeyOf, messageKeyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { lockedQueueOrder, observedQueueOrder, queueBaseOf } from './append.ts';
import { createExclusive, readFence, removeDurable, type DurableFaults } from './durable.ts';
import { floorState, queuesFolder, seatDropFoldersStrict, withActivationLock, type FloorActor } from './floor.ts';
import { drainPendingReceiptsChecked, pendingMarkers, quarantinedPending } from './receipt-store.ts';

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
 * folder (the bound legacy listing's set). `drain`: the authorized switch path drains the seat's
 * pending dual writes first; the read-only check (`team queues status`) only counts them and
 * writes nothing at all.
 */
export function seatQueueCheck(dropDir: string, binding: SeatBinding, unread: readonly string[], home: string, mode: { drain: boolean } = { drain: false }): SeatCheck {
  if (queueBaseOf(dropDir) === null) return { kind: 'incomplete', why: 'the folder has no queue' };
  let pending: number | null;
  if (mode.drain) {
    const drained = drainPendingReceiptsChecked(dropDir, home);
    pending = drained.unknown ? null : drained.left;
  } else {
    pending = pendingMarkers(dropDir);
  }
  if (pending === null) return { kind: 'incomplete', why: 'the pending receipts cannot be listed' };
  if (pending > 0) return { kind: 'incomplete', why: `${String(pending)} pending receipt(s) are not drained` };
  const quarantined = quarantinedPending(dropDir);
  if (quarantined === null) return { kind: 'incomplete', why: 'the receipt quarantine cannot be listed' };
  if (quarantined.length > 0) return { kind: 'incomplete', why: `${String(quarantined.length)} quarantined receipt marker(s) are not accounted for` };
  // The read-only check observes (no lock, no repair); the authorized path proves under the lock.
  const order = mode.drain ? lockedQueueOrder(dropDir, binding, unread, home) : observedQueueOrder(dropDir, binding, unread, home);
  if ('why' in order) return { kind: 'incomplete', why: order.why };
  return { kind: 'complete', generation: order.generation, committed: order.seq.size, pending: 0, quarantined: 0 };
}

export type ReaderOrder =
  | { kind: 'queue'; generation: string; seq: Map<string, number> }
  | { kind: 'legacy'; why: string };

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
    const order = lockedQueueOrder(dropDir, binding, ids, home);
    return 'why' in order ? { kind: 'legacy', why: order.why } : { kind: 'queue', generation: order.generation, seq: order.seq };
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
  /** The unread ids of one seat folder (the bound legacy listing's set); null when the folder
   *  cannot be listed (never read as empty). */
  unreadOf: (dropDir: string) => { binding: SeatBinding; ids: string[] } | null;
  /** The root's seat folders; null when any level cannot be listed. Defaults to the strict scan. */
  seatFolders?: () => string[] | null;
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
    const folders = (options.seatFolders ?? (() => seatDropFoldersStrict(root)))();
    if (folders === null) return { kind: 'refused', why: 'the seat folders cannot all be listed' };
    for (const dropDir of folders) {
      const unread = options.unreadOf(dropDir);
      if (unread === null) {
        blocked.push({ dropDir, why: 'the seat folder cannot be listed' });
        continue;
      }
      const check = seatQueueCheck(dropDir, unread.binding, unread.ids, options.home, { drain: true });
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
