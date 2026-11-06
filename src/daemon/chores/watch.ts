// The hosted watch inside a chores child: one watch host per route the token names, driven by
// the daemon's beats over the child's protocol pipe.
//
// A hosted watch's effect authority is the process that holds the epoch. The shared verifier
// (`verifyWatchAuthority`) refuses when the record's pid is not this process's, so a watch whose
// run must be able to send is a run this child owns: the child acquires the route's epoch, runs
// the shared loop over the real read sources, and sends its own direct wake. The daemon keeps
// the route's record, the fault diagnostic's request file and the status row; it mirrors the
// state this module reports after every beat and after every fault.
//
// Nothing here invents a second loop or a second beat. A `watch-beat` frame is the daemon's beat
// for one route: it renews that route's authority on the child's own clock and settles the
// waits whose due instant has passed, then sends the state back. A hosted pass that yields at a
// seat seam sends `watch-pulse`; the daemon turns it into its ordinary cross-route beat for the
// other routes, exactly as it does for a watch running on its own loop. A `watch-fault` frame is
// the fault diagnostic's only entry: the host ends the run at its own seam, and the answer is
// `left` once that exit is recorded or `refused` when no run was in flight.
//
// The daemon relays one presence-health snapshot per seat with every beat when it hosts the
// presence steps for the route; this module answers the watch's dispatcher from the latest
// snapshot, so a seat is held or believed on the daemon's own measurement and never on a word
// the child would have to re-derive. The broker reading does not cross the token: no production
// daemon hosts the broker (`features.broker` is never `on`), so the child's watch keeps that
// reading explicitly unknown, exactly as a daemon without a broker reader does.
import type { WatchSources } from '../../commands/watch.ts';
import { paneProcessesAsync } from '../../herdr.ts';
import { WATCH_DIRECT_WORK, verifyWatchAuthority } from '../../watch/authority.ts';
import { loggedWatchDirectIo, sendWatchDirect } from '../../watch/direct-send.ts';
import type { HostedWatchState } from '../../watch/hosted.ts';
import type { HostedRoute } from '../routes.ts';
import { createHostedWatch, type HostedWatch } from '../watch.ts';
import { hostedWatchAuthority } from '../watch-authority.ts';
import type { ChoresChildRoute, ChoresWatchSeatHealth } from './protocol.ts';

export type ChoresWatchInput = {
  /** Every root the child serves. Routes without a `watch` carry no host here: their watch, if
   *  any, still runs on the daemon's own loop. */
  routes: readonly ChoresChildRoute[];
  /** One diagnostic line for the daemon's log. */
  log(text: string): void;
  /** One route's whole watch state, sent after its creation, every beat and every fault exit. */
  report(root: string, state: HostedWatchState): void;
  /** The route's pass reached a host seam and a daemon beat is due: the daemon's cross-route
   *  pulse, never this route's own. Synchronous, like the seam that calls it. */
  pulse(root: string, at: Date): void;
  /** The route's pass finished one loop turn. */
  cycle?: (root: string, at: Date) => void;
  /** The answer to one diagnostic: `left` when a faulted run's exit has been recorded, `refused`
   *  when the child had no run to end. */
  faultResult(root: string, outcome: 'left' | 'refused', why: string): void;
  now?: () => Date;
  /** Test seam: the read sources the shared loop runs over. */
  base?: WatchSources;
};

export type ChoresWatch = {
  /** One daemon beat for one route: renew its authority, settle due waits, report its state.
   *  `presence` is the daemon's measured health for the route's declared seats on this beat,
   *  or null when it hosts no presence for the root; the latest snapshot answers the watch. */
  beat(root: string, at: Date, presence: readonly ChoresWatchSeatHealth[] | null): void;
  /** Ends that route's run at its own seam, as the fault diagnostic asks. */
  fault(root: string, why: string): void;
  /** Stops every route's run, releasing each epoch, and resolves when each has left. */
  stop(why: string): Promise<void>;
};

type PresenceReading = { current: readonly ChoresWatchSeatHealth[] | null };

/** The child's own address for one watched route: the host it drives and the latest presence
 *  snapshot the daemon relayed. Only the host's `state()` is read; the reading is reassigned by
 *  every beat, and the dispatcher closure below always reads the latest one. */
type WatchedRoute = { host: HostedWatch; reading: PresenceReading };

/** One route's hosted watch, built exactly as the daemon composes its own: the authority build
 *  under a host whose tick rides the beat, with this child's process as the epoch's owner. */
