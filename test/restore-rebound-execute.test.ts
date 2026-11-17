// An adoption that changes a seat's conversation is proved again at execution from the binding
// the records hold, with the worktree and claim evidence read again then: a folder or a competing
// record that changed after the plan refuses it, and nothing is renamed or recorded. Pane ids,
// processes, folders and the clock are synthetic.
import { expect, test } from 'bun:test';
import { executePlan, type Host } from '../src/launch/execute.ts';
import type { Step } from '../src/launch/plan.ts';
import type { RestoreWorktree } from '../src/launch/restore-proof.ts';

const SESSION = 'rebound-scene';
const SEAT = 'tester-codex';
const PANE = 'w53:p1';
const WORKSPACE = 'w53';
const OWN = '/fixture/floor/worktrees/tester-codex';
const OTHER = '/fixture/floor/worktrees/operator-02';
const OLD = '01a1e31f-0000-7000-8000-000000000001';
const NEW = '01a1bfd3-0000-7000-8000-000000000002';

function adopt(): Step[] {
  return [{
    kind: 'run',
    argv: [],
    do: {
      do: 'adopt',
      seat: SEAT,
      cli: 'codex',
      pane: PANE,
      workspace: WORKSPACE,
      launched: { shell: 101, cli: [201] },
      recordedLaunched: { shell: 100, cli: [200] },
      session: NEW,
      rebound: { from: OLD, to: NEW },
    },
  }];
}

function relaunch(endpoint: boolean): Step[] {
  return [{
    kind: 'run',
    argv: [],
    do: {
      do: 'relaunch',
      seat: SEAT,
      cli: 'codex',
      pane: PANE,
      workspace: WORKSPACE,
      launched: { shell: 100, cli: [200] },
      session: NEW,
      rebound: { from: OLD, to: NEW },
      ...(endpoint ? { endpoint: true as const } : {}),
    },
  }];
}

let typed = 0;

function world(cwd: string): { host: Host; renames: () => number; records: { seat: string; patch: Record<string, unknown> }[]; said: string[] } {
  typed = 0;
  let renames = 0;
  let taken = false;
  const records: { seat: string; patch: Record<string, unknown> }[] = [];
  const said: string[] = [];
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: WORKSPACE }),
    paneRun: () => true,
    typeLine: async () => {
      typed += 1;
      return false;
    },
    typeText: () => {
      typed += 1;
      return false;
    },
    sendKey: () => {
      typed += 1;
      return false;
    },
    renameAgent: () => {
      renames += 1;
      taken = true;
      return true;
    },
    agentList: () => [{
      name: taken ? SEAT : null,
      agent: 'codex',
      pane: PANE,
      workspace: WORKSPACE,
      status: 'idle',
      cwd,
      session: NEW,
    }],
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [PANE],
    foreground: () => ['codex'],
    processInfo: () => ({ shell: 101, foreground: [201] }),
    classify: () => 'idle',
    sleep: async () => {},
    now: () => 0,
    allow: () => null,
    record: (name, patch) => {
      records.push({ seat: name, patch: patch as Record<string, unknown> });
    },
    running: () => {},
    drop: () => {},
    say: (line) => {
      said.push(line);
    },
    log: () => {},
  };
  return { host, renames: () => renames, records, said };
}

const evidence = (over: Partial<RestoreWorktree> = {}): RestoreWorktree => ({ own: OWN, others: [OTHER], paneClaimed: false, ...over });

test('the change is adopted when the fresh evidence still proves it, with the audit line', async () => {
  const made = world(OWN);
  await executePlan(adopt(), SESSION, made.host, { restoreWorktree: () => evidence() });
  expect(made.renames()).toBe(1);
  const ready = made.records.find((record) => record.patch.stage === 'ready');
  expect(ready?.patch.agent_session).toBe(NEW);
  expect(made.said.join('')).toContain(`its conversation moved from ${OLD} to ${NEW}`);
});

test('a pane whose folder left the seat\'s worktree since the plan is not adopted', async () => {
  const made = world(OTHER);
  await executePlan(adopt(), SESSION, made.host, { restoreWorktree: () => evidence() });
  expect(made.renames()).toBe(0);
  expect(made.records.filter((record) => record.patch.stage === 'ready')).toEqual([]);
});

test('a pane another seat\'s record claimed since the plan is not adopted', async () => {
  const made = world(OWN);
  await executePlan(adopt(), SESSION, made.host, { restoreWorktree: () => evidence({ paneClaimed: true }) });
  expect(made.renames()).toBe(0);
  expect(made.records.filter((record) => record.patch.stage === 'ready')).toEqual([]);
});

test('without fresh evidence the change is never adopted as an exact-id proof', async () => {
  const made = world(OWN);
  await executePlan(adopt(), SESSION, made.host);
  expect(made.renames()).toBe(0);
  expect(made.records.filter((record) => record.patch.stage === 'ready')).toEqual([]);
});

for (const endpoint of [true, false]) {
  const kind = endpoint ? 'a dead-endpoint relaunch' : 'a launcher, model or channel relaunch';

  test(`${kind} with fresh evidence still proving the change reaches the exit`, async () => {
    const made = world(OWN);
    await executePlan(relaunch(endpoint), SESSION, made.host, { restoreWorktree: () => evidence() });
    expect(typed).toBeGreaterThan(0);
  });

  test(`${kind}: a folder that left the seat's worktree since the plan types nothing`, async () => {
    const made = world(OTHER);
    await executePlan(relaunch(endpoint), SESSION, made.host, { restoreWorktree: () => evidence() });
    expect(typed).toBe(0);
    expect(made.said.join('')).toContain('left out');
  });

  test(`${kind}: a claim another seat's record made since the plan types nothing`, async () => {
    const made = world(OWN);
    await executePlan(relaunch(endpoint), SESSION, made.host, { restoreWorktree: () => evidence({ paneClaimed: true }) });
    expect(typed).toBe(0);
  });

  test(`${kind}: no fresh evidence types nothing`, async () => {
    const made = world(OWN);
    await executePlan(relaunch(endpoint), SESSION, made.host);
    expect(typed).toBe(0);
  });
}
