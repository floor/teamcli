// Closed event kinds table, default recipient positions, privileged kinds, owner-at-once set
// (OD-20261018-05), and owner-sovereign threshold constants (RFC 002 Amendment 01 §4.3, §4.4, §10),
// wired to the B2 routing settings in `src/policy/events.ts` and `src/bus/routing.ts`.
//
// An event says what happened, when, and to which record; it carries no body and instructs nobody.
// Privileged kinds (`team.grant-*`, `team.policy-*`, `seat.at-prompt`, plus any kind the owner
// adds to `privileged-kinds`) may never be self-subscribed to by a seat: a self-subscription
// attempt is refused under rule `privileged-self-subscription` (`checkRoutingWrite`) and raises
// `team.policy-refused` to the owner.
import {
  EVENT_ROUTING_DEFAULTS,
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
  'message.expired',
  'message.unconfirmed',
  'message.not-submitted',
  'message.unreachable',
  // Seat lifecycle & state
  'seat.working',
  'seat.idle',
  'seat.idle-timeout',
  'seat.blocked',
  'seat.at-prompt',
  'seat.unreachable',
  'seat.done',
  'seat.started',
  'seat.stopped',
  'seat.lost',
  'seat.restored',
  'seat.rate-limited',
  'seat.provider-error',
  // Work & tasks
  'work.claimed',
  'work.taken',
  'work.done',
  'work.released',
  'work.gate',
  'work.suite',
  'work.branch-pushed',
  'work.pr-opened',
  'work.pr-merged',
  // Team & governance
  'team.up',
  'team.down',
  'team.seat-added',
  'team.seat-removed',
  'team.seat-reloaded',
  'team.budget-mark',
  'team.grant-issued',
  'team.grant-added',
  'team.grant-revoked',
  'team.grant-expired',
  'team.policy-changed',
  'team.policy-refused',
  'team.hold-set',
  'team.hold-cleared',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

const EVENT_KIND_SET: ReadonlySet<string> = new Set<string>(EVENT_KINDS);

export function isEventKind(value: unknown): value is EventKind {
  return typeof value === 'string' && EVENT_KIND_SET.has(value);
}

/** Positions that the default routing table and `event-routing` policy can name. */
export type EventRecipientPosition = 'lead' | 'operator' | 'sender' | 'recipient' | 'subject' | 'owner';

/** Default recipients per event kind (Amendment 01 §4.3), extending `EVENT_ROUTING_DEFAULTS`.
 *  `seat.working` and `seat.idle` go to nobody by default: the bus and the watch read them,
 *  and a lead that wants them adds itself. `team.policy-refused` goes to the owner only (Q12). */
export const DEFAULT_EVENT_RECIPIENTS: Readonly<Record<EventKind, readonly EventRecipientPosition[]>> = {
  'message.arrived': ['recipient'],
  'message.delivered': ['sender'],
  'message.read': ['sender'],
  'message.replied': ['sender'],
  'message.held': ['sender', 'lead'],
  'message.expired': ['sender', 'lead'],
  'message.unconfirmed': ['sender'],
  'message.not-submitted': ['sender', 'lead'],
  'message.unreachable': ['sender', 'lead'],

  'seat.working': [],
  'seat.idle': [],
  'seat.idle-timeout': ['lead'],
  'seat.blocked': ['lead', 'operator'],
  'seat.at-prompt': ['lead', 'operator', 'owner'],
  'seat.unreachable': ['lead', 'operator', 'owner'],
  'seat.done': ['lead', 'operator', 'owner'],
  'seat.started': ['lead'],
  'seat.stopped': ['lead'],
  'seat.lost': ['lead', 'operator', 'owner'],
  'seat.restored': ['lead', 'operator'],
  'seat.rate-limited': ['lead', 'operator', 'owner'],
  'seat.provider-error': ['lead', 'operator', 'owner'],

  'work.claimed': ['lead', 'subject'],
  'work.taken': ['lead', 'subject'],
  'work.done': ['lead', 'subject'],
  'work.released': ['lead', 'subject'],
  'work.gate': ['lead', 'subject', 'operator'],
  'work.suite': ['lead', 'subject', 'operator'],
  'work.branch-pushed': ['lead', 'subject'],
  'work.pr-opened': ['lead', 'subject'],
  'work.pr-merged': ['lead', 'subject'],

  'team.up': ['lead', 'owner'],
  'team.down': ['lead', 'owner'],
  'team.seat-added': ['lead', 'owner'],
  'team.seat-removed': ['lead', 'owner'],
  'team.seat-reloaded': ['lead', 'owner'],
  'team.budget-mark': ['lead', 'operator', 'owner'],
  'team.grant-issued': ['lead', 'subject', 'owner'],
  'team.grant-added': ['lead', 'subject', 'owner'],
  'team.grant-revoked': ['lead', 'subject', 'owner'],
  'team.grant-expired': ['lead', 'subject', 'owner'],
  'team.policy-changed': ['lead', 'subject', 'owner'],
  'team.policy-refused': ['owner'],
  'team.hold-set': ['lead', 'owner'],
  'team.hold-cleared': ['lead', 'owner'],
};

/** Built-in privileged event kinds (Amendment 01 §4.4, Q12): `team.grant-*`, `team.policy-*`,
 *  and `seat.at-prompt`. The owner may grow this set via `privileged-kinds`; no level below
 *  the owner may remove any of them or self-subscribe to one. */
export const DEFAULT_PRIVILEGED_KINDS: readonly EventKind[] = [
  'seat.at-prompt',
  'team.grant-issued',
  'team.grant-added',
  'team.grant-revoked',
  'team.grant-expired',
  'team.policy-changed',
  'team.policy-refused',
];

export function isPrivilegedKind(kind: EventKind, extraPrivileged?: readonly string[]): boolean {
  const patterns = extraPrivileged !== undefined ? growPrivilegedKinds(PRIVILEGED_KINDS, extraPrivileged) : PRIVILEGED_KINDS;
  return isPolicyPrivilegedKind(kind, patterns);
}

/** Events delivered to the owner at once rather than batched into a summary (OD-20261018-05,
 *  Amendment 01 §10): `seat.at-prompt` of the owner's kinds, `seat.unreachable` and `seat.done`
 *  of the lead's seat, and every roster, grant and policy event. */
export const DEFAULT_OWNER_AT_ONCE_KINDS: readonly EventKind[] = [
  'seat.at-prompt',
  'seat.unreachable',
  'seat.done',
  'seat.lost',
  'seat.provider-error',
  'seat.rate-limited',
  'team.seat-added',
  'team.seat-removed',
  'team.seat-reloaded',
  'team.grant-issued',
  'team.grant-added',
  'team.grant-revoked',
  'team.grant-expired',
  'team.policy-changed',
  'team.policy-refused',
  'team.budget-mark',
];

const OWNER_AT_ONCE_SET: ReadonlySet<EventKind> = new Set<EventKind>(DEFAULT_OWNER_AT_ONCE_KINDS);

export function isOwnerAtOnce(
  kind: EventKind,
  context?: { seat?: string; leadSeats?: ReadonlySet<string> },
): boolean {
  if (!OWNER_AT_ONCE_SET.has(kind)) return false;
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
    const defaults = DEFAULT_EVENT_RECIPIENTS[kind];
    if (options.isLead === true && defaults.includes('lead')) continue;
    if (options.isOperator === true && defaults.includes('operator')) continue;
    const decision = checkRoutingWrite({
      level: 'seat',
      kind,
      change: { add: [{ seat: requester }] },
      actor: { kind: 'seat', seat: requester },
      inherited: EVENT_ROUTING_DEFAULTS[kind] ?? [],
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

const ROUTING_TABLE_FOR_FOLD: EventRouting = Object.fromEntries(
  EVENT_KINDS.map((kind) => [
    kind,
    DEFAULT_EVENT_RECIPIENTS[kind].filter((pos): pos is Exclude<EventRecipientPosition, 'recipient'> => pos !== 'recipient'),
  ]),
);

function toRoutingRecipient(entry: string): RoutingRecipient {
  if (entry === 'lead' || entry === 'operator' || entry === 'sender' || entry === 'subject' || entry === 'owner') {
    return entry;
  }
  return { seat: entry };
}

/** Resolves the concrete recipient names (`owner` and seat names) for an event by folding the
 *  routing chain through `resolveRouting` (`src/bus/routing.ts`) and mapping positions (`lead`,
 *  `operator`, `sender`, `subject`, `owner`) and `{ seat }` recipients to concrete names. */
export function recipientsForEvent(
  event: {
    kind: EventKind;
    from?: string;
    to?: string;
    seat?: string;
    subject?: string;
  },
  team: TeamRoutingRoles,
  additiveRouting?: Partial<Record<EventKind, readonly string[]>>,
  chain: RoutingChain = [],
): Set<string> {
  const out = new Set<string>();
  const leads = leadSeatsOf(team);

  if (DEFAULT_EVENT_RECIPIENTS[event.kind].includes('recipient') && event.to !== undefined && event.to !== '') {
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

  const resolved = resolveRouting(event.kind, effectiveChain, { defaults: ROUTING_TABLE_FOR_FOLD });
  for (const recipient of resolved) {
    if (typeof recipient !== 'string') {
      if (recipient.seat !== '') out.add(recipient.seat);
      continue;
    }
    if (recipient === 'owner') {
      out.add('owner');
    } else if (recipient === 'lead') {
      for (const lead of leads) out.add(lead);
    } else if (recipient === 'operator') {
      if (team.operator !== undefined && team.operator !== '') out.add(team.operator);
    } else if (recipient === 'sender') {
      if (event.from !== undefined && event.from !== '') out.add(event.from);
    } else if (recipient === 'subject') {
      const subj = event.subject ?? event.seat ?? event.to;
      if (subj !== undefined && subj !== '') out.add(subj);
    }
  }
  return out;
}
