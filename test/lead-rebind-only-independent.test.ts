import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { reportedConversationProblem } from '../src/commands/send.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { findAgent, registerAgent, updateAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState, type SeatState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T12:00:00Z');
const SESSION = 'acme';
const LEAD = 'lead';
const SEAT_ONE = 'seat-1';
const SEAT_TWO = 'seat-2';
const INITIAL_SES = 'ses_initial_01';
const ROTATED_SES = 'ses_working_rebind_02';
const MODEL = 'Claude Opus';
const VERSION = '5.5';
const LAUNCH = 'claude --model claude-opus-5-5';
const PANE = 'fixture-pane-one';
const OTHER_PANE = 'fixture-pane-two';
const SPACE = 'fixture-space-one';
const RECORDED = { shell: 100, cli: [200] };
const PANE_PROCESSES: PaneProcesses = { shell: 100, foreground: [200] };
const SEAT_HANDLE = 'seat_0123456789ab';

const bases: string[] = [];
let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;
let sockets: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'ignore',
    env: gitEnv(),
  });
}

function teamText(humanLead = false): string {
  return `format: 1
project: acme
coordinator: ${LEAD}
operator: ${LEAD}
session: ${SESSION}
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${LEAD}
    label: ${LEAD}
    cli: claude-code
    vendor: anthropic
    model: ${MODEL}
    version: "${VERSION}"
    launch: ${LAUNCH}
${humanLead ? '    human: true\n' : ''}  - role: implementer
    name: ${SEAT_ONE}
    label: ${SEAT_ONE}
    cli: claude-code
    vendor: anthropic
    model: ${MODEL}
    version: "${VERSION}"
    launch: ${LAUNCH}
  - role: implementer
    name: ${SEAT_TWO}
    label: ${SEAT_TWO}
    cli: claude-code
    vendor: anthropic
    model: ${MODEL}
    version: "${VERSION}"
    launch: ${LAUNCH}
`;
}

function stand(humanLead = false): void {
  const text = teamText(humanLead);
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
}

function recordSeat(
  name: string,
  over: {
    stage?: 'ready' | 'launched';
    pane?: string;
    workspace?: string;
    launched?: { shell: number; cli: number[] };
    agent_session?: string;
  } = {},
): void {
  const held: SeatState = {
    stage: over.stage ?? 'ready',
    id: SEAT_HANDLE,
    pane: over.pane ?? PANE,
    workspace: over.workspace ?? SPACE,
    launched: over.launched ?? RECORDED,
    agent_session: over.agent_session ?? INITIAL_SES,
    model: MODEL,
    version: VERSION,
    launch_line: LAUNCH,
  };
  updateState(dir, (file) => {
    const session = (file.sessions[SESSION] ??= emptySession());
    session.seats[name] = held;
    session.watch = { heartbeat: NOW.toISOString(), pane: 'fixture-watch-pane' };
  });
}

function registerSeat(
  name: string,
  over: {
    pane?: string | null;
    address?: string | null;
    agent_session?: string;
    lifecycle?: 'running' | 'stopped';
    cli?: 'claude-code' | 'codex';
  } = {},
): void {
  registerAgent(home, {
    name,
    signing: { model: MODEL, version: VERSION, role: name === LEAD ? 'coordinator' : 'implementer' },
    lab: 'anthropic',
    cli: over.cli ?? 'claude-code',
    launcher: null,
    launch: LAUNCH,
    reach: {
      team: teamIdOf(root),
      seat: name,
      session: SESSION,
      pane: over.pane === undefined ? PANE : over.pane,
      address: over.address ?? null,
      agent_session: over.agent_session ?? INITIAL_SES,
    },
    seat_handle: SEAT_HANDLE,
    mcp: [],
    skills: [],
    lifecycle: over.lifecycle ?? 'running',
    by: 'team up',
  });
}

