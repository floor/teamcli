import { isAbsolute, join, resolve } from 'node:path';
import { DISPLAY_AGENT_SOURCE } from '../herdr.ts';
import { selfRunner } from '../mcp/register.ts';
import { channelLobbyFolder, claudeChannelSeat, type ChannelLaunchScope } from '../mcp/launch-config.ts';
import { lobbyOf } from '../lobby/recorded.ts';
import { codexDaemonForSeat, type CodexDaemonValue } from '../policy/codex-daemon.ts';
import { sidebarRowsWord } from '../policy/types.ts';
import type { SidebarIndicator } from '../settings/sidebar-policy.ts';
import { profileFor } from '../profiles/index.ts';
import type { Discovery, ResolveContext } from '../launchers/resolve.ts';
import { cliWordList, launchCommandOrRefusal, pinnedRecordLine, resumeCarry, shellQuote } from '../profiles/profile.ts';
import { resolvedCommand } from './resolve-flag.ts';
import type { LaunchedIdentity } from './identity.ts';
import type { FinalRecord } from './progress.ts';
import { cliWatcher, type CliWatcher } from './cli-hook.ts';
import { shellScriptWordOf } from './cli-scope.ts';
import { grokSandboxOf, type GrokSandbox } from './grok-sandbox.ts';
import { launchedCliBinary } from './line.ts';
import type { WaitingRecord } from '../state.ts';
import type { TeamFile } from '../file/types.ts';

/** The pace the idle wait polls a pane at — and the one a pause re-reads an opened pane at, and
 *  reads a trust prompt's terminal with, when `team answer` may be racing it. */
export const IDLE_POLL_MS = 2000;

/** How long a replacement waits for a signalled watch to be confirmed gone. A watch stopped by a
 *  signal ends its wait and returns well inside this; a process still alive at the deadline is
 *  held, never treated as stopped. */
export const WATCH_STOP_SECONDS = 10;

/**
 * What running a step does. The printed command stays in `argv`; this is how the live command
 * performs that same step, so a dry run and a real run share one plan.
 */
export type Op =
  | { do: 'server'; session: string }
  | { do: 'wait-session'; session: string; seconds: number }
  /** Writes the terminal host's sidebar layout before any seat starts: backup, one-pass splice
   *  of both keys, validate through the host's own `config check`, roll back on refusal. A
   *  refusal aborts the plan — nothing was started yet — with the reason the splice or the check
   *  gave. Reloads are their own steps (`sidebar-reload`), so one session's refusal is one line. */
  | { do: 'sidebar'; rows: readonly (readonly string[])[]; indicators: SidebarIndicator }
  /** Reloads one already-running session's server onto the layout the `sidebar` write left, and
   *  records it. A refusal names the session and fails nothing else: the file holds the layout,
   *  and check names any session without a record. */
  | { do: 'sidebar-reload'; session: string; rows: readonly (readonly string[])[]; indicators: SidebarIndicator }
  | { do: 'create'; seat: string; label: string; cwd: string; repairLine: string; notice?: string; lobby?: true; watcher?: CliWatcher; channel?: ChannelLaunchScope }
  /** The watchdog's workspace: no seat, so no seat repair either. */
  | { do: 'create'; seat?: undefined; label: string; cwd: string; notice?: string; lobby?: undefined; bus?: true }
  /** `cli` and `cwd` let the launch register the seat's team inbox in its folder before the
   *  command runs (`execute.ts`); `teamFile` is the team file the run read, which the seat's
   *  inbox server resolves the team from when the folder is a lobby. `watcher` is how the seat
   *  will learn a drop is waiting, as this run leaves it; recorded with the launch. Absent only
   *  on a hand-built op: every planned launch names them. */
  | { do: 'launch'; seat: string; label: string; command: string; pane?: string;
      /**
       * The seat's own recorded pane is reused: the command runs there, nothing is created and
       * nothing is closed. The value is the process identity the seat's record holds; the live
       * run reads the pane, its workspace, its process and the agent list again immediately
       * before the launch. Only a pane the workspace still lists, whose own shell is the only
       * process in front and that the host does not name for another seat, is launched in — a
       * pane back at the recorded CLI is the seat's again, and a pane holding anything else
       * leaves the seat out with nothing launched.
       */
      reuse?: LaunchedIdentity;
      /**
       * The workspace the pane sits in: the reused pane's own for a launch that re-uses one
       * (`reuse` above), and the recorded workspace of a seat launched again in its own pane
       * after its bare restored CLI was exited there. Read again with the pane before the
       * launch.
       */
      workspace?: string;
      notice?: string; cli?: string; cwd?: string; teamFile?: string; watcher?: CliWatcher; channel?: ChannelLaunchScope;
      /**
       * The base recipe the seat's record keeps when this run records it: `seat.launch` with the
       * profile's pinned feature words appended, never the expanded command the pane runs (the
       * environment prefix, the unattended flags, the rules line). Set only for a profile that
       * pins features; absent leaves the record path exactly as it was.
       */
      recordLine?: string;
      /**
       * True when the command this step runs carries the seat's rules line: decided here, where
       * the line is given to `launchCommand`, never re-derived from the built command — the line
       * is shell-quoted on it, and a profile with no launch prompt carries none at all. Absent on
       * a hand-built op: no rules ride its launch.
       */
      rulesCarried?: boolean;
      /**
       * This launch starts (or reuses) the managed Codex app-server endpoint recorded on the
       * seat's current presence binding, and attaches the TUI to it with `--remote`. Set only
       * for a Codex seat with the signed `codex-daemon` policy on, a plain Codex launch line,
       * and no `--remote`/`--no-daemon` of the file's own to collide with. The endpoint and the
       * attach are decided at launch time, so the printed line stays the file's own. `dir` is the
       * state folder the endpoint's record is written in, carried by the plan so the launch's
       * host methods take no folder of their own.
       */
      codexEndpoint?: { dir: string };
      /**
       * A Grok seat's sandbox profile, written at launch before the pane's command runs. Set
       * only when this plan named the profile on the line, so a failure can take the same
       * `--sandbox` off again instead of launching a line Grok would refuse.
       */
      grokSandbox?: GrokSandbox;
      /**
       * The command is the declarative launcher's argv and is run as given. The launch does
       * not mint a session, attach an endpoint, or rewrite a sandbox flag onto it.
       */
      resolved?: true }
  /** `why` is the reason the record and the log carry; `detail`, when the reason has a fuller
   *  sentence with a folder in it, is the stderr line said under the record. */
  | { do: 'refuse'; seat: string; why: string; detail?: string }
  /** The run is held with this sentence: nothing is signalled and nothing is started. */
  | { do: 'hold'; text: string }
  /** Waits, bounded, for a signalled watch to be gone. A process still alive at the deadline
   *  holds the run and suppresses the replacement. */
  | { do: 'watch-gone'; pid: number; seconds: number }
  /** A seat's final record, decided by the plan: no profile, already ready. The step's printed
   *  text stays for the dry run; `detail` is the stderr lines said after the record. */
  | {
      do: 'record';
      seat: string;
      record: FinalRecord;
      detail?: string;
      /** A restored seat: the process ids to store, so the next `up` sees `same`. */
      launched?: LaunchedIdentity;
      /** A restored seat the host moved: the pane the record points at now. */
      pane?: string;
      workspace?: string;
      /** The agent session kept beside those pids. */
      agentSession?: string;
      /** This record is a refusal: the run exits 1 even when the stored stage stays ready. */
      held?: boolean;
    }
  | {
      do: 'idle';
      seat: string;
      label: string;
      cli: string;
      /** How this launch leaves the seat watching for drops; recorded with the idle record. */
      watcher?: CliWatcher;
      seconds: number;
      command: string;
      pane?: string;
      workspace?: string;
      notice?: string;
      model?: string;
      version?: string;
      /** The file's effort word for this launch. Absent when the file sets none. */
      effort?: string;
      /** The team file's repair for this seat (`relaunchRepair`, markdown text): what every
       *  refusal of this seat that names a repair prints — for a lead seat, only `team down`
       *  then `team up`, which its file accepts. */
      repairLine: string;
      /** A seat recorded waiting: its idle step re-reads the screen and enters the owner's
       *  prompt (`pause.ts`) — it is never launched or closed from here (§5). */
      waiting?: { record: WaitingRecord; launched?: LaunchedIdentity };
      /** A waiting seat herdr does not name exactly once: left out, nothing launched. */
      resumeGap?: 'none' | 'many';
    }
  | {
      do: 'rename';
      seat: string;
      label: string;
      /** The seat's CLI: its profile's process names tell a pane herdr has not listed yet. */
      cli?: string;
      seconds: number;
      rules: 'option' | 'message' | 'prepend';
      pane?: string;
      /** Sidebar line 2, reported once this rename has named the seat. A failure is one line. */
      displayAgent?: string;
    }
  /** A seat already running, painted from the file without typing into it or launching it again.
   *  Line 1 is the workspace title; line 2 is display_agent. A failed call is one line. */
  | { do: 'relabel'; seat: string; pane: string; workspace: string; title: string; displayAgent: string }
  | { do: 'deliver'; seat: string; label: string; cli: string; rules: string; path: string; line: string; seconds: number; pane?: string; notice?: string;
      /**
       * Whether a launch line for this seat can carry the rules at all: its profile names a
       * launch prompt. False means no launch ever carries them, so the left-out report says that
       * and never advises a restart.
       */
      launchCanCarryRules?: boolean }
  | { do: 'ready'; seat: string; rules: 'option' | 'message' | 'prepend'; notice?: string }
  | {
      do: 'repair';
      seat: string;
      cli: string;
      pane: string;
      workspace: string;
      launched: LaunchedIdentity;
      /** The pane still holds the process team launched, and its model differs from the file.
       *  The close re-reads that difference. `way` is the caller's own way out when the seat
       *  is working and nothing is closed. */
      drift?: { model: string; version: string; way: string };
      /**
       * The declared model or effort differs from the launch record. The close re-reads the
       * pane and closes only at an idle prompt: not while working, and not while the box
       * holds unsent text. `detail` is the audit line's difference.
       */
      reload?: { detail: string };
    }
  /** A seat relaunched in a fresh workspace had a recorded pane the host did not restore. Its
   *  recorded workspace is closed only here, after the seat is ready on its replacement, and only
   *  when a fresh reading still shows that workspace holding the one old pane, bare at its own
   *  shell and not named for another seat. Every other reading — an unreadable pane, one with a
   *  process beside its shell, a name the host gives another seat — leaves the workspace and
   *  says why. */
  | { do: 'close-leftover'; seat: string; pane: string; workspace: string; cli?: string }
  /**
   * A workspace a seat vacated — a stopped seat's record, a record the file no longer declares,
   * or the workspace a host-moved seat left — is closed only from readings taken immediately
   * before the close. It closes when its pane list, its panes' processes, the agent names, the
   * seat records and the screens all say no CLI and no seat is there; anything else leaves it
   * exactly as it is, with the reason said. `replaced` holds the close until the seat's record
   * reads ready on a pane other than `pane` (the one it left). `after: 'bus'` holds a stray Bus
   * workspace until the Bus this run started is up.
   */
  | {
      do: 'sweep';
      workspace: string;
      seat?: string;
      pane?: string;
      cli?: string;
      replaced?: true;
      after?: 'bus';
    }
  /**
   * A restored pane is not the seat's own running form: it runs the bare CLI where the seat's
   * launch line starts a wrapper, or its managed Codex endpoint died with the host. Re-read the
   * host, re-run the same restore proof, then exit the CLI in that same pane — in its recorded
   * workspace, which stays open — and let the steps after this one launch the seat through its
   * own line there. A pane that is working or holds unsent text, or one whose exit does not come
   * back to its shell in time, is left exactly as it is.
   */
  | {
      do: 'relaunch';
      seat: string;
      cli: string;
      pane: string;
      workspace: string;
      /** The launch record's identity: the proof's expected side, re-read before the exit. */
      launched: LaunchedIdentity;
      /** The recorded conversation the relaunch resumes; absent when none is proven. */
      session?: string;
      /** The seat's managed Codex endpoint is recorded but not live. The weak (`cli`) restore
       *  proof is enough here: the pane is exited for the launch's fresh endpoint, not for a
       *  conversation. */
      endpoint?: true;
    }
  /**
   * The host restored the seat's pane and cleared its name. Re-read the host, re-run the same
   * proof, and only then rename the pane back and record the identity it holds now. No typing,
   * no launch, no close, and no `team register` call.
   */
  | {
      do: 'adopt';
      seat: string;
      cli: string;
      pane: string;
      workspace: string;
      /** The pids the plan read; the execute re-reads them and records the live identity. */
      launched: LaunchedIdentity;
      /** The launch's own identity: what the execute's re-run of the proof reads the pane
       *  against. It is never the identity the record takes (that is `launched`). */
      recordedLaunched: LaunchedIdentity;
      /** The recorded conversation the proof named; absent on a declared-CLI proof. */
      session?: string;
      /** Sidebar line 2, painted by the rename's own step (`also`). */
      displayAgent?: string;
    }
  | { do: 'watch'; label: string; command: string; file?: string }
  /** The event bus's pane: `team bus` in its own workspace, recorded like the watch's. A reused
   *  workspace carries its pane and workspace here; the plan made no new workspace for it. */
  | { do: 'bus'; label: string; command: string; pane?: string; workspace?: string }
  | {
      do: 'type';
      seat: string;
      pane: string;
      text: string;
      /** Close the workspace when this ask fails. The owner's `--abandon`. */
      closeUnasked?: boolean;
      workspace?: string;
      /** What the failure line names when the seat is left: `team down --abandon closes it`. */
      unasked?: string;
    }
  | {
      /** A CLI that exits by key: the keys are pressed in order at its idle screen. */
      do: 'keys';
      seat: string;
      pane: string;
      cli: string;
      keys: readonly string[];
      closeUnasked?: boolean;
      workspace?: string;
      unasked?: string;
    }
  | {
      do: 'gone';
      seat: string;
      pane: string;
      /** The seat's CLI, for a profile herdr cannot report: the pane's own process then says
       *  whether it left, since herdr never lists that pane. */
      cli?: string;
      seconds: number;
      closeUnasked?: boolean;
      workspace?: string;
      unasked?: string;
    }
  | {
      do: 'close';
      seat: string;
      workspace: string;
      /** What the seat's line says instead of `stopped`. The bare-shell close names what it
       *  saw in the pane. */
      said?: string;
    }
  | {
      /** `--abandon` only: answer the seat's prompt with the profile's safe keys, after saving
       *  the unsent text it held (when one was read) to `saveTo`. Never fails the seat: the
       *  steps after it ask the exit, and the workspace close follows whatever this did. */
      do: 'answer';
      seat: string;
      pane: string;
      keys: readonly string[];
      saveTo?: string;
      text?: string;
    }
  | { do: 'kill'; pid: number }
  /** The event bus's workspace `team up` recorded: closed, which ends `team bus` in it. */
  | { do: 'close-bus'; workspace: string }
  | { do: 'stop'; session: string };

