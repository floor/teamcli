// The team-file approval step was removed in 0.5.0. No source string or docs page may name it as
// something to do: a reader who follows the sentence would find no command. Internal comments may
// still describe the stored approval as history, so those few lines are exempted one by one below,
// by exact file and exact line text with a reason; everything else is scanned as written.
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

interface Exemption {
  /** The file, relative to the repository root. */
  file: string;
  /** The line exactly as written there. */
  line: string;
  /** Why this line names no step a reader can follow. */
  reason: string;
}

/** The lines that may describe the stored approval as history. The scan fails when an exempted
 *  line leaves its file, so the list cannot go stale. */
const EXEMPT: Exemption[] = [
  {
    file: 'src/grant.ts',
    line: ' * `up`, `down`, `approve` and `reload` call this. It reads the live default file and the approval again on this',
    reason: 'names when the live approval is read, not a step to approve anything',
  },
  {
    file: 'src/commands/rename.ts',
    line: '        `team rename: the approval pinned lead "${approvedPin}", which this file no longer resolves; approve the team again before renaming\\n`,',
    reason: 'the current team approve, asked before a rename would re-sign a lead the approval no longer resolves',
  },
  {
    file: 'src/commands/rename.ts',
    line: '        `team rename: the file now leads with "${pinned.team.orchestrator}", but the approval pinned "${approvedPin}"; approve the team again before renaming\\n`,',
    reason: 'the current team approve, asked before a rename would re-sign a lead the file and the approval disagree on',
  },
  {
    file: 'src/commands/rename.ts',
    line: '        `team rename: the live chain leads with "${team.orchestrator}", but the approval pinned "${approvedPin}"; approve the team again before renaming\\n`,',
    reason: 'the current team approve, asked before a rename would re-sign a lead the live chain and the approval disagree on',
  },
  {
    file: 'src/daemon/runtime-migration.ts',
    line: '  /** Lobby `guard_dir` lines to re-approve in reverse, one per guard refused. */',
    reason: 'the printed guard_dir line the current approve takes, not a removed step',
  },
  {
    file: 'src/daemon/runtime-migration.ts',
    line: '  /** Replacement `guard_dir` lines to re-approve, one per moved guard still named old. */',
    reason: 'the printed guard_dir line the current approve takes, not a removed step',
  },
  {
    file: 'docs/commands/daemon.md',
    line: 'lane. A moved guard folder prints the exact `guard_dir` line to re-approve and the',
    reason: 'documents the printed guard_dir line the current approve takes',
  },
];

/** Every run of whitespace as one space, so a phrase wrapped across a line in a help string or a
 *  docs paragraph is matched as it reads. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** The refused phrases in one file's text: the file as written, less the exact lines exempted for
 *  that file. */
function foundPhrases(raw: string, file: string): string[] {
  const exempt = EXEMPT.filter((entry) => entry.file === file).map((entry) => entry.line);
  const text = flatten(raw.split('\n').filter((line) => !exempt.includes(line)).join('\n'));
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

test('every exempted line is still in its file, so the list cannot go stale', () => {
  const missing = EXEMPT.filter((entry) => {
    const file = join(ROOT, entry.file);
    if (!existsSync(file)) return true;
    return !readFileSync(file, 'utf8').split('\n').includes(entry.line);
  });
  expect(missing.map((entry) => `${entry.file}: ${entry.reason}`)).toEqual([]);
});

test('no source or docs text names the removed approval step', () => {
  const files = [
    ...filesUnder(join(ROOT, 'src'), ['.ts']),
    ...filesUnder(join(ROOT, 'docs'), ['.md']),
    ...filesUnder(join(ROOT, 'contract'), ['.json']),
    ...['README.md', 'UPGRADE-0.5.md'].map((name) => join(ROOT, name)).filter((file) => existsSync(file)),
  ];
  const hits: string[] = [];
  for (const file of files) {
    const name = relative(ROOT, file);
    const raw = readFileSync(file, 'utf8');
    for (const phrase of foundPhrases(raw, name)) hits.push(`${name}: ${phrase}`);
  }
  expect(hits).toEqual([]);
});

test('a printed line is read wherever it appears', () => {
  const raw = [
    'const asterisk = `',
    '* approve the file again',
    '`;',
    'const slashes = `${name}// approve the team again`;',
  ].join('\n');
  expect(foundPhrases(raw, 'src/example.ts')).toEqual(['approve the team again', 'approve the file again']);
});

test('an exempted line is exempt only exactly, and only in its own file', () => {
  const entry = EXEMPT[0]!;
  expect(foundPhrases(entry.line, entry.file)).toEqual([]);
  expect(foundPhrases(entry.line, 'src/other.ts')).toEqual(['approval again']);
  expect(foundPhrases(`${entry.line} `, entry.file)).toEqual(['approval again']);
});
