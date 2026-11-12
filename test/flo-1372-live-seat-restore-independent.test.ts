import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runApprove } from '../src/approve/command.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { Launch, UpSources } from '../src/commands/up.ts';
import {
  agentList,
  beginHerdrSnapshot,
  endHerdrSnapshot,
  paneProcesses,
  setHerdrRun,
  workspaceList,
  type HerdrAgent,
  type HerdrWorkspace,
  type PaneProcesses,
} from '../src/herdr.ts';
import { runRestoreSweepForRoute } from '../src/launch/restore-sweep.ts';
import { conversationOnDisk } from '../src/profiles/profile.ts';
import { getAgent } from '../src/registry/agents.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { getTeam, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Machine } from '../src/watch/machine.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-21T15:00:00Z');
const AMPLE: Machine = {
  loadPerCore: 0.3,
  memoryFree: 60,
  diskFree: 200e9,
  swapTotal: 10e9,
  swapFree: 9e9,
  swapUsed: 1e9,
};
const CONV_ONE = '11111111-2222-4333-8444-555555555555';
const CONV_THREE = '33333333-2222-4333-8444-555555555555';

const bases: string[] = [];
let base: string;
let root: string;
let home: string;
let stateDir: string;
let teamFile: string;

function teamYaml(options: {
  seats?: {
    name: string;
    launch?: string;
    model?: string;
    version?: string;
  }[];
} = {}): string {
  const list = options.seats ?? [{ name: 'seat-1' }];
  const coordinator = list[0]?.name ?? 'seat-1';
  const rows = list
    .map(
      (seat) => `  - role: implementer
    name: ${seat.name}
    cli: claude-code
    vendor: anthropic
    model: ${seat.model ?? 'Claude Opus'}
    version: "${seat.version ?? '5.5'}"
    launch: ${seat.launch ?? 'claude'}`,
    )
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
  base = fixtureBase('flo-1372-independent-');
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
  discardFixtures(bases.splice(0), { roots: [ join(base, '..') ] });
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

function doctor(): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
  };
}

