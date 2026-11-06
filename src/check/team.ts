// Bare `team check`: one answer to "is anything wrong with this team that someone should act on",
// for the callers who may see it — the owner, a seat of the team, and a pane the team's approved
// file names (design note §3, §4). It needs no git, it reads, and it changes nothing. The owner's
// `--repair` is the owner's one act: the state's leftovers (a record for a seat the file no longer
// declares, a session with no seat of the team in it), the dev-mode mark an agent's registration
// left, and the two sidebar lines a drift moved off the file's text — and nothing else.
// `--close-orphans` is the lead's or the owner's: a live agent CLI no pane holds, re-proven just
// before it is signalled, after one question at a terminal; it is the second act and never the same
// run as the first. The file is
// resolved with `remember` false for every caller, nothing of the watch's pass, report, readings or
// nudge path is called, and the one screen reading (§3.3a) is read-only.
//
// The caller decides, not the flags. The walk classifies the caller before any target is opened,
// and a caller that does not pass as one of the three gets one fixed sentence and nothing else,
// whatever failed underneath — a loader error, a refused standing, herdr's silence, an aimed flag
// and every caller detail among them (the two-phase rule, §4).
import { existsSync, readdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, relative, resolve } from 'node:path';
import { notInForce, sessionDefaultMoveNotes } from '../approve/approval.ts';
import { inspectRecordedCodexEndpoint, readRecordedCodexEndpoint } from '../daemon/presence/endpoint-record.ts';
import {
  isSocketFile,
  ownedSocketPath,
  recordStartMatches,
  unmanagedEndpointNotes,
} from '../launch/codex-endpoint.ts';
import { codexCommandHasFlag, codexCommandRemoteUrl, codexEndpointConfig, managedCodexLaunch } from '../launch/plan.ts';
import { unfinishedWebhookNotes, webhookDeliveryNotes } from '../bus/webhook-notes.ts';
import { rulesOriginOf } from '../launch/rules.ts';
import { declaredUnreadAfter, UNREAD_AFTER_WAKEABLE_SECONDS, unreadWindowSeconds, watchInForceWithPace, watchPaceNotes, watchPaceOf } from '../watch/rhythm.ts';
import { callerLabel, fileOwnerRefusal, isOwner, readAncestors, sessionOwnerRefusal, walkCaller } from '../caller.ts';
import { widenedGrantNotes } from '../client/general-grant.ts';
import { KEY_ISOLATION_LINE } from '../client/records.ts';
import { blindDifferences } from '../commands/seats.ts';
import { resolveSeatOverrides } from '../config/apply.ts';
import { approvalAndOverrideRows, emptyOverrides, protectedCheckouts, realSources, rulesFileDifferences } from '../commands/status.ts';
import type { DelegateSources } from '../delegate.ts';
import { devModeActive, devModeOwnerLift } from '../dev_mode.ts';
import { developmentModeNote, readDevelopmentMode } from '../development_mode.ts';
import { greenNotes, idleWorkNotes, readPendingGreen } from '../idle_work.ts';
import type { IdleWorkInput, IdleWorkReport, PendingGreenSlice } from '../idle_work.ts';
import type { DaemonHealth } from '../daemon/health.ts';
import { daemonDifferences, daemonProblemNotes, daemonReading } from '../daemon/health_display.ts';
import { canonicalRoot } from '../daemon/routes.ts';
import { canonicalRoot as ownerCanonicalRoot, readOwnerActionRecord } from '../client/owner-action.ts';
import { actionRequestsFolder } from '../client/team-create.ts';
import { hostedWatchCheckNotes, hostedWatchDifferences, paneWatchCheckNotes } from '../daemon/watch_display.ts';
import { currentTeam } from '../file/current.ts';
import { leftoverDifferences, leftoverNote } from '../file/team-config.ts';
import { declaredModel } from '../file/model.ts';
import { isParseError, TEAM_FILE } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { isLeadSeat, relaunchRepair } from '../file/sections/lead.ts';
import { displayAgent, labelPersona, LEAD_NAME, seatNickname, workspaceLabel } from '../file/sections/seats.ts';
import { inboxRegistration } from '../mcp/register.ts';
import type { LoadResult, Problem, Seat, TeamFile } from '../file/types.ts';
import { agentList, hasCustomHerdrRun, foregroundArgv0, PANE_WINDOW, paneProcesses, paneProcessesOf, paneProcessInfo, paneRead, reportDisplayAgent, sessionList, sessionRunning, SIDEBAR_TTL_CAP_MS, workspaceList, workspacePanes, workspaceRename, type PaneProcesses } from '../herdr.ts';
import { sidebarPolicy } from '../settings/sidebar-policy.ts';
import type { Io } from '../io.ts';
import { GENERAL_BRIEF_SHA256, briefBindingOf, currentBriefClaim, generalBriefRecord } from '../launch/general-brief.ts';
import { paneHoldsOnlyShell } from '../launch/identity.ts';
import { seatDeliveryClass, wakeableWhileIdle } from '../launch/delivery-class.ts';
import { seatProcessVerdict } from '../launch/identity.ts';
import { logLine } from '../log.ts';
import { resolveLobby } from '../lobby/gate.ts';
import { listUnread } from '../mcp/inbox.ts';
import {
  collapseNotes,
  contextLine,
  formatRelativeTime,
  pluralCount,
  renderDeprecationWarnings,
  renderDifferences,
  renderNotes,
  renderSummary,
  summaryCounts,
  toJsonDifference,
  ttyStyle,
  writeJson,
  writeJsonError,
  type DeprecationWarning,
} from '../output/index.ts';
import { dialogsTrustInForce } from '../permissions/dialogs-trust.ts';
import { rosterOf } from '../permissions/who.ts';
import { herdrUnreliable, profileFor } from '../profiles/index.ts';
import { featureMismatch } from '../launch/features.ts';
import { overridesInForceOf } from '../profiles/overrides.ts';
import { cliWordList, displayEffort } from '../profiles/profile.ts';
import {
  loadAndResolvePolicyChain,
  mailboxRouterPolicyProblems,
  parseOwnerReplyToValue,
  readProjectPolicySource,
  readSeatPolicySource,
  readTeamPolicySource,
  resolveOwnerReplyTo,
  type PolicyLoadRefusal,
} from '../policy/index.ts';
import { codexDaemonForSeat } from '../policy/codex-daemon.ts';
import { mayReadTeam } from '../read-gate.ts';
import { findAgent, updateAgent, type Agent } from '../registry/agents.ts';
import { continuityIdsOf, continuitySessionOf, recordedSeatContinuity } from '../registry/resume.ts';
import { byName, ofTeam, projectIdOf, ProjectsError } from '../registry/projects.ts';
import { nicknameTakenNotes } from '../registry/names.ts';
import { getTeam, readTeams, teamIdOf, TeamsError } from '../registry/teams.ts';
import { readRecord, recordHolds, receiptFile, receiptHolds, verifyRecord } from '../send/record.ts';
import { defaultSocketsDirs } from '../send/address.ts';
import { deliveryChainOf } from '../send/delivery.ts';
import { launchWords, socketEligible } from '../send/inbound.ts';
import { SOCKET_SEND } from '../send/uds.ts';
import { messagingStoreChainOf } from '../send/store.ts';
import {
  DELIVERY_ORDER,
  liveOrderRecord,
  liveOrderWords,
  orderDeclarationsOf,
  type DeliveryLeg,
  type MessagingStore,
  type OrderWord,
  type SettingLevel,
} from '../settings/inherit.ts';
import { deliveryOrder, resolveOrderSetting } from '../settings/resolve.ts';
import { emptySession, liveHold, pidAlive, readState, seatOfFile, updateState, type SeatState, type SessionState, type State } from '../state.ts';
import { compare, orderAndAnnotateDifferences, paneShowsSeat, seatRecordsOf, socketLegOf, type Difference, type Live } from '../status/compare.ts';
import { observeLabel } from '../labels/observe.ts';
import { toolTrace } from '../labels/traces.ts';
import { heldAt } from '../launch/rules-file.ts';
import { modelDiffers, recordSignedModel } from '../status/statusline.ts';
import { messageKeyState } from '../store/keys.ts';
import type { Standing } from '../store/store.ts';
import { listModelRuleBreaches, type RuleLookup } from '../swap/rule.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import type { Attention } from '../watch/check.ts';
import { watchSitting } from '../watch/liveness.ts';
import { processCommOf, processFoldersOf, processStartOf, processTable } from '../watch/process-adapter.ts';
import { EVENT_LOG_TOTAL_BYTES } from '../bus/kinds.ts';
import { retainedLogBytes } from '../bus/log.ts';
import { busLogSizeNotes, busProblemNotes } from '../bus/notes.ts';
import { pingpongLegDifferences } from './pingpong-legs.ts';
import { closeOrphans, orphanReading, type OrphanCloseSources, type OrphanProcessSources, type OrphanReading } from './orphans.ts';
import {
  EMPTY_SIDEBAR_REPAIR,
  readSeatPaneDisplays,
  realSidebarCheckSources,
  repairSidebarLayout,
  sidebarLayoutDifferences,
  type CheckSidebarSources,
} from './sidebar.ts';
import { attentionOf } from '../watch/pass.ts';
import { readScreen, type Screen } from '../watch/screen.ts';

export type { CheckSidebarSources };

/** The team check's own arguments: the owner's aimed/repair flags, the lead's or owner's close, and
 *  optional `--json`. */
export type TeamCheckArgs = {
  session?: string;
  file?: string;
  repair?: boolean;
  closeOrphans?: boolean;
  json?: boolean;
};

// What the check reads from outside the file and the state, so tests and the docs harness can
// stand in for it: the same reads `status` makes, except that the live read is narrowed to the
// panes this project's state records for this team's seats (§3.3a).
export type CheckSources = {
  live(session: string, team: TeamFile, state: SessionState): Live | null;
  branch(path: string): string | null;
  standing(root: string): Standing;
  now(): Date;
  /** The home whose store holds the approval record and the override file. Absent in a test
   *  that does not set one, exactly as `StatusSources.home`. */
  home?: string;
  /** The approved pane's read gate's own reads; the real ones when absent. */
  gate?: DelegateSources;
  /** The two sidebar writes `team register` makes: the workspace label and the display line.
   *  `--repair` re-applies the file's lines through them; the real ones when absent. */
  renameWorkspace?: (session: string, workspace: string, label: string) => boolean;
  reportDisplayAgent?: (session: string, pane: string, text: string, ttlMs?: number) => boolean;
  /** The idle-with-work snapshot, from the watch. Read-only; absent when no producer is wired, and
   *  a test stands in for it. */
  idleWork?(input: IdleWorkInput): IdleWorkReport;
  /** Ready-but-not-installed slices, from the green journal. Read-only; a test stands in for it. */
  pendingGreen?(dir: string): PendingGreenSlice[];
  /** Whether a recorded watch's process is alive. Absent: the real process reading; a scene
   *  stands in for it so a live, dead or stale pane watch can be pinned. */
  alive?(pid: number): boolean;
  /** The folders the seats' session sockets are read in, in the order discovery walks them; the
   *  default folders when absent. A scene hands in its own so no read touches this machine's. */
  sockets?: string | readonly string[];
  /** The machine daemon's reading, already probed by the command wrapper before this
   *  synchronous report runs. Absent in a test that does not stand one in. */
  daemon?: DaemonHealth;
  /** The one probe the wrapper awaits; a scene hands `daemon` instead and reads no socket. */
  daemonHealth?(home: string): Promise<DaemonHealth>;
  /** The process and socket readings that prove a running Codex seat's managed endpoint is its
   *  own live app-server on its planned flags; absent in scenes that do not stand one in so no
   *  test reads this machine's process table. */
  codexEndpoint?: CodexEndpointCheckSources;
  /** The sidebar layout, per-session reload, and pane display reads/writes; adapter defaults when absent. */
  sidebar?: CheckSidebarSources;
  /** The panes in a workspace (`pane list --workspace`). Wired in `realCheckSources`; a scene
   *  stands in for it. */
  workspacePanes?: (session: string, workspace: string) => readonly string[] | null;
  /** A pane's process identity (`pane process-info --pane`). Wired in `realCheckSources`; a scene
   *  stands in for it. */
  processes?: (session: string, pane: string) => PaneProcesses | null;
  /** The process readings the orphan scan makes — the table, many working folders at once, and
   *  this run's own ancestry. Absent when no producer is wired: a run then reads no process table,
   *  as a scene that does not stand one in must not touch this machine. */
  orphans?: OrphanProcessSources;
  /** What the close flow reads and does — liveness, the same process's identity, the pane proof,
   *  the stop signals and the waits between them. Absent when no producer is wired: a run then
   *  refuses `--close-orphans` rather than touching a process it cannot re-prove. */
  closeOrphans?: OrphanCloseSources;
};

export type CodexEndpointCheckSources = {
  alive?: (pid: number) => boolean;
  commandOf?: (pid: number) => string | null;
  startOf?: (pid: number) => number | null;
  isSocket?: (path: string) => boolean;
  runtimeRoot?: string;
};

/** What one session's panes hold: each pane's shell and the foreground pids that are not it; null
 *  when the session's agent list or any pane's process reading did not answer. A read that does not
 *  answer is never read as "no pane holds it". */
function heldIn(session: string): ReadonlySet<number> | null {
  const agents = agentList(session);
  if (agents === null) return null;
  const held = new Set<number>();
  for (const agent of agents) {
    const processes = paneProcesses(agent.pane, session);
    if (processes === null) return null;
    held.add(processes.shell);
    for (const pid of processes.foreground) held.add(pid);
  }
  return held;
}

/**
 * The shipped sources. The live read is `status`'s own with one narrowing: `status` reads every
 * agent's screen, a stray's included, and this reads a screen only where this project's state
 * records the pane for a seat of this team. Every agent's process identity is read either way:
 * the orphan reading holds a CLI herdr names at a pane even when no record of this project's
 * names the seat there. The rest is the same code, not a copy of it.
 */
export const realCheckSources: CheckSources = {
  live(session, team, state) {
    const running = sessionRunning(session);
    if (running === null) return null;
    if (!running) return { running: false, agents: [], workspaces: [], screens: {} };
    const agents = agentList(session);
    const workspaces = workspaceList(session);
    if (!agents || !workspaces) return null;
    // The panes this project's state records for this team's seats: a pane recorded for another
    // session, another project or nobody at all is not read here.
    const recorded = new Set<string>();
    for (const seat of team.seats) {
      const pane = state.seats[seat.name]?.pane;
      if (pane) recorded.add(pane);
    }
    // A temporary seat is a seat of this team by its record alone (`team add --temporary` never
    // writes one into the file): its pane is read on the same terms as a declared seat's, so a
    // temporary seat held at a prompt is named in a real run and not only in a scene.
    for (const held of Object.values(state.seats)) {
      if (held.temporary !== undefined && held.pane) recorded.add(held.pane);
    }
    const screens: Record<string, string> = {};
    const processes: Record<string, PaneProcesses | null> = {};
    const foreground: Record<string, string[] | null> = {};
    for (const agent of agents) {
      if (recorded.has(agent.pane)) {
        const screen = paneRead(agent.pane, PANE_WINDOW, session);
        if (screen !== null) screens[agent.pane] = screen;
      }
      // The pane's process identity, for the comparison with the one the state recorded: a pane
      // that no longer holds what team launched is not the seat. Null when herdr can't tell. The
      // same reading carries the foreground names the restore proof ties a restored CLI with, so
      // a pane is asked for once and both maps come from the one answer.
      const info = paneProcessInfo(agent.pane, session);
      processes[agent.pane] = paneProcessesOf(info);
      foreground[agent.pane] = foregroundArgv0(info);
    }
    // A recorded seat herdr no longer lists an agent for still has its pane standing where it was
    // launched: read too, so one left holding its shell is told apart from one that is gone.
    for (const seat of team.seats) {
      const held = state.seats[seat.name];
      if (!held?.launched || !held.pane || held.pane in processes) continue;
      const info = paneProcessInfo(held.pane, session);
      processes[held.pane] = paneProcessesOf(info);
      foreground[held.pane] = foregroundArgv0(info);
      const screen = paneRead(held.pane, PANE_WINDOW, session);
      if (screen !== null) screens[held.pane] = screen;
    }
    return { running: true, agents, workspaces, screens, processes, foreground };
  },
  branch: realSources.branch,
  standing: realSources.standing,
  now: realSources.now,
  home: realSources.home,
  // The same snapshot and pending reader `status` uses, wired once: the commands cannot disagree.
  idleWork: realSources.idleWork,
  pendingGreen: realSources.pendingGreen,
  // One probe, at the command wrapper: this report is synchronous and only reads the snapshot.
  daemonHealth: realSources.daemonHealth,
  codexEndpoint: {
    alive: pidAlive,
    startOf: processStartOf,
    isSocket: isSocketFile,
  },
  sidebar: realSidebarCheckSources,
  workspacePanes: (session, workspace) =>
    workspacePanes(workspace, session === 'default' ? undefined : session),
  processes: (session, pane) =>
    paneProcesses(pane, session === 'default' ? undefined : session),
  // The process adapter's own readings: the table scoped to this user, one bulk folder query, and
  // this run's ancestry so the check never names or closes itself.
  orphans: {
    table: processTable,
    foldersOf: processFoldersOf,
    ancestorsOf: (pid) => readAncestors(pid)?.map((one) => one.pid) ?? null,
    own: () => readAncestors(process.pid)?.map((one) => one.pid) ?? [process.pid],
  },
  // The close flow's own readings. Every session but this one is read once per close run, and this
  // session's panes are read again immediately before each signal: the question can stand open
  // while a pane picks a process up. A pane list or pane reading that does not answer means no
  // close, never a guess.
  closeOrphans: {
    alive: pidAlive,
    commOf: processCommOf,
    startOf: processStartOf,
    ancestorsOf: (pid) => readAncestors(pid)?.map((one) => one.pid) ?? null,
    heldElsewhere: (_pids, session) => {
      const sessions = sessionList();
      if (sessions === null) return null;
      const held = new Set<number>();
      for (const other of sessions) {
        if (!other.running || other.name === session) continue;
        const set = heldIn(other.name);
        if (set === null) return null;
        for (const pid of set) held.add(pid);
      }
      return held;
    },
    heldHere: (session) => heldIn(session),
    signal: (pid, signal) => {
      try {
        process.kill(pid, signal === 'terminate' ? 'SIGTERM' : 'SIGKILL');
        return true;
      } catch {
        return false;
      }
    },
    pause: (ms) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
  },
};

