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
    // The run returned without the host asking: a fault, counted and awaiting its restart.
    expect(host.state()).toMatchObject({
      phase: 'failed',
      failures: 1,
      lastCycleOutcome: 'failed',
      why: 'the watch loop ended',
    });

    // The next beat restarts it; its first pass is the record's own evidence. The beat moves
    // the pass clock with it, so the replacement's own wait is not already due.
    time.advance(10_005);
    host.tick(time.now());
    await flush();
    expect(host.state()).toMatchObject({
      phase: 'running',
      cycles: 3,
      failures: 1,
      lastCycleOutcome: 'pass',
      why: null,
    });
    await host.stop('test end');
    expect(host.state()).toMatchObject({ phase: 'stopped', why: 'test end', failures: 1 });
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
      failures: 0,
    });
    await host.done;
  });

  test('an unexpected exit is counted once and restarted only by the next tick', async () => {
    const time = clock();
    let attempts = 0;
    const host = createHostedWatch({
      route: ROUTE,
      now: time.now,
      run: async (loop) => {
        attempts += 1;
        if (attempts === 1) throw new Error('the route read failed');
        for (;;) {
          loop.cycled(time.now());
          if (!(await loop.wait(1_000))) return 0;
        }
      },
    });
    await flush();
    expect(attempts).toBe(1);
    expect(host.state()).toMatchObject({
      phase: 'failed',
      failures: 1,
      lastCycleOutcome: 'failed',
      why: 'the route read failed',
      cycles: 0,
    });
    // No timer, no self-restart: another microtask turn starts nothing.
    await flush();
    expect(attempts).toBe(1);
    expect(host.state().failures).toBe(1);

    const due = time.advance(5_000);
    host.tick(due);
    await flush();
    expect(attempts).toBe(2);
    // The failure stays in the health reading after the watch is cycling again.
    expect(host.state()).toMatchObject({
      phase: 'running',
      cycles: 1,
      failures: 1,
      lastCycleOutcome: 'pass',
      why: null,
    });

    host.tick(new Date(time.ms() + 1_000));
    await flush();
    expect(host.state()).toMatchObject({ phase: 'running', cycles: 2, failures: 1 });
    await host.stop('test end');
  });

  test('an unexpected return is a fault too, and each exit is counted once', async () => {
    const time = clock();
    let attempts = 0;
    const host = createHostedWatch({
      route: ROUTE,
      now: time.now,
      run: async (loop) => {
        attempts += 1;
        if (attempts > 2) {
          for (;;) {
            loop.cycled(time.now());
            if (!(await loop.wait(1_000))) return 0;
          }
        }
        loop.cycled(time.now());
        return 0;
      },
    });
    await flush();
    expect(host.state()).toMatchObject({
      phase: 'failed',
      cycles: 1,
      failures: 1,
      lastCycleOutcome: 'failed',
      why: 'the watch loop ended',
    });
    host.tick(time.advance(5_000));
    await flush();
    expect(attempts).toBe(2);
    expect(host.state()).toMatchObject({ phase: 'failed', cycles: 2, failures: 2 });
    host.tick(time.advance(5_000));
    await flush();
    expect(attempts).toBe(3);
    expect(host.state()).toMatchObject({ phase: 'running', cycles: 3, failures: 2 });
    await host.stop('test end');
  });

  test('a deliberate stop is never restarted and its failure count is honest', async () => {
    const time = clock();
    let attempts = 0;
    const host = createHostedWatch({
      route: ROUTE,
      now: time.now,
      run: async (loop) => {
        attempts += 1;
        for (;;) {
          loop.cycled(time.now());
          if (!(await loop.wait(1_000))) return 0;
        }
      },
    });
    expect(attempts).toBe(1);
    await host.stop('the daemon is closing');
    expect(host.state()).toMatchObject({ phase: 'stopped', why: 'the daemon is closing', failures: 0 });
    await host.done;
    host.tick(time.advance(60_000));
    await flush();
    expect(attempts).toBe(1);
    expect(host.state().phase).toBe('stopped');
    expect(host.state().failures).toBe(0);
  });

  test('a pulse that closes effects is the host standing down, not a fault', async () => {
    const time = clock();
    let attempts = 0;
    let closed = false;
    let settled: boolean | undefined;
    const host = createHostedWatch({
      route: ROUTE,
      now: time.now,
      run: async (loop) => {
        attempts += 1;
        settled = await loop.wait(60_000);
        return 0;
      },
      onTick: () => !closed,
    });
    closed = true;
    host.tick(time.advance(5_000));
    await flush();
    expect(settled).toBe(false);
    expect(host.state()).toMatchObject({
      phase: 'stopped',
      why: 'the watch loop ended',
      failures: 0,
      lastCycleOutcome: null,
    });
    await host.done;
    // A live beat after the stand-down starts nothing new.
    closed = false;
    host.tick(time.advance(5_000));
    await flush();
    expect(attempts).toBe(1);
    expect(host.state().phase).toBe('stopped');
    await host.stop('test end');
  });

  test('a throwing pulse is terminal: no restart until explicit recovery', async () => {
    const time = clock();
    let attempts = 0;
    let throwing = true;
    let settled: boolean | undefined;
    const host = createHostedWatch({
      route: ROUTE,
      now: time.now,
      run: async (loop) => {
        attempts += 1;
        settled = await loop.wait(60_000);
        return 0;
      },
      onTick: () => {
        if (throwing) throw new Error('the beat broke');
        return true;
      },
    });
    host.tick(time.advance(5_000));
    await flush();
    expect(settled).toBe(false);
    expect(host.state()).toMatchObject({
      phase: 'failed',
      failures: 1,
      lastCycleOutcome: 'failed',
      why: 'the beat broke',
    });
    throwing = false;
    host.tick(time.advance(5_000));
    await flush();
    expect(attempts).toBe(1);
    expect(host.state().phase).toBe('failed');
    await host.stop('the daemon is closing');
    // A pulse failure is the state; closing does not write over it.
    expect(host.state().phase).toBe('failed');
    expect(host.state().why).toBe('the beat broke');
  });

  test('one route failing is isolated: it recovers while the other keeps cycling', async () => {
    const time = clock();
    let badAttempts = 0;
    const bad = createHostedWatch({
      route: ROUTE,
      now: time.now,
      run: async (loop) => {
        badAttempts += 1;
        if (badAttempts === 1) {
          await Promise.resolve();
          throw new Error('the route read failed');
        }
        for (;;) {
          loop.cycled(time.now());
          if (!(await loop.wait(1_000))) return 0;
        }
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

    // The failed route's own beat restarts it; the other route is untouched by that.
    bad.tick(time.advance(1_000));
    await flush();
    expect(bad.state()).toMatchObject({ phase: 'running', cycles: 1, failures: 1, lastCycleOutcome: 'pass' });

    good.tick(new Date(time.ms() + 1_000));
    await flush();
    expect(good.state().cycles).toBe(2);
    expect(good.state().phase).toBe('running');

    await bad.stop('the daemon is closing');
    expect(bad.state().phase).toBe('stopped');
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
      failures: 0,
      lastCycleAt: null,
    });
    host.tick(time.advance(60_000));
    await flush();
    expect(ran).toBe(false);
    expect(host.state().cycles).toBe(0);
    expect(host.state().failures).toBe(0);
    await host.done;
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
    expect(host.state()).toMatchObject({ phase: 'standby', cycles: 1, failures: 0 });
    await host.done;
    // Standing by is authoritative: a beat starts nothing and counts nothing.
    host.tick(time.advance(60_000));
    await flush();
    expect(host.state()).toMatchObject({ phase: 'standby', cycles: 1, failures: 0 });
    await host.stop('the daemon is closing');
    expect(host.state().phase).toBe('stopped');
  });
});
