// Atlas's retained RC2 frame, captured 2026-10-22T03:01:25Z from a seat running installed
// TeamCLI 0.5.4-rc.2 (source 4e50561d46a29e0452908fece2a2573cb8f93124). The pane shows no CLI
// version marker, so the CLI's own version is unknown. The seat's turn printed the CLI's
// connection-lost sentence and then ended; the composer under the transcript was empty. The
// opening rule of that composer carries the seat's name in its run, which is the layout the
// reading has to place. In the fixture the tool-result rows above the error and the account
// figures in the status row are sanitized; every decisive row is the capture's bytes.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { claudeBox } from './helpers.ts';
import { dialogKind } from '../src/send/deliver.ts';
import { classifyComposer, readScreen, screenWord } from '../src/watch/screen.ts';

const FRAME = readFileSync(
  new URL('./fixtures/claude-code/completed-error-empty-box-atlas.txt', import.meta.url),
  'utf8',
);
const LOST = 'API Error: Connection lost mid-response. The response above may be incomplete.';
const DONE = '✻ Cooked for 5m 51s · done 4:49 AM';

/** The captured frame with text in its input row (the box's one bare `❯`). */
function withDraft(screen: string, text: string): string {
  const lines = screen.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === '❯') {
      lines[i] = `❯ ${text}`;
      return lines.join('\n');
    }
  }
  throw new Error('the frame has no bare input row');
}

/** The captured frame without its closing rule: no box can be placed, so the whole window
 *  stays the screen, exactly as a window whose frame scrolled away. */
function withoutClosingRule(screen: string): string {
  const lines = screen.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^─{8,}$/u.test(lines[i] as string)) {
      lines.splice(i, 1);
      return lines.join('\n');
    }
  }
  throw new Error('the frame has no plain closing rule');
}

/** The captured frame with its labelled opening rule one column shorter, so the box's two rules
 *  no longer stand at one width. */
function narrowerOpeningRule(screen: string): string {
  return screen.replace(/^─+ builder-7 ─$/mu, (row) => row.replace(/^─/u, ''));
}

/** The captured frame with its plain closing rule one column shorter, the width mismatch on the
 *  other side of the box. */
function narrowerClosingRule(screen: string): string {
  const lines = screen.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^─{8,}$/u.test(lines[i] as string)) {
      lines[i] = (lines[i] as string).slice(1);
      return lines.join('\n');
    }
  }
  throw new Error('the frame has no plain closing rule');
}

describe('the completed-provider-error frame', () => {
  test('the fixture keeps the captured rows the reading is about', () => {
    const rows = FRAME.split('\n');
    expect(rows).toContain(`⏺ ${LOST}`);
    expect(rows).toContain(DONE);
    expect(rows).toContain('  ⏵⏵ bypass permissions on (shift+tab to cycle)');
    expect(rows.some((row) => /^─{8,} builder-7 ─$/u.test(row))).toBe(true);
    expect(rows.filter((row) => row === '❯')).toHaveLength(1);
  });

  test('the captured frame reads idle: a turn the completion ended is history above a ready box', () => {
    expect(readScreen('claude-code', FRAME)).toEqual({ kind: 'idle' });
    expect(dialogKind('claude-code', FRAME)).toBeNull();
    expect(classifyComposer('claude-code', FRAME.split('\n')).kind).toBe('idle');
    expect(screenWord(readScreen('claude-code', FRAME))).toBe('idle');
  });

  test('the captured frame with text in its box reads unsent, never idle', () => {
    const typed = withDraft(FRAME, 'a draft in the box');
    expect(readScreen('claude-code', typed)).toEqual({ kind: 'unsent' });
    expect(classifyComposer('claude-code', typed.split('\n')).kind).toBe('unsent');
    expect(dialogKind('claude-code', typed)).toBeNull();
  });

  test('a window that cannot place a box keeps the whole window, error and all', () => {
    const unreadable = withoutClosingRule(FRAME);
    expect(readScreen('claude-code', unreadable)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', unreadable)).toBe('provider error');
    expect(classifyComposer('claude-code', unreadable.split('\n')).kind).toBe('unknown');
  });

  test('a labelled opening rule drawn at another width fails closed', () => {
    const narrow = narrowerOpeningRule(FRAME);
    expect(narrow).not.toBe(FRAME);
    expect(readScreen('claude-code', narrow)).toEqual({ kind: 'provider error' });
  });

  test('the same transcript above a plain rule box is ready: only the label stood in the way', () => {
    const plain = FRAME.replace(/^─+ builder-7 ─$/mu, '─'.repeat(187));
    expect(plain).not.toBe(FRAME);
    expect(readScreen('claude-code', plain)).toEqual({ kind: 'idle' });
    expect(classifyComposer('claude-code', plain.split('\n')).kind).toBe('idle');
  });

  test('a box drawn with the minimum eight-column borders reads ready', () => {
    // The capture's box is wide and its opening rule is labelled; the shortest border the
    // profile accepts is the flat eight-column rule, and the ended turn above it stays history.
    const screen = [LOST, DONE, '────────', '❯', '────────'].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'idle' });
    expect(classifyComposer('claude-code', screen.split('\n')).kind).toBe('idle');
  });

  test('a closing rule drawn at another width fails closed', () => {
    const narrower = narrowerClosingRule(FRAME);
    expect(narrower).not.toBe(FRAME);
    expect(readScreen('claude-code', narrower)).toEqual({ kind: 'provider error' });
  });
});

