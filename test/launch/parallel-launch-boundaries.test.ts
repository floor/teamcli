// The edges of the launch window the happy paths do not cross: the exact figures that open and
// close each machine gate, a seat whose idle wait runs out while the window keeps moving behind
// it, a failing seat that neither delays the others nor closes a workspace that is not its own,
// and the serial opt-out, from the flag on the command line down to one seat at a time.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executePlan, type Host, type ScreenKind } from '../../src/launch/execute.ts';
import { IDLE_POLL_MS, type Step } from '../../src/launch/plan.ts';
import { progressWriter, type ProgressSink } from '../../src/launch/progress.ts';
import { launchConcurrency, type Machine } from '../../src/watch/machine.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { approvalOf } from '../../src/approve/approval.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { testIo } from '../helpers.ts';

function sink(isTTY: boolean): { out: string[]; err: string[]; sink: ProgressSink } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), isTTY } };
}

function seatSteps(name: string, cli: 'claude-code' | 'codex', seconds = 90): Step[] {
  const rules = cli === 'codex' ? ('message' as const) : ('option' as const);
  const repairLine = `\`team remove ${name} --keep\` then \`team add ${name}\``;
  const steps: Step[] = [
    {
      kind: 'run',
      argv: [],
      do: { do: 'create', seat: name, label: name, cwd: '.', repairLine },
    },
    {
      kind: 'run',
      argv: [],
      do: { do: 'launch', seat: name, label: name, command: cli },
    },
    {
      kind: 'wait',
      text: `until ${name} shows its idle prompt`,
      do: { do: 'idle', seat: name, label: name, cli, seconds, command: cli, repairLine },
    },
    {
      kind: 'run',
      argv: [],
      do: { do: 'rename', seat: name, label: name, seconds, rules, cli },
    },
  ];
  if (rules === 'message') {
    steps.push({
      kind: 'run',
      argv: [],
      do: {
        do: 'deliver',
        seat: name,
        label: name,
        cli,
        rules: 'Rules.',
        path: `/x/rules/${name}.md`,
        line: `Read /x/rules/${name}.md`,
        seconds,
      },
    });
  }
  return steps;
}

describe('launchConcurrency edges', () => {
  const limits = {
    loadStart: 2.5,
    loadMax: 4.0,
    memoryStart: 15,
    memoryMin: 8,
    swapFreeMin: 2_000_000_000,
    swapGrowthMax: 2_147_483_648,
    swapGrowthWindow: 60,
    diskMin: 5_368_709_120,
  };
  const ample: Machine = {
    loadPerCore: 0.3,
    memoryFree: 60,
    diskFree: 200e9,
    swapTotal: 10e9,
    swapFree: 9e9,
    swapUsed: 1e9,
  };

  test('load just under 0.7 × load_start floors to its slots; just past it holds the launch serial', () => {
    expect(launchConcurrency({ ...ample, loadPerCore: 1.7 }, limits)).toBe(3);
    expect(launchConcurrency({ ...ample, loadPerCore: 1.8 }, limits)).toBe(1);
  });

  test('memory at exactly memory_start + 10 still launches; one under it holds serial', () => {
    expect(launchConcurrency({ ...ample, memoryFree: 25 }, limits)).toBe(3);
    expect(launchConcurrency({ ...ample, memoryFree: 24 }, limits)).toBe(1);
  });

  test('swap at exactly 1.5 × swap_free_min still launches in parallel; just under it holds serial', () => {
    expect(launchConcurrency({ ...ample, swapFree: 3e9 }, limits)).toBe(8);
    expect(launchConcurrency({ ...ample, swapFree: 2.9e9 }, limits)).toBe(1);
  });

  test('a machine whose swap figures cannot be read is gated by load and memory alone', () => {
    expect(launchConcurrency({ ...ample, swapFree: null, swapUsed: null }, limits)).toBe(8);
  });

  test('the width never drops below two while every gate passes, never rises above eight, and --serial overrides all of it', () => {
    // A tight load_start leaves the load floor one slot wide; the floor of two still holds.
    expect(launchConcurrency({ ...ample, loadPerCore: 0.6 }, { ...limits, loadStart: 1.0 })).toBe(2);
    // However ample the machine, eight is the ceiling.
    expect(launchConcurrency({ ...ample, loadPerCore: 0, memoryFree: 1000 }, limits)).toBe(8);
    // The serial flag wins over headroom that would otherwise open the full window.
    expect(launchConcurrency(ample, limits, true)).toBe(1);
    expect(launchConcurrency(ample, limits)).toBe(8);
  });
});

