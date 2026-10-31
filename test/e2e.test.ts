// What the e2e's own pieces do, checked without herdr so `bun run ci` covers them: the machine
// gate, the row and line matches, the team file the run drives, the screens the fake seat draws,
// and the fake seat itself, spawned here as the run's panes spawn it.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateProblem, hasLine, readGate, rowShown, teamFile, type GateReading } from '../scripts/e2e.ts';
import { isExit, screenFor, type FakeMode } from '../scripts/fake-seat.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { seatModel } from '../src/status/statusline.ts';
import { readScreen } from '../src/watch/screen.ts';

describe('the machine gate', () => {
  const reading: GateReading = { load: 2.5, memoryFree: 40, swapUsed: 1024 };
  test('a machine inside the gate passes it', () => {
    expect(gateProblem(reading, reading)).toBeNull();
  });
  test('a load of 60 or more refuses; 25% free memory is already inside the gate', () => {
    expect(gateProblem({ ...reading, load: 60 }, reading)).toContain('load');
    expect(gateProblem({ ...reading, memoryFree: 24 }, reading)).toContain('memory');
    expect(gateProblem({ ...reading, memoryFree: 25 }, reading)).toBeNull();
  });
  test('swap that grows across the wait refuses: the machine is paging', () => {
    expect(gateProblem(reading, { ...reading, swapUsed: 1024.5 })).toContain('paging');
    // Swap that shrank or held still is no reason to refuse.
    expect(gateProblem(reading, { ...reading, swapUsed: 1023 })).toBeNull();
  });
  test('figures this machine cannot read refuse, rather than pass', () => {
    expect(gateProblem({ ...reading, load: null }, reading)).not.toBeNull();
    expect(gateProblem({ ...reading, memoryFree: null }, reading)).not.toBeNull();
    expect(gateProblem(reading, { ...reading, swapUsed: null })).not.toBeNull();
  });
  test('readGate reads the three figures of this machine, or says null', () => {
    const gate = readGate();
    for (const value of [gate.load, gate.memoryFree, gate.swapUsed]) {
      expect(value === null || Number.isFinite(value)).toBe(true);
    }
  });
});

describe('reading the output of a command and its log', () => {
  // A status row as `printComparison` lays it out: cells two spaces apart.
  const out = [
    'agent               state   model             pane',
    '  fake-work          idle    Claude Opus 5.5',
    '  fake-coordinator   idle    Claude Opus 5.5   w1:p1',
  ].join('\n');
  test('a row reads by name, then state, then model', () => {
    expect(rowShown(out, 'fake-work', 'idle', 'Claude Opus 5.5')).toBe(true);
    expect(rowShown(out, 'fake-coordinator', 'idle', 'Claude Opus 5.5')).toBe(true);
    expect(rowShown(out, 'fake-work', 'working', 'Claude Opus 5.5')).toBe(false);
    expect(rowShown(out, 'fake-work', 'idle', 'Claude Sonnet 5.5')).toBe(false);
    expect(rowShown(out, 'fake-nobody', 'idle', 'Claude Opus 5.5')).toBe(false);
  });
  test('a log line matches whole, not across spaces', () => {
    const lines = ['2026-10-04T00:00:00.000Z watch [watch] every agent is idle'];
    expect(hasLine(lines, 'watch [watch] every agent is idle')).toBe(true);
    expect(hasLine(lines, 'watch [watch]  every agent')).toBe(false);
    expect(hasLine([], 'anything')).toBe(false);
  });
});

describe('the team file the run drives', () => {
  test('it validates, with the two fake seats the steps name', () => {
    const text = teamFile({ coordinator: 'bash -c run-fake-1', worker: 'bash -c run-fake-2' });
    const result = validateTeamFile(text);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.team.session).toBe('sandbox-e2e');
    expect(result.team.seats.map((seat) => seat.name)).toEqual(['fake-coordinator', 'fake-work']);
    // Its machine limits are wide open: the gate is the script's own, read before anything runs.
    expect(result.team.machine.loadStart).toBe(60);
    expect(result.team.machine.memoryStart).toBe(0);
  });
});

describe('the fake seat', () => {
  test('each mode draws the screen the commands classify it as', () => {
    const kinds: Record<FakeMode, 'idle' | 'unsent' | 'permission'> = { idle: 'idle', unsent: 'unsent', permission: 'permission' };
    for (const [mode, kind] of Object.entries(kinds)) {
      expect(readScreen('claude-code', screenFor(mode as FakeMode)).kind).toBe(kind);
    }
  });
  test('its idle screen names the model the seats of the run declare', () => {
    expect(seatModel({ cli: 'claude-code', model: 'Claude Opus' }, screenFor('idle'))).toEqual({
      model: 'Claude Opus',
      version: '5.5',
    });
  });
  test('the exit is the text and the Enter: the text alone leaves it seated', () => {
    expect(isExit('/exit')).toBe(false);
    expect(isExit('/exit\r')).toBe(true);
    expect(isExit('/exit\n')).toBe(true);
  });
  test('spawned as the panes spawn it, it logs what it receives and leaves on /exit and Enter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-e2e-seat-'));
    const log = join(dir, 'seat.log');
    const script = join(import.meta.dir, '..', 'scripts', 'fake-seat.ts');
    const seat = Bun.spawn([process.execPath, script, 'idle', log], {
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'inherit',
    });
    try {
      // The log file appears before the screen is drawn: once it is there, the seat is seated.
      const until = Date.now() + 5_000;
      while (!existsSync(log) && Date.now() < until) await Bun.sleep(20);
      expect(existsSync(log)).toBe(true);

      seat.stdin.write('/exit');
      await seat.stdin.flush();
      await Bun.sleep(200);
      expect(seat.exitCode).toBeNull();

      seat.stdin.write('\r');
      await seat.stdin.flush();
      const code = await Promise.race([seat.exited, Bun.sleep(3_000).then(() => 'timeout' as const)]);
      expect(code).toBe(0);
      const bytes = readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string)
        .join('');
      expect(bytes).toBe('/exit\r');
    } finally {
      seat.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
