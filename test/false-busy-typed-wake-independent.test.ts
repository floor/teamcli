// Independent scenes for the false-busy typed wake. The frames are captured Grok panes.
// An empty idle prompt under a leftover spinner, or under a leftover turn-status line, is
// still the idle prompt: one agent prompt delivers the line, with no typing and no Enter. A pane
// mid-turn is never typed into. An empty prompt whose box already holds text is not typed
// over. No herdr runs.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';

const IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.70', 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.52', 'working.txt'), 'utf8');
const UNSENT = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.50', 'unsent.txt'), 'utf8');

const LINE = 'wake the idle seat';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1, ackSettleMs: 1 };
const SPINNER = '   ⠸ Waiting for response…        16s ⇣20.7k [stop]';
const STATUS = '  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+.:';

function drawn(frame: string, text: string): string {
  return frame.replace(/^( {2}│ ❯)(.*)$/m, (_match, prompt: string, rest: string) => {
    const trimmed = rest.trimEnd();
    const edge = trimmed.endsWith('│') ? '│' : '';
    const room = trimmed.length - edge.length;
    const gap = Math.max(1, room - text.length);
    return `${prompt} ${text}${' '.repeat(gap)}${edge}`;
  });
}

/** The idle prompt with one leftover row at the top of the pane window, above the
 *  rows beside the box. The box itself stays empty. */
function under(row: string): string {
  const lines = IDLE.split('\n');
  const fence = lines.findIndex((line) => line.startsWith('  ╭'));
  const at = Math.max(0, lines.length - 20);
  if (fence - at < 9 || lines[at]?.trim() !== '') {
    throw new Error('the leftover row is not in the transcript above the prompt');
  }
  lines[at] = row;
  return lines.join('\n');
}

function capture(before: string) {
  const typed: string[] = [];
  const prompts: string[] = [];
  let enters = 0;
  const holding = drawn(IDLE, LINE);
  const host: TypedWakeHost = {
    read: () => (prompts.length > 0 ? WORKING : typed.length > 0 ? holding : before),
    type: (_pane, text) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    prompt: (_pane, text) => {
      prompts.push(text);
      return true;
    },
    wait: async () => {},
  };
  return { host, typed, prompts, enters: () => enters };
}

async function wake(before: string) {
  const pane = capture(before);
  const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'grok', FAST);
  return { delivered: out.delivered, reason: out.reason, typed: pane.typed, prompts: pane.prompts, enters: pane.enters() };
}

const asked = {
  delivered: true,
  reason: 'the working screen showed after the agent prompt',
  typed: [] as string[],
  prompts: [LINE],
  enters: 0,
};

test('an idle prompt under a stale spinner or status line is delivered by one agent prompt', async () => {
  const spinner = await wake(under(SPINNER));
  const status = await wake(under(STATUS));
  expect({ spinner, status }).toEqual({ spinner: asked, status: asked });
});

test('a pane mid-turn is never typed into', async () => {
  const out = await wake(WORKING);
  expect(out.delivered).toBe(false);
  expect(out.typed).toEqual([]);
  expect(out.enters).toBe(0);
  expect(out.reason).toContain('the first read showed working');
  expect(out.reason).toContain('nothing was typed');
  expect(out.prompts).toEqual([]);
});

test('an empty prompt with leftover text in the input box is not typed over', async () => {
  const out = await wake(UNSENT);
  expect(out.delivered).toBe(false);
  expect(out.typed).toEqual([]);
  expect(out.enters).toBe(0);
  expect(out.reason).toContain('the first read showed unsent');
  expect(out.reason).toContain('nothing was typed');
  expect(out.prompts).toEqual([]);
  expect(UNSENT).toContain('RULES_RECEIVED');
});
