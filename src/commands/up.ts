import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalDifferencesOf, budgetsInForceOf, notInForce } from '../approve/approval.ts';
import { ownerAuthorized, upFingerprint } from '../approve/owner-token.ts';
import { readArgs } from '../args.ts';
import { callerLabel, callerOf, describeCaller, mayLaunchSeats, walkCaller } from '../caller.ts';
import { delegateGate, logDelegated } from '../delegate.ts';
import { TEAM_FILE, loadTeamFile } from '../file/load.ts';
import { migrationText } from '../file/migrate.ts';
import { isLegacyTrust, isMigratedTrust } from '../file/paths.ts';
import { declaredModel } from '../file/model.ts';
import { isLeadSeat, relaunchRepair, unidentifiedRepair } from '../file/sections/lead.ts';
import { displayAgent, workspaceLabel } from '../file/sections/seats.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import {
  agentList,
  agentStatus,
  agentRename,
  focusAgent,
  paneForeground,
  paneProcesses,
  paneRead,
  paneRun,
  reportDisplayAgent,
  paneShellBack,
  sessionDelete,
  sessionStop,
  typeText,
  pressEnter,
  sessionRunning,
  sessionState,
  startServer,
  workspaceClose,
  workspaceCreate,
  workspaceList,
  workspacePanes,
  type HerdrAgent,
  type HerdrWorkspace,
  type PaneProcesses,
  type SessionState,
} from '../herdr.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import type { Host } from '../launch/execute.ts';
import { executePlan } from '../launch/execute.ts';
import { launchedIdentity, paneHoldsShell, seatProcessVerdict } from '../launch/identity.ts';
import { launchLineFinding } from '../launch/line.ts';
import { formatPlan, upPlan, type UpSeat } from '../launch/plan.ts';
import { runPause, type PauseHost, type PauseInput } from '../launch/pause.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { recordWhat, progressWriter, classificationOf } from '../launch/progress.ts';
import { acquireRunLock, runLockText } from '../launch/run-lock.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { processSignals, terminalReader, type Terminal } from '../launch/terminal.ts';
import { trustPolicy } from '../file/dialogs.ts';
import { rulesOf } from '../launch/rules.ts';
import { rulesFileHash, rulesFileHolds, seatDeliveryOf, typeablePath, writeRulesFile } from '../launch/rules-file.ts';
import { deliverRules, fileRefusalOf, type Refusal } from '../launch/deliver.ts';
import { recheckLobby, resolveLobby, verifyLobby, type FsReader, type LobbySeen } from '../lobby/gate.ts';
import { logLine } from '../log.ts';
import { shellQuote } from '../profiles/profile.ts';
import { profileFor, shippedLobbyFiles } from '../profiles/index.ts';
import { reachProjectionNote, writeReachProjection } from '../reach/projection.ts';
import { approvalStanding, type Ceilings, type Standing } from '../store/store.ts';
import { forgetLaunchedPane, noteLaunchedPane } from '../file/launched-file.ts';
import { emptySession, readState, updateState, type SeatState } from '../state.ts';
import { seatBudget } from '../budgets/gate.ts';
import { loadReadings, loadSpendReadings } from '../budgets/readings.ts';
import { blocksLaunch, doctorFindings, realSources as doctorSources, type DoctorSources } from './doctor.ts';
import { leftoverName } from './remove.ts';
import { launchLimit, readMachine, readingsText, type Machine, type SwapSample } from '../watch/machine.ts';
import { canShowModel, modelDiffers, seatModel } from '../status/statusline.ts';
import { readScreen } from '../watch/screen.ts';
import { seatStart } from '../worktree/place.ts';

// What `up` reads from outside the file, so tests can stand in for it.
export type UpSources = {
  sessionRunning(session: string): boolean | null;
  sessionState?(session: string): SessionState | null;
  agents(session: string): HerdrAgent[] | null;
  /** The session's workspaces with their labels now; null when herdr can't tell. The waiting
   *  proof compares a pane's workspace label with the seat's launch label. */
  workspaces?(session: string): HerdrWorkspace[] | null;
  home: string;
  getuid?(): number;
  fs?: FsReader;
  doctor?: DoctorSources;
  machine?(root: string): Machine;
  now?(): Date;
  sleep?(ms: number): Promise<void>;
  alive?(pid: number): boolean;
  watchCommand?(session: string): string;
  // The owner's terminal, for the pause at a dialog. Absent: Node's own stdin, read in raw
  // mode for one key at a time (`terminal.ts`). A dry run and a caller without a terminal
  // never read it.
  terminal?(): Terminal;
  // The approval store's one read, overridable so a test can count it or swap the record
  // after the gate. Absent: the real read.
  standing?(root: string): Standing;
  // The budget gate, overridable so a test can count its calls. Absent: the real gate.
  // A standing that is not verified refuses below before this is consulted at all.
  seatBudget?: typeof seatBudget;
  // The delegate gate, overridable so a test can fake its verdict without the real preflight.
  // Absent: the real gate. The audit line of a delegated run, overridable the same way.
  delegateGate?: typeof delegateGate;
  logDelegated?: typeof logDelegated;
  // Present on the shipped command. A dry run never calls it.
  launch?: Launch;
};

export type Launch = {
  sessionState(session: string): SessionState | null;
  startServer(session: string): boolean;
  sessionUp(session: string): boolean | null;
  createWorkspace(session: string, cwd: string, label: string): { pane: string; workspace: string } | null;
  paneRun(session: string, pane: string, command: string): boolean;
  /** Sets the pane's display_agent after launch. False is one line and does not leave the seat out. */
  reportDisplayAgent?(session: string, pane: string, text: string): boolean;
  renameAgent(session: string, pane: string, name: string): boolean;
  closeWorkspace(session: string, workspace: string): boolean;
  agentPanes(session: string): string[] | null;
  /** The session's agents as herdr lists them now; null when the list can't be read. */
  agents(session: string): HerdrAgent[] | null;
  /** Pane ids in a workspace as herdr lists them now; null when the list can't be read. */
  workspacePanes?(session: string, workspace: string): string[] | null;
  paneText(session: string, pane: string): string | null;
  typeText?(session: string, pane: string, text: string): boolean;
  pressEnter?(session: string, pane: string): boolean;
  agentStatus?(session: string, pane: string): string | null;
  /** Foreground argv0 names, or null when the pane can't be read. */
  foreground(session: string, pane: string): string[] | null;
  /** Whether the pane's foreground program is back to its shell; null when herdr can't tell. */
  shellBack?(session: string, pane: string): boolean | null;
  /** The pane's process identity, compared with the one recorded for the seat. */
  processInfo?(session: string, pane: string): PaneProcesses | null;
  /** Brings the pane to the owner's attention, without sending a key or a text into it. */
  focus?(session: string, pane: string): boolean;
  /** Stops the session (`q` in the pause, only for a session this invocation started). */
  stopSession?(session: string): boolean;
  /** Clears a stopped session this team's state records, so the run can start it. */
  deleteSession?(session: string): boolean | Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): Date;
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

function sameFile(a: string, b: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(a) === real(b);
}

/** Whether a flagless watch started in `start` would read `flagged`. The decision is that load,
 *  not the shape of the path: the same function the watch runs, with no `--file`. */
