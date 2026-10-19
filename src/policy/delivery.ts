// The delivery timing policies in force for one recipient's chain: `delivery-timeout` (the
// attempt budget per route) and `delivery-escalation` (the main fallback delay). The values,
// their grammar and their release defaults live in `src/policy/types.ts`; this module reads a
// resolved chain and hands callers numbers. B2's fallback events consume `deliveryEscalationDelay`
// for the due instant; B1's send path consumes `deliveryTimeoutInForce` per route.
//
// Both readers fail closed. A chain that will not load, or a value that is not the shape the
// catalogue admits, comes back as `ok: false` with the reason: a fallback episode stays pending
// and is rescheduled by a later pass, and no caller quietly runs on a release default the policy
// surface did not choose.
import type { Seat, TeamFile } from '../file/types.ts';
import { EVENT_THRESHOLDS } from './events.ts';
import { resolvePolicyChain, type PolicyLoadRefusal, type ResolvePolicyOptions } from './resolve.ts';
import { readPolicyChain, type PolicyChainInput } from './sources.ts';
import { DELIVERY_ESCALATION_SECONDS, deliveryTimeoutOf, type DeliveryTimeoutRoute, type PolicyLevel } from './types.ts';

/**
 * The reviewed post-submit read-receipt window (Atlas timing decision, 2026-10-20). It is the
 * caller's explicit `--wait` window, never a transport attempt's synchronous wait: an ordinary
 * send does not hold a route open for a reply.
 */
export const DELIVERY_RECEIPT_SECONDS = 120;

/** The reviewed readiness probe before a route attempt, in milliseconds. */
export const DELIVERY_PREPROBE_MS = 400;

/** A receipt wait is never shorter than the attempt it follows. */
export function receiptSecondsFor(attemptSeconds: number, requestedSeconds: number = DELIVERY_RECEIPT_SECONDS): number {
  return Math.max(attemptSeconds, requestedSeconds);
}

/** Where a reader's chain is read: the recipient's team, seat and the machine's home. */
export type DeliveryPolicyInput = {
  home: string;
  entity: string;
  projectId: string;
  /** The receiving team's root. */
  root: string;
  /** The receiving team's validated file. */
  team: TeamFile;
  /** The receiving seat, so a seat-level word in its own chain is read. */
  seat?: string;
  now?: Date;
};

export type DeliveryTimeoutInForce =
  | { ok: true; budgets: Record<DeliveryTimeoutRoute, number>; level: PolicyLevel | 'default' }
  | { ok: false; why: string };

export type DeliveryEscalationSource = 'delivery-escalation' | 'event-unreachable-threshold-seconds' | 'release-default';

export type DeliveryEscalationDelay =
  | { ok: true; seconds: number; source: DeliveryEscalationSource }
  | { ok: false; why: string };

function chainInputOf(input: DeliveryPolicyInput): PolicyChainInput {
  const seat: Seat | undefined =
    input.seat === undefined ? undefined : input.team.seats.find((one) => one.name === input.seat);
  return {
    home: input.home,
    entity: input.entity,
    projectId: input.projectId,
    teamRoot: input.root,
    team: input.team,
    agentId: seat?.name ?? null,
    seat: seat ?? null,
  };
}

function optionsOf(input: DeliveryPolicyInput): ResolvePolicyOptions {
  return input.now ? { now: input.now } : {};
}

function refusalsWhy(refusals: readonly PolicyLoadRefusal[]): string {
  const messages = refusals.map((refusal) => refusal.message);
  return messages.length > 0 ? messages.join('; ') : 'the policy chain did not resolve';
}

/**
 * The attempt budget per route in force for one recipient. A chain that refuses returns the
 * refusals as the reason; the caller treats the attempt as undecided rather than guessed.
 */
export function deliveryTimeoutInForce(input: DeliveryPolicyInput): DeliveryTimeoutInForce {
  try {
    const chain = resolvePolicyChain(readPolicyChain(chainInputOf(input)), optionsOf(input));
    if (!chain.ok) return { ok: false, why: refusalsWhy(chain.refusals) };
    const effective = chain.policies['delivery-timeout'];
    if (effective === undefined) return { ok: false, why: 'the policy chain did not answer "delivery-timeout"' };
    const budgets = deliveryTimeoutOf(effective.value);
    if (budgets === null) return { ok: false, why: 'the resolved "delivery-timeout" value is not a route map' };
    return { ok: true, budgets, level: effective.level };
  } catch {
    return { ok: false, why: 'the delivery timeout policy could not be read' };
  }
}

/**
 * The main fallback delay in force for one recipient. `delivery-escalation` is the canonical
 * value; a legacy `event-unreachable-threshold-seconds` word, when a level declares one, caps it
 * and is named as the source. The legacy release default is not a cap: with no legacy word, the
 * canonical 300 seconds stands. The all-live-routes-failed event is immediate at 0 and never
 * passes through this value.
 */
export function deliveryEscalationDelay(input: DeliveryPolicyInput): DeliveryEscalationDelay {
  try {
    const chain = resolvePolicyChain(readPolicyChain(chainInputOf(input)), optionsOf(input));
    if (!chain.ok) return { ok: false, why: refusalsWhy(chain.refusals) };

    const main = chain.policies['delivery-escalation'];
    const legacy = chain.policies['event-unreachable-threshold-seconds'];
    const mainSeconds = typeof main?.value === 'number' ? main.value : DELIVERY_ESCALATION_SECONDS;
    const mainSet = main !== undefined && main.level !== 'default';
    const legacySet = legacy !== undefined && legacy.level !== 'default' && typeof legacy.value === 'number';
    const legacySeconds: number | null = legacySet ? (legacy.value as number) : null;

    if (legacySeconds !== null && legacySeconds < mainSeconds) {
      return { ok: true, seconds: legacySeconds, source: 'event-unreachable-threshold-seconds' };
    }
    if (mainSet) return { ok: true, seconds: mainSeconds, source: 'delivery-escalation' };
    if (legacySeconds !== null && legacySeconds === mainSeconds) {
      return { ok: true, seconds: mainSeconds, source: 'event-unreachable-threshold-seconds' };
    }
    return { ok: true, seconds: mainSeconds, source: 'release-default' };
  } catch {
    return { ok: false, why: 'the delivery escalation policy could not be read' };
  }
}

/** The legacy threshold's release default, named here so a test can prove it is not a cap. */
export const DELIVERY_LEGACY_ESCALATION_DEFAULT_SECONDS = EVENT_THRESHOLDS.unreachable_threshold_seconds;
