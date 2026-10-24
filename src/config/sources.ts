// The signed settings store and the architect's storage ruling: settings sit
// beside policies in the registry's own records, signed under their own domain.
//
// - entity:  `<home>/.config/team/entities.yaml` under `<entity>.settings`
// - project: `<home>/.config/team/projects.yaml` under `projects.<projectId>.settings`
// - team:    `<home>/.config/team/teams.yaml` under `teams.<teamId>.settings` — never the team file
// - seat:    `<home>/.config/team/agents/<agentId>.yaml` under `settings`
//
// One hierarchy, inheritance by absence: the nearest level that holds a key decides it, and a
// level that holds none inherits. A record carries the value, its setter, date, the target it was
// signed for, the owner key's generation and the signature; a reader verifies every entry before
// it reads one and refuses the source whole when one does not verify.
//
// A write is one signed record per key. One write bumps the owner-key generation once, signs
// every entry with it, and hands the entries to the level's registry writer, which applies them
// to the record it reads under its own lock, so a multi-key write lands together and a
// concurrent write of another key survives. Entity settings are read only: the owner's entities
// file stays hand-written in this release.

import type { KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { entitiesPath } from '../entities.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { grantsDir } from '../grant.ts';
import { agentsDir, findAgent, getAgent, isAgentId, readAgents, updateAgent } from '../registry/agents.ts';
import { get as getProject, projectsFile, upsertProject } from '../registry/projects.ts';
import { registerDeclaredSeat } from '../registry/sync.ts';
import { getTeam, readTeams, teamIdOf, teamsFile, upsertTeam } from '../registry/teams.ts';
import { bumpGeneration, keyOf, keyState } from '../store/keys.ts';
import { DELIVERY_LEGS, type DeliveryLeg } from '../settings/inherit.ts';
import { parseYaml, toValue, YamlError, type YamlValue } from '../yaml.ts';
import {
  CONFIG_KEYS,
  CONFIG_LEVELS,
  configKeysAt,
  getConfigSpec,
  type ConfigKey,
  type ConfigLevel,
  type ConfigValue,
} from './registry.ts';
import {
  signConfigRecord,
  verifyConfigRecord,
  type ConfigRecordInput,
  type SignedConfigRecord,
} from './record.ts';

/** One level's settings as read from its record: every entry verified, or a refusal naming the
 *  file and what is wrong with it. An absent record is an empty list, never a refusal. */
export type ConfigSourceRead = {
  ok: boolean;
  level: ConfigLevel;
  target: string | null;
  source?: string;
  why?: string;
  settings: SignedConfigRecord[];
};

/** The four records a seat's settings can come from, nearest first. A level whose target is not
 *  known in this context is null. */
export type ConfigChainSources = {
  entity: ConfigSourceRead | null;
  project: ConfigSourceRead | null;
  team: ConfigSourceRead | null;
  seat: ConfigSourceRead | null;
};

export type ConfigChainInput = {
  home?: string;
  entity?: string | null;
  projectId?: string | null;
  teamId?: string | null;
  agentId?: string | null;
  /** The seat's name, when known: it names the level's target while the seat has no agent record.
   *  A signed record always verifies against the agent id, never the name. */
  seatName?: string | null;
};

/** One key resolved to the nearest level that holds a verified value. */
export type ResolvedConfigSetting = {
  key: ConfigKey;
  value: ConfigValue;
  level: ConfigLevel;
  record: SignedConfigRecord;
};

export type ConfigChainResult =
  | { ok: true; settings: ResolvedConfigSetting[] }
  | { ok: false; refusals: readonly { level: ConfigLevel; target: string | null; why: string }[] };

/** One setting a write names: the key as typed, and its value as the CLI or a caller handed it. */
export type ConfigSettingInput = { key: string; value: unknown };

export type ConfigSetRequest = {
  level: ConfigLevel;
  /** Entity name, project id, team id, or agent id: the record the write lands in. */
  target: string;
  settings: readonly ConfigSettingInput[];
  /** A seat the caller's team file declares, when the plan names that seat by name before it has
   *  a record: the plan is validated against the declaration and creates no record itself. */
  declaration?: SeatDeclaration;
};

export type ConfigUnsetRequest = {
  level: ConfigLevel;
  target: string;
  keys: readonly string[];
};

export type ConfigWriteOptions = {
  now?: Date;
  key?: KeyObject;
};

export type PlannedConfigSetting = {
  key: ConfigKey;
  value: ConfigValue;
  previous: SignedConfigRecord | null;
};

/** Why a write was refused, in the terms the command maps to an exit id: the key is not one the
 *  level holds (`key`), the value is not one the key's type admits (`value`), the level's record
 *  cannot be read or verified (`source`), or the record could not be replaced (`write`). */
export type ConfigPlanRefusal = { ok: false; kind: 'key' | 'value' | 'source' | 'write'; why: string };

export type ConfigSetPlan =
  | { ok: true; level: ConfigLevel; target: string; settings: PlannedConfigSetting[] }
  | ConfigPlanRefusal;

export type ConfigWriteResult =
  | { ok: true; level: ConfigLevel; target: string; generation: number; written: SignedConfigRecord[] }
  | ConfigPlanRefusal;

export type ConfigUnsetPlan =
  | { ok: true; level: ConfigLevel; target: string; removed: PlannedConfigSetting[] }
  | ConfigPlanRefusal;

/** One level's outcome in a write across levels, and the levels a refusal left untouched. */
export type ConfigAcrossResult = {
  ok: boolean;
  attempted: { level: ConfigLevel; target: string; result: ConfigWriteResult }[];
  skipped: { level: ConfigLevel; target: string }[];
};

// ---- reading one level ----------------------------------------------------------------------

function isMap(value: YamlValue | undefined): value is { [key: string]: YamlValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const KNOWN_ENTRY_KEYS = ['value', 'setter', 'date', 'target', 'generation', 'signature'] as const;

const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/** The problem a model, effort or nickname word has, if any — the one rule the read and the
 *  write share, so a record the read accepts is one the write would have written. A model name
 *  may carry spaces ("Claude Opus"); an effort or nickname is one word. No word carries a
 *  control character, looks like a credential, or makes a nickname of "lead". The wording is a
 *  predicate ("must be one word"), so each caller prefixes the key it names. */
function wordProblem(type: 'model' | 'effort' | 'nickname', word: string): string | null {
  if (type !== 'model' && /\s/.test(word)) return 'must be one word';
  if (CONTROL_CHAR.test(word)) return 'must not carry control characters';
  if (looksLikeCredential(word)) return 'looks like a credential; settings hold no secrets';
  if (type === 'nickname' && word.toLowerCase() === 'lead') return 'may not be "lead"';
  return null;
}

/** Whether a value on disk is one this release's registry can carry for `key`. */
function settingValueProblem(key: ConfigKey, value: YamlValue | undefined): string | null {
  const spec = getConfigSpec(key);
  if (spec === null) return `"${key}" is not a setting of this release`;
  switch (spec.type) {
    case 'model':
    case 'effort':
    case 'nickname': {
      if (typeof value !== 'string' || value.trim() === '') return 'must be a non-empty word';
      if (CONTROL_CHAR.test(value)) return 'must not carry control characters';
      return wordProblem(spec.type, value.trim());
    }
    case 'order': {
      if (!Array.isArray(value) || value.length === 0) return 'must be a list of delivery legs';
      const seen = new Set<string>();
      for (const leg of value) {
        if (typeof leg !== 'string' || !(DELIVERY_LEGS as readonly string[]).includes(leg)) {
          return `has an unknown delivery leg (expected: ${DELIVERY_LEGS.join(', ')})`;
        }
        if (seen.has(leg)) return `names leg "${leg}" twice`;
        seen.add(leg);
      }
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
  }
}

/** The registry order a read lists settings in. */
function settingOrder(key: string): number {
  const at = (CONFIG_KEYS as readonly string[]).indexOf(key);
  return at < 0 ? CONFIG_KEYS.length : at;
}

function verifySettingsMap(
  home: string,
  level: ConfigLevel,
  expectedTargets: readonly string[],
  sourcePath: string,
  rawSettings: YamlValue | undefined,
): ConfigSourceRead {
  const primaryTarget = expectedTargets[0] ?? null;
  if (rawSettings === undefined || rawSettings === null) {
    return { ok: true, level, target: primaryTarget, source: sourcePath, settings: [] };
  }
  if (!isMap(rawSettings)) {
    return {
      ok: false,
      level,
      target: primaryTarget,
      source: sourcePath,
      why: `${sourcePath}: "settings" must be a map of signed settings entries`,
      settings: [],
    };
  }
  const entries = Object.entries(rawSettings);
  if (entries.length === 0) return { ok: true, level, target: primaryTarget, source: sourcePath, settings: [] };

  const state = keyState(home);
  if (state.kind !== 'key') {
    return {
      ok: false,
      level,
      target: primaryTarget,
      source: sourcePath,
      why: `${sourcePath}: owner signing key is not available (${state.kind})`,
      settings: [],
    };
  }

  const out: SignedConfigRecord[] = [];
  for (const [rawName, rawEntry] of entries) {
    const spec = getConfigSpec(rawName);
    if (spec === null) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: "${rawName}" is not a setting of this release (known: ${CONFIG_KEYS.join(', ')})`,
        settings: [],
      };
    }
    if (!isMap(rawEntry)) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: setting "${rawName}" must be a signed map`,
        settings: [],
      };
    }
    const unknownKey = Object.keys(rawEntry).find((k) => !(KNOWN_ENTRY_KEYS as readonly string[]).includes(k));
    if (unknownKey) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: setting "${rawName}" has unknown field "${unknownKey}"`,
        settings: [],
      };
    }
    const problem = settingValueProblem(spec.key, rawEntry.value);
    if (problem !== null) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: setting "${rawName}" ${problem}`,
        settings: [],
      };
    }
    if (spec.levels !== undefined && !spec.levels.includes(level)) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `setting "${rawName}" may not be set at level ${level} (allowed: ${spec.levels.join(', ')})`,
        settings: [],
      };
    }
    const setter = rawEntry.setter;
    if (setter !== 'owner') {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: setting "${rawName}" setter must be "owner"`,
        settings: [],
      };
    }
    const date = rawEntry.date;
    if (typeof date !== 'string' || !Number.isFinite(Date.parse(date))) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: setting "${rawName}" has an invalid date`,
        settings: [],
      };
    }
    const target = rawEntry.target;
    if (typeof target !== 'string' || !target.trim()) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: setting "${rawName}" is missing its signed target`,
        settings: [],
      };
    }
    if (expectedTargets.length > 0 && !expectedTargets.includes(target)) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: setting "${rawName}" was signed for target "${target}", not "${primaryTarget}"`,
        settings: [],
      };
    }
    const generation = rawEntry.generation;
    if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: setting "${rawName}" has an invalid generation`,
        settings: [],
      };
    }
    const signature = rawEntry.signature;
    if (typeof signature !== 'string' || !signature.trim()) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: setting "${rawName}" is missing its owner signature`,
        settings: [],
      };
    }
    const record: SignedConfigRecord = {
      key: spec.key,
      value: rawEntry.value as ConfigValue,
      level,
      target,
      setter,
      date,
      generation,
      signature,
    };
    // The record is untrusted disk: verify the whole payload, never a field read first.
    if (!verifyConfigRecord(record, state.key)) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: signature verification failed for setting "${rawName}"`,
        settings: [],
      };
    }
    out.push(record);
  }

  out.sort((a, b) => settingOrder(a.key) - settingOrder(b.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { ok: true, level, target: primaryTarget, source: sourcePath, settings: out };
}

function yamlReadProblem(path: string, error: unknown): string {
  return error instanceof YamlError
    ? `${path}: line ${error.line}: ${error.message}`
    : `${path}: ${(error as Error).message}`;
}

/**
 * Reads the entity-level settings for `entity` from `<home>/.config/team/entities.yaml`.
 * An absent file or absent entity entry declares no settings; an unreadable or invalidly signed
 * file returns `{ ok: false, level: 'entity', why }`.
 */
export function readEntityConfigSource(home: string = homedir(), entity: string | null = null): ConfigSourceRead {
  const path = entitiesPath(home);
  if (!existsSync(path)) return { ok: true, level: 'entity', target: entity, settings: [] };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, level: 'entity', target: entity, source: path, why: `${path}: ${(error as Error).message}`, settings: [] };
  }
  if (!text.trim()) return { ok: true, level: 'entity', target: entity, settings: [] };
  let root: YamlValue;
  try {
    root = toValue(parseYaml(text));
  } catch (error) {
    return { ok: false, level: 'entity', target: entity, source: path, why: yamlReadProblem(path, error), settings: [] };
  }
  if (!isMap(root)) {
    return { ok: false, level: 'entity', target: entity, source: path, why: `${path}: expected a map of entities`, settings: [] };
  }
  if (!entity) return { ok: true, level: 'entity', target: null, settings: [] };
  const container = isMap(root.entities) && root[entity] === undefined ? root.entities : root;
  const entry = container[entity];
  if (entry === undefined || entry === null) return { ok: true, level: 'entity', target: entity, settings: [] };
  if (!isMap(entry)) {
    return { ok: false, level: 'entity', target: entity, source: path, why: `${path}: entity "${entity}" must be a map`, settings: [] };
  }
  return verifySettingsMap(home, 'entity', [entity], path, entry.settings);
}

/**
 * Reads the project-level settings for `projectId` from `<home>/.config/team/projects.yaml`.
 * An absent file or absent project entry declares no settings.
 */
export function readProjectConfigSource(home: string = homedir(), projectId: string | null = null): ConfigSourceRead {
  const path = projectsFile(home);
  if (!existsSync(path)) return { ok: true, level: 'project', target: projectId, settings: [] };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, level: 'project', target: projectId, source: path, why: `${path}: ${(error as Error).message}`, settings: [] };
  }
  if (!text.trim()) return { ok: true, level: 'project', target: projectId, settings: [] };
  let root: YamlValue;
  try {
    root = toValue(parseYaml(text));
  } catch (error) {
    return { ok: false, level: 'project', target: projectId, source: path, why: yamlReadProblem(path, error), settings: [] };
  }
  if (!isMap(root)) {
    return { ok: false, level: 'project', target: projectId, source: path, why: `${path}: expected a map`, settings: [] };
  }
  if (!projectId) return { ok: true, level: 'project', target: null, settings: [] };
  const container = isMap(root.projects) ? root.projects : root;
  const entry = container[projectId];
  if (entry === undefined || entry === null) return { ok: true, level: 'project', target: projectId, settings: [] };
  if (!isMap(entry)) {
    return { ok: false, level: 'project', target: projectId, source: path, why: `${path}: project "${projectId}" must be a map`, settings: [] };
  }
  return verifySettingsMap(home, 'project', [projectId], path, entry.settings);
}

/**
 * Reads the team-level settings for `teamId` from `<home>/.config/team/teams.yaml` — the
 * registry's own team record, never the team file.
 */
export function readTeamConfigSource(home: string = homedir(), teamId: string | null = null): ConfigSourceRead {
  const path = teamsFile(home);
  if (!teamId) return { ok: true, level: 'team', target: null, settings: [] };
  let record;
  try {
    record = getTeam(home, teamId);
  } catch (error) {
    // The registry's own message already names the file; a second prefix would name it twice.
    const message = (error as Error).message;
    const why = message.startsWith(path) ? message : `${path}: ${message}`;
    return { ok: false, level: 'team', target: teamId, source: path, why, settings: [] };
  }
  if (record === null) return { ok: true, level: 'team', target: teamId, settings: [] };
  return verifySettingsMap(home, 'team', [teamId], path, record.settings);
}

/**
 * Reads the seat-level settings for `agentId` from `<home>/.config/team/agents/<agentId>.yaml`.
 * A record is signed for the agent id and nothing else: a record signed for a seat name would
 * verify in every team that has a seat of that name, so its owner is the id a seat keeps for
 * life. A roster line that is not an agent id is refused before a path is built from it.
 */
export function readSeatConfigSource(
  home: string = homedir(),
  agentId: string | null = null,
  seatName: string | null = null,
): ConfigSourceRead {
  const target = agentId ?? seatName;
  if (!agentId) return { ok: true, level: 'seat', target, settings: [] };
  if (!isAgentId(agentId)) {
    return {
      ok: false,
      level: 'seat',
      target: agentId,
      why: `the registry names "${agentId}" as a seat's agent, and that is not an agent id`,
      settings: [],
    };
  }
  const path = `${agentsDir(home)}/${agentId}.yaml`;
  if (!existsSync(path)) return { ok: true, level: 'seat', target, settings: [] };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, level: 'seat', target, source: path, why: `${path}: ${(error as Error).message}`, settings: [] };
  }
  let root: YamlValue;
  try {
    root = toValue(parseYaml(text));
  } catch (error) {
    return { ok: false, level: 'seat', target, source: path, why: yamlReadProblem(path, error), settings: [] };
  }
  if (!isMap(root)) {
    return { ok: false, level: 'seat', target, source: path, why: `${path}: expected a map`, settings: [] };
  }
  return verifySettingsMap(home, 'seat', [agentId], path, root.settings);
}

