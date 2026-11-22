// Which registered team a command binds to. The folder wins, then the caller's own placement,
// and only then does a shared seat name refuse. A team's places are its registered root,
// each seat's configured cwd (resolved against that root), and its own lobby when no other team
// records that path. The longest place that holds the cwd wins.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { callerOf, standingOf } from '../caller.ts';
import type { Io } from '../io.ts';
import { lobbyDir } from '../lobby/gate.ts';
import { parseYaml, type YamlNode } from '../yaml.ts';
import { readTeams, teamIdOf, type TeamRecord } from './teams.ts';

/** The caller a placement check reads. Every field is optional: a command that has not placed
 *  anyone still binds by the folder. */
export type BindingIo = Partial<Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>>;

/** The team file at a registered root. The same relative path as `TEAM_FILE` in the loader. */
const TEAM_FILE = '.agents/team.yaml';

/** The path as it really stands, or the absolute path when it is not there yet. */
function realPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Whether `cwd` is `root` or a descendant of it. A path separator keeps `/a/team` from
 *  matching `/a/team-other`. Both sides are real paths. */
export function rootHolds(root: string, cwd: string): boolean {
  return realHolds(realPath(root), realPath(cwd));
}

/** `rootHolds` for two paths already real. */
function realHolds(left: string, right: string): boolean {
  return right === left || right.startsWith(left.endsWith(sep) ? left : `${left}${sep}`);
}

export type TeamBinding =
  | { kind: 'bound'; team: TeamRecord; by: 'place' | 'caller' }
  | { kind: 'ambiguous'; ids: readonly string[]; message: string }
  | { kind: 'unbound' }
  | { kind: 'unreadable'; message: string };

/** A team's recorded lobby paths, with blanks dropped. The primary `lobby` and every session
 *  entry count: a command has not chosen a session yet when it binds. */
function lobbyPaths(team: TeamRecord): string[] {
  const values = [team.lobby, ...Object.values(team.lobbies ?? {})];
  return [...new Set(values.filter((value) => value !== ''))];
}

/** A seat cwd that must not become a place: `/`, the home folder, the shared default lobby,
 *  or any ancestor of the team's own root. Each wide folder would claim every folder under
 *  it, and the shared lobby is a place for no team. `.` is already the root. Every path is real:
 *  `wide` holds `/`, the home folder and the shared lobby as they stand. */
function addsNoPlace(wide: readonly string[], realRoot: string, path: string): boolean {
  if (wide.includes(path)) return true;
  return path !== realRoot && realHolds(path, realRoot);
}

/** Each team file's last parse, by path, with the stat stamp it was read under: the file's inode,
 *  size, mtime and ctime (the fields `agentFolderStamp` keeps per agent file). Every send binds
 *  against every registered team's file; one whose stamp stands is not read or parsed again. A
 *  file that cannot be read or parsed is null, as before. The parse is shared read-only. */
const parsedTeamFiles = new Map<string, { stamp: string; doc: YamlNode | null }>();
const PARSED_TEAM_FILES = 64;

function fileStamp(path: string): string | null {
  try {
    // Followed, not lstat: a team file that is a link is judged by the file it names.
    const one = statSync(path);
    return `${String(one.ino)}:${String(one.size)}:${String(one.mtimeMs)}:${String(one.ctimeMs)}`;
  } catch {
    return null;
  }
}

/** The team file at `root` as a parsed document, or null when it is missing or unreadable. */
function teamFileDoc(root: string): YamlNode | null {
  const path = join(root, TEAM_FILE);
  const stamp = fileStamp(path);
  const kept = parsedTeamFiles.get(path);
  if (stamp !== null && kept !== undefined && kept.stamp === stamp) return kept.doc;
  let doc: YamlNode | null;
  try {
    doc = parseYaml(readFileSync(path, 'utf8'));
  } catch {
    doc = null;
  }
  parsedTeamFiles.delete(path);
  // Kept only when the file stood still across the read: a write during it is read again.
  if (stamp !== null && fileStamp(path) === stamp) {
    parsedTeamFiles.set(path, { stamp, doc });
    while (parsedTeamFiles.size > PARSED_TEAM_FILES) parsedTeamFiles.delete(parsedTeamFiles.keys().next().value!);
  }
  return doc;
}

