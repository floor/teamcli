import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetsInForceOf, ceilingsOf, notInForce, watchInForceOf } from '../approve/approval.ts';
import { KEY_ISOLATION_LINE, activeClientUpGrant, withClientGrantLock, type ClientUpGrantRecord } from '../client/records.ts';
import { verifyClientUp } from '../client/up-grant.ts';
import { admitGeneral } from '../client/general-grant.ts';
import { ownerAuthorized, upFingerprint } from '../approve/owner-token.ts';
import { ownerSeatRuleAdmits, ownerSeatStep } from '../client/owner-action-step.ts';
import { spawnInheritedBus } from '../bus/supervise.ts';
import type { OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { readArgs, type Args } from '../args.ts';
import { callerLabel, callerOf, describeCaller, detachedRefusal, judgeCallerIn, mayLaunchSeats, standingOf, walkCaller, type Caller, type SeatStanding } from '../caller.ts';
import { daemonHealth, type DaemonHealth } from '../daemon/health.ts';
import { delegateGate, delegateNamedFor, logDelegated } from '../delegate.ts';
import { devModeCallerGate, devModeExpiryLine, devModeExpiryNote, devModeMark, logDevMode, logDevModeState, resolveDevMode } from '../dev_mode.ts';
import { entityGrantAdmits, grantGate, logGranted } from '../grant.ts';
import { dialogsTrustInForce } from '../permissions/dialogs-trust.ts';
import { gateVerdict } from '../permissions/who.ts';
import { TEAM_FILE } from '../file/load.ts';
import { leftoverNote, readTeamConfig } from '../file/team-config.ts';
import { importForUp } from '../file/team-import.ts';
import { derivedTrust, migrationText } from '../file/migrate.ts';
import { insideTrust, isLegacyTrust, isMigratedTrust } from '../file/paths.ts';
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
  workspaceRename,
  paneShellBack,
  sessionDelete,
  sessionStop,
  typeText,
  pressEnter,
  sendKey,
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
import { installCliHooks, plannedCliHooks, resetCliHookState, restorePresenceBinding } from '../launch/cli-hook.ts';
import { executePlan, restoreSummaryOf, type Report, type RestoreSweepSummary } from '../launch/execute.ts';
import type { EndpointStopRead, ManagedEndpointRead } from '../launch/codex-endpoint.ts';
import { ensureCodexEndpoint, stopSeatCodexEndpoint } from '../launch/codex-endpoint.ts';
import { currentBriefClaim, currentBriefEpochs, deliverBriefForAttribution, GENERAL_BRIEF_SHA256, walkBriefDeliveries } from '../launch/general-brief.ts';
import { launchedIdentity, paneHoldsShell, replacedSeat, seatProcessVerdict } from '../launch/identity.ts';
import { launchLineFinding } from '../launch/line.ts';
import { launchRefusal, readEntityModelRule, type EntityModelRule } from '../launch/model-guard.ts';
import { charterGate } from '../charter/check.ts';
import { charterFolderPretrust, grantedFolderPretrust, lobbyPretrustLine, projectRootPretrust } from '../launch/pretrust.ts';
import { formatPlan, upPlan, type UpSeat } from '../launch/plan.ts';
import { runPause, type PauseHost, type PauseInput } from '../launch/pause.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { unreadIdle } from '../launch/unread.ts';
import { recordWhat, progressWriter, classificationOf } from '../launch/progress.ts';
import { acquireRunLock, runLockText } from '../launch/run-lock.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { processSignals, terminalReader, type Terminal } from '../launch/terminal.ts';
import { rulesOf, rulesOriginOf, type RulesOrigin } from '../launch/rules.ts';
import { quietRulesDelivery, rulesFileHash, rulesFileHolds, seatDeliveryOf, typeablePath, writeRulesFile } from '../launch/rules-file.ts';
import { deliverRules, fileRefusalOf, type Refusal } from '../launch/deliver.ts';
import { recheckLobby, verifyLobby, type FsReader, type LobbySeen } from '../lobby/gate.ts';
import { lobbyOf } from '../lobby/recorded.ts';
import { logLine } from '../log.ts';
import { hasJsonFlag, planStepsOf, refuse, writeJson, type PlanStep } from '../output/index.ts';
import { namedResumeTarget, resumeCarry, shellQuote } from '../profiles/profile.ts';
import { profileFor, shippedStartupReads } from '../profiles/index.ts';
import { reachProjectionNote, writeReachProjection } from '../reach/projection.ts';
import { registerRun } from '../registry/sync.ts';
import { beginSession } from '../sessions/registry.ts';
import { findAgent } from '../registry/agents.ts';
import { continuityIdOf, continuityIdsOf, recordedSeatContinuity, recordedSeatSession } from '../registry/resume.ts';
import { teamIdOf } from '../registry/teams.ts';
import { senderNameModeFor, sessionDisplayName } from '../send/names.ts';
import { refreshAgentAddress } from '../send/address.ts';
import { approvalStanding, type Ceilings, type Standing } from '../store/store.ts';
import { forgetLaunchedPane, noteLaunchedPane } from '../file/launched-file.ts';
import { emptySession, liveHold, mintSeatId, pidAlive, readState, seatOfFile, updateState, type SeatState, type WaitingRecord } from '../state.ts';
import { seatBudget } from '../budgets/gate.ts';
import { loadReadings, loadSpendReadings } from '../budgets/readings.ts';
import { blocksLaunch, doctorFindings, realSources as doctorSources, type DoctorSources } from './doctor.ts';
import { leftoverName } from './remove.ts';
import { launchConcurrency, launchLimit, readMachine, readingsText, type Machine, type SwapSample } from '../watch/machine.ts';
import { canShowModel, modelDiffers, runningModel, seatModel } from '../status/statusline.ts';
import { watchSitting } from '../watch/liveness.ts';
import { busLabel, watchIdentity, watchLabel } from '../watch/pane.ts';
import { busAnswers } from '../bus/follow.ts';
import { readScreen } from '../watch/screen.ts';
import { seatStart } from '../worktree/place.ts';
import { registerInbox, type InboxRegistration } from '../mcp/register.ts';
import { expiryPhrase } from '../client/duration-policy.ts';

// What `up` reads from outside the file, so tests can stand in for it.
export type UpSources = {
  /** The credential store an owner-seat answer's signer key is confirmed against. Absent: the system one. */
  ownerSeatStore?: OwnerSeatKeyStore;
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
  /** Whether this checkout's event bus answers on its socket. Absent: no bus step is planned, so a
   *  world that does not probe it never starts one. */
  busAlive?(root: string): Promise<boolean>;
  busCommand?(): string;
  /** The machine daemon's reading, for the hosted watch that may own this team's route. Absent in
   *  a world that does not probe it, and then no pane watch is suppressed by a hosted one. */
  daemonHealth?(home: string): Promise<DaemonHealth>;
  // The owner's terminal, for the pause at a dialog. Absent: Node's own stdin, read in raw
  // mode for one key at a time (`terminal.ts`). A dry run and a caller without a terminal
  // never read it.
  terminal?(): Terminal;
  /** Present on the shipped command. A test leaves it unset, so `up` never spawns a bus there. */
  superviseBus?: boolean;
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
  // The grant gate, overridable the same way. Absent: the real gate. The audit line of a
  // granted run, overridable the same way.
  grantGate?: typeof grantGate;
  logGranted?: typeof logGranted;
  // Present on the shipped command. A dry run never calls it.
  launch?: Launch;
};

export type Launch = {
  sessionState(session: string): SessionState | null;
  startServer(session: string): boolean;
  sessionUp(session: string): boolean | null;
  createWorkspace(session: string, cwd: string, label: string): { pane: string; workspace: string } | null;
  paneRun(session: string, pane: string, command: string): boolean;
  /** Registers the seat's team inbox with its CLI, in the seat's folder, before its launch
   *  command. `teamFile` is the team file the run read; the seat's folder may be a lobby with
   *  none. Null when the profile carries no file route; a refusal leaves the seat on its drop
   *  and typed legs. Absent on a world that registers nothing: fake launches and reads. */
  registerInbox?(cli: string, seat: string, cwd: string, teamFile?: string): InboxRegistration | null;
  /** Starts and stops the managed Codex app-server endpoint a launch owns. Present on the shipped
   *  launch surface; a fake launch that omits it plans no endpoint, so no scene reaches a real
   *  process. */
  codexEndpoint?: {
    managed(input: { dir: string; session: string; seat: string; cwd?: string }): Promise<ManagedEndpointRead>;
    stop(input: { dir: string; session: string; seat: string }): EndpointStopRead;
  };
  /** Sets the pane's display_agent after launch. False is one line and does not leave the seat out. */
  reportDisplayAgent?(session: string, pane: string, text: string): boolean;
  /** Sets the workspace title of a seat already running. False is one line and does not leave it out. */
  renameWorkspace?(session: string, workspace: string, label: string): boolean;
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
  /** The profile's one clearing key. Absent: a failed rules read-back leaves the line. */
  sendKey?(session: string, pane: string, key: string): boolean;
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
  /** Stops a process this run is replacing: the stale pane watch the plan kills before it starts
   *  the replacement. Absent on a fake launch, which then cannot repair a live stale watch. */
  kill?(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

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
  const found = readTeamConfig(start, home ? { home } : {});
  return found.ok && sameFile(found.path, flagged);
}

/** The watchdog command, from this process and this install: `team` may not be on the PATH. */
/** The bus command, from this process and this install, as the watch's is. */
export function busCommand(): string {
  const here = fileURLToPath(import.meta.url);
  const cli = join(dirname(here), '..', here.endsWith('.ts') ? 'cli.ts' : 'cli.js');
  return `${shellQuote(process.execPath)} ${shellQuote(cli)} bus`;
}

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
  registerInbox: (cli, seat, cwd, teamFile) =>
    registerInbox({ cli, seat, cwd, ...(teamFile === undefined ? {} : { file: teamFile }) }),
  codexEndpoint: {
    managed: (input) => ensureCodexEndpoint(input),
    stop: (input) => stopSeatCodexEndpoint(input),
  },
  reportDisplayAgent: (session, pane, text) => reportDisplayAgent(pane, text, aim(session)),
  renameWorkspace: (session, workspace, label) => workspaceRename(workspace, label, aim(session)),
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
  sendKey: (session, pane, key) => sendKey(pane, key, aim(session)),
  agentStatus: (session, pane) => agentStatus(pane, aim(session)),
  foreground: (session, pane) => paneForeground(pane, aim(session)),
  shellBack: (session, pane) => paneShellBack(pane, aim(session)),
  processInfo: (session, pane) => paneProcesses(pane, aim(session)),
  focus: (session, pane) => focusAgent(pane, aim(session)),
  stopSession: (session) => sessionStop(session),
  deleteSession: sessionDelete,
  kill(pid) {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch (error) {
      // A process that died on its own between the reading and this call is already the
      // outcome the caller wanted; only a refusal that leaves it running is a failure.
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  },
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
  busAlive: (root) => busAnswers(root),
  busCommand,
  daemonHealth: (home) => daemonHealth(home),
  launch: realLaunch,
  /** Present on the shipped command only: a dead bus is started in its own process before launch. */
  superviseBus: true,
};

/** The reason the hold `up --no-launch` places carries. */
export const QUIET_HOLD_REASON = 'quiet start (team up --no-launch): the watch wakes no seat; release with team hold --release';

export const USAGE = 'Usage: team up [--dry-run] [--serial] [--no-launch] [--session <name>] [--file <path>] [--json]\n       team up --client <grant-file> --key <client-key> [--team <team>] [--dry-run] [--serial] [--no-launch] [--json]\n       team up --general <grant.json> --key <client-key> [--dry-run] [--serial] [--no-launch] [--json]\n       team up --request [--serial] [--json]\n       team up --approval <request-id> [--dry-run] [--serial] [--json]\n\n--no-launch is a quiet start: the seats get their rules only, told not to continue earlier work or read drops; no general seat brief (the launch message) is dropped or typed, and a team hold stops the watch typing anything automatic until team hold --release.\n\nThe owner-seat form needs no owner terminal: --request records this launch (repository, team, HEAD, arguments; fifteen minutes) and sends it to the owner seat, where the owner answers on the owner page with a passkey or Touch ID; --approval <request-id> then runs it, once, as signed. A signed always rule for team-up covering this folder admits the run with no request. team init --request --then-up asks for the team and its first launch in one request.\n\nThe --client form is for a client with no terminal that the owner signed an up grant for (team grant --client <id> --entity <entity> --public-key <file> --team <team> --up --request): it brings up that one team at that one folder, as signed, and nothing else.\n\nExits 0 when the team is ready or the dry-run plan is printed, 1 when launch is refused or fails, 2 when the invocation or team file can\'t be read.\n';

export const up: Command = (argv, io) => runUp(argv, io, realSources);
export default up;

/** The invocation problems the client form owns, or null: it takes its grant and its key together,
 *  never the owner's `--file` or `--session`, and `--team` only names the team the grant is for. */
function clientInvocationProblem(args: Args): string | null {
  const client = args.values.client !== undefined;
  if (client && args.values.key === undefined) return '--client needs --key <client-key-file>';
  if (args.values.general !== undefined) return client || args.values.key === undefined ? '--general takes --key <client-key-file> and no --client' : null;
  if (!client && args.values.key !== undefined) return '--key belongs to the --client form: team up --client <grant-file> --key <client-key-file>';
  if (!client && args.values.team !== undefined) return '--team belongs to the --client form: team up --client <grant-file> --key <client-key-file> --team <team>';
  if (client && (args.values.file !== undefined || args.values.session !== undefined)) {
    return '--client runs the one team its grant names: --file and --session are the owner\'s and take no --client';
  }
  return null;
}

/** A client-form refusal: the sentence, then the exit. The grant verified or it did not; nothing ran. */
function clientRefused(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'up', { id: 'up.client-refused', message: plainText(message), repair: null });
  // exit: up.client-refused
  return 1;
}

/** One refusal this run carries to its single exit site: its contract row, the sentence, and
 *  the repair when one is known. */
type UpRefusal = { id: string; message: string; repair?: string | null };

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
  if (count > ceilings.seats) return `the file allows ${ceilings.seats} seats; ${count} would be running`;
  const cap = ceilings.vendors[seat.vendor];
  if (cap !== undefined) {
    const vendors = running.filter((item) => item.vendor === seat.vendor).length + 1;
    if (vendors > cap) return `the file allows ${cap} ${seat.vendor} seats; ${vendors} would be running`;
  }
  return null;
}

/** The refusal a proven conversation gets when the line the repair would actually run cannot
 *  carry it — the record's own launch where there is one, the declared line otherwise. The
 *  repair is not attempted, because its close would destroy a conversation the launch cannot
 *  put back. A line naming another id, or resuming without naming one, is never rewritten; a
 *  fresh start there is the caller's own edit of the launch line, not `--abandon`, which would
 *  run the same selection. */