/** Reads all four settings sources for a chain context. */
export function readConfigSources(input: ConfigChainInput = {}): ConfigChainSources {
  const home = input.home ?? homedir();
  return {
    entity: input.entity ? readEntityConfigSource(home, input.entity) : null,
    project: input.projectId ? readProjectConfigSource(home, input.projectId) : null,
    team: input.teamId ? readTeamConfigSource(home, input.teamId) : null,
    seat: input.agentId || input.seatName ? readSeatConfigSource(home, input.agentId ?? null, input.seatName ?? null) : null,
  };
}

/**
 * Resolves the four records, nearest level first (`seat → team → project → entity`), inheritance
 * by absence. A source that could not be read or verified refuses the chain: an unreadable record
 * is never read as an absent one.
 */
export function resolveConfigChain(sources: ConfigChainSources): ConfigChainResult {
  const refusals: { level: ConfigLevel; target: string | null; why: string }[] = [];
  const order: ConfigLevel[] = ['seat', 'team', 'project', 'entity'];
  for (const level of order) {
    const read = sources[level];
    if (read !== null && !read.ok) refusals.push({ level, target: read.target, why: read.why ?? `${level}: the settings record could not be read` });
  }
  if (refusals.length > 0) return { ok: false, refusals };
  const found = new Map<ConfigKey, ResolvedConfigSetting>();
  for (const level of order) {
    for (const record of sources[level]?.settings ?? []) {
      if (!found.has(record.key)) found.set(record.key, { key: record.key, value: record.value, level, record });
    }
  }
  const settings = CONFIG_KEYS.filter((key) => found.has(key)).map((key) => found.get(key) as ResolvedConfigSetting);
  return { ok: true, settings };
}

