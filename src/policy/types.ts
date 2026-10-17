// Kernel amendment 02: the Policy object, its four levels, its two kinds, and the closed
// vocabulary of enforced policies in 0.5.0 (catalogue.md).
//
// A policy is a named rule with a value, set at one level (entity, project, team, seat), by a
// named setter, on a date, with an optional expiry and a kind (enforced or advised). Enforced
// policies come from a closed, release-owned vocabulary; advised policies may be from the
// catalogue or a project's own text.

import { DELIVERY_LEGS, type DeliveryLeg } from '../settings/inherit.ts';

/** The four inheritance levels of Kernel amendment 02 §2.2, outermost first. */
export type PolicyLevel = 'entity' | 'project' | 'team' | 'seat';

export const POLICY_LEVELS: readonly PolicyLevel[] = ['entity', 'project', 'team', 'seat'] as const;

/** The two policy kinds of Kernel amendment 02 §2.5, fixed by the defining text. */
export type PolicyKind = 'enforced' | 'advised';

/** The value a policy may hold: 'on'/'off', a number (seconds), a string, or an ordered list of channels. */
export type PolicyValue = 'on' | 'off' | boolean | number | string | readonly string[];

/**
 * One policy declaration at one level (Kernel amendment 02 §2.1).
 *
 * Fields required by the amendment:
 * - `name`: canonical policy name (e.g. `dev-mode`, `seats-cross-teams`, `delivery-order`)
 * - `value`: the declared value at this level
 * - `level`: `entity | project | team | seat`
 * - `setter`: who set it (`'owner'` in 0.5.0)
 * - `date`: ISO-8601 timestamp when set
 * - `expiry`: optional ISO-8601 timestamp when the declaration expires (expired = unset at its level)
 * - `kind`: `'enforced' | 'advised'`
 */
export type Policy<V extends PolicyValue = PolicyValue> = {
  name: string;
  value: V;
  level: PolicyLevel;
  setter: string;
  date: string;
  expiry?: string | null;
  kind: PolicyKind;
  /** Optional target identifier (entity name, project id, team id, or agent id) covered by the signature. */
  target?: string;
  /** Optional signing generation from the owner's key store. */
  generation?: number;
  /** Optional Ed25519 signature under `POLICY_DOMAIN`. */
  signature?: string;
};

/** Domain tag for owner-signed policy records (amendment 02 §2.6, §2.12). */
export const POLICY_DOMAIN = 'team-policy-v1\n';

/**
 * The EIGHT everyday operations whose caller gate `dev-mode` lifts when `on`
 * (OD-20261017-01, OD-20261017-08, and Atlas ruling of 2026-10-17 adding `reload`).
 * Never reaches `grant`, `delegate`, `revoke`, `approve`, `create`, `agree`, `leads`,
 * `remove --abandon`, `broker`, `tempo`, or a delegate's file-editing `add`.
 */
export const DEV_MODE_OPERATIONS = [
  'up',
  'down',
  'remove',
  'register',
  'add',
  'restart',
  'init',
  'reload',
] as const;

export type DevModeOperation = (typeof DEV_MODE_OPERATIONS)[number];

/** Canonical names of the closed enforced policy vocabulary in 0.5.0. */
export const ENFORCED_POLICY_NAMES = [
  'dev-mode',
  'seats-cross-teams',
  'state-trace-window-seconds',
  'state-blind-after-seconds',
  'state-hook-working-seconds',
  'delivery-order',
] as const;

export type EnforcedPolicyName = (typeof ENFORCED_POLICY_NAMES)[number];

/** Canonical names of catalogue advised policies in 0.5.0. */
export const ADVISED_POLICY_NAMES = [
  'development-mode',
  'shared-checkout-hygiene',
  'pane-conduct',
  'board',
  'review-terms',
] as const;

export type AdvisedPolicyName = (typeof ADVISED_POLICY_NAMES)[number];

export type CataloguePolicyName = EnforcedPolicyName | AdvisedPolicyName;

/** Snake-case aliases accepted at load and normalized to their canonical kebab-case policy name. */
export const POLICY_NAME_ALIASES: Readonly<Record<string, CataloguePolicyName>> = {
  dev_mode: 'dev-mode',
  seats_cross_teams: 'seats-cross-teams',
  state_trace_window_seconds: 'state-trace-window-seconds',
  state_blind_after_seconds: 'state-blind-after-seconds',
  state_hook_working_seconds: 'state-hook-working-seconds',
  delivery_order: 'delivery-order',
  development_mode: 'development-mode',
  shared_checkout_hygiene: 'shared-checkout-hygiene',
  pane_conduct: 'pane-conduct',
  review_terms: 'review-terms',
};

/** Normalizes a policy name, mapping known snake_case settings spellings to canonical kebab-case. */
export function normalizePolicyName(raw: string): string {
  const trimmed = raw.trim();
  return POLICY_NAME_ALIASES[trimmed] ?? trimmed;
}

/** Definition of a policy in the catalogue (its kind, allowed levels, release default, and ordering). */
export type PolicySpec<V extends PolicyValue = PolicyValue> = {
  name: CataloguePolicyName;
  kind: PolicyKind;
  /** Levels permitted to set this policy (`dev-mode` excludes `'seat'`). */
  levels: readonly PolicyLevel[];
  /** Release default when no level in the chain sets a value (`'off'` for gate-lifting). */
  defaultValue: V;
  /** True for gate-lifting policies (§2.7), where absent or expired means `'off'`. */
  gateLifting: boolean;
  /**
   * True for advised policies whose defining text says a lower level chooses without ordering
   * (`development-mode`, amendment 02 §2.3 exception).
   */
  lowerLevelChooses?: boolean;
  /** Validates and normalizes a raw value for this policy, returning null if invalid. */
  parseValue: (raw: unknown) => V | null;
  /**
   * Returns true when `lower` (with `lowerExpiry`) is within (tighter than or equal to)
   * `higher` (with `higherExpiry`).
   */
  isWithin: (
    lower: V,
    higher: V,
    lowerExpiry?: string | null,
    higherExpiry?: string | null,
  ) => boolean;
};

