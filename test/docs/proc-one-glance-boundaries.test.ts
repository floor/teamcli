import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const COMMAND_PAGE = 'docs/commands/proc.md';
const INTERNAL_PAGE = 'docs/internal/proc.md';
const README_PAGE = 'README.md';

function raw(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe('the one-glance cut of the proc page', () => {
  test('docs/commands/proc.md stays under 155 lines and keeps expected structure', () => {
    const page = raw(COMMAND_PAGE);
    const lines = page.split('\n');
    expect(lines.length).toBeLessThan(155);

    expect(
      page.includes(
        'What it reads and writes, how a seat holds a name, the JSON document, and the refusal examples: [docs/internal/proc.md](../internal/proc.md).',
      ),
    ).toBe(true);

    expect(page.includes('## Who may run it')).toBe(true);
    expect(page.includes('| Subcommand | Caller |')).toBe(true);

    expect(page.includes('## Refusals')).toBe(true);
    const refusals = [
      '`team proc: a subcommand is required` (with the usage)',
      '`team proc: unexpected "<word>"` (with the usage)',
      '`team proc: a <name> is required` (with the usage)',
      '`team proc: "<name>" is a name, not a path: lowercase letters, digits and hyphens` (with the usage)',
      '`team proc: --pid is a whole number above zero, the process to watch` (with the usage)',
      '`team proc: --pid needs a value` (with the usage)',
      '`team proc: unknown option --<name>` (with the usage)',
      '`team proc: add takes no --json`, and the same for `done` (with the usage)',
      '`team proc: list takes no --pid or --note` (with the usage)',
      '`team proc: only the owner runs this, from a terminal outside herdr`',
      '`team proc: only a seat of this team or the owner records a process; this call is <caller>`',
      '`team proc: pid <n> is not running`',
      '`team proc: "<name>" is <seat>\'s, live since <at>`',
      '`team proc: no process named "<name>"`',
      '`team proc: "<name>" is <seat>\'s; only <seat>, a lead or the owner clears it`',
      '`team proc: "<name>" is the owner\'s; only the owner clears it`',
      '`team proc: this team is not yours to read`',
      '`team proc: <why the team file did not load>`',
    ];
    for (const refusal of refusals) {
      expect(page.includes(refusal), `missing refusal: ${refusal}`).toBe(true);
    }
  });

  test('docs/internal/proc.md carries required title and sections', () => {
    const page = raw(INTERNAL_PAGE);
    expect(page.includes('# `team proc`: rationale and known limits')).toBe(true);
    expect(page.includes('## What it reads and writes')).toBe(true);
    expect(page.includes('## Naming, and the name a seat holds')).toBe(true);
    expect(page.includes('## Examples')).toBe(true);
  });

  test('README.md includes team usage and team proc rows in ## Commands table', () => {
    const readme = raw(README_PAGE);
    expect(readme.includes('| `team usage` |')).toBe(true);
    expect(readme.includes('| `team proc add <name>` / `team proc list` / `team proc done <name>` |')).toBe(true);
  });
});
