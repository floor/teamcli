// Two sends that overlap on one native seat. send.test.ts checks that only one trigger is
// typed. This checks the drop files: the body that was written stays whole, and the other
// body is not spliced in. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { dropDir, fake, owner, world } from './send-native-fixtures.ts';

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
  expect(during.length).toBe(1);
  const stored = readFileSync(join(drops, during[0] as string), 'utf8');
  expect(stored).toBe('ALPHA-ONE');
  expect(stored).not.toContain('BETA-TWO');
  expect(second).toBe(1);
  expect(secondIo.err).toContain('refused');
  expect(secondIo.err).toContain('nothing was sent');
  release();
  expect(await first).toBe(0);
  const after = readdirSync(drops);
  expect(after).toEqual(during);
  expect(readFileSync(join(drops, after[0] as string), 'utf8')).toBe('ALPHA-ONE');
  expect(typed.length).toBe(1);
  expect(typed[0]).not.toContain('ALPHA-ONE');
  expect(typed[0]).not.toContain('BETA-TWO');
});
