// The owner's decision, word for word: what approvals are for is said in one sentence, in the
// README. A rewrite may reword what surrounds it, never this sentence.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const SENTENCE = 'Approvals guard against mistakes, not against a hostile process running as the owner.';

// Whitespace runs collapse before the match, so the sentence survives line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

describe('the limit sentence', () => {
  test('the README carries it, verbatim', () => {
    expect(prose('../../README.md').includes(SENTENCE), 'README.md lost the limit sentence').toBe(true);
  });
});
