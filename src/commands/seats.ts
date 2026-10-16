import { watchInForceOf } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { fileOwnerRefusal, isOwner, sessionOwnerRefusal, walkCaller } from '../caller.ts';
import { currentTeam } from '../file/current.ts';
import type { Problem, TeamFile } from '../file/types.ts';
import type { Command, Io } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import { mayReadTeam } from '../read-gate.ts';
import { profileFor } from '../profiles/profile.ts';
import { emptySession, isSeatId, readState, type SessionState } from '../state.ts';
import { compare, type Comparison, type Live } from '../status/compare.ts';
import { waitOrStop } from '../wait.ts';
import { realSources as realStatusSources, type StatusSources } from './status.ts';

export type SeatsSources = StatusSources & {
  /** Waits between `--watch` passes; false ends the loop. */
  wait?(seconds: number): Promise<boolean>;
};

export const realSeatsSources: SeatsSources = {
  live: (session, team, state) => realStatusSources.live(session, team, state),
  branch: (path) => realStatusSources.branch(path),
  standing: (root) => realStatusSources.standing(root),
  now: () => realStatusSources.now(),
  wait: waitOrStop,
};

export const seats: Command = (argv, io) => runSeats(argv, io, realSeatsSources);
export default seats;

export type SeatRegistryRow = {
  name: string;
  id: string | null;
  role: string;
  cli: string;
  model: string;
  effort: string | null;
  status: string;
  stored?: string;
  last_active: string | null;
  last_active_display: string;
  pane: string | null;
  launch_line: string | null;
  start_cwd?: string;
};

export interface SeatsJson {
  format: 1;
  project: string;
  session: string;
  seats: Array<{
    name: string;
    id: string | null;
    role: string;
    cli: string;
    model: string;
    effort: string | null;
    status: string;
    last_active: string | null;
    pane: string | null;
    launch_line: string | null;
    start_cwd?: string;
  }>;
}

export const USAGE = 'Usage: team seats [--session <name>] [--file <path>] [--all] [--watch] [--json]\n';

