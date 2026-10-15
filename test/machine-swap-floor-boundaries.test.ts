// The swap floor at its boundaries. The default fell from 2GB to 100MB: free swap is a floor
// now, not a comfort. The change's own tests re-spell their refusals; the edges left open are
// the floor's own arithmetic — at the figure it passes, one byte under it refuses — the file's
// word still overriding the default, the pass the old default used to refuse, and the order the
// guards check in. The README's fixture row is pinned to the same figure.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { launchLimit } from '../src/watch/machine.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const README = '../docs/commands/README.md';

// The example's machine block sets no swap floor, so the default is in force. Load and memory
// sit well inside their guards; each reading below overrides one figure.
const FINE = { loadPerCore: 0.4, memoryFree: 69, diskFree: 200e9, swapTotal: 8.2e9, swapUsed: 0.1e9 };

function limits(): TeamFile['machine'] {
  const parsed = validateTeamFile(example);
  if (!parsed.ok) throw new Error('the example fixture does not validate');
  return parsed.team.machine;
}

function at(swapFree: number, over: Partial<TeamFile['machine']> = {}): string | null {
  return launchLimit({ ...FINE, swapFree }, { ...limits(), ...over }, [], 0);
}

describe('the swap floor', () => {
  test('at the floor it passes; one byte under it refuses', () => {
    expect(at(100e6), 'the floor itself is not a refusal').toBe(null);
    expect(at(100e6 - 1), 'a byte under the floor must refuse').toBe('free swap is 0.1 GB, below 0.1 GB');
  });

  test('what the old default refused, the floor now passes', () => {
    // 1.1 GB free was a refusal when the default asked for 2 GB; the floor asks only that some
    // swap remain free. This pass is the change — none of the re-spelled tests assert it.
    expect(at(1.1e9), '1.1 GB free is not a refusal on the default floor').toBe(null);
  });

  test('a file that sets its own floor keeps it', () => {
    const text = example.replace('machine:', 'machine:\n  swap_free_min: 2GB');
    const parsed = validateTeamFile(text);
    if (!parsed.ok) throw new Error(`the 2GB fixture does not validate: ${parsed.errors[0]?.message}`);
    const word = launchLimit({ ...FINE, swapFree: 1.2e9 }, parsed.team.machine, [], 0);
    expect(word, 'the file\'s own floor must still refuse').toBe('free swap is 1.2 GB, below 2.0 GB');
    // The same reading passes on the default: only the file\'s word makes it a refusal.
    expect(at(1.2e9), 'the same reading passes where the file sets no floor').toBe(null);
  });

  test('load and memory are checked before the swap floor', () => {
    const both = launchLimit({ ...FINE, loadPerCore: 9, swapFree: 20e6 }, limits(), [], 0);
    expect(both, 'the primary guard names the refusal, not the floor').toBe('the load is 9.0 per core, above 3');
    const memory = launchLimit({ ...FINE, memoryFree: 10, swapFree: 20e6 }, limits(), [], 0);
    expect(memory, 'memory outranks the floor too').toBe('free memory is 10%, below 25%');
  });

  test('the README\'s fixture row names the floor the code enforces', () => {
    const row = readFileSync(new URL(README, import.meta.url), 'utf8').replace(/\s+/g, ' ');
    expect(row.includes('(`small-swap`: a swap total under the 100MB default floor)'), 'README.md parted from the floor').toBe(true);
  });
});
