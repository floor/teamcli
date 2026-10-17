import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitError, selectCommits } from '../../src/check/git.ts';
import { formatReport, runCheck } from '../../src/check/run.ts';
import { loadConfig } from '../../src/commands/check.ts';
import { commits } from '../../src/commands/commits.ts';
import { pr } from '../../src/commands/pr.ts';
import { storePath } from '../../src/store/store.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { config, PR_SIGNATURE, SIGNATURE } from './fixtures.ts';
import { createRepository, HUMAN_EMAIL, type Repository } from './repository.ts';

let repo: Repository;
type Name =
  | 'old'
  | 'older-unsigned'
  | 'signed'
  | 'coauthored'
  | 'unsigned'
  | 'prose'
  | 'fixes'
  | 'human'
  | 'human-forbidden'
  | 'session'
  | 'link'
  | 'tracker'
  | 'no-version'
  | 'wrong-pair'
  | 'subject-only'
  | 'side'
  | 'merge'
  | 'clean1'
  | 'clean2'
  | 'spaces';
const hash = {} as Record<Name, string>;

/** The findings of one commit, as kinds. */
function kindsOf(name: Name, overrides = {}): string[] {
  const report = runCheck(config(overrides), { cwd: repo.path, ref: hash[name] });
  expect(report.commits).toHaveLength(1);
  return report.commits.flatMap((commit) => commit.findings.map((finding) => finding.kind));
}

beforeAll(() => {
  repo = createRepository();
  const add = (name: Name, message: string, email?: string) => {
    hash[name] = repo.commit(message, email);
  };

  add('old', 'chore: before the rule');
  add('older-unsigned', 'chore: also before the rule');
  add('signed', `feat: signed\n\nSome prose.\n\n${SIGNATURE}`);
  add('coauthored', `feat: two trailers\n\n${SIGNATURE}\nCo-authored-by: A <a@b.example>`);
  add('unsigned', 'fix: unsigned\n\nSome prose.');
  add('prose', `fix: prose in the paragraph\n\nRefs #3\n${SIGNATURE}`);
  add('fixes', `fix: a trailer before it\n\nFixes: #11\n${SIGNATURE}`);
  add('human', 'docs: by a human', HUMAN_EMAIL);
  add('human-forbidden', 'docs: by a human\n\nClaude-Session: 1234', HUMAN_EMAIL);
  add('session', `feat: session line\n\nClaude-Session: 1234\n\n${SIGNATURE}`);
  add('link', `feat: session link\n\nSee https://claude.ai/code/session_01ab\n\n${SIGNATURE}`);
  add('tracker', `feat: tracker id (WEB-12)\n\n${SIGNATURE}`);
  add('no-version', 'feat: no version\n\nAgent: Claude Opus · implementer');
  add('wrong-pair', 'feat: wrong pair\n\nAgent: GPT-6 Sol · implementer');
  add('subject-only', SIGNATURE);

  repo.git('switch', '--quiet', '-c', 'side', hash.old);
  hash.side = repo.commit(`feat: on a side branch\n\n${SIGNATURE}`);
  repo.git('switch', '--quiet', 'main');
  repo.git('merge', '--quiet', '--no-ff', '--no-gpg-sign', '-m', 'Merge branch side', 'side');
  hash.merge = repo.git('rev-parse', 'HEAD');

  hash.spaces = repo.commit(`feat: trailing spaces\n\n${SIGNATURE}  \n`, undefined, true);
  hash.clean1 = repo.commit(`feat: clean one\n\n${SIGNATURE}`);
  hash.clean2 = repo.commit(`feat: clean two\n\n${SIGNATURE}`);
});

afterAll(() => repo.remove());

