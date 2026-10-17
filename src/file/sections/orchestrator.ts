import type { Section } from './section.ts';
import { valueOf } from './section.ts';
import { readLeadField } from './lead.ts';
import type { DraftSeat } from './seats.ts';

export const orchestrator: Section = {
  name: 'orchestrator',
  // The one top-level key that still supplies this section: the file may spell the lead's name
  // here, and `leads: true` on the lead's seat is the other spelling. Everything order- and
  // digest-shaped reads `name`, so a record written under the key keeps its bucket's value.
  key: 'coordinator',
  owner: true,
  after: ['seats'],
  validate(entry, ctx) {
    // The key is still read, and the file may put `leads: true` on the lead's seat instead. The
    // notice says so once, at the key's line, whether or not the mark stands beside it.
    if (entry) {
      ctx.check.warnings.push({ line: entry.value.line, message: '`coordinator:` is now `leads: true` on the lead\'s seat, and is still read' });
    }
    return readLeadField(entry, ctx.leads, valueOf<DraftSeat[]>(ctx, 'seats'), ctx.broken, ctx.check);
  },
  schema: {
    type: 'string',
    minLength: 1,
    deprecated: true,
    $comment: 'one seat may carry `leads: true` instead; a key must name a declared seat: one, without count, neither parked nor stopped',
  },
};
