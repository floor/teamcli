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
  'delivery-timeout',
  'delivery-escalation',
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
  'watch-rhythm',
  'grant-emission',
  'owner-signers',
  'owner-signer-mode',
  'approval-rule-ttl',
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
  delivery_timeout: 'delivery-timeout',
  delivery_escalation: 'delivery-escalation',
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
  watch_rhythm: 'watch-rhythm',
  grant_emission: 'grant-emission',
  owner_signers: 'owner-signers',
  owner_signer_mode: 'owner-signer-mode',
  approval_rule_ttl: 'approval-rule-ttl',
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
   * Optional: merges a lower declaration into the value in force above it before the chain moves
   * on. A sparse value names only some fields, and the fields it leaves out inherit the value in
   * force (the release default for the first declaration) instead of being reset. When absent,
   * the normalized declaration is the value in force.
   */
  inherit?: (higher: V, lower: V) => V;
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

/** `owner-signers`: a list of signer names, or on the command line one comma-separated word (`phone,mac`). */
function parseOwnerSigners(raw: unknown): string[] | null {
  const list = typeof raw === 'string' ? raw.split(',').map((n) => n.trim()) : raw;
  return Array.isArray(list) && list.length > 0 && list.every((n) => typeof n === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(n)) && new Set(list).size === list.length
    ? (list as string[])
    : null;
}

/** `approval-rule-ttl`: whole days, 1 to 90; on the command line `60` or `60d`. */
function parseApprovalRuleTtlDays(raw: unknown): number | null {
  const n = typeof raw === 'string' && /^[1-9][0-9]*d?$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 90 ? n : null;
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

/** The five watch rhythms, from the tightest pace to the quietest. */
export const WATCH_RHYTHMS = ['urgent', 'normal', 'relaxed', 'night', 'dormant'] as const;
export type WatchRhythmPreset = (typeof WATCH_RHYTHMS)[number];

/** The final sweep a preset runs when its value names no explicit sweep. */
export const WATCH_RHYTHM_SWEEP: Readonly<Record<WatchRhythmPreset, number>> = {
  urgent: 60,
  normal: 120,
  relaxed: 240,
  night: 3600,
  dormant: 86_400,
};

/** How a preset scales the six watch waits. The sweep is never scaled by this. */
export const WATCH_RHYTHM_FACTOR: Readonly<Record<WatchRhythmPreset, number>> = {
  urgent: 0.5,
  normal: 1,
  relaxed: 2,
  night: 12,
  dormant: 24,
};

export const WATCH_SWEEP_MIN = 10;
export const WATCH_SWEEP_MAX = 86_400;

/** A watch rhythm resolved to its final sweep and its wait factor, ready for the watch. */
export type WatchRhythm = { preset: WatchRhythmPreset; sweepSeconds: number };

function watchPresetOf(raw: unknown): WatchRhythmPreset | null {
  return typeof raw === 'string' && (WATCH_RHYTHMS as readonly string[]).includes(raw.trim())
    ? (raw.trim() as WatchRhythmPreset)
    : null;
}

function watchSweepOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= WATCH_SWEEP_MIN && raw <= WATCH_SWEEP_MAX
    ? raw
    : null;
}

/**
 * The parts a raw watch-rhythm value names: a bare preset string, the canonical `preset@seconds`
 * string, or a mapping `{ preset, sweepSeconds? }`. Null when the value is not one of those.
 */
function watchRhythmParts(raw: unknown): { preset: WatchRhythmPreset; sweepSeconds: number | null } | null {
  if (typeof raw === 'string') {
    const text = raw.trim();
    const at = text.indexOf('@');
    if (at < 0) {
      const preset = watchPresetOf(text);
      return preset === null ? null : { preset, sweepSeconds: null };
    }
    const preset = watchPresetOf(text.slice(0, at));
    const sweep = watchSweepOf(Number(text.slice(at + 1)));
    return preset === null || sweep === null ? null : { preset, sweepSeconds: sweep };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'preset' && key !== 'sweepSeconds')) return null;
  const preset = watchPresetOf(record.preset);
  if (preset === null) return null;
  if (record.sweepSeconds === undefined) return { preset, sweepSeconds: null };
  const sweep = watchSweepOf(record.sweepSeconds);
  return sweep === null ? null : { preset, sweepSeconds: sweep };
}

/**
 * The canonical watch-rhythm value: a bare preset, or `preset@seconds` when the value names an
 * explicit final sweep. The signed declaration stores this one scalar; the watch reads it back
 * as a {@link WatchRhythm}. A mapping value is accepted at load and canonicalized here.
 */
