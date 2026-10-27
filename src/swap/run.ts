// Carrying out a queued model swap (Policies rule 11): the boundary
// observation that decides when a seat may be stopped, and the run itself, which is the restart
// path's own sequence — inspect, stop, end the session record with reason `swap`, write the new
// declaration, install the hooks, deliver the brief, launch from the file's words, wait for
// ready, read the model back. `team restart` and the swap both call `performRestart`, so there
// is one stop-and-launch sequence in the tool and this module adds only what a swap decides:
// whether it is due, whether the conversation resumes or a handover is asked for, and what the
// new screen says the model is.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ceilingsOf } from '../approve/approval.ts';
import { performRestart, type ReadBack, type RestartSources } from '../commands/restart.ts';
import type { RulesOrigin } from '../launch/rules.ts';
import { hasSeat, rewriteSeatModel, type SeatModelFields } from '../file/lines.ts';
import type { Problem, Seat, TeamFile } from '../file/types.ts';
import type { Io } from '../io.ts';
import { logLine } from '../log.ts';
import { herdrUnreliable, supportsSessionResume } from '../profiles/profile.ts';
import { latestSessionOf } from '../sessions/registry.ts';
import { readState, type QueuedSwap } from '../state.ts';
import { approvalStanding } from '../store/store.ts';
import { liveLeaseOf } from '../tasks/lease.ts';
import { seatHasAssignedWorkOnDisk } from '../watch/status-events.ts';
import { nativeAllowsTyping, prefetchPresence, presenceSeatOf, presenceVerdict } from '../watch/presence.ts';
import { finishSwap, handoverPath, needsHandover, noteHandover, queuedSwaps, swapDue } from './queue.ts';
import { readTeamText, teamPlace, writeTeamText } from '../file/team-text.ts';

/** What one observation says about a seat, in the words `swapDue` reads. `boundary` is the mark
 *  the watch makes itself: quiet, no turn, no dialog, no task lease, no assigned work on disk
 *  and no work drop still in the seat's folder. The watch types no *new* work drop into a seat
 *  whose swap is queued, but a drop delivered before the record was queued — or a message sent
 *  past the queue — can still be waiting, and the stop must not cut a task it wakes. */
export type SwapObservation = {
  running: boolean;
  quiet: boolean;
  working: boolean;
  prompt: boolean;
  /** The input box holds text nobody sent: never a boundary, and never due past the deadline. */
  unsent: boolean;
  broken: boolean;
  boundary: boolean;
  /** The native presence proof does not allow stopping this seat (a turn, a person wait, a
   *  session end, an unproven record or an unproven channel). Not a boundary, and never due
   *  past the deadline: the screen's `idle` word cannot overrule the runtime's own record. */
  nativeHeld?: boolean;
};

/** The bounded wait the old conversation is given to write its handover. The design names a
 *  bound and no setting: the seats are idle when this is asked (the swap waits for the
 *  boundary), so one turn is enough, and a conversation that does not answer must not hold the
 *  launch forever. */
export const HANDOVER_WAIT_MS = 120_000;

/** No dev mode: a swap's run has no caller gate to lift — a rule-driven or owner swap carries
 *  the owner's authorization, and a `config` swap already passed the queue's gate. */
const NO_DEV = { on: false, by: null, governed: false, ignored: false, expired: null, refusals: [] };

/** What one run ended as. `wait` is not due yet, or past its wait on a turn, a dialog or unsent
 *  text (`why` says which); `retry` is a busy turn, a replaced pane or an unreadable herdr, which
 *  the next pass tries again; `failed` is worth reporting — a preflight refusal, a seat this file
 *  no longer declares, or a screen that did not read back the model. */
export type SwapRunResult =
  | {
      kind: 'ready';
      seat: string;
      oldPane: string;
      pane: string;
      readBack: ReadBack;
      resumed?: string;
      handover?: string;
    }
  | {
      kind: 'mismatch';
      seat: string;
      oldPane: string;
      pane: string;
      readBack: Extract<ReadBack, { kind: 'mismatch' }>;
    }
  | { kind: 'failed'; seat: string; why: string }
  | { kind: 'retry'; seat: string; why: string }
  | { kind: 'wait'; seat: string; why: string };

