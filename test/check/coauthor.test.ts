import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck } from '../../src/check/run.ts';
import { loadConfig } from '../../src/commands/check.ts';
import { commits } from '../../src/commands/commits.ts';
import { createRepository, type Repository } from './repository.ts';

/** This repository's own team file, the one CI checks with. */
const TEAM_FILE = fileURLToPath(new URL('../../.github/team.yaml', import.meta.url));

/** The rule as `check` prints it: the pattern's source, byte for byte. */
const RULE = 'forbidden pattern ^[Cc][Oo]-[Aa][Uu][Tt][Hh][Oo][Rr][Ee][Dd]-[Bb][Yy]:';

/** The notice this repository's own team file carries: it still spells the lead `coordinator:`. */

/** A signature of the file's coordinator seat, which passes the signature rule. */
const SIGNATURE = 'Agent: Claude Opus 5.5 · coordinator';

type Name = 'old' | 'upper' | 'lower' | 'mixed' | 'shout' | 'mention' | 'normal' | 'merge';

/** Each spelling of the trailer, and the commit that carries it. */
const TRAILERS = [
  { name: 'upper', spelling: 'Co-authored-by', subject: 'feat: a trailer in its usual case' },
  { name: 'lower', spelling: 'co-authored-by', subject: 'feat: the trailer in lower case' },
  { name: 'mixed', spelling: 'Co-Authored-By', subject: 'feat: the trailer in mixed case' },
  { name: 'shout', spelling: 'CO-AUTHORED-BY', subject: 'feat: the trailer in capitals' },
] as const;

const coauthor = (spelling: string) => `${spelling}: Someone <someone@example.com>`;

let repo: Repository;
let home: string;
const hash = {} as Record<Name, string>;

beforeAll(() => {
  repo = createRepository();
  home = mkdtempSync(join(tmpdir(), 'team-coauthor-home-'));
  hash.old = repo.commit('chore: the base, always skipped');

  for (const { name, spelling, subject } of TRAILERS) {
    hash[name] = repo.commit(`${subject}\n\n${SIGNATURE}\n${coauthor(spelling)}`);
  }

  hash.mention = repo.commit(
    [
      'feat: the words in a sentence',
      '',
      'We discussed the co-authored-by line in review,',
      'co-authored-by mentions in prose stay prose.',
      '',
      SIGNATURE,
    ].join('\n'),
  );
  hash.normal = repo.commit(`feat: a clean one\n\n${SIGNATURE}`);

  repo.git('switch', '--quiet', '-c', 'side', hash.old);
  repo.commit(`feat: on the side\n\n${SIGNATURE}`);
  repo.git('switch', '--quiet', 'main');
  repo.git('merge', '--quiet', '--no-ff', '--no-gpg-sign', '-m', `Merge side\n\n${coauthor('Co-authored-by')}`, 'side');
  hash.merge = repo.git('rev-parse', 'HEAD');
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

/** One named commit, with the file's `since` overridden: its hash is not in the temporary repository. */
const runOne = (name: Name) => run([hash[name], '--since', hash.old, '--file', TEAM_FILE]);

describe('a Co-authored-by trailer in this repository', () => {
  for (const { name, spelling, subject } of TRAILERS) {
    test(`is refused in ${spelling}, and the commit and the rule are named`, async () => {
      const result = await runOne(name);
      expect(result).toEqual({
        code: 1,
        stdout: [
          'COMMIT      STATUS   DETAIL',
          `${hash[name].slice(0, 10)}  refused  ${subject}`,
          `difference: commit ${hash[name].slice(0, 10)} "${subject}", line 4: ${RULE} — "${coauthor(spelling)}"`,
          '  repair: rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)',
          '  who: any seat',
          'team commits check: 1 commit checked: 1 commit refused',
          '',
        ].join('\n'),
        stderr: '',
      });
    });
  }

  test('the signature still passes: the only finding is the forbidden trailer', () => {
    const loaded = loadConfig(repo.path, TEAM_FILE, home);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    const report = runCheck(
      { ...loaded.config, since: undefined },
      { cwd: repo.path, ref: hash.upper },
    );
    expect(report.commits[0]?.findings.map((finding) => finding.kind)).toEqual(['forbidden']);
    expect(report.ok).toBe(false);
  });

  test('the words mid-sentence, even at the start of a line, are not a trailer', async () => {
    const result = await runOne('mention');
    expect(result).toEqual({
      code: 0,
      stdout: [
        'COMMIT      STATUS  DETAIL',
        `${hash.mention.slice(0, 10)}  ok      feat: the words in a sentence`,
        'team commits check: 1 commit checked: ok',
        '',
      ].join('\n'),
      stderr: '',
    });
  });

  test('a clean commit passes', async () => {
    const result = await runOne('normal');
    expect(result).toEqual({
      code: 0,
      stdout: [
        'COMMIT      STATUS  DETAIL',
        `${hash.normal.slice(0, 10)}  ok      feat: a clean one`,
        'team commits check: 1 commit checked: ok',
        '',
      ].join('\n'),
      stderr: '',
    });
  });

  test('a merge carrying the trailer is refused too, though a merge needs no signature', async () => {
    const result = await runOne('merge');
    expect(result).toEqual({
      code: 1,
      stdout: [
        'COMMIT      STATUS   DETAIL',
        `${hash.merge.slice(0, 10)}  refused  Merge side`,
        `difference: commit ${hash.merge.slice(0, 10)} "Merge side", line 3: ${RULE} — "Co-authored-by: Someone <someone@example.com>"`,
        '  repair: rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)',
        '  who: any seat',
        'team commits check: 1 commit checked, 1 by a human or a merge: 1 commit refused',
        '',
      ].join('\n'),
      stderr: '',
    });
  });
});
