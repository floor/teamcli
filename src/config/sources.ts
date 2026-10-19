// The signed settings store of OD-20261018-08 and the architect's storage ruling: settings sit
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
// every entry with it, and replaces the level's record in one locked temp-and-rename, so a
// multi-key write is atomic per record. A write across levels is not one transaction: it is
// applied lowest level first (`seat`, then `team`, `project`, `entity`), stops at the first
// refusal, and the result names what was applied, what failed and what was not attempted.

import type { KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { entitiesPath } from '../entities.ts';
import { grantsDir } from '../grant.ts';
import { agentsDir, getAgent, updateAgent } from '../registry/agents.ts';
import { get as getProject, projectsFile, upsertProject } from '../registry/projects.ts';
import { getTeam, teamsFile, upsertTeam } from '../registry/teams.ts';
import { writeAtomic } from '../state.ts';
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
  /** The seat's name, when known: a seat-level record may be signed for the seat name as well
   *  as for the agent id, as a policy record may. */
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

export type ConfigSetPlan =
  | { ok: true; level: ConfigLevel; target: string; settings: PlannedConfigSetting[] }
  | { ok: false; why: string };

export type ConfigWriteResult =
  | { ok: true; level: ConfigLevel; target: string; generation: number; written: SignedConfigRecord[] }
  | { ok: false; why: string };

export type ConfigUnsetPlan =
  | { ok: true; level: ConfigLevel; target: string; removed: PlannedConfigSetting[] }
  | { ok: false; why: string };

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

/** Whether a value on disk is one this release's registry can carry for `key`. */
function settingValueProblem(key: ConfigKey, value: YamlValue | undefined): string | null {
  const spec = getConfigSpec(key);
  if (spec === null) return `"${key}" is not a setting of this release`;
  switch (spec.type) {
    case 'model':
    case 'effort':
    case 'nickname':
      return typeof value === 'string' && value.trim() !== '' ? null : `"${key}" must be a non-empty word`;
    case 'order':
      if (!Array.isArray(value) || value.length === 0) return `"${key}" must be a list of delivery legs`;
      for (const leg of value) {
        if (typeof leg !== 'string' || !(DELIVERY_LEGS as readonly string[]).includes(leg)) {
          return `"${key}" has an unknown delivery leg (expected: ${DELIVERY_LEGS.join(', ')})`;
        }
      }
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `"${key}" must be true or false`;
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
 * registry's own team record, never the team file (OD-20261018-08).
 */
export function readTeamConfigSource(home: string = homedir(), teamId: string | null = null): ConfigSourceRead {
  const path = teamsFile(home);
  if (!teamId) return { ok: true, level: 'team', target: null, settings: [] };
  let record;
  try {
    record = getTeam(home, teamId);
  } catch (error) {
    return { ok: false, level: 'team', target: teamId, source: path, why: `${path}: ${(error as Error).message}`, settings: [] };
  }
  if (record === null) return { ok: true, level: 'team', target: teamId, settings: [] };
  return verifySettingsMap(home, 'team', [teamId], path, record.settings);
}

/**
 * Reads the seat-level settings for `agentId` from `<home>/.config/team/agents/<agentId>.yaml`.
 * A seat-level record may be signed for the agent id or for the seat name, as a policy one may.
 */
export function readSeatConfigSource(
  home: string = homedir(),
  agentId: string | null = null,
  seatName: string | null = null,
): ConfigSourceRead {
  const target = agentId ?? seatName;
  if (!agentId) return { ok: true, level: 'seat', target, settings: [] };
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
  const expectedTargets = seatName ? [agentId, seatName] : [agentId];
  return verifySettingsMap(home, 'seat', expectedTargets, path, root.settings);
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
): { ok: true; key: ConfigKey; value: ConfigValue } | { ok: false; why: string } {
  const spec = getConfigSpec(key);
  if (spec === null) {
    const known = configKeysAt(level);
    return {
      ok: false,
      why: known.length > 0
        ? `unknown setting "${key}" at level ${level}; known settings: ${known.join(', ')}`
        : `unknown setting "${key}" at level ${level}; no setting may be set at this level in this release`,
    };
  }
  if (!spec.levels.includes(level)) {
    return { ok: false, why: `setting "${key}" may not be set at level ${level} (allowed: ${spec.levels.join(', ')})` };
  }
  switch (spec.type) {
    case 'model':
    case 'effort':
    case 'nickname': {
      if (typeof value !== 'string' || value.trim() === '') {
        return { ok: false, why: `setting "${key}" needs a word` };
      }
      const word = value.trim();
      if (/\s/.test(word)) return { ok: false, why: `setting "${key}" must be one word` };
      if (looksLikeCredential(word)) {
        return { ok: false, why: `setting "${key}" looks like a credential; settings hold no secrets` };
      }
      if (spec.type === 'nickname' && word.toLowerCase() === 'lead') {
        return { ok: false, why: 'a nickname may not be "lead"' };
      }
      return { ok: true, key: spec.key, value: word };
    }
    case 'order': {
      const legs = typeof value === 'string' ? value.split(',').map((leg) => leg.trim()).filter((leg) => leg !== '') : value;
      if (!Array.isArray(legs) || legs.length === 0) {
        return { ok: false, why: `setting "${key}" needs at least one leg: ${DELIVERY_LEGS.join(', ')}` };
      }
      const seen = new Set<string>();
      for (const leg of legs) {
        if (typeof leg !== 'string' || !(DELIVERY_LEGS as readonly string[]).includes(leg)) {
          return { ok: false, why: `setting "${key}" "${String(leg)}" must be one of: ${DELIVERY_LEGS.join(', ')}` };
        }
        if (seen.has(leg)) return { ok: false, why: `setting "${key}" names leg "${leg}" twice` };
        seen.add(leg);
      }
      return { ok: true, key: spec.key, value: legs as DeliveryLeg[] };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, key: spec.key, value };
      if (value === 'true') return { ok: true, key: spec.key, value: true };
      if (value === 'false') return { ok: true, key: spec.key, value: false };
      return { ok: false, why: `setting "${key}" must be true or false` };
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
    case 'seat': return readSeatConfigSource(home, target, seatName ?? null);
  }
}

/**
 * Validates a write without touching any file: every key is in the registry at that level, every
 * value is one the key's type admits, and the level's current record verifies. All settings are
 * validated before any is signed, so a refused second key leaves the first one unwritten.
 */
export function planConfigSet(home: string, request: ConfigSetRequest): ConfigSetPlan {
  if (!(CONFIG_LEVELS as readonly string[]).includes(request.level)) {
    return { ok: false, why: `"${request.level}" is not a settings level: expected ${CONFIG_LEVELS.join(', ')}` };
  }
  if (!request.target || !request.target.trim()) {
    return { ok: false, why: `a target is required to set a setting at level ${request.level}` };
  }
  if (request.settings.length === 0) return { ok: false, why: 'at least one setting is required' };
  const planned: { key: ConfigKey; value: ConfigValue }[] = [];
  const seen = new Set<string>();
  for (const setting of request.settings) {
    if (seen.has(setting.key)) return { ok: false, why: `setting "${setting.key}" is named twice` };
    seen.add(setting.key);
    const normalized = normalizeSetting(request.level, setting.key, setting.value);
    if (!normalized.ok) return normalized;
    planned.push({ key: normalized.key, value: normalized.value });
  }
  const current = readTargetSource(home, request.level, request.target);
  if (!current.ok) {
    return { ok: false, why: current.why ?? `${current.level}: the current settings record could not be read` };
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
    return { ok: false, why: `"${request.level}" is not a settings level: expected ${CONFIG_LEVELS.join(', ')}` };
  }
  if (!request.target || !request.target.trim()) {
    return { ok: false, why: `a target is required to unset a setting at level ${request.level}` };
  }
  if (request.keys.length === 0) return { ok: false, why: 'at least one setting is required' };
  const seen = new Set<string>();
  for (const key of request.keys) {
    if (seen.has(key)) return { ok: false, why: `setting "${key}" is named twice` };
    seen.add(key);
    const spec = getConfigSpec(key);
    if (spec === null) return { ok: false, why: `unknown setting "${key}"` };
    if (!spec.levels.includes(request.level)) {
      return { ok: false, why: `setting "${key}" may not be set at level ${request.level} (allowed: ${spec.levels.join(', ')})` };
    }
  }
  const current = readTargetSource(home, request.level, request.target);
  if (!current.ok) {
    return { ok: false, why: current.why ?? `${current.level}: the current settings record could not be read` };
  }
  const removed: PlannedConfigSetting[] = [];
  for (const key of request.keys) {
    const previous = current.settings.find((record) => record.key === key);
    if (!previous) {
      return { ok: false, why: `setting "${key}" is not set at level ${request.level} for ${request.target}; nothing to unset` };
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

function emitYamlVal(v: YamlValue): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((item) => emitYamlVal(item)).join(', ')}]`;
  return JSON.stringify(v);
}

function scalarYaml(text: string): string {
  const bare = /^[A-Za-z_/~][A-Za-z0-9_./@~-]*$/.test(text) && !/^(~|null|true|false)$/i.test(text);
  return bare ? text : JSON.stringify(text);
}

function emitSettingsBlock(indent: string, settings: Record<string, YamlValue>): string[] {
  const names = Object.keys(settings).sort();
  if (names.length === 0) return [];
  const lines = [`${indent}settings:`];
  for (const name of names) {
    const entry = settings[name];
    if (isMap(entry)) {
      lines.push(`${indent}  ${scalarYaml(name)}:`);
      for (const [k, v] of Object.entries(entry)) {
        lines.push(`${indent}    ${scalarYaml(k)}: ${emitYamlVal(v ?? null)}`);
      }
    }
  }
  return lines;
}

function emitPoliciesBlock(indent: string, policies: Record<string, YamlValue>): string[] {
  const names = Object.keys(policies).sort();
  if (names.length === 0) return [];
  const lines = [`${indent}policies:`];
  for (const name of names) {
    const entry = policies[name];
    if (isMap(entry)) {
      lines.push(`${indent}  ${scalarYaml(name)}:`);
      for (const [k, v] of Object.entries(entry)) {
        lines.push(`${indent}    ${scalarYaml(k)}: ${emitYamlVal(v ?? null)}`);
      }
    }
  }
  return lines;
}

/** The entity record, rewritten whole: every root, liveness threshold, policy and unknown field is
 *  carried as it was, and only the `settings` map changes. One atomic replacement. */
function writeEntitySettings(
  home: string,
  entity: string,
  updates: Record<string, Record<string, YamlValue> | null>,
): void {
  const path = entitiesPath(home);
  let root: Record<string, YamlValue> = {};
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    if (text.trim()) {
      const parsed = toValue(parseYaml(text));
      if (!isMap(parsed)) throw new Error(`${path}: expected a map of entities`);
      root = { ...parsed };
    }
  }
  const existingEntity = isMap(root[entity]) ? { ...(root[entity] as Record<string, YamlValue>) } : {};
  const existingSettings = isMap(existingEntity.settings) ? { ...(existingEntity.settings as Record<string, YamlValue>) } : {};
  for (const [name, entry] of Object.entries(updates)) {
    if (entry === null) delete existingSettings[name];
    else existingSettings[name] = entry;
  }
  if (Object.keys(existingSettings).length === 0) delete existingEntity.settings;
  else existingEntity.settings = existingSettings;
  root[entity] = existingEntity;

  const lines: string[] = [];
  for (const entityKey of Object.keys(root).sort()) {
    const entityVal = root[entityKey];
    if (!isMap(entityVal) || Object.keys(entityVal).length === 0) {
      lines.push(`${scalarYaml(entityKey)}: {}`);
      continue;
    }
    lines.push(`${scalarYaml(entityKey)}:`);
    if (Array.isArray(entityVal.roots)) {
      lines.push('  roots:');
      for (const r of entityVal.roots) {
        lines.push(`    - ${typeof r === 'string' ? scalarYaml(r) : emitYamlVal(r)}`);
      }
    }
    if (isMap(entityVal.liveness)) {
      const pairs = Object.entries(entityVal.liveness).map(([k, v]) => `${scalarYaml(k)}: ${emitYamlVal(v ?? null)}`);
      if (pairs.length > 0) lines.push(`  liveness: { ${pairs.join(', ')} }`);
    }
    if (isMap(entityVal.policies) && Object.keys(entityVal.policies).length > 0) {
      lines.push(...emitPoliciesBlock('  ', entityVal.policies));
    }
    if (isMap(entityVal.settings) && Object.keys(entityVal.settings).length > 0) {
      lines.push(...emitSettingsBlock('  ', entityVal.settings));
    }
    for (const [k, v] of Object.entries(entityVal)) {
      if (k === 'roots' || k === 'liveness' || k === 'policies' || k === 'settings') continue;
      lines.push(`  ${scalarYaml(k)}: ${emitYamlVal(v ?? null)}`);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${lines.join('\n')}\n`);
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
      writeEntitySettings(home, target, updates);
      return;
    case 'project': {
      const current = getProject(home, target);
      const settings = current?.settings ? { ...current.settings } : {};
      for (const [name, entry] of Object.entries(updates)) {
        if (entry === null) delete settings[name];
        else settings[name] = entry;
      }
      upsertProject(home, target, { settings, by: 'owner' });
      return;
    }
    case 'team': {
      const current = getTeam(home, target);
      if (!current) throw new Error(`no team ${target} in the registry`);
      const settings = current.settings ? { ...current.settings } : {};
      for (const [name, entry] of Object.entries(updates)) {
        if (entry === null) delete settings[name];
        else settings[name] = entry;
      }
      upsertTeam(home, target, { settings, by: 'owner' });
      return;
    }
    case 'seat': {
      const current = getAgent(home, target);
      if (!current) throw new Error(`no registered agent "${target}" in ${agentsDir(home)}`);
      const settings = current.settings ? { ...current.settings } : {};
      for (const [name, entry] of Object.entries(updates)) {
        if (entry === null) delete settings[name];
        else settings[name] = entry;
      }
      updateAgent(home, target, { settings });
      return;
    }
  }
}

/**
 * Signs and writes a planned set. One generation is bumped and every entry of the write is signed
 * with it; the level's record is then replaced once, so all keys of the write land together or
 * none does. The returned records carry the generation and signature the event log names.
 */
export function writeConfigSet(home: string, plan: ConfigSetPlan, options: ConfigWriteOptions = {}): ConfigWriteResult {
  if (!plan.ok) return plan;
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
        target: plan.target,
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
    writeSettingsMap(home, plan.level, plan.target, updates);
  } catch (error) {
    return { ok: false, why: (error as Error).message };
  }
  return { ok: true, level: plan.level, target: plan.target, generation, written };
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
    return { ok: false, why: (error as Error).message };
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
