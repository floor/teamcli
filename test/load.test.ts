import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findRoot, loadTeamFile, NOT_A_REPO } from '../src/file/load.ts';
import type { LoadResult } from '../src/file/types.ts';
import { gitEnv } from './helpers.ts';

const example = new URL('./fixtures/example.yaml', import.meta.url).pathname;
let base: string;
let project: string;
let worktree: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore', env: gitEnv() });
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-load-')));
  project = join(base, 'acme-web');
  worktree = join(base, 'worktrees', 'acme-web', 'task');
  mkdirSync(join(project, 'src'), { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'acme\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'worktree', 'add', '-q', worktree, '-b', 'task');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the project root', () => {
  test('is the main checkout, from a subfolder and from a linked worktree', () => {
    expect(findRoot(project)).toBe(project);
    expect(findRoot(join(project, 'src'))).toBe(project);
    expect(findRoot(worktree)).toBe(project);
  });
  test('is null outside a repository', () => {
    expect(findRoot(base)).toBeNull();
  });
});

describe('loading the file', () => {
  test('no file: one message says it is private to each clone', () => {
    const result = loadTeamFile(project);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toMatch(/no team file here; it is private to each clone: run `team init`/);
    expect(result.path).toBe(join(project, '.agents', 'team.yaml'));
  });

  test('a linked worktree reads the main checkout\'s file', () => {
    mkdirSync(join(project, '.agents'), { recursive: true });
    copyFileSync(example, join(project, '.agents', 'team.yaml'));
    const result = loadTeamFile(worktree);
    expect(result).toMatchObject({ ok: true, root: project, path: join(project, '.agents', 'team.yaml') });
  });

  test('an invalid file comes back with its problems and its path', () => {
    writeFileSync(join(project, '.agents', 'team.yaml'), 'format: 2\n');
    const result = loadTeamFile(join(project, 'src'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((problem) => /format must be 1/.test(problem.message))).toBe(true);
    expect(result.path).toBe(join(project, '.agents', 'team.yaml'));
  });

  test('--file: the root is the folder that holds its .agents/', () => {
    const other = join(base, 'other', '.agents');
    mkdirSync(other, { recursive: true });
    copyFileSync(example, join(other, 'team.yaml'));
    expect(loadTeamFile(base, { file: 'other/.agents/team.yaml' })).toMatchObject({ ok: true, root: join(base, 'other') });
  });

  test('a trust pattern that names the project\'s parent by its own name is refused', () => {
    // The project is <base>/acme-web: "../../<base's name>/*" is every folder beside it.
    const parent = base.split('/').pop() as string;
    const text = readFileSync(example, 'utf8')
      .replace('  - ../worktrees/acme-web/*', `  - ../../${parent}/*`)
      .replace('path: ../worktrees/{repo}/{task}', `path: ../../${parent}/{task}`);
    writeFileSync(join(project, '.agents', 'team.yaml'), text);
    const result = loadTeamFile(project);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const messages = result.errors.map((problem) => problem.message).join('\n');
    expect(messages).toMatch(/trust: "\.\.\/\.\.\/[^"]+\/\*" names the project's parent/);
    expect(messages).toMatch(/workspace\.path: .* puts worktrees in the project's parent/);
  });

  test('a symlink to the project\'s parent is refused as the parent is', () => {
    symlinkSync(base, join(base, 'alias'));
    const text = readFileSync(example, 'utf8').replace('  - ../worktrees/acme-web/*', '  - ../worktrees/acme-web/*\n  - ../alias/*');
    writeFileSync(join(project, '.agents', 'team.yaml'), text);
    const result = loadTeamFile(project);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toMatch(/names the project's parent/);
  });

  test('outside a repository and without --file', () => {
    const result = loadTeamFile(base);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toBe(NOT_A_REPO);
  });

  test('a folder with no git reads .agents/team.yaml in that folder', () => {
    const plain = join(base, 'plain');
    mkdirSync(join(plain, '.agents'), { recursive: true });
    copyFileSync(example, join(plain, '.agents', 'team.yaml'));
    expect(loadTeamFile(plain)).toMatchObject({
      ok: true,
      root: plain,
      path: join(plain, '.agents', 'team.yaml'),
    });
    const empty = join(base, 'empty-folder');
    mkdirSync(empty);
    const missing = loadTeamFile(empty);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.path).toBeUndefined();
      expect(missing.errors[0]?.message).toBe(NOT_A_REPO);
    }
  });

  test('a parent folder\'s file is not found', () => {
    const parent = join(base, 'holding');
    const child = join(parent, 'child');
    mkdirSync(join(parent, '.agents'), { recursive: true });
    mkdirSync(child);
    copyFileSync(example, join(parent, '.agents', 'team.yaml'));
    const result = loadTeamFile(child);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.path).toBeUndefined();
    expect(result.errors[0]?.message).toBe(NOT_A_REPO);
  });
});

// The git-project inputs of the tests above, run through this tree and through the tree it
// forked from main at — merge-base(HEAD, origin/main), which is origin/main itself on main and
// on every branch carrying it. Against origin/main's tip the comparison fails on any tree
// behind main over main's own deliberate changes (the renamed refusals, for one), which is
// drift no branch behind main should be held to; against the fork point it fails only on this
// tree's own loader moving away from what it forked as. The fallback is the no-repository
// case only, so these stay identical.
type Loader = {
  findRoot(cwd: string): string | null;
  loadTeamFile(cwd: string, options?: { file?: string }): LoadResult;
};

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: import.meta.dir, encoding: 'utf8' }).trim();

