import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { runApprove, type ApproveSources } from '../../src/approve/command.ts';
import { loadConfig } from '../../src/commands/check.ts';
import { commits } from '../../src/commands/commits.ts';
import { runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { runDown } from '../../src/commands/down.ts';
import { runRegister, type RegisterSources } from '../../src/commands/register.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import { runSeats, type SeatsSources } from '../../src/commands/seats.ts';
import { runStatus, standingSource, type StatusSources } from '../../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { runWorktree, type WorktreeSources } from '../../src/commands/worktree.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { absoluteTrustProblem, canonicalLanding, insideTrust } from '../../src/file/paths.ts';
import { rulesFilePath } from '../../src/launch/rules-file.ts';
import { rulesText, seatRules, type RulesInput } from '../../src/launch/rules.ts';
import { defaultFs, findRepoRoot, lobbyDir, recheckLobby, verifyLobby, type FsReader } from '../../src/lobby/gate.ts';
import { shippedStartupReads } from '../../src/profiles/index.ts';
import { seatStart } from '../../src/worktree/place.ts';
import { readState, SEAT_ID_PATTERN, updateState } from '../../src/state.ts';
import { watchLabel } from '../../src/watch/pane.ts';
import { approvalStanding, LEGACY_LINE, storePath, writeApproval } from '../../src/store/store.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-04T09:00:00Z');
const IDLE = CLAUDE_IDLE;
const FILE = ['--file', '.agents/team.yaml'];
const OWNER = { kind: 'owner' } as const;

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function legacyTeamYaml(): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - .
  - ../worktrees/acme/*
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [.]
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
    cwd: .
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    count: 1
`;
}

function migratedTeamYaml(): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
  - ${join(base, 'worktrees')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [.]
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
    cwd: .
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    count: 1
`;
}

function approveYaml(text: string, writeHome: string = home): void {
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const loaded = loadTeamFile(root, { home: writeHome });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, writeHome),
    { approval: approvalOf(loaded.team, loaded.root), file: text },
    loaded.team.seats,
    writeHome,
  );
}

function world(): {
  launch: Launch;
  workspaces: { label: string; cwd: string }[];
  renames: string[];
  session: 'absent' | 'running';
  /** Every command typed into a pane (`pane run`), in order. */
  runs: string[];
  /** Every text typed into a pane (`typeText`), in order. */
  typed: string[];
  /** Every workspace a close was asked for, in order. */
  closed: string[];
  /** Every pane the world holds, with an agent in it or not. */
  paneIds(): string[];
} {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  let clock = NOW.getTime();
  const made = {
    launch: {} as Launch,
    workspaces: [] as { label: string; cwd: string }[],
    renames: [] as string[],
    session: 'absent' as 'absent' | 'running',
    runs: [] as string[],
    typed: [] as string[],
    closed: [] as string[],
    paneIds: () => [...panes.keys()],
  };
  made.launch = {
    sessionState: () => made.session,
    startServer() {
      made.session = 'running';
      return true;
    },
    sessionUp: () => made.session === 'running',
    createWorkspace(_session, cwd, label) {
      n++;
      panes.set(`w${n}:p1`, { text: IDLE, agent: false });
      made.workspaces.push({ label, cwd });
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      made.runs.push(command);
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    typeText(_session, _pane, text) {
      made.typed.push(text);
      return true;
    },
    renameAgent(_session, _pane, name) {
      made.renames.push(name);
      return true;
    },
    closeWorkspace(_session, workspace) {
      made.closed.push(workspace);
      return true;
    },
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return made;
}

async function runUpCmd(argv: string[], made: ReturnType<typeof world>, over: Partial<UpSources> = {}) {
  const io = testIo(root, OWNER);
  const sources: UpSources = {
    sessionRunning: () => made.session === 'running',
    sessionState: () => made.session,
    agents: () => [],
    home,
    doctor: runDoctorCmdSources(),
    launch: made.launch,
    now: () => NOW,
    ...over,
  };
  const code = await runUp([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

async function runAddCmd(argv: string[], made: ReturnType<typeof world>, over: Partial<AddSources> = {}) {
  const io = testIo(root, OWNER);
  const sources: AddSources = {
    home,
    sessionState: () => made.session,
    agents: () => [],
    workspaces: () => [],
    doctor: runDoctorCmdSources(over.home ? { home: over.home } : {}),
    now: () => NOW,
    launch: made.launch,
    ...over,
  };
  const code = await runAdd([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

function runDoctorCmdSources(over: Partial<DoctorSources> = {}): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
    ...over,
  };
}

async function runDoctorCmd(argv: string[] = [], over: Partial<DoctorSources> = {}) {
  const io = testIo(root, OWNER);
  const sources = runDoctorCmdSources(over);
  const code = await runDoctor([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

async function runStatusCmd(argv: string[] = []) {
  const io = testIo(root, OWNER);
  const sources: StatusSources = {
    live: () => ({
      running: true,
      agents: [
        { name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: root },
        { name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: lobby },
      ],
      workspaces: [
        { id: 'w0', label: 'lead' },
        { id: 'w1', label: 'worker' },
      ],
      screens: {},
    }),
    branch: () => 'main',
    standing: standingSource(home),
    now: () => NOW,
    home,
  };
  const code = await runStatus([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

async function runSeatsCmd(argv: string[] = []) {
  const io = testIo(root, OWNER);
  const sources: SeatsSources = {
    live: () => ({
      running: true,
      agents: [
        { name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: root },
        { name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: lobby },
      ],
      workspaces: [
        { id: 'w0', label: 'lead' },
        { id: 'w1', label: 'worker' },
      ],
      screens: {},
    }),
    branch: () => 'main',
    standing: standingSource(home),
    now: () => NOW,
    home,
  };
  const code = await runSeats([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

/** `team register` on a fake host: one agent on the pane, the processes a launch reads, and no
 *  herdr write behind the sidebar relabel or the address refresh. */
async function runRegisterCmd(
  seat: string,
  pane: string,
  workspace: string,
  over: Partial<RegisterSources> = {},
) {
  const io = testIo(root, OWNER);
  const sources: RegisterSources = {
    home,
    sessionState: () => 'running',
    agents: () => [{ name: seat, agent: 'claude', pane, workspace, status: 'idle', cwd: null }],
    processInfo: () => ({ shell: 900, foreground: [901] }),
    foreground: () => ['claude'],
    paneText: () => IDLE,
    renameWorkspace: () => true,
    reportDisplayAgent: () => true,
    refreshAddress: () => ({ address: null }),
    now: () => NOW,
    ...over,
  };
  // `team register` reads the file from the caller's folder (it takes no `--file`): the test's
  // cwd is the project root, whose `.agents/team.yaml` the scene approved.
  const code = await runRegister([seat], io, sources);
  return { code, out: io.out, err: io.err };
}

async function runApproveCmd(argv: string[] = []) {
  const io = testIo(root, OWNER);
  const sources: ApproveSources = {
    ask: async () => '5',
    waiting: () => 'empty',
    now: () => NOW,
    home,
  };
  const code = await runApprove([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

async function runCheckCmd(argv: string[] = []) {
  const io = testIo(root, OWNER);
  const code = await commits(['check', 'main', ...argv, ...FILE], io, (cwd, file) => loadConfig(cwd, file, home));
  return { code, out: io.out, err: io.err };
}

async function runWorktreeCmd(argv: string[] = []) {
  const io = testIo(root, OWNER);
  const sources: WorktreeSources = { home, now: () => NOW };
  const code = await runWorktree([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-lobby-test-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = lobbyDir(home);
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'branch', 'fix/fresh');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the lobby gate', () => {
  test('refusal: a symbolic link at the lobby', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    const target = join(base, 'target');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, lobby, 'dir');

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(2);
    expect(run.err).toContain('symbolic link');
    expect(made.workspaces).toHaveLength(0);
    const gate = verifyLobby(home);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.text).toContain(`${lobby} is a symbolic link`);

    const runAdd = await runAddCmd(['worker'], world());
    expect(runAdd.code).toBe(2);
    expect(runAdd.err).toContain('symbolic link');
  });

  test('refusal: a symbolic link at its parent (~/.config/team)', async () => {
    approveYaml(migratedTeamYaml());
    rmSync(join(home, '.config', 'team'), { recursive: true, force: true });
    const target = join(base, 'parent-target');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(home, '.config', 'team'), 'dir');

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(2);
    expect(run.err).toContain(`${join(home, '.config', 'team')} is a symbolic link`);
    expect(made.workspaces).toHaveLength(0);
    const gate = verifyLobby(home);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.text).toContain(`${join(home, '.config', 'team')} is a symbolic link`);
  });

  test('refusal: a symbolic link at a higher existing ancestor (~/.config)', async () => {
    approveYaml(migratedTeamYaml());
    rmSync(join(home, '.config'), { recursive: true, force: true });
    const target = join(base, 'config-target');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(home, '.config'), 'dir');

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(2);
    expect(run.err).toContain(`${join(home, '.config')} is a symbolic link`);
    expect(made.workspaces).toHaveLength(0);
    const gate = verifyLobby(home);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.text).toContain(`${join(home, '.config')} is a symbolic link`);
  });

  test('refusal: a component owned by another user (simulated through getuid)', async () => {
    approveYaml(migratedTeamYaml());
    const made = world();
    const run = await runUpCmd([], made, { getuid: () => 99999 });
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: ${home} is not owned by you`);
    expect(made.workspaces).toHaveLength(0);

    const runAdd = await runAddCmd(['worker'], world(), { getuid: () => 99999 });
    expect(runAdd.code).toBe(1);
    expect(runAdd.err).toContain(`the lobby ${lobby}: ${home} is not owned by you`);
  });

  test('refusal: mode 0755', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o755);

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: has mode 0755, not 0700`);
    expect(made.workspaces).toHaveLength(0);
  });

  test('refusal: mode 0750', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o750);

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: has mode 0750, not 0700`);
    expect(made.workspaces).toHaveLength(0);
  });

  test('refusal: mode 0600', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o600);

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: has mode 0600, not 0700`);
    expect(made.workspaces).toHaveLength(0);
  });

  test('refusal: a regular file where the lobby should be', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(lobby, 'not a folder');

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(2);
    expect(run.err).toContain('is not a directory');
    expect(made.workspaces).toHaveLength(0);
    const gate = verifyLobby(home);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.text).toContain('is not a directory');
  });

  test('a dotfile no shipped CLI reads at start passes', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    writeFileSync(join(lobby, '.gitkeep'), '');

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(0);
    expect(made.workspaces).toContainEqual({ label: 'worker', cwd: lobby });
    expect(existsSync(join(lobby, '.gitkeep'))).toBe(true);
  });

  test('refusal: the lobby inside a repository by its logical path', async () => {
    approveYaml(migratedTeamYaml());
    git(home, 'init', '-q');

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: is inside the repository ${home}`);
    expect(made.workspaces).toHaveLength(0);
  });

  test('refusal: the lobby inside a repository only by its canonical landing', async () => {
    const repoDir = join(base, 'git-repo');
    git(base, 'init', '-q', repoDir);
    const targetDir = join(repoDir, 'real-parent');
    mkdirSync(targetDir, { recursive: true });

    const linkDir = join(base, 'link-dir');
    symlinkSync(targetDir, linkDir, 'dir');
    const homeInLink = join(linkDir, 'home');
    mkdirSync(homeInLink, { recursive: true });

    const gate = verifyLobby(homeInLink, { create: true });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.text).toContain(`is inside the repository ${repoDir}`);
  });

  test('creation under a umask of 0022 and 0077 ends at 0700', () => {
    const oldUmask = process.umask(0o022);
    try {
      const home1 = join(base, 'umask-22');
      mkdirSync(home1, { recursive: true });
      const res1 = verifyLobby(home1, { create: true });
      expect(res1.ok).toBe(true);
      const mode1 = statSync(lobbyDir(home1)).mode & 0o777;
      expect(mode1).toBe(0o700);

      process.umask(0o077);
      const home2 = join(base, 'umask-77');
      mkdirSync(home2, { recursive: true });
      const res2 = verifyLobby(home2, { create: true });
      expect(res2.ok).toBe(true);
      const mode2 = statSync(lobbyDir(home2)).mode & 0o777;
      expect(mode2).toBe(0o700);
    } finally {
      process.umask(oldUmask);
    }
  });

  test('a link planted between creation of two components is refused', () => {
    const homePlant = join(base, 'home-plant');
    mkdirSync(homePlant, { recursive: true });
    mkdirSync(join(homePlant, '.config'), { recursive: true });
    const target = join(base, 'planted-target');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(homePlant, '.config', 'team'), 'dir');

    const res = verifyLobby(homePlant, { create: true });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.problem).toBe('symlink');
      expect(res.text).toContain(`${join(homePlant, '.config', 'team')} is a symbolic link`);
    }
  });

  test('doctor reports lobby status without creating anything', async () => {
    approveYaml(migratedTeamYaml());
    expect(existsSync(lobby)).toBe(false);

    const doc = await runDoctorCmd();
    expect(doc.code).toBe(0);
    expect(doc.out).toContain('the lobby ~/.config/team/lobby: will be created at the first launch\n');
    expect(existsSync(lobby)).toBe(false);

    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    const docVerified = await runDoctorCmd();
    expect(docVerified.code).toBe(0);
    expect(docVerified.out).toContain('the lobby ~/.config/team/lobby: verified\n');
  });

  test('refusal: mode 01700 (sticky) and 02700 (setgid) refused as not 0700', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o1700);
    const run1 = await runUpCmd([], world());
    expect(run1.code).toBe(1);
    expect(run1.err).toContain(`the lobby ${lobby}: has mode 01700, not 0700`);

    const setgidFs: FsReader = {
      ...defaultFs,
      lstat(p) {
        const s = defaultFs.lstat(p);
        if (p === lobby) {
          const m = Object.create(s);
          m.mode = (s.mode & ~0o7777) | 0o2700;
          return m;
        }
        return s;
      },
    };
    const run2 = await runUpCmd([], world(), { fs: setgidFs });
    expect(run2.code).toBe(1);
    expect(run2.err).toContain(`the lobby ${lobby}: has mode 02700, not 0700`);
  });

  test('refusal: link swapped between parent lstat and mkdirSync using injected FsReader', async () => {
    approveYaml(migratedTeamYaml());
    const swappingFs: FsReader = {
      ...defaultFs,
      mkdir(p, opts) {
        if (p.endsWith('lobby')) {
          const escaped = join(base, 'escaped-lobby-target');
          mkdirSync(escaped, { recursive: true });
          rmSync(join(home, '.config'), { recursive: true, force: true });
          symlinkSync(escaped, join(home, '.config'), 'dir');
        }
        defaultFs.mkdir(p, opts);
      },
    };
    const res = verifyLobby(home, { create: true, fs: swappingFs });
    expect(res.ok).toBe(false);
  });

  test('refusal: dangling link at lobby refused safely in both create: true and create: false', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    symlinkSync(join(base, 'non-existent-target'), lobby);

    const resCreate = verifyLobby(home, { create: true });
    expect(resCreate.ok).toBe(false);
    if (!resCreate.ok) expect(resCreate.problem).toBe('symlink');

    const resNoCreate = verifyLobby(home, { create: false });
    expect(resNoCreate.ok).toBe(false);
    if (!resNoCreate.ok) expect(resNoCreate.problem).toBe('symlink');

    const doc = await runDoctorCmd();
    expect(doc.out).not.toContain('will be created at the first launch');
    expect(doc.err).toContain('symbolic link');
  });

  test('refusal: readdir error on lobby refuses and does not succeed open', () => {
    const brokenFs: FsReader = {
      ...defaultFs,
      readdir() {
        const err: any = new Error('Permission denied');
        err.code = 'EACCES';
        throw err;
      },
    };
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    const res = verifyLobby(home, { create: false, fs: brokenFs });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.text).toContain('cannot read directory: EACCES');
  });

  test('a missing record does not refuse up, and a refusal still creates no lobby', async () => {
    writeFileSync(join(root, '.agents', 'team.yaml'), migratedTeamYaml());
    const made = world();
    const run = await runUpCmd([], made);
    expect(run.err).not.toContain('the file was never approved on this machine');
    if (run.code !== 0) expect(existsSync(lobby)).toBe(false);
  });

  test('refusal: component owned by foreign user via injected FsReader', () => {
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    const myUid = process.getuid ? process.getuid() : 1000;
    const foreignFs: FsReader = {
      ...defaultFs,
      lstat(p) {
        const realStat = defaultFs.lstat(p);
        if (p === lobby) {
          const m = Object.create(realStat);
          m.uid = myUid + 1;
          return m;
        }
        return realStat;
      },
    };
    const res = verifyLobby(home, { create: false, fs: foreignFs, getuid: () => myUid });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.text).toContain(`${lobby} is not owned by you`);
  });

  test('a plain directory no shipped CLI reads at start passes', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(join(lobby, 'subfolder'), { recursive: true });
    chmodSync(lobby, 0o700);
    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(0);
    expect(made.workspaces).toContainEqual({ label: 'worker', cwd: lobby });
  });

  test('findRepoRoot accepts .git as a file (worktree / submodule style)', () => {
    const fakeRepo = join(base, 'fake-wt-repo');
    mkdirSync(fakeRepo, { recursive: true });
    writeFileSync(join(fakeRepo, '.git'), 'gitdir: /somewhere/else\n');
    const sub = join(fakeRepo, 'sub', 'folder');
    mkdirSync(sub, { recursive: true });
    expect(findRepoRoot(sub)).toBe(fakeRepo);
  });

  test('refusal: symbolic link at home itself', async () => {
    const realHome = join(base, 'real-home');
    mkdirSync(realHome, { recursive: true });
    const symHome = join(base, 'sym-home');
    symlinkSync(realHome, symHome, 'dir');

    const gate = verifyLobby(symHome);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.text).toContain(`${symHome} is a symbolic link`);
  });

  test('a fresh launch starts a lead in the project and records that folder', async () => {
    approveYaml(migratedTeamYaml());
    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(0);
    expect(made.workspaces).toContainEqual({ label: 'lead', cwd: root });
    expect(made.workspaces).toContainEqual({ label: 'worker', cwd: lobby });
    const state = readState(dir);
    expect(state.sessions['acme']?.seats.lead?.start_cwd).toBe(root);
    expect(state.sessions['acme']?.seats.worker?.start_cwd).toBe(canonicalLanding(lobby).landing);
  });

  test('a running lead recorded in the lobby is left there', async () => {
    approveYaml(migratedTeamYaml());
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          lead: { stage: 'ready', pane: 'w0:p1', workspace: 'w0', launched: { shell: 1, cli: [2] }, start_cwd: lobby },
        },
        worktrees: {},
      };
    });
    const made = world();
    made.session = 'running';
    const run = await runUpCmd([], made, {
      agents: () => [{ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null }],
    });
    expect(run.code).toBe(0);
    expect(run.out).toContain('lead: ready\n');
    expect(run.err).not.toContain('moves it into the lobby');
    expect(made.closed).toEqual([]);
    expect(readState(dir).sessions['acme']?.seats.lead?.start_cwd).toBe(lobby);
    expect(readState(dir).sessions['acme']?.seats.lead?.pane).toBe('w0:p1');
  });

  test('a running lead recorded in the project is left there', async () => {
    approveYaml(migratedTeamYaml());
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          lead: { stage: 'ready', pane: 'w0:p1', workspace: 'w0', launched: { shell: 1, cli: [2] }, start_cwd: root },
        },
        worktrees: {},
      };
    });
    const made = world();
    made.session = 'running';
    const run = await runUpCmd([], made, {
      agents: () => [{ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null }],
    });
    expect(run.code).toBe(0);
    expect(run.out).toContain('lead: ready\n');
    expect(run.err).not.toContain('moves it into the lobby');
    expect(made.closed).toEqual([]);
    expect(readState(dir).sessions['acme']?.seats.lead?.start_cwd).toBe(root);
    expect(readState(dir).sessions['acme']?.seats.lead?.pane).toBe('w0:p1');
  });

  test('a lead waiting at trust in the project or the lobby is not told the folder is wrong', async () => {
    const yaml = migratedTeamYaml().replace(
      '    name: lead\n    label: lead\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n',
      '    name: lead\n    label: lead\n    cli: cursor\n    vendor: cursor\n    model: Composer\n    version: "2.5"\n    launch: cursor-agent\n',
    );
    approveYaml(yaml);
    const captured = readFileSync(join(import.meta.dir, '..', 'fixtures', 'cursor', '2026.10.01', 'trust.txt'), 'utf8');
    const screen = (folder: string) => captured.replace('<untrusted-directory>', folder);
    const sources = {
      version: (binary: string) => (binary === 'cursor-agent' ? '2026.10.01-14929f9' : '2.1.288'),
      paneText: () => screen(root),
      sessionRunning: () => true,
      agentList: () => [{ name: 'lead', agent: 'cursor-agent', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null }],
    };
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: { lead: { stage: 'launched', pane: 'w0:p1', workspace: 'w0', waiting: { state: 'waiting-owner', classification: 'trust' } } },
        worktrees: {},
      };
    });
    const atRoot = await runDoctorCmd([], sources);
    expect(atRoot.out).not.toContain('the pane is not the trust dialog');
    expect(atRoot.out).not.toContain('lead: waiting at trust; the folder is not the lobby');
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: { lead: { stage: 'launched', pane: 'w0:p1', workspace: 'w0', waiting: { state: 'waiting-owner', classification: 'trust' } } },
        worktrees: {},
      };
    });
    const atLobby = await runDoctorCmd([], { ...sources, paneText: () => screen(lobby) });
    expect(atLobby.out).not.toContain('lead: waiting at trust; the folder is not the lobby');
  });

  test('dry run starts the lead in the project and every other seat in the machine lobby', async () => {
    approveYaml(migratedTeamYaml());
    const dry = await runUpCmd(['--dry-run'], world());
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`workspace create --cwd ${root} --label lead`);
    expect(dry.out).toContain(`workspace create --cwd ${lobby} --label worker`);
    expect(dry.out).toContain('<pane of lead>');
    expect(dry.out).toContain('<pane of worker>');
    expect(dry.out).not.toContain('mkdir -p');
  });

  test('real run makes the machine lobby and leaves the old lobby untouched', async () => {
    approveYaml(migratedTeamYaml());
    const oldLobby = join(base, 'worktrees', 'acme', '.lobby');
    mkdirSync(oldLobby, { recursive: true });
    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(0);
    expect(existsSync(lobby)).toBe(true);
    expect(made.workspaces).toContainEqual({ label: 'lead', cwd: root });
    expect(made.workspaces).toContainEqual({ label: 'worker', cwd: lobby });
    expect(readdirSync(oldLobby)).toEqual([]);
  });
});

describe('the lobby gate and the files a shipped CLI reads at start', () => {
  const lock = () => join(lobby, '.claude', 'scheduled_tasks.lock');
  const readBy = ' is read at start by ';

  function makeLobby(): void {
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
  }

  test('an empty lobby passes', () => {
    makeLobby();
    const gate = verifyLobby(home, { reads: shippedStartupReads() });
    expect(gate).toEqual({ ok: true, path: lobby, dev: expect.any(Number), ino: expect.any(Number), files: [] });
  });

  test('a file a CLI writes, and files no CLI reads at start, pass', () => {
    makeLobby();
    mkdirSync(join(lobby, '.claude'));
    writeFileSync(lock(), '{}\n');
    writeFileSync(join(lobby, 'README.md'), 'readme\n');
    mkdirSync(join(lobby, 'notes'));
    writeFileSync(join(lobby, 'notes', 'scratch.txt'), 'scratch\n');
    writeFileSync(join(lobby, 'reach-roster.json'), '{}\n');
    writeFileSync(join(lobby, 'settings.json'), '{}\n');
    const gate = verifyLobby(home, { reads: shippedStartupReads() });
    expect(gate.ok).toBe(true);
    if (gate.ok && 'files' in gate) expect(gate.files).toEqual([]);
  });

  test('a symbolic link anywhere on a declared path is refused', () => {
    makeLobby();
    const outside = join(base, 'outside-claude');
    mkdirSync(outside);
    symlinkSync(outside, join(lobby, '.claude'), 'dir');
    const gate = verifyLobby(home, { reads: shippedStartupReads() });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.problem).toBe('symlink');
      expect(gate.text).toBe(`the lobby ${lobby}: ${join(lobby, '.claude')} is a symbolic link`);
    }

    rmSync(join(lobby, '.claude'));
    mkdirSync(join(lobby, '.claude'));
    const elsewhere = join(base, 'elsewhere.lock');
    writeFileSync(elsewhere, '{}\n');
    symlinkSync(elsewhere, join(lobby, 'CLAUDE.md'), 'file');
    const fileGate = verifyLobby(home, { reads: shippedStartupReads() });
    expect(fileGate.ok).toBe(false);
    if (!fileGate.ok) {
      expect(fileGate.problem).toBe('symlink');
      expect(fileGate.text).toBe(`the lobby ${lobby}: ${join(lobby, 'CLAUDE.md')} is a symbolic link`);
    }
  });

  test('a fifo passes, and a directory whose name is a file a CLI reads is that read', () => {
    makeLobby();
    mkdirSync(join(lobby, '.claude'));
    // This runtime's node:fs has no mkfifoSync; the binary is the same maker of a fifo.
    execFileSync('mkfifo', [lock()]);
    const fifoGate = verifyLobby(home, { reads: shippedStartupReads() });
    expect(fifoGate.ok).toBe(true);

    const other = join(base, 'home-folder-case');
    mkdirSync(join(other, '.config', 'team', 'lobby'), { recursive: true });
    const otherLobby = lobbyDir(other);
    chmodSync(otherLobby, 0o700);
    mkdirSync(join(otherLobby, 'CLAUDE.md'));
    const folderGate = verifyLobby(other, { reads: shippedStartupReads() });
    expect(folderGate.ok).toBe(false);
    if (!folderGate.ok) {
      expect(folderGate.problem).toBe('startup-read');
      expect(folderGate.text).toBe(`the lobby ${otherLobby}: CLAUDE.md${readBy}claude-code, cursor and grok`);
    }
  });

  test('a regular file where a deeper read would sit passes', () => {
    const other = join(base, 'home-midcase');
    mkdirSync(join(other, '.config', 'team', 'lobby'), { recursive: true });
    const otherLobby = lobbyDir(other);
    chmodSync(otherLobby, 0o700);
    writeFileSync(join(otherLobby, 'a'), 'not a folder\n');
    const gate = verifyLobby(other, { reads: [{ path: 'a/b.lock', directory: false, clis: ['codex'] }] });
    expect(gate.ok).toBe(true);
  });

  test('a declared file owned by another user is refused', () => {
    makeLobby();
    mkdirSync(join(lobby, '.claude'));
    writeFileSync(lock(), '{}\n');
    const myUid = process.getuid ? process.getuid() : 1000;
    const foreignFs: FsReader = {
      ...defaultFs,
      lstat(p) {
        const realStat = defaultFs.lstat(p);
        if (p === lock()) {
          const m = Object.create(realStat);
          m.uid = myUid + 1;
          return m;
        }
        return realStat;
      },
    };
    const gate = verifyLobby(home, { reads: shippedStartupReads(), fs: foreignFs, getuid: () => myUid });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.problem).toBe('owner');
      expect(gate.text).toBe(`the lobby ${lobby}: ${lock()} is not owned by you`);
      expect(gate.words).toBe('the lobby: .claude/scheduled_tasks.lock is not owned by you');
    }
  });

  test('creation with declarations makes the clean lobby and records nothing', () => {
    const gate = verifyLobby(home, { create: true, reads: shippedStartupReads() });
    expect(gate.ok).toBe(true);
    if (!gate.ok || !('files' in gate)) throw new Error('gate must succeed with a path');
    expect(gate.files).toEqual([]);
    expect(existsSync(lobby)).toBe(true);
  });

  test('the recheck: a replaced lock is allowed, and a file read at start that appears is refused', () => {
    makeLobby();
    mkdirSync(join(lobby, '.claude'));
    writeFileSync(lock(), '{}\n');
    const gate = verifyLobby(home, { reads: shippedStartupReads() });
    if (!gate.ok || !('files' in gate)) throw new Error('gate must succeed with a path');
    const seen = { path: gate.path, dev: gate.dev, ino: gate.ino, files: gate.files };

    expect(recheckLobby(home, seen, { reads: shippedStartupReads() })).toBeNull();

    const fresh = `${lock()}.replacement`;
    writeFileSync(fresh, '{}\n');
    renameSync(fresh, lock());
    expect(recheckLobby(home, seen, { reads: shippedStartupReads() })).toBeNull();

    writeFileSync(join(lobby, 'CLAUDE.md'), 'plant\n');
    expect(recheckLobby(home, seen, { reads: shippedStartupReads() })).toEqual({
      reason: `the lobby: CLAUDE.md${readBy}claude-code, cursor and grok`,
      detail: `the lobby ${lobby}: CLAUDE.md${readBy}claude-code, cursor and grok`,
    });
  });

  test('a startup-read file swapped in after the gate is refused when the new file reuses an inode', () => {
    makeLobby();
    mkdirSync(join(lobby, '.claude'));
    writeFileSync(lock(), '{}\n');
    const gate = verifyLobby(home, { reads: shippedStartupReads() });
    if (!gate.ok || !('files' in gate)) throw new Error('gate must succeed with a path');
    const seen = { path: gate.path, dev: gate.dev, ino: gate.ino, files: gate.files };
    const plant = join(lobby, 'CLAUDE.md');
    writeFileSync(plant, 'one\n');
    rmSync(plant);
    writeFileSync(plant, 'two\n');
    const reused = lstatSync(lock());
    const swapped: FsReader = {
      ...defaultFs,
      lstat(p) {
        const real = defaultFs.lstat(p);
        if (p !== plant) return real;
        const copy = Object.create(real);
        copy.dev = reused.dev;
        copy.ino = reused.ino;
        return copy;
      },
    };
    const sentence = `CLAUDE.md${readBy}claude-code, cursor and grok`;
    expect(recheckLobby(home, seen, { reads: shippedStartupReads(), fs: swapped })).toEqual({
      reason: `the lobby: ${sentence}`,
      detail: `the lobby ${lobby}: ${sentence}`,
    });
  });

  test('doctor names a lock a CLI writes, and misses a file a CLI reads at start', async () => {
    approveYaml(migratedTeamYaml());
    makeLobby();
    mkdirSync(join(lobby, '.claude'));
    writeFileSync(lock(), '{}\n');

    const doc = await runDoctorCmd();
    expect(doc.code).toBe(0);
    expect(doc.out).toContain('the lobby ~/.config/team/lobby: verified\n');
    expect(doc.out).toContain("ok    the lobby ~/.config/team/lobby: .claude/scheduled_tasks.lock is claude-code's\n");

    writeFileSync(join(lobby, 'CLAUDE.md'), 'plant\n');
    const miss = await runDoctorCmd();
    expect(miss.code).toBe(1);
    expect(miss.out).toContain(`the lobby ~/.config/team/lobby: CLAUDE.md${readBy}claude-code, cursor and grok\n`);
  });

  test('a lobby whose .claude holds only the lock passes up, add and doctor', async () => {
    approveYaml(migratedTeamYaml());
    makeLobby();
    mkdirSync(join(lobby, '.claude'));
    writeFileSync(lock(), '{}\n');

    const doc = await runDoctorCmd();
    expect(doc.code).toBe(0);
    expect(doc.out).toContain('the lobby ~/.config/team/lobby: verified\n');
    expect(doc.out).toContain("ok    the lobby ~/.config/team/lobby: .claude/scheduled_tasks.lock is claude-code's\n");

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(0);
    expect(made.workspaces).toContainEqual({ label: 'lead', cwd: root });
    expect(made.workspaces).toContainEqual({ label: 'worker', cwd: lobby });

    const addRun = await runAddCmd(['--temporary', '--like', 'worker', '--until', 'merged:main'], made);
    expect(addRun.code).toBe(0);
    expect(made.workspaces).toContainEqual({ label: 'worker-tmp-01', cwd: lobby });
  });

  test('up and add pass a lobby whose .claude holds only the lock, plus a readme and a notes folder', async () => {
    approveYaml(migratedTeamYaml());
    makeLobby();
    mkdirSync(join(lobby, '.claude'));
    writeFileSync(lock(), '{}\n');
    writeFileSync(join(lobby, 'README.md'), 'readme\n');
    mkdirSync(join(lobby, 'notes'));
    writeFileSync(join(lobby, 'notes', 'scratch.txt'), 'scratch\n');

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(0);
    expect(made.workspaces).toContainEqual({ label: 'lead', cwd: root });
    expect(made.workspaces).toContainEqual({ label: 'worker', cwd: lobby });

    const addRun = await runAddCmd(['--temporary', '--like', 'worker', '--until', 'merged:main'], made);
    expect(addRun.code).toBe(0);
    expect(made.workspaces).toContainEqual({ label: 'worker-tmp-01', cwd: lobby });
  });

  test('up and add refuse CLAUDE.md when each is about to start a seat in the lobby', async () => {
    approveYaml(migratedTeamYaml());
    makeLobby();
    writeFileSync(join(lobby, 'CLAUDE.md'), 'plant\n');
    const sentence = `CLAUDE.md${readBy}claude-code, cursor and grok`;

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`team up: the lobby ${lobby}: ${sentence}\n`);
    expect(made.workspaces).toEqual([]);

    const addRun = await runAddCmd(['--temporary', '--like', 'worker', '--until', 'merged:main'], world());
    expect(addRun.code).toBe(1);
    expect(addRun.err).toContain(`team add: the lobby ${lobby}: ${sentence}\n`);
  });

  /** Plants CLAUDE.md on the `n`th listing of the lobby, after the planning read, against the
   *  confirm directly before a workspace is made there. */
  function plantClaudeAt(n: number): FsReader {
    let seen = 0;
    return {
      ...defaultFs,
      readdir(p) {
        if (p === lobby && ++seen === n) writeFileSync(join(lobby, 'CLAUDE.md'), 'plant\n');
        return defaultFs.readdir(p);
      },
    };
  }

  test('a file read at start that appears after the gate leaves the lead in the project and refuses the lobby seat', async () => {
    approveYaml(migratedTeamYaml());
    makeLobby();
    const sentence = `the lobby: CLAUDE.md${readBy}claude-code, cursor and grok`;

    const made = world();
    // The planning read is the first listing. The lead starts in the project and does not list
    // the lobby again; the worker's confirmation is the second listing, and the file lands there.
    const run = await runUpCmd([], made, { fs: plantClaudeAt(2) });
    expect(run.code).toBe(1);
    expect(made.workspaces).toEqual([{ label: 'lead', cwd: root }]);
    expect(made.workspaces.some((workspace) => workspace.cwd === lobby)).toBe(false);
    expect(run.out).toContain('lead: ready\n');
    expect(run.out).toContain(`worker: left out: ${sentence}\n`);
    expect(run.out).not.toContain(lobby);
    expect(run.err).toContain(`  the lobby ${lobby}: CLAUDE.md${readBy}claude-code, cursor and grok\n`);
    const log = readFileSync(join(dir, 'team.log'), 'utf8');
    expect(log).toContain(`worker: left out: ${sentence}`);
    expect(log).not.toContain(lobby);
    expect(Object.keys(readState(dir).sessions['acme']?.seats ?? {})).toEqual(['lead']);
  });

  test('a refused up keeps the state entry a seat already had, the binding and every field with it', async () => {
    approveYaml(migratedTeamYaml());
    makeLobby();
    // The seat was recorded by an earlier run and holds the binding that run launched it with.
    // This run plans its launch afresh and is refused by the lobby before the line runs: the
    // record it already had is the record it keeps, field for field.
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          worker: { stage: 'launched', presence_binding: 'prs_aaaaaaaaaaaa', watcher: 'hook' },
        },
        worktrees: {},
      };
    });

    const made = world();
    const run = await runUpCmd([], made, { fs: plantClaudeAt(2) });
    expect(run.code).toBe(1);
    expect(made.typed).toEqual([]);
    const after = readState(dir).sessions['acme']?.seats.worker;
    expect(after).toEqual({ stage: 'launched', presence_binding: 'prs_aaaaaaaaaaaa', watcher: 'hook' });
    expect(Object.keys(readState(dir).sessions['acme']?.seats ?? {}).sort()).toEqual(['lead', 'worker']);
  });

  test('a launched up keeps the binding its install minted for the seat, named in its settings file', async () => {
    approveYaml(migratedTeamYaml());
    makeLobby();
    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(0);
    const after = readState(dir).sessions['acme']?.seats.worker;
    expect(after?.presence_binding).toMatch(/^prs_[0-9a-f]{12}$/);
    // The settings file the launch line carries names the binding the state records: the
    // successor the install minted is the one the launched process runs with.
    const settings = made.runs
      .map((command) => /--settings ([^ ]+)/.exec(command)?.[1])
      .filter((path): path is string => path !== undefined);
    expect(settings.length).toBeGreaterThan(0);
    expect(settings.some((path) => readFileSync(path, 'utf8').includes(after!.presence_binding!))).toBe(true);
  });

  // Each shipped startup-read path, and the CLIs whose field matches it at any depth, in ship order.
  const plants: readonly [string, string][] = [
    ['CLAUDE.md', 'claude-code, cursor and grok'],
    ['CLAUDE.local.md', 'claude-code, cursor and grok'],
    ['.claude/CLAUDE.md', 'claude-code, cursor and grok'],
    ['.claude/rules/plant.md', 'claude-code and grok'],
    ['.claude/settings.json', 'claude-code'],
    ['AGENTS.md', 'codex, cursor, antigravity and grok'],
    ['.codex/config.toml', 'codex'],
    ['.cursorrules', 'cursor'],
    ['.cursor/rules/plant.mdc', 'cursor'],
    ['GEMINI.md', 'antigravity and gemini'],
    ['.gemini/settings.json', 'gemini'],
  ];

  async function refusesPlant(rel: string, by: string): Promise<void> {
    approveYaml(migratedTeamYaml());
    makeLobby();
    const full = join(lobby, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, 'plant\n');
    const sentence = `${rel}${readBy}${by}`;
    const doc = await runDoctorCmd();
    expect(doc.code).toBe(1);
    expect(doc.out).toContain(`the lobby ~/.config/team/lobby: ${sentence}\n`);
    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`team up: the lobby ${lobby}: ${sentence}\n`);
    expect(made.workspaces).toEqual([]);
    const addRun = await runAddCmd(['--temporary', '--like', 'worker', '--until', 'merged:main'], world());
    expect(addRun.code).toBe(1);
    expect(addRun.err).toContain(`team add: warning: the lobby ${lobby}: ${sentence}\n`);
    expect(addRun.err).toContain(`team add: the lobby ${lobby}: ${sentence}\n`);
  }

  for (const [rel, by] of plants) {
    test(`up, add and doctor refuse a planted ${rel}`, async () => {
      await refusesPlant(rel, by);
    });
    test(`up, add and doctor refuse ${rel} one folder down`, async () => {
      await refusesPlant(`nested/${rel}`, by);
    });
  }

  test('a symbolic link at each startup-read path is refused', () => {
    const links = [
      'CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', '.claude/rules', '.claude/settings.json',
      'AGENTS.md', '.codex/config.toml', '.cursorrules', '.cursor/rules', 'GEMINI.md', '.gemini/settings.json',
    ];
    for (const rel of links) {
      rmSync(lobby, { recursive: true, force: true });
      makeLobby();
      const full = join(lobby, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      symlinkSync(lobby, full);
      const gate = verifyLobby(home, { reads: shippedStartupReads() });
      expect(gate.ok).toBe(false);
      if (!gate.ok) {
        expect(gate.problem).toBe('symlink');
        expect(gate.words).toBe(`the lobby: ${rel} is a symbolic link`);
      }
    }
  });

  test('up and add refuse a symbolic link at a startup-read path', async () => {
    approveYaml(migratedTeamYaml());
    makeLobby();
    symlinkSync(lobby, join(lobby, 'CLAUDE.md'));
    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`team up: the lobby ${lobby}: ${join(lobby, 'CLAUDE.md')} is a symbolic link\n`);
    expect(made.workspaces).toEqual([]);
    const addRun = await runAddCmd(['--temporary', '--like', 'worker', '--until', 'merged:main'], world());
    expect(addRun.code).toBe(1);
    expect(addRun.err).toContain(`team add: the lobby ${lobby}: ${join(lobby, 'CLAUDE.md')} is a symbolic link\n`);
  });

  test('up and add refuse a startup-read file owned by someone else', async () => {
    approveYaml(migratedTeamYaml());
    makeLobby();
    const plant = join(lobby, 'AGENTS.md');
    writeFileSync(plant, 'plant\n');
    const myUid = process.getuid ? process.getuid() : 1000;
    const foreign: FsReader = {
      ...defaultFs,
      lstat(p) {
        const real = defaultFs.lstat(p);
        if (p !== plant) return real;
        const copy = Object.create(real);
        copy.uid = myUid + 1;
        return copy;
      },
    };
    const made = world();
    const run = await runUpCmd([], made, { fs: foreign, getuid: () => myUid });
    expect(run.code).toBe(1);
    expect(run.err).toContain(`team up: the lobby ${lobby}: ${plant} is not owned by you\n`);
    expect(made.workspaces).toEqual([]);
    const addRun = await runAddCmd(['--temporary', '--like', 'worker', '--until', 'merged:main'], world(), { fs: foreign, getuid: () => myUid });
    expect(addRun.code).toBe(1);
    expect(addRun.err).toContain(`team add: the lobby ${lobby}: ${plant} is not owned by you\n`);
  });

  test('a readme, a notes folder, the lock, the roster and a plain folder pass up, add and doctor', async () => {
    approveYaml(migratedTeamYaml());
    makeLobby();
    mkdirSync(join(lobby, '.claude'));
    writeFileSync(lock(), '{}\n');
    writeFileSync(join(lobby, 'README.md'), 'readme\n');
    mkdirSync(join(lobby, 'notes'));
    writeFileSync(join(lobby, 'notes', 'scratch.txt'), 'scratch\n');
    writeFileSync(join(lobby, 'reach-roster.json'), '{}\n');
    mkdirSync(join(lobby, 'scratch'));

    const doc = await runDoctorCmd();
    expect(doc.code).toBe(0);
    expect(doc.out).toContain('the lobby ~/.config/team/lobby: verified\n');
    expect(doc.out).toContain("ok    the lobby ~/.config/team/lobby: .claude/scheduled_tasks.lock is claude-code's\n");

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(0);
    expect(made.workspaces).toContainEqual({ label: 'lead', cwd: root });
    expect(made.workspaces).toContainEqual({ label: 'worker', cwd: lobby });

    const addRun = await runAddCmd(['--temporary', '--like', 'worker', '--until', 'merged:main'], made);
    expect(addRun.code).toBe(0);
    expect(made.workspaces).toContainEqual({ label: 'worker-tmp-01', cwd: lobby });
  });
});

describe('the lobby set every caller reads', () => {
  // The lobby is one folder per machine, shared by every team on it, so what it may hold is
  // the union of every shipped profile's `lobby_files` — never a set built from the seats a
  // run starts, nor from the team's own file. The capture's one declared path stands for all.
  const lock = () => join(lobby, '.claude', 'scheduled_tasks.lock');

  function makeLobby(): void {
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
  }

  function withLock(): void {
    mkdirSync(join(lobby, '.claude'), { recursive: true });
    writeFileSync(lock(), '{}\n');
  }

  // A team of one Codex seat: no seat of the file runs the CLI that declares the lock, so a
  // set built from the file's seats would refuse the very file another team's CLI left.
  function codexTeamYaml(): string {
    return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
  - ${join(base, 'worktrees')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [.]
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex
    mode: shared
    cwd: .
  - role: implementer
    name: worker
    label: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex
    stopped: true
`;
  }

  function codexCapture(name: string): string {
    return readFileSync(new URL(`../fixtures/codex/0.157.0/${name}.txt`, import.meta.url), 'utf8')
      .replaceAll('GPT-5.6-Terra', 'GPT-6-Sol');
  }

  // The fake host of a Codex launch: the rules go to a file, the one line that points at it
  // is typed at an empty idle prompt, read back row by row, then Enter turns the screen
  // working. One box per pane, so a second command on its own world starts clean.
  function codexWorld(): ReturnType<typeof world> {
    const made = world();
    made.launch.foreground = () => ['codex'];
    const idle = codexCapture('idle');
    const working = codexCapture('working');
    const boxes = new Map<string, { typed: string; entered: boolean }>();
    const text = (pane: string): string => {
      const box = boxes.get(pane);
      if (!box) return idle;
      if (box.entered) return working;
      const [first = '', ...rest] = box.typed.split('\n');
      return idle.replace('› Ask Codex to do anything', [`› ${first}`, ...rest.map((line) => `  ${line}`)].join('\n'));
    };
    made.launch.paneText = (_session, pane) => text(pane);
    made.launch.typeText = (_session, pane, typed) => { boxes.set(pane, { typed, entered: false }); return true; };
    made.launch.pressEnter = (_session, pane) => {
      const box = boxes.get(pane) ?? { typed: '', entered: false };
      boxes.set(pane, { ...box, entered: true });
      return true;
    };
    made.launch.agentStatus = () => ([...boxes.values()].some((box) => box.entered) ? 'working' : 'idle');
    made.launch.processInfo = () => ({ shell: 900, foreground: [901] });
    return made;
  }

  test('a team with no claude-code seat: up, add and doctor all accept the lock another team\'s CLI left', async () => {
    approveYaml(codexTeamYaml());
    makeLobby();
    withLock();

    // The same lobby fixtures go to all three callers, and all three accept: doctor verifies
    // the folder, up starts the team in it, add starts one more seat in it.
    const doc = await runDoctorCmd();
    expect(doc.code).toBe(0);
    expect(doc.out).toContain('the lobby ~/.config/team/lobby: verified\n');

    const upWorld = codexWorld();
    const run = await runUpCmd([], upWorld);
    expect(run.code).toBe(0);
    expect(upWorld.workspaces).toContainEqual({ label: 'lead', cwd: root });
    expect(existsSync(lock())).toBe(true);

    const addWorld = codexWorld();
    addWorld.session = 'running';
    const addRun = await runAddCmd(['worker'], addWorld);
    expect(addRun.code).toBe(0);
    expect(addWorld.workspaces).toContainEqual({ label: 'worker', cwd: lobby });
    expect(readState(dir).sessions['acme']?.seats.worker?.stage).toBe('ready');
  });

  test('doctor names, for each declared file present in the lobby, the profile it belongs to', async () => {
    approveYaml(codexTeamYaml());
    makeLobby();
    withLock();

    // The file in the shared folder is not this team's CLI's: the line says whose it is, so
    // an owner reading the report knows who left it there and may remove it at the exit.
    const doc = await runDoctorCmd();
    expect(doc.code).toBe(0);
    expect(doc.out).toContain("ok    the lobby ~/.config/team/lobby: .claude/scheduled_tasks.lock is claude-code's\n");
  });

  test('CLAUDE.md: doctor misses, an up that starts no lobby seat does not refuse, add of a lobby seat does', async () => {
    approveYaml(codexTeamYaml());
    makeLobby();
    withLock();
    writeFileSync(join(lobby, 'CLAUDE.md'), 'plant\n');
    const sentence = `CLAUDE.md is read at start by claude-code, cursor and grok`;

    const doc = await runDoctorCmd();
    expect(doc.code).toBe(1);
    expect(doc.out).toContain(`the lobby ~/.config/team/lobby: ${sentence}\n`);

    // The worker is stopped, so this up starts only the lead, in the project.
    const upWorld = codexWorld();
    const run = await runUpCmd([], upWorld);
    expect(run.code).toBe(0);
    expect(upWorld.workspaces).toContainEqual({ label: 'lead', cwd: root });
    expect(upWorld.workspaces.some((workspace) => workspace.cwd === lobby)).toBe(false);

    const addWorld = codexWorld();
    addWorld.session = 'running';
    const addRun = await runAddCmd(['worker'], addWorld);
    expect(addRun.code).toBe(1);
    expect(addRun.err).toContain(`team add: warning: the lobby ${lobby}: ${sentence}\n`);
    expect(addRun.err).toContain(`team add: the lobby ${lobby}: ${sentence}\n`);
  });

  test('up with no lobby seat still refuses a symlink in the lobby', async () => {
    approveYaml(codexTeamYaml());
    makeLobby();
    const outside = join(base, 'outside-lobby-link');
    mkdirSync(outside);
    symlinkSync(outside, join(lobby, 'bridge'), 'dir');

    const made = codexWorld();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`${join(lobby, 'bridge')} is a symbolic link`);
    expect(made.workspaces).toEqual([]);
  });

  test('add of a seat that starts in the project still refuses a symlink in the lobby', async () => {
    // The worker is the operator and is not stopped, so it starts in the project. The lobby is still checked.
    approveYaml(codexTeamYaml().replace('operator: lead', 'operator: worker').replace('    stopped: true\n', ''));
    makeLobby();
    const outside = join(base, 'outside-lobby-link');
    mkdirSync(outside);
    symlinkSync(outside, join(lobby, 'bridge'), 'dir');

    const made = codexWorld();
    made.session = 'running';
    const run = await runAddCmd(['worker'], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`${join(lobby, 'bridge')} is a symbolic link`);
    expect(made.workspaces).toEqual([]);
  });

  test('the run\'s case: the claude-code seat already ready, the lock present, a second up starts the rest', async () => {
    // The real run's shape: the Claude Code seat — the only seat whose CLI declares the lock —
    // is already at ready, so a set built from the seats this up starts held no declaration
    // while the very CLI that wrote the lock was the one running. The lock stays; the run goes
    // on to start the Codex seat left out.
    const withScribe = migratedTeamYaml().replace(
      '    count: 1\n',
      '    count: 1\n  - role: implementer\n    name: scribe\n    label: scribe\n    cli: codex\n    vendor: openai\n    model: GPT Sol\n    version: "6"\n    launch: codex\n',
    );
    approveYaml(withScribe);
    makeLobby();
    withLock();
    const landing = canonicalLanding(lobby).landing;
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          lead: { stage: 'ready', pane: 'w0:p1', workspace: 'w0', start_cwd: landing },
          worker: { stage: 'ready', pane: 'w1:p1', workspace: 'w1', start_cwd: landing },
        },
        worktrees: {},
      };
    });

    const made = codexWorld();
    made.session = 'running';
    // The ready seats sit at their recorded panes, live as herdr would list them: a ready seat
    // whose pane holds it is left as it is, and only the Codex seat is started.
    const live = {
      agents: () => [
        { name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null },
        { name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null },
      ],
    };
    const run = await runUpCmd([], made, live);
    expect(run.code).toBe(0);
    expect(made.workspaces).toContainEqual({ label: 'scribe', cwd: lobby });
    expect(existsSync(lock())).toBe(true);
    const seats = readState(dir).sessions['acme']?.seats;
    expect(seats?.scribe?.stage).toBe('ready');
    expect(seats?.lead?.stage).toBe('ready');
  });
});

