import type { HerdrAgent, HerdrWorkspace, PaneProcesses } from '../herdr.ts';
import { seatProcessVerdict, type LaunchedIdentity } from './identity.ts';
import { IDLE_POLL_MS } from './plan.ts';
import type { Classification } from './progress.ts';
import type { SeatState } from '../state.ts';
import type { Key } from './terminal.ts';

// A seat that stopped at a dialog `team` may not answer, with its owner at the terminal.
//
// The pause is the whole of the interaction: it records the seat as waiting for its owner —
// with the process identity read at that moment, in the same write — draws the record, and asks
// with one exact line, and waits at most the profile's idle timeout for that line. A trust or
// permission prompt that nobody answers cannot hold the run: the budget ends, the seat is left
// as it is, and the caller goes on. `o` focuses the pane and never sends a key or a text into
// it: from there the owner works in her own pane, and this loop polls the screen until it
// reaches its prompt, stops at something else, or runs out the profile's idle timeout — then
// asks again, with a new budget. `s` closes
// the seat's workspace without input and clears its state. `q` and Ctrl-C stop cleanly: the
// caller (execute) closes what this invocation created and writes the stopped records.
//
// The seat lock is taken before each of resume, open, skip and close, and released before the
// prompt is shown: nothing holds the lock while the owner looks at the terminal or while a pane
// is polled. A pane is never typed into, and the workspace of a seat this run did not create is
// never closed.
//
// Under a `dialogs.trust` team grant the prompt is also re-read on a tick: `team answer`
// may be racing this run, so every timeout and every return takes the lock, reads the state and
// the pane fresh, and follows what it finds — a seat that became ready, a recovery `answer` left
// behind (which is shown and offers the same keys), or the screen's own reading. No trust key is
// ever sent from here.

/** The waiting record a state carries, as this module writes it. */
export type WaitingRecord = NonNullable<SeatState['waiting']>;

export type PauseInput = {
  seat: string;
  /** The fresh reading that stopped the seat: a dialog, or the idle wait's timeout. */
  classification: Classification;
  pane: string;
  workspace?: string;
  /** The label this seat's launch gives its workspace — what `up` set when it created one
   *  (`plan.ts` labels a seat's workspace with `seat.label`). The proof compares it with the
   *  workspace's live label before anything acts on the pane. */
  label: string;
  /** The relaunch repair as the team file names it for this seat (`relaunchRepair`'s markdown
   *  text): a lead seat is told only `team down` then `team up`, never a `remove --keep` its
   *  file would refuse. Every refusal that names a repair prints this one. */
  repairLine: string;
  /** The waiting record this run resumed into, when the seat was already recorded waiting. */
  recorded?: WaitingRecord;
};

export type PauseResult =
  | { kind: 'idle' }
  | { kind: 'ready'; detail: string }
  | { kind: 'skipped' }
  | { kind: 'stopped' }
  | { kind: 'left out'; reason: string; detail: string };

/** A screen reading: the pane's kind, or one of the classifications a pause can name. */
export type ScreenReading = 'idle' | 'working' | Classification;

