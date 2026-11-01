// The reservation adapter's decisions over a STAND-IN store (see reservation-stand-in-store.ts):
// the store lane's contract is imitated in memory, so every assertion here is about
// `src/workflow/reservation` — which hold it asks for, which literal it passes through, which
// refusal it reports, whether it rechecks inside the transaction — and none is evidence about
// the real store. Real-store races and recovery live in the separate race suite and run only at
// the committed store head.
//
// The clock is injected everywhere the contract injects one; the fixture instants are in the
// past relative to this machine's clock, so a code path that read `Date.now` instead would flip
// the expiry answers and fail these tests.

import { describe, expect, test } from 'bun:test';
import {
  acknowledge,
  claimNext,
  excludedItems,
  exclusionOf,
  expire,
  nextOwner,
  releaseNextClaim,
  releaseReservation,
  renewNextClaim,
  reserve,
  attemptOwner,
  type HoldRecord,
  type ItemIdentity,
} from '../../src/workflow/reservation/index.ts';
import { StandInStore, standInKeyText } from './reservation-stand-in-store.ts';

const ITEM: ItemIdentity = { source: 'file', project: 'acme', team: 'crew', id: 'm1' };
const OTHER: ItemIdentity = { ...ITEM, id: 'm2' };
const T = Date.parse('2026-10-20T09:00:00.000Z'); // the acknowledgement deadline
const AT = T - 60_000; // a reservation made a minute earlier

function reserved(store: StandInStore, patch: { attempt?: number; runId?: string } = {}) {
  return reserve(store, {
    item: ITEM,
    runId: patch.runId ?? 'run-1',
    attempt: patch.attempt ?? 1,
    thread: 'th-1',
    receiver: { seat: 'work', pane: 'fixture2:pane1' },
    expiresAt: T,
    at: AT,
  });
}

function ackInput(patch: Partial<Parameters<typeof acknowledge>[1]> = {}) {
  return {
    item: ITEM,
    runId: 'run-1',
    attempt: 1,
    thread: 'th-1',
    seat: 'work',
    pane: 'fixture2:pane1',
    messageId: 'msg-1',
    at: AT + 1000,
    ...patch,
  };
}

function holdOf(store: StandInStore, item: ItemIdentity = ITEM): HoldRecord | undefined {
  const key = standInKeyText(item);
  if (key === null) throw new Error('the fixture item is unkeyable');
  // The index itself, not the advisory read, so a stale-read scene can still inspect state.
  return store.index.get(key)?.hold;
}

describe('reserve: one hold for the item and its receiver', () => {
  test('writes one pending hold naming the attempt, the receiver and the deadline', () => {
    const store = new StandInStore();
    const result = reserved(store);
    expect(result.kind).toBe('reserved');
    if (result.kind !== 'reserved') return;
    expect(result.hold).toMatchObject({
      kind: 'reservation',
      owner: 'run-1/1',
      seat: 'work',
      phase: 'pending',
      expiresAt: new Date(T).toISOString(),
      at: new Date(AT).toISOString(),
      run: 'run-1',
      attempt: 1,
      thread: 'th-1',
      receiver: 'work',
      pane: 'fixture2:pane1',
    });
    expect(store.transactions).toBe(1);
    expect(holdOf(store)).toEqual(result.hold);
  });

  test("passes the store's own refusal literals through unchanged", () => {
    const store = new StandInStore();
    store.seed(ITEM, { live: 'run-9' });
    expect(reserved(store)).toMatchObject({ kind: 'refused', reason: 'run-live', run: 'run-9' });

    const terminal = new StandInStore();
    terminal.seed(ITEM, { terminal: { run: 'run-8', generation: 1, outcome: 'refused', at: new Date(AT).toISOString() } });
    expect(reserved(terminal)).toMatchObject({ kind: 'refused', reason: 'terminal' });

    const held = new StandInStore();
    held.seed(ITEM, {
      hold: { kind: 'next-claim', item: 'k', owner: nextOwner('lead', 'fixture1:pane1'), seat: 'lead', phase: 'pending', at: new Date(AT).toISOString(), expiresAt: new Date(T).toISOString() },
    });
    expect(reserved(held)).toMatchObject({ kind: 'refused', reason: 'hold-live' });

    const busy = new StandInStore();
    busy.seed(OTHER, {
      hold: { kind: 'reservation', item: 'k', owner: 'run-7/1', seat: 'work', phase: 'pending', at: new Date(AT).toISOString(), expiresAt: new Date(T).toISOString(), receiver: 'work' },
    });
    expect(reserved(busy)).toMatchObject({ kind: 'refused', reason: 'receiver-busy' });
  });

  test('an unkeyable item is item-key for a reservation and unrecorded for a claim', () => {
    const store = new StandInStore();
    const unkeyable = { ...ITEM, id: '' };
    expect(reserve(store, { item: unkeyable, runId: 'run-1', attempt: 1, thread: 'th-1', receiver: { seat: 'work' }, expiresAt: T, at: AT })).toEqual({
      kind: 'refused',
      reason: 'item-key',
    });
    expect(claimNext(store, { item: unkeyable, seat: 'lead', pane: 'fixture1:pane1', now: AT, expiresAt: T })).toEqual({
      kind: 'unrecorded',
      reason: 'item-key',
    });
  });
});

