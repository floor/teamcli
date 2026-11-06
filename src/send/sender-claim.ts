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

import { readTeamConfig } from '../file/team-config.ts';
import { GENERAL_BRIEF_FROM, GENERAL_BRIEF_RULE, type CurrentBriefClaim } from '../launch/general-brief.ts';
import { getAgent } from '../registry/agents.ts';
import type { RecordPayload } from './record.ts';

/** What a reader knows about a record's sender. `attributed` rests on the shared checkout key
 *  alone, which a text reader prints as an unverified claim; `launch-brief` is the launch's
 *  delivery bound to the seat's current claim, which the text reader prints as attributed;
 *  `none` is no attribution at all — an unsigned file, a marker's word, or a record no key could
 *  vouch for. A row may name a sender and still be `none`: the name is then what the file says,
 *  not who it is. */
export type SenderAttribution = 'attributed' | 'launch-brief' | 'none';

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
  /** The verified record payload when available. */
  record?: RecordPayload | null;
  /** The verified sender's registry id when the reader has it without the whole record. */
  fromId?: string | null;
  /** Home directory for agent/team registry lookup. */
  home?: string;
  /** Checkout root for fallback seat CLI lookup. */
  root?: string;
  /** Explicit sender CLI override when known. */
  cli?: string | null;
  /** Explicit sender display name override (e.g. nickname/label resolved for a socket frame). */
  displayName?: string | null;
  /** Explicit preformatted sender label override (e.g. `"Gemini seat Argon"`). */
  senderLabel?: string | null;
  /** The verified admission rule. The body's opening line never supplies this. */
  rule?: string | null;
  /** When true, only the first non-empty content line of the body is rendered (compact socket frame). */
  compact?: boolean;
};

/**
 * How a verified record's sender is attributed. The record has already been checked against the
 * message key by the caller; this compares what the record claims about itself with what the
 * seat's own state says. A general seat brief's sender is the launch, and the attribution is the
 * delivery the seat's current claim names: same id, same incarnation, same digest. Any other
 * record, and any brief the claim does not name, rests on the shared key.
 */
