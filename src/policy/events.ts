// Amendment 01 to 002 (draft 3) §4.3–§4.5: the event vocabulary's default recipients, the
// privileged kinds, and the routing settings' release defaults.
//
// This is a settings group of its own, not a catalogue policy. A catalogue value is one scalar
// (or one ordered list) per level; event routing is a map from event kind to recipients, and its
// levels grow a set instead of replacing a value — a level adds recipients and takes none away
// that a higher level or the default table set. The inheritance reading for it is therefore its
// own: `src/bus/routing.ts` folds the chain and judges each word a writer asks to make; the bus
// (and the watch) read the group through it. The values here are the release defaults the draft
// names; the changing numbers are named constants so the owner can set them in one place.
import type { PolicyLevel } from './types.ts';

/** The levels an event-routing word may be set at (§4.4), outermost first. */
export const EVENT_ROUTING_LEVELS: readonly PolicyLevel[] = ['entity', 'project', 'team', 'seat'];

/**
 * A recipient the bus resolves against the event it is delivering: `lead` is the seat whose role
 * holds `leads`, `operator` the file's operator seat, `sender` and `subject` the record's own
 * fields, and `owner` the owner's own runtime — never a seat.
 */
export type RoutingPosition = 'lead' | 'operator' | 'sender' | 'subject' | 'owner';

/** One recipient: a position, or a seat by its registry id (`agt_…`), the draft's own two forms. */
export type RoutingRecipient = RoutingPosition | { seat: string };

/**
 * The routing map's value: event kind to recipients. A kind left out of a level's word keeps the
 * recipients it already has; a kind named with an empty list is written but adds nothing — a
 * level cannot empty a kind it did not fill.
 */
export type EventRouting = Readonly<Record<string, readonly RoutingRecipient[]>>;

/**
 * One level's word on routing: the recipients it adds, and the recipients it would remove. A
 * removal that names a recipient standing in the chain above the level is refused (the chain is
 * a growing set); `src/bus/routing.ts` names the rule. `remove` exists so that refusal is a
 * decision with a name, not an unexpressible wish.
 */
export type RoutingChange = {
  readonly add?: readonly RoutingRecipient[];
  readonly remove?: readonly RoutingRecipient[];
};

/** A level's whole word: one change per kind. */
export type RoutingWord = Readonly<Record<string, RoutingChange>>;

/**
 * The default recipients of §4.3's table, for the kinds whose default is a routing decision.
 * `message.arrived` is absent on purpose: it *is* the delivery, addressed to the record's own
 * recipient, so there is nothing to route. The conditional lines of the table are the raising
 * side's: the owner joins an at-prompt whose kind is a permission, trust, login or vendor notice;
 * a red gate on the integration tip also reaches every seat holding `merge` and the operator. A
 * position the event does not carry (no `subject`, no `sender`) resolves to nobody.
 */
export const EVENT_ROUTING_DEFAULTS: EventRouting = {
  'message.delivered': ['sender'],
  'message.read': ['sender'],
  'message.replied': ['sender'],
  // The lead's copy is raised only after `held-threshold`; the sender's word is immediate.
  'message.held': ['sender', 'lead'],
  // Working and idle are read by the bus and the watch; a lead that wants them adds itself.
  'seat.working': [],
  'seat.idle': [],
  'seat.idle-timeout': ['lead'],
  'seat.blocked': ['lead', 'operator'],
  'seat.at-prompt': ['lead', 'operator'],
  'seat.unreachable': ['lead', 'operator'],
  'seat.done': ['lead', 'operator'],
  'work.claimed': ['lead'],
  'work.done': ['lead'],
  'work.released': ['lead'],
  'work.gate': ['lead'],
  'work.suite': ['lead'],
  'team.seat-added': ['lead', 'owner'],
  'team.seat-removed': ['lead', 'owner'],
  'team.seat-reloaded': ['lead', 'owner'],
  'team.grant-issued': ['lead', 'subject', 'owner'],
  'team.grant-revoked': ['lead', 'subject', 'owner'],
  'team.grant-expired': ['lead', 'subject', 'owner'],
  'team.policy-changed': ['lead', 'subject', 'owner'],
  // The one answer that moves a table default: a refusal names a rule, so the owner is the
  // audience; the operational log holds the same record for every reader.
  'team.policy-refused': ['owner'],
  // The lead's own words to the owner, raised through `team raise`: a release is ready, or a
  // decision is needed. Each is a decision moment the owner answers, so the audience is the
  // owner alone and the watch delivers it at once (`DEFAULT_OWNER_AT_ONCE_KINDS`).
  'release.ready': ['owner'],
  'decision.needed': ['owner'],
  // Retention is operational, not governance: a dropped range is declared to the lead and the
  // operator, and the record itself is in the log every reader already verifies.
  'team.event-log-dropped': ['lead', 'operator'],
};

