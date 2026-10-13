import { callerOf, callerVerdict, standingOf } from './caller.ts';
import { delegateReadGate, type DelegateSources } from './delegate.ts';
import type { Current } from './file/current.ts';
import type { Io } from './io.ts';

/**
 * Whether this caller may see the team's answer: a seat of the team the state records on the
 * pane this call stands on, or a pane the approved file names. Every other case is not a
 * message but simply does not pass, and the command answers with its one sentence — an
 * unapproved caller learns no detail, not which step failed, not whose pane an entry is, not
 * that a `delegates` section exists at all.
 *
 * Moved out of `team check` so another command calls this instead of copying it.
 */
export function mayReadTeam(
  current: Extract<Current, { ok: true }>,
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
  sources: { home?: string; gate?: DelegateSources },
): boolean {
  const session = current.team.session;
  const caller = callerOf(io, session);
  if (caller.kind === 'seat' && callerVerdict(caller, caller.name, standingOf(current.dir, session, caller)).kind === 'ok') {
    return true;
  }
  return delegateReadGate({
    team: current.team,
    root: current.root,
    dir: current.dir,
    io,
    ...(sources.home !== undefined ? { home: sources.home } : {}),
    ...(sources.gate !== undefined ? { sources: sources.gate } : {}),
  });
}
