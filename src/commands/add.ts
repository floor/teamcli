import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { auditClientRefusal, authorizeClientRun, clientFormProblem, rosterApprovalText, verifyClientForm, type ClientRun } from '../client/client-form.ts';
import { KEY_ISOLATION_LINE } from '../client/records.ts';
import { approvedFingerprints, budgetsInForceOf, ceilingsOf, notInForce, recordSeatDigestOf } from '../approve/approval.ts';
import { fingerprints } from '../approve/fingerprint.ts';
import { readArgs } from '../args.ts';
import { describeCaller, detachedRefusal, fileOwnerRefusal, isOwner, judgeCallerIn, judgeCallerOf, sessionOwnerRefusal, standingOf, walkCaller, type Caller, type SeatStanding } from '../caller.ts';
import { blocksLaunch, doctorFindings, realSources as doctorSources, type DoctorSources } from '../commands/doctor.ts';
import { seatBudget } from '../budgets/gate.ts';
import { loadReadings, loadSpendReadings } from '../budgets/readings.ts';
import type { Launch } from '../commands/up.ts';
import { ADD_DELEGATE_EDIT, delegateGate, logDelegated } from '../delegate.ts';
import { devModeCallerGate, devModeExpiryNote, devModeFileApproval, devModeMark, logDevMode, logDevModeState, resolveDevMode } from '../dev_mode.ts';
import type { ActingCommand } from '../delegate-types.ts';
import { entityGrantAdmits, readEntityCreateGrants } from '../grant.ts';
import { deliverRules, fileRefusalOf, type Refusal } from '../launch/deliver.ts';
import { removeRulesFile, rulesFileHash, rulesFileHolds, seatDeliveryOf, typeablePath, writeRulesFile } from '../launch/rules-file.ts';
import { rulesOf } from '../launch/rules.ts';
import { nextFreeSeatNumber, type SeatNumbering } from '../seat-names.ts';
import { seatNumberingInForce } from '../settings/seat-numbering.ts';
import { branchPresent, readMerge } from '../end/condition.ts';
import { branchProblem, resultPathProblem } from '../end/until.ts';
import { clearStopped, copySeat, hasSeat, seatIsStopped } from '../file/lines.ts';
import { loadTeamFile, placedProblems } from '../file/load.ts';
import { launchedTeamFile, forgetLaunchedPane, noteLaunchedPane } from '../file/launched-file.ts';
import { migrationText } from '../file/migrate.ts';
import { isLegacyTrust, isMigratedTrust } from '../file/paths.ts';
import { isLeadSeat, relaunchRepair } from '../file/sections/lead.ts';
import { displayAgent, LEAD_NAME, workspaceLabel } from '../file/sections/seats.ts';
import type { Problem, Seat, TeamFile } from '../file/types.ts';
import { defaultLabel, validateTeamFile } from '../file/validate.ts';
import { writeTeamFile } from '../file/write.ts';
import { recheckLobby, verifyLobby, type FsReader, type LobbyRefusal, type LobbySeen } from '../lobby/gate.ts';
import { lobbyOf } from '../lobby/recorded.ts';
import {
  agentList, agentRename, agentStatus, paneForeground, paneProcesses, paneRead, paneRun, paneShellBack, pressEnter, reportDisplayAgent, sendKey, sessionRunning,
  sessionState, startServer, typeText, workspaceClose, workspaceCreate, workspaceList, workspacePanes,
  type HerdrAgent, type PaneProcesses,
} from '../herdr.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { executePlan, type Host } from '../launch/execute.ts';
import { ensureCodexEndpoint, stopSeatCodexEndpoint } from '../launch/codex-endpoint.ts';
import { currentBriefEpochs, deliverBriefForAttribution, walkBriefDeliveries } from '../launch/general-brief.ts';
import { installCliHooks, plannedCliHooks, resetCliHookState, restorePresenceBinding } from '../launch/cli-hook.ts';
import { launchedIdentity, replacedSeat, seatProcessVerdict } from '../launch/identity.ts';
import { launchLineFinding } from '../launch/line.ts';
import { lobbyPretrustLine } from '../launch/pretrust.ts';
import { formatPlan, upPlan, type UpSeat } from '../launch/plan.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { progressWriter, type Progress } from '../launch/progress.ts';
import { acquireRunLock, runLockText } from '../launch/run-lock.ts';
import { logLine } from '../log.ts';
import { hasJsonFlag, planStepsOf, refuse, writeJson, type PlanStep } from '../output/index.ts';
import { gateVerdict } from '../permissions/who.ts';
import { profileFor, shippedStartupReads } from '../profiles/index.ts';
import { resolveEffortOverride, resolveModelOverride, shellQuote, supportsEffortLaunch, withLaunchOverrides } from '../profiles/profile.ts';
import { reachProjectionNote, writeReachProjection } from '../reach/projection.ts';
import { registerEnd, registerLaunch } from '../registry/sync.ts';
import { beginSession } from '../sessions/registry.ts';
import { refreshAgentAddress } from '../send/address.ts';
import { senderNameModeFor, sessionDisplayName } from '../send/names.ts';
import { teamIdOf } from '../registry/teams.ts';
import { emptySession, mintSeatId, readState, updateState, withLock, type SeatState, type SessionState } from '../state.ts';
import { approvalStanding, recordLedger, storePath, type Ceilings, type Standing } from '../store/store.ts';
import { launchLimit, readMachine, readingsText, type Machine, type SwapSample } from '../watch/machine.ts';
import { watchLabel } from '../watch/pane.ts';
import { readScreen } from '../watch/screen.ts';
import { seatStart, type SeatStart } from '../worktree/place.ts';
import { registerInbox } from '../mcp/register.ts';

export type AddSources = {
  home: string;
  getuid?(): number;
  fs?: FsReader;
  sessionState(session: string): 'absent' | 'running' | 'stopped' | null;
  agents(session: string): HerdrAgent[] | null;
  workspaces(session: string): { id: string }[] | null;
  doctor: DoctorSources;
  machine?: (root: string) => Machine;
  now(): Date;
  launch: Launch;
  // The approval store's one read, overridable so a test can count it or swap the record
  // after the gate. Absent: the real read.
  standing?(root: string): Standing;
  // The budget gate, overridable so a test can count its calls. Absent: the real gate.
  // The standing gate refuses before it is ever consulted.
  seatBudget?: typeof seatBudget;
  // The delegate gate, overridable so a test can hand a delegated run its verdict. Absent: the
  // real gate (`src/delegate.ts`).
  delegateGate?: typeof delegateGate;
};

