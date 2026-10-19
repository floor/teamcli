import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GREEN_SLICES_FILE,
  GREEN_SLICES_MAX,
  greenSlicesPath,
  pendingGreenSlices,
  readGreenSliceJournal,
  recordGreenSliceInstall,
  recordGreenSliceReady,
} from '../src/tasks/green-slices.ts';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const EARLIER = new Date('2026-10-19T11:00:00.000Z');

const slice = {
  task: 'OD51-GREEN-SLICES',
  seat: 'builder-7',
  commit: '4cc0afd25',
  version: '0.5.3-hotfix.9',
};

let base: string;
let dir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'team-green-slices-'));
  dir = join(base, '.agents');
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function stored(): { format: number; events: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(greenSlicesPath(dir), 'utf8'));
}

function wroteReady(input: Partial<typeof slice & { at: Date }> = {}): void {
  const recorded = recordGreenSliceReady(dir, { ...slice, at: NOW, ...input });
  if (!recorded.ok) throw new Error(recorded.why);
}

describe('the green-slice journal', () => {
  test('an empty journal has nothing pending and writes no file', () => {
    expect(greenSlicesPath(dir)).toBe(join(dir, GREEN_SLICES_FILE));
    expect(existsSync(greenSlicesPath(dir))).toBe(false);
    expect(readGreenSliceJournal(dir)).toEqual([]);
    expect(pendingGreenSlices(dir)).toEqual([]);
  });

  test('a ready slice is stored as metadata only and waits for the installer', () => {
    const recorded = recordGreenSliceReady(dir, { ...slice, at: NOW });
    if (!recorded.ok) throw new Error(recorded.why);
    expect(recorded.added).toBe(true);
    expect(recorded.event).toEqual({ kind: 'ready', ...slice, at: NOW.toISOString() });

    expect(stored().format).toBe(1);
    expect(stored().events).toHaveLength(1);
    expect(Object.keys(stored().events[0] ?? {}).sort()).toEqual(['at', 'commit', 'kind', 'seat', 'task', 'version']);
    expect(readGreenSliceJournal(dir)).toEqual([{ kind: 'ready', ...slice, at: NOW.toISOString() }]);

    // A ready is not an install: nothing but an install event clears the alert.
    expect(pendingGreenSlices(dir)).toEqual([{
      task: slice.task,
      seat: slice.seat,
      commit: slice.commit,
      version: slice.version,
      readyAt: NOW.toISOString(),
    }]);
  });

  test('a second ready for the same slice is the same fact', () => {
    wroteReady();
    const again = recordGreenSliceReady(dir, { ...slice, seat: 'builder-5', at: EARLIER });
    if (!again.ok) throw new Error(again.why);
    expect(again.added).toBe(false);
    expect(again.event).toEqual({ kind: 'ready', ...slice, at: NOW.toISOString() });
    expect(stored().events).toHaveLength(1);
    expect(pendingGreenSlices(dir)[0]?.seat).toBe('builder-7');
  });

  test('the install acknowledgement is what clears a pending slice', () => {
    wroteReady();
    const installed = recordGreenSliceInstall(dir, {
      task: slice.task,
      commit: slice.commit,
      version: slice.version,
      installedBy: 'builder-1',
      at: NOW,
    });
    if (!installed.ok) throw new Error(installed.why);
    expect(installed.added).toBe(true);
    expect(installed.event.installedBy).toBe('builder-1');
    expect(readGreenSliceJournal(dir).map((event) => event.kind)).toEqual(['ready', 'install']);
    expect(pendingGreenSlices(dir)).toEqual([]);
  });

  test('a second install acknowledgement is idempotent', () => {
    wroteReady();
    const first = recordGreenSliceInstall(dir, {
      task: slice.task,
      commit: slice.commit,
      version: slice.version,
      installedBy: 'builder-1',
      at: NOW,
    });
    if (!first.ok) throw new Error(first.why);
    const again = recordGreenSliceInstall(dir, {
      task: slice.task,
      commit: slice.commit,
      version: slice.version,
      installedBy: 'builder-1',
      at: EARLIER,
    });
    if (!again.ok) throw new Error(again.why);
    expect(again.added).toBe(false);
    expect(again.event).toEqual(first.event);
    expect(readGreenSliceJournal(dir)).toHaveLength(2);
  });

  test('an install of another commit leaves the slice pending', () => {
    wroteReady();
    const installed = recordGreenSliceInstall(dir, {
      task: slice.task,
      commit: 'abcdef123',
      version: slice.version,
      installedBy: 'builder-1',
      at: NOW,
    });
    expect(installed.ok).toBe(true);
    expect(pendingGreenSlices(dir).map((pending) => pending.commit)).toEqual([slice.commit]);
  });

  test('an install recorded before its ready still covers it', () => {
    const installed = recordGreenSliceInstall(dir, {
      task: slice.task,
      commit: slice.commit,
      version: slice.version,
      installedBy: 'builder-1',
      at: EARLIER,
    });
    if (!installed.ok) throw new Error(installed.why);
    wroteReady();
    expect(pendingGreenSlices(dir)).toEqual([]);
  });

  test('pending is keyed by task and commit, keeps the earliest ready and sorts by time', () => {
    wroteReady({ task: 'T-LATE', commit: 'aaaaaaa', at: NOW });
    wroteReady({ task: 'T-EARLY', commit: 'bbbbbbb', at: EARLIER });
    wroteReady({ task: 'T-LATE', commit: 'aaaaaaa', version: '0.5.3-hotfix.10', at: EARLIER });
    expect(pendingGreenSlices(dir)).toEqual([
      { task: 'T-EARLY', seat: 'builder-7', commit: 'bbbbbbb', version: slice.version, readyAt: EARLIER.toISOString() },
      { task: 'T-LATE', seat: 'builder-7', commit: 'aaaaaaa', version: slice.version, readyAt: NOW.toISOString() },
    ]);
  });

  test('invalid metadata is refused and nothing is written', () => {
    const refusals: Array<[string, Parameters<typeof recordGreenSliceReady>[1]]> = [
      ['task', { ...slice, task: 'OD 51', at: NOW }],
      ['task', { ...slice, task: '', at: NOW }],
      ['seat', { ...slice, seat: 'builder 7', at: NOW }],
      ['commit', { ...slice, commit: '4CC0AFD', at: NOW }],
      ['commit', { ...slice, commit: 'abc', at: NOW }],
      ['version', { ...slice, version: '0.5 3', at: NOW }],
      ['time', { ...slice, at: new Date('nope') }],
    ];
    for (const [field, input] of refusals) {
      const recorded = recordGreenSliceReady(dir, input);
      if (recorded.ok) throw new Error(`expected a refusal for ${field}`);
      expect(recorded.why).toContain(field);
    }
    for (const installedBy of ['', 'builder 1']) {
      const recorded = recordGreenSliceInstall(dir, {
        task: slice.task,
        commit: slice.commit,
        version: slice.version,
        installedBy,
        at: NOW,
      });
      if (recorded.ok) throw new Error('expected a refusal for the installer');
      expect(recorded.why).toContain('installer');
    }
    expect(existsSync(greenSlicesPath(dir))).toBe(false);
  });

  test('an extra property is never stored', () => {
    const sneaky = { ...slice, at: NOW, body: 'SECRET BRIEF TEXT' };
    const recorded = recordGreenSliceReady(dir, sneaky);
    if (!recorded.ok) throw new Error(recorded.why);
    expect(readFileSync(greenSlicesPath(dir), 'utf8')).not.toContain('SECRET BRIEF TEXT');
    expect(recorded.event).toEqual({ kind: 'ready', ...slice, at: NOW.toISOString() });
  });

  test('a malformed entry is dropped, and a malformed install leaves its slice pending', () => {
    writeFileSync(greenSlicesPath(dir), `${JSON.stringify({
      format: 1,
      events: [
        { kind: 'ready', ...slice, at: NOW.toISOString() },
        { kind: 'install', task: slice.task, commit: slice.commit, version: slice.version, installedBy: '', at: NOW.toISOString() },
        'junk',
        { kind: 'ready', task: 'T-OTHER', seat: 'builder-5', commit: 'abcdef1', version: slice.version, at: EARLIER.toISOString() },
      ],
    }, null, 2)}\n`);
    expect(readGreenSliceJournal(dir).map((event) => event.kind)).toEqual(['ready', 'ready']);
    expect(pendingGreenSlices(dir).map((pending) => pending.task)).toEqual(['T-OTHER', slice.task]);
  });

  test('a journal that is not a format 1 journal throws a repair message', () => {
    writeFileSync(greenSlicesPath(dir), 'not json');
    expect(() => pendingGreenSlices(dir)).toThrow(/not valid JSON/);
    writeFileSync(greenSlicesPath(dir), JSON.stringify({ format: 2, events: [] }));
    expect(() => readGreenSliceJournal(dir)).toThrow(/format 1/);
  });

  test('the journal is bounded and keeps a pending slice', () => {
    wroteReady({ task: 'T-PENDING', commit: 'aaaaaaa', at: NOW });
    for (let index = 0; index < GREEN_SLICES_MAX + 10; index += 1) {
      const installed = recordGreenSliceInstall(dir, {
        task: `T-INSTALLED-${index}`,
        commit: '4cc0afd25',
        version: slice.version,
        installedBy: 'builder-1',
        at: NOW,
      });
      if (!installed.ok) throw new Error(installed.why);
    }
    expect(readGreenSliceJournal(dir)).toHaveLength(GREEN_SLICES_MAX);
    expect(readGreenSliceJournal(dir).some((event) => event.kind === 'ready')).toBe(true);
    expect(pendingGreenSlices(dir)).toEqual([{
      task: 'T-PENDING',
      seat: 'builder-7',
      commit: 'aaaaaaa',
      version: slice.version,
      readyAt: NOW.toISOString(),
    }]);
  });

  test('a journal full of pending slices refuses a new record instead of dropping an alert', () => {
    for (let index = 0; index < GREEN_SLICES_MAX; index += 1) {
      wroteReady({ task: `T-PENDING-${index}`, commit: 'aaaaaaa', at: NOW });
    }
    expect(pendingGreenSlices(dir)).toHaveLength(GREEN_SLICES_MAX);

    const refused = recordGreenSliceReady(dir, { ...slice, task: 'T-ONE-TOO-MANY', commit: 'bbbbbbb', at: NOW });
    if (refused.ok) throw new Error('expected the full journal to refuse a new slice');
    expect(refused.why).toContain('pending green slices');

    const unrelatedInstall = recordGreenSliceInstall(dir, {
      task: 'T-NEVER-READY',
      commit: 'ccccccc',
      version: slice.version,
      installedBy: 'builder-1',
      at: NOW,
    });
    if (unrelatedInstall.ok) throw new Error('expected the full journal to refuse an install it cannot hold');
    expect(unrelatedInstall.why).toContain('pending green slices');

    // Being already recorded is still idempotent at the bound.
    const again = recordGreenSliceReady(dir, { ...slice, task: 'T-PENDING-0', commit: 'aaaaaaa', at: NOW });
    if (!again.ok) throw new Error(again.why);
    expect(again.added).toBe(false);

    expect(readGreenSliceJournal(dir)).toHaveLength(GREEN_SLICES_MAX);
    expect(pendingGreenSlices(dir)).toHaveLength(GREEN_SLICES_MAX);

    // Acknowledging an install clears its slice and frees the room for the next ready.
    const installed = recordGreenSliceInstall(dir, {
      task: 'T-PENDING-0',
      commit: 'aaaaaaa',
      version: slice.version,
      installedBy: 'builder-1',
      at: NOW,
    });
    if (!installed.ok) throw new Error(installed.why);
    expect(pendingGreenSlices(dir).map((pending) => pending.task)).not.toContain('T-PENDING-0');
    expect(pendingGreenSlices(dir)).toHaveLength(GREEN_SLICES_MAX - 1);

    const accepted = recordGreenSliceReady(dir, { ...slice, task: 'T-ONE-TOO-MANY', commit: 'bbbbbbb', at: NOW });
    if (!accepted.ok) throw new Error(accepted.why);
    expect(accepted.added).toBe(true);
    expect(pendingGreenSlices(dir).map((pending) => pending.task)).toContain('T-ONE-TOO-MANY');
  });

  test('dropping installed history never resurrects a covered slice', () => {
    const events: Array<Record<string, unknown>> = [];
    for (let index = 0; index < GREEN_SLICES_MAX - 2; index += 1) {
      events.push({ kind: 'ready', task: `T-PENDING-${index}`, seat: 'builder-7', commit: 'aaaaaaa', version: slice.version, at: NOW.toISOString() });
    }
    events.push({ kind: 'ready', task: 'T-COVERED', seat: 'builder-7', commit: 'ddddddd', version: slice.version, at: NOW.toISOString() });
    events.push({ kind: 'install', task: 'T-COVERED', commit: 'ddddddd', version: slice.version, installedBy: 'builder-1', at: NOW.toISOString() });
    writeFileSync(greenSlicesPath(dir), `${JSON.stringify({ format: 1, events }, null, 2)}\n`);
    expect(readGreenSliceJournal(dir)).toHaveLength(GREEN_SLICES_MAX);

    const recorded = recordGreenSliceReady(dir, { ...slice, task: 'T-NEW', commit: 'eeeeeee', at: NOW });
    if (!recorded.ok) throw new Error(recorded.why);
    expect(recorded.added).toBe(true);

    expect(readGreenSliceJournal(dir)).toHaveLength(GREEN_SLICES_MAX);
    expect(readGreenSliceJournal(dir).some((event) => event.kind === 'ready' && event.task === 'T-COVERED')).toBe(false);
    const pending = pendingGreenSlices(dir);
    expect(pending.map((entry) => entry.task)).not.toContain('T-COVERED');
    expect(pending.map((entry) => entry.task)).toContain('T-NEW');
    expect(pending).toHaveLength(GREEN_SLICES_MAX - 1);
  });
});
