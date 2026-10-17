// The settings' resolution, read through the catalogue of Kernel amendment 02. Each setting spec
// names one enforced policy; that policy owns the setting's vocabulary (its `parseValue`), which
// word tightens and which loosens (its `isWithin`), and the release default the spec's fallback
// must match. The inheritance loop stays the settings': machine → entity → project → team → seat,
// loosening only at the levels the setting lists. An expired declaration is unset at its level
// (Atlas ruling 5): it changes nothing and is not a word set aside.
//
// This lives beside `inherit.ts` rather than in it because `policy/types.ts` imports the delivery
// legs and the liveness defaults from `inherit.ts`; a resolver importing the catalogue from there
// would close a cycle. The data stays in `inherit.ts`, the reading is here.

import { getPolicySpec, type PolicySpec, type PolicyValue } from '../policy/index.ts';
import {
  declarationsOf,
  DELIVERY_ORDER,
  LIVENESS_KEYS,
  LIVENESS_RULE,
  orderDeclarationsOf,
  sayThreshold,
  SEATS_CROSS_TEAMS,
  SETTING_LEVELS,
  STATE_THRESHOLDS,
  type Declaration,
  type DeliveryLeg,
  type LivenessThresholds,
  type NumberDeclaration,
  type NumberSettingSpec,
  type OrderDeclaration,
  type OrderSettingSpec,
  type SettingLevel,
  type SettingSpec,
  type StateThresholds,
} from './inherit.ts';

/** When a chain is read: a declaration whose expiry has passed is unset at its level. */
export type ResolveOptions = { now?: Date };

/**
 * What a seat ends up with, and what it cost: the value in force, the level whose word set it —
 * null when the fallback stands — and every declaration set aside because its level may not
 * loosen this setting.
 */
export type Resolution = {
  value: boolean;
  source: SettingLevel | null;
  refused: Declaration[];
};

/** A word the number resolver set aside, with the value it would have replaced: a report names both. */
export type RefusedNumberDeclaration = NumberDeclaration & { inherited: number };

export type NumberResolution = { value: number; source: SettingLevel | null; refused: RefusedNumberDeclaration[] };

export type OrderResolution<L extends string = string> = {
  value: readonly L[];
  source: SettingLevel | null;
  refused: OrderDeclaration<L>[];
};

/** One declaration set aside, in the words a report names it by. */
export type ThresholdRefusal = {
  setting: keyof LivenessThresholds;
  level: SettingLevel;
  value: number;
  inherited: number;
  /** The rule the word broke, with the setting, the level and both values in it. */
  text: string;
};

/** The catalogue policy a spec names. A setting naming a policy the release does not ship is a
 *  programming error, not a chain to refuse. */
function policyOf(policy: string): PolicySpec<any> {
  const spec = getPolicySpec(policy);
  if (spec === null) throw new Error(`settings: "${policy}" is not a policy of the 0.5.0 catalogue`);
  return spec;
}

/** How an expiry reads at `now`: a word with no expiry is live; one whose expiry has passed is
 *  unset at its level (ruling 5); a timestamp this build cannot read is refused, as the policy
 *  resolver refuses it. */
type Expiry = 'live' | 'expired' | 'unreadable';

function expiryState(declaration: { expiry?: string | null }, now: Date): Expiry {
  if (!declaration.expiry) return 'live';
  const at = Date.parse(declaration.expiry);
  if (Number.isNaN(at)) return 'unreadable';
  return at <= now.getTime() ? 'expired' : 'live';
}

/** Whether two declared values are the same word: equal scalars, or an order with the same legs
 *  in the same places. */
function sameValue(left: PolicyValue, right: PolicyValue): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((leg, at) => leg === right[at]);
  }
  return left === right;
}

/**
 * The inheritance itself. Levels are read outermost first, and within a level the last word wins.
 * A word that would loosen the setting is honoured only at a level the spec lists; one set aside
 * changes nothing and the inherited value stands. A word equal to the value already in force is no
 * word at all — neither loosening nor tightening — so it passes at every level.
 */
