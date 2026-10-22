// Restore-sweep summary aggregation and output contract:
// - Consumes `restoreSummaryOf(report.restoreBuckets)` directly in `src/commands/up.ts`.
// - Emits the canonical one-line summary (`N seat(s) repaired, M skipped (working), K refused`)
//   with `(seat: why; ...)` when `K > 0`, and emits `0 seats repaired, 0 skipped (working), 0 refused`
//   even on a healthy 0/0/0 pass.
// - Exposes `restore_summary` and the aggregate `action_summary` on `team.up` (`--json`), while
//   preserving all per-seat records in `notes` and surfacing the summary on `--json` partial failures.
// - Never infers `repaired` from an attempted launch: a relaunch that fails or times out before
//   `finishReady` lands in `K refused`, never `N repaired`.
// - Exits `0` when `K === 0` (including when `M > 0` working seats are skipped) and `1` when `K > 0`.

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { UP_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import type { Machine } from '../src/watch/machine.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

const NOW = new Date('2026-10-21T18:00:00Z');
const SUMMARY_RE = /^(\d+) seats? repaired, (\d+) skipped \(working\), (\d+) refused(?: \((.+)\))?$/m;

const OPUS_IDLE = CLAUDE_IDLE;
const SONNET_IDLE = CLAUDE_IDLE.replaceAll('Opus 5.5', 'Sonnet 5.5');
const OPUS_WORKING = CLAUDE_IDLE.replace('\n\n\n', '\n✳ Thinking… (esc to interrupt)\n\n');

const AMPLE_MACHINE: Machine = {
  loadPerCore: 0.25,
  memoryFree: 65,
  diskFree: 200e9,
  swapTotal: 8e9,
  swapFree: 8e9,
  swapUsed: 0,
};

const TIGHT_MACHINE: Machine = {
  loadPerCore: 1.5,
  memoryFree: 5,
  diskFree: 200e9,
  swapTotal: 8e9,
  swapFree: 1e9,
  swapUsed: 7e9,
};

type SeatSeed = {
  seat: string;
  recordedPane: string;
  recordedWorkspace: string;
  recordedShellPid: number;
  recordedCliPid: number;
  recordedSession?: string;
  livePane?: string | null;
  liveWorkspace?: string;
  liveShellPid?: number;
  liveCliPid?: number;
  liveAgentSession?: string;
  liveStatus?: HerdrAgent['status'];
  liveScreen?: string;
  postLaunchScreen?: string;
};

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
});

function claudeTranscriptSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

function writeClaudeTranscript(home: string, cwd: string, sessionId: string): void {
  const dir = join(home, '.claude', 'projects', claudeTranscriptSlug(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n');
}

function makePlace() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-flo1061-summary-')));
  bases.push(base);
  const home = join(base, 'home');
  const root = join(base, 'repo');
  const dir = join(root, '.agents');
  const lobby = join(home, '.config', 'team', 'lobbies', 'acme-restore');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv() });

  const yaml = `format: 1
project: acme-restore
coordinator: orchestrator
operator: operator-1
session: acme-restore
workspace:
  mode: shared
trust:
  - ~/.config/team/lobby
  - ${root}
seats:
  - role: orchestrator
    name: orchestrator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
  - role: operator
    name: operator-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: builder-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
  - role: implementer
    name: builder-2
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
`;
  const teamFilePath = join(dir, 'team.yaml');
  writeFileSync(teamFilePath, yaml);
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(`team.yaml failed to load: ${JSON.stringify(loaded.errors)}`);
  writeApproval(
    storePath(loaded.team.project, root, home),
    { approval: approvalOf(loaded.team, root, NOW), file: yaml },
    [],
    home,
    NOW,
  );
  return { base, home, root, dir, lobby, teamFilePath, team: loaded.team };
}