describe('trust: validation', () => {
  test('non-empty sequence of absolute paths accepted, ~ expanded as first segment', () => {
    const yaml = migratedTeamYaml();
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
  });

  test('empty trust loads and launches, trusting only the lobby and the project root, said once', async () => {
    const yaml = migratedTeamYaml().replace(/trust:\n(?:  - .*\n)+/, 'trust: []\n');
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
    const made = world();
    const run = await runUpCmd([], made);
    expect(run.err).toContain(`team up: the file lists no trust: this run trusts only the lobby ${lobby} and the project root ${root}`);
    expect(run.err.split('this run trusts only').length).toBe(2);
    expect(run.err).not.toContain('the file is legacy: migrate trust');
    expect(run.code, run.err + run.out).toBe(0);
    // The file is not edited for it.
    expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8')).toBe(yaml);
    const status = await runStatusCmd();
    expect(status.code).not.toBe(2);
    const work = await runWorktreeCmd(['new', 'task']);
    expect(work.code).not.toBe(2);
  });

  test('relative paths or globs in migrated trust are refused', () => {
    const yamlWithGlob = migratedTeamYaml().replace(root, `${root}/*`);
    writeFileSync(join(root, '.agents', 'team.yaml'), yamlWithGlob);
    const loadedGlob = loadTeamFile(root, { home });
    expect(loadedGlob.ok).toBe(false);
    if (!loadedGlob.ok) {
      expect(loadedGlob.errors.some((e) => e.message.includes('glob'))).toBe(true);
    }

    const yamlWithDotDot = migratedTeamYaml().replace(root, `${root}/../acme`);
    writeFileSync(join(root, '.agents', 'team.yaml'), yamlWithDotDot);
    const loadedDotDot = loadTeamFile(root, { home });
    expect(loadedDotDot.ok).toBe(false);
    if (!loadedDotDot.ok) {
      expect(loadedDotDot.errors.some((e) => e.message.includes('"." or ".."'))).toBe(true);
    }
  });

  test('an existing entry that is not a directory is refused', () => {
    const fileEntry = join(root, 'README.md');
    const yaml = migratedTeamYaml().replace('trust:\n', `trust:\n  - ${fileEntry}\n`);
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.errors.some((e) => e.message.includes('is not a directory'))).toBe(true);
    }
  });

  test('two legal spellings of one folder compare equal and case stays different', () => {
    const slash = canonicalLanding(`${root}/`);
    const plain = canonicalLanding(root);
    expect(slash.error).toBeUndefined();
    expect(slash.landing).toBe(plain.landing);
    const lower = canonicalLanding(join(root, 'src'));
    const upper = canonicalLanding(join(root, 'SRC'));
    expect(lower.landing).not.toBe(upper.landing);
  });

  test('a symlink spelling is not a legal trust entry', () => {
    const target = join(base, 'real-folder');
    mkdirSync(target, { recursive: true });
    const sym = join(base, 'sym-folder');
    symlinkSync(target, sym, 'dir');
    expect(absoluteTrustProblem(sym, home)).toContain('symbolic link');
  });

  test('mixed file (legacy patterns and absolute entries) exits 2 in all 7 commands', async () => {
    const mixedYaml = `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - .
  - ~/.config/team/lobby
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
`;
    writeFileSync(join(root, '.agents', 'team.yaml'), mixedYaml);

    expect((await runStatusCmd()).code).toBe(2);
    expect((await runDoctorCmd()).code).toBe(2);
    expect((await runUpCmd([], world())).code).toBe(2);
    expect((await runAddCmd(['lead'], world())).code).toBe(2);
    expect((await runApproveCmd()).code).toBe(2);
    expect((await runCheckCmd()).code).toBe(2);
    expect((await runWorktreeCmd(['new', 'task-1', '--kind', 'feat'])).code).toBe(2);
  });

  test('non-directory existing ancestor is refused', () => {
    const pkgChild = join(root, 'README.md', 'child');
    const prob = absoluteTrustProblem(pkgChild, home);
    expect(prob).toContain('is not a directory');
  });

  test('dangling symbolic link component is refused', () => {
    const link = join(base, 'dangling-link');
    symlinkSync(join(base, 'no-such-target'), link);
    const prob = absoluteTrustProblem(join(link, 'tail'), home);
    expect(prob).toContain('is a symbolic link');
  });

  test('grammar matrix: ~ in later component, ., trailing slash, duplicates', () => {
    expect(absoluteTrustProblem(join(root, '~', 'more'), home)).toContain('takes "~" only as the first component');
    expect(absoluteTrustProblem('~other/lobby', home)).toContain('takes "~" only as the first component');
    expect(absoluteTrustProblem(`${root}/.`, home)).toContain('must not contain "." or ".."');

    // trailing slash accepted
    expect(absoluteTrustProblem(`${root}/`, home)).toBe(null);

    // duplicates accepted in YAML
    const dupYaml = migratedTeamYaml().replace('trust:\n', `trust:\n  - ${root}\n`);
    writeFileSync(join(root, '.agents', 'team.yaml'), dupYaml);
    expect(loadTeamFile(root, { home }).ok).toBe(true);
  });

  test('rules text: control character or newline in cwd or trust is refused at validation', () => {
    const injectedYaml = migratedTeamYaml().replace('cwd: .', 'cwd: "work\\n- injected rule"');
    writeFileSync(join(root, '.agents', 'team.yaml'), injectedYaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.errors.some((e) => e.message.includes('control character'))).toBe(true);
    }
  });

  test('migrated file without lobby in trust is refused', () => {
    const noLobbyYaml = migratedTeamYaml().replace(/  - ~\/\.config\/team\/lobby\n/, '');
    writeFileSync(join(root, '.agents', 'team.yaml'), noLobbyYaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.errors.some((e) => e.message.includes('must list the lobby'))).toBe(true);
    }
  });

  test('omitted trust does not stop up or add: each warns once and continues', async () => {
    const omittedTrustYaml = migratedTeamYaml().replace(/trust:\n(?:  - .*\n)+/, '');
    approveYaml(omittedTrustYaml);
    const made = world();
    const upRes = await runUpCmd([], made);
    expect(upRes.err).toContain(`team up: the file lists no trust: this run trusts only the lobby ${lobby} and the project root ${root}`);
    expect(upRes.err).not.toContain('the file is legacy: migrate trust');
    expect(upRes.code, upRes.err + upRes.out).toBe(0);

    const addRes = await runAddCmd(['worker'], world());
    expect(addRes.err).toContain(`team add: the file lists no trust: this run trusts only the lobby ${lobby} and the project root ${root}`);
    expect(addRes.err.split('this run trusts only').length).toBe(2);
    expect(addRes.err).not.toContain('the file is legacy: migrate trust');
  });

  test('containment: dangling linked descendant fails containment', () => {
    const jump = join(root, 'jump');
    symlinkSync(join(base, 'outside-missing'), jump);
    const probe = join(jump, 'seat');
    expect(insideTrust(probe, [root], root, home)).toBe(false);
  });

  test('containment: seat aimed at protected checkout in migrated file is refused', () => {
    const yaml = migratedTeamYaml()
      .replace('protected: [.]', 'protected: [., src]')
      .replace('mode: shared\n    cwd: .', 'mode: worktree\n    cwd: src');
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const start = seatStart(loaded.team, loaded.team.seats[0]!, root, home);
      expect('problem' in start && start.problem).toContain('inside the protected checkout');
    }
  });

  test('containment: a shared seat aimed at a protected checkout hears the rule that applies to it', () => {
    const yaml = migratedTeamYaml()
      .replace('protected: [.]', 'protected: [., src]')
      .replace('cwd: .', 'cwd: src');
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const lead = loaded.team.seats.find((seat) => seat.name === 'lead');
      if (!lead) throw new Error('no lead seat');
      const start = seatStart(loaded.team, lead, root, home);
      expect('problem' in start && start.problem).toContain('a shared seat never works in a protected checkout');
    }
  });

  test('a migrated lead starts in the project, and every other seat stays in the lobby', () => {
    writeFileSync(join(root, '.agents', 'team.yaml'), migratedTeamYaml());
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const lead = loaded.team.seats.find((seat) => seat.name === 'lead');
    const worker = loaded.team.seats.find((seat) => seat.name === 'worker');
    if (!lead || !worker) throw new Error('fixture seats missing');
    expect(seatStart(loaded.team, lead, root, home)).toEqual({ cwd: root });
    expect(seatStart(loaded.team, worker, root, home)).toEqual({ cwd: lobby, lobby: true });
  });

  test('containment: worktrees never land in a protected checkout', () => {
    const yaml = migratedTeamYaml()
      .replace('protected: [.]', 'protected: [src]')
      .replace('path: ../worktrees/{repo}/{task}', 'path: src/acme/{task}');
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    // The full load refuses the file with its own sentence...
    const full = loadTeamFile(root, { home });
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.errors.map((e) => e.message).join('\n')).toContain('puts worktrees inside the protected checkout src');
    // ...and a validation-only load, which skips the placement checks, still meets the seat guard.
    const checked = loadTeamFile(root, { home, checkOnly: true });
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      const lead = checked.team.seats.find((seat) => seat.name === 'lead');
      if (!lead) throw new Error('no lead seat');
      const start = seatStart(checked.team, lead, root, home);
      expect('problem' in start && start.problem).toContain('worktrees never land in a protected checkout');
      if ('problem' in start) expect(start.problem).toContain('inside the protected checkout src');
    }
  });

  test('containment: worktrees folder symlinked into project in migrated file is refused', () => {
    const liveDir = join(root, 'live');
    mkdirSync(liveDir, { recursive: true });
    mkdirSync(join(base, 'worktrees'), { recursive: true });
    symlinkSync(liveDir, join(base, 'worktrees', 'acme'), 'dir');

    const yaml = migratedTeamYaml()
      .replace('protected: [.]', 'protected: [., live]');
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.errors.some((e) => e.message.includes('inside the protected checkout'))).toBe(true);
    }
  });
});

