import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function run(tarball: string, expected?: string): { status: number | null; output: string } {
  // The hosted run sets GITHUB_SHA; a fixture tarball is not that commit, so
  // clear it unless the test supplies the expected source itself.
  const result = spawnSync('bun', ['scripts/check-pack.ts', tarball, ...(expected === undefined ? [] : [expected])], {
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
  const result = run(tarball);
  expect(result.status).toBe(0);
  expect(result.output).toContain('no internal ticket reference');
});

test('a tarball with a reference exits 1, naming the file and not the reference', () => {
  const id = reference(999998);
  const tarball = fixture({
    'package.json': `{"name":"team","version":"0.0.0","gitHead":"${STAMP}"}\n`,
    'dist/notes.md': `fixed in ${id}\n`,
  });
  const result = run(tarball);
  expect(result.status).toBe(1);
  expect(result.output).toContain('package/dist/notes.md');
  expect(result.output).not.toContain(id);
});

test('a tarball without a source stamp exits 1', () => {
  const tarball = fixture({
    'package.json': '{"name":"team","version":"0.0.0"}\n',
    'dist/cli.js': 'console.log("team");\n',
  });
  const result = run(tarball);
  expect(result.status).toBe(1);
  expect(result.output).toContain('no source stamp');
});

test('a stamp that is not the expected commit exits 1, naming both', () => {
  const tarball = fixture({
    'package.json': `{"name":"team","version":"0.0.0","gitHead":"${STAMP}"}\n`,
    'dist/cli.js': 'console.log("team");\n',
  });
  const result = run(tarball, OTHER);
  expect(result.status).toBe(1);
  expect(result.output).toContain(STAMP);
  expect(result.output).toContain(OTHER);
});

test('a stamp that is the expected commit passes', () => {
  const tarball = fixture({
    'package.json': `{"name":"team","version":"0.0.0","gitHead":"${STAMP}"}\n`,
    'dist/cli.js': 'console.log("team");\n',
  });
  const result = run(tarball, STAMP);
  expect(result.status).toBe(0);
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
