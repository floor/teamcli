// Who a record's `from` is. The checkout's message key proves that a record was not changed
// after it was signed; every seat runs as the owner's user and can read that same key, so the
// signature is integrity, not identity (`src/store/keys.ts`). A reader that prints a sender is
// printing an attribution, never a verification.
//
// One binding says who the record is: the launch's own general seat brief, whose id, lifetime
// and delivered-body digest are the seat's current claim. A text reader marks that `(attributed)`.
// Every other signed record rests on the shared checkout key alone, and the reader says so as an
// unverified claim. This version persists no separate seat key. A client record has no signature
// this version persists, so it is unattributed here too.

import { GENERAL_BRIEF_FROM, GENERAL_BRIEF_RULE, type CurrentBriefClaim } from '../launch/general-brief.ts';
import { encodeIdentity, principalOf, registryIdentityView, senderIdentity, type FromIdentity, type IdentityView } from '../comms/identity.ts';
import { getAgent } from '../registry/agents.ts';
import type { RecordPayload } from './record.ts';

/** What a reader knows about a record's sender. `unverified_claim` rests on the shared checkout
 *  key alone, which a text reader prints as an unverified claim; `launch-brief` is the launch's
 *  delivery bound to the seat's current claim, which the text reader prints as attributed;
 *  `none` is no attribution at all — an unsigned file, a marker's word, or a record no key could
 *  vouch for. A row may name a sender and still be `none`: the name is then what the file says,
 *  not who it is. */
export type SenderAttribution = 'unverified_claim' | 'launch-brief' | 'none';

/** The parenthetical a text reader appends to a sender name. The JSON field keeps its own words. */
export function senderReading(attribution: SenderAttribution): string {
  if (attribution === 'launch-brief') return '(attributed)';
  if (attribution === 'none') return '(unattributed)';
  return '(unverified claim)';
}

export type SenderClaimContext = {
  /** The reading seat's current general-brief claim, when the reader holds one. A brief record is
   *  attributed to the launch only against it. */
  briefClaim?: CurrentBriefClaim | null;
};

export type SenderRenderContext = {
  /** The verified record payload when available: its signed `from_identity` names the sender. */
  record?: RecordPayload | null;
  /** The verified sender's registry id when the reader has it without the whole record. */
  fromId?: string | null;
  /** Home directory for the registry's identity view. */
  home?: string;
  /** Checkout root (kept for callers; the identity reads the registry by id only). */
  root?: string;
  /** The verified admission rule. The body's opening line never supplies this. */
  rule?: string | null;
  /** The send instant (ISO or Date). The record's own `at` wins when it is handed in. */
  at?: string | Date | null;
  /** When true, only the first non-empty content line of the body is rendered (compact socket frame). */
  compact?: boolean;
  /** The identity view to read, when the caller holds one (tests, a reading over many rows). */
  view?: IdentityView;
};

/**
 * How a verified record's sender is attributed. The record has already been checked against the
 * message key by the caller; this compares what the record claims about itself with what the
 * seat's own state says. A general seat brief's sender is the launch, and the attribution is the
 * delivery the seat's current claim names: same id, same incarnation, same digest. Any other
 * record, and any brief the claim does not name, rests on the shared key.
 */
export function attributeSenderClaim(
  payload: Pick<RecordPayload, 'from' | 'rule' | 'id'> & Partial<Pick<RecordPayload, 'incarnation' | 'brief_sha256'>>,
  context: SenderClaimContext = {},
): 'unverified_claim' | 'launch-brief' {
  const claim = context.briefClaim ?? null;
  const launch = payload.from === GENERAL_BRIEF_FROM && payload.rule === GENERAL_BRIEF_RULE;
  if (claim !== null && launch
    && payload.id === claim.id
    && payload.incarnation === claim.incarnation
    && payload.brief_sha256 === claim.sha256) {
    return 'launch-brief';
  }
  return 'unverified_claim';
}

/** The sender header every sent body opens with: `from <claimed> — admitted by: <rule>`, then the
 *  body under one empty line. */
const SENDER_HEADER = /^from ([^\n]*?) — admitted by: ([^\n]*)\n\n?/;

