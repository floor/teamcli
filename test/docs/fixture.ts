// The project, home and git history one page's examples run against. The clock and the author are
// pinned, and git's own configuration is shut out, so commit hashes and messages come out the same
// on every machine — the pages print them.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const AGENT_EMAIL = 'agent@example.test';
export const HUMAN_EMAIL = 'jane@acme.example';

export type GitRun = { code: number; stdout: string; stderr: string };

export type Fixture = {
  /** The temporary folder holding the project and the home, both removed together. */
  base: string;
  /** The project's real path; the pages show it as `.`. */
  root: string;
  /** The user-level store's home; the pages show it as `~`. */
  home: string;
  git(...args: string[]): GitRun;
  /** An empty commit with this message and author; returns its hash. */
  commit(message: string, email?: string): string;
  /** Writes one file of the project; `exec` makes it runnable, as a check script has to be. */
  write(relative: string, text: string, exec?: boolean): void;
  remove(): void;
};

export function createFixture(project: string, clock: { at: number }): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-docs-')));
  const home = join(base, 'home');
  const root = join(home, 'Code', project);
  mkdirSync(home);
  mkdirSync(root, { recursive: true });

  const git = (...args: string[]): GitRun => {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: AGENT_EMAIL,
        GIT_AUTHOR_DATE: `${clock.at} +0000`,
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: AGENT_EMAIL,
        GIT_COMMITTER_DATE: `${clock.at} +0000`,
      },
    });
    return { code: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };

  const run = (args: string[], email: string, input?: string): GitRun => {
    clock.at++;
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      input,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: `${clock.at} +0000`,
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: email,
        GIT_COMMITTER_DATE: `${clock.at} +0000`,
      },
    });
    if ((result.status ?? 1) !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return { code: 0, stdout: result.stdout.trim(), stderr: '' };
  };

  const init = git('init', '--quiet', '--initial-branch=main');
  if (init.code !== 0) throw new Error(`git init: ${init.stderr}`);

  // A page writes its files in the order it shows them. Commands that sort by mtime (team drops)
  // must see that order even when two writes land in the same clock tick.
  let writtenAt = Date.now();
  return {
    base,
    root,
    home,
    git,
    commit(message, email = AGENT_EMAIL) {
      run(['commit', '--quiet', '--allow-empty', '--no-gpg-sign', '--cleanup=verbatim', '-F', '-'], email, message);
      return run(['rev-parse', 'HEAD'], email).stdout;
    },
    write(relative, text, exec = false) {
      const path = join(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, exec ? { mode: 0o755 } : {});
      writtenAt += 1000;
      const at = new Date(writtenAt);
      utimesSync(path, at, at);
    },
    remove: () => rmSync(base, { recursive: true, force: true }),
  };
}
