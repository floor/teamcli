// The reservation decisions over the store lane's settled surface (§2.2, §2.3): reserve,
// acknowledge-and-convert, claim for `team next`, renew, release, expire, and the advisory
// exclusion the claim lists read. Every mutation re-reads inside `store.transact`; the item and
// receiver write in one section, so the boundary cannot be half-taken, and the lock-free filters
// are never the authority for a write.
import type {
  AckIgnored,
  AckInput,
  AckResult,
  ClaimNextInput,
  ClaimNextResult,
  Expired,
  HoldRecord,
  IndexEntry,
  ItemIdentity,
  ReservationStore,
  ReserveInput,
  ReserveResult,
  TryHoldResult,
} from './types.ts';

/** The owner token of one dispatch attempt (§2.2): the run and the attempt it binds. The store
 *  takes it opaquely; `convertHold` and `releaseHold` must present the same string. */
export function attemptOwner(runId: string, attempt: number): string {
  return `${runId}/${attempt}`;
}

/** The owner token of a `team next` claim: stable across every lease renewal, opaque to the store. */
export function nextOwner(seat: string, pane: string): string {
  return `next:${seat}:${pane}`;
}

/** The item's exclusion state from its index entry: a live run, a terminal run no reopen
 *  released, or a hold. A pending hold blocks until its deadline; a holder blocks until release.
 *  Liveness follows the store's own rule: a holder is always live, a pending hold with no readable
 *  deadline is not (the store treats an unparseable instant as past). */
export function exclusionOf(entry: IndexEntry | null, now: number): 'live-run' | 'terminal' | 'held' | null {
  if (entry === null) return null;
  if (entry.live !== undefined) return 'live-run';
  if (entry.terminal !== undefined && entry.reopened === undefined) return 'terminal';
  const hold = entry.hold;
  if (hold === undefined) return null;
  if (hold.phase === 'holder') return 'held';
  if (hold.expiresAt === undefined) return 'held';
  const until = Date.parse(hold.expiresAt);
  return Number.isFinite(until) && until > now ? 'held' : null;
}

/** The keys a `team next` pass must not offer. Advisory: `claimNext` re-judges inside the
 *  transaction, so a stale filter can waste a candidate but never take an excluded one. */
export function excludedItems(store: ReservationStore, items: readonly ItemIdentity[], now: number): Set<string> {
  const blocked = new Set<string>();
  for (const item of items) {
    const key = store.keyText(item);
    if (key === null) continue;
    if (exclusionOf(store.entry(key), now) !== null) blocked.add(key);
  }
  return blocked;
}

/** Reserves the item and the receiver together, before any send. A refusal carries the store's
 *  raw reason: `run-live`, `terminal`, `hold-live` or `receiver-busy` (or `item-key`). */
export function reserve(store: ReservationStore, input: ReserveInput): ReserveResult {
  return store.transact((tx) => {
    const result = tx.tryHold({
      item: input.item,
      kind: 'reservation',
      owner: attemptOwner(input.runId, input.attempt),
      seat: input.receiver.seat,
      expiresAt: iso(input.expiresAt),
      at: iso(input.at),
      run: input.runId,
      attempt: input.attempt,
      thread: input.thread,
      receiver: input.receiver.seat,
      ...(input.receiver.pane === undefined ? {} : { pane: input.receiver.pane }),
    });
    return fromTryHold(result);
  });
}

/** A `team next` claim in the same boundary. A refusal means the item or the seat is already
 *  bound; `unrecorded` means the store cannot key the item, so no run can exist for it either. */
export function claimNext(store: ReservationStore, input: ClaimNextInput): ClaimNextResult {
  return store.transact((tx) => {
    const result = tx.tryHold({
      item: input.item,
      kind: 'next-claim',
      owner: nextOwner(input.seat, input.pane),
      seat: input.seat,
      pane: input.pane,
      expiresAt: iso(input.expiresAt),
      at: iso(input.now),
    });
    if (!result.ok && result.reason === 'item-key') return { kind: 'unrecorded', reason: result.reason };
    const converted = fromTryHold(result);
    return converted.kind === 'reserved' ? { kind: 'claimed', hold: converted.hold } : converted;
  });
}

/** The acknowledgement, and with it the only write of a holder. Bind checks run first, then the
 *  deadline; all of it in one transaction with the conversion, so a reply racing the expiry sweep
 *  has exactly one outcome. A converted holder does not expire and cannot be renewed (§2.2). */
export function acknowledge(store: ReservationStore, input: AckInput): AckResult {
  const key = store.keyText(input.item);
  if (key === null) return { kind: 'ignored', why: 'no-reservation' };
  return store.transact((tx) => {
    const hold = tx.entry(key)?.hold;
    if (hold === undefined || hold.kind !== 'reservation') return { kind: 'ignored', why: 'no-reservation' };
    if (hold.phase === 'holder') return { kind: 'ignored', why: 'already-holder', hold };
    if (hold.run !== input.runId) return { kind: 'ignored', why: 'wrong-run', hold };
    if (hold.attempt !== input.attempt) return { kind: 'ignored', why: 'stale-attempt', hold };
    if (hold.thread !== input.thread) return { kind: 'ignored', why: 'wrong-thread', hold };
    if (hold.receiver !== input.seat) return { kind: 'ignored', why: 'wrong-receiver', hold };
    if (hold.pane !== undefined && hold.pane !== input.pane) return { kind: 'ignored', why: 'wrong-receiver', hold };
    if (hold.expiresAt === undefined) return { kind: 'ignored', why: 'expired', hold };
    const until = Date.parse(hold.expiresAt);
    if (!Number.isFinite(until) || until <= input.at) return { kind: 'ignored', why: 'expired', hold };
    const converted = tx.convertHold({
      item: input.item,
      owner: hold.owner,
      holder: { seat: input.seat, pane: input.pane },
      expect: { attempt: input.attempt, receiver: input.seat, thread: input.thread },
      messageId: input.messageId,
      at: iso(input.at),
    });
    if (!converted.ok) return { kind: 'ignored', why: convertRefusal(converted.reason), hold };
    return { kind: 'acknowledged', hold: converted.hold };
  });
}

