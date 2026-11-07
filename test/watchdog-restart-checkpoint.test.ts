// End-to-end integration of the seat-health watchdog with `team restart` and a standing
// checkpoint (R2/R4), over fakes with no real CLI:
// - Scene 1 (Seam A): `observeRoute` + `runWatchdogSlice` detect a stalled seat after
//   `WATCHDOG_AFTER_MS`, invoke `restartArgs('worker')` (`['restart', 'worker', '--json']`),
//   drive `runRestart` -> `readRestartReady` -> `restartLandedText`, resume the seat's bound
//   conversation (`--resume <cli-session-id>`), carry the standing checkpoint's handover path
//   through `sessions.jsonl` and the new launch rules, emit `handover` in `team.restart` JSON,
//   and tell the lead `a handover file was already there`.
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askCheckpoint } from '../src/checkpoint/checkpoint.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { RESTART_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { observeRoute, type HealthRoute, type SeatHealthHost } from '../src/seat-health/live.ts';
import { runWatchdogSlice, watchdogState } from '../src/seat-health/pass.ts';
import { WATCHDOG_AFTER_MS } from '../src/seat-health/proof.ts';
import { readRestartReady, type RestartReady } from '../src/seat-health/restart.ts';
import { beginSession, readStoreSessions, type SessionRecord } from '../src/sessions/registry.ts';
import { emptySession, updateState } from '../src/state.ts';
import { storePath } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';
import { assertMatchesOutputSchema } from './helpers/output.ts';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const BOUND_CLI_SESSION = 'sess-watchdog-001';

