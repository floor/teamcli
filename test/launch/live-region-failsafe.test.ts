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
import { NO_PANE_MESSAGING } from '../../src/send/no-pane-messaging.ts';
import { readScreen, type Screen } from '../../src/watch/screen.ts';
import { claudeBox } from '../helpers.ts';

const LOST = 'API Error: Connection lost mid-response. The response above may be incomplete.';
const DONE = '✻ Cooked for 5m 51s · done 4:49 AM';
const RULES = 'Synthetic rules.';
const UPDATE_NOTICE = '✔ Update installed · Restart to update';
const STATUS = '  no-git · …/lobbies/teamcli · deepseek-flash · S: $000.0 ⣿⣿⣿⣶⣀ 12% · L: 10% (0h00m) · W: 100% (-00.0%) (00h0m)';
const BYPASS = '  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const WIDE_TOP = `${'─'.repeat(220)} builder-7 ─`;
const WIDE_BOTTOM = '─'.repeat(WIDE_TOP.length);

/** Atlas R4-6: the provider error wraps at a narrow pane width, then the idle frame follows. */
const WRAPPED_ACTIVE_ERROR = [
  '⏺ API Error: Connection lost mid-response. The response',
  '  above may be incomplete.',
  '',
  `                        ${UPDATE_NOTICE}`,
  `${'─'.repeat(48)} builder-7 ─`,
  '❯',
  '─'.repeat(60),
  STATUS,
  BYPASS,
].join('\n');

/** Atlas R4-5: the update notice shares the completion's terminal row, right-aligned. */
const COMPLETED_WITH_INLINE_NOTICE = [
  `⏺ ${LOST}`,
  '',
  `${DONE}${' '.repeat(81)}${UPDATE_NOTICE}`,
  WIDE_TOP,
  '❯',
  WIDE_BOTTOM,
  STATUS,
  BYPASS,
].join('\n');

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

  test('no pane messaging, rules are never typed; was: an older error stays live while the newest turn shows no completion row', async () => {
    const retired = await deliver(OLDER_ERROR_LIVE);
    const done = await retired;
    expect(done.result).toBe(false);
    expect(done.typed).toEqual([]);
  });

  test('no pane messaging, rules are never typed; was: the hold ends when the older error scrolls off the window', async () => {
    expect(ERROR_SCROLLED_OFF).not.toContain(LOST);
    const retired = await deliver(ERROR_SCROLLED_OFF);
    const done = await retired;
    expect(done.result).toBe(false);
    expect(done.typed).toEqual([]);
  });

  test('no pane messaging, rules are never typed; was: a completion under the older error keeps it history: the window is idle', async () => {
    expect(readScreen('claude-code', COMPLETION_UNDER_OLDER)).toEqual({ kind: 'idle' });
    expect(dialogKind('claude-code', COMPLETION_UNDER_OLDER)).toBeNull();
    const retired = await deliver(COMPLETION_UNDER_OLDER);
    const done = await retired;
    expect(done.result).toBe(false);
    expect(done.typed).toEqual([]);
  });

  test('a wrapped active provider error keeps a narrow idle-looking pane blocked', async () => {
    const ran = await deliver(WRAPPED_ACTIVE_ERROR);
    expect(readScreen('claude-code', WRAPPED_ACTIVE_ERROR)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', WRAPPED_ACTIVE_ERROR)).toBe('provider error');
    expect(ran.read).toBe('provider error');
    expect(ran.result).toBe(false);
    expect(ran.typed).toEqual([]);
    expect(ran.entered).toBe(0);
    // No pane messaging: delivery refuses before any screen is read, so the refusal carries the
    // no-pane line; the reading asserted above is what keeps the narrow pane blocked.
    expect(ran.refusals[0]).toMatchObject({
      stop: 'typing', typed: false, sent: false, kind: 'unknown', row: NO_PANE_MESSAGING,
    });
  });

  test('no pane messaging, rules are never typed; was: a right-aligned update notice on the completion row leaves the prompt deliverable', async () => {
    expect(readScreen('claude-code', COMPLETED_WITH_INLINE_NOTICE)).toEqual({ kind: 'idle' });
    expect(dialogKind('claude-code', COMPLETED_WITH_INLINE_NOTICE)).toBeNull();
    const ran = await deliver(COMPLETED_WITH_INLINE_NOTICE);
    expect(ran.read).toBe('idle');
    expect(ran.result).toBe(false);
    expect(ran.typed).toEqual([]);
  });
});
