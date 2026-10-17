import { watchInForceOf } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { fileOwnerRefusal, isOwner, sessionOwnerRefusal, walkCaller } from '../caller.ts';
import { currentTeam } from '../file/current.ts';
import { isParseError } from '../file/load.ts';
import type { Problem, TeamFile } from '../file/types.ts';
import type { Command, Io } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import {
  contextLine,
  formatRelativeTime,
  hasJsonFlag,
  renderTable,
  ttyStyle,
  writeJson,
  writeJsonError,
  type OutputSchemaTag,
  type TtyStyle,
} from '../output/index.ts';
import { mayReadTeam } from '../read-gate.ts';
import { observedSeatState, sayThreshold, type SeatStateWord, type StateSource } from '../labels/state.ts';
import { readCliHook } from '../launch/cli-hook.ts';
import { supportsCliHook } from '../profiles/profile.ts';
import { newestTraceAt, seatTraces } from '../labels/traces.ts';
import { findAgent } from '../registry/agents.ts';
import { teamIdOf } from '../registry/teams.ts';
import { DEFAULT_STATE_THRESHOLDS } from '../settings/inherit.ts';
import { emptySession, isSeatId, liveHold, readState, type SessionState } from '../state.ts';
import { compare, type Comparison, type Difference, type Live } from '../status/compare.ts';
import { waitOrStop } from '../wait.ts';
import { realSources as realStatusSources, type StatusSources } from './status.ts';

export type SeatsSources = StatusSources & {
  /** Waits between `--watch` passes; false ends the loop. */
  wait?(seconds: number): Promise<boolean>;
};

/** Where a seat's own traces are read from (src/labels/traces.ts): the project's name, its
 *  root, and the home whose store holds the send history. A home of `undefined` is a caller
 *  standing in for no store at all — the message trace is skipped, as status.ts's store-backed
 *  differences are. */
export type SeatTraceSources = {
  project: string;
  root: string;
  home?: string;
  /** The project state folder (the team file's own): where the CLI's hook state files live.
   *  Absent, with `session`, leaves the hook unread — the reading before the launch installed
   *  one. */
  stateDir?: string;
  /** The session the rows are read for: its own folder under the state folder holds the seats'
   *  hook files, so a seat of the same name in another session is never read here. */
  session?: string;
};

export const realSeatsSources: SeatsSources = {
  live: (session, team, state) => realStatusSources.live(session, team, state),
  branch: (path) => realStatusSources.branch(path),
  standing: (root) => realStatusSources.standing(root),
  now: () => realStatusSources.now(),
  // A getter, not a value: `status.ts` and this module import each other, and reading the value
  // while the imports initialize throws when `status.ts` is the entry (its `realSources` is
  // still in its temporal dead zone). A run reads it after both modules have initialized.
  get home() {
    return realStatusSources.home;
  },
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
  /** The seat's own reading (src/labels/state.ts): what it is doing, and from which
   *  source — beside `status`, which is the comparison's phrase about the record. */
  state: SeatStateWord;
  state_source: StateSource;
  blind: boolean;
  /** The seat's registry record carries the dev mark: a registration dev mode admitted wrote it
   *  (`src/registry/agents.ts`), shown beside the id. Absent when the record says nothing. */
  dev_mode?: boolean;
  stored?: string;
  last_active: string | null;
  last_active_display: string;
  pane: string | null;
  launch_line: string | null;
  start_cwd?: string;
};

export interface SeatsJson {
  schema: OutputSchemaTag;
  format: 1;
  project: string;
  session: string;
  notice?: string | null;
  seats: Array<{
    name: string;
    id: string | null;
    role: string;
    cli: string;
    model: string;
    effort: string | null;
    status: string;
    /** The seat's own reading (src/labels/state.ts), the table's STATE and SOURCE columns,
     *  beside `status`, which is the comparison's phrase about the record. */
    state: SeatStateWord;
    state_source: StateSource;
    /** Present, true, only where it applies: `unknown` past the blind threshold, which counts
     *  as not working (the table's `(blind)`). */
    blind?: true;
    last_active: string | null;
    pane: string | null;
    launch_line: string | null;
    /** Present, and true, only for a record a dev-mode registration wrote. */
    dev_mode?: boolean;
    start_cwd?: string;
  }>;
}

