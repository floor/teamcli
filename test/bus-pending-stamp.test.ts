// A pending marker names a record the drop scan already read. A later pass reuses that
// record's stamp instead of verifying the file again.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  const seat = join(root, '.agents', 'send-drops', 'acme', 'iris');
  mkdirSync(seat, { recursive: true });
  mkdirSync(home, { recursive: true });
  messageKeyOf(home);
  const id = 'held-1';
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: 'iris',
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
  markPending(seat, { id, from: 'lead', to: 'iris', body: 'fixture', ts: '2026-11-03T00:00:00.000Z', leg: 'drop' });
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
