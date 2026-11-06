// A Cursor Grok status row is closed: the version, then only the fixed tokens, with Run
// Everything optional, and the line ends there. Words after the version are not that row.
// The workspace line has to sit directly under it. The same frames are read from the middle
// of a window and from a window whose first row is the prompt.
import { expect, test } from 'bun:test';
import { readScreen } from '../src/watch/screen.ts';

function frame(rows: readonly string[]): string {
  return `${rows.join('\n')}\n`;
}

const gap = ['', ''] as const;

function mid(status: string, workspace: boolean): string {
  return frame([
    '',
    '  → Add a follow-up',
    ...gap,
    status,
    ...(workspace ? ['  <workspace>'] : []),
  ]);
}

function top(status: string, workspace: boolean): string {
  return frame([
    '  → Add a follow-up',
    ...gap,
    status,
    ...(workspace ? ['  <workspace>'] : []),
  ]);
}

const closed = '  Grok 4.7';
const withRun = '  Grok 4.7                  Run Everything';
const trailed = '  Grok 4.7 leftover';

test('a closed Grok row with the workspace line under it is idle in the middle of the window', () => {
  expect(readScreen('cursor', mid(closed, true)).kind).toBe('idle');
  expect(readScreen('cursor', mid(withRun, true)).kind).toBe('idle');
});

test('words after the version are unknown in the middle of the window', () => {
  expect(readScreen('cursor', mid(trailed, true)).kind).toBe('unknown');
});

test('a closed Grok row with no workspace line under it is unknown in the middle of the window', () => {
  expect(readScreen('cursor', mid(closed, false)).kind).toBe('unknown');
  expect(readScreen('cursor', mid(withRun, false)).kind).toBe('unknown');
});

test('a closed Grok row with the workspace line under it is idle when the window starts on the prompt', () => {
  expect(readScreen('cursor', top(closed, true)).kind).toBe('idle');
  expect(readScreen('cursor', top(withRun, true)).kind).toBe('idle');
});

test('words after the version are unknown when the window starts on the prompt', () => {
  expect(readScreen('cursor', top(trailed, true)).kind).toBe('unknown');
});

test('a closed Grok row with no workspace line under it is unknown when the window starts on the prompt', () => {
  expect(readScreen('cursor', top(closed, false)).kind).toBe('unknown');
});