/**
 * The check's run. Every return is one of the check's own exits, and every one of them is reached
 * only after the caller gate above it has answered (design §4's two-phase rule).
 */
export function runTeamCheck(args: TeamCheckArgs, io: Io, sources: CheckSources): number {
  const walked = walkCaller(io);
  const owner = isOwner(walked);
  // Phase 1 is the typed line and the walk alone. Phase 2 resolves the file, the approval's
  // standing, the state and herdr — and uses all of it only to decide: for a caller that does not
  // pass, `--file` is never opened and no session is placed, so the target is the file the
  // caller's own place finds.
  const current = currentTeam(io.cwd, owner ? args.file : undefined, sources.now(), sources.home, false, owner ? args.session : undefined);
  if (owner) {
    if (!current.ok) {
      if (args.json) {
        const id = current.errors.some((e) => e.message.startsWith('not inside a git repository'))
          ? 'check.not-a-repo'
          : current.errors.some(isParseError)
            ? 'check.file-invalid'
            : 'check.file';
        writeJsonError(io, id, current.errors.map((p) => `${p.line ? `team config line ${p.line}: ` : ''}${p.message}`).join('; '));
      } else {
        printProblems(io, current.errors);
      }
      // exit: check.not-a-repo
      // exit: check.file
      // exit: check.file-invalid
      return 2;
    }
  } else {
    if (!current.ok || !mayReadTeam(current, io, sources)) {
      return notYours(io, args.json);
    }
    const fallbackNotice = current.notice ? plainText(current.notice) : undefined;
    // The caller passes and is not the owner: the flags aim nothing, and one aimed meets the
    // refusal every other command gives it — after the gate, never before it.
    if (args.file !== undefined) {
      const msg = fileOwnerRefusal(io, args.file) ?? "--file is the owner's";
      if (args.json) {
        writeJsonError(io, 'check.file-owner', msg, null, 1, undefined, fallbackNotice);
      } else {
        io.stderr(`team check: ${msg}\n`);
      }
      // exit: check.file-owner
      return 1;
    }
    if (args.session !== undefined) {
      const msg = sessionOwnerRefusal(walked);
      if (args.json) {
        writeJsonError(io, 'check.session-owner', msg, null, 1, undefined, fallbackNotice);
      } else {
        io.stderr(`team check: ${msg}\n`);
      }
      // exit: check.session-owner
      return 1;
    }
    // `--repair` writes: the check's one act, and the owner's alone, as the two aimed flags are.
    if (args.repair === true) {
      const msg = "--repair is the owner's";
      // The owner's dev-mode admission for exactly this gate: a placed lead or
      // orchestrator continues with the warning; the owner's own path above never reaches here.
      const lift = devModeOwnerLift(io, {
        command: 'check',
        refusal: msg,
        ...(sources.home !== undefined ? { home: sources.home } : {}),
        team: current.team,
        root: current.root,
        dir: current.dir,
        now: sources.now(),
        // The placed operator may repair, under the lead-gates policy.
        admitsOperator: true,
      });
      if (!lift.lifted) {
        if (args.json) {
          writeJsonError(io, 'check.repair-owner', msg, null, 1, undefined, fallbackNotice);
        } else {
          io.stderr(`team check: ${msg}\n`);
        }
        // exit: check.repair-owner
        return 1;
      }
      io.stderr(`${lift.warning}\n`);
    }
    // `--close-orphans` ends processes: the team's lead or the owner, never a plain seat. This
    // caller still sees every row the reading names; only the close is not the seat's.
    if (args.closeOrphans === true && !(walked.kind === 'seat' && isLeadSeat(current.team, walked.name))) {
      const msg = "--close-orphans is the team's lead's or the owner's";
      if (args.json) {
        writeJsonError(io, 'check.close-orphans-lead', msg, null, 1, undefined, fallbackNotice);
      } else {
        io.stderr(`team check: ${msg}\n`);
      }
      // exit: check.close-orphans-lead
      return 1;
    }
  }
  // The close asks its one question at a terminal, before anything is read or signalled: a run
  // with no terminal, or with no process reading wired, refuses here and changes nothing.
  if (args.closeOrphans === true) {
    if (sources.orphans === undefined || sources.closeOrphans === undefined) {
      const msg = '--close-orphans has no process reading here';
      if (args.json) {
        writeJsonError(io, 'check.close-orphans-unavailable', msg, null, 2);
      } else {
        io.stderr(`team check: ${msg}\n`);
      }
      // exit: check.close-orphans-unavailable
      return 2;
    }
    if (!io.stdinIsTTY) {
      const msg = '--close-orphans asks before it closes anything; it needs a terminal';
      if (args.json) {
        writeJsonError(io, 'check.close-orphans-terminal', msg, null, 2);
      } else {
        io.stderr(`team check: ${msg}\n`);
      }
      // exit: check.close-orphans-terminal
      return 2;
    }
  }
  const { team, root, dir } = current;
  const notice = current.notice ? plainText(current.notice) : undefined;
  if (!args.json && notice !== undefined) io.stdout(`${notice}\n`);
  const session = owner ? (args.session ?? team.session) : team.session;
  // The one read of the approval store: the drift, and the values in force, all derive from it.
  const standing = sources.standing(root);
  const overrides = sources.home ? overridesInForceOf(standing, team.project, root, sources.home) : emptyOverrides();
  let whole: State;
  try {
    whole = readState(dir);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (args.json) {
      writeJsonError(io, 'check.state', msg, null, 1, undefined, notice);
    } else {
      io.stderr(`team check: ${msg}\n`);
    }
    // exit: check.state
    return 2;
  }
  // The live read comes before the repair: the check refuses when herdr cannot answer, and a run
  // that refuses must have changed nothing. The read is the state's own seats for the file's
  // seats — the leftovers the repair drops are never among them — so the comparison below reads
  // the same live session either way.
  const recorded = whole.sessions[session] ?? emptySession();
  let live = sources.live(session, team, recorded);
  if (!live) {
    const msg = "herdr doesn't answer; is it installed and running?";
    if (args.json) {
      writeJsonError(io, 'check.herdr', msg, null, 1, undefined, notice);
    } else {
      io.stderr(`team check: ${msg}\n`);
    }
    // exit: check.herdr
    return 2;
  }
  // The state's leftovers, read before anything is compared: a record for a seat the file no
  // longer declares, and a session the file does not name with no seat of the team in it. They
  // are named as differences below; with the owner's `--repair` they are dropped first, so the
  // comparison runs on the state the file would have written. The file is the truth: nothing is
  // ever guessed back into it.
  let stale = staleState(team, session, whole);
  const repaired: string[] = [];
  let sidebarRepair = EMPTY_SIDEBAR_REPAIR;
  const repairedDisplayPanes = new Set<string>();
  if (args.repair === true) {
    // The owner's one repair, in the order the readings below depend on: the state's leftovers
    // first, then the registration an agent wrote under dev mode, then the two sidebar lines. Each
    // line is printed and logged as its phase finishes, so a write that throws later leaves the
    // repairs already made named. Every write that fails throws, as every other command's state
    // write does.
    const named = (lines: string[]): void => {
      repaired.push(...lines);
      for (const line of lines) logLine(dir, 'check', callerLabel(walked), `repaired: ${line}`, sources.now());
    };
    if (stale.seats.length > 0 || stale.sessions.length > 0) {
      named(dropStale(dir, session, stale));
      whole = readState(dir);
      stale = staleState(team, session, whole);
    }
    named(reRecordMarked(team, root, sources.home));
    sidebarRepair = repairSidebarLayout({
      home: sources.home,
      root,
      team,
      session,
      now: sources.now(),
      sidebar: sources.sidebar,
      io,
    });
    if (sidebarRepair.repaired.length > 0) named(sidebarRepair.repaired);
    // The file is the truth for both sidebar lines: a drifted one is set back from it, through
    // the same two writes `team register <seat>` makes. The live session is read again after the
    // writes, so the comparison below reads the sidebar the repair left; a session herdr no
    // longer answers keeps the first read, and its rows stand.
    const after = whole.sessions[session] ?? emptySession();
    const prePaneDisplays = readSeatPaneDisplays(session, team, after, live, sources.sidebar);
    const drifts = labelDrifts(team, after, live, prePaneDisplays);
    if (drifts.length > 0) {
      const sidebarTtlMs =
        sources.home === undefined
          ? SIDEBAR_TTL_CAP_MS
          : sidebarPolicy({ home: sources.home, root, team, now: sources.now() }).ttlMs;
      named(syncLabels(drifts, session, sources, io, sidebarTtlMs, repairedDisplayPanes));
      live = sources.live(session, team, after) ?? live;
    }
  }
  const state = whole.sessions[session] ?? emptySession();
  const paneDisplays = readSeatPaneDisplays(session, team, state, live, sources.sidebar);
  const sidebarChecked = sidebarLayoutDifferences({
    home: sources.home,
    root,
    team,
    session,
    now: sources.now(),
    sidebar: sources.sidebar,
    repairState: sidebarRepair,
  });
  // Live agent CLIs no pane holds any more, read from the state's own launches and from the
  // working folders inside this root. A scene that wires no process source reads no process
  // table, and the reading itself asks for nothing until a seat or an agent exists.
  const orphansOf = (): OrphanReading | null =>
    sources.orphans === undefined
      ? null
      : orphanReading({
          project: team.project,
          root,
          session,
          state,
          live,
          now: sources.now(),
          daemonSince: sources.daemon?.since ?? null,
          sources: sources.orphans,
        });
  let orphans = orphansOf();
  // The lead's or owner's one act per run: close the orphan candidates that carry the close's
  // proof, after one question at the terminal. The reading is then taken again, so the rows below
  // describe the world the close left — a closed process is gone, and one the close could not end
  // is still a row with the reading's own repair on it.
  const closedLines: string[] = [];
  if (args.closeOrphans === true && orphans !== null && sources.closeOrphans !== undefined) {
    const closing = closeOrphans({
      candidates: orphans.candidates,
      session,
      sources: sources.closeOrphans,
      confirm: (prompt) => confirmClose(io, prompt),
    });
    closedLines.push(...closing.lines);
    for (const line of closing.lines) logLine(dir, 'check', callerLabel(walked), line, sources.now());
    if (closing.closed > 0) orphans = orphansOf();
  }
  const policyChecked = policyCheck(team, root, sources.home, sources.now(), io.env, dir, callerLabel(walked));
  const modelRule = modelRuleCheck(team, root, sources.home);
  // The same live grant `status` reads, so the two readings offer `team answer` together or not
  // at all: the setting is one record, never a file key and never a stale approval. The pace is
  // the watch's own: one policy value, converted legacy file values, and an unreadable chain
  // reported as a note rather than silently replaced.
  const watchPace = watchPaceOf({ team, root, home: sources.home, now: sources.now(), standing });
  const inForce = watchInForceWithPace(standing, team, watchPace);
  // The watch that owns this session, read once through the same predicate `up` plans from: the
  // check cannot call a watch stale that `up` would leave alone, or miss the one it would replace.
  const watch = watchSitting({
    daemon: sources.daemon,
    root,
    pane: state.watch,
    alive: (pid) => sources.alive?.(pid) ?? pidAlive(pid),
    now: sources.now().getTime(),
    interval: inForce.interval,
  });
  const watchRoute = canonicalRoot(root) ?? root;
  // The daemon's hosted watch for this checkout, judged once: a stopped, failed or gate-blocked
  // watch is not enforcing anything, and it is the owner's own install that repairs it. Its
  // lines are the difference's then, and the notes below do not say them again.
  const hostedWatch = hostedWatchDifferences(watch);
  // The registry's own continuity per declared seat, read once: the check's process gate and
  // `compare()` must decide a restored pane the same way `up` and `status` do.
  const continuityIds = sources.home === undefined ? undefined : continuityIdsOf({
    home: sources.home,
    root,
    herdrSession: session,
    seats: team.seats,
    states: state.seats,
  });
  const comparison = compare(
    team,
    session,
    state,
    live,
    sources.now(),
    inForce,
    undefined,
    dialogsTrustInForce(sources.home ?? homedir(), root, sources.now()),
    undefined,
    continuityIds,
  );
  // Dev mode is the local override, read from the caller's place: under it the approval and
  // overrides state rows fold into quiet notes, and a seat recorded under it is counted rather
  // than named seat by seat — `team seats` keeps the mark, and `team status --all --json` keeps
  // the field. Outside dev mode every row stands. The effective policy, not the variable, decides
  // once a value governs.
  const quiet = devModeActive(io, {
    ...(sources.home !== undefined ? { home: sources.home } : {}),
    entity: team.entity,
    team,
    root,
    now: sources.now(),
  });
  const record = approvalAndOverrideRows(
    standing.kind === 'legacy' || standing.kind === 'refused' ? notInForce(standing) : null,
    overrides,
    quiet,
  );
  const provenance = devModeDifferences(team, root, sources.home, quiet);
  const attention = attentionDifferences(team, state, live, sources.now(), continuityIds);
  const briefs = generalBriefDifferences(team, state, root, sources.home, session);
  const socketSkipped = socketSkippedDeliveries(
    team,
    state,
    live,
    root,
    dir,
    session,
    sources.home,
    sources.sockets ?? defaultSocketsDirs(),
    sources.now(),
    continuityIds,
  );
  comparison.differences = orderAndAnnotateDifferences([
    // A seat the check names itself in its own stuck-prompt line is not named again in
    // `compare()`'s plain words: one line per held seat, the richer one.
    ...comparison.differences.filter((difference) => difference.promptSeat === undefined || !attention.named.has(difference.promptSeat)),
    ...signingDifferences(team, state, live, root, sources.home),
    ...briefs.differences,
    ...unreadDifferences(team, state, live, root, dir, sources.home, session, sources.sockets ?? defaultSocketsDirs(), declaredUnreadAfter(inForce, watchPace), sources.now()),
    ...provenance.differences,
    ...liftCardDriftDifferences(sources.home, root, quiet, sources.now()),
    ...attention.differences,
    ...labelDifferences(team, state, live, paneDisplays, repairedDisplayPanes),
    ...sidebarChecked.differences,
    ...featureDifferences(team, state),
    ...unmanagedCodexServerDifferences(team, state, live, dir, session, continuityIds, sources),
    ...rosterDifferences(team, state, live, root, sources.home),
    ...registryDifferences(team, root, sources.home),
    // A team file left beside a registry team that says something else: never silent.
    ...leftoverDifferences(current.leftover),
    ...deliveryOrderDifferences(team, root, sources.home),
    ...socketSkipped.differences,
    // The daemon's watch for this checkout: not running when the route carries one, or running
    // with its outbound gate closed, is a difference — the watch is not enforcing anything.
    ...hostedWatch,
    ...policyChecked.differences,
    // An entity with a lead and no live signed owner-reply endpoint loses owner replies
    // after the upgrade that stopped shipping one. One difference: what is missing, and
    // the dry-run that declares the lead's own address. A live declaration, a team that
    // names no entity, and an unreadable value say nothing here.
    ...ownerReplyDifferences(team, root, sources.home, sources.now()),
    ...modelRule.differences,
    // The nightly harness's latest per-leg result: a class over its send-to-read target, a lost
    // message, or a result older than a day. A team that has not run draws nothing.
    ...pingpongLegDifferences(dir, sources.now()),
    ...protectedCheckouts(team, root, { branch: sources.branch }),
    // The same rows `status` prints: a legacy record or one the verification refused still says
    // what it is; a machine that never approved the file is the ordinary file now, and nothing to
    // repair. Under dev mode both fold into the quiet notes above.
    ...record.differences,
    ...rulesFileDifferences(standing, team, root, sources.home, rulesOriginOf(current.source)),
    ...staleDifferences(stale),
    ...unrecordedWorkspaceDifferences(team, state, live, root, sources.home, session, sources),
    // A live agent CLI no pane holds: named with its pid, age and the record it answers to, with
    // the team's own close where a state record or the daemon's start proves it the team's.
    ...(orphans?.differences ?? []),
    // A blind seat — unknown past the blind threshold — counts as not working, and is
    // a must-fix here exactly as it is in `team status`.
    ...blindDifferences(team, state, live, comparison, sources.now(), liveHold(whole, sources.now()) !== null, { project: team.project, root, home: sources.home, stateDir: dir, session }),
    // A daemon endpoint that failed is a difference here too, with its checkout, reason and age;
    // the note above names the daemon's reading, this row is what the check counts.
    ...(sources.daemon !== undefined ? daemonDifferences(sources.daemon, sources.now()) : []),
  ]);
  const differences = comparison.differences;
  // A deprecated field the file still reads: the check is the one command that names it, with
  // the repair its record carries. It is not a difference and does not change the exit — the
  // file works, it just carries a key this build no longer acts on.
  const shown = shownTeamFile(current.path, root);
  const deprecationWarnings: DeprecationWarning[] = [
    ...current.warnings.flatMap((w): DeprecationWarning[] => {
      const repair = deprecationRepairOf(w.message, shown);
      if (repair === undefined) return [];
      return [{ line: w.line || undefined, message: w.message, repair }];
    }),
    ...(current.deprecations ?? []).map((deprecation) => ({
      line: deprecation.line || undefined,
      message: deprecation.message,
      repair: deprecation.repair.replace('{file}', shown),
    })),
  ];
  const warnings = renderDeprecationWarnings(deprecationWarnings);
  // Idle with work and ready-but-uninstalled slices: the same two reads and the same lines as
  // `team status`, notes only — neither changes the total nor the exit. A green journal that
  // cannot be read is named as such, never read as "no slice is ready".
  const idleWork = sources.idleWork?.({
    root,
    team,
    state,
    live,
    now: sources.now(),
    ...(sources.home !== undefined ? { home: sources.home } : {}),
    pause: whole.pause ?? null,
    seatPauses: whole.seat_pauses ?? null,
    swaps: Object.keys(whole.swaps ?? {}),
  });
  const green = sources.pendingGreen === undefined ? null : readPendingGreen(sources.pendingGreen, dir);
  const leftoverLine = leftoverNote(current.leftover);
  const idleNotes = [
    ...(leftoverLine !== null ? [leftoverLine] : []),
    ...(idleWork !== undefined ? idleWorkNotes(idleWork) : []),
    ...greenNotes(green),
    // The daemon's reading: a note only when there is something to act on. A daemon that is
    // simply not installed is the ordinary state and is said in `status`, not counted here.
    ...(sources.daemon !== undefined ? daemonProblemNotes(sources.daemon) : []),
    // A hosted watch the daemon carries, notes only: a standing-down or stopped watch, a failed
    // cycle, and a blocked outbound gate are named; a watch simply cycling says nothing, and a
    // route whose watch is already the difference above keeps only the lines it does not carry.
    ...(sources.daemon !== undefined
      ? hostedWatchCheckNotes(sources.daemon, sources.now(), {
          ...(watch.kind === 'hosted' && hostedWatch.length > 0 ? { differing: watch.root } : {}),
          ...(watch.kind === 'pane'
            ? { ownPane: { route: watchRoute, live: watch.health.state === 'live' } }
            : {}),
        })
      : []),
    // A running seat whose CLI registers its inbox in a project file, and whose folder holds no
    // registration: the seat receives nothing on its inbox leg, and nothing else says so. Read
    // from the file the profile's route writes. A launch-line route writes no file and a seat
    // whose launch folder was never recorded cannot be read this way: both say nothing.
    ...inboxRegistrationNotes(team, state, live),
    // A pane watch when no hosted one owns the route: live, dead, stale or — only with a daemon
    // reading to prove no hosted watch exists — missing. Notes only, like every line above.
    ...paneWatchCheckNotes(watch, {
      known: sources.daemon !== undefined && sources.daemon.state !== 'unknown',
      running: live?.running === true,
    }),
    // The event bus: a dead one, or one `team up` started that is gone. Notes only.
    ...busProblemNotes({
      root,
      alive: (pid) => sources.alive?.(pid) ?? pidAlive(pid),
      recorded: state.bus,
      autostart: team.bus?.autostart !== false,
    }),
    // The retained event log at four fifths of its size cap: named so the team's lead sees the
    // cap coming. A stat per retained slot, never a read of a segment.
    ...(sources.home !== undefined
      ? busLogSizeNotes({
          bytes: retainedLogBytes(team.project, root, sources.home),
          cap: EVENT_LOG_TOTAL_BYTES,
        })
      : []),
  ];
  // The notes print above the differences, as `team status` prints them: a note names something
  // worth acting on without counting it wrong — it is not in the total and does not change the exit.
  const notes = collapseNotes([
    ...delegateNotes(team),
    // A wildcard general grant signed before the release that first shipped an op reaches that op
    // without a new approval: named once per grant, information only, never counted as a difference.
    ...(sources.home !== undefined ? widenedGrantNotes(sources.home, sources.now()) : []),
    ...leadNameNotes(team),
    ...nicknameDriftNotes(team),
    ...nicknameTakenNotes(team, root, sources.home),
    ...leadRoleNotes(team),
    // The default session moved to <entity>-<project>: the line the approval's own comparison
    // names, so the owner sees the old and the new session before the next launch.
    ...sessionDefaultMoveNotes(standing, team, sources.home),
    ...lobbyNotes(team, root, sources.home, session),
    // A delivery_order word still naming `mcp-inbox`: the name is retired — the inbox is the
    // store's reader, not a leg (ADR D1) — and the word is read as an alias that is dropped from
    // every order, with this note asking for its removal.
    ...deliveryOrderInboxNotes(team),
    // A seat whose chain declares `messaging.store: none`: what its sends stop keeping, named
    // once per seat where the word is in force.
    ...messagingStoreNotes(team, root, sources.home, sources.now()),
    ...policyChecked.notes,
    ...modelRule.notes,
    ...socketSkipped.notes,
    ...unknownStatusNotes(team, state, live),
    // A Codex seat whose last launch fell back to an unmanaged line, in the same words `team
    // status` prints: the fallback is a reading worth acting on, never a silent state.
    ...unmanagedEndpointNotes(team.seats, state),
    // Every ready Codex seat whose policy would manage an endpoint and whose record is absent,
    // unusable, or a recorded line carrying --no-daemon. One line, naming each seat and the
    // restore. A policy that is off, or a file that already names its own remote, stays off it.
    ...missingEndpointRecordNotes(team, state, dir, root, sources.home, session),
    // A seat whose last webhook delivery did not arrive, in the same words `team status` prints:
    // the send could not have known, so the outcome is read here.
    ...webhookDeliveryNotes(team.seats, state),
    // A send's webhook post left in flight with no bus serving the root to finish it: a reading,
    // never a delivered post.
    ...unfinishedWebhookNotes({ root, alive: (pid) => sources.alive?.(pid) ?? pidAlive(pid) }),
    ...record.notes,
    ...provenance.notes,
    // Why the orphan reading named nothing it might otherwise have named: a pane list that read
    // no agents, a pane herdr could not answer for, a folder or process read that did not answer.
    ...(orphans?.notes ?? []),
    ...idleNotes,
    ...watchPaceNotes(watchPace),
  ]);
  if (args.json) {
    writeJson(io, 'team.check', {
      format: 1,
      project: team.project,
      session,
      // The declared limitation of a client app key, carried as a field so the one JSON
      // document on stdout stays valid; text mode prints the same line on stdout (commands/check.ts).
      key_isolation: KEY_ISOLATION_LINE,
      ...(notice !== undefined ? { notice } : {}),
      warnings,
      repaired,
      notes,
      ...(idleWork !== undefined ? { idle_work: idleWork } : {}),
      ...(green?.kind === 'slices' ? { green_slices: green.slices } : {}),
      ...(green?.kind === 'refused' ? { green_notice: green.why } : {}),
      ...(sources.daemon !== undefined ? { daemon: daemonReading(sources.daemon) } : {}),
      differences: differences.map(toJsonDifference),
      summary: summaryCounts(differences),
      ...(briefs.stale ? { hint: ROLLOUT_HINT } : {}),
    });
  } else {
    const style = ttyStyle(io);
    io.stdout(`${contextLine(team.project, session)}\n`);
    io.stdout(`${KEY_ISOLATION_LINE}\n`);
    for (const warning of warnings) io.stdout(`${warning}\n`);
    for (const line of repaired) io.stdout(`repaired: ${line}\n`);
    for (const line of closedLines) io.stdout(`${line}\n`);
    for (const line of renderNotes(notes, { home: sources.home })) io.stdout(`${line}\n`);
    for (const line of renderDifferences(differences, style, sources.home)) io.stdout(`${line}\n`);
    if (sidebarChecked.tomlBlock !== null) io.stdout(`${sidebarChecked.tomlBlock}\n`);
    // One line, once, after the per-seat lines: this build's brief is ahead of a seat's claim,
    // and the rollout is the repair that delivers it to every live seat. The exit stays as it is.
    if (briefs.stale) io.stdout(`${ROLLOUT_HINT}\n`);
    io.stdout(`${renderSummary(differences)}\n`);
  }
  if (differences.length > 0) {
    // exit: check.findings
    return 1;
  }
  // The owner's own repair ran and left nothing to act on: the state now says what the file
  // does, and the run ends as a clean check with the dropped records named above.
  if (repaired.length > 0) {
    // exit: check.repaired
    return 0;
  }
  // exit: check.ok
  return 0;
}

