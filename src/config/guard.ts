// The policy guard every settings write passes before it is recorded (OD-20261018-17: settings
// are values, policies are limits, and a setting never loosens a policy). The chain is the
// receiving seat's own, resolved by `resolvePolicyChain`; the guard only reads it.
//
// Fail closed: a chain that did not resolve refuses the write — an unreadable or unverified
// source is never read as "no limit" — and a governing policy that the catalogue ships but the
// resolved chain lacks refuses too, because a missing limit this build expected is an
// inconsistency, not permission. A key whose governing policy the release does not ship is
// unconstrained today; the moment the catalogue gains the policy, the same check enforces it.

import { getPolicySpec, type PolicyChainResult, type PolicyValue } from '../policy/index.ts';
import { CONFIG_REGISTRY, type ConfigKey, type ConfigValue } from './registry.ts';

/** One reason a value is refused: the key, the governing policy (null when no policy could be
 *  named), and the sentence a report prints. */
export type ConfigRefusal = {
  key: ConfigKey;
  policy: string | null;
  why: string;
};

export type ConfigCheck = { ok: true } | { ok: false; refusals: readonly ConfigRefusal[] };

/** A policy value in words: an order as its legs, a boolean as on/off. */
function sayValue(value: PolicyValue): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
}

/**
 * Whether the value may be recorded for this key. The value is parsed by the governing policy's
 * own vocabulary — so a word the policy does not know is refused for being one — and then tested
 * against the value in force: a value that drops or reorders an order is within; one that adds a
 * leg or inverts a limit is refused, naming the policy and the level it is in force at.
 */
export function checkConfigValue(
  key: ConfigKey,
  value: ConfigValue,
  chain: PolicyChainResult,
): ConfigCheck {
  const spec = CONFIG_REGISTRY[key];
  const governing = spec.governedBy !== undefined ? getPolicySpec(spec.governedBy) : null;
  // The release does not ship the policy: nothing to check the value against yet.
  if (governing === null) return { ok: true };

  if (!chain.ok) {
    const first = chain.refusals[0];
    return {
      ok: false,
      refusals: [{
        key,
        policy: governing.name,
        why: first
          ? `the policy chain cannot be read or verified (${first.message}); the value is not admitted`
          : 'the policy chain cannot be read or verified; the value is not admitted',
      }],
    };
  }

  const effective = chain.policies[governing.name];
  if (effective === undefined) {
    return {
      ok: false,
      refusals: [{
        key,
        policy: governing.name,
        why: `the policy chain did not resolve "${governing.name}"; the value is not admitted`,
      }],
    };
  }

  const parsed = governing.parseValue(value);
  if (parsed === null) {
    const problem = governing.valueProblem?.(value) ?? null;
    const base = `the value is not one policy "${governing.name}" admits`;
    return { ok: false, refusals: [{ key, policy: governing.name, why: problem ? `${base}: ${problem}` : base }] };
  }

  if (!governing.isWithin(parsed, effective.value)) {
    return {
      ok: false,
      refusals: [{
        key,
        policy: governing.name,
        why: `the value "${sayValue(parsed)}" loosens policy "${governing.name}" in force at level ${effective.level} ("${sayValue(effective.value)}")`,
      }],
    };
  }

  return { ok: true };
}
