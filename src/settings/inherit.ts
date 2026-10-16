// Settings (Layer 3): one value per seat, inherited entity → project → team → seat. A level below
// may tighten a setting freely — closing is always legal — and may loosen it only where the
// setting itself allows that level to, so a project can open what an entity left closed, while a
// team inside it keeps the power to close the door again for itself. Phase 0b ships the mechanism
// and its first setting, `seats_cross_teams`; the rest follow.

export type SettingLevel = 'entity' | 'project' | 'team' | 'seat';

/** The inheritance order, outermost first. */
export const SETTING_LEVELS: readonly SettingLevel[] = ['entity', 'project', 'team', 'seat'];

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

export type NumberResolution = { value: number; source: SettingLevel | null; refused: NumberDeclaration[] };

/** The inheritance itself, number-valued: the same order, the same loosen-only-where-listed
 *  rule, and a word equal to the value in force counting as none. */
export function resolveNumberSetting(spec: NumberSettingSpec, declared: readonly NumberDeclaration[]): NumberResolution {
  let value = spec.fallback;
  let source: SettingLevel | null = null;
  const refused: NumberDeclaration[] = [];
  for (const level of SETTING_LEVELS) {
    for (const declaration of declared) {
      if (declaration.level !== level || declaration.value === value) continue;
      const looser = spec.permissive === 'higher' ? declaration.value > value : declaration.value < value;
      if (looser && !spec.looseningLevels.includes(level)) {
        refused.push(declaration);
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
 * The two thresholds the seat-state reading runs by: how fresh a TeamCLI trace must
 * be for the seat to read as working, and how long a seat may read unknown before it counts as
 * not working — the reading `status` and `check` flag `blind`. A longer window tolerates more,
 * so the permissive side is 'higher'; the project may open either, and every level inside may
 * tighten again. Declared per seat as a partial pair, each field inherited on its own.
 */
export type StateThresholds = { trace_window_seconds: number; blind_after_seconds: number };

export const STATE_THRESHOLDS: { [K in keyof StateThresholds]: NumberSettingSpec } = {
  trace_window_seconds: {
    name: 'state_trace_window_seconds',
    fallback: 120,
    permissive: 'higher',
    looseningLevels: ['project'],
  },
  blind_after_seconds: {
    name: 'state_blind_after_seconds',
    fallback: 1800,
    permissive: 'higher',
    looseningLevels: ['project'],
  },
};

/** The values when nothing declares any — the same fallbacks the specs carry. */
export const DEFAULT_STATE_THRESHOLDS: StateThresholds = {
  trace_window_seconds: STATE_THRESHOLDS.trace_window_seconds.fallback,
  blind_after_seconds: STATE_THRESHOLDS.blind_after_seconds.fallback,
};

/** The one call the state reading makes: the chain in, both thresholds out. */
export function stateThresholds(declared: Partial<Record<SettingLevel, Partial<StateThresholds> | undefined>>): StateThresholds {
  const said = (name: keyof StateThresholds): NumberDeclaration[] => {
    const out: NumberDeclaration[] = [];
    for (const level of SETTING_LEVELS) {
      const value = declared[level]?.[name];
      if (value !== undefined) out.push({ level, value });
    }
    return out;
  };
  return {
    trace_window_seconds: resolveNumberSetting(STATE_THRESHOLDS.trace_window_seconds, said('trace_window_seconds')).value,
    blind_after_seconds: resolveNumberSetting(STATE_THRESHOLDS.blind_after_seconds, said('blind_after_seconds')).value,
  };
}