/** Convenience entry point: reads the four sources fresh and resolves the chain. */
export function loadAndResolveConfigChain(input: ConfigChainInput = {}): ConfigChainResult {
  return resolveConfigChain(readConfigSources(input));
}

// ---- validating a write ---------------------------------------------------------------------

const CREDENTIAL_WORD = /(?:token|secret|password|passwd|keychain|api[-_]?key|credential)/i;
const CREDENTIAL_PREFIX = /(?:^sk-|^gh[pousr]_|^xox[abpr]-)/;

/** Whether a string a write names looks like a credential. A setting is stored as signed plain
 *  text; the spec's no-secrets rule refuses one before it is ever recorded. */
function looksLikeCredential(word: string): boolean {
  return CREDENTIAL_WORD.test(word) || CREDENTIAL_PREFIX.test(word);
}

function normalizeSetting(
  level: ConfigLevel,
  key: string,
  value: unknown,
): { ok: true; key: ConfigKey; value: ConfigValue } | { ok: false; kind: 'key' | 'value'; why: string } {
  const spec = getConfigSpec(key);
  if (spec === null) {
    const known = configKeysAt(level);
    return {
      ok: false,
      kind: 'key',
      why: known.length > 0
        ? `unknown setting "${key}" at level ${level}; known settings: ${known.join(', ')}`
        : `unknown setting "${key}" at level ${level}; no setting may be set at this level in this release`,
    };
  }
  if (!spec.levels.includes(level)) {
    return { ok: false, kind: 'key', why: `setting "${key}" may not be set at level ${level} (allowed: ${spec.levels.join(', ')})` };
  }
  switch (spec.type) {
    case 'model':
    case 'effort':
    case 'nickname': {
      if (typeof value !== 'string' || value.trim() === '') {
        return { ok: false, kind: 'value', why: `setting "${key}" needs a word` };
      }
      if (CONTROL_CHAR.test(value)) {
        return { ok: false, kind: 'value', why: `setting "${key}" must not carry control characters` };
      }
      const word = value.trim();
      const problem = wordProblem(spec.type, word);
      if (problem !== null) return { ok: false, kind: 'value', why: `setting "${key}" ${problem}` };
      return { ok: true, key: spec.key, value: word };
    }
    case 'order': {
      const legs = typeof value === 'string' ? value.split(',').map((leg) => leg.trim()).filter((leg) => leg !== '') : value;
      if (!Array.isArray(legs) || legs.length === 0) {
        return { ok: false, kind: 'value', why: `setting "${key}" needs at least one leg: ${DELIVERY_LEGS.join(', ')}` };
      }
      const seen = new Set<string>();
      for (const leg of legs) {
        if (typeof leg !== 'string' || !(DELIVERY_LEGS as readonly string[]).includes(leg)) {
          return { ok: false, kind: 'value', why: `setting "${key}" "${String(leg)}" must be one of: ${DELIVERY_LEGS.join(', ')}` };
        }
        if (seen.has(leg)) return { ok: false, kind: 'value', why: `setting "${key}" names leg "${leg}" twice` };
        seen.add(leg);
      }
      return { ok: true, key: spec.key, value: legs as DeliveryLeg[] };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, key: spec.key, value };
      if (value === 'true') return { ok: true, key: spec.key, value: true };
      if (value === 'false') return { ok: true, key: spec.key, value: false };
      return { ok: false, kind: 'value', why: `setting "${key}" must be true or false` };
    }
  }
}

