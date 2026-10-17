// What 0.5.0 must not pretend, said plainly (decided-grants-minimum-2026-10-17, "What 0.5.0
// must not pretend, said plainly"): the release's own honest limits, in the record's words. The
// record names the two places they stand — the gaps "named in `team check`'s output", and, for
// the first line, that "every record and view says so", which is `team status`'s footer. The
// lines below are printed exactly as the record words them; test/must-not-pretend.test.ts pins
// them sentence by sentence, under both of the check's answers and under the status reading.

/** The first line of the list, and the one `team status` prints as its footer: the gates hold
 *  against a mistake, not against an attempt. The same sentence stands in `team check`'s block,
 *  first under its heading — a record and a view saying the one thing. */
export const INTEGRITY_NOT_AUTHORITY =
  'Integrity, not authority: every gate 0.5.0 ships holds against a mistake, not against an attempt';

/** `team check`'s closing block, under both of its answers: the heading and the record's six
 *  lines, in the record's order. The heading is the record's section title; the entry lines are
 *  its six bullets as the record words them, its markdown emphasis dropped, the first joined the
 *  way the record joins a lead to its body (bullets 4 and 6's own `: `). */
export const NOT_PRETENDED: readonly string[] = [
  'what 0.5.0 must not pretend:',
  `  ${INTEGRITY_NOT_AUTHORITY}`,
  '  Standing grants with an expiry, not leases',
  '  No two-granter agreement, no `agree`, no `create` bounds',
  '  No read scoping (§3, every disclosure is a `read`), no `act-as`, no `use-broker`, no `deploy` gating',
  '  No constraint program beyond the one-`leads` cardinality and launch-time mutual exclusion (§5)',
  '  No policy object yet (amendment 02)',
];
