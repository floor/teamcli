import { describe, expect, test } from 'bun:test';
import { executePlan, type Host, type ScreenKind } from '../../src/launch/execute.ts';
import { IDLE_POLL_MS, type Step } from '../../src/launch/plan.ts';
import { progressWriter, type ProgressSink } from '../../src/launch/progress.ts';
import { launchConcurrency, type Machine } from '../../src/watch/machine.ts';

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
      do: { do: 'rename', seat: name, label: name, seconds, rules },
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

describe('launchConcurrency', () => {
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

  test('returns 8 when the machine has ample load, memory, and swap headroom', () => {
    const machine: Machine = {
      loadPerCore: 0.3,
      memoryFree: 60,
      diskFree: 200e9,
      swapTotal: 10e9,
      swapFree: 9e9,
      swapUsed: 1e9,
    };
    expect(launchConcurrency(machine, limits)).toBe(8);
  });

  test('scales concurrency down as load or free memory tightens', () => {
    const moderateLoad: Machine = {
      loadPerCore: 1.5,
      memoryFree: 60,
      diskFree: 200e9,
      swapTotal: 10e9,
      swapFree: 9e9,
      swapUsed: 1e9,
    };
    expect(launchConcurrency(moderateLoad, limits)).toBe(4);

    const moderateMemory: Machine = {
      loadPerCore: 0.3,
      memoryFree: 25,
      diskFree: 200e9,
      swapTotal: 10e9,
      swapFree: 9e9,
      swapUsed: 1e9,
    };
    expect(launchConcurrency(moderateMemory, limits)).toBe(3);
  });

  test('falls back to serial (1) when --serial is requested, machine is absent, or figures are near start limits', () => {
    const ample: Machine = {
      loadPerCore: 0.3,
      memoryFree: 60,
      diskFree: 200e9,
      swapTotal: 10e9,
      swapFree: 9e9,
      swapUsed: 1e9,
    };
    expect(launchConcurrency(ample, limits, true)).toBe(1);
    expect(launchConcurrency(undefined, limits)).toBe(1);
    expect(launchConcurrency({ ...ample, loadPerCore: null }, limits)).toBe(1);
    expect(launchConcurrency({ ...ample, memoryFree: null }, limits)).toBe(1);
    expect(launchConcurrency({ ...ample, loadPerCore: 2.0 }, limits)).toBe(1);
    expect(launchConcurrency({ ...ample, memoryFree: 20 }, limits)).toBe(1);
    expect(launchConcurrency({ ...ample, swapFree: 2.5e9 }, limits)).toBe(1);
  });
});

