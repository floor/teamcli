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
const HUMAN_EMAIL = 'drjones@floor.io';

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

function repo(files: Record<string, string>, message: string): { dir: string; sha: string } {
  const dir = temp();
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  write(dir, files);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', `${message}\n\n${SIGNATURE}`]);
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']).trim() };
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

  test('a NUL in an added file does not hide its line', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    write(base.dir, { 'notes/nul.txt': `before\u0000${SECRET}\n` });
    commit(base.dir, 'add a NUL-bearing file');
    const result = run(base.dir, ['--base', base.sha, '--private-names', listFile(`${SECRET}\n`)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('notes/nul.txt:1');
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

  test('a tracker id in a commit message is a hit, for FLO and every other tracker key in the rules', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    const floCommit = commit(base.dir, `test(codex): add scenes\n\nFive scenes for the ${FLO_ID} lane.`);
    const result = run(base.dir, ['--base', base.sha]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`commit:${floCommit}:3`);
    expect(result.stdout + result.stderr).not.toContain(FLO_ID);

    const customTeam = join(temp(), 'team.yaml');
    const baseYaml = readFileSync(join(ROOT, '.github', 'team.yaml'), 'utf8');
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
    const customResult = run(customBase.dir, ['--base', customBase.sha, '--file', customTeam]);
    expect(customResult.status).toBe(1);
    expect(customResult.stderr).toContain(`commit:${customCommit}:1`);
    expect(customResult.stderr).toContain(`commit:${odCommit}:3`);
    expect(customResult.stdout + customResult.stderr).not.toContain(CUSTOM_ID);
    expect(customResult.stdout + customResult.stderr).not.toContain(OD_ID);
  });

  test('a commit without the Agent signature trailer is a hit unless it is a merge or human-authored', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    const unsigned = commit(base.dir, 'fix(init): check the folder an approval change targets', { signed: false });
    const missing = run(base.dir, ['--base', base.sha]);
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
    const exemptClean = run(base.dir, ['--base', base.sha]);
    expect(exemptClean.status).toBe(0);

    // A human-authored or merge commit that carries a tracker id is still refused.
    const humanTracker = commit(base.dir, `docs: ${FLO_ID} note`, { signed: false, authorEmail: HUMAN_EMAIL });
    const refusedHuman = run(base.dir, ['--base', base.sha]);
    expect(refusedHuman.status).toBe(1);
    expect(refusedHuman.stderr).toContain(`commit:${humanTracker}:1`);
    expect(refusedHuman.stdout + refusedHuman.stderr).not.toContain(FLO_ID);
  });

  test('--release scans origin/main..HEAD while lane gates keep --base', () => {
    const base = repo({ 'keep.txt': 'clean\n' }, 'base');
    git(base.dir, ['update-ref', 'refs/remotes/origin/main', base.sha]);

    // An unsigned or tracker-bearing commit between origin/main and the lane base is caught by --release.
    const badEarlier = commit(base.dir, `test: ${FLO_ID} fixture`, { signed: false });
    const laneBase = commit(base.dir, 'chore: integration checkpoint');
    write(base.dir, { 'lane.txt': 'clean lane change\n' });
    commit(base.dir, 'feat: clean lane commit');

    const laneResult = run(base.dir, ['--base', laneBase]);
    expect(laneResult.status).toBe(0);

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
