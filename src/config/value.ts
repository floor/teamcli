// The checks one seat setting passes after its bare shape is admitted: the value a model word
// names in the seat's own profile, an effort the seat's vendor carries, a nickname no other seat
// already holds, and then the policy guard every governed key goes through. `planConfigSet`
// refuses an unknown key and a malformed word before this layer runs; this layer answers with the
// value that is actually recorded — a model as its launch id — or the sentence a refusal prints.

import type { Seat } from '../file/types.ts';
import { nicknameProblem } from '../file/sections/seats.ts';
import type { PolicyChainResult } from '../policy/index.ts';
import { profileFor, resolveEffortOverride, resolveModelOverride } from '../profiles/profile.ts';
import { checkConfigValue } from './guard.ts';
import type { ConfigKey, ConfigValue } from './registry.ts';

/** The two refusals only this layer can name: the seat's own range (`settings.value`) and the
 *  policies in force over it (`settings.policy`). */
export type SeatSettingRefusal = {
  id: 'settings.value' | 'settings.policy';
  why: string;
};

export type SeatSettingCheck =
  | { ok: true; value: ConfigValue }
  | { ok: false; refusal: SeatSettingRefusal };

/** The value the policy guard admits, or its refusal in the guard's own words. */
function governed(key: ConfigKey, value: ConfigValue, chain: PolicyChainResult): SeatSettingCheck {
  const check = checkConfigValue(key, value, chain);
  if (check.ok) return { ok: true, value };
  const first = check.refusals[0];
  return {
    ok: false,
    refusal: {
      id: 'settings.policy',
      why: first?.why ?? `the value is not one policy "${key}" admits`,
    },
  };
}

/**
 * Whether `value` may be recorded for `key` on this seat, and what is recorded. The profile range
 * is the same check `team add --model` and `--effort` make, so a value the launch would refuse is
 * refused here; the nickname is checked against the live roster, because a collision would make
 * one address reach two seats. A governed key still has to pass the policy chain.
 */
export function checkSeatSetting(
  key: ConfigKey,
  value: ConfigValue,
  seat: Seat,
  seats: ReadonlyArray<{ name: string; nickname?: string; line: number }>,
  chain: PolicyChainResult,
): SeatSettingCheck {
  switch (key) {
    case 'model': {
      const profile = profileFor(seat.cli);
      if (profile === null) {
        return { ok: false, refusal: { id: 'settings.value', why: `no launch profile for \`${seat.cli}\` in this version` } };
      }
      const resolved = resolveModelOverride(profile, String(value), seat.version);
      if (resolved === null) {
        return {
          ok: false,
          refusal: { id: 'settings.value', why: `${seat.name}: unknown model ${JSON.stringify(String(value))} for ${seat.cli}` },
        };
      }
      return governed(key, resolved.id, chain);
    }
    case 'effort': {
      const resolved = resolveEffortOverride(seat.cli, seat.vendor, String(value));
      if ('error' in resolved) {
        return { ok: false, refusal: { id: 'settings.value', why: `${seat.name}: ${resolved.error}` } };
      }
      return governed(key, resolved.effort, chain);
    }
    case 'nickname': {
      const problem = nicknameProblem(seats, String(value), seat.name);
      if (problem !== null) {
        return { ok: false, refusal: { id: 'settings.value', why: `seat "${seat.name}": ${problem.message}` } };
      }
      return { ok: true, value: String(value) };
    }
    case 'delivery_order':
      return governed(key, value, chain);
    case 'human':
      return governed(key, value, chain);
  }
}
