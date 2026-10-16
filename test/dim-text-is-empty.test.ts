import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { allDimAfter, stripSgr } from '../src/ansi.ts';
import { boxHoldsText, deliverRules, type Delivery } from '../src/launch/deliver.ts';
import { readScreen } from '../src/watch/screen.ts';

// Dim text in an input box is a suggestion, not text. These scenes are built from the repo's own
// ANSI captures (`pane read --format ansi`), swapping words and never the styling bytes, so each
// one differs from a capture only where the comment says.

const claude = (name: string): string => readFileSync(new URL(`./fixtures/claude-code/2.1.289/${name}.txt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const exitTyping = (name: string): string => readFileSync(new URL(`./fixtures/exit-typing/${name}.txt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const ESC = '\x1b';
const FAINT = `${ESC}[0m${ESC}[2m`;
const RESET = `${ESC}[0m`;

/** The Claude Code idle capture with its input row swapped, and rows added under it. */
function claudeWith(inputRow: string, ...below: string[]): string {
  const rows = claude('idle-suggestion-ansi').split('\n');
  const at = rows.findIndex((row) => row.startsWith('\u276f\u00a0'));
  rows.splice(at, 1, inputRow, ...below);
  return rows.join('\n');
}

describe('a faint suggestion is an empty box', () => {
  test('Claude Code: the captured suggestion reads idle, and the captured typed text unsent', () => {
    expect(readScreen('claude-code', claude('idle-suggestion-ansi')).kind).toBe('idle');
    expect(readScreen('claude-code', claude('unsent-typed-ansi')).kind).toBe('unsent');
  });

  test('Claude Code: a suggestion the list never named is idle, and holds no text', () => {
    const screen = claude('idle-suggestion-other-ansi');
    expect(readScreen('claude-code', screen).kind).toBe('idle');
    expect(boxHoldsText('claude-code', 'Rules.', screen)).toBe(false);
    // The same words without styling are the documented limit: plain text cannot be told apart.
    expect(readScreen('claude-code', stripSgr(screen)).kind).toBe('unsent');
  });

  test("Claude Code: a suggestion that wraps onto a second row is still idle", () => {
    const screen = claudeWith(
      `\u276f\u00a0${FAINT}check the CI result of the open pull request and report which tests failed on${RESET}`,
      `  ${FAINT}the hosted run${RESET}`,
    );
    expect(readScreen('claude-code', screen).kind).toBe('idle');
    expect(boxHoldsText('claude-code', 'Rules.', screen)).toBe(false);
  });

  test('Claude Code: one plain character on the wrapped row, or a plain row, is text', () => {
    const first = `\u276f\u00a0${FAINT}check the CI result of the open pull request and report which tests failed on${RESET}`;
    expect(readScreen('claude-code', claudeWith(first, `  ${FAINT}the hosted ru${RESET}n`)).kind).toBe('unsent');
    expect(readScreen('claude-code', claudeWith(first, '  the hosted run')).kind).toBe('unsent');
    // And a faint first row with typed text after it on the same row is text too.
    expect(readScreen('claude-code', claudeWith(`\u276f\u00a0${FAINT}check${RESET} the CI`)).kind).toBe('unsent');
  });

  test('Claude Code: the wrapped suggestion read without styling stays unsent, as before', () => {
    const screen = claudeWith(
      `\u276f\u00a0${FAINT}check the CI result of the open pull request and report which tests failed on${RESET}`,
      `  ${FAINT}the hosted run${RESET}`,
    );
    expect(readScreen('claude-code', stripSgr(screen)).kind).toBe('unsent');
  });

  test('Codex: the captured placeholder is idle, and a placeholder of other words is too', () => {
    const idle = exitTyping('codex-idle-ansi');
    expect(readScreen('codex', idle).kind).toBe('idle');
    // Codex shows other words in other sessions; same bytes, other words.
    const other = idle.replace('Ask Codex to do anything', 'Summarize recent commits');
    expect(other).not.toBe(idle);
    expect(readScreen('codex', other).kind).toBe('idle');
    expect(boxHoldsText('codex', 'Rules.', other)).toBe(false);
  });

  test('Codex: the captured typed text is unsent, and the placeholder bytes with the faint switch off are text', () => {
    expect(readScreen('codex', exitTyping('codex-unsent-ansi')).kind).toBe('unsent');
    const idle = exitTyping('codex-idle-ansi');
    const typed = idle.replace(`${ESC}[2mAsk Codex to do anything`, 'Ask Codex to do anything');
    expect(typed).not.toBe(idle);
    expect(readScreen('codex', typed).kind).toBe('unsent');
  });

  test('Cursor: the captured placeholder, with its inverse cursor cell, is idle', () => {
    expect(readScreen('cursor', exitTyping('cursor-idle-ansi')).kind).toBe('idle');
    expect(readScreen('cursor', exitTyping('cursor-unsent-ansi')).kind).toBe('unsent');
  });

  test('Cursor: a placeholder of other words in the same styling is idle', () => {
    const idle = exitTyping('cursor-idle-ansi');
    const other = idle.replace('mP\x1b[0m', 'mR\x1b[0m').replace('lan, search, build anything', 'efactor the parser');
    expect(other).not.toBe(idle);
    expect(readScreen('cursor', other).kind).toBe('idle');
    expect(boxHoldsText('cursor', 'Rules.', other)).toBe(false);
  });

  test('Cursor: text under the cursor cell is text', () => {
    const idle = exitTyping('cursor-idle-ansi');
    // The cursor cell on the first character, the rest of the line drawn plain.
    const typed = idle.replace(`${ESC}[2m${ESC}[48;2;21;21;21mlan, search, build anything`, `${ESC}[48;2;21;21;21mlan, search, build anything`);
    expect(typed).not.toBe(idle);
    expect(readScreen('cursor', typed).kind).toBe('unsent');
  });
});

describe('allDimAfter and the cursor cell', () => {
  const inverse = `${ESC}[0m${ESC}[7m`;

  test('faint after the prompt is dim, plain is not', () => {
    expect(allDimAfter(`> ${FAINT}suggestion${RESET}`, 1)).toBe(true);
    expect(allDimAfter('> suggestion', 1)).toBe(false);
    expect(allDimAfter('>', 1)).toBe(true);
  });

  test('an inverse first character followed by faint text is dim', () => {
    expect(allDimAfter(`> ${inverse}s${FAINT}uggestion${RESET}`, 1)).toBe(true);
  });

  test('an inverse first character followed by plain text is not', () => {
    expect(allDimAfter(`> ${inverse}s${RESET}uggestion`, 1)).toBe(false);
  });

  test('an inverse character that is not the first, or a second one, is not', () => {
    expect(allDimAfter(`> ${FAINT}s${RESET}${inverse}u${FAINT}ggestion${RESET}`, 1)).toBe(false);
    expect(allDimAfter(`> ${inverse}su${FAINT}ggestion${RESET}`, 1)).toBe(false);
  });

  test('an inverse blank cell is nothing, an inverse cell after plain text is text', () => {
    expect(allDimAfter(`> ${inverse} ${RESET}`, 1)).toBe(true);
    expect(allDimAfter(`> typed${inverse} ${RESET}`, 1)).toBe(false);
  });

  test('an inverse cell reset by 27 or 0 is plain again', () => {
    expect(allDimAfter(`> ${ESC}[7ms${ESC}[27muggestion`, 1)).toBe(false);
    expect(allDimAfter(`> ${ESC}[7m${ESC}[0msuggestion`, 1)).toBe(false);
  });
});

describe('the rules read-back over a faint suggestion', () => {
  function delivery(startScreen: string) {
    let raw = startScreen;
    let status = 'idle';
    let clock = 0;
    const calls: string[] = [];
    const io: Delivery = {
      screen: () => raw,
      status: () => status,
      file: () => true,
      // The paste renders as the box the CLI draws for its text: the capture with its input row.
      type(text) {
        calls.push(text);
        raw = claudeWith(`\u276f\u00a0${text}`);
        return true;
      },
      enter() {
        calls.push('Enter');
        raw = claudeWith('\u276f\u00a0');
        status = 'working';
        return true;
      },
      foreground: () => ['claude'],
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    };
    return { io, calls };
  }

  test('a faint suggestion is an empty box: the rules are typed and sent', async () => {
    const d = delivery(claude('idle-suggestion-other-ansi'));
    expect(await deliverRules('claude-code', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
  });

  test('a wrapped faint suggestion is an empty box too', async () => {
    const wrapped = claudeWith(
      `\u276f\u00a0${FAINT}check the CI result of the open pull request and report which tests failed on${RESET}`,
      `  ${FAINT}the hosted run${RESET}`,
    );
    const d = delivery(wrapped);
    expect(await deliverRules('claude-code', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
  });

  test('typed text in the box is not: the rules are not typed over it', async () => {
    const d = delivery(claude('unsent-typed-ansi'));
    expect(await deliverRules('claude-code', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });
});
