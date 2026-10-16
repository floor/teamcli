// The unsigned state file can say anything, so `team add` and `team worktree remove` read it as
// claims, not facts. An unnamed pane is adopted only when the record is uncontested — no other
// seat on its workspace or on its pane — and the live pane is the recorded one; a recorded
// launch fingerprint that cannot be confirmed ends the adoption, and one the pane still holds
// lets it through. A live agent the file does not declare charges the seats ceiling like any
// seat. And a worktree record whose branch does not fill the approved `{kind}/{task}` pattern —
// a kind that is not a slug, an empty kind, a foreign task — removes nothing.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runWorktree, type WorktreeSources } from '../src/commands/worktree.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { Launch } from '../src/commands/up.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo, type TestIo } from './helpers.ts';
import type { Machine } from '../src/watch/machine.ts';

const NOW = new Date('2026-10-03T14:02:00Z');
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const owner = { kind: 'owner' } as const;

let base: string;
let project: string;
let home: string;

const ADD_FILE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
  base: main
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
    stopped: true
`;

const WORKTREE_FILE = `format: 1
project: acme
visibility: public
coordinator: lead
operator: lead
identity:
  forbidden_public:
    - "\\\\bWEB-[0-9]+\\\\b"
trust:
  - ../worktrees/acme/*
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  limit: 8
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function approveAdd(text: string = ADD_FILE): void {
  const trustPath = project.startsWith(home) ? project.replace(home, '~') : project;
  const yaml = text.replace('coordinator: lead\n', `coordinator: lead\ntrust:\n  - ~/.config/team/lobby\n  - ${trustPath}\n  - ${join(home, 'worktrees')}\n`);
  mkdirSync(join(project, '.agents'), { recursive: true });
  writeFileSync(join(project, '.agents', 'team.yaml'), yaml);
  const loaded = loadTeamFile(project, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: yaml },
    loaded.team.seats,
    home,
  );
}

function approveWorktree(text: string = WORKTREE_FILE): void {
  mkdirSync(join(project, '.agents'), { recursive: true });
  writeFileSync(join(project, '.agents', 'team.yaml'), text);
  const loaded = loadTeamFile(project);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: text },
    loaded.team.seats,
    home,
  );
}

function doctor(): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

function world(): { launch: Launch; creates: string[]; renames: string[] } {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  let clock = NOW.getTime();
  const made = { launch: {} as Launch, creates: [] as string[], renames: [] as string[] };
  made.launch = {
    sessionState: () => 'running',
    startServer() {
      return true;
    },
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      n++;
      panes.set(`w${n}:p1`, { text: IDLE, agent: false });
      made.creates.push(label);
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent(_session, _pane, name) {
      made.renames.push(name);
      return true;
    },
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes: (_session, workspace) => {
      const found = [...panes.keys()].filter((p) => p.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return made;
}

function addSources(made: ReturnType<typeof world>, extra: Partial<AddSources> = {}): AddSources {
  return {
    home,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(),
    machine: () => fine,
    now: () => NOW,
    launch: made.launch,
    ...extra,
  };
}

function strayAgent(pane: string, workspace: string): HerdrAgent {
  return { name: null, agent: 'claude', pane, workspace, status: 'idle', cwd: null };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-unsigned-state-')));
  home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  project = join(home, 'acme');
  mkdirSync(join(project, '.agents'), { recursive: true });
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(project, 'README.md'), 'acme\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'remote', 'add', 'origin', remote);
  git(project, 'push', '-q', '-u', 'origin', 'main');
  approveAdd();
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('the unnamed pane a seat may adopt', () => {
  test('is the recorded pane: an unnamed agent at another pane in the workspace launches fresh', async () => {
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.lead = { stage: 'launched', workspace: 'w9', pane: 'w9:p1' };
      state.sessions.acme = session;
    });
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['lead'], io, addSources(made, {
      agents: () => [strayAgent('w9:p2', 'w9')],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code, io.out + io.err).toBe(0);
    expect(made.creates).toEqual(['lead']);
  });

  test('is uncontested: a recorded seat sharing only the pane launches fresh', async () => {
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.lead = { stage: 'launched', workspace: 'w9', pane: 'w9:p1' };
      session.seats.worker = { stage: 'ready', workspace: 'w8', pane: 'w9:p1' };
      state.sessions.acme = session;
    });
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['lead'], io, addSources(made, {
      agents: () => [strayAgent('w9:p1', 'w9')],
      workspaces: () => [{ id: 'w9' }, { id: 'w8' }],
    }));
    expect(code, io.out + io.err).toBe(0);
    expect(made.creates).toEqual(['lead']);
  });

  test('is confirmed by the launch fingerprint: a record whose pane cannot be read launches fresh', async () => {
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.lead = { stage: 'launched', workspace: 'w9', pane: 'w9:p1', launched: { shell: 1, cli: [2] } };
      state.sessions.acme = session;
    });
    const made = world();
    made.launch.processInfo = () => ({ shell: 1, foreground: [] });
    const io = testIo(project, owner);
    const code = await runAdd(['lead'], io, addSources(made, {
      agents: () => [strayAgent('w9:p1', 'w9')],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code, io.out + io.err).toBe(0);
    expect(made.creates).toEqual(['lead']);
  });

  test('a pane that still holds the recorded fingerprint is adopted, not relaunched', async () => {
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.lead = { stage: 'launched', workspace: 'w9', pane: 'w9:p1', launched: { shell: 1, cli: [2] } };
      state.sessions.acme = session;
    });
    const made = world();
    made.launch.paneText = () => IDLE;
    made.launch.agentPanes = () => ['w9:p1'];
    made.launch.processInfo = () => ({ shell: 1, foreground: [2] });
    const io = testIo(project, owner);
    const code = await runAdd(['lead'], io, addSources(made, {
      agents: () => [strayAgent('w9:p1', 'w9')],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code, io.out + io.err).toBe(0);
    expect(made.creates).toEqual([]);
    expect(made.renames).toEqual(['lead']);
  });
});

describe('a live agent the file does not declare', () => {
  test('charges the seats ceiling like a declared one', async () => {
    const yaml = `${readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')}limits:\n  seats: 2\n  temporary: 1\n  vendors:\n    anthropic: 1\n    openai: 1\n`;
    writeFileSync(join(project, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(project, { home });
    if (!loaded.ok) throw new Error('load');
    writeApproval(
      storePath(loaded.team.project, loaded.root, home),
      {
        approval: approvalOf(loaded.team, loaded.root),
        file: yaml,
      },
      loaded.team.seats,
      home,
    );
    const declared: HerdrAgent = { name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null };
    const stranger: HerdrAgent = { name: 'visitor-x', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null };
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['lead'], io, addSources(made, {
      agents: () => [declared, stranger],
      workspaces: () => [{ id: 'w1' }, { id: 'w2' }],
    }));
    expect(code).toBe(1);
    expect(io.err).toContain('the file allows 2 seats; 3 would be running');
  });
});

describe('worktree remove and the recorded branch', () => {
  let sources: WorktreeSources;

  async function run(argv: string[]): Promise<TestIo & { code: number }> {
    const io = testIo(project, owner) as TestIo & { code: number };
    io.code = await runWorktree(argv, io, sources);
    return io;
  }

  beforeEach(() => {
    sources = { home, now: () => new Date('2026-10-03T12:00:00Z') };
    approveWorktree();
  });

  test('a recorded branch that fills no pattern is a hint: the branch read from git is the one named', async () => {
    expect((await run(['new', 'select-width', '--kind', 'fix'])).code).toBe(0);
    git(project, 'push', '-q', 'origin', 'fix/select-width');
    const dir = join(project, '.agents');
    // The project root sits inside `home`, so the approved `../worktrees/{repo}/{task}` resolves
    // beside it there.
    const folder = join(home, 'worktrees', 'acme', 'select-width');
    updateState(dir, (state) => {
      const work = state.sessions.acme?.worktrees['select-width'];
      if (work) work.branch = '/select-width';
    });
    const io = await run(['remove', 'select-width']);
    expect(io.code).toBe(0);
    expect(io.out).toContain('removed select-width; the branch fix/select-width is kept');
    expect(existsSync(folder)).toBe(false);
    expect(readState(dir).sessions.acme?.worktrees['select-width']).toBeUndefined();
  });
});
