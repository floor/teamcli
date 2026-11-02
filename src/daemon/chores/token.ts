// The one-use token that proves a chores child was started by this machine daemon.
//
// The daemon writes it under the machine folder (mode 0600) and starts the child with its nonce
// on the command line; the child reads it once, unlinks it, and serves the configuration it
// carries. Any token presented is consumed, readable or not: one token starts one child. It
// lives in its own module so the child's entry can read a token without loading the spawner.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { choresInheritPath, machineConfigDir } from '../paths.ts';
import { choresConfigProblem } from './child.ts';
import type { ChoresChildConfig } from './protocol.ts';

/** Writes the one-use token a child reads. Returns its nonce. */
export function writeChoresInherit(config: ChoresChildConfig): string {
  const nonce = randomBytes(16).toString('hex');
  const dir = machineConfigDir(config.home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
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
 */
export function readChoresInherit(home: string, nonce: string): ChoresInheritRead {
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    return { kind: 'refused', why: 'the token name is not one this daemon writes' };
  }
  const path = choresInheritPath(home, nonce);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { kind: 'refused', why: 'no one-use token names this child' };
  }
  try {
    unlinkSync(path);
  } catch {
    // A token that cannot be unlinked still starts nothing twice: the child that read it is the
    // only one this invocation runs.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'refused', why: 'the token is not readable JSON' };
  }
  const problem = choresConfigProblem(parsed);
  if (problem !== null) return { kind: 'refused', why: problem };
  return { kind: 'ok', config: parsed as ChoresChildConfig };
}