export function resolveSetting(
  spec: SettingSpec,
  declared: readonly Declaration[],
  options: ResolveOptions = {},
): Resolution {
  const policy = policyOf(spec.policy);
  const now = options.now ?? new Date();
  const start = policy.parseValue(spec.fallback) as 'on' | 'off' | null;
  if (start === null) throw new Error(`settings: "${spec.name}" carries a fallback its policy rejects`);
  let value = start;
  let source: SettingLevel | null = null;
  const refused: Declaration[] = [];
  for (const level of SETTING_LEVELS) {
    for (const declaration of declared) {
      if (declaration.level !== level) continue;
      const timing = expiryState(declaration, now);
      if (timing === 'expired') continue;
      if (timing === 'unreadable') {
        refused.push(declaration);
        continue;
      }
      const word = policy.parseValue(declaration.value) as 'on' | 'off' | null;
      if (word === null) {
        refused.push(declaration);
        continue;
      }
      if (sameValue(word, value)) continue;
      if (!policy.isWithin(word, value, declaration.expiry, null) && !spec.looseningLevels.includes(level)) {
        refused.push(declaration);
        continue;
      }
      value = word;
      source = level;
    }
  }
  return { value: value === 'on', source, refused };
}

/** The one call admission makes: the asker's chain in, the effective answer out. */
export function seatsCrossTeams(
  declared: Partial<Record<SettingLevel, boolean | undefined>>,
  options?: ResolveOptions,
): boolean {
  return resolveSetting(SEATS_CROSS_TEAMS, declarationsOf(declared), options).value;
}

/** The inheritance itself, number-valued: the same order, the same loosen-only-where-listed
 *  rule, and a word equal to the value in force counting as none. */
export function resolveNumberSetting(
  spec: NumberSettingSpec,
  declared: readonly NumberDeclaration[],
  options: ResolveOptions = {},
): NumberResolution {
  const policy = policyOf(spec.policy);
  const now = options.now ?? new Date();
  const start = policy.parseValue(spec.fallback) as number | null;
  if (start === null) throw new Error(`settings: "${spec.name}" carries a fallback its policy rejects`);
  let value = start;
  let source: SettingLevel | null = null;
  const refused: RefusedNumberDeclaration[] = [];
  for (const level of SETTING_LEVELS) {
    for (const declaration of declared) {
      if (declaration.level !== level) continue;
      const timing = expiryState(declaration, now);
      if (timing === 'expired') continue;
      if (timing === 'unreadable') {
        refused.push({ ...declaration, inherited: value });
        continue;
      }
      const word = policy.parseValue(declaration.value) as number | null;
      if (word === null) {
        refused.push({ ...declaration, inherited: value });
        continue;
      }
      if (word === value) continue;
      if (!policy.isWithin(word, value, declaration.expiry, null) && !spec.looseningLevels.includes(level)) {
        refused.push({ ...declaration, inherited: value });
        continue;
      }
      value = word;
      source = level;
    }
  }
  return { value, source, refused };
}

/** The words one chain holds, one level at a time, for one threshold. */
function thresholdDeclarations<K extends keyof StateThresholds>(
  declared: Partial<Record<SettingLevel, Partial<StateThresholds> | undefined>>,
  name: K,
): NumberDeclaration[] {
  const out: NumberDeclaration[] = [];
  for (const level of SETTING_LEVELS) {
    const value = declared[level]?.[name];
    if (value !== undefined) out.push({ level, value });
  }
  return out;
}

/**
 * The one call the state reading makes — and the one the watch makes: the chain in, every
 * threshold out, each resolved on its own through the inheritance rule. A word that would
 * loosen a threshold no level allows is set aside here, the value in force standing; `status`,
 * `check` and the watch name those words through `thresholdRefusals`.
 */
