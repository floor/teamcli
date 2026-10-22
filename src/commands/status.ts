import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import { auditClientOp } from '../client/bundles.ts';
import { KEY_ISOLATION_LINE } from '../client/records.ts';
import { verifyClientUp } from '../client/up-grant.ts';
import { budgetsInForceOf, notInForce, watchInForceOf } from '../approve/approval.ts';
import { dialogsTrustInForce } from '../permissions/dialogs-trust.ts';
import { overridesInForceOf, type OverrideForce } from '../profiles/overrides.ts';
import { readArgs } from '../args.ts';
import { budgetLine, budgetTable, type BudgetRow } from '../budgets/table.ts';
import { recall } from '../budgets/readings.ts';
import { fileOwnerRefusal, isOwner, sessionOwnerRefusal, walkCaller } from '../caller.ts';
import type { DelegateSources } from '../delegate.ts';
import { devModeActive } from '../dev_mode.ts';
import { existsSync } from 'node:fs';
import { ownerSeatHelperPath, systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { readSecurityProfile, securityProfileLine, securityProfilePath } from '../security/profile.ts';
import { developmentModeNote, readDevelopmentMode } from '../development_mode.ts';
import { greenNotes, idleWorkNotes, readPendingGreen } from '../idle_work.ts';
import type { IdleWorkInput, IdleWorkReport, PendingGreenSlice } from '../idle_work.ts';
import { daemonHealth } from '../daemon/health.ts';
import type { DaemonHealth } from '../daemon/health.ts';
import { daemonNotes, daemonReading } from '../daemon/health_display.ts';
import { hostedWatchNotes } from '../daemon/watch_display.ts';
import { pendingGreenSlices } from '../tasks/green-slices.ts';
import { idleWorkReport } from '../watch/idle-work.ts';
import { currentTeam } from '../file/current.ts';
import { isParseError } from '../file/load.ts';
import type { Problem, Seat, TeamFile } from '../file/types.ts';
import { entityGrantAdmits, readEntityCreateGrants } from '../grant.ts';
import { agentList, PANE_WINDOW, paneProcesses, paneRead, sessionRunning, workspaceList, type PaneProcesses } from '../herdr.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { emptySession, holdText, liveHold, liveProcs, pauseText, pidAlive, readState, type HoldRecord, type PauseRecord, type QueuedSwap, type SessionState } from '../state.ts';
import { keyFingerprint, keyState } from '../store/keys.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import type { PresenceObservation, SeatStateWord, StateSource } from '../labels/state.ts';
import { presenceChannelHealthy, presenceSeatsOf } from '../labels/presence.ts';
import { checkRulesFile, rulesFilePath } from '../launch/rules-file.ts';
import { rulesOf } from '../launch/rules.ts';
import {
  contextLine,
  hasJsonFlag,
  pluralCount,
  projectContextLine,
  renderDifferences,
  renderNotes,
  renderSummary,
  renderTable,
  summaryCounts,
  toJsonDifference,
  ttyStyle,
  writeJson,
  writeJsonError,
  type DifferenceSummaryCounts,
  type DifferenceWho,
  type OutputSchemaTag,
  type TtyStyle,
} from '../output/index.ts';
import { profileFor } from '../profiles/index.ts';
import { mayReadTeam } from '../read-gate.ts';
import { readTeams, teamIdOf } from '../registry/teams.ts';
import { findAgent } from '../registry/agents.ts';
import { continuityIdsOf } from '../registry/resume.ts';
import { realSources as realProjectSources, type ProjectSources } from './projects.ts';
import * as projectRegistry from '../registry/projects.ts';
import { APPROVAL_REPAIR, compare, orderAndAnnotateDifferences } from '../status/compare.ts';
import type { Comparison, Difference, Live } from '../status/compare.ts';
import { queuedSwaps, swapLine } from '../swap/queue.ts';
import { readMachine, swapTotalProblem, type Machine } from '../watch/machine.ts';
import { blindDifferences, renderSeatsTable, seatRegistryRows, type SeatRegistryRow } from './seats.ts';
import { expiryPhrase } from '../client/duration-policy.ts';

// What `status` reads from outside the file and the state, so tests can stand in for it.
export type StatusSources = {
  live(session: string, team: TeamFile, state: SessionState): Live | null;
  branch(path: string): string | null;
  // The approval store's one snapshot, read once for the whole report: the
  // file's case, the watch and budget values in force, and the overrides all
  // derive from it, so no later read can disagree with the first.
  standing(root: string): Standing;
  now(): Date;
  /** The home whose store holds the override file and the key. Absent in a test that does not set one. */
  home?: string;
  /** The project registry, for `--project`. The real one when absent; a test stands in for it. */
  projects?: ProjectSources;
  /** This machine's own figures, read for the one check no machine can ever meet. Absent in a test
   *  that does not read them; absent is not "fine", it is nothing said. */
  machine?(root: string): Machine;
  /** Whether a recorded process id names something still running, for the `team proc` note.
   *  The real reading when absent; a test stands in for it so no fixture depends on a pid. */
  alive?(pid: number): boolean;
  /** The approved pane's read gate's own reads; the real ones when absent. */
  gate?: DelegateSources;
  /** The idle-with-work snapshot, from the watch. Read-only; absent when no producer is wired, and
   *  a test stands in for it. */
  idleWork?(input: IdleWorkInput): IdleWorkReport;
  /** Ready-but-not-installed slices, from the green journal. Read-only; a test stands in for it. */
  pendingGreen?(dir: string): PendingGreenSlice[];
  /** The machine daemon's one health reading, probed once per run at this boundary. Absent in a
   *  test that does not stand one in, so its scenes read no socket. */
  daemonHealth?(home: string): Promise<DaemonHealth>;
  /** The owner-seat credential store that confirms the security profile's signer; the system helper by default. */
  ownerSeatStore?: OwnerSeatKeyStore;
};

/**
 * The standing source against a home that is not the owner's real one — the
 * shipped command's own, and what a test or a scratch home stands in for.
 */
export function standingSource(home: string): StatusSources['standing'] {
  return (root) => approvalStanding(root, home);
}

export const realSources: StatusSources = {
  // The watch's own read-only snapshot, the same function its dispatcher uses, so who is idle and
  // what is takeable cannot differ between the two readers.
  idleWork: idleWorkReport,
  // The green journal's own pending reader, the same function the watch uses: a corrupt journal
  // throws, and the presentation names that read as refused rather than as no ready slice.
  pendingGreen: pendingGreenSlices,
  // The daemon's own health probe: it reads the state record and asks the socket once. It never
  // throws and never waits past its timeout, so an unreadable machine is a reading, not a crash.
  daemonHealth,
  live(session, team, state) {
    const running = sessionRunning(session);
    if (running === null) return null;
    if (!running) return { running: false, agents: [], workspaces: [], screens: {} };
    const agents = agentList(session);
    const workspaces = workspaceList(session);
    if (!agents || !workspaces) return null;
    const screens: Record<string, string> = {};
    const processes: Record<string, PaneProcesses | null> = {};
    // Every agent's pane, not only one whose name is a seat: a stray in a seat's workspace has a
    // screen too. A null screen is left out, and that pane is then unread.
    for (const agent of agents) {
      const declared = team.seats.find((s) => s.name === agent.name);
      if (declared?.human !== true) {
        const screen = paneRead(agent.pane, PANE_WINDOW, session);
        if (screen !== null) screens[agent.pane] = screen;
      }
      // The pane's process identity, for the comparison with the one the state recorded: a pane
      // that no longer holds what team launched is not the seat. Null when herdr can't tell.
      processes[agent.pane] = paneProcesses(agent.pane, session);
    }
    // A recorded seat herdr no longer lists an agent for still has its pane standing where it was
    // launched: that pane is read too, so one left holding its shell is told apart from one that is
    // gone. Only a seat with a recorded process is read — one with no record is never compared.
    // The screen is the same read: a pane with no agent still has visible text, and a null leaves
    // the restored row with no note.
    for (const seat of team.seats) {
      if (seat.human === true) continue;
      const held = state.seats[seat.name];
      if (!held?.launched || !held.pane || held.pane in processes) continue;
      processes[held.pane] = paneProcesses(held.pane, session);
      const screen = paneRead(held.pane, PANE_WINDOW, session);
      if (screen !== null) screens[held.pane] = screen;
    }
    return { running: true, agents, workspaces, screens, processes };
  },
  branch(path) {
    try {
      return execFileSync('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  },
  standing: standingSource(homedir()),
  now: () => new Date(),
  home: homedir(),
  projects: realProjectSources,
  machine: readMachine,
};

export const status: Command = (argv, io) => runStatus(argv, io, realSources);
export default status;

/**
 * The JSON shape printed by `team status --json`.
 * Format 1.
 */
export interface StatusJson {
  schema: OutputSchemaTag;
  format: 1;
  project: string;
  session: string;
  rows: Array<{
    name: string;
    id?: string | null;
    role?: string;
    /** `--all` only, like the registry's other fields: the seat's human name from the file, or
     *  null when it writes none. */
    nickname?: string | null;
    cli?: string;
    state: string;
    model: string;
    effort?: string | null;
    last_active?: string | null;
    pane: string;
    launch_line?: string | null;
    /** The seat's own reading (src/labels/state.ts), the table's STATE and SOURCE columns.
     *  `state` above keeps its published meaning — the comparison's phrase about the record. */
    seat_state?: SeatStateWord;
    seat_state_source?: StateSource;
    /** The native projection behind the reading, canonical word and provenance kept beside the
     *  legacy words; `live` false is last known, shown as itself. */
    seat_presence?: PresenceObservation;
    /** The projection exists but this build cannot read it: unknown, from presence. */
    seat_presence_unreadable?: true;
    /** Present, true, only where it applies: `unknown` past the blind threshold, which counts
     *  as not working (the table's `(blind)`). */
    blind?: true;
    /** `--all` only, like the registry's other fields: present when the seat's registry record
     *  carries the dev mark — a registration dev mode admitted wrote it. */
    dev_mode?: boolean;
    start_cwd?: string;
  }>;
  notes: string[];
  /** The idle-with-work snapshot, when the watch provides one. */
  idle_work?: IdleWorkReport;
  /** Ready-but-not-installed slices, when the green journal was read. */
  green_slices?: PendingGreenSlice[];
  /** Why the green journal could not be read; never rendered as an empty list. */
  green_notice?: string;
  differences: Array<{
    what: string;
    repair: string;
    who: DifferenceWho;
  }>;
  summary: DifferenceSummaryCounts;
  notice: string | null;
  /** Present when the file names an account, or a reading is stored. */
  budgets?: BudgetRow[];
  /** Present while a hold stands and has not lapsed (`team hold`). */
  hold?: HoldRecord;
  /** Present while the team is paused (`team pause`), with its stop points. */
  pause?: PauseRecord;
  /** The live records of `team proc`, present only when the session's seats hold some. */
  procs?: Array<{
    name: string;
    by: string;
    at: string;
    pid?: number;
    note?: string;
  }>;
  /** The swaps the project waits on (`team swap`), one entry per seat, in seat order. */
  swaps?: Array<{
    seat: string;
    swap: QueuedSwap;
  }>;
}

export const USAGE = `Usage: team status [--session <name>] [--file <path>] [--project <name>] [--all] [--json]
       team status --client <grant-file> --key <client-key> [--team <team>] [--json]

The --client form is for a client with no terminal that the owner signed a bundle grant carrying status for (team grant --client <id> --entity <entity> --public-key <file> --team <team> --bundle observer --request): it reads that one team, as signed, and nothing else. It changes nothing and never prompts.

Exits 0 when the session agrees with the file (or the project is listed), 1 when it differs or is refused, 2 when the invocation, team file, or herdr can't be read.
`;

/** The invocation problems the client form owns, or null: its grant and its key come together, and
 *  it reads the one team its grant names, so nothing that aims elsewhere rides with it. */
function clientInvocationProblem(args: ReturnType<typeof readArgs>): string | null {
  const client = args.values.client !== undefined;
  if (client && args.values.key === undefined) return '--client needs --key <client-key-file>';
  if (!client && args.values.key !== undefined) return '--key belongs to the --client form: team status --client <grant-file> --key <client-key-file>';
  if (!client && args.values.team !== undefined) return '--team belongs to the --client form: team status --client <grant-file> --key <client-key-file> --team <team>';
  if (client && (args.values.file !== undefined || args.values.session !== undefined || args.values.project !== undefined || args.flags.has('all'))) {
    return '--client reads the one team its grant names: --file, --session, --project and --all are the owner\'s and take no --client';
  }
  return null;
}

export async function runStatus(argv: string[], io: Io, sources: StatusSources): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, ['session', 'file', 'project', 'client', 'key', 'team'], ['all', 'json']);
  const json = hasJsonFlag(argv);
  // `--project` reads the project level instead of one team: the project's teams, from the
  // registry, wherever the run stands — no team file and no caller gate, the way `team projects`
  // reads. `--session` and `--file` name one team's readings and do not apply beside it.
  const beside = args.values.project !== undefined && (args.values.session !== undefined || args.values.file !== undefined);
  const clientProblem = args.error === undefined && args.rest.length === 0 ? clientInvocationProblem(args) : null;
  if (args.error || args.rest.length || beside || clientProblem !== null) {
    const why = args.error ?? (args.rest.length
      ? `unexpected "${args.rest[0]}"`
      : clientProblem ?? '--project reads the project; --session and --file name one team');
    if (json) {
      writeJsonError(io, 'status.invocation', plainText(why), null);
    } else {
      out.stderr(`team status: ${plainText(why)}\n${USAGE}`);
    }
    // exit: status.invocation
    return 2;
  }
  // The client form: a bundle grant the owner signed for ONE team at ONE folder, proven by the
  // client's own key. It is verified whole, before any file is read, and then the run reads that
  // folder alone and writes nothing but its audit line. It is the read gate's second door, never a
  // second gate: every other caller goes through the gates below, unchanged.
  let clientRead = false;
  if (args.values.client !== undefined) {
    if (!json) out.stderr(`${KEY_ISOLATION_LINE}\n`);
    const at = sources.now();
    const verified = verifyClientUp({
      home: sources.home ?? homedir(),
      grantFile: resolve(io.cwd, args.values.client),
      keyFile: resolve(io.cwd, args.values.key!),
      cwd: io.cwd,
      ...(args.values.team !== undefined ? { team: args.values.team } : {}),
      now: at,
      op: 'status',

      io,    });
    if (!verified.ok) {
      const named = verified.identified;
      if (named !== null) auditClientOp(named.up.root, 'status', named.clientId, 'refused', `grant ${named.grantId}: ${verified.why}`, at);
      if (json) writeJsonError(io, 'status.client-refused', plainText(verified.why), null);
      else out.stderr(`team status: ${plainText(verified.why)}\n`);
      // exit: status.client-refused
      return 1;
    }
    auditClientOp(verified.root, 'status', verified.grant.clientId, 'authorized', `grant ${verified.grant.grantId} client ${verified.grant.clientId} team ${verified.grant.up.project} root ${verified.root} request ${verified.requestId}`, at);
    clientRead = true;
    // The folder is the grant's, whatever the caller's: from here every read is of that team.
    io = { ...io, cwd: verified.root };
    if (!json) out.stderr(`client grant ${verified.grant.grantId}: ${verified.grant.clientId} for team ${verified.grant.up.project} at ${verified.root}, ${expiryPhrase(verified.grant.expires)}\n`);
  }
  if (args.values.project !== undefined) {
    return projectReport(args.values.project, out, io, sources, json);
  }
  // `--file` and `--session` are the owner's. The walk decides that before any file or session
  // is read, the same gate `worktree` and `watch` use. A plain folder's own seats need no flag:
  // `currentTeam` finds `.agents/team.yaml` in their folder. The one write on this path is the
  // `last_valid` copy, and only the owner's run keeps it.
  const walked = walkCaller(io);
  // A client run is never the owner's, whatever terminal it stands in.
  const owner = !clientRead && isOwner(walked);
  if (args.values.file !== undefined) {
    const refusal = fileOwnerRefusal(io, args.values.file);
    if (refusal !== undefined) {
      if (json) {
        writeJsonError(io, 'status.file-owner', plainText(refusal), 'the owner runs `team status --file <path>` from a terminal outside herdr', 1, 'owner-only');
      } else {
        out.stderr(`team status: ${plainText(refusal)}\n`);
      }
      // exit: status.file-owner
      return 1;
    }
  }
  if (args.values.session !== undefined && !owner) {
    const refusal = plainText(sessionOwnerRefusal(walked));
    if (json) {
      writeJsonError(io, 'status.session-owner', refusal, 'the owner runs `team status --session <name>` from a terminal outside herdr', 1, 'owner-only');
    } else {
      out.stderr(`team status: ${refusal}\n`);
    }
    // exit: status.session-owner
    return 1;
  }

  const current = currentTeam(io.cwd, owner ? args.values.file : undefined, sources.now(), sources.home, owner);
  if (!owner) {
    const read = current.ok && (clientRead || mayReadTeam(current, io, sources));
    // A create-grant admits the seat whose own registry record it names to the read, for a team
    // whose root is under the granted paths: the same record `init` and `up` consult. It buys the
    // read alone — `--file` and `--session` above stay the owner's, and this run keeps no
    // `last_valid` copy. Asked only where the read gate has refused, and only when a record
    // exists, so a seat's own reading reads no clock for it.
    const granted = current.ok && !read
      && readEntityCreateGrants(sources.home ?? homedir()).length > 0
      && entityGrantAdmits(current.root, io, { home: sources.home, now: sources.now(), cwd: io.cwd });
    if (!current.ok || (!read && !granted)) {
      out.stderr('team status: this team is not yours to read\n');
      // exit: status.not-yours
      return 2;
    }
  } else if (!current.ok) {
    if (json) {
      const id = current.errors[0]?.message.includes('not inside a git repository')
        ? 'status.not-a-repo'
        : current.errors.some(isParseError)
          ? 'status.file-invalid'
          : 'status.file';
      const msg = current.errors.map((p) => `${p.line ? `team.yaml line ${p.line}: ` : ''}${plainText(p.message)}`).join('; ');
      writeJsonError(io, id, msg, null);
    } else {
      printProblems(out, current.errors);
    }
    // exit: status.not-a-repo
    // exit: status.file
    // exit: status.file-invalid
    return 2;
  }
  const { team, root, dir } = current;
  if (!json && current.notice) out.stdout(`${plainText(current.notice)}\n`);

  const session = args.values.session ?? team.session;
  // The one read of the approval store: everything below derives from it.
  const standing = sources.standing(root);
  const overrides = sources.home ? overridesInForceOf(standing, team.project, root, sources.home) : emptyOverrides();
  for (const problem of overrides.problems) out.stderr(`team status: ${plainText(problem)}\n`);
  // The state is read before the world: the live read compares each pane with the process the
  // state recorded for the seat it holds.
  const whole = readState(dir);
  const state = whole.sessions[session] ?? emptySession();
  const live = sources.live(session, team, state);
  if (!live) {
    if (json) {
      writeJsonError(
        io,
        'status.herdr',
        "herdr doesn't answer; is it installed and running?",
        'start herdr and run `team status` again',
        1,
        undefined,
        current.notice ? plainText(current.notice) : undefined,
      );
    } else {
      out.stderr('team status: herdr doesn\'t answer; is it installed and running?\n');
    }
    // exit: status.herdr
    return 2;
  }
  const now = sources.now();
  // The team's hold first of all, the way it is the first thing a reader should know: a hold
  // past its `until` reads as none (`liveHold`), so neither the note nor the document carries
  // one that has lapsed. Read before the comparison below, whose held seats it marks.
  const hold = liveHold(whole, now);
  const budgets = budgetTable(budgetsInForceOf(standing, team), recall(whole.budgets), now.getTime());
  // The registry's binding per declared seat, read once for the comparison: a restored process
  // is proven by the record where one exists, and by the state's own copy where none does.
  const continuityIds = sources.home === undefined ? undefined : continuityIdsOf({
    home: sources.home,
    root,
    herdrSession: session,
    seats: team.seats,
    states: state.seats,
  });
  const comparison = compare(
    team, session, state, live, now,
    watchInForceOf(standing, team),
    undefined,
    // The owner's live grant, read fresh: the `team answer` repair line appears only while the
    // team grant carries `dialogs.trust`.
    dialogsTrustInForce(sources.home ?? homedir(), root, now),
    sources.home === undefined ? undefined : new Map(team.seats.flatMap((seat) => {
      const agent = findAgent(sources.home!, { team: teamIdOf(root), seat: seat.name });
      return agent ? [[seat.name, agent.signing] as const] : [];
    })),
    continuityIds,
  );
  const all = args.flags.has('all');
  // One probe of the machine daemon for the whole run: the line below, the document's `daemon`
  // field and the seats' presence qualification all come from the same snapshot, so they cannot
  // disagree. No second probe, no server, and no exit change — the reading is a fact, not a
  // verdict.
  const health = sources.daemonHealth === undefined
    ? null
    : await sources.daemonHealth(sources.home ?? homedir());
  // Whether the seats' presence projections may be called live: only a fresh route verdict that
  // says serving and healthy for this session. Default closed — a persisted status word or a
  // health answer without a verdict proves nothing.
  const presenceHealthy = health !== null && presenceChannelHealthy(health, root, session, now);
  // The same fresh answer's per-seat verdicts: when the route carries them, a seat is live only
  // by its own serving entry whose sampled binding matches the seat state's recorded one.
  const presenceSeats = health === null ? undefined : presenceSeatsOf(health, root, session, now);
  // The registry rows carry each seat's own reading: `--all` renders them as the expanded
  // table, and every `--json` document carries the reading on each row whether `--all` is
  // there or not. Without either, nothing here is read.
  const registryRows = all || json
    ? seatRegistryRows(team, state, live, comparison, now, true, hold !== null, {
        project: team.project, root, home: sources.home, stateDir: dir, session,
        presenceChannelHealthy: presenceHealthy,
        ...(presenceSeats === undefined ? {} : { presenceSeats }),
      })
    : undefined;
  const registryByName = registryRows ? new Map(registryRows.map((item) => [item.name, item])) : undefined;
  // The one machine check this reading cannot pass — the same fact `doctor` reports as a finding,
  // as one note, in the reading's own words. `up`'s refusal on it is its own line, and nothing
  // here changes an exit.
  const machine = sources.machine?.(root);
  if (machine) {
    const problem = swapTotalProblem(machine, team.machine);
    if (problem !== null) comparison.notes.unshift(problem);
  }
  if (!live.running) comparison.notes.unshift(`the herdr session "${session}" is not running`);
  if (hold) comparison.notes.unshift(holdText(hold));
  // The pause stands above both: it is the one note that says why no seat takes work.
  const pause = whole.pause;
  if (pause) comparison.notes.unshift(pauseText(pause));
  // A seat paused on its own stands beside the team's record and says why it alone stays still;
  // the rest of the team is unaffected, so its line names the seat.
  const seatPauses = whole.seat_pauses ?? {};
  comparison.notes.unshift(...Object.entries(seatPauses)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([seat, record]) => `seat paused: ${seat} (${pauseText(record)})`));
  // The swaps this project waits on, in seat order: the same line `team swap` prints, so the
  // reading says what each one waits for before the proc records below.
  const swaps = queuedSwaps(whole);
  for (const [seat, held] of swaps) comparison.notes.push(`swap ${swapLine(seat, held, now)}`);
  // What the seats recorded with `team proc add`: one note per live process, read the same way
  // `team proc list` reads it — a record whose pid is gone is skipped here and left for the next
  // write to clear. The reading is the note and the document, one derivation for both.
  // `--json` is the one text not cleaned: the document carries each string as it was read, so the
  // rows here are raw, and the note below is cleaned where it is printed like every other note.
  const procs = liveProcs(state, sources.alive ?? pidAlive).map(([name, held]) => ({
    name,
    by: held.by,
    at: held.at,
    ...(held.pid !== undefined ? { pid: held.pid } : {}),
    ...(held.note !== undefined ? { note: held.note } : {}),
  }));
  for (const held of procs) {
    comparison.notes.push(`proc ${held.name}: ${held.by} since ${held.at}${held.pid !== undefined ? `, pid ${held.pid}` : ''}`);
  }
  // Dev mode is the local override, read from the caller's place: under it the approval and
  // overrides rows fold into quiet notes — a team running so does not take the owner step they
  // name — and the policy, not the variable, decides once a value governs. A machine record
  // stands above both, and its own line names the mode, the moment and the owner provenance.
  const machineMode = sources.home !== undefined ? readDevelopmentMode(sources.home) : null;
  const machineNote = machineMode === null ? null : developmentModeNote(machineMode);
  if (machineNote !== null) comparison.notes.push(machineNote);
  // The owner-signed security profile: a relaxed one is said loudly on every status; a record that
  // does not verify is said too (strict then applies). No record, no line: strict is the default.
  if (sources.home !== undefined && existsSync(securityProfilePath(sources.home))) {
    comparison.notes.push(securityProfileLine(readSecurityProfile(sources.home, sources.ownerSeatStore ?? systemOwnerSeatKeyStore(ownerSeatHelperPath(sources.home)), now)));
  }
  // Idle with work and ready-but-uninstalled slices: one read each, notes only, no exit change.
  // The snapshot always exists once the watch provides one (the default local queue counts as a
  // source); the green read keeps a corrupt journal a named refusal rather than an empty list.
  const idleWork = sources.idleWork?.({
    root,
    team,
    state,
    live,
    now,
    ...(sources.home !== undefined ? { home: sources.home } : {}),
    // The project's records, not one session's: a paused team claims nothing and a seat holding
    // a queued swap is not an idle worker.
    pause: whole.pause ?? null,
    seatPauses: whole.seat_pauses ?? null,
    swaps: Object.keys(whole.swaps ?? {}),
  });
  if (idleWork !== undefined) comparison.notes.push(...idleWorkNotes(idleWork));
  const green = sources.pendingGreen === undefined ? null : readPendingGreen(sources.pendingGreen, dir);
  if (green !== null) comparison.notes.push(...greenNotes(green));
  if (health !== null) {
    comparison.notes.push(...daemonNotes(health));
    // The hosted watches that same reading carries: one plain line per watched route, and a
    // blocked outbound gate said as blocked — never as enforcing.
    comparison.notes.push(...hostedWatchNotes(health, now));
  }
  const record = approvalAndOverrideRows(
    standing.kind === 'legacy' || standing.kind === 'refused' ? notInForce(standing) : null,
    overrides,
    devModeActive(io, {
      ...(sources.home !== undefined ? { home: sources.home } : {}),
      entity: team.entity ?? null,
      team,
      root,
      now,
    }),
  );
  comparison.notes.push(...record.notes);
  comparison.differences = orderAndAnnotateDifferences([
    ...comparison.differences,
    ...protectedCheckouts(team, root, sources),
    // `approve` is gone: a machine that never approved this file is the ordinary case now, not a
    // difference, and the reading exits 0 for it. A legacy record and one the verification refused
    // still say what they are — as rows, or under dev mode as the quiet notes above.
    ...record.differences,
    // The file's own rules files, only once a record exists for a launch to have written them.
    ...rulesFileDifferences(standing, team, root, sources.home),
    // A seat whose reading is blind — unknown past the blind threshold — counts as
    // not working, and is a must-fix here exactly as it is in `team check`.
    ...blindDifferences(team, state, live, comparison, now, hold !== null, {
      project: team.project, root, home: sources.home, stateDir: dir, session,
      presenceChannelHealthy: presenceHealthy,
      ...(presenceSeats === undefined ? {} : { presenceSeats }),
    }),
  ]);

  const visibleRows = all
    ? comparison.rows
    : comparison.rows.filter((row) => row.state !== 'stopped');

  if (json) {
    writeJson(io, 'team.status', {
      format: 1 as const,
      project: team.project,
      session,
      rows: visibleRows.map((row) => {
        // The expanded columns stay `--all`'s: without it `extra` is undefined and every field
        // the row published stands as it was. The reading below is every row's, `--all` or not.
        const found = registryByName?.get(row.name);
        const extra = all ? found : undefined;
        return {
          name: row.name,
          ...(extra ? { id: extra.id } : row.id ? { id: row.id } : {}),
          ...(extra ? { role: extra.role, nickname: extra.nickname ?? null, cli: extra.cli } : {}),
          state: row.stored ?? row.state,
          model: row.model,
          ...(extra ? { effort: extra.effort, last_active: extra.last_active } : {}),
          pane: row.pane,
          ...(extra ? { launch_line: extra.launch_line } : {}),
          ...(found ? { seat_state: found.state, seat_state_source: found.state_source } : {}),
          ...(found?.presence !== undefined ? { seat_presence: found.presence } : {}),
          ...(found?.presence_unreadable === true ? { seat_presence_unreadable: true as const } : {}),
          ...(found?.blind ? { blind: true as const } : {}),
          ...(extra?.dev_mode === true ? { dev_mode: true } : {}),
          ...(row.start_cwd ? { start_cwd: row.start_cwd } : {}),
        };
      }),
      notes: comparison.notes,
      ...(idleWork !== undefined ? { idle_work: idleWork } : {}),
      ...(green?.kind === 'slices' ? { green_slices: green.slices } : {}),
      ...(green?.kind === 'refused' ? { green_notice: green.why } : {}),
      ...(health !== null ? { daemon: daemonReading(health) } : {}),
      differences: comparison.differences.map(toJsonDifference),
      summary: summaryCounts(comparison.differences),
      notice: current.notice ?? null,
      ...(budgets.length ? { budgets } : {}),
      ...(hold ? { hold } : {}),
      ...(pause ? { pause } : {}),
      ...(Object.keys(seatPauses).length > 0 ? { seat_pauses: seatPauses } : {}),
      ...(procs.length ? { procs } : {}),
      ...(swaps.length ? { swaps: swaps.map(([seat, swap]) => ({ seat, swap })) } : {}),
    });
  } else {
    const style = ttyStyle(io);
    const rendered = render(team, session, comparison, budgets, all ? registryRows : undefined, style, sources.home);
    if (style.enabled) {
      io.stdout(rendered);
    } else {
      out.stdout(rendered);
    }
  }
  // exit: status.agrees
  // exit: status.difference
  return comparison.differences.length ? 1 : 0;
}

export function emptyOverrides(): OverrideForce {
  return { profiles: [], differences: [], problems: [] };
}

export function overrideDrift(report: OverrideForce): Difference[] {
  return [
    ...report.differences.map((line): Difference => ({
      what: `the overrides differ from the stored copy: ${line}`,
      repair: APPROVAL_REPAIR,
      approval: true,
      owner: true,
    })),
    ...report.problems.map((problem): Difference => ({ what: problem, repair: 'fix the overrides file' })),
  ];
}

// The file's case as one row of its own, for a standing that still says something: a legacy
// record, or one the verification refused. No record on this machine is not one of those — with
// `approve` gone it is the ordinary file, nothing for the owner to repair, and it never fails a
// reading. A record in force is nothing to say either, and nothing is compared against it — the
// live file is what the commands read, so an edit to it is not a difference.
export function approvalCaseRow(reason: string | null): Difference[] {
  if (reason === null) return [];
  return [{ what: reason, repair: APPROVAL_REPAIR, approval: true, owner: true }];
}

// The two state rows as one reading, for `team status` and `team check` alike. Under dev mode —
// the local override, read from the effective policy once a value governs — they fold into quiet
// notes: a team running so does not take the owner step they name, and the reading still says
// what it set aside. The override report's own problems are never folded: a file that will not
// parse is not a comparison dev mode can waive.
export function approvalAndOverrideRows(
  reason: string | null,
  report: OverrideForce,
  quiet: boolean,
): { differences: Difference[]; notes: string[] } {
  if (!quiet) return { differences: [...approvalCaseRow(reason), ...overrideDrift(report)], notes: [] };
  const notes: string[] = [];
  if (reason !== null) notes.push(`${reason}; dev mode does not compare it`);
  if (report.differences.length > 0) {
    notes.push(`${pluralCount(report.differences.length, 'override difference')}; dev mode does not compare them`);
  }
  return { differences: overrideDrift({ ...report, differences: [] }), notes };
}


/** Every message-rules seat's file, against the rules the live file gives it. A file that
 *  differs is a difference for a grant holder — or the owner — to repair with `team reload
 *  <seat>`, whose grant gate admits both; never rewritten here. No `owner: true` is set: the
 *  repair names the command, and the map reads it as the grant scope it is. An option seat has
 *  no file, and a seat whose rules can't travel at all is `up`'s to refuse. */
/** The one seat's rules-file check, or null when the file holds exactly the rules the live file
 *  gives that seat. The reading `rulesFileDifferences` makes per seat, shared with `team reload`
 *  so a repair can never disagree with the check that named it: the same home rule, the same
 *  live project, the same text. Null for a stopped seat (nothing wrote its file), an option seat
 *  (its rules travel on the launch line), a seat with no typeable path, and no home at all (a
 *  test standing in for no store). */
export function rulesFileProblem(standing: Standing, team: TeamFile, seat: Seat, root: string, home: string | undefined): string | null {
  // The check runs only once a record exists, so a file that was never approved does not grow a
  // difference for a file no launch has written.
  if (home === undefined || standing.kind !== 'verified') return null;
  // A stopped seat is not checked: `up` writes the file only at a delivery, so the repair
  // below could not fix a stopped seat's file. An unstopped seat's file is rewritten the
  // next time it launches, so no stale file outlives one.
  if (seat.stopped) return null;
  // A seat whose rules ride a launch option or a brief has no file of its own to check.
  if ((profileFor(seat.cli)?.rulesMode ?? 'message') !== 'message') return null;
  const path = rulesFilePath(team.project, root, home, seat.name);
  if (path === null) return null;
  const check = checkRulesFile(path, rulesOf(team, seat, root));
  return check.ok ? null : check.what;
}

export function rulesFileDifferences(standing: Standing, team: TeamFile, root: string, home: string | undefined): Difference[] {
  if (home === undefined || standing.kind !== 'verified') return [];
  const out: Difference[] = [];
  for (const seat of team.seats) {
    const problem = rulesFileProblem(standing, team, seat, root, home);
    if (problem !== null) out.push({ what: `${seat.name}: ${problem}`, repair: `team reload ${seat.name}` });
  }
  return out;
}

/** The protected checkouts left on another branch — the same rows `status` prints, for `check`
 *  too. All it reads of the sources is the branch of a path. */
export function protectedCheckouts(team: TeamFile, root: string, sources: { branch(path: string): string | null }): Difference[] {
  const base = team.workspace.base;
  if (!base) return [];
  const out: Difference[] = [];
  for (const path of team.workspace.protected) {
    const full = resolve(root, path);
    const branch = sources.branch(full);
    if (branch === null || branch === base) continue;
    const shown = relative(root, full) || '.';
    out.push({
      what: `the protected checkout "${shown}" is on ${branch === 'HEAD' ? 'a detached commit' : `"${branch}"`}, not on "${base}"`,
      repair: `the owner switches it back: git -C ${shown} switch ${base}`,
      owner: true,
    });
  }
  return out;
}

/**
 * `team status --project <name>`: the project's teams, from the registry — the project itself
 * through the projects source, each team's record through the team registry. The reading covers
 * every team of the project the way the plain reading covers every seat of a team: a team the
 * registry does not know is said as such, never left out.
 */
function projectReport(name: string, out: Io, io: Io, sources: StatusSources, json: boolean): number {
  // An injected projects source answers for itself; with none, the registry the home holds is the
  // reading — the same file `team projects` reads, bound to the injected home, never another's.
  const project = sources.projects ? sources.projects.byName(name) : projectRegistry.byName(sources.home ?? homedir(), name);
  if (!project) {
    if (json) {
      writeJsonError(io, 'status.project-unknown', `no project named ${JSON.stringify(name)}; nothing to show`, null, 1);
    } else {
      out.stderr(`team status: no project named ${JSON.stringify(name)}; nothing to show\n`);
    }
    // exit: status.project-unknown
    return 1;
  }
  const records = readTeams(sources.home ?? homedir());
  const teams = project.teams.map((teamId) => {
    const record = records[teamId] ?? null;
    return {
      name: teamId,
      session: record?.session ?? null,
      lifecycle: record?.lifecycle ?? null,
      seats: record ? record.roster.length : null,
    };
  });
  if (json) {
    writeJson(io, 'team.status.project', { format: 1 as const, project, teams });
  } else {
    const lines = [projectContextLine(project)];
    for (const team of teams) {
      lines.push(team.session === null
        ? `  ${plainLine(team.name)}  not registered`
        : `  ${plainLine(team.name)}  session "${plainLine(team.session)}"  ${plainLine(team.lifecycle ?? '?')}  ${team.seats === null ? '? seats' : pluralCount(team.seats, 'seat')}`);
    }
    out.stdout(`${lines.join('\n')}\n`);
  }
  // exit: status.project-listed
  return 0;
}

function render(
  team: TeamFile,
  session: string,
  comparison: Comparison,
  budgets: BudgetRow[],
  registryRows?: SeatRegistryRow[],
  style: TtyStyle = ttyStyle(false),
  home?: string,
): string {
  const lines = [contextLine(team.project, session)];
  if (registryRows) {
    lines.push(...renderSeatsTable(registryRows, '  ', style).trimEnd().split('\n'));
  } else {
    const visibleRows = comparison.rows.filter((row) => row.state !== 'stopped');
    lines.push(
      ...renderTable({
        headers: ['SEAT', 'STATE', 'MODEL', 'PANE', 'REACH'],
        rows: visibleRows.map((row) => [
          row.name,
          row.state,
          row.model,
          row.pane,
          row.reach ?? 'typed',
        ]),
        indent: '  ',
        style,
        styleCell: (padded, _raw, _r, col, s) => (col === 1 ? s.styleState(padded) : padded),
      }),
    );
  }
  if (budgets.length) {
    lines.push('budgets:');
    // The row carries its own reserve: the line and the JSON can't disagree (queue 79).
    for (const row of budgets) lines.push(`  ${plainLine(budgetLine(row))}`);
  }
  lines.push(...renderNotes(comparison.notes, { home }));
  lines.push(...renderDifferences(comparison.differences, style, home));
  lines.push(renderSummary(comparison.differences));
  return `${lines.join('\n')}\n`;
}

function printProblems(io: Io, problems: Problem[]): void {
  for (const problem of problems) {
    io.stderr(`team status: ${problem.line ? `team.yaml line ${problem.line}: ` : ''}${plainText(problem.message)}\n`);
  }
}
