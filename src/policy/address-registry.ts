// A policy word that stores one or more `seat@team` addresses is refused at write time when a
// team word does not resolve in this home's registry. The registry answers a word by registered
// team id, by the team's own name (its `project`), or by its session — the three spellings an
// address's `@team` may use — so a value that would only fail later, when the address is used,
// is caught where it is written. `planPolicySet` runs the check, so `--dry-run` refuses the same
// value and the real write refuses too; nothing is written either way.
import { findTeams, readTeams } from '../registry/teams.ts';
import {
  parseRouterAliases,
  parseRouterFallback,
  parseSeatTeamAddress,
  type PolicyValue,
} from './types.ts';

/** The teams a refusal lists — each by the three spellings an address's `@team` may use — or the
 *  sentence saying there are none to list. */
function registryHas(home: string): string {
  const teams = Object.values(readTeams(home));
  if (teams.length === 0) return 'the registry has no teams';
  const said = teams
    .map((team) => `${team.project} (id ${team.id ?? '(none)'}, session ${team.session})`)
    .sort()
    .join(', ');
  return `the registry has: ${said}`;
}

/** Why `word` does not name exactly one team in this home, or null when it names one. */
function teamWordProblem(home: string, word: string): string | null {
  const found = findTeams(home, word);
  if (found.length === 1) return null;
  if (found.length === 0) {
    return `which no team registry record matches (by id, name or session); ${registryHas(home)}`;
  }
  const ids = found.map((team) => team.id ?? '(no id)').sort().join(', ');
  return `which ${String(found.length)} registry records answer (ids: ${ids}); say which by its id`;
}

/** One address's refusal under its policy, or null when its team word resolves. `subject` names
 *  the word the address was written under (the raw address, an alias, or a fallback's alias). */
function addressProblem(home: string, name: string, subject: string, address: string): string | null {
  const parsed = parseSeatTeamAddress(address);
  // A value that is not an address at all is refused by its own value rule before this runs.
  if (parsed === null) return null;
  const problem = teamWordProblem(home, parsed.team);
  if (problem === null) return null;
  return `policy "${name}": ${subject} names team ${JSON.stringify(parsed.team)}, ${problem}`;
}

/**
 * The write-time refusal for an address policy in this home's registry, or null when every
 * address resolves (or the name is not one of the address policies). Only the three policies
 * that store `seat@team` addresses are checked; the value rules have already run.
 */
export function policyAddressRegistryProblem(home: string, name: string, value: PolicyValue): string | null {
  if (name === 'owner-reply-to') {
    const address = typeof value === 'string' ? value.trim() : '';
    return addressProblem(home, name, JSON.stringify(address), address);
  }
  if (name === 'router.aliases' || name === 'router.fallback') {
    const entries = name === 'router.aliases' ? parseRouterAliases(value) : parseRouterFallback(value);
    if (entries === null) return null;
    for (const [alias, address] of entries) {
      if (address === null) continue;
      const subject = name === 'router.aliases' ? `alias ${JSON.stringify(alias)}` : `fallback for ${JSON.stringify(alias)}`;
      const problem = addressProblem(home, name, subject, address);
      if (problem !== null) return problem;
    }
  }
  return null;
}
