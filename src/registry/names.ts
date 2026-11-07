// Seat nicknames across the entity: the name a seat goes by is its written label's persona when
// the `nickname:` field could hold it, and the field otherwise
// (src/file/sections/seats.ts:seatNicknames) — the word the launch gives its session and the
// message header carries (src/send/names.ts). The owner's `names.unique` word on the entity
// (src/entities.ts) says how far apart those names must stay: across the whole entity (the
// default), within a project, within a team, or not at all.
//
// The word is checked where a nickname is newly set — `team init`, `team add`, and `team config
// set` on a seat's label or on a whole seat map — and never against a team that already carries
// a duplicate: a running team is never refused (up, restart and reload do not read this file),
// and `team check` names the pair as a note (nicknameTakenNotes).
//
// The name read here is the one the roster and the launch carry, read by the file's own rule: a
// label's word that the field could not hold (a space, an accent, the reserved `lead`, a word
// another seat already carries) is display alone and is not held apart — only the name a seat
// can be addressed by is. A word equal to the seat's own name is not a nickname either: the
// seat's name is unique in its team already, and every plain `team add` writes it.
import { projectIdOfTeam } from '../dev_mode.ts';
import { namesUniqueFor, type NicknameScope } from '../entities.ts';
import { seatNickname } from '../file/sections/seats.ts';
import type { TeamFile } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import { readStoredTeamConfig, type StoredTeamConfig } from './team-config-store.ts';
import { readTeams, teamIdOf, TeamsError, type TeamRecord } from './teams.ts';

/** The comparison the setting names: case-insensitive, so `Cicero` and `cicero` are one name. */
export function sameNickname(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The nickname a seat carries, or null when it has none: the name the seat goes by
 * (src/file/sections/seats.ts:seatNickname), unless that word is the seat's own name (a plain
 * `team add` writes `label: <name>`, and the seat's name is unique in its team by the file's own
 * check).
 */
function heldNickname(
  seats: ReadonlyArray<{ name: string; nickname?: string; label: string; labelWritten?: boolean }>,
  seat: { name: string; nickname?: string; label: string; labelWritten?: boolean },
): string | null {
  const name = seatNickname(seats, seat);
  if (name === null || sameNickname(name, seat.name)) return null;
  return name;
}

/** One seat carrying a nickname, with the team that holds it. */
export type NicknameHolder = {
  nickname: string;
  teamId: string;
  /** The team's own name — the file's `project:` key. */
  team: string;
  root: string;
  entity: string | null;
  projectId: string | null;
  seat: string;
};

/** The seat a nickname is checked against: the team the write is for, as the new file says it. */
export type NicknameOwner = { teamId: string; entity: string | null; projectId: string | null };

/** The team's project as its record and file name it: the id a `project` scope compares, and the
 *  name the refusal prints. */
function projectOf(
  home: string,
  record: TeamRecord | null,
  team: TeamFile | null,
  root: string,
): { id: string | null; name: string | null } {
  let id: string | null = null;
  try {
    id = projectIdOfTeam(home, team, root);
  } catch {
    id = record?.projectId ?? null;
  }
  const name = team?.inProject ?? team?.project ?? record?.project ?? null;
  return { id, name };
}

/** A team's seats as its stored record text writes them, or null when that text is missing or
 *  does not read — the caller then falls back to the roster. */
function storedSeats(home: string, id: string): { team: TeamFile; seats: Array<{ seat: string; nickname: string }> } | null {
  let stored: StoredTeamConfig | null = null;
  try {
    stored = readStoredTeamConfig(home, id);
  } catch {
    return null;
  }
  if (stored === null) return null;
  const parsed = validateTeamFile(stored.text, { home, root: stored.root });
  if (!parsed.ok) return null;
  const seats = parsed.team.seats.flatMap((seat) => {
    const nickname = heldNickname(parsed.team.seats, seat);
    return nickname === null ? [] : [{ seat: seat.name, nickname }];
  });
  return { team: parsed.team, seats };
}

/** The roster's own nicknames, for a team whose stored text cannot be read: the name the last
 *  launch marked, taken as the same projection the record derives (src/registry/sync.ts). */
function rosterSeats(record: TeamRecord): Array<{ seat: string; nickname: string }> {
  return record.roster.flatMap((line) => {
    const nickname = line.nickname;
    if (nickname === undefined || sameNickname(nickname, line.seat)) return [];
    return [{ seat: line.seat, nickname }];
  });
}

/**
 * Every seat carrying a nickname in the registry's teams, `exceptTeamId` left out and archived
 * teams left out: a team no longer running holds no name a new one cannot take. A team's own
 * stored text is read before its roster lines — the record is the team as its commands wrote it,
 * the roster what the last launch marked — and a registry that cannot be read holds nobody.
 */
export function nicknameHolders(home: string, exceptTeamId: string): NicknameHolder[] {
  let teams: Record<string, TeamRecord>;
  try {
    teams = readTeams(home);
  } catch (error) {
    if (error instanceof TeamsError) return [];
    throw error;
  }
  const out: NicknameHolder[] = [];
  for (const [id, record] of Object.entries(teams)) {
    if (id === exceptTeamId || record.lifecycle === 'archived') continue;
    const stored = storedSeats(home, id);
    const project = projectOf(home, record, stored?.team ?? null, record.root);
    for (const seat of stored?.seats ?? rosterSeats(record)) {
      out.push({
        nickname: seat.nickname,
        teamId: id,
        team: record.project,
        root: record.root,
        entity: record.entity,
        projectId: project.id,
        seat: seat.seat,
      });
    }
  }
  return out;
}

