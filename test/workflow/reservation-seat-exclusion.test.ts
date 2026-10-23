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

function scene(): { store: RunStore } {
  if (base) rmSync(base, { recursive: true, force: true });
  base = mkdtempSync(join(tmpdir(), 'reservation-seat-'));
  const root = join(base, 'runs');
  const store = openRunStore({ root, now: () => AT });
  return { store };
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
