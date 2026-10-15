// The lobby trust record's paper trail at its boundaries. The add page now states what the tool
// reads and writes for it, the refusal that stops a seat when the record cannot be written, and
// the repair line that names what the seat's own CLI needs. The binary owns those lines —
// src/launch/pretrust.ts builds the repair per CLI — and nothing tied the page to it. These pins
// read both and refuse to let them part.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const PAGE = '../../docs/commands/add.md';
const PRETRUST_SRC = '../../src/launch/pretrust.ts';
const ADD_SRC = '../../src/commands/add.ts';

// The refusal row the exit table carries, as written.
const ROW =
  'team add: refused: the lobby is not trusted for <cli>: run <cli> in <lobby> and accept the folder';

// The reads and writes the page now states, as written: what the trust work reads, and what it
// writes — before the workspace is made, never through a link.
const READS = "the seat's CLI's own config under the seat's home when the seat is about to start in the lobby";
const WRITES =
  "the CLI's own trust record for the lobby when the seat is about to start there — the file that CLI already reads for a folder it was told to trust, written under the seat's home before the workspace is made, and left untouched when it or a folder above it is a link";

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

// The repair string src builds for one CLI, with ${lobby} left as a placeholder.
function repairTemplate(cli: string): string {
  const src = raw(PRETRUST_SRC);
  const form = src.match(new RegExp("case '" + cli + "':\\s*return `([^`]+)`"));
  if (!form) throw new Error(`pretrust.ts no longer names the repair for ${cli}`);
  return form[1]!.replace(/\$\{lobby\}/g, '<lobby>');
}

describe('the lobby trust record on paper', () => {
  test('the refusal row and the reads/writes promises stand as written', () => {
    const page = prose(PAGE);
    expect(page.includes(ROW), 'add.md lost the refusal row').toBe(true);
    expect(page.includes(READS), 'add.md lost what the trust work reads').toBe(true);
    expect(page.includes(WRITES), 'add.md lost what the trust work writes').toBe(true);
  });

  test('the page’s repair lines are the binary’s own, for every CLI the page names', () => {
    const page = prose(PAGE);
    // The table row generalises the repair; claude's own form the page quotes rendered, in the
    // worked example the test below pins. The flag CLIs the page names as the command tail, which
    // must be the tail of the string src builds, placeholder for placeholder.
    for (const cli of ['grok', 'cursor'] as const) {
      const tail = repairTemplate(cli).replace(new RegExp(`^the lobby is not trusted for ${cli}: `), '');
      expect(page.includes(tail), `add.md’s ${cli} repair drifted from src`).toBe(true);
    }
  });

  test('the worked example quotes the binary’s own refusal, rendered for the default lobby', () => {
    const page = prose(PAGE);
    const scene = page.match(/team add: refused: the lobby is not trusted for claude: run claude in \S+ and accept the folder/);
    expect(scene, 'add.md lost the worked refusal example').not.toBeNull();
    const rendered = `team add: refused: ${repairTemplate('claude-code').replaceAll('<lobby>', '~/.config/team/lobby')}`;
    expect(scene![0], 'the example’s refusal no longer matches the binary’s').toBe(rendered);
  });

  test('the dry-run shape the page states is the shape the command prints', () => {
    const page = prose(PAGE);
    expect(
      page.includes('A `--dry-run` reports it as `<name>: would refuse: <line>` and writes nothing.'),
      'add.md lost the dry-run sentence',
    ).toBe(true);
    // The page's <line> is the command's own template, pulled from the source.
    expect(
      raw(ADD_SRC).includes(': would refuse: ${'),
      'add.ts no longer prints the would-refuse line with the reason',
    ).toBe(true);
  });
});
