import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readArgs } from '../args.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { agentList, paneRead, sessionList, type HerdrSession } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import { findTeamFile, type FoundTeam } from '../list/find.ts';
import { displayPath, hasJsonFlag, jsonEnvelope, pluralCount, ttyStyle, writeJsonError, type TtyStyle } from '../output/index.ts';
import { herdrUnreliable } from '../profiles/index.ts';
import { readTeams, teamsFile } from '../registry/teams.ts';
import { isSeatId, readState } from '../state.ts';
import { readScreen, screenWord } from '../watch/screen.ts';
import { waitOrStop } from '../wait.ts';

const PLAIN_STYLE = ttyStyle();

export const USAGE = `Usage: team list [--all] [--seats] [--watch] [--json]

Run from any folder. Lists the herdr sessions on this machine, the running ones unless --all is given, and changes nothing.

A duplicate is two listed sessions whose team files resolve to the same directory, the real path of the folder that holds .agents. The same project name in two directories is two teams and is not flagged. Session names that match after lowercasing and removing hyphens, underscores and dots are near-duplicates. A pair the directory rule already names is not named again as near.

Exits 0 when the sessions are listed (including when none are running or herdr is down), 2 when the invocation can't be read.
`;

/** One herdr session, as the list reads it. */
export type ListedSession = { name: string; running: boolean };

/** One seat on a running session's roster. A null status could not be read. */
export type RosterSeat = {
  name: string | null;
  status: string | null;
  id?: string | null;
  role?: string | null;
  cli?: string | null;
  model?: string | null;
  effort?: string | null;
  pane?: string | null;
  last_active?: string | null;
};

export type ActiveSeatsSummary = {
  ready: number;
  working: number;
  waiting: number;
  stopped: number;
};

/** One seat a registry record lists: the seat name in its team file, and what the record adds. */
export type RegistryRosterSeat = {
  seat: string;
  role?: string | null;
  agent?: string | null;
};

/** One team as the team registry holds it (`~/.config/team/teams.yaml`). `list` reads only what it
 *  shows; a record from the registry module carries these fields and more. */
export type RegistryTeam = {
  /** The record's key: sha256 of the root's real path, first 12 hex. */
  id: string;
  entity: string | null;
  project: string | null;
  session: string | null;
  root: string | null;
  lobby: string | null;
  roster: RegistryRosterSeat[];
};

/** What a registry record's root holds: the team file, and whether it loads and validates. */
export type RegistryFile = { valid: boolean; seats: number | null };

/** What `list` reads from outside itself, so a test stands in with fixtures and never a socket. */
export type ListSources = {
  /** Home directory for ~ shortening in human tables; defaults to homedir(). */
  home?: string;
  /** Null when herdr cannot be asked. */
  sessions(): ListedSession[] | null;
  /** Null when this running session's roster cannot be read. Not called for a stopped session. */
  roster(session: string): RosterSeat[] | null;
  /** Null when no team file names this session. */
  team(session: string): FoundTeam | null;
  /** Every team in the registry. Null when there is no registry to read — no file, or one that
   *  cannot be read — which is also the signal that this machine lists discovery alone. Absent
   *  counts as null, so a caller that never reads it is never asked for one. */
  registry?(): RegistryTeam[] | null;
  /** The team file at a registry record's root. Null when the root is null or holds no file. */
  file?(root: string): RegistryFile | null;
  /** Waits between `--watch` passes; false ends the loop. */
  wait?(seconds: number): Promise<boolean>;
  /** Clock for `--watch` headers. */
  now?(): Date;
};

export const STATUS_ORDER = ['working', 'ready', 'waiting', 'blocked', 'idle', 'done', 'stopped'];

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The near-duplicate key: lower case, with `-`, `_` and `.` removed. */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/[-_.]/g, '');
}

export type ListRow = {
  team: string;
  project: string;
  status: 'running' | 'stopped';
  seats: string;
  activity: string;
  note: string;
};

export type ListSeatsRow = ListRow & {
  active: ActiveSeatsSummary | null;
  roster: RosterSeat[];
};

