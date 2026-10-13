import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { agentList, sessionList, type HerdrSession } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import { findTeam, type FoundTeam } from '../list/find.ts';

export const USAGE = `Usage: team list [--all] [--json]

Run from any folder. Lists the herdr sessions on this machine, the running ones unless --all is given, and changes nothing.

A duplicate is two listed sessions whose team files resolve to the same directory, the real path of the folder that holds .agents. The same project name in two directories is two teams and is not flagged. Session names that match after lowercasing and removing hyphens, underscores and dots are near-duplicates. A pair the directory rule already names is not named again as near.
`;

/** One herdr session, as the list reads it. */
export type ListedSession = { name: string; running: boolean };

/** One seat on a running session's roster. A null status could not be read. */
export type RosterSeat = { name: string | null; status: string | null };

/** What `list` reads from outside itself, so a test stands in with fixtures and never a socket. */
export type ListSources = {
  /** Null when herdr cannot be asked. */
  sessions(): ListedSession[] | null;
  /** Null when this running session's roster cannot be read. Not called for a stopped session. */
  roster(session: string): RosterSeat[] | null;
  /** Null when no team file names this session. */
  team(session: string): FoundTeam | null;
};

const STATUS_ORDER = ['working', 'blocked', 'idle', 'done'];

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

type Draft = {
  team: string;
  project: string;
  status: 'running' | 'stopped';
  seats: string;
  activity: string;
  root: string | null;
  bits: string[];
};

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

/**
 * One row per listed session. Running sessions only, unless `all`. Stopped sessions are not asked
 * for a roster. A session with no team file is an orphan. Two sessions that share a resolved
 * project directory are duplicates; the same project name in two directories is not. Near-duplicate
 * names compare equal after `nameKey`, except a pair the directory rule already names.
 */
export function rowsOf(sessions: ListedSession[], sources: ListSources, all: boolean): ListRow[] {
  const shown = sessions.filter((session) => all || session.running).sort((a, b) => byName(a.name, b.name));
  const drafts: Draft[] = shown.map((session) => {
    const found = ask(() => sources.team(session.name), { project: null, root: null, seats: null, unreadable: true });
    const running = session.running;
    const roster = running ? ask(() => sources.roster(session.name), null) : null;
    const bits: string[] = [];
    if (!found) bits.push('orphan');
    else if (found.unreadable) bits.push('team file unreadable');
    if (running && roster === null) bits.push('roster unread');
    let seats = '?';
    if (found && !found.unreadable && found.seats !== null) seats = String(found.seats);
    else if (!found && !running) seats = '-';
    else if (!found && roster) seats = String(roster.length);
    const project = !found ? '-' : (found.project ?? '?');
    return {
      team: plainLine(session.name),
      project: plainLine(project),
      status: running ? 'running' : 'stopped',
      seats,
      activity: running && roster === null ? '?' : running && roster ? activityOf(roster) : '-',
      root: found?.root ?? null,
      bits,
    };
  });
  return drafts.map((row) => {
    const mates = drafts.filter((other) => other !== row && other.root !== null && other.root === row.root).map((other) => other.team);
    const workspace = new Set(mates);
    const near = drafts
      .filter((other) => other !== row && !workspace.has(other.team) && nameKey(other.team) === nameKey(row.team))
      .map((other) => other.team);
    const bits = [...row.bits];
    if (mates.length) bits.push(`same workspace as ${[...mates].sort(byName).join(', ')}`);
    if (near.length) bits.push(`near ${[...near].sort(byName).join(', ')}`);
    return {
      team: row.team,
      project: row.project,
      status: row.status,
      seats: row.seats,
      activity: row.activity,
      note: bits.join('; '),
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

export function realListSources(home: string = homedir()): ListSources {
  let cache: HerdrSession[] | null | undefined;
  const listed = (): HerdrSession[] | null => {
    if (cache === undefined) cache = sessionList();
    return cache;
  };
  return {
    sessions() {
      const rows = listed();
      if (rows === null) return null;
      return rows.map((row) => ({ name: row.name, running: row.running }));
    },
    roster(session) {
      const agents = agentList(session);
      if (agents === null) return null;
      return agents.map((agent) => ({
        name: agent.name,
        status: agent.status && agent.status !== 'unknown' ? agent.status : null,
      }));
    },
    team(session) {
      const dir = listed()?.find((row) => row.name === session)?.sessionDir ?? null;
      return findTeam(session, dir, home);
    },
  };
}

export const list: Command = (argv, io) => runList(argv, io);
export default list;

export async function runList(argv: string[], io: Io, sources: ListSources = realListSources()): Promise<number> {
  const args = readArgs(argv, [], ['all', 'json']);
  if (args.error || args.rest.length) {
    io.stderr(`team list: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: list.invocation
    return 2;
  }
  const all = args.flags.has('all');
  const json = args.flags.has('json');
  const listed = ask(() => sources.sessions(), null);
  if (listed === null) {
    io.stdout(json ? '[]\n' : 'herdr is not running\n');
    // exit: list.herdr-down
    return 0;
  }
  const rows = rowsOf(listed, sources, all);
  if (rows.length === 0) {
    io.stdout(json ? '[]\n' : all ? 'no sessions\n' : 'no running sessions\n');
    // exit: list.empty
    return 0;
  }
  io.stdout(json ? jsonOf(rows) : table(rows));
  // exit: list.shown
  return 0;
}
