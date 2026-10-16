// npm-readme.md's Start block, against the command docs. Every command the shortest working
// start shows must be a `$ ` line of a docs/commands page — the lines test/docs.test.ts runs
// in-process against the fake world, byte-for-byte against the output beside them. A command
// added to the Start block without a page (a page without a test) fails here.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..');

/** The lines of the sh fence under `## Start`, comments stripped. */
function startCommands(markdown: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^##\s+Start\s*$/.test(line));
  expect(start).toBeGreaterThanOrEqual(0);
  const fence = lines.findIndex((line, index) => index > start && line.trim() === '```sh');
  expect(fence).toBeGreaterThan(start);
  const body: string[] = [];
  for (const line of lines.slice(fence + 1)) {
    if (line.trim() === '```') break;
    const command = line.split(' #')[0]?.trim() ?? '';
    if (command !== '') body.push(command);
  }
  return body;
}

describe('npm-readme.md', () => {
  const markdown = readFileSync(join(repo, 'npm-readme.md'), 'utf8');

  test('stays short', () => {
    expect(markdown.split('\n').length).toBeLessThan(100);
  });

  test('the Start block is the shortest working start: init, doctor, up', () => {
    expect(startCommands(markdown)).toEqual(['team init', 'team doctor', 'team up']);
  });

  test('every Start command is a `$ ` line of a page test/docs.test.ts runs', () => {
    const pages = readdirSync(join(repo, 'docs/commands'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({ name, markdown: readFileSync(join(repo, 'docs/commands', name), 'utf8') }));

    for (const command of startCommands(markdown)) {
      const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const line = new RegExp(`^\\$ ${escaped}(?: ; echo "exit \\$\\?")?$`, 'm');
      const page = pages.find((candidate) => line.test(candidate.markdown));
      expect(page?.name, `no docs/commands page runs \`${command}\``).toBeDefined();
    }
  });
});
