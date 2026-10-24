import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import { dialogsTrustInForce } from '../permissions/dialogs-trust.ts';
import { readArgs } from '../args.ts';
import { anotherPaneRefusal, callerOf, callerVerdict, describeCaller, detachedRefusal, fileOwnerRefusal, isOwner, judgeCallerIn, logTag, noPaneRefusal, sessionOwnerRefusal, standingOf, walkCaller, type Caller, type SeatStanding } from '../caller.ts';
import { canonicalLanding, folderOf, listFolder } from '../file/landing.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { launchedTeamFile } from '../file/launched-file.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { agentList, agentRename, agentStatus, paneForeground, paneForegroundCwd, paneProcesses, paneRead, pressEnter, sendKey as herdrSendKey, typeText, type PaneProcesses } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { deliverRules, type Delivery } from '../launch/deliver.ts';
import { seatProcessVerdict, type LaunchedIdentity } from '../launch/identity.ts';
import { rulesDeliveryOf, rulesFileHash, rulesFileHolds, writeRulesFile } from '../launch/rules-file.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { lobbyOf } from '../lobby/recorded.ts';
import { logLine } from '../log.ts';
import { contextLine, hasJsonFlag, writeJson, writeJsonError } from '../output/index.ts';
import { profileFor } from '../profiles/index.ts';
import { type Profile } from '../profiles/profile.ts';
import { extractFolder, isEligible, keyOf, labelMatches, versionMatches, type TrustRecord } from '../profiles/trust-answer.ts';
import { emptySession, readState, updateState, type SeatState } from '../state.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { readScreen } from '../watch/screen.ts';

export const USAGE = `Usage: team answer <seat> trust [--session <name>] [--file <path>] [--json]

Presses the one recorded key of a folder-trust dialog, and only that key. Every check has
to pass on two fresh reads of the pane, and the folder must be the lobby on three readings
at once: the path the screen shows, the folder the pane itself reports working in, and the
lobby's parent directory. <seat> names one seat of the team file; trust is the only
dialog word. No option takes a key, a text, or another dialog. The pane is herdr's one agent
of that name; a pane recorded in the state selects nothing. A name the file does not carry
is left as it is, and two agents of the name send nothing. --session is the owner's alone,
and so is --file: each is refused before the flagged session or file is read. The answer
opens on the team's context line and closes on <seat>: answered trust (<folder>). A refused
or incomplete answer names its reason on stderr, and a recovery stays recorded for the next
answer to observe. --json prints one document instead of the lines: {format, dry_run,
status, action_summary, project, session, seat, pane, dialog, state, folder?}. A run that
exits 1 or 2 writes the structured error document instead — {error: {id, message, repair}} —
and stderr stays empty.

Exits 0 when the trust dialog is answered and the seat is ready, 1 when the answer is
refused or does not complete, 2 when the invocation or team file can't be read.
`;

const OUTSIDE = 'ask the owner to add this exact folder to trust and answer through team up';

export type AnswerHost = {
  version(binary: string): string | null;
  agents(session: string): { name: string; pane: string; workspace?: string }[] | null;
  pane(session: string, pane: string): string | undefined;
  sendKey(session: string, pane: string, key: string): boolean;
  rename(session: string, pane: string, name: string): boolean;
  foreground(session: string, pane: string): string[] | null;
  foregroundCwd(session: string, pane: string): string | null;
  list(dir: string): string[] | null;
  status(session: string, pane: string): string | null;
  type(session: string, pane: string, text: string): boolean;
  enter(session: string, pane: string): boolean;
  /** The pane's process identity; null when herdr can't tell. */
  processInfo?(session: string, pane: string): PaneProcesses | null;
  now(): Date;
  sleep(ms: number): Promise<void>;
  home: string;
  standing(root: string): Standing;
};

