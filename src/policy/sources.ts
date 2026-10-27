// Kernel amendment 02 §2.12 & Runtime draft 1 chapter J (commitment 27):
// One signed source per level:
// - entity:  `<home>/.config/team/entities.yaml` under `<entity>.policies`
// - project: `<home>/.config/team/projects.yaml` under `projects.<projectId>.policies`
// - team:    `<teamRoot>/.agents/team.yaml` owner `policies:` section
// - seat:    `<home>/.config/team/agents/<agentId>.yaml` under `policies`

import type { KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { entitiesPath } from '../entities.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { grantsDir } from '../grant.ts';
import { logLine } from '../log.ts';
import { agentsDir, getAgent, updateAgent } from '../registry/agents.ts';
import { get as getProject, projectsFile, upsertProject } from '../registry/projects.ts';
import { getTeam, teamIdOf } from '../registry/teams.ts';
import { readState, updateState, writeAtomic } from '../state.ts';
import { bumpGeneration, keyOf, keyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { parseYaml, toValue, YamlError, type YamlNode, type YamlValue } from '../yaml.ts';
import {
  resolvePolicyChain,
  type PolicyChainResult,
  type PolicyChainSources,
  type PolicySourceRead,
  type ResolvePolicyOptions,
} from './resolve.ts';
import {
  getPolicySpec,
  normalizePolicyName,
  POLICY_DOMAIN,
  POLICY_LEVELS,
  type Policy,
  type PolicyKind,
  type PolicyLevel,
  type PolicyValue,
} from './types.ts';
import { readTeamText, teamTextTarget, writeTeamText } from '../file/team-text.ts';

export type PolicyChainInput = {
  home?: string;
  entity?: string | null;
  projectId?: string | null;
  teamRoot?: string | null;
  team?: TeamFile | null;
  agentId?: string | null;
  seat?: Seat | null;
};

export type SignedPolicyDiskEntry = {
  value: PolicyValue;
  setter: string;
  date: string;
  expiry: string | null;
  kind: PolicyKind;
  target: string;
  generation: number;
  signature: string;
};

export type PolicySetRequest = {
  level: PolicyLevel;
  /** Target identifier: entity name, project id, team id (or root), or agent id. */
  target: string;
  /** Required when `level === 'team'`: root directory containing `.agents/team.yaml`. */
  teamRoot?: string;
  /** Optional display name when creating a new project entry in `projects.yaml`. */
  projectName?: string;
  /** Optional entity name when creating a new project entry in `projects.yaml`. */
  projectEntity?: string | null;
  name: string;
  value: unknown;
  expiry?: string | null;
  kind?: PolicyKind;
};

export type PolicyUnsetRequest = {
  level: PolicyLevel;
  target: string;
  teamRoot?: string;
  name: string;
};

export type PolicyWriteOptions = {
  now?: Date;
  key?: KeyObject;
};

export type PolicyWritePlan =
  | { ok: true; policy: Policy; previous: Policy | null }
  | { ok: false; why: string };

export type PolicyUnsetPlan =
  | { ok: true; name: string; level: PolicyLevel; target: string; previous: Policy | null }
  | { ok: false; why: string };

/** Canonical payload covered by `POLICY_DOMAIN` Ed25519 signatures. */
export function policySignaturePayload(entry: {
  name: string;
  value: PolicyValue;
  level: PolicyLevel;
  target: string;
  setter: string;
  date: string;
  expiry: string | null;
  kind: PolicyKind;
  generation: number;
}): Json {
  return {
    name: entry.name,
    value: Array.isArray(entry.value) ? [...entry.value] : (entry.value as Json),
    level: entry.level,
    target: entry.target,
    setter: entry.setter,
    date: entry.date,
    expiry: entry.expiry,
    kind: entry.kind,
    generation: entry.generation,
  };
}

function isMap(value: YamlValue | undefined): value is { [key: string]: YamlValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPolicyValueShape(raw: unknown): raw is PolicyValue {
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return true;
  if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) return true;
  return false;
}

const KNOWN_ENTRY_KEYS = ['value', 'setter', 'date', 'expiry', 'kind', 'target', 'generation', 'signature'] as const;

function verifyPoliciesMap(
  home: string,
  level: PolicyLevel,
  expectedTargets: readonly string[],
  sourcePath: string,
  rawPolicies: YamlValue | undefined,
): PolicySourceRead {
  const primaryTarget = expectedTargets[0] ?? null;
  if (rawPolicies === undefined || rawPolicies === null) {
    return { ok: true, level, target: primaryTarget, policies: [] };
  }
  if (!isMap(rawPolicies)) {
    return {
      ok: false,
      level,
      target: primaryTarget,
      source: sourcePath,
      why: `${sourcePath}: "policies" must be a map of signed policy entries`,
    };
  }
  const entries = Object.entries(rawPolicies);
  if (entries.length === 0) {
    return { ok: true, level, target: primaryTarget, policies: [] };
  }
  const state = keyState(home);
  if (state.kind !== 'key') {
    return {
      ok: false,
      level,
      target: primaryTarget,
      source: sourcePath,
      why: `${sourcePath}: owner signing key is not available (${state.kind})`,
    };
  }

  const out: Policy[] = [];
  for (const [rawName, rawEntry] of entries) {
    const canonicalName = normalizePolicyName(rawName);
    if (!isMap(rawEntry)) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: policy "${rawName}" must be a signed map`,
      };
    }
    const unknownKey = Object.keys(rawEntry).find((k) => !(KNOWN_ENTRY_KEYS as readonly string[]).includes(k));
    if (unknownKey) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: policy "${rawName}" has unknown field "${unknownKey}"`,
      };
    }
    const value = rawEntry.value;
    if (!isPolicyValueShape(value)) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: policy "${rawName}" has an unreadable value`,
      };
    }
    const setter = rawEntry.setter;
    if (setter !== 'owner') {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: policy "${rawName}" setter must be "owner"`,
      };
    }
    const date = rawEntry.date;
    if (typeof date !== 'string' || !Number.isFinite(Date.parse(date))) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: policy "${rawName}" has an invalid date`,
      };
    }
    const expiry = rawEntry.expiry ?? null;
    if (expiry !== null && (typeof expiry !== 'string' || !Number.isFinite(Date.parse(expiry)))) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: policy "${rawName}" has an invalid expiry`,
      };
    }
    const kind = rawEntry.kind;
    if (kind !== 'enforced' && kind !== 'advised') {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: policy "${rawName}" kind must be "enforced" or "advised"`,
      };
    }
    const target = rawEntry.target;
    if (typeof target !== 'string' || !target.trim()) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: policy "${rawName}" is missing its signed target`,
      };
    }
    if (expectedTargets.length > 0 && !expectedTargets.includes(target)) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: policy "${rawName}" was signed for target "${target}", not "${primaryTarget}"`,
      };
    }
    const generation = rawEntry.generation;
    if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: policy "${rawName}" has an invalid generation`,
      };
    }
    const signature = rawEntry.signature;
    if (typeof signature !== 'string' || !signature.trim()) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: policy "${rawName}" is missing its owner signature`,
      };
    }
    const payload = policySignaturePayload({
      name: canonicalName,
      value,
      level,
      target,
      setter,
      date,
      expiry,
      kind,
      generation,
    });
    const verifiedCanonical = verifyDomain(POLICY_DOMAIN, payload, signature, state.key);
    const verifiedRaw =
      verifiedCanonical ||
      (rawName !== canonicalName &&
        verifyDomain(
          POLICY_DOMAIN,
          policySignaturePayload({
            name: rawName,
            value,
            level,
            target,
            setter,
            date,
            expiry,
            kind,
            generation,
          }),
          signature,
          state.key,
        ));
    if (!verifiedRaw) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `${sourcePath}: signature verification failed for policy "${rawName}"`,
      };
    }
    const spec = getPolicySpec(canonicalName);
    if (spec && !spec.levels.includes(level)) {
      return {
        ok: false,
        level,
        target: primaryTarget,
        source: sourcePath,
        why: `policy "${canonicalName}" may not be set at level ${level} (allowed: ${spec.levels.join(', ')})`,
      };
    }
    out.push({
      name: canonicalName,
      value,
      level,
      setter,
      date,
      expiry,
      kind,
      target,
      generation,
      signature,
    });
  }

  return { ok: true, level, target: primaryTarget, policies: out };
}

/**
 * Reads the entity-level policies for `entity` from `<home>/.config/team/entities.yaml`.
 * An absent file or absent entity entry declares no policies; an unreadable or invalidly signed
 * file returns `{ ok: false, level: 'entity', why }`.
 */
export function readEntityPolicySource(home: string = homedir(), entity: string | null = null): PolicySourceRead {
  const path = entitiesPath(home);
  if (!existsSync(path)) {
    return { ok: true, level: 'entity', target: entity, policies: [] };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, level: 'entity', target: entity, source: path, why: `${path}: ${(error as Error).message}` };
  }
  if (!text.trim()) {
    return { ok: true, level: 'entity', target: entity, policies: [] };
  }
  let root: YamlValue;
  try {
    root = toValue(parseYaml(text));
  } catch (error) {
    const why = error instanceof YamlError ? `${path}: line ${error.line}: ${error.message}` : `${path}: ${(error as Error).message}`;
    return { ok: false, level: 'entity', target: entity, source: path, why };
  }
  if (!isMap(root)) {
    return { ok: false, level: 'entity', target: entity, source: path, why: `${path}: expected a map of entities` };
  }
  if (!entity) {
    return { ok: true, level: 'entity', target: null, policies: [] };
  }
  const container = isMap(root.entities) && root[entity] === undefined ? root.entities : root;
  const entry = container[entity];
  if (entry === undefined || entry === null) {
    return { ok: true, level: 'entity', target: entity, policies: [] };
  }
  if (!isMap(entry)) {
    return { ok: false, level: 'entity', target: entity, source: path, why: `${path}: entity "${entity}" must be a map` };
  }
  return verifyPoliciesMap(home, 'entity', [entity], path, entry.policies);
}

/**
 * Reads the project-level policies for `projectId` from `<home>/.config/team/projects.yaml`.
 * An absent file or absent project entry declares no policies; an unreadable or invalidly signed
 * record returns `{ ok: false, level: 'project', why }`.
 */
export function readProjectPolicySource(home: string = homedir(), projectId: string | null = null): PolicySourceRead {
  const path = projectsFile(home);
  if (!existsSync(path)) {
    return { ok: true, level: 'project', target: projectId, policies: [] };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, level: 'project', target: projectId, source: path, why: `${path}: ${(error as Error).message}` };
  }
  if (!text.trim()) {
    return { ok: true, level: 'project', target: projectId, policies: [] };
  }
  let root: YamlValue;
  try {
    root = toValue(parseYaml(text));
  } catch (error) {
    const why = error instanceof YamlError ? `${path}: line ${error.line}: ${error.message}` : `${path}: ${(error as Error).message}`;
    return { ok: false, level: 'project', target: projectId, source: path, why };
  }
  if (!isMap(root)) {
    return { ok: false, level: 'project', target: projectId, source: path, why: `${path}: expected a map` };
  }
  if (!projectId) {
    return { ok: true, level: 'project', target: null, policies: [] };
  }
  const container = isMap(root.projects) ? root.projects : root;
  const entry = container[projectId];
  if (entry === undefined || entry === null) {
    return { ok: true, level: 'project', target: projectId, policies: [] };
  }
  if (!isMap(entry)) {
    return { ok: false, level: 'project', target: projectId, source: path, why: `${path}: project "${projectId}" must be a map` };
  }
  return verifyPoliciesMap(home, 'project', [projectId], path, entry.policies);
}

/**
 * Reads the team-level owner `policies:` section from `<teamRoot>/.agents/team.yaml` (or the
 * pre-loaded `team` object), as well as any legacy unsigned `delivery_order:` declaration at the
 * team level (Kernel Amendment 02 Gap 3). An unreadable or invalidly signed section returns
 * `{ ok: false, level: 'team', why }`.
 */
export function readTeamPolicySource(
  home: string = homedir(),
  teamRoot: string | null = null,
  team: TeamFile | null = null,
): PolicySourceRead {
  const path = teamRoot ? join(teamRoot, '.agents', 'team.yaml') : '.agents/team.yaml';
  const expectedTargets: string[] = [];
  if (teamRoot) {
    expectedTargets.push(teamIdOf(teamRoot), teamRoot);
  }
  if (team?.project) {
    expectedTargets.push(team.project);
  }
  const primaryTarget = expectedTargets[0] ?? null;

  let rawPolicies: YamlValue | undefined = team?.policies;
  let rawLegacyDelivery: unknown = team?.deliveryOrder ?? undefined;

  // Without a team handed in, the team's text is read where its edits land: the registry's record
  // under `team-config.source: registry`, the file otherwise (src/file/team-text.ts).
  const onRegistry = rawPolicies === undefined && teamRoot !== null && teamTextTarget(path, { home }).kind === 'registry';
  if (rawPolicies === undefined && teamRoot && (onRegistry || existsSync(path))) {
    let text: string;
    try {
      text = readTeamText(path, { home });
    } catch (error) {
      return { ok: false, level: 'team', target: primaryTarget, source: path, why: `${onRegistry ? 'the registry' : path}: ${(error as Error).message}` };
    }
    let root: YamlValue;
    try {
      root = toValue(parseYaml(text));
    } catch (error) {
      const why = error instanceof YamlError ? `${path}: line ${error.line}: ${error.message}` : `${path}: ${(error as Error).message}`;
      return { ok: false, level: 'team', target: primaryTarget, source: path, why };
    }
    if (!isMap(root)) {
      return { ok: false, level: 'team', target: primaryTarget, source: path, why: `${path}: expected a map` };
    }
    rawPolicies = root.policies;
    if (rawLegacyDelivery === undefined && root.delivery_order !== undefined) {
      rawLegacyDelivery = root.delivery_order;
    }
  }

  const verified = verifyPoliciesMap(home, 'team', expectedTargets, path, rawPolicies);
  if (!verified.ok) return verified;

  const policies = [...verified.policies];
  if (!policies.some((p) => p.name === 'delivery-order') && rawLegacyDelivery !== undefined && rawLegacyDelivery !== null) {
    if (!isPolicyValueShape(rawLegacyDelivery)) {
      return {
        ok: false,
        level: 'team',
        target: primaryTarget,
        source: path,
        why: `${path}: delivery_order has an unreadable value`,
      };
    }
    policies.push({
      name: 'delivery-order',
      value: Array.isArray(rawLegacyDelivery) ? [...rawLegacyDelivery] : rawLegacyDelivery,
      level: 'team',
      setter: null,
      date: null,
      expiry: null,
      kind: 'enforced',
      ...(primaryTarget ? { target: primaryTarget } : {}),
    });
  }

  return { ok: true, level: 'team', target: primaryTarget, policies };
}

function readSeatLegacyDeliveryFromTeamRoot(teamRoot: string, seatName: string, home: string): unknown {
  const path = join(teamRoot, '.agents', 'team.yaml');
  try {
    const root = toValue(parseYaml(readTeamText(path, { home })));
    if (!isMap(root) || !Array.isArray(root.seats)) return undefined;
    for (const item of root.seats) {
      if (!isMap(item) || typeof item.name !== 'string') continue;
      const baseName = item.name;
      const count = typeof item.count === 'number' && Number.isInteger(item.count) && item.count > 1 ? item.count : 1;
      const matches =
        seatName === baseName ||
        (count > 1 &&
          Array.from({ length: count - 1 }, (_, idx) => `${baseName}-${idx + 2}`).includes(seatName));
      if (matches && item.delivery_order !== undefined) {
        return item.delivery_order;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Reads the seat-level policies for `agentId` / `seat` from `<home>/.config/team/agents/<id>.yaml`,
 * as well as any legacy unsigned `delivery_order` declaration on `seat` (Kernel Amendment 02 Gap 3).
 */
export function readSeatPolicySource(
  home: string = homedir(),
  agentId: string | null = null,
  seat: Seat | null = null,
): PolicySourceRead {
  const target = agentId ?? seat?.name ?? null;
  let policies: Policy[] = [];
  let agentRoot: Record<string, YamlValue> | null = null;

  if (agentId) {
    const path = join(agentsDir(home), `${agentId}.yaml`);
    if (existsSync(path)) {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch (error) {
        return { ok: false, level: 'seat', target, source: path, why: `${path}: ${(error as Error).message}` };
      }
      let root: YamlValue;
      try {
        root = toValue(parseYaml(text));
      } catch (error) {
        const why = error instanceof YamlError ? `${path}: line ${error.line}: ${error.message}` : `${path}: ${(error as Error).message}`;
        return { ok: false, level: 'seat', target, source: path, why };
      }
      if (!isMap(root)) {
        return { ok: false, level: 'seat', target, source: path, why: `${path}: expected a map` };
      }
      agentRoot = root;
      const expectedTargets = seat?.name ? [agentId, seat.name] : [agentId];
      const verified = verifyPoliciesMap(home, 'seat', expectedTargets, path, root.policies);
      if (!verified.ok) return verified;
      policies = [...verified.policies];
    }
  }

  if (!policies.some((p) => p.name === 'delivery-order')) {
    let rawLegacy: unknown =
      seat?.deliveryOrder ?? (seat as { delivery_order?: unknown } | null)?.delivery_order;
    if (rawLegacy === undefined && seat === null && agentRoot && isMap(agentRoot.reach)) {
      const teamId = typeof agentRoot.reach.team === 'string' ? agentRoot.reach.team : null;
      const seatName = typeof agentRoot.reach.seat === 'string' ? agentRoot.reach.seat : null;
      if (teamId && seatName) {
        try {
          const teamRoot = getTeam(home, teamId)?.root;
          if (teamRoot) {
            rawLegacy = readSeatLegacyDeliveryFromTeamRoot(teamRoot, seatName, home);
          }
        } catch {
          rawLegacy = undefined;
        }
      }
    }
    if (rawLegacy !== undefined && rawLegacy !== null) {
      if (!isPolicyValueShape(rawLegacy)) {
        return {
          ok: false,
          level: 'seat',
          target,
          source: 'team config',
          why: `seat "${seat?.name ?? target ?? 'seat'}": delivery_order has an unreadable value`,
        };
      }
      policies.push({
        name: 'delivery-order',
        value: Array.isArray(rawLegacy) ? [...rawLegacy] : rawLegacy,
        level: 'seat',
        setter: null,
        date: null,
        expiry: null,
        kind: 'enforced',
        ...(target ? { target } : {}),
      });
    }
  }

  return { ok: true, level: 'seat', target, policies };
}

/**
 * Reads all four policy sources (`entity`, `project`, `team`, `seat`) for a given chain context.
 */
export function readPolicyChain(input: PolicyChainInput = {}): PolicyChainSources {
  const home = input.home ?? homedir();
  return {
    entity: readEntityPolicySource(home, input.entity ?? input.team?.entity ?? null),
    project: readProjectPolicySource(home, input.projectId ?? null),
    team: readTeamPolicySource(home, input.teamRoot ?? null, input.team ?? null),
    seat: readSeatPolicySource(home, input.agentId ?? null, input.seat ?? null),
  };
}

/**
 * Convenience entry point for gates and `team policy`: reads the four sources fresh and resolves
 * the chain outermost-first (`entity → project → team → seat`).
 */
export function loadAndResolvePolicyChain(
  input: PolicyChainInput = {},
  options: ResolvePolicyOptions = {},
): PolicyChainResult {
  return resolvePolicyChain(readPolicyChain(input), options);
}

function expiredPolicyMarker(exp: Policy): string {
  return `${exp.level}:${exp.target ?? ''}:${exp.name}:${exp.date ?? ''}:${exp.expiry ?? ''}:${exp.signature ?? ''}`;
}

/**
 * Logs each expired policy reading at most once per expired entry to `<agentsDir>/team.log`,
 * recording an unsigned marker in `<agentsDir>/team.state.json` while leaving the signed policy
 * files untouched.
 */
export function logExpiredPoliciesOnce(
  agentsDir: string,
  expired: readonly Policy[],
  now: Date,
): void {
  if (expired.length === 0) return;
  let existing: Set<string>;
  try {
    existing = new Set(readState(agentsDir).expired_policies ?? []);
  } catch {
    existing = new Set();
  }
  const unseen = expired.filter((exp) => !existing.has(expiredPolicyMarker(exp)));
  if (unseen.length === 0) return;

  let toLog = unseen;
  try {
    toLog = updateState(agentsDir, (state) => {
      const seen = new Set(state.expired_policies ?? []);
      const newlyAdded: Policy[] = [];
      for (const exp of unseen) {
        const key = expiredPolicyMarker(exp);
        if (!seen.has(key)) {
          seen.add(key);
          newlyAdded.push(exp);
        }
      }
      state.expired_policies = [...seen];
      return newlyAdded;
    });
  } catch {
    // If state cannot be updated, still log the unseen readings for this call.
  }

  for (const exp of toLog) {
    logLine(
      agentsDir,
      'policy',
      exp.setter ?? 'owner',
      `${exp.name} at ${exp.level} expired at ${exp.expiry ?? 'now'}; read as unset`,
      now,
    );
  }
}

// ---- Policy writers (`planPolicySet`, `writePolicySet`, `planPolicyUnset`, `writePolicyUnset`) ----

function formatRawValue(raw: unknown): string {
  if (Array.isArray(raw)) return raw.join(', ');
  return String(raw);
}

function readExistingPolicyAtLevel(home: string, level: PolicyLevel, target: string, teamRoot: string | undefined, name: string): Policy | null {
  const source =
    level === 'entity'
      ? readEntityPolicySource(home, target)
      : level === 'project'
        ? readProjectPolicySource(home, target)
        : level === 'team'
          ? readTeamPolicySource(home, teamRoot ?? null, null)
          : readSeatPolicySource(home, target, null);
  if (!source.ok) return null;
  return source.policies.find((p) => p.name === name && p.signature !== undefined) ?? null;
}

/**
 * Validates a policy `set` request without signing or mutating files.
 */
export function planPolicySet(
  home: string,
  request: PolicySetRequest,
  options: PolicyWriteOptions = {},
): PolicyWritePlan {
  const now = options.now ?? new Date();
  if (!(POLICY_LEVELS as readonly string[]).includes(request.level)) {
    return { ok: false, why: `"${request.level}" is not a policy level: expected ${POLICY_LEVELS.join(', ')}` };
  }
  if (!request.target || !request.target.trim()) {
    return { ok: false, why: `a target is required to set a policy at level ${request.level}` };
  }
  const name = normalizePolicyName(request.name);
  if (!name) {
    return { ok: false, why: 'a policy name is required' };
  }
  const spec = getPolicySpec(name);
  let kind: PolicyKind;
  let normalizedValue: PolicyValue;

  if (spec) {
    if (!spec.levels.includes(request.level)) {
      return {
        ok: false,
        why: `policy "${name}" may not be set at level ${request.level} (allowed: ${spec.levels.join(', ')})`,
      };
    }
    if (request.kind !== undefined && request.kind !== spec.kind) {
      return {
        ok: false,
        why: `policy "${name}" has kind ${spec.kind}, not ${request.kind}`,
      };
    }
    kind = spec.kind;
    const parsed = spec.parseValue(request.value);
    if (parsed === null) {
      const customWhy = spec.valueProblem?.(request.value) ?? null;
      return {
        ok: false,
        why: customWhy
          ? `${request.level}: ${customWhy}`
          : `invalid value "${formatRawValue(request.value)}" for policy "${name}"`,
      };
    }
    normalizedValue = parsed;
  } else {
    if ((request.kind ?? 'enforced') === 'enforced') {
      return {
        ok: false,
        why: `unknown enforced policy "${name}"`,
      };
    }
    kind = 'advised';
    if (typeof request.value !== 'string' || !request.value.trim()) {
      return { ok: false, why: `advised policy "${name}" requires a non-empty value` };
    }
    normalizedValue = request.value.trim();
  }

  let expiry: string | null = null;
  if (request.expiry !== undefined && request.expiry !== null) {
    const parsedMs = Date.parse(request.expiry);
    if (typeof request.expiry !== 'string' || !Number.isFinite(parsedMs)) {
      return { ok: false, why: `"${request.expiry}" is not a readable ISO-8601 expiry timestamp` };
    }
    if (parsedMs <= now.getTime()) {
      return { ok: false, why: `expiry "${request.expiry}" must be in the future` };
    }
    expiry = request.expiry;
  }

  if (request.level === 'team' && !request.teamRoot) {
    return { ok: false, why: 'setting a team-level policy requires a team root whose record team config can read' };
  }
  if (request.level === 'seat' && getAgent(home, request.target) === null) {
    return { ok: false, why: `no registered agent "${request.target}" in ${agentsDir(home)}` };
  }

  const previous = readExistingPolicyAtLevel(home, request.level, request.target, request.teamRoot, name);
  return {
    ok: true,
    previous,
    policy: {
      name,
      value: normalizedValue,
      level: request.level,
      setter: 'owner',
      date: now.toISOString(),
      expiry,
      kind,
      target: request.target,
      generation: 0,
    },
  };
}

/**
 * Signs and writes a policy entry to its level's source file.
 */
export function writePolicySet(
  home: string,
  request: PolicySetRequest,
  options: PolicyWriteOptions = {},
): PolicyWritePlan {
  const now = options.now ?? new Date();
  const plan = planPolicySet(home, request, { ...options, now });
  if (!plan.ok) return plan;

  const folder = grantsDir(home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const generation = bumpGeneration(folder, home, now);
  const key = options.key ?? keyOf(home);
  const setter = plan.policy.setter ?? 'owner';
  const date = plan.policy.date ?? now.toISOString();
  const payload = policySignaturePayload({
    name: plan.policy.name,
    value: plan.policy.value,
    level: plan.policy.level,
    target: plan.policy.target!,
    setter,
    date,
    expiry: plan.policy.expiry ?? null,
    kind: plan.policy.kind,
    generation,
  });
  const signature = signDomain(POLICY_DOMAIN, payload, key);
  const signedPolicy: Policy = {
    ...plan.policy,
    setter,
    date,
    generation,
    signature,
  };
  const diskEntry: Record<string, YamlValue> = {
    value: Array.isArray(signedPolicy.value) ? [...signedPolicy.value] : (signedPolicy.value as YamlValue),
    setter,
    date,
    expiry: signedPolicy.expiry ?? null,
    kind: signedPolicy.kind,
    target: signedPolicy.target!,
    generation,
    signature,
  };

  try {
    if (request.level === 'entity') {
      writeEntityPolicyEntry(home, request.target, signedPolicy.name, diskEntry);
    } else if (request.level === 'project') {
      writeProjectPolicyEntry(home, request.target, signedPolicy.name, diskEntry, {
        name: request.projectName,
        entity: request.projectEntity,
        at: now.toISOString(),
      });
    } else if (request.level === 'team') {
      writeTeamPolicyEntry(request.teamRoot!, signedPolicy.name, diskEntry, home);
    } else {
      writeSeatPolicyEntry(home, request.target, signedPolicy.name, diskEntry);
    }
  } catch (error) {
    return { ok: false, why: (error as Error).message };
  }

  return { ok: true, policy: signedPolicy, previous: plan.previous };
}

/**
 * Validates a policy `unset` request without mutating files.
 */
export function planPolicyUnset(
  home: string,
  request: PolicyUnsetRequest,
): PolicyUnsetPlan {
  if (!(POLICY_LEVELS as readonly string[]).includes(request.level)) {
    return { ok: false, why: `"${request.level}" is not a policy level: expected ${POLICY_LEVELS.join(', ')}` };
  }
  if (!request.target || !request.target.trim()) {
    return { ok: false, why: `a target is required to unset a policy at level ${request.level}` };
  }
  const name = normalizePolicyName(request.name);
  if (!name) {
    return { ok: false, why: 'a policy name is required' };
  }
  if (request.level === 'team' && !request.teamRoot) {
    return { ok: false, why: 'unsetting a team-level policy requires a team root whose record team config can read' };
  }
  const previous = readExistingPolicyAtLevel(home, request.level, request.target, request.teamRoot, name);
  return {
    ok: true,
    name,
    level: request.level,
    target: request.target,
    previous,
  };
}

/**
 * Removes a policy entry from its level's source file.
 */
export function writePolicyUnset(
  home: string,
  request: PolicyUnsetRequest,
): PolicyUnsetPlan {
  const plan = planPolicyUnset(home, request);
  if (!plan.ok) return plan;

  try {
    if (request.level === 'entity') {
      writeEntityPolicyEntry(home, request.target, plan.name, null);
    } else if (request.level === 'project') {
      writeProjectPolicyEntry(home, request.target, plan.name, null, {});
    } else if (request.level === 'team') {
      writeTeamPolicyEntry(request.teamRoot!, plan.name, null, home);
    } else {
      writeSeatPolicyEntry(home, request.target, plan.name, null);
    }
  } catch (error) {
    return { ok: false, why: (error as Error).message };
  }

  return plan;
}

// ---- Per-level YAML writers ----------------------------------------------------------------

function scalarYaml(text: string): string {
  const bare = /^[A-Za-z_/~][A-Za-z0-9_./@~-]*$/.test(text) && !/^(~|null|true|false)$/i.test(text);
  return bare ? text : JSON.stringify(text);
}

function emitYamlVal(v: YamlValue): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((item) => emitYamlVal(item)).join(', ')}]`;
  return JSON.stringify(v);
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

