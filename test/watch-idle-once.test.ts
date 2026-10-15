import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf, watchInForceOf } from '../src/approve/approval.ts';
import { legacyWatchDigest } from '../src/approve/fingerprint.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { storePath, writeApproval, type Standing } from '../src/store/store.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, NUDGE_TEXT, pass } from '../src/watch/pass.ts';

const MIN = 60_000;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idleScreen = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const workingScreen = `✶ Working…\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;

const rawExample = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8')
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

// Default file without idle_repeat in watch:
const defaultExample = rawExample.replace(/  idle_repeat: 20m[^\n]*\n/, '');

// Example with explicit idle_repeat: 20m:
const repeatExample = rawExample;

function valid(source: string): TeamFile {
  const result = validateTeamFile(source);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function agent(name: string, workspace: string, status = 'idle'): HerdrAgent {
  return {
    workspace,
    pane: `${workspace}:p1`,
    agent: name.startsWith('codex') ? 'codex' : 'claude',
    name,
    status,
    cwd: null,
  };
}

function liveScene(over: Partial<Record<string, { status?: string; screen?: string }>> = {}): Live {
  const seats: [string, string, string, string][] = [
    ['claude-operator-acme', 'w0', 'idle', idleScreen],
    ['claude-coordinator-acme', 'w1', 'working', workingScreen],
    ['codex-acme', 'w2', 'working', workingScreen],
    ['deepseek-acme', 'w3', 'working', workingScreen],
    ['deepseek-acme-2', 'w4', 'working', workingScreen],
  ];
  const agents: HerdrAgent[] = [];
  const screens: Record<string, string> = {};
  for (const [name, workspace, status, screen] of seats) {
    const change = over[name] ?? {};
    agents.push(agent(name, workspace, change.status ?? status));
    screens[`${workspace}:p1`] = change.screen ?? screen;
  }
  return {
    running: true,
    agents,
    workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })),
    screens,
  };
}

describe('watch idle reports (once per period by default, repeat on request)', () => {
  test('default: a seat idle for three hours yields exactly one report (at idle_first) and one nudge', () => {
    const file = valid(defaultExample);
    expect(file.watch.idleRepeat).toBeUndefined();

    const memory = newMemory();
    const live = liveScene({
      'deepseek-acme': { status: 'idle', screen: idleScreen },
    });

    const reports: string[] = [];
    let nudges = 0;

    // Simulate 3 hours (180 minutes) with a pass every 2 minutes (interval: 120s):
    for (let minute = 0; minute <= 180; minute += 2) {
      const now = minute * MIN;
      const result = pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now, memory });
      for (const r of result.reports) reports.push(r.text);
      if (result.nudge) nudges++;
    }

    // Exactly one report and one nudge across the entire 3 hours:
    expect(reports).toEqual(['deepseek-acme has been idle since the watch started']);
    expect(nudges).toBe(1);
    expect(memory.pending).toEqual([]);
    expect(memory.pendingSince).toBeNull();
  });

  test('a new period reports again: idle -> reported -> works -> idle again -> reported again after idle_first', () => {
    const file = valid(defaultExample);
    const memory = newMemory();

    // 0m: deepseek starts quiet
    const p0 = pass({
      team: file, watch: file.watch, state: emptySession(),
      live: liveScene({ 'deepseek-acme': { status: 'idle', screen: idleScreen } }),
      machine: fine, now: 0, memory,
    });
    expect(p0.reports).toEqual([]);
    expect(p0.nudge).toBeNull();

    // 10m: idle_first reached -> reports and nudges
    const p10 = pass({
      team: file, watch: file.watch, state: emptySession(),
      live: liveScene({ 'deepseek-acme': { status: 'idle', screen: idleScreen } }),
      machine: fine, now: 10 * MIN, memory,
    });
    expect(p10.reports.map((r) => r.text)).toEqual(['deepseek-acme has been idle since the watch started']);
    expect(p10.nudge).not.toBeNull();

    // 14m: still quiet -> no repeat
    const p14 = pass({
      team: file, watch: file.watch, state: emptySession(),
      live: liveScene({ 'deepseek-acme': { status: 'idle', screen: idleScreen } }),
      machine: fine, now: 14 * MIN, memory,
    });
    expect(p14.reports).toEqual([]);
    expect(p14.nudge).toBeNull();

    // 20m: deepseek works mid-turn!
    const p20 = pass({
      team: file, watch: file.watch, state: emptySession(),
      live: liveScene({ 'deepseek-acme': { status: 'working', screen: workingScreen } }),
      machine: fine, now: 20 * MIN, memory,
    });
    expect(p20.reports).toEqual([]);
    expect(p20.nudge).toBeNull();

    // 24m: deepseek goes idle again (4 minutes since work)
    const p24 = pass({
      team: file, watch: file.watch, state: emptySession(),
      live: liveScene({ 'deepseek-acme': { status: 'idle', screen: idleScreen } }),
      machine: fine, now: 24 * MIN, memory,
    });
    expect(p24.reports).toEqual([]);

    // 30m: 10 minutes since work at 20m -> reports new period with duration!
    const p30 = pass({
      team: file, watch: file.watch, state: emptySession(),
      live: liveScene({ 'deepseek-acme': { status: 'idle', screen: idleScreen } }),
      machine: fine, now: 30 * MIN, memory,
    });
    expect(p30.reports.map((r) => r.text)).toEqual(['deepseek-acme has been idle for 10 minutes']);
    expect(p30.nudge).not.toBeNull();

    // 50m: stays quiet -> no repeated report for this new period
    const p50 = pass({
      team: file, watch: file.watch, state: emptySession(),
      live: liveScene({ 'deepseek-acme': { status: 'idle', screen: idleScreen } }),
      machine: fine, now: 50 * MIN, memory,
    });
    expect(p50.reports).toEqual([]);
    expect(p50.nudge).toBeNull();
  });

  test('"idle since the watch started" is reported once in a run of three hours', () => {
    const file = valid(defaultExample);
    const memory = newMemory();
    const live = liveScene({
      'deepseek-acme': { status: 'idle', screen: idleScreen },
    });

    let count = 0;
    for (let minute = 0; minute <= 180; minute += 1) {
      const result = pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now: minute * MIN, memory });
      for (const r of result.reports) {
        if (r.text.includes('idle since the watch started')) count++;
      }
    }
    expect(count).toBe(1);
  });

  test('no nudge without a new report: pending list does not grow and fallback is not produced for delivered report', () => {
    const file = valid(defaultExample);
    const memory = newMemory();
    const live = liveScene({
      'deepseek-acme': { status: 'idle', screen: idleScreen },
    });

    // Run across 3 hours:
    for (let minute = 0; minute <= 180; minute += 2) {
      const now = minute * MIN;
      const result = pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now, memory });
      expect(result.fallback).toBeNull();
      if (minute > 10) {
        expect(result.nudge).toBeNull();
        expect(memory.pending).toEqual([]);
      }
    }
  });

  test('an idle seat is nudged on the pass that reports it, and a repeat does not duplicate pending', () => {
    const brisk = valid(defaultExample.replace('  idle_first: 10m', '  idle_first: 1m\n  idle_repeat: 2m'));
    const memory = newMemory();
    const live = liveScene({
      'claude-operator-acme': { status: 'working', screen: workingScreen },
      'deepseek-acme': { status: 'idle', screen: idleScreen },
    });

    pass({ team: brisk, watch: brisk.watch, state: emptySession(), live, machine: fine, now: 0, memory });

    const p1 = pass({ team: brisk, watch: brisk.watch, state: emptySession(), live, machine: fine, now: 1 * MIN, memory });
    expect(p1.reports.map((r) => r.text)).toEqual(['deepseek-acme has been idle since the watch started']);
    expect(p1.nudge).toEqual({
      pane: 'w3:p1',
      seat: 'deepseek-acme',
      cli: 'claude-code',
      text: NUDGE_TEXT,
      pending: ['deepseek-acme has been idle since the watch started'],
    });
    expect(memory.pending).toEqual([]);

    const p3 = pass({ team: brisk, watch: brisk.watch, state: emptySession(), live, machine: fine, now: 3 * MIN, memory });
    expect(p3.reports.map((r) => r.text)).toEqual(['deepseek-acme has been idle since the watch started']);
    expect(p3.nudge?.pending).toEqual(['deepseek-acme has been idle since the watch started']);
    expect(memory.pending).toEqual([]);
  });

  test('a box holding exactly the watch\'s line, that this process never typed, is not free', () => {
    // The reviewer's case: the line is one fixed public constant, so a person or an agent who
    // typed it themselves holds a box that reads exactly like a leftover of the watch's. The
    // text proves nothing: with no record in this process of typing it, the box is its owner's,
    // and the pass raises no nudge into it.
    const file = valid(defaultExample
      .replace('  idle_first: 10m', '  idle_first: 1m\n  idle_repeat: 2m')
      .replace('  unsent_after: 1m', '  unsent_after: 1h'));
    const memory = newMemory();
    const nudgeBox = `${RULE}\n❯ ${NUDGE_TEXT}\n${RULE}\n${STATUS}\n`;
    const live = liveScene({
      'deepseek-acme': { status: 'idle', screen: nudgeBox },
    });
    pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now: 0, memory });
    const p1 = pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now: 1 * MIN, memory });
    expect(p1.nudge).toBeNull();
    expect(memory.pending).toEqual(['deepseek-acme has been idle since the watch started']);
  });

  test('a box holding the line this process recorded typing is free: the pass raises the nudge', () => {
    // The same box, after this process typed the line itself and its Enter never went out. The
    // pass acts on the record of the typing, in this pane — and on nothing else.
    const file = valid(defaultExample
      .replace('  idle_first: 10m', '  idle_first: 1m\n  idle_repeat: 2m')
      .replace('  unsent_after: 1m', '  unsent_after: 1h'));
    const memory = newMemory();
    memory.ownNudge = { pane: 'w3:p1', text: NUDGE_TEXT };
    const nudgeBox = `${RULE}\n❯ ${NUDGE_TEXT}\n${RULE}\n${STATUS}\n`;
    const live = liveScene({
      'deepseek-acme': { status: 'idle', screen: nudgeBox },
    });
    pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now: 0, memory });
    const p1 = pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now: 1 * MIN, memory });
    expect(p1.nudge).toEqual({
      pane: 'w3:p1',
      seat: 'deepseek-acme',
      cli: 'claude-code',
      text: NUDGE_TEXT,
      pending: ['deepseek-acme has been idle since the watch started'],
    });
  });

  test('a box holding any other text is not free, and the pass raises no nudge', () => {
    const file = valid(defaultExample
      .replace('  idle_first: 10m', '  idle_first: 1m\n  idle_repeat: 2m')
      .replace('  unsent_after: 1m', '  unsent_after: 1h'));
    const memory = newMemory();
    const otherBox = `${RULE}\n❯ Brief: take the next task from the queue\n${RULE}\n${STATUS}\n`;
    const live = liveScene({
      'deepseek-acme': { status: 'idle', screen: otherBox },
    });
    pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now: 0, memory });
    const p1 = pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now: 1 * MIN, memory });
    expect(p1.nudge).toBeNull();
    expect(memory.pending).toEqual(['deepseek-acme has been idle since the watch started']);
  });

  test('idle_repeat: 20m set repeats every 20 minutes (assert against sequence)', () => {
    const file = valid(repeatExample);
    expect(file.watch.idleRepeat).toBe(1200);

    const memory = newMemory();
    const live = liveScene({
      'deepseek-acme': { status: 'idle', screen: idleScreen },
    });

    const reportTimes: number[] = [];
    const nudgeTimes: number[] = [];

    for (let minute = 0; minute <= 180; minute += 2) {
      const now = minute * MIN;
      const result = pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now, memory });
      if (result.reports.length > 0) reportTimes.push(minute);
      if (result.nudge) nudgeTimes.push(minute);
    }

    const expectedTimes = [10, 30, 50, 70, 90, 110, 130, 150, 170];
    expect(reportTimes).toEqual(expectedTimes);
    expect(nudgeTimes).toEqual(expectedTimes);
  });

  test('idle_repeat validation: smallest (1s) and largest (1000h) values pass, zero and negative refused', () => {
    // 1s passes:
    const file1s = valid(defaultExample.replace('watch:\n', 'watch:\n  idle_repeat: 1s\n'));
    expect(file1s.watch.idleRepeat).toBe(1);

    // 1000h passes:
    const file1000h = valid(defaultExample.replace('watch:\n', 'watch:\n  idle_repeat: 1000h\n'));
    expect(file1000h.watch.idleRepeat).toBe(3600000);

    // Bare 0 refused:
    const zero = validateTeamFile(defaultExample.replace('watch:\n', 'watch:\n  idle_repeat: 0\n'));
    expect(zero.ok).toBe(false);
    if (!zero.ok) {
      expect(zero.errors[0]?.message).toContain('watch.idle_repeat needs a value with its unit (s, m, h)');
    }

    // Negative refused:
    const negative = validateTeamFile(defaultExample.replace('watch:\n', 'watch:\n  idle_repeat: -1\n'));
    expect(negative.ok).toBe(false);
    if (!negative.ok) {
      expect(negative.errors[0]?.message).toContain('watch.idle_repeat needs a value with its unit (s, m, h)');
    }

    // Negative with unit refused:
    const negativeUnit = validateTeamFile(defaultExample.replace('watch:\n', 'watch:\n  idle_repeat: -1s\n'));
    expect(negativeUnit.ok).toBe(false);
    if (!negativeUnit.ok) {
      expect(negativeUnit.errors[0]?.message).toContain('watch.idle_repeat needs a value with its unit (s, m, h)');
    }
  });

  test('lead and parked seats are skipped from idle reports', () => {
    const file = valid(repeatExample);
    const memory = newMemory();

    // coordinator, operator, parked codex-acme, and normal worker deepseek-acme all idle
    const live = liveScene({
      'claude-coordinator-acme': { status: 'idle', screen: idleScreen },
      'claude-operator-acme': { status: 'idle', screen: idleScreen },
      'codex-acme': { status: 'idle', screen: idleScreen },
      'deepseek-acme': { status: 'idle', screen: idleScreen },
      'deepseek-acme-2': { status: 'working', screen: workingScreen },
    });

    pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now: 0, memory });
    const result = pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now: 10 * MIN, memory });
    expect(result.reports.map((r) => r.text)).toEqual(['deepseek-acme has been idle since the watch started']);
  });
});

describe('approvals and legacy watch digest', () => {
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'team-idle-approval-')));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('a file approved before this change (without idle_repeat) does not differ and does not prompt for approval', () => {
    const loaded = valid(defaultExample);
    const store = storePath(loaded.project, home, home);
    mkdirSync(store, { recursive: true });

    // Simulate an approval record written before this change:
    // Its fingerprints.sections['watch'] was computed with the old default (idleRepeat: 1200).
    const legacyDigest = legacyWatchDigest(loaded);
    expect(legacyDigest).not.toBeNull();

    const approval = approvalOf(loaded, home);
    approval.fingerprints.sections['watch'] = legacyDigest!;

    writeApproval(store, { approval, file: defaultExample }, [], home);

    // Validate the current file (which has no idle_repeat, so new default):
    const current = valid(defaultExample);

    // Verify approvalDifferences reports NO differences:
    expect(approvalDifferences(current, home, home)).toEqual([]);

    // Verify watchInForceOf runs with the file's watch values (idleRepeat undefined):
    const standing: Standing = {
      kind: 'verified',
      record: { approval, file: defaultExample },
      generation: 1,
      signedAt: new Date().toISOString(),
    };
    const inForce = watchInForceOf(standing, current);
    expect(inForce.idleRepeat).toBeUndefined();
  });

  test('a file approved with idle_repeat set keeps repeating at that interval', () => {
    const loaded = valid(repeatExample);
    const store = storePath(loaded.project, home, home);
    mkdirSync(store, { recursive: true });

    const approval = approvalOf(loaded, home);
    writeApproval(store, { approval, file: repeatExample }, [], home);

    const current = valid(repeatExample);
    expect(approvalDifferences(current, home, home)).toEqual([]);

    const standing: Standing = {
      kind: 'verified',
      record: { approval, file: repeatExample },
      generation: 1,
      signedAt: new Date().toISOString(),
    };
    const inForce = watchInForceOf(standing, current);
    expect(inForce.idleRepeat).toBe(1200);
  });
});
