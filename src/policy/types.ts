// Kernel amendment 02: the Policy object, its four levels, its two kinds, and the closed
// vocabulary of enforced policies in 0.5.0 (catalogue.md).
//
// A policy is a named rule with a value, set at one level (entity, project, team, seat), by a
// named setter, on a date, with an optional expiry and a kind (enforced or advised). Enforced
// policies come from a closed, release-owned vocabulary; advised policies may be from the
// catalogue or a project's own text.

import { DURATION, parseMeasure } from '../file/sections/units.ts';
import {
  DEFAULT_STATE_THRESHOLDS,
  DELIVERY_LEGS,
  DELIVERY_ORDER,
  parseSeatNumberingValue,
  SEAT_NUMBERING_DEFAULT_VALUE,
  SEATS_CROSS_TEAMS,
  STATE_THRESHOLDS,
  SWAP_WAIT_SECONDS,
  type DeliveryLeg,
} from '../settings/inherit.ts';
import { ownerReplyToValueProblem, parseOwnerReplyToValue } from '../settings/owner-reply.ts';
import { parseSenderLineValue, senderLineValueProblem } from '../settings/sender-line.ts';
import { EVENT_THRESHOLDS } from './events.ts';
import { formatModelRule, modelRuleProblem, parseModelRule } from './model-rule.ts';

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
 * - `setter`: who set it (`'owner'` in 0.5.0, or `null` for unsigned legacy `delivery_order:` declarations)
 * - `date`: ISO-8601 timestamp when set (or `null` for unsigned legacy declarations)
 * - `expiry`: optional ISO-8601 timestamp when the declaration expires (expired = unset at its level)
 * - `kind`: `'enforced' | 'advised'`
 */
export type Policy<V extends PolicyValue = PolicyValue> = {
  name: string;
  value: V;
  level: PolicyLevel;
  setter: string | null;
  date: string | null;
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
 * (`reload` was added last).
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
  'rename',
] as const;

export type DevModeOperation = (typeof DEV_MODE_OPERATIONS)[number];

/** Canonical names of the closed enforced policy vocabulary in 0.5.0. */
export const ENFORCED_POLICY_NAMES = [
  'dev-mode',
  'seats-cross-teams',
  'state-trace-window-seconds',
  'state-blind-after-seconds',
  'state-hook-working-seconds',
  'liveness-idle-lead-seconds',
  'liveness-idle-owner-seconds',
  'delivery-order',
  'brief-transport',
  'sender-line',
  'event-thread-ttl-seconds',
  'event-thread-cap',
  'event-retention-days',
  'event-held-threshold-seconds',
  'event-unreachable-threshold-seconds',
  'event-idle-threshold-seconds',
  'event-reconcile-interval-seconds',
  'model-rule',
  'swap-wait-seconds',
  'owner-reply-to',
  'codex-daemon',
  'idle-threshold',
  'daemon.broker',
] as const;

export type EnforcedPolicyName = (typeof ENFORCED_POLICY_NAMES)[number];

