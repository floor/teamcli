// The quota view: per lab and per account, the figures a seat's own status line (or a CLI's own
// usage command, or a quota screen) shows — the window's used and left percentages, when it
// resets, how far the spend runs ahead of or behind the window's own clock (the margin), which
// seats draw on the account, one state word, and one advice line. Everything here is a fact the
// caller observed; nothing is fetched or inferred beyond the margin, and that inference is stated.
//
// The margin is the owner's own rule, read off a real status line: `W: 12% (+13.3%) (125h26m)`
// (test/status.test.ts:1205). A weekly window is seven days, so 125h26m to reset leaves 42h34m
// gone of 168h — 25.3% of the window — and 25.3 − 12 = +13.3, the figure the line itself printed.
// A line that prints its margin is believed as printed; one that does not is read the same way,
// against the window's length. The session window is five hours, the length the sibling CLI's own
// usage report names (`Five Hour Limit`).
import { span, WINDOW_MS } from '../budgets/table.ts';

export const QUOTA_WINDOWS = ['session', 'weekly'] as const;
export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];

/** The window lengths the margin is read against. A status line's own margin wins when printed.
 *  One source with the budget table's own lengths (`table.ts:WINDOW_MS`), so the two never drift. */
export const QUOTA_WINDOW_MS: Record<QuotaWindow, number> = {
  session: WINDOW_MS.session,
  weekly: WINDOW_MS.weekly,
};

/** A figure older than this describes a window that may have moved on, like a machine reading. */
export const QUOTA_STALE_MS = 5 * 60 * 1000;

/** The accounts a shipped CLI's own usage command answers for, though no status pattern names
 *  them: `agy --print /usage` prints the Antigravity subscription's two pools, so a figure for
 *  `google-antigravity` is one a reader on this machine really makes. A stored reading of an
 *  account outside this set and every status pattern's own is no reading of anything. */
export const USAGE_ACCOUNTS = ['google-antigravity'] as const;

/** Where a quota figure was observed: a seat's status line, a CLI's own usage command, a quota
 *  screen (a wall), or the watch's machine-wide reading store. */
export type QuotaSource = 'status line' | 'cli usage' | 'machine reading' | 'quota screen';

/** The two live-source problems the report collapses to one counted note each. The words are the
 *  tool's own, never a read's message. */
export const PANE_UNREAD = 'a seat pane could not be read';
export const USAGE_UNANSWERED = 'a CLI usage command did not answer';

/** One figure as a source observed it. `window` is null for a wall, which names no window; `wall`
 *  observations carry no percentage — the account is out, and the reset word is what the screen
 *  said. `margin` is the status line's own printed figure, one decimal and signed, when it prints
 *  one (Claude Code's `(+13.3%)`); it is null when the line leaves the margin to be computed. */
export type QuotaObservation = {
  account: string;
  pool?: 'gemini' | 'claude-gpt';
  window: QuotaWindow | null;
  left: number | null;
  used: number | null;
  resetsAt: number | null;
  /** The reset words a wall screen printed when they cannot be read as a moment (`at 3pm`). */
  resetText: string | null;
  observedAt: number;
  source: QuotaSource;
  seat: string | null;
  /** The herdr session the seat's pane was read in; null for a CLI usage print, which belongs
   *  to no seat. It keeps two teams' same-named seats apart when a report attributes figures
   *  back to the seat that showed them. */
  session?: string | null;
  margin: number | null;
  wall: boolean;
};

/** One seat's spend in money, as the seat's own screen printed it. A money figure belongs to
 *  the pane that printed it, so `seat` is never null; `session` is stamped by the observer with
 *  the herdr session the pane was read in, as a quota observation's is. A screen that prints no
 *  amount gives no observation — the report shows `unknown`, never an invented zero. */
export type CostObservation = {
  seat: string;
  account: string;
  session?: string | null;
  amount: number;
  currency: 'USD';
  observedAt: number;
  source: 'status line';
};

/** A lab's or an account's state: plenty, close to the cap, out, or nothing fresh to say. */
export type QuotaState = 'ok' | 'near cap' | 'walled' | 'unknown';

/** The used percentage at or above which an account whose window offers no margin to read (its
 *  reset moment is unknown) reads `near cap`: the fallback figure. When a margin exists the pace
 *  decides, never the used figure alone — a window at 96% used and on pace is not near its cap. */
