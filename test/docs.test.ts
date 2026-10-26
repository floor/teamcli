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
// A command's full reference — every flag, refusal, outcome and exit code — lives in
// docs/internal/commands/<command>.md once its public page is the short human one; its
// examples run here exactly as the public page's do.
const REFERENCE = join(import.meta.dir, '..', 'docs', 'internal', 'commands');

const pages = [
  ...readdirSync(DIR).filter((name) => name.endsWith('.md') && name !== 'README.md').map((name) => join(DIR, name)),
  ...readdirSync(REFERENCE).filter((name) => name.endsWith('.md')).map((name) => join(REFERENCE, name)),
].sort();

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
  for (const path of pages) {
    const page = path.startsWith(REFERENCE) ? `internal/commands/${path.slice(REFERENCE.length + 1)}` : path.slice(DIR.length + 1);
    test(`${page}`, async () => {
      const markdown = readFileSync(path, 'utf8');
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
    const publicPages = pages.filter((path) => path.startsWith(`${DIR}/`)).map((path) => path.slice(DIR.length + 1).replace(/\.md$/, ''));
    expect(listed.sort()).toEqual(publicPages.sort());
  });
});
