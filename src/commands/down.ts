import { homedir } from 'node:os';
import { notInForce } from '../approve/approval.ts';
import { dirname } from 'node:path';
import { readArgs } from '../args.ts';
import { anotherPaneRefusal, callerOf, describeCaller, detachedRefusal, fileOwnerRefusal, isOwner, judgeCallerIn, mayChangeTeamVerdict, noPaneRefusal, sessionOwnerRefusal, standingOf, walkCaller, type Caller } from '../caller.ts';
import { delegateGate, logDelegated, type DelegateSources, type DelegateVerdict } from '../delegate.ts';
import { grantGate, logGranted } from '../grant.ts';
import { currentTeam, rememberCurrent, type Current } from '../file/current.ts';
import { launchedTeamFile } from '../file/launched-file.ts';
import { loadTeamFile } from '../file/load.ts';
import { validateTeamFile } from '../file/validate.ts';
import type { TeamFile } from '../file/types.ts';
import {
  agentList,
  agentStatus,
  paneForeground,
  paneForegroundCwd,
  paneRead,
  paneShellBack,
  sendKey,
  sessionDelete,
  sessionRunning,
  pressEnter,
  sessionStop,
  typeText,
  workspaceClose,
  paneProcesses,
  type HerdrAgent,
  type PaneProcesses,
} from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import type { ExitTyping, Host } from '../launch/execute.ts';
import { executePlan } from '../launch/execute.ts';
import { reportedLiveAgent } from '../launch/agent.ts';
import { downPlan, formatPlan, type DownSeat } from '../launch/plan.ts';
import { acquireRunLock, runLockText } from '../launch/run-lock.ts';
import { boxHoldsOther, boxHoldsText, DRAW_WAIT_MS, settleScreen } from '../launch/deliver.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { profileFor } from '../profiles/index.ts';
import { logLine } from '../log.ts';
import { seatProcessVerdict } from '../launch/identity.ts';
import { emptySession, readState, updateState, type SeatState } from '../state.ts';
import { forgetLaunchedPane } from '../file/launched-file.ts';
import { readScreen, type Screen, type ScreenOptions } from '../watch/screen.ts';

// What `down` reads from outside the file, so tests can stand in for it.
export type DownSources = {
  sessionRunning(session: string): boolean | null;
  agents(session: string): HerdrAgent[] | null;
  alive(pid: number): boolean;
  /** Herdr's status is not enough: a permission prompt is reported as idle. */
  screen(session: string, pane: string, cli: string, cwd?: string | null): Screen;
  /** The pane's raw text, for reading the input box back before any Enter. */
  screenText(session: string, pane: string, cli: string): string | undefined;
  /** Herdr's own status for the pane. The Enter waits for idle or done. */
  status(session: string, pane: string): string | null;
  /** Foreground argv0 names, or null when the pane can't be read. */
  foreground(session: string, pane: string): string[] | null;
  /** Whether the pane's own shell process is back in front — the pid-based reading, never
   *  argv0 alone (`herdr.ts`, `shellBackOf`). Optional: a caller without it classifies by the
   *  screen exactly as before. */
  shellBack?(session: string, pane: string): boolean | null;
  /** Foreground live working directory, or null when the pane can't be read. */
  foregroundCwd?(session: string, pane: string): string | null;
  /** Pids in the pane, for a seat whose record holds the process `up` launched. Absent: a
   *  record with no process is matched on pane and workspace alone. */
  processes?(session: string, pane: string): PaneProcesses | null;
  now(): Date;
  sleep?(ms: number): Promise<void>;
  /** Approval store home. The real command uses the owner's home. */
  home?: string;
  /** The approval standing. Tests hand in a record; the shipped command reads the store. */
  standing?(root: string): Standing;
  // Present on the shipped command. A dry run never calls it.
  launch?: DownLaunch;
  /** The delegate gate. Tests hand in a verdict; the shipped command asks the real one. */
  gate?: typeof delegateGate;
  /** The gate's own fakes: the approval standing, the approved copy, state, herdr, placement. */
  delegate?: DelegateSources;
  /** The audit line a delegated run leaves. Tests record it; the shipped command writes it. */
  audit?: typeof logDelegated;
  /** The grant gate. Tests hand in a verdict; the shipped command asks the real one. */
  grantGate?: typeof grantGate;
  /** The audit line a granted run leaves. Tests record it; the shipped command writes it. */
  grantAudit?: typeof logGranted;
};

