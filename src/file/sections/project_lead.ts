import type { Section } from './section.ts';
import { valueOf } from './section.ts';

/**
 * The team that leads the project it sits in: the team-side `leads: true`, and the file marker
 * the project's `lead` in the registry is read from (src/registry/sync.ts). One team per project
 * sets it — `team check` refuses two — and a project with no team claiming it has no lead, which
 * is a state teams read as ordinary. Non-owner and additive, like `in_project` beside it: a new
 * owner section would make every approval in force read as drifted.
 */
export const projectLead: Section = {
  name: 'project_lead',
  owner: false,
  after: ['in_project'],
  validate(entry, ctx) {
    const value = ctx.check.flag(entry, 'project_lead');
    if (!value) return false;
    // A team leads the project the file names it sits in; with none named there is nothing to
    // lead, and the registry has no project to point at.
    if (valueOf<string | null>(ctx, 'in_project') === null) {
      ctx.check.fail(entry?.line ?? 1, 'project_lead needs in_project: name the project this team leads');
    }
    return value;
  },
  schema: {
    type: 'boolean',
    $comment: 'this team leads the project it sits in; one team per project declares it',
  },
};
