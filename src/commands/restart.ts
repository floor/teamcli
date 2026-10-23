import { chmodSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { auditClientRefusal, authorizeClientRun, clientFormProblem, verifyClientForm, type ClientRun } from '../client/client-form.ts';
import { KEY_ISOLATION_LINE } from '../client/records.ts';
import { stripSgr } from '../ansi.ts';
import { budgetsInForceOf, ceilingsOf, notInForce } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { seatBudget } from '../budgets/gate.ts';
import { loadReadings, loadSpendReadings } from '../budgets/readings.ts';
import {
  anotherPaneRefusal,
  describeCaller,
  detachedRefusal,
  fileOwnerRefusal,
  isOwner,
  judgeCallerIn,
  judgeCallerOf,
  noPaneRefusal,
  sessionOwnerRefusal,
  standingOf,
  walkCaller,
  type Caller,
  type SeatStanding,
} from '../caller.ts';
import { devModeCallerGate, devModeExpiryNote, devModeMark, logDevMode, logDevModeState, resolveDevMode, type DevModeRun } from '../dev_mode.ts';
import { gateVerdict } from '../permissions/who.ts';
import { forgetLaunchedPane, launchedTeamFile, noteLaunchedPane } from '../file/launched-file.ts';
import { loadTeamFile, placedProblems } from '../file/load.ts';
import { relaunchRepair } from '../file/sections/lead.ts';
import { displayAgent, workspaceLabel } from '../file/sections/seats.ts';
import type { Problem, Seat, TeamFile } from '../file/types.ts';
import {
  agentList,
  agentRename,
  agentStatus,
  paneForeground,
  paneForegroundCwd,
  paneProcesses,
  paneRead,
  paneRun,
  paneShellBack,
  pressEnter,
  reportDisplayAgent,
  sessionRunning,
  sessionState,
  startServer,
  typeText,
  workspaceClose,
  workspaceCreate,
  workspaceList,
  workspacePanes,
  type HerdrAgent,
} from '../herdr.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { boxHoldsText, deliverRules, fileRefusalOf, type Refusal } from '../launch/deliver.ts';
import { executePlan, type Host } from '../launch/execute.ts';
import { ensureCodexEndpoint, stopSeatCodexEndpoint } from '../launch/codex-endpoint.ts';
import { GENERAL_BRIEF_SHA256, currentBriefEpochs, deliverBriefForAttribution, walkBriefDeliveries } from '../launch/general-brief.ts';
import { installCliHooks, plannedCliHooks, resetCliHookState } from '../launch/cli-hook.ts';
import { launchedIdentity, replacedSeat, seatProcessVerdict } from '../launch/identity.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { formatPlan, upPlan, type DownSeat, type UpSeat } from '../launch/plan.ts';
import { progressWriter, type Progress } from '../launch/progress.ts';
import { rulesFileHash, rulesFileHolds, seatDeliveryOf, typeablePath, writeRulesFile } from '../launch/rules-file.ts';
import { rulesOf } from '../launch/rules.ts';
import { unreadAdvice, unreadIdle } from '../launch/unread.ts';
import { acquireRunLock, runLockText } from '../launch/run-lock.ts';
import { logLine } from '../log.ts';
import { registerInbox } from '../mcp/register.ts';
import { hasJsonFlag, planStepsOf, refuse, writeJson, type PlanStep } from '../output/index.ts';
import { captureDraft, pasteDraftBack, type DeliverHost } from '../send/deliver.ts';
import { dropMessage } from '../send/native.ts';
import { namedResumeTarget, resumeCarry, shellQuote } from '../profiles/profile.ts';
import { profileFor } from '../profiles/index.ts';
import { emptySession, mintSeatId, readState, updateState, type SeatState, type SessionState } from '../state.ts';
import { recordedSeatContinuity, recordedSeatSession } from '../registry/resume.ts';
import { registerEnd, registerLaunch } from '../registry/sync.ts';
import { beginSession } from '../sessions/registry.ts';
import { refreshAgentAddress } from '../send/address.ts';
import { modelDiffers, seatModel } from '../status/statusline.ts';
import { approvalStanding, type Ceilings, type Standing } from '../store/store.ts';
import { senderNameModeFor, sessionDisplayName } from '../send/names.ts';
import { teamIdOf } from '../registry/teams.ts';
import { launchLimit, readMachine, readingsText, type Machine, type SwapSample } from '../watch/machine.ts';
import { watchLabel } from '../watch/pane.ts';
import { readScreen } from '../watch/screen.ts';
import { seatStart } from '../worktree/place.ts';
import { blocksLaunch, doctorFindings, realSources as doctorSources, type DoctorSources } from './doctor.ts';
import { realSources as downSources, stateOfPane } from './down.ts';
import { stopRunning, type RemoveSources } from './remove.ts';
import type { Launch } from './up.ts';

export const USAGE = `Usage: team restart <seat> [--abandon] [--dry-run] [--session <name>] [--file <path>] [--json]
       team restart <seat> --client <grant-file> --key <client-key> [--team <team>] [--dry-run] [--json]

The --client form is for a client with no terminal that the owner signed a manager bundle grant carrying restart for: it restarts a seat of that one team, as signed, and nothing else. It never prompts, never abandons a pane (--abandon, --file and --session are the owner's and take no --client), and is never the owner.

Exits 0 when the seat is restarted or the dry-run plan is printed, 1 when restart is refused or fails, 2 when the invocation or team file can't be read.
`;

export type RestartSources = RemoveSources & {
  home: string;
  sessionState(session: string): 'absent' | 'running' | 'stopped' | null;
  workspaces(session: string): { id: string }[] | null;
  upLaunch: Launch;
  doctor: DoctorSources;
  machine?: (root: string) => Machine;
  standing?: (root: string) => Standing;
  seatBudget?: typeof seatBudget;
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

const realUpLaunch: Launch = {
  sessionState,
  startServer,
  sessionUp: sessionRunning,
  createWorkspace: (session, cwd, label) => workspaceCreate(cwd, label, aim(session)),
  paneRun: (session, pane, command) => paneRun(pane, command, aim(session)),
  registerInbox: (cli, seat, cwd, teamFile) =>
    registerInbox({ cli, seat, cwd, ...(teamFile === undefined ? {} : { file: teamFile }) }),
  codexEndpoint: {
    managed: (endpoint) => ensureCodexEndpoint(endpoint),
    stop: (endpoint) => stopSeatCodexEndpoint(endpoint),
  },
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
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: () => new Date(),
};

export const realSources: RestartSources = {
  ...downSources,
  home: homedir(),
  sessionState,
  workspaces(session) {
    const listed = workspaceList(aim(session));
    return listed === null ? null : listed.map((workspace) => ({ id: workspace.id }));
  },
  foreground: (session, pane) => paneForeground(pane, aim(session)),
  foregroundCwd: (session, pane) => paneForegroundCwd(pane, aim(session)),
  renameAgent: (session, pane, name) => agentRename(pane, name, aim(session)),
  upLaunch: realUpLaunch,
  doctor: doctorSources,
  machine: readMachine,
};

const LEFT: Record<Exclude<DownSeat['state'], 'free'>, string> = {
  working: 'is working; left as it is',
  blocked: 'is blocked at a prompt, which team never answers; left as it is',
  unknown: 'shows a screen the profile does not recognise; left as it is',
  unsent: 'holds unsent text in its input box; left as it is',
  exited: 'its CLI had exited; closed without typing',
};

export const restart: Command = (argv, io) => runRestart(argv, io, realSources);
export default restart;

export async function runRestart(argv: string[], io: Io, sources: RestartSources = realSources): Promise<number> {
  let out = cleanedIo(io);
  // A bad option stops the parser before `--json` is read when it comes first, and the
  // structured refusal is still the one the caller asked for.
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['session', 'file', 'client', 'key', 'team'], ['abandon', 'dry-run', 'json']);
  const clientProblem = args.error === undefined && args.rest.length === 1
    ? clientFormProblem(args.values, 'team restart <seat> --client <grant-file> --key <client-key-file>')
      ?? (args.values.client !== undefined && (args.values.file !== undefined || args.values.session !== undefined || args.flags.has('abandon'))
        ? "--client restarts a seat of the one team its grant names: --file, --session and --abandon are the owner's and take no --client"
        : null)
    : null;
  if (args.error || args.rest.length !== 1 || clientProblem !== null) {
    const reason = args.error ?? (args.rest.length > 1 ? `unexpected "${plainLine(args.rest[1] ?? '')}"` : args.rest.length === 0 ? 'a seat name is required' : clientProblem ?? 'the invocation cannot be read');
    return usage(out, json, reason);
  }
  const name = args.rest[0] ?? '';
  const abandon = args.flags.has('abandon');
  const dry = args.flags.has('dry-run');
  // Collapsed notes: what plain output writes to stdout while it works (the pre-close readings,
  // the stop's own lines) ride on the document instead.
  const notes: string[] = [];

  // The client form: a manager grant the owner signed for ONE team at ONE folder, proven by the client's
  // own key and verified whole before anything is read. The verified run is the second door past the
  // placement and who-may-run-it gates below, never the owner's: it cannot abandon a pane, and it is
  // logged as `client:<id>`.
  let clientRun: ClientRun | null = null;
  if (args.values.client !== undefined) {
    if (!json) io.stderr(`${KEY_ISOLATION_LINE}\n`);
    const at = sources.now();
    const clientHome = sources.home ?? homedir();
    const verified = verifyClientForm({ home: clientHome, now: at }, { op: 'restart', values: args.values, cwd: io.cwd });
    if (!verified.ok) {
      if (!dry) auditClientRefusal('restart', verified.named, verified.why, at);
      return clientRefused(out, json, verified.why);
    }
    clientRun = verified.run;
    io = { ...io, cwd: verified.run.root };
    out = cleanedIo(io);
    if (!json) io.stderr(`client grant ${clientRun.grant.grantId}: ${clientRun.grant.clientId} for team ${clientRun.grant.up.project} at ${clientRun.root}, until ${clientRun.grant.expires}\n`);
  }
  const clientText = clientRun === null ? null : `client:${clientRun.grant.clientId}`;

  const walked = walkCaller(io);
  const detached = detachedRefusal(walked, { who: 'the owner or a `leads` seat', where: 'a terminal outside herdr or its own pane' });
  if (detached !== undefined && clientRun === null) return detachedExit(out, json, detached);

  const flagRefusal = fileOwnerRefusal(io, args.values.file)
    ?? (args.values.session !== undefined && !isOwner(walked) ? sessionOwnerRefusal(walked) : undefined);
  if (flagRefusal !== undefined) return callerRefused(out, json, flagRefusal, undefined, 'owner-only');

  const launched = args.values.file ? undefined : launchedTeamFile(io, sources.home);
  const loaded = loadTeamFile(io.cwd, {
    ...(args.values.file ?? launched ? { file: args.values.file ?? launched } : {}),
    home: sources.home,
    // The session this run addresses: the placement check reads that session's recorded lobby.
    ...(args.values.session !== undefined ? { session: args.values.session } : {}),
  });
  if (!loaded.ok) {
    return configuration(out, json, loaded.errors.map((problem) => `${where(problem)}${plainText(problem.message)}`).join('\n'));
  }
  const { team, root, path } = loaded;
  const dir = dirname(path);

  // The gate is the map's (`gateVerdict`), read in the verdict shape the branches below already
  // speak: owner or `leads` for this team, decided from records.
  const home = sources.home ?? homedir();
  const verdictOf = (who: Caller, at: SeatStanding): ReturnType<typeof gateVerdict> =>
    gateVerdict(who, team, root, home, 'restart', at, sources.now);
  const judged = args.values.session !== undefined
    ? { ...judgeCallerOf(io, args.values.session === 'default' ? undefined : args.values.session), session: args.values.session }
    : judgeCallerIn(io, dir, team, verdictOf);
  const { caller, shown, session } = judged;
  // Dev mode, from the file this run restarts against: a `dev-mode` value anywhere in the
  // caller's chain governs, and `TEAMCLI_DEV_MODE` is then ignored; before any such value the
  // variable set to exactly `1` keeps its behaviour. Only the caller line below is ever folded.
  const dev = resolveDevMode('restart', io, { home: sources.home, team, root, now: sources.now() });
  if (!dry) logDevModeState(dir, 'restart', describeCaller(caller), dev, sources.now());
  let devFolded = false;
  if (session === 'default') {
    return callerRefused(out, json, 'session can\'t be "default", herdr\'s own session');
  }

  const standing = sources.standing?.(root) ?? approvalStanding(root, sources.home);
  if (standing.kind !== 'verified' && standing.kind !== 'none') {
    return callerRefused(out, json, notInForce(standing));
  }
  // The live file is the record: the roster, the ceilings and the grant all read from it, and a
  // file that changed since the last approval is not a refusal.
  const ceilings = ceilingsOf(team);

  const mayChange = verdictOf(caller, standingOf(dir, session, caller));
  // The who-may-run-it gate: the caller, its placement, and the owner rule. Set to exactly
  // `1`, dev mode says this gate once, as a warning, and the restart continues — exactly as
  // `up` does. Every other refusal stays a refusal: the target placement, the CLI, the
  // records, the approvals and trust. The warning is logged where this call runs; a dry run
  // says it beside the dry answer and decides nothing.
  const mayRun = clientRun !== null ? null : mayChange.kind === 'no-pane' ? noPaneRefusal(mayChange.name)
    : mayChange.kind === 'another-pane' ? anotherPaneRefusal(mayChange.name, mayChange.recordedPane)
      : mayChange.kind === 'refused' ? `only the owner or \`leads\` restarts a seat; this call is ${plainLine(describeCaller(shown))}${devModeExpiryNote(dev)}`
        : null;
  if (mayRun !== null) {
    const folded = devModeCallerGate(dev, mayRun);
    if (folded !== null) {
      devFolded = true;
      // The document's note is the sentence itself; the terminal's lines carry the dry run's
      // `! ` and the command's name.
      if (json) notes.push(folded);
      else if (dry) out.stdout(`! ${folded}\n`);
      else out.stderr(`team restart: ${plainText(folded)}\n`);
      if (!dry) logDevMode(dir, 'restart', describeCaller(caller), folded, sources.now());
    } else {
      // The dry answer names the refusal and the one command that unblocks it, on stdout where
      // a dry run's answers go; both paths exit through the refusal's one exit site below.
      return callerRefused(
        out,
        json,
        mayRun,
        dry ? `! restart would refuse: ${plainText(mayRun)}\n! to unblock: ${plainText(unblockingRestartRun(argv))}\n` : undefined,
        'owner-or-leads',
        unblockingRestartRun(argv),
      );
    }
  }

  const recordedSession = readState(dir).sessions[session] ?? emptySession();
  const recordedSeat = recordedSession.seats[name];
  if (caller.kind === 'seat' && (caller.name === name || (recordedSeat?.pane !== undefined && caller.pane === recordedSeat.pane))) {
    return selfRefused(out, json, caller.name);
  }

  const declared = team.seats.find((seat) => seat.name === name);
  if (recordedSeat?.temporary && !declared) {
    return temporaryRefused(out, json, name, recordedSeat.temporary.like);
  }
  if (!declared) {
    return unknownRefused(out, json, name);
  }
  if (abandon && caller.kind !== 'owner' && (name === team.orchestrator || name === team.operator)) {
    return leadRefused(out, json, describeCaller(caller));
  }
  if (declared.stopped) {
    return signedOffRefused(out, json, name);
  }

  const liveState = sources.sessionState(session);
  const running = sources.sessionRunning(session);
  if (liveState === null || running === null) return herdrRefused(out, json);
  if (liveState !== 'running' || !running) return noSessionRefused(out, json, session);

  const agents = sources.agents(session);
  const workspaces = sources.workspaces(session);
  if (agents === null || workspaces === null) return herdrRefused(out, json);

  // A pane the file marks as a human's is never typed into or launched over: this command is a
  // stop followed by a launch, so it steps over the seat entirely and says why.
  if (declared.human) {
    return notReadyRefused(out, json, `${name} is a human's pane: nothing is typed into it or launched over it; left as it is`);
  }

  // The seat's own recorded conversation, when the two team-owned records agree on it: the
  // restart resumes that conversation instead of starting a fresh one. A record that belongs to
  // another seat, team, agent or CLI, or one the seat state does not match, is never resumed —
  // the run says why and launches fresh, exactly as a restart did before. The id is the CLI's
  // own, read from the launch's herdr reading; nothing here reads a CLI home or session file.
  const ownSession = recordedSeatSession({
    home,
    root,
    herdrSession: session,
    seat: declared,
    state: recordedSeat,
  });
  let resume: string | undefined;
  // The pane's continuity is proven by the session the registry binds to the seat, whatever
  // resume form the new launch line can carry: a CLI with none has no resume id, and its
  // state copy may predate the id a restore kept. The live agent's session must still be the
  // recorded one; `inspectSeat` makes that comparison. A state naming another id, or a record
  // that is not this seat's, binds nothing.
  const boundSession = recordedSeatContinuity({
    home,
    root,
    herdrSession: session,
    seat: declared,
    state: recordedSeat,
  });
  const continuity = boundSession.kind === 'bound' && boundSession.recorded.launch
    ? boundSession.recorded.sessionId
    : undefined;
  const noResume = (why: string): void => {
    const said = `${name}: not resuming its recorded session (${why})`;
    if (json) notes.push(said);
    else if (dry) out.stdout(`! ${said}\n`);
    else out.stderr(`team restart: ${plainText(said)}\n`);
    if (!dry) logLine(dir, 'restart', describeCaller(caller), said, sources.now());
  };
  // The id to resume is the one the records bind, not one the state copy must also agree with:
  // the registry record is the proof, and a state copy naming no id is a copy that predates the
  // id, not a disagreement. A state naming another id is refused above by both readers.
  const resumeCandidate = ownSession.kind === 'bound' && ownSession.recorded.launch
    ? { id: ownSession.recorded.sessionId, launch: ownSession.recorded.launch }
    : boundSession.kind === 'bound' && boundSession.recorded.launch
      ? { id: boundSession.recorded.sessionId, launch: boundSession.recorded.launch }
      : undefined;
  if (ownSession.kind === 'refused') {
    noResume(ownSession.why);
  } else if (resumeCandidate !== undefined) {
    const recordedPane = recordedSeat?.pane;
    const listed = recordedPane === undefined
      ? undefined
      : agents.find((agent) => agent.name === name && agent.pane === recordedPane);
    // The recorded launcher's own selection, read before anything is stopped: `--abandon` is the
    // caller's fresh start, and a line that itself names a conversation — the recorded id or any
    // other — cannot be run fresh. It is never rewritten, so the flag is refused here rather than
    // pretending the line it would run is a fresh one.
    const pinned = namedResumeTarget(declared.cli, resumeCandidate.launch) !== null;
    if (pinned && abandon) {
      return notReadyRefused(
        out,
        json,
        `${name}: its launch line itself names a conversation, so --abandon cannot start a fresh one; left as it is (clear the resume selection from its launch line for a fresh start)`,
      );
    }
    if (listed?.session !== undefined && listed.session !== '' && listed.session !== resumeCandidate.id) {
      // The live pane is another conversation: resuming the recorded one would put two live
      // copies of the seat's history beside each other. The restart proceeds fresh.
      noResume('its live agent session is not the recorded one');
    } else {
      const carried = resumeCarry(declared.cli, resumeCandidate.launch, resumeCandidate.id);
      if (carried.kind === 'line') {
        // The line selects the recorded id, or names none and takes it appended — never under
        // the caller's `--abandon`, which starts fresh.
        if (!abandon) resume = resumeCandidate.id;
      } else if (pinned) {
        // The recorded launcher names another conversation, or resumes without naming one:
        // stopping the seat and running that line would resume something nothing proved. Nothing
        // is stopped, and the fresh start is not the caller's `--abandon` either: that line would
        // run the same selection.
        return notReadyRefused(
          out,
          json,
          `${name}: its recorded launcher does not select the recorded conversation; left as it is (its launch line names a conversation of its own: clear that selection from its launch line for a fresh start)`,
        );
      } else if (abandon) {
        // The caller's fresh start: the id the records bind is not put on the line. The line
        // names no conversation of its own here, so running it as it is starts one.
        if (carried.kind === 'refuse') noResume(carried.why);
      } else {
        // No measured resume form on this CLI: stopping the seat would destroy a conversation
        // nothing could put back. The fresh start is the caller's explicit choice.
        return notReadyRefused(
          out,
          json,
          `${name}: its recorded conversation cannot be resumed (${carried.why}); left as it is (team restart ${name} --abandon for a fresh start)`,
        );
      }
    }
  }

  // The client's grant, read once more under its lock immediately before the first effect, and its audit
  // line written while the lock is held. A dry run decides nothing and writes nothing.
  if (clientRun !== null && !dry) {
    const stood = authorizeClientRun(home, clientRun, 'restart', sources.now(), `seat ${name}`);
    if (stood !== null) {
      auditClientRefusal('restart', clientRun.grant, stood, sources.now());
      return clientRefused(out, json, stood);
    }
  }

  const performed = await performRestart({
    out,
    json,
    notes,
    dir,
    root,
    home,
    path,
    team,
    session,
    name,
    declared,
    recorded: recordedSeat,
    agents,
    abandon,
    owner: clientRun === null && caller.kind === 'owner',
    callerText: clientText ?? describeCaller(caller),
    standing,
    ceilings,
    dev,
    devFolded,
    command: 'restart',
    endReason: 'restart',
    dry,
    ...(resume === undefined ? {} : { resume }),
    ...(continuity === undefined ? {} : { continuity }),
    ...(boundSession.kind === 'bound' && boundSession.recorded.launch ? { registryLaunch: boundSession.recorded.launch } : {}),
    now: sources.now,
    sources,
  });
  switch (performed.kind) {
    case 'dry':
      return dryRunExit(out, json, performed.text, {
        project: team.project,
        session,
        seat: name,
        plan: performed.plan,
        notes,
      });
    case 'replaced':
      return replacedRefused(out, json, name, performed.takeable);
    case 'abandon-working':
      return abandonWorkingRefused(out, json, name);
    case 'busy':
      return busyRefused(out, json, performed.message);
    case 'not-ready':
      return notReadyRefused(out, json, performed.message);
    case 'herdr':
      return herdrRefused(out, json);
    case 'run-lock':
      return runLockRefused(out, json, performed.held, session, dir);
    case 'ready':
      return readyExit(
        out,
        json,
        dir,
        clientText ?? describeCaller(caller),
        name,
        performed.oldPane,
        performed.pane,
        sources.now(),
        team.project,
        session,
        notes,
      );
    default: {
      // Every result the launch sequence returns is handled above. This arm is the contract the
      // exit gate reads: a run that ends in a shape this version does not know can only be a bug.
      const unknown: never = performed;
      throw new Error(`restart: unhandled result ${JSON.stringify(unknown)}`);
    }
  }
}

/** Which command runs the shared launch sequence: the word its log lines carry, and the reason
 *  the old session's record ends with. */
export type PerformCommand = 'restart' | 'swap';

/** What the shared launch sequence is handed: the seat as the file now declares it, the world it
 *  was inspected in, and the caller's own words. `restart` and the swap's run both call it, so
 *  there is one stop-and-launch sequence in the tool. */
export type PerformInput = {
  out: Io;
  json: boolean;
  /** The plain output's working lines, collapsed onto the document under `--json`. */
  notes: string[];
  dir: string;
  root: string;
  home: string;
  path: string;
  team: TeamFile;
  session: string;
  name: string;
  declared: Seat;
  /** The seat as the file will declare it once the stop is done: a swap's recipe. Absent, the
   *  declaration is `declared` and the run is a restart. The inspection reads `declared` (the
   *  pane still runs the old CLI); the preflight and the launch read this one. */
  next?: Seat;
  recorded: SeatState | undefined;
  agents: readonly HerdrAgent[];
  abandon: boolean;
  /** The swap observed the screen at the CLI's rate limit or provider error: that pane cannot
   *  finish its task and cannot answer, so it is closed without typing. Every other blocked
   *  screen — permission, trust, question, exit question, vendor notice — keeps its refusal. */
  broken?: boolean;
  owner: boolean;
  callerText: string;
  standing: Standing;
  ceilings: Ceilings;
  dev: DevModeRun;
  devFolded: boolean;
  command: PerformCommand;
  endReason: 'restart' | 'swap';
  /** The dry run: preflight, then the plan, and nothing stopped or launched. */
  dry: boolean;
  /** The recorded CLI session id the new launch resumes, where a swap keeps the conversation.
   *  Absent when the CLI changed or cannot resume: the run asks for a handover instead. */
  resume?: string;
  /** The registry-bound session id this restart proves a restored pane against. Absent when no
   *  binding exists, or the CLI has no measured resume form and the state copy names no id: the
   *  pane is then never tied to the launch, and a replaced process is left as it is. */
  continuity?: string;
  /** Registry recipe bound to the resume id. */
  registryLaunch?: string;
  /** The handover the new conversation reads first: the seat is asked to write this path before
   *  the stop, and the wait is bounded. */
  handover?: { path: string; waitMs: number };
  /** Writes the team file's new declaration, after the old pane is closed and before the hooks
   *  and the launch — the launch reads the file's own words. A failure is a truthful abort: the
   *  sequence ends before the hooks, the brief and the launch, and the caller reports it as a
   *  refusal. A swap keeping its queue record on that abort is the caller's rule (the ruling of
   *  2026-10-19). */
  declare?: () => { ok: true } | { ok: false; why: string };
  now(): Date;
  sources: RestartSources;
};

/** What the launch's own screen says the new conversation is, read back after ready. */
export type ReadBack =
  | { kind: 'match'; model: string }
  | { kind: 'mismatch'; expected: string; shown: string }
  | { kind: 'unread' };

export type PerformResult =
  | { kind: 'dry'; text: string; plan: PlanStep[] }
  | { kind: 'replaced'; takeable: boolean }
  | { kind: 'abandon-working' }
  | { kind: 'busy'; message: string }
  | { kind: 'not-ready'; message: string }
  | { kind: 'herdr' }
  | { kind: 'run-lock'; held: number }
  | {
      kind: 'ready';
      oldPane: string;
      pane: string;
      readBack: ReadBack;
      /** The handover file the launch was actually given. Absent when the bounded wait ended
       *  without one, so a caller never reports a handover that was only asked for. */
      handover?: string;
    };

export async function performRestart(input: PerformInput): Promise<PerformResult> {
  const {
    out,
    json,
    notes,
    dir,
    root,
    home,
    path,
    team,
    session,
    name,
    declared,
    agents,
    abandon,
    owner,
    callerText,
    standing,
    ceilings,
    dev,
    devFolded,
    dry,
    now,
    sources,
  } = input;
  const recordedSeat = input.recorded;
  const recordedSession = readState(dir).sessions[session] ?? emptySession();
  // The declaration the launch reads: a swap's recipe, when one is handed in; a restart's own
  // file entry otherwise. The inspection above it reads the old declaration — the pane still
  // runs the old CLI.
  const next = input.next ?? declared;
  const noteIo: Io = json
    ? { ...out, stdout: (text: string) => { notes.push(...text.split('\n').filter((line) => line !== '')); } }
    : out;

  // Inspect the target seat's current pane before any preflight or stop.
  let continuitySession = input.command === 'restart' ? (input.continuity ?? input.resume) : undefined;
  const inspected = inspectSeat(session, name, declared, recordedSeat, agents, abandon, owner, sources, input.broken === true, input.command === 'restart', continuitySession);
  if (inspected.kind === 'replaced') return { kind: 'replaced', takeable: inspected.takeable };
  if (inspected.kind === 'abandon-working') return { kind: 'abandon-working' };
  if (inspected.kind === 'busy') return { kind: 'busy', message: inspected.message };

  // Preflight the relaunch before stopping the seat so a preflight refusal leaves the seat running.
  const profile = profileFor(next.cli);
  if (!profile) {
    return { kind: 'not-ready', message: `no launch profile for \`${plainLine(next.cli)}\` in this version` };
  }
  for (const problem of placedProblems(team, root, home, undefined, session)) {
    return { kind: 'not-ready', message: problem.message };
  }
  const start = seatStart({ ...team, session }, next, root, home);
  if ('problem' in start) {
    return { kind: 'not-ready', message: start.problem };
  }
  const doctorTeam = { ...team, seats: [next] };
  for (const finding of doctorFindings(doctorTeam, root, dir, session, sources.doctor, [], standing, team)) {
    if (blocksLaunch(finding)) {
      if (finding.text.includes('team approve') || finding.text.includes('never approved')) continue;
      if (finding.text.includes(' is read at start by ')) continue;
      return { kind: 'not-ready', message: finding.text };
    }
  }
  const samples: SwapSample[] = [];
  const machineNow = sources.machine?.(root);
  const machineProblem = machineNow ? launchLimit(machineNow, team.machine, samples, sources.now().getTime()) : null;
  if (machineProblem) return { kind: 'not-ready', message: machineProblem };

  const remainingAgents = agents.filter((agent) => agent.name !== name);
  const runningSeats = runningOf(remainingAgents, team, recordedSession);
  const room = ceilingProblem(ceilings, runningSeats, next);
  if (room) return { kind: 'not-ready', message: room };

  const budgets = budgetsInForceOf(standing, team);
  const budgetDecision = (sources.seatBudget ?? seatBudget)(
    budgets,
    loadReadings(dir),
    next,
    sources.now().getTime(),
    loadSpendReadings(dir),
  );
  if (budgetDecision.kind === 'refuse') {
    return { kind: 'not-ready', message: budgetDecision.why };
  }

  const liveRules = standing.kind !== 'verified' || owner;
  const planSeat = buildUpSeat(standing, team, next, start, root, home, liveRules);
  if (input.registryLaunch) planSeat.launch = input.registryLaunch;
  const declaredLaunch = planSeat.launch;
  // The recorded conversation, resumed on the new declaration. The profile decides whether the
  // CLI can carry the id at all; the attempt is the log's fact, never a claim that it resumed
  // losslessly. It is applied before the dry answer so the plan prints the line the launch would
  // run; the log line itself is written once the seat is down and the launch is going out.
  let resumed: string | undefined;
  if (input.resume !== undefined) {
    const carried = resumeCarry(next.cli, planSeat.launch, input.resume);
    if (carried.kind === 'line') {
      planSeat.launch = carried.line;
      resumed = input.resume;
    } else if (namedResumeTarget(next.cli, planSeat.launch) !== null) {
      // The line this launch would run names a conversation of its own: stopping the seat would
      // destroy one nothing proved while resuming another. The stop is not made, and `--abandon`
      // is no way out either: it would run the same line.
      return {
        kind: 'not-ready',
        message: `${name}: its launch line does not select the recorded conversation; left as it is (its launch line names a conversation of its own: clear that selection from its launch line for a fresh start)`,
      };
    }
    // A CLI with no measured resume form runs fresh; the caller already said so.
  }
  if (dry) {
    const stopStep = inspected.agent
      ? `stop ${plainLine(name)} in ${plainLine(inspected.agent.pane)} (${inspected.where})\n`
      : `${plainLine(name)}: not currently running\n`;
    // An unread screen on a seat herdr calls idle is advice: the dry answer says what the run
    // does without typing into it.
    const advice = inspected.unrecognised === undefined
      ? ''
      : `${unreadAdvice(name, inspected.unrecognised)}\n`;
    // An unsent box the run would move: the dry answer names where its text waits and when it
    // goes back, so the plan never reads as a close that drops it.
    const draftStep = inspected.draftScreen === undefined
      ? ''
      : `${plainLine(name)}: input box: holds unsent text; it is copied to ${restartDraftPath(dir, session, name)} before the close and pasted back once the new pane is ready\n`;
    const preview = upPlan({
      root,
      session,
      sessionRunning: true,
      seats: [planSeat],
      watchAlive: true,
      teamFile: path,
      cliHooks: plannedCliHooks(dir, session, [planSeat]),
      briefEpochs: currentBriefEpochs(dir, session),
      watchLabel: watchLabel(team.project),
    });
    // The stop comes before the launch the plan prints; a seat that is not running is a skip.
    const stopPlan: PlanStep[] = inspected.agent
      ? [{ step: 'stop', seat: name, detail: `stop ${name} in ${inspected.agent.pane} (${inspected.where})`, prefix: '+' }]
      : [{ step: 'stop', seat: name, detail: 'not currently running', prefix: 'skip' }];
    return {
      kind: 'dry',
      text: `${stopStep}${draftStep}${advice}${plainText(formatPlan(preview))}`,
      plan: [...stopPlan, ...planStepsOf(preview)],
    };
  }

  const runLock = acquireRunLock(dir, session);
  if ('held' in runLock) {
    return { kind: 'run-lock', held: runLock.held };
  }
  try {
    const freshAgents = sources.agents(session);
    if (freshAgents === null) return { kind: 'herdr' };
    const freshSession = readState(dir).sessions[session] ?? emptySession();
    const freshRecorded = freshSession.seats[name];
    // The binding is re-read under the run lock: a record that changed between the caller's read
    // and this one no longer names the conversation this run would start with, so the launch goes
    // out fresh and says why. A restart never resumes an id the current records do not bind.
    if (input.command === 'restart' && resumed !== undefined) {
      // The same reader the resume was chosen with: the registry binding, refused by a state
      // that names another id. A state copy that merely names none no longer cancels the resume.
      const freshOwn = recordedSeatContinuity({
        home,
        root,
        herdrSession: session,
        seat: declared,
        state: freshRecorded,
      });
      if (freshOwn.kind !== 'bound' || freshOwn.recorded.sessionId !== resumed) {
        const why = freshOwn.kind === 'bound'
          ? 'the seat record changed before the launch'
          : freshOwn.why;
        planSeat.launch = declaredLaunch;
        resumed = undefined;
        continuitySession = undefined;
        const said = `${name}: not resuming its recorded session (${why})`;
        if (json) notes.push(said);
        else out.stderr(`team restart: ${plainText(said)}\n`);
        logLine(dir, 'restart', callerText, said, sources.now());
      }
    }
    const rechecked = inspectSeat(session, name, declared, freshRecorded, freshAgents, abandon, owner, sources, input.broken === true, input.command === 'restart', continuitySession);
    if (rechecked.kind === 'replaced') return { kind: 'replaced', takeable: rechecked.takeable };
    if (rechecked.kind === 'abandon-working') return { kind: 'abandon-working' };
    if (rechecked.kind === 'busy') return { kind: 'busy', message: rechecked.message };

    // The unsent text, copied under the run lock before the pane is closed, so neither a failed
    // launch nor this process ending loses it. The copy stays until the text is read back in
    // the new box; where that fails, its path is named in what the run prints.
    let draftText: string | undefined;
    let draftCopy: string | undefined;
    if (input.command === 'restart' && rechecked.draftScreen !== undefined && rechecked.agent) {
      const capture = captureDraft(declared.cli, rechecked.draftScreen);
      if (!('text' in capture)) {
        return { kind: 'busy', message: `${name} holds unsent text in its input box ${capture.why}; left as it is` };
      }
      const kept = keepRestartDraft(dir, session, name, capture.text);
      if ('why' in kept) {
        return { kind: 'busy', message: `${name} holds unsent text and ${kept.why}; left as it is` };
      }
      draftText = capture.text;
      draftCopy = kept.path;
    }

    const who = callerText;
    // The launch's machine decision, taken under the run lock at the last point a refusal can
    // still leave the seat as it is. The preflight above refuses early, outside the lock; this
    // reading decides the stop, and it shares the run's samples so swap growth across the
    // preflight (or a handover wait) is measured rather than hidden. Nothing below the stop
    // reads the machine again: a seat already closed and then refused for a reading taken after
    // it is a stranded seat, with no pane to go back to.
    const machineRefusal = (): string | null => {
      const machine = sources.machine?.(root);
      if (!machine) return null;
      const problem = launchLimit(machine, team.machine, samples, sources.now().getTime());
      if (problem !== null) {
        logLine(dir, input.command, callerText, `refused: ${problem} — readings: ${readingsText(machine)}`, sources.now());
      }
      return problem;
    };
    const oldPane = rechecked.agent?.pane ?? freshRecorded?.pane ?? 'none';
    let handoverPath: string | undefined;
    let stopObs: Extract<InspectedSeat, { kind: 'ok' }> = rechecked;

    if (rechecked.agent) {
      // Print the three pre-close facts before stopping or closing the seat's workspace. Under
      // `--json` they are collapsed notes on the document instead. A screen the profile cannot
      // read is not claimed empty: its input box was not read.
      const box = rechecked.unrecognised !== undefined
        ? 'not read (the screen is not recognised)'
        : draftCopy !== undefined
          ? `holds unsent text, copied to ${draftCopy} and pasted back once the new pane is ready`
          : rechecked.where === 'unsent' ? 'holds unsent text' : 'empty';
      noteIo.stdout(`${plainLine(name)}: input box: ${box}\n`);
      noteIo.stdout(`${plainLine(name)}: turn: ${rechecked.where === 'working' ? 'mid-turn (working)' : `not working (${rechecked.where})`}\n`);
      noteIo.stdout(`${plainLine(name)}: context: workspace close ends the pane; relaunch runs "${plainLine(next.launch)}" in a new workspace without passing the old transcript\n`);
      if (rechecked.unrecognised !== undefined) {
        noteIo.stdout(`${unreadAdvice(name, rechecked.unrecognised)}\n`);
      }

      // The handover is asked at the boundary, as the last step of the old conversation's task,
      // and before the stop. The request starts a turn; the pane is read again before the stop,
      // so what the stop acts on is the screen after that turn, never the one it was asked at.
      if (input.handover !== undefined) {
        handoverPath = await askForHandover({
          session,
          name,
          pane: rechecked.agent.pane,
          path: input.handover.path,
          waitMs: input.handover.waitMs,
          sources,
          log: (said) => logLine(dir, input.command, who, said, sources.now()),
        });
        const fresh = sources.agents(session);
        if (fresh === null) return { kind: 'herdr' };
        const seen = inspectSeat(session, name, declared, readState(dir).sessions[session]?.seats[name], fresh, abandon, owner, sources, input.broken === true, input.command === 'restart', continuitySession);
        if (seen.kind === 'replaced') return { kind: 'replaced', takeable: seen.takeable };
        if (seen.kind === 'abandon-working') return { kind: 'abandon-working' };
        if (seen.kind === 'busy') return { kind: 'busy', message: seen.message };
        stopObs = seen;
      }

      // The last refusal before the stop: the reading is taken here, immediately before the
      // pane is closed, so a seat that goes down is never left down by a guard below.
      const stopMachineProblem = machineRefusal();
      if (stopMachineProblem) return { kind: 'not-ready', message: stopMachineProblem };

      // A pane herdr still lists is stopped; one it no longer lists is not typed into, and the
      // old record is cleared below either way.
      let stopped = true;
      if (stopObs.agent) {
        stopped = await stopRunning({
          io: noteIo,
          dir,
          session,
          sources,
          logCommand: input.command,
          caller: who,
          seat: {
            name,
            cli: declared.cli,
            pane: stopObs.agent.pane,
            workspace: stopObs.agent.workspace,
            state: stopObs.where === 'free' ? 'free' : stopObs.where,
            ...(stopObs.exitInBox ? { exitInBox: true } : {}),
            ...(stopObs.atExitQuestion ? { atExitQuestion: true } : {}),
            // A doubt pane the caller's `--abandon` takes is closed without typing: nothing is
            // read from it, no exit text is sent, and no key answers whatever is in front.
            ...(stopObs.taken === true ? { unproven: true as const } : {}),
          },
          keep: false,
          // An unrecognised screen on a seat herdr calls idle is closed, not typed into: `abandon`
          // says "close without typing" here, and the owner's own `--abandon` stays what it was.
          // A broken screen (rate limit or provider error) gets the same close: nothing is typed
          // into a pane whose conversation cannot answer.
          abandon: (abandon || stopObs.unrecognised !== undefined || stopObs.brokenScreen || draftCopy !== undefined) && stopObs.where !== 'free',
          closeUnasked: abandon,
          unasked: `team ${input.command} ${name} --abandon closes it`,
        });
      }
      if (!stopped) {
        return { kind: 'busy', message: `${name} could not be stopped; left as it is${keptAt(draftCopy)}` };
      }
      if (stopObs.agent && sources.upLaunch.agentPanes(session)?.includes(stopObs.agent.pane)) {
        return { kind: 'busy', message: `${name} did not close its old pane; left as it is${keptAt(draftCopy)}` };
      }
      let priorPane = freshRecorded?.pane;
      updateState(dir, (file) => {
        const current = file.sessions[session];
        if (!current) return;
        const prior = current.seats[name] ?? freshRecorded;
        priorPane = prior?.pane ?? priorPane;
        if (prior?.id && !prior.temporary) {
          (current.retained_seats ??= {})[name] = {
            id: prior.id,
            ...(prior.last_active ? { last_active: prior.last_active } : {}),
          };
        }
        delete current.seats[name];
      });
      if (priorPane) forgetLaunchedPane(sources.home, priorPane, session);
      // The old pane is closed: the seat's agent is stopped until the relaunch below re-points it.
      const ended = registerEnd({ home, team, root, by: who, session }, name, 'stopped', input.endReason);
      if (ended) logLine(dir, input.command, who, ended.note, sources.now());
    } else {
      // Nothing was stopped in this run, so the launch's one machine decision is taken here,
      // before the declaration lands and the plan is built.
      const machineProblemNow = machineRefusal();
      if (machineProblemNow) return { kind: 'not-ready', message: machineProblemNow };
    }

    // The team file's new declaration lands after the old pane is closed and before the hooks
    // and the launch, which reads the file's own words. A write that fails is a truthful abort:
    // the run ends non-zero and launches nothing — a swap's queue record stands and the failure
    // is reported (the ruling of 2026-10-19). The seat is already down either way, so the next
    // `team up` starts it from the file the run actually holds.
    if (input.declare) {
      const wrote = input.declare();
      if (!wrote.ok) {
        const said = `the team file was not rewritten (${wrote.why}); nothing was launched`;
        if (json) notes.push(said);
        else out.stderr(`team ${input.command}: ${plainText(said)}\n`);
        logLine(dir, input.command, who, said, sources.now());
        return { kind: 'not-ready', message: said };
      }
    }

    // A handover the old conversation wrote is passed to the new one through the brief and the
    // rules line it already reads first, whichever way this CLI carries its rules. One sentence,
    // built once: the brief appends its words verbatim and the rules line carries the same.
    const handoverSentence = handoverPath === undefined
      ? undefined
      : `Your predecessor wrote a handover for you at ${handoverPath}; read it before anything else.`;
    if (handoverSentence !== undefined) {
      planSeat.rules = `${planSeat.rules}\n\n${handoverSentence}`;
      if (planSeat.rulesFile) planSeat.rulesFile.line = `${planSeat.rulesFile.line} ${handoverSentence}`;
    }

    if (resumed !== undefined) {
      logLine(dir, input.command, callerText, `${name}: resuming session ${resumed} on the new declaration`, sources.now());
    }

    // What the launch declares: the recipe, with the resume line the plan carries where one was
    // applied. The record and the registry read this seat, never the old declaration.
    const launching: Seat = resumed === undefined ? next : { ...next, launch: planSeat.launch };

    const records = progressWriter(
      json
        ? { stdout: () => {}, stderr: (text) => { notes.push(...text.split('\n').filter((line) => line !== '')); }, isTTY: false }
        : { stdout: out.stdout, stderr: out.stderr, isTTY: out.stdoutIsTTY ?? false },
    );
    // The general seat brief goes first, before the state hook and the plan's rules line: the
    // claim is written before the hook that resolves it and the signed drop before the launch. A
    // delivery that cannot be written is said and logged, and the launch goes on; `team check`
    // names the seat with no record.
    const briefs = deliverBriefForAttribution({
      dir,
      root,
      session,
      home,
      now: sources.now?.() ?? new Date(),
      team,
      state: readState(dir).sessions[session] ?? emptySession(),
      attributed: [planSeat.name],
      broadcast: true,
      ...(handoverSentence === undefined ? {} : { handover: handoverSentence }),
    });
    await walkBriefDeliveries(briefs, { dir, home });
    const briefLine = (said: string): void => {
      if (json) notes.push(said);
      else out.stderr(`team ${input.command}: ${plainText(said)}\n`);
      logLine(dir, input.command, who, said, sources.now());
    };
    for (const delivery of briefs.deliveries) {
      if (!delivery.ok) briefLine(`${delivery.seat}: the general seat brief was not delivered (${delivery.reason})`);
    }
    if (briefs.recording !== undefined) briefLine(`the general seat brief was written and not recorded (${briefs.recording})`);
    // The claim this seat's launch was delivered at. The launch's own record writes the pane
    // diagnostics onto it, and only while the state still holds exactly this claim: a recovery or
    // a replacement delivery that landed in between is the claim that stands, and this run must
    // not overwrite it. The identity is compared whole — id alone is no claim.
    const delivered = briefs.deliveries.find((delivery) => delivery.seat === planSeat.name && delivery.ok === true);
    const expectedBrief = delivered === undefined || !delivered.ok
      ? undefined
      : {
          id: delivered.id,
          incarnation: delivered.incarnation,
          epoch: delivered.epoch,
          sha256: GENERAL_BRIEF_SHA256,
          stage: 'ready' as const,
        };
    // The state hook lands before the plan types the launch line. A seat whose settings file did
    // not land is said once, in the log, and relaunches with the file's own line.
    const plannedHooks = plannedCliHooks(dir, session, [planSeat]);
    const installed = installCliHooks(dir, session, [{ ...planSeat, fresh: true }], { project: team.project, root, home });
    if (plannedHooks[planSeat.name] !== undefined && installed[planSeat.name] === undefined) {
      logLine(dir, input.command, who, `${planSeat.name}: no state hook written; its launch line is the file's own`, sources.now());
    }
    const plan = upPlan({
      root,
      session,
      sessionRunning: true,
      seats: [planSeat],
      watchAlive: true,
      teamFile: path,
      cliHooks: installed,
      briefEpochs: currentBriefEpochs(dir, session),
      watchLabel: watchLabel(team.project),
      ...(sources.upLaunch.codexEndpoint === undefined ? {} : { stateDir: dir }),
    });
    // The old pane is closed: whatever its last turn wrote says nothing about the seat this
    // plan starts.
    resetCliHookState(dir, session, [planSeat.name]);
    const host = hostOf({
      dir,
      session,
      team: team,
      root,
      home,
      command: input.command,
      endReason: input.endReason,
      ...(resumed === undefined ? {} : { resume: resumed }),
      ...(handoverPath === undefined ? {} : { handover: handoverPath }),
      ceilings,
      running: runningSeats,
      seat: launching,
      caller: who,
      owner,
      devMode: devModeMark(dev, devFolded),
      now: sources.now,
      launch: sources.upLaunch,
      io: json
        ? { ...out, stdout: () => {}, stderr: (text: string) => { notes.push(...text.split('\n').filter((line) => line !== '')); } }
        : out,
      standing,
      teamFile: path,
      startCwd: planSeat.cwd,
      inLobby: planSeat.lobby === true,
      records,
      doctor: sources.doctor,
      ...(expectedBrief === undefined ? {} : { brief: expectedBrief }),
    });
    const report = await executePlan(plan, session, host);
    const afterwards = readState(dir).sessions[session]?.seats[name];
    const launchedOk = !report.held && !report.dropped.includes(name) && afterwards?.stage === 'ready' && !report.serverFailed;
    if (!launchedOk || !afterwards?.pane) {
      logLine(dir, input.command, who, `${name}: launch did not reach ready${draftCopy === undefined ? '' : `; its unsent text is copied at ${draftCopy}`}`, sources.now());
      return { kind: 'not-ready', message: `${name} did not reach a ready prompt${keptAt(draftCopy)}` };
    }
    // The unsent text goes back into the new pane's own box, its rows verified. On success the
    // copy is removed; where the paste did not read back, the copy stays and this run names it.
    if (draftText !== undefined && draftCopy !== undefined) {
      const restored = await restoreRestartDraft(sources.upLaunch, session, afterwards.pane, next.cli, draftText);
      if (restored.ok) {
        removeRestartDraft(draftCopy);
        const said = `${name}: unsent text pasted back${restored.note === undefined ? '' : ` (${restored.note})`}`;
        noteIo.stdout(`${plainLine(said)}\n`);
        logLine(dir, input.command, who, said, sources.now());
      } else {
        const why = restored.note ?? 'the paste did not read back as its rows';
        const said = `${name}: the unsent text could not be pasted back (${why}); its copy is at ${draftCopy}`;
        noteIo.stdout(`${plainLine(said)}\n`);
        logLine(dir, input.command, who, said, sources.now());
      }
    }
    return {
      kind: 'ready',
      oldPane,
      pane: afterwards.pane,
      readBack: readBackOf(launching, sources.screenText(session, afterwards.pane, next.cli)),
      ...(handoverPath === undefined ? {} : { handover: handoverPath }),
    };
  } finally {
    runLock.release();
  }
}

/** How often the handover wait looks for the file. The wait is bounded by the caller; this is
 *  the poll inside it. */
const HANDOVER_POLL_MS = 2_000;

/** The line typed into the old conversation to ask for its handover. One line: it is typed into
 *  an empty input box and sent with Enter. */
export function handoverRequest(path: string): string {
  return `Before this conversation ends, write a handover for your successor to ${path}: what you were doing, what is done, what is left, and anything the next conversation must not redo. Write the file as the last thing you do.`;
}

function fileHasText(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

/**
 * Asks the old conversation for its handover and waits, bounded, for the file. A file a previous
 * attempt already wrote is used without asking again. A request that cannot be typed is said and
 * the launch goes on; one that is chosen but not answered before the wait is the caller's to log.
 */
async function askForHandover(input: {
  session: string;
  name: string;
  pane: string;
  path: string;
  waitMs: number;
  sources: RestartSources;
  log(said: string): void;
}): Promise<string | undefined> {
  if (fileHasText(input.path)) {
    input.log(`${input.name}: using the handover already at ${input.path}`);
    return input.path;
  }
  try {
    mkdirSync(dirname(input.path), { recursive: true });
  } catch {
    input.log(`${input.name}: the handover folder could not be made; the launch goes on`);
    return undefined;
  }
  const typed = input.sources.upLaunch.typeText?.(input.session, input.pane, handoverRequest(input.path)) ?? false;
  const entered = typed && (input.sources.upLaunch.pressEnter?.(input.session, input.pane) ?? false);
  if (!entered) {
    input.log(`${input.name}: the handover request was not typed; the launch goes on`);
    return undefined;
  }
  const started = input.sources.now().getTime();
  // The file landing is not the end of the turn: the conversation may still be finishing its
  // final response, and the stop's recheck would refuse the seat as mid-turn. The wait is the
  // bound: it goes on until the seat is no longer working. A file written by a turn that ran
  // past the wait is still used — the launch reads it, and the recheck decides the stop.
  for (;;) {
    if (fileHasText(input.path)) {
      if (!workingNow(input.sources, input.session, input.pane)) {
        input.log(`${input.name}: the old conversation wrote the handover at ${input.path}`);
        return input.path;
      }
    }
    if (input.sources.now().getTime() - started >= input.waitMs) {
      if (fileHasText(input.path)) {
        input.log(
          `${input.name}: the old conversation wrote the handover at ${input.path} and its turn is still running; the launch goes on`,
        );
        return input.path;
      }
      input.log(`${input.name}: no handover was written before the wait ended; the launch goes on`);
      return undefined;
    }
    await input.sources.upLaunch.sleep(HANDOVER_POLL_MS);
  }
}

/** Whether herdr still reports the pane mid-turn. An unreadable herdr is not called working: the
 *  stop's own recheck reads the same source and decides. */
function workingNow(sources: RestartSources, session: string, pane: string): boolean {
  const agents = sources.agents(session);
  const agent = agents?.find((candidate) => candidate.pane === pane);
  return agent?.status === 'working';
}

/** The words a model id is compared by: lowercased, split where a CLI or a file may spell the
 *  same id with a hyphen, a dot or a space. */
function modelIdWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== '');
}

