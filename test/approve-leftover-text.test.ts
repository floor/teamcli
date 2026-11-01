// The team-file approval step was removed in 0.5.0. No source string or docs page may name it as
// something to do: a reader who follows the sentence would find no command. Internal comments may
// still describe the stored approval as history; only the sentences that send someone to it are
// refused here.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const PHRASES = [
  'the approval no longer covers',
  'approve the team again',
  'approve the file again',
  'for the owner to approve',
  'approve with the owner seat',
  'the approval record was not changed',
  'roster change is for the owner',
];

/** Every file under `dir` ending in one of `suffixes`, in a stable order. */
function filesUnder(dir: string, suffixes: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path, suffixes));
    else if (suffixes.some((suffix) => entry.endsWith(suffix))) found.push(path);
  }
  return found;
}

test('no source or docs text names the removed approval step', () => {
  const files = [
    ...filesUnder(join(ROOT, 'src'), ['.ts']),
    ...filesUnder(join(ROOT, 'docs'), ['.md']),
    ...filesUnder(join(ROOT, 'contract'), ['.json']),
    ...['README.md', 'UPGRADE-0.5.md'].map((name) => join(ROOT, name)).filter((file) => existsSync(file)),
  ];
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const phrase of PHRASES) {
      if (text.includes(phrase)) hits.push(`${relative(ROOT, file)}: ${phrase}`);
    }
  }
  expect(hits).toEqual([]);
});
