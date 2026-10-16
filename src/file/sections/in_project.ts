import type { Section } from './section.ts';

// A project name is one path segment: the same shape as the team's own `project:` name and as an
// entity name, so the three levels of entity → project → team read alike and a name is never "".
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The project this team sits in, by name, or null when the file names none. `project:` above
 * still names the team itself — the team `teamcli` writes `project: teamcli` and, inside project
 * TeamCLI, `in_project: TeamCLI`. A team that names no project is its own project, so every file
 * written before this field existed loads as it did. The registry's team record carries the
 * project this names (src/registry/sync.ts); no approval digest reads it.
 */
export const inProject: Section = {
  name: 'in_project',
  owner: false,
  after: [],
  validate(entry, ctx) {
    const value = ctx.check.text(entry, 'in_project');
    if (value === undefined) return null;
    if (!PROJECT_NAME.test(value)) {
      ctx.check.fail(
        entry?.line ?? 1,
        'in_project must be a short name: letters, digits, ".", "_" and "-", starting with a letter or a digit',
      );
      return null;
    }
    return value;
  },
  schema: {
    type: 'string',
    minLength: 1,
    pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
    $comment: 'the project this team belongs to, by name; absent, the team is its own project',
  },
};
