import { machineAccountsOf } from '../information/machine-accounts.ts';
import { randomUUID } from 'node:crypto';
import { readArgs } from '../args.ts';
import { budgetsInForceOf } from '../approve/approval.ts';
import { callerOf, describeCaller, detachedRefusal, fileOwnerRefusal, isOwner } from '../caller.ts';
import { loadReadings, saveSpendReadings, updateReadings, type Seen, type SpendReading } from '../budgets/readings.ts';
import { runChecksOf, type CheckOutcome } from '../budgets/run.ts';
import { currentTeam, rememberCurrent } from '../file/current.ts';
import { isParseError } from '../file/load.ts';
import { saveMachineReadings } from '../information/machine-readings.ts';
import type { TeamFile } from '../file/types.ts';
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentStatus, PANE_WINDOW, paneForeground, paneProcesses, paneRead, paneRun, pressEnter, reportDisplayAgent, sendKey as herdrSendKey, typeText, workspaceClose, workspaceCreate, workspaceRename, type PaneProcesses } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { logLine } from '../log.ts';
import { hasJsonFlag, writeJsonError } from '../output/index.ts';
import { emptySession, readState, updateState } from '../state.ts';
import { waitOrStop } from '../wait.ts';
import type { Live } from '../status/compare.ts';
import { readMachine, readingsText } from '../watch/machine.ts';
import type { Machine } from '../watch/machine.ts';
import { beatWatch, ownWatchPane, placedWatch, watchLabel, watchRunning } from '../watch/pane.ts';
import { watchCommand, watchWouldRead } from './up.ts';
import { realHost, redeliverChannelOnSocket, sendDirect } from './send.ts';
import { notify } from '../watch/notify.ts';
import { dropMessage, readTriggerLine, triggerLine } from '../send/native.ts';
import { listUnacked, listUnackedMessages } from './messages.ts';
import { wakeTrigger } from '../send/wake.ts';
import { labelSweep } from '../watch/label-tick.ts';
import { newMemory, NUDGE_TEXT, ownUnsent, pass, ringText, type MailboxWaiting, type Memory } from '../watch/pass.ts';
import { listUnread } from '../mcp/inbox.ts';
import { modelRuleOfPass } from '../watch/rule-pass.ts';
import { promoteInboxDrops, retryHeldDrops } from '../watch/retry.ts';
import { expirePendingNative } from '../watch/native.ts';
import { confirmTakenDrops } from '../watch/taken.ts';
import { reportUnreadDrops, wakeUnreadDrops } from '../watch/unread.ts';
import { readScreen } from '../watch/screen.ts';
import { dispatchIdleWork, workPushResultOf, type IdleDispatchResult, type WorkPush } from '../watch/dispatch.ts';
import type { BrokerWorkSnapshot, BrokerWorkSource } from '../idle_work.ts';
import { nativeHeldSeats } from '../watch/idle-work.ts';
import { prefetchPresence } from '../watch/presence.ts';
import { actingWatchHandover, readWatchHandover } from '../watch/handover.ts';
import type { HostedLoop } from '../watch/hosted.ts';
import { watchInForceWithPace, watchPaceNotes, watchPaceOf } from '../watch/rhythm.ts';
import { judgeTemporary, judgeWorktree } from '../watch/close.ts';
import { readEnd, type EndView } from '../watch/end.ts';
import { reportedLiveAgent } from '../launch/agent.ts';
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
import { realSources, standingSource } from './status.ts';
import { queuedSwaps, swapLine } from '../swap/queue.ts';
import { queueRuleBreaches } from '../swap/auto.ts';
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
  reportDisplayAgent?(session: string, pane: string, text: string): boolean;
  /** The home whose store holds the override file. Absent in a test that does not set one. */
  home?: string;
  /** The live world a queued swap's run reads: the restart path's own sources. Absent, the
   *  watch queues the rule's breaches but carries no swap out (a test without a faked launch). */
  swapSources?: RestartSources;
  /**
   * The watch's own workspace: `up`'s two steps, run by a hand start. Absent, no workspace can
   * be made here: the watch runs in this process, as one started by hand always did.
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
   * Whether the caller can prove that one seat's native presence channel is healthy right now,
   * keyed by declared seat name. Only the machine daemon that owns the route can answer, from
   * its fresh per-seat continuity; a hand-started watch does not know, and the dispatcher then
   * holds a native projection instead of believing it. Never settable from a command line.
   */
  presenceChannelHealthy?: (seat: string) => boolean;
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

