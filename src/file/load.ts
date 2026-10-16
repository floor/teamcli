import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { type FsReader } from '../lobby/gate.ts';
import { lobbyOf } from '../lobby/recorded.ts';
import { protectedLanding } from '../worktree/place.ts';
import { canonicalLanding, fixedFolder, isLegacyTrust, isMigratedTrust } from './paths.ts';
import type { LoadResult, Problem, TeamFile } from './types.ts';
import { validateTeamFile } from './validate.ts';
import { readPolicyChain } from '../policy/sources.ts';
import { fileDeclaresWorkspaceMode, resolveWorkSettings } from '../policy/work-settings.ts';
import { ofTeam as projectOfTeam } from '../registry/projects.ts';
import { teamIdOf } from '../registry/teams.ts';

export const TEAM_FILE = '.agents/team.yaml';

export const NOT_A_REPO = 'not inside a git repository: run team from a project, or pass --file';

// The no-repository refusal when `.agents` or `team.yaml` is a link. The link is not followed.
// `--file` still opens the path it names.
export const LINK_NOT_FOLLOWED = `${NOT_A_REPO}: a link was found and not followed`;

// The same refusal for a command whose options have no `--file`: the shared sentence ends by
// offering one, and a command that takes none cannot keep it.
export const NOT_A_REPO_NO_FILE = 'not inside a git repository: run team from a project';

/** `message` with the `--file` offer removed when it is the no-repository refusal, unchanged
 *  otherwise. A command that takes no `--file` prints this instead of the shared sentence. */
export function withoutFileOffer(message: string): string {
  return message.replace(NOT_A_REPO, NOT_A_REPO_NO_FILE);
}

/**
 * Whether a `loadTeamFile` / `currentTeam` problem is a line-attributed parse/validation error
 * (`problem.line > 0`, mapped to `*.file-invalid`) rather than an unparsed file-locate/read
 * problem (`problem.line === 0`, mapped to `*.not-a-repo` or `*.file`).
 */
export function isParseError(problem: Problem): boolean {
  return problem.line > 0;
}

/**
 * Whether a `loadTeamFile` / `currentTeam` problem is the no-repository refusal — no checkout
 * names this folder and no plain team root stands in it (a link found instead of one included) —
 * rather than an unreadable or invalid team file. The shared sentence offers `--file`; a command
 * that takes none prints `withoutFileOffer(problem.message)`.
 */
export function isNoRepository(problem: Problem): boolean {
  return problem.line === 0 && problem.message.startsWith(NOT_A_REPO);
}

// The team file in a folder that is not a git repository. The folder the process was given is
// resolved first: when that path is itself a link, the real directory is the folder (the shell
// chose it). Inside it, `.agents` must be a real directory and `team.yaml` a real file. A link at
// either is not opened. `null` is the ordinary miss (nothing there); `'link'` is a link standing
// where the file would be.
function plainFolderTeam(cwd: string): { root: string; path: string } | 'link' | null {
  let here: string;
  try {
    lstatSync(cwd);
    here = realpathSync(cwd);
  } catch {
    return null;
  }
  const agents = join(here, '.agents');
  let agentsStat: Stats;
  try {
    agentsStat = lstatSync(agents);
  } catch {
    return null;
  }
  if (agentsStat.isSymbolicLink()) return 'link';
  if (!agentsStat.isDirectory()) return null;
  const file = join(agents, 'team.yaml');
  let fileStat: Stats;
  try {
    fileStat = lstatSync(file);
  } catch {
    return null;
  }
  if (fileStat.isSymbolicLink()) return 'link';
  if (!fileStat.isFile()) return null;
  return { root: here, path: file };
}

// The project's root: the main checkout, found through git's common directory, so a command run
// in a subfolder or in a linked worktree reads the same `.agents/`.
export function findRoot(cwd: string): string | null {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return common ? dirname(common) : null;
  } catch {
    return null;
  }
}

