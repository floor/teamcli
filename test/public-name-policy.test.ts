// The public-name rule the repository's own team file declares, on fixture trees: a tracked
// test's contents and its path each carry the policy, and nothing else is in scope. Every
// forbidden string here is assembled from pieces at runtime, so this file stays inside the
// policy it enforces.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanPublicNames, type PublicNameHit, type PublicNameRule } from '../src/check/public-names.ts';

const REPO = join(import.meta.dir, '..');
const SCRIPT = join(REPO, 'scripts/check-public-names.ts');
const TEAM = join(REPO, '.github/team.yaml');

// The declared internal tracker pattern and a synthetic id in its shape; neither is whole in
// this source, and the id is not one from any finding.
const TRACKER = ['\\b', 'FL', 'O', '-', '[0-9]', '+', '\\b'].join('');
const ID = ['FL', 'O-', '77', '0'].join('');
const LOWER = ID.toLowerCase();

// The scanner's own rule list: the tracker pattern on contents case-sensitively, and on every
// tracked path case-insensitively (the lower-case form is a public name too).
const RULES: PublicNameRule[] = [
  { source: TRACKER, scope: 'content', caseInsensitive: false },
  { source: TRACKER, scope: 'path', caseInsensitive: true },
];

const CLEAN = '// A clean test file.\n';

const created: string[] = [];

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'team-public-names-'));
  created.push(root);
  return root;
}

function git(root: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
}

function tree(files: Array<[string, string]>, after?: (root: string) => void): string {
  const root = scratch();
  for (const [path, text] of files) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  after?.(root);
  return root;
}

function scanned(root: string): { hits: PublicNameHit[]; scanned: number } {
  const result = scanPublicNames(root, RULES);
  if ('problem' in result) throw new Error(`unexpected problem: ${result.problem}`);
  return result;
}

function runCli(args: string[], cwd: string = REPO): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd });
  return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function contentHit(path: string, line: number): RegExp {
  return new RegExp(`${escape(path)}:${line}: it matches the forbidden public pattern "[^"]+"`);
}

function nameHit(path: string): RegExp {
  return new RegExp(`${escape(path)}: its name matches the forbidden public pattern "[^"]+"`);
}

function hitLines(run: { stderr: string }): string[] {
  return run.stderr.split('\n').filter((line) => line !== '');
}

describe('scanPublicNames on tracked fixture trees', () => {
  test('an id in tracked contents is reported with its line, and the count is the tracked files', () => {
    const root = tree([
      ['test/alpha.test.ts', `// first line\n// ${ID} item 6\n`],
      ['README.md', '# Synthetic tree\n'],
    ]);
    const result = scanned(root);
    expect(result.scanned).toBe(2);
    expect(result.hits).toEqual([{ path: 'test/alpha.test.ts', line: 2, pattern: TRACKER }]);
  });

  test('contents are matched case-sensitively, so a lower-case id in contents is not a hit', () => {
    const root = tree([['test/alpha.test.ts', `// ${LOWER} item 6 is plain prose here\n`]]);
    expect(scanned(root).hits).toEqual([]);
  });

  test('a lower-case id in a tracked path is a hit even when the contents are harmless', () => {
    const path = `test/${LOWER}-restore.test.ts`;
    const root = tree([[path, CLEAN]]);
    expect(scanned(root).hits).toEqual([{ path, line: 0, pattern: TRACKER }]);
  });

  test('untracked and git-ignored files are outside the scope', () => {
    const root = tree(
      [
        ['.gitignore', 'ignored.txt\n'],
        ['test/alpha.test.ts', CLEAN],
      ],
      (root) => {
        writeFileSync(join(root, 'ignored.txt'), `// ${ID}\n`);
        writeFileSync(join(root, 'untracked.txt'), `// ${ID}\n`);
      },
    );
    const result = scanned(root);
    expect(result.hits).toEqual([]);
    expect(result.scanned).toBe(2);
  });

  test('every match in one file is reported, not just the first', () => {
    const root = tree([['test/alpha.test.ts', `// ${ID} one\n// clean\n// ${ID} two\n`]]);
    const lines = scanned(root)
      .hits.map((hit) => hit.line)
      .sort((left, right) => left - right);
    expect(lines).toEqual([1, 3]);
  });

  test('a folder that is not a git work tree is a problem, never a silent clean pass', () => {
    const root = scratch();
    writeFileSync(join(root, 'alpha.test.ts'), `// ${ID}\n`);
    const result = scanPublicNames(root, RULES);
    expect('problem' in result).toBe(true);
  });
});

