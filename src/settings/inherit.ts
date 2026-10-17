// Settings (Layer 3): one value per seat, inherited machine → entity → project → team → seat. A
// level below may tighten a setting freely — closing is always legal — and may loosen it only
// where the setting itself allows that level to, so a project can open what an entity left
// closed, while a team inside it keeps the power to close the door again for itself. Phase 0b
// ships the mechanism and its first setting, `seats_cross_teams`; the rest follow.

export type SettingLevel = 'machine' | 'entity' | 'project' | 'team' | 'seat';

/** The inheritance order, outermost first. */
export const SETTING_LEVELS: readonly SettingLevel[] = ['machine', 'entity', 'project', 'team', 'seat'];

/** One level's word on a setting: the level that holds it, and the value it declares. */
export type Declaration = { level: SettingLevel; value: boolean };

/**
 * A boolean setting, declared once per feature: the value when no level declares one, which of the
 * two values is the permissive one, and the levels allowed to loosen — to declare the permissive
 * value where the inherited one is stricter. Tightening is allowed at every level and needs no
 * listing.
 */
export type SettingSpec = {
  /** The name the setting is written under, for reports. */
  name: string;
  /** The value when nothing declares it. */
  fallback: boolean;
  /** The permissive value: the one a level may declare anew only where it may loosen. */
  permissive: boolean;
  /** The levels allowed to loosen this setting. */
  looseningLevels: readonly SettingLevel[];
};

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

/**
 * The inheritance itself. Levels are read outermost first, and within a level the last word wins.
 * A word that would loosen the setting is honoured only at a level the spec lists; one set aside
 * changes nothing and the inherited value stands. A word equal to the value already in force is no
 * word at all — neither loosening nor tightening — so it passes at every level.
 */
export function resolveSetting(spec: SettingSpec, declared: readonly Declaration[]): Resolution {
  let value = spec.fallback;
  let source: SettingLevel | null = null;
  const refused: Declaration[] = [];
  for (const level of SETTING_LEVELS) {
    for (const declaration of declared) {
      if (declaration.level !== level || declaration.value === value) continue;
      if (declaration.value === spec.permissive && !spec.looseningLevels.includes(level)) {
        refused.push(declaration);
        continue;
      }
      value = declaration.value;
      source = level;
    }
  }
  return { value, source, refused };
}

/** The declarations a chain of per-level values holds, in inheritance order; a level the chain
 *  says nothing about is left out, and so is a level given `undefined`. */
export function declarationsOf(declared: Partial<Record<SettingLevel, boolean | undefined>>): Declaration[] {
  const out: Declaration[] = [];
  for (const level of SETTING_LEVELS) {
    const value = declared[level];
    if (value !== undefined) out.push({ level, value });
  }
  return out;
}

/**
 * Seats of different teams inside one project may reach each other when this is on: the project
 * setting, default off. The project is the level that may open it; every level inside a project
 * may close it again. Resolve it for the seat that wants to reach out — admission reads the
 * asker's own chain, so a seat that closes it closes the door on itself alone.
 */
export const SEATS_CROSS_TEAMS: SettingSpec = {
  name: 'seats_cross_teams',
  fallback: false,
  permissive: true,
  looseningLevels: ['project'],
};

/** The one call admission makes: the asker's chain in, the effective answer out. */
export function seatsCrossTeams(declared: Partial<Record<SettingLevel, boolean | undefined>>): boolean {
  return resolveSetting(SEATS_CROSS_TEAMS, declarationsOf(declared)).value;
}

/**
 * A number setting, in the boolean one's shape: the value when no level declares one, which side
 * of the inherited value is the permissive one, and the levels allowed to loosen — to declare a
 * permissive value where the inherited one is stricter. Tightening is allowed at every level and
 * needs no listing. A word equal to the value in force is no word at all.
 */
export type NumberSettingSpec = {
  /** The name the setting is written under, for reports. */
  name: string;
  /** The value when nothing declares it. */
  fallback: number;
  /** The permissive side: the side of the inherited value a level may move to only where it
   *  may loosen. */
  permissive: 'higher' | 'lower';
  /** The levels allowed to loosen this setting. */
  looseningLevels: readonly SettingLevel[];
};

/** One level's word on a number setting: the level that holds it, and the value it declares. */
export type NumberDeclaration = { level: SettingLevel; value: number };

