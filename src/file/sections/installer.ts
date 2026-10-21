import type { Section } from './section.ts';
import { valueOf } from './section.ts';
import { readLead } from './lead.ts';
import type { DraftSeat } from './seats.ts';

/**
 * The owner's designation of the one seat that records a green-slice install beside the owner:
 * a declared seat of this team, one, neither parked nor stopped. Omitted, the file names none
 * and only the owner records an install. Owner-only, so naming or changing the seat is an edit
 * the owner approves — and the queue command admits the designated seat only while that
 * approval is in force: an unapproved designation never admits an install.
 */
export const installer: Section = {
  name: 'installer',
  owner: true,
  after: ['seats'],
  validate(entry, ctx) {
    if (!entry) return null;
    const name = readLead(entry, 'installer', valueOf<DraftSeat[]>(ctx, 'seats'), ctx.broken, ctx.check);
    return name === '' ? null : name;
  },
  schema: {
    type: 'string',
    minLength: 1,
    $comment:
      'the seat that records green-slice installs beside the owner: must name a declared seat, without count, and neither parked nor stopped. omitted means none, and only the owner records an install',
  },
};
