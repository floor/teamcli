// The docs check: every example in docs/commands/ is run against a fixture project and fakes, and
// its output must match the page byte for byte. A page that drifts from the code fails here, in
// `bun test`, and so in `bun run ci`.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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

const DOCS = join(import.meta.dir, '..', 'docs');

function markdownPages(at: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const path = join(at, entry.name);
    if (entry.isDirectory()) found.push(...markdownPages(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found.sort();
}

/** The sender vocabulary, checked over every page: a displayed sender is always attributed, and
 *  never called verified or unverified. The word verified is reserved for an owner's own
 *  device-signed action; a reader that printed it beside a seat's name would claim an identity
 *  the shared checkout key cannot carry. */
describe('the sender vocabulary in the docs', () => {
  test('no page marks a sender as verified or unverified', () => {
    const offenders: string[] = [];
    for (const path of markdownPages(DOCS)) {
      const lines = readFileSync(path, 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        if (/(?:un)?verified (sender|author)|\((?:un)?verified\)/.test(line)) {
          offenders.push(`${relative(DOCS, path)}:${String(index + 1)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every reader page carries the attributed words', () => {
    const wanted: Array<[page: string, words: string[]]> = [
      ['commands/messages.md', ['(attributed)', 'sender_attribution']],
      ['commands/drops.md', ['(attributed)', '(unattributed)', 'sender_attribution']],
      ['commands/send.md', ['attribution, never a verification']],
      ['commands/settings.md', ['[unattributed author]']],
      ['internal/messages.md', ['sender_attribution']],
      ['internal/mcp-inbox.md', ['sender_attribution']],
    ];
    const missing: string[] = [];
    for (const [page, words] of wanted) {
      const text = readFileSync(join(DOCS, page), 'utf8');
      for (const word of words) if (!text.includes(word)) missing.push(`${page}: ${word}`);
    }
    expect(missing).toEqual([]);
  });
});
