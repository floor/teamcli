import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { compare, fingerprints } from '../../src/approve/fingerprint.ts';
import { runWorktree, type WorktreeSources } from '../../src/commands/worktree.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { WORKTREE_OUTPUT_SCHEMA } from '../../src/output/schema.ts';
import { readState, updateState, emptySession } from '../../src/state.ts';
import { approvalStanding, storePath, writeApproval } from '../../src/store/store.ts';
import { gitEnv, testIo, type TestIo } from '../helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from '../helpers/output.ts';
import { writeTextSignedApproval } from '../helpers/text-signed-approval.ts';

let base: string;
let project: string;
let home: string;
let sources: WorktreeSources;

const owner = { kind: 'owner' } as const;
const lead = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' } as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function teamText(patch?: { setup?: string; limit?: number; mode?: string }): string {
  const mode = patch?.mode ?? 'worktree';
  const setup = patch?.setup ?? '';
  const workspace = mode === 'shared'
    ? 'workspace:\n  mode: shared\n'
    : `workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  limit: ${patch?.limit ?? 8}
${setup}`;
  return `format: 1
project: acme
visibility: public
coordinator: lead
operator: lead
identity:
  forbidden_public:
    - "\\\\bWEB-[0-9]+\\\\b"
trust:
  - ../worktrees/acme/*
${workspace}seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

function approve(text: string): void {
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

async function run(argv: string[], caller: TestIo['caller'] = owner): Promise<TestIo & { code: number }> {
  const io = testIo(project, caller) as TestIo & { code: number };
  io.code = await runWorktree(argv, io, sources);
  return io;
}

// The state `team up` writes for a seat: the caller gate judges a seat on the pane the state
// records for it, so a seat caller needs this record to stand as one. Without it the gate fails
// closed — that refusal has its own tests in coordinator-session.
function recordSeat(name: string, pane: string): void {
  updateState(join(project, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats[name] = { stage: 'ready', pane };
  });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-worktree-')));
  project = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(project);
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
  sources = { home, now: () => new Date('2026-10-03T12:00:00Z') };
  approve(teamText());
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('team worktree new', () => {
  test('creates the folder and the branch from the fetched base, and prints the path', async () => {
    const io = await run(['new', 'select-width', '--kind', 'fix', '--seat', 'lead']);
    expect(io.code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nworktree select-width: created at ../worktrees/acme/select-width\n');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width', 'README.md'))).toBe(true);
    expect(git(project, 'rev-parse', '--verify', 'refs/heads/fix/select-width').trim()).toBe(git(project, 'rev-parse', 'origin/main').trim());
    const state = readState(join(project, '.agents'));
    expect(state.sessions.acme?.worktrees['select-width']).toEqual({
      path: '../worktrees/acme/select-width',
      branch: 'fix/select-width',
      own_commits: false,
      seat: 'lead',
      setup: 'ok',
    });
    expect(readFileSync(join(project, '.agents', 'team.log'), 'utf8')).toContain('worktree new [owner] created select-width');
  });

  test('--json carries the action envelope under the registered schema', async () => {
    const io = await run(['new', 'select-width', '--kind', 'fix', '--json']);
    expect(io.code).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<Record<string, unknown>>(io.out, WORKTREE_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({
      schema: { name: 'team.worktree', version: 1 },
      format: 1,
      dry_run: false,
      status: 'created',
      action_summary: 'worktree select-width: created at ../worktrees/acme/select-width',
      project: 'acme',
      session: 'acme',
      action: 'new',
      task: 'select-width',
      branch: 'fix/select-width',
      path: '../worktrees/acme/select-width',
    });
    const removed = await run(['remove', 'select-width', '--json']);
    expect(removed.code).toBe(0);
    expect(removed.err).toBe('');
    const after = assertMatchesOutputSchema<Record<string, unknown>>(removed.out, WORKTREE_OUTPUT_SCHEMA);
    expect(after).toMatchObject({
      status: 'removed',
      action_summary: 'removed select-width; the branch fix/select-width is kept',
      action: 'remove',
      task: 'select-width',
      branch: 'fix/select-width',
    });
  });

  test('--json: a refusal is the team.error document on stdout, stderr empty', async () => {
    approve(teamText({ mode: 'shared' }));
    const io = await run(['new', 'select-width', '--kind', 'fix', '--json']);
    expect(io.code).toBe(1);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, { id: 'worktree.shared', messageContains: 'workspace.mode is shared' });
  });

  test('--json is read before the parser: a bad option, or --json=<value>, still writes the error document', async () => {
    for (const [argv, messageContains] of [
      [['--nope', '--json'], 'unknown option --nope'],
      [['--json=1'], 'unknown option --json'],
    ] as const) {
      const io = await run([...argv]);
      expect(io.code).toBe(2);
      expect(io.err).toBe('');
      assertJsonErrorShape(io.out, { id: 'worktree.invocation', messageContains, repair: null });
    }
  });

  test('--json: a setup failure is the worktree.setup error document, and it writes nothing on stderr', async () => {
    approve(teamText({ setup: '  setup:\n    - "false"\n' }));
    const io = await run(['new', 'select-width', '--kind', 'fix', '--json']);
    expect(io.code).toBe(1);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, { id: 'worktree.setup', messageContains: 'setup failed on command 1 of 1' });
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(true);
  });

  test('a coordinator seat may create one; another seat may not', async () => {
    recordSeat('lead', 'w1:p1');
    expect((await run(['new', 'select-width', '--kind', 'fix'], lead)).code).toBe(0);
    const other = await run(['new', 'other-task', '--kind', 'fix'], { kind: 'seat', name: 'stranger', pane: 'w2:p1' });
    expect(other.code).toBe(1);
    expect(other.err).toContain('only the owner, the orchestrator or the operator');
  });

  test('--file is refused from a seat', async () => {
    const io = await run(['new', 'select-width', '--kind', 'fix', '--file', join(project, '.agents', 'team.yaml')], lead);
    expect(io.code).toBe(1);
    expect(io.err).toContain('--file is the owner');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(false);
  });

  test('a team with no stored approval runs: the live file is the record', async () => {
    rmSync(home, { recursive: true, force: true });
    const missing = await run(['new', 'select-width', '--kind', 'fix']);
    expect(missing.code).toBe(0);
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(true);
  });

  test('a stored approval that cannot be verified still refuses, with its own line', async () => {
    approve(teamText());
    sources = { ...sources, standing: () => ({ kind: 'refused', why: 'the record cannot be verified' }) };
    const refused = await run(['new', 'select-width', '--kind', 'fix']);
    expect(refused.code).toBe(1);
    expect(refused.err).toBe('team worktree: the record cannot be verified\n');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(false);
  });

  test('refuses shared mode, a public forbidden name, an unknown seat, a taken branch and the limit', async () => {
    approve(teamText({ mode: 'shared' }));
    const shared = await run(['new', 'select-width', '--kind', 'fix']);
    expect(shared.err).toContain('workspace.mode is shared');

    approve(teamText());
    const named = await run(['new', 'WEB-12', '--kind', 'fix']);
    expect(named.code).toBe(1);
    expect(named.err).toContain('forbidden_public');

    const seat = await run(['new', 'select-width', '--kind', 'fix', '--seat', 'nobody']);
    expect(seat.err).toContain('names no declared seat');

    expect((await run(['new', 'select-width', '--kind', 'fix'])).code).toBe(0);
    const again = await run(['new', 'select-width', '--kind', 'fix']);
    expect(again.err).toContain('already recorded');
    git(project, 'branch', 'fix/taken', 'main');
    const taken = await run(['new', 'taken', '--kind', 'fix']);
    expect(taken.code).toBe(1);
    expect(taken.err).toContain('branch fix/taken already exists');

    approve(teamText({ limit: 1 }));
    const limited = await run(['new', 'other-task', '--kind', 'fix']);
    expect(limited.code).toBe(1);
    expect(limited.err).toContain('worktree limit is 1');
    expect(existsSync(join(base, 'worktrees', 'acme', 'other-task'))).toBe(false);
  });

  test('a failed fetch creates nothing', async () => {
    git(project, 'remote', 'set-url', 'origin', join(base, 'missing.git'));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(1);
    expect(io.err).toContain('Nothing was created');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(false);
    expect(readState(join(project, '.agents')).sessions.acme).toBeUndefined();
  });

  test('a base with no upstream starts from the local branch', async () => {
    git(project, 'branch', '--unset-upstream');
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(readFileSync(join(project, '.agents', 'team.log'), 'utf8')).toContain('no upstream');
  });

  test('a setup failure is kept and recorded, and later commands do not run', async () => {
    approve(teamText({ setup: '  setup:\n    - "false"\n    - "touch no-second"\n' }));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(1);
    expect(io.out).toBe('team acme, session "acme"\nworktree select-width: created at ../worktrees/acme/select-width\n');
    expect(io.err).toContain('setup: failed');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(true);
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width', 'no-second'))).toBe(false);
    expect(readState(join(project, '.agents')).sessions.acme?.worktrees['select-width']?.setup).toBe('failed');
  });

  test('a symlink that would land outside trust is refused before the folder exists', async () => {
    const escaped = join(base, 'escaped');
    mkdirSync(escaped);
    symlinkSync(escaped, join(base, 'worktrees'));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(1);
    expect(io.err).toContain('symlink');
    expect(existsSync(join(escaped, 'acme'))).toBe(false);
  });
});

describe('team worktree remove', () => {
  test('removes the folder and the record, and keeps the branch', async () => {
    expect((await run(['new', 'select-width', '--kind', 'fix'])).code).toBe(0);
    const io = await run(['remove', 'select-width']);
    expect(io.code).toBe(0);
    expect(io.out).toContain('the branch fix/select-width is kept');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(false);
    expect(git(project, 'rev-parse', '--verify', '--quiet', 'refs/heads/fix/select-width').trim()).not.toBe('');
    expect(readState(join(project, '.agents')).sessions.acme?.worktrees['select-width']).toBeUndefined();
  });

  test('refuses uncommitted changes, untracked files and commits on no remote, and lists them', async () => {
    expect((await run(['new', 'select-width', '--kind', 'fix'])).code).toBe(0);
    const folder = join(base, 'worktrees', 'acme', 'select-width');
    writeFileSync(join(folder, 'README.md'), 'changed\n');
    const dirty = await run(['remove', 'select-width']);
    expect(dirty.code).toBe(1);
    expect(dirty.err).toContain('README.md');
    expect(existsSync(folder)).toBe(true);

    git(folder, 'checkout', '-q', '--', 'README.md');
    writeFileSync(join(folder, 'notes.txt'), 'local\n');
    const untracked = await run(['remove', 'select-width']);
    expect(untracked.code).toBe(1);
    expect(untracked.err).toContain('notes.txt');

    rmSync(join(folder, 'notes.txt'));
    writeFileSync(join(folder, 'README.md'), 'committed\n');
    git(folder, 'add', 'README.md');
    git(folder, 'commit', '-q', '-m', 'local only');
    const unpushed = await run(['remove', 'select-width']);
    expect(unpushed.code).toBe(1);
    expect(unpushed.err).toContain('local only');
    expect(git(project, 'rev-parse', '--verify', '--quiet', 'refs/heads/fix/select-width').trim()).not.toBe('');

    git(project, 'push', '-q', 'origin', 'fix/select-width');
    const pushed = await run(['remove', 'select-width']);
    expect(pushed.code).toBe(0);
    expect(git(project, 'rev-parse', '--verify', '--quiet', 'refs/heads/fix/select-width').trim()).not.toBe('');
    expect(git(project, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/fix/select-width').trim()).not.toBe('');
  });

  test('refuses a commit on a detached HEAD, and one on another branch checked out there', async () => {
    expect((await run(['new', 'select-width', '--kind', 'fix'])).code).toBe(0);
    const folder = join(base, 'worktrees', 'acme', 'select-width');
    git(folder, 'checkout', '-q', '--detach');
    writeFileSync(join(folder, 'README.md'), 'detached\n');
    git(folder, 'add', 'README.md');
    git(folder, 'commit', '-q', '-m', 'only on a detached HEAD');
    const detached = await run(['remove', 'select-width']);
    expect(detached.code).toBe(1);
    expect(detached.err).toContain('only on a detached HEAD');
    expect(existsSync(folder)).toBe(true);

    git(folder, 'checkout', '-q', 'fix/select-width');
    git(folder, 'checkout', '-q', '-b', 'fix/side');
    writeFileSync(join(folder, 'README.md'), 'side\n');
    git(folder, 'add', 'README.md');
    git(folder, 'commit', '-q', '-m', 'only on the side branch');
    const side = await run(['remove', 'select-width']);
    expect(side.code).toBe(1);
    expect(side.err).toContain('only on the side branch');
    expect(existsSync(folder)).toBe(true);
    expect(git(project, 'rev-parse', '--verify', '--quiet', 'refs/heads/fix/select-width').trim()).not.toBe('');
  });

  test('refuses while a temporary seat is recorded in the task', async () => {
    expect((await run(['new', 'select-width', '--kind', 'fix'])).code).toBe(0);
    const dir = join(project, '.agents');
    const state = readState(dir);
    const session = state.sessions.acme;
    if (!session) throw new Error('no session');
    session.seats['lead-tmp-1'] = { stage: 'ready', temporary: { like: 'lead', until: 'merged:fix/select-width', task: 'select-width' } };
    writeFileSync(join(dir, 'team.state.json'), `${JSON.stringify(state, null, 2)}\n`);
    const io = await run(['remove', 'select-width']);
    expect(io.code).toBe(1);
    expect(io.err).toContain('lead-tmp-1');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(true);
  });

  test('a folder that is already gone drops the record and deletes no branch', async () => {
    expect((await run(['new', 'select-width', '--kind', 'fix'])).code).toBe(0);
    rmSync(join(base, 'worktrees', 'acme', 'select-width'), { recursive: true, force: true });
    const io = await run(['remove', 'select-width']);
    expect(io.code).toBe(0);
    expect(io.out).toContain('already gone');
    expect(git(project, 'rev-parse', '--verify', '--quiet', 'refs/heads/fix/select-width').trim()).not.toBe('');
    expect(readState(join(project, '.agents')).sessions.acme?.worktrees['select-width']).toBeUndefined();
  });

  test('refuses a recorded path that does not match the approved pattern, and reads the branch from git, not the record', async () => {
    expect((await run(['new', 'select-width', '--kind', 'fix'])).code).toBe(0);
    expect((await run(['new', 'other-task', '--kind', 'fix'])).code).toBe(0);
    git(project, 'push', '-q', 'origin', 'fix/select-width');
    git(project, 'push', '-q', 'origin', 'fix/other-task');
    const dir = join(project, '.agents');
    const otherFolder = join(base, 'worktrees', 'acme', 'other-task');

    updateState(dir, (state) => {
      const work = state.sessions.acme?.worktrees['select-width'];
      if (work) work.path = '../worktrees/acme/other-task';
    });
    const wrongPath = await run(['remove', 'select-width']);
    expect(wrongPath.code).toBe(1);
    expect(wrongPath.err).toContain('the recorded path "../worktrees/acme/other-task" is not "../worktrees/acme/select-width"');
    expect(existsSync(otherFolder)).toBe(true);

    updateState(dir, (state) => {
      const work = state.sessions.acme?.worktrees['select-width'];
      if (work) {
        work.path = '../worktrees/acme/select-width';
        work.branch = 'main';
      }
    });
    const staleBranch = await run(['remove', 'select-width']);
    expect(staleBranch.code).toBe(0);
    expect(staleBranch.out).toContain('removed select-width; the branch fix/select-width is kept');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(false);
  });
});

describe('team worktree and the live file', () => {
  // The live file is the record these subcommands act on: an edit to it draws no note, and
  // an empty stderr is the reading every test below holds to.
  const noNote = '';

  function edit(text: string): void {
    writeFileSync(join(project, '.agents', 'team.yaml'), text);
  }

  function recordPath(): string {
    const loaded = loadTeamFile(project);
    if (!loaded.ok) throw new Error('the team file must load');
    return join(storePath(loaded.team.project, loaded.root, home), 'approval.json');
  }

  test('a rules-only edit draws no note and both subcommands use the live settings', async () => {
    expect((await run(['new', 'select-width', '--kind', 'fix'])).code).toBe(0);
    edit(`${teamText()}rules:\n  - "read the brief first"\n`);
    const created = await run(['new', 'tidy-logs', '--kind', 'chore']);
    expect(created.code).toBe(0);
    expect(created.err).toBe(noNote);
    expect(created.out).toBe('team acme, session "acme"\nworktree tidy-logs: created at ../worktrees/acme/tidy-logs\n');
    const removed = await run(['remove', 'select-width']);
    expect(removed.code).toBe(0);
    expect(removed.err).toBe(noNote);
    expect(removed.out).toBe('team acme, session "acme"\nremoved select-width; the branch fix/select-width is kept\n');
  });

  test('the live workspace.path supplies the landing', async () => {
    // The file's own path, one folder deeper under the same trust, so the file still validates.
    edit(teamText().replace('../worktrees/{repo}/{task}', '../worktrees/{repo}/file/{task}'));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    expect(io.out).toBe('team acme, session "acme"\nworktree select-width: created at ../worktrees/acme/file/select-width\n');
    expect(existsSync(join(base, 'worktrees', 'acme', 'file', 'select-width', 'README.md'))).toBe(true);
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(false);
  });

  test('the live workspace.setup commands run', async () => {
    const folder = join(base, 'worktrees', 'acme', 'select-width');
    const ran: { cwd: string; command: string }[] = [];
    sources.setup = (cwd, command) => {
      ran.push({ cwd, command });
      return 0;
    };
    approve(teamText({ setup: '  setup:\n    - "touch from-approved"\n' }));
    edit(teamText({ setup: '  setup:\n    - "touch from-file"\n' }));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    expect(ran).toEqual([{ cwd: folder, command: 'touch from-file' }]);
  });

  test('a widened live trust permits the landing', async () => {
    // The approved copy trusts only the task called "task" — the sample the validator checks — so
    // its own landing is outside it; the file's wider trust would have allowed the landing.
    approve(teamText().replace('  - ../worktrees/acme/*\n', '  - ../worktrees/acme/task\n'));
    edit(teamText());
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(true);
  });

  test('a narrowed live trust refuses the landing', async () => {
    approve(teamText());
    edit(teamText().replace('  - ../worktrees/acme/*\n', '  - ../worktrees/acme/task\n'));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(1);
    expect(io.err).toBe(`${noNote}team worktree: ../worktrees/acme/select-width is outside the file's trust paths\n`);
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(false);
  });

  test('a live workspace.protected edit leaves creation inside the task workspace', async () => {
    approve(teamText());
    edit(teamText().replace('  base: main\n', '  base: main\n  protected:\n    - .\n    - ../worktrees\n'));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(true);
  });

  test('--seat uses additions and edits from the live roster', async () => {
    approve(teamText());
    edit(teamText()
      .replace('    model: Claude Opus\n', '    model: Claude Sonnet\n')
      .replace('\nseats:\n', '\nseats:\n  - role: implementer\n    name: ghost\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n'));
    const added = await run(['new', 'select-width', '--kind', 'fix', '--seat', 'ghost']);
    expect(added.code).toBe(0);
    expect(added.err).toBe(noNote);
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(true);
    const kept = await run(['new', 'second-task', '--kind', 'fix', '--seat', 'lead']);
    expect(kept.code).toBe(0);
    expect(kept.err).toBe(noNote);
    // The worktree state records the seat's name only, and that name is the approved one.
    expect(readState(join(project, '.agents')).sessions.acme?.worktrees['second-task']?.seat).toBe('lead');
  });

  test('a file the record holds prints no note and both outputs are main\'s own', async () => {
    const created = await run(['new', 'select-width', '--kind', 'fix']);
    expect(created.code).toBe(0);
    expect(created.err).toBe('');
    expect(created.out).toBe('team acme, session "acme"\nworktree select-width: created at ../worktrees/acme/select-width\n');
    const removed = await run(['remove', 'select-width']);
    expect(removed.code).toBe(0);
    expect(removed.err).toBe('');
    expect(removed.out).toBe('team acme, session "acme"\nremoved select-width; the branch fix/select-width is kept\n');
  });

  test('a record that does not verify refuses with the signature line, unchanged', async () => {
    const path = recordPath();
    const record = JSON.parse(readFileSync(path, 'utf8')) as { approvedAt: string };
    record.approvedAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(1);
    expect(io.err).toBe('team worktree: the record does not carry a valid signature: it was changed after approval, or written without the key\n');
  });

  test('a legacy record refuses with the one-line repair, unchanged', async () => {
    const path = recordPath();
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    record.format = 1;
    delete record.generation;
    delete record.signature;
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(1);
    expect(io.err).toBe('team worktree: approved before records were signed\n');
  });

  test('an unreadable stored copy does not block a valid live file', async () => {
    // A record whose copy this version cannot read, as a stricter validator tomorrow would leave
    // it: the standing is handed in whole, so the signature is the one that verified.
    edit(teamText({ limit: 4 }));
    const loaded = loadTeamFile(project);
    if (!loaded.ok) throw new Error('the team file must load');
    const real = approvalStanding(loaded.root, home);
    if (real.kind !== 'verified') throw new Error(real.kind);
    const io = testIo(project, owner) as TestIo & { code: number };
    io.code = await runWorktree(['new', 'select-width', '--kind', 'fix'], io, {
      home,
      now: sources.now,
      standing: () => ({ ...real, record: { ...real.record, file: 'nope: [[[' } }),
    });
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(true);
  });

  test('the caller gate accepts a live promotion on its recorded pane', async () => {
    approve(teamText());
    edit(teamText()
      .replace('coordinator: lead\n', 'coordinator: stranger\n')
      .replace('\nseats:\n', '\nseats:\n  - role: coordinator\n    name: stranger\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n'));
    recordSeat('stranger', 'w2:p1');
    const promoted = await run(['new', 'select-width', '--kind', 'fix'], { kind: 'seat', name: 'stranger', pane: 'w2:p1', session: 'acme' });
    expect(promoted.code).toBe(0);
    expect(promoted.err).toBe(noNote);
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(true);

  });

  test('the live workspace.branch names the new branch', async () => {
    edit(teamText().replace('branch: "{kind}/{task}"', 'branch: "file/{task}"'));
    const io = await run(['new', 'branch-case']);
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    expect(readState(join(project, '.agents')).sessions.acme?.worktrees['branch-case']?.branch).toBe('file/branch-case');
    expect(() => git(project, 'rev-parse', '--verify', '--quiet', 'refs/heads/fix/branch-case')).toThrow();
  });

  test('the live workspace.base supplies the worktree contents', async () => {
    git(project, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(project, 'README.md'), 'other\n');
    git(project, 'add', 'README.md');
    git(project, 'commit', '-q', '-m', 'other');
    git(project, 'checkout', '-q', 'main');
    edit(teamText().replace('base: main\n', 'base: other\n'));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    expect(readFileSync(join(base, 'worktrees', 'acme', 'select-width', 'README.md'), 'utf8')).toBe('other\n');
  });

  test('a live workspace.mode shared refuses a task worktree', async () => {
    edit(teamText({ mode: 'shared' }));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(1);
    expect(io.err).toBe(`${noNote}team worktree: workspace.mode is shared: this team keeps one checkout, so there is no task worktree to create\n`);
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width', 'README.md'))).toBe(false);
  });

  test('a widened live workspace.limit permits another worktree', async () => {
    approve(teamText({ limit: 1 }));
    expect((await run(['new', 'select-width', '--kind', 'fix'])).code).toBe(0);
    edit(teamText({ limit: 8 }));
    const io = await run(['new', 'other-task', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    expect(existsSync(join(base, 'worktrees', 'acme', 'other-task'))).toBe(true);
  });

  function staffText(): string {
    return teamText()
      .replace('operator: lead\n', 'operator: clerk\n')
      .replace(
        '    launch: claude --model claude-opus-5-5\n',
        '    launch: claude --model claude-opus-5-5\n  - role: operator\n    name: clerk\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n',
      );
  }

  test('an operator promoted in the live file may create from its recorded pane', async () => {
    const staff = staffText();
    const stranger = '  - role: operator\n    name: stranger\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n';
    approve(staff);
    edit(`${staff.replace('operator: clerk\n', 'operator: stranger\n')}${stranger}`);
    recordSeat('stranger', 'w2:p1');
    const io = await run(['new', 'select-width', '--kind', 'fix'], { kind: 'seat', name: 'stranger', pane: 'w2:p1', session: 'acme' });
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(true);
  });

  test('the live file revokes a demoted operator', async () => {
    const staff = staffText();
    approve(staff);
    edit(staff.replace('operator: clerk\n', 'operator: lead\n'));
    recordSeat('clerk', 'w3:p1');
    const io = await run(['new', 'select-width', '--kind', 'fix'], { kind: 'seat', name: 'clerk', pane: 'w3:p1', session: 'acme' });
    expect(io.code).toBe(1);
    expect(io.err).toBe('team worktree: only the owner, the orchestrator or the operator runs it; this call is clerk\n');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width', 'README.md'))).toBe(false);
  });

  test('the live file revokes a demoted orchestrator who is not the operator', async () => {
    const staff = teamText()
      .replace('operator: lead\n', 'operator: clerk\n')
      .replace(
        '    launch: claude --model claude-opus-5-5\n',
        '    launch: claude --model claude-opus-5-5\n  - role: operator\n    name: clerk\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n',
      );
    approve(staff);
    edit(staff.replace('coordinator: lead\n', 'coordinator: clerk\n'));
    recordSeat('lead', 'w1:p1');
    const io = await run(['new', 'select-width', '--kind', 'fix'], lead);
    expect(io.code).toBe(1);
    expect(io.err).toBe('team worktree: only the owner, the orchestrator or the operator runs it; this call is lead\n');
  });

  test('the live session name selects the state record', async () => {
    edit(teamText().replace('project: acme\n', 'project: acme\nsession: other\n'));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    const state = readState(join(project, '.agents'));
    expect(state.sessions.other?.worktrees['select-width']?.path).toBe('../worktrees/acme/select-width');
    expect(state.sessions.acme).toBeUndefined();
  });

  test('an emptied live forbidden_public list permits the name', async () => {
    const approved = teamText();
    const live = approved.replace('identity:\n  forbidden_public:\n    - "\\\\bWEB-[0-9]+\\\\b"\n', '');
    expect(live).not.toBe(approved);
    expect(live).not.toContain('forbidden_public');
    edit(live);
    const io = await run(['new', 'WEB-12', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    expect(existsSync(join(base, 'worktrees', 'acme', 'WEB-12'))).toBe(true);
  });

  test('live private visibility permits a name forbidden only in public projects', async () => {
    // The reviewer's mutant passed the live `visibility` to the forbidden-name check; the
    // private live file would then allow a name the approved public file forbids.
    const approved = teamText();
    const live = approved.replace('visibility: public\n', 'visibility: private\n');
    expect(live).not.toBe(approved);
    expect(live).not.toContain('visibility: public');
    edit(live);
    const io = await run(['new', 'WEB-12', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    expect(existsSync(join(base, 'worktrees', 'acme', 'WEB-12'))).toBe(true);
  });

  test('a removed live seat cannot be assigned a worktree', async () => {
    // `limits.seats` defaults to the roster, so an unpinned limit would itself be a difference and
    // the one-way comparison would not be quiet. Both files pin it: the removed seat is the only change.
    const limits = 'limits:\n  seats: 4\n  temporary: 2\n';
    const pinned = teamText().replace('trust:\n', `${limits}trust:\n`);
    const withScribe = pinned.replace(
      '    launch: claude --model claude-opus-5-5\n',
      '    launch: claude --model claude-opus-5-5\n  - role: implementer\n    name: scribe\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n',
    );
    const approved = validateTeamFile(withScribe);
    const live = validateTeamFile(pinned);
    if (!approved.ok || !live.ok) throw new Error('both files must load');
    expect(compare(fingerprints(approved.team), fingerprints(live.team))).toEqual([]);
    approve(withScribe);
    edit(pinned);
    const io = await run(['new', 'select-width', '--kind', 'fix', '--seat', 'scribe']);
    expect(io.code).toBe(1);
    expect(io.err).toBe('team worktree: --seat "scribe" names no declared seat\n');
    expect(readState(join(project, '.agents')).sessions.acme?.worktrees['select-width']).toBeUndefined();
  });

  test('a renamed live seat no longer accepts its old name', async () => {
    edit(teamText().replaceAll('lead', 'chief'));
    const io = await run(['new', 'select-width', '--kind', 'fix', '--seat', 'lead']);
    expect(io.code).toBe(1);
    expect(io.err).toBe(`${noNote}team worktree: --seat "lead" names no declared seat\n`);
    expect(readState(join(project, '.agents')).sessions.acme?.worktrees['select-width']).toBeUndefined();
  });

  test('a redefined live seat keeps its declared name', async () => {
    edit(teamText().replace('model: Claude Opus\n', 'model: Claude Sonnet\n'));
    const io = await run(['new', 'select-width', '--kind', 'fix', '--seat', 'lead']);
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    expect(readState(join(project, '.agents')).sessions.acme?.worktrees['select-width']?.seat).toBe('lead');
  });

  test('a replaced live file supplies the path, branch and setup', async () => {
    const ran: string[] = [];
    sources.setup = (_cwd, command) => {
      ran.push(command);
      return 0;
    };
    approve(teamText({ setup: '  setup:\n    - "echo approved"\n' }));
    edit(`format: 1
project: acme
visibility: private
coordinator: lead
operator: lead
trust:
  - ../worktrees/acme/*
workspace:
  mode: worktree
  path: ../worktrees/{repo}/live/{task}
  branch: "live/{task}"
  base: main
  setup:
    - "echo from-file"
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
    const io = await run(['new', 'select-width']);
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    expect(io.out).toBe('team acme, session "acme"\nworktree select-width: created at ../worktrees/acme/live/select-width\n');
    expect(ran).toEqual(['echo from-file']);
    expect(readState(join(project, '.agents')).sessions.acme?.worktrees['select-width']?.branch).toBe('live/select-width');
    expect(existsSync(join(base, 'worktrees', 'acme', 'live'))).toBe(true);
  });

  test('a stored copy that is an older format does not block the live file', async () => {
    const loaded = loadTeamFile(project);
    if (!loaded.ok) throw new Error('the team file must load');
    writeTextSignedApproval(
      storePath(loaded.team.project, loaded.root, home),
      { approval: approvalOf(loaded.team, loaded.root), file: 'format: 0\n' },
      loaded.team.seats,
      home,
    );
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(io.err).toBe('');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(true);
  });

  test('a stored copy that is empty does not block the live file', async () => {
    const loaded = loadTeamFile(project);
    if (!loaded.ok) throw new Error('the team file must load');
    writeTextSignedApproval(
      storePath(loaded.team.project, loaded.root, home),
      { approval: approvalOf(loaded.team, loaded.root), file: '' },
      loaded.team.seats,
      home,
    );
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(io.err).toBe('');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(true);
  });

  test('a record whose file is not a string keeps the store\'s own refusal', async () => {
    const path = recordPath();
    const record = JSON.parse(readFileSync(path, 'utf8')) as { file: unknown };
    record.file = 1;
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(1);
    expect(io.err).toContain('the approval record cannot be read');
    expect(io.err).toContain('"file" is not a string');
    expect(io.err).not.toContain("the stored copy can't be read");
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(false);
  });

  test('renaming project fills {repo} from the live file and stays inside a wide approved trust', async () => {
    // `session` is written, so it does not follow the project name: the only edit is `project`.
    const wide = teamText()
      .replace('  - ../worktrees/acme/*\n', '  - ../worktrees/*\n')
      .replace('project: acme\n', 'project: acme\nsession: acme\n');
    approve(wide);
    edit(wide.replace('project: acme\n', 'project: renamed\n'));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toBe('team renamed, session "acme"\nworktree select-width: created at ../worktrees/renamed/select-width\n');
    expect(existsSync(join(base, 'worktrees', 'renamed', 'select-width', 'README.md'))).toBe(true);
  });

  test('with the session omitted, a rename moves the session too: the state lands under the new name', async () => {
    // The file names an entity and no session, so the session is `<entity>-<project>`: renaming the
    // project renames the session, and the live file is the record, so `{repo}` and the state both
    // follow it.
    const wide = teamText()
      .replace('  - ../worktrees/acme/*\n', '  - ../worktrees/*\n')
      .replace('project: acme\n', 'project: acme\nentity: floor\n');
    approve(wide);
    edit(wide.replace('project: acme\n', 'project: renamed\n'));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    expect(io.out).toBe('team renamed, session "floor-renamed"\nworktree select-width: created at ../worktrees/renamed/select-width\n');
    const state = readState(join(project, '.agents'));
    expect(Object.keys(state.sessions)).toEqual(['floor-renamed']);
    expect(state.sessions['floor-renamed']?.worktrees['select-width']?.branch).toBe('fix/select-width');
    expect(existsSync(join(base, 'worktrees', 'renamed', 'select-width', 'README.md'))).toBe(true);
  });

  test('renaming project against a trust that names the old project makes the file invalid', async () => {
    edit(teamText().replace('project: acme\n', 'project: renamed\n'));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(2);
    expect(io.err).toContain('matches no trust pattern');
    expect(existsSync(join(base, 'worktrees', 'renamed'))).toBe(false);
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(false);
  });

  test('a project rename uses the live trust paths', async () => {
    edit(teamText()
      .replace('project: acme\n', 'project: renamed\n')
      .replace('  - ../worktrees/acme/*\n', '  - ../worktrees/*\n'));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(io.err).toBe(noNote);
    expect(existsSync(join(base, 'worktrees', 'renamed'))).toBe(true);
  });
});

describe('team worktree list', () => {
  const statePath = () => join(project, '.agents', 'team.state.json');
  const logPath = () => join(project, '.agents', 'team.log');

  test('an empty record prints the count and the limit, and writes nothing', async () => {
    expect(existsSync(statePath())).toBe(false);
    expect(existsSync(logPath())).toBe(false);
    const io = await run(['list']);
    expect(io.code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toBe(
      'team acme, session "acme"\n' +
      '  TASK  BRANCH  PATH\n' +
      'note: limit 8 (workspace.limit)\n' +
      '0 worktrees\n',
    );
    expect(existsSync(statePath())).toBe(false);
    expect(existsSync(logPath())).toBe(false);
  });

  test('a recorded worktree is one line, and a gone folder stays recorded', async () => {
    expect((await run(['new', 'select-width', '--kind', 'fix', '--seat', 'lead'])).code).toBe(0);
    const stateBefore = readFileSync(statePath(), 'utf8');
    const logBefore = readFileSync(logPath(), 'utf8');
    const listed = await run(['list']);
    expect(listed.code).toBe(0);
    expect(listed.err).toBe('');
    expect(listed.out).toBe(
      'team acme, session "acme"\n' +
      '  TASK          BRANCH            PATH\n' +
      '  select-width  fix/select-width  ../worktrees/acme/select-width\n' +
      'note: limit 8 (workspace.limit)\n' +
      '1 worktree\n',
    );
    expect(readFileSync(statePath(), 'utf8')).toBe(stateBefore);
    expect(readFileSync(logPath(), 'utf8')).toBe(logBefore);

    rmSync(join(base, 'worktrees', 'acme', 'select-width'), { recursive: true, force: true });
    const gone = await run(['list']);
    expect(gone.code).toBe(0);
    expect(gone.out).toBe(
      'team acme, session "acme"\n' +
      '  TASK          BRANCH            PATH\n' +
      '  select-width  fix/select-width  ../worktrees/acme/select-width (gone)\n' +
      'note: limit 8 (workspace.limit)\n' +
      '1 worktree\n',
    );
    expect(readState(join(project, '.agents')).sessions.acme?.worktrees['select-width']?.branch).toBe('fix/select-width');
    expect(git(project, 'rev-parse', '--verify', 'refs/heads/fix/select-width').trim().length).toBeGreaterThan(0);
  });

  test('--json is the reading document under the registered schema', async () => {
    expect((await run(['new', 'select-width', '--kind', 'fix', '--seat', 'lead'])).code).toBe(0);
    const io = await run(['list', '--json']);
    expect(io.code).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<Record<string, unknown>>(io.out, WORKTREE_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({
      schema: { name: 'team.worktree', version: 1 },
      format: 1,
      project: 'acme',
      session: 'acme',
      notice: null,
      worktrees: [{
        task: 'select-width',
        branch: 'fix/select-width',
        path: '../worktrees/acme/select-width',
        session: 'acme',
        seat: 'lead',
        exists: true,
      }],
      notes: ['limit 8 (workspace.limit)'],
      summary: { worktrees: 1 },
    });
  });

  test('rows are ordered by session, then task', async () => {
    updateState(join(project, '.agents'), (state) => {
      const later = (state.sessions.z ??= emptySession());
      later.worktrees.beta = { path: '../worktrees/acme/beta', branch: 'fix/beta', setup: 'ok' };
      const earlier = (state.sessions.m ??= emptySession());
      earlier.worktrees.alpha = { path: '../worktrees/acme/alpha', branch: 'fix/alpha', setup: 'ok', seat: 'lead' };
    });
    const io = await run(['list']);
    expect(io.code).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\n' +
      '  TASK   BRANCH     PATH\n' +
      '  alpha  fix/alpha  ../worktrees/acme/alpha (gone)\n' +
      '  beta   fix/beta   ../worktrees/acme/beta (gone)\n' +
      'note: limit 8 (workspace.limit)\n' +
      '2 worktrees\n',
    );
  });

  test('the limit refusal keeps its first clause and names the same rows', async () => {
    approve(teamText({ limit: 1 }));
    expect((await run(['new', 'select-width', '--kind', 'fix', '--seat', 'lead'])).code).toBe(0);
    const limited = await run(['new', 'other-task', '--kind', 'fix']);
    expect(limited.code).toBe(1);
    expect(limited.err).toBe(
      'team worktree: the worktree limit is 1, and 1 are open (workspace.limit in the team file)\n' +
      'select-width session acme seat lead ../worktrees/acme/select-width folder exists\n',
    );
    expect(existsSync(join(base, 'worktrees', 'acme', 'other-task'))).toBe(false);
  });

  test('a seat that is not the orchestrator or the operator is refused', async () => {
    recordSeat('lead', 'w1:p1');
    const leadList = await run(['list'], lead);
    expect(leadList.code).toBe(0);
    expect(leadList.out).toBe(
      'team acme, session "acme"\n' +
      '  TASK  BRANCH  PATH\n' +
      'note: limit 8 (workspace.limit)\n' +
      '0 worktrees\n',
    );
    const other = await run(['list'], { kind: 'seat', name: 'stranger', pane: 'w2:p1' });
    expect(other.code).toBe(1);
    expect(other.err).toBe('team worktree: only the owner, the orchestrator or the operator runs it; this call is stranger\n');
  });

  test('a task, --kind or --seat is refused', async () => {
    const extra = await run(['list', 'nope']);
    expect(extra.code).toBe(2);
    expect(extra.err).toContain('unexpected "nope"');
    const flags = await run(['list', '--seat', 'lead']);
    expect(flags.code).toBe(2);
    expect(flags.err).toContain('list takes no --kind or --seat');
  });
});
