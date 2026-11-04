import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runOrder, type OrderSources } from '../src/commands/order.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { projectIdOfTeam } from '../src/dev_mode.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import {
  AUTO_ORDER_MARKER,
  maybeAutoOrder,
  realAutoOrderSources,
  sidebarTail,
  type AutoOrderInput,
  type AutoOrderSources,
  type SidebarRecorded,
  type SidebarTeam,
} from '../src/launch/auto-order.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { sidebarPolicy } from '../src/settings/sidebar-policy.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, shortSocketBase, testIo } from './helpers.ts';

const NOW = new Date('2026-11-04T10:00:00.000Z');
const EXPECTED_HINT = 'the sidebar is out of roster order; run team order once its tail is idle';

const TEAM_YAML = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: coordinator
    name: ops
    label: ops
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

type Fixture = {
  base: string;
  root: string;
  home: string;
  dir: string;
  file: string;
};

const tempBases: string[] = [];
afterEach(() => {
  while (tempBases.length > 0) {
    rmSync(tempBases.pop()!, { recursive: true, force: true });
  }
});

function makeFixture(opts: { opsStopped?: boolean } = {}): Fixture {
  const base = realpathSync(mkdtempSync(join(shortSocketBase(), 'ao-ind-')));
  tempBases.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  let yaml = TEAM_YAML.replace(
    'workspace:\n',
    `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:\n`,
  );
  if (opts.opsStopped) {
    yaml = yaml.replace(
      '    name: ops\n    label: ops\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5',
      '    name: ops\n    label: ops\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n    stopped: true',
    );
  }
  const file = join(dir, 'team.yaml');
  writeFileSync(file, yaml);
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((e) => e.message).join('; '));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: yaml },
    loaded.team.seats,
    home,
    NOW,
  );
  return { base, root, home, dir, file };
}

