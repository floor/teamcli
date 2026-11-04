// The mailbox router's three words read back from their signed sources into the shape the router
// child consumes: `routes` (each alias's `seat@team` address and its definite-miss fallback) and
// `replyBoundSeconds` (null means twice the seat's unread window). The words' grammar and release
// defaults live in `src/policy/types.ts`; this reader owns the rules that span words — a team may
// add an alias for its own seats but never retarget one the entity places, and an entity alias's
// fallback belongs to the entity alone. A word that broke a rule refuses at load with a named
// error, never a guessed route. The child's own mechanics (the definite-miss rule, the bridge's
// synchronous 120 s cap) are constants of the child, not values here.
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import { readEntityPolicySource, readTeamPolicySource } from './sources.ts';
import {
  normalizePolicyName,
  parseRouterAliases,
  parseRouterFallback,
  parseRouterReplyBound,
  parseSeatTeamAddress,
  ROUTER_ALIAS_DEFAULTS,
  routerAliasesProblem,
  ROUTER_FALLBACK_DEFAULTS,
  routerFallbackProblem,
  type Policy,
} from './types.ts';

/** One alias's route: where an ask addressed to `alias` goes, and where it goes on a definite miss. */
export type MailboxRouterRoute = { alias: string; address: string; fallback: string | null };

/** The router child's whole policy: every route, and the reply bound in seconds (null = twice the
 *  seat's unread window). */
export type MailboxRouterPolicyValue = { routes: MailboxRouterRoute[]; replyBoundSeconds: number | null };

export type MailboxRouterPolicyRead =
  | { ok: true; policy: MailboxRouterPolicyValue }
  | { ok: false; why: string };

/** One rule a router word broke, as `team check` reports it: the named sentence, the level whose
 *  word broke it, and that word's name — enough for a `team policy unset` repair. `kind` is
 *  `invalid` for a word its own value refuses and `rule` for a rule between words; an unreadable
 *  source never reaches this list (the chain's own refusal names it). */
export type MailboxRouterProblem = {
  why: string;
  level: 'entity' | 'team';
  name: string;
  kind: 'invalid' | 'rule';
};

/** The release's alias map, under the names the router child was agreed to import. */
export const MAILBOX_ROUTER_ALIAS_DEFAULTS = ROUTER_ALIAS_DEFAULTS;
/** The release's fallback map, under the names the router child was agreed to import. */
export const MAILBOX_ROUTER_FALLBACK_DEFAULTS = ROUTER_FALLBACK_DEFAULTS;

/**
 * Names a routes list that broke its final shape — an alias placed twice, an address that is not
 * a `seat@team` address, a seat named `desk`, or a fallback naming its own route. The grammar and
 * the load-time rules refuse each of these before a word is signed; this checker is the belt the
 * router child still wears, so a hand-edited source cannot route a broken map either.
 */
export function mailboxRouterPolicyProblem(routes: readonly MailboxRouterRoute[]): string | null {
  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.alias)) return `router alias "${route.alias}" is named twice`;
    seen.add(route.alias);
    const parsed = parseSeatTeamAddress(route.address);
    if (parsed === null) {
      return `router alias "${route.alias}" names "${route.address}", which is not a seat@team address`;
    }
    if (parsed.seat === 'desk') {
      return `router alias "${route.alias}" targets the desk seat, which no alias may name`;
    }
    if (route.fallback !== null && route.fallback === route.address) {
      return `router fallback for "${route.alias}" names the route itself (${route.address})`;
    }
  }
  return null;
}

/** A policy record that was signed, as opposed to a legacy word a source reader injects. */
function isSignedPolicy(policy: Policy): boolean {
  return policy.setter !== null || policy.signature !== undefined;
}

/** An expired declaration counts as unset at its level, as it does in the policy chain. */
function expiredPolicy(policy: Policy, now: Date): boolean {
  if (!policy.expiry) return false;
  const at = Date.parse(policy.expiry);
  return Number.isFinite(at) && at <= now.getTime();
}

type RouterAssembly =
  | { ok: true; value: MailboxRouterPolicyValue }
  | { ok: false; why: string; problems: MailboxRouterProblem[] };

/**
 * Walks both levels' signed sources by hand — the chain's resolver merges maps, but these rules
 * need to know which level placed which alias. An unreadable team config leaves the release
 * defaults in force (`team check` names the file through its own gates); an unreadable or
 * unverified policy source refuses the whole read, the way every policy read refuses.
 */
