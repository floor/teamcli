// The binding `team add` mints is a launch's, not a run's. The install writes the seat's
// settings file and its successor binding before the plan types the line; a refusal that stops
// the seat before its line runs must leave the record the previous incarnation wrote, and the
// hook file's new binding must not be claimed by a state entry no process carries. The boundary
// is the line itself: a launch that ran — ready or not — keeps its successor, so the settings
// file the CLI loaded and the seat's state name the same incarnation.
//
// These scenes read the state the run leaves, not the writer's lines: the swallowed refusal is
// the `already running` sentence, and the seat's record is what the next run will read.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import type { Launch } from '../../src/commands/up.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { restorePresenceBinding } from '../../src/launch/cli-hook.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-03T14:02:00Z');
const IDLE = CLAUDE_IDLE;
const owner = { kind: 'owner' } as const;

let base: string;
let project: string;
let home: string;

// A shared seat starting in the project root: the plain launch path.
const FILE = `format: 1
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

// A file whose worker works in worktrees: a seat a previous run left ready in its workspace.
const WORKTREE_FILE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
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
    mode: shared
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: zsh ../tools/x.sh
    stopped: true
`;

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

/** The file is written and approved over — the trust lines are the test's own. */
function approve(text: string = FILE): void {
  const trustPath = project.startsWith(home) ? project.replace(home, '~') : project;
  const yaml = text.includes('trust:')
    ? text
    : text.replace('coordinator: lead\n', `coordinator: lead\ntrust:\n  - ~/.config/team/lobby\n  - ${trustPath}\n  - ${join(home, 'worktrees')}\n`);
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

/** The host's pane world: a create makes `w{n}:p1` showing the idle prompt, and `paneRun`
 *  marks it as the seat's. No process is ever spawned and nothing is typed into a real pane. */
function world(): { launch: Launch; creates: string[]; renames: string[]; session: 'absent' | 'running' } {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  let clock = NOW.getTime();
  const made = { launch: {} as Launch, creates: [] as string[], renames: [] as string[], session: 'absent' as 'absent' | 'running' };
  made.launch = {
    sessionState: () => made.session,
    startServer() {
      made.session = 'running';
      return true;
    },
    sessionUp: () => made.session === 'running',
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

function sources(made: ReturnType<typeof world>, extra: Partial<AddSources> = {}): AddSources {
  return {
    home,
    sessionState: () => made.session,
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(),
    now: () => NOW,
    launch: made.launch,
    ...extra,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-add-binding-')));
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
  git(project, 'branch', 'fix/fresh');
  approve();
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('a refusal before the launch line ran', () => {
  test('the seat keeps the binding its previous process was started with', async () => {
    // A seat left ready, and a pane that first reads as its shell (the plan decides to repair)
    // then as the process the record names (the repair finds the seat's again): the run refuses
    // after the install, and the successor it minted never reached a process.
    approve(WORKTREE_FILE);
    const PRIOR = 'prs_aaaaaaaaaaaa';
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.worker = {
        stage: 'ready',
        workspace: 'w9',
        pane: 'w9:p1',
        launched: { shell: 400, cli: [401] },
        presence_binding: PRIOR,
      };
      state.sessions.acme = session;
    });
    const before = readState(join(project, '.agents'));
    const made = world();
    let reads = 0;
    made.launch.processInfo = () => {
      reads += 1;
      return reads === 1 ? { shell: 400, foreground: [400] } : { shell: 400, foreground: [400, 401] };
    };
    made.launch.paneText = () => IDLE;
    const listed: HerdrAgent = { name: 'worker', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null };
    made.launch.agents = () => [listed];
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [listed],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code).toBe(1);
    expect(io.err).toContain('team add: worker is already running\n');
    expect(made.creates).toEqual([]);
    const after = readState(join(project, '.agents')).sessions.acme;
    // The rotation is undone: the record is the one the previous incarnation was started with.
    expect(after?.seats.worker).toEqual(before.sessions.acme?.seats.worker);
    expect(after?.seats.worker?.presence_binding).toBe(PRIOR);
    // The install did write its settings file, naming the successor it minted. It is on disk,
    // but no process loaded it — and the seat's record does not claim it.
    const settings = readFileSync(join(project, '.agents', 'hooks', 'acme', 'worker.json'), 'utf8');
    const minted = /--binding (prs_[0-9a-f]{12}) --event turn-start/.exec(settings)?.[1];
    expect(minted).toBeDefined();
    expect(minted).not.toBe(PRIOR);
    expect(after?.seats.worker?.presence_binding).not.toBe(minted);
  });

  test('an install that wrote the only entry takes that entry back out', async () => {
    // A fresh seat, no state at all: the install creates `{stage:'launched', presence_binding}`.
    // The machine refuses the workspace create before the run records anything beside it, so the
    // entry the install made is the whole entry, and the refusal leaves no seat behind.
    const made = world();
    const hooksPath = join(project, '.agents', 'hooks', 'acme', 'worker.json');
    let installedAtRead = false;
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      machine: () => {
        installedAtRead = existsSync(hooksPath);
        return installedAtRead ? { ...fine, loadPerCore: 500 } : fine;
      },
    }));
    expect(code).toBe(1);
    expect(installedAtRead).toBe(true);
    expect(io.out + io.err).toContain('per core, above');
    expect(made.creates).toEqual([]);
    expect(readState(join(project, '.agents')).sessions.acme?.seats.worker).toBeUndefined();
    // The install's file stays: it is a file fact, and the next install replaces it.
    expect(existsSync(hooksPath)).toBe(true);
  });
});

