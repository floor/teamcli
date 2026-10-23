// The seat exclusion across BOTH hold kinds, on the REAL store (adapter 919b65941, store
// 478a89f17). A seat that already holds one item must not take a second item through the other
// entry path; the store's own seat-exclusion refusal is `receiver-busy`.
//
// This file is the independent case for the shared-boundary finding: at the pin it is RED twice
// (a pending reservation, and a converted holder, both followed by a next-claim on another item
// of the same seat), while the reverse direction — a next-claim followed by a reservation — is
// already refused. It turns green when the committed fix pair makes the scan cover both kinds.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRunStore, type ItemRecord, type RunStore } from '../../src/workflow/live/index.ts';
import {
  acknowledge,
  claimNext,
  expire,
  releaseNextClaim,
  releaseReservation,
  renewNextClaim,
  reserve,
  type ItemIdentity,
  type ReservationStore,
} from '../../src/workflow/reservation/index.ts';
import { createRunFor } from './reservation-live-fixture.ts';

const T = Date.parse('2026-10-20T09:00:00.000Z');
const AT = T - 60_000;
const X: ItemIdentity = { source: 'file', project: 'acme', team: 'crew', id: 'x1' };
const Y: ItemIdentity = { source: 'file', project: 'acme', team: 'crew', id: 'y1' };

let base: string;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

type Scene = { store: RunStore; clock: { at: number } };

function scene(at = AT): Scene {
  if (base) rmSync(base, { recursive: true, force: true });
  base = mkdtempSync(join(tmpdir(), 'reservation-seat-'));
  const root = join(base, 'runs');
  const clock = { at };
  const store = openRunStore({ root, now: () => clock.at });
  return { store, clock };
}

function entryOf(store: RunStore, item: ItemIdentity): ItemRecord | null {
  const key = store.keyText(item);
  if (key === null) throw new Error('the fixture item is unkeyable');
  return store.entry(key);
}

function reserveFor(store: ReservationStore, item: ItemIdentity, runId: string) {
  return reserve(store, {
    item,
    runId,
    attempt: 1,
    thread: `th-${runId}`,
    receiver: { seat: 'work', pane: 'w2:p1' },
    expiresAt: T,
    at: AT,
  });
}

function claimFor(store: ReservationStore, item: ItemIdentity) {
  return claimNext(store, { item, seat: 'work', pane: 'w2:p1', now: AT, expiresAt: T });
}

describe('a seat holding one item', () => {
  test('a pending reservation refuses a next-claim on another item of the same seat', () => {
    const { store } = scene();
    const reservationStore: ReservationStore = store;
    expect(reserveFor(reservationStore, X, 'run-1').kind).toBe('reserved');

    expect(claimFor(reservationStore, Y)).toMatchObject({ kind: 'refused', reason: 'receiver-busy' });
    expect(entryOf(store, Y)?.hold).toBeUndefined();
    expect(entryOf(store, X)?.hold).toMatchObject({ kind: 'reservation', owner: 'run-1/1', seat: 'work' });
  });

  test('a converted holder refuses a next-claim on another item of the same seat', () => {
    const { store } = scene();
    const reservationStore: ReservationStore = store;
    const run = createRunFor(store, X);
    expect(reserveFor(reservationStore, X, run).kind).toBe('reserved');
    expect(acknowledge(reservationStore, {
      item: X, runId: run, attempt: 1, thread: `th-${run}`,
      seat: 'work', pane: 'w2:p1', messageId: 'msg-1', at: T - 1000,
    }).kind).toBe('acknowledged');

    expect(claimFor(reservationStore, Y)).toMatchObject({ kind: 'refused', reason: 'receiver-busy' });
    expect(entryOf(store, Y)?.hold).toBeUndefined();
    expect(entryOf(store, X)?.hold).toMatchObject({ phase: 'holder', holder: { seat: 'work', pane: 'w2:p1' } });
  });

  test('the reverse direction already refuses: a next-claim makes the seat busy for a reservation', () => {
    const { store } = scene();
    const reservationStore: ReservationStore = store;
    expect(claimFor(reservationStore, X).kind).toBe('claimed');

    expect(reserveFor(reservationStore, Y, 'run-2')).toMatchObject({ kind: 'refused', reason: 'receiver-busy' });
    expect(entryOf(store, Y)?.hold).toBeUndefined();
    expect(entryOf(store, X)?.hold).toMatchObject({ kind: 'next-claim', owner: 'next:work:w2:p1', seat: 'work' });
  });
});