/** Reads the record a write targets, at its own level, and finds the current entry for a key.
 *  A source that does not verify refuses the plan: never overwrite what cannot be read. */
function readTargetSource(home: string, level: ConfigLevel, target: string, seatName?: string | null): ConfigSourceRead {
  switch (level) {
    case 'entity': return readEntityConfigSource(home, target);
    case 'project': return readProjectConfigSource(home, target);
    case 'team': return readTeamConfigSource(home, target);
    case 'seat':
      // A seat-level write target may be a seat name no agent record exists for yet (the bootstrap
      // ruling): the name reads as no settings, and no path is built from it. The chain passes the
      // registry's agent id here, and readSeatConfigSource refuses a value that is not one.
      if (!isAgentId(target)) return { ok: true, level: 'seat', target, settings: [] };
      return readSeatConfigSource(home, target, seatName ?? null);
  }
}

/**
 * The seat names a team file declares, read leniently. A file `team check` refuses still names
 * its seats, and the bootstrap ruling plans against the declaration; a name learned here buys a
 * read-only plan, while the write still needs the agent record.
 */
function declaredSeatNames(root: string): string[] {
  try {
    const path = join(root, '.agents', 'team.yaml');
    if (!existsSync(path)) return [];
    const value = toValue(parseYaml(readFileSync(path, 'utf8')));
    if (!isMap(value) || !Array.isArray(value.seats)) return [];
    return value.seats.flatMap((seat) => (isMap(seat) && typeof seat.name === 'string' ? [seat.name] : []));
  } catch {
    return [];
  }
}

