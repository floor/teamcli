// A routing recipient may name a seat by its plain name or by the agent registry id that holds it
// (RFC 002 Amendment 01 §4.4, and the go answer that both forms are accepted). This module is the
// one place that reads the registry for routing, so `recipientsForEvent` and the routing judge stay
// pure: the bus resolves recipients on every walk, the watch on every delivered event, and both
// see the same records `team seats` shows.
import { isAgentId, readAgents, type Agent } from '../registry/agents.ts';
import { readTeams, type TeamRecord } from '../registry/teams.ts';
import type { SeatRecipientResolver } from './kinds.ts';

/** The resolver over a snapshot of the registry. A retired agent holds no seat, so its id names
 *  nobody and is left as written; a plain seat name is not this resolver's business. */
export function seatResolverOf(agents: readonly Agent[], teamId: string): SeatRecipientResolver {
  return (entry) => {
    if (!isAgentId(entry)) return undefined;
    const agent = agents.find(
      (candidate) =>
        candidate.id === entry && candidate.lifecycle !== 'retired' && candidate.reach.team === teamId,
    );
    return agent?.reach.seat;
  };
}

/** The resolver over the registry on disk. It reads only when an entry names an id: a bus serves
 *  for hours while agents register, relaunch and retire, so the snapshot is taken at the entry
 *  that needs it, never held from start-up. */
export function readSeatResolver(home: string, teamId: string): SeatRecipientResolver {
  return (entry) => {
    if (!isAgentId(entry)) return undefined;
    return seatResolverOf(readAgents(home), teamId)(entry);
  };
}

/** The lead of the entity's own team: the seat above `teamId` in the entity's chain. Admission
 *  reads the same place ("the entity's own coordinator is the lead of the team whose project is
 *  the entity", `src/send/admit.ts`); routing names it `entity`. The root and session travel with
 *  the seat so a watch can leave the climb in the entity team's own mailbox. */
export type EntityOrchestrator = { seat: string; team: string; root: string; session: string };

/** The entity's own coordinator over a registry snapshot: the lead-marked seat of the team whose
 *  team name (`project`) is the entity itself. Null when this team names no entity, when no team
 *  is that entity's own, or when its roster marks no lead. */
export function entityOrchestratorOf(
  teams: Record<string, TeamRecord>,
  teamId: string,
): EntityOrchestrator | null {
  const own = teams[teamId];
  if (!own || own.entity === null) return null;
  for (const id of Object.keys(teams).sort()) {
    const team = teams[id];
    if (!team || team.entity !== own.entity || team.project !== own.entity) continue;
    const seat = team.roster.find((entry) => entry.leads === true)?.seat;
    if (seat === undefined) return null;
    return { seat, team: id, root: team.root, session: team.session };
  }
  return null;
}

/** The same answer from the registry on disk. A registry that cannot be read names no entity
 *  lead; the owner is still routed, so the climb is never silent. */
export function readEntityOrchestrator(home: string, teamId: string): EntityOrchestrator | null {
  try {
    return entityOrchestratorOf(readTeams(home), teamId);
  } catch {
    return null;
  }
}
