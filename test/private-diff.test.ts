// The pre-push corpus and the diff check, over synthetic repositories. Every value is built at
// runtime; the real external lists are never read.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { privateDiffCorpus } from '../src/check/private-names.ts';

const ROOT = join(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts', 'check-private-diff.ts');

const SECRET = ['qw', 'rtz', '-', 'diff', 'secret'].join('');
const OTHER = ['qw', 'rtz', '-', 'diff', 'other'].join('');
const WORD = ['qw', 'rtz', '-', 'diff', 'word'].join('');
const FLO_ID = ['FL', 'O-', '11', '90'].join('');
const OD_ID = ['O', 'D-', '20261105-1'].join('');
const CUSTOM_ID = ['AC', 'ME-', '42'].join('');
const SIGNATURE = 'Agent: Claude Opus 5.5 · implementer';
const HUMAN_EMAIL = 'synthetic-owner@example.test';

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

function env(dir: string, authorEmail = 'synthetic@example.test'): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Synthetic',
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: 'Synthetic',
    GIT_COMMITTER_EMAIL: authorEmail,
  };
}

function git(dir: string, args: string[], authorEmail?: string): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: env(dir, authorEmail) });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function repo(files: Record<string, string>, message: string): { dir: string; sha: string; ref: string } {
  const dir = temp();
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  write(dir, files);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', `${message}\n\n${SIGNATURE}`]);
  const sha = git(dir, ['rev-parse', 'HEAD']).trim();
  const ref = 'v0.0.0-fixture';
  git(dir, ['tag', ref, sha]);
  git(dir, ['update-ref', 'refs/remotes/origin/main', sha]);
  return { dir, sha, ref };
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function commit(
  dir: string,
  message: string,
  options: { signed?: boolean; authorEmail?: string } = {},
): string {
  const full = options.signed === false ? message : `${message}\n\n${SIGNATURE}`;
  git(dir, ['add', '-A'], options.authorEmail);
  git(dir, ['commit', '--quiet', '--allow-empty', '-m', full], options.authorEmail);
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
    const built = privateDiffCorpus(base.dir, base.ref);
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

describe('byte-identical moves in the diff check', () => {
  function moved(before: string | Buffer = `${SECRET}\n`, after: string | Buffer = before) {
    const base = repo({ 'old.txt': 'placeholder\n' }, 'base');
    writeFileSync(join(base.dir, 'old.txt'), before);
    const sha = commit(base.dir, 'store synthetic base');
    git(base.dir, ['update-ref', `refs/tags/${base.ref}`, sha]);
    git(base.dir, ['update-ref', 'refs/remotes/origin/main', sha]);
    git(base.dir, ['rm', '--quiet', '--', 'old.txt']);
    writeFileSync(join(base.dir, 'new.txt'), after);
    return { ...base, sha };
  }
  const notice = (count: number) => `private diff: treated ${count} line(s) as moves (identical line removed in this diff)`;

  test('a moved private line passes and prints its count and location without its value', () => {
    const base = moved();
    commit(base.dir, 'move synthetic line');
    const result = run(base.dir, ['--base', base.ref, '--private-names', listFile(`${SECRET}\n`)]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(notice(1));
    expect(result.stdout).toContain('private diff: moved new.txt:1 (1 rule hit(s))');
    expect(result.stdout + result.stderr).not.toContain(SECRET);
  }, 30_000);

  test('an added hit without a removed twin remains a refusal', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    write(base.dir, { 'new.txt': `${SECRET}\n` });
    commit(base.dir, 'add synthetic line');
    const result = run(base.dir, ['--base', base.ref, '--private-names', listFile(`${SECRET}\n`)]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(notice(0));
    expect(result.stderr).toContain('new.txt:1');
  }, 30_000);

  test('an unchanged tracked twin does not count as a removed line', () => {
    const base = repo({ 'keep.txt': `${SECRET}\n` }, 'base');
    write(base.dir, { 'new.txt': `${SECRET}\n` });
    commit(base.dir, 'copy synthetic line');
    const result = run(base.dir, ['--base', base.ref, '--private-names', listFile(`${SECRET}\n`)]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(notice(0));
  }, 30_000);

  for (const twin of ['untracked', 'ignored', 'outside'] as const) {
    test(`a twin only in an ${twin} file cannot hide an added hit`, () => {
      const base = repo({ 'keep.txt': 'clean\n', '.gitignore': 'ignored/\n' }, 'base');
      const path = twin === 'outside' ? join(temp(), 'twin.txt') : join(base.dir, twin === 'ignored' ? 'ignored/twin.txt' : 'untracked.txt');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${SECRET}\n`);
      write(base.dir, { 'new.txt': `${SECRET}\n` });
      // Stage only the tested addition. The twin never becomes a tracked diff source.
      git(base.dir, ['add', '--', 'new.txt']);
      git(base.dir, ['commit', '--quiet', '-m', `add synthetic line\n\n${SIGNATURE}`]);
      const corpus = privateDiffCorpus(base.dir, base.ref);
      expect('problem' in corpus).toBe(false);
      if ('problem' in corpus) return;
      expect(corpus.corpus.moves).toEqual([]);
      const result = run(base.dir, ['--base', base.ref, '--private-names', listFile(`${SECRET}\n`)]);
      expect(result.status).toBe(twin === 'untracked' ? 2 : 1);
      if (twin === 'untracked') expect(result.stderr).toContain('working tree is dirty');
      else {
        expect(result.stdout).toContain(notice(0));
        expect(result.stderr).toContain('new.txt:1');
      }
    }, 30_000);
  }

  for (const [name, before, after] of [
    ['one added byte', `${SECRET}\n`, `${SECRET}!\n`],
    ['different indentation', ` ${SECRET}\n`, `${SECRET}\n`],
    ['different line endings', `${SECRET}\r\n`, `${SECRET}\n`],
    ['different final newline', `${SECRET}\n`, SECRET],
    ['different invalid bytes', Buffer.concat([Buffer.from(SECRET), Buffer.from([0xff, 10])]), Buffer.concat([Buffer.from(SECRET), Buffer.from([0xfe, 10])])],
    ['an added NUL byte', `${SECRET}\n`, `${SECRET}\0\n`],
  ] as const) {
    test(`${name} is not a byte-identical move`, () => {
      const base = moved(before, after);
      commit(base.dir, 'change synthetic bytes');
      const result = run(base.dir, ['--base', base.ref, '--private-names', listFile(`${SECRET}\n`)]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(notice(0));
      expect(result.stderr).toContain('new.txt:1');
    }, 30_000);
  }

  test('two added copies consume one removed twin only once', () => {
    const base = moved();
    write(base.dir, { 'second.txt': `${SECRET}\n` });
    commit(base.dir, 'move and duplicate synthetic line');
    const result = run(base.dir, ['--base', base.ref, '--private-names', listFile(`${SECRET}\n`)]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(notice(1));
    expect(result.stdout).toContain('moved new.txt:1');
    expect(result.stderr).toContain('second.txt:1');
  }, 30_000);

  test('one moved line matching two private rules consumes one twin and reports both hits', () => {
    const base = moved(`${SECRET} ${WORD}\n`);
    commit(base.dir, 'move synthetic pair');
    const result = run(base.dir, ['--base', base.ref, '--private-names', listFile(`${SECRET}\n${WORD}\n`)]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(notice(1));
    expect(result.stdout).toContain('new.txt:1 (2 rule hit(s))');
  }, 30_000);

  test('a matching commit-message line is refused even while its file twin moves', () => {
    const base = moved();
    const head = commit(base.dir, `move synthetic line\n\n${SECRET}`);
    const result = run(base.dir, ['--base', base.ref, '--private-names', listFile(`${SECRET}\n`)]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(notice(1));
    expect(result.stderr).toContain(`commit:${head}:3`);
    expect(result.stderr).not.toContain('new.txt:1');
  }, 30_000);
});

describe('committed ranges and public bases', () => {
  test('a committed hit remains in the corpus after an uncommitted reversion, which the wrapper refuses', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    write(base.dir, { 'keep.txt': `${SECRET}\n` });
    commit(base.dir, 'add synthetic line');
    write(base.dir, { 'keep.txt': 'clean\n' });
    const built = privateDiffCorpus(base.dir, base.ref);
    expect('problem' in built).toBe(false);
    if ('problem' in built) return;
    expect(built.corpus.lines).toContain(SECRET);
    expect(built.corpus.where[built.corpus.lines.indexOf(SECRET)]).toBe('keep.txt:1');
    const names = listFile(`${SECRET}\n`);
    const dirty = run(base.dir, ['--base', base.ref, '--private-names', names]);
    expect(dirty.status).toBe(2);
    expect(dirty.stderr).toContain('working tree is dirty');
    expect(dirty.stderr).toContain('dirty "keep.txt"');
    expect(dirty.stdout + dirty.stderr).not.toContain(SECRET);
    write(base.dir, { 'keep.txt': `${SECRET}\n` });
    const clean = run(base.dir, ['--base', base.ref, '--private-names', names]);
    expect(clean.status).toBe(1);
    expect(clean.stderr).toContain('keep.txt:1');
  }, 30_000);

  for (const kind of ['staged', 'unstaged', 'untracked'] as const) {
    test(`the wrapper refuses ${kind} changes even when default lists are absent`, () => {
      const base = repo({ 'keep.txt': 'clean\n' }, 'base');
      const path = kind === 'untracked' ? 'loose.txt' : 'keep.txt';
      write(base.dir, { [path]: `${SECRET}\n` });
      if (kind === 'staged') git(base.dir, ['add', '--', 'keep.txt']);
      const result = run(base.dir, ['--base', base.ref]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('working tree is dirty');
      expect(result.stdout).not.toContain('skipped');
      expect(result.stderr).toContain(`dirty ${JSON.stringify(path)}`);
      expect(result.stdout + result.stderr).not.toContain(SECRET);
    });
  }

  test('ignored dependencies and build output do not make the wrapper refuse a clean tree', () => {
    const base = repo({ 'keep.txt': 'clean\n', '.gitignore': 'node_modules/\ndist/\n' }, 'base');
    write(base.dir, { 'node_modules/fixture.txt': `${SECRET}\n`, 'dist/output.txt': `${SECRET}\n` });
    const result = run(base.dir, ['--base', base.ref]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('skipped');
    expect(result.stderr).not.toContain('dirty');
    expect(result.stdout + result.stderr).not.toContain(SECRET);
  });

  test('dirty rename diagnostics escape both paths and never print file contents', () => {
    const oldPath = 'old name.txt';
    const newPath = 'new\nname.txt';
    const base = repo({ [oldPath]: `${SECRET}\n` }, 'base');
    git(base.dir, ['mv', '--', oldPath, newPath]);
    const result = run(base.dir, ['--base', base.ref]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`dirty ${JSON.stringify(oldPath)}`);
    expect(result.stderr).toContain(`dirty ${JSON.stringify(newPath)}`);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
  });

  test('a removed twin in an arbitrary private base cannot authorize a move', () => {
    const base = repo({ 'old.txt': `${SECRET}\n` }, 'base');
    git(base.dir, ['branch', 'private-base', base.sha]);
    git(base.dir, ['branch', 'v-private-branch', base.sha]);
    git(base.dir, ['tag', 'not-a-release', base.sha]);
    git(base.dir, ['rm', '--quiet', '--', 'old.txt']);
    write(base.dir, { 'new.txt': `${SECRET}\n` });
    commit(base.dir, 'move synthetic line');
    const names = listFile(`${SECRET}\n`);
    for (const ref of [base.sha, 'HEAD~1', 'private-base', 'refs/heads/private-base', 'v-private-branch', 'not-a-release', `${base.ref}^0`]) {
      const built = privateDiffCorpus(base.dir, ref);
      expect('problem' in built).toBe(true);
      const result = run(base.dir, ['--base', ref, '--private-names', names]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('public release tag (v*)');
      expect(result.stdout).not.toContain('treated 1 line(s) as moves');
      expect(result.stdout + result.stderr).not.toContain(SECRET);
    }
  }, 30_000);

  test('a tag on a local-only commit cannot authorize a removed twin', () => {
    const base = repo({ 'old.txt': 'clean\n' }, 'base');
    write(base.dir, { 'old.txt': `${SECRET}\n` });
    commit(base.dir, 'store synthetic line locally');
    git(base.dir, ['tag', 'v0.9.9-local']);
    git(base.dir, ['rm', '--quiet', '--', 'old.txt']);
    write(base.dir, { 'new.txt': `${SECRET}\n` });
    commit(base.dir, 'move synthetic line');
    const names = listFile(`${SECRET}\n`);
    const local = run(base.dir, ['--base', 'v0.9.9-local', '--private-names', names]);
    expect(local.status).toBe(2);
    expect(local.stderr).toContain('tag base must be an ancestor of refs/remotes/origin/main');
    expect(local.stdout).not.toContain('treated 1 line(s) as moves');
    expect(local.stdout + local.stderr).not.toContain(SECRET);
    for (const ref of ['origin/main', base.ref]) {
      const publicRange = run(base.dir, ['--base', ref, '--private-names', names]);
      expect(publicRange.status).toBe(1);
      expect(publicRange.stderr).toContain('new.txt:1');
    }
  }, 30_000);

  test('a tag without origin/main cannot establish a public base', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    git(base.dir, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const result = run(base.dir, ['--base', base.ref]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('tag base must be an ancestor of refs/remotes/origin/main');
  });

  test('public refs resolve explicitly even when a same-named branch points elsewhere', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    git(base.dir, ['update-ref', 'refs/remotes/origin/main', base.sha]);
    git(base.dir, ['tag', '-a', 'v0.0.1-fixture', '-m', 'synthetic release', base.sha]);
    write(base.dir, { 'keep.txt': `${SECRET}\n` });
    const head = commit(base.dir, 'add synthetic line');
    git(base.dir, ['branch', base.ref, head]);
    git(base.dir, ['branch', 'origin/main', head]);
    const names = listFile(`${SECRET}\n`);
    for (const ref of [base.ref, `refs/tags/${base.ref}`, 'v0.0.1-fixture', 'origin/main', 'refs/remotes/origin/main']) {
      const result = run(base.dir, ['--base', ref, '--private-names', names]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('keep.txt:1');
    }
  }, 30_000);
});

describe('the diff check command', () => {
  test('an added line fails with the location, source, class and ordinal, never the value', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    write(base.dir, { 'notes/hit.txt': `${SECRET}\n` });
    commit(base.dir, 'add a line');
    const result = run(base.dir, ['--base', base.ref, '--private-names', listFile(`${SECRET}\n`)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('notes/hit.txt:1');
    expect(result.stderr).toContain('private names entry 1');
    expect(result.stderr).not.toContain(SECRET);
  });

  test('a commit message is read and located as a commit line', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    write(base.dir, { 'keep.txt': 'clean\nmore\n' });
    const head = commit(base.dir, `subject\n\nbody ${SECRET}`);
    const result = run(base.dir, ['--base', base.ref, '--private-names', listFile(`${SECRET}\n`)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`commit:${head}:3`);
    expect(result.stderr).not.toContain(SECRET);
  });

  test('internal seat-id tokens in commit bodies are refused without printing them', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    let before = base.sha;
    for (const token of [
      ['builder', '7'].join('-'),
      ['operator', '2'].join('-'),
      ['tester', '3'].join('-'),
      ['reviewer', 'sample'].join('-'),
      ['REVIEWER', 'SAMPLE', 'LAB'].join('-'),
      ['tester', '3', 'independent'].join('-'),
      ['builder', '1', 'owned'].join('-'),
      `briefs/${['tester', '3', 'notes.md'].join('-')}`,
      ['co', 'operator', '1'].join('-'),
      ['pre', 'reviewer', 'sample'].join('-'),
      ['reviewer', 'requested', '2'].join('-'),
      ['operator', '12'].join('-'),
    ]) {
      const head = commit(base.dir, `test: a neutral subject\n\nThe reviewer-requested proof was checked by ${token}'s scene.`);
      git(base.dir, ['update-ref', `refs/tags/${base.ref}`, before]);
      git(base.dir, ['update-ref', 'refs/remotes/origin/main', before]);
      const result = run(base.dir, ['--base', base.ref]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`commit:${head}:3`);
      expect(result.stderr).toContain('commit message names an internal seat');
      expect(result.stdout + result.stderr).not.toContain(token);
      before = head;
    }
  }, 30_000);

  test('review-role prose from release messages and ordinary continuations is allowed', () => {
    const bodies = [
      'Add the reviewer-requested three lines only under Unreleased: checked state publication, owner-only modes for the three changed file families, and declared-link-root refusal with ancestor-alias handling. Historical release sections remain byte-identical. No package version or release timestamp changes.',
      'The reviewer-approved wording remains unchanged.',
      'Keep the reviewer-side notes separate.',
      'The Reviewer-Side and Reviewer-Requested wording stays.',
    ];
    for (const body of bodies) {
      const base = repo({ 'keep.txt': 'clean\n' }, 'base');
      commit(base.dir, `docs(release): record guarded state writes and permission changes\n\n${body}`);
      const result = run(base.dir, ['--base', base.ref]);
      expect(result.status).toBe(0);
    }
  });

  test('ordinary role prose and tokens containing a longer word are allowed in commit bodies', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    const embedded = ['preoperator', '2'].join('-');
    const longer = ['operator', '2word'].join('-');
    commit(base.dir, `test: ordinary role prose\n\nAn operator-only check helps the builder and reviewer. ${embedded}, ${longer}, ${['x_operator', '1'].join('-')}, and operator 2 are unrelated words.`);
    const result = run(base.dir, ['--base', base.ref]);
    expect(result.status).toBe(0);
  });

  test('a NUL in a raw commit message does not hide the line after it', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    const head = literalCommit(base.dir, base.sha, `subject\n\u0000tail ${SECRET}`);
    const result = run(base.dir, ['--base', base.ref, '--private-names', listFile(`${SECRET}\n`)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`commit:${head}:2`);
    expect(result.stderr).not.toContain(SECRET);
  });

  test('a NUL in an added file does not hide its line', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    write(base.dir, { 'notes/nul.txt': `before\u0000${SECRET}\n` });
    commit(base.dir, 'add a NUL-bearing file');
    const result = run(base.dir, ['--base', base.ref, '--private-names', listFile(`${SECRET}\n`)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('notes/nul.txt:1');
    expect(result.stderr).not.toContain(SECRET);
  });

  test('a removed line is not scanned and a clean diff exits 0', () => {
    const base = repo({ 'keep.txt': `${SECRET}\n` }, 'base');
    write(base.dir, { 'keep.txt': 'clean\n' });
    commit(base.dir, 'remove the line');
    const result = run(base.dir, ['--base', base.ref, '--private-names', listFile(`${SECRET}\n`)]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('carry no private name');
    expect(result.stdout).not.toContain(SECRET);
  });

  test('a diff-only class is scanned in the diff, a path-only class is not', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    write(base.dir, { 'notes/added.txt': `${OTHER}\n${WORD}\n` });
    commit(base.dir, 'add lines');
    const diffOnly = listFile(`# class: c pane; scope=diff\n${OTHER}\n`);
    const onlyOther = run(base.dir, ['--base', base.ref, '--private-names', diffOnly]);
    expect(onlyOther.status).toBe(1);
    expect(onlyOther.stderr).toContain('notes/added.txt:1');

    const pathOnly = listFile(`# class: c pane; scope=path,content\n${WORD}\n`);
    const onlyWord = run(base.dir, ['--base', base.ref, '--private-names', pathOnly]);
    expect(onlyWord.status).toBe(0);
  });

  test('an unsupported escape and a missing named list are refusals', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    write(base.dir, { 'keep.txt': 'clean\nmore\n' });
    commit(base.dir, 'more');
    const unsupported = run(base.dir, [
      '--base',
      base.ref,
      '--private-names',
      listFile(`# class: a names\n${SECRET}\\bword\n`),
    ]);
    expect(unsupported.status).toBe(2);
    expect(unsupported.stderr).toContain('names class a entry 1');
    expect(unsupported.stderr).not.toContain(SECRET);

    const missing = run(base.dir, ['--base', base.ref, '--private-names', join(base.dir, 'absent.txt')]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('private list not present');
  });

  test('both default lists absent is a visible skip, not a failure', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    write(base.dir, { 'keep.txt': 'clean\nmore\n' });
    commit(base.dir, 'more');
    const result = run(base.dir, ['--base', base.ref]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('skipped');
    expect(result.stdout).toContain('names private list not present');
  });

  test('a tracker id in a commit message is a hit, for FLO and every other tracker key in the rules', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    const floCommit = commit(base.dir, `test(codex): add scenes\n\nFive scenes for the ${FLO_ID} lane.`);
    const result = run(base.dir, ['--base', base.ref]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`commit:${floCommit}:3`);
    expect(result.stdout + result.stderr).not.toContain(FLO_ID);

    const customTeam = join(temp(), 'team.yaml');
    const baseYaml = readFileSync(join(ROOT, '.github', 'policy.yaml'), 'utf8');
    writeFileSync(
      customTeam,
      baseYaml.replace(
        '  forbidden_public:\n',
        '  forbidden_public:\n    - "\\\\bACME-[0-9]+\\\\b"\n    - "\\\\bOD-(?:20[0-9]{6}-)?[0-9]+\\\\b"\n',
      ),
    );
    const customBase = repo({ 'keep.txt': 'clean\n' }, 'base');
    const customCommit = commit(customBase.dir, `feat: add ${CUSTOM_ID} coverage`);
    const odCommit = commit(customBase.dir, `fix(policy): apply rule\n\nPer ${OD_ID} decision.`);
    const customResult = run(customBase.dir, ['--base', customBase.ref, '--file', customTeam]);
    expect(customResult.status).toBe(1);
    expect(customResult.stderr).toContain(`commit:${customCommit}:1`);
    expect(customResult.stderr).toContain(`commit:${odCommit}:3`);
    expect(customResult.stdout + customResult.stderr).not.toContain(CUSTOM_ID);
    expect(customResult.stdout + customResult.stderr).not.toContain(OD_ID);
  });

  test('a commit without the Agent signature trailer is a hit unless it is a merge or human-authored', () => {
    const humanTeam = join(temp(), 'team.yaml');
    const teamYaml = readFileSync(join(ROOT, '.github', 'policy.yaml'), 'utf8');
    const syntheticHumans = teamYaml.replace(/(  humans:\n)(?:    - [^\n]*\n)+/, `$1    - ${HUMAN_EMAIL}\n`);
    if (syntheticHumans === teamYaml) throw new Error('synthetic human allowlist was not installed');
    writeFileSync(humanTeam, syntheticHumans);
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    const unsigned = commit(base.dir, 'fix(init): check the folder an approval change targets', { signed: false });
    const missing = run(base.dir, ['--base', base.ref, '--file', humanTeam]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`commit:${unsigned}`);
    expect(missing.stderr).toContain('no signature');

    // Reset to base and verify human-authored and merge exemptions match `team commits check`.
    git(base.dir, ['reset', '--hard', base.sha]);
    commit(base.dir, 'docs: owner note', { signed: false, authorEmail: HUMAN_EMAIL.toUpperCase() });
    git(base.dir, ['switch', '--quiet', '-c', 'side', base.sha]);
    write(base.dir, { 'side.txt': 'side\n' });
    commit(base.dir, 'feat: side branch');
    git(base.dir, ['switch', '--quiet', 'main']);
    git(base.dir, ['merge', '--quiet', '--no-ff', '--no-gpg-sign', '-m', 'Merge branch side', 'side']);
    const exemptClean = run(base.dir, ['--base', base.ref, '--file', humanTeam]);
    expect(exemptClean.status).toBe(0);

    // A human-authored or merge commit that carries a tracker id is still refused.
    const humanTracker = commit(base.dir, `docs: ${FLO_ID} note`, { signed: false, authorEmail: HUMAN_EMAIL });
    const refusedHuman = run(base.dir, ['--base', base.ref, '--file', humanTeam]);
    expect(refusedHuman.status).toBe(1);
    expect(refusedHuman.stderr).toContain(`commit:${humanTracker}:1`);
    expect(refusedHuman.stdout + refusedHuman.stderr).not.toContain(FLO_ID);
  });

  test('--release scans public history and rejects an arbitrary commit base', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    git(base.dir, ['update-ref', 'refs/remotes/origin/main', base.sha]);

    // An unsigned or tracker-bearing commit between origin/main and the lane base is caught by --release.
    const badEarlier = commit(base.dir, `test: ${FLO_ID} fixture`, { signed: false });
    const laneBase = commit(base.dir, 'chore: integration checkpoint');
    write(base.dir, { 'lane.txt': 'clean lane change\n' });
    commit(base.dir, 'feat: clean lane commit');

    const laneResult = run(base.dir, ['--base', laneBase]);
    expect(laneResult.status).toBe(2);
    expect(laneResult.stderr).toContain('base must be origin/main or an existing public release tag');

    const releaseResult = run(base.dir, ['--release']);
    expect(releaseResult.status).toBe(1);
    expect(releaseResult.stderr).toContain(`commit:${badEarlier}:1`);
    expect(releaseResult.stderr).toContain(`commit:${badEarlier}: no signature`);
    expect(releaseResult.stdout + releaseResult.stderr).not.toContain(FLO_ID);

    // Both --release and --base together is a usage refusal (exit 2).
    const both = run(base.dir, ['--release', '--base', laneBase]);
    expect(both.status).toBe(2);

    // When origin/main..HEAD is clean, --release exits 0.
    git(base.dir, ['update-ref', 'refs/remotes/origin/main', laneBase]);
    const cleanRelease = run(base.dir, ['--release', '--private-names', listFile(`${SECRET}\n`)]);
    expect(cleanRelease.status).toBe(0);
  });
});
