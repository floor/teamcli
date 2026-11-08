// A migrated seat whose cwd is not "." starts in that folder. "." still waits in the lobby,
// and a cwd inside a protected checkout is still refused. Synthetic home and roots, stub hosts.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { realSources as restartSources, runRestart } from '../src/commands/restart.ts';
import { runUp, type Launch } from '../src/commands/up.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { seatStart } from '../src/worktree/place.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState, type SeatState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-08T00:00:00.000Z');
const SESSION = 'ses_own';
const HANDLE = 'seat_0123456789ab';

type Profile = {
  /** The scene name. kimi is the shipped claude-code profile's moonshot vendor: there is no kimi cli. */
  name: string;
  cli: string;
  vendor: string;
  model: string;
  version: string;
  launch: string;
  /** This CLI has a measured resume form, so a recorded conversation is put on the restart line. */
  resume: boolean;
};

const PROFILES: readonly Profile[] = [
  { name: 'codex', cli: 'codex', vendor: 'openai', model: 'GPT Sol', version: '6.1', launch: 'codex -m gpt-6.1-sol', resume: true },
  { name: 'claude-code', cli: 'claude-code', vendor: 'anthropic', model: 'Claude Opus', version: '5.5', launch: 'claude --model claude-opus-5-5', resume: true },
  { name: 'kimi', cli: 'claude-code', vendor: 'moonshot', model: 'Kimi K2.5', version: '2.5', launch: 'claude --model kimi-k2.5', resume: true },
  { name: 'agy', cli: 'antigravity', vendor: 'google', model: 'Gemini Flash', version: '3.8', launch: 'agy', resume: true },
  { name: 'cursor', cli: 'cursor', vendor: 'cursor', model: 'Composer', version: '2026.10.22', launch: 'cursor-agent', resume: false },
  { name: 'grok', cli: 'grok', vendor: 'xai', model: 'Grok', version: '4.7', launch: 'grok', resume: true },
  { name: 'jules', cli: 'jules', vendor: 'google', model: 'Gemini Pro', version: '4.0', launch: 'jules', resume: false },
];

function gitInit(cwd: string): void {
  const ran = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd, env: gitEnv() });
  if (ran.status !== 0) throw new Error(ran.stderr.toString() || 'git init failed');
}

function teamText(root: string, own: string, profile: Profile, cwd: string | null, home: string): string {
  const workerCwd = cwd === null ? '' : `\n    cwd: ${cwd}`;
  const seatFolder = cwd === '../own' ? realpathSync(resolve(root, '../own')) : own;
  return `format: 1
project: seatcwd
session: seatcwd
coordinator: lead
operator: lead
trust:
  - ${root}
  - ${seatFolder}
  - ${lobbyDir(home)}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: ${profile.name}
    cli: ${profile.cli}
    vendor: ${profile.vendor}
    model: ${profile.model}
    version: "${profile.version}"
    launch: ${profile.launch}${workerCwd}
`;
}

function scene(profile: Profile, cwd: string | null): { base: string; home: string; root: string; own: string; dir: string } {
  const base = fixtureBase(`seat-start-${profile.name}-`);
  const home = join(base, 'home');
  const root = join(base, 'repo');
  const own = join(base, 'own');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(own, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  chmodSync(lobbyDir(home), 0o700);
  gitInit(root);
  writeFileSync(join(dir, 'team.yaml'), teamText(root, own, profile, cwd, home));
  return { base, home, root, own, dir };
}

function discard(base: string): void {
  discardFixtures([base], { roots: [dirname(base)] });
}

function ownerIo(root: string) {
  const io = testIo(root, { kind: 'owner' });
  io.env = { ...io.env, TEAMCLI_DEV_MODE: '1' };
  return io;
}

function doctorOf(home: string): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    agentList: () => [],
    now: () => NOW,
    home,
    getuid: () => process.getuid?.() ?? 0,
    runCheck: () => null,
    standing: () => ({ kind: 'none' }),
    paneText: () => '',
    watchAlive: () => false,
    processComm: () => null,
    watchPane: () => null,
    command: () => ({ status: 0, stdout: '', stderr: '' }),
  };
}

