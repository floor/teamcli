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
import * as projectRegistry from '../registry/projects.ts';

export const USAGE = `Usage: team projects [--json]

Run from any folder. Lists the projects this machine's registry holds: each project's id, name,
entity, lead and teams. The lead is the seat whose role holds the leads capability. Reads the
registry and changes nothing.
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

export type ProjectsJson = { format: 1; projects: ProjectView[] };

export const projects: Command = (argv, io) => runProjects(argv, io, realSources);
export default projects;

export async function runProjects(argv: string[], io: Io, sources: ProjectSources): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, [], ['json']);
  if (args.error || args.rest.length) {
    out.stderr(`team projects: ${plainText(args.error ?? `unexpected "${args.rest[0]}"`)}\n${USAGE}`);
    // exit: projects.invocation
    return 2;
  }
  const listed = sources.list();
  if (args.flags.has('json')) {
    const doc: ProjectsJson = { format: 1, projects: listed };
    io.stdout(`${JSON.stringify(doc, null, 2)}\n`);
  } else if (listed.length === 0) {
    out.stdout('(no projects)\n');
  } else {
    const rows = listed.map((project) => ({
      id: plainLine(project.id ?? '-'),
      name: plainLine(project.name),
      entity: project.entity === null ? '-' : plainLine(project.entity),
      lead: plainLine(project.lead ?? '-'),
      teams: project.teams.map(plainLine).join(', '),
    }));
    const widths = [0, 0, 0, 0];
    for (const row of rows) {
      widths[0] = Math.max(widths[0] as number, row.id.length);
      widths[1] = Math.max(widths[1] as number, row.name.length);
      widths[2] = Math.max(widths[2] as number, row.entity.length);
      widths[3] = Math.max(widths[3] as number, row.lead.length);
    }
    for (const row of rows) {
      out.stdout(`  ${row.id.padEnd(widths[0] as number)}  ${row.name.padEnd(widths[1] as number)}  ${row.entity.padEnd(widths[2] as number)}  ${row.lead.padEnd(widths[3] as number)}  ${row.teams}\n`);
    }
  }
  // exit: projects.listed
  return 0;
}
