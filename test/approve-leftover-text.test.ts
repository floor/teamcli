// The team-file approval step was removed in 0.5.0. No source string or docs page may name it as
// something to do: a reader who follows the sentence would find no command. Internal comments may
// still describe the stored approval as history; only the sentences that send someone to it are
// refused here, so source comments are dropped before the scan while the contents of strings and
// template literals are kept — a printed line is read even when it starts with `*` or `//`.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

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

/** The source text with its comments removed and every other character kept. A line inside a
 *  string or template literal is printed text, even when it starts with `*` or `//`; a comment is
 *  internal history and is dropped, with its newlines kept so it cannot join the lines around it. */
function withoutComments(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  let kept = '';
  let cursor = 0;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    kept += text.slice(cursor, scanner.getTokenStart());
    kept += text.slice(scanner.getTokenStart(), scanner.getTextPos()).replace(/[^\n]/g, '');
    cursor = scanner.getTextPos();
  }
  return kept + text.slice(cursor);
}

/** The refused phrases in one file's text, with source comments dropped and every run of
 *  whitespace read as one space. */
function foundPhrases(raw: string, source: boolean): string[] {
  const text = flatten(source ? withoutComments(raw) : raw);
  return PHRASES.filter((phrase) => text.includes(phrase));
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
    for (const phrase of foundPhrases(raw, file.endsWith('.ts'))) hits.push(`${relative(ROOT, file)}: ${phrase}`);
  }
  expect(hits).toEqual([]);
});

test('a printed line inside a template is read whatever it starts with', () => {
  const raw = [
    'const asterisk = `',
    '* approve the file again',
    '`;',
    'const slashes = `',
    '// approve the team again',
    '`;',
  ].join('\n');
  expect(foundPhrases(raw, true)).toEqual(['approve the team again', 'approve the file again']);
});

test('a real comment is still dropped', () => {
  const raw = ['// approve the file again', '/* approve the team again */', 'const usage = "text";'].join('\n');
  expect(foundPhrases(raw, true)).toEqual([]);
});