// Finds, reads and validates the team file. With `file`, the root is the folder that holds the
// file's `.agents/`, or the file's own folder when it sits elsewhere.
export function loadTeamFile(cwd: string, options: { file?: string; home?: string; checkOnly?: boolean; fs?: FsReader; session?: string } = {}): LoadResult {
  let path: string;
  let root: string;
  // A named file is read and only that file: an empty name is not "no name", it names the
  // folder it resolves to, and a folder, a missing file or an unreadable one is a refusal.
  if (options.file !== undefined) {
    path = isAbsolute(options.file) ? options.file : resolve(cwd, options.file);
    const folder = dirname(path);
    root = folder.endsWith('.agents') ? dirname(folder) : folder;
  } else {
    const found = findRoot(cwd);
    if (!found) {
      // No git repository, so there is no checkout this folder belongs to. The team file is
      // `.agents/team.yaml` in this folder, and not in a parent: a walk up would read a
      // neighboring project. A repository that has no team file is unchanged — the git root's
      // file, present or missing, stays the one file — so a nested `.agents/team.yaml` cannot
      // take its place. A link at `.agents` or at `team.yaml` is not that file: it is refused
      // and not followed. `--file` still opens the path it names.
      const plain = plainFolderTeam(cwd);
      if (plain === 'link') {
        return { ok: false, errors: [{ line: 0, message: LINK_NOT_FOLLOWED }] };
      }
      if (!plain) {
        return { ok: false, errors: [{ line: 0, message: NOT_A_REPO }] };
      }
      root = plain.root;
      path = plain.path;
    } else {
      root = found;
      path = join(root, TEAM_FILE);
    }
  }
  if (!existsSync(path)) {
    return {
      ok: false,
      path,
      errors: [{
        line: 0,
        message: options.file !== undefined
          ? `no team file at ${options.file}`
          : 'no team file here; it is private to each clone: run `team init`, or `team init --restore` to bring back the copy this machine stored',
      }],
    };
  }
  // One read. Callers that store the text (approve) use this string, the one that was validated.
  // A path that cannot be read — a folder, a denied file — is a refusal, never a fallback to the
  // folder this command started in.
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, path, errors: [{ line: 0, message: `the team file at ${path} could not be read`, unreadable: true }] };
  }
  return loadTeamText(text, root, path, options, () => readFileSync(path, 'utf8'));
}

