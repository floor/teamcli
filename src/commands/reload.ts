import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { auditClientRefusal, authorizeClientRun, clientFormProblem, verifyClientForm, type ClientRun } from '../client/client-form.ts';
import { KEY_ISOLATION_LINE } from '../client/records.ts';
import { readArgs } from '../args.ts';
import {
  anotherPaneRefusal,
  callerOf,
  describeCaller,
  isOwner,
  noPaneRefusal,
  standingOf,
  walkCaller,
} from '../caller.ts';
import { TEAM_FILE } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { relaunchRepair } from '../file/sections/lead.ts';
import { displayAgent, workspaceLabel } from '../file/sections/seats.ts';
import type { Seat } from '../file/types.ts';
import { grantGate, logGranted, type GrantVerdict } from '../grant.ts';
import {
  agentList,
  agentRename,
  agentStatus,
  paneForeground,
  paneProcesses,
  paneRead,
  paneRun,
  paneShellBack,
  pressEnter,
  reportDisplayAgent,
  sendKey,
  typeText,
  workspaceClose,
  workspaceCreate,
  workspacePanes,
} from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { cleanedIo } from '../io.ts';
import {
  devModeCallerGate,
  devModeExpiryNote,
  devModeFileApproval,
  devModeLevelNote,
  logDevMode,
  logDevModeState,
  resolveDevMode,
} from '../dev_mode.ts';
import { deliverRules, fileRefusalOf, type Refusal } from '../launch/deliver.ts';
import type { Host } from '../launch/execute.ts';
import { executePlan } from '../launch/execute.ts';
import { ensureCodexEndpoint, stopSeatCodexEndpoint } from '../launch/codex-endpoint.ts';
import { currentBriefEpochs, deliverBriefForAttribution, walkBriefDeliveries } from '../launch/general-brief.ts';
import { installCliHooks, plannedCliHooks, resetCliHookState, restorePresenceBinding } from '../launch/cli-hook.ts';
import { plainLine } from '../launch/plain.ts';
import { upPlan } from '../launch/plan.ts';
import { recordText } from '../launch/progress.ts';
import { acquireRunLock, runLockText } from '../launch/run-lock.ts';
import { rulesFileHash, rulesFileHolds, seatDeliveryOf, typeablePath, writeRulesFile } from '../launch/rules-file.ts';
import { rulesOf, rulesOriginOf } from '../launch/rules.ts';
import { unreadAdvice, unreadIdle } from '../launch/unread.ts';
import { logLine } from '../log.ts';
import { hasJsonFlag, refuse, writeJson } from '../output/index.ts';
import { gateVerdict } from '../permissions/who.ts';
import { parseVersion, profileFor, versionVerdict } from '../profiles/profile.ts';
import { teamIdOf } from '../registry/teams.ts';
import { senderNameModeFor, sessionDisplayName } from '../send/names.ts';
import { emptySession, readState, updateState, type SeatState } from '../state.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { modelDiffers, seatModel, type Running } from '../status/statusline.ts';
import { registerEnd, registerLaunch } from '../registry/sync.ts';
import { beginSession } from '../sessions/registry.ts';
import { refreshAgentAddress } from '../send/address.ts';
import { watchLabel } from '../watch/pane.ts';
import { readScreen } from '../watch/screen.ts';
import { realSources as doctorSources } from './doctor.ts';
import { rulesFileProblem } from './status.ts';
import type { Launch } from './up.ts';
import { registerInbox } from '../mcp/register.ts';

export const USAGE = `Usage: team reload <seat> [--file <path>] [--json]
       team reload <seat> --client <grant-file> --key <client-key> [--team <team>] [--json]

The --client form is for a client with no terminal that the owner signed a manager bundle grant carrying reload for: it reloads a seat of that one team, as signed, and nothing else. It never prompts and is never the owner (--file is the owner's and takes no --client).

Exits 0 when the seat is reloaded or already matches the file, 1 when reload is refused or relaunch fails, 2 when the invocation or team file can't be read.
`;

