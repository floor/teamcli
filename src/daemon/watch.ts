// The watch host: one per hosted route, driven by the machine daemon's existing heartbeat.
//
// The host adds no loop and no timer. It runs one serial pass of the shared watch loop at a
// time, releases that pass's wait exactly when the wait's own due instant has passed, and
// records what it saw so a reader can tell a watch that is cycling from one that is standing
// down or has failed. Nothing here types into a pane, writes a bus event or places an owner:
// the hosted source set closes every mutating source. Outbound effects are recorded as
// `blocked` until a verified admitted sender is injected, and the record says so.
//
// A run that leaves without the host asking is a fault, not an intention. The host counts it,
// says why in the record, and starts a fresh run on its next heartbeat tick. That beat is five
// seconds, half the ten-second sweep floor, so the next pass is always due within one in-force
// watch interval. A deliberate stop, a loop that stood down to a live pane watch, and a run a
// pulse closed are the host's own decisions: they are never counted and never restarted.
//
// `fault(why)` is the one diagnostic entry into that recovery path, and it is deliberately not a
// second recovery implementation: it ends the run currently in flight at the run's own seam, and
// the exit then takes the ordinary unexpected-exit path (counted once, restarted on the next
// beat). It never signals a process, never touches another route and never starts a run.

import { routeId, type HostedRoute } from './routes.ts';
import type { HostedLoop, HostedWatchHandle, HostedWatchState } from '../watch/hosted.ts';

export type HostedWatchInput = {
  route: HostedRoute;
  /** Runs the shared watch loop under this host; resolves with the loop's own exit code. A
   *  fresh run is started on the next heartbeat tick whenever this one leaves unexpectedly. */
  run(loop: HostedLoop): Promise<number>;
  /** Whether a route may emit an effect now. A getter makes the recorded state truthful: a
   *  route that has not acquired its authority, or has lost it, reads `blocked`. Absent reads
   *  as blocked. */
  effects?: HostedEffects | (() => HostedEffects);
  /** Whether this route was started with a hosted watch on purpose. Defaults to true. */
  required?: boolean;
  /** Start standing down because a live pane watch already owns the session. */
  standby?: string;
  /** Runs on every daemon heartbeat tick, before any due waiter is settled. A route's own
   *  pulses ride the existing fixed interval; the host adds no timer and never shortens a wait.
   *  `false` closes effects: the host then settles every outstanding wait false at once. */
  onTick?: (at: Date) => boolean | void;
  now?: () => Date;
};

export type HostedWatch = HostedWatchHandle & {
  route: HostedRoute;
  /**
   * Ends the run currently in flight as a requested diagnostic fault. The run's outstanding
   * host wait settles false and its next wait — if it reaches one — is answered false too, so
   * the run leaves by its own seam; the exit is then recorded exactly like an unexpected one:
   * `failures` + 1, phase `failed` with `why`, and one restart on the next heartbeat tick.
   * Returns false, changing nothing, when no run is in flight (a standby, a stopped host, a
   * pulse that failed terminally, or the gap between a fault and its restart). `left` is called
   * with the reason the record carries once that exit has been recorded; it never runs for a
   * deliberate stop, because stop owns that exit.
   */
  fault(why: string, left?: (recorded: string) => void): boolean;
};

/** What a hosted route may do outbound right now. */
export type HostedEffects = 'blocked' | 'open';

type Waiter = { due: number; resolve(ok: boolean): void };

