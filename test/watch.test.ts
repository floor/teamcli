import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { loadReadings, loadSpendReadings, saveReadings, type Seen } from '../src/budgets/readings.ts';
import { runStatus } from '../src/commands/status.ts';
import { plantMessage, receiptFile, type MessagePayload } from '../src/commands/messages.ts';
import { messageKeyOf, RECEIPT_DOMAIN, signDomain, type Json } from '../src/store/keys.ts';
import { runWatch, USAGE } from '../src/commands/watch.ts';
import { readTriggerLine } from '../src/send/native.ts';
import { findRoot } from '../src/file/load.ts';
import type { WatchSources } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { launchLimit, parseLoadavg, parseMeminfo, parseMemoryPressure, parsePsiMemory, parseSwapUsage, parseVmPressureLevel, readMachine, readingsText, swapTotalProblem } from '../src/watch/machine.ts';
import type { Machine } from '../src/watch/machine.ts';
import { watchLabel } from '../src/watch/pane.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { newMemory, NUDGE_TEXT, pass } from '../src/watch/pass.ts';
import { readScreen } from '../src/watch/screen.ts';
import { agyMismatchedFrame, claudeBox, injectWas, testIo, wordWrap } from './helpers.ts';
import { assertJsonErrorShape } from './helpers/output.ts';

// The ring line is the receiver's own: this fixture's team session is `acme-web`, each scene's
// seat is the one its record names, and the waiting record's sender is the planted `harness`.
const ringFor = (seat: string): string => readTriggerLine(seat, 'acme-web', {
  seat: 'harness',
  team: 'acme-web',
  body: 'the message body itself',
}) as string;
const RING_TEXT = ringFor('deepseek-acme');

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8')
  .replace('operator: claude-coordinator-acme', 'operator: claude-operator-acme')
  .replace('seats:\n', `seats:
  - role: operator
    name: claude-operator-acme
    label: claude-operator-acme
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
`).replace('  seats: 6', '  seats: 8');

// The example's operator as an Antigravity seat: the watch's nudge path then reads the
// operator's box through the two-rules reader.
const agyOperator = example.replace(
  `  - role: operator
    name: claude-operator-acme
    label: claude-operator-acme
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`,
  `  - role: operator
    name: claude-operator-acme
    label: claude-operator-acme
    cli: antigravity
    vendor: google
    model: Gemini Flash
    version: "3.8"
    launch: agy`,
);

// The example's operator as a Cursor seat: the watch's nudge path then reads the operator's
// box through the status-then-one reader.
const cursorOperator = example.replace(
  `  - role: operator
    name: claude-operator-acme
    label: claude-operator-acme
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`,
  `  - role: operator
    name: claude-operator-acme
    label: claude-operator-acme
    cli: cursor
    vendor: xai
    model: Grok
    version: "4.7"
    launch: cursor-agent`,
);