/** Every event kind the default table routes, in the table's own order. */
export const EVENT_KINDS: readonly string[] = Object.keys(EVENT_ROUTING_DEFAULTS);

/**
 * The kinds privileged from the start: a grant record's life, a policy record's life, and a seat
 * at a prompt. `team.policy-refused` matches `team.policy-*` and is raised by the bus itself.
 */
export const PRIVILEGED_KINDS: readonly string[] = ['team.grant-*', 'team.policy-*', 'seat.at-prompt'];

/**
 * The setting's name, levels and owner sovereignty: the list grows only by the owner's act, at
 * any scope, and no level removes a kind from it. The bus never edits this list; it reads it.
 */
export const PRIVILEGED_KINDS_SETTING = {
  name: 'privileged-kinds',
  levels: EVENT_ROUTING_LEVELS,
  ownerSovereign: true,
  /** The release defaults; the owner's additions stand beside them and never replace them. */
  defaults: PRIVILEGED_KINDS,
} as const;

/** The routing setting's name and levels, for the bus's reader and the policy surface. */
export const EVENT_ROUTING_SETTING = {
  name: 'event-routing',
  levels: EVENT_ROUTING_LEVELS,
} as const;

/**
 * The shipping defaults of the event settings, in seconds (and counts where a count is the unit),
 * in the shape the existing state thresholds use. These are the numbers every command reads: the
 * pending retry window and the inbox fallback are ten minutes, the lead is told about an idle seat
 * after five, `reconcile-interval` mirrors the watch's two-minute poll, a thread stays open for 72
 * hours after its newest record or until it holds 50 records, and the event log keeps 30 days. The
 * owner may change them, and the delay thresholds only ever shorten.
 */
export const EVENT_THRESHOLDS = {
  /** How long a record may wait before `message.held` reaches the lead. */
  held_threshold_seconds: 600,
  /** How long a seat that watches nothing reads `sent` before it is `unreachable`, and is told. */
  unreachable_threshold_seconds: 600,
  /** How long a seat may be `idle` before `seat.idle-timeout` reaches the lead. */
  idle_threshold_seconds: 300,
  /** How often the bus reconciles records against the log. */
  reconcile_interval_seconds: 120,
  /** How long an unanswered thread stays open before `thread-ttl` closes it. */
  thread_ttl_seconds: 72 * 60 * 60,
  /** How many messages one thread may hold before a reply opens a new one. */
  thread_cap: 50,
  /** How many days the event log keeps before rotation drops its oldest segment. */
  retention_days: 30,
} as const;

export type EventThreshold = keyof typeof EVENT_THRESHOLDS;

/**
 * The threshold set's descriptor, in the shape the other two settings carry: the name a policy
 * surface writes, the levels that may declare a word, and owner sovereignty over the numbers
 * shipped here. It is a set, not one scalar: each field resolves on its own, and a level's word
 * on a delay threshold may only shorten it (answer 8). The setter enforces that direction; the
 * constants above are where it starts.
 */
export const EVENT_THRESHOLDS_SETTING = {
  name: 'event-thresholds',
  levels: EVENT_ROUTING_LEVELS,
  ownerSovereign: true,
  defaults: EVENT_THRESHOLDS,
  /** The delay thresholds, the fields bound to move in one direction only: shorter. */
  shortenOnly: ['held_threshold_seconds', 'unreachable_threshold_seconds', 'idle_threshold_seconds'],
} as const;

/**
 * Whether a kind is privileged under a list of patterns. A pattern is an exact kind or a prefix
 * ending in `*` (`team.grant-*`); the release kinds use the two forms the draft names. The list
 * in force is the release defaults grown by the owner's additions (`growPrivilegedKinds`).
 */
export function isPrivilegedKind(kind: string, patterns: readonly string[] = PRIVILEGED_KINDS): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith('*')) return kind.startsWith(pattern.slice(0, -1));
    return kind === pattern;
  });
}

/**
 * The privileged list after the owner's own word: his additions join the defaults, and a kind
 * already covered — exactly, or by a pattern standing in the list — is no change. This is the
 * only write the list takes: no level removes a kind, and no caller other than the owner reaches
 * it (`checkPrivilegedKindsWrite` in `src/bus/routing.ts` refuses the rest).
 */
export function growPrivilegedKinds(current: readonly string[], additions: readonly string[]): readonly string[] {
  const out = [...current];
  for (const kind of additions) {
    if (out.includes(kind)) continue;
    if (!kind.endsWith('*') && isPrivilegedKind(kind, out)) continue;
    out.push(kind);
  }
  return out;
}