export const USAGE = `Usage: team seats [--session <name>] [--file <path>] [--all] [--watch] [--json]

Exits 0 when the seats are shown, 1 when an owner-only flag is refused, 2 when the invocation, team file, or herdr can't be read.
`;

export { formatRelativeTime };

export function seatRegistryRows(
  team: TeamFile,
  state: SessionState,
  live: Live,
  comparison: Comparison,
  now: Date,
  all: boolean,
  held = false,
  /** Where the traces are read from; absent is the old carried-forward `last_active` alone. */
  traceSources?: SeatTraceSources,
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
    // The seat's agent: the one herdr names for it, or — an agent renamed or left unnamed, which
    // the comparison flags on its own — the one standing in the pane the state records for the
    // seat. An agent named as another seat is that seat's, never this one's: a stale pane record
    // must not report this seat's state from another seat's pane. Its screen is the seat's
    // screen either way, and it is not read as blind.
    const recordedPane = recorded?.pane;
    const agent = live.agents.find((candidate) => candidate.name === row.name)
      ?? (recordedPane !== undefined
        ? live.agents.find((candidate) =>
            candidate.pane === recordedPane
            && !team.seats.some((other) => other.name === candidate.name))
        : undefined);
    // A pane `team` did not launch is not this seat's process: the comparison says `restored, not
    // launched by team`, and neither that process's screen nor herdr's word for it is the seat's.
    // Its reading is what TeamCLI's own records say and nothing else — unknown, untrusted. The
    // state hook is left unread with it: its file belongs to the process this seat launched.
    const untrusted = row.state === 'restored, not launched by team';
    const screenText = agent && !untrusted && live.screens[agent.pane] !== undefined ? live.screens[agent.pane] : undefined;
    // The seat's own hook reading, when its CLI is one whose launch this team can give a settings
    // file: the state file the CLI writes at turn start and turn end. Only read from the project
    // state folder — never from any CLI home.
    const hook = !untrusted && traceSources?.stateDir !== undefined && traceSources.session !== undefined
      && supportsCliHook(cli)
      ? readCliHook(traceSources.stateDir, traceSources.session, row.name)
      : null;
    // The seat-state reading: the CLI's own hook when its launch keeps one, the CLI's own
    // screen, then herdr, then the traces (a fresh one even over an idle word) — and the
    // certainties the comparison already judged. The
    // comparison's own 'missing'/'stopped' is such a certainty — it read the pane's processes —
    // and is done, not judged blind. The file's `stopped` and a retained record say the same,
    // but only while herdr names no agent there: a live agent is the observation, and the file's
    // `stopped` beside it is a difference of its own (src/status/compare.ts), never the state.
    // The trace is TeamCLI's own (src/labels/traces.ts) beside the record's carried-forward
    // `last_active`.
    const goneByFile = declared?.stopped === true || retained !== undefined;
    const goneOnPurpose = row.state === 'missing' || row.state === 'stopped'
      || (goneByFile && agent === undefined);
    const trace = traceSources === undefined
      ? recorded?.last_active ?? retained?.last_active ?? null
      : newestTraceAt(
          seatTraces({
            seat: { name: row.name, cli },
            session: state,
            project: traceSources.project,
            root: traceSources.root,
            home: traceSources.home,
            ...(screenText !== undefined ? { screen: screenText } : {}),
          }),
          recorded?.last_active,
          retained?.last_active,
        );
    const reading = observedSeatState({
      cli,
      ...(agent !== undefined && !untrusted ? { agent: { pane: agent.pane, status: agent.status } } : {}),
      ...(screenText !== undefined ? { screenText } : {}),
      hook,
      trace,
      ...(goneOnPurpose ? { stopped: true } : {}),
      ...(held ? { held: true } : {}),
      reachable: live.running,
      now,
    });
    // Working now: the reading says so — the screen, a trace inside its window, herdr or the
    // seat's own hook — or herdr's word and the record say the turn is still on. The seat's
    // `last_active` is this run's instant while it works, whatever carried the word.
    const workingNow = reading.state === 'working'
      || Boolean(agent !== undefined && !untrusted && (agent.status === 'working' || row.state.startsWith('working')));
    const lastActive = workingNow ? now.toISOString() : (recorded?.last_active ?? retained?.last_active ?? null);
    const lastActiveDisplay = workingNow ? 'now' : formatRelativeTime(lastActive, now);
    const pane = row.pane === '-' ? null : row.pane;
    const launchLine = recorded?.launch_line ?? declared?.launch ?? likeSeat?.launch ?? null;
    // The registry record's own provenance, when a home is there to read it: a record a dev-mode
    // registration wrote is marked beside the seat's id. An unreadable registry is no mark, as it
    // is no record for every other reader.
    const record = traceSources?.home === undefined
      ? null
      : findAgent(traceSources.home, { team: teamIdOf(traceSources.root), seat: row.name });
    rows.push({
      name: row.name,
      id,
      role,
      cli,
      model: row.model,
      effort,
      status: row.state,
      state: reading.state,
      state_source: reading.source,
      blind: reading.blind,
      ...(record?.provenance.dev_mode === true ? { dev_mode: true } : {}),
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

/** The must-fix rows `status` and `check` print for blind seats: a reading of unknown
 *  past the blind threshold counts as not working. One row per seat, the same reading the table
 *  above shows. */
export function blindDifferences(
  team: TeamFile,
  state: SessionState,
  live: Live,
  comparison: Comparison,
  now: Date,
  held = false,
  /** Where the traces are read from; absent is the old carried-forward `last_active` alone. */
  traceSources?: SeatTraceSources,
): Difference[] {
  const said = sayThreshold(DEFAULT_STATE_THRESHOLDS.blind_after_seconds);
  return seatRegistryRows(team, state, live, comparison, now, true, held, traceSources)
    .filter((row) => row.blind)
    .map((row): Difference => ({
      what: `${row.name}: unknown for over ${said} — blind, and it counts as not working`,
      repair: 'the owner looks at the pane',
      owner: true,
    }));
}

export function renderSeatsTable(rows: SeatRegistryRow[], indent = '', style: TtyStyle = ttyStyle(false)): string {
  const lines = renderTable({
    headers: ['SEAT', 'ID', 'ROLE', 'CLI', 'MODEL', 'EFFORT', 'STATUS', 'STATE', 'SOURCE', 'LAST ACTIVE', 'PANE'],
    rows: rows.map((row) => [
      row.name,
      // The id cell carries the record's one mark: `(dev)` says a registration dev mode admitted
      // wrote the seat's registry record.
      row.dev_mode === true ? `${row.id ?? '-'} (dev)` : row.id ?? '-',
      row.role,
      row.cli,
      row.model,
      row.effort ?? '-',
      row.status,
      // The seat-state reading: the word, and the flag when it is blind — unknown past the
      // threshold, which counts as not working.
      row.blind ? `${row.state} (blind)` : row.state,
      row.state_source,
      row.last_active_display,
      row.pane ?? '-',
    ]),
    indent,
    style,
    styleCell: (padded, _raw, _r, col, s) => (col === 6 || col === 7 ? s.styleState(padded) : padded),
  });
  return `${lines.join('\n')}\n`;
}

export async function runSeats(argv: string[], io: Io, sources: SeatsSources = realSeatsSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['all', 'watch', 'json']);
  const json = hasJsonFlag(argv);
  const watching = args.flags.has('watch');
  if (args.error || args.rest.length || (watching && json)) {
    const why = args.error
      ?? (args.rest.length ? `unexpected "${args.rest[0]}"` : "--watch and --json can't be used together");
    if (json) {
      writeJsonError(io, 'seats.invocation', why, null);
    } else {
      io.stderr(`team seats: ${why}\n${USAGE}`);
    }
    // exit: seats.invocation
    return 2;
  }
  const walked = walkCaller(io);
  const owner = isOwner(walked);
  if (args.values.file !== undefined) {
    const refusal = fileOwnerRefusal(io, args.values.file);
    if (refusal !== undefined) {
      if (json) {
        writeJsonError(io, 'seats.file-owner', refusal, 'the owner runs `team seats --file <path>` from a terminal outside herdr', 1, 'owner-only');
      } else {
        io.stderr(`team seats: ${refusal}\n`);
      }
      // exit: seats.file-owner
      return 1;
    }
  }
  if (args.values.session !== undefined && !owner) {
    const refusal = sessionOwnerRefusal(walked);
    if (json) {
      writeJsonError(io, 'seats.session-owner', refusal, 'the owner runs `team seats --session <name>` from a terminal outside herdr', 1, 'owner-only');
    } else {
      io.stderr(`team seats: ${refusal}\n`);
    }
    // exit: seats.session-owner
    return 1;
  }

  const current = currentTeam(io.cwd, owner ? args.values.file : undefined, sources.now(), sources.home, owner);
  if (!owner) {
    if (!current.ok || !mayReadTeam(current, io, sources)) {
      if (json) {
        writeJsonError(io, 'seats.not-yours', 'this team is not yours to read', null);
      } else {
        io.stderr('team seats: this team is not yours to read\n');
      }
      // exit: seats.not-yours
      return 2;
    }
  } else if (!current.ok) {
    if (json) {
      const id = current.errors[0]?.message.includes('not inside a git repository')
        ? 'seats.not-a-repo'
        : current.errors.some(isParseError)
          ? 'seats.file-invalid'
          : 'seats.file';
      const msg = current.errors.map((p) => `${p.line ? `team.yaml line ${p.line}: ` : ''}${p.message}`).join('; ');
      writeJsonError(io, id, msg, null);
    } else {
      printProblems(io, current.errors);
    }
    // exit: seats.not-a-repo
    // exit: seats.file
    // exit: seats.file-invalid
    return 2;
  }
  const { team, root, dir } = current;
  const all = args.flags.has('all');
  if (!json && !watching && current.notice) io.stdout(`${current.notice}\n`);

  const session = args.values.session ?? team.session;
  const standing = sources.standing(root);
  const wait = sources.wait ?? waitOrStop;
  const style = ttyStyle(io, { json });

  for (;;) {
    const now = sources.now();
    const whole = readState(dir);
    const state = whole.sessions[session] ?? emptySession();
    const live = sources.live(session, team, state);
    if (!live) {
      if (json) {
        writeJsonError(io, 'seats.herdr', "herdr doesn't answer; is it installed and running?", 'start herdr and run `team seats` again');
      } else {
        io.stderr("team seats: herdr doesn't answer; is it installed and running?\n");
      }
      // exit: seats.herdr
      return 2;
    }
    const comparison = compare(team, session, state, live, now, watchInForceOf(standing, team));
    const rows = seatRegistryRows(team, state, live, comparison, now, all, liveHold(whole, now) !== null, {
      project: team.project,
      root,
      home: sources.home,
      stateDir: dir,
      session,
    });

    if (json) {
      writeJson(io, 'team.seats', {
        format: 1 as const,
        project: team.project,
        session,
        ...(current.notice !== undefined ? { notice: current.notice } : {}),
        seats: rows.map((row) => ({
          name: row.name,
          id: row.id,
          role: row.role,
          cli: row.cli,
          model: row.model,
          effort: row.effort,
          status: row.stored ?? row.status,
          state: row.state,
          state_source: row.state_source,
          ...(row.blind ? { blind: true as const } : {}),
          last_active: row.last_active,
          pane: row.pane,
          launch_line: row.launch_line,
          ...(row.dev_mode === true ? { dev_mode: true } : {}),
          ...(row.start_cwd ? { start_cwd: row.start_cwd } : {}),
        })),
      });
      break;
    }

    const rendered = renderSeatsTable(rows, '', style);
    if (watching && io.stdoutIsTTY) {
      io.stdout(`\x1b[2J\x1b[H`);
      io.stdout(`Every 2s: team seats${all ? ' --all' : ''} (${plainLine(session)})  ${now.toISOString()}\n\n${rendered}`);
    } else {
      io.stdout(`${contextLine(team.project, session)}\n${rendered}${rows.length} seat(s)\n`);
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
