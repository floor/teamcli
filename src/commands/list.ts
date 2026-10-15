import { homedir } from 'node:os';
import { join } from 'node:path';
import { readArgs } from '../args.ts';
import { agentList, sessionList, type HerdrSession } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import { findTeamFile, type FoundTeam } from '../list/find.ts';
import { isSeatId, readState } from '../state.ts';
import { waitOrStop } from '../wait.ts';

export const USAGE = `Usage: team list [--all] [--seats] [--watch] [--json]

Run from any folder. Lists the herdr sessions on this machine, the running ones unless --all is given, and changes nothing.

A duplicate is two listed sessions whose team files resolve to the same directory, the real path of the folder that holds .agents. The same project name in two directories is two teams and is not flagged. Session names that match after lowercasing and removing hyphens, underscores and dots are near-duplicates. A pair the directory rule already names is not named again as near.
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

/** What `list` reads from outside itself, so a test stands in with fixtures and never a socket. */
export type ListSources = {
  /** Null when herdr cannot be asked. */
  sessions(): ListedSession[] | null;
  /** Null when this running session's roster cannot be read. Not called for a stopped session. */
  roster(session: string): RosterSeat[] | null;
  /** Null when no team file names this session. */
  team(session: string): FoundTeam | null;
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

function table(rows: ListRow[]): string {
  const head = ['TEAM', 'PROJECT', 'STATUS', 'SEATS', 'ACTIVITY', 'NOTE'];
  const body = rows.map((row) => [row.team, row.project, row.status, row.seats, row.activity, row.note]);
  const width = head.map((label, index) => Math.max(label.length, ...body.map((cells) => cells[index]?.length ?? 0)));
  const line = (cells: string[]): string => cells
    .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(width[index] ?? 0)))
    .join('  ')
    .trimEnd();
  return `${[line(head), ...body.map(line)].join('\n')}\n`;
}

function tableWithSeats(rows: ListSeatsRow[]): string {
  const head = ['TEAM', 'PROJECT', 'STATUS', 'SEATS', 'ACTIVITY', 'NOTE'];
  const body = rows.map((row) => [row.team, row.project, row.status, row.seats, row.activity, row.note]);
  const width = head.map((label, index) => Math.max(label.length, ...body.map((cells) => cells[index]?.length ?? 0)));
  const line = (cells: string[]): string => cells
    .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(width[index] ?? 0)))
    .join('  ')
    .trimEnd();
  const out: string[] = [line(head)];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    out.push(line(body[index]!));
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
            .map((cell, col) => (col === cells.length - 1 ? cell : cell.padEnd(seatWidths[col] ?? 0)))
            .join('  ')
            .trimEnd()}`,
        );
      }
    }
  }
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
  return `${JSON.stringify(documents, null, 2)}\n`;
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
  return `${JSON.stringify(documents, null, 2)}\n`;
}

export function realListSources(home: string = homedir()): ListSources {
  let cache: HerdrSession[] | null | undefined;
  const listed = (): HerdrSession[] | null => {
    if (cache === undefined) cache = sessionList();
    return cache;
  };
  return {
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
      const matchedPanes = new Set<string>();
      const out: RosterSeat[] = [];
      for (const declared of resolved.team.seats) {
        const recorded = state?.seats[declared.name];
        const retained = state?.retained_seats?.[declared.name];
        const live = agents.find((agent) => agent.name === declared.name)
          ?? (recorded?.pane ? agents.find((agent) => agent.pane === recorded.pane) : undefined);
        if (live) matchedPanes.add(live.pane);
        let status: string | null;
        if (recorded?.waiting) status = 'waiting';
        else if (!live) status = 'stopped';
        else if (live.status === 'blocked') status = 'waiting';
        else if (live.status === 'idle' && recorded?.stage === 'ready') status = 'ready';
        else if (live.status && live.status !== 'unknown') status = live.status;
        else status = null;
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
        let status: string | null;
        if (recorded.waiting) status = 'waiting';
        else if (!live) status = 'stopped';
        else if (live.status === 'blocked') status = 'waiting';
        else if (live.status === 'idle' && recorded.stage === 'ready') status = 'ready';
        else if (live.status && live.status !== 'unknown') status = live.status;
        else status = null;
        const likeSeat = recorded.temporary
          ? resolved.team.seats.find((seat) => seat.name === recorded.temporary?.like)
          : undefined;
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
    wait: waitOrStop,
    now: () => new Date(),
  };
}

export const list: Command = (argv, io) => runList(argv, io);
export default list;

export async function runList(argv: string[], io: Io, sources: ListSources = realListSources()): Promise<number> {
  const args = readArgs(argv, [], ['all', 'seats', 'watch', 'json']);
  if (args.error || args.rest.length || (args.flags.has('watch') && args.flags.has('json'))) {
    const why = args.error
      ?? (args.rest.length ? `unexpected "${args.rest[0]}"` : "--watch and --json can't be used together");
    io.stderr(`team list: ${why}\n${USAGE}`);
    // exit: list.invocation
    return 2;
  }
  const all = args.flags.has('all');
  const showSeats = args.flags.has('seats');
  const json = args.flags.has('json');
  const watching = args.flags.has('watch');
  if (watching) {
    const wait = sources.wait ?? waitOrStop;
    const now = sources.now ?? (() => new Date());
    for (;;) {
      const listed = ask(() => sources.sessions(), null);
      let body: string;
      if (listed === null) {
        body = 'herdr is not running\n';
      } else if (showSeats) {
        const rows = seatRowsOf(listed, sources, all);
        body = rows.length === 0 ? (all ? 'no sessions\n' : 'no running sessions\n') : tableWithSeats(rows);
      } else {
        const rows = rowsOf(listed, sources, all);
        body = rows.length === 0 ? (all ? 'no sessions\n' : 'no running sessions\n') : table(rows);
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
    const listed = ask(() => sources.sessions(), null);
    if (listed === null) {
      io.stdout(json ? '[]\n' : 'herdr is not running\n');
      // exit: list.herdr-down
      return 0;
    }
    const rows = showSeats ? seatRowsOf(listed, sources, all) : rowsOf(listed, sources, all);
    if (rows.length === 0) {
      io.stdout(json ? '[]\n' : all ? 'no sessions\n' : 'no running sessions\n');
      // exit: list.empty
      return 0;
    }
    if (showSeats) {
      io.stdout(json ? jsonWithSeatsOf(rows as ListSeatsRow[]) : tableWithSeats(rows as ListSeatsRow[]));
    } else {
      io.stdout(json ? jsonOf(rows) : table(rows));
    }
  }
  // exit: list.shown
  return 0;
}

