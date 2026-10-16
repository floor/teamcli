// The one-glance cut of the add page. The full delegate and placement rules, the reads-and-writes
// detail, the line-by-line print account, the refusals the page does not carry and the examples it
// does not keep moved to docs/internal/add.md; the page keeps its synopsis, its flags, its caller
// table, the ceilings sentence, the standing refusals, the exit codes and one worked example.
// These pins hold the pointer and both accounts of the cut, hold what stayed to the page as
// written, hold the moved dry-run account to the exit-id comments and templates the source really
// carries, and hold the moved refusal rows and examples to the lines that print them — verbatim
// in the note, gone from the page.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const PAGE = '../../docs/commands/add.md';
const INTERNAL = '../../docs/internal/add.md';
const ADD_SRC = '../../src/commands/add.ts';
const CALLER_SRC = '../../src/caller.ts';
const PRETRUST_SRC = '../../src/launch/pretrust.ts';

// The cut page's closing pointer, and the internal note's own account of the cut.
const POINTER =
  'Rationale, the full delegate and placement rules, what it prints line by line, and every other refusal with its exit: [docs/internal/add.md](../internal/add.md).';
const MOVED =
  'What moved off [the `team add` page](../commands/add.md): the full delegate and placement rules, what it reads and writes in full, what it prints line by line, the refusals the page does not carry, and the examples it does not keep.';
const STAYED =
  'The synopsis, the flags, who may run it, the ceilings sentence, the standing refusals, the exit codes and the worked example stay on the page.';
const HEADINGS = [
  '## Who may run it, in full',
  '## Where the seat starts',
  '## The ends `--until` accepts',
  '## What it prints, line by line',
  '## The refusals the page does not carry',
  '## The examples the page does not keep',
];

// What stayed on the page: the no-terminal refusal inside the caller table, the ceilings sentence,
// the already-running row with its abandon tail, and the worked example's console.
const NO_TERMINAL =
  'a run with no terminal is refused before the file is read: `team add: only the owner runs this, from a terminal outside herdr`';
const CEILINGS_PAGE =
  'The ceilings a run is held to are read from the approval\'s record, never from the file: a seat that would put the session past `limits.seats`, past `limits.temporary` for a temporary seat, or past a `limits.vendors` entry for its vendor, is refused';
const ALREADY_RUNNING =
  '`team add: <name> is already running` — and, for a screen the profile does not recognise, `team remove <name> --abandon closes its workspace without typing`';
const EXAMPLE_ALREADY = 'team add: claude-beacon is already running';
const EXAMPLE_STOPPED = 'claude-beacon: stopped';
const EXAMPLE_STOPPED_SEAT = 'stopped claude-beacon';
const EXAMPLE_LOBBY = 'team add: refused: the lobby is not trusted for claude: run claude in ~/.config/team/lobby and accept the folder';
const EXAMPLE_FIXTURE = 'agents: [claude-beacon]';

// The ceilings sentence as the internal note carries it — first words of its own.
const CEILINGS_INTERNAL = 'The ceilings are read from the approval\'s record, never from the file';

// The moved dry-run account: the paragraph that bounds it, and the exit ids it names. The source
// carries each id as the comment on the refusal it belongs to.
const DRY_RETURNS = 'It returns before these real-run failures, and never takes their status:';
const DRY_IDS = [
  '`add.run-lock`, another run holds the session',
  '`add.changed`, the file changed while add was checking',
  '`add.lobby`, the lobby could not be created',
  '`add.not-ready`, the launch finished without a ready seat; `add.server`, the server did not start',
];
const SRC_IDS = [
  '// exit: add.run-lock',
  '// exit: add.changed',
  '// exit: add.locked',
  '// exit: add.lobby',
  '// exit: add.not-ready',
  '// exit: add.server',
];
const SRC_WOULD_REFUSE = ': would refuse: ${plainText(decision.why)}';
const SRC_DRY_NOTHING = 'dry run: nothing was run';

// The refusal templates the moved rows and the kept rows quote, in the lines that print them.
const ROW_FOR_TEMPORARY = '`team add: --like, --until and --worktree are for --temporary` | 2';
const ROW_UNTIL = '`team add: --until is result:<path> or merged:<branch>` | 1';
const ROW_NO_SEAT = '`team add: the approved file has no seat "<name>"`';
const SRC_FOR_TEMPORARY = "'team add: --like, --until and --worktree are for --temporary\\n'";
const SRC_UNTIL = "return { error: '--until is result:<path> or merged:<branch>' };";
const SRC_NO_SEAT = 'the approved file has no seat ${JSON.stringify(name)}';
const SRC_ABANDON = 'team remove ${who} --abandon closes its workspace without typing';
const SRC_DETACHED = "export const DETACHED_REFUSAL = 'only the owner runs this, from a terminal outside herdr';";
const SRC_LOBBY_GROK = 'the lobby is not trusted for grok: run grok --trust in ${lobby}';
const SRC_LOBBY_CURSOR = 'the lobby is not trusted for cursor: run cursor-agent --trust in ${lobby}';
const SRC_LOBBY_CLAUDE = 'the lobby is not trusted for claude: run claude in ${lobby} and accept the folder';

