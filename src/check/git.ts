import { spawnSync } from 'node:child_process';
import { syncChildTimeout } from '../child.ts';

/** A git command that failed, or a ref that can't be used. */
export class GitError extends Error {}

export interface Commit {
  hash: string;
  parents: string[];
  authorEmail: string;
  subject: string;
  message: string;
  /** The lines of the final trailer block as git reads it; empty when it sees none. */
  trailers: string[];
}

export interface Selection {
  /** The commits to check, newest first. */
  commits: Commit[];
  /** Commits of the range that `since` leaves out. */
  skipped: number;
  /** `since` as a commit hash, when one applies. */
  since?: string;
}

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Set for every call, so the machine's git configuration can't change what is read. */
const CONFIGURATION = ['log.showSignature=false', 'i18n.logOutputEncoding=UTF-8', 'trailer.separators=:'].flatMap(
  (setting) => ['-c', setting],
);

function run(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', [...CONFIGURATION, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 1024,
    timeout: syncChildTimeout(15_000),
  });
  if (result.error) throw new GitError(`can't run git: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd: string, args: string[]): string {
  const result = run(cwd, args);
  if (result.status !== 0) {
    throw new GitError(result.stderr.trim() || `git ${args[0]} exited ${result.status}`);
  }
  return result.stdout;
}

function refuseOption(ref: string, what: string): void {
  if (ref === '' || ref.startsWith('-')) throw new GitError(`${what} ${JSON.stringify(ref)} is not a ref`);
}

/** The revision arguments for `<ref>`: a range as given, or that one commit. */
function revision(cwd: string, ref: string): string {
  refuseOption(ref, 'the ref');
  if (ref.includes('..')) return ref;
  const result = run(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  if (result.status !== 0) throw new GitError(`${JSON.stringify(ref)} doesn't name a commit`);
  return `${result.stdout.trim()}^!`;
}

/** The commits a range starts from: what `rev-parse` gives without a `^`. */
function tips(cwd: string, range: string): string[] {
  const result = run(cwd, ['rev-parse', '--revs-only', '--end-of-options', range]);
  if (result.status !== 0 || result.stdout.trim() === '') {
    throw new GitError(`the range ${JSON.stringify(range)} can't be resolved`);
  }
  return result.stdout.split('\n').filter((line) => line !== '' && !line.startsWith('^'));
}

const FIELDS = 6;
const FORMAT = ['%H', '%P', '%ae', '%s', '%B', '%(trailers)'].map((field) => `${field}%x00`).join('');

function parseLog(output: string): Commit[] {
  const fields = output.split('\0');
  const commits: Commit[] = [];
  for (let index = 0; index + FIELDS <= fields.length; index += FIELDS) {
    const [hash, parents, authorEmail, subject, message, trailers] = fields.slice(index, index + FIELDS) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    commits.push({
      // Each record ends with a newline, which lands before the next hash.
      hash: hash.trim(),
      parents: parents.split(' ').filter(Boolean),
      authorEmail,
      subject,
      message,
      trailers: trailers.split('\n').filter((line) => line.trim() !== ''),
    });
  }
  return commits;
}

/** A commit object's message, read whole: `git log --format=%B` stops at a NUL byte in it, while
 *  the object keeps the bytes after it and `git cat-file` prints them. */
function rawMessage(cwd: string, sha: string): string {
  const result = run(cwd, ['cat-file', 'commit', sha]);
  if (result.status !== 0) throw new GitError(`can't read the commit ${sha}`);
  let start = 0;
  while (start < result.stdout.length) {
    const end = result.stdout.indexOf('\n', start);
    if (end === -1) break;
    if (end === start) return result.stdout.slice(end + 1);
    start = end + 1;
  }
  throw new GitError(`the commit ${sha} carries no message`);
}

/**
 * The commits `check` reads for `<ref>`: the range as given when it holds
 * `..`, else that one commit, without what is reachable from `since`.
 * An empty or unresolvable range is an error, and so is a `since` that isn't
 * reachable from the range.
 */
export function selectCommits(cwd: string, ref: string, since?: string): Selection {
  const inside = run(cwd, ['rev-parse', '--git-dir']);
  if (inside.status !== 0) throw new GitError('not in a git repository');

  const range = revision(cwd, ref);
  const from = tips(cwd, range);
  const total = Number(git(cwd, ['rev-list', '--count', '--end-of-options', range]).trim());
  if (total === 0) throw new GitError(`the range ${JSON.stringify(ref)} holds no commit`);

  const revisions = [range];
  let sinceHash: string | undefined;
  if (since !== undefined) {
    refuseOption(since, 'since');
    const resolved = run(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${since}^{commit}`]);
    if (resolved.status !== 0) {
      throw new GitError(
        `since ${JSON.stringify(since)} doesn't name a commit here (a shallow clone doesn't hold the history it needs)`,
      );
    }
    sinceHash = resolved.stdout.trim();
    const reachable = from.some(
      (tip) => run(cwd, ['merge-base', '--is-ancestor', sinceHash as string, tip]).status === 0,
    );
    if (!reachable) {
      throw new GitError(`since ${JSON.stringify(since)} is not reachable from ${JSON.stringify(ref)}`);
    }
    revisions.push(`^${sinceHash}`);
  }

  const commits = parseLog(
    git(cwd, ['log', '--no-color', `--format=tformat:${FORMAT}`, '--end-of-options', ...revisions]),
  );
  for (const commit of commits) commit.message = rawMessage(cwd, commit.hash);
  return { commits, skipped: total - commits.length, since: sinceHash };
}
