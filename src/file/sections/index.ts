import { format } from './format.ts';
import { project } from './project.ts';
import { inProject } from './in_project.ts';
import { projectLead } from './project_lead.ts';
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
import { deliveryOrder } from './delivery_order.ts';
import { senderName } from './sender_name.ts';
import { policies } from './policies.ts';
import { releases } from './releases.ts';
import { delegates } from './delegate.ts';
import { grant } from './grant.ts';
import { installer } from './installer.ts';
import { clients } from './clients.ts';
import { tasks } from './tasks.ts';
import { tempo } from './tempo.ts';
import type { Section } from './section.ts';

/**
 * Every section of the team file, in one order. The owner-only list is generated from this order
 * (`SECTIONS.filter(s => s.owner).map(s => s.name)`), and that order feeds the approval digest,
 * so it is part of the contract: the owner sections appear here exactly as the digest reads them.
 * The validator walks the list running each section once every section it reads (`after`) has
 * run, which is the order `validate.ts` read them in before the sections were modules.
 */
export const SECTIONS: readonly Section[] = [
  format,
  project,
  // The project the team makes its own above; the project it sits in here. Non-owner and
  // additive, like `entity` and `lobby` below: absent in every file written before Phase 0b.
  inProject,
  // The team-side `leads: true`: set by the one team that leads the project `in_project` names,
  // and read by the registry's writers. Non-owner and additive too, and it reads `in_project`, so
  // it runs after it.
  projectLead,
  // Where this team's lobby lives. Both non-owner and additive: a file that sets neither keeps the
  // machine-global lobby, so they change no approval digest and sit outside the owner-section list.
  entity,
  lobby,
  trust,
  // The 0.4 line's trust-dialog setting, kept as a known deprecated field: read and ignored, so
  // it grants nothing and changes no approval digest. It runs without an `after` and its report
  // is printed by `team check` alone.
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
  // The file's word on how a send to its seats walks: non-owner and additive, so a file written
  // before it keeps every digest and approval it had, and it changes no approval fingerprint.
  // The seat-level word sits on a seat and is read by the seats section above.
  deliveryOrder,
  // The file's word on how a sender reads in TeamCLI's headlines: non-owner and additive, like
  // `delivery_order`, so a file written before it keeps every digest and approval it had. The
  // seat-level word sits on a seat and is read by the seats section above.
  senderName,
  // Owner-signed team-level policies (Kernel amendment 02 §2.12). Non-owner in the section list
  // so existing approval digests stay intact; each entry carries its own Ed25519 signature.
  policies,
  releases,
  // The sections before `tasks` keep the relative order records were written with.
  tasks,
  // Immediately before `grant`, so the sections already in the digest keep their order.
  tempo,
  // The seat that may record a green-slice install beside the owner. An owner section, so a file
  // that writes or changes it is a difference against the last approval; a record written before
  // it reads the omitted designation from its own copy, so the arrival alone is no difference.
  installer,
  // The seats an external client grant may address, by client id. An owner section; a record
  // written before it reads the omitted section as null, so the arrival alone is no difference.
  clients,
  // Immediately before `delegates`, so `delegates` stays the last owner section.
  grant,
  // Last, after every owner section there was: the owner-section list is filtered from this one,
  // so `delegates` is the last entry of the approval digest and of a difference report, and the
  // sections before it keep the relative order records were written with.
  delegates,
];