describe('acknowledge: bind checks first, one transaction, one outcome', () => {
  test('each mismatch is ignored and the pending hold is byte-identical after it', () => {
    const store = new StandInStore();
    reserved(store);
    const before = structuredClone(holdOf(store));
    const cases: Array<[Partial<Parameters<typeof acknowledge>[1]>, string]> = [
      [{ runId: 'run-2' }, 'wrong-run'],
      [{ attempt: 2 }, 'stale-attempt'],
      [{ thread: 'th-2' }, 'wrong-thread'],
      [{ seat: 'other' }, 'wrong-receiver'],
      [{ pane: 'fixture2:pane2' }, 'wrong-receiver'],
    ];
    for (const [patch, why] of cases) {
      const answer = acknowledge(store, ackInput(patch));
      expect(answer).toMatchObject({ kind: 'ignored', why });
      expect(holdOf(store)).toEqual(before);
    }
    expect(store.entry(standInKeyText(ITEM) as string)?.hold?.phase).toBe('pending');
  });

  test('the valid reply converts to a holder with its pane and message, and no deadline', () => {
    const store = new StandInStore();
    reserved(store);
    const answer = acknowledge(store, ackInput());
    expect(answer.kind).toBe('acknowledged');
    const hold = holdOf(store);
    expect(hold).toMatchObject({ phase: 'holder', holder: { seat: 'work', pane: 'fixture2:pane1' }, messageId: 'msg-1' });
    expect(hold?.expiresAt).toBeUndefined();
    // A second reply to the same attempt is refused, and the holder stays.
    expect(acknowledge(store, ackInput())).toMatchObject({ kind: 'ignored', why: 'already-holder' });
    expect(holdOf(store)).toEqual(hold);
  });

  test('no reservation, or one for another item, is no-reservation', () => {
    const store = new StandInStore();
    expect(acknowledge(store, ackInput())).toEqual({ kind: 'ignored', why: 'no-reservation' });
    expect(store.calls.some((call) => call.op === 'convertHold')).toBe(false);
  });
});

describe('the deadline: exactly one of convert and sweep wins', () => {
  test('a reply at the deadline is expired and moves nothing; the sweep then clears it', () => {
    const store = new StandInStore();
    reserved(store);
    const before = structuredClone(holdOf(store));
    expect(acknowledge(store, ackInput({ at: T }))).toMatchObject({ kind: 'ignored', why: 'expired' });
    expect(holdOf(store)).toEqual(before);
    const cleared = expire(store, T);
    expect(cleared).toEqual([
      { kind: 'reservation', item: ITEM, owner: 'run-1/1', run: 'run-1', attempt: 1, thread: 'th-1', seat: 'work', receiver: 'work', pane: 'fixture2:pane1' },
    ]);
    expect(holdOf(store)).toBeUndefined();
    expect(acknowledge(store, ackInput({ at: T - 1 }))).toEqual({ kind: 'ignored', why: 'no-reservation' });
  });

  test('a reply one millisecond before the deadline converts, and the sweep leaves the holder', () => {
    const store = new StandInStore();
    reserved(store);
    expect(acknowledge(store, ackInput({ at: T - 1 })).kind).toBe('acknowledged');
    const holder = structuredClone(holdOf(store));
    expect(expire(store, T + 86_400_000)).toEqual([]);
    expect(holdOf(store)).toEqual(holder);
  });
});

