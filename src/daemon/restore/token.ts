// The one-use token that proves a restore child was started by this machine daemon.
//
// The daemon writes it under the machine folder (mode 0600) and starts the child with its nonce
// on the command line; the child claims it by rename, reads the claimed copy, and runs the one
// route it carries. The rename is atomic, so two children started with one nonce cannot both
// claim it: exactly one runs. Any token presented is consumed, readable or not. The token is the
// child's whole authority to act as the daemon's owner-level restore pass: a child started any
// other way — no token, a nonce this program would not write, an already spent token, or another
// uid that cannot read a 0600 file under this machine folder — refuses and runs nothing. Nothing
// about having been spawned stands in for the token.
//
// It lives in its own module so the child's entry can read a token without loading the spawner.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { claimOneUseToken } from '../one-use-token.ts';
import { machineConfigDir, restoreInheritPath } from '../paths.ts';

/** What one restore pass may act on: the route and the home its reads resolve under. */
export type RestoreChildRequest = {
  version: 1;
  home: string;
  root: string;
  /** The team file the route was loaded from, when it is a `team-file` route. */
  teamFile?: string;
};

/** Whether a token's request is one this child can run. A refusal names the field. */
export function restoreRequestProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'the token carries no request';
  const request = raw as Record<string, unknown>;
  if (request.version !== 1) return 'the token names an unknown format';
  if (typeof request.home !== 'string' || request.home === '') return 'the token names no home';
  if (typeof request.root !== 'string' || request.root === '') return 'the token names no root';
  if (request.teamFile !== undefined && (typeof request.teamFile !== 'string' || request.teamFile === '')) {
    return 'the token names a malformed team file';
  }
  return null;
}

/** Writes the one-use token a child reads. Returns its nonce. */
export function writeRestoreInherit(request: RestoreChildRequest): string {
  const nonce = randomBytes(16).toString('hex');
  const dir = machineConfigDir(request.home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = restoreInheritPath(request.home, nonce);
  writeFileSync(path, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return nonce;
}

/** Removes a token this process wrote that no child can read any more (a start that failed).
 *  Idempotent and never throws. */
export function discardRestoreInherit(home: string, nonce: string): void {
  try {
    unlinkSync(restoreInheritPath(home, nonce));
  } catch {
    // Already consumed or never written: nothing is left behind either way.
  }
}

export type RestoreInheritRead =
  | { kind: 'ok'; request: RestoreChildRequest }
  | { kind: 'refused'; why: string };

/**
 * Reads and consumes the token named on a child's command line. The nonce is restricted to the
 * exact spelling this program writes, so a command line cannot point the reader at another file.
 * The claim is shared with the chores child: a rename, so a second child started with the same
 * nonce finds no token and refuses.
 */
export function readRestoreInherit(home: string, nonce: string): RestoreInheritRead {
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    return { kind: 'refused', why: 'the token name is not one this daemon writes' };
  }
  const claimed = claimOneUseToken(restoreInheritPath(home, nonce));
  if (claimed.kind === 'refused') return claimed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(claimed.text);
  } catch {
    return { kind: 'refused', why: 'the token is not readable JSON' };
  }
  const problem = restoreRequestProblem(parsed);
  if (problem !== null) return { kind: 'refused', why: problem };
  return { kind: 'ok', request: parsed as RestoreChildRequest };
}
