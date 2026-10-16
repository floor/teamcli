// The up page's new left-out row for the lobby trust record, held to the binary that owns the
// line. The row generalises the refusal the launch prints, names the grok and cursor flags as the
// command tails src builds, states the dry-run shape up prints, and claims a CLI with no writer
// starts with nothing written — a claim that lives in the gap between repair's antigravity case
// and a WRITERS table without one. These pins read both sides and refuse to let them part.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const PAGE = '../../docs/internal/up.md';
const PRETRUST_SRC = '../../src/launch/pretrust.ts';
const UP_SRC = '../../src/commands/up.ts';

// The refusal row the left-out table carries, as written.
const ROW = '<seat>: left out: refused: the lobby is not trusted for <cli>: run <cli> in <lobby> and accept the folder';

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

describe('the lobby trust record on the up page', () => {
  test('the refusal row and its promises stand as written', () => {
    const page = prose(PAGE);
    expect(page.includes(ROW), 'up.md lost the refusal row').toBe(true);
    expect(page.includes("the record is written under the seat's home before its workspace is made"), 'up.md lost where the record is written').toBe(true);
    expect(
      page.includes(
        'a config that is a link — that file, or a folder above it — one that cannot be read, or one that CLI\'s own file cannot be merged into leaves the seat out instead',
      ),
      'up.md lost what leaves the seat out',
    ).toBe(true);
    expect(page.includes('a CLI this build has no writer for starts with nothing written'), 'up.md lost the no-writer sentence').toBe(true);
    expect(page.includes('This seat is not started, and the others still are'), 'up.md lost the others-still-start promise').toBe(true);
  });

  test('the flags the row names are the binary’s own, and claude’s form is the row’s', () => {
    const page = prose(PAGE);
    for (const cli of ['grok', 'cursor'] as const) {
      const tail = repairTemplate(cli).replace(new RegExp(`^the lobby is not trusted for ${cli}: `), '');
      expect(page.includes(tail), `up.md’s ${cli} repair drifted from src`).toBe(true);
    }
    // The row generalises claude’s own form: the template with its name held out as <cli> is
    // the row’s refusal word for word.
    expect(repairTemplate('claude-code').replaceAll('claude', '<cli>')).toBe(ROW.replace('<seat>: left out: refused: ', ''));
  });

  test('the dry-run sentence is the shape up prints, and claude is the one seat it reports', () => {
    const page = prose(PAGE);
    expect(
      page.includes(
        'A `--dry-run` writes nothing: it reports this refusal, as a `would refuse:` line, only for a Claude seat whose config it cannot merge into.',
      ),
      'up.md lost the dry-run sentence',
    ).toBe(true);
    // The would-refuse line is up's own template, and the dry run reports a line for a claude
    // seat alone: that rule is the one clause in pretrust that names a CLI.
    expect(raw(UP_SRC).includes('! up would refuse: ${'), 'up.ts no longer prints the would-refuse line').toBe(true);
    expect(raw(PRETRUST_SRC).includes("seat.cli === 'claude-code' && claudeUnmergeable(home)"), 'pretrust.ts no longer limits the dry run to claude').toBe(true);
  });

  test('the no-writer sentence keeps its CLI: antigravity has a repair and no writer', () => {
    const src = raw(PRETRUST_SRC);
    // A shipped CLI the row’s last promise is true for: repair can name agy, but the writer is
    // what decides, and the table has none for it — the day one is added, the sentence above
    // is no longer the whole truth and this pin says so.
    expect(src.includes("case 'antigravity':"), 'pretrust.ts lost the antigravity repair').toBe(true);
    expect(/\bantigravity: write/.test(src), 'an antigravity writer landed: the no-writer sentence went stale').toBe(false);
  });
});
