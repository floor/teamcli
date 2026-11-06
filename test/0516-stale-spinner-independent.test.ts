import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readScreen } from '../src/watch/screen.ts';

test('an old transcript spinner cannot license a raw key or prove a prompt was submitted', async () => {
  const rows = readFileSync(new URL('./fixtures/grok/1.0.70/idle.txt', import.meta.url), 'utf8').split('\n');
  const box = rows.findLastIndex(row => row.includes('╭'));
  expect(box > 10).toBe(true);
  rows[box - 10] = '   ⠸ Waiting for response…        29s ⇣2.3k [stop]';
  const frame = rows.join('\n');
  expect(readScreen('grok', frame).kind).toBe('working');
  expect(readScreen('grok', frame, { working: 'cluster' }).kind).toBe('idle');
  const keys: string[] = [];
  const prompts: string[] = [];
  const host: TypedWakeHost = {
    read: () => frame,
    type: (_pane, text) => { keys.push(text); return true; },
    enter: () => { keys.push('ENTER'); return true; },
    prompt: (_pane, text) => { prompts.push(text); return true; },
    wait: async () => {},
  };
  const result = await deliverTypedWake(host, 'synthetic-pane', 'Read the synthetic task.', 'grok',
    { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 });
  expect(keys).toEqual([]);
  expect(prompts).toEqual(['Read the synthetic task.']);
  expect(result.delivered).toBe(false);
  expect(result.reason).toContain('no working screen');
});
