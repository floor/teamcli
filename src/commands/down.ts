import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { notInForce } from '../approve/approval.ts';
import { dirname, join, resolve } from 'node:path';
import { readArgs, type Args } from '../args.ts';
import { ownerSeatRuleAdmits, ownerSeatStep } from '../client/owner-action-step.ts';
import type { OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { KEY_ISOLATION_LINE, activeClientUpGrant, withClientGrantLock, type ClientUpGrantRecord } from '../client/records.ts';
import { verifyClientUp } from '../client/up-grant.ts';
import { plainText } from '../launch/plain.ts';
import { processNameMatches } from '../clis.ts';
import { devModeCallerGate, devModeExpiryNote, devModeFileApproval, devModeLevelNote, devModeOwnerLiftAtCwd, logDevMode, logDevModeState, resolveDevMode } from '../dev_mode.ts';
import { anotherPaneRefusal, callerOf, describeCaller, detachedRefusal, fileOwnerRefusal, isOwner, judgeCallerIn, noPaneRefusal, sessionOwnerRefusal, standingOf, walkCaller, type Caller, type SeatStanding } from '../caller.ts';
import { gateVerdict } from '../permissions/who.ts';
import { delegateGate, logDelegated, type DelegateSources, type DelegateVerdict } from '../delegate.ts';
import { entityGrantAdmits, grantGate, logGranted, readEntityCreateGrants } from '../grant.ts';
import { currentTeam, rememberCurrent, type Current } from '../file/current.ts';
import { launchedTeamFile } from '../file/launched-file.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import { getTeam, noteTeam, teamIdOf } from '../registry/teams.ts';
import { registerEnd, registerSessionEnd } from '../registry/sync.ts';
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
import type { ExitKeys, ExitTyping, Host } from '../launch/execute.ts';
import { executePlan } from '../launch/execute.ts';
import { stopSeatCodexEndpoint, type EndpointStopRead } from '../launch/codex-endpoint.ts';
import { reportedLiveAgent } from '../launch/agent.ts';
import { downPlan, formatPlan, type DownSeat } from '../launch/plan.ts';
import { acquireRunLock, runLockText } from '../launch/run-lock.ts';
import { resetCliHookState } from '../launch/cli-hook.ts';
import { boxHoldsOther, boxHoldsText, DRAW_WAIT_MS, settleScreen } from '../launch/deliver.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { herdrUnreliable, profileFor } from '../profiles/index.ts';
import { logLine } from '../log.ts';
import { seatProcessVerdict } from '../launch/identity.ts';
import { emptySession, readState, updateState, type SeatState } from '../state.ts';
import { forgetLaunchedPane } from '../file/launched-file.ts';
import { readScreen, type Screen, type ScreenOptions } from '../watch/screen.ts';
import { hasJsonFlag, planStepsOf, refuse, writeJson, type PlanStep } from '../output/index.ts';
import { expiryPhrase } from '../client/duration-policy.ts';

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
  /** The credential store an owner-seat answer is confirmed against. Absent: the system store. */
  ownerSeatStore?: OwnerSeatKeyStore;
  /** The approval standing. Tests hand in a record; the shipped command reads the store. */
  standing?(root: string): Standing;
  // Present on the shipped command. A dry run never calls it.
  launch?: DownLaunch;
  /** Stops the managed Codex endpoint a seat's launch recorded, before the record that names it
   *  is dropped. Absent on a world with no endpoint seam: nothing is stopped or said. */
  codexEndpoint?: {
    stop(input: { dir: string; session: string; seat: string }): EndpointStopRead;
  };
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

/** One refusal this run carries to its single exit site: its contract row, the sentence, and
 *  the repair when the gate named one. */
type DownRefusal = { id: string; message: string; repair?: string | null };

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
  codexEndpoint: { stop: (input) => stopSeatCodexEndpoint(input) },
};

/** How long `--wait` gives a working seat, in seconds. */
export const WAIT_SECONDS = 120;

export const USAGE = 'Usage: team down [--dry-run] [--wait] [--abandon] [--session <name>] [--file <path>] [--json]\n       team down --client <grant-file> --key <client-key> [--team <team>] [--dry-run] [--wait] [--json]\n       team down --request [--dry-run] [--wait] [--json]\n       team down --approval <request-id> [--dry-run] [--wait] [--abandon] [--json]\n\nThe owner-seat form needs no owner terminal: --request records this stop (repository, team, HEAD, arguments; fifteen minutes) and sends it to the owner seat, where the owner answers on the owner page with a passkey or Touch ID; --approval <request-id> then runs it, once, as signed. A signed always rule for team-down covering this folder admits the run with no request. A seat the team marks leads, on its own pane, may run it too.\n\nThe --client form is for a client with no terminal that the owner signed a down grant for (team grant --client <id> --entity <entity> --public-key <file> --team <team> --down --request): it stops that one team at that one folder, as signed, and nothing else. It never prompts.\n\nExits 0 when the session is down or the dry-run plan is printed, 1 when the stop is refused, 2 when the invocation, team file, or herdr can\'t be read.\n';

export const down: Command = (argv, io) => runDown(argv, io, realSources);
export default down;

/** The invocation problems the client form owns, or null: it takes its grant and its key together,
 *  never the owner's `--file`, `--session` or `--abandon`, and `--team` only names the team the
 *  grant is for. */
