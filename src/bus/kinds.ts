// Closed event kinds table, default recipient positions, privileged kinds, the owner's
// immediacy list (the kinds pushed at once rather than batched), and owner-sovereign threshold
// constants (RFC 002 Amendment 01 §4.3, §4.4, §10),
// wired to the B2 routing settings in `src/policy/events.ts` and `src/bus/routing.ts`.
//
// An event says what happened, when, and to which record; it carries no body and instructs nobody.
// Privileged kinds (`team.grant-*`, `team.policy-*`, `seat.at-prompt`, plus any kind the owner
// adds to `privileged-kinds`) may never be self-subscribed to by a seat: a self-subscription
// attempt is refused under rule `privileged-self-subscription` (`checkRoutingWrite`) and raises
// `team.policy-refused` to the owner.
import {
  EVENT_ROUTING_DEFAULTS,
  EVENT_ROUTING_LEVELS,
  EVENT_THRESHOLDS,
  growPrivilegedKinds,
  isPrivilegedKind as isPolicyPrivilegedKind,
  PRIVILEGED_KINDS,
  type EventRouting,
  type RoutingChange,
  type RoutingRecipient,
} from '../policy/events.ts';
import {
  checkPrivilegedKindsWrite,
  checkRoutingWrite,
  policyRefusedEvent,
  refusalRecord,
  resolveRouting,
  type PolicyRefusedEvent,
  type RoutingChain,
  type RoutingRefusal,
  type RoutingRefusalRecord,
  type RoutingRule,
} from './routing.ts';

export {
  checkPrivilegedKindsWrite,
  checkRoutingWrite,
  EVENT_ROUTING_DEFAULTS,
  EVENT_THRESHOLDS,
  growPrivilegedKinds,
  policyRefusedEvent,
  PRIVILEGED_KINDS,
  refusalRecord,
  resolveRouting,
  type EventRouting,
  type PolicyRefusedEvent,
  type RoutingChain,
  type RoutingChange,
  type RoutingRecipient,
  type RoutingRefusal,
  type RoutingRefusalRecord,
  type RoutingRule,
};

