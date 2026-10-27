// S1 of the command-name change, pinned: `team check <ref>` is `team commits check <ref>`, the
// `--pr` half is `team pr check <file>`, and the old spelling is read through 0.3.3 — the same
// report, the same exit, and one notice line naming the new command. Bare `team check` — and a
// line that spells only the check's own options — is the team check itself (S2): it reads the
// team and the world, prints its answer, needs no commit and takes no notice. `team pr check`
// runs in a folder with no repository at all.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, loadConfig, USAGE as CHECK_USAGE, type LoadConfig } from '../../src/commands/check.ts';
import type { CheckSources } from '../../src/check/team.ts';
import { KEY_ISOLATION_LINE } from '../../src/client/records.ts';
import { commits, USAGE as COMMITS_USAGE } from '../../src/commands/commits.ts';
import { pr } from '../../src/commands/pr.ts';
import type { Io } from '../../src/io.ts';
import { NOT_PRETENDED } from '../../src/permissions/must-not-pretend.ts';
import { config, PR_SIGNATURE, SIGNATURE } from '../check/fixtures.ts';
import { createRepository, type Repository } from '../check/repository.ts';

/** The notice the old spelling prints, and the twin the `--pr` form adds after it. */
const NOTICE = 'team check: `team check` is now `team commits check`, and is still read through 0.3.3\n';
const TWIN = 'team check: `team check --pr` is now `team pr check`, and is still read through 0.3.3\n';

/** The record's honesty block the team check prints under both of its answers; the sentences
 *  themselves are pinned in test/must-not-pretend.test.ts. */
const NOT_PRETENDED_BLOCK = `${NOT_PRETENDED.join('\n')}\n`;

/** A standing the verification refused: it still says what it is, and still carries the
 *  approval repair. A machine with no record at all carries neither. */
const REFUSED_WHY = 'the record is signed, but its key is missing';

/** The usage block an old spelling's refusal prints: the tail of the export, where the combined
 *  text keeps it byte for byte. */
const OLD_USAGE = CHECK_USAGE.slice(CHECK_USAGE.indexOf('Usage: team check <ref>'));

/** The file both folder cases load: one seat, no trust, no repository. */
const TEAM = [
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

let repo: Repository;
const hash = {} as Record<'clean' | 'unsigned' | 'forbidden', string>;

beforeAll(() => {
  repo = createRepository();
  hash.clean = repo.commit(`feat: a clean one\n\n${SIGNATURE}`);
  hash.unsigned = repo.commit('fix: unsigned\n\nSome prose.');
  hash.forbidden = repo.commit(`feat: a session line\n\nClaude-Session: 1234\n\n${SIGNATURE}`);
});

afterAll(() => repo.remove());

/** The file the repo cases load: the fixtures' config, whole. */
const load = () => ({ ok: true as const, config: config(), warnings: [] });

type Command = (argv: string[], io: Io, load: LoadConfig) => Promise<number>;

async function run(command: Command, argv: string[]) {
  let stdout = '';
  let stderr = '';
  const io = {
    stdout: (text: string) => void (stdout += text),
    stderr: (text: string) => void (stderr += text),
    cwd: repo.path,
    env: {},
    stdinIsTTY: false,
  };
  const code = await command(argv, io, load);
  return { code, stdout, stderr };
}

/** The team check's own form, in a folder of its own with the world handed in: no herdr, no
 *  store and no home of the invoker's are read. */
async function runCheck(cwd: string, argv: string[], sources: CheckSources) {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: (text: string) => void (stdout += text),
    stderr: (text: string) => void (stderr += text),
    cwd,
    env: {},
    stdinIsTTY: false,
    caller: { kind: 'owner' },
  };
  const code = await check(argv, io, load as LoadConfig, sources);
  return { code, stdout, stderr };
}

