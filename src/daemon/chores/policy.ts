// The chores policy in force for one hosted root.
//
// `daemon.chores` decides where the heavy per-root work runs, and three more catalogue policies
// bound one child: its slice budget, the missed heartbeats that end it, and the cap on its
// restart backoff. All four are read to the team level, like the daemon's other knobs, and a
// chain that cannot be read keeps the release defaults with `unknown` saying so: the chores are
// housekeeping, and a policy store that cannot answer must not stop a root from being hosted or
// its endpoint from answering. A child's limits are fixed for its lifetime; a restart reads the
// chain again, so a changed limit takes effect at the next child, never mid-pass.
import { projectIdOfTeam } from '../../dev_mode.ts';
import type { TeamFile } from '../../file/types.ts';
import {
  DAEMON_CHORES_DEFAULTS,
  DAEMON_CHORES_MODES,
  loadAndResolvePolicyChain,
  type DaemonChoresMode,
} from '../../policy/index.ts';

export type ChoresPolicy = {
  mode: DaemonChoresMode;
  sliceMs: number;
  missedBeats: number;
  backoffCapMs: number;
  /** Why the release defaults are in force; absent when the chain resolved every value. */
  unknown?: string;
};

const DEFAULT_MODE: DaemonChoresMode = DAEMON_CHORES_DEFAULTS.mode;

export function choresPolicyFor(
  team: TeamFile,
  root: string,
  home: string | undefined,
  now: Date,
): ChoresPolicy {
  const defaults: ChoresPolicy = {
    mode: DEFAULT_MODE,
    sliceMs: DAEMON_CHORES_DEFAULTS.sliceMs,
    missedBeats: DAEMON_CHORES_DEFAULTS.missedBeats,
    backoffCapMs: DAEMON_CHORES_DEFAULTS.backoffCapMs,
  };
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
      return { ...defaults, unknown: why === '' ? 'the policy chain could not be read' : why };
    }
    const mode = resolved.policies['daemon.chores']?.value;
    const sliceMs = resolved.policies['daemon.chores-slice-ms']?.value;
    const missedBeats = resolved.policies['daemon.chores-missed-beats']?.value;
    const backoffCapMs = resolved.policies['daemon.chores-backoff-cap-ms']?.value;
    const missing: string[] = [];
    if (typeof mode !== 'string' || !(DAEMON_CHORES_MODES as readonly string[]).includes(mode)) {
      missing.push('daemon.chores');
    }
    if (typeof sliceMs !== 'number') missing.push('daemon.chores-slice-ms');
    if (typeof missedBeats !== 'number') missing.push('daemon.chores-missed-beats');
    if (typeof backoffCapMs !== 'number') missing.push('daemon.chores-backoff-cap-ms');
    if (missing.length > 0) {
      return { ...defaults, unknown: `${missing.join(' and ')} did not resolve` };
    }
    return {
      mode: mode as DaemonChoresMode,
      sliceMs: sliceMs as number,
      missedBeats: missedBeats as number,
      backoffCapMs: backoffCapMs as number,
    };
  } catch (error) {
    return { ...defaults, unknown: error instanceof Error ? error.message : String(error) };
  }
}

/** The tightest of several policies, for the one child a shared group runs: the smallest slice
 *  answers a heartbeat soonest, the smallest miss allowance replaces a stuck child soonest, and
 *  the smallest cap retries soonest. A group with one root keeps that root's own word exactly. */
export function tightestPolicy(policies: readonly ChoresPolicy[]): ChoresPolicy {
  const first = policies[0];
  if (first === undefined) {
    return {
      mode: DEFAULT_MODE,
      sliceMs: DAEMON_CHORES_DEFAULTS.sliceMs,
      missedBeats: DAEMON_CHORES_DEFAULTS.missedBeats,
      backoffCapMs: DAEMON_CHORES_DEFAULTS.backoffCapMs,
    };
  }
  const unknown = policies.map((policy) => policy.unknown).filter((why): why is string => why !== undefined);
  return {
    mode: first.mode,
    sliceMs: Math.min(...policies.map((policy) => policy.sliceMs)),
    missedBeats: Math.min(...policies.map((policy) => policy.missedBeats)),
    backoffCapMs: Math.min(...policies.map((policy) => policy.backoffCapMs)),
    ...(unknown.length === 0 ? {} : { unknown: unknown.join('; ') }),
  };
}