describe('parallel launch window boundaries', () => {
  test('a seat whose idle wait runs out keeps its slot the whole wait while the window moves behind it', async () => {
    // a never shows a prompt and times out after 30 s; b, c, d idle two polls after their own
    // launches. The window of two never grows: a holds one slot from its launch to its deadline
    // while b, c and d pass one at a time through the other.
    const plan: Step[] = [
      ...seatSteps('a', 'claude-code', 30),
      ...seatSteps('b', 'claude-code'),
      ...seatSteps('c', 'claude-code'),
      ...seatSteps('d', 'claude-code'),
    ];

    let t = 0;
    let active = 0;
    let maxActive = 0;
    const launchedAt = new Map<string, number>();
    const renamedAt = new Map<string, number>();
    const { out, err, sink: s } = sink(false);
    const records = progressWriter(s);
    const logged: { who: string; what: string }[] = [];

    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: (_session, _cwd, label) => ({ pane: `${label}-pane`, workspace: `${label}-ws` }),
      paneRun: (_session, pane) => {
        launchedAt.set(pane, t);
        active++;
        maxActive = Math.max(maxActive, active);
        return true;
      },
      typeLine: () => true,
      renameAgent: (_session, _pane, name) => {
        renamedAt.set(name, t);
        active--;
        return true;
      },
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => [...launchedAt.keys()],
      classify: (_session, pane): ScreenKind => {
        if (pane === 'a-pane') return 'working';
        const start = launchedAt.get(pane) ?? 0;
        return t - start >= 2 * IDLE_POLL_MS ? 'idle' : 'working';
      },
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: () => {},
      log: (who, what) => logged.push({ who, what }),
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record) => records.final(seat, record),
      detail: (line) => records.detail(line),
    };

    const report = await executePlan(plan, 'acme', host, { concurrency: 2 });
    expect(report).toEqual({ serverFailed: false, watchFailed: false, held: false, dropped: ['a'] });
    expect(t).toBe(30000);
    expect(maxActive).toBe(2);
    // a and b took the two slots at once; c entered only after b settled, d after c.
    expect(launchedAt.get('a-pane')).toBe(0);
    expect(launchedAt.get('b-pane')).toBe(0);
    expect(launchedAt.get('c-pane')!).toBeGreaterThan(renamedAt.get('b')!);
    expect(launchedAt.get('d-pane')!).toBeGreaterThan(renamedAt.get('c')!);
    // Every seat settled within a's wait — the run's whole cost is the straggler's own deadline,
    // with nothing added after it for the seats the window moved through behind it.
    expect(renamedAt.get('d')!).toBeLessThanOrEqual(30000);
    expect(out.join('')).toBe('a: left out: timeout\nb: ready\nc: ready\nd: ready\n');
    expect(err.join('')).toBe(
      '  timed out after 30 s waiting for its idle prompt; the screen last read working; left at launched\n'
        + '  run `team up` again to resume it\n',
    );
    expect(logged).toEqual([
      { who: 'a', what: 'left out: timeout' },
      { who: 'b', what: 'ready' },
      { who: 'c', what: 'ready' },
      { who: 'd', what: 'ready' },
    ]);
  });

  test('a seat the budget refuses before its workspace exists costs no window slot', async () => {
    const plan: Step[] = ['a', 'b', 'c', 'd'].flatMap((name) => seatSteps(name, 'claude-code'));

    let t = 0;
    const events: string[] = [];
    const { out, sink: s } = sink(false);
    const records = progressWriter(s);
    const logged: { who: string; what: string }[] = [];

    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: (_session, _cwd, label) => {
        events.push(`create:${label}@${t}`);
        return { pane: `${label}-pane`, workspace: `${label}-ws` };
      },
      paneRun: (_session, pane) => {
        events.push(`launch:${pane}@${t}`);
        return true;
      },
      typeLine: () => true,
      renameAgent: () => true,
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => ['a-pane', 'c-pane', 'd-pane'],
      classify: (_session, pane): ScreenKind => {
        const launched = { 'a-pane': 0, 'c-pane': 0, 'd-pane': 2000 }[pane] ?? 0;
        return t - launched >= IDLE_POLL_MS ? 'idle' : 'working';
      },
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      allow: (seat) => (seat === 'b' ? 'a budget gate holds this seat' : null),
      record: () => {},
      running: () => {},
      drop: () => {},
      say: () => {},
      log: (who, what) => logged.push({ who, what }),
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record) => records.final(seat, record),
      detail: (line) => records.detail(line),
    };

    const report = await executePlan(plan, 'acme', host, { concurrency: 2 });
    expect(report).toEqual({ serverFailed: false, watchFailed: false, held: false, dropped: ['b'] });
    // b got no workspace at all; the same window pass took c in its place, and d entered as soon
    // as one of the two waiting seats settled.
    expect(events).toEqual([
      'create:a@0',
      'launch:a-pane@0',
      'create:c@0',
      'launch:c-pane@0',
      'create:d@2000',
      'launch:d-pane@2000',
    ]);
    expect(t).toBe(4000);
    expect(out.join('')).toBe(
      'a: ready\nb: left out: a budget gate holds this seat\nc: ready\nd: ready\n',
    );
    expect(logged).toEqual([
      { who: 'a', what: 'ready' },
      { who: 'b', what: 'left out: a budget gate holds this seat' },
      { who: 'c', what: 'ready' },
      { who: 'd', what: 'ready' },
    ]);
  });

  test('a seat whose launch command fails is left out alone and nothing is closed for it', async () => {
    const plan: Step[] = ['a', 'b', 'c'].flatMap((name) => seatSteps(name, 'claude-code'));

    let t = 0;
    const launchedAt = new Map<string, number>();
    const closed: string[] = [];
    const { out, sink: s } = sink(false);
    const records = progressWriter(s);
    const logged: { who: string; what: string }[] = [];

    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: (_session, _cwd, label) => ({ pane: `${label}-pane`, workspace: `${label}-ws` }),
      paneRun: (_session, pane) => {
        launchedAt.set(pane, t);
        return pane !== 'b-pane';
      },
      typeLine: () => true,
      renameAgent: () => true,
      closeWorkspace: (_session, workspace) => {
        closed.push(workspace);
        return true;
      },
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => ['a-pane', 'c-pane'],
      classify: (_session, pane): ScreenKind => {
        const start = launchedAt.get(pane) ?? 0;
        return t - start >= IDLE_POLL_MS ? 'idle' : 'working';
      },
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: () => {},
      log: (who, what) => logged.push({ who, what }),
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record) => records.final(seat, record),
      detail: (line) => records.detail(line),
    };

    const report = await executePlan(plan, 'acme', host, { concurrency: 4 });
    expect(report).toEqual({ serverFailed: false, watchFailed: false, held: false, dropped: ['b'] });
    // The failed launch closed no workspace — not b's own, and never another seat's.
    expect(closed).toEqual([]);
    // a and c were launched in the same first pass; b's failure pushed neither aside.
    expect(launchedAt.get('a-pane')).toBe(0);
    expect(launchedAt.get('c-pane')).toBe(0);
    expect(out.join('')).toBe(
      'a: ready\nb: left out: its launch command did not run; left at launched\nc: ready\n',
    );
    expect(logged).toEqual([
      { who: 'a', what: 'ready' },
      { who: 'b', what: 'left out: its launch command did not run; left at launched' },
      { who: 'c', what: 'ready' },
    ]);
  });

  test('a seat whose workspace will not close is held alone; only that workspace is asked to close', async () => {
    const plan: Step[] = ['a', 'b', 'c'].flatMap((name) => seatSteps(name, 'claude-code'));

    let t = 0;
    const launchedAt = new Map<string, number>();
    const closed: string[] = [];
    const { out, err, sink: s } = sink(false);
    const records = progressWriter(s);
    const logged: { who: string; what: string }[] = [];

    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: (_session, _cwd, label) => ({ pane: `${label}-pane`, workspace: `${label}-ws` }),
      paneRun: (_session, pane) => {
        launchedAt.set(pane, t);
        return true;
      },
      typeLine: () => true,
      renameAgent: () => true,
      closeWorkspace: (_session, workspace) => {
        closed.push(workspace);
        return workspace !== 'b-ws';
      },
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => ['a-pane', 'c-pane'],
      // b shows a vendor notice from its first reading; a and c idle one poll after launch.
      classify: (_session, pane): ScreenKind => {
        if (pane === 'b-pane') return 'vendor notice';
        const start = launchedAt.get(pane) ?? 0;
        return t - start >= IDLE_POLL_MS ? 'idle' : 'working';
      },
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: () => {},
      log: (who, what) => logged.push({ who, what }),
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record) => records.final(seat, record),
      detail: (line) => records.detail(line),
    };

    const report = await executePlan(plan, 'acme', host, { concurrency: 4 });
    // The run says what it could not do, and b is the only seat it gave up on.
    expect(report).toEqual({ serverFailed: false, watchFailed: false, held: true, dropped: ['b'] });
    expect(closed).toEqual(['b-ws']);
    expect(out.join('')).toBe(
      'a: ready\nb: left out: vendor notice; its workspace did not close; left as it is\nc: ready\n',
    );
    expect(logged).toEqual([
      { who: 'a', what: 'ready' },
      { who: 'b', what: 'left out: vendor notice; its workspace did not close; left as it is' },
      { who: 'c', what: 'ready' },
    ]);
  });

  test('seats settling in reverse file order still report in file order, printing nothing early', async () => {
    const names = ['a', 'b', 'c', 'd', 'e'];
    const plan: Step[] = names.flatMap((name) => seatSteps(name, 'claude-code', 120));

    let t = 0;
    const launchedAt = new Map<string, number>();
    // e settles at 20 s, d at 40 s, and so on back to a at 100 s — the exact opposite of the
    // file's order, with the gaps wide enough that no poll alignment can blur it.
    const idleAt = new Map<string, number>(
      names.map((name, i) => [`${name}-pane`, (names.length - 1 - i) * 20_000]),
    );
    const outWhen: { seat: string; printed: number }[] = [];
    const { out, sink: s } = sink(false);
    const records = progressWriter(s);
    const logged: { who: string; what: string }[] = [];

    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: (_session, _cwd, label) => ({ pane: `${label}-pane`, workspace: `${label}-ws` }),
      paneRun: (_session, pane) => {
        launchedAt.set(pane, t);
        return true;
      },
      typeLine: () => true,
      renameAgent: (_session, _pane, name) => {
        outWhen.push({ seat: name, printed: out.length });
        return true;
      },
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => names.map((name) => `${name}-pane`),
      classify: (_session, pane): ScreenKind => (t >= (idleAt.get(pane) ?? Infinity) ? 'idle' : 'working'),
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: () => {},
      log: (who, what) => logged.push({ who, what }),
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record) => records.final(seat, record),
      detail: (line) => records.detail(line),
    };

    const report = await executePlan(plan, 'acme', host, { concurrency: 8 });
    expect(report).toEqual({ serverFailed: false, watchFailed: false, held: false, dropped: [] });
    // Every seat settled before the run's end — d and e settled well before a — yet not one
    // line reached stdout ahead of the first seat in the file.
    expect(outWhen.map((entry) => entry.seat)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(outWhen.slice(0, 4).every((entry) => entry.printed === 0)).toBe(true);
    expect(out.join('')).toBe('a: ready\nb: ready\nc: ready\nd: ready\ne: ready\n');
    expect(logged).toEqual(names.map((who) => ({ who, what: 'ready' })));
  });

  test('with no options the plan runs one seat at a time, as before the window existed', async () => {
    const names = ['a', 'b', 'c'];
    const plan: Step[] = names.flatMap((name) => seatSteps(name, 'claude-code'));

    let t = 0;
    const events: string[] = [];
    const launchedAt = new Map<string, number>();
    const { out, sink: s } = sink(false);
    const records = progressWriter(s);

    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: (_session, _cwd, label) => {
        events.push(`create:${label}@${t}`);
        return { pane: `${label}-pane`, workspace: `${label}-ws` };
      },
      paneRun: (_session, pane) => {
        launchedAt.set(pane, t);
        events.push(`launch:${pane}@${t}`);
        return true;
      },
      typeLine: () => true,
      renameAgent: (_session, _pane, name) => {
        events.push(`rename:${name}@${t}`);
        return true;
      },
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => names.map((name) => `${name}-pane`),
      classify: (_session, pane): ScreenKind => {
        const start = launchedAt.get(pane) ?? 0;
        return t - start >= IDLE_POLL_MS ? 'idle' : 'working';
      },
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: () => {},
      log: () => {},
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record) => records.final(seat, record),
      detail: (line) => records.detail(line),
    };

    const report = await executePlan(plan, 'acme', host);
    expect(report).toEqual({ serverFailed: false, watchFailed: false, held: false, dropped: [] });
    // No seat's create ran until the seat before it had settled: a's whole launch, then b's,
    // then c's, in file order with no interleaving.
    expect(events).toEqual([
      'create:a@0',
      'launch:a-pane@0',
      'rename:a@2000',
      'create:b@2000',
      'launch:b-pane@2000',
      'rename:b@4000',
      'create:c@4000',
      'launch:c-pane@4000',
      'rename:c@6000',
    ]);
    expect(t).toBe(6000);
    expect(out.join('')).toBe('a: ready\nb: ready\nc: ready\n');
  });
});

