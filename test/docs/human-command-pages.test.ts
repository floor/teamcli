// The human command page: what a reader sees on docs/commands/<command>.md once the page has
// been rewritten to the template. Every flag, refusal, outcome and exit code lives in the full
// reference, docs/internal/commands/<command>.md, whose examples test/docs.test.ts runs too.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', 'docs');
// The pages rewritten so far; a command joins this list when its page is.
const HUMAN = ['config', 'init', 'migrate', 'send', 'up'];
const SECTIONS = ['Usage', 'What it does', 'Examples', 'Options', 'Who can run it', 'See also'];

function sectionOf(markdown: string, title: string): string {
  const start = markdown.indexOf(`\n## ${title}\n`);
  if (start < 0) return '';
  const rest = markdown.slice(start + title.length + 5);
  const end = rest.indexOf('\n## ');
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

describe('the human command pages', () => {
  for (const name of HUMAN) {
    const markdown = readFileSync(join(ROOT, 'commands', `${name}.md`), 'utf8');
    test(`${name}.md follows the template`, () => {
      const lines = markdown.split('\n');
      expect(lines[0]).toBe(`# team ${name}`);
      // One line of purpose under the title, then the sections in order.
      expect(lines[1]).toBe('');
      expect(lines[2]?.length ?? 0).toBeGreaterThan(0);
      expect(lines[3]).toBe('');
      const headings = lines.filter((line) => line.startsWith('## ')).map((line) => line.slice(3));
      expect(headings).toEqual(SECTIONS);
      // "What it does" is a short paragraph: six sentences at most.
      const what = sectionOf(markdown, 'What it does').replace(/`[^`]*`/g, 'x');
      expect((what.match(/[.!?](\s|$)/g) ?? []).length).toBeLessThanOrEqual(6);
      // Two or three examples, each introduced by a line of its own.
      const examples = sectionOf(markdown, 'Examples').match(/^```(console|sh)\b/gm) ?? [];
      expect(examples.length).toBeGreaterThanOrEqual(2);
      expect(examples.length).toBeLessThanOrEqual(3);
      // "Who can run it" is one line.
      expect(sectionOf(markdown, 'Who can run it').split('\n')).toHaveLength(1);
      // The public page never points at the private docs.
      expect(markdown.includes('internal/')).toBe(false);
    });
    test(`${name}.md has its full reference`, () => {
      expect(existsSync(join(ROOT, 'internal', 'commands', `${name}.md`))).toBe(true);
    });
  }
});
