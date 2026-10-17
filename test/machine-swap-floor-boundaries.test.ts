// The machine gate's free-swap floor is 100MB when the file sets none, and the guards before it
// are the primary ones: load per core, free memory, free disk, each named before swap when
// several cross at once. These scenes hold the floor at its line — the reading that sits exactly
// on it passes, the byte under it refuses, a figure not read is neither — and hold the file's own
// `swap_free_min` above the default, so a team that wrote 2GB keeps 2GB.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateTeamFile } from '../src/file/validate.ts';
import { launchLimit, swapTotalProblem, type Machine } from '../src/watch/machine.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');

// A machine inside every start limit, with swap allocated and free above the floor.
const fine: Machine = { loadPerCore: 0.8, memoryFree: 46, diskFree: 200e9, swapTotal: 2.1e9, swapFree: 0.6e9, swapUsed: 1.5e9 };

function limitsOf(text: string) {
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error('the fixture does not validate');
  return checked.team.machine;
}

describe('the free-swap floor on the machine gate', () => {
  test('the floor is exactly 100MB, and a figure not read is no refusal', () => {
    const limits = limitsOf(example);
    expect(limits.swapFreeMin).toBe(100e6);
    expect(launchLimit({ ...fine, swapFree: 100e6 }, limits, [], 0)).toBeNull();
    expect(launchLimit({ ...fine, swapFree: 100e6 - 1, swapUsed: 2.1e9 - 100e6 + 1 }, limits, [], 0)).toBe(
      'free swap is 0.1 GB, below 0.1 GB',
    );
    expect(launchLimit({ ...fine, swapFree: null }, limits, [], 0)).toBeNull();
    // A total that cannot hold the floor is still said, at the new floor as at any other.
    expect(swapTotalProblem({ ...fine, swapTotal: 100e6 }, limits)).toBeNull();
    expect(swapTotalProblem({ ...fine, swapTotal: 100e6 - 1 }, limits)).toContain('the machine check asks for 0.1 GB free swap');
  });

  test('the file\'s own figure is the floor, not the default', () => {
    const limits = limitsOf(example.replace(/(disk_min: 10GB[^\n]*)/, '$1\n  swap_free_min: 2GB'));
    expect(limits.swapFreeMin).toBe(2e9);
    expect(launchLimit({ ...fine, swapFree: 1.5e9, swapUsed: 0.6e9 }, limits, [], 0)).toBe('free swap is 1.5 GB, below 2.0 GB');
    expect(launchLimit({ ...fine, swapFree: 2e9, swapUsed: 0.1e9 }, limits, [], 0)).toBeNull();
  });

  test('the guards are named in order, the first one that crosses', () => {
    const limits = limitsOf(example);
    const empty: Machine = { ...fine, swapFree: 20e6, swapUsed: 2.1e9 - 20e6 };
    expect(launchLimit({ ...empty, diskFree: 5e9 }, limits, [], 0)).toBe('free disk is 5.0 GB, below 10.0 GB');
    expect(launchLimit({ ...empty, loadPerCore: 9, memoryFree: 10, diskFree: 5e9 }, limits, [], 0)).toBe(
      'the load is 9.0 per core, above 3',
    );
  });
});
