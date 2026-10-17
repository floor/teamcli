import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/commands/check.ts';
import { commits } from '../../src/commands/commits.ts';
import { pr } from '../../src/commands/pr.ts';
import { createRepository, type Repository } from './repository.ts';

/** This repository's own team file, the one CI checks with. */
const TEAM_FILE = fileURLToPath(new URL('../../.github/team.yaml', import.meta.url));

/** The rules as `check` prints them: each pattern's source, byte for byte. */
const PANE = 'forbidden pattern \\bw[0-9A-Z]+:p[0-9]+\\b';
const SESSION = 'forbidden pattern \\bfloor-[0-9a-f]{2}\\b';

/** A signature of the file's coordinator seat, which passes the signature rule. */
const SIGNATURE = 'Agent: Claude Opus 5.5 · coordinator';
const PR_SIGNATURE = '**Agent:** Claude Opus 5.5 · coordinator';

type Name = 'old' | 'pane' | 'session' | 'misses';

let repo: Repository;
let home: string;
const hash = {} as Record<Name, string>;

beforeAll(() => {
  repo = createRepository();
  home = mkdtempSync(join(tmpdir(), 'team-internal-names-home-'));
  hash.old = repo.commit('chore: the base, always skipped');

  hash.pane = repo.commit(`feat: a pane id in the message

The watch announced w2A:p1 today,
and w29:p12 as well.

${SIGNATURE}`);

  hash.session = repo.commit(`feat: a session name in the message

The run came from floor-3a.

${SIGNATURE}`);

  hash.misses = repo.commit(`feat: near misses stay prose

w3c, www:port and v2:p1 stay, and so do floor-io,
floor/teamcli, team.floor.io and floor-material.

${SIGNATURE}`);
});

afterAll(() => {
  repo.remove();
  rmSync(home, { recursive: true, force: true });
});

/** The command as CI runs it: this repository's file, on a commit of the temporary repository. */
async function run(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const io = {
    stdout: (text: string) => void (stdout += text),
    stderr: (text: string) => void (stderr += text),
    cwd: repo.path,
    env: {},
    stdinIsTTY: false,
  };
  const code = await commits(['check', ...argv], io, (cwd, file) => loadConfig(cwd, file, home));
  return { code, stdout, stderr };
}

/** Runs `team pr check` the same way. */
async function runPr(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const io = {
    stdout: (text: string) => void (stdout += text),
    stderr: (text: string) => void (stderr += text),
    cwd: repo.path,
    env: {},
    stdinIsTTY: false,
  };
  const code = await pr(['check', ...argv], io, (cwd, file) => loadConfig(cwd, file, home));
  return { code, stdout, stderr };
}

/** One named commit, with the file's `since` overridden: its hash is not in the temporary repository. */
const runOne = (name: Name) => run([hash[name], '--since', hash.old, '--file', TEAM_FILE]);

describe('a pane id in this repository', () => {
  test('is refused in a commit message, and the commit and the rule are named', async () => {
    const result = await runOne('pane');
    expect(result).toEqual({
      code: 1,
      stdout: [
        'COMMIT      STATUS   DETAIL',
        `${hash.pane.slice(0, 10)}  refused  feat: a pane id in the message`,
        `difference: commit ${hash.pane.slice(0, 10)} "feat: a pane id in the message", line 3: ${PANE} — "The watch announced w2A:p1 today,"`,
        '  repair: rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)',
        '  who: any seat',
        `difference: commit ${hash.pane.slice(0, 10)} "feat: a pane id in the message", line 4: ${PANE} — "and w29:p12 as well."`,
        '  repair: rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)',
        '  who: any seat',
        'team commits check: 1 commit checked: 1 commit refused',
        '',
      ].join('\n'),
      stderr: '',
    });
  });

  test('is refused in a pull request body beside a passing commit', async () => {
    writeFileSync(join(repo.path, 'body.md'), `What this does.\n\nThe watch announced w2A:p1.\n\n${PR_SIGNATURE}\n`);
    const passing = await run([hash.misses, '--since', hash.old, '--file', TEAM_FILE]);
    expect(passing).toEqual({
      code: 0,
      stdout: [
        'COMMIT      STATUS  DETAIL',
        `${hash.misses.slice(0, 10)}  ok      feat: near misses stay prose`,
        'team commits check: 1 commit checked: ok',
        '',
      ].join('\n'),
      stderr: '',
    });
    const result = await runPr(['body.md', '--file', TEAM_FILE]);
    expect(result).toEqual({
      code: 1,
      stdout: [
        `difference: pull request body, line 3: ${PANE} — "The watch announced w2A:p1."`,
        '  repair: edit the pull request body so the line no longer matches (its author can edit it on the pull request)',
        '  who: any seat',
        'team pr check: 1 pull request body checked: the pull request body refused',
        '',
      ].join('\n'),
      stderr: '',
    });
  });
});

describe('an internal session name in this repository', () => {
  test('is refused in a commit message, and the commit and the rule are named', async () => {
    const result = await runOne('session');
    expect(result).toEqual({
      code: 1,
      stdout: [
        'COMMIT      STATUS   DETAIL',
        `${hash.session.slice(0, 10)}  refused  feat: a session name in the message`,
        `difference: commit ${hash.session.slice(0, 10)} "feat: a session name in the message", line 3: ${SESSION} — "The run came from floor-3a."`,
        '  repair: rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)',
        '  who: any seat',
        'team commits check: 1 commit checked: 1 commit refused',
        '',
      ].join('\n'),
      stderr: '',
    });
  });

  test('is refused in a pull request body beside a passing commit', async () => {
    writeFileSync(join(repo.path, 'body.md'), `What this does.\n\nThe run came from floor-3a.\n\n${PR_SIGNATURE}\n`);
    const passing = await run([hash.misses, '--since', hash.old, '--file', TEAM_FILE]);
    expect(passing).toEqual({
      code: 0,
      stdout: [
        'COMMIT      STATUS  DETAIL',
        `${hash.misses.slice(0, 10)}  ok      feat: near misses stay prose`,
        'team commits check: 1 commit checked: ok',
        '',
      ].join('\n'),
      stderr: '',
    });
    const result = await runPr(['body.md', '--file', TEAM_FILE]);
    expect(result).toEqual({
      code: 1,
      stdout: [
        `difference: pull request body, line 3: ${SESSION} — "The run came from floor-3a."`,
        '  repair: edit the pull request body so the line no longer matches (its author can edit it on the pull request)',
        '  who: any seat',
        'team pr check: 1 pull request body checked: the pull request body refused',
        '',
      ].join('\n'),
      stderr: '',
    });
  });
});

describe('the near misses', () => {
  test('words, versions and the public names are not pane ids or session names', async () => {
    const result = await runOne('misses');
    expect(result).toEqual({
      code: 0,
      stdout: [
        'COMMIT      STATUS  DETAIL',
        `${hash.misses.slice(0, 10)}  ok      feat: near misses stay prose`,
        'team commits check: 1 commit checked: ok',
        '',
      ].join('\n'),
      stderr: '',
    });
  });
});
