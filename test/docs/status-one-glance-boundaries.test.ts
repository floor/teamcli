// The one-glance cut of the status page. The row paragraphs stay on the page under their own
// heading; the budgets example — the account the yaml named, the state's readings, the table
// rows they render, the JSON document and the swap note — moves whole to docs/internal/status.md,
// and the page keeps one shorter example. These pins hold the pointer and the page's own account
// of what moved, hold the row paragraphs to the heading that now carries them, hold the moved
// example to the exact rows it quotes and those rows to the templates that print them, and hold
// the shortened example to what the page says it is: the same team file without the budgets
// account, the implementer up, and the one difference.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const PAGE = '../../docs/commands/status.md';
const INTERNAL = '../../docs/internal/status.md';
const TABLE_SRC = '../../src/budgets/table.ts';
const MACHINE_SRC = '../../src/watch/machine.ts';

// The cut page's closing pointer — it gains the budgets — and the two accounts of what moved.
const POINTER =
  'Rationale, behaviour, the budgets, refusals and known limits: [docs/internal/status.md](../internal/status.md).';
const MOVED_SENTENCE =
  'The `budgets:` table the file\'s accounts would add, the `--json` document, the swap note and the readings that follow the repair stand on the internal page:';
const INTERNAL_MOVED =
  'What moved off [the `team status` page](../commands/status.md): what the run reads and writes, who may read the team and what every other caller gets, the rows and what each state says, the budgets table, the differences and their repairs, the JSON behind `--json`, the refusals in their own words, and the known limits.';
const INTERNAL_STAYED = 'The synopsis, the flags, the caller table and the exit codes stay on the page.';
const MOVED_EXAMPLES =
  'The examples below stood on [the `team status` page](../commands/status.md) before its one-glance cut, in the order they stood in, and they stand there no longer: the page carries one shorter example now — the same team file without the `budgets:` account, the implementer up, and the one difference. None of the examples here is executed by any test — `test/docs.test.ts` reads `docs/commands/` alone.';
const HEADINGS = [
  '# `team status`: rationale and known limits',
  '## What the run does: one seat per line, one difference per disagreement',
  '## What it reads and writes',
  '## Who may run it',
  '## Rows',
  '## Budgets',
  '## Differences',
  '## The JSON',
  '## Refusals',
  '## Examples, moved here whole',
];

// The row paragraphs stayed on the page, gathered under a heading of their own between the
// caller table and the output table.
const ROWS_HEADING = '## What a row says';
const ROW_PARAGRAPH_ONE =
  'Otherwise a pane with no CLI left reads `missing` (the CLI ended, or a restore left the shell in front) and a pane fronted by any other program reads `restored, not launched by team`; both carry a difference, and the second\'s model is `-`, never the file\'s.';
const ROW_PARAGRAPH_TWO = 'Nothing either report says starts a seat.';
const BEFORE_HEADING = '## Who may run it';
const AFTER_HEADING = '## Output and exit codes';

// The moved example's load-bearing rows: the account the yaml named, the three rendered rows,
// the JSON keys the document carries, and the swap note.
const MOVED_YAML_CHECK = 'check: examples/checks/codex-quota';
const MOVED_ROW_SESSION = 'openai session left 40% used 60% resets in 44m - read 2m ago check fresh';
const MOVED_ROW_DAILY =
  'openai daily left 70% used 30% resets unknown claude-beacon last seen 40m ago status line (fallback) stale';
const MOVED_ROW_WEEKLY =
  'openai weekly left 5% used 95% resets in 44m claude-beacon changed 2m ago status line (fallback) fresh, inside reserve 20%';
const MOVED_JSON_FALLBACK = '"fallback": true';
const MOVED_JSON_INSIDE = '"inside": true';
const MOVED_SWAP_NOTE =
  'note: the machine check asks for 2.0 GB free swap; at this reading the machine has 1.0 GB in total, so `team up` would refuse now; set `machine.swap_free_min` to a figure this machine can keep, then run `team approve`';

// The shortened example the page keeps: the same file without the budgets account, the
// implementer up, the one difference, exit 1.
const KEPT_DIFFERENCE = 'difference: claude-keeper is in the file and is not running';
const KEPT_REPAIR = 'repair: team add claude-keeper';
const KEPT_COUNT = '1 difference(s)';
const KEPT_EXIT = 'exit 1';
const KEPT_FIXTURE = 'agents: [claude-beacon]';

// The lines that render those rows: the budget line's shape, the fallback and inside-reserve
// endings, the reset and the when-word the stale and check rows take, and the swap note.
const SRC_LINE_SHAPE = 'left ${row.left}%  used ${row.used}%';
const SRC_FALLBACK = 'const source = row.fallback ? `${from} (fallback)` : from;';
const SRC_INSIDE =
  'const state = row.inside && row.reserve !== null ? `${row.state}, inside reserve ${row.reserve}%` : row.state;';
const SRC_RESET = "const reset = row.resetsIn === null ? 'resets unknown' : `resets in ${row.resetsIn}`;";
const SRC_WHEN =
  "return row.state === 'stale' && row.resetsIn === null ? 'last seen' : row.source === 'check' ? 'read' : 'changed';";
