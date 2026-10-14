import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { approvalDifferencesOf, budgetsInForceOf, notInForce, recordSeatDigestOf } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { anotherPaneRefusal, describeCaller, fileOwnerRefusal, isOwner, judgeCallerIn, judgeCallerOf, mayChangeTeamVerdict, noPaneRefusal, sessionOwnerRefusal, standingOf, walkCaller } from '../caller.ts';
import { blocksLaunch, doctorFindings, realSources as doctorSources, type DoctorSources } from '../commands/doctor.ts';
import { seatBudget } from '../budgets/gate.ts';
import { loadReadings, loadSpendReadings } from '../budgets/readings.ts';
import type { Launch } from '../commands/up.ts';
import { ADD_DELEGATE_EDIT, delegateGate, logDelegated } from '../delegate.ts';
import { deliverRules, fileRefusalOf, type Refusal } from '../launch/deliver.ts';
import { removeRulesFile, rulesFileHash, rulesFileHolds, seatDeliveryOf, typeablePath, writeRulesFile } from '../launch/rules-file.ts';
import { rulesOf } from '../launch/rules.ts';
import { branchPresent, readMerge } from '../end/condition.ts';
import { branchProblem, resultPathProblem } from '../end/until.ts';
import { clearStopped, hasSeat, restoreSeat, seatIsStopped } from '../file/lines.ts';
import { loadTeamFile, placedProblems } from '../file/load.ts';
import { launchedTeamFile, forgetLaunchedPane, noteLaunchedPane } from '../file/launched-file.ts';
import { migrationText } from '../file/migrate.ts';
import { isLegacyTrust, isMigratedTrust } from '../file/paths.ts';
import { relaunchRepair } from '../file/sections/lead.ts';
import { displayAgent, workspaceLabel } from '../file/sections/seats.ts';
import type { Problem, Seat, TeamFile } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import { writeTeamFile } from '../file/write.ts';
import { recheckLobby, resolveLobby, verifyLobby, type FsReader, type LobbyRefusal, type LobbySeen } from '../lobby/gate.ts';
import {
  agentList, agentRename, agentStatus, paneForeground, paneProcesses, paneRead, paneRun, paneShellBack, pressEnter, reportDisplayAgent, sessionRunning,
  sessionState, startServer, typeText, workspaceClose, workspaceCreate, workspaceList, workspacePanes,
  type HerdrAgent, type PaneProcesses,
} from '../herdr.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { executePlan, type Host } from '../launch/execute.ts';
import { launchedIdentity, replacedSeat, seatProcessVerdict } from '../launch/identity.ts';
import { launchLineFinding } from '../launch/line.ts';
import { lobbyPretrustLine } from '../launch/pretrust.ts';
import { formatPlan, upPlan, type UpSeat } from '../launch/plan.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { progressWriter, type Progress } from '../launch/progress.ts';
import { acquireRunLock, runLockText } from '../launch/run-lock.ts';
import { logLine } from '../log.ts';
import { profileFor, shippedStartupReads } from '../profiles/index.ts';
import { reachProjectionNote, writeReachProjection } from '../reach/projection.ts';
import { emptySession, readState, updateState, withLock, type SeatState, type SessionState } from '../state.ts';
import { approvalStanding, recordLedger, storePath, type Ceilings, type Standing } from '../store/store.ts';
import { launchLimit, readMachine, readingsText, type Machine, type SwapSample } from '../watch/machine.ts';
import { readScreen } from '../watch/screen.ts';
import { seatStart, type SeatStart } from '../worktree/place.ts';

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

export const USAGE = `Usage: team add <name> [--dry-run] [--session <name>] [--file <path>]
       team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>] [--dry-run] [--session <name>] [--file <path>]
`;

/** The gate's refusal as this command prints it: the verdict's own sentence behind the prefix.
 *  Both delegate branches print it — the caller rule's below and the owner-only flags' — so the
 *  exit ids sit at one site. */