/** Seat `cwd` values from the team file at `root`, resolved against that root. A missing or
 *  unreadable file contributes none: the root itself is still a place. `.` is the root. */
function configuredCwds(root: string): string[] {
  const doc = teamFileDoc(root);
  if (doc === null || doc.kind !== 'map') return [];
  const seats = doc.entries.find((entry) => entry.key === 'seats')?.value;
  if (seats === undefined || seats.kind !== 'seq') return [];
  const found: string[] = [];
  for (const item of seats.items) {
    if (item.kind !== 'map') continue;
    const cwd = item.entries.find((entry) => entry.key === 'cwd')?.value;
    if (cwd === undefined || cwd.kind !== 'scalar' || typeof cwd.value !== 'string') continue;
    if (cwd.value === '' || cwd.value === '.') continue;
    found.push(resolve(root, cwd.value));
  }
  return found;
}

/** A place, with its path as it really stands (resolved once per binding). */
type Place = { team: TeamRecord; path: string; real: string };

/** Every place a command can bind to. A lobby path recorded by more than one team binds none
 *  of them. The shared `~/.config/team/lobby` binds no one, even when a single team records it. */
function boundPlaces(home: string, teams: readonly TeamRecord[]): Place[] {
  const shared = realPath(lobbyDir(home));
  const lobbyOwners = new Map<string, TeamRecord>();
  const sharedLobbies = new Set<string>();
  for (const team of teams) {
    for (const lobby of lobbyPaths(team)) {
      const path = realPath(lobby);
      if (path === shared) continue;
      const owner = lobbyOwners.get(path);
      if (owner === undefined) lobbyOwners.set(path, team);
      else if (owner !== team) sharedLobbies.add(path);
    }
  }
  const wide = [realPath('/'), realPath(home), shared];
  const places: Place[] = [];
  for (const team of teams) {
    const realRoot = realPath(team.root);
    places.push({ team, path: team.root, real: realRoot });
    for (const cwd of configuredCwds(team.root)) {
      const real = realPath(cwd);
      if (!addsNoPlace(wide, realRoot, real)) places.push({ team, path: cwd, real });
    }
  }
  for (const [path, team] of lobbyOwners) {
    if (!sharedLobbies.has(path)) places.push({ team, path, real: path });
  }
  return places;
}

/** Seat names the team file at `root` declares. A missing or unreadable file declares none. */
function declaredSeatNames(root: string): string[] {
  const doc = teamFileDoc(root);
  if (doc === null || doc.kind !== 'map') return [];
  const seats = doc.entries.find((entry) => entry.key === 'seats')?.value;
  if (seats === undefined || seats.kind !== 'seq') return [];
  const names: string[] = [];
  for (const item of seats.items) {
    if (item.kind !== 'map') continue;
    const name = item.entries.find((entry) => entry.key === 'name')?.value;
    if (name === undefined || name.kind !== 'scalar' || typeof name.value !== 'string' || name.value === '') continue;
    names.push(name.value);
  }
  return names;
}

/** Whether `seat` belongs to `team`: the registry roster, or a seat the team file declares.
 *  A record with no roster still holds the seats its file names. */
export function teamHoldsSeat(team: TeamRecord, seat: string): boolean {
  if (team.roster.some((line) => line.seat === seat)) return true;
  return declaredSeatNames(team.root).includes(seat);
}

/**
 * The one team whose state records this caller on its pane. The pane is asked
 * before any folder: herdr's name, that team's session, and the recorded pane.
 * None, or more than one, is no placement, and the folder decides. `teamBinding`
 * itself stays folder-then-caller. A command asks here first through `addressedTeam`.
 */
