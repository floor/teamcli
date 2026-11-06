// Independent scenes for the Antigravity typed wake. The frames are captured panes.
// An empty prompt whose footer is the shortcuts line is woken. A working frame is never typed into, and a permission dialog is never typed into.
// No herdr runs.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';

const IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12', 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12', 'working-synthetic.txt'), 'utf8');
const PERMISSION = readFileSync(join(import.meta.dir, 'fixtures', 'antigravity', '1.4.1', 'permission.txt'), 'utf8');

const LINE = 'wake the idle seat';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1, ackSettleMs: 1 };

/** The captured empty prompt with the shortcuts line under the box in place of the older footer. */
function shortcutsIdle(): string {
  return IDLE.split('\n').map((line) => (
    line.includes('? for shortcuts') ? 'Press ? to see keyboard shortcuts.' : line
  )).join('\n');
}

function holding(): string {
  return IDLE.replace(/^>\s*$/m, `> ${LINE}`);
}

function capture(before: string) {
  const typed: string[] = [];
  let enters = 0;
  const echoed = holding();
  const host: TypedWakeHost = {
    read: () => (enters > 0 ? WORKING : typed.length > 0 ? echoed : before),
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

async function wake(before: string) {
  const pane = capture(before);
  const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
  return { delivered: out.delivered, reason: out.reason, typed: pane.typed, enters: pane.enters() };
}

test('an idle agy prompt is woken', async () => {
  const out = await wake(shortcutsIdle());
  expect(out).toEqual({
    delivered: true,
    reason: 'the working screen showed after 1 Enter',
    typed: [LINE],
    enters: 1,
  });
});

test('a working agy frame is never typed into', async () => {
  const out = await wake(WORKING);
  expect(out.delivered).toBe(false);
  expect(out.typed).toEqual([]);
  expect(out.enters).toBe(0);
  expect(out.reason).toContain('the first read showed working');
  expect(out.reason).toContain('nothing was typed');
});

test('an agy permission dialog is never typed into', async () => {
  const out = await wake(PERMISSION);
  expect(out.delivered).toBe(false);
  expect(out.typed).toEqual([]);
  expect(out.enters).toBe(0);
  expect(out.reason).toContain('the first read showed permission');
  expect(out.reason).toContain('nothing was typed');
});
