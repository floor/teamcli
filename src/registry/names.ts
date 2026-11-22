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
import { editedRecordText, withValue } from '../config/team-record.ts';
import { projectIdOfTeam } from '../dev_mode.ts';
import { namesAutoFor, namesUniqueFor, type NamesAuto, type NicknameScope } from '../entities.ts';
import { DAEMON_NAME, LEAD_NAME, labelPersona, SEAT_NAME, seatNickname } from '../file/sections/seats.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import { parseYaml, toValue } from '../yaml.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentRunMemo } from '../run-memo.ts';
import { writeAtomic } from '../state.ts';
import { NAME_POOL_DEFAULT, NAME_POOLS } from './name-pools.ts';
import { readStoredTeamConfig } from './team-config-store.ts';
import { TEAM_FILE } from '../file/load.ts';
import { teamTextTarget } from '../file/team-text.ts';
import { readTeams, teamIdOf, TeamsError, withTeamsLock, type TeamRecord } from './teams.ts';

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

/**
 * Every seat carrying a nickname in the registry's teams, `exceptTeamId` left out and archived
 * teams left out: a team no longer running holds no name a new one cannot take. Every copy of a
 * team counts — its stored record, its team file and its roster (teamView) — so a copy that lags
 * never hides a name another shows; a registry that cannot be read holds nobody.
 */
export function nicknameHolders(home: string, exceptTeamId: string): NicknameHolder[] {
  let teams: Record<string, TeamRecord>;
  try {
    teams = readTeams(home);
  } catch (error) {
    if (error instanceof TeamsError) return [];
    throw error;
  }
  const rows = rowHolders(home, teams);
  // A name claimed under the naming lock is held as well until the registry's own view shows it
  // for that team and seat — a first run before its row, or a row whose stored record or roster
  // has not caught up with the write (claimNames).
  return [
    ...liveClaims(home, teams, rows).filter((claim) => claim.teamId !== exceptTeamId),
    ...rows.filter((holder) => holder.teamId !== exceptTeamId),
  ];
}

/** One team as every copy of it shows it: the seats it declares and the nicknames they carry. */
type TeamView = { team: TeamFile | null; seats: Set<string>; named: Array<{ seat: string; nickname: string }> };

/**
 * A team as the registry's stored record, its team file (when that is its active source) and its
 * roster show it — the union, never one copy preferred over another: a file-backed team's stored
 * copy can lag its team file and roster, and a name any copy shows is held. A copy that cannot be
 * read adds nothing.
 */
