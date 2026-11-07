// A pending marker names a record the drop scan already read. A later pass reuses that
// record's stamp instead of verifying the file again.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReconcileState, reconcilePass } from '../src/bus/reconcile.ts';
import { markPending } from '../src/send/pending.ts';
import { signRecord, type RecordPayload } from '../src/send/record.ts';
import { messageKeyOf } from '../src/store/keys.ts';

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

test('a pending marker reuses the record stamp on the next pass', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-pending-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const seat = join(root, '.agents', 'send-drops', 'acme', 'helper');
  mkdirSync(seat, { recursive: true });
  mkdirSync(home, { recursive: true });
  messageKeyOf(home);
  const id = 'held-1';
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: 'helper',
    to_id: null,
    root,
    session: 'acme',
    at: '2026-11-03T00:00:00.000Z',
    body: 'fixture',
    from: 'lead',
    from_id: null,
    rule: 'fixture',
    thread: id,
  };
  writeFileSync(join(seat, id), JSON.stringify(signRecord(payload, home)));
  markPending(seat, { id, from: 'lead', to: 'helper', body: 'fixture', ts: '2026-11-03T00:00:00.000Z', leg: 'drop' });
  const state = createReconcileState();
  const pass = () => reconcilePass({ project: 'acme', root, session: 'acme', home, state, now: new Date('2026-11-03T00:01:00.000Z') });
  const first = pass();
  expect(first.ok).toBe(true);
  expect(state.stats.filesRead).toBe(1);
  expect(state.stats.verifies).toBe(0);
  expect(state.stats.verifiesReused).toBe(1);
  const second = pass();
  expect(second.ok).toBe(true);
  expect(state.stats.filesRead).toBe(0);
  expect(state.stats.verifies).toBe(0);
  expect(state.stats.verifiesReused).toBe(1);
});

test('a pending marker on a symbolic link takes its refusal reason from the relative reader and raises only after replacement with a real signed record', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-pending-link-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const seat = join(root, '.agents', 'send-drops', 'acme', 'helper');
  mkdirSync(seat, { recursive: true });
  mkdirSync(home, { recursive: true });
  messageKeyOf(home);

  const id = 'held-link';
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: 'helper',
    to_id: null,
    root,
    session: 'acme',
    at: '2026-11-03T00:00:00.000Z',
    body: 'fixture',
    from: 'lead',
    from_id: null,
    rule: 'fixture',
    thread: id,
  };
  const target = join(base, 'outside-record');
  writeFileSync(target, JSON.stringify(signRecord(payload, home)));
  symlinkSync(target, join(seat, id));
  markPending(seat, { id, from: 'lead', to: 'helper', body: 'fixture', ts: '2026-11-03T00:00:00.000Z', leg: 'drop' });

  const state = createReconcileState();
  const refusals: { where: string; reason: string }[] = [];
  const pass = () =>
    reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      state,
      now: new Date('2026-11-03T00:10:00.000Z'),
      onRefused: (refusal) => refusals.push(refusal),
    });

  // Pass 1: the drop scan reports its own link sentence (`the record is a symbolic link`) while
  // the `.pending` loop consults `checkedDropRelative` and reports the reader's sentence
  // (`a symbolic link was found and not followed`); neither arrival nor held is raised.
  const first = pass();
  expect(first.ok).toBe(true);
  if (first.ok) expect(first.raised).toHaveLength(0);
  expect(refusals).toEqual([
    { where: `helper/${id}`, reason: 'the record is a symbolic link' },
    { where: `helper/${id}`, reason: 'a symbolic link was found and not followed' },
  ]);

  // Pass 2: while the symlink stands, both refusal keys stay in `state.refused` and are not repeated.
  refusals.length = 0;
  const second = pass();
  expect(second.ok).toBe(true);
  if (second.ok) expect(second.raised).toHaveLength(0);
  expect(refusals).toEqual([]);

  // Replace the symlink with the real signed record: the drop scan verifies it once, the
  // `.pending` loop reuses that stamp (`verifies === 0`, `verifiesReused === 1`), and both
  // `message.arrived` and `message.held` are raised.
  unlinkSync(join(seat, id));
  writeFileSync(join(seat, id), JSON.stringify(signRecord(payload, home)));
  const third = pass();
  expect(third.ok).toBe(true);
  if (third.ok) {
    expect(third.raised.map((e) => `${e.payload.kind}:${e.payload.record_id}`)).toEqual([
      `message.arrived:${id}`,
      `message.held:${id}:held`,
    ]);
  }
  expect(state.stats.filesRead).toBe(1);
  expect(state.stats.verifies).toBe(0);
  expect(state.stats.verifiesReused).toBe(1);
  expect(state.refused.size).toBe(0);
});
