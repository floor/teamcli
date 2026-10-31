// The `team next` claim under the shared boundary (§2.2): the store holds the item and the
// receiver first, then the command writes its local lease. Writing the hold first is what makes
// "an item claimed by `team next` is not dispatched" true — a refused hold claims no lease, so a
// losing claim leaves nothing behind. The lease still renews and releases as before; the store
// claim follows it, with the lease's own deadline as the store's absolute deadline.
//
// The adapter-claim path (a tracker-side claim) has no local lease to follow, so its hold is
// written around the adapter's claim instead, in the command; this file is only the lease path.
import { wakeableWhileIdle, type DeliveryClass } from '../../launch/delivery-class.ts';
import { claimLocal, LEASE_MS, liveLeaseOf } from '../../tasks/lease.ts';
import type { TaskRecord } from '../../tasks/adapter.ts';
import { claimNext, excludedItems, releaseNextClaim, renewNextClaim } from './ops.ts';
import type { ItemIdentity, ReservationStore } from './types.ts';

/** The parts every candidate of one pass shares: the source, project and team of the item key. */
export type NextHoldBase = Pick<ItemIdentity, 'source' | 'project' | 'team'>;

export type NextHold = {
  store: ReservationStore;
  base: NextHoldBase;
  seat: string;
  pane: string;
  now: number;
  /** The seat's measured delivery class. A class nothing can wake while the seat is idle is
   *  offered no time-bound record, so the store's hold is never written for one. */
  delivery: DeliveryClass;
};

export type NextClaimOutcome = { kind: 'held'; record: TaskRecord } | { kind: 'none' } | { kind: 'kept' };

/**
 * One `team next` take, under the store's exclusion. A live lease is renewed exactly as before,
 * and its claim with it: the store's deadline and the lease's `until` are the same instant. A new
 * claim tries each candidate in order, hold first, lease second; a candidate whose hold is
 * refused is skipped, and a lease that cannot be written releases the hold it just took.
 *
 * Time-bound work is never assigned to a seat whose class cannot be woken while the seat is
 * idle: the deadline falls between its turns and nothing would reach it. Such a seat is still
 * offered the ordinary work in the same queue.
 */
export function takeUnderHolds(
  root: string,
  known: ReadonlyMap<string, TaskRecord>,
  candidates: readonly TaskRecord[],
  input: NextHold,
): NextClaimOutcome {
  const { store, base, seat, pane, now, delivery } = input;
  const expiresAt = now + LEASE_MS;
  const itemOf = (id: string): ItemIdentity => ({ ...base, id });
  const offered = wakeableWhileIdle(delivery)
    ? candidates
    : candidates.filter((record) => record.deadline === undefined);

  const live = liveLeaseOf(root, seat, now);
  if (live !== null) {
    const renewed = claimLocal(root, { now, seat, pane, known, candidates });
    const id = renewed.kind === 'held' ? renewed.record.id : live.id;
    renewNextClaim(store, { item: itemOf(id), seat, pane, now, expiresAt });
    return renewed;
  }

  for (const record of offered) {
    const item = itemOf(record.id);
    const claimed = claimNext(store, { item, seat, pane, now, expiresAt });
    if (claimed.kind === 'refused') continue;
    const taken = claimLocal(root, { now, seat, pane, known, candidates: [record] });
    if (taken.kind === 'held') return taken;
    if (claimed.kind === 'claimed') releaseNextClaim(store, { item, seat, pane, at: now });
    if (taken.kind === 'kept') return taken;
  }
  return { kind: 'none' };
}

/** The advisory half of the shared boundary: a candidate whose item has a live run, a terminal
 *  hold or a live store hold is not offered. `claimNext` re-judges every candidate inside the
 *  store transaction, so a stale read here can only hide a free candidate for one pass. */
export function openCandidates(
  store: ReservationStore,
  base: NextHoldBase,
  records: readonly TaskRecord[],
  now: number,
): TaskRecord[] {
  const blocked = excludedItems(store, records.map((record) => ({ ...base, id: record.id })), now);
  if (blocked.size === 0) return [...records];
  return records.filter((record) => {
    const key = store.keyText({ ...base, id: record.id });
    return key === null || !blocked.has(key);
  });
}

/** `--release` clears the seat's claim in the store after the lease is unlinked. The hold names
 *  one item and one (seat, pane), so a stale id releases nothing else. */
export function releaseHoldFor(
  store: ReservationStore | undefined,
  base: NextHoldBase,
  id: string,
  seat: string,
  pane: string,
  at: number,
): void {
  if (store === undefined) return;
  releaseNextClaim(store, { item: { ...base, id }, seat, pane, at });
}