export function stateThresholds(
  declared: Partial<Record<SettingLevel, Partial<StateThresholds> | undefined>>,
  options?: ResolveOptions,
): StateThresholds {
  return {
    idle_lead_seconds: resolveNumberSetting(STATE_THRESHOLDS.idle_lead_seconds, thresholdDeclarations(declared, 'idle_lead_seconds'), options).value,
    idle_owner_seconds: resolveNumberSetting(STATE_THRESHOLDS.idle_owner_seconds, thresholdDeclarations(declared, 'idle_owner_seconds'), options).value,
    blind_after_seconds: resolveNumberSetting(STATE_THRESHOLDS.blind_after_seconds, thresholdDeclarations(declared, 'blind_after_seconds'), options).value,
    trace_window_seconds: resolveNumberSetting(STATE_THRESHOLDS.trace_window_seconds, thresholdDeclarations(declared, 'trace_window_seconds'), options).value,
    hook_working_seconds: resolveNumberSetting(STATE_THRESHOLDS.hook_working_seconds, thresholdDeclarations(declared, 'hook_working_seconds'), options).value,
  };
}

/**
 * Every liveness word the chain set aside, each with the rule it broke. The values themselves
 * come from the same `stateThresholds` call the reading makes, so a report never disagrees with
 * the number in force: a looser word changes nothing, and a project may only open a window the
 * setting allows that level to open.
 */
export function thresholdRefusals(
  declared: Partial<Record<SettingLevel, Partial<StateThresholds> | undefined>>,
  options?: ResolveOptions,
): ThresholdRefusal[] {
  const refused: ThresholdRefusal[] = [];
  for (const setting of LIVENESS_KEYS) {
    const spec = STATE_THRESHOLDS[setting];
    const resolution = resolveNumberSetting(spec, thresholdDeclarations(declared, setting), options);
    for (const word of resolution.refused) {
      refused.push({
        setting,
        level: word.level,
        value: word.value,
        inherited: word.inherited,
        text: `${spec.name}: the ${word.level} declared ${sayThreshold(word.value)}, longer than the ${sayThreshold(word.inherited)} in force — ${LIVENESS_RULE}`,
      });
    }
  }
  return refused;
}

/**
 * The inheritance itself, order-valued: levels are read outermost first, and within a level the
 * last word wins. A word that drops or reorders the order in force is honoured; one that names a
 * leg the order in force does not have, or names none at all, is set aside and the order stands.
 * A word equal to the order in force is no word at all — the order it keeps may be declared at
 * every level. An order has no loosening level: tightening is the only form a word may take.
 */
export function resolveOrderSetting<L extends string>(
  spec: OrderSettingSpec<L>,
  declared: readonly OrderDeclaration<L>[],
  options: ResolveOptions = {},
): OrderResolution<L> {
  const policy = policyOf(spec.policy);
  const now = options.now ?? new Date();
  const start = policy.parseValue(spec.fallback) as readonly L[] | null;
  if (start === null) throw new Error(`settings: "${spec.name}" carries a fallback its policy rejects`);
  let value = start;
  let source: SettingLevel | null = null;
  const refused: OrderDeclaration<L>[] = [];
  for (const level of SETTING_LEVELS) {
    for (const declaration of declared) {
      if (declaration.level !== level) continue;
      const timing = expiryState(declaration, now);
      if (timing === 'expired') continue;
      if (timing === 'unreadable') {
        refused.push(declaration);
        continue;
      }
      const word = policy.parseValue(declaration.value) as readonly L[] | null;
      if (word === null) {
        refused.push(declaration);
        continue;
      }
      if (sameValue(word, value)) continue;
      if (!policy.isWithin(word, value, declaration.expiry, null)) {
        refused.push(declaration);
        continue;
      }
      value = word;
      source = level;
    }
  }
  return { value, source, refused };
}

/** The one call a send makes: the receiving seat's chain in, the order its delivery walks out. */
export function deliveryOrder(
  declared: Partial<Record<SettingLevel, readonly DeliveryLeg[] | undefined>>,
  options?: ResolveOptions,
): readonly DeliveryLeg[] {
  return resolveOrderSetting(DELIVERY_ORDER, orderDeclarationsOf(declared), options).value;
}
