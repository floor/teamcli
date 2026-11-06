// Independent scene for an agent-prompt wake. A box already holding the line was left by an
// older build. The frame never changes: the prompt does not clear it. A later wake must not
// prompt again. No herdr runs.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readScreen } from '../src/watch/screen.ts';

const GROK_UNSENT = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.50', 'unsent.txt'), 'utf8');
const AGY_IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12', 'idle.txt'), 'utf8');

const LINE = 'wake the idle seat';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1, ackSettleMs: 1 };

function grokHeld(): string {
  const frame = GROK_UNSENT.replace('RULES_RECEIVED', LINE);
  if (readScreen('grok', frame).kind !== 'unsent' || !boxHoldsText('grok', LINE, frame)) {
    throw new Error('the grok frame is not a box holding the line');
  }
  return frame;
}

function agyHeld(): string {
  const frame = AGY_IDLE.replace(/^>\s*$/m, `> ${LINE}`);
  if (readScreen('antigravity', frame).kind !== 'unsent' || !boxHoldsText('antigravity', LINE, frame)) {
    throw new Error('the antigravity frame is not a box holding the line');
  }
  return frame;
}

function capture(before: string) {
  const prompts: string[] = [];
  const typed: string[] = [];
  let enters = 0;
  const host: TypedWakeHost = {
    read: () => before,
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
  return { host, prompts, typed, enters: () => enters };
}

async function twice(cli: string, before: string) {
  const pane = capture(before);
  const first = await deliverTypedWake(pane.host, 'pane-1', LINE, cli, FAST);
  const second = await deliverTypedWake(pane.host, 'pane-1', LINE, cli, FAST);
  return { prompts: pane.prompts, typed: pane.typed, enters: pane.enters(), first, second };
}

test('a grok box already holding the line is not prompted again', async () => {
  const out = await twice('grok', grokHeld());
  expect(out.prompts).toEqual([]);
  expect(out.typed).toEqual([]);
  expect(out.enters).toBe(0);
  expect(out.first.delivered).toBe(false);
  expect(out.second.delivered).toBe(false);
});

test('an antigravity box already holding the line is not prompted again', async () => {
  const out = await twice('antigravity', agyHeld());
  expect(out.prompts).toEqual([]);
  expect(out.typed).toEqual([]);
  expect(out.enters).toBe(0);
  expect(out.first.delivered).toBe(false);
  expect(out.second.delivered).toBe(false);
});
