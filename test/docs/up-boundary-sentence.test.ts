// The up pages' boundary sentences, word for word: who is refused and in whose words, what a
// left-alone seat may count on, and what a dry run promises. The example walk runs the pages'
// fixtures; nothing else holds their prose. A rewrite may reword what surrounds these, never
// these — and the refusal's words are pinned to the code's own constant, so neither page nor
// code can drift from the other unnoticed.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const PAGE = '../../docs/internal/commands/up.md';
const INTERNAL = '../../docs/internal/up.md';

describe('the up pages boundary sentences', () => {
  test('the left-alone promise stands, verbatim, as the page opens', () => {
    expect(prose(PAGE)).toContain(
      'A seat already running or ready is left as it is — its pane is not closed, moved or typed into — and its sidebar is rewritten from the file either way.',
    );
  });

  test('the no-terminal refusal is quoted in the code\'s own words, on both pages', () => {
    // The commands page quotes it as the run prints it; the internal page quotes the sentence
    // alone. `up` admits the owner and the team's lead, so its refusal is the route's sentence —
    // not the owner-only constant — and both pages carry it word for word.
    const sentence = 'only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane';
    expect(prose(PAGE)).toContain(`team up: ${sentence}`);
    expect(prose(INTERNAL)).toContain(sentence);
  });

  test('the grant row\'s --session and --file refusals stand, verbatim', () => {
    expect(prose(PAGE)).toContain('`--session` and `--file` are refused before either is read');
  });

  test('the dry-run promise stands, verbatim: it reaches nothing and changes nothing', () => {
    expect(prose(PAGE)).toContain('run `--dry-run`, which reaches nothing and changes nothing');
  });
});
