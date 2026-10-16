// The public tree carries no user-specific names and no paths off someone's machine: not a real
// person's name, not the owner's account name, not the sample folder a standing grant used to
// name. This test is the check that keeps them out — it reads every tracked file, which is the
// one place the `forbidden_public` patterns in .github/team.yaml cannot look: those guard commit
// messages, pull-request bodies and branch names, never a file's contents.
//
// Each needle is built from parts, so this file never matches its own check, and the failure
// output names the description, not the needle, so a regression is not echoed into a public log.
// .github/team.yaml is exempt: the same names live there on purpose, as forbidden patterns.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

/** The exempt list: the file whose own job is to carry these names as patterns. */
const EXEMPT = new Set([join('.github', 'team.yaml')]);

const NEEDLES: readonly { what: string; text: string }[] = [
  { what: 'a sample folder on a real machine', text: 'radio' + 'oooo' },
  { what: "the owner's account name", text: 'jvia' + 'l' },
  { what: "a real person's name", text: 'Dr ' + 'Jones' },
  { what: 'a seat name from a live team', text: 'iri' + 's' },
  { what: 'a seat name from a live team', text: 'atl' + 'as' },
];

function patternOf(needle: string): RegExp {
  return new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
}

test('no user-specific name or path is in the tracked tree', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const found: string[] = [];
  for (const file of files) {
    if (EXEMPT.has(file)) continue;
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const needle of NEEDLES) {
      if (patternOf(needle.text).test(text)) found.push(`${file}: ${needle.what}`);
    }
  }
  expect(found).toEqual([]);
});