export type PauseHost = {
  /** The seat's exclusive lock: its release, or the pid holding it. */
  lock(): { release(): void } | { held: number };
  /** The seat's state, freshly read. */
  state(): SeatState | undefined;
  /** Writes the waiting record — the seat's launched identity, read now, goes in the same
   *  write — with `change` editing the record that is there (or the entry one). */
  write(change: (prior: WaitingRecord | undefined) => WaitingRecord): void;
  /** Removes the waiting field alone: the seat reached its prompt and continues. */
  clear(): void;
  /** Removes the seat's whole launch state: its workspace has been closed. */
  drop(): void;
  /** A fresh screen read of the pane. */
  screen(): ScreenReading;
  /** The pane's process identity now; null when herdr can't tell. */
  process(): PaneProcesses | null;
  /** The session's agents now; null when herdr can't tell. */
  agents(): HerdrAgent[] | null;
  /** The session's workspaces with their labels now; null when herdr can't tell. */
  workspaces(): HerdrWorkspace[] | null;
  /** The session's recorded seats now, as the state file has them; null when unreadable. The
   *  proof reads them to refuse a pane or workspace the state names for two seats. */
  seats(): Record<string, SeatState> | null;
  /** Pane ids in a workspace as herdr lists them now; null when the list can't be read. A close
   *  reads it directly before closing, to bind the workspace to the pane just verified. */
  workspacePanes(workspace: string): string[] | null;
  /** Brings the pane to the owner's attention. Sends no key and no text. */
  focus(): boolean;
  /** Closes the seat's workspace, without input. */
  close(workspace: string): boolean;
  /** The seat's waiting record, drawn provisionally while its prompt is open. */
  record(classification: string): void;
  /** One prompt line, on its own line. */
  prompt(line: string): void;
  /** Every byte already pending is read and discarded: type-ahead never answers a prompt, and
   *  a paste that arrived before the prompt is never read as a key by it. */
  drain(): void;
  /** A line said beside the record: a failed focus, a lock another command holds. */
  say(line: string): void;
  /** The seat entered the pause this run: the caller logs its one transition line. */
  entering(classification: Classification): void;
  key(ms: number): Promise<Key>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** The seat's idle timeout, in seconds: how long an opened pane is polled. */
  idleTimeout: number;
  /** Whether the prompt is re-read on a tick and the state and pane refreshed each time
   *  (a trust dialog under a policy that names the lead). */
  polled: boolean;
};

/** The one key that moves the seat itself; everything else reprints the prompt. */
function promptLine(seat: string, at: string): string {
  return `${seat} is waiting at ${at}: [o] open pane, [s] skip seat, [q] stop cleanly`;
}

/** What the record and prompt show: the classification, or the recovery `answer` left behind. */
type View = { classification: string; recovery: boolean };

function display(view: View): string {
  return view.recovery ? 'trust sent; recovery required' : view.classification;
}

/** The repair for a waiting record whose pane is gone or no longer holds the seat: the team
 *  file's own repair for this seat (`relaunchRepair`), never a `remove --keep` a lead seat's
 *  file would refuse. */
export function goneDetail(proof: Pick<WaitingProof, 'repairLine'>): string {
  return `  its record still names it; ${proof.repairLine}, clears it\n`;
}

/** The fresh reads that prove a waiting record's pane is still the seat's: herdr's agent list,
 *  the pane's process, the workspaces with their labels, and the session's recorded seats. A
 *  `PauseHost` has all four; so does `execute`'s host, through its four hooks. */
export type WaitingReads = {
  agents(): HerdrAgent[] | null;
  process(): PaneProcesses | null;
  workspaces(): HerdrWorkspace[] | null;
  seats(): Record<string, SeatState> | null;
};

/** What must be proven about a pane before anything acts on the waiting record that names it. */
export type WaitingProof = {
  seat: string;
  pane: string;
  /** The workspace the record names; the proof refuses when the pane lives in another one. */
  workspace?: string;
  /** The label this seat's launch gives its workspace (`up` sets it when it creates one). */
  label: string;
  /** The team file's repair for this seat (`relaunchRepair`'s markdown text), printed by any
   *  refusal that names one: for a lead seat only `team down` then `team up`. */
  repairLine: string;
  /** The process identity recorded with the waiting record. Absent: nothing is acted on — the
   *  record alone cannot prove the pane is the seat's, and a run must establish one. */
  launched?: LaunchedIdentity;
};

/** A refusal: the words for the seat's record, and the detail line said under it. */
export type WaitingProblem = { reason: string; detail: string };

/** The repair for a waiting record that can prove nothing: the record is cleared and the seat is
 *  started again by a run, so the next wait is recorded with the identity read in that same
 *  write. It begins with the step `team down` and `team remove` never take — they answer no
 *  prompt and touch no agent they cannot name — read from the pane the record names: a pane the
 *  multiplexer lists under this seat's name is a CLI at its dialog, answered or closed in its
 *  pane; any other pane (no name, another name, or a list that cannot be read) is closed. Then
 *  the team file's own repair for this seat (`relaunchRepair`): an ordinary seat is told
 *  `team remove <seat> --keep`, then `team add <seat>`; a lead seat only `team down`, then
 *  `team up`, which its file would otherwise refuse. */
