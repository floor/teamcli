// The team-file approval step was removed in 0.5.0. No source string or docs page may name it as
// something to do: a reader who follows the sentence would find no command. Internal comments may
// still describe the stored approval as history; only the sentences that send someone to it are
// refused here, so whole-line comments are dropped from source files before the scan.
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
  'needing approval',
  'needs approval',
  'approval again',
  'approve again',
  're-approve',
  'reapprove',
];

/** Every run of whitespace as one space, so a phrase wrapped across a line in a help string or a
 *  docs paragraph is matched as it reads. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** The text without its whole-line comments: those may describe the stored approval as history,
 *  and none is printed to a reader or followed as a step. */
function withoutCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const start = line.trimStart();
      return !(start.startsWith('//') || start.startsWith('/*') || start.startsWith('*'));
    })
    .join('\n');
}

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
    const raw = readFileSync(file, 'utf8');
    const text = flatten(file.endsWith('.ts') ? withoutCommentLines(raw) : raw);
    for (const phrase of PHRASES) {
      if (text.includes(phrase)) hits.push(`${relative(ROOT, file)}: ${phrase}`);
    }
  }
  expect(hits).toEqual([]);
});
