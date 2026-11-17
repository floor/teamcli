// Re-tie a seat the terminal host restored without its name.
//
// The restore clears what the launch recorded about names and keeps what it recorded about
// places: the session, the pane ids and the workspace ids (measured 2026-11-05). A seat whose
// recorded pane still holds a process, whose entry the host lists without the seat's name, and
// whose place the record names is therefore provable without the name: the seat's own
// conversation, or — only when no session id exists on either side — the declared CLI alone in
// its workspace at an idle prompt. The proof is one function, read by `team up` (to adopt) and
// `team check` (to report), so the two can never disagree about what "restored" means.
//
// The name is never proof. A pane the host names with another seat's name is that seat's; a
// recorded session the pane does not show, or one the pane shows that the record never named,
// is refused rather than weakened into a guess.
import type { Seat } from '../file/types.ts';
import type { HerdrAgent, PaneProcesses } from '../herdr.ts';
import { channelLaunchEnabled } from '../mcp/channel.ts';
import type { SeatState } from '../state.ts';
import { profileFor } from '../profiles/index.ts';
import { modelFaultAtIdle, readScreen } from '../watch/screen.ts';
import { reportedAgentIsCli, reportedLiveAgent } from './agent.ts';
import { seatProcessVerdict } from './identity.ts';
import { usesLauncher } from './line.ts';
import { featureDialog } from './reboot.ts';

export type RestoreProof =
  /** The pane runs the conversation the launch recorded: the strongest proof there is. */
  | { kind: 'session'; pane: string; sentence: string }
  /** No session id on either side: the declared CLI, alone in its workspace, at an idle prompt. */
  | { kind: 'cli'; pane: string; sentence: string }
  /** A reported reason, never an adoption. `specific` marks a reason that names something a
   *  reader can act on (another conversation, another CLI, another pane, a working pane); a
   *  reason that only restates "the pane cannot be tied" leaves it off, so `team check` keeps
   *  its generic line for those. */
  | { kind: 'none'; why: string; specific?: true };

export type RestoreProofInput = {
  seat: Pick<Seat, 'name' | 'cli'>;
  /** The state's record for the seat: only a launch record can be re-tied. */
  recorded: Pick<SeatState, 'stage' | 'pane' | 'workspace' | 'launched' | 'waiting'>;
  /** The terminal host's agent list for the session; null when it could not be read. */
  agents: readonly HerdrAgent[] | null;
  /** The recorded pane's process reading, already taken. */
  process: PaneProcesses | null;
  /** The recorded pane's foreground argv0 names, already read; null when unread. */
  foreground: readonly string[] | null;
  /** The conversation the launch recorded (state or registry binding); undefined when none. */
  recordedSession: string | undefined;
  /** The recorded pane's screen text, where it could be read. */
  screen: string | null;
  /** Whether the recorded process itself (`verdict === 'same'`) is also accepted for an in-place
   *  dead-endpoint relaunch. */
  allowSame?: boolean;
};

const NONE_LISTED = 'the terminal host does not list the pane any more; team cannot re-tie it';
const NONE_UNREAD = "the terminal host's agent list could not be read; team cannot re-tie it";

