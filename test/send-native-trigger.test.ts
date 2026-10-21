// A body that is more than one line still reaches the pane as one short trigger. The
// single-line case lives in send.test.ts. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { TRIGGER_MAX, triggerLine } from '../src/send/native.ts';
import { recordBody } from './helpers.ts';
import { dropDir, filed, nativeHost, owner, world } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

test('a multi-line body is filed whole and the pane gets one short line', async () => {
  const made = world();
  cleanup = made.cleanup;
  const body = 'HEAD-LINE\nTAIL-LINE';
  const { host, pane } = nativeHost(made, ['idle', 'working']);

  const code = await runSend(['native', body], owner(made.root), host);

  expect(code).toBe(0);
  expect(pane.typed.length).toBe(1);
  const trigger = pane.typed[0] as string;
  expect(trigger.includes('\n')).toBe(false);
  expect(trigger.length).toBeLessThanOrEqual(TRIGGER_MAX);
  expect(trigger).not.toContain('HEAD-LINE');
  expect(trigger).not.toContain('TAIL-LINE');
  const drops = dropDir(made.dir);
  const names = readdirSync(drops);
  expect(names.length).toBe(1);
  const path = join(drops, names[0] as string);
  const line = triggerLine(path);
  if (line === null) throw new Error(`no trigger for ${path}`);
  expect(trigger).toBe(line);
  expect(recordBody(path)).toBe(filed(body));
  expect(host.frames).toEqual([]);
});