export type SwapRunOptions = {
  dir: string;
  root: string;
  home: string;
  /** The team file's path: what the launch plan and the state record name. */
  path: string;
  team: TeamFile;
  session: string;
  io: Io;
  json: boolean;
  /** The plain output's working lines, collapsed onto the document under `--json`. */
  notes: string[];
  sources: RestartSources;
  /** The words the log carries as the caller: `the watch`, or the caller's description. */
  by: string;
  /** Whether the run acts with the owner's authorization. A rule-driven swap does (the rule in
   *  force is the owner's word); a `config` swap does only when its caller was the owner. */
  owner: boolean;
  /** The caller's fresh per-seat native channel health, when it has one (the watch does). Unset
   *  leaves every native projection unproven, so the run holds such a seat; a run with no
   *  presence record is unaffected. */
  presenceChannelHealthy?: (seat: string) => boolean;
  now(): Date;
  /** Registry wording when the team was read from the registry; file wording for a real team.yaml. */
  rulesOrigin?: RulesOrigin;
};

/**
 * One observation of a seat, from the live world rather than an agent's word. Null when herdr
 * cannot be read at all: that is a retry, never a boundary.
 */
export function observeSwap(
  sources: RestartSources,
  session: string,
  seat: Seat,
  root: string,
  now: Date,
  /** The team's project: with `sources.home` it reaches the entity event log the assigned-work
   *  check reads beside the project's own. */
  project: string,
  /** Whether this run's own native presence read holds the seat. The run reads the store itself
   *  at decision time, so a watch caller and a `team swap` caller reach the same answer. */
  nativeHeld = false,
): SwapObservation | null {
  const agents = sources.agents(session);
  if (agents === null) return null;
  const agent = agents.find((candidate) => candidate.name === seat.name);
  if (!agent) {
    return { running: false, quiet: false, working: false, prompt: false, unsent: false, broken: false, boundary: false, nativeHeld };
  }
  const cwd = sources.foregroundCwd ? sources.foregroundCwd(session, agent.pane) : null;
  const screen = sources.screen(session, agent.pane, seat.cli, cwd);
  const theirWord = herdrUnreliable(seat.cli);
  // Text in the input box is not the boundary the design names: the stop would refuse it as
  // unsent, and a watch that called it a boundary would log an attempt every pass. It is also
  // never the past-deadline pause `swapDue` reads.
  const unsent = screen.kind === 'unsent';
  const quiet = !unsent && (theirWord
    ? screen.kind === 'idle'
    : agent.status === 'idle' || agent.status === 'done');
  const working = agent.status === 'working' || screen.kind === 'working';
  const prompt = screen.kind === 'permission'
    || screen.kind === 'trust'
    || screen.kind === 'question'
    || screen.kind === 'exit question'
    || screen.kind === 'vendor notice'
    || screen.kind === 'provider error'
    || screen.kind === 'rate limit';
  // A broken seat cannot finish its task: the two states `provider-error` already reads. It
  // swaps at once rather than waiting for a boundary it may never reach.
  const broken = screen.kind === 'provider error' || screen.kind === 'rate limit';
  // A quiet screen is not the whole boundary: work can wait on disk with no turn running — a
  // live lease, an assigned worktree or temporary task, an unacked message drop (all read by the
  // one assigned-work check the status engine already uses) and a work drop the watch wrote
  // before the record was queued. None of them is a turn, but starting one is exactly what the
  // stop would cut. The native proof is the same kind of fact about the runtime itself: a seat
  // it holds is never free, whatever the screen's word.
  const assigned = seatHasAssignedWorkOnDisk(root, session, seat.name, now.getTime(), {
    project,
    home: sources.home,
  });
  const boundary = quiet && !working && !prompt
    && !nativeHeld
    && liveLeaseOf(root, seat.name, now.getTime()) === null
    && !assigned
    && !workDropWaiting(root, session, seat.name);
  return { running: true, quiet, working, prompt, unsent, broken, boundary, nativeHeld };
}

/** Whether a work drop the watch wrote still waits in the seat's folder. A work drop carries no
 *  receipt — nothing marks one read — so a file still there is the only sign available, and the
 *  safe reading is that the seat may still take it. A drop long consumed can therefore delay the
 *  boundary path, never the swap: past `swap-wait-seconds` the run goes without it. */
function workDropWaiting(root: string, session: string, seat: string): boolean {
  const dir = join(root, '.agents', 'send-drops', session, seat);
  try {
    return readdirSync(dir).some((name) => name.startsWith('work-'));
  } catch {
    // A folder that cannot be read holds no drop this observation can see.
    return false;
  }
}

/** The queued swaps of this team, in seat order, run one at a time. Every record is read, never
 *  only the seats herdr currently lists: a record for a seat that is down, signed off, human or
 *  no longer in the file must still be handled — reported, kept or cleaned up — instead of being
 *  skipped for as long as its seat is not live. The queue is re-read before every record, so a
 *  swap cancelled or re-queued by another process while this run stops one seat does not start
 *  another seat on a stale record. A record for a seat the file no longer declares or has signed
 *  off is handed to `runOneSwap` all the same: the run reports it and removes a record the file
 *  has no seat for, and no run ever launches over a sign-off. */
