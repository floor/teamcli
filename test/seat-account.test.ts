// RFC 0003 § 3b: a seat names its account through its vendor, or through an explicit `account:`
// when one vendor has two. The seat's account is what the gate, the readings, the reports and the
// status table key on; a seat that names none spends its vendor.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, budgetsInForce, watchInForce } from '../src/approve/approval.ts';
import { standingSource } from '../src/commands/status.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { seatBudget } from '../src/budgets/gate.ts';
import { loadReadings, type Seen } from '../src/budgets/readings.ts';
import { budgetTable } from '../src/budgets/table.ts';
import { runApprove } from '../src/approve/command.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, updateState, type SessionState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, pass } from '../src/watch/pass.ts';
import { testIo } from './helpers.ts';

const NOW = Date.parse('2026-10-04T09:00:00Z');

// Two seats of one vendor on two accounts, and a coordinator that names none: its account is its
// vendor.
const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: codex-work
    label: codex-work
    cli: codex
    vendor: openai
    account: openai-work
    model: GPT Sol
    version: "6"
    launch: codex
  - role: implementer
    name: codex-home
    label: codex-home
    cli: codex
    vendor: openai
    account: openai-home
    model: GPT Sol
    version: "6"
    launch: codex
budgets:
  accounts:
    anthropic: { kind: subscription, reserve: 20%, sources: [status_line] }
    openai-work: { kind: subscription, reserve: 10%, sources: [status_line] }
    openai-home: { kind: subscription, reserve: 10%, sources: [status_line] }
`;

// The same file with a vendor-named account the two seats must not share.
const WITH_VENDOR = TEAM.replace(
  '    openai-work: { kind: subscription, reserve: 10%, sources: [status_line] }',
  '    openai: { kind: subscription, reserve: 50%, sources: [status_line] }\n    openai-work: { kind: subscription, reserve: 10%, sources: [status_line] }',
);

function team(text: string = TEAM): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function errors(text: string): { line: number; message: string }[] {
  const result = validateTeamFile(text);
  if (result.ok) throw new Error('the file validated, and the test wanted it refused');
  return result.errors;
}

function lineOf(text: string, needle: string): number {
  const index = text.split('\n').findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`no line with "${needle}"`);
  return index + 1;
}

function seatOf(name: string, text: string = TEAM) {
  const seat = team(text).seats.find((one) => one.name === name);
  if (!seat) throw new Error(`no seat ${name}`);
  return seat;
}

function reading(account: string, left: number): Seen {
  return {
    account,
    window: 'weekly',
    left,
    used: 100 - left,
    changedAt: NOW - 60_000,
    resetsAt: NOW + 3_600_000,
    seat: account,
    source: 'status_line',
    confirmed: true,
  };
}

// A live team of exactly the seats given, each in a workspace of its own with its own screen.
function live(screens: Record<string, string>): Live {
  const agents: HerdrAgent[] = [];
  const panes: Record<string, string> = {};
  let n = 0;
  for (const [name, screen] of Object.entries(screens)) {
    const workspace = `w${n++}`;
    agents.push({ name, agent: name.startsWith('codex') ? 'codex' : 'claude', pane: `${workspace}:p1`, workspace, status: 'working', cwd: null });
    panes[`${workspace}:p1`] = screen;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens: panes };
}

const CODEX = (left: number) => `• Working (2m 10s • esc to interrupt)\n\n  GPT-5.6-Terra medium · Context 98% left · weekly ${left}% left\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