export const realHost: AnswerHost = {
  version(binary) {
    try {
      return execFileSync(binary, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    } catch {
      return null;
    }
  },
  agents: (session) => agentList(session)?.map((agent) => ({ name: agent.name ?? '', pane: agent.pane, workspace: agent.workspace })) ?? null,
  pane: (session, pane) => paneRead(pane, 40, session) ?? undefined,
  sendKey: (session, pane, key) => herdrSendKey(pane, key, session),
  rename: (session, pane, name) => agentRename(pane, name, session),
  foreground: (session, pane) => paneForeground(pane, session),
  foregroundCwd: (session, pane) => paneForegroundCwd(pane, session),
  list: (dir) => listFolder(dir),
  status: (session, pane) => agentStatus(pane, session),
  type: (session, pane, text) => typeText(pane, text, session),
  enter: (session, pane) => pressEnter(pane, session),
  processInfo: (session, pane) => paneProcesses(pane, session),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  home: homedir(),
  standing: (root) => approvalStanding(root, homedir()),
};

type Reason = 'caller' | 'policy' | 'state' | 'screen' | 'version' | 'label' | 'folder' | 'action' | 'process' | 'idle' | 'rule delivery' | 'human';

/** A refusal class that is also a contract row: every class word is the row id's last word. */
type RefusalClass = Exclude<Reason, 'idle' | 'rule delivery'>;

type Refusal = {
  /** The `contract/exit-codes.json` row this refusal answers; the `--json` error carries it. */
  id: string;
  class: Reason;
  /** The human sentence, as the plain run prints it (a caller sentence keeps its prefix). */
  message: string;
  /** The actionable repair an error document carries, or absent for none. */
  repair?: string | null;
};

/** A refusal whose contract row is `answer.<class>`. */
function refusedClass(reason: RefusalClass, message: string): Refusal {
  return { id: `answer.${reason}`, class: reason, message };
}

type Seen = { record: TrustRecord; version: string; folder: string };

const answer: Command = (argv, io) => runAnswer(argv, io, realHost);
export default answer;

export async function runAnswer(argv: string[], io: Io, host: AnswerHost): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['json']);
  // Raw argv, before the parser: `--nope --json` and `--json=1` must still answer with the
  // structured error document, and the parser errors before its flag set sees them.
  const json = hasJsonFlag(argv);
  const seatName = args.rest[0];
  const dialog = args.rest[1];
  if (args.error || args.rest.length !== 2 || !seatName || dialog !== 'trust') {
    const message = args.error ?? (dialog && dialog !== 'trust' ? `unknown dialog "${dialog}"` : 'a seat and trust are required');
    return usage(io, json, message);
  }
  const detached = detachedRefusal(walkCaller(io), { who: 'the owner or the orchestrator from its own seat', where: 'a terminal outside herdr or its own seat' });
  if (detached !== undefined) {
    if (json) writeJsonError(io, 'answer.detached', detached, 'run team answer from a terminal outside herdr');
    else io.stderr(`team answer: ${detached}\n`);
    // exit: answer.detached
    return 1;
  }

  // The `--file` check is the walk's, and it runs before that file is read: a non-owner aiming
  // `--file` must not make this command read and validate another project's team file, nor leave
  // a refusal log beside it. `fileOwnerRefusal` (caller.ts) is the one place every command
  // whose `--file` is the owner's decides it; the walk reads no session, no state and no log.
  const fileRefusal = fileOwnerRefusal(io, args.values.file);
  if (fileRefusal !== undefined) {
    if (json) writeJsonError(io, 'answer.file-owner', fileRefusal, null);
    else io.stderr(`team answer: ${fileRefusal}\n`);
    // exit: answer.file-owner
    return 1;
  }
  // The owner is a terminal outside herdr, and the walk alone decides that: a non-owner aiming
  // `--session` is refused here, before `launchedTeamFile` or any other call that reaches herdr,
  // and before the flag's session is read — no agent list, no pane root, no state write. (A seat
  // cannot be named in this refusal: placing it would read a session, and that is what must not
  // happen yet.) When this folder has a team file, the refusal's log line sits beside it. When
  // it does not, the sentence is the only output: no `.agents` folder and no log are created.
  if (args.values.session !== undefined) {
    const walked = walkCaller(io);
    if (!isOwner(walked)) {
      const local = readTeamConfig(io.cwd, { home: host.home });
      return refuse(
        io,
        json,
        local.ok ? dirname(local.path) : undefined,
        logTag(walked),
        seatName,
        host,
        {
          id: 'answer.session-owner',
          class: 'caller',
          message: `team answer: ${sessionOwnerRefusal(walked)}`,
        },
      );
    }
  }
  const launched = args.values.file ? undefined : launchedTeamFile(io, host.home);
  const loaded = readTeamConfig(io.cwd, { ...(args.values.file ?? launched ? { file: args.values.file ?? launched } : {}), home: host.home });
  if (!loaded.ok) {
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return configuration(io, json, message || 'the team file cannot be read');
  }
  const { team, root } = loaded;
  const dir = dirname(loaded.path);
  // A non-owner's `--session` has already returned, above, so this arm is the owner's: the flag's
  // session, placed with `callerOf`. With no `--session` the session judged is the caller's own
  // placement: the file's session first, then a session the state records this caller's pane in
  // (`team up --session <other>`) — never one a non-owner chose. The refusal names the caller's
  // own placement, exactly as main described it.
  const judged = args.values.session !== undefined
    ? { caller: callerOf(io, args.values.session), session: args.values.session }
    : judgeCallerIn(io, dir, team);
  const { caller } = judged;
  const session = judged.session;
  const who = logTag(caller);

  const refused = (reason: Refusal): number => refuse(io, json, dir, who, seatName, host, reason);

  const callerProblem = callerProblemOf(caller, team, seatName, standingOf(dir, session, caller));
  if (callerProblem) return refused(callerProblem);
  // A pane the file marks as a human's never takes a dialog key or a rules line: this command
  // presses one and types the other, so it refuses before the seat's lock, state or screen is
  // read. The mark is the file's, the last word over any record a launch left behind.
  const humanSeat = team.seats.find((seat) => seat.name === seatName);
  if (humanSeat?.human === true) {
    return refused(refusedClass('human', `${seatName}: the pane is a human's; no dialog key is pressed and no rules line is typed; left as it is`));
  }
  // The setting is the owner's live grant: a team grant carrying `dialogs.trust`, read fresh
  // here. No file key and no approval stand behind it — off is the default, the owner turns it
  // on with `team grant @team --capabilities dialogs.trust`, and a revocation ends it at the
  // next dialog. The recovery path below still receives the standing, whose rules delivery
  // reads no approval gate.
  const standing = host.standing(root);
  if (!dialogsTrustInForce(host.home, root, host.now())) {
    return refused(refusedClass('policy', `${seatName}: use team up and [o] (dialogs.trust is off; only the owner can turn it on: team grant @team --capabilities dialogs.trust)`));
  }

  const lock = acquireSeatLock(dir, session, seatName);
  if (!('release' in lock)) return refused(refusedClass('state', `${seatName}: another command holds it`));
  try {
    const state = readState(dir).sessions[session] ?? emptySession();
    const recorded = state.seats[seatName];
    // The seat is the file's, and the pane is herdr's one agent of that name — or, when a new
    // seat paused at trust before the rename step named it, the unnamed agent on the pane its
    // waiting-for-trust record holds. A name the file does not carry is left for the owner.
    const configured = team.seats.find((seat) => seat.name === seatName);
    if (!configured) {
      if (!recorded) return refused({ id: 'answer.unverified', class: 'state', message: `${seatName}: it is not a live seat` });
      return refused({
        id: 'answer.unverified',
        class: 'state',
        message: `${seatName}: its record is not a declared seat; left as it is (the owner cleans it: team remove ${seatName} --abandon)`,
      });
    }
    const agents = host.agents(session);
    const named = agents?.filter((item) => item.name === seatName) ?? [];
    const onRecorded =
      named.length === 0 &&
      recorded?.waiting?.classification === 'trust' &&
      recorded.pane !== undefined
        ? agents?.find((item) => item.pane === recorded.pane && !item.name)
        : undefined;
    const agent = named.length === 1 ? named[0] : onRecorded;
    if (!agent) {
      if (named.length > 1) {
        return refused({ id: 'answer.ambiguous', class: 'state', message: `${seatName}: herdr lists more than one agent of this name; left as it is` });
      }
      return refused(refusedClass('state', `${seatName}: it is not a live seat`));
    }
    const pane = agent.pane;
    const workspace = agent.workspace;
    const waiting = recorded?.waiting;
    if (waiting?.manual === true) return refused(refusedClass('state', `${seatName}: the owner has the pane open`));
    if (waiting?.state === 'trust-sent-recovery') {
      return await finish(io, json, host, dir, session, who, seatName, team, configured, pane, workspace, root, standing, recorded?.launched, waiting.folder);
    }
    if (waiting?.state !== 'waiting-owner' || waiting.classification !== 'trust') {
      return refused(refusedClass('state', `${seatName}: it is not waiting at a trust dialog`));
    }

    const cli = configured.cli;
    const profile = profileFor(cli);
    // The lobby the file resolves to: its own when the file sets `entity` or `lobby`, else
    // the machine-global one. The folder shown in the dialog must be this lobby, as team writes it.
    const answerLobby = lobbyOf(host.home, root, { ...team, session });
    const checked = inspect(seatName, host, session, pane, profile, team.trust, answerLobby, root, recorded?.launched);
    if ('class' in checked) return refused(checked);
    const again = inspect(seatName, host, session, pane, profile, team.trust, answerLobby, root, recorded?.launched);
    if ('class' in again) return refused(again);
    if (again.folder !== checked.folder) return refused(refusedClass('folder', `${seatName}: ${OUTSIDE}`));
    if (again.record.from !== checked.record.from || again.record.to !== checked.record.to || again.record.action !== checked.record.action) {
      return refused(refusedClass('version', `${seatName}: this version has no trust answer`));
    }
    const key = keyOf(checked.record.action);
    if (!key) {
      return refused(refusedClass('action', `${seatName}: the recorded key is not one this version sends`));
    }
    // The recovery intent is on disk before the key: a crash between the two leaves a
    // recovery that may never have sent (a retry only observes), never a waiting-owner
    // whose retry sends a second time.
    if (!recordRecovery(dir, session, seatName, {
      state: 'trust-sent-recovery',
      classification: 'trust',
      sentAt: host.now().toISOString(),
      version: checked.version,
      folder: checked.folder,
    }, pane, workspace)) {
      return refused(refusedClass('state', `${seatName}: its recovery state could not be recorded`));
    }
    const keyProcessProblem = checkProcess(seatName, host, session, pane, recorded?.launched);
    if (keyProcessProblem) {
      // Nothing was sent, so this clean refusal puts the record back exactly as it was: the
      // seat is waiting for its owner again, and a later answer can still answer it. The
      // write above exists only for the crash case — that window stays write-before-key. A
      // rollback that does not take leaves the recovery, the direction that only observes.
      if (!restoreWaiting(dir, session, seatName, waiting, pane, workspace)) {
        return refused({ id: keyProcessProblem.id, class: 'state', message: `${keyProcessProblem.message} (it is still recorded as a recovery)` });
      }
      return refused(keyProcessProblem);
    }
    let sent = false;
    try {
      sent = host.sendKey(session, pane, key);
    } catch {
      sent = false;
    }
    if (!sent) {
      logLine(dir, 'answer', who, `${seatName}: refused trust: action`, host.now());
      return recovery(io, json, `${seatName}: the key could not be sent; recovery required`);
    }
    return await finish(io, json, host, dir, session, who, seatName, team, configured, pane, workspace, root, standing, recorded?.launched, checked.folder);
  } finally {
    lock.release();
  }
}