// The moved examples, verbatim in the note and gone from the page.
const MOVED_NO_PANE = 'team add: no pane is recorded for seat claude-keeper in this session: the owner stops that seat and runs `team up`';
const MOVED_TMP_READY = 'claude-beacon-tmp-1: ready';
const MOVED_HAND_STARTED = 'the hand-started pane is closed, and `team up` starts the seat with a pane of its own';
const MOVED_ABANDON_OTHER =
  'the owner is told `team remove <name> --abandon closes its workspace without typing`, and anyone else is told `the owner runs team remove <name> --abandon, which closes its workspace without typing`';
const PAGE_NEGATIVES = [
  'claude-keeper in this session',
  'claude-beacon-tmp-1',
  'the hand-started pane is closed',
  '--until later',
  'delegation needs a verified approval',
  'inside the protected checkout',
];

function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('the one-glance cut of the add page', () => {
  test('the pointer stands as written, and the note says what moved and what stayed', () => {
    expect(prose(PAGE).includes(POINTER), 'the page lost its long-read pointer').toBe(true);
    const internal = prose(INTERNAL);
    expect(internal.includes(MOVED), 'the note lost its account of what moved off the page').toBe(true);
    expect(internal.includes(STAYED), 'the note lost its account of what stayed on the page').toBe(true);
    for (const heading of HEADINGS) {
      expect(internal.includes(heading), `the note lost "${heading}"`).toBe(true);
    }
  });

  test('what stayed stands on the page as written: the no-terminal rule, the ceilings, the standing rows, the example', () => {
    const page = prose(PAGE);
    expect(page.includes(NO_TERMINAL), 'the page lost its no-terminal refusal').toBe(true);
    expect(page.includes(CEILINGS_PAGE), 'the page lost its ceilings sentence').toBe(true);
    expect(page.includes(ALREADY_RUNNING), 'the page lost its already-running row with the abandon tail').toBe(true);
    expect(page.includes(EXAMPLE_ALREADY), 'the example lost its already-running run').toBe(true);
    expect(page.includes(EXAMPLE_STOPPED), 'the example lost its stopped line').toBe(true);
    expect(page.includes(EXAMPLE_STOPPED_SEAT), 'the example lost its stopped-seat record').toBe(true);
    expect(page.includes(EXAMPLE_LOBBY), 'the example lost its lobby refusal').toBe(true);
    expect(page.includes(EXAMPLE_FIXTURE), 'the example lost its one-running-agent fixture').toBe(true);
    expect(prose(INTERNAL).includes(CEILINGS_INTERNAL), 'the note lost its own ceilings wording').toBe(true);
  });

  test('the dry-run account moved: its bounds and exit ids in the note, the ids and templates in the source', () => {
    const internal = prose(INTERNAL);
    expect(internal.includes(DRY_RETURNS), 'the note lost its never-takes-their-status bound').toBe(true);
    for (const id of DRY_IDS) {
      expect(internal.includes(id), `the note lost its exit-id bullet: "${id.slice(0, 40)}…"`).toBe(true);
    }
    const src = raw(ADD_SRC);
    for (const id of SRC_IDS) {
      expect(src.includes(id), `add.ts lost its exit-id comment "${id}"`).toBe(true);
    }
    expect(src.includes(SRC_WOULD_REFUSE), 'add.ts lost its would-refuse template').toBe(true);
    expect(src.includes(SRC_DRY_NOTHING), 'add.ts lost its dry-run-nothing line').toBe(true);
  });

  test('the refusal rows quote templates the source really prints', () => {
    const internal = prose(INTERNAL);
    expect(internal.includes(ROW_FOR_TEMPORARY), 'the note lost its for-temporary row').toBe(true);
    expect(internal.includes(ROW_UNTIL), 'the note lost its until row').toBe(true);
    expect(prose(PAGE).includes(ROW_NO_SEAT), 'the page lost its no-seat row').toBe(true);
    const src = raw(ADD_SRC);
    expect(src.includes(SRC_FOR_TEMPORARY), 'add.ts lost its for-temporary line').toBe(true);
    expect(src.includes(SRC_UNTIL), 'add.ts lost its until line').toBe(true);
    expect(src.includes(SRC_NO_SEAT), 'add.ts lost its no-seat template').toBe(true);
    expect(src.includes(SRC_ABANDON), 'add.ts lost its abandon template').toBe(true);
    expect(raw(CALLER_SRC).includes(SRC_DETACHED), 'caller.ts lost its detached-refusal constant').toBe(true);
    const pretrust = raw(PRETRUST_SRC);
    expect(pretrust.includes(SRC_LOBBY_GROK), 'pretrust.ts lost its grok line').toBe(true);
    expect(pretrust.includes(SRC_LOBBY_CURSOR), 'pretrust.ts lost its cursor line').toBe(true);
    expect(pretrust.includes(SRC_LOBBY_CLAUDE), 'pretrust.ts lost its claude line').toBe(true);
  });

  test('the moved examples stand in the note and no longer on the page', () => {
    const internal = prose(INTERNAL);
    expect(internal.includes(MOVED_NO_PANE), 'the note lost its no-pane-recorded example').toBe(true);
    expect(internal.includes(MOVED_TMP_READY), 'the note lost its temporary-seat example').toBe(true);
    expect(internal.includes(MOVED_HAND_STARTED), 'the note lost its hand-started-pane rule').toBe(true);
    expect(internal.includes(MOVED_ABANDON_OTHER), 'the note lost its anyone-else abandon rule').toBe(true);
    const page = prose(PAGE);
    for (const gone of PAGE_NEGATIVES) {
      expect(page.includes(gone), `the page still carries a moved example or refusal: "${gone}"`).toBe(false);
    }
  });
});
