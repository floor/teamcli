// The docs check: every example in docs/commands/ is run against a fixture project and fakes, and
// its output must match the page byte for byte. A page that drifts from the code fails here, in
// `bun test`, and so in `bun run ci`.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import type { Io } from '../src/io.ts';
import { runPage } from './docs/run.ts';

const DIR = join(import.meta.dir, '..', 'docs', 'commands');

const pages = readdirSync(DIR)
  .filter((name) => name.endsWith('.md') && name !== 'README.md')
  .sort();

function capture(): { io: Io; out(): string } {
  let out = '';
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      out += text;
    },
    cwd: process.cwd(),
    env: {},
    stdinIsTTY: false,
  };
  return { io, out: () => out };
}

describe('the command reference', () => {
  for (const page of pages) {
    test(`${page}`, async () => {
      const markdown = readFileSync(join(DIR, page), 'utf8');
      const failures = await runPage(page, markdown);
      expect(failures.map((failure) => `${failure.page}:${failure.line}: ${failure.message}`).join('\n\n')).toBe('');
    });
  }

  test('every command `team --help` lists has a page, and every page a command', async () => {
    const shown = capture();
    expect(await main(['--help'], shown.io)).toBe(0);
    const lines = shown.out().split('\n');
    const listed = lines
      .slice(lines.indexOf('Commands:') + 1)
      .filter((line) => /^  \S+$/.test(line))
      .map((line) => line.trim());
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.sort()).toEqual(pages.map((name) => name.replace(/\.md$/, '')).sort());
  });
});
