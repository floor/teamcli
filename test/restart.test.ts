import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { standingOf } from '../src/caller.ts';
import { runTeamCheck } from '../src/check/team.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { realSources as restartRealSources, runRestart, USAGE, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { noteLaunchedPane } from '../src/file/launched-file.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { seatLockPath } from '../src/launch/seat-lock.ts';
import type { Machine } from '../src/watch/machine.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { RESTART_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { findAgent, readAgents, recordAgentSession, registerAgent } from '../src/registry/agents.ts';
import { setRoster, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { approvalStanding } from '../src/store/store.ts';
import { gateVerdict } from '../src/permissions/who.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

const NOW = new Date('2026-10-16T02:00:00Z');
const IDLE = CLAUDE_IDLE;

const TEAM_YAML = `format: 1
project: acme
coordinator: lead
operator: ops
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

  - role: implementer
    name: parked-seat
    label: parked
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`;

// The live restart reading: the file asks for 0.5 GB free swap, the machine reads 0.4 GB.
const MACHINE_YAML = TEAM_YAML.replace('workspace:\n', 'machine:\n  swap_free_min: 0.5GB\nworkspace:\n');
const ROOMY: Machine = { loadPerCore: 0.4, memoryFree: 62, diskFree: 120e9, swapTotal: 8e9, swapFree: 4e9, swapUsed: 4e9 };
const TIGHT: Machine = { ...ROOMY, swapFree: 0.4e9, swapUsed: 7.6e9 };

type Fixture = {
  base: string;
  root: string;
  home: string;
  file: string;
  dir: string;
  yaml: string;
};

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the real restart launch', () => {
  test('registers a seat inbox with the team file the run read', () => {
    // Without this, a real restart leaves every file-route CLI unregistered: the launch host
    // forwards `registerInbox` only when the launch object defines it.
    expect(typeof restartRealSources.upLaunch.registerInbox).toBe('function');
  });
});

