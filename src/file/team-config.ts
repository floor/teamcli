import { loadTeamFile } from './load.ts';
import type { LoadResult } from './types.ts';

// The one read seam for a team's configuration. Every command that
// needs the team reads it here, never through the backing store directly, so the source can
// change behind this function without touching its callers.
//
// Phase 1: the only source is the project's `.agents/team.yaml`, read by `loadTeamFile`; the
// result, the problems and their wording are exactly the file reader's. Phase 2 adds the
// registry as a source behind this function, selected by a setting, with the team file as the
// fallback; the result shape stays `LoadResult` so no caller changes then either.

/** Where the configuration came from. Phase 1 has one source. */
export type TeamConfigSource = 'team-file';

/** The options the seam accepts: today, exactly the team-file reader's. */
export type ReadTeamConfigOptions = NonNullable<Parameters<typeof loadTeamFile>[1]>;

/** Finds, reads and validates the team's configuration for the folder `cwd`. */
export function readTeamConfig(cwd: string, options: ReadTeamConfigOptions = {}): LoadResult {
  return loadTeamFile(cwd, options);
}