/**
 * Why a seat-level target cannot be planned, or null when it can. The target is an agent record,
 * or a seat some team's roster declares before it is launched (the bootstrap ruling: such a seat
 * plans with no previous value). A name neither the agent registry nor any roster knows is
 * refused here, before a write could reach the store and bump a generation for nothing.
 */
function seatTargetProblem(home: string, target: string, declaration?: SeatDeclaration): string | null {
  if (getAgent(home, target) !== null) return null;
  // A caller that holds the declaration answers for its own team, registered or not: planning a
  // first write must not need the record the planning is meant to precede.
  if (declaration !== undefined && declaration.seat.name === target) return null;
  // A bare name more than one team binds is refused at plan time as well as at write time: a
  // preview must not describe a target the write would then refuse to choose.
  const ambiguous = ambiguityProblem(target, seatBindings(home, target));
  if (ambiguous !== null) return ambiguous;
  try {
    for (const record of Object.values(readTeams(home))) {
      if (record.roster.some((line) => line.agent === target || line.seat === target)) return null;
      // A seat the team file declares but `team up` never launched has no registry roster line
      // yet; the declaration itself is what the bootstrap ruling plans against.
      const loaded = readTeamConfig(record.root, { home });
      const declared = loaded.ok ? loaded.team.seats.map((seat) => seat.name) : declaredSeatNames(record.root);
      if (declared.includes(target)) return null;
    }
  } catch {
    // An unreadable team registry declares no roster here; the call answers with the target it
    // could not find.
  }
  return `no registered agent "${target}" in ${agentsDir(home)}, and no team roster declares it`;
}