function team(): TeamFile {
  const result = validateTeamFile(example);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

// The example with budget accounts, where a real file writes them: under `budgets`.
const MARKS = '  marks: [50, 75, 90]          # percent used, per account and window';

function withAccounts(accounts: string): string {
  return example.replace(MARKS, `${MARKS}\n${accounts}`);
}

// The example with codex-acme stopped instead of parked — a stopped seat whose screen the watch
// can read. (The example's own stopped seat, grok-acme, was a CLI with no screens at all to read
// before the grok profile shipped; the captures these tests read are codex's either way.)
function stoppedTeam(): TeamFile {
  const result = validateTeamFile(example.replace('parked: true', 'stopped: true'));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

// Screens of Claude Code, as the live team shows them.
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const suggestion = `${RULE}\n❯ Try "fix the failing test"\n${RULE}\n${STATUS}\n`;
const unsent = `${RULE}\n❯ Brief: take the next task from the queue\n${RULE}\n${STATUS}\n`;
const permission = `Bash command\n\n  chmod +x run.sh\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently\n\nEsc to cancel · Tab to amend\n`;
const question = `Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`;
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;

describe('reading a screen of Claude Code', () => {
  test('an empty idle prompt, with or without a greyed suggestion', () => {
    expect(readScreen('claude-code', idle).kind).toBe('idle');
    expect(readScreen('claude-code', suggestion).kind).toBe('idle');
  });
  test('text left in the input box', () => {
    expect(readScreen('claude-code', unsent).kind).toBe('unsent');
  });
  test('a permission prompt is told apart from a question', () => {
    expect(readScreen('claude-code', permission).kind).toBe('permission');
    const quotedPermission = `The last answer asks: Do you want to proceed?\n1. Yes, if the tests pass\n2. No\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
    expect(readScreen('claude-code', quotedPermission).kind).toBe('idle');
    const agyPermission = readFileSync(new URL('./fixtures/antigravity/1.2.16/permission.txt', import.meta.url), 'utf8');
    expect(readScreen('antigravity', agyPermission).kind).toBe('permission');
    expect(readScreen('claude-code', `Do you trust this folder?\n❯ 1. Yes, proceed\n  2. No, exit\n\nEnter to confirm · Esc to cancel`).kind).toBe('trust');
    const liveTrust = [
      'Accessing workspace:',
      'Quick safety check: Is this a project you created or one you trust?',
      'Claude Code will be able to read, edit, and execute files here.',
      '❯ 1. Yes, I trust this folder',
      '  2. No, exit',
    ].join('\n');
    expect(readScreen('claude-code', liveTrust).kind).toBe('trust');
    const quoted = `The note says to trust this folder before you start.\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
    expect(readScreen('claude-code', quoted).kind).toBe('idle');
    expect(readScreen('claude-code', question).kind).toBe('question');
  });
  test('text on a later line of the box, under an empty first line, is unsent text', () => {
    expect(readScreen('claude-code', `${RULE}\n❯ \n  and a second line\n${RULE}\n${STATUS}\n`).kind).toBe('unsent');
    expect(readScreen('claude-code', `${RULE}\n❯ \n\n${RULE}\n${STATUS}\n`).kind).toBe('idle');
  });
  test('anything else is unknown: a screen without a prompt, no screen, another CLI', () => {
    expect(readScreen('claude-code', 'Welcome back!\n\nUpdate available: run claude update\n').kind).toBe('unknown');
    expect(readScreen('claude-code', undefined).kind).toBe('unknown');
    expect(readScreen('codex', idle).kind).toBe('unknown');
  });
  test('a running turn is working, not an empty idle box; a finished one is idle again', () => {
    expect(readScreen('claude-code', busy).kind).toBe('working');
    expect(readScreen('claude-code', `${RULE}\n❯ \n${RULE}\n  main · Opus 5.5 · esc to interrupt\n`).kind).toBe('working');
    const finished = `✻ Churned for 51s · done 9:51 PM\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
    expect(readScreen('claude-code', finished).kind).toBe('idle');
  });
});

describe('the machine\'s figures', () => {
  test('macOS swap usage', () => {
    expect(parseSwapUsage('total = 25600.00M  used = 23981.81M  free = 1618.19M  (encrypted)')).toEqual({
      total: 25600 * 1024 ** 2, used: 23981.81 * 1024 ** 2, free: 1618.19 * 1024 ** 2,
    });
    expect(parseSwapUsage('nonsense')).toBeNull();
  });
  test('macOS memory pressure', () => {
    expect(parseMemoryPressure('…\nSystem-wide memory free percentage: 49%\n')).toBe(49);
    expect(parseMemoryPressure('')).toBeNull();
  });
  test('macOS memory pressure level', () => {
    expect(parseVmPressureLevel('1\n')).toBe('normal');
    expect(parseVmPressureLevel('2\n')).toBe('warn');
    expect(parseVmPressureLevel('4\n')).toBe('critical');
    // A value this code doesn't know is unread, never normal.
    expect(parseVmPressureLevel('3\n')).toBeNull();
    expect(parseVmPressureLevel('critical\n')).toBeNull();
    expect(parseVmPressureLevel('')).toBeNull();
  });
  test('Linux meminfo, with and without swap', () => {
    const info = 'MemTotal:       16000000 kB\nMemAvailable:    4000000 kB\nSwapTotal:       2000000 kB\nSwapFree:         500000 kB\n';
    expect(parseMeminfo(info)).toEqual({ memoryFree: 25, swapTotal: 2000000 * 1024, swapFree: 500000 * 1024, swapUsed: 1500000 * 1024 });
    expect(parseMeminfo('MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n')).toEqual({ memoryFree: 50, swapTotal: null, swapFree: null, swapUsed: null });
  });
  test('Linux load average, from /proc/loadavg', () => {
    expect(parseLoadavg('0.52 0.58 0.59 1/1234 5678')).toBe(0.52);
    expect(parseLoadavg('12.00 9.50 8.25 3/999 4242')).toBe(12);
    expect(parseLoadavg('')).toBeNull();
    expect(parseLoadavg('load average: 1.00')).toBeNull();
  });
  test('Linux PSI memory pressure, on the same three levels', () => {
    const psi = (avg10: string) => `some avg10=${avg10} avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;
    expect(parsePsiMemory(psi('0.00'))).toBe('normal');
    expect(parsePsiMemory(psi('9.99'))).toBe('normal');
    expect(parsePsiMemory(psi('10.00'))).toBe('warn');
    expect(parsePsiMemory(psi('49.99'))).toBe('warn');
    expect(parsePsiMemory(psi('50.00'))).toBe('critical');
    expect(parsePsiMemory(psi('100.00'))).toBe('critical');
    // No readable `some` line is unread, never normal: a kernel without PSI has no file at all.
    expect(parsePsiMemory('full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')).toBeNull();
    expect(parsePsiMemory('some avg10=x avg60=0.00')).toBeNull();
    expect(parsePsiMemory('')).toBeNull();
  });

  test('Linux: memory, swap, load and pressure read from a captured /proc, not from macOS commands', () => {
    // A 16 GB machine halfway through its memory, 2 GB of swap with 1.5 GB of it used, load 0.52,
    // and PSI `some avg10=12.34`: a warning level.
    const machine = readMachine(process.cwd(), 'linux', new URL('./fixtures/linux/proc', import.meta.url).pathname);
    expect(machine.memoryFree).toBe(50);
    expect(machine.swapTotal).toBe(2 * 1024 ** 3);
    expect(machine.swapFree).toBe(512 * 1024 ** 2);
    expect(machine.swapUsed).toBe(1536 * 1024 ** 2);
    expect(machine.loadPerCore).toBeCloseTo(0.52 / cpus().length, 10);
    expect(machine.pressure).toBe('warn');
  });

  test('this machine: every figure it can read is a number, and its level is a known one', () => {
    const machine = readMachine(process.cwd());
    expect(machine.loadPerCore).toBeGreaterThanOrEqual(0);
    expect(machine.diskFree).toBeGreaterThan(0);
    const { pressure, ...figures } = machine;
    for (const value of Object.values(figures)) expect(value === null || Number.isFinite(value)).toBe(true);
    expect(pressure === null || pressure === 'normal' || pressure === 'warn' || pressure === 'critical').toBe(true);
  });

  test('the swap total the check can never meet', () => {
    const limits: TeamFile['machine'] = {
      loadStart: 3, loadMax: 6, memoryStart: 25, memoryMin: 15, diskMin: 10e9,
      swapFreeMin: 2e9, swapGrowthMax: 1e9, swapGrowthWindow: 600,
    };
    const small: Machine = { loadPerCore: 0.4, memoryFree: 62, diskFree: 120e9, swapTotal: 1e9, swapFree: 0.5e9, swapUsed: 0.5e9 };
    expect(swapTotalProblem(small, limits)).toBe(
      'the machine check asks for 2.0 GB free swap; at this reading the machine has 1.0 GB in total, so this reading cannot meet it; set `machine.swap_free_min` to a figure this machine can keep',
    );
    // The check can pass in principle — its floor sits under the machine's total — and the free
    // figure is low right now: the watch's finding, and nothing here.
    expect(swapTotalProblem({ ...small, swapTotal: 16e9, swapFree: 0.5e9 }, limits)).toBeNull();
    // Exactly the total the check asks for is meetable.
    expect(swapTotalProblem({ ...small, swapTotal: 2e9 }, limits)).toBeNull();
    // A figure that wasn't read is neither fine nor bad: a machine with no swap at all leaves
    // both null, and neither this warning nor `launchLimit` can fire there.
    expect(swapTotalProblem({ ...small, swapTotal: null, swapFree: null }, limits)).toBeNull();
    expect(swapTotalProblem({ ...small, swapFree: null }, limits)).toBeNull();
  });

  test('the launch gate: critical pressure refuses, free swap alone never does', () => {
    const limits: TeamFile['machine'] = {
      loadStart: 3, loadMax: 6, memoryStart: 25, memoryMin: 15, diskMin: 10e9,
      swapFreeMin: 2e9, swapGrowthMax: 1e9, swapGrowthWindow: 600,
    };
    // The host this slice was measured on: 49% of physical memory free, the OS level normal, and
    // 0.99 GB of a 15.36 GB swap free — under the 2 GB the file asks, and still no refusal.
    const host: Machine = { loadPerCore: 0.4, memoryFree: 49, diskFree: 120e9, swapTotal: 15.36e9, swapFree: 0.99e9, swapUsed: 14.37e9, pressure: 'normal' };
    const now = Date.parse('2026-10-20T09:00:00Z');
    expect(launchLimit(host, limits, [], now)).toBeNull();
    // A warning level does not refuse either.
    expect(launchLimit({ ...host, pressure: 'warn' }, limits, [], now)).toBeNull();
    // A critical level does, whatever the figures say.
    expect(launchLimit({ ...host, pressure: 'critical' }, limits, [], now)).toBe('memory pressure is critical');
    // A level that wasn't read is neither fine nor bad: the other limits still decide.
    expect(launchLimit({ ...host, pressure: null }, limits, [], now)).toBeNull();
    const older: Machine = { loadPerCore: 0.4, memoryFree: 49, diskFree: 120e9, swapTotal: 15.36e9, swapFree: 0.99e9, swapUsed: 14.37e9 };
    expect(launchLimit(older, limits, [], now)).toBeNull();
    // Physical free memory is its own limit, independent of the level.
    expect(launchLimit({ ...host, memoryFree: 10 }, limits, [], now)).toBe('free memory is 10%, below 25%');
    expect(launchLimit({ ...host, memoryFree: 10, pressure: 'critical' }, limits, [], now)).toBe('free memory is 10%, below 25%');
    // The swap-growth guard is kept.
    expect(launchLimit({ ...host, swapUsed: 15e9, swapFree: 0.36e9 }, limits, [{ at: now - 60_000, used: 13e9 }], now))
      .toBe('swap grew by 2.0 GB in 10 minutes, above 1.0 GB');
  });

  test('the readings as one sentence, in the log\'s fixed order, in the bytes the gate compared', () => {
    expect(readingsText({ loadPerCore: 1, memoryFree: 69, diskFree: 200e9, swapTotal: 8.2e9, swapFree: 1.2e9, swapUsed: 7e9, pressure: 'normal' }))
      .toBe('load 1.0/core, memory 69%, disk 200000000000 B free, pressure normal, swap used 7000000000 B of 8200000000 B (free 1200000000 B)');
    // The watch spelling: the disk figure and the pressure level no moment recorded, the rest
    // from a reading taken.
    expect(readingsText({ loadPerCore: 0.7, memoryFree: 69, diskFree: null, swapTotal: 8.2e9, swapFree: 1.2e9, swapUsed: 6.9e9 }))
      .toBe('load 0.7/core, memory 69%, disk unread, pressure unread, swap used 6900000000 B of 8200000000 B (free 1200000000 B)');
    // Not a rounding of the bytes: a figure the gate compared byte for byte prints byte for byte,
    // so a later launch parsing the newest line's swap figures reads the figure it compared.
    expect(readingsText({ loadPerCore: 0.5, memoryFree: 68, diskFree: 199_999_999_999, swapTotal: 8_192_620_000, swapFree: 1_314_750_000, swapUsed: 6_877_870_000, pressure: 'critical' }))
      .toBe('load 0.5/core, memory 68%, disk 199999999999 B free, pressure critical, swap used 6877870000 B of 8192620000 B (free 1314750000 B)');
  });
  test('a figure that wasn\'t read prints unread, never a guessed number', () => {
    const none: Machine = { loadPerCore: null, memoryFree: null, diskFree: null, swapTotal: null, swapFree: null, swapUsed: null, pressure: null };
    expect(readingsText(none)).toBe('load unread, memory unread, disk unread, pressure unread, swap unread');
    // One of the three swap figures missing makes the whole swap reading unread.
    expect(readingsText({ ...none, swapUsed: 6.9e9 })).toBe('load unread, memory unread, disk unread, pressure unread, swap unread');
    expect(readingsText({ ...none, swapTotal: 8.2e9, swapFree: 1.2e9, swapUsed: null })).toBe('load unread, memory unread, disk unread, pressure unread, swap unread');
    // An older reading object that omits the level is unread too, never normal.
    const older: Machine = { loadPerCore: null, memoryFree: null, diskFree: null, swapTotal: null, swapFree: null, swapUsed: null };
    expect(readingsText(older)).toBe('load unread, memory unread, disk unread, pressure unread, swap unread');
  });
});

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const MIN = 60_000;

function agent(name: string | null, workspace: string, status: string, kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The example's team, everyone working, the operator at an empty prompt.
function live(over: Partial<Record<string, { status?: string; screen?: string }>> = {}): Live {
  const seats: [string, string, string, string][] = [
    ['claude-operator-acme', 'w0', 'idle', idle],
    ['claude-coordinator-acme', 'w1', 'working', busy],
    ['codex-acme', 'w2', 'working', ''],
    ['deepseek-acme', 'w3', 'working', busy],
    ['deepseek-acme-2', 'w4', 'working', busy],
  ];
  const agents: HerdrAgent[] = [];
  const screens: Record<string, string> = {};
  for (const [name, workspace, status, screen] of seats) {
    const change = over[name] ?? {};
    agents.push(agent(name, workspace, change.status ?? status, name.startsWith('codex') ? 'codex' : 'claude'));
    screens[`${workspace}:p1`] = change.screen ?? screen;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

describe('a pass of the watch', () => {
  test('a working team reports nothing', () => {
    const { labels, ...rest } = pass({
      team: team(), watch: team().watch, state: emptySession(), live: live(), machine: fine, now: 0, memory: newMemory(),
    });
    expect(rest).toEqual({ reports: [], work: [], ring: null, mailboxNote: null, readings: [], machineReadings: [], refusals: [] });
    expect(labels.length).toBe(5);
  });

  test('an idle seat is reported after idle_first, to the owner after idle_owner, and again every idle_repeat', () => {
    const memory = newMemory();
    const quiet = live({ 'deepseek-acme': { status: 'done', screen: idle } });
    const at = (minute: number) => pass({ team: team(), watch: team().watch, state: emptySession(), live: quiet, machine: fine, now: minute * MIN, memory }).reports.map((report) => report.text);
    expect(at(0)).toEqual([]);
    expect(at(4)).toEqual([]);
    // Never seen working: the report says so instead of inventing a duration.
    expect(at(5)).toEqual(['deepseek-acme has been idle since the watch started']);
    expect(at(12)).toEqual([]);
    // The owner hears once per idle period, at idle_owner.
    expect(at(15)).toEqual(['deepseek-acme has been idle since the watch started — reported to the owner']);
    expect(at(24)).toEqual([]);
    // Every idle_repeat after the lead's own report, the lead hears again.
    expect(at(25)).toEqual(['deepseek-acme has been idle since the watch started']);
    expect(at(45)).toEqual(['deepseek-acme has been idle since the watch started']);
  });

  test('work resets the idle timer', () => {
    const memory = newMemory();
    const quiet = live({ 'deepseek-acme': { status: 'idle', screen: idle } });
    pass({ team: team(), watch: team().watch, state: emptySession(), live: quiet, machine: fine, now: 0, memory });
    pass({ team: team(), watch: team().watch, state: emptySession(), live: live(), machine: fine, now: 9 * MIN, memory });
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: quiet, machine: fine, now: 10 * MIN, memory }).reports).toEqual([]);
  });

  test('a parked seat idle for an hour is not reported idle, while its unparked neighbour is', () => {
    const memory = newMemory();
    const quiet = live({ 'codex-acme': { status: 'idle' }, 'deepseek-acme': { status: 'idle', screen: idle } });
    // The parked seat's screen is one nothing reads, and the fail-safe reports that — once. Its
    // idleness is still nobody's report: the shelf is not a stall.
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: quiet, machine: fine, now: 0, memory }).reports.map((report) => report.text))
      .toEqual(['codex-acme: herdr reports the status "idle"']);
    // Ten minutes in, the unparked seat's report lands: the shelf works, the parked seat's idle is
    // off it.
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: quiet, machine: fine, now: 10 * MIN, memory }).reports.map((report) => report.text))
      .toEqual(['deepseek-acme has been idle since the watch started']);
    // An hour in, the neighbour's lead report repeats on the idle_repeat cadence and its owner
    // report lands; the parked seat's idle is still absent from every report.
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: quiet, machine: fine, now: 60 * MIN, memory }).reports.map((report) => report.text))
      .toEqual([
        'deepseek-acme has been idle since the watch started',
        'deepseek-acme has been idle since the watch started — reported to the owner',
      ]);
  });

  test('a parked seat that holds unsent text is reported, after unsent_after', () => {
    const memory = newMemory();
    // The captured screen names Terra; the file's codex-acme is GPT Sol 6. Read as the seat's own
    // id, the screen is here for its unsent composer alone, with no model drift of its own.
    const screen = readFileSync(new URL('./fixtures/codex/0.157.0/unsent.txt', import.meta.url), 'utf8')
      .replaceAll('GPT-5.6-Terra', 'GPT-6-Sol');
    const holding = live({ 'codex-acme': { status: 'idle', screen } });
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: holding, machine: fine, now: 0, memory }).reports).toEqual([]);
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: holding, machine: fine, now: MIN, memory }).reports.map((report) => report.text))
      .toEqual(['codex-acme holds text in its input box that was never sent']);
  });

  test('the checks read the watch values in force, not the file\'s', () => {
    const memory = newMemory();
    const screen = readFileSync(new URL('./fixtures/codex/0.157.0/unsent.txt', import.meta.url), 'utf8')
      .replaceAll('GPT-5.6-Terra', 'GPT-6-Sol');
    const holding = live({ 'codex-acme': { status: 'idle', screen } });
    const file = team();
    // The file says unsent_after is a minute; the values in force say an hour — what the owner
    // approved, or the defaults — and the check waits for the hour.
    const inForce = { ...file.watch, unsentAfter: 60 * 60 };
    expect(pass({ team: file, state: emptySession(), live: holding, machine: fine, now: 0, memory, approval: [], watch: inForce }).reports).toEqual([]);
    expect(pass({ team: file, state: emptySession(), live: holding, machine: fine, now: 60 * MIN, memory, approval: [], watch: inForce }).reports.map((report) => report.text))
      .toEqual(['codex-acme holds text in its input box that was never sent']);
    // With the file's own values, the minute is enough.
    const own = newMemory();
    pass({ team: file, watch: file.watch, state: emptySession(), live: holding, machine: fine, now: 0, memory: own, approval: [] });
    expect(pass({ team: file, watch: file.watch, state: emptySession(), live: holding, machine: fine, now: MIN, memory: own, approval: [] }).reports.map((report) => report.text))
      .toEqual(['codex-acme holds text in its input box that was never sent']);
  });

  test('a parked seat runs the wrong model: model drift is reported too', () => {
    const screen = readFileSync(new URL('./fixtures/codex/0.157.0/working.txt', import.meta.url), 'utf8');
    const drift = live({ 'codex-acme': { status: 'working', screen } });
    const texts = pass({ team: team(), watch: team().watch, state: emptySession(), live: drift, machine: fine, now: 0, memory: newMemory() }).reports.map((report) => report.text);
    expect(texts).toEqual(['codex-acme runs GPT Terra 5.6; the registry says GPT Sol 6: it signs with the wrong model — team remove codex-acme --keep, then team add codex-acme']);
  });

  test('a stopped seat that runs is watched like a parked one: its permission prompt is reported', () => {
    const screen = readFileSync(new URL('./fixtures/codex/0.157.0/permission.txt', import.meta.url), 'utf8');
    const stuck = live({ 'codex-acme': { status: 'idle', screen } });
    expect(pass({ team: stoppedTeam(), watch: stoppedTeam().watch, state: emptySession(), live: stuck, machine: fine, now: 0, memory: newMemory() }).reports).toEqual([
      { key: 'blocked:codex-acme', text: "codex-acme waits at a permission prompt: its owner's to answer", to: 'owner' },
    ]);
  });

  test('a stopped seat that runs and holds unsent text is reported, after unsent_after', () => {
    const memory = newMemory();
    // The captured screen names Terra; the file's codex-acme is GPT Sol 6. Read as the seat's own
    // id, the screen is here for its unsent composer alone, with no model drift of its own.
    const screen = readFileSync(new URL('./fixtures/codex/0.157.0/unsent.txt', import.meta.url), 'utf8')
      .replaceAll('GPT-5.6-Terra', 'GPT-6-Sol');
    const holding = live({ 'codex-acme': { status: 'idle', screen } });
    expect(pass({ team: stoppedTeam(), watch: stoppedTeam().watch, state: emptySession(), live: holding, machine: fine, now: 0, memory }).reports).toEqual([]);
    expect(pass({ team: stoppedTeam(), watch: stoppedTeam().watch, state: emptySession(), live: holding, machine: fine, now: MIN, memory }).reports.map((report) => report.text))
      .toEqual(['codex-acme holds text in its input box that was never sent']);
  });

  test('a stopped seat that runs but stays idle is not reported idle', () => {
    const memory = newMemory();
    const quiet = live({ 'deepseek-acme': { status: 'idle', screen: idle } });
    quiet.agents.push(agent('grok-acme', 'w5', 'idle', 'grok'));
    quiet.workspaces.push({ id: 'w5', label: 'grok-acme' });
    // The pane carries no screen to read at all, and the fail-safe reports the running stopped
    // seat's screen as unreadable — once. Its idleness is still not a report: a stopped seat may
    // sit idle all day.
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: quiet, machine: fine, now: 0, memory }).reports.map((report) => report.text))
      .toEqual(['grok-acme: herdr reports the status "idle"']);
    // Ten minutes in, the unparked neighbour's report lands: the shelf works, the stopped seat is
    // off it.
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: quiet, machine: fine, now: 10 * MIN, memory }).reports.map((report) => report.text))
      .toEqual(['deepseek-acme has been idle since the watch started']);
    // An hour in, the neighbour's lead report repeats on the idle_repeat cadence and its owner
    // report lands; the stopped seat is still absent from every report.
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: quiet, machine: fine, now: 60 * MIN, memory }).reports.map((report) => report.text))
      .toEqual([
        'deepseek-acme has been idle since the watch started',
        'deepseek-acme has been idle since the watch started — reported to the owner',
      ]);
  });

  test('a permission prompt that herdr calls idle is the owner\'s, and is never an idle seat', () => {
    const memory = newMemory();
    const stuck = live({ 'deepseek-acme': { status: 'idle', screen: permission } });
    const first = pass({ team: team(), watch: team().watch, state: emptySession(), live: stuck, machine: fine, now: 0, memory });
    expect(first.reports).toEqual([{ key: 'blocked:deepseek-acme', text: 'deepseek-acme waits at a permission prompt: its owner\'s to answer', to: 'owner' }]);
    // The promise behind the report: a prompt nobody clears does not stay one line. The lead's
    // window runs out, and the climb is raised — once, and to the owner at once.
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: stuck, machine: fine, now: 30 * MIN, memory }).reports).toEqual([
      { key: 'prompt-escalated:deepseek-acme', text: "deepseek-acme is still at a permission prompt after 5 minutes: the team's lead has not cleared it, and the entity's lead and the owner are told", to: 'owner' },
    ]);
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: stuck, machine: fine, now: 60 * MIN, memory }).reports).toEqual([]);
  });

  test.each(['idle', 'working'])('a captured Codex permission goes to its owner when herdr says %s', (status) => {
    const screen = readFileSync(new URL('./fixtures/codex/0.157.0/permission.txt', import.meta.url), 'utf8');
    const memory = newMemory();
    const stuck = live({ 'codex-acme': { status, screen } });
    const first = pass({ team: team(), watch: team().watch, state: emptySession(), live: stuck, machine: fine, now: 0, memory });
    expect(first.reports).toEqual([{ key: 'blocked:codex-acme', text: "codex-acme waits at a permission prompt: its owner's to answer", to: 'owner' }]);
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: stuck, machine: fine, now: 30 * MIN, memory }).reports).toEqual([
      { key: 'prompt-escalated:codex-acme', text: "codex-acme is still at a permission prompt after 5 minutes: the team's lead has not cleared it, and the entity's lead and the owner are told", to: 'owner' },
    ]);
  });

  test('a quiet seat on a screen no profile reads is reported, not taken for a free one', () => {
    // The fail-safe: herdr says done, and no profile reads the screen. Before it this reported
    // nothing — the shape a stalled seat leaves, and the one that read as a free seat.
    const memory = newMemory();
    const stalled = live({ 'codex-acme': { status: 'done', screen: 'Some unknown output without composer\n' } });
    const first = pass({ team: team(), watch: team().watch, state: emptySession(), live: stalled, machine: fine, now: 0, memory });
    expect(first.reports).toEqual([{ key: 'unknown:codex-acme', text: 'codex-acme: herdr reports the status "done"', to: 'operator' }]);
    // No work drop is due yet, and the report is never typed anywhere.
    expect(first.work).toEqual([]);
    expect(first.ring).toBeNull();
    // Once: the same sight is not reported again.
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: stalled, machine: fine, now: 30 * MIN, memory }).reports).toEqual([]);
  });

  test.each(['idle', 'working'])('a captured Codex update screen is the vendor notice, its owner\'s, when herdr says %s', (status) => {
    const screen = readFileSync(new URL('./fixtures/codex/0.157.0/startup.txt', import.meta.url), 'utf8');
    const memory = newMemory();
    const update = live({ 'codex-acme': { status, screen } });
    const first = pass({ team: team(), watch: team().watch, state: emptySession(), live: update, machine: fine, now: 0, memory });
    // Its owner's to act on — never a question the operator nudges, and never an idle seat.
    expect(first.reports).toEqual([{ key: 'vendor notice:codex-acme', text: "codex-acme shows a vendor notice: its owner's to act on", to: 'owner' }]);
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: update, machine: fine, now: 30 * MIN, memory }).reports).toEqual([
      { key: 'prompt-escalated:codex-acme', text: "codex-acme is still at a vendor notice prompt after 5 minutes: the team's lead has not cleared it, and the entity's lead and the owner are told", to: 'owner' },
    ]);
  });

  test('a question is the operator\'s', () => {
    const asked = live({ 'deepseek-acme-2': { status: 'blocked', screen: question } });
    const result = pass({ team: team(), watch: team().watch, state: emptySession(), live: asked, machine: fine, now: 0, memory: newMemory() });
    expect(result.reports).toEqual([{ key: 'question:deepseek-acme-2', text: 'deepseek-acme-2 asked a question: the operator\'s to act on', to: 'operator' }]);
  });

  test('a condition is reported once, and again only after two passes that cleared', () => {
    // One pass where the condition is not seen is a flicker, not a new period: the key survives
    // it, and the condition's return is the same report. Two passes in a row drop the key.
    const memory = newMemory();
    const stuck = live({ 'deepseek-acme': { status: 'idle', screen: permission } });
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: stuck, machine: fine, now: 0, memory }).reports.length).toBe(1);
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: stuck, machine: fine, now: MIN, memory }).reports.length).toBe(0);
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: live(), machine: fine, now: 2 * MIN, memory }).reports.length).toBe(0);
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: stuck, machine: fine, now: 3 * MIN, memory }).reports.length).toBe(0);
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: live(), machine: fine, now: 4 * MIN, memory }).reports.length).toBe(0);
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: live(), machine: fine, now: 5 * MIN, memory }).reports.length).toBe(0);
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: stuck, machine: fine, now: 6 * MIN, memory }).reports.length).toBe(1);
  });

  test('unsent input is its own condition, after unsent_after, for the coordinator too', () => {
    const memory = newMemory();
    const typed = live({ 'claude-coordinator-acme': { status: 'idle', screen: unsent } });
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: typed, machine: fine, now: 0, memory }).reports).toEqual([]);
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: typed, machine: fine, now: MIN, memory }).reports.map((report) => report.text)).toEqual([
      'claude-coordinator-acme holds text in its input box that was never sent',
    ]);
  });

  test('a fully idle team, the coordinator and the operator left out, is reported once', () => {
    const memory = newMemory();
    const all = live({
      'deepseek-acme': { status: 'idle', screen: idle },
      'deepseek-acme-2': { status: 'done', screen: idle },
    });
    // codex-acme is parked and the leads don't count: the two DeepSeek seats are the team.
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: all, machine: fine, now: 0, memory }).reports).toEqual([]);
    const texts = pass({
      team: team(), watch: team().watch, state: emptySession(), live: all, machine: fine, now: 10 * MIN, memory,
    }).reports.map((report) => report.text);
    expect(texts).toContain('every agent is idle');
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: all, machine: fine, now: 15 * MIN, memory }).reports.map((report) => report.text)).not.toContain('every agent is idle');
  });

  test('a missing seat, an agent the file doesn\'t hold, and a wrong model', () => {
    const now = live({ 'claude-coordinator-acme': { screen: busy.replace('Opus 5.5', 'Fable 5.1') } });
    now.agents = now.agents.filter((one) => one.name !== 'deepseek-acme-2');
    now.agents.push(agent('stranger', 'w8', 'working'), agent(null, 'w9', 'working'));
    now.workspaces.push({ id: 'w8', label: 'x' }, { id: 'w9', label: watchLabel('acme-web') });
    const texts = pass({ team: team(), watch: team().watch, state: emptySession(), live: now, machine: fine, now: 0, memory: newMemory() }).reports.map((report) => report.text);
    expect(texts).toEqual([
      'claude-coordinator-acme runs Claude Fable 5.1; the registry says Claude Opus 5.5: it signs with the wrong model — team down, then team up (to restart the whole team)',
      'deepseek-acme-2 is in the file and is not running',
      'stranger (w8:p1) is running and is not in the file',
    ]);
  });

  // A seat the watch saw running and that is gone says so, and says it at each disappearance: the
  // session's own sequence, from the incident that found the line missing.
  const without = (scene: Live, name: string): Live => ({ ...scene, agents: scene.agents.filter((one) => one.name !== name) });
  const missingTexts = (memory: ReturnType<typeof newMemory>, at: number, scene: Live) => pass({
    team: team(), watch: team().watch, state: emptySession(), live: scene, machine: fine, now: at, memory,
  }).reports.filter((report) => report.key.startsWith('missing:')).map((report) => report.text);
  const GONE = 'deepseek-acme-2 was running and is gone (its pane closed, or its CLI ended)';

  test('the session\'s sequence: absent before the up, seen idle after it, then gone', () => {
    const memory = newMemory();
    const absent = without(live(), 'deepseek-acme-2');
    const running = live({ 'deepseek-acme-2': { status: 'idle', screen: idle } });
    // Absent from the very first pass: the seat never ran in this watch's run.
    expect(missingTexts(memory, 0, absent)).toEqual(['deepseek-acme-2 is in the file and is not running']);
    expect(missingTexts(memory, 2 * MIN, absent)).toEqual([]);
    // Launched and left at `named`, then seen idle for ten minutes: the watch knows it ran.
    expect(missingTexts(memory, 4 * MIN, running)).toEqual([]);
    expect(missingTexts(memory, 14 * MIN, running)).toEqual([]);
    // Gone at a later pass: said so, in the words for a seat that ran.
    expect(missingTexts(memory, 16 * MIN, absent)).toEqual([GONE]);
    expect(missingTexts(memory, 40 * MIN, absent)).toEqual([]);
  });

  test('gone, back, gone again: a report each time, not only the first', () => {
    const memory = newMemory();
    const running = live();
    const absent = without(running, 'deepseek-acme-2');
    expect(missingTexts(memory, 0, running)).toEqual([]);
    expect(missingTexts(memory, 2 * MIN, absent)).toEqual([GONE]);
    expect(missingTexts(memory, 4 * MIN, running)).toEqual([]);
    expect(missingTexts(memory, 6 * MIN, absent)).toEqual([GONE]);
    expect(missingTexts(memory, 8 * MIN, absent)).toEqual([]);
  });

  test('a seat the state left at named is already gone: the earlier not-running mark must not hide it', () => {
    const memory = newMemory();
    const absent = without(live(), 'deepseek-acme-2');
    const named = emptySession();
    named.seats['deepseek-acme-2'] = { stage: 'named', pane: 'w4:p1' };
    const texts = (at: number, scene: Live, state = emptySession()) => pass({
      team: team(), watch: team().watch, state, live: scene, machine: fine, now: at, memory,
    }).reports.filter((report) => report.key.startsWith('missing:')).map((report) => report.text);
    // Before the up: not running, and that sentence is the once-mark.
    expect(texts(0, absent)).toEqual(['deepseek-acme-2 is in the file and is not running']);
    // Named, and gone before the next pass saw an agent. The earlier sentence must not hide it.
    expect(texts(2 * MIN, absent, named)).toEqual([GONE]);
    // The same disappearance stands reported.
    expect(texts(4 * MIN, absent, named)).toEqual([]);
    // Seen running, then gone again: a new disappearance, reported again.
    expect(texts(6 * MIN, live(), named)).toEqual([]);
    expect(texts(8 * MIN, absent, named)).toEqual([GONE]);
  });

  test('a named seat already gone on the first pass was running', () => {
    const named = emptySession();
    named.seats['deepseek-acme-2'] = { stage: 'named', pane: 'w4:p1' };
    const absent = without(live(), 'deepseek-acme-2');
    expect(pass({
      team: team(), watch: team().watch, state: named, live: absent, machine: fine, now: 0, memory: newMemory(),
    }).reports.filter((report) => report.key.startsWith('missing:')).map((report) => report.text)).toEqual([GONE]);
    const ready = emptySession();
    ready.seats['deepseek-acme-2'] = { stage: 'ready', pane: 'w4:p1' };
    expect(pass({
      team: team(), watch: team().watch, state: ready, live: absent, machine: fine, now: 0, memory: newMemory(),
    }).reports.filter((report) => report.key.startsWith('missing:')).map((report) => report.text)).toEqual([GONE]);
  });

  test('a seat left at launched, with no agent, is still not running', () => {
    const state = emptySession();
    state.seats['deepseek-acme-2'] = { stage: 'launched', pane: 'w4:p1' };
    const absent = without(live(), 'deepseek-acme-2');
    expect(pass({
      team: team(), watch: team().watch, state, live: absent, machine: fine, now: 0, memory: newMemory(),
    }).reports.filter((report) => report.key.startsWith('missing:')).map((report) => report.text)).toEqual([
      'deepseek-acme-2 is in the file and is not running',
    ]);
  });

  test('a seat never seen running: today\'s line, once', () => {
    const memory = newMemory();
    const absent = without(live(), 'deepseek-acme-2');
    expect(missingTexts(memory, 0, absent)).toEqual(['deepseek-acme-2 is in the file and is not running']);
    expect(missingTexts(memory, MIN, absent)).toEqual([]);
    expect(missingTexts(memory, 2 * MIN, absent)).toEqual([]);
  });

  test('a stopped seat that is not running draws nothing', () => {
    const file = stoppedTeam();
    const absent = without(live(), 'codex-acme');
    const memory = newMemory();
    expect(pass({ team: file, watch: file.watch, state: emptySession(), live: absent, machine: fine, now: 0, memory }).reports).toEqual([]);
    expect(pass({ team: file, watch: file.watch, state: emptySession(), live: absent, machine: fine, now: MIN, memory }).reports).toEqual([]);
  });

  test('a session that doesn\'t answer reports no seat — and does again once it answers, as on main', () => {
    const memory = newMemory();
    const absent = without(live(), 'deepseek-acme-2');
    const dark = { ...absent, running: false };
    expect(missingTexts(memory, 0, dark)).toEqual([]);
    expect(missingTexts(memory, 2 * MIN, absent)).toEqual(['deepseek-acme-2 is in the file and is not running']);
    expect(missingTexts(memory, 4 * MIN, dark)).toEqual([]);
    expect(missingTexts(memory, 6 * MIN, absent)).toEqual(['deepseek-acme-2 is in the file and is not running']);
  });

  test('a pane that no longer holds the process team launched, reported once per change', () => {
    const state = emptySession();
    state.seats['deepseek-acme'] = { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 400, cli: [401] } };
    const memory = newMemory();
    const at = (processes: Record<string, { shell: number; foreground: number[] }>) =>
      pass({ team: team(), watch: team().watch, state, live: live(), machine: fine, now: 0, memory, processes }).reports.map((report) => report.text);
    const restored = 'deepseek-acme is no longer the process team launched (its session was restored, or its CLI was restarted)';
    const launcher = 'deepseek-acme: its launch line starts a launcher, and the process in its pane is not the one team launched — team restart deepseek-acme';
    // Another CLI under the recorded shell: replaced. The launch line names a launcher, so both lines.
    expect(at({ 'w3:p1': { shell: 400, foreground: [500] } })).toEqual([restored, launcher]);
    // The same reading again: the condition still holds, and it stands reported once.
    expect(at({ 'w3:p1': { shell: 400, foreground: [500] } })).toEqual([]);
    // The pane back at its own shell: the same condition, no second report. A shell is not the launcher line.
    expect(at({ 'w3:p1': { shell: 400, foreground: [400] } })).toEqual([]);
    // The recorded process in front again: the condition cleared, and one clear pass is a flicker.
    expect(at({ 'w3:p1': { shell: 400, foreground: [401] } })).toEqual([]);
    // Cleared for a second pass in a row: the mark is dropped.
    expect(at({ 'w3:p1': { shell: 400, foreground: [401] } })).toEqual([]);
    // Held by another process anew — a new change, reported anew.
    expect(at({ 'w3:p1': { shell: 500, foreground: [501] } })).toEqual([restored, launcher]);
  });

  test('a matching agent session is not reported as restored', () => {
    const state = emptySession();
    state.seats['deepseek-acme'] = { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 400, cli: [401] }, agent_session: 'kept' };
    const seen = live();
    const seat = seen.agents.find((agent) => agent.name === 'deepseek-acme');
    if (seat) seat.session = 'kept';
    const memory = newMemory();
    const at = (processes: Record<string, { shell: number; foreground: number[] }>) =>
      pass({ team: team(), watch: team().watch, state, live: seen, machine: fine, now: 0, memory, processes }).reports.map((report) => report.text);
    const restored = 'deepseek-acme is no longer the process team launched (its session was restored, or its CLI was restarted)';
    const launcher = 'deepseek-acme: its launch line starts a launcher, and the process in its pane is not the one team launched — team restart deepseek-acme';
    // The stored session is on the pane: the generic line stays quiet, and the launcher is still said.
    expect(at({ 'w3:p1': { shell: 500, foreground: [501] } })).toEqual([launcher]);
    // A pane back at its shell is the generic line only.
    expect(at({ 'w3:p1': { shell: 400, foreground: [400] } })).toEqual([restored]);
  });

  test('a restored agent session is recognized while its observed model drift is still reported', () => {
    const state = emptySession();
    state.seats['codex-acme'] = {
      stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 400, cli: [401] }, agent_session: 'kept',
    };
    const seen = live({
      'codex-acme': {
        status: 'working',
        screen: readFileSync(new URL('./fixtures/codex/0.157.0/working.txt', import.meta.url), 'utf8'),
      },
    });
    const codex = seen.agents.find((candidate) => candidate.name === 'codex-acme');
    if (!codex) throw new Error('fixture is missing codex-acme');
    codex.session = 'kept';

    const result = pass({
      team: team(), watch: team().watch, state, live: seen, machine: fine, now: 0, memory: newMemory(),
      processes: { 'w2:p1': { shell: 500, foreground: [501] } },
      signing: new Map([['codex-acme', { model: 'GPT Sol', version: '6' }]]),
    });

    // The pane's new pid is recognized as the same agent conversation, so no generic restored
    // warning is emitted. The live model still differs from its signing record and is reported.
    expect(result.reports.map((report) => report.text)).toEqual([
      'codex-acme runs GPT Terra 5.6; the registry says GPT Sol 6: it signs with the wrong model — team remove codex-acme --keep, then team add codex-acme',
    ]);
  });

  test('a reading herdr can\'t give is no change: it never clears the report-once mark', () => {
    const state = emptySession();
    state.seats['deepseek-acme'] = { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 400, cli: [401] } };
    const memory = newMemory();
    const at = (processes: Record<string, { shell: number; foreground: number[] } | null>) =>
      pass({ team: team(), watch: team().watch, state, live: live(), machine: fine, now: 0, memory, processes }).reports.map((report) => report.text);
    const restored = 'deepseek-acme is no longer the process team launched (its session was restored, or its CLI was restarted)';
    const launcher = 'deepseek-acme: its launch line starts a launcher, and the process in its pane is not the one team launched — team restart deepseek-acme';
    // same, replaced, replaced, same, gone, unknown, gone: reported at the 2nd and 5th readings
    // only. `unknown` is herdr failing to read, not the condition clearing: were it to clear the
    // mark, the `gone` after it would report a second time what the `gone` before it reported.
    // The launcher line rides the replaced readings and stays quiet once the pane is a shell.
    expect(at({ 'w3:p1': { shell: 400, foreground: [400, 401] } })).toEqual([]);
    expect(at({ 'w3:p1': { shell: 400, foreground: [500] } })).toEqual([restored, launcher]);
    expect(at({ 'w3:p1': { shell: 400, foreground: [500] } })).toEqual([]);
    expect(at({ 'w3:p1': { shell: 400, foreground: [400, 401] } })).toEqual([]);
    expect(at({ 'w3:p1': { shell: 400, foreground: [400] } })).toEqual([restored]);
    expect(at({ 'w3:p1': null })).toEqual([]);
    expect(at({ 'w3:p1': { shell: 400, foreground: [400] } })).toEqual([]);
  });

  test('herdr can\'t tell, or the seat has no record: the pane reads as today', () => {
    const recorded = emptySession();
    recorded.seats['deepseek-acme'] = { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 400, cli: [401] } };
    const at = (state: typeof recorded, processes: Record<string, { shell: number; foreground: number[] } | null>) =>
      pass({ team: team(), watch: team().watch, state, live: live(), machine: fine, now: 0, memory: newMemory(), processes }).reports.map((report) => report.text);
    // No foreground process at all, or no reading for the pane: unknown, never restored.
    expect(at(recorded, { 'w3:p1': { shell: 400, foreground: [] } })).toEqual([]);
    expect(at(recorded, { 'w3:p1': null })).toEqual([]);
    // A seat launched before team recorded its process: the pane reads as today.
    expect(at(emptySession(), { 'w3:p1': { shell: 400, foreground: [500] } })).toEqual([]);
  });

  test('a temporary seat of the state is watched as a seat', () => {
    const state = { ...emptySession(), seats: { 'deepseek-acme-tmp-1': { stage: 'ready' as const, temporary: { like: 'deepseek-acme', until: 'result:out.md' } } } };
    const now = live();
    now.agents.push(agent('deepseek-acme-tmp-1', 'w7', 'idle'));
    now.screens['w7:p1'] = permission;
    const texts = pass({ team: team(), watch: team().watch, state, live: now, machine: fine, now: 0, memory: newMemory() }).reports.map((report) => report.text);
    expect(texts).toEqual(['deepseek-acme-tmp-1 waits at a permission prompt: its owner\'s to answer']);
  });

  test('a temporary seat at herdr\'s done on a screen no profile reads is reported the same way', () => {
    // The stalled-seat shape the fail-safe was built from: a temporary seat, herdr reporting
    // done, no profile reading its screen. The report stands on its own; it is never typed.
    const state = { ...emptySession(), seats: { 'codex-acme-tmp-1': { stage: 'ready' as const, temporary: { like: 'codex-acme', until: 'result:out.md' } } } };
    const now = live();
    now.agents.push(agent('codex-acme-tmp-1', 'w7', 'done'));
    now.screens['w7:p1'] = 'Some unknown output without composer\n';
    const memory = newMemory();
    const first = pass({ team: team(), watch: team().watch, state, live: now, machine: fine, now: 0, memory });
    expect(first.reports).toEqual([{ key: 'unknown:codex-acme-tmp-1', text: 'codex-acme-tmp-1: herdr reports the status "done"', to: 'operator' }]);
    expect(first.work).toEqual([]);
    expect(first.ring).toBeNull();
  });

  test('a seat that runs another maker\'s model through Claude Code is unread, never wrong', () => {
    // The DeepSeek seats show Claude Code\'s status line; it names no model of theirs.
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: live(), machine: fine, now: 0, memory: newMemory() }).reports).toEqual([]);
  });

  test('the machine: load per core, memory, disk and free swap, each against its threshold', () => {
    const tight: Machine = { loadPerCore: 6.5, memoryFree: 10, diskFree: 5e9, swapTotal: 23.3e9, swapFree: 0.3e9, swapUsed: 23e9 };
    const reports = pass({ team: team(), watch: team().watch, state: emptySession(), live: live(), machine: tight, now: 0, memory: newMemory() }).reports;
    expect(reports.map((report) => report.text)).toEqual([
      'the load is 6.5 per core, above 6',
      'free memory is 10%, below 15%',
      'free disk is 5.0 GB, below 10.0 GB',
      'free swap is 0.3 GB, below 2.0 GB',
    ]);
    expect(reports.every((report) => report.to === 'owner')).toBe(true);
  });

  test('swap that grows fast is pressure even while free swap is high', () => {
    const memory = newMemory();
    const at = (minute: number, used: number) =>
      pass({ team: team(), watch: team().watch, state: emptySession(), live: live(), machine: { ...fine, swapUsed: used }, now: minute * MIN, memory }).reports.map((report) => report.text);
    expect(at(0, 1e9)).toEqual([]);
    expect(at(5, 1.8e9)).toEqual([]);
    expect(at(8, 2.4e9)).toEqual(['swap grew by 1.4 GB in 10 minutes, above 1.0 GB']);
    // The same growth an hour apart is not pressure.
    const slow = newMemory();
    pass({ team: team(), watch: team().watch, state: emptySession(), live: live(), machine: { ...fine, swapUsed: 1e9 }, now: 0, memory: slow });
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: live(), machine: { ...fine, swapUsed: 2.4e9 }, now: 60 * MIN, memory: slow }).reports).toEqual([]);
  });

  test('a file that differs from the approved one is the owner\'s, reported once', () => {
    const memory = newMemory();
    const first = pass({ team: team(), watch: team().watch, state: emptySession(), live: live(), machine: fine, now: 0, memory, approval: ['`rules` changed'] });
    expect(first.reports).toEqual([{ key: 'approval', text: 'the file has changed since the last approval: `rules` changed', to: 'owner' }]);
    expect(pass({
      team: team(), watch: team().watch, state: emptySession(), live: live(), machine: fine, now: MIN, memory, approval: ['`rules` changed'],
    }).reports).toEqual([]);
    // Neither spelling of "no difference is recorded" is a report of its own.
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: live(), machine: fine, now: 0, memory: newMemory(), approval: null }).reports).toEqual([]);
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: live(), machine: fine, now: 0, memory: newMemory(), approval: [] }).reports).toEqual([]);
  });

  test('a figure that can\'t be read is never reported', () => {
    const blind: Machine = { loadPerCore: null, memoryFree: null, diskFree: null, swapTotal: null, swapFree: null, swapUsed: null };
    expect(pass({ team: team(), watch: team().watch, state: emptySession(), live: live(), machine: blind, now: 0, memory: newMemory() }).reports).toEqual([]);
  });
});

