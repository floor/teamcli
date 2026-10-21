// The live quota sources, observed and never inferred: a seat's own status row read through
// herdr, a CLI's own usage command where the CLI has one (`agy --print /usage`, bounded by a
// timeout), and a quota screen that says the account is out. No credential, key or session file
// is read; the only process this file starts is the CLI's own usage print, and only for a seat
// that already runs that CLI. Every observation is stamped with the moment it was read.
import { execFileSync } from 'node:child_process';
import { stripSgr } from '../ansi.ts';
import { PANE_WINDOW, paneRead } from '../herdr.ts';
import { figuresOf, type QuotaPattern } from '../profiles/quota.ts';
import { quotaWith } from '../profiles/overrides.ts';
import { readScreen, statusRow } from '../watch/screen.ts';
import type { CostObservation, QuotaObservation, QuotaWindow } from './quota.ts';
import { PANE_UNREAD, USAGE_UNANSWERED } from './quota.ts';
import { realKey, type MachineUsage, type UsageView } from './usage.ts';

export type QuotaLive = {
  observations: QuotaObservation[];
  /** The spend a seat's own screen printed this run, one observation per pane that printed one;
   *  a seat whose screen printed no money figure has no entry here, never a zero. */
  costs: CostObservation[];
  /** Collapsed problems, one entry per distinct why with its count. */
  notes: Array<{ why: string; count: number }>;
};

export type QuotaObserverSources = {
  now: number;
  /** The pane read, injectable for tests: the shipped one shells out to herdr. */
  pane?: (pane: string, lines: number, session: string) => string | null;
  /** The CLI's own usage command, injectable for tests. Null means it did not answer. */
  usage?: (cli: string) => string | null;
  /** Whether a team's herdr session still runs, injectable for tests. False skips the team's
   *  panes: a dead session leaves a record, not a seat, and nothing behind it can answer.
   *  Omitted means no filtering; null (herdr unreachable) is not evidence either way. */
  session?: (name: string) => boolean | null;
};

/** The seat-shaped input a read needs: the seat's name, paying account and pool. */
type SeatTarget = { seat: string; account: string; pool?: 'gemini' | 'claude-gpt'; cli: string };

function addNote(notes: Map<string, number>, why: string): void {
  notes.set(why, (notes.get(why) ?? 0) + 1);
}

/**
 * Every live observation this caller may make: the panes of the teams the view shows — the
 * caller's own team under the restricted view, every team under the full one — read once each,
 * and the CLI usage command once when a visible seat runs a CLI that has one. The panes are the
 * team's own recorded seat panes; a seat with no pane is skipped silently (it has no live
 * source, and its account may still be read from the machine's stores).
 */
export function observeQuota(machine: MachineUsage, view: UsageView, sources: QuotaObserverSources): QuotaLive {
  const now = sources.now;
  const pane = sources.pane ?? ((paneId: string, lines: number, session: string) => paneRead(paneId, lines, session));
  const usage = sources.usage ?? runUsageCommand;
  const mineKey = view.mine === null ? null : realKey(view.mine);
  const teams = machine.teams.filter((team) => view.full || (mineKey !== null && realKey(team.root) === mineKey));
  const observations: QuotaObservation[] = [];
  const costs: CostObservation[] = [];
  const notes = new Map<string, number>();
  const screens = new Map<string, string | null>();
  let wantsUsage = false;
  for (const team of teams) {
    const session = team.usage.session;
    if (session === null) continue;
    // A team whose session is gone or stopped is a record: its panes cannot answer, and a seat
    // row left behind is exactly the stale name the report must not show.
    if (sources.session !== undefined && sources.session(session) === false) continue;
    for (const seat of team.usage.seatAccounts) {
      if (seat.cli === 'antigravity' || seat.cli === 'agy') wantsUsage = true;
      if (seat.pane === undefined || seat.pane === null) continue;
      const key = `${session}\0${seat.pane}`;
      let screen = screens.get(key);
      if (screen === undefined) {
        screen = pane(seat.pane, PANE_WINDOW, session);
        screens.set(key, screen);
        if (screen === null) addNote(notes, PANE_UNREAD);
      }
      const target: SeatTarget = { seat: seat.seat, account: seat.account, ...(seat.pool ? { pool: seat.pool } : {}), cli: seat.cli };
      // Stamped with the session the pane was read in: a report that attributes a figure back
      // to its seat holds two teams' same-named seats apart.
      for (const one of statusQuota(seat.cli, screen, target, now, quotaWith(seat.cli, []))) observations.push({ ...one, session });
      const cost = statusCost(seat.cli, screen, target, now);
      if (cost !== null) costs.push({ ...cost, session });
    }
  }
  if (wantsUsage) {
    const text = usage('agy');
    if (text === null) addNote(notes, USAGE_UNANSWERED);
    else observations.push(...parseUsageOutput(text, now));
  }
  return { observations: ageByReset(observations, now), costs, notes: [...notes.entries()].map(([why, count]) => ({ why, count })) };
}

