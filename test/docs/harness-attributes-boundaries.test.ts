// The two harness attributes the index page now names, held to the page and to the runner that
// reads them. `exec=1` on a `file file=` fence and `reply="…"` on a `console` fence are parser
// features of the docs harness itself — `test/docs/run.ts` and `test/docs/fixture.ts` — and the
// page's rows paraphrase those files' own comments. Each row is pinned verbatim and cross-checked
// against the code that makes it true, so the page cannot drift from the harness unnoticed.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// Whitespace runs collapse before the match, so the rows survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const PAGE = '../../docs/commands/README.md';
const RUN_SRC = '../../test/docs/run.ts';
const FIXTURE_SRC = '../../test/docs/fixture.ts';

describe('the two fence attributes the harness page names', () => {
  test('both rows stand, verbatim, in their tables', () => {
    const page = prose(PAGE);
    expect(page).toContain(
      '| `file file=<path>` | the same, for a file that isn\'t YAML (a log, a PR body); `exec=1` makes it runnable, as a check script has to be |',
    );
    expect(page).toContain(
      '| `reply="<text>"` | what the seat answers a waited `team send` in this block: with it, the wait prints the reply; without it, the seat stays silent and the wait times out |',
    );
  });

  test("exec=1 is the runner's own spelling: a file fence, the exact string, the bit it sets", () => {
    const run = prose(RUN_SRC);
    // The attribute is read off a `file` fence alone, and only the exact string '1' counts —
    // the page's `exec=1` is load-bearing, not a shorthand for any truthy value.
    expect(run).toContain("block.kind === 'file' && block.attrs.exec === '1'");
    // The write the attribute gates: the executable bit, and the fixture's own words for it.
    const fixture = prose(FIXTURE_SRC);
    expect(fixture).toContain('exec ? { mode: 0o755 } : {}');
    expect(fixture).toContain('`exec` makes it runnable, as a check script has to be');
  });

  test("reply is the fake seat's answer, silent without it", () => {
    const run = prose(RUN_SRC);
    // The runner's own comment carries the row's promise in the same words.
    expect(run).toContain('without it, the seat stays silent and the wait times out');
    // The reply path is guarded by the attribute's presence alone, and the answer rides the
    // frame a replying session writes — the `--wait` example prints what the seat said.
    expect(run).toContain('if (reply !== undefined)');
    expect(run).toContain('from-name="${seats[0] ?? \'seat\'}" from-mode="bypass"');
  });
});
