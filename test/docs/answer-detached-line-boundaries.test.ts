// The fifth caller line `answer`'s refusal note names, held to the page and to the command's
// own order. A run placed with no terminal meets the detached sentence before the file or the
// caller is read, so it is that line and none of the other four; the note now counts five
// caller-speaking lines and names the fifth with its before-the-read claim. The sentence is
// pinned verbatim, the old count pinned gone, and the order checked as positions in the source.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const ANSWER_PAGE = '../../docs/internal/answer.md';
const ANSWER_SRC = '../../src/commands/answer.ts';

describe("answer's fifth caller line, the no-terminal refusal", () => {
  test('the note counts five and names the fifth, verbatim', () => {
    const page = prose(ANSWER_PAGE);
    expect(page).toContain('the five `team answer:` lines that speak to the caller rather than about the seat');
    expect(page).toContain(
      "`team answer: only the owner or the orchestrator from its own seat runs this, from a terminal outside herdr or its own seat` — a run placed with no terminal, judged before the file or the caller is read",
    );
    // The count the fifth line moved: four is gone.
    expect(page).not.toContain('the four `team answer:` lines');
  });

  test('the fifth line is the caller’s own constant, under the command’s own prefix', () => {
    const src = prose(ANSWER_SRC);
    // The detached refusal, walked once at the top and printed with `team answer:`'s prefix —
    // the sentence the page names, from the constant it lives in (pinned in caller.ts by its
    // own family elsewhere; here the print site is what this page rides).
    expect(src).toContain("const detached = detachedRefusal(walkCaller(io), { who: 'the owner or the orchestrator from its own seat'");
    expect(src).toContain("where: 'a terminal outside herdr or its own seat' });");
    expect(src).toContain('io.stderr(`team answer: ${detached}\\n`)');
    expect(src).toContain('// exit: answer.detached');
  });

  test('judged before the file or the caller is read: the order in the source', () => {
    const src = prose(ANSWER_SRC);
    // The page's claim, checked as position: the detached check prints and returns before the
    // file refusal is even built and before the caller verdict walks anything. Each needle is
    // a call form, so the import line that names the same helpers cannot stand in for a site.
    const detached = src.indexOf('exit: answer.detached');
    const file = src.indexOf('fileOwnerRefusal(io, args.values.file)');
    const verdict = src.indexOf('judgeCallerIn(io, dir, team)');
    expect(detached).toBeGreaterThan(-1);
    expect(file).toBeGreaterThan(-1);
    expect(verdict).toBeGreaterThan(-1);
    expect(detached).toBeLessThan(file);
    expect(detached).toBeLessThan(verdict);
  });
});
