// The words of a general grant the owner signs for a machine whose owner seat is pinned: the
// grant's own fields in one canonical spelling. It reads no file and imports nothing, so the card
// the owner answers and the check at every use read them the same way (src/client/pinned-grant.ts).

const VERB = 'general-grant';

export type PinnedGrantTerms = { to: string; publicKey: string; entities: string[]; ops: string[]; mayIssue: boolean; days: number };

export function pinnedGrantWords(terms: PinnedGrantTerms): string[] {
  return [
    VERB,
    `to=${terms.to}`,
    `public-key=${terms.publicKey}`,
    `entities=${[...terms.entities].sort().join(',')}`,
    `ops=${[...terms.ops].sort().join(',')}`,
    `may-issue=${terms.mayIssue ? 'yes' : 'no'}`,
    `days=${terms.days}`,
  ];
}

/** Whether these words are this form: the ordinary request binds the command line (`--to`) instead. */
export function namesPinnedGrant(words: readonly string[] | undefined): boolean {
  return words?.[0] === VERB && words[1]?.startsWith('to=') === true;
}

/** The grant's fields, or why these are not its canonical words. */
export function parsePinnedGrantWords(words: readonly string[]): PinnedGrantTerms | string {
  if (words.length !== 7 || !namesPinnedGrant(words)) return 'the request is not a general grant for a pinned machine';
  const field = (at: number, name: string): string | null => (words[at]!.startsWith(`${name}=`) ? words[at]!.slice(name.length + 1) : null);
  const to = field(1, 'to');
  const publicKey = field(2, 'public-key');
  const entities = field(3, 'entities');
  const ops = field(4, 'ops');
  const mayIssue = field(5, 'may-issue');
  const days = field(6, 'days');
  if (to === null || publicKey === null || entities === null || ops === null || (mayIssue !== 'yes' && mayIssue !== 'no') || days === null || !/^[1-9][0-9]{0,2}$/.test(days)) return 'the general grant\'s words cannot be read';
  const terms: PinnedGrantTerms = { to, publicKey, entities: entities.split(','), ops: ops.split(','), mayIssue: mayIssue === 'yes', days: Number(days) };
  const canonical = pinnedGrantWords(terms);
  return canonical.every((word, at) => word === words[at]) ? terms : 'the general grant is not in its canonical words';
}