describe('a launch whose line ran', () => {
  test('a ready seat keeps the successor its hook file names', async () => {
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['worker'], io, sources(made))).toBe(0);
    const seat = readState(join(project, '.agents')).sessions.acme?.seats.worker;
    expect(seat?.stage).toBe('ready');
    const binding = seat?.presence_binding;
    expect(binding).toMatch(/^prs_[0-9a-f]{12}$/);
    const settings = readFileSync(join(project, '.agents', 'hooks', 'acme', 'worker.json'), 'utf8');
    expect(settings).toContain(`--binding ${binding} --event turn-start`);
    expect(settings).toContain(`--binding ${binding} --event turn-end`);
  });

  test('a launch that ran and timed out keeps it too', async () => {
    // The line ran, so the CLI loaded the settings file naming this incarnation. The wait after
    // it times out; that is not a reason to rotate the binding back under a process holding it.
    const made = world();
    made.launch.paneText = () => 'esc to interrupt';
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made));
    expect(code).toBe(1);
    expect(made.creates).toEqual(['worker']);
    const seat = readState(join(project, '.agents')).sessions.acme?.seats.worker;
    const binding = seat?.presence_binding;
    expect(binding).toMatch(/^prs_[0-9a-f]{12}$/);
    const settings = readFileSync(join(project, '.agents', 'hooks', 'acme', 'worker.json'), 'utf8');
    expect(settings).toContain(`--binding ${binding} --event turn-start`);
  });
});

describe('restorePresenceBinding, on the state it is handed', () => {
  function seedSeat(seat: Record<string, unknown>): void {
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.worker = seat as never;
      state.sessions.acme = session;
    });
  }

  test('exactly the install entry is removed', () => {
    seedSeat({ stage: 'launched', presence_binding: 'prs_bbbbbbbbbbbb' });
    restorePresenceBinding(join(project, '.agents'), 'acme', 'worker', undefined);
    expect(readState(join(project, '.agents')).sessions.acme?.seats.worker).toBeUndefined();
  });

  test('a record the run wrote beside it keeps everything but the binding', () => {
    seedSeat({ stage: 'launched', pane: 'w9:p1', presence_binding: 'prs_bbbbbbbbbbbb' });
    restorePresenceBinding(join(project, '.agents'), 'acme', 'worker', undefined);
    expect(readState(join(project, '.agents')).sessions.acme?.seats.worker).toEqual({ stage: 'launched', pane: 'w9:p1' });
  });

  test('a prior binding goes back and the rest of the record is untouched', () => {
    seedSeat({ stage: 'ready', pane: 'w9:p1', presence_binding: 'prs_bbbbbbbbbbbb' });
    restorePresenceBinding(join(project, '.agents'), 'acme', 'worker', 'prs_cccccccccccc');
    expect(readState(join(project, '.agents')).sessions.acme?.seats.worker).toEqual({
      stage: 'ready',
      pane: 'w9:p1',
      presence_binding: 'prs_cccccccccccc',
    });
  });

  test('a binding that is already the prior one is left untouched', () => {
    seedSeat({ stage: 'ready', pane: 'w9:p1', presence_binding: 'prs_cccccccccccc' });
    const file = join(project, '.agents', 'team.state.json');
    const before = readFileSync(file, 'utf8');
    restorePresenceBinding(join(project, '.agents'), 'acme', 'worker', 'prs_cccccccccccc');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('state that cannot be read is left as it is', () => {
    const file = join(project, '.agents', 'team.state.json');
    writeFileSync(file, '{not json');
    expect(() => restorePresenceBinding(join(project, '.agents'), 'acme', 'worker', undefined)).not.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{not json');
  });
});