/** A word the resolver set aside, with the value it would have replaced: a report names both. */
export type RefusedNumberDeclaration = NumberDeclaration & { inherited: number };

export type NumberResolution = { value: number; source: SettingLevel | null; refused: RefusedNumberDeclaration[] };

/** The inheritance itself, number-valued: the same order, the same loosen-only-where-listed
 *  rule, and a word equal to the value in force counting as none. */
export function resolveNumberSetting(spec: NumberSettingSpec, declared: readonly NumberDeclaration[]): NumberResolution {
  let value = spec.fallback;
  let source: SettingLevel | null = null;
  const refused: RefusedNumberDeclaration[] = [];
  for (const level of SETTING_LEVELS) {
    for (const declaration of declared) {
      if (declaration.level !== level || declaration.value === value) continue;
      const looser = spec.permissive === 'higher' ? declaration.value > value : declaration.value < value;
      if (looser && !spec.looseningLevels.includes(level)) {
        refused.push({ ...declaration, inherited: value });
        continue;
      }
      value = declaration.value;
      source = level;
    }
  }
  return { value, source, refused };
}

/** The declarations a chain of per-level numbers holds, in inheritance order; a level the chain
 *  says nothing about is left out, like one given `undefined`. */
export function numberDeclarationsOf(declared: Partial<Record<SettingLevel, number | undefined>>): NumberDeclaration[] {
  const out: NumberDeclaration[] = [];
  for (const level of SETTING_LEVELS) {
    const value = declared[level];
    if (value !== undefined) out.push({ level, value });
  }
  return out;
}

/**
 * How long a seat may read unknown before it counts as not working — the reading `status` and
 * `check` flag `blind`. It is one of the liveness defaults, so it is declared once and read by
 * both groups below; a longer window tolerates more, so the permissive side is 'higher'. The
 * project may open it — the same level `seats_cross_teams` allows — and every level inside a
 * project may close it again. No other level may lengthen it.
 */
const BLIND_AFTER_SECONDS: NumberSettingSpec = {
  name: 'state_blind_after_seconds',
  fallback: 300,
  permissive: 'higher',
  looseningLevels: ['project'],
};

/**
 * How long an idle seat waits before its lead is told. It is one of the liveness defaults and
 * never lengthens: every level may tighten it, and a longer word is set aside where the
 * thresholds resolve.
 */
const IDLE_LEAD_SECONDS: NumberSettingSpec = {
  name: 'liveness_idle_lead_seconds',
  fallback: 300,
  permissive: 'higher',
  looseningLevels: [],
};

/**
 * How long after that the seat's owner is told, once per idle period. Like the lead's window it
 * only ever tightens: an owner is escalated to no later for a longer word.
 */
const IDLE_OWNER_SECONDS: NumberSettingSpec = {
  name: 'liveness_idle_owner_seconds',
  fallback: 900,
  permissive: 'higher',
  looseningLevels: [],
};

/**
 * The thresholds a seat's state is read by, and the two idle windows the watch reports on:
 * how fresh a TeamCLI trace must be for the seat to read as working; how long a seat may read
 * unknown before it counts as not working (`status` and `check` flag it `blind`); how long the
 * CLI's own `working` word outranks the screen outright; and the two idle windows. Past the hook
 * threshold a screen that still reads — a prompt showing again after an interrupted turn —
 * answers instead; a screen it cannot read leaves the hook to answer for the day. A longer window
 * tolerates more, so the permissive side is 'higher' on all five. The project may open the trace,
 * hook and blind windows, the same level `seats_cross_teams` allows; the two idle windows only
 * ever tighten. Declared per level as a partial set, each field inherited on its own. Every
 * reader takes this set through `stateThresholds` below — there is no second view of them.
 */
export type StateThresholds = {
  idle_lead_seconds: number;
  idle_owner_seconds: number;
  blind_after_seconds: number;
  trace_window_seconds: number;
  hook_working_seconds: number;
};

export const STATE_THRESHOLDS: { [K in keyof StateThresholds]: NumberSettingSpec } = {
  idle_lead_seconds: IDLE_LEAD_SECONDS,
  idle_owner_seconds: IDLE_OWNER_SECONDS,
  blind_after_seconds: BLIND_AFTER_SECONDS,
  trace_window_seconds: {
    name: 'state_trace_window_seconds',
    fallback: 120,
    permissive: 'higher',
    looseningLevels: ['project'],
  },
  hook_working_seconds: {
    name: 'state_hook_working_seconds',
    fallback: 120,
    permissive: 'higher',
    looseningLevels: ['project'],
  },
};

