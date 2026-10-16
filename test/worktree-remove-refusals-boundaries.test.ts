// The two record checks that gate a `worktree remove`, at the sentences the internal page
// carries — a page no test walks. Each row tampers the unsigned state the way the guard exists
// for, and proves three things at once: the refusal is the page's whole line, the exit is 1,
// and "nothing was removed" is literal — the folder and the record both survive as they were.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runWorktree, type WorktreeSources } from '../src/commands/worktree.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

let base: string;
let project: string;
let home: string;
let sources: WorktreeSources;

const owner = { kind: 'owner' } as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

const TEAM = `format: 1
project: acme
visibility: public
coordinator: lead
operator: lead
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

/** The state record a `worktree new` leaves behind, with one field tampered. */
function tamper(task: string, patch: { path?: string; branch?: string }): void {
  updateState(join(project, '.agents'), (state) => {
    const record = state.sessions.acme?.worktrees[task];
    if (!record) throw new Error(`no record for ${task}`);
    if (patch.path !== undefined) record.path = patch.path;
    if (patch.branch !== undefined) record.branch = patch.branch;
  });
}

/** A task with a real folder, branch and record, ready to be tampered and removed. */
async function make(task: string): Promise<void> {
  const io = testIo(project, owner);
  const code = await runWorktree(['new', task, '--kind', 'fix'], io, sources);
  expect(code, `new ${task} said:\n${io.out}\n${io.err}`).toBe(0);
}

function record(task: string) {
  return readState(join(project, '.agents')).sessions.acme?.worktrees[task];
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-worktree-refusals-')));
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
  sources = { home, now: () => new Date('2026-10-15T14:00:00Z') };
  mkdirSync(join(project, '.agents'), { recursive: true });
  writeFileSync(join(project, '.agents', 'team.yaml'), TEAM);
  const loaded = loadTeamFile(project);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: TEAM },
    loaded.team.seats,
    home,
  );
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('the record checks that gate a worktree remove', () => {
  test('a recorded branch wiped empty is refused with the page\'s whole line, and nothing is removed', async () => {
    await make('select-width');
    tamper('select-width', { branch: '' });

    const io = testIo(project, owner);
    expect(await runWorktree(['remove', 'select-width'], io, sources)).toBe(1);
    expect(io.err).toBe(
      'team worktree: the recorded branch "" does not match "{kind}/{task}" for "select-width"; nothing was removed\n',
    );
    // "Nothing was removed" is literal: the folder stands and the record stands, tampered field and all.
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width', 'README.md'))).toBe(true);
    expect(record('select-width')?.branch).toBe('');
  });

  test('a recorded branch pointed at the base is refused with the page\'s whole line', async () => {
    await make('select-width');
    tamper('select-width', { branch: 'main' });

    const io = testIo(project, owner);
    expect(await runWorktree(['remove', 'select-width'], io, sources)).toBe(1);
    expect(io.err).toBe(
      'team worktree: the recorded branch "main" does not match "{kind}/{task}" for "select-width"; nothing was removed\n',
    );
    expect(record('select-width')).toBeDefined();
  });

  test('a branch that fills the pattern for another task does not fill it for this one', async () => {
    await make('select-width');
    await make('other-task');
    tamper('select-width', { branch: 'fix/other-task' });

    const io = testIo(project, owner);
    expect(await runWorktree(['remove', 'select-width'], io, sources)).toBe(1);
    expect(io.err).toBe(
      'team worktree: the recorded branch "fix/other-task" does not match "{kind}/{task}" for "select-width"; nothing was removed\n',
    );
    expect(record('select-width')?.branch).toBe('fix/other-task');
  });

  test('a record wrong on both counts answers the path sentence alone', async () => {
    await make('select-width');
    await make('other-task');
    tamper('select-width', { path: '../worktrees/acme/other-task', branch: 'main' });

    const io = testIo(project, owner);
    expect(await runWorktree(['remove', 'select-width'], io, sources)).toBe(1);
    expect(io.err).toBe(
      'team worktree: the recorded path "../worktrees/acme/other-task" is not "../worktrees/acme/select-width"; nothing was removed\n',
    );
    // The path check speaks first; the branch check never adds its sentence beside it.
    expect(io.err).not.toContain('does not match');
    expect(record('select-width')?.path).toBe('../worktrees/acme/other-task');
    expect(existsSync(join(base, 'worktrees', 'acme', 'other-task', 'README.md'))).toBe(true);
  });
});