/**
 * The close's one question, asked before anything is signalled. The report is a synchronous run,
 * so the answer is read in one go: `io.stdin` in a scene, the terminal's own input in a real run.
 * Only a clear yes closes; an empty answer, a no, or a read that did not answer declines.
 */
function confirmClose(io: Io, prompt: string): boolean {
  io.stdout(prompt);
  let answer = '';
  try {
    if (io.stdin !== undefined) {
      answer = io.stdin();
    } else {
      const buffer = Buffer.alloc(256);
      const read = readSync(0, buffer, 0, buffer.length, null);
      answer = read > 0 ? buffer.subarray(0, read).toString('utf8') : '';
    }
  } catch {
    answer = '';
  }
  io.stdout('\n');
  return /^\s*y(es)?\s*$/i.test(answer);
}

// The one sentence a caller that does not pass gets, whatever failed underneath it: it names no
// seat, no session and no path, and it is the only output such a caller can get (§3.4, §4).
function notYours(io: Io, json?: boolean): number {
  const msg = 'this team is not yours to check';
  if (json) {
    writeJsonError(io, 'check.not-yours', msg);
  } else {
    io.stderr(`team check: ${msg}\n`);
  }
  // exit: check.not-yours
  return 2;
}

/** The team record as a repair names it: `team config` for this checkout's own record, or the
 *  path itself when `--file` aimed the run at another file. */
