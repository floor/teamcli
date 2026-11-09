// Which watch owns a session's route right now, shared by `up` and `check` so the two commands
// cannot disagree about a pane watch, a hosted watch, or a reading that cannot say. Pure: the
// daemon health is the snapshot the caller already probed, and the pane record is the state's own.
import type { DaemonHealth } from '../daemon/health.ts';
import { canonicalRoot } from '../daemon/routes.ts';
import type { HostedWatchState } from './hosted.ts';
import { paneWatchHealth, type PaneWatchHealth } from './pane.ts';

export type PaneWatchRecord = { pid?: number; heartbeat: string; pane?: string; workspace?: string };

/** The three answers a reader can act on: the daemon's hosted watch owns the route, a pane watch
 *  is the only watch there (with its health), or the daemon reading cannot say whether a hosted
 *  watch exists — the pane reading is still carried, but no reader starts or kills on it. */
export type WatchSitting =
  | { kind: 'hosted'; root: string; watch: HostedWatchState }
  | { kind: 'pane'; health: PaneWatchHealth }
  | { kind: 'unknown'; why: string; health: PaneWatchHealth };

/**
 * Read one route's watch. A hosted watch that is not standing by owns the route: starting,
 * running, stopping, stopped and failed are all the daemon's own states, and a pane watch beside
 * them would be a second watcher. `standby` is the daemon saying a live pane watch owns the
 * session, so pane liveness decides. A daemon reading that is `unknown` and shows no hosted
 * record cannot prove either way; the caller must not start or repair a pane watch from it.
 */
export function watchSitting(input: {
  daemon: DaemonHealth | undefined;
  root: string;
  pane: PaneWatchRecord | undefined;
  alive(pid: number): boolean;
  now: number;
  interval: number;
}): WatchSitting {
  const health = paneWatchHealth(input.pane, {
    alive: input.alive,
    now: input.now,
    interval: input.interval,
  });
  const canonical = canonicalRoot(input.root);
  if (canonical !== null) {
    const entry = input.daemon?.roots.find((root) => root.root === canonical);
    if (entry?.watch !== undefined && entry.watch.phase !== 'standby') {
      return { kind: 'hosted', root: entry.root, watch: entry.watch };
    }
  }
  if (input.daemon?.state === 'unknown') {
    return {
      kind: 'unknown',
      why: input.daemon.why ?? 'the daemon health reading cannot say',
      health,
    };
  }
  return { kind: 'pane', health };
}

/** Whether the daemon carries this session's watch and this checkout's bus. A watch counts
 *  only while the daemon is actually running it for this session. Standby, stopped, and failed
 *  leave the watch unhosted. The bus counts only while it is serving on this root. */
export type DaemonRouteHost = { watch: boolean; bus: boolean };

export function daemonRouteHost(
  daemon: DaemonHealth | undefined,
  root: string,
  session: string,
): DaemonRouteHost {
  const canonical = canonicalRoot(root);
  const entry = canonical === null ? undefined : daemon?.roots.find((item) => item.root === canonical);
  const phase = entry?.watch?.phase;
  const watch = entry?.watch !== undefined
    && entry.watch.session === session
    && (phase === 'starting' || phase === 'running' || phase === 'stopping');
  return { watch, bus: entry?.bus === 'serving' };
}

/** The sentences a restore says when the daemon is not carrying the watch or the bus root.
 *  Empty when both are hosted. */
export function daemonRouteGaps(host: DaemonRouteHost): string[] {
  const gaps: string[] = [];
  if (!host.watch) gaps.push("watch: the daemon does not host this session's watch");
  if (!host.bus) gaps.push("bus: the daemon does not host this session's bus root");
  return gaps;
}