function startRoute(input: ChoresWatchInput, route: ChoresChildRoute, now: () => Date): WatchedRoute {
  const watch = route.watch;
  if (watch === undefined) throw new Error('a watched route was started without its watch configuration');
  // The seats are read from the validated team file the daemon carried, never from the child's
  // working directory: the watch's loop loads its own team file from the route root.
  const seats = route.teamFile === undefined ? [] : route.teamFile.seats.map((seat) => seat.name).sort();
  const hosted: HostedRoute = { root: route.root, team: route.team, session: route.session, seats };
  const reading: PresenceReading = { current: null };
  const build = hostedWatchAuthority({
    route: hosted,
    // The loader's own path is the binding identity; the daemon resolved it, and the child
    // never re-derives it from a working directory that a shared group does not share.
    teamFile: watch.teamFile,
    log: input.log,
    now,
    ...(input.base === undefined ? {} : { base: input.base }),
    // Proving a recorded pane watch is the process in its own pane is the same terminal-host
    // read the daemon makes, and it is the awaited one: a synchronous herdr read would hold this
    // child's loop — and its heartbeat — for the read's whole timeout, which is the lateness the
    // supervisor then reports. A pane it cannot read stays unproven and is never asked to hand
    // over. A test's read sources answer first; a base that supplies only the synchronous reader
    // keeps using it, so no scene probes the machine's own sessions.
    processInfo: (pane) => {
      if (input.base?.processesAsync !== undefined) {
        return input.base.processesAsync(pane, hosted.session, { timeoutMs: 10_000 });
      }
      if (input.base?.processes !== undefined) return input.base.processes(pane, hosted.session);
      return paneProcessesAsync(pane, hosted.session, { timeoutMs: 10_000 });
    },
    ...(watch.presence
      ? {
          presenceChannelHealthy: (seat: string): boolean =>
            reading.current?.some((row) => row.seat === seat && row.healthy) === true,
          // The daemon's measured reason crosses the beat with the boolean: the stuck report
          // names the unhealthy channel in the daemon's own words, never a re-derived guess.
          presenceChannelReason: (seat: string): string | null =>
            reading.current?.find((row) => row.seat === seat)?.reason ?? null,
        }
      : {}),
    // The shared verifier judges the captured identity against the record under its own lock
    // immediately before every effect, in this process, which is the record's own pid.
    verifyAuthority: (check) => verifyWatchAuthority({ ...check, purpose: WATCH_DIRECT_WORK }),
    // The watch's one outbound effect: the send command's direct-wake legs, entered as the watch
    // principal the shared verifier proves. The io is the host's log: this process's standard
    // output is its protocol pipe, and a run line written there would corrupt a frame.
    sender: (captured) => (request) => sendWatchDirect(
      { root: hosted.root, session: hosted.session, capturedEpoch: captured.epoch },
      request,
      undefined,
      loggedWatchDirectIo(input.log),
    ),
  });
  const host = createHostedWatch({
    route: hosted,
    now,
    run: build.run,
    effects: build.effects,
    required: build.required,
    standby: build.standby,
    ...(build.tick === undefined ? {} : { onTick: build.tick }),
    // A due beat landing inside this route's pass asks the daemon to renew the other routes; the
    // daemon never renews this one through its own pass's lock.
    onBeat: () => input.pulse(hosted.root, now()),
    onCycle: (at) => input.cycle?.(hosted.root, at),
  });
  return { host, reading };
}

export function createChoresWatch(input: ChoresWatchInput): ChoresWatch {
  const now = input.now ?? (() => new Date());
  const watched = new Map<string, WatchedRoute>();
  for (const route of input.routes) {
    if (route.watch === undefined) continue;
    const entry = startRoute(input, route, now);
    watched.set(route.root, entry);
    // The daemon's record starts from this route's own first state, not from a guess: a watch
    // that is already standing down says so on the first frame.
    input.report(route.root, entry.host.state());
  }
  return {
    beat(root: string, at: Date, presence: readonly ChoresWatchSeatHealth[] | null): void {
      const entry = watched.get(root);
      if (entry === undefined) return;
      if (Number.isNaN(at.getTime())) {
        input.log(`watch ${root}: a beat named no valid instant`);
        return;
      }
      entry.reading.current = presence;
      entry.host.tick(at);
      input.report(root, entry.host.state());
    },
    fault(root: string, why: string): void {
      const entry = watched.get(root);
      if (entry === undefined) {
        input.faultResult(root, 'refused', 'this child hosts no watch for the root');
        return;
      }
      const accepted = entry.host.fault(why, (recorded) => {
        // The exit is recorded: report the failed state before the answer, so a reader that
        // acts on the answer already sees the record it names.
        input.report(root, entry.host.state());
        input.faultResult(root, 'left', recorded);
      });
      // A host that can decide at once refuses by returning false; there is no seam to wait for.
      if (!accepted) input.faultResult(root, 'refused', 'no hosted run is in flight to fault');
    },
    async stop(why: string): Promise<void> {
      await Promise.all([...watched.values()].map((entry) => entry.host.stop(why)));
    },
  };
}