// The tree this one forked from main at.
function forkPoint(): string {
  return execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: repo, encoding: 'utf8' }).trim();
}

// The tree of `ref`, unpacked into `where` (a fresh folder) with its src/file/load.ts imported.
async function loaderOf(ref: string, where: string): Promise<Loader> {
  const packed = join(where, 'tree.tar');
  execFileSync('git', ['archive', '-o', packed, ref], { cwd: repo, stdio: 'ignore' });
  execFileSync('tar', ['-x', '-C', where, '-f', packed], { stdio: 'ignore' });
  rmSync(packed);
  return (await import(pathToFileURL(join(where, 'src/file/load.ts')).href)) as Loader;
}

// One sentence changed on purpose, and this list is the whole of it: the loader no longer sends
// anyone to the copy an owner last approved (that command is gone), and says "the copy this
// machine stored" instead. Every other byte is still held against the fork point.
const REWORDED: ReadonlyArray<readonly [string, string]> = [
  ['the copy you last approved on this machine', 'the copy this machine stored'],
];

function canonical(shape: string): string {
  return REWORDED.reduce((text, [from, to]) => text.split(from).join(to), shape);
}

// The fixture project, the sequence the tests above use, run through both loaders: one line
// per case they disagree on. The guard asserts an empty list; the drift test asserts the
// opposite, so the comparison cannot quietly stop comparing.
function disagreements(candidate: Loader, reference: Loader, fixture: string): string[] {
  const project = join(fixture, 'acme-web');
  const worktree = join(fixture, 'worktrees', 'acme-web', 'task');
  mkdirSync(join(project, 'src'), { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'acme\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'worktree', 'add', '-q', worktree, '-b', 'task');

  const found: string[] = [];
  const shape = (result: LoadResult) =>
    result.ok
      ? { ok: true as const, root: result.root, path: result.path }
      : { ok: false as const, path: result.path, errors: result.errors.map((problem) => problem.message) };
  const roots = (label: string, cwd: string) => {
    const candidateRoot = candidate.findRoot(cwd);
    const referenceRoot = reference.findRoot(cwd);
    if (candidateRoot !== referenceRoot) found.push(`${label}: ${candidateRoot} vs ${referenceRoot}`);
  };
  const same = (label: string, cwd: string, options?: { file?: string }) => {
    const candidateShape = canonical(JSON.stringify(shape(candidate.loadTeamFile(cwd, options))));
    const referenceShape = canonical(JSON.stringify(shape(reference.loadTeamFile(cwd, options))));
    if (candidateShape !== referenceShape) found.push(`${label}\n  candidate:  ${candidateShape}\n  reference:  ${referenceShape}`);
  };

  roots('findRoot(project)', project);
  roots('findRoot(project/src)', join(project, 'src'));
  roots('findRoot(worktree)', worktree);
  roots('findRoot(fixture)', fixture);
  same('no file', project);
  same('no file, from src/', join(project, 'src'));
  same('no file, from the worktree', worktree);
  same('no repository', fixture);

  mkdirSync(join(project, '.agents'), { recursive: true });
  copyFileSync(example, join(project, '.agents', 'team.yaml'));
  same('the file, from the worktree', worktree);
  same('the file, by --file', project, { file: join(project, '.agents', 'team.yaml') });

  writeFileSync(join(project, '.agents', 'team.yaml'), 'format: 2\n');
  same('an invalid file', join(project, 'src'));

  const parent = fixture.split('/').pop() as string;
  const text = readFileSync(example, 'utf8')
    .replace('  - ../worktrees/acme-web/*', `  - ../../${parent}/*`)
    .replace('path: ../worktrees/{repo}/{task}', `path: ../../${parent}/{task}`);
  writeFileSync(join(project, '.agents', 'team.yaml'), text);
  same('the parent-naming trust', project);

  symlinkSync(fixture, join(fixture, 'alias'));
  const linked = readFileSync(example, 'utf8').replace(
    '  - ../worktrees/acme-web/*',
    '  - ../worktrees/acme-web/*\n  - ../alias/*',
  );
  writeFileSync(join(project, '.agents', 'team.yaml'), linked);
  same('the symlinked parent', project);

  // A nested file is the case that is not extended: the git root's file, missing here, wins.
  mkdirSync(join(project, 'nested', '.agents'), { recursive: true });
  copyFileSync(example, join(project, 'nested', '.agents', 'team.yaml'));
  rmSync(join(project, '.agents', 'team.yaml'));
  same('the nested file', join(project, 'nested'));

  return found;
}

test('a git project loads as the tree at its merge-base with main loads it', async () => {
  const archive = realpathSync(mkdtempSync(join(tmpdir(), 'team-load-fork-')));
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'team-load-both-')));
  try {
    const atFork = await loaderOf(forkPoint(), archive);
    expect(disagreements({ findRoot, loadTeamFile }, atFork, fixture)).toEqual([]);
    const nested = loadTeamFile(join(fixture, 'acme-web', 'nested'));
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.path).toBe(join(fixture, 'acme-web', '.agents', 'team.yaml'));
  } finally {
    rmSync(archive, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);

// The guard is only a guard while it fails on a real difference: this imports a loadTeamFile
// that answers every error with one line more — the drift an edit to src/file/load.ts makes —
// and expects the same comparison the guard holds empty to report it against the very tree the
// guard compares against.
test('the comparison catches a load.ts that drifted', async () => {
  const archive = realpathSync(mkdtempSync(join(tmpdir(), 'team-load-drift-')));
  const probe = realpathSync(mkdtempSync(join(tmpdir(), 'team-load-probe-')));
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'team-load-drift-both-')));
  try {
    const reference = await loaderOf(forkPoint(), archive);
    const base = pathToFileURL(join(archive, 'src/file/load.ts')).href;
    writeFileSync(join(probe, 'drifted.ts'), [
      `export * from ${JSON.stringify(base)};`,
      `import * as load from ${JSON.stringify(base)};`,
      `export function loadTeamFile(cwd, options) {`,
      `  const result = load.loadTeamFile(cwd, options);`,
      `  return result.ok ? result : { ...result, errors: [...result.errors, { message: 'drift: the loader was changed' }] };`,
      `}`,
      ``,
    ].join('\n'));
    const drifted = (await import(pathToFileURL(join(probe, 'drifted.ts')).href)) as Loader;
    const mismatches = disagreements(drifted, reference, fixture);
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.join('\n')).toMatch(/drift: the loader was changed/);
  } finally {
    rmSync(archive, { recursive: true, force: true });
    rmSync(probe, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);