function identityDetail(proof: Pick<WaitingProof, 'seat' | 'pane' | 'repairLine'>, reads: WaitingReads): string {
  const named = reads.agents()?.some((agent) => agent.pane === proof.pane && agent.name === proof.seat) ?? false;
  const step = named ? 'answer or close its dialog in its pane' : 'close that pane';
  return `  ${step}, then run ${proof.repairLine}, to establish one by a run\n`;
}

/**
 * Whether the pane a waiting record names is proven this seat's, from fresh reads alone. The
 * state file lives in the project and any seat can write it: a waiting record is a hint of where
 * to look, never an authority. The pane must not be named by any other seat's record of this
 * session (neither its pane nor its workspace), the multiplexer must list its agent as unnamed
 * or already carrying this seat's name, the workspace must carry the label this seat's launch
 * set, and the process must still be the recorded one. Anything else, or a read that cannot be
 * made, refuses. What this cannot tell apart is same-user limit, not a bug: a seat that also
 * renames the pane and relabels the workspace to match, and edits every seat's record, is
 * indistinguishable from the seat itself.
 */
export function waitingProblem(reads: WaitingReads, proof: WaitingProof): WaitingProblem | null {
  if (!proof.launched) {
    return {
      reason: 'its waiting record has no process identity',
      detail: identityDetail(proof, reads),
    };
  }
  const seats = reads.seats();
  if (seats === null) return { reason: 'its session\'s seat records could not be read', detail: '' };
  const other = Object.entries(seats).find(
    ([name, state]) =>
      name !== proof.seat
      && (state.pane === proof.pane || (proof.workspace !== undefined && state.workspace === proof.workspace)),
  );
  if (other) {
    const what = other[1].pane === proof.pane ? 'pane' : 'workspace';
    return {
      reason:
        `the state names one ${what} for two seats (${proof.seat} and ${other[0]}); ` +
        'nothing renamed, nothing closed, the state as it was',
      detail: '',
    };
  }
  const agents = reads.agents();
  if (!agents) return { reason: 'its waiting pane could not be read', detail: goneDetail(proof) };
  const listed = agents.find((agent) => agent.pane === proof.pane);
  if (!listed) return { reason: 'its waiting pane is gone', detail: goneDetail(proof) };
  if (listed.name !== null && listed.name !== proof.seat) {
    return {
      reason: `the multiplexer names ${listed.name} in its pane, not ${proof.seat}; nothing renamed, nothing closed, the state as it was`,
      detail: '',
    };
  }
  if (proof.workspace !== undefined && listed.workspace !== proof.workspace) {
    return {
      reason: `its pane is in workspace ${listed.workspace}, not its recorded ${proof.workspace}; nothing renamed, nothing closed, the state as it was`,
      detail: '',
    };
  }
  const workspaces = reads.workspaces();
  if (!workspaces) return { reason: 'its workspace could not be read', detail: goneDetail(proof) };
  const space = workspaces.find((workspace) => workspace.id === listed.workspace);
  if (!space) return { reason: 'its workspace is gone', detail: goneDetail(proof) };
  if (space.label !== proof.label) {
    return {
      reason: `its workspace is labelled ${space.label}, not ${proof.label}; nothing renamed, nothing closed, the state as it was`,
      detail: '',
    };
  }
  const verdict = seatProcessVerdict(proof.launched, reads.process());
  if (verdict === 'gone' || verdict === 'replaced') {
    return { reason: 'its waiting pane holds another process', detail: goneDetail(proof) };
  }
  if (verdict === 'unknown') {
    return { reason: 'its waiting pane could not be read', detail: goneDetail(proof) };
  }
  return null;
}