export async function runDueSwaps(input: SwapRunOptions): Promise<SwapRunResult[]> {
  const results: SwapRunResult[] = [];
  const names = queuedSwaps(readState(input.dir)).map(([seat]) => seat);
  for (const seat of names) {
    const held = readState(input.dir).swaps?.[seat];
    if (!held) continue;
    const result = await runOneSwap(input, seat, held);
    results.push(result);
    // A ready swap changed the world under the rest of the queue; the next record is read and
    // observed on its own. A failure does not stop the others: one seat at a time, not one only.
  }
  return results;
}

/** One queued swap, carried out if it is due. The queue record is removed only once the new pane
 *  is ready, the file declares the recipe and the read-back agrees (or cannot read the screen);
 *  a file write that failed or a read-back mismatch leaves the record standing. Only the record
 *  this run read is removed. */
export async function runOneSwap(input: SwapRunOptions, name: string, swap: QueuedSwap): Promise<SwapRunResult> {
  const { dir, root, home, team, session, sources, now } = input;
  const declared = team.seats.find((candidate) => candidate.name === name);
  if (!declared) {
    finishSwap(dir, name, swap.queuedAt);
    const why = `${name} is no longer declared in the team file; its queued swap was removed`;
    logLine(dir, 'swap', input.by, why, now());
    return { kind: 'failed', seat: name, why };
  }
  if (declared.stopped) {
    const why = `${name} is signed off; the owner takes the sign-off off in the file and runs team up`;
    logLine(dir, 'swap', input.by, `${name}: the swap waits: ${why}`, now());
    return { kind: 'failed', seat: name, why };
  }
  if (declared.human) {
    const why = `${name} is a human's pane: nothing is launched over it`;
    logLine(dir, 'swap', input.by, `${name}: the swap waits: ${why}`, now());
    return { kind: 'failed', seat: name, why };
  }

  // This run reads the presence store itself, at decision time, rather than borrowing the
  // watch's held set: `team swap` reaches the same answer with no watch in the process. Only an
  // explicit force (handled by `swapDue`) may override the hold; every automatic route honours
  // it, including a screen that reads broken.
  const recorded = readState(dir);
  const presence = await prefetchPresence({ stateDir: dir, session, seatNames: [name] });
  const read = presence.get(name) ?? { kind: 'absent' as const, why: 'the run read no presence for this seat' };
  const native = presenceVerdict(
    read,
    presenceSeatOf(recorded.sessions[session], name, input.presenceChannelHealthy),
    { now: now(), thresholdSeconds: 0 },
  );
  const nativeHeld = !nativeAllowsTyping(native);

  const observed = observeSwap(sources, session, declared, root, now(), team.project, nativeHeld);
  if (observed === null) {
    return { kind: 'retry', seat: name, why: 'herdr cannot be read; the queue stands' };
  }
  // A seat herdr does not list has no pane this run can inspect or stop, and no turn to wait
  // on. The record is the project's and outlives `down` and `up` (the queue's own rule), so the
  // swap waits here, truthfully, and runs once the seat is up — it never launches a pane it
  // could not observe, and a force does not turn this into a blind launch either.
  if (!observed.running) {
    return { kind: 'wait', seat: name, why: 'the seat is not running; the swap waits for its pane (team up starts it)' };
  }
  if (!swapDue(swap, observed, now())) return { kind: 'wait', seat: name, why: waitWhy(swap, observed, now()) };

  const current = now();
  if (swap.forced) {
    logLine(dir, 'swap', input.by, `${name}: runs now, forced by ${swap.forced.by} at ${swap.forced.at}`, current);
  } else if (observed.broken) {
    logLine(dir, 'swap', input.by, `${name}: at a rate limit or provider error; the swap runs at once`, current);
  } else if (!observed.boundary) {
    logLine(dir, 'swap', input.by, `${name}: the wait ran out; the swap runs between two turns`, current);
  } else {
    logLine(dir, 'swap', input.by, `${name}: at its boundary; the swap runs`, current);
  }

  // Resume the recorded conversation when the CLI stays the same and keeps sessions. Otherwise
  // ask the old conversation for a handover: the CLI changed, or a fresh conversation would lose
  // the context anyway. The path is the record's own when it named one, so a retry after a busy
  // turn offers the same file and a handover already written is used without asking again. A
  // broken screen is never asked: it cannot answer, and typing there would burn the bounded wait
  // on a dead pane. The swap runs at once with no handover, as the design's broken-seat clause
  // says it must.
  const resume = resumeIdFor(input, declared, swap);
  let handover: { path: string; waitMs: number } | undefined;
  if (resume === undefined && observed.broken) {
    logLine(dir, 'swap', input.by, `${name}: no handover is asked; the screen is at a rate limit or provider error`, current);
  } else if (resume === undefined) {
    const path = swap.handover ?? handoverPath(dir, name, current);
    if (swap.handover === undefined) noteHandover(dir, name, swap.queuedAt, path);
    handover = { path, waitMs: HANDOVER_WAIT_MS };
  }

  const fields = recipeOf(swap);
  const next = seatOf(declared, swap);
  const agents = sources.agents(session);
  if (agents === null) return { kind: 'retry', seat: name, why: 'herdr cannot be read; the queue stands' };

  const performed = await performRestart({
    out: input.io,
    json: input.json,
    notes: input.notes,
    dir,
    root,
    home,
    path: input.path,
    team,
    session,
    name,
    declared,
    next,
    recorded: readState(dir).sessions[session]?.seats[name],
    agents,
    abandon: false,
    broken: observed.broken,
    owner: input.owner || swap.reason !== 'config',
    callerText: input.by,
    standing: approvalStanding(root, home),
    ceilings: ceilingsOf(team),
    dev: NO_DEV,
    devFolded: false,
    command: 'swap',
    endReason: 'swap',
    dry: false,
    ...(resume === undefined ? {} : { resume }),
    ...(handover === undefined ? {} : { handover }),
    declare: () => declareRecipe(input.path, name, fields, home),
    now: input.now,
    sources,
    ...(input.rulesOrigin === undefined ? {} : { rulesOrigin: input.rulesOrigin }),
  });

  switch (performed.kind) {
    case 'ready': {
      const from = `${swap.from.vendor} ${swap.from.model} ${swap.from.version}`;
      const to = `${swap.to.vendor} ${swap.to.model} ${swap.to.version}`;
      // What the launch was actually given, not what was merely asked for: a handover whose
      // bounded wait ended without the file is not a pass, and the words must not say it was.
      const how = resume !== undefined
        ? `resumed session ${resume}`
        : performed.handover !== undefined
          ? `handover passed from ${performed.handover}`
          : handover !== undefined
            ? 'fresh conversation; no handover was written'
            : 'fresh conversation';
      // A declaration whose write failed never reaches here: the run aborts before the launch
      // (the ruling of 2026-10-19), so a ready result always names a file that was rewritten.
      // The screen shows another model: the swap failed, the queue record stands, and nothing
      // says it swapped. A completion here would hide a seat running the wrong model.
      if (performed.readBack.kind === 'mismatch') {
        const said = `read-back: mismatch — the file declares ${performed.readBack.expected}, the screen shows ${performed.readBack.shown}`;
        logLine(dir, 'swap', input.by, `${name}: ${said}; the swap failed`, now());
        return { kind: 'mismatch', seat: name, oldPane: performed.oldPane, pane: performed.pane, readBack: performed.readBack };
      }
      // The seat is on the new declaration and the screen agrees: the request is done.
      finishSwap(dir, name, swap.queuedAt);
      logLine(dir, 'swap', input.by, `${name}: swapped ${from} -> ${to} (${how})`, now());
      logLine(
        dir,
        'swap',
        input.by,
        performed.readBack.kind === 'match'
          ? `${name}: read-back: ${performed.readBack.model}`
          : `${name}: read-back: unread — the swap is not verified`,
        now(),
      );
      return {
        kind: 'ready',
        seat: name,
        oldPane: performed.oldPane,
        pane: performed.pane,
        readBack: performed.readBack,
        ...(resume === undefined ? {} : { resumed: resume }),
        ...(performed.handover === undefined ? {} : { handover: performed.handover }),
      };
    }
    case 'replaced':
      return { kind: 'retry', seat: name, why: 'the pane is not the seat\'s own process; the queue stands' };
    case 'abandon-working':
      return { kind: 'retry', seat: name, why: 'the seat is mid-turn; the queue stands' };
    case 'busy':
      return { kind: 'retry', seat: name, why: `${performed.message}; the queue stands` };
    case 'run-lock':
      return { kind: 'retry', seat: name, why: `another run holds the session's run lock; the queue stands` };
    case 'herdr':
      return { kind: 'retry', seat: name, why: 'herdr cannot be read; the queue stands' };
    case 'not-ready': {
      logLine(dir, 'swap', input.by, `${name}: the swap was refused: ${performed.message}`, now());
      return { kind: 'failed', seat: name, why: performed.message };
    }
    case 'dry':
      // The run never asks for a dry answer; a plan here can only be a bug.
      return { kind: 'failed', seat: name, why: 'the swap run returned a dry plan' };
    default: {
      const unknown: never = performed;
      throw new Error(`swap: unhandled result ${JSON.stringify(unknown)}`);
    }
  }
}