describe('the transcript above the composer, on a box the captures draw', () => {
  test('a blank row between the error and its completion does not make the error live', () => {
    const screen = [LOST, '', DONE, claudeBox('')].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'idle' });
  });

  test('an error with no completion after it is still the live screen', () => {
    const screen = [LOST, claudeBox('')].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', screen)).toBe('provider error');
    expect(classifyComposer('claude-code', screen.split('\n')).kind).toBe('unknown');
  });

  test('a completion before a fresh error does not dismiss that error', () => {
    const screen = [DONE, LOST, claudeBox('')].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', screen)).toBe('provider error');
  });

  test('a box holding text is not a free box', () => {
    const screen = [LOST, DONE, claudeBox('a draft')].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'unsent' });
    expect(classifyComposer('claude-code', screen.split('\n')).kind).toBe('unsent');
    expect(dialogKind('claude-code', screen)).toBeNull();
  });

  test('a completion quoted in prose does not end the turn', () => {
    const screen = [LOST, `⏺ The log said "${DONE}"`, claudeBox('')].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', screen)).toBe('provider error');
  });

  test('an error sentence quoted in prose above the completion is history', () => {
    const screen = [`⏺ The log said "${LOST}"`, DONE, claudeBox('')].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'idle' });
  });

  test('indented or truncated completion text does not end the turn', () => {
    for (const row of [`  ${DONE}`, '✻ Cooked for 5m 51s · done soon']) {
      const screen = [LOST, row, claudeBox('')].join('\n');
      expect(readScreen('claude-code', screen)).toEqual({ kind: 'provider error' });
      expect(dialogKind('claude-code', screen)).toBe('provider error');
    }
  });

  test('completion-shaped text typed in the box does not end the turn', () => {
    const screen = [LOST, claudeBox(DONE)].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'provider error' });
    expect(classifyComposer('claude-code', screen.split('\n')).kind).toBe('unknown');
  });

  test('a completion verb the capture does not show is a synthetic hypothesis', () => {
    // The frame observed only `Cooked`. The turn_end grammar accepts any verb, so a synthetic
    // row is expected to end its turn too; this is a hypothesis about that grammar, not a
    // second observation.
    const screen = [LOST, '✻ Simmered for 2s · done 5:25 PM', claudeBox('')].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'idle' });
  });

  test('a running turn stays working, whatever the completion above it', () => {
    const screen = [LOST, DONE, '  esc to interrupt', claudeBox('')].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'working' });
    expect(screenWord(readScreen('claude-code', screen))).toBe('working');
  });

  test('a dialog above the box stays the dialog', () => {
    const perm = readFileSync(
      new URL('./fixtures/claude-code/2.1.289/permission-create-plain.txt', import.meta.url),
      'utf8',
    );
    const screen = [LOST, DONE, perm].join('\n');
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'permission' });
    expect(dialogKind('claude-code', screen)).toBe('permission');
  });
});