const realLaunch: Launch = {
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
  sendKey: (session, pane, key) => sendKey(pane, key, aim(session)),
  agentStatus: (session, pane) => agentStatus(pane, aim(session)),
  foreground: (session, pane) => paneForeground(pane, aim(session)),
  shellBack: (session, pane) => paneShellBack(pane, aim(session)),
  processInfo: (session, pane) => paneProcesses(pane, aim(session)),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: () => new Date(),
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

export const realSources: AddSources = {
  home: homedir(),
  getuid: () => process.getuid?.() ?? 0,
  sessionState,
  agents: (session) => agentList(aim(session)),
  workspaces(session) {
    const listed = workspaceList(aim(session));
    return listed === null ? null : listed.map((workspace) => ({ id: workspace.id }));
  },
  doctor: doctorSources,
  machine: readMachine,
  now: () => new Date(),
  launch: realLaunch,
};

export const USAGE = `Usage: team add <name> [--like <seat>] [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>] [--json]
       team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>] [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>] [--json]
       team add <name> [--like <seat>] --client <grant-file> --key <client-key> --team <team> [--dry-run] [--json]
       team add --temporary --like <seat> --until <result:path|merged:branch> --client <grant-file> --key <client-key> --team <team> [--dry-run] [--json]

The --client form is for a client with no terminal that the owner signed a manager bundle grant carrying add for one team (team grant --client <id> --entity <entity> --public-key <file> --team <team> --bundle manager --request): it adds a seat to that one team, as signed, and nothing else. It never prompts, is never the owner, and takes no --file, --session, --model or --effort. It never adds a human's pane, never starts the orchestrator or the operator, and does not touch the approval record: the roster change is for the owner to approve with the owner seat, and the run says so.

Exits 0 when the seat is ready or the dry-run plan is printed, 1 when add is refused or launch fails, 2 when the invocation or team file can't be read.
`;

/** The gate's refusal as this command prints it: the verdict's own sentence behind the prefix.
 *  Both delegate branches print it — the caller rule's below and the owner-only flags' — so the
 *  exit ids sit at one site. */
function delegateRefused(io: Io, json: boolean, verdict: { id: string; text: string }): number {
  // The gate names the row it refused on (`add.delegate-flag`, `add.delegate-approval`, …): the
  // document carries that id, the plain line the same sentence it always printed.
  refuse(io, json, 'add', { id: verdict.id, message: verdict.text, repair: null });
  // exit: add.delegate-approval
  // exit: add.delegate-evidence
  // exit: add.delegate-placement
  // exit: add.delegate
  // exit: add.delegate-command
  // exit: add.delegate-flag
  return 1;
}

type Running = { name: string; vendor: string; temporary: boolean };
type Until = { kind: 'result'; path: string } | { kind: 'merged'; branch: string };
/** What a builder hands the run: the seat to start and the file its entry is written into.
 *  `copiedFrom` names the source of a declared copy; `temporary` the end a temporary seat runs to. */
type Built = { name: string; seat: Seat; edited: string; temporary?: SeatState['temporary']; copiedFrom?: string };
type BuildRefusal = { error: string; id: string };

export const add: Command = (argv, io) => runAdd(argv, io, realSources);
export default add;

export async function runAdd(argv: string[], io: Io, sources: AddSources = realSources): Promise<number> {
  // `--json` is read off the raw argv before the parser: an invocation the parser refuses still
  // owes the `team.error` document rather than the plain usage line.
  const wantsJson = hasJsonFlag(argv);
  // Under `--json` nothing but the one document reaches stdout: the seat's records (the run's
  // closing line last) and every other line the plain output prints are collected here instead.
  const finalRecords: string[] = [];
  const jsonNotes: string[] = [];
  const collectInto = (into: string[]): ((text: string) => void) => (text) => {
    for (const line of text.split('\n')) if (line !== '') into.push(line);
  };
  // Every line this run writes goes through the cleaned writers from here; the raw pair stays
  // reachable for the progress writer alone, which draws its own `\r\x1b[K` on a TTY.
  const out = cleanedIo(wantsJson ? { ...io, stdout: collectInto(finalRecords), stderr: collectInto(jsonNotes) } : io);
  const args = readArgs(argv, ['like', 'until', 'worktree', 'model', 'effort', 'session', 'file', 'client', 'key', 'team'], ['temporary', 'dry-run', 'json']);
  const json = wantsJson;
  // The one refusal of the client form, at every site.
  const clientRefused = (message: string): number => {
    refuse(io, json, 'add', { id: 'add.client-refused', message, repair: null });
    // exit: add.client-refused
    return 1;
  };
  const clientProblem = args.error === undefined
    ? clientFormProblem(args.values, 'team add <name> --client <grant-file> --key <client-key-file>')
      ?? (args.values.client !== undefined && args.values.team === undefined
        ? '--client needs --team <team>: a roster change names the one team it is for'
        : args.values.client !== undefined && ['file', 'session', 'model', 'effort'].some((flag) => args.values[flag] !== undefined)
          ? "--client adds a seat to the one team its grant names: --file, --session, --model and --effort are the owner's and take no --client"
          : null)
    : null;
  if (args.error || clientProblem !== null) {
    refuse(io, json, 'add', { id: 'add.invocation', message: args.error ?? clientProblem ?? 'the invocation cannot be read', repair: null, usage: USAGE });
    // exit: add.invocation
    return 2;
  }
  // The client form: a manager grant the owner signed for ONE team at ONE folder, proven by the client's
  // own key and verified whole before anything else is read — before the terminal check below, which no
  // client has a record for. The verified run is the second door past the caller gates, never the owner's:
  // it is logged as `client:<id>`, takes no owner-only flag, and leaves the approval record as it is. Every
  // other caller goes through the ordinary gates below, unchanged.
  let clientRun: ClientRun | null = null;
  if (args.values.client !== undefined) {
    if (!wantsJson) io.stderr(`${KEY_ISOLATION_LINE}\n`);
    const at = sources.now();
    const verified = verifyClientForm({ home: sources.home, now: at, io }, { op: 'add', values: args.values, cwd: io.cwd });
    if (!verified.ok) {
      if (!args.flags.has('dry-run')) auditClientRefusal('add', verified.named, verified.why, at);
      return clientRefused(plainText(verified.why));
    }
    clientRun = verified.run;
    io = { ...io, cwd: verified.run.root };
    if (!wantsJson) io.stderr(`client grant ${clientRun.grant.grantId}: ${clientRun.grant.clientId} for team ${clientRun.grant.up.project} at ${clientRun.root}, until ${clientRun.grant.expires}\n`);
  }
  const clientText = clientRun === null ? null : `client:${clientRun.grant.clientId}`;
  // No create-grant admits a run with no terminal: the record matches the caller's own registry
  // record, and a caller outside herdr has none. This sentence is answered before any file is
  // read, as `down` and `init` ask it; the route names who may run it, so the sentence does not
  // send every reader to the owner.
  const detached = clientRun !== null ? undefined : detachedRefusal(walkCaller(io), { who: 'the owner or an approved delegate', where: 'a terminal outside herdr or its own pane' });
  if (detached !== undefined) {
    refuse(io, json, 'add', { id: 'add.detached', message: detached, repair: null });
    // exit: add.detached
    return 1;
  }
  const temporary = args.flags.has('temporary');
  const dry = args.flags.has('dry-run');
  if (temporary ? args.rest.length > 0 : args.rest.length !== 1) {
    refuse(io, json, 'add', {
      id: temporary ? 'add.temporary-unexpected' : 'add.seat-name',
      message: temporary ? `unexpected "${args.rest[0]}"` : 'a seat name is required',
      repair: null,
      usage: USAGE,
    });
    // exit: add.seat-name
    // exit: add.temporary-unexpected
    return 2;
  }
  if (!temporary && (args.values.until || args.values.worktree)) {
    refuse(io, json, 'add', { id: 'add.temporary-flags', message: '--until and --worktree are for --temporary', repair: null });
    // exit: add.temporary-flags
    return 2;
  }

  // The `--file` check is the walk's, and it runs before that file is read: a non-owner aiming
  // `--file` must not make this command read and validate another project's team file, nor leave
  // its `last_valid` in that project's state. The one place every command whose `--file` is the owner's
  // decides it is `fileOwnerRefusal` (caller.ts).
  //
  // A `delegates` section hands these owner-only flags to the gate as well: a non-owner aiming
  // either is still refused before the flagged file or the flag's session is read — never the
  // walk's sentence but the gate's verdict, which names the flag for the approved delegate and
  // the caller for anyone else. The eligibility that asks is the default live file's alone, so
  // the flagged file is not read at all; with no `delegates` section there, today's refusal
  // stands, byte for byte.
  const walked = args.values.session !== undefined ? walkCaller(io) : undefined;
  const fileFlag = fileOwnerRefusal(io, args.values.file);
  const flagRefusal = fileFlag
    ?? (walked !== undefined && !isOwner(walked) ? sessionOwnerRefusal(walked) : undefined);
  if (flagRefusal !== undefined) {
    const named = loadTeamFile(io.cwd, { home: sources.home });
    if (named.ok && named.team.delegates) {
      const flagged = (sources.delegateGate ?? delegateGate)({
        command: 'add',
        team: named.team,
        root: named.root,
        dir: dirname(named.path),
        flags: [...args.flags, ...Object.keys(args.values)],
        io,
        home: sources.home,
      });
      if (flagged.kind === 'refused') return delegateRefused(io, json, flagged);
    }
    refuse(io, json, 'add', {
      id: fileFlag !== undefined ? 'add.file-owner' : 'add.session-owner',
      message: flagRefusal,
      repair: null,
    });
    // exit: add.file-owner
    // exit: add.session-owner
    return 1;
  }

  const launched = args.values.file || clientRun !== null ? undefined : launchedTeamFile(io, sources.home);
  const loaded = loadTeamFile(io.cwd, {
    ...(args.values.file ?? launched ? { file: args.values.file ?? launched } : {}),
    home: sources.home,
    // The session this run addresses: the placement check reads that session's recorded lobby.
    ...(args.values.session !== undefined ? { session: args.values.session } : {}),
  });
  if (!loaded.ok) {
    if (json) {
      const id = loaded.errors.some((problem) => problem.message.startsWith('not inside a git repository'))
        ? 'add.not-a-repo'
        : loaded.errors.some((problem) => problem.line > 0) ? 'add.file-invalid' : 'add.file';
      refuse(io, json, 'add', {
        id,
        message: loaded.errors.map((problem) => `${where(problem)}${problem.message}`).join('; '),
        repair: null,
      });
    } else for (const problem of loaded.errors) out.stderr(`team add: ${where(problem)}${plainText(problem.message)}\n`);
    // exit: add.not-a-repo
    // exit: add.file
    // exit: add.file-invalid
    return 2;
  }
  const { team, root, path } = loaded;
  // A client never starts a lead seat: that is the second half of a swap, which is the owner's.
  if (clientRun !== null && !temporary && isLeadSeat(team, args.rest[0] ?? '')) {
    auditClientRefusal('add', clientRun.grant, `${args.rest[0]} is a lead seat of the team`, sources.now());
    return clientRefused(`${plainText(args.rest[0] ?? '')} is the team's orchestrator or operator: a client grant never starts a lead seat (that is the owner's swap)`);
  }
  // The send grammar's team-lead address is `lead@<team>` (src/send/resolve.ts), so the word may
  // not become a new seat's name. A file written before 0.5.0 may already declare a seat of that
  // name: it keeps loading, `lead@<team>` still addresses the seat holding `leads`, and this
  // command may still start it — the reservation binds only a name that would be new, and a new
  // name it refuses is one the file does not declare (the file's own load refuses a new nickname
  // of the word, src/file/sections/seats.ts).
  if (!temporary && args.rest[0] === LEAD_NAME && !team.seats.some((seat) => seat.name === LEAD_NAME)) {
    out.stderr(`team add: "${LEAD_NAME}" is reserved: lead@<team> addresses the team's lead, so no new seat takes it as a name\n${USAGE}`);
    // exit: add.reserved-name
    return 2;
  }
  // The create-grant, decided on the loaded root: the team this run would change must be under
  // the granted paths. The early detached sentence above stands alone: no record admits a
  // caller with no terminal.
  const dir = dirname(path);
  // The gate judges the caller placed in the session this command asks about — the proof its pane
  // is that session's. With no `--session` the session judged is the caller's own placement: the
  // file's session first, then a session the state records this caller's pane in (`team up
  // --session <other>`) — never one a non-owner chose. The refusal names the caller's own
  // placement, exactly as main described it.
  const judged = args.values.session !== undefined
    ? { ...judgeCallerOf(io, args.values.session === 'default' ? undefined : args.values.session), session: args.values.session }
    : judgeCallerIn(io, dir, team);
  const { caller, shown } = judged;
  // A client run is never the owner's, whatever terminal it stands in.
  const ownerRun = clientRun === null && caller.kind === 'owner';
  const session = judged.session;
  // Dev mode, from the file this run edits: a `dev-mode` value anywhere in the caller's chain
  // governs, and `TEAMCLI_DEV_MODE` is then ignored; before any such value the variable set to
  // exactly `1` keeps its behaviour. The caller line and the approval are folded below, and the
  // delegate gate's approval fold carries its own line.
  const dev = resolveDevMode('add', io, { home: sources.home, team, root, now: sources.now() });
  if (!dry) logDevModeState(dir, 'add', describeCaller(shown), dev, sources.now());
  let devFolded = false;
  // The approval sentence dev mode stood in for, when the standing check below folded: the
  // doctor's own approval finding repeats it, and that finding does not stop the add any more
  // than the never-approved miss does.
  let devApprovalRefusal: string | null = null;
  // The gate is the map's (`gateVerdict`), read in the verdict shape the branches below already
  // speak: the `add` row is the owner's alone in 0.5.0, so every seat is refused here whatever
  // pane it sits on, and the delegate gate below is the one standing grant that opens a seat's
  // run. The map's own rows are the judge; a caller it refuses is refused before any standing.
  const verdictOf = (who: Caller, at: SeatStanding): ReturnType<typeof gateVerdict> =>
    gateVerdict(who, team, root, sources.home, 'add', at, sources.now);
  const mayChange = verdictOf(caller, standingOf(dir, session, caller));
  // A create-grant the record holds for this loaded root is the run's admission: the ordinary
  // rule's sentence is then not a refusal, and the delegate gate — which the ordinary refusal
  // alone summons — has nothing to replace. Asked only where the ordinary rule has just refused,
  // and only when a record exists, so a caller with none reads no clock for it, exactly as
  // `down` asks it. A lead seat is not granted: the second half of a swap is the owner's, the
  // granted seat's or an approved delegate's, as `remove`'s own gate says, so a run naming a
  // lead seat is not admitted by the record and the ordinary caller refusal below stands.
  const leadSeat = !temporary && isLeadSeat(team, args.rest[0] ?? '');
  const createGranted = clientRun !== null || (mayChange.kind !== 'ok'
    && !leadSeat
    && readEntityCreateGrants(sources.home).length > 0
    && entityGrantAdmits(root, io, { home: sources.home, now: sources.now(), cwd: io.cwd }));
  // The delegate branch, tried only when the ordinary rule just refused and the file names a
  // delegate at all: with no `delegates` section every refusal below stays exactly today's, and
  // the gate is never asked. A refused verdict takes the ordinary refusal's place; a passed one
  // sends this run on as the approved delegate's — the gate has by then verified the approval,
  // the approved copy, the drift and the placement, that this caller is the entry's pane, that
  // `add` is in its list and that no flag of the owner's was passed. The run the rest of this
  // command performs is then a delegated one: the would-edit refusal below keeps it from
  // writing the file or the approval, and `logDelegated` attributes it at its effects.
  let delegatePane: string | null = null;
  if (mayChange.kind !== 'ok' && team.delegates && !createGranted) {
    const verdict = (sources.delegateGate ?? delegateGate)({
      command: 'add',
      team,
      root,
      dir,
      flags: [...args.flags, ...Object.keys(args.values)],
      io,
      home: sources.home,
      // The second half of a swap: an entry that lists `swap` starts the lead it
      // stopped, as an entry that lists `add` already could.
      ...(!temporary && isLeadSeat(team, args.rest[0] ?? '') ? { swap: true } : {}),
      // Dev mode folds the delegation's approval precondition, and the verdict carries the
      // warning naming the live file; the add then goes on as a delegated one.
      dev,
      file: path,
    });
    if (verdict.kind === 'refused') return delegateRefused(io, json, verdict);
    delegatePane = verdict.pane;
    if (verdict.devApproval !== undefined) {
      devFolded = true;
      if (json) (dry ? finalRecords : jsonNotes).push(verdict.devApproval);
      else if (dry) out.stdout(`! ${verdict.devApproval}\n`);
      else out.stderr(`team add: ${plainText(verdict.devApproval)}\n`);
      if (!dry) logDevMode(dir, 'add', describeCaller(caller), verdict.devApproval, sources.now());
    }
  }
  // The who-may-run-it gate: the map's `add` row, the owner's alone, with the standing grant the
  // delegate gate above may have answered read as its opening. Set to exactly `1`, dev mode says
  // this gate once, as a warning, and the edit continues — exactly as `up` does. Every other
  // refusal stays a refusal: the target placement, the CLI, the records, the approvals and
  // trust. The warning is logged where this call runs; a dry run says it beside the dry answer
  // and decides nothing.
  const mayRun = mayChange.kind === 'refused' && delegatePane === null && !createGranted
    ? `only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is ${plainLine(describeCaller(shown))}${devModeExpiryNote(dev)}`
    : null;
  if (mayRun !== null) {
    const folded = devModeCallerGate(dev, mayRun);
    if (folded !== null) {
      devFolded = true;
      // The document's note is the sentence itself; only the terminal's line carries the
      // dry run's `! ` and the command's name in front.
      if (json) (dry ? finalRecords : jsonNotes).push(folded);
      else if (dry) out.stdout(`! ${folded}\n`);
      else out.stderr(`team add: ${plainText(folded)}\n`);
      if (!dry) logDevMode(dir, 'add', describeCaller(caller), folded, sources.now());
    } else {
      if (json) {
        refuse(io, true, 'add', {
          id: 'add.caller',
          message: mayRun,
          repair: 'an approved delegate runs `team add …` from its own pane when .agents/team.yaml names one; otherwise the owner runs it from this folder, at a terminal outside herdr',
          rule: 'owner-only',
        });
      } else if (dry) {
        out.stdout(`! add would refuse: ${plainText(mayRun)}\n! to unblock: ${plainText(unblockingAddRun(argv))}\n`);
      } else out.stderr(`team add: ${plainText(mayRun)}\n`);
      // exit: add.caller
      return 1;
    }
  }
  if (session === 'default') {
    refuse(io, json, 'add', { id: 'add.default-session', message: 'session can\'t be "default", herdr\'s own session', repair: null });
    // exit: add.default-session
    return 1;
  }
  // A missing record is the live file, and so is a verified one: the edit starts from the live
  // text, and a seat is read from the file as it stands. A legacy or refused record is still not
  // in force — unless dev mode is on, where the live file this run edits counts as approved, with
  // the warning saying so and the caller in the audit log, exactly as the caller gate above folds.
  const standing = sources.standing?.(root) ?? approvalStanding(root, sources.home);
  if (standing.kind !== 'verified' && standing.kind !== 'none') {
    const said = notInForce(standing);
    const folded = devModeFileApproval(dev, said, path);
    if (folded !== null) {
      devFolded = true;
      devApprovalRefusal = said;
      if (json) (dry ? finalRecords : jsonNotes).push(folded);
      else if (dry) out.stdout(`! ${folded}\n`);
      else out.stderr(`team add: ${plainText(folded)}\n`);
      if (!dry) logDevMode(dir, 'add', describeCaller(caller), folded, sources.now());
    } else {
      refuse(io, json, 'add', {
        // Both kinds that reach here — `legacy` and `refused` — are a record not in force; a file
        // never approved is still run, so this site's document is `add.ceilings`.
        id: 'add.ceilings',
        message: said,
        repair: null,
      });
      // exit: add.never-approved
      // exit: add.ceilings
      return 1;
    }
  }
  const ceilings = ceilingsOf(team);

  const live = sources.sessionState(session);
  if (live === null) {
    refuse(io, json, 'add', { id: 'add.herdr', message: 'herdr doesn\'t answer', repair: null });
    // exit: add.herdr
    return 1;
  }
  if (live === 'stopped') {
    refuse(io, json, 'add', {
      id: 'add.stopped',
      message: `session ${plainLine(session)} is stopped; clear it with \`herdr session delete ${plainLine(session)}\``,
      repair: `herdr session delete ${plainLine(session)}`,
    });
    // exit: add.stopped
    return 1;
  }
  const agents = live === 'running' ? sources.agents(session) : [];
  // Read so a session whose workspace list can't be read is refused. The title is not a key.
  const workspaces = live === 'running' ? sources.workspaces(session) : [];
  if (agents === null || workspaces === null) {
    refuse(io, json, 'add', { id: 'add.agents', message: `session ${plainLine(session)} runs, and its agents can't be read`, repair: null });
    // exit: add.agents
    return 1;
  }

  const recorded = readState(dir).sessions[session] ?? emptySession();

  const original = readFileSync(path, 'utf8');
  const asked = args.rest[0] ?? '';
  const built = temporary
    ? temporarySeat(args.values, original, team, recorded, agents, root, team.workspace.base, sources.home, sources.now())
    : args.values.like !== undefined
      ? copiedSeat(asked, args.values.like, original, team, sources.home, sources.fs)
      : declaredSeat(asked, original, team, sources.home, sources.fs);
  if ('error' in built) {
    // The builder names the row its refusal is (`add.no-seat`, `add.until`, `add.branch-missing`,
    // …); the plain line is the sentence it always printed.
    refuse(io, json, 'add', { id: built.id, message: built.error, repair: null });
    // exit: add.no-seat
    // exit: add.human
    // exit: add.not-restored
    // exit: add.no-like
    // exit: add.like-exists
    // exit: add.until
    // exit: add.result-absolute
    // exit: add.result-exists
    // exit: add.merged-base
    // exit: add.branch-missing
    // exit: add.worktree-missing
    // exit: add.worktree-failed
    return 1;
  }
  // The pane is the seat only while the process team launched is still in it. A recorded seat
  // whose pane runs no CLI, or a process team did not launch, is not "already running": its
  // workspace is closed without input and the seat is launched fresh, exactly as `up` does.
  // A seat with no record, or a herdr that can't tell, keeps today's reading. The close itself
  // reads herdr again, immediately before it (`execute.ts`), so this reading only decides that
  // the seat needs repair, never that its recorded workspace is still its own.
  const held = recorded.seats[built.name];
  const proc = held?.launched && held.pane && sources.launch.processInfo ? sources.launch.processInfo(session, held.pane) : null;
  const verdict = seatProcessVerdict(held?.launched, proc);
  const listed = held?.pane ? agents.find((agent) => agent.name === built.name && agent.pane === held.pane) : undefined;
  const continuity = replacedSeat(verdict, {
    asked: true,
    namedOnPane: Boolean(listed),
    recordedSession: held?.agent_session,
    liveSession: listed?.session,
  });
  // The session matches: write the pids the pane holds now, then the already-running refusal.
  // Refusing first would skip that write.
  if (continuity === 'restored' && held?.agent_session && proc) {
    const next = launchedIdentity(proc);
    if (next) {
      const sessionId = held.agent_session;
      updateState(dir, (file) => {
        const seat = file.sessions[session]?.seats[built.name];
        if (!seat) return;
        seat.launched = next;
        seat.agent_session = sessionId;
      });
    }
  }
  // A program the record cannot tie to the launch is not closed and not launched again.
  if (continuity === 'doubt' && held?.workspace && held.pane && held.launched) {
    refuse(io, json, 'add', {
      id: 'add.session-doubt',
      message: `${built.name}: its pane holds a process this record cannot tie to the launch`,
      repair: null,
    });
    // exit: add.session-doubt
    return 1;
  }
  // The shell is in front. The seat is not already running: close and launch fresh.
  const repair = verdict === 'gone' && held?.workspace && held.pane && held.launched
    ? { pane: held.pane, workspace: held.workspace, launched: held.launched, cli: built.seat.cli }
    : undefined;
  const runningNow = !repair ? agents.find((agent) => agent.name === built.name) : undefined;
  if (runningNow) {
    const unknown = screenUnknown(built.seat.cli, sources.launch.paneText(session, runningNow.pane));
    const owner = ownerRun;
    if (json) {
      refuse(io, true, 'add', {
        id: 'add.already-running',
        message: alreadyRunningText(built.name, owner, unknown),
        repair: null,
      });
    } else out.stderr(alreadyRunningLine(built.name, owner, unknown));
    // exit: add.already-running
    return 1;
  }
  // A delegated add is a copy and nothing else: the one seat it may start is one the last
  // approval already holds, its stanza hash for hash as the approved copy wrote it, and the add
  // must write nothing. A missing seat, a stopped seat or a stanza the approval does not hold
  // would extend or edit the file, and that stays the owner's. Refused after the
  // already-running refusal, before the write, the digest and any dry-run plan — so a
  // non-copy delegated add writes neither file nor approval. The rule is not the caller gate
  // dev mode lifts: a delegate's edit is refused in every mode, so a folded caller gate above
  // still ends here.
  if (delegatePane !== null) {
    const stanza = fingerprints(team).seats[built.name];
    const inCopy = standing.kind === 'verified' ? approvedFingerprints(standing.record).seats[built.name] : undefined;
    let admitted = built.edited === original && inCopy !== undefined && inCopy === stanza;
    // The seat a delegate adds by copy is new to the file, so the record cannot hold it: the
    // source is what is compared, hash for hash with the record's own seat, and the edit is the
    // copy that source makes and nothing else — the command builds it from the live text, never
    // from the delegate's. A source the record does not hold, or holds differently, stays the
    // owner's.
    if (!admitted && built.copiedFrom !== undefined && standing.kind === 'verified') {
      const beside = fingerprints(team).seats[built.copiedFrom];
      const held = approvedFingerprints(standing.record).seats[built.copiedFrom];
      admitted = held !== undefined && held === beside && copySeat(original, built.copiedFrom, built.name) === built.edited;
    }
    if (!admitted) {
      refuse(io, json, 'add', { id: 'add.delegate-edit', message: ADD_DELEGATE_EDIT.text, repair: null });
      // exit: add.delegate-edit
      return 1;
    }
  }
  const profile = profileFor(built.seat.cli);
  if (!profile) {
    refuse(io, json, 'add', {
      id: 'add.no-profile',
      message: `no launch profile for \`${plainLine(built.seat.cli)}\` in this version`,
      repair: null,
    });
    // exit: add.no-profile
    return 1;
  }
  if (!temporary && (args.values.model !== undefined || args.values.effort !== undefined) && !ownerRun) {
    refuse(io, json, 'add', {
      id: 'add.override-owner',
      message: "--model and --effort on a declared seat are the owner's; use --temporary --like <seat> for a temporary seat",
      repair: null,
    });
    // exit: add.override-owner
    return 1;
  }
  const resolvedModel = args.values.model !== undefined
    ? resolveModelOverride(profile, args.values.model, built.seat.version)
    : undefined;
  if (args.values.model !== undefined && !resolvedModel) {
    refuse(io, json, 'add', {
      id: 'add.model',
      message: `${plainLine(built.name)}: unknown model ${JSON.stringify(args.values.model)} for ${plainLine(built.seat.cli)}`,
      repair: null,
    });
    // exit: add.model
    return 2;
  }
  const resolvedEffort = args.values.effort !== undefined
    ? resolveEffortOverride(built.seat.cli, built.seat.vendor, args.values.effort)
    : undefined;
  if (resolvedEffort && 'error' in resolvedEffort) {
    refuse(io, json, 'add', {
      id: 'add.effort',
      message: `${plainLine(built.name)}: ${plainText(resolvedEffort.error)}`,
      repair: null,
    });
    // exit: add.effort
    return 2;
  }
  if (resolvedModel || (resolvedEffort && !('error' in resolvedEffort))) {
    const nextModel = resolvedModel?.model ?? built.seat.model;
    const nextVersion = resolvedModel?.version ?? built.seat.version;
    const nextEffort = resolvedEffort && !('error' in resolvedEffort) ? resolvedEffort.effort : built.seat.effort;
    const nextDisplay = resolvedModel ? defaultLabel(nextModel, nextVersion) : built.seat.display;
    const nextLaunch = withLaunchOverrides(profile, built.seat.launch, {
      ...(resolvedModel ? { modelId: resolvedModel.id } : {}),
      ...(nextEffort && supportsEffortLaunch(built.seat.cli) ? { effort: nextEffort } : {}),
    });
    built.seat = {
      ...built.seat,
      model: nextModel,
      version: nextVersion,
      display: nextDisplay,
      ...(nextEffort ? { effort: nextEffort } : {}),
      launch: nextLaunch,
    };
  }

  const prepared = validateTeamFile(built.edited, { home: sources.home, fs: sources.fs, root });
  if (!prepared.ok) {
    if (json) {
      refuse(io, json, 'add', {
        id: 'add.prepared',
        message: prepared.errors.map((problem) => `${where(problem)}${plainText(problem.message)}`).join('; '),
        repair: null,
      });
    } else for (const problem of prepared.errors) out.stderr(`team add: ${where(problem)}${plainText(problem.message)}\n`);
    // exit: add.prepared
    return 2;
  }
  const placed = placedProblems(prepared.team, root, sources.home, sources.fs, session);
  if (placed.length > 0) {
    if (json) {
      refuse(io, json, 'add', {
        id: 'add.placed',
        message: placed.map((problem) => plainText(problem.message)).join('; '),
        repair: null,
      });
    } else for (const problem of placed) out.stderr(`team add: ${plainText(problem.message)}\n`);
    // exit: add.placed
    return 1;
  }
  // The session this run addresses — `--session`, or the caller's own placement — reads its own
  // recorded lobby, which is the file's own unless the run names another.
  const runTeam = { ...prepared.team, session };
  const lobby = lobbyOf(sources.home, root, runTeam);
  let startProblem: string | null = null;
  let verifiedLobby: string | null = null;
  let lobbySeen: LobbySeen | null = null;
  // Paths a shipped CLI reads at start. The lobby is checked only when this seat is about
  // to launch there, after `wouldLaunch` is known, so a dry run refuses in the same words.
  const startupReads = shippedStartupReads();
  if (!prepared.team.trust || prepared.team.trust.length === 0 || isLegacyTrust(prepared.team.trust)) {
    startProblem = `the file is legacy: migrate trust to absolute paths including the lobby ${lobby}:\n${migrationText(runTeam, root, sources.home)}`;
  }
  // Where the seat waits: the lobby the gate verified, or a refusal — before the file is edited.
  const start: SeatStart = startProblem
    ? { problem: startProblem }
    : seatStart(runTeam, built.seat, root, sources.home, verifiedLobby ?? undefined);
  if ('problem' in start) {
    refuse(io, json, 'add', { id: 'add.start', message: start.problem, repair: null });
    // exit: add.start
    return 1;
  }
  // Whether the seat is launched fresh or adopted into an existing pane is decided first, the
  // way `up` decides it for a resumed seat: a seat whose state names a workspace that holds an
  // unnamed pane does not run its launch line now, so that line is checked where the pane runs
  // — the folder the state's `start_cwd` records — or, with no folder recorded, not at all. Its
  // own launch line is checked before the file is edited and before any workspace is made. A
  // note is told, never refused: once, on the terminal, and on stderr on a real run as `doctor`
  // says it. A `miss` joins the doctor findings below, for a seat this `add` would launch.
  // A seat whose pane holds a process team did not launch is never adopted into that pane:
  // it is closed and launched fresh, so no stray is looked for.
  const stray =
    repair || (held?.launched !== undefined && verdict !== 'same')
      ? undefined
      : unnamedIn(built.name, recorded.seats, agents);
  const resumeCwd = recorded.seats[built.name]?.start_cwd;
  const line = !stray
    ? launchLineFinding(prepared.team, built.seat, root, {
        onPath: (binary) => sources.doctor.onPath(binary),
        home: sources.doctor.home,
      })
    : typeof resumeCwd === 'string' && resumeCwd !== ''
      ? launchLineFinding(
          prepared.team,
          built.seat,
          root,
          { onPath: (binary) => sources.doctor.onPath(binary), home: sources.doctor.home },
          { cwd: resolve(root, resumeCwd), folder: resumeCwd },
        )
      : {
          level: 'note' as const,
          why: 'its launch line was not checked: the seat is resumed and its state records no start folder',
        };
  // One writer per run: the seat's provisional line on a terminal, its one final record either
  // way, and every other line of the run on stderr, after the record it belongs to. It exists
  // from here, before the run, because the launch-line note is one of its detail lines.
  // It is handed the raw pair on purpose: the writer cleans its own fields and draws its own
  // `\r\x1b[K` on a TTY, and the cleaned pair would strip those bytes. Under `--json` the same
  // writer feeds the document instead of the terminal: the final records are kept whole, in
  // order — the last one is the run's `action_summary` — and every other line is a note. The
  // provisional lines are off (nothing is a terminal in that mode).
  const records = progressWriter({
    stdout: (text) => {
      if (!json) {
        io.stdout(text);
        return;
      }
      for (const line of text.split('\n')) if (line !== '') finalRecords.push(line);
    },
    stderr: (text) => {
      if (json) collectInto(jsonNotes)(text);
      else io.stderr(text);
    },
    isTTY: json ? false : (io.stdoutIsTTY ?? false),
  });
  // The note is the writer's detail line on a real run: one line, cleaned like a record's
  // fields, whatever the launch line's word holds. A dry run has no run, and its note goes to
  // stdout with the plan it belongs to.
  if (line?.level === 'note') {
    const note = `  note ${built.name}: ${line.why}`;
    if (dry) out.stdout(`${plainLine(note)}\n`);
    else records.detail(note);
  }
  // The plan, the record and the log hold the reason in words (`record`); the full finding — the
  // start folder it names — is the record's stderr detail and the doctor line below, both for a
  // terminal. Without a `record` the words are the whole finding.
  const launchProblem = line?.level === 'miss' ? line.record ?? line.why : null;
  const launchProblemDetail = line?.level === 'miss' && line.record ? line.why : undefined;
  const doctorTeam = built.temporary
    ? { ...prepared.team, seats: prepared.team.seats.map((item) => item.name === built.temporary?.like ? { ...item, stopped: false } : item) }
    : { ...prepared.team, seats: prepared.team.seats.map((item) => item.name === built.name ? built.seat : item) };
  // `team` is the file on disk, the one every read trusts. `doctorTeam` is the
  // seat about to run, so a stopped seat's CLI is still checked. The digest is
  // recorded with the write, after a refusal has left the file alone. The seat's own launch
  // line is the last finding: a miss refuses this `add` like any other doctor finding. A dry
  // run prints that miss as the plan's `  skip <name>: would refuse: …` and leaves through
  // this same return. A `miss` found at a resumed seat's recorded folder is only said, never
  // refused — that seat runs nothing now, and its miss is left out here exactly as `up` leaves
  // one out of the plan for a resumed seat.
  for (const finding of [
    ...doctorFindings(doctorTeam, root, dir, session, sources.doctor, prepared.warnings, standing, team),
    ...(launchProblem && !stray
      ? [{ level: 'miss' as const, text: `${built.name}: ${launchProblemDetail ?? launchProblem}` }]
      : []),
  ]) {
    if (blocksLaunch(finding)) {
      // A missing approval record is the live file, the same way `up` reads it. The doctor's
      // never-approved miss is that record's absence, and it does not stop this add.
      if (finding.text.includes('team approve') || finding.text.includes('never approved')) continue;
      // The approval miss dev mode's fold answered is that same absence: the live file counts
      // as approved, so the sentence the fold took does not stop the add either.
      if (devApprovalRefusal !== null && finding.text === devApprovalRefusal) continue;
      // A file a CLI reads at start is said here and refused later, only when this seat is
      // about to start in the lobby. Other misses still stop the run here.
      if (finding.text.includes(' is read at start by ')) {
        // The document's note is the sentence itself; only the terminal's line carries the
        // command's name in front.
        const warning = `warning: ${plainText(finding.text)}`;
        if (json) (dry ? finalRecords : jsonNotes).push(warning);
        else if (dry) out.stdout(`team add: ${warning}\n`);
        else out.stderr(`team add: ${warning}\n`);
        continue;
      }
      const launchText = launchProblem ? `${built.name}: ${launchProblemDetail ?? launchProblem}` : '';
      if (json) {
        // Under `--json` a dry run's refusal is the error envelope too: the plan it would
        // otherwise print is no document, and the row is the same one the real run takes.
        refuse(io, true, 'add', { id: 'add.doctor', message: finding.text, repair: null });
      } else if (dry && launchProblem && !stray && finding.text === launchText) {
        const starting = seatPlan(standing, prepared.team, built.seat, start, root, sources.home);
        const planned = repair ? { ...starting, repair } : starting;
        const preview = upPlan({
          root,
          session,
          sessionRunning: live === 'running',
          seats: [{
            ...planned,
            launchProblem,
            ...(launchProblemDetail ? { launchProblemDetail } : {}),
          }],
          watchAlive: true,
          teamFile: path,
          cliHooks: plannedCliHooks(dir, session, [planned]),
          briefEpochs: currentBriefEpochs(dir, session),
          watchLabel: watchLabel(prepared.team.project),
          home: sources.home,
        });
        out.stdout(plainText(formatPlan(preview)));
      } else {
        out.stderr(`team add: ${plainLine(finding.text)}\n`);
      }
      // exit: add.doctor
      return 1;
    }
  }
  const samples: SwapSample[] = [];
  const crossed = () => {
    const machine = sources.machine?.(root);
    return machine ? { machine, problem: launchLimit(machine, team.machine, samples, sources.now().getTime()) } : null;
  };
  const first = crossed();
  if (first?.problem) {
    // The incident log: the printed refusal and the readings it was decided on, one line in the
    // project's own log, through the same sink every command logs through. It changes no
    // decision. Every caller refusal above returns before this gate, so a line is only ever
    // written for a call that was allowed this far; a dry run decides nothing and writes none.
    if (!dry) logLine(dir, 'add', describeCaller(caller), `refused: ${first.problem} — readings: ${readingsText(first.machine)}`, sources.now());
    refuse(io, json, 'add', { id: 'add.machine', message: first.problem, repair: null });
    // exit: add.machine
    return 1;
  }
  const running = runningOf(agents, prepared.team, recorded);
  const room = ceilingProblem(ceilings, running, built.seat, Boolean(built.temporary));
  if (room) {
    refuse(io, json, 'add', { id: 'add.ceiling', message: room, repair: null });
    // exit: add.ceiling
    return 1;
  }
  const again = crossed();
  if (again?.problem) {
    if (!dry) logLine(dir, 'add', describeCaller(caller), `refused: ${again.problem} — readings: ${readingsText(again.machine)}`, sources.now());
    refuse(io, json, 'add', { id: 'add.machine-again', message: again.problem, repair: null });
    // exit: add.machine-again
    return 1;
  }
  // The gate reads the approved budgets, never the edited file's: the seat this `add` inserts
  // changes no section of its own, and no unapproved reserve may unblock a launch (#50).
  const budgets = budgetsInForceOf(standing, prepared.team);
  const decision = (sources.seatBudget ?? seatBudget)(budgets, loadReadings(dir), built.seat, sources.now().getTime(), loadSpendReadings(dir));
  const starting = seatPlan(standing, prepared.team, built.seat, start, root, sources.home);
  const planned = repair
    ? { ...starting, repair }
    : stray
      ? { ...starting, stage: 'launched' as const, pane: stray.pane, workspace: stray.workspace, agentLive: true }
      : starting;
  const wouldLaunch = planned.stage === undefined || !planned.pane || (planned.stage === 'launched' && !planned.agentLive);
  const seatForPlan = {
    ...planned,
    ...(launchProblem && wouldLaunch
      ? { launchProblem, ...(launchProblemDetail ? { launchProblemDetail } : {}) }
      : {}),
    ...(decision.kind === 'refuse' && !wouldLaunch ? { budget: decision } : {}),
  };
  if (decision.kind === 'refuse' && wouldLaunch) {
    if (json) {
      refuse(io, true, 'add', { id: 'add.budget', message: decision.why, repair: null });
    } else if (dry) {
      out.stdout(`${plainLine(built.name)}: would refuse: ${plainText(decision.why)}\ndry run: nothing was run\n`);
    } else {
      out.stderr(`team add: refused: ${plainText(decision.why)}\n`);
    }
    // exit: add.budget
    return 1;
  }
  // Links and ownership are checked on every migrated run. A file a CLI reads at start is
  // refused only when this seat is about to start in the lobby. A lead starts in the project.
  const migrated = isMigratedTrust(prepared.team.trust);
  const intoLobby = migrated && wouldLaunch && start.lobby === true;
  if (migrated) {
    const gate = verifyLobby(sources.home, {
      create: false, getuid: sources.getuid, fs: sources.fs,
      reads: intoLobby ? startupReads : [], lobby,
    });
    if (!gate.ok) return refuseLobby(io, json, built.name, gate.text, dry);
    if ('path' in gate) {
      verifiedLobby = gate.path;
      lobbySeen = { path: gate.path, dev: gate.dev, ino: gate.ino, files: gate.files };
    }
  }
  const trustCwd = verifiedLobby && seatForPlan.lobby ? verifiedLobby : seatForPlan.cwd;
  const trustSeat = { ...seatForPlan, cwd: trustCwd };
  // A CLI with no captured trust record is refused before the file is edited. A dry
  // run writes nothing and still shows that line. A CLI with a record is written
  // below, once the lobby exists.
  if (intoLobby && wouldLaunch && !trustSeat.launchProblem) {
    const line = lobbyPretrustLine(trustSeat, sources.home, { write: false, now: sources.now() });
    if (line) return refusePretrust(io, json, built.name, line, dry);
  }
  if (dry) {
    if (decision.kind === 'unknown') out.stdout(`${plainLine(built.name)}: ${plainText(decision.text)}\n`);
    const preview = upPlan({
      root,
      session,
      sessionRunning: live === 'running',
      seats: [seatForPlan],
      watchAlive: true,
      teamFile: path,
      cliHooks: plannedCliHooks(dir, session, [seatForPlan]),
      briefEpochs: currentBriefEpochs(dir, session),
      watchLabel: watchLabel(prepared.team.project),
      home: sources.home,
    });
    if (json) {
      writeJson(io, 'team.add', {
        format: 1,
        dry_run: true,
        status: 'dry-run',
        action_summary: 'dry run: nothing was run',
        project: prepared.team.project,
        session,
        seat: built.name,
        plan: planStepsOf(preview),
        notes: [...jsonNotes, ...finalRecords],
      });
    } else out.stdout(plainText(formatPlan(preview)));
    // exit: add.dry-run
    return 0;
  }
  // The session mutator lock: from here this run has effects — the lobby make below when it
  // is absent, the delegated audit line, the file edit, the launch — and no other session
  // command may interleave its own. Every refusal above is decided first, a dry run returned
  // above, and the lock is released on every exit path (`launch/run-lock.ts`).
  const runLock = acquireRunLock(dir, session);
  if ('held' in runLock) {
    refuse(io, json, 'add', {
      id: 'add.run-lock',
      message: runLockText(runLock.held, session, dir),
      repair: null,
    });
    // exit: add.run-lock
    return 1;
  }
  try {
    // The client's grant, read once more under its own lock immediately before the first effect (the
    // lobby, the file edit and the launch all come after), and its audit line written while that lock
    // is held. A dry run returned above and decides nothing.
    if (clientRun !== null) {
      const stood = authorizeClientRun(sources.home, clientRun, 'add', sources.now(), `seat ${built.name}`);
      if (stood !== null) {
        auditClientRefusal('add', clientRun.grant, stood, sources.now());
        return clientRefused(plainText(stood));
      }
    }
    if (intoLobby) {
      const gate = verifyLobby(sources.home, { create: true, getuid: sources.getuid, fs: sources.fs, reads: startupReads, lobby });
      if (!gate.ok) return refuseLobby(io, json, built.name, gate.text, false);
      if ('path' in gate) {
        verifiedLobby = gate.path;
        lobbySeen = { path: gate.path, dev: gate.dev, ino: gate.ino, files: gate.files };
      }
    }
    // Before the file edit: a record that cannot be written leaves the seat out of the file.
    {
      const trustPath = verifiedLobby && seatForPlan.lobby ? verifiedLobby : seatForPlan.cwd;
      const line = lobbyPretrustLine(
        { ...seatForPlan, cwd: trustPath },
        sources.home,
        { write: true, now: sources.now() },
      );
      if (line) return refusePretrust(io, json, built.name, line, false);
    }
    if (decision.kind === 'unknown') out.stderr(`${plainLine(built.name)}: ${plainText(decision.text)}\n`);
    // The audit line, exactly at the effects boundary: a delegated run that reaches here is
    // committed to its effects — the write below when the seat needs one, the launch after it.
    // A dry run returned above; every refusal came sooner.
    if (delegatePane !== null) logDelegated(dir, delegatePane, 'add', sources.now());
    if (built.edited !== original) {
      const written = withLock(dir, () => {
        if (readFileSync(path, 'utf8') !== original) return { kind: 'changed' as const };
        const wrote = writeTeamFile(path, built.edited);
        return wrote.ok ? { kind: 'ok' as const } : { kind: 'invalid' as const, errors: wrote.errors };
      });
      if (written.kind === 'changed') {
        refuse(io, json, 'add', {
          id: 'add.changed',
          message: 'the file changed while add was checking; nothing was written',
          repair: null,
        });
        // exit: add.changed
        return 1;
      }
      if (written.kind === 'invalid') {
        if (json) {
          refuse(io, json, 'add', {
            id: 'add.locked',
            message: written.errors.map((problem) => `${where(problem)}${plainText(problem.message)}`).join('; '),
            repair: null,
          });
        } else for (const problem of written.errors) out.stderr(`team add: ${where(problem)}${plainText(problem.message)}\n`);
        // exit: add.locked
        return 2;
      }
      const parsed = validateTeamFile(built.edited, { home: sources.home, fs: sources.fs, root });
      // The amendment re-signs from the command's own one snapshot, read at its gate.
      // A client's roster change is the owner's to approve: the approval record is left as it was.
      if (parsed.ok && standing.kind === 'verified' && clientRun === null) recordSeatDigestOf(standing, parsed.team, root, built.name, sources.home);
      // The reach projection, from the file just written: a seat added with a `reach` grant
      // reaches the bridge and the shuttle at this approval, without waiting for an `up`.
      if (parsed.ok) {
        const projectionNote = reachProjectionNote(writeReachProjection(parsed.team, sources.home));
        if (projectionNote) logLine(dir, 'add', describeCaller(caller), projectionNote, sources.now());
      }
    }

    const planSeat = verifiedLobby && seatForPlan.lobby ? { ...seatForPlan, cwd: verifiedLobby } : seatForPlan;
    const who = clientText ?? describeCaller(caller);
    if (clientRun !== null && built.edited !== original) {
      const said = rosterApprovalText('add', built.name, clientRun);
      out.stderr(`team add: ${plainText(said)}\n`);
      logLine(dir, 'add', who, said, sources.now());
    }
    // The general seat brief goes first, before the state hook and the plan's rules line: the
    // claim is written before the hook that resolves it and the signed drop before the launch,
    // human seats included. A delivery that cannot be written is said and logged, and the launch
    // goes on; `team check` names the seat with no record.
    const briefs = deliverBriefForAttribution({
      dir,
      root,
      session,
      home: sources.home,
      now: sources.now?.() ?? new Date(),
      team: prepared.team,
      state: readState(dir).sessions[session] ?? emptySession(),
      attributed: [planSeat.name],
      broadcast: true,
    });
    await walkBriefDeliveries(briefs, { dir, home: sources.home });
    for (const delivery of briefs.deliveries) {
      if (delivery.ok) continue;
      const said = `${delivery.seat}: the general seat brief was not delivered (${delivery.reason})`;
      out.stderr(`team add: ${plainText(said)}\n`);
      logLine(dir, 'add', who, said, sources.now());
    }
    if (briefs.recording !== undefined) {
      const said = `the general seat brief was written and not recorded (${briefs.recording})`;
      out.stderr(`team add: ${plainText(said)}\n`);
      logLine(dir, 'add', who, said, sources.now());
    }
    // The state hook lands before the plan types the launch line. A seat whose settings file did
    // not land is said once, in the log, and launches with the file's own line.
    // The binding the seat holds before this run's install: a minted successor belongs to the
    // launch only if the plan runs the seat's line, and a refusal before that puts this back.
    const priorBinding = readState(dir).sessions[session]?.seats[planSeat.name]?.presence_binding;
    const plannedHooks = plannedCliHooks(dir, session, [planSeat]);
    const installed = installCliHooks(dir, session, [{ ...planSeat, fresh: true }], { project: prepared.team.project, root, home: sources.home });
    if (plannedHooks[planSeat.name] !== undefined && installed[planSeat.name] === undefined) {
      logLine(dir, 'add', who, `${planSeat.name}: no state hook written; its launch line is the file's own`, sources.now());
    }
    const plan = upPlan({ root, session, sessionRunning: live === 'running', seats: [planSeat], watchAlive: true, teamFile: path, cliHooks: installed, briefEpochs: currentBriefEpochs(dir, session), watchLabel: watchLabel(prepared.team.project), home: sources.home, ...(sources.launch.codexEndpoint === undefined ? {} : { stateDir: dir }) });
    // A new seat starts from no reading at all: nothing a previous run left says what it is doing.
    resetCliHookState(dir, session, [planSeat.name]);
    const outcome = { swallowed: false, unknown: false, launched: false };
    const host = hostOf({
      dir, session, team: prepared.team, root, home: sources.home, ceilings, running, seat: built.seat, temporary: built.temporary,
      caller: who, owner: ownerRun, devMode: devModeMark(dev, devFolded), now: sources.now, launch: sources.launch, readMachine: sources.machine, samples, limits: team.machine, io: out, standing,
      ...(delegatePane === null ? {} : { delegated: { actor: delegatePane, command: 'add' as const } }),
      verifiedLobby, startCwd: planSeat.cwd, inLobby: planSeat.lobby === true, records, teamFile: path, outcome,
      doctor: sources.doctor,
      // The lobby is read again directly before the workspace this run makes in it, with nothing
      // in between (`execute.ts`). Null when it is still the folder the gate read and every file
      // it allowed still the file it read. The declared files travel with it, so the recheck
      // walks the same closed tree the gate did.
      confirmLobby() {
        return lobbySeen ? recheckLobby(sources.home, lobbySeen, { getuid: sources.getuid, fs: sources.fs, reads: startupReads, lobby }) : null;
      },
    });
    const report = await executePlan(plan, session, host);
    // A binding is minted for a launch this run is about to type. A refusal that leaves the
    // seat before its line runs never gave the new settings file to a process, so the seat
    // keeps the incarnation it had: the rotation is undone, and a seat the install itself
    // created goes with it. The run's own records of the seat stand otherwise.
    if (!outcome.launched) restorePresenceBinding(dir, session, planSeat.name, priorBinding);
    const afterwards = readState(dir).sessions[session]?.seats[built.name];
    const launched = !report.held && !report.dropped.includes(built.name) && afterwards?.stage === 'ready';
    // A lead stopped for a swap runs again: the swap's record goes, and the log says who closed it.
    // A launch that did not reach ready keeps it, so `doctor` still names the gap as a swap.
    const swapped = launched ? readState(dir).sessions[session]?.swapping?.[built.name] : undefined;
    if (swapped) {
      updateState(dir, (file) => {
        const current = file.sessions[session];
        if (current?.swapping) {
          delete current.swapping[built.name];
          if (Object.keys(current.swapping).length === 0) delete current.swapping;
        }
      });
      logLine(dir, 'add', who, `${built.name} runs its new agent (swap started by ${swapped.by} at ${swapped.at})`, sources.now());
    }
    if (launched && built.temporary) {
      recordLedger(storePath(team.project, root, sources.home), [built.seat]);
    }
    if (json) {
      if (outcome.swallowed) {
        // The writer swallowed the seat's one record: its pane is the seat's again, and the
        // run's own sentence — not a record — is this document's error.
        refuse(io, true, 'add', {
          id: 'add.already-running',
          message: alreadyRunningText(built.name, ownerRun, outcome.unknown),
          repair: null,
        });
      } else if (launched && !report.serverFailed) {
        writeJson(io, 'team.add', {
          format: 1,
          dry_run: false,
          status: 'ready',
          // The last record is the run's closing line (`<seat>: ready`); with no record at all
          // the seat's own outcome is said.
          action_summary: finalRecords.at(-1) ?? `${plainLine(built.name)}: ready`,
          project: prepared.team.project,
          session,
          seat: built.name,
          pane: afterwards?.pane ?? null,
          notes: [...jsonNotes, ...finalRecords.slice(0, -1)],
        });
      } else if (report.serverFailed) {
        refuse(io, true, 'add', {
          id: 'add.server',
          message: "the session's server did not start",
          repair: null,
        });
      } else {
        refuse(io, true, 'add', {
          id: 'add.not-ready',
          message: 'the launch finished without a ready seat',
          repair: null,
        });
      }
    }
    // exit: add.ready
    // exit: add.not-ready
    // exit: add.server
    return launched && !report.serverFailed ? 0 : 1;
  } finally {
    runLock.release();
  }
}

function declaredSeat(
  name: string, current: string, team: TeamFile, home: string, fs?: FsReader,
): Built | BuildRefusal {
  const seat = team.seats.find((item) => item.name === name);
  if (!seat) return { id: 'add.no-seat', error: `the file has no seat ${JSON.stringify(name)}` };
  // A human's pane is never launched into or typed into. `add` names one seat, so it refuses
  // with the reason rather than walk a plan that would skip the only seat it was asked to add.
  if (seat.human) return { id: 'add.human', error: `${name} is a human's pane: nothing is typed into it or launched over it; left as it is` };
  let edited = current;
  if (seat.stopped || seatIsStopped(edited, name)) edited = clearStopped(edited, name);
  const again = validateTeamFile(edited, { home, fs });
  const restored = again.ok ? again.team.seats.find((item) => item.name === name) : undefined;
  if (!restored) return { id: 'add.not-restored', error: `couldn't put ${name} back into the file` };
  return { name, seat: { ...restored, stopped: false }, edited, temporary: undefined };
}

/**
 * The new declared seat `team add <name> --like <seat>` writes: the file gains one entry, named
 * `name`, that the source describes field for field except for the name, the title and the
 * stopped flag. The copy starts now, so it is written without `stopped: true` and launched like
 * any declared seat. A source that is a human's pane is refused: nothing is launched over it.
 */
function copiedSeat(
  name: string, like: string, current: string, team: TeamFile, home: string, fs?: FsReader,
): Built | BuildRefusal {
  const source = team.seats.find((item) => item.name === like);
  if (!source) return { id: 'add.no-like', error: `the file has no seat ${JSON.stringify(like)}` };
  if (team.seats.some((item) => item.name === name)) {
    return { id: 'add.like-exists', error: `the file already declares ${JSON.stringify(name)}; --like adds a copy under a new name` };
  }
  if (source.human) return { id: 'add.human', error: `${like} is a human's pane: nothing is typed into it or launched over it; left as it is` };
  const edited = copySeat(current, like, name);
  if (edited === current || !hasSeat(edited, name)) {
    return { id: 'add.not-restored', error: `couldn't copy ${like} into the file as ${name}` };
  }
  // A copy the file refuses — a second `leads`, `assistant` or nickname — is read here so the
  // seat carries what the file would say; the validation before the write then refuses it by
  // name and the file is never touched.
  const again = validateTeamFile(edited, { home, fs });
  const copied = again.ok ? again.team.seats.find((item) => item.name === name) : undefined;
  return {
    name,
    seat: copied ? { ...copied, stopped: false } : { ...source, name, label: name, stopped: false },
    edited,
    copiedFrom: like,
    temporary: undefined,
  };
}

function temporarySeat(
  values: Record<string, string>, current: string, approved: TeamFile, state: SessionState, agents: readonly HerdrAgent[],
  root: string, base: string | null, home: string, now: Date,
): Built | BuildRefusal {
  const like = approved.seats.find((item) => item.name === values.like);
  if (!like) return { id: 'add.no-like', error: `the file has no seat ${JSON.stringify(values.like)}` };
  const until = parseUntil(values.until ?? '');
  if (!until) return { id: 'add.until', error: '--until is result:<path> or merged:<branch>' };
  let own: boolean | undefined;
  if (until.kind === 'result') {
    const problem = resultPathProblem(root, until.path);
    if (problem) return { id: 'add.result-absolute', error: problem };
    if (existsSync(resolve(root, until.path))) return { id: 'add.result-exists', error: `${until.path} already exists` };
  } else if (!base) {
    return { id: 'add.merged-base', error: 'workspace.base is required to read a merged end' };
  } else {
    const name = branchProblem(root, until.branch);
    // A name git itself refuses is a malformed `--until` target, not a branch that is gone.
    if (name) return { id: 'add.until', error: name };
    const read = readMerge(root, until.branch, base, false);
    const here = branchPresent(root, until.branch);
    if (read.detail.includes('the branch is gone') || here === false) return { id: 'add.branch-missing', error: `branch ${until.branch} doesn't exist` };
    if (here !== true && read.verdict === 'unproven') return { id: 'add.branch-missing', error: read.detail };
    own = read.ownNow > 0;
  }
  const task = values.worktree;
  const worktree = task ? state.worktrees[task] : undefined;
  if (task && !worktree) return { id: 'add.worktree-missing', error: `no worktree named ${JSON.stringify(task)} is recorded` };
  if (worktree?.setup === 'failed') return { id: 'add.worktree-failed', error: `worktree ${task} has a failed setup; team worktree remove ${task}` };
  const name = temporaryName(like.name, approved, state, agents, seatNumberingInForce({ home, root, team: approved, now }));
  return {
    name,
    edited: current,
    seat: { ...like, name, label: name, cwd: worktree?.path ?? like.cwd, stopped: false },
    temporary: {
      like: like.name,
      until: values.until ?? '',
      ...(task ? { task } : {}),
      ...(until.kind === 'merged' && !task && own !== undefined ? { own_commits: own } : {}),
    },
  };
}

/**
 * The temporary seat's name: the like seat's own name, `-tmp`, and the next free seat number in
 * the numbering in force — the `seat-numbering` setting's width and separator (`worker-tmp-01`
 * at the shipped default). The number is read as a number, so a `worker-tmp-1` minted under an
 * older width still holds 1 and the next name is `worker-tmp-02`; a name already running in the
 * session or listed by herdr holds its number too.
 */
function temporaryName(like: string, team: TeamFile, state: SessionState, agents: readonly HerdrAgent[], numbering: SeatNumbering): string {
  const used = new Set([...team.seats.map((seat) => seat.name), ...Object.keys(state.seats), ...agents.map((agent) => agent.name ?? '')]);
  return nextFreeSeatNumber(`${like}-tmp`, used, numbering);
}

function parseUntil(value: string): Until | null {
  if (value.startsWith('result:') && value.length > 'result:'.length) return { kind: 'result', path: value.slice('result:'.length) };
  if (value.startsWith('merged:') && value.length > 'merged:'.length) return { kind: 'merged', branch: value.slice('merged:'.length) };
  return null;
}

function seatPlan(
  standing: Standing,
  team: TeamFile,
  seat: Seat,
  start: { cwd: string; lobby?: true },
  root: string,
  home: string,
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
    ...(seat.effort ? { effort: seat.effort } : {}),
    // The team file's own repair for this seat — a lead seat is told only the whole-team
    // sequence, never a `remove --keep` its file refuses (`lead.ts`).
    repairLine: relaunchRepair(team, seat.name, 'markdown'),
    stopped: false,
    // A human's pane: no launch, no key, no line. The plan skips it before any of that.
    ...(seat.human ? { human: true as const } : {}),
    // An option seat's launch line and a message seat's rules file both come from the live file.
    rules: rulesOf(team, seat, root),
    sessionName: sessionDisplayName({
      seat: seat.name,
      nickname: seat.nickname ?? null,
      team: teamIdOf(root),
      teamName: team.project,
      mode: senderNameModeFor({ home, root, seat: seat.name, file: team }),
    }),
    ...seatDeliveryOf(standing, team, seat, root, home, true),
    ...(start.lobby ? { lobby: true } : {}),
  };
}

