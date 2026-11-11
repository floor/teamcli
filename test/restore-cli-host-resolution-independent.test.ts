import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripSgr } from '../src/ansi.ts';
import { runApprove } from '../src/approve/command.ts';
import { blocksLaunch, doctorFindings, type DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import {
  setHerdrRun,
  type HerdrAgent,
  type HerdrWorkspace,
  type PaneProcesses,
} from '../src/herdr.ts';
import { runRestoreSweepForRoute } from '../src/launch/restore-sweep.ts';
import { conversationOnDisk } from '../src/profiles/profile.ts';
import { readState } from '../src/state.ts';
import { approvalStanding } from '../src/store/store.ts';
import type { Machine } from '../src/watch/machine.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, fixtureBase, gitEnv, testIo } from './helpers.ts';

const CODEX_IDLE = stripSgr(
  readFileSync(new URL('./fixtures/codex/0.167.0/idle.txt', import.meta.url), 'utf8'),
);

const NOW = new Date('2026-10-21T15:00:00Z');
const AMPLE: Machine = {
  loadPerCore: 0.3,
  memoryFree: 60,
  diskFree: 200e9,
  swapTotal: 10e9,
  swapFree: 9e9,
  swapUsed: 1e9,
};

const bases: string[] = [];
let base: string;
let root: string;
let home: string;
let stateDir: string;
let teamFile: string;

type SeatSpec = {
  name: string;
  cli?: 'claude-code' | 'codex';
  vendor?: string;
  model?: string;
  version?: string;
  launch?: string;
};

function teamYaml(options: { seats?: SeatSpec[] } = {}): string {
  const list: SeatSpec[] = options.seats ?? [
    {
      name: 'seat-1',
      cli: 'claude-code',
      vendor: 'anthropic',
      model: 'Claude Opus',
      version: '5.5',
      launch: 'claude',
    },
    {
      name: 'seat-2',
      cli: 'codex',
      vendor: 'openai',
      model: 'GPT Sol',
      version: '6.1',
      launch: 'codex -m gpt-6.1-sol',
    },
  ];
  const coordinator = list[0]?.name ?? 'seat-1';
  const rows = list
    .map((seat) => {
      const cli = seat.cli ?? 'claude-code';
      const vendor = seat.vendor ?? (cli === 'codex' ? 'openai' : 'anthropic');
      const model = seat.model ?? (cli === 'codex' ? 'GPT Sol' : 'Claude Opus');
      const version = seat.version ?? (cli === 'codex' ? '6.1' : '5.5');
      const launch = seat.launch ?? (cli === 'codex' ? 'codex -m gpt-6.1-sol' : 'claude');
      return `  - role: implementer
    name: ${seat.name}
    cli: ${cli}
    vendor: ${vendor}
    model: ${model}
    version: "${version}"
    launch: ${launch}`;
    })
    .join('\n');
  return `format: 1
project: sweep
coordinator: ${coordinator}
operator: ${coordinator}
session: sweep
workspace:
  mode: shared
trust:
  - ~/.config/team/lobby
  - ${root}
seats:
${rows}
`;
}

beforeEach(() => {
  base = fixtureBase('restore-cli-host-ind-');
  bases.push(base);
  root = join(base, 'repo');
  home = join(base, 'home');
  stateDir = join(root, '.agents');
  teamFile = join(stateDir, 'team.yaml');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q'], {
    cwd: root,
    env: gitEnv(),
  });
  writeFileSync(teamFile, teamYaml());
});

afterEach(() => {
  setHerdrRun(null);
  discardFixtures(bases.splice(0), { roots: [join(base, '..')] });
});

async function approve(): Promise<void> {
  const code = await runApprove(['--file', teamFile], testIo(root, { kind: 'owner' }), {
    ask: async () => '5',
    waiting: () => 'empty',
    now: () => NOW,
    home,
  });
  expect(code).toBe(0);
}

function makeDoctor(overrides: Partial<DoctorSources> = {}): DoctorSources {
  return {
    version: (binary) => (binary === 'codex' ? '0.167.0' : '2.1.288'),
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
    ...overrides,
  };
}

