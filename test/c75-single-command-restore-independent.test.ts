// C7.5 item 9, the independent test: the single-command restore (`team up --all`) and the
// daemon's startup sweep with its growing-gap retry. Written from the item 9 design and the
// source, against `feat/c75-single-command-restore` at 9248428e9 (the round-6 door commit);
// nothing under src is touched.
//
// The world is synthetic throughout: a fake terminal host (session reads, agents, panes and
// launch calls are all fixtures), a fake process identity, and a registry and team files under a
// scratch home. The daemon scenes inject the restore runner so no pass ever reaches a real
// terminal host, and the retry scene scales the production delays (5 s / 60 s / 315 s) by 1/1000
// so the injected clock observes the same schedule in milliseconds. One scene runs the daemon
// at the production first delay to read the default 5 s wait and the 315 s budget off the log.
// The door's admission contract is scene'd at `acceptRestoreDoor`'s injected seam: the system
// service manager's job record for the home (or its absence) is the parent anchor, so a claims
// file naming any other pid — even with a matching secret — is refused before it is spent. The
// real child entry then runs as its own program with a synthetic service-manager record and a
// synthetic installed unit on PATH (the machine's own manager is never consulted): a forged
// claims pid, a parent the record does not name, a wrong secret and an expired token all refuse
// without sweeping, and the service-named parent is admitted through the real spawn path, which
// runs the pass end to end. A home with no installed unit is refused even though the record
// names a running machine daemon: `job(home)` answers null before the manager is asked. A plist
// a seat drops into its own home is refused too when the manager's record says the loaded job
// runs from another unit path: the record and the home's unit must be the same file.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalOf } from '../src/approve/approval.ts';
import { issueOwnerGeneralGrant } from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { readChildMessage, readHostMessage } from '../src/daemon/chores/protocol.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { DAEMON_LABEL, daemonLogPath, daemonSocketPath, machineConfigDir, restoreInheritPath } from '../src/daemon/paths.ts';
import { DAEMON_PROTOCOL_VERSION } from '../src/daemon/protocol.ts';
import { runRestoreSweepInChild } from '../src/daemon/restore/spawn.ts';
import { acceptRestoreDoor, restoreDoorText, writeRestoreDoor } from '../src/daemon/restore/token.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, SessionState } from '../src/herdr.ts';
import { acquireRunLock } from '../src/launch/run-lock.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { installKey } from '../src/store/keys.ts';
import { fixtureBase, gitEnv, recordRenames, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T04:15:00Z');
const DAY_MS = 86_400_000;
const IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol')
  .replace('GPT-5.6-Terra', 'GPT-6.1-Sol');

// The pids the state records for the seat as the host launched it, and the pids the restored
// pane reports afterwards: the repair re-records the live identity it proves.
const LAUNCHED = { shell: 120, cli: [220] };
const RESTORED = { shell: 320, foreground: [420] };

/** The restore child entry as its own program, and the one line a refused child writes. */
const ENTRY = fileURLToPath(new URL('../src/daemon/restore/entry.ts', import.meta.url));

type EntryRun = { status: number | null; stdout: string; stderr: string };

/** Runs the restore child entry the way the daemon starts it, and pipes `door` (the inherited
 *  descriptor 3 text) into it. A null door starts the child with descriptor 3 on `/dev/null`: the
 *  daemon's inherited channel is absent, the closest a test can come without inheriting a pipe.
 *  `fakeBin` is put first on the child's PATH when a scene supplies a synthetic service manager. */
function runEntry(
  homeDir: string,
  cwd: string,
  args: string[],
  door: string | null,
  fakeBin?: string,
): Promise<EntryRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: homeDir,
        ...(fakeBin === undefined ? {} : { PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}` }),
      },
      stdio: ['ignore', 'pipe', 'pipe', door === null ? 'ignore' : 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (door !== null) {
      const stream = child.stdio[3] as unknown as {
        on(event: 'error', listener: () => void): void;
        end(text: string): void;
      } | null;
      stream?.on('error', () => {});
      stream?.end(door);
    }
  });
}

/** A synthetic service manager: an executable `launchctl` first on PATH whose `print` reports
 *  `daemonPid` and the unit path the job was loaded from, so the child's live
 *  `systemServiceManager().job(home)` sees the record a scene chose. The machine's own service
 *  manager is never asked. `unitHome`, when given, gets the installed unit the round-5
 *  `job(home)` gate requires, and the record names that unit's real path; `loadedPath` overrides
 *  what the record says so a scene can name another unit (the round-6 gate). */
function fakeServiceRecord(dir: string, daemonPid: number, unitHome?: string, loadedPath?: string): string {
  mkdirSync(dir, { recursive: true });
  let path = loadedPath ?? '/nonexistent-unit';
  if (unitHome !== undefined) {
    mkdirSync(join(unitHome, 'Library', 'LaunchAgents'), { recursive: true });
    const unitFile = join(unitHome, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
    writeFileSync(
      unitFile,
      `<plist version="1.0"><dict><key>Label</key><string>${DAEMON_LABEL}</string></dict></plist>\n`,
      { mode: 0o600 },
    );
    path = loadedPath ?? realpathSync(unitFile);
  }
  writeFileSync(
    join(dir, 'launchctl'),
    `#!/bin/sh\nprintf 'path = %s\\npid = %s\\n' "${path}" "${String(daemonPid)}"\nexit 0\n`,
    { mode: 0o755 },
  );
  return dir;
}

type Fixture = {
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
let neutral: string;
let mainTeam: Fixture;
let alphaTeam: Fixture;
let betaTeam: Fixture;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv(),
  });
}

