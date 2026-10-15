// The up pages now read the granted seat's admission from the file: `the file's grant`, not
// `the approved grant`. The two voices are both true, and these pins hold each to its page and
// both to the code that keeps them the same sentence: whether the gate is asked at all is read
// from the live file — no grant section, no gate — and what the gate then trusts is the
// approved copy, so a grant edited in the live file and not yet signed authorises nothing.
// In every run that passes, the file's grant and the approved one are the same words.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const PAGE = '../../docs/commands/up.md';
const TEAM_FILE = '../../docs/team-file.md';
const GRANT_SRC = '../../src/grant.ts';
const UP_SRC = '../../src/commands/up.ts';

// Whitespace runs collapse before the match, so a sentence survives line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe("the granted seat's admission is read from the file", () => {
  test("the up page's admission table names the file's grant, twice over", () => {
    const page = prose(PAGE);
    expect(
      page.includes("the orchestrator's seat, when the file's `grant` lists `up` | run it on this folder's own team file. The run does not relaunch or close that seat."),
      'up.md lost the grant row\'s file voice',
    ).toBe(true);
    expect(
      page.includes("unless the file's `grant` admits the orchestrator's seat or the file's `delegates` section names that pane with `up` in its entry's `commands`"),
      'up.md lost the seat row\'s file voice',
    ).toBe(true);
  });

  test("the team-file page carries the same voice, and keeps the approve sentence in the approved one", () => {
    const page = prose(TEAM_FILE);
    expect(
      page.includes("`team up` admits the orchestrator's seat when the file's `grant` lists `up`. The run is this folder's own file: `--session` and `--file` are refused"),
      'team-file.md lost the up sentence\'s file voice',
    ).toBe(true);
    expect(
      page.includes('A file that omits `grant` keeps'),
      'team-file.md lost the omitted-grant sentence',
    ).toBe(true);
    // `approve` keeps the approved voice on the same page — deliberate, and true the same way:
    // the gate that approve asks trusts the approved copy too, and refuses a live edit of
    // `grant` because `grant` is not an ordinary section. Both voices name one gate.
    expect(
      page.includes("admits the orchestrator's seat for that class when the approved grant lists `approve`"),
      'team-file.md lost the approve sentence\'s approved voice',
    ).toBe(true);
  });

  test('the code keeps the two voices the same sentence: the live file is asked, the approved copy is trusted', () => {
    // The half the pages state: whether the gate is asked at all is read from the live file.
    expect(
      raw(UP_SRC).includes('const grantTeam = defaultLoad !== null && defaultLoad.ok && defaultLoad.team.grant !== null ? defaultLoad : null;'),
      'up.ts no longer asks the grant gate from the live load',
    ).toBe(true);
    // The half that keeps it honest: what the gate trusts is the approved copy's grant, and a
    // grant edited in the live file and not yet signed authorises nothing — the drift refusal,
    // so no unsigned edit can hide behind the file-voice sentence.
    expect(raw(GRANT_SRC).includes("The grant it trusts is the approved copy's"), 'grant.ts lost its source-of-truth line').toBe(true);
    expect(
      raw(GRANT_SRC).includes('grant edited in the live file and not yet signed authorises nothing'),
      'grant.ts lost the unsigned-edit line',
    ).toBe(true);
    expect(
      raw(GRANT_SRC).includes('a grant needs the approved file: the file is not the approved one ('),
      'grant.ts lost the drift sentence',
    ).toBe(true);
  });
});