function recordSessionSeats(seats?: Record<string, Record<string, unknown>>): void {
  const defaultRecorded = {
    'seat-1': {
      pane: 'pane-gone-1',
      workspace: 'ws-gone-1',
      cli: 'claude-code',
      command: 'claude',
      cwd: root,
      stage: 'ready',
      launchedAt: '2026-10-21T14:00:00.000Z',
    },
    'seat-2': {
      pane: 'pane-gone-2',
      workspace: 'ws-gone-2',
      cli: 'codex',
      command: 'codex -m gpt-6.1-sol',
      cwd: root,
      stage: 'ready',
      launchedAt: '2026-10-21T14:00:00.000Z',
    },
  };
  const statePath = join(stateDir, 'team.state.json');
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        format: 1,
        sessions: {
          sweep: {
            seats: seats ?? defaultRecorded,
            worktrees: {},
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

type FreshOverride = {
  foreground?: string[];
  screen?: string;
  process?: PaneProcesses | null;
  inAgentList?: boolean;
};

type Harness = {
  creates: string[];
  runs: { pane: string; command: string }[];
  closes: string[];
  renames: { pane: string; name: string }[];
  seatClis: Map<string, 'claude-code' | 'codex'>;
  freshOverrides: Map<string, FreshOverride>;
  launch: Launch;
  sources(extra?: Partial<UpSources>): UpSources;
};

function makeHarness(seatClis: Record<string, 'claude-code' | 'codex'> = { 'seat-1': 'claude-code', 'seat-2': 'codex' }): Harness {
  const createdWorkspaces = new Map<string, { pane: string; label: string; named: string | null }>();
  let freshCount = 0;
  let clock = NOW.getTime();

  const harness: Harness = {
    creates: [],
    runs: [],
    closes: [],
    renames: [],
    seatClis: new Map(Object.entries(seatClis)),
    freshOverrides: new Map(),
    launch: {} as Launch,
    sources(extra: Partial<UpSources> = {}): UpSources {
      return {
        sessionRunning: () => true,
        sessionState: () => 'running',
        agents: () => harness.launch.agents('sweep'),
        workspaces: (): HerdrWorkspace[] => {
          const out: HerdrWorkspace[] = [];
          for (const [id, item] of createdWorkspaces) {
            out.push({ id, label: item.label });
          }
          return out;
        },
        home,
        now: harness.launch.now,
        sleep: harness.launch.sleep,
        launch: harness.launch,
        doctor: makeDoctor(),
        machine: () => AMPLE,
        ...extra,
      };
    },
  };

  const labelForPane = (pane: string): string | undefined => {
    for (const created of createdWorkspaces.values()) {
      if (created.pane === pane) return created.label;
    }
    return undefined;
  };

  harness.launch = {
    conversationExists(cli, cwd, id, command) {
      return conversationOnDisk(cli, cwd, id, { ...process.env, CLAUDE_CONFIG_DIR: join(home, '.claude-empty') }, command);
    },
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      freshCount += 1;
      const workspace = `ws-fresh-${freshCount}`;
      const pane = `pane-fresh-${freshCount}`;
      const seatName = label.split(' · ')[0]!;
      createdWorkspaces.set(workspace, { pane, label: seatName, named: null });
      harness.creates.push(seatName);
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      harness.runs.push({ pane, command });
      return true;
    },
    renameAgent(_session, pane, name) {
      harness.renames.push({ pane, name });
      for (const created of createdWorkspaces.values()) {
        if (created.pane === pane) created.named = name;
      }
      return true;
    },
    closeWorkspace(_session, workspace) {
      harness.closes.push(workspace);
      return true;
    },
    agentPanes() {
      const listed: string[] = [];
      for (const created of createdWorkspaces.values()) {
        const override = harness.freshOverrides.get(created.label);
        if (override?.inAgentList === false) continue;
        listed.push(created.pane);
      }
      return listed;
    },
    agents(): HerdrAgent[] {
      const list: HerdrAgent[] = [];
      for (const [workspace, created] of createdWorkspaces) {
        const override = harness.freshOverrides.get(created.label);
        if (override?.inAgentList === false) continue;
        const cli = harness.seatClis.get(created.label) ?? 'claude-code';
        list.push({
          name: created.named,
          agent: cli === 'codex' ? 'codex' : 'claude',
          pane: created.pane,
          workspace,
          status: 'idle',
          cwd: null,
        });
      }
      return list;
    },
    workspacePanes(_session, workspace) {
      const created = createdWorkspaces.get(workspace);
      return created ? [created.pane] : [];
    },
    paneText(_session, pane) {
      const label = labelForPane(pane);
      if (label !== undefined) {
        const override = harness.freshOverrides.get(label);
        if (override?.screen !== undefined) return override.screen;
        const cli = harness.seatClis.get(label) ?? 'claude-code';
        return cli === 'codex' ? CODEX_IDLE : CLAUDE_IDLE;
      }
      return CLAUDE_IDLE;
    },
    foreground(_session, pane) {
      const label = labelForPane(pane);
      if (label !== undefined) {
        const override = harness.freshOverrides.get(label);
        if (override?.foreground !== undefined) return override.foreground;
        const cli = harness.seatClis.get(label) ?? 'claude-code';
        return cli === 'codex' ? ['codex'] : ['claude'];
      }
      return ['claude'];
    },
    processInfo(_session, pane): PaneProcesses | null {
      const label = labelForPane(pane);
      if (label !== undefined) {
        const override = harness.freshOverrides.get(label);
        if (override && 'process' in override) return override.process ?? null;
      }
      for (const created of createdWorkspaces.values()) {
        if (created.pane === pane) return { shell: 900, foreground: [900, 901] };
      }
      return null;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };

  return harness;
}

describe('restore CLI version probe deferral to terminal host resolution', () => {
  test('Scene 1: mixed CLI restore where process-side version probe fails for claude and succeeds for codex defers lookup to terminal host and restores both seats (both automatic sweep and explicit restore dry-run)', async () => {
    recordSessionSeats();
    await approve();

    const doc = makeDoctor({
      // Simulate a restore child environment where `claude --version` fails (null) while `codex --version` succeeds.
      version: (binary) => (binary === 'claude' ? null : '0.167.0'),
    });

    // 1a) Explicit all-team restore with --dry-run (uses internal.restore = true without restoreMissingOnly)
    const dryHarness = makeHarness({ 'seat-1': 'claude-code', 'seat-2': 'codex' });
    const dryIo = testIo(root, { kind: 'owner' });
    const dryCode = await runUp(['--file', teamFile, '--dry-run'], dryIo, dryHarness.sources({ doctor: doc }), {
      caller: { kind: 'owner' },
      restore: true,
    });
    expect(dryCode, dryIo.err + dryIo.out).toBe(0);
    expect(dryIo.err + dryIo.out).not.toContain('install `claude`');
    expect(dryHarness.creates).toEqual([]);

    // 1b) Automatic route restore sweep (runRestoreSweepForRoute -> internal.restore = true, restoreMissingOnly = true)
    const harness = makeHarness({ 'seat-1': 'claude-code', 'seat-2': 'codex' });
    const sweep = await runRestoreSweepForRoute({
      home,
      root,
      teamFile,
      sources: harness.sources({ doctor: doc }),
    });

    expect(sweep.kind).toBe('ran');
    if (sweep.kind === 'ran') {
      expect(sweep.failed).toBe(false);
      expect(sweep.summary.refused).toBe(0);
    }
    expect(harness.creates).toEqual(['seat-1', 'seat-2']);
    expect(harness.runs).toHaveLength(2);

    const afterState = readState(stateDir).sessions.sweep?.seats ?? {};
    expect(afterState['seat-1']?.stage).toBe('ready');
    expect(afterState['seat-2']?.stage).toBe('ready');
  });

  test('Scene 2: failed version probe vs actual binary absence in terminal host reports named per-seat failure while sibling seat continues to ready', async () => {
    recordSessionSeats();
    await approve();

    const harness = makeHarness({ 'seat-1': 'claude-code', 'seat-2': 'codex' });
    // seat-1 is genuinely unlaunchable in the terminal host while seat-2 (codex) succeeds:
    const origPaneRun = harness.launch.paneRun.bind(harness.launch);
    harness.launch.paneRun = (session, pane, command) => {
      origPaneRun(session, pane, command);
      return !command.includes('claude');
    };

    const doc = makeDoctor({
      version: (binary) => (binary === 'claude' ? null : '0.167.0'),
    });

    const io = testIo(root, { kind: 'owner' });
    const exit = await runUp(['--file', teamFile], io, harness.sources({ doctor: doc }), {
      caller: { kind: 'owner' },
      nonInteractive: true,
      restore: true,
      restoreMissingOnly: true,
    });

    expect(exit).toBe(1);
    expect(io.err).toContain(
      "seat-1: the restore process could not read claude's version; the terminal host will resolve each seat's launch command",
    );
    // Named failure for seat-1:
    expect(io.err + io.out).toContain('seat-1: its launch command did not run');
    // Sibling seat-2 still launched and reached ready:
    expect(harness.creates).toEqual(['seat-1', 'seat-2']);
    const afterState = readState(stateDir).sessions.sweep?.seats ?? {};
    expect(afterState['seat-2']?.stage).toBe('ready');
    expect(afterState['seat-1']?.stage).not.toBe('ready');
  });

  test('Scene 3: non-version doctor refusals (missing login, missing herdr) remain blocking during restore', async () => {
    recordSessionSeats();
    await approve();

    // 3a) Login refusal when version probe succeeds: restore must still refuse and launch nothing.
    const harnessLogin = makeHarness({ 'seat-1': 'claude-code', 'seat-2': 'codex' });
    const docLogin = makeDoctor({
      version: (binary) => (binary === 'codex' ? '0.167.0' : '2.1.288'),
      loggedIn: (profile) => (profile.cli === 'claude-code' ? false : true),
    });
    const sweepLogin = await runRestoreSweepForRoute({
      home,
      root,
      teamFile,
      sources: harnessLogin.sources({ doctor: docLogin }),
    });
    expect(sweepLogin.kind).toBe('refused');
    if (sweepLogin.kind === 'refused') {
      expect(sweepLogin.exit).toBe(1);
      expect(sweepLogin.detail).toContain('log in to claude-code:');
    }
    expect(harnessLogin.creates).toEqual([]);
    expect(harnessLogin.runs).toEqual([]);

    // 3b) Missing herdr binary: restore must still refuse even if CLI version probe is also null.
    const harnessHerdr = makeHarness({ 'seat-1': 'claude-code', 'seat-2': 'codex' });
    const docHerdr = makeDoctor({
      version: () => null,
      herdrVersion: () => null,
    });
    const ioHerdr = testIo(root, { kind: 'owner' });
    const codeHerdr = await runUp(['--file', teamFile], ioHerdr, harnessHerdr.sources({ doctor: docHerdr }), {
      restore: true,
      restoreMissingOnly: true,
      caller: { kind: 'owner' },
    });
    expect(codeHerdr).toBe(1);
    expect(ioHerdr.err).toContain('install herdr: it is not on the PATH');
    const sweepHerdr = await runRestoreSweepForRoute({
      home,
      root,
      teamFile,
      sources: harnessHerdr.sources({ doctor: docHerdr }),
    });
    expect(sweepHerdr.kind).toBe('refused');
    if (sweepHerdr.kind === 'refused') {
      expect(sweepHerdr.exit).toBe(1);
    }
    expect(harnessHerdr.creates).toEqual([]);
    expect(harnessHerdr.runs).toEqual([]);
  });

  test('Scene 4: caller admission refusal remains unchanged when an unadmitted seat invokes restore', async () => {
    recordSessionSeats();
    await approve();

    const harness = makeHarness({ 'seat-1': 'claude-code', 'seat-2': 'codex' });
    const doc = makeDoctor({
      version: () => null,
    });
    // Non-lead seat-2 is not admitted to run up / restore.
    const io = testIo(root, { kind: 'seat', name: 'seat-2', session: 'sweep' });
    const code = await runUp(['--file', teamFile], io, harness.sources({ doctor: doc }), {
      restore: true,
      restoreMissingOnly: true,
      caller: { kind: 'seat', name: 'seat-2', session: 'sweep' },
    });
    expect(code).toBe(1);
    expect(harness.creates).toEqual([]);
    expect(harness.runs).toEqual([]);
  });

  test('Scene 5: normal team up and doctorFindings still treat a failed CLI version probe as a blocking miss', async () => {
    recordSessionSeats();
    await approve();

    const harness = makeHarness({ 'seat-1': 'claude-code', 'seat-2': 'codex' });
    const doc = makeDoctor({
      version: (binary) => (binary === 'claude' ? null : '0.167.0'),
    });

    const standing = approvalStanding(root, home);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--file', teamFile], io, harness.sources({ doctor: doc }));
    expect(code).toBe(1);
    expect(io.err).toContain('install `claude`: it is not on the PATH (claude-code: seat-1)');
    expect(harness.creates).toEqual([]);
    expect(harness.runs).toEqual([]);

    const loaded = readTeamConfig(root, { file: teamFile, home });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const findings = doctorFindings(
        loaded.team,
        root,
        stateDir,
        'sweep',
        doc,
        [],
        standing,
      );
      const claudeMiss = findings.find((f) => f.cliVersionUnavailable?.binary === 'claude');
      expect(claudeMiss).toBeDefined();
      expect(claudeMiss?.level).toBe('miss');
      expect(claudeMiss?.cliVersionUnavailable).toEqual({ binary: 'claude', seats: ['seat-1'] });
      expect(blocksLaunch(claudeMiss!)).toBe(true);
    }
  });
});