/** Canonical names of catalogue advised policies in 0.5.0. */
export const ADVISED_POLICY_NAMES = [
  'development-mode',
  'shared-checkout-hygiene',
  'pane-conduct',
  'seat-numbering',
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
  trace_window_seconds: 'state-trace-window-seconds',
  'trace-window-seconds': 'state-trace-window-seconds',
  state_blind_after_seconds: 'state-blind-after-seconds',
  blind_after_seconds: 'state-blind-after-seconds',
  'blind-after-seconds': 'state-blind-after-seconds',
  state_hook_working_seconds: 'state-hook-working-seconds',
  hook_working_seconds: 'state-hook-working-seconds',
  'hook-working-seconds': 'state-hook-working-seconds',
  liveness_idle_lead_seconds: 'liveness-idle-lead-seconds',
  idle_lead_seconds: 'liveness-idle-lead-seconds',
  'idle-lead-seconds': 'liveness-idle-lead-seconds',
  liveness_idle_owner_seconds: 'liveness-idle-owner-seconds',
  idle_owner_seconds: 'liveness-idle-owner-seconds',
  'idle-owner-seconds': 'liveness-idle-owner-seconds',
  delivery_order: 'delivery-order',
  brief_transport: 'brief-transport',
  sender_line: 'sender-line',
  daemon_broker: 'daemon.broker',
  'daemon-broker': 'daemon.broker',
  development_mode: 'development-mode',
  shared_checkout_hygiene: 'shared-checkout-hygiene',
  seat_numbering: 'seat-numbering',
  pane_conduct: 'pane-conduct',
  review_terms: 'review-terms',
  event_thread_ttl_seconds: 'event-thread-ttl-seconds',
  thread_ttl_seconds: 'event-thread-ttl-seconds',
  'thread-ttl': 'event-thread-ttl-seconds',
  thread_ttl: 'event-thread-ttl-seconds',
  event_thread_cap: 'event-thread-cap',
  thread_cap: 'event-thread-cap',
  'thread-cap': 'event-thread-cap',
  event_retention_days: 'event-retention-days',
  retention_days: 'event-retention-days',
  retention: 'event-retention-days',
  event_held_threshold_seconds: 'event-held-threshold-seconds',
  held_threshold_seconds: 'event-held-threshold-seconds',
  held: 'event-held-threshold-seconds',
  event_unreachable_threshold_seconds: 'event-unreachable-threshold-seconds',
  unreachable_threshold_seconds: 'event-unreachable-threshold-seconds',
  unreachable: 'event-unreachable-threshold-seconds',
  event_idle_threshold_seconds: 'event-idle-threshold-seconds',
  idle_threshold_seconds: 'event-idle-threshold-seconds',
  idle: 'event-idle-threshold-seconds',
  event_reconcile_interval_seconds: 'event-reconcile-interval-seconds',
  reconcile_interval_seconds: 'event-reconcile-interval-seconds',
  reconcile: 'event-reconcile-interval-seconds',
  model_rule: 'model-rule',
  swap_wait_seconds: 'swap-wait-seconds',
  owner_reply_to: 'owner-reply-to',
  codex_daemon: 'codex-daemon',
  idle_threshold: 'idle-threshold',
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
  /** Levels permitted to loosen this setting in the legacy settings surface (`src/settings/inherit.ts`). */
  looseningLevels?: readonly PolicyLevel[];
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
  /** Optional custom refusal reason when `parseValue(raw)` returns null. */
  valueProblem?: (raw: unknown) => string | null;
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

/**
 * A duration written the way the team file writes one — a number with its unit, `30s`, `5m` or
 * `2h` (the `DURATION` table in `src/file/sections/units.ts`) — or a bare whole number of
 * seconds, the spelling a policy threshold already takes. The value is whole seconds.
 */
function parseDurationSeconds(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (/^[1-9][0-9]*$/.test(text)) return Number.parseInt(text, 10);
  const seconds = parseMeasure(text, DURATION);
  return seconds !== null && Number.isInteger(seconds) && seconds > 0 ? seconds : null;
}

function durationValueProblem(name: string, raw: unknown): string | null {
  if (parseDurationSeconds(raw) !== null) return null;
  return `policy "${name}" needs a duration above 0, such as 30s, 5m or 2h, or a whole number of seconds`;
}

/** A positive whole count (a record cap, a number of days), without the seconds suffix. */
function parsePositiveCount(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw.trim())) {
    return Number.parseInt(raw.trim(), 10);
  }
  return null;
}

/**
 * A delay threshold: a positive whole number of seconds, never above its release default. The
 * ceiling is part of the spec's range, so every path that parses a word — `team policy set`
 * before writing, and the resolver at load — refuses a longer one; the message says why.
 */
function parseShortenableSeconds(raw: unknown, ceiling: number): number | null {
  const n = parsePositiveSeconds(raw);
  return n !== null && n <= ceiling ? n : null;
}

function shortenOnlyProblem(name: string, raw: unknown, ceiling: number): string | null {
  const n = parsePositiveSeconds(raw);
  if (n !== null && n > ceiling) {
    return `policy "${name}" may only be shortened: ${String(n)}s exceeds the release default ${String(ceiling)}s`;
  }
  return null;
}

function rawDeliveryItems(raw: unknown): unknown[] | null {
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (Array.isArray(raw)) return raw;
  return null;
}

