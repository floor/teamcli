// Reading the entity's model rule across every team of the entity (Policies rule 10).
//
// The rule is a file declaration: a seat breaks it when the vendor its team file declares does
// not satisfy the rule for its name and role. A screen that contradicts its own file is the
// model-drift check's report, not this one.
//
// A replacement is a recipe copied from a seat already running in the entity's teams — never
// invented. The target keeps its role, name, nickname and place; it takes the donor's model
// fields only. Donors from the same team come first, a same-CLI donor first within that (a
// same-CLI swap is the one the tool may try to resume), and a team's visibility is never
// widened: a public team draws no recipe from a private one.

import { resolve } from 'node:path';
import { readTeamConfig } from '../file/team-config.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { modelRuleAllows, parseModelRuleValue, type ModelRuleEntry } from '../policy/model-rule.ts';
import { normalizePolicyName } from '../policy/types.ts';
import { resolvePolicy } from '../policy/resolve.ts';
import { readEntityPolicySource } from '../policy/sources.ts';
import { readTeams, type TeamRecord } from '../registry/teams.ts';

/** The model fields a seat takes when it moves to another vendor's model. */
export type ModelRecipe = {
  cli: string;
  vendor: string;
  model: string;
  version: string;
  display: string;
  launch: string;
  modelFrom?: 'launcher';
  effort?: string;
  /** The target's own account, kept only when it names the recipe's vendor. */
  account?: string;
};

export type RuleDonor = { team: string; root: string; seat: string };

export type RuleBreach = {
  team: string;
  root: string;
  visibility: 'public' | 'private';
  seat: Seat;
  proposal: { donor: RuleDonor; recipe: ModelRecipe } | null;
  /** Why no recipe was proposed, when none was. */
  reason?: string;
};

/** A team of the entity read for the rule: the current team first, then the registry's. */
export type RuleTeam = {
  id: string | null;
  name: string;
  root: string;
  visibility: 'public' | 'private';
  file: TeamFile;
};

export type RuleListing = {
  /** The entity the current team declares, or null: a model rule holds only at entity level. */
  entity: string | null;
  /** The rule in force, canonical; '' when the entity has none. */
  rule: string;
  entries: readonly ModelRuleEntry[];
  teams: readonly RuleTeam[];
  breaches: readonly RuleBreach[];
  /**
   * Records of the entity that could not be read as their own team any more — a moved root, a
   * file that no longer declares the entity, an unreadable file. Named, never silently skipped.
   */
  ignored: readonly { root: string; why: string }[];
};

export type RuleLookup = { ok: true; listing: RuleListing } | { ok: false; why: string };

export type RuleInput = {
  home: string;
  /** The current team's loaded file and root. */
  team: TeamFile;
  root: string;
  /** The team's registry id, when the caller knows it: skips its own registry record. */
  teamId?: string | null;
};

function refusalText(source: { why: string }, level: string): string {
  return `${level}: policy source cannot be read or verified (${source.why})`;
}

/**
 * Reads the rule in force and every breach of it in the entity's teams. The read fails closed:
 * an entity source that cannot be verified, or a rule that does not parse, is a refusal — never
 * an empty rule.
 */
export function listModelRuleBreaches(input: RuleInput): RuleLookup {
  const entity = input.team.entity;
  if (!entity) {
    return {
      ok: true,
      listing: { entity: null, rule: '', entries: [], teams: [], breaches: [], ignored: [] },
    };
  }

  const source = readEntityPolicySource(input.home, entity);
  if (!source.ok) return { ok: false, why: refusalText(source, 'entity') };
  // The resolver takes one policy's declarations: another name's value would be parsed by
  // this name's grammar (Policies rule 10).
  const declarations = source.policies.filter((policy) => normalizePolicyName(policy.name) === 'model-rule');
  const resolved = resolvePolicy('model-rule', declarations);
  if (!resolved.ok) {
    return { ok: false, why: resolved.refusals.map((refusal) => refusal.message).join('; ') };
  }
  const rule = typeof resolved.effective.value === 'string' ? resolved.effective.value : '';
  const entries = parseModelRuleValue(rule);

  const teams: RuleTeam[] = [
    {
      id: input.teamId ?? null,
      name: input.team.project,
      root: input.root,
      visibility: input.team.visibility,
      file: input.team,
    },
  ];
  const ignored: { root: string; why: string }[] = [];
  const known = new Set<string>([resolve(input.root)]);

  let records: Record<string, TeamRecord>;
  try {
    records = readTeams(input.home);
  } catch (error) {
    return { ok: false, why: `the team registry cannot be read: ${(error as Error).message}` };
  }

  for (const [id, record] of Object.entries(records)) {
    if (record.entity !== entity) continue;
    if (id === input.teamId) continue;
    const root = resolve(record.root);
    if (known.has(root)) continue;
    known.add(root);
    const loaded = readTeamConfig(record.root, { home: input.home });
    if (!loaded.ok) {
      ignored.push({
        root: record.root,
        why: loaded.errors.map((problem) => problem.message).join('; '),
      });
      continue;
    }
    if (loaded.team.entity !== entity) {
      ignored.push({
        root: record.root,
        why: `the team file now declares ${loaded.team.entity ? `entity "${loaded.team.entity}"` : 'no entity'}`,
      });
      continue;
    }
    teams.push({
      id,
      name: loaded.team.project,
      root: loaded.root,
      visibility: loaded.team.visibility,
      file: loaded.team,
    });
  }

  const breaches: RuleBreach[] = [];
  for (const team of teams) {
    for (const seat of team.file.seats) {
      if (modelRuleAllows(entries, { name: seat.name, role: seat.role, vendor: seat.vendor })) continue;
      const proposal = propose(entries, teams, team, seat);
      breaches.push({
        team: team.name,
        root: team.root,
        visibility: team.visibility,
        seat,
        proposal: proposal.proposal,
        ...(proposal.reason ? { reason: proposal.reason } : {}),
      });
    }
  }

  return { ok: true, listing: { entity, rule, entries, teams, breaches, ignored } };
}