function uncarryableResume(seat: { name: string; cli: string; launch: string }, session: string): string | undefined {
  const carried = resumeCarry(seat.cli, seat.launch, session);
  if (carried.kind !== 'refuse') return undefined;
  const way = namedResumeTarget(seat.cli, seat.launch) !== null
    ? 'its launch line names a conversation of its own: clear that selection from its launch line for a fresh start'
    : `team restart ${seat.name} --abandon for a fresh start`;
  return `its recorded conversation cannot be resumed: ${carried.why}; left as it is (${way})`;
}

/** What a caller is told when a drifted seat is working and this `up` will not close it. */
function driftWay(owner: boolean, name: string): string {
  return owner
    ? `team remove ${name} --abandon`
    : 'run this again once herdr reports the seat idle or done';
}

// A ready seat whose process is still the one team launched. `skip` is today's ready line.
// `hold` is a drift this run will not close (a running turn). `cycle` closes without input
// and launches the file's line. `refuse` is a drift this run must not close even at a free
// prompt: a lead seat, or the seat this run is inside. A screen that names no model is never
// cycled: unread is not a difference.
function modelDrift(
  team: TeamFile,
  seat: Seat,
  recorded: SeatState,
  agents: readonly HerdrAgent[],
  processes: Readonly<Record<string, PaneProcesses | null>>,
  screenOf: (pane: string) => string | null,
  owner: boolean,
  expected: { model: string; version: string } = seat,
  restored = false,
  /** The seat this run is running inside, when it is one: its pane is never closed here. */
  callerSeat: string | null = null,
): { kind: 'skip' } | { kind: 'hold'; detail: string } | { kind: 'cycle'; way: string } | { kind: 'refuse'; detail: string } {
  if (!recorded.launched || !recorded.pane || !recorded.workspace || !seat.version) return { kind: 'skip' };
  if (!restored && seatProcessVerdict(recorded.launched, processes[seat.name] ?? null) !== 'same') return { kind: 'skip' };
  const listed = agents.find((agent) => agent.pane === recorded.pane);
  if (!listed || listed.name !== seat.name) return { kind: 'skip' };
  const text = screenOf(recorded.pane);
  if (text == null || text === '') return { kind: 'skip' };
  // Registry signing governs even a model that the team file says a different CLI hosts (for
  // example DeepSeek via Claude Code). `seatModel` intentionally hides that case for legacy
  // team-file comparisons; the signed registry comparison must read the CLI's status directly.
  const running = expected === seat ? seatModel(seat, text) : runningModel(seat.cli, text);
  if (!running || !modelDiffers(running, expected)) return { kind: 'skip' };
  const kind = readScreen(seat.cli, text).kind;
  const way = driftWay(owner, seat.name);
  // Herdr's word and the screen: either one saying the seat is mid-turn keeps the pane.
  if (listed.status === 'working' || kind === 'working') return { kind: 'hold', detail: `its model drifted; left as it is (${way})` };
  // A difference proven on a seat this run must never close. Its own seat first: closing the
  // pane this command is running inside would kill the run. A lead next: its repair is the
  // whole team's, in the file's own words. Both are refused, not skipped, so the sweep reports
  // them and exits 1 without touching the pane.
  if (callerSeat !== null && seat.name === callerSeat) {
    return { kind: 'refuse', detail: 'its model drifted; this run is inside its pane and cannot close itself (run team up from outside this pane)' };
  }
  if (isLeadSeat(team, seat.name)) {
    return { kind: 'refuse', detail: `its model drifted; lead seat is not cycled in place (${relaunchRepair(team, seat.name, 'plain')})` };
  }
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
/** The refusal a replaced pane already had when its screen is working or unsent.
 *  Null when the screen is free or was not read: that seat is left with the cannot-tie line.
 *  `working` separates a running turn — left to finish, reported as skipped working — from a
 *  box holding unsent text, which is a refusal. */
function replacedScreenRefusal(
  seat: Seat,
  pane: string,
  screenOf: (pane: string) => string | null,
  status: string | undefined,
): { why: string; working: boolean } | null {
  const text = screenOf(pane);
  if (text == null || text === '') return null;
  const kind = readScreen(seat.cli, text).kind;
  if (status === 'working' || kind === 'working') {
    return {
      why: `the process in its pane is working; nothing closed (stop it there, or run team remove ${seat.name})`,
      working: true,
    };
  }
  if (kind === 'unsent') {
    return {
      why: `the process in its pane holds unsent text; nothing closed (send or clear it there, or run team remove ${seat.name})`,
      working: false,
    };
  }
  return null;
}

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

/** The seat as this run launches it: the file's own role, vendor, CLI and capabilities, with the
 *  bound record's model, version and base launch recipe substituted where the plan resolved one.
 *  `planned` comes from the UpSeat this run already resolved, so it carries the bound policy when
 *  the binding was valid and the declaration otherwise; no registry is read again here. */
function effectiveSeatOf(seat: Seat, planned: UpSeat | undefined): Seat {
  if (planned === undefined) return seat;
  return {
    ...seat,
    launch: planned.launch,
    model: planned.model ?? seat.model,
    version: planned.version ?? seat.version,
  };
}

function seatPlan(
  standing: Standing,
  team: TeamFile,
  seat: Seat,
  recorded: SeatState | undefined,
  agents: readonly HerdrAgent[] | null,
  workspaces: HerdrWorkspace[] | null,
  resume: boolean,
  root: string,
  home: string,
  /** The session this run addresses: the lobby the seat is told to move into is that session's. */
  session: string,
  processes: Readonly<Record<string, PaneProcesses | null>> = {},
  /** Pane readings for a ready seat the host moved: the pane naming it, tied to its recorded
   *  conversation. Only read when the recorded pane holds no process at all. */
  movedProcesses: Readonly<Record<string, PaneProcesses | null>> = {},
  screenOf: (pane: string) => string | null = () => null,
  owner = true,
  /** Dev-mode mount: a message seat's rules come from the live file, with no approval in force. */
  liveRules = false,
  /** The seat this run is running inside, when it is one: its drift is refused, never closed. */
  callerSeat: string | null = null,
  /** Registry wording when this run read the registry; file wording for a real team.yaml. */
  origin: RulesOrigin = 'file',
): UpSeat {
  const binding = recorded
    ? recordedSeatSession({ home, root, herdrSession: session, seat, state: recorded })
    : { kind: 'none' as const, why: 'no state record' };
  // The registry's own binding, for recognition and for the recipe a relaunch runs: a state
  // copy that names no session does not withhold it, so a restored seat a CLI without a resume
  // flag left behind is still proven by the record. The resume id above stays the one the
  // state agrees with; this read never resumes by itself.
  const bound = recorded
    ? recordedSeatContinuity({ home, root, herdrSession: session, seat, state: recorded })
    : { kind: 'none' as const, why: 'no state record' };
  const registry = bound.kind === 'bound' && bound.recorded.launch && bound.recorded.model && bound.recorded.version
    ? bound.recorded as typeof bound.recorded & { launch: string; model: string; version: string }
    : undefined;
  const continuitySession = continuityIdOf(bound, recorded);
  const resumeSession = binding.kind === 'bound' ? binding.recorded.sessionId : undefined;
  const planned: UpSeat = {
    name: seat.name,
    cli: seat.cli,
    launch: registry?.launch ?? seat.launch,
    cwd: seat.cwd,
    label: workspaceLabel(seat),
    displayAgent: displayAgent(seat),
    model: registry?.model ?? seat.model,
    version: registry?.version ?? seat.version,
    // `sessionId` is the resume id, and only the state-agreeing reader offers one: a restored
    // seat's record can prove the pane without the launch line resuming anything.
    ...(registry ? { registry: { launch: registry.launch, model: registry.model, version: registry.version, ...(resumeSession === undefined ? {} : { sessionId: resumeSession }) } } : {}),
    ...(seat.effort ? { effort: seat.effort } : {}),
    // The team file's own repair for this seat — a lead seat is told only the whole-team
    // sequence, never a `remove --keep` its file refuses (`lead.ts`).
    repairLine: relaunchRepair(team, seat.name, 'markdown'),
    stopped: seat.stopped,
    // A human's pane: no launch, no key, no line. The plan skips it before any of that.
    ...(seat.human ? { human: true as const } : {}),
    // An option seat's launch line and a message seat's rules file both come from the live
    // file. A stored copy is not the text a seat is told to obey.
    rules: rulesOf(team, seat, root, undefined, origin),
    sessionName: sessionDisplayName({
      seat: seat.name,
      nickname: seat.nickname ?? null,
      team: teamIdOf(root),
      teamName: team.project,
      mode: senderNameModeFor({ home, root, seat: seat.name, file: team }),
    }),
    ...seatDeliveryOf(standing, team, seat, root, home, liveRules, origin),
  };
  const known = agents ?? [];
  const asked = agents !== null;
  if (!resume || !recorded || seat.stopped) return planned;
  // §5: a seat recorded waiting takes precedence over everything below. Its recorded pane is
  // reused while the host still lists it and the process there is still the one this run
  // launched: the pause reads it fresh and verifies it before doing anything. A process that
  // is gone or has been replaced is not that seat — a fresh workspace is made, and the old
  // pane is left, not closed and not typed into. A pane the host no longer lists is the same
  // fresh workspace, and a workspace the host still lists is named and left. An unreadable
  // process stays fail-closed, so the pane is not duplicated.
  if (recorded.waiting) {
    // A waiting record whose process is gone or has been replaced is not that seat any more.
    // A later `up` must not stay blocked on it, and must not close the old pane or type into it:
    // a new workspace is made and the old one is left. `same` still resumes the wait. `unknown`
    // stays fail-closed, so an unreadable pane is not duplicated.
    const reading = Object.hasOwn(processes, seat.name) ? processes[seat.name] : undefined;
    if (recorded.launched && recorded.pane && reading !== undefined) {
      const waitingVerdict = seatProcessVerdict(recorded.launched, reading);
      if (waitingVerdict === 'gone' || waitingVerdict === 'replaced') {
        const leftWorkspace = recorded.workspace !== undefined && workspaces?.some((item) => item.id === recorded.workspace)
          ? recorded.workspace
          : undefined;
        return { ...planned, replacedPane: recorded.pane, ...(leftWorkspace ? { leftWorkspace } : {}) };
      }
    }
    const named = known.filter((agent) => agent.name === seat.name);
    const paneListed = recorded.pane !== undefined && known.some((agent) => agent.pane === recorded.pane);
    if (named.length === 0 && recorded.pane && !paneListed) {
      // The old workspace stays when the host still lists it. A listed workspace still holds
      // a pane — herdr closes a workspace with its last pane — so it is named, not closed.
      const leftWorkspace = recorded.workspace !== undefined
        && workspaces?.some((item) => item.id === recorded.workspace)
        ? recorded.workspace
        : undefined;
      return { ...planned, replacedPane: recorded.pane, ...(leftWorkspace ? { leftWorkspace } : {}) };
    }
    // A seat waiting for trust is found by its recorded pane even before herdr names it; the
    // pause verifies the pane, workspace label and process before finishing it.
    const onRecorded =
      recorded.waiting.classification === 'trust' && recorded.pane !== undefined && named.length <= 1
        ? known.find((agent) => agent.pane === recorded.pane && (agent.name === null || agent.name === seat.name))
        : undefined;
    const live = onRecorded ?? (named.length === 1 ? named[0] : undefined);
    return {
      ...planned,
      ...(recorded.stage ? { stage: recorded.stage } : {}),
      ...(live ? { pane: live.pane, workspace: live.workspace ?? recorded.workspace } : {}),
      waiting: recorded.waiting,
      ...(recorded.launched ? { waitingLaunched: recorded.launched } : {}),
      ...(live ? {} : { resumeGap: named.length === 0 ? 'none' as const : 'many' as const }),
    };
  }
  // A record with no process identity cannot prove its pane. A bare shell or another model is
  // reported, with the repair that works, and is not closed and not launched again.
  const hold = unidentifiedHold(team, seat, recorded, processes, screenOf);
  if (hold) return { ...planned, stage: recorded.stage, unidentifiedHold: hold };
  // The host can bring a restored seat back on another pane. Its recorded pane is gone, so the
  // recorded process identity proves nothing; the pane the host names for the seat is the seat
  // only while its live agent session is the recorded conversation itself. A pane that cannot be
  // tied that way, or a name the host lists twice, is a doubt: nothing is closed and nothing is
  // launched. Proven, the record moves to that pane: a free drifted model is repaired there, a
  // running one is left, a matching one is adopted with the pids the pane holds now.
  // A pane the host no longer lists is missing only when nothing runs on it: a live process on
  // the recorded pane (listed or not) is the doubt below, never a replacement.
  const paneListed = recorded.pane !== undefined && known.some((agent) => agent.pane === recorded.pane);
  const recordedGone = !paneListed
    && Object.hasOwn(processes, seat.name)
    && (processes[seat.name] ?? null) === null;
  const moved = asked && recordedGone && recorded.stage === 'ready' && recorded.launched && recorded.pane !== undefined && recorded.workspace !== undefined
    ? { pane: recorded.pane, workspace: recorded.workspace, named: known.filter((agent) => agent.name === seat.name) }
    : null;
  if (moved !== null) {
    const { pane: movedPane, workspace: movedWorkspace, named } = moved;
    const next = launchedIdentity(movedProcesses[seat.name] ?? null);
    const working = (agent: HerdrAgent): boolean => {
      if (agent.status === 'working') return true;
      const text = screenOf(agent.pane);
      return text != null && text !== '' && readScreen(seat.cli, text).kind === 'working';
    };
    if (named.length === 0) {
      // The pane is gone and no name survived. A recorded conversation is resumed on a fresh
      // pane when the launch line can carry it — never replaced by a blank one — and the
      // replaced pane is named only on that path: a record with no conversation to protect
      // takes the ordinary fresh launch, with no notice about a pane nothing was resumed from.
      // A line that cannot carry the conversation stops before anything is launched, and the
      // recorded workspace, when the host still lists it, is named and left.
      if (continuitySession === null) return planned;
      const resumeHold = uncarryableResume(planned, continuitySession);
      if (resumeHold) return { ...planned, stage: 'ready', resumeHold };
      const leftWorkspace = workspaces?.some((item) => item.id === movedWorkspace) ? movedWorkspace : undefined;
      return {
        ...planned,
        replacedPane: movedPane,
        resume: continuitySession,
        ...(leftWorkspace ? { leftWorkspace } : {}),
      };
    }
    const candidate = named.length === 1 ? named[0] : undefined;
    const tied = candidate !== undefined
      && continuitySession !== null
      && candidate.session !== undefined
      && candidate.session !== ''
      && candidate.session === continuitySession;
    if (!tied) {
      const why = named.length > 1
        ? 'its recorded pane is gone and more than one agent in the terminal host is named for it; nothing closed'
        : 'its recorded pane is gone and the pane naming this seat cannot be tied to its recorded conversation; nothing closed';
      return {
        ...planned,
        stage: 'ready',
        sessionDoubt: why,
        ...(named.some(working) ? { doubtWorking: true } : {}),
      };
    }
    if (candidate !== undefined && next === null) {
      return {
        ...planned,
        stage: 'ready',
        sessionDoubt: 'its recorded pane is gone and the pane naming this seat gives no process identity; nothing closed',
        ...(working(candidate) ? { doubtWorking: true } : {}),
      };
    }
    if (candidate !== undefined && next !== null) {
      const movedRecord = { ...recorded, pane: candidate.pane, workspace: candidate.workspace || movedWorkspace };
      const drift = modelDrift(team, seat, movedRecord, known, processes, screenOf, owner, registry ?? seat, true, callerSeat);
      if (drift.kind === 'refuse') return { ...planned, stage: 'ready', driftRefused: drift.detail };
      if (drift.kind === 'cycle') {
        const resumeHold = uncarryableResume(planned, continuitySession);
        if (resumeHold) return { ...planned, stage: 'ready', resumeHold };
        return {
          ...planned,
          repair: {
            pane: candidate.pane,
            workspace: movedRecord.workspace,
            launched: next,
            cli: seat.cli,
            drift: { way: drift.way },
          },
          resume: continuitySession,
        };
      }
      if (drift.kind === 'hold') return { ...planned, stage: 'ready', driftHold: drift.detail };
      return {
        ...planned,
        stage: 'ready',
        restored: {
          launched: next,
          session: continuitySession,
          detail: restoredDetail({ ...seat, model: registry?.model ?? seat.model, version: registry?.version ?? seat.version }, movedRecord, screenOf),
          pane: candidate.pane,
          workspace: movedRecord.workspace,
        },
      };
    }
  }
  // The pane is the seat only while the process team launched is still in it: a pane that runs
  // no CLI, or one whose process is not the recorded one, is not the seat. Its workspace is
  // closed without input and the seat is launched fresh — the stage it stopped at is not
  // resumed. No workspace recorded, no close to make: the seat is left as it is. The close
  // itself reads the terminal host again, immediately before it (`execute.ts`), so this
  // reading only decides that the seat needs repair, never that its recorded workspace is
  // still its own.
  const verdict = seatProcessVerdict(recorded.launched, processes[seat.name] ?? null);
  const onRecordedPane = recorded.pane
    ? known.find((agent) => agent.name === seat.name && agent.pane === recorded.pane)
    : undefined;
  const continuity = replacedSeat(verdict, {
    asked,
    namedOnPane: Boolean(onRecordedPane),
    recordedSession: continuitySession ?? undefined,
    liveSession: onRecordedPane?.session,
  });
  const restoredSession = continuity === 'restored' ? continuitySession : null;
  // A program is in front and its agent session is the one the records bind. The pids changed;
  // the seat did not. Nothing is closed, and the record takes the pids the pane holds now.
  if (restoredSession !== null && recorded.pane && recorded.workspace && recorded.launched) {
    const next = launchedIdentity(processes[seat.name] ?? null);
    if (next) {
      // The expected side is the signed record where there is one, and the file it was declared
      // from otherwise: a restored seat the host brought back on another model is repaired too.
      const drift = modelDrift(team, seat, recorded, known, processes, screenOf, owner, registry ?? seat, true, callerSeat);
      if (drift.kind === 'refuse') return { ...planned, stage: 'ready', driftRefused: drift.detail };
      if (drift.kind === 'cycle') {
        // A proven conversation this seat's own launch line cannot carry stops the repair before
        // its close: the conversation would not come back. The line checked is the one the
        // repair would run — the record's launch, not the line the file was declared with.
        const resumeHold = uncarryableResume(planned, restoredSession);
        if (resumeHold) return { ...planned, stage: 'ready', resumeHold };
        return {
          ...planned,
          repair: {
            pane: recorded.pane,
            workspace: recorded.workspace,
            launched: next,
            cli: seat.cli,
            drift: { way: drift.way },
          },
          // The pane's live agent is the recorded conversation (`restored`): the relaunch through
          // the record's launch resumes it, whether or not the state copy names it.
          resume: restoredSession,
        };
      }
      if (drift.kind === 'hold') return { ...planned, stage: 'ready', driftHold: drift.detail };
      return {
        ...planned,
        stage: 'ready',
        restored: {
          launched: next,
          session: restoredSession,
          detail: restoredDetail({ ...seat, model: registry?.model ?? seat.model, version: registry?.version ?? seat.version }, recorded, screenOf),
        },
      };
    }
  }
  // A program is in front and the session cannot be shown. Leave the record. Do not close.
  // A working or unsent screen keeps the refusal the close used to give.
  if (continuity === 'doubt' && recorded.workspace && recorded.pane && recorded.launched) {
    const held = replacedScreenRefusal(seat, recorded.pane, screenOf, onRecordedPane?.status);
    const refusal = held?.why;
    return {
      ...planned,
      stage: recorded.stage,
      sessionDoubt: refusal ?? 'its pane holds a process this record cannot tie to the launch',
      ...(held?.working ? { doubtWorking: true } : {}),
    };
  }
  // The shell is in front. The seat's name surviving on the pane does not make it the CLI.
  if (verdict === 'gone' && recorded.workspace && recorded.pane && recorded.launched) {
    return {
      ...planned,
      repair: { pane: recorded.pane, workspace: recorded.workspace, launched: recorded.launched, cli: seat.cli },
    };
  }
  const named = known.find((agent) => agent.name === seat.name);
  const onPane = recorded.pane ? known.some((agent) => agent.pane === recorded.pane) : false;
  if (recorded.stage === 'ready') {
    if (named || onPane) {
      const drift = modelDrift(team, seat, recorded, known, processes, screenOf, owner, registry ?? seat, false, callerSeat);
      // A drift this run must not close at all — its own seat or a lead — keeps the ready
      // record, closes nothing, and is reported with the way the file itself gives.
      if (drift.kind === 'refuse') return { ...planned, stage: 'ready', driftRefused: drift.detail };
      // The pane's own agent names the conversation the records bind: a relaunch may resume it,
      // even where the state copy names no id. A pane naming another session proves nothing.
      const provenSession = continuitySession !== null
        && onRecordedPane?.session !== undefined
        && onRecordedPane.session !== ''
        && onRecordedPane.session === continuitySession
        ? continuitySession
        : undefined;
      if (drift.kind === 'cycle' && recorded.pane && recorded.workspace && recorded.launched) {
        // The line checked is the one the repair would run — the record's launch where there is
        // one — so a record naming another conversation is refused before the close.
        const resumeHold = provenSession === undefined ? undefined : uncarryableResume(planned, provenSession);
        if (resumeHold) return { ...planned, stage: 'ready', resumeHold };
        return {
          ...planned,
          repair: {
            pane: recorded.pane,
            workspace: recorded.workspace,
            launched: recorded.launched,
            cli: seat.cli,
            drift: { way: drift.way },
          },
          ...(provenSession === undefined ? {} : { resume: provenSession }),
        };
      }
      if (drift.kind === 'hold') return { ...planned, stage: 'ready', driftHold: drift.detail };
      const listed = named ?? known.find((agent) => agent.pane === recorded.pane);
      return {
        ...planned,
        stage: 'ready',
        ...(listed ? { pane: listed.pane, workspace: listed.workspace } : {}),
        ...restartNote(team, seat.name, recorded, home, root, session),
      };
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

// What a ready seat this `up` leaves as it is needs: a process team it never recorded (a launch
// from before identities were), repaired in place by `team register <seat>`; or a start outside
// the team's lobby (an old release's start), repaired by a relaunch — one seat at a time, or the
// whole team for a seat the file names as its orchestrator or operator. The skip line says which.
/** The restored seat's detail. A model that differs from the file is reported and is not closed. */
function restoredDetail(
  seat: Seat,
  recorded: SeatState,
  screenOf: (pane: string) => string | null,
): string {
  const kept = 'restored; left as it is';
  if (!recorded.pane || !seat.version || !canShowModel(seat)) return kept;
  const text = screenOf(recorded.pane);
  if (text == null || text === '') return kept;
  const running = seatModel(seat, text);
  if (!running || !modelDiffers(running, { model: seat.model, version: seat.version })) return kept;
  return `${kept}; its model drifted; left as it is`;
}

function restartNote(
  team: Pick<TeamFile, 'orchestrator' | 'operator' | 'entity' | 'lobby'>,
  name: string,
  recorded: SeatState,
  home: string,
  root: string,
  session: string,
): { restartNote: string } | Record<string, never> {
  const fix = relaunchRepair(team, name, 'plain');
  // The identity a launch predating the record could not write is `team register`'s to write:
  // the seat is ready on its pane, and recording it is one per-seat command — never a
  // whole-team restart for one seat's bookkeeping, and a lead runs it for its own seat too.
  if (!recorded.launched) return { restartNote: `its process was never recorded: run team register ${name} to record it, nothing relaunched` };
  // A running lead is at home in the lobby or in the project. Either recording is left as it
  // is. Every other seat still outside the lobby is told how to move.
  if (recorded.start_cwd && recorded.start_cwd !== lobbyOf(home, root, { ...team, session })) {
    if (isLeadSeat(team, name) && recorded.start_cwd === root) return {};
    return { restartNote: `a relaunch moves it into the lobby: ${fix}` };
  }
  return {};
}

/** A caller who is not the owner and is not named for `up`. Stderr is the word `deny`, and,
 *  when an expired dev-mode declaration is why the gate is quiet, a note line of its own after
 *  it — so the word the page promises is exactly the word, alone on its line. Under `--json` the
 *  same word is the error document, with the contract row of the gate that refused it (`up.deny`
 *  when no gate named one) and the resolver's rule. */
function denyUp(
  out: { stderr(text: string): void },
  io: Io,
  json: boolean,
  id = 'up.deny',
  rule: string | null = 'no-record',
  expiry = '',
): number {
  if (json) refuse(io, true, 'up', { id, message: 'deny', repair: null, rule });
  else {
    out.stderr('deny\n');
    if (expiry !== '') out.stderr(`${expiry}\n`);
  }
  // exit: up.deny
  // exit: up.delegate
  // exit: up.delegate-approval
  // exit: up.delegate-evidence
  // exit: up.delegate-placement
  // exit: up.delegate-command
  // exit: up.grant-another-pane
  // exit: up.grant-approval
  // exit: up.grant-caller
  // exit: up.grant-no-pane
  // exit: up.grant-scope
  return 1;
}

/** The sentence a caller the run does not admit is refused with. One spelling, so the bare
 *  `deny` a real run answers with, the warning dev mode folds it into, and the `! up would
 *  refuse:` line a dry run prints are the same words. The rule is the map's `up` row
 *  (`owner-or-leads`): the owner, or a seat this team's record marks `leads`. */
function placementRefusal(caller: Caller): string {
  return `only the owner or \`leads\` starts the team; this call is ${describeCaller(caller)}`;
}

/** The one command that unblocks a run this caller cannot start: a `leads` seat's own, from its
 *  pane, or the owner's, in this folder from a terminal outside a terminal host session. The
 *  flags the caller named are kept, spelled the way the plan spells a word, so the printed line
 *  is a command that runs. */
function unblockingUpRun(values: { file?: string; session?: string }): string {
  const words = ['team up'];
  if (values.file !== undefined) words.push('--file', shellQuote(values.file));
  if (values.session !== undefined) words.push('--session', shellQuote(values.session));
  return `a \`leads\` seat runs \`${words.join(' ')}\` from its own pane (the owner runs it from this folder, at a terminal outside herdr)`;
}

/** Pulls the dev-mode warnings out of `refusals` and joins them into the one line. */
function devWarningLine(refusals: UpRefusal[], standing: Standing, caller: Caller): string {
  const placement = placementRefusal(caller);
  const kept: UpRefusal[] = [];
  const warnings: string[] = [];
  for (const line of refusals) {
    if (devModeWarning(line.message, standing, placement)) warnings.push(line.message);
    else kept.push(line);
  }
  refusals.splice(0, refusals.length, ...kept);
  return [...new Set(warnings)].join('; ');
}

function devModeWarning(line: string, standing: Standing, placement: string): boolean {
  if (line === placement) return true;
  if (standing.kind === 'verified') return false;
  // A registry read names the team's registry config; a team-file read names the file. Both
  // are the never-approved warning dev mode folds, and neither stays a refusal.
  if (standing.kind === 'none') {
    return line === notInForce(standing) || line === notInForce(standing, 'registry');
  }
  return line === notInForce(standing);
}

/** The run's refusals, each sentence once, in the order the run reached them: the same cause can
 *  arrive from two readers (the gate and `doctor` both read the approval). */
function uniqueRefusals(refusals: readonly UpRefusal[]): UpRefusal[] {
  const seen = new Set<string>();
  return refusals.filter((refusal) => {
    if (seen.has(refusal.message)) return false;
    seen.add(refusal.message);
    return true;
  });
}

/** The daemon's own entry into this run: the restore sweep calls `runUp` with the run lock
 *  already held and the caller it is judged as. No CLI dispatch passes these. */
export type UpInternal = {
  /** Who the run is judged as. The daemon sweeps a route as its owner; without this the
   *  daemon's own process places as no caller and every admission path would refuse it. */
  caller?: Caller;
  /** The caller holds the session's run lock and releases it; this run neither takes nor
   *  releases it. */
  lockHeld?: boolean;
  /** The run's report, before it returns. The restore sweep folds it into its summary. */
  onReport?(report: Report): void;
  /** The host is closing: stop between seat steps, leaving no seat half-made. */
  isClosing?(): boolean;
  /** No terminal is reading this run: a dialog found at a seat is recorded as waiting for the
   *  owner, neither prompted nor closed. The daemon's restore sweep runs detached and passes
   *  this. */
  nonInteractive?: boolean;
};

export async function runUp(argv: string[], io: Io, sources: UpSources, internal?: UpInternal): Promise<number> {
  // Every line this run writes goes through the cleaned writers from here; the raw pair stays
  // reachable for the progress writer alone, which draws its own `\r\x1b[K` on a TTY.
  const out = cleanedIo(io);
  // A bad option stops the parser before `--json` is read when it comes first, and the
  // structured refusal is still the one the caller asked for.
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['session', 'file', 'client', 'key', 'team', 'approval', 'general'], ['dry-run', 'serial', 'json', 'request', 'no-launch']);
  // The lines plain output writes beside the records ride on the document as notes under
  // `--json`; stdout carries the one document and nothing else.
  const jsonNotes: string[] = [];
  const collect = (text: string): void => {
    for (const line of text.split('\n')) if (line !== '') jsonNotes.push(line);
  };
  const stderrLine = (text: string): void => {
    if (json) collect(text);
    else out.stderr(text);
  };
  const clientProblem = args.error === undefined && args.rest.length === 0 ? clientInvocationProblem(args) : null;
  if (args.error || args.rest.length || clientProblem !== null) {
    refuse(io, json, 'up', {
      id: 'up.invocation',
      message: plainText(args.error ?? (args.rest.length ? `unexpected "${args.rest[0]}"` : clientProblem!)),
      repair: null,
      usage: USAGE,
    });
    // exit: up.invocation
    return 2;
  }
  const dry = args.flags.has('dry-run');
  // `--no-launch`: seats get their rules and nothing else — no general seat brief is dropped in
  // their folder and no launch-line inbox route names a brief epoch.
  const noLaunch = args.flags.has('no-launch');
  // The client form: a grant the owner signed for ONE team at ONE folder, proven by the client's own
  // key. It is verified whole here, before anything else is read, and then the run is the grant's
  // folder alone — a no-terminal owner launch that never prompts, whose seats are the signed team
  // file's and no others. Every other caller goes through the ordinary gates below, unchanged.
  let clientUp: { grant: ClientUpGrantRecord; signature: string; requestId: string } | null = null;
  if (args.values.client !== undefined) {
    stderrLine(`${KEY_ISOLATION_LINE}\n`);
    const clientNow = sources.now?.() ?? new Date();
    const verified = verifyClientUp({
      home: sources.home,
      grantFile: resolve(io.cwd, args.values.client),
      keyFile: resolve(io.cwd, args.values.key!),
      cwd: io.cwd,
      ...(args.values.team !== undefined ? { team: args.values.team } : {}),
      now: clientNow,

      io,    });
    if (!verified.ok) {
      // A refusal for a client the key identified goes on the team's own log, where the owner reads
      // what ran; a grant that did not verify identifies no one and writes nothing.
      const named = verified.identified;
      if (!dry && named !== null && existsSync(join(named.up.root, '.agents'))) {
        logLine(join(named.up.root, '.agents'), 'up', `client:${named.clientId}`, `client-up-refused: grant ${named.grantId}: ${verified.why}`, clientNow);
      }
      return clientRefused(io, json, verified.why);
    }
    clientUp = { grant: verified.grant, signature: verified.signature, requestId: verified.requestId };
    // The folder is the grant's, whatever the caller's: from here every read is of that team.
    io = { ...io, cwd: verified.root };
    stderrLine(`client grant ${verified.grant.grantId}: ${verified.grant.clientId} for team ${verified.grant.up.project} at ${verified.root}, ${expiryPhrase(verified.grant.expires)}\n`);
  }
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
  // The owner-seat door (src/client/owner-action-step.ts): `--request` asks the owner seat and
  // returns; `--approval <id>` admits this run when the owner seat signed for exactly it. An
  // admitted run is a no-terminal owner launch: it never prompts and never types into a pane.
  // A general grant (src/client/general-grant.ts): the owner signed this principal once for this
  // entity, so the run is admitted as an owner-seat approval would admit it, with no request.
  if (args.values.general !== undefined) {
    let entity: string | null = null;
    try {
      const here = readTeamConfig(io.cwd, { home: sources.home, checkOnly: true });
      if (here.ok) entity = here.team.entity;
    } catch {}
    const general = admitGeneral(sources.home ?? homedir(), resolve(io.cwd, args.values.general), resolve(io.cwd, args.values.key!), 'up', entity, sources.now?.() ?? new Date());
    if (!general.ok) {
      refuse(io, json, 'up', { id: 'up.general-refused', message: general.why, repair: null });
      // exit: up.general-refused
      return 1;
    }
    stderrLine(`team up: admitted by general grant ${general.grant.grant_id} (${general.grant.client_id})\n`);
  }
  const seatStep = args.values.general !== undefined
    ? { kind: 'admitted' as const }
    : clientUp !== null && (args.flags.has('request') || args.values.approval !== undefined)
    ? (refuse(io, json, 'up', { id: 'up.approval-refused', message: '--client and the owner-seat door are two doors: pass one', repair: null }), { kind: 'refused' as const })
    : ownerSeatStep('up', 'team-up', argv, { request: args.flags.has('request'), approval: args.values.approval, dry, json }, io, sources);
  if (seatStep.kind === 'requested') {
    // exit: up.approval-requested
    return 0;
  }
  if (seatStep.kind === 'refused') {
    // exit: up.approval-refused
    return 1;
  }
  const seatApproved = seatStep.kind === 'admitted';
  const walked = internal?.caller ?? walkCaller(io);
  // A run with no terminal is not the owner, and it is not asked of the delegate gate, the grant,
  // or the token. The refusal is one sentence, on the dry run and the real run.
  const detached = clientUp !== null || seatApproved ? undefined : detachedRefusal(walked, { who: 'the owner or a `leads` seat', where: 'a terminal outside herdr or its own pane' });
  // The owner's run on a team still only in its file imports it first, with a notice
  // (docs/commands/up.md): moving to the registry never stands between the owner and a launch.
  const imported = clientUp === null && detached === undefined && (walked.kind === 'owner' || seatApproved) && !args.values.file
    ? importForUp(io.cwd, sources.home, dry, sources.now?.() ?? new Date())
    : null;
  if (imported !== null) {
    if (dry && !json) out.stdout(`${imported}\n`);
    else stderrLine(`team up: ${imported}\n`);
  }
  const defaultLoad = mayLaunchSeats(walked) || detached !== undefined ? null : readTeamConfig(io.cwd, { home: sources.home });
  // Dev mode, as the default live file's chain states it: this folder's own file is the caller's
  // place, never a file the caller names. The aimed branch below decides before that file is
  // mounted, so it reads this verdict; the run's own, after the load, is the one every later
  // line uses (`dev`). An owner's `--file` therefore cannot carry a laxer policy in with it.
  const aimedDev = resolveDevMode('up', io, {
    home: sources.home,
    team: defaultLoad !== null && defaultLoad.ok ? defaultLoad.team : null,
    root: defaultLoad !== null && defaultLoad.ok ? defaultLoad.root : null,
    now: sources.now?.() ?? new Date(),
  });
  // The folder the aimed branch logs in: the default live file's own, the place its chain was
  // read from; a file that would not load leaves the folder's own team file as the place.
  const aimedDir = defaultLoad !== null && defaultLoad.ok ? dirname(defaultLoad.path) : dirname(join(io.cwd, TEAM_FILE));
  // A non-owner passing `--session`, or a `--file` other than this folder's own team file, is
  // refused before the map is walked for this run: the aim is the owner's, the walk reads a
  // session and asks the host, and the flagged path and the named session are never read. The
  // gate's own sentence replaces the walk's where a delegate refused the aim, and a granted
  // seat that aims either flag is refused in its own words. The owner-only rule is the first
  // thing the aim meets: a grant that refused the run — for any reason — never turns the aim
  // into an ordinary one on the file's own session. This folder's own file, with no
  // `--session`, continues below.
  const otherFile = args.values.file !== undefined && resolve(io.cwd, args.values.file) !== resolve(io.cwd, TEAM_FILE);
  const aimed = otherFile || args.values.session !== undefined;
  if (detached !== undefined && aimed) {
    refuse(io, json, 'up', { id: 'up.detached', message: detached, repair: null });
    // exit: up.detached
    return 1;
  }
  // The two fallbacks, read from the DEFAULT live file of this cwd, with no flag: a delegate's
  // eligibility never comes from a file the caller names, and neither gate opens the aim.
  const delegatesFile = defaultLoad !== null && defaultLoad.ok && defaultLoad.team.delegates ? defaultLoad : null;
  const grantFile = defaultLoad !== null && defaultLoad.ok && defaultLoad.team.grant !== null ? defaultLoad : null;
  const judgeGates = (): {
    verdict: ReturnType<typeof delegateGate> | null;
    delegated: string | null;
    grantedSeat: string | null;
    grantRefusal: string | null;
    /** The warning line a dev-mode approval fold owed, and the file whose folder logs it. */
    approval: string | null;
    approvalDir: string;
  } => {
    const verdict = delegatesFile
      ? (sources.delegateGate ?? delegateGate)({
          command: 'up',
          team: delegatesFile.team,
          root: delegatesFile.root,
          dir: dirname(delegatesFile.path),
          flags: [...args.flags, ...Object.keys(args.values)],
          io,
          home: sources.home,
          // Dev mode folds the delegation's approval precondition, and the verdict carries
          // the warning naming the live file. `aimedDev` is that same default file's chain.
          dev: aimedDev,
          file: delegatesFile.path,
        })
      : null;
    // The approved `<session>/<pane id>` when this run is a delegated one: the default file's
    // `delegates` section named a pane, and the gate passed it.
    const delegated = verdict?.kind === 'passed' ? verdict.pane : null;
    // The grant is asked where no delegate took the run. A delegate refusal that already named a
    // listed pane — a flag, a drift, an approval — keeps that sentence. `up.delegate` is the
    // caller who is not a listed pane, and that caller may be the granted seat. A file that
    // omits `grant` does not ask.
    const delegateMissed = verdict === null || (verdict.kind === 'refused' && verdict.id === 'up.delegate');
    let grantedSeat: string | null = null;
    let grantRefusal: string | null = null;
    let approval: string | null = verdict?.kind === 'passed' ? verdict.devApproval ?? null : null;
    let approvalDir = aimedDir;
    if (delegated === null && delegateMissed && grantFile) {
      const said = (sources.grantGate ?? grantGate)({ act: 'up', io, home: sources.home, dev: aimedDev });
      if (said.kind === 'passed') {
        grantedSeat = said.grant.seat;
        if (said.devApproval !== undefined) {
          approval = said.devApproval;
          approvalDir = dirname(grantFile.path);
        }
      } else grantRefusal = said.text;
    }
    return { verdict, delegated, grantedSeat, grantRefusal, approval, approvalDir };
  };
  if (!mayLaunchSeats(walked) && aimed) {
    const gates = judgeGates();
    if (gates.grantedSeat !== null) {
      const flag = args.values.session !== undefined ? 'session' : 'file';
      refuse(io, json, 'up', {
        id: 'up.grant-flag',
        message: `--${flag} is the owner's; the granted seat cannot use it`,
        repair: null,
      });
      // exit: up.grant-flag
      return 1;
    }
    // Dev mode does not return here: the file is mounted, and the same sentence is a warning below.
    // One return answers both runs: a real one with the bare word, a dry one never denied but told
    // the reason and the owner's own command. Either way the flagged file stays unread, so the dry
    // run prints no plan for it.
    if (gates.verdict === null && !aimedDev.on) {
      // The state the aim's chain owed once, before the refusal ends the run: the variable
      // ignored under a governing policy, an expiry, a source that could not be read. The
      // run never reaches the main log below, so it writes the lines here; the dry run's
      // refusal names the expiry, while a real run keeps the page's bare word.
      if (!dry) logDevModeState(aimedDir, 'up', callerLabel(walked), aimedDev, sources.now?.() ?? new Date());
      if (json) {
        refuse(io, true, 'up', { id: 'up.not-owner', message: 'deny', repair: null, rule: 'no-record' });
      } else if (dry) {
        out.stdout(`! up would refuse: ${plainText(placementRefusal(walked))}${devModeExpiryNote(aimedDev)}\n`);
        out.stdout(`! to unblock: ${plainText(unblockingUpRun(args.values))}\n`);
      } else {
        out.stderr('deny\n');
        const expiry = devModeExpiryLine(aimedDev);
        if (expiry !== '') out.stderr(`${expiry}\n`);
      }
      // exit: up.not-owner
      return 1;
    }
    if (gates.verdict?.kind === 'refused') {
      refuse(io, json, 'up', {
        id: 'up.delegate-flag',
        message: plainText(gates.verdict.text),
        repair: null,
      });
      // exit: up.delegate-flag
      return 1;
    }
  }
  // The caller rule is the map's row (`owner-or-leads`): the owner, or a seat the team's record
  // marks `leads` — its orchestrator, or a roster mark. The decision is made where the caller
  // stands, by the same search `down` makes (`judgeCallerIn`), and the pane proof stays the
  // standing's: a lead the state does not record on its pane is still refused below. The row
  // reads the file the run is on. It is decided before either fallback is used: an admitted run
  // owes neither gate, and neither gate's audit line.
  const gate = defaultLoad !== null && defaultLoad.ok ? defaultLoad : null;
  let judged: ReturnType<typeof judgeCallerIn> | null = null;
  let rule: ReturnType<typeof gateVerdict> | null = null;
  if (gate !== null) {
    const gateDir = dirname(gate.path);
    const verdictOf = (who: Caller, at: SeatStanding): ReturnType<typeof gateVerdict> =>
      gateVerdict(who, gate.team, gate.root, sources.home ?? homedir(), 'up', at, sources.now);
    judged = judgeCallerIn(io, gateDir, gate.team, verdictOf);
    rule = verdictOf(judged.caller, standingOf(gateDir, judged.session, judged.caller));
  }
  const ordinaryAdmitted = mayLaunchSeats(walked) || rule?.kind === 'ok';
  const caller = internal?.caller ?? judged?.caller ?? callerOf(io);
  // The two fallbacks are used only where the map refused. A gate refusal replaces the ordinary
  // caller refusal; a passed one makes the run the gate's, and its audit line is written where
  // the run has effects — never beside the map's own admission.
  const delegateTeam = !ordinaryAdmitted && clientUp === null && delegatesFile !== null ? delegatesFile : null;
  const gates = ordinaryAdmitted || clientUp !== null ? null : judgeGates();
  const verdict = gates?.verdict ?? null;
  const delegated = gates?.delegated ?? null;
  const grantedSeat = gates?.grantedSeat ?? null;
  const grantRefusal = gates?.grantRefusal ?? null;
  // The file this run is whole on: the default one whenever the gate decided on it — a refused
  // run stops on the gate's words without reading a flagged target, a delegated one runs the
  // file its delegation was read from — and otherwise today's load, `--file` honoured exactly
  // as before.
  const loaded =
    delegateTeam ??
    (defaultLoad !== null && !args.values.file
      ? defaultLoad
      : readTeamConfig(io.cwd, {
          ...(args.values.file ? { file: args.values.file } : {}),
          home: sources.home,
          // The session this run addresses: the placement check reads that session's recorded
          // lobby, which `up --session alt` records apart from the file's own.
          ...(args.values.session !== undefined ? { session: args.values.session } : {}),
        }));
  if (!loaded.ok) {
    // A file that does not load refuses both runs, one voice each: the real one stops in
    // `team up`'s own words, the dry one says what a real run would stop on (`! up would
    // refuse:`, the dry run's line for every refusal it reaches) and prints no plan, because
    // this file builds none. Both exit as the file error does, and neither launches anything.
    const said = loaded.errors.map(
      (problem) => `${problem.line ? `line ${problem.line}: ` : ''}${plainText(problem.message)}`,
    );
    if (json) {
      const id = loaded.errors.some((problem) => problem.message.startsWith('not inside a git repository'))
        ? 'up.not-a-repo'
        : loaded.errors.some((problem) => problem.line > 0) ? 'up.file-invalid' : 'up.file';
      refuse(io, true, 'up', { id, message: said.join('; '), repair: null });
    } else {
      for (const problem of said) {
        if (dry) out.stdout(`! up would refuse: ${problem}\n`);
        else out.stderr(`team up: ${problem}\n`);
      }
    }
    // exit: up.not-a-repo
    // exit: up.file
    // exit: up.file-invalid
    return 2;
  }
  const { root } = loaded;
  let team = loaded.team;
  const leftover = imported === null ? leftoverNote(loaded.leftover) : null;
  if (leftover !== null) {
    if (dry && !json) out.stdout(`${leftover}\n`);
    else stderrLine(`team up: ${leftover}\n`);
  }
  // Owner-only targets are honoured only when no gate decided: a delegated run is the default
  // file's own session, and an aimed run by anyone but the owner has already returned above.
  const session = verdict !== null ? team.session : (args.values.session ?? team.session);
  // The lobby this session operates on: the one the registry recorded for it, else its own when
  // the file sets `entity` or `lobby`, else the machine-global one. Every lobby read and make
  // below runs against it, so a second team on the machine — or another session of this one —
  // no longer waits behind the first lobby.
  const teamLobby = lobbyOf(sources.home, root, { ...team, session });
  const dir = dirname(loaded.path);
  // The run's own dev mode, from the file it mounts: a policy value anywhere in the caller's
  // chain governs, and `TEAMCLI_DEV_MODE` is then ignored; before any such value, the variable
  // set to exactly `1` keeps its behaviour. The caller gate is folded here; the grant and
  // delegate gates folded theirs earlier, from the default file's chain (`aimedDev`).
  const dev = resolveDevMode('up', io, { home: sources.home, team, root, now: sources.now?.() ?? new Date() });
  // The configuration lines the run owes once: the variable ignored under a governing policy,
  // and a policy source that could not be read or ordered. Written before any refusal returns,
  // and never by a dry run.
  if (!dry) logDevModeState(dir, 'up', callerLabel(caller), dev, sources.now?.() ?? new Date());
  let state = resolveState(sources, session);
  // A stopped session this team's state records is cleared under the run lock, then started.
  // The plan below is built as for an absent session. One the state does not record is refused,
  // and nothing here tells the caller to run a herdr command.
  let clearStopped = false;

  // Read the approval before the caller gate so an out-of-band owner token can be
  // matched against its fingerprints and generation. Launch limits come from the live file.
  const standing = sources.standing?.(root) ?? approvalStanding(root, sources.home);
  // The out-of-band owner authorization: a non-owner caller is admitted as the owner for this one
  // launch when the token equals the fingerprint of the approved record `up` would launch — its
  // fingerprints and generation, recomputed now. Only when an approval is in force, and never on a
  // delegated run (the gate decides those). Downstream treats it as a no-terminal owner: it never
  // prompts, which is right for an agent with no terminal.
  const upFp =
    standing.kind === 'verified' ? upFingerprint(standing.record.approval.fingerprints, standing.generation) : undefined;
  const ownerToken =
    detached === undefined &&
    clientUp === null &&
    !ordinaryAdmitted &&
    verdict === null &&
    grantedSeat === null &&
    grantRefusal === null &&
    upFp !== undefined &&
    ownerAuthorized(io.env, upFp);
  // A verified owner-seat answer for this run, or a signed always rule asked only where every
  // other door refused.
  const ownerSeat = seatApproved || (
    detached === undefined && clientUp === null && !ordinaryAdmitted && !ownerToken && verdict === null && grantedSeat === null &&
    ownerSeatRuleAdmits('team-up', io.cwd, dry, sources));

  const createGranted = entityGrantAdmits(root, io, { home: sources.home, now: sources.now?.(), cwd: io.cwd });
  // The map's admission, the trusted owner token, the granted seat, a passed delegation, a pane
  // the live file names for `up`, or the seat whose own registry record an active entity
  // create-grant names. A grant is not a constraint on an admitted run: it was never asked, and
  // its audit line is never written.
  const named =
    ordinaryAdmitted ||
    ownerToken ||
    ownerSeat ||
    grantedSeat !== null ||
    delegated !== null ||
    delegateNamedFor(team, 'up', io) ||
    createGranted ||
    clientUp !== null;

  // What would make `up` refuse. A dry run prints the plan anyway; a real run stops first.
  const refusals: UpRefusal[] = [];
  // No create-grant admits a run with no terminal: the record matches the caller's own registry
  // record, and a caller outside a terminal host session has none.
  if (detached !== undefined && !createGranted) {
    refusals.push({ id: 'up.detached', message: detached });
  } else if (!named) {
    // Dev mode mounts and says the placement as a warning; a dry run says it beside the plan it
    // would refuse. Anyone else is denied, and the bare word is the whole answer.
    if (!dev.on && !dry) {
      // The gate that refused names the contract row it refuses on; a run neither fallback
      // took is the bare `up.deny`.
      const grantedId = grantRefusal !== null && grantRefusal.startsWith('grant.')
        ? `up.grant-${grantRefusal.slice('grant.'.length)}`
        : undefined;
      const id = verdict?.kind === 'refused' ? verdict.id : grantedId;
      return denyUp(out, io, json, id, 'no-record', devModeExpiryLine(dev));
    }
    refusals.push({ id: 'up.placement', message: placementRefusal(caller) });
  }
  // The live file is the record. A verified copy that no longer matches is not a refusal.
  // A legacy or refused record still is: its text is the case, and dev mode warns instead.
  const approvalSource = loaded.source === 'registry' ? 'registry' as const : 'team-file' as const;
  if (standing.kind === 'none') {
    if (dev.on) refusals.push({ id: 'up.never-approved', message: notInForce(standing, approvalSource) });
  } else if (standing.kind !== 'verified') {
    refusals.push({ id: 'up.never-approved', message: notInForce(standing, approvalSource) });
  }
  // The budget readings the gate refuses on are the live file's own: a standing that is not
  // verified names no account at all, not even for a dry run's plan.
  const budgets = budgetsInForceOf(standing, team);

  // A file a CLI reads at start refuses only a launch into the lobby. `doctor` reports it
  // as a miss, and that miss is applied once `launchingIntoLobby` is known, below.
  const startupReadRefusals: string[] = [];
  if (sources.doctor) {
    const findings = doctorFindings(team, root, dir, session, sources.doctor, loaded.warnings, standing, team, [], [], rulesOriginOf(loaded.source));
    for (const finding of findings) {
      if (!blocksLaunch(finding)) continue;
      if (!dev.on && (finding.text.includes('team approve') || finding.text.includes('never approved'))) continue;
      if (finding.text.includes(' is read at start by ')) startupReadRefusals.push(finding.text);
      else refusals.push({ id: 'up.doctor', message: finding.text });
    }
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
      if (!dry && (ordinaryAdmitted || delegated !== null || grantedSeat !== null || createGranted || ownerToken || ownerSeat || clientUp !== null)) {
        logLine(dir, 'up', callerLabel(caller), `refused: ${problem} — readings: ${readingsText(machine)}`, sources.now?.() ?? new Date());
      }
      refusals.push({ id: 'up.machine', message: problem });
    }
  }

  if (state === null) refusals.push({ id: 'up.herdr', message: "herdr doesn't answer" });
  if (state === 'stopped') {
    if (Object.hasOwn(readState(dir).sessions, session)) {
      clearStopped = true;
      state = 'absent';
    } else {
      refusals.push({ id: 'up.stopped', message: `session ${session} is stopped` });
    }
  }
  const agents = state === 'running' ? sources.agents(session) : [];
  if (state === 'running') {
    const recorded = readState(dir).sessions[session]?.seats ?? {};
    if (agents === null) {
      refusals.push({ id: 'up.agents', message: `session ${session} runs, and its agents can't be read` });
    } else {
      // §5: a seat recorded waiting was left in its pane for the owner — by `add`, whose seat
      // was never renamed, so herdr lists its pane with no `name` field at all. That agent is
      // known by its pane, whatever its name is now: the resume path verifies pane and process
      // itself, and its prompt is the only way the owner can finish the seat.
      // The file is the truth: a record for a seat the file no longer declares names nothing of
      // this team's, and the pane it claims is no reason to know an agent there (`seatOfFile`).
      const declared = new Set(team.seats.map((seat) => seat.name));
      const waitingPanes = new Set(
        Object.entries(recorded)
          .filter(([name, seat]) => seat.waiting && seatOfFile(name, seat, declared))
          .map(([, seat]) => seat.pane)
          .filter((pane) => pane !== undefined),
      );
      // A seat left at `launched` — a run stopped between "the pane exists" and "the seat has
      // its name" — is the run's own half-finished work, and herdr lists its agent with no name
      // (or another one) on the pane this state records. That pane is known the way the waiting
      // one is: the resume path verifies pane, process and rename before recording anything.
      // Only `launched` qualifies — a seat at `named` or `ready` has its name, so a foreign
      // agent on its pane is refused exactly as before, and so is any pane no record names.
      const launchedPanes = new Set(
        Object.entries(recorded)
          .filter(([name, seat]) => seat.stage === 'launched' && seatOfFile(name, seat, declared))
          .map(([, seat]) => seat.pane)
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
        refusals.push({
          id: 'up.unknown',
          message: `session ${session} has ${unknown.length} agent${unknown.length === 1 ? '' : 's'} this file's state doesn't record: \`up\` never touches a running team`,
        });
      }
    }
  }

  const lobby = teamLobby;
  // Missing or project-relative trust is not a refusal: the run trusts the lobby and the project
  // root, both absolute, and says so once (src/file/migrate.ts derivedTrust).
  const derived = derivedTrust({ ...team, session }, root, sources.home);
  if (derived !== null) {
    team = { ...team, trust: derived.trust };
    // Said to a run that may launch; a caller the gate refused is told only its refusal.
    if (named) stderrLine(`team up: ${plainText(derived.warning)}\n`);
  }

  const recorded = readState(dir).sessions[session];
  const workspaces = sources.workspaces?.(session) ?? null;
  // What each recorded seat's pane holds, read from its pane: what decides whether the seat is
  // still the seat, or whether it must be launched again. Only a running session has panes, and
  // a herdr that can't tell gives null — read exactly as a seat with no record.
  const processes: Record<string, PaneProcesses | null> = {};
  const movedProcesses: Record<string, PaneProcesses | null> = {};
  if (state === 'running' && sources.launch?.processInfo) {
    const readProcess = sources.launch.processInfo;
    for (const [name, held] of Object.entries(recorded?.seats ?? {})) {
      // A pane with no recorded identity is read too: a bare shell is visible without one.
      // The close path still requires the identity; this reading only lets the plan say so.
      if (held.pane) processes[name] = readProcess(session, held.pane);
    }
    // A ready seat the host moved: the pane naming it is read when the recorded pane holds no
    // process at all, exactly one agent names the seat, and that agent's live session is the
    // recorded conversation. The plan proves the same tie again; this reading lets it adopt the
    // moved pane's process identity.
    if (agents !== null) {
      for (const [name, held] of Object.entries(recorded?.seats ?? {})) {
        const seat = team.seats.find((item) => item.name === name);
        if (!seat || held.stage !== 'ready' || !held.launched || !held.pane || !held.workspace) continue;
        if ((processes[name] ?? null) !== null) continue;
        if (agents.some((agent) => agent.pane === held.pane)) continue;
        const named = agents.filter((agent) => agent.name === name);
        if (named.length !== 1) continue;
        const candidate = named[0];
        if (candidate === undefined || candidate.session === undefined || candidate.session === '') continue;
        const continuity = continuityIdOf(
          recordedSeatContinuity({ home: sources.home, root, herdrSession: session, seat, state: held }),
          held,
        );
        if (continuity === null || candidate.session !== continuity) continue;
        movedProcesses[name] = readProcess(session, candidate.pane);
      }
    }
  }
  const readings = loadReadings(dir);
  const spend = loadSpendReadings(dir);
  // What makes a standing that is not verified safe is not the defaults' own values —
  // `defaultBudgets` names no account, and `seatBudget` reads it `clear`: permissive as a
  // value. It is the ordering: the refusal above is carried into every exit below, and this
  // guard keeps the planning pass from consulting a budget at all, so a file no approval
  // covers
  // buys nothing from the budget, not even a mark in a dry run's plan.
  const budgetGate = sources.seatBudget ?? seatBudget;
  const budgetOf = (seat: (typeof team.seats)[number]) =>
    standing.kind === 'verified' ? budgetGate(budgets, readings, seat, readAt(), spend) : { kind: 'clear' as const };
  // One writer per run: a seat's provisional line on a terminal, its one final record either
  // way, and every other line of the run on stderr, after the record it belongs to. It exists
  // from here, before the planning pass, because the launch-line note is one of its detail lines.
  // It is handed the raw pair on purpose: the writer cleans its own fields and draws its own
  // `\r\x1b[K` on a TTY, and the cleaned pair would strip those bytes. Under `--json` the same
  // writer feeds the document instead of the terminal: the final records are kept whole, in
  // order — the last one is the run's `action_summary` — and every other line is a note. The
  // provisional lines are off (nothing is a terminal in that mode).
  const finalRecords: string[] = [];
  const records = progressWriter({
    stdout: (text) => {
      if (!json) {
        io.stdout(text);
        return;
      }
      for (const line of text.split('\n')) if (line !== '') finalRecords.push(line);
    },
    stderr: (text) => {
      if (json) collect(text);
      else io.stderr(text);
    },
    isTTY: json ? false : (io.stdoutIsTTY ?? false),
  });
  const seats: UpSeat[] = [];
  const refused = new Set<string>();
  // The entity model rule, read at the first seat this run would launch and kept for the rest:
  // a run with nothing to start reads no policy.
  let launchRule: EntityModelRule | null = null;
  const ruleOf = (): EntityModelRule => (launchRule ??= readEntityModelRule(sources.home, team));
  for (const seat of team.seats) {
    const planned = seatPlan(
      standing,
      team,
      seat,
      recorded?.seats[seat.name],
      agents,
      workspaces,
      state === 'running',
      root,
      sources.home,
      session,
      processes,
      movedProcesses,
      (pane) => sources.launch?.paneText(session, pane) ?? null,
      // A passed delegation is not the owner, pane or seat. Every other caller keeps today's
      // reading: anyone but a seat.
      delegated === null && caller.kind !== 'seat',
      true,
      // The seat this run is inside: a proven drift on it is refused where the plan is built,
      // before any close can reach the pane that holds this process.
      caller.kind === 'seat' ? caller.name : null,
      rulesOriginOf(loaded.source),
    );
    // The granted seat's own pane is not relaunched and not closed. The skip is the whole of
    // that seat's plan, including a repair the owner's `up` would have performed.
    if (grantedSeat !== null && seat.name === grantedSeat) {
      seats.push({
        ...planned,
        grantKeep: 'left as it is; a granted up does not relaunch or close the orchestrator\'s seat',
      });
      continue;
    }
    // A stopped seat, a human's pane, one without a profile, and one already ready are left out
    // of the budget. A seat resumed into a live workspace starts nowhere new, but its reading is
    // still said.
    if (planned.human || planned.unidentifiedHold || planned.sessionDoubt || planned.stopped || !profileFor(seat.cli) || planned.stage === 'ready') {
      seats.push(planned);
      continue;
    }
    const placed = planned.stage === undefined || !planned.pane;
    // The entity model rule's word on the model this line names, read before the workspace is
    // made. The planned line is the one the launch runs — the file's, or the registry's recorded
    // line for a restored seat. A seat resumed into an existing pane starts nothing now, so its
    // line is not judged.
    const policyProblem = placed
      ? launchRefusal({ name: seat.name, role: seat.role, cli: planned.cli, launch: planned.launch }, ruleOf())
      : null;
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
      if (dry) {
        if (json) collect(note);
        else out.stdout(`${plainLine(note)}\n`);
      } else records.detail(note);
    }
    // The plan, the record and the log hold the reason in words (`record`); the full finding —
    // the start folder it names — rides along as the record's stderr detail only.
    const launchProblem =
      line?.level === 'miss'
        ? {
            launchProblem: line.record ?? line.why,
            ...(line.record ? { launchProblemDetail: line.why } : {}),
          }
        : policyProblem === null
          ? {}
          : { launchProblem: policyProblem };
    if (!placed) {
      const budget = budgetOf(seat);
      seats.push({ ...planned, ...launchProblem, ...(budget.kind === 'clear' ? {} : { budget }) });
      continue;
    }
    const start = seatStart({ ...team, session }, seat, root, sources.home);
    if ('problem' in start) {
      if (!start.once || !refused.has(start.problem)) {
        refused.add(start.problem);
        refusals.push({ id: 'up.placement', message: start.problem });
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
  // The policy this run resolved per seat, cached before any writer runs: a later writer must
  // use what the launch actually ran, never re-read a record an earlier writer may have changed.
  const plannedByName = new Map(seats.map((planned) => [planned.name, planned]));
  let verifiedLobby: string | null = null;
  let lobbySeen: LobbySeen | null = null;
  let createLobby = false;
  // Paths a shipped CLI reads at start. The set does not depend on which seats this run
  // starts: another team's CLI may read a file this team does not launch.
  const startupReads = shippedStartupReads();
  if (isMigratedTrust(team.trust)) {
    // Only a fresh seat whose start is the lobby. A lead starts in the project and does not
    // open this folder; a seat already ready is not launched again.
    const launchingIntoLobby = seats.some((seat) => {
      if (!seat.lobby || seat.unidentifiedHold || seat.stopped || seat.launchProblem) return false;
      if (!profileFor(seat.cli)) return false;
      const fresh = seat.stage === undefined || !seat.pane || (seat.stage === 'launched' && !seat.agentLive);
      if (!fresh) return false;
      return seat.budget?.kind !== 'refuse';
    });
    if (launchingIntoLobby) {
      for (const text of startupReadRefusals) refusals.push({ id: 'up.doctor', message: text });
    }
    // Every migrated run checks links and ownership. A file a CLI reads at start is refused
    // only when a seat is about to start in the lobby.
    // Read-only: a refusal stops the run before anything is made, and the run lock below is
    // held before the first write. A lobby that is simply absent is not a refusal here — the
    // creating pass runs under the lock (`createLobby`). Making it here, as this once did, is
    // the run's first filesystem effect outside the lock, and two fresh runs can both see the
    // lobby absent: the loser's mkdir meets the winner's component and `verifyLobby` turns the
    // EEXIST into a refusal the losing run never earned (`lobby/gate.ts`, the create branch).
    const gate = verifyLobby(sources.home, {
      create: false, getuid: sources.getuid, fs: sources.fs,
      reads: launchingIntoLobby ? startupReads : [], lobby: teamLobby,
    });
    if (!gate.ok) refusals.push({ id: 'up.lobby', message: gate.text });
    else if ('path' in gate) {
      verifiedLobby = gate.path;
      lobbySeen = { path: gate.path, dev: gate.dev, ino: gate.ino, files: gate.files };
      for (const seat of seats) if (seat.lobby) seat.cwd = gate.path;
    } else if (launchingIntoLobby) createLobby = !dry;
  }
  // The team's event bus: started beside the watch unless the file sets `bus.autostart: false`,
  // and only when the bus does not already answer. A world that cannot probe it plans none.
  const startBus = team.bus?.autostart !== false && sources.busAlive !== undefined;
  const busAlive = startBus ? await sources.busAlive!(root) : false;
  const watch = recorded?.watch;
  // Which watch owns this route now. A hosted watch the daemon carries — anything but standing
  // by — is doing the job, and this run starts no second one beside it. Otherwise the pane
  // record decides: a live process with a fresh beat is left alone, a dead or missing one starts
  // one, and a live process behind an old beat is stale and the plan replaces it. A daemon
  // reading that cannot say whether a hosted watch exists starts nothing.
  const daemon = sources.daemonHealth === undefined ? undefined : await sources.daemonHealth(sources.home);
  const sitting = watchSitting({
    daemon,
    root,
    pane: watch,
    alive: (pid) => sources.alive?.(pid) ?? false,
    now: (sources.now?.() ?? new Date()).getTime(),
    interval: watchInForceOf(standing, team).interval,
  });
  const paneHealth = sitting.kind === 'hosted' ? null : sitting.health;
  const watchAlive = sitting.kind === 'hosted' || paneHealth?.state === 'live';
  // A live pid behind an old beat is only the watch's when the pane its own record names still
  // shows it as that pane's process. A pid alone cannot tell a reused process from the watch, so
  // an unprovable record is held: nothing is signalled and no replacement is started.
  const identity = paneHealth?.state === 'stale' && paneHealth.pid !== null
    ? watchIdentity(
        { pid: paneHealth.pid, ...(paneHealth.pane ? { pane: paneHealth.pane } : {}) },
        {
          alive: (pid) => sources.alive?.(pid) ?? false,
          processInfo: (pane) => sources.launch?.processInfo?.(session, pane) ?? null,
        },
      )
    : null;
  const watchPid = identity?.kind === 'verified' ? identity.pid : null;
  const watchHold = sitting.kind === 'pane' && identity?.kind === 'unproven'
    ? `watch: ${identity.why}; nothing was signalled and no replacement is started`
    : null;
  const watchUnknown = sitting.kind === 'unknown' && !watchAlive;
  // The watch starts in `root` and runs `watch` with no `--file`. When that load would miss
  // this file, or read another one, the resolved path is recorded for the pane.
  const watchFile = watchWouldRead(root, loaded.path, sources.home) ? undefined : loaded.path;
  // The seats' own state hooks: a settings file per seat, named at the end of its launch line.
  // A dry run plans the map it would write; the real run writes the files below, before the
  // plan is built, and a seat whose file did not land launches exactly as the file declares.
  const hookSeats = (fresh: readonly string[] = []) => seats.map(({ name, cli, launch, human }) => ({
    name, cli, launch,
    ...(human ? { human: true as const } : {}),
    ...(fresh.includes(name) ? { fresh: true as const } : {}),
  }));
  let cliHooks = plannedCliHooks(dir, session, hookSeats());
  // Built where it is needed: on a dry run, just below, before anything is made; on a real run,
  // after the lock, so the lobby made there under it is already every lobby seat's `cwd`.
  const buildPlan = () => upPlan({
    root,
    session,
    // A stopped session this team records was marked absent above, and this plan starts it.
    // One that is still `stopped` here is not this team's: the refusal already stopped the run.
    sessionRunning: state === 'running' || state === 'stopped',
    seats,
    watchLabel: watchLabel(team.project),
    watchAlive,
    ...(watchPid !== null ? { watchPid } : {}),
    ...(watchHold !== null ? { watchHold } : {}),
    ...(watchUnknown ? { watchUnknown: true } : {}),
    watchLine: (sources.watchCommand ?? watchCommand)(session),
    ...(watchFile ? { watchFile } : {}),
    ...(startBus ? { startBus, busAlive, busLabel: busLabel(team.project), busLine: (sources.busCommand ?? busCommand)() } : {}),
    teamFile: loaded.path,
    cliHooks,
    ...(noLaunch ? {} : { briefEpochs: currentBriefEpochs(dir, session) }),
    home: sources.home,
    // A launch surface with no endpoint seam plans none: the marker is what makes the launch
    // start one, and a scene's fake launch must never reach a real process.
    ...(sources.launch?.codexEndpoint === undefined ? {} : { stateDir: dir }),
  });

  // A dry run only reports a CLI whose trust record is unknown. The real run writes
  // the records below, after the lobby exists.
  const stampLobbyTrust = (write: boolean) => {
    const now = sources.now?.() ?? new Date();
    for (let index = 0; index < seats.length; index++) {
      const seat = seats[index];
      if (!seat) continue;
      const line = lobbyPretrustLine(seat, sources.home, { write, now });
      if (line) seats[index] = { ...seat, launchProblem: line };
      // The project root, for a seat that starts there: pre-accepted in its CLI's own record.
      // A start folder under a charter root is pre-accepted the same way, wherever it sits.
      else if (write) {
        projectRootPretrust(seat, sources.home, { now, root });
        charterFolderPretrust(seat, sources.home, { now, store: sources.ownerSeatStore });
      }
    }
  };

  // A run an entity create-grant admitted trusts the folders its own seats start in — the project,
  // for a lead — in each seat CLI's record: no one is at a terminal to answer that CLI's folder
  // dialog. A folder is written only when the grant's paths cover it and the file's `trust:` lists
  // it. The owner at a terminal, and every caller the grant does not admit, write nothing here.
  const stampGrantedTrust = () => {
    if (!createGranted || ordinaryAdmitted) return;
    const now = sources.now?.() ?? new Date();
    const grant = {
      covers: (folder: string) => entityGrantAdmits(root, io, { home: sources.home, now, cwd: folder }),
      listed: (folder: string) => insideTrust(folder, team.trust ?? [], root, sources.home),
    };
    for (const seat of seats) grantedFolderPretrust(seat, sources.home, { now, grant });
  };

  // Dev mode says the no-approval lines and the caller-placement line once, as a warning,
  // and mounts. Every other refusal stays a refusal. Unset, the list is unchanged. A policy
  // says which level set it — but only when a gate actually folded: an admitted run owes no
  // warning and no provenance mark, whatever set dev mode.
  const foldedLine = dev.on ? devWarningLine(refusals, standing, caller) : '';
  const warning = foldedLine;
  // The one override sentence every lifecycle command prints, its tail included.
  const folded = warning ? devModeCallerGate(dev, warning) ?? warning : '';
  // A grant or delegate gate that folded its own approval comes with the line the gate
  // returned: the refusal's words, the live file that counted, the fold. It printed where the
  // gate is used, so it is one more warning line beside the caller's, never wrapped again.
  const gateApproval = gates?.approval ?? null;
  const warnings: string[] = [...(folded ? [folded] : []), ...(gateApproval === null ? [] : [gateApproval])];
  // The audit line each fold owes: written where the gate is used, on a real run, whether a
  // later refusal stops the start or it goes on. A dry run decides nothing and logs none.
  if (!dry) {
    if (folded) logDevMode(dir, 'up', callerLabel(caller), folded, sources.now?.() ?? new Date());
    if (gateApproval !== null) {
      logDevMode(gates?.approvalDir ?? dir, 'up', callerLabel(caller), gateApproval, sources.now?.() ?? new Date());
    }
  }

  if (dry) {
    stampLobbyTrust(false);
    if (!json) {
      for (const line of warnings) out.stdout(`! ${plainText(line)}\n`);
      // The same cause can reach the list twice — the gate and `doctor` both read the
      // approval — so a refusal is said once. A refusal leaves through the real run's
      // return below, so the status and the exit id are that refusal's; the words stay these.
      const said = uniqueRefusals(refusals).map((refusal) => refusal.message);
      for (const refusal of said) out.stdout(`! up would refuse: ${plainText(refusal)}\n`);
      // A caller the run does not admit is the one refusal with a command of its own behind it:
      // nothing in the file changes it, the owner's run does. So the dry run names that command.
      if (said.includes(placementRefusal(caller))) {
        out.stdout(`! to unblock: ${plainText(unblockingUpRun(args.values))}\n`);
      }
      out.stdout(plainText(formatPlan(buildPlan())));
    }
  }
  if (refusals.length) {
    // Under `--json` the run's first refusal is the document's: its contract row, its sentence.
    // A dev-mode warning rides in the same sentence, so it is not lost in the envelope.
    if (json) {
      const first = refusals[0]!;
      const lead = warnings.map(plainText).join('; ');
      const message = lead === '' ? plainText(first.message) : `${lead}; ${plainText(first.message)}`;
      refuse(io, true, 'up', { id: first.id, message, repair: first.repair ?? null });
    } else if (!dry) {
      for (const line of warnings) out.stderr(`team up: ${plainText(line)}\n`);
      for (const refusal of uniqueRefusals(refusals)) out.stderr(`team up: ${plainText(refusal.message)}\n`);
    }
    // exit: up.never-approved
    // exit: up.doctor
    // exit: up.machine
    // exit: up.herdr
    // exit: up.stopped
    // exit: up.agents
    // exit: up.unknown
    // exit: up.placement
    return 1;
  }
  if (!dry) for (const line of warnings) stderrLine(`team up: ${plainText(line)}\n`);
  if (dry) {
    if (json) {
      // The plan is the document's: the warning first when there is one, then one step per
      // plan line, each with the prefix the terminal draws (`+`, `!`, `skip`).
      const plan: PlanStep[] = [
        ...warnings.map((line) => ({ step: 'warning' as const, detail: line, prefix: '!' as const })),
        ...planStepsOf(buildPlan()),
      ];
      writeJson(io, 'team.up', {
        format: 1,
        dry_run: true,
        ...(noLaunch ? { no_launch: true } : {}),
        status: 'dry-run',
        action_summary: 'dry run: nothing was run',
        project: team.project,
        session,
        seats: [...new Set(team.seats.map((seat) => seat.name))],
        plan,
        notes: jsonNotes,
      });
    }
    // exit: up.dry-run
    return 0;
  }
  const launch = sources.launch;
  if (!launch) {
    refuse(io, json, 'up', {
      id: 'up.no-launch',
      message: 'this call has no way to reach herdr',
      repair: null,
    });
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
  // A caller that already holds the session's run lock (the daemon's restore sweep) passed it
  // in: this run neither takes nor releases it, and the sweep's own release is the one that
  // ends the hold.
  const runLock = internal?.lockHeld === true ? null : acquireRunLock(dir, session);
  if (runLock !== null && 'held' in runLock) {
    refuse(io, json, 'up', {
      id: 'up.run-lock',
      message: plainText(runLockText(runLock.held, session, dir)),
      repair: null,
    });
    // exit: up.run-lock
    return 1;
  }
  try {
    // The audit line of a delegated run: the gate passed it and this run is about to have effects,
    // so the delegation is on the record before the first workspace is made. A dry run returned
    // above and writes nothing; a run that refused never got here.
    if (delegated !== null) (sources.logDelegated ?? logDelegated)(dir, delegated, 'up', sources.now?.());
    // The granted seat's line, at the same moment: the gate passed and this run is about to
    // have effects, before the first workspace is made.
    if (grantedSeat !== null) (sources.logGranted ?? logGranted)(dir, grantedSeat, 'up', sources.now?.());
    // Provenance for an owner-token launch: the caller that ran it, and that the owner authorized
    // it out of band for this approved record.
    if (ownerToken) logLine(dir, 'up', callerLabel(caller), 'owner-token-authorized', sources.now?.() ?? new Date());
    if (ownerSeat) logLine(dir, 'up', callerLabel(caller), 'owner-seat-approved', sources.now?.() ?? new Date());
    // The client's grant is read once more under the grant lock, immediately before the first
    // effect: a revocation appended since the check at the top stops this run here, and a run that
    // passes writes its audit line while it still holds the lock, so one of the two is always first.
    if (clientUp !== null) {
      const at = sources.now?.() ?? new Date();
      const held = clientUp;
      let standing: string | null;
      try {
        standing = withClientGrantLock(sources.home, () => {
          const still = activeClientUpGrant(sources.home, { grant: held.grant, signature: held.signature }, at);
          if (!still.ok) return still.why;
          logLine(dir, 'up', `client:${held.grant.clientId}`, `client-up-authorized: grant ${held.grant.grantId} client ${held.grant.clientId} team ${held.grant.up.project} root ${held.grant.up.root} request ${held.requestId}`, at);
          return null;
        });
      } catch {
        standing = 'the client grant lock could not be taken';
      }
      if (standing !== null) {
        logLine(dir, 'up', `client:${held.grant.clientId}`, `client-up-refused: grant ${held.grant.grantId}: ${standing}`, at);
        return clientRefused(io, json, standing);
      }
    }

    if (createLobby) {
      // The run's first write, under the lock: the lobby the read-only pass above found absent.
      // Serialised here, no competing mkdir can turn into this run's refusal, and this run's own
      // make cannot land on another run's — which is what the read-only pass exists for.
      const gate = verifyLobby(sources.home, { create: true, getuid: sources.getuid, fs: sources.fs, reads: startupReads, lobby: teamLobby });
      if (!gate.ok) {
        refuse(io, json, 'up', { id: 'up.lobby', message: plainText(gate.text), repair: null });
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
        refuse(io, json, 'up', {
          id: 'up.clear',
          message: `session ${session} is stopped and did not clear`,
          repair: null,
        });
        // exit: up.clear
        return 1;
      }
    }
    // Built after the make above: the lobby it may have made is every lobby seat's `cwd`.
    // The trust record is written for that path, before the workspace, and a seat whose
    // record cannot be written is left out of the launch.
    stampLobbyTrust(true);
    stampGrantedTrust();
    // The general seat brief goes first: one signed drop in the folder of every seat this plan
    // launches or relaunches, and of every declared seat the session records no launch of that
    // does not already hold a ready claim for this brief. A seat the state records as already
    // launched, which this run leaves as it is, is left exactly so: no drop and no state entry. A
    // delivery that cannot be written is said and logged, and the launch goes on; `team check`
    // names the seat with no record. The plan is built here with the planned settings map — the
    // launch set does not depend on the files — so the claim exists before the settings files are
    // written below, which name the epoch it was delivered under.
    const planned = buildPlan();
    const launchedSeats = planned.flatMap((step) => (step.do !== undefined && step.do.do === 'launch' ? [step.do.seat] : []));
    // A declared seat this session never launched is delivered to only until it holds a ready
    // claim for this build's brief: an unchanged second run leaves that claim and its drop as
    // they are, while a missing, failed or older claim is delivered again.
    const claimStands = (name: string): boolean => {
      const claim = currentBriefClaim(recorded?.briefs?.[name]);
      return claim !== null && claim.stage === 'ready' && claim.sha256 === GENERAL_BRIEF_SHA256;
    };
    const briefSeats = noLaunch ? [] : team.seats
      .filter((seat) => launchedSeats.includes(seat.name)
        || (recorded?.seats[seat.name] === undefined && !claimStands(seat.name)))
      .map((seat) => seat.name);
    // `--no-launch` is a quiet start: a team hold stands so the watch types nothing automatic
    // (no unread wake, no ring, no work offer) until `team hold --release`. A hold already
    // standing is kept as it is.
    if (noLaunch) {
      try {
        const placedAt = sources.now?.() ?? new Date();
        updateState(dir, (state) => {
          if (liveHold(state, placedAt) !== null) return;
          state.hold = { reason: QUIET_HOLD_REASON, by: callerLabel(caller), at: placedAt.toISOString() };
        });
      } catch (error) {
        stderrLine(`team up: the quiet-start hold was not placed (${plainText(error instanceof Error ? error.message : String(error))})\n`);
      }
    }
    // `--no-launch` delivers no brief at all: not to the launched seats, not to a seat behind.
    if (!noLaunch) {
      const briefs = deliverBriefForAttribution({
        dir,
        root,
        session,
        home: sources.home,
        now: sources.now?.() ?? new Date(),
        team,
        state: recorded ?? emptySession(),
        attributed: briefSeats,
      });
      await walkBriefDeliveries(briefs, { dir, home: sources.home });
      for (const delivery of briefs.deliveries) {
        if (delivery.ok) continue;
        const said = `${delivery.seat}: the general seat brief was not delivered (${delivery.reason})`;
        stderrLine(`team up: ${said}\n`);
        logLine(dir, 'up', callerLabel(caller), said, sources.now?.() ?? new Date());
      }
      if (briefs.recording !== undefined) {
        const said = `the general seat briefs were written and not recorded (${briefs.recording})`;
        stderrLine(`team up: ${said}\n`);
        logLine(dir, 'up', callerLabel(caller), said, sources.now?.() ?? new Date());
      }
    }
    // The binding each planned seat holds before this install mints its successor. A seat whose
    // line never runs keeps it; one this install creates goes back out without a record.
    const beforeInstall = readState(dir).sessions[session]?.seats ?? {};
    const priorBindings = new Map(launchedSeats.map((name) => [name, beforeInstall[name]?.presence_binding]));
    // The settings files land before the plan types a line, so every launch carries its flag. A
    // seat whose file did not land is said once, in the log, and its launch is the plain line.
    const installed = installCliHooks(dir, session, hookSeats(launchedSeats), { project: team.project, root, home: sources.home });
    for (const name of Object.keys(cliHooks)) {
      if (installed[name] === undefined) {
        logLine(dir, 'up', callerLabel(caller), `${name}: no state hook written; its launch line is the file's own`, sources.now?.() ?? new Date());
      }
    }
    cliHooks = installed;
    // The successor binding this install minted for each launch, when it is not the one the seat
    // already held. The settings files name it, and a repair's close drops the state record the
    // install put it on: this map is the only copy left for a process that runs to carry.
    const afterInstall = readState(dir).sessions[session]?.seats ?? {};
    const mintedBindings = new Map<string, string>();
    for (const name of launchedSeats) {
      const held = afterInstall[name]?.presence_binding;
      if (held !== undefined && held !== priorBindings.get(name)) mintedBindings.set(name, held);
    }
    const plan = buildPlan();
    // A relaunch starts from no reading at all: the `working` a killed turn left behind says
    // nothing about the seat this run starts.
    resetCliHookState(dir, session, launchedSeats);

    // Every launch uses the limits declared in the live file, with or without a stored approval.
    const ceilings = ceilingsOf(team);
    const running: Running[] = [];
    // The planned seats whose launch line the pane actually ran (`sessionStarted`).
    const startedSeats = new Set<string>();
    // The seats whose state entry the plan took away before their line ran — a repair closes the
    // old pane and drops the record first.
    const droppedSeats = new Set<string>();
    // The pane each seat's state held when a close this run confirmed took that entry away: the
    // negative boundary a launch is read against. A closed pane is never the route the registry
    // keeps, and the pane a later line started on is told apart from it here.
    const closedPanes = new Map<string, string | undefined>();
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
    const concurrency = launchConcurrency(machine, team.machine, args.flags.has('serial'));
    const rawSleep = sources.sleep ?? launch.sleep;
    const sleepAt = new Map<string, Promise<void>>();
    const sharedSleep = (ms: number): Promise<void> => {
      if (concurrency <= 1) return rawSleep(ms);
      const key = `${now().getTime()}:${ms}`;
      const existing = sleepAt.get(key);
      if (existing) return existing;
      const promise = rawSleep(ms).finally(() => sleepAt.delete(key));
      sleepAt.set(key, promise);
      return promise;
    };
    /** Writes a seat's waiting record, with the process identity read in the same write. The
     *  pause's own `[s]` and a run with no terminal (the daemon's restore sweep, a `keep` dialog)
     *  both leave a seat this way: the next `up` reads it as a waiting seat, not an idle pane. */
    const writeWaiting = (name: string, waiting: WaitingRecord, pane: string, workspace?: string): void => {
      updateState(dir, (file) => {
        const current = (file.sessions[session] ??= emptySession());
        const prior = current.seats[name] ?? { stage: 'launched' as const };
        const retained = current.retained_seats?.[name];
        if (current.retained_seats?.[name]) delete current.retained_seats[name];
        const id = prior.id ?? retained?.id ?? mintSeatId();
        const identity = launchedIdentity(launch.processInfo?.(session, pane) ?? null);
        current.seats[name] = {
          ...prior,
          id,
          waiting,
          pane,
          ...(workspace ? { workspace } : {}),
          ...(identity ? { launched: identity } : {}),
        };
      });
    };
    const host: Host = {
      startServer: launch.startServer,
      sessionUp: launch.sessionUp,
      createWorkspace: launch.createWorkspace,
      // The lobby is read again directly before each workspace this run makes in it, with nothing
      // in between (`execute.ts`). Null when it is still the folder the gate read and every file
      // it allowed still the file it read. The declared files travel with it, so the recheck
      // walks the same closed tree the gate did.
      confirmLobby() {
        return lobbySeen ? recheckLobby(sources.home, lobbySeen, { getuid: sources.getuid, fs: sources.fs, reads: startupReads, lobby: teamLobby }) : null;
      },
      paneRun: launch.paneRun,
      ...(launch.codexEndpoint === undefined
        ? {}
        : {
            managedCodexEndpoint: (input: { dir: string; session: string; seat: string; cwd?: string }) => launch.codexEndpoint!.managed(input),
            stopManagedCodexEndpoint: (input: { dir: string; session: string; seat: string }) => launch.codexEndpoint!.stop(input),
          }),
      ...(launch.registerInbox
        ? { registerInbox: (cli: string, seat: string, cwd: string, teamFile?: string) => launch.registerInbox!(cli, seat, cwd, teamFile) }
        : {}),
      ...(launch.reportDisplayAgent
        ? { reportDisplayAgent: (session: string, pane: string, text: string) => launch.reportDisplayAgent!(session, pane, text) }
        : {}),
      ...(launch.renameWorkspace
        ? { renameWorkspace: (session: string, workspace: string, label: string) => launch.renameWorkspace!(session, workspace, label) }
        : {}),
      typeLine: () => false,
      deliverRules: async (session, pane, cli, planned, seconds) => {
        // A quiet start (`--no-launch`) adds its stop instruction to the rules file itself, so the
        // typed line keeps its ordinary length and shape — only the hash it names changes.
        const file = noLaunch ? quietRulesDelivery(planned) : planned;
        // The rules go to the file first; nothing is typed until it holds them. The writer
        // builds the path itself, from the live project and the seat's name — the same folder
        // the typed line names.
        const written = writeRulesFile(
          standing,
          file.seat,
          root,
          sources.home,
          file.text,
          rulesFileHash(file.text),
          undefined,
          team.project,
        );
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
          ...(launch.sendKey
            ? { key: (name: string) => launch.sendKey!(session, pane, name) }
            : {}),
          // The last look before Enter: the file, read without following a link, must still hold
          // the text whose hash the line names.
          file: () => rulesFileHolds(file.path, rulesFileHash(file.text)),
          foreground: () => launch.foreground(session, pane),
          report: (why) => { stopped.why = why; },
          now: () => now().getTime(),
          sleep: sharedSleep,
        });
        return delivered === false && stopped.why !== null ? stopped.why : delivered;
      },
      renameAgent: launch.renameAgent,
      closeWorkspace: launch.closeWorkspace,
      stopSession: (session) => launch.stopSession?.(session) ?? false,
      kill: (pid) => launch.kill?.(pid) ?? false,
      // The replacement's exit wait reads the same process table the plan did.
      alive: (pid) => sources.alive?.(pid) ?? pidAlive(pid),
      agentPanes: launch.agentPanes,
      agentList: launch.agents,
      // The session's workspaces with their labels now; the pause compares the label of the pane's
      // live workspace with the one this seat's launch gives (`pause.ts`, `waitingProblem`).
      workspaces: () => sources.workspaces?.(session) ?? null,
      // The proof a waiting pane is asked for looks at the session's seat records (`pause.ts`,
      // `waitingProblem`): a record for a seat the file no longer declares names no pane of this
      // team's, and does not block the seat that now stands there (`seatOfFile`).
      seatStates: () => {
        const seats = readState(dir).sessions[session]?.seats ?? null;
        if (seats === null) return null;
        const declared = new Set(team.seats.map((seat) => seat.name));
        return Object.fromEntries(Object.entries(seats).filter(([name, seat]) => seatOfFile(name, seat, declared)));
      },
      workspacePanes: launch.workspacePanes ? (session, workspace) => launch.workspacePanes!(session, workspace) : undefined,
      classify: (name, pane, cli) => readScreen(cli, launch.paneText(name, pane) ?? undefined).kind,
      paneText: (session, pane) => launch.paneText(session, pane),
      foreground: (session, pane) => launch.foreground(session, pane),
      shellBack: (session, pane) => launch.shellBack?.(session, pane) ?? null,
      agentStatus: (session, pane) => launch.agentStatus?.(session, pane) ?? null,
      processInfo: (session, pane) => launch.processInfo?.(session, pane) ?? null,
      sleep: sharedSleep,
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
        if (!seat) return null;
        return overCeiling(ceilings, running, seat);
      },
      record(name, patch) {
        let replaced: string | undefined;
        updateState(dir, (file) => {
          const current = (file.sessions[session] ??= emptySession());
          const prior = current.seats[name] ?? { stage: patch.stage };
          const retained = current.retained_seats?.[name];
          if (current.retained_seats?.[name]) delete current.retained_seats[name];
          const id = prior.id ?? retained?.id ?? mintSeatId();
          const isSkipReady = current.seats[name]?.stage === 'ready' && patch.stage === 'ready';
          const declared = team.seats.find((seat) => seat.name === name);
          // The policy this run kept or launched with: the bound record's model, version and
          // base recipe where the plan resolved them, the declaration otherwise. A keep writes
          // it back like a launch, so the next recognition compares against what is on the pane
          // and never against a declaration this run did not use.
          const effective = declared === undefined ? undefined : effectiveSeatOf(declared, plannedByName.get(name));
          // The CLI the seat was launched with: `down` needs it when the file no longer names the seat.
          const cli = declared?.cli ?? prior.cli;
          const model = effective?.model ?? prior.model;
          const version = effective?.version ?? prior.version;
          const effort = isSkipReady ? prior.effort : (declared?.effort ?? prior.effort);
          const launch_line = effective?.launch ?? prior.launch_line;
          const last_active = patch.stage === 'ready'
            ? now().toISOString()
            : (prior.last_active ?? retained?.last_active);
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
          // `effort: null` is a launch that set no word: the stored word goes with it.
          const { waiting: written, effort: patchedEffort, ...rest } = patch;
          const seat: SeatState = {
            ...prior,
            ...rest,
            id,
            ...(cli ? { cli } : {}),
            ...(model ? { model } : {}),
            ...(version ? { version } : {}),
            ...(effort ? { effort } : {}),
            ...(launch_line ? { launch_line } : {}),
            ...(last_active ? { last_active } : {}),
            ...(start_cwd ? { start_cwd } : {}),
          };
          if (written === null) delete seat.waiting;
          else if (written) seat.waiting = written;
          if (patchedEffort === null) delete seat.effort;
          else if (patchedEffort !== undefined) seat.effort = patchedEffort;
          // A new pane is a new process. The identity the previous pane was launched under does
          // not move with the seat: a later `up` would treat those pids as this pane's, and
          // either refuse a healthy seat or adopt a stranger. A patch that names the new
          // identity writes it; one that does not leaves the field empty until the pane is read.
          if (patch.pane && prior.pane && patch.pane !== prior.pane && rest.launched === undefined) delete seat.launched;
          current.seats[name] = seat;
          if (patch.pane) {
            replaced = prior.pane !== patch.pane ? prior.pane : undefined;
            current.launched_file = loaded.path;
          }
        });
        if (patch.pane) {
          if (replaced) forgetLaunchedPane(sources.home, replaced, session);
          noteLaunchedPane(sources.home, loaded.path, patch.pane, session);
        }
      },
      // A seat found at a dialog by a run with no terminal (`keep`): the wait is recorded and
      // the seat left for a lead to finish, exactly as `team restart` and `team add` leave one.
      recordWaiting(name, waiting, pane, workspace) {
        writeWaiting(name, waiting, pane, workspace);
      },
      // The session registry records the launch itself, with the id TeamCLI set where the CLI
      // takes one; a registry that cannot be written is a note in the run's log, never a refusal.
      sessionStarted(name, started) {
        const declared = team.seats.find((item) => item.name === name);
        if (!declared) return;
        // The session's model and version are the effective policy the line ran, as the seat
        // record and the agent registry state it; the command and session history are the
        // launch's own reading (`started`), never rewritten from the file.
        const seat = effectiveSeatOf(declared, plannedByName.get(name));
        startedSeats.add(name);
        // The pane ran this seat's launch line: the settings file the install wrote is in a
        // process now, so its minted successor is the seat's from here on, whatever the run
        // reaches afterwards. A repair's close dropped the record the install put it on; it is
        // written back before the launch's own records, so every later record carries it.
        const successor = mintedBindings.get(name);
        if (successor !== undefined) {
          updateState(dir, (file) => {
            const one = (file.sessions[session] ??= emptySession());
            const current = one.seats[name];
            if (current === undefined) one.seats[name] = { stage: 'launched', presence_binding: successor };
            else current.presence_binding = successor;
          });
        }
        const began = beginSession({
          home: sources.home,
          root,
          team,
          session,
          seat,
          pane: started.pane,
          ...(started.workspace === undefined ? {} : { workspace: started.workspace }),
          ...(started.cli_session === undefined ? {} : { cli_session: started.cli_session }),
          ...(started.replaces === undefined ? {} : { replaces: started.replaces }),
          now: now(),
        });
        if ('note' in began) logLine(dir, 'up', callerLabel(caller), `${name}: ${began.note}`, now());
      },
      running(name) {
        if (running.some((item) => item.name === name)) return;
        const seat = team.seats.find((item) => item.name === name);
        if (seat) running.push({ name, vendor: seat.vendor, temporary: false });
      },
      drop(name) {
        let pane: string | undefined;
        updateState(dir, (file) => {
          const current = file.sessions[session];
          if (!current) return;
          const prior = current.seats[name];
          pane = prior?.pane;
          // The binding this entry holds goes out with the drop. A line that runs afterwards has
          // the successor the install minted written back by `sessionStarted`; a line that never
          // runs must not be given the closed process's binding back by the rollback below.
          droppedSeats.add(name);
          if (prior?.id && !prior.temporary) {
            (current.retained_seats ??= {})[name] = {
              id: prior.id,
              ...(prior.last_active ? { last_active: prior.last_active } : {}),
            };
          }
          delete current.seats[name];
        });
        closedPanes.set(name, pane);
        if (pane) forgetLaunchedPane(sources.home, pane, session);
      },
      // What is not a record — a skip line, a session failure, the watch's sentence — is cleaned
      // here with the same function the records use: no escape sequence or bidi override reaches
      // the terminal from a file's word, a screen's word or a folder's name.
      say: (line) => stderrLine(plainText(line)),
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record) => records.final(seat, record),
      detail: (line) => records.detail(line),
      cliVersion(cli) {
        const profile = profileFor(cli);
        if (!profile || !sources.doctor) return null;
        return sources.doctor.version(profile.binary);
      },
      log: (who, what) => logLine(dir, 'up', callerLabel(caller), `${who}: ${what}`, now()),
      noteWatchFile(pane, file) {
        updateState(dir, (state) => {
          const current = (state.sessions[session] ??= emptySession());
          current.watchdog = { file, pane };
        });
      },
      noteBus(pane, workspace) {
        updateState(dir, (state) => {
          const current = (state.sessions[session] ??= emptySession());
          current.bus = { pane, started: now().toISOString(), ...(workspace ? { workspace } : {}) };
        });
      },
      noteWatch(pane, workspace) {
        updateState(dir, (state) => {
          const current = (state.sessions[session] ??= emptySession());
          current.watch = { pane, heartbeat: now().toISOString(), ...(workspace ? { workspace } : {}) };
        });
      },
      /**
       * §3/§4: what happens to a seat this run finds at a dialog. The owner at a terminal is
       * asked, in `pause.ts`, with `o`/`s`/`q`; an owner whose stdin is not a terminal never
       * reads it — the workspace is closed without input and the record says so (§2). A delegated
       * run takes that no-terminal path whatever its stdin: it never prompts, never focuses a pane,
       * never sends a key or a text, and its idle wait's timeout is a dialog like any other stop —
       * closed without input, not left at launched. A run the daemon drives (the restore sweep)
       * has no terminal to close a workspace for and no owner to read the seat: it records the
       * wait and leaves the seat out, exactly as `team restart` and `team add` do.
       */
      dialog:
        charterGate(sources.home, { operation: 'up', cwd: root }, sources.ownerSeatStore).kind === 'admit'
          ? { mode: 'notice' }
          : internal?.nonInteractive === true
            ? { mode: 'keep' }
            : delegated !== null
              ? { mode: 'close-no-terminal', timeoutIsDialog: true }
              : caller.kind === 'owner' && clientUp === null
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
          const retained = current.retained_seats?.[input.seat];
          if (current.retained_seats?.[input.seat]) delete current.retained_seats[input.seat];
          const id = prior.id ?? retained?.id ?? mintSeatId();
          const record = change(prior.waiting);
          // The process identity is read here, at the moment the record is written, in the same
          // write: `[o]`, `[s]`, a resumed `up` and `team answer` all refuse a pane whose
          // process is gone or replaced.
          const identity = launchedIdentity(launch.processInfo?.(session, input.pane) ?? null);
          current.seats[input.seat] = {
            ...prior,
            id,
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
        if (kind === 'idle' || kind === 'working') return kind;
        if (
          kind === 'unknown'
          && (launch.shellBack?.(session, input.pane) ?? null) !== true
          && unreadIdle(launch.agentStatus?.(session, input.pane) ?? null)
        ) {
          return 'idle';
        }
        return classificationOf(kind);
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
      sleep: (ms) => rawSleep(ms),
      now: () => now().getTime(),
      idleTimeout: profileFor(seatCli(input.seat))?.idleTimeout ?? 90,
      // The key is the lead answering, and the setting is the owner's live grant: a team grant
      // carrying `dialogs.trust`, read fresh here. No file key and no approval turn it on.
      polled: dialogsTrustInForce(sources.home, root, now()) && input.classification === 'trust',
    });

    // The continuity the plan read, in one map for the close path: execute re-reads the pane and
    // must decide the same way this plan did, including a seat whose state copy names no session.
    const continuityIds = continuityIdsOf({
      home: sources.home,
      root,
      herdrSession: session,
      seats: team.seats,
      states: recorded?.seats ?? {},
    });
    // A dead bus is started in its own process, with no owner at a terminal. The up process does
    // not serve the bus: that process would die when up exits. A test leaves superviseBus unset.
    if (sources.superviseBus === true) {
      try {
        await spawnInheritedBus(root, sources.home);
      } catch {
        // The launch does not depend on the bus. A start that cannot be spawned is the daemon's
        // heartbeat to retry.
      }
    }
    const report = await executePlan(plan, session, host, {
      concurrency,
      continuityIds,
      restoreSeats: seats,
      ...(internal?.isClosing ? { isClosing: internal.isClosing } : {}),
    });
    internal?.onReport?.(report);
    // A fresh install minted a binding for every seat this run planned to launch. A seat whose
    // line ran keeps the successor `sessionStarted` wrote back. A seat whose line never ran —
    // refused before it, or its step left out — never loaded the settings file that names the
    // successor, so it keeps the binding it held. The same rule `add` and `reload` apply follows
    // here; a seat the install itself created goes back out with no record.
    //
    // A repair is the exception. Its close took the seat's state entry away, and the old process
    // went with its pane, so no process carries that binding any more: an entry the relaunch wrote
    // must not be given it back when the line never ran.
    for (const name of launchedSeats) {
      if (startedSeats.has(name)) continue;
      if (droppedSeats.has(name)) restorePresenceBinding(dir, session, name, undefined);
      else restorePresenceBinding(dir, session, name, priorBindings.get(name));
    }
    // The reach projection, after the plan's effects and outside the lobby's identity rechecks
    // (its temporary is a declared lobby file): the owner-approved `reach` grants written where
    // the bridge and the seat-shuttle daemon read them. A skip — no lobby, a lobby not 0700,
    // nothing changed — is a log line, never a refusal: the launch is done.
    const projectionNote = reachProjectionNote(writeReachProjection(team, sources.home));
    if (projectionNote) logLine(dir, 'up', callerLabel(caller), projectionNote, now());
    const afterwards = readState(dir).sessions[session]?.seats ?? {};
    // The registry follows the state this run left: a ready seat is registered, or re-pointed to
    // its pane when it was relaunched; a seat the file stops, or one not ready, is stopped. The
    // run's own dev mode is stated with the write, so a record an un-gated run registered says so
    // — and the owner's run in force, stating it false, takes any earlier mark off; anyone
    // else's write in force leaves the mark for the owner.
    for (const note of registerRun(
      {
        home: sources.home, team, root, by: callerLabel(caller), session, devMode: devModeMark(dev, warning !== ''), owner: caller.kind === 'owner',
        // The delegation this run was admitted by, on the record it writes: the owner as signer,
        // the gate's pane as actor, the one command `up` — never the pane as signer.
        ...(delegated === null ? {} : { delegated: { actor: delegated, command: 'up' as const } }),
      },
      team.seats.map((seat) => {
        const held = afterwards[seat.name];
        const readyPane = held?.stage === 'ready' ? (held.pane ?? null) : null;
        // A launch this run positively started (its line ran, `sessionStarted`) and left short of
        // ready on a pane this run did not close: the registry follows that pane, and never claims
        // ready. A created workspace alone is not this evidence, and a pane the run closed after
        // starting is not either.
        const partial = readyPane === null
          && startedSeats.has(seat.name)
          && held !== undefined
          && held.pane !== undefined
          && closedPanes.get(seat.name) !== held.pane
          ? { pane: held.pane }
          : undefined;
        // A close this run confirmed, with no live successor: the record's route is dead. That is
        // any seat whose pane this run closed and did not replace with a pane a line started on —
        // including a replaced seat whose line never ran. A refused or unproven close never gets
        // here: only a real close calls `drop`.
        const ended = readyPane === null && partial === undefined && closedPanes.has(seat.name);
        return {
          // The registry records the policy this run kept or launched with: the bound record's
          // recipe where the plan resolved one, the declaration otherwise.
          seat: effectiveSeatOf(seat, plannedByName.get(seat.name)),
          pane: readyPane,
          ...(held?.id ? { handle: held.id } : {}),
          // The same measured id the launch wrote into the seat's record: the registry keeps it
          // beside the pane, and a seat with no reading leaves the record's own id in place.
          ...(held?.agent_session ? { agent_session: held.agent_session } : {}),
          ...(partial === undefined ? {} : { partial }),
          ...(ended ? { closed: true as const } : {}),
        };
      }),
    )) logLine(dir, 'up', callerLabel(caller), note, now());
    // The address: a claude-code seat this run left ready records the socket its session answers
    // at, so a later send reaches it without re-reading herdr. A pane herdr cannot read leaves
    // whatever the record holds; the note, if any, is a log line like the registry's own.
    for (const seat of team.seats) {
      const held = afterwards[seat.name];
      if (seat.cli !== 'claude-code' || held?.stage !== 'ready' || !held.pane) continue;
      const agent = findAgent(sources.home, { team: teamIdOf(root), seat: seat.name });
      if (!agent) continue;
      const refreshed = refreshAgentAddress(sources.home, agent.id, held.pane, session);
      if (refreshed.note) logLine(dir, 'up', callerLabel(caller), refreshed.note, now());
    }
    const pending = team.seats.filter((seat) => {
      // A human's pane is left as it is: nothing this run could have made ready, nothing pending.
      if (seat.stopped || seat.human || !profileFor(seat.cli)) return false;
      return afterwards[seat.name]?.stage !== 'ready';
    });
    // The sweep's outcome summary: ready-confirmed repairs, working skips, and refusals with
    // per-seat reasons, emitted once per pass even on 0/0/0.
    const restoreSummary = restoreSummaryOf(report.restoreBuckets);
    const summaryLine = plainText(restoreSummary.line);
    const cleanedRestoreSummary: RestoreSweepSummary = {
      ...restoreSummary,
      refused_seats: restoreSummary.refused_seats.map((entry) => ({
        seat: entry.seat,
        reason: plainText(entry.reason),
      })),
      line: summaryLine,
    };
    logLine(dir, 'up', callerLabel(caller), summaryLine, now());
    if (!json) out.stderr(`${summaryLine}\n`);
    // A seat the plan left behind (a repair it would not close, a dialog it timed out at) is a
    // seat left short of ready even when its state still says ready: `held` makes that exit 1.
    const failed = pending.length > 0 || report.serverFailed || report.watchFailed || report.held;
    if (json) {
      if (failed) {
        // The run's own failure named by its row: the seats short of ready first, then what the
        // plan reported; a held step with nothing pending is the pending row too.
        const id = pending.length > 0
          ? 'up.pending'
          : report.serverFailed ? 'up.server' : report.watchFailed ? 'up.watch' : 'up.pending';
        const message = pending.length > 0
          ? `${pending.length} seat${pending.length === 1 ? '' : 's'} not ready: ${pending.map((seat) => seat.name).join(', ')} (${summaryLine})`
          : report.serverFailed ? 'the herdr server did not start'
            : report.watchFailed ? 'the watch did not start'
              : restoreSummary.refused > 0 ? summaryLine : `a step was held (${summaryLine})`;
        refuse(io, true, 'up', { id, message, repair: null });
      } else {
        writeJson(io, 'team.up', {
          format: 1,
          dry_run: false,
          ...(noLaunch ? { no_launch: true } : {}),
          status: 'ready',
          action_summary: summaryLine,
          project: team.project,
          session,
          seats: [...new Set(team.seats.map((seat) => seat.name))],
          notes: [...jsonNotes, ...finalRecords],
          restore_summary: cleanedRestoreSummary,
        });
      }
    }
    // exit: up.ready
    // exit: up.pending
    // exit: up.server
    // exit: up.watch
    return failed ? 1 : 0;
  } finally {
    if (runLock !== null && 'release' in runLock) runLock.release();
  }
}