export type DownLaunch = {
  typeText(session: string, pane: string, text: string): boolean;
  /** One key by the name `herdr pane send-keys` takes, sent to clear a box that holds exactly
   *  the exit text this run typed and could not confirm. */
  sendKey(session: string, pane: string, key: string): boolean;
  pressEnter(session: string, pane: string): boolean;
  agentPanes(session: string): string[] | null;
  closeWorkspace(session: string, workspace: string): boolean;
  stopSession(session: string): boolean;
  /** Clears the session this run stopped, so a later `up` starts from the beginning. */
  deleteSession(session: string): boolean;
  kill(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  now(): Date;
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

const realLaunch: DownLaunch = {
  typeText: (session, pane, text) => typeText(pane, text, aim(session)),
  sendKey: (session, pane, key) => sendKey(pane, key, aim(session)),
  pressEnter: (session, pane) => pressEnter(pane, aim(session)),
  agentPanes(session) {
    const agents = agentList(aim(session));
    return agents === null ? null : agents.map((agent) => agent.pane);
  },
  closeWorkspace: (session, workspace) => workspaceClose(workspace, aim(session)),
  stopSession: sessionStop,
  deleteSession: sessionDelete,
  kill(pid) {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

export const realSources: DownSources = {
  sessionRunning,
  agents: (session) => agentList(aim(session)),
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  screen(session, pane, cli, cwd) {
    return readScreen(cli, paneRead(pane, 200, aim(session)) ?? undefined, {
      cwd: cwd ?? undefined,
      home: homedir(),
    });
  },
  screenText: (session, pane) => paneRead(pane, 200, aim(session)) ?? undefined,
  status: (session, pane) => agentStatus(pane, aim(session)),
  foreground: (session, pane) => paneForeground(pane, aim(session)),
  shellBack: (session, pane) => paneShellBack(pane, aim(session)),
  foregroundCwd: (session, pane) => paneForegroundCwd(pane, aim(session)),
  processes: (session, pane) => paneProcesses(pane, aim(session)),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  home: homedir(),
  launch: realLaunch,
};

/** How long `--wait` gives a working seat, in seconds. */
export const WAIT_SECONDS = 120;

export const USAGE = 'Usage: team down [--dry-run] [--wait] [--abandon] [--session <name>] [--file <path>]\n';

export const down: Command = (argv, io) => runDown(argv, io, realSources);
export default down;

// Free only when herdr says idle or done and the screen is an empty idle prompt. A permission
// prompt is idle to herdr, and typing `/exit` there would answer it.
// Herdr keeps a pane after the CLI exits, so the pane id staying listed is not "still there".
// The seat has left when no foreground process is its CLI. An unreadable list keeps the wait.
export function paneStillRunning(foreground: readonly string[] | null, processNames: readonly string[]): boolean {
  if (!foreground) return true;
  return foreground.some((name) => processNames.includes(name));
}

/**
 * The seat's state with the one process reading that tells "its CLI exited" from "its screen is
 * unreadable": the pane's own shell process is back in front (`shellBack`, from pids — never
 * argv0 alone) and the pane's readable foreground list holds no process of the CLI. Both are
 * positive facts, so nothing an unrecognised live screen shows can reach this branch: an
 * unreadable foreground list keeps `paneStillRunning` true, a missing shell-back reading and a
 * CLI still in the list both fall through, and with no profile there are no process names to
 * look for. Everything else is `stateOf`, byte for byte.
 */
export function stateOfPane(
  status: string,
  screen: Screen,
  pane: { foreground: readonly string[] | null; shellBack: boolean | null; processNames: readonly string[] },
): DownSeat['state'] {
  if (pane.shellBack === true && pane.processNames.length > 0 && !paneStillRunning(pane.foreground, pane.processNames)) {
    return 'exited';
  }
  return stateOf(status, screen);
}

export function stateOf(status: string, screen: Screen): DownSeat['state'] {
  if (screen.kind === 'unsent') return 'unsent';
  // A framed exit question already on screen was left by an earlier stop. This run did not ask
  // it, so it is blocked: no key is sent, and `--abandon` closes it only as it closes every
  // other seat that cannot be asked.
  if (screen.kind === 'permission' || screen.kind === 'trust' || screen.kind === 'question' || screen.kind === 'exit question' || screen.kind === 'vendor notice' || screen.kind === 'provider error' || screen.kind === 'rate limit') return 'blocked';
  // A screen showing a running turn is working even when herdr's status has not caught up:
  // `--wait` waits for it, and it is never typed into.
  if (screen.kind === 'working') return 'working';
  if (screen.kind === 'unknown') return 'unknown';
  if (status === 'idle' || status === 'done') return 'free';
  if (status === 'working' || status === 'blocked') return status;
  return 'unknown';
}

/** What `typeExit` may do to one pane, so `down` and `remove` share the whole sequence and the
 *  tests can stand in for every part of it. */
export type ExitIo = {
  typeText(text: string): boolean;
  sendKey(key: string): boolean;
  pressEnter(): boolean;
  screen(): string | undefined;
  status(): string | null;
  foreground(): string[] | null;
  foregroundCwd?(): string | null;
  home?: string;
  sleep(ms: number): Promise<void>;
  now(): number;
};

/**
 * The whole live exit typing for one pane: what `team` sends, and when. The exit text is typed
 * once, into a box that reads empty and idle; a box that already holds exactly this exit text —
 * an earlier run typed it and never confirmed it — is emptied with the profile's one clearing
 * key first, never sent and never typed onto. After the typing, the Enter goes only to a box
 * that reads back as exactly the typed text, the same comparison delivery makes. When the
 * read-back does not confirm the text, nothing is sent on a screen that is not the CLI's own
 * composer; a box that holds exactly the typed text is cleared with the profile's one key, and
 * a profile without one leaves the text for the owner, saying so. The caller check that
 * precedes every key precedes each of these too.
 */
export async function typeExit(io: ExitIo, cli: string, text: string): Promise<ExitTyping> {
  const names = profileFor(cli)?.processNames ?? [];
  // The caller check that precedes every key: the CLI itself must be the pane's foreground
  // process at the key, not when the seat was read.
  const live = () => reportedLiveAgent(io.foreground(), names);
  const resting = () => {
    const status = io.status();
    return status === 'idle' || status === 'done';
  };
  const screenOpts = (): ScreenOptions => ({
    cwd: io.foregroundCwd ? io.foregroundCwd() : undefined,
    home: io.home,
  });
  // One reading of the pane, as text: the kind and the box both come from it, so they cannot
  // disagree. A screen that is not the CLI's composer — a dialog over it, a shell after it —
  // never reaches a key.
  const kindOf = () => readScreen(cli, io.screen(), screenOpts()).kind;
  const holds = () => boxHoldsText(cli, text, io.screen(), screenOpts());
  // The reading that decides a key, waiting out the pane's late drawing — the one wait the exit
  // typing, the watch's nudge and delivery share (settleScreen in launch/deliver.ts).
  const settle = (undrawn: Screen['kind']): Promise<Screen['kind']> => settleScreen(undrawn, kindOf, io);
  const otherRow = (): string => {
    const other = boxHoldsOther(cli, text, io.screen(), screenOpts());
    if (other === null) return '';
    return ` (first row that differs: ${other === '' ? 'a blank row' : other})`;
  };
  // The Enter above sends the exit text. A second key is only the profile's `exit_confirm`,
  // and only once the screen reads as that CLI's own exit question. A quote of the choice
  // row is an ordinary question and gets nothing. A question the profile cannot confirm, or
  // one that stays after the key, is reported at once: the seat could not be stopped by asking.
  const sendExit = async (): Promise<ExitTyping> => {
    if (!live()) return 'no-agent';
    if (!resting()) {
      return { left: 'its exit was not confirmed; the exit text was typed and not sent; left running' };
    }
    if (kindOf() !== 'unsent' || !holds()) {
      return { left: 'its exit was not confirmed; the exit text was typed and not sent; left running' };
    }
    if (!io.pressEnter()) {
      return { left: 'its exit was not confirmed; the exit text was typed and not sent; left running' };
    }
    const confirm = profileFor(cli)?.exitConfirm ?? null;
    const deadline = io.now() + DRAW_WAIT_MS;
    let confirmed = false;
    for (;;) {
      if (!live()) return true;
      if (kindOf() === 'exit question') {
        if (confirm === null) {
          return { left: 'its exit was not confirmed; its profile names no key for the exit question; left running' };
        }
        if (!confirmed) {
          if (!live()) return 'no-agent';
          if (!io.sendKey(confirm)) {
            return { left: 'its exit was not confirmed; the exit question was not answered; left running' };
          }
          confirmed = true;
          continue;
        }
      }
      if (io.now() >= deadline) break;
      const before = io.now();
      await io.sleep(100);
      if (io.now() <= before) break;
    }
    if (!live()) return true;
    if (kindOf() === 'exit question') {
      return { left: 'its exit was not confirmed; the exit question stayed open; left running' };
    }
    return true;
  };

  if (!live()) return 'no-agent';
  if (!resting()) return false;
  // The leftover exit text: cleared with the profile's one key, then typed fresh, so the Enter
  // provably sends only what this run read back. A profile without a key leaves it; the plan
  // or the refusal that sent the seat here says so in its own line.
  const start = kindOf();
  if (start !== 'idle') {
    if (start !== 'unsent' || !holds()) return false;
    const key = profileFor(cli)?.exitClear ?? null;
    // The caller check first: a CLI gone at this key is `no-agent` whether or not the profile
    // carries a clearing key, and "not typed" is for a key-less profile the CLI is still on.
    if (!live()) return 'no-agent';
    if (!resting()) return false;
    if (kindOf() !== 'unsent') return false;
    if (key === null) return false;
    if (!io.sendKey(key)) return false;
    const after = await settle('unsent');
    // The wait can swallow the CLI as well: the caller check precedes the typing, exactly as it
    // precedes every key.
    if (!live()) return 'no-agent';
    if (after !== 'idle' || !resting()) {
      return { left: `its box already held this exit text; the clearing key (${key}) left the screen reading ${after}; left running` };
    }
  }
  if (!io.typeText(text)) return false;
  if (!live()) return 'no-agent';
  if (!resting()) return false;
  // An idle screen right after the typing is the text not rendered yet, not an empty box; the
  // wait settles that before the comparison. Only a box that reads back as exactly the typed
  // text gets the Enter.
  if (holds()) return sendExit();
  const kind = await settle('idle');
  // The wait is a window the pane's state can change in — the CLI can go, a turn can start —
  // so the caller check is taken again here, before the Enter this reading leads to.
  if (!live()) return 'no-agent';
  if (!resting()) return false;
  if (kind !== 'unsent' && kind !== 'idle') {
    // A dialog the CLI drew over the composer hides the box without emptying it: the text typed
    // a moment ago is still in it, so "its exit was not typed" would be the wrong report — the
    // line says what the screen was reading instead. Every other reading (a turn that started, a
    // screen the reader cannot name) proves nothing about where the typed text went, and keeps
    // that report.
    const dialog =
      kind === 'permission' || kind === 'trust' || kind === 'question' || kind === 'exit question' || kind === 'provider error' || kind === 'rate limit';
    if (!dialog) return false;
    return { left: `its exit was not confirmed; the screen was reading ${kind} before the Enter; left running` };
  }
  if (holds()) return sendExit();
  if (kind === 'idle') {
    return { left: 'its exit was not confirmed; the pane never drew the typed text; its box is empty; left running' };
  }
  // The box holds something. The caller check precedes the clearing key, exactly as it precedes
  // every other key.
  if (!live()) return 'no-agent';
  if (!resting()) return false;
  if (kindOf() !== 'unsent') return false;
  const key = profileFor(cli)?.exitClear ?? null;
  if (key === null) {
    return holds()
      ? { left: 'its exit was not confirmed; the text was left in its box; the owner clears it in its pane' }
      : { left: `its exit was not confirmed; its box was left holding other text${otherRow()}; the owner clears it in its pane` };
  }
  if (!holds()) {
    return { left: `its exit was not confirmed; its box holds text that is not only the exit text${otherRow()}; nothing more was sent; left running` };
  }
  if (!io.sendKey(key)) {
    return { left: `its exit was not confirmed; the clearing key (${key}) was not delivered; the text was left; left running` };
  }
  const after = await settle('unsent');
  if (after === 'idle' && resting()) return 'cleared';
  return { left: `its exit was not confirmed; the clearing key (${key}) left the screen reading ${after}; left running` };
}

/** This seat's pane when the state records that pane and that workspace for exactly one seat.
 *  Herdr's name is not read: a title is not the seat's name, and a missing name is not a
 *  different pane. A record that also holds the launched process is this pane's only while
 *  that process is still there, or the pane is back at the shell this team recorded. */
function claimRecorded(
  seats: Record<string, SeatState>,
  agent: HerdrAgent,
  processes: PaneProcesses | null,
): { name: string; close: boolean } | null {
  const matches = Object.entries(seats).filter(([, seat]) => seat.pane === agent.pane && seat.workspace === agent.workspace);
  if (matches.length !== 1) return null;
  const [name, seat] = matches[0] as [string, SeatState];
  if (!seat.launched) return { name, close: true };
  const verdict = seatProcessVerdict(seat.launched, processes);
  return { name, close: verdict === 'same' || verdict === 'gone' };
}

function leftNote(claim: { name: string; close: boolean } | null, pane: string): string {
  return claim
    ? `${claim.name}: pane ${pane} is not the process this team launched; left as it is`
    : `pane ${pane}: not recorded for a seat of this team; left as it is`;
}

export async function runDown(argv: string[], io: Io, sources: DownSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['dry-run', 'wait', 'abandon']);
  if (args.error || args.rest.length) {
    io.stderr(`team down: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: down.invocation
    return 2;
  }
  const detached = detachedRefusal(walkCaller(io));
  if (detached !== undefined) {
    io.stderr(`team down: ${detached}\n`);
    // exit: down.caller
    return 1;
  }
  const dry = args.flags.has('dry-run');
  const refusals: string[] = [];

  // --- the delegate branch -----------------------------------------------------------------
  // The gate is asked at most once, and only where the ordinary rule has just refused: a caller
  // the ordinary rule accepts never reaches it, and the owner — never a delegate — asks nothing.
  // The live file is read directly, never `currentTeam`'s remembered copy and never `last_valid`,
  // and this command acts on that same read when the branch decides the run: a delegated run
  // never calls `currentTeam` at all. A file that does not load carries no delegate, and the
  // ordinary path keeps its own fallback and its own words.
  //
  // `granted` is the approved pane a `passed` verdict names. A refusal the gate can only give
  // *after* it placed the caller — an unlisted command, a prohibited flag — means the caller is
  // that pane too: its run plans as a delegate's though the refusal stops it.
  const gate = sources.gate ?? delegateGate;
  const flags = [...args.flags, ...Object.keys(args.values)];
  let asked = false;
  let verdict: DelegateVerdict | undefined;
  let granted: string | undefined;
  let placed = false;
  let liveRead = false;
  let live: LiveFile | undefined;
  const liveFile = (): LiveFile | undefined => {
    if (!liveRead) {
      liveRead = true;
      live = liveTeam(io, sources.home);
    }
    return live;
  };
  const decide = (): DelegateVerdict | undefined => {
    if (asked) return verdict;
    asked = true;
    const file = liveFile();
    if (file === undefined || file.team.delegates === null) return undefined;
    verdict = gate({
      command: 'down',
      team: file.team,
      root: file.root,
      dir: file.dir,
      flags,
      io: { env: io.env, stdinIsTTY: io.stdinIsTTY, caller: io.caller, callerSources: io.callerSources },
      ...(sources.delegate ? { sources: sources.delegate } : {}),
    });
    if (verdict.kind === 'passed') granted = verdict.pane;
    else if (verdict.id === 'down.delegate-command' || verdict.id === 'down.delegate-flag') placed = true;
    return verdict;
  };
  // The caller is the pane the gate placed: the run is the delegate's, whatever the verdict.
  const branching = (): boolean => granted !== undefined || placed;

  // The `--file` check is the walk's too, and it runs before `currentTeam` reads that file or
  // writes beside it: a non-owner aiming `--file` must not make this command read and validate
  // another project's team file, nor leave its `last_valid` in that project's state. The one
  // place every command whose `--file` is the owner's decides it is `fileOwnerRefusal` (caller.ts).
  // A delegate is refused here too, and its refusal is the gate's: every flag is the owner's,
  // this one included, so the flagged path is never read and the run goes on as the delegate's.
  // Any other answer — the gate didn't place this caller, or the file carries no delegate — is
  // refused here, byte for byte as today.
  const fileRefusal = fileOwnerRefusal(io, args.values.file);
  if (fileRefusal !== undefined) {
    const said = decide();
    if (said?.kind === 'refused' && placed) {
      refusals.push(said.text);
    } else {
      io.stderr(`team down: ${fileRefusal}\n`);
      // exit: down.file-owner
      return 1;
    }
  }
  // The owner is a terminal outside herdr, and the walk alone decides that: a non-owner aiming
  // `--session` is refused here, before `currentTeam` writes anything and before the flag's
  // session is read — no agent list, no pane root, no `last_valid`, no log line. The dry run
  // refuses the same way: the plan it would print is that session's, which is not its to aim.
  // (A seat cannot be named in this refusal: placing it would read a session, and that is what
  // must not happen yet.) A delegate's `--session` is the same case as its `--file`.
  if (args.values.session !== undefined && !branching()) {
    const walked = walkCaller(io);
    if (!isOwner(walked)) {
      const said = decide();
      if (said?.kind === 'refused' && placed) {
        refusals.push(said.text);
      } else {
        io.stderr(`team down: ${sessionOwnerRefusal(walked)}\n`);
        // exit: down.session-owner
        return 1;
      }
    }
  }
  // Both flags are dropped once the branch has decided the run: the gate has refused them, and a
  // delegated run judges the file's own session, as any delegated `down` does.
  const launched = args.values.file ? undefined : launchedTeamFile(io, sources.home);
  const file = branching() ? undefined : (args.values.file ?? launched);
  const sessionFlag = branching() ? undefined : args.values.session;

  // The run's file. The load is today's: `currentTeam` falls back to the last copy that
  // validated. Remembering is off until the caller rule and `--abandon` have answered, below.
  // A caller that is not the owner may be a delegate's, and a delegated run reads the live file
  // directly — never `currentTeam`, never `last_valid` — so a live file that carries `delegates`
  // is the run's file, whether the gate passes that caller or refuses it. A file that does not
  // load carries no delegate: today's path, with today's fallback and today's words, decides.
  const owner = isOwner(walkCaller(io));
  const liveNow = owner ? undefined : liveFile();
  const current: Current = liveNow !== undefined && liveNow.team.delegates !== null
    ? { ok: true, team: liveNow.team, root: liveNow.root, dir: liveNow.dir, warnings: [] }
    : currentTeam(io.cwd, file, sources.now(), sources.home, false);
  if (!current.ok) {
    for (const problem of current.errors) {
      io.stderr(`team down: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    // exit: down.not-a-repo
    // exit: down.file
    // exit: down.file-invalid
    return 2;
  }
  if (current.notice) io.stdout(`${current.notice}\n`);
  const { team, dir, root } = current;
  // With no `--session` the session this run judges and stops is the caller's own placement: the
  // file's session first, then a session the state records this caller's pane in (`team up
  // --session <other>`) — never one a non-owner chose, and the plan then names that session. The
  // flag keeps aiming the run, for the owner alone. A delegated run stops the whole team, in the
  // session the file names: its caller is a pane outside that team, and no placement of it may
  // move the run onto another session — its own included.
  const judged = branching()
    ? { caller: callerOf(io), session: team.session }
    : sessionFlag !== undefined
      ? { caller: callerOf(io, sessionFlag === 'default' ? undefined : sessionFlag), session: sessionFlag }
      : judgeCallerIn(io, dir, team);
  let caller = judged.caller;
  let session = judged.session;

  // The ordinary caller rule, for the session the caller's own placement named. It is what decides
  // whether the gate is asked at all: a caller the rule accepts never enters the delegate branch,
  // and a run it accepts keeps its own session, its own plan and today's bytes exactly.
  const rule = mayChangeTeamVerdict(caller, team, standingOf(dir, session, caller));
  // A gate answer can move a run onto another session: the delegate branch always stops the team
  // the file names, whatever session the caller's placement pointed at. The two differ only for a
  // caller placed in a session the state holds (`team up --session <other>`), and the owner is
  // never one of those. So the gate is asked here, before the checks below, and a placed caller's
  // run is checked — and stopped — in the file's session, not in the one it happens to sit in.
  // Asking before those checks is the point: an idle session of the caller's own must not wave
  // through a run that stops another, and a refusal that places nobody leaves the run on its own
  // session, where the checks below still come first: an idle one returns idle, as it would have.
  if (!owner && judged.session !== team.session && rule.kind !== 'ok') {
    const said = decide();
    if (said?.kind === 'refused' && placed) refusals.push(said.text);
    if (branching()) {
      caller = callerOf(io);
      session = team.session;
    }
  }

  // The load above wrote nothing. A refused caller, a dry run, and a run that finds the
  // session lock held leave the state file as it was. An allowed run that is not a dry run
  // remembers when it leaves through an early failure (herdr silent, the session idle, the
  // agent list unreadable), and a run that takes the lock remembers once that lock is held,
  // before anything the stop itself can fail at. A delegated run has no loaded path and still
  // remembers nothing.
  // A grant, when the file has one, is what admits the orchestrator's own `down`. The operator
  // and the owner stay on the rule above. A passed grant keeps this run a seat's run: both lead
  // seats stay in `keep`. A file that omits `grant` does not ask, and today's `down` stands.
  let grantSeat: string | undefined;
  let grantRefusal: string | undefined;
  if (!branching() && rule.kind === 'ok' && caller.kind === 'seat' && caller.name === team.orchestrator && team.grant) {
    const said = (sources.grantGate ?? grantGate)({ act: 'down', io, home: sources.home });
    if (said.kind === 'passed') grantSeat = said.grant.seat;
    else grantRefusal = said.text;
  }

  const callerRefused = (rule.kind !== 'ok' && !branching()) || grantRefusal !== undefined;
  const abandonRefused = args.flags.has('abandon') && granted === undefined && !callerOwns(caller) && verdict === undefined;
  const mayRemember = !callerRefused && !abandonRefused && !dry && current.path !== undefined;
  const remember = (): void => {
    if (mayRemember && current.path !== undefined) rememberCurrent(current.dir, current.path, sources.now());
  };

  const running = sources.sessionRunning(session);
  if (running === null) {
    io.stderr("team down: herdr doesn't answer; is it installed and running?\n");
    remember();
    // exit: down.herdr
    return 2;
  }
  if (!running && grantRefusal === undefined) {
    io.stdout(`session ${session} is not running: nothing to stop${dry ? '\ndry run: nothing was run' : ''}\n`);
    remember();
    // exit: down.idle
    return 0;
  }
  let agents = running ? sources.agents(session) : [];
  if (agents === null) {
    io.stderr(`team down: the agents of session ${session} can't be read\n`);
    remember();
    // exit: down.agents
    return 2;
  }

  if (grantRefusal !== undefined) refusals.push(grantRefusal);
  if (rule.kind !== 'ok' && !branching()) {
    // The ordinary rule has refused, and only now is the gate asked. With no delegate in the live
    // file nothing changes. A refusal takes the ordinary refusal's place, in the same place and at
    // the same exit statuses: a real run stops on it, a dry run says what it would refuse and
    // prints the plan. A pass lets the run go on as the delegate's.
    const said = decide();
    if (said === undefined) {
      if (rule.kind === 'no-pane') {
        refusals.push(noPaneRefusal(rule.name));
      } else if (rule.kind === 'another-pane') {
        refusals.push(anotherPaneRefusal(rule.name, rule.recordedPane));
      } else {
        refusals.push(
          `only the owner, the orchestrator or the operator stops the team; this call is ${describeCaller(caller)}`,
        );
      }
    } else if (said.kind === 'refused') {
      refusals.push(said.text);
    }
  }
  // A delegated run never abandons: `--abandon` is the gate's refusal, and the plan holds every
  // seat, orchestrator and operator included, exactly as the owner's own `down` does. A gate that
  // has answered is the run's only refusal: today's abandon line stays out of the way of its own.
  const abandon = args.flags.has('abandon') && granted === undefined;
  if (abandon && !callerOwns(caller) && verdict === undefined) {
    refusals.push('only the owner abandons a team, from a terminal outside herdr');
  }
  const branchRun = branching();

  const state = readState(dir).sessions[session];
  const home = sources.home ?? homedir();
  let acting = team;
  if (refusals.length === 0) {
    const standing = sources.standing?.(root) ?? approvalStanding(root, home);
    if (standing.kind !== 'verified') {
      io.stderr(`team down: ${notInForce(standing)}\n`);
      // exit: down.never-approved
      // exit: down.legacy
      // exit: down.refused
      return 1;
    }
    const approved = validateTeamFile(standing.record.file);
    if (!approved.ok) {
      io.stderr('team down: the approved copy of the team file cannot be read\n');
      // exit: down.approved-copy
      return 1;
    }
    acting = approved.team;
  }
  // The stop list is the copy in force. A name that copy carries, listed once, is that seat.
  // Any other agent — no name, or a name the copy does not carry — is this team's only when
  // one seat records that pane and that workspace, and, when the record holds a launched
  // process, that process is still the one in the pane. The name is not that match. A caller
  // already refused keeps the live file's names, so the dry-run plan is that refusal's.
  const known = new Set(acting.seats.map((seat) => seat.name));
  const cliOf = new Map(acting.seats.map((seat) => [seat.name, seat.cli]));
  const cliFor = (name: string): string => cliOf.get(name) ?? 'unknown';

  if (!dry && args.flags.has('wait') && refusals.length === 0) {
    const deadline = sources.now().getTime() + WAIT_SECONDS * 1000;
    const sleep = sources.sleep ?? sources.launch?.sleep;
    while (sleep && sources.now().getTime() < deadline) {
      const waiting = agents.some((agent) => {
        if (!agent.name) return false;
        const liveCwd = sources.foregroundCwd ? sources.foregroundCwd(session, agent.pane) : null;
        const cli = cliFor(agent.name);
        // The same reading the plan classifies with: a seat whose CLI exited is not working,
        // even when herdr's status word still says it is, so nothing waits for it.
        const state = stateOfPane(agent.status, sources.screen(session, agent.pane, cli, liveCwd), {
          foreground: sources.foreground(session, agent.pane),
          shellBack: sources.shellBack ? sources.shellBack(session, agent.pane) : null,
          processNames: profileFor(cli)?.processNames ?? [],
        });
        return state === 'working';
      });
      if (!waiting) break;
      const before = sources.now().getTime();
      await sleep(2000);
      if (sources.now().getTime() <= before) break;
      const again = sources.agents(session);
      if (again === null) break;
      agents = again;
    }
  }

  const seats: DownSeat[] = [];
  const notes: string[] = [];
  let extra = 0;
  const named = new Map<string, HerdrAgent[]>();
  for (const agent of agents) {
    if (!agent.name) {
      const claim = claimRecorded(state?.seats ?? {}, agent, sources.processes?.(session, agent.pane) ?? null);
      if (claim?.close) {
        seats.push({
          name: claim.name,
          cli: cliFor(claim.name),
          pane: agent.pane,
          workspace: agent.workspace,
          state: 'free',
          unnamed: true,
        });
      } else {
        extra++;
        if (refusals.length === 0) notes.push(leftNote(claim, agent.pane));
      }
      continue;
    }
    const listed = named.get(agent.name) ?? [];
    listed.push(agent);
    named.set(agent.name, listed);
  }
  for (const [name, listed] of named) {
    if (!known.has(name)) {
      const foreign: HerdrAgent[] = [];
      for (const agent of listed) {
        const claim = claimRecorded(state?.seats ?? {}, agent, sources.processes?.(session, agent.pane) ?? null);
        if (claim?.close) {
          seats.push({
            name: claim.name,
            cli: cliFor(claim.name),
            pane: agent.pane,
            workspace: agent.workspace,
            state: 'free',
            title: name,
          });
        } else if (claim) {
          extra++;
          if (refusals.length === 0) notes.push(leftNote(claim, agent.pane));
        } else {
          foreign.push(agent);
        }
      }
      if (foreign.length > 0) {
        extra += foreign.length;
        if (refusals.length === 0) {
          notes.push(`${name}: its record is not an approved seat; left running (the owner cleans it: team remove ${name} --abandon)`);
        }
      }
      continue;
    }
    if (listed.length !== 1) {
      extra += listed.length;
      if (refusals.length === 0) notes.push(`${name}: herdr lists more than one agent of this name; left as it is`);
      continue;
    }
    const agent = listed[0] as HerdrAgent;
    const cli = cliFor(agent.name as string);
    const profile = profileFor(cli);
    const liveCwd = sources.foregroundCwd ? sources.foregroundCwd(session, agent.pane) : null;
    const shown = sources.screen(session, agent.pane, cli, liveCwd);
    // The process reading decides "its CLI exited" before the screen is consulted: a bare shell
    // draws nothing the profiles recognise, so the screen alone can never tell it from a live
    // CLI whose screen this profile can't read.
    const reading = stateOfPane(agent.status, shown, {
      foreground: sources.foreground(session, agent.pane),
      shellBack: sources.shellBack ? sources.shellBack(session, agent.pane) : null,
      processNames: profile?.processNames ?? [],
    });
    // An unsent box that holds exactly the profile's exit text — an earlier run typed it and
    // never confirmed it — is named as such either way: the profile's one clearing key decides
    // whether this run empties it and asks again (the plan's run step) or the owner does (its
    // skip line). Anything else unsent keeps the ordinary unsent line.
    const exitInBox = reading === 'unsent' && profile !== null
      && boxHoldsText(cli, profile.exit, sources.screenText(session, agent.pane, cli), { cwd: liveCwd ?? undefined, home: sources.home });
    seats.push({
      name,
      cli,
      pane: agent.pane,
      workspace: agent.workspace,
      state: reading,
      ...(exitInBox ? { exitInBox: true } : {}),
      ...(shown.kind === 'exit question' ? { atExitQuestion: true } : {}),
    });
  }

  const watch = state?.watch;
  const watchAlive = Boolean(watch && sources.alive(watch.pid));
  if (watchAlive && refusals.length === 0) notes.push('watch: its pid is only in the state; left running');
  for (const note of notes) io.stdout(`${note}\n`);
  const plan = downPlan({
    session,
    seats,
    extra,
    watchPid: refusals.length === 0 ? null : watchAlive && watch ? watch.pid : null,
    // A delegated run stops the whole team: no seat is kept back, the orchestrator and the
    // operator included. The delegate sits outside the session, so it never stops itself.
    keep: !branchRun && caller.kind === 'seat' ? [acting.orchestrator, acting.operator] : [],
    abandon: abandon && callerOwns(caller),
    // A free seat is still asked. When that ask cannot be typed or confirmed, the owner's
    // `--abandon` closes it in this same run; every other run names that close and leaves it.
    closeUnasked: abandon && callerOwns(caller),
    unasked: 'team down --abandon closes it',
  });

  if (dry) {
    // A refusal leaves through the real run's return below, so the status and the exit id
    // are that refusal's. The words stay the dry run's, and nothing is written.
    for (const refusal of refusals) io.stdout(`! down would refuse: ${refusal}\n`);
    io.stdout(formatPlan(plan));
  }
  if (refusals.length) {
    if (!dry) for (const refusal of refusals) io.stderr(`team down: ${refusal}\n`);
    // exit: down.caller
    // exit: down.abandon
    // exit: down.no-pane
    // exit: down.another-pane
    // exit: down.delegate
    // exit: down.delegate-approval
    // exit: down.delegate-approved-copy
    // exit: down.delegate-drift
    // exit: down.delegate-evidence
    // exit: down.delegate-placement
    // exit: down.delegate-command
    // exit: down.delegate-flag
    // exit: down.grant-approval
    // exit: down.grant-approved-copy
    // exit: down.grant-drift
    // exit: down.grant-scope
    return 1;
  }
  if (dry) {
    // exit: down.dry-run
    return 0;
  }
  const launch = sources.launch;
  if (!launch) {
    io.stderr('team down: this call has no way to reach herdr\n');
    // exit: down.no-launch
    return 1;
  }
  // The session mutator lock: this run has effects from here — the delegated audit line, the
  // typing and closes of the plan below, the session stop — and no other session command may
  // interleave its own. Every refusal above is decided first, a dry run returned above, an
  // idle `down` returned at its own check, and the lock is released on every exit path
  // (`launch/run-lock.ts`).
  const runLock = acquireRunLock(dir, session);
  if ('held' in runLock) {
    io.stderr(`team down: ${runLockText(runLock.held, session, dir)}\n`);
    // exit: down.run-lock
    return 1;
  }
  try {
    remember();
    // The audit line goes in exactly when the delegate's run passes its gate and proceeds to
    // effects — never on a dry run (returned above), never on an already-idle `down` (which
    // returns at its own check, before any caller rule), never when a refusal held the run, and
    // never when herdr is out of reach.
    if (granted !== undefined) (sources.audit ?? logDelegated)(dir, granted, 'down', sources.now());
    // The granted seat's line, at the same moment, before the first close.
    if (grantSeat !== undefined) (sources.grantAudit ?? logGranted)(dir, grantSeat, 'down', sources.now());

    const now = () => sources.now();
    const host: Host = {
      startServer: () => false,
      sessionUp: () => true,
      createWorkspace: () => null,
      paneRun: () => false,
      async typeLine(sessionName, pane, text) {
        // Free was decided when the plan was built. Look again, and once more between the text and
        // the Enter: a prompt that appeared would take the key, as the watch's nudge does. Herdr's
        // status is asked both times; the Enter waits until it is idle or done and the box reads
        // back as exactly the typed text. The whole sequence, the clearing key included, is
        // `typeExit`'s, shared with `remove`.
        const cli = seats.find((seat) => seat.pane === pane)?.cli ?? '';
        return typeExit({
          typeText: (line) => launch.typeText(sessionName, pane, line),
          sendKey: (key) => launch.sendKey(sessionName, pane, key),
          pressEnter: () => launch.pressEnter(sessionName, pane),
          screen: () => sources.screenText(sessionName, pane, cli),
          status: () => sources.status(sessionName, pane),
          foreground: () => sources.foreground(sessionName, pane),
          foregroundCwd: () => (sources.foregroundCwd ? sources.foregroundCwd(sessionName, pane) : null),
          home: sources.home,
          sleep: sources.sleep ?? launch.sleep,
          now: () => sources.now().getTime(),
        }, cli, text);
      },
      renameAgent: () => false,
      closeWorkspace: launch.closeWorkspace,
      stopSession: launch.stopSession,
      // Only the session this run has itself just stopped. Herdr keeps a stopped session listed
      // (`running: false`) until `session delete`; a delete while it still reports running is
      // refused. Wait out that report, then delete, and retry the delete until it takes.
      async deleteSession(name) {
        const sleep = sources.sleep ?? launch.sleep;
        const deadline = sources.now().getTime() + DRAW_WAIT_MS;
        const wait = async (): Promise<boolean> => {
          if (sources.now().getTime() >= deadline) return false;
          const before = sources.now().getTime();
          await sleep(100);
          return sources.now().getTime() > before;
        };
        for (;;) {
          const running = sources.sessionRunning(name);
          if (running === null) return false;
          if (!running) break;
          if (!(await wait())) return false;
        }
        for (;;) {
          if (launch.deleteSession(name)) return true;
          if (!(await wait())) return false;
        }
      },
      kill: launch.kill,
      agentPanes(sessionName) {
        const listed = launch.agentPanes(sessionName);
        if (!listed) return null;
        // A pane back at its shell is no longer the seat. `gone` then finishes and the workspace
        // closes. The wait keeps an unreadable list (`paneStillRunning`); the watch's quota read
        // asks the other way — `reportedLiveAgent`, a figure only where the CLI was seen.
        return listed.filter((pane) => {
          const cli = seats.find((seat) => seat.pane === pane)?.cli;
          const names = cli ? profileFor(cli)?.processNames : undefined;
          if (!names) return true;
          return paneStillRunning(sources.foreground(sessionName, pane), names);
        });
      },
      classify: () => 'unknown',
      sleep: sources.sleep ?? launch.sleep,
      now: () => now().getTime(),
      allow: () => null,
      record() {},
      running() {},
      drop(name) {
        let pane: string | undefined;
        updateState(dir, (file) => {
          const seatsOf = (file.sessions[session] ??= emptySession()).seats;
          pane = seatsOf[name]?.pane;
          delete seatsOf[name];
        });
        if (pane) forgetLaunchedPane(sources.home ?? homedir(), pane, session);
      },
      say: (line) => io.stdout(line),
      log: (who, what) => logLine(dir, 'down', describeCaller(caller), `${who}: ${what}`, now()),
    };
    const report = await executePlan(plan, session, host);
    // exit: down.stopped
    // exit: down.held
    return report.held ? 1 : 0;
  } finally {
    runLock.release();
  }
}

/** A team file read directly, with the project root and the `.agents` directory beside it. */
type LiveFile = { team: TeamFile; root: string; dir: string };

/**
 * The live team file, read directly: the copy the delegate gate judges and the copy a delegated
 * run acts on. Never `currentTeam`'s remembered copy, never `last_valid` — a file that does not
 * load carries no delegate, and the ordinary path keeps its own fallback and its own words.
 */
function liveTeam(io: Io, home?: string): LiveFile | undefined {
  const loaded = loadTeamFile(io.cwd, home ? { home } : {});
  if (!loaded.ok) return undefined;
  return { team: loaded.team, root: loaded.root, dir: dirname(loaded.path) };
}

function callerOwns(caller: Caller): boolean {
  return caller.kind === 'owner';
}
