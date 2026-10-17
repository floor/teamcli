// The quota view of `team usage`: per lab and per account the figures the machine can observe —
// a seat's own status line through herdr, a CLI's own usage print, a quota screen, and the
// watch's machine-wide reading store — with the window percentages, the reset, the pace margin
// against the window's own clock, the seats, one state and one advice line. The model and its
// renderer are tested first, from observations made here; then the live readers, each against a
// fixture of the shape it reads (the two-field status row is the real capture `status.test.ts`
// carries, and the usage print is the real `agy --print /usage` run quoted in `quota-observe.ts`);
// then the command, with an observer handed in, so this file reads no pane and runs no CLI.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { runUsage } from '../src/commands/usage.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { saveMachineReadings } from '../src/information/machine-readings.ts';
import {
  adviceOf,
  marginOf,
  quotaOf,
  quotaText,
  signed,
  type QuotaLabInput,
  type QuotaObservation,
} from '../src/information/quota.ts';
import {
  ageByReset,
  labeledFigures,
  observeQuota,
  parseUsageOutput,
  realQuotaObservations,
  setUsageExec,
  statusQuota,
} from '../src/information/quota-observe.ts';
import type { MachineUsage, TeamEntry } from '../src/information/usage.ts';
import { quotaWith } from '../src/profiles/overrides.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const NOW = Date.parse('2026-10-17T09:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The status row a real 2.1.299 screen drew (`status.test.ts` pins the same capture): the two
 *  labels, the five-hour reset, the printed margin and the weekly reset, in one line. */
const REAL_ROW = '  main · …/floor/docs · Opus 5.5 · S: $5.8 ⣿⣄⣀⣀⣀ 24% · L: 20% (2h6m) · W: 12% (+13.3%) (125h26m)';
const REAL_SCREEN = `❯\n${'─'.repeat(40)}\n${REAL_ROW}\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents\n`;

/** One observation, with the fields a test does not name defaulted to a fresh status-line read. */
function observed(one: Partial<QuotaObservation> & Pick<QuotaObservation, 'account'>): QuotaObservation {
  return {
    pool: undefined,
    window: 'weekly',
    left: null,
    used: null,
    resetsAt: null,
    resetText: null,
    observedAt: NOW - 60_000,
    source: 'status line',
    seat: null,
    margin: null,
    wall: false,
    ...one,
  } as QuotaObservation;
}

