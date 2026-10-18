// The no-terminal refusal `status` gives `--file` and `--session`, held to both pages and to
// the gate that prints it. The flag refusals ride `fileOwnerRefusal` and `sessionOwnerRefusal`,
// which prefer the detached sentence; the pages now name both forms, and the internal table's
// new row claims the flags are judged *before* the caller gate — the exit-1 flag line, not the
// fixed exit-2 sentence. Each sentence is pinned verbatim and the ordering claim cross-checked
// against the source, so neither the pages nor the gate can drift unnoticed.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// Whitespace runs collapse before the match, so the sentences survive line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const STATUS_PAGE = '../../docs/commands/status.md';
const INTERNAL_PAGE = '../../docs/internal/status.md';
const STATUS_SRC = '../../src/commands/status.ts';
const CALLER_SRC = '../../src/caller.ts';

describe("status's no-terminal refusal for --file and --session", () => {
  test('both pages name the two forms, verbatim', () => {
    expect(prose(STATUS_PAGE)).toContain(
      '`--file` and `--session` aimed by anyone else are refused before any file or session is read — `--file is the owner\'s, from a terminal outside herdr; this call is …`, or `only the owner runs this, from a terminal outside herdr` for a run with no terminal — and exit 1.',
    );
    expect(prose(INTERNAL_PAGE)).toContain(
      '`--file` and `--session` are the owner\'s. Aimed by anyone else, each is refused before any file or session is read — `--file is the owner\'s, from a terminal outside herdr; this call is …`, or `only the owner runs this, from a terminal outside herdr` for a run with no terminal — and exits 1.',
    );
  });

  test('the exit table gains the row, with its before-the-gate claim, verbatim', () => {
    expect(prose(INTERNAL_PAGE)).toContain(
      '| `team status: only the owner runs this, from a terminal outside herdr` — a run with no terminal aiming either flag; judged before the caller gate, so it is this line and not the fixed sentence below | 1 |',
    );
  });

  test("the sentence is the caller's own constant, preferred by both flag refusals", () => {
    const caller = prose(CALLER_SRC);
    expect(caller).toContain(
      "export const DETACHED_REFUSAL = 'only the owner runs this, from a terminal outside herdr';",
    );
    expect(caller).toContain("if (caller.kind !== 'owner-no-tty') return undefined;");
    // The pages' "or" is this ??: the detached sentence first, the owner's-flag line only when
    // the run has a terminal.
    expect(caller).toContain('detachedRefusal(walked) ?? `--file is the owner\'s, from a terminal outside herdr');
  });

  test('the flags really are judged before the read: the gate order in the source', () => {
    const src = prose(STATUS_SRC);
    // The row's claim, checked as position: both flag refusals print and return before
    // currentTeam reads anything — a no-terminal run aiming a flag meets the exit-1 line,
    // never the fixed exit-2 sentence the read gate prints.
    const fileGate = src.indexOf('exit: status.file-owner');
    const sessionGate = src.indexOf('exit: status.session-owner');
    const read = src.indexOf('currentTeam(io.cwd');
    expect(fileGate).toBeGreaterThan(-1);
    expect(sessionGate).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    expect(fileGate).toBeLessThan(read);
    expect(sessionGate).toBeLessThan(read);
  });
});
