// The held outcome's paper trail at its boundaries. The docs now promise six confirmed outcomes
// and a five-outcome history; the binary owns both lists, and nothing ties the sentences to it —
// a seventh outcome, a history write for `refused`, or a reworded held definition would land
// unannounced. These pins read the docs and the source and refuse to let them part.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const SEND_PAGE = '../../docs/commands/send.md';
const README = '../../README.md';
const HISTORY_SRC = '../../src/send/history.ts';
const SEND_SRC = '../../src/commands/send.ts';

// The six the page and the README confirm, in the page's own order. Both files must carry the
// same list; a seventh outcome added to the binary without both pages fails the src comparison.
const CONFIRMED = ['delivered', 'answered', 'held', 'timeout', 'unreachable', 'refused'];

// What held means, as the page states it: nothing typed, the body safe on disk, the pane as it
// was, exit 1. Pinned as written so the definition cannot be softened into something the
// command does not do.
const HELD_DEFINITION =
  '`held` is nothing typed: the message is safely on disk, the pane was left as it was, and the run exits 1 — the reason it prints says what held it.';

// The exit table's held row, pinned as written.
const HELD_ROW = '| held | 1 | `team send: <seat>: held: <reason>` on stderr |';

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

// The backticked outcome names in order inside a prose fragment.
function backticked(fragment: string): string[] {
  return [...fragment.matchAll(/`([a-z]+)`/g)].map((m) => m[1]!);
}

// The outcomes the binary's own type says a history line can carry, parsed from the source so a
// change there moves the test without a hand-edited list.
function historyOutcomes(): string[] {
  const src = raw(HISTORY_SRC);
  const union = src.match(/export type HistoryOutcome = ([^;]+);/);
  if (!union) throw new Error('HistoryOutcome could not be found in src/send/history.ts');
  return [...union[1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
}

describe('the held outcome on paper', () => {
  test('the send page and the README confirm the same six, and they are the binary’s outcomes plus refused', () => {
    const page = prose(SEND_PAGE);
    const sentence = page.match(/The outcome is always confirmed — one of ([^—]+) — /);
    expect(sentence, 'send.md lost the always-confirmed sentence').not.toBeNull();
    expect(backticked(sentence![1]!), 'send.md’s confirmed list changed').toEqual(CONFIRMED);

    const readme = prose(README);
    const row = readme.match(/\| `team send` \| writes one message to one seat, confirming ([^.|]+)\./);
    expect(row, 'the README lost its team send row’s confirming list').not.toBeNull();
    expect(backticked(row![1]!), 'the README’s confirmed list changed').toEqual(CONFIRMED);

    // The history type is the write-down set; `refused` writes nothing by design, so the pages
    // confirm exactly the history outcomes plus it — no more, no fewer.
    expect([...historyOutcomes()].sort(), 'the binary’s history outcomes changed').toEqual(
      [...CONFIRMED.filter((o) => o !== 'refused')].sort(),
    );
  });

  test('the history sentence names exactly the outcomes the binary writes down', () => {
    const page = prose(SEND_PAGE);
    const sentence = page.match(/run that ends (.+?) appends one line/);
    expect(sentence, 'send.md lost the history-write sentence').not.toBeNull();
    const named = backticked(sentence![1]!);
    expect([...named].sort(), 'the history sentence drifted from the write-down set').toEqual(
      [...historyOutcomes()].sort(),
    );
  });

  // The row’s shape is the command’s own line. On this branch’s tree the held line is not
  // printed yet — the native `held` reason still reaches the terminal as an unreachable — so
  // the pin is marked failing until the tree carries the feature; it flips (and so asks to be
  // unmarked) the moment it does.
  test.failing('the held definition and its exit row stand as written, and the row quotes the binary’s own format', () => {
    const page = prose(SEND_PAGE);
    expect(page.includes(HELD_DEFINITION), 'send.md lost the held definition').toBe(true);
    expect(page.includes(HELD_ROW), 'send.md lost the held exit row').toBe(true);

    // The row’s shape is the command’s own line: pull the template from the source and require
    // the row to be its exact placeholder rendering, so neither can drift alone.
    const src = raw(SEND_SRC);
    const template = src.match(/io\.stderr\(`team send: \$\{seat\}: held: \$\{reason\}\\n`\)/);
    expect(template, 'src no longer prints the held line with seat and reason').not.toBeNull();
    expect(HELD_ROW.includes('`team send: <seat>: held: <reason>`'), 'the row’s quoted shape changed').toBe(true);
  });
});