export function createHostedWatch(input: HostedWatchInput): HostedWatch {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const effectsOf = (): HostedEffects =>
    (typeof input.effects === 'function' ? input.effects() : input.effects ?? 'blocked');
  const required = input.required ?? true;
  let phase: HostedWatchState['phase'] = input.standby === undefined ? 'starting' : 'standby';
  let why: string | null = input.standby ?? null;
  let lastCycleAt: string | null = null;
  let lastCycleOutcome: HostedWatchState['lastCycleOutcome'] = null;
  let cycles = 0;
  let failures = 0;
  // A deliberate stop was requested: authoritative, and nothing starts again.
  let stopped = false;
  // The current run is being ended by the host itself — its pulse closed effects, or its pulse
  // threw. Neither is an unexpected exit, so neither is restarted.
  let pulseClosed = false;
  let terminalFailure = false;
  // A run left without the host asking. Its replacement waits for the next heartbeat tick, so
  // a loop that leaves at once is restarted at the beat cadence, never in a busy loop.
  let restartPending = false;
  let inFlight = false;
  // A fault asked for by the daemon's own diagnostic. The reason is carried to the exit's
  // record; `armed` marks one that landed while the run was between waits, so its next wait is
  // answered false rather than sleeping past the request.
  let faultDiagnostic: { why: string; left?: (recorded: string) => void } | undefined;
  let faultArmed = false;
  let current: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let doneSettled = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const settleDone = (): void => {
    if (doneSettled) return;
    doneSettled = true;
    resolveDone();
  };
  const controller = new AbortController();
  const waiters = new Set<Waiter>();

  const settleWaiters = (ok: boolean): void => {
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      waiter.resolve(ok);
    }
  };

  const loop: HostedLoop = {
    signal: controller.signal,
    wait(ms) {
      // A wait registered after the stop resolves false at once: a loop that slept through its
      // own cancellation never starts another pass.
      if (stopped) return Promise.resolve(false);
      // A fault that landed while the run was mid-pass is delivered at this seam: the run
      // leaves here instead of sleeping past the request.
      if (faultArmed) {
        faultArmed = false;
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        waiters.add({ due: now().getTime() + Math.max(0, ms), resolve });
      });
    },
    cycled(at) {
      if (stopped || phase === 'standby' || terminalFailure) return;
      cycles += 1;
      lastCycleAt = at.toISOString();
      lastCycleOutcome = 'pass';
      // A completed pass answers the failure reason a restarted run was carrying.
      why = null;
      if (phase === 'starting') phase = 'running';
    },
    standby(reason) {
      if (stopped) return;
      phase = 'standby';
      why = reason;
      // The current pass has already decided to stand down; its wait is cancelled so it leaves
      // through its own end instead of running another pass.
      settleWaiters(false);
    },
  };

  /**
   * One run left. Whoever ended it decides what the record says: a deliberate stop, a standby,
   * a pulse closure or a pulse failure is the host's own decision; anything else is a fault and
   * earns a counted failure and one restart on the next beat.
   */
  const recordExit = (code: number | undefined, error?: unknown): void => {
    inFlight = false;
    current = undefined;
    settleWaiters(false);
    // The fault request belongs to this exit, whichever end it turns out to be; a request the
    // run never reached (it stood down or was stopped first) leaves no claim behind.
    const diagnostic = faultDiagnostic;
    faultDiagnostic = undefined;
    faultArmed = false;
    if (stopped) return; // stop() owns the reason and settles `done`
    if (phase === 'standby') {
      settleDone();
      return;
    }
    if (terminalFailure) {
      settleDone();
      return;
    }
    if (pulseClosed) {
      // The host closed effects and ended this run itself: a stand-down it chose, so neither a
      // failed cycle nor an exit to recover from.
      pulseClosed = false;
      phase = 'stopped';
      why = code === undefined || code === 0
        ? 'the watch loop ended'
        : `the watch loop ended with code ${String(code)}`;
      settleDone();
      return;
    }
    failures += 1;
    lastCycleOutcome = 'failed';
    phase = 'failed';
    // A diagnostic fault asks for the ordinary fault path with its own reason: the reader sees
    // the injected reason, not whichever end the loop's own seam happened to take.
    why = diagnostic?.why ?? (error !== undefined
      ? (error instanceof Error ? error.message : 'the watch loop failed')
      : (code === 0 ? 'the watch loop ended' : `the watch loop ended with code ${String(code)}`));
    restartPending = true;
    if (diagnostic?.left !== undefined) {
      try {
        diagnostic.left(why);
      } catch {
        // The exit record stands whatever a reader of it could not write.
      }
    }
  };

  /**
   * Starts one run. Only ever called with no run in flight, so one hosted loop never doubles;
   * a fresh run reuses the same host handle and the same waits.
   */
  const begin = (): void => {
    if (stopped || phase === 'standby' || terminalFailure) return;
    restartPending = false;
    pulseClosed = false;
    inFlight = true;
    let result: Promise<number>;
    try {
      result = Promise.resolve(input.run(loop));
    } catch (error) {
      result = Promise.reject(error);
    }
    current = (async () => {
      try {
        recordExit(await result);
      } catch (error) {
        recordExit(undefined, error);
      }
    })();
  };

  if (input.standby === undefined) begin();
  else settleDone();

  const tick = (at: Date): void => {
    // While this daemon is closing there is no further beat to ride: the run's own cleanup
    // already ran, and a release it left pending stays honestly pending for explicit recovery.
    if (stopped) return;
    // The route's own pulse rides every beat, including after its run has ended, so cleanup a
    // route left pending can be retried while this daemon lives. It runs before any due waiter:
    // a pass starts only under authority renewed on this very beat.
    let live = true;
    try {
      live = input.onTick?.(at) !== false;
    } catch (error) {
      // A throwing pulse is not a line to log and keep acting past: effects close and the loop
      // drains. The failure stays in the host's state for the daemon's own status, and recovery
      // is explicit: a pulse that cannot be trusted is not restarted under.
      terminalFailure = true;
      restartPending = false;
      failures += 1;
      lastCycleOutcome = 'failed';
      phase = 'failed';
      why = error instanceof Error ? error.message : 'the watch tick failed';
      controller.abort();
      settleWaiters(false);
      settleDone();
      return;
    }
    if (!live) {
      // A pulse that closed effects is ending this run on purpose. Mark it only for a run that
      // exists; with none in flight the pending restart simply waits for a beat that renews
      // authority.
      if (inFlight) pulseClosed = true;
      settleWaiters(false);
      return;
    }
    // Recheck after the pulse: it may have stood this host down or failed it.
    if (phase === 'standby' || phase === 'stopped' || terminalFailure) {
      settleWaiters(false);
      return;
    }
    // One restart per beat, under the authority this very beat renewed. A replacement that
    // leaves again re-arms and waits for the next beat, so the repair cadence is the heartbeat,
    // never a hot spin.
    if (restartPending && !inFlight) {
      phase = 'starting';
      begin();
    }
    const ms = at.getTime();
    for (const waiter of [...waiters]) {
      if (ms < waiter.due) continue;
      waiters.delete(waiter);
      waiter.resolve(true);
    }
  };

  const state = (): HostedWatchState => ({
    routeId: routeId(input.route),
    root: input.route.root,
    team: input.route.team,
    session: input.route.session,
    phase,
    startedAt,
    lastCycleAt,
    lastCycleOutcome,
    cycles,
    failures,
    effects: effectsOf(),
    required,
    why,
  });

  /**
   * The diagnostic entry: it ends the run in flight and nothing else. A standby, a stopped host
   * and a terminal pulse failure have no run to end, so they refuse instead of inventing one.
   */
  const fault = (why: string, left?: (recorded: string) => void): boolean => {
    // One fault owns the exit in flight: a second diagnostic asked before the first reached its
    // seam would replace the first writer's answer, so it is refused instead.
    if (stopped || phase === 'standby' || terminalFailure || !inFlight || faultDiagnostic !== undefined) return false;
    const reason = why.trim() === '' ? 'a hosted watch fault was requested' : why;
    faultDiagnostic = left === undefined ? { why: reason } : { why: reason, left };
    if (waiters.size > 0) settleWaiters(false);
    else faultArmed = true;
    return true;
  };

  const stop = (reason: string): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise;
    stopped = true;
    restartPending = false;
    // A stop owns the exit: a diagnostic that has not been reached is dropped, never counted.
    faultDiagnostic = undefined;
    faultArmed = false;
    if (terminalFailure) {
      // A pulse that failed is the state; closing does not write over it.
      phase = 'failed';
    } else {
      why = reason;
      if (phase !== 'stopped' && phase !== 'standby') phase = 'stopping';
    }
    controller.abort();
    settleWaiters(false);
    stopPromise = (current ?? Promise.resolve()).then(() => {
      if (!terminalFailure) {
        phase = 'stopped';
        why = reason;
      }
      settleDone();
    });
    return stopPromise;
  };

  return {
    route: input.route,
    state,
    tick,
    fault,
    stop,
    done,
  };
}
