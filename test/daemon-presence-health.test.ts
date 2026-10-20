// The daemon's channel-health answer and the seam that carries it to the watch's dispatcher.
// The scenes use a fixed clock: health is a liveness fact, never a wall-clock sleep.
import { describe, expect, test } from 'bun:test';
import type { WatchSources } from '../src/commands/watch.ts';
import { hostedWatchSources } from '../src/daemon/watch-run.ts';
import {
  PRESENCE_HEALTH_GRACE_MS, createPresenceChannelHealth, presenceStepHealth,
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

describe('a step is not healthy just because it finished', () => {
  test('only the ingester\'s own healthy answer with no known backlog counts', () => {
    expect(presenceStepHealth({ healthy: true, pending: false })).toBe(true);
  });

  test('a faulted or unconvincing answer is not healthy, even with no reported errors', () => {
    expect(presenceStepHealth({ pending: false })).toBe(false);
    expect(presenceStepHealth({ healthy: false, pending: false })).toBe(false);
    expect(presenceStepHealth({ healthy: 'yes', pending: false })).toBe(false);
    expect(presenceStepHealth({})).toBe(false);
  });

  test('a known backlog pending holds the channel unhealthy until it catches up', () => {
    expect(presenceStepHealth({ healthy: true, pending: true })).toBe(false);
    expect(presenceStepHealth({ healthy: true })).toBe(false);
  });

  test('a step that throws records no success', () => {
    const health = createPresenceChannelHealth();
    health.stepped(true, START);
    expect(health.healthy(START)).toBe(true);
    // The host passes the typed answer, which a throwing step never produces.
    health.stepped(presenceStepHealth({}), after(10));
    expect(health.healthy(after(10))).toBe(false);
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
