// Synthetic Cursor screens for a typed wake. A busy frame paints the follow-up placeholder,
// the stop hint, and a spinner. That is a running turn: no Enter, and the send names that
// working screen. An empty placeholder is idle. Real text in the box is unsent, and it is
// not pressed. The pane host is the outer edge.
import { expect, test } from 'bun:test';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readScreen } from '../src/watch/screen.ts';

const PANE = 'fixture-pane-one';
const LINE = 'Answer the note.';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1, ackSettleMs: 1 };

function frame(rows: readonly string[]): string {
  return `${rows.join('\n')}\n`;
}

const status = ['', '', '  Grok 4.7', '  <workspace>'] as const;

const idle = frame(['  → Add a follow-up', ...status]);

const busy = frame([
  '  ⠋ Working',
  '  → Add a follow-up                  ctrl+c to stop',
  ...status,
]);

const unsent = frame(['  → Reply with the note.', ...status]);

function holding(line: string): string {
  return idle.replace('  → Add a follow-up', `  → ${line}`);
}

function hostOf(screen: (read: number, enters: number, typed: readonly string[]) => string): {
  host: TypedWakeHost;
  typed: string[];
  enters: () => number;
} {
  const typed: string[] = [];
  let reads = 0;
  let enters = 0;
  const host: TypedWakeHost = {
    read: () => screen(reads++, enters, typed),
    type: (_pane, text) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    wait: async () => {},
  };
  return { host, typed, enters: () => enters };
}

test('a busy placeholder and spinner take no Enter and the send does not say the line stayed in the box', async () => {
  expect(readScreen('cursor', busy).kind).toBe('working');
  const pane = hostOf(() => busy);
  const out = await deliverTypedWake(pane.host, PANE, LINE, 'cursor', FAST);
  expect(pane.enters()).toBe(0);
  expect(pane.typed).toEqual([]);
  expect(out.delivered).toBe(false);
  expect(out.tries).toBe(0);
  expect(out.reason).toContain('working');
  expect(out.reason).not.toContain('stayed in the box');
});

test('an empty follow-up placeholder is idle and one Enter submits the line', async () => {
  expect(readScreen('cursor', idle).kind).toBe('idle');
  const pane = hostOf((read, enters, typed) => {
    if (read < 2) return idle;
    if (enters === 0) return holding(typed[typed.length - 1] ?? LINE);
    return busy;
  });
  const out = await deliverTypedWake(pane.host, PANE, LINE, 'cursor', FAST);
  expect(pane.typed).toEqual([LINE]);
  expect(pane.enters()).toBe(1);
  expect(out.delivered).toBe(true);
  expect(out.tries).toBe(1);
  expect(out.reason).toContain('working');
  expect(out.reason).not.toContain('stayed in the box');
});

test('real unsent text takes no Enter and is not reported as a line that stayed in the box', async () => {
  expect(readScreen('cursor', unsent).kind).toBe('unsent');
  const pane = hostOf(() => unsent);
  const out = await deliverTypedWake(pane.host, PANE, LINE, 'cursor', FAST);
  expect(pane.enters()).toBe(0);
  expect(pane.typed).toEqual([]);
  expect(out.delivered).toBe(false);
  expect(out.tries).toBe(0);
  expect(out.reason).toContain('unsent');
  expect(out.reason).not.toContain('stayed in the box');
});