function recordSessionSeats(
  seats: Record<string, Record<string, unknown>>,
  briefs?: Record<string, Record<string, unknown>>,
): {
  statePath: string;
  stateBefore: string;
  seatsBefore: string;
} {
  const statePath = join(stateDir, 'team.state.json');
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        format: 1,
        sessions: {
          sweep: {
            seats,
            worktrees: {},
            ...(briefs === undefined ? {} : { briefs }),
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const stateBefore = readFileSync(statePath, 'utf8');
  const seatsBefore = JSON.stringify(
    (JSON.parse(stateBefore) as { sessions: { sweep: { seats: unknown } } }).sessions.sweep.seats,
  );
  return { statePath, stateBefore, seatsBefore };
}

type WorldSeat = {
  pane: string;
  workspace: string;
  inWorkspaceList: boolean;
  inPaneList: boolean;
  paneListUnread?: boolean;
  inAgentList: boolean;
  agentStatus?: 'idle' | 'working';
  process: PaneProcesses | null;
  screen?: string;
  /** The host restored the pane but dropped its name (a host restart): listed with no name. */
  unnamed?: boolean;
  /** The conversation the host reports for the pane's agent. */
  session?: string;
};

type Harness = {
  seats: Map<string, WorldSeat>;
  workspacesUnread: boolean;
  agentsUnread: boolean;
  extraAgents: HerdrAgent[];
  creates: string[];
  runs: { pane: string; command: string }[];
  closes: string[];
  renames: { pane: string; name: string }[];
  conversationChecks: { cli: string; cwd: string; id: string; command?: string }[];
  conversationAnswer: boolean | null;
  launch: Launch;
  sources(extra?: Partial<UpSources>): UpSources;
};

function makeHarness(initialSeats: Record<string, WorldSeat>): Harness {
  const seats = new Map<string, WorldSeat>(Object.entries(initialSeats));
  const createdWorkspaces = new Map<string, { pane: string; label: string; named: string | null }>();
  let freshCount = 0;
  let clock = NOW.getTime();

  const harness: Harness = {
    seats,
    workspacesUnread: false,
    agentsUnread: false,
    extraAgents: [],
    creates: [],
    runs: [],
    closes: [],
    renames: [],
    conversationChecks: [],
    conversationAnswer: null,
    launch: {} as Launch,
    sources(extra: Partial<UpSources> = {}): UpSources {
      return {
        sessionRunning: () => true,
        sessionState: () => 'running',
        agents: () => harness.launch.agents('sweep'),
        workspaces: () => {
          if (harness.workspacesUnread) return null;
          const out: HerdrWorkspace[] = [];
          for (const [name, item] of seats) {
            if (item.inWorkspaceList) out.push({ id: item.workspace, label: name });
          }
          for (const [id, item] of createdWorkspaces) {
            out.push({ id, label: item.label });
          }
          return out;
        },
        home,
        now: harness.launch.now,
        sleep: harness.launch.sleep,
        launch: harness.launch,
        doctor: doctor(),
        machine: () => AMPLE,
        ...extra,
      };
    },
  };

  harness.launch = {
    conversationExists(cli, cwd, id, command) {
      harness.conversationChecks.push({ cli, cwd, id, ...(command === undefined ? {} : { command }) });
      if (harness.conversationAnswer !== null) return harness.conversationAnswer;
      return conversationOnDisk(cli, cwd, id, { ...process.env, CLAUDE_CONFIG_DIR: join(home, '.claude-empty') }, command);
    },
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      freshCount += 1;
      const workspace = `ws-fresh-${freshCount}`;
      const pane = `pane-fresh-${freshCount}`;
      createdWorkspaces.set(workspace, { pane, label, named: null });
      harness.creates.push(label);
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
      for (const item of seats.values()) {
        if (item.inAgentList) listed.push(item.pane);
      }
      for (const created of createdWorkspaces.values()) {
        listed.push(created.pane);
      }
      return listed;
    },
    agents(): HerdrAgent[] | null {
      if (harness.agentsUnread) return null;
      const list: HerdrAgent[] = [...harness.extraAgents];
      for (const [name, item] of seats) {
        if (item.inAgentList) {
          list.push({
            name: item.unnamed === true ? null : name,
            agent: 'claude',
            pane: item.pane,
            workspace: item.workspace,
            status: item.agentStatus ?? 'idle',
            cwd: null,
            ...(item.session === undefined ? {} : { session: item.session }),
          });
        }
      }
      for (const [workspace, created] of createdWorkspaces) {
        list.push({
          name: created.named,
          agent: 'claude',
          pane: created.pane,
          workspace,
          status: 'idle',
          cwd: null,
        });
      }
      return list;
    },
    workspacePanes(_session, workspace) {
      for (const item of seats.values()) {
        if (item.workspace === workspace) {
          if (item.paneListUnread) return null;
          return item.inPaneList ? [item.pane] : [];
        }
      }
      const created = createdWorkspaces.get(workspace);
      if (created) return [created.pane];
      return [];
    },
    paneText(_session, pane) {
      for (const item of seats.values()) {
        if (item.pane === pane && item.screen !== undefined) return item.screen;
      }
      return CLAUDE_IDLE;
    },
    foreground: () => ['claude'],
    processInfo(_session, pane): PaneProcesses | null {
      for (const item of seats.values()) {
        if (item.pane === pane) return item.process;
      }
      for (const created of createdWorkspaces.values()) {
        if (created.pane === pane) return { shell: 900, foreground: [900, 901] };
      }
      if (harness.extraAgents.some((agent) => agent.pane === pane)) {
        return { shell: 800, foreground: [800, 801] };
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

describe('independent restore sweep and conversation-store boundaries', () => {
  test('scene 1 (incident reproduction): a recorded pane present in the workspace pane list is never replaced or rebound when omitted from the agent list, null in processInfo, or actively working with changed PIDs', async () => {
    writeFileSync(
      teamFile,
      teamYaml({
        seats: [
          { name: 'seat-1', launch: 'claude-glm', model: 'Claude Opus', version: '5.5' },
          { name: 'seat-2', launch: 'claude-glm', model: 'Claude Opus', version: '5.5' },
          { name: 'seat-3', launch: 'claude-glm', model: 'Claude Opus', version: '5.5' },
        ],
      }),
    );
    const { statePath, stateBefore } = recordSessionSeats({
      'seat-1': {
        stage: 'ready',
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        launched: { shell: 500, cli: [501] },
        launch_line: `claude-glm --resume ${CONV_ONE}`,
        agent_session: CONV_ONE,
        model: 'Claude Sonnet',
        version: '4.6',
        channel: true,
        endpoint: 'http://127.0.0.1:41999/v1',
      },
      'seat-2': {
        stage: 'ready',
        pane: 'pane-seat-2',
        workspace: 'ws-seat-2',
        launched: { shell: 510, cli: [511] },
      },
      'seat-3': {
        stage: 'ready',
        pane: 'pane-seat-3',
        workspace: 'ws-seat-3',
        launched: { shell: 520, cli: [521] },
        agent_session: CONV_THREE,
      },
    });
    await approve();

    // seat-1: omitted from agent list, null processInfo, present in workspacePanes.
    // seat-2: actively working with changed shell and CLI PIDs.
    // seat-3: present in workspacePanes with null processInfo while agent list names seat-3 on another pane.
    const harness = makeHarness({
      'seat-1': {
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        inWorkspaceList: true,
        inPaneList: true,
        inAgentList: false,
        process: null,
      },
      'seat-2': {
        pane: 'pane-seat-2',
        workspace: 'ws-seat-2',
        inWorkspaceList: true,
        inPaneList: true,
        inAgentList: true,
        agentStatus: 'working',
        process: { shell: 610, foreground: [610, 611] },
      },
      'seat-3': {
        pane: 'pane-seat-3',
        workspace: 'ws-seat-3',
        inWorkspaceList: true,
        inPaneList: true,
        inAgentList: false,
        process: null,
      },
    });
    harness.extraAgents.push({
      name: 'seat-3',
      agent: 'claude',
      pane: 'pane-stray-9',
      workspace: 'ws-stray-9',
      status: 'idle',
      cwd: null,
      session: CONV_THREE,
    });

    const result = await runRestoreSweepForRoute({
      home,
      root,
      teamFile,
      sources: harness.sources(),
    });
    expect(result.kind).toBe('ran');
    if (result.kind !== 'ran') return;

    // Certain keeps (present) produce no restore bucket entry at all.
    expect(result.failed).toBe(false);
    expect(result.summary.repaired_seats).toEqual([]);
    expect(result.summary.skipped_working_seats).toEqual([]);
    expect(result.summary.refused_seats).toEqual([]);
    expect(harness.creates).toEqual([]);
    expect(harness.runs).toEqual([]);
    expect(harness.closes).toEqual([]);
    expect(harness.renames).toEqual([]);
    // Kept records are byte-for-byte unchanged on disk.
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
  });

  test('scene 2 (drift protection and behind brief claim): an idle live recorded pane with launcher, model, channel, and endpoint drift and a behind brief claim is kept untouched with byte-identical state and no drop written', async () => {
    writeFileSync(
      teamFile,
      teamYaml({
        seats: [{ name: 'seat-1', launch: 'claude --model claude-opus-5-5', model: 'Claude Opus', version: '5.5' }],
      }),
    );
    const { statePath, stateBefore } = recordSessionSeats(
      {
        'seat-1': {
          stage: 'ready',
          pane: 'pane-seat-1',
          workspace: 'ws-seat-1',
          launched: { shell: 500, cli: [501] },
          launch_line: 'claude --model claude-haiku-4-5',
          model: 'Claude Haiku',
          version: '4.5',
          channel: true,
          endpoint: 'http://127.0.0.1:42999/v1',
        },
      },
      {
        'seat-1': {
          id: '11111111-1111-4111-8111-111111111111',
          at: '2026-10-20T09:00:00.000Z',
          incarnation: 'inc_000000000001',
          epoch: 'run_000000000001',
          sha256: '0'.repeat(64),
          attempt: 0,
          stage: 'ready',
          pane: 'pane-seat-1',
          pane_root_pid: 500,
        },
      },
    );
    await approve();

    const harness = makeHarness({
      'seat-1': {
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        inWorkspaceList: true,
        inPaneList: true,
        inAgentList: true,
        agentStatus: 'idle',
        process: { shell: 700, foreground: [701] },
        screen: CLAUDE_IDLE.replace('Opus 5.5 · Acme billing', 'deepseek-v3 · API Usage Billing'),
      },
    });

    const result = await runRestoreSweepForRoute({
      home,
      root,
      teamFile,
      sources: harness.sources(),
    });
    expect(result.kind).toBe('ran');
    if (result.kind !== 'ran') return;
    expect(result.failed).toBe(false);
    expect(result.summary.repaired_seats).toEqual([]);
    expect(result.summary.skipped_working_seats).toEqual([]);
    expect(result.summary.refused_seats).toEqual([]);
    expect(harness.creates).toEqual([]);
    expect(harness.runs).toEqual([]);
    expect(harness.closes).toEqual([]);
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
    expect(existsSync(join(stateDir, 'send-drops', 'sweep', 'seat-1'))).toBe(false);
  });

  test('scene 3 (unread, malformed, and contradictory inventories): malformed host payloads parse as null and unread or contradictory readings hold in refused_seats without mutating state', async () => {
    // 3a: Malformed terminal-host replies must return null (unread), never an empty array.
    setHerdrRun(() => ({}));
    expect(workspaceList('sweep')).toBeNull();
    expect(agentList('sweep')).toBeNull();

    setHerdrRun(() => ({ workspaces: 'malformed', agents: 'malformed' }));
    expect(workspaceList('sweep')).toBeNull();
    expect(agentList('sweep')).toBeNull();

    setHerdrRun(() => ({
      workspaces: [{ workspace_id: '', label: 'seat-1' }],
      agents: [{ pane_id: 'pane-seat-1', workspace_id: '' }],
    }));
    expect(workspaceList('sweep')).toBeNull();
    expect(agentList('sweep')).toBeNull();
    setHerdrRun(null);

    // 3b: Sweep holds when inventory is unread or contradicts a live process or agent reading,
    // placing the uncertain seat in refused_seats and leaving team.state.json byte-identical.
    const { statePath, stateBefore } = recordSessionSeats({
      'seat-1': {
        stage: 'ready',
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        launched: { shell: 500, cli: [501] },
      },
    });
    await approve();

    // Contradiction 1: workspace and pane lists claim pane-seat-1 is gone, but processInfo is live.
    const conflicting = makeHarness({
      'seat-1': {
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        inWorkspaceList: false,
        inPaneList: false,
        inAgentList: false,
        process: { shell: 500, foreground: [500, 501] },
      },
    });
    const conflictResult = await runRestoreSweepForRoute({
      home,
      root,
      teamFile,
      sources: conflicting.sources(),
    });
    expect(conflictResult.kind).toBe('ran');
    if (conflictResult.kind !== 'ran') return;
    expect(conflictResult.failed).toBe(true);
    expect(conflictResult.summary.repaired_seats).toEqual([]);
    expect(conflictResult.summary.skipped_working_seats).toEqual([]);
    expect(conflictResult.summary.refused_seats).toEqual([
      { seat: 'seat-1', reason: 'restore cannot prove the recorded pane is gone; left untouched' },
    ]);
    expect(conflicting.creates).toEqual([]);
    expect(conflicting.runs).toEqual([]);
    expect(conflicting.closes).toEqual([]);
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);

    // Contradiction 2: workspace exists and pane list omits pane-seat-1, but agent list still names pane-seat-1.
    const agentConflict = makeHarness({
      'seat-1': {
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        inWorkspaceList: true,
        inPaneList: false,
        inAgentList: true,
        process: null,
      },
    });
    const agentConflictResult = await runRestoreSweepForRoute({
      home,
      root,
      teamFile,
      sources: agentConflict.sources(),
    });
    expect(agentConflictResult.kind).toBe('ran');
    if (agentConflictResult.kind !== 'ran') return;
    expect(agentConflictResult.failed).toBe(true);
    expect(agentConflictResult.summary.refused_seats).toEqual([
      { seat: 'seat-1', reason: 'restore cannot prove the recorded pane is gone; left untouched' },
    ]);
    expect(agentConflict.creates).toEqual([]);
    expect(agentConflict.runs).toEqual([]);
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);

    // Unread pane list: workspace exists, agent and process reads are empty/null, pane list is null.
    const unreadPanes = makeHarness({
      'seat-1': {
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        inWorkspaceList: true,
        inPaneList: false,
        paneListUnread: true,
        inAgentList: false,
        process: null,
      },
    });
    const unreadResult = await runRestoreSweepForRoute({
      home,
      root,
      teamFile,
      sources: unreadPanes.sources(),
    });
    expect(unreadResult.kind).toBe('ran');
    if (unreadResult.kind !== 'ran') return;
    expect(unreadResult.failed).toBe(true);
    expect(unreadResult.summary.refused_seats).toEqual([
      { seat: 'seat-1', reason: 'restore cannot prove the recorded pane is gone; left untouched' },
    ]);
    expect(unreadPanes.creates).toEqual([]);
    expect(unreadPanes.runs).toEqual([]);
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
  });

  test('scene 4 (wrapper vs direct conversation store): wrapper launches return null and preserve --resume, whereas direct claude launches fall back to fresh when the store file is absent', async () => {
    const emptyConfig = join(base, 'claude-config-empty');
    mkdirSync(emptyConfig, { recursive: true });
    const env = { ...process.env, CLAUDE_CONFIG_DIR: emptyConfig };

    // Direct CLI vs built AGENT_UNATTENDED=1 marker vs quoted marker vs custom env vs wrapper store read.
    expect(conversationOnDisk('claude-code', root, CONV_ONE, env, `claude --resume '${CONV_ONE}'`)).toBe(false);
    expect(conversationOnDisk('claude-code', root, CONV_ONE, env, `/usr/local/bin/claude --resume '${CONV_ONE}'`)).toBe(
      false,
    );
    expect(
      conversationOnDisk('claude-code', root, CONV_ONE, env, `AGENT_UNATTENDED=1 claude --resume '${CONV_ONE}'`),
    ).toBe(false);
    expect(
      conversationOnDisk(
        'claude-code',
        root,
        CONV_ONE,
        env,
        `AGENT_UNATTENDED=1 /usr/local/bin/claude --resume '${CONV_ONE}'`,
      ),
    ).toBe(false);
    // Quoted marker, bare marker, custom env assignments, and wrapper programs remain unmeasured (null).
    expect(
      conversationOnDisk('claude-code', root, CONV_ONE, env, `'AGENT_UNATTENDED=1' claude --resume '${CONV_ONE}'`),
    ).toBeNull();
    expect(
      conversationOnDisk('claude-code', root, CONV_ONE, env, `"AGENT_UNATTENDED=1" claude --resume '${CONV_ONE}'`),
    ).toBeNull();
    expect(conversationOnDisk('claude-code', root, CONV_ONE, env, 'AGENT_UNATTENDED=1')).toBeNull();
    expect(
      conversationOnDisk('claude-code', root, CONV_ONE, env, `CUSTOM_ENV=1 claude --resume '${CONV_ONE}'`),
    ).toBeNull();
    expect(
      conversationOnDisk(
        'claude-code',
        root,
        CONV_ONE,
        env,
        `AGENT_UNATTENDED=1 CUSTOM_ENV=1 claude --resume '${CONV_ONE}'`,
      ),
    ).toBeNull();
    expect(conversationOnDisk('claude-code', root, CONV_ONE, env, `claude-glm --resume '${CONV_ONE}'`)).toBeNull();
    expect(
      conversationOnDisk('claude-code', root, CONV_ONE, env, `AGENT_UNATTENDED=1 claude-glm --resume '${CONV_ONE}'`),
    ).toBeNull();
    expect(
      conversationOnDisk('claude-code', root, CONV_ONE, env, `/opt/wrappers/claude-glm --resume '${CONV_ONE}'`),
    ).toBeNull();

    const projectDir = join(emptyConfig, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${CONV_ONE}.jsonl`), '{"type":"user"}\n');
    expect(conversationOnDisk('claude-code', root, CONV_ONE, env, `claude --resume '${CONV_ONE}'`)).toBe(true);
    expect(
      conversationOnDisk('claude-code', root, CONV_ONE, env, `AGENT_UNATTENDED=1 claude --resume '${CONV_ONE}'`),
    ).toBe(true);

    // End-to-end restore of a genuinely absent pane for a wrapper seat vs a direct claude seat
    // when conversationExists returns false (e.g., unknown wrapper store).
    writeFileSync(
      teamFile,
      teamYaml({
        seats: [
          { name: 'seat-1', launch: 'claude-glm' },
          { name: 'seat-2', launch: 'claude' },
        ],
      }),
    );
    const statePath = join(stateDir, 'team.state.json');
    writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          format: 1,
          sessions: {
            sweep: {
              seats: {
                'seat-1': {
                  stage: 'ready',
                  pane: 'pane-seat-1',
                  workspace: 'ws-seat-1',
                  launched: { shell: 500, cli: [501] },
                  agent_session: CONV_ONE,
                },
                'seat-2': {
                  stage: 'ready',
                  pane: 'pane-seat-2',
                  workspace: 'ws-seat-2',
                  launched: { shell: 510, cli: [511] },
                  agent_session: CONV_THREE,
                },
              },
              worktrees: {},
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await approve();

    const harness = makeHarness({
      'seat-1': {
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        inWorkspaceList: false,
        inPaneList: false,
        inAgentList: false,
        process: null,
      },
      'seat-2': {
        pane: 'pane-seat-2',
        workspace: 'ws-seat-2',
        inWorkspaceList: false,
        inPaneList: false,
        inAgentList: false,
        process: null,
      },
    });
    harness.conversationAnswer = false;

    const result = await runRestoreSweepForRoute({
      home,
      root,
      teamFile,
      sources: harness.sources(),
    });
    expect(result.kind).toBe('ran');
    if (result.kind !== 'ran') return;
    expect(result.failed).toBe(false);
    expect(result.summary.repaired_seats).toEqual(['seat-1', 'seat-2']);

    const wrapperRun = harness.runs.find((entry) => entry.command.includes('claude-glm'));
    const directRun = harness.runs.find(
      (entry) => !entry.command.includes('claude-glm') && entry.command.includes('claude'),
    );
    expect(wrapperRun?.command).toContain(`--resume ${CONV_ONE}`);
    expect(directRun?.command).not.toContain('--resume');
    expect(directRun?.command).toContain('--session-id');
  });

  test('scene 5 (cached conflict read eviction and reappearance race): a cached null process read is evicted for fresh live conflict checks, and a pane that reappears before mutation aborts launch and record writes', async () => {
    const { statePath, stateBefore } = recordSessionSeats({
      'seat-1': {
        stage: 'ready',
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        launched: { shell: 500, cli: [501] },
      },
    });
    await approve();

    // 5a: Cached null processInfo and empty agentList inside an active herdr snapshot must be
    // evicted by restoreKeepOf so a newly live process reading stops the restore.
    let hostProcessLive = false;
    setHerdrRun((args) => {
      if (args.includes('agent') && args.includes('list')) {
        return { agents: [] };
      }
      if (args.includes('pane') && args.includes('process-info')) {
        if (!hostProcessLive) return null;
        return {
          process_info: {
            pane_id: 'pane-seat-1',
            shell_pid: 500,
            foreground_processes: [{ pid: 501, argv0: 'claude', name: 'claude' }],
          },
        };
      }
      return null;
    });

    const snap = beginHerdrSnapshot();
    try {
      // Prime the snapshot cache with empty agents and null process-info.
      expect(agentList('sweep')).toEqual([]);
      expect(paneProcesses('pane-seat-1', 'sweep')).toBeNull();
      // Now the pane's process becomes readable on the host.
      hostProcessLive = true;

      const cachedHarness = makeHarness({
        'seat-1': {
          pane: 'pane-seat-1',
          workspace: 'ws-seat-1',
          inWorkspaceList: false,
          inPaneList: false,
          inAgentList: false,
          process: null,
        },
      });
      cachedHarness.launch.agents = (session) => agentList(session);
      cachedHarness.launch.processInfo = (session, pane) => paneProcesses(pane, session);

      const cachedResult = await runRestoreSweepForRoute({
        home,
        root,
        teamFile,
        sources: cachedHarness.sources(),
      });
      expect(cachedResult.kind).toBe('ran');
      if (cachedResult.kind !== 'ran') return;
      expect(cachedResult.failed).toBe(true);
      expect(cachedResult.summary.refused_seats).toEqual([
        { seat: 'seat-1', reason: 'restore cannot prove the recorded pane is gone; left untouched' },
      ]);
      expect(cachedHarness.creates).toEqual([]);
      expect(cachedHarness.runs).toEqual([]);
      expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
    } finally {
      endHerdrSnapshot(snap);
      setHerdrRun(null);
    }

    // 5b: Reappearance race — recorded pane is genuinely absent during initial planning, then
    // reappears in workspacePanes on the lock recheck (before setup/briefs) and in a second pass
    // right before executePlan creates a workspace.
    let lockRecheckCalls = 0;
    const lockRaceHarness = makeHarness({
      'seat-1': {
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        inWorkspaceList: true,
        inPaneList: false,
        inAgentList: false,
        process: null,
      },
    });
    const baseLockPanes = lockRaceHarness.launch.workspacePanes!;
    lockRaceHarness.launch.workspacePanes = (session, workspace) => {
      lockRecheckCalls += 1;
      if (lockRecheckCalls >= 2) {
        lockRaceHarness.seats.get('seat-1')!.inPaneList = true;
      }
      return baseLockPanes(session, workspace);
    };

    const lockRaceResult = await runRestoreSweepForRoute({
      home,
      root,
      teamFile,
      sources: lockRaceHarness.sources(),
    });
    expect(lockRaceResult.kind).toBe('ran');
    if (lockRaceResult.kind !== 'ran') return;
    expect(lockRaceResult.failed).toBe(false);
    expect(lockRaceResult.summary.repaired_seats).toEqual([]);
    expect(lockRaceResult.summary.refused_seats).toEqual([]);
    expect(lockRaceHarness.creates).toEqual([]);
    expect(lockRaceHarness.runs).toEqual([]);
    expect(lockRaceHarness.closes).toEqual([]);
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);

    let execRecheckCalls = 0;
    const raceHarness = makeHarness({
      'seat-1': {
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        inWorkspaceList: true,
        inPaneList: false,
        inAgentList: false,
        process: null,
      },
    });
    const baseWorkspacePanes = raceHarness.launch.workspacePanes!;
    raceHarness.launch.workspacePanes = (session, workspace) => {
      execRecheckCalls += 1;
      // Check 1 is seatPlan; Check 2 is the pre-buildPlan lock recheck; on Check 3 (guardRestore
      // inside executePlan before workspace creation) the recorded pane reappears.
      if (execRecheckCalls >= 3) {
        raceHarness.seats.get('seat-1')!.inPaneList = true;
      }
      return baseWorkspacePanes(session, workspace);
    };

    const raceResult = await runRestoreSweepForRoute({
      home,
      root,
      teamFile,
      sources: raceHarness.sources(),
    });
    expect(raceResult.kind).toBe('ran');
    if (raceResult.kind !== 'ran') return;
    expect(raceResult.failed).toBe(true);
    expect(raceResult.summary.repaired_seats).toEqual([]);
    expect(raceResult.summary.refused_seats).toEqual([
      { seat: 'seat-1', reason: 'restore left the recorded pane untouched; it is still present' },
    ]);
    expect(raceHarness.creates).toEqual([]);
    expect(raceHarness.runs).toEqual([]);
    expect(raceHarness.closes).toEqual([]);
    expect(
      JSON.stringify(
        (JSON.parse(readFileSync(statePath, 'utf8')) as { sessions: { sweep: { seats: unknown } } }).sessions.sweep
          .seats,
      ),
    ).toBe(
      JSON.stringify(
        (JSON.parse(stateBefore) as { sessions: { sweep: { seats: unknown } } }).sessions.sweep.seats,
      ),
    );
  });

  test('scene 6 (registry lifecycle and mixed pass): an all-protected sweep preserves team running lifecycle, and a mixed pass restores only the proven-absent recorded pane while refusing unread and unrecorded seats', async () => {
    // 6a: All-protected registry-backed team (one present seat, one unread seat) must keep
    // team lifecycle: 'running' even though registerRun receives zero running seats from the filtered list.
    const twoSeatYaml = teamYaml({
      seats: [{ name: 'seat-1' }, { name: 'seat-2' }],
    });
    writeFileSync(teamFile, twoSeatYaml);
    const parsedTwo = validateTeamFile(twoSeatYaml, { home, root });
    expect(parsedTwo.ok).toBe(true);
    if (!parsedTwo.ok) return;

    const regInput = { home, team: parsedTwo.team, root, by: 'owner' as const };
    const regOne = registerLaunch(regInput, parsedTwo.team.seats[0]!, 'pane-seat-1');
    const regTwo = registerLaunch(regInput, parsedTwo.team.seats[1]!, 'pane-seat-2');
    expect('id' in regOne && 'id' in regTwo).toBe(true);
    const idOne = (regOne as { id: string }).id;
    const idTwo = (regTwo as { id: string }).id;
    const teamId = teamIdOf(root);
    expect(getTeam(home, teamId)?.lifecycle).toBe('running');

    const { statePath, stateBefore: stateBeforeAllProtected } = recordSessionSeats({
      'seat-1': {
        stage: 'ready',
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        launched: { shell: 500, cli: [501] },
      },
      'seat-2': {
        stage: 'ready',
        pane: 'pane-seat-2',
        workspace: 'ws-seat-2',
        launched: { shell: 510, cli: [511] },
      },
    });
    await approve();

    const allProtected = makeHarness({
      'seat-1': {
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        inWorkspaceList: true,
        inPaneList: true,
        inAgentList: true,
        process: { shell: 500, foreground: [500, 501] },
      },
      'seat-2': {
        pane: 'pane-seat-2',
        workspace: 'ws-seat-2',
        inWorkspaceList: true,
        inPaneList: false,
        paneListUnread: true,
        inAgentList: false,
        process: null,
      },
    });

    const protectedResult = await runRestoreSweepForRoute({
      home,
      root,
      teamFile,
      sources: allProtected.sources(),
    });
    expect(protectedResult.kind).toBe('ran');
    if (protectedResult.kind !== 'ran') return;
    expect(protectedResult.failed).toBe(true);
    expect(protectedResult.summary.repaired_seats).toEqual([]);
    expect(protectedResult.summary.refused_seats).toEqual([
      { seat: 'seat-2', reason: 'restore cannot prove the recorded pane is gone; left untouched' },
    ]);
    expect(getTeam(home, teamId)?.lifecycle).toBe('running');
    expect(getAgent(home, idOne)?.reach.pane).toBe('pane-seat-1');
    expect(getAgent(home, idOne)?.lifecycle).toBe('running');
    expect(getAgent(home, idTwo)?.reach.pane).toBe('pane-seat-2');
    expect(getAgent(home, idTwo)?.lifecycle).toBe('running');
    expect(readFileSync(statePath, 'utf8')).toBe(stateBeforeAllProtected);

    // 6b: Mixed pass with 4 declared seats:
    // - seat-1: present on pane-seat-1 -> untouched, no bucket entry
    // - seat-2: unread pane inventory on ws-seat-2 -> untouched, refused_seats entry
    // - seat-3: genuinely absent (ws-seat-3 absent from workspaces(), no agent/process) -> restored into pane-fresh-1
    // - seat-4: unrecorded in team.state.json -> never cold-started, refused_seats entry
    const fourSeatYaml = teamYaml({
      seats: [{ name: 'seat-1' }, { name: 'seat-2' }, { name: 'seat-3' }, { name: 'seat-4' }],
    });
    writeFileSync(teamFile, fourSeatYaml);
    const parsedFour = validateTeamFile(fourSeatYaml, { home, root });
    expect(parsedFour.ok).toBe(true);
    if (!parsedFour.ok) return;
    const regThree = registerLaunch(
      { home, team: parsedFour.team, root, by: 'owner' },
      parsedFour.team.seats[2]!,
      'pane-seat-3',
    );
    expect('id' in regThree).toBe(true);
    const idThree = (regThree as { id: string }).id;
    upsertTeam(home, teamId, { lifecycle: 'running' });

    writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          format: 1,
          sessions: {
            sweep: {
              seats: {
                'seat-1': {
                  stage: 'ready',
                  pane: 'pane-seat-1',
                  workspace: 'ws-seat-1',
                  launched: { shell: 500, cli: [501] },
                },
                'seat-2': {
                  stage: 'ready',
                  pane: 'pane-seat-2',
                  workspace: 'ws-seat-2',
                  launched: { shell: 510, cli: [511] },
                },
                'seat-3': {
                  stage: 'ready',
                  pane: 'pane-seat-3',
                  workspace: 'ws-seat-3',
                  launched: { shell: 520, cli: [521] },
                  agent_session: CONV_THREE,
                },
              },
              worktrees: {},
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await approve();

    const mixed = makeHarness({
      'seat-1': {
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        inWorkspaceList: true,
        inPaneList: true,
        inAgentList: true,
        process: { shell: 500, foreground: [500, 501] },
      },
      'seat-2': {
        pane: 'pane-seat-2',
        workspace: 'ws-seat-2',
        inWorkspaceList: true,
        inPaneList: false,
        paneListUnread: true,
        inAgentList: false,
        process: null,
      },
      'seat-3': {
        pane: 'pane-seat-3',
        workspace: 'ws-seat-3',
        inWorkspaceList: false,
        inPaneList: false,
        inAgentList: false,
        process: null,
      },
    });

    const mixedResult = await runRestoreSweepForRoute({
      home,
      root,
      teamFile,
      sources: mixed.sources(),
    });
    expect(mixedResult.kind).toBe('ran');
    if (mixedResult.kind !== 'ran') return;
    expect(mixedResult.failed).toBe(true);
    expect(mixedResult.summary.repaired_seats).toEqual(['seat-3']);
    expect(mixedResult.summary.skipped_working_seats).toEqual([]);
    expect(mixedResult.summary.refused_seats).toEqual([
      { seat: 'seat-2', reason: 'restore cannot prove the recorded pane is gone; left untouched' },
      { seat: 'seat-4', reason: 'restore cannot prove the recorded pane is gone; left untouched' },
    ]);

    // Only seat-3 was created and launched; unrecorded seat-4 was not cold-started.
    expect(mixed.creates).toEqual(['seat-3 · implementer']);
    expect(mixed.closes).toEqual([]);
    expect(getTeam(home, teamId)?.lifecycle).toBe('running');
    expect(getAgent(home, idOne)?.reach.pane).toBe('pane-seat-1');
    expect(getAgent(home, idTwo)?.reach.pane).toBe('pane-seat-2');
    expect(getAgent(home, idThree)?.reach.pane).toBe('pane-fresh-1');

    const afterSeats = (
      JSON.parse(readFileSync(statePath, 'utf8')) as {
        sessions: { sweep: { seats: Record<string, { pane?: string; workspace?: string; stage?: string }> } };
      }
    ).sessions.sweep.seats;
    expect(afterSeats['seat-1']?.pane).toBe('pane-seat-1');
    expect(afterSeats['seat-2']?.pane).toBe('pane-seat-2');
    expect(afterSeats['seat-3']?.pane).toBe('pane-fresh-1');
    expect(afterSeats['seat-3']?.workspace).toBe('ws-fresh-1');
    expect(afterSeats['seat-3']?.stage).toBe('ready');
    expect(afterSeats['seat-4']).toBeUndefined();
  });

  test('scene 7 (host restart): a recorded pane the host restored with its name dropped is renamed back to its seat, and nothing is launched, typed or closed', async () => {
    writeFileSync(teamFile, teamYaml({ seats: [{ name: 'seat-1' }] }));
    recordSessionSeats({
      'seat-1': {
        stage: 'ready',
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        launched: { shell: 500, cli: [501] },
        agent_session: CONV_ONE,
      },
    });
    await approve();

    // The restart kept the pane and its conversation, gave it new processes, and dropped its name.
    const harness = makeHarness({
      'seat-1': {
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        inWorkspaceList: true,
        inPaneList: true,
        inAgentList: true,
        unnamed: true,
        session: CONV_ONE,
        process: { shell: 700, foreground: [701] },
      },
    });
    harness.conversationAnswer = true;

    const result = await runRestoreSweepForRoute({ home, root, teamFile, sources: harness.sources() });
    expect(result.kind).toBe('ran');
    if (result.kind !== 'ran') return;
    expect(harness.renames).toEqual([{ pane: 'pane-seat-1', name: 'seat-1' }]);
    expect(harness.creates).toEqual([]);
    expect(harness.runs).toEqual([]);
    expect(harness.closes).toEqual([]);
    expect(result.summary.refused_seats).toEqual([]);
  });

  test('scene 8 (host restart, bare shell): a recorded pane the host restored at its own bare shell gets the seat\'s line in that same pane, and nothing is created or closed', async () => {
    writeFileSync(teamFile, teamYaml({ seats: [{ name: 'seat-1' }] }));
    recordSessionSeats({
      'seat-1': {
        stage: 'ready',
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        launched: { shell: 500, cli: [501] },
      },
    });
    await approve();

    const harness = makeHarness({
      'seat-1': {
        pane: 'pane-seat-1',
        workspace: 'ws-seat-1',
        inWorkspaceList: true,
        inPaneList: true,
        inAgentList: false,
        process: { shell: 700, foreground: [700] },
      },
    });
    // The launch puts the CLI in front of that pane, as the real host does.
    const baseRun = harness.launch.paneRun!;
    harness.launch.paneRun = (session, pane, command) => {
      const ran = baseRun(session, pane, command);
      const seat = harness.seats.get('seat-1')!;
      if (pane === seat.pane) {
        seat.process = { shell: 700, foreground: [701] };
        seat.inAgentList = true;
        seat.unnamed = true;
      }
      return ran;
    };
    const baseRename = harness.launch.renameAgent;
    harness.launch.renameAgent = (session, pane, name) => {
      const seat = harness.seats.get('seat-1')!;
      if (pane === seat.pane && name === 'seat-1') seat.unnamed = false;
      return baseRename(session, pane, name);
    };

    const result = await runRestoreSweepForRoute({ home, root, teamFile, sources: harness.sources() });
    expect(result.kind).toBe('ran');
    if (result.kind !== 'ran') return;
    expect(harness.creates).toEqual([]);
    expect(harness.closes).toEqual([]);
    expect(harness.runs.map((run) => run.pane)).toEqual(['pane-seat-1']);
    // The rename after the launch is not held by the CLI the launch itself put in the pane.
    expect(harness.renames).toEqual([{ pane: 'pane-seat-1', name: 'seat-1' }]);
  });
});