function healthySeeds(home: string, root: string): SeatSeed[] {
  const lobby = join(home, '.config', 'team', 'lobbies', 'acme-restore');
  writeClaudeTranscript(home, root, 'ses-orch');
  writeClaudeTranscript(home, root, 'ses-op1');
  writeClaudeTranscript(home, lobby, 'ses-b1');
  writeClaudeTranscript(home, lobby, 'ses-b2');
  return [
    {
      seat: 'orchestrator',
      recordedPane: 'w1:p1',
      recordedWorkspace: 'w1',
      recordedShellPid: 100,
      recordedCliPid: 101,
      recordedSession: 'ses-orch',
      livePane: 'w1:p1',
      liveWorkspace: 'w1',
      liveShellPid: 200,
      liveCliPid: 201,
      liveAgentSession: 'ses-orch',
      liveStatus: 'idle',
      liveScreen: OPUS_IDLE,
    },
    {
      seat: 'operator-1',
      recordedPane: 'w2:p1',
      recordedWorkspace: 'w2',
      recordedShellPid: 110,
      recordedCliPid: 111,
      recordedSession: 'ses-op1',
      livePane: 'w2:p1',
      liveWorkspace: 'w2',
      liveShellPid: 210,
      liveCliPid: 211,
      liveAgentSession: 'ses-op1',
      liveStatus: 'idle',
      liveScreen: OPUS_IDLE,
    },
    {
      seat: 'builder-1',
      recordedPane: 'w3:p1',
      recordedWorkspace: 'w3',
      recordedShellPid: 120,
      recordedCliPid: 121,
      recordedSession: 'ses-b1',
      livePane: 'w3:p1',
      liveWorkspace: 'w3',
      liveShellPid: 220,
      liveCliPid: 221,
      liveAgentSession: 'ses-b1',
      liveStatus: 'idle',
      liveScreen: SONNET_IDLE,
    },
    {
      seat: 'builder-2',
      recordedPane: 'w4:p1',
      recordedWorkspace: 'w4',
      recordedShellPid: 130,
      recordedCliPid: 131,
      recordedSession: 'ses-b2',
      livePane: 'w4:p1',
      liveWorkspace: 'w4',
      liveShellPid: 230,
      liveCliPid: 231,
      liveAgentSession: 'ses-b2',
      liveStatus: 'idle',
      liveScreen: SONNET_IDLE,
    },
  ];
}

