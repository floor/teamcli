import { readArgs } from '../args.ts';
import type { Command, Io } from '../io.ts';
import { cleanedIo } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import {
  resolveIdentity,
  realLockSources,
  takeLock,
  takenText,
  validLockName,
  WAIT_MAX_SECONDS,
  type LockSources,
} from '../lock/machine.ts';

export const USAGE = 'Usage: team lock <name> [--for <text>] [--wait <seconds>]\n';

export const lock: Command = (argv, io) => runLock(argv, io, realLockSources);
export default lock;

/**
 * `team lock <name>`: take the named machine lock, or say who holds it. `<name>` is a name,
 * never a path. `--for` is the note recorded as the run. `--wait` is how many seconds to wait
 * for a holder to release it; the lock is not broken when the wait ends.
 */
export async function runLock(argv: string[], io: Io, sources: LockSources = realLockSources): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, ['for', 'wait'], []);
  if (args.error) return invocation(out, args.error);
  const name = args.rest.length === 1 ? args.rest[0] : undefined;
  if (!name) {
    const extra = args.rest[1];
    return invocation(out, extra === undefined ? 'a <name> is required' : `unexpected "${plainLine(extra)}"`);
  }
  if (!validLockName(name)) return invocation(out, nameProblem(name));
  const wait = waitOf(args.values.wait);
  if (!wait.ok) return invocation(out, wait.message);
  const identity = resolveIdentity(io, sources);
  if (!identity.ok) {
    out.stderr(`team lock: ${identity.message}\n`);
    // exit: lock.project
    return 2;
  }
  const outcome = await takeLock({
    home: sources.home,
    name,
    run: plainLine(args.values.for ?? '').trim(),
    identity: identity.identity,
    now: sources.now,
    sleep: sources.sleep,
    waitSeconds: wait.seconds,
  });
  if (outcome.kind === 'bad-name') return invocation(out, nameProblem(name));
  if (outcome.kind === 'taken') {
    out.stdout(takenText(name, outcome.who));
    // exit: lock.taken
    return 0;
  }
  if (outcome.kind === 'held') {
    out.stderr(`${outcome.line}\n`);
    // exit: lock.held
    return 1;
  }
  out.stderr(`team lock: ${outcome.message}\n`);
  // exit: lock.io
  return 1;
}

function invocation(io: Io, message: string): number {
  io.stderr(`team lock: ${message}\n${USAGE}`);
  // exit: lock.invocation
  return 2;
}

function nameProblem(name: string): string {
  return `"${plainLine(name)}" is a name, not a path: lowercase letters, digits and hyphens`;
}

function waitOf(value: string | undefined): { ok: true; seconds: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, seconds: 0 };
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return { ok: false, message: '--wait is a whole number of seconds' };
  const seconds = Number(value);
  if (seconds > WAIT_MAX_SECONDS) return { ok: false, message: `--wait is at most ${WAIT_MAX_SECONDS} seconds` };
  return { ok: true, seconds };
}
