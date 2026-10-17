// The tested-range sentence and the profile's own declaration, held to each other. The claim
// checker's own words put these sentences outside its checks — "a CLI version a profile is
// tested with" is not a claim (scripts/check-readmes.ts) — so a range can drift under a green
// readmes:check, and the Antigravity ceiling once did. Every "The X profile is tested with
// CLI ..." sentence in the shipped READMEs is swept here against the profile the loader really
// loads: it names a shipped profile, it claims exactly that profile's floor and ceiling, and a
// binary named in its parenthetical is the binary the profile runs.
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { profileFor } from '../src/profiles/index.ts';
import type { Profile } from '../src/profiles/profile.ts';

const ROOT = join(import.meta.dir, '..');

/** The shipped profiles, loaded by the loader the launch path itself uses. */
function shipped(): Record<string, Profile> {
  const loaded: Record<string, Profile> = {};
  for (const name of readdirSync(join(ROOT, 'src', 'profiles'))) {
    if (!name.endsWith('.yaml')) continue;
    const profile = profileFor(name.replace(/\.yaml$/, ''));
    if (!profile) throw new Error(`profile ${name} did not load`);
    loaded[name.replace(/\.yaml$/, '')] = profile;
  }
  return loaded;
}

/** The sentence's own shape: a floor, its ceiling, and the binary the reader runs. A profile
 *  named in two words on the page ("Claude Code") is the hyphenated cli id (`claude-code`). */
const SENTENCE = /^The ([A-Z][A-Za-z-]+(?: [A-Z][A-Za-z-]+)?) profile is tested with CLI (\d+(?:\.\d+)+)(?: to (\d+(?:\.\d+)+))?(?: \(`([^`]+)`\))?\./gm;

/** Every "The X profile is tested with CLI ..." sentence a readme carries. */
function sentences(file: string): { file: string; name: string; from: string; to?: string; binary?: string }[] {
  return [...readFileSync(join(ROOT, file), 'utf8').matchAll(SENTENCE)].map((match) => ({
    file,
    name: match[1]!.toLowerCase().replace(/ /g, '-'),
    from: match[2]!,
    ...(match[3] ? { to: match[3] } : {}),
    ...(match[4] ? { binary: match[4] } : {}),
  }));
}

describe('the tested-range sentence against the profile that declares it', () => {
  const profiles = shipped();
  // README.md carries the sentences today; npm-readme.md is swept too, so a sentence that
  // appears there later answers the same rule from its first day.
  const found = [...sentences('README.md'), ...sentences('npm-readme.md')];

  test('the sweep has sentences to sweep', () => {
    // A wholesale rephrasing must not turn this file green by finding nothing.
    expect(found.filter((sentence) => sentence.file === 'README.md').length).toBeGreaterThan(0);
  });

  test('every sentence names a shipped profile', () => {
    const unknown = found.filter((sentence) => !(sentence.name in profiles));
    expect(unknown.map((sentence) => `${sentence.file}: ${sentence.name}`)).toEqual([]);
  });

  test('every sentence claims exactly the profile\'s floor and ceiling', () => {
    // The drift this guards: a range claimed by its floor alone, with the ceiling left
    // unwritten. Either side moving — the profile's declaration or the sentence — fails here.
    for (const sentence of found) {
      const declared = profiles[sentence.name]!.tested;
      expect(
        [sentence.from, sentence.to],
        `${sentence.file}: ${sentence.name}`,
      ).toEqual([declared.from, declared.to]);
    }
  });

  test('a binary named in a sentence is the binary the profile runs', () => {
    for (const sentence of found) {
      if (sentence.binary) {
        expect(sentence.binary, `${sentence.file}: ${sentence.name}`).toBe(profiles[sentence.name]!.binary);
      }
    }
  });
});