/** One seat a registered team's file declares: the declaration a first write is seeded from. */
export type SeatDeclaration = { root: string; team: TeamFile; seat: Seat };

/**
 * Every team that knows a seat name, by team id: its file declares the seat, its roster line names
 * a live agent for it, or an agent record still answers to it. The value is the declaration where
 * one loads, so a first write has something to seed from. Keyed by team, the answer never depends
 * on the registry's order.
 */
function seatBindings(home: string, name: string): Map<string, SeatDeclaration | null> {
  const teams = new Map<string, SeatDeclaration | null>();
  try {
    for (const [teamId, record] of Object.entries(readTeams(home))) {
      let declaration: SeatDeclaration | null = null;
      try {
        const loaded = readTeamConfig(record.root, { home });
        if (loaded.ok) {
          const seat = loaded.team.seats.find((one) => one.name === name);
          if (seat !== undefined) declaration = { root: record.root, team: loaded.team, seat };
        }
      } catch {
        // A team file this build cannot read declares nothing; a roster line or record still binds.
      }
      const line = record.roster.find((entry) => entry.seat === name && getAgent(home, entry.agent) !== null);
      if (declaration !== null || line !== undefined) teams.set(teamId, declaration);
    }
    for (const agent of readAgents(home)) {
      if (agent.lifecycle === 'retired' || agent.reach.seat !== name) continue;
      if (!teams.has(agent.reach.team)) teams.set(agent.reach.team, null);
    }
  } catch {
    // An unreadable registry binds no team here; the caller reports what it could not find.
  }
  return teams;
}

/**
 * The refusal an unscoped bare seat name earns when more than one team knows it. Keyed by team and
 * sorted, so the answer is the same in either registry order; the caller names an agent id to
 * choose one.
 */
function ambiguityProblem(target: string, teams: Map<string, SeatDeclaration | null>): string | null {
  if (teams.size <= 1) return null;
  return `the seat name "${target}" is known to ${teams.size} teams (${[...teams.keys()].sort().join(', ')}); name the seat's agent id to choose one`;
}

/** Creates the record a declared seat never had: the first write's create, not a launch. Nothing
 *  starts, attaches or types; the identity words are the declaration's own. */
function materializeSeat(home: string, declaration: SeatDeclaration): { ok: true; agentId: string } | { ok: false; why: string } {
  const created = registerDeclaredSeat({ home, root: declaration.root, team: declaration.team, by: 'team settings' }, declaration.seat);
  if ('note' in created) return { ok: false, why: created.note };
  return { ok: true, agentId: created.id };
}

/**
 * The agent id a seat-level write signs under. A launched seat has one already. A seat that is
 * declared but never launched has none: the bootstrap ruling makes the first write the moment its
 * record is created, seeded from the declaration and signed like any other record, so the write
 * never refuses for the missing record and no launch or pane operation happens as its side effect.
 *
 * The binding is the team's, not the first registry entry's: a declaration from the caller's own
 * team answers for that team only, and a bare name with no declaration resolves only when one team
 * knows it. Two teams that both know the name make the bare name ambiguous, and the call refuses
 * rather than picking one; the caller names the agent id to choose.
 */
export function seatRecordForWrite(
  home: string,
  target: string,
  declaration?: SeatDeclaration,
): { ok: true; agentId: string } | { ok: false; why: string } {
  if (getAgent(home, target) !== null) {
    // An id is the caller's binding — the roster line it resolved for its own team — and a name
    // lookup below never replaces it with another team's same-named seat.
    return { ok: true, agentId: target };
  }
  if (declaration !== undefined) {
    if (declaration.seat.name !== target) {
      return { ok: false, why: `"${target}" is not the seat "${declaration.seat.name}" the team file declares` };
    }
    const known = findAgent(home, { team: teamIdOf(declaration.root), seat: target });
    if (known !== null) return { ok: true, agentId: known.id };
    return materializeSeat(home, declaration);
  }
  const teams = seatBindings(home, target);
  if (teams.size === 0) {
    return { ok: false, why: `no registered agent "${target}" in ${agentsDir(home)}, and no team roster declares it` };
  }
  const ambiguous = ambiguityProblem(target, teams);
  if (ambiguous !== null) return { ok: false, why: ambiguous };
  const teamId = [...teams.keys()][0];
  if (teamId === undefined) {
    return { ok: false, why: `no team declares the seat "${target}"` };
  }
  const known = findAgent(home, { team: teamId, seat: target });
  if (known !== null) return { ok: true, agentId: known.id };
  const declared = teams.get(teamId) ?? null;
  if (declared === null) {
    return { ok: false, why: `team ${teamId} knows the seat "${target}" but its team file no longer declares it; run \`team up\` first` };
  }
  return materializeSeat(home, declared);
}

