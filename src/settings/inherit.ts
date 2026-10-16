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
