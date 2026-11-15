import { currentClaimIn } from '../mcp/inbox.ts';
import { messageFile } from './messages.ts';
import { traceChildStep } from '../diagnostics/child-steps.ts';
import { captureModelDriftFences, clearRepairedModelDrifts } from '../send/model-drift.ts';
import { beginBeatWork } from '../diagnostics/beat-work.ts';
import { refuseTyping } from '../send/no-pane-messaging.ts';
import { machineAccountsOf } from '../information/machine-accounts.ts';
import { createHash, randomUUID } from 'node:crypto';
import { readArgs } from '../args.ts';
import { budgetsInForceOf } from '../approve/approval.ts';
import { callerOf, describeCaller, fileOwnerRefusal, isOwner } from '../caller.ts';
import { loadReadings, overlayReadings, saveSpendReadings, updateReadings, type Seen, type SpendReading } from '../budgets/readings.ts';
import { runChecksOf, runChecksOfAsync, type CheckOutcome } from '../budgets/run.ts';
import type { ChildOptions } from '../child.ts';
import { daemonHealth } from '../daemon/health.ts';
import { canonicalRoot } from '../daemon/routes.ts';
import { currentTeam, rememberCurrent } from '../file/current.ts';
import { isParseError, launchTeamFile, loadTeamFile } from '../file/load.ts';
import { saveMachineReadings } from '../information/machine-readings.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { sameFolder } from '../send/record.ts';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentStatus, foregroundArgv0, PANE_WINDOW, paneForeground, paneProcessInfoAsync, paneProcesses, paneProcessesOf, paneRead, paneReadAsync, reportDisplayAgent, SIDEBAR_TTL_CAP_MS, workspaceRename, type PaneProcesses } from '../herdr.ts';
import { sidebarPolicy } from '../settings/sidebar-policy.ts';
import type { Command, Io } from '../io.ts';
import { isShellName } from '../launch/cli-scope.ts';
import { paneHoldsOnlyShell } from '../launch/identity.ts';
import { logLine } from '../log.ts';
import { readBacklogDepth, readQueueDepths } from '../queues.ts';
import { hasJsonFlag, writeJsonError } from '../output/index.ts';
import { emptySession, liveHold, readState, updateState } from '../state.ts';
import { waitOrStop } from '../wait.ts';
import type { Live } from '../status/compare.ts';
import { readMachine, readMachineAsync, readingsText, unreadMachine } from '../watch/machine.ts';
import type { Machine } from '../watch/machine.ts';
import { processCommOf } from '../watch/process-adapter.ts';
import { watchReadLimits, type ReadLimits } from '../watch/read-limits.ts';
import { beatWatch, ownWatchPane, placedWatch, watchRunning } from '../watch/pane.ts';
import { watchPushWork } from '../watch/direct-send.ts';
import { watchCommand } from './up.ts';
import { realHost, redeliverChannelOnSocket, runSend } from './send.ts';
import { realHost as realReplyHost, runReply } from './reply.ts';
import { relayOutboxes } from '../send/confined-outbox.ts';
import { sendDaemonDirect } from '../reminder/direct-send.ts';
import { runRestart } from './restart.ts';
import { notify } from '../watch/notify.ts';
import { dropMessage, readTriggerLine, triggerLine } from '../send/native.ts';
import { listUnacked } from './messages.ts';
import { wakeTrigger, wakeWordsFor, type WakeWords } from '../send/wake.ts';
import { deliverTypedWake, herdrTypedWakeHost, type TypedWakeResult } from '../send/typed-wake.ts';
import { labelSweep } from '../watch/label-tick.ts';
import { newMemory, NUDGE_TEXT, ownUnsent, pass, ringText, type MailboxWaiting, type Memory } from '../watch/pass.ts';
import { MailPass } from '../watch/mail-pass.ts';
import { modelRuleOfPass } from '../watch/rule-pass.ts';
import { promoteInboxDrops, retryHeldDrops } from '../watch/retry.ts';
import { expirePendingNative } from '../watch/native.ts';
import { confirmTakenDrops } from '../watch/taken.ts';
import { reportStuckSeats, reportUnreadDrops, wakeUnreadDrops } from '../watch/unread.ts';
import { readScreen } from '../watch/screen.ts';
import { dispatchIdleWork, type IdleDispatchResult, type WorkPush } from '../watch/dispatch.ts';
import type { BrokerWorkSnapshot, BrokerWorkSource } from '../idle_work.ts';
import { nativeHeldSeats, presenceUnproven, presenceWorkingSince, type PresenceUnproven } from '../watch/idle-work.ts';
import { prefetchPresence } from '../watch/presence.ts';
import { actingWatchHandover, readWatchHandover } from '../watch/handover.ts';
import type { HostedLoop } from '../watch/hosted.ts';
import { declaredUnreadAfter, unreadWindowSeconds, watchInForceWithPace, watchPaceNotes, watchPaceOf } from '../watch/rhythm.ts';
import { judgeTemporary, judgeWorktree } from '../watch/close.ts';
import { readEnd, type EndView } from '../watch/end.ts';
import { reportedLiveAgent } from '../launch/agent.ts';
import { seatDeliveryClass } from '../launch/delivery-class.ts';
import { boxHoldsText, DRAW_WAIT_MS } from '../launch/deliver.ts';
import { removeWorktree } from './worktree.ts';
import { stateOf } from './down.ts';
import type { DownSeat } from '../launch/plan.ts';
import { herdrUnreliable, profileFor } from '../profiles/index.ts';
import { classifyWith, overridesInForceOf, quotaWith, type OverrideForce } from '../profiles/overrides.ts';
import { ofTeam } from '../registry/projects.ts';
import { teamIdOf } from '../registry/teams.ts';
import { findAgent } from '../registry/agents.ts';
import { continuityIdsOf } from '../registry/resume.ts';
import type { StateThresholds } from '../settings/inherit.ts';
import { machineLiveness, watchWords } from '../settings/declared.ts';
import { entityLiveness } from '../entities.ts';
import { defaultWatch } from '../file/validate.ts';
import { createSequenceTracker, type EventAppendInput, type SignedEventRecord, type SequenceTracker } from '../bus/log.ts';
import { OwnerDelivery, writeRuntimeMailboxRecord } from '../bus/owner.ts';
import { readEntityOrchestrator } from '../bus/seats.ts';
import {
  publishToBus,
  subscribeBusOnce,
  type BusPublishOutcome,
  type BusSubscribeOutcome,
} from '../bus/server.ts';
import { LEGACY_LINE, type Standing } from '../store/store.ts';
import { liveAsync, realSources, standingSource, type AsyncLiveOptions, type AsyncLiveRead } from './status.ts';
import { queuedSwaps, swapLine } from '../swap/queue.ts';
import { queueRuleBreaches } from '../swap/auto.ts';
import { rulesOriginOf } from '../launch/rules.ts';
import { runDueSwaps, type SwapRunResult } from '../swap/run.ts';
import { realSources as restartSources, type RestartSources } from './restart.ts';
import {
  classifyPromptKind,
  createSeatStatusEngine,
  herdrStatusSource,
  isScreenVerifiedStatusCli,
  isStatusWaiterSeat,
  reconcileStatusWithScreen,
  seatHasAssignedWorkOnDisk,
  shouldReadScreenForStatus,
  waitAgentStatus,
  type EmittedStatusEvent,
  type HerdrAgentStatus,
  type PromptKind,
  type SeatStatusEngine,
  type SeatStatusEngineInput,
  type SeatStatusStep,
  type SeatStatusWaitStep,
  type StatusSource,
  type StatusTarget,
  type StatusWaitResult,
  type StatusWaitSeat,
  type StatusClimb,
} from '../watch/status-events.ts';

export {
  classifyPromptKind,
  createSeatStatusEngine,
  herdrStatusSource,
  isScreenVerifiedStatusCli,
  isStatusWaiterSeat,
  reconcileStatusWithScreen,
  seatHasAssignedWorkOnDisk,
  shouldReadScreenForStatus,
  waitAgentStatus,
  type EmittedStatusEvent,
  type HerdrAgentStatus,
  type PromptKind,
  type SeatStatusEngine,
  type SeatStatusEngineInput,
  type SeatStatusStep,
  type SeatStatusWaitStep,
  type StatusSource,
  type StatusTarget,
  type StatusWaitResult,
  type StatusWaitSeat,
};

// What the watch reads and does outside its own process, so tests can stand in for it.
export type WatchSources = {
  live(session: string, team: TeamFile): Live | null;
  machine(root: string): Machine;
  // The approval store's one snapshot per pass: the drift line, the watch and
  // budget values in force and the checks all derive from it, so no later read
  // in the same pass can disagree with the first.
  standing(root: string): Standing;
  // What each checked account reads this pass (RFC 0003 § 5). Runs outside the pass, like the
  // machine figures: a command's raw output never leaves this call, and a failure reads unknown.
  readChecks(standing: Standing, team: TeamFile, now: number): CheckOutcome[];
  // The same reads, awaited: each takes the per-call deadline and the loop's stop, so a loop
  // that must not hold its process's event loop (the machine daemon's hosted watch) reads
  // without blocking another route. A loop uses these only when the source supplies them; the
  // synchronous source is the CLI's and every test seam's, and stays.
  liveAsync?(session: string, team: TeamFile, options: AsyncLiveOptions): Promise<AsyncLiveRead>;
  machineAsync?(root: string, options: ChildOptions): Promise<Machine>;
  readChecksAsync?(standing: Standing, team: TeamFile, now: number, options: ChildOptions): Promise<CheckOutcome[]>;
  screenAsync?(pane: string, session: string, options: ChildOptions): Promise<string | null>;
  foregroundAsync?(pane: string, session: string, options: ChildOptions): Promise<string[] | null>;
  processesAsync?(pane: string, session: string, options: ChildOptions): Promise<PaneProcesses | null>;
  // The operator's screen, read again just before a nudge is typed.
  screen(pane: string, session: string): string | null;
  // The operator's status, asked again with its screen.
  status(pane: string, session: string): string | null;
  /** Foreground argv0 names, or null when the pane can't be read. */
  foreground(pane: string, session: string): string[] | null;
  /** The pane's process identity, compared with the one the state records for its seat; null
   *  when herdr can't tell. */
  processes?(pane: string, session: string): PaneProcesses | null;
  typeText(pane: string, text: string, session: string): boolean;
  pressEnter(pane: string, session: string): boolean;
  /** One key, spelled as herdr spells it: a delivery that meets unsent text clears the box with
   *  the profile's measured keys and pastes the text back. Absent, such a delivery holds. */
  sendKey?(pane: string, key: string, session: string): boolean;
  /** The profile-gated typed wake (src/send/typed-wake.ts), bound to one session: the unread
   *  pass's one typing seam, reached only for a seat whose profile declares a typed wake and
   *  whose retry is on. The raw writers above stay refused. */
  typedWake?(pane: string, line: string, cli: string, session: string): Promise<TypedWakeResult>;
  // Sleeps between the typing of the nudge and the read-back that decides the Enter — the
  // bounded draw wait the exit typing and delivery make (settleScreen). Required: a watch whose
  // delivery reads back the instant it typed, with nothing to wait on, is the fault itself.
  sleep(ms: number): Promise<void>;
  notify(text: string): void;
  now(): Date;
  // Waits between passes; false ends the watch. `onTick`, when the source honours it, runs
  // about every five seconds inside the wait: the label sweep, so a running seat's status line
  // reaches line 2 without a whole interval.
  wait(seconds: number, onTick?: () => void): Promise<boolean>;
  alive(pid: number): boolean;
  pid: number;
  /** This process's pane, `'gone'` when herdr answered and none has it, null when herdr can't say. */
  ownPane?(session: string, pid: number): { pane: string; workspace: string } | 'gone' | null;
  /** How an end is read. The real watch uses git and the filesystem. */
  readEnd?(root: string, until: string, base: string | null, ownBefore: boolean, seat?: string): EndView;
  /** Stops one free seat. The real watch uses the same steps as `remove`. */
  stopSeat?(session: string, seat: DownSeat): Promise<boolean>;
  /** Removes one merged worktree. The real watch calls `worktree remove`. */
  removeWorktree?(task: string): number;
  /** Sidebar line 1. False is one line and the next pass tries the same title again. */
  renameWorkspace?(session: string, workspace: string, label: string): boolean;
  /** Sidebar line 2. False is one line and the next pass tries the same text again. */
  reportDisplayAgent?(session: string, pane: string, text: string, ttlMs?: number): boolean;
  /** The home whose store holds the override file. Absent in a test that does not set one. */
  home?: string;
  /** The daemon health a pane's `team watch` reads. Absent, a pane still writes nothing. */
  daemonHealth?: (home: string) => Promise<{ roots: readonly { root: string; watch?: { session: string; phase: string } }[] }>;
  /** The unacked-record read this pass rings and reports from: a scan of every drop and legacy
   *  record. Read before the fold, never inside it — the scan is unbounded, and the fold holds
   *  the state lock. Absent, the shipped reader. `mail` is the pass's shared reading: the same
   *  lists serve this scan, the wake and the report, so each folder is scanned once. */
  readMailbox?(root: string, dir: string, team: TeamFile, live: Live, home: string, now: Date, mail?: MailPass): MailboxWaiting[];
  /** The live world a queued swap's run reads: the restart path's own sources. Absent, the
   *  watch queues the rule's breaches but carries no swap out (a test without a faked launch). */
  swapSources?: RestartSources;
  /** Restarts one seat from its record, resumed, that seat alone. Absent, the watch does not
   *  restart: a test that does not inject this never launches a real seat. The real watch
   *  wires `team restart` over its own restart sources. A hosted watch leaves it unset. */
  restartSeat?(seat: string, io: Io): Promise<number>;
  /**
   * A hand-run `team watch` does not call this. No path starts a pane watch; the daemon's
   * hosted loop is the only watch this command runs.
   */
  createWorkspace?(session: string, cwd: string, label: string): { pane: string; workspace: string } | null;
  /** Types the watch's command into its pane. False when herdr refused. */
  paneRun?(session: string, pane: string, command: string): boolean;
  /** Closes a workspace a failed start made. Absent in a test with no workspaces. */
  closeWorkspace?(session: string, workspace: string): boolean;
  /** The command a watch pane runs: the one `up` starts. Defaults to `up`'s own. */
  watchCommand?(session: string): string;
  /** Subscribes to `.agents/bus.sock` from `cursor` when a bus is running; falls back to polling when unavailable. */
  busSubscribe?(root: string, cursor: number): Promise<BusSubscribeOutcome>;
  /** Publishes an event (e.g. `seat.unreachable` or `seat.at-prompt`) to `.agents/bus.sock` when a bus is running. */
  busPublish?(root: string, event: EventAppendInput): Promise<BusPublishOutcome>;
  /** Optional listener invoked for each verified event received from the bus in sequence order. */
  onBusEvent?(event: SignedEventRecord): void;
  /** Optional listener invoked when the bus reports a sequence gap (`cursor + 1 < oldest_seq`)
   *  and watch resyncs from records. `reason` is `'retention'` when retained drop records declare
   *  the missing window. */
  onBusGap?(oldestSeq: number, newestSeq: number, reason?: 'retention'): void;
  /** Optional herdr status-event source (`herdr wait agent-status` per seat). */
  statusSource?: StatusSource;
  /**
   * The direct route to an idle seat with takeable work (the dispatcher's `pushWork`). Absent,
   * the watch dispatches nothing directly and types no old work nudge either: an episode the
   * dispatcher owns is never typed at by the legacy path, and the one fallback record says so.
   * The real watch runs the send command in this process, over direct routes only; a test
   * stands in.
   */
  pushWork?: WorkPush;
  /**
   * Present when the machine daemon hosts this loop. The host owns the clock, the wait and the
   * cancellation; this process has no pane and no terminal, and the front refusals that admit a
   * human-started watch do not apply to it. Never settable from a command line: `runWatch`
   * receives it only from the daemon's own source set.
   */
  hosted?: HostedLoop;
  /**
   * Set when `up` or the daemon starts this watch. A placed lead needs neither. Never settable
   * from a command line: `runWatch` receives it only from those two starters.
   */
  startedBy?: 'up' | 'daemon';
  /**
   * Whether `pid` is a live team watch. Absent, a pid `alive` reports that is not a shell.
   * A test supplies this and never signals a process.
   */
  watchPidLive?(pid: number): boolean;
  /**
   * What the recorded pane is running. `gone` is a pane that is no longer there. Absent, the
   * pane's process list: a missing pane is `gone`, a bare shell is `shell`, a team watch is
   * `watch`, and anything else is `other`. `unread` is a pane this pass could not judge, and a
   * record is not taken over on it.
   */
  paneVerdict?(session: string, pane: string): 'gone' | 'shell' | 'other' | 'watch' | 'unread';
  /**
   * Whether the caller can prove that one seat's native presence channel is healthy right now,
   * keyed by declared seat name. Only the machine daemon that owns the route can answer, from
   * its fresh per-seat continuity; a hand-started watch does not know, and the dispatcher then
   * holds a native projection instead of believing it. Never settable from a command line.
   */
  presenceChannelHealthy?: (seat: string) => boolean;
  /**
   * The owning daemon's measured reason for an unhealthy seat channel, when it hosts presence.
   * Display detail for the stuck report's notice; a watch that cannot answer leaves it out and
   * the notice names the unproven channel in the proof's own words. Never settable from a
   * command line.
   */
  presenceChannelReason?: (seat: string) => string | null;
  /**
   * The broker reading for a tracker team, prefetched once in the pass before the dispatcher
   * reads it. Absent (a hand-started watch, and every daemon that does not host the broker), the
   * reading stays explicitly unknown and this watch never opens the broker's socket. Only a
   * machine daemon that hosts the broker supplies one. Never settable from a command line.
   */
  brokerWork?: BrokerWorkSource;
};

/** The pass's one broker reading for a tracker team. The caller's reader is asked once; a
 *  reader with no answer leaves the snapshot absent, so the reading keeps its own pinned unknown
 *  rather than a refusal this watch invented, and a throw becomes a named refusal so a broken
 *  reader is never read as an empty page. */
