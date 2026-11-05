// The hosted pass under a read budget: what a cut pass must not claim, how soon it comes back,
// what a stop does to a read in flight, and what one root's stalled read does to another root.
// Every scene drives the shared loop through its own hosted host and injects the awaited seams,
// so no scene opens a live session, reads a clock or waits a wall time: the clock, the reads and
// the waits are the scene's own, and the wait each pass asked for is recorded at the loop's seam.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import type { AsyncLiveRead, AsyncLiveOptions } from '../src/commands/status.ts';
import { routeOf, type HostedRoute } from '../src/daemon/routes.ts';
import { createHostedWatch, type HostedWatch } from '../src/daemon/watch.ts';
import { hostedWatchRun } from '../src/daemon/watch-run.ts';
import type { HerdrAgent, HerdrWorkspace, PaneProcesses } from '../src/herdr.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { forgetIdleEpisodes, type WorkPushRequest } from '../src/watch/dispatch.ts';
import type { HostedLoop } from '../src/watch/hosted.ts';
import type { Machine } from '../src/watch/machine.ts';

const NOW = Date.parse('2026-11-02T09:00:00Z');
const WIN = '5.5';
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idleScreen = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const PUSH_LAUNCH = 'claude --dangerously-load-development-channels server:team-inbox';

const CREW = `format: 1
project: acme-web
session: crew
coordinator: crew-lead
operator: crew-op
workspace:
  mode: shared
seats:
  - role: coordinator
    name: crew-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
  - role: operator
    name: crew-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
  - role: worker
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: ${PUSH_LAUNCH}
`;

type World = { root: string; home: string; agents: string };

let base = '';

function makeWorld(name: string): World {
  const root = join(base, name, 'repo');
  const home = join(base, name, 'home');
  const agents = join(root, '.agents');
  mkdirSync(agents, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(agents, 'team.yaml'), CREW);
  writeFileSync(join(agents, 'queue.yaml'), '- id: t1\n  title: "First"\n');
  updateState(agents, (state) => {
    const session = (state.sessions.crew ??= emptySession());
    session.seats['worker-1'] = {
      stage: 'ready',
      pane: 'pane-worker',
      last_active: new Date(NOW - 10 * 60_000).toISOString(),
    };
  });
  return { root, home, agents };
}

beforeEach(() => {
  forgetIdleEpisodes();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-watch-async-budget-')));
});

afterEach(() => {
  forgetIdleEpisodes();
  rmSync(base, { recursive: true, force: true });
});

