// SECURITY.md at its boundaries. No suite reads this file — docs.test.ts walks docs/commands/
// alone — so the page's operative parts had no guard at all: the private-report link, the scope
// list that says what a report may be about, and the not-a-weakness framing that keeps the scope
// honest. These pins hold them as written.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const PAGE = '../../SECURITY.md';

// The one private channel, as a literal: the page's link must be this repository's own advisory
// form, not a generic GitHub URL and not another repository's.
const ADVISORY_LINK = 'https://github.com/floor/teamcli/security/advisories/new';

// The scope list, as written: what a run of the command does in a project, named surface by
// surface. A scope edit that drops a surface (the drop files, the sockets) softens the page's
// promise about what may be reported.
const SCOPE =
  'Everything this repository ships — the `team` command, its schema and its examples — and what a run of it does in a project: the team file and the grants it holds, the caller gate that reads them, the message files and drop files it writes, the local sockets it binds, and the behaviour its own documentation states.';

// The framing that keeps the scope honest: the tool guards against mistakes, not against a
// hostile program — the same limit the approve page and the README state for approvals, in this
// page's own words.
const NOT_A_WEAKNESS =
  "TeamCLI protects against an agent's mistake, not against a hostile program running as you: agents run as your user, and what you can read on your machine, they can read.";

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

describe('the security page', () => {
  test('the private-report link is this repository’s own advisory form', () => {
    const page = prose(PAGE);
    expect(page.includes(ADVISORY_LINK), 'SECURITY.md lost or changed the direct advisory link').toBe(true);
  });

  test('the in-scope section stands, with its surfaces enumerated as written', () => {
    const page = prose(PAGE);
    expect(page.includes('## What is in scope'), 'SECURITY.md lost the in-scope heading').toBe(true);
    expect(page.includes(SCOPE), 'SECURITY.md softened or dropped the scope list').toBe(true);
    // The scope section is a promise about this tool's own behaviour, so it stands beside the
    // page's limit: what is not a weakness is stated in the same breath, as written.
    expect(page.includes(NOT_A_WEAKNESS), 'SECURITY.md lost the not-a-weakness framing').toBe(true);
  });
});
