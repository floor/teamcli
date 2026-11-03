// A refusal is said once while the path is still there, and dropped when the path is gone.
// The cache does not keep a path the pass no longer meets.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReconcileState, reconcilePass } from '../src/bus/reconcile.ts';
import { messageKeyOf } from '../src/store/keys.ts';

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

test('a refusal is kept while the path remains and dropped once the path is gone', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-refused-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const seat = join(root, '.agents', 'send-drops', 'acme', 'iris');
  mkdirSync(seat, { recursive: true });
  mkdirSync(home, { recursive: true });
  messageKeyOf(home);
  const first = join(seat, 'bad-one');
  const second = join(seat, 'bad-two');
  writeFileSync(first, '{}\n');
  writeFileSync(second, '{}\n');
  const state = createReconcileState();
  const said: string[] = [];
  const pass = () => reconcilePass({
    project: 'acme',
    root,
    session: 'acme',
    home,
    state,
    onRefused: (refusal) => said.push(refusal.where),
  });
  pass();
  expect(said).toEqual(['iris/bad-one', 'iris/bad-two']);
  expect(state.refused.has(`record\0${first}`)).toBe(true);
  said.length = 0;
  pass();
  expect(said).toEqual([]);
  expect(state.refused.size).toBe(2);
  rmSync(first);
  pass();
  expect(state.refused.has(`record\0${first}`)).toBe(false);
  expect(state.refused.has(`record\0${second}`)).toBe(true);
  rmSync(second);
  pass();
  expect(state.refused.size).toBe(0);
});
