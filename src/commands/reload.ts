import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { describeCaller, isOwner, walkCaller } from '../caller.ts';
import { TEAM_FILE, loadTeamFile } from '../file/load.ts';
import { relaunchRepair } from '../file/sections/lead.ts';
import { displayAgent, workspaceLabel } from '../file/sections/seats.ts';
import type { Seat } from '../file/types.ts';
import { grantGate, logGranted } from '../grant.ts';
import {
  agentList,
  agentRename,
  paneProcesses,
  paneRead,
  paneRun,
  paneShellBack,
  reportDisplayAgent,
  workspaceClose,
  workspaceCreate,
  workspacePanes,
} from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { cleanedIo } from '../io.ts';
import { devModeCallerGate, devModeExpiryNote, logDevMode, logDevModeState, resolveDevMode } from '../dev_mode.ts';
import type { Host } from '../launch/execute.ts';
import { executePlan } from '../launch/execute.ts';
import { installCliHooks, plannedCliHooks, resetCliHookState } from '../launch/cli-hook.ts';
import { plainLine } from '../launch/plain.ts';
import { upPlan } from '../launch/plan.ts';
import { acquireRunLock, runLockText } from '../launch/run-lock.ts';
import { rulesOf } from '../launch/rules.ts';
import { logLine } from '../log.ts';
import { emptySession, readState, updateState, type SeatState } from '../state.ts';
import { modelDiffers } from '../status/statusline.ts';
import { registerEnd, registerLaunch } from '../registry/sync.ts';
import { refreshAgentAddress } from '../send/address.ts';
import { watchLabel } from '../watch/pane.ts';
import { readScreen } from '../watch/screen.ts';
import type { Launch } from './up.ts';

export const USAGE = 'Usage: team reload <seat> [--file <path>]\n';

