import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import { dialogsTrustInForce } from '../permissions/dialogs-trust.ts';
import { readArgs } from '../args.ts';
import { anotherPaneRefusal, callerOf, callerVerdict, describeCaller, detachedRefusal, fileOwnerRefusal, isOwner, judgeCallerIn, logTag, noPaneRefusal, sessionOwnerRefusal, standingOf, walkCaller, type Caller, type SeatStanding } from '../caller.ts';
import { canonicalLanding, folderOf, listFolder } from '../file/landing.ts';
import { canonicalTeam, readTeamConfig } from '../file/team-config.ts';
import { launchedTeamFile } from '../file/launched-file.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { agentList, agentRename, agentStatus, paneForeground, paneForegroundCwd, paneProcesses, paneRead, pressEnter, sendKey as herdrSendKey, typeText, type PaneProcesses } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { deliverRules, type Delivery } from '../launch/deliver.ts';
import { seatProcessVerdict, type LaunchedIdentity } from '../launch/identity.ts';
import { rulesOriginOf, type RulesOrigin } from '../launch/rules.ts';
import { rulesDeliveryOf, rulesFileHash, rulesFileHolds, writeRulesFile } from '../launch/rules-file.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { lobbyOf } from '../lobby/recorded.ts';
import { logLine } from '../log.ts';
import { contextLine, hasJsonFlag, writeJson, writeJsonError } from '../output/index.ts';
import { profileFor } from '../profiles/index.ts';
import { type Profile } from '../profiles/profile.ts';
import { ANSWER_KEYS, questionAnswerFor, type QuestionAnswerRecord } from '../profiles/question-answer.ts';
import { extractFolder, isEligible, keyOf, labelMatches, versionMatches, type TrustRecord } from '../profiles/trust-answer.ts';
import { emptySession, readState, updateState, type SeatState } from '../state.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { isDialogKind, readDialog, type DialogKind, type DialogReading } from '../watch/dialog.ts';
import { readScreen } from '../watch/screen.ts';
import { realHost as realSendHost, runSend, type SendHost } from './send.ts';

export const USAGE = `Usage: team answer <seat> trust [--session <name>] [--file <path>] [--json]
       team answer <seat> question [--session <name>] [--file <path>] [--json]

Presses the one recorded key of a dialog, and only that key. trust answers a folder-trust
dialog, and the folder must be the lobby on three readings at once: the path the screen
shows, the folder the pane itself reports working in, and the lobby's parent directory.
question dismisses a question, plan approval or confirmation dialog with that CLI's recorded
let-me-type-or-cancel key, then sends the seat one line through the ordinary send path and
never a keystroke at a choice: decide within your rules or ask your orchestrator with team
send. A permission, login or trust-to-run-a-command prompt is never answered. Every check
has to pass on two fresh reads of the pane, and the question word's two reads must agree on
the dialog and on its text. <seat> names one seat of the team file. No option takes a key,
a text, or another dialog. The pane is the terminal host's one agent of that name; a pane
recorded in the state selects nothing. A name the file does not carry is left as it is, and
two agents of the name send nothing. --session is the owner's alone, and so is --file: each
is refused before the flagged session or file is read. The answer opens on the team's
context line and closes on <seat>: answered trust (<folder>) or <seat>: answered question
(<dialog>). A refused or incomplete answer names its reason on stderr, and a recovery stays
recorded for the next answer to observe. --json prints one document instead of the lines:
{format, dry_run, status, action_summary, project, session, seat, pane, dialog,
dialog_kind?, state, folder?}. A run that exits 1 or 2 writes the structured error document
instead — {error: {id, message, repair}} — and stderr stays empty.

Exits 0 when the dialog is answered and the seat is ready, 1 when the answer is refused or
does not complete, 2 when the invocation or team file can't be read.
`;

const OUTSIDE = 'ask the owner to add this exact folder to trust and answer through team up';

/** The line a question answer puts into the seat's own conversation, word for word: the seat
 *  decides within its rules, or asks its orchestrator over the bus. Nothing is typed at a
 *  choice, and no dialog option is ever selected. */
const QUESTION_LINE = 'decide within your rules or ask your orchestrator with team send';

