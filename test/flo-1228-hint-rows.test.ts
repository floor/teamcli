// An empty Antigravity composer draws a hint row, `/tasks shows …`, and the watch's typed
// retry types only into a screen the profile calls idle. The shipped idle frame's bare `>`
// is idle; the same frame with the hint in that row is the scene. A draft in the box stays
// unsent. No CLI runs and no key leaves the process.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readScreen } from '../src/watch/screen.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working-synthetic.txt'), 'utf8');
const LINE = 'Read /t/mail/abc and do that.';
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

test('an Antigravity /tasks shows hint is the empty box, and a draft in that box is unsent', () => {
  expect(readScreen('antigravity', IDLE).kind).toBe('idle');
  expect(readScreen('antigravity', row('/tasks shows your open tasks')).kind).toBe('idle');
  expect(readScreen('antigravity', row('/tasks shows the queue')).kind).toBe('idle');
  expect(readScreen('antigravity', row(LINE)).kind).toBe('unsent');
  expect(readScreen('antigravity', row('/tasks')).kind).toBe('unsent');
  expect(readScreen('antigravity', row('/goal ship the release')).kind).toBe('unsent');
});

test('the typed wake types into the hint row and waits for the working screen', async () => {
  const hint = row('/tasks shows your open tasks');
  const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? hint : row(typed[typed.length - 1] ?? '')));
  const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
  expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
  expect(pane.typed).toEqual([LINE]);
  expect(pane.enters).toBe(1);
});
