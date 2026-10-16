// The one-glance cut of the lock page. The page keeps the synopsis, the flags, the caller rule,
// the refusals in their own words and the exit codes, and closes by pointing at
// docs/internal/lock.md; the long read now alone carries how the take works, what it reads and
// writes, the holder the page stopped and the take that died halfway, and the two examples the
// page no longer runs — which no test executes. These pins hold the cut to its own enumeration,
// hold every rule the long read states to the line that enforces it, and hold the moved examples
// to the exact templates they quote, so neither page can drift from the code that prints it.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const PAGE = '../../docs/commands/lock.md';
const LONG = '../../docs/internal/lock.md';
const MACHINE_SRC = '../../src/lock/machine.ts';
const LOCK_SRC = '../../src/commands/lock.ts';
const UNLOCK_SRC = '../../src/commands/unlock.ts';

// The cut page's closing pointer, and the long read's own account of the cut.
const POINTER =
  'Rationale, behaviour, refusals and known limits: [docs/internal/lock.md](../internal/lock.md).';
const MOVED =
  'how the take works, what it reads and writes, the holder the page stopped and the take that died halfway, and the example the page no longer runs';
const STAYED =
  'The synopsis, the flags, the caller rule, the refusals in their own words and the exit codes stay on the page.';
const HEADINGS = [
  '# `team lock`: rationale and known limits',
  '## How the take works',
  '## What it reads and writes',
  '## When the holder is gone',
  '## Examples, moved here whole',
];

// What the page kept: the held template and its three dead-take variants with their exits, the
// invocation refusals, and the two sentences that bound the command.
const HELD_ROW = '<name>: held since <at> by <by> (<team>) — <run>, for <age>` | 1';
const HELD_NOT_YET = '<name>: held; its holder file is not there yet';
const HELD_UNREADABLE = '<name>: held; its holder file cannot be read';
const HELD_NOT_DIR = '<name>: held; its lock is not a directory';
const NAME_REQUIRED = 'a <name> is required';
const NAME_NOT_PATH = '"<name>" is a name, not a path: lowercase letters, digits and hyphens';
const WAIT_WHOLE = '--wait is a whole number of seconds';
const WAIT_MAX = '--wait is at most 86400 seconds';
const NEVER_REMOVED = 'A held lock is never removed by this command.';
const WAIT_NOT_BREAK = 'The wait does not break the lock. When `--wait` ends, the same refusal is printed.';
const CALLER_RULE = 'a seat does not remove a lock it did not take';

// The lines that print them: the held template, the three dead-take sentences, and the
// invocation templates with the usage.
const SRC_HELD = 'held since ${who.at} by ${who.by} (${who.team})${run}, for ${age}';
const SRC_NOT_YET = "seen.kind === 'missing') return `${name}: held; its holder file is not there yet`";
const SRC_NOT_DIR = "seen.kind === 'not-directory') return `${name}: held; its lock is not a directory`";
const SRC_UNREADABLE = 'return `${name}: held; its holder file cannot be read`';
const SRC_NAME_REQUIRED = "extra === undefined ? 'a <name> is required'";
const SRC_NAME_NOT_PATH = '`"${plainLine(name)}" is a name, not a path: lowercase letters, digits and hyphens`';
const SRC_WAIT_WHOLE = "'--wait is a whole number of seconds'";
const SRC_USAGE = 'Usage: team lock <name> [--for <text>] [--wait <seconds>]';

// The rules the long read now alone carries, each pinned to the line that enforces them: the
// plain mkdir that is the whole of the take, the `who` file written only after it, the holder
// the same pair may release.
const TAKE_WORKS =
  'created by a plain `mkdir`. That call fails when the directory is already there, which is the whole of the take';
const WHO_AFTER = 'The holder is a file named `who`, written only after the `mkdir` succeeds.';
const HELD_ONLY_READ = 'A lock that is already held is only read. A failed take writes nothing';
const WHO_SHAPE = 'team: beacon';
const UNLOCK_PAIR = 'releases it: the same project, and the same `by`';
// The page ends its caller rule in lowercase mid-sentence; the long read closes with the same
// sentence standing alone, capitalised.
const CALLER_RULE_LONG = 'A seat does not remove a lock it did not take.';
const SRC_MKDIR = 'mkdirSync(dir);';
const SRC_WHO_FILE = "const WHO_FILE = 'who';";
const SRC_WHO_TEMPLATE = 'team: ${who.team}\\nrun: ${who.run}\\nby: ${who.by}\\nat: ${who.at}\\n';
const SRC_NOT_YOURS = ', not you';
const SRC_RELEASED = '${name}: released\\n';

// The two moved examples, held to the exact templates they quote: the not-you refusal, the
// release, and the name that is a path.
const EXAMPLE_NOT_YOU = 'heavy-run: held by owner (beacon) since 2026-10-04T09:00:00Z — release CI, not you';
const EXAMPLE_RELEASED = 'heavy-run: released';
const EXAMPLE_NAME_PATH = 'team lock: "../out" is a name, not a path: lowercase letters, digits and hyphens';
const SRC_NOT_YOURS_LINE = 'held by ${who.by} (${who.team}) since ${who.at}${run}, not you';

