// The state half of a seat's own reading, beside observe.ts's label half: what the
// seat is doing, best source first —
//
//   1. a screen that is neither mid-turn nor at its prompt — a dialog, a question, an error, a
//      composer holding unsent text: blocked, whatever any clock says;
//   2. the CLI's own signal through the hooks this run installed: working at turn start, idle at
//      turn end, with the instant it wrote — the working word outranking the screen only while
//      its turn is young (`state_hook_working_seconds`), so an interrupted turn cannot leave a
//      stale `working` standing for the day;
//   3. the pane's screen, read against the seat's CLI — working, or idle at its prompt;
//   4. herdr's own screen status;
//   5. TeamCLI's traces within a window — the seat's last ack, message or commit: a trace this
//      fresh means working, and it outranks an idle word, from the hook, the screen or herdr;
//   6. otherwise unknown. Unknown past the blind threshold counts as not working, and `status`
//      and `check` flag the seat `blind` as a must-fix.
//
// TeamCLI's own bookkeeping answers first where it is certain about something a screen cannot
// say: a hold stands over the team (`held`), herdr cannot reach the seat at all (`unreachable`),
// or the process the launch recorded no longer stands in its pane (`done`). The thresholds are
// settings (src/settings/inherit.ts); the fallbacks below are the shipped values.
import { DEFAULT_STATE_THRESHOLDS, sayThreshold, type StateThresholds } from '../settings/inherit.ts';
import type { Screen } from '../watch/screen.ts';
import { readScreen } from '../watch/screen.ts';

export type SeatStateWord = 'working' | 'idle' | 'done' | 'blocked' | 'held' | 'unreachable' | 'unknown';

/** Where a reading came from: the CLI's own screen, the state file the CLI's hooks keep, herdr's
 *  status, TeamCLI's traces, the seat's own process, the hold over the team, or nothing at all. */
export type StateSource = 'cli' | 'cli-hook' | 'herdr' | 'trace' | 'process' | 'hold' | 'none';

/** One reading the seat's CLI wrote through the hooks its launch installed: `working` when a turn
 *  started, `idle` when the turn ended, and the instant it wrote, ISO 8601. */
export type CliHookReading = {
  state: 'working' | 'idle';
  since: string;
};

/** The hook's reading stands for a day. A state file a day old was written by a run that no
 *  longer speaks for this one, and the screen and herdr answer again. */
export const CLI_HOOK_FRESH_SECONDS = 24 * 60 * 60;

/** How far ahead of its reader's clock a hook's instant may sit and still answer. The hook runs
 *  `date -u` beside the reader on the same machine, so a well-formed file is never ahead of it
 *  by more than a clock nudge; a file dated further ahead is no reading — otherwise a future
 *  timestamp, skewed or hand-written, would read fresh until the wall clock passed it. */
export const CLI_HOOK_FUTURE_SKEW_SECONDS = 60;

/** What one seat's reading is made of, already gathered: the caller reads panes and records,
 *  this module only decides. */
export type SeatStateObservation = {
  /** A hold stands over the team (`team hold`): every seat of it is held. */
  held?: boolean;
  /** herdr answers and the session runs. False is out of reach, whatever the pane last showed. */
  reachable?: boolean;
  /** The process the launch recorded still stands in the seat's pane. False is the seat done —
   *  its CLI is gone. Absent where the state records no process: not judged. */
  present?: boolean;
  /** The CLI's own signal: the pane's screen, read against the seat's CLI, when one was read. */
  screen?: Screen;
  /** The state file the CLI's own hooks keep for the seat, when the launch installed them. */
  hook?: CliHookReading | null;
  /** herdr's own screen status for the seat's agent, when herdr reports one. */
  herdr?: string | null;
  /** The newest TeamCLI trace of the seat that carries its own instant, ISO 8601: its last
   *  ack, message or commit — whatever the caller's own records hold. A tool row has no clock
   *  and never stands here. */
  trace?: string | null;
};

export type SeatStateReading = {
  state: SeatStateWord;
  source: StateSource;
  /** Unknown past the blind threshold: not working, and a must-fix in `status` and `check`. */
  blind: boolean;
};

/**
 * The reading itself. First answer wins, in the order above — save two: a trace inside the
 * window beats an idle word, from the hook, the screen or from herdr, because a seat that just
 * committed, acked or was messaged is working even while its prompt shows; and a screen that
 * still reads outranks a `working` hook older than the short working window, because an
 * interrupted turn leaves that word behind while the prompt is what the seat shows now. An
 * absent or unrecognised screen, like a herdr word that is neither `working` nor `idle`, falls
 * through to the next source. `unknown` carries `blind`: no trace at all, or none younger than
 * the blind threshold.
 */