/** One row of the registry view (spec section 5): a registered team, or a session the registry
 *  does not name. `defined` is whether the registry holds the record; `approved` is whether the
 *  team file at its root loads and validates; `running` is whether herdr lists its session now,
 *  null when herdr cannot be asked. `roster` is the record's seats, shown by `--seats`. */
export type RegistryRow = {
  entity: string | null;
  team: string;
  project: string | null;
  lobby: string | null;
  seats: number | null;
  defined: boolean;
  approved: boolean;
  running: boolean | null;
  source: 'registry' | 'discovered';
  roster: RegistryRosterSeat[];
};

type Draft = {
  team: string;
  project: string;
  status: 'running' | 'stopped';
  seats: string;
  declaredSeats: number | null;
  activity: string;
  roster: RosterSeat[] | null;
  root: string | null;
  bits: string[];
};

/** What a seat's row says it is doing. Herdr's word, with two changes — a blocked seat is
 *  `waiting`, and herdr's `unknown` (or no word) is unread. For a profile herdr cannot report
 *  (`herdr_status: unreliable`) the seat's own screen is the word, as it is in status, check and
 *  the watch: idle or ready, working, every screen the profile reads but a running turn
 *  `waiting`, and herdr's word only when the screen cannot be read either. */
export function rosterStatus(
  live: { status: string } | undefined,
  cli: string | undefined,
  stage: string | undefined,
  screenText: string | null | undefined,
): string | null {
  if (!live) return 'stopped';
  if (herdrUnreliable(cli)) {
    const word = screenWord(readScreen(cli ?? '', screenText ?? ''));
    if (word === 'working') return 'working';
    if (word === 'idle') return stage === 'ready' ? 'ready' : 'idle';
    if (word === 'blocked') return 'waiting';
  }
  if (live.status === 'blocked') return 'waiting';
  if (live.status === 'idle' && stage === 'ready') return 'ready';
  if (live.status && live.status !== 'unknown') return live.status;
  return null;
}

export function activeSeatsOf(
  roster: RosterSeat[] | null,
  declaredSeats: number | null = null,
  running = true,
): ActiveSeatsSummary | null {
  if (!running) {
    if (declaredSeats === null) return { ready: 0, working: 0, waiting: 0, stopped: 0 };
    return { ready: 0, working: 0, waiting: 0, stopped: Math.max(0, declaredSeats) };
  }
  if (roster === null) return null;
  let ready = 0;
  let working = 0;
  let waiting = 0;
  let stopped = 0;
  for (const seat of roster) {
    const status = seat.status;
    if (!status) continue;
    if (status === 'working' || status.startsWith('working')) working += 1;
    else if (status === 'ready' || status === 'idle' || status === 'done') ready += 1;
    else if (status === 'waiting' || status === 'blocked' || status.startsWith('waiting')) waiting += 1;
    else if (status === 'stopped') stopped += 1;
  }
  if (typeof declaredSeats === 'number' && declaredSeats > 0) {
    const accounted = ready + working + waiting + stopped;
    if (declaredSeats > accounted) stopped += declaredSeats - accounted;
  }
  return { ready, working, waiting, stopped };
}

export function formatActiveSeats(summary: ActiveSeatsSummary | null): string {
  if (summary === null) return '?';
  if (summary.ready === 0 && summary.working === 0 && summary.waiting === 0 && summary.stopped === 0) return '-';
  return `${summary.ready} ready / ${summary.working} working / ${summary.waiting} waiting / ${summary.stopped} stopped`;
}

function activityOf(roster: RosterSeat[]): string {
  if (roster.length === 0) return '-';
  const counts = new Map<string, number>();
  let unread = 0;
  for (const seat of roster) {
    if (!seat.status) unread += 1;
    else counts.set(seat.status, (counts.get(seat.status) ?? 0) + 1);
  }
  const parts: string[] = [];
  const used = new Set<string>();
  for (const status of STATUS_ORDER) {
    const count = counts.get(status);
    if (!count) continue;
    parts.push(`${count} ${status}`);
    used.add(status);
  }
  for (const status of [...counts.keys()].filter((key) => !used.has(key)).sort(byName)) {
    parts.push(`${counts.get(status)} ${status}`);
  }
  if (unread) parts.push(`${unread} ?`);
  return parts.join(', ');
}

