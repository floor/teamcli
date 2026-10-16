// The watch page's schema-refusal demo, rewritten off `team approve` — a command this build no
// longer ships — onto `team up`: the page now says a command that reads such a file refuses it
// the same way, and the console block shows the two refusals under the up name with exit 2.
// Held to the binary three ways: the page as written, the loader's own two problems for the
// example file — the line numbers and the text the block prints — and the printer that carries
// the command's name, beside the contract that took `approve` out of the CLI.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTeamFile } from '../../src/file/load.ts';

const PAGE = '../../docs/commands/watch.md';
const WATCH_SRC = '../../src/file/sections/watch.ts';
const UP_SRC = '../../src/commands/up.ts';
const CONTRACT = '../../contract/cli.json';

// Whitespace runs collapse before the match, so a sentence survives line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** The example file as the page shows it, with `attention: off` on line 9 and `disks: off` on
 *  line 10. */
const EXAMPLE = `format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

watch:
  interval: 120s
  checks:
    attention: off
    disks: off

workspace:
  mode: shared

seats:
  - role: coordinator
    name: claude-keeper
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: claude-beacon
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const TURN_OFF = 'watch.checks can\'t turn off attention: attention, missing, model-drift, approval always run';
const UNKNOWN = 'unknown check "disks" in watch.checks: the checks are missing, restored, model-drift, attention, provider-error, unsent, idle, extra, team-idle, approval, load, memory, disk, swap-free, swap-growth, budget';

describe("the watch page's schema-refusal demo after team approve left the build", () => {
  test('the page says it in prose and shows it under the up name, exit 2', () => {
    const page = prose(PAGE);
    expect(
      page.includes(
        'A command that reads such a file refuses it the same way, and the watch keeps the last copy that validated, with the checks as the owner approved them.',
      ),
      'watch.md lost the refuses-it-the-same-way sentence',
    ).toBe(true);
    expect(
      raw(PAGE).includes(
        '$ team up ; echo "exit $?"\n' +
          `team up: line 9: ${TURN_OFF}\n` +
          `team up: line 10: ${UNKNOWN}\n` +
          'exit 2',
      ),
      'watch.md lost or reworded the console block under the up name',
    ).toBe(true);
  });

  test('the refusals are the loader\'s own and the printer carries the command\'s name', () => {
    const watch = raw(WATCH_SRC);
    expect(
      watch.includes('check.fail(item.line, `unknown check "${item.key}" in watch.checks: the checks are ${CHECK_NAMES.join(\', \')}`);'),
      'the unknown-check refusal changed its bytes',
    ).toBe(true);
    expect(
      watch.includes('check.fail(item.line, `watch.checks can\'t turn off ${item.key}: ${ALWAYS_ON.join(\', \')} always run`);'),
      'the always-on refusal changed its bytes',
    ).toBe(true);
    expect(
      raw(UP_SRC).includes('out.stderr(`team up: ${problem.line ? `line ${problem.line}: ` : \'\'}${plainText(problem.message)}\\n`);'),
      'the printer that puts the up name on a file problem changed its bytes',
    ).toBe(true);
    const contract = JSON.parse(readFileSync(new URL(CONTRACT, import.meta.url), 'utf8'));
    const names = contract.commands.map((command: { name: string }) => command.name);
    expect(names, 'the demo runs team up; the CLI must ship it').toContain('up');
    expect(
      names,
      'approve returned as a shipped command; the page may name it in the demo again',
    ).not.toContain('approve');
  });

  test('the example file meets those two refusals at lines 9 and 10', () => {
    const folder = mkdtempSync(join(tmpdir(), 'watch-refusals-'));
    try {
      mkdirSync(join(folder, '.agents'), { recursive: true });
      writeFileSync(join(folder, '.agents', 'team.yaml'), EXAMPLE);
      const loaded = loadTeamFile(folder);
      expect(loaded.ok, 'the example file must be refused, not read').toBe(false);
      if (!loaded.ok) {
        expect(loaded.errors).toEqual([
          { line: 9, message: TURN_OFF },
          { line: 10, message: UNKNOWN },
        ]);
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
