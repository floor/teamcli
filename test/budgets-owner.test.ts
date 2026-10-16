// The whole `budgets` section is the owner's, like the watch's: what a file sets takes
// effect only once the owner approves it. Until then every reader — the watch's pass and its
// check cadence, the check commands' own run, and `status`'s table — runs with the values of the
// approved copy, or with the defaults (no accounts) when nothing was approved. Fixtures only.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf, budgetsInForce, watchInForce } from '../src/approve/approval.ts';
import { resolveChecks } from '../src/budgets/checks.ts';
import { saveReadings, type Seen } from '../src/budgets/readings.ts';
import { runChecks, type CheckOutcome } from '../src/budgets/run.ts';
import { standingSource, runStatus, type StatusSources } from '../src/commands/status.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { TeamFile } from '../src/file/types.ts';
import { defaultBudgets, validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-04T09:00:00Z');
const NOW_MS = NOW.getTime();
const MIN = 60_000;
const SESSION = 'acme-web';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
// The example's whole `budgets` section, replaced by the lines a test spells.
const BUDGETS = 'budgets:                       # owner-only; a change needs a new approval\n  marks: [50, 75, 90]          # percent used, per account and window\n';
const OPENAI = '  accounts:\n    openai: { kind: subscription, reserve: 10%, sources: [status_line] }\n';
const OPENAI_CHECK = '  accounts:\n    openai: { kind: subscription, reserve: 10%, sources: [check], check: openai-quota }\n';

function source(budgets = '  marks: [50, 75, 90]\n'): string {
  return example.replace(BUDGETS, `budgets:\n${budgets}`);
}

function teamFile(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

let base: string;
let root: string;
let home: string;

function write(text: string): void {
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
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

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-budgets-owner-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('the budgets section, owner-only', () => {
  test('an edit is recorded as drift and its live budget values take effect', () => {
    approve(source(`${OPENAI}  check_every: 10m\n`));
    const edited = teamFile(source(`${OPENAI.replace('10%', '1%')}  check_every: 1000h\n  marks: [99]\n`));
    expect(approvalDifferences(edited, root, home)).toEqual(['`budgets` changed']);
    const inForce = budgetsInForce(edited, root, home);
    // The live reserve, marks and cadence take effect together.
    expect(inForce.accounts['openai']?.reserve).toBe(1);
    expect(inForce.marks).toEqual([99]);
    expect(inForce.checkEvery).toBe(1000 * 3600);
    expect(edited.budgets.accounts['openai']?.reserve).toBe(1);
    expect(edited.budgets.marks).toEqual([99]);
    expect(edited.budgets.checkEvery).toBe(1000 * 3600);
  });

  test('approving the edit puts the new values in force', () => {
    approve(source(OPENAI));
    const changed = source(OPENAI.replace('10%', '1%'));
    approve(changed);
    const file = teamFile(changed);
    expect(approvalDifferences(file, root, home)).toEqual([]);
    expect(budgetsInForce(file, root, home).accounts['openai']?.reserve).toBe(1);
  });

  test('a file never approved runs with the defaults, whatever it sets', () => {
    const file = teamFile(source(OPENAI));
    expect(approvalDifferences(file, root, home)).toBeNull();
    expect(budgetsInForce(file, root, home)).toEqual(defaultBudgets());
  });
});

describe('the check commands run from the budgets in force', () => {
  test('a live edit that drops an account stops its check', () => {
    const command = join(root, 'balance');
    writeFileSync(command, '#!/bin/sh\necho "6.20 USD"\n', { mode: 0o755 });
    const account = `  accounts:\n    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: ${command} }\n`;
    const text = source(account);
    write(text);
    const loaded = loadTeamFile(root);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    const resolved = resolveChecks(loaded.team, root, '');
    if (!resolved.ok) throw new Error('the check did not resolve');
    writeApproval(
      storePath(loaded.team.project, loaded.root, home),
      { approval: approvalOf(loaded.team, loaded.root, NOW, resolved.checks), file: text },
      loaded.team.seats,
      home,
    );

// The live file names no account, so its former check must not run.
    const edited = teamFile(source('  marks: [50, 75, 90]\n'));
    expect(approvalDifferences(edited, root, home)).toEqual(['`budgets` changed']);
    const reading = { kind: 'spend', amount: 6.2, currency: 'USD', at: NOW_MS } as const;
    const outcomes: CheckOutcome[] = runChecks(edited, root, NOW_MS, home, () => reading);
    expect(outcomes).toEqual([]);
  });
});

const idle = `● Done.\n\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

function agent(name: string, workspace: string, status: string, kind: string): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

function live(): Live {
  const agents = [
    agent('claude-coordinator-acme', 'w0', 'idle', 'claude'),
    agent('codex-acme', 'w1', 'working', 'codex'),
    agent('deepseek-acme', 'w2', 'working', 'claude'),
    agent('deepseek-acme-2', 'w3', 'working', 'claude'),
  ];
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens: { 'w1:p1': idle } };
}

describe('the watch reads them', () => {
  let clock: number;
  let reads: number[];
  let outcomes: CheckOutcome[];
  let left: number;

  function watchSources(passes: number, over: Partial<WatchSources> = {}): WatchSources {
    left = passes;
    return {
      live: () => live(),
      machine: () => fine,
      standing: standingSource(home),
      readChecks: (_team, _at, now) => {
        reads.push(now);
        return outcomes;
      },
      screen: () => idle,
      status: () => 'idle',
      foreground: () => ['claude', 'codex'],
      typeText: () => true,
      pressEnter: () => true,
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock),
      wait: async (seconds) => {
        clock += seconds * 1000;
        return --left > 0;
      },
      alive: () => false,
      pid: 4242,
      ...over,
    };
  }

  beforeEach(() => {
    clock = NOW_MS;
    reads = [];
    outcomes = [];
  });

  test('a live marks edit sets the thresholds reported by the watch', async () => {
    approve(source(OPENAI_CHECK));
    write(source(`  marks: [99]\n${OPENAI_CHECK}`));
    outcomes = [{
      account: 'openai',
      state: 'read',
      reading: {
        kind: 'subscription',
        windows: [{ window: 'weekly', left: 8, used: 92, at: NOW_MS, resetsAt: NOW_MS + 7 * 24 * 3600_000 }],
      },
    }];
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(['--file', '.agents/team.yaml'], io, watchSources(1));
    expect(code).toBe(0);
    expect(io.out).not.toContain('past the 50% mark');
    expect(io.out).not.toContain('past the 90% mark');
    expect(io.out).toContain('openai weekly left 8%, inside its 10% reserve');
    expect(io.out).not.toContain('the file differs from the approved one');
  });

  test('a live cadence edit changes the loop\'s check runs', async () => {
    approve(source('  check_every: 30s\n'));
    write(source('  check_every: 1000h\n'));
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(['--file', '.agents/team.yaml'], io, watchSources(2));
    expect(code).toBe(0);
    // Two passes 120s apart use the live cadence: the second keeps the first reading.
    expect(reads).toEqual([NOW_MS]);
  });
});

describe('status reads them', () => {
  test('a live reserve edit changes the reserve mark immediately', async () => {
    approve(source(OPENAI));
    const stored: Seen = {
      account: 'openai',
      window: 'weekly',
      left: 5,
      used: 95,
      changedAt: NOW_MS - MIN,
      resetsAt: NOW_MS + 60 * MIN,
      seat: 'codex-acme',
      source: 'status_line',
      confirmed: true,
    };
    saveReadings(join(root, '.agents'), [stored], NOW_MS);
    const sources: StatusSources = {
      live: () => live(),
      branch: () => 'main',
      standing: standingSource(home),
      now: () => NOW,
      home,
    };
    const status = async () => {
      const io = testIo(root, { kind: 'owner' });
      await runStatus(['--file', '.agents/team.yaml'], io, sources);
      return io.out;
    };

    expect(await status()).toContain('openai  weekly  left 5%  used 95%');
    expect(await status()).toContain('fresh, inside reserve 10%');
    // The live 1% reserve puts this reading outside its reserve immediately.
    write(source(OPENAI.replace('10%', '1%')));
    expect(await status()).not.toContain('inside reserve');
    // Approved, it is the row's own reserve.
    approve(source(OPENAI.replace('10%', '1%')));
    const after = await status();
    expect(after).toContain('openai  weekly  left 5%  used 95%');
    expect(after).not.toContain('inside reserve');
  });
});