function ask<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function buildDrafts(sessions: ListedSession[], sources: ListSources, all: boolean): Draft[] {
  const shown = sessions.filter((session) => all || session.running).sort((a, b) => byName(a.name, b.name));
  return shown.map((session) => {
    const found = ask(() => sources.team(session.name), { project: null, root: null, seats: null, unreadable: true });
    const running = session.running;
    const roster = running ? ask(() => sources.roster(session.name), null) : null;
    const bits: string[] = [];
    if (!found) bits.push('orphan');
    else if (found.unreadable) bits.push('team file unreadable');
    if (running && roster === null) bits.push('roster unread');
    let seats = '?';
    let declaredSeats: number | null = null;
    if (found && !found.unreadable && found.seats !== null) {
      seats = String(found.seats);
      declaredSeats = found.seats;
    } else if (!found && !running) {
      seats = '-';
    } else if (!found && roster) {
      seats = String(roster.length);
    }
    const project = !found ? '-' : (found.project ?? '?');
    return {
      team: plainLine(session.name),
      project: plainLine(project),
      status: running ? 'running' : 'stopped',
      seats,
      declaredSeats,
      activity: running && roster === null ? '?' : running && roster ? activityOf(roster) : '-',
      roster,
      root: found?.root ?? null,
      bits,
    };
  });
}

function noteOf(row: Draft, drafts: Draft[]): string {
  const mates = drafts.filter((other) => other !== row && other.root !== null && other.root === row.root).map((other) => other.team);
  const workspace = new Set(mates);
  const near = drafts
    .filter((other) => other !== row && !workspace.has(other.team) && nameKey(other.team) === nameKey(row.team))
    .map((other) => other.team);
  const bits = [...row.bits];
  if (mates.length) bits.push(`same workspace as ${[...mates].sort(byName).join(', ')}`);
  if (near.length) bits.push(`near ${[...near].sort(byName).join(', ')}`);
  return bits.join('; ');
}

/**
 * One row per listed session. Running sessions only, unless `all`. Stopped sessions are not asked
 * for a roster. A session with no team file is an orphan. Two sessions that share a resolved
 * project directory are duplicates; the same project name in two directories is not. Near-duplicate
 * names compare equal after `nameKey`, except a pair the directory rule already names.
 */
export function rowsOf(sessions: ListedSession[], sources: ListSources, all: boolean): ListRow[] {
  const drafts = buildDrafts(sessions, sources, all);
  return drafts.map((row) => ({
    team: row.team,
    project: row.project,
    status: row.status,
    seats: row.seats,
    activity: row.activity,
    note: noteOf(row, drafts),
  }));
}

export function seatRowsOf(sessions: ListedSession[], sources: ListSources, all: boolean): ListSeatsRow[] {
  const drafts = buildDrafts(sessions, sources, all);
  return drafts.map((row) => {
    const active = activeSeatsOf(row.roster, row.declaredSeats, row.status === 'running');
    return {
      team: row.team,
      project: row.project,
      status: row.status,
      seats: row.seats,
      activity: formatActiveSeats(active),
      active,
      roster: (row.roster ?? []).map((seat) => ({
        name: seat.name ? plainLine(seat.name) : null,
        status: seat.status ? plainLine(seat.status) : null,
        ...(seat.id !== undefined ? { id: seat.id && isSeatId(seat.id) ? seat.id : null } : {}),
        ...(seat.role !== undefined ? { role: seat.role ? plainLine(seat.role) : null } : {}),
        ...(seat.cli !== undefined ? { cli: seat.cli ? plainLine(seat.cli) : null } : {}),
        ...(seat.model !== undefined ? { model: seat.model ? plainLine(seat.model) : null } : {}),
        ...(seat.effort !== undefined ? { effort: seat.effort ? plainLine(seat.effort) : null } : {}),
        ...(seat.pane !== undefined ? { pane: seat.pane ? plainLine(seat.pane) : null } : {}),
        ...(seat.last_active !== undefined ? { last_active: seat.last_active } : {}),
      })),
      note: noteOf(row, drafts),
    };
  });
}

