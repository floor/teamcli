// A compose delivery: the profile's own module walks the CLI's screens and types the brief
// where the CLI asks for it. The caller keeps the seat lock, writes the drop file and writes
// the history; this file only builds what the module may see — the pane, the seat's folder,
// the repo its folder names, and the repos the CLI itself lists — and turns the module's
// answer into the send's three outcomes.
//
// The seat's folder is the pane's foreground cwd when herdr can name it, else the folder the
// seat's record carries. `git -C <folder> remote get-url origin` names the repo, and the
// profile's `reposArgs` run with its binary list the account's repos; both are read here,
// never by the module, which may not run a command.
import { execFileSync } from 'node:child_process';
import { stripSgr } from '../ansi.ts';
import { ComposeError, type ComposeIo, type ComposeProfile, type ComposeSeat } from '../profiles/compose.ts';
import type { NativePane } from './native.ts';

/** What one compose delivery needs besides the pane. */
export type ComposeRun = {
  profile: ComposeProfile;
  /** The profile's launch binary, for listing repos. */
  binary: string;
  session: string;
  pane: string;
  /** The folder the seat's record carries, used when the pane names none. */
  seatCwd: string;
  /** The profile's idle timeout in seconds. */
  idleTimeout: number;
  /** The brief, whole: rules and sender header included. */
  message: string;
};

/** The send's three outcomes, in the words the walk already reports. */
export type ComposeResult =
  | { outcome: 'delivered'; evidence: string }
  | { outcome: 'not-submitted'; reason: string }
  | { outcome: 'unreachable'; reason: string };

/** `owner/repo` from a git remote URL, or null. Both the scp form
 *  (`git@github.com:owner/repo.git`) and a URL (`https://github.com/owner/repo.git`,
 *  `ssh://git@github.com/owner/repo`) end at the same two path segments. */
export function repoFromUrl(url: string): string | null {
  const match = /[:/]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match === null ? null : match[1]!;
}

/** The origin repo of a folder, or null when the folder has no origin or git cannot be run. */
export function originRepo(dir: string): string | null {
  try {
    const url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    return repoFromUrl(url);
  } catch {
    return null;
  }
}

/** The repos the seat's CLI lists, in its own order, or null when it could not be asked. A line
 *  that is not `owner/repo` is not a repo and is dropped. */
export function listedRepos(binary: string, args: readonly string[], dir: string): string[] | null {
  try {
    const out = execFileSync(binary, [...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
    });
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(line));
  } catch {
    return null;
  }
}

/**
 * Runs the profile's compose module against the pane. A module that returns its proof line
 * delivered the brief; a ComposeError after the module typed is `not-submitted` (the box may
 * hold the text), and one before it is `unreachable` (nothing was typed). Every refusal carries
 * the module's repair line, so the operator reads what to do next in the same sentence.
 */
export async function deliverCompose(native: NativePane, run: ComposeRun): Promise<ComposeResult> {
  const cwd = native.foregroundCwd?.(run.session, run.pane) ?? run.seatCwd;
  const seat: ComposeSeat = {
    cwd,
    repo: originRepo(cwd),
    repos: run.profile.repos.length === 0 ? null : listedRepos(run.binary, run.profile.repos, cwd),
  };
  const io: ComposeIo = {
    text: () => {
      const raw = native.paneText?.(run.session, run.pane);
      return raw === null || raw === undefined ? null : stripSgr(raw);
    },
    type: (text) => native.typeText(run.session, run.pane, text),
    key: (key) => native.sendKey?.(run.session, run.pane, key) ?? false,
    wait: (ms) => native.wait(ms),
    idleTimeout: run.idleTimeout,
    seat,
  };
  try {
    const proof = await run.profile.compose(io, run.message);
    return { outcome: 'delivered', evidence: proof };
  } catch (error) {
    if (!(error instanceof ComposeError)) throw error;
    const reason = `${error.message}; ${error.repair}`;
    return error.typed ? { outcome: 'not-submitted', reason } : { outcome: 'unreachable', reason };
  }
}