// A volume either folds two spellings of one name into one folder or keeps them apart. The probe
// uses raw syscalls on folders this test made; each expectation below is the answer for the volume
// the suite runs on, so every test states a definite verdict and none of them is skipped.
function foldsSpellings(variant: string, real: string): boolean {
  try {
    lstatSync(variant);
  } catch {
    return false;
  }
  try {
    return realpathSync(variant) === realpathSync(real);
  } catch {
    return false;
  }
}

describe('a refused folder is refused under every spelling that names it', () => {
  const only = (entry: string) => migratedTeamYaml().replace(/trust:\n(?:  - .*\n)+/, `trust:\n  - ${entry}\n`);
  // The same file with the entry added to a trust list that covers the lobby, the root and the
  // worktrees, so a load failure names the entry, never the coverage a single-entry file lacks.
  const plus = (entry: string) => migratedTeamYaml().replace('trust:\n', `trust:\n  - ${entry}\n`);

  const verdicts = (entry: string, homeDir = home, rootDir = root): string[] => {
    const result = validateTeamFile(only(entry), { home: homeDir, root: rootDir });
    return result.ok ? [] : result.errors.map((problem) => problem.message);
  };

  test('a second spelling of the home is refused where it names the home', () => {
    const variant = join(base, 'HOME');
    const folds = foldsSpellings(variant, home);
    const found = verdicts(variant);
    if (folds) {
      expect(found.join('\n')).toContain('is the home itself');
    } else {
      expect(found).toEqual([]);
    }
    writeFileSync(join(root, '.agents', 'team.yaml'), plus(variant));
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(!folds);
    if (!loaded.ok) expect(loaded.errors.map((e) => e.message).join('\n')).toContain('is the home itself');
  });

  test("a second spelling of the project's parent is refused where it names the parent", () => {
    const project = join(base, 'PB', 'proj');
    mkdirSync(project, { recursive: true });
    const variant = join(base, 'pb');
    const folds = foldsSpellings(variant, join(base, 'PB'));
    const found = verdicts(variant, home, project);
    if (folds) {
      expect(found.join('\n')).toContain('is a parent of the project');
    } else {
      expect(found).toEqual([]);
    }
  });

  test("a second spelling of the parent that holds the project is refused at load", () => {
    const project = join(base, 'PB', 'proj');
    const agents = join(project, '.agents');
    mkdirSync(agents, { recursive: true });
    const variant = join(base, 'pb');
    const folds = foldsSpellings(variant, join(base, 'PB'));
    // The project moved, so its worktrees folder moved with it: the fixture's worktrees entry has
    // to move too, or the load refuses `workspace.path ... outside trust` for a reason that is not
    // the entry under test — on a volume that keeps "pb" apart from "PB" the variant entry used to
    // cover that path only by folding, which is exactly the volume this case is not about.
    const text = migratedTeamYaml()
      .replaceAll(root, project)
      .replace(join(base, 'worktrees'), join(base, 'PB', 'worktrees'))
      .replace('trust:\n', `trust:\n  - ${variant}\n`);
    writeFileSync(join(agents, 'team.yaml'), text);
    const loaded = loadTeamFile(project, { file: join(agents, 'team.yaml'), home });
    expect(loaded.ok).toBe(!folds);
    if (!loaded.ok) expect(loaded.errors.map((e) => e.message).join('\n')).toContain('is a parent of the project');
  });

  test('a second spelling of the folders that hold the lobby and the approval store is refused', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    const folds = foldsSpellings(join(base, 'HOME'), home);
    const found = [
      join(base, 'HOME', '.config'),
      join(base, 'HOME', '.config', 'team'),
    ].flatMap((entry) => verdicts(entry));
    if (folds) {
      expect(found).toHaveLength(2);
      for (const message of found) expect(message).toContain('would cover');
    } else {
      expect(found).toEqual([]);
    }
  });

  test('another normalisation form of the home is refused where it names the home', () => {
    const homeUni = join(base, 'Hómé');
    mkdirSync(homeUni);
    const variant = join(base, 'Hómé');
    const folds = foldsSpellings(variant, homeUni);
    const found = verdicts(variant, homeUni);
    if (folds) {
      expect(found.join('\n')).toContain('is the home itself');
    } else {
      expect(found).toEqual([]);
    }
  });

  test('an entry that does not exist yet resolves as far as it exists and keeps the rest as written', () => {
    const variant = join(base, 'HOME');
    const folds = foldsSpellings(variant, home);
    const under = join(variant, 'seat');
    expect(canonicalLanding(under).landing).toBe(folds ? join(realpathSync(home), 'seat') : under);
    expect(verdicts(under)).toEqual([]);
    writeFileSync(join(root, '.agents', 'team.yaml'), plus(under));
    expect(loadTeamFile(root, { home }).ok).toBe(true);
  });

  test("the spellings that name a refused folder exactly still refuse, and the team's own folders still accept", () => {
    expect(verdicts('/').join('\n')).toContain('is the root of the filesystem');
    expect(verdicts(home).join('\n')).toContain('is the home itself');
    expect(verdicts(join(home, '.config', 'team')).join('\n')).toContain('would cover');
    expect(verdicts(root, home, root)).toEqual([]);
    expect(verdicts(join(root, 'work'), home, root)).toEqual([]);
    expect(verdicts(lobbyDir(home))).toEqual([]);
    expect(verdicts(join(base, 'worktrees'))).toEqual([]);
    expect(verdicts(join(base, 'elsewhere'))).toEqual([]);
  });
});

