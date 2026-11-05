// Scenes for the process adapter's CPU-time fact: the parser against the shapes the time column
// prints, and real readings of this test process. The adapter is the only place a process query
// is named; every other scene injects a fake through the same interface.
import { describe, expect, test } from 'bun:test';
import { parseCpuTime, processCpuTimeAsync } from '../src/watch/process-adapter.ts';

describe('the process adapter CPU-time reading', () => {
  test('parses the time-column shapes: minutes, hours and days, with an optional fraction', () => {
    expect(parseCpuTime('  0:00.01')).toBe(10);
    expect(parseCpuTime(' 53:45.87')).toBe(3_225_870);
    expect(parseCpuTime('1-02:03:04.5')).toBe(93_784_500);
    expect(parseCpuTime('00:00:00')).toBe(0);
  });

  test('reads anything it does not recognise, and an empty column, as no reading', () => {
    expect(parseCpuTime('')).toBeNull();
    expect(parseCpuTime('   ')).toBeNull();
    expect(parseCpuTime('nonsense')).toBeNull();
    expect(parseCpuTime('1:2:3:4')).toBeNull();
    expect(parseCpuTime('-1:00')).toBeNull();
  });

  // Known for 0.5.12.1: Linux ps -o time= reports whole seconds without centiseconds, so a
  // 50 ms spin does not advance the reading off macOS.
  test.skipIf(process.platform !== 'darwin')('reads this test process: a number now, and a larger one after it works', async () => {
    const first = await processCpuTimeAsync(process.pid);
    expect(first).not.toBeNull();
    expect(first!).toBeGreaterThanOrEqual(0);
    const until = Date.now() + 50;
    let spin = 0;
    while (Date.now() < until) spin += Math.sqrt(spin + 1);
    expect(spin).toBeGreaterThan(0);
    const second = await processCpuTimeAsync(process.pid);
    expect(second).not.toBeNull();
    expect(second!).toBeGreaterThan(first!);
  });

  test('reads a pid that is not running as no reading', async () => {
    expect(await processCpuTimeAsync(999_999_999)).toBeNull();
  });
});