async function prefetchBrokerWork(
  source: BrokerWorkSource,
  input: { root: string; team: TeamFile; now: Date },
): Promise<BrokerWorkSnapshot | undefined> {
  try {
    return (await source(input)) ?? undefined;
  } catch (error) {
    return {
      kind: 'refused',
      at: input.now.toISOString(),
      why: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The initial retry after a cut pass, in seconds: doubles on each consecutive cut up to the watch's own interval. */
const CUT_RETRY_SECONDS = 5;

/**
 * One pass's read budget: the moment its read phase started and what is left of the team's
 * budget. `take` returns the options a read is called with — the per-call deadline, shortened
 * by what is left, and the loop's stop — or null when the budget is spent or the loop stopped:
 * the read is skipped and its figure is unread. The clock is the watch's own, so a scene drives
 * a cut with its fake clock and measures no wall time.
 */
type ReadGate = {
  /** What is left of the pass's budget, in ms, never below zero. */
  left(): number;
  /** The pass's deadline on the same clock `take` measures against. */
  until(): number;
  take(): ChildOptions | null;
  /** A read that stopped at its own cut (a partial whole-session read) marks the pass cut too. */
  noteCut(): void;
  readonly cut: boolean;
};

function readGate(clock: () => number, limits: ReadLimits, signal: AbortSignal | undefined): ReadGate {
  const started = clock();
  let cut = false;
  const left = () => Math.max(0, limits.budgetMs - (clock() - started));
  return {
    left,
    until: () => clock() + left(),
    take() {
      if (signal?.aborted === true) {
        cut = true;
        return null;
      }
      const remaining = left();
      if (remaining <= 0) {
        cut = true;
        return null;
      }
      return {
        timeoutMs: Math.min(limits.timeoutMs, remaining),
        ...(signal === undefined ? {} : { signal }),
      };
    },
    noteCut() {
      cut = true;
    },
    get cut() {
      return cut;
    },
  };
}

/** The wait after a pass: a cut pass backs off from five seconds, doubling on each consecutive cut up to the interval. */
function readWait(interval: number, cut: boolean, cutPasses: number): number {
  if (!cut || cutPasses < 1 || interval <= CUT_RETRY_SECONDS) return interval;
  const shift = Math.min(cutPasses - 1, 30);
  return Math.min(CUT_RETRY_SECONDS * (2 ** shift), interval);
}

/** One extra screen read inside the pass, bounded by what is left of its budget. */
async function screenRead(sources: WatchSources, gate: ReadGate, pane: string, session: string): Promise<string | null> {
  const call = gate.take();
  if (call === null) return null;
  return sources.screenAsync !== undefined
    ? await sources.screenAsync(pane, session, call)
    : sources.screen(pane, session);
}

/** The one read a blocked seat gets outside the pass's budget, and the allowance every such read
 *  in one pass shares. */
const BLOCKED_SCREEN_READ_MS = 5_000;
const BLOCKED_SCREEN_READS_PER_PASS_MS = 10_000;

/** One blocked seat's read, under one absolute deadline that covers every attempt the read makes
 *  (its styled read and the plain retry), and the loop's stop. */
async function blockedScreenRead(sources: WatchSources, pane: string, session: string, stop: AbortSignal | undefined, budgetMs: number): Promise<string | null> {
  if (stop?.aborted === true || budgetMs <= 0) return null;
  const deadline = AbortSignal.timeout(budgetMs);
  const signal = stop === undefined ? deadline : AbortSignal.any([stop, deadline]);
  return sources.screenAsync !== undefined
    ? await sources.screenAsync(pane, session, { timeoutMs: budgetMs, signal })
    : sources.screen(pane, session);
}

/** A pane's foreground names, awaited when the source supplies the bounded read, else read
 *  synchronously; null when the budget is spent or the pane can't be read. */
async function foregroundRead(sources: WatchSources, gate: ReadGate, pane: string, session: string): Promise<string[] | null> {
  const call = gate.take();
  if (call === null) return null;
  return sources.foregroundAsync !== undefined
    ? await sources.foregroundAsync(pane, session, call)
    : sources.foreground(pane, session);
}

/** A pane's process identity, read the same way; null when the budget is spent or herdr can't tell. */
async function processesRead(sources: WatchSources, gate: ReadGate, pane: string, session: string): Promise<PaneProcesses | null> {
  const call = gate.take();
  if (call === null) return null;
  return sources.processesAsync !== undefined
    ? await sources.processesAsync(pane, session, call)
    : (sources.processes?.(pane, session) ?? null);
}

export const realWatchSources: WatchSources = {
  // The status live read, handed no state: the watch compares each live pane's process with its
  // seat's record itself, through `processes` below — only `status` needs the panes the state
  // recorded for seats no agent is listed under, so none is read here.
  live: (session, team) => realSources.live(session, team, emptySession()),
  // The awaited whole-session read: one `pane process-info` per pane answers both the process
  // identity and the foreground names, and its panes rotate from the cursor a cut left.
  liveAsync: (session, team, options) => liveAsync(session, team, options),
  machine: readMachine,
  machineAsync: (root, options) => readMachineAsync(root, options),
  standing: standingSource(homedir()),
  readChecks: (standing, team, now) => runChecksOf(standing, team, now),
  readChecksAsync: (standing, team, now, options) => runChecksOfAsync(standing, team, now, options),
  screen: (pane, session) => paneRead(pane, PANE_WINDOW, session),
  screenAsync: (pane, session, options) => paneReadAsync(pane, PANE_WINDOW, session, options),
  status: agentStatus,
  foreground: (pane, session) => paneForeground(pane, session),
  foregroundAsync: async (pane, session, options) => foregroundArgv0(await paneProcessInfoAsync(pane, session, options)),
  processes: (pane, session) => paneProcesses(pane, session),
  processesAsync: async (pane, session, options) => paneProcessesOf(await paneProcessInfoAsync(pane, session, options)),
  // No pane messaging: the watch never types a nudge or a reminder (src/send/no-pane-messaging.ts).
  // The one exception is the profile-gated typed wake below, whose own module reads the box
  // twice and presses Enter only into the line it typed (src/send/typed-wake.ts).
  typeText: refuseTyping,
  pressEnter: refuseTyping,
  sendKey: refuseTyping,
  typedWake: (pane, line, cli, session) => deliverTypedWake(herdrTypedWakeHost(session), pane, line, cli),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  notify,
  now: () => new Date(),
  wait: waitOrStop,
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  pid: process.pid,
  ownPane: ownWatchPane,
  home: homedir(),
  swapSources: restartSources,
  restartSeat: (seat, io) => runRestart([seat], { ...io, stdout: () => {}, stderr: () => {} }, restartSources),
  renameWorkspace: (session, workspace, label) => workspaceRename(workspace, label, session === 'default' ? undefined : session),
  reportDisplayAgent: (session, pane, text, ttlMs = SIDEBAR_TTL_CAP_MS) =>
    reportDisplayAgent(pane, text, session === 'default' ? undefined : session, ttlMs),
  watchCommand,
  // The bus identity of the owner's delivery path (§4.5): the watch reads what the policy routes
  // to `owner` and what the raising side addresses to `owner`. It is never a seat name.
  busSubscribe: (root, cursor) => subscribeBusOnce(root, { seat: 'owner', cursor }, { deadlineMs: 500 }),
  busPublish: (root, event) => publishToBus(root, event, { deadlineMs: 500 }),
  statusSource: herdrStatusSource(),
  // The direct-work route: this process holds no verified watch authority (a hand-started watch
  // records no epoch), so the wake is held with a refusal and no transport is attempted. The
  // hosted watch wires its own verified sender over `sendWatchDirect`; an infrastructure pane is
  // never used as the sender, and no placement, grant or registration stands in for the watch.
  pushWork: watchPushWork(null),
  daemonHealth: (home) => daemonHealth(home),
};

/**
 * The idle dispatcher's read-back lives beside its own types, in `src/watch/dispatch.ts`; it is
 * re-exported here so every existing reader of `team watch` keeps its import.
 */
export { workPushResultOf } from '../watch/dispatch.ts';

export const watch: Command = (argv, io) => runWatch(argv, io, realWatchSources);
export default watch;

export const USAGE = `Usage: team watch [--session <name>] [--file <path>] [--no-nudge] [--no-notify]

Watches a running team. Every \`watch.interval\` seconds it reads the session — the seats,
their screens, the file, the approval, the machine — prints what is wrong, and nudges an
idle seat when a report waits. The owner starts it from a terminal outside herdr; \`up\`
starts one when a session needs it. It runs in the foreground until Ctrl-C, and every line
it prints goes to \`.agents/team.log\`.

Exits 0 when the watch starts or stops cleanly, 1 when it is refused or fails, 2 when
the invocation or team file can't be read.
`;

/** The file `up` recorded for this session's watch, or a refusal for any other non-owner.
 *  Absent when neither folder a team file can sit in records one: a flagless watch then reads
 *  what it always did. `'wait'` is a file recorded and a pid not written yet: the process `up`
 *  spawned. A record whose pane is gone or is not running `team watch`, and whose pid is not a
 *  live team watch, is dead: the owner, the daemon, `up`, or the team's placed lead rewrites it
 *  to this call and the watch starts. A live record still refuses every other caller. */
function watchdogGrant(
  cwd: string, session: string | undefined, caller: ReturnType<typeof callerOf>, sources: WatchSources,
): { file: string } | { refuse: string } | { wait: true } | undefined {
  const name = session ?? 'default';
  const recorded = recordedWatchdog(cwd, name);
  if (!recorded) return undefined;
  if (recorded.pane && caller.kind === 'pane' && caller.pane === recorded.pane) return { file: recorded.file };
  // The pid that owns the record is read from the record's own state: the team file's folder,
  // never this process's start folder when the two differ.
  const watchPid = readState(recorded.dir).sessions[name]?.watch?.pid;
  if (watchPid === process.pid) return { file: recorded.file };
  if (watchPid === undefined && !recorded.pane) return { wait: true };
  // The hand-over window: the file and the pane are recorded, and the watch's first pass — the
  // command typed into that pane — has not written its pid yet. Its own call can read as
  // unplaced when herdr names no pane to it; a caller the walk provably places elsewhere is
  // still refused while the record is fresh.
  const elsewhere = caller.kind === 'owner' || caller.kind === 'owner-no-tty' || caller.kind === 'seat'
    || (caller.kind === 'pane' && caller.pane !== recorded.pane);
  if (watchPid === undefined && recorded.pane && !elsewhere) return { file: recorded.file };
  const taken = takeOverDeadWatch(cwd, session, caller, sources);
  if (taken) return taken;
  if (isOwner(caller)) return undefined;
  return {
    refuse: `only the watch this session records may read the file up recorded; this call is ${describeCaller(caller)}`,
  };
}

/** A dead recorded watch, rewritten to this call. Absent when the record is live, unreadable,
 *  or this caller may not take it. The old pane is left as it is: nothing is signalled and
 *  nothing is closed. */
function takeOverDeadWatch(
  cwd: string, session: string | undefined, caller: ReturnType<typeof callerOf>, sources: WatchSources,
): { file: string } | undefined {
  const name = session ?? 'default';
  const recorded = recordedWatchdog(cwd, name);
  if (!recorded) return undefined;
  const watchPid = readState(recorded.dir).sessions[name]?.watch?.pid;
  const reason = deadWatchReason(recorded, watchPid, name, sources);
  if (reason === undefined) return undefined;
  const loaded = loadTeamFile(cwd, { file: recorded.file, home: sources.home });
  if (!mayTakeOverDeadWatch(caller, sources, loaded.ok ? loaded.team : undefined)) return undefined;
  const own = caller.kind === 'seat' || caller.kind === 'pane' ? caller.pane : undefined;
  updateState(recorded.dir, (state) => {
    const current = (state.sessions[name] ??= emptySession());
    current.watchdog = own === undefined ? { file: recorded.file } : { file: recorded.file, pane: own };
  });
  logLine(recorded.dir, 'watch', 'watch', `watch record taken over from ${recorded.pane ?? 'none'}: ${reason}`, sources.now());
  return { file: recorded.file };
}

function mayTakeOverDeadWatch(caller: ReturnType<typeof callerOf>, sources: WatchSources, team: TeamFile | undefined): boolean {
  if (isOwner(caller)) return true;
  if (caller.kind === 'daemon') return true;
  if (sources.hosted !== undefined) return true;
  if (sources.startedBy === 'up' || sources.startedBy === 'daemon') return true;
  return caller.kind === 'seat' && team !== undefined && (caller.name === team.orchestrator || caller.name === team.operator);
}

/** `gone` or `no watch running` when the recorded pane is not a team watch and its pid is not a
 *  live team watch. A pane this pass cannot read stays recorded: an unreadable pane is not a
 *  dead one. */
function deadWatchReason(
  recorded: { pane?: string }, watchPid: number | undefined, session: string, sources: WatchSources,
): 'gone' | 'no watch running' | undefined {
  // A record with no pane is the daemon's own binding, or a hand-over that has not named a pane.
  // Neither is a dead pane watch, and neither is rewritten.
  if (recorded.pane === undefined) return undefined;
  const word = paneWord(sources, session, recorded.pane);
  if (word === 'watch' || word === 'unread') return undefined;
  if (watchPidIsLive(watchPid, sources)) return undefined;
  return word === 'gone' ? 'gone' : 'no watch running';
}

function paneClass(
  names: string[] | null,
  info: PaneProcesses | null,
): 'gone' | 'shell' | 'other' | 'watch' | 'unread' {
  const base = (name: string): string => name.split('/').pop() ?? name;
  if (names?.some((name) => base(name) === 'team')) return 'watch';
  if (info !== null && paneHoldsOnlyShell(info)) return 'shell';
  if (names !== null && names.length > 0 && names.every((name) => isShellName(base(name)))) return 'shell';
  if ((names === null || names.length === 0) && info === null) return 'gone';
  return 'other';
}

function paneWord(sources: WatchSources, session: string, pane: string): 'gone' | 'shell' | 'other' | 'watch' | 'unread' {
  if (sources.paneVerdict) return sources.paneVerdict(session, pane);
  let names: string[] | null;
  try {
    names = sources.foreground(pane, session);
  } catch {
    return 'unread';
  }
  const info = sources.processes?.(pane, session) ?? null;
  return paneClass(names, info);
}

/** The same pane word, read off the awaited sources. A loop that supplies `processesAsync`
 *  uses that read and does not call the synchronous process reader: that read would hold the beat.
 *  No screen is read here. */
async function paneWordAwaited(
  sources: WatchSources, session: string, pane: string,
): Promise<'gone' | 'shell' | 'other' | 'watch' | 'unread'> {
  if (sources.paneVerdict) return sources.paneVerdict(session, pane);
  const call = { timeoutMs: 10_000 };
  let names: string[] | null;
  try {
    names = sources.foregroundAsync !== undefined
      ? await sources.foregroundAsync(pane, session, call)
      : sources.foreground(pane, session);
  } catch {
    return 'unread';
  }
  const info = await paneProcessesOnce(sources, pane, session, call);
  return paneClass(names, info);
}

/** One pane's process read, shared by every ask on this beat. A second ask while the read is
 *  pending, and one that arrives after it has settled but before the next beat, receives that
 *  same result. The next beat drops a settled read so a later proof can look again. */
const paneReads = new Map<string, { promise: Promise<PaneProcesses | null>; settled: boolean }>();

export function paneProcessesOnce(
  sources: Pick<WatchSources, 'processes' | 'processesAsync'>,
  pane: string,
  session: string,
  options: ChildOptions,
): Promise<PaneProcesses | null> {
  const key = `${session}\0${pane}`;
  const flight = paneReads.get(key);
  if (flight) return flight.promise;
  const promise = sources.processesAsync !== undefined
    ? sources.processesAsync(pane, session, options)
    : Promise.resolve(sources.processes?.(pane, session) ?? null);
  const flightNext = { promise, settled: false };
  paneReads.set(key, flightNext);
  promise.then(
    () => { flightNext.settled = true; },
    () => { flightNext.settled = true; },
  );
  return promise;
}

/** Drops process reads that have already settled, so the next beat can prove the pane again.
 *  A read that is still pending stays, and the beat reuses it. */
export function releaseSettledPaneReads(): void {
  for (const [key, flight] of paneReads) {
    if (flight.settled) paneReads.delete(key);
  }
}

/** A live team watch. A pid `alive` reports as gone is not one, and no process table is read
 *  for it. A live shell is not a team watch. A live pid whose command cannot be read is left
 *  recorded, so a watch this pass cannot name is not taken. */
function watchPidIsLive(pid: number | undefined, sources: WatchSources): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  if (sources.watchPidLive) return sources.watchPidLive(pid);
  if (!sources.alive(pid)) return false;
  const comm = processCommOf(pid);
  if (comm === null) return true;
  const name = comm.split('/').pop() ?? comm;
  return !isShellName(name);
}

/** Whether the daemon's hosted watch would become the active watch for this session. Reads the
 *  state and the pane, and writes nothing. `take` is true only when the recorded pane watch is
 *  not alive: its pane is gone, a shell, or something other than `team watch`, its heartbeat is
 *  older than three watch intervals, and it has no live pid. A live pane watch stays the holder. */
export type WatchTakeoverVerdict = { take: boolean; reason: string; who: string };

const DEAD_HEARTBEAT_INTERVALS = 3;

function takeoverFrom(
  root: string,
  session: string,
  sources: WatchSources,
  word: 'gone' | 'shell' | 'other' | 'watch' | 'unread',
  found: NonNullable<ReturnType<typeof recordedSession>>,
): WatchTakeoverVerdict {
  if (word === 'unread') return { take: false, reason: 'unread', who: 'pane' };
  if (word === 'watch' || watchPidIsLive(found.watch?.pid, sources)) return { take: false, reason: 'live', who: 'pane' };
  const intervalMs = daemonIntervalMs(root, found.watchdog?.file, sources);
  const beat = found.watch?.heartbeat === undefined ? Number.NaN : Date.parse(found.watch.heartbeat);
  const age = sources.now().getTime() - beat;
  if (!Number.isFinite(age) || age <= DEAD_HEARTBEAT_INTERVALS * intervalMs) {
    return { take: false, reason: 'fresh', who: 'pane' };
  }
  const reason = word === 'gone' ? 'gone' : word === 'shell' ? 'shell' : 'no watch running';
  return { take: true, reason, who: 'daemon' };
}

export function watchTakeoverVerdict(root: string, session: string, sources: WatchSources): WatchTakeoverVerdict {
  const found = recordedSession(root, session);
  const pane = found?.watch?.pane;
  if (found === undefined || pane === undefined) return { take: false, reason: 'no pane watch recorded', who: 'none' };
  return takeoverFrom(root, session, sources, paneWord(sources, session, pane), found);
}

/** The loop's verdict. The pane word is awaited, so a slow process read does not hold the beat. */
export async function watchTakeoverVerdictAsync(
  root: string, session: string, sources: WatchSources,
): Promise<WatchTakeoverVerdict> {
  const found = recordedSession(root, session);
  const pane = found?.watch?.pane;
  if (found === undefined || pane === undefined) return { take: false, reason: 'no pane watch recorded', who: 'none' };
  return takeoverFrom(root, session, sources, await paneWordAwaited(sources, session, pane), found);
}

/** The daemon becomes the active watch for a dead pane record. The audit line is written and the
 *  dead pane record is dropped so the authority store can acquire. No pane is started and nothing
 *  is signalled. A live or fresh record is left as it stands. */
export function activateDeadPaneWatch(root: string, session: string, sources: WatchSources): boolean {
  const verdict = watchTakeoverVerdict(root, session, sources);
  if (!verdict.take) return false;
  return dropDeadPaneWatch(root, session, sources, verdict);
}

/** The loop's activation. It awaits the pane read and then applies the same drop. */
export async function activateDeadPaneWatchAsync(
  root: string, session: string, sources: WatchSources,
): Promise<boolean> {
  const verdict = await watchTakeoverVerdictAsync(root, session, sources);
  if (!verdict.take) return false;
  return dropDeadPaneWatch(root, session, sources, verdict);
}

function dropDeadPaneWatch(
  root: string, session: string, sources: WatchSources, verdict: WatchTakeoverVerdict,
): boolean {
  const found = recordedSession(root, session);
  if (found === undefined) return false;
  const pane = found.watch?.pane ?? 'none';
  const dropped = updateState(found.dir, (state) => {
    const current = state.sessions[session];
    const held = current?.watch;
    if (current === undefined || held === undefined || held.epoch !== undefined) return false;
    if (watchPidIsLive(held.pid, sources)) return false;
    delete current.watch;
    return true;
  }, { writeWhen: (dropped) => dropped });
  if (!dropped) return false;
  logLine(
    found.dir,
    'watch',
    'daemon',
    `pane watch ${pane} not alive: ${verdict.reason}; the daemon's watch is active`,
    sources.now(),
  );
  return true;
}

function recordedSession(
  root: string, session: string,
): { dir: string; watchdog?: { file: string; pane?: string }; watch?: { pid?: number; pane?: string; heartbeat?: string; epoch?: string } } | undefined {
  for (const dir of stateDirsOf(root)) {
    const current = readState(dir).sessions[session];
    if (current?.watchdog !== undefined || current?.watch !== undefined) {
      return { dir, watchdog: current.watchdog, watch: current.watch };
    }
  }
  return undefined;
}

function daemonIntervalMs(root: string, file: string | undefined, sources: WatchSources): number {
  if (file === undefined) return 120_000;
  const loaded = loadTeamFile(root, { file, home: sources.home });
  const seconds = loaded.ok ? loaded.team.watch.interval : 120;
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 120) * 1000;
}

/** The folders a team file can sit in, seen from the folder the watch starts in: this one (a
 *  team file named directly there) and its `.agents` folder (the layout `up` starts the watch
 *  from). `up` writes `team.state.json` beside the file it loaded, so the record, its pane and
 *  its pid are read from the team file's folder — the same state `up` wrote — whichever of the
 *  two it is. */
function stateDirsOf(cwd: string): string[] {
  return [cwd, join(cwd, '.agents')];
}

function recordedWatchdog(
  cwd: string, session: string,
): { file: string; pane?: string; dir: string } | undefined {
  for (const dir of stateDirsOf(cwd)) {
    const recorded = readState(dir).sessions[session]?.watchdog;
    if (recorded) return { ...recorded, dir };
  }
  return undefined;
}

/** The grant, waiting out the moment between spawn and the pid landing in the state. */
async function admittedWatchdog(
  cwd: string, session: string | undefined, caller: ReturnType<typeof callerOf>, sources: WatchSources,
): Promise<{ file: string } | { refuse: string } | undefined> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const grant = watchdogGrant(cwd, session, caller, sources);
    if (!grant || !('wait' in grant)) return grant;
    if (Date.now() >= deadline) {
      return {
        refuse: `only the watch this session records may read the file up recorded; this call is ${describeCaller(caller)}`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// How often the watch writes the machine's readings to the log, in seconds. Not the pass rate:
// the default pass is 120s and the machine moves on an hourly scale, so a line per pass would be
// 720 a day saying what one every ten minutes says.
const READINGS_EVERY = 600;

/** A hand-run `team watch` (no hosted loop). A boolean, not a type predicate, so the hosted
 *  loop below stays typed for both callers: the return that follows is what keeps a hand run
 *  out of it. */
function handRunWatch(hosted: HostedLoop | undefined): boolean {
  return hosted === undefined;
}

export async function runWatch(argv: string[], io: Io, sources: WatchSources): Promise<number> {
  // Raw argv, before the parser: `--json` is not a flag this daemon takes, and its refusal
  // must still answer with the structured error document when the flag is present.
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['session', 'file'], ['no-nudge', 'no-notify']);
  if (args.error || args.rest.length) {
    const why = args.error ?? `unexpected "${args.rest[0]}"`;
    if (json) {
      writeJsonError(io, 'watch.invocation', why, null);
    } else {
      io.stderr(`team watch: ${why}\n${USAGE}`);
    }
    // exit: watch.invocation
    return 2;
  }
  // The loop itself prints no document: `--json` is refused above. A refusal before the loop
  // still takes the error document when the flag was read (a `--file --json` value reads as
  // the flag, as the shared helper defines it), and its plain line otherwise.
  const refuse = (id: string, why: string): void => {
    if (json) writeJsonError(io, id, why, null);
    else io.stderr(`team watch: ${why}\n`);
  };
  const hosted = sources.hosted;
  // The `--file` check is the walk's too, and it runs before `currentTeam` reads that file or
  // writes beside it: a non-owner aiming `--file` must not make this command read and validate
  // another project's team file, nor leave its `last_valid`, its log line or its heartbeat in
  // that project's state. The one place every command whose `--file` is the owner's decides it is
  // `fileOwnerRefusal` (caller.ts). The watch's pane carries no `--file`: a pane is not an owner
  // at a terminal. The file is recorded on the session instead, and only that pane — or the
  // process a pass records — may read it.
  const fileRefusal = fileOwnerRefusal(io, args.values.file);
  if (fileRefusal !== undefined) {
    refuse('watch.file-owner', fileRefusal);
    // exit: watch.file-owner
    return 1;
  }
  const caller = callerOf(io, args.values.session);
  // No path starts a pane watch. A hand-run `team watch` — the owner, a seat, a pane, or a
  // pane the walk cannot place — only prints the daemon's watch and writes nothing. The hosted
  // loop below is the daemon's own watch; it is the one caller that still runs.
  if (handRunWatch(hosted)) {
    const named = caller.kind === 'pane' ? (caller.session ?? args.values.session) : args.values.session;
    let sessionName = named;
    if (sessionName === undefined) {
      const looked = currentTeam(io.cwd, args.values.file, sources.now(), sources.home, false);
      if (looked.ok) sessionName = looked.team.session;
    }
    const home = sources.home;
    let line = 'team watch: the daemon does not host this session\n';
    if (sessionName !== undefined && home !== undefined && sources.daemonHealth !== undefined) {
      const health = await sources.daemonHealth(home);
      const canonical = canonicalRoot(io.cwd);
      const entry = canonical === null ? undefined : health.roots.find((item) => item.root === canonical);
      const phase = entry?.watch?.phase;
      const runs = entry?.watch !== undefined
        && entry.watch.session === sessionName
        && phase !== 'standby'
        && phase !== 'stopped'
        && phase !== 'failed';
      line = runs
        ? `team watch: running in the daemon for session ${sessionName}\n`
        : `team watch: the daemon does not host session ${sessionName}\n`;
    } else if (sessionName !== undefined) {
      line = `team watch: the daemon does not host session ${sessionName}\n`;
    }
    io.stdout(line);
    // exit: watch.started
    return 0;
  }
  // A hosted watch takes no grant and no `--file`: it reads the team of the route it was built
  // for, and the watchdog file is the hand-over a pane makes, which a daemon pass never makes.
  const grant = args.values.file || hosted !== undefined
    ? undefined
    : await admittedWatchdog(io.cwd, args.values.session, caller, sources);
  // The instant this process reached its loop, recorded once on the first beat the record takes:
  // `down` stops a pane-less watch only when the live process's command line and start instant
  // prove it is this watch. Captured once the run is admitted and before the first pass reads, so
  // it is this process's start rather than the first pass's, and a refused run reads no source.
  const watchStartedAt = sources.now().toISOString();
  const aimed = args.values.file ?? (grant && 'file' in grant ? grant.file : undefined);
  const first = currentTeam(io.cwd, aimed, sources.now(), sources.home, false);
  if (!first.ok) {
    if (json) {
      const id = first.errors[0]?.message.includes('not inside a git repository')
        ? 'watch.not-a-repo'
        : first.errors.some(isParseError)
          ? 'watch.file-invalid'
          : 'watch.file';
      const message = first.errors.map((p) => `${p.line ? `team config line ${p.line}: ` : ''}${p.message}`).join('; ');
      writeJsonError(io, id, message, null);
    } else {
      for (const problem of first.errors) io.stderr(`team watch: ${problem.line ? `team config line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    // exit: watch.not-a-repo
    // exit: watch.file
    // exit: watch.file-invalid
    return 2;
  }
  const session = args.values.session ?? first.team.session;
  const { dir } = first;

  const placed = callerOf(io, session);
  // A hosted loop never asks `watchdogGrant`: the front refusals do not apply to it. A dead
  // record is still rewritten once, here, before the loop, and a live one is left as it is.
  if (hosted !== undefined) takeOverDeadWatch(io.cwd, session, placed, sources);

  // Owner delivery (§4.5) is the owner's own path. This process is that path when the owner
  // check that admits owner-only actions admits it, when it runs in an agentless pane — the
  // pane `up` starts the watch in — or when it is the watch this session recorded. A watch a
  // seat started in its own pane runs its passes and polls; it never subscribes with the
  // owner's identity.
  // A hosted watch is a new identity, not the owner's and not a seat's: whatever the daemon
  // process's own caller happens to look like, it never owns the owner's delivery path, never
  // creates a workspace and is never refused for being unplaced.
  const ownerPath = hosted === undefined && (isOwner(placed) || placed.kind === 'pane' || grant !== undefined);

  // A seat that starts the session's only watch must not be able to drop the operator's nudge
  // or the operator's desktop notices. The owner's own `--no-notify` still cannot silence a
  // report addressed to the owner: those are routed below.
  if (args.flags.has('no-nudge') || args.flags.has('no-notify')) {
    if (!isOwner(placed)) {
      const message = `--no-nudge and --no-notify are the owner's, from a terminal outside herdr; this call is ${describeCaller(placed)}`;
      refuse(args.flags.has('no-nudge') ? 'watch.no-nudge' : 'watch.no-notify', message);
      // exit: watch.no-nudge
      // exit: watch.no-notify
      return 1;
    }
  }

  // The load above wrote nothing, and a flag refusal returned above. A watch that is already
  // running leaves the state file as it was. An allowed run remembers once that check has
  // passed, before the loop. The loop's own read remembers again when the file changes.
  const standing = sources.standing(first.root);
  // The hand-over's freshness check above is the first pass's read too: the loop takes this
  // snapshot for pass one, and reads the store itself from the second pass on. A pass is one
  // read, not two — the first pass has already had it.
  let standingThisPass: Standing | undefined = standing;
  const other = readState(dir).sessions[session]?.watch;
  // A record with a pane and no pid yet is the hand-over `up` — or the owner's own run — made:
  // the command typed into that pane is the watch this call is. Only a caller the walk provably
  // places elsewhere — the owner's terminal outside herdr, a seat, another pane — is refused
  // while that record is fresh. A caller the walk cannot place is admitted, because the pane's
  // own command reads exactly so when herdr names no pane to it (a `pane run` whose process
  // carries no pane hint places nobody), and its first pass then records the pid every later
  // caller is judged by.
  const elsewhere = placed.kind === 'owner' || placed.kind === 'owner-no-tty' || placed.kind === 'seat'
    || (placed.kind === 'pane' && placed.pane !== other?.pane);
  const handOver = !elsewhere && other !== undefined && other.pid === undefined && other.pane !== undefined;
  const otherRunning = other && !handOver && other.pid !== sources.pid && watchRunning(other, {
    alive: (pid) => sources.alive(pid),
    now: sources.now().getTime(),
    interval: watchInForceWithPace(standing, first.team, watchPaceOf({
      team: first.team,
      root: first.root,
      home: sources.home,
      standing,
      now: sources.now(),
    })).interval,
  });
  if (otherRunning) {
    const where = other.pid !== undefined ? `pid ${other.pid}` : `pane ${other.pane ?? 'not recorded'}`;
    // A live pane watch owns the session. A hosted watch stands down and records that it did,
    // instead of taking the record over or touching the pane: the transfer to a daemon-carried
    // watch is a separate step with its own proof.
    if (hosted !== undefined) {
      hosted.standby(`a watch already runs for the session "${session}" (${where})`);
      // exit: watch.standby
      return 0;
    }
  }
  if (first.path !== undefined) rememberCurrent(first.dir, first.path, sources.now());

  // The log line is written for every report. `--no-notify` never removes it, and it never
  // removes a desktop notice addressed to the owner. It does silence every other notice.
  const tell = (text: string, notify: boolean) => {
    io.stdout(`${sources.now().toISOString()} ${text}\n`);
    logLine(dir, 'watch', 'watch', text, sources.now());
    if (notify) sources.notify(text);
  };
  const say = (text: string, desktop: boolean) => tell(text, desktop && !args.flags.has('no-notify'));

  // A hosted pass yields to the daemon's beat between its blocking reads and synchronous sub-steps:
  // it fires the host's cross-route beat and yields a macrotask so an interval beat timer on this
  // loop can run between steps. Without a host beat (a CLI watch, or a host that wired none), the
  // pass yields nothing.
  const yieldBeat = async (): Promise<void> => {
    if (hosted?.beat === undefined) return;
    hosted.beat();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  // Whether the host has stopped this loop. A call, not an inline comparison, so the flow
  // analysis never treats one check as proof about the next: a stop can land at any await.
  const stopped = (): boolean => hosted !== undefined && hosted.signal.aborted;

  const memory = newMemory();
  const told = new Set<string>();
  // The owner-addressed texts this process has already told: an event raised from one of them
  // must not be a second notice for the same words.
  const ownerTold = new Set<string>();
  const busTracker: SequenceTracker = createSequenceTracker(0);
  let outcomes: CheckOutcome[] = [];
  let checksAt: number | null = null;
  let readingsAt: number | null = null;
  let notice: string | undefined;
  let silent = false;
  let announced = false;
  // The first 'gone' for a pane this pid recorded is remembered here, and the heartbeat
  // continues. The watch ends only when the next pass says 'gone' again. A pass that finds the
  // pane, or where herdr cannot say, forgets it.
  let paneGoneOnce = false;
  // The agents and panes of the last whole read: what the label sweep between passes works on.
  let lastLive: Live | null = null;
  // Where the awaited whole-session read resumes its pane rotation after a cut: one cursor per
  // watch process, so one per root. A read that took every pane leaves it at the start.
  let readCursor = 0;
  // Consecutive passes whose read phase was cut short by its budget: the retry backs off by
  // doubling from five seconds up to the watch's interval, and resets when a read completes.
  let cutPasses = 0;
  let statusEngine: SeatStatusEngine | undefined;
  // A hosted watch's prompt climbs to this team's own lead, waiting for the daemon's notice.
  const hostedClimbs: { climb: StatusClimb; tries: number }[] = [];
  /** The current pass's native hold, replaced before the status engine, the pass and every
   *  automatic typed path read it. Empty until the first pass has read the store. */
  let nativeHeldNow: ReadonlySet<string> = new Set();
  /** The seats whose proven presence says a turn is running, and since when. Replaced with the
   *  hold before every pass that could report a stuck seat. */
  let workingSinceNow: ReadonlyMap<string, string> = new Map();
  /** The seats whose native presence this pass could not prove, with the words the stuck report's
   *  notice uses. Replaced beside the working word before every pass that could report one. */
  let unprovenPresenceNow: ReadonlyMap<string, PresenceUnproven> = new Map();
  let statusWaiters: { stop(): void; done: Promise<void> } | undefined;
  let statusWaitersKey = '';
  let finishWatchPass = () => {};
  // A sandboxed seat's send waits in its outbox for this watch (src/send/confined-outbox.ts). The
  // relay runs on its own tick, every `RELAY_EVERY_MS`, one batch at a time: a pass paced to
  // minutes under load must not make a seat's send wait that long (2026-11-15: the floor pass ran
  // every 240 s and Iris's send outlived her command's 45 s wait). Until a pass has read the team,
  // the relay reads the team file the watch started with and no live panes.
  let relayContext: { team: TeamFile; agents: { name: string | null; pane: string }[] | null } | null = first.team.session === session
    ? { team: first.team, agents: null }
    : null;
  let relayStopped = false;
  const relayTimer = hosted === undefined ? undefined : setInterval(() => {
    const context = relayContext;
    if (relayStopped || hosted?.signal.aborted === true || context === null || relayRunning.has(dir)) return;
    relayRunning.add(dir);
    void relayConfinedOutboxes(dir, session, context.team, context.agents, sources.now)
      .catch((error: unknown) => logLine(dir, 'watch', 'watch', `the outbox relay failed: ${(error as Error).message}`, sources.now()))
      .finally(() => relayRunning.delete(dir));
  }, RELAY_EVERY_MS);
  relayTimer?.unref?.();
  const stopRelay = (): void => {
    relayStopped = true;
    if (relayTimer !== undefined) clearInterval(relayTimer);
  };
  // The tick stops with the authority (the signal) and with the loop (the finally below). A host
  // stop is seen by the loop at its next wait, so a stop during a pass leaves the tick running
  // until that pass ends: a batch cut off then is answered as cut off on the next start
  // (src/send/confined-outbox.ts). A second waiter on the host is not registered for it: the
  // host's waits are the loop's own seam.
  hosted?.signal.addEventListener('abort', stopRelay, { once: true });
  try {
    for (;;) {
      // A hosted pass starts only while the host still wants one.
      if (hosted?.signal.aborted) break;
      finishWatchPass = beginBeatWork(`watch pass (wall):${first.root}`);
      // A daemon that hosts this route asks the live pane watch to hand over before it takes the
      // session. The request is read once per pass, before any effect: it must name this
      // checkout and session, come from a live process and carry a fresh beat on that daemon's
      // fixed liveness. The pane watch then leaves through its own loop, whose cleanup deletes
      // only its own record; the daemon's next beat acquires. A hosted loop never reads its own
      // request — it is the asking side of the same transfer.
      if (hosted === undefined) {
        const asked = actingWatchHandover({
          read: readWatchHandover(dir),
          root: first.root,
          session,
          alive: (pid) => sources.alive(pid),
          now: sources.now().getTime(),
        });
        if (asked !== undefined) {
          say(`the machine daemon now hosts this route's watch; handing over the session "${session}"`, false);
          break;
        }
      }
      // The file is read again on every pass, so a seat parked or stopped since is seen.
      const current = currentTeam(io.cwd, aimed, sources.now(), sources.home);
      const team = current.ok ? current.team : first.team;
      const root = current.ok ? current.root : first.root;
      // The one read of the approval store for the whole pass: the record's case, the values in
      // force and the checks below all derive from it. The first pass takes the snapshot the
      // hand-over check already read; every later pass reads again.
      const standing = standingThisPass ?? sources.standing(root);
      standingThisPass = undefined;
      // The pace in force for this pass: one policy value, never a second timer. A chain that
      // cannot be read keeps the safe reading cadence but holds every automated effect until the
      // policy is readable again; the pass says so once and never acts from the fallback as if
      // the policy had chosen it.
      const watchPace = watchPaceOf({ team, root, home: sources.home, standing, now: sources.now() });
      const paceVerified = watchPace.unknown === undefined;
      const inForce = watchInForceWithPace(standing, team, watchPace);
      for (const line of watchPaceNotes(watchPace)) {
        tellOnce(told, `watch-pace:${line}`, line, tell);
      }
      const overrides: OverrideForce = sources.home
        ? overridesInForceOf(standing, team.project, root, sources.home)
        : { profiles: [], differences: [], problems: [] };
      if (!announced) {
        announced = true;
        say(`watching the session "${session}" every ${inForce.interval}s${args.flags.has('no-nudge') ? ', without nudges' : ''}`, false);
      }
      for (const line of overrides.problems) {
        if (told.has(line)) continue;
        told.add(line);
        say(line, false);
      }
      // The live file is the record: a verified copy that differs is not reported. A record
      // that is not an approval in force — legacy, or one the verification refused — is said
      // once, in its own words. The watch keeps watching either way: it never stops a seat over
      // this, and the owner-only checks simply read unapproved.
      const approvalReason = standing.kind === 'legacy' ? LEGACY_LINE : standing.kind === 'refused' ? standing.why : null;
      if (approvalReason !== null && !told.has(`approval:${approvalReason}`)) {
        told.add(`approval:${approvalReason}`);
        say(approvalReason, false);
      }
      const problem = current.ok ? current.notice : `team config can't be read (${current.errors[0]?.message ?? 'unknown'}); watching with the team as it was`;
      if (problem !== notice) {
        notice = problem;
        if (problem) tell(problem, true);
      }

      // Only the watch of the file's own session saves readings. A watch on another session —
      // anyone may run one, from any terminal — reads and reports, but the figures it sees are
      // not the project's cache that `up` and `add` count (§ 4.4): it says so once and writes
      // none, budget or spend.
      const foreign = session !== team.session;
      // A pass that finds the team file naming another session stops this watch's relay: the
      // queued sends belong to the watch of the session the file names now.
      if (foreign) relayContext = null;
      if (foreign && !told.has('foreign-session')) {
        told.add('foreign-session');
        say(`the session "${session}" is not this file's "${team.session}": its readings are not saved`, false);
      }

      // Subscribe-first, poll-second (RFC 002 Amendment 01 §4.2): when the bus is running on
      // `.agents/bus.sock`, read unseen events from `busTracker.cursor` and apply them in sequence
      // order; on `gap`, reset the cursor and clear `memory.active` so this pass re-announces any
      // still-true reports; when no bus is running, fall back cleanly to the poll path.
      // Owner delivery (§4.5): the Runtime reaches the owner itself — the notice and the owner's
      // own inbox — for every event the policy routes to `owner` or the raising side addresses to
      // `owner`. No seat is in the path, so a held or unreachable liaison silences neither. The
      // subscription is the owner's delivery path's own, so a watch that is not that path stays a
      // reader of the file and the pass, and publishes what its checks see.
      const owner = sources.home === undefined || foreign || hosted !== undefined
        ? undefined
        : new OwnerDelivery({
            root,
            session,
            team,
            home: sources.home,
            notify: (text) => tell(text, true),
            now: sources.now,
            alreadyTold: (text) => ownerTold.has(text),
          });
      if (!foreign && ownerPath && sources.busSubscribe !== undefined) {
        await syncWatchBus(root, busTracker, sources, memory, owner === undefined ? undefined : (record) => {
          const outcome = owner.onEvent(record.payload);
          if (outcome.error !== undefined) {
            tellOnce(told, 'owner-record', `the owner's inbox was not written: ${outcome.error}`, tell);
          }
        });
      }

      // The values in force, from the pass's own snapshot: until the owner approves an edit to
      // `watch` or `tempo`, the watch keeps the waits that were approved, or the defaults. The
      // pace computed at the top of the pass is the same object for the sweep and every wait.
      // The budget values in force, from the same snapshot: an unapproved edit to the marks, the
      // accounts or the cadence silences nothing here until the owner approves it.
      const budget = budgetsInForceOf(standing, team);
      // One read of this process's pane per pass. The heartbeat and the work drop share it:
      // a second read would count as a second pass to a caller that records the calls.
      const own = sources.ownPane?.(session, sources.pid);
      const ownPane = own && own !== 'gone' ? own.pane : null;
      // The pass's read limits: the team's policies, resolved to `team` like the idle window and
      // the pace, and the gate that spends them. The budget is per pass and per root: once it is
      // spent, the panes not reached stay unread for this pass, and the awaited read resumes at
      // its cursor next pass.
      const limits = watchReadLimits(team, root, sources.home, sources.now());
      const sidebar = sidebarPolicy(
        sources.home === undefined
          ? { home: '', root, team: null }
          : { home: sources.home, root, team, now: sources.now() },
      );
      const gate = readGate(() => sources.now().getTime(), limits, hosted?.signal);
      // Before the one whole-session read: a beat overdue from the last pass lands here, so the
      // other hosted routes are renewed going into a call that can hold the loop for seconds.
      await yieldBeat();
      // Capture the episode generations before the live read can suspend. A later positive
      // snapshot may clear only those generations, never a newer concurrent observation.
      const driftFences = !foreign && sources.home !== undefined && current.ok && current.notice === undefined
        ? captureModelDriftFences({ dir, root, home: sources.home, session, team })
        : new Map();
      const liveCall = gate.take();
      let live: Live | null = null;
      let liveSkipped = false;
      if (liveCall === null) {
        // The budget was spent (or the loop stopped) before the session read: nothing is said
        // and nothing is forgotten; the next pass starts again at its cursor.
        liveSkipped = true;
      } else if (sources.liveAsync !== undefined) {
        const reading = await sources.liveAsync(session, team, {
          ...liveCall,
          cursor: readCursor,
          until: gate.until(),
          now: () => sources.now().getTime(),
        });
        live = reading.live;
        readCursor = reading.next;
        if (reading.cut) gate.noteCut();
      } else {
        live = sources.live(session, team);
      }
      lastLive = live;
      await yieldBeat();
      // A stop that landed while the read was in flight ends the pass here: the children it was
      // waiting on are killed with the signal the read was given.
      if (stopped()) break;
      if (!live) {
        if (!liveSkipped && !silent) tell('herdr doesn\'t answer; the watch keeps trying', true);
        if (!liveSkipped) silent = true;
      } else {
        silent = false;
        // `human: true` seats have zero screen reads and zero keys typed (`workspace-adapters` §6).
        for (const seat of team.seats) {
          if (seat.human !== true) continue;
          const humanAgent = live.agents.find((candidate) => candidate.name === seat.name);
          if (humanAgent) delete live.screens[humanAgent.pane];
        }
        noteWorked(dir, session, live, sources.now());
        const whole = readState(dir);
        // A team hold (`team hold`, which `up --no-launch` places for its quiet start) types
        // nothing automatic, as `--no-nudge` does: no work offer, no ring, no unread wake, no
        // held-drop retry and no swap. Reading and reporting go on; `team hold --release` ends it.
        const quiet = args.flags.has('no-nudge') || liveHold(whole, sources.now()) !== null;
        const state = whole.sessions[session] ?? emptySession();
        const now = sources.now().getTime();
        // Whether this pass may dispatch at all: a foreign session, a watch told to type
        // nothing, an unreadable pace, or a hosted loop with no direct route. The dispatcher
        // below takes its reading only when something could act on it, and so does the broker.
        const dispatchHeld = foreign || quiet || !paceVerified
          || (hosted !== undefined && sources.pushWork === undefined);
        // The tracker team's one broker reading for this pass, beside the presence snapshot: the
        // caller's reader, never this process's socket. A file team never asks, and neither does
        // a pass that cannot dispatch, so a held watch opens nothing it could not use.
        const broker = dispatchHeld || sources.brokerWork === undefined || team.tasks?.source !== 'linear'
          ? undefined
          : await prefetchBrokerWork(sources.brokerWork, { root, team, now: sources.now() });
        // One presence snapshot for this pass, shared by the status engine, the pass's idle
        // publication and every automatic typed path: they cannot disagree about a seat. The
        // hold is the explicit allow (`nativeAllowsTyping`): only a qualified native idle or a
        // genuinely absent or unsupported channel lets the screen path speak.
        const presence = await prefetchPresence({
          stateDir: dir,
          session,
          seatNames: team.seats.map((seat) => seat.name),
        });
        nativeHeldNow = nativeHeldSeats({
          team,
          state,
          presence,
          ...(sources.presenceChannelHealthy === undefined ? {} : { channelHealthy: sources.presenceChannelHealthy }),
          now: sources.now(),
        });
        // The seats a proven presence says are mid-turn, with the instant the word began: the
        // stuck report ages that word against `watch.stuck_after` rather than guessing at what
        // the pane is doing.
        workingSinceNow = presenceWorkingSince({
          team,
          state,
          presence,
          ...(sources.presenceChannelHealthy === undefined ? {} : { channelHealthy: sources.presenceChannelHealthy }),
          now: sources.now(),
        });
        // The seats the proof refused, in the same reading: the stuck report names an unhealthy
        // channel and the projection it last showed, where a recognised screen alone would say
        // nothing about why the wake never reached the seat.
        unprovenPresenceNow = presenceUnproven({
          team,
          state,
          presence,
          ...(sources.presenceChannelHealthy === undefined ? {} : { channelHealthy: sources.presenceChannelHealthy }),
          ...(sources.presenceChannelReason === undefined ? {} : { channelReason: sources.presenceChannelReason }),
          now: sources.now(),
        });
        if (!foreign && sources.statusSource !== undefined) {
          statusEngine ??= createSeatStatusEngine({
            team,
            session,
            root,
            home: sources.home,
            source: sources.statusSource,
            now: () => sources.now().getTime(),
            graceMs: inForce.interval * 1000,
            publish: sources.busPublish,
            nativeHeld: () => nativeHeldNow,
            ...(hosted !== undefined
              ? {
                deliverClimb: (climb: StatusClimb): boolean => {
                  if (!hostedClimbTakes(climb, root, session, team)) return false;
                  holdClimb(dir, hostedClimbs, climb);
                  return true;
                },
              }
              : {}),
          });
          const panesBySeat: Record<string, string> = {};
          // The blocked seats' own reads share one allowance per pass.
          let blockedReadsLeftMs = BLOCKED_SCREEN_READS_PER_PASS_MS;
          for (const seat of team.seats) {
            // Between seats: the screen read below is synchronous and can be slow.
            await yieldBeat();
            if (seat.human === true || seat.stopped === true) continue;
            const agent = live.agents.find((candidate) => candidate.name === seat.name);
            if (!agent) continue;
            panesBySeat[seat.name] = agent.pane;
            const hasSidebarLabel = hosted !== undefined || Boolean(memory.seatLabels[seat.name]?.title);
            const readScreenNow = shouldReadScreenForStatus(seat, agent.status, hasSidebarLabel);
            const liveScreen = live.screens[agent.pane];
            // The fallback read is the same bounded, awaited call when the source supplies one:
            // a pane whose screen the whole-session read could not take is asked once more,
            // never with the pass's budget already spent.
            let extra = readScreenNow && (liveScreen === undefined || liveScreen === '')
              ? await screenRead(sources, gate, agent.pane, session)
              : undefined;
            // A seat the host reports blocked is read even when the pass's read budget is spent:
            // its prompt's kind and text are what its lead is told, and without a screen the
            // notice could only say the screen was not recognised (2026-11-15: a Grok approval
            // dialog reported that way twice under load). One bounded read per blocked seat.
            if (
              agent.status === 'blocked' && (liveScreen === undefined || liveScreen === '')
              && (extra === undefined || extra === null || extra === '') && blockedReadsLeftMs > 0
            ) {
              const began = Date.now();
              extra = await blockedScreenRead(sources, agent.pane, session, hosted?.signal, Math.min(BLOCKED_SCREEN_READ_MS, blockedReadsLeftMs));
              blockedReadsLeftMs -= Date.now() - began;
              // A stop that cut the read ends the pass here: nothing is observed or escalated
              // from a read the stop aborted.
              if (hosted?.signal.aborted === true) break;
            }
            const rawScreen = readScreenNow
              ? (liveScreen !== undefined && liveScreen !== '' ? liveScreen : (extra ?? liveScreen))
              : undefined;
            if (rawScreen !== undefined && rawScreen !== '') {
              live.screens[agent.pane] = rawScreen;
            }
            if (herdrUnreliable(seat.cli)) {
              await statusEngine.pollUnreliableSeat(seat.name, rawScreen ?? liveScreen, now, agent.pane);
            } else if (
              agent.status === 'idle'
              || agent.status === 'working'
              || agent.status === 'blocked'
              || agent.status === 'done'
              || agent.status === 'unknown'
            ) {
              const verifyScreen = isScreenVerifiedStatusCli(seat.cli) || agent.status === 'blocked'
                ? rawScreen
                : undefined;
              await statusEngine.observe(seat.name, agent.status, now, agent.pane, verifyScreen);
            }
          }
          // A stop during the seats' reads observes and escalates nothing more this pass.
          if (hosted?.signal.aborted !== true) await statusEngine.tick(now);
          if (hosted !== undefined && sources.home !== undefined) {
            loadHeldClimbs(dir, hostedClimbs);
            if (hostedClimbs.length > 0) await sendHostedClimbs(sources.home, root, team, session, hostedClimbs, dir, sources.now);
          }
          // A seat its sandbox confines sends and replies through its outbox: the daemon's
          // watch runs those commands for it, as that seat (src/send/confined-outbox.ts).
          // The pass hands the outbox relay its latest reading of the team and the live panes;
          // the relay runs on its own short tick (below), not at the pass's pace.
          if (hosted !== undefined) {
            relayContext = { team, agents: live.agents.map((agent) => ({ name: agent.name, pane: agent.pane })) };
          }
          const nextPanesKey = Object.entries(panesBySeat)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(',');
          if (nextPanesKey !== statusWaitersKey) {
            statusWaiters?.stop();
            await statusWaiters?.done;
            statusWaitersKey = nextPanesKey;
            statusWaiters = nextPanesKey === ''
              ? undefined
              : statusEngine.startWaiters(panesBySeat, { timeoutMs: Math.min(9_000, inForce.interval * 1000) });
          }
        }
        // The check commands run here, outside the pass, at most every `check_every` (§ 5): the
        // pass reads what they read, and nothing else. Only their state is ever said — a
        // contract failure or a timeout says `unreadable`, never a line of what they printed.
        if (checksAt === null || now - checksAt >= budget.checkEvery * 1000) {
          await yieldBeat();
          const checkCall = gate.take();
          // A pass whose budget is spent before the checks leaves `checksAt` where it is, so the
          // next pass runs them rather than skipping a whole cadence. A stop between two check
          // commands ends the list inside the awaited runner.
          if (checkCall !== null) {
            checksAt = now;
            outcomes = sources.readChecksAsync !== undefined
              ? await sources.readChecksAsync(standing, team, now, checkCall)
              : sources.readChecks(standing, team, now);
            // A check command is awaited (or synchronous) and can run for its own timeout: the
            // beat it displaced lands as soon as it returns.
            await yieldBeat();
            // The money a spend check counted is kept, like the pass's screen readings: the launch
            // gate of `up` and `add` reads it later, and one that is stale by then reads unknown
            // (§ 5). An account whose check did not run keeps its stored reading.
            if (!foreign) saveSpendReadings(dir, spendOf(outcomes));
            for (const outcome of outcomes) {
              const key = `check:${outcome.account}`;
              if (outcome.state === 'read') {
                told.delete(key);
                continue;
              }
              if (told.has(key)) continue;
              // A check the stop aborted is not unreadable: nothing is said during a shutdown.
              if (stopped()) continue;
              told.add(key);
              say(outcome.state === 'unreadable'
                ? `${outcome.account}: its check is unreadable`
                : `the check for ${outcome.account} is unapproved; that account reads unknown`, false);
            }
          }
        }
        // Herdr's process list per pane, read with the screen: a figure is only read off a pane
        // where herdr reports the seat's CLI. A pane it can't read is null, and a null is not a
        // CLI: no figure. One `pane process-info` per pane answers both figures, and the awaited
        // whole-session read already took it: the maps it returned are this pass's reading. A
        // seam whose live read does not carry them keeps the per-pane read, still bounded by the
        // same budget; a pane the budget did not reach is left out of the maps — unread, which
        // the pass reports as unknown, never as gone.
        const foreground: Record<string, string[] | null> = {};
        const processes: Record<string, PaneProcesses | null> = {};
        if (live.foreground !== undefined && live.processes !== undefined) {
          Object.assign(foreground, live.foreground);
          Object.assign(processes, live.processes);
        } else {
          for (const agent of live.agents) {
            // Between seats: the process read, one per figure when the seam has no whole-session
            // map to offer.
            await yieldBeat();
            foreground[agent.pane] = await foregroundRead(sources, gate, agent.pane, session);
            processes[agent.pane] = await processesRead(sources, gate, agent.pane, session);
          }
        }
        // The machine's own readings, written to the log at the slow rate: the same figures the
        // pass below reads, whether or not anything is wrong, so the night the incident was is
        // on record in the tool's own files. `unread` where a figure couldn't be read; the gate
        // that acts on these figures is elsewhere and unchanged. Awaited when the source supplies
        // the child-bounded read; a pass whose budget is spent before it reads the unread shape.
        const machineCall = gate.take();
        const machine = machineCall === null
          ? unreadMachine()
          : sources.machineAsync !== undefined
            ? await traceChildStep('readings machine', () => sources.machineAsync!(root, machineCall))
            : traceChildStep('readings machine', () => sources.machine(root));
        await yieldBeat();
        if (stopped()) break;
        if (readingsAt === null || now - readingsAt >= READINGS_EVERY * 1000) {
          readingsAt = now;
          logLine(dir, 'watch', 'watch', `readings: ${readingsText(machine)}`, sources.now());
        }
        const machineAccounts = sources.home === undefined ? [] : traceChildStep('readings machine accounts', () => machineAccountsOf(sources.home!));
        // The queue reading for the idle summary: reported to the log and the bus like any other
        // report, never typed into the orchestrator's pane.
        const queueDepths = traceChildStep('readings queue depths', () => readQueueDepths(team, root, sources.home, Object.keys(state.seats).filter((name) => state.seats[name]?.temporary)));
        const queueBacklog = queueDepths ? readBacklogDepth(team, root, sources.home) : null;
        // The entity's model rule, read once for this pass: the breach list `team check` prints,
        // narrowed to this team by name. The pass never reads the entity's files itself.
        const modelRule = traceChildStep('registry model rule', () => modelRuleOfPass(team, root, sources.home));
        // The pass's record reads happen before its fold, never inside it: the fold holds the
        // state lock, and an unbounded scan (the mailbox, the agent registry, the liveness
        // files) must not keep another command out of the state while it runs. Each reads this
        // pass's own snapshot, so moving them changes no figure the pass computes.
        const signing = sources.home === undefined ? undefined : traceChildStep('registry signing', () => new Map(team.seats.map((seat) => {
          const agent = findAgent(sources.home!, { team: teamIdOf(root), seat: seat.name });
          return [seat.name, agent ? { ...agent.signing, cli: agent.cli, launch: agent.launch } : null] as const;
        })));
        // The same records, read for continuity: a pane restored from outside the launch line
        // is the seat while the record's session is the one the pane runs.
        const continuityIds = sources.home === undefined ? undefined : traceChildStep('registry continuity', () => continuityIdsOf({
          home: sources.home!,
          root,
          herdrSession: session,
          seats: team.seats,
          states: state.seats,
        }));
        const liveness = {
          machine: machineLiveness(sources.home),
          entity: entityLiveness(sources.home, team.entity),
          project: projectLiveness(sources.home, root),
        };
        const mail = !foreign && sources.home !== undefined
          ? new MailPass({ dir, root, session, home: sources.home, lead: team.orchestrator })
          : undefined;
        const mailbox = !foreign && sources.home
          ? (sources.readMailbox ?? mailboxWaiting)(root, dir, team, live, sources.home, new Date(now), mail)
          : [];
        const queued = new Set<string>();
        if (mail !== undefined) {
          for (const seat of team.seats) {
            if (mail.unread(seat.name).length > 0) queued.add(seat.name);
          }
        }
        const unsentNotes = new Map<string, number | null>();
        const run = (stored: readonly Seen[]) => pass({
          machineAccounts,
          signing,
          continuityIds,
          team, state, live, machine, now, memory,
          queueDepths,
          queueBacklog,
          // The team's pause is the project's, not this session's: every watch of the project
          // stops nudging, and a foreign watch's notice is dropped where every other work drop
          // of that watch is.
          pause: whole.pause ?? null,
          // Seats paused on their own are skipped by this pass's work nudges; the rest of the
          // team keeps its nudges.
          seatPauses: whole.seat_pauses ?? null,
          approval: standing.kind === 'verified' ? [] : null, approvalReason, watch: inForce,
          modelRule,
          liveness,
          // The team's words are the watch as written, not as `tempo` scaled it: the tighten-only
          // check reads declarations, and the tempo is applied to the resolved idle window after.
          livenessTeam: watchWords(standing.kind === 'verified' ? team.watch : defaultWatch()),
          tempo: standing.kind === 'verified' ? team.tempo : 'normal',
          outcomes, budgets: budget,
          quotaFor: (cli) => quotaWith(cli, overrides.profiles),
          readScreen: (cli, pane) => classifyWith(cli, pane, overrides.profiles),
          nativeHeld: nativeHeldNow,
          readings: stored, foreground, processes,
          // The pass itself is synchronous and can be long: a hosted pass carries a due daemon
          // beat to the other routes between its seats. A CLI watch passes none.
          ...(hosted?.beat === undefined ? {} : { beat: hosted.beat }),
          // A record is bound to the file's session. A watch of another session neither rings
          // nor raises the owner line; the file's own watch still does both.
          mailbox,
          queued,
          onUnsent: (name, since) => { unsentNotes.set(name, since); },
          // The out-of-tokens mark lives beside the state, so a later send can skip the seat
          // after this pass has left the pane.
          agentsDir: dir,
        });
        // The pass computes on a snapshot read before the lock and returns its result outside
        // it: a long pass never keeps another command out of the state. Only the merge of its
        // readings is written under the lock, by key over whatever the state holds now, so a
        // reading another writer landed while the pass ran is kept; an unchanged result skips
        // the write. A watch on a foreign session still folds, for its reports, and saves
        // nothing.
        const snapshot = traceChildStep('readings stored snapshot', () => loadReadings(dir));
        await yieldBeat();
        const computed = traceChildStep('watch fold', () => run(snapshot));
        if (!foreign && unsentNotes.size > 0) {
          updateState(dir, (file) => {
            let changed = false;
            for (const [name, since] of unsentNotes) {
              const seat = file.sessions[session]?.seats[name];
              if (seat === undefined) continue;
              if (since === null) {
                if (seat.unsent_since !== undefined) {
                  delete seat.unsent_since;
                  changed = true;
                }
              } else {
                const iso = new Date(since).toISOString();
                if (seat.unsent_since !== iso) {
                  seat.unsent_since = iso;
                  changed = true;
                }
              }
            }
            return changed;
          }, { writeWhen: (changed) => changed });
        }
        const result = foreign
          ? computed
          : updateReadings(dir, now, (stored) => ({
            readings: overlayReadings(stored, computed.readings),
            value: computed,
          }), { skipIdentical: true });
        if (!foreign && sources.home) saveMachineReadings(sources.home, result.machineReadings, now);
        await yieldBeat();
        // The entity's model rule, carried out without a caller: a breaching seat the queue does
        // not hold yet is queued here. Only the file's own watch queues — a foreign session
        // writes nothing, and a watch with no home has no policy chain to read the wait from.
        if (!foreign && sources.home !== undefined && hosted === undefined && paceVerified) {
          try {
            for (const [breaching, swap] of queueRuleBreaches({
              dir, root, home: sources.home, team, rule: modelRule, by: 'the watch', now: sources.now,
            })) tell(swapLine(breaching, swap, sources.now()), false);
          } catch (error) {
            tellOnce(told, 'rule-queue', `the model rule's swaps were not queued: ${(error as Error).message}`, tell);
          }
        }
        // The seats this project's queue waits on, whoever queued them: the pass types no work
        // drop into one, so it takes no task while its swap waits (the design's work-drop rule).
        const waiting = new Set(queuedSwaps(readState(dir)).map(([seat]) => seat));
        // The dispatcher: the watch's one path to an idle seat with takeable work. It reads the
        // same snapshot `status` prints (no picker of its own, no claim) and calls the direct
        // route when the sources wire one. Every automatic work request is decided here and
        // nowhere else: the legacy typed work nudge is retired below, so a seat the reading
        // cannot prove idle is typed at by nobody. `--no-nudge` is the watch that types nothing:
        // it dispatches nothing at all rather than spending an episode on a route it was told
        // not to use.
        const idleDispatch: IdleDispatchResult = dispatchHeld
          ? { pushed: [], suppressed: [] }
          : await dispatchIdleWork({
            root, dir, team, state, live, now: sources.now(),
            home: sources.home,
            pause: whole.pause ?? null,
            seatPauses: whole.seat_pauses ?? null,
            swaps: [...waiting],
            body: (seat) => (team.watch.nudge ?? NUDGE_TEXT).replaceAll('<your seat name>', seat),
            push: sources.pushWork,
            // The caller's own per-seat knowledge, never the store's last word: with no
            // provider every seat's answer is not known and the dispatcher holds its native
            // projection.
            presenceChannelHealthy: sources.presenceChannelHealthy,
            // The same snapshot and hold the rest of this pass reads, so the dispatcher, the
            // status engine and the typed fallbacks cannot disagree about a seat.
            presence,
            // The pass's prefetched broker reading, when a caller hosts one: the dispatcher
            // counts it with the picker's own rules and never reads the tracker itself.
            ...(broker === undefined ? {} : { broker }),
          });
        await yieldBeat();
        for (const item of idleDispatch.pushed) {
          if (item.ok) continue;
          const standing = item.staged === true
            ? 'the work waits in its bus inbox and is read at its next wake'
            : 'nothing was written for it and the attempt is not retried in this idle episode';
          tell(`${item.seat}: its work was not dispatched directly (${item.refused}); ${standing}`, false);
        }
        for (const line of idleDispatch.fallback?.failed ?? []) tell(line, true);
        for (const line of idleDispatch.fallback?.missing ?? []) say(line, false);
        // The seats whose idle episode the dispatcher owns. The ring guard below reads it, so a
        // mail notification is never a second typed path into an episode already delivered (or
        // reported undelivered) by the dispatcher.
        const suppressed = new Set(idleDispatch.suppressed ?? []);
        // One report per episode. The dispatcher's record is the report for a seat it owns,
        // so the cant-work event does not also fire. A seat with no such episode still reports.
        if (suppressed.size > 0) {
          result.reports = result.reports.filter((report) => {
            if (!report.key.startsWith('cant-work:')) return true;
            return !suppressed.has(report.key.slice('cant-work:'.length));
          });
        }
        // The legacy automatic work typing is retired: every automatic work request goes through
        // the shared dispatcher reading above. A seat the reading cannot prove idle (no truthful
        // stamp, unknown window, unreadable source) or cannot offer work to (an empty source) is
        // typed at by nobody: absence of evidence is silence, never a guess. The pause's own
        // drops are not work requests and stay, and `--no-nudge` still names what it would not
        // type.
        if (!foreign && !args.flags.has('no-nudge') && whole.pause == null) result.work = [];
        // An unreadable pace holds every automated work request: the pass keeps reading and
        // reporting, and types nothing that depends on a rhythm it cannot verify.
        if (!paceVerified) result.work = [];
        // A liveness word the chain set aside: said once per process, as a line, never typed
        // into a seat and never a desktop notice. The value in force stands.
        for (const refusal of result.refusals) {
          const key = `liveness:${refusal.setting}`;
          if (told.has(key)) continue;
          told.add(key);
          say(refusal.text, false);
        }
        // The watch's own reports ring as they always have: an owner-addressed one is a decision
        // moment (a prompt, a floor, a screen nobody knows), and `--no-notify` silences operator
        // notices, never an owner push. The owner's immediacy list batches what arrives on the
        // bus (`OwnerDelivery`), not these; a report that is also published as an event is
        // recorded once there and not rung a second time.
        const reportTs = sources.now().toISOString();
        for (const report of result.reports) {
          if (report.to === 'owner') ownerTold.add(report.text);
          tell(report.text, report.to === 'owner' || !args.flags.has('no-notify'));
        }
        for (const item of result.cantWork ?? []) {
          // The lead's copy is a signed record in the lead's mailbox and, when this team has
          // a parent, in that orchestrator's. The report loop above already printed the line;
          // the bus publish below carries the same report. A hold still reports. A restart
          // does not: it is an effect, and it waits for a watch whose effects are open.
          if (item.tellLead && !suppressed.has(item.seat) && !foreign && sources.home !== undefined && hosted === undefined) {
            tellLeadCantWork(sources.home, root, team, session, item.seat, `${item.seat}: ${item.line}`, reportTs);
          }
          // A wake the seat did not take is retried by the unread pass below, under the same
          // hold. This loop does not type a second one.
          if (item.restart === undefined || foreign || quiet || hosted !== undefined || sources.restartSeat === undefined) continue;
          // Marked only once the restart is actually asked for. A held pass leaves it unset,
          // so the next open pass still carries the plan.
          const workEpisodes = memory.slots['seat-cant-work'] as Record<string, { restarted?: boolean }> | undefined;
          const workEpisode = workEpisodes?.[item.seat];
          if (workEpisode) workEpisode.restarted = true;
          logLine(dir, 'watch', 'watch', item.restart.audit, sources.now());
          try {
            const code = await sources.restartSeat(item.seat, io);
            logLine(dir, 'watch', 'watch', `restart ${item.seat} ended ${String(code)}`, sources.now());
          } catch (error) {
            logLine(dir, 'watch', 'watch', `restart ${item.seat} failed: ${(error as Error).message}`, sources.now());
          }
        }
        // What the pass saw goes on the bus whatever started this watch: a report is the watch's
        // contribution, not a privileged delivery, and a bus that is not running answers
        // `unavailable` without making the pass wait. A hosted watch does not publish that bus
        // and does not write the lead's mailbox itself. One blocked episode for a seat the
        // dispatcher does not own goes out as the daemon's own notice, to the lead alone.
        if (!foreign && hosted !== undefined && sources.home !== undefined) {
          await sendHostedBlockedEpisodes(
            sources.home, root, team, session, result.reports, reportTs, suppressed, memory, dir, sources.now,
            (seat) => screenExcerpt(live, seat),
          );
        }
        if (!foreign && sources.busPublish !== undefined && hosted === undefined) {
          await publishWatchReportsToBus(root, session, result.reports, reportTs, sources.busPublish);
        }
        // A prompt that is the lead's own, or one the lead has not cleared in time, climbs to the
        // entity's lead in that team's own mailbox. The registry names no entity lead: the climb
        // is still the event the line above published, whose routing always carries the owner.
        if (!foreign && sources.home && hosted === undefined && paceVerified) {
          for (const line of escalatePromptReports(
            sources.home, root, team, session, result.reports, reportTs,
          ).failed) tell(line, true);
        }
        for (const label of result.labels) {
          const slot = (memory.seatLabels[label.name] ??= {});
          if (hosted !== undefined) {
            if (label.title) slot.title = label.title;
            if (label.displayAgent) {
              slot.line = label.displayAgent;
              slot.reportedAt = now;
            }
            continue;
          }
          if (label.title && sources.renameWorkspace) {
            if (sources.renameWorkspace(session, label.workspace, label.title)) slot.title = label.title;
            else say(`${label.name}: its title was not reported`, false);
          }
          if (label.displayAgent && sources.reportDisplayAgent) {
            if (sources.reportDisplayAgent(session, label.pane, label.displayAgent, sidebar.ttlMs)) {
              slot.line = label.displayAgent;
              slot.reportedAt = now;
            } else say(`${label.name}: its display was not reported`, false);
          }
        }
        if (!foreign && statusEngine !== undefined) {
          // The status engine's automatic work nudge is retired with the pass's own: draining
          // clears its memory, and nothing is typed into a seat from here. Every automatic work
          // request is the dispatcher's decision above.
          statusEngine.drainNudges();
        }
        const delivered = new Set<string>();
        if (!foreign && hosted === undefined) {
          for (const item of result.work) {
            if (item.pane === ownPane) continue;
            // No work drop moves a seat a swap waits on: the seat is at its boundary, or close
            // to it, and a fresh task would take the swap past another wait.
            if (waiting.has(item.seat)) continue;
            if (quiet) {
              say(`nudge not typed (--no-nudge): ${item.body}`, false);
              continue;
            }
            const written = writeWorkDrop(dir, session, item.seat, item.body);
            if ('error' in written) {
              tell(written.error, true);
              continue;
            }
            await deliver({
              pane: item.pane,
              text: written.trigger,
              cli: item.cli,
              seat: item.seat,
              said: item.body,
            }, team, session, sources, memory, say, tell, told);
            delivered.add(item.pane);
          }
        }
        // The ring is a typed path of its own: a seat whose idle episode the dispatcher owns is
        // not typed at by it either. That episode is the dispatcher's to deliver (or to report
        // undelivered to the lead), and a stored signed copy waiting unread is not a wake. When
        // the daemon hosts the watch, the hosted loop owns the ring and this pass types nothing;
        // an unverified pace holds the ring with the rest of the automatic work.
        // Resolve receipts before the ring: an inbox/drop receipt can prove this id was read
        // even when the matching mailbox record's separate receipt is not present.
        const readOptions = () => gate.take();
        const promotedReads = !foreign
          ? promoteInboxDrops({
            dir, session, root, home: sources.home, team, live, processes, readOptions, ownPane, sources, now: sources.now(), say,
          })
          : new Set<string>();
        await yieldBeat();
        const ring = result.ring;
        const rung = new Set<string>();
        if (ring && delivered.size === 0 && !suppressed.has(ring.to) && hosted === undefined && paceVerified && sources.home !== undefined) {
          if (quiet) say(`ring not typed (--no-nudge): ${ring.text}`, false);
          // A read that landed since the pass read the mailbox is the seat's own word: the signed
          // receipt is read again here, and an already-read message is not reminded. The snapshot
          // held it only because the read came after that read.
          else if (promotedReads.has(`${ring.to}\n${ring.id}`)
            || !listUnacked(root, team.session, sources.home, team.orchestrator).some((one) => one.id === ring.id && one.to === ring.to)) {
            say(`ring not typed: message ${ring.id} is already read`, false);
          } else {
            await deliver({
              pane: ring.pane,
              text: ring.text,
              cli: ring.cli,
              ring: { to: ring.to },
            }, team, session, sources, memory, say, tell, told);
            rung.add(ring.to);
          }
        }
        // An inbox send the seat's client has read since the last pass is promoted here: the
        // receipt is that client's own word, and the history records `delivered (read)` once. It
        // types nothing and needs no pane, so a watch without nudges promotes it just the same.
        // A send held while a pane was busy leaves its drop and a record beside it: the pass
        // delivers one per seat once the box is free, bounded, and says the drop's path when it
        // gives up. `--no-nudge` is the watch that types nothing, and this types too.
        if (!foreign && !quiet && hosted === undefined && paceVerified) {
          await retryHeldDrops({
            dir, session, root, home: sources.home, team, live, processes, readOptions, ownPane, sources, now: sources.now(), say,
            nativeHeld: nativeHeldNow,
            // The channel's one redelivery dials the receiving session's socket with the stored
            // signed record; a seat whose launch the socket gate refuses falls through to the
            // typed leg the retry already walks.
            socketRedeliver: (dropDir, drop) => {
              const seat = team.seats.find((one) => one.name === drop.to);
              return redeliverChannelOnSocket({
                host: { ...realHost, home: sources.home ?? realHost.home, now: sources.now },
                dir,
                root,
                project: team.project,
                session,
                seat: drop.to,
                cli: seat?.cli ?? '',
                dropDir,
                drop,
                team,
                ...(seat === undefined ? {} : { launch: seat.launch }),
              });
            },
          });
        }
        // A delivered send whose seat was not seen acting on the line yet leaves a record of its
        // own: this pass looks for the sign and, past the window, says so once. It types nothing,
        // so a watch without nudges still keeps that word for the sender.
        if (!foreign) {
          await expirePendingNative(
            { dir, session, root, home: sources.home, team, live, processes, readOptions, ownPane, sources, now: sources.now(), say, nativeHeld: nativeHeldNow },
            { noNudge: quiet },
          );
          await confirmTakenDrops({
            dir, session, root, home: sources.home, team, live, processes, readOptions, ownPane, sources, now: sources.now(), say,
          });
          await yieldBeat();
          // A delivery is a deposit until the seat's signed receipt follows: a message still
          // unread its seat's window after it landed gets the next leg down the cascade — the
          // webhook adapter before the typed line (ADR message-path, D2) — and one still
          // unread at twice that window is reported to its sender and the team's lead. The
          // window is the file's declared word when it moved the section, else the seat class's
          // own default: 30 s for a seat a message can wake while idle, 60 s for a typed one.
          // The report is a mailbox record, so a watch without nudges keeps that word.
          //
          // The wake runs under a hosted loop too. Its raw writers are closed there, but the one
          // seam a hosted source set keeps is the gated typed wake (`hostedWatchSources`), and
          // the cascade's webhook leg needs no pane at all: leaving the wake out of a hosted
          // pass made every daemon-hosted root drop the N re-wake while the 2N report still
          // spoke, so a seat was told nothing and then reported. `--no-nudge` is the caller's
          // word, and only that leaves the wake out.
          const declaredUnread = declaredUnreadAfter(inForce, watchPace);
          const unreadWindows = new Map<string, number>();
          const unreadWindowOf = (seat: Seat): number => {
            if ((team.orchestrator !== '' && seat.name === team.orchestrator)
              || (team.operator !== '' && seat.name === team.operator)) return inForce.leadUnreadAfter;
            const known = unreadWindows.get(seat.name);
            if (known !== undefined) return known;
            const seconds = unreadWindowSeconds(declaredUnread, seatDeliveryClass({
              dir,
              root,
              session,
              seat: seat.name,
              declared: seat,
              ...(state.seats[seat.name] === undefined ? {} : { state: state.seats[seat.name] }),
              ...(sources.home === undefined ? {} : { home: sources.home }),
            }).class);
            unreadWindows.set(seat.name, seconds);
            return seconds;
          };
          // The stuck report runs before the wake: it names every seat whose oldest unread has
          // waited past twice its window without a fresh proven working word, whatever the screen
          // says — and its episode marker is what keeps the wake path's own blocked notice from
          // saying the same thing twice. The unread report below reads the same reading: the
          // lead's generic word stays out while that episode speaks or a young turn may read it.
          const stuckReading = {
            workingSince: workingSinceNow,
            stuckAfterSeconds: inForce.stuckAfter,
            stalePresence: unprovenPresenceNow,
          };
          reportStuckSeats(
            { dir, session, root, home: sources.home, team, live, ownPane, sources, now: sources.now(), say, ...(mail === undefined ? {} : { mail }) },
            { unreadAfter: inForce.unreadAfter, seatWindow: unreadWindowOf },
            stuckReading,
          );
          await wakeUnreadDrops(
            {
              dir, session, root, home: sources.home, team, live, processes, readOptions, ownPane, sources, now: sources.now(), say, nativeHeld: nativeHeldNow,
              ...(mail === undefined ? {} : { mail }),
              // A hosted watch sends the unread-lead climb as the daemon's notice, like a prompt's.
              ...(hosted === undefined ? {} : {
                deliverClimb: (climb: StatusClimb): boolean => {
                  if (!hostedClimbTakes(climb, root, session, team)) return false;
                  holdClimb(dir, hostedClimbs, climb);
                  return true;
                },
              }),
            },
            { unreadAfter: inForce.unreadAfter, seatWindow: unreadWindowOf, rung, ...(quiet || !paceVerified ? { noNudge: true } : {}) },
          );
          reportUnreadDrops(
            { dir, session, root, home: sources.home, team, live, processes, readOptions, ownPane, sources, now: sources.now(), say, ...(mail === undefined ? {} : { mail }) },
            { unreadAfter: inForce.unreadAfter, seatWindow: unreadWindowOf },
            stuckReading,
          );
        }
        if (!foreign && sources.home !== undefined && current.ok && current.notice === undefined) {
          clearRepairedModelDrifts({ dir, root, home: sources.home, session, team, live, fences: driftFences });
        }
        if (result.mailboxNote) tell(result.mailboxNote, true);
        await yieldBeat();
        // A hosted watch closes no seat, removes no worktree and runs no swap: those are
        // destructive actions, and the quiet foundation leaves them to a watch whose effects
        // are open. The reads that decide an end still happen where a caller asks for them.
        if (hosted === undefined) await closeEnded({ team, root, dir, session, live, sources, say, io, told });
        // The queue is carried out here, after the pass typed everything it had to type, so a
        // run inspects the boundary it will act on. `--no-nudge` is the watch that types
        // nothing, and a run types (the exit, the launch): such a watch queues the rule's seats
        // and leaves the run to a watch that may. A foreign session already writes nothing.
        if (
          hosted === undefined
          && !foreign
          && !quiet
          && sources.swapSources !== undefined
          && sources.home !== undefined
          && current.ok
          && current.notice === undefined
          && current.path !== undefined
        ) {
          try {
            const ran = await runDueSwaps({
              dir,
              root,
              home: sources.home,
              path: current.path,
              launchFile: launchTeamFile(current),
              team,
              session,
              io,
              json: false,
              notes: [],
              sources: sources.swapSources,
              by: 'the watch',
              owner: false,
              rulesOrigin: rulesOriginOf(current.source),
              ...(sources.presenceChannelHealthy === undefined ? {} : { presenceChannelHealthy: sources.presenceChannelHealthy }),
              now: sources.now,
            });
            // A ready swap is said once per new pane; a failure or a read-back mismatch once per
            // record's own words — the queue retries a busy turn silently, and the queue itself
            // already said what was queued.
            for (const swapResult of ran) {
              if (swapResult.kind === 'ready') {
                const key = `swap-ready:${swapResult.seat}:${swapResult.pane}`;
                if (told.has(key)) continue;
                told.add(key);
                tell(
                  `swapped: ${swapResult.seat} in ${swapResult.pane} (read-back ${
                    swapResult.readBack.kind === 'match' ? swapResult.readBack.model : 'unread'
                  })`,
                  true,
                );
              } else if (swapResult.kind === 'mismatch') {
                const key = `swap-mismatch:${swapResult.seat}:${swapResult.readBack.shown}`;
                if (told.has(key)) continue;
                told.add(key);
                tell(
                  `team swap: ${swapResult.seat}: read-back: mismatch — the file declares ${swapResult.readBack.expected}, the screen shows ${swapResult.readBack.shown}; the swap failed`,
                  true,
                );
              } else if (swapResult.kind === 'failed') {
                const key = `swap-failed:${swapResult.seat}:${swapResult.why}`;
                if (told.has(key)) continue;
                told.add(key);
                tell(`team swap: ${swapResult.seat}: ${swapResult.why}`, true);
              }
            }
          } catch (error) {
            tellOnce(told, 'swap-run', `the queue's swaps did not run: ${(error as Error).message}`, tell);
          }
        }
      }
      const flushed = owner?.flush();
      if (flushed?.error !== undefined) {
        tellOnce(told, 'owner-record', `the owner's inbox was not written: ${flushed.error}`, tell);
      }
      if (hosted !== undefined) {
        // One completed pass, on the pass's own clock. The host records liveness from this and
        // nothing else. No pane record is written and no pane is read for one: a hosted watch
        // never takes the session's live pane watch over.
        hosted.cycled(sources.now());
      } else {
        const place = placedWatch(dir, session, sources.pid, sources.ownPane ? () => own ?? null : undefined);
        if (place === 'end' && paneGoneOnce) {
          tell(`the watch's pane is gone; the watch ends with it`, true);
          break;
        }
        paneGoneOnce = place === 'end';
        beatWatch(dir, session, sources.pid, sources.now().toISOString(), place === 'end' ? 'keep' : place, watchStartedAt);
      }
      // The pass's read outcome: consecutive cut passes back off by doubling from five seconds up
      // to the watch's interval; a pass that read every pane it meant to clears both the count and
      // the line, so a later cut is a new episode. The retry repeats no report: every line a
      // pass prints is deduplicated by `told`, and the cut line is one of them.
      if (gate.cut) {
        cutPasses += 1;
        if (!told.has('read-cut')) {
          told.add('read-cut');
          say(`the read pass ran out of its ${limits.budgetMs} ms budget; the panes it did not reach are read on the next pass`, false);
        }
      } else {
        cutPasses = 0;
        told.delete('read-cut');
      }
      finishWatchPass();
      const waitSeconds = readWait(inForce.interval, gate.cut, cutPasses);
      // The label sweep, inside the wait: a running seat's own status line reaches line 2 in
      // about five seconds, not a whole interval. It repeats the pass's own rule on the panes
      // the last live read named — the same memory, so the two cannot disagree — and the next
      // pass re-reads everything and stays the authority.
      // A hosted watch has no sidebar and no pane line: the label sweep would only write
      // refusals to the daemon's log, so its wait carries no sweep.
      if (hosted !== undefined) {
        if (!(await sources.wait(waitSeconds))) break;
        continue;
      }
      const sweep = () => {
        const last = lastLive;
        if (last === null) return;
        const { failed } = labelSweep({
          seats: team.seats.filter((seat) => seat.human !== true),
          agents: last.agents,
          memory,
          read: (pane) => sources.screen(pane, session),
          report: (pane, text, ttlMs) =>
            sources.reportDisplayAgent?.(session, pane, text, ttlMs ?? sidebar.ttlMs) ?? false,
          now: sources.now().getTime(),
          refreshMs: sidebar.refreshMs,
          ttlMs: sidebar.ttlMs,
        });
        for (const seat of failed) say(`${seat.name}: its display was not reported`, false);
      };
      if (!(await sources.wait(waitSeconds, sweep))) break;
    }
  } finally {
    stopRelay();
    finishWatchPass();
    statusWaiters?.stop();
    await statusWaiters?.done;
    // A hosted watch never wrote the session's pane record, so it never deletes one either.
    if (hosted === undefined) {
      updateState(dir, (state) => {
        const record = state.sessions[session];
        if (record?.watch?.pid === sources.pid) delete record.watch;
      });
    }
    tell(`the watch of "${session}" stopped`, true);
  }
  // exit: watch.stopped
  return 0;
}

/** Writes the work prompt where `team send` writes a plain body: `.agents/send-drops/<session>/<seat>/<id>`,
 *  mode 0600, and returns the one line the pane is asked to read. A path that will not fit in
 *  that line is not written. */
function writeWorkDrop(
  dir: string, session: string, seat: string, body: string,
): { trigger: string } | { error: string } {
  // A work nudge is not a message: its name says so, and the receive side reads only records.
  const id = `work-${randomUUID()}`;
  const dropDir = join(dir, 'send-drops', session, seat);
  // Checked before the write, as `team send` does: a path that will not fit is not written.
  if (triggerLine(join(dropDir, id)) === null) {
    return { error: `${seat}: the trigger would exceed the limit; nothing was sent` };
  }
  let path: string;
  try {
    const root = join(dir, 'send-drops');
    const sessionDir = join(root, session);
    mkdirSync(dropDir, { recursive: true });
    chmodSync(root, 0o700);
    chmodSync(sessionDir, 0o700);
    chmodSync(dropDir, 0o700);
    path = dropMessage(dropDir, id, body);
  } catch {
    return { error: `${seat}: the drop file could not be written; nothing was typed` };
  }
  const trigger = triggerLine(path);
  if (trigger === null) return { error: `${seat}: the trigger would exceed the limit; nothing was sent` };
  return { trigger };
}

/** The spend readings among a pass's check outcomes, for the state. */
function spendOf(outcomes: readonly CheckOutcome[]): SpendReading[] {
  const list: SpendReading[] = [];
  for (const outcome of outcomes) {
    if (outcome.state !== 'read' || outcome.reading.kind !== 'spend') continue;
    list.push({
      account: outcome.account,
      amount: outcome.reading.amount,
      currency: outcome.reading.currency,
      at: outcome.reading.at,
    });
  }
  return list;
}

// Types the nudge, after reading the seat's screen once more: the pass saw it free, and a
// prompt may have appeared since. An empty idle prompt is typed into; a box still holding the
// line this same process typed itself and never sent is sent instead of typed into; anything
// else — another person's or agent's text, or the same text found after a restart — stays.
function mailboxWaiting(root: string, dir: string, team: TeamFile, live: Live, home: string, now: Date, mail?: MailPass): MailboxWaiting[] {
  // The ring's line names the seat's own drop read, so a record is ringable only while that read
  // would serve it. `listUnread` is the reader's own list — a message in the seat's drop folder
  // with no verifying read receipt — so the ring and `team drops --read` can never disagree. A
  // record in the older mailbox store (`.agents/messages/<seat>`) waits for `team messages`, a
  // reader the ring never names; ringing it typed a command that served nothing and re-fired
  // every pass. Such a record still raises the owner's waiting note when its box is not free.
  // The pass's reading is used when one is handed in, so the unacked list and each seat's unread
  // list are taken once for the whole pass; absent, this call takes its own.
  const scan = mail ?? new MailPass({ dir, root, session: team.session, home, lead: team.orchestrator });
  const servedByDrops = new Map<string, Set<string>>();
  // Each seat's current brief claim, read once per call.
  const claimIds = new Map<string, string | null>();
  const claimIdOf = (seat: string): string | null => {
    if (!claimIds.has(seat)) claimIds.set(seat, currentClaimIn(root, team.session, seat)?.id ?? null);
    return claimIds.get(seat) ?? null;
  };
  const waitingIds = (seat: string): Set<string> => {
    let ids = servedByDrops.get(seat);
    if (ids === undefined) {
      ids = new Set(scan.unread(seat).map((one) => one.id));
      servedByDrops.set(seat, ids);
    }
    return ids;
  };
  // The words every ring this call types shares: the registry naming and the receiving team's
  // template are read on the first record, never once per record.
  let words: WakeWords | undefined;
  const wordsNow = (): WakeWords => (words ??= wakeWordsFor(home, { root, session: team.session, team }, now));
  // The owner's inbox is delivered by the Runtime, not a seat's message: a record there never
  // counts as mail waiting in a pane.
  return scan.unacked().filter((record) => record.to !== 'owner').map((record) => {
    const named = live.agents.filter((agent) => agent.name === record.to);
    const agent = named.length === 1 ? named[0] : undefined;
    const seat = team.seats.find((item) => item.name === record.to);
    // The oldest waiting record's own line: its header, then the fixed read hint. A sender this
    // home cannot name falls back to the shipped nameless ring rather than ringing nothing.
    const sender = wakeTrigger(record, home, { root, session: team.session, team }, now, wordsNow());
    const text = (sender === null ? null : readTriggerLine(record.to, team.session, sender, seat?.cli ?? ''))
      ?? ringText(record.to, team.session);
    return {
      id: record.id,
      to: record.to,
      at: Date.parse(record.at),
      pane: agent?.pane ?? null,
      status: agent?.status ?? null,
      cli: seat?.cli ?? '',
      screen: agent ? live.screens[agent.pane] : undefined,
      served: waitingIds(record.to).has(record.id),
      // The seat's current launch brief, by the claim its state holds (never by the sender's
      // word): it waits on the seat's own turn-start read, not on a wake.
      brief: claimIdOf(record.to) === record.id,
      inDrops: existsSync(join(scan.dropDir(record.to), record.id)),
      text,
    };
  });
}

async function deliver(
  nudge: { pane: string; text: string; cli?: string; seat?: string; ring?: { to: string }; said?: string }, team: TeamFile, session: string, sources: WatchSources,
  memory: ReturnType<typeof newMemory>, say: (text: string, desktop: boolean) => void,
  tell: (text: string, notify: boolean) => void, told: Set<string>,
): Promise<void> {
  const who = nudge.ring?.to ?? nudge.seat ?? 'the seat';
  const cli = nudge.cli ?? team.seats.find((seat) => seat.name === who)?.cli ?? '';
  // A pane the team file marks as a human's is never typed into, and a nudge is typing: the
  // line is not typed, and the report says whose pane was spared. A ring's record stays
  // unacked, so the message waits for the person rather than being lost.
  if (team.seats.some((seat) => seat.name === who && seat.human === true)) {
    tellOnce(told, 'nudge:human', `a nudge was not typed: ${who} is a human's pane`, tell);
    return;
  }
  const look = () => readScreen(cli, sources.screen(nudge.pane, session) ?? undefined).kind;
  const holds = () => boxHoldsText(cli, nudge.text, sources.screen(nudge.pane, session) ?? undefined);
  const status = sources.status(nudge.pane, session);
  const names = profileFor(cli)?.processNames ?? [];
  const live = () => reportedLiveAgent(sources.foreground(nudge.pane, session), names);
  const noAgent = 'nudge:no-agent';
  if (!live()) {
    tellOnce(told, noAgent, `a nudge was not typed: no live agent in ${who}'s pane`, tell);
    return;
  }
  told.delete(noAgent);
  // The box may already hold this line — but only the record of this process's own typing, in
  // this same pane, can make it the watch's. The line is one fixed public constant, so the same
  // text typed by a person or an agent, or found by a restarted watch, is theirs: never typed
  // over, sent or cleared. One read settles both the kind and the claim.
  const raw = sources.screen(nudge.pane, session);
  const kind = readScreen(cli, raw ?? undefined).kind;
  const mine = kind === 'unsent' && ownUnsent(memory, nudge.pane, nudge.text, cli, raw ?? undefined);
  // A legible box shows what stands: a record that no longer matches it — the line was sent,
  // cleared or written over — is forgotten here, before anything is typed or sent.
  if ((kind === 'idle' || kind === 'unsent') && memory.ownNudge?.pane === nudge.pane && !mine) {
    memory.ownNudge = null;
  }
  // The free reading: herdr's idle or done, or — for a profile herdr cannot report — the seat's
  // own screen. The screen check beside it stays the gate on what may be typed into: only an
  // empty idle box takes the line.
  const quiet = herdrUnreliable(cli)
    ? kind === 'idle' || (mine && kind === 'unsent')
    : status === 'idle' || status === 'done';
  if (!quiet || (!mine && (kind !== 'idle' || !sources.typeText(nudge.pane, nudge.text, session)))) {
    return;
  }
  // The typing, and the record of whose it is: from here this process can claim the line, and a
  // later pass may send it. Nothing of this survives a restart — a new process starts with none.
  if (!mine) memory.ownNudge = { pane: nudge.pane, text: nudge.text };
  // The text is in the box. The agent is read again before Enter: it may have exited
  // since the text was typed, and an unframed line is not a box to send.
  if (!live()) {
    tellOnce(told, noAgent, `a nudge was not typed: no live agent in ${who}'s pane`, tell);
    return;
  }
  // The box is read back before the Enter: it must hold exactly the nudge's own text. The pane
  // draws late — the reading right after the typing is still the idle prompt, and the box
  // appears a moment later (the nudge-typing captures) — so the reading that decides the Enter
  // waits for it, the same bounded wait the exit typing makes, and a screen still idle at the
  // deadline is the text never drawn. Unsent text alone is not this nudge.
  let drawn = mine || holds();
  if (!drawn) {
    const deadline = sources.now().getTime() + DRAW_WAIT_MS;
    for (;;) {
      if (holds()) {
        drawn = true;
        break;
      }
      const currentStatus = sources.status(nudge.pane, session);
      if (currentStatus !== 'idle' && currentStatus !== 'done') {
        tell(`a nudge was typed and not sent: ${who} was not free when the box was read back`, true);
        return;
      }
      const kind = look();
      if (kind !== 'idle' && kind !== 'unsent') {
        tell(`a nudge was typed and not sent: ${who}'s box does not hold it`, true);
        return;
      }
      if (sources.now().getTime() >= deadline) break;
      const before = sources.now().getTime();
      await sources.sleep(100);
      if (sources.now().getTime() <= before) break;
    }
  }
  // The wait is a window the pane's state can change in: the agent can go, and the operator can
  // start a turn. Every check the Enter needs — the live agent, the status as it reads now, the
  // box — is taken here, with no await between them, so nothing that changed while the box drew
  // can have a key sent into it. The status read at the top of this function is not reused: it
  // predates the wait, and a turn that began under it must fail closed.
  if (!live()) {
    tellOnce(told, noAgent, `a nudge was not typed: no live agent in ${who}'s pane`, tell);
    return;
  }
  if (!drawn) {
    tell(`a nudge was typed and not sent: ${who}'s box does not hold it`, true);
    return;
  }
  const free = sources.status(nudge.pane, session);
  if (free !== 'idle' && free !== 'done') {
    tell(`a nudge was typed and not sent: ${who} was not free when the box was read back`, true);
    return;
  }
  if (sources.pressEnter(nudge.pane, session)) {
    // Sent: the line has left the box, so nothing here can claim it any more.
    memory.ownNudge = null;
    const spoken = nudge.said ?? nudge.text;
    say(nudge.ring
      ? `rang ${nudge.ring.to}: ${nudge.text}`
      : mine
        ? `nudged ${who} (its own unsent line was already in its box): ${spoken}`
        : `nudged ${who}: ${spoken}`, false);
  }
}

/** The liveness words of the project a team sits in, or none when it sits in none, no home is
 *  known, or the registry can't be read. The registry's own errors are `team check`'s to refuse;
 *  the watch keeps watching with the values in force. */
function projectLiveness(home: string | undefined, root: string): Partial<StateThresholds> | undefined {
  if (home === undefined) return undefined;
  try {
    return ofTeam(home, teamIdOf(root))?.liveness;
  } catch {
    return undefined;
  }
}

function tellOnce(told: Set<string>, key: string, text: string, tell: (text: string, notify: boolean) => void): void {
  if (told.has(key)) return;
  told.add(key);
  tell(text, true);
}

function noteWorked(dir: string, session: string, live: Live, now: Date): void {
  const recorded = readState(dir).sessions[session];
  if (!recorded) return;
  // Working is herdr's word, or — for a profile herdr cannot report — the seat's own screen:
  // herdr gives such a CLI no word while its turn runs.
  const working = (status: string, seat: { cli?: string } | undefined, pane: string): boolean =>
    status === 'working'
    || (seat !== undefined && herdrUnreliable(seat.cli) && readScreen(seat.cli ?? '', live.screens[pane]).kind === 'working');
  const due = live.agents.some((agent) => {
    const seat = agent.name ? recorded.seats[agent.name] : undefined;
    return seat && seat.stage === 'ready' && working(agent.status, seat, agent.pane);
  });
  if (!due) return;
  const activeAt = now.toISOString();
  updateState(dir, (file) => {
    const seats = (file.sessions[session] ??= emptySession()).seats;
    for (const agent of live.agents) {
      const seat = agent.name ? seats[agent.name] : undefined;
      if (seat && seat.stage === 'ready' && working(agent.status, seat, agent.pane)) {
        if (seat.temporary) seat.worked = true;
        seat.last_active = activeAt;
      }
    }
  });
}

function sayOnce(told: Set<string>, key: string, text: string | undefined, say: (text: string, desktop: boolean) => void): void {
  if (!text || told.has(key)) return;
  told.add(key);
  say(text, true);
}

// Closes a temporary seat whose end holds, and removes an on-merge worktree whose branch is merged.
// Anything that is not free, or not proved, is left as it is.
async function closeEnded(input: {
  team: TeamFile;
  root: string;
  dir: string;
  session: string;
  live: Live;
  sources: WatchSources;
  say: (text: string, desktop: boolean) => void;
  io: Io;
  told: Set<string>;
}): Promise<void> {
  const { team, root, dir, session, live, sources, say, io, told } = input;
  const endOf = sources.readEnd ?? readEnd;
  const state = readState(dir).sessions[session] ?? emptySession();
  for (const [name, recorded] of Object.entries(state.seats)) {
    const temporary = recorded.temporary;
    if (!temporary) continue;
    const task = temporary.task;
    const work = task ? state.worktrees[task] : undefined;
    const ownBefore = work ? work.own_commits === true : temporary.own_commits === true;
    const end = endOf(root, temporary.until, team.workspace.base, ownBefore, name);
    const agent = live.agents.find((item) => item.name === name);
    const cli = team.seats.find((seat) => seat.name === temporary.like)?.cli ?? '';
    const free = agent
      ? stateOf(sources.status(agent.pane, session) ?? agent.status, readScreen(cli, sources.screen(agent.pane, session) ?? undefined), cli) === 'free'
      : false;
    const decision = judgeTemporary({ worked: recorded.worked === true, free, ownBefore, end });
    if (decision.ownCommits) {
      updateState(dir, (file) => {
        const current = (file.sessions[session] ??= emptySession());
        if (work && task) {
          const tree = current.worktrees[task];
          if (tree) tree.own_commits = true;
        } else {
          const seat = current.seats[name];
          if (seat?.temporary) seat.temporary.own_commits = true;
        }
      });
    }
    sayOnce(told, `end:${name}`, decision.report, say);
    if (!decision.close || !agent) continue;
    // A temporary seat is not in the approved copy. The watch leaves it; the owner removes it.
    sayOnce(
      told,
      `unverified:${name}`,
      `${name}: its record is not an approved seat; left as it is (the owner cleans it: team remove ${name} --abandon)`,
      say,
    );
  }

  const again = readState(dir);
  const here = again.sessions[session] ?? emptySession();
  for (const [task, work] of Object.entries(here.worktrees)) {
    const occupied = Object.values(again.sessions).some((recorded) =>
      Object.values(recorded.seats).some((seat) => seat.temporary?.task === task));
    const end = endOf(root, `merged:${work.branch}`, team.workspace.base, work.own_commits === true);
    const decision = judgeWorktree({
      policy: team.workspace.remove, occupied, ownBefore: work.own_commits === true, end,
    });
    if (decision.ownCommits) {
      updateState(dir, (file) => {
        const tree = file.sessions[session]?.worktrees[task];
        if (tree) tree.own_commits = true;
      });
    }
    sayOnce(told, `worktree:${task}`, decision.report, say);
    if (!decision.close) continue;
    const code = sources.removeWorktree
      ? sources.removeWorktree(task)
      : removeWorktree(io, false, { home: homedir(), now: sources.now }, team, root, dir, session, task, undefined, 'watch');
    if (code !== 0) say(`worktree ${task} was not removed`, true);
  }
}

/**
 * Reads unseen bus events from `tracker.cursor` and forwards each accepted event to `onBusEvent`.
 * Each accepted event also reaches `deliver`, when given: the owner's delivery path (§4.5) is
 * built there. On a sequence `gap`, resets `tracker` to `newest_seq`, clears `memory.active` so
 * the next pass re-announces any still-true screen/team reports (`pass()` derives `memory.grace`
 * from `memory.active` each pass), and calls `onBusGap` so a subscriber maintaining a message
 * projection can rebuild it from the durable records on disk.
 */
export async function syncWatchBus(
  root: string,
  tracker: SequenceTracker,
  sources: Pick<WatchSources, 'busSubscribe' | 'onBusEvent' | 'onBusGap'>,
  memory?: Pick<Memory, 'active'>,
  deliver?: (event: SignedEventRecord) => void,
): Promise<boolean> {
  if (sources.busSubscribe === undefined) return false;
  try {
    const outcome = await sources.busSubscribe(root, tracker.cursor);
    if (outcome.kind === 'events') {
      for (const event of outcome.events) {
        if (tracker.accept(event)) {
          sources.onBusEvent?.(event);
          deliver?.(event);
        }
      }
      if (outcome.cursor > tracker.cursor) {
        tracker.reset(outcome.cursor);
      }
      return true;
    }
    if (outcome.kind === 'gap') {
      tracker.reset(outcome.newest_seq);
      memory?.active.clear();
      sources.onBusGap?.(outcome.oldest_seq, outcome.newest_seq, outcome.reason);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** The event one check report raises: the single place the report keys map to §4.3 kinds. Null
 *  for a key this build does not map. The event carries no addressing; the caller sets it. */
export function watchReportEvent(
  report: { key: string; text: string },
  session: string,
  ts: string,
): EventAppendInput | null {
  const colon = report.key.indexOf(':');
  if (colon < 0) return null;
  const prefix = report.key.slice(0, colon);
  const rawSeat = report.key.slice(colon + 1);
  const withoutOwner = rawSeat.endsWith(':owner') ? rawSeat.slice(0, -':owner'.length) : rawSeat;
  // A report may name its occurrence after the seat — `question:<seat>:<digest>` — so the seat is
  // the first field, never the whole tail.
  const seat = withoutOwner.split(':')[0] ?? '';
  if (seat === '') return null;

  if (prefix === 'missing' || prefix === 'never-started' || prefix === 'gone') {
    return {
      ts,
      kind: 'seat.unreachable',
      session,
      record_id: `watch:${prefix}:${seat}:${ts}`,
      seat,
      subject: seat,
      reason: report.text,
    };
  }
  if (prefix === 'permission' || (prefix === 'blocked' && report.text.includes('permission prompt'))) {
    return {
      ts,
      kind: 'seat.at-prompt',
      session,
      record_id: `watch:permission:${seat}:${ts}`,
      seat,
      subject: seat,
      prompt: 'permission',
      reason: report.text,
    };
  }
  if (prefix === 'question' || prefix === 'plan approval' || prefix === 'confirmation') {
    return {
      ts,
      kind: 'seat.at-prompt',
      session,
      record_id: `watch:${prefix}:${seat}:${ts}`,
      seat,
      subject: seat,
      prompt: prefix,
      reason: report.text,
    };
  }
  if (prefix === 'blocked') {
    return {
      ts,
      kind: 'seat.blocked',
      session,
      record_id: `watch:${prefix}:${seat}:${ts}`,
      seat,
      subject: seat,
      reason: report.text,
    };
  }
  if (prefix === 'vendor notice' || prefix === 'vendor') {
    return {
      ts,
      kind: 'seat.at-prompt',
      session,
      record_id: `watch:vendor-notice:${seat}:${ts}`,
      seat,
      subject: seat,
      prompt: 'vendor notice',
      reason: report.text,
    };
  }
  if (prefix === 'rate-limit') {
    return {
      ts,
      kind: 'seat.at-prompt',
      session,
      record_id: `watch:rate-limit:${seat}:${ts}`,
      seat,
      subject: seat,
      prompt: 'rate limit',
      reason: report.text,
    };
  }
  if (prefix === 'prompt-escalated') {
    return {
      ts,
      kind: 'seat.prompt-escalated',
      session,
      record_id: `watch:prompt-escalated:${seat}:${ts}`,
      seat,
      subject: seat,
      reason: report.text,
    };
  }
  if (prefix === 'cant-work') {
    return {
      ts,
      kind: 'seat.blocked',
      session,
      record_id: `watch:cant-work:${seat}:${ts}`,
      seat,
      subject: seat,
      reason: report.text,
    };
  }
  if (prefix === 'provider-error') {
    return {
      ts,
      kind: 'seat.blocked',
      session,
      record_id: `watch:provider-error:${seat}:${ts}`,
      seat,
      subject: seat,
      reason: report.text,
    };
  }
  return null;
}

/** One signed record for the team lead, and the same record for the parent orchestrator when
 *  the registry names one and it is not already the lead. `once` keeps the episode's repeat
 *  pass from writing a second copy. A team with no lead and no parent writes nothing here;
 *  the bus event still names the lead through the routing table. */
function tellLeadCantWork(
  home: string,
  root: string,
  team: TeamFile,
  session: string,
  seat: string,
  text: string,
  at: string,
): void {
  const id = `evt-cant-work-${seat}-${text.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)}`;
  const write = (target: { root: string; session: string; seat: string }): void => {
    writeRuntimeMailboxRecord({
      root: target.root,
      home,
      to: target.seat,
      id,
      text,
      session: target.session,
      at,
      once: true,
    });
  };
  if (team.orchestrator !== '') write({ root, session, seat: team.orchestrator });
  const main = readEntityOrchestrator(home, teamIdOf(root));
  if (main !== null && !(main.root === root && main.session === session && main.seat === team.orchestrator)) write(main);
}

/** A provider error and the can't-work line for that same seat are one episode. The map keeps
 *  one `seat.blocked` event for them. Anything else stays on its own record id. */
function blockedEpisodeKey(event: EventAppendInput): string {
  const id = event.record_id;
  if (
    event.kind === 'seat.blocked'
    && event.seat !== undefined
    && event.seat !== ''
    && (id.startsWith('watch:provider-error:') || id.startsWith('watch:cant-work:'))
  ) {
    return `blocked-episode:${event.seat}`;
  }
  return event.record_id;
}

/** The can't-work record is the episode's event. An owner-addressed copy adds the owner and
 *  leaves the lead and the operator on the same event. */
function keepBlockedEpisode(current: EventAppendInput, next: EventAppendInput, nextToOwner: boolean): EventAppendInput {
  const kept = next.record_id.startsWith('watch:cant-work:') ? next : current;
  if (nextToOwner || current.to === 'owner') kept.to = 'owner';
  return kept;
}

/** One folded event per observation. A provider error and the can't-work report of one seat
 *  share one event. An owner-addressed copy marks that event for the owner. */
function foldedWatchEvents(
  reports: readonly { key: string; text: string; to: string }[],
  session: string,
  ts: string,
): EventAppendInput[] {
  const events = new Map<string, EventAppendInput>();
  for (const report of reports) {
    const event = watchReportEvent(report, session, ts);
    if (event === null) continue;
    const key = blockedEpisodeKey(event);
    const existing = events.get(key);
    if (existing !== undefined) {
      events.set(key, keepBlockedEpisode(existing, event, report.to === 'owner'));
      continue;
    }
    if (report.to === 'owner') event.to = 'owner';
    events.set(key, event);
  }
  return [...events.values()];
}

/** One blocked episode waiting on a daemon notice. `id` is the episode's start. `sent` is
 *  set only after a send succeeds, so a refusal keeps this same id for the next pass. */
type PendingBlockedNotice = { body: string; id: string; sent: boolean };

/** A hosted watch's blocked episodes: one daemon notice per episode, to the team's lead and
 *  to nobody else. A seat the dispatcher owns is not among them. The notice id is the
 *  episode's start, the `since` the can't-work plan stored. A send that does not succeed
 *  stays pending and is tried again on each pass that still observes the seat blocked, under
 *  that same id. The episode ends only when the plan has dropped it, which is an observed
 *  recovery: a pass that does not repeat the report leaves the episode in place. The next
 *  blocked stretch is a new start and a new notice even when the words are the same. The raw
 *  bus and the direct mailbox write stay closed on this path. */
async function sendHostedBlockedEpisodes(
  home: string,
  root: string,
  team: TeamFile,
  session: string,
  reports: readonly { key: string; text: string; to: string }[],
  ts: string,
  suppressed: ReadonlySet<string>,
  memory: Memory,
  dir: string,
  now: () => Date,
  excerpt: (seat: string) => string | null = () => null,
): Promise<void> {
  const lead = team.orchestrator;
  if (lead === '') return;
  const episodes = memory.slots['seat-cant-work'] as Record<string, { since?: number; open?: boolean }> | undefined;
  const pending = (memory.slots['blocked-notice'] ??= {}) as Record<string, PendingBlockedNotice>;
  const prompts = (memory.slots['prompt-notice'] ??= {}) as Record<string, PendingPromptNotice>;
  for (const seat of Object.keys(pending)) {
    if (episodes?.[seat] === undefined) delete pending[seat];
  }
  const sendNotice = async (body: string, id: string): Promise<{ ok: boolean; text: string }> => {
    try {
      const sent = await sendDaemonDirect(
        {
          reminder: 'seat-blocked',
          due: ts,
          recipients: [{ root, session, seat: lead }],
          notice: 'seat-blocked',
        },
        { root, seat: lead, body, id },
        { ...realHost, home, now: () => now() },
      );
      return { ok: sent.ok, text: sent.text };
    } catch (error) {
      return { ok: false, text: (error as Error).message };
    }
  };
  // A prompt, or a screen nobody recognises, is its own cause: it goes out under its own id even
  // while a can't-work episode for the same seat is open, so a seat that moves from a wake it did
  // not take to a dialog is told again, with what the dialog is. The same cause stays quiet.
  const deliverPrompt = async (seat: string, body: string, id: string): Promise<void> => {
    const held = prompts[seat];
    if (held !== undefined && held.id === id && (held.sent || held.tries >= PROMPT_NOTICE_TRIES)) return;
    const tries = held !== undefined && held.id === id ? held.tries + 1 : 1;
    const sent = await sendNotice(body, id);
    prompts[seat] = { id, body, sent: sent.ok, tries };
    if (!sent.ok) logLine(dir, 'watch', 'watch', `${seat}: the prompt notice was not sent — ${sent.text}`, now());
  };
  const deliver = async (seat: string, body: string, id: string): Promise<void> => {
    const held = pending[seat];
    if (held !== undefined && held.id === id && held.sent) return;
    try {
      const sent = await sendDaemonDirect(
        {
          reminder: 'seat-blocked',
          due: ts,
          recipients: [{ root, session, seat: lead }],
          notice: 'seat-blocked',
        },
        { root, seat: lead, body, id },
        { ...realHost, home, now: () => now() },
      );
      if (sent.ok) pending[seat] = { body, id, sent: true };
      else {
        pending[seat] = { body, id, sent: false };
        logLine(dir, 'watch', 'watch', `${seat}: the blocked episode was not sent — ${sent.text}`, now());
      }
    } catch (error) {
      pending[seat] = { body, id, sent: false };
      logLine(dir, 'watch', 'watch', `${seat}: the blocked episode was not sent — ${(error as Error).message}`, now());
    }
  };
  const seen = new Set<string>();
  for (const event of foldedWatchEvents(reports, session, ts)) {
    if (event.seat === undefined || event.seat === '') continue;
    if (event.kind === 'seat.at-prompt' || (event.kind === 'seat.blocked' && blockedEpisodeKey(event) === event.record_id)) {
      if (suppressed.has(event.seat)) continue;
      const cause = promptCause(event);
      const shown = excerpt(event.seat);
      const body = shown === null
        ? event.reason ?? `${event.seat}: ${cause}`
        : `${event.reason ?? `${event.seat}: ${cause}`}\n\nOn its screen:\n${shown}`;
      // A prompt report is said once per spell, so the pass that carries it names the spell: the
      // same dialog met again after the seat moved on is a new spell and a new notice.
      const digest = createHash('sha256').update(`${cause}\n${event.reason ?? ''}`).digest('hex').slice(0, 12);
      const spell = ts.replace(/[^0-9A-Za-z]/g, '');
      await deliverPrompt(event.seat, body, `blocked-episode-${event.seat}-${digest}-${spell}`);
      continue;
    }
    if (event.kind !== 'seat.blocked') continue;
    seen.add(event.seat);
    if (suppressed.has(event.seat)) continue;
    const body = event.reason ?? `${event.seat}: can't work`;
    const start = episodes?.[event.seat]?.since;
    const identity = typeof start === 'number'
      ? String(start)
      : body.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    await deliver(event.seat, body, `blocked-episode-${event.seat}-${identity}`);
  }
  for (const seat of Object.keys(pending)) {
    if (seen.has(seat) || suppressed.has(seat)) continue;
    const held = pending[seat];
    if (held === undefined || held.sent) continue;
    if (episodes?.[seat]?.open !== true) continue;
    await deliver(seat, held.body, held.id);
  }
  // A prompt notice that did not go out is tried again on the next passes, a few times at most:
  // its report is said once per spell, so no later pass would carry it again.
  for (const seat of Object.keys(prompts)) {
    const held = prompts[seat];
    if (held === undefined || held.sent || suppressed.has(seat)) continue;
    if (held.tries >= PROMPT_NOTICE_TRIES) continue;
    await deliverPrompt(seat, held.body, held.id);
  }
}

/** The teams whose outbox relay batch is running in this process. */
const relayRunning = new Set<string>();

/** Runs the waiting outbox requests of this team's seats as those seats, with the ordinary send
 *  and reply commands and their ordinary admission; what each run said goes back to the seat. */
/** How often a hosted watch runs its seats' outbox requests, whatever its pass pace. */
const RELAY_EVERY_MS = 3_000;

async function relayConfinedOutboxes(
  dir: string,
  session: string,
  team: TeamFile,
  agents: readonly { name: string | null; pane: string }[] | null,
  now: () => Date,
): Promise<void> {
  await relayOutboxes(dir, session, team.seats.map((seat) => seat.name), {
    recordedPane: (seat) => readState(dir).sessions[session]?.seats[seat]?.pane,
    // The last pass's live panes; null until a pass has read them, and the relay then checks the
    // pane the state records alone.
    agents: () => (agents === null ? null : agents.map((agent) => ({ name: agent.name, pane: agent.pane }))),
    now,
    log: (line) => logLine(dir, 'watch', 'watch', line, now()),
    run: async (command, argv, cwd, caller) => {
      let out = '';
      let err = '';
      const io: Io = {
        stdout: (text) => { out += text; },
        stderr: (text) => { err += text; },
        cwd,
        env: process.env,
        stdinIsTTY: false,
        stdoutIsTTY: false,
        stderrIsTTY: false,
        caller,
      };
      let code: number;
      try {
        code = command === 'send'
          ? await runSend(argv, io, realHost)
          : await runReply(argv, io, realReplyHost);
      } catch (error) {
        code = 1;
        err += `team ${command}: ${(error as Error).message}\n`;
      }
      return { code, out, err };
    },
  });
}

/** Where a taken climb waits until it is sent or left in the runtime mailbox: one file per climb,
 *  so a daemon stopped before the next pass sends it after its restart. */
function heldClimbsDir(dir: string): string {
  return join(dir, 'climbs-held');
}

const HELD_CLIMB_ID = /^evt-prompt-[A-Za-z0-9_.-]+$/;

/** Takes a climb: written to its file first, then queued. A climb whose file cannot be written is
 *  not taken, and the engine writes its runtime record as before. */
export function holdClimb(dir: string, queue: { climb: StatusClimb; tries: number }[], climb: StatusClimb): void {
  if (HELD_CLIMB_ID.test(climb.id)) {
    try {
      mkdirSync(heldClimbsDir(dir), { recursive: true, mode: 0o700 });
      writeFileSync(join(heldClimbsDir(dir), `${climb.id}.json`), `${JSON.stringify(climb)}\n`, { mode: 0o600 });
    } catch {
      // Queued in memory only: still sent this run.
    }
  }
  if (!queue.some((held) => held.climb.id === climb.id)) queue.push({ climb, tries: 0 });
}

/** The climbs a stopped run had taken and not sent, back into the queue once each. */
export function loadHeldClimbs(dir: string, queue: { climb: StatusClimb; tries: number }[]): void {
  let names: string[];
  try {
    names = readdirSync(heldClimbsDir(dir));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || !HELD_CLIMB_ID.test(name.slice(0, -5))) continue;
    try {
      const climb = JSON.parse(readFileSync(join(heldClimbsDir(dir), name), 'utf8')) as StatusClimb;
      if (typeof climb?.id !== 'string' || climb.id !== name.slice(0, -5) || typeof climb.text !== 'string'
        || typeof climb.target?.seat !== 'string' || typeof climb.target.root !== 'string' || typeof climb.target.session !== 'string') continue;
      if (!queue.some((held) => held.climb.id === climb.id)) queue.push({ climb, tries: 0 });
    } catch {
      // An unreadable file is left for the next pass.
    }
  }
}

export function releaseHeldClimb(dir: string, id: string): void {
  try {
    unlinkSync(join(heldClimbsDir(dir), `${id}.json`));
  } catch {
    // Not held, or gone already.
  }
}

/** A held climb older than this was taken by an earlier run: the seat's prompt is read again by
 *  this run's engine, which raises its own climb if the prompt still stands. */
export const HELD_CLIMB_STALE_MS = 30 * 60_000;

/** The climbs worth sending from a queue: per seat and rung (`evt-prompt-<rung>-<seat>-<stamp>`)
 *  only the newest, and none older than `HELD_CLIMB_STALE_MS`. 2026-11-15: a climb an earlier
 *  daemon run had held was sent after a restart beside the new run's climb for the same prompt,
 *  and the lead got the same escalation twice. The dropped ones are handed to `drop`. */
export function supersededClimbs(
  queue: readonly { climb: StatusClimb; tries: number }[],
  at: Date,
  drop: (climb: StatusClimb, why: string) => void,
): { climb: StatusClimb; tries: number }[] {
  const keyOf = (climb: StatusClimb): string => {
    const match = /^evt-prompt-([a-z]+)-/.exec(climb.id);
    return `${match?.[1] ?? climb.id}\0${climb.seat}\0${climb.target.root}\0${climb.target.seat}`;
  };
  // The climb's instant: its `at`, else the stamp its id carries; null when neither reads, and
  // such a climb never outranks a dated one and is never dropped as stale.
  const instant = (climb: StatusClimb): number | null => {
    const parsed = Date.parse(climb.at ?? '');
    if (Number.isFinite(parsed)) return parsed;
    const stamp = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(climb.id);
    if (stamp === null) return null;
    const fromId = Date.parse(`${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}.${stamp[7]}Z`);
    return Number.isFinite(fromId) ? fromId : null;
  };
  // Only the prompt rungs the engine raises again while the prompt stands may expire; a lead's
  // unread climb (`evt-prompt-lead-`) is raised once per episode and is kept until it is sent.
  const expires = (climb: StatusClimb): boolean => /^evt-prompt-(climb|remind)-/.test(climb.id);
  const newest = new Map<string, number>();
  for (const held of queue) {
    const when = instant(held.climb);
    if (when === null) continue;
    const key = keyOf(held.climb);
    newest.set(key, Math.max(newest.get(key) ?? -Infinity, when));
  }
  const kept: { climb: StatusClimb; tries: number }[] = [];
  const seen = new Set<string>();
  for (const held of queue) {
    const key = keyOf(held.climb);
    const when = instant(held.climb);
    if (when !== null && expires(held.climb) && at.getTime() - when > HELD_CLIMB_STALE_MS) {
      drop(held.climb, 'it is older than 30 minutes; this run reads the seat again');
      continue;
    }
    const best = newest.get(key);
    // An undated climb stands only when no dated one exists for the same seat and prompt.
    if ((when === null && best !== undefined) || (when !== null && best !== undefined && when < best) || seen.has(key)) {
      drop(held.climb, 'a newer climb for the same seat and prompt stands');
      continue;
    }
    seen.add(key);
    kept.push(held);
  }
  return kept;
}

/** Whether a hosted watch delivers this climb itself, as the daemon's notice: to this team's own
 *  lead, or across teams to the entity's orchestrator, which is the lead of its own team (the one
 *  seat a blocked-episode notice may reach in that team's checkout). A climb with no seat to
 *  reach keeps the runtime mailbox record the engine writes. */
export function hostedClimbTakes(climb: StatusClimb, root: string, session: string, team: TeamFile): boolean {
  if (climb.target.seat === '') return false;
  // In this checkout only this team's own lead, in this session, is reachable this way.
  if (sameFolder(climb.target.root, root)) {
    return climb.target.session === session && team.orchestrator !== '' && climb.target.seat === team.orchestrator;
  }
  // Another checkout: the entity's orchestrator there, whose own team's lead it is; the daemon's
  // admission checks that, and a refusal leaves the record where it went before.
  return true;
}

/** Sends the queued climbs as the daemon's own notice to the team's lead, each under its own id.
 *  One that does not go out is tried on the next passes, five times at most, then said in the
 *  log and dropped. */
async function sendHostedClimbs(
  home: string,
  root: string,
  team: TeamFile,
  session: string,
  queue: { climb: StatusClimb; tries: number }[],
  dir: string,
  now: () => Date,
): Promise<void> {
  const kept: { climb: StatusClimb; tries: number }[] = [];
  for (const held of supersededClimbs(queue.splice(0), now(), (climb, why) => {
    releaseHeldClimb(dir, climb.id);
    logLine(dir, 'watch', 'watch', `${climb.seat}: the prompt climb ${climb.id} was not sent: ${why}`, now());
  })) {
    // The climb's own target: this team's lead, or the entity's orchestrator in its own checkout.
    const target = held.climb.target;
    // A fallback record a stopped run already left settles the climb: no second copy anywhere.
    if (existsSync(messageFile(target.root, target.seat, held.climb.id))) {
      releaseHeldClimb(dir, held.climb.id);
      continue;
    }
    let ok = false;
    let text = '';
    try {
      const sent = await sendDaemonDirect(
        {
          reminder: 'seat-blocked',
          due: held.climb.at ?? now().toISOString(),
          recipients: [{ root: target.root, session: target.session, seat: target.seat }],
          notice: 'seat-blocked',
        },
        { root: target.root, seat: target.seat, body: held.climb.text, id: held.climb.id },
        { ...realHost, home, now: () => now() },
      );
      // A record staged under the notice's id is in the seat's inbox already: a failed
      // transport after it is not a reason to leave a second copy anywhere.
      ok = sent.ok || sent.staged;
      text = sent.text;
    } catch (error) {
      text = (error as Error).message;
    }
    if (ok) {
      releaseHeldClimb(dir, held.climb.id);
      continue;
    }
    const tries = held.tries + 1;
    if (tries < PROMPT_NOTICE_TRIES) {
      kept.push({ climb: held.climb, tries });
      continue;
    }
    // The notice could not be sent: the record still goes where it went before, and the log says so.
    const outcome = writeRuntimeMailboxRecord({
      root: target.root,
      home,
      to: target.seat,
      id: held.climb.id,
      text: held.climb.text,
      session: target.session,
      ...(held.climb.at === undefined ? {} : { at: held.climb.at }),
    });
    logLine(dir, 'watch', 'watch', `${held.climb.seat}: the prompt climb to ${target.seat} was not sent — ${text}${outcome.ok ? '; it was left in the runtime mailbox' : '; it stays held and is tried again'}`, now());
    // Only a climb stored somewhere is let go. One that reached neither store stays held: its
    // file is written again (a write that failed at the take may work now) and it stays queued,
    // so a climb never rests in memory alone once its tries are spent.
    if (outcome.ok) releaseHeldClimb(dir, held.climb.id);
    else {
      holdClimb(dir, kept, held.climb);
    }
  }
  queue.push(...kept);
}

/** One prompt notice: its id names the seat, the cause's digest and the pass that said the spell.
 *  `tries` caps the retries of a notice whose send did not succeed. A seat keeps its latest one. */
type PendingPromptNotice = { id: string; body: string; sent: boolean; tries: number };

const PROMPT_NOTICE_TRIES = 5;

/** The words a prompt notice names its cause with: the prompt's kind, or the unrecognised screen. */
function promptCause(event: EventAppendInput): string {
  if (event.kind === 'seat.at-prompt') return `at a ${event.prompt ?? 'prompt'} prompt`;
  return 'blocked on a screen the watch does not recognise';
}

/** The last rows a blocked seat's pane shows, for the lead's notice: at most eight non-blank
 *  rows, each trimmed and cut at 160 characters, the dialog's frame marks left out. It is a
 *  report of what the screen says, never an answer to it. Null when the pass read no screen. */
export function screenExcerpt(live: Live | null, seat: string): string | null {
  if (live === null) return null;
  const agent = live.agents.find((candidate) => candidate.name === seat);
  if (agent === undefined) return null;
  const raw = live.screens[agent.pane];
  if (raw === undefined || raw === '') return null;
  const rows = raw
    .split('\n')
    .map((line) => line.replace(/^[\s┃│┆]+/, '').replace(/[\s█]+$/, ''))
    .filter((line) => line !== '');
  if (rows.length === 0) return null;
  return rows.slice(-8).map((line) => `  ${line.length > 160 ? `${line.slice(0, 159)}…` : line}`).join('\n');
}

/** Publishes one event per observation, even when a check emits an operator line and an owner
 *  line for it: both lines share a record id, and an owner-addressed copy marks the event
 *  addressed to `owner` (§4.5), so the watch's owner reports reach the owner's list as events,
 *  one list with the rest. A provider error and the can't-work report of that seat are one
 *  episode: one `seat.blocked` event, with the owner added to the lead and the operator. */
export async function publishWatchReportsToBus(
  root: string,
  session: string,
  reports: readonly { key: string; text: string; to: string }[],
  ts: string,
  publish: (root: string, event: EventAppendInput) => Promise<BusPublishOutcome>,
): Promise<void> {
  for (const event of foldedWatchEvents(reports, session, ts)) await publish(root, event).catch(() => {});
}

/** The climb: the one place the watch leaves an escalation in another team's mailbox. A team's
 *  lead at a prompt (the first rung skipped) and a prompt the lead has not cleared within
 *  `prompt_escalation_seconds` are written as signed runtime messages to the entity's own lead,
 *  in the entity team's root, where that team's watch rings them. Nothing is typed into a pane:
 *  a climb is a mailbox record and an event, never a keystroke. A registry that names no entity
 *  lead writes nothing here; the event's own routing still carries the owner, so a climb is
 *  never silent. A seat at a prompt is not told about its own prompt: it cannot clear it by
 *  reading a message, and the owner's copy carries it. */
export function escalatePromptReports(
  home: string,
  root: string,
  team: TeamFile,
  session: string,
  reports: readonly { key: string; text: string; to: string }[],
  ts: string,
): { written: string[]; failed: string[] } {
  const target = readEntityOrchestrator(home, teamIdOf(root));
  if (target === null) return { written: [], failed: [] };
  const leads = new Set<string>();
  if (team.orchestrator !== '') leads.add(team.orchestrator);
  const stamp = ts.replace(/[^0-9A-Za-z]/g, '');
  const written: string[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();
  for (const report of reports) {
    const event = watchReportEvent(report, session, ts);
    if (event === null || event.seat === undefined) continue;
    const climbed = event.kind === 'seat.prompt-escalated';
    if (!climbed && !(event.kind === 'seat.at-prompt' && leads.has(event.seat))) continue;
    // One climb per seat per pass: the operator and owner copies of one report share a seat.
    if (event.seat === target.seat || seen.has(event.seat)) continue;
    seen.add(event.seat);
    const why = climbed
      ? report.text
      : `${report.text} — its lead is the seat at the prompt, so the climb starts above it`;
    const outcome = writeRuntimeMailboxRecord({
      root: target.root,
      home,
      to: target.seat,
      id: `evt-prompt-${climbed ? 'climb' : 'lead'}-${event.seat}-${stamp}`,
      text: `${team.project}: ${why}`,
      session: target.session,
      at: ts,
    });
    if (outcome.ok) written.push(outcome.path);
    else failed.push(`${target.seat} was not told of ${event.seat}'s prompt: ${outcome.error}`);
  }
  return { written, failed };
}
