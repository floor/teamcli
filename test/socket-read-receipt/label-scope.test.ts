// The label fallback's scope edges: a blank label, a padded label, and the fields that are not
// the label. `label` means the seat's declared TeamCLI `label:` field in team.yaml — never the
// CLI display, model or version. A blank label, and a name that is empty after trimming, fall
// through to the seat name; a padded label is trimmed. The opening line is display only, so the
// body attribution stays exactly as it was.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../../src/commands/send.ts';
import {
  acceptSocket,
  book,
  dropsOf,
  frameOf,
  helperIo,
  hostOf,
  recordOf,
  registerHelper,
  world,
  type World,
} from './fixtures.ts';
import { labelSeat } from './label-fixtures.ts';

let made: World | null = null;
afterEach(() => {
  made?.cleanup();
  made = null;
});

/** Writes one field into a seat stanza, under its `name:` line. */
function writeSeatField(one: World, seat: string, key: string, value: string): void {
  const path = join(one.dir, 'team.yaml');
  const lines = readFileSync(path, 'utf8').split('\n');
  const at = lines.findIndex((line) => line === `    name: ${seat}`);
  if (at < 0) throw new Error(`the fixture's team file names no seat ${seat}`);
  lines.splice(at + 1, 0, `    ${key}: ${JSON.stringify(value)}`);
  writeFileSync(path, lines.join('\n'));
}

test('a blank written label falls back to the seat name', async () => {
  const one = world(['socket']);
  made = one;
  acceptSocket(one);
  // A written label of spaces only is a declared label whose name is empty after trimming.
  labelSeat(one, 'helper', '   ');
  registerHelper(one, null);
  const host = hostOf(one, book());
  const drops = dropsOf(one);

  expect(await runSend(['lead', 'a note'], helperIo(one), host)).toBe(0);
  const frame = frameOf(host.frames);
  const record = recordOf(drops);
  expect(frame.content.split('\n')[0]).toBe('Message from helper (helper@acme)');
  expect(record.body.startsWith('from helper — admitted by: ')).toBe(true);
});

test('a padded written label is trimmed before it is read', async () => {
  const one = world(['socket']);
  made = one;
  acceptSocket(one);
  labelSeat(one, 'helper', '  Bea  ·  implementer  ');
  registerHelper(one, null);
  const host = hostOf(one, book());
  const drops = dropsOf(one);

  expect(await runSend(['lead', 'a note'], helperIo(one), host)).toBe(0);
  const frame = frameOf(host.frames);
  const record = recordOf(drops);
  expect(frame.content.split('\n')[0]).toBe('Message from Bea (helper@acme)');
  // Display only: the body keeps the seat name when no nickname stands.
  expect(record.body.startsWith('from helper — admitted by: ')).toBe(true);
  expect(record.raw).not.toContain('Bea');
});

test('the CLI display, model and version are never the label name', async () => {
  const one = world(['socket']);
  made = one;
  acceptSocket(one);
  // A declared pane display with no label: the stored default title is the model and version.
  writeSeatField(one, 'helper', 'display', 'Bea 1');
  registerHelper(one, null);
  const host = hostOf(one, book());
  const drops = dropsOf(one);

  expect(await runSend(['lead', 'a note'], helperIo(one), host)).toBe(0);
  const frame = frameOf(host.frames);
  const record = recordOf(drops);
  expect(frame.content.split('\n')[0]).toBe('Message from helper (helper@acme)');
  expect(record.body.startsWith('from helper — admitted by: ')).toBe(true);
});
