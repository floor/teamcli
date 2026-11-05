import type { Section } from './section.ts';
import { resolveLeadField } from './lead.ts';

export const orchestrator: Section = {
  name: 'orchestrator',
  // The one top-level key that still supplies this section: the file may spell the lead's name
  // here, and `leads: true` on the lead's seat is the other spelling. Everything order- and
  // digest-shaped reads `name`, so a record written under the key keeps its bucket's value.
  key: 'coordinator',
  owner: true,
  // `lead` first: the team file's own default word is what `resolveLeadField` reads when no seat
  // carries the mark, and the value this section stores is the resolved lead either way.
  after: ['seats', 'lead'],
  validate(entry, ctx) {
    // The key is still read, and the file may put `leads: true` on the lead's seat instead. The
    // notice says so once, at the key's line, whether or not the mark stands beside it.
    if (entry) {
      ctx.check.warnings.push({ line: entry.value.line, message: '`coordinator:` is now `leads: true` on the lead\'s seat, and is still read' });
    }
    return resolveLeadField(entry, ctx);
  },
  schema: {
    type: 'string',
    minLength: 1,
    deprecated: true,
    $comment: 'one seat may carry `leads: true` instead; a key must name a declared seat: one, without count, neither parked nor stopped',
  },
};