function writeFreshInboundAndSocket(
  seat = LEAD,
  pid = 200,
  options: { staleInbound?: boolean } = {},
): string {
  const settings = cliHookSettingsPath(dir, SESSION, seat, LAUNCH);
  if (settings === null) throw new Error('expected hook settings path');
  mkdirSync(join(settings, '..'), { recursive: true });
  writeFileSync(settings, '{"crossSessionInbound":"accept"}\n');
  const inbound = join(dir, 'inbound', SESSION, `${seat}.json`);
  mkdirSync(join(inbound, '..'), { recursive: true });
  writeFileSync(
    inbound,
    `${JSON.stringify({
      version: 1,
      session: SESSION,
      seat,
      root,
      channel_dir: null,
      mcp_config: null,
      settings_file: settings,
      written_at: NOW.toISOString(),
    })}\n`,
  );
  const socketPath = join(sockets, `${String(pid)}.sock`);
  writeFileSync(socketPath, '');
  const baseSec = Math.floor(NOW.getTime() / 1000);
  if (options.staleInbound) {
    utimesSync(inbound, baseSec - 30, baseSec - 30);
    utimesSync(socketPath, baseSec - 20, baseSec - 20);
    utimesSync(settings, baseSec - 5, baseSec - 5);
  } else {
    utimesSync(settings, baseSec - 30, baseSec - 30);
    utimesSync(inbound, baseSec - 20, baseSec - 20);
    utimesSync(socketPath, baseSec - 5, baseSec - 5);
  }
  return socketPath;
}

function makeDoctor(over: Partial<DoctorSources> = {}): DoctorSources {
  return {
    version: () => '1.0.0',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.0',
    sessionRunning: () => true,
    now: () => NOW,
    home,
    ...over,
  };
}