/** What must be proven about a workspace before it is closed. */
export type CloseProof = {
  seat: string;
  pane: string;
  /** The workspace the record names. A live id that differs refuses; it is never closed. */
  workspace?: string;
  /** The team file's repair for this seat, for a refusal that leaves the record in place. */
  repairLine: string;
  launched?: LaunchedIdentity;
};

/** The fresh reads a close is proven with: the agent list, the workspace's panes, the process. */
export type CloseReads = {
  agents(): HerdrAgent[] | null;
  workspacePanes(workspace: string): string[] | null;
  process(): PaneProcesses | null;
};

/**
 * The workspace to close, or the refusal that says why nothing is closed. The workspace is the
 * one the multiplexer returned for the pane just verified, never the stored one when they
 * differ; it must hold that pane and be its only agent pane; and the pane's process must still
 * be the recorded one. Reads are made by the caller directly before this call, with nothing
 * between it and the close.
 */
export function closeTarget(reads: CloseReads, proof: CloseProof): { workspace: string } | { problem: WaitingProblem } {
  const agents = reads.agents();
  if (!agents) return { problem: { reason: 'its waiting pane could not be read', detail: goneDetail(proof) } };
  const listed = agents.find((agent) => agent.pane === proof.pane);
  if (!listed) return { problem: { reason: 'its waiting pane is gone', detail: goneDetail(proof) } };
  if (proof.workspace !== undefined && listed.workspace !== proof.workspace) {
    return {
      problem: {
        reason: `its pane is in workspace ${listed.workspace}, not its recorded ${proof.workspace}; nothing closed, the state as it was`,
        detail: '',
      },
    };
  }
  const panes = reads.workspacePanes(listed.workspace);
  if (panes === null) return { problem: { reason: 'its workspace could not be read; nothing closed', detail: goneDetail(proof) } };
  if (!panes.includes(proof.pane)) {
    return { problem: { reason: 'its workspace does not hold its pane; nothing closed', detail: goneDetail(proof) } };
  }
  const agentPanes = new Set(agents.map((agent) => agent.pane));
  if (panes.some((pane) => pane !== proof.pane && agentPanes.has(pane))) {
    return {
      problem: {
        reason: 'its workspace holds another seat\'s pane; nothing closed (close its pane there, then run team up)',
        detail: '',
      },
    };
  }
  if (!proof.launched) {
    return { problem: { reason: 'its process is not recorded; left as it is', detail: '' } };
  }
  const verdict = seatProcessVerdict(proof.launched, reads.process());
  if (verdict === 'gone' || verdict === 'replaced') {
    return { problem: { reason: 'left as it is: its process changed', detail: goneDetail(proof) } };
  }
  if (verdict === 'unknown') {
    return { problem: { reason: 'its pane could not be read; nothing closed', detail: goneDetail(proof) } };
  }
  return { workspace: listed.workspace };
}

type Outcome =
  | { kind: 'done'; result: PauseResult }
  | { kind: 'view'; view: View }
  /** The lock is another command's: nothing was done, the prompt asks again. */
  | { kind: 'held' };

const leftOut = (problem: WaitingProblem): Outcome => ({
  kind: 'done',
  result: { kind: 'left out', reason: problem.reason, detail: problem.detail },
});

/** The proof a `PauseHost` can make of its own pane, against one fresh state read. */
function proofOf(input: PauseInput, state: SeatState | undefined): WaitingProof {
  const workspace = input.workspace ?? state?.workspace;
  return {
    seat: input.seat,
    pane: input.pane,
    ...(workspace ? { workspace } : {}),
    label: input.label,
    repairLine: input.repairLine,
    ...(state?.launched ? { launched: state.launched } : {}),
  };
}