function stubLaunch(): Launch {
  return {
    sessionState: () => 'absent',
    startServer: () => true,
    sessionUp: () => false,
    createWorkspace: () => ({ pane: 'pane-new', workspace: 'ws-new' }),
    paneRun: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [],
    agents: () => [],
    paneText: () => '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
    conversationExists: () => null,
    applySidebar: () => ({ kind: 'unchanged', reloaded: [], failed: [] }),
    checkSidebarConfig: () => ({ ok: true, text: '' }),
    reloadSidebar: () => ({ applied: true, text: '' }),
    recordSidebarReload: () => {},
    processStartOf: () => null,
    processInfo: () => null,
  };
}

function restartHost(home: string) {
  const { machine: _machine, codexThreads: _threads, launch: _launch, codexEndpoint: _endpoint, inboxRemove: _inbox, ...base } = restartSources;
  return {
    ...base,
    home,
    sessionRunning: () => true,
    sessionState: () => 'running' as const,
    agents: () => [],
    workspaces: () => [{ id: 'ws', label: 'ws' }],
    alive: () => false,
    commandOf: () => null,
    startOf: () => null,
    cwdOf: () => null,
    now: () => NOW,
    screen: () => ({ kind: 'idle' as const }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => ['claude'],
    shellBack: () => null,
    foregroundCwd: () => null,
    processes: () => null,
    workspacePanes: () => [],
    standing: () => ({ kind: 'none' as const }),
    doctor: doctorOf(home),
    upLaunch: stubLaunch(),
  };
}

function remember(held: { home: string; root: string; dir: string; own: string }, profile: Profile): void {
  updateState(held.dir, (state) => {
    const session = (state.sessions.seatcwd ??= emptySession());
    const recorded: SeatState = {
      stage: 'ready',
      id: HANDLE,
      start_cwd: resolve(held.root, '../own'),
      ...(profile.resume ? { agent_session: SESSION } : {}),
    };
    session.seats.worker = recorded;
  });
  if (!profile.resume) return;
  registerAgent(held.home, {
    name: 'worker',
    signing: { model: profile.model, version: profile.version, role: 'implementer' },
    lab: profile.vendor,
    cli: profile.cli,
    launcher: null,
    launch: profile.launch,
    reach: {
      team: teamIdOf(held.root),
      seat: 'worker',
      session: 'seatcwd',
      pane: null,
      address: null,
      agent_session: SESSION,
    },
    seat_handle: HANDLE,
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

async function plan(held: { home: string; root: string }, command: 'up' | 'restart'): Promise<{ code: number; out: string; err: string }> {
  const io = ownerIo(held.root);
  // The file check resolves a relative cwd from the process directory. The seat folder's
  // realpath is trusted, so the command runs from the project root, where that path is `../own`.
  const back = process.cwd();
  process.chdir(held.root);
  try {
    const code = command === 'up'
      ? await runUp(['--dry-run'], io, {
          home: held.home,
          sessionRunning: () => false,
          agents: () => [],
          now: () => NOW,
          alive: () => false,
          doctor: doctorOf(held.home),
          hostSessions: () => [],
          sidebarConfigText: () => '',
        })
      : await runRestart(['worker', '--dry-run'], io, restartHost(held.home));
    return { code, out: io.out, err: io.err };
  } finally {
    process.chdir(back);
  }
}

for (const profile of PROFILES) {
  test(`${profile.name} starts in its own folder on a fresh up and restart`, async () => {
    const held = scene(profile, '../own');
    try {
      const up = await plan(held, 'up');
      expect(up.code, up.err + up.out).toBe(0);
      expect(up.out).toContain(held.own);
      expect(up.out).not.toContain(`--cwd ${lobbyDir(held.home)}`);
      const restarted = await plan(held, 'restart');
      expect(restarted.code, restarted.err + restarted.out).toBe(0);
      expect(restarted.out).toContain(held.own);
      expect(restarted.out).not.toContain(`--cwd ${lobbyDir(held.home)}`);
    } finally {
      discard(held.base);
    }
  });

  test(`${profile.name} stays in its own folder when a previous start is recorded`, async () => {
    const held = scene(profile, '../own');
    try {
      remember(held, profile);
      const up = await plan(held, 'up');
      expect(up.code, up.err + up.out).toBe(0);
      expect(up.out).toContain(held.own);
      const restarted = await plan(held, 'restart');
      expect(restarted.code, restarted.err + restarted.out).toBe(0);
      expect(restarted.out).toContain(held.own);
      expect(restarted.out).not.toContain(`--cwd ${lobbyDir(held.home)}`);
      if (profile.resume) expect(restarted.out).toContain(SESSION);
    } finally {
      discard(held.base);
    }
  });
}

test('a cwd inside a protected checkout is still refused', async () => {
  const profile = PROFILES[1]!;
  const held = scene(profile, 'kept');
  try {
    mkdirSync(join(held.root, 'kept'), { recursive: true });
    const up = await plan(held, 'up');
    expect(up.code, up.err + up.out).not.toBe(0);
    expect(up.out + up.err).toContain('protected checkout');
    const restarted = await plan(held, 'restart');
    expect(restarted.code, restarted.err + restarted.out).not.toBe(0);
    expect(restarted.out + restarted.err).toContain('protected checkout');
  } finally {
    discard(held.base);
  }
});

/** A ready seat whose recorded start is exactly where `seatStart` would put it. */
async function noted(
  held: { home: string; root: string; dir: string; own: string },
  worktree?: string,
): Promise<{ code: number; out: string; err: string }> {
  const back = process.cwd();
  process.chdir(held.root);
  try {
    const loaded = readTeamConfig(held.root, { home: held.home });
    if (!loaded.ok) throw new Error(loaded.errors.map((problem) => problem.message).join('; '));
    const worker = loaded.team.seats.find((seat) => seat.name === 'worker');
    if (worker === undefined) throw new Error('no worker');
    const start = seatStart(loaded.team, worker, held.root, held.home, undefined, worktree);
    if ('problem' in start) throw new Error(start.problem);
    updateState(held.dir, (state) => {
      const session = (state.sessions.seatcwd ??= emptySession());
      session.seats.worker = {
        stage: 'ready',
        pane: 'pane-seat',
        workspace: 'w1',
        launched: { shell: 1, cli: [2] },
        start_cwd: start.cwd,
        id: HANDLE,
      };
      if (worktree !== undefined) session.worktrees.worker = { path: worktree, branch: 'main', setup: 'ok', seat: 'worker' };
    });
    const io = ownerIo(held.root);
    const code = await runUp(['--dry-run'], io, {
      home: held.home,
      sessionRunning: () => true,
      agents: () => [{ name: 'worker', agent: 'claude', pane: 'pane-seat', workspace: 'w1', status: 'idle', cwd: null }],
      now: () => NOW,
      alive: () => false,
      doctor: doctorOf(held.home),
      hostSessions: () => [],
      sidebarConfigText: () => '',
    });
    return { code, out: io.out, err: io.err };
  } finally {
    process.chdir(back);
  }
}

test('a channel seat recorded in its channel folder draws no own-folder relaunch note', async () => {
  const claude = PROFILES[1]!;
  const profile = { ...claude, launch: `${claude.launch} --dangerously-load-development-channels server:team-inbox` };
  const held = scene(profile, '../own');
  try {
    const run = await noted(held);
    const text = run.err + run.out;
    expect(run.code, text).toBe(0);
    expect(text).toContain('already ready');
    expect(text).not.toContain('own folder');
  } finally {
    discard(held.base);
  }
});

test('a grok seat with "." and a recorded worktree draws no lobby relaunch note', async () => {
  const profile = PROFILES.find((one) => one.cli === 'grok');
  if (profile === undefined) throw new Error('no grok profile');
  const held = scene(profile, null);
  try {
    const run = await noted(held, held.own);
    const text = run.err + run.out;
    expect(run.code, text).toBe(0);
    expect(text).toContain('already ready');
    expect(text).not.toContain('into the lobby');
  } finally {
    discard(held.base);
  }
});

test('a cwd of "." still starts in the lobby', async () => {
  const profile = PROFILES[1]!;
  const held = scene(profile, null);
  try {
    const lobby = lobbyDir(held.home);
    const up = await plan(held, 'up');
    expect(up.out + up.err, up.err).toContain(lobby);
    const restarted = await plan(held, 'restart');
    expect(restarted.out + restarted.err, restarted.err).toContain(lobby);
  } finally {
    discard(held.base);
  }
});