function teamYaml(f: Fixture): string {
  return `format: 1
project: ${f.project}
coordinator: ${f.lead}
operator: ${f.operator}
session: ${f.session}
trust:
  - ${f.lobby}
  - ${f.root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${f.lead}
    label: ${f.lead}
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
    leads: true
  - role: operator
    name: ${f.operator}
    label: ${f.operator}
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
    human: true
  - role: implementer
    name: ${f.worker}
    label: ${f.worker}
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
    stopped: true
`;
}

function makeFixture(spec: {
  project: string;
  session: string;
  root: string;
  pane: string;
  workspace: string;
  sessionId: string;
}): Fixture {
  const dir = join(spec.root, '.agents');
  const lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  git(spec.root, 'init', '-q', '-b', 'main');
  writeFileSync(join(spec.root, 'README.md'), `${spec.project}\n`);
  git(spec.root, 'add', 'README.md');
  git(spec.root, 'commit', '-q', '-m', 'init');

  const fixture: Fixture = { ...spec, dir, lobby, lead: 'lead-1', operator: 'op-1', worker: 'worker-1' };
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

  const teamId = teamIdOf(spec.root);
  updateState(dir, (state) => {
    const s = (state.sessions[spec.session] ??= emptySession());
    s.seats[fixture.lead] = {
      id: `seat_${teamId}`,
      stage: 'ready',
      pane: spec.pane,
      workspace: spec.workspace,
      launched: LAUNCHED,
      agent_session: spec.sessionId,
    };
    // The operator's seat is recorded as placed so the pass never cold-starts it; its own
    // launch identity is not what this test restores.
    s.seats[fixture.operator] = {
      id: `seat_${teamId.slice(0, 11)}f`,
      stage: 'ready',
      pane: `${spec.workspace}:p2`,
      workspace: spec.workspace,
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
      session: spec.session,
      pane: spec.pane,
      address: null,
      agent_session: spec.sessionId,
    },
    seat_handle: `seat_${teamId}`,
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  upsertTeam(home, teamIdOf(spec.root), {
    project: fixture.project,
    entity: null,
    session: spec.session,
    root: spec.root,
    lobby: fixture.lobby,
    lobbies: { [spec.session]: fixture.lobby },
    roster: [
      { agent: `ag_${spec.session}_lead`, seat: fixture.lead, role: 'coordinator', leads: true },
      { agent: `ag_${spec.session}_op`, seat: fixture.operator, role: 'operator' },
      { agent: `ag_${spec.session}_worker`, seat: fixture.worker, role: 'implementer' },
    ],
    lifecycle: 'running',
    by: 'team up',
    at: NOW.toISOString(),
  });
  return fixture;
}

type Trace = {
  renamed: { session: string; pane: string; name: string }[];
  reported: { session: string; pane: string; text: string }[];
  created: { session: string; label: string }[];
  typed: { session: string; pane: string }[];
};

type FakeWorld = {
  sources: UpSources;
  trace: Trace;
  /** How many times the pass asked the terminal host about a session. A refused caller must
   *  never raise this: the gate answers before the sweep reads anything. */
  sessionReads: () => number;
};

/** A world whose terminal host is entirely fixture: the three teams' sessions answer from the
 *  given map (every known fixture is running unless overridden), and `hostSilent` makes every
 *  read unknown. */
function fakeWorld(options: {
  home?: string;
  sessionStates?: Record<string, SessionState | null>;
  liveSessionIds?: Record<string, string>;
  hostSilent?: boolean;
} = {}): FakeWorld {
  const trace: Trace = { renamed: [], reported: [], created: [], typed: [] };
  const counter = { reads: 0 };
  const fixtures = new Map<string, Fixture>([
    [mainTeam.session, mainTeam],
    [alphaTeam.session, alphaTeam],
    [betaTeam.session, betaTeam],
  ]);

  const stateOf = (session: string): SessionState | null => {
    if (options.hostSilent) return null;
    if (options.sessionStates !== undefined && session in options.sessionStates) {
      return options.sessionStates[session]!;
    }
    return fixtures.has(session) ? 'running' : 'absent';
  };
  const sessionState = (session: string): SessionState | null => {
    counter.reads += 1;
    return stateOf(session);
  };
  const agents = (session: string): HerdrAgent[] | null => {
    if (options.hostSilent) return null;
    const fixture = fixtures.get(session);
    if (fixture === undefined || stateOf(session) !== 'running') return [];
    return [
      {
        name: null,
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
      const state = stateOf(session);
      return state === null ? null : state === 'running';
    },
    createWorkspace: (session, _cwd, label) => {
      trace.created.push({ session, label });
      return { pane: `created-${label}`, workspace: `ws-${label}` };
    },
    paneRun: (session, pane) => {
      trace.typed.push({ session, pane });
      return true;
    },
    renameWorkspace: () => true,
    reportDisplayAgent(session, pane, text) {
      trace.reported.push({ session, pane, text });
      return true;
    },
    renameAgent(session, pane, name) {
      trace.renamed.push({ session, pane, name });
      return true;
    },
    closeWorkspace: () => true,
    agentPanes: (session) => (agents(session) ?? []).map((agent) => agent.pane),
    agents,
    paneText: () => IDLE,
    foreground: () => ['codex'],
    processInfo: () => RESTORED,
    sleep: async () => {},
    now: () => NOW,
  };
  recordRenames(launch);

  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => !options.hostSilent,
    now: () => NOW,
    home: options.home ?? home,
  };

  const sources: UpSources = {
    sessionRunning: (session) => {
      const state = stateOf(session);
      return state === null ? null : state === 'running';
    },
    sessionState,
    agents,
    workspaces: (session) => {
      const fixture = fixtures.get(session);
      return fixture === undefined ? [] : [{ id: fixture.workspace, label: fixture.lead }];
    },
    home: options.home ?? home,
    doctor,
    launch,
    now: () => NOW,
  };
  return { sources, trace, sessionReads: () => counter.reads };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLog(logPath: string, needle: string, deadlineMs: number): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let text = '';
  while (Date.now() < deadline) {
    text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    if (text.includes(needle)) return text;
    await sleep(10);
  }
  throw new Error(`the daemon log never said "${needle}"; it said:\n${text}`);
}

/** One request line on the daemon's socket, one response line back. */
function askDaemon(socketPath: string, request: { v: number; id: string; op: string }): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ path: socketPath });
    let buffer = '';
    let settled = false;
    const finish = (error: Error | null, value?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== null) reject(error);
      else resolvePromise(value!);
    };
    const timer = setTimeout(() => finish(new Error('the daemon did not answer')), 2000);
    socket.on('error', (error) => finish(error));
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>);
      } catch {
        finish(new Error('the daemon answer was not JSON'));
      }
    });
  });
}

