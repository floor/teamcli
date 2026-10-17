import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
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
import { devModeCallerGate, devModeExpiryNote, devModeMark, logDevMode, logDevModeState, resolveDevMode } from '../dev_mode.ts';
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
import { shellQuote } from '../profiles/profile.ts';
import { profileFor } from '../profiles/index.ts';
import { emptySession, mintSeatId, readState, updateState, type SeatState, type SessionState } from '../state.ts';
import { registerEnd, registerLaunch } from '../registry/sync.ts';
import { refreshAgentAddress } from '../send/address.ts';
import { approvalStanding, type Ceilings, type Standing } from '../store/store.ts';
import { launchLimit, readMachine, readingsText, type Machine, type SwapSample } from '../watch/machine.ts';
import { watchLabel } from '../watch/pane.ts';
import { readScreen } from '../watch/screen.ts';
import { seatStart } from '../worktree/place.ts';
import { blocksLaunch, doctorFindings, realSources as doctorSources, type DoctorSources } from './doctor.ts';
import { realSources as downSources, stateOfPane } from './down.ts';
import { stopRunning, type RemoveSources } from './remove.ts';
import type { Launch } from './up.ts';

export const USAGE = 'Usage: team restart <seat> [--abandon] [--dry-run] [--session <name>] [--file <path>]\n';

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
  const out = cleanedIo(io);
  const args = readArgs(argv, ['session', 'file'], ['abandon', 'dry-run']);
  if (args.error || args.rest.length !== 1) {
    const reason = args.error ?? (args.rest.length > 1 ? `unexpected "${plainLine(args.rest[1] ?? '')}"` : 'a seat name is required');
    return usage(out, reason);
  }
  const name = args.rest[0] ?? '';
  const abandon = args.flags.has('abandon');
  const dry = args.flags.has('dry-run');

  const walked = walkCaller(io);
  const detached = detachedRefusal(walked);
  if (detached !== undefined) return detachedExit(out, detached);

  const flagRefusal = fileOwnerRefusal(io, args.values.file)
    ?? (args.values.session !== undefined && !isOwner(walked) ? sessionOwnerRefusal(walked) : undefined);
  if (flagRefusal !== undefined) return callerRefused(out, flagRefusal);

  const launched = args.values.file ? undefined : launchedTeamFile(io, sources.home);
  const loaded = loadTeamFile(io.cwd, {
    ...(args.values.file ?? launched ? { file: args.values.file ?? launched } : {}),
    home: sources.home,
    // The session this run addresses: the placement check reads that session's recorded lobby.
    ...(args.values.session !== undefined ? { session: args.values.session } : {}),
  });
  if (!loaded.ok) {
    return configuration(out, loaded.errors.map((problem) => `${where(problem)}${plainText(problem.message)}`).join('\n'));
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
    return callerRefused(out, 'session can\'t be "default", herdr\'s own session');
  }

  const standing = sources.standing?.(root) ?? approvalStanding(root, sources.home);
  if (standing.kind !== 'verified' && standing.kind !== 'none') {
    return callerRefused(out, notInForce(standing));
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
  const mayRun = mayChange.kind === 'no-pane' ? noPaneRefusal(mayChange.name)
    : mayChange.kind === 'another-pane' ? anotherPaneRefusal(mayChange.name, mayChange.recordedPane)
      : mayChange.kind === 'refused' ? `only the owner or \`leads\` restarts a seat; this call is ${plainLine(describeCaller(shown))}${devModeExpiryNote(dev)}`
        : null;
  if (mayRun !== null) {
    const folded = devModeCallerGate(dev, mayRun);
    if (folded !== null) {
      devFolded = true;
      if (dry) out.stdout(`! ${folded}\n`);
      else {
        out.stderr(`team restart: ${plainText(folded)}\n`);
        logDevMode(dir, 'restart', describeCaller(caller), folded, sources.now());
      }
    } else {
      // The dry answer names the refusal and the one command that unblocks it, on stdout where
      // a dry run's answers go; both paths exit through the refusal's one exit site below.
      return callerRefused(
        out,
        mayRun,
        dry ? `! restart would refuse: ${plainText(mayRun)}\n! to unblock: ${plainText(ownerRestartRun(argv))}\n` : undefined,
      );
    }
  }

  const recordedSession = readState(dir).sessions[session] ?? emptySession();
  const recordedSeat = recordedSession.seats[name];
  if (caller.kind === 'seat' && (caller.name === name || (recordedSeat?.pane !== undefined && caller.pane === recordedSeat.pane))) {
    return selfRefused(out, caller.name);
  }

  const declared = team.seats.find((seat) => seat.name === name);
  if (recordedSeat?.temporary && !declared) {
    return temporaryRefused(out, name, recordedSeat.temporary.like);
  }
  if (!declared) {
    return unknownRefused(out, name);
  }
  if (abandon && caller.kind !== 'owner' && (name === team.orchestrator || name === team.operator)) {
    return leadRefused(out, describeCaller(caller));
  }
  if (declared.stopped) {
    return signedOffRefused(out, name);
  }

  const liveState = sources.sessionState(session);
  const running = sources.sessionRunning(session);
  if (liveState === null || running === null) return herdrRefused(out);
  if (liveState !== 'running' || !running) return noSessionRefused(out, session);

  const agents = sources.agents(session);
  const workspaces = sources.workspaces(session);
  if (agents === null || workspaces === null) return herdrRefused(out);

  // Inspect the target seat's current pane before any preflight or stop.
  const inspected = inspectSeat(session, name, declared, recordedSeat, agents, abandon, caller.kind === 'owner', sources);
  if (inspected.kind === 'replaced') return replacedRefused(out, name);
  if (inspected.kind === 'abandon-working') return abandonWorkingRefused(out, name);
  if (inspected.kind === 'busy') return busyRefused(out, inspected.message);

  // Preflight the relaunch before stopping the seat so a preflight refusal leaves the seat running.
  const profile = profileFor(declared.cli);
  if (!profile) {
    return notReadyRefused(out, `no launch profile for \`${plainLine(declared.cli)}\` in this version`);
  }
  for (const problem of placedProblems(team, root, sources.home, undefined, session)) {
    return notReadyRefused(out, problem.message);
  }
  const start = seatStart({ ...team, session }, declared, root, sources.home);
  if ('problem' in start) {
    return notReadyRefused(out, start.problem);
  }
  const doctorTeam = { ...team, seats: [declared] };
  for (const finding of doctorFindings(doctorTeam, root, dir, session, sources.doctor, [], standing, team)) {
    if (blocksLaunch(finding)) {
      if (finding.text.includes('team approve') || finding.text.includes('never approved')) continue;
      if (finding.text.includes(' is read at start by ')) continue;
      return notReadyRefused(out, finding.text);
    }
  }
  const samples: SwapSample[] = [];
  const machineNow = sources.machine?.(root);
  const machineProblem = machineNow ? launchLimit(machineNow, team.machine, samples, sources.now().getTime()) : null;
  if (machineProblem) return notReadyRefused(out, machineProblem);

  const remainingAgents = agents.filter((agent) => agent.name !== name);
  const runningSeats = runningOf(remainingAgents, team, recordedSession);
  const room = ceilingProblem(ceilings, runningSeats, declared);
  if (room) return notReadyRefused(out, room);

  const budgets = budgetsInForceOf(standing, team);
  const budgetDecision = (sources.seatBudget ?? seatBudget)(
    budgets,
    loadReadings(dir),
    declared,
    sources.now().getTime(),
    loadSpendReadings(dir),
  );
  if (budgetDecision.kind === 'refuse') {
    return notReadyRefused(out, budgetDecision.why);
  }

  const liveRules = standing.kind !== 'verified' || caller.kind === 'owner';
  const planSeat = buildUpSeat(standing, team, declared, start, root, sources.home, liveRules);
  if (dry) {
    const stopStep = inspected.agent
      ? `stop ${plainLine(name)} in ${plainLine(inspected.agent.pane)} (${inspected.where})\n`
      : `${plainLine(name)}: not currently running\n`;
    // An unread screen on a seat herdr calls idle is advice: the dry answer says what the run
    // does without typing into it.
    const advice = inspected.unrecognised === undefined
      ? ''
      : `${unreadAdvice(name, inspected.unrecognised)}\n`;
    const preview = upPlan({
      root,
      session,
      sessionRunning: true,
      seats: [planSeat],
      watchAlive: true,
      cliHooks: plannedCliHooks(dir, session, [planSeat]),
      watchLabel: watchLabel(team.project),
    });
    return dryRunExit(out, `${stopStep}${advice}${plainText(formatPlan(preview))}`);
  }

  const runLock = acquireRunLock(dir, session);
  if ('held' in runLock) {
    return runLockRefused(out, runLock.held, session, dir);
  }
  try {
    const freshAgents = sources.agents(session);
    if (freshAgents === null) return herdrRefused(out);
    const freshSession = readState(dir).sessions[session] ?? emptySession();
    const freshRecorded = freshSession.seats[name];
    const rechecked = inspectSeat(session, name, declared, freshRecorded, freshAgents, abandon, caller.kind === 'owner', sources);
    if (rechecked.kind === 'replaced') return replacedRefused(out, name);
    if (rechecked.kind === 'abandon-working') return abandonWorkingRefused(out, name);
    if (rechecked.kind === 'busy') return busyRefused(out, rechecked.message);

    const who = describeCaller(caller);
    const oldPane = rechecked.agent?.pane ?? freshRecorded?.pane ?? 'none';

    if (rechecked.agent) {
      // Print the three pre-close facts before stopping or closing the seat's workspace. A screen
      // the profile cannot read is not claimed empty: its input box was not read.
      const box = rechecked.unrecognised !== undefined
        ? 'not read (the screen is not recognised)'
        : rechecked.where === 'unsent' ? 'holds unsent text' : 'empty';
      out.stdout(`${plainLine(name)}: input box: ${box}\n`);
      out.stdout(`${plainLine(name)}: turn: ${rechecked.where === 'working' ? 'mid-turn (working)' : `not working (${rechecked.where})`}\n`);
      out.stdout(`${plainLine(name)}: context: workspace close ends the pane; relaunch runs "${plainLine(declared.launch)}" in a new workspace without passing the old transcript\n`);
      if (rechecked.unrecognised !== undefined) {
        out.stdout(`${unreadAdvice(name, rechecked.unrecognised)}\n`);
      }

      const stopped = await stopRunning({
        io: out,
        dir,
        session,
        sources,
        logCommand: 'restart',
        caller: who,
        seat: {
          name,
          cli: declared.cli,
          pane: rechecked.agent.pane,
          workspace: rechecked.agent.workspace,
          state: rechecked.where === 'free' ? 'free' : rechecked.where,
          ...(rechecked.exitInBox ? { exitInBox: true } : {}),
          ...(rechecked.atExitQuestion ? { atExitQuestion: true } : {}),
        },
        keep: false,
        // An unrecognised screen on a seat herdr calls idle is closed, not typed into: `abandon`
        // says "close without typing" here, and the owner's own `--abandon` stays what it was.
        abandon: (abandon || rechecked.unrecognised !== undefined) && rechecked.where !== 'free',
        closeUnasked: abandon,
        unasked: `team restart ${name} --abandon closes it`,
      });
      if (!stopped) {
        return busyRefused(out, `${name} could not be stopped; left as it is`);
      }
      if (sources.upLaunch.agentPanes(session)?.includes(rechecked.agent.pane)) {
        return busyRefused(out, `${name} did not close its old pane; left as it is`);
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
      const ended = registerEnd({ home: sources.home, team, root, by: who, session }, name, 'stopped');
      if (ended) logLine(dir, 'restart', who, ended.note, sources.now());
    }

    const records = progressWriter({ stdout: io.stdout, stderr: io.stderr, isTTY: io.stdoutIsTTY ?? false });
    // The state hook lands before the plan types the launch line. A seat whose settings file did
    // not land is said once, in the log, and relaunches with the file's own line.
    const plannedHooks = plannedCliHooks(dir, session, [planSeat]);
    const installed = installCliHooks(dir, session, [planSeat]);
    if (plannedHooks[planSeat.name] !== undefined && installed[planSeat.name] === undefined) {
      logLine(dir, 'restart', who, `${planSeat.name}: no state hook written; its launch line is the file's own`, sources.now());
    }
    const plan = upPlan({
      root,
      session,
      sessionRunning: true,
      seats: [planSeat],
      watchAlive: true,
      cliHooks: installed,
      watchLabel: watchLabel(team.project),
    });
    // The old pane is closed: whatever its last turn wrote says nothing about the seat this
    // plan starts.
    resetCliHookState(dir, session, [planSeat.name]);
    const host = hostOf({
      dir,
      session,
      team: team,
      root,
      home: sources.home,
      ceilings,
      running: runningSeats,
      seat: declared,
      caller: who,
      owner: caller.kind === 'owner',
      devMode: devModeMark(dev, devFolded),
      now: sources.now,
      launch: sources.upLaunch,
      readMachine: sources.machine,
      samples,
      limits: team.machine,
      io: out,
      standing,
      teamFile: path,
      startCwd: planSeat.cwd,
      inLobby: planSeat.lobby === true,
      records,
      doctor: sources.doctor,
    });
    const report = await executePlan(plan, session, host);
    const afterwards = readState(dir).sessions[session]?.seats[name];
    const launchedOk = !report.held && !report.dropped.includes(name) && afterwards?.stage === 'ready' && !report.serverFailed;
    if (!launchedOk || !afterwards?.pane) {
      logLine(dir, 'restart', who, `${name}: launch did not reach ready`, sources.now());
      return notReadyRefused(out, `${name} did not reach a ready prompt`);
    }
    return readyExit(out, dir, who, name, oldPane, afterwards.pane, sources.now());
  } finally {
    runLock.release();
  }
}

type InspectedSeat =
  | { kind: 'replaced' }
  | { kind: 'abandon-working' }
  | { kind: 'busy'; message: string }
  | {
      kind: 'ok';
      agent: HerdrAgent | undefined;
      where: DownSeat['state'];
      exitInBox: boolean;
      atExitQuestion: boolean;
      /** herdr's own status, when the screen is not recognised but herdr says idle or done. */
      unrecognised?: string;
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
    recordedSession: recorded?.agent_session,
    liveSession: listedOnRecorded?.session,
  });
  if (verdict === 'replaced' || (continuity === 'doubt' && recorded?.workspace && recorded.pane && recorded.launched)) {
    return { kind: 'replaced' };
  }

  const matched = agents.filter((item) => item.name === name);
  if (matched.length > 1) {
    return { kind: 'busy', message: `${name}: herdr lists more than one agent of this name; left as it is` };
  }
  const agent = matched[0];
  if (!agent) {
    return { kind: 'ok', agent: undefined, where: 'free', exitInBox: false, atExitQuestion: false };
  }

  const liveCwd = sources.foregroundCwd ? sources.foregroundCwd(session, agent.pane) : null;
  const screen = sources.screen(session, agent.pane, declared.cli, liveCwd);
  const profile = profileFor(declared.cli);
  const where = stateOfPane(agent.status, screen, {
    foreground: sources.foreground(session, agent.pane),
    shellBack: sources.shellBack ? sources.shellBack(session, agent.pane) : null,
    processNames: profile?.processNames ?? [],
  });
  const holdsExit = where === 'unsent'
    && profile !== null
    && boxHoldsText(declared.cli, profile.exit, sources.screenText(session, agent.pane, declared.cli), {
      cwd: liveCwd ?? undefined,
      home: sources.home,
    });
  const clearable = holdsExit && profile?.exitClear !== null;

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
    };
  }
  if (where !== 'free' && where !== 'exited' && !abandon && !clearable) {
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
    rules: rulesOf(team, seat, root),
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
  ceilings: Ceilings;
  running: Running[];
  seat: Seat;
  caller: string;
  owner: boolean;
  devMode: boolean;
  now(): Date;
  launch: Launch;
  readMachine?: (root: string) => Machine;
  samples: SwapSample[];
  limits: TeamFile['machine'];
  io: Io;
  standing: Standing;
  teamFile: string;
  startCwd: string;
  inLobby: boolean;
  records: Progress;
  doctor: DoctorSources;
}): Host {
  const { dir, session, launch, seat, records } = input;
  const running = [...input.running];
  return {
    startServer: launch.startServer,
    sessionUp: launch.sessionUp,
    createWorkspace: launch.createWorkspace,
    confirmLobby: () => null,
    paneRun: launch.paneRun,
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
    shellBack: (_name, pane) => launch.shellBack?.(session, pane) ?? null,
    agentStatus: (_name, pane) => launch.agentStatus?.(session, pane) ?? null,
    processInfo: (_name, pane) => launch.processInfo?.(session, pane) ?? null,
    sleep: launch.sleep,
    now: () => input.now().getTime(),
    allow(name) {
      if (input.readMachine) {
        const machine = input.readMachine(input.root);
        const problem = launchLimit(machine, input.limits, input.samples, input.now().getTime());
        if (problem) {
          logLine(dir, 'restart', input.caller, `refused: ${problem} — readings: ${readingsText(machine)}`, input.now());
          return problem;
        }
      }
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
          const made = registerLaunch(
            { home: input.home, team: input.team, root: input.root, by: input.caller, session, devMode: input.devMode, owner: input.owner },
            seat,
            patch.pane,
            readState(dir).sessions[session]?.seats[name]?.id,
          );
          if ('note' in made) logLine(dir, 'restart', input.caller, made.note, input.now());
          else {
            // The address: the live session socket this relaunch answers at, recorded on the agent.
            const refreshed = refreshAgentAddress(input.home, made.id, patch.pane, session);
            if (refreshed.note) logLine(dir, 'restart', input.caller, refreshed.note, input.now());
          }
        }
      }
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
        const ended = registerEnd({ home: input.home, team: input.team, root: input.root, by: input.caller, session }, name, 'stopped');
        if (ended) logLine(dir, 'restart', input.caller, ended.note, input.now());
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
    log: (who, what) => logLine(dir, 'restart', input.caller, `${who}: ${what}`, input.now()),
  };
}

