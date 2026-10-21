// The provider-error sentence a seat printed stays in the pane after the seat runs again.
// The field report's pane: a seat idle at its prompt, and an earlier "connection lost" line
// above it. send answered "unreachable: the screen reads provider error". The sentence is read
// on the live region alone — the box's own rows and the newest turn above them — so a turn the
// pane has scrolled past is not the dialog. A turn the CLI's own completion row already ended
// is history too: the rows above the last completion belong to a turn that is over, and the
// empty box under it is a fresh ready prompt. The screens here are the captured 2.1.289 idle
// box with the turns a session leaves above it; no live pane.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { claudeBox } from './helpers.ts';
import { dialogKind } from '../src/send/deliver.ts';
import { classifyComposer, readScreen } from '../src/watch/screen.ts';
import { loadScreen } from '../src/watch/screen-file.ts';

const LOST = 'API Error: Connection lost mid-response. The response above may be incomplete.';
const DONE = '✻ Sautéed for 8m 33s · done 8:51 PM';

// The approved observation (teamcli-notes briefs-0.5.4, 2026-10-21): an echoed prompt, the
// turn's thought line, the error, and the completion the turn ended with — verbatim rows. The
// box under them is the captured idle frame, composed here independently: the note's tail was
// trimmed at a labelled divider and is not a composer frame, so the note's literal tail is
// never fed to the reader as if it were one.
const observed = [
  '❯ From orchestrator@teamcli: run team drops --read --seat documentarist --session teamcli and do that.',
  '  Thought for 17s, ran 4 shell commands',
  `⏺ ${LOST}`,
  DONE,
  claudeBox(''),
].join('\n');

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

// The error's own turn ended: the completion the CLI drew after it closes that turn, and the
// box below is a new ready prompt. This is the shape Atlas observed on an idle, ready seat.
const completedTurn = `${LOST}\n${DONE}\n${claudeBox('')}`;

// No completion after the error: the box under it is not a free prompt.
const currentError = `${LOST}\n${claudeBox('')}`;

describe('a provider error in scrollback above an idle prompt', () => {
  test('the error two turns up is not the dialog, and the prompt is free', () => {
    expect(readScreen('claude-code', oldError)).toEqual({ kind: 'idle' });
    expect(dialogKind('claude-code', oldError)).toBeNull();
    expect(classifyComposer('claude-code', oldError.split('\n')).kind).toBe('idle');
  });

  test('the observed turn: the error the completion ended is history above a ready box', () => {
    expect(readScreen('claude-code', observed)).toEqual({ kind: 'idle' });
    expect(dialogKind('claude-code', observed)).toBeNull();
    expect(classifyComposer('claude-code', observed.split('\n')).kind).toBe('idle');
  });

  test('an error with no completion after it is still the live screen', () => {
    expect(readScreen('claude-code', currentError)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', currentError)).toBe('provider error');
    expect(classifyComposer('claude-code', currentError.split('\n')).kind).toBe('unknown');
  });

  test('a completion before a fresh error does not dismiss that error', () => {
    const fresh = `${DONE}\n${LOST}\n${claudeBox('')}`;
    expect(readScreen('claude-code', fresh)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', fresh)).toBe('provider error');
    expect(classifyComposer('claude-code', fresh.split('\n')).kind).toBe('unknown');
  });

  test('a completion with the shell detail still ends its turn', () => {
    const withShell = `${LOST}\n✻ Cogitated for 3s · done 11:36 PM · 1 shell still\n${claudeBox('')}`;
    expect(readScreen('claude-code', withShell)).toEqual({ kind: 'idle' });
  });

  test('quoted, indented, malformed or truncated completion text does not end the turn', () => {
    for (const line of [
      `⏺ The log said "${DONE}"`,
      `  ${DONE}`,
      '✻ Sautéed for 8m 33s · done soon',
      '✻ Sautéed for 8m 33s · don',
      '✻ Sautéed for 8m 33s · done 8:51 PM extra',
    ]) {
      const screen = `${LOST}\n${line}\n${claudeBox('')}`;
      expect(readScreen('claude-code', screen)).toEqual({ kind: 'provider error' });
      expect(dialogKind('claude-code', screen)).toBe('provider error');
    }
  });

  test('completion-shaped text typed in the box does not end the turn', () => {
    const screen = `${LOST}\n${claudeBox(DONE)}`;
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', screen)).toBe('provider error');
    expect(classifyComposer('claude-code', screen.split('\n')).kind).toBe('unknown');
  });

  test('the captured provider-error screen still reads as one', () => {
    const captured = readFileSync(new URL('./fixtures/claude-code/provider-error.txt', import.meta.url), 'utf8');
    expect(readScreen('claude-code', captured)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', captured)).toBe('provider error');
  });

  test('a window whose box cannot be read keeps the whole window, error and all', () => {
    // No composer rule to place the region: the caution stays where it was, and an error
    // anywhere in the window is the screen. A completion cannot be tied to a readable ready
    // box here, so the reader keeps its caution and types nothing.
    const withoutBox = `${LOST}\n${DONE}\n\n⏺ Running the suite…\n`;
    expect(readScreen('claude-code', withoutBox)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', withoutBox)).toBe('provider error');
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

describe('the turn_end row', () => {
  const profile = (turnEnd: string): string => `
format: 1
cli: sample
screen:
${turnEnd}
  provider_error:
    - any: ['lost']
      live: true
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholders:
      - equals: ''
`;

  test('the loaded profile carries the compiled pattern', () => {
    const data = loadScreen(profile(`  turn_end: '^done [0-9]+$'`));
    expect(data.turnEnd?.test('done 2')).toBe(true);
    expect(data.turnEnd?.test('done two')).toBe(false);
  });

  test('the loader refuses an unanchored or non-string turn_end, in its own words', () => {
    expect(() => loadScreen(profile(`  turn_end: 'done [0-9]+'`))).toThrow(
      'a turn_end pattern must match the whole line: "^…$"',
    );
    expect(() => loadScreen(profile('  turn_end: [a]'))).toThrow('"turn_end" must be a string');
  });
});