/** The rules, in order; the first that fails is the answer. */
export function restoreProof(input: RestoreProofInput): RestoreProof {
  const { seat, recorded } = input;
  // 1. Only a launch record is re-tied. A seat still at `named`/`launched` never delivered its
  //    rules; the relaunch path, not the adoption path, is what it needs.
  if (recorded.stage !== 'ready' || !recorded.pane || !recorded.workspace || !recorded.launched || recorded.waiting !== undefined) {
    return { kind: 'none', why: 'its launch record never reached ready; team never adopts it' };
  }
  // 2. The pane is the record's own, in the record's own workspace, and it holds a process the
  //    record does not name: `same` needs no proof, `gone` is the relaunch case, `unknown` is
  //    reported. The host's own listing is the place reading the check can trust.
  if (input.agents === null) return { kind: 'none', why: NONE_UNREAD };
  const entry = input.agents.find((agent) => agent.pane === recorded.pane);
  if (!entry) return { kind: 'none', why: NONE_LISTED };
  if (entry.workspace !== '' && entry.workspace !== recorded.workspace) {
    return { kind: 'none', why: `its pane is in workspace ${entry.workspace}; the record puts it in ${recorded.workspace}`, specific: true };
  }
  const verdict = seatProcessVerdict(recorded.launched, input.process);
  if (verdict !== 'replaced' && !(input.allowSame === true && verdict === 'same')) {
    return { kind: 'none', why: 'its pane holds no process this proof can re-tie to the launch' };
  }
  // 3. No other seat owns the pane. The seat's own name (or none) is the only one re-tied over.
  if (entry.name !== null && entry.name !== seat.name) {
    return { kind: 'none', why: `its pane is named ${entry.name}; team never adopts a pane another seat owns`, specific: true };
  }
  // 4. The declared CLI is in the pane, for both proofs. The foreground argv0s are the reading
  //    the launch itself uses; the entry's own attribution, when it names one, must name the
  //    same CLI — its process names, or the profile's own cli where herdr's kind differs
  //    (Cursor: kind `cursor`, process `cursor-agent`).
  const processNames = profileFor(seat.cli)?.processNames ?? [];
  if (processNames.length === 0) {
    return { kind: 'none', why: 'its launch profile names no process to look for; team cannot tie the pane' };
  }
  if (input.foreground === null) {
    return { kind: 'none', why: `its pane's foreground cannot be read; team cannot tell it is ${seat.cli}` };
  }
  if (!reportedLiveAgent(input.foreground, processNames)) {
    return { kind: 'none', why: `its pane runs ${input.foreground[0] ?? 'no CLI'}; the seat's launch line runs ${seat.cli}`, specific: true };
  }
  if (entry.agent !== null && !reportedAgentIsCli(entry.agent, seat.cli, processNames)) {
    return { kind: 'none', why: `its pane's agent says ${entry.agent}; the seat's launch line runs ${seat.cli}`, specific: true };
  }
  // 5. The conversation decides strong versus weak. One-sided ids are refused: a recorded
  //    conversation the pane does not show, or one the record never named, is not a weak proof.
  const liveSession = entry.session !== undefined && entry.session !== '' ? entry.session : undefined;
  if (input.recordedSession !== undefined && liveSession !== undefined) {
    if (input.recordedSession !== liveSession) {
      return {
        kind: 'none',
        why: `its pane holds another conversation (${liveSession}; the record's launch ran ${input.recordedSession})`,
        specific: true,
      };
    }
    return { kind: 'session', pane: recorded.pane, sentence: 'its conversation is the one the record names' };
  }
  if (input.recordedSession !== undefined) {
    return { kind: 'none', why: `its pane reports no conversation; the record's launch ran ${input.recordedSession}`, specific: true };
  }
  if (liveSession !== undefined) {
    return { kind: 'none', why: `its pane holds a conversation (${liveSession}) the record's launch never named`, specific: true };
  }
  // Weak: the declared CLI must be alone in its workspace, at an idle prompt, with nothing
  // unsent in its box. Another pane in the workspace leaves no way to tell which one is the seat.
  if (input.agents.some((agent) => agent.pane !== recorded.pane && agent.workspace === recorded.workspace)) {
    return { kind: 'none', why: 'its workspace holds another pane; team cannot tell which one is the seat', specific: true };
  }
  if (entry.status === 'working') return { kind: 'none', why: workingWhy(seat.name), specific: true };
  if (entry.status !== 'idle' && entry.status !== 'done') {
    return { kind: 'none', why: `its pane reads ${entry.status || 'no state'}; team cannot tell it is at an idle prompt`, specific: true };
  }
  if (input.screen !== null && input.screen !== '') {
    const kind = readScreen(seat.cli, input.screen).kind;
    if (kind === 'working') return { kind: 'none', why: workingWhy(seat.name), specific: true };
    if (kind === 'unsent') return { kind: 'none', why: `the process in its pane holds unsent text; nothing closed (send or clear it there, or run team remove ${seat.name})`, specific: true };
  }
  return {
    kind: 'cli',
    pane: recorded.pane,
    sentence: `its pane runs ${seat.cli} alone in its workspace, at an idle prompt`,
  };
}

function workingWhy(seat: string): string {
  return `the process in its pane is working; nothing closed (stop it there, or run team remove ${seat})`;
}