/** One thing `up` or `down` does, in order. */
export type Step =
  /** A command that is run. `also` is a second command printed with it; the live run performs
   *  that work inside this step's `do`, so it adds no step and no wait of its own. */
  | { kind: 'run'; argv: string[]; also?: string[]; note?: string; do?: Op }
  /** A wait, with its time limit. */
  | { kind: 'wait'; text: string; note?: string; do?: Op }
  /** A seat that is left out, and why. */
  | { kind: 'skip'; text: string; note?: string; do?: Op };

/**
 * The seats a plan starts from the registry's record rather than through a named team file: the
 * launches whose inbox registration resolves the seat by the registry's roster, so the roster
 * must hold the seat's line before the plan runs. A launch that names a team file resolves the
 * seat from that file instead, and the line its own completed launch writes is enough.
 */
export function registryLaunches(steps: readonly Step[]): string[] {
  return steps.flatMap((step) =>
    step.do !== undefined && step.do.do === 'launch' && step.do.teamFile === undefined ? [step.do.seat] : []);
}

export interface UpSeat {
  name: string;
  cli: string;
  launch: string;
  /** The declarative launcher name, when the seat names one. */
  launcher?: string;
  /** The session the resolver is given, including a blank one it refuses. Absent when this
   *  run has no session to give. Ignored unless the launch is asked to resolve a launcher. */
  resolveSession?: string;
  /** Relative to the root. */
  cwd: string;
  label: string;
  /** Sidebar line 2, set on the pane after launch. Absent: the plan does not report one. */
  displayAgent?: string;
  /** The team file's repair for this seat (`relaunchRepair`'s markdown text): every line this
   *  run prints that names a repair prints this one, never a `remove --keep` a lead seat's file
   *  would refuse. */
  repairLine: string;
  stopped: boolean;
  /** The pane is a human's: the file marks it `human: true`. Nothing is launched into it and
   *  no key or line is typed into it; the plan leaves the seat as it is and says why. */
  human?: true;
  /** The seat's rules, as one text: what a launch option embeds and what its file holds. */
  rules: string;
  /**
   * The display name the seat's session carries, when its CLI takes one (Claude Code's `--name`):
   * the seat's readable name under the project's `sender_name` word (`src/send/names.ts`), so a
   * person reading the session sees whom it belongs to. Absent leaves the launch line as the file
   * wrote it.
   */
  sessionName?: string;
  /** The resolved `codex-daemon` policy (`on | off`) for a Codex seat. When omitted, `upPlan`
   *  resolves it from the signed policy chain (`entity -> project -> team -> seat`). */
  codexDaemon?: CodexDaemonValue;
  /** For a seat whose rules travel as a first message: the file its rules are written to and the
   *  one line typed in its pane. Absent when the path can't be typed safely. */
  rulesFile?: { path: string; line: string };
  /** Why the seat's rules can't be delivered; set instead of `rulesFile`. */
  rulesRefusal?: string;
  /** The file's model and version, compared with the screen after the idle wait. */
  model?: string;
  version?: string;
  /** The file's effort word. Absent when the file sets none; the launch record then drops it. */
  effort?: string;
  /** Set when a running session is being resumed. Omitted: launch from the start. */
  stage?: 'launched' | 'named' | 'ready';
  pane?: string;
  workspace?: string;
  /** Herdr already lists an agent in the recorded pane. */
  agentLive?: boolean;
  /**
   * The seat's recorded waiting record: it stopped at a dialog an earlier run could not answer.
   * Its recorded pane and workspace are reused and nothing is created, launched or repaired;
   * the idle step reads the screen fresh and enters the owner's prompt (§5). `waitingLaunched`
   * is the process identity recorded with it, compared with the pane before the prompt.
   */
  waiting?: WaitingRecord;
  waitingLaunched?: LaunchedIdentity;
  /** Set when a waiting seat has no single herdr agent of its name: the resume is left out. */
  resumeGap?: 'none' | 'many';
  /** The waiting seat's recorded pane, when the host no longer lists it. The seat is launched
   *  in a fresh workspace, and this id is the one line that says the old pane was replaced. */
  replacedPane?: string;
  /** The recorded workspace, when the host still lists it. Named on that same line, and not closed. */
  leftWorkspace?: string;
  /**
   * A missing pane's recorded workspace, when the host still lists it: closed after the seat is
   * ready on its replacement, never before. The plan's reading only says the host listed it; the
   * close re-reads the workspace and its old pane immediately before it (`execute.ts`), and any
   * other reading leaves the workspace and says so.
   */
  closeLeftover?: { pane: string; workspace: string };
  /**
   * A workspace this seat vacated and this run's close should sweep: a stopped seat's recorded
   * workspace (nothing replaces the seat), or the workspace a host-moved seat left for another
   * one. The sweep reads the host afresh immediately before the close; `replaced` says the close
   * waits until the seat's own record reads ready on a pane other than `pane`.
   */
  sweep?: { workspace: string; pane?: string; replaced?: true };
  /** The seat works in worktrees: it waits in the lobby until a brief names its worktree. */
  lobby?: boolean;
  /**
   * Set when the seat's pane no longer holds the process team launched: its workspace is closed
   * without input, its launch state cleared, and the seat launched fresh. The plan step that
   * does the closing comes before everything else for this seat. The close itself re-reads the
   * pane immediately before it (`execute.ts`): this plan's reading only decides that the seat
   * is repaired, never that the recorded workspace is still the seat's to close.
   */
  repair?: {
    pane: string;
    workspace: string;
    launched: LaunchedIdentity;
    /** The CLI the seat starts with, for the classifier that guards a replaced pane. */
    cli: string;
    /** The pane still holds the launched process and the model on its screen is not the file's.
     *  The close re-reads the screen; `way` is what the refusal names for this caller. */
    drift?: { way: string };
    /** Set by `team reload`: close only at an idle prompt, then launch the file's line. */
    reload?: { detail: string };
    /** The restored pane is not the seat's running form: the bare CLI where this seat's launch
     *  line starts a wrapper, or a Codex seat whose recorded managed endpoint died with the host.
     *  The step re-proves the pane (strongly, or weakly for a dead endpoint), then exits the CLI
     *  in place; the seat is launched through its own line in that same pane, never adopted. */
    ownLine?: { session?: string; endpoint?: true };
    /**
     * The pane is back at its shell and still the seat's own: the launch runs in it, and nothing
     * is created or closed. The live run re-reads the pane and its workspace immediately before
     * the launch, and a changed reading leaves the seat out with nothing launched.
     */
    reuse?: true;
  };
  /** A ready seat whose model drifted and that this `up` will not close: herdr reports it
   *  working, or its screen shows a running turn. The record stays ready. */
  driftHold?: string;
  /**
   * A drifted seat this run must not close even at a free prompt: a lead seat, or the seat this
   * run is inside. The record stays ready, nothing is closed, and the run exits 1 with this
   * reason.
   */
  driftRefused?: string;
  /**
   * The pane's pids differ and its agent session is the one stored at launch. Nothing is
   * closed. `launched` is the process in the pane now; the record stores it. `pane` and
   * `workspace` are set when the seat came back on another pane: the record moves with it.
   */
  restored?: { launched: LaunchedIdentity; session: string; detail: string; pane?: string; workspace?: string };
  /**
   * The host restored the pane and cleared the seat's name: the place and the process prove the
   * seat without it. `up` renames the pane back and records the identity it holds now — no
   * launch, no typing, no close. `via` is the proof: the recorded conversation, or the declared
   * CLI alone. `sentence` is the proof's own words, for the plan and the audit line.
   */
  adopted?: {
    pane: string;
    workspace: string;
    /** The launch's own identity, for the execute's re-run of the proof. */
    recordedLaunched: LaunchedIdentity;
    launched: LaunchedIdentity;
    session?: string;
    via: 'session' | 'cli';
    sentence: string;
  };
  /** A bound registry policy. Its launch/model are authoritative over the team file. */
  registry?: { launch: string; model: string; version: string; sessionId?: string };
  /**
   * The conversation a relaunch through this seat's line resumes, when the pane itself proved
   * it: the registry binding read against the live agent's session, even where the seat state
   * names no id. Set on a repair the proof decided (a restored seat whose model drifted, or the
   * seat's own process drifted); `registry.sessionId`, where present, stays the first choice.
   */
  resume?: string;
  /**
   * A proven conversation this seat's launch line cannot carry: it names another resume id, or
   * resumes without naming one, or the CLI has no measured resume form. Nothing is closed and
   * nothing is launched; the record stays ready and the run exits 1.
   */
  resumeHold?: string;
  /**
   * The pane holds a program this record cannot tie to the launch. Nothing is closed and
   * the stored process is left as it is.
   */
  sessionDoubt?: string;
  /** The doubt's screen is working: the seat keeps its record, nothing is closed, and the run
   *  reports it as skipped working — not as a refusal. */
  doubtWorking?: boolean;
  /**
   * A seat recorded with no process identity whose pane is a bare shell or another model.
   * This `up` does not close it: the record cannot prove the pane is the seat's. The line
   * names the repair (`--abandon`, then `up`). A ready seat keeps that record; any earlier
   * stage is left out and is not resumed.
   */
  unidentifiedHold?: string;
  /**
   * Set when the seat's own launch line can't run where the seat starts — the program is not
   * there, or a relative path in it resolves from neither the start folder nor the root. The
   * seat is left out before its workspace is made; the other seats go on. The words only: no
   * folder this machine resolved (`launchProblemDetail` holds the full finding for the terminal).
   */
  launchProblem?: string;
  /** The finding in full — the start folder and the path to write — said on stderr under the
   *  seat's record, never logged. Present where `launchProblem` came from a `miss` that names
   *  a folder; absent when the words are the whole finding. */
  launchProblemDetail?: string;
  /**
   * Set when a counted reading is inside the reserve, or the figure is unknown
   * or a first sight. A refusal stops the seat only when this plan would launch it.
   */
  budget?: { kind: 'refuse'; why: string } | { kind: 'unknown'; account: string; text: string };
  /**
   * Set when a ready seat's own state needs a repair this `up` never performs — its process was
   * never recorded (a per-seat `team register` run records it), or it still starts outside the
   * team's lobby (a relaunch moves it). The skip line says it, so the owner is not left with a
   * seat that is "already ready" and stale.
   */
  restartNote?: string;
  /**
   * Set when this `up` is the granted orchestrator's and this seat is that seat. The plan
   * skips it before any close or launch: the run does not relaunch or close the caller's pane.
   */
  grantKeep?: string;
}