export async function runPause(input: PauseInput, host: PauseHost): Promise<PauseResult> {
  // The first write. A seat resumed out of a recovery keeps the record exactly as the answer
  // left it — only the owner's path clears that, and it clears it by finishing the seat. A seat
  // resumed from a recorded wait was written by the caller's own resume, under the seat lock:
  // this entry writes only when it is the first to record the seat, so nothing here can ever
  // overwrite a recovery a concurrent `team answer` just wrote.
  let view: View;
  if (input.recorded?.state === 'trust-sent-recovery') {
    view = { classification: input.recorded.classification, recovery: true };
  } else if (input.recorded) {
    view = { classification: input.classification, recovery: false };
  } else {
    view = { classification: input.classification, recovery: false };
    host.write((prior) => ({
      state: 'waiting-owner',
      classification: input.classification,
      ...(prior?.manual ? { manual: true as const } : {}),
    }));
  }
  host.entering(input.classification);
  host.record(display(view));
  // One unattended ask, bounded by the profile's idle timeout. A polled prompt spends that
  // same budget across its ticks.
  let askedUntil = host.now() + host.idleTimeout * 1000;

  try {
    for (;;) {
      const remaining = askedUntil - host.now();
      if (remaining <= 0) return unanswered(host.idleTimeout);
      // Bytes typed before this prompt was drawn were typed for something else — a keystroke
      // held down, a paste, a line the owner forgot — and are read and discarded, never
      // answered: the prompt that follows asks about the pane as it is now.
      host.drain();
      host.prompt(promptLine(input.seat, display(view)));
      const slice = host.polled ? Math.min(IDLE_POLL_MS, remaining) : remaining;
      const key = await host.key(slice);
      if (key === 'q') {
        // Ctrl-C reads as `q` in raw mode: the owner's own decision to stop cleanly.
        return { kind: 'stopped' };
      }
      if (key === 'eof') {
        // End of input is not `q`: nobody is at the terminal any more. The run stops asking and
        // leaves the seat exactly as it is — pane, workspace and waiting record — saying so.
        return { kind: 'left out', reason: 'its input ended; left as it is', detail: '' };
      }
      if (key === 'o') {
        const outcome = await open(input, host);
        if (outcome.kind === 'done') return outcome.result;
        if (outcome.kind === 'view') {
          view = outcome.view;
          host.record(display(view));
        }
        // The owner took the pane. The poll had its own deadline; the ask that follows starts again.
        askedUntil = host.now() + host.idleTimeout * 1000;
        continue;
      }
      if (key === 's') {
        const outcome = await skip(input, host, display(view));
        if (outcome.kind === 'done') return outcome.result;
        continue;
      }
      if (key === 'timeout') {
        // The read used the time it was given. A poll that still has budget left looks again;
        // the last slice, or a clock already past the ask, ends it.
        if (host.now() >= askedUntil || slice >= remaining) return unanswered(host.idleTimeout);
        const outcome = await refresh(input, host, view);
        if (outcome.kind === 'done') return outcome.result;
        if (outcome.kind === 'view') {
          view = outcome.view;
          host.record(display(view));
        }
        continue;
      }
      // Any other input — a paste, a burst of bytes, any key that is not o, s, q or Ctrl-C: the
      // exact prompt again, and nothing else.
    }
  } finally {
    // The pause is over; whatever is still pending was typed for a prompt that no longer exists.
    // On this runtime that is every byte Node's stream has already buffered — a byte still in the
    // terminal's own buffer, or one arriving after this drain, is read by whatever runs next.
    host.drain();
  }
}

/** `o`: the owner takes the pane. The record says so, the pane is focused, and the screen is
 *  polled to the deadline. No key, no text. */
