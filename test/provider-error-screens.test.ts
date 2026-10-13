// Claude Code's provider-error and rate-limit screens, built from the sentences a seat printed.
// The box under the error is the idle box, which is what the watch used to see.
import { describe, expect, test } from 'bun:test';
import { claudeBox } from './helpers.ts';
import { classifyComposer, readScreen } from '../src/watch/screen.ts';

const lost = `API Error: Connection lost mid-response. The response above may be incomplete.\n${claudeBox('')}`;
const limit = `API Error: Request rejected (429) · Usage limit reached for 5 hour. Your limit will reset at 11:00\n${claudeBox('')}`;

describe('Claude Code provider errors', () => {
  test('connection lost above an idle box is a provider error, and the box alone is not a prompt', () => {
    expect(readScreen('claude-code', lost)).toEqual({ kind: 'provider error' });
    expect(classifyComposer('claude-code', lost.split('\n')).kind).toBe('unknown');
    expect(readScreen('claude-code', claudeBox(''))).toEqual({ kind: 'idle' });
  });

  test('a 429 above an idle box is a rate limit and carries the reset time', () => {
    expect(readScreen('claude-code', limit)).toEqual({ kind: 'rate limit', reset: '11:00' });
    expect(classifyComposer('claude-code', limit.split('\n')).kind).toBe('unknown');
  });

  test('a working line does not hide the error', () => {
    const both = `API Error: Connection lost mid-response. The response above may be incomplete.\nesc to interrupt\n${claudeBox('')}`;
    expect(readScreen('claude-code', both).kind).toBe('provider error');
  });
});
