// The three seats floor's `team up --retie` still left after the 2026-11-17 restart:
// - tester-gemini: agy 1.5.10 draws its permission mode in the empty box, read as unsent text;
//   and its record stopped at `launched` with no conversation id on either side, which no proof
//   could adopt. The seat's own worktree now stands in for the id, proved again at execution.
// - tester-codex and operator-02: a dead managed Codex endpoint needs an in-place relaunch, which
//   --retie never does; its reason now names the cause and the `team up` that repairs it.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { retieSkipReason } from '../src/commands/up.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import type { Step, UpSeat } from '../src/launch/plan.ts';
import type { RestoreWorktree } from '../src/launch/restore-proof.ts';
import { readScreen } from '../src/watch/screen.ts';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/antigravity/1.5.10/${name}`, import.meta.url), 'utf8');

describe('agy 1.5.10 permission-mode hint', () => {
  test('the hint alone in the box is the empty idle prompt', () => {
    expect(readScreen('antigravity', fixture('idle-auto-mode.txt')).kind).toBe('idle');
  });

  test('more text after the hint stays unsent', () => {
    expect(readScreen('antigravity', fixture('unsent-after-mode.txt')).kind).toBe('unsent');
  });
});

const SESSION = 'floor-scene';
const SEAT = 'tester-gemini';
const PANE = 'w4Q:p1';
const WORKSPACE = 'w4Q';
const OWN = '/fixture/floor/worktrees/tester-gemini';
const OTHER = '/fixture/floor/worktrees/tester-codex';

function adopt(): Step[] {
  return [{
    kind: 'run',
    argv: [],
    do: {
      do: 'adopt',
      seat: SEAT,
      cli: 'antigravity',
      pane: PANE,
      workspace: WORKSPACE,
      launched: { shell: 101, cli: [201] },
      recordedLaunched: { shell: 100, cli: [200] },
      unready: 'launched',
      worktreeProof: true,
    },
  }];
}

function world(cwd: string, screen = fixture('idle-auto-mode.txt')): { host: Host; renames: () => number; records: Record<string, unknown>[] } {
  let renames = 0;
  let taken = false;
  const records: Record<string, unknown>[] = [];
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: WORKSPACE }),
    paneRun: () => true,
    typeLine: async () => false,
    renameAgent: () => {
      renames += 1;
      taken = true;
      return true;
    },
    agentList: () => [{ name: taken ? SEAT : null, agent: 'agy', pane: PANE, workspace: WORKSPACE, status: 'idle', cwd }],
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [PANE],
    foreground: () => ['agy'],
    processInfo: () => ({ shell: 101, foreground: [201] }),
    paneText: () => screen,
    classify: () => 'idle',
    sleep: async () => {},
    now: () => 0,
    allow: () => null,
    record: (_name, patch) => {
      records.push(patch as Record<string, unknown>);
    },
    running: () => {},
    drop: () => {},
    say: () => {},
    log: () => {},
  };
  return { host, renames: () => renames, records };
}

const evidence = (over: Partial<RestoreWorktree> = {}): RestoreWorktree => ({ own: OWN, others: [OTHER], paneClaimed: false, ...over });

describe('an unready id-less seat adopted on its own worktree', () => {
  test('is re-tied and recorded ready at its idle prompt', async () => {
    const made = world(OWN);
    await executePlan(adopt(), SESSION, made.host, { restoreWorktree: () => evidence() });
    expect(made.renames()).toBe(1);
    expect(made.records.some((record) => record.stage === 'ready')).toBe(true);
  });

  test('a folder that left the worktree since the plan is not adopted', async () => {
    const made = world(OTHER);
    await executePlan(adopt(), SESSION, made.host, { restoreWorktree: () => evidence() });
    expect(made.renames()).toBe(0);
    expect(made.records).toEqual([]);
  });

  test('a pane another record claimed since the plan is not adopted', async () => {
    const made = world(OWN);
    await executePlan(adopt(), SESSION, made.host, { restoreWorktree: () => evidence({ paneClaimed: true }) });
    expect(made.renames()).toBe(0);
  });

  test('no fresh evidence: not adopted', async () => {
    const made = world(OWN);
    await executePlan(adopt(), SESSION, made.host);
    expect(made.renames()).toBe(0);
  });

  test('unsent text: re-tied, but its record keeps the stage it held', async () => {
    const made = world(OWN, fixture('unsent-after-mode.txt'));
    await executePlan(adopt(), SESSION, made.host, { restoreWorktree: () => evidence() });
    expect(made.renames()).toBe(1);
    expect(made.records.some((record) => record.stage === 'ready')).toBe(false);
  });
});

describe('--retie on a seat that needs an in-place relaunch', () => {
  const base = { name: 'tester-codex', cli: 'codex', launch: 'codex', cwd: '.', label: 'tester-codex', repairLine: '', stopped: false, rules: '' } as UpSeat;

  test('a dead Codex endpoint names its cause and the team up that repairs it', () => {
    const planned = { ...base, repair: { pane: 'w53:p1', workspace: 'w53', launched: { shell: 1, cli: [2] }, cli: 'codex', ownLine: { session: 'S1', endpoint: true as const } } } as UpSeat;
    const said = retieSkipReason(planned, 'w53:p1', 'floor');
    expect(said).toContain('managed Codex endpoint died');
    expect(said).toContain('team up --session floor');
    expect(said).toContain('resuming S1');
  });

  test('a plan with no in-place repair keeps the general sentence', () => {
    expect(retieSkipReason(base, 'w53:p1', 'floor')).toContain('its pane cannot be re-tied as it stands');
    expect(retieSkipReason(base, undefined, 'floor')).toBe('not launched: --retie only re-ties seats whose panes are running');
  });
});