/** The model id a launch line names with `--model`, where it names one. */
function launchModelId(launch: string): string | null {
  const match = /(?:^|\s)--model(?:=|\s+)([A-Za-z0-9._/-]+)/.exec(launch);
  return match?.[1] ?? null;
}

/** The id on the launch wrapper's banner line, `<id> · API Usage Billing`, where the pane shows
 *  one. This is the reading for a CLI the profile cannot show a model for. */
export function bannerModel(screen: string | undefined): string | null {
  if (screen === undefined) return null;
  for (const line of stripSgr(screen).split('\n')) {
    const match = /([A-Za-z0-9][A-Za-z0-9._-]*)\s*·\s*API Usage Billing/.exec(line);
    if (match) return match[1] ?? null;
  }
  return null;
}

/**
 * What the new pane says the conversation is, compared with the declaration it was launched
 * from. The profile's own model reading comes first (`modelDiffers`); a model it cannot show is
 * read off the wrapper's banner instead, compared by normalized words with the id the recipe's
 * launch line carries — the id a donor seat running the same line shows. Neither reading is
 * `unread`, and `unread` never claims a match.
 */
export function readBackOf(seat: Seat, screen: string | undefined): ReadBack {
  const shown = seatModel(seat, screen);
  if (shown !== null) {
    const want = `${seat.model} ${seat.version}`;
    const got = `${shown.model} ${shown.version}`;
    return modelDiffers(shown, seat) ? { kind: 'mismatch', expected: want, shown: got } : { kind: 'match', model: got };
  }
  const banner = bannerModel(screen);
  if (banner !== null) {
    const expected = launchModelId(seat.launch) ?? seat.model;
    const wanted = modelIdWords(expected);
    const got = modelIdWords(banner);
    const same = wanted.length === got.length && wanted.every((word) => got.includes(word));
    return same ? { kind: 'match', model: banner } : { kind: 'mismatch', expected, shown: banner };
  }
  return { kind: 'unread' };
}

