// The budgets table `status` prints. One row per account and window.
import type { TeamFile } from '../file/types.ts';
import type { WindowName } from '../profiles/quota.ts';
import { checkOf, countedFor, screenOf, type ReadingSource, type Seen } from './readings.ts';

export type BudgetState = 'fresh' | 'unconfirmed' | 'stale' | 'refusing' | 'unknown';

export type BudgetRow = {
  account: string;
  window: WindowName | null;
  left: number | null;
  used: number | null;
  resetsIn: string | null;
  seat: string | null;
  age: string | null;
  source: ReadingSource | null;
  /** True when the counted figure did not come from the first source the account names (§ 3). */
  fallback: boolean;
  state: BudgetState;
  /** True when a subscription's left figure is at or inside its reserve. */
  inside: boolean;
  /** The reserve the row was read against, or null: the line and the JSON can't disagree. */
  reserve: number | null;
};

/** The windows this tool writes, in the order a row's windows sort. Exported so a reader that
 *  binds a stored reading against the tool's own vocabulary asks the same list. */
export const WINDOWS: WindowName[] = ['session', 'daily', 'weekly'];

/** Rows for the accounts the budgets in force name, and for any reading still in the state. */
export function budgetTable(budgets: TeamFile['budgets'], list: readonly Seen[], now: number): BudgetRow[] {
  const staleAfterMs = budgets.staleAfter * 1000;
  const groups = new Map<string, Seen[]>();
  for (const reading of list) {
    const key = `${reading.account}\0${reading.window}`;
    const group = groups.get(key) ?? [];
    group.push(reading);
    groups.set(key, group);
  }
  const rows: BudgetRow[] = [];
  const named = new Set<string>();
  for (const [key, group] of groups) {
    const account = key.slice(0, key.indexOf('\0'));
    const window = group[0]?.window ?? null;
    named.add(account);
    const reserve = reserveOf(budgets, account);
    // The window's reading from the sources the account names, in order (§ 3, § 5).
    const sources = sourcesOf(budgets, account);
    const result = countedFor(sources, screenOf(group), checkOf(group), now, staleAfterMs, reserve);
    rows.push(result.kind === 'unknown'
      ? { ...blank(account, reserve), window }
      : budgetRowOf(result, now, staleAfterMs, reserve, result.reading.source !== sources[0]));
  }
  for (const account of Object.keys(budgets.accounts)) {
    if (!named.has(account)) rows.push(blank(account, reserveOf(budgets, account)));
  }
  return rows.sort(byAccount);
}

/** An account's reserve: a subscription's own, and none for anything else. */
export function reserveOf(budgets: TeamFile['budgets'], account: string): number | null {
  const entry = budgets.accounts[account];
  return entry?.kind === 'subscription' ? entry.reserve : null;
}

export function budgetLine(row: BudgetRow): string {
  if (row.state === 'unknown' || row.left === null || row.used === null) {
    return [row.account, row.window, 'unknown'].filter((part) => part).join('  ');
  }
  const reset = row.resetsIn === null ? 'resets unknown' : `resets in ${row.resetsIn}`;
  const from = row.source === 'status_line' ? 'status line' : row.source === 'check' ? 'check' : 'unknown source';
  const source = row.fallback ? `${from} (fallback)` : from;
  const state = row.inside && row.reserve !== null ? `${row.state}, inside reserve ${row.reserve}%` : row.state;
  return `${row.account}  ${row.window}  left ${row.left}%  used ${row.used}%  ${reset}  ${row.seat ?? '-'}  ${whenWord(row)} ${row.age} ago  ${source}  ${state}`;
}

/** The word a figure's moment takes in a line: a stale row with no known reset is the room last
 *  seen, not a reading aged out. Exported so the machine view's own line for a seat's row writes
 *  the same word this line does, and the two can never disagree. The source is any word: a machine
 *  row the machine view synthesizes from a live reading names its own source, and takes this
 *  line's default word, which is what every source but a check's already reads. */
export function whenWord(row: Pick<BudgetRow, 'state' | 'resetsIn'> & { source: string | null }): 'last seen' | 'read' | 'changed' {
  return row.state === 'stale' && row.resetsIn === null ? 'last seen' : row.source === 'check' ? 'read' : 'changed';
}

/** The sources the account's figures are read from, in order: a status line when the file is
 *  silent. Exported so a reader that pairs a row with the reading behind it asks the same rule. */
export function sourcesOf(budgets: TeamFile['budgets'], account: string): readonly ReadingSource[] {
  return budgets.accounts[account]?.sources ?? ['status_line'];
}

/** The row for one counted group. Exported as `budgetRowOf` so a machine-scope reader that reads
 *  a team's stored readings itself (`machineUsage`) builds the row through the same one rule
 *  `budgetTable` uses, and the two can never disagree. */
export function budgetRowOf(
  result: { kind: 'counted' | 'unconfirmed'; reading: Seen },
  now: number,
  staleAfterMs: number,
  reserve: number | null,
  fallback: boolean,
): BudgetRow {
  const reading = result.reading;
  const inside = reserve !== null && reading.left <= reserve;
  const state: BudgetState = result.kind === 'unconfirmed'
    ? 'unconfirmed'
    : now - reading.changedAt < staleAfterMs
      ? 'fresh'
      : inside && reading.resetsAt !== null ? 'refusing' : 'stale';
  return {
    account: reading.account,
    window: reading.window,
    left: reading.left,
    used: reading.used,
    resetsIn: reading.resetsAt === null ? null : span(reading.resetsAt - now),
    seat: reading.seat,
    age: span(now - reading.changedAt),
    source: reading.source,
    fallback,
    state,
    inside,
    reserve,
  };
}

function blank(account: string, reserve: number | null): BudgetRow {
  return {
    account,
    window: null,
    left: null,
    used: null,
    resetsIn: null,
    seat: null,
    age: null,
    source: null,
    fallback: false,
    state: 'unknown',
    inside: false,
    reserve,
  };
}

function byAccount(a: BudgetRow, b: BudgetRow): number {
  if (a.account !== b.account) return a.account < b.account ? -1 : 1;
  const rank = (window: WindowName | null) => (window === null ? WINDOWS.length : WINDOWS.indexOf(window));
  return rank(a.window) - rank(b.window);
}

/** An age in the one form every line writes it: minutes, or hours and minutes. Exported so the
 *  machine view's spend line writes an age the same way the budget lines do. */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `${hours}h${rest}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}