export const NEAR_CAP = 90;
/** The margin at or above which an account counts as having headroom, in points. Its mirror is
 *  the band a window reads `near cap` from: at `-HEADROOM` or below the spend has run ahead of
 *  the window's own clock by more than the headroom the advice looks for, so at that pace the
 *  window is empty before it resets — whatever its used percentage says today. */
export const HEADROOM = 10;

export type ReportQuotaWindow = {
  window: QuotaWindow;
  used: number | null;
  left: number | null;
  /** ISO, when the reset moment is known. */
  resetsAt: string | null;
  /** The reset as a countdown, or the words a wall screen printed. */
  resetsIn: string | null;
  /** Expected minus used, one decimal, signed, when the window's clock allows one. */
  margin: number | null;
  /** The hours left before the window is empty at the pace its own clock reads, when the spend
   *  runs ahead of that clock by `HEADROOM` or more: the figure the `runs out in about Xh, before
   *  the reset in Yh` sentence carries. Null when the margin does not name a run-out. */
  runsOutIn: string | null;
  source: QuotaSource;
  seat: string | null;
  age: string;
  /** The reading is older than five minutes or names a reset that has passed. */
  stale: boolean;
  /** The reading is older than its own window: it describes a passed window instance, so the
   *  figure is not shown (`used`/`left`/`resetsIn`/`margin` are null) and the line says so. */
  expired: boolean;
  wall: boolean;
};

export type ReportQuotaAccount = {
  account: string;
  pool?: 'gemini' | 'claude-gpt';
  state: QuotaState;
  windows: ReportQuotaWindow[];
  /** The seats this view may name on the account, in report order. */
  seats: string[];
  /** Seats on the account this view may not name (the restricted view's other teams), counted. */
  seatsOther?: number;
  /** A wall screen's reset words, when the wall has no readable figure to carry them. */
  wallResets: string | null;
};

export type ReportQuotaLab = { lab: string; state: QuotaState; accounts: ReportQuotaAccount[] };

/** The quota block both renderers print. `accountsFile` is the file a lab with no account
 *  declaration points at, so the one line the owner asked for is actionable. */
export type ReportQuota = {
  format: 1;
  accountsFile: string;
  labs: ReportQuotaLab[];
  advice: string;
};

/** One account the report may show, already joined with the seats this view may name on it. */
export type QuotaAccountInput = {
  account: string;
  pool?: 'gemini' | 'claude-gpt';
  seats: string[];
  seatsOther?: number;
};
export type QuotaLabInput = { lab: string; accounts: QuotaAccountInput[] };

export type QuotaOptions = {
  labs: readonly QuotaLabInput[];
  observations: readonly QuotaObservation[];
  accountsFile: string;
  now: number;
  /** Windows the report already knows are past their own window (`account (window)`), read from
   *  the budget rows: the advice names them even when no observation reached this block. */
  expired?: readonly string[];
};

function keyOf(one: { account: string; pool?: 'gemini' | 'claude-gpt' }): string {
  return `${one.account}\0${one.pool ?? ''}`;
}

function named(one: { account: string; pool?: 'gemini' | 'claude-gpt' }, lab?: string): string {
  const account = one.pool ? `${one.account} (${one.pool})` : one.account;
  return lab === undefined || lab === one.account || lab === account ? account : `${lab}/${account}`;
}

/** The margin the window's own clock allows: the share of the window already gone, minus the
 *  share spent. Positive means the account is spending slower than time, negative faster. Null
 *  when the reset moment is unknown, and on a stale reading — a window that has reset has no
 *  clock to compare against. */