/**
 * Ages the bars that print a countdown rather than a clock time. A status row is frozen at its
 * last render, and every bar of one account and window counts down to the same reset instant:
 * the smallest countdown is the freshest reading, and any other bar was read that much earlier.
 * A live run on 2026-10-17 found every visible claude-family row counting to one shared reset,
 * and the freshest matched the owner's own pane.
 */
export function ageByReset(observations: QuotaObservation[], now: number): QuotaObservation[] {
  const keyOf = (one: QuotaObservation): string => `${one.account}\0${one.pool ?? ''}\0${one.window ?? ''}`;
  const freshest = new Map<string, number>();
  for (const one of observations) {
    if (one.resetsAt === null || one.window === null) continue;
    const key = keyOf(one);
    const seen = freshest.get(key);
    if (seen === undefined || one.resetsAt < seen) freshest.set(key, one.resetsAt);
  }
  return observations.map((one) => {
    if (one.resetsAt === null || one.window === null) return one;
    const min = freshest.get(keyOf(one));
    const age = min === undefined ? 0 : Math.max(0, one.resetsAt - min);
    return age === 0 ? one : { ...one, observedAt: now - age };
  });
}

/** A reset duration in the profile's own grammar (`114h4m`, `44m`) as milliseconds. */
export function durationMs(text: string): number | null {
  const match = /^(?:([0-9]+)h)?(?:([0-9]+)m)?$/.exec(text);
  if (match === null || (match[1] === undefined && match[2] === undefined)) return null;
  return Number(match[1] ?? 0) * 3_600_000 + Number(match[2] ?? 0) * 60_000;
}

/** The parenthesised field of a status label: either a reset duration, a signed margin, or both
 *  (`(+13.3%) (125h26m)` arrives as two fields, but `(125h26m, +13.3%)` is accepted too). */
function parenOf(text: string | undefined): { resetsMs: number | null; margin: number | null } {
  let resetsMs: number | null = null;
  let margin: number | null = null;
  if (text === undefined) return { resetsMs, margin };
  for (const token of text.split(/[,\s·]+/).filter((word) => word !== '')) {
    const duration = durationMs(token);
    if (duration !== null) resetsMs = duration;
    else if (/^[±+\-]?[0-9]+(?:\.[0-9]+)?%$/.test(token)) margin = Number(token.replace(/[±%]/g, ''));
  }
  return { resetsMs, margin };
}

const LABELED = /\b([LW]):\s*([0-9]{1,3})%(?:\s*\(([^)]*)\))?(?:\s*\(([^)]*)\))?/g;

/**
 * The subscription labels of a configurable claude-family status row: `L` is the session window,
 * `W` the weekly one, each a USED percentage. The row's own margin (`(+13.3%)`) is carried as
 * printed; a reset duration (`(125h26m)`) becomes a moment. This parser is the quota view's own
 * because the profile grammar carries one parenthesised field per pattern and this row carries
 * two — the shipped `L`/`W` patterns still feed the watch unchanged.
 */
