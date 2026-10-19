// Kernel amendment 02 §2.3, §2.6, §2.7, §2.12: the policy resolver.
//
// - Reads the chain outermost first: entity → project → team → seat.
// - Unreadable or unverified source at any level refuses at load, naming the level.
// - Expired declaration counts as UNSET at its level: the inherited value or the
//   release default applies ('off' for gate-lifting policies where absent means 'off'); it never
//   becomes a value no level chose.
// - Inheritance tightens only: the first non-expired declaration sets the active bound, and any
//   lower level that loosens what it inherits is refused AT LOAD, naming both levels.
// - Migration trigger: `devModeGoverned` is true iff a `dev-mode` value ('on' or
//   'off') is set anywhere in the chain; setting a threshold or another policy never switches
//   dev-mode migration on.

import {
  getPolicySpec,
  normalizePolicyName,
  POLICY_CATALOGUE,
  POLICY_LEVELS,
  type CataloguePolicyName,
  type Policy,
  type PolicyKind,
  type PolicyLevel,
  type PolicyValue,
} from './types.ts';

/** Result of reading one level's policy source. */
export type PolicySourceRead =
  | { ok: true; level: PolicyLevel; target: string | null; policies: Policy[] }
  | { ok: false; level: PolicyLevel; target?: string | null; source?: string; why: string };

/** All four levels' source reads for one resolution chain. */
export type PolicyChainSources = Partial<Record<PolicyLevel, PolicySourceRead>>;

/** Load-time refusal returned when a source is unreadable/unverified, a policy is invalid, or a lower level loosens a higher level. */
export type PolicyLoadRefusal =
  | {
      kind: 'unreadable-source';
      level: PolicyLevel;
      source?: string;
      why: string;
      message: string;
    }
  | {
      kind: 'invalid-policy';
      level: PolicyLevel;
      policy: string;
      why: string;
      message: string;
      unsigned?: boolean;
    }
  | {
      kind: 'loosening';
      policy: string;
      lowerLevel: PolicyLevel;
      higherLevel: PolicyLevel;
      lowerValue: PolicyValue;
      higherValue: PolicyValue;
      message: string;
      unsigned?: boolean;
    };

/** Effective resolved state of one policy across the chain. */
export type EffectivePolicy<V extends PolicyValue = PolicyValue> = {
  name: string;
  value: V;
  /** The level whose declaration is in force, or `'default'` when no non-expired level set it. */
  level: PolicyLevel | 'default';
  setter: string | null;
  date: string | null;
  expiry: string | null;
  kind: PolicyKind;
  /** Declarations that expired at or before `now` and therefore counted as unset at their level. */
  expired: Policy[];
};

export type ResolvePolicyOptions = {
  now?: Date;
  /** Maximum level to resolve up to (defaults to `'seat'`). */
  upToLevel?: PolicyLevel;
};

export type SinglePolicyResult<V extends PolicyValue = PolicyValue> =
  | { ok: true; effective: EffectivePolicy<V>; expired: Policy[] }
  | { ok: false; refusals: PolicyLoadRefusal[]; expired: Policy[] };

export type PolicyChainResult =
  | {
      ok: true;
      policies: Record<string, EffectivePolicy>;
      expired: Policy[];
      /**
       * True iff a `dev-mode` value ('on' or 'off') is set anywhere in the chain.
       * When true, `dev-mode` policy governs and `TEAMCLI_DEV_MODE` is ignored.
       */
      devModeGoverned: boolean;
    }
  | {
      ok: false;
      refusals: PolicyLoadRefusal[];
      expired: Policy[];
      devModeGoverned: boolean;
    };

