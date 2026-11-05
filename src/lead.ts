// The team's lead, by seat name: which seat leads when the team file marks none. The file's own
// `leads: true` still decides it; this chain only picks a default. The levels,
// widest first, are the universe's suggestion, the entity's word, the home project's word and the
// team file's own `lead:` field. The most specific level that declares one wins; a narrower level
// does not have to repeat a wider one. Nothing here is authority: the word names a seat, and every
// admission, grant and rules line still keys on the resolved lead seat `leads: true` names
// (`src/file/sections/lead.ts`).
//
// The code term is `lead`; `orchestrator` is display only and no path in this module or
// `src/lead-chain.ts` reads it.

/** The levels that may declare a default lead, widest first: the order the widest word is
 *  overridden in. */
export const LEAD_LEVELS = ['universe', 'entity', 'project', 'team'] as const;
export type LeadLevel = (typeof LEAD_LEVELS)[number];

/** Each level's word, when the level declares one. A level an older chain never read is absent. */
export type LeadChain = Partial<Record<LeadLevel, string>>;

/** The word in force and the level it came from: `universe` when no setting names one. */
export type ResolvedLead = { lead: string; level: LeadLevel };

/** The most specific declared word, or null when no level declares one. Iterates nearest-first,
 *  so a team word wins over a project word, which wins over an entity word, which wins over the
 *  universe's default. */
export function resolveLead(chain: LeadChain): ResolvedLead | null {
  for (let at = LEAD_LEVELS.length - 1; at >= 0; at -= 1) {
    const level = LEAD_LEVELS[at]!;
    const word = chain[level];
    if (word !== undefined) return { lead: word, level };
  }
  return null;
}

/** The shape a seat name takes in every level's word. The same letters `SEAT_NAME` and the
 *  declared clients' `SEAT_WORD` take (`src/file/sections/seats.ts`, `src/entities.ts`): one word,
 *  starting with a letter or digit, at most 64 characters. The lead is a name, never a role word
 *  or a phrase. */
const LEAD_WORD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Why `word` cannot name a lead seat, or null when it can. */
export function leadWordProblem(word: string): string | null {
  if (!LEAD_WORD.test(word)) return 'must be one seat name: letters, digits, ".", "_" or "-", at most 64 characters';
  return null;
}
