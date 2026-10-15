// The release notes at their boundaries. The changelog is the one page that states what shipped
// and when, and nothing checks it: a version heading that disagrees with package.json, a date
// that is not a date, or a quoted refusal the binary never prints would all land silently. These
// pins read the notes against the two things they must agree with — the package and the source.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const CHANGELOG = '../../CHANGELOG.md';
const PACKAGE = '../../package.json';
const STATUS_SRC = '../../src/commands/status.ts';

// The one stderr sentence the 0.4.0 notes quote for the status gate, as the binary prints it.
const NOT_YOURS = 'team status: this team is not yours to read';

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('the release notes', () => {
  test('the newest version heading matches the package, and its date is a date', () => {
    const notes = raw(CHANGELOG);
    // The first versioned heading below Unreleased is the release the notes describe.
    const heading = notes.match(/^## \[([0-9][^\]]*)\] - (\S+)$/m);
    expect(heading, 'CHANGELOG.md lost its versioned heading').not.toBeNull();

    const pkg = JSON.parse(raw(PACKAGE)) as { version: string };
    expect(heading![1]!, 'the notes describe a version the package does not carry').toBe(pkg.version);

    const date = new Date(`${heading![2]!}T00:00:00Z`);
    expect(Number.isNaN(date.getTime()), 'the release date does not name a calendar day').toBe(false);

    // Notes are added below Unreleased, never in place of it.
    expect(notes.includes('## [Unreleased]'), 'CHANGELOG.md lost its Unreleased section').toBe(true);
  });

  test('the refusal the notes quote is the binary’s own sentence', () => {
    expect(prose(CHANGELOG).includes(NOT_YOURS), 'the notes no longer quote the status refusal').toBe(true);
    // The quote must be the command's own line, pulled from the source: if either changes alone,
    // the notes describe a build that does not exist.
    expect(raw(STATUS_SRC).includes(NOT_YOURS), 'src no longer prints the sentence the notes quote').toBe(true);
  });
});