describe('a converted holder is excluded for good', () => {
  test('exclusion survives the deadline that used to apply, and no hold can take the seat or item', () => {
    const store = new StandInStore();
    reserved(store);
    expect(acknowledge(store, ackInput()).kind).toBe('acknowledged');
    const later = T + 86_400_000;
    const key = standInKeyText(ITEM) as string;
    expect(exclusionOf(store.entry(key), later)).toBe('held');
    expect(excludedItems(store, [ITEM], later)).toEqual(new Set([key]));
    expect(reserved(store)).toMatchObject({ kind: 'refused', reason: 'hold-live' });
    expect(claimNext(store, { item: ITEM, seat: 'lead', pane: 'fixture1:pane1', now: later, expiresAt: later + 1000 })).toMatchObject({
      kind: 'refused',
      reason: 'hold-live',
    });
    // The holder's own seat cannot take another item either, while a different seat can.
    expect(reserve(store, { item: OTHER, runId: 'run-3', attempt: 1, thread: 'th-3', receiver: { seat: 'work' }, expiresAt: later, at: later })).toMatchObject({
      kind: 'refused',
      reason: 'receiver-busy',
    });
    expect(claimNext(store, { item: OTHER, seat: 'lead', pane: 'fixture1:pane1', now: later, expiresAt: later + 1000 }).kind).toBe('claimed');
  });
});

describe('expire: deterministic order, holders and live holds untouched', () => {
  test('reports each due pending hold once, ordered by item parts then owner', () => {
    const store = new StandInStore();
    const a1 = { ...ITEM, id: 'a1' };
    const b1 = { ...ITEM, id: 'b1' };
    const c1 = { ...ITEM, id: 'c1' };
    const d1 = { ...ITEM, id: 'd1' };
    store.seed(b1, { hold: { kind: 'next-claim', item: 'k', owner: nextOwner('lead', 'fixture1:pane1'), seat: 'lead', phase: 'pending', at: new Date(AT).toISOString(), expiresAt: new Date(T).toISOString() } });
    store.seed(a1, { hold: { kind: 'next-claim', item: 'k', owner: nextOwner('work', 'fixture2:pane2'), seat: 'work', phase: 'pending', at: new Date(AT).toISOString(), expiresAt: new Date(T).toISOString() } });
    // A holder past every deadline and a live pending hold both stay.
    store.seed(c1, { hold: { kind: 'reservation', item: 'k', owner: 'run-5/1', seat: 'work', phase: 'holder', at: new Date(AT).toISOString(), holder: { seat: 'work', pane: 'fixture2:pane1' } } });
    store.seed(d1, { hold: { kind: 'reservation', item: 'k', owner: 'run-6/1', seat: 'lead', phase: 'pending', at: new Date(AT).toISOString(), expiresAt: new Date(T + 60_000).toISOString() } });
    const cleared = expire(store, T);
    expect(cleared.map((entry) => entry.kind === 'reservation' ? 'reservation' : 'next-claim')).toEqual(['next-claim', 'next-claim']);
    expect(cleared.map((entry) => entry.item.id)).toEqual(['a1', 'b1']);
    expect(holdOf(store, c1)).toBeDefined();
    expect(holdOf(store, d1)).toBeDefined();
    expect(holdOf(store, a1)).toBeUndefined();
    expect(holdOf(store, b1)).toBeUndefined();
  });
});