function callerProblemOf(caller: Caller, team: TeamFile, seat: string, at: SeatStanding): Refusal | null {
  if (caller.kind === 'owner') return null;
  // The orchestrator's seat, in the session judged and on its recorded pane; a seat of another
  // session, or one merely renamed, falls through to the refusal below, unchanged.
  const verdict = callerVerdict(caller, team.orchestrator, at);
  if (verdict.kind === 'ok') return null;
  if (verdict.kind === 'no-pane') return { id: 'answer.no-pane', class: 'caller', message: `team answer: ${noPaneRefusal(verdict.name)}` };
  if (verdict.kind === 'another-pane') {
    return { id: 'answer.another-pane', class: 'caller', message: `team answer: ${anotherPaneRefusal(verdict.name, verdict.recordedPane)}` };
  }
  if (caller.kind === 'unplaced') return refusedClass('caller', caller.reason);
  if (caller.kind === 'pane') return refusedClass('caller', describeCaller(caller));
  return refusedClass('caller', `${seat}: only the owner, or the orchestrator from its own seat, can answer`);
}

function checkProcess(
  seat: string,
  host: AnswerHost,
  session: string,
  pane: string,
  launched?: LaunchedIdentity,
): Refusal | null {
  if (!launched) return null;
  const info = host.processInfo ? host.processInfo(session, pane) : null;
  const verdict = seatProcessVerdict(launched, info);
  if (verdict === 'unknown') return refusedClass('process', `${seat}: its pane could not be read`);
  if (verdict !== 'same') return refusedClass('process', `${seat}: the process in its pane is not the one team launched`);
  return null;
}

