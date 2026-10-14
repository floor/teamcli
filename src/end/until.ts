import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

// What `--until` may name, shared by the command that stores it and by `readMerge`.
//
// A result path is checked lexically, and a symlink is not followed. `resolve` and
// `relative` do not call `realpath`, and this check never stats the path. An absolute
// form and any `..` segment are refused, including a `..` that would still land inside
// the project. The existence test that runs only after a path has been accepted
// (`existsSync`) does follow a link: a link that already sits inside the project can
// name a file outside it, and this check does not look through it.
//
// A branch is a name `git check-ref-format --branch` prints back unchanged, and it
// must not start with `-`. The leading `-` is refused before git is asked. Callers
// that pass an accepted name to `git diff` or `git rev-list` put it after
// `--end-of-options`. A bare `--` is not that separator: it makes the name a path.

const RELATIVE = 'a result path is relative to the project';

/** `null` when `path` is lexically inside `root`. A symlink is not followed. */
export function resultPathProblem(root: string, path: string): string | null {
  if (path === '' || path.startsWith('~') || isAbsolute(path) || win32.isAbsolute(path)) return RELATIVE;
  if (path.split(/[\\/]/).includes('..')) return RELATIVE;
  const rel = relative(root, resolve(root, path));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return RELATIVE;
  return null;
}

/** `null` when `branch` is a branch name git accepts and it does not start with `-`. */
export function branchProblem(root: string, branch: string): string | null {
  if (branch === '' || branch.startsWith('-')) return notABranch(branch);
  const checked = git(root, ['check-ref-format', '--branch', branch]);
  if (checked.code !== 0 || checked.stdout.trim() !== branch) return notABranch(branch);
  return null;
}

function notABranch(branch: string): string {
  return `${JSON.stringify(branch)} is not a branch name`;
}

function git(cwd: string, args: string[]): { code: number; stdout: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '' };
}
