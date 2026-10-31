// The external private-name gate, over synthetic lists and synthetic tracked trees.
// Every value here is built at runtime and exists only in this test's temporary folders; the
// real external lists are never read, and no private expression is copied into this file.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  normalizePrivateRules,
  readPrivateList,
  scanPrivateLines,
  scanPrivateTree,
  type PrivateScope,
  type PrivateSource,
} from '../src/check/private-names.ts';

const ROOT = join(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts', 'check-public-names.ts');
const TEAM_FILE = join(ROOT, '.github', 'team.yaml');

const SECRET = ['qw', 'rtz', '-', 'syn', 'th'].join('');
const OTHER = ['qw', 'rtz', '-', 'oth', 'er'].join('');
const WORD = ['qw', 'rtz', '-', 'word'].join('');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'private-names-'));
  dirs.push(dir);
  return dir;
}

function git(dir: string, args: string[]): void {
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
}

function tree(files: Record<string, string>): string {
  const dir = temp();
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, ['add', '-A']);
  return dir;
}

function listFile(contents: string, mode = 0o600): string {
  const path = join(temp(), 'private.txt');
  writeFileSync(path, contents, { mode });
  return path;
}

function source(label: string, entries: { source: string; scope: PrivateScope[]; className?: string }[]): PrivateSource {
  return {
    label,
    path: `/synthetic/${label}.txt`,
    entries: entries.map((entry, index) => ({
      source: entry.source,
      scope: entry.scope,
      origin: label,
      ...(entry.className === undefined ? {} : { className: entry.className }),
      ordinal: index + 1,
      line: index + 1,
    })),
  };
}

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, '--file', TEAM_FILE, ...args], {
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

describe('readPrivateList', () => {
  test('parses class scopes, a default scope and the non-comment prepush marker', () => {
    const path = listFile(
      [
        '# class: a names; scope=path,content',
        SECRET,
        '# class: b default',
        OTHER,
        '# class: c pane; scope=diff',
        'prepush-only:' + WORD,
        '#prepush-only: this is a comment, not an entry',
        '',
      ].join('\n'),
    );
    const read = readPrivateList(path, 'names');
    expect('source' in read).toBe(true);
    if (!('source' in read)) return;
    expect(read.source.entries.map((entry) => [entry.className, entry.scope, entry.source])).toEqual([
      ['a', ['path', 'content'], SECRET],
      ['b', ['path', 'content', 'diff'], OTHER],
      ['c', ['diff'], WORD],
    ]);
    expect(read.source.entries.map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
  });

  test('refuses ambiguous backslash escapes and lookaround without echoing the expression', () => {
    for (const bad of [`${SECRET}\\bword`, `${SECRET}\\Bword`, `${SECRET}\\w`, `${SECRET}\\s`, `${SECRET}\\1`, `${SECRET}(?=x)`]) {
      const read = readPrivateList(listFile(`# class: a names\n${bad}\n`), 'names');
      expect('problem' in read).toBe(true);
      if (!('problem' in read)) continue;
      expect(read.problem).toContain('names class a entry 1');
      expect(read.problem).not.toContain(bad);
      expect(read.problem).not.toContain(SECRET);
    }
  });

  test('allows explicit boundaries, literal escapes and POSIX bracket classes', () => {
    const boundary = `(^|[^A-Za-z0-9_])${WORD}([^A-Za-z0-9_]|$)`;
    const path = listFile(`${boundary}\n${SECRET}\\.${OTHER}\n[[:space:]]${SECRET}\n`);
    const read = readPrivateList(path, 'names');
    expect('source' in read).toBe(true);
    if (!('source' in read)) return;
    expect(read.source.entries).toHaveLength(3);
  });

  test('a missing default is a skip and a missing required list is a problem', () => {
    const missing = join(temp(), 'missing.txt');
    expect(readPrivateList(missing, 'names')).toEqual({ missing: true, path: missing });
    const required = readPrivateList(missing, 'names', { required: true });
    expect('problem' in required).toBe(true);
  });

  test('an empty list and a group-readable list are problems', () => {
    const empty = readPrivateList(listFile('# only comments\n\n'), 'names');
    expect('problem' in empty).toBe(true);
    const path = listFile(`${SECRET}\n`, 0o644);
    expect(statSync(path).mode & 0o077).not.toBe(0);
    const readable = readPrivateList(path, 'names');
    expect('problem' in readable).toBe(true);
    if (!('problem' in readable)) return;
    expect(readable.problem).toContain('readable by group or other');
  });

  test('a malformed class header or scope is a problem', () => {
    for (const header of ['# class: A x', '# class: a x; scope=paths', '# class: a x; scope=']) {
      const read = readPrivateList(listFile(`${header}\n${SECRET}\n`), 'names');
      expect('problem' in read).toBe(true);
    }
  });
});

describe('normalizePrivateRules', () => {
  test('an identical string is one rule, and a diff-only occurrence narrows it in either order', () => {
    const full = source('names', [{ source: SECRET, scope: ['path', 'content', 'diff'], className: 'a' }]);
    const diff = source('phrases', [{ source: SECRET, scope: ['diff'], className: 'c' }]);
    for (const ordered of [[full, diff], [diff, full]]) {
      const normalized = normalizePrivateRules(ordered);
      expect('problem' in normalized).toBe(false);
      if ('problem' in normalized) continue;
      expect(normalized.rules).toHaveLength(1);
      expect(normalized.rules[0]!.scope).toEqual(['diff']);
      expect(normalized.rules[0]!.occurrences).toHaveLength(2);
      expect(normalized.duplicates).toBe(1);
      expect(normalized.diffOnly).toBe(1);
    }
  });

  test('duplicate occurrences with disjoint scopes are refused', () => {
    const first = source('names', [{ source: SECRET, scope: ['path'], className: 'a' }]);
    const second = source('phrases', [{ source: SECRET, scope: ['diff'] }]);
    const normalized = normalizePrivateRules([first, second]);
    expect('problem' in normalized).toBe(true);
  });
});

describe('scanPrivateTree', () => {
  test('matches path and content scopes, skips diff-only entries, and never returns matched text', () => {
    const root = tree({
      [`docs/${SECRET}.md`]: 'no content here\n',
      'notes/clean.txt': `intro\n${SECRET}\n`,
      'notes/other.txt': `${OTHER}\n`,
    });
    const names = source('names', [
      { source: SECRET, scope: ['path', 'content'], className: 'a' },
      { source: OTHER, scope: ['diff'], className: 'c' },
    ]);
    const scan = scanPrivateTree(root, [names]);
    expect('problem' in scan).toBe(false);
    if ('problem' in scan) return;
    expect(scan.diffOnly).toBe(1);
    expect(scan.hits).toHaveLength(2);
    expect(scan.hits).toContainEqual({
      origin: 'names',
      className: 'a',
      ordinal: 1,
      path: 'notes/clean.txt',
      line: 2,
    });
    expect(scan.hits).toContainEqual({ origin: 'names', className: 'a', ordinal: 1, path: `docs/${SECRET}.md`, line: 0 });
    // A path hit's location is the path itself, so the path necessarily carries the name. A
    // content hit never carries the matching line's text.
    const contentHit = scan.hits.find((hit) => hit.line === 2);
    expect(contentHit).toBeDefined();
    expect(JSON.stringify(contentHit)).not.toContain(SECRET);
    expect(JSON.stringify(scan.hits)).not.toContain(OTHER);
  });

  test('explicit boundaries match a whole word once, not inside another word', () => {
    const boundary = `(^|[^A-Za-z0-9_])${WORD}([^A-Za-z0-9_]|$)`;
    const root = tree({
      'notes/inside.txt': `x${WORD}x\n`,
      'notes/word.txt': ` ${WORD} \n`,
    });
    const scan = scanPrivateTree(root, [source('names', [{ source: boundary, scope: ['content'] }])]);
    expect('problem' in scan).toBe(false);
    if ('problem' in scan) return;
    expect(scan.hits).toEqual([{ origin: 'names', ordinal: 1, path: 'notes/word.txt', line: 1 }]);
  });

  test('POSIX bracket classes are executed by the ERE engine and intervals and alternation work', () => {
    const root = tree({
      'notes/digits.txt': 'code 123\n',
      'notes/letters.txt': 'alpha-42\n',
    });
    const scan = scanPrivateTree(
      root,
      [source('names', [
        { source: '[[:digit:]]{3}', scope: ['content'] },
        { source: '(alpha|beta)-[0-9]{2}', scope: ['content'] },
      ])],
    );
    expect('problem' in scan).toBe(false);
    if ('problem' in scan) return;
    expect(scan.hits).toHaveLength(2);
    expect(scan.hits.map((hit) => hit.path).sort()).toEqual(['notes/digits.txt', 'notes/letters.txt']);
  });

  test('matching is case-sensitive', () => {
    const root = tree({ 'notes/case.txt': `${SECRET.toUpperCase()}\n` });
    const scan = scanPrivateTree(root, [source('names', [{ source: SECRET, scope: ['content'] }])]);
    expect('problem' in scan).toBe(false);
    if ('problem' in scan) return;
    expect(scan.hits).toHaveLength(0);
  });

  test('an invalid expression is a redacted problem, never the engine error', () => {
    const root = tree({ 'notes/clean.txt': 'nothing\n' });
    const bad = '(';
    const scan = scanPrivateTree(root, [source('names', [{ source: bad, scope: ['content'], className: 'a' }])]);
    expect('problem' in scan).toBe(true);
    if (!('problem' in scan)) return;
    expect(scan.problem).toContain('names class a entry 1');
    expect(scan.problem).not.toContain(bad);
    expect(scan.problem).not.toContain('fatal');
  });
});

describe('scanPrivateLines', () => {
  test('applies diff scope only, including a full-scope rule and a prepush rule', () => {
    const sources = [
      source('names', [
        { source: SECRET, scope: ['path', 'content'], className: 'a' },
        { source: OTHER, scope: ['diff'], className: 'c' },
      ]),
    ];
    const scan = scanPrivateLines([`added ${SECRET}`, `added ${OTHER}`], sources);
    expect('problem' in scan).toBe(false);
    if ('problem' in scan) return;
    expect(scan.hits).toEqual([{ origin: 'names', className: 'c', ordinal: 2, line: 2 }]);
    expect(JSON.stringify(scan.hits)).not.toContain(OTHER);
  });

  test('an empty text has no line for a match-all expression', () => {
    const scan = scanPrivateLines([], [source('names', [{ source: '^$', scope: ['diff'] }])]);
    expect('problem' in scan).toBe(false);
    if ('problem' in scan) return;
    expect(scan.hits).toHaveLength(0);
  });
});

describe('the check command', () => {
  test('a private content hit fails with the source, class and ordinal, never the value', () => {
    const root = tree({ 'notes/hit.txt': `${SECRET}\n` });
    const names = listFile(`${SECRET}\n`);
    const phrases = listFile(`${OTHER}\n`);
    const result = run(root, ['--private-names', names, '--private-phrases', phrases]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('notes/hit.txt:1');
    expect(result.stderr).toContain('private names entry 1');
    expect(result.stderr).not.toContain(SECRET);
    expect(result.stderr).not.toContain(OTHER);
  });

  test('a missing default list is a visible skip, not a failure', () => {
    const root = tree({ 'notes/clean.txt': 'nothing\n' });
    const result = run(root, []);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('names private list not present');
    expect(result.stdout).toContain('phrases private list not present');
    expect(result.stdout).toContain('private scan skipped');
  });

  test('a list named on the command line must exist', () => {
    const root = tree({ 'notes/clean.txt': 'nothing\n' });
    const result = run(root, ['--private-names', join(root, 'missing.txt')]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('private list not present');
  });

  test('an unsupported escape, an invalid expression and a readable list are refusals', () => {
    const root = tree({ 'notes/clean.txt': 'nothing\n' });
    const unsupported = run(root, ['--private-names', listFile(`# class: a names\n${SECRET}\\bword\n`)]);
    expect(unsupported.status).toBe(2);
    expect(unsupported.stderr).toContain('names class a entry 1');
    expect(unsupported.stderr).not.toContain(SECRET);

    const invalid = run(root, ['--private-names', listFile('(\n')]);
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain('invalid private entry');
    expect(invalid.stderr).not.toContain('(');

    const readable = run(root, ['--private-names', listFile(`${SECRET}\n`, 0o644)]);
    expect(readable.status).toBe(2);
    expect(readable.stderr).toContain('readable by group or other');
  });

  test('a clean tree with a clean list passes and reports the rule count', () => {
    const root = tree({ 'notes/clean.txt': 'nothing\n' });
    const result = run(root, ['--private-names', listFile(`${SECRET}\n`), '--private-phrases', listFile(`${OTHER}\n`)]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('private scan: 2 rules');
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stdout).not.toContain(OTHER);
  });
});
