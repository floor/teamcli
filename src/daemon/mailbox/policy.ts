// The mailbox router's policy read. Three advised words (the alias map, the fallback, the
// reply bound) resolve nearest-level-wins. The signed chain is `readMailboxRouterPolicy` and
// `mailboxRouterPolicyProblems` in `src/policy/router.ts`. This module keeps the release map,
// the fold, and the load checker the child applies to a policy it already holds.
import { parseOwnerReplyToValue } from '../../settings/owner-reply.ts';

export {
  mailboxRouterPolicyProblems,
  readMailboxRouterPolicy,
} from '../../policy/router.ts';

/** One resolved alias. `address` and `fallback` are `seat@team`. A null fallback means none. */
export type MailboxRoute = {
  alias: string;
  address: string;
  fallback: string | null;
};

/** The routes in force, and the reply bound in seconds. A null bound means the router waits
 *  twice the seat's unread window. */
export type MailboxRouterPolicy = {
  routes: readonly MailboxRoute[];
  replyBoundSeconds: number | null;
};

/** One alias declaration, already taken off its word. `fallback` omitted means the declaration
 *  does not speak about the fallback. `null` clears it. */
export type MailboxAliasWord = {
  level: 'entity' | 'project' | 'team' | 'seat';
  alias: string;
  address: string;
  fallback?: string | null;
};

/** One reply-bound declaration, in seconds. */
export type MailboxReplyBoundWord = {
  level: MailboxAliasWord['level'];
  seconds: number;
};

export type MailboxRouterPolicyRead =
  | { ok: true; policy: MailboxRouterPolicy }
  | { ok: false; why: string };

/** Outermost first. The fold applies them in this order, so the nearest word lands last. */
const LEVELS: readonly MailboxAliasWord['level'][] = ['entity', 'project', 'team', 'seat'];

/** The seat a route must not name. The desk shuttle is retired and nothing routes there. */
const DESK_SEAT = 'desk';

/** The release map, used when the chain sets nothing: empty. A fresh install ships no alias, so a
 *  routing word exists only when an entity or team policy record places it. Entity-owned words
 *  are seeded from the chain, never from this constant. */
export const MAILBOX_ROUTER_DEFAULTS: MailboxRouterPolicy = {
  routes: [],
  replyBoundSeconds: null,
};

type Owned = MailboxRoute & { entity: boolean };

function seatOf(address: string): string {
  return address.slice(0, address.indexOf('@'));
}

function fail(why: string): MailboxRouterPolicyRead {
  return { ok: false, why };
}

/** Why a resolved policy cannot be loaded, or null when it can. A desk target, a missing
 *  address, an address that is not `seat@team`, and a fallback that names the alias or the
 *  alias's own address are refusals. The words name the reason. */
export function mailboxRouterPolicyProblem(policy: MailboxRouterPolicy): string | null {
  const seen = new Set<string>();
  for (const route of policy.routes) {
    const alias = route.alias.trim();
    if (alias === '') return 'an alias has no name';
    if (seen.has(alias)) return `the alias ${alias} is declared twice`;
    seen.add(alias);
    if (route.address.trim() === '') return `${alias} has no address`;
    if (parseOwnerReplyToValue(route.address) === null) {
      return `${alias} must name a seat@team address`;
    }
    if (seatOf(route.address) === DESK_SEAT) {
      return `${alias} names the desk seat, which is not a route`;
    }
    if (route.fallback === null) continue;
    if (route.fallback === alias) return `the fallback for ${alias} names the alias itself`;
    if (parseOwnerReplyToValue(route.fallback) === null) {
      return `the fallback for ${alias} must be a seat@team address`;
    }
    if (route.fallback === route.address) {
      return `the fallback for ${alias} names that alias's own address`;
    }
    if (seatOf(route.fallback) === DESK_SEAT) {
      return `the fallback for ${alias} names the desk seat, which is not a route`;
    }
  }
  if (policy.replyBoundSeconds !== null) {
    const seconds = policy.replyBoundSeconds;
    if (!Number.isInteger(seconds) || seconds < 1) {
      return 'the reply bound must be a positive number of seconds';
    }
  }
  return null;
}

function ownedOf(route: MailboxRoute, entity: boolean): Owned {
  return { alias: route.alias, address: route.address, fallback: route.fallback, entity };
}

/**
 * Folds alias words and reply-bound words onto the release defaults. Entity aliases keep the
 * address and fallback the entity level set; a nearer level that changes either is a refusal.
 * A nearer level may add an alias. The reply bound is the nearest word, and none leaves it
 * null. The finished value still passes through the load checker.
 */
export function resolveMailboxRouterPolicy(input: {
  aliases?: readonly MailboxAliasWord[];
  replyBounds?: readonly MailboxReplyBoundWord[];
} = {}): MailboxRouterPolicyRead {
  const map = new Map<string, Owned>();
  for (const route of MAILBOX_ROUTER_DEFAULTS.routes) map.set(route.alias, ownedOf(route, true));
  const aliases = input.aliases ?? [];
  for (const level of LEVELS) {
    for (const word of aliases) {
      if (word.level !== level) continue;
      const alias = word.alias.trim();
      if (alias === '') return fail('an alias has no name');
      const address = word.address.trim();
      if (address === '') return fail(`${alias} has no address`);
      const current = map.get(alias);
      if (current?.entity === true && level !== 'entity') {
        if (address !== current.address) {
          return fail(`the ${level} level cannot retarget the entity alias ${alias}`);
        }
        if (word.fallback !== undefined && word.fallback !== current.fallback) {
          return fail(`the ${level} level cannot change the fallback of the entity alias ${alias}`);
        }
        continue;
      }
      const fallback = word.fallback !== undefined ? word.fallback : (current?.fallback ?? null);
      map.set(alias, {
        alias,
        address,
        fallback,
        entity: level === 'entity' || current?.entity === true,
      });
    }
  }
  let replyBoundSeconds: number | null = null;
  for (const level of LEVELS) {
    const words = (input.replyBounds ?? []).filter((word) => word.level === level);
    const last = words.at(-1);
    if (last === undefined) continue;
    if (!Number.isInteger(last.seconds) || last.seconds < 1) {
      return fail('the reply bound must be a positive number of seconds');
    }
    replyBoundSeconds = last.seconds;
  }
  const policy: MailboxRouterPolicy = {
    routes: [...map.values()].map((route) => ({
      alias: route.alias,
      address: route.address,
      fallback: route.fallback,
    })),
    replyBoundSeconds,
  };
  const problem = mailboxRouterPolicyProblem(policy);
  if (problem !== null) return fail(problem);
  return { ok: true, policy };
}

