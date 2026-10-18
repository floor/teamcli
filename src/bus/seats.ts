// A routing recipient may name a seat by its plain name or by the agent registry id that holds it
// (RFC 002 Amendment 01 §4.4, and the go answer that both forms are accepted). This module is the
// one place that reads the registry for routing, so `recipientsForEvent` and the routing judge stay
// pure: the bus resolves recipients on every walk, the watch on every delivered event, and both
// see the same records `team seats` shows.
import { isAgentId, readAgents, type Agent } from '../registry/agents.ts';
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