describe('the old spelling is the new run, one notice line first', () => {
  // The tails are built lazily: the hashes exist only after `beforeAll`.
  const cases: { label: string; tail: () => string[]; exit: number }[] = [
    { label: 'a passing commit', tail: () => [hash.clean], exit: 0 },
    { label: 'a refused commit', tail: () => [hash.unsigned], exit: 1 },
    { label: 'a refused commit that leaks a line', tail: () => [hash.forbidden], exit: 1 },
    { label: 'a range', tail: () => [`${hash.clean}..${hash.forbidden}`], exit: 1 },
    { label: 'a ref that names nothing', tail: () => ['not-a-ref'], exit: 2 },
    { label: 'a range that cannot be resolved', tail: () => ['missing..also'], exit: 2 },
    { label: 'a range that holds no commit', tail: () => [`${hash.clean}..${hash.clean}`], exit: 2 },
  ];
  for (const item of cases) {
    test(`${item.label}: the same report and the same exit`, async () => {
      const old = await run(check, item.tail());
      const now = await run(commits, ['check', ...item.tail()]);
      expect(old.code).toBe(item.exit);
      expect(now.code).toBe(item.exit);
      expect(old.stdout).toBe(now.stdout);
      expect(old.stderr).toBe(`${NOTICE}${now.stderr}`);
    });
  }

  test('a refused invocation keeps its old bytes and takes no notice', async () => {
    const refusals: string[][] = [['a', 'b'], ['main', '--force'], ['main', '--since']];
    for (const tail of refusals) {
      const old = await run(check, tail);
      const now = await run(commits, ['check', ...tail]);
      expect(old.code).toBe(2);
      expect(now.code).toBe(2);
      // The same refusal line, under the new name, and no notice: an error already says what to
      // fix. The usage below it is each command's own — the old form alone takes `--pr`.
      const first = (text: string) => text.split('\n')[0] ?? '';
      expect(first(old.stderr).replace('team check:', 'team commits check:')).toBe(first(now.stderr));
      expect(old.stderr).toEndWith(OLD_USAGE);
      expect(now.stderr).toEndWith(COMMITS_USAGE);
      expect(old.stderr).not.toContain('is now');
    }
  });

  test('bare team check is the team check itself: it reads the team and prints its answer', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'team-names-bare-'));
    const home = mkdtempSync(join(tmpdir(), 'team-names-bare-home-'));
    try {
      mkdirSync(join(folder, '.agents'), { recursive: true });
      writeFileSync(join(folder, '.agents', 'team.yaml'), TEAM);
      const ran = await runCheck(folder, [], {
        live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
        branch: () => 'main',
        standing: () => ({ kind: 'none' }),
        now: () => new Date(0),
        home,
      });
      expect(ran.code).toBe(1);
      // A machine that never approved the file carries no row and marks no repair: the report is
      // the file's state alone.
      expect(ran.stdout).toBe(
        'team acme-web, session "acme-web"\n' +
          `${KEY_ISOLATION_LINE}\n` +
          'warning: the file, line 3: `coordinator:` is now `leads: true` on the lead\'s seat, and is still read; repair: set `leads: true` on the lead\'s seat and remove `coordinator:` from team config\n' +
          'difference: lead is in the file and is not running\n' +
          '  repair: team up\n' +
          '  who: the owner\n' +
          '1 difference, 1 for the owner\n',
      );
      expect(ran.stderr).toBe('');
      // A standing that still says something keeps its row first, and the row marks the repairs
      // that wait on it.
      const refused = await runCheck(folder, [], {
        live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
        branch: () => 'main',
        standing: () => ({ kind: 'refused', why: REFUSED_WHY }),
        now: () => new Date(0),
        home,
      });
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe(
        'team acme-web, session "acme-web"\n' +
          `${KEY_ISOLATION_LINE}\n` +
          'warning: the file, line 3: `coordinator:` is now `leads: true` on the lead\'s seat, and is still read; repair: set `leads: true` on the lead\'s seat and remove `coordinator:` from team config\n' +
          `difference: ${REFUSED_WHY}\n` +
          '  repair: the live file is what the commands read\n' +
          '  who: the owner\n' +
          'difference: lead is in the file and is not running\n' +
          '  repair: team up (after: the live file is what the commands read)\n' +
          '  who: the owner\n' +
          '2 differences, 2 for the owner\n',
      );
      expect(refused.stderr).toBe('');
    } finally {
      rmSync(folder, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the --pr form runs both halves and prints both notices, the commits one first', async () => {
    writeFileSync(join(repo.path, 'body.md'), `${PR_SIGNATURE}\n`);
    const old = await run(check, [hash.clean, '--pr', 'body.md']);
    expect(old.code).toBe(0);
    expect(old.stdout).toBe(
      'COMMIT      STATUS  DETAIL\n' +
        `${hash.clean.slice(0, 10)}  ok      feat: a clean one\n` +
        'team commits check: 1 commit checked, 1 pull request body checked: ok\n',
    );
    expect(old.stderr).toBe(`${NOTICE}${TWIN}`);

    const committed = await run(commits, ['check', hash.clean]);
    const body = await run(pr, ['check', 'body.md']);
    expect(committed).toEqual({
      code: 0,
      stdout:
        'COMMIT      STATUS  DETAIL\n' +
        `${hash.clean.slice(0, 10)}  ok      feat: a clean one\n` +
        'team commits check: 1 commit checked: ok\n',
      stderr: '',
    });
    expect(body).toEqual({ code: 0, stdout: 'team pr check: 1 pull request body checked: ok\n', stderr: '' });
  });

  test('a refused body: the old report is the two new ones, findings and exit both', async () => {
    writeFileSync(join(repo.path, 'body.md'), 'Bump the retry window to thirty seconds.\n');
    const old = await run(check, [hash.clean, '--pr', 'body.md']);
    const committed = await run(commits, ['check', hash.clean]);
    const body = await run(pr, ['check', 'body.md']);

    expect(old.code).toBe(1);
    expect(committed.code).toBe(0);
    expect(body.code).toBe(1);
    expect(old.stdout).toContain('pull request body');
    expect(old.stdout).toContain('no signature: expected "**Agent:** {display} · {role}" in the last line');

    // The old closing line covers both halves; the findings above it are the two new reports,
    // each without its own closing line, in order.
    const lines = (text: string) => text.replace(/\n$/, '').split('\n');
    expect(lines(old.stdout).at(-1)).toBe(
      'team commits check: 1 commit checked, 1 pull request body checked: the pull request body refused',
    );
    expect(lines(old.stdout).slice(0, -1)).toEqual([
      ...lines(committed.stdout).slice(0, -1),
      ...lines(body.stdout).slice(0, -1),
    ]);
  });

  test('a body file that cannot be read refuses under the body check’s name', async () => {
    const old = await run(check, [hash.clean, '--pr', 'missing.md']);
    expect(old.code).toBe(2);
    expect(old.stdout).toBe('');
    expect(old.stderr).toStartWith(`${NOTICE}${TWIN}team pr check: can't read the pull request body: ENOENT: `);
  });
});

describe('team pr check needs no repository', () => {
  test('checks a body in a folder that is not a repository', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'team-names-plain-'));
    const home = mkdtempSync(join(tmpdir(), 'team-names-home-'));
    try {
      mkdirSync(join(folder, '.agents'), { recursive: true });
      writeFileSync(join(folder, '.agents', 'team.yaml'), TEAM);
      writeFileSync(join(folder, 'body.md'), `${PR_SIGNATURE}\n`);
      let stdout = '';
      let stderr = '';
      const io: Io = {
        stdout: (text) => void (stdout += text),
        stderr: (text) => void (stderr += text),
        cwd: folder,
        env: {},
        stdinIsTTY: false,
      };
      const code = await pr(['check', 'body.md'], io, (cwd, file) => loadConfig(cwd, file, home));
      expect(code).toBe(0);
      expect(stdout).toBe('team pr check: 1 pull request body checked: ok\n');
      expect(stderr).toBe('');
    } finally {
      rmSync(folder, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
