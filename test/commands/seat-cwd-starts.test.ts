import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { seatStart } from '../../src/worktree/place.ts';
import { readState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-04T09:00:00Z');
const IDLE = CLAUDE_IDLE;
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

// A migrated file with a lead and a worker. `workerLines` is spliced into the worker's seat, so
// a test sets its cwd or mode. `protectedList` is the workspace's protected checkouts.
function yamlWith(workerLines: string, protectedList: string = '[../elsewhere]'): string {
  return migratedTeamYaml()
    .replace('protected: [.]', `protected: ${protectedList}`)
    .replace(`${seat('worker', 'implementer')}\n    count: 1\n`, `${seat('worker', 'implementer')}\n${workerLines}    count: 1\n`)
}


function load(text: string) {
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return loaded.team;
}

function seatOf(team: ReturnType<typeof load>, name: string) {
  return team.seats.find((s) => s.name === name)!;
}

describe('seatStart in a migrated file: a non-lead seat with an explicit cwd', () => {
  beforeEach(() => {
    mkdirSync(join(root, 'tools', 'dev'), { recursive: true });
  });

  test('a shared seat starts in its cwd, resolved against the project root, with no lobby flag', () => {
    const team = load(yamlWith('    mode: shared\n    cwd: tools/dev\n'));
    const start = seatStart(team, seatOf(team, 'worker'), root, home);
    expect(start).toEqual({ cwd: join(root, 'tools', 'dev') });
    expect('lobby' in start).toBe(false);
  });

  test('a worktree-mode seat with a cwd starts there too, never in the lobby', () => {
    const team = load(yamlWith('    cwd: tools/dev\n'));
    const worker = seatOf(team, 'worker');
    expect(worker.mode).not.toBe('shared');
    const start = seatStart(team, worker, root, home, join(lobby, 'verified'));
    expect(start).toEqual({ cwd: join(root, 'tools', 'dev') });
    expect('lobby' in start).toBe(false);
  });

  test('a cwd inside the project starts there when that folder is not in a protected checkout', () => {
    const team = load(yamlWith('    mode: shared\n    cwd: tools\n'));
    expect(seatStart(team, seatOf(team, 'worker'), root, home)).toEqual({ cwd: join(root, 'tools') });
  });

  test('a seat without a cwd keeps the lobby default', () => {
    const team = load(yamlWith(''));
    const worker = seatOf(team, 'worker');
    expect(worker.cwd).toBe('.');
    expect(seatStart(team, worker, root, home)).toEqual({ cwd: lobby, lobby: true });
    expect(seatStart(team, worker, root, home, '/verified/lobby')).toEqual({ cwd: '/verified/lobby', lobby: true });
  });

  test('a shared seat without a cwd also waits in the lobby, as before', () => {
    const team = load(yamlWith('    mode: shared\n'));
    expect(seatStart(team, seatOf(team, 'worker'), root, home)).toEqual({ cwd: lobby, lobby: true });
  });

  test('a lead keeps starting in the project root', () => {
    const team = load(yamlWith('    cwd: tools/dev\n'));
    expect(seatStart(team, seatOf(team, 'lead'), root, home)).toEqual({ cwd: root });
  });

  test('a lead with an explicit cwd still starts in the project root', () => {
    const team = load(yamlWith('    cwd: tools/dev\n').replace('    mode: shared\n    cwd: .\n', '    mode: shared\n    cwd: tools/dev\n'));
    expect(seatOf(team, 'lead').cwd).toBe('tools/dev');
    expect(seatStart(team, seatOf(team, 'lead'), root, home)).toEqual({ cwd: root });
  });

  test('an explicit cwd inside a protected checkout is still refused', () => {
    const team = load(yamlWith('    cwd: tools\n', '[.]'));
    const start = seatStart(team, seatOf(team, 'worker'), root, home);
    expect('problem' in start).toBe(true);
    if ('problem' in start) {
      expect(start.problem).toContain('seat worker would start in tools, inside the protected checkout .');
    }
  });

  test('a shared seat with a cwd inside a protected checkout is refused with the shared wording', () => {
    const team = load(yamlWith('    mode: shared\n    cwd: tools\n', '[.]'));
    const start = seatStart(team, seatOf(team, 'worker'), root, home);
    expect('problem' in start).toBe(true);
    if ('problem' in start) expect(start.problem).toContain('a shared seat never works in a protected checkout');
  });
});

describe('up with a non-lead seat that names a cwd in a migrated file', () => {
  beforeEach(() => {
    mkdirSync(join(root, 'tools', 'dev'), { recursive: true });
  });

  test('the worker is launched in its cwd, and its record holds that folder, not the lobby', async () => {
    const file = approveYaml(yamlWith('    mode: shared\n    cwd: tools/dev\n'));
    const made = world();
    const run = await runUpCmd(['--file', file], made);
    expect(run.code).toBe(0);
    expect(made.workspaces).toContainEqual({ label: 'lead', cwd: root });
    expect(made.workspaces).toContainEqual({ label: 'worker', cwd: join(root, 'tools', 'dev') });
    expect(made.workspaces.some((w) => w.cwd === lobby)).toBe(false);
    expect(readState(dir).sessions['alpha']?.seats.worker?.start_cwd).toBe(join(root, 'tools', 'dev'));
  });

  test('a seat without a cwd is still launched in the lobby while its sibling starts in its own cwd', async () => {
    const text = yamlWith('    mode: shared\n    cwd: tools/dev\n').replace(
      '    count: 1\n',
      `    count: 1\n${seat('plain', 'implementer')}\n    count: 1\n`,
    );
    const file = approveYaml(text);
    const made = world();
    const run = await runUpCmd(['--file', file], made);
    expect(run.code).toBe(0);
    expect(made.workspaces).toContainEqual({ label: 'worker', cwd: join(root, 'tools', 'dev') });
    expect(made.workspaces).toContainEqual({ label: 'plain', cwd: lobby });
  });

  test('a cwd inside a protected checkout is refused by up and nothing is launched for the worker', async () => {
    const file = approveYaml(yamlWith('    mode: shared\n    cwd: tools/dev\n', '[../elsewhere, tools]'));
    const made = world();
    const run = await runUpCmd(['--file', file], made);
    expect(run.code).not.toBe(0);
    expect(run.err + run.out).toContain('inside the protected checkout');
    expect(made.workspaces.some((w) => w.label === 'worker')).toBe(false);
  });
});