/**
 * Maps a full admission rule string to its short parenthetical phrase for compact delivery
 * rendering. The full rule remains in `payload.rule`, `payload.body` on disk, and `team trace`.
 */
export function compactRule(rule: string): string {
  const trimmed = rule.trim();
  switch (trimmed) {
    case 'a client grant, to the entity orchestrator':
    case 'a client bundle grant, to a granted seat':
      return 'owner relay';
    case "a seat to its own team's orchestrator":
      return 'to orchestrator';
    case 'an orchestrator or operator to a seat of its own team':
    case 'the lead to a seat of its own team':
      return 'team lead';
    case 'an orchestrator to another orchestrator':
      return 'orchestrator';
    case 'an operator to another operator of its own team':
      return 'operator';
    case 'a seat to a declared seat of its own team':
      return 'same team';
    case "an assistant seat to its entity's coordinator":
      return 'assistant';
    case "the entity's main orchestrator to any seat of the entity's teams":
      return 'main orchestrator';
    case 'the project lead and the leads of its teams':
      return 'project lead';
    case 'team leads within one project to each other':
      return 'project leads';
    case 'seats crossing teams within one project, where the project allows it':
      return 'cross-team';
    case 'a reply to the sender of a record on an open thread':
    case "a seat replying to the entity's main orchestrator on its thread":
    case 'a reply on a client thread, to the client that opened it':
      return 'reply';
    case 'the owner':
      return 'owner';
    case 'the launch delivers it to every seat of its team':
      return 'launch brief';
    case "the watch's direct-work authority":
      return 'direct-work';
    case "the daemon's reminder authority":
      return 'reminder';
    case "the daemon's stuck-child notice":
    case "the daemon's blocked-episode notice":
    case "the daemon's drops-archive notice":
      return 'daemon';
    default: {
      const grantMatch = /^an owner-signed grant naming send \((.+)\)$/.exec(trimmed);
      if (grantMatch !== null) return `grant ${grantMatch[1]}`;
      if (trimmed === 'an owner-signed grant naming send') return 'send grant';
      return trimmed;
    }
  }
}

/**
 * The profile's display kind for a non-Claude seat CLI, or `null` for a Claude seat (or unknown).
 * Uses the profile's display kind, never the model's, so the opening words correct the host
 * wrapper's "another session of its own kind" label when the sender is not a Claude seat.
 */
export function seatKindPrefix(cli: string | null | undefined): string | null {
  switch (cli) {
    case 'antigravity':
    case 'agy':
    case 'gemini':
      return 'Gemini seat';
    case 'codex':
      return 'Codex seat';
    case 'grok':
      return 'Grok seat';
    case 'muse':
      return 'Muse seat';
    case 'cursor':
      return 'Cursor seat';
    case 'jules':
      return 'Jules seat';
    default:
      return null;
  }
}

