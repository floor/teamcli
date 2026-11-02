// The read limits a watch pass runs under: how long the pass may spend reading the terminal
// host and the machine, and how long one read may take before its child is killed. Both are team
// policies (`watch-read-budget-ms`, `watch-read-timeout-ms`), resolved the same way the idle
// window and the pace are: the chain is read to `team`, because one pass reads a whole session
// and no seat sets it, and a shorter value is the tighter one. A chain that cannot be read
// resolves nothing: the pass uses the documented defaults and the reading says so.
import { projectIdOfTeam } from '../dev_mode.ts';
import type { TeamFile } from '../file/types.ts';
import { loadAndResolvePolicyChain } from '../policy/index.ts';

/** The documented defaults, in milliseconds, when no level declares a value. */
export const READ_LIMITS_DEFAULT_MS = { budget: 2000, timeout: 2000 } as const;

export type ReadLimits = {
  /** How long one pass may spend reading before its remaining panes wait for the next pass. */
  budgetMs: number;
  /** The longest one read may take before its child is killed. */
  timeoutMs: number;
  /** Present when the chain could not be read or a value did not resolve to a number: the
   *  figures are the documented defaults, not a level's choice. */
  unknown?: string;
};

/**
 * The read limits in force. A chain that cannot be read is not a chain that declared nothing, so
 * the reading carries `unknown`; the values are the defaults either way, and nothing here writes
 * the expired-policy markers a command would.
 */
export function watchReadLimits(team: TeamFile, root: string, home: string | undefined, now: Date): ReadLimits {
  try {
    const resolved = loadAndResolvePolicyChain(
      {
        home,
        entity: team.entity,
        projectId: home === undefined ? null : projectIdOfTeam(home, team, root),
        teamRoot: root,
        team,
      },
      { now, upToLevel: 'team' },
    );
    if (!resolved.ok) {
      const why = resolved.refusals.map((refusal) => refusal.message).join('; ');
      return {
        budgetMs: READ_LIMITS_DEFAULT_MS.budget,
        timeoutMs: READ_LIMITS_DEFAULT_MS.timeout,
        unknown: why === '' ? 'the policy chain could not be read' : why,
      };
    }
    const budget = resolved.policies['watch-read-budget-ms']?.value;
    const timeout = resolved.policies['watch-read-timeout-ms']?.value;
    const limits: ReadLimits = {
      budgetMs: typeof budget === 'number' ? budget : READ_LIMITS_DEFAULT_MS.budget,
      timeoutMs: typeof timeout === 'number' ? timeout : READ_LIMITS_DEFAULT_MS.timeout,
    };
    if (typeof budget !== 'number' || typeof timeout !== 'number') {
      limits.unknown = 'the read limits did not resolve to a number';
    }
    return limits;
  } catch (error) {
    return {
      budgetMs: READ_LIMITS_DEFAULT_MS.budget,
      timeoutMs: READ_LIMITS_DEFAULT_MS.timeout,
      unknown: error instanceof Error ? error.message : String(error),
    };
  }
}