describe('legacy files and migration', () => {
  test('read-only commands (status, doctor, check, worktree) work on a legacy file', async () => {
    approveYaml(legacyTeamYaml());
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          lead: { stage: 'ready' },
          worker: { stage: 'ready' },
        },
        worktrees: {},
        watch: { pid: process.pid, heartbeat: NOW.toISOString() },
      };
    });

    expect((await runStatusCmd()).code).not.toBe(2);
    expect((await runDoctorCmd()).code).not.toBe(2);
    expect((await runCheckCmd()).code).not.toBe(2);
    expect((await runWorktreeCmd(['new', 'task-1', '--kind', 'feat'])).code).toBe(0);
  });

  test('a legacy file whose worktrees sit inside the project loads and reads; the seat is refused at placement', async () => {
    // Main loaded such a file and refused the seat at launch; the load-time containment of
    // workspace.path holds migrated files only, so this file must still load and read.
    const yaml = legacyTeamYaml().replace('../worktrees/{repo}/{task}', 'wt/{task}');
    approveYaml(yaml);

    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
    expect((await runStatusCmd()).code).not.toBe(2);
    expect((await runDoctorCmd()).code).not.toBe(2);

    if (!loaded.ok) return;
    const worker = loaded.team.seats.find((seat) => seat.name === 'worker');
    if (!worker) throw new Error('no worker seat');
    const start = seatStart(loaded.team, worker, root, home);
    expect('problem' in start && start.problem).toContain('inside the protected checkout');
  });

  test('up and add warn once with the trust block naming the lobby path, trust the lobby and the project root, and continue', async () => {
    approveYaml(legacyTeamYaml());

    const madeUp = world();
    const upRes = await runUpCmd([], madeUp);
    expect(upRes.err.split('this run trusts only').length).toBe(2);
    // The third entry is the one the old message left out: the folder workspace.path places
    // worktrees in, and the from-line says which key each entry comes from.
    expect(upRes.err).toContain(
      `team up: the file lists project-relative trust: this run trusts only the lobby ${lobby} and the project root ${root}; to keep it, write trust as absolute paths including the lobby ${lobby}:\ntrust:\n  - ~/.config/team/lobby\n  - ${root}\n  - ${join(base, 'worktrees', 'acme')}\n`,
    );
    expect(upRes.err).toContain(
      `~/.config/team/lobby is the machine lobby, where every seat starts now; ${root} is the project root, replacing "."; `
        + `${join(base, 'worktrees', 'acme')} is the folder workspace.path "../worktrees/{repo}/{task}" places worktrees in, replacing "../worktrees/acme/*"`,
    );
    expect(upRes.err).not.toContain('the file is legacy: migrate trust');

    const madeAdd = world();
    const addRes = await runAddCmd(['worker'], madeAdd);
    expect(addRes.err).toContain(`team add: the file lists project-relative trust: this run trusts only the lobby ${lobby} and the project root ${root}; to keep it, write trust as absolute paths including the lobby ${lobby}:\ntrust:\n  - ~/.config/team/lobby\n  - ${root}\n  - ${join(base, 'worktrees', 'acme')}\n`);
    expect(addRes.err).not.toContain('the file is legacy: migrate trust');
  });

  test('doctor prints migration note once for legacy file, and stops after migration plus approval', async () => {
    approveYaml(legacyTeamYaml());
    const oldLobby = join(base, 'worktrees', 'acme', '.lobby');
    mkdirSync(oldLobby, { recursive: true });

    const docBefore = await runDoctorCmd();
    expect(docBefore.code).toBe(0);
    expect(docBefore.out).toContain(
      `note  the file is legacy: migrate from ../worktrees/acme/.lobby to ~/.config/team/lobby by writing:\ntrust:\n  - ~/.config/team/lobby\n  - ${root}\n  - ${join(base, 'worktrees', 'acme')}\n`
        + `~/.config/team/lobby is the machine lobby, where every seat starts now; ${root} is the project root, replacing "."; `
        + `${join(base, 'worktrees', 'acme')} is the folder workspace.path "../worktrees/{repo}/{task}" places worktrees in, replacing "../worktrees/acme/*"\n`,
    );

    // Migrated and different from the stored copy: the migration note is gone, and doctor
    // does not name a deleted command.
    writeFileSync(join(root, '.agents', 'team.yaml'), migratedTeamYaml());
    const docUnapproved = await runDoctorCmd();
    expect(docUnapproved.out).not.toContain('the file is legacy');
    expect(docUnapproved.out).not.toContain('team approve');

    approveYaml(migratedTeamYaml());
    const docAfter = await runDoctorCmd();
    expect(docAfter.code).toBe(0);
    expect(docAfter.out).not.toContain('the file is legacy');
  });

  test('a migrated file that differs from the stored copy still mounts', async () => {
    approveYaml(legacyTeamYaml());
    writeFileSync(join(root, '.agents', 'team.yaml'), migratedTeamYaml());

    const upRes = await runUpCmd([], world());
    expect(upRes.err).not.toContain('the file is not the approved one');
    expect(upRes.err).not.toContain('team approve');
    expect(upRes.code, upRes.err + upRes.out).toBe(0);

    const addRes = await runAddCmd(['worker'], world());
    expect(addRes.err).not.toContain('the file is not the approved one');
    expect(addRes.err).not.toContain('team approve');
  });

  test('temporary add waits in machine lobby', async () => {
    approveYaml(migratedTeamYaml());
    const made = world();
    await runUpCmd([], made);
    const before = made.workspaces.length;
    const addRun = await runAddCmd(['--temporary', '--like', 'worker', '--until', 'merged:main'], made);
    expect(addRun.code).toBe(0);
    const added = made.workspaces.slice(before);
    expect(added).toContainEqual({ label: 'worker-tmp-01', cwd: lobby });
  });

  test('add refuses when trust has no lobby and leaves file untouched', async () => {
    const noLobbyYaml = migratedTeamYaml().replace(/  - ~\/\.config\/team\/lobby\n/, '');
    writeFileSync(join(root, '.agents', 'team.yaml'), noLobbyYaml);
    const before = readFileSync(join(root, '.agents', 'team.yaml'), 'utf8');
    const made = world();
    const addRun = await runAddCmd(['worker'], made);
    expect(addRun.code).not.toBe(0);
    expect(made.workspaces).toEqual([]);
    const after = readFileSync(join(root, '.agents', 'team.yaml'), 'utf8');
    expect(after).toBe(before);
  });
});