export function attributeSenderClaim(
  payload: RecordPayload,
  context: SenderClaimContext = {},
): 'attributed' | 'launch-brief' {
  const claim = context.briefClaim ?? null;
  const launch = payload.from === GENERAL_BRIEF_FROM && payload.rule === GENERAL_BRIEF_RULE;
  if (claim !== null && launch
    && payload.id === claim.id
    && payload.incarnation === claim.incarnation
    && payload.brief_sha256 === claim.sha256) {
    return 'launch-brief';
  }
  return 'attributed';
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

function isSystemOrOwner(claimed: string, displayName: string): boolean {
  return (
    claimed === 'owner' ||
    claimed === 'the owner' ||
    claimed === 'watch' ||
    claimed === 'the watch' ||
    claimed === 'daemon' ||
    claimed === 'the daemon' ||
    claimed === GENERAL_BRIEF_FROM ||
    displayName === 'the owner' ||
    displayName === 'owner' ||
    displayName === 'the watch' ||
    displayName === 'the daemon' ||
    displayName === GENERAL_BRIEF_FROM
  );
}

function clientDisplayName(claimed: string, clientId?: string): string {
  const id = clientId ?? (claimed.startsWith('client:') ? claimed.slice('client:'.length) : claimed);
  if (id === 'grok-bot') return 'Grok Bot';
  return id;
}

/** Compatibility forms and case. NFKC folds those forms, and letter case folds; homoglyphs and punctuation stay distinct. */
function normalizedSenderName(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

/** The registry's name for the verified sender, when the record names an agent this home has. */
function registrySenderName(context: SenderRenderContext): string | null {
  const fromId = context.fromId ?? context.record?.from_id ?? null;
  if (fromId === null || context.home === undefined) return null;
  try {
    const agent = getAgent(context.home, fromId);
    return agent === null ? null : agent.name;
  } catch {
    return null;
  }
}

function resolveSenderCli(context: SenderRenderContext, claimed: string): string | null {
  if (context.cli !== undefined && context.cli !== null) return context.cli;
  const fromId = context.fromId ?? context.record?.from_id ?? null;
  if (fromId !== null && context.home !== undefined) {
    try {
      const agent = getAgent(context.home, fromId);
      if (agent !== null) return agent.cli;
    } catch {
      // Fallback to team file below.
    }
  }
  const root = context.root ?? context.record?.root;
  const seatName = context.record?.from ?? claimed;
  if (root !== undefined && seatName !== '') {
    try {
      const loaded = readTeamConfig(root, context.home === undefined ? undefined : { home: context.home });
      if (loaded.ok) {
        const seat = loaded.team.seats.find((one) => one.name === seatName);
        if (seat !== undefined) return seat.cli;
      }
    } catch {
      // Ignore config read errors on fallback.
    }
  }
  return null;
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

/**
 * Formats the single-line compact sender header for a rendered message:
 * - Client:      `"Client <Name> (<short rule>):"` (or `"Client <Name>:"` when no rule is given)
 * - Non-Claude:  `"<Kind> seat <Name> (<short rule>):"` (or `"<Kind> seat <Name>:"` when no rule is given)
 * - Claude/else: `"from <Name> (<short rule>):"` (or `"from <Name>:"` when no rule is given)
 */
export function compactSenderHeader(
  name: string,
  rule = '',
  options: { client?: boolean; cli?: string | null; preformatted?: boolean } = {},
): string {
  const shortRule = compactRule(rule);
  const ruleSuffix = shortRule === '' ? '' : ` (${shortRule})`;
  if (options.preformatted === true) {
    return `${name}${ruleSuffix}:`;
  }
  if (options.client === true) {
    return `Client ${name}${ruleSuffix}:`;
  }
  const kind = seatKindPrefix(options.cli);
  if (kind !== null) {
    return `${kind} ${name}${ruleSuffix}:`;
  }
  return `from ${name}${ruleSuffix}:`;
}

/**
 * Renders the body of a message with its compact sender header at display time, leaving the
 * stored record's `payload.body` and `payload.rule` untouched on disk.
 *
 * The header is the verified sender and the verified rule. Its spelling is the display name,
 * the registry name, or the claimed name, in that order. A body that opens with
 * `from <name> — admitted by: <rule>` does not choose either. That line is dropped from the
 * content only when the name matches a verified name after width and case folding and the rule
 * is the verified rule exactly; any other opening line stays content.
 * A client record (`from_client` or `client:<id>`) renders `Client <Name> (<short rule>):`.
 * When `context.compact` is true, only the first non-empty content line is rendered.
 */
export function attributedBody(body: string, claimed: string, context: SenderRenderContext = {}): string {
  const isClient = context.record?.from_client !== undefined || claimed.startsWith('client:');
  const renderRest = (text: string): string => (context.compact === true ? firstContentLine(text) : text);
  const rule = context.record?.rule ?? context.rule ?? (isClient ? 'a client grant, to the entity orchestrator' : '');
  const header = SENDER_HEADER.exec(body);
  const verifiedNames = [claimed];
  if (context.displayName !== undefined && context.displayName !== null && context.displayName !== '') {
    verifiedNames.push(context.displayName);
  }
  const registered = registrySenderName(context);
  if (registered !== null && registered !== '') verifiedNames.push(registered);
  const sameSender = (left: string, right: string): boolean =>
    normalizedSenderName(left) === normalizedSenderName(right);
  const openingName = header?.[1] ?? '';
  const openingAgrees = header !== null
    && verifiedNames.some((name) => sameSender(name, openingName))
    && (header[2] ?? '') === rule;
  const rest = renderRest(openingAgrees ? body.slice(header[0].length) : body);
  if (context.senderLabel && context.senderLabel !== '') {
    return `${compactSenderHeader(context.senderLabel, rule, { preformatted: true })}\n\n${rest}`;
  }
  if (isClient) {
    const display =
      context.displayName && context.displayName !== ''
        ? context.displayName
        : clientDisplayName(claimed, context.record?.from_client?.client_id);
    return `${compactSenderHeader(display, rule, { client: true })}\n\n${rest}`;
  }
  const display =
    context.displayName && context.displayName !== ''
      ? context.displayName
      : registered !== null && registered !== ''
        ? registered
        : claimed;
  const cli = isSystemOrOwner(claimed, display) ? null : resolveSenderCli(context, claimed);
  return `${compactSenderHeader(display, rule, { cli })}\n\n${rest}`;
}
