// The one-glance cut of the tempo page. The reads-and-writes rules and the three runs the page
// no longer carries moved to docs/internal/tempo.md; the synopsis, the flags, the caller table,
// the output table and the one example stay. These pins hold the pointer and both accounts of
// the cut, hold what stayed to the page as written, hold the moved runs verbatim in the note and
// gone from the page with each message named in the line that prints it, and hold the moved
// read-and-write rules to the lines in setTempo that do them.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const PAGE = '../../docs/commands/tempo.md';
const INTERNAL = '../../docs/internal/tempo.md';
const SRC = '../../src/commands/tempo.ts';

// The cut page's closing pointer, and the internal note's own account of the cut.
const POINTER = 'Rationale, behaviour, refusals and known limits: [docs/internal/tempo.md](../internal/tempo.md).';
const MOVED =
  'What moved off [the `team tempo` page](../commands/tempo.md): what the run reads and writes, and the runs the page no longer carries.';
const STAYED =
  'The synopsis, the flags, the caller table, the output and exit codes table and the one example stay on the page.';
const UNEXECUTED =
  'None is executed by any test — `test/docs.test.ts` runs the console fences of `docs/commands/` alone — and each runs against the page\'s own team file.';
const HEADINGS = [
  '# `team tempo`: rationale and known limits',
  '## What it reads and writes',
  '## The runs the page no longer carries',
];

// What stayed on the page: the synopsis, the flags rows, the caller rows, the output rows and
// the one example.
const SYNOPSIS = 'team tempo <word>';
const FLAG_WORD = '| `<word>` | `relaxed`, `normal` or `urgent` |';
const FLAG_HELP = '| `--help`, `-h` | the usage, and exit 0 |';
const OWNER_ROW = 'the owner, from a terminal outside herdr | set the word';
const NO_TERMINAL_ROW = 'nothing: `team tempo: only the owner runs this, from a terminal outside herdr`';
const SEAT_ROW = 'nothing: `team tempo: only the owner runs tempo, from a terminal outside herdr; this call is <caller>`';
const OUTPUT_WORD = '`tempo: <word>`. A written `relaxed` or `urgent` also says it takes effect when the file is approved';
const OUTPUT_BAD = '`team tempo: <problem>`, with the usage for a bad word | 2';
const EXAMPLE_TAKES_EFFECT = 'team tempo: it takes effect when the file is approved';

// The three moved runs: their introductions and their console bodies.
const RUN_SAME_INTRO = 'The same word again leaves the line:';
const RUN_SAME_BODY = 'tempo: urgent exit 0';
const RUN_BAD_INTRO = 'A word the file does not know is the usage:';
const RUN_BAD_BODY = 'team tempo: "faster" must be relaxed, normal or urgent Usage: team tempo <word> exit 2';
const RUN_SEAT_INTRO = "A seat can't run it:";
const RUN_SEAT_BODY =
  'team tempo: only the owner runs tempo, from a terminal outside herdr; this call is unplaced (it is run by an agent (claude) outside herdr) exit 1';

// The lines that print each: the bad-word refusal with its word list, the owner refusal with its
// caller description, the word line, and the usage.
const SRC_WORDS = "const WORDS = 'relaxed, normal or urgent';";
const SRC_BAD = 'team tempo: "${word}" must be ${WORDS}';
const SRC_OWNER = 'team tempo: only the owner runs tempo, from a terminal outside herdr; this call is ${describeCaller(caller)}';
const SRC_WORD_LINE = 'tempo: ${word}\\n';
const SRC_USAGE = "'Usage: team tempo <word>\\n'";

// The moved read-and-write rules, each named in the line that does it: the tempo line found, the
// same word returning the file untouched, and the missing key spliced in after `format:`.
const RW_PARAGRAPH =
  'Writes one line, `tempo: <word>`, after `format:` when the key is missing, or on the line that already names it. The rest of the file is left as it is. A line that already says that word is not rewritten.';
const SRC_FIND_TEMPO = "const index = lines.findIndex((line) => /^tempo:/.test(line));";
const SRC_SAME_WORD = 'if (written === word) return text;';
const SRC_FIND_FORMAT = "const format = lines.findIndex((line) => /^format:/.test(line));";
const SRC_SPLICE = 'lines.splice(format >= 0 ? format + 1 : 0, 0, `tempo: ${word}`);';

