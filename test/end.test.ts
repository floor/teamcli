import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeMerge, readMerge } from '../src/end/condition.ts';
import { resultPathProblem } from '../src/end/until.ts';
import { readEnd } from '../src/watch/end.ts';
import { gitEnv } from './helpers.ts';

describe('a result path stays inside the project', () => {
  test('an absolute path and a .. segment are refused, and a link is not followed', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-path-')));
    const outside = join(root, '..', 'outside.txt');
    try {
      writeFileSync(outside, 'secret\n');
      symlinkSync(outside, join(root, 'alias'));
      expect(resultPathProblem(root, '/tmp/out.md')).toContain('relative to the project');
      expect(resultPathProblem(root, '~/out.md')).toContain('relative to the project');
      expect(resultPathProblem(root, 'C:/out.md')).toContain('relative to the project');
      expect(resultPathProblem(root, '../outside.txt')).toContain('relative to the project');
      expect(resultPathProblem(root, 'notes/../../outside.txt')).toContain('relative to the project');
      expect(resultPathProblem(root, 'notes/../inside.txt')).toContain('relative to the project');
      expect(resultPathProblem(root, 'notes/out.md')).toBeNull();
      // `alias` points at a file outside the project. The check reads the path as written
      // and does not follow the link, so the name is inside the project.
      expect(resultPathProblem(root, 'alias')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });
});

describe('a stored result path', () => {
  test('an absolute path or a .. segment is refused, and the seat is named', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-stored-')));
    const outside = join(root, '..', 'outside.md');
    try {
      writeFileSync(outside, 'x\n');
      expect(readEnd(root, 'result:../outside.md', null, false, 'worker-tmp-1')).toEqual({
        kind: 'merged',
        verdict: 'unproven',
        ownNow: 0,
        detail: 'worker-tmp-1: a result path is relative to the project; nothing is removed',
      });
      expect(readEnd(root, 'result:/tmp/out.md', null, false, 'worker-tmp-1').kind).toBe('merged');
      writeFileSync(join(root, 'out.md'), 'x\n');
      expect(readEnd(root, 'result:out.md', null, false, 'worker-tmp-1')).toEqual({ kind: 'result', exists: true });
      expect(readEnd(root, 'result:missing.md', null, false)).toEqual({ kind: 'result', exists: false });
      symlinkSync(outside, join(root, 'alias'));
      // The name `alias` is inside the project, so it is not refused. Existence follows the link.
      expect(readEnd(root, 'result:alias', null, false, 'worker-tmp-1')).toEqual({ kind: 'result', exists: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });
});

describe('merged, from the branch\'s own commits', () => {
  test('a fresh branch, one only brought up to date, and a real merge', () => {
    expect(judgeMerge({ fetch: 'ok', branch: 'present', ownNow: [], ownBefore: false }).verdict).toBe('open');
    expect(judgeMerge({ fetch: 'ok', branch: 'present', ownNow: [], ownBefore: false }).detail).toContain('never had');
    expect(judgeMerge({ fetch: 'ok', branch: 'present', ownNow: ['abc own'], ownBefore: true }).verdict).toBe('open');
    expect(judgeMerge({ fetch: 'ok', branch: 'present', ownNow: [], ownBefore: true }).verdict).toBe('merged');
  });

  test('a failed fetch or a deleted branch removes nothing', () => {
    expect(judgeMerge({ fetch: 'failed', branch: 'present', ownNow: [], ownBefore: true }).verdict).toBe('unproven');
    expect(judgeMerge({ fetch: 'ok', branch: 'gone', ownNow: [], ownBefore: true }).detail).toContain('squash');
  });
});

describe('read from a repository', () => {
  let base: string;
  let project: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
    });
  }

  function setup(): void {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'team-end-')));
    project = join(base, 'acme');
    const remote = join(base, 'remote.git');
    mkdirSync(project);
    git(base, 'init', '-q', '--bare', '-b', 'main', remote);
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'config', 'user.name', 'Test');
    git(project, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(project, 'README.md'), 'acme\n');
    git(project, 'add', 'README.md');
    git(project, 'commit', '-q', '-m', 'first');
    git(project, 'remote', 'add', 'origin', remote);
    git(project, 'push', '-q', '-u', 'origin', 'main');
  }

  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test('a fresh branch and one that was only fast-forwarded are not merged', () => {
    setup();
    git(project, 'branch', 'fix/fresh');
    expect(readMerge(project, 'fix/fresh', 'main', false)).toMatchObject({ verdict: 'open', ownNow: 0 });
    git(project, 'commit', '-q', '--allow-empty', '-m', 'later');
    git(project, 'push', '-q', 'origin', 'main');
    git(project, 'branch', 'fix/updated', 'HEAD~1');
    git(project, 'checkout', '-q', 'fix/updated');
    git(project, 'merge', '-q', '--ff-only', 'origin/main');
    expect(readMerge(project, 'fix/updated', 'main', false).detail).toContain('never had');
  });

  test('a merge of the branch\'s own commit is merged only after it was seen', () => {
    setup();
    git(project, 'checkout', '-q', '-b', 'fix/own');
    git(project, 'commit', '-q', '--allow-empty', '-m', 'own');
    expect(readMerge(project, 'fix/own', 'main', false)).toMatchObject({ verdict: 'open', ownNow: 1 });
    git(project, 'checkout', '-q', 'main');
    git(project, 'merge', '-q', '--no-ff', 'fix/own', '-m', 'merge own');
    git(project, 'push', '-q', 'origin', 'main');
    expect(readMerge(project, 'fix/own', 'main', false).verdict).toBe('open');
    expect(readMerge(project, 'fix/own', 'main', true).verdict).toBe('merged');
  });

  test('a squash leaves the branch\'s commits in place, so it is not merged', () => {
    setup();
    git(project, 'checkout', '-q', '-b', 'fix/squash');
    git(project, 'commit', '-q', '--allow-empty', '-m', 'own');
    git(project, 'checkout', '-q', 'main');
    git(project, 'commit', '-q', '--allow-empty', '-m', 'squashed');
    git(project, 'push', '-q', 'origin', 'main');
    expect(readMerge(project, 'fix/squash', 'main', true)).toMatchObject({
      verdict: 'open',
      ownNow: 1,
      detail: 'merged? not provable',
    });
  });

  test('a branch whose tree still differs is open, and stays quiet', () => {
    setup();
    git(project, 'checkout', '-q', '-b', 'fix/open');
    writeFileSync(join(project, 'README.md'), 'changed\n');
    git(project, 'commit', '-q', '-am', 'own');
    expect(readMerge(project, 'fix/open', 'main', true)).toMatchObject({
      verdict: 'open',
      ownNow: 1,
      detail: 'the branch still has commits of its own',
    });
  });

  test('a branch that starts with a dash is refused', () => {
    setup();
    expect(readMerge(project, '-not-a-branch', 'main', true)).toEqual({
      verdict: 'unproven',
      ownNow: 0,
      detail: 'the branch is not a name git accepts; nothing is removed',
    });
  });

  // The git wrapper below routes each call through a bun process of its own: under a loaded
  // machine the runner's five-second default budget measures that spawn cost, not this scene's
  // work. Thirty seconds fits several interpreter starts while still bounding the scene, and the
  // assertions are unchanged — the wrapper logs the same argv and the check still pins
  // `--end-of-options` before the branch and the remote.
  test('rev-list and diff put --end-of-options before the branch and the remote', () => {
    setup();
    git(project, 'checkout', '-q', '-b', 'fix/own');
    git(project, 'commit', '-q', '--allow-empty', '-m', 'own');
    const bin = join(base, 'bin');
    const log = join(base, 'git-args.log');
    mkdirSync(bin);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(process.env.GIT_ARGV_LOG ?? '', JSON.stringify(args) + '\\n');
const run = spawnSync(process.env.REAL_GIT ?? '', args, { stdio: 'inherit' });
process.exit(run.status === null ? 1 : run.status);
`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    process.env.GIT_ARGV_LOG = log;
    process.env.REAL_GIT = realGit;
    try {
      expect(readMerge(project, 'fix/own', 'main', false)).toMatchObject({ verdict: 'open', ownNow: 1 });
    } finally {
      process.env.PATH = savedPath;
      delete process.env.GIT_ARGV_LOG;
      delete process.env.REAL_GIT;
    }
    const calls = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as string[]);
    const revList = calls.find((args) => args[0] === 'rev-list');
    const diff = calls.find((args) => args[0] === 'diff');
    expect(revList).toBeDefined();
    expect(diff).toBeDefined();
    for (const [args, names] of [
      [revList!, ['fix/own', '^origin/main']],
      [diff!, ['origin/main', 'fix/own']],
    ] as const) {
      const separator = args.indexOf('--end-of-options');
      expect(separator).toBeGreaterThanOrEqual(0);
      for (const name of names) expect(args.indexOf(name)).toBeGreaterThan(separator);
    }
  }, 30_000);

  test('a deleted branch and a failed fetch are unproven', () => {
    setup();
    git(project, 'branch', 'fix/gone');
    git(project, 'push', '-q', 'origin', 'fix/gone');
    git(project, 'branch', '-D', 'fix/gone');
    git(project, 'push', '-q', 'origin', ':fix/gone');
    expect(readMerge(project, 'fix/gone', 'main', true).verdict).toBe('unproven');
    git(project, 'remote', 'set-url', 'origin', join(base, 'missing.git'));
    expect(readMerge(project, 'main', 'main', true).detail).toContain('fetch failed');
  });
});
