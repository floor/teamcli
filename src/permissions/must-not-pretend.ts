// What 0.5.0 must not pretend, said plainly: the
// release's own honest limits in plain words for human output, with each line's Kernel reference
// carried in `--json` (`ref`) and in the docs. In the 0.5.0 output contract (§2.3), this block is
// printed only by `team doctor` (full runs, not `--login`) and `team --about`; routine operational
// commands (`team status` and `team check`) omit it so repeated runs stay quiet by default.

export interface NotPretendedEntry {
  text: string;
  ref: string;
}

/** The first line of `NOT_PRETENDED`: the checks hold against a mistake, not against an attempt. */
export const INTEGRITY_NOT_AUTHORITY =
  'The checks in 0.5.0 — including the owner check — stop mistakes by agents in herdr panes, not a process running as the same OS user that sets out to get around those checks.';

/** Each entry of `NOT_PRETENDED`, pairing the plain sentence with its Kernel section reference. */
export const NOT_PRETENDED_ENTRIES: readonly NotPretendedEntry[] = [
  {
    text: INTEGRITY_NOT_AUTHORITY,
    ref: 'Kernel §11, §12, §14',
  },
  {
    text: 'A right given to a team or a seat stands until it is revoked, and may carry an end date; a seat cannot lend a right to another seat for a task and take it back when the task is done.',
    ref: 'Kernel §7, §10, §14, §15 (standing grant vs lease; liveness walk)',
  },
  {
    text: 'Three ways of sharing control are not built yet — a grant co-signed by a second person, a seat approving an identical copy of another seat, and an agent creating a team within pre-set limits — so only the owner grants rights and adds seats.',
    ref: 'Kernel §9, §10 (two-granter agreement, `agree`, `create`)',
  },
  {
    text: 'Four things are not checked yet: which project files a seat may see, acting under an account the owner holds — GitHub, Linear, email — using the broker, and deploying a release.',
    ref: 'Kernel §3, §14 (`read` scope, `act-as`, `use-broker`, `deploy`)',
  },
  {
    text: 'Apart from one lead seat per team and no seat starting with two exclusive rights, nothing else about how a team is put together is enforced: no limit on how many seats hold a right, no rule that a change is merged by a different seat from the one that wrote it, and no rule that a reviewer comes from another lab.',
    ref: 'Kernel §5, §9 (cardinality, mutual exclusion, separation of duties, cross-lab review)',
  },
];

/** The closing block printed by `team doctor` and `team --about`: the heading and the five plain
 *  lines, in the record's order. */
export const NOT_PRETENDED: readonly string[] = [
  'what 0.5.0 must not pretend:',
  ...NOT_PRETENDED_ENTRIES.map((entry) => `  ${entry.text}`),
];