export function labeledFigures(row: string | null, target: SeatTarget, now: number): QuotaObservation[] {
  if (row === null) return [];
  const found: QuotaObservation[] = [];
  for (const match of row.matchAll(LABELED)) {
    const used = Number(match[2]);
    if (used > 100) continue;
    // The real row carries two fields — `W: 12% (+13.3%) (125h26m)` — so both are read.
    const { resetsMs, margin } = parenOf([match[3], match[4]].filter((part) => part !== undefined).join(','));
    found.push({
      // `L:`/`W:` are the CLI's own subscription labels, and that subscription is Anthropic's
      // whatever launcher pays the seat: on 2026-10-17 a seat paid through zai and one paid
      // through deepseek printed the same bars as the owner's own pane. The shipped patterns
      // name the account too, so an undeclared account still lands on the right lab.
      account: 'anthropic',
      ...(target.pool ? { pool: target.pool } : {}),
      window: match[1] === 'L' ? 'session' : 'weekly',
      used,
      left: 100 - used,
      resetsAt: resetsMs === null ? null : now + resetsMs,
      resetText: null,
      observedAt: now,
      source: 'status line',
      seat: target.seat,
      margin,
      wall: false,
    });
  }
  return found;
}

/** The wall phrases the owner named, for a screen the profiles' rate-limit grammar does not
 *  claim: only the last three visible lines are read, where a wall replaces the prompt. */
const WALLS: RegExp[] = [
  /\bquota reached\b/i,
  /\bout of usage\b/i,
  /\busage limit reached\b/i,
  /API Error: Request rejected \((?:429|403)\)/,
];

function wallOf(screen: string): { wall: boolean; reset: string | null } {
  const lines = stripSgr(screen).split('\n').filter((line) => line.trim() !== '').slice(-3);
  for (const line of lines) {
    if (!WALLS.some((one) => one.test(line))) continue;
    // The phrase is the wall, whether or not the line also says when it lifts.
    const reset = /(?:resets?|resetting|try again)\s+(?:at\s+)?([^\n·]+?)\s*$/i.exec(line);
    return { wall: true, reset: reset?.[1] ?? null };
  }
  return { wall: false, reset: null };
}

/**
 * A pane's observations: the status row's figures and margins, and a wall when the screen says
 * the account is out — the classifier's own rate-limit screen first, then the owner's phrases.
 * `patterns` are the account's shipped quota patterns (plus any the caller resolved); a
 * claude-family row's labels are read by `labeledFigures` so its printed margin survives.
 */
export function statusQuota(cli: string, screen: string | null, target: SeatTarget, now: number, patterns: readonly QuotaPattern[]): QuotaObservation[] {
  if (screen === null) return [];
  const row = statusRow(cli, screen);
  const found: QuotaObservation[] = [];
  const labeled = cli === 'claude-code' ? labeledFigures(row, target, now) : [];
  for (const one of labeled) found.push(one);
  const seen = new Set(labeled.map((one) => one.window));
  for (const figure of figuresOf(patterns, row)) {
    if (figure.window !== 'session' && figure.window !== 'weekly') continue;
    if (seen.has(figure.window)) continue;
    found.push({
      account: figure.account,
      ...(target.pool ? { pool: target.pool } : {}),
      window: figure.window,
      used: figure.used,
      left: figure.left,
      resetsAt: figure.resets === null ? null : now + (durationMs(figure.resets) ?? 0),
      resetText: null,
      observedAt: now,
      source: 'status line',
      seat: target.seat,
      margin: null,
      wall: false,
    });
  }
  const kind = readScreen(cli, screen);
  const phrase = wallOf(screen);
  if (phrase.wall || kind.kind === 'rate limit') {
    // The classifier's reset carries its own preposition — `at 11:00`, `in 47h31m` — so it is
    // printed as it stands; the owner's wall phrases read a time and keep the `at` the earlier
    // writer used. The text follows "resets ", never a second preposition.
    const resetText = kind.kind === 'rate limit'
      ? kind.reset === null ? null : kind.reset.kind === 'at' ? `at ${kind.reset.value}` : `in ${kind.reset.value}`
      : phrase.reset === null ? null : `at ${phrase.reset.replace(/^at\s+/i, '')}`;
    found.push({
      account: target.account,
      ...(target.pool ? { pool: target.pool } : {}),
      window: null,
      used: null,
      left: null,
      resetsAt: null,
      resetText,
      observedAt: now,
      source: 'quota screen',
      seat: target.seat,
      margin: null,
      wall: true,
    });
  }
  return found;
}

