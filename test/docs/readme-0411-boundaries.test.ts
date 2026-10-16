// The README rewritten for an approval-less build. The command list drops `approve` from its
// enumeration, the walkthrough says nothing is recorded between the edit and the run, and a
// section of its own says `team approve` is not part of this build — while the word stays one a
// `delegates` entry or a `grant` scope may carry, read like any other. These pins hold every
// one of those sentences as written, hold the word's survival to the two lists that still
// carry it, and hold the dispatch — the unknown-command line — to a run: `team approve` with no
// file anywhere answers `unknown command`, exit 2. The harness page's generalized answer and
// waiting rows are held to the line that maps them.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { main } from '../../src/cli.ts';
import { testIo } from '../helpers.ts';

const README = '../../README.md';
const COMMANDS_README = '../../docs/commands/README.md';
const CLI_SRC = '../../src/cli.ts';
const DELEGATE_SRC = '../../src/delegate-types.ts';
const TYPES_SRC = '../../src/file/types.ts';
const RUN_SRC = './run.ts';

// The approval-record section, in the words the rewrite left it in.
const NOT_PART =
  '`team approve` is not part of this build: nothing records an approval, and `up`, `add`, `remove` and `down` run with no record at all, reading `.agents/team.yaml` as it is on disk.';
const STILL_VERIFIED =
  'A record an earlier build wrote is still verified where a command reads one: `up` refuses to start from a file that has drifted from a record in force, and the delegate gate is consulted only when one is in force.';
const NOT_APPROVAL =
  'A record changed after it was signed, signed for another root, or replayed from an older number is not an approval, and the command says which case it found.';
const UNSIGNED =
  'A record written by an earlier `team`, before records were signed, is not an approval in force: `up`, `add`, `remove` and `down` refuse it.';
const SECTION = '## The approval record';

// Where the word is gone: the status enumeration, the walkthrough, the fresh-file paragraph,
// the delegates description and the up row.
const ENUMERATION =
  'validates the file, checks who is calling, and holds `add`, `answer`, `check`, `doctor`, `down`, `init`, `list`, `release`, `remove`, `status`, `up`, `watch` and `worktree`.';
const WALKTHROUGH = 'Nothing is recorded between the edit and the run: `up` reads the file as it is.';
const FRESH_FILE =
  'A file you receive from someone else is read as it is — no step records it first — and `up` starts its seats only from the owner\'s terminal, or from a seat the file\'s `grant` names.';
const DELEGATES =
  'names panes — `<herdr session>/<pane id>` — and, per pane, which of `up`, `down`, `add` and `remove` it may run.';
const UP_ROW =
  '`up`: the owner at a terminal outside herdr, or the seat the file\'s `grant` names for `up` (anyone else is told `deny`); `down`: the owner, the coordinator or the operator seat';

// Where the word survives: the README's own sentence, and the two lists that still carry it.
const WORD_CARRIED =
  '`approve` is still a word a `delegates` entry or a `grant` scope may carry — a file that names it is read like any other — and no command in this build consults it.';
const SRC_DELEGATE_TYPE = "export type DelegateCommand = 'up' | 'down' | 'add' | 'remove' | 'approve';";
const SRC_DELEGATE_LIST = "export const DELEGATE_COMMANDS: readonly DelegateCommand[] = ['up', 'down', 'add', 'remove', 'approve'];";
const SRC_GRANT_SCOPES = "export const GRANT_SCOPES = ['up', 'down', 'approve', 'init', 'reload'] as const;";

// The dispatch an `approve` invocation really meets: no key in the command table, so the
// unknown-command refusal with the help text, exit 2.
const SRC_UNKNOWN = 'io.stderr(`team: unknown command "${name}"\\n\\n${helpText()}`);';
const SRC_UNKNOWN_EXIT = 'return 2; // exit: team.unknown';
const RUN_UNKNOWN = 'team: unknown command "approve"';

