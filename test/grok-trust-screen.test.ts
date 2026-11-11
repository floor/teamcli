// Grok 1.0.77's folder trust dialog is read as a trust screen, not as an idle prompt.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from '../src/watch/screen.ts';

test('the 1.0.77 trust dialog classifies as trust', () => {
  const lines = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.77', 'trust.txt'), 'utf8').split('\n');
  expect(classify('grok', lines).kind).toBe('trust');
});

test('an idle 1.0.50 prompt is still not a trust screen', () => {
  const lines = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.50', 'idle.txt'), 'utf8').split('\n');
  expect(classify('grok', lines).kind).not.toBe('trust');
});