export function parseWatchRhythmValue(raw: unknown): string | null {
  const parts = watchRhythmParts(raw);
  if (parts === null) return null;
  return parts.sweepSeconds === null ? parts.preset : `${parts.preset}@${String(parts.sweepSeconds)}`;
}

/** A canonical watch-rhythm value as its final sweep and preset; null for a value this build cannot read. */
export function watchRhythmValueOf(raw: unknown): WatchRhythm | null {
  const canonical = parseWatchRhythmValue(raw);
  if (canonical === null) return null;
  const parts = watchRhythmParts(canonical);
  if (parts === null) return null;
  return {
    preset: parts.preset,
    sweepSeconds: parts.sweepSeconds ?? WATCH_RHYTHM_SWEEP[parts.preset],
  };
}

function watchRhythmProblem(raw: unknown): string | null {
  if (parseWatchRhythmValue(raw) !== null) return null;
  if (typeof raw === 'string') {
    const at = raw.indexOf('@');
    const preset = watchPresetOf(raw.slice(0, at < 0 ? raw.length : at));
    if (preset === null) {
      return `policy "watch-rhythm" has no rhythm "${raw.trim()}": expected ${WATCH_RHYTHMS.join(', ')}`;
    }
    return `policy "watch-rhythm" needs a whole sweep between ${String(WATCH_SWEEP_MIN)} and ${String(WATCH_SWEEP_MAX)} seconds after "${preset}@"`;
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'preset' && key !== 'sweepSeconds')) {
      return 'policy "watch-rhythm" takes only preset and sweepSeconds';
    }
    if (watchPresetOf(record.preset) === null) {
      return `policy "watch-rhythm" needs a preset: ${WATCH_RHYTHMS.join(', ')}`;
    }
    return `policy "watch-rhythm" needs a whole sweepSeconds between ${String(WATCH_SWEEP_MIN)} and ${String(WATCH_SWEEP_MAX)}`;
  }
  return `policy "watch-rhythm" needs a preset (${WATCH_RHYTHMS.join(', ')}) or { preset, sweepSeconds? }`;
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

/** One `delivery-timeout` word's entries, in the order it names them; an empty part is invalid. */
function deliveryTimeoutItems(raw: unknown): unknown[] | null {
  if (typeof raw === 'string') return raw.split(',');
  if (Array.isArray(raw)) return raw;
  return null;
}

/** The budgets a word names; null when the word is not a route map this surface admits. */
function parseDeliveryTimeoutEntries(raw: unknown): Map<DeliveryTimeoutRoute, number> | null {
  const items = deliveryTimeoutItems(raw);
  if (!items || items.length === 0) return null;
  const entries = new Map<DeliveryTimeoutRoute, number>();
  for (const item of items) {
    if (typeof item !== 'string') return null;
    const text = item.trim();
    const match = /^([a-z][a-z0-9-]*)=([1-9][0-9]*)$/.exec(text);
    if (!match) return null;
    const route = match[1] as DeliveryTimeoutRoute;
    if (!(DELIVERY_TIMEOUT_ROUTES as readonly string[]).includes(route)) return null;
    const seconds = Number.parseInt(match[2]!, 10);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) return null;
    if (entries.has(route)) return null;
    entries.set(route, seconds);
  }
  return entries;
}

/** The budgets a `delivery-timeout` value fills out with the release defaults. In force, a route
 *  a lower word leaves out inherits the budget set above it (`inheritDeliveryTimeout`); this
 *  fills only the routes no level in the chain named at all. */
export function deliveryTimeoutOf(value: unknown): Record<DeliveryTimeoutRoute, number> | null {
  const entries = parseDeliveryTimeoutEntries(value);
  if (entries === null) return null;
  const budgets: Record<DeliveryTimeoutRoute, number> = { ...DELIVERY_TIMEOUT_DEFAULTS };
  for (const [route, seconds] of entries) budgets[route] = seconds;
  return budgets;
}

/** The complete map, in route order (`socket=15,mcp-inbox=15,typed=15,native=15`). */
function formatDeliveryTimeout(budgets: Readonly<Record<DeliveryTimeoutRoute, number>>): string {
  return DELIVERY_TIMEOUT_ROUTES.map((route) => `${route}=${String(budgets[route])}`).join(',');
}

/** A word kept to the routes it names, in route order, so the resolver can inherit the rest. */
function formatNamedDeliveryTimeout(entries: ReadonlyMap<DeliveryTimeoutRoute, number>): string {
  return DELIVERY_TIMEOUT_ROUTES.filter((route) => entries.has(route))
    .map((route) => `${route}=${String(entries.get(route))}`)
    .join(',');
}