describe('an account on a seat (§ 3b)', () => {
  test('the file reads each seat\'s own account, and leaves it unwritten where there is none', () => {
    expect(seatOf('codex-work').account).toBe('openai-work');
    expect(seatOf('codex-home').account).toBe('openai-home');
    // Absent, not the vendor: the default is applied where the account is read, never in the file.
    expect(Object.hasOwn(seatOf('lead'), 'account')).toBe(false);
  });

  test('an account is the owner\'s: it is part of the seat\'s fingerprint', () => {
    const without = TEAM.replace('    account: openai-work\n', '').replace('    account: openai-home\n', '');
    const before = fingerprints(team(without));
    const after = fingerprints(team());
    expect(before.seats['codex-work']).not.toBe(after.seats['codex-work']);
    expect(before.seats['lead']).toBe(after.seats['lead']);
    expect(after.seats['codex-work']).not.toBe(after.seats['codex-home']);
  });

  test('the gate measures each seat against its own account, not the vendor they share', () => {
    const budgets = team().budgets;
    const work = seatOf('codex-work');
    const home = seatOf('codex-home');
    expect(seatBudget(budgets, [reading('openai-work', 5), reading('openai-home', 80)], work, NOW)).toEqual({
      kind: 'refuse',
      why: 'openai-work weekly left 5%, inside its 10% reserve, changed 1m ago; accounts with room: openai-home',
    });
    // The other seat of the vendor keeps its own account: room here, and unknown with no reading.
    expect(seatBudget(budgets, [reading('openai-work', 5), reading('openai-home', 80)], home, NOW)).toEqual({ kind: 'clear' });
    expect(seatBudget(budgets, [reading('openai-work', 5)], home, NOW))
      .toEqual({ kind: 'unknown', account: 'openai-home', text: 'openai-home is unknown' });
  });

  test('a reading under the vendor\'s name is not a reading for the seat on an account', () => {
    const budgets = team(WITH_VENDOR).budgets;
    const work = seatOf('codex-work', WITH_VENDOR);
    expect(seatBudget(budgets, [reading('openai', 1)], work, NOW))
      .toEqual({ kind: 'unknown', account: 'openai-work', text: 'openai-work is unknown' });
    expect(seatBudget(budgets, [reading('openai', 1), reading('openai-work', 80)], work, NOW)).toEqual({ kind: 'clear' });
  });

  test('the default: a seat that names no account reads its vendor\'s', () => {
    const budgets = team().budgets;
    const lead = seatOf('lead');
    expect(seatBudget(budgets, [reading('anthropic', 5)], lead, NOW)).toEqual({
      kind: 'refuse',
      why: 'anthropic weekly left 5%, inside its 20% reserve, changed 1m ago; accounts with room: none',
    });
    expect(seatBudget(budgets, [reading('openai-work', 80)], lead, NOW))
      .toEqual({ kind: 'unknown', account: 'anthropic', text: 'anthropic is unknown' });
  });
});

describe('an account the budgets don\'t hold (§ 3b)', () => {
  test('a seat\'s account must be a key of budgets.accounts', () => {
    // A typo used to validate with no warning: the seat silently left every budget, and the gate
    // read it as a vendor nobody had budgeted. Clear is right for a vendor nobody budgeted; a
    // seat that names an account the file doesn't hold is a mistake, and is refused where it is.
    const typo = TEAM.replace('    account: openai-work\n', '    account: opanai\n');
    expect(errors(typo)).toEqual([
      { line: lineOf(typo, 'account: opanai'), message: 'seat "codex-work": account "opanai" is not in budgets.accounts' },
    ]);
  });

  test('a file with no budgets section and a seat naming an account is the same error', () => {
    const noBudgets = TEAM.slice(0, TEAM.indexOf('budgets:'));
    expect(errors(noBudgets)).toEqual([
      { line: lineOf(noBudgets, 'account: openai-work'), message: 'seat "codex-work": account "openai-work" is not in budgets.accounts' },
      { line: lineOf(noBudgets, 'account: openai-home'), message: 'seat "codex-home": account "openai-home" is not in budgets.accounts' },
    ]);
  });

  test('a vendor nobody budgeted is not an account to name', () => {
    // The seats that name no account keep their vendor, budgeted or not: only an explicit
    // `account:` must be one the budgets hold.
    const noAnthropic = TEAM.replace('    anthropic: { kind: subscription, reserve: 20%, sources: [status_line] }\n', '');
    expect(validateTeamFile(noAnthropic).ok).toBe(true);
  });
});

