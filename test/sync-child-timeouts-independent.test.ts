// A sleeping ps must not place a caller, a narrowed child bound stays inside
// its default, a long commit range still answers, and grep still reads the
// pattern it is given on stdin.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { placeCaller, readAncestors, readWithPs } from '../src/caller.ts';
import { selectCommits } from '../src/check/git.ts';
import { scanPrivateTree } from '../src/check/private-names.ts';
import { syncChildTimeout } from '../src/child.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv } from './helpers.ts';

const MARK = 'fixture-marker-one';
const RANGE = 80;

let scratchParent: string | undefined;
const made: string[] = [];

afterEach(() => {
  discardFixtures(made.splice(0), { roots: scratchParent === undefined ? [] : [scratchParent] });
});

function scratch(): string {
  const base = fixtureBase('sync-child-');
  scratchParent ??= dirname(base);
  made.push(base);
  return base;
}

function git(root: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], {
    cwd: root,
    env: gitEnv(),
    stdio: 'ignore',
  });
}

function repoWith(commits: number): string {
  const root = join(scratch(), 'repo');
  mkdirSync(root, { recursive: true });
  git(root, ['init', '-q']);
  writeFileSync(join(root, 'note.txt'), `${MARK}\n`, { mode: 0o600 });
  git(root, ['add', 'note.txt']);
  git(root, ['commit', '-q', '-m', 'fixture 1']);
  for (let n = 2; n <= commits; n += 1) git(root, ['commit', '--allow-empty', '-q', '-m', `fixture ${n}`]);
  return root;
}

const KEEPER: HerdrAgent = {
  name: 'keeper',
  agent: 'claude',
  pane: 'fixture-pane-one',
  workspace: 'floor',
  status: 'idle',
  cwd: null,
};

function placeWithPs(): ReturnType<typeof placeCaller> {
  return placeCaller({
    ancestors: () => readAncestors(process.pid, readWithPs),
    agents: () => [KEEPER],
    paneRootPid: () => process.pid,
    env: { HERDR_PANE_ID: 'fixture-pane-one' },
    stdinIsTTY: false,
  }, 'home-session');
}

function withPs(body: string, timeoutMs: string | undefined, run: () => void): void {
  const dir = join(scratch(), 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ps'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const path = process.env.PATH;
  const bound = process.env.TEAM_SYNC_CHILD_TIMEOUT_MS;
  process.env.PATH = `${dir}${delimiter}${path ?? ''}`;
  if (timeoutMs === undefined) delete process.env.TEAM_SYNC_CHILD_TIMEOUT_MS;
  else process.env.TEAM_SYNC_CHILD_TIMEOUT_MS = timeoutMs;
  try {
    run();
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    if (bound === undefined) delete process.env.TEAM_SYNC_CHILD_TIMEOUT_MS;
    else process.env.TEAM_SYNC_CHILD_TIMEOUT_MS = bound;
  }
}

describe('synchronous child bounds', () => {
  test('a ps that times out during placement refuses and does not place', () => {
    withPs("printf '1 herdr\\n'", undefined, () => {
      const placed = placeWithPs();
      expect(placed.kind).toBe('seat');
      if (placed.kind === 'seat') {
        expect(placed.name).toBe('keeper');
        expect(placed.pane).toBe('fixture-pane-one');
      }
    });
    withPs("sleep 0.35\nprintf '1 herdr\\n'", '60', () => {
      const started = performance.now();
      const placed = placeWithPs();
      expect(performance.now() - started).toBeLessThan(250);
      expect(placed).toEqual({ kind: 'unplaced', reason: 'its parent processes can\'t be read to the top' });
    });
  });

  test('the override cannot raise a bound and never goes below 50 ms', () => {
    const bound = process.env.TEAM_SYNC_CHILD_TIMEOUT_MS;
    try {
      delete process.env.TEAM_SYNC_CHILD_TIMEOUT_MS;
      expect(syncChildTimeout(2_000)).toBe(2_000);
      for (const raw of ['', '0', '-5', 'nope', '60.5']) {
        process.env.TEAM_SYNC_CHILD_TIMEOUT_MS = raw;
        expect(syncChildTimeout(2_000)).toBe(2_000);
      }
      process.env.TEAM_SYNC_CHILD_TIMEOUT_MS = '10';
      expect(syncChildTimeout(2_000)).toBe(50);
      process.env.TEAM_SYNC_CHILD_TIMEOUT_MS = '49';
      expect(syncChildTimeout(2_000)).toBe(50);
      process.env.TEAM_SYNC_CHILD_TIMEOUT_MS = '50';
      expect(syncChildTimeout(2_000)).toBe(50);
      process.env.TEAM_SYNC_CHILD_TIMEOUT_MS = '60';
      expect(syncChildTimeout(2_000)).toBe(60);
      process.env.TEAM_SYNC_CHILD_TIMEOUT_MS = '60000';
      expect(syncChildTimeout(2_000)).toBe(2_000);
      expect(syncChildTimeout(15_000)).toBe(15_000);
      expect(syncChildTimeout(30_000)).toBe(30_000);
    } finally {
      if (bound === undefined) delete process.env.TEAM_SYNC_CHILD_TIMEOUT_MS;
      else process.env.TEAM_SYNC_CHILD_TIMEOUT_MS = bound;
    }
  });

  test('a commits check over a long range does not false-fail', () => {
    const bound = process.env.TEAM_SYNC_CHILD_TIMEOUT_MS;
    delete process.env.TEAM_SYNC_CHILD_TIMEOUT_MS;
    try {
      const root = repoWith(RANGE);
      const span = `HEAD~${RANGE - 1}..HEAD`;
      const all = selectCommits(root, span);
      expect(all.commits).toHaveLength(RANGE - 1);
      expect(all.skipped).toBe(0);
      const oldest = all.commits[all.commits.length - 1]?.hash;
      if (oldest === undefined) throw new Error('the range produced no oldest commit');
      const later = selectCommits(root, span, oldest);
      expect(later.commits).toHaveLength(RANGE - 2);
      expect(later.skipped).toBe(1);
    } finally {
      if (bound === undefined) delete process.env.TEAM_SYNC_CHILD_TIMEOUT_MS;
      else process.env.TEAM_SYNC_CHILD_TIMEOUT_MS = bound;
    }
  }, 60_000);

  test('closed stdin on other children does not break grep fed by its pattern', () => {
    const root = repoWith(1);
    const scan = scanPrivateTree(root, [{
      label: 'names',
      path: 'fixture-list',
      entries: [{
        source: MARK,
        scope: ['content'],
        origin: 'names',
        ordinal: 1,
        line: 1,
      }],
    }]);
    expect('hits' in scan).toBe(true);
    if ('hits' in scan) {
      expect(scan.hits).toEqual([{ origin: 'names', ordinal: 1, path: 'note.txt', line: 1 }]);
    }
  });
});