function unnamedIn(
  seatName: string,
  seats: Readonly<Record<string, SeatState>>,
  agents: readonly HerdrAgent[],
): HerdrAgent | undefined {
  const held = seats[seatName];
  const workspace = held?.workspace;
  if (!workspace) return undefined;
  const shared = Object.entries(seats).some(
    ([name, other]) =>
      name !== seatName
      && (other.workspace === workspace || (held.pane !== undefined && other.pane === held.pane)),
  );
  if (shared) return undefined;
  return agents.find(
    (agent) => !agent.name && agent.workspace === workspace && (held.pane === undefined || agent.pane === held.pane),
  );
}

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

function ceilingProblem(ceilings: Ceilings, running: readonly Running[], seat: Seat, temporary: boolean): string | null {
  if (running.some((item) => item.name === seat.name)) return null;
  if (running.length + 1 > ceilings.seats) return `the file allows ${ceilings.seats} seats; ${running.length + 1} would be running`;
  if (temporary && running.filter((item) => item.temporary).length + 1 > ceilings.temporary) {
    return `the file allows ${ceilings.temporary} temporary seats; ${running.filter((item) => item.temporary).length + 1} would be running`;
  }
  const cap = ceilings.vendors[seat.vendor];
  if (cap !== undefined) {
    const vendors = running.filter((item) => item.vendor === seat.vendor || item.vendor === 'unknown').length + 1;
    if (vendors > cap) return `the file allows ${cap} ${seat.vendor} seats; ${vendors} would be running`;
  }
  return null;
}