describe('the public-name check command on tracked fixture trees', () => {
  test('a clean tree exits 0 and names the number of tracked files scanned', () => {
    const root = tree([
      ['test/alpha.test.ts', CLEAN],
      ['README.md', '# Synthetic tree\n'],
    ]);
    const run = runCli(['--root', root, '--file', TEAM]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    const lines = run.stdout.trim().split('\n');
    expect(lines.length).toBe(1);
    expect(lines.at(0) ?? '').toContain('2');
  });

  test('matching contents exit 1, naming the file and line, and never print the match', () => {
    const root = tree([['test/alpha.test.ts', `// a clean first line\n// ${ID} item 6\n`]]);
    const run = runCli(['--root', root, '--file', TEAM]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(contentHit('test/alpha.test.ts', 2));
    expect(run.stdout + run.stderr).not.toContain(ID);
  });

  test('a lower-case id filename exits 1 even with harmless contents', () => {
    const path = `test/${LOWER}-restore.test.ts`;
    const run = runCli(['--root', tree([[path, CLEAN]]), '--file', TEAM]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(nameHit(path));
    // The path is the location and must be named; the upper-case id and the file's contents
    // are never echoed.
    expect(run.stdout + run.stderr).not.toContain(ID);
    expect(run.stdout + run.stderr).not.toContain('A clean test file');
  });

  test('UTF-8 prose, a SHA-256 digest and public issue numbers are not matches', () => {
    const root = tree([
      ['test/utf8.test.ts', '// UTF-8 prose: an em dash — a middle dot · and CJK 汉字 stay readable.\n'],
      ['test/digest.test.ts', `// The digest is ${'a1b2c3d4'.repeat(8)} in the log.\n`],
      ['test/issues.test.ts', '// See #9, #123 and #661.\n'],
    ]);
    const run = runCli(['--root', root, '--file', TEAM]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
  });

  test('near misses around the tracker boundary stay clean, in contents and in a name', () => {
    const near = ['afloat', 'FL' + 'O-', 'FL' + 'O-abc', 'x' + 'FL' + 'O-1', LOWER + 'x'].join(' ');
    const nearName = `test/${'flo' + '-1x'}.test.ts`;
    const root = tree([
      ['test/alpha.test.ts', `// ${near}\n`],
      [nearName, CLEAN],
    ]);
    const run = runCli(['--root', root, '--file', TEAM]);
    expect(run.code).toBe(0);
  });

  test('every path rule applies to names, while contents carry the tracker id alone', () => {
    const pane = ['w', '2', 'A', ':', 'p', '1'].join('');
    const session = ['floor', '-', '3', 'a'].join('');
    const root = tree([
      [`test/${pane}.test.ts`, CLEAN],
      [`test/${session}.test.ts`, CLEAN],
      ['test/prose.test.ts', `// Fixtures synthesize ${pane} and ${session} as plain prose.\n`],
    ]);
    const run = runCli(['--root', root, '--file', TEAM]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(nameHit(`test/${pane}.test.ts`));
    expect(run.stderr).toMatch(nameHit(`test/${session}.test.ts`));
    expect(hitLines(run).length).toBe(2);
  });

  test('a scanned tree with no team file of its own exits 2 when none is named', () => {
    const root = tree([['test/alpha.test.ts', CLEAN]]);
    const run = runCli(['--root', root], root);
    expect(run.code).toBe(2);
  });

  test('a team file that does not declare the tracker id exits 2', () => {
    const policyDir = scratch();
    const copy = readFileSync(TEAM, 'utf8')
      .split('\n')
      .filter((line) => !line.includes('FL' + 'O-'))
      .join('\n');
    writeFileSync(join(policyDir, 'team.yaml'), copy);
    const root = tree([['test/alpha.test.ts', `// ${ID} item 6\n`]]);
    const run = runCli(['--root', root, '--file', join(policyDir, 'team.yaml')]);
    expect(run.code).toBe(2);
    expect(run.stderr).not.toBe('');
  });

  test('an unreadable team file exits 2', () => {
    const run = runCli([
      '--root',
      tree([['test/alpha.test.ts', CLEAN]]),
      '--file',
      join(scratch(), 'absent-team.yaml'),
    ]);
    expect(run.code).toBe(2);
  });

  test('a folder that is not a git work tree exits 2', () => {
    const plain = scratch();
    writeFileSync(join(plain, 'alpha.test.ts'), `// ${ID} item 6\n`);
    const run = runCli(['--root', plain, '--file', TEAM]);
    expect(run.code).toBe(2);
  });
});

describe('this repository', () => {
  test('is clean under the declared policy once the scrub has landed', () => {
    const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: REPO });
    expect(tracked.exitCode).toBe(0);
    const count = tracked.stdout
      .toString()
      .trim()
      .split('\n')
      .filter((line) => line !== '').length;
    const run = runCli([], REPO);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout.trim().split('\n').length).toBe(1);
    expect(run.stdout).toContain(String(count));
  });
});