export type ReloadSources = {
  launch: Launch;
  home?: string;
  now?: () => Date;
  grantGate?: typeof grantGate;
  logGranted?: typeof logGranted;
  standing?: (root: string) => Standing;
  /** What the installed `<binary>` reports as its version, read once before a close. The
   *  profile's tested range is the record of which screens this build reads: a version outside
   *  it refuses up front, and a version that cannot be read refuses nothing. Absent: the close
   *  is made exactly as it was before this guard. */
  version?: (binary: string) => string | null;
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

/** A profile's tested range as `doctor` prints it. */
function testedRange(tested: { from: string; to: string }): string {
  return tested.from === tested.to ? tested.from : `${tested.from} to ${tested.to}`;
}

/** The one release a dev-mode run reloads past its profile's tested range: Antigravity's `agy`
 *  1.4.3, seen exactly. A fourth component, another release or another CLI is not it, and the
 *  profile's tested range is never touched. */
function isAgy143(cli: string, printed: string): boolean {
  if (cli !== 'antigravity') return false;
  const version = parseVersion(printed);
  return version !== null && version.length === 3 && version[0] === 1 && version[1] === 4 && version[2] === 3;
}

const realLaunch: Launch = {
  sessionState: () => null,
  startServer: () => false,
  sessionUp: () => null,
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
  sendKey: (session, pane, key) => sendKey(pane, key, aim(session)),
  agentStatus: (session, pane) => agentStatus(pane, aim(session)),
  foreground: (session, pane) => paneForeground(pane, aim(session)),
  processInfo: (session, pane) => paneProcesses(pane, aim(session)),
  shellBack: (session, pane) => paneShellBack(pane, aim(session)),
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  now: () => new Date(),
};

const realSources: ReloadSources = {
  launch: realLaunch,
  home: homedir(),
  now: () => new Date(),
  version: (binary) => doctorSources.version(binary),
};

export const reload: Command = (argv, io) => runReload(argv, io, realSources);
export default reload;

/**
 * `team reload <seat>`: when the file's model, version or effort differs from the launch
 * record — or a message seat's per-seat rules file no longer holds the live text — close that
 * seat at an idle prompt and launch the file's line, delivering the rules again. A ready seat
 * `up` leaves alone stays up. Nothing is closed while the seat is working or the box holds
 * unsent text. A seat launched before the record kept a model is read from its screen, or
 * from the file when the screen names none, and recorded in place when nothing drifts.
 */
export async function runReload(argv: string[], io: Io, sources: ReloadSources = realSources): Promise<number> {
  let out = cleanedIo(io);
  // A bad option stops the parser before `--json` is read when it comes first, and the
  // structured refusal is still the one the caller asked for.
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['file', 'client', 'key', 'team'], ['json']);
  if (args.error) return invocation(io, json, args.error);
  const name = args.rest.length === 1 ? args.rest[0] : undefined;
  if (!name) {
    const extra = args.rest[1];
    return invocation(io, json, extra === undefined ? 'a <seat> is required' : `unexpected "${plainLine(extra)}"`);
  }
  const clientProblem = clientFormProblem(args.values, 'team reload <seat> --client <grant-file> --key <client-key-file>')
    ?? (args.values.client !== undefined && args.values.file !== undefined
      ? "--client reloads a seat of the one team its grant names: --file is the owner's and takes no --client"
      : null);
  if (clientProblem !== null) return invocation(io, json, clientProblem);

  // The client form: a manager grant the owner signed for ONE team at ONE folder, proven by the client's
  // own key and verified whole before anything is read. The verified run is the second door past the
  // caller and grant gates below, never the owner's, and it is logged as `client:<id>`.
  let clientRun: ClientRun | null = null;
  if (args.values.client !== undefined) {
    if (!json) io.stderr(`${KEY_ISOLATION_LINE}\n`);
    const at = sources.now ? sources.now() : new Date();
    const verified = verifyClientForm({ home: sources.home ?? homedir(), now: at, io }, { op: 'reload', values: args.values, cwd: io.cwd });
    if (!verified.ok) {
      auditClientRefusal('reload', verified.named, verified.why, at);
      return clientRefused(io, json, verified.why);
    }
    clientRun = verified.run;
    io = { ...io, cwd: verified.run.root };
    out = cleanedIo(io);
    if (!json) io.stderr(`client grant ${clientRun.grant.grantId}: ${clientRun.grant.clientId} for team ${clientRun.grant.up.project} at ${clientRun.root}, until ${clientRun.grant.expires}\n`);
  }

  const caller = walkCaller(io);
  // A client run is never the owner's, whatever terminal it stands in.
  const owner = clientRun === null && isOwner(caller);
  const who = clientRun === null ? describeCaller(caller) : `client:${clientRun.grant.clientId}`;
  const flagged = args.values.file;
  const foreign = flagged !== undefined && resolve(io.cwd, flagged) !== resolve(io.cwd, TEAM_FILE);
  // Dev mode, from this folder's own file: the caller's place, never a file the caller names.
  // A `dev-mode` value anywhere in its chain governs, and `TEAMCLI_DEV_MODE` is then ignored;
  // before any such value, the variable set to exactly `1` keeps its behaviour. The gate below
  // is the caller gate dev mode folds: a grant the file omits and one naming another seat are
  // that gate, while its placement (`no-pane`, `another-pane`), the approval, the scope, a file
  // that will not load and the owner's `--file` stay refusals in every mode.
  const policyLoad = readTeamConfig(io.cwd, { ...(sources.home ? { home: sources.home } : {}) });
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
  logDevModeState(placeDir, 'reload', who, dev, sources.now ? sources.now() : new Date());
  let devWarning: string | null = null;
  let grantSeat: string | null = null;
  let said: GrantVerdict | null = null;
  if (!owner && clientRun === null) {
    said = (sources.grantGate ?? grantGate)({ act: 'reload', io, home: sources.home, dev });
    // A grant that cannot be read is the refusal it was, before any other reading: the rest is
    // judged with the team file in hand, where the map's `reload` row admits a lead.
    if (said.kind === 'refused' && said.id === 'grant.file') {
      refuse(io, json, 'reload', {
        id: 'reload.grant-file',
        message: said.text,
        repair: null,
      });
      // exit: reload.grant-file
      return 1;
    }
    if (said.kind === 'passed') {
      grantSeat = said.grant.seat;
      // The gate's approval was folded in dev mode: say so where the caller reads it, and let
      // the audit line below carry it once the run has passed every later refusal.
      if (said.devApproval !== undefined) {
        out.stderr(`team reload: ${said.devApproval}\n`);
        devWarning = said.devApproval;
      }
    }
  }

  const loaded = readTeamConfig(io.cwd, {
    ...(owner && flagged ? { file: flagged } : {}),
    ...(sources.home ? { home: sources.home } : {}),
  });
  if (!loaded.ok) {
    const said = loaded.errors.map((problem) => `${problem.line ? `line ${problem.line}: ` : ''}${problem.message}`);
    if (json) refuse(io, json, 'reload', { id: 'reload.file', message: said.join('; '), repair: null });
    else for (const line of said) out.stderr(`team reload: ${line}\n`);
    // exit: reload.file
    return 2;
  }

  const team = loaded.team;
  const dir = dirname(loaded.path);
  const root = loaded.root;
  const home = sources.home;
  const standing = (sources.standing ?? approvalStanding)(root, home);
  const session = team.session;
  // Two doors for a seat: the map's `reload` row (the owner and the team's `leads`, standing on
  // their recorded pane) and the grant. A grant the file carries is a second gate, as it is for
  // `down`: its refusal is a refusal even where the map would admit the caller. With no grant,
  // a lead passes on the map's row alone.
  const placed = callerOf(io, session);
  if (!owner && clientRun === null && grantSeat === null) {
    const rule = gateVerdict(
      placed, team, loaded.root, sources.home ?? homedir(), 'reload',
      standingOf(dir, session, placed), sources.now ?? (() => new Date()),
    );
    let refusal: string | null = null;
    // A grant the file carries is read before the placement: its sentence names what the file
    // must fix (an approval, a scope, a seat), which is more than "you are not placed". The
    // grant's own placement words are the same sentence the map's verdict gives, so they are
    // taken from the verdict below.
    const grantWords = said !== null && said.kind === 'refused' ? said : null;
    const placementWords = grantWords?.id === 'grant.no-pane' || grantWords?.id === 'grant.another-pane';
    if (grantWords !== null && !placementWords && (team.grant !== null || rule.kind !== 'ok')) refusal = grantWords.text;
    else if (rule.kind === 'no-pane') refusal = noPaneRefusal(rule.name);
    else if (rule.kind === 'another-pane') refusal = anotherPaneRefusal(rule.name, rule.recordedPane);
    else if (!(rule.kind === 'ok' && team.grant === null)) refusal = said?.kind === 'refused' ? said.text : null;
    if (refusal !== null) {
      // Dev mode lifts the caller gate's own words — a grant the file omits, or one naming
      // another seat — and nothing else: the placement's repair, the approval and the scope
      // stay refusals.
      const liftable = rule.kind === 'refused' && said !== null && said.kind === 'refused'
        && (said.id === 'grant.omitted' || said.id === 'grant.caller');
      const folded = liftable ? devModeCallerGate(dev, refusal) : null;
      if (folded === null) {
        // The document's row is the gate's own: the grant's id where the file's grant refused,
        // the placement's for the two pane verdicts, the caller's row otherwise.
        const id = grantWords !== null && grantWords.id.startsWith('grant.') && !placementWords
          ? `reload.${grantWords.id.replace(/^grant\./, 'grant-')}`
          : rule.kind === 'no-pane' || (placementWords && grantWords?.id === 'grant.no-pane') ? 'reload.grant-no-pane'
            : rule.kind === 'another-pane' || grantWords?.id === 'grant.another-pane' ? 'reload.grant-another-pane'
              : 'reload.grant-caller';
        refuse(io, json, 'reload', {
          id,
          message: `${refusal}${liftable ? devModeExpiryNote(dev) : ''}`,
          repair: null,
        });
        // exit: reload.grant-another-pane
        // exit: reload.grant-approval
        // exit: reload.grant-caller
        // exit: reload.grant-no-pane
        // exit: reload.grant-omitted
        // exit: reload.grant-scope
        return 1;
      }
      out.stderr(`team reload: ${folded}\n`);
      devWarning = folded;
    }
  }
  if (!owner && foreign) {
    refuse(io, json, 'reload', {
      id: 'reload.grant-flag',
      message: "--file is the owner's; the granted seat cannot use it",
      repair: null,
    });
    // exit: reload.grant-flag
    return 1;
  }
  // The audit line the fold owes: written where the gate is used, before any later refusal
  // ends the run. A run the owner's `--file` refusal ended above owes none — no close was
  // permitted — so the line waits until that refusal has passed.
  if (devWarning !== null) logDevMode(dir, 'reload', who, devWarning, sources.now?.() ?? new Date());
  const seat = team.seats.find((item) => item.name === name);
  if (!seat) {
    refuse(io, json, 'reload', {
      id: 'reload.absent',
      message: 'no seat of that name',
      repair: 'team seats lists the seats the file declares',
    });
    // exit: reload.absent
    return 1;
  }
  // A pane the file marks as a human's is never closed and never launched over: this command is
  // a close followed by a launch, so it refuses before the record is read or anything is typed.
  if (seat.human) {
    refuse(io, json, 'reload', {
      id: 'reload.human',
      message: `${seat.name} is a human's pane: nothing is typed into it or launched over it; left as it is`,
      repair: null,
    });
    // exit: reload.human
    return 1;
  }
  if (placed.kind === 'seat' && seat.name === placed.name) {
    refuse(io, json, 'reload', {
      id: 'reload.self',
      message: "a reload does not close the caller's seat",
      repair: null,
    });
    // exit: reload.self
    return 1;
  }

  const recorded = readState(dir).sessions[session]?.seats[seat.name];
  if (seat.stopped || !recorded || recorded.stage !== 'ready' || !recorded.pane || !recorded.workspace || !recorded.launched) {
    refuse(io, json, 'reload', {
      id: 'reload.not-running',
      message: `${seat.name} has no ready pane to close`,
      repair: `team up launches ${seat.name}; team reload needs a seat already at its idle prompt`,
    });
    // exit: reload.not-running
    return 1;
  }
  // The client's grant, read once more under its lock immediately before the first effect (the brief, the
  // state record and the close all come after), and its audit line written while the lock is held.
  if (clientRun !== null) {
    const stood = authorizeClientRun(home ?? homedir(), clientRun, 'reload', sources.now ? sources.now() : new Date(), `seat ${seat.name}`);
    if (stood !== null) {
      auditClientRefusal('reload', clientRun.grant, stood, sources.now ? sources.now() : new Date());
      return clientRefused(io, json, stood);
    }
  }
  // A seat started before the launch record kept a model still reloads: its screen's status row
  // is the first answer, the team file's declared values the second, and whichever answered is
  // said and then recorded. A seat already running what that answer declares is recorded in
  // place, with no close.
  let compared = recorded;
  let source: 'screen' | 'file' | null = null;
  let shown: Running | null = null;
  if (recorded.model === undefined || recorded.version === undefined) {
    shown = seatModel({ cli: seat.cli, model: seat.model }, sources.launch.paneText(session, recorded.pane) ?? undefined);
    compared = {
      ...recorded,
      model: shown?.model ?? seat.model,
      version: shown?.version ?? seat.version,
      ...(recorded.effort === undefined && seat.effort !== undefined ? { effort: seat.effort } : {}),
    };
    source = shown === null ? 'file' : 'screen';
  }
  const detail = driftOf(compared, seat);
  // The rules file is a launch input too: a seat whose per-seat file no longer holds the live
  // text is not running what the file declares, however its model row reads. This is the same
  // reading `team check` makes (`rulesFileProblem`), so the repair the check names can never
  // leave the check red. A seat with no home to look under has no file to compare.
  const rulesProblem = home === undefined ? null : rulesFileProblem(standing, team, seat, root, home, rulesOriginOf(loaded.source));
  const driftDetail = [detail, rulesProblem === null ? null : 'rules'].filter((part): part is string => part !== null).join('; ');
  const now = sources.now ?? (() => new Date());
  // The lines plain output writes beside the document ride on it as notes under `--json`;
  // stdout carries the one document and nothing else.
  const jsonNotes: string[] = [];
  const sayBrief = (said: string): void => {
    if (json) jsonNotes.push(said);
    else out.stdout(`team reload: ${said}\n`);
    logLine(dir, 'reload', who, said, now());
  };
  // The general seat brief goes to the seat on every path this command reaches it: the check
  // names `team reload <seat>` as a repair, so a reload must deliver the brief even when nothing
  // else drifts. A relaunch path attributes the seat and gets a fresh delivery lifetime. The two
  // "already running" paths attribute nobody: the boundary still delivers there when this build's
  // brief is ahead of the seat's claim, and an idempotent delivery leaves a current claim and its
  // verified drop as they are. Without a home there is no message key to sign the record with, so
  // nothing is written.
  const deliverBrief = async (attributed: boolean): Promise<void> => {
    if (home === undefined) return;
    const briefs = deliverBriefForAttribution({
      dir,
      root,
      session,
      home,
      now: now(),
      team,
      state: readState(dir).sessions[session] ?? emptySession(),
      attributed: attributed ? [seat.name] : [],
    });
    await walkBriefDeliveries(briefs, { dir, home });
    for (const delivery of briefs.deliveries) {
      if (!delivery.ok) sayBrief(`${delivery.seat}: the general seat brief was not delivered (${delivery.reason})`);
    }
    if (briefs.recording !== undefined) sayBrief(`the general seat brief was written and not recorded (${briefs.recording})`);
  };
  if (detail === null && rulesProblem === null && source === null) {
    await deliverBrief(false);
    const summary = `team reload: ${seat.name} is already running what the file declares`;
    if (json) {
      writeJson(io, 'team.reload', {
        format: 1 as const,
        dry_run: false,
        status: 'same',
        action_summary: summary,
        project: team.project,
        session,
        seat: seat.name,
        pane: recorded.pane,
        ...(jsonNotes.length === 0 ? {} : { notes: jsonNotes }),
      });
    } else {
      out.stdout(`${summary}\n`);
    }
    // exit: reload.same
    return 0;
  }

  // Both writes — the record kept in place and the close that follows a drift — happen under the
  // session's mutator lock, and the idle-prompt reading is taken there too, so nothing between
  // that reading and the close can move the seat.
  const runLock = acquireRunLock(dir, session);
  if ('held' in runLock) {
    refuse(io, json, 'reload', {
      id: 'reload.run-lock',
      message: runLockText(runLock.held, session, dir),
      repair: null,
    });
    // exit: reload.run-lock
    return 1;
  }
  try {
    if (detail === null && rulesProblem === null) {
      updateState(dir, (file) => {
        const held = file.sessions[session]?.seats[seat.name];
        if (!held) return;
        held.model = compared.model;
        held.version = compared.version;
        if (compared.effort === undefined) delete held.effort;
        else held.effort = compared.effort;
      });
      const summary = `team reload: ${seat.name}: its launch record held no model; recorded ${mentioned(shown, compared, recorded)}; it is already running what the file declares`;
      await deliverBrief(false);
      if (json) {
        writeJson(io, 'team.reload', {
          format: 1 as const,
          dry_run: false,
          status: 'same',
          action_summary: summary,
          project: team.project,
          session,
          seat: seat.name,
          pane: recorded.pane,
          ...(jsonNotes.length === 0 ? {} : { notes: jsonNotes }),
        });
      } else {
        out.stdout(`${summary}\n`);
      }
      // exit: reload.unrecorded
      return 0;
    }

    // The close this run makes hands the seat's place to a relaunch, and the relaunch's ready
    // screen is read through the CLI's profile: an installed version outside the profile's
    // tested range may draw a prompt no recogniser knows, and the seat would be closed and left
    // without one. The version is read once, before anything is closed. A version that cannot
    // be read is not evidence against the CLI, and refuses nothing. One dev-mode run continues
    // past the refusal: AGY 1.4.3, the next release after the range, warns and reloads anyway
    // while the tested range itself stays as it was. Every other CLI and version, and every run
    // with dev mode off, is the refusal it always was.
    const profile = profileFor(seat.cli);
    const printed = profile === null || sources.version === undefined ? null : sources.version(profile.binary);
    if (profile !== null && printed !== null) {
      const verdict = versionVerdict(printed, profile.tested);
      if (verdict === 'older' || verdict === 'newer') {
        const reading = `${seat.name}: ${plainLine(profile.binary)} ${plainLine(printed)} is ${verdict} than the tested ${plainLine(testedRange(profile.tested))}; its ready screen may not be recognised`;
        const continues = dev.on && verdict === 'newer' && isAgy143(profile.cli, printed);
        if (!continues) {
          refuse(io, json, 'reload', {
            id: 'reload.untested',
            message: `${reading}, so nothing closed`,
            repair: null,
          });
          // exit: reload.untested
          return 1;
        }
        const warning = `warning: ${reading}; dev mode continues${devModeLevelNote(dev)}`;
        out.stderr(`team reload: ${warning}\n`);
        logDevMode(dir, 'reload', who, warning, sources.now?.() ?? new Date());
      }
    }

    const listed = sources.launch.agents(session)?.find((agent) => agent.name === seat.name);
    if (listed && listed.pane === recorded.pane && listed.workspace === recorded.workspace) {
      const text = sources.launch.paneText(session, recorded.pane);
      const kind = readScreen(seat.cli, text ?? undefined).kind;
      if (listed.status === 'working' || kind === 'working') {
        refuse(io, json, 'reload', { id: 'reload.working', message: `${seat.name} is working; nothing closed`, repair: null });
        // exit: reload.working
        return 1;
      }
      if (kind === 'unsent') {
        refuse(io, json, 'reload', { id: 'reload.unsent', message: `${seat.name} holds unsent text; nothing closed`, repair: null });
        // exit: reload.unsent
        return 1;
      }
      // herdr's own status is the last word on a screen the profile cannot read: one it reports
      // idle or done is closed without typing into it, and the advice says so. A working seat
      // was refused above; anything else unread stays the refusal it was.
      if (!(unreadIdle(listed.status) && (kind === 'idle' || kind === 'unknown'))) {
        refuse(io, json, 'reload', { id: 'reload.not-idle', message: `${seat.name} is not at an idle prompt; nothing closed`, repair: null });
        // exit: reload.not-idle
        return 1;
      }
      if (kind === 'unknown') {
        // The advice is the terminal's: the document has no field for it, and stdout stays the
        // one document under `--json`.
        if (json) out.stderr(`team reload: ${unreadAdvice(seat.name, listed.status)}\n`);
        else out.stdout(`team reload: ${unreadAdvice(seat.name, listed.status)}\n`);
      }
    }

    // The readings are the terminal's; under `--json` stdout is the one document, so they ride
    // on stderr, where a reader parsing the document never meets them.
    const says = (text: string) => (json ? out.stderr(text) : out.stdout(text));
    if (rulesProblem !== null) {
      // Said before any model line: the file, not the status row, is what the repair is for.
      // The line that follows (when the record held no model) already ends `; reloading`.
      says(`team reload: ${seat.name}: ${rulesProblem}${source === null ? '; reloading' : ''}\n`);
    }
    if (source !== null) {
      const effort = source === 'screen' ? effortFromFile(recorded, compared) : effortSaid(recorded, compared);
      says(source === 'screen'
        ? `team reload: ${seat.name}: its launch record held no model; its screen shows ${compared.model} ${compared.version}${effort}; reloading\n`
        : `team reload: ${seat.name}: its launch record held no model; its screen names none, so the file's ${compared.model} ${compared.version}${effort} stand; reloading\n`);
    }

    const planned = {
      name: seat.name,
      cli: seat.cli,
      // The mark rides the plan too: should a later path ever reach this object, `upPlan` skips
      // the seat instead of closing or typing into a human's pane.
      ...(seat.human ? { human: true as const } : {}),
      launch: seat.launch,
      cwd: seat.cwd,
      label: workspaceLabel(seat),
      displayAgent: displayAgent(seat),
      model: seat.model,
      version: seat.version,
      ...(seat.effort ? { effort: seat.effort } : {}),
      repairLine: relaunchRepair(team, seat.name, 'markdown'),
      stopped: false,
      rules: rulesOf(team, seat, root, undefined, rulesOriginOf(loaded.source)),
      // The same session display name a fresh `up` gives the seat: a relaunched claude session
      // reads its sender like every other surface, and a reload is how most seats get relaunched.
      sessionName: sessionDisplayName({
        seat: seat.name,
        nickname: seat.nickname ?? null,
        team: teamIdOf(root),
        teamName: team.project,
        mode: senderNameModeFor({
          ...(home === undefined ? {} : { home }),
          root,
          seat: seat.name,
          file: team,
        }),
      }),
      // The same delivery a fresh `up` gives the seat: a message seat needs its per-seat file
      // and the one line to read, written and typed by the host below; an option seat needs
      // nothing here (its rules ride the launch line).
      ...(home === undefined ? {} : seatDeliveryOf(standing, team, seat, root, home, standing.kind !== 'verified' || owner, rulesOriginOf(loaded.source))),
      repair: {
        pane: recorded.pane,
        workspace: recorded.workspace,
        launched: recorded.launched,
        cli: seat.cli,
        reload: { detail: driftDetail },
      },
    };
    // The general seat brief goes first, before the state hook and the plan's rules line: the
    // claim is written before the hook that resolves it and the signed drop before the launch.
    await deliverBrief(true);
    // The binding the seat holds before this run's install: a minted successor belongs to the
    // launch only if the plan runs the seat's line, and a refusal before that puts this back.
    const priorBinding = readState(dir).sessions[session]?.seats[planned.name]?.presence_binding;
    // The state hook lands before the plan types the launch line. A seat whose settings file did
    // not land is said once, in the log, and relaunches with the file's own line.
    const plannedHooks = plannedCliHooks(dir, session, [planned]);
    const installed = installCliHooks(dir, session, [{ ...planned, fresh: true }], home === undefined ? undefined : { project: team.project, root, home });
    if (plannedHooks[planned.name] !== undefined && installed[planned.name] === undefined) {
      logLine(dir, 'reload', who, `${planned.name}: no state hook written; its launch line is the file's own`,
        sources.now ? sources.now() : new Date());
    }
    // The successor binding this install minted for the launch, when it is not the one the seat
    // already held. The drift close drops the seat's record before the line runs, so this is the
    // only copy left of the incarnation a process that does run will carry.
    const installedBinding = readState(dir).sessions[session]?.seats[planned.name]?.presence_binding;
    const mintedBinding = installedBinding !== undefined && installedBinding !== priorBinding ? installedBinding : undefined;
    const steps = upPlan({
      session,
      root,
      seats: [planned],
      sessionRunning: true,
      startWatch: false,
      teamFile: loaded.path,
      cliHooks: installed,
      briefEpochs: currentBriefEpochs(dir, session),
      watchLabel: watchLabel(team.project),
      ...(home === undefined ? {} : { home }),
      ...(sources.launch.codexEndpoint === undefined ? {} : { stateDir: dir }),
    });
    // The drifted seat is closed: whatever its last turn wrote says nothing about the seat this
    // run starts.
    resetCliHookState(dir, session, [planned.name]);
    const launch = sources.launch;
    let closed = false;
    // Whether the pane ran the seat's line: a failure after it (an idle wait that times out, a
    // name that never lands, rules that are not delivered) leaves a live process holding the
    // mint, so the successor stands.
    const outcome = { launched: false };
    const host: Host = {
      agentList: (current) => launch.agents(current),
      workspacePanes: (current, workspace) => launch.workspacePanes?.(current, workspace) ?? null,
      processInfo: (current, pane) => launch.processInfo?.(current, pane) ?? null,
      paneText: (current, pane) => launch.paneText(current, pane),
      classify(current, pane, cli) {
        return readScreen(cli, launch.paneText(current, pane) ?? undefined).kind;
      },
      foreground: (current, pane) => launch.foreground(current, pane),
      shellBack: (current, pane) => launch.shellBack?.(current, pane) ?? null,
      agentStatus: (current, pane) => launch.agentStatus?.(current, pane) ?? null,
      agentPanes: (current) => launch.agentPanes(current),
      createWorkspace: (current, cwd, label) => launch.createWorkspace(current, cwd, label),
      paneRun: (current, pane, command) => launch.paneRun(current, pane, command),
      ...(launch.codexEndpoint === undefined
        ? {}
        : {
            managedCodexEndpoint: (endpoint: { dir: string; session: string; seat: string; cwd?: string }) => launch.codexEndpoint!.managed(endpoint),
            stopManagedCodexEndpoint: (endpoint: { dir: string; session: string; seat: string }) => launch.codexEndpoint!.stop(endpoint),
          }),
      ...(launch.registerInbox
        ? { registerInbox: (cli: string, seat: string, cwd: string, teamFile?: string) => launch.registerInbox!(cli, seat, cwd, teamFile) }
        : {}),
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
      // The rules delivery a message seat needs after its relaunch: the file is written from
      // the live text, then the one line is typed at an empty idle prompt and read back, with
      // Enter only after the file still holds the hash the line names. The owner's live run and
      // a run with no verified approval write under the live project name, as `restart` does.
      ...(home === undefined ? {} : {
        deliverRules: async (
          current: string,
          pane: string,
          cli: string,
          file: { text: string; path: string; line: string; seat: string },
          seconds: number,
        ) => {
          const devProject = standing.kind !== 'verified' || owner ? team.project : undefined;
          const written = writeRulesFile(standing, file.seat, root, home, file.text, rulesFileHash(file.text), undefined, devProject);
          if (!written.ok) return fileRefusalOf(written);
          if (!typeablePath(file.path)) {
            return { stop: 'path', typed: false, sent: false, kind: 'unknown' as const, row: null };
          }
          const stopped: { why: Refusal | null } = { why: null };
          const delivered = await deliverRules(cli, file.line, seconds, {
            screen: () => launch.paneText(current, pane) ?? undefined,
            status: () => launch.agentStatus?.(current, pane) ?? null,
            type: (value) => launch.typeText?.(current, pane, value) ?? false,
            enter: () => launch.pressEnter?.(current, pane) ?? false,
            // The profile's one clearing key, the same key `up` sends: a line this run typed
            // whose read-back fails is cleared instead of left sitting in the box unsent.
            ...(launch.sendKey
              ? { key: (name: string) => launch.sendKey!(current, pane, name) }
              : {}),
            file: () => rulesFileHolds(file.path, rulesFileHash(file.text)),
            foreground: () => launch.foreground(current, pane),
            report: (why) => {
              stopped.why = why;
            },
            now: () => now().getTime(),
            sleep: launch.sleep,
          });
          return delivered === false && stopped.why !== null ? stopped.why : delivered;
        },
      }),
      stopSession: () => false,
      kill: () => false,
      allow: () => null,
      running: () => {},
      // The new session's start. The swapped-out record ended as `swap` before the close.
      sessionStarted: (next, started) => {
        if (next !== seat.name) return;
        // The pane ran this seat's launch line: the settings file the install wrote is in a
        // process now, so the successor binding is the seat's from here on, whatever the run
        // reaches afterwards. The drift close dropped the record the install put it on; it is
        // written back before the launch's own record, so every later record carries it.
        outcome.launched = true;
        if (mintedBinding !== undefined) {
          updateState(dir, (file) => {
            const one = (file.sessions[session] ??= emptySession());
            const current = one.seats[next];
            if (current === undefined) one.seats[next] = { stage: 'launched', presence_binding: mintedBinding };
            else current.presence_binding = mintedBinding;
          });
        }
        const at = sources.home;
        if (at === undefined) return;
        const began = beginSession({
          home: at,
          root,
          team,
          session,
          seat,
          pane: started.pane,
          ...(started.workspace === undefined ? {} : { workspace: started.workspace }),
          ...(started.cli_session === undefined ? {} : { cli_session: started.cli_session }),
          now: now(),
        });
        if ('note' in began) logLine(dir, 'reload', who, began.note, now());
      },
      drop(next) {
        updateState(dir, (file) => {
          const seats = file.sessions[session]?.seats;
          if (seats) delete seats[next];
        });
        // The registry: a reload whose seat was dropped leaves its agent stopped.
        if (next === seat.name && sources.home) {
          const ended = registerEnd({ home: sources.home, team, root, by: who, session }, next, 'stopped', 'swap');
          if (ended) logLine(dir, 'reload', who, ended.note, now());
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
          // The state this run just wrote is the registry's reading too: the same seat id and
          // the same agent session, never a second derivation of either.
          const kept = readState(dir).sessions[session]?.seats[next];
          const made = registerLaunch(
            { home: sources.home, team, root, by: who, session, owner },
            seat,
            patch.pane,
            kept?.id,
            kept?.agent_session,
          );
          if ('note' in made) logLine(dir, 'reload', who, made.note, now());
          else {
            // The address: the live session socket this relaunch answers at, recorded on the agent.
            const refreshed = refreshAgentAddress(sources.home, made.id, patch.pane, session);
            if (refreshed.note) logLine(dir, 'reload', who, refreshed.note, now());
          }
        }
      },
      say: () => {},
      // A seat this run leaves out is said and logged the way `up` says its records: the refusal
      // is the run's account of the seat, and throwing it away leaves the owner holding a line
      // `team` typed and never sent, with nothing telling them so. A ready record says nothing
      // here: a reload that worked keeps the one success line below, as it always did.
      final(seat, record) {
        if (record.kind !== 'left out') return;
        const line = recordText(seat, record);
        says(`${line}\n`);
        logLine(dir, 'reload', who, line, now());
      },
      sleep: (ms) => launch.sleep(ms),
      now: () => launch.now().getTime(),
      log(_who, what) {
        if (what !== driftDetail) return;
        if (grantSeat !== null) (sources.logGranted ?? logGranted)(dir, grantSeat, 'reload', now(), `${seat.name} ${driftDetail}`);
        else logLine(dir, 'reload', who, `${seat.name}: ${driftDetail}`, now());
      },
    };
    const report = await executePlan(steps, session, host);
    if (!report.dropped.includes(seat.name)) {
      const after = readState(dir).sessions[session]?.seats[seat.name];
      if (after?.stage === 'ready') {
        const summary = `team reload: ${seat.name} reloaded`;
        if (json) {
          writeJson(io, 'team.reload', {
            format: 1 as const,
            dry_run: false,
            status: 'reloaded',
            action_summary: summary,
            project: team.project,
            session,
            seat: seat.name,
            pane: after.pane ?? recorded.pane,
            ...(jsonNotes.length === 0 ? {} : { notes: jsonNotes }),
          });
        } else {
          out.stdout(`${summary}\n`);
        }
        // exit: reload.reloaded
        return 0;
      }
    }
    // A binding is minted for a launch this run is about to type. A refusal that leaves the
    // seat before its line runs never gave the new settings file to a process, so the seat
    // keeps the incarnation it had: the rotation is undone, and a seat the install itself
    // created goes with it. A launch that did run keeps the successor — written when the pane
    // ran — even when the run fails before ready; the run's own records stand otherwise.
    if (!outcome.launched) restorePresenceBinding(dir, session, seat.name, priorBinding);
    if (!closed) {
      refuse(io, json, 'reload', {
        id: 'reload.changed',
        message: 'the seat changed before it closed; nothing relaunched',
        repair: null,
      });
      // exit: reload.changed
      return 1;
    }
    // The relaunch did not reach ready: the close happened and nothing took its place, so the
    // registry records the seat as down. `stopped` keeps the same agent for the next launch and
    // clears its pane; a record left `running` would describe a seat no pane holds.
    if (sources.home) {
      const ended = registerEnd({ home: sources.home, team, root, by: who, session }, seat.name, 'stopped', 'swap');
      if (ended) logLine(dir, 'reload', who, ended.note, now());
    }
    refuse(io, json, 'reload', {
      id: 'reload.launch',
      message: 'the close happened and the new launch did not reach ready',
      repair: null,
    });
    // exit: reload.launch
    return 1;
  } finally {
    runLock.release();
  }
}

