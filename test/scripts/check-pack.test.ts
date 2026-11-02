import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// This repository is public, so the reference the fixtures carry is assembled at
// runtime, never spelled here.
const reference = (ticket: number) => ['FLO', String(ticket)].join('-');
const repo = join(import.meta.dir, '..', '..');

// A fixture source stamp: any full 40-hex SHA. It is not a real commit.
const STAMP = '0123456789abcdef0123456789abcdef01234567';
const OTHER = '89abcdef0123456789abcdef0123456789abcdef';

const areas: string[] = [];

function area(): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-pack-test-'));
  areas.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of areas.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A tarball with `package/<name>` members, as npm packs them. */
function fixture(files: Record<string, string>): string {
  const staging = area();
  for (const [name, content] of Object.entries(files)) {
    const path = join(staging, 'package', name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const tarball = join(area(), 'fixture.tgz');
  const tar = spawnSync('tar', ['-czf', tarball, '-C', staging, 'package']);
  expect(tar.status).toBe(0);
  return tarball;
}

/** A wrapper manifest as `packages/teamcli/package.json` carries it: the version it publishes,
 *  and the `team` dependency at `dependsOn` (the same version unless a scene says otherwise). */
function wrapper(version: string, dependsOn: string | null = version): string {
  const path = join(area(), 'packages', 'teamcli', 'package.json');
  mkdirSync(dirname(path), { recursive: true });
  const manifest = {
    name: '@teamcli/cli',
    version,
    ...(dependsOn === null ? {} : { dependencies: { team: dependsOn } }),
  };
  writeFileSync(path, `${JSON.stringify(manifest)}\n`);
  return path;
}

function run(tarball: string, expected?: string, wrapperPath?: string): { status: number | null; output: string } {
  // The hosted run sets GITHUB_SHA; a fixture tarball is not that commit, so
  // clear it unless the test supplies the expected source itself.
  const result = spawnSync('bun', ['scripts/check-pack.ts', tarball, ...(expected === undefined ? [] : [expected]), ...(wrapperPath === undefined ? [] : ['--wrapper', wrapperPath])], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_SHA: '' },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('a clean stamped tarball passes', () => {
  const tarball = fixture({
    'package.json': `{"name":"team","version":"0.0.0","gitHead":"${STAMP}"}\n`,
    'dist/cli.js': 'console.log("team");\n',
  });
  const result = run(tarball, undefined, wrapper('0.0.0'));
  expect(result.status).toBe(0);
  expect(result.output).toContain('no internal ticket reference');
});

test('a tarball with a reference exits 1, naming the file and not the reference', () => {
  const id = reference(999998);
  const tarball = fixture({
    'package.json': `{"name":"team","version":"0.0.0","gitHead":"${STAMP}"}\n`,
    'dist/notes.md': `fixed in ${id}\n`,
  });
  const result = run(tarball, undefined, wrapper('0.0.0'));
  expect(result.status).toBe(1);
  expect(result.output).toContain('package/dist/notes.md');
  expect(result.output).not.toContain(id);
});

test('a tarball without a source stamp exits 1', () => {
  const tarball = fixture({
    'package.json': '{"name":"team","version":"0.0.0"}\n',
    'dist/cli.js': 'console.log("team");\n',
  });
  const result = run(tarball, undefined, wrapper('0.0.0'));
  expect(result.status).toBe(1);
  expect(result.output).toContain('no source stamp');
});

test('a stamp that is not the expected commit exits 1, naming both', () => {
  const tarball = fixture({
    'package.json': `{"name":"team","version":"0.0.0","gitHead":"${STAMP}"}\n`,
    'dist/cli.js': 'console.log("team");\n',
  });
  const result = run(tarball, OTHER, wrapper('0.0.0'));
  expect(result.status).toBe(1);
  expect(result.output).toContain(STAMP);
  expect(result.output).toContain(OTHER);
});

test('a stamp that is the expected commit passes', () => {
  const tarball = fixture({
    'package.json': `{"name":"team","version":"0.0.0","gitHead":"${STAMP}"}\n`,
    'dist/cli.js': 'console.log("team");\n',
  });
  const result = run(tarball, STAMP, wrapper('0.0.0'));
  expect(result.status).toBe(0);
});

test('a wrapper at the packed version depending on team at exactly that version passes', () => {
  const tarball = fixture({
    'package.json': `{"name":"team","version":"1.2.3","gitHead":"${STAMP}"}\n`,
    'dist/cli.js': 'console.log("team");\n',
  });
  const result = run(tarball, undefined, wrapper('1.2.3'));
  expect(result.status).toBe(0);
  expect(result.output).toContain('wrapper at its version');
});

test('a wrapper one release behind the packed version exits 1, naming both', () => {
  const tarball = fixture({
    'package.json': `{"name":"team","version":"1.2.3","gitHead":"${STAMP}"}\n`,
    'dist/cli.js': 'console.log("team");\n',
  });
  const result = run(tarball, undefined, wrapper('1.2.2'));
  expect(result.status).toBe(1);
  expect(result.output).toContain('packages/teamcli/package.json');
  expect(result.output).toContain('1.2.2');
  expect(result.output).toContain('1.2.3');
});

test('a wrapper whose team dependency is another version exits 1, naming both', () => {
  const tarball = fixture({
    'package.json': `{"name":"team","version":"1.2.3","gitHead":"${STAMP}"}\n`,
    'dist/cli.js': 'console.log("team");\n',
  });
  const result = run(tarball, undefined, wrapper('1.2.3', '1.2.2'));
  expect(result.status).toBe(1);
  expect(result.output).toContain('depends on team 1.2.2');
  expect(result.output).toContain('1.2.3');
});

test('a range in place of the exact version exits 1', () => {
  const tarball = fixture({
    'package.json': `{"name":"team","version":"1.2.3","gitHead":"${STAMP}"}\n`,
    'dist/cli.js': 'console.log("team");\n',
  });
  const result = run(tarball, undefined, wrapper('1.2.3', '^1.2.3'));
  expect(result.status).toBe(1);
  expect(result.output).toContain('depends on team ^1.2.3');
});

test('a wrapper that names no team dependency exits 1', () => {
  const tarball = fixture({
    'package.json': `{"name":"team","version":"1.2.3","gitHead":"${STAMP}"}\n`,
    'dist/cli.js': 'console.log("team");\n',
  });
  const result = run(tarball, undefined, wrapper('1.2.3', null));
  expect(result.status).toBe(1);
  expect(result.output).toContain('names no dependencies.team dependency');
});

test('a wrapper manifest that cannot be read exits 2', () => {
  const tarball = fixture({
    'package.json': `{"name":"team","version":"1.2.3","gitHead":"${STAMP}"}\n`,
    'dist/cli.js': 'console.log("team");\n',
  });
  const result = run(tarball, undefined, join(area(), 'absent', 'package.json'));
  expect(result.status).toBe(2);
  expect(result.output).toContain('cannot read the wrapper');
});

test('the checkout\'s own wrapper is read when no --wrapper is given', () => {
  // The repository is the release's own wrapper: a tarball at its committed version passes
  // against `packages/teamcli/package.json` with nothing handed in.
  const root = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string };
  const tarball = fixture({
    'package.json': `{"name":"team","version":"${root.version}","gitHead":"${STAMP}"}\n`,
    'dist/cli.js': 'console.log("team");\n',
  });
  const result = run(tarball);
  expect(result.status).toBe(0);
  expect(result.output).toContain('wrapper at its version');
});

test('a corrupt tarball exits 2', () => {
  const path = join(area(), 'corrupt.tgz');
  writeFileSync(path, 'not a tarball\n');
  const result = run(path);
  expect(result.status).toBe(2);
  expect(result.output).toContain('cannot extract');
});

test('a missing tarball exits 2', () => {
  const result = run(join(area(), 'absent.tgz'));
  expect(result.status).toBe(2);
  expect(result.output).toContain('cannot extract');
});
