// Kernel amendment 02: the Policy object, its four levels, its two kinds, and the closed
// vocabulary of enforced policies in 0.5.0 (catalogue.md).
//
// A policy is a named rule with a value, set at one level (entity, project, team, seat), by a
// named setter, on a date, with an optional expiry and a kind (enforced or advised). Enforced
// policies come from a closed, release-owned vocabulary; advised policies may be from the
// catalogue or a project's own text.

import { bundlePolicyWithin, formatBundlePolicy, parseBundlePolicy } from '../client/bundle-ops.ts';
import { OWNER_PROOF_MAX_AGE_MS } from '../signing/owner-statement.ts';
import { durationPolicyWithin, formatDurationPolicy, inheritDurationPolicy, parseDurationPolicy } from '../client/duration-policy.ts';
import { DURATION, parseMeasure } from '../file/sections/units.ts';
import { DEFAULT_SIDEBAR_ROWS, SIDEBAR_TOKENS, STATUS_INDICATOR_VALUES } from '../herdr.ts';
import {
  DEFAULT_STATE_THRESHOLDS,
  DELIVERY_LEGS,
  DELIVERY_ORDER,
  isMessagingStore,
  LEGACY_ORDER_WORDS,
  MESSAGING_STORE,
  parseSeatNumberingValue,
  SEAT_NUMBERING_DEFAULT_VALUE,
  SEATS_CROSS_TEAMS,
  STATE_THRESHOLDS,
  SWAP_WAIT_SECONDS,
  type DeliveryLeg,
  type MessagingStore,
} from '../settings/inherit.ts';
import {
  MESSAGE_DISPLAY_DEFAULT,
  messageDisplayValueProblem,
  parseMessageDisplayValue,
} from '../settings/message-display.ts';
import { ownerReplyToValueProblem, parseOwnerReplyToValue } from '../settings/owner-reply.ts';
import { parseSenderLineValue, senderLineValueProblem } from '../settings/sender-line.ts';
import { WEBHOOK_SENDER_DEADLINE_MAX_MS, WEBHOOK_SENDER_DEADLINE_MIN_MS, WEBHOOK_SENDER_DEADLINE_MS } from '../settings/webhook-sender.ts';
import { EVENT_SEGMENT_MB, EVENT_SEGMENT_MB_MAX, EVENT_THRESHOLDS } from './events.ts';
import { formatModelRule, modelRuleProblem, parseModelRule } from './model-rule.ts';
import { parseGrokCommandDeny, type GrokCommandDeny } from '../settings/grok-command-deny.ts';

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
  /** When the owner's device proof for a loosening was made, as an ISO instant. Absent, a
   *  loosening is refused. A proof older than the statement's window is not fresh. */
  proofAt?: string;
};

/** Domain tag for owner-signed policy records (amendment 02 §2.6, §2.12). */
export const POLICY_DOMAIN = 'team-policy-v1\n';

/**
 * The TEN everyday operations whose caller gate `dev-mode` lifts when `on`
 * (`reload` and `rename` were added last, and `peek` after them: the one lift that only reads).
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
  'peek',
] as const;

export type DevModeOperation = (typeof DEV_MODE_OPERATIONS)[number];

/** Canonical names of the closed enforced policy vocabulary in 0.5.0. */
export const ENFORCED_POLICY_NAMES = [
  'dev-mode',
  'lead-gates',
  'seats-cross-teams',
  'state-trace-window-seconds',
  'state-blind-after-seconds',
  'state-hook-working-seconds',
  'liveness-idle-lead-seconds',
  'liveness-idle-owner-seconds',
  'delivery-order',
  'messaging.store',
  'delivery-timeout',
  'delivery-escalation',
  'brief-transport',
  'sender-line',
  'message-display',
  'event-thread-ttl-seconds',
  'event-thread-cap',
  'event-retention-days',
  'event-segment-mb',
  'event-held-threshold-seconds',
  'event-unreachable-threshold-seconds',
  'event-idle-threshold-seconds',
  'event-reconcile-interval-seconds',
  'model-rule',
  'swap-wait-seconds',
  'owner-reply-to',
  'codex-daemon',
  'grok-command-deny',
  'idle-threshold',
  'watch-read-budget-ms',
  'watch-read-timeout-ms',
  'webhook-sender-deadline-ms',
  'daemon.broker',
  'daemon.fallback-backlog-above',
  'daemon.fallback-backlog-limit',
  'daemon.heartbeat',
  'daemon.chores',
  'daemon.chores-slice-ms',
  'daemon.chores-missed-beats',
  'daemon.chores-backoff-cap-ms',
  'workspace.sidebar.rows',
  'workspace.sidebar.manage',
  'workspace.sidebar.status_indicators',
  'daemon.sidebar-ttl-ms',
  'daemon.sidebar-refresh-ms',
  'watch-rhythm',
  'grant-emission',
  'owner-signers',
  'owner-signer-mode',
  'approval-rule-ttl',
  'client-bundles',
  'client-grant-max-duration',
  'actions-commands',
  'seat.dialog.answer',
  'seat-health.watchdog.after',
  'seat-health.watchdog.auto-restart',
  'pretrust',
  'first-run-admission',
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
  'workspace-mode',
  'landing-mode',
  'vault-root',
  'entity-orchestrator',
  'entity.main-orchestrator.relays-owner',
  'leads.pane-actions',
  'leads.self-service',
  'owner.reserved-scope',
  'router.aliases',
  'router.fallback',
  'router.reply-bound',
] as const;

export type AdvisedPolicyName = (typeof ADVISED_POLICY_NAMES)[number];

export type CataloguePolicyName = EnforcedPolicyName | AdvisedPolicyName;

