import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const AGENT_EMAIL = 'agent@example.test';
export const HUMAN_EMAIL = 'jane@acme.example';

export interface Repository {
  path: string;
  git(...args: string[]): string;
  /** An empty commit with this message, kept byte for byte when `verbatim`; returns its hash. */
  commit(message: string, email?: string, verbatim?: boolean): string;
  /** A commit object written literally, so its message can hold a NUL byte that `git commit`
   *  refuses; stored without a ref, and its hash returned. */
  literal(message: string, parent: string): string;
  remove(): void;
}

/** A git repository in a temporary folder, untouched by the machine's git configuration. */
export function createRepository(): Repository {
  const path = mkdtempSync(join(tmpdir(), 'team-check-'));
  let clock = 1_780_000_000;

  const git = (args: string[], email = AGENT_EMAIL, input?: string): string => {
    const date = `${clock++} +0000`;
    const result = spawnSync('git', args, {
      cwd: path,
      encoding: 'utf8',
      input,
      env: {
        PATH: process.env.PATH,
        HOME: path,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: email,
        GIT_COMMITTER_DATE: date,
      },
    });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };

  git(['init', '--quiet', '--initial-branch=main']);

  return {
    path,
    git: (...args) => git(args),
    commit(message, email, verbatim = false) {
      const cleanup = verbatim ? ['--cleanup=verbatim'] : [];
      git(['commit', '--quiet', '--allow-empty', '--no-gpg-sign', ...cleanup, '-F', '-'], email, message);
      return git(['rev-parse', 'HEAD']);
    },
    literal(message, parent) {
      const tree = git(['rev-parse', `${parent}^{tree}`]);
      const object = [
        `tree ${tree}`,
        `parent ${parent}`,
        `author Test <${AGENT_EMAIL}> 1700000000 +0000`,
        `committer Test <${AGENT_EMAIL}> 1700000000 +0000`,
        '',
        message,
      ].join('\n');
      return git(['hash-object', '--literally', '-t', 'commit', '-w', '--stdin'], AGENT_EMAIL, object);
    },
    remove: () => rmSync(path, { recursive: true, force: true }),
  };
}
