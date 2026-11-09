// The seam a scene gives `runWatch` so the pass runs. A hand-run `team watch` returns before
// the loop; the daemon's hosted loop is the one that still runs. The scene keeps its own
// `wait`, which is what ends the passes. This host only stays open and records the loop's
// own words.
import type { WatchSources } from '../../src/commands/watch.ts';
import type { HostedLoop } from '../../src/watch/hosted.ts';

export function hostedLoop(over: Partial<HostedLoop> = {}): HostedLoop {
  return {
    signal: new AbortController().signal,
    wait: async () => false,
    cycled() {},
    standby() {},
    ...over,
  };
}

/** The scene's sources on the hosted seam. A scene that already set `hosted` keeps that loop. */
export function withHostedLoop(sources: WatchSources, over: Partial<HostedLoop> = {}): WatchSources {
  if (sources.hosted !== undefined) return sources;
  return { ...sources, hosted: hostedLoop(over) };
}