describe('next claims renew and release by their own owner token', () => {
  test('renew moves only the deadline; a foreign owner cannot renew or release', () => {
    const store = new StandInStore();
    const claimed = claimNext(store, { item: ITEM, seat: 'lead', pane: 'fixture1:pane1', now: AT, expiresAt: T });
    expect(claimed.kind).toBe('claimed');
    expect(renewNextClaim(store, { item: ITEM, seat: 'lead', pane: 'fixture1:pane1', now: AT + 1000, expiresAt: T + 60_000 })).toBe(true);
    expect(holdOf(store)?.expiresAt).toBe(new Date(T + 60_000).toISOString());
    expect(renewNextClaim(store, { item: ITEM, seat: 'work', pane: 'fixture2:pane1', now: AT + 1000, expiresAt: T + 120_000 })).toBe(false);
    expect(releaseNextClaim(store, { item: ITEM, seat: 'work', pane: 'fixture2:pane1', at: AT + 1000 })).toBe(false);
    expect(holdOf(store)).toBeDefined();
    expect(releaseNextClaim(store, { item: ITEM, seat: 'lead', pane: 'fixture1:pane1', at: AT + 1000 })).toBe(true);
    expect(holdOf(store)).toBeUndefined();
    expect(releaseNextClaim(store, { item: ITEM, seat: 'lead', pane: 'fixture1:pane1', at: AT + 1000 })).toBe(false);
  });

  test('a late release of an earlier attempt cannot touch its successor', () => {
    const store = new StandInStore();
    expect(reserved(store, { attempt: 1 }).kind).toBe('reserved');
    expect(releaseReservation(store, { item: ITEM, runId: 'run-1', attempt: 1, at: AT + 1000 })).toBe(true);
    expect(releaseReservation(store, { item: ITEM, runId: 'run-1', attempt: 1, at: AT + 2000 })).toBe(false);
    expect(reserved(store, { attempt: 2 }).kind).toBe('reserved');
    const second = structuredClone(holdOf(store));
    expect(second?.owner).toBe('run-1/2');
    expect(releaseReservation(store, { item: ITEM, runId: 'run-1', attempt: 1, at: AT + 3000 })).toBe(false);
    expect(holdOf(store)).toEqual(second);
    expect(attemptOwner('run-1', 2)).toBe('run-1/2');
  });
});

describe('lock-free reads are advisory only', () => {
  test('a stale read hides a held candidate from the filter but never opens it to a claim', () => {
    const store = new StandInStore();
    reserved(store);
    store.staleReads = true;
    const transactions = store.transactions;
    expect(excludedItems(store, [ITEM], AT)).toEqual(new Set());
    expect(store.transactions).toBe(transactions);
    expect(claimNext(store, { item: ITEM, seat: 'lead', pane: 'fixture1:pane1', now: AT, expiresAt: T })).toMatchObject({ kind: 'refused', reason: 'hold-live' });
    expect(reserved(store)).toMatchObject({ kind: 'refused', reason: 'hold-live' });
    expect(holdOf(store)?.owner).toBe('run-1/1');
  });

  test('exclusionOf names the live states and treats a lapsed pending hold as free', () => {
    const store = new StandInStore();
    const key = (item: ItemIdentity) => standInKeyText(item) as string;
    store.seed(ITEM, { live: 'run-9' });
    expect(exclusionOf(store.entry(key(ITEM)), AT)).toBe('live-run');
    const terminal = new StandInStore();
    terminal.seed(ITEM, { terminal: { run: 'run-8', generation: 1, outcome: 'refused', at: new Date(AT).toISOString() } });
    expect(exclusionOf(terminal.entry(key(ITEM)), AT)).toBe('terminal');
    terminal.seed(ITEM, { reopened: { by: 'lead', at: new Date(AT + 1).toISOString() } });
    expect(exclusionOf(terminal.entry(key(ITEM)), AT + 2)).toBeNull();
    const pending = new StandInStore();
    pending.seed(ITEM, { hold: { kind: 'next-claim', item: 'k', owner: nextOwner('lead', 'fixture1:pane1'), seat: 'lead', phase: 'pending', at: new Date(AT).toISOString(), expiresAt: new Date(T).toISOString() } });
    expect(exclusionOf(pending.entry(key(ITEM)), T - 1)).toBe('held');
    expect(exclusionOf(pending.entry(key(ITEM)), T)).toBeNull();
  });
});
