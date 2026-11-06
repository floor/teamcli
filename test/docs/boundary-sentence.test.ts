// The boundary, word for word: the screen read is one layer and the live-agent check is the
// other, and the watch page states both the owner's sentence and what the Cursor profile
// requires of the status row's place. A rewrite of the page may reword what surrounds these,
// never these.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const SENTENCE =
  "A screen that reproduces a CLI's complete idle frame (input row, status row and workspace line, in place) reads idle; the live-agent check is the second layer.";

// The page's own sentence for the positional rule, pinned as written, so the requirement that a
// grammar-matching line is the row only in the place the pane draws it cannot be softened or
// dropped without a test failing.
const POSITION =
  "the status row's place: a line the row's grammar matches is the row only when the workspace line sits directly below it, that line is the pane's last non-blank one, and the input row sits above it within the captured distance";

// The exception the positional rule needs to be true: Grok rows skip the distance pin, and the
// workspace line still sits directly below them. Pinned too, so the page cannot drop that line.
const GROK =
  "Grok rows are the profile's exception to the distance pin — the workspace line still sits directly below them — and every Grok row in the captures carries exactly the two spaces that grammar spells.";

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

describe('the watch page boundary', () => {
  test('the screen-read sentence, the Cursor positional rule and its Grok exception stand, verbatim', () => {
    const page = prose('../../docs/commands/watch.md');
    expect(page.includes(SENTENCE), 'watch.md lost the boundary sentence').toBe(true);
    expect(page.includes(POSITION), 'watch.md lost the Cursor positional rule').toBe(true);
    expect(page.includes(GROK), 'watch.md lost the Grok exception').toBe(true);
  });
});