export function marginOf(one: { used: number | null; window: QuotaWindow | null; resetsAt: number | null; margin: number | null }, now: number): number | null {
  if (one.window === null) return null;
  if (one.margin !== null) return round1(one.margin);
  if (one.used === null || one.resetsAt === null) return null;
  if (one.resetsAt <= now) return null;
  const length = QUOTA_WINDOW_MS[one.window];
  const gone = Math.min(length, Math.max(0, length - (one.resetsAt - now)));
  return round1((gone / length) * 100 - one.used);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function isStale(one: { observedAt: number; resetsAt: number | null }, now: number): boolean {
  return now - one.observedAt > QUOTA_STALE_MS || (one.resetsAt !== null && one.resetsAt <= now);
}

/** The hours left before a window is empty at the pace its own clock reads: the left figure over
 *  the share spent per hour of window time gone. Null when the reading lacks a figure or a reset
 *  moment the clock can use. */
function hoursToEmpty(one: QuotaObservation, length: number, now: number): string | null {
  if (one.used === null || one.left === null || one.resetsAt === null) return null;
  const elapsed = length - (one.resetsAt - now);
  if (elapsed <= 0) return span(0);
  const pace = one.used / (elapsed / 3_600_000);
  if (pace <= 0) return null;
  return span((one.left / pace) * 3_600_000);
}

/** The windows a set of observations gives one account: the newest observation per window, in
 *  the quota block's own order. A window only the stale set has still prints, marked stale. */
function windowsOf(list: readonly QuotaObservation[], now: number): ReportQuotaWindow[] {
  const newest = new Map<QuotaWindow, QuotaObservation>();
  for (const one of list) {
    if (one.wall || one.window === null) continue;
    const known = newest.get(one.window);
    if (known === undefined || one.observedAt > known.observedAt) newest.set(one.window, one);
  }
  return QUOTA_WINDOWS.filter((window) => newest.has(window)).map((window) => {
    const one = newest.get(window) as QuotaObservation;
    const stale = isStale(one, now);
    // Older than the window itself: the window has reset since, so the figure and its reset
    // belong to a passed instance. The age and source still say what was read and when.
    const expired = now - one.observedAt >= WINDOW_MS[window];
    const margin = expired || stale ? null : marginOf(one, now);
    return {
      window,
      used: expired ? null : one.used,
      left: expired ? null : one.left,
      resetsAt: expired || one.resetsAt === null ? null : new Date(one.resetsAt).toISOString(),
      resetsIn: expired ? null : one.resetsAt === null ? one.resetText : span(one.resetsAt - now),
      margin,
      // The spend runs ahead of the clock by the headroom band: at that pace the window is empty
      // before it resets, so the line says when. Only a margin names the run-out; a window whose
      // reset moment is unknown has no clock to read either hours from.
      runsOutIn: margin === null || margin > -HEADROOM ? null : hoursToEmpty(one, QUOTA_WINDOW_MS[window], now),
      source: one.source,
      seat: one.seat,
      age: span(now - one.observedAt),
      stale,
      expired,
      wall: false,
    };
  });
}

/** The account's state from the newest fresh figures and any live wall: a wall (or a figure at
 *  100) is walled; near the cap is a fresh margin at `-HEADROOM` or below — the spend runs ahead
 *  of the window's own clock by more than the headroom the advice looks for, so at that pace the
 *  window is empty before it resets. The used percentage alone decides nothing when a margin
 *  exists (96% on pace is ok); a window whose clock gives no margin falls back to `NEAR_CAP`.
 *  Anything else is ok. Nothing fresh is unknown — a stale percentage describes a window that may
 *  have reset, and is never grounds for advice. */
function stateOf(windows: readonly ReportQuotaWindow[], walled: boolean): QuotaState {
  if (walled) return 'walled';
  const fresh = windows.filter((one) => !one.stale && one.used !== null);
  if (fresh.length === 0) return 'unknown';
  const used = Math.max(...fresh.map((one) => one.used as number));
  if (used >= 100) return 'walled';
  if (fresh.some(nearCap)) return 'near cap';
  return 'ok';
}

/** Whether one fresh window reads near its cap: the margin's pace decides when the window's
 *  clock gives one — at `-HEADROOM` or below the window is empty before it resets — and a window
 *  with no clock to read falls back to its used figure at `NEAR_CAP`. */
function nearCap(one: ReportQuotaWindow): boolean {
  return one.margin === null ? (one.used as number) >= NEAR_CAP : one.margin <= -HEADROOM;
}

/** One window's state, the account rule on that window alone: a wall is a wall, nothing fresh is
 *  unknown, a window empty of figure is walled, a margin at `-HEADROOM` or below is near cap, and
 *  a window with no margin falls back to its used figure at `NEAR_CAP`. The table's STATE cell
 *  reads this, so a row and the quota block's account can never disagree about a figure they
 *  show. */
export function windowState(one: ReportQuotaWindow): QuotaState {
  if (one.wall) return 'walled';
  if (one.stale || one.used === null) return 'unknown';
  if (one.used >= 100) return 'walled';
  return nearCap(one) ? 'near cap' : 'ok';
}

const ORDER: QuotaState[] = ['walled', 'near cap', 'ok', 'unknown'];

function worst(states: readonly QuotaState[]): QuotaState {
  for (const state of ORDER) if (states.includes(state)) return state;
  return 'unknown';
}

/**
 * The quota block: every visible lab and account with the figures observed for it, its state,
 * the seats the view may name, and one advice line. Observations for an account this view does
 * not show never reach this call — the filter builds the labs — so a restricted caller cannot
 * read another team's wall through an aggregate.
 */
export function quotaOf(options: QuotaOptions): ReportQuota {
  const { labs, observations, accountsFile, now } = options;
  const walls = new Map<string, QuotaObservation>();
  const byAccount = new Map<string, QuotaObservation[]>();
  for (const one of observations) {
    if (one.account === '') continue;
    const key = keyOf(one);
    if (one.wall) {
      // A wall whose reset has passed describes a window that already rolled over.
      if (one.resetsAt !== null && one.resetsAt <= now) continue;
      const known = walls.get(key);
      if (known === undefined || one.observedAt > known.observedAt) walls.set(key, one);
      continue;
    }
    const list = byAccount.get(key) ?? [];
    list.push(one);
    byAccount.set(key, list);
  }

  const built: ReportQuotaLab[] = labs.map((lab) => {
    const accounts: ReportQuotaAccount[] = lab.accounts.map((input) => {
      const key = keyOf(input);
      const wall = walls.get(key) ?? null;
      const windows = windowsOf(byAccount.get(key) ?? [], now);
      return {
        account: input.account,
        ...(input.pool ? { pool: input.pool } : {}),
        state: stateOf(windows, wall !== null),
        windows,
        seats: [...input.seats],
        ...(input.seatsOther !== undefined ? { seatsOther: input.seatsOther } : {}),
        wallResets: wall === null ? null : wall.resetText ?? (wall.resetsAt === null ? null : span(wall.resetsAt - now)),
      };
    });
    return { lab: lab.lab, state: worst(accounts.map((one) => one.state)), accounts };
  });

  // The windows whose reading is older than its own window, by the two paths that know one: the
  // budget rows the report carries (`options.expired`, named by `reportOf`) and this block's own
  // observations. One label per window, the block's spelling.
  const expired = [...new Set([
    ...(options.expired ?? []),
    ...built.flatMap((lab) => lab.accounts.flatMap((account) =>
      account.windows.filter((one) => one.expired).map((one) => expiredLabel(account, lab.lab, one.window)))),
  ])];
  return { format: 1, accountsFile, labs: built, advice: adviceOf(built, expired) };
}

/** One expired window's label for the advice line: the block's own spelling of an account under
 *  its lab (`named`), with the window. Exported so the report names a budget row's expired window
 *  exactly as the block names its own, and one window never reads as two. */
export function expiredLabel(one: { account: string; pool?: 'gemini' | 'claude-gpt' }, lab: string, window: string): string {
  return `${named(one, lab)} (${window})`;
}

/** Every account the advice may speak about, with the lab it sits under. */
function accountsOf(labs: readonly ReportQuotaLab[]): Array<{ lab: string; account: ReportQuotaAccount; margin: number | null }> {
  return labs.flatMap((lab) => lab.accounts.map((account) => {
    const weekly = account.windows.find((one) => one.window === 'weekly' && !one.stale && one.margin !== null);
    const any = account.windows.find((one) => !one.stale && one.margin !== null);
    return { lab: lab.lab, account, margin: (weekly ?? any)?.margin ?? null };
  }));
}

/**
 * The one advice line the owner asked for: the labs (really their accounts) with headroom, or the
 * walled seats and where to move them. One line always, in both views, built only from what the
 * block already shows. A walled account with seats is offered the best-ordered healthy target; a
 * machine with walls and no headroom says so instead of inventing a destination. A window whose
 * reading is older than its own window is named with how to read a fresh one — the figure it
 * carried is not advice about the present.
 */
export function adviceOf(labs: readonly ReportQuotaLab[], expired: readonly string[] = []): string {
  const all = accountsOf(labs);
  // Any window at all, stale ones included: "no readings yet" is for a machine nothing answered
  // on, and a stale figure is an answer whose clock has moved on — the headroom sentence is the
  // true one there.
  const withFigures = all.filter((one) => one.account.windows.length > 0);
  const noFresh = expired.length === 0
    ? null
    : `no fresh reading on ${expired.slice(0, 2).join(', ')}${expired.length > 2 ? ` and ${expired.length - 2} more` : ''}: a running seat's status line or the CLI's own usage command reads one on the next run`;
  // A fresh figure whose source printed no reset has no clock to read a margin against, and the
  // CLI's own status view is where that clock is printed. Named on the same line, so `not
  // printed` in a cell never stands without a route to the reset it says is off-screen. A window
  // whose row printed its own margin needs no route — the pace is the figure advice uses — and a
  // walled account's advice is the move, not an errand for a clock.
  const noReset = all.flatMap((one) => one.account.windows
    .filter((w) => one.account.state !== 'walled' && !w.wall && !w.stale && !w.expired
      && w.used !== null && w.resetsIn === null && w.margin === null)
    .map((w) => `${named(one.account, one.lab)} (${w.window})`));
  const notes: string[] = [];
  if (noFresh !== null) notes.push(noFresh);
  if (noReset.length > 0) {
    const list = `${noReset.slice(0, 2).join(', ')}${noReset.length > 2 ? ` and ${noReset.length - 2} more` : ''}`;
    notes.push(`no reset printed on ${list}: the CLI's own status view shows it`);
  }
  if (all.length === 0) return 'no lab is declared on this machine: declare an account first';
  const targets = all
    .filter((one) => one.account.state === 'ok' && one.margin !== null && one.margin >= HEADROOM)
    .sort((a, b) => (b.margin as number) - (a.margin as number) || a.account.account.localeCompare(b.account.account));
  const walled = all.filter((one) => one.account.state === 'walled');
  // Near the cap on the margin alone is the case the used figure hides: name it, worst margin
  // first, so an account at 89% and falling fast is never advice-silent.
  const near = all
    .filter((one) => one.account.state === 'near cap')
    .sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0) || a.account.account.localeCompare(b.account.account));
  const describe = (one: { lab: string; account: ReportQuotaAccount; margin: number | null }): string => {
    const figure = one.account.windows.find((w) => w.window === 'weekly' && !w.stale && w.margin !== null)
      ?? one.account.windows.find((w) => !w.stale && w.margin !== null);
    const parts = [`used ${figure?.used ?? '?'}%`];
    if (one.margin !== null) parts.push(marginWord(one.margin));
    return `${named(one.account, one.lab)} (${figure?.window ?? 'weekly'} ${parts.join(', ')})`;
  };
  const withNote = (line: string): string => (notes.length === 0 ? line : `${line}; ${notes.join('; ')}`);
  if (walled.length > 0) {
    const moves: string[] = [];
    for (const one of walled.slice(0, 2)) {
      const who = one.account.seats.length > 0 ? one.account.seats.join(', ') : `seats drawing on ${named(one.account, one.lab)}`;
      const target = targets.find((other) => other.account !== one.account);
      moves.push(target === undefined
        ? `swap ${who} off ${named(one.account, one.lab)} (walled): no other account has headroom`
        : `swap ${who} off ${named(one.account, one.lab)} (walled) to ${describe(target)}`);
    }
    return withNote(moves.join('; '));
  }
  // An account near its cap is named before any headroom: the owner's one line must say what is
  // about to run out, and where the spare capacity is when there is one.
  if (near.length > 0) {
    const warn = `near cap on ${near.slice(0, 2).map((one) => describe(one)).join('; ')}`;
    return withNote(targets.length > 0 ? `${warn}; headroom on ${targets.slice(0, 2).map((one) => describe(one)).join('; ')}` : warn);
  }
  if (targets.length > 0) {
    return withNote(`headroom on ${targets.slice(0, 2).map((one) => describe(one)).join('; ')}`);
  }
  if (notes.length > 0) return notes.join('; ');
  if (withFigures.length > 0) return `no account has headroom yet (no fresh reading is ahead of pace by ${HEADROOM}% or more)`;
  return 'no readings yet: no seat status line and no CLI usage command has answered';
}

