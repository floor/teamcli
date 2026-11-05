// The one-use door and token that prove a restore child was started by this machine daemon.
//
// Following the Seam B restart-door pattern (`src/seat-health/restart-door.ts`):
// 1. The daemon writes `restore.inherit.<nonce>.json` under the machine folder (mode 0600,
//    created exclusively) carrying the route claims (`version`, `home`, `root`, optional
//    `teamFile`), a short expiry (`exp`), the daemon's own PID (`daemonPid`), and the SHA-256
//    hash of a random 256-bit secret (`secretHash`) — never the raw secret itself.
// 2. The daemon passes `{ nonce, secret }` only on inherited file descriptor 3 (a pipe closed
//    after writing).
// 3. The restore child (`./entry.ts`) reads descriptor 3, verifies that `daemonPid` is among its
//    own ancestor processes (`readAncestors`) and that `sha256(secret) === secretHash` before
//    claiming the token by atomic rename (`claimOneUseToken`), and checks `now < exp`. An
//    unauthorized caller without the inherited descriptor, with a wrong secret, or without the
//    daemon PID among its ancestors is refused and spends nothing it should not.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, fstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { readAncestors } from '../../caller.ts';
import { claimOneUseToken } from '../one-use-token.ts';
import { machineConfigDir, restoreInheritPath } from '../paths.ts';

export const RESTORE_DOOR_FD = 3;
export const RESTORE_DOOR_MS = 2 * 60 * 1000;

/** What one restore pass may act on: the route and the home its reads resolve under. */
export type RestoreChildRequest = {
  version: 1;
  home: string;
  root: string;
  /** The team file the route was loaded from, when it is a `team-file` route. */
  teamFile?: string;
};

/** The on-disk claims written to `restore.inherit.<nonce>.json`. Holds `secretHash`, never the
 *  raw secret. */
export type RestoreClaims = RestoreChildRequest & {
  exp: string;
  daemonPid: number;
  secretHash: string;
};

export type RestoreDoorMint = RestoreChildRequest & {
  daemonPid?: number;
  now?: Date;
};

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Whether a token's request fields are ones this child can run. A refusal names the field. */
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

/** Whether the on-disk claims carry both a valid request and valid door metadata (`exp`,
 *  `daemonPid`, `secretHash`). */
export function restoreClaimsProblem(raw: unknown): string | null {
  const reqProblem = restoreRequestProblem(raw);
  if (reqProblem !== null) return reqProblem;
  const claims = raw as Record<string, unknown>;
  if (typeof claims.exp !== 'string' || claims.exp === '' || !Number.isFinite(Date.parse(claims.exp))) {
    return 'the token names no expiry';
  }
  if (!Number.isInteger(claims.daemonPid) || (claims.daemonPid as number) <= 0) {
    return 'the token names no daemon pid';
  }
  if (typeof claims.secretHash !== 'string' || !/^[0-9a-f]{64}$/.test(claims.secretHash)) {
    return 'the token names no secret hash';
  }
  return null;
}

/** Writes the on-disk hash + claims file (mode 0600, exclusive) and returns the `{ nonce, secret }`
 *  pair that the daemon passes on inherited descriptor 3. */