const YAML = (root: string): string => `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
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
  root: string;
  home: string;
  dir: string;
  file: string;
  team: TeamFile;
  priorSessionId: string;
  handoverPath: string;
};

const owned: string[] = [];
afterEach(() => {
  for (const path of owned.splice(0)) discardFixtures([path]);
});

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'watchdog-restart-cp-')));
  owned.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  const file = join(dir, 'team.yaml');
  writeFileSync(file, YAML(root));
  const parsed = validateTeamFile(YAML(root), { home, root });
  if (!parsed.ok) throw new Error('fixture team does not validate');

  const workerSeat = parsed.team.seats.find((s) => s.name === 'worker')!;
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = {
      id: 'seat_000000000001',
      stage: 'ready',
      pane: 'pane-lead',
      workspace: 'ws-lead',
      cli: 'claude-code',
    };
    session.seats.worker = {
      id: 'seat_000000000002',
      stage: 'ready',
      pane: 'pane-old',
      workspace: 'ws-old',
      cli: 'claude-code',
      agent_session: BOUND_CLI_SESSION,
      last_active: NOW.toISOString(),
    };
  });

  const begun = beginSession({
    home,
    root,
    team: parsed.team,
    session: 'acme',
    seat: workerSeat,
    pane: 'pane-old',
    workspace: 'ws-old',
    cli_session: BOUND_CLI_SESSION,
    now: NOW,
  });
  if (!('id' in begun)) throw new Error(begun.note);

  registerAgent(home, {
    name: 'worker',
    seat_handle: 'seat_000000000002',
    cli: 'claude-code',
    lab: 'anthropic',
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: {
      session: 'acme',
      pane: 'pane-old',
      team: teamIdOf(root),
      seat: 'worker',
      address: null,
      agent_session: BOUND_CLI_SESSION,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  });

  const ask = askCheckpoint(dir, 'worker', 'acme', 'lead', NOW);
  mkdirSync(join(dir, 'handovers'), { recursive: true });
  writeFileSync(ask.path, '# handover\n\nresume from checkpoint\n');

  return {
    root,
    home,
    dir,
    file,
    team: parsed.team,
    priorSessionId: begun.id,
    handoverPath: ask.path,
  };
}

function makeWatchdogHost(): SeatHealthHost {
  return {
    agents: async () => [{ name: 'worker', pane: 'pane-old', status: 'working' }],
    text: async () => '✻ Thinking…',
    processes: async () => ({
      process_info: {
        shell_pid: 100,
        foreground_processes: [
          { pid: 100, argv0: 'zsh' },
          { pid: 101, argv0: 'claude' },
        ],
      },
    }),
  };
}

function healthRouteOf(fixture: Fixture): HealthRoute {
  return {
    home: fixture.home,
    root: fixture.root,
    session: 'acme',
    stateDir: fixture.dir,
    seats: [
      {
        name: 'worker',
        cli: 'claude-code',
        launch: 'claude --model claude-opus-5-5',
      },
    ],
  };
}

function makeRestartHarness(
  fixture: Fixture,
  options: { paneStillWorking?: boolean } = {},
): {
  sources: RestartSources;
  did: { typed: string[]; closed: string[]; runs: string[] };
} {
  const did = { typed: [] as string[], closed: [] as string[], runs: [] as string[] };
  let leadAlive = true;
  let workerAlive = true;
  const boxes = new Map<string, string>();
  const shelled = new Set<string>();
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();
  const oldStatus = options.paneStillWorking === true ? ('working' as const) : ('idle' as const);
  const oldScreenKind = options.paneStillWorking === true ? ('working' as const) : ('idle' as const);

  const agents = (): HerdrAgent[] => [
    ...(leadAlive
      ? [{ name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle' as const, cwd: fixture.root }]
      : []),
    ...(workerAlive
      ? [{
          name: 'worker',
          agent: 'claude-code',
          pane: 'pane-old',
          workspace: 'ws-old',
          status: oldStatus,
          cwd: fixture.root,
          session: BOUND_CLI_SESSION,
        }]
      : []),
    ...[...newPanes.entries()].filter(([, slot]) => slot.agent).map(([pane, slot]) => ({
      // A blank herdr name is null. An empty string is another seat's name.
      name: slot.name,
      agent: 'claude-code',
      pane,
      workspace: slot.workspace,
      status: 'idle' as const,
      cwd: fixture.root,
      session: BOUND_CLI_SESSION,
    })),
  ];

  const closeWorkspace = (_session: string, workspace: string): boolean => {
    did.closed.push(workspace);
    if (workspace === 'ws-lead') leadAlive = false;
    if (workspace === 'ws-old') workerAlive = false;
    return true;
  };

  const downLaunch: DownLaunch = {
    typeText(_session, pane, text) {
      did.typed.push(text);
      boxes.set(pane, claudeBox(text));
      return true;
    },
    sendKey: () => true,
    pressEnter(_session, pane) {
      shelled.add(pane);
      return true;
    },
    agentPanes: () => agents().map((agent) => agent.pane),
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
    createWorkspace() {
      newPanes.set('pane-new', { text: CLAUDE_IDLE, agent: false, name: null, workspace: 'ws-new' });
      return { pane: 'pane-new', workspace: 'ws-new' };
    },
    paneRun(_session, pane, command) {
      did.runs.push(command);
      const slot = newPanes.get(pane);
      if (slot) slot.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = newPanes.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace,
    agentPanes: () => agents().map((agent) => agent.pane),
    agents: () => agents(),
    paneText: (_session, pane) => newPanes.get(pane)?.text ?? CLAUDE_IDLE,
    typeText(_session, _pane, text) {
      did.typed.push(text);
      return true;
    },
    pressEnter(_session, pane) {
      const slot = newPanes.get(pane);
      if (slot) slot.text = CLAUDE_IDLE;
      return true;
    },
    agentStatus: () => 'idle',
    foreground: (_session, pane) => (shelled.has(pane) ? ['zsh'] : ['claude']),
    sleep: async () => {},
    now: () => NOW,
  };

  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home: fixture.home,
  };

  return {
    sources: {
      home: fixture.home,
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => agents(),
      workspaces: () => agents().map((agent) => ({ id: agent.workspace })),
      alive: () => true,
      screen: (_session, pane) => (pane === 'pane-old' ? { kind: oldScreenKind } : { kind: 'idle' }),
      screenText: (_session, pane) => boxes.get(pane) ?? claudeBox(''),
      status: (_session, pane) => (pane === 'pane-old' ? oldStatus : 'idle'),
      foreground: (_session, pane) => (shelled.has(pane) ? ['zsh'] : ['claude']),
      now: () => NOW,
      sleep: async () => {},
      launch: downLaunch,
      upLaunch,
      doctor,
    },
    did,
  };
}

function workerSessions(fixture: Fixture): SessionRecord[] {
  const read = readStoreSessions(storePath('acme', fixture.root, fixture.home), fixture.home);
  if (!read.ok) throw new Error(read.reason);
  return read.sessions.filter((one) => one.seat === 'worker');
}

describe('watchdog -> team restart -> conversation resume + checkpoint handover (end-to-end over fakes)', () => {
  test('Seam A: watchdog restart of a stalled seat with a checkpoint resumes the bound conversation, hands over the checkpoint path, emits handover in team.restart JSON, and tells the lead the file was there', async () => {
    const fixture = makeFixture();
    const watchdogHost = makeWatchdogHost();
    const route = healthRouteOf(fixture);
    const { sources, did } = makeRestartHarness(fixture);
    const state = watchdogState();
    const leadMessages: string[] = [];
    const restartInvocations: (readonly string[])[] = [];
    let restartJsonOut = '';

    // t = 0: watchdog observes the stalled seat and starts the stillness clock.
    const seatsT0 = await observeRoute(route, watchdogHost);
    await runWatchdogSlice(state, {
      seats: seatsT0,
      now: 0,
      restart: async () => ({ kind: 'failed' }),
      lead: (text) => leadMessages.push(text),
    });
    expect(restartInvocations).toEqual([]);
    expect(leadMessages).toEqual([]);

    // t = WATCHDOG_AFTER_MS: watchdog triggers `team restart worker --json`, driving `runRestart`
    // and reading its JSON stdout via `readRestartReady`.
    const seatsT1 = await observeRoute(route, watchdogHost);
    const restartPromises: Promise<RestartReady | { kind: 'failed' }>[] = [];
    await runWatchdogSlice(state, {
      seats: seatsT1,
      now: WATCHDOG_AFTER_MS,
      restart: (_seat, args) => {
        restartInvocations.push(args);
        const pending = (async (): Promise<RestartReady | { kind: 'failed' }> => {
          const io = testIo(fixture.root, {
            kind: 'seat',
            name: 'lead',
            pane: 'pane-lead',
            session: 'acme',
          });
          const code = await runRestart(args.slice(1), io, sources);
          restartJsonOut = io.out;
          const ready = readRestartReady(io.out);
          if (code === 0 && ready !== null) return ready;
          return { kind: 'failed' };
        })();
        restartPromises.push(pending);
        return pending;
      },
      lead: (text) => leadMessages.push(text),
    });
    await Promise.all(restartPromises);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(restartInvocations).toEqual([['restart', 'worker', '--json']]);

    // 1. `team.restart` JSON output matches RESTART_OUTPUT_SCHEMA and carries `handover`.
    const doc = assertMatchesOutputSchema(restartJsonOut, RESTART_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({
      schema: { name: 'team.restart', version: 1 },
      status: 'ready',
      seat: 'worker',
      pane: 'pane-new',
      handover: fixture.handoverPath,
    });

    // 2. Launch command resumes the bound conversation AND carries the checkpoint handover path.
    expect(did.runs).toHaveLength(1);
    expect(did.runs[0]).toContain(`--resume ${BOUND_CLI_SESSION}`);
    expect(did.runs[0]).toContain(
      `Your predecessor wrote a handover for you at ${fixture.handoverPath}; read it before anything else.`,
    );

    // 3. Session registry records the handover path on both the ended and the new session records.
    const sessions = workerSessions(fixture);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      id: fixture.priorSessionId,
      seat: 'worker',
      cli_session: BOUND_CLI_SESSION,
      reason: 'restart',
      handover: fixture.handoverPath,
    });
    expect(sessions[1]).toMatchObject({
      seat: 'worker',
      previous: fixture.priorSessionId,
      handover: fixture.handoverPath,
    });

    // 4. Watchdog reports to the lead that the recorded conversation was resumed AND a handover
    //    file was already there.
    expect(leadMessages).toEqual([
      'worker: restarted after 15 minutes with the screen unchanged; the recorded conversation was resumed; a handover file was already there',
    ]);
  });
});
