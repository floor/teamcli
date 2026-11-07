// A mid-window Cursor frame. Words after a Grok version are not the status row, and a
// status row with no workspace line under it is not the row either. Both read unknown.
// The same frame with a closed row and the workspace line under it stays idle.
import { expect, test } from 'bun:test';
import { readScreen } from '../src/watch/screen.ts';

const CLOSED = '  Grok 4.7 256K High                 Run Everything';
const WORKSPACE = '  <workspace>';

function frame(status: string, workspace: string | null): string {
  const rows = [
    'the transcript says hello',
    '',
    '  → Add a follow-up',
    '',
    '',
    status,
  ];
  if (workspace !== null) rows.push(workspace);
  return `${rows.join('\n')}\n`;
}

test('a Grok row that runs on past the version is not the status row', () => {
  expect(readScreen('cursor', frame('  Grok 4.7 and more words', WORKSPACE)).kind).toBe('unknown');
  expect(readScreen('cursor', frame(CLOSED, WORKSPACE)).kind).toBe('idle');
});

test('a status row with no workspace line under it is not the row', () => {
  expect(readScreen('cursor', frame(CLOSED, null)).kind).toBe('unknown');
  expect(readScreen('cursor', frame(CLOSED, WORKSPACE)).kind).toBe('idle');
});