/** Snake-case aliases accepted at load and normalized to their canonical kebab-case policy name. */
export const POLICY_NAME_ALIASES: Readonly<Record<string, CataloguePolicyName>> = {
  dev_mode: 'dev-mode',
  lead_gates: 'lead-gates',
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
  messaging_store: 'messaging.store',
  'messaging-store': 'messaging.store',
  delivery_timeout: 'delivery-timeout',
  delivery_escalation: 'delivery-escalation',
  brief_transport: 'brief-transport',
  sender_line: 'sender-line',
  message_display: 'message-display',
  daemon_broker: 'daemon.broker',
  'daemon-broker': 'daemon.broker',
  daemon_fallback_backlog_above: 'daemon.fallback-backlog-above',
  'daemon-fallback-backlog-above': 'daemon.fallback-backlog-above',
  fallback_backlog_above: 'daemon.fallback-backlog-above',
  'fallback-backlog-above': 'daemon.fallback-backlog-above',
  daemon_fallback_backlog_limit: 'daemon.fallback-backlog-limit',
  'daemon-fallback-backlog-limit': 'daemon.fallback-backlog-limit',
  fallback_backlog_limit: 'daemon.fallback-backlog-limit',
  'fallback-backlog-limit': 'daemon.fallback-backlog-limit',
  daemon_heartbeat: 'daemon.heartbeat',
  'daemon-heartbeat': 'daemon.heartbeat',
  daemon_heartbeat_seconds: 'daemon.heartbeat',
  'daemon-heartbeat-seconds': 'daemon.heartbeat',
  heartbeat_seconds: 'daemon.heartbeat',
  'heartbeat-seconds': 'daemon.heartbeat',
  daemon_chores: 'daemon.chores',
  'daemon-chores': 'daemon.chores',
  chores: 'daemon.chores',
  daemon_chores_slice_ms: 'daemon.chores-slice-ms',
  'daemon-chores-slice-ms': 'daemon.chores-slice-ms',
  chores_slice_ms: 'daemon.chores-slice-ms',
  'chores-slice-ms': 'daemon.chores-slice-ms',
  daemon_chores_missed_beats: 'daemon.chores-missed-beats',
  'daemon-chores-missed-beats': 'daemon.chores-missed-beats',
  chores_missed_beats: 'daemon.chores-missed-beats',
  'chores-missed-beats': 'daemon.chores-missed-beats',
  daemon_chores_backoff_cap_ms: 'daemon.chores-backoff-cap-ms',
  'daemon-chores-backoff-cap-ms': 'daemon.chores-backoff-cap-ms',
  chores_backoff_cap_ms: 'daemon.chores-backoff-cap-ms',
  'chores-backoff-cap-ms': 'daemon.chores-backoff-cap-ms',
  workspace_sidebar_rows: 'workspace.sidebar.rows',
  'workspace-sidebar-rows': 'workspace.sidebar.rows',
  sidebar_rows: 'workspace.sidebar.rows',
  'sidebar-rows': 'workspace.sidebar.rows',
  workspace_sidebar_manage: 'workspace.sidebar.manage',
  'workspace-sidebar-manage': 'workspace.sidebar.manage',
  sidebar_manage: 'workspace.sidebar.manage',
  'sidebar-manage': 'workspace.sidebar.manage',
  workspace_sidebar_status_indicators: 'workspace.sidebar.status_indicators',
  'workspace-sidebar-status-indicators': 'workspace.sidebar.status_indicators',
  sidebar_status_indicators: 'workspace.sidebar.status_indicators',
  'sidebar-status-indicators': 'workspace.sidebar.status_indicators',
  daemon_sidebar_ttl_ms: 'daemon.sidebar-ttl-ms',
  'daemon-sidebar-ttl-ms': 'daemon.sidebar-ttl-ms',
  sidebar_ttl_ms: 'daemon.sidebar-ttl-ms',
  'sidebar-ttl-ms': 'daemon.sidebar-ttl-ms',
  daemon_sidebar_refresh_ms: 'daemon.sidebar-refresh-ms',
  'daemon-sidebar-refresh-ms': 'daemon.sidebar-refresh-ms',
  sidebar_refresh_ms: 'daemon.sidebar-refresh-ms',
  'sidebar-refresh-ms': 'daemon.sidebar-refresh-ms',
  development_mode: 'development-mode',
  shared_checkout_hygiene: 'shared-checkout-hygiene',
  seat_numbering: 'seat-numbering',
  pane_conduct: 'pane-conduct',
  review_terms: 'review-terms',
  workspace_mode: 'workspace-mode',
  landing_mode: 'landing-mode',
  vault_root: 'vault-root',
  entity_orchestrator: 'entity-orchestrator',
  'chain.topology.entity.orchestrator': 'entity-orchestrator',
  // The lead rules the owner decided on 2026-11-03, in the spellings a team
  // writes them and the kebab-case canonical names of this catalogue.
  entity_main_orchestrator_relays_owner: 'entity.main-orchestrator.relays-owner',
  'entity.main_orchestrator.relays_owner': 'entity.main-orchestrator.relays-owner',
  'entity.main-orchestrator.relays_owner': 'entity.main-orchestrator.relays-owner',
  'entity.main_orchestrator.relays-owner': 'entity.main-orchestrator.relays-owner',
  leads_pane_actions: 'leads.pane-actions',
  'leads.pane_actions': 'leads.pane-actions',
  leads_self_service: 'leads.self-service',
  'leads.self_service': 'leads.self-service',
  'lead-self-service': 'leads.self-service',
  owner_reserved_scope: 'owner.reserved-scope',
  'owner.reserved_scope': 'owner.reserved-scope',
  'owner-reserved-scope': 'owner.reserved-scope',
  router_aliases: 'router.aliases',
  'router-aliases': 'router.aliases',
  router_fallback: 'router.fallback',
  'router-fallback': 'router.fallback',
  router_reply_bound: 'router.reply-bound',
  'router-reply-bound': 'router.reply-bound',
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
  'bus.retain_days': 'event-retention-days',
  'bus.retain-days': 'event-retention-days',
  bus_retain_days: 'event-retention-days',
  event_segment_mb: 'event-segment-mb',
  segment_mb: 'event-segment-mb',
  'segment-mb': 'event-segment-mb',
  'bus.segment_mb': 'event-segment-mb',
  'bus.segment-mb': 'event-segment-mb',
  bus_segment_mb: 'event-segment-mb',
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
  grok_command_deny: 'grok-command-deny',
  idle_threshold: 'idle-threshold',
  watch_read_budget_ms: 'watch-read-budget-ms',
  'watch-read-budget': 'watch-read-budget-ms',
  read_budget_ms: 'watch-read-budget-ms',
  'read-budget': 'watch-read-budget-ms',
  watch_read_timeout_ms: 'watch-read-timeout-ms',
  'watch-read-timeout': 'watch-read-timeout-ms',
  read_timeout_ms: 'watch-read-timeout-ms',
  'read-timeout': 'watch-read-timeout-ms',
  webhook_sender_deadline_ms: 'webhook-sender-deadline-ms',
  webhook_sender_deadline: 'webhook-sender-deadline-ms',
  watch_rhythm: 'watch-rhythm',
  grant_emission: 'grant-emission',
  owner_signers: 'owner-signers',
  owner_signer_mode: 'owner-signer-mode',
  approval_rule_ttl: 'approval-rule-ttl',
  client_bundles: 'client-bundles',
  client_grant_max_duration: 'client-grant-max-duration',
  actions_commands: 'actions-commands',
  'seat-dialog-answer': 'seat.dialog.answer',
  seat_dialog_answer: 'seat.dialog.answer',
  'seat-health.watchdog.auto_restart': 'seat-health.watchdog.auto-restart',
  first_run_admission: 'first-run-admission',
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
   * True when a `parseValue` result that is an empty array means the declaration names nothing:
   * the resolver skips it like an expired one — never refused, never set aside — and the word in
   * force stands. Only `delivery-order` sets it: a word whose every name is retired (`mcp-inbox`,
   * read as an alias and dropped by `parseDeliveryOrder`) declares nothing, and a signed record
   * an older build wrote still reads.
   */
  emptyWordDeclaresNothing?: boolean;
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
  /** A fresh owner proof on this declaration may loosen what the level above set. Absent,
   *  a loosening is refused at load. */
  proofAllowsLoosening?: (declaration: Policy, now: Date) => boolean;
};

function parseOnOff(raw: unknown): 'on' | 'off' | null {
  if (raw === 'on' || raw === true) return 'on';
  if (raw === 'off' || raw === false) return 'off';
  return null;
}

/** `lead-gates`: which placed roles dev mode admits to the owner-only gates. */
export type LeadGatesValue = 'lead' | 'lead+operator';

/** `lead-gates` accepts exactly its two words; anything else is a load refusal. */
function parseLeadGates(raw: unknown): LeadGatesValue | null {
  return raw === 'lead' || raw === 'lead+operator' ? raw : null;
}

/** The Actions commands a caller may leave in the guard's allowlist. The release default is all
 *  three: Floor's values, with no seat named. A lower level may only drop commands. */
export const ACTIONS_COMMANDS = ['rerun-failed', 'deploy', 'ci-pr-head'] as const;

export type ActionsCommand = (typeof ACTIONS_COMMANDS)[number];

export const ACTIONS_COMMANDS_DEFAULT: readonly ActionsCommand[] = ACTIONS_COMMANDS;

function parseActionsCommands(raw: unknown): ActionsCommand[] | null {
  const items = typeof raw === 'string'
    ? raw.split(',').map((item) => item.trim()).filter((item) => item !== '')
    : raw;
  if (!Array.isArray(items)) return null;
  const out: ActionsCommand[] = [];
  for (const name of ACTIONS_COMMANDS) {
    if (items.includes(name)) out.push(name);
  }
  if (out.length !== items.length || new Set(items).size !== items.length) return null;
  return out;
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

/**
 * One of the watch's read limits: a whole number of milliseconds from 100 to 30000, so a busy
 * loop can bound a pass without letting a level switch the bound off.
 */
function parseReadMillis(raw: unknown): number | null {
  const n = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 30_000 ? n : null;
}

function readMillisProblem(name: string, raw: unknown): string | null {
  if (parseReadMillis(raw) !== null) return null;
  return `policy "${name}" needs a whole number of milliseconds from 100 to 30000, such as 2000`;
}

/** One send's own webhook answer bound: a whole number of milliseconds from 500 to 10000. */
function parseWebhookSenderDeadline(raw: unknown): number | null {
  const n = typeof raw === 'string' && /^[0-9]+$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n >= WEBHOOK_SENDER_DEADLINE_MIN_MS && n <= WEBHOOK_SENDER_DEADLINE_MAX_MS
    ? n
    : null;
}

function webhookSenderDeadlineProblem(name: string, raw: unknown): string | null {
  if (parseWebhookSenderDeadline(raw) !== null) return null;
  return `policy "${name}" needs a whole number of milliseconds from ${String(WEBHOOK_SENDER_DEADLINE_MIN_MS)} to ${String(WEBHOOK_SENDER_DEADLINE_MAX_MS)}, such as ${String(WEBHOOK_SENDER_DEADLINE_MS)}`;
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
 * `event-retention-days`: a whole positive count, or the explicit keep-all words. Keep-all is
 * `0` — the number or the string "0" — and the bare word `all`; it means no age-based drop. The
 * widening lives here, not in `parsePositiveCount`, because every other count policy still
 * refuses zero: a zero-cap thread or a zero-second delay has no meaning, while a zero-day window
 * does. Absence is not keep-all: an unset policy resolves to its fallback, still 30 days.
 */
function parseRetentionDays(raw: unknown): number | null {
  if (raw === 0) return 0;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '0' || text === 'all') return 0;
  }
  return parsePositiveCount(raw);
}

function retentionDaysProblem(name: string, raw: unknown): string | null {
  if (parseRetentionDays(raw) !== null) return null;
  return `policy "${name}" needs a whole number of days above 0, or the keep-all words 0 and all`;
}

/**
 * `event-segment-mb`: a whole number of megabytes from 1 to half the retained-size cap. Above
 * the ceiling a full live segment and its predecessor could not both fit under the cap, and the
 * store would drop every segment it sealed.
 */
function parseSegmentMb(raw: unknown): number | null {
  const n = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= EVENT_SEGMENT_MB_MAX ? n : null;
}

