// The held git roots are partitioned by the run's git environment (rfc-bus-send-server §2.4): a
// long-lived process that serves runs with different environments (the warm send host) answers
// each run exactly as a fresh process with that environment would, in either order. A held "not a
// repository" stands only while no `.git` appears above the folder.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findRoot, gitEnvDigest, holdGitRoots } from '../../src/file/load.ts';

let base: string;
let repo: string;
let other: string;
let plain: string;
let release: () => void;
const saved: Record<string, string | undefined> = {};
const GIT_NAMES = ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'];

function fresh(cwd: string, env: Record<string, string | undefined>): string | null {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: env as NodeJS.ProcessEnv,
    }).trim();
    return common ? dirname(common) : null;
  } catch {
    return null;
  }
}

function withGit(values: Record<string, string>, fn: () => void): void {
  for (const name of GIT_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try { fn(); } finally { for (const name of GIT_NAMES) delete process.env[name]; }
}

beforeEach(() => {
  for (const name of GIT_NAMES) saved[name] = process.env[name];
  base = realpathSync(mkdtempSync(join(tmpdir(), 'git-hold-')));
  repo = join(base, 'repo');
  other = join(base, 'other');
  plain = join(base, 'plain');
  for (const dir of [repo, other, plain]) mkdirSync(dir);
  for (const dir of [repo, other]) execFileSync('git', ['init', '-q', dir]);
  release = holdGitRoots();
});

afterEach(() => {
  release();
  for (const name of GIT_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(base, { recursive: true, force: true });
});

describe('the git-root hold and the git environment', () => {
  test('the digest changes with GIT_* and PATH, and not with an unrelated variable', () => {
    const a = gitEnvDigest({ PATH: '/bin', HOME: '/h' });
    expect(gitEnvDigest({ PATH: '/bin', HOME: '/h', UNRELATED: 'x' })).toBe(a);
    expect(gitEnvDigest({ PATH: '/bin', HOME: '/h', GIT_DIR: '/x' })).not.toBe(a);
    expect(gitEnvDigest({ PATH: '/usr/bin', HOME: '/h' })).not.toBe(a);
    expect(gitEnvDigest({ PATH: '/bin', HOME: '/other' })).not.toBe(a);
  });

  for (const order of ['plain first', 'overrides first'] as const) {
    test(`same folder, ordinary then invalid then another GIT_DIR (${order}) matches a fresh git`, () => {
      const runs: [string, Record<string, string>][] = [
        ['ordinary', {}],
        ['invalid GIT_DIR', { GIT_DIR: join(base, 'missing') }],
        ['another GIT_DIR', { GIT_DIR: join(other, '.git') }],
        ['another GIT_DIR and GIT_COMMON_DIR', { GIT_DIR: join(other, '.git'), GIT_COMMON_DIR: join(other, '.git') }],
      ];
      const sequence = order === 'plain first' ? [...runs, ...runs] : [...runs.slice(1), runs[0]!, ...runs.slice(1), runs[0]!];
      for (const [, values] of sequence) {
        withGit(values, () => {
          expect(findRoot(repo)).toBe(fresh(repo, { ...process.env }));
        });
      }
    });
  }

  test('a held "not a repository" stands until a .git appears above the folder', () => {
    expect(findRoot(plain)).toBeNull();
    expect(findRoot(plain)).toBeNull();
    execFileSync('git', ['init', '-q', plain]);
    expect(findRoot(plain)).toBe(fresh(plain, { ...process.env }));
  });

  test('a held "not a repository" is not reused by a run with another GIT_DIR', () => {
    expect(findRoot(plain)).toBeNull();
    withGit({ GIT_DIR: join(other, '.git') }, () => {
      expect(findRoot(plain)).toBe(fresh(plain, { ...process.env }));
    });
    expect(findRoot(plain)).toBeNull();
  });
});
