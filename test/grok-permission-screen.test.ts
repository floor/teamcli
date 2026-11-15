// Grok 1.0.77's command approval is read as a permission prompt, so a seat stopped on it is
// routed like any other prompt and never read as unknown.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyPromptKind } from '../src/watch/status-events.ts';
import { classify } from '../src/watch/screen.ts';

const fixture = (version: string, name: string): string =>
  readFileSync(join(import.meta.dir, 'fixtures', 'grok', version, name), 'utf8');

test('the 1.0.77 command approval classifies as permission', () => {
  const raw = fixture('1.0.77', 'permission.txt');
  expect(classify('grok', raw.split('\n')).kind).toBe('permission');
  expect(classifyPromptKind('grok', raw)).toBe('permission');
});

test('the 1.0.52 answer widget stays a question, and an idle prompt is no permission', () => {
  expect(classify('grok', fixture('1.0.52', 'permission.txt').split('\n')).kind).toBe('question');
  expect(classify('grok', fixture('1.0.50', 'idle.txt').split('\n')).kind).not.toBe('permission');
});

test('the choices alone, without the select footer, are not read as the approval', () => {
  const raw = fixture('1.0.77', 'permission.txt')
    .split('\n')
    .filter((line) => !/[0-9]+\/[0-9]+:select/.test(line))
    .join('\n');
  expect(classify('grok', raw.split('\n')).kind).not.toBe('permission');
});
