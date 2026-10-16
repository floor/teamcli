// The session-doubt refusal at its boundaries. The add page's exit table now carries the refusal
// for a pane this record cannot tie to the launch, with what the record holds and the promise
// that nothing is closed and nothing started. The sentence itself is the binary's, and it lives
// in three places — the add refusal, `up`'s doubt default, and the launch's left-out reason. These
// pins tie the row to the source and the three copies to each other.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const PAGE = '../../docs/commands/add.md';
const ADD_SRC = '../../src/commands/add.ts';
const UP_SRC = '../../src/commands/up.ts';
const EXECUTE_SRC = '../../src/launch/execute.ts';

// The refusal row's explanation, as written: what the record holds, why the pane fails it, and
// the promise that the pane is left alone.
const EXPLAINS =
  "the record holds the pane's own shell pid and the CLI's pids, read when the seat was launched; the pane is running neither, and the agent session herdr shows there is not the stored one. Nothing is closed and no second CLI is started in it";

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

// The clause the three source files share: pulled out of each by its own quoting, so a drift in
// any one of them parts the pair the test names.
function clauseIn(src: string, pattern: RegExp): string {
  const found = raw(src).match(pattern);
  if (!found) throw new Error(`${src} no longer carries the session-doubt clause`);
  return found[1]!;
}

describe('the session-doubt refusal on paper', () => {
  test('the row and its explanation stand as written', () => {
    const page = prose(PAGE);
    expect(page.includes('team add: <name>: its pane holds a process this record cannot tie to the launch'), 'add.md lost the session-doubt row').toBe(true);
    expect(page.includes(EXPLAINS), 'add.md lost what the record holds and the promise it makes').toBe(true);
  });

  test('the row quotes the refusal the command prints, placeholder for placeholder', () => {
    // add.ts builds the line from a template on its own stderr call; <name> in the row is its
    // one interpolation.
    const template = clauseIn(ADD_SRC, /out\.stderr\(`team add: \$\{plainText\(`\$\{built\.name\}: ([^`]+)`/);
    expect(`team add: <name>: ${template}`, 'the row and the command parted').toBe(
      'team add: <name>: its pane holds a process this record cannot tie to the launch',
    );
  });

  test('the clause is one sentence in the three files that print or record it', () => {
    const inAdd = clauseIn(ADD_SRC, /built\.name\}: ([^`]+)`/);
    const inUp = clauseIn(UP_SRC, /sessionDoubt: refusal \?\? '([^']+)'/);
    // The launch's copy sits at the end of the pane checks, right after the unsent-text sibling —
    // the anchor is that sibling, not the clause, so a rename still lands here and fails loudly.
    const inLeftOut = clauseIn(EXECUTE_SRC, /holds unsent text[^`]*` \}\);\s*break;[\s\S]{0,200}reason: '([^']+)'/);
    expect(inUp, 'up\'s doubt default parted from the add refusal').toBe(inAdd);
    expect(inLeftOut, 'the launch\'s left-out reason parted from the add refusal').toBe(inAdd);
  });
});