/** Compatibility forms and case. NFKC folds those forms, and letter case folds; homoglyphs and punctuation stay distinct. */
function normalizedSenderName(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

/**
 * Extracts the first non-empty line of a message body (excluding the `from … — admitted by: …`
 * header) for compact socket delivery.
 */
export function firstContentLine(text: string): string {
  for (const line of text.split('\n')) {
    if (line.trim() !== '') return line;
  }
  return '';
}

/** The send instant, or now when the record's own time is missing or unreadable, as UTC
 *  `YYYY-MM-DD HH:MMZ`: the clock reads on the receiver's line are the send's, never the
 *  render's. */
export function utcStamp(at?: string | Date | null): string {
  const date = at instanceof Date ? at : typeof at === 'string' ? new Date(at) : new Date();
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const iso = safe.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

/**
 * The receiver's one sender line, shared by every leg (the socket, channel, typed and read legs):
 *
 *   `<name> · <seat>@<team> · <model> · <YYYY-MM-DD HH:MMZ> · admitted: <short rule>`
 *
 * The identity is the record's signed `from_identity`, else the registry's answer for the
 * verified `from` and `from_id` (src/comms/identity.ts). A principal with no address or model
 * (the owner, the runtime) prints the fields it has. No short rule means no admission tail.
 */
export function receiverHeaderLine(identity: FromIdentity, rule: string, at?: string | Date | null): string {
  const shown = encodeIdentity(identity);
  const parts = [shown.name];
  if (shown.address !== undefined) parts.push(shown.address);
  if (shown.model !== undefined) parts.push(shown.model);
  parts.push(utcStamp(at));
  const shortRule = compactRule(rule);
  if (shortRule !== '') parts.push(`admitted: ${shortRule}`);
  return parts.join(' · ');
}

/** The view a render reads: the caller's, else the registry under `home`, else none at all. */
function viewOf(context: SenderRenderContext): IdentityView {
  if (context.view !== undefined) return context.view;
  if (context.home !== undefined) return registryIdentityView(context.home);
  return { seatById: () => null, otherSeats: () => [] };
}

/**
 * The identity a rendered record names: its signed `from_identity` when it is stamped and carries
 * one, else `senderIdentity` over the verified `from` and `from_id`, by registry id only.
 */
export function renderedIdentity(claimed: string, context: SenderRenderContext = {}): FromIdentity {
  const record = context.record ?? null;
  if (record?.from_identity !== undefined) return record.from_identity;
  const fromId = context.fromId ?? record?.from_id ?? null;
  const principal = principalOf({
    from: record?.from ?? claimed,
    from_id: fromId,
    ...(record?.from_client === undefined ? {} : { from_client: record.from_client }),
  });
  try {
    return senderIdentity(viewOf(context), principal);
  } catch {
    return senderIdentity({ seatById: () => null, otherSeats: () => [] }, principal);
  }
}

/** The names a body's own opening line may carry for this sender and still be folded away. */
function verifiedNamesOf(claimed: string, identity: FromIdentity, context: SenderRenderContext): string[] {
  const names = [claimed, identity.name];
  if (identity.address !== undefined) names.push(identity.address);
  const principal = principalOf({ from: context.record?.from ?? claimed, from_id: context.fromId ?? context.record?.from_id ?? null, ...(context.record?.from_client === undefined ? {} : { from_client: context.record.from_client }) });
  if (principal.kind === 'owner') names.push('the owner');
  if (principal.kind === 'runtime') names.push('the watch', 'the daemon', 'watch', 'daemon');
  if (principal.kind === 'seat' && principal.id !== null) {
    try {
      const seat = viewOf(context).seatById(principal.id);
      if (seat !== null) {
        for (const name of [seat.signedNickname, seat.nickname]) if (name !== null) names.push(name);
        names.push(`${seat.seat}@${seat.teamName}`);
      }
      if (context.home !== undefined) {
        const agent = getAgent(context.home, principal.id);
        if (agent !== null) names.push(agent.name);
      }
    } catch {
      // A registry that cannot answer adds no name.
    }
  }
  return names;
}

/**
 * Renders the body of a message with its sender line at display time, leaving the stored
 * record's `payload.body` and `payload.rule` untouched on disk.
 *
 * The line is the verified sender (`renderedIdentity`) and the verified rule; no caller can hand
 * in another name. A body that opens with `from <name> — admitted by: <rule>` does not choose
 * either: that line is dropped from the content only when the name is one of the sender's own
 * verified names after width and case folding and the rule is the verified rule exactly; any
 * other opening line stays content. When `context.compact` is true, only the first non-empty
 * content line is rendered.
 */
export function attributedBody(body: string, claimed: string, context: SenderRenderContext = {}): string {
  const isClient = context.record?.from_client !== undefined || claimed.startsWith('client:');
  const renderRest = (text: string): string => (context.compact === true ? firstContentLine(text) : text);
  const rule = context.record?.rule ?? context.rule ?? (isClient ? 'a client grant, to the entity orchestrator' : '');
  const identity = renderedIdentity(claimed, context);
  const header = SENDER_HEADER.exec(body);
  const verifiedNames = verifiedNamesOf(claimed, identity, context);
  const sameSender = (left: string, right: string): boolean =>
    normalizedSenderName(left) === normalizedSenderName(right);
  const openingName = header?.[1] ?? '';
  const openingAgrees = header !== null
    && verifiedNames.some((name) => sameSender(name, openingName))
    && (header[2] ?? '') === rule;
  const rest = renderRest(openingAgrees ? body.slice(header[0].length) : body);
  const at = context.at ?? context.record?.at ?? null;
  return `${receiverHeaderLine(identity, rule, at)}\n\n${rest}`;
}