describe('one commit', () => {
  test('a signature in a trailer block passes', () => {
    expect(kindsOf('signed')).toEqual([]);
  });

  test('a Co-authored-by after the signature passes', () => {
    expect(kindsOf('coauthored')).toEqual([]);
  });

  test('a signature line that ends in spaces passes, at each position', () => {
    expect(repo.git('log', '-1', '--format=[%B]', hash.spaces)).toContain(`${SIGNATURE}  \n`);
    expect(kindsOf('spaces')).toEqual([]);
    expect(kindsOf('spaces', { commits: { ...config().commits, position: 'last-line' } })).toEqual([]);
    expect(kindsOf('spaces', { commits: { ...config().commits, position: 'anywhere' } })).toEqual([]);
  });

  test('a trailer before the signature passes', () => {
    expect(kindsOf('fixes')).toEqual([]);
  });

  test('an unsigned commit is refused', () => {
    expect(kindsOf('unsigned')).toEqual(['signature-missing']);
  });

  test('prose in the trailer paragraph is named as that case', () => {
    expect(kindsOf('prose')).toEqual(['signature-in-prose']);
  });

  test('the same message passes when the position is last-line', () => {
    expect(kindsOf('prose', { commits: { ...config().commits, position: 'last-line' } })).toEqual([]);
  });

  test('a signature as the subject is in no trailer block', () => {
    expect(kindsOf('subject-only')).toEqual(['signature-misplaced']);
  });

  test('a human needs no signature', () => {
    const report = runCheck(config(), { cwd: repo.path, ref: hash.human });
    expect(report.commits[0]).toMatchObject({ exempt: 'human', findings: [] });
    expect(report.ok).toBe(true);
  });

  test('a human is matched whatever the case of the email', () => {
    expect(kindsOf('human', { humans: [HUMAN_EMAIL.toUpperCase()] })).toEqual([]);
  });

  test('a human who is not listed must sign', () => {
    expect(kindsOf('human', { humans: [] })).toEqual(['signature-missing']);
  });

  test("a human's commit is still checked for forbidden patterns", () => {
    expect(kindsOf('human-forbidden')).toEqual(['forbidden']);
  });

  test('a merge needs no signature', () => {
    const report = runCheck(config(), { cwd: repo.path, ref: hash.merge });
    expect(report.commits[0]).toMatchObject({ exempt: 'merge', findings: [] });
  });

  test('a merge must sign when the file exempts nothing', () => {
    expect(kindsOf('merge', { commits: { ...config().commits, exemptMerge: false } })).toEqual(['signature-missing']);
  });

  test('each default forbidden pattern is refused in a signed commit', () => {
    expect(kindsOf('session')).toEqual(['forbidden']);
    expect(kindsOf('link')).toEqual(['forbidden']);
  });

  test('a tracker id is refused in a public project only', () => {
    expect(kindsOf('tracker')).toEqual(['forbidden']);
    expect(kindsOf('tracker', { public: false })).toEqual([]);
  });

  test('a signature without the version, or with a pair no seat had, is refused', () => {
    expect(kindsOf('no-version')).toEqual(['signature-unknown']);
    expect(kindsOf('wrong-pair')).toEqual(['signature-unknown']);
  });

  test('a single ref never reads the history behind it', () => {
    const report = runCheck(config(), { cwd: repo.path, ref: 'main' });
    expect(report.commits.map((commit) => commit.hash)).toEqual([hash.clean2]);
    expect(report.ok).toBe(true);
  });
});