function parseOnOff(raw: unknown): 'on' | 'off' | null {
  if (raw === 'on' || raw === true) return 'on';
  if (raw === 'off' || raw === false) return 'off';
  return null;
}

function parsePositiveSeconds(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^[1-9][0-9]*s?$/.test(raw.trim())) {
    const n = Number.parseInt(raw.trim().replace(/s$/, ''), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function parseDeliveryOrder(raw: unknown): readonly DeliveryLeg[] | null {
  const items =
    typeof raw === 'string'
      ? raw
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      : Array.isArray(raw)
        ? raw
        : null;
  if (!items || items.length === 0) return null;
  const out: DeliveryLeg[] = [];
  for (const item of items) {
    if (typeof item !== 'string' || !(DELIVERY_LEGS as readonly string[]).includes(item)) return null;
    const leg = item as DeliveryLeg;
    if (out.includes(leg)) return null;
    out.push(leg);
  }
  return out;
}

/**
 * Catalogue of policies known to TeamCLI 0.5.0 (amendment 02 `catalogue.md`).
 */
export const POLICY_CATALOGUE: Readonly<Record<CataloguePolicyName, PolicySpec<any>>> = {
  'dev-mode': {
    name: 'dev-mode',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: 'off',
    gateLifting: true,
    parseValue: parseOnOff,
    isWithin: (lower: 'on' | 'off', higher: 'on' | 'off', lowerExpiry?: string | null, higherExpiry?: string | null) => {
      if (lower === 'off') return true;
      if (higher === 'off') return false;
      // Both are 'on': a nearer expiry is tighter than a later expiry or none.
      if (!higherExpiry) return true;
      if (!lowerExpiry) return false;
      return Date.parse(lowerExpiry) <= Date.parse(higherExpiry);
    },
  },
  'seats-cross-teams': {
    name: 'seats-cross-teams',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: 'off',
    gateLifting: false,
    parseValue: parseOnOff,
    // 'off' is tighter than 'on'.
    isWithin: (lower: 'on' | 'off', higher: 'on' | 'off') => !(higher === 'off' && lower === 'on'),
  },
  'state-trace-window-seconds': {
    name: 'state-trace-window-seconds',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: 120,
    gateLifting: false,
    parseValue: parsePositiveSeconds,
    // Shorter or equal window is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  'state-blind-after-seconds': {
    name: 'state-blind-after-seconds',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: 1800,
    gateLifting: false,
    parseValue: parsePositiveSeconds,
    // Shorter or equal threshold is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  'state-hook-working-seconds': {
    name: 'state-hook-working-seconds',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: 120,
    gateLifting: false,
    parseValue: parsePositiveSeconds,
    // Shorter or equal window is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  'delivery-order': {
    name: 'delivery-order',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: DELIVERY_LEGS,
    gateLifting: false,
    parseValue: parseDeliveryOrder,
    // Dropping or reordering channels present in `higher` is within; adding one excluded by `higher` is not.
    isWithin: (lower: readonly DeliveryLeg[], higher: readonly DeliveryLeg[]) =>
      lower.length > 0 && lower.every((leg, idx) => higher.includes(leg) && lower.indexOf(leg) === idx),
  },
  'development-mode': {
    name: 'development-mode',
    kind: 'advised',
    levels: ['entity', 'project', 'team'],
    defaultValue: 'local-fast',
    gateLifting: false,
    lowerLevelChooses: true,
    parseValue: (raw: unknown) => (raw === 'local-fast' || raw === 'pr-per-change' ? raw : null),
    isWithin: () => true,
  },
  'shared-checkout-hygiene': {
    name: 'shared-checkout-hygiene',
    kind: 'advised',
    levels: ['project', 'team'],
    defaultValue: 'on',
    gateLifting: false,
    parseValue: parseOnOff,
    // 'on' is tighter than 'off'.
    isWithin: (lower: 'on' | 'off', higher: 'on' | 'off') => !(higher === 'on' && lower === 'off'),
  },
  'pane-conduct': {
    name: 'pane-conduct',
    kind: 'advised',
    levels: ['entity', 'project', 'team'],
    defaultValue: 'on',
    gateLifting: false,
    parseValue: parseOnOff,
    // 'on' is tighter than 'off'.
    isWithin: (lower: 'on' | 'off', higher: 'on' | 'off') => !(higher === 'on' && lower === 'off'),
  },
  board: {
    name: 'board',
    kind: 'advised',
    levels: ['project'],
    defaultValue: '',
    gateLifting: false,
    parseValue: (raw: unknown) => (typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null),
    isWithin: (lower: string, higher: string) => lower === higher,
  },
  'review-terms': {
    name: 'review-terms',
    kind: 'advised',
    levels: ['project'],
    defaultValue: '',
    gateLifting: false,
    parseValue: (raw: unknown) => (typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null),
    isWithin: (lower: string, higher: string) => lower === higher,
  },
};

export function getPolicySpec(name: string): PolicySpec<any> | null {
  const canonical = normalizePolicyName(name) as CataloguePolicyName;
  return POLICY_CATALOGUE[canonical] ?? null;
}