export function shownTeamFile(path: string | undefined, root: string): string {
  if (path === undefined) return 'team config';
  const rel = relative(root, path);
  if (rel === TEAM_FILE) return 'team config';
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

/** A state seat record the file no longer declares, with the pane it claims when it expects one. */
type StaleSeat = { name: string; pane?: string };

/** What the state keeps that the file does not: seats the file no longer declares (a temporary
 *  seat excepted — the file never lists one), and sessions with no seat of the team in them. */
type Stale = { seats: StaleSeat[]; sessions: string[] };

/**
 * The state's leftovers, read against the file alone. The addressed session's seats are compared
 * with the file's own: a record for a name the file no longer declares names no pane of this
 * team's, and only a temporary seat — which the file never lists — keeps its record. Every other
 * session the state holds is a leftover unless a seat of the team lives in it: a name the file
 * declares, or a temporary seat the file never lists. The file's own session and the addressed
 * session are never leftovers themselves: the first is where the team runs, and the second is the
 * session this run is about — `--session` aims the check at it, so the repair must not drop the
 * record it is reading. What herdr is running is not read: the state's own claims are the subject,
 * and a pane herdr no longer lists is still a pane the state claims.
 */
function staleState(team: TeamFile, session: string, whole: State): Stale {
  const declared = new Set(team.seats.map((seat) => seat.name));
  const seats: StaleSeat[] = [];
  for (const [name, seat] of Object.entries(whole.sessions[session]?.seats ?? {})) {
    if (seatOfFile(name, seat, declared)) continue;
    seats.push({ name, ...(seat.pane !== undefined ? { pane: seat.pane } : {}) });
  }
  const sessions: string[] = [];
  for (const [name, held] of Object.entries(whole.sessions)) {
    if (name === team.session || name === session) continue;
    if (Object.entries(held.seats).some(([seatName, seat]) => seatOfFile(seatName, seat, declared))) continue;
    sessions.push(name);
  }
  return { seats, sessions };
}

/** One difference per leftover, the owner's to drop: the check names them and `--repair` is the
 *  repair — never an edit of the file, and never a guess at which record is right. */
function staleDifferences(stale: Stale): Difference[] {
  const repair = 'drop its record from the state (team check --repair)';
  const out: Difference[] = [];
  for (const seat of stale.seats) {
    out.push({
      what: seat.pane === undefined
        ? `${seat.name}: left the team file but its record is still in the state`
        : `${seat.name}: left the team file but its record still claims pane ${seat.pane}`,
      repair,
      owner: true,
    });
  }
  for (const name of stale.sessions) {
    out.push({
      what: `the state records the session "${name}", and no seat of the team is in it`,
      repair,
      owner: true,
    });
  }
  return out;
}

function collectSessionRecords(
  sessionState: SessionState | undefined,
  workspaces: Set<string>,
  panes: Set<string>,
): void {
  if (sessionState === undefined) return;
  for (const held of Object.values(sessionState.seats)) {
    if (typeof held.workspace === 'string' && held.workspace !== '') {
      workspaces.add(held.workspace);
    }
    if (typeof held.pane === 'string' && held.pane !== '') {
      panes.add(held.pane);
    }
  }
  if (typeof sessionState.watch?.workspace === 'string' && sessionState.watch.workspace !== '') {
    workspaces.add(sessionState.watch.workspace);
  }
  if (typeof sessionState.watch?.pane === 'string' && sessionState.watch.pane !== '') {
    panes.add(sessionState.watch.pane);
  }
  if (typeof sessionState.bus?.workspace === 'string' && sessionState.bus.workspace !== '') {
    workspaces.add(sessionState.bus.workspace);
  }
  if (typeof sessionState.bus?.pane === 'string' && sessionState.bus.pane !== '') {
    panes.add(sessionState.bus.pane);
  }
  if (typeof sessionState.watchdog?.pane === 'string' && sessionState.watchdog.pane !== '') {
    panes.add(sessionState.watchdog.pane);
  }
}

function collectDelegatePanes(
  delegates: TeamFile['delegates'],
  session: string,
  panes: Set<string>,
): void {
  for (const delegate of delegates ?? []) {
    if (typeof delegate.pane !== 'string' || delegate.pane === '') continue;
    const slash = delegate.pane.indexOf('/');
    if (slash <= 0 || slash !== delegate.pane.lastIndexOf('/') || slash === delegate.pane.length - 1) continue;
    if (/\s/.test(delegate.pane)) continue;
    if (delegate.pane.slice(0, slash) === session) {
      panes.add(delegate.pane.slice(slash + 1));
    }
  }
}

/**
 * Workspaces in `session` that no team record names and whose panes are all bare shells, read
 * fresh through the terminal host role (`pane list --workspace` and `pane process-info --pane`).
 * Read-only: `team check` never closes an unrecorded workspace, because it may belong to the
 * owner or another team. A workspace with an unreadable or empty pane list, or any pane whose
 * process reading is unreadable or lists a foreground process other than its own shell, is left
 * uncounted.
 */
function unrecordedWorkspaceDifferences(
  team: TeamFile,
  state: SessionState,
  live: Live,
  root: string,
  home: string | undefined,
  session: string,
  sources: CheckSources,
): Difference[] {
  if (!live.running || live.workspaces.length === 0) return [];
  if (
    sources.workspacePanes === undefined &&
    sources.processes === undefined &&
    !hasCustomHerdrRun()
  ) {
    return [];
  }

  const recordedWorkspaces = new Set<string>();
  const recordedPanes = new Set<string>();
  collectSessionRecords(state, recordedWorkspaces, recordedPanes);
  collectDelegatePanes(team.delegates, session, recordedPanes);
  if (home !== undefined) {
    try {
      const teams = readTeams(home);
      const ownRoot = resolve(root);
      for (const record of Object.values(teams)) {
        if (resolve(record.root) === ownRoot) continue;
        try {
          const otherState = readState(join(record.root, '.agents'));
          collectSessionRecords(otherState.sessions[session], recordedWorkspaces, recordedPanes);
        } catch {
          // A sibling team whose state cannot be read does not fail this team's check.
        }
        try {
          const otherConfig = readTeamConfig(record.root, { home, checkOnly: true });
          if (otherConfig.ok) {
            collectDelegatePanes(otherConfig.team.delegates, session, recordedPanes);
          }
        } catch {
          // A sibling team whose config cannot be read does not fail this team's check.
        }
      }
    } catch {
      // An unreadable team registry is named once by `registryDifferences`.
    }
  }
  for (const agent of live.agents) {
    if (recordedPanes.has(agent.pane) && typeof agent.workspace === 'string' && agent.workspace !== '') {
      recordedWorkspaces.add(agent.workspace);
    }
  }

  const readPanes =
    sources.workspacePanes ??
    ((s: string, w: string) => workspacePanes(w, s === 'default' ? undefined : s));
  const readProcesses =
    sources.processes ??
    ((s: string, p: string) => paneProcesses(p, s === 'default' ? undefined : s));

  const out: Difference[] = [];
  for (const workspace of live.workspaces) {
    if (recordedWorkspaces.has(workspace.id)) continue;
    recordedWorkspaces.add(workspace.id);
    const panes = readPanes(session, workspace.id);
    if (panes === null || panes.length === 0) continue;
    if (panes.some((pane) => recordedPanes.has(pane))) continue;
    let allBareShells = true;
    for (const pane of panes) {
      const process = readProcesses(session, pane);
      if (!paneHoldsOnlyShell(process)) {
        allBareShells = false;
        break;
      }
    }
    if (!allBareShells) continue;
    out.push({
      what: `unrecorded workspace ${workspace.id} (${workspace.label}) holds only shells`,
      repair: 'look at the workspace; close it if it is yours',
    });
  }
  return out;
}

/**
 * The owner's repair: the leftovers `staleState` named, dropped from the state in one locked
 * write, each one re-checked against the record now on disk — a temporary seat, or a record
 * gone already, is left alone. The lines returned are the ones actually dropped, each printed
 * as a `repaired:` line and written to the log; a write that fails throws, as every command's
 * state write does.
 */
function dropStale(dir: string, session: string, stale: Stale): string[] {
  return updateState(dir, (state) => {
    const lines: string[] = [];
    for (const name of stale.sessions) {
      if (!Object.hasOwn(state.sessions, name)) continue;
      delete state.sessions[name];
      lines.push(`the state's session "${name}" holds no seat of the team; its record is dropped`);
    }
    const current = state.sessions[session];
    if (current !== undefined) {
      for (const seat of stale.seats) {
        const held = current.seats[seat.name];
        if (held === undefined || held.temporary !== undefined) continue;
        delete current.seats[seat.name];
        lines.push(seat.pane === undefined
          ? `${seat.name}: left the team file; its record is dropped`
          : `${seat.name}: left the team file and its record claimed pane ${seat.pane}; its record is dropped`);
      }
    }
    return lines;
  });
}

/**
 * A seat whose record carries the dev mark: its registration was written by a run whose caller
 * gate was folded into a warning (`src/registry/agents.ts`, `src/registry/sync.ts`), so the
 * record that says what the seat is was made without the ordinary gate behind it. The difference
 * states plainly that the seat was registered by an agent rather than by the owner, and names the
 * one repair that takes the mark off: the owner's own `team register`, the same write with nothing
 * folded — a clean launch of the seat does it too. A seat the file no longer names, and one whose
 * record the registry holds none for, is not this finding's.
 */
function devModeDifferences(
  team: TeamFile,
  root: string,
  home: string | undefined,
  quiet: boolean,
): { differences: Difference[]; notes: string[] } {
  if (home === undefined) return { differences: [], notes: [] };
  const out: Difference[] = [];
  let marked = 0;
  const teamId = teamIdOf(root);
  for (const seat of team.seats) {
    const record = findAgent(home, { team: teamId, seat: seat.name });
    if (record?.provenance.dev_mode !== true) continue;
    // Under dev mode the mark is the expected record, not a finding: one quiet note counts the
    // seats instead of one row per seat.
    if (quiet) {
      marked += 1;
      continue;
    }
    out.push({
      what: `${seat.name}: registered by an agent, not by the owner`,
      repair: `re-record the seat with the caller gate in force (team register ${seat.name})`,
    });
  }
  return { differences: out, notes: marked > 0 ? [`${pluralCount(marked, 'seat')} recorded under dev mode`] : [] };
}

/** The actions a card may still ask for while dev mode is on: a change to the general grant, and
 *  the loosening of a security policy (the machine's own `development-mode` record). Every other
 *  pending request for this team is policy drift there — the lift already admits the record edit a
 *  card would ask for, and a seat model, CLI or label change is never carded under it. */
const LIFT_CARD_ACTIONS: readonly string[] = ['team-general-grant', 'development-mode'];

/**
 * Pending owner cards for this team while dev mode is on, other than the two actions that may
 * still be carded. A request that expired or was answered is not pending and is not this
 * finding's; a request for another folder is another team's. Read-only: the check names the card
 * and the action it asks for, and the repair is to answer it or let it expire.
 */
function liftCardDriftDifferences(home: string | undefined, root: string, quiet: boolean, now: Date): Difference[] {
  if (home === undefined || !quiet) return [];
  let names: string[];
  try {
    names = readdirSync(actionRequestsFolder(home)).filter((name) => /^oa_[0-9a-f]{24}\.json$/.test(name)).sort();
  } catch {
    return [];
  }
  const out: Difference[] = [];
  for (const name of names) {
    const id = name.slice(0, -'.json'.length);
    let record: ReturnType<typeof readOwnerActionRecord>;
    try {
      record = readOwnerActionRecord(home, id);
    } catch {
      continue;
    }
    if (typeof record === 'string') continue;
    if (ownerCanonicalRoot(record.params.root) !== ownerCanonicalRoot(root)) continue;
    if (record.expires_at !== null && Date.parse(record.expires_at) <= now.getTime()) continue;
    try {
      if (existsSync(join(actionRequestsFolder(home), `${id}.seat-answer.json`))) continue;
    } catch {
      continue;
    }
    const drift = record.params.actions.filter((action) => !LIFT_CARD_ACTIONS.includes(action));
    if (drift.length === 0) continue;
    out.push({
      what: `owner card ${id} asks for ${drift.join(', ')} under dev mode: policy drift, and only a general grant change or a security policy loosening is carded there`,
      repair: `answer or let ${id} expire; under dev mode the lead runs a seat, CLI or label change with no card`,
    });
  }
  return out;
}

/**
 * The owner's repair of a dev-mode mark: every file seat whose newest record an agent's folded run
 * wrote is recorded again with the caller gate in force — the same write `team register <seat>`
 * makes as the owner, with the one patch that clears `dev_mode`, `dev_mode_by` and `dev_mode_at`
 * (`src/registry/agents.ts`). A team with no home has no registry to repair, and a seat the file
 * does not declare is not this repair's. Each line returned is named and logged by the caller.
 */
function reRecordMarked(team: TeamFile, root: string, home: string | undefined): string[] {
  if (home === undefined) return [];
  const lines: string[] = [];
  const teamId = teamIdOf(root);
  for (const seat of team.seats) {
    const record = findAgent(home, { team: teamId, seat: seat.name });
    if (record?.provenance.dev_mode !== true) continue;
    updateAgent(home, record.id, { provenance: { dev_mode: false } });
    lines.push(`${seat.name}: re-recorded with the caller gate in force; the dev-mode mark is cleared`);
  }
  return lines;
}

/**
 * The lobby the registry holds against the one the file would derive. Once the registry holds a
 * team's lobby, the entity never derives it again (`src/lobby/recorded.ts`): changing `entity` on
 * a running team no longer moves its seats, so the check names the file that now derives another
 * lobby and says which path stands. A file with an explicit `lobby:` is not a derivation — the
 * owner's own declaration re-records it — and a team the registry holds no lobby for has nothing
 * recorded to stand. The registry keeps one lobby per session, so the record speaks for this run
 * through the session it addresses — the file's own, or the `--session` the check was given; a
 * session with no entry derives from its entity, as a new team does. A home that names no store
 * answers for no registry, as the other notes do.
 */
function lobbyNotes(team: TeamFile, root: string, home: string | undefined, session: string): string[] {
  if (home === undefined || team.lobby) return [];
  let recorded = '';
  try {
    const record = getTeam(home, teamIdOf(root));
    // The session the check addresses: its own recorded lobby is the one that stands, and it is
    // the file's own unless `team check --session` named another.
    if (record !== null) recorded = record.lobbies[session] ?? '';
  } catch (error) {
    // An unreadable registry already has its own difference; it cannot say where the lobby is.
    if (!(error instanceof TeamsError)) throw error;
    return [];
  }
  if (!recorded) return [];
  const derived = resolveLobby(home, { entity: team.entity });
  if (derived === recorded) return [];
  return [`the file's entity derives the lobby ${derived}, and the registry records ${recorded}: the recorded lobby stands`];
}

/**
 * The check's notes: what it names without counting it wrong. A `delegates` entry naming `approve`
 * is one — `team approve` was removed, and the word is still accepted only so a file that already
 * names it loads unchanged, so the file carries a stale word to drop. A note prints above the
 * differences, is counted in neither their total nor the exit code, and names the entry's pane.
 */
function delegateNotes(team: TeamFile): string[] {
  const notes: string[] = [];
  for (const delegate of team.delegates ?? []) {
    if (!delegate.commands.includes('approve')) continue;
    notes.push(`${delegate.pane}'s delegate entry names approve, which no command acts on since team approve was removed; drop it from the file`);
  }
  return notes;
}

/**
 * A seat still named `lead`, where the file's own lead is another seat. The word is the send
 * grammar's team-lead address (`lead@<team>`, src/send/resolve.ts): the file keeps loading — a
 * file written before 0.5.0 may name its coordinator's seat so — the address always reaches the
 * seat that holds `leads`, and the legacy seat stays addressable by its bare name in its own
 * team. The team's lead renames it when convenient, so the address and the seat's name stop
 * sharing a spelling. A note, not a difference: nothing is wrong with the team, and the fix is a
 * `team rename` away.
 */
function leadNameNotes(team: TeamFile): string[] {
  if (team.orchestrator === LEAD_NAME) return [];
  const legacy = team.seats.find((seat) => seat.name === LEAD_NAME);
  if (legacy === undefined) return [];
  return [`seat "${LEAD_NAME}" does not hold leads: lead@<team> addresses the seat that does, so this seat answers only to its bare name; the team's lead: run team rename ${LEAD_NAME} <new-name> to give it another name`];
}

/**
 * The team's lead carrying the legacy role word: 0.3.5 and 0.4 files spell the role
 * `coordinator`, and an upgraded team keeps that word. The 0.5 word is `orchestrator`.
 * Admission, the `lead@<team>` address and the listing all key on the lead's place in the file —
 * the `leads` mark, or the legacy `coordinator:` key — never on a role's word, so every send
 * reaches the seat either way and the rename is housekeeping; the file is worth bringing to the
 * 0.5 word when convenient. A note, not a difference: nothing is wrong with the team, and its
 * exit code is unchanged.
 */
function leadRoleNotes(team: TeamFile): string[] {
  const lead = team.seats.find((seat) => seat.name === team.orchestrator);
  if (lead === undefined || lead.role !== 'coordinator') return [];
  return [`the lead seat "${lead.name}" carries the 0.3.5/0.4 role word "coordinator"; the 0.5 word is "orchestrator" — sends reach it either way, since admission keys on the lead seat, not the role: set \`role: orchestrator\` on it when convenient`];
}

/**
 * A seat whose written label names a word that is not the name the seat goes by. A persona the
 * `nickname:` field could hold is that name (src/file/sections/seats.ts:seatNicknames), so a field
 * a hand edit left behind means the seat sends under the label's word while the record says
 * another; a word the field could not hold — a space or an accent, the reserved `lead`, a name
 * another seat already carries — stays a workspace title, and the record's nickname remains the
 * address. A config set on either name writes the other with it whenever the pair can be one name
 * (src/config/edit.ts:syncSeatNames), so this is what a hand edit leaves. A note, not a
 * difference: the team runs either way.
 */
function nicknameDriftNotes(team: TeamFile): string[] {
  return team.seats.flatMap((seat) => {
    const persona = labelPersona(seat);
    if (persona === null) return [];
    const name = seatNickname(team.seats, seat);
    if (name !== persona) {
      return [`seat "${seat.name}": its written label names "${persona}", but the seat goes by "${name ?? seat.name}" — a space, an accent, the reserved "lead" or a word another seat carries is not a nickname, so the label's word is the workspace title alone; set seats.${seat.name}.nickname to choose the address`];
    }
    if (seat.nickname === undefined || seat.nickname === persona) return [];
    return [`seat "${seat.name}": its nickname is "${seat.nickname}" and its written label names "${persona}" — the label wins from the next launch, and a set on seats.${seat.name}.label writes the two together`];
  });
}

/**
 * The registry's signing triple against the pane: a seat whose agent record says it signs as
 * `<model> <version>` while its screen runs another model would sign commits with a model it does
 * not run, so the two things are named side by side with the re-record and the relaunch beside
 * them. The live agent must be the pane the state recorded for the seat, as the attention and
 * label differences read it: a name herdr lists on another pane is a stray, and its screen is not
 * this seat's. The record is the launch's own declaration (`src/registry/sync.ts`), and nothing
 * here updates it: `team register` writes the file's declared model into the record, so an
 * accepted drift is the file's model updated first and registered after, or the seat relaunched
 * on the record's model. A team the registry holds no record for reads as before, and a screen
 * the reader cannot name a model from — unread, or another maker's through Claude Code — is never
 * wrong.
 */
function signingDifferences(team: TeamFile, state: SessionState, live: Live, root: string, home: string | undefined): Difference[] {
  if (home === undefined) return [];
  const out: Difference[] = [];
  const teamId = teamIdOf(root);
  for (const seat of team.seats) {
    // The pane the state recorded for the seat: a name on another pane is not the seat, and its
    // model is not the one the record is compared with.
    const recorded = state.seats[seat.name]?.pane;
    const agent = live.agents.find((candidate) => candidate.name === seat.name);
    if (!agent || agent.pane !== recorded) continue;
    const record = findAgent(home, { team: teamId, seat: seat.name });
    if (!record) continue;
    const { model, version } = record.signing;
    // A model Claude Code cannot name is never read off its own default family: a provider
    // wrapper is compared with its own banner id, or the signing where it prints none, and a
    // bare launch keeps the screen its Claude family is a contradiction against. The provenance
    // is the record's own cli and launch — the line the running process was started from; a team
    // file edited after the launch cannot prove what it started.
    const running = recordSignedModel(
      { cli: seat.cli, model, version, launch: seat.launch, modelFrom: seat.modelFrom },
      record,
      live.screens[agent.pane],
    );
    if (!running) continue;
    // The comparison is the file's own (`modelDiffers`): a name in another word order, or a
    // version spelled inside the record's model name, is the model the pane runs.
    if (!modelDiffers(running, { model, version })) continue;
    // The record's own words, unless the file still declares exactly what the record signs: then
    // the seat's display spelling is the record's, the spelling every other line gives it.
    const signs = seat.model === model && seat.version === version ? declaredModel(seat) : `${model} ${version}`;
    const command = isLeadSeat(team, seat.name)
      ? relaunchRepair(team, seat.name, 'plain')
      : `team remove ${seat.name} --keep, then team add ${seat.name}`;
    out.push({
      what: `${seat.name}: signs as ${signs}, runs ${running.model} ${running.version}`,
      repair: `update the team file's model, then team register ${seat.name}, or relaunch on the recorded model (${command})`,
      needs: 'approve',
    });
  }
  return out;
}

/** The one line the check prints when this build's brief is ahead of any declared seat's claim:
 *  the rollout is the repair that delivers it to every live seat, once per run. */
export const ROLLOUT_HINT = 'run team brief rollout --apply to deliver the general seat brief to every live seat';

/**
 * The general seat brief every launch delivers first, by drop. A session that has launched a seat,
 * or recorded a delivery, is a session whose seats were due the brief. The claim is what the check
 * reads first: no claim, or one an older build wrote without the delivery lifetime, is a seat
 * that has not been delivered. A current claim is checked against the file it names — a missing
 * record is a delivery that never landed; an existing one that does not verify for the claim
 * (another text, lifetime, epoch binding, a planted file, a link) is a delivery record that does
 * not verify, and only the rollout's recovery may move past it. A CLI seat then needs read
 * evidence binding the claim; a human seat is delivery-only. Every repair is one the delivering
 * paths answer to, and the read repairs never waive the requirement: a seat whose launch installed
 * no reader is told how to read by hand and how to install one. The returned `stale` flag is the
 * one rollout hint the caller prints, once, when this build is ahead of any seat's claim.
 */
function generalBriefDifferences(
  team: TeamFile,
  state: SessionState,
  root: string,
  home: string | undefined,
  session: string,
): { differences: Difference[]; stale: boolean } {
  if (Object.keys(state.seats).length === 0 && state.briefs === undefined) return { differences: [], stale: false };
  const out: Difference[] = [];
  let stale = false;
  const key = home === undefined ? null : messageKeyState(home);
  for (const seat of team.seats) {
    const recorded = state.briefs?.[seat.name];
    const running = state.seats[seat.name] !== undefined;
    const human = seat.human === true;
    const repair = human ? 'team up' : `team reload ${seat.name} or team up`;
    const claim = currentBriefClaim(recorded);
    if (claim === null) {
      stale = true;
      // A CLI seat this session never launched has no delivery due yet: its launch is its repair,
      // and the comparison already names the launch if one was due.
      if (recorded === undefined && !running && !human) continue;
      out.push({ what: `${seat.name}: the general seat brief has not been delivered`, repair });
      continue;
    }
    if (claim.sha256 !== GENERAL_BRIEF_SHA256) stale = true;
    if (home === undefined) {
      // Without a home there is no message key to verify a signature with. A claim that is behind
      // this build is still a delivery the seat does not have; a current one stands as recorded.
      if (claim.sha256 !== GENERAL_BRIEF_SHA256) {
        out.push({ what: `${seat.name}: the general seat brief has not been delivered`, repair });
      }
      continue;
    }
    const dropDir = join(root, '.agents', 'send-drops', session, seat.name);
    const expected = {
      ...generalBriefRecord({
        to: seat.name,
        root,
        session,
        at: claim.at,
        incarnation: claim.incarnation,
        attempt: claim.attempt,
      }),
      // The claim's id is the delivered body's id: a handover variant is still the claim's record,
      // and the canonical digest it carries is what ties the text to this build.
      id: claim.id,
      thread: claim.id,
    };
    const path = join(dropDir, claim.id);
    if (heldAt(path).kind === 'missing') {
      out.push({ what: `${seat.name}: the general seat brief has not been delivered`, repair });
      continue;
    }
    if (!recordHolds(path, expected, home, { body: false, to_id: false })) {
      out.push({ what: `${seat.name}: the general seat brief's delivery record does not verify`, repair });
      continue;
    }
    if (human) continue;
    if (key === null || key.kind !== 'key') continue;
    const context = { to: seat.name, root, session };
    const binding = briefBindingOf(claim);
    const readVerified = receiptHolds(receiptFile(dropDir, claim.id, 'read'), claim.id, 'read', context, key.key, binding)
      || receiptHolds(receiptFile(dropDir, claim.id, 'replied'), claim.id, 'replied', context, key.key, binding);
    // A delivery is a file fact and never implies a successful attribution: a seat whose launch
    // did not reach ready keeps its launch difference, and the read is not demanded of it. A read
    // that arrived before readiness is provisional — the runtime it came from is not confirmed.
    if (state.seats[seat.name]?.stage !== 'ready') {
      out.push({
        what: `${seat.name}: the general seat brief has been delivered; launch not ready`,
        repair: `the launch's repair runs first; the seat's next turn reads it`,
      });
      if (readVerified) {
        out.push({
          what: `${seat.name}: a read happened before readiness; the runtime is not confirmed`,
          repair: `the launch's repair runs first`,
        });
      }
      continue;
    }
    if (readVerified) continue;
    const readRepair = `the seat's next turn reads it; team reload ${seat.name} delivers it again`;
    const watcher = state.seats[seat.name]?.watcher;
    const readerRepair = watcher === undefined || watcher === 'none'
      ? `${readRepair}; no turn-start reader is installed: the seat reads it with team drops --read --seat ${seat.name}, or team reload ${seat.name} installs the launch's hooks`
      : readRepair;
    const readHeld = heldAt(receiptFile(dropDir, claim.id, 'read')).kind;
    const repliedHeld = heldAt(receiptFile(dropDir, claim.id, 'replied')).kind;
    if (readHeld !== 'missing' || repliedHeld !== 'missing') {
      out.push({
        what: `${seat.name}: the general seat brief's read receipt does not verify`,
        repair: 'team brief rollout --apply recovers this seat at a new id; the file that does not verify is left in place',
      });
      continue;
    }
    if (olderReadReceipt(dropDir, claim.id, context, key.key)) {
      out.push({ what: `${seat.name}: the general seat brief's read receipt is stale (an earlier agent or an earlier text)`, repair: readerRepair });
      continue;
    }
    out.push({ what: `${seat.name}: the general seat brief has been delivered and not read`, repair: readerRepair });
  }
  return { differences: out, stale };
}

/**
 * Every seat with work still unread past its seat's window. The reading is the watch's own —
 * `listUnread`, with the same receipt, superseded and claim rules — so the check and the unread
 * wake agree on what unread means, window included: the file's declared `watch.unread_after` when
 * it moved the section, else the seat class's own default (30 s wakeable, 60 s typed; ADR
 * zeus-message-path, D2). One difference per seat names the oldest message and counts the rest.
 * The general seat brief has its own read difference and is not counted twice; a person's drop is
 * read by a person and is never asked for a receipt, and without a message key no receipt can be
 * judged, so neither is named here.
 */
function unreadDifferences(
  team: TeamFile,
  state: SessionState,
  live: Live,
  root: string,
  dir: string,
  home: string | undefined,
  session: string,
  sockets: string | readonly string[],
  declaredSeconds: number | null,
  now: Date,
): Difference[] {
  if (home === undefined) return [];
  const key = messageKeyState(home);
  if (key.kind !== 'key') return [];
  const out: Difference[] = [];
  // The shortest window any seat class can earn: a seat with nothing older than this is left
  // before its launch records are read at all.
  const floorSeconds = declaredSeconds ?? UNREAD_AFTER_WAKEABLE_SECONDS;
  for (const seat of team.seats) {
    if (seat.human === true) continue;
    const brief = state.briefs?.[seat.name];
    const briefIds = new Set<string>([
      ...(brief === undefined ? [] : [brief.id]),
      ...(brief?.superseded ?? []),
    ]);
    const dropDir = join(root, '.agents', 'send-drops', session, seat.name);
    const context = { to: seat.name, root, session, lead: team.orchestrator };
    const unread = listUnread(dropDir, context, home).filter((message) => {
      if (briefIds.has(message.id)) return false;
      return now.getTime() - Date.parse(message.ts) >= floorSeconds * 1000;
    });
    if (unread.length === 0) continue;
    // The class the seat's own launch left, read exactly as the socket reading and a send read
    // it, so the repair cannot promise a wake the seat does not have. Only a seat nothing can
    // wake while it is idle needs the turn said out loud: a wakeable seat's silence is a stuck
    // wake, not a class with no route.
    const recorded = state.seats[seat.name];
    const listed = live.agents.find((candidate) => candidate.name === seat.name);
    const delivery = seatDeliveryClass({
      dir,
      root,
      session,
      seat: seat.name,
      declared: seat,
      ...(recorded === undefined ? {} : { state: recorded }),
      home,
      processes: listed === undefined ? null : live.processes?.[listed.pane] ?? null,
      sockets,
    });
    // This seat's own window: the wake it earns and the gate this difference reads are one value.
    const windowSeconds = unreadWindowSeconds(declaredSeconds, delivery.class);
    const past = unread.filter((message) => now.getTime() - Date.parse(message.ts) >= windowSeconds * 1000);
    const oldest = past[0];
    if (oldest === undefined) continue;
    const minutes = Math.max(1, Math.round((now.getTime() - Date.parse(oldest.ts)) / 60_000));
    // The sender is the verified record's own word, and only that. The `.pending` marker beside
    // it is unsigned: it is never read as the message's sender, so it can never lend a message the
    // owner's name or a seat's standing. A record that cannot be opened or verified is named as
    // what it is — an unverified message — and keeps its age, its id and its count.
    let who = 'an unverified message';
    const looked = readRecord(join(dropDir, oldest.id), oldest.id);
    if (looked.ok && looked.record !== null && verifyRecord(looked.record, key.key)) {
      const from = looked.record.payload.from;
      who = typeof from === 'string' && from !== '' ? `a message from ${from}` : 'a message from an unknown sender';
    }
    const more = past.length > 1 ? `; ${String(past.length - 1)} more unread` : '';
    const watcher = recorded?.watcher;
    const readNow = `team drops --read --seat ${seat.name} reads it now`;
    const repair = watcher === undefined || watcher === 'none'
      ? `${readNow}; no turn-start reader is installed, so team reload ${seat.name} installs the launch's hooks`
      : wakeableWhileIdle(delivery.class)
        ? `a wake route stands for ${seat.name} and the message is still unread; ${readNow}`
        : delivery.evidence.watchWake
          ? `nothing wakes ${seat.name} while it is idle except a send-time typed wake, and the watch's typed retry has not delivered this message; ${readNow}, or a person or a restart must give it a turn`
          : delivery.evidence.typedWake
            ? `nothing wakes ${seat.name} while it is idle except a send-time typed wake into an empty composer; ${readNow}, or a person or a restart must give it a turn`
            : `nothing gives ${seat.name} a turn while it is idle; ${readNow}, or a person or a restart must give it a turn`;
    out.push({
      what: `${seat.name}: ${who} has been unread for ${String(minutes)} min${more} (id ${oldest.id})`,
      repair,
    });
  }
  return out;
}

/** Whether this seat's folder holds a signed read receipt for another message: the read an
 *  earlier agent or an earlier text left, which no longer binds the current claim. */
function olderReadReceipt(
  dropDir: string,
  claimId: string,
  context: { to: string; root: string; session: string },
  key: Parameters<typeof receiptHolds>[4],
): boolean {
  let names: string[];
  try {
    names = readdirSync(dropDir);
  } catch {
    return false;
  }
  for (const name of names) {
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(read|replied)\.json$/.exec(name);
    if (match === null) continue;
    const id = match[1]!;
    if (id === claimId) continue;
    const status = match[2] as 'read' | 'replied';
    if (receiptHolds(join(dropDir, name), id, status, context, key)) return true;
  }
  return false;
}

// The kinds the check names for a seat held at a prompt, in the words the brief gives them:
// `quota` is the watch's rate limit and `confirm` the CLI's own exit question. `unknown` is a
// screen no profile reads whose safety floor caught a prompt row — the floor's matched line is
// the one piece of that screen a reader may quote.
type StuckKind = 'permission' | 'trust' | 'quota' | 'confirm' | 'unknown';

const STUCK_WORDS: Record<StuckKind, string> = {
  permission: 'a permission prompt',
  trust: 'a trust prompt',
  quota: 'a quota prompt',
  confirm: 'a confirm prompt',
  unknown: 'an unrecognised prompt',
};

const STUCK_REPAIRS: Record<StuckKind, Pick<Difference, 'repair' | 'owner'>> = {
  permission: { repair: 'its lead answers it in the pane' },
  trust: { repair: 'the owner answers it in the pane', owner: true },
  quota: { repair: 'the owner waits for the reset; team never types into that screen', owner: true },
  confirm: { repair: 'the owner answers it in the pane, or team down --abandon closes it', owner: true },
  unknown: { repair: 'the owner looks at the pane', owner: true },
};

/** The prompt kind a screen shows, or null. Only an unknown screen whose safety floor carries a
 *  prompt row is named: an unknown one the floor left alone stays the watch's ordinary `blocked`
 *  line. */
function stuckKind(screen: Screen): StuckKind | null {
  switch (screen.kind) {
    case 'permission':
      return 'permission';
    case 'trust':
      return 'trust';
    case 'rate limit':
      return 'quota';
    case 'exit question':
      return 'confirm';
    case 'unknown':
      return screen.matched === undefined ? null : 'unknown';
    default:
      return null;
  }
}

/**
 * One held seat, in the check's words: the kind, the age the state's own clock gives it (the
 * seat's `last_active` — the only instant a seat record carries), the command the screen shows
 * when the profile's trace reader finds one, and for an unrecognised prompt the floor row that
 * named it. The age reads `last active <age>`: the prompt appeared after that moment, so the
 * record dates the seat's last activity, never claims how long the prompt itself has stood.
 */
function stuckPromptDifference(
  name: string,
  kind: StuckKind,
  screen: Screen,
  screenText: string | undefined,
  recorded: SeatState | undefined,
  cli: string,
  now: Date,
): Difference {
  const details: string[] = [];
  // Every detail below is text the screen showed, not text `team` wrote: each is cleaned the way
  // the report cleans a difference line, so the same string is safe in `--json`, which renders
  // `what` as it stands (a control sequence or a `\r` in it would otherwise reach the document).
  if (screen.kind === 'rate limit' && screen.reason !== undefined) {
    details.push(plainLine(screen.reason));
  } else if (screen.kind === 'rate limit') {
    // The reset in the screen's own phrase: `at` a clock or `in` a span, never the other. A
    // screen that names none says so, rather than leaving the reader to guess one.
    details.push(screen.reset === null
      ? 'the screen names no reset time'
      : `resets ${screen.reset.kind} ${plainLine(screen.reset.value)}`);
  }
  if (screen.kind === 'unknown' && screen.matched !== undefined) details.push(`matched "${plainLine(screen.matched)}"`);
  const tool = toolTrace(cli, screenText);
  if (tool !== null) details.push(plainLine(tool.what));
  const age = formatRelativeTime(recorded?.last_active, now);
  const since = age === '-' ? '' : ` (last active ${age})`;
  const detail = details.length === 0 ? '' : `: ${details.join('; ')}`;
  return { what: `${name}: stuck at ${STUCK_WORDS[kind]}${since}${detail}`, ...STUCK_REPAIRS[kind] };
}

/**
 * The watch's own report texts, as differences with the repair beside them (§3.3a): one read of
 * each pane this project's state records for a seat of this team, through the watch's own reader.
 * A seat held at a prompt the check can name — a permission dialog, a trust question, a quota
 * screen, the CLI's own exit question, or an unrecognised screen the safety floor caught — is
 * named in the check's own line, and `compare()`'s plain row for that seat is dropped (its
 * `promptSeat`) so the seat is named once. Every other seat keeps the watch's line. No write, no
 * key, no nudge, and no pane the state does not record for this team; the only screen text a line
 * quotes is the floor's own matched row. `named` is the seats the check named itself.
 */
function attentionDifferences(
  team: TeamFile,
  state: SessionState,
  live: Live,
  now: Date,
  continuityIds?: ReadonlyMap<string, string | null>,
): { differences: Difference[]; named: Set<string> } {
  const differences: Difference[] = [];
  const named = new Set<string>();
  type Read = { name: string; cli: string; recorded: SeatState | undefined; declared: boolean };
  const reads: Read[] = team.seats.map((seat) => ({
    name: seat.name,
    cli: seat.cli,
    recorded: state.seats[seat.name],
    declared: true,
  }));
  for (const [name, recorded] of Object.entries(state.seats)) {
    if (recorded.temporary === undefined || team.seats.some((seat) => seat.name === name)) continue;
    // A temporary seat reads its like-seat's CLI, as its row reads the like-seat's model; a
    // like-seat gone reads nothing, and the screen is unknown then.
    const like = team.seats.find((seat) => seat.name === recorded.temporary?.like);
    reads.push({ name, cli: like?.cli ?? '', recorded, declared: false });
  }
  for (const read of reads) {
    const pane = read.recorded?.pane;
    // Only the pane the state records for this seat, and only where that seat answers on it: a
    // pane herdr lists for the name on any other pane is a stale record, and is not read.
    if (pane === undefined) continue;
    const agent = live.agents.find((candidate) => candidate.name === read.name);
    if (!agent || agent.pane !== pane) continue;
    // The pane is the seat only while the process team launched is still in it, the same gate
    // `compare()` applies (`paneShowsSeat`): a pane back at its shell, or one running a process
    // the record does not name with no stored session showing continuity, keeps the process row,
    // and its scrollback is not read for a prompt — a dialog the CLI drew before it exited is not
    // a seat held at one. A record with no identity whose pane holds a bare shell reads no prompt
    // either.
    if (!paneShowsSeat(read.recorded, agent, live, continuitySessionOf(continuityIds, read.name, read.recorded?.agent_session))) continue;
    const text = live.screens[pane];
    const screen = readScreen(read.cli, text);
    // A launch's own waiting record already names the seat and the dialog it stopped at, with
    // the repair that resumes the launch (`waitingView`, `src/status/compare.ts`): the check
    // does not name the same seat a second time beside it. The watch's own line still reads.
    const kind = read.recorded?.waiting === undefined ? stuckKind(screen) : null;
    if (kind !== null) {
      named.add(read.name);
      differences.push(stuckPromptDifference(read.name, kind, screen, text, read.recorded, read.cli, now));
      continue;
    }
    // A temporary seat has no watch line beside the check's; a declared seat keeps the watch's
    // own reading, from its own two inputs: herdr's word, and — for a profile herdr cannot
    // report — the seat's screen, which is the reading there.
    if (!read.declared) continue;
    const theirWord = herdrUnreliable(read.cli);
    const quiet = theirWord
      ? screen.kind === 'idle' || screen.kind === 'unsent'
      : agent.status === 'idle' || agent.status === 'done';
    const view = viewOf(attentionOf(screen, agent.status, quiet, theirWord), read.name, agent.status);
    if (view) differences.push(view);
  }
  return { differences, named };
}

/**
 * One seat's drifted sidebar, read once for both the report and the owner's repair: the pane the
 * project's state recorded for it, and each of the file's two lines herdr holds differently.
 */
type LabelDrift = {
  seat: Seat;
  pane: string;
  workspace?: { id: string; title: string };
  display?: { kind: 'drift'; line: string } | { kind: 'missing' };
};

/**
 * The two herdr sidebar lines a file seat carries, as drift when they read as neither the file's
 * own text nor a line the watch is entitled to paint. Line 1 is exactly `workspaceLabel(seat)` —
 * nothing else writes it — so any other label is drift. Line 2 is the watch's
 * (`src/labels/observe.ts`): it may carry the model the pane shows in place of the file's display,
 * and an effort word read from a screen, so a line the observation explains is left alone. One
 * pane per seat, the one this project's state records — the same read the attention report makes.
 */
function labelDrifts(
  team: TeamFile,
  state: SessionState,
  live: Live,
  paneDisplays: ReadonlyMap<string, string | undefined> | null = null,
  repairedDisplayPanes?: ReadonlySet<string>,
): LabelDrift[] {
  const out: LabelDrift[] = [];
  for (const seat of team.seats) {
    if (seat.stopped) continue;
    const recorded = state.seats[seat.name]?.pane;
    if (recorded === undefined) continue;
    const agent = live.agents.find((candidate) => candidate.name === seat.name);
    const agentOnPane = agent !== undefined && agent.pane === recorded;
    const paneListed = paneDisplays !== null && paneDisplays.has(recorded);
    if (!agentOnPane && !paneListed) continue;
    const workspaceId = agentOnPane ? agent.workspace : state.seats[seat.name]?.workspace;
    const title = workspaceId === undefined
      ? undefined
      : live.workspaces.find((workspace) => workspace.id === workspaceId)?.label;
    const drift: LabelDrift = { seat, pane: recorded };
    if (workspaceId !== undefined && title !== undefined && title !== workspaceLabel(seat)) {
      drift.workspace = { id: workspaceId, title };
    }
    if (paneDisplays !== null) {
      const line = repairedDisplayPanes?.has(recorded)
        ? displayAgent(seat)
        : (paneListed ? paneDisplays.get(recorded) : agent?.displayAgent);
      if (line === undefined) {
        drift.display = { kind: 'missing' };
      } else if (!displayLineMatches(seat, line, live.screens[recorded])) {
        drift.display = { kind: 'drift', line };
      }
    } else if (agentOnPane) {
      const line = repairedDisplayPanes?.has(recorded) ? displayAgent(seat) : agent.displayAgent;
      if (line !== undefined && !displayLineMatches(seat, line, live.screens[recorded])) {
        drift.display = { kind: 'drift', line };
      }
    }
    if (drift.workspace !== undefined || drift.display !== undefined) out.push(drift);
  }
  return out;
}

// A running seat whose recorded launch line does not carry the one feature set its profile
// pins. Every seat of such a CLI joins one background server; a front end whose settings differ
// is refused until its owner chooses "run without daemon", which costs the seat the route its
// drops arrive on. The reading is the RECORDED launch line in team's own state, never a running
// process's command line, and a record that holds no line says unknown rather than a guess. The
// repair is the relaunch that writes the pinned line; a seat the state does not record was not
// left running by this session and is not named.
function featureDifferences(team: TeamFile, state: SessionState): Difference[] {
  const out: Difference[] = [];
  for (const seat of team.seats) {
    if (seat.stopped) continue;
    const features = profileFor(seat.cli)?.features ?? [];
    if (features.length === 0) continue;
    const held = state.seats[seat.name];
    if (!held) continue;
    // The line is read through the launch scope: a pin inside a quoted script that runs the CLI
    // is one the CLI reads, and a line that scope cannot decode is reported as unreadable rather
    // than as carrying a pin written after a script the CLI never receives.
    const said = featureMismatch(held.launch_line, features, held.launch_line === undefined ? undefined : cliWordList(seat.cli, held.launch_line));
    if (said === null) continue;
    out.push({ what: `${seat.name}: ${said}`, repair: `team restart ${seat.name}` });
  }
  return out;
}

function endpointContainsConfig(recorded: readonly string[], needed: readonly string[]): boolean {
  for (let i = 0; i + 1 < needed.length; i += 2) {
    if (needed[i] !== '-c') continue;
    const pair = needed[i + 1]!;
    let found = false;
    for (let j = 0; j + 1 < recorded.length; j += 2) {
      if (recorded[j] === '-c' && recorded[j + 1] === pair) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/** One note naming every ready Codex seat whose policy would manage an endpoint and whose
 *  record is absent, unusable, or a recorded launch line carrying `--no-daemon`. The restore
 *  is `team up` in that seat's project. A file that already names `--remote` or `--no-daemon`,
 *  or a policy that is off, is unmanaged and is not listed. */
function missingEndpointRecordNotes(
  team: TeamFile,
  state: SessionState,
  dir: string,
  root: string,
  home: string | undefined,
  session: string,
): string[] {
  if (home === undefined) return [];
  const gaps: string[] = [];
  for (const seat of team.seats) {
    if (seat.cli !== 'codex' || seat.stopped || seat.human === true) continue;
    const held = state.seats[seat.name];
    if (held?.stage !== 'ready') continue;
    const profile = profileFor(seat.cli);
    if (profile === null) continue;
    const launch = seat.launch ?? '';
    const daemon = codexDaemonForSeat({ home, root, team, seat: seat.name, session });
    if (!managedCodexLaunch({
      cli: profile.cli,
      binary: profile.binary,
      codexDaemon: daemon,
      stateDir: dir,
      launch,
      command: launch,
    })) continue;
    const recordedLine = held.launch_line;
    const noDaemon = recordedLine !== undefined && codexCommandHasFlag(recordedLine, '--no-daemon');
    const record = inspectRecordedCodexEndpoint(held.codex_endpoint, held.presence_binding);
    if (record.kind === 'ok' && !noDaemon) continue;
    const why = noDaemon
      ? 'launch line carries --no-daemon'
      : record.kind === 'invalid' ? 'unusable' : 'absent';
    gaps.push(`${seat.name} (${why})`);
  }
  if (gaps.length === 0) return [];
  gaps.sort();
  return [`no usable Codex endpoint record: ${gaps.join(', ')}; team up restores the endpoint`];
}

function unmanagedCodexServerDifferences(
  team: TeamFile,
  state: SessionState,
  live: Live | null,
  dir: string,
  session: string,
  continuityIds: ReadonlyMap<string, string | null> | undefined,
  sources: CheckSources,
): Difference[] {
  const out: Difference[] = [];
  if (live !== null && !live.running) return out;
  const endpointSources = sources.codexEndpoint;
  const aliveFn = endpointSources?.alive
    ?? sources.alive;
  const startOfFn = endpointSources?.startOf;

  for (const seat of team.seats) {
    if (seat.stopped || seat.human === true || seat.cli !== 'codex') continue;
    const held = state.seats[seat.name];
    if (held?.stage !== 'ready') continue;
    if (live !== null) {
      const listed = live.agents.find((c) => c.name === seat.name || (held.pane !== undefined && c.pane === held.pane));
      if (listed === undefined || (held.pane !== undefined && listed.pane !== held.pane)) continue;
      if (!paneShowsSeat(held, listed, live, continuitySessionOf(continuityIds, seat.name, held.agent_session))) continue;
    }
    const lineText = held.launch_line ?? seat.launch;
    const hasEndpointEvidence = endpointSources !== undefined
      || held.codex_endpoint !== undefined
      || held.presence_binding !== undefined
      || codexCommandRemoteUrl(lineText) !== null;
    if (!hasEndpointEvidence) continue;

    const repair = `team restart ${seat.name}`;
    const recordedRemote = codexCommandRemoteUrl(lineText);
    const noDaemon = codexCommandHasFlag(lineText, '--no-daemon');
    if (noDaemon && recordedRemote === null && held.codex_endpoint === undefined) continue;

    const record = readRecordedCodexEndpoint(held.codex_endpoint, held.presence_binding);
    if (record === null) {
      if (held.launch_line === undefined && held.codex_endpoint === undefined && recordedRemote === null) {
        out.push({
          what: `${seat.name}: cannot tell whether it is running against its managed Codex server (no launch line or managed endpoint is recorded for this seat)`,
          repair,
        });
      } else {
        out.push({
          what: `${seat.name}: running against an unmanaged Codex server (no valid managed endpoint is recorded for this seat)`,
          repair,
        });
      }
      continue;
    }
    if (held.launch_line === undefined && recordedRemote === null) {
      out.push({
        what: `${seat.name}: cannot tell whether it is running against its managed Codex server (its recorded launch line is missing)`,
        repair,
      });
      continue;
    }
    if (recordedRemote !== null && recordedRemote !== record.url) {
      out.push({
        what: `${seat.name}: running against an unmanaged Codex server (its recorded remote ${recordedRemote} does not match ${record.url})`,
        repair,
      });
      continue;
    }
    const owned = ownedSocketPath(dir, session, seat.name, record, endpointSources?.runtimeRoot);
    if (owned === null) {
      out.push({
        what: `${seat.name}: running against an unmanaged Codex server (its recorded endpoint ${record.url} is not this seat's owned socket)`,
        repair,
      });
      continue;
    }
    if (endpointSources?.isSocket === undefined) {
      out.push({
        what: `${seat.name}: cannot tell whether its managed Codex server socket is live`,
        repair,
      });
      continue;
    }
    if (!endpointSources.isSocket(owned.path)) {
      out.push({
        what: `${seat.name}: running against an unmanaged Codex server (its recorded endpoint socket is not live)`,
        repair,
      });
      continue;
    }
    if (aliveFn === undefined) {
      out.push({
        what: `${seat.name}: cannot tell whether its recorded app-server pid ${record.pid} is alive`,
        repair,
      });
      continue;
    }
    if (!aliveFn(record.pid)) {
      out.push({
        what: `${seat.name}: running against an unmanaged Codex server (its recorded app-server pid ${record.pid} is not alive)`,
        repair,
      });
      continue;
    }
    if (startOfFn === undefined) {
      out.push({
        what: `${seat.name}: cannot tell whether its recorded app-server pid ${record.pid} is the one its launch started (its start time cannot be read)`,
        repair,
      });
      continue;
    }
    const started = startOfFn(record.pid);
    if (started === null || !Number.isFinite(Date.parse(record.started_at))) {
      out.push({
        what: `${seat.name}: cannot tell whether its recorded app-server pid ${record.pid} is the one its launch started (its start time cannot be read)`,
        repair,
      });
      continue;
    }
    if (!recordStartMatches(record, started)) {
      out.push({
        what: `${seat.name}: running against an unmanaged Codex server (its recorded app-server pid ${record.pid} started at another time than its endpoint record)`,
        repair,
      });
      continue;
    }
    if (record.config === undefined) {
      out.push({
        what: `${seat.name}: cannot tell whether its managed Codex server carries the seat's start flags (its endpoint record names no config)`,
        repair,
      });
      continue;
    }
    const plannedFlags = codexEndpointConfig(lineText);
    if (!endpointContainsConfig(record.config, plannedFlags)) {
      out.push({
        what: `${seat.name}: running against an unmanaged Codex server (its recorded endpoint config lacks the seat's start flags)`,
        repair,
      });
    }
  }
  return out;
}

/**
 * The drifts as differences, one per line: the repair is `team register <seat>`, which re-applies
 * both lines from the file without a relaunch.
 */
function labelDifferences(
  team: TeamFile,
  state: SessionState,
  live: Live,
  paneDisplays: ReadonlyMap<string, string | undefined> | null = null,
  repairedDisplayPanes?: ReadonlySet<string>,
): Difference[] {
  const out: Difference[] = [];
  for (const drift of labelDrifts(team, state, live, paneDisplays, repairedDisplayPanes)) {
    const name = drift.seat.name;
    if (drift.workspace !== undefined) {
      out.push({
        what: `${name}: its herdr workspace label reads "${drift.workspace.title}", the file says "${workspaceLabel(drift.seat)}"`,
        repair: `team register ${name}`,
      });
    }
    if (drift.display?.kind === 'missing') {
      out.push({
        what: `${name}: its sidebar display line is missing or expired; the file's line is "${displayAgent(drift.seat)}"`,
        repair: `team register ${name}`,
      });
    }
    if (drift.display?.kind === 'drift') {
      out.push({
        what: `${name}: its herdr display reads "${drift.display.line}", the file's line is "${displayAgent(drift.seat)}"`,
        repair: `team register ${name}`,
      });
    }
  }
  return out;
}

/**
 * The owner's repair of the sidebar: each drifted line set back from the file alone — line 1
 * through the rename, line 2 through the display report, the same two writes `team register <seat>`
 * makes. A herdr that will not take one says so as `team register` does, and its difference stands;
 * a line the repair wrote is named in the run's `repaired:` lines and logged with them.
 */
function syncLabels(
  drifts: LabelDrift[],
  session: string,
  sources: CheckSources,
  io: Io,
  ttlMs = SIDEBAR_TTL_CAP_MS,
  repairedDisplayPanes?: Set<string>,
): string[] {
  const lines: string[] = [];
  const rename = sources.renameWorkspace ?? ((s: string, workspace: string, label: string) => workspaceRename(workspace, label, s));
  const report =
    sources.reportDisplayAgent ??
    ((s: string, pane: string, text: string, ttl = SIDEBAR_TTL_CAP_MS) => reportDisplayAgent(pane, text, s, ttl));
  for (const drift of drifts) {
    const name = drift.seat.name;
    if (drift.workspace !== undefined) {
      const label = workspaceLabel(drift.seat);
      if (rename(session, drift.workspace.id, label)) {
        lines.push(`${name}: its herdr workspace label is set back to "${label}"`);
      } else {
        io.stdout(`${plainLine(name)}: its title was not reported\n`);
      }
    }
    if (drift.display !== undefined) {
      const text = displayAgent(drift.seat);
      if (report(session, drift.pane, text, ttlMs)) {
        repairedDisplayPanes?.add(drift.pane);
        lines.push(`${name}: its herdr display is set back to "${text}"`);
      } else {
        io.stdout(`${plainLine(name)}: its display was not reported\n`);
      }
    }
  }
  return lines;
}

/**
 * A seat this project's state holds ready, running on the pane it recorded, that the team
 * registry's record does not list in its roster. The roster line is the seat's identity for
 * the permission bridge (`src/permissions/who.ts`): where the registry holds a record of the
 * team, the roster is the record of who its seats are, and a seat it does not list has none —
 * every gate wired to the bridge refuses the seat what the live file says it holds. A team
 * the registry holds no record of is not this difference: the bridge reads the file's own
 * declaration then, and the seat is served. A seat still launching is not one either: the line
 * is written when the seat reaches ready, and `team register <seat>` writes it for a seat that
 * is ready without one, its repair here.
 */
function rosterDifferences(
  team: TeamFile,
  state: SessionState,
  live: Live,
  root: string,
  home: string | undefined,
): Difference[] {
  if (home === undefined) return [];
  const roster = rosterOf(home, root);
  // Only a listed roster can name a missing line: a team the registry holds no record of reads
  // the file's declaration, and a registry that cannot be read names nothing here either — the
  // permission bridge refuses those callers closed, which this report does not soften.
  if (roster.kind !== 'listed') return [];
  const listed = new Set(roster.roster.map((line) => line.seat));
  const out: Difference[] = [];
  for (const seat of team.seats) {
    if (listed.has(seat.name)) continue;
    const held = state.seats[seat.name];
    if (held?.stage !== 'ready') continue;
    // The live pane the state recorded for the seat, as the label differences read it: a pane
    // herdr lists the name on anywhere else is a stale record, and `team register` would refuse
    // it, so it is not repaired from here.
    const agent = live.agents.find((candidate) => candidate.name === seat.name);
    if (!agent || agent.pane !== held.pane) continue;
    out.push({
      what: `${seat.name}: ready and running, and the team registry's roster does not list it`,
      repair: `team register ${seat.name}`,
    });
  }
  return out;
}

/**
 * Every effort word the `observeLabel` readers can print from a list, lowercased
 * (`src/labels/observe.ts`). A grok pane's word is whatever sits in its parens, so it is not
 * checked against this set.
 */
const EFFORT_WORDS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'none', 'minimal']);

/**
 * Whether a live line 2 is one the file or the watch could have written. The watch's line is
 * `observeLabel(seat, screen)` (src/labels/observe.ts): the file's display, replaced by the model
 * the pane shows when the screen names a different one, and the file's effort or one a screen
 * showed. The effort the watch read from an *earlier* screen in its own process is not readable
 * here, so any word those readers can print is accepted beside the line it would paint now.
 */
function displayLineMatches(seat: Seat, line: string, screen: string | undefined): boolean {
  const observed = observeLabel(seat, screen).line;
  if (line === observed) return true;
  const cut = line.lastIndexOf(' ');
  const model = cut < 0 ? line : line.slice(0, cut);
  const effort = cut < 0 ? '' : line.slice(cut + 1);
  const observedCut = observed.lastIndexOf(' ');
  if (model !== (observedCut < 0 ? observed : observed.slice(0, observedCut))) return false;
  const own = displayEffort(seat.cli, seat.effort);
  if (own === null) return false;
  if (effort === own) return true;
  return seat.cli === 'grok' || EFFORT_WORDS.has(effort);
}

/**
 * What the registries say about this team's place (src/registry/projects.ts, src/registry/teams.ts).
 * Membership is the team records' own: `ofTeam` answers this team's home project from its record,
 * and a team serving more than one project is the served membership a record may name, not a
 * difference. A registry that does not read refuses in the same line, so a machine whose registry
 * cannot be read is not read as fine. The team registry is read for every team, a project lead's
 * or not: the roster bridge
 * (`src/permissions/who.ts`) answers from it for every seat, so a file it cannot read leaves every
 * team unserved, and the difference is named wherever the check runs. And a project is led by one
 * team: when this team declares `project_lead: true`, the
 * project's other teams are looked up in the team registry (their `root` to their file) and a
 * second declaring team is a difference. A sibling the registries cannot answer for — no record,
 * no readable file, or a file naming another project — is not counted, and a team that declares
 * no lead reads no sibling at all. A team no project names is its own project, and a machine with
 * no registry has no projects: neither is a difference. A check with no home answers for no
 * registry at all, exactly as it reads no approval store.
 */
function registryDifferences(team: TeamFile, root: string, home: string | undefined): Difference[] {
  if (home === undefined) return [];
  try {
    // Read for every team, not only below for a lead's siblings: `rosterOf` swallows the read's
    // own error and reports no roster, which reads as no gap — so the unreadable registry is
    // named here, once, wherever the check runs.
    readTeams(home);
    ofTeam(home, teamIdOf(root));
    if (!team.projectLead || team.inProject === null) return [];
    const project = byName(home, team.inProject);
    if (project === null) return [];
    const leads = [team.project, ...leadSiblings(team, root, home, project.teams)];
    if (leads.length < 2) return [];
    return [{
      what: `the project ${team.inProject} has ${leads.length} lead teams: ${leads.join(', ')}`,
      repair: 'take "project_lead: true" off all but one of them',
    }];
  } catch (error) {
    if (error instanceof ProjectsError) return [{ what: `the project registry: ${error.message}`, repair: 'fix the project registry (~/.config/team/projects.yaml)' }];
    if (error instanceof TeamsError) return [{ what: `the team registry cannot be read: ${error.message}`, repair: 'fix the team registry (~/.config/team/teams.yaml)' }];
    throw error;
  }
}

/**
 * The names of this project's other teams whose files declare `project_lead: true` too, read
 * through the team registry's `root` and the file's canonical path — text only, so a sibling's
 * placement and its own trust are not this check's business. A sibling whose file names another
 * project is a stale registry, not a second lead of this one.
 */
function leadSiblings(team: TeamFile, root: string, home: string, teamIds: string[]): string[] {
  const mine = teamIdOf(root);
  const out: string[] = [];
  for (const id of teamIds) {
    if (id === mine) continue;
    const siblingRoot = getTeam(home, id)?.root;
    if (siblingRoot === undefined) continue;
    let loaded: LoadResult;
    try {
      // The sibling as its own source holds it: the registry's record, or its file in file mode.
      loaded = readTeamConfig(siblingRoot, { home, checkOnly: true });
    } catch {
      // A file that cannot be read at all (permissions, a broken link) is a sibling the check
      // cannot see: not counted, and not a reason for this team's check to fail.
      continue;
    }
    if (!loaded.ok) continue;
    if (loaded.team.projectLead && loaded.team.inProject === team.inProject) out.push(loaded.team.project);
  }
  return out;
}

/**
 * A `delivery_order` declaration in `.agents/team.yaml` (at the team or seat level) that
 * `resolveOrderSetting` sets aside because it names a leg the inherited order does not have,
 * leaving the inherited order in force (`src/settings/inherit.ts`, output contract §1.5 scene D4).
 * `native`, `socket`, `headless-resume` and `session` are legs a word may add, so a declaration
 * naming any of them is no difference. The retired `mcp-inbox` alias is dropped before the
 * resolver ever judges a word (`liveOrderRecord`), so a word naming it — alone or beside live
 * legs — is never a set-aside; the word is named in a note instead
 * (`deliveryOrderInboxNotes`).
 */
function deliveryOrderDifferences(team: TeamFile, root: string, home: string | undefined): Difference[] {
  let projectOrder: readonly OrderWord[] | undefined;
  let signedTeamOrder = false;
  if (home !== undefined) {
    try {
      projectOrder = ofTeam(home, teamIdOf(root))?.deliveryOrder;
    } catch {
      projectOrder = undefined;
    }
    const teamSource = readTeamPolicySource(home, root, team);
    if (teamSource.ok && teamSource.policies.some((p) => p.name === 'delivery-order' && p.setter === 'owner')) {
      signedTeamOrder = true;
    }
  }
  const out: Difference[] = [];
  if (team.deliveryOrder !== null && !signedTeamOrder) {
    const res = resolveOrderSetting(
      DELIVERY_ORDER,
      orderDeclarationsOf(liveOrderRecord({
        ...(projectOrder !== undefined ? { project: projectOrder } : {}),
        team: team.deliveryOrder,
      })),
    );
    if (res.refused.some((r) => r.level === 'team')) {
      const extra = liveOrderWords(team.deliveryOrder).filter((leg) => !res.value.includes(leg)).length;
      out.push({
        what: `delivery_order [${team.deliveryOrder.join(', ')}] in team config is set aside; [${res.value.join(', ')}] stands`,
        repair: `drop the ${pluralCount(Math.max(1, extra), 'leg')} not in the inherited delivery_order in team config`,
      });
    }
  }
  for (const seat of team.seats) {
    if (seat.deliveryOrder === undefined) continue;
    // A human seat walks `drop` alone whatever its word says, so the resolver's set-aside verdict
    // never describes its delivery: human wins, and a word it writes is no difference.
    if (seat.human === true) continue;
    const res = resolveOrderSetting(
      DELIVERY_ORDER,
      orderDeclarationsOf(liveOrderRecord({
        ...(projectOrder !== undefined ? { project: projectOrder } : {}),
        ...(!signedTeamOrder && team.deliveryOrder ? { team: team.deliveryOrder } : {}),
        seat: seat.deliveryOrder,
      })),
    );
    if (res.refused.some((r) => r.level === 'seat')) {
      const extra = liveOrderWords(seat.deliveryOrder).filter((leg) => !res.value.includes(leg)).length;
      out.push({
        what: `${seat.name}: delivery_order [${seat.deliveryOrder.join(', ')}] in team config is set aside; [${res.value.join(', ')}] stands`,
        repair: `drop the ${pluralCount(Math.max(1, extra), 'leg')} not in the inherited delivery_order for ${seat.name} in team config`,
      });
    }
  }
  return out;
}

/**
 * Whether the launch line runs the CLI through something other than the CLI's own program word:
 * a wrapper script, or a nested shell this build hands its generated settings to at the end of
 * the line. A line whose program word is the profile's binary is the CLI itself, and a
 * human-launched line that carries no settings is read as such — never as a wrapper's missing
 * file. A profile this build does not know (or a line naming no word) is no wrapper.
 */
function wrapperLaunch(cli: string, launch: string): boolean {
  const binary = profileFor(cli)?.binary;
  if (binary === undefined) return false;
  const words = launchWords(launch);
  let at = 0;
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? '')) at += 1;
  if (words[at] === 'exec' || words[at] === 'command') at += 1;
  const program = words[at];
  return program !== undefined && (program.split('/').pop() ?? program) !== binary;
}

