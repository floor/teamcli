// Phase 0b: `team projects` — the project level above teams. Every project the registry holds,
// with its immutable id, its name, its entity, its lead and its teams. The lead is the seat whose
// role holds the `leads` capability, never a role name. Reads the registry and changes nothing.
//
// The registry read is src/registry/projects.ts. The views read through the small ProjectSources
// interface below, so a test hands in its own registry; the real sources bind to the registry
// module the same way every other command's real sources do.
import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import {
  renderTable,
  ttyStyle,
  writeJson,
  writeJsonError,
  type OutputSchemaTag,
} from '../output/index.ts';
import * as projectRegistry from '../registry/projects.ts';

export const USAGE = `Usage: team projects [--json]

Run from any folder. Lists the projects this machine's registry holds: each project's id, name,
entity, lead and teams. The lead is the seat whose role holds the leads capability. Reads the
registry and changes nothing.

Exits 0 when the projects are listed, 1 when the project registry cannot be read, 2 when the invocation can't be read.
`;

/** One project, as the views read it: the registry record's own fields. */
export type ProjectView = projectRegistry.ProjectRecord;

/** Where the views read projects from: the registry module, through the few reads they need. */
export type ProjectSources = {
  /** Every project the registry holds. */
  list(): ProjectView[];
  /** The one project a name or an id picks, or null when none does. */
  byName(key: string): ProjectView | null;
  /** The project a team sits in — the project whose teams name it — or null when it sits in none. */
  ofTeam(team: string): ProjectView | null;
};

export const realSources: ProjectSources = {
  list: () => projectRegistry.list(homedir()),
  byName: (key) => projectRegistry.byName(homedir(), key),
  ofTeam: (team) => projectRegistry.ofTeam(homedir(), team),
};

export type ProjectsJson = {
  schema: OutputSchemaTag;
  format: 1;
  projects: ProjectView[];
};

export const projects: Command = (argv, io) => runProjects(argv, io, realSources);
export default projects;

/** The registry's own sentence, in this command's words: the top-level catch would say `team:`
 *  and leave the reader without the command that failed. */
function unreadable(io: Io, out: Io, reason: string, json: boolean): number {
  if (json) {
    writeJsonError(io, 'projects.unreadable', `the project registry cannot be read: ${plainText(reason)}`, null);
  } else {
    out.stderr(`team projects: the project registry cannot be read: ${reason}\n`);
  }
  // exit: projects.unreadable
  return 1;
}

export async function runProjects(argv: string[], io: Io, sources: ProjectSources): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, [], ['json']);
  const json = args.flags.has('json');
  if (args.error || args.rest.length) {
    const why = plainText(args.error ?? `unexpected "${args.rest[0]}"`);
    if (json) {
      writeJsonError(io, 'projects.invocation', why, null);
    } else {
      out.stderr(`team projects: ${why}\n${USAGE}`);
    }
    // exit: projects.invocation
    return 2;
  }
  let listed: ProjectView[];
  try {
    listed = sources.list();
  } catch (error) {
    if (!(error instanceof projectRegistry.ProjectsError)) throw error;
    return unreadable(io, out, error.message, json);
  }
  if (json) {
    writeJson(io, 'team.projects', { format: 1 as const, projects: listed });
  } else if (listed.length === 0) {
    out.stdout('(no projects)\n');
  } else {
    const style = ttyStyle(io, { json: false });
    const lines = renderTable({
      headers: ['ID', 'NAME', 'ENTITY', 'LEAD', 'TEAMS'],
      rows: listed.map((project) => [
        project.id ?? '-',
        project.name,
        project.entity,
        project.lead ?? '-',
        project.teams.length > 0 ? project.teams.map(plainLine).join(', ') : '-',
      ]),
      indent: '',
      style,
    });
    lines.push(`${listed.length} project(s)`);
    out.stdout(`${lines.join('\n')}\n`);
  }
  // exit: projects.listed
  return 0;
}
