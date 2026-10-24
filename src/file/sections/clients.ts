import type { YamlEntry } from '../../yaml.ts';
import type { Ctx, Section } from './section.ts';
import { valueOf } from './section.ts';
import type { DraftSeat } from './seats.ts';

/** A client id: one lowercase word, hyphens allowed (the client grant's own pattern). */
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The seats one external client may be issued a grant to, by client id. */
export type ClientSeats = Record<string, { seats: string[] }>;

/**
 * The owner's word on which seats of this team an external client grant may address, by client
 * id. Omitted, it is null and a client reaches only the orchestrator, as before. Owner-only, so
 * naming or widening a client's seats is an edit the owner approves; TeamCLI enforces the list
 * and defines none of it. A seat listed here must be a declared seat of this team, one, neither
 * the operator nor a `human: true` pane; an empty list is refused.
 */
export const clients: Section = {
  name: 'clients',
  owner: true,
  after: ['seats', 'operator', 'orchestrator'],
  validate(entry, ctx) {
    return readClients(entry, ctx);
  },
  schema: {
    type: 'object',
    minProperties: 1,
    propertyNames: { pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
    additionalProperties: {
      type: 'object',
      additionalProperties: false,
      required: ['seats'],
      properties: {
        seats: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
          $comment: 'the seats this client may address: declared seats of this team, without count, never the operator or a human seat',
        },
      },
    },
    $comment:
      'the seats an external client grant may address, by client id. omitted means a client reaches only the orchestrator. owner-only: a change needs a new approval',
  },
};

function readClients(entry: YamlEntry | undefined, ctx: Ctx): ClientSeats | null {
  if (!entry) return null;
  const node = entry.value;
  if (node.kind !== 'map') {
    ctx.check.fail(node.line, 'clients must be a map of client id to { seats: [...] }');
    return null;
  }
  const before = ctx.check.problems.length;
  const seats = valueOf<DraftSeat[]>(ctx, 'seats');
  const lead = valueOf<string>(ctx, 'orchestrator');
  const operator = valueOf<string>(ctx, 'operator');
  const out: ClientSeats = {};
  if (node.entries.length === 0) ctx.check.fail(node.line, 'clients must name at least one client');
  for (const client of node.entries) {
    const id = client.key;
    const at = `clients.${id}`;
    if (!CLIENT_ID_PATTERN.test(id)) {
      ctx.check.fail(client.value.line, `${at}: "${id}" is not a client id: one lowercase word, digits and hyphens`);
      continue;
    }
    const fields = ctx.check.fields(client.value, at, ['seats']);
    if (client.value.kind !== 'map') continue;
    const list = fields.get('seats');
    if (!list) {
      ctx.check.fail(client.value.line, `${at}.seats is required`);
      continue;
    }
    if (list.value.kind !== 'seq') {
      ctx.check.fail(list.value.line, `${at}.seats must be a list`);
      continue;
    }
    const items = ctx.check.list(list, `${at}.seats`);
    if (items.length === 0) {
      ctx.check.fail(list.value.line, `${at}.seats must name at least one seat`);
      continue;
    }
    const named: string[] = [];
    for (const item of items) {
      const seat = seats.find((candidate) => candidate.name === item.value);
      if (named.includes(item.value)) ctx.check.fail(item.line, `${at}.seats names "${item.value}" twice`);
      else if (!seat) {
        if (!ctx.broken.has(item.value)) ctx.check.fail(item.line, `${at}.seats: "${item.value}" names no declared seat`);
      } else if (seat.count > 1) ctx.check.fail(item.line, `${at}.seats: "${item.value}" can't be a seat with count`);
      else if (item.value === operator && operator !== lead) ctx.check.fail(item.line, `${at}.seats: "${item.value}" is the operator; a client never addresses it`);
      else if ((seat as { human?: boolean }).human === true) ctx.check.fail(item.line, `${at}.seats: "${item.value}" is a human seat; a client never addresses it`);
      named.push(item.value);
    }
    out[id] = { seats: named };
  }
  return ctx.check.problems.length === before ? out : null;
}