function routeOfWorld(world: World): HostedRoute {
  return routeOf(world.root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
}

function agent(name: string, pane: string): HerdrAgent {
  return { name, agent: 'claude', pane, workspace: 'pane-ws', status: 'idle', cwd: null };
}

function workspaceOf(agent: HerdrAgent): HerdrWorkspace {
  return { id: agent.workspace, label: agent.name ?? '' };
}

/** The figures a pass reads beside its screens: one pane, read or not. */
function panesOf(names: { pane: string }[]): {
  processes: Record<string, PaneProcesses | null>;
  foreground: Record<string, string[] | null>;
} {
  const processes: Record<string, PaneProcesses | null> = {};
  const foreground: Record<string, string[] | null> = {};
  for (const { pane } of names) {
    processes[pane] = { shell: 111, foreground: [222] };
    foreground[pane] = ['claude'];
  }
  return { processes, foreground };
}

/** A watched session: every seat listed, the worker's screen the idle prompt. */
function fullLive(): Live {
  const worker = agent('worker-1', 'pane-worker');
  return {
    running: true,
    agents: [worker],
    workspaces: [workspaceOf(worker)],
    screens: { 'pane-worker': idleScreen },
    ...panesOf([worker]),
  };
}

function baseSources(world: World, clock: { at: number }, extra: Partial<WatchSources> = {}): WatchSources {
  return {
    live: () => null,
    machine: () => fine,
    standing: () => ({ kind: 'none' }),
    readChecks: () => [],
    screen: () => null,
    status: () => null,
    foreground: () => null,
    typeText: () => false,
    pressEnter: () => false,
    sleep: async () => {},
    notify: () => {},
    now: () => new Date(clock.at),
    wait: async () => false,
    alive: () => true,
    pid: process.pid,
    home: world.home,
    ...extra,
  };
}

/** The loop the scene hands the shared run: every wait it asks for is recorded, in ms. */
function asking(loop: HostedLoop, asked: number[]): HostedLoop {
  return {
    ...loop,
    wait: (ms) => {
      asked.push(ms);
      return loop.wait(ms);
    },
  };
}

type Hosted = {
  host: HostedWatch;
  asked: number[];
  log: string[];
};

function hostedOf(
  world: World,
  clock: { at: number },
  baseSourcesFor: WatchSources,
  pushWork?: (request: WorkPushRequest) => Promise<{ ok: true; outcome: string }>,
): Hosted {
  const route = routeOfWorld(world);
  const asked: number[] = [];
  const log: string[] = [];
  const host = createHostedWatch({
    route,
    now: () => new Date(clock.at),
    run: (loop) => hostedWatchRun({
      route,
      log: (text) => void log.push(text),
      base: baseSourcesFor,
      ...(pushWork === undefined ? {} : { pushWork }),
    })(asking(loop, asked)),
  });
  return { host, asked, log };
}

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the hosted pass');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets the pass that is waiting end at its own due instant, and returns once the next one waits. */
async function oneMorePass(hosted: Hosted, clock: { at: number }): Promise<void> {
  const before = hosted.asked.length;
  if (before === 0) throw new Error('no pass has asked for a wait yet');
  const due = hosted.asked[before - 1]!;
  clock.at += due;
  hosted.host.tick(new Date(clock.at));
  await until(() => hosted.asked.length === before + 1);
}

function linesMatching(log: string[], needle: string): string[] {
  return log.filter((line) => line.includes(needle));
}

describe('a cut pass', () => {
  test('never prints an unreached pane as gone; a later pass where it is absent does', async () => {
    const world = makeWorld('unread');
    const clock = { at: NOW };
    let pass = 0;
    const baseFor = baseSources(world, clock, {
      liveAsync: async (): Promise<AsyncLiveRead> => {
        pass += 1;
        if (pass === 1) {
          // The session read answers and the worker's screen is in hand, but the process read
          // for its pane was never taken: the pane is unread, which is not absent.
          const worker = agent('worker-1', 'pane-worker');
          return {
            live: {
              running: true,
              agents: [worker],
              workspaces: [workspaceOf(worker)],
              screens: { 'pane-worker': idleScreen },
              processes: {},
              foreground: {},
            },
            next: 1,
            cut: true,
          } satisfies AsyncLiveRead;
        }
        return {
          live: { running: true, agents: [], workspaces: [], screens: {}, processes: {}, foreground: {} },
          next: 0,
          cut: false,
        } satisfies AsyncLiveRead;
      },
    });
    const hosted = hostedOf(world, clock, baseFor);
    await until(() => hosted.asked.length >= 1);

    // Unread: neither the identity check nor the missing check speaks for the pane.
    expect(linesMatching(hosted.log, 'no longer the process team launched')).toEqual([]);
    expect(linesMatching(hosted.log, 'was running and is gone')).toEqual([]);
    expect(linesMatching(hosted.log, 'worker-1 is in the file and is not running')).toEqual([]);
    // The cut itself is said once, in its own words.
    expect(linesMatching(hosted.log, 'the read pass ran out of its 2000 ms budget')).toHaveLength(1);

    // The next pass reads the whole session, and the pane is gone: now, and only now, it is said.
    await oneMorePass(hosted, clock);
    expect(linesMatching(hosted.log, 'worker-1 was running and is gone')).toHaveLength(1);

    await hosted.host.stop('test end');
  });

  test('comes back in five seconds three times, then at the interval; its line prints once per episode', async () => {
    const world = makeWorld('retry');
    const clock = { at: NOW };
    let pass = 0;
    const baseFor = baseSources(world, clock, {
      liveAsync: async () => {
        pass += 1;
        // Every pass but the fifth ends at the read's own cut.
        return { live: fullLive(), next: 0, cut: pass !== 5 } satisfies AsyncLiveRead;
      },
    });
    const hosted = hostedOf(world, clock, baseFor);
    await until(() => hosted.asked.length >= 1);

    // The first pass has cut; three more make four cut passes in a row.
    for (let index = 0; index < 3; index += 1) await oneMorePass(hosted, clock);
    // Three short retries, then the watch's own 120 s interval.
    expect(hosted.asked).toEqual([5000, 5000, 5000, 120_000]);
    expect(linesMatching(hosted.log, 'the read pass ran out of its 2000 ms budget')).toHaveLength(1);

    // The fifth pass read every pane: the count and the line are cleared together.
    await oneMorePass(hosted, clock);
    expect(hosted.asked).toEqual([5000, 5000, 5000, 120_000, 120_000]);
    expect(linesMatching(hosted.log, 'the read pass ran out of its 2000 ms budget')).toHaveLength(1);

    // A cut after a full pass is a new episode, and it is said again.
    await oneMorePass(hosted, clock);
    expect(hosted.asked).toEqual([5000, 5000, 5000, 120_000, 120_000, 5000]);
    expect(linesMatching(hosted.log, 'the read pass ran out of its 2000 ms budget')).toHaveLength(2);

    await hosted.host.stop('test end');
  });

  test('pushes no work for a pane it did not read; the next full idle pass pushes once', async () => {
    const world = makeWorld('push');
    const clock = { at: NOW };
    let pass = 0;
    const baseFor = baseSources(world, clock, {
      liveAsync: async () => {
        pass += 1;
        if (pass === 1) {
          // The worker answers the session read, but its screen was not reached.
          const worker = agent('worker-1', 'pane-worker');
          return {
            live: {
              running: true,
              agents: [worker],
              workspaces: [workspaceOf(worker)],
              screens: {},
              processes: {},
              foreground: {},
            },
            next: 1,
            cut: true,
          } satisfies AsyncLiveRead;
        }
        return { live: fullLive(), next: 0, cut: false } satisfies AsyncLiveRead;
      },
    });
    const pushes: WorkPushRequest[] = [];
    const hosted = hostedOf(world, clock, baseFor, async (request) => {
      pushes.push(request);
      return { ok: true, outcome: 'typed (unconfirmed)' };
    });
    await until(() => hosted.asked.length >= 1);
    // Not idle is not idle: no route is given a seat the pass could not read.
    expect(pushes).toEqual([]);

    await oneMorePass(hosted, clock);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.seat).toBe('worker-1');

    await hosted.host.stop('test end');
  });
});

