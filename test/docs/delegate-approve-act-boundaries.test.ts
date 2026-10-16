// The team-file page's delegates bullet, after the `approve` command left the build: the page
// now says the word still parses in `commands` and no command consults it, and that a delegate
// may run `up`, `down`, `add` and `remove`. The parse side is held by the delegate-section
// tests; this file holds the page to the shipped CLI it describes — the four commands the page
// names are the contract's, `approve` is not — and to the list the loader still reads, so the
// day `approve` returns as a command, or leaves the parser, the page and this pin disagree.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const PAGE = '../../docs/team-file.md';
const CONTRACT = '../../contract/cli.json';
const DELEGATE_TYPES = '../../src/delegate-types.ts';

// Whitespace runs collapse before the match, so a sentence survives line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

describe('the delegates bullet after the approve command left the build', () => {
  test('the page says it parses and is not consulted, as written', () => {
    const page = prose(PAGE);
    expect(
      page.includes('`commands` names at most one each of the six `up`, `down`, `add`, `remove`, `approve` and `swap`.'),
      'team-file.md lost the six-worded parse rule the still-parses claim leans on',
    ).toBe(true);
    expect(
      page.includes(
        '`approve` in `commands` still parses — a file that names it is read like any other — and no command in this build consults it.',
      ),
      'team-file.md lost the still-parses, not-consulted sentence',
    ).toBe(true);
    expect(
      page.includes('The commands a delegate may run are `up`, `down`, `add` and `remove`.'),
      'team-file.md lost the four-runnable sentence',
    ).toBe(true);
  });

  test('the build agrees: the four are shipped commands, approve is not, and the parser still reads it', () => {
    const contract = JSON.parse(readFileSync(new URL(CONTRACT, import.meta.url), 'utf8'));
    const names = contract.commands.map((command: { name: string }) => command.name);
    for (const command of ['up', 'down', 'add', 'remove']) {
      expect(names, `the page names \`team ${command}\` as a delegate\'s to run`).toContain(command);
    }
    expect(
      names,
      'approve returned as a shipped command; the page says no command consults it',
    ).not.toContain('approve');
    expect(
      readFileSync(new URL(DELEGATE_TYPES, import.meta.url), 'utf8'),
      'the loader dropped approve from the words it reads; the page says it still parses',
    ).toContain("export const DELEGATE_COMMANDS: readonly DelegateCommand[] = ['up', 'down', 'add', 'remove', 'approve', 'swap'];");
  });
});