// The harness rows the attributes work generalized, and the line that maps waiting's values.
const ANSWER_ROW = '| `answer="<text>"` | what the terminal types back at the owner\'s prompt in this block |';
const WAITING_ROW =
  '| `waiting="1"` | the terminal has a line of input already waiting when the block\'s command asks, for this block (`waiting="unreadable"`: a terminal the check cannot read) |';
const SRC_WAITING = "block.attrs.waiting === '1' ? 'waiting' : block.attrs.waiting === 'unreadable' ? 'unreadable' : 'empty';";

function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('the README of the approval-less build', () => {
  test('the approval-record section stands as written, and the word is gone from its table', () => {
    const page = prose(README);
    expect(page.includes(NOT_PART), 'the README lost its not-part-of-this-build sentence').toBe(true);
    expect(page.includes(STILL_VERIFIED), 'the README lost its old-records-still-verified sentence').toBe(true);
    expect(page.includes(NOT_APPROVAL), 'the README lost its changed-or-replayed sentence').toBe(true);
    expect(page.includes(UNSIGNED), 'the README lost its unsigned-record sentence').toBe(true);
    expect(page.includes(SECTION), 'the README lost its approval-record heading').toBe(true);
    expect(page.includes('| `team approve` |'), 'the README still carries a team approve row').toBe(false);
    expect(page.includes('`answer`, `approve`, `check`'), 'the enumeration still lists approve').toBe(false);
  });

  test('the enumeration, the walkthrough, the fresh-file paragraph and the up row drop the word', () => {
    const page = prose(README);
    expect(page.includes(ENUMERATION), 'the README lost its command enumeration').toBe(true);
    expect(page.includes(WALKTHROUGH), 'the README lost its nothing-is-recorded sentence').toBe(true);
    expect(page.includes(FRESH_FILE), 'the README lost its fresh-file sentence').toBe(true);
    expect(page.includes(DELEGATES), 'the README lost its delegates description').toBe(true);
    expect(page.includes(UP_ROW), 'the README lost its up row with the deny ending').toBe(true);
  });

  test('the word survives in the README\'s own words and in both lists that still carry it', () => {
    expect(prose(README).includes(WORD_CARRIED), 'the README lost its word-still-carried sentence').toBe(true);
    const delegates = raw(DELEGATE_SRC);
    expect(delegates.includes(SRC_DELEGATE_TYPE), 'delegate-types.ts dropped approve from the type').toBe(true);
    expect(delegates.includes(SRC_DELEGATE_LIST), 'delegate-types.ts dropped approve from the list').toBe(true);
    expect(raw(TYPES_SRC).includes(SRC_GRANT_SCOPES), 'file/types.ts dropped approve from the grant scopes').toBe(true);
    expect(raw(CLI_SRC).includes(SRC_UNKNOWN), 'cli.ts lost its unknown-command refusal').toBe(true);
    expect(raw(CLI_SRC).includes(SRC_UNKNOWN_EXIT), 'cli.ts lost the unknown-command exit').toBe(true);
  });

  test('an approve invocation meets the unknown-command refusal, and the help names no approve', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readme-approve-'));
    try {
      const io = testIo(dir, { kind: 'owner' });
      const exit = await main(['approve'], io);
      expect(exit).toBe(2);
      expect(io.err).toContain(RUN_UNKNOWN);
      // The same refusal carries the help text: it lists the table's real commands and none
      // named approve.
      expect(io.err).toContain('\n  up\n');
      expect(io.err).not.toContain('\n  approve\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the harness answer and waiting rows stand as written, and the line that maps them', () => {
    const page = prose(COMMANDS_README);
    expect(page.includes(ANSWER_ROW), 'the harness page lost its answer row').toBe(true);
    expect(page.includes(WAITING_ROW), 'the harness page lost its waiting row with the unreadable variant').toBe(true);
    expect(raw(RUN_SRC).includes(SRC_WAITING), 'run.ts lost its waiting-value mapping').toBe(true);
  });
});
