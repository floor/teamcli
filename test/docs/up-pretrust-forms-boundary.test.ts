// The two guards the lobby trust row's other pins leave open, held to the sources that build
// them. The up page's row generalises four repair forms `src/launch/pretrust.ts` prints; the
// claude form is pinned as the row's own elsewhere, and grok and cursor with it, but codex and
// antigravity's forms are unreached — a rewording of either would pass every other check. And
// the record the row describes is the same refusal `add`'s exit table carries: nothing else
// holds the family line on both pages at once. These two pins close those gaps.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const UP_PAGE = '../../docs/internal/up.md';
const ADD_PAGE = '../../docs/commands/add.md';
const PRETRUST_SRC = '../../src/launch/pretrust.ts';

// The family line both pages carry: the record `up` writes is the refusal `add` prints.
const FAMILY = 'the lobby is not trusted for <cli>: run <cli> in <lobby> and accept the folder';

describe("the lobby trust refusal's other two forms, and the family it belongs to", () => {
  test("the codex and antigravity repairs keep the page's accept-the-folder form", () => {
    const src = prose(PRETRUST_SRC);
    // The page's `<cli>` placeholder stands for four concrete spellings; claude's is pinned as
    // the row's own word for word elsewhere, so these two are the ones left open here.
    for (const cli of ['codex', 'agy'] as const) {
      expect(src).toContain(`the lobby is not trusted for ${cli}: run ${cli} in \${lobby} and accept the folder`);
    }
    // The tail both spellings share is the page's own: the general form's closing words.
    expect(src).toContain('in ${lobby} and accept the folder');
  });

  test('the family line lives on both pages, or neither drifts unnoticed', () => {
    // `up`'s records table and `add`'s exit table carry the one refusal between them; a page
    // edit that drops or rewords it on either side fails here even if every per-CLI form holds.
    expect(prose(UP_PAGE)).toContain(FAMILY);
    expect(prose(ADD_PAGE)).toContain(FAMILY);
  });
});
