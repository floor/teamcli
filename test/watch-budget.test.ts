// RFC 0003 § 4.1, § 6, § 7 and § 9.5 through the watch: the core parses each seat's quota line
// into the observation, records it for the accounts whose `sources` take it, and the budget
// check reports the marks a window crosses, an account inside its reserve or floor, and one that
// reads unknown while seats run on it. Fixtures only: no screen here is a real session's.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { WATCH_CHECKS_CHANGED } from '../src/approve/fingerprint.ts';
import type { Seen } from '../src/budgets/readings.ts';
import type { CheckOutcome } from '../src/budgets/run.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, pass, type PassResult } from '../src/watch/pass.ts';
import { readScreen } from '../src/watch/screen.ts';
import { withWas } from './helpers.ts';

const NOW = Date.parse('2026-10-04T09:00:00Z');
const MIN = 60_000;
const WEEK = 7 * 24 * 3600_000;
const RESET = NOW + WEEK;

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');

// Where a real file writes its accounts and its checks: under the section, at its indentation.
const MARKS = '  marks: [50, 75, 90]          # percent used, per account and window';
const UNSENT = '  unsent_after: 1m';

function source(accounts = '', checks = ''): string {
  return example
    .replace(MARKS, accounts ? `${MARKS}\n${accounts}` : MARKS)
    .replace(UNSENT, checks ? `${UNSENT}\n${checks}` : UNSENT);
}