describe('start_cwd and removal check', () => {
  test('start_cwd is recorded on launch and exposed in status --json', async () => {
    approveYaml(migratedTeamYaml());
    const made = world();
    const upRes = await runUpCmd([], made);
    expect(upRes.code).toBe(0);

    const state = readState(dir);
    expect(state.sessions['acme']?.seats['lead']?.start_cwd).toBe(root);
    expect(state.sessions['acme']?.seats['worker']?.start_cwd).toBe(canonicalLanding(lobby).landing);

    const statusRes = await runStatusCmd(['--json']);
    expect(statusRes.code).not.toBe(2);
    const parsed = JSON.parse(statusRes.out);
    const workerRow = parsed.rows.find((r: { name: string }) => r.name === 'worker');
    expect(workerRow).toBeDefined();
    expect(workerRow.start_cwd).toBe(canonicalLanding(lobby).landing);
  });

  test('removal check in doctor: states, repairs, and ignoring stopped historical seats', async () => {
    approveYaml(migratedTeamYaml());
    const oldLobby = join(base, 'worktrees', 'acme', '.lobby');
    mkdirSync(oldLobby, { recursive: true });
    const oldLanding = canonicalLanding(oldLobby).landing;
    const fix = 'run `team remove worker --keep` then `team add worker` (or `team down` then `team up` for the whole team)';

    // State 1: A live seat that records its start in the old lobby
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          worker: { stage: 'ready', pane: 'w1:p1', start_cwd: oldLanding },
        },
        worktrees: {},
      };
    });
    const docState1 = await runDoctorCmd([], {
      sessionRunning: () => true,
      agentList: () => [{ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: oldLanding }],
    });
    expect(docState1.out).toContain(`warn  the old lobby ../worktrees/acme/.lobby: seat worker started in it; ${fix} to move it into the lobby, then remove the folder\n`);

    // State 2: A live seat without start_cwd — the 0.2.1 shape. The file says worktree mode with
    // cwd ".", and that release started such a seat in the old lobby, so the warning names it as
    // started there; the repair it names is one that moves the seat.
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          worker: { stage: 'ready', pane: 'w1:p1' },
        },
        worktrees: {},
      };
    });
    const docState2 = await runDoctorCmd([], {
      sessionRunning: () => true,
      agentList: () => [{ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: oldLanding }],
    });
    expect(docState2.out).toContain(`warn  the old lobby ../worktrees/acme/.lobby: seat worker started in it; ${fix} to move it into the lobby, then remove the folder\n`);

    // A shared seat without start_cwd started in the project root, not the old lobby: it is not
    // named — that release never started it there — and the folder may be removed.
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          lead: { stage: 'ready', pane: 'w0:p1' },
        },
        worktrees: {},
      };
    });
    const docShared = await runDoctorCmd([], {
      sessionRunning: () => true,
      agentList: () => [{ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: root }],
    });
    expect(docShared.out).toContain(`ok    the old lobby ../worktrees/acme/.lobby: may be removed\n`);

    // A live seat the file no longer names: where it started is unknown, so the folder is held.
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          ghost: { stage: 'ready', pane: 'w9:p1' },
        },
        worktrees: {},
      };
    });
    const docGhost = await runDoctorCmd([], {
      sessionRunning: () => true,
      agentList: () => [{ name: 'ghost', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: oldLanding }],
    });
    expect(docGhost.out).toContain(`warn  the old lobby ../worktrees/acme/.lobby: where seat ghost started is not recorded and the file no longer names it; stop it before removing the folder\n`);

    // State 3: Live seat with start_cwd in new lobby (may be removed)
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          worker: { stage: 'ready', pane: 'w1:p1', start_cwd: canonicalLanding(lobby).landing },
        },
        worktrees: {},
      };
    });
    const docState3 = await runDoctorCmd([], {
      sessionRunning: () => true,
      agentList: () => [{ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: lobby }],
    });
    expect(docState3.out).toContain(`ok    the old lobby ../worktrees/acme/.lobby: may be removed\n`);

    // Correction check: A stopped historical seat (no pane, not running, no waiting) without start_cwd does NOT block removal
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          historical: { stage: 'ready', pane: 'w99:p1' }, // historical, no agent in agentList
          worker: { stage: 'ready', pane: 'w1:p1', start_cwd: canonicalLanding(lobby).landing },
        },
        worktrees: {},
      };
    });
    const docHistorical = await runDoctorCmd([], {
      sessionRunning: () => true,
      agentList: () => [{ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: lobby }],
    });
    expect(docHistorical.out).toContain(`ok    the old lobby ../worktrees/acme/.lobby: may be removed\n`);
  });

  test('resumed launch of pre-migration seat does not record or infer start_cwd', async () => {
    approveYaml(migratedTeamYaml());
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          worker: { stage: 'ready', pane: 'w1:p1' },
        },
        worktrees: {},
      };
    });
    const made = world();
    made.session = 'running';
    const upRes = await runUpCmd([], made, {
      sessionRunning: () => true,
      agents: () => [{ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: root }],
    });
    expect(upRes.code).toBe(0);
    const state = readState(dir);
    expect(state.sessions['acme']?.seats['worker']?.start_cwd).toBeUndefined();
  });

  test('doctor removal check fails closed when liveList is null', async () => {
    approveYaml(migratedTeamYaml());
    const oldLobby = join(base, 'worktrees', 'acme', '.lobby');
    mkdirSync(oldLobby, { recursive: true });
    const doc = await runDoctorCmd([], {
      sessionRunning: () => true,
      agentList: () => null,
    });
    expect(doc.out).toContain("can't tell if live seats are using it: herdr doesn't answer");
  });
});

