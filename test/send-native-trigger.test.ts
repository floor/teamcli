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

test('a wake past the measured limit is refused; a sender that cannot fit keeps the old form', () => {
  const tooLong = `/drops/${'x'.repeat(TRIGGER_MAX)}`;
  expect(triggerLine(tooLong, { seat: 'tester-2', team: 'teamcli' })).toBeNull();
  // The named form is 18 characters longer; this path leaves room for one and not both.
  const tight = `/drops/${'x'.repeat(164)}`;
  expect(triggerLine(tight, { seat: 'tester-2', team: 'teamcli' })).toBe(`Read ${tight} and do that.`);
  // A sender that is not one clean line never reaches the pane; the old form still does.
  expect(triggerLine('/drops/a', { seat: 'tester\n2', team: 'teamcli' })).toBe('Read /drops/a and do that.');
});