/**
 * Whether this plan runs the seat's launch line now: the one test every launch step and every
 * launch refusal uses. A fresh seat launches; so does a recorded seat whose pane the host still
 * lists while no agent is live in it (a launch that stopped before ready) — the line runs again
 * in that pane, with no workspace made. A waiting seat never launches, and a ready or named one
 * is left as it is.
 */
export function launchWillRun(
  seat: Pick<UpSeat, 'stage' | 'pane' | 'agentLive' | 'waiting' | 'repair'>,
): boolean {
  const waiting = seat.waiting;
  // A seat whose own pane came back at its shell runs its line again in that pane: nothing is
  // created beside it and nothing is closed.
  if (!waiting && seat.repair?.reuse === true) return true;
  const fresh = !waiting && (seat.stage === undefined || !seat.pane);
  return !waiting && (fresh || (seat.stage === 'launched' && !seat.agentLive));
}

/**
 * Whether this launch is the seat's own Codex binary under the managed-endpoint policy: the one
 * condition that makes a launch start an app-server and attach to it, and the same condition
 * `team up` reads to decide a restored seat must be launched again for the endpoint it lost.
 * A wrapper's own endpoint is not ours to bind, a `--remote` or `--no-daemon` the file already
 * names is a collision, and a policy that is off or unreadable plans none. The collision is read
 * from the CLI's own decoded words — a flag inside a trailing quoted script is one the CLI will
 * read, a quoted flag name is the flag, and words before it are the shell's — with 0.5.10's
 * whole-line question for a line this version cannot prove.
 */
export function managedCodexLaunch(input: {
  cli: string;
  binary: string;
  codexDaemon: CodexDaemonValue | undefined;
  stateDir: string | undefined;
  launch: string;
  command: string;
}): boolean {
  if (input.cli !== 'codex' || input.codexDaemon !== 'on' || input.stateDir === undefined) return false;
  if (launchedCliBinary(input.launch) !== input.binary) return false;
  const words = cliWordList(input.cli, input.command);
  const names = words === null
    ? (flag: string): boolean => new RegExp(`(^|\\s)${flag}(=|\\s|$)`).test(input.command)
    : (flag: string): boolean => words.some((word) => word === flag || word.startsWith(`${flag}=`));
  return !names('--remote') && !names('--no-daemon');
}

export interface UpInput {
  /** The project root; seats start in it. */
  root: string;
  session: string;
  /** Whether the herdr session is already running, empty. */
  sessionRunning: boolean;
  seats: readonly UpSeat[];
  /** The watch's workspace label: the one `watchLabel` makes for this team. */
  watchLabel: string;
  /** The watch is running, so no second watch is started. */
  watchAlive?: boolean;
  /** A recorded pane watch whose process lives but whose heartbeat is stale, and that the pane
   *  its own record names still shows as that pane's process. The plan stops it, waits for it to
   *  be confirmed gone, and only then starts the replacement; without this the replacement would
   *  be the second watcher on the route. */
  watchPid?: number;
  /** A stale pid that cannot be shown to be the watch — no pane recorded, an unreadable pane, or
   *  another process in it. Nothing is signalled and nothing is started; the run is held with
   *  this sentence. */
  watchHold?: string;
  /** The daemon health cannot say whether a hosted watch owns the route. No pane watch is
   *  started, and the plan says why rather than leaving the reader to guess. */
  watchUnknown?: boolean;
  /** When false, no watch is started: a flagless watch started in `root` would
   *  not read the file this plan was built from. Absent means start one, as before. */
  startWatch?: boolean;
  /** The command the watch's pane runs. Defaults to `team watch`. */
  watchLine?: string;
  /** Start the team's event bus in its own workspace (`bus.autostart`, on unless the file sets
   *  it false). Absent means no bus step at all: a plan built by hand starts none. */
  startBus?: boolean;
  /** The bus answers on its socket, so no second one is started. */
  busAlive?: boolean;
  /** The bus's workspace label: the one `busLabel` makes for this team. */
  busLabel?: string;
  /** The command the bus's pane runs. Defaults to `team bus`. */
  busLine?: string;
  /** A workspace already labelled for the Bus whose pane this run starts the Bus in, instead of
   *  making a second one. Absent: no such workspace was found, and one is made. */
  busReuse?: { workspace: string; pane: string };
  /** Labelled Bus workspaces left over beside the one the Bus lives in. Each is swept after the
   *  Bus is up (or at once when it already answers), never before, and only from a fresh
   *  reading that finds no CLI in it. */
  busStrays?: readonly { workspace: string; pane?: string }[];
  /** The Bus cannot be placed: a sentence the plan says instead of creating a second workspace.
   *  Set when a labelled Bus workspace exists whose pane cannot be chosen safely. */
  busHold?: string;
  /** Records the team file no longer declares: each seat's vacated workspace is swept after the
   *  plan's own steps. A seat this run declares is swept through its own `sweep`. */
  vacated?: readonly { seat: string; workspace: string; pane?: string; cli?: string }[];
  /**
   * The team file a flagless watch in `root` would not read. Recorded for the watch's pane
   * before its command runs. Absent when that flagless watch already reads the file.
   */
  watchFile?: string;
  /**
   * The per-launch settings file each seat's CLI loads for its state hooks, by seat name, when
   * the run installed them. Absent on a dry run that has not written anything yet; a dry run
   * plans the map it would install and prints the line the real run would type.
   */
  cliHooks?: Readonly<Record<string, string>>;
  /**
   * The runtime epoch each seat's general brief was delivered under, by seat name, when this run
   * wrote a claim. A launch-line inbox route names it to the server, so the server serves only
   * that delivery. Absent on a dry run, and for a seat this run delivered no brief to.
   */
  briefEpochs?: Readonly<Record<string, string>>;
  /**
   * The team file this run read and validated, as its absolute path. A seat's folder may be a
   * lobby with no team file, so the launch's inbox registration and the server it names are told
   * this file. Absent on a plan built by hand, whose launches register from the seat's folder.
   */
  teamFile?: string;
  /** The home directory used to resolve signed policies (`entity`, `project`, `team`, `seat`). */
  home?: string;
  /**
   * The team's state folder (`.agents`). A managed Codex seat's app-server endpoint is recorded
   * there, so a launch without it manages no endpoint: presence stays whatever it was, and no
   * path is guessed in the state's place. Present on every real launch.
   */
  stateDir?: string;
  /** The team the run already read. The seat policies are resolved from it, so a team whose
   *  record lives in the registry is not looked up again through a file path it has no file at
   *  (which reads as unresolved, and a managed Codex endpoint would then never be planned). */
  team?: TeamFile;
  /** The terminal host's sidebar step (`src/launch/sidebar-step.ts`), planned first — before the
   *  server and every seat — wherever `workspace.sidebar.manage` resolves on. Absent: no step,
   *  including every plan where managing resolved off. `skip` prints as one skipped line and
   *  writes nothing; otherwise the write runs once and each of `sessions` reloads in its own
   *  step. */
  sidebar?: {
    rows: readonly (readonly string[])[];
    indicators: SidebarIndicator;
    /** The running sessions of the entity's teams the layout reloads into, minus the session
     *  this run starts, which reads the config when it starts. */
    sessions: readonly string[];
    /** The whole step is already in force: the sentence says so, and nothing runs. */
    skip?: string;
  };
  /** When true, a seat's pane command is the declarative launcher's argv. Absent keeps the
   *  launch line the file already runs. */
  resolveLaunch?: boolean;
  /** Launcher homes for this run. Read only when `resolveLaunch` is set. */
  launcherDiscovery?: Discovery;
}

/** The variables a herdr server starts with: nothing else reaches a seat's pane. */
export const SERVER_ENVIRONMENT = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'LANG'] as const;

/** `herdr` aimed at a session; herdr's default session takes no option. */
export function herdr(session: string, ...args: string[]): string[] {
  return session === 'default' ? ['herdr', ...args] : ['herdr', '--session', session, ...args];
}

/** What stands for a pane id that only exists once its workspace is created. */
export function paneOf(label: string): string {
  return `<pane of ${label}>`;
}

/** How the seat learns that a drop is waiting, in the dry run's own words. Said on the launch
 *  line, so a seat that watches nothing is known before a send leaves it a file no one reads. */
function watcherNote(watcher: CliWatcher): string {
  if (watcher === 'hook') return 'reads its drops at each turn start';
  if (watcher === 'inbox') return 'reads its drops through its MCP inbox';
  return 'watches nothing: a drop sent here is never read';
}