describe('the quota model', () => {
  test('the margin is the window clock minus the spend, read off the real status row', () => {
    // `W: 12% (+13.3%) (125h26m)` on a weekly window: 125h26m to reset leaves 42h34m of 168h gone,
    // 25.3%, and 25.3 − 12 = +13.3 — the figure the line itself printed, from the arithmetic the
    // model re-derives when a line prints none.
    const weekly = { used: 12, window: 'weekly' as const, resetsAt: NOW + 125 * HOUR + 26 * 60_000, margin: null };
    expect(marginOf(weekly, NOW)).toBe(13.3);
    // A line that prints its margin is believed as printed, whatever its reset says.
    expect(marginOf({ ...weekly, margin: -4.5 }, NOW)).toBe(-4.5);
    // The session window is five hours, so three hours to reset is 40% gone.
    expect(marginOf({ used: 40, window: 'session', resetsAt: NOW + 3 * HOUR, margin: null }, NOW)).toBe(0);
    // No reset, or one that has passed, gives no clock — and no margin.
    expect(marginOf({ used: 40, window: 'session', resetsAt: null, margin: null }, NOW)).toBeNull();
    expect(marginOf({ used: 40, window: 'session', resetsAt: NOW - 1, margin: null }, NOW)).toBeNull();
    expect(marginOf({ used: null, window: 'weekly', resetsAt: NOW + DAY, margin: null }, NOW)).toBeNull();
  });

  test('signed and the margin word spell the figure the way a status line does', () => {
    expect(signed(13.3)).toBe('+13.3');
    expect(signed(-10)).toBe('-10');
    expect(signed(0)).toBe('0');
  });

  const labs: QuotaLabInput[] = [
    {
      lab: 'anthropic',
      accounts: [
        { account: 'anthropic', seats: ['lead'] },
        { account: 'openai', seats: ['scout'], seatsOther: 2 },
      ],
    },
  ];
  const observations: QuotaObservation[] = [
    observed({ account: 'anthropic', window: 'session', used: 40, left: 60, resetsAt: NOW + 3 * HOUR, seat: 'lead' }),
    observed({ account: 'anthropic', window: 'weekly', used: 12, left: 88, resetsAt: NOW + 125 * HOUR + 26 * 60_000, seat: 'lead', margin: 13.3 }),
    // An older weekly read of the same account: the newest one is the one that prints.
    observed({ account: 'anthropic', window: 'weekly', used: 50, left: 50, observedAt: NOW - 4 * 60_000 }),
    // The watch's own reading of the other account, with no reset to read a clock from.
    observed({ account: 'openai', window: 'weekly', used: 95, left: 5, source: 'machine reading', observedAt: NOW - 2 * 60_000 }),
    // A wall screen: the account is out, and the screen's reset word rides the account's line.
    observed({ account: 'openai', window: null, wall: true, resetsAt: NOW + 2 * HOUR, resetText: null, source: 'quota screen' }),
  ];

  test('the block is one document, per lab and per account, with the seats and one advice line', () => {
    const quota = quotaOf({ labs, observations, accountsFile: '~/.config/team/accounts.yaml', now: NOW });
    expect(quota).toEqual({
      format: 1,
      accountsFile: '~/.config/team/accounts.yaml',
      labs: [
        {
          lab: 'anthropic',
          state: 'walled',
          accounts: [
            {
              account: 'anthropic',
              state: 'ok',
              windows: [
                { window: 'session', used: 40, left: 60, resetsAt: '2026-10-17T12:00:00.000Z', resetsIn: '3h', margin: 0, source: 'status line', seat: 'lead', age: '1m', stale: false, wall: false },
                { window: 'weekly', used: 12, left: 88, resetsAt: '2026-10-22T14:26:00.000Z', resetsIn: '125h26m', margin: 13.3, source: 'status line', seat: 'lead', age: '1m', stale: false, wall: false },
              ],
              seats: ['lead'],
              wallResets: null,
            },
            {
              account: 'openai',
              state: 'walled',
              windows: [
                { window: 'weekly', used: 95, left: 5, resetsAt: null, resetsIn: null, margin: null, source: 'machine reading', seat: null, age: '2m', stale: false, wall: false },
              ],
              seats: ['scout'],
              seatsOther: 2,
              wallResets: '2h',
            },
          ],
        },
      ],
      advice: 'swap scout off anthropic/openai (walled) to anthropic (weekly used 12%, margin +13.3%)',
    });

    expect(quotaText(quota)).toEqual([
      'quota',
      '  anthropic  walled',
      '    anthropic  ok  seats: lead',
      '      session  used 40%  left 60%  resets in 3h  margin 0%  (status line, read 1m ago)',
      '      weekly  used 12%  left 88%  resets in 125h26m  margin +13.3%  (status line, read 1m ago)',
      '    openai  walled  resets 2h  seats: scout, +2 on another team',
      '      weekly  used 95%  left 5%  resets unknown  margin not known  (machine reading, read 2m ago)',
      'advice: swap scout off anthropic/openai (walled) to anthropic (weekly used 12%, margin +13.3%)',
    ]);
  });

  test('a stale reading prints marked, carries no margin, and is never grounds for advice', () => {
    const quota = quotaOf({
      labs: [{ lab: 'anthropic', accounts: [{ account: 'anthropic', seats: [] }] }],
      observations: [observed({ account: 'anthropic', window: 'weekly', used: 40, left: 60, resetsAt: NOW + DAY, observedAt: NOW - 6 * 60_000 })],
      accountsFile: 'accounts.yaml',
      now: NOW,
    });
    expect(quota.labs[0]?.accounts[0]?.state).toBe('unknown');
    expect(quota.labs[0]?.accounts[0]?.windows[0]).toMatchObject({ stale: true, margin: null, age: '6m' });
    expect(quotaText(quota)).toContain(
      '      weekly  used 40%  left 60%  resets in 24h  margin not known  (status line, read 6m ago)  stale',
    );
    expect(quota.advice).toBe(`no account has headroom yet (no fresh margin at or above ${signed(10)}%)`);
  });

  test('a wall whose reset has already passed is a window that rolled over', () => {
    const quota = quotaOf({
      labs: [{ lab: 'anthropic', accounts: [{ account: 'anthropic', seats: [] }] }],
      observations: [observed({ account: 'anthropic', window: null, wall: true, resetsAt: NOW - 1 })],
      accountsFile: 'accounts.yaml',
      now: NOW,
    });
    expect(quota.labs[0]?.accounts[0]?.state).toBe('unknown');
    expect(quota.labs[0]?.accounts[0]?.wallResets).toBeNull();
  });

  test('the states: a fresh 100 is walled, 90 is near the cap, anything lower is ok', () => {
    const state = (used: number): string => quotaOf({
      labs: [{ lab: 'anthropic', accounts: [{ account: 'anthropic', seats: [] }] }],
      observations: [observed({ account: 'anthropic', used, left: 100 - used })],
      accountsFile: 'accounts.yaml',
      now: NOW,
    }).labs[0]?.accounts[0]?.state as string;
    expect(state(100)).toBe('walled');
    expect(state(90)).toBe('near cap');
    expect(state(89)).toBe('ok');
  });

  test('a window far ahead of its clock is near the cap under 90% used, and the advice names it', () => {
    // The live case (2026-10-17): google at 89% weekly with a -71.6% margin — spending far
    // faster than the window runs down — read `ok` and the advice said nothing. The margin is as
    // good a sign of a cap about to arrive as the used figure is.
    const quota = quotaOf({
      labs: [{ lab: 'google', accounts: [{ account: 'google', seats: [] }] }],
      observations: [observed({ account: 'google', used: 89, left: 11, margin: -71.6 })],
      accountsFile: 'accounts.yaml',
      now: NOW,
    });
    expect(quota.labs[0]?.accounts[0]?.state).toBe('near cap');
    expect(quota.advice).toBe('near cap on google (weekly used 89%, margin -71.6%)');
    // The threshold is the margin's own: a window exactly at the cap is near it, one a tenth
    // short of it is ok — the used figure alone decides nothing below NEAR_CAP.
    const state = (margin: number): string => quotaOf({
      labs: [{ lab: 'google', accounts: [{ account: 'google', seats: [] }] }],
      observations: [observed({ account: 'google', used: 89, left: 11, margin })],
      accountsFile: 'accounts.yaml',
      now: NOW,
    }).labs[0]?.accounts[0]?.state as string;
    expect(state(-50)).toBe('near cap');
    expect(state(-49.9)).toBe('ok');
  });

  test('the advice is one line: headroom, the best target first; the walled seats; or what is missing', () => {
    const two = (accounts: Array<{ account: string; seats: string[] }>, obs: QuotaObservation[]): string => adviceOf(quotaOf({
      labs: [{ lab: 'anthropic', accounts }],
      observations: obs,
      accountsFile: 'accounts.yaml',
      now: NOW,
    }).labs);
    const fresh = (account: string, used: number, margin: number | null): QuotaObservation =>
      observed({ account, used, left: 100 - used, margin });

    expect(adviceOf([])).toBe('no lab is declared on this machine: declare an account first');
    expect(two([{ account: 'anthropic', seats: [] }, { account: 'openai', seats: [] }], []))
      .toBe('no readings yet: no seat status line and no CLI usage command has answered');
    // Two accounts with headroom: the larger margin first, and both named, on one line.
    expect(two(
      [{ account: 'anthropic', seats: [] }, { account: 'openai', seats: [] }],
      [fresh('anthropic', 20, 12), fresh('openai', 10, 30)],
    )).toBe('headroom on anthropic/openai (weekly used 10%, margin +30%); anthropic (weekly used 20%, margin +12%)');
    // Fresh figures, and none of them at the +10% headroom mark.
    expect(two([{ account: 'anthropic', seats: [] }], [fresh('anthropic', 60, 3)]))
      .toBe('no account has headroom yet (no fresh margin at or above +10%)');
    // Walled seats move to the account with headroom; no headroom says so instead.
    expect(two(
      [{ account: 'anthropic', seats: ['lead', 'coda'] }, { account: 'openai', seats: [] }],
      [fresh('anthropic', 100, null), fresh('openai', 10, 30)],
    )).toBe('swap lead, coda off anthropic (walled) to anthropic/openai (weekly used 10%, margin +30%)');
    expect(two(
      [{ account: 'anthropic', seats: ['lead'] }, { account: 'openai', seats: [] }],
      [fresh('anthropic', 100, null), fresh('openai', 70, 5)],
    )).toBe('swap lead off anthropic (walled): no other account has headroom');
  });

  test('a lab with no account declared is spoken for once: the report line, not the block', () => {
    const quota = quotaOf({ labs: [{ lab: 'anthropic', accounts: [] }], observations: [], accountsFile: 'accounts.yaml', now: NOW });
    expect(quotaText(quota)).toEqual(['quota', 'advice: no lab is declared on this machine: declare an account first']);
    const none = quotaOf({ labs: [], observations: [], accountsFile: 'accounts.yaml', now: NOW });
    expect(quotaText(none)).toEqual([
      'quota',
      '  not known: no account declared; declare it in accounts.yaml',
      'advice: no lab is declared on this machine: declare an account first',
    ]);
  });
});