function assembleRouterPolicy(root: string, home: string, now: Date, team: TeamFile | null): RouterAssembly {
  const problems: MailboxRouterProblem[] = [];

  const entityAliases = new Map<string, string>(Object.entries(ROUTER_ALIAS_DEFAULTS));
  const entityFallback = new Map<string, string | null>(Object.entries(ROUTER_FALLBACK_DEFAULTS));
  const fallbackLevel = new Map<string, 'default' | 'entity' | 'team'>(
    [...Object.keys(ROUTER_FALLBACK_DEFAULTS)].map((alias) => [alias, 'default'] as const),
  );
  let entityReplyBound: number | null = null;

  const entity = team?.entity?.trim() || null;
  if (team !== null && entity !== null) {
    const source = readEntityPolicySource(home, entity);
    if (!source.ok) {
      return {
        ok: false,
        why: `entity: policy source cannot be read or verified (${source.why})`,
        problems: [],
      };
    }
    for (const policy of source.policies) {
      if (!isSignedPolicy(policy) || expiredPolicy(policy, now)) continue;
      const canonical = normalizePolicyName(policy.name);
      if (canonical === 'router.aliases') {
        const entries = parseRouterAliases(policy.value);
        if (entries === null) {
          problems.push({
            why: routerAliasesProblem(policy.value) ?? `entity: invalid value for policy "router.aliases"`,
            level: 'entity',
            name: 'router.aliases',
            kind: 'invalid',
          });
          continue;
        }
        for (const [alias, address] of entries) {
          entityAliases.set(alias, address);
          // An entity word that places an alias also owns its fallback from here on.
          if (!fallbackLevel.has(alias)) fallbackLevel.set(alias, 'entity');
        }
      } else if (canonical === 'router.fallback') {
        const entries = parseRouterFallback(policy.value);
        if (entries === null) {
          problems.push({
            why: routerFallbackProblem(policy.value) ?? `entity: invalid value for policy "router.fallback"`,
            level: 'entity',
            name: 'router.fallback',
            kind: 'invalid',
          });
          continue;
        }
        for (const [alias, fallback] of entries) {
          entityFallback.set(alias, fallback);
          fallbackLevel.set(alias, 'entity');
        }
      } else if (canonical === 'router.reply-bound') {
        entityReplyBound = parseRouterReplyBound(policy.value);
        if (entityReplyBound === null) {
          problems.push({
            why: 'policy "router.reply-bound" is a whole number of seconds from 1 to 86400, such as 600',
            level: 'entity',
            name: 'router.reply-bound',
            kind: 'invalid',
          });
        }
      }
    }
  }

  const teamAliases = new Map<string, string>();
  const teamFallback = new Map<string, string | null>();
  let teamReplyBound: number | null = null;

  if (team !== null) {
    const seatNames = new Set(team.seats.map((seat) => seat.name));
    const session = team.session;
    const source = readTeamPolicySource(home, root, team);
    if (!source.ok) {
      return {
        ok: false,
        why: `team: policy source cannot be read or verified (${source.why})`,
        problems: [],
      };
    }
    for (const policy of source.policies) {
      if (!isSignedPolicy(policy) || expiredPolicy(policy, now)) continue;
      const canonical = normalizePolicyName(policy.name);
      if (canonical === 'router.aliases') {
        const entries = parseRouterAliases(policy.value);
        if (entries === null) {
          problems.push({
            why: routerAliasesProblem(policy.value) ?? `team: invalid value for policy "router.aliases"`,
            level: 'team',
            name: 'router.aliases',
            kind: 'invalid',
          });
          continue;
        }
        for (const [alias, address] of entries) {
          if (entityAliases.has(alias)) {
            if (entityAliases.get(alias) !== address) {
              problems.push({
                why: `router alias "${alias}" is set by the entity; a team may add an alias, never retarget one`,
                level: 'team',
                name: 'router.aliases',
                kind: 'rule',
              });
              continue;
            }
            // The same address re-declared changes nothing; record it so later words see it.
            teamAliases.set(alias, address);
            continue;
          }
          const parsed = parseSeatTeamAddress(address);
          if (parsed === null || parsed.seat === 'desk' || !seatNames.has(parsed.seat) || parsed.team !== session) {
            problems.push({
              why: `router alias "${alias}" names "${address}", which is not a seat of this team`,
              level: 'team',
              name: 'router.aliases',
              kind: 'rule',
            });
            continue;
          }
          teamAliases.set(alias, address);
        }
      } else if (canonical === 'router.fallback') {
        const entries = parseRouterFallback(policy.value);
        if (entries === null) {
          problems.push({
            why: routerFallbackProblem(policy.value) ?? `team: invalid value for policy "router.fallback"`,
            level: 'team',
            name: 'router.fallback',
            kind: 'invalid',
          });
          continue;
        }
        for (const [alias, fallback] of entries) {
          if (entityAliases.has(alias)) {
            problems.push({
              why: `router fallback for "${alias}" belongs to the entity; only the entity level may change or clear it`,
              level: 'team',
              name: 'router.fallback',
              kind: 'rule',
            });
            continue;
          }
          teamFallback.set(alias, fallback);
          fallbackLevel.set(alias, 'team');
        }
      } else if (canonical === 'router.reply-bound') {
        teamReplyBound = parseRouterReplyBound(policy.value);
        if (teamReplyBound === null) {
          problems.push({
            why: 'policy "router.reply-bound" is a whole number of seconds from 1 to 86400, such as 600',
            level: 'team',
            name: 'router.reply-bound',
            kind: 'invalid',
          });
        }
      }
    }
  }

  const aliases = new Map(entityAliases);
  for (const [alias, address] of teamAliases) aliases.set(alias, address);
  const fallbacks = new Map(entityFallback);
  for (const [alias, fallback] of teamFallback) fallbacks.set(alias, fallback);

  for (const [alias, fallback] of fallbacks) {
    if (!aliases.has(alias)) {
      const level = fallbackLevel.get(alias) === 'team' ? 'team' : 'entity';
      problems.push({
        why: `router fallback names "${alias}", which no alias maps`,
        level,
        name: 'router.fallback',
        kind: 'rule',
      });
      continue;
    }
    if (fallback !== null && fallback === aliases.get(alias)) {
      problems.push({
        why: `router fallback for "${alias}" names the route itself (${fallback})`,
        level: fallbackLevel.get(alias) === 'team' ? 'team' : 'entity',
        name: 'router.fallback',
        kind: 'rule',
      });
    }
  }

  if (problems.length > 0) return { ok: false, why: problems[0]!.why, problems };

  const routes: MailboxRouterRoute[] = [...aliases].map(([alias, address]) => ({
    alias,
    address,
    fallback: fallbacks.get(alias) ?? null,
  }));
  const shape = mailboxRouterPolicyProblem(routes);
  if (shape !== null) {
    return { ok: false, why: shape, problems: [{ why: shape, level: 'team', name: 'router.aliases', kind: 'rule' }] };
  }
  return { ok: true, value: { routes, replyBoundSeconds: teamReplyBound ?? entityReplyBound } };
}