/** Every step of `team up`, in order. Nothing here runs anything. */
/** One shell word without its quoting: `'a'\''b'` and `"a\"b"` read as the shell reads them. */
function unquoteWord(word: string): string {
  let out = '';
  for (const part of word.match(/'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^'"\\]+/g) ?? []) {
    if (part.startsWith("'")) out += part.slice(1, -1);
    else if (part.startsWith('"')) out += part.slice(1, -1).replace(/\\(.)/g, '$1');
    else if (part.startsWith('\\')) out += part.slice(1);
    else out += part;
  }
  return out;
}

function unwrapCodexCommand(command: string): string {
  let current = command;
  for (let depth = 0; depth < 4; depth += 1) {
    const found = shellScriptWordOf(current);
    if (found === null) break;
    current = found.word.text;
  }
  return current;
}

export function codexCommandHasFlag(command: string, flag: string): boolean {
  const words = cliWordList('codex', command);
  if (words !== null) {
    let positional = false;
    for (const word of words) {
      if (word === '--') {
        positional = true;
        continue;
      }
      if (positional) continue;
      if (word === flag || word.startsWith(`${flag}=`)) return true;
    }
    return false;
  }
  const unwrapped = unwrapCodexCommand(command);
  const rawWords: string[] = unwrapped.match(/(?:[^\s'"\\]+|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+/g) ?? [];
  for (const raw of rawWords) {
    const word = unquoteWord(raw);
    if (word === '--') break;
    if (word === flag || word.startsWith(`${flag}=`)) return true;
  }
  return new RegExp(`(^|\\s)${flag}(=|\\s|$)`).test(unwrapped);
}

export function codexCommandRemoteUrl(command: string): string | null {
  const unwrapped = unwrapCodexCommand(command);
  const words: string[] = unwrapped.match(/(?:[^\s'"\\]+|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+/g) ?? [];
  let found: string | null = null;
  for (let i = 0; i < words.length; i++) {
    const word = unquoteWord(words[i]!);
    if (word === '--') break;
    if (word === '--remote') {
      const next = words[i + 1];
      if (next !== undefined) {
        found = unquoteWord(next);
        i++;
      }
    } else if (word.startsWith('--remote=')) {
      found = unquoteWord(word.slice('--remote='.length));
    }
  }
  return found;
}

/**
 * The configuration a managed Codex endpoint is started with, from the seat's own line.
 * Measured on codex-cli 0.161.0: a TUI attached with `--remote` runs its turns under the
 * app-server's configuration, not its own: the TUI's `-c mcp_servers.…` pairs are not loaded
 * (the seat loses its team inbox server), and a resumed thread's permissions are the
 * app-server's (a danger-full-access thread read "Workspace" under a default app-server and
 * "Full Access" under one started with `-c sandbox_mode="danger-full-access"`). So every `-c`
 * pair of the line, and its `-a`/`-s` overrides as their config keys — however the line spells
 * them (spaced, `=`-joined, or attached short) — go to the endpoint. A bare `--` ends option
 * parsing as it does for the CLI: every word after the first one is positional (a prompt), so a
 * prompt word shaped like an option never becomes an endpoint permission.
 */
export function codexEndpointConfig(command: string): string[] {
  const unwrapped = unwrapCodexCommand(command);
  const words: string[] = unwrapped.match(/(?:[^\s'"\\]+|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+/g) ?? [];
  const config: string[] = [];
  const toml = (value: string): string => JSON.stringify(value);
  // A joined value is part of its flag's own word: `--flag=value`, and a short option's
  // `-a=value` or `-avalue`. Measured on codex-cli 0.161.0: `codex -abogus --version` exits 2
  // with "invalid value 'bogus' for '--ask-for-approval <APPROVAL_POLICY>'" and `codex
  // -aon-request -sworkspace-write completion bash` exits 0, so the attached forms name the
  // same options as the spaced ones.
  const joined = (raw: string): { flag: string; value: string } | null => {
    const long = /^(--[a-z-]+)=(.*)$/.exec(raw);
    if (long !== null) return { flag: long[1]!, value: unquoteWord(long[2]!) };
    const short = /^-([as])=(.*)$/.exec(raw);
    if (short !== null) return { flag: `-${short[1]!}`, value: unquoteWord(short[2]!) };
    const attached = /^-([as])(.+)$/.exec(raw);
    if (attached !== null) return { flag: `-${attached[1]!}`, value: unquoteWord(attached[2]!) };
    return null;
  };
  // A bare `--` ends option parsing, as it does for the CLI: every later word is positional (the
  // prompt), in every spelling — spaced, `=`-joined, attached short or long. An attached-looking
  // prompt word such as `-sdanger-full-access` after it names no sandbox.
  let positional = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === '--') { positional = true; continue; }
    if (positional) continue;
    const next = i + 1 < words.length ? unquoteWord(words[i + 1]!) : undefined;
    const own = joined(word);
    const flag = own === null ? word : own.flag;
    const value = own === null ? next : own.value;
    const took = own === null ? 1 : 0;
    if ((flag === '-c' || flag === '--config') && value !== undefined) {
      config.push('-c', value); i += took;
    } else if ((flag === '-a' || flag === '--ask-for-approval') && value !== undefined && !value.startsWith('-')) {
      config.push('-c', `approval_policy=${toml(value)}`); i += took;
    } else if ((flag === '-s' || flag === '--sandbox') && value !== undefined && !value.startsWith('-')) {
      config.push('-c', `sandbox_mode=${toml(value)}`); i += took;
    } else if (word === '--dangerously-bypass-approvals-and-sandbox') {
      config.push('-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"');
    } else if (word === '--full-auto') {
      config.push('-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"');
    }
  }
  return config;
}

/**
 * The line a managed Codex seat runs once it attaches to its endpoint. Keep the selected
 * conversation; permission overrides belong to `codexEndpointConfig` on a remote resume.
 * Other configuration and quoted arguments stay on the line. A fresh launch is unchanged.
 *
 * Measured 2026-10-31 on codex-cli 0.161.0 with a synthetic home, local response fixture and
 * scratch terminal session: start the endpoint with `-c approval_policy="never" -c
 * sandbox_mode="danger-full-access"`, launch a fresh thread with `-a never -s danger-full-access`,
 * then detach and run `codex resume <id> --remote <endpoint>` without permission overrides.
 * Repeat after stopping that endpoint and starting another with the same config. All three
 * completed turns recorded `approval_policy: "never"` and `sandbox_policy.type:
 * "danger-full-access"` in the synthetic rollout's `turn_context`, on the same thread.
 * Evidence: ~/Code/floor/briefs/teamcli-notes/briefs-0.5.10/a7-measurement/measurement.json
 * and provider.py. This measurement used an endpoint carrying the line's config words.
 */
export function remoteCodexCommand(command: string): string {
  const trimmed = command.trimEnd();
  const script = shellScriptWordOf(trimmed);
  if (script !== null && script.trailing.length === 0) {
    const inner = remoteCodexCommand(script.word.text);
    if (inner === script.word.text) return command;
    const open = trimmed[script.word.start];
    const close = trimmed[script.word.end - 1];
    if (open === "'" && close === "'") {
      const encoded = `'${inner.replaceAll("'", "'\\''")}'`;
      return `${trimmed.slice(0, script.word.start)}${encoded}${trimmed.slice(script.word.end)}${command.slice(trimmed.length)}`;
    }
    if (open === '"' && close === '"') {
      const encoded = `"${inner.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`;
      return `${trimmed.slice(0, script.word.start)}${encoded}${trimmed.slice(script.word.end)}${command.slice(trimmed.length)}`;
    }
  }
  // Raw shell words, quotes kept: a word is only ever matched whole and unquoted, so a quoted
  // argument (the rules line, a `-c` value) that happens to hold `resume` is never touched.
  const words: string[] = command.match(/(?:[^\s'"\\]+|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+/g) ?? [];
  if (!words.includes('resume')) return command;
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === '--') {
      kept.push(...words.slice(i));
      break;
    }
    if (['--full-auto', '--dangerously-bypass-approvals-and-sandbox'].includes(word)
      || /^--(ask-for-approval|sandbox)=/.test(word)
      // A short option's joined value: `-a=value` or the attached `-avalue` (measured on
      // codex-cli 0.161.0: `-abogus` is refused as `--ask-for-approval`'s invalid value and
      // the valid attached forms run). Both are permission overrides for the endpoint.
      || /^-[as]=?.+/.test(word)) continue;
    if (['-a', '-s', '--ask-for-approval', '--sandbox'].includes(word)) {
      if (words[i + 1] !== undefined && !words[i + 1]!.startsWith('-')) i++;
      continue;
    }
    const config = word === '-c' || word === '--config';
    const inline = word.startsWith('--config=');
    const value = config ? words[i + 1] : inline ? word.slice('--config='.length) : undefined;
    if (value !== undefined) {
      // A config value is one shell word even when quotes or spaces occur inside it.
      const key = unquoteWord(value).split('=', 1)[0]!.trim();
      if (/^(approval_policy|sandbox_mode|sandbox_workspace_write)(\.|$)/.test(key)) {
        if (config) i++;
        continue;
      }
      if (config) {
        kept.push(word, value);
        i++;
        continue;
      }
    }
    kept.push(word);
  }
  return kept.length === words.length ? command : kept.join(' ');
}

export function upPlan(input: UpInput): Step[] {
  const { session } = input;
  const steps: Step[] = [];

  // A seat's sidebar is painted from the record: line 1 its label, line 2 its display-agent.
  // The same step serves a ready seat and a restored one. Nothing is typed into the pane, and
  // the seat is not launched again.
  const repaint = (seat: UpSeat, pane: string | undefined, workspace: string | undefined): void => {
    if (!pane || !workspace || !seat.displayAgent) return;
    steps.push({
      kind: 'run',
      argv: herdr(session, 'workspace', 'rename', workspace, seat.label),
      also: herdr(session, 'pane', 'report-metadata', pane, '--source', DISPLAY_AGENT_SOURCE, '--display-agent', seat.displayAgent),
      do: {
        do: 'relabel',
        seat: seat.name,
        pane,
        workspace,
        title: seat.label,
        displayAgent: seat.displayAgent,
      },
    });
  };

  // The sidebar layout goes in before anything starts: the session this run creates reads the
  // config as it comes up, and the sessions already running are reloaded onto it. A refusal of
  // the write stops the plan here, with no seat left half-started behind it.
  if (input.sidebar !== undefined) {
    const { rows, indicators, sessions, skip } = input.sidebar;
    if (skip !== undefined) {
      steps.push({ kind: 'skip', text: `sidebar: ${skip}` });
    } else {
      steps.push({
        kind: 'run',
        argv: ['herdr', 'config', 'check'],
        note: `after writing the marked sidebar block — rows ${sidebarRowsWord(rows)}; indicators ${indicators}`,
        do: { do: 'sidebar', rows, indicators },
      });
      for (const one of sessions) {
        steps.push({
          kind: 'run',
          argv: ['herdr', '--session', one, 'server', 'reload-config'],
          note: `the sidebar layout onto the running session; recorded when it applies`,
          do: { do: 'sidebar-reload', session: one, rows, indicators },
        });
      }
    }
  }

  if (!input.sessionRunning) {
    steps.push({
      kind: 'run',
      argv: ['env', '-i', ...SERVER_ENVIRONMENT.map((name) => `${name}=$${name}`), ...herdr(session, 'server')],
      note: 'detached, in a clean environment; SSH_AUTH_SOCK is passed too when it is set',
      do: { do: 'server', session },
    });
    steps.push({
      kind: 'wait',
      text: `until session ${session} is running (30 s at most)`,
      do: { do: 'wait-session', session, seconds: 30 },
    });
  }

  for (const seat of input.seats) {
    if (seat.grantKeep) {
      steps.push({ kind: 'skip', text: `${seat.name}: ${seat.grantKeep}` });
      continue;
    }
    // A pane that is a human's is never launched into or typed into: no workspace is made,
    // no command runs, and the seat is left exactly as it was.
    if (seat.human) {
      steps.push({
        kind: 'skip',
        text: `${seat.name}: the pane is a human's; nothing is launched into it or typed into it; left as it is`,
      });
      continue;
    }
    if (seat.stopped) {
      steps.push({ kind: 'skip', text: `${seat.name}: stopped in the file; start it with \`team add ${seat.name}\`` });
      continue;
    }
    const profile = profileFor(seat.cli);
    if (!profile) {
      steps.push({
        kind: 'skip',
        text: `${seat.name}: no launch profile for \`${seat.cli}\` in this version; left out`,
        do: {
          do: 'record',
          seat: seat.name,
          record: { kind: 'left out', reason: `no launch profile for \`${seat.cli}\` in this version; left out` },
        },
      });
      continue;
    }
    // How this seat's CLI will learn a drop is waiting, as this run leaves it: the turn-start
    // hook only when the run's settings map holds the seat's file, so a hook that did not land
    // is a seat on its MCP inbox (or watching nothing). No map at all is a plan built by hand:
    // it reads what the launch would install.
    const watcher = cliWatcher(
      seat.cli,
      seat.launch,
      input.cliHooks === undefined || input.cliHooks[seat.name] !== undefined,
    );
    // No recorded process, and the pane is a shell or another model. Nothing is closed and
    // nothing is launched: a ready seat keeps its record, and a seat still at launch is left
    // out instead of being waited on.
    if (seat.unidentifiedHold) {
      if (seat.stage === 'ready') {
        steps.push({
          kind: 'skip',
          text: `${seat.name}: ${seat.unidentifiedHold}`,
          do: {
            do: 'record',
            seat: seat.name,
            record: { kind: 'ready' },
            detail: `  ${seat.unidentifiedHold}\n`,
          },
        });
      } else {
        steps.push({
          kind: 'skip',
          text: `${seat.name}: ${seat.unidentifiedHold}`,
          do: {
            do: 'record',
            seat: seat.name,
            record: { kind: 'left out', reason: seat.unidentifiedHold },
          },
        });
      }
      continue;
    }
    if (seat.adopted) {
      // The pane is renamed back in one line, its sidebar line with it; the re-tie itself is the
      // record step the run makes when that rename lands. Nothing is launched, typed or closed.
      steps.push({
        kind: 'run',
        argv: herdr(session, 'agent', 'rename', seat.adopted.pane, seat.name),
        ...(seat.displayAgent
          ? { also: herdr(session, 'pane', 'report-metadata', seat.adopted.pane, '--source', DISPLAY_AGENT_SOURCE, '--display-agent', seat.displayAgent) }
          : {}),
        do: {
          do: 'adopt',
          seat: seat.name,
          cli: seat.cli,
          pane: seat.adopted.pane,
          workspace: seat.adopted.workspace,
          launched: seat.adopted.launched,
          recordedLaunched: seat.adopted.recordedLaunched,
          ...(seat.displayAgent ? { displayAgent: seat.displayAgent } : {}),
          ...(seat.adopted.session === undefined ? {} : { session: seat.adopted.session }),
        },
      });
      // The plan's own line. It carries no `do`: the re-tie is the run step above, so a walk
      // that stops before it leaves the seat exactly as the host restored it.
      steps.push({ kind: 'skip', text: `${seat.name}: restored and re-tied: ${seat.adopted.sentence}; left as it is` });
      continue;
    }
    if (seat.restored) {
      // The seat keeps its pane; its sidebar is painted from the record like a ready seat's.
      repaint(seat, seat.restored.pane ?? seat.pane, seat.restored.workspace ?? seat.workspace);
      steps.push({
        kind: 'skip',
        text: `${seat.name}: ${seat.restored.detail}`,
        do: {
          do: 'record',
          seat: seat.name,
          record: { kind: 'ready' },
          detail: `  ${seat.restored.detail}\n`,
          launched: seat.restored.launched,
          ...(seat.restored.pane === undefined ? {} : { pane: seat.restored.pane }),
          ...(seat.restored.workspace === undefined ? {} : { workspace: seat.restored.workspace }),
          agentSession: seat.restored.session,
        },
      });
      continue;
    }
    if (seat.sessionDoubt) {
      // The pane holds a process this record cannot tie to the launch. A working screen is left
      // to finish its turn and reported as skipped working, so the run does not fail. Any other
      // unresolved doubt is a refusal and holds the run — the stored ready stage does not turn
      // it into success: nothing was proven, and nothing was closed.
      if (seat.doubtWorking) {
        steps.push({
          kind: 'skip',
          text: `${seat.name}: ${seat.sessionDoubt}`,
          do: seat.stage === 'ready'
            ? {
                do: 'record',
                seat: seat.name,
                record: { kind: 'ready' },
                detail: `  ${seat.sessionDoubt}\n`,
              }
            : {
                do: 'record',
                seat: seat.name,
                record: { kind: 'left out', reason: seat.sessionDoubt },
              },
        });
      } else {
        steps.push({
          kind: 'skip',
          text: `${seat.name}: ${seat.sessionDoubt}`,
          do: {
            do: 'record',
            seat: seat.name,
            record: { kind: 'left out', reason: seat.sessionDoubt },
            // The refusal's own sentence stays the record's stderr detail, as the stored-ready
            // record carried it before the seat was refused.
            detail: `  ${seat.sessionDoubt}\n`,
            held: true,
          },
        });
      }
      continue;
    }
    if (seat.stage === 'ready') {
      // A proven conversation the seat's own launch line cannot carry: the repair stops before
      // the close, so nothing is destroyed that cannot be put back. The record stays ready and
      // the run exits 1 with the reason.
      if (seat.resumeHold) {
        steps.push({
          kind: 'skip',
          text: `${seat.name}: ${seat.resumeHold}`,
          do: {
            do: 'record',
            seat: seat.name,
            record: { kind: 'ready' },
            detail: `  ${seat.resumeHold}\n`,
            held: true,
          },
        });
        continue;
      }
      // A drift this run must not close at all — a lead seat, or the seat it runs inside — keeps
      // the ready record and closes nothing; the run exits 1 with the reason the file itself
      // gives (the lead's whole-team repair, or the outside-the-pane run).
      if (seat.driftRefused) {
        steps.push({
          kind: 'skip',
          text: `${seat.name}: ${seat.driftRefused}`,
          do: {
            do: 'record',
            seat: seat.name,
            record: { kind: 'ready' },
            detail: `  ${seat.driftRefused}\n`,
            held: true,
          },
        });
        continue;
      }
      // A drifted seat this run will not close keeps the ready record. The detail names the
      // caller's own way; the skip words are that line, not the ordinary "left as it is".
      if (seat.driftHold) {
        steps.push({
          kind: 'skip',
          text: `${seat.name}: ${seat.driftHold}`,
          do: {
            do: 'record',
            seat: seat.name,
            record: { kind: 'ready' },
            detail: `  ${seat.driftHold}\n`,
          },
        });
        continue;
      }
      // Seats launched before the sidebar took the file's lines still show the CLI or the role.
      repaint(seat, seat.pane, seat.workspace);
      steps.push({
        kind: 'skip',
        text: `${seat.name}: already ready; left as it is${seat.restartNote ? `; ${seat.restartNote}` : ''}`,
        do: {
          do: 'record',
          seat: seat.name,
          record: { kind: 'ready' },
          detail: `  already ready; left as it is${seat.restartNote ? `; ${seat.restartNote}` : ''}\n`,
        },
      });
      continue;
    }
    const cwd = claudeChannelSeat(seat) && input.home !== undefined && input.team !== undefined
      ? channelLobbyFolder(lobbyOf(input.home, input.root, input.team), seat)
      : isAbsolute(seat.cwd) ? seat.cwd : resolve(input.root, seat.cwd);
    const channel = claudeChannelSeat(seat)
      ? { root: input.root, ...(input.home === undefined ? {} : { home: input.home }),
          ...(input.briefEpochs?.[seat.name] === undefined ? {} : { epoch: input.briefEpochs[seat.name] }) }
      : undefined;
    // A seat recorded waiting is never launched again: its recorded pane is reused, and the
    // idle step below reads it fresh and asks its owner (§5).
    const waiting = seat.waiting;
    // The seat's own recorded pane came back at its shell: the line runs there, and neither a
    // workspace is created nor one is closed.
    const reuse = !waiting && seat.repair?.reuse === true ? seat.repair : undefined;
    // A wrapper seat restored to its bare CLI: its own pane is exited in place, with no
    // workspace closed and none made, and the launch below runs in that same pane.
    const ownLine = seat.repair?.ownLine;
    const fresh = !waiting && reuse === undefined && (seat.stage === undefined || !seat.pane);
    const pane = reuse?.pane ?? seat.pane ?? paneOf(seat.name);
    // The same condition as the launch step below. A seat already running keeps
    // its idle wait, rename and rules, and hears the reading as a notice.
    const wouldLaunch = launchWillRun(seat);
    if (seat.launchProblem && wouldLaunch) {
      steps.push({
        // The dry run prints the finding in full, as it always did; the record is left out with
        // the words, and the full sentence follows it on stderr as the record's detail.
        kind: 'skip',
        text: `${seat.name}: would refuse: ${seat.launchProblemDetail ?? seat.launchProblem}`,
        do: {
          do: 'refuse',
          seat: seat.name,
          why: seat.launchProblem,
          ...(seat.launchProblemDetail ? { detail: seat.launchProblemDetail } : {}),
        },
      });
      continue;
    }
    if (seat.budget?.kind === 'refuse' && wouldLaunch) {
      steps.push({
        kind: 'skip',
        text: `${seat.name}: would refuse: ${seat.budget.why}`,
        do: { do: 'refuse', seat: seat.name, why: seat.budget.why },
      });
      continue;
    }
    // The place's session is the herdr session this launch aims at. A file route binds the
    // team file's own session instead (`mcp/register.ts`), read from the file this run read:
    // the server refuses any other. A launch-line route names the same file to its server, so
    // both resolve the team from it rather than from the seat's folder.
    let codexDaemon: CodexDaemonValue | undefined = seat.codexDaemon;
    if (codexDaemon === undefined && profile.cli === 'codex' && input.home !== undefined) {
      codexDaemon = codexDaemonForSeat({
        home: input.home,
        root: input.root,
        ...(input.team !== undefined
          ? { team: input.team }
          : input.teamFile === undefined ? {} : { teamFile: input.teamFile }),
        seat: seat.name,
        session,
      });
    }
    // The id a proven conversation writes into the launch line: the state-agreeing record's
    // first, then the one the pane itself proved (`seat.resume`). A CLI with no measured resume
    // form cannot carry either; the plan says so on the launch rather than losing it silently.
    const resumeId = seat.registry?.sessionId ?? seat.resume;
    const carried = resumeId === undefined ? undefined : resumeCarry(profile.cli, seat.launch, resumeId);
    const recordedLine = carried?.kind === 'line' ? carried.line : seat.launch;
    const resumeGap = carried?.kind === 'refuse'
      ? `its recorded conversation cannot be resumed: ${carried.why}`
      : undefined;
    // The rules line this launch gives `launchCommandOrRefusal`, and whether that call carries
    // it: only a message-mode profile with a launch prompt carries one. Whether the built line
    // really hands it to the CLI is read from the CLI's own decoded words — the same reader the
    // placement proves — so a line whose shape this version cannot place reports no carry
    // instead of writing the file on the assumption of one. `execute.ts` writes the rules file
    // before the command runs from this decision, never by searching the built command's text,
    // which is shell-quoted there.
    const rulesLine = profile.rulesMode === 'message' && !seat.rulesRefusal ? seat.rulesFile?.line : undefined;
    // A Grok seat runs inside the sandbox profile this run writes for it: the workspace's own
    // grant plus the two folders the seat's state lives in. The profile belongs to the team's
    // project, and a launch line that names its own `--sandbox` keeps it — nothing is written
    // for a profile this run did not name. A plan with no home or no team file cannot place the
    // file, and names no profile rather than one Grok could not find.
    const grokSandbox = profile.cli === 'grok' && input.home !== undefined && input.team !== undefined
      ? grokSandboxOf({ home: input.home, root: input.root, project: input.team.project })
      : undefined;
    // The line's own `--sandbox` keeps the file's choice. Asked of the CLI's decoded words,
    // exactly as the launch command asks every "does the line already set this": a flag inside a
    // wrapper's trailing script is the CLI's flag, and a quoted mention in a prompt value is not.
    // A line whose shape this version cannot prove is asked of the whole line, where a plainly
    // written flag is still seen.
    const lineWords = cliWordList(profile.cli, recordedLine);
    const lineNamesSandbox = lineWords === null
      ? /(^|\s)--sandbox(=|\s|$)/.test(recordedLine)
      : lineWords.some((word) => word === '--sandbox' || word.startsWith('--sandbox='));
    const plannedSandbox = grokSandbox !== undefined && !lineNamesSandbox
      ? grokSandbox
      : undefined;
    // The line is built before the steps that create or close a workspace: a refusal must come
    // before any of them, and the warnings it produces are said on the launch step where they
    // have always been said.
    const launchWarnings: string[] = [];
    let command: string;
    let fromResolver = false;
    if (input.resolveLaunch === true) {
      const ctx: ResolveContext = {
        teamRoot: input.root,
        teamHome: input.home ?? input.root,
        cwd,
        parentEnv: {},
        existingPaths: [],
        seatNames: input.seats.map((one) => one.name),
        ...(seat.resolveSession === undefined ? {} : { sessionArg: seat.resolveSession }),
      };
      const decided = resolvedCommand({
        launcher: seat.launcher,
        discovery: input.launcherDiscovery ?? { launchers: new Map(), diagnostics: [] },
        ctx,
      });
      if ('refusal' in decided) {
        steps.push({
          kind: 'skip',
          text: `${seat.name}: would refuse: ${decided.refusal}`,
          do: { do: 'refuse', seat: seat.name, why: decided.refusal },
        });
        continue;
      }
      command = decided.command;
      fromResolver = true;
    } else {
      const launcher = launchCommandOrRefusal(profile, recordedLine, seat.rules, input.cliHooks?.[seat.name], {
        seat: seat.name,
        session,
        ...selfRunner(),
        ...(input.teamFile === undefined ? {} : { file: input.teamFile }),
        ...(input.briefEpochs?.[seat.name] === undefined ? {} : { epoch: input.briefEpochs[seat.name] }),
      }, seat.sessionName, codexDaemon === undefined ? undefined : { codexDaemon }, rulesLine, (text) => {
        // A launch line whose shape this version cannot prove keeps 0.5.10's placement of the
        // options after it; the seat says so on the launch step rather than losing the words.
        launchWarnings.push(text);
      }, cwd, plannedSandbox?.profile, wouldLaunch);
      // A line the profile's words cannot be placed on is refused before any workspace is created
      // or closed: its options would be read as prompt text, or its rules line lost.
      if (launcher.refusal !== undefined) {
        steps.push({
          kind: 'skip',
          text: `${seat.name}: would refuse: ${launcher.refusal}`,
          do: { do: 'refuse', seat: seat.name, why: launcher.refusal },
        });
        continue;
      }
      command = launcher.command;
    }
    let notice: string | undefined;
    if (seat.budget?.kind === 'unknown') notice = seat.budget.text;
    else if (seat.budget?.kind === 'refuse') notice = seat.budget.why;
    if (seat.replacedPane) {
      const gone = seat.closeLeftover
        ? `its recorded pane ${seat.replacedPane} was gone and was replaced; its recorded workspace ${seat.closeLeftover.workspace} is closed once the seat is ready, if it still holds only the old pane`
        : seat.leftWorkspace
          ? `its recorded pane ${seat.replacedPane} was gone and was replaced; its workspace ${seat.leftWorkspace} was left`
          : `its recorded pane ${seat.replacedPane} was gone and was replaced`;
      notice = notice ? `${notice}; ${gone}` : gone;
    }
    if (reuse !== undefined) {
      const same = `its recorded pane ${reuse.pane} was at its shell; launched in the same pane`;
      notice = notice ? `${notice}; ${same}` : same;
    }
    const takeNotice = (): string | undefined => {
      const text = notice;
      notice = undefined;
      return text;
    };
    if (fresh) {
      // A seat whose pane stopped holding the process team launched: what is in it now is not
      // the seat, so it is closed with no key and no text, and everything after this step
      // launches the seat from the beginning, in a workspace of its own. A wrapper seat the
      // host restored to its bare CLI is the exception: its pane is the seat's own, and the
      // exit — the profile's own way out — is typed in it, with no workspace closed or made.
      if (seat.repair) {
        const drift = !seat.repair.reload && !ownLine && seat.repair.drift && seat.model !== undefined && seat.version !== undefined
          ? { model: seat.model, version: seat.version, way: seat.repair.drift.way }
          : undefined;
        const reload = seat.repair.reload;
        const repair = seat.repair;
        if (ownLine) {
          steps.push({
            kind: 'run',
            argv: profile.exit !== null
              ? herdr(session, 'pane', 'run', repair.pane, profile.exit)
              : herdr(session, 'pane', 'send-keys', repair.pane, ...profile.exitKeys),
            note: ownLine.endpoint === true
              ? 'its recorded Codex endpoint is not live; exited in place and launched again here with its own endpoint'
              : 'its pane holds the bare restored CLI, not its launch line; exited in place and launched again here',
            do: {
              do: 'relaunch',
              seat: seat.name,
              cli: repair.cli,
              pane: repair.pane,
              workspace: repair.workspace,
              launched: repair.launched,
              ...(ownLine.session === undefined ? {} : { session: ownLine.session }),
              ...(ownLine.endpoint === true ? { endpoint: true as const } : {}),
            },
          });
        } else {
          steps.push({
            kind: 'run',
            argv: herdr(session, 'workspace', 'close', repair.workspace),
            note: reload
              ? 'closed without input, at an idle prompt: its declared model, effort or rules differ from the launch'
              : drift
                ? 'closed without input: its model drifted from the file'
                : 'closed without input: its pane no longer holds the process team launched',
            do: {
              do: 'repair',
              seat: seat.name,
              cli: repair.cli,
              pane: repair.pane,
              workspace: repair.workspace,
              launched: repair.launched,
              ...(drift ? { drift } : {}),
              ...(reload ? { reload } : {}),
            },
          });
        }
      }
      if (!ownLine) {
        const said = takeNotice();
        steps.push({
          kind: 'run',
          argv: herdr(session, 'workspace', 'create', '--cwd', cwd, '--label', seat.label, '--no-focus'),
          ...(said ? { note: `${said}; would launch` } : {}),
          // A seat that waits in the lobby is created in it: the host confirms that folder again
          // directly before this create (`execute.ts`), with nothing in between.
          do: { do: 'create', seat: seat.name, label: seat.label, cwd, repairLine: seat.repairLine, ...(seat.lobby ? { lobby: true as const } : {}), ...(said ? { notice: said } : {}), watcher, ...(channel === undefined ? {} : { channel }) },
        });
      }
    }
    // A launch line whose shape this version cannot prove keeps 0.5.10's placement of the
    // options after it; the seat says so on the launch step rather than losing the words.
    for (const text of launchWarnings) notice = notice ? `${notice}; ${text}` : text;
    // The launch carries the line exactly when the CLI's own decoded words end with it: a
    // message-mode CLI reads its initial prompt as its last positional word, and a line this
    // version could not place it on names no such word.
    const launchWords = cliWordList(profile.cli, command);
    const rulesCarried = rulesLine !== undefined && profile.rulesPrompt !== null
      && launchWords !== null && launchWords.at(-1) === rulesLine;
    // What the seat's record keeps as its launch line when this run records it: the same base
    // recipe the record paths store today, with the profile's pins placed where the launch puts
    // them — before the CLI's first delimiter, inside a proven script that runs the CLI. Never
    // the expanded command — a dry run prints that and a pane runs it, and the record's line is
    // the recipe, not the expansion. A profile that pins nothing records its base line unchanged.
    const recordLine = pinnedRecordLine(profile.cli, seat.launch, profile.features);
    // A managed Codex seat's endpoint, decided from the same signed policy that shaped the line:
    // the launch must be the Codex binary itself (a wrapper's own endpoint is not ours to bind),
    // and a `--remote` or `--no-daemon` the file already names is a collision, refused rather
    // than probed past. Nothing is recorded when the policy is off or unreadable. A resume line
    // attaches too: the attach sheds its permission overrides (`remoteCodexCommand`), which
    // codex-cli 0.161.0 refuses on a remote resume.
    const managedCodex = managedCodexLaunch({
      cli: profile.cli,
      binary: profile.binary,
      codexDaemon,
      stateDir: input.stateDir,
      launch: seat.launch,
      command,
    });
    // The `waiting` guard is not this condition's alone: §5's seat is never launched again,
    // whatever its live-ness reads, so the wait above is the whole of its plan.
    if (wouldLaunch) {
      const said = takeNotice();
      const watched = watcherNote(watcher);
      // `would launch` joins a notice or a resume gap; a plain watcher note stands alone.
      const launchNote = [said, resumeGap, said === undefined && resumeGap === undefined ? undefined : 'would launch', watched]
        .filter((part): part is string => part !== undefined)
        .join('; ');
      steps.push({
        kind: 'run',
        argv: herdr(session, 'pane', 'run', pane, command),
        note: launchNote,
        do: { do: 'launch', seat: seat.name, label: seat.label, command, pane: reuse?.pane ?? seat.pane, ...(reuse === undefined ? {} : { reuse: reuse.launched, workspace: reuse.workspace }), ...(reuse === undefined && seat.workspace !== undefined ? { workspace: seat.workspace } : {}), cli: profile.cli, cwd, ...(input.teamFile === undefined ? {} : { teamFile: input.teamFile }), ...(said ? { notice: said } : {}), watcher, rulesCarried, recordLine, ...(channel === undefined ? {} : { channel }), ...(fromResolver ? { resolved: true as const } : {}), ...(fromResolver || !(managedCodex && input.stateDir !== undefined) ? {} : { codexEndpoint: { dir: input.stateDir } }), ...(fromResolver || plannedSandbox === undefined ? {} : { grokSandbox: plannedSandbox }) },
      });
    }
    const rules = profile.rulesMode;
    // A waiting seat is asked even when its stage says named: the prompt is the only way its
    // owner can finish or skip it, and nothing here launches it again.
    if (seat.stage !== 'named' || waiting) {
      const said = takeNotice();
      steps.push({
        kind: 'wait',
        text: waiting
          ? `${seat.name}: waiting for owner (${waiting.classification}); its recorded pane is read fresh and the caller is asked (${profile.idleTimeout} s at most)`
          : `until ${seat.name} shows its idle prompt (${profile.idleTimeout} s at most); ` +
            'anything else is reported, its workspace closed without input, and the seat left out',
        ...(said ? { note: said } : {}),
        do: {
          do: 'idle',
          seat: seat.name,
          label: seat.label,
          cli: seat.cli,
          watcher,
          seconds: profile.idleTimeout,
          command,
          pane: reuse?.pane ?? seat.pane,
          workspace: reuse?.workspace ?? seat.workspace,
          repairLine: seat.repairLine,
          ...(seat.model !== undefined && seat.version !== undefined
            ? { model: seat.model, version: seat.version, ...(seat.effort ? { effort: seat.effort } : {}) }
            : {}),
          ...(said ? { notice: said } : {}),
          ...(waiting ? { waiting: { record: waiting, ...(seat.waitingLaunched ? { launched: seat.waitingLaunched } : {}) } } : {}),
          ...(seat.resumeGap ? { resumeGap: seat.resumeGap } : {}),
        },
      });
    }
    if (seat.stage !== 'named' || waiting) {
      steps.push({
        kind: 'run',
        argv: herdr(session, 'agent', 'rename', pane, seat.name),
        // Line 2 is printed with the rename. The live run reports it after the name lands,
        // so the idle wait and anything it asks the owner stay as they were.
        ...(seat.displayAgent
          ? { also: herdr(session, 'pane', 'report-metadata', pane, '--source', DISPLAY_AGENT_SOURCE, '--display-agent', seat.displayAgent) }
          : {}),
        do: {
          do: 'rename',
          seat: seat.name,
          label: seat.label,
          cli: seat.cli,
          seconds: profile.idleTimeout,
          rules,
          pane: reuse?.pane ?? seat.pane,
          ...(seat.displayAgent ? { displayAgent: seat.displayAgent } : {}),
        },
      });
    }
    if (profile.rulesMode === 'message') {
      if (seat.rulesRefusal || !seat.rulesFile) {
        const why = seat.rulesRefusal ?? "its rules file's path can't be typed safely";
        steps.push({
          kind: 'skip',
          text: `${seat.name}: would refuse: ${why}`,
          do: { do: 'refuse', seat: seat.name, why },
        });
        continue;
      }
      const said = takeNotice();
      const file = seat.rulesFile;
      // Where no launch prompt exists, restart builds the same line the launch did: the note
      // says no launch carries them rather than advising a restart that cannot.
      const carryNote = profile.rulesPrompt === null
        ? 'the rules go to a per-seat file in the project state folder; its CLI takes no initial prompt at launch, so no launch carries them, and a seat is never typed into: it is left out'
        : 'the rules go to a per-seat file in the project state folder and ride the launch line; a seat this run does not launch is never typed into: it is left out until team restart carries them';
      steps.push({
        kind: 'run',
        argv: ['team', 'rules', '--with-launch', file.line],
        note: said ? `${said}; ${carryNote}` : carryNote,
        do: {
          do: 'deliver',
          seat: seat.name,
          label: seat.label,
          cli: seat.cli,
          rules: seat.rules,
          path: file.path,
          line: file.line,
          seconds: profile.idleTimeout,
          launchCanCarryRules: profile.rulesPrompt !== null,
          pane: reuse?.pane ?? seat.pane,
          ...(said ? { notice: said } : {}),
        },
      });
    } else if (seat.stage === 'named' && !waiting) {
      const said = takeNotice();
      steps.push({
        kind: 'skip',
        text: `${seat.name}: named, and its rules went with the launch; marked ready`,
        ...(said ? { note: said } : {}),
        do: { do: 'ready', seat: seat.name, rules: 'option', ...(said ? { notice: said } : {}) },
      });
    }
    // The old workspace closes last, after every step that makes the seat ready on its
    // replacement: a seat this run does not launch never reaches it. The close re-reads the
    // workspace and its old pane immediately before it, and says why when it leaves them.
    if (seat.closeLeftover !== undefined && wouldLaunch) {
      steps.push({
        kind: 'run',
        argv: herdr(session, 'workspace', 'close', seat.closeLeftover.workspace),
        note: 'closed once the seat is ready on its replacement, if it still holds only the old pane, with no CLI in it',
        do: { do: 'close-leftover', seat: seat.name, pane: seat.closeLeftover.pane, workspace: seat.closeLeftover.workspace, cli: seat.cli },
      });
    }
  }

  // The workspaces seats vacated close last, after every step that makes a replacement ready —
  // and after a stopped seat's own (there is no replacement to wait for). Each close re-reads
  // the host immediately before it; this plan only says which workspace to read.
  // A human's pane and a granted seat's are not this run's to close, whatever a plan built by
  // hand attached to them: neither reaches the swept collection.
  const swept = [
    ...input.seats.flatMap((seat) => (seat.sweep === undefined || seat.human || seat.grantKeep !== undefined
      ? []
      : [{ seat: seat.name, cli: seat.cli, ...seat.sweep }])),
    ...(input.vacated ?? []),
  ];
  for (const held of swept) {
    steps.push({
      kind: 'run',
      argv: herdr(session, 'workspace', 'close', held.workspace),
      note: 'closed only if a fresh reading shows every pane bare at its own shell, with no other seat there',
      do: {
        do: 'sweep',
        seat: held.seat,
        workspace: held.workspace,
        ...(held.pane === undefined ? {} : { pane: held.pane }),
        ...(held.cli === undefined ? {} : { cli: held.cli }),
        ...('replaced' in held && held.replaced === true ? { replaced: true as const } : {}),
      },
    });
  }

  const busLabel = input.busLabel;
  const busStarting = input.startBus === true && input.busAlive !== true && busLabel !== undefined;
  if (busStarting && busLabel !== undefined) {
    const busLine = input.busLine ?? 'team bus';
    if (input.busHold !== undefined) {
      // A Bus workspace with the team's label exists and its pane cannot be chosen from an
      // unreadable host: a second workspace now could sit beside a Bus already running in it.
      steps.push({ kind: 'skip', text: input.busHold });
    } else if (input.busReuse !== undefined) {
      steps.push({
        kind: 'run',
        argv: herdr(session, 'pane', 'run', input.busReuse.pane, busLine),
        note: 'seats follow it for message.arrived; without it they poll',
        do: { do: 'bus', label: busLabel, command: busLine, pane: input.busReuse.pane, workspace: input.busReuse.workspace },
      });
    } else {
      steps.push({
        kind: 'run',
        argv: herdr(session, 'workspace', 'create', '--cwd', input.root, '--label', busLabel, '--no-focus'),
        do: { do: 'create', label: busLabel, cwd: input.root, bus: true },
      });
      steps.push({
        kind: 'run',
        argv: herdr(session, 'pane', 'run', paneOf(busLabel), busLine),
        note: 'seats follow it for message.arrived; without it they poll',
        do: { do: 'bus', label: busLabel, command: busLine },
      });
    }
  }
  // A stray Bus workspace closes only once the Bus this team runs is up: after the step that
  // starts it, or at once when it already answers. With no Bus planned at all (autostart off,
  // or a hold), strays stay exactly where they are.
  if (input.busStrays !== undefined && (busStarting || (input.startBus === true && input.busAlive === true))) {
    if (!(busStarting && input.busHold !== undefined)) {
      for (const stray of input.busStrays) {
        steps.push({
          kind: 'run',
          argv: herdr(session, 'workspace', 'close', stray.workspace),
          note: 'a second Bus workspace; closed only after the Bus is up and only from a fresh reading',
          do: {
            do: 'sweep',
            workspace: stray.workspace,
            ...(stray.pane === undefined ? {} : { pane: stray.pane }),
            ...(busStarting ? { after: 'bus' as const } : {}),
          },
        });
      }
    }
  }
  if (input.watchAlive || input.startWatch === false) return steps;
  if (input.watchUnknown) {
    steps.push({
      kind: 'skip',
      text: 'watch: the daemon health cannot be read; no pane watch is started this run',
    });
    return steps;
  }
  if (input.watchHold !== undefined) {
    steps.push({
      kind: 'skip',
      text: input.watchHold,
      do: { do: 'hold', text: input.watchHold },
    });
    return steps;
  }
  if (input.watchPid !== undefined) {
    steps.push({
      kind: 'run',
      argv: ['kill', String(input.watchPid)],
      note: 'the stale watch, before its replacement',
      do: { do: 'kill', pid: input.watchPid },
    });
    steps.push({
      kind: 'wait',
      text: `until pid ${input.watchPid} is confirmed gone (${WATCH_STOP_SECONDS} s at most); no replacement is started while it runs`,
      do: { do: 'watch-gone', pid: input.watchPid, seconds: WATCH_STOP_SECONDS },
    });
  }
  const watchArguments = session === 'default' ? '' : ` --session ${shellQuote(session)}`;
  const watchLine = input.watchLine ?? `team watch${watchArguments}`;
  steps.push({
    kind: 'run',
    argv: herdr(session, 'workspace', 'create', '--cwd', input.root, '--label', input.watchLabel, '--no-focus'),
    do: { do: 'create', label: input.watchLabel, cwd: input.root },
  });
  steps.push({
    kind: 'run',
    argv: herdr(session, 'pane', 'run', paneOf(input.watchLabel), watchLine),
    note: 'a desktop notification follows when the watch exits',
    do: { do: 'watch', label: input.watchLabel, command: watchLine, ...(input.watchFile ? { file: input.watchFile } : {}) },
  });
  return steps;
}

export interface DownSeat {
  name: string;
  cli: string;
  pane: string;
  workspace: string;
  /** What the watch's reading says of the seat: only a free seat is stopped.
   *  `exited` comes from the process reading alone — the pane's own shell is back in front and
   *  no CLI process is in its foreground list — never from an unrecognised screen. */
  state: 'free' | 'working' | 'blocked' | 'unknown' | 'unsent' | 'exited';
  /** The pane is a human's: the file marks it `human: true`. No exit line or key is typed into
   *  it, and the seat is left running; the plan says why. */
  human?: true;
  /** The seat's box holds exactly the profile's exit text — left by an earlier run that never
   *  confirmed it — and the profile carries the key that empties the box. */
  exitInBox?: boolean;
  /** The pane already shows this CLI's framed exit question. This run did not ask it. */
  atExitQuestion?: boolean;
  /** Herdr has not named this pane. The state records it for this seat: close it, type nothing,
   *  unless `keep` names the seat. */
  unnamed?: boolean;
  /** Herdr's name for this pane, when it is not the seat's name. The state records the pane
   *  and the workspace for this seat: close it, type nothing, unless `keep` names the seat.
   *  The name is not the match. */
  title?: string;
  /** The caller's `--abandon` takes a pane herdr names as this seat but whose process cannot be
   *  tied to the launch: close its workspace, type nothing — no key, no exit text, no draft. */
  unproven?: true;
  /** `--abandon` only: the profile's safe keys that answer the prompt this pane shows, or the
   *  clearing key for a box holding unsent text. */
  answerKeys?: readonly string[];
  /** `--abandon` only: the unsent text read off the box, and the file it is saved to first. */
  unsentText?: string;
  saveTo?: string;
}

export interface DownInput {
  session: string;
  /** The running seats the file names, plus a pane whose pane and workspace the state records
   *  for a seat, named or not. A name the file does not carry is not closed on that name. */
  seats: readonly DownSeat[];
  /** Agents in the session that the file and the state don't name. */
  extra: number;
  /** The watch's pid, when its state records one that is alive. */
  watchPid: number | null;
  /** The bus's workspace, when `team up` recorded one for this session. */
  busWorkspace?: string | null;
  /** The caller's own seat, and the orchestrator's and operator's, when a seat calls. */
  keep: readonly string[];
  /** The owner is closing workspaces that are not free, without typing into them. */
  abandon?: boolean;
  /** A seat this run asks, whose exit cannot be typed or confirmed, is closed the same way. */
  closeUnasked?: boolean;
  /** The clause a failed ask names when the seat is left running. */
  unasked?: string;
}

const LEFT: Record<Exclude<DownSeat['state'], 'free'>, string> = {
  working: 'is working (`--wait` waits for it)',
  blocked: 'is blocked at a prompt, which `team` never answers',
  unknown: 'shows a screen the profile does not recognise',
  unsent: 'holds unsent text in its input box',
  // Unreachable: `downPlan` closes an exited seat before any line that reads this map. It is
  // here because the type names a clause for every state.
  exited: 'its CLI had exited',
};

/** The `--abandon` answer step: save the unsent text, then press the profile's safe keys. */
function answerStep(session: string, seat: DownSeat): Step {
  const keys = seat.answerKeys ?? [];
  return {
    kind: 'run',
    argv: herdr(session, 'pane', 'send-keys', seat.pane, ...keys),
    note: seat.saveTo !== undefined ? `abandoned: its unsent text is saved to ${seat.saveTo}, then cleared (${keys.join(' ')})` : `abandoned: its prompt is answered with ${keys.join(' then ')}`,
    do: { do: 'answer', seat: seat.name, pane: seat.pane, keys, ...(seat.saveTo !== undefined && seat.unsentText !== undefined ? { saveTo: seat.saveTo, text: seat.unsentText } : {}) },
  };
}

/** Every step of `team down`, in order. Nothing here runs anything. */
export function downPlan(input: DownInput): Step[] {
  const { session } = input;
  const steps: Step[] = [];
  let left = input.extra;

  for (const seat of input.seats) {
    // Before every close: a kept seat stays, whatever herdr calls its pane.
    if (input.keep.includes(seat.name)) {
      steps.push({
        kind: 'skip',
        text: `${seat.name}: left running; only the owner stops the orchestrator's or the operator's seat`,
      });
      left++;
      continue;
    }
    // A pane that is a human's is never typed into: no exit line, no key, and no close of the
    // workspace it is in. The seat is left running and said so.
    if (seat.human) {
      steps.push({
        kind: 'skip',
        text: `${seat.name}: the pane is a human's; nothing is typed into it; left running`,
      });
      left++;
      continue;
    }
    // A pane herdr names as this seat, whose process is not the launched one, and which the
    // caller's `--abandon` takes: its conversation is not this run's to answer, so nothing is
    // typed into it. The workspace close ends whatever is in front.
    if (seat.unproven) {
      steps.push({
        kind: 'run',
        argv: herdr(session, 'workspace', 'close', seat.workspace),
        note: 'abandoned: its process is not the launched one; closed without typing',
        do: {
          do: 'close',
          seat: seat.name,
          workspace: seat.workspace,
          said: 'its process is not the launched one; its workspace was closed without typing',
        },
      });
      continue;
    }
    if (seat.unnamed || seat.title) {
      const said = seat.title
        ? `titled ${seat.title}, not its seat name; the state records its pane and workspace, so its workspace was closed`
        : 'created for this seat and never named; its workspace was closed';
      steps.push({
        kind: 'run',
        argv: herdr(session, 'workspace', 'close', seat.workspace),
        note: seat.title
          ? `titled ${seat.title}; recorded for this seat; closed without typing`
          : 'created for this seat and never named; closed without typing',
        do: {
          do: 'close',
          seat: seat.name,
          workspace: seat.workspace,
          said,
        },
      });
      continue;
    }
    const profile = profileFor(seat.cli);
    if (!profile) {
      if (input.abandon) {
        steps.push({
          kind: 'run',
          argv: herdr(session, 'workspace', 'close', seat.workspace),
          note: 'abandoned: nothing was typed',
          do: { do: 'close', seat: seat.name, workspace: seat.workspace },
        });
        continue;
      }
      if (seat.cli === 'unknown') {
        steps.push({
          kind: 'skip',
          text:
            `${seat.name}: the state doesn't say which CLI it runs, so it can't be asked to exit; ` +
            'left running (`team down --abandon` closes it without typing)',
        });
        left++;
        continue;
      }
      steps.push({
        kind: 'skip',
        text: `${seat.name}: no launch profile for \`${seat.cli}\` in this version; left running`,
      });
      left++;
      continue;
    }
    if (seat.state !== 'free') {
      // The CLI process is gone and the pane's own shell is back in front: there is nothing in
      // this pane to ask and nothing a key could reach. It is closed in this same ordinary run —
      // no `--abandon`, which a delegate cannot pass — and the seat's line names what was seen.
      // Not counted among `left`: the seat is no longer in the session, so the session stop
      // below follows in this same run.
      if (seat.state === 'exited') {
        if (input.abandon && seat.answerKeys && seat.answerKeys.length > 0) steps.push(answerStep(session, seat));
        steps.push({
          kind: 'run',
          argv: herdr(session, 'workspace', 'close', seat.workspace),
          note: 'its CLI had exited; closed without typing',
          do: { do: 'close', seat: seat.name, workspace: seat.workspace, said: 'its CLI had exited; its workspace was closed' },
        });
        continue;
      }
      if (input.abandon && seat.answerKeys && seat.answerKeys.length > 0 && (seat.state === 'unsent' || seat.state === 'blocked' || seat.state === 'unknown')) {
        // The prompt is answered (or the box saved and cleared) by TeamCLI itself, and the seat
        // is then asked to exit as a free one is; the owner's `--abandon` closes it if that fails.
        steps.push(answerStep(session, seat));
      } else if (input.abandon) {
        steps.push({
          kind: 'run',
          argv: herdr(session, 'workspace', 'close', seat.workspace),
          note: 'abandoned: nothing was typed',
          do: { do: 'close', seat: seat.name, workspace: seat.workspace },
        });
        continue;
      } else if (!(seat.state === 'unsent' && seat.exitInBox && profile.exitClear !== null)) {
        // A key-exit profile has no exit text, so no box can hold it: `exitInBox` is false
        // for it at every read.
        // An unsent box holding exactly the exit text, on a CLI with no key for it, is named:
        // the owner sends it or clears it. A framed exit question already on screen is named
        // for what it is: this run never asked it. Every other not-free seat keeps its own line.
        steps.push({
          kind: 'skip',
          text: seat.atExitQuestion
            ? `${seat.name}: sits at its own exit question; left running (team down --abandon closes it)`
            : seat.state === 'unsent' && seat.exitInBox && profile.exit !== null
              ? `${seat.name}: holds this CLI's exit text (${profile.exit}) unsent in its input box; left running (the owner sends it or clears it in its pane)`
              : `${seat.name}: ${LEFT[seat.state]}; left running`,
        });
        left++;
        continue;
      }
      // (An answered seat, above, goes on to the exit below.)
      // The box already holds exactly this exit text and the profile carries the key: the
      // typing step below clears it first and then asks the seat to exit exactly as on an
      // empty box.
    }
    // The printed command is `pane run`. The live step types with `typeText` and `pressEnter`:
    // `/exit` has to go into the idle prompt, and the screen is read again before the Enter.
    // A seat that arrives holding its exit text gets the clearing key before the typing.
    const asked = {
      ...(input.closeUnasked ? { closeUnasked: true, workspace: seat.workspace } : {}),
      ...(input.unasked ? { unasked: input.unasked } : {}),
    };
    if (profile.exit !== null) {
      steps.push({
        kind: 'run',
        argv: herdr(session, 'pane', 'run', seat.pane, profile.exit),
        ...(seat.exitInBox && profile.exitClear !== null
          ? { note: `its box already holds this exit text; it is cleared first (${profile.exitClear})` }
          : {}),
        do: { do: 'type', seat: seat.name, pane: seat.pane, text: profile.exit, ...asked },
      });
    } else {
      steps.push({
        kind: 'run',
        argv: herdr(session, 'pane', 'send-keys', seat.pane, ...profile.exitKeys),
        note: `its CLI takes no exit text: ${profile.exitKeys.join(' then ')} at its idle screen`,
        do: { do: 'keys', seat: seat.name, pane: seat.pane, cli: profile.cli, keys: profile.exitKeys, ...asked },
      });
    }
    steps.push({
      kind: 'wait',
      text: `until ${seat.name}'s pane is back at its shell (${profile.exitTimeout} s at most); on a time-out it is left as it is`,
      do: { do: 'gone', seat: seat.name, pane: seat.pane, cli: profile.cli, seconds: profile.exitTimeout, ...asked },
    });
    steps.push({
      kind: 'run',
      argv: herdr(session, 'workspace', 'close', seat.workspace),
      do: { do: 'close', seat: seat.name, workspace: seat.workspace },
    });
  }

  if (input.watchPid !== null) {
    steps.push({
      kind: 'run',
      argv: ['kill', String(input.watchPid)],
      note: 'the watch',
      do: { do: 'kill', pid: input.watchPid },
    });
  }

  if (input.busWorkspace) {
    steps.push({
      kind: 'run',
      argv: herdr(session, 'workspace', 'close', input.busWorkspace),
      note: 'the event bus',
      do: { do: 'close-bus', workspace: input.busWorkspace },
    });
  }

  if (session === 'default') {
    steps.push({ kind: 'skip', text: "session default: herdr's default session is never stopped" });
  } else if (left > 0) {
    steps.push({
      kind: 'skip',
      text: `session ${session}: not stopped, ${left} agent${left === 1 ? '' : 's'} left in it`,
    });
  } else {
    steps.push({
      kind: 'run',
      argv: ['herdr', 'session', 'stop', session],
      note: 'stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning',
      do: { do: 'stop', session },
    });
  }
  return steps;
}

/** The plan as `--dry-run` prints it. */
export function formatPlan(steps: readonly Step[]): string {
  const lines = steps.map((step) => {
    if (step.kind === 'run') {
      const show = (argv: readonly string[]) => argv
        .map((word) => (/^<pane of .+>$|^[A-Z_]+=\$[A-Z_]+$/.test(word) ? word : shellQuote(word)))
        .join(' ');
      const note = step.note ? `\n    (${step.note})` : '';
      const extra = step.also ? `\n+ ${show(step.also)}` : '';
      return `+ ${show(step.argv)}${note}${extra}`;
    }
    if (step.kind === 'wait') return `  wait ${step.text}${step.note ? `\n    (${step.note})` : ''}`;
    return `  skip ${step.text}${step.note ? `\n    (${step.note})` : ''}`;
  });
  return `${lines.join('\n')}\ndry run: nothing was run\n`;
}