/** The session spend a configurable claude-family status row prints. The real 2.1.299 capture
 *  (test/usage-quota.test.ts:47, the row `status.test.ts` also pins) carries
 *  `S: $5.8 ⣿⣄⣀⣀⣀ 24%`; only the dollar figure is read, and only from the row the profile's
 *  own status patterns recognize. A row that prints no amount is no observation — the report
 *  shows the seat's spend `unknown`, never a zero. Only the claude-family row has a capture in
 *  this tree that prints money (`grep 'S: \$' test/` finds no other CLI's); the others give
 *  none. */
export function statusCost(cli: string, screen: string | null, target: SeatTarget, now: number): CostObservation | null {
  if (cli !== 'claude-code' || screen === null) return null;
  const row = statusRow(cli, screen);
  if (row === null) return null;
  const match = /(?:^|\s)S:\s*\$([0-9]+(?:\.[0-9]+)?)(?=\s|$)/.exec(row);
  if (match === null) return null;
  return {
    seat: target.seat,
    account: target.account,
    amount: Number(match[1]),
    currency: 'USD',
    observedAt: now,
    source: 'status line',
  };
}

/**
 * The antigravity CLI's own usage print, as a real run gave it on 2026-10-17 (5.1s, exit 0):
 * tab-separated lines `Gemini Models<TAB>Weekly Limit Remaining<TAB>89%<TAB>2026-10-23T21:59:46Z`,
 * and the same for `Five Hour Limit Remaining` and `Claude and GPT models`. "Remaining" is the
 * LEFT percentage; the reset is an absolute instant. A line that does not read as that shape is
 * skipped: an output format this reader does not know is no figure, never a guess.
 */
export function parseUsageOutput(text: string, now: number): QuotaObservation[] {
  const found: QuotaObservation[] = [];
  for (const line of text.split('\n')) {
    const parts = line.split('\t').map((part) => part.trim());
    if (parts.length < 4) continue;
    const [poolLabel = '', windowLabel = '', figure = '', reset = ''] = parts;
    const pool = /^gemini/i.test(poolLabel) ? 'gemini' : /claude|gpt/i.test(poolLabel) ? 'claude-gpt' : null;
    if (pool === null) continue;
    const window: QuotaWindow | null = /five hour/i.test(windowLabel) ? 'session' : /weekly/i.test(windowLabel) ? 'weekly' : null;
    if (window === null || !/^[0-9]{1,3}%$/.test(figure)) continue;
    const left = Number(figure.slice(0, -1));
    if (left > 100) continue;
    const resetsAt = Date.parse(reset);
    found.push({
      account: 'google-antigravity',
      pool,
      window,
      left,
      used: 100 - left,
      resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
      resetText: null,
      observedAt: now,
      source: 'cli usage',
      seat: null,
      margin: null,
      wall: false,
    });
  }
  return found;
}

/** The CLI's own usage command. Only antigravity has one this tool knows: `agy --print /usage`,
 *  bounded so a hung CLI cannot hold the report. Anything but a run that printed is null. */
function runUsageCommand(cli: string): string | null {
  if (cli !== 'agy' && cli !== 'antigravity') return null;
  try {
    return execFileSync('agy', ['--print', '/usage'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
  } catch {
    return null;
  }
}

let usageExec: (cli: string) => string | null = runUsageCommand;

/** Swaps the CLI usage call the observer makes; null restores the real one. */
export function setUsageExec(exec: ((cli: string) => string | null) | null): void {
  usageExec = exec ?? runUsageCommand;
}

/** The real observer for the shipped command: the shipped pane read and the real usage call. The
 *  session filter is the command's own (`realSources.sessions`, memoized over one run); omitted,
 *  no team is skipped, which is what a caller that holds its machine as a fixture expects. */
export function realQuotaObservations(
  machine: MachineUsage,
  view: UsageView,
  now: number,
  sessions?: (name: string) => boolean | null,
): QuotaLive {
  return observeQuota(machine, view, { now, usage: (cli) => usageExec(cli), ...(sessions === undefined ? {} : { session: sessions }) });
}
