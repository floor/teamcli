// The live-seat guards every typed wake reads before it types: the seat must map to exactly one
// pane in its session, and that pane must not be back at a bare shell.
//
// Shared by the send daemon's last mile and its wake child (`src/daemon/wake/child.ts`), so the
// guards a caller reads are the same words and the same order wherever the walk runs. The daemon
// keeps its own thin wrappers over these for its host shape; nothing here types.
import { agentList, paneProcesses, type PaneProcesses } from '../herdr.ts';
import { paneHoldsOnlyShell } from '../launch/identity.ts';

/** The session's live agents, or null when the session cannot be read. */
export type SeatAgents = (session: string) => { name: string | null; pane: string }[] | null;

/**
 * The one pane a seat name maps to, or the reason this wake must not type. `unreachable` is a
 * missing pane (the caller may fall through to another leg); `refused` is an ambiguous answer
 * (two agents of the name), which no later leg may override.
 */
export function findSeatAgent(
  agentsOf: SeatAgents,
  session: string,
  seatName: string,
): { ok: true; pane: string } | { ok: false; kind: 'unreachable' | 'refused'; reason: string } {
  const agents = agentsOf(session);
  if (agents === null) return { ok: false, kind: 'unreachable', reason: `the session "${session}" could not be read` };
  const named = agents.filter((agent) => agent.name === seatName);
  if (named.length === 0) return { ok: false, kind: 'unreachable', reason: 'no live agent carries that name in the session' };
  if (named.length > 1) {
    return { ok: false, kind: 'refused', reason: `${seatName}: herdr lists more than one agent of this name; nothing was sent` };
  }
  return { ok: true, pane: (named[0] as { pane: string }).pane };
}

/** The real session read, shaped for `findSeatAgent`. */
export function liveSeatAgents(session: string): { name: string | null; pane: string }[] | null {
  const agents = agentList(session);
  return agents === null ? null : agents.map((agent) => ({ name: agent.name, pane: agent.pane }));
}

/**
 * The pane is back at its shell only when the shell is the only process in front. A program
 * beside the shell — a wrapper and the CLI — is the seat, not a bare shell, so a typed wake
 * is not skipped for it. An unread table is not a shell.
 */
export function isBareShellPane(_dir: string, _session: string, _seatName: string, procs: PaneProcesses | null): boolean {
  return paneHoldsOnlyShell(procs);
}

/** The real pane process table for one pane, shaped for `isBareShellPane`. */
export function livePaneProcesses(session: string, pane: string): PaneProcesses | null {
  return paneProcesses(pane, session);
}
