import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { approvalDifferencesOf, notInForce } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { anotherPaneRefusal, callerOf, callerVerdict, describeCaller, fileOwnerRefusal, isOwner, judgeCallerIn, noPaneRefusal, sessionOwnerRefusal, standingOf, walkCaller, type Caller, type SeatStanding } from '../caller.ts';
import { trustPolicy } from '../file/dialogs.ts';
import { canonicalLanding, folderOf, listFolder } from '../file/landing.ts';
import { loadTeamFile } from '../file/load.ts';
import { launchedTeamFile } from '../file/launched-file.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import { agentList, agentRename, agentStatus, paneForeground, paneForegroundCwd, paneProcesses, paneRead, pressEnter, sendKey as herdrSendKey, typeText, type PaneProcesses } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { deliverRules, type Delivery } from '../launch/deliver.ts';
import { seatProcessVerdict, type LaunchedIdentity } from '../launch/identity.ts';
import { rulesDeliveryOf, rulesFileHash, rulesFileHolds, writeRulesFile } from '../launch/rules-file.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { resolveLobby } from '../lobby/gate.ts';
import { logLine } from '../log.ts';
import { profileFor } from '../profiles/index.ts';
import { type Profile } from '../profiles/profile.ts';
import { extractFolder, isEligible, keyOf, labelMatches, versionMatches, type TrustRecord } from '../profiles/trust-answer.ts';
import { emptySession, readState, updateState, type SeatState } from '../state.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { readScreen } from '../watch/screen.ts';

export const USAGE = 'Usage: team answer <seat> trust [--session <name>] [--file <path>] [--json]\n';

const OUTSIDE = 'ask the owner to approve this exact folder and answer through team up';

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

type Reason = 'caller' | 'policy' | 'state' | 'screen' | 'version' | 'label' | 'folder' | 'action' | 'process' | 'idle' | 'rule delivery';

type Refusal = { class: Reason; message: string };

type Seen = { record: TrustRecord; version: string; folder: string };

const answer: Command = (argv, io) => runAnswer(argv, io, realHost);
export default answer;