/** A signed margin, one decimal when it has one: `+13.3`, `-10`, `0`. */
export function signed(value: number): string {
  if (value === 0) return '0';
  return `${value > 0 ? '+' : ''}${value}`;
}

/** The pace as a line prints it, in the owner's words: `on pace` within the headroom band of the
 *  window's own clock either way, `ahead of pace by 13.3%` a band or more ahead of it, and
 *  `runs out before the reset` a band or more behind — the window and state lines print that same
 *  fact in hours when the clock is known. `pace not known` when the source gave no clock. */
export function marginWord(margin: number | null): string {
  if (margin === null) return 'pace not known';
  if (margin <= -HEADROOM) return 'runs out before the reset';
  if (margin >= HEADROOM) return `ahead of pace by ${round1(margin)}%`;
  return 'on pace';
}

/** One window's line, under the account's own line: the two percentages, the reset, the margin,
 *  and where the figure came from. A wall prints as a wall — no percentage is invented for it.
 *  A window running ahead of its clock by the headroom band prints the run-out sentence in place
 *  of the reset countdown and the margin, which it already carries both hours of. */
function windowText(one: ReportQuotaWindow): string {
  // A figure whose source printed no reset says so; a wall's reset is the limit lifting, which
  // no figure names either, so the wall keeps `unknown` for a screen that named none.
  const reset = one.wall
    ? (one.resetsIn === null ? 'resets unknown' : `resets in ${one.resetsIn}`)
    : (one.resetsIn === null ? 'resets not printed' : `resets in ${one.resetsIn}`);
  const from = `(${one.source}, read ${one.age} ago)`;
  if (one.wall) return `${one.window}  walled  ${reset}  ${from}`;
  // A reading older than its own window is of a passed instance: the words, the age and the
  // source are the line; the figure and its reset are not the current window's.
  if (one.expired) return `${one.window}  no fresh reading  ${from}`;
  const stale = one.stale ? '  stale' : '';
  const clock = one.runsOutIn === null
    ? `${reset}  ${marginWord(one.margin)}`
    : `runs out in about ${one.runsOutIn}, before the reset in ${one.resetsIn}`;
  return `${one.window}  used ${one.used}%  left ${one.left}%  ${clock}  ${from}${stale}`;
}