function writeEntityPolicyEntry(
  home: string,
  entity: string,
  policyName: string,
  entry: Record<string, YamlValue> | null,
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
  const existingPolicies = isMap(existingEntity.policies) ? { ...(existingEntity.policies as Record<string, YamlValue>) } : {};
  if (entry === null) {
    delete existingPolicies[policyName];
    for (const key of Object.keys(existingPolicies)) {
      if (normalizePolicyName(key) === policyName) delete existingPolicies[key];
    }
  } else {
    existingPolicies[policyName] = entry;
  }
  if (Object.keys(existingPolicies).length === 0) {
    delete existingEntity.policies;
  } else {
    existingEntity.policies = existingPolicies;
  }
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
    for (const [k, v] of Object.entries(entityVal)) {
      if (k === 'roots' || k === 'liveness' || k === 'policies') continue;
      lines.push(`  ${scalarYaml(k)}: ${emitYamlVal(v ?? null)}`);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${lines.join('\n')}\n`);
}

function writeProjectPolicyEntry(
  home: string,
  projectId: string,
  policyName: string,
  entry: Record<string, YamlValue> | null,
  meta: { name?: string; entity?: string | null; at?: string },
): void {
  const current = getProject(home, projectId);
  const existingPolicies = current?.policies ? { ...current.policies } : {};
  if (entry === null) {
    delete existingPolicies[policyName];
    for (const key of Object.keys(existingPolicies)) {
      if (normalizePolicyName(key) === policyName) delete existingPolicies[key];
    }
    if (!current) return;
  } else {
    existingPolicies[policyName] = entry;
  }
  upsertProject(home, projectId, {
    ...(current ? {} : { name: meta.name ?? projectId, entity: meta.entity ?? null }),
    policies: existingPolicies,
    by: 'owner',
    ...(meta.at ? { at: meta.at } : {}),
  });
}

function lastNodeLine(node: YamlNode): number {
  if (node.kind === 'scalar') return node.line;
  if (node.kind === 'seq') return Math.max(node.line, ...node.items.map(lastNodeLine));
  return Math.max(node.line, ...node.entries.map((e) => Math.max(e.line, lastNodeLine(e.value))));
}

function writeTeamPolicyEntry(
  teamRoot: string,
  policyName: string,
  entry: Record<string, YamlValue> | null,
  home: string,
): void {
  const path = join(teamRoot, '.agents', 'team.yaml');
  const where = { home, command: 'policy' };
  const text = readTeamText(path, where);
  const parsed = parseYaml(text);
  if (parsed.kind !== 'map') throw new Error(`${teamTextTarget(path, where).kind === 'registry' ? "the registry's record" : path}: the team must be a map`);
  const rootVal = toValue(parsed);
  const existingPolicies =
    isMap(rootVal) && isMap(rootVal.policies) ? { ...(rootVal.policies as Record<string, YamlValue>) } : {};

  if (entry === null) {
    delete existingPolicies[policyName];
    for (const key of Object.keys(existingPolicies)) {
      if (normalizePolicyName(key) === policyName) delete existingPolicies[key];
    }
  } else {
    existingPolicies[policyName] = entry;
  }

  const body = emitPoliciesBlock('', existingPolicies);
  const topEntry = parsed.entries.find((e) => e.key === 'policies');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let nextText: string;
  if (!topEntry) {
    if (body.length === 0) return;
    nextText = text + (text.endsWith('\n') ? '' : newline) + body.join(newline) + newline;
  } else {
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const end = Math.max(topEntry.line, lastNodeLine(topEntry.value));
    const bom = topEntry.line === 1 && text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const terminated = lines[end - 1]?.endsWith('\n');
    const replacement = body.length ? body.join(newline) + (terminated ? newline : '') : '';
    const before = lines.slice(0, topEntry.line - 1).join('');
    const after = lines.slice(end).join('');
    nextText = bom + before + replacement + after;
  }
  const wrote = writeTeamText(path, nextText, where);
  if (!wrote.ok) {
    throw new Error(wrote.errors[0]?.message ?? `cannot write ${teamTextTarget(path, where).kind === 'registry' ? "the registry's record" : `the team file ${path}`}`);
  }
}

function writeSeatPolicyEntry(
  home: string,
  agentId: string,
  policyName: string,
  entry: Record<string, YamlValue> | null,
): void {
  const current = getAgent(home, agentId);
  if (!current) throw new Error(`no registered agent "${agentId}" in ${agentsDir(home)}`);
  const existingPolicies = current.policies ? { ...current.policies } : {};
  if (entry === null) {
    delete existingPolicies[policyName];
    for (const key of Object.keys(existingPolicies)) {
      if (normalizePolicyName(key) === policyName) delete existingPolicies[key];
    }
  } else {
    existingPolicies[policyName] = entry;
  }
  updateAgent(home, agentId, { policies: existingPolicies });
}