function makeDoctor(home: string): DoctorSources {
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

type CommandWorld = {
  workspaces: string[];
  seats: Map<string, { pane: string; workspace: string; status: string; text: string }>;
  spawned: Array<{ argv: string[]; root: string }>;
  hookHostReads: number;
  hookInvocations: AutoOrderInput[];
  env: Record<string, string | undefined>;
  nextId: number;
};

function createCommandWorld(
  fixture: Fixture,
  initialSeats: Array<{ name: string; pane: string; workspace: string; status?: string }>,
  initialWorkspaces?: string[],
): {
  world: CommandWorld;
  restartSources: RestartSources;
  addSources: AddSources;
} {
  const seats = new Map<string, { pane: string; workspace: string; status: string; text: string }>();
  for (const s of initialSeats) {
    seats.set(s.name, {
      pane: s.pane,
      workspace: s.workspace,
      status: s.status ?? 'idle',
      text: CLAUDE_IDLE,
    });
  }
  updateState(fixture.dir, (state) => {
    const sess = (state.sessions.acme ??= emptySession());
    for (const s of initialSeats) {
      sess.seats[s.name] = { stage: 'ready', pane: s.pane, workspace: s.workspace };
    }
  });

  const world: CommandWorld = {
    workspaces: initialWorkspaces ? [...initialWorkspaces] : initialSeats.map((s) => s.workspace),
    seats,
    spawned: [],
    hookHostReads: 0,
    hookInvocations: [],
    env: {},
    nextId: 1,
  };

  const shelledPanes = new Set<string>();
  const paneBoxes = new Map<string, string>();
  const pendingPanes = new Map<string, { workspace: string; text: string; active: boolean; name: string | null }>();

  const listAgents = (): HerdrAgent[] => {
    const out: HerdrAgent[] = [];
    const seenPanes = new Set<string>();
    for (const [name, info] of world.seats.entries()) {
      seenPanes.add(info.pane);
      out.push({
        name,
        agent: 'claude-code',
        pane: info.pane,
        workspace: info.workspace,
        status: info.status,
        cwd: fixture.root,
      });
    }
    for (const [pane, slot] of pendingPanes.entries()) {
      if (slot.active && !seenPanes.has(pane)) {
        out.push({
          name: slot.name,
          agent: 'claude-code',
          pane,
          workspace: slot.workspace,
          status: 'idle',
          cwd: fixture.root,
        });
      }
    }
    return out;
  };

  const closeWorkspace = (_session: string | undefined, workspace: string): boolean => {
    world.workspaces = world.workspaces.filter((w) => w !== workspace);
    for (const [name, info] of world.seats.entries()) {
      if (info.workspace === workspace) {
        world.seats.delete(name);
      }
    }
    for (const [pane, slot] of pendingPanes.entries()) {
      if (slot.workspace === workspace) {
        pendingPanes.delete(pane);
      }
    }
    return true;
  };

  const downLaunch: DownLaunch = {
    typeText(_session, pane, text) {
      paneBoxes.set(pane, claudeBox(text));
      return true;
    },
    sendKey: () => true,
    pressEnter(_session, pane) {
      shelledPanes.add(pane);
      return true;
    },
    agentPanes: () => listAgents().map((a) => a.pane),
    closeWorkspace,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };

  const upLaunch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      const idx = world.nextId++;
      const pane = `pane-created-${idx}`;
      const workspace = `ws-created-${idx}`;
      world.workspaces.push(workspace);
      pendingPanes.set(pane, { workspace, text: CLAUDE_IDLE, active: false, name: label ?? null });
      return { pane, workspace };
    },
    paneRun(_session, pane) {
      const slot = pendingPanes.get(pane);
      if (slot) slot.active = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = pendingPanes.get(pane);
      if (slot) {
        slot.name = name;
        world.seats.set(name, { pane, workspace: slot.workspace, status: 'idle', text: CLAUDE_IDLE });
      }
      return true;
    },
    closeWorkspace,
    agentPanes: () => listAgents().map((a) => a.pane),
    agents: () => listAgents(),
    workspacePanes: (_session, ws) => {
      for (const info of world.seats.values()) {
        if (info.workspace === ws) return [info.pane];
      }
      for (const [pane, slot] of pendingPanes.entries()) {
        if (slot.workspace === ws) return [pane];
      }
      return [`pane-of-${ws}`];
    },
    paneText: (_session, pane) => pendingPanes.get(pane)?.text ?? CLAUDE_IDLE,
    typeText(_session, pane, text) {
      const slot = pendingPanes.get(pane);
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      if (slot && pasted) slot.text = claudeBox(pasted[1] ?? '');
      return true;
    },
    pressEnter(_session, pane) {
      const slot = pendingPanes.get(pane);
      if (slot) slot.text = CLAUDE_IDLE;
      return true;
    },
    agentStatus: () => 'idle',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };

  const autoOrder: typeof maybeAutoOrder = (input, s = realAutoOrderSources) => {
    world.hookInvocations.push(input);
    return maybeAutoOrder(input, {
      ...s,
      workspaces: (sess) => {
        world.hookHostReads += 1;
        return s.workspaces(sess);
      },
      agents: (sess) => {
        world.hookHostReads += 1;
        return s.agents(sess);
      },
      spawnOrder: (argv, root) => {
        world.spawned.push({ argv, root });
      },
      env: (name) => world.env[name],
    });
  };

  const doctor = makeDoctor(fixture.home);

  const restartSources: RestartSources = {
    home: fixture.home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => listAgents(),
    workspaces: () => world.workspaces.map((id) => ({ id })),
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: (_session, pane) => paneBoxes.get(pane) ?? claudeBox(''),
    status: (_session, pane) => {
      for (const info of world.seats.values()) {
        if (info.pane === pane) return info.status;
      }
      return 'idle';
    },
    foreground: (_session, pane) => (shelledPanes.has(pane) ? ['zsh'] : ['claude']),
    now: () => NOW,
    sleep: async () => {},
    launch: downLaunch,
    upLaunch,
    doctor,
    autoOrder,
  };

  const addSources: AddSources = {
    home: fixture.home,
    sessionState: () => 'running',
    agents: () => listAgents(),
    workspaces: () => world.workspaces.map((id) => ({ id })),
    doctor,
    now: () => NOW,
    launch: upLaunch,
    autoOrder,
  };

  return { world, restartSources, addSources };
}