/** `model`, `effort`, or `model; effort`. Null when the launch record already matches the file. */
function driftOf(recorded: SeatState, seat: Seat): string | null {
  // The shared comparison (`modelDiffers`): another word order, another casing, or the version
  // written inside the recorded model name is the model the file declares.
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

/** The effort the launch record lacked, read from the team file: said wherever the fallback
 *  values are named, so the reader knows which half came from where. */
/** The effort the file supplied, said plainly; the caller has already said where it came from. */
function effortSaid(recorded: SeatState, compared: SeatState): string {
  return compared.effort !== undefined && recorded.effort === undefined
    ? ` and effort ${compared.effort}`
    : '';
}

function effortFromFile(recorded: SeatState, compared: SeatState): string {
  const effort = effortSaid(recorded, compared);
  return effort === '' ? '' : `${effort} from the file`;
}

/** What the fallback recorded, and from where: the screen's model, or the file's values when the
 *  screen names none. */
function mentioned(shown: Running | null, compared: SeatState, recorded: SeatState): string {
  if (shown === null) return `the file's ${compared.model} ${compared.version}${effortSaid(recorded, compared)}, since its screen names none`;
  return `${compared.model} ${compared.version} from its screen${effortFromFile(recorded, compared)}`;
}

function clientRefused(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'reload', { id: 'reload.client-refused', message: plainLine(message), repair: null });
  // exit: reload.client-refused
  return 1;
}

function invocation(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'reload', { id: 'reload.invocation', message, repair: null, usage: USAGE });
  // exit: reload.invocation
  return 2;
}