function makeWorld(
  seat = LEAD,
  over: Partial<Launch> = {},
): {
  sources: UpSources;
  created: string[];
  closed: string[];
  runs: Array<{ pane: string; command: string }>;
} {
  const created: string[] = [];
  const closed: string[] = [];
  const runs: Array<{ pane: string; command: string }> = [];
  const launch: Launch = {
    conversationExists: () => true,
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: (_s, _c, label) => {
      created.push(label);
      return { pane: `new-${label}`, workspace: `ws-${label}` };
    },
    paneRun: (_s, pane, command) => {
      runs.push({ pane, command });
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: (_s, ws) => {
      closed.push(ws);
      return true;
    },
    agentPanes: () => [PANE],
    agents: (): HerdrAgent[] => [
      {
        name: seat,
        agent: 'claude',
        pane: PANE,
        workspace: SPACE,
        status: 'working',
        cwd: root,
        session: ROTATED_SES,
      },
    ],
    workspacePanes: () => [PANE],
    paneText: () => 'Working…\nesc to interrupt',
    foreground: () => ['claude'],
    processInfo: () => PANE_PROCESSES,
    sleep: async () => {},
    now: () => NOW,
    ...over,
  };
  return {
    created,
    closed,
    runs,
    sources: {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => launch.agents(SESSION),
      workspaces: () => [{ id: SPACE, label: `${seat} · coordinator` }],
      home,
      now: () => NOW,
      sleep: async () => {},
      launch,
      doctor: makeDoctor(),
      sockets: [sockets],
      machine: () => ({
        loadPerCore: 0.2,
        memoryFree: 50,
        diskFree: 50_000_000_000,
        swapTotal: 8_000_000_000,
        swapFree: 7_000_000_000,
        swapUsed: 1_000_000_000,
      }),
    },
  };
}

function seatOf(name = LEAD): SeatState | undefined {
  return readState(dir).sessions[SESSION]?.seats[name];
}

function agentOf(name = LEAD) {
  return findAgent(home, { team: teamIdOf(root), seat: name });
}

function teamLog(): string {
  try {
    return readFileSync(join(dir, 'team.log'), 'utf8');
  } catch {
    return '';
  }
}

beforeEach(() => {
  base = fixtureBase('lead-rebind-only-ind-');
  bases.push(base);
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  sockets = join(base, 'sockets');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  git(root, 'init');
  git(root, 'commit', '--allow-empty', '-m', 'init');
});

afterEach(() => {
  discardFixtures(bases.splice(0));
});

describe('one-seat working rebind (729fa2236): team up --rebind <seat> independent verification', () => {
  test('Scene 1: calling lead rebinds its own working pane via --rebind without starting or closing anything (plus --dry-run and --json)', async () => {
    stand(false);
    recordSeat(LEAD);
    registerSeat(LEAD);
    const socketPath = writeFreshInboundAndSocket(LEAD, 200);
    const world = makeWorld(LEAD);

    // Before rebind, reportedConversationProblem rejects the rotated live conversation:
    const beforeProblem = reportedConversationProblem(
      agentOf(LEAD)!,
      PANE,
      {
        agents: () => [
          { name: LEAD, pane: PANE, cli: 'claude', session: ROTATED_SES },
        ],
      },
    );
    expect(beforeProblem).toContain(
      "the live conversation on pane fixture-pane-one does not match the registry's conversation for seat lead",
    );

    // 1a) --dry-run --json from the working lead caller shows proposed rebind and writes neither store:
    const dryIo = testIo(root, { kind: 'seat', name: LEAD, pane: PANE, session: SESSION });
    const dryCode = await runUp(['--rebind', LEAD, '--dry-run', '--json'], dryIo, world.sources);
    expect(dryCode, dryIo.err + dryIo.out).toBe(0);
    const dryDoc = JSON.parse(dryIo.out);
    expect(dryDoc.status).toBe('dry-run');
    expect(dryDoc.seats).toEqual([LEAD]);
    expect(dryDoc.plan).toEqual([]);
    expect(dryDoc.rebind).toEqual({ seat: LEAD, changed: true, applied: false });
    expect(seatOf(LEAD)?.agent_session).toBe(INITIAL_SES);
    expect(agentOf(LEAD)?.reach.agent_session).toBe(INITIAL_SES);

    // 1b) Live --rebind from the calling lead on its own working pane updates state + registry:
    const liveIo = testIo(root, { kind: 'seat', name: LEAD, pane: PANE, session: SESSION });
    const liveCode = await runUp(['--rebind', LEAD], liveIo, world.sources);
    expect(liveCode, liveIo.err + liveIo.out).toBe(0);
    expect(liveIo.out).toContain(`${LEAD}: rebound to the live conversation on its recorded pane; no process was stopped or launched`);
    expect(seatOf(LEAD)?.agent_session).toBe(ROTATED_SES);
    expect(agentOf(LEAD)?.reach.agent_session).toBe(ROTATED_SES);
    expect(agentOf(LEAD)?.reach.address).toBe(socketPath);
    expect(world.created).toEqual([]);
    expect(world.closed).toEqual([]);
    expect(world.runs).toEqual([]);
    expect(teamLog()).toContain(`${LEAD}: rebound to the live conversation on its recorded pane`);

    // After rebind, reportedConversationProblem passes (null):
    const afterProblem = reportedConversationProblem(
      agentOf(LEAD)!,
      PANE,
      {
        agents: () => [
          { name: LEAD, pane: PANE, cli: 'claude', session: ROTATED_SES },
        ],
      },
    );
    expect(afterProblem).toBeNull();

    // 1c) Repeating --rebind when already bound reports 'already bound' with changed: false:
    const repeatIo = testIo(root, { kind: 'seat', name: LEAD, pane: PANE, session: SESSION });
    expect(await runUp(['--rebind', LEAD, '--json'], repeatIo, world.sources)).toBe(0);
    const repeatDoc = JSON.parse(repeatIo.out);
    expect(repeatDoc.rebind).toEqual({ seat: LEAD, changed: false, applied: false });
  });

  test('Scene 2: one-seat isolation skips launch-only doctor/load checks and leaves unlaunched sibling seats untouched', async () => {
    stand(true);
    recordSeat(SEAT_ONE);
    registerSeat(SEAT_ONE);
    writeFreshInboundAndSocket(SEAT_ONE, 200);
    const world = makeWorld(SEAT_ONE);

    // Make doctor and machine load throw if consulted in --rebind mode:
    world.sources.doctor = () => {
      throw new Error('doctor must not run in --rebind mode');
    };
    world.sources.machine = () => {
      throw new Error('machine load check must not run in --rebind mode');
    };

    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', SEAT_ONE], io, world.sources), io.err + io.out).toBe(0);
    expect(seatOf(SEAT_ONE)?.agent_session).toBe(ROTATED_SES);
    expect(agentOf(SEAT_ONE)?.reach.agent_session).toBe(ROTATED_SES);
    // Sibling SEAT_TWO was never launched or registered:
    expect(seatOf(SEAT_TWO)).toBeUndefined();
    expect(agentOf(SEAT_TWO)).toBeNull();
    expect(world.created).toEqual([]);
    expect(world.closed).toEqual([]);
  });

  test('Scene 3: caller placement and admission refusals reject callers outside the recorded pane, unadmitted workers, and incompatible flags', async () => {
    stand(false);
    recordSeat(LEAD);
    registerSeat(LEAD);
    recordSeat(SEAT_ONE, { pane: OTHER_PANE });
    registerSeat(SEAT_ONE, { pane: OTHER_PANE });
    writeFreshInboundAndSocket(LEAD, 200);
    const world = makeWorld(LEAD);

    // 3a) Calling lead from ANOTHER pane (OTHER_PANE != PANE) is refused:
    const wrongPaneIo = testIo(root, { kind: 'seat', name: LEAD, pane: OTHER_PANE, session: SESSION });
    expect(await runUp(['--rebind', LEAD], wrongPaneIo, world.sources)).toBe(1);
    expect(seatOf(LEAD)?.agent_session).toBe(INITIAL_SES);
    expect(agentOf(LEAD)?.reach.agent_session).toBe(INITIAL_SES);

    // 3b) Calling lead from another session is refused:
    const wrongSessionIo = testIo(root, { kind: 'seat', name: LEAD, pane: PANE, session: 'other-session' });
    expect(await runUp(['--rebind', LEAD], wrongSessionIo, world.sources)).toBe(1);
    expect(seatOf(LEAD)?.agent_session).toBe(INITIAL_SES);

    // 3c) Unadmitted worker seat (SEAT_ONE) on its own pane cannot invoke --rebind:
    const workerIo = testIo(root, { kind: 'seat', name: SEAT_ONE, pane: OTHER_PANE, session: SESSION });
    expect(await runUp(['--rebind', SEAT_ONE], workerIo, world.sources)).toBe(1);
    expect(seatOf(SEAT_ONE)?.agent_session).toBe(INITIAL_SES);

    // 3d) Incompatible flags (--all, --no-launch, --resolve-launch, --request, --client) exit 2:
    for (const extra of [['--all'], ['--no-launch'], ['--resolve-launch'], ['--request'], ['--client', 'g.json']]) {
      const badIo = testIo(root, { kind: 'owner' });
      expect(await runUp(['--rebind', LEAD, ...extra], badIo, world.sources)).toBe(2);
    }

    // 3e) Undeclared seat name exits 2:
    const unknownSeatIo = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', 'nonexistent-seat'], unknownSeatIo, world.sources)).toBe(2);
  });

  test('Scene 4: pane, CLI, process, socket, inbound, and unstable-conversation proof failures refuse rebind without writing', async () => {
    stand(false);
    recordSeat(LEAD);
    registerSeat(LEAD);
    const socketPath = writeFreshInboundAndSocket(LEAD, 200);

    // 4a) Reused pane reporting another CLI ('codex' instead of 'claude'):
    const worldWrongCli = makeWorld(LEAD, {
      agents: () => [
        { name: LEAD, agent: 'codex', pane: PANE, workspace: SPACE, status: 'working', cwd: root, session: ROTATED_SES },
      ],
    });
    expect(await runUp(['--rebind', LEAD], testIo(root, { kind: 'owner' }), worldWrongCli.sources)).toBe(1);
    expect(seatOf(LEAD)?.agent_session).toBe(INITIAL_SES);

    // 4b) Unproved / replaced process PIDs on the pane:
    const worldReplacedPid = makeWorld(LEAD, {
      processInfo: () => ({ shell: 100, foreground: [999] }),
    });
    expect(await runUp(['--rebind', LEAD], testIo(root, { kind: 'owner' }), worldReplacedPid.sources)).toBe(1);
    expect(seatOf(LEAD)?.agent_session).toBe(INITIAL_SES);

    // 4c) Conversation changes between first and second agent list reads during proof:
    let calls = 0;
    const worldChangingConv = makeWorld(LEAD, {
      agents: () => {
        calls += 1;
        return [
          {
            name: LEAD,
            agent: 'claude',
            pane: PANE,
            workspace: SPACE,
            status: 'working',
            cwd: root,
            session: calls === 1 ? ROTATED_SES : 'ses_raced_03',
          },
        ];
      },
    });
    expect(await runUp(['--rebind', LEAD], testIo(root, { kind: 'owner' }), worldChangingConv.sources)).toBe(1);
    expect(seatOf(LEAD)?.agent_session).toBe(INITIAL_SES);

    // 4d) Stale inbound declaration (older than socket mtime):
    writeFreshInboundAndSocket(LEAD, 200, { staleInbound: true });
    const worldStaleInbound = makeWorld(LEAD);
    expect(await runUp(['--rebind', LEAD], testIo(root, { kind: 'owner' }), worldStaleInbound.sources)).toBe(1);
    expect(seatOf(LEAD)?.agent_session).toBe(INITIAL_SES);

    // 4e) Missing socket file:
    discardFixtures([socketPath], { quiet: true });
    const worldNoSocket = makeWorld(LEAD);
    expect(await runUp(['--rebind', LEAD], testIo(root, { kind: 'owner' }), worldNoSocket.sources)).toBe(1);
    expect(seatOf(LEAD)?.agent_session).toBe(INITIAL_SES);
    expect(agentOf(LEAD)?.reach.agent_session).toBe(INITIAL_SES);
  });

  test('Scene 5: bidirectional CAS fencing refuses --rebind when either registry or state mutates mid-proof', async () => {
    stand(false);
    recordSeat(LEAD);
    registerSeat(LEAD);
    writeFreshInboundAndSocket(LEAD, 200);
    const concurrentSock = writeFreshInboundAndSocket(LEAD, 900);

    // 5a) Registry changes during proveSeatRebind (in processInfo) -> refuses state & registry write:
    const worldRegRace = makeWorld(LEAD, {
      processInfo: () => {
        const current = agentOf(LEAD)!;
        updateAgent(home, current.id, { reach: { address: concurrentSock } });
        return PANE_PROCESSES;
      },
    });
    const regIo = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', LEAD], regIo, worldRegRace.sources)).toBe(1);
    expect(regIo.err).toContain('its state or registry snapshot changed; nothing was rebound');
    expect(seatOf(LEAD)?.agent_session).toBe(INITIAL_SES);
    expect(agentOf(LEAD)?.reach.agent_session).toBe(INITIAL_SES);
    expect(agentOf(LEAD)?.reach.address).toBe(concurrentSock);

    // Reset registry address to null and test 5b) State changes during proveSeatRebind -> refuses registry write:
    updateAgent(home, agentOf(LEAD)!.id, { reach: { address: null } });
    const worldStateRace = makeWorld(LEAD, {
      processInfo: () => {
        updateState(dir, (file) => {
          file.sessions[SESSION]!.seats[LEAD]!.agent_session = 'ses_concurrent_state';
        });
        return PANE_PROCESSES;
      },
    });
    const stateIo = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', LEAD], stateIo, worldStateRace.sources)).toBe(1);
    expect(stateIo.err).toContain('its state or registry snapshot changed; nothing was rebound');
    expect(seatOf(LEAD)?.agent_session).toBe('ses_concurrent_state');
    expect(agentOf(LEAD)?.reach.agent_session).toBe(INITIAL_SES);
  });
});
