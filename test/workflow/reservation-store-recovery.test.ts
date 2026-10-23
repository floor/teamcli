// Crash and restart behavior of the reservation surface over the REAL committed run store: the
// index is the exclusion truth, so every scene here damages one side of the index/journal pair
// and checks that a reopen of the store still sees exactly the exclusion the index holds.
//
// Scenes: an index-only hold whose run has no journal at all survives recovery and still blocks a
// claim; an index ahead of its journal (a lost audit line) keeps the hold; a journal ahead of the
// index adopts the terminal outcome and drops the hold, and a second recovery changes nothing; a
// restart never duplicates the hold and the sweep still reports it once.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  indexPath,
  journalPath,
  openRunStore,
  type ItemRecord,
  type RunStore,
} from '../../src/workflow/live/index.ts';
import {
  claimNext,
  expire,
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
  base = mkdtempSync(join(tmpdir(), 'reservation-recovery-'));
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

function claimBy(store: ReservationStore, at: number) {
  return claimNext(store, { item: ITEM, seat: 'lead', pane: 'w1:p1', now: at, expiresAt: at + 60_000 });
}

describe('an index-only hold whose run has no journal', () => {
  test('survives recovery, keeps blocking a claim, and the sweep reports it exactly once', () => {
    const { root, store } = scene();
    const ghost = 'ghost-1';
    expect(reserveFor(store, ITEM, ghost).kind).toBe('reserved');
    expect(existsSync(journalPath(root, ghost))).toBe(false);
    const held = entryOf(store, ITEM)?.hold;
    expect(held).toMatchObject({ owner: `${ghost}/1`, phase: 'pending' });

    const recovery = store.recover();
    expect(recovery.recovered).toEqual([]);
    expect(recovery.corrupt).toEqual([]);
    expect(entryOf(store, ITEM)?.hold).toEqual(held);
    expect(recovery.pending).toEqual([]);

    expect(claimBy(store, AT)).toMatchObject({ kind: 'refused', reason: 'hold-live' });
    expect(store.recover().recovered).toEqual([]);
    expect(entryOf(store, ITEM)?.hold).toEqual(held);

    expect(expire(store, T)).toEqual([
      { kind: 'reservation', item: ITEM, owner: `${ghost}/1`, run: ghost, attempt: 1, thread: 'th-ghost-1', seat: 'work', receiver: 'work', pane: 'w2:p1' },
    ]);
    expect(expire(store, T)).toEqual([]);
    expect(entryOf(store, ITEM)?.hold).toBeUndefined();
    expect(claimBy(store, T).kind).toBe('claimed');
  });
});

describe('an index ahead of its journal', () => {
  test('a lost audit line does not lose the hold, and the journal still reads', () => {
    const { root, store } = scene();
    const run = createRunFor(store, ITEM);
    expect(reserveFor(store, ITEM, run).kind).toBe('reserved');

    const path = journalPath(root, run);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const last = JSON.parse(lines.at(-1) ?? '{}') as { record?: string; action?: string };
    expect(last.record).toBe('hold');
    expect(last.action).toBe('reserve');
    writeFileSync(path, `${lines.slice(0, -1).join('\n')}\n`);

    const recovery = store.recover();
    expect(recovery.recovered).toEqual([]);
    expect(recovery.corrupt).toEqual([]);
    const entry = entryOf(store, ITEM);
    expect(entry?.hold).toMatchObject({ owner: `${run}/1`, phase: 'pending', run });
    expect(entry?.live).toBe(run);

    const read = store.read(run);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.records.some((record) => record.record === 'hold')).toBe(false);

    // The run is still live here, so the claim is refused by the run rather than by the hold; the
    // hold's survival is what this scene pins, and the sweep below reports it.
    expect(claimBy(store, AT)).toMatchObject({ kind: 'refused', reason: 'run-live', run });
    expect(expire(store, T)).toHaveLength(1);
  });
});

describe('a journal ahead of the index', () => {
  test('recovery adopts the terminal outcome, drops the hold, and a second recovery changes nothing', () => {
    const { root, store } = scene();
    const run = createRunFor(store, ITEM);
    expect(reserveFor(store, ITEM, run).kind).toBe('reserved');
    const before = readFileSync(indexPath(root), 'utf8');
    store.transact((tx) => tx.recordOutcome(run, { outcome: 'done', at: new Date(T).toISOString() }));
    expect(entryOf(store, ITEM)?.hold).toBeUndefined();

    writeFileSync(indexPath(root), before);
    const restored = entryOf(store, ITEM);
    expect(restored?.hold).toMatchObject({ owner: `${run}/1` });
    expect(restored?.terminal).toBeUndefined();

    const recovery = store.recover();
    expect(recovery.recovered).toEqual([{ run, action: 'terminal-adopted' }]);
    expect(recovery.corrupt).toEqual([]);
    const adopted = entryOf(store, ITEM);
    expect(adopted?.terminal).toMatchObject({ run, outcome: 'done' });
    expect(adopted?.live).toBeUndefined();
    expect(adopted?.hold).toBeUndefined();

    const again = store.recover();
    expect(again.recovered).toEqual([]);
    expect(entryOf(store, ITEM)).toEqual(adopted);
    expect(claimBy(store, AT)).toMatchObject({ kind: 'refused', reason: 'terminal' });
  });
});

describe('a restart', () => {
  test('does not duplicate the hold, and the retry stays one hold with one journal fold', () => {
    const { root, clock, store } = scene();
    const run = createRunFor(store, ITEM);
    expect(reserveFor(store, ITEM, run).kind).toBe('reserved');
    expect(store.recover().recovered).toEqual([]);
    expect(store.recover().recovered).toEqual([]);

    const restarted = openRunStore({ root, now: () => clock.at });
    const retried = reserveFor(restarted as ReservationStore, ITEM, run);
    expect(retried.kind).toBe('reserved');
    if (retried.kind === 'reserved') expect(retried.hold.owner).toBe(`${run}/1`);
    expect(restarted.transact((tx) => tx.holds().length)).toBe(1);
    expect(entryOf(restarted, ITEM)?.hold).toMatchObject({ owner: `${run}/1`, phase: 'pending' });

    const read = restarted.read(run);
    expect(read.ok).toBe(true);
    const restartedAgain = openRunStore({ root, now: () => clock.at });
    expect(restartedAgain.recover().recovered).toEqual([]);
    expect(restartedAgain.transact((tx) => tx.holds().length)).toBe(1);

    expect(expire(restarted as ReservationStore, T)).toHaveLength(1);
    expect(expire(restarted as ReservationStore, T)).toEqual([]);
    expect(restarted.transact((tx) => tx.holds().length)).toBe(0);
    // The hold is gone; the live run still excludes the item on its own.
    expect(claimBy(restarted as ReservationStore, T)).toMatchObject({ kind: 'refused', reason: 'run-live', run });
  });
});