/**
 * One fresh reading of the pane: the record this version answers, or the class that
 * refused. `trust` is the file's own `trust:` list — the folder must be an entry
 * of what the file names.
 */
function inspect(
  seat: string,
  host: AnswerHost,
  session: string,
  pane: string,
  profile: Profile | null,
  trust: readonly string[],
  resolvedLobby: string,
  root: string,
  launched?: LaunchedIdentity,
): Seen | Refusal {
  const say = (reason: 'version' | 'screen' | 'label' | 'folder', text: string): Refusal =>
    refusedClass(reason, `${seat}: ${text}`);
  const problem = checkProcess(seat, host, session, pane, launched);
  if (problem) return problem;
  if (!profile) return say('version', 'this version has no trust answer');
  const printed = host.version(profile.binary);
  const record = printed
    ? profile.answers.find((item) => isEligible(profile.cli, item) && versionMatches(item, printed))
    : undefined;
  if (!printed || !record) return say('version', 'this version has no trust answer');
  const screen = host.pane(session, pane);
  if (readScreen(profile.cli, screen).kind !== 'trust') return say('screen', 'the pane is not the trust dialog');
  if (!labelMatches(record, screen ?? '')) return say('label', 'the trust choice is not the recorded one');
  const shown = extractFolder(record.extract, screen ?? '');
  if (!shown) return say('folder', 'the dialog does not show exactly one folder');
  // `shown` must be the lobby as team writes it, byte for byte, and canonicalise to
  // it — a trailing slash, another case, `//` or `/./` is a different spelling, and
  // the reading that sends less is to refuse it.
  const lobby = canonicalLanding(resolvedLobby);
  if (!lobby) return say('folder', OUTSIDE);
  if (canonicalLanding(shown) !== lobby) return say('folder', OUTSIDE);
  if (shown !== lobby) return say('folder', 'the dialog does not show the lobby as written: the owner answers it through team up');
  // The screen read strips the row's trailing padding, so the last byte of the path it
  // shows is never proof — a boxed row has no visible end. Two other readings, fresh with
  // this one, must say the lobby too: the folder the pane itself reports working in, byte
  // for byte, and the lobby's parent, where a name the lobby's plus whitespace would be
  // the folder such trimming could have hidden.
  const own = host.foregroundCwd(session, pane);
  if (own === null) return say('folder', "the pane's folder cannot be read");
  if (own !== lobby) return say('folder', "the pane's folder is not the lobby as written");
  const names = host.list(dirname(lobby));
  if (names === null) return say('folder', "the lobby's parent folder cannot be read");
  const base = basename(lobby);
  if (names.some((name) => name.length > base.length && name.startsWith(base) && /\s/.test(name.charAt(base.length)))) {
    return say('folder', "the lobby's parent folder holds a name that differs from the lobby's by whitespace alone");
  }
  const listed = trust.some((entry) => canonicalLanding(folderOf(entry, root)) === lobby);
  if (!listed) return say('folder', 'this folder is not an exact trust entry');
  return { record, version: printed, folder: lobby };
}