function segmentMbProblem(name: string, raw: unknown): string | null {
  if (parseSegmentMb(raw) !== null) return null;
  return `policy "${name}" needs a whole number of megabytes from 1 to ${String(EVENT_SEGMENT_MB_MAX)}, such as ${String(EVENT_SEGMENT_MB)}`;
}

/**
 * The retention policy's order: fewer days kept is the tighter word, and keep-all (0) is looser
 * than every positive count, because it gives up the age bound entirely. A lower level may
 * narrow a window but may not widen one to keep-all.
 */
function retentionDaysWithin(lower: number, higher: number): boolean {
  const rank = (value: number): number => (value === 0 ? Number.POSITIVE_INFINITY : value);
  return rank(lower) <= rank(higher);
}

/** One daemon store backlog knob's accepted range, and the release default its message offers. */
type BacklogRange = { min: number; max: number; release: number };

/** A backlog knob's word: a whole count, written with digits, inside its own range. */
function parseBacklogCount(raw: unknown, range: BacklogRange): number | null {
  const n = typeof raw === 'string' && /^[0-9]+$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n >= range.min && n <= range.max ? n : null;
}

function backlogCountProblem(name: string, raw: unknown, range: BacklogRange): string | null {
  if (parseBacklogCount(raw, range) !== null) return null;
  return `policy "${name}" needs a whole number from ${String(range.min)} to ${String(range.max)}, such as ${String(range.release)}`;
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

/** `owner.reserved-scope`: a list of what the owner reserves, or one `;`/`,`-separated word. */
function parseScopeItems(raw: unknown): readonly string[] | null {
  const items = typeof raw === 'string' ? raw.split(/[;,]/).map((part) => part.trim()) : raw;
  if (!Array.isArray(items) || items.length === 0) return null;
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') return null;
    const text = item.trim().replace(/\s+/g, ' ');
    if (text === '' || /[\x00-\x1f\x7f]/.test(text)) return null;
    if (!out.includes(text)) out.push(text);
  }
  return out;
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
  const seen: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') return null;
    const known = (DELIVERY_LEGS as readonly string[]).includes(item)
      || (LEGACY_ORDER_WORDS as readonly string[]).includes(item);
    // A duplicate is judged before the retired name is dropped: [mcp-inbox, mcp-inbox] was
    // invalid for every build that knew the word, and a duplicated alias is as invalid as a
    // duplicated live leg. A word this build knows nothing else about refuses the same way.
    if (!known || seen.includes(item)) return null;
    seen.push(item);
    // A retired name is dropped, never refused: the chain reads it as an alias, and the level
    // it came from keeps the legs it names.
    if ((LEGACY_ORDER_WORDS as readonly string[]).includes(item)) continue;
    out.push(item as DeliveryLeg);
  }
  return out;
}

/** True when a raw delivery-order word names a retired alias word anywhere — alone or beside
 *  live legs. New writes refuse such a word with the leg's own reason (`src/policy/sources.ts`);
 *  a stored record still reads, and `parseDeliveryOrder` drops the name. */
export function namesRetiredOrderWord(raw: unknown): boolean {
  const items = rawDeliveryItems(raw);
  return items !== null && items.some((item) => typeof item === 'string' && (LEGACY_ORDER_WORDS as readonly string[]).includes(item));
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

// ---- The mailbox router's three words (the mailbox-router design of 2026-11-03) -----------------------
//
// `router.aliases` places each alias at a `seat@team` address; `router.fallback` places where an
// alias's ask goes on a definite miss (`none` clears it); `router.reply-bound` bounds the wait for
// a verified reply. The words carry the map; the router child's own mechanics — the definite-miss
// rule and the bridge's synchronous 120 s cap — are constants of the child, never values here.
// `readMailboxRouterPolicy` in `src/policy/router.ts` reads them back into the shape the child
// consumes and refuses a word that broke its rules at load, with a named error.

/** The release's router alias map: empty. A fresh install ships no alias; the entity or team
 *  policy record places every word, and only those levels may move one. */
export const ROUTER_ALIAS_DEFAULTS: Readonly<Record<string, string>> = {};

/** The release's fallback map: empty, for the same reason. Only the entity level may move a
 *  fallback the entity placed. */
export const ROUTER_FALLBACK_DEFAULTS: Readonly<Record<string, string>> = {};

/** A `seat@team` address: one `@`, a name each side of it. */
export function parseSeatTeamAddress(text: string): { seat: string; team: string } | null {
  const at = text.indexOf('@');
  if (at <= 0 || at !== text.lastIndexOf('@')) return null;
  const seat = text.slice(0, at).trim();
  const team = text.slice(at + 1).trim();
  if (seat === '' || team === '') return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(seat) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(team)) return null;
  return { seat, team };
}

/** One map word's entries, in the order the word names them. */
function routerMapItems(raw: unknown): unknown[] | null {
  if (typeof raw === 'string') return raw.split(',');
  if (Array.isArray(raw)) return raw;
  return null;
}

const ROUTER_ALIAS_SHAPE = /^[a-z][a-z0-9-]*$/;

/** The aliases a `router.aliases` word places, or null when an entry is not one this surface admits. */
export function parseRouterAliases(raw: unknown): Map<string, string> | null {
  const items = routerMapItems(raw);
  if (!items || items.length === 0) return null;
  const entries = new Map<string, string>();
  for (const item of items) {
    if (typeof item !== 'string') return null;
    const eq = item.indexOf('=');
    if (eq < 0) return null;
    const alias = item.slice(0, eq).trim();
    const address = item.slice(eq + 1).trim();
    if (!ROUTER_ALIAS_SHAPE.test(alias)) return null;
    if (entries.has(alias)) return null;
    if (address === '') return null;
    const parsed = parseSeatTeamAddress(address);
    if (parsed === null || parsed.seat === 'desk') return null;
    entries.set(alias, address);
  }
  return entries;
}

/** The fallbacks a `router.fallback` word sets (`alias=seat@team`, `alias=none` to clear), or null. */
export function parseRouterFallback(raw: unknown): Map<string, string | null> | null {
  const items = routerMapItems(raw);
  if (!items || items.length === 0) return null;
  const entries = new Map<string, string | null>();
  for (const item of items) {
    if (typeof item !== 'string') return null;
    const eq = item.indexOf('=');
    if (eq < 0) return null;
    const alias = item.slice(0, eq).trim();
    const address = item.slice(eq + 1).trim();
    if (!ROUTER_ALIAS_SHAPE.test(alias)) return null;
    if (entries.has(alias)) return null;
    if (address === 'none') {
      entries.set(alias, null);
      continue;
    }
    const parsed = address === '' ? null : parseSeatTeamAddress(address);
    if (parsed === null || parsed.seat === 'desk') return null;
    entries.set(alias, address);
  }
  return entries;
}

function formatRouterAliases(entries: ReadonlyMap<string, string>): string {
  return [...entries].map(([alias, address]) => `${alias}=${address}`).join(',');
}

function formatRouterFallback(entries: ReadonlyMap<string, string | null>): string {
  return [...entries].map(([alias, address]) => `${alias}=${address ?? 'none'}`).join(',');
}

const ROUTER_ALIAS_DEFAULT_VALUE = formatRouterAliases(new Map(Object.entries(ROUTER_ALIAS_DEFAULTS)));
const ROUTER_FALLBACK_DEFAULT_VALUE = formatRouterFallback(new Map(Object.entries(ROUTER_FALLBACK_DEFAULTS)));

/** A word keeps every key the value in force above it already places, so a word names only what it
 *  moves; the value in force after the merge is always the complete map. */
function inheritRouterAliases(higher: string, lower: string): string {
  const merged = new Map<string, string>(Object.entries(ROUTER_ALIAS_DEFAULTS));
  for (const source of [higher, lower]) {
    const entries = parseRouterAliases(source);
    if (entries === null) continue;
    for (const [alias, address] of entries) merged.set(alias, address);
  }
  return formatRouterAliases(merged);
}

function inheritRouterFallback(higher: string, lower: string): string {
  const merged = new Map<string, string | null>(Object.entries(ROUTER_FALLBACK_DEFAULTS));
  for (const source of [higher, lower]) {
    const entries = parseRouterFallback(source);
    if (entries === null) continue;
    for (const [alias, address] of entries) merged.set(alias, address);
  }
  return formatRouterFallback(merged);
}

/** Every alias the higher value places keeps the address the lower value finds there. */
function routerAliasesWithin(lower: string, higher: string): boolean {
  const lowerMap = parseRouterAliases(lower);
  const higherMap = parseRouterAliases(higher);
  if (lowerMap === null || higherMap === null) return false;
  for (const [alias, address] of higherMap) {
    if (lowerMap.get(alias) !== address) return false;
  }
  return true;
}

function routerFallbackWithin(lower: string, higher: string): boolean {
  const lowerMap = parseRouterFallback(lower);
  const higherMap = parseRouterFallback(higher);
  if (lowerMap === null || higherMap === null) return false;
  for (const [alias, fallback] of higherMap) {
    if (lowerMap.get(alias) !== fallback) return false;
  }
  return true;
}

