// What the fallback sweep's counts line last said for each root, so the same refused and
// unreadable markers are not logged again on every five-second pass (2026-11-17: one root logged
// the same "refused 1" line every pass, 63k lines in a day). A pass that escalates is always said;
// a clean pass forgets the root, so a refusal that comes back after it is said again. Kept per
// process and bounded: past the bound the table starts over, which costs one repeated line per
// root, never a lost escalation.

/** The most roots one process remembers. */
const SAID_LIMIT = 500;

const said = new Map<string, string>();

type Counts = {
  escalated: readonly unknown[];
  refused: readonly { messageId: string; reason: string }[];
  unreadable: readonly string[];
};

/** The identity of one pass's refused and unreadable markers, in a stable order. */
export function sweepCountsKey(report: Pick<Counts, 'refused' | 'unreadable'>): string {
  const refused = report.refused.map((item) => `${item.messageId}\u0000${item.reason}`).sort();
  return JSON.stringify([refused, [...report.unreadable].sort()]);
}

/** Whether this pass's counts line is news for `root` (`scope` keeps the daemon's inline beat and
 *  a chores child apart), recording it when it is. A report with nothing to count clears the root
 *  and answers false. */
export function sweepCountsAreNews(scope: string, root: string, report: Counts): boolean {
  const at = `${scope}\u0000${root}`;
  if (report.escalated.length === 0 && report.refused.length === 0 && report.unreadable.length === 0) {
    said.delete(at);
    return false;
  }
  const key = sweepCountsKey(report);
  if (report.escalated.length === 0 && said.get(at) === key) return false;
  if (!said.has(at) && said.size >= SAID_LIMIT) said.clear();
  said.set(at, key);
  return true;
}

/** Forgets every root; for tests. */
export function resetSweepCountsSaid(): void {
  said.clear();
}
