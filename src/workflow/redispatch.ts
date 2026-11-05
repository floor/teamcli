// The redispatch-max check. A step may be re-dispatched `REDISPATCH_MAX` times. Past that the
// run goes failed, unless the lead's word authorizes one further redispatch. An authority step
// keeps its refusal either way. The word is audited by the caller; this function only decides.

/** Re-dispatches one step may take before the run goes failed. */
export const REDISPATCH_MAX = 2;

/** An owner or grant confirmation is an authority step. Those keep their refusal. */
export function authorityConfirmation(confirmationClass: 'none' | 'owner' | 'grant'): boolean {
  return confirmationClass === 'owner' || confirmationClass === 'grant';
}

/** The lead's word for one rerun past the max. Any other actor is not this override. */
export type LeadWord = {
  by: string;
  at: string;
  reason: string;
};

export type RedispatchCheck = {
  /** Re-dispatches this step has already recorded. */
  taken: number;
  /** An authority step (an owner or grant confirmation) keeps its refusal. */
  authority: boolean;
  /** The lead's word, when one was given and not yet spent. */
  lead?: LeadWord;
  max?: number;
};

export type RedispatchVerdict =
  | { action: 'redispatch'; audit: LeadWord | null }
  | { action: 'step-failed'; why: string }
  | { action: 'refused'; why: string };

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function leadWord(word: LeadWord | undefined): LeadWord | null {
  if (word === undefined) return null;
  if (word.by !== 'lead') return null;
  if (word.reason.trim() === '') return null;
  if (!ISO_INSTANT.test(word.at)) return null;
  return { by: 'lead', at: word.at, reason: word.reason };
}

/**
 * Whether the next redispatch of a step is allowed. Fewer than `max` taken redispatches pass.
 * At the max, the run goes failed unless the lead's word covers this one. An authority step
 * is refused before either of those.
 */
export function redispatchCheck(input: RedispatchCheck): RedispatchVerdict {
  if (input.authority) {
    return { action: 'refused', why: 'an authority step keeps its refusal' };
  }
  const max = input.max ?? REDISPATCH_MAX;
  if (input.taken < max) return { action: 'redispatch', audit: null };
  const word = leadWord(input.lead);
  if (word !== null) return { action: 'redispatch', audit: word };
  return { action: 'step-failed', why: `past redispatch-max (${max})` };
}