function where(problem: Problem): string {
  return problem.line ? `line ${problem.line}: ` : '';
}

function usage(out: Io, message: string): number {
  out.stderr(`team restart: ${plainText(message)}\n${USAGE}`);
  // exit: restart.usage
  return 2;
}

function configuration(out: Io, message: string): number {
  out.stderr(`team restart: ${plainText(message)}\n`);
  // exit: restart.configuration
  return 2;
}

function detachedExit(out: Io, message: string): number {
  out.stderr(`team restart: ${plainText(message)}\n`);
  // exit: restart.detached
  return 1;
}

/** The one command that unblocks a `restart` this caller cannot run: the owner's own, in this
 *  folder, at a terminal outside herdr. The caller's words are kept, the dry run's own flag
 *  dropped, so the printed line is a command that runs. */
function ownerRestartRun(argv: string[]): string {
  const words = ['team', 'restart', ...argv.filter((word) => word !== '--dry-run').map(shellQuote)];
  return `the owner runs \`${words.join(' ')}\` from this folder, at a terminal outside herdr`;
}

/** The gate's refusal: the sentence on stderr, or, with `dryAnswer`, the dry run's own words on
 *  stdout — the same outcome either way, so both leave through this one exit site. */
function callerRefused(out: Io, message: string, dryAnswer?: string): number {
  if (dryAnswer === undefined) out.stderr(`team restart: ${plainText(message)}\n`);
  else out.stdout(dryAnswer);
  // exit: restart.caller
  return 1;
}

