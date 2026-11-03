// The one-use token that proves a chores child was started by this machine daemon.
//
// The daemon writes it under the machine folder (mode 0600) and starts the child with its nonce
// on the command line; the child claims it by rename, reads the claimed copy, and serves the
// configuration it carries. The rename is atomic, so two children started with one nonce cannot
// both claim it: exactly one serves. Any token presented is consumed, readable or not. It lives
// in its own module so the child's entry can read a token without loading the spawner.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { claimOneUseToken, sweepSpentClaims } from '../one-use-token.ts';
import { choresInheritPath, machineConfigDir } from '../paths.ts';
import { choresConfigProblem } from './child.ts';
import type { ChoresChildConfig } from './protocol.ts';

/** Writes the one-use token a child reads. Returns its nonce. */
export function writeChoresInherit(config: ChoresChildConfig): string {
  const nonce = randomBytes(16).toString('hex');
  const dir = machineConfigDir(config.home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepSpentClaims(dir);
  const path = choresInheritPath(config.home, nonce);
  writeFileSync(path, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return nonce;
}

export type ChoresInheritRead =
  | { kind: 'ok'; config: ChoresChildConfig }
  | { kind: 'refused'; why: string };

/**
 * Reads and consumes the token named on a child's command line. The nonce is restricted to the
 * exact spelling this program writes, so a command line cannot point the reader at another file.
 * The claim is shared with the restore child: a rename, so a second child started with the same
 * nonce finds no token and refuses.
 */
export function readChoresInherit(home: string, nonce: string): ChoresInheritRead {
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    return { kind: 'refused', why: 'the token name is not one this daemon writes' };
  }
  const claimed = claimOneUseToken(choresInheritPath(home, nonce));
  if (claimed.kind === 'refused') return claimed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(claimed.text);
  } catch {
    return { kind: 'refused', why: 'the token is not readable JSON' };
  }
  const problem = choresConfigProblem(parsed);
  if (problem !== null) return { kind: 'refused', why: problem };
  return { kind: 'ok', config: parsed as ChoresChildConfig };
}
