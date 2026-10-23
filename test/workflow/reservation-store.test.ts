// The reservation surface over the REAL committed run store, in one process: the pin pair
// (adapter 919b65941, store 478a89f17). The key formatter is the store's own, the holds live in
// its durable index, and the audits land in its journals; nothing here is a stand-in.
//
// Scenes: dotted and percent segments cannot alias; a converted holder outlives the deadline
// that used to apply; a retry is idempotent and a second attempt while the hold is live is
// refused; the deadline instant is expired for both the sweep and a fresh claim; a run's
// outcome releases its own hold with an audit line and a terminal item refuses others until a
// reopen; and a live run refuses a hold for any other run.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openRunStore,
  type ItemRecord,
  type RunStore,
} from '../../src/workflow/live/index.ts';
import {
  acknowledge,
  claimNext,
  excludedItems,
  expire,
  releaseReservation,
  reserve,
  type ItemIdentity,
  type ReservationStore,
} from '../../src/workflow/reservation/index.ts';
import { createRunFor } from './reservation-live-fixture.ts';

const T = Date.parse('2026-10-20T09:00:00.000Z');
const AT = T - 60_000;

const ITEM: ItemIdentity = { source: 'file', project: 'acme', team: 'crew', id: 'm1' };

let base: string;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

type Scene = { root: string; clock: { at: number }; store: RunStore };

function scene(at = AT): Scene {
  if (base) rmSync(base, { recursive: true, force: true });
  base = mkdtempSync(join(tmpdir(), 'reservation-store-'));
  const root = join(base, 'runs');
  const clock = { at };
  const store = openRunStore({ root, now: () => clock.at });
  return { root, clock, store };
}

function entryOf(store: RunStore, item: ItemIdentity): ItemRecord | null {
  const key = store.keyText(item);
  if (key === null) throw new Error('the fixture item is unkeyable');
  return store.entry(key);
}

function reserveFor(store: ReservationStore, item: ItemIdentity, runId: string, seat = 'work', pane = 'w2:p1') {
  return reserve(store, {
    item,
    runId,
    attempt: 1,
    thread: `th-${runId}`,
    receiver: { seat, pane },
    expiresAt: T,
    at: AT,
  });
}

describe('the store key formatter over real holds', () => {
  test('dotted and percent segments cannot alias, and each item gets its own hold', () => {
    const { store } = scene();
    const a = { source: 'file', project: 'acme', team: 'a', id: 'b.c' };
    const b = { source: 'file', project: 'acme', team: 'a.b', id: 'c' };
    const c = { source: 'file', project: 'acme', team: 'a', id: 'b%2Ec' };
    const keys = [a, b, c].map((item) => store.keyText(item));
    expect(keys.every((key) => typeof key === 'string')).toBe(true);
    expect(new Set(keys).size).toBe(3);

    const reservationStore: ReservationStore = store;
    expect(reserveFor(reservationStore, a, 'run-a', 's1', 'w1:p1').kind).toBe('reserved');
    expect(reserveFor(reservationStore, b, 'run-b', 's2', 'w2:p1').kind).toBe('reserved');
    expect(reserveFor(reservationStore, c, 'run-c', 's3', 'w3:p1').kind).toBe('reserved');

    for (const [item, runId] of [[a, 'run-a'], [b, 'run-b'], [c, 'run-c']] as const) {
      const entry = entryOf(store, item);
      expect(entry?.hold).toMatchObject({ owner: `${runId}/1`, phase: 'pending' });
    }
    expect(store.transact((tx) => tx.holds().length)).toBe(3);
  });
});

describe('a converted holder', () => {
  test('outlives the acknowledgement deadline that used to apply', () => {
    const { store, clock } = scene();
    const reservationStore: ReservationStore = store;
    expect(reserveFor(reservationStore, ITEM, 'run-1').kind).toBe('reserved');
    const answer = acknowledge(reservationStore, {
      item: ITEM, runId: 'run-1', attempt: 1, thread: 'th-run-1',
      seat: 'work', pane: 'w2:p1', messageId: 'msg-1', at: T - 1000,
    });
    expect(answer.kind).toBe('acknowledged');
    const holder = entryOf(store, ITEM)?.hold;
    expect(holder).toMatchObject({ phase: 'holder', holder: { seat: 'work', pane: 'w2:p1' }, messageId: 'msg-1' });
    expect(holder?.expiresAt).toBeUndefined();

    clock.at = T + 86_400_000;
    expect(expire(reservationStore, clock.at)).toEqual([]);
    expect(entryOf(store, ITEM)?.hold?.phase).toBe('holder');
    expect(store.transact((tx) =>
      tx.tryHold({
        item: ITEM, kind: 'reservation', owner: 'run-2/1', seat: 'work',
        expiresAt: new Date(clock.at).toISOString(), at: new Date(clock.at).toISOString(), run: 'run-2', attempt: 1,
      }),
    )).toMatchObject({ ok: false, reason: 'hold-live' });
    expect(claimNext(reservationStore, { item: ITEM, seat: 'lead', pane: 'w1:p1', now: clock.at, expiresAt: clock.at + 60_000 })).toMatchObject({
      kind: 'refused',
      reason: 'hold-live',
    });
    const key = store.keyText(ITEM);
    if (key === null) throw new Error('the fixture item is unkeyable');
    expect(excludedItems(reservationStore, [ITEM], clock.at)).toEqual(new Set([key]));
    expect(store.transact((tx) => tx.busySeats())).toEqual(['work']);
  });

  test('a retry with the same owner is idempotent; another attempt while the hold is live is not', () => {
    const { store } = scene();
    const reservationStore: ReservationStore = store;
    const first = reserveFor(reservationStore, ITEM, 'run-1');
    const again = reserveFor(reservationStore, ITEM, 'run-1');
    expect(first.kind).toBe('reserved');
    expect(again.kind).toBe('reserved');
    if (first.kind !== 'reserved' || again.kind !== 'reserved') return;
    expect(again.hold).toEqual(first.hold);
    expect(store.transact((tx) => tx.holds().length)).toBe(1);
    expect(reserve(reservationStore, {
      item: ITEM, runId: 'run-1', attempt: 2, thread: 'th-run-1', receiver: { seat: 'work' },
      expiresAt: T, at: AT,
    })).toMatchObject({ kind: 'refused', reason: 'hold-live' });
    expect(releaseReservation(reservationStore, { item: ITEM, runId: 'run-1', attempt: 1, at: AT })).toBe(true);
    expect(reserve(reservationStore, {
      item: ITEM, runId: 'run-1', attempt: 2, thread: 'th-run-1', receiver: { seat: 'work' },
      expiresAt: T, at: AT,
    }).kind).toBe('reserved');
  });
});

