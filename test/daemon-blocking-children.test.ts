// The daemon's loops start no synchronous child they do not need. A long-lived process holds the
// roots git named, so a beat that reads every hosted root's team file asks git once per root,
// not on every read; a hold never keeps a folder git did not place, nor a root whose folder or
// common directory has gone, and a CLI run outside a hold asks git as before. A hosted watch
// names the daemon as its caller and never walks its own parents with `ps`. Synthetic folders,
// a synthetic team and injected sources; no live daemon, herdr or CLI.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { findRoot, holdGitRoots, HELD_GIT_ROOT_MS } from '../src/file/load.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Machine } from '../src/watch/machine.ts';
import { hostedLoop } from './helpers/hosted-watch.ts';
import { testIo } from './helpers.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, 'fixtures/example.yaml'), 'utf8');
const NOW = new Date('2026-11-15T16:00:00Z');
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

let base: string;
let releases: Array<() => void> = [];
const priorPath = process.env.PATH;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-blocking-children-')));
});

afterEach(() => {
  for (const release of releases.splice(0)) release();
  process.env.PATH = priorPath;
  rmSync(base, { recursive: true, force: true });
});

function repo(name: string): string {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  return root;
}

/** The answer findRoot gives while no `git` can be started: a held root answers, a read that
 *  needs a child finds none and answers null. */
function withoutGit(cwd: string): string | null {
  process.env.PATH = join(base, 'no-bin');
  try {
    return findRoot(cwd);
  } finally {
    process.env.PATH = priorPath;
  }
}

function hold(options: { ttlMs?: number; now?: () => number } = {}): () => void {
  const release = holdGitRoots(options);
  releases.push(release);
  return release;
}

describe('git roots in a long-lived process', () => {
  test('outside a hold every read asks git', () => {
    const root = repo('plain');
    expect(findRoot(root)).toBe(root);
    expect(withoutGit(root)).toBeNull();
  });

  test('inside a hold a found root is answered without a second git child', () => {
    const root = repo('held');
    const sub = join(root, 'deep', 'er');
    mkdirSync(sub, { recursive: true });
    hold();
    expect(findRoot(sub)).toBe(root);
    expect(withoutGit(sub)).toBe(root);
    expect(withoutGit(sub)).toBe(root);
  });

  test('the last release drops what the hold kept', () => {
    const root = repo('released');
    const outer = hold();
    const inner = hold();
    expect(findRoot(root)).toBe(root);
    inner();
    expect(withoutGit(root)).toBe(root);
    outer();
    expect(withoutGit(root)).toBeNull();
  });

  test('a held root stands only for its hold time', () => {
    const root = repo('aged');
    let clock = 1_000;
    hold({ now: () => clock });
    expect(findRoot(root)).toBe(root);
    clock += HELD_GIT_ROOT_MS - 1;
    expect(withoutGit(root)).toBe(root);
    clock += 1;
    expect(withoutGit(root)).toBeNull();
  });

  test('a root whose common directory has gone is asked again', () => {
    const root = repo('moved');
    hold();
    expect(findRoot(root)).toBe(root);
    renameSync(join(root, '.git'), join(base, 'moved-git'));
    expect(withoutGit(root)).toBeNull();
    expect(findRoot(root)).toBeNull();
  });

  test('a folder git did not place is never held', () => {
    const folder = join(base, 'not-yet');
    mkdirSync(folder);
    hold();
    expect(findRoot(folder)).toBeNull();
    execFileSync('git', ['init', '-q'], { cwd: folder, stdio: 'ignore' });
    expect(findRoot(folder)).toBe(folder);
  });
});

describe('a hosted watch names the daemon as its caller', () => {
  test('its run never asks the caller sources, which walk the parents with ps', async () => {
    const root = repo('acme-web');
    const home = join(base, 'home');
    mkdirSync(home);
    mkdirSync(join(root, '.agents'), { recursive: true });
    const file = join(root, '.agents/team.yaml');
    writeFileSync(file, EXAMPLE);
    let asked = 0;
    const io = {
      ...testIo(root),
      callerSources: () => {
        asked += 1;
        throw new Error('a hosted watch walked its own parents');
      },
    };
    let left = 2;
    let clock = NOW.getTime();
    const sources: WatchSources = {
      hosted: hostedLoop(),
      home,
      live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
      machine: () => fine,
      standing: (project) => {
        const text = readFileSync(file, 'utf8');
        const parsed = validateTeamFile(text);
        return parsed.ok ? verifiedOf(parsed.team, text, project) : { kind: 'none' };
      },
      readChecks: () => [],
      screen: () => '',
      status: () => 'idle',
      foreground: () => [],
      typeText: () => true,
      pressEnter: () => true,
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock),
      wait: async (seconds) => { clock += seconds * 1000; return --left > 0; },
      alive: () => false,
      pid: 4242,
    };
    const code = await runWatch(['--file', '.agents/team.yaml'], io, sources);
    expect({ code, err: io.err }).toMatchObject({ code: 0 });
    expect(asked).toBe(0);
    expect(io.out).toContain('the watch of "acme-web" stopped');
  });
});
