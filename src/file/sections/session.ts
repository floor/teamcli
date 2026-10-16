import type { Section, Ctx } from './section.ts';
import { valueOf } from './section.ts';

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
    return session;
  },
  // The team's own herdr session: the key, or the entity and the project name joined with `-`,
  // the project's name alone when the file names no entity — never `default`, herdr's own.
  schema: {
    type: 'string',
    not: { const: 'default' },
    $comment: 'the session key, or <entity>-<project> when the file names an entity and the project name alone when it does not',
  },
};
