// One watchdog slice. It decides from the proof and the memory it already holds, starts at
// most one restart, and returns before that restart finishes. The restart is `team restart
// <seat> --json` with no handover path and no checkpoint ask: the command reads what is on
// record, and this step reads the ready result.

import { DIALOG_LEAD, WATCHDOG_AFTER_MS, WATCHDOG_AUTO_RESTART, liveChild, proofNow, screenDigest, type ProcessRow } from './proof.ts';
import { restartArgs, type RestartReady } from './restart.ts';

export type SessionRead = { kind: 'bound' } | { kind: 'none' | 'refused'; why: string };

export type WatchdogSeat = {
  seat: string;
  cli: string;
  reconciled: string;
  hostStatus: string;
  plain: string | null;
  screenKind: string | null;
  presenceAt: string | null;
  processes: readonly ProcessRow[] | null;
  session: SessionRead;
  /** The resume form `withResume` returned, or null when this CLI has none. */
  resume: string | null;
};

export type WatchdogLimits = { afterMs: number; autoRestart: number };

export const WATCHDOG_LIMITS: WatchdogLimits = {
  afterMs: WATCHDOG_AFTER_MS,
  autoRestart: WATCHDOG_AUTO_RESTART,
};

type SeatMemory = {
  since: number | null;
  digest: string | null;
  presenceAt: string | null;
  window: boolean;
  inFlight: boolean;
  toldDialog: string | null;
  toldHung: boolean;
  toldResume: boolean;
  toldSession: boolean;
  toldSecond: boolean;
  toldOff: boolean;
  stillMs: number;
  /** The stillness clock is counting a live child, not a stall that may restart. */
  child: boolean;
};

export type WatchdogState = {
  seats: Map<string, SeatMemory>;
};

export type WatchdogEffect =
  | { kind: 'restart'; seat: string; args: readonly string[] }
  | { kind: 'lead'; text: string };

export function watchdogState(): WatchdogState {
  return { seats: new Map() };
}

function memoryOf(state: WatchdogState, seat: string): SeatMemory {
  const found = state.seats.get(seat);
  if (found !== undefined) return found;
  const fresh: SeatMemory = {
    since: null,
    digest: null,
    presenceAt: null,
    window: false,
    inFlight: false,
    toldDialog: null,
    toldHung: false,
    toldResume: false,
    toldSession: false,
    toldSecond: false,
    toldOff: false,
    stillMs: 0,
    child: false,
  };
  state.seats.set(seat, fresh);
  return fresh;
}

function resetClock(memory: SeatMemory): void {
  memory.since = null;
  memory.digest = null;
  memory.presenceAt = null;
}

function lead(text: string): WatchdogEffect {
  return { kind: 'lead', text };
}

/** The words the lead hears when a restart has become ready. The path stays off the message. */
export function restartLandedText(seat: string, stillMs: number, ready: RestartReady): string {
  const minutes = Math.floor(stillMs / 60_000);
  const waited = minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
  const handover = ready.handover !== undefined
    ? 'a handover file was already there'
    : ready.handoverAsked !== undefined
      ? 'the checkpoint may be stale'
      : 'no handover file was there';
  return `${seat}: restarted after ${waited} with the screen unchanged; the recorded conversation was resumed; ${handover}`;
}

export function watchdogPass(
  state: WatchdogState,
  seats: readonly WatchdogSeat[],
  now: number,
  limits: WatchdogLimits = WATCHDOG_LIMITS,
): WatchdogEffect[] {
  const effects: WatchdogEffect[] = [];
  const seen = new Set(seats.map((seat) => seat.seat));
  for (const name of [...state.seats.keys()]) {
    if (!seen.has(name)) state.seats.delete(name);
  }
  for (const seat of seats) {
    effects.push(...oneSeat(state, seat, now, limits));
  }
  return effects;
}