type InspectedSeat =
  /** `takeable`: herdr names this seat on the recorded pane, so `--abandon` would replace it. */
  | { kind: 'replaced'; takeable: boolean }
  | { kind: 'abandon-working' }
  | { kind: 'busy'; message: string }
  | {
      kind: 'ok';
      agent: HerdrAgent | undefined;
      where: DownSeat['state'];
      exitInBox: boolean;
      atExitQuestion: boolean;
      /** The raw screen the unsent box was read from, when its text can be copied and pasted
       *  back: the restart moves it out of the old pane and into the new one. */
      draftScreen?: string;
      /** herdr's own status, when the screen is not recognised but herdr says idle or done. */
      unrecognised?: string;
      /** The screen reads as the CLI's rate limit or provider error and the caller observed it:
       *  the pane cannot answer, so it is closed without typing and never refused as busy. */
      brokenScreen: boolean;
      /** The pane was a `replaced` doubt the caller's `--abandon` takes: close it without typing. */
      taken?: boolean;
    };

function inspectSeat(
  session: string,
  name: string,
  declared: Seat,
  recorded: SeatState | undefined,
  agents: readonly HerdrAgent[],
  abandon: boolean,
  owner: boolean,
  sources: RestartSources,
  broken = false,
  /** Whether an unsent box may be copied and pasted back. A restart does; a swap leaves the
   *  box to the seat's own work — the queue stands and the swap waits, never typing over it. */
  draftCapture = true,
  continuitySession?: string,
): InspectedSeat {
  const proc = recorded?.launched && recorded.pane && sources.upLaunch.processInfo
    ? sources.upLaunch.processInfo(session, recorded.pane)
    : null;
  const verdict = seatProcessVerdict(recorded?.launched, proc);
  const listedOnRecorded = recorded?.pane
    ? agents.find((agent) => agent.name === name && agent.pane === recorded.pane)
    : undefined;
  const continuity = replacedSeat(verdict, {
    asked: true,
    namedOnPane: Boolean(listedOnRecorded),
    // A restart proves continuity with the registry-bound session it can actually resume. Its
    // state-file copy alone cannot bless a restored process when that registry binding is absent.
    recordedSession: draftCapture ? continuitySession : recorded?.agent_session,
    liveSession: listedOnRecorded?.session,
  });
  // A pane whose process is not the recorded one is taken only by an explicit `--abandon`, and
  // only while herdr still names this seat on the recorded pane: the pane is the seat's own, and
  // the caller has said what to do with whatever now runs in front of the launch line. Every
  // other doubt — no name on that pane, or no flag — is left as it is.
  const takeable = abandon && listedOnRecorded !== undefined;
  if (
    ((verdict === 'replaced' && continuity !== 'restored')
      || (continuity === 'doubt' && recorded?.workspace && recorded.pane && recorded.launched))
    && !takeable
  ) {
    return { kind: 'replaced', takeable: listedOnRecorded !== undefined };
  }

  const matched = agents.filter((item) => item.name === name);
  if (matched.length > 1) {
    return { kind: 'busy', message: `${name}: herdr lists more than one agent of this name; left as it is` };
  }
  const agent = matched[0];
  if (!agent) {
    return { kind: 'ok', agent: undefined, where: 'free', exitInBox: false, atExitQuestion: false, brokenScreen: false };
  }

  const liveCwd = sources.foregroundCwd ? sources.foregroundCwd(session, agent.pane) : null;
  const screen = sources.screen(session, agent.pane, declared.cli, liveCwd);
  const profile = profileFor(declared.cli);
  const where = stateOfPane(agent.status, screen, {
    foreground: sources.foreground(session, agent.pane),
    shellBack: sources.shellBack ? sources.shellBack(session, agent.pane) : null,
    processNames: profile?.processNames ?? [],
    cli: declared.cli,
  });
  const holdsExit = where === 'unsent'
    && profile !== null
    && profile.exit !== null
    && boxHoldsText(declared.cli, profile.exit, sources.screenText(session, agent.pane, declared.cli), {
      cwd: liveCwd ?? undefined,
      home: sources.home,
    });
  const clearable = holdsExit && profile?.exitClear !== null;
  // A broken seat is closed without typing: the screen is at the CLI's rate limit or provider
  // error and the caller observed it (`broken`), so the pane cannot run a turn and cannot answer
  // an exit. The screen is read again here, so a seat that recovered between the observation and
  // this inspection is no longer treated as broken. The other blocked screens keep their refusal.
  const brokenScreen = broken && (screen.kind === 'provider error' || screen.kind === 'rate limit');

  if (abandon && !owner && where === 'working') {
    return { kind: 'abandon-working' };
  }
  // herdr's own status is the last word on a seat whose screen the profile cannot read: one
  // herdr reports idle or done is restartable, and its workspace is closed without typing into
  // it. The unread screen is advice on the pre-close line, never a block.
  if (where === 'unknown' && unreadIdle(agent.status)) {
    return {
      kind: 'ok',
      agent,
      where,
      exitInBox: false,
      atExitQuestion: false,
      unrecognised: agent.status,
      brokenScreen: false,
      taken: takeable,
    };
  }
  // Unsent text is not a block: the box is read now, the text is copied under the run lock
  // before the close, and pasted back once the relaunched seat is ready. What keeps the old
  // refusal is a text no measured surface can copy faithfully, and a seat herdr reports
  // mid-turn — its turn is not this command's to end. The CLI's own exit text in the box is
  // never pasted into the new pane; it stays the clearable case above.
  if (draftCapture && where === 'unsent' && !abandon && !clearable && !holdsExit) {
    if (profile !== null && profile.input !== null && (agent.status === 'idle' || agent.status === 'done')) {
      const raw = sources.screenText(session, agent.pane, declared.cli);
      const capture = raw === undefined ? { why: 'but its screen could not be read' } : captureDraft(declared.cli, raw);
      if ('text' in capture) {
        return {
          kind: 'ok',
          agent,
          where,
          exitInBox: false,
          atExitQuestion: false,
          draftScreen: raw ?? '',
          brokenScreen,
          taken: takeable,
        };
      }
      return {
        kind: 'busy',
        message: `${name} holds unsent text in its input box ${capture.why}; left as it is (the owner clears it in its pane, or team restart ${name} --abandon closes it)`,
      };
    }
    // No measured clear-and-paste surface for this CLI, or a seat herdr reports mid-turn: the
    // old word stands below.
  }

  if (where !== 'free' && where !== 'exited' && !abandon && !clearable && !brokenScreen) {
    const way = where !== 'unknown'
      ? ''
      : owner
        ? ` (team restart ${name} --abandon closes its workspace without typing)`
        : ' (run this again once herdr reports the seat idle or done)';
    const held = screen.kind === 'exit question'
      ? `sits at its own exit question; left as it is (team restart ${name} --abandon closes it)`
      : where === 'unsent' && holdsExit
        ? `holds this CLI's exit text (${profile?.exit}) unsent in its input box; left as it is (the owner sends it or clears it in its pane)`
        : LEFT[where];
    return { kind: 'busy', message: `${name} ${held}${way}` };
  }

  return {
    kind: 'ok',
    agent,
    where,
    exitInBox: clearable,
    atExitQuestion: screen.kind === 'exit question',
    brokenScreen,
    taken: takeable,
  };
}

