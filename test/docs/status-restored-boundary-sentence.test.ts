// The status page's restored-pane section, word for word: when a pane that dropped the launched
// process is the seat again, what `missing` and `restored, not launched by team` mean, the
// launcher difference that stands even then, the repair forms, and the rule that nothing either
// report says starts a seat. The two lines the page quotes are the code's own strings — they are
// built in src/status/compare.ts and src/watch/checks/restored.ts — so each is pinned on the page
// and pinned to the source, and neither can drift from the other unnoticed.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const PAGE = '../../docs/commands/status.md';
const COMPARE = '../../src/status/compare.ts';
const RESTORED = '../../src/watch/checks/restored.ts';

const LAUNCHER_LINE = 'its launch line starts a launcher, and the process in its pane is not the one team launched';

describe('the status page restored-pane sentences', () => {
  test('the pane-again rule stands, verbatim, as the section opens', () => {
    expect(prose(PAGE)).toContain(
      'A pane that no longer holds the process `team` launched is not by itself a difference: when a program `team` did not launch is in front and the agent session the seat\'s records bind — its registry record where one exists, the copy stored with its launch where none does — is the session the pane reports now — a herdr restart brings the pane back under a new shell pid — the row is the ordinary one.',
    );
    // The proof is the registry's own binding, refused rather than overruled: both sentences are
    // on the page, and the source reads the binding through the one shared helper.
    expect(prose(PAGE)).toContain(
      'The two records must agree: a record for another team, seat, CLI or herdr session, or a state naming another session than the record, binds nothing, and a state\'s copy never overrules a record it disagrees with.',
    );
    expect(prose(COMPARE)).toContain('continuitySessionOf(continuityIds, declared.name, recorded?.agent_session)');
  });

  test('the two states and the model rule stand, verbatim', () => {
    expect(prose(PAGE)).toContain(
      'a pane with no CLI left reads `missing` (the CLI ended, or a restore left the shell in front) and a pane fronted by any other program reads `restored, not launched by team`; both carry a difference, and the second\'s model is `-`, never the file\'s.',
    );
    // The two states are the code's own row states, in the file that builds them.
    const compare = prose(COMPARE);
    expect(compare).toContain("state: 'restored, not launched by team'");
    expect(compare).toContain("verdict === 'gone' ? 'missing' : 'restored, not launched by team'");
  });

  test('the launcher difference is quoted in the code\'s own words, in both places that build it', () => {
    expect(prose(PAGE)).toContain(
      `\`<seat>: ${LAUNCHER_LINE}\``,
    );
    expect(prose(COMPARE)).toContain(LAUNCHER_LINE);
    expect(prose(RESTORED)).toContain(LAUNCHER_LINE);
  });

  test('the repair forms and the no-start rule stand, verbatim', () => {
    const page = prose(PAGE);
    expect(page).toContain(
      'repaired the same way — `team restart <seat> --abandon` for a seat that is not a lead while herdr still names that seat on the pane the state recorded, `look at the pane` where it does not, and, for a lead\'s own seat, a note naming what the pane runs and no difference at all',
    );
    expect(page).toContain(
      'The flag is named in the repair, never assumed: a plain restart only leaves that pane as it is, and `--abandon` is what takes the process in front.',
    );
    expect(page).toContain('a pane it can say nothing about is repaired by looking at it.');
    expect(page).toContain('Nothing either report says starts a seat.');
  });
});
