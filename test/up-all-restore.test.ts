// C7.5 item 9: `team up --all` runs the restore pass across every registered team whose session
// is running in the terminal host with recorded seats, in parent-first then session order,
// isolating per-team failures and refusing a false all-clear when no session is running.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { readChildMessage, readHostMessage } from '../src/daemon/chores/protocol.ts';
import { daemonLogPath } from '../src/daemon/paths.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { answerDaemonRequest, parseDaemonRequest } from '../src/daemon/protocol.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, SessionState } from '../src/herdr.ts';
import { acquireRunLock } from '../src/launch/run-lock.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T04:15:00Z');
const IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol')
  .replace('GPT-5.6-Terra', 'GPT-6.1-Sol');

const LAUNCHED_PIDS = { shell: 100, cli: [200] };
const RESTORED_PIDS = { shell: 301, foreground: [401] };

type TeamFixture = {
  project: string;
  session: string;
  root: string;
  dir: string;
  lobby: string;
  lead: string;
  operator: string;
  worker: string;
  pane: string;
  workspace: string;
  sessionId: string;
};

let base: string;
let home: string;
let neutralCwd: string;
let mainTeam: TeamFixture;
let alphaTeam: TeamFixture;
let betaTeam: TeamFixture;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv(),
  });
}

function teamYaml(fixture: TeamFixture): string {
  return `format: 1
project: ${fixture.project}
coordinator: ${fixture.lead}
operator: ${fixture.operator}
session: ${fixture.session}
trust:
  - ${fixture.lobby}
  - ${fixture.root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${fixture.lead}
    label: ${fixture.lead}
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
    leads: true
  - role: operator
    name: ${fixture.operator}
    label: ${fixture.operator}
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
    human: true
  - role: implementer
    name: ${fixture.worker}
    label: ${fixture.worker}
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
    stopped: true
`;
}