function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('the one-glance cut of the tempo page', () => {
  test('the pointer stands as written, and the note says what moved, what stayed and what it alone carries', () => {
    expect(prose(PAGE).includes(POINTER), 'the page lost its long-read pointer').toBe(true);
    const internal = prose(INTERNAL);
    expect(internal.includes(MOVED), 'the note lost its account of what moved off the page').toBe(true);
    expect(internal.includes(STAYED), 'the note lost its account of what stayed on the page').toBe(true);
    expect(internal.includes(UNEXECUTED), 'the note lost its none-is-executed claim').toBe(true);
    for (const heading of HEADINGS) {
      expect(internal.includes(heading), `the note lost "${heading}"`).toBe(true);
    }
  });

  test('what the note says stayed stands on the page as written', () => {
    const page = prose(PAGE);
    expect(page.includes(SYNOPSIS), 'the page lost its synopsis').toBe(true);
    expect(page.includes(FLAG_WORD), 'the page lost its word flag row').toBe(true);
    expect(page.includes(FLAG_HELP), 'the page lost its help flag row').toBe(true);
    expect(page.includes(OWNER_ROW), 'the page lost its owner caller row').toBe(true);
    expect(page.includes(NO_TERMINAL_ROW), 'the page lost its no-terminal caller row').toBe(true);
    expect(page.includes(SEAT_ROW), 'the page lost its seat caller row').toBe(true);
    expect(page.includes(OUTPUT_WORD), 'the page lost its word output row').toBe(true);
    expect(page.includes(OUTPUT_BAD), 'the page lost its bad-word output row and exit').toBe(true);
    expect(page.includes(EXAMPLE_TAKES_EFFECT), 'the page\'s one example lost its approval line').toBe(true);
  });

  test('the three runs moved whole: verbatim in the note, gone from the page, each message in the line that prints it', () => {
    const internal = prose(INTERNAL);
    expect(internal.includes(RUN_SAME_INTRO), 'the note lost the same-word introduction').toBe(true);
    expect(internal.includes(RUN_SAME_BODY), 'the note lost the same-word run').toBe(true);
    expect(internal.includes(RUN_BAD_INTRO), 'the note lost the bad-word introduction').toBe(true);
    expect(internal.includes(RUN_BAD_BODY), 'the note lost the bad-word run').toBe(true);
    expect(internal.includes(RUN_SEAT_INTRO), 'the note lost the seat introduction').toBe(true);
    expect(internal.includes(RUN_SEAT_BODY), 'the note lost the seat run').toBe(true);
    const page = prose(PAGE);
    for (const gone of [RUN_SAME_INTRO, RUN_BAD_INTRO, RUN_SEAT_INTRO, '"faster"', 'unplaced']) {
      expect(page.includes(gone), `the page still carries a moved run: "${gone}"`).toBe(false);
    }
    const src = raw(SRC);
    expect(src.includes(SRC_WORDS), 'tempo.ts lost its word list').toBe(true);
    expect(src.includes(SRC_BAD), 'tempo.ts lost the bad-word template').toBe(true);
    expect(src.includes(SRC_OWNER), 'tempo.ts lost the owner refusal template').toBe(true);
    expect(src.includes(SRC_WORD_LINE), 'tempo.ts lost the word line').toBe(true);
    expect(src.includes(SRC_USAGE), 'tempo.ts lost its usage line').toBe(true);
  });

  test('the read-and-write rules moved, each named in the line of setTempo that does it', () => {
    expect(prose(INTERNAL).includes(RW_PARAGRAPH), 'the note lost the read-and-write paragraph').toBe(true);
    expect(prose(PAGE).includes('Writes one line'), 'the page still carries the moved paragraph').toBe(false);
    const src = raw(SRC);
    expect(src.includes(SRC_FIND_TEMPO), 'setTempo no longer finds the tempo line').toBe(true);
    expect(src.includes(SRC_SAME_WORD), 'setTempo no longer leaves a same word untouched').toBe(true);
    expect(src.includes(SRC_FIND_FORMAT), 'setTempo no longer finds the format line').toBe(true);
    expect(src.includes(SRC_SPLICE), 'setTempo no longer splices the missing key in after format:').toBe(true);
  });
});
