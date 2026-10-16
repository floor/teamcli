// The one-glance cut of the watch page. The command page now carries the operative parts — the
// flags, the callers, the refusals, one full report — and closes by naming what moved to
// docs/internal/watch.md. These pins hold the cut to its own promises: the closing sentence as
// written, the headings it names in the long read, the typing rules the long read now alone
// carries, the cut page's refusal rows, and the two worktree refusals the internal page adds —
// each checked against the source that prints it, so the page cannot claim a refusal the code
// does not give.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const WATCH_PAGE = '../../docs/commands/watch.md';
const LONG_READ = '../../docs/internal/watch.md';
const WORKTREE_PAGE = '../../docs/internal/worktree.md';
const WORKTREE_SRC = '../../src/commands/worktree.ts';

// The cut page's closing pointer, as written: seven topics, each of which the long read must
// still carry a heading for. Whitespace runs collapse before the match.
const POINTER =
  'Rationale, what it reads and writes, how a screen is read in full, what it types and what it leaves alone, the other reports and nudge lines, the budgets, and the known limits: [docs/internal/watch.md](../internal/watch.md).';
const PROMISED_HEADINGS = [
  '# `team watch`: rationale and known limits',
  '## What it types, and what it leaves alone',
  '## What it reads and writes',
  '## How a screen is read',
  '## What it prints',
  '## Budgets',
];

// The typing rules the long read now alone carries: the unreadable screen is left alone, a box
// that already holds the line is sent rather than retyped, and the report nudge outranks the
// message ring.
const TYPING_GUARD =
  "It types nothing into a screen it can't read as an empty idle prompt, so a permission dialog and a half-typed sentence are left alone.";
const BOX_ALREADY_HELD =
  "A box that already holds the nudge's own line is sent, not typed into twice — and only by the watch process that typed it: the same text from anyone else, or found after a restart, is its owner's, and is never sent or cleared.";
const NUDGE_NOT_BODY =
  'the watch types `Team: run team messages` and not the body';
const NUDGE_WINS =
  'The report nudge wins the pane: a pass that types it does not also type the ring.';

// The cut page's own refusals, as written: the second watch over one session, and the run with
// no terminal.
const SECOND_WATCH =
  'team watch: a watch already runs for the session "<session>" (pid <pid>)';
const NO_TERMINAL =
  'team watch: only the owner runs this, from a terminal outside herdr';

// The two refusal rows the internal worktree page adds in the same change. Both name templates
// the source really prints; the pin holds page and source together, so a row whose refusal the
// code no longer prints (or never did) fails here.
const SYMLINK_ROW =
  'team worktree: <folder> follows a symlink to <real>, which is outside the approved trust paths';
const SYMLINK_SRC = 'follows a symlink to ${landing.real}, which is outside the approved trust paths';
const BASE_TRACKS_ROW =
  'team worktree: base <base> tracks "<remote>", which isn\'t a remote branch; nothing was created';
const BASE_TRACKS_SRC =
  'base ${base} tracks ${JSON.stringify(remote)}, which isn\'t a remote branch; nothing was created';

function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

describe('the one-glance cut of the watch page', () => {
  test('the closing pointer stands as written, and the long read carries every heading it names', () => {
    expect(prose(WATCH_PAGE).includes(POINTER), 'watch.md lost the long-read pointer').toBe(true);
    const headings = prose(LONG_READ);
    for (const heading of PROMISED_HEADINGS) {
      expect(headings.includes(heading), `internal/watch.md lost "${heading}"`).toBe(true);
    }
  });

  test('the typing rules survive only in the long read, and stand as written', () => {
    const long = prose(LONG_READ);
    expect(long.includes(TYPING_GUARD), 'the long read lost the unreadable-screen guard').toBe(true);
    expect(long.includes(BOX_ALREADY_HELD), 'the long read lost the box-already-held rule').toBe(true);
    expect(long.includes(NUDGE_NOT_BODY), 'the long read lost the nudge-not-body rule').toBe(true);
    expect(long.includes(NUDGE_WINS), 'the long read lost the nudge-wins rule').toBe(true);
  });

  test('the cut page keeps its second-watch and no-terminal refusals as written', () => {
    const page = prose(WATCH_PAGE);
    expect(page.includes(SECOND_WATCH), 'the cut page lost the second-watch refusal').toBe(true);
    expect(page.includes(NO_TERMINAL), 'the cut page lost the no-terminal refusal').toBe(true);
  });

  test('the worktree page\'s new rows name refusals the source really prints', () => {
    expect(prose(WORKTREE_PAGE).includes(SYMLINK_ROW), 'worktree.md lost the symlink row').toBe(true);
    expect(prose(WORKTREE_PAGE).includes(BASE_TRACKS_ROW), 'worktree.md lost the base-tracks row').toBe(true);
    const source = readFileSync(new URL(WORKTREE_SRC, import.meta.url), 'utf8');
    expect(source.includes(SYMLINK_SRC), 'worktree.ts no longer prints the symlink refusal').toBe(true);
    expect(source.includes(BASE_TRACKS_SRC), 'worktree.ts no longer prints the base-tracks refusal').toBe(true);
  });
});