type Running = { name: string; vendor: string; temporary: boolean };

function runningOf(agents: readonly HerdrAgent[], team: TeamFile, state: SessionState): Running[] {
  const seats = new Map(team.seats.map((seat) => [seat.name, seat]));
  const running: Running[] = [];
  for (const agent of agents) {
    if (!agent.name) continue;
    const seat = seats.get(agent.name);
    const known = state.seats[agent.name];
    const like = known?.temporary ? seats.get(known.temporary.like) : undefined;
    running.push({
      name: agent.name,
      vendor: seat?.vendor ?? like?.vendor ?? 'unknown',
      temporary: !seat || Boolean(known?.temporary),
    });
  }
  return running;
}

function ceilingProblem(ceilings: Ceilings, running: readonly Running[], seat: Seat): string | null {
  if (running.some((item) => item.name === seat.name)) return null;
  if (running.length + 1 > ceilings.seats) {
    return `the file allows ${ceilings.seats} seats; ${running.length + 1} would be running`;
  }
  const cap = ceilings.vendors[seat.vendor];
  if (cap !== undefined) {
    const vendors = running.filter((item) => item.vendor === seat.vendor || item.vendor === 'unknown').length + 1;
    if (vendors > cap) return `the file allows ${cap} ${seat.vendor} seats; ${vendors} would be running`;
  }
  return null;
}