function clientInvocationProblem(args: Args): string | null {
  const client = args.values.client !== undefined;
  if (client && args.values.key === undefined) return '--client needs --key <client-key-file>';
  if (!client && args.values.key !== undefined) return '--key belongs to the --client form: team down --client <grant-file> --key <client-key-file>';
  if (!client && args.values.team !== undefined) return '--team belongs to the --client form: team down --client <grant-file> --key <client-key-file> --team <team>';
  if (client && (args.values.file !== undefined || args.values.session !== undefined || args.flags.has('abandon'))) {
    return '--client stops the one team its grant names: --file, --session and --abandon are the owner\'s and take no --client';
  }
  return null;
}

// Free only when herdr says idle or done and the screen is an empty idle prompt. A permission
// prompt is idle to herdr, and typing `/exit` there would answer it.
// Herdr keeps a pane after the CLI exits, so the pane id staying listed is not "still there".
// The seat has left when no foreground process is its CLI. An unreadable list keeps the wait.
export function paneStillRunning(foreground: readonly string[] | null, processNames: readonly string[]): boolean {
  if (!foreground) return true;
  return foreground.some((name) => processNameMatches(name, processNames));
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
  pane: { foreground: readonly string[] | null; shellBack: boolean | null; processNames: readonly string[]; cli?: string },
): DownSeat['state'] {
  if (pane.shellBack === true && pane.processNames.length > 0 && !paneStillRunning(pane.foreground, pane.processNames)) {
    return 'exited';
  }
  return stateOf(status, screen, pane.cli);
}

