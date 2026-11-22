// The watch never leaves its own text in a composer (2026-11-21, material lead: a typed pointer sat
// unsubmitted on the `❯` row for 5.5 hours after the seat went mid-turn between the idle reads and
// the Enter). A wake that typed its line and did not submit it takes exactly that line back out,
// only while the box still shows that line (or, after a clear press, a leading part of it), and
// the result no longer says the line was written.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';

const IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'claude-code', '2.1.326', 'idle.txt'), 'utf8');
const LINE = 'team: 1 unread message waiting — read them all with: team drops --read --seat helper [w:8bc6]';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, ackSettleMs: 1, verifyMs: 1, reportLine: true as const };

/** A Claude pane: its composer text and whether a turn runs. `busyAfterType` starts a turn the
 *  moment the line lands (the seat went mid-turn between the idle reads and the Enter). */
function pane(options: { busyAfterType?: boolean; enterSubmits?: boolean; other?: string } = {}) {
  const state = { box: '', working: false, keys: [] as string[], enters: 0 };
  const draw = (): string => {
    const base = state.box === '' ? IDLE : IDLE.replace(/❯[^\n]*/, `❯ ${state.box}`);
    return state.working ? base.replace(/\n(─+\n❯)/, '\n✢ Channeling… (7s · ↓ 2 tokens)\n$1') : base;
  };
  const host: TypedWakeHost = {
    read: () => draw(),
    type: (_p, text) => {
      state.box += text;
      if (options.busyAfterType === true) state.working = true;
      if (options.other !== undefined) state.box = options.other;
      return true;
    },
    enter: () => {
      state.enters += 1;
      if (options.enterSubmits === true && !state.working) { state.box = ''; state.working = true; }
      return true;
    },
    key: (_p, key) => {
      state.keys.push(key);
      // ctrl+u kills the row back to its start; ctrl+c empties the box (and would stop a turn).
      if (key === 'ctrl+u' || key === 'ctrl+c') state.box = '';
      return true;
    },
    wait: async () => {},
  };
  return { host, state, draw };
}

describe('a typed line that was not submitted is taken back', () => {
  test('the seat went mid-turn before the Enter: the line is cleared with the turn key, not left', async () => {
    const p = pane({ busyAfterType: true });
    const out = await deliverTypedWake(p.host, 'pane', LINE, 'claude-code', FAST);
    expect(out.delivered).toBe(false);
    expect(p.state.box).toBe('');
    expect(p.state.keys).toEqual(['ctrl+u']);
    expect(boxHoldsText('claude-code', LINE, p.draw())).toBe(false);
    expect(out.lineWritten).toBeUndefined();
    expect(out.reason).toContain('the line was taken back out of the box');
  });

  test('a delivered wake presses no clear key', async () => {
    const p = pane({ enterSubmits: true });
    const out = await deliverTypedWake(p.host, 'pane', LINE, 'claude-code', FAST);
    expect(out.delivered).toBe(true);
    expect(p.state.keys).toEqual([]);
    expect(out.lineWritten).toBe(true);
  });

  test('a box that holds other text than the line is never cleared', async () => {
    const p = pane({ other: 'the owner typed this' });
    const out = await deliverTypedWake(p.host, 'pane', LINE, 'claude-code', FAST);
    expect(out.delivered).toBe(false);
    expect(p.state.keys).toEqual([]);
    expect(p.state.box).toBe('the owner typed this');
  });

  test('a pane that is no longer the seat\'s takes no clear key, and the line still counts as written', async () => {
    const p = pane({ busyAfterType: true });
    let keys = 0;
    const out = await deliverTypedWake(p.host, 'pane', LINE, 'claude-code', { ...FAST, beforeEachKey: () => (keys += 1) === 1 });
    expect(p.state.keys).toEqual([]);
    expect(p.state.box).toBe(LINE);
    expect(out.lineWritten).toBe(true);
    expect(out.reason).toContain('the pane did not take the clear key');
  });
});
