// Who a record's `from` is. The checkout's message key proves that a record was not changed
// after it was signed; every seat runs as the owner's user and can read that same key, so the
// signature is integrity, not identity (`src/store/keys.ts`). A reader that prints a sender is
// printing an attribution, never a verification.
//
// One attribution rests on more than the shared key: the launch's own general seat brief, whose
// id, lifetime and delivered-body digest must be the seat's current claim. It is still an
// attribution — a local claim, not proof of who wrote the record — and the reader marks it the
// same way. Every other record is signed with the shared checkout key and attributed on that
// alone. A client record has no signature this version persists, so it is unattributed here too.

import { GENERAL_BRIEF_FROM, GENERAL_BRIEF_RULE, type CurrentBriefClaim } from '../launch/general-brief.ts';
import type { RecordPayload } from './record.ts';

/** What a reader knows about a record's sender. `attributed` rests on the shared checkout key;
 *  `launch-brief` is that and the launch's delivery bound to the seat's current claim; `none` is
 *  no attribution at all — an unsigned file, a marker's word, or a record no key could vouch for.
 *  A row may name a sender and still be `none`: the name is then what the file says, not who it is. */
export type SenderAttribution = 'attributed' | 'launch-brief' | 'none';

export type SenderClaimContext = {
  /** The reading seat's current general-brief claim, when the reader holds one. A brief record is
   *  attributed to the launch only against it. */
  briefClaim?: CurrentBriefClaim | null;
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

/** The one-line mark a reader puts above a body: the sender is attributed, and the name is the
 *  record's claim. It is always present, so its absence never reads as verification. */
export function attributionBanner(claimed: string): string {
  return `[attributed sender: ${claimed}]`;
}

/** The sender header every sent body opens with: `from <claimed> — admitted by: <rule>`, then the
 *  body under one empty line. */
const SENDER_HEADER = /^from ([^\n]*?) — admitted by: ([^\n]*)\n\n?/;

/**
 * The body of a message under its sender mark. A send's own header line keeps its claimed name
 * and rule and gains `(attributed)`, so the reader sees an attribution, not an identity; a body
 * with no such first line takes the banner instead, naming the record's claimed sender. The
 * words of the message itself are never rewritten.
 */
export function attributedBody(body: string, claimed: string): string {
  const header = SENDER_HEADER.exec(body);
  if (header === null) return `${attributionBanner(claimed)}\n\n${body}`;
  const name = header[1] ?? claimed;
  const rule = header[2] ?? '';
  return `from ${name} (attributed) — admitted by: ${rule}\n\n${body.slice(header[0].length)}`;
}