function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('the one-glance cut of the lock page', () => {
  test('the pointer stands as written, and the long read says what moved and what stayed', () => {
    expect(prose(PAGE).includes(POINTER), 'lock.md lost the long-read pointer').toBe(true);
    const long = prose(LONG);
    expect(long.includes(MOVED), 'internal/lock.md lost its account of what moved off the page').toBe(true);
    expect(long.includes(STAYED), 'internal/lock.md lost its account of what stayed on the page').toBe(true);
    for (const heading of HEADINGS) {
      expect(long.includes(heading), `internal/lock.md lost "${heading}"`).toBe(true);
    }
  });

  test('the refusals the page kept, each named in the line that prints it', () => {
    const page = prose(PAGE);
    expect(page.includes(HELD_ROW), 'the page lost the held template row and its exit').toBe(true);
    expect(page.includes(HELD_NOT_YET), 'the page lost the not-there-yet row').toBe(true);
    expect(page.includes(HELD_UNREADABLE), 'the page lost the cannot-be-read row').toBe(true);
    expect(page.includes(HELD_NOT_DIR), 'the page lost the not-a-directory row').toBe(true);
    expect(page.includes(NAME_REQUIRED), 'the page lost the name-required refusal').toBe(true);
    expect(page.includes(NAME_NOT_PATH), 'the page lost the name-not-a-path refusal').toBe(true);
    expect(page.includes(WAIT_WHOLE), 'the page lost the whole-seconds refusal').toBe(true);
    expect(page.includes(WAIT_MAX), 'the page lost the 86400 refusal').toBe(true);
    expect(page.includes(NEVER_REMOVED), 'the page lost its never-removed sentence').toBe(true);
    expect(page.includes(WAIT_NOT_BREAK), 'the page lost its wait-does-not-break sentence').toBe(true);
    expect(page.includes(CALLER_RULE), 'the page lost the seat caller rule').toBe(true);
    const machine = raw(MACHINE_SRC);
    expect(machine.includes(SRC_HELD), 'machine.ts lost the held template').toBe(true);
    expect(machine.includes(SRC_NOT_YET), 'machine.ts lost the not-there-yet sentence').toBe(true);
    expect(machine.includes(SRC_NOT_DIR), 'machine.ts lost the not-a-directory sentence').toBe(true);
    expect(machine.includes(SRC_UNREADABLE), 'machine.ts lost the cannot-be-read sentence').toBe(true);
    const command = raw(LOCK_SRC);
    expect(command.includes(SRC_NAME_REQUIRED), 'lock.ts lost the name-required template').toBe(true);
    expect(command.includes(SRC_NAME_NOT_PATH), 'lock.ts lost the name-not-a-path template').toBe(true);
    expect(command.includes(SRC_WAIT_WHOLE), 'lock.ts lost the whole-seconds template').toBe(true);
    expect(command.includes(SRC_USAGE), 'lock.ts lost its usage line').toBe(true);
  });

  test('the take, the holder file and the release rule live only in the long read, and the source enforces them', () => {
    const long = prose(LONG);
    expect(long.includes(TAKE_WORKS), 'the long read lost the plain-mkdir take').toBe(true);
    expect(long.includes(WHO_AFTER), 'the long read lost the who-after-mkdir rule').toBe(true);
    expect(long.includes(HELD_ONLY_READ), 'the long read lost the held-only-read rule').toBe(true);
    expect(long.includes(WHO_SHAPE), 'the long read lost the holder file shape').toBe(true);
    expect(long.includes(UNLOCK_PAIR), 'the long read lost the same-pair release rule').toBe(true);
    expect(long.includes(CALLER_RULE_LONG), 'the long read lost the seat caller rule').toBe(true);
    const machine = raw(MACHINE_SRC);
    expect(machine.includes(SRC_MKDIR), 'the take is no longer a plain mkdir of the lock directory').toBe(true);
    expect(machine.includes(SRC_WHO_FILE), 'the holder file is no longer named who').toBe(true);
    expect(machine.includes(SRC_WHO_TEMPLATE), 'machine.ts lost the holder file template').toBe(true);
    expect(machine.includes(SRC_NOT_YOURS), 'machine.ts lost the not-you ending').toBe(true);
    expect(raw(UNLOCK_SRC).includes(SRC_RELEASED), 'unlock.ts lost the released line').toBe(true);
  });

  test('the moved examples stand as written, quoting templates the source really prints', () => {
    const long = prose(LONG);
    expect(long.includes(EXAMPLE_NOT_YOU), 'the long read lost the not-you example').toBe(true);
    expect(long.includes(EXAMPLE_RELEASED), 'the long read lost the released example').toBe(true);
    expect(long.includes(EXAMPLE_NAME_PATH), 'the long read lost the name-that-is-a-path example').toBe(true);
    expect(raw(MACHINE_SRC).includes(SRC_NOT_YOURS_LINE), 'the not-you example no longer matches its template').toBe(true);
    expect(raw(UNLOCK_SRC).includes(SRC_NAME_NOT_PATH), 'unlock names a path exactly as lock does').toBe(true);
  });
});