function team(accounts = '', checks = ''): TeamFile {
  const result = validateTeamFile(source(accounts, checks));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

const OPENAI = '  accounts:\n    openai: { kind: subscription, reserve: 3%, sources: [check], check: openai-quota }\n';
const RESERVE = '  accounts:\n    openai: { kind: subscription, reserve: 10%, sources: [check], check: openai-quota }\n';
const SCREEN_READ = '  accounts:\n    openai: { kind: subscription, reserve: 3%, sources: [status_line] }\n';
const DEEPSEEK = '  accounts:\n    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: deepseek-balance }\n';
const BOTH = '  accounts:\n    openai: { kind: subscription, reserve: 20%, sources: [check, status_line], check: openai-quota }\n';
const SCREEN_FIRST = '  accounts:\n    openai: { kind: subscription, reserve: 20%, sources: [status_line, check], check: openai-quota }\n';

// Screens of Claude Code, as the live team shows them, and a Codex one whose status line carries
// the weekly figure the codex profile reads.
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const quota = `• Working (2m 10s • esc to interrupt)\n\n  GPT-5.6-Terra medium · Context 98% left · weekly 39% left\n`;

type Over = Partial<Record<string, { status?: string; screen?: string }>>;

function agent(name: string, workspace: string, status: string, kind: string): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The example's team: the coordinator idle at its prompt, the rest working. A seat named in
// `drop` is not running at all.
function live(over: Over = {}, drop: string[] = []): Live {
  const seats: [string, string, string, string, string][] = [
    ['claude-coordinator-acme', 'w0', 'idle', 'claude', idle],
    ['codex-acme', 'w1', 'working', 'codex', ''],
    ['deepseek-acme', 'w2', 'working', 'claude', busy],
    ['deepseek-acme-2', 'w3', 'working', 'claude', busy],
  ];
  const agents: HerdrAgent[] = [];
  const screens: Record<string, string> = {};
  for (const [name, workspace, status, kind, screen] of seats) {
    if (drop.includes(name)) continue;
    const change = over[name] ?? {};
    agents.push(agent(name, workspace, change.status ?? status, kind));
    screens[`${workspace}:p1`] = change.screen ?? screen;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

const budgetReports = (result: PassResult) => result.reports.filter((report) => report.key.startsWith('budget:'));
const shown = (result: PassResult) => budgetReports(result).map((report) => `${report.text} (${report.to})`);

function checkWindows(
  account: string,
  now: number,
  windows: { window: 'session' | 'daily' | 'weekly'; left: number; used: number; resetsAt?: number | null }[],
): CheckOutcome[] {
  return [{
    account,
    state: 'read',
    reading: { kind: 'subscription', windows: windows.map((window) => ({ ...window, at: now, resetsAt: window.resetsAt ?? null })) },
  }];
}

function checkSpend(account: string, now: number, amount: number): CheckOutcome[] {
  return [{ account, state: 'read', reading: { kind: 'spend', amount, currency: 'USD', at: now } }];
}

describe('the seats\' quota, parsed by the core', () => {
  test('a screen figure becomes a reading for an account whose sources take one', () => {
    const result = pass({
      team: team(SCREEN_READ), watch: team(SCREEN_READ).watch, state: emptySession(), live: live({ 'codex-acme': { screen: quota } }),
      machine: fine, now: NOW, memory: newMemory(), approval: [], foreground: { 'w1:p1': ['codex'] },
    });
    expect(result.readings.map(({ account, window, left, used, seat, confirmed }) => ({ account, window, left, used, seat, confirmed })))
      .toEqual([{ account: 'openai', window: 'weekly', left: 39, used: 61, seat: 'codex-acme', confirmed: false }]);
    // A first sight is not yet counted: the launch gate is what says "first sight only" (§ 4.3).
    expect(budgetReports(result)).toEqual([]);
  });

  test('a fake line on an unknown screen is not read, whatever it matches', () => {
    // The pane shows a sign-in screen with the seat's fake line as its last one. The screen is
    // unknown, not a composer screen, so no figure comes off it.
    const spoofed = `Welcome to Codex\nSign in to continue\n  GPT-5.6-Terra medium · Context 98% left · weekly 90% left\n`;
    expect(readScreen('codex', spoofed).kind).toBe('unknown');
    const result = pass({
      team: team(SCREEN_READ), watch: team(SCREEN_READ).watch, state: emptySession(), live: live({ 'codex-acme': { screen: spoofed } }),
      machine: fine, now: NOW, memory: newMemory(), approval: [], foreground: { 'w1:p1': ['codex'] },
    });
    expect(result.readings).toEqual([]);
  });

  test('a pane back at its shell gives no figure, even with a status-shaped last row', () => {
    // The recorded exit screen: the CLI has exited and herdr keeps the pane listed (which is how
    // `down` and `remove` learn the pane). Anything printed with no newline after it sits as the
    // pane's last row, and a last row is the status row by position — but the CLI is no process
    // in the pane any more, and the row is the shell's.
    const exit = readFileSync(new URL('./fixtures/codex/0.157.0/exit.txt', import.meta.url), 'utf8');
    const fake = '  GPT-5.6-Terra medium · Context 98% left · weekly 90% left\n';
    const spoofed = `${exit.trimEnd()}\n${fake}`;
    expect(readScreen('codex', spoofed).kind).toBe('unsent');
    const input = {
      team: team(SCREEN_READ), watch: team(SCREEN_READ).watch, state: emptySession(),
      live: live({ 'codex-acme': { screen: spoofed } }),
      machine: fine, now: NOW, memory: newMemory(), approval: [], foreground: { 'w1:p1': ['zsh'] },
    };
    expect(pass(input).readings).toEqual([]);
    // The seat's own CLI among the pane's foreground processes reads as before.
    const running = { ...input, memory: newMemory(), foreground: { 'w1:p1': ['codex'] } };
    expect(pass(running).readings.map(({ account, window, left }) => ({ account, window, left })))
      .toEqual([{ account: 'openai', window: 'weekly', left: 90 }]);
    // A figure is read only where herdr reports the seat's CLI: an unreadable list (null) is not
    // a CLI, and a pane the map doesn't hold was not read either. Both give no figure — a shell's
    // row is never trusted, and not knowing is not a reading.
    const unread = { ...input, memory: newMemory(), foreground: { 'w1:p1': null } };
    expect(pass(unread).readings).toEqual([]);
    const unheld = { ...input, memory: newMemory(), foreground: {} };
    expect(pass(unheld).readings).toEqual([]);
  });

  test('an account whose sources name only the check takes no screen reading', () => {
    const result = pass({
      team: team(OPENAI), watch: team(OPENAI).watch, state: emptySession(), live: live({ 'codex-acme': { screen: quota } }),
      machine: fine, now: NOW, memory: newMemory(), approval: [], foreground: { 'w1:p1': ['codex'] },
    });
    expect(result.readings).toEqual([]);
    // Nothing counts for it this pass, and a seat spends it: unknown while running.
    expect(shown(result)).toEqual(['openai is unknown while codex-acme runs on it (operator)']);
  });
});

describe('the marks', () => {
  const week = (now: number, used: number, resetsAt: number | null) =>
    checkWindows('openai', now, [{ window: 'weekly', left: 100 - used, used, resetsAt }]);

  function marks(memory: ReturnType<typeof newMemory>, now: number, outcomes: CheckOutcome[]): string[] {
    const result = pass({ team: team(OPENAI), watch: team(OPENAI).watch, state: emptySession(), live: live(), machine: fine, now, memory, approval: [], outcomes: outcomes });
    return budgetReports(result).filter((report) => report.key.startsWith('budget:mark:')).map((report) => report.text);
  }

  test('each mark is reported once per window, and armed again at its reset', () => {
    const memory = newMemory();
    expect(marks(memory, NOW, week(NOW, 92, RESET))).toEqual([
      'openai weekly is 92% used, past the 50% mark',
      'openai weekly is 92% used, past the 75% mark',
      'openai weekly is 92% used, past the 90% mark',
    ]);
    expect(marks(memory, NOW + MIN, week(NOW + MIN, 93, RESET))).toEqual([]);
    // A dip below a mark before the reset does not arm it again.
    expect(marks(memory, NOW + 2 * MIN, week(NOW + 2 * MIN, 60, RESET))).toEqual([]);
    expect(marks(memory, NOW + 3 * MIN, week(NOW + 3 * MIN, 94, RESET))).toEqual([]);
    // The reset passes: the next window's figure crosses them again.
    expect(marks(memory, RESET + MIN, week(RESET + MIN, 55, RESET + WEEK))).toEqual([
      'openai weekly is 55% used, past the 50% mark',
    ]);
  });

  test('with no reset time, a figure ten points lower is a new window\'s', () => {
    const memory = newMemory();
    expect(marks(memory, NOW, week(NOW, 60, null))).toEqual(['openai weekly is 60% used, past the 50% mark']);
    expect(marks(memory, NOW + MIN, week(NOW + MIN, 58, null))).toEqual([]);
    expect(marks(memory, NOW + 2 * MIN, week(NOW + 2 * MIN, 45, null))).toEqual([]);
    expect(marks(memory, NOW + 3 * MIN, week(NOW + 3 * MIN, 55, null))).toEqual(['openai weekly is 55% used, past the 50% mark']);
  });

  test('a mark is the operator\'s to act on', () => {
    const result = pass({ team: team(OPENAI), watch: team(OPENAI).watch, state: emptySession(), live: live(), machine: fine, now: NOW, memory: newMemory(), approval: [], outcomes: week(NOW, 92, RESET) });
    expect(budgetReports(result).every((report) => report.to === 'operator')).toBe(true);
  });
});

describe('the reserve and the floor', () => {
  test('an account inside its reserve is the owner\'s, once, and again when it comes back', () => {
    const memory = newMemory();
    const at = (now: number, outcomes: CheckOutcome[]) =>
      budgetReports(pass({ team: team(RESERVE), watch: team(RESERVE).watch, state: emptySession(), live: live(), machine: fine, now, memory, approval: [], outcomes: outcomes }))
        .filter((report) => report.key.startsWith('budget:reserve:'))
        .map((report) => `${report.text} (${report.to})`);
    expect(at(NOW, checkWindows('openai', NOW, [{ window: 'weekly', left: 7, used: 93, resetsAt: RESET }])))
      .toEqual(['openai weekly left 7%, inside its 10% reserve (owner)']);
    expect(at(NOW + MIN, checkWindows('openai', NOW + MIN, [{ window: 'weekly', left: 6, used: 94, resetsAt: RESET }])))
      .toEqual([]);
    expect(at(NOW + 2 * MIN, checkWindows('openai', NOW + 2 * MIN, [{ window: 'weekly', left: 60, used: 40, resetsAt: RESET }])))
      .toEqual([]);
    // The tightest window inside the reserve is the one named.
    expect(at(NOW + 3 * MIN, checkWindows('openai', NOW + 3 * MIN, [
      { window: 'session', left: 9, used: 91, resetsAt: null },
      { window: 'weekly', left: 6, used: 94, resetsAt: null },
    ]))).toEqual(['openai weekly left 6%, inside its 10% reserve (owner)']);
  });

  test('a spend account at or below its floor is the owner\'s, once, and again when it comes back', () => {
    const memory = newMemory();
    const at = (now: number, amount: number) =>
      budgetReports(pass({ team: team(DEEPSEEK), watch: team(DEEPSEEK).watch, state: emptySession(), live: live(), machine: fine, now, memory, approval: [], outcomes: checkSpend('deepseek', now, amount) }))
        .filter((report) => report.key.startsWith('budget:floor:'))
        .map((report) => `${report.text} (${report.to})`);
    expect(at(NOW, 4.2)).toEqual(['deepseek 4.2 USD left, at its 5 USD floor (owner)']);
    expect(at(NOW + MIN, 3)).toEqual([]);
    expect(at(NOW + 2 * MIN, 7.5)).toEqual([]);
    expect(at(NOW + 3 * MIN, 5)).toEqual(['deepseek 5 USD left, at its 5 USD floor (owner)']);
  });

  test('a spend account crosses no marks', () => {
    const result = pass({
      team: team(DEEPSEEK), watch: team(DEEPSEEK).watch, state: emptySession(), live: live(), machine: fine, now: NOW, memory: newMemory(),
      approval: [], outcomes: checkSpend('deepseek', NOW, 4.2),
    });
    expect(budgetReports(result).filter((report) => report.key.startsWith('budget:mark:'))).toEqual([]);
  });
});

describe('an account that reads unknown', () => {
  const unreadable: CheckOutcome[] = [{ account: 'openai', state: 'unreadable' }];

  test('is reported to the operator while seats run on it', () => {
    const memory = newMemory();
    const at = (now: number, outcomes: CheckOutcome[], scene = live()) =>
      budgetReports(pass({ team: team(RESERVE), watch: team(RESERVE).watch, state: emptySession(), live: scene, machine: fine, now, memory, approval: [], outcomes: outcomes }))
        .filter((report) => report.key === 'budget:unknown:openai')
        .map((report) => `${report.text} (${report.to})`);
    expect(at(NOW, unreadable)).toEqual(['openai is unknown while codex-acme runs on it (operator)']);
    expect(at(NOW + MIN, unreadable)).toEqual([]);
    // A reading clears it; unknown again is new news.
    expect(at(NOW + 2 * MIN, checkWindows('openai', NOW + 2 * MIN, [{ window: 'weekly', left: 61, used: 39, resetsAt: RESET }])))
      .toEqual([]);
    expect(at(NOW + 3 * MIN, unreadable)).toEqual(['openai is unknown while codex-acme runs on it (operator)']);
  });

  test('is quiet when no running seat spends it', () => {
    const result = pass({
      team: team(RESERVE), watch: team(RESERVE).watch, state: emptySession(), live: live({}, ['codex-acme']), machine: fine, now: NOW, memory: newMemory(),
      approval: [], outcomes: unreadable,
    });
    expect(budgetReports(result)).toEqual([]);
  });

  test('is not what a first sight is called', () => {
    const result = pass({
      team: team(SCREEN_READ), watch: team(SCREEN_READ).watch, state: emptySession(), live: live({ 'codex-acme': { screen: quota } }),
      machine: fine, now: NOW, memory: newMemory(), approval: [], outcomes: [], foreground: { 'w1:p1': ['codex'] },
    });
    expect(budgetReports(result)).toEqual([]);
  });
});

describe('the source fallback is per window', () => {
  // A reading a status line gave in an earlier pass, still in the project's cache (§ 4.4).
  const seen = (window: 'session' | 'weekly', left: number, changedAt: number) => ({
    account: 'openai', window, left, used: 100 - left, changedAt,
    resetsAt: NOW + 3_600_000, seat: 'codex-acme', source: 'status_line' as const, confirmed: true,
  });
  const at = (teamSource: string, readings: Seen[]) =>
    pass({
      team: team(teamSource), watch: team(teamSource).watch, state: emptySession(), live: live(), machine: fine,
      now: NOW, memory: newMemory(), approval: [],
      outcomes: checkWindows('openai', NOW, [{ window: 'session', left: 80, used: 20, resetsAt: NOW + 3_600_000 }]),
      readings,
    });

  test('a check that reported only session leaves the status line\'s weekly counted', () => {
    // The check filled `session`; the status line's `weekly` from an earlier pass sits at 5% left,
    // inside the 20% reserve. The check answering one window must not hide the other window's
    // source: the weekly figure is counted, and its reserve crossing is reported.
    expect(shown(at(BOTH, [seen('weekly', 5, NOW - MIN)]))).toEqual([
      'openai weekly is 95% used, past the 50% mark (operator)',
      'openai weekly is 95% used, past the 75% mark (operator)',
      'openai weekly is 95% used, past the 90% mark (operator)',
      'openai weekly left 5%, inside its 20% reserve (owner)',
    ]);
  });

  test('a window the check reported is not overridden by a staler status-line figure', () => {
    // The check owns `session` (80% left); the staler screen figure of the same window (15% left,
    // inside the reserve) is below the check in `sources` and must not be read at all.
    expect(budgetReports(at(BOTH, [seen('session', 15, NOW - 20 * MIN)]))).toEqual([]);
  });

  test('a fresh check below a stale status line is not hidden by it', () => {
    // The screen's `session` figure is stale and inside the reserve; the check below it is fresh,
    // and § 4.3's order lets it count: a stale higher source is exactly when the lower one counts.
    expect(budgetReports(at(SCREEN_FIRST, [seen('session', 15, NOW - 40 * MIN)]))).toEqual([]);
  });

  test('a point on the cached reading moves no report, and only the point the pass carries forward', () => {
    // § 5: the pass reads figures, and the point rides the reading it carries forward. Same
    // reports, same folded readings record for record — the one field allowed to differ is the
    // point itself, and it is there in the pointed pass and nowhere in the plain one.
    const run = (points: boolean) => {
      const cached = seen('weekly', 5, NOW - MIN);
      return at(BOTH, [points ? withWas(cached) : cached]);
    };
    const plain = run(false);
    const pointed = run(true);
    // Non-vacuity: the reports this pins are the cached reading's own figures.
    expect(shown(plain)).toEqual([
      'openai weekly is 95% used, past the 50% mark (operator)',
      'openai weekly is 95% used, past the 75% mark (operator)',
      'openai weekly is 95% used, past the 90% mark (operator)',
      'openai weekly left 5%, inside its 20% reserve (owner)',
    ]);
    const bare = (one: Seen) => Object.fromEntries(Object.entries(one).filter(([field]) => field !== 'was'));
    expect(pointed.readings.map(bare)).toEqual(plain.readings.map(bare));
    expect(shown(pointed)).toEqual(shown(plain));
    expect(plain.readings.every((one) => !('was' in one))).toBe(true);
    expect(pointed.readings.some((one) => 'was' in one)).toBe(true);
  });
});

describe('watch.checks', () => {
  test('turns the budget check off, once the owner approved the change', () => {
    const crossed = checkWindows('openai', NOW, [{ window: 'weekly', left: 8, used: 92, resetsAt: RESET }]);
    const off = team(OPENAI, '  checks:\n    budget: off\n');
    expect(budgetReports(pass({ team: off, watch: off.watch, state: emptySession(), live: live(), machine: fine, now: NOW, memory: newMemory(), approval: [], outcomes: crossed }))).toEqual([]);
    // The section in force is still the approved list, which leaves budget on, so the marks run.
    const approved = { ...off.watch, checks: [] };
    const waiting = pass({ team: off, watch: approved, state: emptySession(), live: live(), machine: fine, now: NOW, memory: newMemory(), approval: [WATCH_CHECKS_CHANGED], outcomes: crossed });
    expect(budgetReports(waiting).filter((report) => report.key.startsWith('budget:mark:'))).toHaveLength(3);
  });
});