function parseDeliveryTimeout(raw: unknown): string | null {
  const entries = parseDeliveryTimeoutEntries(raw);
  return entries === null ? null : formatNamedDeliveryTimeout(entries);
}

/**
 * A lower word inherits every route it leaves out from the value in force above it, so a team
 * word `typed=4` under an entity `socket=5` keeps socket at 5 rather than resetting it to the
 * release default. The value in force after the merge is always a complete map.
 */
function inheritDeliveryTimeout(higher: string, lower: string): string {
  const budgets: Record<DeliveryTimeoutRoute, number> = { ...DELIVERY_TIMEOUT_DEFAULTS };
  for (const source of [higher, lower]) {
    const entries = parseDeliveryTimeoutEntries(source);
    if (entries === null) continue;
    for (const [route, seconds] of entries) budgets[route] = seconds;
  }
  return formatDeliveryTimeout(budgets);
}

function deliveryTimeoutProblem(raw: unknown): string | null {
  const items = deliveryTimeoutItems(raw) ?? [];
  const routes = items
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.split('=')[0]?.trim() ?? '');
  if (routes.includes('socket-accepted')) return 'socket-accepted is not available in this release';
  for (const route of routes) {
    if (route === 'drop' || route === 'durable-copy') {
      return `route "${route}" has no live receipt wait and no attempt budget`;
    }
  }
  return null;
}

/**
 * The main delay before a durable escalation reaches the entity orchestrator's mailbox after
 * every live route has failed: five minutes (the timing decision of 2026-10-20). The
 * all-live-routes-failed event is immediate at 0 and is not a value this policy can move. The
 * legacy `event-unreachable-threshold-seconds` remains enforced as a compatibility cap only when
 * a level declares it; its own release default of 600 does not lengthen this 300.
 */
export const DELIVERY_ESCALATION_SECONDS = 300;

/**
 * The routes `delivery-timeout` may budget: every leg with a live transport attempt. `native`
 * (the CLI's own enqueue or spawn) counts: it has no read acknowledgement, but the attempt can
 * still hang, so the budget bounds it. `drop` has no live wait at all, and a word naming it — or
 * a route this release does not carry — is refused.
 */
export const DELIVERY_TIMEOUT_ROUTES = ['socket', 'mcp-inbox', 'typed', 'native'] as const;
export type DeliveryTimeoutRoute = (typeof DELIVERY_TIMEOUT_ROUTES)[number];

