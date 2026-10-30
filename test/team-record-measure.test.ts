import { expect, test } from 'bun:test';
import { recordText } from '../src/config/team-record.ts';

test('a value with its unit is written plain, so the validator reads it as a measure', () => {
  expect(recordText({ machine: { memory_start: '30%', swap_free_min: '500MB', window: '10m', name: '10 apples' } })).toBe('machine:\n  memory_start: 30%\n  swap_free_min: 500MB\n  window: 10m\n  name: "10 apples"\n');
});