describe('independent auto-order verification', () => {
  test('sidebarTail and maybeAutoOrder compute the diverging roster tail, spawn detached team order when idle, and emit the hint without spawning when any tail seat is working or blocked', () => {
    // 1. sidebarTail: orchestrator is lifted first regardless of file order, human seats and
    //    unplaced seats are excluded, non-seat workspaces (watch/bus) are ignored, and a seat
    //    without a recorded workspace falls back to its pane's agent workspace.
    const team: SidebarTeam = {
      orchestrator: 'lead',
      seats: [
        { name: 'ops' },
        { name: 'observer', human: true },
        { name: 'lead' },
        { name: 'worker' },
        { name: 'reviewer' },
        { name: 'unplaced' },
      ],
    };
    const recorded: SidebarRecorded = {
      seats: {
        lead: { pane: 'pane-lead', workspace: 'ws-lead' },
        ops: { pane: 'pane-ops', workspace: 'ws-ops' },
        worker: { pane: 'pane-worker' }, // legacy state: workspace resolved from agent by pane
        reviewer: { pane: 'pane-rev', workspace: 'ws-rev' },
        observer: { pane: 'pane-human', workspace: 'ws-human' },
      },
    };
    const agents: HerdrAgent[] = [
      { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: null },
      { name: 'ops', agent: 'claude-code', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle', cwd: null },
      { name: 'worker', agent: 'claude-code', pane: 'pane-worker', workspace: 'ws-worker', status: 'idle', cwd: null },
      { name: 'reviewer', agent: 'claude-code', pane: 'pane-rev', workspace: 'ws-rev', status: 'idle', cwd: null },
    ];

    const outOfOrder = sidebarTail(
      team,
      recorded,
      [
        { id: 'ws-watch' },
        { id: 'ws-lead' },
        { id: 'ws-bus' },
        { id: 'ws-rev' },
        { id: 'ws-ops' },
        { id: 'ws-worker' },
        { id: 'ws-human' },
      ],
      agents,
    );
    expect(outOfOrder.roster).toEqual(['lead', 'ops', 'worker', 'reviewer', 'unplaced']);
    expect(outOfOrder.aimed).toEqual(['lead', 'ops', 'worker', 'reviewer']);
    expect(outOfOrder.inSidebar).toEqual(['lead', 'reviewer', 'ops', 'worker']);
    expect(outOfOrder.tail).toEqual(['ops', 'worker', 'reviewer']);

    const alreadyOrdered = sidebarTail(
      team,
      recorded,
      [{ id: 'ws-lead' }, { id: 'ws-watch' }, { id: 'ws-ops' }, { id: 'ws-worker' }, { id: 'ws-rev' }],
      agents,
    );
    expect(alreadyOrdered.tail).toEqual([]);

    // 2. maybeAutoOrder: busy tail ('working' or 'blocked') returns the hint and never spawns;
    //    busy seat outside the tail ('lead' working/blocked while tail is idle/done) spawns once.
    const makeHookSources = (opts: {
      workspaces?: { id: string }[] | null;
      statuses?: Record<string, string>;
      stateThrows?: boolean;
      spawnThrows?: boolean;
    }) => {
      const spawned: Array<{ argv: string[]; root: string }> = [];
      const statuses = opts.statuses ?? {};
      const sources: AutoOrderSources = {
        workspaces: () =>
          opts.workspaces !== undefined
            ? opts.workspaces
            : [{ id: 'ws-lead' }, { id: 'ws-rev' }, { id: 'ws-ops' }, { id: 'ws-worker' }],
        agents: () =>
          agents.map((a) => ({
            ...a,
            status: statuses[a.name ?? ''] ?? 'idle',
          })),
        state: () => {
          if (opts.stateThrows) throw new Error('corrupt state');
          return { sessions: { acme: recorded } };
        },
        spawnOrder: (argv, root) => {
          if (opts.spawnThrows) throw new Error('spawn failed');
          spawned.push({ argv, root });
        },
        env: () => undefined,
      };
      return { sources, spawned };
    };

    const baseInput: AutoOrderInput = {
      root: '/work/acme',
      dir: '/work/acme/.agents',
      team,
      session: 'acme',
      manage: true,
    };

    // Busy tail seat: working or blocked at any position in the tail -> hint and no spawn
    for (const tailSeat of ['ops', 'worker', 'reviewer']) {
      for (const busyStatus of ['working', 'blocked']) {
        const { sources, spawned } = makeHookSources({ statuses: { [tailSeat]: busyStatus } });
        expect(maybeAutoOrder(baseInput, sources)).toBe(EXPECTED_HINT);
        expect(spawned).toEqual([]);
      }
    }

    // Busy seat outside the tail ('lead' is working/blocked) while tail seats are 'idle'/'done' -> spawns detached order
    for (const leadStatus of ['working', 'blocked']) {
      const { sources, spawned } = makeHookSources({
        statuses: { lead: leadStatus, ops: 'idle', worker: 'done', reviewer: 'idle' },
      });
      expect(maybeAutoOrder({ ...baseInput, file: 'custom-team.yaml' }, sources)).toBeNull();
      expect(spawned).toEqual([
        { argv: ['order', '--session', 'acme', '--file', 'custom-team.yaml'], root: '/work/acme' },
      ]);
    }

    // Degraded state / silent host / throwing spawn -> returns hint and never throws
    expect(maybeAutoOrder(baseInput, makeHookSources({ stateThrows: true }).sources)).toBe(EXPECTED_HINT);
    expect(maybeAutoOrder(baseInput, makeHookSources({ workspaces: null }).sources)).toBe(EXPECTED_HINT);
    expect(maybeAutoOrder(baseInput, makeHookSources({ spawnThrows: true }).sources)).toBe(EXPECTED_HINT);
  });

  test('manage false and workspace.sidebar.manage=off return null without spawning, hinting, or reading the pane host across maybeAutoOrder and runRestart', async () => {
    // 1. Direct maybeAutoOrder with manage: false does not read state, workspaces, or agents,
    //    spawns nothing, and returns null even when the tail is out of order and busy.
    let stateReads = 0;
    let workspaceReads = 0;
    let agentReads = 0;
    const spawned: string[][] = [];
    const directResult = maybeAutoOrder(
      {
        root: '/work/acme',
        dir: '/work/acme/.agents',
        team: { orchestrator: 'lead', seats: [{ name: 'lead' }, { name: 'ops' }, { name: 'worker' }] },
        session: 'acme',
        manage: false,
      },
      {
        state: () => {
          stateReads += 1;
          return {
            sessions: {
              acme: {
                seats: {
                  lead: { pane: 'pane-lead', workspace: 'ws-lead' },
                  ops: { pane: 'pane-ops', workspace: 'ws-ops' },
                  worker: { pane: 'pane-worker', workspace: 'ws-worker' },
                },
              },
            },
          };
        },
        workspaces: () => {
          workspaceReads += 1;
          return [{ id: 'ws-lead' }, { id: 'ws-worker' }, { id: 'ws-ops' }];
        },
        agents: () => {
          agentReads += 1;
          return [
            { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: null },
            { name: 'ops', agent: 'claude-code', pane: 'pane-ops', workspace: 'ws-ops', status: 'working', cwd: null },
            { name: 'worker', agent: 'claude-code', pane: 'pane-worker', workspace: 'ws-worker', status: 'blocked', cwd: null },
          ];
        },
        spawnOrder: (argv) => {
          spawned.push(argv);
        },
        env: () => undefined,
      },
    );
    expect(directResult).toBeNull();
    expect(spawned).toEqual([]);
    expect(stateReads).toBe(0);
    expect(workspaceReads).toBe(0);
    expect(agentReads).toBe(0);

    // 2. End-to-end through runRestart when workspace.sidebar.manage is set to 'off' in the policy chain:
    //    Restarting 'ops' places it after 'worker' (out-of-order tail ['ops', 'worker']).
    //    Even when 'worker' is working (or idle), manage=off produces neither a spawn nor a hint.
    const fixture = makeFixture();
    const loaded = loadTeamFile(fixture.root, { home: fixture.home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const projectId = projectIdOfTeam(fixture.home, loaded.team, fixture.root)!;
    expect(
      writePolicySet(
        fixture.home,
        { level: 'project', target: projectId, name: 'workspace.sidebar.manage', value: 'off' },
        { now: NOW },
      ).ok,
    ).toBe(true);
    expect(sidebarPolicy({ home: fixture.home, root: fixture.root, team: loaded.team, now: NOW }).manage).toBe(false);

    for (const workerStatus of ['working', 'idle'] as const) {
      const { world, restartSources } = createCommandWorld(fixture, [
        { name: 'lead', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle' },
        { name: 'ops', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle' },
        { name: 'worker', pane: 'pane-worker', workspace: 'ws-worker', status: workerStatus },
      ]);

      const plainIo = testIo(fixture.root, { kind: 'owner' });
      expect(await runRestart(['ops'], plainIo, restartSources)).toBe(0);
      expect(world.hookInvocations).toHaveLength(1);
      expect(world.hookInvocations[0]?.manage).toBe(false);
      expect(world.spawned).toEqual([]);
      expect(world.hookHostReads).toBe(0);
      expect(plainIo.out).not.toContain('team order');

      const jsonIo = testIo(fixture.root, { kind: 'owner' });
      expect(await runRestart(['ops', '--json'], jsonIo, restartSources)).toBe(0);
      const doc = JSON.parse(jsonIo.out) as { status: string; notes?: string[] };
      expect(doc.status).toBe('ready');
      expect((doc.notes ?? []).some((n) => n.includes('team order'))).toBe(false);
      expect(world.spawned).toEqual([]);
      expect(world.hookHostReads).toBe(0);
    }
  });

  test('AUTO_ORDER_MARKER suppresses recursion both directly in maybeAutoOrder and across in-process runRestart calls delegated by runOrder', async () => {
    // 1. Direct maybeAutoOrder with TEAM_AUTO_ORDER set in env does not read state or pane host,
    //    spawns nothing, and returns null.
    let reads = 0;
    const spawned: string[][] = [];
    for (const markerVal of ['1', '']) {
      const res = maybeAutoOrder(
        {
          root: '/work/acme',
          dir: '/work/acme/.agents',
          team: { orchestrator: 'lead', seats: [{ name: 'lead' }, { name: 'ops' }, { name: 'worker' }] },
          session: 'acme',
          manage: true,
        },
        {
          state: () => {
            reads += 1;
            return { sessions: {} };
          },
          workspaces: () => {
            reads += 1;
            return null;
          },
          agents: () => {
            reads += 1;
            return null;
          },
          spawnOrder: (argv) => {
            spawned.push(argv);
          },
          env: (name) => (name === AUTO_ORDER_MARKER ? markerVal : undefined),
        },
      );
      expect(res).toBeNull();
    }
    expect(reads).toBe(0);
    expect(spawned).toEqual([]);

    // 2. End-to-end: runOrder delegates its restarts in-process to runRestart for each seat in the
    //    diverging tail ['ops', 'worker'] (initial sidebar: lead, worker, ops).
    //    With TEAM_AUTO_ORDER='1' in the environment (as realAutoOrderSources.spawnOrder sets on
    //    the detached child), each delegated runRestart hits its ready exit, invokes maybeAutoOrder,
    //    and remains completely silent — zero recursive spawns, zero hook host reads, zero hints —
    //    while runOrder finishes bringing the sidebar into roster order.
    const fixture = makeFixture();
    const { world, restartSources } = createCommandWorld(
      fixture,
      [
        { name: 'lead', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle' },
        { name: 'ops', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle' },
        { name: 'worker', pane: 'pane-worker', workspace: 'ws-worker', status: 'idle' },
      ],
      ['ws-lead', 'ws-worker', 'ws-ops'],
    );
    world.env[AUTO_ORDER_MARKER] = '1';

    const orderSources: OrderSources = {
      home: fixture.home,
      now: () => NOW,
      sessionState: () => 'running',
      workspaces: () => world.workspaces.map((id) => ({ id })),
      agents: () => restartSources.agents('acme'),
      state: (dir) => readState(dir),
      restart: (argv, io) => runRestart(argv, io, restartSources),
    };

    const orderIo = testIo(fixture.root, { kind: 'owner' });
    expect(await runOrder([], orderIo, orderSources)).toBe(0);
    // Both 'ops' and 'worker' ran through real runRestart ready exits:
    expect(world.hookInvocations).toHaveLength(2);
    expect(world.hookInvocations.map((inv) => inv.session)).toEqual(['acme', 'acme']);
    // Neither delegated restart spawned a recursive order pass or read the host inside maybeAutoOrder:
    expect(world.spawned).toEqual([]);
    expect(world.hookHostReads).toBe(0);
    expect(orderIo.out).not.toContain(EXPECTED_HINT);
    expect(orderIo.out).toContain('team order: sidebar: lead, ops, worker\n');
  });

  test('ready runRestart and ready runAdd wire the auto-order pass and its busy-tail hint while dry-run stays silent', async () => {
    // 1. runRestart: restarting 'ops' places it after 'worker', creating tail ['ops', 'worker'].
    //    - When 'worker' is blocked, ready exit prints/records the hint and does not spawn.
    //    - When 'worker' is idle, ready exit spawns detached `team order` and emits no hint.
    //    - `--dry-run` never invokes autoOrder.
    const restartFix = makeFixture();
    const { world: busyRestartWorld, restartSources: busyRestartSources } = createCommandWorld(restartFix, [
      { name: 'lead', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle' },
      { name: 'ops', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle' },
      { name: 'worker', pane: 'pane-worker', workspace: 'ws-worker', status: 'blocked' },
    ]);

    const dryRestartIo = testIo(restartFix.root, { kind: 'owner' });
    expect(await runRestart(['ops', '--dry-run'], dryRestartIo, busyRestartSources)).toBe(0);
    expect(busyRestartWorld.hookInvocations).toHaveLength(0);
    expect(busyRestartWorld.spawned).toEqual([]);

    const plainRestartIo = testIo(restartFix.root, { kind: 'owner' });
    expect(await runRestart(['ops'], plainRestartIo, busyRestartSources)).toBe(0);
    expect(busyRestartWorld.hookInvocations).toHaveLength(1);
    expect(busyRestartWorld.spawned).toEqual([]);
    expect(plainRestartIo.out).toContain(`team restart: ${EXPECTED_HINT}\n`);

    const jsonRestartIo = testIo(restartFix.root, { kind: 'owner' });
    expect(await runRestart(['ops', '--json'], jsonRestartIo, busyRestartSources)).toBe(0);
    const restartDoc = JSON.parse(jsonRestartIo.out) as { status: string; notes?: string[] };
    expect(restartDoc.status).toBe('ready');
    expect(restartDoc.notes).toContain(`team restart: ${EXPECTED_HINT}`);
    expect(busyRestartWorld.spawned).toEqual([]);

    // Now set 'worker' to 'idle' and restart 'ops' again -> spawns detached order pass with no hint
    busyRestartWorld.seats.get('worker')!.status = 'idle';
    const idleRestartIo = testIo(restartFix.root, { kind: 'owner' });
    expect(await runRestart(['ops', '--file', restartFix.file], idleRestartIo, busyRestartSources)).toBe(0);
    expect(busyRestartWorld.spawned).toEqual([
      { argv: ['order', '--session', 'acme', '--file', restartFix.file], root: restartFix.root },
    ]);
    expect(idleRestartIo.out).not.toContain(EXPECTED_HINT);

    // 2. runAdd: starting stopped seat 'ops' places its new workspace after 'worker' (tail ['ops', 'worker']).
    //    - `--dry-run` does not invoke autoOrder.
    //    - When 'worker' is working, ready exit emits `team add: <hint>` in plain and JSON modes and does not spawn.
    //    - When 'worker' is idle, ready exit spawns detached `team order` and emits no hint.
    const addBusyFix = makeFixture({ opsStopped: true });
    const { world: addBusyWorld, addSources: addBusySources } = createCommandWorld(addBusyFix, [
      { name: 'lead', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle' },
      { name: 'worker', pane: 'pane-worker', workspace: 'ws-worker', status: 'working' },
    ]);

    const dryAddIo = testIo(addBusyFix.root, { kind: 'owner' });
    expect(await runAdd(['ops', '--dry-run'], dryAddIo, addBusySources)).toBe(0);
    expect(addBusyWorld.hookInvocations).toHaveLength(0);
    expect(addBusyWorld.spawned).toEqual([]);

    const plainAddIo = testIo(addBusyFix.root, { kind: 'owner' });
    expect(await runAdd(['ops'], plainAddIo, addBusySources)).toBe(0);
    expect(addBusyWorld.hookInvocations).toHaveLength(1);
    expect(addBusyWorld.spawned).toEqual([]);
    expect(plainAddIo.out).toContain(`team add: ${EXPECTED_HINT}\n`);

    const addJsonFix = makeFixture({ opsStopped: true });
    const { world: addJsonWorld, addSources: addJsonSources } = createCommandWorld(addJsonFix, [
      { name: 'lead', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle' },
      { name: 'worker', pane: 'pane-worker', workspace: 'ws-worker', status: 'blocked' },
    ]);
    const jsonAddIo = testIo(addJsonFix.root, { kind: 'owner' });
    expect(await runAdd(['ops', '--json'], jsonAddIo, addJsonSources)).toBe(0);
    const addDoc = JSON.parse(jsonAddIo.out) as { status: string; notes?: string[] };
    expect(addDoc.status).toBe('ready');
    expect(addDoc.notes).toContain(`team add: ${EXPECTED_HINT}`);
    expect(addJsonWorld.spawned).toEqual([]);

    const addIdleFix = makeFixture({ opsStopped: true });
    const { world: addIdleWorld, addSources: addIdleSources } = createCommandWorld(addIdleFix, [
      { name: 'lead', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle' },
      { name: 'worker', pane: 'pane-worker', workspace: 'ws-worker', status: 'idle' },
    ]);
    const idleAddIo = testIo(addIdleFix.root, { kind: 'owner' });
    expect(await runAdd(['ops'], idleAddIo, addIdleSources)).toBe(0);
    expect(addIdleWorld.spawned).toEqual([
      { argv: ['order', '--session', 'acme'], root: addIdleFix.root },
    ]);
    expect(idleAddIo.out).not.toContain(EXPECTED_HINT);
  });
});