/** The keys a question answer may press: the CLI's recorded let-me-type-or-cancel key, and only
 *  the names of this closed set. None of them selects a choice. The set is the one
 *  src/profiles/question-answer.ts parses; a record outside it refuses `answer.action`. */
const QUESTION_KEYS: ReadonlySet<string> = new Set(ANSWER_KEYS);

/** Whether a dialog kind — a stored classification, or a recovery record's keepsake — is one the
 *  question word answers: `classificationOf` records a screen kind as itself. */
function answerableClassification(value: string | undefined): value is DialogKind {
  return value !== undefined && isDialogKind(value);
}

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
  /** The send command's own host: the decision line reaches the seat's conversation through the
   *  ordinary send path, never through a keystroke. Absent, the real one. */
  sendHost?: SendHost;
  /** A seat's CLI profile; absent, the shipped profile data. A scene stands in the records a
   *  release's shipped data does not carry yet. */
  profile?(cli: string): Profile | null;
  /** One fresh reading of a pane for the question word: the screen's kind word, and the dialog
   *  reading when the screen is one of the answerable three. Absent, the shipped screen data
   *  reads it. */
  reading?(cli: string, screen: string | undefined): PaneReading;
};

/** One fresh reading of a pane for the question word: the screen's kind word — the vocabulary of
 *  `readScreen`, plus any word a host reports — and the dialog reading (its kind and its text,
 *  or none). */
export type PaneReading = { kind: string; dialog: DialogReading };

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
  sendHost: realSendHost,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  home: homedir(),
  standing: (root) => approvalStanding(root, homedir()),
};

type Reason = 'caller' | 'policy' | 'state' | 'screen' | 'version' | 'label' | 'folder' | 'action' | 'process' | 'identity' | 'idle' | 'rule delivery' | 'human' | 'permission' | 'login' | 'not-a-question' | 'incomplete' | 'disagree';

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

/** One reading of a pane for the question word: the record this version answers, the printed
 *  version it was chosen from, and the dialog the two reads agreed on. */
type SeenQuestion = { record: QuestionAnswerRecord; version: string; kind: DialogKind; text: string };

const answer: Command = (argv, io) => runAnswer(argv, io, realHost);
export default answer;

