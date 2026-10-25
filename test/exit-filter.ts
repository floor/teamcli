/**
 * `TEAM_EXIT_IDS` lets a local run of `test/exit-codes.test.ts` cover only the scenes a diff
 * touches. The filter is all-or-nothing: unset (or empty) runs every scene, and a filter
 * naming an id the contract does not list is a failure, never a silent skip.
 */

/** The ids `TEAM_EXIT_IDS` names, or null when no filter is set (every scene runs). */
export function wantedScenes(raw: string | undefined): Set<string> | null {
  if (raw === undefined) return null;
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  return ids.length === 0 ? null : new Set(ids);
}

/** True when a filter is set and does not name `id`: that scene is skipped. No filter never skips. */
export function skipsScene(wanted: Set<string> | null, id: string): boolean {
  return wanted !== null && !wanted.has(id);
}

/** The filter ids the contract does not list: a run with any of these fails instead of trusting itself. */
export function unknownScenes(wanted: Set<string> | null, known: Iterable<string>): string[] {
  if (wanted === null) return [];
  const have = new Set(known);
  return [...wanted].filter((id) => !have.has(id));
}

/**
 * `TEAM_EXIT_PART=<index>/<count>` splits one full run of the scenes over `count` processes, so
 * CI can spread `test/exit-codes.test.ts` across shards. Scenes are dealt by their position in
 * the contract (position % count === index): every scene runs in exactly one part. The checks
 * that read the whole repo, and the analyzer probes, run in part 0 only. Unset means one part.
 * A malformed value is an error, never a silent full or empty run.
 */
export type ScenePart = { index: number; count: number };

export function scenePart(raw: string | undefined): ScenePart | null {
  if (raw === undefined || raw.trim() === '') return null;
  const m = /^(\d+)\/(\d+)$/.exec(raw.trim());
  const index = m ? Number(m[1]) : NaN;
  const count = m ? Number(m[2]) : NaN;
  if (!m || count < 1 || index >= count) throw new Error(`TEAM_EXIT_PART must be <index>/<count> with index < count, not "${raw}"`);
  return { index, count };
}

/** True when a part is set and the scene at `position` in the contract belongs to another part. */
export function outsidePart(part: ScenePart | null, position: number): boolean {
  return part !== null && position % part.count !== part.index;
}

/** True when this run carries the whole-repo checks and analyzer probes: no part, or part 0. */
export function leadPart(part: ScenePart | null): boolean {
  return part === null || part.index === 0;
}
