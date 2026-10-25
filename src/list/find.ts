import { lstatSync, readFileSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TeamFile } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import { storesFolder } from '../store/store.ts';
import { parseYaml, type YamlNode } from '../yaml.ts';

/** A team file that names one herdr session. `seats` is null when the file was found but did not
 *  validate, so the list prints `?` for the count and does not fail. `root` is the real path of
 *  the directory that holds `.agents` when the OS can resolve it. */
export type FoundTeam = {
  project: string | null;
  root: string | null;
  seats: number | null;
  unreadable: boolean;
};

export type FoundTeamWithFile = {
  found: FoundTeam;
  team: TeamFile | null;
};

// The same folder-name rule `machineUsage` walks: a store directory ends in a dash and 12 hex digits.
const STORE_NAME = /-[0-9a-f]{12}$/;

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function scalar(map: YamlNode, key: string): string | null {
  if (map.kind !== 'map') return null;
  const entry = map.entries.find((item) => item.key === key);
  if (!entry || entry.value.kind !== 'scalar' || typeof entry.value.value !== 'string' || entry.value.value === '') return null;
  return entry.value.value;
}

/** `project`, `entity` and `session` as the file writes them. An omitted session is the entity and
 *  the project name joined with `-`, the project name alone when the file names no entity: the
 *  section's own default, kept in step with it. Null when those cannot be read, so the file is not
 *  claimed for a session. */
function declared(text: string): { project: string; session: string } | null {
  try {
    const node = parseYaml(text);
    const project = scalar(node, 'project');
    if (!project) return null;
    const entity = scalar(node, 'entity');
    return { project, session: scalar(node, 'session') ?? (entity ? `${entity}-${project}` : project) };
  } catch {
    return null;
  }
}

function isRealFile(path: string): boolean {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return false;
  }
  return stat.isFile() && !stat.isSymbolicLink();
}

/** `.agents/team.yaml` in `dir` when both are real, not links. */
function teamFileAt(dir: string): string | null {
  const agents = join(dir, '.agents');
  let stat: Stats;
  try {
    stat = lstatSync(agents);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  const file = join(agents, 'team.yaml');
  return isRealFile(file) ? file : null;
}

function interpret(path: string, root: string, session: string, home: string): FoundTeamWithFile | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const names = declared(text);
  if (!names || names.session !== session) return null;
  const folder = resolved(root);
  const validated = validateTeamFile(text, { home, root: folder });
  if (validated.ok) {
    return {
      found: { project: validated.team.project, root: folder, seats: validated.team.seats.length, unreadable: false },
      team: validated.team,
    };
  }
  return {
    found: { project: names.project, root: folder, seats: null, unreadable: true },
    team: null,
  };
}

/** Walk up from a workspace folder. The first team file whose session is this one wins; a file
 *  that names another session is stepped past. */
function fromDir(start: string, session: string, home: string): FoundTeamWithFile | null {
  let dir = start;
  for (let depth = 0; depth < 40; depth++) {
    const file = teamFileAt(dir);
    if (file) {
      const found = interpret(file, dir, session, home);
      if (found) return found;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function workspaceCwds(sessionDir: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8')) as { workspaces?: unknown };
    if (!Array.isArray(parsed.workspaces)) return [];
    const cwds: string[] = [];
    for (const entry of parsed.workspaces) {
      if (!entry || typeof entry !== 'object') continue;
      const cwd = (entry as { identity_cwd?: unknown }).identity_cwd;
      if (typeof cwd === 'string' && cwd) cwds.push(cwd);
    }
    return cwds;
  } catch {
    return [];
  }
}

function fromSessionDir(sessionDir: string | null, session: string, home: string): FoundTeamWithFile | null {
  if (!sessionDir) return null;
  for (const cwd of workspaceCwds(sessionDir)) {
    const found = fromDir(cwd, session, home);
    if (found) return found;
  }
  return null;
}

function storeRoot(store: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(store, 'approval.json'), 'utf8')) as { root?: unknown };
    return typeof parsed.root === 'string' && parsed.root ? parsed.root : null;
  } catch {
    return null;
  }
}

function fromStores(session: string, home: string): FoundTeamWithFile | null {
  let names: string[];
  try {
    names = readdirSync(storesFolder(home));
  } catch {
    return null;
  }
  for (const name of names.filter((candidate) => STORE_NAME.test(candidate)).sort()) {
    const store = join(storesFolder(home), name);
    const root = storeRoot(store);
    if (!root) continue;
    const live = teamFileAt(root);
    if (live) {
      const found = interpret(live, root, session, home);
      if (found) return found;
    }
  }
  return null;
}

export function findTeamFile(session: string, sessionDir: string | null, home: string): FoundTeamWithFile | null {
  return fromSessionDir(sessionDir, session, home) ?? fromStores(session, home);
}

/**
 * The team file that names `session`, or null when none does. The session registry's
 * `identity_cwd` is tried first — captured on herdr 0.7.1 as `workspaces[].identity_cwd` in
 * `<session_dir>/session.json` — and then this machine's approval stores. A link standing in
 * for the file is not opened. Nothing here is written.
 */
export function findTeam(session: string, sessionDir: string | null, home: string): FoundTeam | null {
  return findTeamFile(session, sessionDir, home)?.found ?? null;
}

