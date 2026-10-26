// Two sends that overlap on one native seat. send.test.ts checks that only one trigger is
// typed. This checks the drop files: the body that was written stays whole, and the other
// body is not spliced in. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { recordBody } from './helpers.ts';
import { dropDir, fake, filed, owner, world } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

test('an overlapping send leaves the first drop whole and writes no second body', async () => {
  const made = world();
  cleanup = made.cleanup;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waits = 0;
  const typed: string[] = [];
  const host = fake(made, {
    agents: () => [{ name: 'native', pane: 'w9:p1' }],
    native: {
      typeText: (_session, _pane, text) => {
        typed.push(text);
        return true;
      },
      pressEnter: () => true,
      status: () => (waits < 2 ? 'idle' : 'working'),
      wait: () => {
        waits += 1;
        return waits === 1 ? gate : Promise.resolve();
      },
    },
  });
  const first = runSend(['native', 'ALPHA-ONE'], owner(made.root), host);
  const started = Date.now();
  while (typed.length === 0 && Date.now() - started < 1000) await new Promise((resolve) => setTimeout(resolve, 5));

  const secondIo = owner(made.root);
  const second = await runSend(['native', 'BETA-TWO'], secondIo, host);

  const drops = dropDir(made.dir);
  const during = readdirSync(drops);
  expect(during.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  const duringRecords = during.filter((name) => !name.includes('.'));
  expect(duringRecords.length).toBe(2);
  const bodies = duringRecords.map((name) => recordBody(join(drops, name))).sort();
  expect(bodies).toEqual([filed('ALPHA-ONE'), filed('BETA-TWO')]);
  expect(bodies[0]).not.toContain('BETA-TWO');
  expect(bodies[1]).not.toContain('ALPHA-ONE');
  expect(second).toBe(0);
  expect(secondIo.out).toMatch(/native: queued \(receiver busy\) \(typed, \d+ ms; id [0-9a-f-]+\)\n$/);
  release();
  expect(await first).toBe(0);
  const afterRecords = readdirSync(drops).filter((name) => !name.includes('.'));
  expect(afterRecords).toEqual(duringRecords);
  expect(afterRecords.map((name) => recordBody(join(drops, name))).sort()).toEqual([filed('ALPHA-ONE'), filed('BETA-TWO')]);
  expect(typed.length).toBe(1);
  // The display line carries the body's first line as its summary by design; the drop it names
  // is still the whole body, and the overlapping body reaches neither.
  expect(typed[0]).toBe('Message from owner (owner@acme): ALPHA-ONE Read it with: team drops --read.');
  expect(typed[0]).not.toContain('BETA-TWO');
});
