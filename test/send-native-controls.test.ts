// Control characters stay in the drop file. The pane receives the trigger line only, so a
// raw ESC, NUL, or newline from the body never becomes keystrokes. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { readTriggerLine } from '../src/send/native.ts';
import { recordBody } from './helpers.ts';
import { dropDir, filed, nativeHost, owner, world } from './send-native-fixtures.ts';

const BODY = 'PAYLOAD\n\x1b[31m\x00\x07\rEND';

let cleanup: () => void = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

test('control characters in the body are not typed into the pane', async () => {
  const made = world();
  cleanup = made.cleanup;
  const { host, pane } = nativeHost(made, ['idle', 'working']);

  const code = await runSend(['native', BODY], owner(made.root), host);

  expect(code).toBe(0);
  expect(pane.typed.length).toBe(0);
  // The body's first line is the summary, sanitised; the rest of the body stays in the drop.
  const drops = dropDir(made.dir);
  const names = readdirSync(drops).filter((name) => !name.includes('.'));
  expect(names.length).toBe(1);
  const path = join(drops, names[0] as string);
  const line = readTriggerLine('native', 'acme', { seat: 'owner', team: 'acme', body: BODY });
  expect(recordBody(path)).toBe(filed(BODY));
  expect(host.frames).toEqual([]);
});
