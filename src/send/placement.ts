import { PROFILES, processNameMatches } from '../clis.ts';
import type { Agent } from '../registry/agents.ts';

type PlacementSeat = Pick<Agent, 'id' | 'cli'> & { reach: Pick<Agent['reach'], 'session' | 'seat'> };
type PlacementHost = { agents(session: string): { name: string | null; pane: string; cli?: string | null }[] | null };

/** Where the recipient stands now, as herdr reads it: the one pane the session names its seat on,
 *  and only where the CLI herdr reports there is the CLI the record names. The record's own pane
 *  is not a fallback — a pane that closed and was reused belongs to whatever seat stands on it,
 *  and its socket would be that seat's. A seat herdr does not name, names twice, or names on
 *  another CLI gets no address: the reading says the record and the pane no longer agree. */
export function livePlacement(host: PlacementHost, agent: PlacementSeat): { pane: string } | { error: string } {
  const session = agent.reach.session;
  const agents = host.agents(session);
  if (agents === null) {
    return { error: `${agent.id}: the session "${session}" could not be read, so no address was answered` };
  }
  const named = agents.filter((one) => one.name === agent.reach.seat);
  if (named.length === 0) {
    return { error: `${agent.id}: herdr names no seat "${agent.reach.seat}" in the session "${session}", so no address was answered` };
  }
  if (named.length > 1) {
    return { error: `${agent.id}: herdr lists more than one agent named "${agent.reach.seat}"; no address was answered` };
  }
  const live = named[0] as { pane: string; cli?: string | null };
  const cli = live.cli ?? null;
  if (cli === null) {
    return { error: `${agent.id}: herdr does not report the CLI of "${agent.reach.seat}", so no address was answered` };
  }
  const profile = PROFILES.find((one) => one.cli === agent.cli);
  // herdr's `agent` field names the CLI it detected. Most CLIs it names by process (`claude`
  // for claude-code), which is what a profile's `processes` list holds; a cursor session it
  // names `cursor` while the profile's process name is the launch binary `cursor-agent`. The
  // record and the live pane agree when herdr's name is the recorded CLI itself, so that is a
  // match on its own; the profile's process names remain the reading for the CLIs herdr names
  // by process.
  const same = cli === agent.cli || (profile !== undefined && processNameMatches(cli, profile.processes));
  if (!same) {
    return { error: `${agent.id}: herdr names "${agent.reach.seat}" running "${cli}", not the recorded CLI "${agent.cli}"; no address was answered` };
  }
  return { pane: live.pane };
}