export function routerAliasesProblem(raw: unknown): string | null {
  const items = routerMapItems(raw) ?? [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') return null;
    const text = item.trim();
    const eq = text.indexOf('=');
    const alias = (eq < 0 ? text : text.slice(0, eq).trim()).trim();
    if (!ROUTER_ALIAS_SHAPE.test(alias)) continue;
    if (seen.has(alias)) return `router alias "${alias}" is named twice in one word`;
    seen.add(alias);
    if (eq < 0) return `router alias "${alias}" has no address`;
    const address = text.slice(eq + 1).trim();
    if (address === '') return `router alias "${alias}" has no address`;
    const parsed = parseSeatTeamAddress(address);
    if (parsed !== null && parsed.seat === 'desk') {
      return `router alias "${alias}" targets the desk seat, which no alias may name`;
    }
    if (parsed === null) return `router alias "${alias}" names "${address}", which is not a seat@team address`;
  }
  return null;
}

export function routerFallbackProblem(raw: unknown): string | null {
  const items = routerMapItems(raw) ?? [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') return null;
    const text = item.trim();
    const eq = text.indexOf('=');
    const alias = (eq < 0 ? text : text.slice(0, eq).trim()).trim();
    if (!ROUTER_ALIAS_SHAPE.test(alias)) continue;
    if (seen.has(alias)) return `router fallback for "${alias}" is named twice in one word`;
    seen.add(alias);
    if (eq < 0) return `router fallback for "${alias}" has no address`;
    const address = text.slice(eq + 1).trim();
    if (address === '') return `router fallback for "${alias}" has no address`;
    if (address === alias) return `router fallback for "${alias}" names the alias itself`;
    if (address === 'none') continue;
    const parsed = parseSeatTeamAddress(address);
    if (parsed !== null && parsed.seat === 'desk') {
      return `router fallback for "${alias}" targets the desk seat, which no alias may name`;
    }
    if (parsed === null) {
      return `router fallback for "${alias}" names "${address}", which is not a seat@team address`;
    }
  }
  return null;
}

/** `router.reply-bound`: whole seconds from 1 to 86400, written bare or with an `s`. */
export function parseRouterReplyBound(raw: unknown): number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  const match = /^([1-9][0-9]{0,4})s?$/.exec(text);
  if (!match) return null;
  const seconds = Number.parseInt(match[1]!, 10);
  return seconds >= 1 && seconds <= 86_400 ? seconds : null;
}

/**
 * The daemon's two fallback-store backlog knobs: the finished-episode count above which one pass
 * drains a backlog, and how many it then takes. Both are bounded so one pass stays a bounded
 * amount of work, never a whole history: the threshold ranges to a million episodes and the bulk
 * limit to ten thousand, the same order as the steady limit's multiples. The release defaults
 * are shared with the daemon's reader so the catalogue and the sweep cannot drift apart.
 */
export const DAEMON_BACKLOG_DEFAULTS = { above: 256, limit: 500 } as const;

/** The machine daemon's loop heartbeat, in whole seconds: the release default and the bounds a
 *  level's word may choose between. The default is the beat the daemon ran hard-coded before the
 *  word existed (ADR D6, the message path). */
export const DAEMON_HEARTBEAT_SECONDS = { min: 1, max: 60, release: 5 } as const;

/** The heartbeat word: a whole number of seconds from 1 to 60, optionally with the `s` suffix
 *  every seconds policy takes. */
function parseHeartbeatSeconds(raw: unknown): number | null {
  const n = typeof raw === 'string' && /^[1-9][0-9]*s?$/.test(raw.trim())
    ? Number.parseInt(raw.trim().replace(/s$/, ''), 10)
    : raw;
  return typeof n === 'number' && Number.isInteger(n) && n >= DAEMON_HEARTBEAT_SECONDS.min && n <= DAEMON_HEARTBEAT_SECONDS.max ? n : null;
}

function heartbeatSecondsProblem(name: string, raw: unknown): string | null {
  if (parseHeartbeatSeconds(raw) !== null) return null;
  return `policy "${name}" needs a whole number of seconds from ${String(DAEMON_HEARTBEAT_SECONDS.min)} to ${String(DAEMON_HEARTBEAT_SECONDS.max)}, such as 5`;
}

/**
 * The machine daemon's chore isolation: where the heavy per-root chores run, and the limits that
 * bound one child. `per-root`, the default, gives every hosted root its own supervised child, so
 * one root's work never shares a process with another's; `shared` runs one child for every root
 * whose word is `shared` and gives each root its own FIFO and one slice per turn, so one root's
 * backlog can delay another root's chores by a slice but never its socket; `inline` runs them
 * on the daemon's own loop exactly as before the isolation, which is the rollback. The limits
 * default to the values the isolation landed with.
 */
export const DAEMON_CHORES_MODES = ['inline', 'shared', 'per-root'] as const;
export type DaemonChoresMode = (typeof DAEMON_CHORES_MODES)[number];
export const DAEMON_CHORES_DEFAULTS = {
  mode: 'per-root' as DaemonChoresMode,
  sliceMs: 20,
  missedBeats: 2,
  backoffCapMs: 30_000,
} as const;

const BACKLOG_ABOVE_RANGE: BacklogRange = { min: 1, max: 1_000_000, release: DAEMON_BACKLOG_DEFAULTS.above };
const BACKLOG_LIMIT_RANGE: BacklogRange = { min: 1, max: 10_000, release: DAEMON_BACKLOG_DEFAULTS.limit };

/** How a chores mode ranks for inheritance: a lower level may choose less isolation, never more. */
const CHORE_MODE_RANK: Readonly<Record<DaemonChoresMode, number>> = { inline: 0, shared: 1, 'per-root': 2 };

function parseChoreMode(raw: unknown): DaemonChoresMode | null {
  return raw === 'inline' || raw === 'shared' || raw === 'per-root' ? raw : null;
}

function choreModeProblem(name: string, raw: unknown): string | null {
  if (parseChoreMode(raw) !== null) return null;
  return `policy "${name}" needs one of inline, shared or per-root`;
}

/** Whole milliseconds from 10 to 30000: how long one slice of a chores child's pass may run before yielding. */
function parseChoreSliceMs(raw: unknown): number | null {
  const n = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n >= 10 && n <= 30_000 ? n : null;
}

function choreSliceMsProblem(name: string, raw: unknown): string | null {
  if (parseChoreSliceMs(raw) !== null) return null;
  return `policy "${name}" needs a whole number of milliseconds from 10 to 30000, such as 20`;
}

/** Whole beats from 1 to 60: how many missed child heartbeats end the child and restart it. */
function parseMissedBeats(raw: unknown): number | null {
  const n = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 60 ? n : null;
}

/** Whole milliseconds from 1000 to 600000: the cap on a chores child's restart backoff. */
function parseBackoffCapMs(raw: unknown): number | null {
  const n = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1_000 && n <= 600_000 ? n : null;
}

function missedBeatsProblem(name: string, raw: unknown): string | null {
  if (parseMissedBeats(raw) !== null) return null;
  return `policy "${name}" needs a whole number of beats from 1 to 60`;
}

function backoffCapProblem(name: string, raw: unknown): string | null {
  if (parseBackoffCapMs(raw) !== null) return null;
  return `policy "${name}" needs a whole number of milliseconds from 1000 to 600000, such as 30000`;
}

// ---- The sidebar words (the sidebar-metadata design of 2026-11-04) -------------------------------------
//
// Five enforced words carry what the 0.5.13 sidebar work reads: the rows layout of the terminal
// host's sidebar, whether team may touch the host's config at all, which status indicator the
// host draws, how long a pane's reported metadata lives, and how often it is re-reported. The
// token and indicator vocabularies are the adapter's (`src/herdr.ts`), because the host is what
// refuses a word it does not know; the reader that consumes the resolved chain is
// `sidebarPolicy` in `src/settings/sidebar-policy.ts`.

/** The rows layout as one canonical word: rows separated by `;`, a row's tokens by `,` —
 *  `state_icon,machine,workspace,tab;state_text,agent`. At load the YAML natural form (a list
 *  of token lists) and a list of row strings read the same way. */
export function sidebarRowsWord(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => [...row].join(',')).join(';');
}

const SIDEBAR_ROWS_DEFAULT_VALUE = sidebarRowsWord(DEFAULT_SIDEBAR_ROWS);

function parseSidebarRowsValue(raw: unknown): string | null {
  const rowsRaw: unknown[] = [];
  if (typeof raw === 'string') {
    rowsRaw.push(...raw.split(';'));
  } else if (Array.isArray(raw)) {
    rowsRaw.push(...raw);
  } else {
    return null;
  }
  if (rowsRaw.length === 0) return null;
  const rows: string[] = [];
  for (const row of rowsRaw) {
    const tokens = typeof row === 'string' ? row.split(',') : Array.isArray(row) ? row : null;
    if (tokens === null) return null;
    const clean = tokens.map((token) => (typeof token === 'string' ? token.trim() : ''));
    if (clean.some((token) => token === '')) return null;
    if (clean.some((token) => !(SIDEBAR_TOKENS as readonly string[]).includes(token))) return null;
    if (new Set(clean).size !== clean.length) return null;
    rows.push(clean.join(','));
  }
  return rows.join(';');
}

