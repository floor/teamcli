import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { noteLaunchedPane } from '../src/file/launched-file.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { seatLockPath } from '../src/launch/seat-lock.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { readAgents } from '../src/registry/agents.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

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
    closeFails?: boolean;
    doctorVersion?: string | null;
  } = {},
): {
  sources: RestartSources;
  did: { typed: string[]; closed: string[]; created: number; runs: string[] };
} {
  const did = { typed: [] as string[], closed: [] as string[], created: 0, runs: [] as string[] };
  let workerAlive = opts.initialRunning ?? true;
  let boxedText = opts.workerScreen === 'unsent' ? claudeBox('draft') : claudeBox('');
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
    expect(io.err).toBe('team restart: the lead cannot restart its own recorded pane; the owner must do it\n');
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

  test('refuses a busy seat without --abandon, and refuses when preflight fails before stopping the seat', async () => {
    const fixture = makeFixture();
    const busyRun = makeHarness(fixture, { workerScreen: 'unsent' });
    const ioBusy = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioBusy, busyRun.sources)).toBe(1);
    expect(ioBusy.err).toBe('team restart: worker holds unsent text in its input box; left as it is\n');
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
    expect(ioStopped.err).toBe('team restart: parked-seat is signed off; the owner approves the seat back and runs team up\n');

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
});