describe('a range', () => {
  test('is passed to git as given, newest first', () => {
    const report = runCheck(config(), { cwd: repo.path, ref: `${hash.spaces}..main` });
    expect(report.commits.map((commit) => commit.hash)).toEqual([hash.clean2, hash.clean1]);
    expect(report.ok).toBe(true);
  });

  test('reports every offending commit', () => {
    const report = runCheck(config(), { cwd: repo.path, ref: `${hash.old}..main` });
    const refused = report.commits.filter((commit) => commit.findings.length > 0).map((commit) => commit.hash);
    expect(new Set(refused)).toEqual(
      new Set(
        (
          [
            'older-unsigned',
            'unsigned',
            'prose',
            'human-forbidden',
            'session',
            'link',
            'tracker',
            'no-version',
            'wrong-pair',
            'subject-only',
          ] as Name[]
        ).map((name) => hash[name]),
      ),
    );
    expect(report.ok).toBe(false);
  });

  test('an empty range is an error', () => {
    expect(() => selectCommits(repo.path, 'main..main')).toThrow('holds no commit');
  });

  test('an unresolvable range or ref is an error', () => {
    expect(() => selectCommits(repo.path, 'nowhere..main')).toThrow(GitError);
    expect(() => selectCommits(repo.path, 'nowhere')).toThrow("doesn't name a commit");
  });

  test('a ref that looks like an option is refused', () => {
    expect(() => selectCommits(repo.path, '--all')).toThrow('is not a ref');
    expect(() => selectCommits(repo.path, 'main', '--all')).toThrow('is not a ref');
  });

  test('a folder that is no repository is an error', () => {
    expect(() => selectCommits('/', 'HEAD')).toThrow(GitError);
  });
});

describe('since', () => {
  test('skips the commit and everything reachable from it', () => {
    const selection = selectCommits(repo.path, `${hash.signed}..main`, hash.spaces);
    expect(selection.commits.map((commit) => commit.hash)).toEqual([hash.clean2, hash.clean1]);
    expect(selection.since).toBe(hash.spaces);
  });

  test('counts what it leaves out of a range', () => {
    const report = runCheck(config({ since: hash.spaces }), { cwd: repo.path, ref: `${hash.old}..main` });
    expect(report.commits.map((commit) => commit.hash)).toEqual([hash.clean2, hash.clean1]);
    expect(report.skipped).toBe(17);
    expect(report.ok).toBe(true);
  });

  test('passes when it sits behind the range', () => {
    const selection = selectCommits(repo.path, `${hash.spaces}..main`, hash.old);
    expect(selection.commits).toHaveLength(2);
    expect(selection.skipped).toBe(0);
  });

  test('the option overrides the file', () => {
    const report = runCheck(config({ since: hash.old }), {
      cwd: repo.path,
      ref: `${hash.old}..main`,
      since: hash.spaces,
    });
    expect(report.commits).toHaveLength(2);
  });

  test('a commit that is not reachable from the range is an error', () => {
    expect(() => selectCommits(repo.path, hash.signed, hash.clean1)).toThrow('is not reachable from');
  });

  test('a commit that does not exist is an error', () => {
    expect(() => selectCommits(repo.path, 'main', 'nowhere')).toThrow("doesn't name a commit here");
  });

  test('a range it covers whole passes with nothing checked, and says so', () => {
    const report = runCheck(config({ since: 'main' }), { cwd: repo.path, ref: 'main' });
    expect(report.commits).toEqual([]);
    expect(report.ok).toBe(true);
    expect(formatReport(report)).toContain('0 commits checked, 1 skipped (since ');
  });
});

