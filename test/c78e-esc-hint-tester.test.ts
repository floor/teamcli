// Independent check of the Codex hint row that stands under an empty composer after the
// scroll-back return (src/watch/screen.ts, src/send/typed-wake.ts). Screens and keys are
// synthetic. No live host, CLI, or process signal is invoked.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { classifyComposer, readScreen, screenData } from '../src/watch/screen.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'codex', '0.161.0');
const SCROLL = readFileSync(join(FIXTURES, 'scroll-back.txt'), 'utf8');
const MARKER = readFileSync(join(FIXTURES, 'scroll-back-marker.txt'), 'utf8');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working.txt'), 'utf8');
const HINT = readFileSync(join(FIXTURES, 'esc-hint.txt'), 'utf8');

const HINT_ROW = 'esc again to edit previous message';
const PROMPT = '› Ask Codex to do anything';

const LINE = 'fixture wake line';
const PANE = 'fixture-pane-one';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };
const declared = screenData('codex')?.scrollBack?.returnKey;
if (declared === undefined) throw new Error('codex declares no scroll-back return key');
const RETURN: string = declared;

const holding = (text: string): string => IDLE.replace(/› .*/, `› ${text}`);
const hintHolding = (text: string): string => HINT.replace(PROMPT, `› ${text}`);

type Wake = { host: TypedWakeHost; typed: string[]; keys: string[]; enters: () => number };

function wakeOf(screen: (read: number) => string | null): Wake {
  let reads = 0;
  let enters = 0;
  const typed: string[] = [];
  const keys: string[] = [];
  const host: TypedWakeHost = {
    read: () => screen(reads++),
    type: (_pane, text) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    wait: async () => {},
    key: (_pane, key) => {
      keys.push(key);
      return true;
    },
  };
  return { host, typed, keys, enters: () => enters };
}

function script(screens: readonly string[]): (read: number) => string {
  return (read) => screens[Math.min(read, screens.length - 1)] ?? '';
}

test('the hint under an empty composer, as the last non-blank row, reads idle', () => {
  const rows = HINT.split('\n').filter((line) => line.trim() !== '');
  expect(rows.at(-1)?.trim()).toBe(HINT_ROW);
  expect(rows.at(-2)).toContain('GPT-6.1-Sol high · Context 74% left · weekly 94% left');
  expect(rows.at(-3)).toBe(PROMPT);
  expect(readScreen('codex', HINT).kind).toBe('idle');
  expect(classifyComposer('codex', HINT.split('\n')).kind).toBe('idle');
  expect(readScreen('codex', `${HINT}\n\n\n`).kind).toBe('idle');
});

test('a near miss, a later row, or the hint with no composer does not read idle', () => {
  expect(readScreen('codex', HINT.replace(HINT_ROW, 'esc again to edit the previous message')).kind).toBe('unknown');
  expect(readScreen('codex', HINT.replace(HINT_ROW, `${HINT_ROW} now`)).kind).toBe('unknown');
  expect(readScreen('codex', `${HINT}\n• a later row\n`).kind).toBe('unknown');
  expect(readScreen('codex', `• a transcript row\n  ${HINT_ROW}\n`).kind).toBe('unknown');
});

test('a composer holding text reads unsent, hint row or none', () => {
  const draft = hintHolding('a draft left unsent');
  expect(readScreen('codex', draft).kind).toBe('unsent');
});

test('a transcript line quoting the hint is not the hint row', () => {
  const quoted = MARKER.replace(
    '• Merged into the release branch.',
    `• the pane printed ${HINT_ROW}`,
  );
  expect(quoted).not.toBe(MARKER);
  expect(readScreen('codex', quoted).kind).toBe('scroll back');
  const idleWithQuote = IDLE.replace(PROMPT, `• the pane printed ${HINT_ROW}\n\n${PROMPT}`);
  expect(readScreen('codex', idleWithQuote).kind).toBe('idle');
});

test('scroll back, one return, then the hint on both idle reads, types the line and delivers', async () => {
  const drawn = [holding(LINE), holding(LINE), WORKING];
  for (const layout of [MARKER, SCROLL]) {
    const wake = wakeOf(script([layout, HINT, HINT, ...drawn]));
    const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
    expect(out).toMatchObject({ delivered: true, typed: true, tries: 1 });
    expect(out.reason).toContain('working screen showed after 1 Enter');
    expect(wake.keys).toEqual([RETURN]);
    expect(wake.typed).toEqual([LINE]);
    expect(wake.enters()).toBe(1);
  }
});

test('a pane that stays scrolled back after the return gets one key and no second', async () => {
  const wake = wakeOf(() => MARKER);
  const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
  expect(out).toMatchObject({ delivered: false, typed: true, tries: 0 });
  expect(out.reason).toContain('scroll back');
  expect(out.reason).toContain('no wake line was typed');
  expect(wake.keys).toEqual([RETURN]);
  expect(wake.typed).toEqual([]);
  expect(wake.enters()).toBe(0);
});

test('a near-miss hint and an unsent box after the return each get one key and no line', async () => {
  const near = HINT.replace(HINT_ROW, `${HINT_ROW} now`);
  const draft = hintHolding('a draft left unsent');
  for (const after of [near, draft]) {
    const wake = wakeOf((read) => (read === 0 ? SCROLL : after));
    const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
    expect(out.delivered).toBe(false);
    expect(out.tries).toBe(0);
    expect(out.reason).toContain('no wake line was typed');
    expect(wake.keys).toEqual([RETURN]);
    expect(wake.typed).toEqual([]);
    expect(wake.enters()).toBe(0);
  }
});