export function seatState(
  observation: SeatStateObservation,
  now: Date,
  limits: StateThresholds = DEFAULT_STATE_THRESHOLDS,
): SeatStateReading {
  if (observation.held === true) return { state: 'held', source: 'hold', blind: false };
  if (observation.reachable === false) return { state: 'unreachable', source: 'herdr', blind: false };
  if (observation.present === false) return { state: 'done', source: 'process', blind: false };
  const screen = observation.screen;
  const traced = observation.trace ? Date.parse(observation.trace) : Number.NaN;
  const age = Number.isFinite(traced) ? now.getTime() - traced : Number.POSITIVE_INFINITY;
  // A trace inside the window is the freshest TeamCLI heard of the seat. It beats an idle word,
  // from the screen, the hook or herdr; never the certainties above nor a working word: those
  // need no help.
  const withinWindow = age <= limits.trace_window_seconds * 1000;
  // Every screen this version reads that is neither mid-turn nor at the prompt — a permission
  // dialog, a question, a trust screen, a rate limit, a provider error, a vendor notice, a
  // composer holding unsent text — is the seat not working and waiting on someone: blocked. It
  // outranks every clock, the hook included: the hook cannot see the dialog that the CLI stopped
  // at after its last write, and nothing can be typed into a composer holding a line until its
  // owner clears or sends it, however recent the last turn's end.
  if (screen !== undefined && screen.kind !== 'working' && screen.kind !== 'idle'
    && screen.kind !== 'unknown') {
    return { state: 'blocked', source: 'cli', blind: false };
  }
  // The CLI's own hook: a fresh `working` is working while its turn is young; a fresh `idle`
  // is idle unless a trace inside the window says the seat is still in the middle of its work.
  // Past the short working window (`state_hook_working_seconds`) a screen that still reads —
  // an interrupted turn leaves the file's `working` behind, and the prompt shows again — is the
  // fresher word and answers instead; a screen it cannot read leaves the hook to answer for the
  // rest of its day. A reading older than the day, or dated further ahead of this machine's
  // clock than a small skew, says nothing about the seat now at all.
  const hook = observation.hook;
  if (hook !== undefined && hook !== null) {
    const wrote = Date.parse(hook.since);
    if (Number.isFinite(wrote)
      && wrote - now.getTime() <= CLI_HOOK_FUTURE_SKEW_SECONDS * 1000
      && now.getTime() - wrote <= CLI_HOOK_FRESH_SECONDS * 1000) {
      if (hook.state === 'working') {
        const fresh = now.getTime() - wrote <= limits.hook_working_seconds * 1000;
        if (fresh || screen === undefined || screen.kind === 'unknown') {
          return { state: 'working', source: 'cli-hook', blind: false };
        }
        // Stale: a working screen says the same thing through the screen, an idle one answers idle.
      } else {
        if (withinWindow) return { state: 'working', source: 'trace', blind: false };
        return { state: 'idle', source: 'cli-hook', blind: false };
      }
    }
  }
  if (screen !== undefined) {
    if (screen.kind === 'working') return { state: 'working', source: 'cli', blind: false };
    if (screen.kind === 'idle') {
      if (withinWindow) return { state: 'working', source: 'trace', blind: false };
      return { state: 'idle', source: 'cli', blind: false };
    }
    // Only a screen it cannot read at all falls through.
  }
  if (observation.herdr === 'working') return { state: 'working', source: 'herdr', blind: false };
  if (observation.herdr === 'idle') {
    if (withinWindow) return { state: 'working', source: 'trace', blind: false };
    return { state: 'idle', source: 'herdr', blind: false };
  }
  // herdr's own word for an agent that finished: the seat is done, not unheard of.
  if (observation.herdr === 'done') return { state: 'done', source: 'herdr', blind: false };
  if (withinWindow) return { state: 'working', source: 'trace', blind: false };
  return { state: 'unknown', source: 'none', blind: age > limits.blind_after_seconds * 1000 };
}

/** What the three readers (`status`, `seats`, `check`) gather per seat: the live pane, the
 *  state's own record, and the certainties the comparison already judged. */
export type ObservedSeatInput = {
  /** The seat's CLI, for the screen read. */
  cli: string;
  /** The seat's agent, when herdr lists one. */
  agent?: { pane: string; status: string };
  /** The pane's visible text, when the caller read one for that agent's pane. */
  screenText?: string;
  /** The state file the CLI's own hooks keep for the seat, when the launch installed them. */
  hook?: CliHookReading | null;
  /** The seat's newest recorded trace, ISO. */
  trace?: string | null;
  /** The file stops this seat: its process is gone on purpose, and it is done. */
  stopped?: boolean;
  /** The comparison's own verdict: the seat's process is missing from its pane. */
  gone?: boolean;
  /** A hold stands over the team. */
  held?: boolean;
  /** The session runs and herdr answers; false is out of reach. */
  reachable?: boolean;
  now: Date;
  limits?: StateThresholds;
};

export function observedSeatState(input: ObservedSeatInput): SeatStateReading {
  const observation: SeatStateObservation = {
    ...(input.held === true ? { held: true } : {}),
    ...(input.reachable === false ? { reachable: false } : {}),
    ...(input.stopped === true || input.gone === true ? { present: false } : {}),
    ...(input.agent !== undefined ? { herdr: input.agent.status } : {}),
    ...(input.agent !== undefined && input.screenText !== undefined
      ? { screen: readScreen(input.cli, input.screenText) }
      : {}),
    hook: input.hook ?? null,
    trace: input.trace ?? null,
  };
  return seatState(observation, input.now, input.limits ?? DEFAULT_STATE_THRESHOLDS);
}

/** A threshold said the way a report says it: 90s, 5m, 2h. The settings module owns the words;
 *  the readers that already import them from here keep importing them from here. */
export { sayThreshold };