export function formatRelativeTime(iso: string | null | undefined, now: Date): string {
  if (!iso) return '-';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '-';
  const seconds = Math.max(0, Math.floor((now.getTime() - parsed) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function seatRegistryRows(
  team: TeamFile,
  state: SessionState,
  live: Live,
  comparison: Comparison,
  now: Date,
  all: boolean,
): SeatRegistryRow[] {
  const byName = new Map(team.seats.map((seat) => [seat.name, seat]));
  const seenIds = new Set<string>();
  const rows: SeatRegistryRow[] = [];
  for (const row of comparison.rows) {
    if (!all && row.state === 'stopped') continue;
    const declared = byName.get(row.name);
    const recorded = state.seats[row.name];
    const retained = state.retained_seats?.[row.name];
    const likeSeat = recorded?.temporary ? byName.get(recorded.temporary.like) : undefined;
    const candidateId = row.id ?? recorded?.id ?? retained?.id ?? null;
    const id = candidateId && isSeatId(candidateId) && !seenIds.has(candidateId) ? candidateId : null;
    if (id) seenIds.add(id);
    const role = declared?.role ?? likeSeat?.role ?? 'temporary';
    const cli = recorded?.cli ?? declared?.cli ?? likeSeat?.cli ?? '-';
    const effort = recorded?.effort ?? declared?.effort ?? likeSeat?.effort ?? null;
    const agent = live.agents.find((candidate) => candidate.name === row.name);
    const workingNow = Boolean(agent && (agent.status === 'working' || row.state.startsWith('working')));
    const lastActive = workingNow ? now.toISOString() : (recorded?.last_active ?? retained?.last_active ?? null);
    const lastActiveDisplay = workingNow ? 'now' : formatRelativeTime(lastActive, now);
    const pane = row.pane === '-' ? null : row.pane;
    const launchLine = recorded?.launch_line ?? declared?.launch ?? likeSeat?.launch ?? null;
    let model = row.model;
    if (model.endsWith('(unread)') && launchLine) {
      // The same words `status` prints: the seat's declared display, and only without one the
      // model the launch line names.
      const named = profileFor(cli)?.modelOf(launchLine);
      const display = declared?.display ?? likeSeat?.display;
      if (named) model = `${display ?? `${named.model}${named.version ? ` ${named.version}` : ''}`} (from launch)`;
    }
    rows.push({
      name: row.name,
      id,
      role,
      cli,
      model,
      effort,
      status: row.state,
      ...(row.stored ? { stored: row.stored } : {}),
      last_active: lastActive,
      last_active_display: lastActiveDisplay,
      pane,
      launch_line: launchLine,
      ...(row.start_cwd ? { start_cwd: row.start_cwd } : {}),
    });
  }
  return rows;
}

export function renderSeatsTable(rows: SeatRegistryRow[], indent = ''): string {
  const head = ['SEAT', 'ID', 'ROLE', 'CLI', 'MODEL', 'EFFORT', 'STATUS', 'LAST ACTIVE', 'PANE'];
  const body = rows.map((row) => [
    plainLine(row.name),
    plainLine(row.id ?? '-'),
    plainLine(row.role),
    plainLine(row.cli),
    plainLine(row.model),
    plainLine(row.effort ?? '-'),
    plainLine(row.status),
    plainLine(row.last_active_display),
    plainLine(row.pane ?? '-'),
  ]);
  const width = head.map((label, index) =>
    Math.max(label.length, ...body.map((cells) => cells[index]?.length ?? 0)),
  );
  const line = (cells: string[]): string =>
    `${indent}${cells
      .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(width[index] ?? 0)))
      .join('  ')
      .trimEnd()}`;
  return `${[line(head), ...body.map(line)].join('\n')}\n`;
}

export async function runSeats(argv: string[], io: Io, sources: SeatsSources = realSeatsSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['all', 'watch', 'json']);
  if (args.error || args.rest.length || (args.flags.has('watch') && args.flags.has('json'))) {
    const why = args.error
      ?? (args.rest.length ? `unexpected "${args.rest[0]}"` : "--watch and --json can't be used together");
    io.stderr(`team seats: ${why}\n${USAGE}`);
    // exit: seats.invocation
    return 2;
  }
  const walked = walkCaller(io);
  const owner = isOwner(walked);
  if (args.values.file !== undefined) {
    const refusal = fileOwnerRefusal(io, args.values.file);
    if (refusal !== undefined) {
      io.stderr(`team seats: ${refusal}\n`);
      // exit: seats.file-owner
      return 1;
    }
  }
  if (args.values.session !== undefined && !owner) {
    io.stderr(`team seats: ${sessionOwnerRefusal(walked)}\n`);
    // exit: seats.session-owner
    return 1;
  }

  const current = currentTeam(io.cwd, owner ? args.values.file : undefined, sources.now(), sources.home, owner);
  if (!owner) {
    if (!current.ok || !mayReadTeam(current, io, sources)) {
      io.stderr('team seats: this team is not yours to read\n');
      // exit: seats.not-yours
      return 2;
    }
  } else if (!current.ok) {
    printProblems(io, current.errors);
    // exit: seats.not-a-repo
    // exit: seats.file
    // exit: seats.file-invalid
    return 2;
  }
  const { team, root, dir } = current;
  const all = args.flags.has('all');
  const json = args.flags.has('json');
  const watching = args.flags.has('watch');
  if (!json && !watching && current.notice) io.stdout(`${current.notice}\n`);
  for (const warning of current.warnings) io.stderr(`team seats: warning, line ${warning.line}: ${warning.message}\n`);

  const session = args.values.session ?? team.session;
  const standing = sources.standing(root);
  const wait = sources.wait ?? waitOrStop;

  for (;;) {
    const now = sources.now();
    const whole = readState(dir);
    const state = whole.sessions[session] ?? emptySession();
    const live = sources.live(session, team, state);
    if (!live) {
      io.stderr("team seats: herdr doesn't answer; is it installed and running?\n");
      // exit: seats.herdr
      return 2;
    }
    const comparison = compare(team, session, state, live, now, watchInForceOf(standing, team));
    const rows = seatRegistryRows(team, state, live, comparison, now, all);

    if (json) {
      const doc: SeatsJson = {
        format: 1,
        project: team.project,
        session,
        seats: rows.map((row) => ({
          name: row.name,
          id: row.id,
          role: row.role,
          cli: row.cli,
          model: row.model,
          effort: row.effort,
          status: row.stored ?? row.status,
          last_active: row.last_active,
          pane: row.pane,
          launch_line: row.launch_line,
          ...(row.start_cwd ? { start_cwd: row.start_cwd } : {}),
        })),
      };
      io.stdout(`${JSON.stringify(doc, null, 2)}\n`);
      break;
    }

    const rendered = renderSeatsTable(rows);
    if (watching && io.stdoutIsTTY) {
      io.stdout(`\x1b[2J\x1b[H`);
      io.stdout(`Every 2s: team seats${all ? ' --all' : ''} (${plainLine(session)})  ${now.toISOString()}\n\n${rendered}`);
    } else {
      io.stdout(rendered);
    }
    if (!watching) break;
    if (!(await wait(2))) break;
  }

  // exit: seats.shown
  return 0;
}

function printProblems(io: Io, problems: Problem[]): void {
  for (const problem of problems) {
    io.stderr(`team seats: ${problem.line ? `team.yaml line ${problem.line}: ` : ''}${problem.message}\n`);
  }
}
