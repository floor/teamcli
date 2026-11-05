// The chain a team's default lead resolves through: the team file's `lead:` word (passed in,
// already read and checked by its section), then the home project's `lead_seat`, the entity's
// `lead`, and the universe's default. The most specific declared word wins; a level that declares
// none is skipped without being invented. See `src/lead.ts` for the order and the word rule.
//
// The chain is read through the home project only: a served project's word
// never reaches the team, and no other team's file is read — the project and team words come from
// the registry records, the entity's from the owner's entities file. Each level is read only when
// every narrower one is silent, so a file above that cannot be read never takes away a lead the
// narrower level already set.
//
// The universe has no runtime record of its own in this build. The machine's settings file stands
// in for the universe's optional `lead:` (the field `library/en/universes/olympus.yaml` carries);
// when the library's universe reader lands, it supplies that level and the reader here is
// unchanged.

import { declaredEntityLead, entitiesPath } from './entities.ts';
import { leadWordProblem, resolveLead, type LeadChain, type ResolvedLead } from './lead.ts';
import { machineLead } from './settings/declared.ts';
import { byName, get, ofTeam, projectIdOf, projectsFile, type ProjectRecord } from './registry/projects.ts';
import { teamIdOf } from './registry/teams.ts';

export type LeadChainInput = {
  /** The home whose registry, entities file and machine settings are read. */
  home: string;
  /** The team's project root: the team's own word is about this checkout. */
  root: string;
  /** The team file's `lead:` word, when its section found one. */
  team?: string | null;
  /** The project the file names (`in_project:`), used only when the team is not yet in
   *  `projects.yaml` and that project lists no team at all. */
  inProject?: string | null;
  /** The entity the file names; the home project's entity when the file names none. */
  entity?: string | null;
};

export type LeadChainRead =
  | { ok: true; chain: LeadChain }
  | { ok: false; why: string };

/** The chain's words, read nearest-first: the first level that declares one ends the read. */
export function readLeadChain(input: LeadChainInput): LeadChainRead {
  const team = input.team ?? null;
  if (team !== null) return { ok: true, chain: { team } };

  let project: ProjectRecord | null;
  try {
    project = ofTeam(input.home, teamIdOf(input.root));
    if (project === null && input.inProject !== undefined && input.inProject !== null) {
      // The declared `in_project` stands in for the home project only while no team has claimed
      // that record: it names the project a team is about before the team is registered. A
      // project that lists teams belongs to them alone — a declared name never adopts another
      // team's project or the lead_seat it carries.
      const declared = byName(input.home, input.inProject) ?? get(input.home, projectIdOf(input.inProject));
      if (declared !== null && declared.teams.length === 0) project = declared;
    }
  } catch (error) {
    return { ok: false, why: `this team's home project cannot be read: ${(error as Error).message}` };
  }
  if (project !== null && project.leadSeat !== undefined) {
    const problem = leadWordProblem(project.leadSeat);
    if (problem !== null) {
      return { ok: false, why: `${projectsFile(input.home)}: project "${project.name}" lead_seat ${problem}` };
    }
    return { ok: true, chain: { project: project.leadSeat } };
  }

  const entity = input.entity ?? project?.entity ?? null;
  const entityLead = declaredEntityLead(input.home, entity);
  if (!entityLead.ok) return { ok: false, why: `${entitiesPath(input.home)}: ${entityLead.why}` };
  if (entityLead.lead !== null) return { ok: true, chain: { entity: entityLead.lead } };

  const universe = machineLead(input.home);
  if (!universe.ok) return { ok: false, why: universe.why };
  if (universe.lead !== null) return { ok: true, chain: { universe: universe.lead } };

  return { ok: true, chain: {} };
}

/** The default lead in force, with the level it came from; null when every level is silent. */
export function defaultLeadOf(input: LeadChainInput): { ok: true; lead: ResolvedLead | null } | { ok: false; why: string } {
  const read = readLeadChain(input);
  return read.ok ? { ok: true, lead: resolveLead(read.chain) } : read;
}