/** Renews a live `team next` claim with its renewed local lease, in place: no phase change, no
 *  new attempt, and the store's own absolute deadline is the only clock. */
export function renewNextClaim(
  store: ReservationStore,
  input: { item: ItemIdentity; seat: string; pane: string; now: number; expiresAt: number },
): boolean {
  return store.transact((tx) =>
    tx.renewHold({
      item: input.item,
      owner: nextOwner(input.seat, input.pane),
      expiresAt: iso(input.expiresAt),
      at: iso(input.now),
    }).ok,
  );
}

export function releaseNextClaim(
  store: ReservationStore,
  input: { item: ItemIdentity; seat: string; pane: string; at: number },
): boolean {
  return store.transact((tx) =>
    tx.releaseHold({ item: input.item, owner: nextOwner(input.seat, input.pane), at: iso(input.at) }).ok,
  );
}

/** The daemon's timer, stop or re-dispatch releases the attempt's reservation. The owner token
 *  names exactly one attempt, so a late release cannot touch its successor. */
export function releaseReservation(
  store: ReservationStore,
  input: { item: ItemIdentity; runId: string; attempt: number; at: number },
): boolean {
  return store.transact((tx) =>
    tx.releaseHold({ item: input.item, owner: attemptOwner(input.runId, input.attempt), at: iso(input.at) }).ok,
  );
}

/** Restart reconciliation and the timer pass, in one transaction: every pending hold whose
 *  absolute deadline passed is released and reported, in a deterministic order (item parts, then
 *  owner). Holders are skipped — they end only by explicit release. An unexpired reservation is
 *  left armed with its persisted deadline; nothing is replayed from elapsed time. */
export function expire(store: ReservationStore, now: number): Expired[] {
  return store.transact((tx) => {
    const due = tx
      .items()
      .filter((entry): entry is IndexEntry & { hold: HoldRecord } => entry.hold !== undefined && past(entry.hold, now))
      .sort((left, right) => orderKey(left, left.hold).localeCompare(orderKey(right, right.hold)));
    const cleared: Expired[] = [];
    for (const entry of due) {
      if (!tx.releaseHold({ item: entry.item, owner: entry.hold.owner, at: iso(now) }).ok) continue;
      cleared.push(describeExpired(entry.item, entry.hold));
    }
    return cleared;
  });
}

function fromTryHold(result: TryHoldResult): ReserveResult {
  if (result.ok) return { kind: 'reserved', hold: result.hold };
  return {
    kind: 'refused',
    reason: result.reason,
    ...(result.hold === undefined ? {} : { hold: result.hold }),
    ...(result.run === undefined ? {} : { run: result.run }),
  };
}

function convertRefusal(
  reason: 'no-hold' | 'owner-mismatch' | 'not-reservation' | 'already-holder' | 'stale-attempt' | 'wrong-receiver' | 'wrong-thread',
): AckIgnored {
  switch (reason) {
    case 'owner-mismatch':
      return 'owner-mismatch';
    case 'already-holder':
      return 'already-holder';
    case 'stale-attempt':
      return 'stale-attempt';
    case 'wrong-receiver':
      return 'wrong-receiver';
    case 'wrong-thread':
      return 'wrong-thread';
    case 'no-hold':
    case 'not-reservation':
      return 'no-reservation';
  }
}

/** A holder never expires. A pending hold's liveness is the store's own rule read backwards: no
 *  deadline counts as live, an unreadable deadline as past. */
function past(hold: HoldRecord, now: number): boolean {
  if (hold.phase === 'holder') return false;
  if (hold.expiresAt === undefined) return false;
  const until = Date.parse(hold.expiresAt);
  return !Number.isFinite(until) || until <= now;
}

function orderKey(entry: IndexEntry, hold: HoldRecord): string {
  return [entry.item.source, entry.item.project, entry.item.team, entry.item.id, hold.owner].join('\u0000');
}

function describeExpired(item: ItemIdentity, hold: HoldRecord): Expired {
  if (hold.kind === 'reservation') {
    return {
      kind: 'reservation',
      item,
      owner: hold.owner,
      ...(hold.run === undefined ? {} : { run: hold.run }),
      ...(hold.attempt === undefined ? {} : { attempt: hold.attempt }),
      ...(hold.thread === undefined ? {} : { thread: hold.thread }),
      seat: hold.seat,
      ...(hold.receiver === undefined ? {} : { receiver: hold.receiver }),
      ...(hold.pane === undefined ? {} : { pane: hold.pane }),
    };
  }
  return {
    kind: 'next-claim',
    item,
    owner: hold.owner,
    seat: hold.seat,
    ...(hold.pane === undefined ? {} : { pane: hold.pane }),
  };
}

function iso(at: number): string {
  return new Date(at).toISOString();
}
