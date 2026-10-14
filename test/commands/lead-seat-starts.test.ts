import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { launchedTeamFile } from '../../src/file/launched-file.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { canonicalLanding } from '../../src/file/paths.ts';
import { seatStart } from '../../src/worktree/place.ts';
import { readState, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-04T09:00:00Z');
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
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

function seat(name: string, role: string): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
  ].join('\n');
}

// A migrated file with a lead (`lead`) and one ordinary seat (`worker`). The lead holds both
// lead roles, so `seatStart`'s lead branch is the one under test.
function migratedTeamYaml(): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: alpha
trust:
  - ${lobby}
  - ${root}
  - ${join(base, 'worktrees')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [.]
seats:
${seat('lead', 'coordinator')}
    mode: shared
    cwd: .
${seat('worker', 'implementer')}
    count: 1
`;
}

// The same file with the trust a release before absolute paths wrote: a legacy file, where a
// lead is placed by the legacy rules, not the project-root rule.
function legacyTeamYaml(): string {
  return migratedTeamYaml().replace(
    `trust:
  - ${lobby}
  - ${root}
  - ${join(base, 'worktrees')}`,
    `trust:
  - .
  - ../worktrees/acme/*`,
  );
}

function approveYaml(text: string, file: string = 'team.yaml'): string {
  const path = join(dir, file);
  writeFileSync(path, text);
  const loaded = loadTeamFile(root, { file: path, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: text },
    loaded.team.seats,
    home,
  );
  return path;
}

function world(first: number = 1): {
  launch: Launch;
  workspaces: { label: string; cwd: string }[];
  session: 'absent' | 'running';
} {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = first - 1;
  let clock = NOW.getTime();
  const made = {
    launch: {} as Launch,
    workspaces: [] as { label: string; cwd: string }[],
    session: 'absent' as 'absent' | 'running',
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
    paneRun(_session, pane, _command) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    typeText: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
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

function doctorSources(over: Partial<DoctorSources> = {}): DoctorSources {
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

async function runUpCmd(argv: string[], made: ReturnType<typeof world>, over: Partial<UpSources> = {}) {
  const io = testIo(root, OWNER);
  const sources: UpSources = {
    sessionRunning: () => made.session === 'running',
    sessionState: () => made.session,
    agents: () => [],
    home,
    doctor: doctorSources(),
    launch: made.launch,
    now: () => NOW,
    ...over,
  };
  const code = await runUp(argv, io, sources);
  return { code, out: io.out, err: io.err };
}

async function runAddCmd(argv: string[], made: ReturnType<typeof world>, over: Partial<AddSources> = {}) {
  const io = testIo(root, OWNER);
  const sources: AddSources = {
    home,
    sessionState: () => made.session,
    agents: () => [],
    workspaces: () => [],
    doctor: doctorSources(),
    now: () => NOW,
    launch: made.launch,
    ...over,
  };
  const code = await runAdd(argv, io, sources);
  return { code, out: io.out, err: io.err };
}

async function runDoctorCmd(argv: string[], over: Partial<DoctorSources> = {}) {
  const io = testIo(root, OWNER);
  const code = await runDoctor(argv, io, doctorSources(over));
  return { code, out: io.out, err: io.err };
}

// The caller a seat's own command runs as, for reading the launched-file pointer.
function seatCaller(name: string, pane: string) {
  return {
    caller: { kind: 'seat', name, pane } as const,
    env: {},
    stdinIsTTY: false,
    callerSources: () => ({ ancestors: () => [], agents: () => [], paneRootPid: () => null, env: {}, stdinIsTTY: false }),
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-lead-seats-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('a lead on a file whose trust is not migrated', () => {
  test('a legacy shared lead still starts in the cwd the file gives it', () => {
    writeFileSync(join(dir, 'team.yaml'), legacyTeamYaml());
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const lead = loaded.team.seats.find((s) => s.name === 'lead')!;
    expect(lead.mode).toBe('shared');
    expect(seatStart(loaded.team, lead, root, home)).toEqual({ cwd: '.' });
  });

  test('a legacy worktree lead still waits in the old derived lobby', () => {
    const text = legacyTeamYaml().replace('    mode: shared\n    cwd: .\n', '');
    writeFileSync(join(dir, 'team.yaml'), text);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const lead = loaded.team.seats.find((s) => s.name === 'lead')!;
    const start = seatStart(loaded.team, lead, root, home);
    expect('lobby' in start && start.lobby).toBe(true);
    expect('cwd' in start ? resolve(root, start.cwd) : '').toBe(join(base, 'worktrees', 'acme', '.lobby'));
  });

  test('a file with no trust at all still refuses, for a lead like any seat', () => {
    const text = legacyTeamYaml().replace(/trust:\n(  - .*\n)+/, '');
    writeFileSync(join(dir, 'team.yaml'), text);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const lead = loaded.team.seats.find((s) => s.name === 'lead')!;
    const start = seatStart(loaded.team, lead, root, home);
    expect('problem' in start).toBe(true);
    if ('problem' in start) expect(start.problem).toContain('migrate trust to absolute paths');
  });
});

describe('doctor on both layouts for the seat the change does not help', () => {
  // The worker seat as a cursor seat, whose captured trust dialog names the folder it waits in.
  function cursorWorkerYaml(): string {
    return migratedTeamYaml().replace(
      `${seat('worker', 'implementer')}\n    count: 1\n`,
      `${seat('worker', 'implementer')
        .replace('cli: claude-code', 'cli: cursor')
        .replace('vendor: anthropic', 'vendor: cursor')
        .replace('model: Claude Opus', 'model: Composer')
        .replace('version: "5.5"', 'version: "2.5"')
        .replace('launch: claude --model claude-opus-5-5', 'launch: cursor-agent')}\n    count: 1\n`,
    );
  }

  function trustScreen(folder: string): string {
    const captured = readFileSync(join(import.meta.dir, '..', 'fixtures', 'cursor', '2026.10.01', 'trust.txt'), 'utf8');
    return captured.replace('<untrusted-directory>', folder);
  }

  function workerWaitingAtTrust() {
    updateState(dir, (st) => {
      st.sessions['alpha'] = {
        seats: {
          worker: { stage: 'launched', pane: 'w0:p1', workspace: 'w0', waiting: { state: 'waiting-owner', classification: 'trust' } },
        },
        worktrees: {},
      };
    });
  }

  test('a non-lead waiting at trust in the project folder is still told the folder is wrong', async () => {
    approveYaml(cursorWorkerYaml());
    workerWaitingAtTrust();
    const at = await runDoctorCmd(['--file', '.agents/team.yaml'], {
      version: (binary) => (binary === 'cursor-agent' ? '2026.10.01-14929f9' : '2.1.288'),
      paneText: () => trustScreen(root),
      sessionRunning: () => true,
      agentList: () => [{ name: 'worker', agent: 'cursor-agent', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null }],
    });
    expect(at.out).toContain('worker: waiting at trust; the folder is not the lobby');
  });

  test('the same worker at trust in the lobby is not warned', async () => {
    approveYaml(cursorWorkerYaml());
    workerWaitingAtTrust();
    const at = await runDoctorCmd(['--file', '.agents/team.yaml'], {
      version: (binary) => (binary === 'cursor-agent' ? '2026.10.01-14929f9' : '2.1.288'),
      paneText: () => trustScreen(lobby),
      sessionRunning: () => true,
      agentList: () => [{ name: 'worker', agent: 'cursor-agent', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null }],
    });
    expect(at.out).not.toContain('worker: waiting at trust; the folder is not the lobby');
  });
});

describe('add records the project root for a lead it launches', () => {
  test('a lead added by name starts in the project and records that folder', async () => {
    approveYaml(migratedTeamYaml());
    const made = world();
    made.session = 'running';
    made.launch.processInfo = () => ({ shell: 900, foreground: [901] });
    const run = await runAddCmd(['lead', '--file', '.agents/team.yaml'], made);
    expect(run.code).toBe(0);
    expect(made.workspaces).toContainEqual({ label: 'lead', cwd: root });
    expect(readState(dir).sessions['alpha']?.seats.lead?.start_cwd).toBe(root);
  });
});

describe('two teams whose project roots are the same checkout', () => {
  function secondTeamYaml(): string {
    return `format: 1
project: acme
coordinator: lead2
operator: lead2
session: beta
entity: zeta
trust:
  - ${join(home, '.config', 'team', 'lobbies', 'zeta')}
  - ${root}
  - ${join(base, 'worktrees')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [.]
seats:
${seat('lead2', 'coordinator')}
    mode: shared
    cwd: .
${seat('worker2', 'implementer')}
    count: 1
`;
  }

  test('each team launches its lead at the root and its worker in its own lobby, and each lead pane resolves its own file', async () => {
    const lobbyZeta = join(home, '.config', 'team', 'lobbies', 'zeta');
    const fileA = approveYaml(migratedTeamYaml());
    const worldA = world(1);
    const runA = await runUpCmd(['--file', fileA], worldA);
    expect(runA.code).toBe(0);
    expect(worldA.workspaces).toContainEqual({ label: 'lead', cwd: root });
    expect(worldA.workspaces).toContainEqual({ label: 'worker', cwd: lobby });
    expect(readState(dir).sessions['alpha']?.seats.lead?.start_cwd).toBe(root);
    expect(readState(dir).sessions['alpha']?.seats.worker?.start_cwd).toBe(canonicalLanding(lobby).landing);

    const fileB = approveYaml(secondTeamYaml(), 'team-b.yaml');
    const worldB = world(10);
    const runB = await runUpCmd(['--file', fileB], worldB);
    expect(runB.code).toBe(0);
    expect(worldB.workspaces).toContainEqual({ label: 'lead2', cwd: root });
    expect(worldB.workspaces).toContainEqual({ label: 'worker2', cwd: lobbyZeta });
    expect(readState(dir).sessions['beta']?.seats.lead2?.start_cwd).toBe(root);
    expect(readState(dir).sessions['beta']?.seats.worker2?.start_cwd).toBe(canonicalLanding(lobbyZeta).landing);

    // The one state file beside the two files vouches each session's own launched file.
    expect(readState(dir).sessions['alpha']?.launched_file).toBe(fileA);
    expect(readState(dir).sessions['beta']?.launched_file).toBe(fileB);

    // A seat command run from the shared root resolves the file its pane was launched from.
    const paneA = readState(dir).sessions['alpha']?.seats.lead?.pane;
    const paneB = readState(dir).sessions['beta']?.seats.lead2?.pane;
    expect(paneA).toBeDefined();
    expect(paneB).toBeDefined();
    if (paneA && paneB) {
      expect(launchedTeamFile(seatCaller('lead', paneA), home)).toBe(fileA);
      expect(launchedTeamFile(seatCaller('lead2', paneB), home)).toBe(fileB);
    }
  });
});