/**
 * Whether a proven seat must be relaunched through its own launch line instead of adopted in
 * place. A `session` proof on a seat whose launch line starts something other than the CLI's own
 * binary — or whose file says the launcher chooses the model — is the wrapper case: the restored
 * pane runs the bare CLI without the wrapper's settings (an alternate endpoint), so adopting it
 * would leave every turn failing. `team up` then closes it without input and relaunches the seat
 * through its own line plus `--resume <the proof's conversation>`. Any other proof, or a line
 * that is the CLI itself, is re-tied where it stands. The `launch` is the line the relaunch would
 * run — the record's own where there is one, never the file's line edited since.
 */
export function relaunchWithOwnLine(
  seat: Pick<Seat, 'name' | 'cli'> & { launch?: string; modelFrom?: Seat['modelFrom'] },
  recorded: Pick<SeatState, 'stage' | 'pane' | 'workspace' | 'launched' | 'waiting'>,
  proof: RestoreProof,
): boolean {
  void recorded;
  if (proof.kind !== 'session' || seat.launch === undefined) return false;
  return usesLauncher({
    cli: seat.cli,
    launch: seat.launch,
    ...(seat.modelFrom === undefined ? {} : { modelFrom: seat.modelFrom }),
  });
}

/** How long a restore waits for the seat's channel to answer before the quiet counts as a mismatch. */
export const CHANNEL_RESTORE_WINDOW_MS = 2000;

/** The step of that wait. The bound is the count of steps, so a clock that does not move still ends. */
export const CHANNEL_RESTORE_STEP_MS = 200;

const RESTORE_DIALOGS = new Set([
  'permission',
  'plan approval',
  'confirmation',
  'question',
  'trust',
  'login',
  'exit question',
]);

/** A restored pane that must not be exited: a running turn, unsent text, or a dialog. */
export function restorePaneBusy(cli: string, screen: string | null, status: string | undefined): boolean {
  if (status === 'working') return true;
  if (screen == null || screen === '') return false;
  if (featureDialog(screen)) return true;
  const kind = readScreen(cli, screen).kind;
  return kind === 'working' || kind === 'unsent' || RESTORE_DIALOGS.has(kind);
}

export type RestoreRelaunch = 'launcher' | 'model' | 'channel';

/**
 * Whether a seat runs through something the host's own restore does not re-run: a launcher
 * script in front of the CLI, a file that lets the launcher choose the model, or a Claude Code
 * seat on the shipped launcher with a provider other than Anthropic (its endpoint and key are set
 * in front of the CLI). A host restart resumes the bare CLI without them, and every turn then
 * fails on the model ("There's an issue with the selected model (deepseek-flash)", material's and
 * floor's DeepSeek seats after the 17 Nov restart), so such a seat is launched again from its
 * own line, never adopted where it stands.
 */
/** The restored pane is at an empty idle prompt directly under the CLI's own model-failure
 *  entry: the CLI is running without the endpoint its launcher sets ("There's an issue with the
 *  selected model (deepseek-flash). …"). A banner or a status line naming the provider's model
 *  is not proof the settings are there (the 17 Nov DeepSeek seats showed `deepseek-flash` in their
 *  status line while every turn failed), and a quoted or older mention of the sentence is not a
 *  fault: the reading is structural (`modelFaultAtIdle`), and execution repeats it. */
export function restoredModelFailure(cli: string, screen: string | null): boolean {
  return modelFaultAtIdle(cli, screen);
}

export function restoredBypassesLauncher(
  seat: Pick<Seat, 'cli'> & { launch?: string; modelFrom?: Seat['modelFrom']; launcher?: string; vendor?: string },
): boolean {
  const providerLaunch = seat.cli === 'claude-code' && seat.launcher === 'claude-code'
    && seat.vendor !== undefined && seat.vendor !== 'anthropic';
  return providerLaunch || seat.launch !== undefined && usesLauncher({
    cli: seat.cli,
    launch: seat.launch,
    ...(seat.modelFrom === undefined ? {} : { modelFrom: seat.modelFrom }),
  });
}

