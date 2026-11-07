// The first-minute scene is red until `team start` exists, and a complete proof
// inside the budgets is the only green. The trial uses a temporary home and a
// binary the test supplies. It does not read a credential path.
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessMinute, formatMarks, missingStart, runTrial, type MinuteClock, type MinuteProof } from '../scripts/first-minute.ts';

const clock = (over: Partial<MinuteClock> = {}): MinuteClock => ({
  elapsedMs: 20_000,
  bootstrapMs: 1_000,
  detectMs: 1_000,
  upMs: 1_000,
  exchangeMs: 1_000,
  startedMs: 1_000,
  ...over,
});

const proof = (over: Partial<MinuteProof> = {}): MinuteProof => ({
  versionOk: true,
  daemonRunning: true,
  roots: 1,
  teamFile: true,
  checkClean: true,
  readyLead: true,
  readyBuilder: true,
  exchangeId: 'task-1',
  exchangeArrived: true,
  exchangeRead: true,
  working: true,
  claimedTask: 'task-1',
  ...over,
});

describe('first-minute scene', () => {
  test('a complete proof inside the budgets is green', () => {
    const marks = assessMinute(proof(), clock());
    expect(marks.every((mark) => mark.ok)).toBe(true);
    expect(formatMarks(marks, 20_000)).toContain('total 20000 ms ok');
  });

  test('a trial past 60 seconds is a miss', () => {
    const marks = assessMinute(proof(), clock({ elapsedMs: 60_001 }));
    expect(marks.every((mark) => mark.ok)).toBe(false);
  });

  test('one root is required', () => {
    const marks = assessMinute(proof({ roots: 0 }), clock());
    expect(marks.find((mark) => mark.step === 'bootstrap')?.ok).toBe(false);
  });

  test('the claimed task is the exchanged id', () => {
    const marks = assessMinute(proof({ claimedTask: 'other' }), clock());
    expect(marks.find((mark) => mark.step === 'started')?.ok).toBe(false);
    expect(marks.find((mark) => mark.step === 'exchange')?.ok).toBe(false);
  });

  test('a step past its own budget is a miss', () => {
    const marks = assessMinute(proof(), clock({ upMs: 15_001 }));
    expect(marks.find((mark) => mark.step === 'up')?.ok).toBe(false);
    expect(marks.find((mark) => mark.step === 'detect')?.ok).toBe(true);
  });

  test('an unknown start command is the missing-command miss', () => {
    expect(missingStart(2, 'team: unknown command "start"\n')).toBe(true);
    expect(missingStart(1, 'team: unknown command "start"\n')).toBe(false);
    const home = mkdtempSync(join(tmpdir(), 'first-minute-'));
    const bin = join(home, 'team');
    writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.0.0; exit 0; fi\necho \'team: unknown command "start"\' >&2\nexit 2\n');
    chmodSync(bin, 0o755);
    const trial = runTrial({ bin, home: join(home, 'account'), path: '/usr/bin:/bin' });
    expect(trial.ok).toBe(false);
    expect(trial.text).toContain('team start is not a command');
    expect(trial.text).toContain('install 0 ms ok');
  });
});