describe('the live sources', () => {
  test('the real status row gives both windows, and the printed margin survives', () => {
    const target = { seat: 'lead', account: 'anthropic', cli: 'claude-code' };
    const found = labeledFigures(REAL_ROW, target, NOW);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ window: 'session', used: 20, left: 80, margin: null, resetsAt: NOW + 2 * HOUR + 6 * 60_000, source: 'status line', seat: 'lead' });
    expect(found[1]).toMatchObject({ window: 'weekly', used: 12, left: 88, margin: 13.3, resetsAt: NOW + 125 * HOUR + 26 * 60_000 });
    // The other shape: the reset is the only parenthesised field, and no margin is invented.
    expect(labeledFigures('L: 20% (2h6m)', target, NOW)).toEqual([expect.objectContaining({ margin: null, resetsAt: NOW + 2 * HOUR + 6 * 60_000 })]);
    expect(labeledFigures(null, target, NOW)).toEqual([]);
  });

  test('a screen gives the status row once per window, not once per grammar that matches it', () => {
    const target = { seat: 'lead', account: 'anthropic', cli: 'claude-code' };
    const found = statusQuota('claude-code', REAL_SCREEN, target, NOW, quotaWith('claude-code', []));
    expect(found).toHaveLength(2);
    expect(found.map((one) => one.window)).toEqual(['session', 'weekly']);
    expect(found.every((one) => one.source === 'status line' && one.wall === false)).toBe(true);
    // A pane that could not be read is no observation, and no note here — the observer counts it.
    expect(statusQuota('claude-code', null, target, NOW, [])).toEqual([]);
  });

  test('a wall screen says the account is out, and keeps the reset words it printed', () => {
    const target = { seat: 'lead', account: 'xai', cli: 'grok' };
    const phrase = statusQuota('grok', 'working\n\nQuota reached for this account. It resets at 3pm\n', target, NOW, []);
    expect(phrase).toHaveLength(1);
    expect(phrase[0]).toMatchObject({ wall: true, window: null, used: null, left: null, source: 'quota screen', resetText: 'at 3pm' });
    const classified = statusQuota('claude-code', 'API Error: Request rejected (429)\nUsage limit reached\nYour limit will reset at 3pm\n', target, NOW, []);
    expect(classified).toHaveLength(1);
    expect(classified[0]).toMatchObject({ wall: true, resetText: 'at 3pm' });
    // A wall whose line names no reset is still a wall: the phrase is the observation, and the
    // missing reset reads `unknown` rather than dropping the account back to "no reading".
    const bare = statusQuota('grok', 'working\n\nout of usage\n', target, NOW, []);
    expect(bare).toHaveLength(1);
    expect(bare[0]).toMatchObject({ wall: true, resetText: null });
    const quota = quotaOf({ labs: [{ lab: 'xai', accounts: [{ account: 'xai', seats: ['scout'] }] }], observations: bare, accountsFile: '~/.config/team/accounts.yaml', now: NOW });
    expect(quota.labs[0]?.accounts[0]).toMatchObject({ state: 'walled', windows: [], wallResets: null });
    expect(quotaText(quota)).toEqual([
      'quota',
      '  xai  walled',
      '    xai  walled  resets unknown  seats: scout',
      'advice: swap scout off xai (walled): no other account has headroom',
    ]);
  });

  test('the antigravity usage print reads as the real run wrote it', () => {
    const text = [
      'Gemini Models\tWeekly Limit Remaining\t89%\t2026-10-23T21:59:46Z',
      'Gemini Models\tFive Hour Limit Remaining\t94%\t2026-10-23T21:59:46Z',
      'Claude and GPT models\tWeekly Limit Remaining\t11%\t2026-10-23T09:48:36Z',
      'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-23T09:48:36Z',
      'some other line this reader does not know',
    ].join('\n');
    expect(parseUsageOutput(text, NOW)).toEqual([
      { account: 'google-antigravity', pool: 'gemini', window: 'weekly', left: 89, used: 11, resetsAt: Date.parse('2026-10-23T21:59:46Z'), resetText: null, observedAt: NOW, source: 'cli usage', seat: null, margin: null, wall: false },
      { account: 'google-antigravity', pool: 'gemini', window: 'session', left: 94, used: 6, resetsAt: Date.parse('2026-10-23T21:59:46Z'), resetText: null, observedAt: NOW, source: 'cli usage', seat: null, margin: null, wall: false },
      { account: 'google-antigravity', pool: 'claude-gpt', window: 'weekly', left: 11, used: 89, resetsAt: Date.parse('2026-10-23T09:48:36Z'), resetText: null, observedAt: NOW, source: 'cli usage', seat: null, margin: null, wall: false },
      { account: 'google-antigravity', pool: 'claude-gpt', window: 'session', left: 100, used: 0, resetsAt: Date.parse('2026-10-23T09:48:36Z'), resetText: null, observedAt: NOW, source: 'cli usage', seat: null, margin: null, wall: false },
    ]);
  });

  test('bars counting down to one reset age from the freshest bar of their own account and window', () => {
    // A status row is frozen at its last render, and every bar of one account and window counts
    // to the same reset instant: the smallest countdown is the freshest reading, and the others
    // were read that much earlier — unless the bar carries no countdown, which ages nothing.
    const bar = (seat: string, account: string, window: 'session' | 'weekly', resetsAt: number | null) =>
      observed({ account, window, seat, used: 8, left: 92, resetsAt, observedAt: NOW });
    const bars = [
      bar('a', 'anthropic', 'session', NOW + 2 * HOUR),
      bar('b', 'anthropic', 'session', NOW + HOUR + 59 * 60_000),
      bar('c', 'anthropic', 'session', NOW + 3 * HOUR),
      bar('d', 'anthropic', 'weekly', NOW + 10 * DAY),
      bar('e', 'openai', 'session', null),
    ];
    const aged = ageByReset(bars, NOW);
    expect(aged.map((one) => one.observedAt)).toEqual([
      NOW - 60_000, // a: one minute behind the freshest session bar
      NOW, // b: the freshest of its group
      NOW - 61 * 60_000, // c: an hour and a minute behind
      NOW, // d: alone in its window, so its own freshest
      NOW, // e: no countdown to compare, untouched
    ]);
  });

  test('the observer reads only the caller’s own team, and one note per problem however many seats hit it', () => {
    const seat = (name: string, cli: string, account: string, pane?: string) => ({
      seat: name, cli, account, ...(pane === undefined ? {} : { pane }),
    });
    const team = (root: string, session: string | null, seats: ReturnType<typeof seat>[]): TeamEntry =>
      ({ kind: 'team', root, usage: { session, seatAccounts: seats } }) as unknown as TeamEntry;
    const machine = {
      teams: [
        team('/mine', 'mine-web', [seat('lead', 'claude-code', 'anthropic', 'p1'), seat('coda', 'claude-code', 'anthropic', 'p2')]),
        team('/other', 'other-web', [seat('scout', 'grok', 'xai', 'p3')]),
      ],
    } as unknown as MachineUsage;

    const reads: string[] = [];
    const restricted = observeQuota(machine, { full: false, mine: '/mine' }, {
      now: NOW,
      pane: (pane) => { reads.push(pane); return null; },
      usage: () => { throw new Error('no seat runs a CLI with a usage command'); },
    });
    // The other team's pane is never read, and the two unread panes are one counted note.
    expect(reads).toEqual(['p1', 'p2']);
    expect(restricted.observations).toEqual([]);
    expect(restricted.notes).toEqual([{ why: 'a seat pane could not be read', count: 2 }]);

    reads.length = 0;
    const full = observeQuota(machine, { full: true, mine: null }, {
      now: NOW,
      pane: (pane) => { reads.push(pane); return pane === 'p1' ? REAL_SCREEN : null; },
    });
    // The full view reads every team's pane, the caller's own included, once each.
    expect(reads).toEqual(['p1', 'p2', 'p3']);
    expect(full.observations).toHaveLength(2);
    expect(full.notes).toEqual([{ why: 'a seat pane could not be read', count: 2 }]);
  });

  test('a seat running a CLI with a usage command makes the observer ask it, once, and its silence is a note', () => {
    const agy = { seat: 'gem', cli: 'antigravity', account: 'google-antigravity', pane: null };
    const machine = {
      teams: [{ kind: 'team', root: '/mine', usage: { session: 'mine-web', seatAccounts: [agy] } }],
    } as unknown as MachineUsage;
    const calls: string[] = [];
    const answered = observeQuota(machine, { full: false, mine: '/mine' }, {
      now: NOW,
      usage: (cli) => { calls.push(cli); return 'Gemini Models\tWeekly Limit Remaining\t89%\t2026-10-23T21:59:46Z\n'; },
    });
    expect(calls).toEqual(['agy']);
    expect(answered.observations).toHaveLength(1);
    expect(answered.notes).toEqual([]);
    const silent = observeQuota(machine, { full: false, mine: '/mine' }, { now: NOW, usage: () => null });
    expect(silent.observations).toEqual([]);
    expect(silent.notes).toEqual([{ why: 'a CLI usage command did not answer', count: 1 }]);
  });

  test('the shipped observer asks the swapped usage call, and a seat with no pane costs no read', () => {
    const agy = { seat: 'gem', cli: 'agy', account: 'google-antigravity' };
    const machine = {
      teams: [{ kind: 'team', root: '/mine', usage: { session: 'mine-web', seatAccounts: [agy] } }],
    } as unknown as MachineUsage;
    setUsageExec(() => 'Claude and GPT models\tWeekly Limit Remaining\t11%\t2026-10-23T09:48:36Z\n');
    const live = realQuotaObservations(machine, { full: false, mine: '/mine' }, NOW);
    expect(live.observations).toHaveLength(1);
    expect(live.observations[0]).toMatchObject({ account: 'google-antigravity', pool: 'claude-gpt', source: 'cli usage' });
  });
});

