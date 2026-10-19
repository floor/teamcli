// The event thresholds as the owner sets them: seven enforced catalogue policies read back from
// a resolved chain into the set the bus and `team reply` consume. The names and their release
// defaults live in `src/policy/events.ts` (`EVENT_THRESHOLD_POLICIES`); the range and the
// shorten-only ceiling live on each spec in `src/policy/types.ts`.
//
// A chain that will not load is a refusal here, not a fallback: these numbers decide when a lead
// hears about a held record, how long a thread stays open, and how much log retention keeps. A
// reader that guessed the release default would quietly run a team on numbers no level chose.
import type { Seat, TeamFile } from '../file/types.ts';
import { EVENT_THRESHOLDS, EVENT_THRESHOLD_POLICIES, type EventThresholdField } from './events.ts';
import type { EffectivePolicy, PolicyLoadRefusal, ResolvePolicyOptions } from './resolve.ts';
import { loadAndResolvePolicyChain } from './sources.ts';
import type { PolicyLevel } from './types.ts';

/** The seven thresholds in force, in the order `team policy view` lists them. */
export type EventThresholds = { [K in EventThresholdField]: number };

/** Where a reader's chain is read: the team in force, and whose word it is. */
export type EventThresholdsContext = {
  home?: string;
  entity?: string | null;
  projectId?: string | null;
  /** The team root whose `.agents/team.yaml` carries the team-level word. */
  root?: string | null;
  team?: TeamFile | null;
  /** The seat whose own word applies, when the reader runs as one (the reply command). */
  agentId?: string | null;
  seat?: Seat | null;
  now?: Date;
  /** The innermost level read (`'seat'` only when `agentId`/`seat` name a readable seat). */
  upToLevel?: PolicyLevel;
};

export type EventThresholdsInForce =
  | { ok: true; thresholds: EventThresholds }
  | { ok: false; refusals: PolicyLoadRefusal[] };

function thresholdValue(policies: Record<string, EffectivePolicy>, field: EventThresholdField): number {
  const value = policies[EVENT_THRESHOLD_POLICIES[field]]?.value;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  // Unreachable through `eventThresholdsInForce`: the resolver answers every catalogue name. A
  // partial map handed in by a test still reads as the release default.
  return EVENT_THRESHOLDS[field];
}

/** The threshold set a resolved chain carries, its defaults included. */
export function eventThresholdsOf(policies: Record<string, EffectivePolicy>): EventThresholds {
  return {
    thread_ttl_seconds: thresholdValue(policies, 'thread_ttl_seconds'),
    thread_cap: thresholdValue(policies, 'thread_cap'),
    retention_days: thresholdValue(policies, 'retention_days'),
    held_threshold_seconds: thresholdValue(policies, 'held_threshold_seconds'),
    unreachable_threshold_seconds: thresholdValue(policies, 'unreachable_threshold_seconds'),
    idle_threshold_seconds: thresholdValue(policies, 'idle_threshold_seconds'),
    reconcile_interval_seconds: thresholdValue(policies, 'reconcile_interval_seconds'),
  };
}

/**
 * The thresholds in force for one chain context. Any source that cannot be read, verified or
 * ordered comes back as its load-time refusals; the caller names them and stops.
 */
export function eventThresholdsInForce(context: EventThresholdsContext = {}): EventThresholdsInForce {
  const options: ResolvePolicyOptions = {
    ...(context.now ? { now: context.now } : {}),
    ...(context.upToLevel ? { upToLevel: context.upToLevel } : {}),
  };
  const chain = loadAndResolvePolicyChain(
    {
      ...(context.home ? { home: context.home } : {}),
      ...(context.entity !== undefined ? { entity: context.entity } : {}),
      ...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
      teamRoot: context.root ?? null,
      team: context.team ?? null,
      agentId: context.agentId ?? null,
      seat: context.seat ?? null,
    },
    options,
  );
  if (!chain.ok) return { ok: false, refusals: chain.refusals };
  return { ok: true, thresholds: eventThresholdsOf(chain.policies) };
}
