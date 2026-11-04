// Who a record's `from` is. The checkout's message key proves that a record was not changed
// after it was signed; every seat runs as the owner's user and can read that same key, so the
// signature is integrity, not identity (`src/store/keys.ts`). A reader that prints a sender is
// printing a claim, and must say so unless the claim verifies.
//
// One claim verifies at read time today: the launch's own general seat brief, whose id, lifetime
// and delivered-body digest must be the seat's current claim. Every other record — a seat, the
// owner, an orchestrator relaying an owner decision — carries `shared-key-only`: signed with the
// shared key, and nothing more. A client record has no signature this version persists, so it is
// unverified here too.

import { GENERAL_BRIEF_FROM, GENERAL_BRIEF_RULE, type CurrentBriefClaim } from '../launch/general-brief.ts';
import type { RecordPayload } from './record.ts';

/** What a sender claim rests on. `launch-brief` is the launch's own delivery, bound to the
 *  seat's current claim; `shared-key-only` is everything else, which the shared key signed. */
export type SenderTrust = 'launch-brief' | 'shared-key-only';

export type SenderVerification = { verified: boolean; trust: SenderTrust };

export type SenderClaimContext = {
  /** The reading seat's current general-brief claim, when the reader holds one. A brief record is
   *  verified only against it. */
  briefClaim?: CurrentBriefClaim | null;
};

const SHARED_ONLY: SenderVerification = { verified: false, trust: 'shared-key-only' };

/**
 * Whether a verified record's sender claim verifies too. The record has already been checked
 * against the message key by the caller; this compares what the record claims about itself with
 * what the seat's own state says. A general seat brief's sender is the launch, and its identity
 * is the delivery the seat's current claim names: same id, same incarnation, same digest. Any
 * other record, and any brief the claim does not name, is a shared-key claim.
 */
export function verifySenderClaim(payload: RecordPayload, context: SenderClaimContext = {}): SenderVerification {
  const claim = context.briefClaim ?? null;
  const launch = payload.from === GENERAL_BRIEF_FROM && payload.rule === GENERAL_BRIEF_RULE;
  if (claim !== null && launch
    && payload.id === claim.id
    && payload.incarnation === claim.incarnation
    && payload.brief_sha256 === claim.sha256) {
    return { verified: true, trust: 'launch-brief' };
  }
  return SHARED_ONLY;
}

/** The one-line banner a reader puts on a message whose sender claim does not verify. It names
 *  the claim, never the claim as fact. */
export function unverifiedBanner(claimed: string): string {
  return `[unverified sender: claimed ${claimed}]`;
}

/** The sender header every sent body opens with: `from <claimed> — admitted by: <rule>`, then the
 *  body under one empty line. */
const SENDER_HEADER = /^from ([^\n]*?) — admitted by: ([^\n]*)\n\n?/;

/**
 * The body of a message whose sender claim does not verify. A send's own header line keeps its
 * claimed name and rule and gains the mark, so the reader sees the quote and the rule as claims;
 * a body with no such first line takes the banner instead, naming the record's claimed sender.
 * The words of the message itself are never rewritten.
 */
export function unverifiedBody(body: string, claimed: string): string {
  const header = SENDER_HEADER.exec(body);
  if (header === null) return `${unverifiedBanner(claimed)}\n\n${body}`;
  const name = header[1] ?? claimed;
  const rule = header[2] ?? '';
  return `from ${name} [unverified sender — shared checkout key only] — admitted by: ${rule} (unverified claim)\n\n${body.slice(header[0].length)}`;
}
