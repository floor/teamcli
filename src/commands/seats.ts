import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { watchInForceOf } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { fileOwnerRefusal, isOwner, sessionOwnerRefusal, walkCaller } from '../caller.ts';
import { auditClientRefusal, authorizeClientRun, clientFormProblem, verifyClientForm } from '../client/client-form.ts';
import { KEY_ISOLATION_LINE } from '../client/records.ts';
import { currentTeam } from '../file/current.ts';
import { isParseError } from '../file/load.ts';
import type { Problem, TeamFile } from '../file/types.ts';
import type { Command, Io } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import {
  contextLine,
  hasJsonFlag,
  pluralCount,
  renderTable,
  ttyStyle,
  writeJson,
  writeJsonError,
  type OutputSchemaTag,
  type TtyStyle,
} from '../output/index.ts';
import { mayReadTeam } from '../read-gate.ts';
import { observedSeatState, sayThreshold, type PresenceObservation, type SeatStateWord, type StateSource } from '../labels/state.ts';
import { presenceChannelHealthy, presenceSeatsOf, readPresenceForSeat, seatPresenceProof, type PresenceProjectionRead, type PresenceSeatsRead } from '../labels/presence.ts';
import { readCliHook } from '../launch/cli-hook.ts';
import { supportsCliHook } from '../profiles/profile.ts';
import { newestTraceAt, seatTraces } from '../labels/traces.ts';
import { findAgent } from '../registry/agents.ts';
import { continuityIdsOf } from '../registry/resume.ts';
import { ofTeam } from '../registry/projects.ts';
import { teamIdOf } from '../registry/teams.ts';
import { DEFAULT_STATE_THRESHOLDS, type StateThresholds } from '../settings/inherit.ts';
import { stateThresholds } from '../settings/resolve.ts';
import { machineLiveness, watchWords } from '../settings/declared.ts';
import { entityLiveness } from '../entities.ts';
import { emptySession, isSeatId, liveHold, pauseText, readState, type PauseRecord, type SessionState } from '../state.ts';
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
  /**
   * Whether this session's presence route is healthy, from a *fresh* daemon health answer for
   * the route (the display command's one probe). Absent or false makes every projection last
   * known — still shown, just not live. Never from the persisted `status.json` word: a status
   * record can outlive the channel it describes.
   */
  presenceChannelHealthy?: boolean;
  /**
   * The same fresh answer's complete per-seat verdicts. Every declared seat is classified: a
   * seat is qualified only by its own serving entry whose sampled binding equals the binding
   * the seat state records; route health alone is not enough, and a missing list or entry is an
   * incomplete answer, never a hook-only route.
   */
  presenceSeats?: PresenceSeatsRead;
};

/**
 * The state thresholds a seat's chain puts in force: the machine's settings file, the entity's
 * `liveness:` map, the project record's word, the team's own `watch.blind_after` and — when a
 * seat is named — that seat's own word. Every value resolves in the one `stateThresholds` call
 * the reading makes. A file that cannot be read declares no word here (the registry's own errors
 * are `team check`'s to refuse), and a word that would loosen a threshold its level may not
 * loosen is set aside by the resolver, the value in force standing.
 */
export function stateLimitsOf(team: TeamFile, home: string | undefined, teamId: string, seat?: string): StateThresholds {
  let project: Partial<StateThresholds> | undefined;
  try {
    project = home === undefined ? undefined : ofTeam(home, teamId)?.liveness;
  } catch {
    project = undefined;
  }
  const word = seat === undefined ? undefined : team.seats.find((one) => one.name === seat)?.liveness;
  return stateThresholds({
    machine: machineLiveness(home),
    entity: entityLiveness(home, team.entity),
    ...(project !== undefined ? { project } : {}),
    team: watchWords(team.watch),
    ...(word !== undefined ? { seat: word } : {}),
  });
}

