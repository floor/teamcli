// The tarball must name the commit it was built from. The 0.5.3-hotfix.25
// build is the case this pins: its version was edited in the working tree and
// never committed, so the artifact's source could not be recovered afterwards.
// These scenes run `scripts/pack.ts` in scratch git repositories and check the
// refusals and the stamp.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..', '..');
const areas: string[] = [];

function area(): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-pack-stamp-'));
  areas.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of areas.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A committed probe package: a build script that writes dist/, a tracked file, a schema. */
function project(): string {
  const root = join(area(), 'repo');
  mkdirSync(join(root, 'schema'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'probe',
        version: '1.0.0',
        bin: { team: 'dist/cli.js' },
        files: ['dist', 'a.txt', 'schema'],
        scripts: { build: 'node build.js' },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, 'build.js'),
    "require('fs').mkdirSync('dist', { recursive: true });\nrequire('fs').writeFileSync('dist/cli.js', 'built\\n');\n",
  );
  writeFileSync(join(root, 'a.txt'), 'a\n');
  writeFileSync(join(root, 'schema', 'x.json'), '{}\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\ndist/\n');
  const git = (...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=p@probe', ...args], { cwd: root, encoding: 'utf8' });
  expect(git('init', '-q').status).toBe(0);
  expect(git('add', '-A').status).toBe(0);
  expect(git('commit', '-qm', 'one').status).toBe(0);
  return root;
}

/** Runs the pack with its own temporary npm home, so no machine npm state is read or written. */
function run(root: string, out: string) {
  const home = join(area(), 'home');
  mkdirSync(home, { recursive: true });
  const result = spawnSync('bun', [join(repo, 'scripts', 'pack.ts'), '--pack-destination', out], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      npm_config_userconfig: join(home, 'npmrc'),
      npm_config_cache: join(home, 'cache'),
      npm_config_prefix: join(home, 'prefix'),
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
  });
  return { status: result.status, stdout: result.stdout, output: `${result.stdout}${result.stderr}` };
}

test('a clean tree packs with the commit as gitHead and writes the stamp', () => {
  const root = project();
  const out = join(area(), 'out');
  const result = run(root, out);
  expect(result.status).toBe(0);

  // The report is one machine-readable line on stdout, whatever the build printed.
  const lines = result.stdout.trim().split('\n');
  expect(lines.length).toBe(1);
  const stamp = JSON.parse(lines[0] as string) as { tarball: string; version: string; gitHead: string; sha256: string; bytes: number };
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  expect(stamp.gitHead).toBe(head);
  expect(stamp.version).toBe('1.0.0');

  const tarball = join(out, stamp.tarball);
  expect(existsSync(`${tarball}.stamp.json`)).toBe(true);
  const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  expect(stamp.sha256).toBe(sha256);

  const packed = JSON.parse(spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }).stdout) as {
    version: string;
    gitHead: string;
  };
  expect(packed.version).toBe('1.0.0');
  expect(packed.gitHead).toBe(head);

  const members = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).stdout;
  expect(members).toContain('package/dist/cli.js');
  expect(members).toContain('package/a.txt');
  expect(members).toContain('package/schema/x.json');

  // The tracked manifest was not left altered by the stamp.
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
  expect(status.trim()).toBe('');
}, 30_000);

test('an uncommitted version bump refuses (the .25 case)', () => {
  const root = project();
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  manifest.version = '1.0.1';
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const out = join(area(), 'out');
  const result = run(root, out);
  expect(result.status).toBe(2);
  expect(result.output).toContain('is not committed at HEAD');
  expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
}, 30_000);

test('a changed working tree refuses', () => {
  const root = project();
  writeFileSync(join(root, 'a.txt'), 'changed\n');
  const result = run(root, join(area(), 'out'));
  expect(result.status).toBe(2);
  expect(result.output).toContain('working tree has changes');
}, 30_000);
