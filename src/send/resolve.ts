// Send addressing: one spec — an agent id (`agt_…`), a `seat@team`, or a plain seat of the
// team whose shell the caller stands in — resolved through the registry. The registry's records
// are the address; the live herdr read is the fallback for a record that carries no pane yet.

import { loadTeamFile } from '../file/load.ts';
import { agentList } from '../herdr.ts';
import type { Io } from '../io.ts';
import { AGENT_ID_PATTERN, findAgent, getAgent, type Agent } from '../registry/agents.ts';
import { findTeam, teamIdOf, type TeamRecord } from '../registry/teams.ts';

/** What a spec resolves to: the owning team record, the agent, and the pane to type into. */
export type Target = { team: TeamRecord; agent: Agent; pane: string };

/** One live agent as the herdr read returns it: a name and a pane. */
export type LiveAgent = { name?: string | null; pane: string };

export type LiveRead = (session: string) => LiveAgent[] | null;

const liveFromHerdr: LiveRead = (session) => agentList(session);

/** True for the specs the registry alone answers: an agent id, whole or mistyped, and a
 *  `seat@team`. A plain seat is answered by the registry too, but falls back to the pre-registry
 *  path when the team has no record. */
export function isRegistrySpec(spec: string): boolean {
  return AGENT_ID_PATTERN.test(spec) || spec.startsWith('agt_') || spec.includes('@');
}

/**
 * The team a spec names, as a person wrote it: the agent id's own `reach.team`, or the key after
 * the `@`, or — for a plain seat — the team file at the caller's cwd, matched by the id the
 * registry keys teams on, then by the project or session name it may also be written as.
 */
export function resolveTarget(
  home: string,
  spec: string,
  io: Pick<Io, 'cwd'>,
  live: LiveRead = liveFromHerdr,
): Target | { error: string } {
  if (AGENT_ID_PATTERN.test(spec)) return fromId(home, spec, live);
  const at = spec.indexOf('@');
  if (at >= 0) {
    const seat = spec.slice(0, at);
    const key = spec.slice(at + 1);
    if (at !== spec.lastIndexOf('@') || seat === '' || key === '') {
      return { error: `${spec}: a spec is <seat>@<team>, or an agent id` };
    }
    const team = findTeam(home, key);
    if (!team) return { error: `${spec}: no team registry record matches "${key}" (by id, project or session)` };
    return fromSeat(home, spec, team, seat, live);
  }
  if (spec.startsWith('agt_')) return { error: `${spec}: that is not an agent id (agt_ plus 12 hex)` };
  const loaded = loadTeamFile(io.cwd, { home });
  if (!loaded.ok) return { error: `${spec}: the team of the caller's folder cannot be read (${io.cwd})` };
  const id = teamIdOf(loaded.root);
  const team = findTeam(home, id) ?? findTeam(home, loaded.team.project) ?? findTeam(home, loaded.team.session);
  if (!team) return { error: `${spec}: this team has no registry record yet` };
  return fromSeat(home, spec, team, spec, live);
}

/** The agent that holds a seat, across the spellings a record's `reach.team` may use: the
 *  team id the registry keys on, its project, or its session. */
export function seatAgent(home: string, teamKeys: string[], seat: string): Agent | null {
  for (const key of teamKeys) {
    const agent = findAgent(home, { team: key, seat });
    if (agent) return agent;
  }
  return null;
}

function fromId(home: string, id: string, live: LiveRead): Target | { error: string } {
  const agent = getAgent(home, id);
  if (!agent) return { error: `${id}: no registered agent carries that id` };
  if (agent.lifecycle === 'retired') return { error: `${id}: the agent is retired; nothing was sent` };
  const team = findTeam(home, agent.reach.team);
  if (!team) return { error: `${id}: its team "${agent.reach.team}" has no registry record` };
  const pane = paneOf(agent, live);
  if ('error' in pane) return pane;
  return { team, agent, pane: pane.pane };
}

function fromSeat(
  home: string,
  spec: string,
  team: TeamRecord,
  seat: string,
  live: LiveRead,
): Target | { error: string } {
  const agent = seatAgent(home, [teamIdOf(team.root), team.project, team.session], seat);
  if (!agent) return { error: `${spec}: no registered agent holds the seat "${seat}" in that team` };
  const pane = paneOf(agent, live);
  if ('error' in pane) return pane;
  return { team, agent, pane: pane.pane };
}

/** The pane to type into: the one the record carries, re-pointed on relaunch; when it carries
 *  none, the live read of the record's session, and only a single agent of the seat's name. */
function paneOf(agent: Agent, live: LiveRead): { pane: string } | { error: string } {
  if (agent.reach.pane !== null && agent.reach.pane !== '') return { pane: agent.reach.pane };
  const agents = live(agent.reach.session);
  if (agents === null) return { error: `${agent.id}: the session "${agent.reach.session}" could not be read for a pane` };
  const named = agents.filter((one) => one.name === agent.reach.seat);
  if (named.length === 0) {
    return { error: `${agent.id}: no live agent carries the seat "${agent.reach.seat}" in the session "${agent.reach.session}"` };
  }
  if (named.length > 1) {
    return { error: `${agent.id}: herdr lists more than one agent named "${agent.reach.seat}"; nothing was sent` };
  }
  return { pane: (named[0] as LiveAgent).pane };
}
