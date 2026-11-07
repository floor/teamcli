// The claim that spends a one-use token, shared by the daemon's chores and restore children.
//
// The daemon writes a token under the machine folder and names it on the child's command line.
// A child claims it here before acting: the claim is a rename, which the file system admits for
// exactly one mover of that name, so two processes started with the same token cannot both read
// it. The claimed copy is private to this process; it is read and unlinked in the same turn, and
// a token that cannot be claimed starts nothing. A writer sweeps the claimed copies a process
// left when it died between the rename and the unlink: they are inert (their name is not the
// source spelling a child can claim), and the sweep keeps the machine folder from collecting
// them. A sweep looks only at regular files directly inside the folder: a link is never followed.
import { lstatSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { claimedTokenPath, INHERIT_KINDS, INHERIT_NONCE_PATTERN } from './paths.ts';

/** The signal a liveness probe asks with: 0 asks whether the pid exists and sends nothing. */
export type KillProbe = (pid: number, signal: number) => unknown;

/** Whether a pid names a process this machine still has. The default `kill` is this module's
 *  one real probe: signal 0 reaches the kernel and carries nothing. A process this uid cannot
 *  signal still exists, so anything but "no such process" counts as alive. */
export function pidAlive(pid: number, kill: KillProbe = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** What a sweep asks about a claimed pid; a writer's default is `pidAlive`. */
export type LivenessProbe = (pid: number) => boolean;

/** The claimed copy's name: exactly the token spelling a writer produces, plus `.claim.<pid>`.
 *  Built from the same parts as the path builders, so the sweep and the writers cannot drift. */
const CLAIMED_NAME = new RegExp(
  `^(?:${INHERIT_KINDS.join('|')})\\.inherit\\.${INHERIT_NONCE_PATTERN}\\.json\\.claim\\.([1-9][0-9]*)$`,
);

/**
 * Removes the claimed copies under `dir` whose process is gone. Only regular files directly in
 * `dir` are candidates: a link is never followed, an entry whose pid is still alive stays, and
 * nothing outside `dir` is touched. Never throws.
 */
export function sweepSpentClaims(dir: string, isAlive: LivenessProbe): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // No machine folder yet: the write that called this is about to make one.
    return;
  }
  for (const name of names) {
    const match = CLAIMED_NAME.exec(name);
    if (match === null) continue;
    // The pattern already rejects a zero or signed pid; only the safe-integer bound is left.
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid)) continue;
    if (isAlive(pid)) continue;
    // A name read from the folder cannot carry a separator; refuse one anyway rather than build
    // a path out of the folder.
    if (name.includes('/') || name.includes('\\')) continue;
    const path = join(dir, name);
    try {
      if (!lstatSync(path).isFile()) continue;
    } catch {
      continue;
    }
    try {
      unlinkSync(path);
    } catch {
      // Already gone, or this uid cannot remove it: either way it is inert.
    }
  }
}

export type OneUseClaim =
  | { kind: 'ok'; text: string }
  | { kind: 'refused'; why: string };

/** Since a writer sweeps before it writes, its liveness answer is injectable: the spawners use
 *  the real probe, and a scene that plants a claimed copy answers through a fake. */
export type WriteTokenOptions = { isAlive?: LivenessProbe };

/** Claims the token at `path` and returns its text, or refuses. Never throws. */
export function claimOneUseToken(path: string): OneUseClaim {
  const claimed = claimedTokenPath(path, process.pid);
  try {
    renameSync(path, claimed);
  } catch {
    // No token, an already spent one, or a machine folder this uid cannot claim in.
    return { kind: 'refused', why: 'no one-use token names this child' };
  }
  let text: string;
  try {
    text = readFileSync(claimed, 'utf8');
  } catch {
    return { kind: 'refused', why: 'the claimed token cannot be read' };
  } finally {
    try {
      // Spent either way: a claimed copy that cannot be removed grants nothing further.
      unlinkSync(claimed);
    } catch {
      // Nothing is left to spend: the claim already took the name out of circulation.
    }
  }
  return { kind: 'ok', text };
}
