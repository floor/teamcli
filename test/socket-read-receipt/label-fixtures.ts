// Scenes for the accepted frame's label fallback: one written seat label in the sending run's
// own team file. The shared world writes no label, so the scene adds the key to the one seat it
// names — exactly the stanza an owner edits by hand. No product code, live session or owner home.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { World } from './fixtures.ts';

/**
 * Writes one seat's `label:` into the fixture's team file, under the stanza's `name:` line: the
 * key a person edits to title the seat in herdr. A label written this way is a *written* label
 * (the file's default title is the model and version and is never taken for a name).
 */
export function labelSeat(made: World, seat: string, label: string): void {
  const path = join(made.dir, 'team.yaml');
  const lines = readFileSync(path, 'utf8').split('\n');
  const at = lines.findIndex((line) => line === `    name: ${seat}`);
  if (at < 0) throw new Error(`the fixture's team file names no seat ${seat}`);
  lines.splice(at + 1, 0, `    label: ${JSON.stringify(label)}`);
  writeFileSync(path, lines.join('\n'));
}