describe('the pull request body', () => {
  test('passes with the signature last', () => {
    const report = runCheck(config(), { cwd: repo.path, ref: 'main', pullRequestBody: `text\n\n${PR_SIGNATURE}\n` });
    expect(report.pullRequest).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('is refused without one, and for a forbidden line', () => {
    const report = runCheck(config(), {
      cwd: repo.path,
      ref: 'main',
      pullRequestBody: 'Closes WEB-3\n\nClaude-Session: 1',
    });
    expect(report.pullRequest?.map((finding) => finding.kind)).toEqual(['forbidden', 'forbidden', 'signature-missing']);
    expect(report.ok).toBe(false);
  });
});

describe('the command', () => {
  const load = () => ({ ok: true as const, config: config(), warnings: [] });

  /** The io a run below collects into. */
  function ioOf() {
    let stdout = '';
    let stderr = '';
    return {
      io: {
        stdout: (text: string) => void (stdout += text),
        stderr: (text: string) => void (stderr += text),
        cwd: repo.path,
        env: {},
        stdinIsTTY: false,
      },
      text: () => ({ stdout, stderr }),
    };
  }

  /** Runs `team commits check` with a given configuration, or with the repository's own file when `loader` is 'file'. */
  async function run(argv: string[], loader: Parameters<typeof commits>[2] | 'file' = load) {
    const { io, text } = ioOf();
    const code = await (loader === 'file' ? commits(['check', ...argv], io) : commits(['check', ...argv], io, loader));
    return { code, ...text() };
  }

  /** Runs `team pr check` the same way. */
  async function runPr(argv: string[], loader: Parameters<typeof pr>[2] | 'file' = load) {
    const { io, text } = ioOf();
    const code = await (loader === 'file' ? pr(['check', ...argv], io) : pr(['check', ...argv], io, loader));
    return { code, ...text() };
  }

  test('exits 0 and prints the summary', async () => {
    const result = await run([`${hash.spaces}..main`]);
    expect(result).toEqual({
      code: 0,
      stdout:
        'COMMIT      STATUS  DETAIL\n' +
        `${hash.clean2.slice(0, 10)}  ok      feat: clean two\n` +
        `${hash.clean1.slice(0, 10)}  ok      feat: clean one\n` +
        'team commits check: 2 commits checked: ok\n',
      stderr: '',
    });
  });

  test('exits 1 with each offending commit and line', async () => {
    const REWRITE = '  repair: rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)\n';
    const WHO = '  who: any seat\n';
    const result = await run([`${hash.human}..${hash.link}`]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(
      'COMMIT      STATUS   DETAIL\n' +
        `${hash.link.slice(0, 10)}  refused  feat: session link\n` +
        `${hash.session.slice(0, 10)}  refused  feat: session line\n` +
        `${hash['human-forbidden'].slice(0, 10)}  refused  docs: by a human\n` +
        `difference: commit ${hash.link.slice(0, 10)} "feat: session link", line 3: forbidden pattern https?://claude\\.ai/code/session — "See https://claude.ai/code/session_01ab"\n` +
        REWRITE +
        WHO +
        `difference: commit ${hash.session.slice(0, 10)} "feat: session line", line 3: forbidden pattern ^Claude-Session: — "Claude-Session: 1234"\n` +
        REWRITE +
        WHO +
        `difference: commit ${hash['human-forbidden'].slice(0, 10)} "docs: by a human", line 3: forbidden pattern ^Claude-Session: — "Claude-Session: 1234"\n` +
        REWRITE +
        WHO +
        'team commits check: 3 commits checked, 1 by a human or a merge: 3 commits refused\n',
    );
  });

  test('names the prose case and the missing case apart', async () => {
    const prose = await run([hash.prose]);
    expect(prose.stdout).toContain('line 4: the signature shares its paragraph with prose ("Refs #3")');
    const missing = await run([hash.unsigned]);
    expect(missing.stdout).toContain('no signature: expected "Agent: {display} · {role}" in the final trailer block');
  });

  test('pr check reads the body from its own file', async () => {
    writeFileSync(join(repo.path, 'body.md'), `text\n\n${PR_SIGNATURE}\n`);
    const passed = await runPr(['body.md']);
    expect(passed).toEqual({ code: 0, stdout: 'team pr check: 1 pull request body checked: ok\n', stderr: '' });

    writeFileSync(join(repo.path, 'body.md'), 'text\n');
    const refused = await runPr(['body.md']);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain(
      'difference: pull request body: no signature: expected "**Agent:** {display} · {role}" in the last line',
    );
    expect(refused.stdout).toContain('the pull request body refused');
  });

  test('exits 2 when the body, the range or since cannot be read', async () => {
    expect(await runPr(['missing.md'])).toMatchObject({ code: 2, stdout: '' });
    expect(await run(['main..main'])).toEqual({
      code: 2,
      stdout: '',
      stderr: 'team commits check: the range "main..main" holds no commit\n',
    });
    expect((await run([hash.signed, '--since', hash.clean1])).code).toBe(2);
  });

  test('exits 2 on a usage error', async () => {
    expect((await run([])).stderr).toStartWith(
      'team commits check: a <ref> is required\nUsage: team commits check <ref> [--since <ref>] [--file <path>] [--json]',
    );
    expect((await run(['a', 'b'])).code).toBe(2);
    expect((await run(['main', '--force'])).stderr).toStartWith('team commits check: unknown option --force');
    expect((await run(['main', '--since'])).stderr).toStartWith('team commits check: --since needs a value');
  });

  test('reads the team file of the repository, and its since', async () => {
    const file = [
      'format: 1',
      'project: acme-web',
      'coordinator: lead',
      'operator: lead',
      'identity:',
      `  since: ${hash.spaces}`,
      '  humans: [jane@acme.example]',
      'workspace:',
      '  mode: shared',
      'seats:',
      '  - role: implementer',
      '    name: lead',
      '    cli: claude-code',
      '    vendor: anthropic',
      '    model: Claude Opus',
      '    version: "5.5"',
      '    launch: claude --model claude-opus-5-5',
      '',
    ].join('\n');
    mkdirSync(join(repo.path, '.agents'), { recursive: true });
    writeFileSync(join(repo.path, '.agents/team.yaml'), file);

    const passed = await run([`${hash.old}..main`], 'file');
    expect(passed).toEqual({
      code: 0,
      stdout:
        'COMMIT      STATUS  DETAIL\n' +
        `${hash.clean2.slice(0, 10)}  ok      feat: clean two\n` +
        `${hash.clean1.slice(0, 10)}  ok      feat: clean one\n` +
        `team commits check: 2 commits checked, 17 skipped (since ${hash.spaces.slice(0, 10)}): ok\n`,
      stderr: '',
    });
    expect((await run([hash.unsigned, '--since', hash.old], 'file')).code).toBe(1);

    writeFileSync(join(repo.path, 'other.yaml'), file.replace('5.5', '5.6'));
    const other = await run(['main', '--file', 'other.yaml'], 'file');
    expect(other.code).toBe(1);
    expect(other.stdout).toContain('a signature no seat of this team has had');

    writeFileSync(join(repo.path, '.agents/team.yaml'), file.replace('format: 1', 'format: 2'));
    const refused = await run(['main'], 'file');
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toMatch(/^team commits check: .*line 1: /);
  });

  test('a corrupt ledger exits 2 and names the file, with no stack', async () => {
    const file = [
      'format: 1',
      'project: acme-web',
      'coordinator: lead',
      'operator: lead',
      'workspace:',
      '  mode: shared',
      'seats:',
      '  - role: implementer',
      '    name: lead',
      '    cli: claude-code',
      '    vendor: anthropic',
      '    model: Claude Opus',
      '    version: "5.5"',
      '    launch: claude --model claude-opus-5-5',
      '',
    ].join('\n');
    writeFileSync(join(repo.path, '.agents/team.yaml'), file);
    const loaded = loadTeamFile(repo.path);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const home = mkdtempSync(join(tmpdir(), 'team-ledger-'));
    const ledgerFile = join(storePath(loaded.team.project, loaded.root, home), 'ledger.json');
    mkdirSync(join(ledgerFile, '..'), { recursive: true });
    writeFileSync(ledgerFile, '{ this is not json');
    const result = await run(['main'], (cwd, path) => loadConfig(cwd, path, home));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`can't read ${ledgerFile}`);
    expect(result.stderr).not.toContain('    at ');
  });

  test('exits 2 with the line when the team file is refused', async () => {
    const result = await run(['main'], () => ({
      ok: false,
      path: '.agents/team.yaml',
      errors: [{ line: 12, message: 'unknown field "sesion"' }],
    }));
    expect(result).toEqual({
      code: 2,
      stdout: '',
      stderr: 'team commits check: .agents/team.yaml, line 12: unknown field "sesion"\n',
    });
  });
});