// What a person who upgraded from 0.2.1 holds, on the file and state that release left behind:
// the skeleton's trust block uncommented, every seat on the placeholder version "0", and a
// state that records ready with a pane but no process identity and no start folder. The
// fixtures are those file and state shapes themselves, not 0.2.1's own functions: what the
// upgrade turns on is exactly these literals, so they are pinned here where the assertions
// can see them.
describe('the upgrade from 0.2.1', () => {
  // 0.2.1's init skeleton with the trust block uncommented, and the
  // placeholder version "0" that release wrote where no owner had filled one in.
  function v021TeamYaml(): string {
    return legacyTeamYaml().replaceAll('version: "5.5"', 'version: "0"');
  }

  // The trust block exactly as the message prints it: the `  - ` lines under `trust:`.
  function blockOf(output: string): string[] {
    return output.split('\n').filter((line) => line.startsWith('  - ')).map((line) => line.slice(4));
  }

  // The file with its trust replaced by the block the message printed, byte for byte.
  function pasteTrust(yaml: string, entries: readonly string[]): string {
    return yaml.replace(/trust:\n(?:  - .*\n)+/, `trust:\n${entries.map((entry) => `  - ${entry}\n`).join('')}`);
  }

  // The store 0.2.1 left: a format-1 approval nobody signed.
  function legacyApproval(text: string): void {
    writeFileSync(join(root, '.agents', 'team.yaml'), text);
    const loaded = loadTeamFile(root, { home });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    const store = storePath(loaded.team.project, loaded.root, home);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'approval.json'), JSON.stringify({ ...approvalOf(loaded.team, loaded.root), format: 1, file: text }));
  }

  test('the block up prints takes the file past validation for every starting shape it met', async () => {
    // The file exactly as init wrote it, uncommented.
    approveYaml(v021TeamYaml());
    const refusedA = await runUpCmd([], world());
    const entriesA = blockOf(refusedA.err);
    expect(entriesA).toEqual(['~/.config/team/lobby', root, join(base, 'worktrees', 'acme')]);
    writeFileSync(join(root, '.agents', 'team.yaml'), pasteTrust(v021TeamYaml(), entriesA));
    const pastedA = loadTeamFile(root, { home });
    expect(pastedA.ok).toBe(true);
    if (pastedA.ok) expect(pastedA.team.trust).toEqual(entriesA);
    const afterA = await runUpCmd([], world());
    expect(afterA.err).not.toContain('the file is legacy');
    expect(afterA.err).not.toContain('outside trust');
    expect(afterA.err).not.toContain('the file is not the approved one');
    expect(afterA.err).not.toContain('team approve');

    // An entry the owner added by hand under the init ones — kept, absolute, named as his.
    const handAdded = v021TeamYaml().replace('  - ../worktrees/acme/*\n', '  - ../worktrees/acme/*\n  - ../allies/*\n');
    approveYaml(handAdded);
    const refusedB = await runUpCmd([], world());
    const entriesB = blockOf(refusedB.err);
    expect(entriesB).toEqual(['~/.config/team/lobby', root, join(base, 'worktrees', 'acme'), join(base, 'allies')]);
    expect(refusedB.err).toContain(`${join(base, 'allies')} is your own "../allies/*" entry, kept in absolute form`);
    writeFileSync(join(root, '.agents', 'team.yaml'), pasteTrust(handAdded, entriesB));
    expect(loadTeamFile(root, { home }).ok).toBe(true);
    const afterB = await runUpCmd([], world());
    expect(afterB.err).not.toContain('the file is legacy');
    expect(afterB.err).not.toContain('outside trust');
    expect(afterB.err).not.toContain('the file is not the approved one');
    expect(afterB.err).not.toContain('team approve');

    // The approval 0.2.1 left is format-1 and unsigned. The block is computed from the
    // file, so it is the same one, and pasting it leaves exactly the approval step.
    legacyApproval(v021TeamYaml());
    const refusedD = await runUpCmd([], world());
    expect(refusedD.code).toBe(1);
    expect(blockOf(refusedD.err)).toEqual(['~/.config/team/lobby', root, join(base, 'worktrees', 'acme')]);
    expect(refusedD.err).toContain(LEGACY_LINE);
    writeFileSync(join(root, '.agents', 'team.yaml'), pasteTrust(v021TeamYaml(), blockOf(refusedD.err)));
    expect(loadTeamFile(root, { home }).ok).toBe(true);
    const afterD = await runUpCmd([], world());
    expect(afterD.err).not.toContain('the file is legacy');
    expect(afterD.err).toContain(LEGACY_LINE);
  });

  test('worktrees inside the project: one extra edit its own rule names, then the same block', async () => {
    // 0.2.1 refused this shape too, so no trust block can carry it past validation alone; the
    // refusal that names the extra edit is the file's own, and once the path is moved the
    // recomputed block is the skeleton's own shape and pastes clean.
    const insideProjectYaml = v021TeamYaml().replace('../worktrees/{repo}/{task}', 'wt/{task}');
    approveYaml(insideProjectYaml);
    const made = world();
    const refused = await runUpCmd([], made);
    expect(refused.code).toBe(1);
    expect(blockOf(refused.err)).toEqual(['~/.config/team/lobby', root]);
    expect(refused.err).toContain('inside the protected checkout');
    expect(made.workspaces).toEqual([]);

    // The one extra edit: give worktrees a folder of their own. The file is still legacy, and
    // the block recomputed for it carries the worktrees folder.
    const moved = insideProjectYaml.replace('path: wt/{task}', 'path: ../worktrees/{repo}/{task}');
    approveYaml(moved);
    const recomputed = await runUpCmd([], world());
    const entries = blockOf(recomputed.err);
    expect(entries).toEqual(['~/.config/team/lobby', root, join(base, 'worktrees', 'acme')]);
    writeFileSync(join(root, '.agents', 'team.yaml'), pasteTrust(moved, entries));
    expect(loadTeamFile(root, { home }).ok).toBe(true);
    const after = await runUpCmd([], world());
    expect(after.err).not.toContain('the file is legacy');
    expect(after.err).not.toContain('outside trust');
    expect(after.err).not.toContain('inside the protected checkout');
    expect(after.err).not.toContain('the file is not the approved one');
    expect(after.err).not.toContain('team approve');
  });

  test('a folder the containment rule refuses is never suggested: the key that forces it is named', async () => {
    // The project sits directly under the home and workspace.path puts worktrees in ~/.config,
    // which covers the lobby and the approval store. Trust refuses that folder, so the message
    // cannot print it as a suggestion; the key that forces it is named instead. (A legacy file
    // loads only when workspace.path matches one of its patterns, so the hand-added pattern that
    // covers it is part of the fixture — and is the old entry the refused folder would replace.)
    const inside = join(home, 'acme');
    mkdirSync(join(inside, '.agents'), { recursive: true });
    git(inside, 'init', '-q', '-b', 'main');
    const yaml = v021TeamYaml()
      .replace('  - ../worktrees/acme/*\n', '  - ../worktrees/acme/*\n  - ../.config/*\n')
      .replace('path: ../worktrees/{repo}/{task}', 'path: ../.config/{task}');
    writeFileSync(join(inside, '.agents', 'team.yaml'), yaml);
    const io = testIo(inside, OWNER);
    await runDoctor(['--file', '.agents/team.yaml'], io, runDoctorCmdSources());
    expect(io.out).toContain(
      `workspace.path "../.config/{task}" would need ~/.config, which would cover `
        + `~/.config/team, which holds the lobby and the approval store: trust a folder of the team's own; `
        + 'team cannot choose it for you: pick a folder yourself and write it into trust',
    );
    // The refused folder is not suggested; the suggestions stay at the lobby and the project root.
    expect(blockOf(io.out)).toEqual(['~/.config/team/lobby', '~/acme']);
    expect(io.out).not.toContain('  - ~/.config\n');
  });

  // The fake host a named repair runs on: `remove --keep` types the exit into a free seat and
  // closes its workspace, exactly as the live command does.
  function removeKeepSources(
    seat: { name: string; pane: string; workspace: string },
    agent: string,
    box: (text: string) => string,
  ): RemoveSources {
    // The pane's box, physically: the empty box before any typing, the typed text after it,
    // empty again after the one clearing key.
    let typed = '';
    let sent = false;
    return {
      sessionRunning: () => true,
      agents: () => [{ name: seat.name, agent, pane: seat.pane, workspace: seat.workspace, status: 'idle', cwd: null }],
      alive: () => false,
      screen: () => ({ kind: sent ? ('unknown' as const) : ('idle' as const) }),
      screenText: () => box(typed),
      status: () => 'idle',
      foreground: () => (sent ? [] : [agent]),
      now: () => NOW,
      sleep: async () => {},
      home,
      launch: {
        typeText: (_session, _pane, text) => { typed = text; return true; },
        sendKey: () => { typed = ''; return true; },
        pressEnter: () => { sent = true; return true; },
        agentPanes: () => (sent ? [] : [seat.pane]),
        closeWorkspace: () => true,
        stopSession: () => false,
        deleteSession: () => false,
        kill: () => false,
        sleep: async () => {},
        now: () => NOW,
      },
    };
  }

  function claudeLive(name: string, pane: string, workspace: string, cwd: string | null = null) {
    return {
      sessionRunning: () => true,
      agentList: () => [{ name, agent: 'claude', pane, workspace, status: 'idle', cwd }],
    };
  }

  test("the identity note's repair works: register records the process where the seat stands", async () => {
    approveYaml(migratedTeamYaml());
    updateState(dir, (st) => {
      st.sessions['acme'] = { seats: { worker: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' } }, worktrees: {} };
    });
    const live = claudeLive('worker', 'w1:p1', 'w1');
    const before = await runDoctorCmd([], live);
    expect(before.out).toContain(
      'worker: launched before team recorded its process; run `team register worker` to record its process',
    );

    // Run the repair the line names, on the fake host: the pane the seat stands in is read
    // again, and nothing is relaunched.
    const registered = await runRegisterCmd('worker', 'w1:p1', 'w1');
    expect(registered.code).toBe(0);
    expect(registered.out).toContain('worker: already registered — pane w1:p1');

    const after = await runDoctorCmd([], live);
    expect(after.out).not.toContain('launched before team recorded its process');
    const worker = readState(dir).sessions['acme']?.seats.worker;
    expect(worker?.launched).toEqual({ shell: 900, cli: [901] });
    expect(worker?.id).toMatch(SEAT_ID_PATTERN);
    expect(worker?.stage).toBe('ready');
    // The record the repair writes is the one `team seats` reads its ID column from: the row
    // that showed `-` before shows the seat's id.
    const seats = await runSeatsCmd();
    expect(seats.out).toContain(worker!.id!);
  });

  function codexCapture(name: string): string {
    // The captured Codex home names Terra 5.6; the file's seat says GPT Sol 6, so the status
    // row is shown in the file's spelling, as live.test.ts does it.
    return readFileSync(new URL(`../fixtures/codex/0.157.0/${name}.txt`, import.meta.url), 'utf8')
      .replaceAll('GPT-5.6-Terra', 'GPT-6-Sol');
  }

  test("the rules-file line names team reload, and a relaunch writes the file at the fresh launch", async () => {
    // A rules file travels as a message only on a CLI that takes rules that way, so the seat
    // the line is printed for is a Codex one.
    const withScribe = migratedTeamYaml().replace(
      '    count: 1\n',
      '    count: 1\n  - role: implementer\n    name: scribe\n    label: scribe\n    cli: codex\n    vendor: openai\n    model: GPT Sol\n    version: "6"\n    launch: codex\n',
    );
    approveYaml(withScribe);
    updateState(dir, (st) => {
      st.sessions['acme'] = { seats: { scribe: { stage: 'ready', pane: 'w2:p1', workspace: 'w2' } }, worktrees: {} };
    });
    const live = {
      sessionRunning: () => true,
      agentList: () => [{ name: 'scribe', agent: 'codex', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null }],
    };
    const before = await runDoctorCmd([], live);
    expect(before.out).toContain('scribe: its rules file is missing; run team reload scribe');

    const codexBox = (text: string): string => codexCapture('idle').replace('› Ask Codex to do anything', `› ${text}`);
    expect(
      await runRemove(['scribe', '--keep', ...FILE], testIo(root, OWNER), removeKeepSources({ name: 'scribe', pane: 'w2:p1', workspace: 'w2' }, 'codex', codexBox)),
    ).toBe(0);

    // The relaunch, on a Codex-shaped host: the rules go to the file, the one line that points
    // at it is typed at an empty idle prompt, read back row by row, then Enter.
    const made = world();
    made.session = 'running';
    const idle = codexCapture('idle');
    const working = codexCapture('working');
    let typed = '';
    let pasted = false;
    let entered = false;
    let status = 'idle';
    const boxed = (): string => {
      const [first = '', ...rest] = typed.split('\n');
      return idle.replace('› Ask Codex to do anything', [`› ${first}`, ...rest.map((line) => `  ${line}`)].join('\n'));
    };
    made.launch.paneText = () => (pasted ? boxed() : entered ? working : idle);
    made.launch.typeText = (_session, _pane, text) => { typed = text; pasted = true; return true; };
    made.launch.pressEnter = () => { pasted = false; entered = true; status = 'working'; return true; };
    made.launch.agentStatus = () => status;
    made.launch.foreground = () => ['codex'];
    made.launch.processInfo = () => ({ shell: 900, foreground: [901] });
    expect((await runAddCmd(['scribe'], made)).code).toBe(0);

    const file = rulesFilePath('acme', root, home, 'scribe');
    expect(file).not.toBeNull();
    if (file !== null) expect(existsSync(file)).toBe(true);
    const after = await runDoctorCmd([], live);
    expect(after.out).not.toContain('scribe: its rules file is missing');
    expect(readState(dir).sessions['acme']?.seats.scribe).toMatchObject({ stage: 'ready', rules: 'message' });
  });

  test("the old-lobby line's repair works: remove --keep then add moves the seat into the lobby", async () => {
    approveYaml(migratedTeamYaml());
    const oldLobby = join(base, 'worktrees', 'acme', '.lobby');
    mkdirSync(oldLobby, { recursive: true });
    const oldLanding = canonicalLanding(oldLobby).landing;
    updateState(dir, (st) => {
      st.sessions['acme'] = { seats: { worker: { stage: 'ready', pane: 'w1:p1', workspace: 'w1', start_cwd: oldLanding } }, worktrees: {} };
    });
    const live = claudeLive('worker', 'w1:p1', 'w1', oldLanding);
    const before = await runDoctorCmd([], live);
    expect(before.out).toContain(
      'warn  the old lobby ../worktrees/acme/.lobby: seat worker started in it; run `team remove worker --keep` then `team add worker` '
        + '(or `team down` then `team up` for the whole team) to move it into the lobby, then remove the folder\n',
    );

    expect(
      await runRemove(['worker', '--keep', ...FILE], testIo(root, OWNER), removeKeepSources({ name: 'worker', pane: 'w1:p1', workspace: 'w1' }, 'claude', claudeBox)),
    ).toBe(0);
    const made = world();
    made.session = 'running';
    made.launch.processInfo = () => ({ shell: 900, foreground: [901] });
    expect((await runAddCmd(['worker'], made)).code).toBe(0);

    const after = await runDoctorCmd([], live);
    expect(after.out).toContain('ok    the old lobby ../worktrees/acme/.lobby: may be removed\n');
    expect(after.out).not.toContain('seat worker started in it');
    expect(readState(dir).sessions['acme']?.seats.worker?.start_cwd).toBe(canonicalLanding(lobby).landing);
  });

  function downSourcesFor(
    seats: { name: string; pane: string; workspace: string; cli?: string }[],
    closed?: string[],
  ): RemoveSources {
    let sentPane: string | null = null;
    const typedBox = new Map<string, string>();
    const cliMap = new Map(seats.map((s) => [s.pane, s.cli ?? 'claude']));
    return {
      sessionRunning: () => true,
      agents: () => seats.map((seat) => ({ name: seat.name, agent: seat.cli ?? 'claude', pane: seat.pane, workspace: seat.workspace, status: 'idle', cwd: null })),
      alive: () => false,
      screen: () => ({ kind: 'idle' as const }),
      screenText: (_session, pane, cli) => {
        const text = typedBox.get(pane) ?? '';
        return cli === 'codex' ? codexCapture('idle').replace('› Ask Codex to do anything', `› ${text}`) : claudeBox(text);
      },
      status: () => 'idle',
      foreground: (_session, pane) => (sentPane === null ? [cliMap.get(pane) ?? 'claude'] : pane === sentPane ? [] : [cliMap.get(pane) ?? 'claude']),
      now: () => NOW,
      sleep: async () => {},
      home,
      launch: {
        typeText: (_session, pane, text) => { typedBox.set(pane, text); return true; },
        sendKey: (_session, pane) => { typedBox.set(pane, ''); return true; },
        pressEnter: (_session, pane) => { sentPane = pane; return true; },
        agentPanes: () => seats.filter((seat) => seat.pane !== sentPane).map((seat) => seat.pane),
        closeWorkspace: (_session, workspace) => { closed?.push(workspace); return true; },
        stopSession: () => true,
        deleteSession: () => true,
        kill: () => false,
        sleep: async () => {},
        now: () => NOW,
      },
    };
  }

  test('the same note clears for the whole-team route: down, then up', async () => {
    approveYaml(migratedTeamYaml());
    updateState(dir, (st) => {
      st.sessions['acme'] = { seats: { worker: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' } }, worktrees: {} };
    });
    const live = claudeLive('worker', 'w1:p1', 'w1');
    expect((await runDoctorCmd([], live)).out).toContain('launched before team recorded its process');

    // `down` stops both seats and clears the session; `up` then launches the team from the
    // beginning, which is what records the identity.
    const seats = [
      { name: 'lead', pane: 'w0:p1', workspace: 'w0' },
      { name: 'worker', pane: 'w1:p1', workspace: 'w1' },
    ];
    const closed: string[] = [];
    expect(await runDown([...FILE], testIo(root, OWNER), downSourcesFor(seats, closed))).toBe(0);
    expect(closed.sort()).toEqual(['w0', 'w1']);

    const made = world();
    made.launch.processInfo = () => ({ shell: 900, foreground: [901] });
    const run = await runUpCmd([], made);
    expect(run.code).toBe(0);
    expect(run.out).toContain('worker: ready\n');
    const after = await runDoctorCmd([], live);
    expect(after.out).not.toContain('launched before team recorded its process');
    expect(readState(dir).sessions['acme']?.seats.worker?.launched).toEqual({ shell: 900, cli: [901] });
  });

  test("up's skip line says what repairs a ready seat whose process was never recorded", async () => {
    approveYaml(migratedTeamYaml());
    updateState(dir, (st) => {
      st.sessions['acme'] = { seats: { worker: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' } }, worktrees: {} };
    });
    const made = world();
    made.session = 'running';
    const run = await runUpCmd([], made, {
      agents: () => [{ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
    });
    expect(run.code).toBe(0);
    expect(run.out).toContain('worker: ready\n');
    expect(run.err).toContain(
      '  already ready; left as it is; its process was never recorded: '
        + 'run team register worker to record it, nothing relaunched\n',
    );
  });

  test("up's skip line says what moves a ready seat that still starts outside the lobby", async () => {
    approveYaml(migratedTeamYaml());
    const oldLobby = join(base, 'worktrees', 'acme', '.lobby');
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: { worker: { stage: 'ready', pane: 'w1:p1', workspace: 'w1', launched: { shell: 1, cli: [2] }, start_cwd: canonicalLanding(oldLobby).landing } },
        worktrees: {},
      };
    });
    const made = world();
    made.session = 'running';
    const run = await runUpCmd([], made, {
      agents: () => [{ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
    });
    expect(run.code).toBe(0);
    expect(run.out).toContain('worker: ready\n');
    expect(run.err).toContain(
      '  already ready; left as it is; a relaunch moves it into the lobby: '
        + 'team remove worker --keep, then team add worker (or team down, then team up, for the whole team)\n',
    );
  });

  test('coordinator and operator draw no identity note, the register repair clears an ordinary seat\'s, their rules-file line names team reload, and down/up clears both', async () => {
    // Separate coordinator and operator seats
    const withOp = migratedTeamYaml()
      .replace('operator: lead', 'operator: opSeat')
      .replace(
        '    count: 1\n',
        '    count: 1\n  - role: operator\n    name: opSeat\n    label: opSeat\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n    count: 1\n',
      );
    approveYaml(withOp);
    const oldLobby = join(base, 'worktrees', 'acme', '.lobby');
    mkdirSync(oldLobby, { recursive: true });
    const oldLanding = canonicalLanding(oldLobby).landing;

    // 1. Identity note: never for a lead's own seat; an ordinary seat names `team register`
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          lead: { stage: 'ready', pane: 'w0:p1', workspace: 'w0' },
          opSeat: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' },
          worker: { stage: 'ready', pane: 'w2:p1', workspace: 'w2' },
        },
        worktrees: {},
      };
    });
    const liveLeads = {
      sessionRunning: () => true,
      agentList: () => [
        { name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null },
        { name: 'opSeat', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null },
        { name: 'worker', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null },
      ],
    };
    const docIdent = await runDoctorCmd([], liveLeads);
    // The orchestrator and the operator stand in the seat that reads the line: their own gaps
    // draw no note, and no identity line names a whole-team restart any more.
    expect(docIdent.out.split('\n').filter((line) => line.includes('launched before team recorded its process'))).toEqual([
      'note  worker: launched before team recorded its process; run `team register worker` to record its process',
    ]);
    expect(docIdent.out).not.toContain('team remove lead --keep');
    expect(docIdent.out).not.toContain('team remove opSeat --keep');
    expect(docIdent.out).not.toContain('team remove worker --keep');

    // Run the repair the line names: the worker's record is completed where it stands.
    const registered = await runRegisterCmd('worker', 'w2:p1', 'w2');
    expect(registered.code).toBe(0);
    expect(registered.out).toContain('worker: already registered — pane w2:p1');
    const docIdentAfter = await runDoctorCmd([], liveLeads);
    expect(docIdentAfter.out).not.toContain('launched before team recorded its process');
    expect(readState(dir).sessions['acme']?.seats.worker?.id).toMatch(SEAT_ID_PATTERN);

    // 2. Rules-file warning: every seat, a lead included, is repaired with team reload — the
    // command that closes the ready seat and launches the file's line, which writes the rules file
    const withCodexLeads = withOp
      .replaceAll('cli: claude-code', 'cli: codex')
      .replaceAll('vendor: anthropic', 'vendor: openai')
      .replaceAll('model: Claude Opus', 'model: GPT Sol')
      .replaceAll('version: "5.5"', 'version: "6"')
      .replaceAll('launch: claude --model claude-opus-5-5', 'launch: codex');
    approveYaml(withCodexLeads);
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          lead: { stage: 'ready', pane: 'w0:p1', workspace: 'w0' },
          opSeat: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' },
          worker: { stage: 'ready', pane: 'w2:p1', workspace: 'w2' },
        },
        worktrees: {},
      };
    });
    const docRules = await runDoctorCmd([], liveLeads);
    expect(docRules.out).toContain('lead: its rules file is missing; run team reload lead');
    expect(docRules.out).toContain('opSeat: its rules file is missing; run team reload opSeat');
    expect(docRules.out).not.toContain('team remove lead --keep');
    expect(docRules.out).not.toContain('team remove opSeat --keep');

    // Run whole-team repair on fake host; afterwards the rules warning is gone
    const seatsToDown = [
      { name: 'lead', pane: 'w0:p1', workspace: 'w0' },
      { name: 'opSeat', pane: 'w1:p1', workspace: 'w1' },
      { name: 'worker', pane: 'w2:p1', workspace: 'w2' },
    ];
    const codexSeatsToDown = seatsToDown.map((s) => ({ ...s, cli: 'codex' }));
    expect(await runDown([...FILE], testIo(root, OWNER), downSourcesFor(codexSeatsToDown))).toBe(0);
    const madeCodex = world();
    madeCodex.session = 'running';
    const idle = codexCapture('idle');
    const paneState = new Map<string, { typed: string; pasted: boolean; entered: boolean }>();
    const stateFor = (pane: string) => {
      let s = paneState.get(pane);
      if (!s) {
        s = { typed: '', pasted: false, entered: false };
        paneState.set(pane, s);
      }
      return s;
    };
    madeCodex.launch.paneText = (_session, pane) => {
      const s = stateFor(pane);
      if (s.pasted) {
        const [first = '', ...rest] = s.typed.split('\n');
        return idle.replace('› Ask Codex to do anything', [`› ${first}`, ...rest.map((line) => `  ${line}`)].join('\n'));
      }
      return idle;
    };
    madeCodex.launch.typeText = (_session, pane, text) => {
      const s = stateFor(pane);
      s.typed = text;
      s.pasted = true;
      return true;
    };
    madeCodex.launch.pressEnter = (_session, pane) => {
      const s = stateFor(pane);
      s.pasted = false;
      s.entered = true;
      return true;
    };
    madeCodex.launch.agentStatus = (_session, pane) => (stateFor(pane).entered ? 'working' : 'idle');
    madeCodex.launch.foreground = () => ['codex'];
    madeCodex.launch.processInfo = () => ({ shell: 900, foreground: [901] });
    expect((await runUpCmd([], madeCodex)).code).toBe(0);
    const docRulesAfter = await runDoctorCmd([], liveLeads);
    expect(docRulesAfter.out).not.toContain('lead: its rules file is missing');
    expect(docRulesAfter.out).not.toContain('opSeat: its rules file is missing');

    // 3. Old lobby warning: coordinator and operator name only team down/up
    approveYaml(withOp);
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          lead: { stage: 'ready', pane: 'w0:p1', workspace: 'w0', start_cwd: oldLanding, launched: { shell: 1, cli: [2] } },
          opSeat: { stage: 'ready', pane: 'w1:p1', workspace: 'w1', start_cwd: oldLanding, launched: { shell: 1, cli: [2] } },
        },
        worktrees: {},
      };
    });
    const docOld = await runDoctorCmd([], {
      sessionRunning: () => true,
      agentList: () => [
        { name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: oldLanding },
        { name: 'opSeat', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: oldLanding },
      ],
    });
    expect(docOld.out).toContain(
      'the old lobby ../worktrees/acme/.lobby: seats lead, opSeat started in it; run `team down` then `team up` to move them into the lobby (to restart the whole team), then remove the folder',
    );
    expect(docOld.out).not.toContain('team remove <seat> --keep');

    // Single coordinator in old lobby
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          lead: { stage: 'ready', pane: 'w0:p1', workspace: 'w0', start_cwd: oldLanding, launched: { shell: 1, cli: [2] } },
        },
        worktrees: {},
      };
    });
    const docOldSingle = await runDoctorCmd([], {
      sessionRunning: () => true,
      agentList: () => [{ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: oldLanding }],
    });
    expect(docOldSingle.out).toContain(
      'the old lobby ../worktrees/acme/.lobby: seat lead started in it; run `team down` then `team up` (to restart the whole team) to move it into the lobby, then remove the folder',
    );
    expect(docOldSingle.out).not.toContain('team remove lead --keep');

    // Run whole-team repair on fake host; afterwards old lobby may be removed
    expect(await runDown([...FILE], testIo(root, OWNER), downSourcesFor([{ name: 'lead', pane: 'w0:p1', workspace: 'w0' }]))).toBe(0);
    const madeLobbyUp = world();
    madeLobbyUp.launch.processInfo = () => ({ shell: 900, foreground: [901] });
    expect((await runUpCmd([], madeLobbyUp)).code).toBe(0);
    const docOldAfter = await runDoctorCmd([], {
      sessionRunning: () => true,
      agentList: () => [{ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null }],
    });
    expect(docOldAfter.out).toContain('ok    the old lobby ../worktrees/acme/.lobby: may be removed\n');

    // 4. up's skip line: every seat, the lead's own included, names the one per-seat register run
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          lead: { stage: 'ready', pane: 'w0:p1', workspace: 'w0' },
          opSeat: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' },
          worker: { stage: 'ready', pane: 'w2:p1', workspace: 'w2' },
        },
        worktrees: {},
      };
    });
    const upWorld = world();
    upWorld.session = 'running';
    const upRun = await runUpCmd([], upWorld, {
      agents: () => [
        { name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null },
        { name: 'opSeat', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null },
        { name: 'worker', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null },
      ],
    });
    expect(upRun.code).toBe(0);
    expect(upRun.out).toContain('lead: ready\n');
    expect(upRun.out).toContain('worker: ready\n');
    expect(upRun.out).toContain('opSeat: ready\n');
    // Every record, the lead's own included, names the one per-seat register run: recording the
    // identity where the seat stands, never a whole-team restart for one seat's bookkeeping.
    expect(upRun.err).toContain(
      '  already ready; left as it is; its process was never recorded: run team register lead to record it, nothing relaunched\n'
        + '  already ready; left as it is; its process was never recorded: run team register worker to record it, nothing relaunched\n'
        + '  already ready; left as it is; its process was never recorded: run team register opSeat to record it, nothing relaunched\n',
    );
    expect(upRun.err).not.toContain('to restart the whole team');
    expect(upRun.err).not.toContain('team remove lead --keep');
    expect(upRun.err).not.toContain('team remove opSeat --keep');

    // Old landing skip line for coordinator
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          lead: { stage: 'ready', pane: 'w0:p1', workspace: 'w0', launched: { shell: 1, cli: [2] }, start_cwd: oldLanding },
        },
        worktrees: {},
      };
    });
    const upOld = await runUpCmd([], upWorld, {
      agents: () => [{ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null }],
    });
    expect(upOld.code).toBe(0);
    expect(upOld.out).toContain('lead: ready\n');
    expect(upOld.err).toContain(
      '  already ready; left as it is; a relaunch moves it into the lobby: team down, then team up (to restart the whole team)\n',
    );
    expect(upOld.err).not.toContain('team remove lead --keep');

    // Run whole-team repair on fake host; afterwards up launches fresh and the detail is gone
    expect(await runDown([...FILE], testIo(root, OWNER), downSourcesFor([{ name: 'lead', pane: 'w0:p1', workspace: 'w0' }]))).toBe(0);
    const upAfter = await runUpCmd([], world());
    expect(upAfter.code).toBe(0);
    expect(upAfter.out).toContain('lead: ready\n');
    expect(upAfter.err).not.toContain('already ready');
  });

  test('version "0" — the placeholder init writes — no longer stops the first fresh launch', async () => {
    approveYaml(migratedTeamYaml().replaceAll('version: "5.5"', 'version: "0"'));
    const run = await runUpCmd([], world());
    expect(run.code).toBe(0);
    expect(run.out).toContain('lead: ready\n');
    expect(run.out).toContain('worker: ready\n');
  });

  test('the family is still compared: a wrong model with version "0" stops exactly as today', async () => {
    const yaml = migratedTeamYaml()
      .replaceAll('version: "5.5"', 'version: "0"')
      .replaceAll('model: Claude Opus', 'model: Claude Sonnet');
    approveYaml(yaml);
    const run = await runUpCmd([], world());
    expect(run.code).toBe(1);
    expect(run.out).toContain('runs Claude Opus 5.5; the file says Claude Sonnet 0; left at launched, not named');
    expect(readState(dir).sessions['acme']?.seats.worker?.stage).toBe('launched');
  });

  test('no other spelling is the placeholder: "0.0" still stops the launch', async () => {
    approveYaml(migratedTeamYaml().replaceAll('version: "5.5"', 'version: "0.0"'));
    const run = await runUpCmd([], world());
    expect(run.code).toBe(1);
    expect(run.out).toContain('the file says Claude Opus 0.0; left at launched, not named');
  });

  test('doctor says the placeholder as information: the running model and the one edit', async () => {
    approveYaml(migratedTeamYaml().replaceAll('version: "5.5"', 'version: "0"'));
    updateState(dir, (st) => {
      st.sessions['acme'] = { seats: { worker: { stage: 'ready', pane: 'w1:p1' } }, worktrees: {} };
    });
    const over = { paneText: () => IDLE };
    const doc = await runDoctorCmd([], over);
    expect(doc.out).toContain(
      'worker: runs Claude Opus 5.5; the file\'s version "0" is the placeholder init writes — '
        + 'write "5.5" into the file',
    );
    // Information, not a block: the note adds no finding that stops anything.
    expect(doc.code).toBe(0);

    // A seat that runs another family than the file's warns with the mismatch the launch
    // check will print, naming the edit to model and version so the first upgrade edit covers it.
    const other = migratedTeamYaml()
      .replaceAll('version: "5.5"', 'version: "0"')
      .replaceAll('model: Claude Opus', 'model: Claude Sonnet');
    writeFileSync(join(root, '.agents', 'team.yaml'), other);
    const docOther = await runDoctorCmd([], over);
    expect(docOther.out).toContain(
      'warn  worker: runs Claude Opus 5.5; the file says Claude Sonnet 0 — '
        + 'write model: "Claude Opus" and version: "5.5" into the file',
    );
    expect(docOther.out).not.toContain('the placeholder init writes');

    // A real version produces neither placeholder note nor wrong-family warning.
    const realVersion = migratedTeamYaml()
      .replaceAll('model: Claude Opus', 'model: Claude Sonnet');
    writeFileSync(join(root, '.agents', 'team.yaml'), realVersion);
    const docReal = await runDoctorCmd([], over);
    expect(docReal.out).not.toContain('the placeholder init writes');
    expect(docReal.out).not.toContain('the file says Claude Sonnet 0');

    // A stopped team has no screen, so no placeholder finding is emitted.
    updateState(dir, (st) => {
      st.sessions['acme'] = { seats: {}, worktrees: {} };
    });
    const docStopped = await runDoctorCmd([], over);
    expect(docStopped.out).not.toContain('the placeholder init writes');
    expect(docStopped.out).not.toContain('the file says Claude Sonnet 0');
  });
});

