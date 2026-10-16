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
