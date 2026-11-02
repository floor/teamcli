// The watch computes its pass on a snapshot read before the state lock, and writes only the
// merge of its readings under the lock: another command can take the lock while the pass runs,
// a reading written in that window is kept beside the pass's own, and an unchanged result is
// not written at all.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReadings, overlayReadings, saveReadings, updateReadings, type Seen } from '../src/budgets/readings.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { STATE_FILE, updateState } from '../src/state.ts';
import type { Machine } from '../src/watch/machine.ts';
import * as passModule from '../src/watch/pass.ts';
import { testIo } from './helpers.ts';

const NOW = Date.parse('2026-11-02T09:00:00.000Z');

function seen(over: Partial<Seen> = {}): Seen {
  return {
    account: 'openai', window: 'weekly', left: 60, used: 40,
    changedAt: NOW, resetsAt: null, seat: 'one', source: 'status_line', confirmed: true,
    ...over,
  };
}

function stateDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'team-watch-merge-')), '.agents');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const made: string[] = [];
const restores: { mockRestore(): void }[] = [];

afterEach(() => {
  for (const spy of restores.splice(0)) spy.mockRestore();
  for (const dir of made.splice(0)) rmSync(join(dir, '..'), { recursive: true, force: true });
});

function watchedDir(): string {
  const dir = stateDir();
  made.push(dir);
  return dir;
}

describe('the merge of a pass computed before the lock', () => {
  test('a reading another writer lands while the pass runs is kept beside the pass own', () => {
    const dir = watchedDir();
    // The pass read nothing before it started; while it runs, another writer lands a check
    // reading. Its fold is handed the state as it stands now and keeps that key.
    saveReadings(dir, [seen({ account: 'anthropic', window: 'session', seat: null, source: 'check', left: 95 })], NOW);
    const computed = [seen({ left: 20 })];
    const returned = updateReadings(dir, NOW, (stored) => ({
      readings: overlayReadings(stored, computed),
      value: 'computed',
    }), { skipIdentical: true });
    expect(returned).toBe('computed');
    expect(loadReadings(dir).map(({ account, window, seat, left }) => [account, window, seat, left]).sort())
      .toEqual([
        ['anthropic', 'session', null, 95],
        ['openai', 'weekly', 'one', 20],
      ].sort());
  });

  test('the pass own reading wins on a key both lists hold', () => {
    const dir = watchedDir();
    // The pass snapshot predates the other writer's reading; the design's rule is that the
    // pass's own figure wins for the seat and window it just read.
    saveReadings(dir, [seen({ left: 39 })], NOW);
    updateReadings(dir, NOW, (stored) => ({
      readings: overlayReadings(stored, [seen({ left: 20 })]),
      value: null,
    }), { skipIdentical: true });
    expect(loadReadings(dir).map(({ seat, left }) => [seat, left])).toEqual([['one', 20]]);
  });

  test('an unchanged result writes nothing, and a changed one writes', () => {
    const dir = watchedDir();
    saveReadings(dir, [seen()], NOW);
    const path = join(dir, STATE_FILE);
    // A file this suite formatted itself: a skipped write leaves these bytes as they stand.
    writeFileSync(path, `${JSON.stringify(JSON.parse(readFileSync(path, 'utf8')), null, 4)}\n`);
    const spaced = readFileSync(path, 'utf8');
    updateReadings(dir, NOW, (stored) => ({ readings: stored, value: null }), { skipIdentical: true });
    expect(readFileSync(path, 'utf8')).toBe(spaced);

    updateReadings(dir, NOW, (stored) => ({
      readings: [...stored, seen({ account: 'anthropic', window: 'session', seat: null, source: 'check', left: 95 })],
      value: null,
    }), { skipIdentical: true });
    expect(readFileSync(path, 'utf8')).not.toBe(spaced);
    expect(loadReadings(dir)).toHaveLength(2);
  });
});

const RAW = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

describe('a watch pass runs with the state lock free', () => {
  let root: string;
  let file: string;
  let clock: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'team-watch-pass-lock-'));
    made.push(join(root, '.agents'));
    execSync('git init -q', { cwd: root });
    mkdirSync(join(root, '.agents'), { recursive: true });
    file = join(root, '.agents', 'team.yaml');
    writeFileSync(file, RAW);
    clock = NOW;
  });

  function sources(): WatchSources {
    return {
      live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => null,
      status: () => null,
      foreground: () => null,
      processes: () => null,
      typeText: () => false,
      pressEnter: () => false,
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock),
      wait: async () => false,
      alive: () => false,
      pid: 4242,
      home: root,
      ownPane: () => ({ pane: 'watch:pane', workspace: 'watch' }),
    };
  }

  test('another caller takes the lock during the pass, and its budget write survives the merge', async () => {
    const dir = join(root, '.agents');
    const during: { locked: boolean; took: boolean; snapshot: number }[] = [];
    const realPass = passModule.pass;
    restores.push(spyOn(passModule, 'pass').mockImplementation((input) => {
      // The state lock must be free while the pass computes: an independent command takes it
      // at once, and a check reading lands while this pass's own list is still the snapshot.
      const locked = existsSync(join(dir, 'team.lock'));
      let took = false;
      try {
        updateState(dir, () => {}, { waitMs: 0 });
        took = true;
      } catch {
        took = false;
      }
      saveReadings(dir, [seen({ account: 'anthropic', window: 'session', seat: null, source: 'check', left: 95 })], clock);
      during.push({ locked, took, snapshot: input.readings?.length ?? 0 });
      return realPass(input);
    }));

    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, sources());
    expect(io.err).toBe('');
    expect(code).toBe(0);
    // The pass saw the snapshot it started from (nothing), ran lock-free, and the merge kept
    // the budget the other caller wrote in that window.
    expect(during).toEqual([{ locked: false, took: true, snapshot: 0 }]);
    expect(loadReadings(dir).map(({ account, window, left }) => [account, window, left]))
      .toEqual([['anthropic', 'session', 95]]);
  });
});
