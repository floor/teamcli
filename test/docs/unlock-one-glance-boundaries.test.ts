// The one-glance cut of the unlock page. The reads-and-writes rules and the states the release
// leaves alone moved to docs/internal/unlock.md; the page keeps its synopsis, its flags, its
// caller rule, its refusals in their own words, its exit codes and its example. These pins hold
// the pointer and both accounts of the cut, hold the page's rewritten opening and its new
// never-removed sentence as written, hold the moved rules to the lines of releaseLock that do
// them — the holder file first and the directory second, the directory only when empty, the
// holder put back — and hold the kept refusal rows to the lines that print them.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const PAGE = '../../docs/commands/unlock.md';
const INTERNAL = '../../docs/internal/unlock.md';
const MACHINE_SRC = '../../src/lock/machine.ts';
const UNLOCK_SRC = '../../src/commands/unlock.ts';

// The cut page's closing pointer, and the internal note's own account of the cut.
const POINTER = 'Rationale, behaviour, refusals and known limits: [docs/internal/unlock.md](../internal/unlock.md).';
const MOVED =
  'What moved off [the `team unlock` page](../commands/unlock.md): what the run reads and writes, and the states the release leaves alone.';
const STAYED =
  'The synopsis, the flags, the caller rule, the refusals in their own words, the exit codes and the example stay on the page.';
const HEADINGS = [
  '# `team unlock`: rationale and known limits',
  '## What it reads and writes',
  '## A lock that cannot be released',
];

// What the page kept, in the words the cut left it in.
const OPENING =
  'Releases the lock [`team lock`](lock.md) took — but only when its holder file, `who`, names this caller: the same project and the same `by` line. Anyone else is shown who holds it and refused.';
const HAND_CLEARING =
  'A lock that cannot be released is left exactly where it is, and [`team lock`](lock.md) tells the owner how to clear one by hand.';
const NEVER_REMOVED = 'A lock that is not held, or held by someone else, is never removed: nothing is cleared and nobody is guessed.';
const FLAG_ROW = '| `<name>` | the lock\'s name, the same closed set as [`team lock`](lock.md) |';
const EXIT_ONE =
  '| 1 | it is not held, it is held by someone else, its holder can\'t be read, or the directory could not be removed |';
const EXIT_TWO = '| 2 | the invocation can\'t be read, or the team file can\'t |';
const EXAMPLE_NOT_HELD = 'demo: not held';

// The refusal rows the page kept, and the lines that print them.
const ROW_NOT_THERE = '<name>: its holder file is not there yet; left <path> in place';
const ROW_NOT_DIR = '<name>: its lock is not a directory; left <path> in place';
const ROW_UNREADABLE = '<name>: its holder file cannot be read; left <path> in place';
const SRC_NOT_THERE = '${name}: its holder file is not there yet; left ${dir} in place';
const SRC_NOT_DIR = '${name}: its lock is not a directory; left ${dir} in place';
const SRC_UNREADABLE = '${name}: its holder file cannot be read; left ${dir} in place';
const SRC_NOT_HELD = 'out.stderr(`${name}: not held\\n`);';

// The rules the note now alone carries, held to the lines of releaseLock that do them: the
// holder file removed first and the directory second, only when empty, and the holder put back
// when the directory would not go.
const RW_ORDER =
  'When the caller matches, it removes `who` and then the directory. The directory goes second, and only when it is empty: a file left beside `who` is not swept, and `who` is put back.';
const CANNOT_RELEASE =
  'A lock whose holder file is missing, unreadable, or not the four lines [`team lock`](../commands/lock.md) writes is left where it is — the directory is not removed to find out.';
const SRC_ORDER_DOC = ' * first and the directory second: a reader never sees a claimed empty directory, and `rmdir`';
const SRC_FOUR_LINES = 'The holder file, or null when it is not the four lines this command writes.';
const SRC_UNLINK = 'unlinkSync(whoPath);';
const SRC_RMDIR = 'rmdirSync(dir);';
const SRC_PUT_BACK = 'writeWho(root, input.name, dir, text);';
const SRC_PUT_BACK_LOST = 'removed the holder file but could not remove';

