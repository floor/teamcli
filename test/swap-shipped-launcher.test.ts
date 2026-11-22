// team swap <seat> <shipped launcher>: the launcher's CLI, vendor and default model, which the
// swap's --model, --version, --vendor and --effort override; the seat keeps everything else.
import { expect, test } from 'bun:test';
import type { Seat } from '../src/file/types.ts';
import { shippedRecipe } from '../src/swap/preset.ts';

const seat = { name: 'worker', role: 'builder', cli: 'claude-code', vendor: 'moonshot', model: 'Kimi K3', version: '3', display: 'Kimi K3 3', launch: 'claude', cwd: '.', mode: 'shared', label: 'worker' } as unknown as Seat;

test('grok-build takes Grok 4.7 by default and a --version over it', () => {
  expect(shippedRecipe('grok-build', {}, seat)).toMatchObject({ cli: 'grok', vendor: 'xai', model: 'Grok', version: '4.7', launch: 'grok', launcher: 'grok-build' });
  expect(shippedRecipe('grok-build', { version: '5' }, seat)).toMatchObject({ version: '5', display: 'Grok 5' });
});

test('codex takes GPT Sol 6.1, antigravity Gemini Argon 4 at high effort', () => {
  expect(shippedRecipe('codex', {}, seat)).toMatchObject({ cli: 'codex', vendor: 'openai', model: 'GPT Sol', version: '6.1', launcher: 'codex' });
  expect(shippedRecipe('antigravity', {}, seat)).toMatchObject({ cli: 'antigravity', vendor: 'google', model: 'Gemini Argon', version: '4', effort: 'high', launch: 'agy' });
});

test('claude-code keeps the seat\'s own model on the same vendor, and asks for one on another', () => {
  expect(shippedRecipe('claude-code', {}, seat)).toMatchObject({ cli: 'claude-code', vendor: 'moonshot', model: 'Kimi K3', version: '3' });
  expect(shippedRecipe('claude-code', { vendor: 'deepseek' }, seat)).toEqual({ why: expect.stringContaining('--model and --version') });
  expect(shippedRecipe('claude-code', { vendor: 'anthropic', model: 'Claude Haiku', version: '5.5' }, seat)).toMatchObject({ vendor: 'anthropic', model: 'Claude Haiku', display: 'Claude Haiku 5.5' });
});

test('a vendor the launcher does not run, or a malformed version, is refused', () => {
  expect('why' in shippedRecipe('grok-build', { vendor: 'openai' }, seat)).toBe(true);
  expect('why' in shippedRecipe('codex', { version: 'six' }, seat)).toBe(true);
});
