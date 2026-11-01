// Two-process races over the REAL committed run store (adapter 919b65941, store 478a89f17). Each
// scene starts two driver processes against one store root behind a file barrier, releases them
// together and reads both answers, so a scene measures what the store's lock section actually
// decides rather than what one process assumes the other did.
//
// Scenes: two seats reserve one item (exactly one wins); two items, one receiver seat (the seat
// takes one only); claim against reserve on one item (exactly one effect); the expiry sweep
// against an acknowledgement (exactly one of the two, never both); two replies to one
// reservation (one conversion); and a restart in a second process, where the hold still excludes,
// the sweep reports it once and a claim then takes the item.
//
// Evidence label: REAL STORE. The product here is the committed store and adapter pair; only the
// barrier and answer protocol are test fixtures. Stand-in-store evidence lives in
// reservation-ops.test.ts and carries its own label.

import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  runDriver,
  runPair,
  scratch,
  type DriverRun,
  type Scratch,
} from './reservation-race-fixtures.ts';

const DRIVER = join(import.meta.dir, 'reservation-race-driver.ts');

const T = Date.parse('2026-10-20T09:00:00.000Z');
const AT = T - 60_000;
const ITEM = { source: 'file', project: 'acme', team: 'crew', id: 'm1' };
const ITEM2 = { source: 'file', project: 'acme', team: 'crew', id: 'm2' };

type Hold = { owner?: string; kind?: string; phase?: string; seat?: string; run?: string; messageId?: string };
type ReserveAnswer = { kind: string; reason?: string; hold?: Hold };
type ClaimAnswer = { kind: string; reason?: string; hold?: Hold };
type AckAnswer = { kind: string; why?: string; hold?: Hold };
type ExpiredAnswer = Array<{ kind: string; owner?: string }>;
type RecoveryAnswer = { recovered: Array<{ run: string; action: string }>; corrupt: Array<{ run: string }>; pending: Array<unknown> };

let live: Scratch | null = null;

afterEach(() => {
  live?.cleanup();
  live = null;
});

function root(): string {
  live = scratch('reservation-race');
  return live.store;
}

function resultOf<T>(run: DriverRun<T>): T {
  if (run.answer === null) {
    throw new Error(`the driver printed no answer (exit ${String(run.code)}): ${run.stderr.slice(0, 600)}`);
  }
  if (!run.answer.ok) throw new Error(`the driver failed: ${run.answer.error}`);
  return run.answer.result;
}

function reserveArgs(
  store: string,
  runId: string,
  seat: string,
  pane: string,
  item: { source: string; project: string; team: string; id: string } = ITEM,
): Record<string, unknown> {
  return { root: store, now: AT, item, runId, attempt: 1, thread: `th-${runId}`, receiver: { seat, pane }, expiresAt: T, at: AT };
}

function claimArgs(store: string, seat: string, pane: string, now = AT): Record<string, unknown> {
  return { root: store, now, item: ITEM, seat, pane, expiresAt: now + 60_000 };
}

function ackArgs(store: string, seat: string, pane: string, at = T - 1000, runId = 'run-1'): Record<string, unknown> {
  return { root: store, now: at, item: ITEM, runId, attempt: 1, thread: `th-${runId}`, seat, pane, messageId: 'msg-1', at };
}

async function holdOf(store: string, now = AT): Promise<{ key: string | null; hold: Hold | null }> {
  return resultOf(await runDriver<{ key: string | null; hold: Hold | null }>(DRIVER, 'hold', { root: store, now, item: ITEM }));
}

async function holdsIn(store: string): Promise<number> {
  const counts = resultOf(await runDriver<{ items: number; holds: number }>(DRIVER, 'counts', { root: store, now: AT }));
  return counts.holds;
}

describe('two seats reserving one item at once', () => {
  test('exactly one reservation lands, the other sees the live hold', async () => {
    const store = root();
    const [a, b] = await runPair<ReserveAnswer>(
      DRIVER,
      { command: 'reserve', args: reserveArgs(store, 'run-a', 'seat-a', 'fixture1:pane1') },
      { command: 'reserve', args: reserveArgs(store, 'run-b', 'seat-b', 'fixture2:pane1') },
    );
    const answers = [resultOf(a), resultOf(b)];
    expect(answers.filter((answer) => answer.kind === 'reserved')).toHaveLength(1);
    expect(answers.filter((answer) => answer.kind === 'refused').map((answer) => answer.reason)).toEqual(['hold-live']);

    const { hold } = await holdOf(store);
    expect(hold?.phase).toBe('pending');
    expect(['run-a/1', 'run-b/1']).toContain(hold?.owner ?? '');
    expect(await holdsIn(store)).toBe(1);
  });
});

describe('two items and one receiver seat at once', () => {
  test('the seat holds one item only, the other reservation is refused as receiver-busy', async () => {
    const store = root();
    const [a, b] = await runPair<ReserveAnswer>(
      DRIVER,
      { command: 'reserve', args: reserveArgs(store, 'run-a', 'work', 'fixture2:pane1', ITEM) },
      { command: 'reserve', args: reserveArgs(store, 'run-b', 'work', 'fixture2:pane1', ITEM2) },
    );
    const answers = [resultOf(a), resultOf(b)];
    expect(answers.filter((answer) => answer.kind === 'reserved')).toHaveLength(1);
    expect(answers.filter((answer) => answer.kind === 'refused').map((answer) => answer.reason)).toEqual(['receiver-busy']);
    expect(await holdsIn(store)).toBe(1);

    const seats = resultOf(await runDriver<string[]>(DRIVER, 'seats', { root: store, now: AT }));
    expect(seats).toEqual(['work']);
  });
});