export async function runAnswer(argv: string[], io: Io, host: AnswerHost): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['json']);
  // Raw argv, before the parser: `--nope --json` and `--json=1` must still answer with the
  // structured error document, and the parser errors before its flag set sees them.
  const json = hasJsonFlag(argv);
  const seatName = args.rest[0];
  const dialog = args.rest[1];
  if (args.error || args.rest.length !== 2 || !seatName || (dialog !== 'trust' && dialog !== 'question')) {
    const message = args.error ?? (dialog && dialog !== 'trust' && dialog !== 'question' ? `unknown dialog "${dialog}"` : 'a seat and trust or question are required');
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
        dialog,
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

  const refused = (reason: Refusal): number => refuse(io, json, dir, who, seatName, host, reason, dialog);

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
    // A waiting record names the pane it waits at, and a new seat pauses at its dialog before
    // the rename step names it: the unnamed agent on that recorded pane is the seat. The check
    // below decides whether the dialog is the one this word answers; the record is only the hint
    // that places the agent, and the process identity is checked before any key is sent.
    const onRecorded =
      named.length === 0 &&
      recorded?.waiting !== undefined &&
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
    // Nothing has been sent yet: a clean refusal puts the record back exactly as it was, and a
    // rollback that does not take leaves the recovery, the direction that only observes. Both
    // words refuse from this point the same way.
    const refusedAtKey = (problem: Refusal, back: NonNullable<SeatState['waiting']>): Refusal =>
      restoreWaiting(dir, session, seatName, back, pane, workspace)
        ? problem
        : { id: problem.id, class: 'state', message: `${problem.message} (it is still recorded as a recovery)` };

    if (dialog === 'question') {
      // A recovery is the other word's to complete: only the command that pressed the key
      // finishes it, and this word presses none.
      if (waiting?.state === 'trust-sent-recovery') {
        return refused(refusedClass('state', `${seatName}: a trust answer was sent; complete it with team answer ${seatName} trust`));
      }
      // The decision line is put into the seat's own conversation with the ordinary send path,
      // and that path loads its team from the folder this run was started in. Before a key is
      // pressed, that team must be this one and the seat must be judged in the file's own
      // session: otherwise the line would reach another team's — or another session's — seat
      // of this name, after this pane's dialog had already been dismissed.
      const sendPath = sendPathProblem(io, host, root, session, team);
      if (sendPath !== null) return configuration(io, json, sendPath);
      if (waiting?.state === 'question-sent-recovery') {
        // The dialog is dismissed and the decision line may still be owed: deliver it, and
        // never a second key. A delivery an earlier run completed is kept — the record says
        // so — and only the readiness is finished, so the line is never put in twice. The
        // kind the recovery kept names the dialog in the summary.
        if (!answerableClassification(waiting.dialog)) {
          return refused(refusedClass('state', `${seatName}: its recovery does not name a dialog this version answers`));
        }
        if (waiting.delivered !== true) {
          if (!(await deliverQuestion(io, host, seatName))) {
            logLine(dir, 'answer', who, `${seatName}: question sent; delivery required`, host.now());
            return deliveryFailure(io, json, `${seatName}: the decision line could not be delivered; recovery required`);
          }
          if (!markDelivered(dir, session, seatName, pane, workspace)) {
            logLine(dir, 'answer', who, `${seatName}: question sent; delivery unrecorded`, host.now());
            return recovery(io, json, `${seatName}: the decision line was delivered, but its record could not be marked; recovery required`);
          }
        }
        return await finish(io, json, host, dir, session, who, seatName, team, configured, pane, workspace, root, standing, recorded?.launched, { word: 'question', dialog: waiting.dialog }, rulesOriginOf(loaded.source));
      }
      // The waiting state is the gate; the screen is what names the dialog. A record at a
      // permission, login or trust screen reaches the reading below and is refused there with
      // its own row — never by a generic state sentence, and never answered.
      if (waiting?.state !== 'waiting-owner') {
        return refused(refusedClass('state', `${seatName}: it is not waiting at a question, plan approval or confirmation dialog`));
      }
      const cli = configured.cli;
      const profile = host.profile ? host.profile(cli) : profileFor(cli);
      const checked = inspectQuestion(seatName, host, session, pane, profile, recorded?.launched);
      if ('class' in checked) return refused(checked);
      const again = inspectQuestion(seatName, host, session, pane, profile, recorded?.launched);
      if ('class' in again) return refused(again);
      // Two fresh reads, not one: a pane that changed between them is refused, never answered.
      if (!sameQuestion(checked, again)) {
        return refused(refusedClass('disagree', `${seatName}: the two fresh reads of the pane do not agree on the dialog`));
      }
      // The key is the CLI's recorded let-me-type-or-cancel key, and the closed set holds no
      // choice: a record outside it is refused, never sent.
      if (!QUESTION_KEYS.has(checked.record.key)) {
        return refused(refusedClass('action', `${seatName}: the recorded key is not one this version sends`));
      }
      // The recovery intent is on disk before the key, exactly as the trust word writes it: a
      // crash between the two leaves a recovery that may never have sent (a retry only
      // observes), never a waiting-owner whose retry presses a second time.
      if (!recordRecovery(dir, session, seatName, {
        state: 'question-sent-recovery',
        classification: checked.kind,
        dialog: checked.kind,
        sentAt: host.now().toISOString(),
        version: checked.version,
      }, pane, workspace)) {
        return refused(refusedClass('state', `${seatName}: its recovery state could not be recorded`));
      }
      // The last reading is the one immediately before the key, and it reads the whole pane
      // again: the dialog's kind included, so a same-process switch to a permission, login or
      // other prompt after the earlier reads refuses here, and a dialog that no longer reads the
      // same is refused rather than keyed.
      const last = inspectQuestion(seatName, host, session, pane, profile, recorded?.launched);
      if ('class' in last) return refused(refusedAtKey(last, waiting));
      if (!sameQuestion(checked, last)) {
        return refused(refusedAtKey(refusedClass('disagree', `${seatName}: the last reading of the pane no longer names the dialog`), waiting));
      }
      let sent = false;
      try {
        sent = host.sendKey(session, pane, last.record.key);
      } catch {
        sent = false;
      }
      if (!sent) {
        logLine(dir, 'answer', who, `${seatName}: refused question: action`, host.now());
        return recovery(io, json, `${seatName}: the key could not be sent; recovery required`);
      }
      // The dialog is gone. The one decision line goes into the seat's own conversation
      // through the ordinary send path — its own admission, its own delivery order — and never
      // as a keystroke at a choice.
      if (!(await deliverQuestion(io, host, seatName))) {
        logLine(dir, 'answer', who, `${seatName}: question answered; delivery required`, host.now());
        return deliveryFailure(io, json, `${seatName}: the dialog was dismissed, but the decision line could not be delivered; recovery required`);
      }
      // The line is out, and the record says so before readiness is waited on: a retry after
      // a readiness-only failure finishes the recovery and never sends the line again.
      if (!markDelivered(dir, session, seatName, pane, workspace)) {
        logLine(dir, 'answer', who, `${seatName}: question answered; delivery unrecorded`, host.now());
        return recovery(io, json, `${seatName}: the decision line was delivered, but its record could not be marked; recovery required`);
      }
      return await finish(io, json, host, dir, session, who, seatName, team, configured, pane, workspace, root, standing, recorded?.launched, { word: 'question', dialog: checked.kind }, rulesOriginOf(loaded.source));
    }

    if (waiting?.state === 'question-sent-recovery') {
      return refused(refusedClass('state', `${seatName}: a question was sent; complete it with team answer ${seatName} question`));
    }
    if (waiting?.state === 'trust-sent-recovery') {
      return await finish(io, json, host, dir, session, who, seatName, team, configured, pane, workspace, root, standing, recorded?.launched, { word: 'trust', ...(waiting.folder === undefined ? {} : { folder: waiting.folder }) }, rulesOriginOf(loaded.source));
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
    // The last reading is the one immediately before the key, and it reads the whole pane again:
    // the process and the screen included, so a process replacement or a switch to a permission,
    // login or other prompt after the earlier reads refuses here, and a dialog that no longer
    // reads the same is refused rather than keyed. The clean refusal puts the record back: the
    // seat is waiting for its owner again, and a later answer can still answer it. The write
    // above exists only for the crash case — that window stays write-before-key.
    const last = inspect(seatName, host, session, pane, profile, team.trust, answerLobby, root, recorded?.launched);
    if ('class' in last) return refused(refusedAtKey(last, waiting));
    if (
      last.folder !== checked.folder ||
      last.record.from !== checked.record.from ||
      last.record.to !== checked.record.to ||
      last.record.action !== checked.record.action
    ) {
      return refused(refusedAtKey(refusedClass('disagree', `${seatName}: the last reading of the pane no longer names the trust dialog`), waiting));
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
    return await finish(io, json, host, dir, session, who, seatName, team, configured, pane, workspace, root, standing, recorded?.launched, { word: 'trust', folder: checked.folder }, rulesOriginOf(loaded.source));
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

/**
 * Why the one decision line could not reach this seat through the ordinary send path, or null.
 * `runSend` loads its team from the folder this run was started in and addresses a declared
 * seat in the team file's own session; this answer may have read another file (`--file`, or the
 * file a pane was launched from). Answering one pane and then writing into another team's — or
 * another session's — seat of the same name is the one thing this word must never do, so the
 * two readings are compared before any key is pressed.
 */
function sendPathProblem(io: Io, host: AnswerHost, root: string, session: string, team: TeamFile): string | null {
  const here = readTeamConfig(io.cwd, { home: host.home });
  if (!here.ok) return `the decision line is sent from ${io.cwd}, which holds no readable team file`;
  const mine = canonicalLanding(root);
  const theirs = canonicalLanding(here.root);
  if (mine === null || theirs === null || mine !== theirs) {
    return `the decision line is sent with the team file of ${io.cwd}, which is not this seat's team`;
  }
  // The same root can hold more than one team file: `--file` may name another session's file
  // beside the folder's default. The send path reads the default, so the two teams are compared
  // whole — roster, session and all — before a key is pressed.
  let sameTeam: boolean;
  try {
    sameTeam = canonicalTeam(team) === canonicalTeam(here.team);
  } catch {
    sameTeam = false;
  }
  if (!sameTeam) {
    return here.team.session === team.session
      ? `the decision line is sent with the team file of ${io.cwd}, which is not the team this answer read`
      : `the decision line is sent in session ${here.team.session}, and this answer read session ${team.session}`;
  }
  if (session !== team.session) {
    return `the decision line is sent in the team's own session (${team.session}), and this run answered in ${session}`;
  }
  return null;
}

/**
 * Puts the one decision line into the seat's own conversation through the ordinary send path:
 * the send command's own admission, its own delivery order and its own record — and never a
 * keystroke this command types at a dialog. The send's exit code is the whole answer: 0 when
 * it delivered the line or recorded it for the seat, anything else when it refused.
 */
async function deliverQuestion(io: Io, host: AnswerHost, seat: string): Promise<boolean> {
  try {
    return await runSend([seat, QUESTION_LINE], quietIo(io), host.sendHost ?? realSendHost) === 0;
  } catch {
    return false;
  }
}

/**
 * Writes the delivered marker onto the recovery record and reads it back: the line the send
 * path has taken is never sent again by a later run, even when readiness was the only thing
 * the first run failed. False when the record cannot be marked; the caller then reports the
 * delivery as unrecorded rather than claiming a clean finish.
 */
function markDelivered(
  dir: string,
  session: string,
  name: string,
  pane: string,
  workspace: string | undefined,
): boolean {
  try {
    const waiting = readState(dir).sessions[session]?.seats[name]?.waiting;
    if (waiting?.state !== 'question-sent-recovery') return false;
    writeWaiting(dir, session, name, { ...waiting, delivered: true }, pane, workspace);
    const back = readState(dir).sessions[session]?.seats[name]?.waiting;
    return back?.state === 'question-sent-recovery' && back.delivered === true;
  } catch {
    return false;
  }
}

/** The same io with both writers silenced: the send's own report is not this command's output,
 *  and its only word here is the exit code. */
function quietIo(io: Io): Io {
  return { ...io, stdout: () => {}, stderr: () => {} };
}

/**
 * The delivery report: the dialog is dismissed and the recovery stands, but the decision line
 * did not reach the seat through the send path. The seat is not a recovery of the key — the key
 * went out — so it is not the recovery row either: the line itself is what is owed.
 */
function deliveryFailure(io: Io, json: boolean, human: string): number {
  if (json) writeJsonError(io, 'answer.delivery', human, null);
  else io.stderr(`${human}\n`);
  // exit: answer.delivery
  return 1;
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
  // The process check compares the pane's process with the identity its launch recorded. With no
  // record there is nothing to compare it with, so the reading cannot be proved this run's seat:
  // the word refuses instead of pressing a key into a pane it cannot identify. The log line keeps
  // the class both words use; the contract row is this word's own.
  if (!launched) {
    return { id: 'answer.trust-identity', class: 'identity', message: `${seat}: its launched identity was not recorded, so the process in its pane cannot be checked` };
  }
  if (!profile) return say('version', 'this version has no trust answer');
  // Every slow or host lookup is resolved before the final process read. `host.version` runs the
  // CLI's `--version`, which can take seconds, and the pane's folder readings are host calls of
  // their own: a process replaced — or a screen switched to a permission, login or other prompt —
  // while one of them runs would be keyed from a process read taken before the replacement, or
  // from a capture taken before the switch. The order the key path relies on is: the version and
  // the folder lookups, then the final process check, then the final pane capture, then only
  // pure checks, then the key. The refusal order is unchanged — the process, the version, the
  // screen and the folder are still judged in that order — only the host reads moved together.
  const printed = host.version(profile.binary);
  const own = host.foregroundCwd(session, pane);
  const lobby = canonicalLanding(resolvedLobby);
  const names = lobby === null ? null : host.list(dirname(lobby));
  const problem = checkProcess(seat, host, session, pane, launched);
  if (problem) return problem;
  const screen = host.pane(session, pane);
  const record = printed
    ? profile.answers.find((item) => isEligible(profile.cli, item) && versionMatches(item, printed))
    : undefined;
  if (!printed || !record) return say('version', 'this version has no trust answer');
  if (readScreen(profile.cli, screen).kind !== 'trust') return say('screen', 'the pane is not the trust dialog');
  if (!labelMatches(record, screen ?? '')) return say('label', 'the trust choice is not the recorded one');
  const shown = extractFolder(record.extract, screen ?? '');
  if (!shown) return say('folder', 'the dialog does not show exactly one folder');
  // `shown` must be the lobby as team writes it, byte for byte, and canonicalise to
  // it — a trailing slash, another case, `//` or `/./` is a different spelling, and
  // the reading that sends less is to refuse it.
  if (!lobby) return say('folder', OUTSIDE);
  if (canonicalLanding(shown) !== lobby) return say('folder', OUTSIDE);
  if (shown !== lobby) return say('folder', 'the dialog does not show the lobby as written: the owner answers it through team up');
  // The screen read strips the row's trailing padding, so the last byte of the path it
  // shows is never proof — a boxed row has no visible end. Two other readings, fresh with
  // this one, must say the lobby too: the folder the pane itself reports working in, byte
  // for byte, and the lobby's parent, where a name the lobby's plus whitespace would be
  // the folder such trimming could have hidden.
  if (own === null) return say('folder', "the pane's folder cannot be read");
  if (own !== lobby) return say('folder', "the pane's folder is not the lobby as written");
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
 * One fresh reading of the pane for the question word: the record this version answers, or the
 * class that refused. Permission, login and trust are never answered, whatever was asked — a
 * trust-to-run-a-command prompt is a permission prompt — and anything the reading cannot call a
 * question, plan approval or confirmation is refused too.
 */
function inspectQuestion(
  seat: string,
  host: AnswerHost,
  session: string,
  pane: string,
  profile: Profile | null,
  launched?: LaunchedIdentity,
): SeenQuestion | Refusal {
  const say = (reason: 'identity' | 'version' | 'permission' | 'login' | 'not-a-question' | 'incomplete', text: string): Refusal =>
    refusedClass(reason, `${seat}: ${text}`);
  // The process check compares the pane's process with the identity its launch recorded. With no
  // record there is nothing to compare it with, so the reading cannot be proved this run's seat:
  // the word refuses instead of pressing a key into a pane it cannot identify.
  if (!launched) return say('identity', 'its launched identity was not recorded, so the process in its pane cannot be checked');
  if (!profile) return say('version', 'this version has no question answer');
  // Every slow or host lookup is resolved before the final process read. `host.version` runs the
  // CLI's `--version`, which can take seconds, and a pane whose foreground process is replaced
  // while it runs would be keyed from a process read taken before the replacement, exactly as a
  // screen switched during it would be keyed from an earlier capture. The order the key path
  // relies on is: version, then the final process check, then the final pane capture, then only
  // pure checks, then the key. The refusal order is unchanged — the process and the screen are
  // still judged before the version's record — only the host reads moved together.
  const printed = host.version(profile.binary);
  const problem = checkProcess(seat, host, session, pane, launched);
  if (problem) return problem;
  const screen = host.pane(session, pane);
  const reading = host.reading
    ? host.reading(profile.cli, screen)
    : { kind: readScreen(profile.cli, screen).kind, dialog: readDialog(profile.cli, screen) };
  if (reading.kind === 'permission') {
    return say('permission', 'the pane is at a permission prompt, which is never answered');
  }
  if (reading.kind === 'login') return say('login', 'the pane is at a login prompt, which is never answered');
  if (reading.kind === 'trust') {
    return say('not-a-question', `the pane is at a trust dialog; team answer ${seat} trust answers it`);
  }
  const dialogs = reading.dialog;
  if (dialogs.dialog === null) {
    return say('not-a-question', 'the pane is not at a question, plan approval or confirmation dialog');
  }
  // The text is then only the part of the block the version's rows reached: a key pressed here
  // would answer the part that was read as though it were the whole question.
  if (!dialogs.complete) {
    return say('incomplete', 'the question runs past the rows this version reads; left as it is');
  }
  const record = printed === null ? null : questionAnswerFor(profile.questionAnswers, dialogs.dialog, printed);
  if (printed === null || record === null) return say('version', 'this version has no question answer');
  return { record, version: printed, kind: dialogs.dialog, text: dialogs.text };
}

/** Whether two fresh readings of a pane name the same dialog and the same recorded answer. */
function sameQuestion(left: SeenQuestion, right: SeenQuestion): boolean {
  return (
    left.kind === right.kind &&
    left.text === right.text &&
    left.record.kind === right.record.kind &&
    left.record.key === right.record.key &&
    left.record.from === right.record.from &&
    left.record.to === right.record.to
  );
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
    return back?.state === waiting.state && back.classification === waiting.classification;
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
 * ready — idle prompt or rules — all leave the word's own recovery state, so all answer with
 * the same row and exit: `trust-sent-recovery` for the trust word, `question-sent-recovery`
 * for the question word.
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
  word: 'trust' | 'question',
): number {
  // No directory means this folder had no team file to log beside. Writing the line would create
  // `.agents` and `team.log` wherever the command was run.
  if (dir !== undefined) logLine(dir, 'answer', who, `${seat}: refused ${word}: ${reason.class}`, host.now());
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
  // exit: answer.identity
  // exit: answer.trust-identity
  // exit: answer.human
  // exit: answer.permission
  // exit: answer.login
  // exit: answer.not-a-question
  // exit: answer.incomplete
  // exit: answer.disagree
  return 1;
}

/** The dialog a finished answer names: the trust word's folder when one was shown, and the
 *  question word's dialog kind — both are what the closing line reports. */
type Finished = { word: 'trust'; folder?: string } | { word: 'question'; dialog: DialogKind };

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
  launched: LaunchedIdentity | undefined,
  done: Finished,
  origin: RulesOrigin = 'file',
): Promise<number> {
  const seatState = readState(dir).sessions[session]?.seats[name];
  const like = seatState?.temporary?.like;
  const seat = configured ?? team.seats.find((item) => item.name === like);
  const profile = seat ? profileFor(seat.cli) : null;
  const launchIdentity = launched ?? seatState?.launched;
  const ready = profile ? await recover(host, session, pane, name, profile, seat as Seat, team, root, standing, launchIdentity, origin) : 'idle';
  if (typeof ready === 'object' && 'class' in ready) {
    return refuse(io, json, dir, who, name, host, ready, done.word);
  }
  if (ready !== true) {
    logLine(dir, 'answer', who, `${name}: refused ${done.word}: ${ready}`, host.now());
    return recovery(io, json, `${name}: ${done.word} sent; recovery required`);
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
  logLine(dir, 'answer', who, `${name}: ${done.word} answered`, host.now());
  const summary = done.word === 'trust'
    ? (done.folder === undefined ? `${name}: answered trust` : `${name}: answered trust (${done.folder})`)
    : `${name}: answered question (${done.dialog})`;
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
      dialog: done.word,
      ...(done.word === 'trust' ? (done.folder !== undefined ? { folder: done.folder } : {}) : { dialog_kind: done.dialog }),
      state: 'ready',
    });
  } else {
    io.stdout(`${contextLine(team.project, session)}\n${summary}\n`);
  }
  // exit: answer.ready
  // exit: answer.question
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
  origin: RulesOrigin = 'file',
): Promise<true | Refusal | 'idle' | 'rule delivery'> {
  if (!(await waitIdle(host, session, pane, profile))) return 'idle';
  const named = host.agents(session)?.some((agent) => agent.name === name && agent.pane === pane) === true;
  if (!named && !host.rename(session, pane, name)) return 'rule delivery';
  if (profile.rulesMode !== 'message') return true;
  // The rules are delivered exactly as `up` delivers them: written to the seat's per-seat
  // file first — from the live file, as `up`'s are — then the one line that points at it,
  // the only shape of rules a read-back can prove; this command shares that delivery.
  const delivery = rulesDeliveryOf(standing, team, seat, root, host.home, false, origin);
  if ('refusal' in delivery) return 'rule delivery';
  if (!writeRulesFile(standing, seat.name, root, host.home, delivery.text, rulesFileHash(delivery.text), undefined, team.project).ok) return 'rule delivery';
  // 0.5.9: a CLI whose launch line carries the rules line took it as its initial prompt, which it
  // runs once the dialog this answer cleared is gone; nothing is typed. Any other CLI's rules are
  // never typed either: deliverRules refuses (src/send/no-pane-messaging.ts).
  // The process must still be the one team launched with that line: a replaced or unreadable one
  // never ran it.
  if (profile.rulesPrompt !== null) return checkProcess(name, host, session, pane, launched) ?? true;
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