/** The three liveness defaults, in the order a report names them: the idle-to-lead, idle-to-owner
 *  and blind windows. They ship at 5 minutes, 15 minutes and 5 minutes. */
export type LivenessThresholds = Pick<StateThresholds, 'idle_lead_seconds' | 'idle_owner_seconds' | 'blind_after_seconds'>;

/** The liveness keys, in the order the writers emit them. */
export const LIVENESS_KEYS = ['idle_lead_seconds', 'idle_owner_seconds', 'blind_after_seconds'] as const;

/** The values when nothing declares any — the same fallbacks the specs carry. */
export const DEFAULT_STATE_THRESHOLDS: StateThresholds = {
  idle_lead_seconds: STATE_THRESHOLDS.idle_lead_seconds.fallback,
  idle_owner_seconds: STATE_THRESHOLDS.idle_owner_seconds.fallback,
  blind_after_seconds: STATE_THRESHOLDS.blind_after_seconds.fallback,
  trace_window_seconds: STATE_THRESHOLDS.trace_window_seconds.fallback,
  hook_working_seconds: STATE_THRESHOLDS.hook_working_seconds.fallback,
};

export const DEFAULT_LIVENESS_THRESHOLDS: LivenessThresholds = livenessOf(DEFAULT_STATE_THRESHOLDS);

/** The three liveness windows in a resolved set, handed to the watch's checks. */
export function livenessOf(thresholds: StateThresholds): LivenessThresholds {
  return {
    idle_lead_seconds: thresholds.idle_lead_seconds,
    idle_owner_seconds: thresholds.idle_owner_seconds,
    blind_after_seconds: thresholds.blind_after_seconds,
  };
}

/** One declaration set aside, in the words a report names it by. */
export type ThresholdRefusal = {
  setting: keyof LivenessThresholds;
  level: SettingLevel;
  value: number;
  inherited: number;
  /** The rule the word broke, with the setting, the level and both values in it. */
  text: string;
};

