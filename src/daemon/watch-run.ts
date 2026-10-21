// The production binding of a hosted watch: the shared watch loop, run inside the daemon
// process over the real read sources, with every mutating source closed. It is not a second
// loop and it re-implements none of the loop's checks.

import type { Io } from '../io.ts';
import type { BrokerWorkSource } from '../idle_work.ts';
import { realWatchSources, runWatch, type WatchSources } from '../commands/watch.ts';
import type { WorkPush } from '../watch/dispatch.ts';
import type { HostedLoop } from '../watch/hosted.ts';
import type { HostedRoute } from './routes.ts';

export type HostedWatchRunInput = {
  route: HostedRoute;
  /** The daemon's log: the loop's own lines go here, never to a terminal or a pane. */
  log(text: string): void;
  /** The verified admitted sender, when one has been injected. Absent, no outbound effect. */
  pushWork?: WorkPush;
  /** Test seam: the read sources that stand in for the real ones. */
  base?: WatchSources;
  /** Test seam: the process id the loop's reads record. */
  pid?: number;
  /** The owning daemon's fresh per-seat answer for this route's presence channels, when it
   *  hosts them: the argument is a declared seat name. */
  presenceChannelHealthy?: (seat: string) => boolean;
  /** The owning daemon's broker reader, when it hosts the broker: the watch counts a tracker
   *  team's takeable work from the snapshot it returns and never opens the socket itself. */
  brokerWork?: BrokerWorkSource;
};

/**
 * The sources a hosted loop runs with: every read stays the production read, and every write
 * that could reach a person — typing, a key, a notice, a workspace, a sidebar line, a bus
 * event, a queued swap — is closed. `home` stays as the base has it: readings, the approval
 * store and the mailbox are read, and the gates in `runWatch` decide what hosted may write.
 */
export function hostedWatchSources(
  route: HostedRoute,
  loop: HostedLoop,
  base: WatchSources,
  pushWork?: WorkPush,
  pid?: number,
  presenceChannelHealthy?: (seat: string) => boolean,
  brokerWork?: BrokerWorkSource,
): WatchSources {
  return {
    ...base,
    pid: pid ?? base.pid,
    hosted: loop,
    ownPane: undefined,
    typeText: () => false,
    pressEnter: () => false,
    sendKey: () => false,
    notify: () => {},
    createWorkspace: undefined,
    paneRun: undefined,
    closeWorkspace: undefined,
    renameWorkspace: undefined,
    reportDisplayAgent: undefined,
    stopSeat: undefined,
    removeWorktree: undefined,
    swapSources: undefined,
    busSubscribe: undefined,
    busPublish: undefined,
    onBusEvent: undefined,
    onBusGap: undefined,
    // The loop's waits are the host's own: a sleep ends at the next tick at or after its due
    // instant, and a stop ends both at once.
    sleep: (ms) => loop.wait(ms).then(() => undefined),
    wait: (seconds) => loop.wait(seconds * 1000),
    pushWork,
    ...(presenceChannelHealthy === undefined ? {} : { presenceChannelHealthy }),
    // A base source never brings a broker reader into a hosted loop: the daemon's own reader is
    // the only one, and it is absent unless this daemon hosts the broker.
    ...(brokerWork === undefined ? {} : { brokerWork }),
  };
}

export function hostedWatchRun(input: HostedWatchRunInput): (loop: HostedLoop) => Promise<number> {
  const base = input.base ?? realWatchSources;
  const io: Io = {
    stdout: (text) => void input.log(text),
    stderr: (text) => void input.log(text),
    // The route's checkout is the pass's working directory; no other checkout is ever read.
    cwd: input.route.root,
    // A hosted watch is its own identity: it inherits no TEAM_* placement from the daemon's
    // launcher, and the front refusals that read placement are bypassed by the hosted source.
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stderrIsTTY: false,
  };
  return async (loop) => runWatch([], io, hostedWatchSources(
    input.route,
    loop,
    base,
    input.pushWork,
    input.pid,
    input.presenceChannelHealthy,
    input.brokerWork,
  ));
}
