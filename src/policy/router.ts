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
import { list as listProjects } from '../registry/projects.ts';
import { readTeams, teamIdOf } from '../registry/teams.ts';
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
 * need to know which level placed which alias. An unreadable or unverified policy source refuses
 * the whole read, the way every policy read refuses. A null team (the check path, where the
 * chain's own gates name the file) leaves only the release defaults.
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
  // Every spelling an address may name one of the entity's teams by, built once an entity word
  // first needs it: a team belongs to the entity when its own record says so or a project record
  // of the entity lists it, and each member answers by its registry id, its name or its session —
  // the same forms a send accepts. A registry that cannot be read refuses the whole read; an
  // entity with no router words never asks.
  let entityScopes: Set<string> | null = null;
  let entityScopesRefusal: string | undefined;
  const scopesOfEntityTeams = (): { ok: true; scopes: Set<string> } | { ok: false; why: string } => {
    if (entityScopesRefusal !== undefined) return { ok: false, why: entityScopesRefusal };
    if (entityScopes === null) {
      try {
        const viaProject = new Set<string>();
        for (const project of listProjects(home)) {
          if (project.entity !== entity) continue;
          for (const id of project.teams) viaProject.add(id);
        }
        const scopes = new Set<string>();
        for (const record of Object.values(readTeams(home))) {
          const id = record.id ?? teamIdOf(record.root);
          if (record.entity !== entity && !viaProject.has(id)) continue;
          scopes.add(id);
          scopes.add(record.project);
          scopes.add(record.session);
        }
        entityScopes = scopes;
      } catch (error) {
        entityScopesRefusal = `entity: the registry cannot be read (${(error as Error).message})`;
        return { ok: false, why: entityScopesRefusal };
      }
    }
    return { ok: true, scopes: entityScopes };
  };

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
          const parsed = parseSeatTeamAddress(address);
          const answer = scopesOfEntityTeams();
          if (!answer.ok) {
            return { ok: false, why: answer.why, problems: [] };
          }
          if (parsed === null || !answer.scopes.has(parsed.team)) {
            problems.push({
              why: `router alias "${alias}" names "${address}", which is not a team of this entity`,
              level: 'entity',
              name: 'router.aliases',
              kind: 'rule',
            });
            continue;
          }
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
          if (fallback !== null) {
            const parsed = parseSeatTeamAddress(fallback);
            const answer = scopesOfEntityTeams();
            if (!answer.ok) {
              return { ok: false, why: answer.why, problems: [] };
            }
            if (parsed === null || !answer.scopes.has(parsed.team)) {
              problems.push({
                why: `router fallback for "${alias}" names "${fallback}", which is not a team of this entity`,
                level: 'entity',
                name: 'router.fallback',
                kind: 'rule',
              });
              continue;
            }
          }
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
    // The team's real address forms: the registry id, its own name and its session — an
    // entity-scoped team's session is `<entity>-<project>` while its addresses still name the
    // project, so all three spellings reach its own seats, the same forms a send accepts.
    const ownScopes = new Set([teamIdOf(root), team.session, team.project]);
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
          if (parsed === null || parsed.seat === 'desk' || !seatNames.has(parsed.seat) || !ownScopes.has(parsed.team)) {
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
          // A team's fallback routes a miss, so it may only name a seat of this same team —
          // never one outside the team, the way its own aliases may not.
          if (fallback !== null) {
            const parsed = parseSeatTeamAddress(fallback);
            if (parsed === null || parsed.seat === 'desk' || !seatNames.has(parsed.seat) || !ownScopes.has(parsed.team)) {
              problems.push({
                why: `router fallback for "${alias}" names "${fallback}", which is not a seat of this team`,
                level: 'team',
                name: 'router.fallback',
                kind: 'rule',
              });
              continue;
            }
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
 * rather than routing a broken map. The team config is read through `readTeamConfig`; a file that
 * cannot be read refuses the whole read the way every policy reader refuses its source — never
 * the release defaults over a team it could not read.
 */
export function readMailboxRouterPolicy(
  root: string,
  home: string,
  now: Date = new Date(),
): MailboxRouterPolicyRead {
  const loaded = loadTeamOrWhy(root, home);
  if (!loaded.ok) return { ok: false, why: `the team file cannot be read (${loaded.why})` };
  const assembled = assembleRouterPolicy(root, home, now, loaded.team);
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
  team: TeamFile | null = loadTeamOrNull(root, home),
): MailboxRouterProblem[] {
  const assembled = assembleRouterPolicy(root, home, now, team);
  return assembled.ok ? [] : assembled.problems;
}

/** The team config at `root`, or why it cannot be read — the sentence the reader's refusal carries. */
function loadTeamOrWhy(root: string, home: string): { ok: true; team: TeamFile | null } | { ok: false; why: string } {
  try {
    const loaded = readTeamConfig(root, { home });
    if (loaded.ok) return { ok: true, team: loaded.team };
    const message = loaded.errors
      .map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message))
      .join('; ');
    return { ok: false, why: message === '' ? 'unknown problem' : message };
  } catch (error) {
    return { ok: false, why: (error as Error).message };
  }
}

/** The team config at `root`, or null when it cannot be read (the check path: its own gates name the file). */
function loadTeamOrNull(root: string, home: string): TeamFile | null {
  const loaded = loadTeamOrWhy(root, home);
  return loaded.ok ? loaded.team : null;
}
