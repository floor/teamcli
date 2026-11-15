// The Gemini CLI typed wake, read on the captured 0.64.0 frames in
// test/fixtures/gemini/0.64.0/: the empty idle box, a draft in the box, and the spinner frame.
// No CLI runs and no key leaves the process.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { profileFor } from '../src/profiles/index.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readScreen } from '../src/watch/screen.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'gemini', '0.64.0');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const UNSENT = readFileSync(join(FIXTURES, 'unsent.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working.txt'), 'utf8');
const PERMISSION = readFileSync(join(FIXTURES, 'permission.txt'), 'utf8');

const LINE = 'Read /t/mail/abc and do that.';

/** The captured unsent frame with `text` in the box: `RULES_RECEIVED` is the capture's own draft. */
function holding(text: string): string {
  return UNSENT.replace('RULES_RECEIVED', () => text);
}

/** A pane scripted by how many reads and Enters it has seen. `wait` costs nothing. */
function wakeFake(screen: (read: number, enters: number, typed: readonly string[]) => string | null): {
  host: TypedWakeHost;
  typed: string[];
  readonly enters: number;
} {
  const typed: string[] = [];
  const state = { enters: 0, reads: 0 };
  const host: TypedWakeHost = {
    read: () => screen(state.reads++, state.enters, typed),
    type: (_pane: string, text: string) => {
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

const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

describe('the gemini typed wake', () => {
  test('the profile declares the wake, types it with Enter, and the frames read as the gate needs', () => {
    const profile = profileFor('gemini');
    expect(profile?.typedWake).toBe('screen');
    // Enter submits on this CLI: the wake types and presses, it does not ask herdr to prompt.
    expect(profile?.wake ?? null).toBeNull();
    expect(profile?.typedWakeMax).toBe(600);
    expect(profile?.readHint).toBe('Read it with: call inbox_check now.');
    expect(readScreen('gemini', IDLE).kind).toBe('idle');
    expect(readScreen('gemini', WORKING).kind).toBe('working');
    expect(readScreen('gemini', holding(LINE)).kind).toBe('unsent');
    expect(boxHoldsText('gemini', LINE, holding(LINE))).toBe(true);
  });

  test('two idle reads, one line, one Enter: the spinner row is the delivery', async () => {
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'gemini', FAST);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter', submittedAt: expect.any(Number), workingAt: expect.any(Number) });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('a draft in the box refuses before any key', async () => {
    const pane = wakeFake(() => UNSENT);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'gemini', FAST);
    expect(out.delivered).toBe(false);
    expect(out.typed).toBe(false);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a permission dialog refuses before any key', async () => {
    expect(readScreen('gemini', PERMISSION).kind).toBe('permission');
    const pane = wakeFake(() => PERMISSION);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'gemini', FAST);
    expect(out.delivered).toBe(false);
    expect(out.typed).toBe(false);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a working screen refuses before any key: a busy seat reads its inbox at its next turn', async () => {
    const pane = wakeFake(() => WORKING);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'gemini', FAST);
    expect(out.delivered).toBe(false);
    expect(out.typed).toBe(false);
    expect(pane.typed).toEqual([]);
  });
});
