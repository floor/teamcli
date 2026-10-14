import { format } from './format.ts';
import { project } from './project.ts';
import { entity } from './entity.ts';
import { lobby } from './lobby.ts';
import { trust } from './trust.ts';
import { dialogs } from './dialogs.ts';
import { limits } from './limits.ts';
import { machine } from './machine.ts';
import { rules } from './rules.ts';
import { identity } from './identity.ts';
import { workspace } from './workspace.ts';
import { orchestrator } from './orchestrator.ts';
import { operator } from './operator.ts';
import { session } from './session.ts';
import { visibility } from './visibility.ts';
import { tools } from './tools.ts';
import { budgets } from './budgets.ts';
import { watch } from './watch.ts';
import { watchChecks } from './watch-checks.ts';
import { seats } from './seats.ts';
import { releases } from './releases.ts';
import { delegates } from './delegate.ts';
import { grant } from './grant.ts';
import { tasks } from './tasks.ts';
import { tempo } from './tempo.ts';
import type { Section } from './section.ts';

/**
 * Every section of the team file, in one order. The owner-only list is generated from this order
 * (`SECTIONS.filter(s => s.owner).map(s => s.name)`), and that order feeds the approval digest,
 * so it is part of the contract: the owner sections appear here exactly as the digest reads them.
 * The validator walks the list running each section once every section it names in `after` has
 * run, which is the order `validate.ts` read them in before the sections were modules.
 */
export const SECTIONS: readonly Section[] = [
  format,
  project,
  // Where this team's lobby lives. Both non-owner and additive: a file that sets neither keeps the
  // machine-global lobby, so they change no approval digest and sit outside the owner-section list.
  entity,
  lobby,
  trust,
  dialogs,
  limits,
  machine,
  rules,
  identity,
  workspace,
  // The lead's section, canonical name `orchestrator`, declared key `coordinator`: the position,
  // the `after` and the owner bucket stay where they were, under the canonical name.
  orchestrator,
  operator,
  session,
  visibility,
  tools,
  budgets,
  watch,
  watchChecks,
  seats,
  releases,
  // The sections before `tasks` keep the relative order records were written with.
  tasks,
  // Immediately before `grant`, so the sections already in the digest keep their order.
  tempo,
  // Immediately before `delegates`, so `delegates` stays the last owner section.
  grant,
  // Last, after every owner section there was: the owner-section list is filtered from this one,
  // so `delegates` is the last entry of the approval digest and of a difference report, and the
  // sections before it keep the relative order records were written with.
  delegates,
];
