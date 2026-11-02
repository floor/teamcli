// The daemon's fallback sweep: one pass over every checkout the machine daemon hosts, firing the
// main escalation for episodes whose durable `dueAt` has passed. It adds no timer, process or
// socket of its own — the existing heartbeat calls it — and keeps no state: the marker's
// `dueAt`, its `escalatedAt` and a delivery's cancellation stay authoritative, and `escalateDue`
// remains the one reader of the signed delay and the one writer of the event.
//
// A pass is non-blocking by design (`lockWaitMs: 0`): the key lock of a message another live
// holder is working is deferred to the next existing heartbeat tick, never waited on, so one busy
// message can neither stall the daemon's event loop — and with it health and delivery — nor emit a
// refusal or a repeated event. The other roots and keys in the same pass keep moving.
//
// A pass runs on a caller-free `EscalationContext`. A daemon fires markers a host already
// recorded, so it has no verified seat to pass and must not invent one: the event's sender is the
// tag fixed in the marker at its first fact, and `noteTransport` — the transport path — still
// requires a full context with the verified caller.
import { projectIdOfTeam } from '../dev_mode.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import { DAEMON_BACKLOG_DEFAULTS, loadAndResolvePolicyChain } from '../policy/index.ts';
import {
  drainDeferredNotes,
  escalateDue,
  reclaimFallbackLocks,
  retireFinished,
  type DeferredNoteDrainReport,
  type EscalationReport,
  type RetirementReport,
} from '../send/fallback-events.ts';

/** A hosted checkout and the team file the daemon validated when it started. */
export type SweepRoot = { root: string; team: TeamFile };

/** A root given to a pass: an already-validated pair, or a bare path this module validates. */
export type SweepRootInput = SweepRoot | string;

/**
 * The fallback store's two backlog knobs in force for one root: above `above` eligible finished
 * episodes, one pass retires up to `limit` instead of its steady limit. Both are catalogue
 * policies (`daemon.fallback-backlog-above`, `daemon.fallback-backlog-limit`), read to the team
 * level like the daemon's other knobs. A chain that cannot be read keeps the release defaults and
 * carries `unknown`, because retirement is housekeeping: it keeps the store bounded either way,
 * and the caller says which word it could not read rather than acting on a word no level chose.
 */
export type StoreBacklogLimits = { above: number; limit: number; unknown?: string };

export function storeBacklogLimits(team: TeamFile, root: string, home: string | undefined, now: Date): StoreBacklogLimits {
  const defaults = { above: DAEMON_BACKLOG_DEFAULTS.above, limit: DAEMON_BACKLOG_DEFAULTS.limit };
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
    const above = resolved.policies['daemon.fallback-backlog-above']?.value;
    const limit = resolved.policies['daemon.fallback-backlog-limit']?.value;
    const missing = [
      typeof above === 'number' ? null : 'daemon.fallback-backlog-above',
      typeof limit === 'number' ? null : 'daemon.fallback-backlog-limit',
    ].filter((name): name is string => name !== null);
    if (missing.length > 0) {
      return { ...defaults, unknown: `${missing.join(' and ')} did not resolve to a number` };
    }
    return { above: above as number, limit: limit as number };
  } catch (error) {
    return { ...defaults, unknown: error instanceof Error ? error.message : String(error) };
  }
}

export type SweepRootResult = {
  root: string;
  /** The facts a busy episode key deferred while a send returned, recorded and cleared. */
  notes: DeferredNoteDrainReport | null;
  /** The pass over this root, or null when the root was not swept. */
  report: EscalationReport | null;
  /** What this pass retired, or null when the caller did not ask for retirement. */
  retirement: RetirementReport | null;
  /** The lock folders this pass reclaimed, or null when it did not reclaim. */
  reclaim: { reclaimed: number; kept: number; scanned: number } | null;
  /** Why the root was skipped; null when the pass ran. */
  why: string | null;
  /** What the pass has to say about the root besides its counts: a backlog word that could not
   *  be read and the release defaults the retirement used instead. Null when there is none. */
  note: string | null;
};

