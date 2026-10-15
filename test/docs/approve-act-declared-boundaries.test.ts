// The `approve` act's bullet on the team-file page, held to the page and to both halves of its
// claim. `approve` is declared — the scope set still names it, so a file that lists it parses
// like any other — but no command in this build consults it: the grant gate's live callers pass
// `up` and `down`, and the one caller that passes `approve` is the module the CLI's registry no
// longer reaches. The rewritten bullet is pinned verbatim, the deleted command's admissions
// pinned gone, and each half pinned to the line that carries it.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const TEAM_FILE_PAGE = '../../docs/team-file.md';
const TYPES_SRC = '../../src/file/types.ts';
const GRANT_SRC = '../../src/file/sections/grant.ts';
const UP_SRC = '../../src/commands/up.ts';
const DOWN_SRC = '../../src/commands/down.ts';
const APPROVE_SRC = '../../src/approve/command.ts';
const CLI_SRC = '../../src/cli.ts';

describe("the grant scope's approve act, declared but not consulted", () => {
  test('the rewritten bullet, verbatim', () => {
    expect(prose(TEAM_FILE_PAGE)).toContain(
      '`approve` in `scope` still parses — a file that names it is read like any other — and no command in this build consults it. A change to `grant` itself, and a change to any other owner section, stays the owner\'s to approve. A roster edit that moves the derived ceiling — a file that declares no `limits` — stays the owner\'s too.',
    );
  });

  test('the deleted command\'s admissions are gone from the page', () => {
    // The old bullet handed two claims to `team approve`: the admission of the orchestrator's
    // seat for the approve class, and the first-approval rule. Both went with the command.
    expect(prose(TEAM_FILE_PAGE)).not.toContain('admits the orchestrator\'s seat for that class when the approved grant lists `approve`');
    expect(prose(TEAM_FILE_PAGE)).not.toContain('the first approval of a team stays');
  });

  test('declared: the set still names approve, and the page keeps its three refusals', () => {
    expect(prose(TYPES_SRC)).toContain("export const GRANT_SCOPES = ['up', 'down', 'approve', 'init'] as const;");
    const grant = prose(GRANT_SRC);
    expect(grant).toContain('const NAMES = GRANT_SCOPES.join(\', \');');
    // The three messages the page quotes, as the templates that print them.
    expect(grant).toContain('`grant.scope must name at least one of: ${NAMES}`');
    expect(grant).toContain('`grant.scope must name ${NAMES}: "${item.value}" is not one`');
    expect(grant).toContain('`grant.scope names "${item.value}" twice`');
    // And the same three on the page, word for word against the set above.
    const page = prose(TEAM_FILE_PAGE);
    expect(page).toContain('grant.scope must name at least one of: up, down, approve, init');
    expect(page).toContain('grant.scope names "<act>" twice');
    expect(page).toContain('grant.scope must name up, down, approve, init: "<word>" is not one');
  });

  test('not consulted: the live callers pass up and down; approve lives behind a dead door', () => {
    expect(prose(UP_SRC)).toContain("(sources.grantGate ?? grantGate)({ act: 'up', io, home: sources.home });");
    expect(prose(DOWN_SRC)).toContain("(sources.grantGate ?? grantGate)({ act: 'down', io, home: sources.home });");
    // The one caller that asks for the approve act — and the registry that no longer reaches
    // its module: no command row names it, so no shipped command consults the act.
    expect(prose(APPROVE_SRC)).toContain("(sources.grantGate ?? grantGate)({ act: 'approve', io, home: sources.home });");
    expect(prose(CLI_SRC)).not.toContain('approve');
  });
});
