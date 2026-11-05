// The one typed wake this build allows. A profile that declares `typed_wake: screen`
// lets a send type one trigger line into a composer two reads showed as the empty idle prompt;
// Enter goes only into a box that reads back as exactly that line, and the send is delivered
// only when the profile's working screen shows. The screens below are the captured Muse 1.4.11
// frames in test/fixtures/muse/, with the trigger line drawn in the captured composer.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { listUnread } from '../src/mcp/inbox.ts';
import {
  DEFAULT_WATCH_WAKE_TRIES,
  profileFor,
  readHintKey,
  typedWakeKey,
  watchWakeKey,
  watchWakeTriesKey,
} from '../src/profiles/index.ts';
import { readHistory } from '../src/send/history.ts';
import { NO_EVENT_ADAPTER_TOOK_IT, queuedLine } from '../src/send/no-pane-messaging.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readBox, readScreen, type Screen } from '../src/watch/screen.ts';
import { fake, filed, owner, world } from './send-native-fixtures.ts';
import { recordBody } from './helpers.ts';
import { withoutSendId } from './helpers/output.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'muse', '1.4.11');
const FIXTURES_149 = join(import.meta.dir, 'fixtures', 'muse', '1.4.9');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const GOAL = readFileSync(join(FIXTURES, 'goal-hint-synthetic.txt'), 'utf8');
const LOOP = readFileSync(join(FIXTURES, 'loop-hint-dim.txt'), 'utf8');
const PROSE = readFileSync(join(FIXTURES, 'prose-hint-dim.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working-synthetic.txt'), 'utf8');
const WORKING_149 = readFileSync(join(FIXTURES_149, 'working.txt'), 'utf8');
const UNSENT = readFileSync(join(FIXTURES, 'unsent-synthetic.txt'), 'utf8');
const PERMISSION_149 = readFileSync(join(FIXTURES_149, 'permission.txt'), 'utf8');
const TRUST_149 = readFileSync(join(FIXTURES_149, 'trust.txt'), 'utf8');
const QUESTION_149 = readFileSync(join(FIXTURES_149, 'model-picker.txt'), 'utf8');

/** The captured idle frame with `text` drawn in its composer: the same rules and footer, one
 *  input row. Muse wraps a long row, so the scenes keep the line short enough to read back. */
function holding(text: string): string {
  return IDLE.replace('❯\n', `❯ ${text}\n`);
}

/** The captured working frame with `text` still in the composer. The spinner row keeps the
 *  screen working; the composer read is unsent while the line sits there. */
function workingHolding(text: string): string {
  return WORKING.replace('❯\n', `❯ ${text}\n`);
}

const LINE = 'Read /t/mail/abc and do that.';

/** A pane scripted by how many reads and Enters it has seen, and by the lines typed into it. The
 *  trigger a send composes is not known until the send runs, so a scene that wants the box to
 *  read back the line draws the text the wake itself typed. `wait` costs nothing. */
function wakeFake(
  screen: (read: number, enters: number, typed: readonly string[]) => string | null,
  options: { typeOk?: boolean; enterOk?: boolean } = {},
): { host: TypedWakeHost; typed: string[]; enters: number; reads: number } {
  const typed: string[] = [];
  const state = { enters: 0, reads: 0 };
  const host: TypedWakeHost = {
    read: () => screen(state.reads++, state.enters, typed),
    type: (_pane: string, text: string) => {
      typed.push(text);
      return options.typeOk ?? true;
    },
    enter: () => {
      state.enters += 1;
      return options.enterOk ?? true;
    },
    wait: async () => {},
  };
  return {
    host,
    typed,
    get enters() {
      return state.enters;
    },
    get reads() {
      return state.reads;
    },
  };
}

const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, ackSettleMs: 1, verifyMs: 1 };

type WakeStep = { op: 'read' } | { op: 'type' } | { op: 'enter' } | { op: 'wait'; ms: number };

/** A pane scripted as `wakeFake`, recording every step in the order the wake took it: the walk's
 *  shape is what a wait cut changes, so the scenes read the sequence, not just the result. */
function stepFake(
  screen: (read: number, enters: number, typed: readonly string[]) => string | null,
): { host: TypedWakeHost; steps: WakeStep[]; typed: string[]; enters: number } {
  const steps: WakeStep[] = [];
  const typed: string[] = [];
  const state = { enters: 0, reads: 0 };
  const host: TypedWakeHost = {
    read: () => {
      steps.push({ op: 'read' });
      return screen(state.reads++, state.enters, typed);
    },
    type: (_pane: string, text: string) => {
      steps.push({ op: 'type' });
      typed.push(text);
      return true;
    },
    enter: () => {
      steps.push({ op: 'enter' });
      state.enters += 1;
      return true;
    },
    wait: async (ms: number) => {
      steps.push({ op: 'wait', ms });
    },
  };
  return {
    host,
    steps,
    typed,
    get enters() {
      return state.enters;
    },
  };
}