export function writeRestoreDoor(input: RestoreDoorMint): { nonce: string; secret: string } {
  const nonce = randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const now = input.now ?? new Date();
  const claims: RestoreClaims = {
    version: 1,
    home: input.home,
    root: input.root,
    ...(input.teamFile === undefined ? {} : { teamFile: input.teamFile }),
    exp: new Date(now.getTime() + RESTORE_DOOR_MS).toISOString(),
    daemonPid: input.daemonPid ?? process.pid,
    secretHash: sha256(secret),
  };
  const dir = machineConfigDir(input.home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = restoreInheritPath(input.home, nonce);
  writeFileSync(path, `${JSON.stringify(claims)}\n`, { flag: 'wx', mode: 0o600 });
  chmodSync(path, 0o600);
  return { nonce, secret };
}

/** Writes the one-use token file and returns its nonce. */
export function writeRestoreInherit(request: RestoreDoorMint): string {
  return writeRestoreDoor(request).nonce;
}

/** The bytes the daemon writes to inherited descriptor 3 and closes so the child reads to EOF. */
export function restoreDoorText(nonce: string, secret: string): string {
  return `${JSON.stringify({ nonce, secret })}\n`;
}

/** Reads descriptor 3 when it is an inherited pipe or socketpair. Any other descriptor, or none,
 *  is no door. */
export function readRestoreDoor(fd = RESTORE_DOOR_FD): string | null {
  try {
    const stat = fstatSync(fd);
    if (!stat.isFIFO() && !stat.isSocket()) return null;
    const text = readFileSync(fd, 'utf8');
    return text.trim() === '' ? null : text;
  } catch {
    return null;
  }
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

function cleanRequestOf(claims: RestoreChildRequest): RestoreChildRequest {
  return {
    version: 1,
    home: claims.home,
    root: claims.root,
    ...(claims.teamFile === undefined ? {} : { teamFile: claims.teamFile }),
  };
}

/**
 * Verifies the inherited descriptor (`{ nonce, secret }`), checks that `daemonPid` is among this
 * process's ancestors and that `sha256(secret)` matches `secretHash` before spending a valid
 * token file, atomically claims the file by rename (`claimOneUseToken`), and checks `now < exp`.
 */
export function acceptRestoreDoor(input: {
  home: string;
  nonce: string;
  text: string | null;
  now?: Date;
  ancestors?: readonly { pid: number }[] | null;
}): RestoreInheritRead {
  if (!/^[0-9a-f]{32}$/.test(input.nonce)) {
    return { kind: 'refused', why: 'the token name is not one this daemon writes' };
  }
  const path = restoreInheritPath(input.home, input.nonce);
  if (!existsSync(path)) {
    return { kind: 'refused', why: 'no one-use token names this child' };
  }
  if (input.text === null) {
    return { kind: 'refused', why: 'the restore child was started without an inherited door descriptor' };
  }
  let doorParsed: unknown;
  try {
    doorParsed = JSON.parse(input.text);
  } catch {
    return { kind: 'refused', why: 'the restore door descriptor is not readable JSON' };
  }
  if (doorParsed === null || typeof doorParsed !== 'object' || Array.isArray(doorParsed)) {
    return { kind: 'refused', why: 'the restore door descriptor carries no secret' };
  }
  const doorRaw = doorParsed as Record<string, unknown>;
  if (typeof doorRaw.nonce !== 'string' || doorRaw.nonce !== input.nonce) {
    return { kind: 'refused', why: 'the token name does not match the inherited door descriptor' };
  }
  if (typeof doorRaw.secret !== 'string' || !/^[0-9a-f]{64}$/.test(doorRaw.secret)) {
    return { kind: 'refused', why: 'the restore door descriptor carries no secret' };
  }

  const ancestors = input.ancestors === undefined ? readAncestors() : input.ancestors;
  if (ancestors === null || ancestors.length === 0) {
    return { kind: 'refused', why: 'the restore child ancestors could not be read' };
  }

  // Pre-check `secretHash` and `daemonPid` before renaming so an unauthenticated process on the
  // same UID (without the descriptor secret or without the daemon among its ancestors) cannot
  // spend the real child's token.
  let preText: string;
  try {
    preText = readFileSync(path, 'utf8');
  } catch {
    return { kind: 'refused', why: 'no one-use token names this child' };
  }
  let preParsed: unknown;
  try {
    preParsed = JSON.parse(preText);
  } catch {
    preParsed = null;
  }
  if (preParsed !== null && restoreClaimsProblem(preParsed) === null) {
    const preClaims = preParsed as RestoreClaims;
    if (sha256(doorRaw.secret) !== preClaims.secretHash) {
      return { kind: 'refused', why: 'the restore door secret does not match the token' };
    }
    if (!ancestors.some((proc) => proc.pid === preClaims.daemonPid)) {
      return { kind: 'refused', why: 'the restore child is not a descendant of the daemon that minted the token' };
    }
  }

  const claimed = claimOneUseToken(path);
  if (claimed.kind === 'refused') return claimed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(claimed.text);
  } catch {
    return { kind: 'refused', why: 'the token is not readable JSON' };
  }
  const problem = restoreClaimsProblem(parsed);
  if (problem !== null) return { kind: 'refused', why: problem };
  const claims = parsed as RestoreClaims;
  if (sha256(doorRaw.secret) !== claims.secretHash) {
    return { kind: 'refused', why: 'the restore door secret does not match the token' };
  }
  if (!ancestors.some((proc) => proc.pid === claims.daemonPid)) {
    return { kind: 'refused', why: 'the restore child is not a descendant of the daemon that minted the token' };
  }
  const exp = Date.parse(claims.exp);
  const now = input.now ?? new Date();
  if (!Number.isFinite(exp) || now.getTime() >= exp) {
    return { kind: 'refused', why: 'the restore token has expired' };
  }
  return { kind: 'ok', request: cleanRequestOf(claims) };
}

/**
 * Reads and consumes the token named on a child's command line (format and atomic rename claim).
 * The restore child entry (`./entry.ts`) uses `acceptRestoreDoor`, which additionally enforces
 * the inherited descriptor secret, expiry, and daemon ancestor check.
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
  return { kind: 'ok', request: cleanRequestOf(parsed as RestoreChildRequest) };
}
