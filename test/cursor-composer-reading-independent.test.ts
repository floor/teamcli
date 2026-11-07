// A Cursor window whose first row is the column-two prompt, with the status row under it,
// is the composer. An empty follow-up placeholder there is idle and one Enter submits. Real
// text there is unsent and takes no Enter. A non-blank row pressed against the prompt from
// above stays unknown. Another profile whose window starts on its prompt stays unknown. The
// busy frame, placeholder plus spinner plus the stop hint, stays a running turn.
import { expect, test } from 'bun:test';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readScreen } from '../src/watch/screen.ts';

const PANE = 'fixture-pane-one';
const LINE = 'Answer the note.';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1, ackSettleMs: 1 };

function frame(rows: readonly string[]): string {
  return `${rows.join('\n')}\n`;
}

const cursorTail = ['', '', '  Grok 4.7', '  <workspace>'] as const;

const idle = frame(['  → Add a follow-up', ...cursorTail]);

const unsent = frame(['  → Reply with the note.', ...cursorTail]);

const pressed = frame(['  earlier row', '  → Add a follow-up', ...cursorTail]);

const busy = frame([
  '  ⠋ Working',
  '  → Add a follow-up                  ctrl+c to stop',
  ...cursorTail,
]);

const codex = frame([
  '› Ask Codex to do anything',
  '',
  '  GPT-5.4 high · weekly',
]);

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

test('an empty follow-up placeholder at the top of the window is idle and one Enter submits', async () => {
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
});

test('real text at the top of the window is unsent and takes no Enter', async () => {
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

test('a non-blank row pressed against the prompt from above stays unknown', async () => {
  expect(readScreen('cursor', pressed).kind).toBe('unknown');
  const pane = hostOf(() => pressed);
  const out = await deliverTypedWake(pane.host, PANE, LINE, 'cursor', FAST);
  expect(pane.enters()).toBe(0);
  expect(pane.typed).toEqual([]);
  expect(out.delivered).toBe(false);
  expect(out.reason).toContain('unknown');
});

test('another profile stays unknown when its window starts on the prompt', async () => {
  expect(readScreen('codex', codex).kind).toBe('unknown');
  const pane = hostOf(() => codex);
  const out = await deliverTypedWake(pane.host, PANE, LINE, 'codex', FAST);
  expect(pane.enters()).toBe(0);
  expect(pane.typed).toEqual([]);
  expect(out.delivered).toBe(false);
  expect(out.reason).toContain('unknown');
});

test('a busy placeholder with a spinner and the stop hint stays a running turn', async () => {
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