function formatPolicyValue(value: PolicyValue): string {
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function isExpired(policy: Policy, now: Date): boolean {
  if (!policy.expiry) return false;
  const parsed = Date.parse(policy.expiry);
  if (!Number.isFinite(parsed)) return false;
  return parsed <= now.getTime();
}

/**
 * Resolves a single policy across declarations from outermost (`entity`) to innermost (`seat`).
 *
 * - Absent = release default (`'off'` for gate-lifting policies).
 * - Expired = unset at its level.
 * - Loosening = refused AT LOAD naming both levels (`higherLevel` and `lowerLevel`).
 */
export function resolvePolicy<V extends PolicyValue = PolicyValue>(
  rawName: string,
  declarations: readonly Policy[],
  options: ResolvePolicyOptions = {},
): SinglePolicyResult<V> {
  const now = options.now ?? new Date();
  const maxIdx = options.upToLevel ? POLICY_LEVELS.indexOf(options.upToLevel) : POLICY_LEVELS.length - 1;
  const name = normalizePolicyName(rawName);
  const spec = getPolicySpec(name);

  const refusals: PolicyLoadRefusal[] = [];
  const expired: Policy[] = [];

  if (!spec) {
    const first = declarations[0];
    const level: PolicyLevel = first?.level ?? 'team';
    // Only project-defined advised policies may exist outside the closed vocabulary (§2.1, §2.5).
    if (!first || first.kind === 'enforced') {
      refusals.push({
        kind: 'invalid-policy',
        level,
        policy: name,
        why: `unknown enforced policy "${name}"`,
        message: `${level}: unknown enforced policy "${name}"`,
      });
      return { ok: false, refusals, expired };
    }
  }

  let activeDeclaration: Policy | null = null;

  for (let i = 0; i <= maxIdx; i++) {
    const level = POLICY_LEVELS[i]!;
    const levelDecls = declarations.filter((d) => d.level === level);
    for (const decl of levelDecls) {
      const unsigned = decl.setter === null && !decl.signature;
      if (spec) {
        if (!spec.levels.includes(level)) {
          refusals.push({
            kind: 'invalid-policy',
            level,
            policy: name,
            why: `policy "${name}" may not be set at level ${level}`,
            message: `${level}: policy "${name}" may not be set at level ${level} (allowed: ${spec.levels.join(', ')})`,
            ...(unsigned ? { unsigned: true } : {}),
          });
          continue;
        }
        if (decl.kind !== spec.kind) {
          refusals.push({
            kind: 'invalid-policy',
            level,
            policy: name,
            why: `policy "${name}" is ${spec.kind}, not ${decl.kind}`,
            message: `${level}: policy "${name}" has kind ${spec.kind}, not ${decl.kind}`,
            ...(unsigned ? { unsigned: true } : {}),
          });
          continue;
        }
        const parsed = spec.parseValue(decl.value);
        if (parsed === null) {
          const customWhy = spec.valueProblem?.(decl.value) ?? null;
          const why = customWhy ?? `invalid value "${formatPolicyValue(decl.value)}" for policy "${name}"`;
          refusals.push({
            kind: 'invalid-policy',
            level,
            policy: name,
            why,
            message: `${level}: ${why}`,
            ...(unsigned ? { unsigned: true } : {}),
          });
          continue;
        }
        if (decl.expiry !== undefined && decl.expiry !== null && !Number.isFinite(Date.parse(decl.expiry))) {
          refusals.push({
            kind: 'invalid-policy',
            level,
            policy: name,
            why: `invalid expiry "${decl.expiry}" for policy "${name}"`,
            message: `${level}: invalid expiry "${decl.expiry}" for policy "${name}"`,
            ...(unsigned ? { unsigned: true } : {}),
          });
          continue;
        }
        // A sparse value inherits the fields it leaves out from the value in force above it (the
        // release default for the first declaration), so a lower level never resets an
        // unmentioned field. The merge also keeps the active bound complete for the next level.
        const inherited = spec.inherit
          ? spec.inherit(activeDeclaration?.value ?? (spec.gateLifting ? 'off' : spec.defaultValue), parsed)
          : parsed;
        const normalizedDecl: Policy = { ...decl, name, value: inherited };
        if (isExpired(normalizedDecl, now)) {
          expired.push(normalizedDecl);
          continue;
        }
        if (activeDeclaration !== null && !spec.lowerLevelChooses) {
          const within = spec.isWithin(
            normalizedDecl.value,
            activeDeclaration.value,
            normalizedDecl.expiry ?? null,
            activeDeclaration.expiry ?? null,
          );
          if (!within) {
            refusals.push({
              kind: 'loosening',
              policy: name,
              lowerLevel: level,
              higherLevel: activeDeclaration.level,
              lowerValue: normalizedDecl.value,
              higherValue: activeDeclaration.value,
              message: `policy "${name}" at level ${level} ("${formatPolicyValue(normalizedDecl.value)}") loosens level ${activeDeclaration.level} ("${formatPolicyValue(activeDeclaration.value)}")`,
              ...(unsigned ? { unsigned: true } : {}),
            });
            continue;
          }
        }
        activeDeclaration = normalizedDecl;
      } else {
        // Custom advised policy: no ordering unless equal to higher level.
        if (isExpired(decl, now)) {
          expired.push(decl);
          continue;
        }
        if (activeDeclaration !== null && decl.value !== activeDeclaration.value) {
          refusals.push({
            kind: 'loosening',
            policy: name,
            lowerLevel: level,
            higherLevel: activeDeclaration.level,
            lowerValue: decl.value,
            higherValue: activeDeclaration.value,
            message: `policy "${name}" at level ${level} ("${formatPolicyValue(decl.value)}") loosens level ${activeDeclaration.level} ("${formatPolicyValue(activeDeclaration.value)}")`,
            ...(unsigned ? { unsigned: true } : {}),
          });
          continue;
        }
        activeDeclaration = { ...decl, name };
      }
    }
  }

  if (refusals.length > 0) {
    return { ok: false, refusals, expired };
  }

  if (activeDeclaration !== null) {
    return {
      ok: true,
      effective: {
        name,
        value: activeDeclaration.value as V,
        level: activeDeclaration.level,
        setter: activeDeclaration.setter,
        date: activeDeclaration.date,
        expiry: activeDeclaration.expiry ?? null,
        kind: activeDeclaration.kind,
        expired,
      },
      expired,
    };
  }

  const defaultValue = spec ? (spec.gateLifting ? ('off' as V) : (spec.defaultValue as V)) : ('' as V);
  const kind: PolicyKind = spec ? spec.kind : 'advised';
  return {
    ok: true,
    effective: {
      name,
      value: defaultValue,
      level: 'default',
      setter: null,
      date: null,
      expiry: null,
      kind,
      expired,
    },
    expired,
  };
}

/**
 * Resolves all policies across the four-level source chain (`entity → project → team → seat`).
 * Any unreadable source or loosening at any level refuses at load.
 */
export function resolvePolicyChain(
  sources: PolicyChainSources,
  options: ResolvePolicyOptions = {},
): PolicyChainResult {
  const maxIdx = options.upToLevel ? POLICY_LEVELS.indexOf(options.upToLevel) : POLICY_LEVELS.length - 1;
  const refusals: PolicyLoadRefusal[] = [];
  const allDeclarations: Policy[] = [];

  for (let i = 0; i <= maxIdx; i++) {
    const level = POLICY_LEVELS[i]!;
    const source = sources[level];
    if (!source) continue;
    if (!source.ok) {
      refusals.push({
        kind: 'unreadable-source',
        level,
        source: source.source,
        why: source.why,
        message: `${level}: policy source cannot be read or verified (${source.why})`,
      });
      continue;
    }
    for (const policy of source.policies) {
      allDeclarations.push({ ...policy, name: normalizePolicyName(policy.name), level });
    }
  }

  const devModeGoverned = allDeclarations.some((decl) => decl.name === 'dev-mode');

  if (refusals.length > 0) {
    return { ok: false, refusals, expired: [], devModeGoverned };
  }

  const names = new Set<string>(Object.keys(POLICY_CATALOGUE) as CataloguePolicyName[]);
  for (const decl of allDeclarations) {
    names.add(decl.name);
  }

  const policies: Record<string, EffectivePolicy> = {};
  const expired: Policy[] = [];

  for (const name of names) {
    const forName = allDeclarations.filter((decl) => decl.name === name);
    const resolved = resolvePolicy(name, forName, options);
    expired.push(...resolved.expired);
    if (!resolved.ok) {
      refusals.push(...resolved.refusals);
    } else {
      policies[name] = resolved.effective;
    }
  }

  if (refusals.length > 0) {
    return { ok: false, refusals, expired, devModeGoverned };
  }

  return { ok: true, policies, expired, devModeGoverned };
}