describe('a claim racing a reservation on one item', () => {
  test('exactly one takes the item; the other is refused the live hold', async () => {
    const store = root();
    const [reserveRun, claimRun] = await runPair<ReserveAnswer | ClaimAnswer>(
      DRIVER,
      { command: 'reserve', args: reserveArgs(store, 'run-a', 'seat-a', 'fixture1:pane1') },
      { command: 'claim', args: claimArgs(store, 'lead', 'fixture1:pane1') },
    );
    const reserved = resultOf(reserveRun);
    const claimed = resultOf(claimRun);
    const effects = [reserved.kind === 'reserved', claimed.kind === 'claimed'].filter(Boolean);
    expect(effects).toHaveLength(1);
    const refusal = reserved.kind === 'refused' ? reserved : claimed.kind === 'refused' ? claimed : null;
    expect(refusal?.reason).toBe('hold-live');

    const { hold } = await holdOf(store);
    expect(hold?.owner).toBe(reserved.kind === 'reserved' ? 'run-a/1' : 'next:lead:fixture1:pane1');
    expect(await holdsIn(store)).toBe(1);
  });
});

describe('the expiry sweep racing an acknowledgement', () => {
  test('the reservation either expires or converts, never both, and the state agrees', async () => {
    const store = root();
    const reserved = resultOf(
      await runDriver<ReserveAnswer>(DRIVER, 'reserve', reserveArgs(store, 'run-1', 'work', 'fixture2:pane1')),
    );
    expect(reserved.kind).toBe('reserved');

    const [sweep, ack] = await runPair<unknown>(
      DRIVER,
      { command: 'expire', args: { root: store, now: T } },
      { command: 'ack', args: ackArgs(store, 'work', 'fixture2:pane1') },
    );
    const swept = resultOf(sweep) as ExpiredAnswer;
    const converted = resultOf(ack) as AckAnswer;
    const ackWon = converted.kind === 'acknowledged';
    if (ackWon) {
      expect(swept).toEqual([]);
      const { hold } = await holdOf(store, AT);
      expect(hold).toMatchObject({ phase: 'holder', owner: 'run-1/1' });
    } else {
      expect(converted).toMatchObject({ kind: 'ignored', why: 'no-reservation' });
      expect(swept).toHaveLength(1);
      const { hold } = await holdOf(store, AT);
      expect(hold).toBeNull();
    }
  });
});

describe('two replies to one reservation at once', () => {
  test('one conversion, the other reply finds the holder', async () => {
    const store = root();
    const reserved = resultOf(
      await runDriver<ReserveAnswer>(DRIVER, 'reserve', reserveArgs(store, 'run-1', 'work', 'fixture2:pane1')),
    );
    expect(reserved.kind).toBe('reserved');
    const [a, b] = await runPair<AckAnswer>(
      DRIVER,
      { command: 'ack', args: ackArgs(store, 'work', 'fixture2:pane1') },
      { command: 'ack', args: ackArgs(store, 'work', 'fixture2:pane1') },
    );
    const answers = [resultOf(a), resultOf(b)];
    expect(answers.filter((answer) => answer.kind === 'acknowledged')).toHaveLength(1);
    expect(answers.filter((answer) => answer.kind === 'ignored').map((answer) => answer.why)).toEqual(['already-holder']);
    const { hold } = await holdOf(store, AT);
    expect(hold).toMatchObject({ phase: 'holder', messageId: 'msg-1' });
    expect(await holdsIn(store)).toBe(1);
  });
});

describe('a restart in a second process', () => {
  test('the hold survives, keeps excluding a claim, and the sweep reports it once', async () => {
    const store = root();
    const reserved = resultOf(
      await runDriver<ReserveAnswer>(DRIVER, 'reserve', reserveArgs(store, 'run-1', 'work', 'fixture2:pane1')),
    );
    expect(reserved.kind).toBe('reserved');

    const recovered = resultOf(await runDriver<RecoveryAnswer>(DRIVER, 'recover', { root: store, now: AT }));
    expect(recovered.recovered).toEqual([]);
    expect(recovered.corrupt).toEqual([]);

    const before = await holdOf(store);
    expect(before.hold).toMatchObject({ owner: 'run-1/1', phase: 'pending' });
    const refused = resultOf(await runDriver<ClaimAnswer>(DRIVER, 'claim', claimArgs(store, 'lead', 'fixture1:pane1')));
    expect(refused).toMatchObject({ kind: 'refused', reason: 'hold-live' });

    const swept = resultOf(await runDriver<ExpiredAnswer>(DRIVER, 'expire', { root: store, now: T }));
    expect(swept).toHaveLength(1);
    const second = resultOf(await runDriver<ExpiredAnswer>(DRIVER, 'expire', { root: store, now: T }));
    expect(second).toEqual([]);
    expect((await holdOf(store, T)).hold).toBeNull();

    const claim = resultOf(await runDriver<ClaimAnswer>(DRIVER, 'claim', claimArgs(store, 'lead', 'fixture1:pane1', T)));
    expect(claim.kind).toBe('claimed');
    if (claim.kind === 'claimed') expect(claim.hold?.owner).toBe('next:lead:fixture1:pane1');
  });
});