/** The session name a record is listed under: its session, its project, or the record's key. */
function recordName(record: RegistryTeam): string {
  return record.session ?? record.project ?? record.id;
}

/** The team file at a record's root. The registry read is the only source that knows a root
 *  without a live session, so the file is asked for by that root. */
function fileAt(sources: ListSources, root: string | null): RegistryFile | null {
  if (root === null) return null;
  return ask(() => sources.file?.(root) ?? null, null);
}

/**
 * The registry view (spec section 5): one row per registered team, plus one per herdr session the
 * registry does not name. A registered team's session is matched by its session name, and by the
 * root its team file resolves to when the name does not match. Rows carry where they come from:
 * `registry` is authoritative, `discovered` is a session nothing registered. `entity` filters
 * rows; rows are grouped by entity, then by team. `all` keeps stopped discovered sessions.
 */
export function registryRowsOf(
  registry: RegistryTeam[],
  sessions: ListedSession[] | null,
  sources: ListSources,
  all: boolean,
  entity: string | null = null,
): RegistryRow[] {
  const live = sessions ?? [];
  const liveByName = new Map(live.map((session) => [session.name, session]));
  const found = new Map<string, FoundTeam | null>();
  for (const session of live) found.set(session.name, ask(() => sources.team(session.name), null));
  const taken = new Set<string>();
  const rows: RegistryRow[] = [];
  for (const record of [...registry].sort((a, b) => byName(recordName(a), recordName(b)))) {
    const name = recordName(record);
    const session = liveByName.get(name)
      ?? live.find((other) => !taken.has(other.name) && record.root !== null && found.get(other.name)?.root === record.root)
      ?? null;
    if (session) taken.add(session.name);
    const file = fileAt(sources, record.root);
    const roster = record.roster.map((seat) => ({
      seat: plainLine(seat.seat),
      ...(seat.agent !== undefined ? { agent: seat.agent ? plainLine(seat.agent) : null } : {}),
      ...(seat.role !== undefined ? { role: seat.role ? plainLine(seat.role) : null } : {}),
    }));
    rows.push({
      entity: record.entity ? plainLine(record.entity) : null,
      team: plainLine(name),
      project: record.project ? plainLine(record.project) : null,
      lobby: record.lobby ? plainLine(record.lobby) : null,
      // SEATS is the count the contract defines: what the team file validates. The registry's
      // roster is what has launched, so it is the count only when the file cannot be read.
      seats: file?.seats ?? (roster.length > 0 ? roster.length : null),
      defined: true,
      approved: file?.valid ?? false,
      running: sessions === null ? null : (session?.running ?? false),
      source: 'registry',
      roster,
    });
  }
  for (const session of live) {
    if (taken.has(session.name)) continue;
    if (!all && !session.running) continue;
    const team = found.get(session.name) ?? null;
    const project = team?.project ? plainLine(team.project) : null;
    rows.push({
      entity: project,
      team: plainLine(session.name),
      project,
      lobby: null,
      seats: team && !team.unreadable ? team.seats : null,
      defined: false,
      approved: team !== undefined && team !== null && !team.unreadable && team.seats !== null,
      running: session.running,
      source: 'discovered',
      roster: [],
    });
  }
  const shown = entity === null ? rows : rows.filter((row) => row.entity === entity);
  return shown.sort((a, b) => byName(a.entity ?? '', b.entity ?? '') || byName(a.team, b.team));
}

const REGISTRY_HEAD = ['ENTITY', 'TEAM/SESSION', 'PROJECT', 'LOBBY', 'SEATS', 'DEFINED', 'APPROVED', 'RUNNING', 'SOURCE'];

/** `yes` / `no`, and `?` for a state that cannot be read. */
function yesNo(value: boolean | null): string {
  return value === null ? '?' : value ? 'yes' : 'no';
}

function registryCells(row: RegistryRow, home?: string): string[] {
  return [
    row.entity ?? '-',
    row.team,
    row.project ?? '-',
    row.lobby ? displayPath(row.lobby, home) : '-',
    row.seats === null ? '?' : String(row.seats),
    yesNo(row.defined),
    yesNo(row.approved),
    yesNo(row.running),
    row.source,
  ];
}