export type ReloadSources = {
  launch: Launch;
  home?: string;
  now?: () => Date;
  grantGate?: typeof grantGate;
  logGranted?: typeof logGranted;
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

const realLaunch: Launch = {
  sessionState: () => null,
  startServer: () => false,
  sessionUp: () => null,
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
  foreground: (session, pane) => null,
  processInfo: (session, pane) => paneProcesses(pane, aim(session)),
  shellBack: (session, pane) => paneShellBack(pane, aim(session)),
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  now: () => new Date(),
};

const realSources: ReloadSources = {
  launch: realLaunch,
  home: homedir(),
  now: () => new Date(),
};

export const reload: Command = (argv, io) => runReload(argv, io, realSources);
export default reload;

/**
 * `team reload <seat>`: when the file's model, version or effort differs from the launch
 * record, close that seat at an idle prompt and launch the file's line. A ready seat `up`
 * leaves alone stays up. Nothing is closed while the seat is working or the box holds
 * unsent text, and a seat launched before the record existed is refused.
 */
export async function runReload(argv: string[], io: Io, sources: ReloadSources = realSources): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, ['file'], []);
  if (args.error) return invocation(out, args.error);
  const name = args.rest.length === 1 ? args.rest[0] : undefined;
  if (!name) {
    const extra = args.rest[1];
    return invocation(out, extra === undefined ? 'a <seat> is required' : `unexpected "${plainLine(extra)}"`);
  }

  const caller = walkCaller(io);
  const owner = isOwner(caller);
  const flagged = args.values.file;
  const foreign = flagged !== undefined && resolve(io.cwd, flagged) !== resolve(io.cwd, TEAM_FILE);
  // Dev mode, from this folder's own file: the caller's place, never a file the caller names.
  // A `dev-mode` value anywhere in its chain governs, and `TEAMCLI_DEV_MODE` is then ignored;
  // before any such value, the variable set to exactly `1` keeps its behaviour. The grant gate
  // below is the caller gate dev mode folds; the grant's approval, its `caller` and an absent
  // grant are that gate, while its placement (`no-pane`, `another-pane`), its scope list, a
  // file that will not load and the owner's `--file` stay refusals in every mode.
  const policyLoad = loadTeamFile(io.cwd, { ...(sources.home ? { home: sources.home } : {}) });
  const dev = resolveDevMode('reload', io, {
    ...(sources.home ? { home: sources.home } : {}),
    team: policyLoad.ok ? policyLoad.team : null,
    root: policyLoad.ok ? policyLoad.root : null,
    now: sources.now ? sources.now() : new Date(),
  });
  // The configuration lines the run owes once, written where the caller's place is known and
  // before the grant gate — a gate that refuses must not swallow them: the variable ignored
  // under a governing policy, an expiry, a source that could not be read. Nothing is written
  // when the chain had nothing to say.
  const placeDir = policyLoad.ok ? dirname(policyLoad.path) : dirname(join(io.cwd, TEAM_FILE));
  logDevModeState(placeDir, 'reload', describeCaller(caller), dev, sources.now ? sources.now() : new Date());
  let devWarning: string | null = null;
  let grantSeat: string | null = null;
  if (!owner) {
    const said = (sources.grantGate ?? grantGate)({ act: 'reload', io, home: sources.home });
    if (said.kind === 'refused') {
      const foldable = said.id === 'grant.approval' || said.id === 'grant.caller' || said.id === 'grant.omitted';
      const folded = foldable ? devModeCallerGate(dev, said.text) : null;
      if (folded === null) {
        out.stderr(`team reload: ${said.text}${foldable ? devModeExpiryNote(dev) : ''}\n`);
        // exit: reload.grant-another-pane
        // exit: reload.grant-approval
        // exit: reload.grant-caller
        // exit: reload.grant-file
        // exit: reload.grant-no-pane
        // exit: reload.grant-omitted
        // exit: reload.grant-scope
        return 1;
      }
      devWarning = folded;
      out.stderr(`team reload: ${folded}\n`);
    } else {
      grantSeat = said.grant.seat;
    }
    if (foreign) {
      out.stderr(`team reload: --file is the owner's; the granted seat cannot use it\n`);
      // exit: reload.grant-flag
      return 1;
    }
  }

  const loaded = loadTeamFile(io.cwd, {
    ...(owner && flagged ? { file: flagged } : {}),
    ...(sources.home ? { home: sources.home } : {}),
  });
  if (!loaded.ok) {
    for (const problem of loaded.errors) {
      out.stderr(`team reload: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    // exit: reload.file
    return 2;
  }

  const team = loaded.team;
  const seat = team.seats.find((item) => item.name === name);
  if (!seat) {
    out.stderr(`team reload: no seat of that name\n`);
    // exit: reload.absent
    return 1;
  }
  if (grantSeat !== null && seat.name === grantSeat) {
    out.stderr(`team reload: a granted reload does not close the caller's seat\n`);
    // exit: reload.self
    return 1;
  }

  const dir = dirname(loaded.path);
  // The audit line the fold owes: written where the gate is used, before any later refusal
  // ends the run. The configuration lines were already written above, before the gate.
  if (devWarning !== null) logDevMode(dir, 'reload', describeCaller(caller), devWarning, sources.now ? sources.now() : new Date());
  const session = team.session;
  const recorded = readState(dir).sessions[session]?.seats[seat.name];
  if (seat.stopped || !recorded || recorded.stage !== 'ready' || !recorded.pane || !recorded.workspace || !recorded.launched) {
    out.stderr(`team reload: ${seat.name} has no ready pane to close\n`);
    // exit: reload.not-running
    return 1;
  }
  if (recorded.model === undefined || recorded.version === undefined) {
    out.stderr(`team reload: ${seat.name}: its model and effort were not recorded at launch\n`);
    // exit: reload.unrecorded
    return 1;
  }
  const detail = driftOf(recorded, seat);
  if (detail === null) {
    out.stdout(`team reload: ${seat.name} is already running what the file declares\n`);
    // exit: reload.same
    return 0;
  }

  const listed = sources.launch.agents(session)?.find((agent) => agent.name === seat.name);
  if (listed && listed.pane === recorded.pane && listed.workspace === recorded.workspace) {
    const text = sources.launch.paneText(session, recorded.pane);
    const kind = readScreen(seat.cli, text ?? undefined).kind;
    if (listed.status === 'working' || kind === 'working') {
      out.stderr(`team reload: ${seat.name} is working; nothing closed\n`);
      // exit: reload.working
      return 1;
    }
    if (kind === 'unsent') {
      out.stderr(`team reload: ${seat.name} holds unsent text; nothing closed\n`);
      // exit: reload.unsent
      return 1;
    }
    if (!((listed.status === 'idle' || listed.status === 'done') && kind === 'idle')) {
      out.stderr(`team reload: ${seat.name} is not at an idle prompt; nothing closed\n`);
      // exit: reload.not-idle
      return 1;
    }
  }

  const runLock = acquireRunLock(dir, session);
  if ('held' in runLock) {
    out.stderr(`team reload: ${plainLine(runLockText(runLock.held, session, dir))}\n`);
    // exit: reload.run-lock
    return 1;
  }
  try {
    const root = loaded.root;
    const planned = {
      name: seat.name,
      cli: seat.cli,
      launch: seat.launch,
      cwd: seat.cwd,
      label: workspaceLabel(seat),
      displayAgent: displayAgent(seat),
      model: seat.model,
      version: seat.version,
      ...(seat.effort ? { effort: seat.effort } : {}),
      repairLine: relaunchRepair(team, seat.name, 'markdown'),
      stopped: false,
      rules: rulesOf(team, seat, root),
      repair: {
        pane: recorded.pane,
        workspace: recorded.workspace,
        launched: recorded.launched,
        cli: seat.cli,
        reload: { detail },
      },
    };
    // The state hook lands before the plan types the launch line. A seat whose settings file did
    // not land is said once, in the log, and relaunches with the file's own line.
    const plannedHooks = plannedCliHooks(dir, session, [planned]);
    const installed = installCliHooks(dir, session, [planned]);
    if (plannedHooks[planned.name] !== undefined && installed[planned.name] === undefined) {
      logLine(dir, 'reload', describeCaller(caller), `${planned.name}: no state hook written; its launch line is the file's own`,
        sources.now ? sources.now() : new Date());
    }
    const steps = upPlan({
      session,
      root,
      seats: [planned],
      sessionRunning: true,
      startWatch: false,
      cliHooks: installed,
      watchLabel: watchLabel(team.project),
    });
    // The drifted seat is closed: whatever its last turn wrote says nothing about the seat this
    // run starts.
    resetCliHookState(dir, session, [planned.name]);
    const launch = sources.launch;
    const now = sources.now ?? (() => new Date());
    let closed = false;
    const host: Host = {
      agentList: (current) => launch.agents(current),
      workspacePanes: (current, workspace) => launch.workspacePanes?.(current, workspace) ?? null,
      processInfo: (current, pane) => launch.processInfo?.(current, pane) ?? null,
      paneText: (current, pane) => launch.paneText(current, pane),
      classify(current, pane, cli) {
        return readScreen(cli, launch.paneText(current, pane) ?? undefined).kind;
      },
      shellBack: (current, pane) => launch.shellBack?.(current, pane) ?? null,
      agentPanes: (current) => launch.agentPanes(current),
      createWorkspace: (current, cwd, label) => launch.createWorkspace(current, cwd, label),
      paneRun: (current, pane, command) => launch.paneRun(current, pane, command),
      renameAgent: (current, pane, next) => launch.renameAgent(current, pane, next),
      reportDisplayAgent: (current, pane, text) => launch.reportDisplayAgent?.(current, pane, text) ?? true,
      closeWorkspace(current, workspace) {
        const ok = launch.closeWorkspace(current, workspace);
        if (ok) closed = true;
        return ok;
      },
      startServer: () => false,
      sessionUp: () => true,
      typeLine: () => false,
      stopSession: () => false,
      kill: () => false,
      allow: () => null,
      running: () => {},
      drop(next) {
        updateState(dir, (file) => {
          const seats = file.sessions[session]?.seats;
          if (seats) delete seats[next];
        });
        // The registry: a reload whose seat was dropped leaves its agent stopped.
        if (next === seat.name && sources.home) {
          const ended = registerEnd({ home: sources.home, team, root, by: describeCaller(caller), session }, next, 'stopped');
          if (ended) logLine(dir, 'reload', describeCaller(caller), ended.note, now());
        }
      },
      record(next, patch) {
        updateState(dir, (file) => {
          const current = (file.sessions[session] ??= emptySession());
          const prior = current.seats[next] ?? { stage: patch.stage };
          const { waiting: written, effort, createdWorkspace: _created, ...rest } = patch;
          const stored: SeatState = { ...prior, ...rest };
          // The record keeps the file's own launch line, never the executed one: the state hooks'
          // `--settings` rides on the command the pane runs, not on what the seat declared.
          const launch_line = (next === seat.name ? seat.launch : undefined) ?? prior.launch_line;
          if (launch_line) stored.launch_line = launch_line;
          if (written === null) delete stored.waiting;
          else if (written) stored.waiting = written;
          if (effort === null) delete stored.effort;
          else if (effort !== undefined) stored.effort = effort;
          current.seats[next] = stored;
        });
        // The registry: the relaunched seat keeps its agent, re-pointed to the new pane with the
        // model and effort the file now declares.
        if (patch.pane && next === seat.name && sources.home) {
          const made = registerLaunch(
            { home: sources.home, team, root, by: describeCaller(caller), session, owner },
            seat,
            patch.pane,
            readState(dir).sessions[session]?.seats[next]?.id,
          );
          if ('note' in made) logLine(dir, 'reload', describeCaller(caller), made.note, now());
          else {
            // The address: the live session socket this relaunch answers at, recorded on the agent.
            const refreshed = refreshAgentAddress(sources.home, made.id, patch.pane, session);
            if (refreshed.note) logLine(dir, 'reload', describeCaller(caller), refreshed.note, now());
          }
        }
      },
      say: () => {},
      final: () => {},
      sleep: (ms) => launch.sleep(ms),
      now: () => launch.now().getTime(),
      log(_who, what) {
        if (what !== detail) return;
        if (grantSeat !== null) (sources.logGranted ?? logGranted)(dir, grantSeat, 'reload', now(), `${seat.name} ${detail}`);
        else logLine(dir, 'reload', describeCaller(caller), `${seat.name}: ${detail}`, now());
      },
    };
    const report = await executePlan(steps, session, host);
    if (!report.dropped.includes(seat.name)) {
      const after = readState(dir).sessions[session]?.seats[seat.name];
      if (after?.stage === 'ready') {
        out.stdout(`team reload: ${seat.name} reloaded\n`);
        // exit: reload.reloaded
        return 0;
      }
    }
    if (!closed) {
      out.stderr(`team reload: the seat changed before it closed; nothing relaunched\n`);
      // exit: reload.changed
      return 1;
    }
    out.stderr(`team reload: the close happened and the new launch did not reach ready\n`);
    // exit: reload.launch
    return 1;
  } finally {
    runLock.release();
  }
}

/** `model`, `effort`, or `model; effort`. Null when the launch record already matches the file. */
function driftOf(recorded: SeatState, seat: Seat): string | null {
  // The shared comparison (`modelDiffers`): another word order, another casing, or the version
  // written inside the recorded model name is the model the file declares. A record without a
  // model is a drift, as before — the caller refuses those seats earlier anyway.
  const model =
    recorded.model === undefined || recorded.version === undefined
      ? true
      : modelDiffers(
          { model: recorded.model, version: recorded.version },
          { model: seat.model, version: seat.version },
        );
  const effort = (recorded.effort ?? null) !== (seat.effort ?? null);
  if (!model && !effort) return null;
  return [model ? 'model' : '', effort ? 'effort' : ''].filter(Boolean).join('; ');
}

function invocation(io: Io, message: string): number {
  io.stderr(`team reload: ${message}\n${USAGE}`);
  // exit: reload.invocation
  return 2;
}
