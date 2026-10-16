// A `check` command's run and its output contract (RFC 0003 § 5). The raw output
// lives only here: it is parsed and dropped, and never returned, logged or shown.
// A check reads a vendor home; its bytes could carry anything the owner's tools know.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { budgetsInForceOf } from '../approve/approval.ts';
import type { BudgetAccount, TeamFile } from '../file/types.ts';
import type { WindowName } from '../profiles/quota.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { checkCommands, checkReadings, type ApprovedCheck } from './checks.ts';
import { resetsFrom } from './readings.ts';

/** One window of a subscription check reading. */
export type CheckWindow = {
  window: WindowName;
  left: number;
  used: number;
  /** The source's own measurement time: `at` when the line carries one, else the run's. */
  at: number;
  /** Anchored at the reading's own time, not at the run's. */
  resetsAt: number | null;
};

export type CheckReading =
  | { kind: 'subscription'; windows: CheckWindow[] }
  | { kind: 'spend'; amount: number; currency: string; at: number };

/** What one account's check reads this pass, or why it has no reading. */
export type CheckOutcome =
  | { account: string; state: 'read'; reading: CheckReading }
  | { account: string; state: 'unreadable' | 'unapproved' };

// § 5: one line, an amount with at most four decimals, an uppercase currency.
const SPEND = /^([0-9]+(?:\.[0-9]{1,4})?) ([A-Z]{3})$/;
// § 5: one to three lines, each a window, each figure whole and at most 100. The
// printed reset is a duration; the printed measurement time is unix seconds.
const LINE = /^(session|daily|weekly) (100|[0-9]{1,2})% (used|left)(?: resets ([0-9]+h(?:[0-9]+m)?|[0-9]+m))?(?: at ([0-9]{10}))?$/;

/**
 * An output's lines: one trailing newline allowed, and nothing else. A "\r\n" ending reads
 * as its line — the CR goes with the newline — and a CR anywhere else stays a character of
 * the line, off the contract.
 */
function linesOf(text: string): string[] | null {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (body === '') return null;
  return body.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * A subscription output against § 5. Any line off the contract, a figure over
 * 100, or a window twice reads unknown — the whole output, not just the line.
 * `at`, when printed, is the line's own time; a time later than the run is the run's.
 */
export function parseSubscription(text: string, now: number): CheckReading | null {
  const lines = linesOf(text);
  if (!lines || lines.length > 3) return null;
  const windows: CheckWindow[] = [];
  for (const line of lines) {
    const match = LINE.exec(line);
    if (!match) return null;
    const window = match[1] as WindowName;
    if (windows.some((one) => one.window === window)) return null;
    const value = Number(match[2]);
    const used = match[3] === 'used' ? value : 100 - value;
    const at = match[5] === undefined ? now : Math.min(Number(match[5]) * 1000, now);
    windows.push({ window, left: 100 - used, used, at, resetsAt: match[4] === undefined ? null : resetsFrom(match[4], at) });
  }
  return windows.length ? { kind: 'subscription', windows } : null;
}

/** A spend output against § 5: exactly one line, and in the floor's currency. */
export function parseSpend(text: string, currency: string, now: number): CheckReading | null {
  const lines = linesOf(text);
  if (!lines || lines.length !== 1) return null;
  const match = SPEND.exec(lines[0] ?? '');
  if (!match || match[2] !== currency) return null;
  return { kind: 'spend', amount: Number(match[1]), currency: match[2], at: now };
}

/** One output against its account's contract. Null reads unknown for that account. */
export function parseOutput(account: BudgetAccount, text: string, now: number): CheckReading | null {
  if (account.kind === 'spend') return account.floor === null ? null : parseSpend(text, account.floor.currency, now);
  return parseSubscription(text, now);
}

/**
 * Runs one approved command and returns its output, or null: § 5 gives it an
 * empty environment with PATH and HOME, a timeout, and exit 0; stderr is dropped.
 * The timeout kills (SIGKILL: a command that traps TERM would otherwise run on,
 * and `spawnSync` blocks the whole watch loop while it does). The command's bytes
 * are the owner's, so they are returned to the parser only.
 */
export function runCommand(path: string, timeoutMs = 10_000): string | null {
  try {
    const result = spawnSync(path, [], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

/** One account's reading this pass: null when the command fails, times out, or breaks its contract. */
export function readCheck(account: BudgetAccount, path: string, now: number, timeoutMs = 10_000): CheckReading | null {
  const text = runCommand(path, timeoutMs);
  return text === null ? null : parseOutput(account, text, now);
}

export type CheckRunner = (account: BudgetAccount, path: string, now: number) => CheckReading | null;

/**
 * What each checked account reads this pass: its reading, or that it has none
 * and why. `budgets` is the section in force: an account an unapproved edit
 * took out is not checked, and one it changed reads under the approved entry.
 * An account whose check is changed, missing or unapproved is not run at all
 * (§ 5, #45). The path handed to `run` is the one the approval recorded, hashed again
 * against the approval: the file's command is never run directly.
 */
export function checkOutcomes(
  budgets: TeamFile['budgets'],
  approved: Record<string, ApprovedCheck> | undefined,
  run: CheckRunner,
  now: number,
): CheckOutcome[] {
  const may = new Map(checkReadings(budgets, approved).map((one) => [one.account, one.state === 'approved']));
  const outcomes: CheckOutcome[] = [];
  for (const { account } of checkCommands(budgets)) {
    const entry = budgets.accounts[account];
    const known = approved?.[account];
    if (entry === undefined || known === undefined || may.get(account) !== true) {
      outcomes.push({ account, state: 'unapproved' });
      continue;
    }
    const reading = run(entry, known.path, now);
    outcomes.push(reading === null ? { account, state: 'unreadable' } : { account, state: 'read', reading });
  }
  return outcomes;
}

/**
 * What every checked account reads this pass, from the one standing the caller
 * read. The accounts are the ones the budgets in force name, never the file's
 * unapproved edit of them, and the commands are the verified record's: a
 * standing that is not verified leaves every check unapproved, so it is not
 * run at all — the watch's owner-only checks refuse, and the watch keeps
 * watching.
 */
export function runChecksOf(standing: Standing, team: TeamFile, now: number, run: CheckRunner = readCheck): CheckOutcome[] {
  const approved = standing.kind === 'verified' ? standing.record.approval.checks : undefined;
  return checkOutcomes(budgetsInForceOf(standing, team), approved, run, now);
}

/** `runChecksOf` as a standalone caller uses it: one read of its own, then the outcomes. */
export function runChecks(
  team: TeamFile,
  root: string,
  now: number,
  home: string = homedir(),
  run: CheckRunner = readCheck,
): CheckOutcome[] {
  return runChecksOf(approvalStanding(root, home), team, now, run);
}
