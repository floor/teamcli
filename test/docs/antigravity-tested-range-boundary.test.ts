// The team-file page's tested-range sentences, held to the profiles they describe. The claim checker
// deliberately does not read them — "a CLI version a profile is tested with" is not a version
// claim to it — which is how the Antigravity ceiling could move to 1.3.5 while the page still
// said the start of the range alone. Each sentence here is rebuilt from the profile the tool
// itself loads, so the page and the profile cannot drift apart again unnoticed.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { profileFor } from '../../src/profiles/profile.ts';

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const TEAM_FILE = '../../docs/team-file.md';

describe('the team-file page tested-range sentences', () => {
  test('the Antigravity sentence names the range the profile carries, and its binary', () => {
    const profile = profileFor('antigravity');
    if (profile === null) throw new Error('the antigravity profile is gone');
    expect(prose(TEAM_FILE)).toContain(
      `The Antigravity profile is tested with CLI ${profile.tested.from} to ${profile.tested.to} (\`${profile.binary}\`).`,
    );
    // The form this replaces: the range's start standing in for the whole range.
    expect(prose(TEAM_FILE)).not.toContain(`is tested with CLI ${profile.tested.from} (\`${profile.binary}\`)`);
  });

  test('the Codex sentence names the range its profile carries', () => {
    const profile = profileFor('codex');
    if (profile === null) throw new Error('the codex profile is gone');
    expect(prose(TEAM_FILE)).toContain(
      `The Codex profile is tested with CLI ${profile.tested.from} to ${profile.tested.to}.`,
    );
  });
});