function makeFixture(rawYaml = TEAM_YAML): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-restart-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  const yaml = rawYaml.includes('trust:')
    ? rawYaml
    : rawYaml.replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:\n`);
  const file = join(dir, 'team.yaml');
  writeFileSync(file, yaml);
  return { base, root, home, file, dir, yaml };
}

function makeHarness(
  fixture: Fixture,
  opts: {
    initialRunning?: boolean;
    workerStatus?: string;
    workerScreen?: 'idle' | 'working' | 'permission' | 'unsent' | 'unknown';
    /** The text the unsent box draws, when `workerScreen` is `unsent`. */
    workerDraft?: string;
    /** The relaunched pane never draws the paste: the restore's read-back fails. */
    pasteDrops?: boolean;
    closeFails?: boolean;
    doctorVersion?: string | null;
    machine?: (root: string) => Machine;
  } = {},
): {
  sources: RestartSources;
  did: { typed: string[]; pasted: string[]; closed: string[]; created: number; runs: string[] };
} {
  const did = { typed: [] as string[], pasted: [] as string[], closed: [] as string[], created: 0, runs: [] as string[] };
  let workerAlive = opts.initialRunning ?? true;
  let boxedText = opts.workerScreen === 'unsent' ? claudeBox(opts.workerDraft ?? 'draft') : claudeBox('');
  let shelled = false;
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();

  const currentAgents = (): HerdrAgent[] => {
    const list: HerdrAgent[] = [
      { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: fixture.root },
      { name: 'ops', agent: 'claude-code', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle', cwd: fixture.root },
    ];
    if (workerAlive) {
      list.push({
        name: 'worker',
        agent: 'claude-code',
        pane: 'pane-old',
        workspace: 'ws-old',
        status: opts.workerStatus ?? (opts.workerScreen === 'working' ? 'working' : 'idle'),
        cwd: fixture.root,
      });
    }
    for (const [pane, slot] of newPanes) {
      if (slot.agent) {
        list.push({
          name: slot.name,
          agent: 'claude-code',
          pane,
          workspace: slot.workspace,
          status: 'idle',
          cwd: fixture.root,
        });
      }
    }
    return list;
  };

  const downLaunch: DownLaunch = {
    typeText(_session, _pane, text) {
      did.typed.push(text);
      boxedText = claudeBox(text);
      return true;
    },
    sendKey: () => true,
    pressEnter() {
      shelled = true;
      return true;
    },
    agentPanes: () => currentAgents().map((a) => a.pane),
    closeWorkspace(_session, workspace) {
      if (opts.closeFails) return false;
      did.closed.push(workspace);
      if (workspace === 'ws-old') workerAlive = false;
      return true;
    },
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
      did.created += 1;
      const pane = did.created === 1 ? 'pane-new' : `pane-new-${did.created}`;
      const workspace = did.created === 1 ? 'ws-new' : `ws-new-${did.created}`;
      newPanes.set(pane, { text: IDLE, agent: false, name: null, workspace });
      return { pane, workspace };
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
    closeWorkspace: downLaunch.closeWorkspace,
    agentPanes: () => currentAgents().map((a) => a.pane),
    agents: () => currentAgents(),
    paneText: (_session, pane) => newPanes.get(pane)?.text ?? IDLE,
    // The relaunched seat's own box: a bracketed paste draws its text as the composer rows, so
    // the delivery's read-back verifies exactly as it does on a real CLI.
    typeText(_session, pane, text) {
      did.pasted.push(text);
      const slot = newPanes.get(pane);
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      if (slot && pasted && !opts.pasteDrops) slot.text = claudeBox(pasted[1] ?? '');
      return true;
    },
    pressEnter: () => true,
    agentStatus: () => 'idle',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };

  const doctor: DoctorSources = {
    version: () => (opts.doctorVersion === undefined ? '2.1.288' : opts.doctorVersion),
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home: fixture.home,
  };

  const screenKind = opts.workerScreen ?? 'idle';
  const sources: RestartSources = {
    home: fixture.home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => currentAgents(),
    workspaces: () => currentAgents().map((a) => ({ id: a.workspace })),
    alive: () => true,
    screen: () => {
      if (screenKind === 'working') return { kind: 'working' };
      if (screenKind === 'permission') return { kind: 'permission' };
      if (screenKind === 'unsent') return { kind: 'unsent' };
      if (screenKind === 'unknown') return { kind: 'unknown' };
      return { kind: 'idle' };
    },
    screenText: () => boxedText,
    status: () => opts.workerStatus ?? (screenKind === 'working' ? 'working' : 'idle'),
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : ['claude']),
    now: () => NOW,
    sleep: async () => {},
    launch: downLaunch,
    upLaunch,
    doctor,
    ...(opts.machine ? { machine: opts.machine } : {}),
  };

  return { sources, did };
}

describe('team restart <seat>', () => {
  test('owner restarts a free running seat, prints pre-close facts, updates state, and does not edit team.yaml', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
    });
    const { sources, did } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(did.typed).toEqual(['/exit']);
    expect(did.closed).toEqual(['ws-old']);
    expect(did.created).toBe(1);
    expect(io.out).toContain('worker: input box: empty\n');
    expect(io.out).toContain('worker: turn: not working (free)\n');
    expect(io.out).toContain('worker: context: workspace close ends the pane; relaunch runs "claude --model claude-opus-5-5" in a new workspace without passing the old transcript\n');
    expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
    expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.yaml);

    const after = readState(fixture.dir).sessions.acme?.seats.worker;
    expect(after?.stage).toBe('ready');
    expect(after?.pane).toBe('pane-new');
    expect(after?.id).toBe('seat_0123456789ab');

    const log = readFileSync(join(fixture.dir, 'team.log'), 'utf8');
    expect(log).toContain('restart [owner] restarted worker; pane pane-old -> pane-new\n');
  });

  test('a dev-mode restart records the mark and the caller it admitted', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
    });
    const { sources } = makeHarness(fixture);
    const recorded = () => readAgents(fixture.home).find((agent) => agent.reach.seat === 'worker');

    // A seat the gate refuses, folded into a warning: the restart proceeds, and its registry
    // write says which mode it ran in and who it admitted — not `dev_mode: false`.
    const folded = testIo(fixture.root, { kind: 'seat', name: 'helper', pane: 'pane-helper', session: 'acme' });
    folded.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runRestart(['worker'], folded, sources)).toBe(0);
    expect(folded.err).toBe('team restart: warning: only the owner or `leads` restarts a seat; this call is helper; dev mode continues\n');
    expect(recorded()?.provenance.dev_mode).toBe(true);
    expect(recorded()?.provenance.dev_mode_by).toBe('helper');
  });

  test('a lead\'s restart in force leaves an existing mark, and the owner\'s restart takes it off', async () => {
    /** The worker ready on `pane-old`, its record marked as a folded run wrote it. The lead is
     *  on the roster, as a launched team lists it: the gate reads the record, not the file. */
    function marked(): { fixture: Fixture; sources: RestartSources; recorded(): ReturnType<typeof readAgents>[number] | undefined } {
      const fixture = makeFixture();
      updateState(fixture.dir, (state) => {
        const session = (state.sessions.acme ??= emptySession());
        session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
        session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      });
      const loaded = loadTeamFile(fixture.root, { home: fixture.home });
      if (!loaded.ok) throw new Error('fixture team does not validate');
      const seat = (name: string) => loaded.team.seats.find((item) => item.name === name)!;
      registerLaunch({ home: fixture.home, team: loaded.team, root: fixture.root, by: 'owner' }, seat('lead'), 'pane-lead');
      registerLaunch({ home: fixture.home, team: loaded.team, root: fixture.root, by: 'helper', devMode: true }, seat('worker'), 'pane-old');
      return {
        fixture,
        sources: makeHarness(fixture).sources,
        recorded: () => readAgents(fixture.home).find((agent) => agent.reach.seat === 'worker'),
      };
    }

    // A lead's restart in force is routine: it re-points the record and leaves the mark for the
    // owner. The owner's own restart is the write that answers the finding.
    const byLead = marked();
    const lead = testIo(byLead.fixture.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
    expect(await runRestart(['worker'], lead, byLead.sources)).toBe(0);
    expect(byLead.recorded()?.provenance.dev_mode).toBe(true);
    expect(byLead.recorded()?.provenance.dev_mode_by).toBe('helper');

    const byOwner = marked();
    const owner = testIo(byOwner.fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], owner, byOwner.sources)).toBe(0);
    expect(byOwner.recorded()?.provenance.dev_mode).toBeUndefined();
    expect(byOwner.recorded()?.provenance.dev_mode_by).toBeUndefined();
  });

  test('the lead can restart another seat from its recorded pane, including from the lobby', async () => {
    const fixture = makeFixture();
    const lobby = join(fixture.home, '.config', 'team', 'lobby');
    mkdirSync(join(fixture.home, '.config', 'team'), { recursive: true });
    mkdirSync(lobby, { mode: 0o700 });
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.launched_file = fixture.file;
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      session.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    noteLaunchedPane(fixture.home, fixture.file, 'pane-lead', 'acme');

    const { sources } = makeHarness(fixture);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(lobby, leadCaller);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
  });

  test('the lead can start a seat the file lists and no pane holds', async () => {
    // The check names `team restart <seat>` for a seat that is in the file and not running, so a
    // lead must be able to run it with no record and no agent to stop: the map admits the team's
    // leads, and the seat starts where nothing was closed.
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    });
    const { sources, did } = makeHarness(fixture, { initialRunning: false });
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.root, leadCaller);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(io.out).toContain('team restart: restarted worker; pane none -> pane-new\n');
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(1);
  });

  test('check names the lead for the restart it prints, and the restart gate admits that lead', async () => {
    // The missing-seat line prints `team restart <seat>` with `who: the team's lead`. That is the
    // map's own row (`restart: owner-or-leads`) answered by the function `restart.ts` calls, so a
    // lead must be able to run the line as printed. `team add` is the owner's alone — the owner
    // writes a seat into the file — and the check names it nowhere: the two acts are different
    // rows, and a lead reading the line is handed the one it can run. The team is registered with
    // its roster, the shape a launched team has on this machine, not the file-declaration fallback
    // the test above reads.
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      session.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
    });
    const id = teamIdOf(fixture.root);
    upsertTeam(fixture.home, id, { project: 'acme', session: 'acme', root: fixture.root, at: NOW.toISOString() });
    setRoster(fixture.home, id, [
      { agent: 'agt_000000000000', seat: 'lead', role: 'coordinator', leads: true },
      { agent: 'agt_111111111111', seat: 'ops', role: 'coordinator' },
    ]);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const opsCaller: Caller = { kind: 'seat', name: 'ops', pane: 'pane-ops', session: 'acme' };

    const { sources, did } = makeHarness(fixture, { initialRunning: false });
    const checkIo = testIo(fixture.root, leadCaller);
    const code = runTeamCheck({}, checkIo, {
      live: () => ({
        running: true,
        agents: [
          { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: fixture.root },
          { name: 'ops', agent: 'claude-code', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle', cwd: fixture.root },
        ],
        workspaces: [
          { id: 'ws-lead', label: 'lead' },
          { id: 'ws-ops', label: 'ops' },
        ],
        screens: { 'pane-lead': CLAUDE_IDLE, 'pane-ops': CLAUDE_IDLE },
      }),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, fixture.home),
      now: () => NOW,
      home: fixture.home,
    });
    expect(code).toBe(1);
    expect(checkIo.out).toContain(
      'difference: worker is in the file and is not running\n  repair: team restart worker\n  who: the team\'s lead\n',
    );
    expect(checkIo.out).not.toContain('team add');

    // The gate behind the printed command, in the registry-listed shape: the roster's `leads`
    // mark admits the lead, the map refuses a plain seat, and `team add` stays the owner's.
    const loaded = loadTeamFile(fixture.root, { home: fixture.home });
    if (!loaded.ok) throw new Error('fixture team does not validate');
    const standingOfLead = standingOf(fixture.dir, 'acme', leadCaller);
    const standingOfOps = standingOf(fixture.dir, 'acme', opsCaller);
    expect(gateVerdict(leadCaller, loaded.team, fixture.root, fixture.home, 'restart', standingOfLead, () => NOW)).toEqual({ kind: 'ok' });
    expect(gateVerdict(opsCaller, loaded.team, fixture.root, fixture.home, 'restart', standingOfOps, () => NOW)).toEqual({ kind: 'refused' });
    expect(gateVerdict(leadCaller, loaded.team, fixture.root, fixture.home, 'add', standingOfLead, () => NOW)).toEqual({ kind: 'refused' });
    expect(gateVerdict({ kind: 'owner' }, loaded.team, fixture.root, fixture.home, 'add', { session: 'acme' }, () => NOW)).toEqual({ kind: 'ok' });

    // And the lead runs the line as printed: the seat starts where nothing was closed.
    const io = testIo(fixture.root, leadCaller);
    expect(await runRestart(['worker'], io, sources)).toBe(0);
    expect(io.out).toContain('team restart: restarted worker; pane none -> pane-new\n');
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(1);
  });

  test('refuses self-restart from a seat caller', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    });
    const { sources, did } = makeHarness(fixture);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.root, leadCaller);

    const code = await runRestart(['lead'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe('team restart: the lead cannot restart its own recorded pane; another `leads` seat (or the owner) restarts it\n');
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
  });

  test('a lead --abandon closes a blocked non-lead seat, but refuses a working seat or a lead seat; a plain seat is refused by the map', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };

    // 1. Refuses --abandon on the operator's seat: the map admits the lead, and the abandon rule
    //    keeps a seat caller off the orchestrator's and the operator's seat.
    const leadRun = makeHarness(fixture, { workerScreen: 'permission' });
    const ioLead = testIo(fixture.root, leadCaller);
    expect(await runRestart(['ops', '--abandon'], ioLead, leadRun.sources)).toBe(1);
    expect(ioLead.err).toContain("does not abandon the orchestrator's or the operator's seat");

    // 2. Refuses --abandon on a working seat from a lead caller
    const workingRun = makeHarness(fixture, { workerScreen: 'working', workerStatus: 'working' });
    const ioWorking = testIo(fixture.root, leadCaller);
    expect(await runRestart(['worker', '--abandon'], ioWorking, workingRun.sources)).toBe(1);
    expect(ioWorking.err).toBe("team restart: worker is working; a seat's --abandon leaves it (the owner's --abandon closes it)\n");
    expect(workingRun.did.closed).toEqual([]);

    // 3. Succeeds with --abandon on a blocked seat from a lead caller without typing
    const blockedRun = makeHarness(fixture, { workerScreen: 'permission', workerStatus: 'blocked' });
    const ioBlocked = testIo(fixture.root, leadCaller);
    expect(await runRestart(['worker', '--abandon'], ioBlocked, blockedRun.sources)).toBe(0);
    expect(blockedRun.did.typed).toEqual([]);
    expect(blockedRun.did.closed).toEqual(['ws-old']);
    expect(ioBlocked.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');

    // 4. A plain seat of the team is refused by the map's `restart` row before any of that: it
    //    admits the owner and the team's `leads`, and `ops` holds no `leads`.
    const opsRun = makeHarness(fixture);
    const ioOps = testIo(fixture.root, { kind: 'seat', name: 'ops', pane: 'pane-ops', session: 'acme' });
    expect(await runRestart(['worker'], ioOps, opsRun.sources)).toBe(1);
    expect(ioOps.err).toBe('team restart: only the owner or `leads` restarts a seat; this call is ops\n');
    expect(opsRun.did.closed).toEqual([]);
  });

  test('a seat holding unsent text is restarted: the text is copied, the pane closed without typing, and the text pasted back', async () => {
    const fixture = makeFixture();
    const busyRun = makeHarness(fixture, { workerScreen: 'unsent' });
    const ioBusy = testIo(fixture.root, { kind: 'owner' });
    const copy = join(fixture.dir, 'restart-drafts', 'acme', 'worker.draft');
    expect(await runRestart(['worker'], ioBusy, busyRun.sources)).toBe(0);
    // Nothing was typed into the old box: the workspace closed, and the paste went to the new
    // pane only after it was ready.
    expect(busyRun.did.typed).toEqual([]);
    expect(busyRun.did.closed).toEqual(['ws-old']);
    expect(busyRun.did.created).toBe(1);
    expect(busyRun.did.pasted).toEqual(['\x1b[200~draft\x1b[201~']);
    expect(existsSync(copy)).toBe(false);
    expect(ioBusy.out).toContain(`worker: input box: holds unsent text, copied to ${copy} and pasted back once the new pane is ready\n`);
    expect(ioBusy.out).toContain('worker: unsent text pasted back\n');
    expect(ioBusy.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
    expect(readFileSync(join(fixture.dir, 'team.log'), 'utf8')).toContain('restart [owner] worker: unsent text pasted back\n');

    // Preflight doctor failure leaves the running seat untouched
    const docRun = makeHarness(fixture, { doctorVersion: null });
    const ioDoc = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioDoc, docRun.sources)).toBe(1);
    expect(docRun.did.typed).toEqual([]);
    expect(docRun.did.closed).toEqual([]);
    expect(docRun.did.created).toBe(0);
  });

  test('a multi-line unsent draft is refused: its rows cannot be told from a soft wrap', async () => {
    const fixture = makeFixture();
    // The box draws the draft's rows at its own indent, exactly as a one-line draft the composer
    // word-wrapped would draw: the screen cannot say which break is a newline, so nothing is
    // copied and the pane is left as it is.
    const draft = 'first line\nsecond line\n\nfourth line';
    const run = makeHarness(fixture, { workerScreen: 'unsent', workerDraft: draft });
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], io, run.sources)).toBe(1);
    expect(io.err).toBe('team restart: worker holds unsent text in its input box over more than one drawn row, where a soft wrap cannot be told from a newline; left as it is (the owner clears it in its pane, or team restart worker --abandon closes it)\n');
    expect(run.did.closed).toEqual([]);
    expect(run.did.created).toBe(0);
    expect(run.did.pasted).toEqual([]);
    expect(existsSync(join(fixture.dir, 'restart-drafts', 'acme', 'worker.draft'))).toBe(false);
  });

  test('a draft that cannot be copied faithfully still refuses the restart, and nothing is closed', async () => {
    const fixture = makeFixture();
    const chip = makeHarness(fixture, { workerScreen: 'unsent', workerDraft: '[Pasted text #2 +7 lines]' });
    const ioChip = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioChip, chip.sources)).toBe(1);
    expect(ioChip.err).toBe('team restart: worker holds unsent text in its input box behind a paste chip; left as it is (the owner clears it in its pane, or team restart worker --abandon closes it)\n');
    expect(chip.did.closed).toEqual([]);
    expect(chip.did.created).toBe(0);

    // A seat herdr reports mid-turn keeps the old word: its turn is not the restart's to end.
    const working = makeHarness(fixture, { workerScreen: 'unsent', workerStatus: 'working' });
    const ioWorking = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioWorking, working.sources)).toBe(1);
    expect(ioWorking.err).toBe('team restart: worker holds unsent text in its input box; left as it is\n');
    expect(working.did.closed).toEqual([]);
  });

  test('an earlier copy with different text is never overwritten: the restart refuses and the old copy keeps its words', async () => {
    const fixture = makeFixture();
    const copy = join(fixture.dir, 'restart-drafts', 'acme', 'worker.draft');
    mkdirSync(join(fixture.dir, 'restart-drafts', 'acme'), { recursive: true });
    writeFileSync(copy, 'older unsent text');
    const run = makeHarness(fixture, { workerScreen: 'unsent' });
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], io, run.sources)).toBe(1);
    expect(io.err).toBe(`team restart: worker holds unsent text and a different copy already sits at ${copy}; left as it is\n`);
    expect(readFileSync(copy, 'utf8')).toBe('older unsent text');
    expect(run.did.closed).toEqual([]);
  });

  test('a paste the new pane never draws back is named, and its copy stays', async () => {
    const fixture = makeFixture();
    const run = makeHarness(fixture, { workerScreen: 'unsent', pasteDrops: true });
    const io = testIo(fixture.root, { kind: 'owner' });
    const copy = join(fixture.dir, 'restart-drafts', 'acme', 'worker.draft');
    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(existsSync(copy)).toBe(true);
    expect(readFileSync(copy, 'utf8')).toBe('draft');
    expect(io.out).toContain(`worker: the unsent text could not be pasted back (the pasted text did not read back as its rows); its copy is at ${copy}\n`);
    expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
  });

  test('refuses a busy seat without --abandon, and refuses when preflight fails before stopping the seat', async () => {
    const fixture = makeFixture();
    const busyRun = makeHarness(fixture, { workerScreen: 'permission', workerStatus: 'blocked' });
    const ioBusy = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioBusy, busyRun.sources)).toBe(1);
    expect(ioBusy.err).toBe('team restart: worker is blocked at a prompt, which team never answers; left as it is\n');
    expect(busyRun.did.closed).toEqual([]);

    // Preflight doctor failure leaves the running seat untouched
    const docRun = makeHarness(fixture, { doctorVersion: null });
    const ioDoc = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioDoc, docRun.sources)).toBe(1);
    expect(docRun.did.typed).toEqual([]);
    expect(docRun.did.closed).toEqual([]);
    expect(docRun.did.created).toBe(0);
  });

  test('never launches beside a pane that failed to close or holds a replaced process', async () => {
    const fixture = makeFixture();
    const closeFail = makeHarness(fixture, { closeFails: true });
    const ioClose = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioClose, closeFail.sources)).toBe(1);
    expect(closeFail.did.created).toBe(0);

    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = {
        stage: 'ready',
        pane: 'pane-old',
        workspace: 'ws-old',
        launched: { shell: 100, cli: [200] },
      };
    });
    const replaced = makeHarness(fixture);
    replaced.sources.upLaunch.processInfo = () => ({ shell: 100, foreground: [999] });
    const ioReplaced = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioReplaced, replaced.sources)).toBe(1);
    expect(ioReplaced.err).toBe('team restart: worker has a process in its old pane that is not the signed seat; left as it is\n');
    expect(replaced.did.closed).toEqual([]);
    expect(replaced.did.created).toBe(0);
  });

  test('refuses unknown, temporary, signed-off seats, and held run-lock; supports --dry-run', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats['worker-tmp-1'] = { stage: 'ready', temporary: { like: 'worker', until: 'result:out.md' } };
    });
    const { sources, did } = makeHarness(fixture);

    const ioUnknown = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['no-such-seat'], ioUnknown, sources)).toBe(1);
    expect(ioUnknown.err).toBe('team restart: no-such-seat is not a signed declared seat\n');

    const ioTemp = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker-tmp-1'], ioTemp, sources)).toBe(1);
    expect(ioTemp.err).toBe('team restart: worker-tmp-1 is a temporary copy; use team remove worker-tmp-1 then team add --temporary --like worker\n');

    const ioStopped = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['parked-seat'], ioStopped, sources)).toBe(1);
    expect(ioStopped.err).toBe('team restart: parked-seat is signed off; the owner takes the sign-off off in the file and runs team up\n');

    // Dry run
    const ioDry = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker', '--dry-run'], ioDry, sources)).toBe(0);
    expect(ioDry.out).toContain('stop worker in pane-old (free)\n');
    expect(ioDry.out).toContain('dry run: nothing was run\n');
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);

    // Run lock held
    mkdirSync(join(fixture.dir, 'seat-locks', 'acme'), { recursive: true });
    writeFileSync(seatLockPath(fixture.dir, 'acme', '.run'), `${process.pid} 0a1b2c3d\n`);
    const ioLocked = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioLocked, sources)).toBe(1);
    expect(ioLocked.err).toContain('another session-mutating run is holding');
  });

  test('an unread screen on a seat herdr calls idle does not block a lead: closed without typing, then restarted', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    });
    const { sources, did } = makeHarness(fixture, { workerScreen: 'unknown' });
    const io = testIo(fixture.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
    const code = await runRestart(['worker'], io, sources);
    expect(code, io.err).toBe(0);
    // The workspace is closed without a typed exit: the screen is not recognised.
    expect(did.typed).toEqual([]);
    expect(did.closed).toEqual(['ws-old']);
    expect(did.created).toBe(1);
    expect(io.out).toContain('worker: input box: not read (the screen is not recognised)\n');
    expect(io.out).toContain('worker: screen: not recognised; herdr reports it idle; the workspace is closed without typing into it\n');
    expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
    expect(readState(fixture.dir).sessions.acme?.seats.worker?.pane).toBe('pane-new');
  });

  test('a dry run on an unread screen says how the workspace is closed', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const { sources, did } = makeHarness(fixture, { workerScreen: 'unknown' });
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker', '--dry-run'], io, sources)).toBe(0);
    expect(io.out).toContain('stop worker in pane-old (unknown)\n');
    expect(io.out).toContain('worker: screen: not recognised; herdr reports it idle; the workspace is closed without typing into it\n');
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
  });

  test('--json: a restarted seat is the team.restart document, its working lines collapsed to notes', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
    });
    const { sources } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker', '--json'], io, sources)).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{
      schema: { name: string; version: number };
      format: number;
      dry_run: boolean;
      status: string;
      action_summary: string;
      project: string;
      session: string;
      seat: string;
      pane: string | null;
      notes: string[];
    }>(io.out, RESTART_OUTPUT_SCHEMA);
    expect(doc.schema).toEqual({ name: 'team.restart', version: 1 });
    expect(doc).toMatchObject({
      format: 1,
      dry_run: false,
      status: 'ready',
      action_summary: 'team restart: restarted worker; pane pane-old -> pane-new',
      project: 'acme',
      seat: 'worker',
      pane: 'pane-new',
    });
    expect(doc.notes).toContain('worker: input box: empty');
    expect(doc.notes).toContain('worker: turn: not working (free)');
    expect(io.out).not.toContain('worker: input box: empty\n');
  });

  test('--json --dry-run: the plan carries the stop then the launch, and nothing is run', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
    });
    const { sources, did } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker', '--dry-run', '--json'], io, sources)).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{
      dry_run: boolean;
      status: string;
      action_summary: string;
      seat: string;
      plan: { step: string; detail: string; seat?: string; prefix?: string }[];
    }>(io.out, RESTART_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({
      dry_run: true,
      status: 'dry-run',
      action_summary: 'dry run: nothing was run',
      seat: 'worker',
    });
    expect(doc.plan[0]).toEqual({
      step: 'stop',
      seat: 'worker',
      detail: 'stop worker in pane-old (free)',
      prefix: '+',
    });
    expect(doc.plan.some((step) => step.step === 'launch' && step.seat === 'worker')).toBe(true);
    expect(did.typed).toEqual([]);
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
  });

  test('the same unread screen with herdr reporting a turn stays a refusal', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const { sources, did } = makeHarness(fixture, { workerScreen: 'unknown', workerStatus: 'working' });
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], io, sources)).toBe(1);
    expect(io.err).toBe('team restart: worker shows a screen the profile does not recognise; left as it is (team restart worker --abandon closes its workspace without typing)\n');
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
  });

  test('--json: a dev-mode warning is a note, on the plan and on the real run, and stdout is the document alone', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
    });
    const { sources } = makeHarness(fixture);
    const warning = 'warning: only the owner or `leads` restarts a seat; this call is helper; dev mode continues';

    // The dry answer is the document: the warning rides in its notes, never in front of it.
    const dry = testIo(fixture.root, { kind: 'seat', name: 'helper', pane: 'pane-helper', session: 'acme' });
    dry.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runRestart(['worker', '--dry-run', '--json'], dry, sources)).toBe(0);
    expect(dry.err).toBe('');
    const dryDoc = JSON.parse(dry.out) as { status: string; notes: string[] };
    expect(dryDoc.status).toBe('dry-run');
    expect(dryDoc.notes).toContain(warning);
    expect(dry.out.startsWith('{')).toBe(true);

    // The real run's terminal line carried the command's name; the document's note does not.
    const real = testIo(fixture.root, { kind: 'seat', name: 'helper', pane: 'pane-helper', session: 'acme' });
    real.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runRestart(['worker', '--json'], real, sources)).toBe(0);
    expect(real.err).toBe('');
    const realDoc = JSON.parse(real.out) as { status: string; notes: string[] };
    expect(realDoc.status).toBe('ready');
    expect(realDoc.notes).toContain(warning);
    expect(realDoc.notes.some((note) => note.startsWith('team restart:'))).toBe(false);
  });

  test('--json: the owner-or-leads repair names the owner\'s command without this run\'s --json', async () => {
    const fixture = makeFixture();
    const { sources } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'seat', name: 'helper', pane: 'pane-helper', session: 'acme' });

    expect(await runRestart(['worker', '--json'], io, sources)).toBe(1);
    expect(io.err).toBe('');
    const doc = assertJsonErrorShape(io.out, { id: 'restart.caller', messageContains: 'only the owner or `leads` restarts a seat' });
    expect(doc.error.repair).toContain('`team restart worker`');
    expect(doc.error.repair).not.toContain('--json');

    // The dry answer's line is the same command, without the dry run's own flag.
    const dry = testIo(fixture.root, { kind: 'seat', name: 'helper', pane: 'pane-helper', session: 'acme' });
    expect(await runRestart(['worker', '--dry-run'], dry, sources)).toBe(1);
    expect(dry.out).toContain('! to unblock: a `leads` seat runs `team restart worker`');
    expect(dry.out).not.toContain('--dry-run`');
  });

  test('--json: a refusal is the team.error document and leaves stderr empty', async () => {
    const fixture = makeFixture();
    const { sources } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['no-such-seat', '--json'], io, sources)).toBe(1);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, {
      id: 'restart.unknown',
      messageContains: 'no-such-seat is not a signed declared seat',
      repair: 'team seats lists the seats the file declares',
    });
  });

  test('--json: a bad invocation is the usage row, without the usage text in the document', async () => {
    const fixture = makeFixture();
    const { sources } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['--json'], io, sources)).toBe(2);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, { id: 'restart.usage', messageContains: 'a seat name is required' });
    expect(io.out).not.toContain('Usage:');
    expect(USAGE).toContain('Exits 0 when the seat is restarted');
  });
});