export function placedCallerTeam(home: string, io: BindingIo): TeamRecord | null {
  let teams: Record<string, TeamRecord>;
  try {
    teams = readTeams(home);
  } catch {
    return null;
  }
  const placed = candidateTeams(io, Object.values(teams)).filter((team) => callerStandsIn(io, team));
  return placed.length === 1 ? placed[0]! : null;
}

/** The herdr session a pane belongs to, read from the socket path herdr hands every pane
 *  (`HERDR_SOCKET_PATH`, `…/sessions/<name>/herdr.sock`), or null when it is absent or not that
 *  shape. A hint only: it never places anyone. */
export function hintedHerdrSession(env: Record<string, string | undefined> | undefined): string | null {
  const path = env?.HERDR_SOCKET_PATH;
  if (path === undefined || path === '') return null;
  const match = /[\\/]sessions[\\/]([^\\/]+)[\\/]herdr\.sock$/.exec(path);
  return match ? match[1]! : null;
}

/** The teams worth running the placement proof for. Each proof reads that team's herdr session
 *  (one child process per pane it lists), so a caller checked against every registered team paid
 *  for every running session on the machine (about 0.2 s of a 0.9 s send, 2026-11-17). A pane's
 *  root process is a child of exactly one herdr server, so a caller can stand only in teams of
 *  its own pane's session: when the socket hint names a session some team uses, only those teams
 *  are proved. The narrowing can only drop placements, never make one: a wrong or forged hint
 *  leaves the caller unplaced (refused), and a missing hint, a hint no team uses, or a caller
 *  handed in whole keep the full scan. */
function candidateTeams(io: BindingIo, teams: TeamRecord[]): TeamRecord[] {
  if (io.caller !== undefined) return teams;
  const session = hintedHerdrSession(io.env);
  if (session === null) return teams;
  const own = teams.filter((team) => team.session === session);
  return own.length > 0 ? own : teams;
}

/** Whether the caller stands on the pane `team`'s state records for it, in that team's session. */
function callerStandsIn(io: BindingIo, team: TeamRecord): boolean {
  const caller = callerOf({
    env: io.env ?? {},
    stdinIsTTY: io.stdinIsTTY ?? false,
    ...(io.caller !== undefined ? { caller: io.caller } : {}),
    ...(io.callerSources !== undefined ? { callerSources: io.callerSources } : {}),
  }, team.session);
  if (caller.kind !== 'seat' || caller.session !== team.session) return false;
  const at = standingOf(join(team.root, '.agents'), team.session, caller);
  return at.recordedPane !== undefined && at.recordedPane === caller.pane;
}

/**
 * The team a command that changes a team addresses when no flag names a file.
 *
 * A folder that is a registered place of one team is that team's, whoever runs there: a seat of
 * another team placed on its own pane does not carry its own team into it. The command's own
 * gate then judges the caller against the folder's team, so a caller with no standing there is
 * refused, and the caller's own team is never the fallback (a `team down` run in a nested
 * team's folder once stopped the outer team that placed the caller). Where no place holds the
 * cwd, the pane is asked: one team whose state records this caller on its pane is that root and
 * roster. None, or more than one, leaves `teamBinding` unchanged.
 */
export function addressedTeam(home: string, cwd: string, seat: string | undefined, io?: BindingIo): TeamBinding {
  if (io !== undefined) {
    const placed = placedCallerTeam(home, io);
    if (placed !== null) {
      const folder = teamBinding(home, cwd, seat);
      if (folder.kind === 'bound' && folder.by === 'place' && !sameTeam(folder.team, placed)) return folder;
      // A folder two teams claim is the caller's own when its team is one of them.
      if (folder.kind === 'ambiguous' && !folder.ids.includes(teamIdOfRecord(placed))) return folder;
      return { kind: 'bound', team: placed, by: 'caller' };
    }
  }
  return teamBinding(home, cwd, seat, io);
}

/**
 * The pane-first reading `addressedTeam` used before folders won: the one team whose state
 * records this caller on its pane, else the folder. Only a seat's own bootstrap reads it (the
 * inbox setup a seat's CLI starts in its working folder), where the pane, not the folder, names
 * the seat's team; no command that changes a team does.
 */