/** The reviewed attempt budget per route: fifteen seconds each (the timing decision). */
export const DELIVERY_TIMEOUT_DEFAULTS: Readonly<Record<DeliveryTimeoutRoute, number>> = {
  socket: 15,
  'mcp-inbox': 15,
  typed: 15,
  native: 15,
};

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
  // The attempt budget per route: one map, `route=<seconds>` entries separated by commas. It is
  // the TOTAL budget for one attempt at that route — probe, connect, write and any receipt the
  // transport requires — and a low-level capability may only shorten the remaining budget. The
  // post-submit read-receipt window is not part of it (`team send --wait` owns that, and a
  // receipt wait is never shorter than the attempt it follows). `native` is budgeted too: it has
  // no read acknowledgement, but the CLI's enqueue or spawn can hang and the attempt is bounded.
  // A route a word leaves out inherits the budget in force above it, so a level never has to
  // restate the routes it keeps. `deliveryTimeoutInForce` in `src/policy/delivery.ts` reads the
  // resolved value; a level may only shorten each route against the value in force.
  'delivery-timeout': {
    name: 'delivery-timeout',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: formatDeliveryTimeout(DELIVERY_TIMEOUT_DEFAULTS),
    gateLifting: false,
    parseValue: parseDeliveryTimeout,
    valueProblem: deliveryTimeoutProblem,
    inherit: inheritDeliveryTimeout,
    // Every route in the merged value is at or below the value in force for that route.
    isWithin: (lower: string, higher: string) => {
      const lowerBudgets = deliveryTimeoutOf(lower);
      const higherBudgets = deliveryTimeoutOf(higher);
      if (lowerBudgets === null || higherBudgets === null) return false;
      return DELIVERY_TIMEOUT_ROUTES.every((route) => lowerBudgets[route] <= higherBudgets[route]);
    },
  },
  // The one main delay in the fallback path: how long after every live route has failed the
  // durable escalation reaches the entity orchestrator's mailbox. A shorter delay is the tighter
  // one, and the release default is the ceiling, so a longer word is refused before it is signed.
  // The all-live-routes-failed event itself is immediate at 0 and is not in this value. The legacy
  // `event-unreachable-threshold-seconds` stays enforced beside it as a compatibility cap when a
  // level declares it; its release default never lengthens this value.
  // `deliveryEscalationDelay` in `src/policy/delivery.ts` reads both and returns the smaller.
  'delivery-escalation': {
    name: 'delivery-escalation',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: DELIVERY_ESCALATION_SECONDS,
    gateLifting: false,
    parseValue: (raw: unknown) => parseShortenableSeconds(raw, DELIVERY_ESCALATION_SECONDS),
    valueProblem: (raw: unknown) => shortenOnlyProblem('delivery-escalation', raw, DELIVERY_ESCALATION_SECONDS),
    // Shorter or equal delay is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  // How a general seat brief travels: `file` is the signed record in the seat's own drop
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
  // The entity's rule for which models may run on which seats (Policies rule 10):
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
  // The watch's own pace: how often a pass sweeps and how long its six waits run. One value
  // names a preset (`urgent`, `normal`, `relaxed`, `night`, `dormant`), optionally with an
  // explicit final sweep (`night@1800`, or the mapping `{ preset: night, sweepSeconds: 1800 }`).
  // The preset sets the six-wait factor and, when no sweep is named, its nominal sweep; an
  // explicit sweep is final and is never multiplied. A shorter sweep and a smaller wait factor
  // are both tighter, and a lower level must be no looser on either axis. Only explicit ancestor
  // declarations bound it: the release default is not a parent, so a team with no ancestor word
  // may choose any preset. This entry is the name, its aliases and the value rule; the watch
  // reads the effective value itself.
  // How `team grant --client` may be emitted for an entity: `owner-terminal` (the default, and
  // what an absent, unsigned or tampered policy reads as) is the owner at a terminal outside the
  // multiplexer; `conversational` also admits a pending request (`--request`) that runs only with
  // a single-use, short-lived owner approval bound to the request's hash (`--execute`). Entity
  // level only. `owner-terminal` is the tighter word.
  // Which owner-seat signers an entity accepts for an approval, by signer name (for example
  // `[phone, mac]`); no signer type is preferred. Absent, no signer is accepted (fail closed).
  'owner-signers': {
    name: 'owner-signers',
    kind: 'enforced',
    levels: ['entity'],
    defaultValue: null,
    gateLifting: false,
    parseValue: parseOwnerSigners,
    isWithin: (lower: string[] | null, higher: string[] | null) => higher === null || (lower !== null && lower.every((n) => higher.includes(n))),
  },
  // How the accepted signers combine: `any` (one valid assertion from any accepted signer).
  'owner-signer-mode': {
    name: 'owner-signer-mode',
    kind: 'enforced',
    levels: ['entity'],
    defaultValue: 'any',
    gateLifting: false,
    parseValue: (raw: unknown) => (raw === 'any' ? raw : null),
    isWithin: () => true,
  },
  // How long a standing ('always') approval rule lives, in days from its creation: 30 by
  // default, 90 at most. A rule past it stops matching. Entity level; shorter is tighter.
  'approval-rule-ttl': {
    name: 'approval-rule-ttl',
    kind: 'enforced',
    levels: ['entity'],
    defaultValue: 30,
    gateLifting: false,
    parseValue: parseApprovalRuleTtlDays,
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  'grant-emission': {
    name: 'grant-emission',
    kind: 'enforced',
    levels: ['entity'],
    defaultValue: 'owner-terminal',
    gateLifting: false,
    parseValue: (raw: unknown) => (raw === 'owner-terminal' || raw === 'conversational' ? raw : null),
    isWithin: (lower: 'owner-terminal' | 'conversational', higher: 'owner-terminal' | 'conversational') =>
      lower === higher || lower === 'owner-terminal',
  },
  'watch-rhythm': {
    name: 'watch-rhythm',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: 'normal',
    gateLifting: false,
    parseValue: parseWatchRhythmValue,
    valueProblem: watchRhythmProblem,
    isWithin: (lower: string, higher: string) => {
      const low = watchRhythmValueOf(lower);
      const high = watchRhythmValueOf(higher);
      return low !== null
        && high !== null
        && low.sweepSeconds <= high.sweepSeconds
        && WATCH_RHYTHM_FACTOR[low.preset] <= WATCH_RHYTHM_FACTOR[high.preset];
    },
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
