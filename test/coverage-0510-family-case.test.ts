// The family test that decides whether a Claude Code seat's screen can speak for its model: the
// seat's spelling of the CLI's family is not its model's identity, so any case of `claude` reads
// as the CLI's own family and the screen stands; a word that merely starts with those letters is
// another declaration, and only the launch line decides whether it is a wrapper.
import { describe, expect, test } from 'bun:test';
import { foreignModelOnClaudeCode, signedSeatModel, wrapperSeat } from '../src/status/statusline.ts';

const SCREEN = ['❯ ', '─'.repeat(40), '  main · …/glow · Opus 5.5 · S: $1.2 · W: 12%', ''].join('\n');

describe('the Claude family test', () => {
  test('is case- and spacing-blind, so the CLI’s own declaration keeps the screen reading', () => {
    for (const model of ['CLAUDE 5', 'Claude Opus', '  claude  ']) {
      const seat = { cli: 'claude-code', model, version: '5.5', launch: 'claude' };
      expect(foreignModelOnClaudeCode(seat)).toBe(false);
      expect(wrapperSeat(seat)).toBe(false);
      expect(signedSeatModel(seat, SCREEN)).toEqual({ model: 'Claude Opus', version: '5.5' });
    }
  });

  test('ends at the word boundary: a longer name is another maker’s declaration', () => {
    const seat = { cli: 'claude-code', model: 'Claudette 5', version: '5.5', launch: 'claude' };
    expect(foreignModelOnClaudeCode(seat)).toBe(true);
    // The launch starts the CLI itself, so the screen is the CLI's own and is read — this is the
    // contradiction the declared model needs, not a wrapper.
    expect(wrapperSeat(seat)).toBe(false);
    expect(signedSeatModel(seat, SCREEN)).toEqual({ model: 'Claude Opus', version: '5.5' });
  });

  test('a foreign model with stray spacing is still foreign, and a named wrapper proves it', () => {
    const seat = { cli: 'claude-code', model: ' glM 5 ', version: '5.3', launch: 'claude-glm.sh' };
    expect(foreignModelOnClaudeCode(seat)).toBe(true);
    expect(wrapperSeat(seat)).toBe(true);
    expect(signedSeatModel(seat, SCREEN)).toEqual({ model: ' glM 5 ', version: '5.3' });
  });
});