// ---- the seat's own recorded conversation ---------------------------------------------------
//
// The resume id comes from the two team-owned records agreeing — the agent registry's
// `reach.agent_session` and the seat state's own — bound to this team, seat, agent, CLI and
// herdr session. A record that does not agree is never resumed: the restart says why and
// launches fresh, exactly as it did before the records were read.
describe('team restart resumes the seat\'s own recorded session', () => {
  function seeded(opts: { registry?: string; state?: string; cli?: string } = {}) {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = {
        stage: 'ready',
        pane: 'pane-old',
        workspace: 'ws-old',
        id: 'seat_0123456789ab',
        ...(opts.state === undefined ? {} : { agent_session: opts.state }),
      };
    });
    let agentId: string | undefined;
    if (opts.registry !== undefined) {
      agentId = registerAgent(fixture.home, {
        name: 'worker',
        signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
        lab: 'anthropic',
        cli: opts.cli ?? 'claude-code',
        launcher: null,
        launch: 'claude --model claude-opus-5-5',
        reach: {
          team: teamIdOf(fixture.root),
          seat: 'worker',
          session: 'acme',
          pane: 'pane-old',
          address: null,
          agent_session: opts.registry,
        },
        seat_handle: 'seat_0123456789ab',
        mcp: [],
        skills: [],
        lifecycle: 'running',
        by: 'team up',
      }).id;
    }
    return { fixture, run: makeHarness(fixture), agentId };
  }

  test('both records agreeing on one id resume it on the new declaration', async () => {
    const { fixture, run } = seeded({ registry: 'ses_keep', state: 'ses_keep' });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.runs.join('\n')).toContain('claude --model claude-opus-5-5 --resume ses_keep');
    expect(io.err).toBe('');
    const log = readFileSync(join(fixture.dir, 'team.log'), 'utf8');
    expect(log).toContain('worker: resuming session ses_keep on the new declaration');
    // The relaunch's herdr reading carried no id here: the registry keeps the one it held rather
    // than clearing it, so the next restart can still bind the conversation.
    expect(findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })?.reach.agent_session).toBe('ses_keep');
  });

  test('a state naming another session is never resumed, and the run says why', async () => {
    const { fixture, run } = seeded({ registry: 'ses_keep', state: 'ses_other' });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.runs.join('\n')).not.toContain('--resume');
    expect(io.err).toContain('team restart: worker: not resuming its recorded session (the seat state and the agent record name different sessions)');
    const log = readFileSync(join(fixture.dir, 'team.log'), 'utf8');
    expect(log).toContain('worker: not resuming its recorded session (the seat state and the agent record name different sessions)');
  });

  test('a record written by another CLI is not resumed', async () => {
    const { fixture, run } = seeded({ registry: 'ses_keep', state: 'ses_keep', cli: 'codex' });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.runs.join('\n')).not.toContain('--resume');
    expect(io.err).toContain('worker: not resuming its recorded session (the record ran codex, the seat now declares claude-code)');
  });

  test('a live pane running another conversation is never resumed', async () => {
    const { fixture, run } = seeded({ registry: 'ses_keep', state: 'ses_keep' });
    // The pane on the recorded endpoint says it is running a different conversation: resuming the
    // recorded one would put two live copies of the seat's history beside each other.
    const listed = run.sources.agents;
    run.sources.agents = (session) => (listed(session) ?? []).map((agent) => (
      agent.name === 'worker' && agent.pane === 'pane-old' ? { ...agent, session: 'ses_live' } : agent
    ));
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.runs.join('\n')).not.toContain('--resume');
    expect(io.err).toContain('worker: not resuming its recorded session (its live agent session is not the recorded one)');
  });

  test('a record that changes between the caller\'s read and the run lock is not resumed', async () => {
    const { fixture, run, agentId } = seeded({ registry: 'ses_keep', state: 'ses_keep' });
    // A concurrent writer lands a new conversation after the caller's own read: the state and the
    // registry now agree on another id. The run lock serializes the restart, and the binding is
    // read again under it, so what launches is the fresh conversation the records now name — never
    // the id the caller saw a moment before. The writer lands on the run's second listing, after
    // the caller's read and before the run lock's own.
    const listed = run.sources.agents;
    let calls = 0;
    let moved = false;
    run.sources.agents = (session) => {
      calls += 1;
      if (calls === 2) {
        moved = true;
        updateState(fixture.dir, (state) => {
          const seat = state.sessions.acme?.seats.worker;
          if (seat) seat.agent_session = 'ses_new';
        });
        recordAgentSession(fixture.home, agentId!, 'ses_new');
      }
      return listed(session);
    };
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(moved).toBe(true);
    expect(run.did.runs.join('\n')).not.toContain('--resume');
    expect(io.err).toContain('worker: not resuming its recorded session (the seat record changed before the launch)');
  });

  test('a dry run prints the resume the launch would use, and writes no log line', async () => {
    const { fixture, run } = seeded({ registry: 'ses_keep', state: 'ses_keep' });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker', '--dry-run'], io, run.sources)).toBe(0);
    expect(io.out).toContain('--resume ses_keep');
    expect(io.out).toContain('dry run: nothing was run');
    const logged = existsSync(join(fixture.dir, 'team.log')) ? readFileSync(join(fixture.dir, 'team.log'), 'utf8') : '';
    expect(logged).not.toContain('resuming session');
    expect(run.did.created).toBe(0);
  });
});

