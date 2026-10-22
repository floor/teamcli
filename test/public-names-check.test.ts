// The public-name check, over synthetic tracked trees: a hit in a file's text, a hit in a lower-
// case file name, clean controls, and the scope controls that keep ignored private state and
// untracked files out. Every forbidden token here is built from parts at runtime, so this file
// never matches its own check, and the ticket id used is one no policy names.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts', 'check-public-names.ts');
const TEAM_FILE = join(ROOT, '.github', 'team.yaml');

/** A ticket id no policy names, built from parts so this file never matches its own check. */
const TICKET = ['FL', 'O-', '77', '0'].join('');
/** The declared pattern's source, also built from parts. */
const TRACKER = ['\\bFL', 'O-[0-9]+\\b'].join('');
/** A session-shaped name and a synthetic pane id the tests use as data. */
const SESSION = ['floor', '-', '1a'].join('');
const PANE = ['w', '2', ':p', '1'].join('');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** A tracked tree: git init, the files written, then `git add -A`; an ignored file stays out. */
function tree(files: Record<string, string>, ignore: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'public-names-'));
  dirs.push(dir);
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  if (ignore.length > 0) writeFileSync(join(dir, '.gitignore'), `${ignore.join('\n')}\n`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, ['add', '-A']);
  return dir;
}

function run(root: string, file: string = TEAM_FILE) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, '--file', file], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

test('a tracked file whose text carries a ticket id fails, naming the line and never the id', () => {
  const root = tree({ 'test/restore-notes.test.ts': `// a note\nconst ticket = '${TICKET}';\n` });
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('test/restore-notes.test.ts:2');
  expect(result.stderr).toContain(JSON.stringify(TRACKER));
  expect(result.stderr).not.toContain(TICKET);
});

test('a lower-case file name fails even though the declared pattern is written in upper case', () => {
  const name = ['fl', 'o-', '77', '0'].join('');
  const root = tree({ [`test/${name}-notes.test.ts`]: 'export {};\n' });
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`test/${name}-notes.test.ts`);
  expect(result.stderr).toContain('its name matches');
});

test('clean prose, a hash and a public issue reference pass', () => {
  const root = tree({
    'test/notes.test.ts': [
      '// naïve café, 日本語, an emoji',
      `const digest = '${'a'.repeat(64)}';`,
      '// see #123 for the public issue',
      '// xFLO-77, FLO- and FLO-77x are near misses, never a ticket id',
    ].join('\n') + '\n',
  });
  const result = run(root);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('tracked files carry no forbidden public name');
});

test('every tracked file is public, not only the test tree', () => {
  const root = tree({ 'docs/restore.md': `ticket ${TICKET}\n` });
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('docs/restore.md:1');
});

test('every declared pattern applies to a path, not only the ticket id', () => {
  const root = tree({ [`docs/${SESSION}.md`]: 'export {};\n' });
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`docs/${SESSION}.md`);
});

test('a synthetic pane id in public test data is not a content hit', () => {
  const root = tree({ 'test/panes.test.ts': `const pane = '${PANE}';\n` });
  const result = run(root);
  expect(result.status).toBe(0);
});

test('the policy file does not match the patterns it declares', () => {
  const root = tree({ '.github/team.yaml': readFileSync(TEAM_FILE, 'utf8') });
  const result = run(root);
  expect(result.status).toBe(0);
});

test('ignored private state and untracked files are outside the index and the check', () => {
  const root = tree({ 'test/notes.test.ts': 'export {};\n' }, ['private/']);
  mkdirSync(join(root, 'private'), { recursive: true });
  writeFileSync(join(root, 'private', 'leak.txt'), TICKET);
  writeFileSync(join(root, 'untracked.txt'), TICKET);
  const result = run(root);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('2 tracked files');
});

test('a policy file that stopped declaring the ticket id is a refusal, never a pass', () => {
  const declares = ['FL', 'O-[0-9]+'].join('');
  const policy = readFileSync(TEAM_FILE, 'utf8')
    .split('\n')
    .filter((line) => !line.includes(declares))
    .join('\n');
  const holder = tree({ 'test/notes.test.ts': 'export {};\n' });
  const policyFile = join(holder, 'policy.yaml');
  writeFileSync(policyFile, policy);
  const result = run(holder, policyFile);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('declares no internal ticket-id pattern');
});

test('a tree git cannot list is a refusal, not a pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-names-plain-'));
  dirs.push(dir);
  const result = run(dir);
  expect(result.status).toBe(2);
});

test('an unreadable policy file is a refusal, not a pass', () => {
  const root = tree({ 'test/notes.test.ts': 'export {};\n' });
  const result = run(root, join(root, 'missing.yaml'));
  expect(result.status).toBe(2);
});
