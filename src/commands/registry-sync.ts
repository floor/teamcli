// The registry's writers for the launch commands (FLO-837 agents, FLO-838 teams). `up`, `add`,
// `restart` and `reload` register a seat's agent at its first launch and re-point it on every
// relaunch; `remove` and the stop of a seat end it. The agent's id is assigned once and never
// re-derived from the seat's name: a relaunch finds the live agent of (team, seat) and keeps it.
//
// A registry that cannot be written is a note for the command's log, never a refusal: the launch
// or the stop is done, and the next launch writes the record again. Every function here catches.
import { findAgent, registerAgent, updateAgent } from '../registry/agents.ts';
import { getTeam, noteTeam, setRoster, setTeamLifecycle, teamIdOf } from '../registry/teams.ts';
import type { Seat, TeamFile } from '../file/types.ts';

/** What every writer here is told about the team it writes for. */
export type RegistryTeam = { home: string; team: TeamFile; root: string; by: string };

/** How a seat's agent ends: `stopped` comes back to the same agent, `retired` never does. */
export type Ending = 'stopped' | 'retired';

const SEAT_HANDLE = /^seat_[0-9a-f]{12}$/;

function noteOf(error: unknown): string {
  return `registry not written: ${error instanceof Error ? error.message : String(error)}`;
}

/** The team's record, made when the registry has none, and set running: a seat is launching in it.
 *  `noteTeam` never throws; the line it returns is why the record was not written. */
function ensureTeam(input: RegistryTeam): string | null {
  const { team, root, home, by } = input;
  const seed = { project: team.project, entity: team.entity, session: team.session, lobby: team.lobby };
  return noteTeam(home, root, seed, 'running', by);
}

/** One roster entry set (an agent) or taken out (null); every other entry stays as it is. */
function writeRoster(input: RegistryTeam, teamId: string, seat: string, entry: { agent: string; role: string } | null): void {
  const roster = (getTeam(input.home, teamId)?.roster ?? []).filter((item) => item.seat !== seat);
  if (entry) roster.push({ agent: entry.agent, seat, role: entry.role });
  setRoster(input.home, teamId, roster);
}

/**
 * A seat launched in `pane`: its agent is registered when the (team, seat) has none, else it is
 * re-pointed (same id, new pane, running). The signing triple, the lab, the cli and the launch
 * line are the launch's own, so a reload that changes the model rewrites them on the same agent.
 * Returns the agent's id, or the note to log.
 */
export function registerLaunch(
  input: RegistryTeam,
  seat: Seat,
  pane: string,
  handle?: string,
): { id: string } | { note: string } {
  try {
    const { home, team, by } = input;
    const teamId = teamIdOf(input.root);
    const unrecorded = ensureTeam(input);
    if (unrecorded) return { note: unrecorded };
    const known = findAgent(home, { team: teamId, seat: seat.name });
    // The seat's stable handle, kept on the agent for continuity: set when the agent has none, and
    // never changed after, so a handle the state minted later does not rewrite the record.
    const seatHandle = SEAT_HANDLE.test(handle ?? '') && !known?.seat_handle ? { seat_handle: handle as string } : {};
    const reach = { team: teamId, seat: seat.name, session: team.session, pane, address: known?.reach.address ?? null };
    const signing = { model: seat.model, version: seat.version, role: seat.role };
    const agent = known
      ? updateAgent(home, known.id, {
        signing, lab: seat.vendor, cli: seat.cli, launch: seat.launch, lifecycle: 'running', reach, ...seatHandle,
      })
      : registerAgent(home, {
        name: seat.name, signing, lab: seat.vendor, cli: seat.cli, launcher: null, launch: seat.launch,
        reach, mcp: [], skills: [], lifecycle: 'running', by, ...seatHandle,
      });
    writeRoster(input, teamId, seat.name, { agent: agent.id, role: seat.role });
    return { id: agent.id };
  } catch (error) {
    return { note: noteOf(error) };
  }
}

/**
 * A seat's agent ended. `stopped` keeps the seat in the roster (the file still names it, and it
 * comes back as the same agent); `retired` ends the agent and takes the seat out of the roster.
 * Its pane is cleared either way: the pane is gone, and a later `send` must not type into whatever
 * the host reuses its id for. Nothing is written for a seat the registry never knew.
 */
export function registerEnd(input: RegistryTeam, seat: string, ending: Ending): { note: string } | null {
  try {
    const teamId = teamIdOf(input.root);
    const known = findAgent(input.home, { team: teamId, seat });
    if (!known) return null;
    updateAgent(input.home, known.id, { lifecycle: ending, reach: { ...known.reach, pane: null } });
    if (ending === 'retired') writeRoster(input, teamId, seat, null);
    return null;
  } catch (error) {
    return { note: noteOf(error) };
  }
}

/** The seats `up` left standing, written once at the end of its run. A seat the file stops, or one
 *  that is not ready, is ended as `stopped`; a ready one is registered or re-pointed. The team
 *  record is stopped when no seat is left running. */
export function registerRun(
  input: RegistryTeam,
  seats: ReadonlyArray<{ seat: Seat; pane: string | null; handle?: string }>,
): string[] {
  const notes: string[] = [];
  let running = 0;
  for (const { seat, pane, handle } of seats) {
    if (seat.stopped || pane === null) {
      const ended = registerEnd(input, seat.name, 'stopped');
      if (ended) notes.push(ended.note);
      continue;
    }
    const made = registerLaunch(input, seat, pane, handle);
    if ('note' in made) notes.push(made.note);
    else running += 1;
  }
  try {
    const teamId = teamIdOf(input.root);
    if (running === 0 && getTeam(input.home, teamId)) setTeamLifecycle(input.home, teamId, 'stopped');
  } catch (error) {
    notes.push(noteOf(error));
  }
  return notes;
}
