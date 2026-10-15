// The refusal rows the two lists never carried, held to the pages and to the sources that build
// them. `team watch` refused `--no-nudge` and `--no-notify` with its own sentence and `team
// worktree new` refused a linked folder and a base with no remote to fetch, but neither list
// said so. Each row here is pinned on its page verbatim and cross-checked against the string
// the command prints, placeholder for placeholder, so neither can drift from the other
// unnoticed.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// Whitespace runs collapse before the match, so the rows survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const WATCH_PAGE = '../../docs/commands/watch.md';
const WATCH_SRC = '../../src/commands/watch.ts';
const WORKTREE_PAGE = '../../docs/internal/worktree.md';
const WORKTREE_SRC = '../../src/commands/worktree.ts';

describe('the refusal rows the two lists never carried', () => {
  test("watch's table and its `1` bullet carry the two flags the command refuses", () => {
    const page = prose(WATCH_PAGE);
    expect(page).toContain(
      '| `team watch: --no-nudge and --no-notify are the owner\'s, from a terminal outside herdr; this call is <caller>` | 1 |',
    );
    expect(page).toContain(
      '- `1` — a watch already runs for the session. Or a caller that is not the owner aimed `--file`, or passed `--no-nudge` or `--no-notify`.',
    );
    // The row is the command's own sentence: the same clause, from the source that prints it.
    const src = prose(WATCH_SRC);
    expect(src).toContain(
      "`team watch: --no-nudge and --no-notify are the owner's, from a terminal outside herdr; this call is ${",
    );
  });

  test("worktree's table carries the symlink row, in the command's own words", () => {
    expect(prose(WORKTREE_PAGE)).toContain(
      '| `team worktree: <folder> follows a symlink to <real>, which is outside the approved trust paths` — the folder is a link and its real path is outside them | 1 |',
    );
    // The row quotes the refusal the command prints, placeholders and all.
    const src = prose(WORKTREE_SRC);
    expect(src).toContain('follows a symlink to ${');
    expect(src).toContain(', which is outside the approved trust paths');
  });

  test("worktree's table carries the no-remote-branch row, quotes included", () => {
    expect(prose(WORKTREE_PAGE)).toContain(
      '| `team worktree: base <base> tracks "<remote>", which isn\'t a remote branch; nothing was created` — the base\'s upstream names no remote to fetch | 1 |',
    );
    // The quotes around <remote> are the source's own: the name passes through JSON.stringify,
    // so the page renders a quoting the command really produces.
    const src = prose(WORKTREE_SRC);
    expect(src).toContain("tracks ${JSON.stringify(remote)}, which isn't a remote branch; nothing was created");
  });
});