describe('the watch reads a seat\'s figures onto its own account', () => {
  test('a screen figure is kept under the seat\'s account, and the status table shows both rows', () => {
    const result = pass({
      team: team(),
      watch: team().watch,
      state: emptySession(),
      live: live({ 'codex-work': CODEX(39), 'codex-home': CODEX(20) }),
      machine: fine,
      now: NOW,
      memory: newMemory(),
      approval: [],
      foreground: { 'w0:p1': ['codex'], 'w1:p1': ['codex'] },
    });
    expect(result.readings.map(({ account, seat, left }) => ({ account, seat, left }))).toEqual([
      { account: 'openai-work', seat: 'codex-work', left: 39 },
      { account: 'openai-home', seat: 'codex-home', left: 20 },
    ]);
    expect(budgetTable(team().budgets, result.readings, NOW).map((row) => [row.account, row.window, row.seat, row.left])).toEqual([
      ['anthropic', null, null, null],
      ['openai-home', 'weekly', 'codex-home', 20],
      ['openai-work', 'weekly', 'codex-work', 39],
    ]);
  });

  test('the unknown report names the seats on the account, not the vendor\'s others', () => {
    const result = pass({
      team: team(),
      watch: team().watch,
      state: emptySession(),
      live: live({ 'codex-work': CODEX(39), 'codex-home': 'Welcome to Codex\n' }),
      machine: fine,
      now: NOW,
      memory: newMemory(),
      approval: [],
      foreground: { 'w0:p1': ['codex'], 'w1:p1': ['codex'] },
    });
    expect(result.reports.filter((report) => report.key.startsWith('budget:')).map((report) => report.text))
      .toEqual(['openai-home is unknown while codex-home runs on it']);
  });

  test('a temporary seat is read as the seat it is like: its account too', () => {
    const state: SessionState = emptySession();
    state.seats['codex-temp'] = { stage: 'ready', temporary: { like: 'codex-work', until: 'result:briefs/x.result.md' } };
    const result = pass({
      team: team(),
      watch: team().watch,
      state,
      live: live({ 'codex-work': CODEX(39), 'codex-temp': CODEX(12) }),
      machine: fine,
      now: NOW,
      memory: newMemory(),
      approval: [],
      foreground: { 'w0:p1': ['codex'], 'w1:p1': ['codex'] },
    });
    expect(result.readings.map(({ account, seat, left }) => ({ account, seat, left }))).toEqual([
      { account: 'openai-work', seat: 'codex-work', left: 39 },
      { account: 'openai-work', seat: 'codex-temp', left: 12 },
    ]);
  });
});

