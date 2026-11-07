// The one-use token that proves a wake child was started by this machine daemon.
//
// The daemon writes it under the machine folder (mode 0600) and starts the child with its nonce
// on the command line; the child claims it by rename, reads the claimed copy, and runs the one
// wake it carries. The rename is atomic, so two children started with one nonce cannot both
// claim it: exactly one wakes. Any token presented is consumed, readable or not. The token is
// the child's whole authority to type: nothing a seat can write — a record field, a marker, an
// environment value — decides identity, the pane, or the line.
//
// It lives in its own module so the child's entry can read a token without loading the spawner.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { claimOneUseToken, pidAlive, sweepSpentClaims, type WriteTokenOptions } from '../one-use-token.ts';
import { machineConfigDir, wakeInheritPath } from '../paths.ts';

/** One typed wake, as the daemon validated and staged it. The child re-reads the pane live and
 *  locks the seat itself; these values are what the daemon admitted, not a promise about a
 *  screen. */
export type WakeChildRequest = {
  version: 1;
  /** The message id the staged copy and the wake marker are held under. */
  id: string;
  seat: string;
  session: string;
  /** The receiving seat's CLI, whose profile declared the typed wake. */
  cli: string;
  /** The one trigger line: no control character, within the measured bound. */
  line: string;
  /** The daemon's staged copy in `<storeDir>/drops/<session>/<seat>/<id>` (0600); the wake
   *  marker lives beside it. */
  dropPath: string;
  /** The folder the seat's locks, records and log live in (the presence folder, today
   *  `.agents`), never the store's drop folder and never the caller's guess. */
  dir: string;
  /** The receiving checkout's canonical root: where the history and the trace are filed. */
  root: string;
  /** The receiving team's project store key. */
  project: string;
  /** The home the child's store and log resolve under. */
  home: string;
  /** The sender and the message the staged copy holds: what the child's history line keeps. */
  from: string;
  body: string;
  spec?: string;
  resolved?: string;
  from_team?: string;
  failed?: string[];
  /** When the daemon staged the copy (epoch ms): the child's trace counts its two times from it. */
  stagedAt: number;
};

/** Whether a token's request is one this child can run. A refusal names the field. */
export function wakeRequestProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'the token carries no wake request';
  const request = raw as Record<string, unknown>;
  if (request.version !== 1) return 'the token names an unknown format';
  const text = ['id', 'seat', 'session', 'cli', 'line', 'dropPath', 'dir', 'root', 'project', 'home', 'from'] as const;
  for (const field of text) {
    if (typeof request[field] !== 'string' || request[field] === '') return `the token names no ${field}`;
  }
  if (typeof request.body !== 'string') return 'the token names no body';
  for (const field of ['spec', 'resolved', 'from_team'] as const) {
    if (request[field] !== undefined && typeof request[field] !== 'string') return `the token carries a malformed ${field}`;
  }
  const failed = request.failed;
  if (failed !== undefined && (!Array.isArray(failed) || failed.some((one) => typeof one !== 'string'))) {
    return 'the token carries a malformed failure list';
  }
  if (typeof request.stagedAt !== 'number' || !Number.isFinite(request.stagedAt)) return 'the token names no staging time';
  return null;
}

/** Writes the one-use token a child reads. Returns its nonce. */
export function writeWakeInherit(request: WakeChildRequest, options: WriteTokenOptions = {}): string {
  const nonce = randomBytes(16).toString('hex');
  const dir = machineConfigDir(request.home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepSpentClaims(dir, options.isAlive ?? pidAlive);
  const path = wakeInheritPath(request.home, nonce);
  writeFileSync(path, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return nonce;
}

/** Removes a token this process wrote that no child can read any more (a start that failed).
 *  Idempotent and never throws. */
export function discardWakeInherit(home: string, nonce: string): void {
  try {
    unlinkSync(wakeInheritPath(home, nonce));
  } catch {
    // Already consumed or never written: nothing is left behind either way.
  }
}

export type WakeInheritRead =
  | { kind: 'ok'; request: WakeChildRequest }
  | { kind: 'refused'; why: string };

/**
 * Reads and consumes the token named on a child's command line. The nonce is restricted to the
 * exact spelling this program writes, so a command line cannot point the reader at another file.
 * The claim is shared with the chores and restore children: a rename, so a second child started
 * with the same nonce finds no token and refuses.
 */
export function readWakeInherit(home: string, nonce: string): WakeInheritRead {
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    return { kind: 'refused', why: 'the token name is not one this daemon writes' };
  }
  const claimed = claimOneUseToken(wakeInheritPath(home, nonce));
  if (claimed.kind === 'refused') return claimed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(claimed.text);
  } catch {
    return { kind: 'refused', why: 'the token is not readable JSON' };
  }
  const problem = wakeRequestProblem(parsed);
  if (problem !== null) return { kind: 'refused', why: problem };
  return { kind: 'ok', request: parsed as WakeChildRequest };
}