function padStyled(cell: string, width: number, styled: string): string {
  const pad = Math.max(0, width - cell.length);
  return `${styled}${' '.repeat(pad)}`;
}

/** The registry view's table. `--seats` prints each registered team's roster under its row,
 *  indented two spaces: seat, agent, role. A discovered row has no roster to print. */
export function registryTable(rows: RegistryRow[], showSeats = false, style: TtyStyle = PLAIN_STYLE, home?: string): string {
  const head = REGISTRY_HEAD;
  const body = rows.map((row) => registryCells(row, home));
  const width = head.map((label, index) => Math.max(label.length, ...body.map((cells) => cells[index]?.length ?? 0)));
  const line = (cells: string[], isHeader = false): string => {
    const rendered = cells
      .map((cell, index) => {
        const isLast = index === cells.length - 1;
        if (isHeader) return isLast ? cell : cell.padEnd(width[index] ?? 0);
        const styled = cell === '-' ? style.dim(cell) : cell;
        return isLast ? styled : padStyled(cell, width[index] ?? 0, styled);
      })
      .join('  ')
      .trimEnd();
    return isHeader ? style.bold(rendered) : rendered;
  };
  const out: string[] = [line(head, true)];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    out.push(line(body[index]!));
    if (!showSeats || row.roster.length === 0) continue;
    const seatCells = row.roster.map((seat) => [seat.seat, seat.agent ?? '-', seat.role ?? '-']);
    const seatWidths = [0, 1, 2].map((col) => Math.max(1, ...seatCells.map((cells) => cells[col]?.length ?? 0)));
    for (const cells of seatCells) {
      out.push(`  ${cells.map((cell, col) => {
        const styled = cell === '-' ? style.dim(cell) : cell;
        return col === cells.length - 1 ? styled : padStyled(cell, seatWidths[col] ?? 0, styled);
      }).join('  ').trimEnd()}`);
    }
  }
  out.push(pluralCount(rows.length, 'session'));
  return `${out.join('\n')}\n`;
}

/** The registry rows as JSON: the same fields as the table, plus `roster` with `--seats`. */
export function registryJsonOf(rows: RegistryRow[], showSeats = false): string {
  const documents = rows.map((row) => ({
    entity: row.entity,
    team: row.team,
    project: row.project,
    lobby: row.lobby,
    seats: row.seats,
    defined: row.defined,
    approved: row.approved,
    running: row.running,
    source: row.source,
    ...(showSeats ? { roster: row.roster } : {}),
  }));
  return `${JSON.stringify(jsonEnvelope('team.list', { format: 1, rows: documents }), null, 2)}\n`;
}

