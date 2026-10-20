import { describe, expect, test } from 'bun:test';
import { routeOf } from '../src/daemon/routes.ts';
import { createHostedWatch } from '../src/daemon/watch.ts';
import type { HostedLoop } from '../src/watch/hosted.ts';

const ROUTE = routeOf('/repo/acme', 'acme', 'acme', ['clerk']);
const OTHER = routeOf('/repo/other', 'other', 'other', ['clerk']);

function clock(start = '2026-10-20T12:00:00.000Z'): { now(): Date; ms(): number; advance(by: number): Date } {
  let at = Date.parse(start);
  return {
    now: () => new Date(at),
    ms: () => at,
    advance(by) {
      at += by;
      return new Date(at);
    },
  };
}

/** Lets the loop's awaited continuation run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('one hosted watch', () => {
  test('counts a pass only when it completes, and a tick releases only a wait that is due', async () => {
    const time = clock();
    let loopSeen: HostedLoop | undefined;
    const host = createHostedWatch({
      route: ROUTE,
      now: time.now,
      run: async (loop) => {
        loopSeen = loop;
        loop.cycled(time.now());
        if (!(await loop.wait(10_000))) return 0;
        loop.cycled(time.now());
        return 0;
      },
    });

    // The first pass starts with the host, so its own completion is already recorded.
    expect(loopSeen).toBeDefined();
    expect(host.state()).toMatchObject({
      root: ROUTE.root,
      team: ROUTE.team,
      phase: 'running',
      cycles: 1,
      failures: 0,
      lastCycleAt: time.now().toISOString(),
      lastCycleOutcome: 'pass',
      effects: 'blocked',
      required: true,
    });
    // routeId is the digest, never the path.
    expect(host.state().routeId).not.toBe(ROUTE.root);
    expect(host.state().routeId).toHaveLength(32);

    host.tick(new Date(time.ms() + 9_999));
    await flush();
    expect(host.state().cycles).toBe(1);

    host.tick(new Date(time.ms() + 10_000));
    await flush();
    expect(host.state().cycles).toBe(2);
    // The run returned on its own: that is a stop, not a failure.
    expect(host.state().phase).toBe('stopped');
    expect(host.state().lastCycleOutcome).toBe('pass');
  });

  test('many ticks at one due instant still release one serial pass', async () => {
    const time = clock();
    let loopSeen: HostedLoop | undefined;
    const host = createHostedWatch({
      route: ROUTE,
      now: time.now,
      run: async (loop) => {
        loopSeen = loop;
        for (;;) {
          loop.cycled(time.now());
          if (!(await loop.wait(1_000))) return 0;
        }
      },
    });
    expect(host.state().cycles).toBe(1);
    const due = new Date(time.ms() + 1_000);
    for (let index = 0; index < 5; index += 1) host.tick(due);
    await flush();
    expect(host.state().cycles).toBe(2);
    expect(loopSeen?.signal.aborted).toBe(false);
    await host.stop('test end');
  });

  test('stop resolves the pending wait false and a wait registered after the stop is false too', async () => {
    const time = clock();
    let loopSeen: HostedLoop | undefined;
    let sawWait: boolean | undefined;
    const host = createHostedWatch({
      route: ROUTE,
      now: time.now,
      run: async (loop) => {
        loopSeen = loop;
        sawWait = await loop.wait(60_000);
        return sawWait ? 1 : 0;
      },
    });
    const stopping = host.stop('the daemon is closing');
    expect(host.state().phase).toBe('stopping');
    // Registered while the abort is already in effect.
    expect(await loopSeen?.wait(1)).toBe(false);
    await stopping;
    expect(sawWait).toBe(false);
    expect(host.state()).toMatchObject({
      phase: 'stopped',
      why: 'the daemon is closing',
      cycles: 0,
      lastCycleAt: null,
      lastCycleOutcome: null,
    });
    await host.done;
  });

  test('one route failing is isolated: it records the failure and the other still cycles', async () => {
    const time = clock();
    const bad = createHostedWatch({
      route: ROUTE,
      now: time.now,
      run: async () => {
        await Promise.resolve();
        throw new Error('the route read failed');
      },
    });
    const good = createHostedWatch({
      route: OTHER,
      now: time.now,
      run: async (loop) => {
        for (;;) {
          loop.cycled(time.now());
          if (!(await loop.wait(1_000))) return 0;
        }
      },
    });
    await flush();
    expect(bad.state()).toMatchObject({
      phase: 'failed',
      failures: 1,
      lastCycleOutcome: 'failed',
      why: 'the route read failed',
      cycles: 0,
    });
    // A failed host's tick is a no-op and never throws.
    expect(() => bad.tick(time.advance(5_000))).not.toThrow();
    expect(bad.state().phase).toBe('failed');

    good.tick(new Date(time.ms() + 1_000));
    await flush();
    expect(good.state().cycles).toBe(2);
    expect(good.state().phase).toBe('running');

    await bad.stop('the daemon is closing');
    // A failure is the state; closing does not write over it.
    expect(bad.state().phase).toBe('failed');
    await good.stop('the daemon is closing');
    expect(good.state().phase).toBe('stopped');
  });

  test('a watch that already runs the session makes the host stand down, never start', async () => {
    const time = clock();
    let ran = false;
    const host = createHostedWatch({
      route: ROUTE,
      now: time.now,
      standby: 'a watch already runs for the session "acme" (pid 123)',
      run: async () => {
        ran = true;
        return 0;
      },
    });
    expect(host.state()).toMatchObject({
      phase: 'standby',
      why: 'a watch already runs for the session "acme" (pid 123)',
      cycles: 0,
      lastCycleAt: null,
    });
    host.tick(time.advance(60_000));
    await flush();
    expect(ran).toBe(false);
    expect(host.state().cycles).toBe(0);
    await host.stop('the daemon is closing');
    expect(host.state().phase).toBe('stopped');
  });

  test('a live pane watch appearing mid-run stands the loop down at its own wait', async () => {
    const time = clock();
    let loopSeen: HostedLoop | undefined;
    let sawWait: boolean | undefined;
    const host = createHostedWatch({
      route: ROUTE,
      now: time.now,
      run: async (loop) => {
        loopSeen = loop;
        loop.cycled(time.now());
        sawWait = await loop.wait(60_000);
        return 0;
      },
    });
    loopSeen?.standby('a live pane watch appeared');
    await flush();
    expect(sawWait).toBe(false);
    expect(host.state().phase).toBe('standby');
    expect(host.state().cycles).toBe(1);
    await host.stop('the daemon is closing');
    expect(host.state().phase).toBe('stopped');
  });
});