describe('the command', () => {
  let base: string;
  let home: string;
  let root: string;
  const SEAT: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme-web' };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'team-quota-')));
    home = join(base, 'home');
    root = join(base, 'acme');
    mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
    mkdirSync(join(root, '.agents'), { recursive: true });
    const text = `format: 1
project: acme
session: acme-web
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
budgets:
  accounts:
    anthropic:
      kind: subscription
      reserve: 10%
    openai:
      kind: subscription
      reserve: 20%
seats:
  - role: orchestrator
    name: lead
    label: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
    writeFileSync(join(root, '.agents', 'team.yaml'), text);
    const checked = validateTeamFile(text, { home, root });
    if (!checked.ok) throw new Error(`the fixture does not validate: ${JSON.stringify(checked.errors)}`);
    writeApproval(storePath('acme', root, home), { approval: approvalOf(checked.team, root, new Date(NOW)), file: text }, [], home);
  });
  afterEach(() => {
    setUsageExec(null);
    rmSync(base, { recursive: true, force: true });
  });

  test('the observer’s figures render in both faces, under the caller’s own view', async () => {
    const views: string[] = [];
    const io = testIo(root, SEAT);
    const code = await runUsage(['--tree'], io, {
      home,
      now: () => new Date(NOW),
      observe: (machine, view) => {
        expect(machine.teams).toHaveLength(1);
        views.push(view.full ? 'full' : 'restricted');
        return {
          observations: [
            observed({ account: 'anthropic', window: 'weekly', used: 12, left: 88, resetsAt: NOW + 125 * HOUR + 26 * 60_000, seat: 'lead', margin: 13.3 }),
          ],
          notes: [{ why: 'a seat pane could not be read', count: 1 }],
        };
      },
    });
    expect(code).toBe(0);
    expect(views).toEqual(['restricted']);
    expect(io.out).toContain([
      'quota',
      '  anthropic  ok',
      '    anthropic  ok  seats: lead',
      '      weekly  used 12%  left 88%  resets in 125h26m  margin +13.3%  (status line, read 1m ago)',
      '  openai  unknown',
      '    openai  unknown',
      '      not known: no reading yet',
      'advice: headroom on anthropic (weekly used 12%, margin +13.3%)',
    ].join('\n'));
    expect(io.out).toContain('note: 1 seat pane could not be read\n');

    const json = testIo(root, SEAT);
    expect(await runUsage(['--json'], json, { home, now: () => new Date(NOW), observe: () => ({ observations: [], notes: [] }) })).toBe(0);
    const doc = JSON.parse(json.out) as { quota: Record<string, unknown> };
    expect(Object.keys(doc.quota)).toEqual(['format', 'accountsFile', 'labs', 'advice']);
    expect(doc.quota).toMatchObject({
      format: 1,
      accountsFile: '~/.config/team/accounts.yaml',
      advice: 'no readings yet: no seat status line and no CLI usage command has answered',
    });
  });

  test('the lab is the model the seat RUNS, never the CLI it runs it with', async () => {
    // The live machine's case (owner, 2026-10-17): a file whose orchestrator entry still says
    // zai/GLM while its pane says Opus, DeepSeek builders on the same claude-code CLI, and an
    // antigravity operator. The running model decides the lab; the launcher decides only what
    // pays. The last seat pins the other half: an explicit `account:` always wins the account,
    // while its lab still comes from the model it runs.
    const text = `format: 1
project: acme
session: acme-web
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
budgets:
  accounts:
    openai:
      kind: subscription
      reserve: 10%
seats:
  - role: orchestrator
    name: lead
    label: lead
    leads: true
    cli: claude-code
    vendor: zai
    model: GLM
    version: "5.3"
    launch: claude-glm.sh
  - role: member
    name: builder-a
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: member
    name: builder-b
    cli: claude-code
    vendor: deepseek
    model: DeepSeek
    version: "4.1"
    launch: claude-deepseek.sh
  - role: member
    name: operator-a
    cli: antigravity
    vendor: google
    model: Gemini
    version: "4"
    launch: agy --model gemini
  - role: member
    name: pinned
    cli: claude-code
    vendor: anthropic
    account: openai
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
    writeFileSync(join(root, '.agents', 'team.yaml'), text);
    const checked = validateTeamFile(text, { home, root });
    if (!checked.ok) throw new Error(`the fixture does not validate: ${JSON.stringify(checked.errors)}`);
    writeApproval(storePath('acme', root, home), { approval: approvalOf(checked.team, root, new Date(NOW)), file: text }, [], home);

    // What herdr's `agent list` says each seat runs (`display_agent`): the live machine's lines.
    const models = new Map([
      ['lead', 'Claude Opus 5.5 default'],
      ['builder-a', 'DeepSeek V4.1 Flash default'],
      ['builder-b', 'DeepSeek V4.1 Flash default'],
      ['operator-a', 'Gemini 4 Argon medium'],
      ['pinned', 'DeepSeek V4.1 Flash default'],
    ]);
    const runningSeat = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme-web' } as const;
    const io = testIo(root, runningSeat);
    expect(await runUsage(['--tree'], io, { home, now: () => new Date(NOW), running: (session) => (session === 'acme-web' ? models : null) })).toBe(0);
    // Every seat under the lab of the model it runs: the DeepSeek builders only under deepseek,
    // never under anthropic; the file's stale zai vendor names nothing at all.
    expect(io.out).toContain('    anthropic  unknown  seats: lead\n');
    expect(io.out).toContain('    deepseek  unknown  seats: builder-a, builder-b, pinned\n');
    expect(io.out).toContain('    google  unknown  seats: operator-a\n');
    expect(io.out).not.toContain('zai');
    // The account is what pays: the pinned seat's explicit account stands, whatever it runs.
    const json = testIo(root, runningSeat);
    expect(await runUsage(['--json'], json, { home, now: () => new Date(NOW), running: () => models })).toBe(0);
    const doc = JSON.parse(json.out) as { teams: { seats: { seat: string; cli: string; account: string; pool?: string }[] }[] };
    expect(doc.teams[0]?.seats).toEqual([
      { seat: 'lead', cli: 'claude-code', account: 'anthropic' },
      { seat: 'builder-a', cli: 'claude-code', account: 'deepseek' },
      { seat: 'builder-b', cli: 'claude-code', account: 'deepseek' },
      { seat: 'operator-a', cli: 'antigravity', account: 'google-antigravity', pool: 'gemini' },
      { seat: 'pinned', cli: 'claude-code', account: 'openai' },
    ]);

    // No running source at all (a test's own run, or herdr unreachable): the file decides, and
    // the same machine shows the defect the fix exists for — builder-a under anthropic, and the
    // stale zai lab named by the orchestrator's launcher.
    const idle = testIo(root, runningSeat);
    expect(await runUsage(['--tree'], idle, { home, now: () => new Date(NOW) })).toBe(0);
    expect(idle.out).toContain('    anthropic  unknown  seats: builder-a, pinned\n');
    expect(idle.out).toContain('    zai  unknown  seats: lead\n');
  });

  test('a stored reading under an account no reader measures is not that account’s figure', async () => {
    // The defect (owner, 2026-10-17): every running seat's status bar was stored under the
    // account that PAID for the seat, so a DeepSeek seat on Claude Code left a `deepseek session
    // 9%` reading that was the Claude subscription's own figure shown twice. A machine reading
    // is shown only under an account a shipped screen or usage print measures — here anthropic's
    // own bar is shown, and the deepseek row reads `not known`.
    const text = `format: 1
project: acme
session: acme-web
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
budgets:
  accounts:
    anthropic:
      kind: subscription
      reserve: 10%
seats:
  - role: orchestrator
    name: lead
    label: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: member
    name: builder
    cli: claude-code
    vendor: deepseek
    model: DeepSeek
    version: "4.1"
    launch: claude-deepseek.sh
`;
    writeFileSync(join(root, '.agents', 'team.yaml'), text);
    const checked = validateTeamFile(text, { home, root });
    if (!checked.ok) throw new Error(`the fixture does not validate: ${JSON.stringify(checked.errors)}`);
    writeApproval(storePath('acme', root, home), { approval: approvalOf(checked.team, root, new Date(NOW)), file: text }, [], home);
    saveMachineReadings(home, [
      { account: 'anthropic', window: 'session', left: 64, used: 36, resets: null },
      { account: 'deepseek', window: 'session', left: 91, used: 9, resets: null },
    ], NOW);

    const io = testIo(root, { kind: 'owner' });
    expect(await runUsage(['--tree'], io, { home, now: () => new Date(NOW) })).toBe(0);
    expect(io.out).toContain('anthropic  session  64%   36%');
    expect(io.out).toContain('  deepseek  unknown\n');
    expect(io.out).toContain('    deepseek  unknown  seats: builder\n');
    expect(io.out).not.toMatch(/^deepseek\s+session/m);
    const json = testIo(root, { kind: 'owner' });
    expect(await runUsage(['--json'], json, { home, now: () => new Date(NOW) })).toBe(0);
    const doc = JSON.parse(json.out) as { labs: { lab: string; accounts: { account: string; machine: { state: string; window: string | null } }[] }[] };
    const entry = doc.labs.flatMap((lab) => lab.accounts).find((one) => one.account === 'deepseek');
    expect(entry?.machine).toMatchObject({ state: 'unknown', window: null });
  });

  test('a live read of an undeclared account lands under its own lab; a machine-wide one only where the caller pays', async () => {
    // Zero-config: the file declares anthropic and openai, and a live seat's own screen names
    // `zai` — an account no file names. It lands under its own lab, with its seats and figures,
    // and the closing counts grow by the lab and the account it made.
    const read = observed({ account: 'zai', window: 'weekly', used: 12, left: 88, resetsAt: NOW + 125 * HOUR + 26 * 60_000, seat: 'lead' });
    const seat = testIo(root, SEAT);
    expect(await runUsage(['--tree'], seat, { home, now: () => new Date(NOW), observe: () => ({ observations: [read], notes: [] }) })).toBe(0);
    expect(seat.out).toMatch(/^zai\s+weekly\s+88%\s+12%\s+in 125h26m/m);
    // The account is the figure's own, but the seat stands under what PAYS for it: this seat's
    // file and launcher name Anthropic, and its screen's account names only the subscription
    // whose bar the screen printed — so no seat of this view lists under zai.
    expect(seat.out).toContain([
      '  zai  ok',
      '    zai  ok',
      '      weekly  used 12%  left 88%  resets in 125h26m  margin +13.3%  (status line, read 1m ago)',
    ].join('\n'));
    expect(seat.out).toContain('advice: headroom on zai (weekly used 12%, margin +13.3%)\n');
    expect(seat.out).toContain('usage on this machine, 1 team, 3 labs, 3 accounts\n');
    const json = testIo(root, SEAT);
    expect(await runUsage(['--json'], json, { home, now: () => new Date(NOW), observe: () => ({ observations: [read], notes: [] }) })).toBe(0);
    const doc = JSON.parse(json.out) as { counts: Record<string, number>; labs: { lab: string; accounts: unknown[] }[] };
    expect(doc.counts).toEqual({ teams: 1, labs: 3, accounts: 3 });
    expect(doc.labs.map((one) => one.lab)).toEqual(['anthropic', 'openai', 'zai']);
    expect(doc.labs.find((one) => one.lab === 'zai')?.accounts).toMatchObject([
      { account: 'zai', kind: 'subscription', machine: { window: 'weekly', left: 88, used: 12, source: 'status_line' } },
    ]);

    // The same figure as a machine-wide reading (a CLI usage print names no seat) is another
    // team's material under the restricted view: the caller pays no `zai` account, so it is no
    // reading of theirs and names nothing — the full view, whose own read it is, reads it.
    const wide = { ...read, seat: null };
    const hidden = testIo(root, SEAT);
    expect(await runUsage([], hidden, { home, now: () => new Date(NOW), observe: () => ({ observations: [wide], notes: [] }) })).toBe(0);
    expect(hidden.out).not.toContain('zai');
    expect(hidden.out).toContain('usage on this machine, 1 team, 2 labs, 2 accounts\n');
    const owner = testIo(root, { kind: 'owner' });
    expect(await runUsage([], owner, { home, now: () => new Date(NOW), observe: () => ({ observations: [wide], notes: [] }) })).toBe(0);
    expect(owner.out).toMatch(/^zai\s+weekly\s+88%/m);
    expect(owner.out).toContain('usage on this machine, 1 team, 3 labs, 3 accounts\n');
  });
});
