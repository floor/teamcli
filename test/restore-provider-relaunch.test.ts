// A Claude Code seat on the shipped launcher with a provider other than Anthropic is launched
// again after a host restart, never adopted: the restart resumed the CLI without the provider's
// endpoint and key, and every turn then fails on the model.
import { expect, test } from 'bun:test';
import { restoreRelaunch } from '../src/launch/restore-proof.ts';

const proof = { kind: 'session' as const, pane: 'w1:p1', sentence: 'its conversation is the one the record names' };
const base = { proof, screen: null, status: 'idle', modelDiffers: false, channelQuiet: false };

test('a provider seat on the claude-code launcher is launched again', () => {
  expect(restoreRelaunch({ ...base, seat: { cli: 'claude-code', launch: 'claude', launcher: 'claude-code', vendor: 'deepseek' } })).toBe('launcher');
});

test('an Anthropic seat on the same launcher is adopted as before', () => {
  expect(restoreRelaunch({ ...base, seat: { cli: 'claude-code', launch: 'claude', launcher: 'claude-code', vendor: 'anthropic' } })).toBeNull();
});

test('a busy provider seat is held, never exited', () => {
  expect(restoreRelaunch({ ...base, status: 'working', seat: { cli: 'claude-code', launch: 'claude', launcher: 'claude-code', vendor: 'moonshot' } })).toBe('busy-line');
});