/** Whether a holder is inside the scope the owner set for this team. `team` and `off` never
 *  reach across teams; a team's own file check holds its seats' names apart. */
function withinScope(holder: NicknameHolder, own: NicknameOwner, scope: NicknameScope): boolean {
  if (scope === 'off' || scope === 'team' || own.entity === null) return false;
  if (holder.entity !== own.entity) return false;
  if (scope === 'project' && (own.projectId === null || holder.projectId !== own.projectId)) return false;
  return true;
}

/** The holder of `nickname` the scope makes a clash, or null. */
export function nicknameClash(home: string, own: NicknameOwner, nickname: string, scope: NicknameScope): NicknameHolder | null {
  if (scope === 'off' || scope === 'team' || own.entity === null) return null;
  for (const holder of nicknameHolders(home, own.teamId)) {
    if (!withinScope(holder, own, scope)) continue;
    if (sameNickname(holder.nickname, nickname)) return holder;
  }
  return null;
}

/** The values of `names.unique` that would allow this pair: `project` only helps when the other
 *  team sits in another project of the entity. */
function relaxingValues(scope: NicknameScope, own: NicknameOwner, holder: NicknameHolder): string {
  const otherProject = holder.projectId !== null && holder.projectId !== own.projectId;
  return scope === 'entity' && otherProject ? 'project, team or off' : 'team or off';
}

/** The refusal's one sentence: the name, the other team and seat, the rule in force, and the
 *  word that would allow it. */
function refusalOf(holder: NicknameHolder, own: NicknameOwner & { projectName: string | null }, scope: NicknameScope): string {
  const where = scope === 'entity'
    ? `across entity "${own.entity}"`
    : `within project "${own.projectName ?? own.projectId ?? ''}"`;
  return `the nickname "${holder.nickname}" is already held by seat "${holder.seat}" of team "${holder.team}"; seat nicknames are unique ${where}, and names.unique: ${relaxingValues(scope, own, holder)} in the entity's names entry in entities.yaml would allow it`;
}

/** What the write sites take: the team as it reads now (`null` where the write creates it) and
 *  as the write would leave it. */
export type NicknameGate =
  | { ok: true }
  | { ok: false; message: string };

/**
 * The check a write site makes: every nickname the new file would carry that the old one did not
 * already carry is held apart by the entity's `names.unique` word. A name the old file already
 * carried is not checked again — a team that already holds a duplicate keeps running, and only a
 * nickname this write brings is refused. `before` is null for a team the write creates
 * (`team init`): every nickname in `after` is new. A home that cannot be read (no registry, no
 * entities file, a team that names no entity) checks nothing.
 */
export function nicknameChangeGate(input: {
  home: string | undefined;
  teamId: string;
  root: string;
  before: TeamFile | null;
  after: TeamFile;
}): NicknameGate {
  const { home, after } = input;
  if (home === undefined) return { ok: true };
  const scope = namesUniqueFor(home, after.entity);
  if (scope === 'off' || scope === 'team') return { ok: true };
  const held = new Set<string>();
  if (input.before !== null) {
    for (const seat of input.before.seats) {
      const name = heldNickname(input.before.seats, seat);
      if (name !== null) held.add(name.toLowerCase());
    }
  }
  const fresh = after.seats.flatMap((seat) => {
    const nickname = heldNickname(after.seats, seat);
    if (nickname === null || held.has(nickname.toLowerCase())) return [];
    return [{ nickname }];
  });
  if (fresh.length === 0) return { ok: true };
  const project = projectOf(home, null, after, input.root);
  const own: NicknameOwner & { projectName: string | null } = {
    teamId: input.teamId,
    entity: after.entity,
    projectId: project.id,
    projectName: project.name,
  };
  for (const seat of fresh) {
    const holder = nicknameClash(home, own, seat.nickname, scope);
    if (holder !== null) return { ok: false, message: refusalOf(holder, own, scope) };
  }
  return { ok: true };
}

/**
 * `team check`'s note: a seat whose nickname another team's seat already carries, inside the
 * scope the owner set. A note, never a difference — the team runs either way, and the word is
 * checked only where a nickname is newly set — and it names both seats and the teams they hold.
 * A check with no home answers for no registry, as the other notes do.
 */
export function nicknameTakenNotes(team: TeamFile, root: string, home: string | undefined): string[] {
  if (home === undefined) return [];
  const scope = namesUniqueFor(home, team.entity);
  if (scope === 'off' || scope === 'team' || team.entity === null) return [];
  const project = projectOf(home, null, team, root);
  const own: NicknameOwner = {
    teamId: teamIdOf(root),
    entity: team.entity,
    projectId: project.id,
  };
  const holders = nicknameHolders(home, own.teamId).filter((holder) => withinScope(holder, own, scope));
  if (holders.length === 0) return [];
  const notes: string[] = [];
  for (const seat of team.seats) {
    const nickname = heldNickname(team.seats, seat);
    if (nickname === null) continue;
    const holder = holders.find((candidate) => sameNickname(candidate.nickname, nickname));
    if (holder === undefined) continue;
    const where = scope === 'entity'
      ? `across entity "${team.entity}"`
      : `within project "${project.name ?? project.id ?? ''}"`;
    notes.push(`seat "${seat.name}": its nickname "${nickname}" is also held by seat "${holder.seat}" of team "${holder.team}" — seat nicknames are unique ${where}; existing duplicates keep running, and only a nickname newly set is refused`);
  }
  return notes;
}