/**
 * Writes the recovery record and reads it back: the key is only sent when the intent is
 * on disk, not merely handed to a writer. A write fault, or a state that reads back
 * without the record, refuses the send.
 */
function recordRecovery(
  dir: string,
  session: string,
  name: string,
  waiting: NonNullable<SeatState['waiting']>,
  pane: string,
  workspace: string | undefined,
): boolean {
  try {
    writeWaiting(dir, session, name, waiting, pane, workspace);
    const back = readState(dir).sessions[session]?.seats[name]?.waiting;
    return back?.state === 'trust-sent-recovery' && back.classification === 'trust';
  } catch {
    return false;
  }
}

/**
 * Puts back the waiting record a seat had before a recovery write that never reached its
 * key: written and read back, exactly as `recordRecovery` does. False when it does not
 * take, and the seat then keeps the recovery — which only ever observes a retry.
 */
function restoreWaiting(
  dir: string,
  session: string,
  name: string,
  waiting: NonNullable<SeatState['waiting']>,
  pane: string,
  workspace: string | undefined,
): boolean {
  try {
    writeWaiting(dir, session, name, waiting, pane, workspace);
    const back = readState(dir).sessions[session]?.seats[name]?.waiting;
    return back?.state === 'waiting-owner' && back.classification === waiting.classification;
  } catch {
    return false;
  }
}

