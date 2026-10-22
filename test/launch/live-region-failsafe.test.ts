// The documented expectation for the side effect of the sound fail-safe in liveRegion (the R4
// product fix): a window whose newest turn ended without a completion row has no turn-end row
// above the frame, so nothing in the visible transcript is proven history and all of it stays
// live. When an older error is still visible higher in that window, the screen is a provider
// error even though the newest turn is in fact over: delivery holds, typing nothing and pressing
// no Enter, until that older error scrolls off. A completion row under the older error is the
// other way the error becomes history; the window left after the error scrolls off is idle and
// takes the line once. This file pins that trade-off as intended behavior; it changes no product
// code.
import { describe, expect, test } from 'bun:test';
import { deliverRules, type Delivery, type Refusal } from '../../src/launch/deliver.ts';
import { dialogKind } from '../../src/send/deliver.ts';
import { readScreen, type Screen } from '../../src/watch/screen.ts';
import { claudeBox } from '../helpers.ts';

const LOST = 'API Error: Connection lost mid-response. The response above may be incomplete.';
const DONE = '✻ Cooked for 5m 51s · done 4:49 AM';
const RULES = 'Synthetic rules.';

/** An older turn whose provider error is still visible, with the blank line a new turn follows. */
const OLDER = [
  '❯ Please fix the parser.',
  '⏺ The parser is updated; two tests still fail.',
  `⏺ ${LOST}`,
  '',
];

/** The newest turn: it ended, but the window carries no completion row for it. */
const NEWER = [
  '❯ Run the failing tests again.',
  '⏺ The run is finished; this turn shows no completion row.',
  '',
];

/** The scene the floor asked to document: older error above, newest turn with no completion. */
const OLDER_ERROR_LIVE = [...OLDER, ...NEWER, claudeBox('')].join('\n');

/** The same window once the older error has scrolled off the top. */
const ERROR_SCROLLED_OFF = [...NEWER, claudeBox('')].join('\n');

/** A completion row under the older error: it proves the error history even though the newest
 *  turn draws no completion row of its own. */
const COMPLETION_UNDER_OLDER = [...OLDER.slice(0, 3), '', DONE, '', ...NEWER, claudeBox('')].join('\n');

/** A submitted line leaves the box empty; the pane reports the turn working. */
function withDraft(screen: string, text: string): string {
  const rows = screen.split('\n');
  const at = rows.findIndex((row) => row === '❯' || row === '❯ ');
  if (at < 0) throw new Error('the screen has no empty input row');
  rows[at] = rows[at] === '❯' ? `❯ ${text}` : `❯ ${text}`;
  return rows.join('\n');
}

type Ran = {
  read: Screen['kind'];
  result: boolean | 'no-agent';
  typed: string[];
  entered: number;
  refusals: Refusal[];
  clock: number;
};

/** Rules delivery against a pane that stands at `screen`: a pane that would take the input draws
 *  the typed draft, and Enter submits it into a running turn. A refusal must reach none of that,
 *  which the `typed`/`entered` readings make visible. */
async function deliver(screen: string): Promise<Ran> {
  let current = screen;
  let word = 'idle';
  let clock = 0;
  const typed: string[] = [];
  let entered = 0;
  const refusals: Refusal[] = [];
  const io: Delivery = {
    screen: () => current,
    status: () => word,
    foreground: () => ['claude'],
    file: () => true,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    report: (why) => { refusals.push(why); },
    type: (text) => { typed.push(text); current = withDraft(screen, text); return true; },
    enter: () => { entered += 1; current = ERROR_SCROLLED_OFF; word = 'working'; return true; },
  };
  const result = await deliverRules('claude-code', RULES, 1, io);
  return { read: readScreen('claude-code', screen).kind, result, typed, entered, refusals, clock };
}

describe('the liveRegion fail-safe over an older error', () => {
  test('the scene shows the older error and no completion row anywhere', () => {
    const rows = OLDER_ERROR_LIVE.split('\n');
    expect(rows).toContain(`⏺ ${LOST}`);
    expect(rows[rows.indexOf(`⏺ ${LOST}`) - 1]).toBe('⏺ The parser is updated; two tests still fail.');
    expect(rows).toContain('⏺ The run is finished; this turn shows no completion row.');
    expect(rows.some((row) => row.includes('✻'))).toBe(false);
  });

  test('an older error stays live while the newest turn shows no completion row', async () => {
    const ran = await deliver(OLDER_ERROR_LIVE);
    expect(ran.read).toBe('provider error');
    expect(dialogKind('claude-code', OLDER_ERROR_LIVE)).toBe('provider error');
    expect(ran.result).toBe(false);
    expect(ran.typed).toEqual([]);
    expect(ran.entered).toBe(0);
    expect(ran.refusals).toHaveLength(1);
    expect(ran.refusals[0]).toMatchObject({
      stop: 'screen', typed: false, sent: false, kind: 'provider error', row: null,
    });
  });

  test('the hold ends when the older error scrolls off the window', async () => {
    expect(ERROR_SCROLLED_OFF).not.toContain(LOST);
    const ran = await deliver(ERROR_SCROLLED_OFF);
    expect(ran.read).toBe('idle');
    expect(dialogKind('claude-code', ERROR_SCROLLED_OFF)).toBeNull();
    expect(ran.result).toBe(true);
    expect(ran.typed).toEqual([RULES]);
    expect(ran.entered).toBe(1);
    expect(ran.refusals).toEqual([]);
  });

  test('a completion under the older error keeps it history: the window is idle', async () => {
    expect(readScreen('claude-code', COMPLETION_UNDER_OLDER)).toEqual({ kind: 'idle' });
    expect(dialogKind('claude-code', COMPLETION_UNDER_OLDER)).toBeNull();
    const ran = await deliver(COMPLETION_UNDER_OLDER);
    expect(ran.result).toBe(true);
    expect(ran.typed).toEqual([RULES]);
    expect(ran.entered).toBe(1);
    expect(ran.refusals).toEqual([]);
  });
});