// Validates a team's text as the file reader does once it has read it: the same validation, the
// same placement problems, the same result. The registry source (src/file/team-config.ts) hands
// the text it stores here, so a team read from the registry is checked exactly as a file is.
export function loadTeamText(
  text: string,
  root: string,
  path: string,
  options: { home?: string; checkOnly?: boolean; fs?: FsReader; session?: string } = {},
  reread?: () => string,
): LoadResult {
  let result = validateWithWorkspaceMode(text, root, options);
  if (!result.ok && result.parse === true && reread !== undefined) {
    // The parse itself failed, which a file replaced under this reader can do transiently
    // (a writer that is not the atomic one): read and validate the settled file once more,
    // and report that attempt's problems if it fails too. A file that parses and then fails
    // validation is not re-read: its problems are its own.
    try {
      text = reread();
    } catch {
      return { ok: false, path, errors: [{ line: 0, message: `the team file at ${path} could not be read`, unreadable: true }] };
    }
    result = validateWithWorkspaceMode(text, root, options);
  }
  if (!result.ok) return { ...result, path };
  if (options.checkOnly) return { ...result, root, path, text };
  const errors = placedProblems(result.team, root, options.home, options.fs, options.session);
  return errors.length ? { ok: false, errors, path } : { ...result, root, path, text };
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// What only shows once the root is known: a folder named by its own name can still be the
// project's parent, as "../../Code/*" is for a project at ~/Code/acme. Validation on the text
// alone can't see that; here every fixed folder is resolved, symlinks included.
export function placedProblems(
  team: TeamFile,
  root: string,
  home: string = homedir(),
  fs?: FsReader,
  /** The session the command addresses: the lobby trust must list is that session's recorded
   *  one, which is the file's own unless the run names another (`up --session alt`). */
  session: string = team.session,
): Problem[] {
  const problems: Problem[] = [];
  const readLanding = (path: string) => {
    const res = canonicalLanding(path, fs);
    if (res.error) return { error: `cannot read ${res.error.path}: ${res.error.code}` as const };
    return res;
  };
  const project = real(root);
  const holdsProject = (folder: string) => {
    const full = real(resolve(project, folder));
    return full !== project && project.startsWith(full.endsWith(sep) ? full : full + sep);
  };
  const insideProj = (folder: string) => {
    const full = real(resolve(project, folder));
    return full === project || full.startsWith(project.endsWith(sep) ? project : project + sep);
  };

  // What the workspace.path itself must never do: put worktrees in the project's parent or above.
  const path = team.workspace.path;
  const folder = path ? path.split('/').slice(0, -1).join('/').replaceAll('{repo}', team.project) || '.' : null;
  if (path && folder && holdsProject(folder)) {
    problems.push({ line: 0, message: `workspace.path: "${path}" puts worktrees in the project's parent or a folder above it: give them a folder of their own` });
  }
  // A migrated file's worktrees are held to the same containment as its seats: never inside the
  // project, never inside a protected checkout. Main loaded legacy files and refused the seat at
  // placement, so these two checks stay off legacy files and seatStart keeps refusing them.
  if (path && folder && isMigratedTrust(team.trust)) {
    if (insideProj(folder)) {
      problems.push({ line: 0, message: `workspace.path: "${path}" puts worktrees inside the project: give them a folder of their own` });
    }
    const hit = protectedLanding(root, folder, team.workspace.protected);
    if (hit) {
      problems.push({ line: 0, message: `workspace.path: "${path}" puts worktrees inside the protected checkout ${hit}` });
    }
  }

  if (isLegacyTrust(team.trust)) {
    for (const pattern of team.trust) {
      if (holdsProject(fixedFolder(pattern))) {
        problems.push({ line: 0, message: `trust: "${pattern}" names the project's parent or a folder above it: it would trust every folder beside the project` });
      }
    }
    return problems;
  }

  if (isMigratedTrust(team.trust)) {
    const lobby = lobbyOf(home, root, { ...team, session });
    const lobbyRead = readLanding(lobby);
    const lobbyLanding = 'error' in lobbyRead ? null : lobbyRead.landing;
    if ('error' in lobbyRead) problems.push({ line: 0, message: `trust: ${lobbyRead.error}` });

    for (const entry of team.trust) {
      const expanded = resolve(entry.replace(/^~(?=$|\/)/, home));
      if (expanded === lobby || lobby.startsWith(expanded + sep)) continue;
      const res = readLanding(expanded);
      if ('error' in res) problems.push({ line: 0, message: `trust: "${entry}": ${res.error}` });
      else if (res.symlink) problems.push({ line: 0, message: `trust: "${entry}": ${res.symlink} is a symbolic link` });
    }

    const hasLobby = lobbyLanding !== null && team.trust.some((entry) => {
      const expanded = resolve(entry.replace(/^~(?=$|\/)/, home));
      const res = readLanding(expanded);
      return !('error' in res) && res.landing === lobbyLanding;
    });
    if (!hasLobby && lobbyLanding !== null) {
      problems.push({ line: 0, message: `trust: must list the lobby ${lobby}` });
    }

    // Every seat's cwd must equal an approved entry or be a descendant of one
    for (const seat of team.seats) {
      const seatPath = resolve(root, seat.cwd);
      const res = readLanding(seatPath);
      if ('error' in res) {
        problems.push({ line: seat.line, message: `seat ${seat.name}: cwd "${seat.cwd}": ${res.error}` });
        continue;
      }
      if (res.symlink) {
        problems.push({ line: seat.line, message: `seat ${seat.name}: cwd "${seat.cwd}" follows a symbolic link: ${res.symlink}` });
        continue;
      }
      const seatLanding = res.landing;
      const trusted = team.trust.some((entry) => {
        const expanded = resolve(entry.replace(/^~(?=$|\/)/, home));
        const landed = readLanding(expanded);
        if ('error' in landed) return false;
        return seatLanding === landed.landing || seatLanding.startsWith(landed.landing.endsWith(sep) ? landed.landing : landed.landing + sep);
      });
      if (!trusted) {
        problems.push({ line: seat.line, message: `seat ${seat.name}: cwd "${seat.cwd}" is outside trust` });
      }
    }

    // Workspace landing (workspace.path for any task)
    if (team.workspace.path) {
      const sample = team.workspace.path.replaceAll('{repo}', team.project).replace('{task}', 'task');
      const wtPath = resolve(root, sample);
      const res = readLanding(wtPath);
      if ('error' in res) {
        problems.push({ line: 0, message: `workspace.path: "${team.workspace.path}": ${res.error}` });
      } else if (res.symlink) {
        problems.push({ line: 0, message: `workspace.path: "${team.workspace.path}" follows a symbolic link: ${res.symlink}` });
      } else {
        const wtLanding = res.landing;
        const trusted = team.trust.some((entry) => {
          const expanded = resolve(entry.replace(/^~(?=$|\/)/, home));
          const landed = readLanding(expanded);
          if ('error' in landed) return false;
          return wtLanding === landed.landing || wtLanding.startsWith(landed.landing.endsWith(sep) ? landed.landing : landed.landing + sep);
        });
        if (!trusted) problems.push({ line: 0, message: `workspace.path: "${team.workspace.path}" is outside trust` });
      }
    }
  }

  return problems;
}

// A file that writes no `workspace.mode` works in the mode the signed policy chain resolves
// (`workspace-mode`, src/policy/work-settings.ts): it is read once without the worktree
// requirements to learn its entity and project, then validated for real in the resolved mode.
// A file that writes its mode is validated once, as before; so is every file when the chain holds
// no `workspace-mode` (the release default is `worktree`).
function validateWithWorkspaceMode(text: string, root: string, options: { home?: string; fs?: FsReader }): ReturnType<typeof validateTeamFile> {
  const plain = () => validateTeamFile(text, { home: options.home, fs: options.fs, root });
  if (fileDeclaresWorkspaceMode(text)) return plain();
  const probe = validateTeamFile(text, { home: options.home, fs: options.fs, root, workspaceMode: 'shared' });
  if (!probe.ok) return plain();
  let mode: 'worktree' | 'shared' = 'worktree';
  try {
    const home = options.home ?? homedir();
    let projectId: string | null = null;
    try {
      projectId = projectOfTeam(home, teamIdOf(root))?.id ?? null;
    } catch {}
    mode = resolveWorkSettings(readPolicyChain({ home, teamRoot: root, team: probe.team, projectId }), {}, { home }).workspaceMode.value;
  } catch {
    mode = 'worktree';
  }
  return mode === 'shared' ? probe : plain();
}