function buildUpSeat(
  standing: Standing,
  team: TeamFile,
  seat: Seat,
  start: { cwd: string; lobby?: true },
  root: string,
  home: string,
  live = false,
): UpSeat {
  return {
    name: seat.name,
    cli: seat.cli,
    launch: seat.launch,
    cwd: start.cwd,
    label: workspaceLabel(seat),
    displayAgent: displayAgent(seat),
    model: seat.model,
    version: seat.version,
    repairLine: relaunchRepair(team, seat.name, 'markdown'),
    stopped: false,
    // A human's pane: no launch, no key, no line. The plan skips it before any of that.
    ...(seat.human ? { human: true as const } : {}),
    rules: rulesOf(team, seat, root),
    sessionName: sessionDisplayName({
      seat: seat.name,
      nickname: seat.nickname ?? null,
      team: teamIdOf(root),
      teamName: team.project,
      mode: senderNameModeFor({ home, root, seat: seat.name, file: team }),
    }),
    ...seatDeliveryOf(standing, team, seat, root, home, live),
    ...(start.lobby ? { lobby: true } : {}),
  };
}

function hostOf(input: {
  dir: string;
  session: string;
  team: TeamFile;
  root: string;
  home: string;
  /** The command whose relaunch this host serves: its log lines carry the word, and a session
   *  it closes on the way ends with its reason. */
  command: PerformCommand;
  endReason: 'restart' | 'swap';
  /** The recorded conversation the launch resumed, when it did. */
  resume?: string;
  /** The handover file the new conversation was told to read first. */
  handover?: string;
  ceilings: Ceilings;
  running: Running[];
  seat: Seat;
  caller: string;
  owner: boolean;
  devMode: boolean;
  now(): Date;
  launch: Launch;
  io: Io;
  standing: Standing;
  teamFile: string;
  startCwd: string;
  inLobby: boolean;
  records: Progress;
  doctor: DoctorSources;
  /** The claim this launch's general seat brief was delivered at, with the digest and the stage
   *  the delivery finalized it to. `record` writes the pane diagnostics onto the state's claim
   *  only while every field still matches: a claim a recovery or a replacement delivery wrote in
   *  between is left exactly as it is. */
  brief?: { id: string; incarnation: string; epoch: string; sha256: string; stage: 'claimed' | 'ready' };
}): Host {
  const { dir, session, launch, seat, records } = input;
  const running = [...input.running];
  return {
    startServer: launch.startServer,
    sessionUp: launch.sessionUp,
    createWorkspace: launch.createWorkspace,
    confirmLobby: () => null,
    paneRun: launch.paneRun,
    ...(launch.codexEndpoint === undefined
      ? {}
      : {
          managedCodexEndpoint: (endpoint: { dir: string; session: string; seat: string; cwd?: string }) => launch.codexEndpoint!.managed(endpoint),
          stopManagedCodexEndpoint: (endpoint: { dir: string; session: string; seat: string }) => launch.codexEndpoint!.stop(endpoint),
        }),
    ...(launch.registerInbox
      ? { registerInbox: (cli: string, seat: string, cwd: string, teamFile?: string) => launch.registerInbox!(cli, seat, cwd, teamFile) }
      : {}),
    ...(launch.reportDisplayAgent
      ? { reportDisplayAgent: (s: string, pane: string, text: string) => launch.reportDisplayAgent!(s, pane, text) }
      : {}),
    typeLine: () => false,
    deliverRules: async (s, pane, cli, file, seconds) => {
      const devProject = input.standing.kind !== 'verified' || input.caller === 'owner' ? input.team.project : undefined;
      const written = writeRulesFile(input.standing, file.seat, input.root, input.home, file.text, rulesFileHash(file.text), undefined, devProject);
      if (!written.ok) return fileRefusalOf(written);
      if (!typeablePath(file.path)) {
        return { stop: 'path', typed: false, sent: false, kind: 'unknown' as const, row: null };
      }
      const stopped: { why: Refusal | null } = { why: null };
      const delivered = await deliverRules(cli, file.line, seconds, {
        screen: () => launch.paneText(s, pane) ?? undefined,
        status: () => launch.agentStatus?.(s, pane) ?? null,
        type: (value) => launch.typeText?.(s, pane, value) ?? false,
        enter: () => launch.pressEnter?.(s, pane) ?? false,
        file: () => rulesFileHolds(file.path, rulesFileHash(file.text)),
        foreground: () => launch.foreground(s, pane),
        report: (why) => {
          stopped.why = why;
        },
        now: () => input.now().getTime(),
        sleep: launch.sleep,
      });
      return delivered === false && stopped.why !== null ? stopped.why : delivered;
    },
    renameAgent: launch.renameAgent,
    closeWorkspace: launch.closeWorkspace,
    stopSession: () => false,
    dialog: { mode: 'keep' },
    recordWaiting(name, waiting, pane, workspace) {
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
    },
    kill: () => false,
    agentPanes: launch.agentPanes,
    agentList: launch.agents,
    workspacePanes: launch.workspacePanes ? (s, workspace) => launch.workspacePanes!(s, workspace) : undefined,
    classify: (_name, pane, cli) => readScreen(cli, launch.paneText(session, pane) ?? undefined).kind,
    paneText: (_name, pane) => launch.paneText(session, pane),
    foreground: (_name, pane) => launch.foreground(session, pane),
    shellBack: (_name, pane) => launch.shellBack?.(session, pane) ?? null,
    agentStatus: (_name, pane) => launch.agentStatus?.(session, pane) ?? null,
    processInfo: (_name, pane) => launch.processInfo?.(session, pane) ?? null,
    sleep: launch.sleep,
    now: () => input.now().getTime(),
    allow(name) {
      if (name !== seat.name) return null;
      return ceilingProblem(input.ceilings, running, seat);
    },
    record(name, patch) {
      let replaced: string | undefined;
      updateState(dir, (file) => {
        const current = (file.sessions[session] ??= emptySession());
        const prior = current.seats[name] ?? { stage: patch.stage };
        const retained = current.retained_seats?.[name];
        if (current.retained_seats?.[name]) delete current.retained_seats[name];
        const id = prior.id ?? retained?.id ?? mintSeatId();
        const isTarget = name === seat.name;
        const cli = (isTarget ? seat.cli : undefined) ?? prior.cli;
        const model = (isTarget ? seat.model : undefined) ?? prior.model;
        const version = (isTarget ? seat.version : undefined) ?? prior.version;
        const effort = (isTarget ? seat.effort : undefined) ?? prior.effort;
        const launch_line = (isTarget ? seat.launch : undefined) ?? prior.launch_line;
        const last_active = patch.stage === 'ready'
          ? input.now().toISOString()
          : (prior.last_active ?? retained?.last_active);
        const start_cwd = prior.start_cwd ?? (patch.createdWorkspace ? input.startCwd : undefined);
        const { waiting: written, effort: patchedEffort, ...rest } = patch;
        const seatState: SeatState = {
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
        if (written === null) delete seatState.waiting;
        else if (written) seatState.waiting = written;
        if (patchedEffort === null) delete seatState.effort;
        else if (patchedEffort !== undefined) seatState.effort = patchedEffort;
        current.seats[name] = seatState;
        // The brief's pane diagnostics, written under this same state lock and only while the
        // state still holds the claim this launch was delivered at: id, incarnation, epoch,
        // digest and stage, compared whole. A claim a recovery or a replacement delivery wrote
        // in between is the claim that stands, and nothing here overwrites it.
        const expected = input.brief;
        if (isTarget && patch.pane !== undefined && expected !== undefined) {
          const claim = current.briefs?.[name];
          if (
            claim !== undefined
            && claim.id === expected.id
            && claim.incarnation === expected.incarnation
            && claim.epoch === expected.epoch
            && claim.sha256 === expected.sha256
            && claim.stage === expected.stage
          ) {
            const identity = launchedIdentity(launch.processInfo?.(session, patch.pane) ?? null);
            const diagnosed = { ...claim, seat_handle: id, pane: patch.pane };
            if (identity === null) delete diagnosed.pane_root_pid;
            else diagnosed.pane_root_pid = identity.shell;
            current.briefs![name] = diagnosed;
          }
        }
        if (patch.pane) {
          replaced = prior.pane !== patch.pane ? prior.pane : undefined;
          current.launched_file = input.teamFile;
        }
      });
      if (patch.pane) {
        if (replaced) forgetLaunchedPane(input.home, replaced, session);
        noteLaunchedPane(input.home, input.teamFile, patch.pane, session);
        // The registry: a relaunch keeps the seat's agent and re-points it to the new pane.
        if (name === seat.name) {
          // The state this run just wrote is the registry's reading too: the same seat id and
          // the same agent session, never a second derivation of either.
          const kept = readState(dir).sessions[session]?.seats[name];
          const made = registerLaunch(
            { home: input.home, team: input.team, root: input.root, by: input.caller, session, devMode: input.devMode, owner: input.owner },
            seat,
            patch.pane,
            kept?.id,
            kept?.agent_session,
          );
          if ('note' in made) logLine(dir, input.command, input.caller, made.note, input.now());
          else {
            // The address: the live session socket this relaunch answers at, recorded on the agent.
            const refreshed = refreshAgentAddress(input.home, made.id, patch.pane, session);
            if (refreshed.note) logLine(dir, input.command, input.caller, refreshed.note, input.now());
          }
        }
      }
    },
    // The new session's start, with the id TeamCLI set where the CLI takes one. The old record
    // ended as `restart` before the close; this one names it `previous`.
    sessionStarted(name, started) {
      if (name !== seat.name) return;
      // A resumed launch names no `--session-id` of its own: the id it carries is the recorded
      // conversation's, and the start record is that conversation's session.
      const sessionId = started.cli_session ?? input.resume;
      const began = beginSession({
        home: input.home,
        root: input.root,
        team: input.team,
        session,
        seat,
        pane: started.pane,
        ...(started.workspace === undefined ? {} : { workspace: started.workspace }),
        ...(sessionId === undefined ? {} : { cli_session: sessionId }),
        ...(input.handover === undefined ? {} : { handover: input.handover }),
        now: input.now(),
      });
      if ('note' in began) logLine(dir, input.command, input.caller, began.note, input.now());
    },
    running(name) {
      if (!running.some((item) => item.name === name)) {
        running.push({ name, vendor: seat.vendor, temporary: false });
      }
    },
    drop(name) {
      let pane: string | undefined;
      updateState(dir, (file) => {
        const current = file.sessions[session];
        if (!current) return;
        const prior = current.seats[name];
        pane = prior?.pane;
        if (prior?.id && !prior.temporary) {
          (current.retained_seats ??= {})[name] = {
            id: prior.id,
            ...(prior.last_active ? { last_active: prior.last_active } : {}),
          };
        }
        delete current.seats[name];
      });
      if (pane) forgetLaunchedPane(input.home, pane, session);
      if (name === seat.name) {
        const ended = registerEnd({ home: input.home, team: input.team, root: input.root, by: input.caller, session }, name, 'stopped', input.endReason);
        if (ended) logLine(dir, input.command, input.caller, ended.note, input.now());
      }
    },
    say: (line) => input.io.stderr(plainText(line)),
    progress: (name, state) => records.progress(name, state),
    final: (name, record) => records.final(name, record),
    detail: (line) => records.detail(line),
    cliVersion(cli) {
      const prof = profileFor(cli);
      return prof ? input.doctor.version(prof.binary) : null;
    },
    log: (who, what) => logLine(dir, input.command, input.caller, `${who}: ${what}`, input.now()),
  };
}

/** Where a restart keeps the text it moves out of an unsent box: under the state folder, away
 *  from the drop scans, one file per seat and session. */
export function restartDraftPath(dir: string, session: string, name: string): string {
  return join(dir, 'restart-drafts', session, `${name}.draft`);
}

/** The clause a refusal carries while a copy exists: the text is safe there, never lost with
 *  the pane. */
function keptAt(copy: string | undefined): string {
  return copy === undefined ? '' : `; its unsent text is copied at ${copy}`;
}

/** Writes the copy before the pane is closed: 0600 in a 0700 folder, the same write a drop
 *  file makes. An identical copy is reused; one holding different text is an earlier restart's
 *  and is never overwritten — the box is left as it is and the old copy keeps its words. */
function keepRestartDraft(
  dir: string,
  session: string,
  name: string,
  text: string,
): { path: string } | { why: string } {
  const path = restartDraftPath(dir, session, name);
  try {
    if (readFileSync(path, 'utf8') === text) return { path };
    return { why: `a different copy already sits at ${path}` };
  } catch {
    // Absent, or unreadable: the write below is the one that says which.
  }
  try {
    const store = dirname(path);
    mkdirSync(store, { recursive: true });
    chmodSync(join(dir, 'restart-drafts'), 0o700);
    chmodSync(store, 0o700);
    dropMessage(store, `${name}.draft`, text);
    return { path };
  } catch (error) {
    return { why: `its text could not be copied (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** Removes the copy once the text is verified back in the new box. One that will not unlink is
 *  left: the safe side is a copy too many, never one too few. */
function removeRestartDraft(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Left in place; nothing reads it as a drop.
  }
}

/** Pastes the captured text into the relaunched seat's own box and reads it back as its rows —
 *  the same bracketed paste and verification a delivery's restore makes. The paste only goes
 *  to a pane herdr reports idle or done: anything else keeps the text in its copy. */
async function restoreRestartDraft(
  launch: Launch,
  session: string,
  pane: string,
  cli: string,
  text: string,
): Promise<{ ok: boolean; note?: string }> {
  const status = launch.agentStatus?.(session, pane) ?? null;
  if (status !== 'idle' && status !== 'done') {
    return { ok: false, note: status === null ? 'the pane status could not be read' : `the pane reads ${status}` };
  }
  const host: DeliverHost = {
    typeText: (id, value) => launch.typeText?.(session, id, value) ?? false,
    pressEnter: (id) => launch.pressEnter?.(session, id) ?? false,
    status: (id) => launch.agentStatus?.(session, id) ?? null,
    wait: launch.sleep,
    readAnsi: (id) => launch.paneText(session, id),
  };
  return pasteDraftBack(host, pane, cli, text);
}

function where(problem: Problem): string {
  return problem.line ? `line ${problem.line}: ` : '';
}

function usage(out: Io, json: boolean, message: string): number {
  refuse(out, json, 'restart', { id: 'restart.usage', message, repair: null, usage: USAGE });
  // exit: restart.usage
  return 2;
}

function configuration(out: Io, json: boolean, message: string): number {
  refuse(out, json, 'restart', { id: 'restart.configuration', message, repair: null });
  // exit: restart.configuration
  return 2;
}

function clientRefused(out: Io, json: boolean, message: string): number {
  refuse(out, json, 'restart', { id: 'restart.client-refused', message: plainText(message), repair: null });
  // exit: restart.client-refused
  return 1;
}

function detachedExit(out: Io, json: boolean, message: string): number {
  refuse(out, json, 'restart', { id: 'restart.detached', message, repair: null });
  // exit: restart.detached
  return 1;
}

/** The one command that unblocks a `restart` this caller cannot run: a `leads` seat's own, from
 *  its pane, or the owner's, in this folder from a terminal outside herdr. The caller's words are
 *  kept, the dry run's and the document's own flags dropped, so the printed line is a command
 *  that runs. */
function unblockingRestartRun(argv: string[]): string {
  const words = ['team', 'restart', ...withoutOutputFlags(argv).map(shellQuote)];
  return `a \`leads\` seat runs \`${words.join(' ')}\` from its own pane (the owner runs it from this folder, at a terminal outside herdr)`;
}

/** The caller's words without this run's own output flags: the repair names a command that
 *  runs on a terminal, so neither the dry run nor the document belongs in it. */
function withoutOutputFlags(argv: string[]): string[] {
  return argv.filter((word) => word !== '--dry-run' && word !== '--json' && !word.startsWith('--json='));
}

/** The gate's refusal: the sentence on stderr, or, with `dryAnswer`, the dry run's own words on
 *  stdout — the same outcome either way, so both leave through this one exit site. Under
 *  `--json` it is the `team.error` document, with the gate's rule on it. */
function callerRefused(
  out: Io,
  json: boolean,
  message: string,
  dryAnswer?: string,
  rule?: string,
  repair?: string,
): number {
  if (json) {
    refuse(out, true, 'restart', {
      id: 'restart.caller',
      message,
      repair: repair ?? null,
      ...(rule !== undefined ? { rule } : {}),
    });
  } else if (dryAnswer === undefined) out.stderr(`team restart: ${plainText(message)}\n`);
  else out.stdout(dryAnswer);
  // exit: restart.caller
  return 1;
}

function selfRefused(out: Io, json: boolean, callerName: string): number {
  refuse(out, json, 'restart', {
    id: 'restart.self',
    message: `the ${callerName} cannot restart its own recorded pane; another \`leads\` seat (or the owner) restarts it`,
    repair: null,
  });
  // exit: restart.self
  return 1;
}

function temporaryRefused(out: Io, json: boolean, name: string, like: string): number {
  refuse(out, json, 'restart', {
    id: 'restart.temporary',
    message: `${name} is a temporary copy; use team remove ${name} then team add --temporary --like ${like}`,
    repair: `team remove ${name} then team add --temporary --like ${like}`,
  });
  // exit: restart.temporary
  return 1;
}

function unknownRefused(out: Io, json: boolean, name: string): number {
  refuse(out, json, 'restart', {
    id: 'restart.unknown',
    message: `${name} is not a signed declared seat`,
    repair: 'team seats lists the seats the file declares',
  });
  // exit: restart.unknown
  return 1;
}

function leadRefused(out: Io, json: boolean, callerText: string): number {
  refuse(out, json, 'restart', {
    id: 'restart.lead',
    message: `a seat caller does not abandon the orchestrator's or the operator's seat; this call is ${callerText}`,
    repair: null,
  });
  // exit: restart.lead
  return 1;
}

function signedOffRefused(out: Io, json: boolean, name: string): number {
  refuse(out, json, 'restart', {
    id: 'restart.signed-off',
    message: `${plainLine(name)} is signed off; the owner takes the sign-off off in the file and runs team up`,
    repair: 'the owner takes the sign-off off in the file, then runs team up',
  });
  // exit: restart.signed-off
  return 1;
}

function herdrRefused(out: Io, json: boolean): number {
  refuse(out, json, 'restart', { id: 'restart.herdr', message: "herdr doesn't answer", repair: null });
  // exit: restart.herdr
  return 1;
}

function noSessionRefused(out: Io, json: boolean, session: string): number {
  refuse(out, json, 'restart', {
    id: 'restart.no-session',
    message: `session "${session}" is not running; run team up first`,
    repair: 'team up',
  });
  // exit: restart.no-session
  return 1;
}

function replacedRefused(out: Io, json: boolean, name: string, takeable = false): number {
  refuse(out, json, 'restart', {
    id: 'restart.replaced',
    message: `${name} has a process in its old pane that is not the signed seat; left as it is`,
    // herdr names the seat on that pane: the caller's own `--abandon` replaces it, without a key.
    repair: takeable ? `team restart ${name} --abandon` : null,
  });
  // exit: restart.replaced
  return 1;
}

function abandonWorkingRefused(out: Io, json: boolean, name: string): number {
  refuse(out, json, 'restart', {
    id: 'restart.abandon-working',
    message: `${name} is working; a seat's --abandon leaves it (the owner's --abandon closes it)`,
    repair: null,
  });
  // exit: restart.abandon-working
  return 1;
}

function busyRefused(out: Io, json: boolean, message: string): number {
  refuse(out, json, 'restart', { id: 'restart.busy', message, repair: null });
  // exit: restart.busy
  return 1;
}

function notReadyRefused(out: Io, json: boolean, message: string): number {
  refuse(out, json, 'restart', { id: 'restart.not-ready', message, repair: null });
  // exit: restart.not-ready
  return 1;
}

function runLockRefused(out: Io, json: boolean, held: number, session: string, dir: string): number {
  refuse(out, json, 'restart', { id: 'restart.run-lock', message: runLockText(held, session, dir), repair: null });
  // exit: restart.run-lock
  return 1;
}

function dryRunExit(
  out: Io,
  json: boolean,
  text: string,
  spec: { project: string; session: string; seat: string; plan: readonly PlanStep[]; notes: readonly string[] },
): number {
  if (json) {
    writeJson(out, 'team.restart', {
      format: 1 as const,
      dry_run: true,
      status: 'dry-run',
      action_summary: 'dry run: nothing was run',
      project: spec.project,
      session: spec.session,
      seat: spec.seat,
      plan: spec.plan,
      ...(spec.notes.length > 0 ? { notes: spec.notes } : {}),
    });
  } else {
    out.stdout(text);
  }
  // exit: restart.dry-run
  return 0;
}

function readyExit(
  out: Io,
  json: boolean,
  dir: string,
  who: string,
  name: string,
  fromPane: string,
  toPane: string,
  now: Date,
  project: string,
  session: string,
  notes: readonly string[],
): number {
  logLine(dir, 'restart', who, `restarted ${name}; pane ${fromPane} -> ${toPane}`, now);
  const summary = `team restart: restarted ${plainLine(name)}; pane ${plainLine(fromPane)} -> ${plainLine(toPane)}`;
  if (json) {
    writeJson(out, 'team.restart', {
      format: 1 as const,
      dry_run: false,
      status: 'ready',
      action_summary: summary,
      project,
      session,
      seat: name,
      pane: toPane,
      notes,
    });
  } else {
    out.stdout(`${summary}\n`);
  }
  // exit: restart.ready
  return 0;
}
