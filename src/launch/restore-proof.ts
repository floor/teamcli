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
import type { SeatState } from '../state.ts';
import { profileFor } from '../profiles/index.ts';
import { readScreen } from '../watch/screen.ts';
import { reportedAgentIsCli, reportedLiveAgent } from './agent.ts';
import { seatProcessVerdict } from './identity.ts';
import { usesLauncher } from './line.ts';

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
  if (seatProcessVerdict(recorded.launched, input.process) !== 'replaced') {
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