function where(problem: Problem): string {
  return problem.line ? `line ${problem.line}: ` : '';
}

/** A screen the profile does not recognise, including one that could not be read. */
function screenUnknown(cli: string, text: string | null | undefined): boolean {
  return readScreen(cli, text ?? undefined).kind === 'unknown';
}

/**
 * The already-running refusal. A screen the profile recognises keeps the sentence a normal
 * seat gets. A screen it does not recognise names the way out for this caller: the owner is
 * told to run `team remove <seat> --abandon`; anyone else is told that the owner runs it.
 */
function alreadyRunningText(name: string, owner: boolean, unknown: boolean): string {
  const who = plainLine(name);
  const base = `${who} is already running`;
  if (!unknown) return base;
  const way = owner
    ? `team remove ${who} --abandon closes its workspace without typing`
    : `the owner runs team remove ${who} --abandon, which closes its workspace without typing`;
  return `${base} (${way})`;
}

function alreadyRunningLine(name: string, owner: boolean, unknown: boolean): string {
  return `team add: ${alreadyRunningText(name, owner, unknown)}\n`;
}

function hostOf(input: {
  dir: string; session: string; team: TeamFile; root: string; home: string; ceilings: Ceilings; running: Running[];
  seat: Seat; temporary?: SeatState['temporary']; caller: string; owner: boolean; devMode: boolean; now(): Date; launch: Launch;
  /** The delegation this add ran under, when it is the approved delegate's: the owner as signer,
   *  this pane as actor, the one command `add`. Absent: no delegation. */
  delegated?: { actor: string; command: ActingCommand };
  readMachine?: (root: string) => Machine; samples: SwapSample[]; limits: TeamFile['machine']; io: Io;
  standing: Standing;
  teamFile: string;
  verifiedLobby: string | null;
  /** The folder this seat's workspace is created in. A lead's is the project; a lobby seat's is the verified lobby. */
  startCwd: string;
  inLobby: boolean;
  /** The run's writer, made by the caller before the launch-line note is said. */
  records: Progress;
  /** What the writer swallowed: the one record whose line the command replaces with its own
   *  sentence, and whether the screen named the way out. Read after the run for `--json`. */
  outcome: { swallowed: boolean; unknown: boolean; launched: boolean };
  doctor: DoctorSources;
  confirmLobby(): LobbyRefusal | null;
}): Host {
  const { dir, session, launch, seat, temporary } = input;
  const running = [...input.running];
  const records = input.records;
  // Set while the one record whose line is replaced by `team add:`'s own sentence is said: its
  // detail lines go unspoken with it.
  let swallowed = false;
  return {
    startServer: launch.startServer,
    sessionUp: launch.sessionUp,
    createWorkspace: launch.createWorkspace,
    confirmLobby: input.confirmLobby,
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
      ? { reportDisplayAgent: (session: string, pane: string, text: string) => launch.reportDisplayAgent!(session, pane, text) }
      : {}),
    typeLine: () => false,
    deliverRules: async (session, pane, cli, file, seconds) => {
      // The rules go to the file first; nothing is typed until it holds them. The writer
      // builds the path itself, from the live project and the seat's name.
      const written = writeRulesFile(
        input.standing, file.seat, input.root, input.home, file.text, rulesFileHash(file.text), undefined, input.team.project,
      );
      if (!written.ok) return fileRefusalOf(written);
      if (!typeablePath(file.path)) {
        return { stop: 'path', typed: false, sent: false, kind: 'unknown' as const, row: null };
      }
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
        now: () => input.now().getTime(),
        sleep: launch.sleep,
      });
      return delivered === false && stopped.why !== null ? stopped.why : delivered;
    },
    renameAgent: launch.renameAgent,
    closeWorkspace: launch.closeWorkspace,
    stopSession: () => false,
    /**
     * §6: `add` has no prompt. A seat that meets a dialog keeps its workspace, is recorded
     * `waiting-owner` with the classification, and is reported left out — its owner finishes
     * it with `team up`.
     */
    dialog: { mode: 'keep' },
    recordWaiting(name, waiting, pane, workspace) {
      updateState(dir, (file) => {
        const current = (file.sessions[session] ??= emptySession());
        const prior = current.seats[name] ?? { stage: 'launched' as const };
        const retained = current.retained_seats?.[name];
        if (current.retained_seats?.[name]) delete current.retained_seats[name];
        const id = prior.id ?? retained?.id ?? mintSeatId();
        // The process identity goes in the same write, so the owner's later `team up` — and
        // `team answer` — can tell a pane that is still the seat's from one that is not.
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
    workspacePanes: launch.workspacePanes ? (session, workspace) => launch.workspacePanes!(session, workspace) : undefined,
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
          // The incident log, as at the gates above: this reading stops a launch, and it is
          // taken after the caller gate let the run through, so it is always the call's own.
          logLine(dir, 'add', input.caller, `refused: ${problem} — readings: ${readingsText(machine)}`, input.now());
          return problem;
        }
      }
      if (name !== seat.name) return null;
      return ceilingProblem(input.ceilings, running, seat, Boolean(temporary));
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
        let start_cwd = prior.start_cwd;
        if (!start_cwd && patch.createdWorkspace) {
          if (input.inLobby) {
            if (input.verifiedLobby) start_cwd = input.verifiedLobby;
          } else {
            start_cwd = input.startCwd;
          }
        }
        // `waiting: null` removes the field alone; anything else written replaces it.
        // `effort: null` is a launch that set no word: the stored word goes with it.
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
          ...(temporary && isTarget ? { temporary } : {}),
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
        // The registry: the seat's agent is registered at its first launch, re-pointed after.
        if (name === seat.name) {
          // The state this run just wrote is the registry's reading too: the same seat id and
          // the same agent session, never a second derivation of either.
          const kept = readState(dir).sessions[session]?.seats[name];
          const made = registerLaunch(
            {
              home: input.home, team: input.team, root: input.root, by: input.caller, session, devMode: input.devMode, owner: input.owner,
              ...(input.delegated === undefined ? {} : { delegated: input.delegated }),
            },
            seat,
            patch.pane,
            kept?.id,
            kept?.agent_session,
          );
          if ('note' in made) logLine(dir, 'add', input.caller, made.note, input.now());
          else {
            // The address: the live session socket this launch answers at, recorded on the agent.
            const refreshed = refreshAgentAddress(input.home, made.id, patch.pane, session);
            if (refreshed.note) logLine(dir, 'add', input.caller, refreshed.note, input.now());
          }
        }
      }
    },
    // The session registry records this seat's launch, with the id TeamCLI set where the CLI
    // takes one; a registry that cannot be written is a note in the run's log.
    sessionStarted(name, started) {
      if (name !== seat.name) return;
      // The plan ran this seat's launch line: the settings file it names is in a process now,
      // so the binding its hooks carry is the seat's incarnation from here on.
      input.outcome.launched = true;
      const began = beginSession({
        home: input.home,
        root: input.root,
        team: input.team,
        session,
        seat,
        pane: started.pane,
        ...(started.workspace === undefined ? {} : { workspace: started.workspace }),
        ...(started.cli_session === undefined ? {} : { cli_session: started.cli_session }),
        now: input.now(),
      });
      if ('note' in began) logLine(dir, 'add', input.caller, began.note, input.now());
    },
    running(name) {
      if (!running.some((item) => item.name === name)) running.push({ name, vendor: seat.vendor, temporary: Boolean(temporary) });
    },
    drop(name) {
      // A temporary seat's rules file goes with the seat. The remover builds the path itself,
      // from the live project and the seat's name, and walks the writer's checked chain.
      if (temporary && name === seat.name) removeRulesFile(input.standing, name, input.root, input.home, input.team.project);
      let pane: string | undefined;
      updateState(dir, (file) => {
        const current = file.sessions[session];
        if (!current) return;
        const prior = current.seats[name];
        pane = prior?.pane;
        if (!temporary && prior?.id && !prior.temporary) {
          (current.retained_seats ??= {})[name] = {
            id: prior.id,
            ...(prior.last_active ? { last_active: prior.last_active } : {}),
          };
        }
        delete current.seats[name];
      });
      if (pane) forgetLaunchedPane(input.home, pane, session);
      // The registry: a temporary seat's agent ends with it; a declared seat's comes back as itself.
      if (name === seat.name) {
        const ended = registerEnd({ home: input.home, team: input.team, root: input.root, by: input.caller, session }, name, temporary ? 'retired' : 'stopped');
        if (ended) logLine(dir, 'add', input.caller, ended.note, input.now());
      }
    },
    // What is not a record — a skip line, a session failure, the watch's sentence — is cleaned
    // here with the same function the records use: no escape sequence or bidi override reaches
    // the terminal from a file's word, a screen's word or a folder's name.
    say: (line) => input.io.stderr(plainText(line)),
    progress: (name, state) => records.progress(name, state),
    final(name, record) {
      // `add` on a pane that is the seat's again: nothing was launched and nothing closed. The
      // record says so, and this is the already-running line instead. A screen the profile does
      // not recognise names the way out for this caller. The record's detail lines go unspoken.
      if (record.kind === 'left out' && record.reason === "its pane is the seat's again; left as it is") {
        swallowed = true;
        const listed = launch.agents(session)?.find((agent) => agent.name === name);
        const unknown = screenUnknown(seat.cli, listed ? launch.paneText(session, listed.pane) : undefined);
        input.outcome.swallowed = true;
        input.outcome.unknown = unknown;
        input.io.stderr(alreadyRunningLine(input.seat.name, input.owner, unknown));
        return;
      }
      swallowed = false;
      input.outcome.swallowed = false;
      records.final(name, record);
    },
    detail(line) {
      if (!swallowed) records.detail(line);
    },
    cliVersion(cli) {
      const profile = profileFor(cli);
      return profile ? input.doctor.version(profile.binary) : null;
    },
    log: (who, what) => logLine(dir, 'add', input.caller, `${who}: ${what}`, input.now()),
  };
}

