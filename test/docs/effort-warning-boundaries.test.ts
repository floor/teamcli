// The team-file page's effort warning no longer names `team approve`: the command is gone from
// the shipped CLI, so the sentence says only `team check` and `team up`. The sentence is pinned
// as written, beside the warning sentence above it that carries the claim, and the gone command
// is pinned to the contract that is the CLI's own surface: the day `approve` returns as a
// command, the page must name it again or this pin says so.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const PAGE = '../../docs/team-file.md';
const CONTRACT = '../../contract/cli.json';
const REFERENCE = '../../docs/reference/cli.md';

// Whitespace runs collapse before the match, so a sentence survives line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

describe("the effort warning's not-failed list", () => {
  test('names team check and team up, and no command that is gone', () => {
    const page = prose(PAGE);
    expect(
      page.includes("A word outside its lab's list is a warning, and the warning names the words that lab allows."),
      'team-file.md lost the warning sentence',
    ).toBe(true);
    expect(
      page.includes('It does not fail `team check` or `team up`.'),
      'team-file.md lost the not-failed sentence',
    ).toBe(true);
  });

  test('approve is gone from the CLI the sentence may name', () => {
    const contract = JSON.parse(readFileSync(new URL(CONTRACT, import.meta.url), 'utf8'));
    const names = contract.commands.map((command: { name: string }) => command.name);
    expect(names, 'the contract is the command list').toContain('check');
    expect(names, 'the contract is the command list').toContain('up');
    expect(names, 'approve returned as a command; the page must name it again').not.toContain('approve');
    expect(
      readFileSync(new URL(REFERENCE, import.meta.url), 'utf8'),
      'the reference page lists approve',
    ).not.toContain('team approve');
  });
});