/** Why a swap that is not due waits, in the words the run prints. Past the deadline the pause is
 *  the observed screen — a running turn, a dialog or text nobody sent — never a clock that has
 *  already run out. */
function waitWhy(swap: QueuedSwap, observed: SwapObservation, now: Date): string {
  if (Date.parse(swap.deadline) > now.getTime()) return 'not due yet';
  if (observed.nativeHeld === true) return 'past its wait; the native presence proof holds the seat';
  if (observed.unsent) return 'past its wait; the input box holds unsent text';
  if (observed.working) return 'past its wait; the seat is mid-turn';
  if (observed.prompt) return 'past its wait; the seat is at a dialog';
  return 'past its wait';
}

/** The recorded session id the launch resumes, when resuming is possible at all: the CLI stays
 *  the same and the profile says it keeps sessions. Undefined otherwise — the run asks for a
 *  handover instead. */
function resumeIdFor(input: SwapRunOptions, declared: Seat, swap: QueuedSwap): string | undefined {
  if (declared.cli !== swap.to.cli) return undefined;
  if (!supportsSessionResume(swap.to.cli)) return undefined;
  return latestSessionOf(input.home, input.team, input.root, input.session, declared.name)?.cli_session;
}

/** The model fields a swap writes into the file: the five every recipe names, and the optional
 *  ones a recipe brought. A field the recipe omits is removed — an account never outlives the
 *  vendor it paid, and an old effort word is not the new CLI's. */
