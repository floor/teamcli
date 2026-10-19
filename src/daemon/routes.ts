// The machine daemon's hosted-route table. A mutating request on the one machine socket will
// name the checkout it belongs to in its scope, and that claim must resolve to exactly one
// checkout this process actually hosts before any handler sees it. This is the non-auth half:
// routes are built only from checkouts this daemon started, a scope is matched exactly or
// refused, and the routing keys never become evidence of who the caller is. The principal check
// is a later layer, and until it lands every mutating request is still refused.
//
// Routing keys are `root`, `team` and `session`; `root` is the strongest and is canonicalized
// before comparison. `seat` and `agent` never select a checkout: they are checked against the
// one route a routing key resolved, so a caller cannot pick a team by naming a seat.
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';

/** One checkout this daemon knows, as loaded from its team file. */
export type HostedRoute = {
  /** The canonical checkout root: the path a scope's `root` is compared against. */
  root: string;
  /** The team file's project name. */
  team: string;
  /** The team file's session. */
  session: string;
  /** The declared seat names, sorted. */
  seats: readonly string[];
};

/** What a request says about the checkout it belongs to. Every field is a claim, never proof. */
export type ScopeClaim = {
  root?: string;
  team?: string;
  session?: string;
  seat?: string;
  agent?: string;
};

export type RouteLookup =
  | { kind: 'one'; route: HostedRoute }
  | { kind: 'refused'; why: string }
  | { kind: 'mismatch'; why: string };

/** The canonical folder a scope names, or null when it is not a readable directory. A claim
 *  that is a link resolves to what it names; a claim that does not exist names no checkout. */
export function canonicalRoot(root: string): string | null {
  try {
    const real = realpathSync(root);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** One route from a loaded team file. The seats are sorted so a lookup never depends on file
 *  order, and the array is copied so a caller cannot change the table through it. */
export function routeOf(root: string, team: string, session: string, seats: readonly string[]): HostedRoute {
  return { root, team, session, seats: [...seats].sort() };
}

/** Whether this checkout is already in the table. A second `--root` for the same checkout is
 *  the same route, not a second one: hosting it twice would make every scope ambiguous. */
export function duplicateRoute(routes: readonly HostedRoute[], root: string): HostedRoute | null {
  return routes.find((route) => route.root === root) ?? null;
}

/** The replay folder's name for a route: a digest of the canonical root, so no folder name is
 *  built from a path a caller can spell. */
export function routeId(route: HostedRoute): string {
  return createHash('sha256').update(route.root, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Resolves an untrusted scope against the hosted routes. With `root` present, the root must
 * name a hosted checkout and every other field present must agree with that route; without it,
 * `team` and `session` must leave exactly one candidate. `seat` is checked against the resolved
 * route rather than used to find one, and `agent` is carried for the principal layer but never
 * consulted here.
 */
export function resolveScope(routes: readonly HostedRoute[], scope: ScopeClaim): RouteLookup {
  const claimedRoot = scope.root === undefined ? null : canonicalRoot(scope.root);
  if (scope.root !== undefined && claimedRoot === null) {
    return { kind: 'refused', why: 'the scope root is not a readable checkout folder' };
  }
  if (scope.root === undefined && scope.team === undefined && scope.session === undefined) {
    return { kind: 'refused', why: 'the scope names no checkout: it needs root, team or session' };
  }

  if (claimedRoot !== null) {
    const route = routes.find((one) => one.root === claimedRoot);
    if (!route) return { kind: 'refused', why: 'the scope root is not a checkout this daemon hosts' };
    for (const key of ['team', 'session'] as const) {
      const claimed = scope[key];
      if (claimed !== undefined && claimed !== route[key]) {
        return { kind: 'mismatch', why: `the scope ${key} "${claimed}" is not this checkout's ${route[key]}` };
      }
    }
    return seatCheck(route, scope.seat);
  }

  const candidates = routes.filter(
    (route) =>
      (scope.team === undefined || route.team === scope.team) &&
      (scope.session === undefined || route.session === scope.session),
  );
  if (candidates.length === 0) return { kind: 'refused', why: 'the scope names no checkout this daemon hosts' };
  if (candidates.length > 1) {
    return { kind: 'refused', why: `the scope names ${String(candidates.length)} hosted checkouts; name its root` };
  }
  return seatCheck(candidates[0] as HostedRoute, scope.seat);
}

function seatCheck(route: HostedRoute, seat: string | undefined): RouteLookup {
  if (seat === undefined) return { kind: 'one', route };
  if (!route.seats.includes(seat)) {
    return { kind: 'mismatch', why: `the scope seat "${seat}" is not a declared seat of ${route.root}` };
  }
  return { kind: 'one', route };
}
