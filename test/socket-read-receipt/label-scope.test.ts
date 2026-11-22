// The label fallback's scope edges: a blank label, a padded label, and the fields that are not
// the label. `label` means the seat's declared TeamCLI `label:` field in team.yaml — never the
// CLI display, model or version. A blank label, and a name that is empty after trimming, fall
// through to the seat name; a padded label is trimmed. The display line is display only, so the
// body attribution stays exactly as it was; the claim banner precedes it.
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