async function open(input: PauseInput, host: PauseHost): Promise<Outcome> {
  const lock = host.lock();
  if ('held' in lock) {
    host.say(`  ${input.seat}: another command holds it; try [o] again\n`);
    return { kind: 'held' };
  }
  try {
    const state = host.state();
    if (state?.stage === 'ready') return { kind: 'done', result: ready(input.seat) };
    const problem = waitingProblem(host, proofOf(input, state));
    if (problem) return leftOut(problem);
    host.write((prior) => ({
      ...(prior ?? { state: 'waiting-owner', classification: input.classification }),
      manual: true,
    }));
  } finally {
    lock.release();
  }
  if (!host.focus()) host.say(`  ${input.seat}: its pane could not be focused; open it yourself\n`);

  const deadline = host.now() + host.idleTimeout * 1000;
  for (;;) {
    if (host.now() >= deadline) return { kind: 'view', view: { classification: 'timeout', recovery: false } };
    await host.sleep(IDLE_POLL_MS);
    const held = host.lock();
    if ('held' in held) continue;
    try {
      const state = host.state();
      if (state?.stage === 'ready') return { kind: 'done', result: ready(input.seat) };
      const problem = waitingProblem(host, proofOf(input, state));
      if (problem) return leftOut(problem);
      if (state?.waiting?.state === 'trust-sent-recovery') {
        return { kind: 'view', view: { classification: state.waiting.classification, recovery: true } };
      }
      const kind = host.screen();
      if (kind === 'idle') {
        host.clear();
        return { kind: 'done', result: { kind: 'idle' } };
      }
      if (kind === 'working') continue;
      return { kind: 'view', view: { classification: kind, recovery: false } };
    } finally {
      held.release();
    }
  }
}

/** `s`: the seat is skipped. Its workspace is closed without input, its state cleared. A close
 *  that fails says so under the reading the prompt showed, the same line the run's own close of
 *  a dialog would write — nothing claims a close that did not happen. */
async function skip(input: PauseInput, host: PauseHost, at: string): Promise<Outcome> {
  const lock = host.lock();
  if ('held' in lock) {
    host.say(`  ${input.seat}: another command holds it; try [s] again\n`);
    return { kind: 'held' };
  }
  try {
    const state = host.state();
    const problem = waitingProblem(host, proofOf(input, state));
    if (problem) return leftOut(problem);
    // The close is the one destructive act here, and the state's workspace id is a hint: the
    // workspace read from the multiplexer for the pane just verified is the one closed, and only
    // when it holds that pane and no other seat's. `closeTarget` is called with the reads above
    // as the last reads before the close.
    const target = closeTarget(host, proofOf(input, state));
    if ('problem' in target) return leftOut(target.problem);
    if (!host.close(target.workspace)) {
      return { kind: 'done', result: { kind: 'left out', reason: `${at}; its workspace did not close; left as it is`, detail: '' } };
    }
    host.drop();
    return { kind: 'done', result: { kind: 'skipped' } };
  } finally {
    lock.release();
  }
}

/** The tick under the lead-answers policy: the state and the pane are read fresh, and whatever
 *  they show decides — ready, recovery, the screen's own reading, or a prompt that asks again. */
async function refresh(input: PauseInput, host: PauseHost, view: View): Promise<Outcome> {
  const lock = host.lock();
  if ('held' in lock) return { kind: 'held' };
  try {
    const state = host.state();
    if (state?.stage === 'ready') return { kind: 'done', result: ready(input.seat) };
    const problem = waitingProblem(host, proofOf(input, state));
    if (problem) return leftOut(problem);
    if (state?.waiting?.state === 'trust-sent-recovery') {
      return { kind: 'view', view: { classification: state.waiting.classification, recovery: true } };
    }
    const kind = host.screen();
    if (kind === 'idle') {
      // The owner answered in the pane between ticks: the seat can finish normally.
      host.clear();
      return { kind: 'done', result: { kind: 'idle' } };
    }
    if (kind === 'working') return { kind: 'view', view };
    return { kind: 'view', view: { classification: kind, recovery: false } };
  } finally {
    lock.release();
  }
}

/** The ask ran out its idle timeout with no key. The seat stays as it is: nothing focused,
 *  nothing closed, the waiting record kept, and the run goes on to the next seat. */
function unanswered(seconds: number): PauseResult {
  return { kind: 'left out', reason: `timed out after ${seconds} s waiting for an answer; left as it is`, detail: '' };
}

/** The seat was made ready under this run's feet, by the orchestrator's `team answer`. */
function ready(seat: string): PauseResult {
  return { kind: 'ready', detail: `  ${seat} was answered while its prompt was open; it is ready\n` };
}