const ZERO_SUMMARY = {
  repaired: 0,
  skipped_working: 0,
  refused: 0,
  repaired_seats: [] as string[],
  skipped_working_seats: [] as string[],
  refused_seats: [] as { seat: string; reason: string }[],
  line: '0 seats repaired, 0 skipped (working), 0 refused',
};

beforeEach(() => {
  base = fixtureBase('c75-single-restore-');
  home = join(base, 'home');
  neutral = join(base, 'neutral');
  mkdirSync(home, { recursive: true });
  mkdirSync(neutral, { recursive: true });

  const parentRoot = join(base, 'workspace');
  betaTeam = makeFixture({
    project: 'beta',
    session: 'beta',
    root: join(parentRoot, 'beta'),
    pane: 'w-beta:p1',
    workspace: 'w-beta',
    sessionId: 'ses_beta',
  });
  alphaTeam = makeFixture({
    project: 'alpha',
    session: 'alpha',
    root: join(parentRoot, 'alpha'),
    pane: 'w-alpha:p1',
    workspace: 'w-alpha',
    sessionId: 'ses_alpha',
  });
  mainTeam = makeFixture({
    project: 'main-team',
    session: 'main-team',
    root: parentRoot,
    pane: 'w-main:p1',
    workspace: 'w-main',
    sessionId: 'ses_main',
  });
  // An active record whose session is not running, and whose root was never created: it must be
  // skipped by the session read alone, never by trying to read a team file that is not there.
  upsertTeam(home, '0000000000pk', {
    project: 'parked',
    entity: null,
    session: 'parked',
    root: join(base, 'never-created'),
    lobby: join(home, '.config', 'team', 'lobby'),
    roster: [],
    lifecycle: 'running',
    by: 'team up',
    at: NOW.toISOString(),
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('team up --all: the single-command multi-team restore', () => {
  test('the owner sweeps in parent-first then session order and skips an inactive team without reading its file', async () => {
    const world = fakeWorld();
    const io = testIo(neutral, { kind: 'owner' });

    expect(await runUp(['--all'], io, world.sources)).toBe(0);

    // Parent root first, then the two children in session-name order; `parked` never appears.
    expect(world.trace.renamed.map((one) => one.session)).toEqual(['main-team', 'alpha', 'beta']);
    expect(world.trace.renamed.every((one) => one.name === 'lead-1')).toBe(true);

    // The pass re-recorded the live identity it proved for each team's lead.
    for (const fixture of [mainTeam, alphaTeam, betaTeam]) {
      const lead = readState(fixture.dir).sessions[fixture.session]?.seats[fixture.lead];
      expect(lead?.launched).toEqual({ shell: RESTORED.shell, cli: RESTORED.foreground });
    }

    expect(io.err).toContain('main-team (session main-team): 0 seats repaired, 0 skipped (working), 0 refused');
    expect(io.err).toContain('alpha (session alpha): 0 seats repaired, 0 skipped (working), 0 refused');
    expect(io.err).toContain('beta (session beta): 0 seats repaired, 0 skipped (working), 0 refused');
    expect(io.err).toContain('all teams: 3 teams swept (0 seats repaired, 0 skipped, 0 refused); 1 inactive skipped');
    expect(io.err).toContain('; 1 inactive skipped');
    expect(io.err).not.toContain('parked');
    expect(io.err).not.toContain('nothing restored');
  });

  test('--dry-run plans every team without launching, and --json reports the team.up envelope', async () => {
    const world = fakeWorld();

    const dryIo = testIo(neutral, { kind: 'owner' });
    expect(await runUp(['--all', '--dry-run'], dryIo, world.sources)).toBe(0);
    expect(world.trace.renamed).toEqual([]);
    expect(world.trace.created).toEqual([]);
    expect(dryIo.out).toContain('=== main-team (session main-team) ===');
    expect(dryIo.out).toContain('=== alpha (session alpha) ===');
    // A plain dry run prints each team's plan and no aggregate line (the aggregate is the
    // real sweep's report); the count is carried in the JSON document below.
    expect(dryIo.err).toBe('');

    const jsonIo = testIo(neutral, { kind: 'owner' });
    expect(await runUp(['--all', '--dry-run', '--json'], jsonIo, world.sources)).toBe(0);
    const doc = JSON.parse(jsonIo.out) as Record<string, any>;
    expect(doc.schema).toEqual({ name: 'team.up', version: 1 });
    expect(doc.all).toBe(true);
    expect(doc.dry_run).toBe(true);
    expect(doc.status).toBe('dry-run');
    expect(doc.teams.map((team: { session: string }) => team.session)).toEqual(['main-team', 'alpha', 'beta']);
    expect(doc.teams.every((team: { status: string }) => team.status === 'dry-run')).toBe(true);
    expect(doc.seats).toContain('main-team/lead-1');
    expect(doc.action_summary).toBe('all teams: 3 teams planned; 1 inactive skipped');
    expect(jsonIo.err).toBe('');
  });

  test('nothing restored is a refusal: no registry, no running session, and a silent terminal host', async () => {
    // No teams registered at all: a bare home, where the registry file does not exist.
    const bare = join(base, 'bare-home');
    mkdirSync(bare, { recursive: true });
    const bareWorld = fakeWorld({ home: bare });
    const bareIo = testIo(neutral, { kind: 'owner' });
    expect(await runUp(['--all'], bareIo, bareWorld.sources)).toBe(1);
    expect(bareIo.err).toContain('team up: nothing restored yet: no teams are registered');
    expect(bareWorld.sessionReads()).toBe(0);

    // Every registered session is stopped: the sweep would be a false all-clear.
    const stoppedWorld = fakeWorld({
      sessionStates: { 'main-team': 'absent', alpha: 'absent', beta: 'absent', parked: 'absent' },
    });
    const stoppedIo = testIo(neutral, { kind: 'owner' });
    expect(await runUp(['--all'], stoppedIo, stoppedWorld.sources)).toBe(1);
    expect(stoppedIo.err).toContain('team up: nothing restored yet: no registered team has a running session in the terminal host');
    expect(stoppedWorld.trace.renamed).toEqual([]);

    // The host answers nothing at all: that is `up.herdr`, never a pending all-clear.
    const silentWorld = fakeWorld({ hostSilent: true });
    const silentIo = testIo(neutral, { kind: 'owner' });
    expect(await runUp(['--all'], silentIo, silentWorld.sources)).toBe(1);
    expect(silentIo.err).toContain("team up: the terminal host doesn't answer");
    expect(silentWorld.trace.renamed).toEqual([]);
  });

  test('a failed team never stops the sweep: an unreadable state and a held lock are isolated, and the exit is 1', async () => {
    // alpha's recorded state cannot be read; beta's run lock is held by another session.
    writeFileSync(join(alphaTeam.dir, 'team.state.json'), 'not json\n');
    const betaLock = acquireRunLock(betaTeam.dir, betaTeam.session);
    expect('release' in betaLock).toBe(true);
    try {
      const world = fakeWorld();
      const io = testIo(neutral, { kind: 'owner' });
      expect(await runUp(['--all'], io, world.sources)).toBe(1);

      // main-team is still swept; the two failures are reported and the aggregate is still one
      // line over all three swept teams.
      expect(world.trace.renamed.map((one) => one.session)).toEqual(['main-team']);
      expect(io.err).toContain('team up: alpha (session alpha): ');
      expect(io.err).toContain('team up: beta (session beta): ');
      expect(io.err).toContain('main-team (session main-team):');
      expect(io.err).toContain('all teams: 3 teams swept (0 seats repaired, 0 skipped, 0 refused); 1 inactive skipped');
      const mainLead = readState(mainTeam.dir).sessions[mainTeam.session]?.seats[mainTeam.lead];
      expect(mainLead?.launched).toEqual({ shell: RESTORED.shell, cli: RESTORED.foreground });

      // The structured form reports the same sweep as one `up.pending`, naming the failures.
      const jsonIo = testIo(neutral, { kind: 'owner' });
      expect(await runUp(['--all', '--json'], jsonIo, world.sources)).toBe(1);
      const doc = JSON.parse(jsonIo.out) as Record<string, any>;
      expect(doc.schema).toEqual({ name: 'team.error', version: 1 });
      expect(doc.error.id).toBe('up.pending');
      expect(doc.error.message).toContain('all teams: 3 teams swept');
      expect(doc.error.message).toContain('alpha');
      expect(doc.error.message).toContain('beta');
    } finally {
      if ('release' in betaLock) betaLock.release();
    }
  });

  test('an unreadable registry exits 2 before any sweep and never falls through to the single-team run', async () => {
    writeFileSync(join(home, '.config', 'team', 'teams.yaml'), 'teams: [unterminated\n');
    // Run from inside a perfectly valid checkout: a fall-through would run the single-team up.
    const world = fakeWorld();
    const io = testIo(alphaTeam.root, { kind: 'owner' });

    expect(await runUp(['--all'], io, world.sources)).toBe(2);
    expect(io.err.startsWith('team up: ')).toBe(true);
    expect(io.err).not.toContain('nothing restored');
    expect(world.sessionReads()).toBe(0);
    expect(world.trace.renamed).toEqual([]);

    const jsonIo = testIo(alphaTeam.root, { kind: 'owner' });
    expect(await runUp(['--all', '--json'], jsonIo, world.sources)).toBe(2);
    const doc = JSON.parse(jsonIo.out) as Record<string, any>;
    expect(doc.schema).toEqual({ name: 'team.error', version: 1 });
    expect(doc.error.id).toBe('up.file');
    expect(world.sessionReads()).toBe(0);
  });
});

describe('team up --all: the caller gate', () => {
  test('a no-terminal owner is refused with its own detached sentence before anything is read', async () => {
    const world = fakeWorld();
    const io = testIo(neutral, { kind: 'owner-no-tty' });
    expect(await runUp(['--all'], io, world.sources)).toBe(1);
    expect(io.err).toContain(
      "team up: only the owner or a lead in development mode runs this, from a terminal outside the terminal host or the lead's own pane",
    );
    expect(world.sessionReads()).toBe(0);
    expect(world.trace.renamed).toEqual([]);
  });

  test('a placed lead in development mode is admitted; a seat, its operator and an unplaced caller are not', async () => {
    // The placed lead runs from its own checkout with dev mode on at the machine level.
    const leadWorld = fakeWorld();
    const leadIo = testIo(mainTeam.root, {
      kind: 'seat',
      name: 'lead-1',
      pane: mainTeam.pane,
      session: mainTeam.session,
    });
    leadIo.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runUp(['--all', '--dry-run'], leadIo, leadWorld.sources)).toBe(0);
    expect(leadIo.err).toContain('only the owner or a lead in development mode runs team up --all; dev mode continues');
    expect(leadIo.out).toContain('=== main-team (session main-team) ===');
    expect(leadIo.out).toContain('=== beta (session beta) ===');

    const refused: { name: string; caller: Parameters<typeof testIo>[1]; cwd: string; dev: boolean }[] = [
      {
        name: 'a seat',
        caller: { kind: 'seat', name: 'worker-1', pane: 'w-main:p9', session: 'main-team' },
        cwd: mainTeam.root,
        dev: true,
      },
      {
        name: 'the operator',
        caller: { kind: 'seat', name: 'op-1', pane: 'w-main:p2', session: 'main-team' },
        cwd: mainTeam.root,
        dev: true,
      },
      {
        name: 'an unplaced caller',
        caller: { kind: 'unplaced', reason: "its parent processes can't be read to the top" },
        cwd: neutral,
        dev: true,
      },
    ];
    for (const scene of refused) {
      const world = fakeWorld();
      const io = testIo(scene.cwd, scene.caller);
      if (scene.dev) io.env = { TEAMCLI_DEV_MODE: '1' };
      expect(await runUp(['--all'], io, world.sources)).toBe(1);
      expect(io.err).toContain('team up: only the owner or a lead in development mode runs team up --all');
      expect(world.sessionReads()).toBe(0);
      expect(world.trace.renamed).toEqual([]);
    }
  });

  test('a verified general grant admits a no-terminal caller, and the same caller without it is refused', async () => {
    installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')) as never);
    const pair = newClientKeyPair();
    const written = writeClientKeyFiles(join(home, '.config', 'team-client', 'build-agent'), pair);
    if (!written.ok) throw new Error(written.why);
    const grant = issueOwnerGeneralGrant(
      home,
      {
        clientId: 'build-agent',
        publicKey: pair.publicKey,
        entities: ['*'],
        ops: ['up'],
        mayIssue: false,
        expires: new Date(NOW.getTime() + 30 * DAY_MS),
      },
      NOW,
    );
    if (!grant.ok) throw new Error(grant.why);

    const refusedWorld = fakeWorld();
    const refusedIo = testIo(neutral, { kind: 'owner-no-tty' });
    expect(await runUp(['--all'], refusedIo, refusedWorld.sources)).toBe(1);
    expect(refusedWorld.sessionReads()).toBe(0);

    const grantedWorld = fakeWorld();
    const grantedIo = testIo(neutral, { kind: 'owner-no-tty', });
    expect(
      await runUp(['--all', '--general', grant.path, '--key', written.keyPath], grantedIo, grantedWorld.sources),
    ).toBe(0);
    expect(grantedIo.err).toContain(`team up: admitted by general grant ${grant.grant.grant_id} (build-agent)`);
    expect(grantedWorld.trace.renamed.map((one) => one.session)).toEqual(['main-team', 'alpha', 'beta']);
  });
});

describe('the daemon start sweep: growing-gap retry', () => {
  test('the wait doubles from the injected initial delay to the cap and ends pending at the budget', async () => {
    // The production schedule is 5 s doubling to a 60 s cap over 315 s; the injected clock runs
    // it at 1/1000 so the same algorithm is observed in milliseconds.
    let attempts = 0;
    const started = await startMachineDaemon({
      home,
      roots: [mainTeam.root],
      startedBy: 'test',
      version: '0.5.12-test',
      heartbeatMs: 10_000,
      restoreRetryInitialDelayMs: 5,
      restoreRetryMaxDelayMs: 60,
      restoreRetryBudgetMs: 315,
      restoreSweep: async () => {
        attempts += 1;
        return { kind: 'not-running', state: 'absent' };
      },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const log = await waitForLog(daemonLogPath(home), 'restore: pending', 5000);
      const waits = [...log.matchAll(/restore: waiting (\d+)(ms|s) for the terminal host to restore 1 session/g)].map(
        (match) => Number(match[1]) * (match[2] === 's' ? 1000 : 1),
      );
      expect(waits).toEqual([5, 10, 20, 40, 60, 60, 60, 60]);
      // The initial pass plus one pass per wait, and the budget stops the loop exactly at 315.
      expect(attempts).toBe(9);
      expect(log).toContain('(attempt 1, elapsed 0ms/315ms)');
      expect(log).toContain('(attempt 8, elapsed 255ms/315ms)');
      expect(log).toContain('restore: pending (1 session still restoring in the terminal host after 315ms;');
      expect(log).not.toContain('nothing restored');
    } finally {
      await started.daemon.close();
    }
  }, 20_000);

  test('the production defaults are a 5 s first wait over a 315 s budget, and a route that comes up stops the retry', async () => {
    let attempts = 0;
    const started = await startMachineDaemon({
      home,
      roots: [mainTeam.root],
      startedBy: 'test',
      version: '0.5.12-test',
      heartbeatMs: 10_000,
      // No retry knobs: the daemon's own defaults decide the schedule.
      restoreSweep: async () => {
        attempts += 1;
        if (attempts === 1) return { kind: 'not-running', state: 'absent' };
        return { kind: 'ran', summary: { ...ZERO_SUMMARY, repaired: 1, repaired_seats: ['lead-1'], line: '1 seat repaired, 0 skipped (working), 0 refused' }, failed: false };
      },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const waiting = await waitForLog(daemonLogPath(home), 'restore: waiting 5s', 3000);
      expect(waiting).toContain('restore: waiting 5s for the terminal host to restore 1 session (attempt 1, elapsed 0ms/315s)');
      const log = await waitForLog(daemonLogPath(home), '1 seat repaired', 12_000);
      expect(attempts).toBe(2);
      expect(log).not.toContain('restore: pending');
    } finally {
      await started.daemon.close();
    }
  }, 30_000);
});

describe("the restore door's admission contract at the seam", () => {
  const daemonPid = process.pid;
  const runningJob = { job: () => ({ pid: daemonPid, program: process.execPath }) };

  test('the service manager record of the daemon admits its direct child and spends the token', () => {
    const door = writeRestoreDoor({ version: 1, home, root: mainTeam.root, daemonPid });
    const path = restoreInheritPath(home, door.nonce);
    expect(
      acceptRestoreDoor({
        home,
        nonce: door.nonce,
        text: restoreDoorText(door.nonce, door.secret),
        parentPid: daemonPid,
        service: runningJob,
      }),
    ).toEqual({ kind: 'ok', request: { version: 1, home, root: mainTeam.root } });
    expect(existsSync(path)).toBe(false);
  });

  test('no job, or a job the manager records without a pid, refuses before claiming', () => {
    for (const service of [{ job: () => null }, { job: () => ({ pid: null, program: null }) }]) {
      const door = writeRestoreDoor({ version: 1, home, root: mainTeam.root, daemonPid });
      const path = restoreInheritPath(home, door.nonce);
      expect(
        acceptRestoreDoor({
          home,
          nonce: door.nonce,
          text: restoreDoorText(door.nonce, door.secret),
          parentPid: daemonPid,
          service,
        }),
      ).toEqual({ kind: 'refused', why: "the system's service manager records no running machine daemon" });
      expect(existsSync(path)).toBe(true);
    }
  });

  test('a forged claims file naming a non-daemon parent is refused although its secret matches', () => {
    // The child reports the forged parent as its own and carries the file's matching secret: only
    // the service manager's record of a different daemon refuses it, before the claim.
    const forgedPid = daemonPid + 1;
    const door = writeRestoreDoor({ version: 1, home, root: mainTeam.root, daemonPid: forgedPid });
    const path = restoreInheritPath(home, door.nonce);
    expect(
      acceptRestoreDoor({
        home,
        nonce: door.nonce,
        text: restoreDoorText(door.nonce, door.secret),
        parentPid: forgedPid,
        service: runningJob,
      }),
    ).toEqual({
      kind: 'refused',
      why: 'the restore child was not started directly by the service-managed machine daemon',
    });
    expect(existsSync(path)).toBe(true);
  });

  test('a claims pid the service record does not name is refused even when the parent matches', () => {
    const door = writeRestoreDoor({ version: 1, home, root: mainTeam.root, daemonPid: daemonPid + 1 });
    const path = restoreInheritPath(home, door.nonce);
    expect(
      acceptRestoreDoor({
        home,
        nonce: door.nonce,
        text: restoreDoorText(door.nonce, door.secret),
        parentPid: daemonPid,
        service: runningJob,
      }),
    ).toEqual({
      kind: 'refused',
      why: 'the restore token daemon pid does not match the service-managed machine daemon',
    });
    expect(existsSync(path)).toBe(true);
  });
});

/** The real-entry scenes need a service manager to read; the live adapter exists on darwin only,
 *  and everywhere else the door refuses with "records no running machine daemon" before the
 *  parent is compared. */
const liveServiceManager = process.platform === 'darwin';

describe('the restore door: the real child entry against a synthetic service-manager record', () => {
  const daemonPid = process.pid;

  test('no inherited descriptor 3 is refused before any route read, and the token is not spent', async () => {
    const door = writeRestoreDoor({ version: 1, home, root: mainTeam.root });
    const stateBefore = readFileSync(join(mainTeam.dir, 'team.state.json'), 'utf8');
    const ran = await runEntry(home, mainTeam.root, ['--inherited', door.nonce], null);
    expect(ran.status).toBe(2);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toBe('team daemon: the restore child was started without an inherited door descriptor\n');
    // An unauthorized attempt spends nothing: the one-use token is still on disk.
    expect(existsSync(restoreInheritPath(home, door.nonce))).toBe(true);
    // Nothing was swept: the route's record is byte-identical and no pass report was written.
    expect(readFileSync(join(mainTeam.dir, 'team.state.json'), 'utf8')).toBe(stateBefore);
  }, 15_000);

  test.skipIf(!liveServiceManager)(
    'a forged claims file naming a non-daemon parent is refused with its secret matching, and nothing is swept',
    async () => {
      // The record names this process as the daemon, so the parent anchor passes; the claims file
      // forges pid 1. The daemon-pid cross-check refuses it before the one-use claim.
      const fake = fakeServiceRecord(join(base, 'service-daemon'), daemonPid, home);
      const door = writeRestoreDoor({ version: 1, home, root: mainTeam.root, daemonPid: 1 });
      const stateBefore = readFileSync(join(mainTeam.dir, 'team.state.json'), 'utf8');
      const ran = await runEntry(
        home,
        mainTeam.root,
        ['--inherited', door.nonce],
        restoreDoorText(door.nonce, door.secret),
        fake,
      );
      expect(ran.status).toBe(2);
      expect(ran.stdout).toBe('');
      expect(ran.stderr).toBe('team daemon: the restore token daemon pid does not match the service-managed machine daemon\n');
      expect(existsSync(restoreInheritPath(home, door.nonce))).toBe(true);
      expect(readFileSync(join(mainTeam.dir, 'team.state.json'), 'utf8')).toBe(stateBefore);
    },
    15_000,
  );

  test.skipIf(!liveServiceManager)(
    'a child the service record names another job for is refused and spends nothing',
    async () => {
      const fake = fakeServiceRecord(join(base, 'service-other'), daemonPid + 1, home);
      const door = writeRestoreDoor({ version: 1, home, root: mainTeam.root, daemonPid });
      const stateBefore = readFileSync(join(mainTeam.dir, 'team.state.json'), 'utf8');
      const ran = await runEntry(
        home,
        mainTeam.root,
        ['--inherited', door.nonce],
        restoreDoorText(door.nonce, door.secret),
        fake,
      );
      expect(ran.status).toBe(2);
      expect(ran.stdout).toBe('');
      expect(ran.stderr).toBe('team daemon: the restore child was not started directly by the service-managed machine daemon\n');
      expect(existsSync(restoreInheritPath(home, door.nonce))).toBe(true);
      expect(readFileSync(join(mainTeam.dir, 'team.state.json'), 'utf8')).toBe(stateBefore);
    },
    15_000,
  );

  test('a token for a home with no installed unit is refused unspent though the record names a running daemon', async () => {
    // The record names this process as the machine daemon and the claims name it too, so every
    // other door fact would line up; the only missing one is the home's own installed unit,
    // which `job(home)` now requires before it asks the manager at all. The refusal arrives
    // before the one-use claim, so the token stays.
    const bareHome = join(base, 'home-without-unit');
    mkdirSync(bareHome, { recursive: true });
    const fake = fakeServiceRecord(join(base, 'service-no-unit'), daemonPid);
    const door = writeRestoreDoor({ version: 1, home: bareHome, root: mainTeam.root, daemonPid });
    const stateBefore = readFileSync(join(mainTeam.dir, 'team.state.json'), 'utf8');
    const ran = await runEntry(
      bareHome,
      mainTeam.root,
      ['--inherited', door.nonce],
      restoreDoorText(door.nonce, door.secret),
      fake,
    );
    expect(ran.status).toBe(2);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toBe("team daemon: the system's service manager records no running machine daemon\n");
    expect(existsSync(restoreInheritPath(bareHome, door.nonce))).toBe(true);
    expect(readFileSync(join(mainTeam.dir, 'team.state.json'), 'utf8')).toBe(stateBefore);
  }, 15_000);

  test('a plist dropped into a scratch home is refused when the loaded job path is the machine unit', async () => {
    // The seat drops a unit into its own home and mints a token whose claims and secret line up
    // with the running machine daemon, but the manager's record says the loaded job runs from
    // the machine's unit, not the dropped one. The record and the home's unit must be the same
    // file, so `job(home)` answers null and the token is refused before its one-use claim.
    const droppedHome = join(base, 'home-with-dropped-plist');
    mkdirSync(droppedHome, { recursive: true });
    const machineUnitDir = join(base, 'machine-unit');
    mkdirSync(machineUnitDir, { recursive: true });
    const machineUnit = join(machineUnitDir, `${DAEMON_LABEL}.plist`);
    writeFileSync(
      machineUnit,
      `<plist version="1.0"><dict><key>Label</key><string>${DAEMON_LABEL}</string></dict></plist>\n`,
      { mode: 0o600 },
    );
    const fake = fakeServiceRecord(
      join(base, 'service-machine-unit'),
      daemonPid,
      droppedHome,
      realpathSync(machineUnit),
    );
    const door = writeRestoreDoor({ version: 1, home: droppedHome, root: mainTeam.root, daemonPid });
    const stateBefore = readFileSync(join(mainTeam.dir, 'team.state.json'), 'utf8');
    const ran = await runEntry(
      droppedHome,
      mainTeam.root,
      ['--inherited', door.nonce],
      restoreDoorText(door.nonce, door.secret),
      fake,
    );
    expect(ran.status).toBe(2);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toBe("team daemon: the system's service manager records no running machine daemon\n");
    expect(existsSync(restoreInheritPath(droppedHome, door.nonce))).toBe(true);
    expect(readFileSync(join(mainTeam.dir, 'team.state.json'), 'utf8')).toBe(stateBefore);
  }, 15_000);

  test.skipIf(!liveServiceManager)('a wrong secret is refused before the token is claimed, and nothing is swept', async () => {
    const fake = fakeServiceRecord(join(base, 'service-daemon-secret'), daemonPid, home);
    const door = writeRestoreDoor({ version: 1, home, root: mainTeam.root, daemonPid });
    const stateBefore = readFileSync(join(mainTeam.dir, 'team.state.json'), 'utf8');
    const ran = await runEntry(
      home,
      mainTeam.root,
      ['--inherited', door.nonce],
      restoreDoorText(door.nonce, 'f'.repeat(64)),
      fake,
    );
    expect(ran.status).toBe(2);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toBe('team daemon: the restore door secret does not match the token\n');
    expect(existsSync(restoreInheritPath(home, door.nonce))).toBe(true);
    expect(readFileSync(join(mainTeam.dir, 'team.state.json'), 'utf8')).toBe(stateBefore);
  }, 15_000);

  test.skipIf(!liveServiceManager)('an expired token is refused after its one-use claim, and no pass runs', async () => {
    const fake = fakeServiceRecord(join(base, 'service-daemon-expired'), daemonPid, home);
    const stale = new Date(Date.now() - 2 * 60 * 1000 - 60_000);
    const door = writeRestoreDoor({ version: 1, home, root: mainTeam.root, daemonPid, now: stale });
    const stateBefore = readFileSync(join(mainTeam.dir, 'team.state.json'), 'utf8');
    const ran = await runEntry(
      home,
      mainTeam.root,
      ['--inherited', door.nonce],
      restoreDoorText(door.nonce, door.secret),
      fake,
    );
    expect(ran.status).toBe(2);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toBe('team daemon: the restore token has expired\n');
    // Expiry is checked after the claim: the token is spent, but the route is untouched.
    expect(existsSync(restoreInheritPath(home, door.nonce))).toBe(false);
    expect(readFileSync(join(mainTeam.dir, 'team.state.json'), 'utf8')).toBe(stateBefore);
  }, 15_000);

  test.skipIf(!liveServiceManager)(
    'the service-named parent is admitted and the real spawn path runs the pass end to end',
    async () => {
      // A route with no recorded session answers from the state the pass read; the door is spent.
      const fake = fakeServiceRecord(join(base, 'service-daemon-spawn'), daemonPid, home);
      rmSync(join(mainTeam.dir, 'team.state.json'), { force: true });
      const savedPath = process.env.PATH;
      process.env.PATH = `${fake}:${savedPath ?? '/usr/bin:/bin'}`;
      try {
        const result = await runRestoreSweepInChild({ home, root: mainTeam.root, timeoutMs: 30_000 });
        expect(result).toEqual({ kind: 'no-recorded-session' });
      } finally {
        if (savedPath === undefined) delete process.env.PATH;
        else process.env.PATH = savedPath;
      }
      const leftovers = readdirSync(machineConfigDir(home)).filter((name) => name.startsWith('restore.inherit.'));
      expect(leftovers).toEqual([]);
    },
    30_000,
  );
});

describe('the restore sweep is reachable only from the daemon start', () => {
  test('no socket request and no chores frame naming the sweep reaches it', async () => {
    let sweeps = 0;
    const started = await startMachineDaemon({
      home,
      roots: [mainTeam.root],
      startedBy: 'test',
      version: '0.5.12-test',
      heartbeatMs: 10_000,
      restoreSweep: async () => {
        sweeps += 1;
        return { kind: 'ran', summary: ZERO_SUMMARY, failed: false };
      },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      await waitForLog(daemonLogPath(home), `restore ${mainTeam.root}: ${ZERO_SUMMARY.line}`, 3000);
      expect(sweeps).toBe(1);

      for (const op of ['restore', 'restore-sweep', 'up', 'runRestoreSweepForRoute']) {
        const answer = await askDaemon(daemonSocketPath(home), {
          v: DAEMON_PROTOCOL_VERSION,
          id: `probe-${op}`,
          op,
        });
        expect(answer).toMatchObject({
          v: DAEMON_PROTOCOL_VERSION,
          id: `probe-${op}`,
          ok: false,
          error: { code: 'daemon.unsupported-op' },
        });
      }
      await sleep(100);
      expect(sweeps).toBe(1);

      // The chores protocol drops any frame naming the sweep, on either side of the pipe.
      for (const type of ['restore', 'restore-sweep', 'up', 'runRestoreSweepForRoute']) {
        expect(readHostMessage({ type, id: '1', root: '/tmp', at: NOW.toISOString() })).toBeNull();
        expect(readChildMessage({ type, root: '/tmp', at: NOW.toISOString() })).toBeNull();
      }

      // The single-caller chain in the source: the pass has one caller (the door-checked child
      // entry), the door's descriptor and claims are minted only by the spawn path and accepted
      // only by the entry, and only the daemon start spawns the child.
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
      const callersOf = (needle: string, definition: string): string[] =>
        files
          .filter((file) => {
            const rel = relOf(file);
            return rel !== definition && readFileSync(file, 'utf8').includes(`${needle}(`);
          })
          .map(relOf);
      expect(callersOf('runRestoreSweepForRoute', 'launch/restore-sweep.ts')).toEqual(['daemon/restore/entry.ts']);
      expect(callersOf('writeRestoreDoor', 'daemon/restore/token.ts')).toEqual(['daemon/restore/spawn.ts']);
      expect(callersOf('restoreDoorText', 'daemon/restore/token.ts')).toEqual(['daemon/restore/spawn.ts']);
      expect(callersOf('acceptRestoreDoor', 'daemon/restore/token.ts')).toEqual(['daemon/restore/entry.ts']);
      expect(callersOf('readRestoreDoor', 'daemon/restore/token.ts')).toEqual(['daemon/restore/entry.ts']);
      expect(callersOf('runRestoreSweepInChild', 'daemon/restore/spawn.ts')).toEqual(['daemon/host.ts']);

      // The old unauthenticated claims reader is gone from the source and from the module's
      // exports, and the production entry takes the parent anchor from its own parent and the
      // live service manager rather than an injected record.
      const sourceText = files.map((file) => readFileSync(file, 'utf8')).join('\n');
      expect(sourceText).not.toContain('readRestoreInherit');
      expect(sourceText).not.toContain('writeRestoreInherit');
      const tokenExports = Object.keys(await import('../src/daemon/restore/token.ts'));
      expect(tokenExports).not.toContain('readRestoreInherit');
      expect(tokenExports).not.toContain('writeRestoreInherit');
      const entrySource = readFileSync(join(srcRoot, 'daemon', 'restore', 'entry.ts'), 'utf8');
      expect(entrySource).not.toContain('parentPid:');
      expect(entrySource).not.toContain('service:');
      const internalSeam = files.filter((file) => readFileSync(file, 'utf8').includes('UpInternal')).map(relOf);
      expect(internalSeam).toEqual(['commands/up.ts']);
    } finally {
      await started.daemon.close();
    }
  }, 20_000);
});