function createTeamFixture(spec: {
  project: string;
  session: string;
  root: string;
  pane: string;
  workspace: string;
  sessionId: string;
}): TeamFixture {
  const dir = join(spec.root, '.agents');
  const lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  git(spec.root, 'init', '-q', '-b', 'main');
  writeFileSync(join(spec.root, 'README.md'), `${spec.project}\n`);
  git(spec.root, 'add', 'README.md');
  git(spec.root, 'commit', '-q', '-m', 'init');

  const fixture: TeamFixture = {
    ...spec,
    dir,
    lobby,
    lead: 'lead-1',
    operator: 'op-1',
    worker: 'worker-1',
  };
  const yaml = teamYaml(fixture);
  const filePath = join(dir, 'team.yaml');
  writeFileSync(filePath, yaml);
  const loaded = loadTeamFile(spec.root, { file: filePath, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: yaml },
    loaded.team.seats,
    home,
  );
  const teamId = teamIdOf(fixture.root);
  updateState(dir, (state) => {
    const s = (state.sessions[fixture.session] ??= emptySession());
    s.seats[fixture.lead] = {
      id: `seat_${teamId}`,
      stage: 'ready',
      pane: fixture.pane,
      workspace: fixture.workspace,
      launched: LAUNCHED_PIDS,
      agent_session: fixture.sessionId,
    };
    s.seats[fixture.operator] = {
      id: `seat_${teamId.slice(0, 11)}f`,
      stage: 'ready',
      pane: `${fixture.workspace}:p2`,
      workspace: fixture.workspace,
    };
  });
  registerAgent(home, {
    name: fixture.lead,
    signing: { model: 'GPT Sol', version: '6.1', role: 'coordinator' },
    lab: 'openai',
    cli: 'codex',
    launcher: null,
    launch: 'codex -m gpt-6.1-sol',
    reach: {
      team: teamId,
      seat: fixture.lead,
      session: fixture.session,
      pane: fixture.pane,
      address: null,
      agent_session: fixture.sessionId,
    },
    seat_handle: `seat_${teamId}`,
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  upsertTeam(home, teamIdOf(fixture.root), {
    project: fixture.project,
    entity: null,
    session: fixture.session,
    root: fixture.root,
    lobby: fixture.lobby,
    lobbies: { [fixture.session]: fixture.lobby },
    roster: [
      { agent: `ag_${fixture.session}_lead`, seat: fixture.lead, role: 'coordinator', leads: true },
      { agent: `ag_${fixture.session}_op`, seat: fixture.operator, role: 'operator' },
      { agent: `ag_${fixture.session}_worker`, seat: fixture.worker, role: 'implementer' },
    ],
    lifecycle: 'running',
    by: 'team up',
    at: NOW.toISOString(),
  });
  return fixture;
}

type MultiTrace = {
  renamedBySession: { session: string; pane: string; name: string }[];
  reportedBySession: { session: string; pane: string; text: string }[];
};

function buildMultiSources(options: {
  sessionStates?: Record<string, SessionState | null>;
  liveSessionIds?: Record<string, string>;
  namedOnPane?: Record<string, string | null>;
  hostDown?: boolean;
} = {}): { sources: UpSources; trace: MultiTrace } {
  const trace: MultiTrace = { renamedBySession: [], reportedBySession: [] };
  const fixturesBySession = new Map<string, TeamFixture>([
    [mainTeam.session, mainTeam],
    [alphaTeam.session, alphaTeam],
    [betaTeam.session, betaTeam],
  ]);

  const sessionState = (session: string): SessionState | null => {
    if (options.hostDown) return null;
    if (options.sessionStates && session in options.sessionStates) {
      return options.sessionStates[session]!;
    }
    return fixturesBySession.has(session) ? 'running' : 'absent';
  };

  const agents = (session: string): HerdrAgent[] | null => {
    if (options.hostDown) return null;
    const fixture = fixturesBySession.get(session);
    if (!fixture || sessionState(session) !== 'running') return [];
    const name = options.namedOnPane && session in options.namedOnPane
      ? options.namedOnPane[session]!
      : null;
    return [
      {
        name,
        agent: 'codex',
        pane: fixture.pane,
        workspace: fixture.workspace,
        status: 'idle',
        cwd: fixture.root,
        session: options.liveSessionIds?.[session] ?? fixture.sessionId,
      },
    ];
  };

  const launch: Launch = {
    sessionState,
    startServer: () => true,
    sessionUp: (session) => {
      const st = sessionState(session);
      return st === null ? null : st === 'running';
    },
    createWorkspace: (_session, _cwd, label) => ({ pane: `new-${label}`, workspace: `ws-${label}` }),
    paneRun: () => true,
    typeText: () => true,
    renameWorkspace: () => true,
    reportDisplayAgent(session, pane, text) {
      trace.reportedBySession.push({ session, pane, text });
      return true;
    },
    renameAgent(session, pane, name) {
      trace.renamedBySession.push({ session, pane, name });
      return true;
    },
    closeWorkspace: () => true,
    agentPanes: (session) => (agents(session) ?? []).map((a) => a.pane),
    agents,
    paneText: () => IDLE,
    foreground: () => ['codex'],
    processInfo: () => RESTORED_PIDS,
    sleep: async () => {},
    now: () => NOW,
  };

  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => !options.hostDown,
    now: () => NOW,
    home,
  };

  return {
    sources: {
      sessionRunning: (session) => {
        const st = sessionState(session);
        return st === null ? null : st === 'running';
      },
      sessionState,
      agents,
      workspaces: (session) => {
        const f = fixturesBySession.get(session);
        return f ? [{ id: f.workspace, label: f.lead }] : [];
      },
      home,
      doctor,
      launch,
      now: () => NOW,
    },
    trace,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-all-restore-')));
  home = join(base, 'home');
  neutralCwd = join(base, 'neutral-lobby');
  mkdirSync(home, { recursive: true });
  mkdirSync(neutralCwd, { recursive: true });

  const parentRoot = join(base, 'workspace');
  const alphaRoot = join(parentRoot, 'alpha');
  const betaRoot = join(parentRoot, 'beta');

  // Register beta, then alpha, then main-team, plus a stale scratch entry whose root is gone.
  betaTeam = createTeamFixture({
    project: 'beta',
    session: 'beta',
    root: betaRoot,
    pane: 'w-beta:p1',
    workspace: 'w-beta',
    sessionId: 'ses_beta',
  });
  alphaTeam = createTeamFixture({
    project: 'alpha',
    session: 'alpha',
    root: alphaRoot,
    pane: 'w-alpha:p1',
    workspace: 'w-alpha',
    sessionId: 'ses_alpha',
  });
  mainTeam = createTeamFixture({
    project: 'main-team',
    session: 'main-team',
    root: parentRoot,
    pane: 'w-main:p1',
    workspace: 'w-main',
    sessionId: 'ses_main',
  });
  upsertTeam(home, '000000000001', {
    project: 'stale-scratch',
    entity: null,
    session: 'stale-scratch',
    root: join(base, 'missing-tmp-scratch'),
    lobby: join(home, '.config', 'team', 'lobby'),
    roster: [{ agent: 'ag_stale', seat: 'lead-1', role: 'coordinator', leads: true }],
    lifecycle: 'running',
    by: 'team up',
    at: NOW.toISOString(),
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('team up --all single-command multi-team restore', () => {
  test('sweeps running registered teams in parent-first then session order and skips inactive roots', async () => {
    const { sources, trace } = buildMultiSources();
    const io = testIo(neutralCwd, { kind: 'owner' });

    const code = await runUp(['--all'], io, sources);
    expect(code).toBe(0);

    // Parent root (main-team) restores first, then alpha, then beta; stale-scratch is skipped.
    expect(trace.renamedBySession).toEqual([
      { session: 'main-team', pane: 'w-main:p1', name: 'lead-1' },
      { session: 'alpha', pane: 'w-alpha:p1', name: 'lead-1' },
      { session: 'beta', pane: 'w-beta:p1', name: 'lead-1' },
    ]);

    for (const fixture of [mainTeam, alphaTeam, betaTeam]) {
      const seat = readState(fixture.dir).sessions[fixture.session]?.seats[fixture.lead];
      expect(seat?.stage).toBe('ready');
      expect(seat?.launched).toEqual({ shell: RESTORED_PIDS.shell, cli: RESTORED_PIDS.foreground });
    }

    expect(io.err).toContain('main-team (session main-team):');
    expect(io.err).toContain('alpha (session alpha):');
    expect(io.err).toContain('beta (session beta):');
    expect(io.err).toContain('all teams: 3 teams swept');
  });

  test('refuses with a non-zero exit when no registered team has a running session (no false all-clear)', async () => {
    const { sources, trace } = buildMultiSources({
      sessionStates: {
        'main-team': 'absent',
        alpha: 'absent',
        beta: 'absent',
      },
    });
    const io = testIo(neutralCwd, { kind: 'owner' });
    expect(await runUp(['--all'], io, sources)).toBe(1);
    expect(io.err).toContain('nothing restored yet');
    expect(trace.renamedBySession).toEqual([]);

    const dryIo = testIo(neutralCwd, { kind: 'owner' });
    expect(await runUp(['--all', '--dry-run'], dryIo, sources)).toBe(1);
    expect(dryIo.err + dryIo.out).toContain('nothing restored yet');
  });

  test('admits a placed dev-mode lead from a lobby or checkout, and refuses seats, operators, and dev-mode-off leads', async () => {
    // 1. Ordinary seat in dev mode is refused before touching any team.
    const workerSources = buildMultiSources();
    const workerIo = testIo(neutralCwd, { kind: 'seat', name: 'worker-1', pane: 'w-main:p9', session: 'main-team' });
    workerIo.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runUp(['--all'], workerIo, workerSources.sources)).toBe(1);
    expect(workerSources.trace.renamedBySession).toEqual([]);

    // 2. Placed operator in dev mode is refused before touching any team.
    const opSources = buildMultiSources();
    const opIo = testIo(neutralCwd, { kind: 'seat', name: 'op-1', pane: 'w-main:p2', session: 'main-team' });
    opIo.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runUp(['--all'], opIo, opSources.sources)).toBe(1);
    expect(opSources.trace.renamedBySession).toEqual([]);

    // 3. Placed lead with dev mode off is refused.
    const leadOffSources = buildMultiSources();
    const leadOffIo = testIo(
      neutralCwd,
      { kind: 'seat', name: 'lead-1', pane: 'w-main:p1', session: 'main-team' },
    );
    expect(await runUp(['--all'], leadOffIo, leadOffSources.sources)).toBe(1);
    expect(leadOffSources.trace.renamedBySession).toEqual([]);

    // 4. Placed lead with dev mode on, running from a lobby outside any checkout, is admitted.
    const leadOnSources = buildMultiSources();
    const leadOnIo = testIo(neutralCwd, { kind: 'seat', name: 'lead-1', pane: 'w-main:p1', session: 'main-team' });
    leadOnIo.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runUp(['--all'], leadOnIo, leadOnSources.sources)).toBe(0);
    expect(leadOnIo.err).toContain('dev mode continues');
    expect(leadOnSources.trace.renamedBySession).toEqual([
      { session: 'main-team', pane: 'w-main:p1', name: 'lead-1' },
      { session: 'alpha', pane: 'w-alpha:p1', name: 'lead-1' },
      { session: 'beta', pane: 'w-beta:p1', name: 'lead-1' },
    ]);
  });

  test('isolates per-team failures (failed proof or held run lock) without stopping the remaining teams', async () => {
    // alpha has a mismatched conversation (refused); beta has its run lock held; main-team is healthy.
    const heldLock = acquireRunLock(betaTeam.dir, betaTeam.session);
    expect('release' in heldLock).toBe(true);
    try {
      const { sources, trace } = buildMultiSources({
        liveSessionIds: { alpha: 'ses_foreign' },
      });
      const io = testIo(neutralCwd, { kind: 'owner' });
      const code = await runUp(['--all'], io, sources);
      expect(code).toBe(1);

      // main-team still restored; alpha's seat was refused; beta was skipped due to lock-held.
      expect(trace.renamedBySession).toEqual([
        { session: 'main-team', pane: 'w-main:p1', name: 'lead-1' },
      ]);
      expect(io.err).toContain('main-team (session main-team):');
      expect(io.err).toContain('alpha (session alpha):');
      expect(io.err).toContain('beta (session beta):');
    } finally {
      if ('release' in heldLock) heldLock.release();
    }
  });

  test('supports --dry-run and --json, and refuses incompatible single-team flags with exit 2', async () => {
    const { sources, trace } = buildMultiSources();

    const badFile = testIo(neutralCwd, { kind: 'owner' });
    expect(await runUp(['--all', '--file', 'team.yaml'], badFile, sources)).toBe(2);

    const badSession = testIo(neutralCwd, { kind: 'owner' });
    expect(await runUp(['--all', '--session', 'alpha'], badSession, sources)).toBe(2);

    const dryIo = testIo(neutralCwd, { kind: 'owner' });
    expect(await runUp(['--all', '--dry-run'], dryIo, sources)).toBe(0);
    expect(trace.renamedBySession).toEqual([]);
    expect(dryIo.out).toContain('main-team');
    expect(dryIo.out).toContain('alpha');
    expect(dryIo.out).toContain('beta');

    const jsonIo = testIo(neutralCwd, { kind: 'owner' });
    expect(await runUp(['--all', '--json'], jsonIo, sources)).toBe(0);
    const parsed = JSON.parse(jsonIo.out);
    expect(parsed.schema).toEqual({ name: 'team.up', version: 1 });
    expect(parsed.status).toBe('ready');
    expect(parsed.all).toBe(true);
    expect(parsed.teams.map((t: { session: string }) => t.session)).toEqual(['main-team', 'alpha', 'beta']);
  });

  test('daemon startup sweep retries not-running routes with a growing gap, logs each wait, and reports pending when still restoring at the bound', async () => {
    let attempts = 0;
    const started = await startMachineDaemon({
      home,
      roots: [alphaTeam.root],
      startedBy: 'test',
      version: '0.5.12-test',
      heartbeatMs: 10_000,
      restoreRetryInitialDelayMs: 5,
      restoreRetryMaxDelayMs: 20,
      restoreRetryBudgetMs: 35,
      restoreSweep: async () => {
        attempts += 1;
        return { kind: 'not-running', state: 'absent' };
      },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const log = existsSync(daemonLogPath(home)) ? readFileSync(daemonLogPath(home), 'utf8') : '';
        if (log.includes('restore: pending')) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      // Initial pass + 3 growing-gap retries (5ms + 10ms + 20ms = 35ms budget) = 4 attempts
      expect(attempts).toBe(4);
      const log = readFileSync(daemonLogPath(home), 'utf8');
      expect(log).toContain('restore: waiting');
      expect(log).toContain('restore: pending');
      expect(log).not.toContain('nothing restored');
    } finally {
      await started.daemon.close();
    }
  });

  test('daemon startup sweep restores a route that becomes running on a retry and stops waiting', async () => {
    let attempts = 0;
    const started = await startMachineDaemon({
      home,
      roots: [alphaTeam.root],
      startedBy: 'test',
      version: '0.5.12-test',
      heartbeatMs: 10_000,
      restoreRetryInitialDelayMs: 5,
      restoreRetryMaxDelayMs: 20,
      restoreRetryBudgetMs: 100,
      restoreSweep: async () => {
        attempts += 1;
        if (attempts < 3) return { kind: 'not-running', state: 'absent' };
        return {
          kind: 'ran',
          summary: {
            repaired: 1,
            skipped_working: 0,
            refused: 0,
            repaired_seats: ['lead-1'],
            skipped_working_seats: [],
            refused_seats: [],
            line: '1 seat repaired, 0 skipped (working), 0 refused',
          },
          failed: false,
        };
      },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const log = existsSync(daemonLogPath(home)) ? readFileSync(daemonLogPath(home), 'utf8') : '';
        if (log.includes('1 seat repaired')) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(attempts).toBe(3);
      const log = readFileSync(daemonLogPath(home), 'utf8');
      expect(log).toContain('restore: waiting 5ms');
      expect(log).toContain('restore: waiting 10ms');
      expect(log).toContain(`restore ${alphaTeam.root}: 1 seat repaired, 0 skipped (working), 0 refused`);
      expect(log).not.toContain('restore: pending');
    } finally {
      await started.daemon.close();
    }
  });

  test('returns 2 immediately when the registry cannot be read and never falls through into single-team up or accepts UpInternal on --all', async () => {
    const registryFile = join(home, '.config', 'team', 'teams.yaml');
    const savedRegistry = readFileSync(registryFile, 'utf8');
    try {
      writeFileSync(registryFile, ': : bad yaml [\n');
      let singleTeamGateCalled = false;
      let sessionProbed = false;
      const baseSources = buildMultiSources();
      const sources: UpSources = {
        ...baseSources.sources,
        sessionState: (s) => {
          sessionProbed = true;
          return baseSources.sources.sessionState!(s);
        },
        delegateGate: () => {
          singleTeamGateCalled = true;
          return { kind: 'refused', id: 'up.delegate', text: 'not delegated' };
        },
      };
      // Run from inside a valid team checkout (`alphaTeam.root`) to prove `--all` exit 2 stops immediately
      // at the `--all` dispatch site without falling through into single-team `walkCaller`/`callerOf`.
      const io = testIo(alphaTeam.root, { kind: 'owner' });
      let callerReads = 0;
      Object.defineProperty(io, 'caller', {
        get() {
          callerReads += 1;
          return { kind: 'owner' as const };
        },
      });
      expect(await runUp(['--all'], io, sources)).toBe(2);
      // 1 read in cleanedIo(io) + 2 reads in runUpAll's walkCaller(io); 0 reads in single-team runUp after exit 2.
      expect(callerReads).toBe(3);
      expect(sessionProbed).toBe(false);
      expect(singleTeamGateCalled).toBe(false);
      expect(baseSources.trace.renamedBySession).toEqual([]);
    } finally {
      writeFileSync(registryFile, savedRegistry);
    }

    // Even if `UpInternal.caller` is passed directly to `runUp` with `--all`, `runUpAll` ignores it
    // and enforces the `--all` caller gate against the real `io` caller.
    const { sources, trace } = buildMultiSources();
    const seatIo = testIo(alphaTeam.root, { kind: 'seat', name: 'worker-1', pane: 'w-alpha:p9', session: 'alpha' });
    expect(await runUp(['--all'], seatIo, sources, { caller: { kind: 'owner' } })).toBe(1);
    expect(seatIo.err).toContain('only the owner or a lead in development mode runs team up --all');
    expect(trace.renamedBySession).toEqual([]);
  });

  test('pins runRestoreSweepForRoute and UpInternal to the daemon startup path only and refuses socket or chores requests naming restore', () => {
    const srcRoot = join(import.meta.dir, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(srcRoot);

    const relOf = (full: string): string => full.slice(srcRoot.length + 1).replaceAll('\\', '/');
    const callersOfSweep: string[] = [];
    const callersOfWriteToken: string[] = [];
    const callersOfSpawnChild: string[] = [];
    const filesWithUpInternal: string[] = [];

    for (const file of files) {
      const rel = relOf(file);
      const text = readFileSync(file, 'utf8');
      if (text.includes('runRestoreSweepForRoute(') && rel !== 'launch/restore-sweep.ts') {
        callersOfSweep.push(rel);
      }
      if (text.includes('writeRestoreInherit(') && rel !== 'daemon/restore/token.ts') {
        callersOfWriteToken.push(rel);
      }
      if (text.includes('runRestoreSweepInChild(') && rel !== 'daemon/restore/spawn.ts') {
        callersOfSpawnChild.push(rel);
      }
      if (text.includes('UpInternal')) {
        filesWithUpInternal.push(rel);
      }
    }

    // 1. Single-caller chain: startMachineDaemon (daemon/host.ts) -> runRestoreSweepInChild (daemon/restore/spawn.ts)
    //    -> writeRestoreInherit + entry.ts (daemon/restore/entry.ts) -> runRestoreSweepForRoute (launch/restore-sweep.ts).
    expect(callersOfSweep).toEqual(['daemon/restore/entry.ts']);
    expect(callersOfWriteToken).toEqual(['daemon/restore/spawn.ts']);
    expect(callersOfSpawnChild).toEqual(['daemon/host.ts']);
    expect(filesWithUpInternal).toEqual(['commands/up.ts']);

    const entryText = readFileSync(join(srcRoot, 'daemon/restore/entry.ts'), 'utf8');
    expect(entryText).toContain('readRestoreInherit(home, nonce)');

    // 2. Daemon socket protocol refuses any request naming restore or up.
    const dummyHealth = {
      pid: 1,
      uid: 501,
      since: '2026-11-05T04:00:00Z',
      startedBy: 'test',
      version: '0.5.12',
      heartbeatAt: '2026-11-05T04:00:00Z',
      stuck: [],
      features: { send: 'on' as const, bus: 'on' as const, broker: 'absent' as const },
    };
    for (const op of ['restore', 'restore-sweep', 'runRestoreSweepForRoute', 'up']) {
      const parsed = parseDaemonRequest(JSON.stringify({ v: 2, id: `req-${op}`, op }));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const res = answerDaemonRequest(parsed.request, dummyHealth);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe('daemon.unsupported-op');
      }
    }

    // 3. Chores protocol rejects any host or child frame naming restore or up.
    for (const type of ['restore', 'restore-sweep', 'runRestoreSweepForRoute', 'up']) {
      expect(readHostMessage({ type, id: '1', root: '/tmp', at: '2026-11-05T04:00:00Z' })).toBeNull();
      expect(readChildMessage({ type, root: '/tmp', at: '2026-11-05T04:00:00Z' })).toBeNull();
    }
  });
});