describe('the typed wake: one line into an empty idle box', () => {
  test('two idle reads, one line, one Enter: the working screen is the delivery', async () => {
    const pane = wakeFake((read, enters) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('a working screen that still holds the line is not delivered until the box empties', async () => {
    const held = workingHolding(LINE);
    expect(readScreen('muse', held).kind).toBe('working');
    expect(boxHoldsText('muse', LINE, held)).toBe(true);
    let post = 0;
    const pane = wakeFake((read, enters) => {
      if (read < 2) return IDLE;
      if (enters === 0) return holding(LINE);
      post += 1;
      return post < 3 ? held : WORKING;
    });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', { ...FAST, verifyMs: 3 });
    expect(post).toBe(3);
    expect(out).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('a working screen that keeps the line through the bound is not delivered', async () => {
    const pane = wakeFake((read, enters) => (enters > 0 ? workingHolding(LINE) : read < 2 ? IDLE : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: true,
      tries: 1,
      reason: 'the working screen showed with the line still in the box after 1 Enter; the line was not submitted',
    });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('the /goal hint is an empty box: two reads of it, one line, one Enter', async () => {
    const pane = wakeFake((read, enters) => (enters > 0 ? WORKING : read < 2 ? GOAL : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('the dim /loop hint is an empty box: two reads of it, one line, one Enter', async () => {
    const pane = wakeFake((read, enters) => (enters > 0 ? WORKING : read < 2 ? LOOP : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('a faint prose hint is a draft: the wake is refused before any key', async () => {
    // Muse declares `shape: slash-hint`, so an all-faint row is the empty box only when it is
    // a listed hint or a `/command …` hint. Faint words are a draft, as plain words are.
    const pane = wakeFake(() => PROSE);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed',
    });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a line still rendering is not pressed, and an Enter that leaves it unsent is pressed again', async () => {
    let settleReads = 0;
    const pane = wakeFake((read, enters) => {
      if (read < 2) return IDLE;
      if (enters === 0) {
        settleReads += 1;
        return settleReads === 1 ? holding('Read') : holding(LINE);
      }
      return enters === 1 ? holding(LINE) : WORKING;
    });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(settleReads).toBe(3);
    expect(out).toEqual({
      delivered: true,
      typed: true,
      tries: 2,
      reason: 'the working screen showed after 2 Enters',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(2);
  });

  test('a box that holds unsent text on the first read is never typed over', async () => {
    const pane = wakeFake(() => UNSENT);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out.delivered).toBe(false);
    expect(out.reason).toBe('the first read showed unsent, not an empty idle prompt; nothing was typed');
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a working screen on the second read stops the wake before any key', async () => {
    const pane = wakeFake((read) => (read === 0 ? IDLE : WORKING));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the second read showed working, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
  });

  test('a pane that cannot be read is refused with nothing typed', async () => {
    const pane = wakeFake(() => null);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed unreadable, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
  });

  test('a box that reads back other text gets no Enter', async () => {
    const pane = wakeFake((read) => (read < 2 ? IDLE : holding('the owner was typing')));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(0);
  });

  test('a box that reads empty after the line was typed gets no Enter', async () => {
    const pane = wakeFake((read) => (read < 2 ? IDLE : IDLE));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the screen read idle after the line was typed; no Enter was pressed' });
    expect(pane.enters).toBe(0);
  });

  test('a line that stays in the box gets at most three guarded Enters and is not delivered', async () => {
    const pane = wakeFake((read) => (read < 2 ? IDLE : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: true, tries: 3, reason: 'the line stayed in the box through 3 Enters and no working screen showed' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(3);
  });

  test('a box that clears without a working screen is not a delivery', async () => {
    const pane = wakeFake((_read, enters) => (enters > 0 ? IDLE : _read < 2 ? IDLE : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    // The Enter's read showed the line gone: submission was confirmed even though no working
    // screen followed, so the bound's mark is taken and the working screen's is not.
    expect(out).toEqual({
      delivered: false,
      typed: true,
      tries: 1,
      reason: 'the screen read idle and no working screen showed',
      submittedAt: expect.any(Number),
    });
    expect(pane.enters).toBe(1);
  });

  test('a working screen before any of the wake’s Enters is not its delivery', async () => {
    const pane = wakeFake((read) => (read < 2 ? IDLE : WORKING));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: true,
      tries: 0,
      reason: 'a working screen showed before any Enter, so the line was not submitted by this wake; no Enter was pressed',
    });
    expect(pane.enters).toBe(0);
  });

  test('a pane that does not take the line stops the wake with nothing pressed', async () => {
    const pane = wakeFake(() => IDLE, { typeOk: false });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the pane did not take the line; nothing was typed' });
    expect(pane.enters).toBe(0);
  });

  test('a pane that does not take the Enter gets no further Enter', async () => {
    const pane = wakeFake((read) => (read < 2 ? IDLE : holding(LINE)), { enterOk: false });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the pane did not take the Enter; no further Enter was pressed' });
    expect(pane.enters).toBe(1);
  });

  test('the exact /goal placeholder reads idle, while real /goal drafts or altered hint text refuse', async () => {
    expect(readScreen('muse', GOAL).kind).toBe('idle');
    expect(readBox('muse', GOAL)).toBeNull();
    expect(boxHoldsText('muse', '/goal pins a session objective with a progress bar', GOAL)).toBe(false);

    const revertedToGoal = wakeFake((read) => (read < 2 ? GOAL : GOAL));
    const outReverted = await deliverTypedWake(revertedToGoal.host, 'pane-1', LINE, 'muse', FAST);
    expect(outReverted).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the screen read idle after the line was typed; no Enter was pressed' });
    expect(revertedToGoal.typed).toEqual([LINE]);
    expect(revertedToGoal.enters).toBe(0);

    const goalDrafts = [
      '/goal',
      '/goal ship 0.5.12',
      '/goal pins a session objective',
      'pins a session objective with a progress bar',
      '/goal pins a session objective with a progress bar now',
      '/goal  pins a session objective with a progress bar',
    ];
    for (const draftText of goalDrafts) {
      const frame = holding(draftText);
      expect(readScreen('muse', frame).kind).toBe('unsent');
      expect(readBox('muse', frame)?.first).toBe(draftText);
      expect(boxHoldsText('muse', draftText, frame)).toBe(true);
      expect(boxHoldsText('muse', LINE, frame)).toBe(false);

      const firstRead = wakeFake(() => frame);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed' });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? GOAL : frame));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the second read showed unsent, not an empty idle prompt; nothing was typed' });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? GOAL : frame));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'muse', FAST);
      expect(outAfter).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
      expect(afterType.typed).toEqual([LINE]);
      expect(afterType.enters).toBe(0);
    }
  });

  test('a box with only spaces or altered internal spacing after typing gets no Enter', async () => {
    const spacesOnly = wakeFake((read) => (read < 2 ? IDLE : holding('    ')));
    const outSpaces = await deliverTypedWake(spacesOnly.host, 'pane-1', LINE, 'muse', FAST);
    expect(readScreen('muse', holding('    ')).kind).toBe('idle');
    expect(boxHoldsText('muse', LINE, holding('    '))).toBe(false);
    expect(outSpaces).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the screen read idle after the line was typed; no Enter was pressed' });
    expect(spacesOnly.typed).toEqual([LINE]);
    expect(spacesOnly.enters).toBe(0);

    const doubledSpace = LINE.replace(' ', '  ');
    const internalSpaces = wakeFake((read) => (read < 2 ? IDLE : holding(doubledSpace)));
    const outInternal = await deliverTypedWake(internalSpaces.host, 'pane-1', LINE, 'muse', FAST);
    expect(readScreen('muse', holding(doubledSpace)).kind).toBe('unsent');
    expect(boxHoldsText('muse', LINE, holding(doubledSpace))).toBe(false);
    expect(outInternal).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
    expect(internalSpaces.typed).toEqual([LINE]);
    expect(internalSpaces.enters).toBe(0);
  });

  test('partial text in the box refuses before any key and gets no Enter if drawn after typing', async () => {
    const prefix = LINE.slice(0, 12);
    const suffix = LINE.slice(5);
    for (const draft of [holding(prefix), holding(suffix)]) {
      expect(readScreen('muse', draft).kind).toBe('unsent');
      expect(boxHoldsText('muse', LINE, draft)).toBe(false);

      const firstRead = wakeFake(() => draft);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed' });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? IDLE : draft));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the second read showed unsent, not an empty idle prompt; nothing was typed' });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? IDLE : draft));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'muse', FAST);
      expect(outAfter).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
      expect(afterType.typed).toEqual([LINE]);
      expect(afterType.enters).toBe(0);
    }
  });

  test('captured dialog and working frames refuse before any key and before Enter', async () => {
    const dialogs: ReadonlyArray<readonly [kind: Screen['kind'], frame: string]> = [
      ['permission', PERMISSION_149],
      ['trust', TRUST_149],
      ['question', QUESTION_149],
    ];
    for (const [kind, frame] of dialogs) {
      expect(readScreen('muse', frame).kind).toBe(kind);
      expect(boxHoldsText('muse', LINE, frame)).toBe(false);

      const firstRead = wakeFake(() => frame);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: `the first read showed ${kind}, not an empty idle prompt; nothing was typed` });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? IDLE : frame));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: `the second read showed ${kind}, not an empty idle prompt; nothing was typed` });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? IDLE : frame));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'muse', FAST);
      expect(outAfter).toEqual({ delivered: false, typed: true, tries: 0, reason: `the screen read ${kind} after the line was typed; no Enter was pressed` });
      expect(afterType.typed).toEqual([LINE]);
      expect(afterType.enters).toBe(0);
    }

    for (const workingFrame of [WORKING, WORKING_149]) {
      expect(readScreen('muse', workingFrame).kind).toBe('working');
      expect(boxHoldsText('muse', LINE, workingFrame)).toBe(false);

      const firstRead = wakeFake(() => workingFrame);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed working, not an empty idle prompt; nothing was typed' });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? IDLE : workingFrame));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the second read showed working, not an empty idle prompt; nothing was typed' });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? IDLE : workingFrame));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'muse', FAST);
      expect(outAfter).toEqual({
        delivered: false,
        typed: true,
        tries: 0,
        reason: 'a working screen showed before any Enter, so the line was not submitted by this wake; no Enter was pressed',
      });
      expect(afterType.typed).toEqual([LINE]);
      expect(afterType.enters).toBe(0);
    }
  });

  test('deliverTypedWake awaits an asynchronous terminal-host adapter for read, type, and enter', async () => {
    let reads = 0;
    let enters = 0;
    const typed: string[] = [];
    const asyncHost: TypedWakeHost = {
      read: async () => {
        const at = reads++;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return enters > 0 ? WORKING : at < 2 ? IDLE : holding(typed[typed.length - 1] ?? '');
      },
      type: async (_pane, text) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        typed.push(text);
        return true;
      },
      enter: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        enters += 1;
        return true;
      },
      wait: async () => {},
    };
    const out = await deliverTypedWake(asyncHost, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(typed).toEqual([LINE]);
    expect(enters).toBe(1);
  });
});