export type FallbackSweepResult = {
  at: string;
  roots: SweepRootResult[];
};

/**
 * Sweep every hosted root once at `input.now()`. A bare root whose team file does not validate
 * is refused by name and swept not at all — a root the daemon never validated contributes
 * nothing. A throw inside one root's pass is reported for that root and never stops another root
 * or the heartbeat that called this. Each pass hands `escalateDue` that root's validated team, so
 * the delay reader resolves that root's chain, and no `Caller`, so no identity is fabricated. The
 * key lock is taken with `waitMs: 0`, so a busy episode is deferred to the next tick, not waited on.
 */
export function sweepFallbackEscalations(input: {
  home: string;
  roots: readonly SweepRootInput[];
  now: () => Date;
  /** Ask this pass to retire finished episodes and reclaim their lock folders after the
   *  escalation pass. Absent, the pass only escalates — a direct sweep never writes the store's
   *  history. `backlogAbove`/`backlogLimit` let one pass drain a store that was never retired
   *  before; see `retireFinished`. `backlogLimitsFor` reads them per root from that root's team
   *  policy instead, over the two fields when it returns them. */
  retire?: {
    limit?: number;
    lockWaitMs?: number;
    youngMs?: number;
    backlogAbove?: number;
    backlogLimit?: number;
    backlogLimitsFor?: (entry: SweepRoot) => StoreBacklogLimits;
  };
}): FallbackSweepResult {
  const at = input.now();
  const roots: SweepRootResult[] = [];
  for (const given of input.roots) {
    let entry: SweepRoot;
    if (typeof given === 'string') {
      const loaded = readTeamConfig(given, { home: input.home });
      if (!loaded.ok) {
        roots.push({
          root: given,
          notes: null,
          report: null,
          retirement: null,
          reclaim: null,
          why: loaded.errors[0]?.message ?? 'the team file cannot be read',
          note: null,
        });
        continue;
      }
      entry = { root: loaded.root, team: loaded.team };
    } else {
      entry = given;
    }
    try {
      const ctx = { team: entry.team, root: entry.root, home: input.home, now: input.now };
      // Notes first: a fact a send deferred is recorded before this pass judges the episode, so
      // an exhaustion it carries schedules its escalation in the same tick rather than the next.
      const notes = drainDeferredNotes(ctx, { at });
      const report = escalateDue(ctx, { at, lockWaitMs: 0 });
      // Escalation first: a pending intent is flushed before retirement may archive its episode,
      // and an intent written during the pass keeps the marker out of the retired set.
      let retirement: RetirementReport | null = null;
      let reclaim: { reclaimed: number; kept: number; scanned: number } | null = null;
      let note: string | null = null;
      if (input.retire !== undefined) {
        const policy = input.retire.backlogLimitsFor?.(entry);
        const backlogAbove = policy?.above ?? input.retire.backlogAbove;
        const backlogLimit = policy?.limit ?? input.retire.backlogLimit;
        retirement = retireFinished(ctx, {
          at,
          lockWaitMs: input.retire.lockWaitMs ?? 0,
          ...(input.retire.limit !== undefined ? { limit: input.retire.limit } : {}),
          ...(backlogAbove !== undefined ? { backlogAbove } : {}),
          ...(backlogLimit !== undefined ? { backlogLimit } : {}),
        });
        reclaim = reclaimFallbackLocks(ctx, {
          ...(input.retire.limit !== undefined ? { limit: input.retire.limit } : {}),
          ...(input.retire.youngMs !== undefined ? { youngMs: input.retire.youngMs } : {}),
        });
        if (policy?.unknown !== undefined) {
          note = `the store backlog word could not be read (${policy.unknown}); the release defaults apply`;
        }
      }
      roots.push({ root: entry.root, notes, report, retirement, reclaim, why: null, note });
    } catch (error) {
      roots.push({
        root: entry.root,
        notes: null,
        report: null,
        retirement: null,
        reclaim: null,
        why: error instanceof Error ? error.message : String(error),
        note: null,
      });
    }
  }
  return { at: at.toISOString(), roots };
}
