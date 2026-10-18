// Amendment 01 to 002 (draft 3) §4.4: event routing, the privileged kinds, and the visible
// refusal. Pure: no file, no clock, no environment. The bus supplies the chain of per-level
// words, the recipients already in force and the actor asking for a change; this module says who
// receives an event and whether a write is allowed. Its one caller is the bus (and, for the
// fold, any reader that must know a kind's audience before the bus runs).
//
// The shape of the group is in `src/policy/events.ts`; this file carries it out. The invariant is
// additive: a level adds recipients among its own seats and removes none that a higher level or
// the default table set, so the chain is a growing set and no notice is silenced from below. The
// privileged kinds are stricter: only the owner (or a holder whose grant names that kind) routes
// one, a seat never adds itself to one, and its default recipients stand. A refusal is a value
// here, never a silence: the bus appends the returned record to the operational log and raises
// `team.policy-refused` to the owner.
import {
  EVENT_ROUTING_DEFAULTS,
  isPrivilegedKind,
  PRIVILEGED_KINDS,
  type EventRouting,
  type RoutingChange,
  type RoutingRecipient,
  type RoutingWord,
} from '../policy/events.ts';
import { POLICY_LEVELS, type PolicyLevel } from '../policy/types.ts';

/** One level's whole word on routing. */
export type RoutingDeclaration = { level: PolicyLevel; word: RoutingWord };

/** The chain a team sits in, outermost first or any order: the fold reads `POLICY_LEVELS`. */
export type RoutingChain = readonly RoutingDeclaration[];

/**
 * Who asks for a routing write. The owner's own runtime is `owner`; a seat acting by itself is
 * `seat`; a holder whose grant names the kind is `grant-holder`, with the granted kinds as the
 * bus read them from the grant store. `registryId` is the id the routing map names a seat by.
 */
export type RoutingActor =
  | { kind: 'owner' }
  | { kind: 'seat'; seat: string; registryId?: string }
  | { kind: 'grant-holder'; seat: string; registryId?: string; kinds: readonly string[] };

/** One write a caller asks the bus to make. */
export type RoutingWrite = {
  /** The level the word would sit at. */
  level: PolicyLevel;
  /** The event kind the word is about. */
  kind: string;
  /** The recipients to add and remove. */
  change: RoutingChange;
  /** Who asks. */
  actor: RoutingActor;
  /**
   * The recipients standing before this word: the kind's defaults plus every level above. A
   * removal that names one of them is refused, the chain being a growing set.
   */
  inherited: readonly RoutingRecipient[];
  /** The privileged list in force: the release defaults, grown by the owner's additions. */
  privileged?: readonly string[];
};

/** The rule a refusal names, in the word the amendment gives it. */
export type RoutingRule =
  | 'privileged-self-subscription'
  | 'privileged-owner-only'
  | 'privileged-default-stands'
  | 'routing-removes-inherited'
  | 'seat-adds-itself-only';

/** A refused routing write, with everything a reader needs to see it whole. */
export type RoutingRefusal = {
  ok: false;
  rule: RoutingRule;
  /** The seat's registry id (or its name when it has none), or `owner`. */
  requester: string;
  /** The event kind the write was about. */
  kind: string;
  /** The level the write was made at. */
  level: PolicyLevel;
  /** One line saying what was refused and why, for the log and the console. */
  detail: string;
};

/** A write the bus may make, with the recipients it changes. */
export type RoutingApproval = { ok: true; added: readonly RoutingRecipient[]; removed: readonly RoutingRecipient[] };

export type RoutingDecision = RoutingApproval | RoutingRefusal;

/** The key two recipients are compared by: a position as itself, a seat by its registry id. */
function keyOf(recipient: RoutingRecipient): string {
  return typeof recipient === 'string' ? recipient : `seat:${recipient.seat}`;
}

function sameRecipient(left: RoutingRecipient, right: RoutingRecipient): boolean {
  return keyOf(left) === keyOf(right);
}

function requesterOf(actor: RoutingActor): string {
  if (actor.kind === 'owner') return 'owner';
  return actor.registryId ?? actor.seat;
}

/** Whether a recipient names the actor itself, the act the privileged ban is about. */
function namesActor(recipient: RoutingRecipient, actor: RoutingActor): boolean {
  if (actor.kind === 'owner' || typeof recipient === 'string') return false;
  return recipient.seat === actor.registryId || recipient.seat === actor.seat;
}

/** Whether a grant's granted kind covers the kind being routed, by the same prefix rule. */
function grantNamesKind(granted: readonly string[], kind: string): boolean {
  return granted.some((one) => (one.endsWith('*') ? kind.startsWith(one.slice(0, -1)) : one === kind));
}

function refuse(write: RoutingWrite, rule: RoutingRule, detail: string): RoutingRefusal {
  return { ok: false, rule, requester: requesterOf(write.actor), kind: write.kind, level: write.level, detail };
}

/**
 * Judges one routing write. It reads nothing: the caller hands in the actor, the privileged list
 * in force and the recipients standing above the write, so the answer is the same on every
 * machine and in every test.
 */
