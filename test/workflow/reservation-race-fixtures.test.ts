// The race harness's own proof: two driver processes start behind one file barrier, both
// answer their one JSON line, and both effects land; a single driver answers the same way; an
// unknown command is a refused answer, not a crash or a silent zero. This is test
// infrastructure coverage for the reservation race suite, written against the committed
// harness at this branch and importing no product slice.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDriver, runPair } from './reservation-race-fixtures.ts';

const DRIVER = join(import.meta.dir, 'reservation-race-probe-driver.ts');

describe('reservation race fixtures', () => {
  test('two drivers behind the barrier both run and both answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reservation-probe-pair-'));
    try {
      const path = join(dir, 'lines.txt');
      const [first, second] = await runPair<{ text: string }>(
        DRIVER,
        { command: 'append', args: { path, text: 'first' } },
        { command: 'append', args: { path, text: 'second' } },
      );
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(first.answer).toEqual({ ok: true, result: { text: 'first' } });
      expect(second.answer).toEqual({ ok: true, result: { text: 'second' } });
      expect(readFileSync(path, 'utf8').trim().split('\n').sort()).toEqual(['first', 'second']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('one driver answers in the same protocol', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reservation-probe-single-'));
    try {
      const path = join(dir, 'lines.txt');
      const run = await runDriver<{ text: string }>(DRIVER, 'append', { path, text: 'solo' });
      expect(run.code).toBe(0);
      expect(run.answer).toEqual({ ok: true, result: { text: 'solo' } });
      expect(readFileSync(path, 'utf8')).toBe('solo\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unknown command is a refused answer with its own exit code', async () => {
    const run = await runDriver<never>(DRIVER, 'unknown', {});
    expect(run.code).toBe(2);
    expect(run.answer).toEqual({ ok: false, error: 'unknown command unknown' });
  });
});