describe('parallel launch execution', () => {
  test('launches all seats in Phase 1 and waits concurrently in Phase 2, finishing 6 seats in one seat’s wait window', async () => {
    const names = ['seat-1', 'seat-2', 'seat-3', 'seat-4', 'seat-5', 'seat-6'];
    const plan: Step[] = [
      ...names.flatMap((name, i) => seatSteps(name, i % 2 === 0 ? 'claude-code' : 'codex')),
      { kind: 'run', argv: [], do: { do: 'spawn-watch', command: 'team watch', cwd: '.' } },
    ];

    let t = 0;
    const events: string[] = [];
    const { out, err, sink: s } = sink(false);
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
      deliverRules: async (_session, pane) => {
        events.push(`deliver:${pane}@${t}`);
        return true;
      },
      renameAgent: (_session, pane, name) => {
        events.push(`rename:${name}:${pane}@${t}`);
        return true;
      },
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      spawnWatch: () => 4242,
      agentPanes: () => names.map((name) => `${name}-pane`),
      // Every seat takes 6 s (3 polls of 2 s) before showing its idle prompt.
      classify: (): ScreenKind => (t >= 3 * IDLE_POLL_MS ? 'idle' : 'working'),
      sleep: async (ms) => {
        events.push(`sleep:${ms}@${t}`);
        t += ms;
      },
      now: () => t,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: (line) => err.push(line),
      log: (who, what) => logged.push({ who, what }),
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record) => records.final(seat, record),
      detail: (line) => records.detail(line),
    };

    const report = await executePlan(plan, 'acme', host, { concurrency: 8 });
    expect(report).toEqual({ serverFailed: false, watchFailed: false, held: false, dropped: [] });

    // All 6 seats complete in 6 s (3 shared polls of 2 s), well under 10 s, instead of 36 s.
    expect(t).toBe(6000);
    expect(events.filter((e) => e.startsWith('sleep:'))).toEqual([
      'sleep:2000@0',
      'sleep:2000@2000',
      'sleep:2000@4000',
    ]);

    // Phase 1 launched all 6 seats at t=0 before the first sleep occurred.
    const firstSleepIndex = events.indexOf('sleep:2000@0');
    const launchedBeforeSleep = events.slice(0, firstSleepIndex).filter((e) => e.startsWith('launch:'));
    expect(launchedBeforeSleep).toEqual(names.map((name) => `launch:${name}-pane@0`));

    // Output and log are in exact file order.
    expect(out.join('')).toBe(names.map((name) => `${name}: ready\n`).join(''));
    expect(err.join('')).toBe('watch: started\n');
    expect(logged).toEqual([
      ...names.map((who) => ({ who, what: 'ready' })),
      { who: 'watch', what: 'started' },
    ]);
  });

  test('serial mode (concurrency: 1) launches and waits on one seat at a time', async () => {
    const names = ['seat-1', 'seat-2', 'seat-3'];
    const plan: Step[] = names.flatMap((name) => seatSteps(name, 'claude-code'));

    let t = 0;
    const launchedAt = new Map<string, number>();
    const { out, sink: s } = sink(false);
    const records = progressWriter(s);

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
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => names.map((name) => `${name}-pane`),
      classify: (_session, pane): ScreenKind => {
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
      log: () => {},
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record) => records.final(seat, record),
      detail: (line) => records.detail(line),
    };

    await executePlan(plan, 'acme', host, { concurrency: 1 });
    expect(launchedAt.get('seat-1-pane')).toBe(0);
    expect(launchedAt.get('seat-2-pane')).toBe(4000);
    expect(launchedAt.get('seat-3-pane')).toBe(8000);
    expect(t).toBe(12000);
    expect(out.join('')).toBe('seat-1: ready\nseat-2: ready\nseat-3: ready\n');
  });

  test('out-of-order seat completion still emits stdout records, stderr details, and logs in exact file order', async () => {
    // seat-1 takes 6 s (3 polls); seat-2 is stopped in the file; seat-3 finishes in 2 s (1 poll);
    // seat-4 hits a vendor notice immediately at 0 s; seat-5 finishes in 4 s (2 polls).
    const plan: Step[] = [
      ...seatSteps('seat-1', 'claude-code'),
      { kind: 'skip', text: 'seat-2: stopped in the file; start it with `team add seat-2`' },
      ...seatSteps('seat-3', 'codex'),
      ...seatSteps('seat-4', 'codex'),
      ...seatSteps('seat-5', 'claude-code'),
      { kind: 'run', argv: [], do: { do: 'spawn-watch', command: 'team watch', cwd: '.' } },
    ];

    let t = 0;
    const { out, err, sink: s } = sink(false);
    const records = progressWriter(s);
    const logged: { who: string; what: string }[] = [];

    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: (_session, _cwd, label) => ({ pane: `${label}-pane`, workspace: `${label}-ws` }),
      paneRun: () => true,
      typeLine: () => true,
      deliverRules: async () => true,
      renameAgent: () => true,
      closeWorkspace: () => true,
      spawnWatch: () => 4242,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => ['seat-1-pane', 'seat-3-pane', 'seat-4-pane', 'seat-5-pane'],
      classify: (_session, pane): ScreenKind => {
        if (pane === 'seat-4-pane') return 'vendor notice';
        if (pane === 'seat-3-pane') return t >= 2000 ? 'idle' : 'working';
        if (pane === 'seat-5-pane') return t >= 4000 ? 'idle' : 'working';
        if (pane === 'seat-1-pane') return t >= 6000 ? 'idle' : 'working';
        return 'working';
      },
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: (line) => err.push(line),
      log: (who, what) => logged.push({ who, what }),
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record) => records.final(seat, record),
      detail: (line) => records.detail(line),
      cliVersion: (cli) => (cli === 'codex' ? '0.160.0' : null),
    };

    const report = await executePlan(plan, 'acme', host, { concurrency: 8 });
    expect(report.dropped).toEqual(['seat-4']);
    expect(t).toBe(6000);

    expect(out.join('')).toBe(
      'seat-1: ready\n' +
        'seat-3: ready\n' +
        'seat-4: left out: vendor notice\n' +
        'seat-5: ready\n',
    );
    expect(err.join('')).toBe(
      '  skip seat-2: stopped in the file; start it with `team add seat-2`\n' +
        '  untested on 0.160.0\n' +
        '  its workspace was closed without input and the seat left out\n' +
        'watch: started\n',
    );
    expect(logged).toEqual([
      { who: 'seat-1', what: 'ready' },
      { who: 'seat-3', what: 'ready' },
      { who: 'seat-4', what: 'left out: vendor notice' },
      { who: 'seat-5', what: 'ready' },
      { who: 'watch', what: 'started' },
    ]);
  });

  test('draws per-seat progress on a terminal and finishes each seat with one newline-terminated record in file order', async () => {
    const plan: Step[] = [
      ...seatSteps('alpha', 'claude-code'),
      ...seatSteps('beta', 'codex'),
    ];

    let t = 0;
    const { out, err, sink: s } = sink(true);
    const records = progressWriter(s);

    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: (_session, _cwd, label) => ({ pane: `${label}-pane`, workspace: `${label}-ws` }),
      paneRun: () => true,
      typeLine: () => true,
      deliverRules: async () => true,
      renameAgent: () => true,
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => ['alpha-pane', 'beta-pane'],
      // beta finishes at t=0, alpha finishes at t=2000.
      classify: (_session, pane): ScreenKind => (pane === 'beta-pane' || t >= 2000 ? 'idle' : 'working'),
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: (line) => err.push(line),
      log: () => {},
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record) => records.final(seat, record),
      detail: (line) => records.detail(line),
    };

    await executePlan(plan, 'acme', host, { concurrency: 4 });
    expect(out.every((chunk) => chunk.startsWith('\r\x1b[K'))).toBe(true);
    expect(out.some((chunk) => chunk.includes('alpha: launching'))).toBe(true);
    expect(out.some((chunk) => chunk.includes('beta: launching'))).toBe(true);
    expect(out.some((chunk) => chunk.includes('alpha: waiting for its prompt'))).toBe(true);
    expect(out.some((chunk) => chunk.includes('beta: sending its rules'))).toBe(true);
    const finals = out.filter((chunk) => chunk.endsWith('\n'));
    expect(finals).toEqual(['\r\x1b[Kalpha: ready\n', '\r\x1b[Kbeta: ready\n']);
    expect(err).toEqual([]);
  });

  test('respects the concurrency window and stops remaining seats when machine limits are crossed mid-launch', async () => {
    const names = ['seat-1', 'seat-2', 'seat-3', 'seat-4'];
    const plan: Step[] = names.flatMap((name) => seatSteps(name, 'claude-code'));

    let t = 0;
    let activeWaits = 0;
    let maxActiveWaits = 0;
    let launchedCount = 0;
    const { out, sink: s } = sink(false);
    const records = progressWriter(s);

    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: (_session, _cwd, label) => ({ pane: `${label}-pane`, workspace: `${label}-ws` }),
      paneRun: () => {
        launchedCount++;
        activeWaits++;
        if (activeWaits > maxActiveWaits) maxActiveWaits = activeWaits;
        return true;
      },
      typeLine: () => true,
      renameAgent: () => {
        activeWaits--;
        return true;
      },
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => names.map((name) => `${name}-pane`),
      classify: (_session, pane): ScreenKind => {
        if (pane === 'seat-1-pane' || pane === 'seat-2-pane') return t >= 2000 ? 'idle' : 'working';
        return t >= 4000 ? 'idle' : 'working';
      },
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      allow: () => (launchedCount >= 2 ? 'load per core 2.8 exceeds load_start 2.5' : null),
      record: () => {},
      running: () => {},
      drop: () => {},
      say: () => {},
      log: () => {},
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record) => records.final(seat, record),
      detail: (line) => records.detail(line),
    };

    const report = await executePlan(plan, 'acme', host, { concurrency: 2 });
    expect(maxActiveWaits).toBe(2);
    expect(report.dropped).toEqual(['seat-3', 'seat-4']);
    expect(out.join('')).toBe(
      'seat-1: ready\n' +
        'seat-2: ready\n' +
        'seat-3: left out: load per core 2.8 exceeds load_start 2.5\n' +
        'seat-4: left out: load per core 2.8 exceeds load_start 2.5\n',
    );
  });

  test('serializes interactive owner dialogs and closes non-ready workspaces cleanly on stop (q)', async () => {
    const names = ['seat-1', 'seat-2', 'seat-3'];
    const plan: Step[] = names.flatMap((name) => seatSteps(name, 'claude-code'));

    let t = 0;
    const closedWorkspaces: string[] = [];
    const promptOrder: string[] = [];
    const { out, sink: s } = sink(false);
    const records = progressWriter(s);

    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: (_session, _cwd, label) => ({ pane: `${label}-pane`, workspace: `${label}-ws` }),
      paneRun: () => true,
      typeLine: () => true,
      renameAgent: () => true,
      closeWorkspace: (_session, ws) => {
        closedWorkspaces.push(ws);
        return true;
      },
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => names.map((name) => `${name}-pane`),
      agentList: () =>
        names.map((name) => ({
          name: null,
          agent: 'claude',
          pane: `${name}-pane`,
          workspace: `${name}-ws`,
          status: 'idle',
          cwd: null,
        })),
      workspacePanes: (_session, ws) => [`${ws.replace(/-ws$/, '')}-pane`],
      processInfo: () => ({
        shell: 100,
        foreground: [200],
      }),
      // seat-1 finishes immediately; seat-2 hits trust at t=0 and owner chooses 'q' (stopped);
      // seat-3 is still working at t=0 and should be stopped and closed cleanly.
      classify: (_session, pane): ScreenKind => {
        if (pane === 'seat-1-pane') return 'idle';
        if (pane === 'seat-2-pane') return 'trust';
        return 'working';
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
      dialog: {
        mode: 'prompt',
        run: async (input) => {
          promptOrder.push(input.seat);
          return { kind: 'stopped' };
        },
      },
    };

    const report = await executePlan(plan, 'acme', host, { concurrency: 4 });
    expect(promptOrder).toEqual(['seat-2']);
    expect(closedWorkspaces).toEqual(['seat-2-ws', 'seat-3-ws']);
    expect(report.dropped).toEqual(['seat-2', 'seat-3']);
    expect(out.join('')).toBe(
      'seat-1: ready\n' +
        'seat-2: left out: stopped cleanly\n' +
        'seat-3: left out: stopped cleanly\n',
    );
  });
});
