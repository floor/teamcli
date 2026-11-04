// Coverage scenes for the chores supervisor startup grace and parent-stall handling.
//
// All scenes run in-process with fake clocks and synthetic `ChoresChild` handles: no child
// processes are spawned and no host commands are invoked.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { serveChoresChild } from '../src/daemon/chores/child.ts';
import type { ChoresPolicy } from '../src/daemon/chores/policy.ts';
import type { ChoresChildMessage, ChoresHostMessage } from '../src/daemon/chores/protocol.ts';
import type { ChoresChild, ChoresChildEvent } from '../src/daemon/chores/spawn.ts';
import { createChoresFleet, type ChoresRouteInput } from '../src/daemon/chores/supervisor.ts';
import { routeOf } from '../src/daemon/routes.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';

const TEAM_YAML = `format: 1
entity: corp
project: acme
session: acme-dev
coordinator: crew-lead
operator: crew-lead
workspace:
  mode: shared
seats:
  - name: crew-lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

const NOW = Date.parse('2026-11-04T02:00:00.000Z');
const AT = new Date(NOW).toISOString();
const RSS = 48 * 1024 * 1024;
const dirs: string[] = [];
/** A flat CPU reading: these synthetic children have no process behind them, so the supervisor
 *  is handed the reading it should judge instead of probing the machine. */
const flatCpu = (): number => 5_000;


afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function teamFile(): TeamFile {
  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return validated.team;
}

function policy(over: Partial<ChoresPolicy> = {}): ChoresPolicy {
  return { mode: 'per-root', sliceMs: 2000, missedBeats: 2, backoffCapMs: 30_000, ...over };
}

function makeWorld(rootNames: readonly string[]): { base: string; home: string; roots: string[] } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-chores-storm-')));
  dirs.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const roots: string[] = [];
  for (const name of rootNames) {
    const root = join(base, name);
    mkdirSync(join(root, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
    upsertTeam(home, teamIdOf(root), {
      project: 'acme',
      entity: 'corp',
      session: 'acme-dev',
      root,
      roster: [{ agent: 'agt_crewlead0000', seat: 'crew-lead', role: 'coordinator', leads: true }],
      lifecycle: 'running',
    });
    roots.push(root);
  }
  return { base, home, roots };
}

function routeInput(root: string, one: ChoresPolicy = policy()): ChoresRouteInput {
  return {
    route: routeOf(root, 'acme', 'acme-dev', ['crew-lead']),
    team: teamFile(),
    policy: one,
    watch: { teamFile: join(root, '.agents', 'team.yaml'), presence: false },
  };
}

type Fake = {
  pid: number;
  root: string;
  spawnedAtMs: number;
  child: ChoresChild;
  sends: ChoresHostMessage[];
  kills: string[];
  emit(message: ChoresChildMessage): void;
  leave(code?: number | null, signal?: NodeJS.Signals | null): void;
};

function fakeChild(pid: number, root: string, spawnedAtMs: number): Fake {
  const listeners = new Set<(event: ChoresChildEvent) => void>();
  let settle: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const sends: ChoresHostMessage[] = [];
  const kills: string[] = [];
  let alive = true;
  const child: ChoresChild = {
    pid,
    get alive() {
      return alive;
    },
    send(message) {
      if (!alive) throw new Error('a beat was written to a child that left');
      sends.push(message);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    kill(why) {
      kills.push(why);
    },
    exited,
  };
  return {
    pid,
    root,
    spawnedAtMs,
    child,
    sends,
    kills,
    emit(message) {
      for (const listener of [...listeners]) listener({ kind: 'message', message });
    },
    leave(code = null, signal = 'SIGTERM') {
      if (!alive) return;
      alive = false;
      for (const listener of [...listeners]) listener({ kind: 'exit', code, signal });
      settle();
    },
  };
}

describe('chores supervisor startup grace and parent-stall guards', () => {
  test('1. a child whose startup build blocks for 20-30 s, on fake clocks, is never ended while it is building', async () => {
    const { home, roots } = makeWorld(['root-building-after-ready', 'root-building-before-ready']);
    const [rootAfterReady, rootBeforeReady] = roots as [string, string];
    const clock = { at: NOW };
    const spawned: Fake[] = [];
    const fleet = createChoresFleet({
      home,
      beatMs: 5000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(rootAfterReady), routeInput(rootBeforeReady)],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: (input) => {
        const root = input.config.routes[0]!.root;
        const child = fakeChild(5100 + spawned.length, root, clock.at);
        spawned.push(child);
        return child.child;
      },
    });

    const tickAt = (offsetMs: number): void => {
      clock.at = NOW + offsetMs;
      fleet.tick(new Date(clock.at));
    };

    // Spawn both children at t = 0.
    tickAt(0);
    expect(spawned).toHaveLength(2);
    const [afterReady, beforeReady] = spawned as [Fake, Fake];

    // Child 1 (`afterReady`) emits `ready` and its initial heartbeat at t = 0, then blocks for
    // 25 s in its watch import / startup build before its second heartbeat arrives.
    // Child 2 (`beforeReady`) blocks for 25 s in its initial module build before emitting `ready`.
    afterReady.emit({ type: 'ready', pid: afterReady.pid, at: AT });
    afterReady.emit({ type: 'heartbeat', at: AT, rssBytes: RSS, busy: null, markerCache: null });

    // Advance fake clock across 25 s (5 beats of 5 s each: 5 s, 10 s, 15 s, 20 s, 25 s) while both are building.
    for (const offsetMs of [5000, 10_000, 15_000, 20_000, 25_000]) {
      tickAt(offsetMs);
      expect(afterReady.kills).toEqual([]);
      expect(beforeReady.kills).toEqual([]);
      expect(fleet.stateFor(rootAfterReady)?.restarts).toBe(0);
      expect(fleet.stateFor(rootBeforeReady)?.restarts).toBe(0);
      expect(fleet.stateFor(rootAfterReady)?.missed).toBe(0);
      expect(fleet.stateFor(rootBeforeReady)?.missed).toBe(0);
    }

    // At t = 25 s, both finish their startup build and beat on cadence.
    const t25 = new Date(NOW + 25_000).toISOString();
    afterReady.emit({ type: 'heartbeat', at: t25, rssBytes: RSS, busy: null, markerCache: null });
    beforeReady.emit({ type: 'ready', pid: beforeReady.pid, at: t25 });
    beforeReady.emit({ type: 'heartbeat', at: t25, rssBytes: RSS, busy: null, markerCache: null });

    tickAt(30_000);
    const t30 = new Date(NOW + 30_000).toISOString();
    afterReady.emit({ type: 'heartbeat', at: t30, rssBytes: RSS, busy: null, markerCache: null });
    beforeReady.emit({ type: 'heartbeat', at: t30, rssBytes: RSS, busy: null, markerCache: null });

    expect(afterReady.kills).toEqual([]);
    expect(beforeReady.kills).toEqual([]);
    expect(fleet.stateFor(rootAfterReady)).toMatchObject({ state: 'ok', restarts: 0, missed: 0, pid: afterReady.pid });
    expect(fleet.stateFor(rootBeforeReady)).toMatchObject({ state: 'ok', restarts: 0, missed: 0, pid: beforeReady.pid });

    // Also verify in `serveChoresChild` that the heartbeat timer is armed BEFORE `watchFactory` builds watches.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const realSetInterval = globalThis.setInterval;
    let intervalsArmedBeforeWatchBuild = 0;
    let intervalsArmedTotal = 0;
    globalThis.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      intervalsArmedTotal += 1;
      return realSetInterval(fn, ms, ...args);
    }) as typeof setInterval;
    try {
      const childRun = serveChoresChild({
        config: {
          version: 1,
          home,
          beatMs: 5000,
          sliceMs: 2000,
          since: AT,
          routes: [
            {
              root: rootAfterReady,
              team: 'acme',
              session: 'acme-dev',
              teamFile: teamFile(),
              watch: { teamFile: join(rootAfterReady, '.agents', 'team.yaml'), presence: false },
            },
          ],
        },
        stdin,
        stdout,
        now: () => new Date(clock.at),
        watchFactory: () => {
          intervalsArmedBeforeWatchBuild = intervalsArmedTotal;
          return { beat: () => {}, fault: () => {}, stop: async () => {} };
        },
      });
      stdin.end();
      await childRun;
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    expect(intervalsArmedBeforeWatchBuild).toBeGreaterThanOrEqual(1);
  });

  test('2. five roots starting at once under a slow build: no restart storm, and backoff does not climb to 30 s', async () => {
    const rootNames = ['root-1', 'root-2', 'root-3', 'root-4', 'root-5'];
    const { home, roots } = makeWorld(rootNames);
    const clock = { at: NOW };
    const spawned: Fake[] = [];
    const logs: string[] = [];
    const BUILD_DURATION_MS = 25_000;

    const fleet = createChoresFleet({
      home,
      beatMs: 5000,
      since: AT,
      now: () => new Date(clock.at),
      routes: roots.map((root) => routeInput(root, policy({ missedBeats: 2, backoffCapMs: 30_000 }))),
      log: (text) => logs.push(text),
      cpuTimeOf: flatCpu,
      factory: (input) => {
        const root = input.config.routes[0]!.root;
        const child = fakeChild(5200 + spawned.length, root, clock.at);
        spawned.push(child);
        // As `serveChoresChild` does on startup, the child emits `ready` and one initial beat,
        // then awaits its watch import & build for `BUILD_DURATION_MS` before its beat timer runs.
        queueMicrotask(() => {
          if (!child.child.alive || child.kills.length > 0) return;
          const iso = new Date(child.spawnedAtMs).toISOString();
          child.emit({ type: 'ready', pid: child.pid, at: iso });
          child.emit({ type: 'heartbeat', at: iso, rssBytes: RSS, busy: null, markerCache: null });
        });
        return child.child;
      },
    });

    // Advance the fake clock in 5 s beats from t = 0 through t = 90 s.
    for (let offsetMs = 0; offsetMs <= 90_000; offsetMs += 5000) {
      clock.at = NOW + offsetMs;
      fleet.tick(new Date(clock.at));
      await Promise.resolve();
      await Promise.resolve();

      for (const active of spawned) {
        if (!active.child.alive) continue;
        // If the supervisor killed a child during its build, let its exit settle so the
        // supervisor's replacement + backoff machinery runs as in production.
        if (active.kills.length > 0) {
          active.leave(null, 'SIGTERM');
          await Promise.resolve();
          await Promise.resolve();
          continue;
        }
        // Once a child's 25 s startup build finishes, its beat timer fires every 5 s.
        if (clock.at - active.spawnedAtMs >= BUILD_DURATION_MS) {
          active.emit({
            type: 'heartbeat',
            at: new Date(clock.at).toISOString(),
            rssBytes: RSS,
            busy: null,
            markerCache: null,
          });
        }
      }
    }

    // No restart storm: only the 5 original children were spawned, 0 were killed, and backoff never climbed.
    expect(spawned).toHaveLength(5);
    expect(spawned.flatMap((c) => c.kills)).toEqual([]);
    expect(logs.filter((line) => line.includes('starting a replacement in 30000 ms'))).toEqual([]);
    for (const root of roots) {
      expect(fleet.stateFor(root)).toMatchObject({
        state: 'ok',
        restarts: 0,
        missed: 0,
        nextStartAt: null,
      });
    }
  });

  test('3. after a 3-beat parent stall, the first on-time tick ends no child whose frames arrived during the stall', () => {
    const { home, roots } = makeWorld(['root-pipe-backlog', 'root-mid-stall-read']);
    const [rootBacklog, rootMidStall] = roots as [string, string];
    const clock = { at: NOW };
    const spawned: Fake[] = [];
    const fleet = createChoresFleet({
      home,
      beatMs: 5000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(rootBacklog), routeInput(rootMidStall)],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: (input) => {
        const root = input.config.routes[0]!.root;
        const child = fakeChild(5300 + spawned.length, root, clock.at);
        spawned.push(child);
        return child.child;
      },
    });

    const tickAt = (offsetMs: number): void => {
      clock.at = NOW + offsetMs;
      fleet.tick(new Date(clock.at));
    };

    // t = 0: start both children; both send `ready` + beat 1.
    tickAt(0);
    const [backlogChild, midStallChild] = spawned as [Fake, Fake];
    backlogChild.emit({ type: 'ready', pid: backlogChild.pid, at: AT });
    backlogChild.emit({ type: 'heartbeat', at: AT, rssBytes: RSS, busy: null, markerCache: null });
    midStallChild.emit({ type: 'ready', pid: midStallChild.pid, at: AT });
    midStallChild.emit({ type: 'heartbeat', at: AT, rssBytes: RSS, busy: null, markerCache: null });

    // t = 5 s: on-time tick; both send beat 2 (`beats === 2`).
    tickAt(5000);
    const t5 = new Date(NOW + 5000).toISOString();
    backlogChild.emit({ type: 'heartbeat', at: t5, rssBytes: RSS, busy: null, markerCache: null });
    midStallChild.emit({ type: 'heartbeat', at: t5, rssBytes: RSS, busy: null, markerCache: null });

    // Parent stalls for 3 beats (15 s, from t = 5 s to t = 20 s).
    // `midStallChild` has a frame read at t = 10 s during the stall before the parent blocks until t = 20 s.
    clock.at = NOW + 10_000;
    midStallChild.emit({
      type: 'heartbeat',
      at: new Date(NOW + 10_000).toISOString(),
      rssBytes: RSS,
      busy: null,
      markerCache: null,
    });

    // At t = 20 s, the stalled tick runs first in the timers phase (`stalled === true`),
    // and then the poll phase drains `backlogChild`'s pipe frames that arrived during the stall.
    tickAt(20_000);
    expect(backlogChild.kills).toEqual([]);
    expect(midStallChild.kills).toEqual([]);
    backlogChild.emit({
      type: 'heartbeat',
      at: new Date(NOW + 10_000).toISOString(),
      rssBytes: RSS,
      busy: null,
      markerCache: null,
    });
    backlogChild.emit({
      type: 'heartbeat',
      at: new Date(NOW + 15_000).toISOString(),
      rssBytes: RSS,
      busy: null,
      markerCache: null,
    });

    // At t = 25 s, the FIRST ON-TIME TICK after the 3-beat stall runs before the t = 25 s poll phase:
    // neither child may be ended.
    tickAt(25_000);
    expect(backlogChild.kills).toEqual([]);
    expect(midStallChild.kills).toEqual([]);
    expect(fleet.stateFor(rootBacklog)).toMatchObject({ state: 'ok', restarts: 0, missed: 0 });
    expect(fleet.stateFor(rootMidStall)).toMatchObject({ state: 'ok', restarts: 0, missed: 0 });
  });

  test('4. a child truly silent after it has beaten twice is still ended after 2 missed beats', async () => {
    const { home, roots } = makeWorld(['root-silent']);
    const root = roots[0]!;
    const clock = { at: NOW };
    const spawned: Fake[] = [];
    const fleet = createChoresFleet({
      home,
      beatMs: 5000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(root, policy({ missedBeats: 2, backoffCapMs: 30_000 }))],
      log: () => {},
      cpuTimeOf: flatCpu,
      factory: (input) => {
        const child = fakeChild(5400 + spawned.length, input.config.routes[0]!.root, clock.at);
        spawned.push(child);
        return child.child;
      },
    });

    const tickAt = (offsetMs: number): void => {
      clock.at = NOW + offsetMs;
      fleet.tick(new Date(clock.at));
    };

    // t = 0: spawn + beat 1.
    tickAt(0);
    const child = spawned[0]!;
    child.emit({ type: 'ready', pid: child.pid, at: AT });
    child.emit({ type: 'heartbeat', at: AT, rssBytes: RSS, busy: null, markerCache: null });

    // t = 5 s: beat 2 (proves run; `beats === 2`).
    tickAt(5000);
    child.emit({
      type: 'heartbeat',
      at: new Date(NOW + 5000).toISOString(),
      rssBytes: RSS,
      busy: null,
      markerCache: null,
    });
    expect(fleet.stateFor(root)).toMatchObject({ state: 'ok', missed: 0, restarts: 0 });

    // Child now goes truly silent.
    // t = 10 s: due now (0 missed beats).
    tickAt(10_000);
    expect(child.kills).toEqual([]);
    expect(fleet.stateFor(root)).toMatchObject({ state: 'ok', missed: 0 });

    // t = 15 s: 1 missed beat (`late`, not ended yet).
    tickAt(15_000);
    expect(child.kills).toEqual([]);
    expect(fleet.stateFor(root)).toMatchObject({ state: 'late', missed: 1 });

    // t = 20 s: 2 missed beats -> ended with `the child missed 2 heartbeats`.
    tickAt(20_000);
    expect(child.kills).toEqual(['the child missed 2 heartbeats']);
    expect(fleet.stateFor(root)).toMatchObject({
      state: 'late',
      missed: 2,
      why: 'the child has missed 2 heartbeats',
    });

    // When the child exits, backoff was reset by its 2 beats so the replacement is scheduled 1000 ms later.
    child.leave(null, 'SIGTERM');
    await Promise.resolve();
    await Promise.resolve();
    expect(fleet.stateFor(root)).toMatchObject({
      state: 'restarting',
      restarts: 1,
      nextStartAt: new Date(NOW + 20_000 + 1000).toISOString(),
    });
  });
});