describe('the typed wake: a line already in the box is pressed into, never typed twice', () => {
  // A wake child can be killed after it typed and before its Enter, and a wake asked twice can
  // look at its own line still sitting in the composer. That wake presses Enter into exactly
  // that line, after the same two spaced looks, and never types the line again.

  test('a box that already holds exactly the line gets one guarded Enter and no second typing', async () => {
    const pane = stepFake((read, enters) => (read === 0 ? holding(LINE) : enters > 0 ? WORKING : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(pane.typed).toEqual([]);
    expect(pane.steps.filter((step) => step.op === 'type')).toEqual([]);
    // The first look, the settle, the second look, then Enter: the same pair the typed path
    // waits for before its first Enter.
    const enteredAt = pane.steps.findIndex((step) => step.op === 'enter');
    expect(pane.steps.slice(0, enteredAt)).toEqual([
      { op: 'read' },
      { op: 'wait', ms: FAST.enterSettleMs },
      { op: 'read' },
    ]);
    expect(pane.enters).toBe(1);
  });

  test('a line still held through every guarded Enter is never retyped', async () => {
    const pane = wakeFake(() => holding(LINE));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: true, tries: 3, reason: 'the line stayed in the box through 3 Enters and no working screen showed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(3);
  });

  test('a working screen that still holds the line before any Enter is not the held path’s delivery', async () => {
    const pane = stepFake((read) => (read === 0 ? holding(LINE) : workingHolding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: 'a working screen showed before any Enter, so the line was not submitted by this wake; no Enter was pressed',
    });
    expect(pane.steps.filter((step) => step.op === 'enter')).toEqual([]);
    expect(pane.steps.filter((step) => step.op === 'type')).toEqual([]);
  });

  test('a line that leaves the box between the two looks gets no Enter', async () => {
    const pane = wakeFake((read) => (read === 0 ? holding(LINE) : IDLE));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the line left the box between the two looks; no Enter was pressed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('another draft appearing between the two looks gets no Enter', async () => {
    const pane = wakeFake((read) => (read === 0 ? holding(LINE) : holding('a draft I did not type')));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the box held text other than the line between the two looks; no Enter was pressed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a second look that cannot be read gets no Enter', async () => {
    const pane = wakeFake((read) => (read === 0 ? holding(LINE) : null));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the screen could not be read after the line was found in the box; no Enter was pressed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a working screen holding the line on the first look is still refused, not pressed', async () => {
    const pane = wakeFake(() => workingHolding(LINE));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed working, not an empty idle prompt; nothing was typed' });
    expect(pane.enters).toBe(0);
  });

  test('a held line whose Enter is not taken reports no key put', async () => {
    const pane = wakeFake(() => holding(LINE), { enterOk: false });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the pane did not take the Enter; no further Enter was pressed' });
    expect(pane.typed).toEqual([]);
  });
});

describe('the waits before and after Enter are the walk’s guard, not fixed sleeps', () => {
  test('a ticking frame that still holds the line is pressed, not refused', async () => {
    // The two looks agree on the facts that matter — the box holds exactly the line — not on the
    // whole frame: a counter elsewhere on screen ticks between them and must not stop the Enter.
    let tick = 0;
    const pane = wakeFake((read, enters) => {
      if (read < 2) return IDLE;
      if (enters > 0) return WORKING;
      tick += 1;
      return holding(LINE).replace('Skills: 56 loaded', `Skills: ${String(56 + tick)} loaded`);
    });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('the second look at the drawn line follows at once, with one settle after the typing', async () => {
    // No sleep between the two looks: the pair is the guard, and the line is typed once.
    const pane = stepFake((read, enters) => (read < 2 ? IDLE : enters > 0 ? WORKING : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out.delivered).toBe(true);
    expect(pane.enters).toBe(1);
    const typedAt = pane.steps.findIndex((step) => step.op === 'type');
    const enteredAt = pane.steps.findIndex((step) => step.op === 'enter');
    expect(pane.steps.slice(typedAt + 1, enteredAt)).toEqual([
      { op: 'wait', ms: FAST.enterSettleMs },
      { op: 'read' },
      { op: 'read' },
    ]);
  });

  test('a look that holds the line and then a different box refuses before any Enter', async () => {
    // The two looks disagree: the box that held the line now holds someone else's text. No Enter.
    const pane = wakeFake((read, enters) => {
      if (read < 2) return IDLE;
      if (enters > 0) return WORKING;
      return read === 2 ? holding(LINE) : holding('a draft I did not type');
    });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: true,
      tries: 0,
      reason: 'the box held text other than the line after the line was typed; no Enter was pressed',
    });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(0);
  });

  test('the first look after Enter waits one ack settle, never reading at zero delay', async () => {
    const pane = stepFake((read, enters) => (read < 2 ? IDLE : enters > 0 ? WORKING : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    const enteredAt = pane.steps.findIndex((step) => step.op === 'enter');
    expect(pane.steps[enteredAt + 1]).toEqual({ op: 'wait', ms: FAST.ackSettleMs });
    expect(pane.steps[enteredAt + 2]).toEqual({ op: 'read' });
  });

  test('an ack that shows the line still held presses again, bounded, and never types it twice', async () => {
    const pane = wakeFake((read, enters) => {
      if (read < 2) return IDLE;
      return enters < 2 ? holding(LINE) : WORKING;
    });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: true,
      typed: true,
      tries: 2,
      reason: 'the working screen showed after 2 Enters',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(2);
  });

  test('an ack that shows the box emptied without a working screen is not a delivery', async () => {
    const pane = wakeFake((read, enters) => (enters > 0 ? IDLE : read < 2 ? IDLE : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    // The Enter's read showed the line gone: submission was confirmed even though no working
    // screen followed, so the bound's mark is taken and the working screen's is not.
    expect(out).toEqual({
      delivered: false,
      typed: true,
      tries: 1,
      reason: 'the screen read idle and no working screen showed',
      submittedAt: expect.any(Number),
    });
    expect(pane.enters).toBe(1);
  });
});

describe('the typed wake marks its two times from the reads it takes', () => {
  // Both marks are read off reads taken after an Enter this wake pressed: the first that shows
  // the line gone is the submission confirmed (the bound's point); the first that shows the
  // profile's working screen with the line gone is the redraw reported beside it. A clock handed
  // in makes the marks exact; a wake that pressed no Enter, or whose working screen still held
  // the line, stamps nothing.

  test('a working screen on the Enter’s own read stamps both times at once', async () => {
    const pane = wakeFake((read, enters) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', { ...FAST, now: () => 5_000 });
    expect(out.delivered).toBe(true);
    expect(out.submittedAt).toBe(5_000);
    expect(out.workingAt).toBe(5_000);
  });

  test('the line leaving before the working screen stamps submission first', async () => {
    const clock = { at: 1_000 };
    const pane = wakeFake((read, enters) => {
      if (enters === 0) return read < 2 ? IDLE : holding(LINE);
      if (read === 4) {
        clock.at = 1_400;
        return IDLE;
      }
      clock.at = 1_900;
      return WORKING;
    });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', { ...FAST, now: () => clock.at });
    expect(out.delivered).toBe(true);
    expect(out.submittedAt).toBe(1_400);
    expect(out.workingAt).toBe(1_900);
  });

  test('a working screen that still holds the line stamps neither time', async () => {
    const pane = wakeFake((read, enters) => (enters === 0 ? (read < 2 ? IDLE : holding(LINE)) : workingHolding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', { ...FAST, now: () => 1_000 });
    expect(out.delivered).toBe(false);
    expect(out.tries).toBe(1);
    expect(out.submittedAt).toBeUndefined();
    expect(out.workingAt).toBeUndefined();
  });

  test('a wake that pressed no Enter stamps nothing', async () => {
    const pane = wakeFake(() => IDLE);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', { ...FAST, now: () => 1_000 });
    expect(out.delivered).toBe(false);
    expect(out.tries).toBe(0);
    expect(out.submittedAt).toBeUndefined();
    expect(out.workingAt).toBeUndefined();
  });
});

describe('the typed wake is a profile word', () => {
  test('the word is closed, and only Muse, Cursor, Antigravity, Grok and Codex declare it', () => {
    expect(typedWakeKey('typed_wake: screen')).toBe('screen');
    expect(typedWakeKey('cli: muse')).toBeNull();
    expect(() => typedWakeKey('typed_wake: typing')).toThrow(/typed_wake/);
    expect(profileFor('muse')?.typedWake).toBe('screen');
    expect(profileFor('cursor')?.typedWake).toBe('screen');
    expect(profileFor('antigravity')?.typedWake).toBe('screen');
    expect(profileFor('grok')?.typedWake).toBe('screen');
    expect(profileFor('codex')?.typedWake).toBe('screen');
    for (const cli of ['claude-code', 'gemini', 'jules']) {
      expect(profileFor(cli)?.typedWake, cli).toBeNull();
    }
  });

  test('the watch retry is on exactly where the typed wake is declared, with the default bound', () => {
    // On with the typed wake, off without one: the retry is the same wake, so a profile with no
    // wake to retry never claims one.
    expect(profileFor('muse')?.watchWake).toBe(true);
    expect(profileFor('cursor')?.watchWake).toBe(true);
    expect(profileFor('antigravity')?.watchWake).toBe(true);
    expect(profileFor('grok')?.watchWake).toBe(true);
    expect(profileFor('codex')?.watchWake).toBe(true);
    for (const cli of ['claude-code', 'gemini', 'jules']) {
      expect(profileFor(cli)?.watchWake, cli).toBe(false);
    }
    // The bound is the loader's default unless a profile names one, and the shipped ones name none.
    expect(DEFAULT_WATCH_WAKE_TRIES).toBe(3);
    expect(profileFor('muse')?.watchWakeTries).toBe(3);
    expect(profileFor('cursor')?.watchWakeTries).toBe(3);
    expect(profileFor('antigravity')?.watchWakeTries).toBe(3);
    expect(profileFor('grok')?.watchWakeTries).toBe(3);
    expect(profileFor('codex')?.watchWakeTries).toBe(3);
  });

  test('the read hint is declared where a seat has an inbox tool to name', () => {
    // The two profiles whose seats carry an MCP inbox send their woken turn to the one direct
    // call that lists the waiting messages: the typed line never carries the id `inbox_read`
    // takes, so the read is always reached through `inbox_check`.
    for (const cli of ['antigravity', 'cursor']) {
      expect(profileFor(cli)?.readHint, cli).toBe('Read it with: call inbox_check now.');
    }
    // Muse types too, but reads with the drops command: the shipped sentence stands, as it does
    // for a profile that declares no hint at all.
    for (const cli of ['muse', 'claude-code', 'codex', 'grok', 'gemini', 'jules']) {
      expect(profileFor(cli)?.readHint, cli).toBeNull();
    }
  });

  test('the read hint is read and checked by the loader’s own rules', () => {
    // The sentence holds `: `, so the file's own YAML rule makes it a quoted scalar.
    expect(readHintKey("read_hint: 'Read it with: call inbox_check now.'")).toBe('Read it with: call inbox_check now.');
    // The longest accepted sentence is the shipped ceiling: the header has to keep room to name
    // its sender inside the 80-column line.
    expect(readHintKey(`read_hint: ${'x'.repeat(60)}`)).toBe('x'.repeat(60));
    expect(readHintKey('cli: muse')).toBeNull();
    // The last two carry a real newline inside a quoted scalar; a block scalar never reaches the
    // check, because the file's own YAML reader refuses block scalars outright.
    for (const bad of ['""', '5', `"${'x'.repeat(61)}"`, '" leading"', '"trailing "', '"two\\nlines"', '"trailing\\n"']) {
      expect(() => readHintKey(`read_hint: ${bad}`), bad).toThrow(/read_hint/);
    }
  });

  test('adversarial loader refusals: over-long, multi-line, control-character, whitespace-padded, and non-scalar read_hint values', () => {
    expect(readHintKey(`read_hint: "${'a'.repeat(59)}"`)).toBe('a'.repeat(59));
    expect(readHintKey(`read_hint: "${'a'.repeat(60)}"`)).toBe('a'.repeat(60));
    // Over-long hints (61, 80, 200 chars) are refused with the 60-character ceiling named.
    for (const len of [61, 80, 200]) {
      expect(() => readHintKey(`read_hint: "${'a'.repeat(len)}"`)).toThrow(/"read_hint" must be at most 60 characters/);
    }
    // Multi-line hints (LF, CR, CRLF, Unicode line/paragraph separators) and control characters are refused.
    for (const bad of [
      '"line one\\nline two"',
      '"line one\\rline two"',
      '"line one\\r\\nline two"',
      '"line one\\u2028line two"',
      '"line one\\u2029line two"',
      '"bell\\u0007here"',
      '"esc\\u001b[31mhere"',
      '"del\\u007fhere"',
      '"c1\\u0085here"',
    ]) {
      expect(() => readHintKey(`read_hint: ${bad}`), bad).toThrow(/"read_hint" must be one printable line/);
    }
    // Leading or trailing whitespace (spaces, tabs) is refused.
    for (const padded of ['" Read it."', '"Read it. "', '"\\tRead it."', '"Read it.\\t"', '"   "']) {
      expect(() => readHintKey(`read_hint: ${padded}`), padded).toThrow(/read_hint/);
    }
    // Non-string YAML shapes (booleans, numbers, lists, mappings) are refused.
    for (const nonString of ['true', 'false', '42', '\n  - a', '\n  k: v']) {
      expect(() => readHintKey(`read_hint: ${nonString}`), nonString).toThrow(/read_hint/);
    }
  });

  test('the watch keys are read by the loader’s own rules', () => {
    expect(watchWakeKey('watch_wake: on')).toBe(true);
    expect(watchWakeKey('watch_wake: off')).toBe(false);
    expect(watchWakeKey('cli: muse')).toBeNull();
    expect(() => watchWakeKey('watch_wake: maybe')).toThrow(/watch_wake/);
    expect(watchWakeTriesKey('watch_wake_tries: 4')).toBe(4);
    expect(watchWakeTriesKey('watch_wake_tries: 10')).toBe(10);
    expect(watchWakeTriesKey('cli: muse')).toBeNull();
    for (const bad of ['0', '11', '1.5', '"3"', 'three']) {
      expect(() => watchWakeTriesKey(`watch_wake_tries: ${bad}`)).toThrow(/watch_wake_tries/);
    }
  });
});

describe('team send: the typed wake', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  });

  function museWorld() {
    const made = world(['mcp-inbox', 'typed'], [{ name: 'muse', role: 'implementer', cli: 'muse', launch: 'muse' }]);
    cleanups.push(made.cleanup);
    return made;
  }

  test('a Muse seat is woken by one typed trigger, and the send is delivered', async () => {
    const made = museWorld();
    // The send composes the trigger itself, so the box reads back whatever the wake typed.
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const host = fake(made, {
      agents: () => [{ name: 'muse', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['muse', 'hello'], io, host)).toBe(0);
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\nmuse: delivered (typed wake)\n');
    // One line, one Enter, and the line is the trigger that reads the drop, never the body.
    // Muse has no MCP inbox, so its profile declares no `read_hint` and the shipped sentence
    // stands: the drop read is this seat's fastest path.
    expect(pane.typed).toEqual(['Message from owner (owner@acme): hello Read it with: team drops --read.']);
    expect(pane.enters).toBe(1);
    // The record was written under the seat lock before the line was typed.
    const drops = join(made.dir, 'send-drops', 'acme', 'muse');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    expect(recordBody(join(drops, records[0] as string))).toBe(filed('hello'));
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'muse', outcome: 'delivered (typed wake)', via: 'typed' });
      // The typed leg took the send, so no leg behind it failed: the inbox is no leg to skip.
      expect(history.entries[0]?.failed).toBeUndefined();
    }
  });

  test('a wake that cannot deliver leaves the message in the bus inbox, and the sender is told so', async () => {
    const made = museWorld();
    const pane = wakeFake(() => UNSENT);
    const host = fake(made, {
      agents: () => [{ name: 'muse', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['muse', 'hello'], io, host)).toBe(0);
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\nmuse: queued, not woken (drop, 0 ms); queued; the typed wake failed (the first read showed unsent, not an empty idle prompt; nothing was typed); nothing wakes muse while it is idle except a send-time typed wake and the watch\'s typed retry once a message passes its unread window, into an empty composer; a person or a restart must give it a turn\n');
    expect(io.err).toBe(queuedLine('muse', NO_EVENT_ADAPTER_TOOK_IT));
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'muse', outcome: 'queued, not woken', via: 'drop' });
      expect(history.entries[0]?.failed).toEqual([
        'typed: the first read showed unsent, not an empty idle prompt; nothing was typed',
      ]);
    }
  });

  test('no other seat in the team gains typing: a Claude Code seat still refuses the typed leg', async () => {
    const made = museWorld();
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const host = fake(made, {
      agents: () => [
        { name: 'lead', pane: 'pane-2' },
        { name: 'muse', pane: 'pane-1' },
      ],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries[0]?.failed).toEqual([
        "typed: typing into a seat's pane is never a delivery: messages go through the bus and an event adapter",
      ]);
    }
  });

  test('a long summary and multi-line body on Muse truncates the header to fit <= 80 chars, keeps the drops hint whole, and never types the body', async () => {
    const made = museWorld();
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const host = fake(made, {
      agents: () => [{ name: 'muse', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const longBody = `SUMMARY-${'M'.repeat(120)}\nSECOND-LINE-BODY-SECRET\nTHIRD-LINE-BODY-SECRET`;
    const io = owner(made.root);
    expect(await runSend(['muse', longBody], io, host)).toBe(0);
    expect(pane.typed).toHaveLength(1);
    const typedLine = pane.typed[0] as string;
    expect(typedLine.length).toBe(80);
    expect(typedLine.endsWith(' Read it with: team drops --read.')).toBe(true);
    expect(typedLine.startsWith('Message from owner (owner@acme): SUMMARY-')).toBe(true);
    expect(typedLine).not.toContain('\n');
    expect(typedLine).not.toContain('SECOND-LINE-BODY-SECRET');
    expect(typedLine).not.toContain('THIRD-LINE-BODY-SECRET');
    const drops = join(made.dir, 'send-drops', 'acme', 'muse');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    expect(recordBody(join(drops, records[0] as string))).toBe(filed(longBody));
  });

  test('independent adversarial: line held while working through bound in send is not delivered, never retyped, and message stays unread; box cleared or partial line mid-poll refuses', async () => {
    // 1. Line held while working through the bound in `runSend` -> not delivered, never retyped, message still unread.
    const made = museWorld();
    const pane = wakeFake((read, enters, typed) => {
      if (read < 2) return IDLE;
      const line = typed[typed.length - 1] ?? '';
      return enters === 0 ? holding(line) : workingHolding(line);
    });
    const host = fake(made, {
      agents: () => [{ name: 'muse', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['muse', 'check held'], io, host)).toBe(0);
    expect(io.out).toContain('muse: queued, not woken (drop, 0 ms); queued; the typed wake failed (the working screen showed with the line still in the box after 1 Enter; the line was not submitted)');
    expect(pane.typed).toHaveLength(1);
    expect(pane.enters).toBe(1);
    const drops = join(made.dir, 'send-drops', 'acme', 'muse');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    const msgId = records[0]!;
    expect(existsSync(join(drops, `${msgId}.read.json`))).toBe(false);
    expect(listUnread(drops, { to: 'muse', root: made.root, session: 'acme' }, host.home).map((m) => m.id)).toEqual([msgId]);
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'muse', outcome: 'queued, not woken', via: 'drop' });
      expect(history.entries[0]?.failed).toEqual([
        'typed: the working screen showed with the line still in the box after 1 Enter; the line was not submitted',
      ]);
    }

    // 2. Box cleared by someone else mid-poll (poll 1 sees workingHolding(LINE), poll 2..N sees IDLE).
    let clearPoll = 0;
    const clearedMidPoll = wakeFake((read, enters) => {
      if (read < 2) return IDLE;
      if (enters === 0) return holding(LINE);
      clearPoll += 1;
      return clearPoll <= 2 ? workingHolding(LINE) : IDLE;
    });
    const outCleared = await deliverTypedWake(clearedMidPoll.host, 'pane-1', LINE, 'muse', { ...FAST, verifyMs: 4 });
    expect(outCleared).toEqual({
      delivered: false,
      typed: true,
      tries: 1,
      reason: 'the screen read idle and no working screen showed',
      submittedAt: expect.any(Number),
    });
    expect(clearedMidPoll.typed).toEqual([LINE]);
    expect(clearedMidPoll.enters).toBe(1);

    // 3. A partial line left mid-poll (poll 1 sees workingHolding(LINE), poll 2..N sees holding(partial)).
    for (const partial of [LINE.slice(0, 12), LINE.slice(5)]) {
      let partialPoll = 0;
      const partialMidPoll = wakeFake((read, enters) => {
        if (read < 2) return IDLE;
        if (enters === 0) return holding(LINE);
        partialPoll += 1;
        return partialPoll <= 2 ? workingHolding(LINE) : holding(partial);
      });
      const outPartial = await deliverTypedWake(partialMidPoll.host, 'pane-1', LINE, 'muse', { ...FAST, verifyMs: 4 });
      expect(outPartial).toEqual({
        delivered: false,
        typed: true,
        tries: 1,
        reason: 'the box held text other than the line and no working screen showed',
      });
      expect(partialMidPoll.typed).toEqual([LINE]);
      expect(partialMidPoll.enters).toBe(1);
    }
  });
});
