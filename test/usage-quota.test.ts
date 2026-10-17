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
    const code = await runUsage([], io, {
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
});
