// Endpoint hosting is independent of lifecycle; automatic seat restoration is not.
import { realpathSync } from 'node:fs';
import { readTeams } from '../registry/teams.ts';
import { currentRunMemo } from '../run-memo.ts';

/** A fresh registry reading before scheduling or executing automatic restore. Unregistered
 * explicit roots retain their existing restore behavior. Any matching inactive row blocks
 * restoration, including when another row or declared session still says running. */
export function restoreLifecycleProblem(home: string, root: string, team: string): string | null {
  try {
    const canonical = realpathSync(root);
    // A pass rechecks under the session run lock; an earlier configuration read must not
    // memoize a lifecycle from before a concurrent stop completed.
    const memo = currentRunMemo();
    memo?.teamsTolerant.delete(home);
    memo?.teamsStrict.delete(home);
    for (const record of Object.values(readTeams(home))) {
      if (record.project !== team) continue;
      let folder: string;
      try { folder = realpathSync(record.root || record.lobby); }
      catch { continue; }
      if (folder !== canonical || record.lifecycle === 'running') continue;
      return `the registry team is ${record.lifecycle}; automatic restore is disabled`;
    }
    return null;
  } catch {
    return 'the registry lifecycle cannot be verified; automatic restore is disabled';
  }
}