/**
 * A `delivery_order` word in `.agents/team.yaml` — the team's own, or a seat's — that names
 * `mcp-inbox`, once per team and once per seat that names it. The name is no longer a leg: the
 * MCP inbox is the store's reader, like `team drops --read`, and a push from its server is not a
 * wake (ADR D1, `src/send/walk-cascade.ts`). A word that still names it is read as an alias and
 * dropped from the order — never an error, never a set-aside, and the walk never sees it
 * (`liveOrderRecord` drops it before the resolver). The note asks for the word's removal, so
 * the name can leave the files; the word changes no leg the walk travels, so it is not a
 * difference and the exit stays as it is.
 */
function deliveryOrderInboxNotes(team: TeamFile): string[] {
  const notes: string[] = [];
  if (team.deliveryOrder !== null && team.deliveryOrder.includes('mcp-inbox')) {
    notes.push(
      `delivery_order [${team.deliveryOrder.join(', ')}] in team config names mcp-inbox, which is no longer a leg; remove it`,
    );
  }
  for (const seat of team.seats) {
    if (seat.deliveryOrder === undefined || !seat.deliveryOrder.includes('mcp-inbox')) continue;
    notes.push(
      `${seat.name}: delivery_order [${seat.deliveryOrder.join(', ')}] in team config names mcp-inbox, which is no longer a leg; remove it`,
    );
  }
  return notes;
}