function selfRefused(out: Io, callerName: string): number {
  out.stderr(`team restart: the ${plainLine(callerName)} cannot restart its own recorded pane; the owner must do it\n`);
  // exit: restart.self
  return 1;
}

function temporaryRefused(out: Io, name: string, like: string): number {
  out.stderr(`team restart: ${plainLine(name)} is a temporary copy; use team remove ${plainLine(name)} then team add --temporary --like ${plainLine(like)}\n`);
  // exit: restart.temporary
  return 1;
}

function unknownRefused(out: Io, name: string): number {
  out.stderr(`team restart: ${plainLine(name)} is not a signed declared seat\n`);
  // exit: restart.unknown
  return 1;
}

function leadRefused(out: Io, callerText: string): number {
  out.stderr(`team restart: a seat caller does not abandon the orchestrator's or the operator's seat; this call is ${plainLine(callerText)}\n`);
  // exit: restart.lead
  return 1;
}

function signedOffRefused(out: Io, name: string): number {
  out.stderr(`team restart: ${plainLine(name)} is signed off; the owner approves the seat back and runs team up\n`);
  // exit: restart.signed-off
  return 1;
}

function herdrRefused(out: Io): number {
  out.stderr("team restart: herdr doesn't answer\n");
  // exit: restart.herdr
  return 1;
}