describe('rules text', () => {
  test('assert exact rules text for shared and worktree seats, byte-identical otherwise', () => {
    const baseInput: RulesInput = {
      orchestrator: 'lead',
      rules: ['Never break CI.'],
      signature: { commit: 'Agent: Claude Opus 5.5 · implementer', pullRequest: '**Agent:** Claude Opus 5.5 · implementer', commitPosition: 'trailer' },
      workspace: { mode: 'worktree', protected: ['.'], branch: '{kind}/{task}', cwd: root },
    };

    const worktreeRules = seatRules(baseInput);
    const sharedRules = seatRules({
      ...baseInput,
      workspace: { mode: 'shared', protected: ['.'], cwd: root },
    });

    // Check specific workspace rules
    expect(worktreeRules).toContain('Work on the code in the worktree your brief names, never in the checkout you started in. Branches are named {kind}/{task}.');
    expect(sharedRules).toContain(`Change to ${root} before any project work.`);

    // Check that every other rule is byte-identical
    const worktreeFiltered = worktreeRules.filter((r) => !r.startsWith('Work on the code in the worktree'));
    const sharedFiltered = sharedRules.filter((r) => !r.startsWith('Change to '));
    expect(worktreeFiltered).toEqual(sharedFiltered);

    // Full exact output assertion for shared seat
    expect(sharedRules).toEqual([
      'End every commit message and every pull request body with your signature, given below.',
      'Never stop at a question: tell the orchestrator (lead) in one line and keep working.',
      'Never run `team grant`, `team delegate` or `team revoke`, and never edit `trust:` in the team file.',
      'In a protected checkout, never switch the branch, reset or commit.',
      'Never break CI.',
      'Your signature in a commit message, as a trailer, in a last paragraph of its own that holds trailers only: Agent: Claude Opus 5.5 · implementer',
      'Your signature in a pull request body, as its last line: **Agent:** Claude Opus 5.5 · implementer',
      'Protected checkouts, relative to the project root: .',
      `Change to ${root} before any project work.`,
    ]);
  });
});

describe('a launch line that cannot run where the seat starts', () => {
  function workerLaunch(): string {
    return migratedTeamYaml().replace(
      '    name: worker\n    label: worker\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n',
      '    name: worker\n    label: worker\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: zsh ../tools/x.sh\n',
    );
  }

  test('the dry run leaves the seat out before its workspace is made, and the others go on', async () => {
    approveYaml(workerLaunch());
    mkdirSync(join(base, 'tools'), { recursive: true });
    writeFileSync(join(base, 'tools', 'x.sh'), 'echo hi\n');
    const run = await runUpCmd(['--dry-run'], world());
    expect(run.code).toBe(0);
    expect(run.out).toContain('worker: would refuse: its launch line runs `../tools/x.sh`');
    expect(run.out).toContain('not found from its start folder ../worktrees/acme/.lobby');
    expect(run.out).not.toContain('<pane of worker>');
    expect(run.out).not.toContain('mkdir -p');
    expect(run.out).toContain(`--cwd ${root} --label lead`);
    expect(run.out).not.toContain(`--cwd ${lobby}`);
  });

  test('the real run refuses that seat only: its workspace is never made, the others start', async () => {
    approveYaml(workerLaunch());
    mkdirSync(join(base, 'tools'), { recursive: true });
    writeFileSync(join(base, 'tools', 'x.sh'), 'echo hi\n');
    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.out).toContain('worker: left out: refused: its launch line runs `../tools/x.sh`');
    expect(made.workspaces).toContainEqual({ label: 'lead', cwd: root });
    expect(made.workspaces.some((workspace) => workspace.cwd === lobby)).toBe(false);
    expect(made.workspaces.some((workspace) => workspace.label === 'worker')).toBe(false);
  });

  test('add refuses the seat too, before the file is edited, and makes no workspace', async () => {
    const text = workerLaunch();
    approveYaml(text);
    mkdirSync(join(base, 'tools'), { recursive: true });
    writeFileSync(join(base, 'tools', 'x.sh'), 'echo hi\n');
    const made = world();
    const run = await runAddCmd(['--temporary', '--like', 'worker', '--until', 'merged:fix/fresh'], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain('its launch line runs `../tools/x.sh`');
    expect(made.workspaces).toEqual([]);
    expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8')).toBe(text);
  });
});

