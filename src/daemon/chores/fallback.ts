// The fallback sweep as one of the child's chores.
//
// The daemon's beat used to run this on its own loop; it now belongs to whichever process hosts
// the root's chores, at the same five-second cadence and with the same words in the log. A root
// whose chores stay inline is still swept by the daemon's beat; every other root is swept here.
// The marker stays authoritative and `escalateDue` stays the one writer of the event, so a pass
// moved between processes keeps its meaning: the same signed event, from the same due instant.
//
// The store's retirement pass keeps its slower interval, per root and from this child's own
// start: a root's first pass here only escalates, and retirement follows once the interval has
// passed, so a restart never rewrites a store's history more often than the daemon did. The
// interval and the per-pass limit come from the sweep module, one source for both processes.
import { type DropRetirementReport, retireDropsSliced } from '../../send/drop-retention.ts';
import {
  FALLBACK_STORE_PASS_LIMIT,
  FALLBACK_STORE_PASS_MS,
  storeBacklogLimits,
  sweepFallbackEscalationsSliced,
  type SweepRoot,
  type SweepRootResult,
} from '../fallback-sweep.ts';
import type { ChoresPass } from './child.ts';
import type { ChoresChildConfig } from './protocol.ts';

/** The notes a host's log should carry for one finished root, in the daemon's own words. A
 *  skipped root names why and stops there; counts appear only when a pass has some. */
function passNotes(entry: SweepRootResult, drops: DropRetirementReport | null): string[] {
  const notes: string[] = [];
  if (entry.note !== null) notes.push(`fallback sweep: ${entry.note}`);
  if (entry.why !== null) {
    notes.push(`fallback sweep: ${entry.why}`);
    return notes;
  }
  const report = entry.report;
  if (report !== null && (report.escalated.length > 0 || report.refused.length > 0 || report.unreadable.length > 0)) {
    notes.push(
      `fallback sweep: escalated ${String(report.escalated.length)}, refused ${String(report.refused.length)}, unreadable ${String(report.unreadable.length)}`,
    );
  }
  const retired = entry.retirement;
  if (retired !== null) {
    const reclaimed = entry.reclaim?.reclaimed ?? 0;
    if (
      retired.retired.length > 0 ||
      retired.refused.length > 0 ||
      retired.unreadable.length > 0 ||
      reclaimed > 0
    ) {
      notes.push(
        `fallback store: retired ${String(retired.retired.length)}, reclaimed ${String(reclaimed)}, refused ${String(retired.refused.length)}, unreadable ${String(retired.unreadable.length)}`,
      );
    }
  }
  if (drops !== null) {
    if (drops.refused !== null) {
      notes.push(`drop store: refused (${drops.refused})`);
    } else if (drops.reclaimed.length > 0) {
      notes.push(
        `drop store: archived ${String(drops.archived.length)}, reclaimed ${String(drops.reclaimed.length)}`,
      );
    } else if (drops.archived.length > 0) {
      notes.push(`drop store: archived ${String(drops.archived.length)}`);
    }
  }
  return notes;
}

/**
 * The pass a child runs for each root it serves: one fallback sweep, with retirement on that
 * root's own housekeeping turns. The route's validated team file is used when the token carries
 * one; a hand-built token without it names the root and the sweep reads that root's team file,
 * refusing it by name when it no longer validates, exactly as a bare root does.
 */
export function createFallbackPass(config: ChoresChildConfig): ChoresPass {
  /** The instant of each root's last pass, so retirement keeps its slower cadence per root. */
  const lastStorePass = new Map<string, number>();
  return async ({ route, at, slices }) => {
    if (slices.stopping()) return [];
    // The first pass in this child only escalates: a restart's early ticks never rewrite history
    // a caller may still be reading, the same wait the daemon's beat keeps.
    const previous = lastStorePass.get(route.root);
    const startedAt = at.getTime();
    const housekeeping = previous !== undefined && startedAt - previous >= FALLBACK_STORE_PASS_MS;
    if (previous === undefined || housekeeping) lastStorePass.set(route.root, startedAt);
    const given: SweepRoot | string =
      route.teamFile === undefined ? route.root : { root: route.root, team: route.teamFile };
    // The pass runs under the child's own slice budget: the sweep's work items are taken a slice
    // at a time and the child's yield is awaited at each boundary, so a store walk answers the
    // heartbeat and a presence nudge instead of holding the loop until it finishes. A stop ends
    // the walk at its next boundary; the next child's pass starts from the durable markers.
    const swept = await sweepFallbackEscalationsSliced({
      home: config.home,
      roots: [given],
      now: () => at,
      ...(housekeeping
        ? {
            retire: {
              limit: FALLBACK_STORE_PASS_LIMIT,
              // The backlog knobs are the team's word, read for this root: above the threshold
              // one pass takes the bulk limit instead of the steady one. A chain that cannot be
              // read keeps the release defaults and says so in the notes.
              backlogLimitsFor: (entry: SweepRoot) => storeBacklogLimits(entry.team, entry.root, config.home, at),
              lockWaitMs: 0,
            },
          }
        : {}),
      slices,
    });
    const entry = swept.roots[0];
    if (entry === undefined) return [];
    let drops: DropRetirementReport | null = null;
    if (housekeeping && entry.why === null && !slices.stopping()) {
      drops = await retireDropsSliced({
        root: entry.root,
        home: config.home,
        ...(route.teamFile !== undefined ? { team: route.teamFile } : {}),
        at,
        limit: FALLBACK_STORE_PASS_LIMIT,
        slices,
      });
    }
    return passNotes(entry, drops);
  };
}
