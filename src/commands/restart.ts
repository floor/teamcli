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
import { deliverGeneralBrief } from '../launch/general-brief.ts';
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
import { hasJsonFlag, planStepsOf, refuse, writeJson, type PlanStep } from '../output/index.ts';
import { shellQuote } from '../profiles/profile.ts';
import { profileFor } from '../profiles/index.ts';
import { emptySession, mintSeatId, readState, updateState, type SeatState, type SessionState } from '../state.ts';
import { registerEnd, registerLaunch } from '../registry/sync.ts';
import { refreshAgentAddress } from '../send/address.ts';
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
  // A bad option stops the parser before `--json` is read when it comes first, and the
  // structured refusal is still the one the caller asked for.
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['session', 'file'], ['abandon', 'dry-run', 'json']);
  if (args.error || args.rest.length !== 1) {
    const reason = args.error ?? (args.rest.length > 1 ? `unexpected "${plainLine(args.rest[1] ?? '')}"` : 'a seat name is required');
    return usage(out, json, reason);
  }
  const name = args.rest[0] ?? '';
  const abandon = args.flags.has('abandon');
  const dry = args.flags.has('dry-run');
  // Collapsed notes: what plain output writes to stdout while it works (the pre-close readings,
  // the stop's own lines) ride on the document instead.
  const notes: string[] = [];
  const noteIo: Io = json
    ? { ...out, stdout: (text: string) => { notes.push(...text.split('\n').filter((line) => line !== '')); } }
    : out;

  const walked = walkCaller(io);
  const detached = detachedRefusal(walked, { who: 'the owner or a `leads` seat', where: 'a terminal outside herdr or its own pane' });
  if (detached !== undefined) return detachedExit(out, json, detached);

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
  const mayRun = mayChange.kind === 'no-pane' ? noPaneRefusal(mayChange.name)
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

  // Inspect the target seat's current pane before any preflight or stop.
  const inspected = inspectSeat(session, name, declared, recordedSeat, agents, abandon, caller.kind === 'owner', sources);
  if (inspected.kind === 'replaced') return replacedRefused(out, json, name);
  if (inspected.kind === 'abandon-working') return abandonWorkingRefused(out, json, name);
  if (inspected.kind === 'busy') return busyRefused(out, json, inspected.message);

  // Preflight the relaunch before stopping the seat so a preflight refusal leaves the seat running.
  const profile = profileFor(declared.cli);
  if (!profile) {
    return notReadyRefused(out, json, `no launch profile for \`${plainLine(declared.cli)}\` in this version`);
  }
  for (const problem of placedProblems(team, root, sources.home, undefined, session)) {
    return notReadyRefused(out, json, problem.message);
  }
  const start = seatStart({ ...team, session }, declared, root, sources.home);
  if ('problem' in start) {
    return notReadyRefused(out, json, start.problem);
  }
  const doctorTeam = { ...team, seats: [declared] };
  for (const finding of doctorFindings(doctorTeam, root, dir, session, sources.doctor, [], standing, team)) {
    if (blocksLaunch(finding)) {
      if (finding.text.includes('team approve') || finding.text.includes('never approved')) continue;
      if (finding.text.includes(' is read at start by ')) continue;
      return notReadyRefused(out, json, finding.text);
    }
  }
  const samples: SwapSample[] = [];
  const machineNow = sources.machine?.(root);
  const machineProblem = machineNow ? launchLimit(machineNow, team.machine, samples, sources.now().getTime()) : null;
  if (machineProblem) return notReadyRefused(out, json, machineProblem);

  const remainingAgents = agents.filter((agent) => agent.name !== name);
  const runningSeats = runningOf(remainingAgents, team, recordedSession);
  const room = ceilingProblem(ceilings, runningSeats, declared);
  if (room) return notReadyRefused(out, json, room);

  const budgets = budgetsInForceOf(standing, team);
  const budgetDecision = (sources.seatBudget ?? seatBudget)(
    budgets,
    loadReadings(dir),
    declared,
    sources.now().getTime(),
    loadSpendReadings(dir),
  );
  if (budgetDecision.kind === 'refuse') {
    return notReadyRefused(out, json, budgetDecision.why);
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
      teamFile: path,
      cliHooks: plannedCliHooks(dir, session, [planSeat]),
      watchLabel: watchLabel(team.project),
    });
    // The stop comes before the launch the plan prints; a seat that is not running is a skip.
    const stopPlan: PlanStep[] = inspected.agent
      ? [{ step: 'stop', seat: name, detail: `stop ${name} in ${inspected.agent.pane} (${inspected.where})`, prefix: '+' }]
      : [{ step: 'stop', seat: name, detail: 'not currently running', prefix: 'skip' }];
    return dryRunExit(out, json, `${stopStep}${advice}${plainText(formatPlan(preview))}`, {
      project: team.project,
      session,
      seat: name,
      plan: [...stopPlan, ...planStepsOf(preview)],
      notes,
    });
  }

  const runLock = acquireRunLock(dir, session);
  if ('held' in runLock) {
    return runLockRefused(out, json, runLock.held, session, dir);
  }
  try {
    const freshAgents = sources.agents(session);
    if (freshAgents === null) return herdrRefused(out, json);
    const freshSession = readState(dir).sessions[session] ?? emptySession();
    const freshRecorded = freshSession.seats[name];
    const rechecked = inspectSeat(session, name, declared, freshRecorded, freshAgents, abandon, caller.kind === 'owner', sources);
    if (rechecked.kind === 'replaced') return replacedRefused(out, json, name);
    if (rechecked.kind === 'abandon-working') return abandonWorkingRefused(out, json, name);
    if (rechecked.kind === 'busy') return busyRefused(out, json, rechecked.message);

    const who = describeCaller(caller);
    const oldPane = rechecked.agent?.pane ?? freshRecorded?.pane ?? 'none';

    if (rechecked.agent) {
      // Print the three pre-close facts before stopping or closing the seat's workspace. Under
      // `--json` they are collapsed notes on the document instead. A screen the profile cannot
      // read is not claimed empty: its input box was not read.
      const box = rechecked.unrecognised !== undefined
        ? 'not read (the screen is not recognised)'
        : rechecked.where === 'unsent' ? 'holds unsent text' : 'empty';
      noteIo.stdout(`${plainLine(name)}: input box: ${box}\n`);
      noteIo.stdout(`${plainLine(name)}: turn: ${rechecked.where === 'working' ? 'mid-turn (working)' : `not working (${rechecked.where})`}\n`);
      noteIo.stdout(`${plainLine(name)}: context: workspace close ends the pane; relaunch runs "${plainLine(declared.launch)}" in a new workspace without passing the old transcript\n`);
      if (rechecked.unrecognised !== undefined) {
        noteIo.stdout(`${unreadAdvice(name, rechecked.unrecognised)}\n`);
      }

      const stopped = await stopRunning({
        io: noteIo,
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
        return busyRefused(out, json, `${name} could not be stopped; left as it is`);
      }
      if (sources.upLaunch.agentPanes(session)?.includes(rechecked.agent.pane)) {
        return busyRefused(out, json, `${name} did not close its old pane; left as it is`);
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

    const records = progressWriter(
      json
        ? { stdout: () => {}, stderr: (text) => { notes.push(...text.split('\n').filter((line) => line !== '')); }, isTTY: false }
        : { stdout: io.stdout, stderr: io.stderr, isTTY: io.stdoutIsTTY ?? false },
    );
    // The state hook lands before the plan types the launch line. A seat whose settings file did
    // not land is said once, in the log, and relaunches with the file's own line.
    const plannedHooks = plannedCliHooks(dir, session, [planSeat]);
    const installed = installCliHooks(dir, session, [planSeat], { project: team.project, root, home: sources.home });
    if (plannedHooks[planSeat.name] !== undefined && installed[planSeat.name] === undefined) {
      logLine(dir, 'restart', who, `${planSeat.name}: no state hook written; its launch line is the file's own`, sources.now());
    }
    const plan = upPlan({
      root,
      session,
      sessionRunning: true,
      seats: [planSeat],
      watchAlive: true,
      teamFile: path,
      cliHooks: installed,
      watchLabel: watchLabel(team.project),
    });
    // The general seat brief goes first, before the plan types a rules line into the pane: one
    // signed drop. A delivery that cannot be written is said and logged, and the launch goes on;
    // `team check` names the seat with no record.
    const briefs = deliverGeneralBrief({
      dir,
      root,
      session,
      seats: [planSeat.name],
      home,
      at: (sources.now?.() ?? new Date()).toISOString(),
    });
    const briefLine = (said: string): void => {
      if (json) notes.push(said);
      else out.stderr(`team restart: ${plainText(said)}\n`);
      logLine(dir, 'restart', who, said, sources.now());
    };
    for (const delivery of briefs.deliveries) {
      if (!delivery.ok) briefLine(`${delivery.seat}: the general seat brief was not delivered (${delivery.reason})`);
    }
    if (briefs.recording !== undefined) briefLine(`the general seat brief was written and not recorded (${briefs.recording})`);
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
      io: json
        ? { ...out, stdout: () => {}, stderr: (text: string) => { notes.push(...text.split('\n').filter((line) => line !== '')); } }
        : out,
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
      return notReadyRefused(out, json, `${name} did not reach a ready prompt`);
    }
    return readyExit(out, json, dir, who, name, oldPane, afterwards.pane, sources.now(), team.project, session, notes);
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

function replacedRefused(out: Io, json: boolean, name: string): number {
  refuse(out, json, 'restart', {
    id: 'restart.replaced',
    message: `${name} has a process in its old pane that is not the signed seat; left as it is`,
    repair: null,
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