export type RecipeLookup = { ok: true; donor: RuleDonor; recipe: ModelRecipe } | { ok: false; why: string };

/**
 * The donor for a swap the caller aimed at one model (`team swap queue <seat> --to <cli>:<model>`).
 * The same rules as a proposal: same visibility only, never the target itself, never a recipe
 * that would break the rule for the target, same team and same CLI first. The words are matched
 * without case, so `Claude-Code:deepseek flash` finds what the file writes.
 */
export function findRecipe(
  listing: RuleListing,
  target: { name: string; role: string; cli: string; account?: string },
  want: { cli: string; model: string },
): RecipeLookup {
  const cli = want.cli.trim().toLowerCase();
  const model = want.model.trim().toLowerCase();
  type Candidate = { donor: RuleDonor; seat: Seat; rank: number };
  const candidates: Candidate[] = [];
  const self = listing.teams[0];
  for (const team of listing.teams) {
    if (self && team.visibility !== self.visibility) continue;
    for (const seat of team.file.seats) {
      if (team.root === self?.root && seat.name === target.name) continue;
      if (seat.cli.toLowerCase() !== cli || seat.model.trim().toLowerCase() !== model) continue;
      if (!modelRuleAllows(listing.entries, { name: target.name, role: target.role, vendor: seat.vendor })) continue;
      const rank = (team.root === self?.root ? 0 : 2) + (seat.cli === target.cli ? 0 : 1);
      candidates.push({ donor: { team: team.name, root: team.root, seat: seat.name }, seat, rank });
    }
  }
  if (candidates.length === 0) {
    return { ok: false, why: `no seat of the entity this team may copy from runs ${want.cli}:${want.model}` };
  }
  const order = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);
  candidates.sort(
    (a, b) => a.rank - b.rank || order(a.donor.team, b.donor.team) || order(a.donor.seat, b.donor.seat),
  );
  const winner = candidates[0]!;
  return {
    ok: true,
    donor: winner.donor,
    recipe: recipeOf(winner.seat, target),
  };
}

/** The recipe a breaching seat would take, and the donor it came from. */
function propose(
  entries: readonly ModelRuleEntry[],
  teams: readonly RuleTeam[],
  targetTeam: RuleTeam,
  target: Seat,
): { proposal: RuleBreach['proposal']; reason?: string } {
  type Candidate = { donor: RuleDonor; seat: Seat; rank: number };
  const candidates: Candidate[] = [];
  for (const team of teams) {
    if (team.visibility !== targetTeam.visibility) continue;
    for (const seat of team.file.seats) {
      if (team.root === targetTeam.root && seat.name === target.name) continue;
      if (!modelRuleAllows(entries, { name: target.name, role: target.role, vendor: seat.vendor })) continue;
      const rank = (team.root === targetTeam.root ? 0 : 2) + (seat.cli === target.cli ? 0 : 1);
      candidates.push({ donor: { team: team.name, root: team.root, seat: seat.name }, seat, rank });
    }
  }
  if (candidates.length === 0) {
    return {
      proposal: null,
      reason: targetTeam.visibility === 'public'
        ? 'no seat of the entity on a public team runs a model the rule allows here'
        : 'no seat of the entity on a team of the same visibility runs a model the rule allows here',
    };
  }
  const order = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);
  candidates.sort(
    (a, b) => a.rank - b.rank || order(a.donor.team, b.donor.team) || order(a.donor.seat, b.donor.seat),
  );
  const winner = candidates[0]!;
  return {
    proposal: { donor: winner.donor, recipe: recipeOf(winner.seat, target) },
  };
}

/** The target's model fields, taken from the donor; the account never widens. */
function recipeOf(donor: Seat, target: { account?: string }): ModelRecipe {
  return {
    cli: donor.cli,
    vendor: donor.vendor,
    model: donor.model,
    version: donor.version,
    display: donor.display,
    launch: donor.launch,
    ...(donor.modelFrom ? { modelFrom: donor.modelFrom } : {}),
    ...(donor.effort ? { effort: donor.effort } : {}),
    ...(target.account === donor.vendor ? { account: target.account } : {}),
  };
}
