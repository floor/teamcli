// The watch host: one per hosted route, driven by the machine daemon's existing heartbeat.
//
// The host adds no loop and no timer. It runs one serial pass of the shared watch loop at a
// time, releases that pass's wait exactly when the wait's own due instant has passed, and
// records what it saw so a reader can tell a watch that is cycling from one that is standing
// down or has failed. Nothing here types into a pane, writes a bus event or places an owner:
// the hosted source set closes every mutating source. Outbound effects are recorded as
// `blocked` until a verified admitted sender is injected, and the record says so.

import { routeId, type HostedRoute } from './routes.ts';
import type { HostedLoop, HostedWatchHandle, HostedWatchState } from '../watch/hosted.ts';

export type HostedWatchInput = {
  route: HostedRoute;
  /** Runs the shared watch loop under this host; resolves with the loop's own exit code. */
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
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  const controller = new AbortController();
  const waiters = new Set<Waiter>();

  const settleWaiters = (ok: boolean): void => {
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      waiter.resolve(ok);
    }
  };

  // A run that ends must not overwrite a host already stood down or failed by a pulse. Read
  // through a function so a tick's write is seen here, not a narrowing from construction time.
  const settled = (): boolean => stopped || phase === 'standby' || phase === 'failed';

  const loop: HostedLoop = {
    signal: controller.signal,
    wait(ms) {
      // A wait registered after the stop resolves false at once: a loop that slept through its
      // own cancellation never starts another pass.
      if (stopped) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        waiters.add({ due: now().getTime() + Math.max(0, ms), resolve });
      });
    },
    cycled(at) {
      if (stopped || phase === 'standby') return;
      cycles += 1;
      lastCycleAt = at.toISOString();
      lastCycleOutcome = 'pass';
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

  // One flight: the run is started once and its passes are the loop's own sequence; the host
  // never starts a second run while one is in flight.
  const runPromise = input.standby !== undefined
    ? Promise.resolve()
    : (async () => {
      try {
        const code = await input.run(loop);
        if (settled()) return;
        // The loop ended on its own — its own reasons reached the log. That is a stop, not a
        // failure, and the host never silently restarts a loop that chose to leave.
        phase = 'stopped';
        why = code === 0 ? 'the watch loop ended' : `the watch loop ended with code ${String(code)}`;
      } catch (error) {
        if (settled()) return;
        failures += 1;
        lastCycleOutcome = 'failed';
        phase = 'failed';
        why = error instanceof Error ? error.message : 'the watch loop failed';
      } finally {
        settleWaiters(false);
      }
    })();

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
      // drains. The failure stays in the host's state for the daemon's own status.
      failures += 1;
      lastCycleOutcome = 'failed';
      phase = 'failed';
      why = error instanceof Error ? error.message : 'the watch tick failed';
      controller.abort();
      settleWaiters(false);
      return;
    }
    // Recheck after the pulse: it may have stood this host down, ended it, or closed effects.
    // A closed pulse settles every outstanding wait false now — an aborted signal alone never
    // resolves an inner wait.
    if (!live || phase === 'standby' || phase === 'stopped' || phase === 'failed') {
      settleWaiters(false);
      return;
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

  const stop = (reason: string): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise;
    stopped = true;
    if (phase !== 'failed') {
      why = reason;
      if (phase !== 'stopped' && phase !== 'standby') phase = 'stopping';
    }
    controller.abort();
    settleWaiters(false);
    stopPromise = runPromise.then(() => {
      if (phase === 'failed') return;
      phase = 'stopped';
      why = reason;
    });
    return stopPromise;
  };

  return {
    route: input.route,
    state,
    tick,
    stop,
    done: runPromise.then(() => undefined),
  };
}