function teamView(home: string, id: string, root: string, record: TeamRecord | null): TeamView {
  const view: TeamView = { team: null, seats: new Set(), named: [] };
  const seen = new Set<string>();
  const hold = (seat: string, nickname: string) => {
    const key = `${seat}\u0000${nickname.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    view.named.push({ seat, nickname });
  };
  const add = (text: string, at: string) => {
    const parsed = validateTeamFile(text, { home, root: at });
    if (!parsed.ok) return;
    view.team ??= parsed.team;
    for (const seat of parsed.team.seats) {
      view.seats.add(seat.name);
      const nickname = heldNickname(parsed.team.seats, seat);
      if (nickname !== null) hold(seat.name, nickname);
    }
  };
  try {
    const stored = readStoredTeamConfig(home, id);
    if (stored !== null) add(stored.text, stored.root);
  } catch {}
  // The team file counts only where it is the team's active source, as every configuration read
  // decides (src/file/team-text.ts:teamTextTarget): a registry-backed team's leftover file from
  // its import is not the team, and a name it still carries is free.
  let fileActive = false;
  try {
    fileActive = teamTextTarget(join(root, TEAM_FILE), { home }).kind === 'file';
  } catch {}
  if (fileActive) {
    try {
      add(readFileSync(join(root, TEAM_FILE), 'utf8'), root);
    } catch {}
  }
  for (const line of record?.roster ?? []) {
    view.seats.add(line.seat);
    if (line.nickname !== undefined && !sameNickname(line.nickname, line.seat)) hold(line.seat, line.nickname);
  }
  return view;
}

/** Every seat carrying a nickname in any copy of the registry's teams (teamView); archived teams
 *  left out. */
function rowHolders(home: string, teams: Record<string, TeamRecord>): NicknameHolder[] {
  const out: NicknameHolder[] = [];
  for (const [id, record] of Object.entries(teams)) {
    if (record.lifecycle === 'archived') continue;
    const view = teamView(home, id, record.root, record);
    const project = projectOf(home, record, view.team, record.root);
    for (const seat of view.named) {
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

// Names handed out: a seat with no nickname takes the first free name of its entity's pool
// (`names.pool`, src/registry/name-pools.ts) at `team add` and `team up`, while `names.auto` is
// on, and `team names fill` names every such seat at once. The name is written as a manual one is
// — the record's `nickname:` and the persona part of its `label:`, through the same validated
// writer — so the next header, launch and roster read it like any other name.

// The name claims: a small ledger beside the registry, `name-claims.json`, written only under the
// naming lock in the same transaction as the record write that brings a nickname. It closes the
// one gap the registry leaves: a team's nicknames reach other allocators through its registry
// row, its stored record or its roster, and a first run writes its record well before `up`
// registers the row, while a file-backed team's roster is refreshed after the write. A claim
// counts until that view shows the nickname for its team and seat, and for a day at most, and each
// claiming write prunes the rest, so a forgotten team or a removed seat leaves nothing behind.
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

type NameClaim = NicknameHolder & { at: string };

function claimsPath(home: string): string {
  return join(home, '.config', 'team', 'name-claims.json');
}

function readClaims(home: string): NameClaim[] {
  try {
    const value = JSON.parse(readFileSync(claimsPath(home), 'utf8')) as { claims?: unknown };
    if (!Array.isArray(value.claims)) return [];
    return value.claims.filter((claim): claim is NameClaim => typeof claim === 'object' && claim !== null
      && typeof (claim as NameClaim).nickname === 'string' && typeof (claim as NameClaim).teamId === 'string'
      && typeof (claim as NameClaim).seat === 'string' && typeof (claim as NameClaim).at === 'string');
  } catch {
    return [];
  }
}

/**
 * Whether a claim is still in force: younger than a day; not yet shown by the registry's view (no
 * copy there carries that nickname for that team and seat — the name is held by the row then);
 * and of a team and seat that still exist: a team the registry archived, or a seat no copy of its
 * team declares any more, releases the name.
 */
function claimInForce(home: string, claim: NameClaim, teams: Record<string, TeamRecord>, rows: readonly NicknameHolder[], now: number): boolean {
  if (!(now - Date.parse(claim.at) < CLAIM_TTL_MS)) return false;
  if (rows.some((holder) => holder.teamId === claim.teamId && holder.seat === claim.seat && sameNickname(holder.nickname, claim.nickname))) return false;
  const record = Object.hasOwn(teams, claim.teamId) ? teams[claim.teamId]! : null;
  if (record !== null && record.lifecycle === 'archived') return false;
  return teamView(home, claim.teamId, record?.root ?? claim.root, record).seats.has(claim.seat);
}

function liveClaims(home: string, teams: Record<string, TeamRecord>, rows: readonly NicknameHolder[], now: number = Date.now()): NameClaim[] {
  return readClaims(home).filter((claim) => claimInForce(home, claim, teams, rows, now));
}

/** Retires every claim no longer in force from the ledger itself, not only from one reading of
 *  it. Run at the naming lock's entry, so every pick under the lock reads a pruned ledger. */
function pruneClaims(home: string, now: number = Date.now()): NameClaim[] {
  const all = readClaims(home);
  if (all.length === 0) return [];
  let teams: Record<string, TeamRecord> = {};
  try {
    teams = readTeams(home);
  } catch {
    return all;
  }
  const kept = liveClaims(home, teams, rowHolders(home, teams), now);
  if (kept.length !== all.length) writeAtomic(claimsPath(home), `${JSON.stringify({ format: 1, claims: kept }, null, 2)}\n`);
  return kept;
}

/**
 * Publishes the nicknames `after` brings that `before` did not carry, as claims of this team, and
 * prunes every claim no longer in force. Called inside the naming lock, right after the record
 * write, so the next allocator — in this checkout or another — sees the name before the lock is
 * released.
 */
export function claimNames(input: { home: string | undefined; root: string; before: TeamFile | null; after: TeamFile; now?: Date }): void {
  const { home, after } = input;
  if (home === undefined) return;
  const held = new Set((input.before?.seats ?? []).flatMap((seat) => {
    const name = heldNickname(input.before!.seats, seat);
    return name === null ? [] : [`${seat.name}\u0000${name.toLowerCase()}`];
  }));
  const teamId = teamIdOf(input.root);
  const project = projectOf(home, null, after, input.root);
  const at = (input.now ?? new Date()).toISOString();
  const fresh: NameClaim[] = after.seats.flatMap((seat) => {
    const nickname = heldNickname(after.seats, seat);
    if (nickname === null || held.has(`${seat.name}\u0000${nickname.toLowerCase()}`)) return [];
    return [{ nickname, teamId, team: after.project, root: input.root, entity: after.entity, projectId: project.id, seat: seat.name, at }];
  });
  const kept = pruneClaims(home, (input.now ?? new Date()).getTime()).filter((claim) => !(claim.teamId === teamId && fresh.some((one) => one.seat === claim.seat)));
  if (fresh.length === 0) return;
  writeAtomic(claimsPath(home), `${JSON.stringify({ format: 1, claims: [...kept, ...fresh] }, null, 2)}\n`);
}

/** The one lock every naming write takes — the registry's teams lock, machine-wide, so it covers
 *  every `names.unique` scope: a pick and its write inside it are one transaction. */
export function withNamingLock<T>(home: string | undefined, work: () => T): T {
  if (home === undefined) return work();
  return withTeamsLock(home, () => {
    // A fresh view inside the lock: a registry row another process wrote after this run first
    // read the registry must not be hidden by the run's memo.
    const memo = currentRunMemo();
    if (memo !== null) {
      memo.teamsStrict.clear();
      memo.teamsTolerant.clear();
      memo.teamLoads.clear();
    }
    // Claims the registry's view now shows, or whose team or seat is gone, leave the ledger.
    pruneClaims(home);
    return work();
  });
}

/** One seat's handed-out name: the nickname, and the label it now carries (`<Nickname> · <role>`). */
export type NameAssignment = { seat: string; nickname: string; label: string };

/** The entity's words on handing out names, defaults filled. */
export function namesAutoOf(home: string | undefined, entity: string | null): NamesAuto {
  return namesAutoFor(home, entity, NAME_POOL_DEFAULT);
}

/**
 * Whether a seat goes by no name of its own. A seat is named when the file writes its
 * `nickname:`, or a written label of the form `<Name> · <role>` whose name part is not the seat's
 * own name. A label with no middle dot ("Gemini tester") is a description, not a name. A seat
 * with a name is never renamed. A human seat is a person, whose name is theirs, and a counted
 * entry cannot carry one nickname, so neither is handed one.
 */
export function unnamedSeat(seat: Pick<Seat, 'name' | 'nickname' | 'label' | 'labelWritten' | 'human' | 'count'>): boolean {
  if (seat.human === true || seat.count > 1 || seat.nickname !== undefined) return false;
  if (seat.labelWritten !== true || !seat.label.includes('·')) return true;
  const persona = labelPersona(seat);
  return persona === null || persona === seat.name;
}

/** The label a named seat carries: the nickname, then the written label's part after its middle
 *  dot — or, for a label with no dot, the label whole as a description — or the seat's role when
 *  the label says nothing more than the seat's name. */
function namedLabel(seat: Pick<Seat, 'name' | 'role' | 'label' | 'labelWritten'>, nickname: string): string {
  const written = seat.labelWritten === true ? seat.label.trim() : '';
  const at = written.indexOf('·');
  const rest = at >= 0 ? written.slice(at + 1).trim() : written === seat.name ? '' : written;
  return `${nickname} · ${rest === '' ? seat.role : rest}`;
}

/**
 * The names a team's unnamed seats take, in file order, each the first name of the pool that is
 * free: never a word the team already carries (a seat's name, nickname or label persona), never
 * `lead` or `daemon`, and never one `taken` holds (the names an entity-wide fill handed out
 * earlier in the same run). A name any team in the registry already carries is passed over while
 * the pool has another; past that, the `names.unique` scope is the rule, as for a manual name.
 * `only` limits the plan to those seats. A pool word that names no built-in pool plans nothing
 * and says why; a pool with no name left names the first seat it could not name.
 */
export function autoNamePlan(input: {
  home: string | undefined;
  root: string;
  team: TeamFile;
  only?: readonly string[];
  taken?: ReadonlySet<string>;
}): { assignments: NameAssignment[]; problem: string | null } {
  const { home, team } = input;
  const config = namesAutoOf(home, team.entity);
  // An own key only: a hand-written word like `constructor` names no pool, never an inherited one.
  const pool = config.pool.kind === 'list'
    ? config.pool.names
    : Object.hasOwn(NAME_POOLS, config.pool.name) ? NAME_POOLS[config.pool.name] : undefined;
  if (pool === undefined) {
    const known = Object.keys(NAME_POOLS).join(', ');
    return { assignments: [], problem: `names.pool "${config.pool.kind === 'builtin' ? config.pool.name : ''}" is no built-in pool (${known}) and no list` };
  }
  const own = new Set<string>([LEAD_NAME, DAEMON_NAME, ...(input.taken ?? [])].map((word) => word.toLowerCase()));
  for (const seat of team.seats) {
    own.add(seat.name.toLowerCase());
    if (seat.nickname !== undefined) own.add(seat.nickname.toLowerCase());
    const persona = labelPersona(seat);
    if (persona !== null) own.add(persona.toLowerCase());
  }
  const scope = namesUniqueFor(home, team.entity);
  const teamId = teamIdOf(input.root);
  const holders = home === undefined ? [] : nicknameHolders(home, teamId);
  const project = home === undefined ? { id: null } : projectOf(home, null, team, input.root);
  const ownTeam: NicknameOwner = { teamId, entity: team.entity, projectId: project.id };
  const anywhere = new Set(holders.map((holder) => holder.nickname.toLowerCase()));
  const inScope = new Set(holders.filter((holder) => withinScope(holder, ownTeam, scope)).map((holder) => holder.nickname.toLowerCase()));
  const usable = pool.filter((name) => SEAT_NAME.test(name));
  const assignments: NameAssignment[] = [];
  for (const seat of team.seats) {
    if (!unnamedSeat(seat) || (input.only !== undefined && !input.only.includes(seat.name))) continue;
    const name = usable.find((word) => !own.has(word.toLowerCase()) && !anywhere.has(word.toLowerCase()))
      ?? usable.find((word) => !own.has(word.toLowerCase()) && !inScope.has(word.toLowerCase()));
    if (name === undefined) return { assignments, problem: `the name pool has no free name left for seat "${seat.name}"` };
    own.add(name.toLowerCase());
    assignments.push({ seat: seat.name, nickname: name, label: namedLabel(seat, name) });
  }
  return { assignments, problem: null };
}

/** The record text with each assignment written: the seat's `nickname:` and its `label:`, line
 *  by line as `team config set` writes them, so the record's comments are kept. */
export function withAutoNames(text: string, assignments: readonly NameAssignment[]): string {
  let next = text;
  for (const assignment of assignments) {
    for (const [field, value] of [['nickname', assignment.nickname], ['label', assignment.label]] as const) {
      const path = ['seats', assignment.seat, field];
      const changed = withValue(toValue(parseYaml(next)), path, value);
      if (!changed.ok || !changed.changed) continue;
      next = editedRecordText(next, path, value, changed.root).text;
    }
  }
  return next;
}

/**
 * The launch's naming step, for `team add` and `team up`: while the entity's `names.auto` is on,
 * the record text with every unnamed seat (or only the `only` seats) named, held to the same
 * `names.unique` check a manual name is. The text comes back unchanged when there is nothing to
 * name, auto is off, the text does not validate, or the plan or the check refuses — a launch is
 * never stopped for want of a name; `problem` says why none was handed out.
 */
export function autoNamedText(input: {
  home: string | undefined;
  root: string;
  text: string;
  only?: readonly string[];
}): { text: string; assignments: NameAssignment[]; problem: string | null } {
  const unchanged = (problem: string | null) => ({ text: input.text, assignments: [] as NameAssignment[], problem });
  const before = validateTeamFile(input.text, { ...(input.home !== undefined ? { home: input.home } : {}), root: input.root });
  if (!before.ok) return unchanged(null);
  if (!namesAutoOf(input.home, before.team.entity).auto) return unchanged(null);
  const plan = autoNamePlan({ home: input.home, root: input.root, team: before.team, ...(input.only !== undefined ? { only: input.only } : {}) });
  if (plan.assignments.length === 0) return unchanged(plan.problem);
  const text = withAutoNames(input.text, plan.assignments);
  const after = validateTeamFile(text, { ...(input.home !== undefined ? { home: input.home } : {}), root: input.root });
  if (!after.ok) return unchanged(`the names did not validate: ${after.errors.map((problem) => problem.message).join('; ')}`);
  const gate = nicknameChangeGate({ home: input.home, teamId: teamIdOf(input.root), root: input.root, before: before.team, after: after.team });
  if (!gate.ok) return unchanged(gate.message);
  return { text, assignments: plan.assignments, problem: plan.problem };
}

/** `team doctor`'s note: a seat with no name, while its entity writes `names.auto: off`. Nothing
 *  while the word is on — the seat takes one at its next launch or `team names fill` — and
 *  nothing for a team with no entity, which has no word to read. */
export function unnamedSeatNotes(team: TeamFile, home: string | undefined): string[] {
  if (team.entity === null || home === undefined || namesAutoOf(home, team.entity).auto) return [];
  return team.seats
    .filter((seat) => unnamedSeat(seat))
    .map((seat) => `seat "${seat.name}" has no name, and names.auto is off: team names fill names it, or team config set seats.${seat.name}.nickname <name>`);
}