/**
 * A seat whose chain declares `messaging.store: none`: its sends keep no copy, and the note
 * names exactly what that gives up. The word is a choice, never a fault — the walk still works
 * through the legs that carry the body themselves, and a socket frame still carries the signed
 * record's bytes, which a receiver verifies as it would the folder copy. What the copy would
 * have carried is gone: the retry, the unread re-wake, the read receipt and the `queued, not
 * woken` flag. A person's pane is reached by the stored copy alone, so a send to a human seat
 * under `none` is refused, and the note says that instead. Notes only, never a difference. A
 * chain that cannot be read says nothing here: the policy and registry readings name that once.
 */
function messagingStoreNotes(team: TeamFile, root: string, home: string | undefined, now: Date): string[] {
  if (home === undefined) return [];
  let agentOf: (seat: string) => Agent | null;
  try {
    agentOf = seatRecordsOf(home, root, team);
  } catch {
    return [];
  }
  const notes: string[] = [];
  for (const seat of team.seats) {
    let record: Agent | null;
    try {
      record = agentOf(seat.name);
    } catch {
      continue;
    }
    let store: MessagingStore;
    let source: SettingLevel | null;
    try {
      const resolved = messagingStoreChainOf({
        root,
        seat: seat.name,
        agentId: record?.id ?? null,
        home,
        file: team,
        projectOfTeam: (id) => ofTeam(home, id),
        now,
      });
      store = resolved.value;
      source = resolved.source;
    } catch {
      continue;
    }
    if (store !== 'none') continue;
    const by = source === null ? '' : ` by the ${source}`;
    const overrides = resolveSeatOverrides({ home, root, seat: seat.name });
    const human = (overrides.ok ? overrides.overrides.human : undefined) ?? (seat.human === true);
    notes.push(
      human
        ? `${seat.name}: messaging.store is none${by}; a person's pane is reached by the stored copy alone, so a send to this seat is refused`
        : `${seat.name}: messaging.store is none${by}; its sends keep no copy — the frame still carries the signed record's bytes and a receiver verifies them, but the retry, the unread re-wake, the read receipt and the "queued, not woken" flag are given up`,
    );
  }
  return notes;
}