function buildWorld(
  place: ReturnType<typeof makePlace>,
  seeds: SeatSeed[],
  options: {
    preCloseScreenOverride?: Record<string, string>;
    machine?: () => Machine;
  } = {},
) {
  updateState(place.dir, (file) => {
    const seatsState: Record<string, unknown> = {};
    for (const seed of seeds) {
      seatsState[seed.seat] = {
        id: `seat_${seed.seat}`,
        stage: 'ready',
        pane: seed.recordedPane,
        workspace: seed.recordedWorkspace,
        launched: { shell: seed.recordedShellPid, cli: [seed.recordedCliPid] },
        ...(seed.recordedSession ? { agent_session: seed.recordedSession } : {}),
      };
    }
    file.sessions['acme-restore'] = {
      seats: seatsState as never,
      worktrees: {},
      watch: { pane: 'w9:p1', heartbeat: NOW.toISOString(), workspace: 'w9' },
    };
  });

  const closes: string[] = [];
  const creates: string[] = [];
  const runs: { pane: string; command: string }[] = [];
  const launchedPanes = new Map<string, { seat: string; postScreen: string }>();
  const screenReadsPerPane = new Map<string, number>();
  let nextIdx = 20;
  let clock = NOW.getTime();

  const seedByLivePane = (pane: string) => seeds.find((s) => s.livePane === pane);

  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      creates.push(label);
      nextIdx += 1;
      const workspace = `w${nextIdx}`;
      const pane = `${workspace}:p1`;
      const seat = seeds.find((s) => label.startsWith(s.seat))?.seat ?? label;
      const seed = seeds.find((s) => s.seat === seat);
      launchedPanes.set(pane, {
        seat,
        postScreen: seed?.postLaunchScreen ?? SONNET_IDLE,
      });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      runs.push({ pane, command });
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      closes.push(workspace);
      return true;
    },
    agentPanes: () => [
      ...seeds.flatMap((s) => (s.livePane ? [s.livePane] : [])),
      ...launchedPanes.keys(),
    ],
    agents: (): HerdrAgent[] =>
      seeds.flatMap((s) =>
        s.livePane
          ? [
              {
                name: s.seat,
                agent: 'claude',
                pane: s.livePane,
                workspace: s.liveWorkspace ?? s.recordedWorkspace,
                status: s.liveStatus ?? 'idle',
                cwd: s.seat === 'orchestrator' || s.seat === 'operator-1' ? place.root : place.lobby,
                ...(s.liveAgentSession ? { session: s.liveAgentSession } : {}),
              },
            ]
          : [],
      ),
    workspacePanes: (_session, workspace) => {
      const fromSeed = seeds
        .filter((s) => (s.liveWorkspace ?? s.recordedWorkspace) === workspace && s.livePane)
        .map((s) => s.livePane as string);
      if (fromSeed.length > 0) return fromSeed;
      for (const [pane, info] of launchedPanes.entries()) {
        if (pane.startsWith(`${workspace}:`)) {
          void info;
          return [pane];
        }
      }
      return [];
    },
    paneText: (_session, pane) => {
      const launched = launchedPanes.get(pane);
      if (launched) return launched.postScreen;
      const count = (screenReadsPerPane.get(pane) ?? 0) + 1;
      screenReadsPerPane.set(pane, count);
      if (count >= 2 && options.preCloseScreenOverride?.[pane] !== undefined) {
        return options.preCloseScreenOverride[pane];
      }
      return seedByLivePane(pane)?.liveScreen ?? CLAUDE_IDLE;
    },
    foreground: () => ['claude'],
    processInfo: (_session, pane): PaneProcesses | null => {
      if (pane === 'w9:p1') return { shell: 900, foreground: [901] };
      if (launchedPanes.has(pane)) return { shell: 800, foreground: [801] };
      const s = seedByLivePane(pane);
      if (!s) return null;
      const shell = s.liveShellPid ?? s.recordedShellPid + 100;
      const cli = s.liveCliPid ?? s.recordedCliPid + 100;
      return { shell, foreground: [cli] };
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };

  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => new Date(clock),
    home: place.home,
  };

  const sources: UpSources = {
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => launch.agents('acme-restore'),
    workspaces: () =>
      seeds.map((s) => ({
        id: s.liveWorkspace ?? s.recordedWorkspace,
        label: `${s.seat} · acme-restore`,
      })),
    home: place.home,
    now: () => new Date(clock),
    sleep: launch.sleep,
    launch,
    doctor,
    machine: options.machine ?? (() => AMPLE_MACHINE),
    terminal: () => ({
      key: async () => 'eof' as const,
      drain: () => {},
    }),
  };

  return { sources, closes, creates, runs };
}