/**
 * Validates a write without touching any file: every key is in the registry at that level, every
 * value is one the key's type admits, and the level's current record verifies. All settings are
 * validated before any is signed, so a refused second key leaves the first one unwritten.
 */
export function planConfigSet(home: string, request: ConfigSetRequest): ConfigSetPlan {
  if (!(CONFIG_LEVELS as readonly string[]).includes(request.level)) {
    return { ok: false, kind: 'key', why: `"${request.level}" is not a settings level: expected ${CONFIG_LEVELS.join(', ')}` };
  }
  if (!request.target || !request.target.trim()) {
    return { ok: false, kind: 'key', why: `a target is required to set a setting at level ${request.level}` };
  }
  if (request.settings.length === 0) return { ok: false, kind: 'key', why: 'at least one setting is required' };
  const planned: { key: ConfigKey; value: ConfigValue }[] = [];
  const seen = new Set<string>();
  for (const setting of request.settings) {
    if (seen.has(setting.key)) return { ok: false, kind: 'key', why: `setting "${setting.key}" is named twice` };
    seen.add(setting.key);
    const normalized = normalizeSetting(request.level, setting.key, setting.value);
    if (!normalized.ok) return normalized;
    planned.push({ key: normalized.key, value: normalized.value });
  }
  if (request.level === 'seat') {
    const unknown = seatTargetProblem(home, request.target, request.declaration);
    if (unknown !== null) return { ok: false, kind: 'source', why: unknown };
  }
  const current = readTargetSource(home, request.level, request.target);
  if (!current.ok) {
    return { ok: false, kind: 'source', why: current.why ?? `${current.level}: the current settings record could not be read` };
  }
  return {
    ok: true,
    level: request.level,
    target: request.target,
    settings: planned.map((setting) => ({
      key: setting.key,
      value: setting.value,
      previous: current.settings.find((record) => record.key === setting.key) ?? null,
    })),
  };
}

/** Validates an unset: every key is in the registry at that level and is actually set there, so
 *  the row can be reported and the change recorded. All keys are checked before any is removed. */
export function planConfigUnset(home: string, request: ConfigUnsetRequest): ConfigUnsetPlan {
  if (!(CONFIG_LEVELS as readonly string[]).includes(request.level)) {
    return { ok: false, kind: 'key', why: `"${request.level}" is not a settings level: expected ${CONFIG_LEVELS.join(', ')}` };
  }
  if (!request.target || !request.target.trim()) {
    return { ok: false, kind: 'key', why: `a target is required to unset a setting at level ${request.level}` };
  }
  if (request.keys.length === 0) return { ok: false, kind: 'key', why: 'at least one setting is required' };
  const seen = new Set<string>();
  for (const key of request.keys) {
    if (seen.has(key)) return { ok: false, kind: 'key', why: `setting "${key}" is named twice` };
    seen.add(key);
    const spec = getConfigSpec(key);
    if (spec === null) return { ok: false, kind: 'key', why: `unknown setting "${key}"` };
    if (!spec.levels.includes(request.level)) {
      return { ok: false, kind: 'key', why: `setting "${key}" may not be set at level ${request.level} (allowed: ${spec.levels.join(', ')})` };
    }
  }
  const current = readTargetSource(home, request.level, request.target);
  if (!current.ok) {
    return { ok: false, kind: 'source', why: current.why ?? `${current.level}: the current settings record could not be read` };
  }
  const removed: PlannedConfigSetting[] = [];
  for (const key of request.keys) {
    const previous = current.settings.find((record) => record.key === key);
    if (!previous) {
      return { ok: false, kind: 'value', why: `setting "${key}" is not set at level ${request.level} for ${request.target}; nothing to unset` };
    }
    removed.push({ key: previous.key, value: previous.value, previous });
  }
  return { ok: true, level: request.level, target: request.target, removed };
}

// ---- writing one level ----------------------------------------------------------------------

function diskEntry(record: SignedConfigRecord): Record<string, YamlValue> {
  return {
    value: Array.isArray(record.value) ? [...record.value] : (record.value as YamlValue),
    setter: record.setter,
    date: record.date,
    target: record.target,
    generation: record.generation,
    signature: record.signature,
  };
}

/** Applies signed entries to a level's record: the registry writers hold their own lock and
 *  replace the file atomically, so a multi-key write is one temp-and-rename per record. */
