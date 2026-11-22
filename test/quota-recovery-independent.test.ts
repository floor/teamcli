// Historical quota walls must stay cleared after a fresh prompt shows headroom.
// Exhausted windows, unmatched live limits and recognized dialog provenance remain covered.
import { describe, expect, test } from 'bun:test';
import { classify, classifyData, readScreen, screenData } from '../src/watch/screen.ts';
import { classifyWith, parseOverrides } from '../src/profiles/overrides.ts';
import { claudeBox } from './helpers.ts';
import { quotaOutOf } from '../src/send/quota-out.ts';

const CODEX_429 = '429 rate limit reached · You’ve hit your usage limit for 5h. Try again at 3:05 PM.';
const CODEX_OWN = 'You’ve hit your usage limit for 5h. Switch to another model now, or try again at 3:05 PM.';
const FULL = '  GPT-6.1-Sol ultra · Context 100% left · weekly 100% left';
const EMPTY = '  GPT-6.1-Sol ultra · Context 100% left · weekly 0% left';
const WEEKLY = 'weekly quota exhausted until tomorrow';
const codex = (limit: string, row: string | null) =>
  [limit, '', '› ', '', ...(row === null ? [] : [row])].join('\n');

describe('quota recovery through the token fallback', () => {
  test('a phrase-bearing limit above a fresh prompt with headroom stays history', () => {
    const text = codex(CODEX_429, FULL);
    expect(classify('codex', text.split('\n')).kind).toBe('idle'); // the core clears it
    expect(readScreen('codex', text)).toEqual({ kind: 'idle' }); // the fallback must not re-wall it
    expect(quotaOutOf('codex', text)).toBeNull(); // and the send preflight must see no wall
  });

  test('the same geometry with a limit wording the fallback phrase list does not carry stays history', () => {
    const text = codex(CODEX_OWN, FULL);
    expect(classify('codex', text.split('\n'))).toEqual({ kind: 'idle' });
    expect(readScreen('codex', text)).toEqual({ kind: 'idle' });
    expect(quotaOutOf('codex', text)).toBeNull();
  });

  test('an exhausted window keeps the wall as the rule’s own reading, not the fallback’s', () => {
    const text = codex(CODEX_429, EMPTY);
    expect(classify('codex', text.split('\n')).kind).toBe('rate limit');
    expect(readScreen('codex', text)).toEqual({ kind: 'rate limit', reset: { kind: 'at', value: '3:05 PM' } });
    expect(quotaOutOf('codex', text)).toEqual({ reset: { kind: 'at', value: '3:05 PM' } });
  });

  test('a phrase-bearing limit with no readable prompt keeps the wall', () => {
    const text = codex(CODEX_429, null);
    expect(classify('codex', text.split('\n')).kind).toBe('rate limit');
    expect(readScreen('codex', text).kind).toBe('rate limit');
    expect(quotaOutOf('codex', text)).toEqual({ reset: { kind: 'at', value: '3:05 PM' } });
  });

  test('the fallback still catches a tail phrase no shipped rule recognizes', () => {
    const text = [WEEKLY, '', '› '].join('\n');
    const read = readScreen('codex', text);
    expect(read.kind).toBe('rate limit');
    expect((read as { reason?: string }).reason).toBe('out of tokens');
    expect(quotaOutOf('codex', text)).toEqual({ reset: null, outOfTokens: true });
  });
});

// claude-code: measured safe today because the composer box holds the phrase above the 6-line
// tail window. Kept as a regression: a box/tail change that pulls the phrase into the tail
// must go red here, not in production.
const CC_LIMIT = 'API Error: Request rejected (429) · Usage limit reached for 5 hour. Your limit will reset at 11:00';
const CC_ROW = ' L: 20% (1h) · W: 40% (40h)';
const CC_ROW_EMPTY = ' L: 20% (1h) · W: 100% (40h)';
const cc = (row: string) => [CC_LIMIT, claudeBox(''), row].join('\n');

describe('Claude Code quota recovery geometry', () => {
  test('history with headroom reads idle end to end (phrase above the tail window)', () => {
    const text = cc(CC_ROW);
    expect(classify('claude-code', text.split('\n')).kind).toBe('idle');
    expect(readScreen('claude-code', text)).toEqual({ kind: 'idle' });
    expect(quotaOutOf('claude-code', text)).toBeNull();
  });
  test('an exhausted weekly window keeps the wall', () => {
    const text = cc(CC_ROW_EMPTY);
    expect(readScreen('claude-code', text).kind).toBe('rate limit');
    expect(quotaOutOf('claude-code', text)).toEqual({ reset: { kind: 'at', value: '11:00' } });
  });
});

// A rule-recognized unknown screen keeps its
// provenance instead of being overwritten by the fallback.
describe('dialog provenance through the quota reader', () => {
  for (const kind of ['unknown', 'permission'] as const) {
    test(`a custom ${kind} rule match survives the fallback`, () => {
      const parsed = parseOverrides(`format: 1\nprofiles:\n  claude-code:\n    screen:\n      ${kind}:\n        - any: ['^Custom modal$']\n`);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const limit = 'There’s an issue with the selected model (k3-256k)';
      const text = ['Custom modal', limit, '❯ '].join('\n');
      const read = classifyWith('claude-code', text, parsed.profiles);
      if (kind === 'unknown') {
        expect(read.kind).toBe('unknown');
        expect((read as { provenance?: string }).provenance).toBe('custom');
      } else {
        expect(read.kind).toBe('permission'); // recognized before the tail fallback can look
      }
    });
  }
  test('a floor dialog, a profile-recognized unknown and a working turn keep their readings', () => {
    const limit = 'There’s an issue with the selected model (k3-256k)';
    const floor = [limit, 'A new dialog the profile never saw', 'Do you want to continue?'].join('\n');
    const exited = [limit, 'Resume this session with:', 'claude --resume fixture-session'].join('\n');
    const working = [limit, 'esc to interrupt'].join('\n');
    expect(readScreen('claude-code', floor).kind).toBe('unknown');
    const exitedRead = readScreen('claude-code', exited);
    expect(exitedRead.kind).toBe('unknown'); // profile-recognized unknown: the fallback must not convert it
    expect((exitedRead as { provenance?: string }).provenance).toBe('profile');
    expect(readScreen('claude-code', working).kind).toBe('working');
    const raw = limit + '\n❯ ';
    expect(classifyData(screenData('claude-code')!, raw.split('\n')).kind).toBe('unknown'); // no shipped rule carries it
    const rawRead = readScreen('claude-code', raw);
    // The tail fallback converts what no rule recognized: this sentence is a model fault (17 Nov),
    // never out of tokens.
    expect(rawRead).toEqual({ kind: 'provider error', reason: 'model' });
  });
});