export function checkRoutingWrite(write: RoutingWrite): RoutingDecision {
  const privileged = write.privileged ?? PRIVILEGED_KINDS;
  const isPrivileged = isPrivilegedKind(write.kind, privileged);
  const added = write.change.add ?? [];
  const removed = write.change.remove ?? [];
  const actor = write.actor;

  if (isPrivileged && actor.kind !== 'owner') {
    // The act the ban is on: a seat adding itself as a recipient of a privileged kind. A seat
    // that is already a default recipient is not self-subscribing; only an explicit add is.
    if (added.some((recipient) => namesActor(recipient, actor))) {
      return refuse(
        write,
        'privileged-self-subscription',
        `${write.kind} is a privileged kind: ${requesterOf(actor)} may not add itself as a recipient`,
      );
    }
    if (actor.kind === 'seat') {
      return refuse(
        write,
        'privileged-owner-only',
        `${write.kind} is a privileged kind: only the owner routes it, or a holder whose grant names it`,
      );
    }
    if (!grantNamesKind(actor.kinds, write.kind)) {
      return refuse(
        write,
        'privileged-owner-only',
        `${write.kind} is a privileged kind: the grant held by ${requesterOf(actor)} does not name it`,
      );
    }
  }

  // A seat acting by itself may only add itself, at its own level. Every other write is the
  // owner's or a grant holder's to make.
  if (!isPrivileged && actor.kind === 'seat') {
    const other = added.find((recipient) => !namesActor(recipient, actor));
    if (write.level !== 'seat' || other !== undefined) {
      return refuse(
        write,
        'seat-adds-itself-only',
        `a seat may add only itself, at its own level; ${requesterOf(actor)} tried to add ${other === undefined ? 'at another level' : keyOf(other)}`,
      );
    }
  }

  for (const recipient of removed) {
    // A privileged kind's default recipients stand, whatever a level says.
    if (isPrivileged && (EVENT_ROUTING_DEFAULTS[write.kind] ?? []).some((one) => sameRecipient(one, recipient))) {
      return refuse(
        write,
        'privileged-default-stands',
        `${write.kind} is a privileged kind: its default recipient ${keyOf(recipient)} stands and no level removes it`,
      );
    }
    if (write.inherited.some((one) => sameRecipient(one, recipient))) {
      return refuse(
        write,
        'routing-removes-inherited',
        `${keyOf(recipient)} was set above ${write.level}; a level adds recipients, it removes none`,
      );
    }
  }

  return { ok: true, added, removed };
}

/**
 * The recipients of one kind after the whole chain: the defaults, then each level's additions in
 * inheritance order. A removal only ever takes what its own word added — what stands above the
 * word is not its to remove, which `checkRoutingWrite` says out loud before a write is made.
 * A privileged kind's default recipients are added back at the end: the fold is defensive, and
 * the invariant stands even when a hand-built chain skipped the check.
 */
export function resolveRouting(
  kind: string,
  chain: RoutingChain,
  options: { defaults?: EventRouting; privileged?: readonly string[] } = {},
): readonly RoutingRecipient[] {
  const defaults = (options.defaults ?? EVENT_ROUTING_DEFAULTS)[kind] ?? [];
  const privileged = options.privileged ?? PRIVILEGED_KINDS;
  const isPrivileged = isPrivilegedKind(kind, privileged);
  const out: RoutingRecipient[] = [...defaults];
  for (const level of POLICY_LEVELS) {
    for (const declaration of chain) {
      if (declaration.level !== level) continue;
      const change = declaration.word[kind];
      if (change === undefined) continue;
      const addedHere: RoutingRecipient[] = [];
      for (const recipient of change.add ?? []) {
        if (out.some((one) => sameRecipient(one, recipient))) continue;
        out.push(recipient);
        addedHere.push(recipient);
      }
      for (const recipient of change.remove ?? []) {
        if (!addedHere.some((one) => sameRecipient(one, recipient))) continue;
        const at = out.findIndex((one) => sameRecipient(one, recipient));
        if (at >= 0) out.splice(at, 1);
      }
    }
  }
  if (isPrivileged) {
    for (const recipient of defaults) {
      if (!out.some((one) => sameRecipient(one, recipient))) out.push(recipient);
    }
  }
  return out;
}

/** The operational log's refusal record (Kernel §15's shape): one line, every field visible. */
export type RoutingRefusalRecord = {
  v: 1;
  at: string;
  rule: RoutingRule;
  requester: string;
  kind: string;
  level: PolicyLevel;
  detail: string;
};

export function refusalRecord(refusal: RoutingRefusal, at: Date): RoutingRefusalRecord {
  return {
    v: 1,
    at: at.toISOString(),
    rule: refusal.rule,
    requester: refusal.requester,
    kind: refusal.kind,
    level: refusal.level,
    detail: refusal.detail,
  };
}

/**
 * The event a refused write raises: `team.policy-refused`, carrying the rule, the requester and
 * the kind. Its recipients are the defaults' — the owner only, the answer the plan's twelfth
 * question settled; the operational log holds the whole record for every reader, so the lead is
 * not left without a word. The record is the truth; this shapes the event derived from it.
 */
export type PolicyRefusedEvent = {
  kind: 'team.policy-refused';
  at: string;
  recipients: readonly RoutingRecipient[];
  rule: RoutingRule;
  requester: string;
  refusedKind: string;
  level: PolicyLevel;
};

export function policyRefusedEvent(refusal: RoutingRefusal, at: Date): PolicyRefusedEvent {
  return {
    kind: 'team.policy-refused',
    at: at.toISOString(),
    recipients: EVENT_ROUTING_DEFAULTS['team.policy-refused'] ?? ['owner'],
    rule: refusal.rule,
    requester: refusal.requester,
    refusedKind: refusal.kind,
    level: refusal.level,
  };
}