describe('team restart machine atomicity', () => {
  test('a machine refusal under the run lock leaves the running seat and its pane untouched', async () => {
    const fixture = makeFixture(MACHINE_YAML);
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    // The live shape: the preflight reading passes, and by the time the run holds the lock
    // the machine reads 0.4 GB free swap where the file asks 0.5 GB. The refusal must land
    // before the stop, so the seat keeps its pane and nothing is typed, closed or created.
    const readings = [ROOMY, TIGHT];
    let calls = 0;
    const { sources, did } = makeHarness(fixture, {
      machine: () => readings[Math.min(calls++, readings.length - 1)]!,
    });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, sources)).toBe(1);
    expect(io.err).toBe('team restart: free swap is 0.4 GB, below 0.5 GB\n');
    expect(calls).toBe(2);
    expect(did.typed).toEqual([]);
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
    expect(did.runs).toEqual([]);
    const after = readState(fixture.dir).sessions.acme?.seats.worker;
    expect(after?.stage).toBe('ready');
    expect(after?.pane).toBe('pane-old');
  });

  test('a reading that goes bad after the stop is never taken, so the stopped seat is not stranded', async () => {
    const fixture = makeFixture(MACHINE_YAML);
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    // The reading is honest up to the stop and bad after it: the old workspace is closed and the
    // machine now reads 0.4 GB free swap. The launch takes no reading after the stop, so the
    // decision made before it stands and the seat comes back up.
    const reads: number[] = [];
    const { sources, did } = makeHarness(fixture, {
      machine: () => {
        reads.push(did.closed.length);
        return did.closed.length === 0 ? ROOMY : TIGHT;
      },
    });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, sources), io.err).toBe(0);
    // Both readings were taken while the old workspace was still open; none after the close.
    expect(reads).toEqual([0, 0]);
    expect(did.closed).toEqual(['ws-old']);
    expect(did.created).toBe(1);
    expect(did.runs.join('\n')).toContain('claude --model claude-opus-5-5');
    const after = readState(fixture.dir).sessions.acme?.seats.worker;
    expect(after?.stage).toBe('ready');
    expect(after?.pane).toBe('pane-new');
  });
});