function table(rows: ListRow[], style: TtyStyle = PLAIN_STYLE): string {
  const head = ['TEAM', 'PROJECT', 'STATUS', 'SEATS', 'ACTIVITY', 'NOTE'];
  const body = rows.map((row) => [row.team, row.project, row.status, row.seats, row.activity, row.note]);
  const width = head.map((label, index) => Math.max(label.length, ...body.map((cells) => cells[index]?.length ?? 0)));
  const headerLine = style.bold(
    head
      .map((cell, index) => (index === head.length - 1 ? cell : cell.padEnd(width[index] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
  const rowLine = (cells: string[]): string => {
    const lastNonEmpty = cells[cells.length - 1] === '' ? cells.length - 2 : cells.length - 1;
    return cells
      .slice(0, lastNonEmpty + 1)
      .map((cell, index) => {
        const styled = index === 2 || cell === '-' ? style.styleState(cell) : cell;
        return index === lastNonEmpty ? styled : padStyled(cell, width[index] ?? 0, styled);
      })
      .join('  ')
      .trimEnd();
  };
  return `${[headerLine, ...body.map(rowLine), pluralCount(rows.length, 'session')].join('\n')}\n`;
}

function tableWithSeats(rows: ListSeatsRow[], style: TtyStyle = PLAIN_STYLE): string {
  const head = ['TEAM', 'PROJECT', 'STATUS', 'SEATS', 'ACTIVITY', 'NOTE'];
  const body = rows.map((row) => [row.team, row.project, row.status, row.seats, row.activity, row.note]);
  const width = head.map((label, index) => Math.max(label.length, ...body.map((cells) => cells[index]?.length ?? 0)));
  const headerLine = style.bold(
    head
      .map((cell, index) => (index === head.length - 1 ? cell : cell.padEnd(width[index] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
  const rowLine = (cells: string[]): string => {
    const lastNonEmpty = cells[cells.length - 1] === '' ? cells.length - 2 : cells.length - 1;
    return cells
      .slice(0, lastNonEmpty + 1)
      .map((cell, index) => {
        const styled = index === 2 || cell === '-' ? style.styleState(cell) : cell;
        return index === lastNonEmpty ? styled : padStyled(cell, width[index] ?? 0, styled);
      })
      .join('  ')
      .trimEnd();
  };
  const out: string[] = [headerLine];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    out.push(rowLine(body[index]!));
    if (row.roster.length > 0) {
      const seatCells = row.roster.map((seat) => [
        seat.name ?? '-',
        seat.id ?? '-',
        seat.status ?? '?',
        seat.cli ?? '-',
        seat.model ?? '-',
        seat.pane ?? '-',
      ]);
      const seatWidths = [0, 1, 2, 3, 4, 5].map((col) =>
        Math.max(1, ...seatCells.map((cells) => cells[col]?.length ?? 0)),
      );
      for (const cells of seatCells) {
        out.push(
          `  ${cells
            .map((cell, col) => {
              const styled = col === 2 || cell === '-' ? style.styleState(cell) : cell;
              return col === cells.length - 1 ? styled : padStyled(cell, seatWidths[col] ?? 0, styled);
            })
            .join('  ')
            .trimEnd()}`,
        );
      }
    }
  }
  out.push(pluralCount(rows.length, 'session'));
  return `${out.join('\n')}\n`;
}

function jsonOf(rows: ListRow[]): string {
  const documents = rows.map((row) => ({
    team: row.team,
    project: row.project,
    status: row.status,
    seats: row.seats,
    activity: row.activity,
    note: row.note,
  }));
  return `${JSON.stringify(jsonEnvelope('team.list', { format: 1, rows: documents }), null, 2)}\n`;
}

function jsonWithSeatsOf(rows: ListSeatsRow[]): string {
  const documents = rows.map((row) => ({
    team: row.team,
    project: row.project,
    status: row.status,
    seats: row.seats,
    activity: row.activity,
    active: row.active,
    roster: row.roster,
    note: row.note,
  }));
  return `${JSON.stringify(jsonEnvelope('team.list', { format: 1, rows: documents }), null, 2)}\n`;
}

export function realListSources(home: string = homedir()): ListSources {
  let cache: HerdrSession[] | null | undefined;
  const listed = (): HerdrSession[] | null => {
    if (cache === undefined) cache = sessionList();
    return cache;
  };
  return {
    home,
    sessions() {
      cache = sessionList();
      if (cache === null) return null;
      return cache.map((row) => ({ name: row.name, running: row.running }));
    },
    roster(session) {
      const agents = agentList(session);
      if (agents === null) return null;
      const dir = listed()?.find((row) => row.name === session)?.sessionDir ?? null;
      const resolved = ask(() => findTeamFile(session, dir, home), null);
      if (!resolved?.team || !resolved.found.root) {
        return agents.map((agent) => ({
          name: agent.name,
          status: agent.status && agent.status !== 'unknown' ? agent.status : null,
          pane: agent.pane,
        }));
      }
      const state = ask(() => readState(join(resolved.found.root!, '.agents')).sessions[session], undefined);
      // Only a seat whose profile herdr cannot report is read from its pane: every other row is
      // the agent list's word alone, as it has always been.
      const screenOf = (live: { pane: string } | undefined, cli: string | undefined): string | null =>
        live !== undefined && herdrUnreliable(cli) ? ask(() => paneRead(live.pane, 200, session), null) ?? null : null;
      const matchedPanes = new Set<string>();
      const out: RosterSeat[] = [];
      for (const declared of resolved.team.seats) {
        const recorded = state?.seats[declared.name];
        const retained = state?.retained_seats?.[declared.name];
        const live = agents.find((agent) => agent.name === declared.name)
          ?? (recorded?.pane ? agents.find((agent) => agent.pane === recorded.pane) : undefined);
        if (live) matchedPanes.add(live.pane);
        const cli = recorded?.cli ?? declared.cli;
        const status: string | null = recorded?.waiting
          ? 'waiting'
          : rosterStatus(live, cli, recorded?.stage, screenOf(live, cli));
        const modelName = recorded?.model ?? declared.model;
        const modelVersion = recorded?.version ?? declared.version;
        const model = modelVersion ? `${modelName} ${modelVersion}` : modelName;
        out.push({
          name: declared.name,
          status,
          id: recorded?.id ?? retained?.id ?? null,
          role: declared.role,
          cli: recorded?.cli ?? declared.cli,
          model,
          effort: recorded?.effort ?? declared.effort ?? null,
          pane: live?.pane ?? recorded?.pane ?? null,
          last_active: status === 'working' ? new Date().toISOString() : (recorded?.last_active ?? retained?.last_active ?? null),
        });
      }
      const declaredNames = new Set(resolved.team.seats.map((seat) => seat.name));
      for (const [name, recorded] of Object.entries(state?.seats ?? {})) {
        if (declaredNames.has(name)) continue;
        const live = agents.find((agent) => agent.name === name)
          ?? (recorded.pane ? agents.find((agent) => agent.pane === recorded.pane) : undefined);
        if (live) matchedPanes.add(live.pane);
        const likeSeat = recorded.temporary
          ? resolved.team.seats.find((seat) => seat.name === recorded.temporary?.like)
          : undefined;
        const cli = recorded.cli ?? likeSeat?.cli;
        const status: string | null = recorded.waiting
          ? 'waiting'
          : rosterStatus(live, cli, recorded.stage, screenOf(live, cli));
        const modelName = recorded.model ?? likeSeat?.model ?? '-';
        const modelVersion = recorded.version ?? likeSeat?.version;
        const model = modelVersion ? `${modelName} ${modelVersion}` : modelName;
        out.push({
          name,
          status,
          id: recorded.id ?? null,
          role: likeSeat?.role ?? 'temporary',
          cli: recorded.cli ?? likeSeat?.cli ?? '-',
          model,
          effort: recorded.effort ?? likeSeat?.effort ?? null,
          pane: live?.pane ?? recorded.pane ?? null,
          last_active: status === 'working' ? new Date().toISOString() : (recorded.last_active ?? null),
        });
      }
      for (const agent of agents) {
        if (matchedPanes.has(agent.pane)) continue;
        out.push({
          name: agent.name,
          status: agent.status && agent.status !== 'unknown' ? agent.status : null,
          pane: agent.pane,
        });
      }
      return out;
    },
    team(session) {
      const dir = listed()?.find((row) => row.name === session)?.sessionDir ?? null;
      return findTeamFile(session, dir, home)?.found ?? null;
    },
    registry() {
      // No registry file is no registry: this machine lists discovery alone, as it did before
      // the registry existed. A file that cannot be read as one is not fatal to a read-only
      // list, so it too is no registry rather than an error.
      const path = teamsFile(home);
      try {
        if (!existsSync(path)) return null;
        return Object.entries(readTeams(home)).map(([id, record]) => ({ ...record, id }));
      } catch {
        return null;
      }
    },
    file(root) {
      try {
        const checked = readTeamConfig(root, { home, checkOnly: true });
        return checked.ok ? { valid: true, seats: checked.team.seats.length } : { valid: false, seats: null };
      } catch {
        return null;
      }
    },
    wait: waitOrStop,
    now: () => new Date(),
  };
}

export const list: Command = (argv, io) => runList(argv, io);
export default list;

export async function runList(argv: string[], io: Io, sources: ListSources = realListSources()): Promise<number> {
  const args = readArgs(argv, [], ['all', 'seats', 'watch', 'json']);
  const json = hasJsonFlag(argv);
  const contradictory = args.flags.has('watch') && args.flags.has('json');
  // An argument this command cannot use stops it before anything outside it is read.
  const early = args.error !== undefined || contradictory;
  const readRegistry = (): RegistryTeam[] | null =>
    (early || sources.registry === undefined ? null : ask(() => sources.registry!(), null));
  // The opening read settles the argument rule; every watch pass reads the registry again, so a
  // team added, renamed or ended between redraws is drawn as it is at that redraw.
  const registry = readRegistry();
  // The one word a registry lists is the entity to filter rows by. With no registry to read, this
  // command has no word, and a word is not its own.
  const words = registry === null ? 0 : 1;
  const why = args.error
    ?? (args.rest.length > words
      ? `unexpected "${args.rest[words]}"`
      : contradictory ? "--watch and --json can't be used together" : null);
  if (why !== null) {
    if (json) {
      writeJsonError(io, 'list.invocation', why, null);
    } else {
      io.stderr(`team list: ${why}\n${USAGE}`);
    }
    // exit: list.invocation
    return 2;
  }
  const all = args.flags.has('all');
  const showSeats = args.flags.has('seats');
  const watching = args.flags.has('watch');
  const style = ttyStyle(io, { json });
  const entity = registry === null ? null : (args.rest[0] ?? null);
  const registryText = (teams: RegistryTeam[]): { text: string; empty: boolean } => {
    const rows = registryRowsOf(teams, ask(() => sources.sessions(), null), sources, all, entity);
    if (rows.length === 0) return { text: json ? jsonOf([]) : `no teams\n${pluralCount(0, 'team')}\n`, empty: true };
    return { text: json ? registryJsonOf(rows, showSeats) : registryTable(rows, showSeats, style, sources.home), empty: false };
  };
  if (watching) {
    const wait = sources.wait ?? waitOrStop;
    const now = sources.now ?? (() => new Date());
    for (;;) {
      const current = readRegistry();
      let body: string;
      if (current !== null) {
        body = registryText(current).text;
      } else {
        const listed = ask(() => sources.sessions(), null);
        if (listed === null) {
          body = 'herdr is not running\n';
        } else if (showSeats) {
          const rows = seatRowsOf(listed, sources, all);
          body = rows.length === 0 ? (all ? `no sessions\n${pluralCount(0, 'session')}\n` : `no running sessions\n${pluralCount(0, 'session')}\n`) : tableWithSeats(rows, style);
        } else {
          const rows = rowsOf(listed, sources, all);
          body = rows.length === 0 ? (all ? `no sessions\n${pluralCount(0, 'session')}\n` : `no running sessions\n${pluralCount(0, 'session')}\n`) : table(rows, style);
        }
      }
      if (io.stdoutIsTTY) {
        io.stdout(`\x1b[2J\x1b[H`);
        io.stdout(`Every 2s: team list${all ? ' --all' : ''}${showSeats ? ' --seats' : ''}  ${now().toISOString()}\n\n${body}`);
      } else {
        io.stdout(body);
      }
      if (!(await wait(2))) break;
    }
  } else {
    let text: string;
    let empty = false;
    if (registry !== null) {
      const view = registryText(registry);
      text = view.text;
      empty = view.empty;
    } else {
      const listed = ask(() => sources.sessions(), null);
      if (listed === null) {
        io.stdout(json ? jsonOf([]) : 'herdr is not running\n');
        // exit: list.herdr-down
        return 0;
      }
      const rows = showSeats ? seatRowsOf(listed, sources, all) : rowsOf(listed, sources, all);
      empty = rows.length === 0;
      if (empty) text = json ? jsonOf([]) : all ? `no sessions\n${pluralCount(0, 'session')}\n` : `no running sessions\n${pluralCount(0, 'session')}\n`;
      else if (showSeats) text = json ? jsonWithSeatsOf(rows as ListSeatsRow[]) : tableWithSeats(rows as ListSeatsRow[], style);
      else text = json ? jsonOf(rows) : table(rows, style);
    }
    io.stdout(text);
    if (empty) {
      // exit: list.empty
      return 0;
    }
  }
  // exit: list.shown
  return 0;
}


