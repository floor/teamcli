// The daemon's channel-health answer and the seam that carries it to the watch's dispatcher.
// The scenes use a fixed clock: health is a liveness fact, never a wall-clock sleep.
import { describe, expect, test } from 'bun:test';
import type { WatchSources } from '../src/commands/watch.ts';
import { hostedWatchSources } from '../src/daemon/watch-run.ts';
import {
  PRESENCE_HEALTH_GRACE_MS, createPresenceChannelHealth,
} from '../src/daemon/presence/health.ts';
import type { HostedRoute } from '../src/daemon/routes.ts';
import type { HostedLoop } from '../src/watch/hosted.ts';

const START = new Date('2026-10-20T00:00:00.000Z');
const after = (ms: number): Date => new Date(START.getTime() + ms);

describe('the channel health answer', () => {
  test('unknown until a step finishes, then healthy only inside the grace window', () => {
    const health = createPresenceChannelHealth();
    expect(health.healthy(START)).toBe(false);
    health.stepped(true, START);
    expect(health.healthy(START)).toBe(true);
    expect(health.healthy(after(PRESENCE_HEALTH_GRACE_MS))).toBe(true);
    expect(health.healthy(after(PRESENCE_HEALTH_GRACE_MS + 1))).toBe(false);
  });

  test('a failed step is unhealthy at once, and only the next success renews it', () => {
    const health = createPresenceChannelHealth();
    health.stepped(true, START);
    health.stepped(false, after(100));
    expect(health.healthy(after(100))).toBe(false);
    health.stepped(true, after(200));
    expect(health.healthy(after(200))).toBe(true);
  });

  test('each success renews the window', () => {
    const health = createPresenceChannelHealth();
    health.stepped(true, START);
    health.stepped(true, after(PRESENCE_HEALTH_GRACE_MS));
    expect(health.healthy(after(PRESENCE_HEALTH_GRACE_MS * 2))).toBe(true);
    expect(health.healthy(after(PRESENCE_HEALTH_GRACE_MS * 2 + 1))).toBe(false);
  });

  test('a pass stamped in the future is not evidence of health', () => {
    const health = createPresenceChannelHealth();
    health.stepped(true, after(PRESENCE_HEALTH_GRACE_MS));
    expect(health.healthy(START)).toBe(false);
  });
});

describe('the owned source seam', () => {
  test('the hosted source carries the daemon provider by reference', () => {
    const route: HostedRoute = { root: '/tmp/route', team: 'acme', session: 'crew', seats: [] };
    const loop: HostedLoop = {
      signal: new AbortController().signal,
      wait: async () => true,
      cycled: () => {},
      standby: () => {},
    };
    const provider = (): boolean => true;
    const sources = hostedWatchSources(
      route, loop, {} as WatchSources, undefined, undefined, provider,
    );
    expect(sources.presenceChannelHealthy).toBe(provider);
  });

  test('a hosted source without a provider answers nothing, so a projection is held', () => {
    const route: HostedRoute = { root: '/tmp/route', team: 'acme', session: 'crew', seats: [] };
    const loop: HostedLoop = {
      signal: new AbortController().signal,
      wait: async () => true,
      cycled: () => {},
      standby: () => {},
    };
    const sources = hostedWatchSources(route, loop, {} as WatchSources);
    expect(sources.presenceChannelHealthy).toBeUndefined();
  });
});
