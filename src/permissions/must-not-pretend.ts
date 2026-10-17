// What 0.5.0 must not pretend, said plainly (decided-grants-minimum-2026-10-17, "What 0.5.0
// must not pretend, said plainly"): the release's own honest limits, in the record's words. In
// the 0.5.0 output contract (§2.3), this block is printed only by `team doctor` (full runs, not
// `--login`) and `team --about`; routine operational commands (`team status` and `team check`)
// omit it so repeated runs stay quiet by default.

/** The first line of `NOT_PRETENDED`: the gates hold against a mistake, not against an attempt. */
export const INTEGRITY_NOT_AUTHORITY =
  'Integrity, not authority: every gate 0.5.0 ships holds against a mistake, not against an attempt';

/** The closing block printed by `team doctor` and `team --about`: the heading and the record's five
 *  lines, in the record's order. The heading is the record's section title; the entry lines are
 *  its bullets as the record words them, its markdown emphasis dropped, the first joined the
 *  way the record joins a lead to its body (bullets 4 and 6's own `: `). */
export const NOT_PRETENDED: readonly string[] = [
  'what 0.5.0 must not pretend:',
  `  ${INTEGRITY_NOT_AUTHORITY}`,
  '  Standing grants with an expiry, not leases',
  '  No two-granter agreement, no `agree`, no `create` bounds',
  '  No read scoping (§3, every disclosure is a `read`), no `act-as`, no `use-broker`, no `deploy` gating',
  '  No constraint program beyond the one-`leads` cardinality and launch-time mutual exclusion (§5)',
];
