import type { YamlEntry } from '../../yaml.ts';
import type { Grant, GrantScope } from '../types.ts';
import { GRANT_SCOPES } from '../types.ts';
import type { Ctx, Section } from './section.ts';
import { valueOf } from './section.ts';

const NAMES = GRANT_SCOPES.join(', ');

/**
 * The grant the owner gives the orchestrator's seat: the session the placement is judged in,
 * that seat's name, and the acts a later check may admit. Omitted, it is null. Owner-only, so
 * granting is one approval and a later edit of this section is one too.
 */
export const grant: Section = {
  name: 'grant',
  owner: true,
  after: ['orchestrator', 'session'],
  validate(entry, ctx) {
    return readGrant(entry, ctx);
  },
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['session', 'seat', 'scope'],
    properties: {
      session: {
        type: 'string',
        minLength: 1,
        $comment: 'the file\'s own session: the session key, or <entity>-<project> when that key is omitted and an entity is named, the project name alone when it is not',
      },
      seat: {
        type: 'string',
        minLength: 1,
        $comment: 'the orchestrator seat\'s name, the one coordinator: or leads: true resolves',
      },
      scope: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { enum: [...GRANT_SCOPES] },
        $comment: 'non-empty, distinct, order kept: up, down, approve, init, reload, swap',
      },
    },
    $comment:
      'the orchestrator seat\'s grant. session is the file\'s session, seat is the orchestrator, scope names acts. omitted means no grant. any other key is refused',
  },
};

function readGrant(entry: YamlEntry | undefined, ctx: Ctx): Grant {
  if (!entry) return null;
  const before = ctx.check.problems.length;
  const session = valueOf<string>(ctx, 'session');
  const seat = valueOf<string>(ctx, 'orchestrator');
  const fields = ctx.check.fields(entry.value, 'grant', ['session', 'seat', 'scope']);
  if (entry.value.kind !== 'map') return null;
  const line = entry.value.line;
  const namedSession = ctx.check.required(fields.get('session'), 'grant.session', line);
  const namedSeat = ctx.check.required(fields.get('seat'), 'grant.seat', line);
  const scope = readScope(fields.get('scope'), ctx, line);
  if (namedSession !== undefined && namedSession !== session) {
    const at = fields.get('session')?.value.line ?? line;
    ctx.check.fail(at, `grant.session must be the file's session "${session}": "${namedSession}"`);
  }
  if (namedSeat !== undefined && namedSeat !== seat) {
    const at = fields.get('seat')?.value.line ?? line;
    ctx.check.fail(at, `grant.seat must name the orchestrator "${seat}": "${namedSeat}"`);
  }
  if (ctx.check.problems.length !== before) return null;
  if (namedSession === undefined || namedSeat === undefined || scope === null) return null;
  return { session: namedSession, seat: namedSeat, scope };
}

/** A non-empty ordered list of distinct acts from the closed set. Order is part of the value. */
function readScope(entry: YamlEntry | undefined, ctx: Ctx, line: number): GrantScope[] | null {
  if (!entry) {
    ctx.check.fail(line, 'grant.scope is required');
    return null;
  }
  const node = entry.value;
  const empty = node.kind === 'scalar' && node.value === null;
  if (node.kind !== 'seq' && !empty) {
    ctx.check.fail(node.line, 'grant.scope must be a list');
    return null;
  }
  const items = ctx.check.list(entry, 'grant.scope');
  if (items.length === 0) {
    ctx.check.fail(node.line, `grant.scope must name at least one of: ${NAMES}`);
    return null;
  }
  const scope: GrantScope[] = [];
  let bad = false;
  for (const item of items) {
    if (!(GRANT_SCOPES as readonly string[]).includes(item.value)) {
      ctx.check.fail(item.line, `grant.scope must name ${NAMES}: "${item.value}" is not one`);
      bad = true;
      continue;
    }
    if (scope.includes(item.value as GrantScope)) {
      ctx.check.fail(item.line, `grant.scope names "${item.value}" twice`);
      bad = true;
      continue;
    }
    scope.push(item.value as GrantScope);
  }
  return bad ? null : scope;
}
