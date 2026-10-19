// The entity's model rule as one watch pass reads it (Policies rule 10): the rule in force, its
// entries — the `*` entry decides for a pane no seat claims — and this team's breaching seats, by
// name. The pass never reads the entity's files: the caller reads the rule once, here, and hands
// the reading to the core.
import { resolve } from 'node:path';
import type { TeamFile } from '../file/types.ts';
import { teamIdOf } from '../registry/teams.ts';
import { listModelRuleBreaches, type RuleLookup } from '../swap/rule.ts';
import type { ModelRuleBreachReading, ModelRulePass } from './check.ts';

/**
 * The rule as a pass reads it. A rule that cannot be read is its reason, never an empty rule: the
 * pass says it once to the owner, and no breach is judged. A team that declares no entity, or a
 * team with no home to read the entity's policy records from, has no rule.
 */
export function modelRuleOfPass(team: TeamFile, root: string, home: string | undefined): ModelRulePass {
  if (home === undefined || team.entity === null) return null;
  let found: RuleLookup;
  try {
    found = listModelRuleBreaches({ home, team, root, teamId: teamIdOf(root) });
  } catch (error) {
    return { ok: false, why: `the model rule cannot be read: ${(error as Error).message}` };
  }
  if (!found.ok) return found;
  const listing = found.listing;
  const breaches = new Map<string, ModelRuleBreachReading>();
  const here = resolve(root);
  for (const breach of listing.breaches) {
    if (resolve(breach.root) !== here) continue;
    breaches.set(breach.seat.name, {
      rule: listing.rule,
      vendor: breach.seat.vendor,
      proposal: breach.proposal
        ? `${breach.proposal.recipe.cli} ${breach.proposal.recipe.model} ${breach.proposal.recipe.version} from ${breach.proposal.donor.team}/${breach.proposal.donor.seat}`
        : null,
      ...(breach.proposal ? { recipe: breach.proposal } : {}),
      reason: breach.reason ?? null,
    });
  }
  return { ok: true, rule: listing.rule, entries: listing.entries, breaches };
}