// The screens each profile's CLI was captured showing, for the idle anchor cases.
const codexIdle = readFileSync(new URL('./fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');
const codexWorking = readFileSync(new URL('./fixtures/codex/0.157.0/working.txt', import.meta.url), 'utf8');
const agyIdle = readFileSync(new URL('./fixtures/antigravity/1.2.16/idle.txt', import.meta.url), 'utf8');
const agyWorking = readFileSync(new URL('./fixtures/antigravity/1.2.16/working.txt', import.meta.url), 'utf8');

// One worker per CLI profile, so the idle clock is pinned the same way for each.
const anchorExample = `
format: 1
project: anchor
workspace:
  mode: shared
coordinator: claude-lead
operator: claude-lead
seats:
  - role: coordinator
    name: claude-lead
    label: claude-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: claude-worker
    label: claude-worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: codex-worker
    cli: codex
    vendor: openai
    model: GPT Terra
    version: "5.6"
    launch: codex
  - role: implementer
    name: agy-worker
    cli: antigravity
    vendor: google
    model: Gemini Flash
    version: "3.8"
    launch: agy
`;

function anchorTeam(): TeamFile {
  const result = validateTeamFile(anchorExample);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

// Every worker working, the lead idle at its prompt, except where a case says otherwise.
function anchorScene(over: Record<string, { status?: string; screen?: string }> = {}): Live {
  const workers = ['claude-worker', 'codex-worker', 'agy-worker'];
  const agents: HerdrAgent[] = [
    { name: 'claude-lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null },
    ...workers.map((name, index) => ({
      name, agent: null, pane: `w${index + 1}:p1`, workspace: `w${index + 1}`, status: 'working', cwd: null,
    })),
  ];
  const screens: Record<string, string> = { 'w0:p1': idle, 'w1:p1': busy, 'w2:p1': codexWorking, 'w3:p1': agyWorking };
  for (const one of agents) {
    const change = over[one.name as string];
    if (!change) continue;
    if (change.status !== undefined) one.status = change.status;
    if (change.screen !== undefined) screens[one.pane] = change.screen;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

describe('the idle anchor', () => {
  // One worker per CLI, with the working and idle screens this repo captured for it.
  const workers = [
    ['claude-worker', busy, idle],
    ['codex-worker', codexWorking, codexIdle],
    ['agy-worker', agyWorking, agyIdle],
  ] as const;

  const reportAt = (memory: ReturnType<typeof newMemory>, minute: number, over: Record<string, { status?: string; screen?: string }> = {}) =>
    pass({ team: anchorTeam(), watch: anchorTeam().watch, state: emptySession(), live: anchorScene(over), machine: fine, now: minute * MIN, memory }).reports.map((report) => report.text);

  test.each(workers)('%s: the duration counts from the last "working" observation', (name, workingScreen, idleScreen) => {
    const memory = newMemory();
    expect(reportAt(memory, 5, { [name]: { status: 'working', screen: workingScreen } })).toEqual([]);
    // Quiet from minute 5 on: the clock runs from the work, not from the first quiet pass.
    expect(reportAt(memory, 15, { [name]: { status: 'idle', screen: idleScreen } })).toEqual([`${name} has been idle for 10 minutes`]);
  });

  test.each(workers)('%s: a working screen is the observation while herdr still says idle', (name, workingScreen, idleScreen) => {
    const memory = newMemory();
    // Herdr lags the transition: its status stays idle while the screen shows the turn running.
    expect(reportAt(memory, 10, { [name]: { status: 'idle', screen: workingScreen } })).toEqual([]);
    expect(reportAt(memory, 25, { [name]: { status: 'idle', screen: workingScreen } })).toEqual([]);
    // The turn over, the seat quiet: ten minutes since the last working observation, not twenty-five.
    expect(reportAt(memory, 35, { [name]: { status: 'idle', screen: idleScreen } })).toEqual([`${name} has been idle for 10 minutes`]);
  });

  test.each(workers)('%s: never seen working, the report carries no duration and reports once by default', (name, _working, idleScreen) => {
    const memory = newMemory();
    const quiet = { [name]: { status: 'idle', screen: idleScreen } };
    expect(reportAt(memory, 0, quiet)).toEqual([]);
    expect(reportAt(memory, 4, quiet)).toEqual([]);
    expect(reportAt(memory, 5, quiet)).toEqual([`${name} has been idle since the watch started`]);
    // The owner hears once per idle period, at idle_owner (15m).
    expect(reportAt(memory, 15, quiet)).toEqual([`${name} has been idle since the watch started — reported to the owner`]);
    // By default idle_repeat is off: the lead is told once per idle stretch.
    expect(reportAt(memory, 30, quiet)).toEqual([]);
  });
});

describe('reports and the passes that carry them', () => {
  const askedLine = 'deepseek-acme-2 asked a question: the operator\'s to act on';

  test('an operator report with free builders nudges no builder', () => {
    // A question waits for the operator and a builder sits free at an empty prompt. The first
    // pass has no work drop due, and the report is never typed. Five minutes on, the builder is
    // reached by its work drop on the idle cadence — the fixed line, never the report's text.
    const scene = live({
      'deepseek-acme-2': { status: 'blocked', screen: question },
      'deepseek-acme': { status: 'idle', screen: idle },
    });
    const memory = newMemory();
    const first = pass({ team: team(), watch: team().watch, state: emptySession(), live: scene, machine: fine, now: 0, memory });
    expect(first.reports).toEqual([{ key: 'question:deepseek-acme-2', text: askedLine, to: 'operator' }]);
    expect(first.work).toEqual([]);
    expect(first.ring).toBeNull();
    const later = pass({ team: team(), watch: team().watch, state: emptySession(), live: scene, machine: fine, now: 5 * MIN, memory });
    expect(later.work).toEqual([{ pane: 'w3:p1', seat: 'deepseek-acme', cli: 'claude-code', body: NUDGE_TEXT }]);
    expect(later.work[0]?.body).not.toContain('asked a question');
  });

  test('a flickering unknown screen reports once across known/unknown/known passes', () => {
    // The fail-safe's key survives one pass where the screen reads known — a flicker is not a
    // clear — and two known passes in a row drop it, so a condition that really cleared reports
    // again when it comes back.
    const memory = newMemory();
    const unknown = live({ 'codex-acme': { status: 'done', screen: 'Some unknown output without composer\n' } });
    const known = live();
    const at = (scene: Live, minute: number) => pass({
      team: team(), watch: team().watch, state: emptySession(), live: scene, machine: fine, now: minute * MIN, memory,
    }).reports.map((report) => report.text);
    const line = 'codex-acme: herdr reports the status "done"';
    expect(at(unknown, 0)).toEqual([line]);
    expect(at(known, 2)).toEqual([]);
    expect(at(unknown, 4)).toEqual([]);
    expect(at(known, 6)).toEqual([]);
    // The second known pass in a row: the condition has cleared.
    expect(at(known, 8)).toEqual([]);
    expect(at(unknown, 10)).toEqual([line]);
  });

  test('a real new idle period still reports', () => {
    const memory = newMemory();
    const quiet = live({ 'deepseek-acme': { status: 'idle', screen: idle } });
    const at = (scene: Live, minute: number) => pass({
      team: team(), watch: team().watch, state: emptySession(), live: scene, machine: fine, now: minute * MIN, memory,
    }).reports.map((report) => report.text);
    expect(at(quiet, 0)).toEqual([]);
    expect(at(quiet, 5)).toEqual(['deepseek-acme has been idle since the watch started']);
    // Works, then goes quiet again: a new period, reported once idle_first has run from the work.
    expect(at(live(), 20)).toEqual([]);
    expect(at(quiet, 24)).toEqual([]);
    expect(at(quiet, 30)).toEqual(['deepseek-acme has been idle for 10 minutes']);
  });
});

describe('team watch', () => {
  let dir: string;
  let file: string;
  let typed: string[];
  let notified: string[];
  let screenNow: string;
  let statusNow: string;
  let scene: Live | null;
  let clock: number;

  // The file as approved, with no drift: a synthetic verified standing over the file on disk, so
  // the watch runs the same derivations a real store's snapshot drives. A test that rewrites the
  // file gets the new text approved too; one that breaks it gets the none a refused read yields.
  function approvedNow(): WatchSources['standing'] {
    return (root) => {
      try {
        const text = readFileSync(file, 'utf8');
        const parsed = validateTeamFile(text);
        return parsed.ok ? verifiedOf(parsed.team, text, root) : { kind: 'none' };
      } catch {
        return { kind: 'none' };
      }
    };
  }

  function sources(passes: number, over: Partial<WatchSources> = {}): WatchSources {
    let left = passes;
    return {
      home: join(dir, 'home'),
      live: () => scene,
      machine: () => fine,
      standing: approvedNow(),
      readChecks: () => [],
      screen: () => screenNow,
      status: () => statusNow,
      foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = claudeBox(text); return true; },
      pressEnter: (pane) => { typed.push(`${pane} <enter>`); return true; },
      sleep: async (ms) => { clock += ms; },
      notify: (text) => { notified.push(text); },
      now: () => new Date(clock),
      wait: async (seconds) => { clock += seconds * 1000; return --left > 0; },
      alive: () => false,
      pid: 4242,
      ...over,
    };
  }

  // A message waiting for a seat: the ring is the watch's one fixed typed line, so the delivery
  // safety tests below type it, while every report beside it is only logged and notified.
  function waiting(seat = 'deepseek-acme', at = '2026-10-03T13:59:00.000Z'): Partial<WatchSources> {
    planted(seat, 'the message body itself', at);
    return { home: join(dir, 'home') };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'team-watch-'));
    execSync('git init -q', { cwd: dir });
    mkdirSync(join(dir, '.agents'));
    file = join(dir, '.agents', 'team.yaml');
    writeFileSync(file, example);
    typed = [];
    notified = [];
    screenNow = idle;
    statusNow = 'idle';
    clock = Date.parse('2026-10-03T14:00:00Z');
    scene = live({
      'deepseek-acme-2': { status: 'blocked', screen: question },
      'deepseek-acme': { status: 'idle', screen: idle },
    });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('--json is an invocation refusal: one team.error document, stderr empty', async () => {
    // The daemon loop takes no document: the flag itself is refused, and the refusal is read
    // from the raw argv, so an earlier unknown option cannot lose the structured face.
    for (const [argv, messageContains] of [
      [['--json'], 'unknown option --json'],
      [['--nope', '--json'], 'unknown option --nope'],
      [['--json=1'], 'unknown option --json'],
    ] as const) {
      const io = testIo(dir, { kind: 'owner' });
      expect(await runWatch([...argv], io, sources(1))).toBe(2);
      expect(io.err).toBe('');
      assertJsonErrorShape(io.out, { id: 'watch.invocation', messageContains, repair: null });
    }
  });

  test('a plain invocation refusal still prints the usage, and the usage states the exits', async () => {
    const io = testIo(dir, { kind: 'owner' });
    expect(await runWatch(['--nope'], io, sources(1))).toBe(2);
    expect(io.out).toBe('');
    expect(io.err).toBe(`team watch: unknown option --nope\n${USAGE}`);
    expect(USAGE).toContain(
      `Exits 0 when the watch starts or stops cleanly, 1 when it is refused or fails, 2 when\nthe invocation or team file can't be read.\n`,
    );
  });

  test.each([
    ['never approved', () => ({ kind: 'none' as const })],
    ['legacy', () => ({ kind: 'legacy' as const })],
    ['refused', () => ({
      kind: 'refused' as const,
      why: 'the record does not carry a valid signature: it was changed after approval, or written without the key',
    })],
  ] satisfies Array<[string, WatchSources['standing']]>)('still rings an idle seat while the record is %s', async (_name, standing) => {
    const io = testIo(dir, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, sources(1, { ...waiting(), standing }));
    expect(code).toBe(0);
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`, 'w3:p1 <enter>']);
  });

  test('types nothing when herdr lists two agents of the idle seat', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const doubled = live({
      'deepseek-acme-2': { status: 'blocked', screen: question },
      'deepseek-acme': { status: 'idle', screen: idle },
    });
    const worker = doubled.agents.find((agent) => agent.name === 'deepseek-acme');
    if (!worker) throw new Error('the fixture has no idle seat');
    doubled.agents.push({ ...worker, pane: 'w9:p1', workspace: 'w9' });
    const code = await runWatch(['--file', file], io, sources(1, { ...waiting(), live: () => doubled }));
    expect(code).toBe(0);
    expect(typed).toEqual([]);
  });

  test('a status line changed between passes reaches line 2 on the sweep, once per change', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const pushed: string[] = [];
    // Nobody idle: no ring, so the pane text the sweep reads is only what this test sets.
    const working = live({ 'deepseek-acme': { status: 'working', screen: busy }, 'deepseek-acme-2': { status: 'working', screen: busy } });
    let waits = 0;
    const code = await runWatch(['--file', file], io, sources(1, {
      live: () => working,
      // The pane as the owner's /model and /effort left it, some seconds after the pass.
      screen: () => '  main · Sonnet 4.5\nwith high effort\n',
      reportDisplayAgent: (_session, pane, text) => { pushed.push(`${pane} ${text}`); return true; },
      wait: async (_seconds, onTick) => { waits += 1; onTick?.(); onTick?.(); return false; },
    }));
    expect(code).toBe(0);
    expect(waits).toBe(1);
    // The pass painted the file's line from the whole read; the sweep painted the changed one,
    // and its second tick — the same screen again — painted nothing.
    expect(pushed.filter((line) => line.startsWith('w1:p1 '))).toEqual([
      'w1:p1 Claude Opus 5.5 default',
      'w1:p1 Claude Sonnet 4.5 high',
    ]);
  });

  test('a display herdr refuses between passes is said, and the older line stands for the next tick', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const pushed: string[] = [];
    const working = live({ 'deepseek-acme': { status: 'working', screen: busy }, 'deepseek-acme-2': { status: 'working', screen: busy } });
    let allow = true;
    const code = await runWatch(['--file', file], io, sources(1, {
      live: () => working,
      screen: () => '  main · Sonnet 4.5\n',
      reportDisplayAgent: (_session, pane, text) => { pushed.push(`${pane} ${text}`); return allow; },
      // The first tick finds herdr gone; the second finds it back, so the line is tried again.
      wait: async (_seconds, onTick) => { allow = false; onTick?.(); allow = true; onTick?.(); return false; },
    }));
    expect(code).toBe(0);
    expect(io.out).toContain('claude-coordinator-acme: its display was not reported');
    expect(pushed.filter((line) => line.startsWith('w1:p1 '))).toEqual([
      'w1:p1 Claude Opus 5.5 default',
      'w1:p1 Claude Sonnet 4.5 default',
      'w1:p1 Claude Sonnet 4.5 default',
    ]);
  });

  test('reports to the log, the desktop and the operator, and writes its heartbeat', async () => {
    const io = testIo(dir, { kind: 'owner' });
    let beat: unknown;
    const code = await runWatch(['--file', file], io, sources(1, {
      ...waiting(),
      wait: async () => { beat ??= readState(join(dir, '.agents')).sessions['acme-web']?.watch; return false; },
    }));
    expect(code).toBe(0);
    expect(beat).toEqual({ pid: 4242, heartbeat: '2026-10-03T14:00:00.000Z' });
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`, 'w3:p1 <enter>']);
    expect(typed[0]).not.toContain('asked a question');
    expect(notified[0]).toBe('deepseek-acme-2 asked a question: the operator\'s to act on');
    const log = readFileSync(join(dir, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('watch [watch] deepseek-acme-2 asked a question');
    expect(log).toContain('watch [watch] rang deepseek-acme');
  });

  test('the readings are written once per ten minutes, and not more, whether or not anything is wrong', async () => {
    const io = testIo(dir, { kind: 'owner' });
    // Eleven passes at the default 120s: twenty minutes of watch, so one line at once, then at
    // ten minutes and at twenty — three lines, not eleven.
    expect(await runWatch(['--file', file], io, sources(11))).toBe(0);
    const lines = readFileSync(join(dir, '.agents', 'team.log'), 'utf8')
      .split('\n').filter((line) => line.includes('watch [watch] readings: '));
    expect(lines).toEqual([
      '2026-10-03T14:00:00.000Z watch [watch] readings: load 1.0/core, memory 50%, disk 200000000000 B free, pressure unread, swap used 1000000000 B of 9000000000 B (free 8000000000 B)',
      '2026-10-03T14:10:00.000Z watch [watch] readings: load 1.0/core, memory 50%, disk 200000000000 B free, pressure unread, swap used 1000000000 B of 9000000000 B (free 8000000000 B)',
      '2026-10-03T14:20:00.000Z watch [watch] readings: load 1.0/core, memory 50%, disk 200000000000 B free, pressure unread, swap used 1000000000 B of 9000000000 B (free 8000000000 B)',
    ]);
  });

  test('a figure the machine couldn\'t read is written unread, never guessed', async () => {
    const io = testIo(dir, { kind: 'owner' });
    expect(await runWatch(['--file', file], io, sources(1, { machine: () => ({ ...fine, memoryFree: null, swapFree: null }) }))).toBe(0);
    const log = readFileSync(join(dir, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('watch [watch] readings: load 1.0/core, memory unread, disk 200000000000 B free, pressure unread, swap unread');
  });

  test('a log that cannot be written does not kill the pass', async () => {
    const io = testIo(dir, { kind: 'owner' });
    // The log path is a directory, so the readings write can only fail — the pass below it still
    // runs whole: its reports still notify, and its heartbeat is on the state while it runs.
    mkdirSync(join(dir, '.agents', 'team.log'), { recursive: true });
    let beat: unknown;
    expect(await runWatch(['--file', file], io, sources(1, {
      wait: async () => { beat ??= readState(join(dir, '.agents')).sessions['acme-web']?.watch; return false; },
    }))).toBe(0);
    expect(beat).toEqual({ pid: 4242, heartbeat: '2026-10-03T14:00:00.000Z' });
    expect(notified[0]).toBe('deepseek-acme-2 asked a question: the operator\'s to act on');
  });

  test('the values in force are what runs: the pass, the announced line and the wait read them', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const waits: number[] = [];
    const code = await runWatch(['--file', file], io, sources(1, {
      // What the owner approved: the same file with a five-second interval. The file on disk
      // says 120s, and the live values are what runs.
      standing: (root) => {
        const approvedText = example.replace('  interval: 120s', '  interval: 5s');
        const parsed = validateTeamFile(approvedText);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
        return verifiedOf(parsed.team, approvedText, root);
      },
      wait: async (seconds) => { waits.push(seconds); return false; },
    }));
    expect(code).toBe(0);
    // The live file says 120s, so both the announcement and wait use it.
    expect(io.out).toContain('watching the session "acme-web" every 120s');
    expect(waits).toEqual([120]);
    expect(io.out).not.toContain('the file differs from the approved one');
  });

  test('a signed watch-rhythm change is reloaded by the running watch on its next pass', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const waits: number[] = [];
    let changed = false;
    const code = await runWatch(['--file', file], io, sources(2, {
      wait: async (seconds) => {
        waits.push(seconds);
        if (!changed) {
          changed = true;
          const wrote = writePolicySet(join(dir, 'home'), {
            level: 'team', target: teamIdOf(dir), teamRoot: dir, name: 'watch-rhythm', value: 'relaxed',
          }, { now: new Date(clock) });
          if (!wrote.ok) throw new Error(wrote.why);
          return true;
        }
        return false;
      },
    }));
    expect(code).toBe(0);
    expect(waits).toEqual([120, 240]);
  });

  test('an edited grant and delegates logs no approved-copy difference', async () => {
    writeFileSync(
      file,
      `${example}\ngrant:\n  session: acme-web\n  seat: claude-coordinator-acme\n  scope: [up, down]\ndelegates:\n  - pane: other/pane-1\n    commands: [up, down]\n`,
    );
    const io = testIo(dir, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, sources(1, {
      standing: (root) => {
        const parsed = validateTeamFile(example);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
        return verifiedOf(parsed.team, example, root);
      },
    }));
    expect(code).toBe(0);
    expect(io.out).not.toContain('the file differs from the approved one');
    expect(io.out).not.toContain('grant');
    expect(io.out).not.toContain('delegates');
    const log = readFileSync(join(dir, '.agents', 'team.log'), 'utf8');
    expect(log).not.toContain('the file differs from the approved one');
  });

  test('when it stops, its record is cleared and that is notified', async () => {
    await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(1));
    expect(readState(join(dir, '.agents')).sessions['acme-web']?.watch).toBeUndefined();
    expect(notified[notified.length - 1]).toBe('the watch of "acme-web" stopped');
  });

  test('a prompt that appeared since the pass keeps the ring back: nothing is typed', async () => {
    screenNow = permission;
    await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(1, waiting()));
    expect(typed).toEqual([]);
    screenNow = idle;
  });

  test('a ring held back by a prompt is typed on a later pass, once the prompt clears', async () => {
    let calls = 0;
    await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(2, {
      ...waiting(),
      screen: () => (calls++ === 0 ? permission : screenNow),
    }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`, 'w3:p1 <enter>']);
  });

  test('a ring the pane has not drawn yet is waited for, read back, and then sent', async () => {
    // The real Claude Code capture of the instant after a line was typed: the pane still reads
    // idle with its placeholder, and a moment later the box holds the line. The reading that
    // decides the Enter waits for the draw — the fault was reading back once, at once, and
    // telling 'typed and not sent' about a pane that had simply not drawn yet.
    const justTyped = readFileSync(new URL('./fixtures/nudge-typing/claude-code-nudge-idle-ansi.txt', import.meta.url), 'utf8');
    const drawn = claudeBox(RING_TEXT);
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      ...waiting(),
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = justTyped; return true; },
      sleep: async (ms) => { clock += ms; screenNow = drawn; },
    }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`, 'w3:p1 <enter>']);
    expect(io.out).toContain('rang deepseek-acme');
    expect(io.out).not.toContain('a nudge was typed and not sent');
  });

  test('a box reading unsent with part of the line first poll draws whole later and gets the Enter', async () => {
    // The core defect this fix closes: terminal painting is asynchronous, so a pane may draw the
    // composer frame and part of the typed line (reading unsent, but boxHoldsText is false) on the
    // first poll, and the remainder of the line a moment later. On main, the first unsent reading
    // ended settleScreen immediately, saw boxHoldsText false, and gave up without sending Enter.
    // The bounded loop waits up to DRAW_WAIT_MS for the box to hold the whole line, and sends the Enter.
    const partial = claudeBox(RING_TEXT.slice(0, 15));
    const drawn = claudeBox(RING_TEXT);
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      ...waiting(),
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = partial; return true; },
      sleep: async (ms) => { clock += ms; screenNow = drawn; },
    }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`, 'w3:p1 <enter>']);
    expect(io.out).toContain('rang deepseek-acme');
    expect(io.out).not.toContain('a nudge was typed and not sent');
  });

  test('a pane that never draws the ring is left, with the line that says so', async () => {
    // The wait is bounded, as the exit typing's is: a screen still idle at the deadline is the
    // text never drawn, and nothing but the typing was sent.
    const justTyped = readFileSync(new URL('./fixtures/nudge-typing/claude-code-nudge-idle-ansi.txt', import.meta.url), 'utf8');
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      ...waiting(),
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = justTyped; return true; },
    }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`]);
    expect(io.out).toContain('a nudge was typed and not sent');
  });

  test('a clock that does not advance ends the draw wait without spinning forever', async () => {
    // settleScreen's no-advance clock guard ensures that under a fixed mock clock (where sleep
    // does not advance now()), the draw-wait loop breaks immediately rather than spinning forever.
    const justTyped = readFileSync(new URL('./fixtures/nudge-typing/claude-code-nudge-idle-ansi.txt', import.meta.url), 'utf8');
    const io = testIo(dir, { kind: 'owner' });
    let sleeps = 0;
    await runWatch(['--file', file], io, sources(1, {
      ...waiting(),
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = justTyped; return true; },
      sleep: async () => { sleeps++; },
      now: () => new Date('2026-10-03T14:00:00Z'),
    }));
    expect(sleeps).toBe(1);
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`]);
    expect(io.out).toContain('a nudge was typed and not sent');
  });

  test('the same line typed by someone else is never sent, typed over or cleared', async () => {
    // The reviewer's case: the line is one fixed public constant, so a person or an agent who
    // typed it themselves leaves a box that reads exactly like the watch's own leftover. The
    // pass saw the scene's idle prompt; the read before delivery finds this box. With no record
    // in this process of typing it, the text is its owner's — no key goes out, nothing is typed
    // over it, and nothing clears it.
    const held = claudeBox(RING_TEXT);
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, { ...waiting(), screen: () => held }));
    expect(typed).toEqual([]);
    expect(io.out).not.toContain('rang deepseek-acme');
  });

  test('a line this watch typed itself, left unsent, is sent by a later pass and not typed again', async () => {
    // Pass 1 types the line; the pane never draws it, so the Enter does not go out and the line
    // stays in the box — this process's own leftover, recorded at the typing. Pass 2 finds the
    // box holding exactly that line and sends it, instead of typing the same text a second time.
    const justTyped = readFileSync(new URL('./fixtures/nudge-typing/claude-code-nudge-idle-ansi.txt', import.meta.url), 'utf8');
    const held = claudeBox(RING_TEXT);
    let waits = 0;
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(2, {
      ...waiting(),
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = justTyped; return true; },
      // The pane draws the line between the passes: unsent, and this watch's own.
      wait: async (seconds) => { clock += seconds * 1000; screenNow = held; return waits++ === 0; },
    }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`, 'w3:p1 <enter>']);
    expect(io.out).toContain('rang deepseek-acme: ' + RING_TEXT);
    expect(io.out).toContain('a nudge was typed and not sent');
  });

  test('after a restart, the line the watch left unsent is someone\'s text: no key is sent', async () => {
    // Run 1 leaves the box holding this watch's own line, unsent. Run 2 is a new watch process:
    // it remembers no typing, so the same box is text it cannot claim, and it is never sent —
    // the unsent report from the check is what a person or the next stop acts on.
    const justTyped = readFileSync(new URL('./fixtures/nudge-typing/claude-code-nudge-idle-ansi.txt', import.meta.url), 'utf8');
    const held = claudeBox(RING_TEXT);
    await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(1, {
      ...waiting(),
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = justTyped; return true; },
    }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`]);
    // The pane drew the line between the runs: the box now holds exactly the watch's line.
    screenNow = held;
    typed = [];
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, { ...waiting(), screen: () => held }));
    expect(typed).toEqual([]);
    expect(io.out).not.toContain('rang deepseek-acme');
  });

  test('a box holding any other text is never sent into, typed over or cleared', async () => {
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, { ...waiting(), screen: () => unsent }));
    expect(typed).toEqual([]);
    expect(io.out).not.toContain('rang deepseek-acme');
  });

  test('a pane with no live agent is not typed into', async () => {
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(2, { ...waiting(), foreground: () => ['zsh'] }));
    expect(typed).toEqual([]);
    const line = 'a nudge was not typed: no live agent in deepseek-acme\'s pane';
    expect(io.out.split(line).length - 1).toBe(1);
  });

  test('an agent that exits between the text and the Enter is not sent the Enter', async () => {
    let live = true;
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      ...waiting(),
      foreground: () => (live ? ['claude'] : ['zsh']),
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); live = false; return true; },
    }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`]);
    expect(io.out).toContain('a nudge was not typed: no live agent in deepseek-acme\'s pane');
  });

  test('an operator that turns working during the draw wait is not sent the Enter', async () => {
    // The reviewer's focused case: the pass saw the seat free, the typing goes in, and while
    // the pane draws the box the seat starts a turn. The status read before the wait must not
    // clear the key: the Enter's checks are the live agent, the status as it reads at the key and
    // the box, all taken with no await between them, so a turn that began under the wait leaves
    // the line typed and unsent.
    const justTyped = readFileSync(new URL('./fixtures/nudge-typing/claude-code-nudge-idle-ansi.txt', import.meta.url), 'utf8');
    const drawn = claudeBox(RING_TEXT);
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      ...waiting(),
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = justTyped; return true; },
      sleep: async (ms) => { clock += ms; screenNow = drawn; statusNow = 'working'; },
    }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`]);
    expect(io.out).toContain('a nudge was typed and not sent');
  });

  test('an operator that started working since the pass is not typed into', async () => {
    statusNow = 'working';
    await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(1, waiting()));
    expect(typed).toEqual([]);
  });

  test('a dialog that opens between the text and the Enter never gets the Enter', async () => {
    let looks = 0;
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, { ...waiting(), screen: () => (looks++ === 0 ? idle : permission) }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`]);
    expect(io.out).toContain('a nudge was typed and not sent');
  });

  test('a codex permission dialog above the status line never gets the Enter either', async () => {
    // The idle seat is codex here, and the screen it pins after the paste is a permission dialog
    // drawn above the status line. Read before the fix: `unsent` — the same shape as the
    // seat's own text — so the Enter went to the dialog's first choice.
    const codexIdle = readFileSync(new URL('./fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');
    const pinned = readFileSync(new URL('./fixtures/codex/0.157.0/permission-pinned.txt', import.meta.url), 'utf8');
    // The example's codex-acme is parked, and a parked seat is not rung.
    writeFileSync(file, example.replace('    parked: true\n', ''));
    scene = live({
      'codex-acme': { status: 'idle', screen: codexIdle },
      'deepseek-acme-2': { status: 'blocked', screen: question },
    });
    let looks = 0;
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, { ...waiting('codex-acme'), screen: () => (looks++ === 0 ? codexIdle : pinned) }));
    expect(typed).toEqual([`w2:p1 ${ringFor('codex-acme')}`]);
    expect(io.out).toContain('a nudge was typed and not sent');
  });

  test('the box, read back before the Enter, is the line\'s own: the Enter is sent', async () => {
    await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(1, waiting()));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`, 'w3:p1 <enter>']);
  });

  test('a wrapped box that reads back as the line gets its Enter', async () => {
    // A narrow pane wraps the line onto continuation rows. Claude Code's captures show no
    // composer wrap, so no wrap is modelled for it: the rows must read back as the line's own
    // text in order, and then the Enter is the line's.
    const wrapped = claudeBox(wordWrap(RING_TEXT, 12).join('\n'));
    await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(1, {
      ...waiting(),
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = wrapped; return true; },
    }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`, 'w3:p1 <enter>']);
  });

  test('a wrapped box with a blank row between its rows never gets the Enter', async () => {
    // An empty continuation row is not part of the line: the pane draws one only where the
    // line itself has a blank line, and it has none. The line is typed, and not sent.
    const rows = wordWrap(RING_TEXT, 12);
    const [firstRow = '', ...rest] = rows;
    const wrapped = claudeBox([firstRow, '', ...rest].join('\n'));
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      ...waiting(),
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = wrapped; return true; },
    }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`]);
    expect(io.out).toContain('a nudge was typed and not sent');
  });

  test('a trailing blank row after the wrapped line never gets the Enter', async () => {
    // The same reproduction: the wrapped line's rows, then one more empty row inside the box,
    // above the closing rule. No capture shows Claude Code drawing an empty row of its own
    // inside the composer, so a trailing blank row is a row the line does not have.
    const rows = wordWrap(RING_TEXT, 12);
    const [firstRow = '', ...rest] = rows;
    const [rule = ''] = claudeBox('').split('\n');
    const wrapped = claudeBox([firstRow, ...rest].join('\n')).replace(`\n${rule}\n`, `\n\n${rule}\n`);
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      ...waiting(),
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = wrapped; return true; },
    }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`]);
    expect(io.out).toContain('a nudge was typed and not sent');
  });

  test('a rule-looking row after the wrapped line never gets the Enter', async () => {
    // The same shape: the wrapped line's rows, then one more indented row of forty ─ inside the
    // box, above its closing rule. The pane draws content rows at the text's own column, and
    // the closing rule is the window's last rule row, an unbroken run of ─ from the pane's
    // first column — the extra row is neither.
    const rows = wordWrap(RING_TEXT, 12);
    const [firstRow = '', ...rest] = rows;
    const wrapped = claudeBox([firstRow, ...rest, '─'.repeat(40)].join('\n'));
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      ...waiting(),
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = wrapped; return true; },
    }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`]);
    expect(io.out).toContain('a nudge was typed and not sent');
  });

  test('a rule-looking row between two line rows never gets the Enter', async () => {
    // The rule-looking row between the line's rows is content the line does not have, and
    // neither is the box that shows it. The line is typed, and not sent.
    const rows = wordWrap(RING_TEXT, 12);
    const [firstRow = '', ...rest] = rows;
    const wrapped = claudeBox([firstRow, '─'.repeat(40), ...rest].join('\n'));
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      ...waiting(),
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = wrapped; return true; },
    }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`]);
    expect(io.out).toContain('a nudge was typed and not sent');
  });

  test('a box that holds someone else\'s text gets no Enter', async () => {
    let looks = 0;
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, { ...waiting(), screen: () => (looks++ === 0 ? idle : unsent) }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`]);
    expect(io.out).toContain('a nudge was typed and not sent');
  });

  test('a prompt-glyph continuation row in the seat\'s box is never typed into and never gets the Enter', async () => {
    // The round-6 reproduction: the seat's box holds its own text and then a continuation row
    // carrying only the prompt glyph. The box is not idle — the input row is the box's first
    // row under its opening rule, and the glyph row is content — so nothing is typed. Read by
    // glyph, the box was idle, the line was appended after the glyph, and the line and the
    // person's text were submitted together.
    screenNow = claudeBox('person text\n❯');
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      ...waiting(),
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = claudeBox(`person text\n❯ ${text}`); return true; },
    }));
    expect(typed).toEqual([]);
    expect(io.out).not.toContain('rang deepseek-acme');
  });

  test('a second glyph row at the seat\'s prompt column is never typed into and never gets the Enter', async () => {
    // The 0.2.1 boundary, in Codex's shape: the seat's box holds its own text and then a row
    // carrying the prompt at the input row's own column. No capture draws a person's
    // continuation there — continuations are indented two columns — so the read is `unknown`:
    // not idle, and nothing is typed. Read by its lowest row the box was idle, the line was
    // appended after the second glyph, the read-back held only the line, and the Enter submitted
    // the person's own text with it.
    const codexIdle = readFileSync(new URL('./fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');
    // The example's codex-acme is parked, and a parked seat can't be rung.
    writeFileSync(file, example.replace('    parked: true\n', ''));
    scene = live({
      'codex-acme': { status: 'idle', screen: codexIdle },
      'deepseek-acme-2': { status: 'blocked', screen: question },
    });
    screenNow = codexIdle.replace('› Ask Codex to do anything', '› person text\n›');
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      ...waiting('codex-acme'),
      typeText: (pane, text) => {
        typed.push(`${pane} ${text}`);
        screenNow = codexIdle.replace('› Ask Codex to do anything', `› person text\n› ${text}`);
        return true;
      },
    }));
    expect(typed).toEqual([]);
    expect(io.out).not.toContain('rang codex-acme');
  });

  test('the transcript echo above the blank frame is rung: the box is idle under it', async () => {
    // The routine post-send layout, in Codex's shape: the sent message echoed at the prompt
    // column, the captured blank frame, the empty input row. It is the transcript's echo, not a
    // row of the person's box (a box row is drawn indented), so the box reads `idle` and the
    // line is typed and entered — the seat exists to be rung.
    const codexIdle = readFileSync(new URL('./fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');
    writeFileSync(file, example.replace('    parked: true\n', ''));
    scene = live({
      'codex-acme': { status: 'idle', screen: codexIdle },
      'deepseek-acme-2': { status: 'blocked', screen: question },
    });
    screenNow = codexIdle.replace('› Ask Codex to do anything', '› person text\n\n›');
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      ...waiting('codex-acme'),
      typeText: (pane, text) => {
        typed.push(`${pane} ${text}`);
        screenNow = codexIdle.replace('› Ask Codex to do anything', `› person text\n\n› ${text}`);
        return true;
      },
    }));
    expect(typed).toEqual([`w2:p1 ${ringFor('codex-acme')}`, 'w2:p1 <enter>']);
    expect(io.out).toContain('rang codex-acme');
  });

  test('a seat\'s box whose top frame scrolled off gets no ring', async () => {
    // The reviewer's second must-fix: the input row scrolled out, a visible indented
    // continuation, then the prompt row. The row directly above the prompt is not blank, so the
    // prompt is not a box top the captures draw — nothing is typed.
    const codexIdle = readFileSync(new URL('./fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');
    writeFileSync(file, example.replace('    parked: true\n', ''));
    scene = live({
      'codex-acme': { status: 'idle', screen: codexIdle },
      'deepseek-acme-2': { status: 'blocked', screen: question },
    });
    screenNow = codexIdle.replace('› Ask Codex to do anything', '  person-owned visible continuation\n›');
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      ...waiting('codex-acme'),
      typeText: (pane, text) => {
        typed.push(`${pane} ${text}`);
        screenNow = codexIdle.replace('› Ask Codex to do anything', `  person-owned visible continuation\n› ${text}`);
        return true;
      },
    }));
    expect(typed).toEqual([]);
    expect(io.out).not.toContain('rang codex-acme');
  });

  test('the transcript echo above the blank frame is rung: the box is idle under it (Cursor)', async () => {
    // The Cursor twin of the routine post-send layout: `  → person text`, blank frame, `  →`.
    // typed-blank-middle.txt settles the shape — a person's box draws its third line at the
    // content column, so a second glyph at the prompt column after a blank is the transcript's
    // echo. The box reads `idle` and the line is typed and entered.
    const cursorIdle = readFileSync(new URL('./fixtures/cursor/2026.10.01/idle.txt', import.meta.url), 'utf8');
    writeFileSync(file, example.replace(
      '    name: deepseek-acme\n    cli: claude-code           # DeepSeek\'s model, run by Claude Code',
      '    name: deepseek-acme\n    cli: cursor',
    ));
    scene = live({
      'deepseek-acme': { status: 'idle', screen: cursorIdle },
      'deepseek-acme-2': { status: 'blocked', screen: question },
    });
    screenNow = cursorIdle.replace('  → Plan, search, build anything', '  → person text\n\n  →');
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      ...waiting(),
      typeText: (pane, text) => {
        typed.push(`${pane} ${text}`);
        screenNow = cursorIdle.replace('  → Plan, search, build anything', `  → person text\n\n  → ${text}`);
        return true;
      },
    }));
    expect(typed).toEqual([`w3:p1 ${RING_TEXT}`, 'w3:p1 <enter>']);
    expect(io.out).toContain('rang deepseek-acme');
  });

  test.each(['close-short', 'close-long', 'open-short'] as const)(
    'a ring is not typed or sent into an Antigravity seat\'s mismatched-rules box (%s)',
    async (shape) => {
      // The round-7 reproduction: the seat's two rules disagree in width, so the frame cannot
      // be established and the window is not idle. Without the width check the window read idle,
      // the line was typed into it, the read-back held, and the Enter went with it. With it,
      // nothing is typed.
      writeFileSync(file, example.replace(
        '    name: deepseek-acme\n    cli: claude-code           # DeepSeek\'s model, run by Claude Code',
        '    name: deepseek-acme\n    cli: antigravity',
      ));
      scene = live({
        'deepseek-acme-2': { status: 'blocked', screen: question },
        'deepseek-acme': { status: 'idle', screen: agyMismatchedFrame(shape) },
      });
      screenNow = agyMismatchedFrame(shape);
      const io = testIo(dir, { kind: 'owner' });
      await runWatch(['--file', file], io, sources(1, {
        ...waiting(),
        typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = agyMismatchedFrame(shape, text); return true; },
      }));
      expect(typed).toEqual([]);
      expect(io.out).not.toContain('rang deepseek-acme');
    });

  test('--no-notify still delivers a floor report, and the log keeps it', async () => {
    writeFileSync(file, withAccounts(`  accounts:
    openai: { kind: subscription, reserve: 3%, sources: [status_line] }
    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: deepseek-balance }
`));
    scene = live({
      'deepseek-acme-2': { status: 'blocked', screen: question },
      'codex-acme': { screen: '• Working (2m 10s • esc to interrupt)\n\n  GPT-5.6-Terra medium · Context 98% left · weekly 2% left\n' },
    });
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file, '--no-notify'], io, sources(1, {
      readChecks: (_team, _root, at) => [
        { account: 'deepseek', state: 'read', reading: { kind: 'spend', amount: 4.2, currency: 'USD', at } },
      ],
    }));
    // The question is the operator's, and the flag may silence it. The floor is the owner's.
    expect(notified).toContain('deepseek 4.2 USD left, at its 5 USD floor');
    expect(notified).not.toContain('deepseek-acme-2 asked a question: the operator\'s to act on');
    const log = readFileSync(join(dir, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('deepseek 4.2 USD left, at its 5 USD floor');
    expect(log).toContain('deepseek-acme-2 asked a question');
    // `status` does not read the flag. The reserve row is still there.
    const status = testIo(dir, { kind: 'owner' });
    await runStatus(['--file', file], status, {
      live: () => scene,
      branch: () => 'main',
      standing: approvedNow(),
      now: () => new Date(clock),
    });
    expect(status.out).toContain('inside reserve 3%');
  });

  test('a seat cannot pass --no-notify or --no-nudge', async () => {
    // No `--file` here: that flag is the owner's, and the watch's own gate would refuse the seat
    // for it before this test's own refusal — a seat runs the command bare, as placed.
    const io = testIo(dir, { kind: 'seat', name: 'deepseek-acme', pane: 'w3:p1' });
    expect(await runWatch(['--no-notify'], io, sources(1))).toBe(1);
    expect(io.err).toContain('--no-nudge and --no-notify are the owner\'s');
    expect(io.err).toContain('deepseek-acme');
    expect(notified).toEqual([]);
    expect(readState(join(dir, '.agents')).sessions['acme-web']?.watch).toBeUndefined();
  });

  test('only the owner\'s delivery path subscribes to the bus', async () => {
    // A seat's own watch runs its passes and never subscribes with the owner's identity, so the
    // bus never hands it a kind the policy routes to the owner.
    let fromSeat = 0;
    const seatIo = testIo(dir, { kind: 'seat', name: 'deepseek-acme', pane: 'w3:p1' });
    expect(await runWatch([], seatIo, sources(1, {
      busSubscribe: async () => {
        fromSeat += 1;
        return { kind: 'events', events: [], cursor: 0 };
      },
    }))).toBe(0);
    expect(fromSeat).toBe(0);

    // The owner at a terminal outside herdr is that path.
    let fromOwner = 0;
    expect(await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(1, {
      busSubscribe: async () => {
        fromOwner += 1;
        return { kind: 'events', events: [], cursor: 0 };
      },
    }))).toBe(0);
    expect(fromOwner).toBe(1);

    // So is the watch pane `up` starts: an agentless pane, placed by its own root.
    let fromPane = 0;
    expect(await runWatch([], testIo(dir, { kind: 'pane', pane: 'w9:p1' }), sources(1, {
      busSubscribe: async () => {
        fromPane += 1;
        return { kind: 'events', events: [], cursor: 0 };
      },
    }))).toBe(0);
    expect(fromPane).toBe(1);
  });

  test('--no-nudge types nothing and --no-notify notifies nothing; the log still has it', async () => {
    // A message waits at the idle seat, so the pass has its one typed line — and refuses it.
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file, '--no-nudge', '--no-notify'], io, sources(1, waiting()));
    expect(typed).toEqual([]);
    expect(notified).toEqual(['the watch of "acme-web" stopped']);
    expect(notified).not.toContain('deepseek-acme-2 asked a question: the operator\'s to act on');
    expect(io.out).toContain(`ring not typed (--no-nudge): ${RING_TEXT}`);
    expect(readFileSync(join(dir, '.agents', 'team.log'), 'utf8')).toContain('deepseek-acme-2 asked a question');
  });
  test('a second watch on the same session refuses while the first is alive', async () => {
    updateState(join(dir, '.agents'), (state) => {
      state.sessions['acme-web'] = { ...emptySession(), watch: { pid: 99, heartbeat: '2026-10-03T13:59:00Z' } };
    });
    const io = testIo(dir, { kind: 'owner' });
    expect(await runWatch(['--file', file], io, sources(1, { alive: (pid) => pid === 99 }))).toBe(1);
    expect(io.err).toContain('a watch already runs for the session "acme-web" (pid 99)');
    // Another session is free, and so is this one once the first watch is dead.
    expect(await runWatch(['--file', file, '--session', 'team-test'], testIo(dir, { kind: 'owner' }), sources(1, { alive: (pid) => pid === 99 }))).toBe(0);
    expect(await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(1))).toBe(0);
  });

  test('a file broken while it runs: it says so once and keeps watching with the last valid copy', async () => {
    const io = testIo(dir, { kind: 'owner' });
    let round = 0;
    await runWatch(['--file', file], io, sources(3, {
      wait: async (seconds) => { clock += seconds * 1000; if (round++ === 0) writeFileSync(file, 'format: 9\n'); return round < 3; },
    }));
    expect(io.out.match(/team\.yaml is invalid/g)?.length).toBe(1);
    expect(io.out).toContain('using the copy of');
  });

  test('herdr that stops answering is reported once, and the watch keeps trying', async () => {
    scene = null;
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(3));
    expect(io.out.match(/herdr doesn't answer/g)?.length).toBe(1);
  });

  test('a check that reads nothing is logged as unreadable, once, and the account reads unknown', async () => {
    writeFileSync(file, withAccounts('  accounts:\n    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: deepseek-balance }\n'));
    const io = testIo(dir, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, sources(2, {
      readChecks: () => [{ account: 'deepseek', state: 'unreadable' }],
    }));
    expect(code).toBe(0);
    // The command's own output is never logged: only that it could not be read.
    expect(io.out.match(/its check is unreadable/g)?.length).toBe(1);
    expect(io.out).toContain('deepseek: its check is unreadable');
    expect(io.out).toContain('deepseek is unknown while deepseek-acme, deepseek-acme-2 run on it');
  });

  test('an unapproved check is not run, and the line says so once', async () => {
    writeFileSync(file, withAccounts('  accounts:\n    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: deepseek-balance }\n'));
    const io = testIo(dir, { kind: 'owner' });
    let asked = 0;
    const code = await runWatch(['--file', file], io, sources(2, {
      readChecks: () => { asked++; return [{ account: 'deepseek', state: 'unapproved' }]; },
    }));
    expect(code).toBe(0);
    // Two passes, one reading: the checks run at most every `budgets.check_every`.
    expect(asked).toBe(1);
    expect(io.out.match(/unapproved; that account reads unknown/g)?.length).toBe(1);
    expect(io.out).toContain('the check for deepseek is unapproved; that account reads unknown');
  });

  test('readings the pass saw are saved, so `status`, `up` and `add` see them', async () => {
    writeFileSync(file, withAccounts('  accounts:\n    openai: { kind: subscription, reserve: 3%, sources: [status_line] }\n'));
    scene = live({ 'codex-acme': { screen: `• Working (2m 10s • esc to interrupt)\n\n  GPT-5.6-Terra medium · Context 98% left · weekly 39% left\n` } });
    const code = await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(1));
    expect(code).toBe(0);
    expect(loadReadings(join(dir, '.agents')).map(({ account, window, left, used, seat }) => ({ account, window, left, used, seat })))
      .toEqual([{ account: 'openai', window: 'weekly', left: 39, used: 61, seat: 'codex-acme' }]);
  });

  test('a reading is not saved from a pane back at its shell', async () => {
    writeFileSync(file, withAccounts('  accounts:\n    openai: { kind: subscription, reserve: 3%, sources: [status_line] }\n'));
    // The pane after the CLI exited: the recorded exit screen, and a status-shaped line printed
    // with no newline after it. herdr still lists the agent; its foreground process is the shell.
    const exit = readFileSync(new URL('./fixtures/codex/0.157.0/exit.txt', import.meta.url), 'utf8');
    const fake = '  GPT-5.6-Terra medium · Context 98% left · weekly 90% left\n';
    scene = live({ 'codex-acme': { screen: `${exit.trimEnd()}\n${fake}` } });
    const fore = { foreground: () => ['zsh'] };
    const code = await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(1, fore));
    expect(code).toBe(0);
    expect(loadReadings(join(dir, '.agents'))).toEqual([]);
  });

  test('a reading is not saved from a pane herdr could not read', async () => {
    writeFileSync(file, withAccounts('  accounts:\n    openai: { kind: subscription, reserve: 3%, sources: [status_line] }\n'));
    // The same status-line figure, and a pane whose process list herdr could not read: a null is
    // not a CLI, and the reading is not invented to fill it.
    scene = live({ 'codex-acme': { screen: `• Working (2m 10s • esc to interrupt)\n\n  GPT-5.6-Terra medium · Context 98% left · weekly 39% left\n` } });
    const code = await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(1, { foreground: () => null }));
    expect(code).toBe(0);
    expect(loadReadings(join(dir, '.agents'))).toEqual([]);
  });

  test('a spend check reading is kept, so `up` and `add` count the floor against it', async () => {
    writeFileSync(file, withAccounts('  accounts:\n    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: deepseek-balance }\n'));
    const code = await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(1, {
      readChecks: (_team, _root, at) => [
        { account: 'deepseek', state: 'read', reading: { kind: 'spend', amount: 4.2, currency: 'USD', at } },
      ],
    }));
    expect(code).toBe(0);
    expect(loadSpendReadings(join(dir, '.agents')))
      .toEqual([{ account: 'deepseek', amount: 4.2, currency: 'USD', at: Date.parse('2026-10-03T14:00:00Z') }]);
  });

  test('a subscription check reading is kept, so `up` and `add` count the reserve against it', async () => {
    writeFileSync(file, withAccounts('  accounts:\n    openai: { kind: subscription, reserve: 3%, sources: [check, status_line], check: openai-usage }\n'));
    const code = await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(1, {
      readChecks: (_team, _root, at) => [
        { account: 'openai', state: 'read', reading: { kind: 'subscription', windows: [{ window: 'weekly', left: 5, used: 95, at, resetsAt: null }] } },
      ],
    }));
    expect(code).toBe(0);
    expect(loadReadings(join(dir, '.agents')).filter((one) => one.source === 'check')).toEqual([{
      account: 'openai', window: 'weekly', left: 5, used: 95,
      changedAt: Date.parse('2026-10-03T14:00:00Z'), resetsAt: null, seat: null, source: 'check', confirmed: true,
    }]);
  });

  test('a watch on a session that is not the file\'s saves no reading, and says so once', async () => {
    writeFileSync(file, withAccounts(
      '  accounts:\n'
      + '    openai: { kind: subscription, reserve: 3%, sources: [status_line, check], check: openai-usage }\n'
      + '    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: deepseek-balance }\n',
    ));
    scene = live({ 'codex-acme': { screen: `• Working (2m 10s • esc to interrupt)\n\n  GPT-5.6-Terra medium · Context 98% left · weekly 39% left\n` } });
    const checks: WatchSources['readChecks'] = (_team, _root, at) => [
      { account: 'openai', state: 'read', reading: { kind: 'subscription', windows: [{ window: 'weekly', left: 5, used: 95, at, resetsAt: null }] } },
      { account: 'deepseek', state: 'read', reading: { kind: 'spend', amount: 4.2, currency: 'USD', at } },
    ];
    // Anyone may watch another session; only the file's own session's watch is the cache that
    // `up` and `add` count (§ 4.4).
    const io = testIo(dir, { kind: 'owner' });
    expect(await runWatch(['--file', file, '--session', 'team-test'], io, sources(2, { readChecks: checks }))).toBe(0);
    expect(loadReadings(join(dir, '.agents'))).toEqual([]);
    expect(loadSpendReadings(join(dir, '.agents'))).toEqual([]);
    expect(io.out.match(/is not this file's "acme-web"/g)?.length).toBe(1);

    // The file's own session saves the same figures.
    scene = live({ 'codex-acme': { screen: `• Working (2m 10s • esc to interrupt)\n\n  GPT-5.6-Terra medium · Context 98% left · weekly 39% left\n` } });
    expect(await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(1, { readChecks: checks }))).toBe(0);
    expect(loadReadings(join(dir, '.agents')).map(({ account, source }) => `${account}/${source}`).sort())
      .toEqual(['openai/check', 'openai/status_line']);
    expect(loadSpendReadings(join(dir, '.agents')).map(({ account, amount }) => [account, amount])).toEqual([['deepseek', 4.2]]);
  });

  test('a cache whose readings carry points moves nothing the watch prints, notifies or types', async () => {
    writeFileSync(file, withAccounts('  accounts:\n    openai: { kind: subscription, reserve: 3%, sources: [status_line] }\n'));
    const seeded: Seen[] = [{
      account: 'openai', window: 'weekly', left: 2, used: 98,
      changedAt: Date.parse('2026-10-03T13:40:00Z'), resetsAt: null,
      seat: 'codex-acme', source: 'status_line' as const, confirmed: true,
    }];
    // The same watch over the same fixture, twice: once over a cache as the pass stores it, once
    // over a cache whose readings every one carry a valid point (the note's § 5 injector). Every
    // line, typed key and notification must be equal. The state file itself is allowed to differ,
    // and does: the pointed run keeps the point through the pass's fold, and the plain one has
    // none to keep.
    const run = async (points: boolean) => {
      rmSync(join(dir, '.agents', 'team.state.json'), { force: true });
      rmSync(join(dir, '.agents', 'team.log'), { force: true });
      clock = Date.parse('2026-10-03T14:00:00Z');
      screenNow = idle;
      statusNow = 'idle';
      typed = [];
      notified = [];
      scene = live({ 'codex-acme': { screen: `• Working (2m 10s • esc to interrupt)\n\n  GPT-5.6-Terra medium · Context 98% left · weekly 2% left\n` } });
      saveReadings(join(dir, '.agents'), seeded, clock);
      if (points) expect(injectWas(join(dir, '.agents'))).toBe(1);
      const io = testIo(dir, { kind: 'owner' });
      const code = await runWatch(['--file', file], io, sources(2));
      const budgets = (JSON.parse(readFileSync(join(dir, '.agents', 'team.state.json'), 'utf8')) as {
        budgets: Record<string, Record<string, unknown>>;
      }).budgets;
      return {
        code, out: io.out, err: io.err,
        notified: [...notified], typed: [...typed],
        log: readFileSync(join(dir, '.agents', 'team.log'), 'utf8'),
        budgets,
      };
    };
    const { budgets: plainBudgets, ...plainRun } = await run(false);
    const { budgets: pointedBudgets, ...pointedRun } = await run(true);
    // The run is not vacuous: the lines that must not move are lines the cache's own figure
    // drives — the marks it crossed and the reserve it sits inside.
    expect(plainRun.out).toContain('openai weekly is 98% used, past the 90% mark');
    expect(plainRun.out).toContain('openai weekly left 2%, inside its 3% reserve');
    expect(pointedRun).toEqual(plainRun);
    // The two caches hold the same figures record for record; the point is the only difference,
    // and it is on every record the injector touched.
    const bare = (one: Record<string, unknown>) => Object.fromEntries(Object.entries(one).filter(([field]) => field !== 'was'));
    const strip = (state: Record<string, Record<string, unknown>>) => Object.fromEntries(Object.entries(state).map(([key, one]) => [key, bare(one)]));
    expect(strip(pointedBudgets)).toEqual(strip(plainBudgets));
    expect(Object.keys(plainBudgets)).toHaveLength(1);
    expect(Object.values(plainBudgets).every((one) => !('was' in one))).toBe(true);
    expect(Object.values(pointedBudgets).every((one) => 'was' in one)).toBe(true);
  });

  function planted(seat: string, body: string, at: string): MessagePayload {
    const root = findRoot(dir);
    if (!root) throw new Error('the watch fixture is not a git checkout');
    const payload: MessagePayload = {
      kind: 'message', id: 'm1', to: seat, root, session: 'acme-web', at, body, from: 'harness',
    };
    plantMessage(join(dir, 'home'), root, seat, payload.id, payload);
    return payload;
  }

  /** The receipt `team messages` writes for a message read from the older store: signed with the
   *  message key over the receipt's own domain, so the watch's unread filter verifies it. */
  function readMailbox(payload: MessagePayload): void {
    const home = join(dir, 'home');
    const receipt = {
      kind: 'receipt', id: payload.id, to: payload.to, root: payload.root, session: payload.session,
      at: '2026-10-03T13:59:30.000Z',
    };
    const signature = signDomain(RECEIPT_DOMAIN, receipt as Json, messageKeyOf(home));
    writeFileSync(receiptFile(payload.root, payload.to, payload.id), `${JSON.stringify({ payload: receipt, signature }, null, 2)}\n`);
  }

  test('--no-nudge types no ring and presses no Enter; the record stays', async () => {
    // The older `--no-nudge` test already has a report waiting, so the nudge branch runs and the
    // ring branch does not. This pass has no report: the ring would be the only typed line.
    const body = 'the message body itself\nthis second line stays in the record';
    planted('claude-operator-acme', body, '2026-10-03T13:00:00.000Z');
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file, '--no-nudge'], io, sources(1, { home: join(dir, 'home'), live: () => live() }));
    expect(typed).toEqual([]);
    expect(io.out).toContain(`ring not typed (--no-nudge): ${ringFor('claude-operator-acme')}`);
    // The logged line carries the body's first content line as its summary; the rest stays in
    // the record and is never printed.
    expect(io.out).not.toContain(body);
    expect(existsSync(join(dir, '.agents', 'messages', 'claude-operator-acme', 'm1.json'))).toBe(true);
    expect(existsSync(join(dir, '.agents', 'messages', 'claude-operator-acme', 'm1.read.json'))).toBe(false);
  });

  test('an unacked record rings the idle seat with the wake line and not the body', async () => {
    const body = 'the message body itself\nthis second line stays in the record';
    planted('claude-operator-acme', body, '2026-10-03T13:00:00.000Z');
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, { home: join(dir, 'home'), live: () => live() }));
    // The line names the record's sender and carries the body's first content line; the rest of
    // the body stays in the record.
    expect(typed).toEqual([
      `w0:p1 ${ringFor('claude-operator-acme')}`,
      'w0:p1 <enter>',
    ]);
    expect(typed.join('\n')).not.toContain(body);
    expect(io.out).toContain(`rang claude-operator-acme: ${ringFor('claude-operator-acme')}`);
    expect(existsSync(join(dir, '.agents', 'messages', 'claude-operator-acme', 'm1.json'))).toBe(true);
    expect(existsSync(join(dir, '.agents', 'messages', 'claude-operator-acme', 'm1.read.json'))).toBe(false);
  });

  test('a message read after the pass read the mailbox is not rung', async () => {
    // The mailbox snapshot is taken at the top of the pass; the seat reads the message while the
    // pass is still reporting it. The receipt is the seat's own word, so the ring would be a
    // duplicate reminder: the line is not typed, and the watch says the message is already read.
    const body = 'the message body itself';
    const payload = planted('claude-operator-acme', body, '2026-10-03T13:00:00.000Z');
    const io = testIo(dir, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, sources(1, {
      home: join(dir, 'home'),
      notify: (text) => {
        notified.push(text);
        if (text.includes('asked a question')) readMailbox(payload);
      },
    }));
    expect(code).toBe(0);
    expect(typed).toEqual([]);
    expect(io.out).toContain('ring not typed: message m1 is already read');
    expect(io.out).not.toContain('rang claude-operator-acme');
  });

  test('an idle report for another seat cannot keep a read drop alive by reusing its id', async () => {
    const target = planted('deepseek-acme', 'target body', '2026-10-03T13:59:00.000Z');
    const start = Date.parse('2026-10-03T14:00:00Z');
    const operatorIdle = live({
      'deepseek-acme': { status: 'working', screen: busy },
      'deepseek-acme-2': { status: 'idle', screen: idle },
    });
    const bothIdle = live({
      'deepseek-acme': { status: 'idle', screen: idle },
      'deepseek-acme-2': { status: 'idle', screen: idle },
    });
    const io = testIo(dir, { kind: 'owner' });
    let passes = 4;
    const code = await runWatch(['--file', file], io, sources(4, {
      live: () => clock >= start + 6 * 60_000 ? bothIdle : operatorIdle,
      wait: async (seconds) => {
        clock += seconds * 1000;
        return --passes > 0;
      },
      notify: (text) => {
        notified.push(text);
        if (text.includes('deepseek-acme-2 has been idle')) {
          readMailbox(target);
          // A different seat can have the same message id. Its unread record must not
          // authorize ringing the target whose receipt just appeared.
          planted('deepseek-acme-2', 'other body', '2026-10-03T14:05:00.000Z');
        }
      },
    }));
    expect(code).toBe(0);
    expect(notified.some((text) => text.includes('deepseek-acme-2 has been idle'))).toBe(true);
    expect(typed).toEqual([]);
    expect(io.out).not.toContain('rang deepseek-acme:');
  });

  test('a waiting report is never the typed line: the ring is', async () => {
    // A report for the operator (the question at deepseek-acme-2) and a message waiting at an
    // idle seat (the operator's own box) in the same pass. One line is typed, and it is the
    // ring's fixed wake line — never the report's words.
    const body = 'the message body itself';
    planted('claude-operator-acme', body, '2026-10-03T13:00:00.000Z');
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, { home: join(dir, 'home') }));
    expect(typed).toEqual([`w0:p1 ${ringFor('claude-operator-acme')}`, 'w0:p1 <enter>']);
    expect(io.out).toContain('deepseek-acme-2 asked a question');
    expect(io.out).not.toContain(`w3:p1 ${NUDGE_TEXT}`);
    expect(existsSync(join(dir, '.agents', 'messages', 'claude-operator-acme', 'm1.json'))).toBe(true);
  });

  test('a cursor box holding unsent text is not typed into and the record stays', async () => {
    const cursorUnsent = readFileSync(new URL('./fixtures/cursor/2026.10.01/unsent.txt', import.meta.url), 'utf8');
    writeFileSync(file, cursorOperator);
    const body = 'the message body itself';
    planted('claude-operator-acme', body, '2026-10-03T13:59:00.000Z');
    const held = live({ 'claude-operator-acme': { status: 'idle', screen: cursorUnsent } });
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      home: join(dir, 'home'),
      live: () => held,
      screen: () => cursorUnsent,
    }));
    expect(typed).toEqual([]);
    expect(io.out).not.toContain(body);
    expect(existsSync(join(dir, '.agents', 'messages', 'claude-operator-acme', 'm1.json'))).toBe(true);
  });

  test('a watch of another session types nothing and raises no owner line', async () => {
    planted('claude-operator-acme', 'the message body itself', '2026-10-03T13:50:00.000Z');
    planted('deepseek-acme', 'an old body', new Date(clock - 601_000).toISOString());
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file, '--session', 'other'], io, sources(1, { home: join(dir, 'home'), live: () => live() }));
    expect(typed).toEqual([]);
    expect(io.out).not.toContain(RING_TEXT);
    expect(io.out).not.toContain('has been waiting');
    expect(existsSync(join(dir, '.agents', 'messages', 'claude-operator-acme', 'm1.json'))).toBe(true);
    expect(existsSync(join(dir, '.agents', 'messages', 'deepseek-acme', 'm1.json'))).toBe(true);
    expect(existsSync(join(dir, '.agents', 'messages', 'claude-operator-acme', 'm1.read.json'))).toBe(false);
    expect(existsSync(join(dir, '.agents', 'messages', 'deepseek-acme', 'm1.read.json'))).toBe(false);
  });

  test('two seats holding the same id each get one owner line', async () => {
    const at = new Date(clock - 601_000).toISOString();
    planted('claude-operator-acme', 'one body', at);
    planted('deepseek-acme', 'another body', at);
    const blocked = live({
      'claude-operator-acme': { status: 'working', screen: busy },
      'deepseek-acme': { status: 'working', screen: busy },
    });
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(2, { home: join(dir, 'home'), live: () => blocked }));
    expect(typed).toEqual([]);
    // One note per pass, so the second seat is said on the next pass and its minute count has moved.
    expect(io.out.split('message m1 for claude-operator-acme has been waiting').length - 1).toBe(1);
    expect(io.out.split('message m1 for deepseek-acme has been waiting').length - 1).toBe(1);
  });

  test('an old unacked record whose box is not free raises one owner line and types nothing', async () => {
    const body = 'the message body itself';
    planted('deepseek-acme', body, new Date(clock - 601_000).toISOString());
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(2, { home: join(dir, 'home'), live: () => live() }));
    expect(typed).toEqual([]);
    expect(io.out).toContain('message m1 for deepseek-acme has been waiting 10 minutes');
    expect(io.out.split('message m1 for deepseek-acme').length - 1).toBe(1);
    expect(io.out).not.toContain(body);
    expect(existsSync(join(dir, '.agents', 'messages', 'deepseek-acme', 'm1.json'))).toBe(true);
  });

  test('a restarted watch does not send a box that already holds the wake line', async () => {
    const body = 'the message body itself';
    planted('claude-operator-acme', body, '2026-10-03T13:59:00.000Z');
    const held = claudeBox(ringFor('claude-operator-acme'));
    const sceneHeld = live({ 'claude-operator-acme': { status: 'idle', screen: held } });
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, {
      home: join(dir, 'home'),
      live: () => sceneHeld,
      screen: () => held,
    }));
    expect(typed).toEqual([]);
    expect(io.out).not.toContain('<enter>');
    expect(io.out).not.toContain(`rang claude-operator-acme`);
  });

  test('a record is not rung when the watch is not given a home', async () => {
    planted('claude-operator-acme', 'the message body itself', '2026-10-03T13:00:00.000Z');
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file], io, sources(1, { home: undefined, live: () => live() }));
    expect(typed).toEqual([]);
    expect(io.out).not.toContain(ringFor('claude-operator-acme'));
  });

  test('a file that never validated, and a bad option', async () => {
    writeFileSync(file, 'format: 9\n');
    expect(await runWatch(['--file', file], testIo(dir, { kind: 'owner' }), sources(1))).toBe(2);
    expect(await runWatch(['--loud'], testIo(dir), sources(1))).toBe(2);
  });
});

describe('the sidebar of a running seat', () => {
  function paint(screen: string, name: string, memory = newMemory()) {
    const scene = live({ [name]: { status: 'idle', screen } });
    return pass({ team: team(), watch: team().watch, state: emptySession(), live: scene, machine: fine, now: 0, memory });
  }

  function line(result: ReturnType<typeof pass>, name: string): string | undefined {
    return result.labels.find((label) => label.name === name)?.displayAgent;
  }

  test('the first cycle paints the file, and the next cycle with the same screen paints nothing', () => {
    const memory = newMemory();
    const screen = '  main · Opus 5.5\n';
    const first = paint(screen, 'claude-coordinator-acme', memory);
    const label = first.labels.find((item) => item.name === 'claude-coordinator-acme');
    expect(label?.displayAgent).toBe('Claude Opus 5.5 default');
    expect(label?.title).toBe('claude-coordinator-acme · project coordinator');
    expect(label?.displayAgent?.includes('claude-code')).toBe(false);
    const slot = (memory.seatLabels['claude-coordinator-acme'] ??= {});
    slot.line = label?.displayAgent;
    slot.title = label?.title;
    const second = paint(screen, 'claude-coordinator-acme', memory);
    expect(second.labels.find((item) => item.name === 'claude-coordinator-acme')).toBeUndefined();
  });

  test('a different yielded model is pushed once, and a failed push is tried again', () => {
    const memory = newMemory();
    const screen = '  main · Sonnet 4.5\n';
    const first = paint(screen, 'claude-coordinator-acme', memory);
    expect(line(first, 'claude-coordinator-acme')).toBe('Claude Sonnet 4.5 default');
    const again = paint(screen, 'claude-coordinator-acme', memory);
    expect(line(again, 'claude-coordinator-acme')).toBe('Claude Sonnet 4.5 default');
    const slot = (memory.seatLabels['claude-coordinator-acme'] ??= {});
    const pushed = again.labels.find((item) => item.name === 'claude-coordinator-acme');
    slot.line = pushed?.displayAgent;
    slot.title = pushed?.title;
    expect(line(paint(screen, 'claude-coordinator-acme', memory), 'claude-coordinator-acme')).toBeUndefined();
  });

  test('an effort change is pushed once, and a Claude viewport with no effort phrase keeps the word', () => {
    const memory = newMemory();
    const banner = 'Opus 4.8 with high effort\na\nb\nc\nd\ne\n  main · Opus 5.5\n';
    const first = paint(banner, 'claude-coordinator-acme', memory);
    expect(line(first, 'claude-coordinator-acme')).toBe('Claude Opus 5.5 high');
    const slot = (memory.seatLabels['claude-coordinator-acme'] ??= {});
    const pushed = first.labels.find((item) => item.name === 'claude-coordinator-acme');
    slot.line = pushed?.displayAgent;
    slot.title = pushed?.title;
    expect(line(paint('  main · Opus 5.5\n', 'claude-coordinator-acme', memory), 'claude-coordinator-acme')).toBeUndefined();
    expect(memory.seatLabels['claude-coordinator-acme']?.effort).toBe('high');
  });

  test('a codex row, a cursor row, an antigravity footer and a grok footer supply the effort', () => {
    const memory = newMemory();
    const codex = paint('  GPT-6-Astra xhigh · Context 100% left\n', 'codex-acme', memory);
    expect(line(codex, 'codex-acme')).toBe('GPT Astra 6 xhigh');

    const file = team();
    const cursorSeat = file.seats.find((seat) => seat.name === 'claude-operator-acme');
    if (!cursorSeat) throw new Error('no operator');
    cursorSeat.cli = 'cursor';
    cursorSeat.model = 'Grok';
    cursorSeat.version = '4.7';
    cursorSeat.display = 'Grok 4.7';
    const cursorScene = live({ 'claude-operator-acme': { status: 'idle', screen: '  Grok 4.7 256K High\n' } });
    const cursor = pass({ team: file, watch: file.watch, state: emptySession(), live: cursorScene, machine: fine, now: 0, memory: newMemory() });
    expect(line(cursor, 'claude-operator-acme')).toBe('Grok 4.7 high');

    const agySeat = file.seats.find((seat) => seat.name === 'grok-acme');
    if (!agySeat) throw new Error('no grok seat');
    agySeat.cli = 'antigravity';
    agySeat.model = 'Gemini Flash';
    agySeat.version = '3.8';
    agySeat.display = 'Gemini 3.8 Flash';
    agySeat.stopped = false;
    const agyScene = live();
    agyScene.agents.push(agent('grok-acme', 'w9', 'idle', 'antigravity'));
    agyScene.screens['w9:p1'] = 'Gemini 4 Argon · medium\n';
    agyScene.workspaces.push({ id: 'w9', label: 'old' });
    const agy = pass({ team: file, watch: file.watch, state: emptySession(), live: agyScene, machine: fine, now: 0, memory: newMemory() });
    expect(line(agy, 'grok-acme')).toBe('Gemini Argon 4 medium');

    const grokFile = team();
    const grokScene = live();
    grokScene.agents.push(agent('grok-acme', 'w8', 'idle', 'grok'));
    grokScene.screens['w8:p1'] = 'Grok 4.6 (xhigh) · always-approve\n';
    grokScene.workspaces.push({ id: 'w8', label: 'old' });
    const grok = pass({ team: grokFile, watch: grokFile.watch, state: emptySession(), live: grokScene, machine: fine, now: 0, memory: newMemory() });
    const grokLine = line(grok, 'grok-acme');
    expect(grokLine).toBe('Grok 4.6 xhigh');
    expect(grokLine?.startsWith('grok ')).toBe(false);
    expect(grok.labels.find((item) => item.name === 'grok-acme')?.title).toBe('grok-acme · reviewer');
  });
});