// A seat the owner has not approved is drift: the watch reports the difference, and the figures
// off that seat's screen are read as they are — but none of them is folded into the readings. An
// unapproved edit to a seat's `account:` must not move its figure into another account's bucket,
// where `up` and `add` would count it. The owner approves, and the folds resume.
describe('a seat the approval lists as changed', () => {
  let base: string;
  let root: string;
  let home: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'team-seat-account-')));
    root = join(base, 'acme');
    home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const write = (text: string) => writeFileSync(join(root, '.agents/team.yaml'), text);

  async function approve(): Promise<number> {
    return runApprove(['--file', '.agents/team.yaml'], testIo(root, { kind: 'owner' }), {
      ask: async () => String(team().seats.length),
      waiting: () => 'empty',
      now: () => new Date(NOW),
      home,
    });
  }

  function watchSources(screens: Record<string, string>): WatchSources {
    let left = 1;
    return {
      live: () => live(screens),
      machine: () => fine,
      standing: standingSource(home),
      readChecks: () => [],
      screen: () => '',
      foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
      status: () => 'idle',
      typeText: () => false,
      pressEnter: () => false,
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(NOW),
      wait: async () => --left > 0,
      alive: () => false,
      pid: 4242,
    };
  }

  test('its figure is folded under the live file\'s account, with no drift line', async () => {
    write(TEAM);
    expect(await approve()).toBe(0);
    const edited = TEAM.replace('    account: openai-work\n', '    account: openai-home\n');
    write(edited);
    expect(approvalDifferences(team(edited), root, home)).toEqual(['seat codex-work changed']);

    const scene = { 'codex-work': CODEX(39), 'codex-home': CODEX(20) };
    const io = testIo(root, { kind: 'owner' });
    expect(await runWatch(['--file', '.agents/team.yaml'], io, watchSources(scene))).toBe(0);
    expect(io.out).not.toContain('seat codex-work changed');
    expect(loadReadings(join(root, '.agents')).map(({ account, seat, left }) => ({ account, seat, left })))
      .toEqual([
        { account: 'openai-home', seat: 'codex-work', left: 39 },
        { account: 'openai-home', seat: 'codex-home', left: 20 },
      ]);
  });

  test('a temporary seat like a changed seat folds under the live file\'s account', async () => {
    write(TEAM);
    expect(await approve()).toBe(0);

    updateState(join(root, '.agents'), (state) => {
      const session = (state.sessions['acme'] ??= emptySession());
      session.seats['codex-temp'] = {
        stage: 'ready',
        temporary: { like: 'codex-work', until: 'result:briefs/x.result.md' },
      };
    });

    const edited = TEAM.replace('    account: openai-work\n', '    account: openai-home\n');
    write(edited);
    expect(approvalDifferences(team(edited), root, home)).toEqual(['seat codex-work changed']);

    const scene = { 'codex-temp': CODEX(12) };
    const io = testIo(root, { kind: 'owner' });
    expect(await runWatch(['--file', '.agents/team.yaml'], io, watchSources(scene))).toBe(0);
    expect(loadReadings(join(root, '.agents')).map(({ account, seat, left }) => ({ account, seat, left })))
      .toEqual([{ account: 'openai-home', seat: 'codex-temp', left: 12 }]);
  });

  test('a temporary seat whose like-seat is not in drift still folds figures', async () => {
    write(TEAM);
    expect(await approve()).toBe(0);

    updateState(join(root, '.agents'), (state) => {
      const session = (state.sessions['acme'] ??= emptySession());
      session.seats['codex-temp-home'] = {
        stage: 'ready',
        temporary: { like: 'codex-home', until: 'result:briefs/x.result.md' },
      };
    });

    // Edit codex-work (not codex-home)
    const edited = TEAM.replace('    account: openai-work\n', '    account: openai-home\n');
    write(edited);
    expect(approvalDifferences(team(edited), root, home)).toEqual(['seat codex-work changed']);

    const scene = { 'codex-temp-home': CODEX(25) };
    const io = testIo(root, { kind: 'owner' });
    expect(await runWatch(['--file', '.agents/team.yaml'], io, watchSources(scene))).toBe(0);

    // codex-temp-home's like-seat (codex-home) is not in drift, so its figure folds normally
    expect(loadReadings(join(root, '.agents')).map(({ account, seat, left }) => ({ account, seat, left })))
      .toEqual([{ account: 'openai-home', seat: 'codex-temp-home', left: 25 }]);
  });

  test('a temporary seat like a seat removed from the file folds no figure', () => {
    const state = emptySession();
    state.seats['temp-orphan'] = {
      stage: 'ready',
      temporary: { like: 'vanished-seat', until: 'result:briefs/x.result.md' },
    };
    const result = pass({
      team: team(),
      watch: team().watch,
      state,
      live: live({ 'temp-orphan': CODEX(15) }),
      machine: fine,
      now: NOW,
      memory: newMemory(),
      approval: [],
      foreground: { 'w0:p1': ['codex'] },
    });
    // Vanished like-seat leaves cli and account empty, so no quota figure is extracted or folded
    expect(result.readings).toEqual([]);
  });

  test('the reports of the pass are unchanged apart from the fold', () => {
    const memory = newMemory();
    const state = emptySession();
    state.seats['codex-temp'] = {
      stage: 'ready',
      temporary: { like: 'codex-work', until: 'result:briefs/x.result.md' },
    };
    const result = pass({
      team: team(),
      watch: team().watch,
      state,
      live: live({ 'codex-temp': CODEX(12) }),
      machine: fine,
      now: NOW,
      memory,
      approval: ['seat codex-work changed'],
      foreground: { 'w0:p1': ['codex'] },
    });

    // A difference in the record is handed in and says nothing: the live file is the record,
    // and the temporary seat's own fold is not a report either.
    expect(result.reports.find((r) => r.key === 'approval')?.text).toBeUndefined();
    // The live like-seat still supplies the temporary seat's account and profile.
    expect(result.readings).toEqual([expect.objectContaining({
      account: 'openai-work', seat: 'codex-temp', left: 12, used: 88, window: 'weekly',
    })]);
  });
});
