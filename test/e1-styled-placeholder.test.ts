// RFC event-comms E1: an empty-box hint is recognised only by its rendered style, never by its
// words. Grok Build 1.0.88 draws `Build anything` and agy 1.5.10 draws `Auto mode: …` in a
// measured grey with no faint attribute. Typed text equal to those words is drawn in the text pen
// and stays a draft; a plain read of the words stays a draft; an unlisted grey stays a draft; and
// a box that changes between the two idle reads gets no keys. Fixtures: the composer rows of
// live and scratch captures (see the fixture READMEs); no CLI runs and no key leaves the process.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripSgr } from '../src/ansi.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readScreen } from '../src/watch/screen.ts';

const read = (...parts: string[]): string => readFileSync(join(import.meta.dir, 'fixtures', ...parts), 'utf8').replace(/\r\n/g, '\n');
const GROK_HINT = read('grok', '1.0.88', 'idle-hint-ansi.txt');
const GROK_DRAFT = read('grok', '1.0.88', 'draft-equal-ansi.txt');
const AGY_HINT = read('antigravity', '1.5.10', 'idle-auto-mode-ansi.txt');
const AGY_DRAFT = read('antigravity', '1.5.10', 'draft-equal-ansi.txt');

const HINT_GREY = '\x1b[38;2;78;78;78m';

describe('E1: Grok Build 1.0.88 `Build anything`', () => {
  test('the captured hint in its measured grey is the empty box', () => {
    expect(GROK_HINT).toContain(`${HINT_GREY}\x1b[48;2;20;20;20mBuild anything`);
    expect(readScreen('grok', GROK_HINT).kind).toBe('idle');
  });

  test('a typed draft of the same words, drawn in the text pen, stays a draft', () => {
    expect(stripSgr(GROK_DRAFT)).toContain('❯ Build anything');
    expect(readScreen('grok', GROK_DRAFT).kind).toBe('unsent');
  });

  test('the same words in the unfocused palette\'s text pen (the padding pen 155) stay a draft', () => {
    const draft = GROK_HINT.replace(HINT_GREY, '\x1b[38;2;155;155;155m');
    expect(readScreen('grok', draft).kind).toBe('unsent');
  });

  test('an undeclared grey stays a draft', () => {
    const other = GROK_HINT.replace(HINT_GREY, '\x1b[38;2;80;80;80m');
    expect(readScreen('grok', other).kind).toBe('unsent');
  });

  test('a plain read of the hint words is not trusted: it stays a draft (fail closed)', () => {
    expect(readScreen('grok', stripSgr(GROK_HINT)).kind).toBe('unsent');
  });
});

describe('E1: agy 1.5.10 `Auto mode: …`', () => {
  test('the captured hint in 38;5;8 is the empty box', () => {
    expect(AGY_HINT).toContain('\x1b[38;5;8mAuto mode:');
    expect(readScreen('antigravity', AGY_HINT).kind).toBe('idle');
  });

  test('a typed draft of the same words in the default pen stays a draft', () => {
    expect(readScreen('antigravity', AGY_DRAFT).kind).toBe('unsent');
  });

  test('a plain read of the hint words stays a draft (fail closed)', () => {
    expect(readScreen('antigravity', stripSgr(AGY_HINT)).kind).toBe('unsent');
  });
});

describe('E1: input that changes between the proof and the keys gets no keys', () => {
  function scripted(frames: string[]): { host: TypedWakeHost; keys: number } {
    const state = { reads: 0, keys: 0 };
    const host: TypedWakeHost = {
      read: () => frames[Math.min(state.reads++, frames.length - 1)] ?? null,
      type: () => { state.keys += 1; return true; },
      enter: () => { state.keys += 1; return true; },
      prompt: () => { state.keys += 1; return true; },
      wait: async () => {},
    };
    return { host, get keys() { return state.keys; } };
  }
  const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

  test('Grok: hint on the first read, a draft on the second → nothing typed', async () => {
    const pane = scripted([GROK_HINT, GROK_DRAFT]);
    const out = await deliverTypedWake(pane.host, 'pane-1', 'Read your inbox.', 'grok', FAST);
    expect(out.delivered).toBe(false);
    expect(out.typed).toBe(false);
    expect(pane.keys).toBe(0);
  });

  test('agy: hint on the first read, a draft on the second → nothing typed', async () => {
    const pane = scripted([AGY_HINT, AGY_DRAFT]);
    const out = await deliverTypedWake(pane.host, 'pane-1', 'Read your inbox.', 'antigravity', FAST);
    expect(out.delivered).toBe(false);
    expect(out.typed).toBe(false);
    expect(pane.keys).toBe(0);
  });
});
