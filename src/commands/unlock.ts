import { readArgs } from '../args.ts';
import type { Command, Io } from '../io.ts';
import { cleanedIo } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import { realLockHome, releaseLock, resolveIdentity, validLockName, type LockHome } from '../lock/machine.ts';
import { hasJsonFlag, writeJson, writeJsonError } from '../output/index.ts';

export const USAGE = `Usage: team unlock <name> [--json]

Exits 0 when the lock is released, 1 when it is not held, held by someone else, or cannot be removed, 2 when the invocation or project can't be read.
`;

export const unlock: Command = (argv, io) => runUnlock(argv, io, realLockHome);
export default unlock;

/**
 * `team unlock <name>`: release the named machine lock when its holder file names this caller.
 * Anyone else is shown the holder and refused. A lock whose holder cannot be read is left in place.
 */
export async function runUnlock(argv: string[], io: Io, sources: LockHome = realLockHome): Promise<number> {
  const out = cleanedIo(io);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, [], ['json']);
  if (args.error) return invocation(out, args.error, json);
  const name = args.rest.length === 1 ? args.rest[0] : undefined;
  if (!name) {
    const extra = args.rest[1];
    return invocation(out, extra === undefined ? 'a <name> is required' : `unexpected "${plainLine(extra)}"`, json);
  }
  if (!validLockName(name)) return invocation(out, nameProblem(name), json);
  const identity = resolveIdentity(io, sources);
  if (!identity.ok) {
    if (json) {
      writeJsonError(out, 'unlock.project', identity.message, null);
    } else {
      out.stderr(`team unlock: ${identity.message}\n`);
    }
    // exit: unlock.project
    return 2;
  }
  const outcome = releaseLock({ home: sources.home, name, identity: identity.identity });
  if (outcome.kind === 'bad-name') return invocation(out, nameProblem(name), json);
  if (outcome.kind === 'released') {
    if (json) {
      writeJson(out, 'team.unlock', {
        format: 1,
        dry_run: false,
        status: 'released',
        action_summary: `${name}: released`,
        project: identity.identity.team,
        target: name,
        value: null,
      });
    } else {
      out.stdout(`${name}: released\n`);
    }
    // exit: unlock.released
    return 0;
  }
  if (outcome.kind === 'not-held') {
    if (json) {
      writeJsonError(out, 'unlock.not-held', `${name}: not held`, null);
    } else {
      out.stderr(`${name}: not held\n`);
    }
    // exit: unlock.not-held
    return 1;
  }
  if (outcome.kind === 'not-yours') {
    if (json) {
      writeJsonError(out, 'unlock.not-yours', outcome.line, null);
    } else {
      out.stderr(`${outcome.line}\n`);
    }
    // exit: unlock.not-yours
    return 1;
  }
  if (outcome.kind === 'unknown') {
    if (json) {
      writeJsonError(out, 'unlock.unknown-holder', outcome.line, null);
    } else {
      out.stderr(`${outcome.line}\n`);
    }
    // exit: unlock.unknown-holder
    return 1;
  }
  if (json) {
    writeJsonError(out, 'unlock.io', outcome.message, null);
  } else {
    out.stderr(`team unlock: ${outcome.message}\n`);
  }
  // exit: unlock.io
  return 1;
}

function invocation(io: Io, message: string, json: boolean): number {
  if (json) {
    writeJsonError(io, 'unlock.invocation', message, null);
  } else {
    io.stderr(`team unlock: ${message}\n${USAGE}`);
  }
  // exit: unlock.invocation
  return 2;
}

function nameProblem(name: string): string {
  return `"${plainLine(name)}" is a name, not a path: lowercase letters, digits and hyphens`;
}