/**
 * The mailbox router's policy in force for the team rooted at `root`. `ok: false` names the first
 * rule a word broke (or the source that could not be read); the caller stops and shows `why`
 * rather than routing a broken map. The team config is read through `readTeamConfig`; when it
 * cannot be read the release defaults stand, because `team check` names the file itself.
 */
export function readMailboxRouterPolicy(
  root: string,
  home: string,
  now: Date = new Date(),
): MailboxRouterPolicyRead {
  const team = loadTeam(root, home);
  const assembled = assembleRouterPolicy(root, home, now, team);
  if (!assembled.ok) return { ok: false, why: assembled.why };
  return { ok: true, policy: assembled.value };
}

/**
 * Every rule the router's words broke, for `team check`: each problem names its sentence, level
 * and word, so each difference carries its own `team policy unset` repair. An unreadable source
 * returns no problems here — the chain's refusal already names it — but does refuse
 * `readMailboxRouterPolicy`.
 */
export function mailboxRouterPolicyProblems(
  root: string,
  home: string,
  now: Date = new Date(),
  team: TeamFile | null = loadTeam(root, home),
): MailboxRouterProblem[] {
  const assembled = assembleRouterPolicy(root, home, now, team);
  return assembled.ok ? [] : assembled.problems;
}

/** The team config at `root`, or null when it cannot be read (the release defaults then stand). */
function loadTeam(root: string, home: string): TeamFile | null {
  try {
    const loaded = readTeamConfig(root, { home });
    return loaded.ok ? loaded.team : null;
  } catch {
    return null;
  }
}