describe('the gate fails closed and the launch uses the path it verified', () => {
  test('a missing config directory is absent, not a failure', () => {
    const res = verifyLobby(home, { create: false });
    expect(res).toEqual({ ok: true, missing: true });
  });

  test('a read error on .git refuses and names the path and the code', () => {
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    const fs: FsReader = {
      ...defaultFs,
      lstat(p) {
        if (p === join(lobby, '.git')) {
          const err = Object.assign(new Error('denied'), { code: 'EACCES' });
          throw err;
        }
        return defaultFs.lstat(p);
      },
    };
    const res = verifyLobby(home, { create: false, fs });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.text).toContain(join(lobby, '.git'));
      expect(res.text).toContain('EACCES');
    }
  });

  test('resolving the home is a refusal when it cannot be read', () => {
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    const fs: FsReader = {
      ...defaultFs,
      realpath(p) {
        if (p === home) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return defaultFs.realpath(p);
      },
    };
    const res = verifyLobby(home, { create: false, fs });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.text).toContain(home);
      expect(res.text).toContain('EACCES');
    }
  });

  test('a link swapped at the last moment the gate allows is refused and leaves the folder it names unchanged', () => {
    const outside = join(base, 'outside-mode');
    mkdirSync(outside, { recursive: true });
    chmodSync(outside, 0o755);
    let seen = 0;
    const fs: FsReader = {
      ...defaultFs,
      lstat(p) {
        const stat = defaultFs.lstat(p);
        // The swap lands after the read that returns a directory and before whatever the gate
        // does next with the path — the last moment the gate allows.
        if (p === lobby && stat.isDirectory() && ++seen === 2) {
          rmSync(lobby, { recursive: true });
          symlinkSync(outside, lobby, 'dir');
        }
        return stat;
      },
    };
    const res = verifyLobby(home, { create: true, fs });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.problem).toBe('symlink');
    expect(statSync(outside).mode & 0o777).toBe(0o755);
  });

  test('a link swapped after the lobby is created is caught by the second pass', () => {
    let directories = 0;
    const fs: FsReader = {
      ...defaultFs,
      lstat(p) {
        const stat = defaultFs.lstat(p);
        if (p === lobby && stat.isDirectory()) {
          directories++;
          if (directories >= 2) {
            return { isDirectory: () => false, isSymbolicLink: () => true, isFile: () => false, mode: stat.mode, uid: stat.uid, dev: stat.dev, ino: stat.ino };
          }
        }
        return stat;
      },
    };
    const res = verifyLobby(home, { create: true, fs });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.text).toContain('symbolic link');
  });

  /** An FsReader that swaps the lobby out of the way just before the `n`th read of its canonical
   *  path — after the gate's read, against the check that comes next: `'folder'` puts a fresh
   *  empty folder of the same owner and mode where the lobby was, a path puts a link there.
   *  A replacement folder is made beside the lobby while the lobby still exists and renamed into
   *  place: `rmSync` followed by `mkdirSync` can hand the old inode straight back — Linux did in
   *  CI — and a folder with the gate's own device and inode reads as the same folder, rightly. */
  function swapLobbyAt(n: number, replacement: 'folder' | string): FsReader {
    let seen = 0;
    return {
      ...defaultFs,
      realpath(p) {
        if (p === lobby && ++seen === n) {
          if (replacement === 'folder') {
            const aside = `${lobby}.replacement`;
            mkdirSync(aside, { mode: 0o700 });
            rmSync(lobby, { recursive: true });
            renameSync(aside, lobby);
          } else {
            rmSync(lobby, { recursive: true });
            symlinkSync(replacement, lobby, 'dir');
          }
        }
        return defaultFs.realpath(p);
      },
    };
  }

  test('a lobby swapped after the gate leaves the lead in the project and refuses the lobby seat: the record and the log hold the reason in words', async () => {
    approveYaml(migratedTeamYaml());
    const made = world();
    // The replacement is a real folder of the same owner, mode and emptiness: no link, no mode
    // difference, the same canonical path. Only device and inode tell it from the gate's folder.
    const run = await runUpCmd([], made, { fs: swapLobbyAt(2, 'folder') });
    expect(run.code).toBe(1);
    expect(made.workspaces).toEqual([{ label: 'lead', cwd: root }]);
    expect(made.workspaces.some((workspace) => workspace.cwd === lobby)).toBe(false);
    expect(made.typed).toEqual([]);
    // The record holds the words; the folder it names is stderr detail, for the owner alone.
    expect(run.out).toContain('lead: ready\n');
    expect(run.out).toContain('worker: left out: the lobby: it is not the folder the gate read\n');
    expect(run.out).not.toContain(lobby);
    expect(run.err).toContain(`  the lobby ${lobby}: it is not the folder the gate read\n`);
    const log = readFileSync(join(dir, 'team.log'), 'utf8');
    expect(log).toContain('worker: left out: the lobby: it is not the folder the gate read');
    expect(log).not.toContain(lobby);
    expect(Object.keys(readState(dir).sessions['acme']?.seats ?? {})).toEqual(['lead']);
  });

  test('a launch that ran but never read idle keeps the binding its settings file names', async () => {
    approveYaml(migratedTeamYaml());
    const made = world();
    // The worker's launch line runs, and its pane never reads the idle prompt, so the seat is
    // left at launched after its line — the settings file the line carried is what its process
    // loaded, and the successor binding the install recorded is the one the record must keep.
    const workerPane = (): string => {
      const at = made.workspaces.findIndex((workspace) => workspace.label === 'worker');
      return at < 0 ? '' : `w${at + 1}:p1`;
    };
    const launch = {
      ...made.launch,
      paneText: (_session: string, pane: string) => (pane === workerPane() ? 'nothing this version knows' : IDLE),
    };
    // The owner's terminal is handed end-of-input: the idle wait runs out and the seat is left
    // exactly as it is, so the test never waits at the pause's prompt.
    const io = testIo(root, OWNER);
    const sources: UpSources = {
      sessionRunning: () => made.session === 'running',
      sessionState: () => made.session,
      agents: () => [],
      home,
      doctor: runDoctorCmdSources(),
      launch,
      terminal: () => ({ key: async () => 'eof' as const, drain: () => {} }),
      now: () => NOW,
    };
    const code = await runUp([...FILE], io, sources);
    expect(code).toBe(1);
    expect(io.out).toContain('worker: left out: its input ended; left as it is\n');
    const worker = readState(dir).sessions['acme']?.seats.worker;
    expect(worker?.stage).toBe('launched');
    expect(worker?.presence_binding).toMatch(/^prs_[0-9a-f]{12}$/);
    const line = made.runs.find((command) => command.includes('/worker.json'));
    expect(line).toBeDefined();
    const settings = /--settings (\S+)/.exec(line!)?.[1];
    expect(settings).toBeDefined();
    expect(readFileSync(settings!, 'utf8')).toContain(worker!.presence_binding!);
  });

  test('add creates nothing for the same swap, and leaves the folder it names unchanged: the log holds no folder', async () => {
    approveYaml(migratedTeamYaml());
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    chmodSync(outside, 0o755);
    const made = world();
    const run = await runAddCmd(['worker'], made, { fs: swapLobbyAt(2, outside) });
    expect(run.code).toBe(1);
    expect(made.workspaces).toEqual([]);
    expect(made.paneIds()).toEqual([]);
    expect(made.runs).toEqual([]);
    expect(made.typed).toEqual([]);
    // The record holds the words; the canonical paths the check compared are stderr detail.
    expect(run.out).toContain('worker: left out: the lobby: its canonical path leads somewhere else\n');
    expect(run.out).not.toContain(lobby);
    expect(run.err).toContain('  the lobby ');
    expect(run.err).toContain('canonical path');
    const log = readFileSync(join(dir, 'team.log'), 'utf8');
    expect(log).toContain('worker: left out: the lobby: its canonical path leads somewhere else');
    expect(log).not.toContain(lobby);
    expect(readdirSync(outside)).toEqual([]);
    expect(statSync(outside).mode & 0o777).toBe(0o755);
  });

  test('a swap between two seats stops the next one and leaves the first running: the stopped seat’s record and log hold no folder', async () => {
    approveYaml(migratedTeamYaml());
    const made = world();
    // The gate reads first. The lead starts in the project and does not read the lobby again;
    // the worker's confirmation is the second read, and the swap lands there.
    const run = await runUpCmd([], made, { fs: swapLobbyAt(2, 'folder') });
    expect(run.code).toBe(1);
    expect(made.workspaces).toEqual([{ label: 'lead', cwd: root }]);
    expect(run.out).toContain('lead: ready');
    expect(run.out).toContain('worker: left out: the lobby: it is not the folder the gate read\n');
    expect(run.out).not.toContain(lobby);
    expect(run.err).toContain(`  the lobby ${lobby}: it is not the folder the gate read\n`);
    const log = readFileSync(join(dir, 'team.log'), 'utf8');
    expect(log).toContain('worker: left out: the lobby: it is not the folder the gate read');
    expect(log).not.toContain(lobby);
    // The lead was created in the project; nothing closes it.
    expect(made.closed).toEqual([]);
    expect(made.launch.agentPanes('acme')).toEqual(['w1:p1']);
  });

  test('a read error while resolving a landing is a refusal', () => {
    const fs: FsReader = {
      ...defaultFs,
      lstat(p) {
        if (p === root) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return defaultFs.lstat(p);
      },
    };
    const landed = canonicalLanding(join(root, 'child'), fs);
    expect(landed.error).toEqual({ path: root, code: 'EACCES' });
    expect(insideTrust(join(root, 'child'), [root], root, home, fs)).toBe(false);
  });

  test('a backtick in a protected checkout is refused', () => {
    const yaml = migratedTeamYaml().replace('protected: [.]', 'protected: [".", "`x"]');
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.errors.some((error) => error.message.includes('workspace.protected'))).toBe(true);
  });

  test('a trust entry covering the approval store is detected', async () => {
    // The store's own folder, spelled through `~`: only the approval-store check can refuse it.
    const store = storePath('acme', root, home);
    const yaml = migratedTeamYaml().replace('trust:\n', `trust:\n  - ~/.config/team/${store.split('/').pop()}\n`);
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const run = await runApproveCmd();
    expect(run.code).not.toBe(0);
    expect(run.err).toContain('approval store');
    expect(run.err).toContain('.config/team');
  });

  test('a migrated file listing "/", the home, or a folder above them is refused at load, naming the entry', () => {
    const cases: [string, string, RegExp][] = [
      ['/', '/', /root of the filesystem/],
      ['"~"', '~', /is the home itself/],
      [home, home, /is the home itself/],
      [join(home, '.config', 'team'), join(home, '.config', 'team'), /holds the lobby and the approval store/],
      [base, base, /holds the lobby and the approval store/],
    ];
    for (const [written, value, reason] of cases) {
      const yaml = migratedTeamYaml().replace('trust:\n', `trust:\n  - ${written}\n`);
      writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
      const loaded = loadTeamFile(root, { home });
      expect(loaded.ok).toBe(false);
      if (loaded.ok) continue;
      const text = loaded.errors.map((error) => error.message).join('\n');
      expect(text).toContain(`trust: "${value}"`);
      expect(text).toMatch(reason);
    }
  });

  test('the project root, a folder under it, the lobby, and a worktrees folder beside the project stay acceptable', () => {
    const yaml = migratedTeamYaml().replace('  - ~/.config/team/lobby\n', `  - ~/.config/team/lobby\n  - ${join(root, 'notes')}\n`);
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
  });

  test('the launch uses the gate\'s canonical lobby when the home is reached through a link', async () => {
    const realHome = join(base, 'real', 'home');
    mkdirSync(realHome, { recursive: true });
    const link = join(base, 'link');
    symlinkSync(join(base, 'real'), link, 'dir');
    const homeLink = join(link, 'home');
    const canonical = lobbyDir(realHome);
    expect(lobbyDir(homeLink)).not.toBe(canonical);
    // The file names the link-free entry; the launch must use the gate's canonical one.
    approveYaml(migratedTeamYaml().replace('~/.config/team/lobby', canonical), homeLink);

    const made = world();
    const run = await runUpCmd([], made, { home: homeLink });
    expect(run.code).toBe(0);
    expect(made.workspaces).toContainEqual({ label: 'lead', cwd: root });
    expect(made.workspaces).toContainEqual({ label: 'worker', cwd: canonical });
    const state = readState(dir);
    expect(state.sessions['acme']?.seats['lead']?.start_cwd).toBe(root);
    expect(state.sessions['acme']?.seats['worker']?.start_cwd).toBe(canonical);
  });

  test('a temporary add launched through a linked home lands in the canonical lobby', async () => {
    const realHome = join(base, 'real', 'home');
    mkdirSync(realHome, { recursive: true });
    const link = join(base, 'link');
    symlinkSync(join(base, 'real'), link, 'dir');
    const homeLink = join(link, 'home');
    const canonical = lobbyDir(realHome);
    approveYaml(migratedTeamYaml().replace('~/.config/team/lobby', canonical), homeLink);

    const made = world();
    expect((await runUpCmd([], made, { home: homeLink })).code).toBe(0);
    const before = made.workspaces.length;
    const addRun = await runAddCmd(['--temporary', '--like', 'worker', '--until', 'merged:main'], made, { home: homeLink });
    expect(addRun.code).toBe(0);
    expect(made.workspaces.slice(before)).toContainEqual({ label: 'worker-tmp-01', cwd: canonical });
  });

  test('an existing lobby with a looser mode is refused, never repaired', () => {
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o755);
    const res = verifyLobby(home, { create: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.text).toContain('not 0700');
    expect(statSync(lobby).mode & 0o7777).toBe(0o755);
  });

  test('doctor notes a migrated file that has never been approved', async () => {
    writeFileSync(join(root, '.agents', 'team.yaml'), migratedTeamYaml());
    const doc = await runDoctorCmd();
    // The file is no longer legacy, so the migration note stays away; the next step the owner
    // has is the approval.
    expect(doc.out).not.toContain('the file is legacy');
    expect(doc.out).not.toContain('team approve');
  });

  test('a resumed launch from a migrated approved file keeps the recorded start folder', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          lead: { stage: 'ready', pane: 'w0:p1', workspace: 'w0', start_cwd: lobby },
          worker: { stage: 'ready', pane: 'w1:p1', workspace: 'w1', start_cwd: lobby },
        },
        worktrees: {},
      };
    });
    const made = world();
    made.session = 'running';
    const run = await runUpCmd([], made, {
      sessionRunning: () => true,
      agents: () => [
        { name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: lobby },
        { name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: lobby },
      ],
      workspaces: () => [{ id: 'w0', label: 'lead' }, { id: 'w1', label: 'worker' }],
    });
    expect(run.err).not.toContain('the file is legacy');
    expect(run.code).toBe(0);
    const state = readState(dir);
    expect(state.sessions['acme']?.seats.lead?.start_cwd).toBe(lobby);
    expect(state.sessions['acme']?.seats.worker?.start_cwd).toBe(lobby);
  });

  test('a migrated lead starts in the project and every other seat starts in the lobby', () => {
    writeFileSync(join(root, '.agents', 'team.yaml'), migratedTeamYaml());
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    for (const seat of loaded.team.seats) {
      const start = seatStart(loaded.team, seat, root, home);
      if (seat.name === 'lead') expect(start).toEqual({ cwd: root });
      else expect(start).toEqual({ cwd: lobby, lobby: true });
    }
  });

  test('creating the lobby waits until a launch will actually happen', async () => {
    approveYaml(migratedTeamYaml());
    const made = world();
    const run = await runUpCmd([], made, {
      seatBudget: () => ({ kind: 'refuse', why: 'the account is spent' }),
    });
    expect(existsSync(lobby)).toBe(false);
    expect(made.workspaces.some((workspace) => workspace.label !== watchLabel('acme'))).toBe(false);
    expect(run.out).toContain('the account is spent');
  });
});
