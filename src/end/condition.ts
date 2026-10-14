import { spawnSync } from 'node:child_process';
import { branchProblem } from './until.ts';

// Whether a temporary seat's `merged:` end holds. "Merged" is provable only when the branch had
// commits of its own on an earlier pass and, after a fetch that succeeded, it no longer does.
// A squash or a rebase does not put those commits in the base, and a deleted branch is the same
// shape, so both are reported and remove nothing.

export type MergeVerdict =
  | { verdict: 'merged'; detail: string }
  | { verdict: 'open'; detail: string }
  | { verdict: 'unproven'; detail: string };

export function judgeMerge(input: {
  fetch: 'ok' | 'failed';
  branch: 'present' | 'gone';
  /** `git rev-list <branch> --not origin/<base>` after the fetch. Empty when the branch has nothing of its own. */
  ownNow: readonly string[];
  /** True once an earlier pass saw a non-empty list. A branch that never had one is never merged. */
  ownBefore: boolean;
}): MergeVerdict {
  if (input.fetch === 'failed') {
    return { verdict: 'unproven', detail: 'the fetch failed; nothing is removed' };
  }
  if (input.branch === 'gone') {
    return {
      verdict: 'unproven',
      detail: 'the branch is gone; a squash or a rebase would look the same, so nothing is removed',
    };
  }
  if (input.ownNow.length > 0) {
    return { verdict: 'open', detail: 'the branch still has commits of its own' };
  }
  if (!input.ownBefore) {
    return { verdict: 'open', detail: 'the branch never had a commit of its own' };
  }
  return { verdict: 'merged', detail: 'its own commits are in the base' };
}

type Run = { code: number; stdout: string; stderr: string };

function git(cwd: string, args: string[]): Run {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** The branch is a local branch or a remote-tracking one. Null when git can't be asked. */
export function branchPresent(root: string, branch: string): boolean | null {
  const listed = git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']);
  if (listed.code !== 0) return null;
  return listed.stdout.split('\n').some((ref) => {
    if (ref === branch) return true;
    const slash = ref.indexOf('/');
    return slash > 0 && ref.slice(slash + 1) === branch;
  });
}

export type MergeRead = MergeVerdict & { ownNow: number };

/**
 * Reads the branch after fetching its base. `ownBefore` is the state's record. A failed fetch
 * or a missing branch does not say the work is merged.
 */
export function readMerge(root: string, branch: string, base: string, ownBefore: boolean): MergeRead {
  // A name stored before this check existed is refused here, and git is not run with it.
  if (branchProblem(root, branch)) {
    return { verdict: 'unproven', ownNow: 0, detail: 'the branch is not a name git accepts; nothing is removed' };
  }
  const upstream = git(root, ['rev-parse', '--abbrev-ref', `${base}@{upstream}`]);
  if (upstream.code !== 0) {
    return {
      verdict: 'unproven',
      ownNow: 0,
      detail: `base ${base} has no upstream, so the fetch can't be checked; nothing is removed`,
    };
  }
  const remote = upstream.stdout.trim();
  const slash = remote.indexOf('/');
  if (slash <= 0) return { verdict: 'unproven', ownNow: 0, detail: 'the fetch failed; nothing is removed' };
  const fetched = git(root, ['fetch', '--quiet', remote.slice(0, slash), remote.slice(slash + 1)]);
  if (fetched.code !== 0) return { ...judgeMerge({ fetch: 'failed', branch: 'present', ownNow: [], ownBefore }), ownNow: 0 };
  const present = branchPresent(root, branch);
  if (present === null) return { verdict: 'unproven', ownNow: 0, detail: 'the branch could not be read; nothing is removed' };
  if (!present) return { ...judgeMerge({ fetch: 'ok', branch: 'gone', ownNow: [], ownBefore }), ownNow: 0 };
  // `--end-of-options` keeps `branch` a revision. A bare `--` would make it a path.
  const listed = git(root, ['rev-list', '--oneline', '--end-of-options', branch, `^${remote}`]);
  if (listed.code !== 0) return { verdict: 'unproven', ownNow: 0, detail: 'the branch could not be read; nothing is removed' };
  const ownNow = listed.stdout.split('\n').filter((line) => line !== '');
  // A squash leaves the branch's commits in place while its tree matches the base. That is not a
  // merge this version can prove, and it is not treated as one. A branch whose tree still differs
  // is ordinary open work and stays quiet.
  if (ownNow.length > 0 && git(root, ['diff', '--quiet', '--end-of-options', remote, branch]).code === 0) {
    return { verdict: 'open', ownNow: ownNow.length, detail: 'merged? not provable' };
  }
  return { ...judgeMerge({ fetch: 'ok', branch: 'present', ownNow, ownBefore }), ownNow: ownNow.length };
}
