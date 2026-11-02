// The watch pass's record reads and its fold: the scan (the mailbox, the agent registry, the
// liveness files) runs before the fold, so another command takes the state lock while the scan
// is busy; and the pass still folds its readings under that lock, one watch after another.
// Fixtures only: a scratch checkout, a scratch home and recorder sources. No pane is read or
// typed into, no daemon runs, and no process is signalled.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { loadReadings } from '../src/budgets/readings.ts';
import type { CheckOutcome } from '../src/budgets/run.ts';
import { standingSource } from '../src/commands/status.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-04T09:00:00Z');
const NOW_MS = NOW.getTime();
const IDLE = `● Done.\n\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const FINE: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
// The example's whole `budgets` section, replaced by the lines a test spells.
const BUDGETS = 'budgets:                       # owner-only; a change needs a new approval\n  marks: [50, 75, 90]          # percent used, per account and window\n';
const OPENAI_CHECK = '  accounts:\n    openai: { kind: subscription, reserve: 10%, sources: [check], check: openai-quota }\n';

function source(budgets = '  marks: [50, 75, 90]\n'): string {
  return example.replace(BUDGETS, `budgets:\n${budgets}`);
}

let base = '';
let root = '';
let home = '';
let file = '';

function agents(): string {
  return join(root, '.agents');
}

function write(text: string): void {
  writeFileSync(file, text);
}

function approve(text: string = source()): void {
  write(text);
  const loaded = loadTeamFile(root);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
}

function live(): Live {
  return { running: true, agents: [], workspaces: [], screens: {} };
}

function sources(over: Partial<WatchSources> = {}): WatchSources {
  return {
    live: () => live(),
    machine: () => FINE,
    standing: standingSource(home),
    readChecks: () => [],
    screen: () => IDLE,
    status: () => 'idle',
    foreground: () => ['claude'],
    processes: () => null,
    typeText: () => false,
    pressEnter: () => false,
    sendKey: () => false,
    sleep: async () => {},
    notify: () => {},
    now: () => new Date(NOW),
    wait: async () => false,
    alive: () => false,
    pid: 4_242,
    home,
    ...over,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-watch-lock-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  file = join(root, '.agents', 'team.yaml');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('the watch pass and the state lock', () => {
  test('a slow mailbox read does not hold the lock: another command takes it meanwhile', async () => {
    approve(source());
    const seen = { reads: 0, took: false, failure: '' };
    const code = await runWatch(['--file', '.agents/team.yaml'], testIo(root, { kind: 'owner' }), sources({
      readMailbox: () => {
        seen.reads += 1;
        // The scan is the slow part; while it runs the pass has not entered its fold yet.
        Bun.sleepSync(20);
        try {
          // The second command: a state write that waits for nobody, the shape a lead's
          // `team restart` makes while the daemon's watch is mid-pass.
          updateState(agents(), () => {}, { waitMs: 0 });
          seen.took = true;
        } catch (error) {
          seen.failure = (error as Error).message;
        }
        return [];
      },
    }));
    expect(code).toBe(0);
    expect(seen.reads).toBeGreaterThan(0);
    expect(seen.failure).toBe('');
    expect(seen.took).toBe(true);
  });

  test('two watches still fold one after the other: the second is handed the first reading', async () => {
    approve(source(OPENAI_CHECK));
    let reads = 0;
    const outcome = (window: 'session' | 'daily' | 'weekly', left: number): CheckOutcome[] => [{
      account: 'openai',
      state: 'read',
      reading: {
        kind: 'subscription',
        windows: [{ window, left, used: 100 - left, at: NOW_MS, resetsAt: null }],
      },
    }];
    const first = await runWatch(['--file', '.agents/team.yaml'], testIo(root, { kind: 'owner' }), sources({
      readChecks: () => outcome('weekly', 39),
      readMailbox: () => { reads += 1; return []; },
    }));
    expect(first).toBe(0);
    expect(loadReadings(agents()).map(({ account, window, left }) => [account, window, left]))
      .toEqual([['openai', 'weekly', 39]]);
    // A second watch reads nothing new; its fold is handed the reading the first one wrote,
    // and its own reading joins the list instead of replacing it.
    const second = await runWatch(['--file', '.agents/team.yaml'], testIo(root, { kind: 'owner' }), sources({
      readChecks: () => outcome('daily', 20),
      readMailbox: () => { reads += 1; return []; },
    }));
    expect(second).toBe(0);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(loadReadings(agents()).map(({ account, window, left }) => [account, window, left]).sort())
      .toEqual([['openai', 'daily', 20], ['openai', 'weekly', 39]].sort());
  });
});
