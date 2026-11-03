// The claim that spends a one-use token, shared by the daemon's chores and restore children.
//
// The daemon writes a token under the machine folder and names it on the child's command line.
// A child claims it here before acting: the claim is a rename, which the file system admits for
// exactly one mover of that name, so two processes started with the same token cannot both read
// it. The claimed copy is private to this process; it is read and unlinked in the same turn, and
// a token that cannot be claimed starts nothing.
import { readFileSync, renameSync, unlinkSync } from 'node:fs';

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