export function stateOf(status: string, screen: Screen, cli?: string): DownSeat['state'] {
  if (screen.kind === 'unsent') return 'unsent';
  // A framed exit question already on screen was left by an earlier stop. This run did not ask
  // it, so it is blocked: no key is sent, and `--abandon` closes it only as it closes every
  // other seat that cannot be asked.
  if (screen.kind === 'permission' || screen.kind === 'trust' || screen.kind === 'question' || screen.kind === 'exit question' || screen.kind === 'vendor notice' || screen.kind === 'provider error' || screen.kind === 'rate limit') return 'blocked';
  // A screen showing a running turn is working even when herdr's status has not caught up:
  // `--wait` waits for it, and it is never typed into.
  if (screen.kind === 'working') return 'working';
  if (screen.kind === 'unknown') return 'unknown';
  // A profile herdr cannot report faithfully is read from its screen: the profile's own module
  // read the seat as idle, which is its prompt. Every other screen kind above keeps its word —
  // a working turn or a dialog is never made less cautious by this reading.
  if (screen.kind === 'idle' && herdrUnreliable(cli)) return 'free';
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
  // A profile herdr cannot report faithfully is at rest when its own screen reads idle; the
  // screen check below each call is the reading there, and it stays the gate for every key.
  const resting = () => {
    if (herdrUnreliable(cli)) return true;
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

/**
 * The live key exit for one pane: a CLI whose TUI takes no exit text leaves on its own key at
 * its idle screen. The caller check that precedes every key precedes each one, and the screen
 * is read fresh right before it: a key goes only to a screen that reads idle, so a prompt that
 * appeared between the planning and the key takes nothing. Every key is pressed at such a
 * screen; once one is pressed the seat counts as asked, and the wait after the step says
 * whether it left.
 */
export async function keyExit(io: ExitIo, cli: string, keys: readonly string[]): Promise<ExitKeys> {
  const names = profileFor(cli)?.processNames ?? [];
  // The caller check that precedes every key: the CLI itself must be the pane's foreground
  // process at the key, not when the seat was read.
  const live = () => reportedLiveAgent(io.foreground(), names);
  // The same reading as `typeExit`: a profile whose herdr status is unreliable is at rest at
  // its own idle screen, and the screen check right after this one is what gates the key.
  const resting = () => {
    if (herdrUnreliable(cli)) return true;
    const status = io.status();
    return status === 'idle' || status === 'done';
  };
  const kindOf = () =>
    readScreen(cli, io.screen(), { cwd: io.foregroundCwd ? io.foregroundCwd() : undefined, home: io.home }).kind;
  let pressed = 0;
  for (const key of keys) {
    if (!live()) return pressed > 0 ? true : 'no-agent';
    if (!resting()) return pressed > 0 ? true : false;
    if (kindOf() !== 'idle') return pressed > 0 ? true : false;
    if (!io.sendKey(key)) return pressed > 0 ? true : false;
    pressed++;
  }
  return true;
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
  // A bad option stops the parser before `--json` is read when it comes first, and the
  // structured refusal is still the one the caller asked for.
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['session', 'file', 'client', 'key', 'team', 'approval'], ['dry-run', 'wait', 'abandon', 'json', 'request']);
  // The lines plain output writes while it works ride on the document as notes under `--json`.
  const jsonNotes: string[] = [];
  const collect = (text: string): void => {
    for (const line of text.split('\n')) if (line !== '') jsonNotes.push(line);
  };
  const note = (text: string): void => {
    if (json) collect(text);
    else io.stdout(`${text}\n`);
  };
  const clientProblem = args.error === undefined && args.rest.length === 0 ? clientInvocationProblem(args) : null;
  if (args.error || args.rest.length || clientProblem !== null) {
    refuse(io, json, 'down', {
      id: 'down.invocation',
      message: args.error ?? (args.rest.length ? `unexpected "${args.rest[0]}"` : clientProblem!),
      repair: null,
      usage: USAGE,
    });
    // exit: down.invocation
    return 2;
  }
  // The client form: a down grant the owner signed for ONE team at ONE folder, proven by the client's
  // own key. It is verified whole here, before anything else is read, and then the run is the grant's
  // folder alone — the owner's own stop of the whole team, with no terminal and no prompt. It is never
  // wider than its grant: another team, another folder, a seat's `--abandon` and every flag that aims
  // elsewhere are refused above or by the verification. Every other caller goes through the ordinary
  // gates below, unchanged.
  let clientDown: { grant: ClientUpGrantRecord; signature: string; requestId: string } | null = null;
  // The one refusal of the client form, at every site: a refusal for a client the key identified goes
  // on the team's own log, where the owner reads what ran (never on a dry run, which decides nothing);
  // a grant that did not verify identifies no one and writes nothing.
  const clientRefusedFor = (why: string, named: ClientUpGrantRecord | null, at: Date): number => {
    if (!args.flags.has('dry-run') && named !== null && existsSync(join(named.up.root, '.agents'))) {
      logLine(join(named.up.root, '.agents'), 'down', `client:${named.clientId}`, `client-down-refused: grant ${named.grantId}: ${why}`, at);
    }
    refuse(io, json, 'down', { id: 'down.client-refused', message: plainText(why), repair: null });
    // exit: down.client-refused
    return 1;
  };
  if (args.values.client !== undefined) {
    if (!json) io.stderr(`${KEY_ISOLATION_LINE}\n`);
    const clientNow = sources.now();
    const verified = verifyClientUp({
      home: sources.home ?? homedir(),
      grantFile: resolve(io.cwd, args.values.client),
      keyFile: resolve(io.cwd, args.values.key!),
      cwd: io.cwd,
      ...(args.values.team !== undefined ? { team: args.values.team } : {}),
      now: clientNow,
      op: 'down',

      io,    });
    if (!verified.ok) return clientRefusedFor(verified.why, verified.identified, clientNow);
    clientDown = { grant: verified.grant, signature: verified.signature, requestId: verified.requestId };
    // The folder is the grant's, whatever the caller's: from here every read is of that team.
    io = { ...io, cwd: verified.root };
    if (!json) io.stderr(`client grant ${verified.grant.grantId}: ${verified.grant.clientId} for team ${verified.grant.up.project} at ${verified.root}, ${expiryPhrase(verified.grant.expires)}\n`);
  }
  const dry = args.flags.has('dry-run');
  // The owner-seat door, for a stop that is not a client grant. `--request` records the stop and
  // returns; `--approval` and an always rule admit it, so the owner never has to be at a terminal.
  // A leads seat on its own pane is admitted by the gate below, as before.
  const seatSources = { ...(sources.home !== undefined ? { home: sources.home } : {}), now: sources.now, ...(sources.ownerSeatStore ? { ownerSeatStore: sources.ownerSeatStore } : {}) };
  let seatApproved = false;
  if (clientDown === null && (args.flags.has('request') || args.values.approval !== undefined)) {
    const seat = ownerSeatStep('down', 'team-down', argv, { request: args.flags.has('request'), approval: args.values.approval, dry, json }, io, seatSources);
    if (seat.kind === 'requested') {
      // exit: down.approval-requested
      return 0;
    }
    if (seat.kind === 'refused') {
      // exit: down.approval-refused
      return 1;
    }
    seatApproved = seat.kind === 'admitted';
  }
  if (clientDown === null && !seatApproved && !isOwner(walkCaller(io))) {
    seatApproved = ownerSeatRuleAdmits('team-down', io.cwd, dry, seatSources);
  }
  // No create-grant admits a run with no terminal: the record matches the caller's own registry
  // record, and a caller outside herdr has none. This sentence is answered before any file is
  // read, as `init` asks it; the route names who may run it, so the sentence does not send every
  // reader to the owner. An owner-seat answer has already admitted this run.
  const detached = clientDown !== null || seatApproved ? undefined : detachedRefusal(walkCaller(io), { who: 'the owner or a `leads` seat', where: 'a terminal outside herdr or its own pane' });
  if (detached !== undefined) {
    refuse(io, json, 'down', { id: 'down.detached', message: detached, repair: null });
    // exit: down.detached
    return 1;
  }
  // Dev mode is resolved from the run's file below, once its chain is known.
  const refusals: DownRefusal[] = [];

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
  // The warning line a dev-mode approval fold owed, once the gate passed: the gate's own
  // sentence naming the live file. It is printed and logged beside the placement fold below.
  let delegateApproval: string | null = null;
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
    // The delegated run stops the file the gate judges, so dev mode is resolved from that same
    // live file: the fold and the run's own admission then read one chain. The run's own
    // resolution below reads the same file (a non-owner with delegates acts on it), so the two
    // verdicts agree.
    const devHere = resolveDevMode('down', io, {
      ...(sources.home !== undefined ? { home: sources.home } : {}),
      team: file.team,
      root: file.root,
      now: sources.now(),
    });
    verdict = gate({
      command: 'down',
      team: file.team,
      root: file.root,
      dir: file.dir,
      flags,
      io: { env: io.env, stdinIsTTY: io.stdinIsTTY, caller: io.caller, callerSources: io.callerSources },
      ...(sources.delegate ? { sources: sources.delegate } : {}),
      // Dev mode folds the delegation's approval precondition, and the verdict carries the
      // warning naming the live file; the stop then goes on as a delegated one.
      dev: devHere,
      file: file.path,
    });
    if (verdict.kind === 'passed') {
      granted = verdict.pane;
      if (verdict.devApproval !== undefined) delegateApproval = verdict.devApproval;
    } else if (verdict.id === 'down.delegate-command' || verdict.id === 'down.delegate-flag') placed = true;
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
  const fileRefusal = seatApproved ? undefined : fileOwnerRefusal(io, args.values.file);
  if (fileRefusal !== undefined) {
    const said = decide();
    if (said?.kind === 'refused' && placed) {
      refusals.push({ id: said.id, message: said.text });
    } else {
      refuse(io, json, 'down', { id: 'down.file-owner', message: fileRefusal, repair: null });
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
  if (args.values.session !== undefined && !branching() && !seatApproved) {
    const walked = walkCaller(io);
    if (!isOwner(walked)) {
      const said = decide();
      if (said?.kind === 'refused' && placed) {
        refusals.push({ id: said.id, message: said.text });
      } else {
        refuse(io, json, 'down', { id: 'down.session-owner', message: sessionOwnerRefusal(walked), repair: null });
        // exit: down.session-owner
        return 1;
      }
    }
  }
  // Both flags are dropped once the branch has decided the run: the gate has refused them, and a
  // delegated run judges the file's own session, as any delegated `down` does.
  const launched = args.values.file || clientDown !== null ? undefined : launchedTeamFile(io, sources.home);
  const file = branching() ? undefined : (args.values.file ?? launched);
  const sessionFlag = branching() ? undefined : args.values.session;

  // The run's file. The load is today's: `currentTeam` falls back to the last copy that
  // validated. Remembering is off until the caller rule and `--abandon` have answered, below.
  // A caller that is not the owner may be a delegate's, and a delegated run reads the live file
  // directly — never `currentTeam`, never `last_valid` — so a live file that carries `delegates`
  // is the run's file, whether the gate passes that caller or refuses it. A file that does not
  // load carries no delegate: today's path, with today's fallback and today's words, decides.
  const owner = isOwner(walkCaller(io)) || seatApproved;
  const liveNow = owner ? undefined : liveFile();
  const liveCurrent: Current | undefined =
    liveNow !== undefined && liveNow.team.delegates !== null
      ? { ok: true, team: liveNow.team, root: liveNow.root, dir: liveNow.dir, path: liveNow.path, warnings: [] }
      : undefined;
  // One clock reading serves the run's own file and the policy chain read beside it; the
  // remembering below keeps its own, later reading.
  const loadedAt = liveCurrent === undefined ? sources.now() : undefined;
  const current: Current = liveCurrent ?? currentTeam(io.cwd, file, loadedAt!, sources.home, false);
  if (!current.ok) {
    const said = current.errors.map((problem) => `${problem.line ? `line ${problem.line}: ` : ''}${problem.message}`);
    const id = current.errors.some((problem) => problem.message.startsWith('not inside a git repository'))
      ? 'down.not-a-repo'
      : current.errors.some((problem) => problem.line > 0) ? 'down.file-invalid' : 'down.file';
    if (json) refuse(io, json, 'down', { id, message: said.join('; '), repair: null });
    else for (const line of said) io.stderr(`team down: ${line}\n`);
    // exit: down.not-a-repo
    // exit: down.file
    // exit: down.file-invalid
    return 2;
  }
  if (current.notice) note(current.notice);
  const { team, dir, root } = current;
  // Dev mode, from the file this run stops: a `dev-mode` value anywhere in the caller's chain
  // governs, and `TEAMCLI_DEV_MODE` is then ignored; before any such value, the variable set to
  // exactly `1` keeps its behaviour. The caller line and the approval are folded below, and the
  // delegate and grant gates' approval folds carry their own lines.
  const devNow = loadedAt ?? sources.now();
  const dev = resolveDevMode('down', io, {
    ...(sources.home !== undefined ? { home: sources.home } : {}),
    team,
    root,
    now: devNow,
  });
  // With no `--session` the session this run judges and stops is the caller's own placement: the
  // file's session first, then a session the state records this caller's pane in (`team up
  // --session <other>`) — never one a non-owner chose, and the plan then names that session. The
  // flag keeps aiming the run, for the owner alone. A delegated run stops the whole team, in the
  // session the file names: its caller is a pane outside that team, and no placement of it may
  // move the run onto another session — its own included.
  // The gate is the map's (`gateVerdict`), read in the verdict shape the branches below already
  // speak: owner or `leads` for this team, decided from records — the registry roster's line
  // where it stands, the file's own declaration where the registry holds no record of the team,
  // and the standing's pane proof for a seat the map admits.
  const verdictOf = (who: Caller, at: SeatStanding): ReturnType<typeof gateVerdict> =>
    gateVerdict(who, team, root, sources.home ?? homedir(), 'down', at, sources.now);
  const judged = branching()
    ? { caller: callerOf(io), session: team.session }
    : sessionFlag !== undefined
      ? { caller: callerOf(io, sessionFlag === 'default' ? undefined : sessionFlag), session: sessionFlag }
      : judgeCallerIn(io, dir, team, verdictOf);
  let caller = judged.caller;
  let session = judged.session;

  // The ordinary caller rule, for the session the caller's own placement named. It is what decides
  // whether the gate is asked at all: a caller the rule accepts never enters the delegate branch,
  // and a run it accepts keeps its own session, its own plan and today's bytes exactly.
  const rule = verdictOf(caller, standingOf(dir, session, caller));
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
    if (said?.kind === 'refused' && placed) refusals.push({ id: said.id, message: said.text });
    if (branching()) {
      caller = callerOf(io);
      session = team.session;
    }
  }
  // A create-grant the record holds for this loaded root is the run's admission, the same one
  // `init` and `up` consult: the team this run would stop is under the granted paths. Asked only
  // where the ordinary rule has just refused — the record is a second door, never a second gate —
  // and only when one exists, so an owner's run reads no clock for it. A granted run stops the
  // whole team, exactly as the owner's own `down` does: no seat of it is the caller.
  // A client's own down grant is the same kind of second door, and the verification above already
  // judged it whole: it admits whatever the caller is, for the grant's folder alone.
  const createGranted = clientDown !== null || (!branching() && rule.kind !== 'ok'
    && readEntityCreateGrants(sources.home ?? homedir()).length > 0
    && entityGrantAdmits(root, io, { home: sources.home, now: sources.now(), cwd: io.cwd }));

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
  let grantRefusal: DownRefusal | undefined;
  // The approval line a dev-mode grant fold owed: printed and logged with the placement fold.
  let grantApproval: string | null = null;
  if (!branching() && rule.kind === 'ok' && caller.kind === 'seat' && caller.name === team.orchestrator && team.grant) {
    const said = (sources.grantGate ?? grantGate)({ act: 'down', io, home: sources.home, dev });
    if (said.kind === 'passed') {
      grantSeat = said.grant.seat;
      if (said.devApproval !== undefined) grantApproval = said.devApproval;
    } else {
      grantRefusal = {
        id: said.id === 'grant.scope' ? 'down.grant-scope' : 'down.grant-approval',
        message: said.text,
      };
    }
  }

  // A caller the create-grant admits is not a refused caller: the run remembers its file exactly
  // as `up`'s admitted runs do.
  const callerRefused = (rule.kind !== 'ok' && !branching() && !createGranted) || grantRefusal !== undefined;
  const abandonRefused = args.flags.has('abandon') && granted === undefined && !callerOwns(caller) && verdict === undefined;
  const mayRemember = !callerRefused && !abandonRefused && !dry && current.path !== undefined;
  const remember = (): void => {
    if (mayRemember && current.path !== undefined) rememberCurrent(current.dir, current.path, sources.now());
  };
  // The registry says the team is stopped once its session is, in the run an allowed caller made:
  // never a dry run, never a refused caller, and never a session other than the one the registry
  // addresses the team in. That is the session the last launch recorded (`up --session x` records
  // `x`), the file's own while the team has no record. The record keeps the session the run
  // acted on. The registry is the user-level home the run was given; a run given none leaves it alone.
  const noteStopped = (): void => {
    if (dry || callerRefused || abandonRefused || sources.home === undefined) return;
    let addressed = team.session;
    try {
      addressed = getTeam(sources.home, teamIdOf(root))?.session ?? team.session;
    } catch {
      // A registry that cannot be read is said by the write below, which reads it again.
    }
    if (session !== addressed) return;
    const unrecorded = noteTeam(
      sources.home,
      root,
      // The run notes the session it stopped; the file's own session keeps the same lobby.
      { ...team, session, aliasSession: team.session },
      'stopped',
      describeCaller(caller),
    );
    if (unrecorded) {
      if (json) collect(unrecorded);
      else io.stderr(`team down: ${unrecorded}\n`);
    }
  };
  // A session found already stopped has no agent left in it: the registry's agents that were
  // launched there are stopped, with their panes cleared. A seat closed by the run below is
  // ended one by one as it is dropped, so a seat left running is never marked stopped.
  const noteSessionEmpty = (): void => {
    if (dry || callerRefused || abandonRefused || sources.home === undefined) return;
    const unrecorded = registerSessionEnd({ home: sources.home, team, root, by: describeCaller(caller), session });
    if (unrecorded) {
      if (json) collect(unrecorded.note);
      else io.stderr(`team down: ${unrecorded.note}\n`);
    }
  };

  // The client's grant is read once more under the grant lock, immediately before the run's first
  // effect: a revocation appended since the check at the top stops this run here, and a run that
  // passes writes its audit line while it still holds the lock, so one of the two is always first.
  // Returns the reason the grant no longer stands, or null.
  const authorizeClientDown = (logDir: string): string | null => {
    const held = clientDown;
    if (held === null) return null;
    const at = sources.now();
    let standing: string | null;
    try {
      standing = withClientGrantLock(sources.home ?? homedir(), () => {
        const still = activeClientUpGrant(sources.home ?? homedir(), { grant: held.grant, signature: held.signature }, at);
        if (!still.ok) return still.why;
        logLine(logDir, 'down', `client:${held.grant.clientId}`, `client-down-authorized: grant ${held.grant.grantId} client ${held.grant.clientId} team ${held.grant.up.project} root ${held.grant.up.root} request ${held.requestId}`, at);
        return null;
      });
    } catch {
      standing = 'the client grant lock could not be taken';
    }
    return standing;
  };
  const clientRefusedAt = (why: string): number => clientRefusedFor(why, clientDown?.grant ?? null, sources.now());

  const running = sources.sessionRunning(session);
  if (running === null) {
    refuse(io, json, 'down', {
      id: 'down.herdr',
      message: "herdr doesn't answer; is it installed and running?",
      repair: null,
    });
    remember();
    // exit: down.herdr
    return 2;
  }
  if (!running && grantRefusal === undefined) {
    // The grant is read under its lock and the run is logged: this idle run still writes the
    // registry's `stopped`, so it is as much the client's as a stop that closes panes.
    if (clientDown !== null && !dry) {
      const stood = authorizeClientDown(dir);
      if (stood !== null) return clientRefusedAt(stood);
    }
    remember();
    noteStopped();
    noteSessionEmpty();
    if (json) {
      writeJson(io, 'team.down', {
        format: 1 as const,
        dry_run: dry,
        status: dry ? 'dry-run' : 'idle',
        action_summary: dry ? 'dry run: nothing was run' : `session ${session} is not running: nothing to stop`,
        project: team.project,
        session,
        seats: [],
        ...(dry ? { notes: [`session ${session} is not running: nothing to stop`, ...jsonNotes] } : { notes: jsonNotes }),
      });
    } else {
      io.stdout(`session ${session} is not running: nothing to stop${dry ? '\ndry run: nothing was run' : ''}\n`);
    }
    // exit: down.idle
    return 0;
  }
  let agents = running ? sources.agents(session) : [];
  if (agents === null) {
    refuse(io, json, 'down', {
      id: 'down.agents',
      message: `the agents of session ${session} can't be read`,
      repair: null,
    });
    remember();
    // exit: down.agents
    return 2;
  }

  if (grantRefusal !== undefined) refusals.push(grantRefusal);
  // A create-grant held for this root is the run's admission: the ordinary rule's sentence is
  // then not a refusal, and the delegate gate — which the ordinary refusal alone summons — has
  // nothing to replace. Every check below (the approval, the budgets, the machine gate) still
  // reads exactly as it does for the owner.
  if (rule.kind !== 'ok' && !branching() && !createGranted && !seatApproved) {
    // The ordinary rule has refused, and only now is the gate asked. With no delegate in the live
    // file nothing changes. A refusal takes the ordinary refusal's place, in the same place and at
    // the same exit statuses: a real run stops on it, a dry run says what it would refuse and
    // prints the plan. A pass lets the run go on as the delegate's.
    const said = decide();
    if (said === undefined) {
      if (rule.kind === 'no-pane') {
        refusals.push({ id: 'down.no-pane', message: noPaneRefusal(rule.name) });
      } else if (rule.kind === 'another-pane') {
        refusals.push({ id: 'down.another-pane', message: anotherPaneRefusal(rule.name, rule.recordedPane) });
      } else {
        refusals.push({
          id: 'down.caller',
          message: `only the owner or \`leads\` stops the team; this call is ${describeCaller(caller)}${devModeExpiryNote(dev)}`,
        });
      }
    } else if (said.kind === 'refused') {
      refusals.push({ id: said.id, message: said.text });
    }
  }
  // A delegated run never abandons: `--abandon` is the gate's refusal, and the plan holds every
  // seat, orchestrator and operator included, exactly as the owner's own `down` does. A gate that
  // has answered is the run's only refusal: today's abandon line stays out of the way of its own.
  const abandon = args.flags.has('abandon') && granted === undefined;
  let abandonLifted = false;
  if (abandon && !callerOwns(caller) && !seatApproved && verdict === undefined) {
    // The owner's dev-mode admission for exactly this gate: a placed lead or
    // orchestrator continues with the warning; every other caller keeps the refusal.
    const lift = devModeOwnerLiftAtCwd(io, {
      command: 'down',
      refusal: 'only the owner abandons a team, from a terminal outside herdr',
      ...(sources.home !== undefined ? { home: sources.home } : {}),
      now: sources.now(),
    });
    if (lift === null || !lift.lifted) {
      refusals.push({
        id: 'down.abandon',
        message: 'only the owner abandons a team, from a terminal outside herdr',
      });
    } else {
      abandonLifted = true;
      io.stderr(`${lift.warning}\n`);
    }
  }
  const branchRun = branching();

  // Dev mode says the caller-placement line once, as a warning, and the stop continues.
  // Every other refusal stays a refusal. Unset, the list is unchanged. Nothing here writes
  // an approval, a key, or a grant.
  const placement = `only the owner or \`leads\` stops the team; this call is ${describeCaller(caller)}`;
  const warnings: string[] = [];
  if (dev.on) {
    let warning = '';
    const kept: DownRefusal[] = [];
    for (const line of refusals) {
      if (line.message === placement) warning = line.message;
      else kept.push(line);
    }
    if (warning) {
      refusals.splice(0, refusals.length, ...kept);
      // The variable's run prints the one override sentence every lifecycle command prints, its
      // tail included; a run a governing policy admits names the level that set it instead.
      warning = dev.by === 'env'
        ? devModeCallerGate(dev, warning) ?? warning
        : `warning: ${warning}${devModeLevelNote(dev)}`;
      warnings.push(warning);
    }
    // The approval a grant or delegate gate folded names the live file that counted; the
    // delegated line came from the gate when it was asked, the grant's from just above.
    if (delegateApproval !== null) warnings.push(delegateApproval);
    if (grantApproval !== null) warnings.push(grantApproval);
    // The audit line each fold owes: written where the gate is used, on a real run, whether a
    // later refusal stops the stop or the stop goes on. A dry run decides nothing and logs none.
    if (!dry) for (const line of warnings) logDevMode(dir, 'down', describeCaller(caller), line, devNow);
  }
  // The configuration lines the run owes once: the variable ignored under a governing policy,
  // and a policy source that would not load. A dry run writes none.
  if (!dry) logDevModeState(dir, 'down', describeCaller(caller), dev, devNow);

  const state = readState(dir).sessions[session];
  const home = sources.home ?? homedir();
  let acting = team;
  if (refusals.length === 0) {
    const standing = sources.standing?.(root) ?? approvalStanding(root, home);
    if (standing.kind !== 'verified' && standing.kind !== 'none') {
      // The same approval a grant or delegate gate folded above: while dev mode is on, the live
      // file this run stops counts as approved, the warning names it, and the caller goes to
      // the audit log. Off, today's refusal.
      const said = notInForce(standing);
      const folded = devModeFileApproval(dev, said, current.path ?? 'team config');
      if (folded === null) {
        for (const line of warnings) {
          if (json) collect(line);
          else io.stderr(`team down: ${line}\n`);
        }
        refuse(io, json, 'down', {
          id: standing.kind === 'legacy' ? 'down.legacy' : 'down.refused',
          message: notInForce(standing),
          repair: null,
        });
        // exit: down.never-approved
        // exit: down.legacy
        // exit: down.refused
        return 1;
      }
      warnings.push(folded);
      if (!dry) logDevMode(dir, 'down', describeCaller(caller), folded, devNow);
    }
    // The live file names who stops. A stored copy is not a second roster.
    acting = team;
  }
  // The stop list is the copy in force. A name that copy carries, listed once, is that seat.
  // Any other agent — no name, or a name the copy does not carry — is this team's only when
  // one seat records that pane and that workspace, and, when the record holds a launched
  // process, that process is still the one in the pane. The name is not that match. A caller
  // already refused keeps the live file's names, so the dry-run plan is that refusal's.
  const known = new Set(acting.seats.map((seat) => seat.name));
  const cliOf = new Map(acting.seats.map((seat) => [seat.name, seat.cli]));
  const cliFor = (name: string): string => cliOf.get(name) ?? 'unknown';
  // A seat the file marks as a human's holds no CLI to ask: the plan leaves it running.
  const humanOf = new Set(acting.seats.filter((seat) => seat.human).map((seat) => seat.name));

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
          cli,
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
          ...(humanOf.has(claim.name) ? { human: true as const } : {}),
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
            ...(humanOf.has(claim.name) ? { human: true as const } : {}),
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
      cli,
    });
    // An unsent box that holds exactly the profile's exit text — an earlier run typed it and
    // never confirmed it — is named as such either way: the profile's one clearing key decides
    // whether this run empties it and asks again (the plan's run step) or the owner does (its
    // skip line). Anything else unsent keeps the ordinary unsent line.
    const exitInBox = reading === 'unsent' && profile !== null && profile.exit !== null
      && boxHoldsText(cli, profile.exit, sources.screenText(session, agent.pane, cli), { cwd: liveCwd ?? undefined, home: sources.home });
    seats.push({
      name,
      cli,
      pane: agent.pane,
      workspace: agent.workspace,
      state: reading,
      ...(humanOf.has(name) ? { human: true as const } : {}),
      ...(exitInBox ? { exitInBox: true } : {}),
      ...(shown.kind === 'exit question' ? { atExitQuestion: true } : {}),
    });
  }

  const watch = state?.watch;
  // Only a pid can be killed; a record whose pane's first pass has not written one yet is left
  // as it is, as a watch whose process is not alive is.
  const watchAlive = Boolean(watch && watch.pid !== undefined && sources.alive(watch.pid));
  if (watchAlive && refusals.length === 0) notes.push('watch: its pid is only in the state; left running');
  if (json) for (const line of notes) jsonNotes.push(line);
  else for (const line of notes) io.stdout(`${line}\n`);
  const plan = downPlan({
    session,
    seats,
    extra,
    watchPid: refusals.length === 0 ? null : watchAlive && watch ? watch.pid ?? null : null,
    // A delegated run stops the whole team: no seat is kept back, the orchestrator and the
    // operator included. The delegate sits outside the session, so it never stops itself.
    keep: !branchRun && clientDown === null && caller.kind === 'seat' ? [acting.orchestrator, acting.operator] : [],
    abandon: abandon && (callerOwns(caller) || abandonLifted),
    // A free seat is still asked. When that ask cannot be typed or confirmed, the owner's
    // `--abandon` closes it in this same run; every other run names that close and leaves it.
    closeUnasked: abandon && (callerOwns(caller) || abandonLifted),
    unasked: 'team down --abandon closes it',
  });

  const seatNames = [...new Set(seats.map((seat) => seat.name))];
  if (dry && !json) {
    // A refusal leaves through the real run's return below, so the status and the exit id
    // are that refusal's. The words stay the dry run's, and nothing is written.
    for (const line of warnings) io.stdout(`! ${line}\n`);
    for (const refusal of refusals) io.stdout(`! down would refuse: ${refusal.message}\n`);
    io.stdout(formatPlan(plan));
  }
  if (refusals.length) {
    const first = refusals[0] as DownRefusal;
    if (json) {
      refuse(io, json, 'down', { id: first.id, message: first.message, repair: first.repair ?? null });
    } else if (!dry) {
      for (const line of warnings) io.stderr(`team down: ${line}\n`);
      for (const refusal of refusals) io.stderr(`team down: ${refusal.message}\n`);
    }
    // exit: down.caller
    // exit: down.abandon
    // exit: down.no-pane
    // exit: down.another-pane
    // exit: down.delegate
    // exit: down.delegate-approval
    // exit: down.delegate-evidence
    // exit: down.delegate-placement
    // exit: down.delegate-command
    // exit: down.delegate-flag
    // exit: down.grant-approval
    // exit: down.grant-scope
    return 1;
  }
  if (!dry) {
    for (const line of warnings) {
      if (json) collect(line);
      else io.stderr(`team down: ${line}\n`);
    }
  }
  if (dry) {
    if (json) {
      const steps: PlanStep[] = [
        ...warnings.map((line) => ({ step: 'warning' as const, detail: line, prefix: '!' as const })),
        ...planStepsOf(plan),
      ];
      writeJson(io, 'team.down', {
        format: 1 as const,
        dry_run: true,
        status: 'dry-run',
        action_summary: 'dry run: nothing was run',
        project: team.project,
        session,
        seats: seatNames,
        plan: steps,
        notes: jsonNotes,
      });
    }
    // exit: down.dry-run
    return 0;
  }
  const launch = sources.launch;
  if (!launch) {
    refuse(io, json, 'down', {
      id: 'down.no-launch',
      message: 'this call has no way to reach herdr',
      repair: null,
    });
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
    refuse(io, json, 'down', {
      id: 'down.run-lock',
      message: runLockText(runLock.held, session, dir),
      repair: null,
    });
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
    // The client's grant, re-read under its lock, then its audit line, before the first close.
    if (clientDown !== null) {
      const stood = authorizeClientDown(dir);
      if (stood !== null) return clientRefusedAt(stood);
    }

    const now = () => sources.now();
    // The lines the plan's own steps print as they run: the last one is the run's outcome.
    const said: string[] = [];
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
      async pressKeys(sessionName, pane, cli, keys) {
        // As `typeLine`: the whole key sequence — the caller check, the fresh idle reading, the
        // key itself — is `keyExit`'s, shared with `remove`.
        return keyExit({
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
        }, cli, keys);
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
      // The departure wait of a profile herdr cannot report reads the pane's own process: herdr
      // never lists such a pane, so its agent list would say "gone" before the key was pressed.
      foreground: (sessionName, pane) => sources.foreground(sessionName, pane),
      sleep: sources.sleep ?? launch.sleep,
      now: () => now().getTime(),
      allow: () => null,
      record() {},
      running() {},
      drop(name) {
        // The endpoint a managed launch recorded is the launch's, not the pane's: it is stopped
        // before the record that names it goes. An endpoint whose process cannot be proven is
        // left alone — its pid is never signalled on trust alone — and the refusal is said.
        const endpoint = sources.codexEndpoint?.stop({ dir, session, seat: name });
        if (endpoint !== undefined && !endpoint.stopped && endpoint.why !== undefined) {
          io.stderr(`team down: ${name}: ${endpoint.why}\n`);
        }
        let pane: string | undefined;
        let temporaryDropped = false;
        updateState(dir, (file) => {
          const current = (file.sessions[session] ??= emptySession());
          const prior = current.seats[name];
          pane = prior?.pane;
          temporaryDropped = Boolean(prior?.temporary);
          if (prior?.id && !prior.temporary) {
            (current.retained_seats ??= {})[name] = {
              id: prior.id,
              ...(prior.last_active ? { last_active: prior.last_active } : {}),
            };
          }
          delete current.seats[name];
        });
        // The seat's own hook reading goes with its record: a `working` left by a turn the stop
        // interrupted must not answer for a seat that is no longer running.
        resetCliHookState(dir, session, [name]);
        if (pane) forgetLaunchedPane(sources.home ?? homedir(), pane, session);
        // The registry: the seat's agent ends with its pane. A temporary seat is gone for good.
        if (sources.home !== undefined) {
          const ended = registerEnd(
            { home: sources.home, team, root, by: describeCaller(caller), session },
            name,
            temporaryDropped ? 'retired' : 'stopped',
          );
          if (ended) {
            if (json) collect(ended.note);
            else io.stderr(`team down: ${ended.note}\n`);
          }
        }
      },
      say: (line) => {
        said.push(line.replace(/\n$/, ''));
        if (!json) io.stdout(line);
      },
      log: (who, what) => logLine(dir, 'down', describeCaller(caller), `${who}: ${what}`, now()),
    };
    const report = await executePlan(plan, session, host);
    if (!report.held) noteStopped();
    if (json) {
      const lines = said.filter((line) => line !== '');
      const summary = lines.at(-1) ?? `session ${session}: stopped`;
      const notes = [...jsonNotes, ...lines.slice(0, -1)];
      if (report.held) {
        refuse(io, true, 'down', { id: 'down.held', message: summary, repair: null });
      } else {
        writeJson(io, 'team.down', {
          format: 1 as const,
          dry_run: false,
          status: 'stopped',
          action_summary: summary,
          project: team.project,
          session,
          seats: seatNames,
          notes,
        });
      }
    }
    // exit: down.stopped
    // exit: down.held
    return report.held ? 1 : 0;
  } finally {
    runLock.release();
  }
}

/** A team file read directly, with the project root and the `.agents` directory beside it. */
type LiveFile = { team: TeamFile; root: string; dir: string; path: string };

/**
 * The live team file, read directly: the copy the delegate gate judges and the copy a delegated
 * run acts on. Never `currentTeam`'s remembered copy, never `last_valid` — a file that does not
 * load carries no delegate, and the ordinary path keeps its own fallback and its own words.
 */
function liveTeam(io: Io, home?: string): LiveFile | undefined {
  const loaded = readTeamConfig(io.cwd, home ? { home } : {});
  if (!loaded.ok) return undefined;
  return { team: loaded.team, root: loaded.root, dir: dirname(loaded.path), path: loaded.path };
}

function callerOwns(caller: Caller): boolean {
  return caller.kind === 'owner';
}