function seatsClause(one: ReportQuotaAccount): string {
  const parts = [...one.seats];
  if (one.seatsOther !== undefined) parts.push(`+${one.seatsOther} on another team`);
  return parts.length === 0 ? '' : `  seats: ${parts.join(', ')}`;
}

/**
 * The quota block's text lines, both views alike: the header, each lab — one line when it has no
 * account declared, a state and its accounts otherwise — and the one advice line. The block is
 * rendered from the same `ReportQuota` the `--json` face carries.
 */
export function quotaText(quota: ReportQuota): string[] {
  const lines = ['quota'];
  if (quota.labs.length === 0) lines.push(`  not known: no account declared; declare it in ${quota.accountsFile}`);
  for (const lab of quota.labs) {
    // A lab with no account declared is spoken for once, by the report's own lab line; the quota
    // block says nothing about it, so the owner never reads the same sentence twice.
    if (lab.accounts.length === 0) continue;
    lines.push(`  ${lab.lab}  ${lab.state}`);
    for (const account of lab.accounts) {
      // A wall is an answer, so an account with only a wall says when it lifts — the screen's own
      // words, or `unknown` when the screen named no reset — and carries no "no reading yet" line
      // underneath: that sentence is for an account nothing answered on. A wall over a figure keeps
      // its reset on the window line, and says it here only when the screen itself named one.
      let reset = '';
      if (account.state === 'walled') {
        if (account.windows.length === 0) reset = `  resets ${account.wallResets ?? 'unknown'}`;
        else if (account.wallResets !== null) reset = `  resets ${account.wallResets}`;
      }
      lines.push(`    ${named(account)}  ${account.state}${reset}${seatsClause(account)}`);
      if (account.windows.length === 0 && account.state !== 'walled') lines.push('      not known: no reading yet');
      for (const one of account.windows) lines.push(`      ${windowText(one)}`);
    }
  }
  lines.push(`advice: ${quota.advice}`);
  return lines;
}