describe('canonical restore-summary line in plain, --json, and team.log', () => {
  test('healthy 0/0/0 restore pass emits 0 seats repaired, 0 skipped (working), 0 refused in plain, --json, and team.log and exits 0', async () => {
    const place = makePlace();
    const seeds = healthySeeds(place.home, place.root);
    const world = buildWorld(place, seeds);

    const ioPlain = testIo(place.root, { kind: 'owner' });
    const exitPlain = await runUp([], ioPlain, world.sources);
    expect(exitPlain).toBe(0);
    expect(world.closes).toEqual([]);
    expect(world.runs).toEqual([]);
    expect(ioPlain.out).toContain('orchestrator: ready\n');
    expect(ioPlain.out).toContain('builder-1: ready\n');
    expect(ioPlain.err).toContain('0 seats repaired, 0 skipped (working), 0 refused\n');
    expect(SUMMARY_RE.exec(ioPlain.err)?.[0]).toBe('0 seats repaired, 0 skipped (working), 0 refused');

    const logText = readFileSync(join(place.dir, 'team.log'), 'utf8');
    expect(logText).toContain('0 seats repaired, 0 skipped (working), 0 refused');

    // Verify `--json` contract on the same 0/0/0 baseline
    const worldJson = buildWorld(place, seeds);
    const ioJson = testIo(place.root, { kind: 'owner' });
    const exitJson = await runUp(['--json'], ioJson, worldJson.sources);
    expect(exitJson).toBe(0);
    expect(ioJson.err).toBe('');
    const doc = assertMatchesOutputSchema<{
      action_summary: string;
      notes: string[];
      restore_summary: {
        repaired: number;
        skipped_working: number;
        refused: number;
        repaired_seats: string[];
        skipped_working_seats: string[];
        refused_seats: { seat: string; reason: string }[];
        line: string;
      };
    }>(ioJson.out, UP_OUTPUT_SCHEMA);
    expect(doc.action_summary).toBe('0 seats repaired, 0 skipped (working), 0 refused');
    expect(doc.restore_summary).toEqual({
      repaired: 0,
      skipped_working: 0,
      refused: 0,
      repaired_seats: [],
      skipped_working_seats: [],
      refused_seats: [],
      line: '0 seats repaired, 0 skipped (working), 0 refused',
    });
    expect(doc.notes).toContain('orchestrator: ready');
    expect(doc.notes).toContain('operator-1: ready');
    expect(doc.notes).toContain('builder-1: ready');
    expect(doc.notes).toContain('builder-2: ready');
  });

  test('ready-confirmed repairs (singular 1 seat repaired and plural 2 seats repaired) carry --resume and expose restore_summary in JSON', async () => {
    const place = makePlace();
    // 1 seat drifted: singular grammar (`1 seat repaired`)
    const oneDrifted = healthySeeds(place.home, place.root).map((s) =>
      s.seat === 'builder-1' ? { ...s, liveScreen: OPUS_IDLE } : s,
    );
    const worldOne = buildWorld(place, oneDrifted);
    const ioOne = testIo(place.root, { kind: 'owner' });
    const exitOne = await runUp([], ioOne, worldOne.sources);
    expect(exitOne).toBe(0);
    expect(worldOne.closes).toEqual(['w3']);
    expect(worldOne.runs).toHaveLength(1);
    expect(worldOne.runs[0]?.command).toContain('--resume ses-b1');
    expect(ioOne.err).toContain('1 seat repaired, 0 skipped (working), 0 refused\n');

    // 2 seats (1 drifted on moved pane + 1 missing pane with carryable session) in `--json`: plural (`2 seats repaired`)
    const twoRepaired = healthySeeds(place.home, place.root).map((s) => {
      if (s.seat === 'builder-1') {
        return { ...s, livePane: 'w99:p1', liveWorkspace: 'w99', liveScreen: OPUS_IDLE };
      }
      if (s.seat === 'builder-2') {
        return { ...s, livePane: null };
      }
      return s;
    });
    const worldTwo = buildWorld(place, twoRepaired);
    const ioTwo = testIo(place.root, { kind: 'owner' });
    const exitTwo = await runUp(['--json'], ioTwo, worldTwo.sources);
    expect(exitTwo).toBe(0);
    const doc = assertMatchesOutputSchema<{
      action_summary: string;
      restore_summary: {
        repaired: number;
        skipped_working: number;
        refused: number;
        repaired_seats: string[];
        skipped_working_seats: string[];
        refused_seats: { seat: string; reason: string }[];
        line: string;
      };
    }>(ioTwo.out, UP_OUTPUT_SCHEMA);
    expect(doc.action_summary).toBe('2 seats repaired, 0 skipped (working), 0 refused');
    expect(doc.restore_summary).toEqual({
      repaired: 2,
      skipped_working: 0,
      refused: 0,
      repaired_seats: ['builder-1', 'builder-2'],
      skipped_working_seats: [],
      refused_seats: [],
      line: '2 seats repaired, 0 skipped (working), 0 refused',
    });
  });

  test('working skips at plan time and at pre-close re-read increment M skipped (working) and exit 0 when K === 0', async () => {
    const place = makePlace();
    const seeds = healthySeeds(place.home, place.root).map((s) => {
      if (s.seat === 'builder-1') {
        // Working at plan time
        return { ...s, liveStatus: 'working' as const, liveScreen: OPUS_WORKING };
      }
      if (s.seat === 'builder-2') {
        // Idle at plan time, flips to working at pre-close re-read
        return { ...s, liveStatus: 'idle' as const, liveScreen: OPUS_IDLE };
      }
      return s;
    });
    const world = buildWorld(place, seeds, {
      preCloseScreenOverride: { 'w4:p1': OPUS_WORKING },
    });
    const io = testIo(place.root, { kind: 'owner' });
    const exit = await runUp([], io, world.sources);
    expect(exit).toBe(0);
    expect(world.closes).toEqual([]);
    expect(world.runs).toEqual([]);
    expect(io.err).toContain('0 seats repaired, 2 skipped (working), 0 refused\n');
  });

  test('partial failure: an attempted relaunch that times out before finishReady lands in K refused, never N repaired, and exits 1', async () => {
    const place = makePlace();
    const seeds = healthySeeds(place.home, place.root).map((s) => {
      if (s.seat === 'builder-1') {
        // Relaunches and reaches ready
        return { ...s, liveScreen: OPUS_IDLE, postLaunchScreen: SONNET_IDLE };
      }
      if (s.seat === 'builder-2') {
        // Relaunches (`paneRun` executes), but post-launch pane never reaches an idle prompt
        return { ...s, liveScreen: OPUS_IDLE, postLaunchScreen: '' };
      }
      return s;
    });
    const world = buildWorld(place, seeds);
    const io = testIo(place.root, { kind: 'owner' });
    const exit = await runUp([], io, world.sources);
    expect(exit).toBe(1);
    // Both panes were closed and both launch commands were attempted:
    expect(world.closes).toEqual(['w3', 'w4']);
    expect(world.runs).toHaveLength(2);
    // Only builder-1 reached finishReady; builder-2 is counted in K refused, never N repaired:
    const match = SUMMARY_RE.exec(io.err);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(1);
    expect(Number(match?.[2])).toBe(0);
    expect(Number(match?.[3])).toBe(1);
    expect(match?.[4]).toContain('builder-2:');
    expect(readState(place.dir).sessions['acme-restore']?.seats['builder-2']?.stage).not.toBe('ready');
  });

  test('guard refusal, lead drift, and session doubt land in K refused with per-seat reasons in plain and --json error output', async () => {
    const place = makePlace();
    // Scene A: lead model drift (`orchestrator`) + moved pane with mismatched session (`builder-2`)
    const seeds = healthySeeds(place.home, place.root).map((s) => {
      if (s.seat === 'orchestrator') return { ...s, liveScreen: SONNET_IDLE };
      if (s.seat === 'builder-2') {
        return { ...s, livePane: 'w88:p1', liveWorkspace: 'w88', liveAgentSession: 'ses-stranger' };
      }
      return s;
    });
    const worldPlain = buildWorld(place, seeds);
    const ioPlain = testIo(place.root, { kind: 'owner' });
    const exitPlain = await runUp([], ioPlain, worldPlain.sources);
    expect(exitPlain).toBe(1);
    expect(worldPlain.closes).toEqual([]);
    expect(worldPlain.runs).toEqual([]);
    const matchPlain = SUMMARY_RE.exec(ioPlain.err);
    expect(matchPlain).not.toBeNull();
    expect(Number(matchPlain?.[1])).toBe(0);
    expect(Number(matchPlain?.[2])).toBe(0);
    expect(Number(matchPlain?.[3])).toBe(2);
    expect(matchPlain?.[4]).toContain('orchestrator:');
    expect(matchPlain?.[4]).toContain('builder-2:');

    // Scene B: `--json` refusal when machine memory/load guard blocks repair inside executePlan (`host.allow`)
    const guardSeeds = healthySeeds(place.home, place.root).map((s) =>
      s.seat === 'builder-1' ? { ...s, liveScreen: OPUS_IDLE } : s,
    );
    let machineReads = 0;
    const worldJson = buildWorld(place, guardSeeds, {
      machine: () => {
        machineReads += 1;
        return machineReads === 1 ? AMPLE_MACHINE : TIGHT_MACHINE;
      },
    });
    const ioJson = testIo(place.root, { kind: 'owner' });
    const exitJson = await runUp(['--json'], ioJson, worldJson.sources);
    expect(exitJson).toBe(1);
    expect(ioJson.err).toBe('');
    const errDoc = assertJsonErrorShape(ioJson.out, {
      id: 'up.pending',
      messageContains: '0 seats repaired, 0 skipped (working), 1 refused (builder-1:',
      repair: null,
    });
    expect(errDoc.error.message).toContain('builder-1:');
  });
});