/** A canonical rows word as its rows, or null for a word this build cannot read. */
export function sidebarRowsOf(value: unknown): readonly (readonly string[])[] | null {
  if (typeof value !== 'string') return null;
  const canonical = parseSidebarRowsValue(value);
  return canonical === null ? null : canonical.split(';').map((row) => row.split(','));
}

function sidebarRowsProblem(raw: unknown): string | null {
  const items: unknown[] = typeof raw === 'string'
    ? raw.split(';')
    : Array.isArray(raw) ? raw : [];
  for (const row of items) {
    const tokens = typeof row === 'string' ? row.split(',') : Array.isArray(row) ? row : [];
    for (const token of tokens) {
      if (typeof token === 'string' && token.trim() !== '' && !(SIDEBAR_TOKENS as readonly string[]).includes(token.trim())) {
        return `policy "workspace.sidebar.rows" has no sidebar token "${token.trim()}": expected ${SIDEBAR_TOKENS.join(', ')}`;
      }
    }
  }
  return null;
}

/** The status indicator the host draws: the closed vocabulary `config check` enforces on the
 *  host's own `[ui] status_indicators` key (`dots` or `symbols`, probed 2026-11-04). */
function parseSidebarIndicators(raw: unknown): string | null {
  return typeof raw === 'string' && (STATUS_INDICATOR_VALUES as readonly string[]).includes(raw.trim())
    ? raw.trim()
    : null;
}

function sidebarIndicatorsProblem(raw: unknown): string | null {
  if (parseSidebarIndicators(raw) !== null) return null;
  return `policy "workspace.sidebar.status_indicators" needs one of ${STATUS_INDICATOR_VALUES.join(' or ')}, such as symbols`;
}

/** Whole milliseconds from 1000 up (`daemon.sidebar-ttl-ms`): no ceiling is enforced here — the
 *  host caps what it is sent at its own 86400000, and the reader clamps to that cap rather than
 *  refusing a stored word a future host might accept. */
const SIDEBAR_TTL_MS_DEFAULT = 86_400_000;

function parseSidebarMillis(raw: unknown): number | null {
  const n = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1000 ? n : null;
}

function sidebarMillisProblem(name: string, raw: unknown): string | null {
  if (parseSidebarMillis(raw) !== null) return null;
  return `policy "${name}" needs a whole number of milliseconds from 1000 up, such as 86400000`;
}

/** The refresh interval's own bounds: whole milliseconds from one minute to seven days
 *  (`daemon.sidebar-refresh-ms`), 6 h when nothing declares it. */
const SIDEBAR_REFRESH_MS = { min: 60_000, max: 604_800_000, release: 21_600_000 } as const;

function parseSidebarRefreshMs(raw: unknown): number | null {
  const n = parseSidebarMillis(raw);
  return n !== null && n >= SIDEBAR_REFRESH_MS.min && n <= SIDEBAR_REFRESH_MS.max ? n : null;
}

function sidebarRefreshProblem(raw: unknown): string | null {
  if (parseSidebarRefreshMs(raw) !== null) return null;
  return `policy "daemon.sidebar-refresh-ms" needs a whole number of milliseconds from ${String(SIDEBAR_REFRESH_MS.min)} to ${String(SIDEBAR_REFRESH_MS.max)}, such as ${String(SIDEBAR_REFRESH_MS.release)}`;
}

/**
 * Catalogue of policies known to TeamCLI 0.5.0 (amendment 02 `catalogue.md`), with defaults
 * sourced directly from `src/settings/inherit.ts`.
 */
/**
 * The owner's reserved scope, in four words: public releases, spending,
 * credentials, and the owner's machine. The machine's gloss names what it covers, so a rule
 * that prints the list never leaves "the machine" to be read as "any act on it": it is the
 * system's own settings and accounts, logins, keychain and hardware, never a checkout, a seat
 * or the team's config.
 */
export const OWNER_RESERVED_SCOPE_DEFAULT = [
  'public releases',
  'spending',
  'credentials',
  "the owner's machine",
] as const;

/** How durable a `messaging.store` word is: the lower the rank, the more the send keeps. A word
 *  is within another when it is at least as durable, so tightening runs toward `first`. */
const STORE_DURABILITY: Readonly<Record<MessagingStore, number>> = { first: 0, parallel: 1, none: 2 };

/** Release default: answer none of trust, permission, and login. Login is never a value. */
export const DIALOG_ANSWER_DEFAULT: readonly string[] = [];

/** How long a still screen waits before one restart. Fifteen minutes, in seconds. */
export const WATCHDOG_AFTER_SECONDS = 900;

/** One automatic restart. Zero tells the lead and starts nothing. */
export const WATCHDOG_AUTO_RESTART_MAX = 1;

const DIALOG_TRUST = /^trust:(.+)$/;
const DIALOG_PERMISSION = /^permission:(.+)$/;

/** `seat.dialog.answer`: trust folders and allowlisted commands. Login is never named. */
export function parseDialogAnswer(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) return null;
  const tokens: string[] = [];
  for (const item of raw) {
    const trust = DIALOG_TRUST.exec(item);
    const permission = DIALOG_PERMISSION.exec(item);
    if (trust !== null) {
      if (trust[1] === '') return null;
      tokens.push(`trust:${trust[1]}`);
      continue;
    }
    if (permission !== null) {
      if (!(ACTIONS_COMMANDS as readonly string[]).includes(permission[1]!)) return null;
      tokens.push(`permission:${permission[1]}`);
      continue;
    }
    return null;
  }
  return [...new Set(tokens)];
}

export function dialogAnswerProblem(raw: unknown): string | null {
  if (parseDialogAnswer(raw) !== null) return null;
  return 'policy "seat.dialog.answer" lists trust:<folder> and permission:<command> from the command guard; login is never, and no other class is a value';
}

/** A declaration loosens only with a fresh owner proof. */
export function dialogProofAllows(declaration: Policy, now: Date): boolean {
  if (declaration.proofAt === undefined) return false;
  const at = Date.parse(declaration.proofAt);
  if (!Number.isFinite(at)) return false;
  const age = now.getTime() - at;
  return age >= 0 && age <= OWNER_PROOF_MAX_AGE_MS;
}