export function paneFirstTeam(home: string, cwd: string, seat: string | undefined, io?: BindingIo): TeamBinding {
  if (io !== undefined) {
    const placed = placedCallerTeam(home, io);
    if (placed !== null) return { kind: 'bound', team: placed, by: 'caller' };
  }
  return teamBinding(home, cwd, seat, io);
}

function teamIdOfRecord(team: TeamRecord): string {
  return team.id ?? teamIdOf(team.root);
}

function sameTeam(a: TeamRecord, b: TeamRecord): boolean {
  return teamIdOfRecord(a) === teamIdOfRecord(b);
}

/** Whether the folder is a registered place of a team other than the caller's placed one, so a
 *  command that changes a team acts on the folder's team (`addressedTeam`), never the caller's.
 *  A folder two teams claim counts as another team's only when the caller's team is not one. */
export function folderOfAnotherTeam(home: string, cwd: string, seat: string | undefined, placed: TeamRecord): boolean {
  const folder = teamBinding(home, cwd, seat);
  if (folder.kind === 'bound') return folder.by === 'place' && !sameTeam(folder.team, placed);
  return folder.kind === 'ambiguous' && !folder.ids.includes(teamIdOfRecord(placed));
}

/**
 * The team a command run at `cwd` addresses.
 *
 * Explicit flags (`--file`, `seat@team`, `--client`) never reach here. Otherwise the longest
 * bound place that holds the cwd wins: the team's registered root, a seat's configured cwd
 * resolved against that root, or the team's own lobby when no other team records that path.
 *
 * Two teams whose longest place is the same folder are refused by id. A seat cwd of `/`, the
 * home folder, or an ancestor of that team's root is not a place.
 *
 * When no place holds the cwd, the caller's own placement decides: the one team whose state
 * records the caller on its pane. A shared seat name is refused only after that, and only when
 * the caller stands in none of the teams. A seat is held by the registry roster or by the
 * team file's declared seats. With no caller and no place, the command keeps its own resolution.
 *
 * A registry that cannot be read is unbound. Binding does not answer for it: the command keeps
 * the refusal and the exit it already had for that folder.
 */
export function teamBinding(home: string, cwd: string, seat?: string, io?: BindingIo): TeamBinding {
  let teams: Record<string, TeamRecord>;
  try {
    teams = readTeams(home);
  } catch {
    return { kind: 'unbound' };
  }
  const listed = Object.values(teams);
  // The caller's folder is resolved once, not once per place.
  const realCwd = realPath(cwd);
  const holding = boundPlaces(home, listed).filter((place) => realHolds(place.real, realCwd));
  if (holding.length > 0) {
    const longest = Math.max(...holding.map((place) => place.real.length));
    const top = holding.filter((place) => place.real.length === longest);
    const ids = [...new Set(top.map((place) => place.team.id ?? teamIdOf(place.team.root)))].sort();
    if (ids.length > 1) {
      return {
        kind: 'ambiguous',
        ids,
        message: `this folder is a place of more than one team (${ids.join(', ')}); name the team by its id`,
      };
    }
    return { kind: 'bound', team: top[0]!.team, by: 'place' };
  }
  const named = seat !== undefined && seat !== '';
  const holders = named ? listed.filter((team) => teamHoldsSeat(team, seat)) : listed;
  if (io !== undefined) {
    const placed = candidateTeams(io, holders).filter((team) => callerStandsIn(io, team));
    if (placed.length === 1) return { kind: 'bound', team: placed[0]!, by: 'caller' };
  }
  if (!named || holders.length < 2) return { kind: 'unbound' };
  const ids = holders.map((team) => team.id ?? teamIdOf(team.root)).sort();
  return {
    kind: 'ambiguous',
    ids,
    message: `${seat} is a seat of more than one team (${ids.join(', ')}); name the team by its id`,
  };
}
