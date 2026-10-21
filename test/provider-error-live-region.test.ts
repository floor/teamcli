// The provider-error sentence a seat printed stays in the pane after the seat runs again.
// The field report's pane: a seat idle at its prompt, and an earlier "connection lost" line
// two turns above it. send answered "unreachable: the screen reads provider error". The
// sentence is read on the live region alone — the box's own rows and the newest turn above
// them — so a turn the pane has scrolled past is not the dialog. The screens here are the
// captured 2.1.289 idle box with the turns a session leaves above it; no live pane.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { claudeBox } from './helpers.ts';
import { dialogKind } from '../src/send/deliver.ts';
import { classifyComposer, readScreen } from '../src/watch/screen.ts';
import { loadScreen } from '../src/watch/screen-file.ts';

const LOST = 'API Error: Connection lost mid-response. The response above may be incomplete.';

// The field report's pane: the error, then a later turn, and the answer to the task after
// that as the newest turn above the idle box.
const oldError = [
  '❯ first task',
  '',
  '⏺ First task done.',
  '',
  LOST,
  '',
  '✻ Sautéed for 2s · done 5:25 PM',
  '',
  '❯ second task',
  '',
  '⏺ Second task done as well.',
  '',
  claudeBox(''),
].join('\n');

// The error is the newest turn's own row, but the turn's result line comes after it: the turn
// ended after the error, so the error is history and the empty box under the result line is the
// current prompt. The current contract (2026-10-21) supersedes the old expectation — a
// completion after the error moves the read from provider error to the current screen.
const endedAfterError = `${LOST}\n✻ Sautéed for 2s · done 5:25 PM\n${claudeBox('')}`;

describe('a provider error in scrollback above an idle prompt', () => {
  test('the error two turns up is not the dialog, and the prompt is free', () => {
    expect(readScreen('claude-code', oldError)).toEqual({ kind: 'idle' });
    expect(dialogKind('claude-code', oldError)).toBeNull();
    expect(classifyComposer('claude-code', oldError.split('\n')).kind).toBe('idle');
  });

  test('the turn ended after the error, so the empty prompt is the current screen', () => {
    expect(readScreen('claude-code', endedAfterError)).toEqual({ kind: 'idle' });
    expect(dialogKind('claude-code', endedAfterError)).toBeNull();
    expect(classifyComposer('claude-code', endedAfterError.split('\n')).kind).toBe('idle');
  });

  test('the captured provider-error screen still reads as one', () => {
    const captured = readFileSync(new URL('./fixtures/claude-code/provider-error.txt', import.meta.url), 'utf8');
    expect(readScreen('claude-code', captured)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', captured)).toBe('provider error');
  });

  test('a window whose box cannot be read keeps the whole window, error and all', () => {
    // No composer rule to place the region: the caution stays where it was, and an error
    // anywhere in the window is the screen.
    const withoutBox = `${LOST}\n\n⏺ Running the suite…\n`;
    expect(readScreen('claude-code', withoutBox)).toEqual({ kind: 'provider error' });
  });
});

describe('the live key of a rule', () => {
  const profile = (rule: string): string => `
format: 1
cli: sample
screen:
  provider_error:
${rule}
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholders:
      - equals: ''
`;

  test('live reads with any or all, and the loaded rule carries it', () => {
    for (const list of [`any: ['lost']`, `all: ['lost']`]) {
      const data = loadScreen(profile(`    - ${list}
      live: true`));
      expect(data.provider_error?.rules[0]?.live).toBe(true);
    }
  });

  test('the loader refuses the shapes live cannot narrow, in its own words', () => {
    const refuses = (rule: string, message: string): void => {
      expect(() => loadScreen(profile(rule))).toThrow(message);
    };
    // `live` narrows `any` or `all`; alone it narrows nothing.
    refuses(`    - footer: 'Esc to cancel'
      live: true`, '"live" narrows "any" or "all": it needs one of them');
    // The other primitives place their own rows, so a rule pairing one with `live` would be
    // read as neither.
    refuses(`    - any: ['lost']
      footer: 'Esc to cancel'
      live: true`, '"live" reads with "any" or "all" alone, never beside another primitive');
    refuses(`    - all: ['lost']
      without_rule: true
      live: true`, '"live" reads with "any" or "all" alone, never beside another primitive');
    refuses(`    - any: ['lost']
      live: 'yes'`, '"live" must be true or false');
  });
});