export const EVENT_KINDS = [
  // Message lifecycle
  'message.arrived',
  'message.delivered',
  'message.read',
  'message.replied',
  'message.held',
  // Seat lifecycle & state
  'seat.working',
  'seat.idle',
  'seat.idle-timeout',
  'seat.blocked',
  'seat.at-prompt',
  'seat.prompt-escalated',
  'seat.unblocked',
  'seat.unreachable',
  'seat.done',
  // Work & tasks
  'work.claimed',
  'work.done',
  'work.released',
  'work.gate',
  'work.suite',
  // Team & governance
  'team.seat-added',
  'team.seat-removed',
  'team.seat-reloaded',
  'team.grant-issued',
  'team.grant-revoked',
  'team.grant-expired',
  'team.policy-changed',
  'team.policy-refused',
  // The lead's own words to the owner (`team raise`): a release is ready, or a decision is
  // needed. Owner-routed by default and delivered at once; no seat is in the audience.
  'release.ready',
  'decision.needed',
  // Refusals: a record that does not verify, and a caller whose identity the rules deny.
  'record.invalid',
  'security.refused',
  // Operational: retention declares the sequence range it dropped, so a reader, a reconcile
  // pass and a gap-resync see a declared drop rather than an unexplained hole.
  'team.event-log-dropped',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

const EVENT_KIND_SET: ReadonlySet<string> = new Set<string>(EVENT_KINDS);

export function isEventKind(value: unknown): value is EventKind {
  return typeof value === 'string' && EVENT_KIND_SET.has(value);
}

/** Prompt kinds on `seat.at-prompt` whose default routing includes the owner (Amendment 01 §4.3, §10). */
export const OWNER_PROMPT_KINDS = [
  'permission',
  'trust',
  'login',
  'vendor notice',
  'rate limit',
] as const;

export type OwnerPromptKind = (typeof OWNER_PROMPT_KINDS)[number];

const OWNER_PROMPT_SET: ReadonlySet<string> = new Set<string>(OWNER_PROMPT_KINDS);

/** Built-in privileged event kinds (Amendment 01 §4.4): `team.grant-*`, `team.policy-*`,
 *  `seat.at-prompt`, `record.invalid` and `security.refused`. The owner may grow this set via
 *  `privileged-kinds`; no level below the owner may remove any of them or self-subscribe to one. */
export const DEFAULT_PRIVILEGED_KINDS: readonly EventKind[] = [
  'seat.at-prompt',
  'seat.prompt-escalated',
  'team.grant-issued',
  'team.grant-revoked',
  'team.grant-expired',
  'team.policy-changed',
  'team.policy-refused',
  'record.invalid',
  'security.refused',
];

export function isPrivilegedKind(kind: EventKind, extraPrivileged?: readonly string[]): boolean {
  const patterns = extraPrivileged !== undefined ? growPrivilegedKinds(PRIVILEGED_KINDS, extraPrivileged) : PRIVILEGED_KINDS;
  return isPolicyPrivilegedKind(kind, patterns);
}

/** Events delivered to the owner at once rather than batched into a summary (Amendment 01 §10):
 *  `seat.at-prompt` of the owner's kinds, `seat.unreachable` and `seat.done` of the lead's seat,
 *  every roster, grant and policy event, the lead's own `team raise` line — a release ready
 *  or a decision needed, which the owner answers rather than reads later in a digest — and the
 *  two refusals. */
export const DEFAULT_OWNER_AT_ONCE_KINDS: readonly EventKind[] = [
  'seat.at-prompt',
  'seat.prompt-escalated',
  'seat.unreachable',
  'seat.done',
  'team.seat-added',
  'team.seat-removed',
  'team.seat-reloaded',
  'team.grant-issued',
  'team.grant-revoked',
  'team.grant-expired',
  'team.policy-changed',
  'team.policy-refused',
  'release.ready',
  'decision.needed',
  'record.invalid',
  'security.refused',
];

const OWNER_AT_ONCE_SET: ReadonlySet<EventKind> = new Set<EventKind>(DEFAULT_OWNER_AT_ONCE_KINDS);

/**
 * The owner's immediacy list as a setting (Amendment 01 §10): the kinds the
 * Runtime pushes at once, while everything else is batched into the pass's summary. It is the
 * owner's and no other level may write it. The release default is the reviewed list; the build
 * carries the descriptor, and the policy layer reads the value in force, as it does for the event
 * thresholds — the delivery never hard-codes the list.
 */
export const OWNER_AT_ONCE_SETTING = {
  name: 'owner-at-once',
  levels: EVENT_ROUTING_LEVELS,
  ownerSovereign: true,
  defaults: DEFAULT_OWNER_AT_ONCE_KINDS,
} as const;

export function isOwnerAtOnce(
  kind: EventKind,
  context?: { seat?: string; leadSeats?: ReadonlySet<string>; prompt?: string },
  atOnceKinds?: readonly EventKind[],
): boolean {
  const kinds = atOnceKinds === undefined || atOnceKinds === DEFAULT_OWNER_AT_ONCE_KINDS
    ? OWNER_AT_ONCE_SET
    : new Set<EventKind>(atOnceKinds);
  if (!kinds.has(kind)) return false;
  if (kind === 'seat.at-prompt' && context?.prompt !== undefined) {
    return OWNER_PROMPT_SET.has(context.prompt);
  }
  if ((kind === 'seat.unreachable' || kind === 'seat.done') && context?.leadSeats !== undefined) {
    return context.seat !== undefined && context.leadSeats.has(context.seat);
  }
  return true;
}

// Owner-sovereign threshold and bus constants sourced from `EVENT_THRESHOLDS` (`src/policy/events.ts`).
export const DEFAULT_RECONCILE_INTERVAL_SECONDS = EVENT_THRESHOLDS.reconcile_interval_seconds;
export const DEFAULT_EVENT_RETENTION_SECONDS = EVENT_THRESHOLDS.retention_days * 86_400;
export const DEFAULT_HELD_THRESHOLD_SECONDS = EVENT_THRESHOLDS.held_threshold_seconds;
export const DEFAULT_UNREACHABLE_THRESHOLD_SECONDS = EVENT_THRESHOLDS.unreachable_threshold_seconds;
export const DEFAULT_IDLE_THRESHOLD_SECONDS = EVENT_THRESHOLDS.idle_threshold_seconds;
export const DEFAULT_PROMPT_ESCALATION_SECONDS = EVENT_THRESHOLDS.prompt_escalation_seconds;
export const DEFAULT_SUBSCRIBER_BUFFER_LIMIT = 256;

export const PRIVILEGED_SELF_SUBSCRIPTION_RULE = 'privileged-self-subscription' as const;

export type SelfSubscriptionCheck =
  | { ok: true }
  | {
      ok: false;
      kind: EventKind;
      rule: typeof PRIVILEGED_SELF_SUBSCRIPTION_RULE;
      message: string;
      refusal: RoutingRefusal;
    };

/** Checks a seat's requested filter of event kinds against the privileged self-subscription ban
 *  (Amendment 01 §4.4) by delegating to `checkRoutingWrite` in `src/bus/routing.ts`. A seat that
 *  is already a default recipient (`lead` or `operator` where the kind's defaults include that
 *  position) is not adding itself; any other seat requesting a privileged kind is refused under
 *  `privileged-self-subscription`. */
export function checkPrivilegedSelfSubscription(
  requester: string,
  requestedKinds: readonly EventKind[],
  options: {
    isOwner?: boolean;
    isLead?: boolean;
    isOperator?: boolean;
    extraPrivileged?: readonly string[];
  } = {},
): SelfSubscriptionCheck {
  if (options.isOwner === true) return { ok: true };
  const privileged =
    options.extraPrivileged !== undefined
      ? growPrivilegedKinds(PRIVILEGED_KINDS, options.extraPrivileged)
      : PRIVILEGED_KINDS;

  for (const kind of requestedKinds) {
    if (!isPolicyPrivilegedKind(kind, privileged)) continue;
    const defaults = EVENT_ROUTING_DEFAULTS[kind] ?? [];
    if (options.isLead === true && defaults.includes('lead')) continue;
    if (options.isOperator === true && defaults.includes('operator')) continue;
    const decision = checkRoutingWrite({
      level: 'seat',
      kind,
      change: { add: [{ seat: requester }] },
      actor: { kind: 'seat', seat: requester },
      inherited: defaults,
      privileged,
    });
    if (!decision.ok) {
      return {
        ok: false,
        kind,
        rule: PRIVILEGED_SELF_SUBSCRIPTION_RULE,
        message: decision.detail,
        refusal: decision,
      };
    }
  }
  return { ok: true };
}

export type TeamRoutingRoles = {
  orchestrator?: string;
  operator?: string;
  seats?: readonly { name: string; leads?: boolean }[];
  /** The lead of the entity's own team — the seat above this team in the entity's chain
   *  (`src/bus/seats.ts` resolves it from the registry). Absent when the registry names no such
   *  team or its roster marks no lead; the `entity` position then resolves to nobody. */
  entityOrchestrator?: string;
};

export function leadSeatsOf(team: TeamRoutingRoles): Set<string> {
  const leads = new Set<string>();
  if (team.orchestrator !== undefined && team.orchestrator !== '') leads.add(team.orchestrator);
  if (team.seats !== undefined) {
    for (const seat of team.seats) {
      if (seat.leads === true) leads.add(seat.name);
    }
  }
  return leads;
}

/** Resolves a `{ seat }` routing recipient that names an agent registry id to the seat that agent
 *  holds in this team. A plain seat name answers `undefined` and stands as written, and so does an
 *  id the registry does not know. The resolver is passed in so `recipientsForEvent` stays pure:
 *  the bus reads the registry behind it (`src/bus/seats.ts`). */
export type SeatRecipientResolver = (entry: string) => string | undefined;

function toRoutingRecipient(entry: string): RoutingRecipient {
  if (
    entry === 'lead' || entry === 'operator' || entry === 'sender' || entry === 'subject'
    || entry === 'entity' || entry === 'owner'
  ) {
    return entry;
  }
  return { seat: entry };
}

/** Resolves the concrete recipient names (`owner` and seat names) for an event by folding the
 *  routing chain through `resolveRouting` (`src/bus/routing.ts`) against `EVENT_ROUTING_DEFAULTS`
 *  and mapping positions (`lead`, `operator`, `sender`, `subject`, `owner`) and `{ seat }`
 *  recipients to concrete names, plus §4.3's conditional owner clauses (`seat.at-prompt` of the
 *  owner's prompt kinds and `seat.unreachable` / `seat.done` of a lead seat). */
export function recipientsForEvent(
  event: {
    kind: EventKind;
    from?: string;
    to?: string;
    seat?: string;
    subject?: string;
    prompt?: string;
  },
  team: TeamRoutingRoles,
  additiveRouting?: Partial<Record<EventKind, readonly string[]>>,
  chain: RoutingChain = [],
  resolveSeat?: SeatRecipientResolver,
): Set<string> {
  const out = new Set<string>();
  const leads = leadSeatsOf(team);

  if (event.kind === 'message.arrived' && event.to !== undefined && event.to !== '') {
    out.add(event.to);
  }

  const effectiveChain: RoutingChain =
    additiveRouting && additiveRouting[event.kind] && additiveRouting[event.kind]!.length > 0
      ? [
          ...chain,
          {
            level: 'team',
            word: {
              [event.kind]: {
                add: additiveRouting[event.kind]!.map(toRoutingRecipient),
              },
            },
          },
        ]
      : chain;

  const resolved = resolveRouting(event.kind, effectiveChain, { defaults: EVENT_ROUTING_DEFAULTS });
  for (const recipient of resolved) {
    if (typeof recipient !== 'string') {
      if (recipient.seat !== '') out.add(resolveSeat?.(recipient.seat) ?? recipient.seat);
      continue;
    }
    if (recipient === 'owner') {
      out.add('owner');
    } else if (recipient === 'lead') {
      for (const lead of leads) out.add(lead);
    } else if (recipient === 'operator') {
      if (team.operator !== undefined && team.operator !== '') out.add(team.operator);
    } else if (recipient === 'entity') {
      if (team.entityOrchestrator !== undefined && team.entityOrchestrator !== '') {
        out.add(team.entityOrchestrator);
      }
    } else if (recipient === 'sender') {
      if (event.from !== undefined && event.from !== '') out.add(event.from);
    } else if (recipient === 'subject') {
      const subj = event.subject ?? event.seat ?? event.to;
      if (subj !== undefined && subj !== '') out.add(subj);
    }
  }

  if (event.kind === 'seat.at-prompt') {
    if (event.prompt !== undefined && OWNER_PROMPT_SET.has(event.prompt)) out.add('owner');
    if (event.seat !== undefined && leads.has(event.seat)) {
      // A team's own lead at a prompt is the climb's first rung skipped: nobody below the lead
      // can clear it, so the event goes to the entity's lead and to the owner from the start.
      out.add('owner');
      if (team.entityOrchestrator !== undefined && team.entityOrchestrator !== '') {
        out.add(team.entityOrchestrator);
      }
    }
  } else if (
    (event.kind === 'seat.unreachable' || event.kind === 'seat.done') &&
    event.seat !== undefined &&
    leads.has(event.seat)
  ) {
    out.add('owner');
  }

  return out;
}
