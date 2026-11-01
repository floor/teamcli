// The pre-push corpus and the diff check, over synthetic repositories. Every value is built at
// runtime; the real external lists are never read.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { privateDiffCorpus } from '../src/check/private-names.ts';

const ROOT = join(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts', 'check-private-diff.ts');

const SECRET = ['qw', 'rtz', '-', 'diff', 'secret'].join('');
const OTHER = ['qw', 'rtz', '-', 'diff', 'other'].join('');
const WORD = ['qw', 'rtz', '-', 'diff', 'word'].join('');

const dirs: string[] = [];
const emptyHome = mkdtempSync(join(tmpdir(), 'private-diff-home-'));

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(emptyHome, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'private-diff-'));
  dirs.push(dir);
  return dir;
}

function env(dir: string): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Synthetic',
    GIT_AUTHOR_EMAIL: 'synthetic@example.test',
    GIT_COMMITTER_NAME: 'Synthetic',
    GIT_COMMITTER_EMAIL: 'synthetic@example.test',
  };
}

function git(dir: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: env(dir) });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function repo(files: Record<string, string>, message: string): { dir: string; sha: string } {
  const dir = temp();
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  write(dir, files);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', message]);
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']).trim() };
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function commit(dir: string, message: string): string {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** A commit object written literally, so its message can hold a NUL byte that `git commit`
 *  refuses; the object, and so the message, is stored as written. */
function literalCommit(dir: string, parent: string, message: string): string {
  const tree = git(dir, ['rev-parse', `${parent}^{tree}`]).trim();
  const object = [
    `tree ${tree}`,
    `parent ${parent}`,
    'author Synthetic <synthetic@example.test> 1700000000 +0000',
    'committer Synthetic <synthetic@example.test> 1700000000 +0000',
    '',
    message,
  ].join('\n');
  const written = spawnSync('git', ['hash-object', '--literally', '-t', 'commit', '-w', '--stdin'], {
    cwd: dir,
    encoding: 'utf8',
    env: env(dir),
    input: object,
  });
  if (written.status !== 0) throw new Error(`git hash-object: ${written.stderr}`);
  const sha = written.stdout.trim();
  git(dir, ['update-ref', 'HEAD', sha]);
  return sha;
}

function listFile(contents: string): string {
  const path = join(temp(), 'private.txt');
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

function run(dir: string, args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: emptyHome, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

describe('privateDiffCorpus', () => {
  test('reads added lines and commit messages, never a removed line', () => {
    const base = repo({ 'keep.txt': `intro\n${SECRET}\n` }, 'base');
    write(base.dir, { 'keep.txt': 'intro\nclean\n', 'notes/added.txt': `first\n${OTHER}\n` });
    const head = commit(base.dir, 'head one');
    const built = privateDiffCorpus(base.dir, base.sha);
    expect('problem' in built).toBe(false);
    if ('problem' in built) return;
    expect(built.corpus.lines).not.toContain(SECRET);
    expect(built.corpus.lines).toContain('clean');
    expect(built.corpus.lines).toContain(OTHER);
    expect(built.corpus.lines).toContain('head one');
    expect(built.corpus.where[built.corpus.lines.indexOf('clean')]).toBe('keep.txt:2');
    expect(built.corpus.where[built.corpus.lines.indexOf(OTHER)]).toBe('notes/added.txt:2');
    expect(built.corpus.where[built.corpus.lines.indexOf('head one')]).toBe(`commit:${head}:1`);
  });
});

describe('the diff check command', () => {
  test('an added line fails with the location, source, class and ordinal, never the value', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    write(base.dir, { 'notes/hit.txt': `${SECRET}\n` });
    commit(base.dir, 'add a line');
    const result = run(base.dir, ['--base', base.sha, '--private-names', listFile(`${SECRET}\n`)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('notes/hit.txt:1');
    expect(result.stderr).toContain('private names entry 1');
    expect(result.stderr).not.toContain(SECRET);
  });

  test('a commit message is read and located as a commit line', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    write(base.dir, { 'keep.txt': 'clean\nmore\n' });
    const head = commit(base.dir, `subject\n\nbody ${SECRET}`);
    const result = run(base.dir, ['--base', base.sha, '--private-names', listFile(`${SECRET}\n`)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`commit:${head}:3`);
    expect(result.stderr).not.toContain(SECRET);
  });

  test('a NUL in a raw commit message does not hide the line after it', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    const head = literalCommit(base.dir, base.sha, `subject\n\u0000tail ${SECRET}`);
    const result = run(base.dir, ['--base', base.sha, '--private-names', listFile(`${SECRET}\n`)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`commit:${head}:2`);
    expect(result.stderr).not.toContain(SECRET);
  });

  test('a removed line is not scanned and a clean diff exits 0', () => {
    const base = repo({ 'keep.txt': `${SECRET}\n` }, 'base');
    write(base.dir, { 'keep.txt': 'clean\n' });
    commit(base.dir, 'remove the line');
    const result = run(base.dir, ['--base', base.sha, '--private-names', listFile(`${SECRET}\n`)]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('carry no private name');
    expect(result.stdout).not.toContain(SECRET);
  });

  test('a diff-only class is scanned in the diff, a path-only class is not', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    write(base.dir, { 'notes/added.txt': `${OTHER}\n${WORD}\n` });
    commit(base.dir, 'add lines');
    const diffOnly = listFile(`# class: c pane; scope=diff\n${OTHER}\n`);
    const onlyOther = run(base.dir, ['--base', base.sha, '--private-names', diffOnly]);
    expect(onlyOther.status).toBe(1);
    expect(onlyOther.stderr).toContain('notes/added.txt:1');

    const pathOnly = listFile(`# class: c pane; scope=path,content\n${WORD}\n`);
    const onlyWord = run(base.dir, ['--base', base.sha, '--private-names', pathOnly]);
    expect(onlyWord.status).toBe(0);
  });

  test('an unsupported escape and a missing named list are refusals', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    write(base.dir, { 'keep.txt': 'clean\nmore\n' });
    commit(base.dir, 'more');
    const unsupported = run(base.dir, [
      '--base',
      base.sha,
      '--private-names',
      listFile(`# class: a names\n${SECRET}\\bword\n`),
    ]);
    expect(unsupported.status).toBe(2);
    expect(unsupported.stderr).toContain('names class a entry 1');
    expect(unsupported.stderr).not.toContain(SECRET);

    const missing = run(base.dir, ['--base', base.sha, '--private-names', join(base.dir, 'absent.txt')]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('private list not present');
  });

  test('both default lists absent is a visible skip, not a failure', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    write(base.dir, { 'keep.txt': 'clean\nmore\n' });
    commit(base.dir, 'more');
    const result = run(base.dir, ['--base', base.sha]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('skipped');
    expect(result.stdout).toContain('names private list not present');
  });
});