function noSessionRefused(out: Io, session: string): number {
  out.stderr(`team restart: session "${plainLine(session)}" is not running; run team up first\n`);
  // exit: restart.no-session
  return 1;
}

function replacedRefused(out: Io, name: string): number {
  out.stderr(`team restart: ${plainLine(name)} has a process in its old pane that is not the signed seat; left as it is\n`);
  // exit: restart.replaced
  return 1;
}

function abandonWorkingRefused(out: Io, name: string): number {
  out.stderr(`team restart: ${plainLine(name)} is working; a seat's --abandon leaves it (the owner's --abandon closes it)\n`);
  // exit: restart.abandon-working
  return 1;
}

function busyRefused(out: Io, message: string): number {
  out.stderr(`team restart: ${plainText(message)}\n`);
  // exit: restart.busy
  return 1;
}

function notReadyRefused(out: Io, message: string): number {
  out.stderr(`team restart: ${plainText(message)}\n`);
  // exit: restart.not-ready
  return 1;
}

function runLockRefused(out: Io, held: number, session: string, dir: string): number {
  out.stderr(`team restart: ${plainText(runLockText(held, session, dir))}\n`);
  // exit: restart.run-lock
  return 1;
}

function dryRunExit(out: Io, text: string): number {
  out.stdout(text);
  // exit: restart.dry-run
  return 0;
}

function readyExit(out: Io, dir: string, who: string, name: string, fromPane: string, toPane: string, now: Date): number {
  logLine(dir, 'restart', who, `restarted ${name}; pane ${fromPane} -> ${toPane}`, now);
  out.stdout(`team restart: restarted ${plainLine(name)}; pane ${plainLine(fromPane)} -> ${plainLine(toPane)}\n`);
  // exit: restart.ready
  return 0;
}
