import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..');

// Every npm call runs offline, in a temporary home, prefix and cache of this test's
// own: no machine npm state is read or written and no network is touched.
function npmRun(home: string, args: string[], cwd: string) {
  return spawnSync('npm', [...args, '--offline', '--cache', join(home, 'cache')], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      npm_config_userconfig: join(home, 'npmrc'),
      npm_config_prefix: join(home, 'prefix'),
    },
  });
}

test('package.json files allows the shipped entries only', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  expect(pkg.files).toEqual(['dist', 'examples', 'schema', 'README.md', 'LICENSE']);
});

test('the packed tarball ships the schema and nothing it should not', () => {
  const home = mkdtempSync(join(tmpdir(), 'team-pack-home-'));
  try {
    const result = npmRun(home, ['pack', '--dry-run', '--json'], repo);
    expect(result.status).toBe(0);
    const files: { path: string }[] = JSON.parse(result.stdout)[0]?.files ?? [];
    expect(files.length).toBeGreaterThan(0);
    const paths = files.map((f) => f.path);

    // Required in every package, and the CLI itself whenever dist has been built.
    for (const required of ['schema/team.schema.json', 'package.json', 'README.md', 'LICENSE']) {
      expect(paths).toContain(required);
    }
    if (existsSync(join(repo, 'dist'))) {
      expect(paths).toContain('dist/cli.js');
    }

    // Every packed path under the allowed top-level entries…
    const allowed = ['dist/', 'examples/', 'schema/', 'package.json', 'README.md', 'LICENSE'];
    for (const path of paths) {
      expect(allowed.some((prefix) => path === prefix || path.startsWith(prefix))).toBe(true);
    }
    // …and the folders that must never ship stay absent.
    for (const forbidden of ['contract/', 'test/', 'scripts/', '.github/', 'docs/', 'src/']) {
      expect(paths.some((p) => p.startsWith(forbidden))).toBe(false);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

test('the schema is tracked at HEAD, so a tag of this commit ships the URL init writes', () => {
  // `team init` writes a $schema URL pinned to this release's tag; the guard belongs with
  // the pack tests because it is the same promise, made to the tarball's future tags.
  const result = spawnSync('git', ['-C', repo, 'ls-tree', '-r', 'HEAD', '--', 'schema/team.schema.json'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  const lines = result.stdout.trim().split('\n').filter((line) => line !== '');
  expect(lines.length).toBe(1);
  expect(lines[0]?.endsWith('schema/team.schema.json')).toBe(true);
});

test("a later release's step, rehearsed on a copy of the tree: npm-readme.md packed as the README", () => {
  // The release workflow does NOT have this step today: 0.3.0's release packs the tree as
  // it is, so npm's page shows README.md and npm-readme.md is not in the tarball (the test
  // below). This test rehearses a later release's step, which will run before its pack:
  //   npm pkg delete scripts devDependencies
  //   cp npm-readme.md README.md
  // It runs those commands on a temporary copy — never in this worktree — and asserts the
  // tarball they produce: the packed package/README.md is npm-readme.md byte for byte, and
  // the long README.md and a second copy under its own name are not in it. Keeping the
  // future step's commands honest is what this test is for.
  //
  // Why one readme: npm always packs README.md, and `files` names it too, so the file the
  // step writes is what ships. npm-readme.md is deliberately not in `files` — it is the
  // source the copy step will use, and shipping it beside README.md would put a second
  // readme in the tarball, which nothing reads.
  const home = mkdtempSync(join(tmpdir(), 'team-pack-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'team-pack-'));
  const tree = join(dir, 'tree');
  try {
    const entries = ['dist', 'examples', 'schema', 'package.json', 'README.md', 'npm-readme.md', 'LICENSE'];
    for (const entry of entries) {
      if (existsSync(join(repo, entry))) cpSync(join(repo, entry), join(tree, entry), { recursive: true });
    }

    const manifest = npmRun(home, ['pkg', 'delete', 'scripts', 'devDependencies'], tree);
    expect(manifest.status).toBe(0);
    cpSync(join(tree, 'npm-readme.md'), join(tree, 'README.md'));

    const packed = npmRun(home, ['pack', '--json', '--pack-destination', dir], tree);
    expect(packed.status).toBe(0);
    const report = JSON.parse(packed.stdout)[0];
    const tarball = join(dir, report.filename);

    // The published manifest is the step's: no repository-only keys.
    const published = JSON.parse(spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }).stdout);
    expect(published.scripts).toBeUndefined();
    expect(published.devDependencies).toBeUndefined();

    // One readme, under the name npm shows, and it is the short one.
    const paths: string[] = (report.files as { path: string }[]).map((file) => file.path);
    expect(paths.filter((path) => /readme/i.test(path))).toEqual(['README.md']);
    const packedReadme = spawnSync('tar', ['-xzOf', tarball, 'package/README.md'], { encoding: 'utf8' }).stdout;
    expect(packedReadme).toBe(readFileSync(join(repo, 'npm-readme.md'), 'utf8'));
    expect(packedReadme).not.toBe(readFileSync(join(repo, 'README.md'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

test('what ships today: a pack of the tree as it is lists README.md and not npm-readme.md', () => {
  // The today-half of the rehearsal above: 0.3.0's release workflow packs the tree as it
  // is, npm always packs README.md, and npm-readme.md is not in `files` — so this
  // release's npm page shows the long README, and the short one only once a later release
  // adds the copy step. Like the rehearsal, the call runs offline in a temporary home of
  // this test's own: no machine npm state is read or written and no network is touched.
  const home = mkdtempSync(join(tmpdir(), 'team-pack-home-'));
  try {
    const result = npmRun(home, ['pack', '--dry-run', '--json'], repo);
    expect(result.status).toBe(0);
    const paths: string[] = (JSON.parse(result.stdout)[0]?.files ?? []).map((file: { path: string }) => file.path);
    expect(paths).toContain('README.md');
    expect(paths).not.toContain('npm-readme.md');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