function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('the one-glance cut of the unlock page', () => {
  test('the pointer stands as written, and the note says what moved and what stayed', () => {
    expect(prose(PAGE).includes(POINTER), 'the page lost its long-read pointer').toBe(true);
    const internal = prose(INTERNAL);
    expect(internal.includes(MOVED), 'the note lost its account of what moved off the page').toBe(true);
    expect(internal.includes(STAYED), 'the note lost its account of what stayed on the page').toBe(true);
    for (const heading of HEADINGS) {
      expect(internal.includes(heading), `the note lost "${heading}"`).toBe(true);
    }
  });

  test('the page keeps its rewritten opening, its never-removed sentence, its exit table and its example', () => {
    const page = prose(PAGE);
    expect(page.includes(OPENING), 'the page lost its rewritten opening').toBe(true);
    expect(page.includes(HAND_CLEARING), 'the page lost its hand-clearing pointer').toBe(true);
    expect(page.includes(NEVER_REMOVED), 'the page lost its never-removed sentence').toBe(true);
    expect(page.includes(FLAG_ROW), 'the page lost its linked name flag row').toBe(true);
    expect(page.includes(EXIT_ONE), 'the page lost its exit-1 row').toBe(true);
    expect(page.includes(EXIT_TWO), 'the page lost its exit-2 row').toBe(true);
    expect(page.includes(EXAMPLE_NOT_HELD), 'the page\'s example lost its not-held run').toBe(true);
  });

  test('the order rules moved: in the note as written, gone from the page, named in the lines that do them', () => {
    const internal = prose(INTERNAL);
    expect(internal.includes(RW_ORDER), 'the note lost the who-first-directory-second rule').toBe(true);
    expect(internal.includes(CANNOT_RELEASE), 'the note lost the cannot-release rule').toBe(true);
    const page = prose(PAGE);
    expect(page.includes('The directory goes second'), 'the page still carries the moved order rule').toBe(false);
    expect(page.includes('not the four lines'), 'the page still carries the moved four-lines rule').toBe(false);
    const machine = raw(MACHINE_SRC);
    expect(machine.includes(SRC_ORDER_DOC), 'machine.ts lost its who-first docstring line').toBe(true);
    expect(machine.includes(SRC_FOUR_LINES), 'machine.ts lost its four-lines holder rule').toBe(true);
    expect(machine.includes(SRC_UNLINK), 'releaseLock no longer removes the holder file').toBe(true);
    expect(machine.includes(SRC_RMDIR), 'releaseLock no longer removes the directory').toBe(true);
    expect(machine.includes(SRC_PUT_BACK), 'releaseLock no longer puts the holder back').toBe(true);
    expect(machine.includes(SRC_PUT_BACK_LOST), 'releaseLock lost its holder-removed confession').toBe(true);
  });

  test('the kept refusal rows are named in the lines that print them', () => {
    const page = prose(PAGE);
    expect(page.includes(ROW_NOT_THERE), 'the page lost the not-there-yet row').toBe(true);
    expect(page.includes(ROW_NOT_DIR), 'the page lost the not-a-directory row').toBe(true);
    expect(page.includes(ROW_UNREADABLE), 'the page lost the cannot-be-read row').toBe(true);
    const machine = raw(MACHINE_SRC);
    expect(machine.includes(SRC_NOT_THERE), 'machine.ts lost the not-there-yet line').toBe(true);
    expect(machine.includes(SRC_NOT_DIR), 'machine.ts lost the not-a-directory line').toBe(true);
    expect(machine.includes(SRC_UNREADABLE), 'machine.ts lost the cannot-be-read line').toBe(true);
    expect(raw(UNLOCK_SRC).includes(SRC_NOT_HELD), 'unlock.ts lost the not-held line').toBe(true);
  });
});
