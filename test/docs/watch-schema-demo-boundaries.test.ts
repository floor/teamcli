// The schema-refusal demo on the watch page, held to the page and to the validator that prints
// its two lines. The demo stopped running `team approve` — a command this build no longer ships —
// and now runs `team up` through the same schema; the sentence above it names a command that
// reads such a file instead of naming the deleted one. Both refusal lines are pinned verbatim
// against the validator's own templates and the two lists they print, and the dead command's
// forms are pinned gone from the sentence and the demo it used to run.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const WATCH_PAGE = '../../docs/commands/watch.md';
const WATCH_SECTION = '../../src/file/sections/watch.ts';
const CHECK_SRC = '../../src/watch/check.ts';
const CLI_SRC = '../../src/cli.ts';

describe("the watch page's schema-refusal demo", () => {
  test('the sentence names a command that reads, not the deleted one', () => {
    expect(prose(WATCH_PAGE)).toContain(
      "refused by the schema itself, with the line, and so is a name that is no check. A command that reads such a file refuses it the same way, and the watch keeps the last copy that validated, with the checks as the owner approved them.",
    );
    // The old sentence handed the refusal to `team approve`; neither it nor the demo's old
    // output prefix may return.
    expect(prose(WATCH_PAGE)).not.toContain('`team approve` refuses such a file the same way');
    expect(prose(WATCH_PAGE)).not.toContain('team approve: line');
  });

  test('the demo runs up and prints the two refusals, verbatim', () => {
    const page = prose(WATCH_PAGE);
    expect(page).toContain('$ team up ; echo "exit $?"');
    expect(page).toContain(
      "team up: line 9: watch.checks can't turn off attention: attention, missing, model-drift, approval always run",
    );
    expect(page).toContain(
      'team up: line 10: unknown check "disks" in watch.checks: the checks are missing, restored, model-drift, attention, provider-error, unsent, idle, extra, team-idle, approval, load, memory, disk, swap-free, swap-growth, budget',
    );
    expect(page).toContain('exit 2');
  });

  test('the two lines are the validator\'s own templates and the two lists they print', () => {
    const section = prose(WATCH_SECTION);
    expect(section).toContain('`unknown check "${item.key}" in watch.checks: the checks are ${CHECK_NAMES.join(\', \')}`');
    expect(section).toContain("`watch.checks can't turn off ${item.key}: ${ALWAYS_ON.join(', ')} always run`");
    // The lists the page's two lines print, as the file defines them: the four that cannot be
    // turned off, and the sixteen names an unknown one is refused against.
    const checks = prose(CHECK_SRC);
    expect(checks).toContain(
      "export const ALWAYS_ON: readonly string[] = ['attention', 'missing', 'model-drift', 'approval'];",
    );
    expect(checks).toContain('export const CHECK_NAMES = [');
    expect(checks).toContain("'missing', 'restored', 'model-drift', 'attention', 'provider-error', 'unsent', 'idle', 'extra', 'team-idle', 'approval', 'load', 'memory', 'disk', 'swap-free', 'swap-growth', 'budget',");
  });

  test('the command the demo stopped running is gone from the registry', () => {
    // `team up` reads the file through the same schema because it is a shipped command; the
    // registry carries it, and carries no `approve` for any demo to run.
    const cli = prose(CLI_SRC);
    expect(cli).toContain('up: () => import(\'./commands/up.ts\'),');
    expect(cli).not.toContain('approve');
  });
});