function delegateRefused(out: { stderr(text: string): void }, verdict: { text: string }): number {
  out.stderr(`team add: ${plainText(verdict.text)}\n`);
  // exit: add.delegate-approval
  // exit: add.delegate-approved-copy
  // exit: add.delegate-drift
  // exit: add.delegate-evidence
  // exit: add.delegate-placement
  // exit: add.delegate
  // exit: add.delegate-command
  // exit: add.delegate-flag
  return 1;
}

type Running = { name: string; vendor: string; temporary: boolean };
type Until = { kind: 'result'; path: string } | { kind: 'merged'; branch: string };

export const add: Command = (argv, io) => runAdd(argv, io, realSources);
export default add;

export async function runAdd(argv: string[], io: Io, sources: AddSources = realSources): Promise<number> {
  // Every line this run writes goes through the cleaned writers from here; the raw pair stays
  // reachable for the progress writer alone, which draws its own `\r\x1b[K` on a TTY.
  const out = cleanedIo(io);
  const args = readArgs(argv, ['like', 'until', 'worktree', 'session', 'file'], ['temporary', 'dry-run']);
  if (args.error) {
    out.stderr(`team add: ${plainText(args.error)}\n${USAGE}`);
    // exit: add.invocation
    return 2;
  }
  const temporary = args.flags.has('temporary');
  const dry = args.flags.has('dry-run');
  if (temporary ? args.rest.length > 0 : args.rest.length !== 1) {
    out.stderr(`team add: ${plainText(temporary ? `unexpected "${args.rest[0]}"` : 'a seat name is required')}\n${USAGE}`);
    // exit: add.seat-name
    // exit: add.temporary-unexpected
    return 2;
  }
  if (!temporary && (args.values.like || args.values.until || args.values.worktree)) {
    out.stderr('team add: --like, --until and --worktree are for --temporary\n');
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
  const flagRefusal = fileOwnerRefusal(io, args.values.file)
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
      if (flagged.kind === 'refused') return delegateRefused(out, flagged);
    }
    out.stderr(`team add: ${plainText(flagRefusal)}\n`);
    // exit: add.file-owner
    // exit: add.session-owner
    return 1;
  }

  const launched = args.values.file ? undefined : launchedTeamFile(io, sources.home);
  const loaded = loadTeamFile(io.cwd, { ...(args.values.file ?? launched ? { file: args.values.file ?? launched } : {}), home: sources.home });
  if (!loaded.ok) {
    for (const problem of loaded.errors) out.stderr(`team add: ${where(problem)}${plainText(problem.message)}\n`);
    // exit: add.not-a-repo
    // exit: add.file
    // exit: add.file-invalid
    return 2;
  }
  const { team, root, path } = loaded;
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
  const session = judged.session;
  const mayChange = mayChangeTeamVerdict(caller, team, standingOf(dir, session, caller));
  // The delegate branch, tried only when the ordinary rule just refused and the file names a
  // delegate at all: with no `delegates` section every refusal below stays exactly today's, and
  // the gate is never asked. A refused verdict takes the ordinary refusal's place; a passed one
  // sends this run on as the approved delegate's — the gate has by then verified the approval,
  // the approved copy, the drift and the placement, that this caller is the entry's pane, that
  // `add` is in its list and that no flag of the owner's was passed. The run the rest of this
  // command performs is then a delegated one: the would-edit refusal below keeps it from
  // writing the file or the approval, and `logDelegated` attributes it at its effects.
  let delegatePane: string | null = null;
  if (mayChange.kind !== 'ok' && team.delegates) {
    const verdict = (sources.delegateGate ?? delegateGate)({
      command: 'add',
      team,
      root,
      dir,
      flags: [...args.flags, ...Object.keys(args.values)],
      io,
      home: sources.home,
    });
    if (verdict.kind === 'refused') return delegateRefused(out, verdict);
    delegatePane = verdict.pane;
  }
  if (mayChange.kind === 'no-pane' && delegatePane === null) {
    out.stderr(`team add: ${plainText(noPaneRefusal(mayChange.name))}\n`);
    // exit: add.no-pane
    return 1;
  }
  if (mayChange.kind === 'another-pane' && delegatePane === null) {
    out.stderr(`team add: ${plainText(anotherPaneRefusal(mayChange.name, mayChange.recordedPane))}\n`);
    // exit: add.another-pane
    return 1;
  }
  if (mayChange.kind === 'refused' && delegatePane === null) {
    out.stderr(`team add: only the owner, the orchestrator or the operator runs it; this call is ${plainLine(describeCaller(shown))}\n`);
    // exit: add.caller
    return 1;
  }
  if (session === 'default') {
    out.stderr('team add: session can\'t be "default", herdr\'s own session\n');
    // exit: add.default-session
    return 1;
  }
  // One verified snapshot for the whole command: a legacy or refused record is not
  // an approval in force, and the approved copy the seat is built from is the record's own.
  const standing = sources.standing?.(root) ?? approvalStanding(root, sources.home);
  if (standing.kind !== 'verified') {
    out.stderr(`team add: ${plainText(notInForce(standing))}\n`);
    // exit: add.never-approved
    // exit: add.ceilings
    return 1;
  }
  const differences = approvalDifferencesOf(standing, team);
  if (differences.length) {
    out.stderr(`team add: the file is not the approved one (${plainText(differences.join('; '))}): run \`team approve\`\n`);
    // exit: add.differs
    return 1;
  }
  const approvedText = standing.record.file;
  const approved = validateTeamFile(approvedText, { home: sources.home, fs: sources.fs, root });
  if (!approved.ok) {
    out.stderr('team add: the approved copy can\'t be read: run `team approve`\n');
    // exit: add.approved-copy
    return 1;
  }

  const live = sources.sessionState(session);
  if (live === null) {
    out.stderr('team add: herdr doesn\'t answer\n');
    // exit: add.herdr
    return 1;
  }
  if (live === 'stopped') {
    out.stderr(`team add: session ${plainLine(session)} is stopped; clear it with \`herdr session delete ${plainLine(session)}\`\n`);
    // exit: add.stopped
    return 1;
  }
  const agents = live === 'running' ? sources.agents(session) : [];
  // Read so a session whose workspace list can't be read is refused. The title is not a key.
  const workspaces = live === 'running' ? sources.workspaces(session) : [];
  if (agents === null || workspaces === null) {
    out.stderr(`team add: session ${plainLine(session)} runs, and its agents can't be read\n`);
    // exit: add.agents
    return 1;
  }

  const recorded = readState(dir).sessions[session] ?? emptySession();
  const ceilings: Ceilings = standing.record.approval.ceilings;

  const original = readFileSync(path, 'utf8');
  const built = temporary
    ? temporarySeat(args.values, original, approved.team, recorded, agents, root, team.workspace.base)
    : declaredSeat(args.rest[0] ?? '', original, approvedText, approved.team, sources.home, sources.fs);
  if ('error' in built) {
    out.stderr(`team add: ${plainText(built.error)}\n`);
    // exit: add.no-seat
    // exit: add.not-restored
    // exit: add.no-like
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
    out.stderr(`team add: ${plainText(`${built.name}: its pane holds a process this record cannot tie to the launch`)}\n`);
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
    out.stderr(alreadyRunningLine(built.name, caller.kind === 'owner', unknown));
    // exit: add.already-running
    return 1;
  }
  // A delegated add may start only a declared, not-stopped seat that is not running: one that
  // would restore a missing seat or clear `stopped` edits the file and re-signs the approval,
  // and that stays the owner's. Refused after the already-running refusal, before the write,
  // the digest and any dry-run plan — so a delegated add writes neither file nor approval.
  if (delegatePane !== null && built.edited !== original) {
    out.stderr(`team add: ${plainText(ADD_DELEGATE_EDIT.text)}\n`);
    // exit: add.delegate-edit
    return 1;
  }
  if (!profileFor(built.seat.cli)) {
    out.stderr(`team add: no launch profile for \`${plainLine(built.seat.cli)}\` in this version\n`);
    // exit: add.no-profile
    return 1;
  }

  const prepared = validateTeamFile(built.edited, { home: sources.home, fs: sources.fs, root });
  if (!prepared.ok) {
    for (const problem of prepared.errors) out.stderr(`team add: ${where(problem)}${plainText(problem.message)}\n`);
    // exit: add.prepared
    return 2;
  }
  for (const problem of placedProblems(prepared.team, root, sources.home, sources.fs)) {
    out.stderr(`team add: ${plainText(problem.message)}\n`);
    // exit: add.placed
    return 1;
  }
  const lobby = resolveLobby(sources.home, prepared.team);
  let startProblem: string | null = null;
  let verifiedLobby: string | null = null;
  let lobbySeen: LobbySeen | null = null;
  // Paths a shipped CLI reads at start. The lobby is checked only when this seat is about
  // to launch there, after `wouldLaunch` is known, so a dry run refuses in the same words.
  const startupReads = shippedStartupReads();
  if (!prepared.team.trust || prepared.team.trust.length === 0 || isLegacyTrust(prepared.team.trust)) {
    startProblem = `the file is legacy: migrate trust to absolute paths including the lobby ${lobby}:\n${migrationText(prepared.team, root, sources.home)}`;
  }
  // Where the seat waits: the lobby the gate verified, or a refusal — before the file is edited.
  const start: SeatStart = startProblem
    ? { problem: startProblem }
    : seatStart(prepared.team, built.seat, root, sources.home, verifiedLobby ?? undefined);
  if ('problem' in start) {
    out.stderr(`team add: ${plainText(start.problem)}\n`);
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
  const stray = repair ? undefined : unnamedIn(recorded.seats[built.name]?.workspace, agents);
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
  // `\r\x1b[K` on a TTY, and the cleaned pair would strip those bytes.
  const records = progressWriter({ stdout: io.stdout, stderr: io.stderr, isTTY: io.stdoutIsTTY ?? false });
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
    : prepared.team;
  // `team` is the file on disk, already the approved one. `doctorTeam` is the
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
      // A file a CLI reads at start is said here and refused later, only when this seat is
      // about to start in the lobby. Other misses still stop the run here.
      if (finding.text.includes(' is read at start by ')) {
        const warning = `team add: warning: ${plainText(finding.text)}\n`;
        if (dry) out.stdout(warning);
        else out.stderr(warning);
        continue;
      }
      const launchText = launchProblem ? `${built.name}: ${launchProblemDetail ?? launchProblem}` : '';
      if (dry && launchProblem && !stray && finding.text === launchText) {
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
    out.stderr(`team add: ${plainText(first.problem)}\n`);
    // exit: add.machine
    return 1;
  }
  const running = runningOf(agents, prepared.team, recorded);
  const room = ceilingProblem(ceilings, running, built.seat, Boolean(built.temporary));
  if (room) {
    out.stderr(`team add: ${plainText(room)}\n`);
    // exit: add.ceiling
    return 1;
  }
  const again = crossed();
  if (again?.problem) {
    if (!dry) logLine(dir, 'add', describeCaller(caller), `refused: ${again.problem} — readings: ${readingsText(again.machine)}`, sources.now());
    out.stderr(`team add: ${plainText(again.problem)}\n`);
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
    if (dry) {
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
    if (!gate.ok) return refuseLobby(out, built.name, gate.text, dry);
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
    if (line) {
      if (!dry) return refusePretrust(out, built.name, line, false, '');
      const preview = upPlan({
        root,
        session,
        sessionRunning: live === 'running',
        seats: [{ ...trustSeat, launchProblem: line }],
        watchAlive: true,
      });
      const shown = decision.kind === 'unknown'
        ? `${plainLine(built.name)}: ${plainText(decision.text)}\n${plainText(formatPlan(preview))}`
        : plainText(formatPlan(preview));
      return refusePretrust(out, built.name, line, true, shown);
    }
  }
  if (dry) {
    if (decision.kind === 'unknown') out.stdout(`${plainLine(built.name)}: ${plainText(decision.text)}\n`);
    const preview = upPlan({
      root,
      session,
      sessionRunning: live === 'running',
      seats: [seatForPlan],
      watchAlive: true,
    });
    out.stdout(plainText(formatPlan(preview)));
    // exit: add.dry-run
    return 0;
  }
  // The session mutator lock: from here this run has effects — the lobby make below when it
  // is absent, the delegated audit line, the file edit, the launch — and no other session
  // command may interleave its own. Every refusal above is decided first, a dry run returned
  // above, and the lock is released on every exit path (`launch/run-lock.ts`).
  const runLock = acquireRunLock(dir, session);
  if ('held' in runLock) {
    out.stderr(`team add: ${plainText(runLockText(runLock.held, session, dir))}\n`);
    // exit: add.run-lock
    return 1;
  }
  try {
    if (intoLobby) {
      const gate = verifyLobby(sources.home, { create: true, getuid: sources.getuid, fs: sources.fs, reads: startupReads, lobby });
      if (!gate.ok) return refuseLobby(out, built.name, gate.text, false);
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
      if (line) return refusePretrust(out, built.name, line, false, '');
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
        out.stderr('team add: the file changed while add was checking; nothing was written\n');
        // exit: add.changed
        return 1;
      }
      if (written.kind === 'invalid') {
        for (const problem of written.errors) out.stderr(`team add: ${where(problem)}${plainText(problem.message)}\n`);
        // exit: add.locked
        return 2;
      }
      const parsed = validateTeamFile(built.edited, { home: sources.home, fs: sources.fs, root });
      // The amendment re-signs from the command's own one snapshot, read at its gate.
      if (parsed.ok) recordSeatDigestOf(standing, parsed.team, root, built.name, sources.home);
      // The reach projection, from the file just written: a seat added with a `reach` grant
      // reaches the bridge and the shuttle at this approval, without waiting for an `up`.
      if (parsed.ok) {
        const projectionNote = reachProjectionNote(writeReachProjection(parsed.team, sources.home));
        if (projectionNote) logLine(dir, 'add', describeCaller(caller), projectionNote, sources.now());
      }
    }

    const planSeat = verifiedLobby && seatForPlan.lobby ? { ...seatForPlan, cwd: verifiedLobby } : seatForPlan;
    const plan = upPlan({ root, session, sessionRunning: live === 'running', seats: [planSeat], watchAlive: true });
    const who = describeCaller(caller);
    const host = hostOf({
      dir, session, team: prepared.team, root, home: sources.home, ceilings, running, seat: built.seat, temporary: built.temporary,
      caller: who, owner: caller.kind === 'owner', now: sources.now, launch: sources.launch, readMachine: sources.machine, samples, limits: team.machine, io: out, standing,
      verifiedLobby, startCwd: planSeat.cwd, inLobby: planSeat.lobby === true, records, teamFile: path,
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
    const afterwards = readState(dir).sessions[session]?.seats[built.name];
    const launched = !report.held && !report.dropped.includes(built.name) && afterwards?.stage === 'ready';
    if (launched && built.temporary) {
      recordLedger(storePath(team.project, root, sources.home), [built.seat]);
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
  name: string, current: string, approvedText: string, approved: TeamFile, home: string, fs?: FsReader,
): { name: string; seat: Seat; edited: string; temporary?: undefined } | { error: string } {
  const seat = approved.seats.find((item) => item.name === name);
  if (!seat) return { error: `the approved file has no seat ${JSON.stringify(name)}` };
  let edited = hasSeat(current, name) ? current : restoreSeat(current, approvedText, name);
  if (seat.stopped || seatIsStopped(edited, name)) edited = clearStopped(edited, name);
  const again = validateTeamFile(edited, { home, fs });
  const restored = again.ok ? again.team.seats.find((item) => item.name === name) : undefined;
  if (!restored) return { error: `couldn't put ${name} back from the approved copy` };
  return { name, seat: { ...restored, stopped: false }, edited, temporary: undefined };
}

function temporarySeat(
  values: Record<string, string>, current: string, approved: TeamFile, state: SessionState, agents: readonly HerdrAgent[],
  root: string, base: string | null,
): { name: string; seat: Seat; edited: string; temporary: NonNullable<SeatState['temporary']> } | { error: string } {
  const like = approved.seats.find((item) => item.name === values.like);
  if (!like) return { error: `the approved file has no seat ${JSON.stringify(values.like)}` };
  const until = parseUntil(values.until ?? '');
  if (!until) return { error: '--until is result:<path> or merged:<branch>' };
  let own: boolean | undefined;
  if (until.kind === 'result') {
    const problem = resultPathProblem(root, until.path);
    if (problem) return { error: problem };
    if (existsSync(resolve(root, until.path))) return { error: `${until.path} already exists` };
  } else if (!base) {
    return { error: 'workspace.base is required to read a merged end' };
  } else {
    const name = branchProblem(root, until.branch);
    if (name) return { error: name };
    const read = readMerge(root, until.branch, base, false);
    const here = branchPresent(root, until.branch);
    if (read.detail.includes('the branch is gone') || here === false) return { error: `branch ${until.branch} doesn't exist` };
    if (here !== true && read.verdict === 'unproven') return { error: read.detail };
    own = read.ownNow > 0;
  }
  const task = values.worktree;
  const worktree = task ? state.worktrees[task] : undefined;
  if (task && !worktree) return { error: `no worktree named ${JSON.stringify(task)} is recorded` };
  if (worktree?.setup === 'failed') return { error: `worktree ${task} has a failed setup; team worktree remove ${task}` };
  const name = temporaryName(like.name, approved, state, agents);
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

function temporaryName(like: string, team: TeamFile, state: SessionState, agents: readonly HerdrAgent[]): string {
  const used = new Set([...team.seats.map((seat) => seat.name), ...Object.keys(state.seats), ...agents.map((agent) => agent.name ?? '')]);
  let n = 1;
  while (used.has(`${like}-tmp-${n}`)) n++;
  return `${like}-tmp-${n}`;
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
    // The team file's own repair for this seat — a lead seat is told only the whole-team
    // sequence, never a `remove --keep` its file refuses (`lead.ts`).
    repairLine: relaunchRepair(team, seat.name, 'markdown'),
    stopped: false,
    // An option seat's rules keep coming from the live file, as main's launch line does; a
    // message seat's file and line are the approved copy's, whatever the live file says now.
    rules: rulesOf(team, seat, root),
    ...seatDeliveryOf(standing, team, seat, root, home),
    ...(start.lobby ? { lobby: true } : {}),
  };
}

function unnamedIn(workspace: string | undefined, agents: readonly HerdrAgent[]): HerdrAgent | undefined {
  if (!workspace) return undefined;
  return agents.find((agent) => !agent.name && agent.workspace === workspace);
}

function runningOf(agents: readonly HerdrAgent[], team: TeamFile, state: SessionState): Running[] {
  const seats = new Map(team.seats.map((seat) => [seat.name, seat]));
  const running: Running[] = [];
  for (const agent of agents) {
    if (!agent.name) continue;
    const seat = seats.get(agent.name);
    const known = state.seats[agent.name];
    if (!seat && !known?.temporary) continue;
    const like = known?.temporary ? seats.get(known.temporary.like) : undefined;
    running.push({ name: agent.name, vendor: seat?.vendor ?? like?.vendor ?? 'unknown', temporary: Boolean(known?.temporary) });
  }
  return running;
}

function ceilingProblem(ceilings: Ceilings, running: readonly Running[], seat: Seat, temporary: boolean): string | null {
  if (running.some((item) => item.name === seat.name)) return null;
  if (running.length + 1 > ceilings.seats) return `the approval allows ${ceilings.seats} seats; ${running.length + 1} would be running`;
  if (temporary && running.filter((item) => item.temporary).length + 1 > ceilings.temporary) {
    return `the approval allows ${ceilings.temporary} temporary seats; ${running.filter((item) => item.temporary).length + 1} would be running`;
  }
  const cap = ceilings.vendors[seat.vendor];
  if (cap !== undefined) {
    const vendors = running.filter((item) => item.vendor === seat.vendor).length + 1;
    if (vendors > cap) return `the approval allows ${cap} ${seat.vendor} seats; ${vendors} would be running`;
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
function alreadyRunningLine(name: string, owner: boolean, unknown: boolean): string {
  const who = plainLine(name);
  const base = `team add: ${who} is already running`;
  if (!unknown) return `${base}\n`;
  const way = owner
    ? `team remove ${who} --abandon closes its workspace without typing`
    : `the owner runs team remove ${who} --abandon, which closes its workspace without typing`;
  return `${base} (${way})\n`;
}

function hostOf(input: {
  dir: string; session: string; team: TeamFile; root: string; home: string; ceilings: Ceilings; running: Running[];
  seat: Seat; temporary?: SeatState['temporary']; caller: string; owner: boolean; now(): Date; launch: Launch;
  readMachine?: (root: string) => Machine; samples: SwapSample[]; limits: TeamFile['machine']; io: Io;
  standing: Standing;
  teamFile: string;
  verifiedLobby: string | null;
  /** The folder this seat's workspace is created in. A lead's is the project; a lobby seat's is the verified lobby. */
  startCwd: string;
  inLobby: boolean;
  /** The run's writer, made by the caller before the launch-line note is said. */
  records: Progress;
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
    ...(launch.reportDisplayAgent
      ? { reportDisplayAgent: (session: string, pane: string, text: string) => launch.reportDisplayAgent!(session, pane, text) }
      : {}),
    typeLine: () => false,
    deliverRules: async (session, pane, cli, file, seconds) => {
      // The rules go to the file first; nothing is typed until it holds them. The writer
      // builds the path itself, from the approval in force and the seat's name.
      const written = writeRulesFile(input.standing, file.seat, input.root, input.home, file.text, rulesFileHash(file.text));
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
        // The process identity goes in the same write, so the owner's later `team up` — and
        // `team answer` — can tell a pane that is still the seat's from one that is not.
        const identity = launchedIdentity(launch.processInfo?.(session, pane) ?? null);
        current.seats[name] = {
          ...prior,
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
    shellBack: (_name, pane) => launch.shellBack?.(session, pane) ?? null,
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
        let start_cwd = prior.start_cwd;
        if (!start_cwd && patch.createdWorkspace) {
          if (input.inLobby) {
            if (input.verifiedLobby) start_cwd = input.verifiedLobby;
          } else {
            start_cwd = input.startCwd;
          }
        }
        // `waiting: null` removes the field alone; anything else written replaces it.
        const { waiting: written, ...rest } = patch;
        const seatState: SeatState = { ...prior, ...rest, ...(temporary && name === seat.name ? { temporary } : {}), ...(start_cwd ? { start_cwd } : {}) };
        if (written === null) delete seatState.waiting;
        else if (written) seatState.waiting = written;
        current.seats[name] = seatState;
        if (patch.pane) {
          replaced = prior.pane !== patch.pane ? prior.pane : undefined;
          current.launched_file = input.teamFile;
        }
      });
      if (patch.pane) {
        if (replaced) forgetLaunchedPane(input.home, replaced, session);
        noteLaunchedPane(input.home, input.teamFile, patch.pane, session);
      }
    },
    running(name) {
      if (!running.some((item) => item.name === name)) running.push({ name, vendor: seat.vendor, temporary: Boolean(temporary) });
    },
    drop(name) {
      // A temporary seat's rules file goes with the seat. The remover builds the path itself,
      // from the approval in force and the seat's name, and walks the writer's checked chain.
      if (temporary && name === seat.name) removeRulesFile(input.standing, name, input.root, input.home);
      let pane: string | undefined;
      updateState(dir, (file) => {
        const seats = file.sessions[session]?.seats;
        pane = seats?.[name]?.pane;
        if (seats) delete seats[name];
      });
      if (pane) forgetLaunchedPane(input.home, pane, session);
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
        input.io.stderr(alreadyRunningLine(input.seat.name, input.owner, unknown));
        return;
      }
      swallowed = false;
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

function refusePretrust(out: Io, name: string, line: string, dry: boolean, preview: string): number {
  if (dry) out.stdout(preview);
  else out.stderr(`team add: ${plainLine(name)}: ${plainText(line)}\n`);
  // exit: add.pretrust
  return 1;
}

function refuseLobby(out: Io, name: string, text: string, dry: boolean): number {
  if (dry) out.stdout(`${plainLine(name)}: would refuse: ${plainText(text)}\ndry run: nothing was run\n`);
  else out.stderr(`team add: ${plainText(text)}\n`);
  // exit: add.lobby
  return 1;
}
