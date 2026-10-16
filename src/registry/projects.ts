// The project registry (Layer 3): `~/.config/team/projects.yaml`, the record between the entity
// and the teams. The hierarchy is entity → project → team → seat: a project groups teams under
// one lead, given by agent ID. Each team record points to its project by ID (src/registry/teams.ts
// carries the field; sync.ts writes it from the team file), and a team no project names is its
// own project — so a machine with no projects.yaml is a machine where every team stands alone,
// and every reader here reads an absent record that way.
//
// This file first carries the shape and the reads; the writes (upsertProject, atomic writes and
// locking like teams.ts) land with it in the same branch, never before: a reader must not see a
// half-written record.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, toValue, YamlError, type YamlValue } from '../yaml.ts';

export type ProjectProvenance = { registered_by: string; registered_at: string; updated_at: string };

export type ProjectRecord = {
  /** The project ID this record is stored under. Filled in when a record is read; never written. */
  id?: string;
  /** The display name: what people and team files call the project (`TeamCLI`). Immutable
   *  alongside the ID — a rename moves this field, never the key the record is stored under. */
  name: string;
  entity: string | null;
  /** The project lead, by agent ID — never a seat or a role name. Null until set. */
  lead: string | null;
  /** The team IDs this project groups. */
  teams: string[];
  provenance: ProjectProvenance;
};

/** The registry file could not be read as a project registry. Names the file and what is wrong. */
export class ProjectsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectsError';
  }
}

export function projectsFile(home: string): string {
  return join(home, '.config', 'team', 'projects.yaml');
}

/** Every registered project, by project ID. A missing file is no projects. A file that does not
 *  read as a project registry throws `ProjectsError`, so a writer never replaces a file it could
 *  not read. */
export function readProjects(home: string): Record<string, ProjectRecord> {
  const path = projectsFile(home);
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ProjectsError(`${path}: ${(error as Error).message}`);
  }
  if (!text.trim()) return {};
  let value: YamlValue;
  try {
    value = toValue(parseYaml(text));
  } catch (error) {
    if (error instanceof YamlError) throw new ProjectsError(`${path}: line ${error.line}: ${error.message}`);
    throw error;
  }
  return projectsOf(value, path);
}

/** The projects of the registry, ID order, so a view reads the same twice. */
export function list(home: string): ProjectRecord[] {
  const projects = readProjects(home);
  return Object.keys(projects)
    .sort()
    .map((id) => projects[id] as ProjectRecord);
}

/** One project by ID, or null. */
export function get(home: string, id: string): ProjectRecord | null {
  return readProjects(home)[id] ?? null;
}

/** The one project whose display name is exactly `name` — the name a team file writes — or null.
 *  Two projects under one name is a registry that cannot answer, and is refused, naming both. */
export function byName(home: string, name: string): ProjectRecord | null {
  const found = list(home).filter((project) => project.name === name);
  if (found.length > 1) {
    throw new ProjectsError(`two projects are named ${name}: ${found.map((project) => project.id).join(', ')}`);
  }
  return found[0] ?? null;
}

/** The project a team belongs to: the one whose `teams` names it, or null — and callers read
 *  null as this team being its own project. A team two projects both name is the state
 *  `team check` refuses; it is refused here too, naming both, so no reader picks one silently. */
export function ofTeam(home: string, teamId: string): ProjectRecord | null {
  const found = list(home).filter((project) => project.teams.includes(teamId));
  if (found.length > 1) {
    throw new ProjectsError(`team ${teamId} is named in ${found.length} projects: ${found.map((project) => project.id).join(', ')}`);
  }
  return found[0] ?? null;
}

// --- reading the file's value into records ---------------------------------------------------

function projectsOf(value: YamlValue, path: string): Record<string, ProjectRecord> {
  if (!isMap(value)) throw new ProjectsError(`${path}: expected a map with a "projects" key`);
  const section = value.projects;
  if (section === null || section === undefined) return {};
  if (!isMap(section)) throw new ProjectsError(`${path}: "projects" must be a map of project IDs`);
  const out: Record<string, ProjectRecord> = {};
  for (const [id, raw] of Object.entries(section)) out[id] = recordOf(id, raw, path);
  return out;
}

function recordOf(id: string, raw: YamlValue, path: string): ProjectRecord {
  const bad = (what: string): never => {
    throw new ProjectsError(`${path}: project ${id}: ${what}`);
  };
  if (!isMap(raw)) return bad('expected a map');
  const text = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : bad(`"${key}" must be text`));
  const entity = raw.entity ?? null;
  if (entity !== null && typeof entity !== 'string') bad('"entity" must be text or null');
  const lead = raw.lead ?? null;
  if (lead !== null && typeof lead !== 'string') bad('"lead" must be an agent ID or null');
  const teams = raw.teams ?? [];
  if (!Array.isArray(teams)) bad('"teams" must be a list of team IDs');
  for (const [i, team] of (teams as YamlValue[]).entries()) {
    if (typeof team !== 'string') bad(`teams line ${i + 1} must be a team ID`);
  }
  const prov = raw.provenance;
  if (!isMap(prov)) return bad('"provenance" must be a map');
  for (const key of ['registered_by', 'registered_at', 'updated_at']) {
    if (typeof prov[key] !== 'string') bad(`provenance: "${key}" must be text`);
  }
  return {
    id,
    name: text('name'),
    entity: entity as string | null,
    lead: lead as string | null,
    teams: teams as string[],
    provenance: { registered_by: prov.registered_by as string, registered_at: prov.registered_at as string, updated_at: prov.updated_at as string },
  };
}

function isMap(value: YamlValue | undefined): value is { [key: string]: YamlValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