function parseDeliveryOrder(raw: unknown): readonly DeliveryLeg[] | null {
  const items = rawDeliveryItems(raw);
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

function deliveryOrderProblem(raw: unknown): string | null {
  const items = rawDeliveryItems(raw);
  if (items && items.some((item) => item === 'socket-accepted')) {
    return 'socket-accepted is not available in this release';
  }
  return null;
}

/**
 * Catalogue of policies known to TeamCLI 0.5.0 (amendment 02 `catalogue.md`), with defaults
 * sourced directly from `src/settings/inherit.ts`.
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
    looseningLevels: SEATS_CROSS_TEAMS.looseningLevels as readonly PolicyLevel[],
    defaultValue: SEATS_CROSS_TEAMS.fallback ? 'on' : 'off',
    gateLifting: false,
    parseValue: parseOnOff,
    // 'off' is tighter than 'on'.
    isWithin: (lower: 'on' | 'off', higher: 'on' | 'off') => !(higher === 'off' && lower === 'on'),
  },
  'state-trace-window-seconds': {
    name: 'state-trace-window-seconds',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    looseningLevels: STATE_THRESHOLDS.trace_window_seconds.looseningLevels as readonly PolicyLevel[],
    defaultValue: DEFAULT_STATE_THRESHOLDS.trace_window_seconds,
    gateLifting: false,
    parseValue: parsePositiveSeconds,
    // Shorter or equal window is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  'state-blind-after-seconds': {
    name: 'state-blind-after-seconds',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    looseningLevels: STATE_THRESHOLDS.blind_after_seconds.looseningLevels as readonly PolicyLevel[],
    defaultValue: DEFAULT_STATE_THRESHOLDS.blind_after_seconds,
    gateLifting: false,
    parseValue: parsePositiveSeconds,
    // Shorter or equal threshold is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  'state-hook-working-seconds': {
    name: 'state-hook-working-seconds',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    looseningLevels: STATE_THRESHOLDS.hook_working_seconds.looseningLevels as readonly PolicyLevel[],
    defaultValue: DEFAULT_STATE_THRESHOLDS.hook_working_seconds,
    gateLifting: false,
    parseValue: parsePositiveSeconds,
    // Shorter or equal window is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  'liveness-idle-lead-seconds': {
    name: 'liveness-idle-lead-seconds',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    looseningLevels: STATE_THRESHOLDS.idle_lead_seconds.looseningLevels as readonly PolicyLevel[],
    defaultValue: DEFAULT_STATE_THRESHOLDS.idle_lead_seconds,
    gateLifting: false,
    parseValue: parsePositiveSeconds,
    // Shorter or equal window is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  'liveness-idle-owner-seconds': {
    name: 'liveness-idle-owner-seconds',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    looseningLevels: STATE_THRESHOLDS.idle_owner_seconds.looseningLevels as readonly PolicyLevel[],
    defaultValue: DEFAULT_STATE_THRESHOLDS.idle_owner_seconds,
    gateLifting: false,
    parseValue: parsePositiveSeconds,
    // Shorter or equal window is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  'delivery-order': {
    name: 'delivery-order',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: DELIVERY_ORDER.fallback,
    gateLifting: false,
    parseValue: parseDeliveryOrder,
    valueProblem: deliveryOrderProblem,
    // Dropping or reordering channels present in `higher` is within. `native`, `socket` and
    // `headless-resume` are the legs a word may add: none is in the fallback order, and a level
    // that names one is the sender choosing that channel — its own SendMessage, this build's
    // frame on the receiver's socket, or a headless runtime's own turn, which no default order
    // ever inserts. Every other leg absent from `higher` is still an addition, and the whole
    // word is set aside.
    isWithin: (lower: readonly DeliveryLeg[], higher: readonly DeliveryLeg[]) =>
      lower.length > 0
      && lower.every((leg, idx) => (leg === 'native' || leg === 'socket' || leg === 'headless-resume' || higher.includes(leg)) && lower.indexOf(leg) === idx),
  },
  // How a general seat brief travels (OD50): `file` is the signed record in the seat's own drop
  // folder, as every launch writes it; `message` keeps that same signed record and claim and
  // delivers it through the seat's own delivery walk, so a brief earns the same receipts and
  // history a send does; `memory` is a strict opt-in experiment that hands the whole brief to a
  // live receiver through its own runtime, with no body written to disk on either side and no
  // fallback when the receiver is not live. The values are not one ladder: `message` is within
  // `file` (it keeps the same durable record and adds the receipted walk), while `memory` is
  // comparable only to itself — it drops the durable record, so no level may infer it from, or
  // be inferred into, `file` or `message`.
  'brief-transport': {
    name: 'brief-transport',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: 'file',
    gateLifting: false,
    parseValue: (raw: unknown) => (raw === 'file' || raw === 'message' || raw === 'memory' ? raw : null),
    isWithin: (lower: 'file' | 'message' | 'memory', higher: 'file' | 'message' | 'memory') =>
      lower === higher || (lower === 'message' && higher === 'file'),
  },
  // The line a typed wake opens with: `on` is the shipped `From <seat>@<team>:`,
  // and a level may set its own one-line format in its place, as long as both names are in it.
  // A wake always names the sender its signed record carries; a format decides the words around
  // those two names, never whether they are there. So the floor has no off: `off` is refused by
  // the parser, and every format is as strict as every other, which lets a lower level choose.
  'sender-line': {
    name: 'sender-line',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: 'on',
    gateLifting: false,
    parseValue: parseSenderLineValue,
    valueProblem: senderLineValueProblem,
    isWithin: () => true,
  },
  // The event thresholds (`src/policy/events.ts`) are enforced numbers the owner sets one field
  // at a time; `src/policy/thresholds.ts` reads the resolved chain back into the set the bus and
  // the reply command consume. A shorter value is the tighter one on every field — a shorter
  // thread life, a smaller cap, less retention, a more frequent reconcile pass, a shorter delay.
  // The three delay thresholds may only be shortened, never lengthened past the release default:
  // the ceiling is in their parse range, so a longer word is refused before it is signed.
  'event-thread-ttl-seconds': {
    name: 'event-thread-ttl-seconds',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: EVENT_THRESHOLDS.thread_ttl_seconds,
    gateLifting: false,
    parseValue: parsePositiveSeconds,
    // Shorter or equal life is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  'event-thread-cap': {
    name: 'event-thread-cap',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: EVENT_THRESHOLDS.thread_cap,
    gateLifting: false,
    parseValue: parsePositiveCount,
    // A smaller or equal cap is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  'event-retention-days': {
    name: 'event-retention-days',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: EVENT_THRESHOLDS.retention_days,
    gateLifting: false,
    parseValue: parsePositiveCount,
    // Fewer or equal days kept is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  'event-held-threshold-seconds': {
    name: 'event-held-threshold-seconds',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: EVENT_THRESHOLDS.held_threshold_seconds,
    gateLifting: false,
    parseValue: (raw: unknown) => parseShortenableSeconds(raw, EVENT_THRESHOLDS.held_threshold_seconds),
    valueProblem: (raw: unknown) => shortenOnlyProblem('event-held-threshold-seconds', raw, EVENT_THRESHOLDS.held_threshold_seconds),
    // Shorter or equal delay is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  'event-unreachable-threshold-seconds': {
    name: 'event-unreachable-threshold-seconds',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: EVENT_THRESHOLDS.unreachable_threshold_seconds,
    gateLifting: false,
    parseValue: (raw: unknown) => parseShortenableSeconds(raw, EVENT_THRESHOLDS.unreachable_threshold_seconds),
    valueProblem: (raw: unknown) => shortenOnlyProblem('event-unreachable-threshold-seconds', raw, EVENT_THRESHOLDS.unreachable_threshold_seconds),
    // Shorter or equal delay is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  'event-idle-threshold-seconds': {
    name: 'event-idle-threshold-seconds',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: EVENT_THRESHOLDS.idle_threshold_seconds,
    gateLifting: false,
    parseValue: (raw: unknown) => parseShortenableSeconds(raw, EVENT_THRESHOLDS.idle_threshold_seconds),
    valueProblem: (raw: unknown) => shortenOnlyProblem('event-idle-threshold-seconds', raw, EVENT_THRESHOLDS.idle_threshold_seconds),
    // Shorter or equal delay is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  'event-reconcile-interval-seconds': {
    name: 'event-reconcile-interval-seconds',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: EVENT_THRESHOLDS.reconcile_interval_seconds,
    gateLifting: false,
    parseValue: parsePositiveSeconds,
    // A shorter or equal interval is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  // The entity's rule for which models may run on which seats (Policies rule 10, OD-20261019-01):
  // one line of `<seat|role|*>=<lab>` entries, carried out in every team of the entity. Only the
  // entity sets it, so no lower level is ever judged against it; the empty default is no rule.
  'model-rule': {
    name: 'model-rule',
    kind: 'enforced',
    levels: ['entity'],
    defaultValue: '',
    gateLifting: false,
    parseValue: (raw: unknown) => {
      const entries = parseModelRule(raw);
      return entries === null ? null : formatModelRule(entries);
    },
    valueProblem: modelRuleProblem,
    isWithin: () => true,
  },
  // How long a queued swap may wait for its boundary before it runs at the next pause between two
  // turns (Policies rule 11), 30 minutes when nothing declares it. A shorter wait moves the seat
  // sooner, so the shorter value is the tighter one.
  'swap-wait-seconds': {
    name: 'swap-wait-seconds',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    looseningLevels: SWAP_WAIT_SECONDS.looseningLevels as readonly PolicyLevel[],
    defaultValue: SWAP_WAIT_SECONDS.fallback,
    gateLifting: false,
    parseValue: parsePositiveSeconds,
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  // The entity-level address an owner-origin message names for the seat that answers it: one
  // qualified `seat@team` target. The empty default is no target; entity `floor` alone answers
  // its shipped `orchestrator@floor`, applied by the reader (`src/policy/owner-reply.ts`) rather
  // than inherited by every entity as a level default. A signed entity declaration replaces it,
  // and any other entity without one has no target.
  'owner-reply-to': {
    name: 'owner-reply-to',
    kind: 'enforced',
    levels: ['entity'],
    defaultValue: '',
    gateLifting: false,
    parseValue: parseOwnerReplyToValue,
    valueProblem: ownerReplyToValueProblem,
    isWithin: () => true,
  },
  // The Codex daemon on a seat's runtime: on unless a level says otherwise. `off` is a valid
  // opt-out at every level, so a project, team or seat may switch off a daemon the levels above
  // left on; `on` is only within an inherited `on`, so a level that turned the daemon off is not
  // turned back on lower down. The runtime reader that consumes this value is owned elsewhere;
  // this entry is only the name, its alias and the value rule.
  'codex-daemon': {
    name: 'codex-daemon',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: 'on',
    gateLifting: false,
    parseValue: parseOnOff,
    // 'off' is the opt-out and is always within; 'on' is only within an inherited 'on'.
    isWithin: (lower: 'on' | 'off', higher: 'on' | 'off') => lower === 'off' || higher === 'on',
  },
  // How long a seat may sit idle before its lead hears about it: a duration with its unit (`5m`,
  // `30s`) or whole seconds, five minutes when nothing declares it, always read as numeric
  // seconds. Only the entity, project or team sets it — never the seat — and a shorter window is
  // the tighter one. `team watch` reads the effective value; this entry is only the name, its
  // alias and the value rule.
  'idle-threshold': {
    name: 'idle-threshold',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: 300,
    gateLifting: false,
    parseValue: parseDurationSeconds,
    valueProblem: (raw: unknown) => durationValueProblem('idle-threshold', raw),
    // A shorter or equal window is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  // The machine daemon's broker feature: on keeps the broker handler serving `team next` over the
  // one machine socket, off stops it before any tracker credential is read. It is a feature gate,
  // not a start authority, so no level says who starts the daemon. Off is explicit and absolute:
  // it is within an inherited on, and on is never within an inherited off, so a lower level may
  // switch the feature off but cannot switch it back on. The daemon reader that consumes this
  // value is owned elsewhere; this entry is only the name, its aliases and the value rule.
  'daemon.broker': {
    name: 'daemon.broker',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    // The broker reads the owner's credential store, so absence is off: no team gets broker
    // access because it failed to say anything. Turning it on is an explicit owner declaration.
    defaultValue: 'off',
    gateLifting: false,
    parseValue: parseOnOff,
    // 'off' is tighter than 'on': off is within on, on is not within off.
    isWithin: (lower: 'on' | 'off', higher: 'on' | 'off') => !(higher === 'off' && lower === 'on'),
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
  // How a seat's number is written at the front of its name: the width (1 to 4 digits, or `auto`
  // for the smallest width that holds the team's largest number) and the separator, carried as one
  // canonical string — `2-` for two digits and a hyphen, `auto.` for an automatic width and a dot.
  // An advised format has nothing tighter to judge against, so a lower level chooses freely.
  'seat-numbering': {
    name: 'seat-numbering',
    kind: 'advised',
    levels: ['entity', 'project', 'team'],
    defaultValue: SEAT_NUMBERING_DEFAULT_VALUE,
    gateLifting: false,
    lowerLevelChooses: true,
    parseValue: parseSeatNumberingValue,
    isWithin: () => true,
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