function writeWaiting(
  dir: string,
  session: string,
  name: string,
  waiting: NonNullable<SeatState['waiting']>,
  pane: string,
  workspace: string | undefined,
): void {
  updateState(dir, (state) => {
    const current = state.sessions[session] ?? emptySession();
    state.sessions[session] = current;
    const seat = current.seats[name] ?? { stage: 'launched' as const };
    seat.waiting = waiting;
    seat.pane = pane;
    if (workspace) seat.workspace = workspace;
    current.seats[name] = seat;
  });
}

/**
 * The recovery report: a key the host did not take, and a sent key whose seat did not come
 * ready — idle prompt or rules — all leave the same `trust-sent-recovery` state, so all
 * answer with the same row and exit.
 */
function recovery(io: Io, json: boolean, human: string): number {
  if (json) writeJsonError(io, 'answer.recovery', human, null);
  else io.stderr(`${human}\n`);
  // exit: answer.recovery
  return 1;
}

/** The human text an error document carries: the contract's `message` has no `team <command>: `
 *  prefix, so one a caller-written sentence carries in its plain form is dropped here. */
function errorText(message: string): string {
  const prefix = 'team answer: ';
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

function refuse(
  io: Io,
  json: boolean,
  dir: string | undefined,
  who: string,
  seat: string,
  host: AnswerHost,
  reason: Refusal,
): number {
  // No directory means this folder had no team file to log beside. Writing the line would create
  // `.agents` and `team.log` wherever the command was run.
  if (dir !== undefined) logLine(dir, 'answer', who, `${seat}: refused trust: ${reason.class}`, host.now());
  if (json) writeJsonError(io, reason.id, errorText(reason.message), reason.repair ?? null);
  else io.stderr(`${reason.message}\n`);
  // exit: answer.caller
  // exit: answer.no-pane
  // exit: answer.another-pane
  // exit: answer.policy
  // exit: answer.session-owner
  // exit: answer.state
  // exit: answer.unverified
  // exit: answer.ambiguous
  // exit: answer.version
  // exit: answer.screen
  // exit: answer.label
  // exit: answer.folder
  // exit: answer.action
  // exit: answer.process
  // exit: answer.human
  return 1;
}

async function finish(
  io: Io,
  json: boolean,
  host: AnswerHost,
  dir: string,
  session: string,
  who: string,
  name: string,
  team: TeamFile,
  configured: Seat | undefined,
  pane: string,
  workspace: string | undefined,
  root: string,
  standing: Standing,
  launched?: LaunchedIdentity,
  folder?: string,
): Promise<number> {
  const seatState = readState(dir).sessions[session]?.seats[name];
  const like = seatState?.temporary?.like;
  const seat = configured ?? team.seats.find((item) => item.name === like);
  const profile = seat ? profileFor(seat.cli) : null;
  const launchIdentity = launched ?? seatState?.launched;
  const ready = profile ? await recover(host, session, pane, name, profile, seat as Seat, team, root, standing, launchIdentity) : 'idle';
  if (typeof ready === 'object' && 'class' in ready) {
    return refuse(io, json, dir, who, name, host, ready);
  }
  if (ready !== true) {
    logLine(dir, 'answer', who, `${name}: refused trust: ${ready}`, host.now());
    return recovery(io, json, `${name}: trust sent; recovery required`);
  }
  updateState(dir, (state) => {
    const current = state.sessions[session] ?? emptySession();
    state.sessions[session] = current;
    const recorded = current.seats[name] ?? { stage: 'launched' as const };
    delete recorded.waiting;
    recorded.stage = 'ready';
    recorded.pane = pane;
    if (workspace) recorded.workspace = workspace;
    const mode = profile?.rulesMode;
    if (mode === 'message' || mode === 'prepend') recorded.rules = mode;
    current.seats[name] = recorded;
  });
  logLine(dir, 'answer', who, `${name}: trust answered`, host.now());
  const summary = folder === undefined ? `${name}: answered trust` : `${name}: answered trust (${folder})`;
  if (json) {
    writeJson(io, 'team.answer', {
      format: 1 as const,
      dry_run: false,
      status: 'answered',
      action_summary: summary,
      project: team.project,
      session,
      seat: name,
      pane,
      dialog: 'trust',
      state: 'ready',
      ...(folder !== undefined ? { folder } : {}),
    });
  } else {
    io.stdout(`${contextLine(team.project, session)}\n${summary}\n`);
  }
  // exit: answer.ready
  return 0;
}

async function recover(
  host: AnswerHost,
  session: string,
  pane: string,
  name: string,
  profile: Profile,
  seat: Seat,
  team: TeamFile,
  root: string,
  standing: Standing,
  launched?: LaunchedIdentity,
): Promise<true | Refusal | 'idle' | 'rule delivery'> {
  if (!(await waitIdle(host, session, pane, profile))) return 'idle';
  const named = host.agents(session)?.some((agent) => agent.name === name && agent.pane === pane) === true;
  if (!named && !host.rename(session, pane, name)) return 'rule delivery';
  if (profile.rulesMode !== 'message') return true;
  // The rules are delivered exactly as `up` delivers them: written to the seat's per-seat
  // file first — from the live file, as `up`'s are — then the one line that points at it,
  // the only shape of rules a read-back can prove; this command shares that delivery.
  const delivery = rulesDeliveryOf(standing, team, seat, root, host.home);
  if ('refusal' in delivery) return 'rule delivery';
  if (!writeRulesFile(standing, seat.name, root, host.home, delivery.text, rulesFileHash(delivery.text), undefined, team.project).ok) return 'rule delivery';
  let processRefusal: Refusal | null = null;
  const delivered = await deliverRules(
    profile.cli,
    delivery.line,
    profile.idleTimeout,
    deliveryOf(host, session, pane, () => rulesFileHolds(delivery.path, rulesFileHash(delivery.text)), (action) => {
      const problem = checkProcess(name, host, session, pane, launched);
      if (!problem) return true;
      processRefusal = action === 'enter'
        ? { id: problem.id, class: problem.class, message: `${problem.message}; rules were typed, not sent` }
        : problem;
      return false;
    }),
  );
  if (processRefusal) return processRefusal;
  return delivered === true ? true : 'rule delivery';
}

async function waitIdle(host: AnswerHost, session: string, pane: string, profile: Profile): Promise<boolean> {
  const deadline = host.now().getTime() + profile.idleTimeout * 1000;
  for (;;) {
    if (readScreen(profile.cli, host.pane(session, pane)).kind === 'idle') return true;
    if (host.now().getTime() >= deadline) return false;
    const before = host.now().getTime();
    await host.sleep(200);
    if (host.now().getTime() <= before) return false;
  }
}

function deliveryOf(
  host: AnswerHost,
  session: string,
  pane: string,
  file: () => boolean,
  beforeInput?: (action: 'type' | 'enter') => boolean,
): Delivery {
  return {
    screen: () => host.pane(session, pane),
    status: () => host.status(session, pane),
    type: (text) => host.type(session, pane, text),
    enter: () => host.enter(session, pane),
    key: (name) => host.sendKey(session, pane, name),
    // The last look before Enter, the same no-follow read `up`'s delivery makes.
    file,
    foreground: () => host.foreground(session, pane),
    now: () => host.now().getTime(),
    sleep: (ms) => host.sleep(ms),
    beforeInput,
  };
}

function usage(io: Io, json: boolean, message: string): number {
  if (json) writeJsonError(io, 'answer.usage', message, null);
  else io.stderr(`team answer: ${message}\n${USAGE}`);
  // exit: answer.usage
  return 2;
}

function configuration(io: Io, json: boolean, message: string): number {
  if (json) writeJsonError(io, 'answer.configuration', message, null);
  else io.stderr(`team answer: ${message}\n`);
  // exit: answer.configuration
  return 2;
}