/** The streams a direct dispatch writes through: the watch process's own, with an optional copy
 *  of what it said on stderr, so a refusal that names no route still reaches the dispatcher. */
function watchIo(onStderr?: (text: string) => void): Io {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => {
      onStderr?.(text);
      void process.stderr.write(text);
    },
    cwd: process.cwd(),
    env: process.env,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
  };
}

export const realWatchSources: WatchSources = {
  // The status live read, handed no state: the watch compares each live pane's process with its
  // seat's record itself, through `processes` below — only `status` needs the panes the state
  // recorded for seats no agent is listed under, so none is read here.
  live: (session, team) => realSources.live(session, team, emptySession()),
  machine: readMachine,
  standing: standingSource(homedir()),
  readChecks: (standing, team, now) => runChecksOf(standing, team, now),
  screen: (pane, session) => paneRead(pane, PANE_WINDOW, session),
  status: agentStatus,
  foreground: (pane, session) => paneForeground(pane, session),
  processes: (pane, session) => paneProcesses(pane, session),
  typeText,
  pressEnter,
  sendKey: (pane, key, session) => herdrSendKey(pane, key, session),
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
  renameWorkspace: (session, workspace, label) => workspaceRename(workspace, label, session === 'default' ? undefined : session),
  reportDisplayAgent: (session, pane, text) => reportDisplayAgent(pane, text, session === 'default' ? undefined : session),
  createWorkspace: (session, cwd, label) => workspaceCreate(cwd, label, session === 'default' ? undefined : session),
  paneRun: (session, pane, command) => paneRun(pane, command, session === 'default' ? undefined : session),
  closeWorkspace: (session, workspace) => workspaceClose(workspace, session === 'default' ? undefined : session),
  watchCommand,
  // The bus identity of the owner's delivery path (§4.5): the watch reads what the policy routes
  // to `owner` and what the raising side addresses to `owner`. It is never a seat name.
  busSubscribe: (root, cursor) => subscribeBusOnce(root, { seat: 'owner', cursor }, { deadlineMs: 500 }),
  busPublish: (root, event) => publishToBus(root, event, { deadlineMs: 500 }),
  statusSource: herdrStatusSource(),
  pushWork: async (request) => {
    // The send runs in this process, through the same admission, delivery order and route rules
    // an ordinary send runs; only routes that reach a live receiver without a keystroke are
    // walked. What the dispatcher reads back is that route's own ending, never an exit code.
    const said: string[] = [];
    const run = await sendDirect(watchIo((text) => said.push(text)), realHost, request);
    return workPushResultOf(run.result, said.join(''));
  },
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
 *  spawned. */
function watchdogGrant(
  cwd: string, session: string | undefined, caller: ReturnType<typeof callerOf>,
): { file: string } | { refuse: string } | { wait: true } | undefined {
  const name = session ?? 'default';
  const recorded = recordedWatchdog(cwd, name);
  if (!recorded) return undefined;
  if (recorded.pane && caller.kind === 'pane' && caller.pane === recorded.pane) return { file: recorded.file };
  if (isOwner(caller)) return undefined;
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
  return {
    refuse: `only the watch this session records may read the file up recorded; this call is ${describeCaller(caller)}`,
  };
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
  cwd: string, session: string | undefined, caller: ReturnType<typeof callerOf>,
): Promise<{ file: string } | { refuse: string } | undefined> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const grant = watchdogGrant(cwd, session, caller);
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
  const detached = hosted === undefined
    ? detachedRefusal(callerOf(io), { who: 'the owner or a placed seat', where: 'a terminal outside herdr or its own pane' })
    : undefined;
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
  // A hosted watch takes no grant and no `--file`: it reads the team of the route it was built
  // for, and the watchdog file is the hand-over a pane makes, which a daemon pass never makes.
  const grant = args.values.file || hosted !== undefined
    ? undefined
    : await admittedWatchdog(io.cwd, args.values.session, caller);
  // A run with no terminal is refused: the watch lives in a pane of its own now, so no process
  // outside a terminal is ever the watch and none has to be admitted to the file.
  if (detached !== undefined) {
    refuse('watch.caller', detached);
    // exit: watch.caller
    return 1;
  }
  if (grant && 'refuse' in grant) {
    refuse('watch.watchdog', grant.refuse);
    // exit: watch.watchdog
    return 1;
  }
  const aimed = args.values.file ?? (grant && 'file' in grant ? grant.file : undefined);
  const first = currentTeam(io.cwd, aimed, sources.now(), sources.home, false);
  if (!first.ok) {
    if (json) {
      const id = first.errors[0]?.message.includes('not inside a git repository')
        ? 'watch.not-a-repo'
        : first.errors.some(isParseError)
          ? 'watch.file-invalid'
          : 'watch.file';
      const message = first.errors.map((p) => `${p.line ? `team.yaml line ${p.line}: ` : ''}${p.message}`).join('; ');
      writeJsonError(io, id, message, null);
    } else {
      for (const problem of first.errors) io.stderr(`team watch: ${problem.line ? `team.yaml line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    // exit: watch.not-a-repo
    // exit: watch.file
    // exit: watch.file-invalid
    return 2;
  }
  const session = args.values.session ?? first.team.session;
  const { dir } = first;

  const placed = callerOf(io, session);

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
    refuse('watch.already', `a watch already runs for the session "${session}" (${where})`);
    // exit: watch.already
    return 1;
  }
  if (first.path !== undefined) rememberCurrent(first.dir, first.path, sources.now());

  // Started alone, from the owner's terminal outside herdr: the watch runs in its own workspace
  // of the team's session — `up`'s own two steps — so the one watch `team status` and the checks
  // look for is the one running, and not a process this terminal owns. The file the pane would
  // not resolve for itself is recorded for that pane before its command runs, and the pane
  // itself once the command has started: a run whose typing failed leaves no watch in the state.
  // An owner who asked to watch without nudges or notices keeps this terminal — those flags are
  // the owner's, and the pane's own `team watch` cannot carry them — and so does a build with no
  // workspace to make (a test's own sources), which runs the watch here as one always did.
  // The hand-over is the file's own session only: a lone run aimed at another session (anyone
  // may watch one) would otherwise make the workspace in that session and write this team's
  // state before the foreign-session reading is even said. It reads and reports here instead.
  if (hosted === undefined && isOwner(placed) && session === first.team.session && !args.flags.has('no-nudge') && !args.flags.has('no-notify')
    && sources.createWorkspace && sources.paneRun) {
    const label = watchLabel(first.team.project);
    const made = sources.createWorkspace(session, first.root, label);
    if (made) {
      const file = first.path !== undefined && !watchWouldRead(first.root, first.path, sources.home) ? first.path : undefined;
      if (file !== undefined) {
        updateState(dir, (state) => {
          const current = (state.sessions[session] ??= emptySession());
          current.watchdog = { file, pane: made.pane };
        });
      }
      if (sources.paneRun(session, made.pane, (sources.watchCommand ?? watchCommand)(session))) {
        updateState(dir, (state) => {
          const current = (state.sessions[session] ??= emptySession());
          current.watch = { pane: made.pane, workspace: made.workspace, heartbeat: sources.now().toISOString() };
        });
        io.stdout(`team watch: the watch runs in its own workspace (${label}, pane ${made.pane})\n`);
        // exit: watch.started
        return 0;
      }
      // The workspace was made and the typing refused: nothing runs in it. Close it and unset
      // the file's record, so the state says what is true — no workspace and no watch.
      sources.closeWorkspace?.(session, made.workspace);
      if (file !== undefined) {
        updateState(dir, (state) => {
          const current = state.sessions[session];
          if (current) delete current.watchdog;
        });
      }
    }
    refuse('watch.workspace', 'the watch did not start in its workspace');
    // exit: watch.workspace
    return 1;
  }

  // The log line is written for every report. `--no-notify` never removes it, and it never
  // removes a desktop notice addressed to the owner. It does silence every other notice.
  const tell = (text: string, notify: boolean) => {
    io.stdout(`${sources.now().toISOString()} ${text}\n`);
    logLine(dir, 'watch', 'watch', text, sources.now());
    if (notify) sources.notify(text);
  };
  const say = (text: string, desktop: boolean) => tell(text, desktop && !args.flags.has('no-notify'));

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
  let statusEngine: SeatStatusEngine | undefined;
  /** The current pass's native hold, replaced before the status engine, the pass and every
   *  automatic typed path read it. Empty until the first pass has read the store. */
  let nativeHeldNow: ReadonlySet<string> = new Set();
  let statusWaiters: { stop(): void; done: Promise<void> } | undefined;
  let statusWaitersKey = '';
  try {
    for (;;) {
      // A hosted pass starts only while the host still wants one.
      if (hosted?.signal.aborted) break;
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
      const problem = current.ok ? current.notice : `team.yaml can't be read (${current.errors[0]?.message ?? 'unknown'}); watching with the team as it was`;
      if (problem !== notice) {
        notice = problem;
        if (problem) tell(problem, true);
      }

      // Only the watch of the file's own session saves readings. A watch on another session —
      // anyone may run one, from any terminal — reads and reports, but the figures it sees are
      // not the project's cache that `up` and `add` count (§ 4.4): it says so once and writes
      // none, budget or spend.
      const foreign = session !== team.session;
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
      const live = sources.live(session, team);
      lastLive = live;
      if (!live) {
        if (!silent) tell('herdr doesn\'t answer; the watch keeps trying', true);
        silent = true;
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
        const state = whole.sessions[session] ?? emptySession();
        const now = sources.now().getTime();
        // Whether this pass may dispatch at all: a foreign session, a watch told to type
        // nothing, an unreadable pace, or a hosted loop with no direct route. The dispatcher
        // below takes its reading only when something could act on it, and so does the broker.
        const dispatchHeld = foreign || args.flags.has('no-nudge') || !paceVerified
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
          });
          const panesBySeat: Record<string, string> = {};
          for (const seat of team.seats) {
            if (seat.human === true || seat.stopped === true) continue;
            const agent = live.agents.find((candidate) => candidate.name === seat.name);
            if (!agent) continue;
            panesBySeat[seat.name] = agent.pane;
            const hasSidebarLabel = Boolean(memory.seatLabels[seat.name]?.title);
            const readScreenNow = shouldReadScreenForStatus(seat, agent.status, hasSidebarLabel);
            const liveScreen = live.screens[agent.pane];
            const rawScreen = readScreenNow
              ? (liveScreen !== undefined && liveScreen !== '' ? liveScreen : (sources.screen(agent.pane, session) ?? liveScreen))
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
          await statusEngine.tick(now);
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
          checksAt = now;
          outcomes = sources.readChecks(standing, team, now);
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
            told.add(key);
            say(outcome.state === 'unreadable'
              ? `${outcome.account}: its check is unreadable`
              : `the check for ${outcome.account} is unapproved; that account reads unknown`, false);
          }
        }
        // Herdr's process list per pane, read with the screen: a figure is only read off a pane
        // where herdr reports the seat's CLI. A pane it can't read is null, and a null is not a
        // CLI: no figure.
        const foreground: Record<string, string[] | null> = {};
        // The pane's process identity, read with the same screen: a pane that no longer holds
        // the process team launched for its seat is not the seat, and the restored check says so.
        const processes: Record<string, PaneProcesses | null> = {};
        for (const agent of live.agents) {
          foreground[agent.pane] = sources.foreground(agent.pane, session);
          processes[agent.pane] = sources.processes?.(agent.pane, session) ?? null;
        }
        // The machine's own readings, written to the log at the slow rate: the same figures the
        // pass below reads, whether or not anything is wrong, so the night the incident was is
        // on record in the tool's own files. `unread` where a figure couldn't be read; the gate
        // that acts on these figures is elsewhere and unchanged.
        const machine = sources.machine(root);
        if (readingsAt === null || now - readingsAt >= READINGS_EVERY * 1000) {
          readingsAt = now;
          logLine(dir, 'watch', 'watch', `readings: ${readingsText(machine)}`, sources.now());
        }
        const machineAccounts = sources.home === undefined ? [] : machineAccountsOf(sources.home);
        // The entity's model rule, read once for this pass: the breach list `team check` prints,
        // narrowed to this team by name. The pass never reads the entity's files itself.
        const modelRule = modelRuleOfPass(team, root, sources.home);
        const run = (stored: readonly Seen[]) => pass({
          machineAccounts,
          signing: sources.home === undefined ? undefined : new Map(team.seats.map((seat) => {
            const agent = findAgent(sources.home!, { team: teamIdOf(root), seat: seat.name });
            return [seat.name, agent?.signing ?? null] as const;
          })),
          // The same records, read for continuity: a pane restored from outside the launch line
          // is the seat while the record's session is the one the pane runs.
          continuityIds: sources.home === undefined ? undefined : continuityIdsOf({
            home: sources.home,
            root,
            herdrSession: session,
            seats: team.seats,
            states: state.seats,
          }),
          team, state, live, machine, now, memory,
          // The team's pause is the project's, not this session's: every watch of the project
          // stops nudging, and a foreign watch's notice is dropped where every other work drop
          // of that watch is.
          pause: whole.pause ?? null,
          approval: standing.kind === 'verified' ? [] : null, approvalReason, watch: inForce,
          modelRule,
          liveness: {
            machine: machineLiveness(sources.home),
            entity: entityLiveness(sources.home, team.entity),
            project: projectLiveness(sources.home, root),
          },
          // The team's words are the watch as written, not as `tempo` scaled it: the tighten-only
          // check reads declarations, and the tempo is applied to the resolved idle window after.
          livenessTeam: watchWords(standing.kind === 'verified' ? team.watch : defaultWatch()),
          tempo: standing.kind === 'verified' ? team.tempo : 'normal',
          outcomes, budgets: budget,
          quotaFor: (cli) => quotaWith(cli, overrides.profiles),
          readScreen: (cli, pane) => classifyWith(cli, pane, overrides.profiles),
          nativeHeld: nativeHeldNow,
          readings: stored, foreground, processes,
          // A record is bound to the file's session. A watch of another session neither rings
          // nor raises the owner line; the file's own watch still does both.
          mailbox: !foreign && sources.home ? mailboxWaiting(root, dir, team, live, sources.home, new Date(now)) : [],
        });
        // The pass folds its figures where the state is held: two watches of the project fold one
        // after the other, not over each other. A watch on a foreign session still folds, for its
        // reports, and saves nothing.
        const result = foreign
          ? run(loadReadings(dir))
          : updateReadings(dir, now, (stored) => {
            const folded = run(stored);
            return { readings: folded.readings, value: folded };
          });
        if (!foreign && sources.home) saveMachineReadings(sources.home, result.machineReadings, now);
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
        for (const item of idleDispatch.pushed) {
          if (item.ok) continue;
          tell(`${item.seat}: its work was not dispatched directly (${item.refused}); nothing was typed for it this episode`, false);
        }
        for (const line of idleDispatch.fallback?.failed ?? []) tell(line, true);
        for (const line of idleDispatch.fallback?.missing ?? []) say(line, false);
        // The seats whose idle episode the dispatcher owns. The ring guard below reads it, so a
        // mail notification is never a second typed path into an episode already delivered (or
        // reported undelivered) by the dispatcher.
        const suppressed = new Set(idleDispatch.suppressed ?? []);
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
        // What the pass saw goes on the bus whatever started this watch: a report is the watch's
        // contribution, not a privileged delivery, and a bus that is not running answers
        // `unavailable` without making the pass wait.
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
          if (label.title && sources.renameWorkspace) {
            if (sources.renameWorkspace(session, label.workspace, label.title)) slot.title = label.title;
            else say(`${label.name}: its title was not reported`, false);
          }
          if (label.displayAgent && sources.reportDisplayAgent) {
            if (sources.reportDisplayAgent(session, label.pane, label.displayAgent)) slot.line = label.displayAgent;
            else say(`${label.name}: its display was not reported`, false);
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
            if (args.flags.has('no-nudge')) {
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
        const promotedReads = !foreign
          ? promoteInboxDrops({
            dir, session, root, home: sources.home, team, live, ownPane, sources, now: sources.now(), say,
          })
          : new Set<string>();
        const ring = result.ring;
        // The record this pass's ring typed for: the unread wake below types the same line, so
        // the same pass does not put it in front of the seat twice.
        let rungId: string | null = null;
        if (ring && delivered.size === 0 && !suppressed.has(ring.to) && hosted === undefined && paceVerified && sources.home !== undefined) {
          if (args.flags.has('no-nudge')) say(`ring not typed (--no-nudge): ${ring.text}`, false);
          // A read that landed since the pass read the mailbox is the seat's own word: the signed
          // receipt is read again here, and an already-read message is not reminded. The snapshot
          // held it only because the read came after that read.
          else if (promotedReads.has(`${ring.to}\n${ring.id}`)
            || !listUnacked(root, team.session, sources.home).some((one) => one.id === ring.id && one.to === ring.to)) {
            say(`ring not typed: message ${ring.id} is already read`, false);
          } else {
            await deliver({
              pane: ring.pane,
              text: ring.text,
              cli: ring.cli,
              ring: { to: ring.to },
            }, team, session, sources, memory, say, tell, told);
            rungId = ring.id;
          }
        }
        // An inbox send the seat's client has read since the last pass is promoted here: the
        // receipt is that client's own word, and the history records `delivered (read)` once. It
        // types nothing and needs no pane, so a watch without nudges promotes it just the same.
        // A send held while a pane was busy leaves its drop and a record beside it: the pass
        // delivers one per seat once the box is free, bounded, and says the drop's path when it
        // gives up. `--no-nudge` is the watch that types nothing, and this types too.
        if (!foreign && !args.flags.has('no-nudge') && hosted === undefined && paceVerified) {
          await retryHeldDrops({
            dir, session, root, home: sources.home, team, live, ownPane, sources, now: sources.now(), say,
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
            { dir, session, root, home: sources.home, team, live, ownPane, sources, now: sources.now(), say, nativeHeld: nativeHeldNow },
            { noNudge: args.flags.has('no-nudge') },
          );
          confirmTakenDrops({
            dir, session, root, home: sources.home, team, live, ownPane, sources, now: sources.now(), say,
          });
          // A delivery is a deposit until the seat's signed receipt follows: a message still
          // unread `watch.unread_after` after it landed gets one typed wake, and one still unread
          // at twice that window is reported to its sender and the team's lead. The report is a
          // mailbox record, so a watch without nudges keeps that word; the wake is typing, and
          // `--no-nudge` leaves it out.
          await wakeUnreadDrops(
            { dir, session, root, home: sources.home, team, live, ownPane, sources, now: sources.now(), say, nativeHeld: nativeHeldNow },
            {
              unreadAfter: inForce.unreadAfter,
              ...(rungId === null ? {} : { skip: new Set([rungId]) }),
              ...(args.flags.has('no-nudge') || hosted !== undefined || !paceVerified ? { noNudge: true } : {}),
            },
          );
          reportUnreadDrops(
            { dir, session, root, home: sources.home, team, live, ownPane, sources, now: sources.now(), say },
            { unreadAfter: inForce.unreadAfter },
          );
        }
        if (result.mailboxNote) tell(result.mailboxNote, true);
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
          && !args.flags.has('no-nudge')
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
              team,
              session,
              io,
              json: false,
              notes: [],
              sources: sources.swapSources,
              by: 'the watch',
              owner: false,
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
        beatWatch(dir, session, sources.pid, sources.now().toISOString(), place === 'end' ? 'keep' : place);
      }
      // The label sweep, inside the wait: a running seat's own status line reaches line 2 in
      // about five seconds, not a whole interval. It repeats the pass's own rule on the panes
      // the last live read named — the same memory, so the two cannot disagree — and the next
      // pass re-reads everything and stays the authority.
      // A hosted watch has no sidebar and no pane line: the label sweep would only write
      // refusals to the daemon's log, so its wait carries no sweep.
      if (hosted !== undefined) {
        if (!(await sources.wait(inForce.interval))) break;
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
          report: (pane, text) => sources.reportDisplayAgent?.(session, pane, text) ?? false,
        });
        for (const seat of failed) say(`${seat.name}: its display was not reported`, false);
      };
      if (!(await sources.wait(inForce.interval, sweep))) break;
    }
  } finally {
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
function mailboxWaiting(root: string, dir: string, team: TeamFile, live: Live, home: string, now: Date): MailboxWaiting[] {
  // The ring's line names the seat's own drop read, so a record is ringable only while that read
  // would serve it. `listUnread` is the reader's own list — a message in the seat's drop folder
  // with no verifying read receipt — so the ring and `team drops --read` can never disagree. A
  // record in the older mailbox store (`.agents/messages/<seat>`) waits for `team messages`, a
  // reader the ring never names; ringing it typed a command that served nothing and re-fired
  // every pass. Such a record still raises the owner's waiting note when its box is not free.
  const servedByDrops = new Map<string, Set<string>>();
  const waitingIds = (seat: string): Set<string> => {
    let ids = servedByDrops.get(seat);
    if (ids === undefined) {
      const dropDir = join(dir, 'send-drops', team.session, seat);
      ids = new Set(listUnread(dropDir, { to: seat, root, session: team.session }, home).map((one) => one.id));
      servedByDrops.set(seat, ids);
    }
    return ids;
  };
  // The owner's inbox is delivered by the Runtime, not a seat's message: a record there never
  // counts as mail waiting in a pane.
  return listUnackedMessages(root, team.session, home)
    .filter((record) => record.to !== 'owner')
    .map((record) => {
      const named = live.agents.filter((agent) => agent.name === record.to);
      const agent = named.length === 1 ? named[0] : undefined;
      const seat = team.seats.find((item) => item.name === record.to);
      // The oldest waiting record's own line: its header, then the fixed read hint. A sender this
      // home cannot name falls back to the shipped nameless ring rather than ringing nothing.
      const sender = wakeTrigger(record, home, { root, session: team.session, team }, now);
      const text = (sender === null ? null : readTriggerLine(record.to, team.session, sender))
        ?? ringText(record.to, team.session);
      return {
        id: record.id,
        to: record.to,
        at: Date.parse(record.at),
        pane: agent?.pane ?? null,
        status: agent?.status ?? null,
        cli: seat?.cli ?? '',
        screen: agent ? live.screens[agent.pane] : undefined,
        text,
        served: waitingIds(record.to).has(record.id),
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
  const seat = rawSeat.endsWith(':owner') ? rawSeat.slice(0, -':owner'.length) : rawSeat;
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
  if (prefix === 'blocked' || prefix === 'question') {
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

/** Publishes one event per observation, even when a check emits an operator line and an owner
 *  line for it: both lines share a record id, and an owner-addressed copy marks the event
 *  addressed to `owner` (§4.5), so the watch's owner reports reach the owner's list as events,
 *  one list with the rest. */
export async function publishWatchReportsToBus(
  root: string,
  session: string,
  reports: readonly { key: string; text: string; to: string }[],
  ts: string,
  publish: (root: string, event: EventAppendInput) => Promise<BusPublishOutcome>,
): Promise<void> {
  const events = new Map<string, EventAppendInput>();
  for (const report of reports) {
    const event = watchReportEvent(report, session, ts);
    if (event === null) continue;
    const existing = events.get(event.record_id);
    if (existing !== undefined) {
      if (report.to === 'owner') existing.to = 'owner';
      continue;
    }
    if (report.to === 'owner') event.to = 'owner';
    events.set(event.record_id, event);
  }
  for (const event of events.values()) await publish(root, event).catch(() => {});
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
