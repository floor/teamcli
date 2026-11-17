// RFC event-comms E2: a launch brief offered again once its seat is ready.
//
// `team up` writes each seat's general brief before the seat runs, so the send walk often finds no
// live route and the signed record is kept in the seat's inbox with nothing to wake the seat for it
// (the lead-unread alarm then fires minutes later). Once the plan has brought the seat to `ready`,
// this offers that same delivery once more through the full event-delivery walk (`eventWalk`).
//
// It is bound to the seat's current claim: the record must be the delivery the seat's state claims
// now (same id, incarnation and brief digest), and it must not already be read. A stale or
// superseded delivery is refused and never offered. A seat that is not ready, or whose delivery the
// launch's own walk already took, is left alone. Nothing here types by itself: the walk's legs keep
// their own proofs (idle screen, empty box, the seat's own listener), and the existing unread sweep
// still offers the brief if this offer is not taken (a lost or reordered ready changes nothing).
import { join } from 'node:path';
import { currentClaimIn, receiptHeld } from '../mcp/inbox.ts';
import type { SendHost } from '../commands/send.ts';
import type { TeamFile } from '../file/types.ts';
import { briefBindingOf, type BriefDeliveryReport, type BriefWalkPlan, type CurrentBriefClaim } from './general-brief.ts';

export type BriefAtReadyNote = { seat: string; offered: boolean; said: string };

/** One ready offer's walk: the delivery and plan of one seat. Returns the leg that took it, or why
 *  none did. */
export type ReadyWalk = (input: {
  dir: string;
  root: string;
  session: string;
  home: string;
  plan: BriefWalkPlan;
  team: TeamFile;
  /** The send host the walk uses; the real one with this run's home when absent. */
  host?: SendHost;
}) => Promise<{ ok: true; via: string } | { ok: false; reason: string }>;

/**
 * The default walk: the full event-delivery walk every carrier of an already written record takes
 * (`walkReplyDelivery`: the receiving seat's own resolved order, the development channel's push,
 * the Codex native queue, the webhook, the profile-gated typed wake, the bus inbox under them),
 * with every pane-safety, held-box and human rule it keeps. The record is the launch's own; no leg
 * writes a second one. A walk that ends at the inbox (`drop`) is not an offer the seat took.
 */
export const eventWalk: ReadyWalk = async (input) => {
  const { realHost, walkReplyDelivery } = await import('../commands/send.ts');
  const { namingFor } = await import('../send/names.ts');
  const { teamIdOf } = await import('../registry/teams.ts');
  const host = input.host ?? { ...realHost, home: input.home };
  const teamId = teamIdOf(input.root);
  const quiet = { stdout: () => {}, stderr: () => {}, cwd: input.root, env: {}, stdinIsTTY: false };
  const walk = await walkReplyDelivery({
    io: quiet,
    host,
    dir: input.dir,
    root: input.root,
    project: input.team.project,
    session: input.session,
    seat: input.plan.seat,
    cli: input.plan.cli,
    payload: input.plan.payload,
    naming: namingFor({ home: input.home, root: input.root, viewerTeam: teamId, seat: input.plan.seat, file: input.team }),
    file: input.team,
    sender: { teamId, project: input.team.project, label: null },
    address: null,
    who: input.plan.payload.from,
  });
  if (!walk.walked) return { ok: false, reason: walk.failures.length === 0 ? 'no delivery leg could run' : walk.failures.join('; ') };
  if (walk.via === 'drop' || walk.endpointBlocked !== undefined) {
    return { ok: false, reason: walk.failures.length === 0 ? 'no wake leg took it' : walk.failures.join('; ') };
  }
  return { ok: true, via: String(walk.via) };
};

export type BriefAtReadyInput = {
  /** The launch's own brief report, after its walks ran. */
  report: BriefDeliveryReport | undefined;
  /** The seats the plan brought to ready in this run. */
  ready: ReadonlySet<string>;
  /** The team's `.agents` folder. */
  dir: string;
  root: string;
  session: string;
  home: string;
  /** Seams for tests: the real claim read, receipt read and walk are the defaults. */
  claimOf?: (root: string, session: string, seat: string) => CurrentBriefClaim | null;
  isRead?: (dropDir: string, id: string, context: { to: string; root: string; session: string }, home: string, claim: CurrentBriefClaim) => boolean;
  /** The receiving team file: the walk resolves the seat's order and legs from it. */
  team: TeamFile;
  walk?: ReadyWalk;
};

/** Whether the claim names exactly the delivery this plan walked. */
function claimMatches(claim: CurrentBriefClaim, plan: BriefWalkPlan): boolean {
  const payload = plan.payload as { id?: unknown; incarnation?: unknown; brief_sha256?: unknown };
  return payload.id === claim.id && payload.incarnation === claim.incarnation && payload.brief_sha256 === claim.sha256;
}

export async function offerBriefsAtReady(input: BriefAtReadyInput): Promise<BriefAtReadyNote[]> {
  const notes: BriefAtReadyNote[] = [];
  const report = input.report;
  if (report === undefined) return notes;
  const claimOf = input.claimOf ?? currentClaimIn;
  const isRead = input.isRead
    ?? ((dropDir, id, context, home, claim) => receiptHeld(dropDir, id, context, home, briefBindingOf(claim)));
  const walk = input.walk ?? eventWalk;
  for (const plan of report.walks ?? []) {
    const delivery = report.deliveries.find((one) => one.seat === plan.seat);
    // Only a delivery whose record stands and whose walk took no leg: an ok walk already reached
    // the seat, and a record that was never written has nothing to offer.
    if (delivery === undefined || delivery.ok || delivery.message === undefined) continue;
    if (!input.ready.has(plan.seat)) continue;
    const claim = claimOf(input.root, input.session, plan.seat);
    if (claim === null || !claimMatches(claim, plan)) {
      notes.push({ seat: plan.seat, offered: false, said: `${plan.seat}: the launch brief was not offered at ready (its record is not the seat's current claim)` });
      continue;
    }
    const dropDir = join(input.dir, 'send-drops', input.session, plan.seat);
    if (isRead(dropDir, claim.id, { to: plan.seat, root: input.root, session: input.session }, input.home, claim)) continue;
    let walked: Awaited<ReturnType<ReadyWalk>>;
    try {
      walked = await walk({ dir: input.dir, root: input.root, session: input.session, home: input.home, plan, team: input.team });
    } catch (error) {
      walked = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (walked.ok) {
      notes.push({ seat: plan.seat, offered: true, said: `${plan.seat}: the launch brief was offered at ready (${walked.via})` });
    } else {
      notes.push({ seat: plan.seat, offered: false, said: `${plan.seat}: the launch brief was not taken at ready (${walked.reason}); the unread sweep still offers it` });
    }
  }
  return notes;
}
