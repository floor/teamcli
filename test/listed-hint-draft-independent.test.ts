// A listed Muse hint is the empty box only when it is faint or drawn in the declared grey.
// Any other single colour, a partial line, and the same words with more text stay a draft.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { classifyComposer, readBox, readScreen } from '../src/watch/screen.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'muse', '1.4.11');
const WORKING = readFileSync(join(FIXTURES, 'working-synthetic.txt'), 'utf8');
const TOP_RULE =
  '── Voice input (⌥ + v to start) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────';
const BOTTOM_RULE =
  '───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────';
const GOAL = '/goal pins a session objective with a progress bar';
const TASKS = '/tasks shows your open tasks';
const WAKE = 'Read the fixture note and answer it.';
const PANE = 'fixture-pane-one';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };
const DECLARED = '38;2;103;108;116';
const TYPED_BLUE = '38;2;90;160;255';

function frame(inputRow: string): string {
  return [
    '',
    '  Muse Code 1.4.11',
    '',
    '  Skills: 56 loaded · 2 warnings (ctrl+o to expand)',
    '',
    TOP_RULE,
    inputRow,
    BOTTOM_RULE,
    '  muse-wonder-full-1.0 · high · ~/fixture/project · YOLO',
    '',
  ].join('\n');
}

function painted(text: string, sgr: string): string {
  return frame(`❯ \x1b[${sgr}m${text}\x1b[0m`);
}

function hostFor(screen: string): { host: TypedWakeHost; typed: string[]; enters: number } {
  const typed: string[] = [];
  let enters = 0;
  let reads = 0;
  const host: TypedWakeHost = {
    read: () => {
      reads += 1;
      return enters > 0 ? WORKING : reads < 3 ? screen : frame(`❯ ${typed[typed.length - 1] ?? ''}`);
    },
    type: (_pane: string, text: string) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    wait: async () => {},
  };
  return {
    host,
    typed,
    get enters() {
      return enters;
    },
  };
}

describe('a listed Muse hint stays a draft unless it is faint or the declared grey', () => {
  test('faint text and the declared grey read idle and the wake types into them', async () => {
    for (const [text, screen] of [
      [GOAL, painted(GOAL, '2')],
      [GOAL, painted(GOAL, DECLARED)],
      [TASKS, painted(TASKS, DECLARED)],
    ] as const) {
      expect(readScreen('muse', screen).kind).toBe('idle');
      expect(classifyComposer('muse', screen.split('\n')).kind).toBe('idle');
      expect(readBox('muse', screen)).toBeNull();
      expect(boxHoldsText('muse', text, screen)).toBe(false);
      const wake = hostFor(screen);
      const out = await deliverTypedWake(wake.host, PANE, WAKE, 'muse', FAST);
      expect(out.delivered).toBe(true);
      expect(wake.typed).toEqual([WAKE]);
      expect(wake.enters).toBe(1);
    }
  });

  test('typed blue, other colours, and 256-colour forms stay drafts and nothing is typed', async () => {
    const colours = [TYPED_BLUE, '38;2;120;125;130', '38;2;200;80;40', '90', '38;5;244', '38;5;245', '36', '32'];
    for (const sgr of colours) {
      for (const text of [GOAL, TASKS]) {
        const screen = painted(text, sgr);
        expect(readScreen('muse', screen).kind).toBe('unsent');
        expect(classifyComposer('muse', screen.split('\n')).kind).toBe('unsent');
        expect(readBox('muse', screen)?.first).toBe(text);
        expect(boxHoldsText('muse', text, screen)).toBe(true);
        const wake = hostFor(screen);
        const out = await deliverTypedWake(wake.host, PANE, WAKE, 'muse', FAST);
        expect(out).toEqual({
          delivered: false,
          typed: false,
          tries: 0,
          reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed',
        });
        expect(wake.typed).toEqual([]);
        expect(wake.enters).toBe(0);
      }
    }
  });

  test('a partial line and a listed line with more words stay drafts in typed blue, 256-colour, and bright black', async () => {
    const drafts = ['/goal pins', '/tasks shows', `${GOAL} now`, `${TASKS} and more`, 'pins a session objective'];
    for (const text of drafts) {
      for (const sgr of [TYPED_BLUE, '38;5;244', '38;5;245', '90', '36']) {
        const screen = painted(text, sgr);
        expect(readScreen('muse', screen).kind).toBe('unsent');
        expect(readBox('muse', screen)?.first).toBe(text);
        expect(boxHoldsText('muse', text, screen)).toBe(true);
        const wake = hostFor(screen);
        const out = await deliverTypedWake(wake.host, PANE, WAKE, 'muse', FAST);
        expect(out.delivered).toBe(false);
        expect(wake.typed).toEqual([]);
      }
      for (const sgr of ['2', DECLARED]) {
        const empty = painted(text, sgr);
        expect(readScreen('muse', empty).kind).toBe('idle');
        expect(readBox('muse', empty)).toBeNull();
      }
    }
  });
});
