import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { stripSgr } from '../src/ansi.ts';
import { readScreen } from '../src/watch/screen.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';

test('a bright frame edge does not make a faint hint a draft, but one bright input character does', () => {
  const idle = readFileSync(new URL('./fixtures/grok/1.0.50/idle-ansi.txt', import.meta.url), 'utf8');
  const mark = idle.lastIndexOf('❯ ');
  expect(mark > 0).toBe(true);
  const insert = (text: string) => idle.slice(0, mark + 2) + text + idle.slice(mark + 2);
  const hint = insert('\x1b[2mA synthetic suggestion\x1b[0m');
  expect(readScreen('grok', hint).kind).toBe('idle');
  expect(boxHoldsText('grok', 'Synthetic rules.', hint)).toBe(false);
  expect(readScreen('grok', stripSgr(hint)).kind).toBe('unsent');
  const mixed = insert('\x1b[2mA synthetic \x1b[22mX\x1b[2m suggestion\x1b[0m');
  expect(readScreen('grok', mixed).kind).toBe('unsent');
  expect(boxHoldsText('grok', 'A synthetic X suggestion', mixed)).toBe(true);
});
