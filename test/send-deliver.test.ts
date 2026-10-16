import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BACKOFF_MS,
  MAX_TRIES,
  bindPane,
  deliverTrigger,
  type DeliverHost,
} from '../src/send/deliver.ts';
import { SETTLE_MS, type NativePane } from '../src/send/native.ts';

// A fake Claude Code box, drawn from the captures the screen reader is pinned to: the idle screen
// with a faint suggestion, and the same screen with its input row replaced.
const FIXTURES = join(import.meta.dir, 'fixtures', 'claude-code', '2.1.289');
const capture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n');
const IDLE = capture('idle-suggestion-ansi.txt');
const PROMPT = '\u276f\u00a0';
const INPUT_ROW = IDLE.split('\n').findIndex((row) => row.startsWith(PROMPT));
const FAINT = (text: string): string => `\x1b[0m\x1b[2m${text}\x1b[0m`;

function screenWith(row: string): string {
  const rows = IDLE.split('\n');
  rows[INPUT_ROW] = row;
  return rows.join('\n');
}

const LINE = 'Read /tmp/drops/native/m1 and do that.';
const PROFILE = 'claude-code';

type Behaviour = {
  /** What the box draws when it is empty: a faint suggestion, or nothing at all. */
  empty?: 'suggestion' | 'blank';
  /** How many Enters the CLI swallows before one submits; Infinity never submits. */
  swallow?: number;
  /** What the box already holds before anything is typed. */
  preload?: string;
  /** The screen to show instead of the box while it is a dialog. */
  dialog?: string;
  /** The status herdr reports once the seat has taken a line. */
  after?: string;
  /** The box keeps the line even when the seat is working: a line queued behind a turn. */
  keepsLine?: boolean;
  /** The pane refuses the typed text. */
  refusesText?: boolean;
};

/** A seat's pane: one box, one herdr status, every key logged. */
function fakeCli(behaviour: Behaviour = {}): DeliverHost & { typed: string[]; enters: number; waited: number[]; log: string[] } {
  let box = behaviour.preload ?? '';
  let swallowed = 0;
  let status = 'idle';
  const typed: string[] = [];
  const waited: number[] = [];
  const log: string[] = [];
  const cli = {
    typed,
    waited,
    log,
    enters: 0,
    typeText: (_pane: string, text: string): boolean => {
      if (behaviour.refusesText) return false;
      typed.push(text);
      box += text;
      log.push(`type:${text}`);
      return true;
    },
    pressEnter: (_pane: string): boolean => {
      cli.enters += 1;
      log.push('enter');
      if (box === '') return true; // an Enter on an empty box submits nothing
      if (swallowed < (behaviour.swallow ?? 0)) {
        swallowed += 1;
        return true;
      }
      status = behaviour.after ?? 'working';
      if (!behaviour.keepsLine) box = '';
      return true;
    },
    status: (_pane: string): string | null => status,
    wait: async (ms: number): Promise<void> => {
      waited.push(ms);
    },
    readAnsi: (_pane: string): string | null => {
      if (behaviour.dialog !== undefined) return behaviour.dialog;
      if (box !== '') return screenWith(`${PROMPT}${box}`);
      return screenWith(behaviour.empty === 'blank' ? PROMPT : `${PROMPT}${FAINT('Try "fix typecheck errors"')}`);
    },
  };
  return cli;
}

const settled = (cli: { waited: number[] }): number => cli.waited.reduce((sum, ms) => sum + ms, 0) - SETTLE_MS;

describe('a box that swallows the first Enter', () => {
  test('is pressed again and the delivery is verified', async () => {
    const cli = fakeCli({ swallow: 1 });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('delivered');
    expect(result.tries).toBe(2);
    expect(result.status).toBe('working');
    expect(cli.typed).toEqual([LINE]);
    expect(cli.enters).toBe(2);
  });

  test('a first Enter that works is the only one', async () => {
    const cli = fakeCli();
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'delivered', tries: 1 });
    expect(cli.enters).toBe(1);
  });

  test('two swallowed Enters are still within the three tries', async () => {
    const cli = fakeCli({ swallow: 2 });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'delivered', tries: 3 });
  });
});

describe('a box that never submits', () => {
  test('is not-submitted, with the text the box holds, after three tries', async () => {
    const cli = fakeCli({ swallow: Infinity });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('not-submitted');
    expect(result.box).toBe(LINE);
    expect(result.tries).toBe(MAX_TRIES);
    expect(cli.enters).toBe(MAX_TRIES);
  });

  test('each try waits longer: one, three, then nine seconds', async () => {
    expect(BACKOFF_MS).toEqual([1000, 3000, 9000]);
    const cli = fakeCli({ swallow: Infinity });
    await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(settled(cli)).toBe(1000 + 3000 + 9000);
  });

  test('a seat working with the line still in the box is not verified', async () => {
    const cli = fakeCli({ keepsLine: true });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('not-submitted');
    expect(result.box).toBe(LINE);
  });

  test('a box that the seat cleared but herdr never called working is not-submitted, and gets no more Enters', async () => {
    const cli = fakeCli({ after: 'idle' });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'not-submitted', box: '', tries: 1 });
    expect(cli.enters).toBe(1);
  });
});