const SRC_SEAT = '${row.seat ?? \'-\'}';
// The swap note's template escapes its own backticks; the pin runs to the first escape and
// carries on past it with the note's fixed ending.
const SRC_SWAP_NOTE =
  'the machine check asks for ${gb(limits.swapFreeMin)} free swap; at this reading the machine has ${gb(machine.swapTotal)} in total, so ';
const SRC_SWAP_NOTE_END = ' would refuse now; set ';

function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('the one-glance cut of the status page', () => {
  test('the pointer gains the budgets, and both notes say what moved and what stayed', () => {
    expect(prose(PAGE).includes(POINTER), 'the page lost its long-read pointer naming the budgets').toBe(true);
    expect(prose(PAGE).includes(MOVED_SENTENCE), 'the page lost its account of what stands on the internal page').toBe(true);
    const internal = prose(INTERNAL);
    expect(internal.includes(INTERNAL_MOVED), 'the internal note lost its account of what moved off the page').toBe(true);
    expect(internal.includes(INTERNAL_STAYED), 'the internal note lost its account of what stayed on the page').toBe(true);
    expect(internal.includes(MOVED_EXAMPLES), 'the internal note lost its account of the moved examples').toBe(true);
    for (const heading of HEADINGS) {
      expect(internal.includes(heading), `the internal note lost "${heading}"`).toBe(true);
    }
  });

  test('the row paragraphs stay on the page, under a heading between the caller table and the output table', () => {
    const page = prose(PAGE);
    expect(page.includes(ROWS_HEADING), 'the page lost its row heading').toBe(true);
    expect(page.includes(ROW_PARAGRAPH_ONE), 'the page lost the missing/restored row paragraph').toBe(true);
    expect(page.includes(ROW_PARAGRAPH_TWO), 'the page lost the nothing-starts-a-seat sentence').toBe(true);
    expect(
      page.indexOf(BEFORE_HEADING) < page.indexOf(ROWS_HEADING) && page.indexOf(ROWS_HEADING) < page.indexOf(AFTER_HEADING),
      'the row heading no longer stands between the caller table and the output table',
    ).toBe(true);
  });

  test('the budgets example moved whole: its rows stand in the internal note and no longer on the page', () => {
    const internal = prose(INTERNAL);
    expect(internal.includes(MOVED_YAML_CHECK), 'the internal note lost the account\'s check line').toBe(true);
    expect(internal.includes(MOVED_ROW_SESSION), 'the internal note lost the session row').toBe(true);
    expect(internal.includes(MOVED_ROW_DAILY), 'the internal note lost the daily row').toBe(true);
    expect(internal.includes(MOVED_ROW_WEEKLY), 'the internal note lost the weekly row').toBe(true);
    expect(internal.includes(MOVED_JSON_FALLBACK), 'the internal note lost the JSON document\'s fallback key').toBe(true);
    expect(internal.includes(MOVED_JSON_INSIDE), 'the internal note lost the JSON document\'s inside key').toBe(true);
    expect(internal.includes(MOVED_SWAP_NOTE), 'the internal note lost the swap note').toBe(true);
    const page = prose(PAGE);
    for (const gone of [MOVED_YAML_CHECK, MOVED_ROW_DAILY, MOVED_ROW_WEEKLY, MOVED_JSON_FALLBACK, MOVED_SWAP_NOTE]) {
      expect(page.includes(gone), `the page still carries a moved row: "${gone.slice(0, 40)}…"`).toBe(false);
    }
  });

  test('the moved rows and the swap note quote templates the source really prints', () => {
    const table = raw(TABLE_SRC);
    expect(table.includes(SRC_LINE_SHAPE), 'the budget line lost its left/used shape').toBe(true);
    expect(table.includes(SRC_FALLBACK), 'table.ts lost the fallback ending').toBe(true);
    expect(table.includes(SRC_INSIDE), 'table.ts lost the inside-reserve ending').toBe(true);
    expect(table.includes(SRC_RESET), 'table.ts lost the resets-unknown/resets-in template').toBe(true);
    expect(table.includes(SRC_WHEN), 'table.ts lost the when-word rule the daily and check rows take').toBe(true);
    expect(table.includes(SRC_SEAT), 'the budget line lost its seat dash').toBe(true);
    expect(raw(MACHINE_SRC).includes(SRC_SWAP_NOTE), 'machine.ts lost the swap note template').toBe(true);
    expect(raw(MACHINE_SRC).includes(SRC_SWAP_NOTE_END), 'machine.ts lost the swap note\'s fixed ending').toBe(true);
  });

  test('the shortened example is the one the page describes: no budgets account, the implementer up, one difference', () => {
    const page = prose(PAGE);
    expect(page.includes(KEPT_FIXTURE), 'the page\'s fixture lost its one agent').toBe(true);
    expect(page.includes(KEPT_DIFFERENCE), 'the page\'s console lost its difference line').toBe(true);
    expect(page.includes(KEPT_REPAIR), 'the page\'s console lost its repair line').toBe(true);
    expect(page.includes(KEPT_COUNT), 'the page\'s console lost its count').toBe(true);
    expect(page.includes(KEPT_EXIT), 'the page\'s console lost its exit line').toBe(true);
    expect(page.includes('kind: subscription'), 'the page\'s yaml still names a subscription account').toBe(false);
    expect(page.includes('state: budgets:'), 'the page\'s fixture still carries the readings state').toBe(false);
  });
});
