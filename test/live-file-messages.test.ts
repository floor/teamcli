// The live file is the record: no sentence in src/ sends a caller to the approval copy — not a
// refusal, not a note, not a comment. "approved one", "approved file" and "run `team approve`"
// are gone from every one of them, and this file fails the moment one comes back, naming the
// line. Strings and comments are read alike: a reader of the source is a reader of the tool.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const NEEDLES = ['approved one', 'approved file', 'run `team approve`'] as const;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

test('no sentence in src/ names the approval copy', () => {
  const hits: string[] = [];
  for (const path of sources(join(import.meta.dir, '..', 'src'))) {
    const shown = path.slice(path.indexOf('/src/') + 1);
    for (const [index, line] of readFileSync(path, 'utf8').split('\n').entries()) {
      for (const needle of NEEDLES) {
        if (line.includes(needle)) hits.push(`${shown}:${index + 1} says "${needle}"`);
      }
    }
  }
  expect(hits).toEqual([]);
});