export async function runAnswer(argv: string[], io: Io, host: AnswerHost): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['json']);
  const json = args.flags.has('json');
  const seatName = args.rest[0];
  const dialog = args.rest[1];
  if (args.error || args.rest.length !== 2 || !seatName || dialog !== 'trust') {
    const message = args.error ?? (dialog && dialog !== 'trust' ? `unknown dialog "${dialog}"` : 'a seat and trust are required');
    return usage(io, json, message);
  }

  // The `--file` check is the walk's, and it runs before that file is read: a non-owner aiming
  // `--file` must not make this command read and validate another project's team file, nor leave
  // a refusal log beside it. `fileOwnerRefusal` (caller.ts) is the one place every command
  // whose `--file` is the owner's decides it; the walk reads no session, no state and no log.
  const fileRefusal = fileOwnerRefusal(io, args.values.file);
  if (fileRefusal !== undefined) {
    io.stderr(`team answer: ${fileRefusal}\n`);
    // exit: answer.file-owner
    return 1;
  }
  // The owner is a terminal outside herdr, and the walk alone decides that: a non-owner aiming
  // `--session` is refused here, before `launchedTeamFile` or any other call that reaches herdr,
  // and before the flag's session is read — no agent list, no pane root, no state write; the
  // refusal's own log line is the only line written. (A seat cannot be named in this refusal:
  // placing it would read a session, and that is what must not happen yet.) The log sits beside
  // this cwd's own file, never a file the flag or a pane pointer would open.
  if (args.values.session !== undefined) {
    const walked = walkCaller(io);
    if (!isOwner(walked)) {
      const local = loadTeamFile(io.cwd, { home: host.home });
      return refuse(
        io,
        json,
        local.ok ? dirname(local.path) : join(io.cwd, '.agents'),
        logWho(walked, local.ok ? local.team : undefined),
        seatName,
        host,
        {
          class: 'caller',
          message: `team answer: ${sessionOwnerRefusal(walked)}`,
        },
      );
    }
  }
  const launched = args.values.file ? undefined : launchedTeamFile(io, host.home);
  const loaded = loadTeamFile(io.cwd, { ...(args.values.file ?? launched ? { file: args.values.file ?? launched } : {}), home: host.home });
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
  const who = logWho(caller, team);

  const refused = (reason: Refusal): number => refuse(io, json, dir, who, seatName, host, reason);

  const callerProblem = callerProblemOf(caller, team, seatName, standingOf(dir, session, caller));
  if (callerProblem) return refused(callerProblem);
  const standing = host.standing(root);
  if (standing.kind !== 'verified') return refused({ class: 'caller', message: notInForce(standing) });
  const drift = approvalDifferencesOf(standing, team);
  if (drift.length) return refused({ class: 'caller', message: `the file is not the approved one (${drift.join('; ')})` });
  // The trust entries the folder check reads come from the approved copy itself,
  // never from the live file: the drift check above normally makes the two equal,
  // but the check must not depend on that to be right about what was approved.
  const approved = validateTeamFile(standing.record.file);
  if (!approved.ok) return refused({ class: 'caller', message: 'the approved copy of the team file cannot be read' });
  if (trustPolicy(team) !== 'coordinator') return refused({ class: 'policy', message: `${seatName}: use team up and [o]` });

  const lock = acquireSeatLock(dir, session, seatName);
  if (!('release' in lock)) return refused({ class: 'state', message: `${seatName}: another command holds it` });
  try {
    const state = readState(dir).sessions[session] ?? emptySession();
    const recorded = state.seats[seatName];
    // The seat is the approved copy's, and the pane is herdr's one agent of that name.
    // A recorded pane selects nothing: the state can name another pane, and a name the
    // copy does not carry is left for the owner.
    const configured = approved.team.seats.find((seat) => seat.name === seatName);
    if (!configured) {
      if (!recorded) return refused({ class: 'state', message: `${seatName}: it is not a live seat` });
      return refused({
        class: 'state',
        message: `${seatName}: its record is not an approved seat; left as it is (the owner cleans it: team remove ${seatName} --abandon)`,
      });
    }
    const agents = host.agents(session);
    const named = agents?.filter((item) => item.name === seatName) ?? [];
    const agent = named.length === 1 ? named[0] : undefined;
    if (!agent) {
      if (named.length > 1) {
        return refused({ class: 'state', message: `${seatName}: herdr lists more than one agent of this name; left as it is` });
      }
      return refused({ class: 'state', message: `${seatName}: it is not a live seat` });
    }
    const pane = agent.pane;
    const workspace = agent.workspace;
    const waiting = recorded?.waiting;
    if (waiting?.manual === true) return refused({ class: 'state', message: `${seatName}: the owner has the pane open` });
    if (waiting?.state === 'trust-sent-recovery') {
      return await finish(io, json, host, dir, session, who, seatName, team, configured, pane, workspace, root, standing, recorded?.launched);
    }
    if (waiting?.state !== 'waiting-owner' || waiting.classification !== 'trust') {
      return refused({ class: 'state', message: `${seatName}: it is not waiting at a trust dialog` });
    }

    const cli = configured.cli;
    const profile = profileFor(cli);
    // The lobby the approved file resolves to: its own when the file sets `entity` or `lobby`, else
    // the machine-global one. The folder shown in the dialog must be this lobby, as team writes it.
    const answerLobby = resolveLobby(host.home, approved.team);
    const checked = inspect(seatName, host, session, pane, profile, approved.team.trust, answerLobby, root, recorded?.launched);
    if ('class' in checked) return refused(checked);
    const again = inspect(seatName, host, session, pane, profile, approved.team.trust, answerLobby, root, recorded?.launched);
    if ('class' in again) return refused(again);
    if (again.folder !== checked.folder) return refused({ class: 'folder', message: `${seatName}: ${OUTSIDE}` });
    if (again.record.from !== checked.record.from || again.record.to !== checked.record.to || again.record.action !== checked.record.action) {
      return refused({ class: 'version', message: `${seatName}: this version has no trust answer` });
    }
    const key = keyOf(checked.record.action);
    if (!key) {
      return refused({ class: 'action', message: `${seatName}: the recorded key is not one this version sends` });
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
      return refused({ class: 'state', message: `${seatName}: its recovery state could not be recorded` });
    }
    const keyProcessProblem = checkProcess(seatName, host, session, pane, recorded?.launched);
    if (keyProcessProblem) {
      // Nothing was sent, so this clean refusal puts the record back exactly as it was: the
      // seat is waiting for its owner again, and a later answer can still answer it. The
      // write above exists only for the crash case — that window stays write-before-key. A
      // rollback that does not take leaves the recovery, the direction that only observes.
      if (!restoreWaiting(dir, session, seatName, waiting, pane, workspace)) {
        return refused({ class: 'state', message: `${keyProcessProblem.message} (it is still recorded as a recovery)` });
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
      return recovery(io, json, seatName, 'its key could not be sent', `${seatName}: the key could not be sent; recovery required`);
    }
    return await finish(io, json, host, dir, session, who, seatName, team, configured, pane, workspace, root, standing, recorded?.launched);
  } finally {
    lock.release();
  }
}

/** The caller class the caller check returned, as the log's bracket. With no team file yet, a seat
 *  stays a seat: telling an orchestrator from any other seat would read that file. */
function logWho(caller: Caller, team?: TeamFile): string {
  // `owner-no-tty` is refused before anything logs (it is not on a terminal), but the bracket
  // it would carry is the owner's, as everywhere else.
  if (caller.kind === 'owner' || caller.kind === 'owner-no-tty') return 'owner';
  if (caller.kind === 'unplaced') return 'unplaced';
  if (caller.kind === 'pane') return caller.session === undefined ? caller.pane : `${caller.session}/${caller.pane}`;
  return team !== undefined && caller.name === team.orchestrator ? 'orchestrator' : 'seat';
}

