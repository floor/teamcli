// 17 Nov restart: every DeepSeek-on-Claude seat answered its turn with "There's an issue with the
// selected model (deepseek-flash)" because the terminal host resumed the bare CLI without its
// launcher's endpoint. The out-of-tokens reader took that sentence for quota, marked the seats
// unavailable and told the lead to wait for a reset. It is a launch or model fault: a provider
// error on the model, which `seatCanWork` reports as "model failing" and `team up` repairs.
import { describe, expect, test } from 'bun:test';
import { modelFaultTail, outOfTokensState, outOfTokensTail } from '../src/quota/token-fallback.ts';
import { seatCanWork } from '../src/watch/seat-can-work.ts';
import { readScreen } from '../src/watch/screen.ts';

const SENTENCE = "There's an issue with the selected model (deepseek-flash). It may not exist or you may not have access to it. Run /model to pick a different model.";
const LIVE = `⏺ ${SENTENCE}\n❯ `;

describe('the model-issue sentence is a model fault, not quota', () => {
  test('the live tail reads as a provider error on the model', () => {
    expect(readScreen('claude-code', LIVE)).toEqual({ kind: 'provider error', reason: 'model' });
    expect(modelFaultTail('claude-code', LIVE)).toBe(true);
    expect(outOfTokensTail('claude-code', LIVE)).toBe(false);
    expect(outOfTokensState(readScreen('claude-code', LIVE))).toBeNull();
  });

  test('a seat showing it cannot work because its model is failing, never out of tokens', () => {
    const verdict = seatCanWork({ seat: 'implementer-deepseek', cli: 'claude-code', screen: LIVE });
    expect(verdict).toMatchObject({ ok: false, reason: 'model failing', line: 'not delivered: model failing' });
  });

  test('a real usage limit is still out of tokens', () => {
    const limit = 'Usage limit reached\n❯ ';
    expect(readScreen('claude-code', limit)).toEqual({ kind: 'rate limit', reset: null, reason: 'out of tokens' });
    expect(modelFaultTail('claude-code', limit)).toBe(false);
  });

  test('a running turn that mentions the sentence stays a running turn', () => {
    expect(readScreen('claude-code', `${SENTENCE}\nesc to interrupt\n`).kind).toBe('working');
  });

  test('a CLI with no profile is never guessed', () => {
    expect(modelFaultTail('unknown-cli', LIVE)).toBe(false);
  });
});