describe('a faint suggestion in the box', () => {
  test('counts as empty: the line is typed, not held, and Enter is pressed once', async () => {
    const cli = fakeCli({ empty: 'suggestion' });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'delivered', tries: 1 });
    expect(cli.log).toEqual([`type:${LINE}`, 'enter']);
  });

  test('is never taken for the trigger: an unsubmitted send is not-submitted with an empty box, and no Enter follows', async () => {
    const cli = fakeCli({ empty: 'suggestion', after: 'idle' });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('not-submitted');
    expect(result.box).toBe('');
    expect(cli.enters).toBe(1);
  });

  test('a blank box reads the same', async () => {
    const cli = fakeCli({ empty: 'blank' });
    expect(await deliverTrigger(cli, 'w1:p1', LINE, PROFILE)).toMatchObject({ outcome: 'delivered', tries: 1 });
  });
});

describe('a box or a pane that is not for typing', () => {
  test('text a person left in the box is held, and nothing is typed or sent', async () => {
    const cli = fakeCli({ preload: 'half a sentence' });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'held', box: 'half a sentence', tries: 0 });
    expect(cli.log).toEqual([]);
  });

  test('a dialog is unreachable, and gets no key', async () => {
    const cli = fakeCli({ dialog: capture('permission-read-wide-ansi.txt') });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('unreachable');
    expect(result.reason).toContain('permission');
    expect(cli.log).toEqual([]);
  });

  test('a pane that will not take the text is unreachable', async () => {
    const cli = fakeCli({ refusesText: true });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'unreachable', tries: 0 });
    expect(cli.enters).toBe(0);
  });

  test('a status herdr cannot read is unreachable', async () => {
    const cli = { ...fakeCli(), status: () => null };
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('unreachable');
    expect(cli.typed).toEqual([]);
  });

  test('a box that reads back something other than the trigger gets no Enter', async () => {
    const cli = fakeCli();
    const typeText = cli.typeText;
    cli.typeText = (pane, text) => typeText(pane, `${text} and something else`);
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('held');
    expect(result.box).toContain('and something else');
    expect(cli.enters).toBe(0);
  });

  test('an Enter herdr did not take, with the line still in the box, is not-submitted with that line', async () => {
    const cli = fakeCli();
    cli.pressEnter = () => false;
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'not-submitted', box: LINE, tries: 0 });
  });

  test('an Enter herdr did not take, with nothing in the box to show for it, is unreachable', async () => {
    const cli = fakeCli({ empty: 'suggestion' });
    // The typed text never reaches the box this fake draws, so the pane cannot be keyed.
    const typeText = cli.typeText;
    cli.typeText = (pane, text) => (typeText(pane, text), true);
    cli.pressEnter = () => false;
    cli.readAnsi = () => screenWith(`${PROMPT}${FAINT('Try "fix typecheck errors"')}`);
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'unreachable', tries: 0 });
  });
});

describe('a box that cannot be read', () => {
  test('the herdr status alone verifies, as it did before', async () => {
    const cli = fakeCli();
    const blind: DeliverHost = { ...cli };
    delete blind.readAnsi;
    expect(await deliverTrigger(blind, 'w1:p1', LINE, PROFILE)).toMatchObject({ outcome: 'delivered', tries: 1 });
  });

  test('an unverified send is not-submitted with no box text, never a success', async () => {
    const cli = fakeCli({ swallow: Infinity });
    const blind: DeliverHost = { ...cli };
    delete blind.readAnsi;
    const result = await deliverTrigger(blind, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('not-submitted');
    expect(result.box).toBeUndefined();
  });
});

describe('binding a pane to a session', () => {
  test('passes the session to every operation and reads the styled screen', async () => {
    const calls: string[] = [];
    const native: NativePane = {
      typeText: (session, pane, text) => (calls.push(`type ${session} ${pane} ${text}`), true),
      pressEnter: (session, pane) => (calls.push(`enter ${session} ${pane}`), true),
      status: (session, pane) => (calls.push(`status ${session} ${pane}`), 'idle'),
      wait: async () => {},
      paneText: (session, pane) => (calls.push(`read ${session} ${pane}`), 'screen'),
    };
    const host = bindPane(native, 'acme');
    host.typeText('w1:p1', 'x');
    host.pressEnter('w1:p1');
    host.status('w1:p1');
    expect(host.readAnsi?.('w1:p1')).toBe('screen');
    expect(calls).toEqual(['type acme w1:p1 x', 'enter acme w1:p1', 'status acme w1:p1', 'read acme w1:p1']);
  });

  test('a pane that cannot be read has no readAnsi', () => {
    const native: NativePane = { typeText: () => true, pressEnter: () => true, status: () => 'idle', wait: async () => {} };
    expect(bindPane(native, 'acme').readAnsi).toBeUndefined();
  });
});
