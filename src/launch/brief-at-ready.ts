// RFC event-comms E2: a launch brief offered again once its seat is ready.
//
// `team up` writes each seat's general brief before the seat runs, so the send walk often finds no
// live route and the signed record is kept in the seat's inbox with nothing to wake the seat for it
// (the lead-unread alarm then fires minutes later). Once the plan has brought the seat to `ready`,
// this offers that same delivery once more through the ordinary send walk, on the legacy wake path.
//
// It is bound to the seat's current claim: the record must be the delivery the seat's state claims
// now (same id, incarnation and brief digest), and it must not already be read. A stale or
// superseded delivery is refused and never offered. A seat that is not ready, or whose delivery the
// launch's own walk already took, is left alone. Nothing here types by itself: the walk's legs keep
// their own proofs (idle screen, empty box, the seat's own listener), and the existing unread sweep
// still offers the brief if this offer is not taken (a lost or reordered ready changes nothing).
import { join } from 'node:path';
import { currentClaimIn, receiptHeld } from '../mcp/inbox.ts';
import {
  briefBindingOf,
  walkBriefDeliveries,
  type BriefDeliveryReport,
  type BriefWalkPlan,
  type CurrentBriefClaim,
} from './general-brief.ts';

export type BriefAtReadyNote = { seat: string; offered: boolean; said: string };

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
  walk?: (report: BriefDeliveryReport, input: { dir: string; home: string }) => Promise<BriefDeliveryReport>;
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
  const walk = input.walk ?? walkBriefDeliveries;
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
    const single: BriefDeliveryReport = {
      deliveries: [{ seat: plan.seat, ok: true, id: claim.id, at: claim.at, incarnation: claim.incarnation, epoch: claim.epoch }],
      walks: [plan],
    };
    const walked = await walk(single, { dir: input.dir, home: input.home });
    const after = walked.deliveries[0];
    if (after !== undefined && after.ok) {
      const via = after.message?.via ?? 'a leg';
      notes.push({ seat: plan.seat, offered: true, said: `${plan.seat}: the launch brief was offered at ready (${via})` });
    } else {
      const why = after !== undefined && !after.ok ? after.reason : 'no leg was walked';
      notes.push({ seat: plan.seat, offered: false, said: `${plan.seat}: the launch brief was not taken at ready (${why}); the unread sweep still offers it` });
    }
  }
  return notes;
}
