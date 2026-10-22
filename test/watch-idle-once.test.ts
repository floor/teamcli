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
  test('default: a seat idle for three hours yields one lead report (at idle_first), one owner report (at idle_owner), and one work drop', () => {
    const file = valid(defaultExample);
    expect(file.watch.idleRepeat).toBeUndefined();

    const memory = newMemory();
    const live = liveScene({
      'deepseek-acme': { status: 'idle', screen: idleScreen },
    });

    const reports: string[] = [];
    let drops = 0;

    // Simulate 3 hours (180 minutes) with a pass every 2 minutes (interval: 120s):
    for (let minute = 0; minute <= 180; minute += 2) {
      const now = minute * MIN;
      const result = pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now, memory });
      for (const r of result.reports) reports.push(r.text);
      drops += result.work.length;
    }

    // Exactly one lead report (at 5m), one owner report (at 15m) and one drop across the 3 hours.
    expect(reports).toEqual([
      'deepseek-acme has been idle since the watch started',
      'deepseek-acme has been idle since the watch started — reported to the owner',
    ]);
    expect(drops).toBe(1);
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
    expect(p0.work).toEqual([]);

    // 10m: idle_first (5m) already reached -> the report, and the work drop that reaches the seat
    const p10 = pass({
      team: file, watch: file.watch, state: emptySession(),
      live: liveScene({ 'deepseek-acme': { status: 'idle', screen: idleScreen } }),
      machine: fine, now: 10 * MIN, memory,
    });
    expect(p10.reports.map((r) => r.text)).toEqual(['deepseek-acme has been idle since the watch started']);
    expect(p10.work).toEqual([{ pane: 'w3:p1', seat: 'deepseek-acme', cli: 'claude-code', body: NUDGE_TEXT }]);

    // 14m: still quiet, idle_owner (15m) not reached -> no repeat, and no second drop
    const p14 = pass({
      team: file, watch: file.watch, state: emptySession(),
      live: liveScene({ 'deepseek-acme': { status: 'idle', screen: idleScreen } }),
      machine: fine, now: 14 * MIN, memory,
    });
    expect(p14.reports).toEqual([]);
    expect(p14.work).toEqual([]);

    // 20m: deepseek works mid-turn!
    const p20 = pass({
      team: file, watch: file.watch, state: emptySession(),
      live: liveScene({ 'deepseek-acme': { status: 'working', screen: workingScreen } }),
      machine: fine, now: 20 * MIN, memory,
    });
    expect(p20.reports).toEqual([]);
    expect(p20.work).toEqual([]);

    // 24m: deepseek goes idle again (4 minutes since work)
    const p24 = pass({
      team: file, watch: file.watch, state: emptySession(),
      live: liveScene({ 'deepseek-acme': { status: 'idle', screen: idleScreen } }),
      machine: fine, now: 24 * MIN, memory,
    });
    expect(p24.reports).toEqual([]);

    // 30m: 10 minutes since work at 20m -> reports the new period with its duration
    const p30 = pass({
      team: file, watch: file.watch, state: emptySession(),
      live: liveScene({ 'deepseek-acme': { status: 'idle', screen: idleScreen } }),
      machine: fine, now: 30 * MIN, memory,
    });
    expect(p30.reports.map((r) => r.text)).toEqual(['deepseek-acme has been idle for 10 minutes']);
    expect(p30.work.map((item) => item.seat)).toEqual(['deepseek-acme']);

    // 50m: past idle_owner (15m since work at 20m) -> the owner is told, once for this period
    const p50 = pass({
      team: file, watch: file.watch, state: emptySession(),
      live: liveScene({ 'deepseek-acme': { status: 'idle', screen: idleScreen } }),
      machine: fine, now: 50 * MIN, memory,
    });
    expect(p50.reports).toEqual([{ key: 'idle-owner:deepseek-acme', text: 'deepseek-acme has been idle for 30 minutes — reported to the owner', to: 'owner' }]);
    expect(p50.work).toEqual([]);
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
        // The lead's report only: the owner's carries the same words and its own key.
        if (r.to === 'operator' && r.text.includes('idle since the watch started')) count++;
      }
    }
    expect(count).toBe(1);
  });

  test('the report never reaches a seat: the idle seat gets only its work drop and its body is the fixed line', () => {
    const file = valid(defaultExample);
    const memory = newMemory();
    const live = liveScene({
      'deepseek-acme': { status: 'idle', screen: idleScreen },
    });

    // Run across 3 hours:
    for (let minute = 0; minute <= 180; minute += 2) {
      const now = minute * MIN;
      const result = pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now, memory });
      for (const drop of result.work) {
        // What the seat is asked to read is the fixed watch line, never a report's text.
        expect(drop.body).toBe(NUDGE_TEXT);
        for (const report of result.reports) expect(drop.body).not.toContain(report.text);
      }
    }
  });

  test('an idle seat is reached on the pass that reports it, once per period unless idle_repeat is set', () => {
    const brisk = valid(defaultExample.replace('  idle_first: 5m', '  idle_first: 1m\n  idle_repeat: 2m'));
    const memory = newMemory();
    const live = liveScene({
      'claude-operator-acme': { status: 'working', screen: workingScreen },
      'deepseek-acme': { status: 'idle', screen: idleScreen },
    });

    pass({ team: brisk, watch: brisk.watch, state: emptySession(), live, machine: fine, now: 0, memory });

    const p1 = pass({ team: brisk, watch: brisk.watch, state: emptySession(), live, machine: fine, now: 1 * MIN, memory });
    expect(p1.reports.map((r) => r.text)).toEqual(['deepseek-acme has been idle since the watch started']);
    expect(p1.work).toEqual([{ pane: 'w3:p1', seat: 'deepseek-acme', cli: 'claude-code', body: NUDGE_TEXT }]);

    const p3 = pass({ team: brisk, watch: brisk.watch, state: emptySession(), live, machine: fine, now: 3 * MIN, memory });
    expect(p3.reports.map((r) => r.text)).toEqual(['deepseek-acme has been idle since the watch started']);
    expect(p3.work).toEqual([{ pane: 'w3:p1', seat: 'deepseek-acme', cli: 'claude-code', body: NUDGE_TEXT }]);
  });

  test('idle_repeat: 20m set repeats every 20 minutes (assert against sequence)', () => {
    const file = valid(repeatExample);
    expect(file.watch.idleRepeat).toBe(1200);

    const memory = newMemory();
    const live = liveScene({
      'deepseek-acme': { status: 'idle', screen: idleScreen },
    });

    const reportTimes: number[] = [];
    const dropTimes: number[] = [];

    for (let minute = 0; minute <= 180; minute += 2) {
      const now = minute * MIN;
      const result = pass({ team: file, watch: file.watch, state: emptySession(), live, machine: fine, now, memory });
      if (result.reports.length > 0) reportTimes.push(minute);
      if (result.work.length > 0) dropTimes.push(minute);
    }

    // The lead at idle_first (5m), then every idle_repeat (20m); the owner once, at idle_owner
    // (15m). The work drop follows the lead's cadence: the owner's escalation is not a drop.
    expect(reportTimes).toEqual([6, 16, 26, 46, 66, 86, 106, 126, 146, 166]);
    expect(dropTimes).toEqual([6, 26, 46, 66, 86, 106, 126, 146, 166]);
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

  test('a native-held seat types no work drop and gets no idle report, while an unheld sibling is unchanged', () => {
    const file = valid(defaultExample);
    const live = liveScene({
      'deepseek-acme': { status: 'idle', screen: idleScreen },
      'deepseek-acme-2': { status: 'idle', screen: idleScreen },
    });
    const heldMemory = newMemory();
    const hold = new Set(['deepseek-acme']);
    pass({
      team: file, watch: file.watch, state: emptySession(), live, machine: fine,
      now: 0, memory: heldMemory, nativeHeld: hold,
    });
    const held = pass({
      team: file, watch: file.watch, state: emptySession(), live, machine: fine,
      now: 10 * MIN, memory: heldMemory, nativeHeld: hold,
    });
    // The held seat's pane is idle and its box is empty: only the native hold keeps both the
    // work drop and the idle report away. Its sibling takes the ordinary path in the same pass.
    expect(held.work).toEqual([{ pane: 'w4:p1', seat: 'deepseek-acme-2', cli: 'claude-code', body: NUDGE_TEXT }]);
    expect(held.reports.map((r) => r.text)).toEqual(['deepseek-acme-2 has been idle since the watch started']);

    // The same instant with no hold is the ordinary pass: both seats are reported and dropped, so
    // the hold is the only difference.
    const controlMemory = newMemory();
    pass({
      team: file, watch: file.watch, state: emptySession(), live, machine: fine,
      now: 0, memory: controlMemory,
    });
    const control = pass({
      team: file, watch: file.watch, state: emptySession(), live, machine: fine,
      now: 10 * MIN, memory: controlMemory,
    });
    expect(control.work.map((drop) => drop.seat).sort()).toEqual(['deepseek-acme', 'deepseek-acme-2']);
    expect(control.reports.map((r) => r.text)).toEqual(expect.arrayContaining([
      'deepseek-acme has been idle since the watch started',
      'deepseek-acme-2 has been idle since the watch started',
    ]));

    // The held pass cleared the seat's stretch; once the hold lifts it is due at idle_first again,
    // and the sibling, already served, is not.
    const freed = pass({
      team: file, watch: file.watch, state: emptySession(), live, machine: fine,
      now: 20 * MIN, memory: heldMemory,
    });
    expect(freed.work.map((drop) => drop.seat)).toEqual(['deepseek-acme']);
  });

  test('a native-held seat is not rung and takes no pause notice; both wait for the hold to lift', () => {
    const file = valid(defaultExample);
    const live = liveScene({ 'deepseek-acme': { status: 'idle', screen: idleScreen } });
    const mailbox = [{
      id: 'msg-1', to: 'deepseek-acme', at: 0, pane: 'w3:p1', status: 'idle',
      cli: 'claude-code', screen: idleScreen, served: true,
    }];
    const held = pass({
      team: file, watch: file.watch, state: emptySession(), live, machine: fine,
      now: 10 * MIN, memory: newMemory(), mailbox, nativeHeld: new Set(['deepseek-acme']),
    });
    expect(held.ring).toBeNull();

    const control = pass({
      team: file, watch: file.watch, state: emptySession(), live, machine: fine,
      now: 10 * MIN, memory: newMemory(), mailbox,
    });
    expect(control.ring).toMatchObject({ pane: 'w3:p1', to: 'deepseek-acme', id: 'msg-1' });

    // The pause's own notice is typed too: skipped under the hold, and written once it lifts.
    const pause = { by: 'owner', at: new Date(0).toISOString(), stops: [] };
    const memory = newMemory();
    const heldPause = pass({
      team: file, watch: file.watch, state: emptySession(), live, machine: fine,
      now: 10 * MIN, memory, pause, nativeHeld: new Set(['deepseek-acme']),
    });
    expect(heldPause.work).toEqual([]);
    const freedPause = pass({
      team: file, watch: file.watch, state: emptySession(), live, machine: fine,
      now: 11 * MIN, memory, pause,
    });
    expect(freedPause.work.map((drop) => drop.seat)).toEqual(['deepseek-acme']);
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
