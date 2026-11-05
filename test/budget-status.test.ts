import { describe, expect, test } from 'bun:test';
import { budgetLine, budgetTable } from '../src/budgets/table.ts';
import type { Seen } from '../src/budgets/readings.ts';
import type { TeamFile } from '../src/file/types.ts';
import { withWas } from './helpers.ts';

const minute = 60 * 1000;
const now = 1_700_000_000_000;

function team(reserve: number | null): TeamFile {
  return {
    budgets: {
      staleAfter: 30 * 60,
      checkEvery: 600,
      marks: [50, 75, 90],
      accounts: {
        openai: { kind: 'subscription', shared: false, reserve, floor: null, sources: ['status_line'], check: null },
      },
    },
  } as unknown as TeamFile;
}

function reading(over: Partial<Seen> = {}): Seen {
  return {
    account: 'openai',
    window: 'weekly',
    left: 40,
    used: 60,
    changedAt: now - minute,
    resetsAt: now + 44 * minute,
    seat: 'one',
    source: 'status_line',
    confirmed: true,
    ...over,
  };
}

describe('the budgets table', () => {
  test('a fresh reading names what is left, when it resets, and how old it is', () => {
    const [row] = budgetTable(team(10).budgets, [reading()], now);
    expect(row?.state).toBe('fresh');
    expect(row?.inside).toBe(false);
    expect(row?.reserve).toBe(10);
    expect(budgetLine(row!)).toBe('openai  weekly  left 40%  used 60%  resets in 44m  one  changed 1m ago  status line  fresh');
  });

  test('a fresh reading inside the reserve says so, and stays fresh', () => {
    const row = budgetTable(team(10).budgets, [reading({ left: 5, used: 95 })], now)[0];
    expect(row?.state).toBe('fresh');
    expect(row?.inside).toBe(true);
    expect(budgetLine(row!)).toContain('fresh, inside reserve 10%');
  });

  // The row carries the reserve, so the line `status` prints and the `budgets` JSON are the
  // same figure, and a row read against no reserve says so (queue 79).
  test('a row with no reserve carries none, and an unknown row carries its account\'s', () => {
    expect(budgetTable(team(null).budgets, [reading({ left: 5, used: 95 })], now)[0]?.reserve).toBeNull();
    expect(budgetTable(team(null).budgets, [reading({ left: 5, used: 95 })], now)[0]?.inside).toBe(false);
    expect(budgetLine(budgetTable(team(10).budgets, [], now)[0]!)).toBe('openai  unknown');
    expect(budgetTable(team(10).budgets, [], now)[0]?.reserve).toBe(10);
  });

  test('a stale reading inside the reserve is refusing, and one with no reset is unknown or last seen', () => {
    const stale = reading({ changedAt: now - 30 * minute, left: 5, used: 95 });
    expect(budgetTable(team(10).budgets, [stale], now)[0]?.state).toBe('refusing');
    // No reset to wait on: inside the reserve, and at twice it, the row is unknown — never a
    // refusal, and never a clearance.
    const at = { changedAt: now - 30 * minute, resetsAt: null };
    expect(budgetTable(team(10).budgets, [reading({ ...at, left: 5, used: 95 })], now)[0]?.state).toBe('unknown');
    expect(budgetTable(team(10).budgets, [reading({ ...at, left: 20, used: 80 })], now)[0]?.state).toBe('unknown');
    // Well outside — more than the reserve again — the room last seen is still shown.
    const lastSeen = budgetTable(team(10).budgets, [reading({ ...at, left: 70, used: 30 })], now)[0];
    expect(lastSeen?.state).toBe('stale');
    expect(budgetLine(lastSeen!)).toBe('openai  weekly  left 70%  used 30%  resets not printed  one  last seen 30m ago  status line  stale');
  });

  test('a named account with no reading is its own unknown row', () => {
    expect(budgetLine(budgetTable(team(10).budgets, [], now)[0]!)).toBe('openai  unknown');
  });

  // The fallback is per window, not per account: a check that filled one window does not hide
  // the status line's figure for the window it never reported.
  const checkFirst = {
    staleAfter: 30 * 60,
    checkEvery: 600,
    marks: [50, 75, 90],
    accounts: {
      openai: { kind: 'subscription', shared: false, reserve: 20, floor: null, sources: ['check', 'status_line'], check: 'openai-usage' },
    },
  } as unknown as TeamFile['budgets'];

  test('the status line fills the window the check did not report', () => {
    const rows = budgetTable(checkFirst, [
      reading({ window: 'session', seat: null, source: 'check' }),
      reading({ window: 'weekly', left: 5, used: 95 }),
    ], now);
    expect(rows.map((row) => budgetLine(row))).toEqual([
      'openai  session  left 40%  used 60%  resets in 44m  -  read 1m ago  check  fresh',
      'openai  weekly  left 5%  used 95%  resets in 44m  one  changed 1m ago  status line (fallback)  fresh, inside reserve 20%',
    ]);
  });

  // § 3: the counted figure is a fallback when it did not come from the source the account
  // names first. The row says so beside the source it did come from, and the JSON carries it.
  test('a figure from below the first source is marked a fallback', () => {
    const rows = budgetTable(checkFirst, [
      reading({ window: 'session', seat: null, source: 'check' }),
      reading({ window: 'weekly', left: 5, used: 95 }),
    ], now);
    expect(rows.map((row) => ({ source: row.source, fallback: row.fallback }))).toEqual([
      { source: 'check', fallback: false },
      { source: 'status_line', fallback: true },
    ]);
  });

  test('a point on the reading moves no row and no line', () => {
    // § 5: the stored point is a passenger. Every row this file pins — its state, its inside, its
    // reserve, its fallback and its line — is the same row whether the reading carries a point or
    // does not; the table never reads the point.
    const shapes = [
      reading(),
      reading({ left: 5, used: 95 }),
      reading({ left: 100, used: 0 }),
      reading({ changedAt: now - 30 * minute, left: 5, used: 95 }),
      reading({ changedAt: now - 30 * minute, resetsAt: null, left: 5, used: 95 }),
      reading({ changedAt: now - 30 * minute, resetsAt: null, left: 70, used: 30 }),
    ];
    for (const seen of shapes) {
      const plain = budgetTable(team(10).budgets, [seen], now);
      const pointed = budgetTable(team(10).budgets, [withWas(seen)], now);
      expect(pointed).toEqual(plain);
      expect(pointed.map((row) => budgetLine(row))).toEqual(plain.map((row) => budgetLine(row)));
    }
    const pair = [reading({ window: 'session', seat: null, source: 'check' }), reading({ window: 'weekly', left: 5, used: 95 })];
    expect(budgetTable(checkFirst, pair.map(withWas), now)).toEqual(budgetTable(checkFirst, pair, now));
    // Non-vacuity: the point is on the reading the table just read, and distinct from the figure.
    expect(withWas(reading()).was).toEqual({ left: 47, at: now - 31 * minute });
    expect(withWas(reading({ left: 100 })).was).toEqual({ left: 93, at: now - 31 * minute });
  });

  test('the mark follows the account\'s own order, not the kind of source', () => {
    const statusLineFirst = {
      ...checkFirst,
      accounts: { openai: { ...checkFirst.accounts.openai, sources: ['status_line', 'check'] } },
    } as TeamFile['budgets'];
    const fromCheck = budgetTable(statusLineFirst, [reading({ window: 'session', seat: null, source: 'check' })], now)[0];
    expect(fromCheck?.source).toBe('check');
    expect(fromCheck?.fallback).toBe(true);
    expect(budgetTable(statusLineFirst, [reading()], now)[0]?.fallback).toBe(false);
  });
});
