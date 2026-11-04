// An empty Antigravity composer draws a hint row, `/tasks shows …`, and the watch's typed
// retry types only into a screen the profile calls idle. The shipped idle frame's bare `>`
// is idle; the same frame with the hint in that row is the scene. A draft in the box stays
// unsent. No CLI runs and no key leaves the process.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readBox, readScreen } from '../src/watch/screen.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working-synthetic.txt'), 'utf8');
const MUSE_PLAIN = readFileSync(join(import.meta.dir, 'fixtures', 'muse', '1.4.11', 'goal-hint-synthetic.txt'), 'utf8');
const MUSE_DIM = readFileSync(join(import.meta.dir, 'fixtures', 'muse', '1.4.11', 'goal-hint-dim.txt'), 'utf8');
const MUSE_DRAFT = readFileSync(join(import.meta.dir, 'fixtures', 'muse', '1.4.11', 'slash-draft-synthetic.txt'), 'utf8');
const LINE = 'Read /t/mail/abc and do that.';
const OPEN = '/tasks shows your open tasks';
const WORKFLOWS = '/tasks shows workflows, subagents and terminals in one place';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

/** The captured idle frame with `text` in the empty input row between the box's two rules. */
function row(text: string): string {
  return IDLE.replace(/\n>\n(─+)\n/, (_match, rule: string) => `\n> ${text}\n${rule}\n`);
}

function wakeFake(screen: (read: number, enters: number, typed: readonly string[]) => string): { host: TypedWakeHost; typed: string[]; enters: number } {
  const typed: string[] = [];
  const state = { enters: 0, reads: 0 };
  const host: TypedWakeHost = {
    read: () => screen(state.reads++, state.enters, typed),
    type: (_pane, text) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      state.enters += 1;
      return true;
    },
    wait: async () => {},
  };
  return {
    host,
    typed,
    get enters() {
      return state.enters;
    },
  };
}

test('an Antigravity tasks hint is the empty box, and the same words with more text are a draft', () => {
  expect(readScreen('antigravity', IDLE).kind).toBe('idle');
  for (const hint of [OPEN, WORKFLOWS]) {
    const exact = row(hint);
    const draft = row(`${hint} now`);
    expect(readScreen('antigravity', exact).kind).toBe('idle');
    expect(readBox('antigravity', exact)).toBeNull();
    expect(boxHoldsText('antigravity', hint, exact)).toBe(false);
    expect(readScreen('antigravity', draft).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', `${hint} now`, draft)).toBe(true);
  }
  expect(readScreen('antigravity', row(LINE)).kind).toBe('unsent');
  expect(readScreen('antigravity', row('/tasks')).kind).toBe('unsent');
  expect(readScreen('antigravity', row('/tasks shows the queue')).kind).toBe('unsent');
  expect(readScreen('antigravity', row('/goal ship the release')).kind).toBe('unsent');
});

/** The plain Muse goal-hint frame with another input row. */
function musePlain(text: string): string {
  return MUSE_PLAIN.replace('❯ /goal pins a session objective with a progress bar', `❯ ${text}`);
}

test('a plain Muse tasks hint is the empty box, and the same words with more text are a draft', () => {
  expect(readScreen('muse', MUSE_PLAIN).kind).toBe('idle');
  for (const hint of [OPEN, WORKFLOWS]) {
    const exact = musePlain(hint);
    const draft = musePlain(`${hint} now`);
    expect(readScreen('muse', exact).kind).toBe('idle');
    expect(readBox('muse', exact)).toBeNull();
    expect(boxHoldsText('muse', hint, exact)).toBe(false);
    expect(readScreen('muse', draft).kind).toBe('unsent');
    expect(boxHoldsText('muse', `${hint} now`, draft)).toBe(true);
  }
  expect(readScreen('muse', MUSE_DRAFT).kind).toBe('unsent');
  expect(readScreen('muse', musePlain('/goal ship the release')).kind).toBe('unsent');
  const colored = MUSE_DIM
    .replace('/goal pins a session objective with a progress bar', OPEN)
    .replace('\u001b[2m', '\u001b[38;5;245m');
  expect(readScreen('muse', colored).kind).toBe('unsent');
});

test('the typed wake types into the hint row and waits for the working screen', async () => {
  const hint = row(OPEN);
  const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? hint : row(typed[typed.length - 1] ?? '')));
  const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
  expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
  expect(pane.typed).toEqual([LINE]);
  expect(pane.enters).toBe(1);
});