function writeSettingsMap(
  home: string,
  level: ConfigLevel,
  target: string,
  updates: Record<string, Record<string, YamlValue> | null>,
): void {
  switch (level) {
    case 'entity':
      // Entity settings are read but never written in this release: a key at that level arrives
      // with the wider set, and the owner's entities file stays hand-written. A plan that reaches
      // here is a caller bug, refused like one.
      throw new Error('settings are not written at entity level in this release');
    case 'project': {
      // The delta, not a map merged from a read outside the lock: the writer applies it to the
      // record it reads under the registry lock, so a concurrent write of another key survives.
      if (getProject(home, target) === null) throw new Error(`no project ${target} in the registry`);
      upsertProject(home, target, { settingsDelta: updates, by: 'owner' });
      return;
    }
    case 'team': {
      if (!getTeam(home, target)) throw new Error(`no team ${target} in the registry`);
      upsertTeam(home, target, { settingsDelta: updates, by: 'owner' });
      return;
    }
    case 'seat': {
      if (!getAgent(home, target)) throw new Error(`no registered agent "${target}" in ${agentsDir(home)}`);
      updateAgent(home, target, { settingsDelta: updates });
      return;
    }
  }
}

/**
 * Whether the level and target a plan names can hold a write at all. It is checked before a
 * generation is bumped: a refused write must not burn the number the next real write carries.
 * The registry writers keep their own checks; this one answers what no lock is needed to know.
 */
function writeTargetProblem(home: string, level: ConfigLevel, target: string): string | null {
  if (!(CONFIG_LEVELS as readonly string[]).includes(level)) {
    return `"${level}" is not a settings level: expected ${CONFIG_LEVELS.join(', ')}`;
  }
  switch (level) {
    case 'entity':
      return 'settings are not written at entity level in this release';
    case 'project':
      return getProject(home, target) === null ? `no project ${target} in the registry` : null;
    case 'team':
      return getTeam(home, target) === null ? `no team ${target} in the registry` : null;
    case 'seat':
      return null;
  }
}

/**
 * Signs and writes a planned set. One generation is bumped and every entry of the write is signed
 * with it; the level's record is then replaced once, so all keys of the write land together or
 * none does. The returned records carry the generation and signature the event log names.
 */
export function writeConfigSet(home: string, plan: ConfigSetPlan, options: ConfigWriteOptions = {}): ConfigWriteResult {
  if (!plan.ok) return plan;
  try {
    const problem = writeTargetProblem(home, plan.level, plan.target);
    if (problem !== null) return { ok: false, kind: 'write', why: problem };
  } catch (error) {
    return { ok: false, kind: 'write', why: (error as Error).message };
  }
  // The target is resolved before the generation is bumped: a write that cannot land must move
  // nothing, or the next real write would carry the burned number. A seat name that has no record
  // yet is the bootstrap case: the first write creates it from the declaration.
  let target = plan.target;
  if (plan.level === 'seat' && getAgent(home, target) === null) {
    const resolved = seatRecordForWrite(home, target);
    if (!resolved.ok) return { ok: false, kind: 'source', why: resolved.why };
    target = resolved.agentId;
  }
  const now = options.now ?? new Date();
  const folder = grantsDir(home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const generation = bumpGeneration(folder, home, now);
  const key = options.key ?? keyOf(home);
  const date = now.toISOString();
  const written: SignedConfigRecord[] = plan.settings.map((setting) =>
    signConfigRecord(
      {
        key: setting.key,
        value: setting.value,
        level: plan.level,
        target,
        setter: 'owner',
        date,
        generation,
      } satisfies ConfigRecordInput,
      key,
    ),
  );
  const updates: Record<string, Record<string, YamlValue>> = {};
  for (const record of written) updates[record.key] = diskEntry(record);
  try {
    writeSettingsMap(home, plan.level, target, updates);
  } catch (error) {
    return { ok: false, kind: 'write', why: (error as Error).message };
  }
  return { ok: true, level: plan.level, target, generation, written };
}

/**
 * Removes a planned unset from its level's record in one write. No generation is bumped: nothing
 * signed remains, and the record's own generation was already the last one bumped.
 */
export function writeConfigUnset(home: string, request: ConfigUnsetRequest): ConfigUnsetPlan {
  const plan = planConfigUnset(home, request);
  if (!plan.ok) return plan;
  const updates: Record<string, null> = {};
  for (const setting of plan.removed) updates[setting.key] = null;
  try {
    writeSettingsMap(home, plan.level, plan.target, updates);
  } catch (error) {
    return { ok: false, kind: 'write', why: (error as Error).message };
  }
  return plan;
}

/**
 * Applies a write that names several levels. Not one transaction: the levels are applied lowest
 * first — `seat`, then `team`, `project`, `entity` — and a refusal stops the write, so the level
 * that failed and the levels not attempted are both reported as they are.
 */
export function writeConfigAcross(
  home: string,
  requests: readonly ConfigSetRequest[],
  options: ConfigWriteOptions = {},
): ConfigAcrossResult {
  const order: ConfigLevel[] = ['seat', 'team', 'project', 'entity'];
  const sorted = [...requests].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  const attempted: ConfigAcrossResult['attempted'] = [];
  const skipped: ConfigAcrossResult['skipped'] = [];
  let failed = false;
  for (const request of sorted) {
    if (failed) {
      skipped.push({ level: request.level, target: request.target });
      continue;
    }
    const result = writeConfigSet(home, planConfigSet(home, request), options);
    attempted.push({ level: request.level, target: request.target, result });
    if (!result.ok) failed = true;
  }
  return { ok: !failed, attempted, skipped };
}