describe('a stop and two roots', () => {
  test('a stop aborts the read in flight and the run ends when that read settles', async () => {
    const world = makeWorld('stop');
    const clock = { at: NOW };
    let seen: AbortSignal | undefined;
    let rejected: unknown;
    const baseFor = baseSources(world, clock, {
      liveAsync: (_session, _team, options: AsyncLiveOptions) => new Promise<AsyncLiveRead>((_resolve, reject) => {
        seen = options.signal;
        options.signal?.addEventListener('abort', () => {
          const error = new Error('the watch stopped');
          Object.assign(error, { code: 'ABORT_ERR' });
          rejected = error;
          reject(error);
        }, { once: true });
      }),
    });
    const hosted = hostedOf(world, clock, baseFor, undefined);
    await until(() => seen !== undefined);

    await hosted.host.stop('test end');

    expect(seen?.aborted).toBe(true);
    expect((rejected as { code?: unknown } | undefined)?.code).toBe('ABORT_ERR');
    expect(hosted.host.state().phase).toBe('stopped');
    expect(linesMatching(hosted.log, 'the watch of "crew" stopped')).toHaveLength(1);
    // The pass ended by its own seam; the host did not count a deliberate stop as a failure.
    expect(hosted.host.state().failures).toBe(0);
  });

  test('one root holding its read does not hold the other root, and the held pass retries short', async () => {
    const worldA = makeWorld('a');
    const worldB = makeWorld('b');
    const clock = { at: NOW };

    let optionsA: AsyncLiveOptions | undefined;
    let releaseA: (read: AsyncLiveRead) => void = () => {};
    const pendingA = new Promise<AsyncLiveRead>((resolve) => {
      releaseA = resolve;
    });
    const baseA = baseSources(worldA, clock, {
      liveAsync: (_session, _team, options: AsyncLiveOptions) => {
        optionsA = options;
        return pendingA;
      },
    });
    const hostedA = hostedOf(worldA, clock, baseA);
    await until(() => optionsA !== undefined);

    const pushesB: WorkPushRequest[] = [];
    const baseB = baseSources(worldB, clock, {
      liveAsync: async () => ({ live: fullLive(), next: 0, cut: false }) satisfies AsyncLiveRead,
    });
    const hostedB = hostedOf(worldB, clock, baseB, async (request) => {
      pushesB.push(request);
      return { ok: true, outcome: 'typed (unconfirmed)' };
    });
    await until(() => hostedB.asked.length >= 1);
    // B finished its pass and its work push while A's read was still in flight.
    expect(hostedB.host.state().cycles).toBe(1);
    expect(pushesB.map((request) => request.seat)).toEqual(['worker-1']);

    // A's read phase holds no state lock: another writer lands while the read is pending.
    updateState(worldA.agents, (state) => {
      state.sessions.crew ??= emptySession();
      state.sessions.crew.seats['worker-1'] = { stage: 'ready', last_active: new Date(NOW).toISOString() };
    });

    // A's one read was given a bounded call: never more than the 2000 ms budget or its timeout.
    expect(optionsA?.timeoutMs).toBeLessThanOrEqual(2000);
    expect(optionsA?.until).toBeDefined();
    const remaining = (optionsA?.until ?? 0) - (optionsA?.now?.() ?? 0);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(2000);

    // The other root keeps its own heartbeat: another full interval passes and B cycles again.
    clock.at += 120_000;
    hostedB.host.tick(new Date(clock.at));
    await until(() => hostedB.asked.length >= 2);
    expect(hostedB.host.state().cycles).toBe(2);
    // A is still mid-read and has asked for no wait yet.
    expect(hostedA.asked).toEqual([]);

    // A's read is released as a cut, and the pass that follows comes back in five seconds.
    releaseA({ live: fullLive(), next: 0, cut: true });
    await until(() => hostedA.asked.length >= 1);
    expect(hostedA.asked).toEqual([5000]);

    await hostedA.host.stop('test end');
    await hostedB.host.stop('test end');
  });
});