/**
 * Why a proven restored seat is launched again from its recorded line. A launcher or a model
 * that is not the record's is a mismatch even when the pane is busy: the caller holds it and
 * types nothing. A channel the record declares, with no live answer, is a mismatch only while
 * the pane is idle; a busy pane stays and the one step is logged.
 */
export function restoreRelaunch(input: {
  seat: Pick<Seat, 'cli'> & { launch?: string; modelFrom?: Seat['modelFrom']; launcher?: string; vendor?: string };
  proof: RestoreProof;
  screen: string | null;
  status: string | undefined;
  modelDiffers: boolean;
  /** The record declares the channel and no live channel answered inside the restore window. */
  channelQuiet: boolean;
  /** The seat state's own launch line, when it is the line that declares the channel. */
  recordedLaunch?: string;
}): RestoreRelaunch | 'busy-line' | null {
  if (input.proof.kind === 'none') return null;
  const launch = input.seat.launch;
  // A Claude Code seat on the shipped launcher with a provider other than Anthropic starts with
  // the provider's endpoint and key set in front of the CLI. A host restart resumes the CLI
  // without them, and every turn then fails on the model (vlist's DeepSeek reviewer, 2026-11-12),
  // so it is launched again from its own line, as a wrapper-script seat is.
  const launcher = restoredBypassesLauncher(input.seat);
  const channel = input.channelQuiet && (channelLaunchEnabled(launch) || channelLaunchEnabled(input.recordedLaunch));
  if (!launcher && !input.modelDiffers && !channel) return null;
  if (restorePaneBusy(input.seat.cli, input.screen, input.status)) {
    return launcher || input.modelDiffers ? 'busy-line' : null;
  }
  if (launcher) return 'launcher';
  if (input.modelDiffers) return 'model';
  return 'channel';
}

/**
 * A seat whose record stopped before ready — still `launched`, or recorded waiting at a dialog —
 * whose pane the host restored with the seat's own conversation in it. The plain proof above never
 * adopts such a record (rule 1), and the waiting path used to read the replaced pids as "not that
 * seat" and plan a fresh workspace resuming the same conversation: a second live copy of the seat
 * beside the first (the teamcli lead after the 2026-11-16 restart). The record's stage is not what
 * proves the pane; the conversation is. So only the strong proof is accepted here: the pane the
 * record names, in its workspace, the declared CLI in front, unnamed or named for this seat, and
 * its live conversation exactly the one the records bind. The weak `cli` proof never adopts a
 * record that did not reach ready.
 */
export function unreadyRestoreProof(input: Omit<RestoreProofInput, 'allowSame'>): Extract<RestoreProof, { kind: 'session' }> | null {
  const { recorded } = input;
  if (input.recordedSession === undefined || input.recordedSession === '') return null;
  const proof = restoreProof({
    ...input,
    recorded: {
      stage: 'ready',
      ...(recorded.pane === undefined ? {} : { pane: recorded.pane }),
      ...(recorded.workspace === undefined ? {} : { workspace: recorded.workspace }),
      ...(recorded.launched === undefined ? {} : { launched: recorded.launched }),
    },
  });
  return proof.kind === 'session' ? proof : null;
}

/**
 * The conversation a plan would put on a launch line, when that conversation is already live on a
 * pane the plan does not exit first. Resuming it would run two copies of one seat's history side
 * by side, so the seat is held instead: nothing is launched, nothing is closed. An in-place repair
 * (its own pane, exited before the line runs) is not a second copy.
 */
export function liveConversationElsewhere(input: {
  /** The id the launch would resume, when it resumes one. */
  resume: string | undefined;
  /** The pane the plan exits or closes before launching, when it repairs in place. */
  inPlace: string | undefined;
  /** The seat's CLI: a conversation id is that CLI's own; another CLI's id is another namespace. */
  cli: string;
  agents: readonly Pick<HerdrAgent, 'pane' | 'session' | 'agent'>[] | null;
}): string | null {
  const id = input.resume;
  if (id === undefined || id === '' || input.agents === null) return null;
  const names = profileFor(input.cli)?.processNames ?? [];
  const live = input.agents.find((agent) => agent.session === id && agent.pane !== input.inPlace
    && reportedAgentIsCli(agent.agent, input.cli, names));
  return live === undefined ? null : live.pane;
}