export function recipeOf(swap: QueuedSwap): SeatModelFields {
  return {
    cli: swap.to.cli,
    vendor: swap.to.vendor,
    model: swap.to.model,
    version: swap.to.version,
    display: swap.to.display,
    launch: swap.to.launch,
    ...(swap.to.modelFrom === undefined ? {} : { modelFrom: swap.to.modelFrom }),
    ...(swap.to.effort === undefined ? {} : { effort: swap.to.effort }),
    ...(swap.to.account === undefined ? {} : { account: swap.to.account }),
  };
}

/** The seat as the file will declare it once the run's write lands: everything the file said
 *  stays, the model fields are the recipe's, and an optional field the recipe does not name is
 *  gone rather than inherited from the old model. */
export function seatOf(declared: Seat, swap: QueuedSwap): Seat {
  const next: Seat = {
    ...declared,
    cli: swap.to.cli,
    vendor: swap.to.vendor,
    model: swap.to.model,
    version: swap.to.version,
    display: swap.to.display,
    launch: swap.to.launch,
    ...(swap.to.account === undefined ? {} : { account: swap.to.account }),
    ...(swap.to.modelFrom === undefined ? {} : { modelFrom: swap.to.modelFrom }),
    ...(swap.to.effort === undefined ? {} : { effort: swap.to.effort }),
  };
  if (swap.to.account === undefined) delete next.account;
  if (swap.to.modelFrom === undefined) delete next.modelFrom;
  if (swap.to.effort === undefined) delete next.effort;
  return next;
}

/**
 * The file's new declaration, written after the old pane is closed and before the launch, which
 * reads the file's own words. The write is validated whole (`writeTeamFile`), so a recipe the
 * schema refuses leaves the file as it was; a seat taken out of the file since the queue was
 * written is said, never re-added. A failure is the caller's abort: nothing is launched from a
 * file the run could not rewrite (the ruling of 2026-10-19).
 */
function declareRecipe(path: string, name: string, fields: SeatModelFields, home: string): { ok: true } | { ok: false; why: string } {
  const where = { home, command: 'swap' };
  let text: string;
  try {
    text = readTeamText(path, where);
  } catch (error) {
    return { ok: false, why: `${teamPlace(path, where, 'the file')} cannot be read (${messageOf(error)})` };
  }
  if (!hasSeat(text, name)) return { ok: false, why: `${name} is no longer in ${teamPlace(path, where, 'the file')}` };
  const written = writeTeamText(path, rewriteSeatModel(text, name, fields), where);
  if (!written.ok) return { ok: false, why: problemText(written.errors[0]) };
  return { ok: true };
}

function problemText(problem: Problem | undefined): string {
  if (problem === undefined) return 'the rewritten file is invalid';
  return `${problem.line === undefined ? '' : `line ${problem.line}: `}${problem.message}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