/**
 * Every live Claude seat whose profile promises a push delivery but whose socket leg a send
 * would skip, one line per seat in the send's own words, with the act that fixes it.
 *
 * The reading is the send's, never a second one: the gate is `socketIneligibleReason` and the
 * address choice is `socketAddressOf`, both behind `socketLegOf` (the same reading `team status`
 * prints), and the walk is the send's own chain — a declared order that names neither `socket`
 * nor the `typed` wake word chose its routes, and the check calls no choice a skip. Only a pane
 * that still holds the seat is read (`paneShowsSeat`, the gate `compare()` applies): a CLI that
 * ended in a retained pane is named once by the comparison and gains no line here. A seat that
 * opts out in the team file (`inbound` other than accept), a human's pane, and a seat woken
 * through its runtime queue or its push channel keep no promise the socket would keep: none is
 * named. The class reads the same held-frame mark and makes the same address choice as the leg
 * below, so a push class it supplies is that leg's own reading, not a second one that could
 * disagree.
 *
 * The class here holds the pane's processes, so it can call a seat wakeable on a socket only
 * those processes prove. Every reader that holds no pane — a send's own class line
 * (`deliveryWordsOf`), `team plan`, the seat's `team next` — reads the same class without them
 * and sees that seat pull-only, so the missing address is named too: its agent record holds no
 * address, and `team up` records it from the pane without a restart (a record that names no
 * process is `team register`'s read, the same split `team up` itself makes).
 *
 * Five reasons are the team's to fix and each is a difference, like an unread drop — one line
 * per seat, the repair named, exit 1:
 *   - the team file neither accepts the frame nor was the declaration generated by this build's
 *     launch: one team-config word admits the route;
 *   - the team file accepts the frame, but the launch's effective settings do not declare
 *     accept: this one is read before the address, for every seat, because a session whose
 *     settings never declared accept is why no socket serves it. The repair follows the source:
 *     a relaunch rewrites this build's generated file, a wrapper's own settings are the seat's
 *     to change first, and a wrapper launch with none gains the generated file from a relaunch;
 *   - the seat's box held a frame its declaration has not been re-confirmed since: a restart
 *     re-confirms it;
 *   - a live seat wakeable only through the socket its pane's processes carry, whose agent
 *     record holds no address: `team up` records the address from the pane the check read, and
 *     a record that names no launch identity is `team register`'s. A record whose pane runs a
 *     process its launch did not start is neither's to re-point — `team register` refuses that
 *     pane, and `team up` records no address over it. When the registry binds the conversation
 *     herdr reports for that pane, the seat is restored and `team up` is still the whole
 *     repair: its own plan adopts the process in place and records the address in one run, so
 *     no restart is named and the load never enters. Without that binding the pane holds a
 *     process no command can tie to the record, and the line names the `--abandon` restart —
 *     it starts the seat fresh, leaving the recorded conversation behind, records the address
 *     itself, and is refused while the load is above the file's limit (`machine.load_start`,
 *     per core), which the line names. Two state records naming one pane are named once, for
 *     the pane — every seat in that dispute would otherwise get a binding repair pointing at
 *     another seat's process; `team down`, then `team up` rewrites the recorded panes;
 *   - the socket predates the settings that declare accept: a restart writes one that does not,
 *     and the line names the load that can refuse it (`machine.load_start`, per core).
 * Otherwise a socket that is nowhere is its class's ordinary state, not a broken promise:
 * absence wins over any gate, and the seat gets a note naming its class, so the exit does not
 * change.
 */
function socketSkippedDeliveries(
  team: TeamFile,
  state: SessionState,
  live: Live,
  root: string,
  dir: string,
  session: string,
  home: string | undefined,
  sockets: string | readonly string[],
  now: Date,
  continuityIds?: ReadonlyMap<string, string | null>,
): { differences: Difference[]; notes: string[] } {
  const differences: Difference[] = [];
  const notes: string[] = [];
  // A build without the socket leg would name every seat, and no one could fix it from a file.
  if (!SOCKET_SEND || home === undefined) return { differences, notes };
  let agentOf: (seat: string) => Agent | null;
  try {
    agentOf = seatRecordsOf(home, root, team);
  } catch {
    // The registry that cannot be read is named by `registryDifferences` once; a reading that
    // leans on it names nothing more.
    return { differences, notes };
  }
  // Every pane a declared, non-human seat's record claims, once per pane: a pane is one seat's,
  // and two records naming it cannot both be written from what the pane proves — a send that
  // dialed its socket would wake whatever process the pane holds, not necessarily the seat the
  // record names. The file is the truth here as it is everywhere in this check: only a seat the
  // team still declares claims a pane.
  const claims = new Map<string, string[]>();
  for (const seat of team.seats) {
    if (seat.human === true) continue;
    const pane = state.seats[seat.name]?.pane;
    if (pane === undefined || pane === '') continue;
    const claim = claims.get(pane);
    if (claim === undefined) claims.set(pane, [seat.name]);
    else claim.push(seat.name);
  }
  const disputed = new Set<string>();
  for (const seat of team.seats) {
    if (seat.human === true) continue;
    const recorded = state.seats[seat.name];
    if (recorded?.stage !== 'ready') continue;
    const listed = live.agents.find((candidate) => candidate.name === seat.name);
    if (listed === undefined || listed.pane !== recorded.pane) continue;
    // Only a pane that still holds the seat is read, the gate the comparison and the
    // held-prompt reading both apply: a CLI that ended in a retained pane is named once, in the
    // comparison's own line, and a process team did not launch is not read for a skipped socket.
    if (!paneShowsSeat(recorded, listed, live, continuitySessionOf(continuityIds, seat.name, recorded.agent_session))) continue;
    // Two seats claiming one pane is no missing address a command can write: every seat in the
    // dispute would get the same binding repair, each pointing at the other's process, and
    // `team register` refuses both (the pane is taken, or the record names another pane —
    // src/commands/register.ts). The dispute is named once, for the pane, and none of its seats
    // gets an address line: a stop and a start rewrite the recorded panes from the file, the
    // one route that clears a record holding the wrong pane.
    const claim = claims.get(recorded.pane);
    if (claim !== undefined && claim.length > 1) {
      if (!disputed.has(recorded.pane)) {
        disputed.add(recorded.pane);
        differences.push({
          what: `${claim.join(', ')}: one pane is recorded for more than one seat: their state records all name ${recorded.pane}, and a pane is one seat's — a send that dialed its socket would wake whichever process the pane holds, not the seat it names`,
          repair: 'team down, then team up',
          needs: 'approve',
        });
      }
      continue;
    }
    let record: Agent | null;
    try {
      record = agentOf(seat.name);
    } catch {
      // A registry that does not read names no record: the same silence `registryDifferences`
      // keeps for the seat, never a finding read off half a store.
      continue;
    }
    // The class the seat's own launch left, from the one reader of it, with the pane's processes
    // and this check's own sockets folders: a recorded socket the pane no longer carries is no
    // push class here either, the same proof the send's leg below makes.
    const delivery = seatDeliveryClass({
      dir, root, session, seat: seat.name, declared: seat, state: recorded, home,
      processes: live.processes?.[listed.pane] ?? null,
      sockets,
    });
    // Only the CLI whose profile declares push is read: a seat that never promised a socket is
    // not falling short of one.
    if (delivery.evidence.declared !== 'push') continue;
    // An explicit opt-out in the team file is the team's choice, not a skipped socket; a human's
    // signed settings say the same for its pane.
    if (seat.inbound !== undefined && seat.inbound !== 'accept') continue;
    const overrides = resolveSeatOverrides({ home, root, seat: seat.name });
    if (!overrides.ok || overrides.overrides.human === true) continue;
    // The class a send measures is this same reader with no pane in hand: a send's own class
    // line (`deliveryWordsOf`), `team plan` and the seat's `team next` hold no processes, so a
    // socket only this check's pane reading proves is no socket there. That split is the one a
    // missing address makes, and it is repairable without a restart: the pane already carries
    // the socket, and the launch that should have recorded it is `team up`'s own write — a
    // record that names no launch identity, or one the pane no longer holds, is `team
    // register`'s read, the same split `team up` itself makes. A seat the registry holds no
    // record of is not named: a plain-name send is refused before any leg, and the roster
    // difference names it.
    const withoutPane = seatDeliveryClass({
      dir, root, session, seat: seat.name, declared: seat, state: recorded, home, sockets,
    });
    // A seat the class proves can be woken while it is idle keeps the promise without a socket:
    // its runtime queue, its push channel, or — when the record carries it — the socket this leg
    // would dial. The class reads the same held-frame mark and the same address choice the leg
    // does, so its word and the leg's cannot split.
    if (wakeableWhileIdle(delivery.class)) {
      if (!wakeableWhileIdle(withoutPane.class) && record !== null) {
        const processes = live.processes?.[listed.pane] ?? null;
        const verdict = seatProcessVerdict(recorded.launched, processes);
        // The address is written only over a process a command can prove: `team up` records one
        // on the record it finds, and `team register` refreshes a record whose launch it still
        // finds in front — it refuses a pane holding another process, so it is never the repair
        // for one (src/commands/register.ts). A replaced process whose pane herdr reports under
        // the conversation the registry binds is the restored seat: `team up`'s own plan adopts
        // that process in place — its restored step writes the new launch identity before its
        // address pass reads the pane — and records the address in the same run, so the line
        // names `team up` and nothing else: no restart, and the load never enters. Without that
        // binding the pane holds a process no command can tie to the record, and the restart
        // that abandons it and starts the seat fresh is the repair; it records the address
        // itself (`refreshAgentAddress`, src/commands/restart.ts), so no `team up` follows it,
        // and it refuses while the load is above the file's limit, which the line names.
        const bound = recordedSeatContinuity({
          home, root, herdrSession: session, seat: { name: seat.name, cli: seat.cli }, state: recorded,
        });
        const restored = bound.kind === 'bound'
          && bound.recorded.launch !== ''
          && listed.session !== undefined && listed.session !== ''
          && listed.session === bound.recorded.sessionId;
        const what = `${seat.name}: a reader without its pane sees ${withoutPane.class}, not ${delivery.class}: only the socket its pane's processes carry proves it, and its agent record holds no address this session can dial`;
        if (verdict === 'replaced') {
          differences.push(restored
            ? { what, repair: 'team up' }
            : {
                what: `${what}; the process in its pane is not the one its record's launch started, and the record's conversation is not the one herdr reports there, so the repair starts the seat fresh: it abandons that process, leaving the recorded conversation behind, and is refused while the load is above ${team.machine.loadStart} per core (machine.load_start)`,
                repair: `team restart ${seat.name} --abandon`,
                // `team restart` refuses while the file's approval is not in force
                // (src/commands/restart.ts).
                needs: 'approve',
              });
        } else {
          differences.push({
            what,
            // `team up` records an address on the record it finds; a record that names another
            // session, or no process, is `team register`'s to re-point from the pane.
            repair: record.reach.session === session && verdict === 'same'
              ? 'team up'
              : `team register ${seat.name}`,
          });
        }
      }
      continue;
    }
    let order: readonly DeliveryLeg[];
    let declaredOrder: boolean;
    try {
      const chain = deliveryChainOf({
        root,
        seat: seat.name,
        home,
        file: team,
        projectOfTeam: (id) => ofTeam(home, id),
        overrides: overrides.overrides,
        now,
      });
      order = deliveryOrder(chain);
      declaredOrder = Object.values(chain).some((word) => word !== undefined && word.length > 0);
    } catch {
      // A project registry or policy record this reader cannot read is named once by
      // `registryDifferences`; this seat's socket reading never guesses an order around it.
      continue;
    }
    // A declared order that names neither the socket nor `typed` — whose wake the socket stands
    // in for — keeps the socket out by its own words: a configuration choice, never a finding.
    if (declaredOrder && !order.includes('socket') && !order.includes('typed')) continue;
    const leg = socketLegOf({
      seat: seat.name,
      declared: seat,
      agent: record,
      processes: live.processes?.[listed.pane] ?? null,
      dir,
      root,
      session,
      sockets,
    });
    // The team file accepts the frame, but the launch's effective settings do not: the running
    // CLI holds every frame, which is why no socket in the class can serve the seat. Named here,
    // before the address is read and for every seat, so the absence the mismatch causes never
    // reads as the class's ordinary state. The effective source decides the repair: this build's
    // generated file is rewritten from the team's word by a relaunch; a wrapper's own settings
    // are the seat's to change first; a wrapper launch with no settings at all gains this
    // build's generated file from a relaunch. A launch the build never attested and that carries
    // no settings of its own is the human-launched shape the send names as such — its owner's
    // CLI settings are not read, and the absence stays that seat's ordinary state, noted below.
    if (seat.inbound === 'accept' && leg.declaration.policy !== 'accept') {
      if (leg.declaration.generated === true) {
        differences.push({
          what: `${seat.name}: sends go to its drop folder, not its socket: its launch-effective generated settings do not declare crossSessionInbound accept, though its team file declares inbound accept`,
          repair: `team restart ${seat.name}`,
          needs: 'approve',
        });
        continue;
      }
      if (leg.declaration.source !== null) {
        const where = leg.declaration.source === root ? "its launch line's own --settings" : leg.declaration.source;
        differences.push({
          what: `${seat.name}: sends go to its drop folder, not its socket: its launch-effective settings (${where}) do not declare crossSessionInbound accept, though its team file declares inbound accept`,
          repair: `declare crossSessionInbound accept in ${where}, or drop the launch's own --settings so this build's generated settings carry the team's word, then team restart ${seat.name}`,
          needs: 'approve',
        });
        continue;
      }
      if (wrapperLaunch(seat.cli, seat.launch)) {
        differences.push({
          what: `${seat.name}: sends go to its drop folder, not its socket: its launch carries no setting that declares crossSessionInbound accept, though its team file declares inbound accept`,
          repair: `team restart ${seat.name}`,
          needs: 'approve',
        });
        continue;
      }
    }
    // A socket that is nowhere is the ordinary state of the seat's class, whatever its gate
    // would say: absence wins, and the note names the class without changing the exit. The
    // sentence after the class is the class's own (`deliveryWords`), so a note and a send's
    // console line can never promise different things about who gives the seat a turn.
    if (leg.address === null || leg.address.kind !== 'path') {
      const waits = delivery.words.replace(/^queued; /, '');
      notes.push(`${seat.name}: no cross-session socket is live, so sends go to its drop folder; its delivery class is ${delivery.class} — ${waits}`);
      continue;
    }
    if (leg.gate !== null) {
      if (!socketEligible(seat.inbound, leg.declaration)) {
        // The one refusal a team-file word fixes: the launch's effective settings declare
        // accept, but this build did not generate them, so the team's own consent is missing.
        if (seat.inbound === undefined && leg.declaration.generated !== true && leg.declaration.policy === 'accept') {
          differences.push({
            what: `${seat.name}: sends go to its drop folder, not its socket: ${leg.gate}`,
            repair: `team config set seats.${seat.name}.inbound accept`,
          });
        }
        continue;
      }
      // Eligible and refused: the box held a frame, and only a restart re-confirms it.
      if (leg.held !== null) {
        differences.push({
          what: `${seat.name}: sends go to its drop folder, not its socket: ${leg.gate}`,
          repair: `team restart ${seat.name}`,
          needs: 'approve',
        });
      }
      continue;
    }
    // Eligible, and the address a send would dial, but the running session predates the settings
    // that declare it accepts: a frame sent there would be held. The restart is the only repair
    // — the declaration is newer than the socket — and it is the one the load can refuse, so the
    // line names that limit beside the repair.
    if (!leg.live) {
      differences.push({
        what: `${seat.name}: sends go to its drop folder, not its socket: the socket predates the settings that declare it accepts; a restart re-reads them, and a restart is refused while the load is above ${team.machine.loadStart} per core (machine.load_start)`,
        repair: `team restart ${seat.name}`,
        needs: 'approve',
      });
    }
  }
  return { differences, notes };
}