/** A threshold said the way a report says it: 90s, 5m, 2h. */
export function sayThreshold(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/** The rule a refused liveness word broke, as the report says it. */
export const LIVENESS_RULE = 'a liveness threshold may be tightened, never loosened, unless the level above allows it';

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
export function stateThresholds(declared: Partial<Record<SettingLevel, Partial<StateThresholds> | undefined>>): StateThresholds {
  return {
    idle_lead_seconds: resolveNumberSetting(STATE_THRESHOLDS.idle_lead_seconds, thresholdDeclarations(declared, 'idle_lead_seconds')).value,
    idle_owner_seconds: resolveNumberSetting(STATE_THRESHOLDS.idle_owner_seconds, thresholdDeclarations(declared, 'idle_owner_seconds')).value,
    blind_after_seconds: resolveNumberSetting(STATE_THRESHOLDS.blind_after_seconds, thresholdDeclarations(declared, 'blind_after_seconds')).value,
    trace_window_seconds: resolveNumberSetting(STATE_THRESHOLDS.trace_window_seconds, thresholdDeclarations(declared, 'trace_window_seconds')).value,
    hook_working_seconds: resolveNumberSetting(STATE_THRESHOLDS.hook_working_seconds, thresholdDeclarations(declared, 'hook_working_seconds')).value,
  };
}

/**
 * Every liveness word the chain set aside, each with the rule it broke. The values themselves
 * come from the same `stateThresholds` call the reading makes, so a report never disagrees with
 * the number in force: a looser word changes nothing, and a project may only open a window the
 * setting allows that level to open.
 */
export function thresholdRefusals(declared: Partial<Record<SettingLevel, Partial<StateThresholds> | undefined>>): ThresholdRefusal[] {
  const refused: ThresholdRefusal[] = [];
  for (const setting of LIVENESS_KEYS) {
    const spec = STATE_THRESHOLDS[setting];
    const resolution = resolveNumberSetting(spec, thresholdDeclarations(declared, setting));
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
 * An order setting: a list of legs, declared once per feature with the order in force when no
 * level declares one. There is no permissive side here — a level below the one that set the order
 * may always drop a leg from it or put the legs it keeps in a different order, and may never add
 * one nor empty it: an order with no leg takes nothing at all. A word naming a leg the order in
 * force does not have — or naming one twice, or naming none — is set aside and the order in force
 * stands. A word equal to the order in force is no word at all.
 */
export type OrderSettingSpec<L extends string> = {
  /** The name the setting is written under, for reports. */
  name: string;
  /** The order when nothing declares it. */
  fallback: readonly L[];
};

/** One level's word on an order setting: the level that holds it, and the order it declares. */
export type OrderDeclaration<L extends string = string> = { level: SettingLevel; value: readonly L[] };

export type OrderResolution<L extends string = string> = {
  value: readonly L[];
  source: SettingLevel | null;
  refused: OrderDeclaration<L>[];
};

/** Whether every leg of `word` is a leg of `order`, each at most once, and there is at least one:
 *  the one form a word on an order setting may take. A word with no leg is no form at all — an
 *  order that names no leg takes no send, and the loaders that read an order from a file refuse
 *  an empty one the same way (`src/file/sections/delivery_order.ts`,
 *  `src/registry/projects.ts`). */
function dropsOrReorders<L extends string>(word: readonly L[], order: readonly L[]): boolean {
  if (word.length === 0) return false;
  const seen = new Set<L>();
  for (const leg of word) {
    if (seen.has(leg) || !order.includes(leg)) return false;
    seen.add(leg);
  }
  return true;
}

function sameOrder<L extends string>(left: readonly L[], right: readonly L[]): boolean {
  return left.length === right.length && left.every((leg, at) => leg === right[at]);
}

/**
 * The inheritance itself, order-valued: levels are read outermost first, and within a level the
 * last word wins. A word that drops or reorders the order in force is honoured; one that names a
 * leg the order in force does not have, or names none at all, is set aside and the order stands.
 * A word equal to the order in force is no word at all — the order it keeps may be declared at
 * every level.
 */
export function resolveOrderSetting<L extends string>(spec: OrderSettingSpec<L>, declared: readonly OrderDeclaration<L>[]): OrderResolution<L> {
  let value = spec.fallback;
  let source: SettingLevel | null = null;
  const refused: OrderDeclaration<L>[] = [];
  for (const level of SETTING_LEVELS) {
    for (const declaration of declared) {
      if (declaration.level !== level || sameOrder(declaration.value, value)) continue;
      if (!dropsOrReorders(declaration.value, value)) {
        refused.push(declaration);
        continue;
      }
      value = declaration.value;
      source = level;
    }
  }
  return { value, source, refused };
}

/** The declarations a chain of per-level orders holds, in inheritance order; a level the chain
 *  says nothing about is left out, and so is a level given `undefined`. */
export function orderDeclarationsOf<L extends string>(declared: Partial<Record<SettingLevel, readonly L[] | undefined>>): OrderDeclaration<L>[] {
  const out: OrderDeclaration<L>[] = [];
  for (const level of SETTING_LEVELS) {
    const value = declared[level];
    if (value !== undefined) out.push({ level, value });
  }
  return out;
}

/**
 * The legs a send may walk, in the words the delivery order is written in: `native`, the frame on
 * the receiving seat's cross-session socket; `mcp-inbox`, the seat's own MCP inbox; `typed`, the
 * 0600 drop file and one composer trigger line.
 */
export type DeliveryLeg = 'native' | 'mcp-inbox' | 'typed';

export const DELIVERY_LEGS: readonly DeliveryLeg[] = ['native', 'mcp-inbox', 'typed'];

/**
 * The order a send walks when no level of the receiving seat's chain declares one: native, then
 * mcp-inbox, then typed. mcp-inbox is not in this build: a walk that reaches it skips the leg and
 * records it unavailable. The chain is the receiving seat's own — entity, project, team, seat —
 * because the order says how that seat's messages may travel.
 */
export const DELIVERY_ORDER: OrderSettingSpec<DeliveryLeg> = {
  name: 'delivery_order',
  fallback: DELIVERY_LEGS,
};

/** The one call a send makes: the receiving seat's chain in, the order its delivery walks out. */
export function deliveryOrder(declared: Partial<Record<SettingLevel, readonly DeliveryLeg[] | undefined>>): readonly DeliveryLeg[] {
  return resolveOrderSetting(DELIVERY_ORDER, orderDeclarationsOf(declared)).value;
}
