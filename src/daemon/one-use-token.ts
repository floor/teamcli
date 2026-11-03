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

/** Whether a pid names a process this machine still has. A process this uid cannot signal still
 *  exists, so anything but "no such process" counts as alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The claimed copy's name: the source token path plus `.claim.<pid>`. */
const CLAIMED_NAME = /\.claim\.(\d+)$/;

/**
 * Removes the claimed copies under `dir` whose process is gone. Only regular files directly in
 * `dir` are candidates: a link is never followed, an entry whose pid is still alive stays, and
 * nothing outside `dir` is touched. Never throws.
 */
export function sweepSpentClaims(dir: string, isAlive: (pid: number) => boolean = pidAlive): void {
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
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
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

/** Claims the token at `path` and returns its text, or refuses. Never throws. */
export function claimOneUseToken(path: string): OneUseClaim {
  const claimed = `${path}.claim.${process.pid}`;
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