describe('the deadline instant', () => {
  test('the sweep reports the pending hold once, and a late reply finds no reservation', () => {
    const { store } = scene();
    const reservationStore: ReservationStore = store;
    expect(reserveFor(reservationStore, ITEM, 'run-1').kind).toBe('reserved');
    expect(expire(reservationStore, T)).toEqual([
      { kind: 'reservation', item: ITEM, owner: 'run-1/1', run: 'run-1', attempt: 1, thread: 'th-run-1', seat: 'work', receiver: 'work', pane: 'w2:p1' },
    ]);
    expect(entryOf(store, ITEM)?.hold).toBeUndefined();
    expect(acknowledge(reservationStore, {
      item: ITEM, runId: 'run-1', attempt: 1, thread: 'th-run-1', seat: 'work', pane: 'w2:p1', messageId: 'msg-1', at: T - 1000,
    })).toEqual({ kind: 'ignored', why: 'no-reservation' });
  });

  test('a store at the deadline treats the pending hold as past for a fresh claim', () => {
    const { store, clock } = scene();
    const reservationStore: ReservationStore = store;
    expect(reserveFor(reservationStore, ITEM, 'run-1').kind).toBe('reserved');
    clock.at = T;
    const claim = claimNext(reservationStore, { item: ITEM, seat: 'lead', pane: 'w1:p1', now: T, expiresAt: T + 60_000 });
    expect(claim.kind).toBe('claimed');
    expect(entryOf(store, ITEM)?.hold).toMatchObject({ kind: 'next-claim', owner: 'next:lead:w1:p1' });
  });
});

describe('runs: a live run refuses other holds, and its outcome releases its own', () => {
  test('a hold for another run is refused while the run is live', () => {
    const { store } = scene();
    const reservationStore: ReservationStore = store;
    const run = createRunFor(store, ITEM);
    expect(reserveFor(reservationStore, ITEM, 'another-run')).toMatchObject({ kind: 'refused', reason: 'run-live', run });
    expect(reserveFor(reservationStore, ITEM, run).kind).toBe('reserved');
  });

  test('the run outcome releases the hold with an audit line, and a reopen admits the next attempt', () => {
    const { store, clock } = scene();
    const reservationStore: ReservationStore = store;
    const run = createRunFor(store, ITEM);
    expect(reserveFor(reservationStore, ITEM, run).kind).toBe('reserved');
    clock.at = T;
    store.transact((tx) => tx.recordOutcome(run, { outcome: 'done', at: new Date(T).toISOString() }));

    const afterOutcome = entryOf(store, ITEM);
    expect(afterOutcome?.terminal).toMatchObject({ run, outcome: 'done' });
    expect(afterOutcome?.hold).toBeUndefined();
    const journal = store.read(run);
    if (!journal.ok) throw new Error(`the journal did not read: ${journal.damage.why}`);
    const actions = journal.records
      .filter((record): record is Extract<(typeof journal.records)[number], { record: 'hold' }> => record.record === 'hold')
      .map((record) => record.action);
    expect(actions).toEqual(['reserve', 'release']);

    expect(reserveFor(reservationStore, ITEM, 'late-run')).toMatchObject({ kind: 'refused', reason: 'terminal' });
    const reopened = store.transact((tx) =>
      tx.reopen({ item: ITEM, by: 'lead', at: new Date(T + 1000).toISOString(), reason: 'retry' }),
    );
    expect(reopened.item.reopened).toMatchObject({ by: 'lead' });
    expect(reopened.item.terminal).toBeUndefined();
    clock.at = T + 2000;
    const next = reserve(reservationStore, {
      item: ITEM, runId: run, attempt: 2, thread: 'th-run-1', receiver: { seat: 'work', pane: 'w2:p1' },
      expiresAt: T + 60_000, at: T + 2000,
    });
    expect(next.kind).toBe('reserved');
    if (next.kind === 'reserved') expect(next.hold.owner).toBe(`${run}/2`);
  });
});