/**
 * One difference per attention, in the watch's own words (`src/watch/checks/attention.ts`): the
 * repair is the one act the report names, and `owner` is the watch's `to`, an owner's report only.
 * A seat that is idle or done on an unrecognised screen (`attention === 'unknown'`) is a normal
 * state, never a difference; an unrecognised herdr status word is surfaced as a note by
 * `unknownStatusNotes` instead.
 */
function viewOf(attention: Attention, name: string, _status: string): Difference | null {
  switch (attention) {
    // A permission or trust screen never reaches here: `compare()` emits its row, and the check
    // replaces that row with its own stuck-prompt line (`attentionDifferences`).
    case 'question':
      return { what: `${name} asked a question: the operator's to act on`, repair: 'the operator acts in the pane' };
    case 'plan approval':
      return { what: `${name} waits at a plan approval prompt: the operator's to act on`, repair: 'the operator acts in the pane' };
    case 'confirmation':
      return { what: `${name} waits at a confirmation prompt: the operator's to act on`, repair: 'the operator acts in the pane' };
    case 'vendor notice':
      return { what: `${name} shows a vendor notice: its owner's to act on`, repair: 'the owner acts in the pane', owner: true };
    case 'blocked':
      return { what: `${name} is blocked, and its screen is not one the watch recognises`, repair: 'the owner looks at the pane', owner: true };
    default:
      return null;
  }
}

/**
 * A note for a running seat whose CLI registers its inbox in a project file, and whose folder
 * holds no such registration: that seat's inbox leg is gone, and no other line says so. The file
 * read is the one the profile's route writes, in the folder the seat's launch started in. A
 * seat whose launch folder is not recorded, and a profile whose registration lives on the launch
 * line rather than in a file, are not readable this way and say nothing.
 */
function inboxRegistrationNotes(team: TeamFile, state: SessionState, live: Live): string[] {
  const out: string[] = [];
  for (const seat of team.seats) {
    if (seat.human === true) continue;
    const recorded = state.seats[seat.name];
    if (recorded?.stage !== 'ready' || recorded.start_cwd === undefined) continue;
    const agent = live.agents.find((candidate) => candidate.name === seat.name);
    if (agent === undefined || agent.pane !== recorded.pane) continue;
    const read = inboxRegistration(recorded.cli ?? seat.cli, recorded.start_cwd);
    if (read === null || read.registered) continue;
    out.push(`${seat.name}: its CLI registers a team inbox in ${read.target}, and ${join(recorded.start_cwd, read.target)} holds none: sends wait in its drop folder; team reload ${seat.name} registers it`);
  }
  return out;
}

/**
 * A note for any seat on its recorded pane whose herdr status is not one of the known words
 * (`idle`, `done`, `working`, `blocked`). An `idle` or `done` seat is a normal state even when its
 * screen is unrecognised, and an unknown herdr status word is reported as a note so it does not
 * count as a difference or change the exit code.
 */
function unknownStatusNotes(team: TeamFile, state: SessionState, live: Live): string[] {
  const out: string[] = [];
  for (const seat of team.seats) {
    const recorded = state.seats[seat.name]?.pane;
    if (recorded === undefined) continue;
    const agent = live.agents.find((candidate) => candidate.name === seat.name);
    if (!agent || agent.pane !== recorded) continue;
    // A profile herdr cannot report is read from its own screen: a screen it reads is the word,
    // and herdr's `unknown` beside it is not a note. A screen no profile reads leaves the note.
    if (herdrUnreliable(seat.cli) && readScreen(seat.cli, live.screens[recorded]).kind !== 'unknown') continue;
    if (
      agent.status !== '' &&
      agent.status !== 'idle' &&
      agent.status !== 'done' &&
      agent.status !== 'working' &&
      agent.status !== 'blocked'
    ) {
      out.push(`${seat.name}: herdr reports the status "${agent.status}"`);
    }
  }
  return out;
}

// `status`'s own problem lines, in the check's name.
function printProblems(io: Io, problems: Problem[]): void {
  for (const problem of problems) {
    io.stderr(`team check: ${problem.line ? `team config line ${problem.line}: ` : ''}${problem.message}\n`);
  }
}

/**
 * The repair command for a deprecated field warning in `current.warnings` (`coordinator:`,
 * `watch.quota_marks`, `budgets.marks`). Non-deprecation warnings (such as `effort`) return
 * `undefined` so `team check` emits only deprecation warnings.
 */
function deprecationRepairOf(message: string, shownFile: string): string | undefined {
  if (message.startsWith('`coordinator:` is now `leads: true`')) {
    return `set \`leads: true\` on the lead's seat and remove \`coordinator:\` from ${shownFile}`;
  }
  if (message.startsWith('watch.quota_marks is now budgets.marks')) {
    return `move \`watch.quota_marks\` to \`budgets.marks\` in ${shownFile}`;
  }
  if (message.startsWith('budgets.marks replaces watch.quota_marks')) {
    return `remove \`watch.quota_marks\` from ${shownFile} and keep \`budgets.marks\``;
  }
  return undefined;
}

function policyRefusalRepair(refusal: PolicyLoadRefusal, seatName?: string): string {
  if ((refusal.kind === 'loosening' || refusal.kind === 'invalid-policy') && refusal.unsigned === true) {
    if (seatName) {
      return `remove or narrow delivery_order for ${seatName} in team config`;
    }
    return 'remove or narrow delivery_order in team config';
  }
  const seatFlag = seatName ? ` --seat ${seatName}` : '';
  if (refusal.kind === 'loosening') {
    return `team policy unset ${refusal.lowerLevel} ${refusal.policy}${seatFlag}`;
  }
  if (refusal.kind === 'invalid-policy') {
    return `team policy unset ${refusal.level} ${refusal.policy}${seatFlag}`;
  }
  const match = /policy "([^"]+)"/.exec(refusal.why);
  if (match?.[1]) {
    return `team policy unset ${refusal.level} ${match[1]}${seatFlag}`;
  }
  return `team policy unset ${refusal.level} <name>${seatFlag}`;
}

/** The dry-run an owner runs first for an entity whose owner-reply endpoint is missing or expired. */
function ownerReplyDifferences(
  team: TeamFile,
  root: string,
  home: string | undefined,
  now: Date,
): Difference[] {
  if (home === undefined) return [];
  const lead = team.orchestrator.trim();
  if (lead === '') return [];
  const found = resolveOwnerReplyTo(root, home, team.entity ?? null, now);
  if (found.ok || found.reason !== 'missing' || found.entity === null) return [];
  const target = `${lead}@${team.project}`;
  if (parseOwnerReplyToValue(target) === null) return [];
  return [{
    what: found.why,
    repair: `team policy set entity owner-reply-to ${target} --entity ${found.entity} --dry-run`,
    owner: true,
  }];
}

/**
 * Policy chain verification and `dev-mode` migration notice (Kernel Amendment 02, Gap 6 & Gap 7):
 * - Reads and resolves the policy chain (`entity → project → team`, plus each registered `seat`).
 * - Any unreadable/unverified source, invalid policy, or load-time loosening refusal is reported
 *   as an owner difference with a `team policy unset` repair (or, when the loosening declaration
 *   is an unsigned legacy field in `.agents/team.yaml`, a lead file-edit repair).
 * - When a signed policy entry shadows a legacy `delivery_order:` line in the same file, emits a
 *   note naming the shadowed line so `team policy unset` does not silently bring it back.
 * - While no `dev-mode` policy is set in the chain (`devModeGoverned === false`) and
 *   `TEAMCLI_DEV_MODE=1` is set in the environment, emits the one migration note.
 */
function policyCheck(
  team: TeamFile,
  root: string,
  home: string | undefined,
  now: Date,
  env: Record<string, string | undefined>,
  stateDir: string,
  caller: string,
): { differences: Difference[]; notes: string[] } {
  if (home === undefined) {
    const notes =
      env.TEAMCLI_DEV_MODE === '1'
        ? ['dev-mode: no policy is set yet for this entity; TEAMCLI_DEV_MODE=1 still applies until the owner sets dev-mode']
        : [];
    return { differences: [], notes };
  }

  // The machine record stands above the chain and the variable; when it is present — verified
  // or refused — the legacy dev-mode notes below describe a source no gate reads any more.
  const machine = readDevelopmentMode(home);

  let projectId: string | null = null;
  let legacyProjectDeliveryOrder: readonly OrderWord[] | undefined;
  try {
    const byTeam = ofTeam(home, teamIdOf(root));
    if (byTeam) {
      projectId = byTeam.id ?? null;
      legacyProjectDeliveryOrder = byTeam.deliveryOrder;
    } else if (team.inProject) {
      const proj = byName(home, team.inProject);
      projectId = proj?.id ?? projectIdOf(team.inProject);
      legacyProjectDeliveryOrder = proj?.deliveryOrder;
    } else {
      projectId = projectIdOf(team.project);
    }
  } catch {
    projectId = null;
  }

  const legacyDeliveryDiffs = deliveryOrderDifferences(team, root, home);
  const differences: Difference[] = [];
  const notes: string[] = [];
  const machineNote = developmentModeNote(machine);
  if (machineNote !== null) notes.push(machineNote);

  const projectSource = readProjectPolicySource(home, projectId);
  if (
    projectSource.ok &&
    projectSource.policies.some((p) => p.name === 'delivery-order' && p.setter === 'owner') &&
    legacyProjectDeliveryOrder !== undefined
  ) {
    notes.push(
      `delivery_order [${legacyProjectDeliveryOrder.join(', ')}] in ~/.config/team/projects.yaml is shadowed by the signed project delivery-order policy; remove delivery_order from ~/.config/team/projects.yaml so team policy unset does not bring it back`,
    );
  }

  const teamSource = readTeamPolicySource(home, root, team);
  if (
    teamSource.ok &&
    teamSource.policies.some((p) => p.name === 'delivery-order' && p.setter === 'owner') &&
    team.deliveryOrder !== null
  ) {
    notes.push(
      `delivery_order [${team.deliveryOrder.join(', ')}] in team config is shadowed by the signed team delivery-order policy; remove delivery_order from team config so team policy unset does not bring it back`,
    );
  }

  const teamChain = loadAndResolvePolicyChain(
    {
      home,
      entity: team.entity ?? null,
      projectId,
      teamRoot: root,
      team,
    },
    { now, upToLevel: 'team' },
  );

  if (!teamChain.ok) {
    for (const refusal of teamChain.refusals) {
      if (
        refusal.kind === 'loosening' &&
        refusal.policy === 'delivery-order' &&
        refusal.lowerLevel === 'team' &&
        legacyDeliveryDiffs.some((d) => d.what.startsWith('delivery_order '))
      ) {
        continue;
      }
      if (
        (refusal.kind === 'loosening' || refusal.kind === 'invalid-policy') &&
        refusal.policy.startsWith('router.')
      ) {
        // The router's own reader re-judges its words below, naming the rule each one broke.
        continue;
      }
      const isUnsigned =
        (refusal.kind === 'loosening' || refusal.kind === 'invalid-policy') && refusal.unsigned === true;
      differences.push({
        what: refusal.message,
        repair: policyRefusalRepair(refusal),
        ...(isUnsigned ? {} : { owner: true }),
      });
    }
  }

  // The router's three words are re-read by their own reader: their rules span words (a team may
  // add an alias for its own seats but never retarget one the entity places, and an entity
  // alias's fallback belongs to the entity alone), which the chain's ordering cannot name. Each
  // problem names the level whose word broke the rule, so each difference carries its own
  // `team policy unset` repair. A seat may not set these words at all, so the seat chains above
  // keep refusing one found there.
  for (const problem of mailboxRouterPolicyProblems(root, home, now, team)) {
    differences.push({
      what: problem.why,
      repair: `team policy unset ${problem.level} ${problem.name}`,
      owner: true,
    });
  }

  const teamId = teamIdOf(root);
  for (const seat of team.seats) {
    let agentId: string | null = null;
    try {
      agentId = findAgent(home, { team: teamId, seat: seat.name })?.id ?? null;
    } catch {
      agentId = null;
    }
    if (!agentId && seat.deliveryOrder === undefined) continue;
    const seatSource = readSeatPolicySource(home, agentId, seat);
    if (
      seatSource.ok &&
      seatSource.policies.some((p) => p.name === 'delivery-order' && p.setter === 'owner') &&
      seat.deliveryOrder !== undefined
    ) {
      notes.push(
        `${seat.name}: delivery_order [${seat.deliveryOrder.join(', ')}] in team config is shadowed by the signed seat delivery-order policy; remove delivery_order for ${seat.name} from team config so team policy unset does not bring it back`,
      );
    }
    const seatChain = loadAndResolvePolicyChain(
      {
        home,
        entity: team.entity ?? null,
        projectId,
        teamRoot: root,
        team,
        agentId,
        seat,
      },
      { now, upToLevel: 'seat' },
    );
    if (!seatChain.ok) {
      for (const refusal of seatChain.refusals) {
        const isSeatRefusal =
          (refusal.kind === 'loosening' && refusal.lowerLevel === 'seat') ||
          ((refusal.kind === 'unreadable-source' || refusal.kind === 'invalid-policy') && refusal.level === 'seat');
        if (!isSeatRefusal) continue;
        if (
          refusal.kind === 'loosening' &&
          refusal.policy === 'delivery-order' &&
          legacyDeliveryDiffs.some((d) => d.what.startsWith(`${seat.name}: delivery_order `))
        ) {
          continue;
        }
        const isUnsigned =
          (refusal.kind === 'loosening' || refusal.kind === 'invalid-policy') && refusal.unsigned === true;
        differences.push({
          what: `${seat.name}: ${refusal.message}`,
          repair: policyRefusalRepair(refusal, seat.name),
          ...(isUnsigned ? {} : { owner: true }),
        });
      }
    }
  }

  const expiredDevMode = teamChain.expired.filter((exp) => exp.name === 'dev-mode').at(-1);
  if (machine.kind === 'absent' && expiredDevMode && (!teamChain.ok || teamChain.policies['dev-mode']?.value === 'off')) {
    notes.push(`dev-mode expired at ${expiredDevMode.expiry ?? 'now'} for ${expiredDevMode.level}; off since`);
  }
  if (env.TEAMCLI_DEV_MODE === '1') {
    if (machine.kind === 'refused') {
      logLine(stateDir, 'check', caller, 'dev-mode: TEAMCLI_DEV_MODE=1 ignored because the machine setting cannot be read', now);
    } else if (machine.kind === 'set') {
      if (machine.record.mode !== 'local-fast') {
        logLine(stateDir, 'check', caller, `dev-mode: TEAMCLI_DEV_MODE=1 ignored because development-mode is ${machine.record.mode} at machine level`, now);
      }
    } else if (!teamChain.devModeGoverned) {
      notes.push(
        'dev-mode: no policy is set yet for this entity; TEAMCLI_DEV_MODE=1 still applies until the owner sets dev-mode',
      );
    } else if (teamChain.ok && teamChain.policies['dev-mode']?.value === 'off') {
      logLine(stateDir, 'check', caller, 'dev-mode: TEAMCLI_DEV_MODE=1 ignored because dev-mode policy is off', now);
    }
  }

  if (teamChain.ok) {
    const pretrust = teamChain.policies.pretrust?.value;
    if (pretrust === 'off' || pretrust === 'project') notes.push(`pretrust: ${pretrust}`);
    const admission = teamChain.policies['first-run-admission']?.value;
    if (admission === 'off' || admission === 'empty-account') notes.push(`first-run-admission: ${admission}`);
  }

  return { differences, notes };
}

/**
 * The entity's model rule over this team's file (Policies rule 10). Every breaching seat of the
 * team this check runs in is one difference, repaired with `team swap queue <seat>`: the same
 * breach list `team swap --rule` prints, narrowed to this team. The line names the rule, the
 * seat's vendor and the swap proposed — or why none is. A rule that cannot be read is a note and
 * never an empty rule: an unreadable rule must not read every seat as in rule.
 *
 * The repair is the lead's: `team swap queue` is queued by the orchestrator's or the operator's
 * seat, and the command is a grant scope in the permission map, so the difference carries its
 * actor rather than letting `whoOfDifference` read the repair as a grant holder's.
 */
function modelRuleCheck(
  team: TeamFile,
  root: string,
  home: string | undefined,
): { differences: Difference[]; notes: string[] } {
  if (home === undefined || team.entity === null) return { differences: [], notes: [] };
  let found: RuleLookup;
  try {
    found = listModelRuleBreaches({ home, team, root, teamId: teamIdOf(root) });
  } catch (error) {
    found = { ok: false, why: `the model rule cannot be read: ${(error as Error).message}` };
  }
  if (!found.ok) {
    return { differences: [], notes: [`the entity model rule cannot be read, so no breach is judged: ${found.why}`] };
  }
  const listing = found.listing;
  if (listing.rule === '') return { differences: [], notes: [] };
  const here = resolve(root);
  const differences: Difference[] = [];
  for (const breach of listing.breaches) {
    if (resolve(breach.root) !== here) continue;
    const action = breach.proposal
      ? `a swap to ${breach.proposal.recipe.cli} ${breach.proposal.recipe.model} ${breach.proposal.recipe.version} from ${breach.proposal.donor.team}/${breach.proposal.donor.seat} is proposed`
      : (breach.reason ?? 'no recipe is available');
    differences.push({
      what: `${breach.seat.name}: declares vendor ${breach.seat.vendor}, which the entity model rule ${listing.rule} refuses; ${action}`,
      repair: `team swap queue ${breach.seat.name}`,
      who: "the team's lead",
    });
  }
  return { differences, notes: [] };
}