function callerProblemOf(caller: Caller, team: TeamFile, seat: string, at?: SeatStanding): Refusal | null {
  if (caller.kind === 'owner') return null;
  // The orchestrator's seat, in the session judged and on its recorded pane; a seat of another
  // session, or one merely renamed, falls through to the refusal below, unchanged.
  const verdict = callerVerdict(caller, team.orchestrator, at);
  if (verdict.kind === 'ok') return null;
  if (verdict.kind === 'no-pane') return { class: 'caller', message: `team answer: ${noPaneRefusal(verdict.name)}` };
  if (verdict.kind === 'another-pane') {
    return { class: 'caller', message: `team answer: ${anotherPaneRefusal(verdict.name, verdict.recordedPane)}` };
  }
  if (caller.kind === 'unplaced') return { class: 'caller', message: caller.reason };
  if (caller.kind === 'pane') return { class: 'caller', message: describeCaller(caller) };
  return { class: 'caller', message: `${seat}: only the owner, or the orchestrator from its own seat, can answer` };
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
  if (verdict === 'unknown') return { class: 'process', message: `${seat}: its pane could not be read` };
  if (verdict !== 'same') return { class: 'process', message: `${seat}: the process in its pane is not the one team launched` };
  return null;
}

/**
 * One fresh reading of the pane: the record this version answers, or the class that
 * refused. `trust` is the approved copy's own `trust:` list, never the live file's —
 * the folder must be an entry of what the owner approved.
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
  const say = (reason: Reason, text: string): Refusal => ({ class: reason, message: `${seat}: ${text}` });
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
 * The recovery report. Two paths reach it — a key the host did not take, and a sent key
 * whose seat did not come ready — and both leave the same `trust-sent-recovery` state,
 * so both answer with the same object shape and exit.
 */
function recovery(io: Io, json: boolean, seat: string, reason: string, human: string): number {
  if (json) io.stdout(`${JSON.stringify({ seat, dialog: 'trust', status: 'recovery', state: 'trust-sent-recovery', reason })}\n`);
  else io.stderr(`${human}\n`);
  // exit: answer.recovery
  return 1;
}

function refuse(
  io: Io,
  json: boolean,
  dir: string,
  who: string,
  seat: string,
  host: AnswerHost,
  reason: Refusal,
): number {
  logLine(dir, 'answer', who, `${seat}: refused trust: ${reason.class}`, host.now());
  if (json) io.stdout(`${JSON.stringify({ seat, dialog: 'trust', status: 'refused', reason: reason.message })}\n`);
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
    const reason = ready === 'idle' ? 'its idle prompt did not come' : 'its rules were not delivered';
    return recovery(io, json, name, reason, `${name}: trust sent; recovery required`);
  }
  updateState(dir, (state) => {
    const current = state.sessions[session] ?? emptySession();
    state.sessions[session] = current;
    const recorded = current.seats[name] ?? { stage: 'launched' as const };
    delete recorded.waiting;
    recorded.stage = 'ready';
    recorded.pane = pane;
    if (workspace) recorded.workspace = workspace;
    if (profile?.rulesOption === null) recorded.rules = 'message';
    current.seats[name] = recorded;
  });
  logLine(dir, 'answer', who, `${name}: trust answered`, host.now());
  if (json) io.stdout(`${JSON.stringify({ seat: name, dialog: 'trust', status: 'answered', state: 'ready' })}\n`);
  else io.stdout(`${name}: trust answered; ready\n`);
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
  if (profile.rulesOption !== null) return true;
  // The rules are delivered exactly as `up` delivers them: written to the seat's per-seat
  // file first — from the approved copy of the team file, as `up`'s are — then the one line
  // that points at it, the only shape of rules a read-back can prove; this command shares
  // that delivery.
  const delivery = rulesDeliveryOf(standing, team, seat, root, host.home);
  if ('refusal' in delivery) return 'rule delivery';
  if (!writeRulesFile(standing, seat.name, root, host.home, delivery.text, rulesFileHash(delivery.text)).ok) return 'rule delivery';
  let processRefusal: Refusal | null = null;
  const delivered = await deliverRules(
    profile.cli,
    delivery.line,
    profile.idleTimeout,
    deliveryOf(host, session, pane, () => rulesFileHolds(delivery.path, rulesFileHash(delivery.text)), (action) => {
      const problem = checkProcess(name, host, session, pane, launched);
      if (!problem) return true;
      processRefusal = action === 'enter'
        ? { class: problem.class, message: `${problem.message}; rules were typed, not sent` }
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
    // The last look before Enter, the same no-follow read `up`'s delivery makes.
    file,
    foreground: () => host.foreground(session, pane),
    now: () => host.now().getTime(),
    sleep: (ms) => host.sleep(ms),
    beforeInput,
  };
}

function usage(io: Io, json: boolean, message: string): number {
  if (json) io.stdout(`${JSON.stringify({ error: { code: 'usage', message } })}\n`);
  else io.stderr(`team answer: ${message}\n${USAGE}`);
  // exit: answer.usage
  return 2;
}

function configuration(io: Io, json: boolean, message: string): number {
  if (json) io.stdout(`${JSON.stringify({ error: { code: 'configuration', message } })}\n`);
  else io.stderr(`team answer: ${message}\n`);
  // exit: answer.configuration
  return 2;
}