function parseWatchdogAfter(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

function parseWatchdogAuto(raw: unknown): number | null {
  return raw === 0 || raw === 1 ? raw : null;
}

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
  'lead-gates': {
    name: 'lead-gates',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: 'lead',
    gateLifting: true,
    parseValue: parseLeadGates,
    // `lead` is within anything: it admits no operator, so no stricter reading can loosen it.
    // `lead+operator` is only within `lead+operator`: a nearer level cannot widen the gates past
    // a farther level that kept them the lead's.
    isWithin: (lower: LeadGatesValue, higher: LeadGatesValue) => lower === 'lead' || lower === higher,
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
    emptyWordDeclaresNothing: true,
    // Dropping or reordering channels present in `higher` is within. `native`, `socket`,
    // `headless-resume` and `session` are the legs a word may add: none is in the fallback order,
    // and a level that names one is the sender choosing that channel — its own SendMessage, this
    // build's frame on the receiver's socket, a headless runtime's own turn, or the receiving
    // CLI's own session call, which no default order ever inserts. The retired `mcp-inbox` name
    // never reaches this test: it is dropped from the word before the word is judged
    // (`parseDeliveryOrder` above), so it can neither add a leg nor widen a level's order.
    // Every other leg absent from `higher` is still an
    // addition, and the whole word is set aside.
    isWithin: (lower: readonly DeliveryLeg[], higher: readonly DeliveryLeg[]) =>
      lower.length > 0
      && lower.every((leg, idx) => (leg === 'native' || leg === 'socket' || leg === 'headless-resume' || leg === 'session' || higher.includes(leg)) && lower.indexOf(leg) === idx),
  },
  // The store a send leaves behind for the receiving seat (`messaging.store` in a team file,
  // ADR D8). `first` writes the signed record into the recipient's folder before the walk wakes
  // it; `parallel` starts the write and the first wake together and ends the send only when both
  // settle; `none` never stores the record, and the frame carries the same signed bytes so the
  // receiver verifies them as today. Durability is the safe side: first is tighter than
  // parallel, parallel tighter than none, and a level moves a seat toward first freely; moving
  // toward none is the loosening the setting's own levels list decides (`MESSAGING_STORE`).
  'messaging.store': {
    name: 'messaging.store',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    looseningLevels: MESSAGING_STORE.looseningLevels as readonly PolicyLevel[],
    defaultValue: MESSAGING_STORE.fallback,
    gateLifting: false,
    parseValue: (raw: unknown) => (isMessagingStore(raw) ? raw : null),
    isWithin: (lower: MessagingStore, higher: MessagingStore) => STORE_DURABILITY[lower] <= STORE_DURABILITY[higher],
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
  // The header a message wake opens with: the sender, the address and a short summary. The
  // template is display only — the signed record is what a seat reads. It is set at entity or
  // team (no project or seat level), holds only the fixed slots, and is refused at save with an
  // unknown slot named. The read hint is appended by the caller and the template cannot remove
  // it; the socket frame's reply line is outside the template too.
  'message-display': {
    name: 'message-display',
    kind: 'enforced',
    levels: ['entity', 'team'],
    defaultValue: MESSAGE_DISPLAY_DEFAULT,
    gateLifting: false,
    parseValue: parseMessageDisplayValue,
    valueProblem: messageDisplayValueProblem,
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
    parseValue: parseRetentionDays,
    valueProblem: (raw: unknown) => retentionDaysProblem('event-retention-days', raw),
    // Fewer or equal days kept is tighter; keep-all is looser than every positive count.
    isWithin: retentionDaysWithin,
  },
  // The bus log's segment size (`bus.segment_mb`): a mechanical number, so every word inside
  // the parser's range is accepted and no level's word tightens another's. The nearest level's
  // word wins, and an absent chain resolves to the shipped 8 MB.
  'event-segment-mb': {
    name: 'event-segment-mb',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: EVENT_SEGMENT_MB,
    gateLifting: false,
    parseValue: parseSegmentMb,
    valueProblem: (raw: unknown) => segmentMbProblem('event-segment-mb', raw),
    isWithin: () => true,
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
  // qualified `seat@team` target. The empty default is no target, and the release ships no
  // entity address: only a signed entity declaration answers, read by `src/policy/owner-reply.ts`,
  // so an entity without one has no target.
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
  'grok-command-deny': {
    name: 'grok-command-deny',
    kind: 'enforced',
    levels: ['team'],
    defaultValue: 'off',
    gateLifting: false,
    parseValue: parseGrokCommandDeny,
    valueProblem: () => 'grok-command-deny must be off, git, or git-and-tests',
    isWithin: (lower: GrokCommandDeny, higher: GrokCommandDeny) =>
      ['off', 'git', 'git-and-tests'].indexOf(lower) >= ['off', 'git', 'git-and-tests'].indexOf(higher),
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
  // How long one watch pass may spend reading the terminal host and the machine before the rest
  // of its panes wait for the next pass: whole milliseconds, 2000 when nothing declares it, and a
  // shorter budget is the tighter one (the pass reads less and resumes sooner). The reader that
  // consumes it (`watchReadLimits`) resolves the chain to `team`: one pass reads a whole session,
  // so no seat sets this. This entry is only the name, its aliases and the value rule.
  'watch-read-budget-ms': {
    name: 'watch-read-budget-ms',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: 2000,
    gateLifting: false,
    parseValue: parseReadMillis,
    valueProblem: (raw: unknown) => readMillisProblem('watch-read-budget-ms', raw),
    // A shorter or equal budget is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  // The longest one read may take before its child is killed: whole milliseconds, 2000 when
  // nothing declares it, a shorter call the tighter one. A pass's remaining budget may shorten
  // a call below this value, never lengthen it. This entry is only the name, its aliases and
  // the value rule.
  'watch-read-timeout-ms': {
    name: 'watch-read-timeout-ms',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: 2000,
    gateLifting: false,
    parseValue: parseReadMillis,
    valueProblem: (raw: unknown) => readMillisProblem('watch-read-timeout-ms', raw),
    // A shorter or equal call is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  // The longest a send's own arrival post waits on the receiving seat's routine: whole
  // milliseconds from 500 to 10000, 3000 when nothing declares it, and a shorter bound is the
  // tighter one. The post is a wake beside a record that is already durable and staged for the
  // bus and the seat's pull, so a person's command never waits out the bus's budget; the release
  // default leaves a routine that answers in one to two seconds its full answer instead of an
  // `unknown` it never had. The bus delivery keeps its own budget (`WEBHOOK_POLICY`) and does not
  // read this value. `webhookSenderDeadlineMs` in `src/settings/webhook-sender-policy.ts` reads
  // it for the receiving team's chain.
  'webhook-sender-deadline-ms': {
    name: 'webhook-sender-deadline-ms',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: WEBHOOK_SENDER_DEADLINE_MS,
    gateLifting: false,
    parseValue: parseWebhookSenderDeadline,
    valueProblem: (raw: unknown) => webhookSenderDeadlineProblem('webhook-sender-deadline-ms', raw),
    // A shorter or equal bound is tighter.
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
  // The machine daemon's fallback-store retirement, for a store that was never retired before and
  // carries its whole history. Above `daemon.fallback-backlog-above` eligible finished episodes,
  // one pass retires up to `daemon.fallback-backlog-limit` instead of the steady 256: the first
  // passes after an upgrade empty the backlog, then the steady limit returns as soon as the
  // backlog is under the threshold. A higher threshold makes one pass do less and a smaller bulk
  // limit retires fewer episodes, so those are the tighter words. Only the entity, project and
  // team levels set them. The daemon reads them for each hosted root; a chain that cannot be read
  // keeps the release defaults, because retirement is housekeeping and never stops the sweep.
  'daemon.fallback-backlog-above': {
    name: 'daemon.fallback-backlog-above',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: BACKLOG_ABOVE_RANGE.release,
    gateLifting: false,
    parseValue: (raw: unknown) => parseBacklogCount(raw, BACKLOG_ABOVE_RANGE),
    valueProblem: (raw: unknown) => backlogCountProblem('daemon.fallback-backlog-above', raw, BACKLOG_ABOVE_RANGE),
    // A higher threshold is tighter: bulk mode engages later, so one pass does less.
    isWithin: (lower: number, higher: number) => lower >= higher,
  },
  'daemon.fallback-backlog-limit': {
    name: 'daemon.fallback-backlog-limit',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: BACKLOG_LIMIT_RANGE.release,
    gateLifting: false,
    parseValue: (raw: unknown) => parseBacklogCount(raw, BACKLOG_LIMIT_RANGE),
    valueProblem: (raw: unknown) => backlogCountProblem('daemon.fallback-backlog-limit', raw, BACKLOG_LIMIT_RANGE),
    // A smaller bulk limit is tighter: one pass retires fewer episodes.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  // The machine daemon's loop heartbeat, in whole seconds from 1 to 60: how often the daemon
  // refreshes its state record, probes its hosted endpoints and runs the fallback sweep, which
  // still rides the beat in this release. One process serves every hosted checkout, so the
  // daemon resolves the word for each hosted root at start and again on its housekeeping pass,
  // and runs the shortest effective word among them: no hosted team loosens another's beat, and
  // a longer beat must be declared at a level every hosted checkout shares. A root whose chain
  // cannot be read keeps the release default as its word, because the beat is liveness and never
  // stops on a word no level could prove. While the sweep still rides the beat, a shorter beat
  // makes a backlog stall more often, not less; the bounds keep a word inside 1 to 60 seconds.
  'daemon.heartbeat': {
    name: 'daemon.heartbeat',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: DAEMON_HEARTBEAT_SECONDS.release,
    gateLifting: false,
    parseValue: parseHeartbeatSeconds,
    valueProblem: (raw: unknown) => heartbeatSecondsProblem('daemon.heartbeat', raw),
    // A shorter or equal beat is tighter, the same direction as every interval policy.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  // Where the machine daemon runs the heavy per-root chores — the fallback sweep and retirement,
  // the reconcile scans, the presence history step and publisher, and the hosted watch's reads.
  // `per-root`, the release default, gives every hosted root its own supervised child, so one
  // root's work never shares a process with another's. `shared` runs one child for every root
  // whose word is `shared`: each root has its own FIFO of passes and the child serves them
  // round-robin, one slice per turn, so a root's backlog delays another root's chores by a slice
  // and never the daemon's socket. `inline` runs the work on the daemon's own loop exactly as
  // before the isolation, which is the rollback. A lower level may choose less isolation, never
  // more: inline is within shared, and shared is within per-root. The daemon reads it for each
  // hosted root; a chain that cannot be read keeps the release default, because the chores never
  // stop the endpoint. A hosted route with no isolation seam (a plain `team bus`, a test
  // harness) stays inline.
  'daemon.chores': {
    name: 'daemon.chores',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: DAEMON_CHORES_DEFAULTS.mode,
    gateLifting: false,
    parseValue: parseChoreMode,
    valueProblem: (raw: unknown) => choreModeProblem('daemon.chores', raw),
    isWithin: (lower: DaemonChoresMode, higher: DaemonChoresMode) => CHORE_MODE_RANK[lower] <= CHORE_MODE_RANK[higher],
  },
  // How long one slice of a chores child's pass may run before it yields: whole milliseconds,
  // 20 when nothing declares it, and a shorter slice is the tighter one (the child answers its
  // heartbeat sooner). The child reads this together with the per-root sweep cadence.
  'daemon.chores-slice-ms': {
    name: 'daemon.chores-slice-ms',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: DAEMON_CHORES_DEFAULTS.sliceMs,
    gateLifting: false,
    parseValue: parseChoreSliceMs,
    valueProblem: (raw: unknown) => choreSliceMsProblem('daemon.chores-slice-ms', raw),
    // A shorter or equal slice is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  // How many child heartbeats the supervisor may miss before it ends the child and restarts it:
  // whole beats from 1 to 60, 2 when nothing declares it, and a smaller count is the tighter one
  // (a stuck child is replaced sooner). The beat is the daemon's own heartbeat interval.
  'daemon.chores-missed-beats': {
    name: 'daemon.chores-missed-beats',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: DAEMON_CHORES_DEFAULTS.missedBeats,
    gateLifting: false,
    parseValue: parseMissedBeats,
    valueProblem: (raw: unknown) => missedBeatsProblem('daemon.chores-missed-beats', raw),
    // A smaller miss allowance is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  // The longest wait before a replaced chores child is started again: whole milliseconds from
  // 1000 to 600000, 30000 when nothing declares it. The wait doubles from one failure to the
  // next and never passes this cap; a smaller cap is the tighter one (recovery is tried sooner).
  'daemon.chores-backoff-cap-ms': {
    name: 'daemon.chores-backoff-cap-ms',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: DAEMON_CHORES_DEFAULTS.backoffCapMs,
    gateLifting: false,
    parseValue: parseBackoffCapMs,
    valueProblem: (raw: unknown) => backoffCapProblem('daemon.chores-backoff-cap-ms', raw),
    // A smaller cap is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  // The sidebar rows layout the terminal host draws for agents: which tokens each line carries,
  // in order, from the host's own closed vocabulary. One word holds every row — rows separated
  // by `;`, a row's tokens by `,` — and the YAML natural form (a list of token lists) reads the
  // same way. The layout is presentation: any parsed layout is as strict as any other, so the
  // nearest level chooses. `workspace.` names a policy namespace here, never the team file's
  // owner section: this word is set at the entity, project or team level of the policy chain
  // and nothing in this release writes it into a team file.
  'workspace.sidebar.rows': {
    name: 'workspace.sidebar.rows',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: SIDEBAR_ROWS_DEFAULT_VALUE,
    gateLifting: false,
    parseValue: parseSidebarRowsValue,
    valueProblem: sidebarRowsProblem,
    isWithin: () => true,
  },
  // Whether team may touch the terminal host's config for the sidebar at all. `on`, the
  // release default, lets `team up` splice the marked block and the marked key, back up first
  // and roll back on a refused check; `off` prints the TOML it would write and never writes —
  // check reports the drift, and the owner applies it by hand. Off is explicit and absolute, the
  // same shape as `daemon.broker`: a lower level may switch managing off but cannot switch it
  // back on against a level that said off.
  'workspace.sidebar.manage': {
    name: 'workspace.sidebar.manage',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: 'on',
    gateLifting: false,
    parseValue: parseOnOff,
    // 'off' is tighter than 'on': off is within on, on is not within off.
    isWithin: (lower: 'on' | 'off', higher: 'on' | 'off') => !(higher === 'off' && lower === 'on'),
  },
  // Which status indicator the host draws beside an agent: the host's own closed vocabulary
  // (`dots` or `symbols`, the word its config check refuses any other value for). The owner
  // wants the distinct symbols, so `symbols` is the release default. Presentation again: any
  // parsed word is as strict as any other and the nearest level chooses.
  'workspace.sidebar.status_indicators': {
    name: 'workspace.sidebar.status_indicators',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: 'symbols',
    gateLifting: false,
    parseValue: parseSidebarIndicators,
    valueProblem: sidebarIndicatorsProblem,
    isWithin: () => true,
  },
  // How long a pane's reported sidebar metadata lives before it lapses: whole milliseconds,
  // one day (the host's own cap) when nothing declares it. The host refuses a ttl above its cap
  // outright, so the reader clamps the word to the cap instead of refusing it — a stored word
  // stays readable when a future host raises the cap. A shorter ttl is the tighter word.
  'daemon.sidebar-ttl-ms': {
    name: 'daemon.sidebar-ttl-ms',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: SIDEBAR_TTL_MS_DEFAULT,
    gateLifting: false,
    parseValue: parseSidebarMillis,
    valueProblem: (raw: unknown) => sidebarMillisProblem('daemon.sidebar-ttl-ms', raw),
    // A shorter or equal ttl is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  // How often the sidebar line is re-reported to keep the metadata inside its ttl: whole
  // milliseconds from one minute to seven days, six hours when nothing declares it. A shorter
  // interval is the tighter word (the line is refreshed sooner, so a lapse is less likely).
  'daemon.sidebar-refresh-ms': {
    name: 'daemon.sidebar-refresh-ms',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: SIDEBAR_REFRESH_MS.release,
    gateLifting: false,
    parseValue: parseSidebarRefreshMs,
    valueProblem: sidebarRefreshProblem,
    // A shorter or equal interval is tighter.
    isWithin: (lower: number, higher: number) => lower <= higher,
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
  // What the client grant bundles (`observer`, `operator`, `manager`) expand to at signing time, and how long
  // a grant of one lasts: `operator=status,send,up,down@30d;observer=status;manager=status,add@30d`. Empty (the default)
  // is the release lists in `src/client/bundle-ops.ts`. A policy can only choose among the ops a
  // bundle may ever carry; the commands that change who may do what are never eligible, whatever
  // it says; `add` and `remove` are eligible for `manager` alone. Entity and project levels; a lower level may only narrow the ops and shorten the days.
  'client-bundles': {
    name: 'client-bundles',
    kind: 'enforced',
    levels: ['entity', 'project'],
    defaultValue: '',
    gateLifting: false,
    parseValue: (raw: unknown) => {
      if (typeof raw !== 'string') return null;
      const parsed = parseBundlePolicy(raw);
      return parsed.ok ? formatBundlePolicy(parsed.specs) : null;
    },
    valueProblem: (raw: unknown) => {
      if (typeof raw !== 'string') return 'client-bundles takes text like operator=status,send,up,down@30d;observer=status';
      const parsed = parseBundlePolicy(raw);
      return parsed.ok ? null : parsed.why;
    },
    isWithin: (lower: string, higher: string) => bundlePolicyWithin(lower, higher),
  },
  // How long a NEW client grant may last, per kind: `send=7d;up=90d;bundle=90d` are the release
  // defaults, so a machine that sets nothing behaves as it always did. One word names every kind
  // (`30d`, `none`); `none` allows a grant with no end date (`team grant --expires never`), which
  // stays revocable with `team revoke`. A cap bounds a request, it never lengthens one that names
  // no date. Entity and project levels; a lower level may only shorten (`none` is the loosest), a
  // kind it leaves out inherits the value above it, and a chain that cannot be read or verified
  // refuses a new grant instead of falling back to a looser default. Grants already signed keep
  // their own end date.
  'client-grant-max-duration': {
    name: 'client-grant-max-duration',
    kind: 'enforced',
    levels: ['entity', 'project'],
    defaultValue: '',
    gateLifting: false,
    parseValue: (raw: unknown) => {
      const parsed = parseDurationPolicy(raw);
      return parsed.ok ? formatDurationPolicy(parsed.caps) : null;
    },
    valueProblem: (raw: unknown) => {
      const parsed = parseDurationPolicy(raw);
      return parsed.ok ? null : parsed.why;
    },
    inherit: (higher: string, lower: string) => inheritDurationPolicy(higher, lower),
    isWithin: (lower: string, higher: string) => durationPolicyWithin(lower, higher),
  },
  // Which Actions commands the guard allows. The default is Floor's three; a caller sets a
  // subset. A name outside the three is not a value, so the list cannot grow a fourth command,
  // and no seat is named.
  'actions-commands': {
    name: 'actions-commands',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: ACTIONS_COMMANDS_DEFAULT,
    gateLifting: false,
    parseValue: parseActionsCommands,
    isWithin: (lower: readonly ActionsCommand[], higher: readonly ActionsCommand[]) =>
      lower.every((command) => higher.includes(command)),
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
  // Where a seat works: in its own worktree (the default) or straight on a branch of the shared
  // checkout. Set at the entity, the project or the team; the nearest level chooses, and the team
  // file's `workspace.mode`, then a seat's `mode`, override it (src/policy/work-settings.ts).
  'workspace-mode': {
    name: 'workspace-mode',
    kind: 'advised',
    levels: ['entity', 'project', 'team'],
    defaultValue: 'worktree',
    gateLifting: false,
    lowerLevelChooses: true,
    parseValue: (raw: unknown) => (raw === 'worktree' ? 'worktree' : raw === 'shared' || raw === 'branch' ? 'shared' : null),
    valueProblem: (raw: unknown) => `workspace-mode is worktree or shared (branch), got ${JSON.stringify(raw)}`,
    isWithin: () => true,
  },
  // How changes land: one pull request per change, a batch of reviewed commits per pull request, or
  // reviewed commits landed directly on the integration branch. Every mode keeps review: the mode
  // chooses how much lands at once, never whether it is reviewed.
  'landing-mode': {
    name: 'landing-mode',
    kind: 'advised',
    levels: ['entity', 'project', 'team'],
    defaultValue: 'batch',
    gateLifting: false,
    lowerLevelChooses: true,
    parseValue: (raw: unknown) => (raw === 'pr-per-change' || raw === 'batch' || raw === 'direct' ? raw : null),
    valueProblem: (raw: unknown) => `landing-mode is pr-per-change, batch or direct, got ${JSON.stringify(raw)}`,
    isWithin: () => true,
  },
  // The root of the docs vault where seats keep memory (an absolute path, or `~/` relative to the
  // home). Empty means no vault: memory stays where each CLI keeps it.
  'vault-root': {
    name: 'vault-root',
    kind: 'advised',
    levels: ['entity', 'project', 'team'],
    defaultValue: '',
    gateLifting: false,
    lowerLevelChooses: true,
    parseValue: (raw: unknown) => (typeof raw === 'string' && (raw.startsWith('/') || raw.startsWith('~/')) && !/[\x00-\x1f\x7f]/.test(raw) ? raw.replace(/\/+$/, '') || '/' : null),
    valueProblem: (raw: unknown) => `vault-root is an absolute path or one under ~/, got ${JSON.stringify(raw)}`,
    isWithin: () => true,
  },
  // The entity's own orchestrator: `auto` (the root project's team lead plays it), `dedicated` (a
  // seat of its own), or `off` (none; each team's orchestrator answers to the owner directly). It
  // names a role, never a power: crossing the entity still needs a grant.
  'entity-orchestrator': {
    name: 'entity-orchestrator',
    kind: 'advised',
    levels: ['entity'],
    defaultValue: 'auto',
    gateLifting: false,
    parseValue: (raw: unknown) => (raw === 'auto' || raw === 'dedicated' || raw === 'off' ? raw : null),
    valueProblem: (raw: unknown) => `entity-orchestrator is auto, dedicated or off, got ${JSON.stringify(raw)}`,
    isWithin: () => true,
  },
  // Whether the entity's main orchestrator relays the owner's word: a relayed decision quotes
  // the owner and cites its owner-decisions entry, and seats act on it without asking again.
  // Relay never carries an owner-reserved decision (major releases, spending and accounts,
  // credentials, machine settings); those need the owner's device. Senders are attributed,
  // not verified, within one OS user. On by default where the entity sets a main orchestrator;
  // `off` turns the rule line off.
  'entity.main-orchestrator.relays-owner': {
    name: 'entity.main-orchestrator.relays-owner',
    kind: 'advised',
    levels: ['entity'],
    defaultValue: 'on',
    gateLifting: false,
    lowerLevelChooses: true,
    parseValue: parseOnOff,
    isWithin: () => true,
  },
  // Whether leads may type or choose in a seat's pane when `team send` cannot reach it or a
  // dialog blocks it; they read the pane before and after, and never the owner's own pane.
  'leads.pane-actions': {
    name: 'leads.pane-actions',
    kind: 'advised',
    levels: ['entity', 'project', 'team'],
    defaultValue: 'on',
    gateLifting: false,
    lowerLevelChooses: true,
    parseValue: parseOnOff,
    isWithin: () => true,
  },
  // Whether a lead in dev mode may bring back a stopped seat and build when no watcher runs.
  'leads.self-service': {
    name: 'leads.self-service',
    kind: 'advised',
    levels: ['entity', 'project', 'team'],
    defaultValue: 'on',
    gateLifting: false,
    lowerLevelChooses: true,
    parseValue: parseOnOff,
    isWithin: () => true,
  },
  // What the owner keeps, in four words, printed in every seat's generated rules below the
  // line that says what belongs to the teams. A list, `;`- or
  // `,`-separated on the command line; set it to change the words, never to make the rule
  // disappear. The four default words are also the floor: a set value may add words, and the
  // scope in force puts any floor word it left out back in, so no level narrows what the
  // owner reserves below them.
  'owner.reserved-scope': {
    name: 'owner.reserved-scope',
    kind: 'advised',
    levels: ['entity', 'project', 'team'],
    defaultValue: OWNER_RESERVED_SCOPE_DEFAULT,
    gateLifting: false,
    lowerLevelChooses: true,
    parseValue: parseScopeItems,
    valueProblem: (raw: unknown) => `owner.reserved-scope is a list of reserved scopes, got ${JSON.stringify(raw)}`,
    isWithin: () => true,
  },
  // The mailbox router's alias map: each entry places an alias at a `seat@team` address. The
  // release places none — a fresh install's map is empty, and a word exists only when an entity or
  // team policy record places it. The entity may place or move any name, and a team may add an
  // alias for its own seats — never retarget one the entity places. `readMailboxRouterPolicy`
  // in `src/policy/router.ts` judges that split at load, naming the alias; the resolver's own
  // ordering refuses a team word that moves an entity-placed alias against an entity declaration.
  'router.aliases': {
    name: 'router.aliases',
    kind: 'advised',
    levels: ['entity', 'team'],
    defaultValue: ROUTER_ALIAS_DEFAULT_VALUE,
    gateLifting: false,
    parseValue: (raw: unknown) => {
      const entries = parseRouterAliases(raw);
      return entries === null ? null : formatRouterAliases(entries);
    },
    valueProblem: routerAliasesProblem,
    inherit: inheritRouterAliases,
    // Every alias the higher value places keeps the address the lower value finds there.
    isWithin: routerAliasesWithin,
  },
  // Where an alias's ask goes on a definite miss: another alias's route is a `seat@team` address,
  // `none` clears it. The release ships none, so a fallback exists only where a record places one.
  // An entity alias's fallback belongs to the entity alone — a team may set the fallback only of
  // an alias it added, which `readMailboxRouterPolicy` judges at load, naming the alias.
  'router.fallback': {
    name: 'router.fallback',
    kind: 'advised',
    levels: ['entity', 'team'],
    defaultValue: ROUTER_FALLBACK_DEFAULT_VALUE,
    gateLifting: false,
    parseValue: (raw: unknown) => {
      const entries = parseRouterFallback(raw);
      return entries === null ? null : formatRouterFallback(entries);
    },
    valueProblem: routerFallbackProblem,
    inherit: inheritRouterFallback,
    // Every fallback the higher value sets (or clears) stays as the higher value left it.
    isWithin: routerFallbackWithin,
  },
  // How long the router waits for a seat's verified reply to an ask: whole seconds from 1 to
  // 86400, and the nearest level chooses. Unset — the release default — means twice the seat's
  // unread window. The bridge's synchronous cap of 120 s is a constant of the child, not a value
  // here; a bound above it still waits the full bound for the mailbox record.
  'router.reply-bound': {
    name: 'router.reply-bound',
    kind: 'advised',
    levels: ['entity', 'team'],
    defaultValue: 'unset',
    gateLifting: false,
    lowerLevelChooses: true,
    parseValue: parseRouterReplyBound,
    valueProblem: () => 'policy "router.reply-bound" is a whole number of seconds from 1 to 86400, such as 600',
    isWithin: () => true,
  },
  'seat.dialog.answer': {
    name: 'seat.dialog.answer',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: DIALOG_ANSWER_DEFAULT,
    gateLifting: false,
    parseValue: parseDialogAnswer,
    valueProblem: dialogAnswerProblem,
    isWithin: (lower: readonly string[], higher: readonly string[]) => lower.every((token) => higher.includes(token)),
    proofAllowsLoosening: dialogProofAllows,
  },
  'seat-health.watchdog.after': {
    name: 'seat-health.watchdog.after',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: WATCHDOG_AFTER_SECONDS,
    gateLifting: false,
    parseValue: parseWatchdogAfter,
    isWithin: (lower: number, higher: number) => lower >= higher,
  },
  'seat-health.watchdog.auto-restart': {
    name: 'seat-health.watchdog.auto-restart',
    kind: 'enforced',
    levels: ['entity', 'project', 'team', 'seat'],
    defaultValue: WATCHDOG_AUTO_RESTART_MAX,
    gateLifting: false,
    parseValue: parseWatchdogAuto,
    isWithin: (lower: number, higher: number) => lower <= higher,
  },
  // Captured trust records for a start folder. `project` writes only a record this build has
  // already captured, and only inside the project. `off` writes none. A lower level may turn
  // it off; it may not turn it back on.
  pretrust: {
    name: 'pretrust',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: 'project',
    gateLifting: false,
    parseValue: (raw: unknown) => (raw === 'off' || raw === 'project' ? raw : null),
    valueProblem: () => 'policy "pretrust" is off or project',
    isWithin: (lower: 'off' | 'project', higher: 'off' | 'project') => lower === higher || lower === 'off',
  },
  // The empty-account door. `empty-account` admits once, only when every durable record is
  // absent. `off` admits never. A lower level may turn it off; it may not turn it back on.
  'first-run-admission': {
    name: 'first-run-admission',
    kind: 'enforced',
    levels: ['entity', 'project', 'team'],
    defaultValue: 'empty-account',
    gateLifting: false,
    parseValue: (raw: unknown) => (raw === 'off' || raw === 'empty-account' ? raw : null),
    valueProblem: () => 'policy "first-run-admission" is off or empty-account',
    isWithin: (lower: 'off' | 'empty-account', higher: 'off' | 'empty-account') =>
      lower === higher || lower === 'off',
  },
};

export function getPolicySpec(name: string): PolicySpec<any> | null {
  const canonical = normalizePolicyName(name) as CataloguePolicyName;
  return POLICY_CATALOGUE[canonical] ?? null;
}