describe('the boundaries of the seat scan', () => {
  test('one seat holds one item: a live next-claim also refuses another item of the same seat', () => {
    const { store } = scene();
    const reservationStore: ReservationStore = store;
    expect(claimFor(reservationStore, X).kind).toBe('claimed');

    expect(claimFor(reservationStore, Y)).toMatchObject({ kind: 'refused', reason: 'receiver-busy' });
    expect(entryOf(store, Y)?.hold).toBeUndefined();
    expect(entryOf(store, X)?.hold).toMatchObject({ kind: 'next-claim', owner: 'next:work:w2:p1' });
  });

  test('releasing the source hold lifts the exclusion at once, for both kinds', () => {
    const reservations = scene();
    expect(reserveFor(reservations.store, X, 'run-1').kind).toBe('reserved');
    expect(releaseReservation(reservations.store, { item: X, runId: 'run-1', attempt: 1, at: AT })).toBe(true);
    expect(claimFor(reservations.store, Y).kind).toBe('claimed');

    const claims = scene();
    expect(claimFor(claims.store, X).kind).toBe('claimed');
    expect(releaseNextClaim(claims.store, { item: X, seat: 'work', pane: 'w2:p1', at: AT })).toBe(true);
    expect(claimFor(claims.store, Y).kind).toBe('claimed');
  });

  test('the same item for another owner is hold-live, not receiver-busy', () => {
    const { store } = scene();
    const reservationStore: ReservationStore = store;
    expect(reserveFor(reservationStore, X, 'run-1').kind).toBe('reserved');

    expect(claimNext(reservationStore, { item: X, seat: 'lead', pane: 'w1:p1', now: AT, expiresAt: T })).toMatchObject({
      kind: 'refused',
      reason: 'hold-live',
    });
  });

  test("an expired hold does not block another item of the same seat", () => {
    const { store, clock } = scene();
    const reservationStore: ReservationStore = store;
    expect(claimFor(reservationStore, X).kind).toBe('claimed');

    clock.at = T;
    expect(claimNext(reservationStore, { item: Y, seat: 'work', pane: 'w2:p1', now: T, expiresAt: T + 60_000 }).kind).toBe(
      'claimed',
    );
  });

  test('a same-owner retry on the same item returns its own live hold, for both kinds', () => {
    const reservations = scene();
    const first = reserveFor(reservations.store, X, 'run-1');
    const again = reserveFor(reservations.store, X, 'run-1');
    expect(first.kind).toBe('reserved');
    expect(again.kind).toBe('reserved');
    if (first.kind === 'reserved' && again.kind === 'reserved') expect(again.hold).toEqual(first.hold);
    expect(reservations.store.transact((tx) => tx.holds().length)).toBe(1);

    const claims = scene();
    const claimed = claimFor(claims.store, Y);
    const claimedAgain = claimFor(claims.store, Y);
    expect(claimed.kind).toBe('claimed');
    expect(claimedAgain.kind).toBe('claimed');
    if (claimed.kind === 'claimed' && claimedAgain.kind === 'claimed') expect(claimedAgain.hold).toEqual(claimed.hold);
    expect(claims.store.transact((tx) => tx.holds().length)).toBe(1);
  });

  test('renewal moves only the deadline: the renewed claim is not swept at the old one', () => {
    const { store, clock } = scene();
    const reservationStore: ReservationStore = store;
    expect(claimFor(reservationStore, X).kind).toBe('claimed');
    const before = entryOf(store, X)?.hold;
    expect(before?.expiresAt).toBe(new Date(T).toISOString());

    clock.at = AT + 1000;
    expect(
      renewNextClaim(reservationStore, { item: X, seat: 'work', pane: 'w2:p1', now: AT + 1000, expiresAt: T + 120_000 }),
    ).toBe(true);
    const renewed = entryOf(store, X)?.hold;
    expect(renewed).toMatchObject({ owner: 'next:work:w2:p1', kind: 'next-claim', phase: 'pending', expiresAt: new Date(T + 120_000).toISOString() });

    expect(expire(reservationStore, T)).toEqual([]);
    expect(claimNext(reservationStore, { item: Y, seat: 'other', pane: 'w3:p1', now: T, expiresAt: T + 60_000 }).kind).toBe(
      'claimed',
    );
  });
});
