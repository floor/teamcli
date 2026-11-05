import { projectIdOf } from '../../registry/projects.ts';
import { sessionNameRefusal } from '../../session-names.ts';
import type { Section, Ctx } from './section.ts';
import { valueOf } from './section.ts';

/**
 * The session a team runs in when the file names none. A team inside a project (`in_project:`)
 * is `<entity>-<project>` — the home project's id as `projectIdOf` mints it — with `-<team>`
 * appended when the team is not the project's namesake, so two teams of one project never share
 * a default. A team that is its own project keeps the name it had: `<entity>-<team>`, or the
 * team's name alone when the file names no entity.
 */
export function defaultSession(project: string, entity: string | null, inProject: string | null): string {
  if (inProject === null) return entity ? `${entity}-${project}` : project;
  const home = projectIdOf(inProject);
  const base = entity ? `${entity}-${home}` : home;
  return projectIdOf(project) === home ? base : `${base}-${project}`;
}

export const session: Section = {
  name: 'session',
  owner: true,
  after: ['project', 'entity', 'in_project'],
  validate(entry, ctx) {
    const project = valueOf<string>(ctx, 'project');
    const entity = valueOf<string | null>(ctx, 'entity');
    const inProject = valueOf<string | null>(ctx, 'in_project');
    // `project` comes back "" when its own check already failed the file; derive nothing from
    // it then, so a broken file gets its own refusal and never a ProjectsError out of the id
    // minting.
    const derived = project === '' ? project : defaultSession(project, entity, inProject);
    const explicit = ctx.check.text(entry, 'session');
    const session = explicit ?? derived;
    if (session === 'default') {
      ctx.check.fail(
        ctx.top.get('session')?.line ?? ctx.top.get('project')?.line ?? 1,
        'session can\'t be "default", herdr\'s own session: give the team a session of its own',
      );
    }
    // The same door for a name every object inherits: a session lookup keyed by it would read the
    // inherited object (or nothing), never a record of the team's own. The sentence is the one a
    // command line's `--session` gets too (src/session-names.ts).
    const refusal = sessionNameRefusal(session);
    if (refusal !== null) {
      ctx.check.fail(ctx.top.get('session')?.line ?? ctx.top.get('project')?.line ?? 1, refusal);
    }
    // An explicit session off the default is kept — it is the file's own word — and named once:
    // a session that drifts from its entity and project is how a stale session of a name the
    // team no longer uses gets reused by mistake.
    if (explicit !== undefined && derived !== '' && explicit !== derived) {
      ctx.check.warnings.push({
        line: entry?.line ?? ctx.top.get('session')?.line ?? 1,
        message: `session "${explicit}" is not the default "${derived}" for this entity and project: kept as written; a drifted name is how a stale session gets reused`,
      });
    }
    return session;
  },
  // The team's own herdr session: the key, or the default `defaultSession` derives — never
  // `default`, herdr's own.
  schema: {
    type: 'string',
    not: { enum: ['default', '__proto__', 'constructor', 'prototype'] },
    $comment:
      'the session key, or <entity>-<project> for a team in a project (<entity>-<project>-<team> when the team is not the project\'s namesake), <entity>-<team> for a team that is its own project',
  },
};
