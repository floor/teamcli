// The checks one seat setting passes after its bare shape is admitted: the value a model word
// names in the seat's own profile, an effort the seat's vendor carries, a nickname no other seat
// already holds, and then the policy guard every governed key goes through. `planConfigSet`
// refuses an unknown key and a malformed word before this layer runs; this layer answers with the
// value that is actually recorded — a model as its launch id — or the sentence a refusal prints.

import type { Seat } from '../file/types.ts';
import { nicknameProblem } from '../file/sections/seats.ts';
import type { PolicyChainResult } from '../policy/index.ts';
import {
  labOfModel,
  modelRuleAllows,
  modelRuleEntryFor,
  modelRuleProblem,
  modelRuleSentence,
  modelRuleUnknownSentence,
  parseModelRule,
} from '../policy/model-rule.ts';
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
 * The entity model rule's word on recording `model` for this seat, or null when it lets the
 * write through. The rule judges the lab the PROPOSED model runs under — never the vendor the
 * file declares today, which only speaks for the model the seat runs now — for the subject the
 * rule decides by: the seat's name, then its role, then `*`. A chain that cannot be read, or a
 * rule that does not parse, refuses: the rule in force is unknown, and a write that could break
 * it is not one this layer admits. A rule that decides this seat's lab cannot judge a model
 * whose maker this version does not know, and refuses it rather than guess.
 */
function modelRuleRefusal(model: string, seat: Seat, chain: PolicyChainResult): string | null {
  if (!chain.ok) {
    const why = chain.refusals.map((refusal) => refusal.message).join('; ');
    return `the policy chain cannot be read, so the entity model rule in force is unknown (${why})`;
  }
  const policy = chain.policies['model-rule'];
  if (policy === undefined) return 'the entity model rule did not resolve, so the rule in force is unknown';
  const raw = policy.value;
  if (typeof raw !== 'string') return 'the entity model rule in force is not a value this version reads';
  if (raw.trim() === '') return null; // the empty default is no rule at all
  const entries = parseModelRule(raw);
  if (entries === null) {
    return `the entity model rule in force does not parse (${modelRuleProblem(raw) ?? 'invalid value'})`;
  }
  if (modelRuleEntryFor(entries, { name: seat.name, role: seat.role }) === undefined) return null;
  const lab = labOfModel(model);
  if (lab === undefined) return `${seat.name}: ${modelRuleUnknownSentence(model)}`;
  if (modelRuleAllows(entries, { name: seat.name, role: seat.role, vendor: lab })) return null;
  return `${seat.name}: ${modelRuleSentence(model, lab)}`;
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
      const rule = modelRuleRefusal(resolved.model, seat, chain);
      if (rule !== null) return { ok: false, refusal: { id: 'settings.policy', why: rule } };
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
