// The two paragraphs that say `doctor` and `status` clean every line they print, held to the
// pages and to the code that makes them true. Both commands take `cleanedIo` once at their entry
// and print through it; `doctor` keeps no raw writer at all, and `status` keeps exactly one —
// the `--json` document, escaped by `JSON.stringify` itself. Each paragraph is pinned verbatim
// and each claim cross-checked against its source, so the page cannot outlive the code or the
// code drift past the page unnoticed.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// Whitespace runs collapse before the match, so the paragraphs survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const DOCTOR_PAGE = '../../docs/commands/doctor.md';
const STATUS_PAGE = '../../docs/commands/status.md';
const DOCTOR_SRC = '../../src/commands/doctor.ts';
const STATUS_SRC = '../../src/commands/status.ts';
const IO_SRC = '../../src/io.ts';

describe('the printed-text cleaning the two pages now promise', () => {
  test('both paragraphs stand, verbatim, on their pages', () => {
    expect(prose(DOCTOR_PAGE)).toContain(
      'Every line it prints is cleaned first: escape sequences, control characters and invisible format characters carried by the team file, a pane or a CLI\'s own output are removed, so a value can never move the cursor, paint the terminal or open a second line.',
    );
    const status = prose(STATUS_PAGE);
    expect(status).toContain(
      'Every line the table prints is cleaned first: escape sequences, control characters and invisible format characters carried by the team file, the state, a pane or herdr are removed, and the columns are padded on the cleaned text, so a value can never move the cursor, paint the terminal or open a second line.',
    );
    expect(status).toContain(
      '`--json` is the one text not cleaned: the document carries each string as it was read, escaped where JSON requires it, for a parser rather than a terminal.',
    );
  });

  test("doctor's promise holds: the raw writer count is zero", () => {
    // `Every line it prints is cleaned first` is true while nothing in doctor.ts writes through
    // io directly; a new raw `io.stdout` or `io.stderr` would print past the cleaning and make
    // the page's sentence a lie. The entry takes the cleaned io, and that is the only kind left.
    expect(raw(DOCTOR_SRC)).toContain('const out = cleanedIo(io);');
    expect(/io\.(stdout|stderr)/.test(raw(DOCTOR_SRC)), 'doctor.ts grew a raw writer: the page went stale').toBe(false);
  });

  test("status's one exception is the --json document, escaped by JSON itself", () => {
    const src = raw(STATUS_SRC);
    // The entry takes the cleaned io like doctor does; the one raw stdout left in the file is
    // the document, and its escaping is JSON.stringify's, which is the page's own claim.
    expect(src).toContain('const out = cleanedIo(io);');
    expect(src).toContain('io.stdout(`${JSON.stringify(doc, null, 2)}\\n`)');
  });

  test('the cleaning both commands print through is plainLine, cell by cell', () => {
    // cleanedIo's own contract: every line of anything it writes is cleaned with the one
    // cleaning. The table's cells pass through plainLine before the widths pad them, which is
    // the page's "the columns are padded on the cleaned text".
    expect(raw(IO_SRC)).toContain('.map((line) => plainLine(line))');
    expect(raw(STATUS_SRC)).toContain('name: plainLine(row.name)');
    expect(raw(STATUS_SRC)).toContain('state: plainLine(row.state)');
    expect(raw(STATUS_SRC)).toContain('pane: plainLine(row.pane)');
  });
});