function oneSeat(state: WatchdogState, seat: WatchdogSeat, now: number, limits: WatchdogLimits): WatchdogEffect[] {
  const memory = memoryOf(state, seat.seat);
  if (seat.reconciled === 'idle' || seat.reconciled === 'done') {
    memory.window = false;
    memory.toldSecond = false;
    memory.toldHung = false;
    memory.toldResume = false;
    memory.toldSession = false;
    memory.toldOff = false;
    memory.toldDialog = null;
    resetClock(memory);
    return [];
  }
  const kind = seat.screenKind;
  if (kind !== null && (DIALOG_LEAD as readonly string[]).includes(kind)) {
    resetClock(memory);
    memory.toldHung = false;
    if (memory.toldDialog === kind) return [];
    memory.toldDialog = kind;
    return [lead(`${seat.seat}: the screen is ${kind}`)];
  }
  memory.toldDialog = null;
  const reading = proofNow(seat);
  if (!reading.holds) {
    if (reading.why === 'child' && hung(seat)) {
      return hungLead(memory, seat, now, limits.afterMs);
    }
    memory.toldHung = false;
    resetClock(memory);
    return [];
  }
  if (memory.child) {
    memory.child = false;
    memory.toldHung = false;
    memory.since = now;
    memory.digest = reading.digest;
    memory.presenceAt = reading.presenceAt;
    return [];
  }
  memory.toldHung = false;
  if (memory.since === null || memory.digest !== reading.digest || memory.presenceAt !== reading.presenceAt) {
    memory.since = now;
    memory.digest = reading.digest;
    memory.presenceAt = reading.presenceAt;
    return [];
  }
  const still = now - memory.since;
  if (still < limits.afterMs) return [];
  memory.stillMs = still;
  if (seat.resume === null) {
    if (memory.toldResume) return [];
    memory.toldResume = true;
    return [lead(`${seat.seat}: this CLI has no resume form`)];
  }
  if (seat.session.kind !== 'bound') {
    if (memory.toldSession) return [];
    memory.toldSession = true;
    return [lead(`${seat.seat}: ${seat.session.why}`)];
  }
  if (limits.autoRestart < 1) {
    if (memory.toldOff) return [];
    memory.toldOff = true;
    return [lead(`${seat.seat}: automatic restart is off`)];
  }
  if (memory.window) {
    if (memory.inFlight || memory.toldSecond) return [];
    memory.toldSecond = true;
    return [lead(`${seat.seat}: a second stall in the restart window`)];
  }
  if (memory.inFlight) return [];
  memory.window = true;
  memory.inFlight = true;
  return [{ kind: 'restart', seat: seat.seat, args: restartArgs(seat.seat) }];
}

/** The other three stall facts, for a child that is itself why the proof fails. */
function hung(seat: WatchdogSeat): boolean {
  return seat.reconciled === 'working'
    && seat.plain !== null
    && seat.screenKind !== null
    && seat.processes !== null
    && liveChild(seat.processes);
}

function hungLead(memory: SeatMemory, seat: WatchdogSeat, now: number, afterMs: number): WatchdogEffect[] {
  const digest = seat.plain === null ? null : screenDigest(seat.plain);
  if (memory.since === null || memory.digest !== digest || memory.presenceAt !== seat.presenceAt) {
    memory.since = now;
    memory.digest = digest;
    memory.presenceAt = seat.presenceAt;
    memory.toldHung = false;
    memory.child = true;
    return [];
  }
  memory.child = true;
  if (now - memory.since < afterMs) return [];
  if (memory.toldHung) return [];
  memory.toldHung = true;
  return [lead(`${seat.seat}: a live child is still running`)];
}

/** The restart finished. The window stays open until the seat is next seen idle or done. */
export function noteRestartFinished(state: WatchdogState, seat: string): void {
  const memory = state.seats.get(seat);
  if (memory === undefined) return;
  memory.inFlight = false;
}

export function stillMsOf(state: WatchdogState, seat: string): number {
  return state.seats.get(seat)?.stillMs ?? 0;
}

export type WatchdogRun = {
  seats: readonly WatchdogSeat[];
  now: number;
  limits?: WatchdogLimits;
  restart(seat: string, args: readonly string[]): Promise<RestartReady | { kind: 'failed' }>;
  lead(text: string): void;
};

/**
 * One slice. A restart's promise is left running: this function resolves when the decision
 * is recorded, and the ready message is sent from the promise, not from this wait.
 */
export async function runWatchdogSlice(state: WatchdogState, run: WatchdogRun): Promise<void> {
  const effects = watchdogPass(state, run.seats, run.now, run.limits);
  for (const effect of effects) {
    if (effect.kind === 'lead') {
      run.lead(effect.text);
      continue;
    }
    const still = stillMsOf(state, effect.seat);
    const pending = run.restart(effect.seat, effect.args);
    pending.then((ready) => {
      noteRestartFinished(state, effect.seat);
      if (ready.kind === 'ready') run.lead(restartLandedText(effect.seat, still, ready));
      else run.lead(`${effect.seat}: the restart did not become ready`);
    }, () => {
      noteRestartFinished(state, effect.seat);
      run.lead(`${effect.seat}: the restart did not become ready`);
    });
  }
  await Promise.resolve();
}