/** The one command that unblocks an `add` this caller cannot run: an approved delegate's own,
 *  from its pane, when the file names one, otherwise the owner's, in this folder from a terminal
 *  outside herdr. The caller's words are kept, the dry run's and the document's own flags
 *  dropped, so the printed line is a command that runs. */
function unblockingAddRun(argv: string[]): string {
  const words = ['team', 'add', ...withoutOutputFlags(argv).map(shellQuote)];
  return `an approved delegate runs \`${words.join(' ')}\` from its own pane when .agents/team.yaml names one; otherwise the owner runs it from this folder, at a terminal outside herdr`;
}

/** The caller's words without this run's own output flags: the repair names a command that
 *  runs on a terminal, so neither the dry run nor the document belongs in it. */
function withoutOutputFlags(argv: string[]): string[] {
  return argv.filter((word) => word !== '--dry-run' && word !== '--json' && !word.startsWith('--json='));
}

function refusePretrust(io: Io, json: boolean, name: string, line: string, dry: boolean): number {
  if (json) {
    refuse(io, true, 'add', { id: 'add.pretrust', message: line, repair: null });
  } else if (dry) io.stdout(`${plainLine(name)}: would refuse: ${plainText(line)}\ndry run: nothing was run\n`);
  else io.stderr(`team add: refused: ${plainText(line)}\n`);
  // exit: add.pretrust
  return 1;
}

function refuseLobby(io: Io, json: boolean, name: string, text: string, dry: boolean): number {
  if (json) {
    refuse(io, true, 'add', { id: 'add.lobby', message: text, repair: null });
  } else if (dry) io.stdout(`${plainLine(name)}: would refuse: ${plainText(text)}\ndry run: nothing was run\n`);
  else io.stderr(`team add: ${plainText(text)}\n`);
  // exit: add.lobby
  return 1;
}