export function watchWouldRead(start: string, flagged: string, home?: string): boolean {
  const found = loadTeamFile(start, home ? { home } : {});
  return found.ok && sameFile(found.path, flagged);
}

/** The watchdog command, from this process and this install: `team` may not be on the PATH. */
export function watchCommand(session: string): string {
  const here = fileURLToPath(import.meta.url);
  const cli = join(dirname(here), '..', here.endsWith('.ts') ? 'cli.ts' : 'cli.js');
  const suffix = session === 'default' ? '' : ` --session ${shellQuote(session)}`;
  return `${shellQuote(process.execPath)} ${shellQuote(cli)} watch${suffix}`;
}

const realLaunch: Launch = {
  sessionState,
  startServer,
  sessionUp: sessionRunning,
  createWorkspace: (session, cwd, label) => workspaceCreate(cwd, label, aim(session)),
  paneRun: (session, pane, command) => paneRun(pane, command, aim(session)),
  reportDisplayAgent: (session, pane, text) => reportDisplayAgent(pane, text, aim(session)),
  renameAgent: (session, pane, name) => agentRename(pane, name, aim(session)),
  closeWorkspace: (session, workspace) => workspaceClose(workspace, aim(session)),
  agentPanes(session) {
    const agents = agentList(aim(session));
    return agents === null ? null : agents.map((agent) => agent.pane);
  },
  agents: (session) => agentList(aim(session)),
  workspacePanes: (session, workspace) => workspacePanes(workspace, aim(session)),
  paneText: (session, pane) => paneRead(pane, 200, aim(session)),
  typeText: (session, pane, text) => typeText(pane, text, aim(session)),
  pressEnter: (session, pane) => pressEnter(pane, aim(session)),
  agentStatus: (session, pane) => agentStatus(pane, aim(session)),
  foreground: (session, pane) => paneForeground(pane, aim(session)),
  shellBack: (session, pane) => paneShellBack(pane, aim(session)),
  processInfo: (session, pane) => paneProcesses(pane, aim(session)),
  focus: (session, pane) => focusAgent(pane, aim(session)),
  stopSession: (session) => sessionStop(session),
  deleteSession: sessionDelete,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

export const realSources: UpSources = {
  sessionRunning,
  sessionState,
  agents: (session) => agentList(aim(session)),
  workspaces: (session) => workspaceList(aim(session)),
  home: homedir(),
  getuid: () => process.getuid?.() ?? 0,
  doctor: doctorSources,
  machine: readMachine,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  watchCommand,
  launch: realLaunch,
};

export const USAGE = 'Usage: team up [--dry-run] [--session <name>] [--file <path>]\n';

export const up: Command = (argv, io) => runUp(argv, io, realSources);
export default up;

function resolveState(sources: UpSources, session: string): SessionState | null {
  if (sources.sessionState) return sources.sessionState(session);
  const running = sources.sessionRunning(session);
  if (running === null) return null;
  return running ? 'running' : 'absent';
}

type Running = { name: string; vendor: string; temporary: boolean };

function overCeiling(ceilings: Ceilings, running: readonly Running[], seat: Seat): string | null {
  if (running.some((item) => item.name === seat.name)) return null;
  const count = running.length + 1;
  if (count > ceilings.seats) return `the approval allows ${ceilings.seats} seats; ${count} would be running`;
  const cap = ceilings.vendors[seat.vendor];
  if (cap !== undefined) {
    const vendors = running.filter((item) => item.vendor === seat.vendor).length + 1;
    if (vendors > cap) return `the approval allows ${cap} ${seat.vendor} seats; ${vendors} would be running`;
  }
  return null;
}

/** What a caller is told when a drifted seat is working and this `up` will not close it. */
function driftWay(owner: boolean, name: string): string {
  return owner
    ? `team remove ${name} --abandon`
    : 'run this again once herdr reports the seat idle or done';
}

// A ready seat whose process is still the one team launched. `skip` is today's ready line.
// `hold` is a drift this run will not close (a running turn). `cycle` closes without input
// and launches the file's line. A lead is never cycled. A screen that names no model is
// never cycled: unread is not a difference.
function modelDrift(
  team: TeamFile,
  seat: Seat,
  recorded: SeatState,
  agents: readonly HerdrAgent[],
  processes: Readonly<Record<string, PaneProcesses | null>>,
  screenOf: (pane: string) => string | null,
  owner: boolean,
): { kind: 'skip' } | { kind: 'hold'; detail: string } | { kind: 'cycle'; way: string } {
  if (isLeadSeat(team, seat.name)) return { kind: 'skip' };
  if (!recorded.launched || !recorded.pane || !recorded.workspace || !seat.version) return { kind: 'skip' };
  if (seatProcessVerdict(recorded.launched, processes[seat.name] ?? null) !== 'same') return { kind: 'skip' };
  const listed = agents.find((agent) => agent.pane === recorded.pane);
  if (!listed || listed.name !== seat.name) return { kind: 'skip' };
  if (!canShowModel(seat)) return { kind: 'skip' };
  const text = screenOf(recorded.pane);
  if (text == null || text === '') return { kind: 'skip' };
  const running = seatModel(seat, text);
  if (!running || !modelDiffers(running, { model: seat.model, version: seat.version })) return { kind: 'skip' };
  const kind = readScreen(seat.cli, text).kind;
  const way = driftWay(owner, seat.name);
  // Herdr's word and the screen: either one saying the seat is mid-turn keeps the pane.
  if (listed.status === 'working' || kind === 'working') return { kind: 'hold', detail: `its model drifted; left as it is (${way})` };
  // Idle or done, including a box that holds unsent text. A dialog is not closed from here,
  // and neither is a screen this version does not classify.
  if ((listed.status === 'idle' || listed.status === 'done') && (kind === 'idle' || kind === 'unsent')) {
    return { kind: 'cycle', way };
  }
  return { kind: 'skip' };
}

/** A record with no process identity whose pane is a bare shell or another model. `up` does not
 *  close it: without an identity there is no proof the pane is the seat's. Null when the record
 *  has an identity, or when the pane cannot be told apart from the seat the file describes. */
function unidentifiedHold(
  team: TeamFile,
  seat: Seat,
  recorded: SeatState,
  processes: Readonly<Record<string, PaneProcesses | null>>,
  screenOf: (pane: string) => string | null,
): string | null {
  if (recorded.launched || !recorded.pane) return null;
  const proc = processes[seat.name];
  const repair = unidentifiedRepair(team, seat.name);
  if (paneHoldsShell(proc ?? null)) {
    return `its pane runs no CLI and its process was never recorded (${repair})`;
  }
  // No process reading: the screen is not consulted. A ready seat keeps today's relaunch note,
  // and a seat still at launch is finished.
  if (proc == null) return null;
  // A seat still at launch is finished: a CLI is in the pane. Only a seat already recorded
  // ready is left in place when its screen names another model.
  if (recorded.stage !== 'ready') return null;
  if (!canShowModel(seat) || !seat.version) return null;
  const text = screenOf(recorded.pane);
  if (text == null || text === '') return null;
  const running = seatModel(seat, text);
  if (!running || !modelDiffers(running, { model: seat.model, version: seat.version })) return null;
  return `its screen runs ${running.model} ${running.version}; the file says ${declaredModel(seat)}; its process was never recorded (${repair})`;
}

function seatPlan(
  standing: Standing,
  team: TeamFile,
  seat: Seat,
  recorded: SeatState | undefined,
  agents: readonly HerdrAgent[],
  workspaces: HerdrWorkspace[] | null,
  resume: boolean,
  root: string,
  home: string,
  processes: Readonly<Record<string, PaneProcesses | null>> = {},
  screenOf: (pane: string) => string | null = () => null,
  owner = true,
): UpSeat {
  const planned: UpSeat = {
    name: seat.name,
    cli: seat.cli,
    launch: seat.launch,
    cwd: seat.cwd,
    label: workspaceLabel(seat),
    displayAgent: displayAgent(seat),
    model: seat.model,
    version: seat.version,
    // The team file's own repair for this seat — a lead seat is told only the whole-team
    // sequence, never a `remove --keep` its file refuses (`lead.ts`).
    repairLine: relaunchRepair(team, seat.name, 'markdown'),
    stopped: seat.stopped,
    // An option seat's rules keep coming from the live file, as main's launch line does; a
    // message seat's file and line are the approved copy's, whatever the live file says now.
    rules: rulesOf(team, seat, root),
    ...seatDeliveryOf(standing, team, seat, root, home),
  };
  if (!resume || !recorded || seat.stopped) return planned;
  // §5: a seat recorded waiting takes precedence over everything below. Its recorded pane and
  // workspace are reused — never launched again — while the host still lists that pane: the
  // pause reads it fresh and verifies it before doing anything. A pane the host no longer
  // lists is not that refusal: a fresh workspace is made and the seat launches. A recorded
  // workspace the host still lists is named on that line and left. A pane the host still
  // lists, including one whose process this run cannot account for, is never closed or
  // recreated.
  if (recorded.waiting) {
    const named = agents.filter((agent) => agent.name === seat.name);
    const paneListed = recorded.pane !== undefined && agents.some((agent) => agent.pane === recorded.pane);
    if (named.length === 0 && recorded.pane && !paneListed) {
      // The old workspace stays when the host still lists it. A listed workspace still holds
      // a pane — herdr closes a workspace with its last pane — so it is named, not closed.
      const leftWorkspace = recorded.workspace !== undefined
        && workspaces?.some((item) => item.id === recorded.workspace)
        ? recorded.workspace
        : undefined;
      return { ...planned, replacedPane: recorded.pane, ...(leftWorkspace ? { leftWorkspace } : {}) };
    }
    // The pane is herdr's one agent of this seat's name. No such agent, or two, is left out
    // and not launched: the recorded pane is still listed, or the name is ambiguous.
    const live = named.length === 1 ? named[0] : undefined;
    return {
      ...planned,
      ...(recorded.stage ? { stage: recorded.stage } : {}),
      ...(live ? { pane: live.pane, workspace: live.workspace } : {}),
      waiting: recorded.waiting,
      ...(recorded.launched ? { waitingLaunched: recorded.launched } : {}),
      ...(live ? {} : { resumeGap: named.length === 0 ? 'none' as const : 'many' as const }),
    };
  }
  // A record with no process identity cannot prove its pane. A bare shell or another model is
  // reported, with the repair that works, and is not closed and not launched again.
  const hold = unidentifiedHold(team, seat, recorded, processes, screenOf);
  if (hold) return { ...planned, stage: recorded.stage, unidentifiedHold: hold };
  // The pane is the seat only while the process team launched is still in it: a pane that runs
  // no CLI, or one whose process is not the recorded one, is not the seat. Its workspace is
  // closed without input and the seat is launched fresh — the stage it stopped at is not
  // resumed. No workspace recorded, no close to make: the seat is left as it is. The close
  // itself reads herdr again, immediately before it (`execute.ts`), so this reading only
  // decides that the seat needs repair, never that its recorded workspace is still its own.
  const verdict = seatProcessVerdict(recorded.launched, processes[seat.name] ?? null);
  if ((verdict === 'gone' || verdict === 'replaced') && recorded.workspace && recorded.pane && recorded.launched) {
    return {
      ...planned,
      repair: { pane: recorded.pane, workspace: recorded.workspace, launched: recorded.launched, cli: seat.cli },
    };
  }
  const named = agents.find((agent) => agent.name === seat.name);
  const onPane = recorded.pane ? agents.some((agent) => agent.pane === recorded.pane) : false;
  if (recorded.stage === 'ready') {
    if (named || onPane) {
      const drift = modelDrift(team, seat, recorded, agents, processes, screenOf, owner);
      if (drift.kind === 'cycle' && recorded.pane && recorded.workspace && recorded.launched) {
        return {
          ...planned,
          repair: {
            pane: recorded.pane,
            workspace: recorded.workspace,
            launched: recorded.launched,
            cli: seat.cli,
            drift: { way: drift.way },
          },
        };
      }
      if (drift.kind === 'hold') return { ...planned, stage: 'ready', driftHold: drift.detail };
      return { ...planned, stage: 'ready', ...restartNote(team, seat.name, recorded, home, root) };
    }
    return planned;
  }
  const workspaceLive =
    recorded.workspace && workspaces ? workspaces.some((workspace) => workspace.id === recorded.workspace) : null;
  const live = Boolean(named || onPane || workspaceLive);
  if (!live) return planned;
  return {
    ...planned,
    stage: recorded.stage,
    pane: recorded.pane,
    workspace: recorded.workspace,
    agentLive: Boolean(named || onPane),
  };
}

// What only a relaunch repairs, for a ready seat this `up` leaves as it is: a process team it
// never recorded (a launch from before identities were), or a start outside the machine lobby
// (an old release's start). The skip line says what does repair it; both repairs relaunch the
// seat — one seat at a time, or the whole team (for an orchestrator or operator, only the whole team).
function restartNote(
  team: Pick<TeamFile, 'orchestrator' | 'operator' | 'entity' | 'lobby'>,
  name: string,
  recorded: SeatState,
  home: string,
  root: string,
): { restartNote: string } | Record<string, never> {
  const fix = relaunchRepair(team, name, 'plain');
  if (!recorded.launched) return { restartNote: `a relaunch records its process: ${fix}` };
  // A running lead is at home in the lobby or in the project. Either recording is left as it
  // is. Every other seat still outside the lobby is told how to move.
  if (recorded.start_cwd && recorded.start_cwd !== resolveLobby(home, team)) {
    if (isLeadSeat(team, name) && recorded.start_cwd === root) return {};
    return { restartNote: `a relaunch moves it into the lobby: ${fix}` };
  }
  return {};
}

export async function runUp(argv: string[], io: Io, sources: UpSources): Promise<number> {
  // Every line this run writes goes through the cleaned writers from here; the raw pair stays
  // reachable for the progress writer alone, which draws its own `\r\x1b[K` on a TTY.
  const out = cleanedIo(io);
  const args = readArgs(argv, ['session', 'file'], ['dry-run']);
  if (args.error || args.rest.length) {
    out.stderr(`team up: ${plainText(args.error ?? `unexpected "${args.rest[0]}"`)}\n${USAGE}`);
    // exit: up.invocation
    return 2;
  }
  const dry = args.flags.has('dry-run');
  // §RFC0007: a caller the ordinary rule refuses is judged by the delegate gate against the
  // DEFAULT live file of this cwd, read with no flag — before any `--file` or `--session` is
  // honoured. Both are the owner's alone: the gate refuses them for a delegated run, and a
  // delegate's eligibility never comes from a file the caller names. A gate refusal replaces the
  // ordinary caller refusal, and the flagged target is never read; a passed verdict makes
  // the run the delegate's, on that same default file. The owner's runs never come here, and
  // with no `delegates` section, a non-owner's `--session`, or a `--file` other than this
  // folder's own team file, is the ordinary refusal and returns before that file or session is
  // read. A delegate verdict that already refused the same aim returns here too, in the gate's
  // own words. This folder's own file, with no `--session`, continues below. The path comparison
  // is the resolved spelling: a link, or a differently-cased spelling of this folder's own team
  // file, is not that file, and is refused here before it is opened.
  const walked = walkCaller(io);
  const defaultLoad = mayLaunchSeats(walked) ? null : loadTeamFile(io.cwd, { home: sources.home });
  const delegateTeam = defaultLoad !== null && defaultLoad.ok && defaultLoad.team.delegates ? defaultLoad : null;
  const verdict = delegateTeam
    ? (sources.delegateGate ?? delegateGate)({
        command: 'up',
        team: delegateTeam.team,
        root: delegateTeam.root,
        dir: dirname(delegateTeam.path),
        flags: [...args.flags, ...Object.keys(args.values)],
        io,
        home: sources.home,
      })
    : null;
  // The approved `<session>/<pane id>` when this run is a delegated one: the ordinary caller rule
  // refused, the default file's `delegates` section named a pane, and the gate passed it.
  let delegated: string | null = null;
  if (verdict?.kind === 'passed') delegated = verdict.pane;
  // A non-owner passing `--session`, or a `--file` other than this folder's own team file, is
  // refused here, before that file is read, before a session is asked, and before an out-of-band
  // owner token is matched. The walk reads no session. The token is a yes for the launch this
  // folder's own file would make, so it is matched only on the path below, which never opens a
  // flagged file and never asks a named session. A delegate verdict that already refused this aim
  // returns in the gate's words, before the caller is placed. This folder's own file, with no
  // `--session`, continues below.
  const otherFile = args.values.file !== undefined && resolve(io.cwd, args.values.file) !== resolve(io.cwd, TEAM_FILE);
  const aimed = otherFile || args.values.session !== undefined;
  if (!mayLaunchSeats(walked) && aimed && verdict === null) {
    out.stderr(
      `team up: only the owner runs \`up\`, from a terminal outside herdr; this call is ${describeCaller(walked)}\n`,
    );
    // exit: up.not-owner
    return 1;
  }
  if (!mayLaunchSeats(walked) && aimed && verdict?.kind === 'refused') {
    out.stderr(`team up: ${verdict.text}\n`);
    // exit: up.delegate-flag
    return 1;
  }
  const caller = callerOf(io);
  // The file this run is whole on: the default one whenever the gate decided on it — a refused
  // run stops on the gate's words without reading a flagged target, a delegated one runs the
  // file its delegation was read from — and otherwise today's load, `--file` honoured exactly
  // as before.
  const loaded =
    delegateTeam ??
    (defaultLoad !== null && !args.values.file
      ? defaultLoad
      : loadTeamFile(io.cwd, { ...(args.values.file ? { file: args.values.file } : {}), home: sources.home }));
  if (!loaded.ok) {
    for (const problem of loaded.errors) {
      out.stderr(`team up: ${problem.line ? `line ${problem.line}: ` : ''}${plainText(problem.message)}\n`);
    }
    // exit: up.not-a-repo
    // exit: up.file
    // exit: up.file-invalid
    return 2;
  }
  const { team, root } = loaded;
  // The lobby this team operates on: its own when it sets `entity` or `lobby`, else the
  // machine-global one. Every lobby read and make below runs against it, so a second team on the
  // machine no longer waits behind the first team's lobby.
  const teamLobby = resolveLobby(sources.home, team);
  // Owner-only targets are honoured only when no gate decided: a delegated run is the default
  // file's own session, and a refused one never adopts the session its caller tried to name.
  const session = verdict === null ? (args.values.session ?? team.session) : team.session;
  const dir = dirname(loaded.path);
  let state = resolveState(sources, session);
  // A stopped session this team's state records is cleared under the run lock, then started.
  // The plan below is built as for an absent session. One the state does not record is refused,
  // and nothing here tells the caller to run a herdr command.
  let clearStopped = false;

  // One verified snapshot carries the whole command: the refusal when there is
  // one, and the ceilings the launch holds. A legacy or refused record is not
  // an approval in force, and says so in its own words. Read before the caller
  // gate so an out-of-band owner token can be matched against what `up` would launch.
  const standing = sources.standing?.(root) ?? approvalStanding(root, sources.home);
  // The out-of-band owner authorization: a non-owner caller is admitted as the owner for this one
  // launch when the token equals the fingerprint of the approved record `up` would launch — its
  // fingerprints and generation, recomputed now. Only when an approval is in force, and never on a
  // delegated run (the gate decides those). Downstream treats it as a no-terminal owner: it never
  // prompts, which is right for an agent with no terminal.
  const upFp =
    standing.kind === 'verified' ? upFingerprint(standing.record.approval.fingerprints, standing.generation) : undefined;
  const ownerToken =
    !mayLaunchSeats(caller) && verdict === null && upFp !== undefined && ownerAuthorized(io.env, upFp);

  // What would make `up` refuse. A dry run prints the plan anyway; a real run stops first.
  const refusals: string[] = [];
  if (!mayLaunchSeats(caller) && !ownerToken) {
    if (verdict === null) {
      refusals.push(
        `only the owner runs \`up\`, from a terminal outside herdr; this call is ${describeCaller(caller)}`,
      );
    } else if (verdict.kind === 'refused') {
      refusals.push(verdict.text);
    }
  }
  if (standing.kind !== 'verified') refusals.push(notInForce(standing));
  else {
    const differences = approvalDifferencesOf(standing, team);
    if (differences.length) {
      refusals.push(`the file is not the approved one (${differences.join('; ')}): run \`team approve\``);
    }
  }
  // The budget readings the gate refuses on are the approved ones: an unapproved lower reserve
  // unblocks nothing, not even the seat a dry run would plan.
  const budgets = budgetsInForceOf(standing, team);

  if (sources.doctor) {
    const findings = doctorFindings(team, root, dir, session, sources.doctor, loaded.warnings, standing);
    for (const finding of findings) if (blocksLaunch(finding)) refusals.push(finding.text);
  }
  const samples: SwapSample[] = [];
  const readAt = () => (sources.now?.() ?? new Date()).getTime();
  const crossed = (machine: Machine) => launchLimit(machine, team.machine, samples, readAt());
  const machine = sources.machine?.(root);
  if (machine) {
    const problem = crossed(machine);
    if (problem) {
      // The incident log: the refusal and the readings it was decided on, one line in the
      // project's own log, through the same sink every command logs through. It changes no
      // decision. Written only when this call is one that may run `up` — the refusals above
      // accumulate rather than return, so a caller the caller gate refused must leave every
      // file as it was — and not on a dry run, which decides nothing.
      if (!dry && (mayLaunchSeats(caller) || delegated !== null || ownerToken)) {
        logLine(dir, 'up', callerLabel(caller), `refused: ${problem} — readings: ${readingsText(machine)}`, sources.now?.() ?? new Date());
      }
      refusals.push(problem);
    }
  }

  if (state === null) refusals.push("herdr doesn't answer");
  if (state === 'stopped') {
    if (Object.hasOwn(readState(dir).sessions, session)) {
      clearStopped = true;
      state = 'absent';
    } else {
      refusals.push(`session ${session} is stopped`);
    }
  }
  const agents = state === 'running' ? sources.agents(session) : [];
  if (state === 'running') {
    const recorded = readState(dir).sessions[session]?.seats ?? {};
    if (agents === null) refusals.push(`session ${session} runs, and its agents can't be read`);
    else {
      // §5: a seat recorded waiting was left in its pane for the owner — by `add`, whose seat
      // was never renamed, so herdr lists its pane with no `name` field at all. That agent is
      // known by its pane, whatever its name is now: the resume path verifies pane and process
      // itself, and its prompt is the only way the owner can finish the seat.
      const waitingPanes = new Set(
        Object.values(recorded)
          .filter((seat) => seat.waiting)
          .map((seat) => seat.pane)
          .filter((pane) => pane !== undefined),
      );
      // A seat left at `launched` — a run stopped between "the pane exists" and "the seat has
      // its name" — is the run's own half-finished work, and herdr lists its agent with no name
      // (or another one) on the pane this state records. That pane is known the way the waiting
      // one is: the resume path verifies pane, process and rename before recording anything.
      // Only `launched` qualifies — a seat at `named` or `ready` has its name, so a foreign
      // agent on its pane is refused exactly as before, and so is any pane no record names.
      const launchedPanes = new Set(
        Object.values(recorded)
          .filter((seat) => seat.stage === 'launched')
          .map((seat) => seat.pane)
          .filter((pane) => pane !== undefined),
      );
      // A force-close — a non-owner's `remove` — leaves its seat's pane running and renames the
      // agent out of the seat's name (`<name>-left`, then `-left-2`, `-left-3`, …: remove.ts's
      // `leftName`). That base may no longer be a seat the file declares, so the family is read
      // off the name's shape alone (`leftoverName`, beside the mint), never off this file: a
      // leftover is skipped the way the two pane sets above are, left running and un-managed,
      // and every other unrecorded name still refuses below.
      const unknown = agents.filter(
        (agent) =>
          !(agent.name && Object.hasOwn(recorded, agent.name)) &&
          !(agent.name && leftoverName(agent.name)) &&
          !waitingPanes.has(agent.pane) &&
          !launchedPanes.has(agent.pane),
      );
      if (unknown.length) {
        refusals.push(
          `session ${session} has ${unknown.length} agent${unknown.length === 1 ? '' : 's'} this file's state doesn't record: \`up\` never touches a running team`,
        );
      }
    }
  }

  const lobby = teamLobby;
  if (!team.trust || team.trust.length === 0 || isLegacyTrust(team.trust)) {
    // The block names every entry the next `up` will require, computed from the file, so one
    // edit takes the file past validation. The same block is what `doctor` and `add` print.
    refusals.push(
      `the file is legacy: migrate trust to absolute paths including the lobby ${lobby}:\n${migrationText(team, root, sources.home)}`,
    );
  }

  const recorded = readState(dir).sessions[session];
  const workspaces = sources.workspaces?.(session) ?? null;
  // What each recorded seat's pane holds, read from its pane: what decides whether the seat is
  // still the seat, or whether it must be launched again. Only a running session has panes, and
  // a herdr that can't tell gives null — read exactly as a seat with no record.
  const processes: Record<string, PaneProcesses | null> = {};
  if (state === 'running' && sources.launch?.processInfo) {
    for (const [name, held] of Object.entries(recorded?.seats ?? {})) {
      // A pane with no recorded identity is read too: a bare shell is visible without one.
      // The close path still requires the identity; this reading only lets the plan say so.
      if (held.pane) processes[name] = sources.launch.processInfo(session, held.pane);
    }
  }
  const readings = loadReadings(dir);
  const spend = loadSpendReadings(dir);
  // What makes a standing that is not verified safe is not the defaults' own values —
  // `defaultBudgets` names no account, and `seatBudget` reads it `clear`: permissive as a
  // value. It is the ordering: the refusal above is carried into every exit below, and this
  // guard keeps the planning pass from consulting a budget at all, so an unapproved file
  // buys nothing from the budget, not even a mark in a dry run's plan.
  const budgetGate = sources.seatBudget ?? seatBudget;
  const budgetOf = (seat: (typeof team.seats)[number]) =>
    standing.kind === 'verified' ? budgetGate(budgets, readings, seat, readAt(), spend) : { kind: 'clear' as const };
  // One writer per run: a seat's provisional line on a terminal, its one final record either
  // way, and every other line of the run on stderr, after the record it belongs to. It exists
  // from here, before the planning pass, because the launch-line note is one of its detail lines.
  // It is handed the raw pair on purpose: the writer cleans its own fields and draws its own
  // `\r\x1b[K` on a TTY, and the cleaned pair would strip those bytes.
  const records = progressWriter({ stdout: io.stdout, stderr: io.stderr, isTTY: io.stdoutIsTTY ?? false });
  const seats: UpSeat[] = [];
  const refused = new Set<string>();
  for (const seat of team.seats) {
    const planned = seatPlan(
      standing,
      team,
      seat,
      recorded?.seats[seat.name],
      agents ?? [],
      workspaces,
      state === 'running',
      root,
      sources.home,
      processes,
      (pane) => sources.launch?.paneText(session, pane) ?? null,
      // A passed delegation is not the owner, pane or seat. Every other caller keeps today's
      // reading: anyone but a seat.
      delegated === null && caller.kind !== 'seat',
    );
    // A stopped seat, one without a profile, and one already ready are left out of the budget.
    // A seat resumed into a live workspace starts nowhere new, but its reading is still said.
    if (planned.unidentifiedHold || planned.stopped || !profileFor(seat.cli) || planned.stage === 'ready') {
      seats.push(planned);
      continue;
    }
    const placed = planned.stage === undefined || !planned.pane;
    // The seat's own launch line, checked where the seat starts: a `miss` leaves this seat out
    // before its workspace is made, and the other seats go on. A note is told, never refused —
    // once, on the terminal, and on stderr on a real run as `doctor` says it. A seat resumed
    // into an existing pane is checked where that pane runs, when the state records it
    // (`start_cwd`); without it the line is not checked at all — the file's folder is not
    // where that pane is, so refusing or passing on it would be a guess.
    const doctor = sources.doctor;
    const resumeCwd = recorded?.seats[seat.name]?.start_cwd;
    const line = doctor
      ? placed
        ? launchLineFinding(team, seat, root, { onPath: (binary) => doctor.onPath(binary), home: doctor.home })
        : typeof resumeCwd === 'string' && resumeCwd !== ''
          ? launchLineFinding(
              team,
              seat,
              root,
              { onPath: (binary) => doctor.onPath(binary), home: doctor.home },
              { cwd: resolve(root, resumeCwd), folder: resumeCwd },
            )
          : {
              level: 'note' as const,
              why: 'its launch line was not checked: the seat is resumed and its state records no start folder',
            }
      : null;
    // The note is the writer's detail line on a real run: one line, cleaned like a record's
    // fields, whatever the launch line's word holds. A dry run has no run, and its note goes to
    // stdout with the plan it belongs to.
    if (line?.level === 'note') {
      const note = `  note ${seat.name}: ${line.why}`;
      if (dry) out.stdout(`${plainLine(note)}\n`);
      else records.detail(note);
    }
    // The plan, the record and the log hold the reason in words (`record`); the full finding —
    // the start folder it names — rides along as the record's stderr detail only.
    const launchProblem =
      line?.level === 'miss'
        ? {
            launchProblem: line.record ?? line.why,
            ...(line.record ? { launchProblemDetail: line.why } : {}),
          }
        : {};
    if (!placed) {
      const budget = budgetOf(seat);
      seats.push({ ...planned, ...launchProblem, ...(budget.kind === 'clear' ? {} : { budget }) });
      continue;
    }
    const start = seatStart(team, seat, root, sources.home);
    if ('problem' in start) {
      if (!start.once || !refused.has(start.problem)) {
        refused.add(start.problem);
        refusals.push(start.problem);
      }
      continue;
    }
    const budget = budgetOf(seat);
    seats.push({
      ...planned,
      cwd: start.cwd,
      ...(start.lobby ? { lobby: true } : {}),
      ...launchProblem,
      ...(budget.kind === 'clear' ? {} : { budget }),
    });
  }
  let verifiedLobby: string | null = null;
  let lobbySeen: LobbySeen | null = null;
  let createLobby = false;
  // What the lobby may hold beside the seats: the `lobby_files` of every profile the tool
  // ships. The lobby is one folder per machine, shared by every team on it, so what it may
  // hold cannot depend on which seats this run starts nor on this team's file: a seat already
  // ready is planned without the lobby mark, and another team's CLI may hold the folder too
  // (`profiles/*.yaml`, the capture behind each entry).
  const declaredLobbyFiles = shippedLobbyFiles();
  if (isMigratedTrust(team.trust)) {
    const launching = seats.some((seat) => {
      if (seat.unidentifiedHold || seat.stopped || seat.launchProblem) return false;
      if (!profileFor(seat.cli)) return false;
      const fresh = seat.stage === undefined || !seat.pane || (seat.stage === 'launched' && !seat.agentLive);
      if (!fresh) return false;
      return seat.budget?.kind !== 'refuse';
    });
    // Read-only: a refusal stops the run before anything is made, and the run lock below is
    // held before the first write. A lobby that is simply absent is not a refusal here — the
    // creating pass runs under the lock (`createLobby`). Making it here, as this once did, is
    // the run's first filesystem effect outside the lock, and two fresh runs can both see the
    // lobby absent: the loser's mkdir meets the winner's component and `verifyLobby` turns the
    // EEXIST into a refusal the losing run never earned (`lobby/gate.ts`, the create branch).
    const gate = verifyLobby(sources.home, { create: false, getuid: sources.getuid, fs: sources.fs, files: declaredLobbyFiles, lobby: teamLobby });
    if (!gate.ok) refusals.push(gate.text);
    else if ('path' in gate) {
      verifiedLobby = gate.path;
      lobbySeen = { path: gate.path, dev: gate.dev, ino: gate.ino, files: gate.files };
      for (const seat of seats) if (seat.lobby) seat.cwd = gate.path;
    } else createLobby = !dry && launching;
  }
  const watch = recorded?.watch;
  const watchAlive = Boolean(watch && sources.alive?.(watch.pid));
  // The watchdog starts in `root` and runs `watch` with no `--file`. When that load would miss
  // this file, or read another one, the resolved path is recorded for the watchdog pane.
  const watchFile = watchWouldRead(root, loaded.path, sources.home) ? undefined : loaded.path;
  // Built where it is needed: on a dry run, just below, before anything is made; on a real run,
  // after the lock, so the lobby made there under it is already every lobby seat's `cwd`.
  const buildPlan = () => upPlan({
    root,
    session,
    // A stopped session this team records was marked absent above, and this plan starts it.
    // One that is still `stopped` here is not this team's: the refusal already stopped the run.
    sessionRunning: state === 'running' || state === 'stopped',
    seats,
    watchAlive,
    watchLine: (sources.watchCommand ?? watchCommand)(session),
    ...(watchFile ? { watchFile } : {}),
  });

  if (dry) {
    // The same cause can reach the list twice — the gate and `doctor` both read the
    // approval — so a refusal is said once. A refusal leaves through the real run's
    // return below, so the status and the exit id are that refusal's; the words stay these.
    for (const refusal of [...new Set(refusals)]) out.stdout(`! up would refuse: ${plainText(refusal)}\n`);
    out.stdout(plainText(formatPlan(buildPlan())));
  }
  if (refusals.length) {
    if (!dry) for (const refusal of [...new Set(refusals)]) out.stderr(`team up: ${plainText(refusal)}\n`);
    // exit: up.delegate
    // exit: up.delegate-approval
    // exit: up.delegate-approved-copy
    // exit: up.delegate-drift
    // exit: up.delegate-evidence
    // exit: up.delegate-placement
    // exit: up.delegate-command
    // exit: up.never-approved
    // exit: up.differs
    // exit: up.doctor
    // exit: up.machine
    // exit: up.herdr
    // exit: up.stopped
    // exit: up.agents
    // exit: up.unknown
    // exit: up.placement
    return 1;
  }
  if (dry) {
    // exit: up.dry-run
    return 0;
  }
  const launch = sources.launch;
  if (!launch) {
    out.stderr('team up: this call has no way to reach herdr\n');
    // exit: up.no-launch
    return 1;
  }

  // One session-mutating run at a time: from here the run has effects — the delegated audit line
  // below is a write — and two runs started in two terminals read the same state before either
  // records a pane, so they launch over each other (one sitting at a dialog while the other
  // reports). The lock is the session mutator lock shared with `add`, `down` and `remove`, which
  // take the same `.run` before their own first effect (`launch/run-lock.ts`). A dry run and a
  // refused run returned above and never take it, and a lock left by a killed run is taken over
  // by the next one (`launch/seat-lock.ts`).
  const runLock = acquireRunLock(dir, session);
  if ('held' in runLock) {
    out.stderr(`team up: ${plainText(runLockText(runLock.held, session, dir))}\n`);
    // exit: up.run-lock
    return 1;
  }
  try {
    // The audit line of a delegated run: the gate passed it and this run is about to have effects,
    // so the delegation is on the record before the first workspace is made. A dry run returned
    // above and writes nothing; a run that refused never got here.
    if (delegated !== null) (sources.logDelegated ?? logDelegated)(dir, delegated, 'up', sources.now?.());
    // Provenance for an owner-token launch: the caller that ran it, and that the owner authorized
    // it out of band for this approved record.
    if (ownerToken) logLine(dir, 'up', callerLabel(caller), 'owner-token-authorized', sources.now?.() ?? new Date());

    if (createLobby) {
      // The run's first write, under the lock: the lobby the read-only pass above found absent.
      // Serialised here, no competing mkdir can turn into this run's refusal, and this run's own
      // make cannot land on another run's — which is what the read-only pass exists for.
      const gate = verifyLobby(sources.home, { create: true, getuid: sources.getuid, fs: sources.fs, files: declaredLobbyFiles, lobby: teamLobby });
      if (!gate.ok) {
        out.stderr(`team up: ${plainText(gate.text)}\n`);
        // exit: up.lobby
        return 1;
      }
      if ('path' in gate) {
        verifiedLobby = gate.path;
        lobbySeen = { path: gate.path, dev: gate.dev, ino: gate.ino, files: gate.files };
        for (const seat of seats) if (seat.lobby) seat.cwd = gate.path;
      }
    }
    // A stopped session this team's state records is cleared here, under the run lock, before
    // the plan starts it. Herdr lists a stopped session until `session delete`; that delete
    // works once the session is stopped and refuses while it is running.
    if (clearStopped) {
      const cleared = await launch.deleteSession?.(session);
      if (!cleared) {
        out.stderr(`team up: ${plainText(`session ${session} is stopped and did not clear`)}\n`);
        // exit: up.clear
        return 1;
      }
    }
    // Built after the make above: the lobby it may have made is every lobby seat's `cwd`.
    const plan = buildPlan();

    // The ceilings the launch holds are the verified record's own, fixed at approval.
    const ceilings: Ceilings | null = standing.kind === 'verified' ? standing.record.approval.ceilings : null;
    const running: Running[] = [];
    if (agents) {
      const byName = new Map(team.seats.map((seat) => [seat.name, seat]));
      for (const agent of agents) {
        if (!agent.name) continue;
        const seat = byName.get(agent.name);
        const known = recorded?.seats[agent.name];
        if (!seat && !known) continue;
        const like = known?.temporary?.like;
        const vendor = seat?.vendor ?? (like ? byName.get(like)?.vendor : undefined) ?? 'unknown';
        running.push({ name: agent.name, vendor, temporary: Boolean(known?.temporary) });
      }
    }
    const now = () => sources.now?.() ?? launch.now();
    const host: Host = {
      startServer: launch.startServer,
      sessionUp: launch.sessionUp,
      createWorkspace: launch.createWorkspace,
      // The lobby is read again directly before each workspace this run makes in it, with nothing
      // in between (`execute.ts`). Null when it is still the folder the gate read and every file
      // it allowed still the file it read. The declared files travel with it, so the recheck
      // walks the same closed tree the gate did.
      confirmLobby() {
        return lobbySeen ? recheckLobby(sources.home, lobbySeen, { getuid: sources.getuid, fs: sources.fs, files: declaredLobbyFiles, lobby: teamLobby }) : null;
      },
      paneRun: launch.paneRun,
      ...(launch.reportDisplayAgent
        ? { reportDisplayAgent: (session: string, pane: string, text: string) => launch.reportDisplayAgent!(session, pane, text) }
        : {}),
      typeLine: () => false,
      deliverRules: async (session, pane, cli, file, seconds) => {
        // The rules go to the file first; nothing is typed until it holds them. The writer
        // builds the path itself, from the approval in force and the seat's name.
        const written = writeRulesFile(standing, file.seat, root, sources.home, file.text, rulesFileHash(file.text));
        if (!written.ok) return fileRefusalOf(written);
        // The plan already refused a path that can't be typed; this is the same check again, so a
        // path that reached this far by a caller's mistake is refused before anything is typed.
        if (!typeablePath(file.path)) {
          return { stop: 'path', typed: false, sent: false, kind: 'unknown' as const, row: null };
        }
        // The delivery reports why it stopped through this box; the caller turns the stopped
        // reading into the report, and a plain refusal stays `false`.
        const stopped: { why: Refusal | null } = { why: null };
        const delivered = await deliverRules(cli, file.line, seconds, {
          screen: () => launch.paneText(session, pane) ?? undefined,
          status: () => launch.agentStatus?.(session, pane) ?? null,
          type: (value) => launch.typeText?.(session, pane, value) ?? false,
          enter: () => launch.pressEnter?.(session, pane) ?? false,
          // The last look before Enter: the file, read without following a link, must still hold
          // the text whose hash the line names.
          file: () => rulesFileHolds(file.path, rulesFileHash(file.text)),
          foreground: () => launch.foreground(session, pane),
          report: (why) => { stopped.why = why; },
          now: () => now().getTime(),
          sleep: sources.sleep ?? launch.sleep,
        });
        return delivered === false && stopped.why !== null ? stopped.why : delivered;
      },
      renameAgent: launch.renameAgent,
      closeWorkspace: launch.closeWorkspace,
      stopSession: (session) => launch.stopSession?.(session) ?? false,
      kill: () => false,
      agentPanes: launch.agentPanes,
      agentList: launch.agents,
      // The session's workspaces with their labels now; the pause compares the label of the pane's
      // live workspace with the one this seat's launch gives (`pause.ts`, `waitingProblem`).
      workspaces: () => sources.workspaces?.(session) ?? null,
      seatStates: () => readState(dir).sessions[session]?.seats ?? null,
      workspacePanes: launch.workspacePanes ? (session, workspace) => launch.workspacePanes!(session, workspace) : undefined,
      classify: (name, pane, cli) => readScreen(cli, launch.paneText(name, pane) ?? undefined).kind,
      paneText: (session, pane) => launch.paneText(session, pane),
      shellBack: (session, pane) => launch.shellBack?.(session, pane) ?? null,
      processInfo: (session, pane) => launch.processInfo?.(session, pane) ?? null,
      sleep: sources.sleep ?? launch.sleep,
      now: () => now().getTime(),
      allow(name) {
        if (sources.machine) {
          const machine = sources.machine(root);
          const problem = crossed(machine);
          if (problem) {
            // The incident log, as at the gate above: this reading stops a launch, and it is
            // taken after the caller gate let the run through, so it is always the call's own.
            logLine(dir, 'up', callerLabel(caller), `refused: ${problem} — readings: ${readingsText(machine)}`, now());
            return problem;
          }
        }
        const seat = team.seats.find((item) => item.name === name);
        if (!seat || !ceilings) return null;
        return overCeiling(ceilings, running, seat);
      },
      record(name, patch) {
        let replaced: string | undefined;
        updateState(dir, (file) => {
          const current = (file.sessions[session] ??= emptySession());
          const prior = current.seats[name] ?? { stage: patch.stage };
          // The CLI the seat was launched with: `down` needs it when the file no longer names the seat.
          const cli = team.seats.find((seat) => seat.name === name)?.cli;
          let start_cwd = prior.start_cwd;
          if (!start_cwd && patch.createdWorkspace) {
            const planned = seats.find((item) => item.name === name);
            if (planned?.lobby) {
              if (verifiedLobby) start_cwd = verifiedLobby;
            } else if (planned?.cwd) {
              start_cwd = planned.cwd;
            }
          }
          // `waiting: null` removes the field alone; anything else written replaces it.
          const { waiting: written, ...rest } = patch;
          const seat: SeatState = { ...prior, ...rest, ...(cli ? { cli } : {}), ...(start_cwd ? { start_cwd } : {}) };
          if (written === null) delete seat.waiting;
          else if (written) seat.waiting = written;
          current.seats[name] = seat;
          if (patch.pane) {
            replaced = prior.pane !== patch.pane ? prior.pane : undefined;
            current.launched_file = loaded.path;
          }
        });
        if (patch.pane) {
          if (replaced) forgetLaunchedPane(sources.home, replaced);
          noteLaunchedPane(sources.home, loaded.path, patch.pane);
        }
      },
      running(name) {
        if (running.some((item) => item.name === name)) return;
        const seat = team.seats.find((item) => item.name === name);
        if (seat) running.push({ name, vendor: seat.vendor, temporary: false });
      },
      drop(name) {
        let pane: string | undefined;
        updateState(dir, (file) => {
          const seats = file.sessions[session]?.seats;
          pane = seats?.[name]?.pane;
          if (seats) delete seats[name];
        });
        if (pane) forgetLaunchedPane(sources.home, pane);
      },
      // What is not a record — a skip line, a session failure, the watch's sentence — is cleaned
      // here with the same function the records use: no escape sequence or bidi override reaches
      // the terminal from a file's word, a screen's word or a folder's name.
      say: (line) => out.stderr(plainText(line)),
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record) => records.final(seat, record),
      detail: (line) => records.detail(line),
      cliVersion(cli) {
        const profile = profileFor(cli);
        if (!profile || !sources.doctor) return null;
        return sources.doctor.version(profile.binary);
      },
      log: (who, what) => logLine(dir, 'up', callerLabel(caller), `${who}: ${what}`, now()),
      noteWatch(pane, file) {
        updateState(dir, (state) => {
          const current = (state.sessions[session] ??= emptySession());
          current.watchdog = { file, pane };
        });
      },
      /**
       * §3/§4: what happens to a seat this run finds at a dialog. The owner at a terminal is
       * asked, in `pause.ts`, with `o`/`s`/`q`; an owner whose stdin is not a terminal never
       * reads it — the workspace is closed without input and the record says so (§2). A delegated
       * run takes that no-terminal path whatever its stdin: it never prompts, never focuses a pane,
       * never sends a key or a text, and its idle wait's timeout is a dialog like any other stop —
       * closed without input, not left at launched.
       */
      dialog:
        delegated !== null
          ? { mode: 'close-no-terminal', timeoutIsDialog: true }
          : caller.kind === 'owner'
            ? { mode: 'prompt', run: (input: PauseInput) => runPause(input, pauseHostFor(input)) }
            : { mode: 'close-no-terminal' },
      clearWaiting(name) {
        updateState(dir, (file) => {
          const seatState = file.sessions[session]?.seats[name];
          if (seatState) delete seatState.waiting;
        });
      },
      seatLock: (name) => acquireSeatLock(dir, session, name),
    };

    // §2: the owner's terminal. Only a run that may prompt builds a reader, and a read only
    // happens from the pause's own key(): a caller whose stdin is not a terminal never gets here
    // (`dialog` is `close-no-terminal` for it), and a dry run returns before the host is built.
    const terminal = sources.terminal ? sources.terminal() : terminalReader(process.stdin, processSignals);
    const seatCli = (name: string) => team.seats.find((item) => item.name === name)?.cli ?? '';
    /** The pause's host for one seat: this run's state, seat lock, screen reads and writer. Every
     *  line it says goes through the writer, and nothing here sends a key or a text into a pane. */
    const pauseHostFor = (input: PauseInput): PauseHost => ({
      lock: () => acquireSeatLock(dir, session, input.seat),
      state: () => readState(dir).sessions[session]?.seats[input.seat],
      write(change) {
        updateState(dir, (file) => {
          const current = (file.sessions[session] ??= emptySession());
          const prior = current.seats[input.seat] ?? { stage: 'launched' as const };
          const record = change(prior.waiting);
          // The process identity is read here, at the moment the record is written, in the same
          // write: `[o]`, `[s]`, a resumed `up` and `team answer` all refuse a pane whose
          // process is gone or replaced.
          const identity = launchedIdentity(launch.processInfo?.(session, input.pane) ?? null);
          current.seats[input.seat] = {
            ...prior,
            waiting: record,
            pane: input.pane,
            ...(input.workspace ? { workspace: input.workspace } : {}),
            ...(identity ? { launched: identity } : {}),
          };
        });
      },
      clear() {
        updateState(dir, (file) => {
          const seatState = file.sessions[session]?.seats[input.seat];
          if (seatState) delete seatState.waiting;
        });
      },
      drop: () => host.drop(input.seat),
      screen: () => {
        const kind = readScreen(seatCli(input.seat), launch.paneText(session, input.pane) ?? undefined).kind;
        return kind === 'idle' || kind === 'working' ? kind : classificationOf(kind);
      },
      process: () => launch.processInfo?.(session, input.pane) ?? null,
      agents: () => launch.agents(session),
      workspaces: () => sources.workspaces?.(session) ?? null,
      workspacePanes: (workspace) => launch.workspacePanes?.(session, workspace) ?? null,
      seats: () => readState(dir).sessions[session]?.seats ?? null,
      focus: () => launch.focus?.(session, input.pane) ?? false,
      close: (workspace) => launch.closeWorkspace(session, workspace),
      record: (label) => records.waiting(input.seat, label),
      prompt: (line) => records.prompt(line),
      drain: () => terminal.drain(),
      // A line beside the record: the writer owns the line's termination, and the cleaning of
      // every string it writes once the records slice's round lands.
      say: (line) => records.prompt(line.endsWith('\n') ? line.slice(0, -1) : line),
      entering: (classification) => host.log(input.seat, recordWhat({ kind: 'waiting for owner', classification })),
      key: (ms) => terminal.key(ms),
      sleep: (ms) => (sources.sleep ?? launch.sleep)(ms),
      now: () => now().getTime(),
      idleTimeout: profileFor(seatCli(input.seat))?.idleTimeout ?? 90,
      polled: trustPolicy(team) === 'coordinator' && input.classification === 'trust',
    });

    const report = await executePlan(plan, session, host);
    // The reach projection, after the plan's effects and outside the lobby's identity rechecks
    // (its temporary is a declared lobby file): the owner-approved `reach` grants written where
    // the bridge and the seat-shuttle daemon read them. A skip — no lobby, a lobby not 0700,
    // nothing changed — is a log line, never a refusal: the launch is done.
    const projectionNote = reachProjectionNote(writeReachProjection(team, sources.home));
    if (projectionNote) logLine(dir, 'up', callerLabel(caller), projectionNote, now());
    const afterwards = readState(dir).sessions[session]?.seats ?? {};
    const pending = team.seats.filter((seat) => {
      if (seat.stopped || !profileFor(seat.cli)) return false;
      return afterwards[seat.name]?.stage !== 'ready';
    });
    // A seat the plan left behind (a repair it would not close, a dialog it timed out at) is a
    // seat left short of ready even when its state still says ready: `held` makes that exit 1.
    // exit: up.ready
    // exit: up.pending
    // exit: up.server
    // exit: up.watch
    return pending.length || report.serverFailed || report.watchFailed || report.held ? 1 : 0;
  } finally {
    runLock.release();
  }
}
