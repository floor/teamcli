// The one-glance cut of the feed page. The command page keeps the synopsis, the flag table,
// the outcome list, the caller rule and the exit codes, and closes by pointing at
// docs/internal/feed.md; the long read now alone carries where the history lives and how it
// rotates, what the run reads and refuses to follow, and the known limits. These pins hold the
// cut to its own enumeration — what moved, what stayed — and hold the rules that live only in
// the long read against the source that enforces them, so the page cannot claim a guard the
// code does not give.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const FEED_PAGE = '../../docs/commands/feed.md';
const FEED_LONG = '../../docs/internal/feed.md';
const HISTORY_SRC = '../../src/send/history.ts';
const FEED_SRC = '../../src/commands/feed.ts';

// The cut page's closing pointer, and the long read's own account of the cut: what moved off
// the page, and what stayed on it. Whitespace runs collapse before the match.
const POINTER =
  'Rationale, behaviour, refusals and known limits: [docs/internal/feed.md](../internal/feed.md).';
const MOVED =
  'where the history lives and how it rotates, what the run reads and refuses to follow, the flags in their own words, and the known limits';
const STAYED =
  'The synopsis, the flag table, the outcome list, the caller rule and the exit codes stay on the page.';
const HEADINGS = [
  '# `team feed`: rationale and known limits',
  '## Where the history lives',
  '## What it reads and writes',
  '## The flags, in their own words',
];

// The rules the long read now alone carries. Rotation and the no-follow guard are claims about
// the writer and the reader of messages.jsonl; each is pinned to the line that enforces it.
const ROTATION =
  'The log rotates at 1 MB and keeps three files (`messages.jsonl`, `messages.jsonl.1`, `messages.jsonl.2`), each at mode `0600`.';
const SRC_ROTATION = 'Rotates at 1 MB keeping 3 files at mode 0600';
const SRC_ROTATED_MODE = 'chmodSync(`${path}.1`, 0o600)';
const NO_FOLLOW =
  'If a symbolic link or FIFO stands at the log or in the state folder ladder, `team feed` refuses and does not follow it.';
const SRC_FIFO = 'a FIFO was found and not followed';
const SRC_NOFOLLOW = 'constants.O_NOFOLLOW';

// The known limits: --all reads the machine's history, and it is the one form that answers
// outside a checkout. The source guard refuses every other outside-checkout form.
const LIMITS =
  "`--all` reads every project state folder under this home, so it follows the machine's history rather than this checkout's, and it is the one form that answers outside a checkout at all.";
const SRC_OUTSIDE_GUARD = '!allTeams && !inDeskLobby';

// What the cut page kept: the outcome list with its five outcomes, the unreadable row, and the
// JSON record line — the record's outcome union and the refusal template named in source.
const OUTCOMES = '(`delivered`, `answered`, `held`, `timeout`, or `unreachable`)';
const RECORD_LINE =
  '{"ts":"<ISO-8601>","from":"<sender>","to":"<seat>","body":"<text>","id":"<uuid>","outcome":"<outcome>"}';
const UNREADABLE = '`team feed: the history log cannot be read: <reason>`';
const SRC_OUTCOME_UNION =
  "export type HistoryOutcome = 'delivered' | 'held' | 'unreachable' | 'answered' | 'timeout';";
const SRC_UNREADABLE = 'team feed: the history log cannot be read: ${reason}';

function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('the one-glance cut of the feed page', () => {
  test('the pointer stands as written, and the long read says what moved and what stayed', () => {
    expect(prose(FEED_PAGE).includes(POINTER), 'feed.md lost the long-read pointer').toBe(true);
    const long = prose(FEED_LONG);
    expect(long.includes(MOVED), 'internal/feed.md lost its account of what moved off the page').toBe(true);
    expect(long.includes(STAYED), 'internal/feed.md lost its account of what stayed on the page').toBe(true);
    for (const heading of HEADINGS) {
      expect(long.includes(heading), `internal/feed.md lost "${heading}"`).toBe(true);
    }
  });

  test('the rotation and no-follow rules survive only in the long read, and the source enforces them', () => {
    const long = prose(FEED_LONG);
    expect(long.includes(ROTATION), 'the long read lost the rotation rule').toBe(true);
    expect(long.includes(NO_FOLLOW), 'the long read lost the no-follow rule').toBe(true);
    const history = raw(HISTORY_SRC);
    expect(history.includes(SRC_ROTATION), 'history.ts no longer states the 1 MB / three-file rotation').toBe(true);
    expect(history.includes(SRC_ROTATED_MODE), 'history.ts no longer enforces the rotated files\' mode').toBe(true);
    expect(history.includes(SRC_FIFO), 'history.ts no longer names the FIFO refusal').toBe(true);
    expect(history.includes(SRC_NOFOLLOW), 'history.ts no longer opens with O_NOFOLLOW').toBe(true);
  });

  test('the limits paragraph stands, and every other outside-checkout form is refused in source', () => {
    expect(prose(FEED_LONG).includes(LIMITS), 'the long read lost the --all limits paragraph').toBe(true);
    expect(raw(FEED_SRC).includes(SRC_OUTSIDE_GUARD), 'feed.ts no longer refuses the non-all outside-checkout forms').toBe(true);
  });

  test('the cut page keeps its outcome list, record line and unreadable row, each named in source', () => {
    const page = prose(FEED_PAGE);
    expect(page.includes(OUTCOMES), 'the cut page lost its five outcomes').toBe(true);
    expect(page.includes(RECORD_LINE), 'the cut page lost the JSON record line').toBe(true);
    expect(page.includes(UNREADABLE), 'the cut page lost the unreadable row').toBe(true);
    const history = raw(HISTORY_SRC);
    expect(history.includes(SRC_OUTCOME_UNION), 'history.ts lost the five-outcome union').toBe(true);
    expect(raw(FEED_SRC).includes(SRC_UNREADABLE), 'feed.ts no longer prints the unreadable refusal').toBe(true);
  });
});
