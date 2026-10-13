import { readArgs } from '../args.ts';
import type { Command, Io } from '../io.ts';
import { cleanedIo } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import { realLockHome, releaseLock, resolveIdentity, validLockName, type LockHome } from '../lock/machine.ts';

export const USAGE = 'Usage: team unlock <name>\n';

export const unlock: Command = (argv, io) => runUnlock(argv, io, realLockHome);
export default unlock;

/**
 * `team unlock <name>`: release the named machine lock when its holder file names this caller.
 * Anyone else is shown the holder and refused. A lock whose holder cannot be read is left in place.
 */
export async function runUnlock(argv: string[], io: Io, sources: LockHome = realLockHome): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, [], []);
  if (args.error) return invocation(out, args.error);
  const name = args.rest.length === 1 ? args.rest[0] : undefined;
  if (!name) {
    const extra = args.rest[1];
    return invocation(out, extra === undefined ? 'a <name> is required' : `unexpected "${plainLine(extra)}"`);
  }
  if (!validLockName(name)) return invocation(out, nameProblem(name));
  const identity = resolveIdentity(io, sources);
  if (!identity.ok) {
    out.stderr(`team unlock: ${identity.message}\n`);
    // exit: unlock.project
    return 2;
  }
  const outcome = releaseLock({ home: sources.home, name, identity: identity.identity });
  if (outcome.kind === 'bad-name') return invocation(out, nameProblem(name));
  if (outcome.kind === 'released') {
    out.stdout(`${name}: released\n`);
    // exit: unlock.released
    return 0;
  }
  if (outcome.kind === 'not-held') {
    out.stderr(`${name}: not held\n`);
    // exit: unlock.not-held
    return 1;
  }
  if (outcome.kind === 'not-yours') {
    out.stderr(`${outcome.line}\n`);
    // exit: unlock.not-yours
    return 1;
  }
  if (outcome.kind === 'unknown') {
    out.stderr(`${outcome.line}\n`);
    // exit: unlock.unknown-holder
    return 1;
  }
  out.stderr(`team unlock: ${outcome.message}\n`);
  // exit: unlock.io
  return 1;
}

function invocation(io: Io, message: string): number {
  io.stderr(`team unlock: ${message}\n${USAGE}`);
  // exit: unlock.invocation
  return 2;
}

function nameProblem(name: string): string {
  return `"${plainLine(name)}" is a name, not a path: lowercase letters, digits and hyphens`;
}