// The serial opt-out at the level the owner types it: `team up --serial` on a machine with
// headroom for the full window. The plain-folder fixture is the same shape the up command's
// own tests use; only the machine reading and the interleaving it allows differ.
const NOW = new Date('2026-10-03T14:02:00Z');
const SESSION = 'acme-web';
const IDLE_SCREEN = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const AMPLE: Machine = {
  loadPerCore: 0.2,
  memoryFree: 60,
  diskFree: 200e9,
  swapTotal: 10e9,
  swapFree: 9e9,
  swapUsed: 1e9,
};

let bases: string[] = [];

afterEach(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
  bases = [];
});

function fresh(): { base: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-serial-')));
  bases.push(base);
  const home = join(base, 'home');
  mkdirSync(lobbyDir(home), { recursive: true });
  chmodSync(lobbyDir(home), 0o700);
  return { base, home };
}

function teamText(root: string): string {
  return `format: 1
project: acme
session: ${SESSION}
coordinator: claude-coordinator-acme
operator: claude-operator-acme
workspace:
  mode: shared
  base: main
trust:
  - ~/.config/team/lobby
  - ${root}
watch:
  interval: 120s
  checks:
    extra: off
    team-idle: off
    load: off
    memory: off
    disk: off
    swap-free: off
    swap-growth: off
    budget: off
    idle: off
    unsent: off
    restored: off
seats:
  - role: coordinator
    name: claude-coordinator-acme
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: claude-operator-acme
    label: operator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;
}

function approve(root: string, file: string, home: string, text: string): void {
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(file, text);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
}

function launchWorld(): { launch: Launch; order: string[] } {
  const order: string[] = [];
  const panes = new Map<string, { text: string; agent: boolean }>();
  let session: 'absent' | 'running' = 'absent';
  let n = 0;
  let clock = NOW.getTime();
  const launch: Launch = {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace(_session, _cwd, label) {
      n++;
      const pane = `w${n}:p1`;
      panes.set(pane, { text: IDLE_SCREEN, agent: false });
      order.push(`create:${label}`);
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      order.push(`run:${pane}:${command.includes(' watch') ? 'watch' : 'launch'}`);
      return true;
    },
    renameAgent(_session, _pane, name) {
      order.push(`rename:${name}`);
      return true;
    },
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return { launch, order };
}

function upSources(home: string, made: ReturnType<typeof launchWorld>): UpSources {
  return {
    sessionRunning: () => made.launch.sessionUp(''),
    agents: () => [],
    home,
    getuid: () => process.getuid?.() ?? 0,
    machine: () => AMPLE,
    now: made.launch.now,
    sleep: made.launch.sleep,
    doctor: {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => false,
      now: () => NOW,
      home,
    },
    launch: made.launch,
  };
}

describe('the serial opt-out on the up command', () => {
  test('up --serial launches the second seat only after the first is named, on an ample machine', async () => {
    const { base, home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(root);
    const file = join(root, '.agents', 'team.yaml');
    const text = teamText(root);
    approve(root, file, home, text);

    const made = launchWorld();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--serial', '--file', '.agents/team.yaml'], io, upSources(home, made));
    expect(code, io.out + io.err).toBe(0);
    expect(io.err).toContain('watch: started\n');
    // Serial: the operator's workspace exists only after the coordinator is renamed.
    expect(made.order.indexOf('rename:claude-coordinator-acme')).toBeLessThan(made.order.indexOf('create:operator'));
  });

  test('the same machine without the flag overlaps the two seats', async () => {
    const { base, home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(root);
    const file = join(root, '.agents', 'team.yaml');
    const text = teamText(root);
    approve(root, file, home, text);

    const made = launchWorld();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--file', '.agents/team.yaml'], io, upSources(home, made));
    expect(code, io.out + io.err).toBe(0);
    // Parallel: both workspaces were made before either seat was named — the contrast that
    // shows the flag above is what forced the order, not the fixture.
    expect(made.order.indexOf('create:operator')).toBeLessThan(made.order.indexOf('rename:claude-coordinator-acme'));
    expect(made.order.indexOf('create:operator')).toBeLessThan(made.order.indexOf('rename:claude-operator-acme'));
  });
});
