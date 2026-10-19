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
  /** Whether the caller injected a verified admitted sender. Absent reads as blocked. */
  effects?: 'blocked' | 'open';
  /** Whether this route was started with a hosted watch on purpose. Defaults to true. */
  required?: boolean;
  /** Start standing down because a live pane watch already owns the session. */
  standby?: string;
  now?: () => Date;
};

export type HostedWatch = HostedWatchHandle & {
  route: HostedRoute;
};

type Waiter = { due: number; resolve(ok: boolean): void };

export function createHostedWatch(input: HostedWatchInput): HostedWatch {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const effects = input.effects ?? 'blocked';
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
        if (stopped || phase === 'standby') return;
        // The loop ended on its own — its own reasons reached the log. That is a stop, not a
        // failure, and the host never silently restarts a loop that chose to leave.
        phase = 'stopped';
        why = code === 0 ? 'the watch loop ended' : `the watch loop ended with code ${String(code)}`;
      } catch (error) {
        if (stopped || phase === 'standby') return;
        failures += 1;
        lastCycleOutcome = 'failed';
        phase = 'failed';
        why = error instanceof Error ? error.message : 'the watch loop failed';
      } finally {
        settleWaiters(false);
      }
    })();

  const tick = (at: Date): void => {
    if (stopped || phase === 'standby' || phase === 'stopped' || phase === 'failed') return;
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
    effects,
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
