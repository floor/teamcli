import type { Section, Ctx } from './section.ts';
import { valueOf } from './section.ts';

/** Names every object inherits. Session state is held in maps keyed by session name, so a team
 *  whose session were one of these would have those lookups find the inherited object instead of
 *  a record of its own. The team file is the one door every reader takes, so the name is refused
 *  here, before any reader uses it. */
const INHERITED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export const session: Section = {
  name: 'session',
  owner: true,
  after: ['project', 'entity'],
  validate(entry, ctx) {
    const project = valueOf<string>(ctx, 'project');
    const entity = valueOf<string | null>(ctx, 'entity');
    const session = ctx.check.text(entry, 'session') ?? (entity ? `${entity}-${project}` : project);
    if (session === 'default') {
      ctx.check.fail(
        ctx.top.get('session')?.line ?? ctx.top.get('project')?.line ?? 1,
        'session can\'t be "default", herdr\'s own session: give the team a session of its own',
      );
    }
    // The same door for a name every object inherits: a session lookup keyed by it would read the
    // inherited object (or nothing), never a record of the team's own.
    if (INHERITED_NAMES.has(session)) {
      ctx.check.fail(
        ctx.top.get('session')?.line ?? ctx.top.get('project')?.line ?? 1,
        `session can't be "${session}": every object inherits that name, so a session lookup by it would not find the team's own record`,
      );
    }
    return session;
  },
  // The team's own herdr session: the key, or the entity and the project name joined with `-`,
  // the project's name alone when the file names no entity — never `default`, herdr's own.
  schema: {
    type: 'string',
    not: { enum: ['default', '__proto__', 'constructor', 'prototype'] },
    $comment: 'the session key, or <entity>-<project> when the file names an entity and the project name alone when it does not',
  },
};
