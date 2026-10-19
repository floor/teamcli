// A body that is more than one line still reaches the pane as one short trigger. The
// single-line case lives in send.test.ts. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { TRIGGER_MAX, readTriggerLine, triggerLine } from '../src/send/native.ts';
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
  const line = readTriggerLine('native', 'acme');
  if (line === null) throw new Error('the trigger line did not fit');
  expect(trigger).toBe(line);
  expect(recordBody(path)).toBe(filed(body));
  expect(host.frames).toEqual([]);
});

test('a wake with a sender names its seat and team; one without keeps the old form', () => {
  const path = '/drops/teamcli/native/tester-1/4a9f';
  expect(triggerLine(path)).toBe(`Read ${path} and do that.`);
  expect(triggerLine(path, { seat: 'tester-2', team: 'teamcli' })).toBe(
    `From tester-2@teamcli: read ${path} and do that.`,
  );
});

test('a named wake fits at exactly the measured limit and is refused one character past it', () => {
  const sender = { seat: 'tester-2', team: 'teamcli' };
  // `From <seat>@<team>: read <path> and do that.` is 41 characters around a path for this
  // sender: 159 makes exactly 200, 160 makes 201.
  const fits = `/${'x'.repeat(158)}`;
  const over = `/${'x'.repeat(159)}`;
  const named = `From tester-2@teamcli: read ${fits} and do that.`;
  expect(named.length).toBe(TRIGGER_MAX);
  expect(triggerLine(fits, sender)).toBe(named);
  expect(triggerLine(over, sender)).toBeNull();
  // A path that only fits the nameless form is refused, not written nameless: a wake for a
  // message always names its sender.
  const oldFits = `/${'x'.repeat(TRIGGER_MAX - 'Read  and do that.'.length - 1)}`;
  expect(`Read ${oldFits} and do that.`.length).toBe(TRIGGER_MAX);
  expect(triggerLine(oldFits)).toBe(`Read ${oldFits} and do that.`);
  expect(triggerLine(oldFits, sender)).toBeNull();
  expect(triggerLine(`/${'x'.repeat(TRIGGER_MAX)}`, sender)).toBeNull();
});

test('a sender that is not one clean line is refused, never written nameless', () => {
  expect(triggerLine('/drops/a', { seat: 'tester\n2', team: 'teamcli' })).toBeNull();
  expect(triggerLine('/drops/a', { seat: 'tester-2', team: 'team\ncli' })).toBeNull();
});