export const realSeatsSources: SeatsSources = {
  live: (session, team, state) => realStatusSources.live(session, team, state),
  branch: (path) => realStatusSources.branch(path),
  standing: (root) => realStatusSources.standing(root),
  now: () => realStatusSources.now(),
  get home() {
    return realStatusSources.home;
  },
  daemonHealth: async (home) => {
    const probe = realStatusSources.daemonHealth;
    if (probe === undefined) throw new Error('the standing sources carry no daemon health probe');
    return probe(home);
  },
  wait: waitOrStop,
};

export const seats: Command = (argv, io) => runSeats(argv, io, realSeatsSources);
export default seats;

export type SeatRegistryRow = {
  name: string;
  /** The seat's human name from the file, or null when it writes none. Shown beside the seat,
   *  never used to identify a row: the name is the identity. */
  nickname?: string | null;
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
  /** The native projection behind the reading, canonical word and provenance kept beside the
   *  legacy word; `live` false is last known, shown as itself. */
  presence?: PresenceObservation;
  /** The projection exists but this build cannot read it: unknown, from presence. */
  presence_unreadable?: true;
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
  /** Present while the team is paused (`team pause`), with its stop points. */
  pause?: PauseRecord;
  seats: Array<{
    name: string;
    /** The seat's human name from the file, or null when it writes none. */
    nickname: string | null;
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
    /** The native projection the reading came from: canonical four-state word, the runtime
     *  source that wrote it, the contract event and its instant, and whether it is live. False
     *  is last known; the legacy `state` still maps `waiting-for-a-person` to `blocked` and
     *  `gone` to `done`. */
    presence?: PresenceObservation;
    /** Present, true, only when the projection exists but this build cannot read it. */
    presence_unreadable?: true;
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
       team seats --client <grant-file> --key <client-key> [--team <team>] [--all] [--json]

The --client form is for a client with no terminal that the owner signed a manager bundle grant carrying seats for (team grant --client <id> --entity <entity> --public-key <file> --team <team> --bundle manager --request): it reads that one team, as signed, and nothing else. It changes nothing and never prompts; --file, --session and --watch are the owner's and take no --client.

Exits 0 when the seats are shown, 1 when an owner-only flag or a client grant is refused, 2 when the invocation, team file, or herdr can't be read.
`;

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
  held = false,
  /** Where the traces are read from; absent is the old carried-forward `last_active` alone. */
  traceSources?: SeatTraceSources,
): SeatRegistryRow[] {
  const byName = new Map(team.seats.map((seat) => [seat.name, seat]));
  const seenIds = new Set<string>();
  const rows: SeatRegistryRow[] = [];
  // The registry read once for the whole table: each row resolves its own chain over it.
  const home = traceSources?.home;
  const teamId = traceSources === undefined ? undefined : teamIdOf(traceSources.root);
  // The route's freshness is the session's, not a seat's; when the fresh answer carries a seat
  // list, each row's own serving entry and sampled binding decide whether its projection is
  // live. Everything else is last known, never removed.
  const presenceQualified = traceSources?.presenceChannelHealthy === true;
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
    const nickname = declared?.nickname ?? likeSeat?.nickname ?? null;
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
    // The daemon's presence projection. It answers whenever the file exists — live with this
    // incarnation's binding on a qualified channel and under the applied transition the fresh
    // answer vouches for, last known otherwise — and only a genuine absence leaves the screen
    // to answer: an existing projection the seat's binding does not fence is unknown from
    // presence, never a screen's reading. Never read for a pane TeamCLI did not launch.
    let presenceRead: PresenceProjectionRead | null = null;
    if (!untrusted && traceSources?.stateDir !== undefined && traceSources.session !== undefined) {
      const proof = seatPresenceProof(
        traceSources.presenceSeats, row.name, recorded?.presence_binding,
      );
      presenceRead = readPresenceForSeat(
        traceSources.stateDir, traceSources.session, row.name, recorded?.presence_binding,
        presenceQualified && proof.qualified, proof.appliedEventId,
      );
    }
    // The seat-state reading: the daemon's presence projection for this launch, the CLI's own
    // hook when its launch keeps one, the CLI's own
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
      ...(presenceRead?.kind === 'ok' ? { presence: presenceRead.observation } : {}),
      ...(presenceRead?.kind === 'bad' || presenceRead?.kind === 'invalid'
        ? { presenceUnreadable: true }
        : {}),
      trace,
      ...(goneOnPurpose ? { stopped: true } : {}),
      ...(held ? { held: true } : {}),
      reachable: live.running,
      now,
      limits: teamId === undefined ? DEFAULT_STATE_THRESHOLDS : stateLimitsOf(team, home, teamId, row.name),
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
      nickname,
      id,
      role,
      cli,
      model: row.model,
      effort,
      status: row.state,
      state: reading.state,
      state_source: reading.source,
      ...(reading.presence !== undefined ? { presence: reading.presence } : {}),
      ...(reading.presenceUnreadable === true ? { presence_unreadable: true as const } : {}),
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
  const teamId = traceSources === undefined ? undefined : teamIdOf(traceSources.root);
  return seatRegistryRows(team, state, live, comparison, now, true, held, traceSources)
    .filter((row) => row.blind)
    .map((row): Difference => {
      const limits = traceSources === undefined || teamId === undefined
        ? DEFAULT_STATE_THRESHOLDS
        : stateLimitsOf(team, traceSources.home, teamId, row.name);
      return {
        what: `${row.name}: unknown for over ${sayThreshold(limits.blind_after_seconds)} — blind, and it counts as not working`,
        repair: 'the owner looks at the pane',
        owner: true,
      };
    });
}

export function renderSeatsTable(rows: SeatRegistryRow[], indent = '', style: TtyStyle = ttyStyle(false)): string {
  const lines = renderTable({
    headers: ['SEAT', 'NICKNAME', 'ID', 'ROLE', 'CLI', 'MODEL', 'EFFORT', 'STATUS', 'STATE', 'SOURCE', 'LAST ACTIVE', 'PANE'],
    rows: rows.map((row) => [
      row.name,
      row.nickname ?? '-',
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
    styleCell: (padded, _raw, _r, col, s) => (col === 7 || col === 8 ? s.styleState(padded) : padded),
  });
  return `${lines.join('\n')}\n`;
}

export async function runSeats(argv: string[], io: Io, sources: SeatsSources = realSeatsSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file', 'client', 'key', 'team'], ['all', 'watch', 'json']);
  const json = hasJsonFlag(argv);
  const watching = args.flags.has('watch');
  const clientProblem = args.error === undefined && args.rest.length === 0
    ? clientFormProblem(args.values, 'team seats --client <grant-file> --key <client-key-file>')
      ?? (args.values.client !== undefined && (args.values.file !== undefined || args.values.session !== undefined || watching)
        ? "--client reads the one team its grant names, once: --file, --session and --watch are the owner's and take no --client"
        : null)
    : null;
  if (args.error || args.rest.length || (watching && json) || clientProblem !== null) {
    const why = args.error
      ?? (args.rest.length ? `unexpected "${args.rest[0]}"` : clientProblem ?? "--watch and --json can't be used together");
    if (json) {
      writeJsonError(io, 'seats.invocation', why, null);
    } else {
      io.stderr(`team seats: ${why}\n${USAGE}`);
    }
    // exit: seats.invocation
    return 2;
  }
  // The client form: a manager grant the owner signed for ONE team at ONE folder, proven by the client's
  // own key and verified whole before any file is read. It is the read gate's second door, never a
  // second gate: every other caller goes through the gates below, unchanged. It writes only its audit line.
  let clientRead = false;
  if (args.values.client !== undefined) {
    if (!json) io.stderr(`${KEY_ISOLATION_LINE}\n`);
    const at = sources.now();
    const home = sources.home ?? homedir();
    const verified = verifyClientForm({ home, now: at, io }, { op: 'seats', values: args.values, cwd: io.cwd });
    const stood = verified.ok ? authorizeClientRun(home, verified.run, 'seats', at) : null;
    if (!verified.ok || stood !== null) {
      const why = verified.ok ? stood! : verified.why;
      auditClientRefusal('seats', verified.ok ? verified.run.grant : verified.named, why, at);
      if (json) writeJsonError(io, 'seats.client-refused', why, null);
      else io.stderr(`team seats: ${why}\n`);
      // exit: seats.client-refused
      return 1;
    }
    clientRead = true;
    // The folder is the grant's, whatever the caller's: from here every read is of that team.
    io = { ...io, cwd: verified.run.root };
    if (!json) io.stderr(`client grant ${verified.run.grant.grantId}: ${verified.run.grant.clientId} for team ${verified.run.grant.up.project} at ${verified.run.root}, until ${verified.run.grant.expires}\n`);
  }
  const walked = walkCaller(io);
  // A client run is never the owner's, whatever terminal it stands in.
  const owner = !clientRead && isOwner(walked);
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
    if (!current.ok || !(clientRead || mayReadTeam(current, io, sources))) {
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
        writeJsonError(
          io,
          'seats.herdr',
          "herdr doesn't answer; is it installed and running?",
          'start herdr and run `team seats` again',
          1,
          undefined,
          current.notice,
        );
      } else {
        io.stderr("team seats: herdr doesn't answer; is it installed and running?\n");
      }
      // exit: seats.herdr
      return 2;
    }
    const continuityIds = sources.home === undefined ? undefined : continuityIdsOf({
      home: sources.home,
      root,
      herdrSession: session,
      seats: team.seats,
      states: state.seats,
    });
    const comparison = compare(team, session, state, live, now, watchInForceOf(standing, team), undefined, false, undefined, continuityIds);
    // One fresh daemon health probe per pass: the same answer decides whether this session's
    // presence projections are live. No persisted status word is consulted — an absent
    // verdict leaves every projection last known, never dropped.
    const health = sources.daemonHealth === undefined || sources.home === undefined
      ? null
      : await sources.daemonHealth(sources.home);
    const presenceHealthy = health !== null && presenceChannelHealthy(health, root, session, now);
    const presenceSeats = health === null ? undefined : presenceSeatsOf(health, root, session, now);
    const rows = seatRegistryRows(team, state, live, comparison, now, all, liveHold(whole, now) !== null, {
      project: team.project,
      root,
      home: sources.home,
      stateDir: dir,
      session,
      presenceChannelHealthy: presenceHealthy,
      ...(presenceSeats === undefined ? {} : { presenceSeats }),
    });

    if (json) {
      writeJson(io, 'team.seats', {
        format: 1 as const,
        project: team.project,
        session,
        ...(current.notice !== undefined ? { notice: current.notice } : {}),
        seats: rows.map((row) => ({
          name: row.name,
          nickname: row.nickname ?? null,
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
          ...(row.presence !== undefined ? { presence: row.presence } : {}),
          ...(row.presence_unreadable === true ? { presence_unreadable: true as const } : {}),
        })),
        ...(whole.pause !== undefined ? { pause: whole.pause } : {}),
      });
      break;
    }

    const rendered = renderSeatsTable(rows, '', style);
    // The team's pause reads above the table, one line in the shape `status` prints it: a reader
    // seeing every seat idle is told why none of them is taking work.
    const pauseLine = whole.pause !== undefined ? `${pauseText(whole.pause)}\n` : '';
    if (watching && io.stdoutIsTTY) {
      io.stdout(`\x1b[2J\x1b[H`);
      io.stdout(`Every 2s: team seats${all ? ' --all' : ''} (${plainLine(session)})  ${now.toISOString()}\n\n${pauseLine}${rendered}`);
    } else {
      io.stdout(`${contextLine(team.project, session)}\n${pauseLine}${rendered}${pluralCount(rows.length, 'seat')}\n`);
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
