// The two pages' new reading of a machine with no approval record, held to the pages and to the
// gates that changed. Since the gates let a `none` standing through, `add` and `remove` no longer
// refuse a never-approved machine — the live file stands in for the approved copy — and their
// pages say so while the dead refusal rows are gone. Each sentence is pinned verbatim, each dead
// row pinned gone, and the gates' own guard cross-checked, so the pages and the gates cannot
// drift apart unnoticed. `up` still refuses a never-approved machine; only these two pages drop
// the row.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const ADD_PAGE = '../../docs/commands/add.md';
const REMOVE_PAGE = '../../docs/internal/remove.md';
const ADD_SRC = '../../src/commands/add.ts';
const REMOVE_SRC = '../../src/commands/remove.ts';
const APPROVAL_SRC = '../../src/approve/approval.ts';

// The sentence only the `none` standing prints, and the standing these two gates skip.
const NEVER_APPROVED = 'the file was never approved on this machine: run `team approve`';

describe('no approval record means the live file', () => {
  test('both pages state the stand-in, verbatim', () => {
    expect(prose(ADD_PAGE)).toContain(
      'A machine with no approval record at all is the one case without an approved copy: the live file stands in for it, ceilings included.',
    );
    expect(prose(REMOVE_PAGE)).toContain(
      'A record that is not in force — one written before records were signed, or one the verification refused — stops the run before anything is stopped or written, with the one-line repair every command prints. A machine with no record at all is not that case: the live file stands in for the approved copy, and the run goes ahead.',
    );
  });

  test('the dead refusal rows are gone from both pages', () => {
    // The row each table carried for the never-approved refusal: neither command can print it
    // any more, so neither page may keep it. `up`'s page is not pinned here — up still refuses.
    expect(prose(ADD_PAGE)).not.toContain(NEVER_APPROVED);
    expect(prose(REMOVE_PAGE)).not.toContain(NEVER_APPROVED);
  });

  test("the gates let none through, and the stand-in is the live file's own ceilings", () => {
    // Both guards: verified or none pass, legacy and refused still stop the run — which is the
    // pages' "a record that is not in force ... stops the run" and "no record at all ... goes
    // ahead" in one line each.
    expect(prose(ADD_SRC)).toContain("standing.kind !== 'verified' && standing.kind !== 'none'");
    expect(prose(REMOVE_SRC)).toContain("standing.kind !== 'verified' && standing.kind !== 'none'");
    // The stand-in add reads: the live file's text, its team, and its ceilings — "ceilings
    // included" is this ceilingsOf, on the file just read, not an approved copy.
    const add = prose(ADD_SRC);
    expect(add).toContain('A missing record is the live file. A legacy or refused record is still not in force.');
    expect(add).toContain('ceilings = ceilingsOf(team);');
    // The sentence the pages dropped is `none`'s only case, still built for the standings that
    // stop the run — pinned here so it stays exactly the sentence the rows named.
    expect(prose(APPROVAL_SRC)).toContain(
      "if (standing.kind === 'none') return 'the file was never approved on this machine: run `team approve`';",
    );
  });
});
