// Independent verification of the liveness slice: a chores child now proves it is alive with the
// watch frames it already emits (`watch-pulse`, and the new `watch-cycle` when one hosted pass
// completes), not only with its heartbeat. The fleet is driven on a fake clock; no assertion
// waits for a wall-clock second, and the 600 s ceiling is crossed by moving the clock, never by
// sleeping. The watch seam is measured from the event loop itself: a zero-delay timer armed at
// the end of one synchronous sub-step either runs at the next sub-step (a macrotask yield) or
// does not, which is exactly the difference the hosted `yieldBeat` makes and the command-line
// watch does not.
//
// The proof groups below are independent of the author's suites: separate fixtures, separate
// scenes, separate assertions. Nothing here edits src; every module is the public one.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import type { ChoresPolicy } from '../src/daemon/chores/policy.ts';
import { readChildMessage, type ChoresChildMessage, type ChoresChildRoute, type ChoresHostMessage } from '../src/daemon/chores/protocol.ts';
import type { ChoresChild, ChoresChildEvent, SpawnChoresInput } from '../src/daemon/chores/spawn.ts';
import { createChoresFleet, type ChoresRouteInput } from '../src/daemon/chores/supervisor.ts';
import { createChoresWatch } from '../src/daemon/chores/watch.ts';
import { routeOf } from '../src/daemon/routes.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { forgetIdleEpisodes } from '../src/watch/dispatch.ts';
import type { HostedWatchState } from '../src/watch/hosted.ts';
import type { Machine } from '../src/watch/machine.ts';
import { testIo } from './helpers.ts';

const NOW = Date.parse('2026-11-05T03:00:00.000Z');
const AT = new Date(NOW).toISOString();
const CEILING_MS = 600_000;
const CEILING_WHY = 'the child has not beaten for 600000 ms while its CPU kept advancing';
const SESSION = 'c76-crew';
const SEAT = 'c76-lead';
const PROJECT = 'acme-c76';

const TEAM = `format: 1
project: ${PROJECT}
session: ${SESSION}
coordinator: ${SEAT}
operator: ${SEAT}
workspace:
  mode: shared
seats:
  - name: ${SEAT}
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function teamOf(): TeamFile {
  const validated = validateTeamFile(TEAM);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return validated.team;
}

type World = { base: string; home: string; roots: string[] };

function makeWorld(...names: string[]): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'c76-liveness-')));
  dirs.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const roots = names.map((name) => makeRoot(base, name));
  return { base, home, roots };
}

function makeRoot(base: string, name: string): string {
  const root = join(base, name);
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  writeFileSync(join(root, '.agents', 'queue.yaml'), '- id: c76\n  title: "Independent"\n');
  return root;
}

/** The daemon's own registry record: the route is a running checkout. */
function register(home: string, root: string): void {
  upsertTeam(home, teamIdOf(root), {
    project: PROJECT,
    entity: 'acme',
    session: SESSION,
    root,
    roster: [{ agent: 'agt_c76lead0000', seat: SEAT, role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
}

function policy(over: Partial<ChoresPolicy> = {}): ChoresPolicy {
  return { mode: 'per-root', sliceMs: 2000, missedBeats: 2, backoffCapMs: 30_000, ...over };
}

function routeInput(root: string, team: TeamFile, one: ChoresPolicy): ChoresRouteInput {
  return { route: routeOf(root, PROJECT, SESSION, [SEAT]), team, policy: one };
}

type Fake = {
  pid: number;
  root: string;
  child: ChoresChild;
  sends: ChoresHostMessage[];
  kills: { why: string; graceMs: number | null; evenIfWorking: boolean }[];
  emit(message: ChoresChildMessage): void;
  leave(): void;
};

/** A child whose every frame is chosen by the test: it never speaks, leaves or is replaced on a
 *  clock of its own, so each liveness fact lands at the instant the test named. */
function fakeChild(pid: number, root: string): Fake {
  const listeners = new Set<(event: ChoresChildEvent) => void>();
  let settle: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const sends: ChoresHostMessage[] = [];
  const kills: Fake['kills'] = [];
  let alive = true;
  const child: ChoresChild = {
    pid,
    get alive() {
      return alive;
    },
    send(message) {
      if (!alive) return false;
      sends.push(message);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    kill(why, graceMs, options) {
      kills.push({ why, graceMs: graceMs ?? null, evenIfWorking: options?.evenIfWorking === true });
    },
    exited,
  };
  return {
    pid,
    root,
    child,
    sends,
    kills,
    emit(message) {
      for (const listener of [...listeners]) listener({ kind: 'message', message });
    },
    leave() {
      alive = false;
      for (const listener of [...listeners]) listener({ kind: 'exit', code: null, signal: 'SIGTERM' });
      settle();
    },
  };
}

function heartbeat(fake: Fake, at: string, cpuMs: number): ChoresChildMessage {
  return { type: 'heartbeat', at, rssBytes: 32 * 1024 * 1024, busy: null, markerCache: null, cpuMs };
}

describe('the chores fleet counts a watch frame as liveness', () => {
  test('a child that pulses or cycles stays ok across the ceiling, and its silent sibling is ended there', () => {
    const world = makeWorld('speaking', 'silent');
    const speaking = world.roots[0]!;
    const silent = world.roots[1]!;
    register(world.home, speaking);
    register(world.home, silent);
    const team = teamOf();
    const clock = { at: NOW };
    const fakes = new Map<string, Fake>();
    const cpuByPid = new Map<number, number>();
    const pulses: string[] = [];
    const fleet = createChoresFleet({
      home: world.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(speaking, team, policy()), routeInput(silent, team, policy())],
      log: () => {},
      cpuTimeOf: (pid) => cpuByPid.get(pid) ?? null,
      watchPulse: (root, at) => {
        pulses.push(`${root} ${at.toISOString()}`);
      },
      factory: (input: SpawnChoresInput) => {
        const root = input.config.routes[0]?.root ?? '';
        const fake = fakeChild(7101 + fakes.size, root);
        fakes.set(root, fake);
        cpuByPid.set(fake.pid, 10_000);
        return fake.child;
      },
    });
    const fakeOf = (root: string): Fake => {
      const fake = fakes.get(root);
      if (fake === undefined) throw new Error(`no child was started for ${root}`);
      return fake;
    };
    const isoAt = (offset: number): string => new Date(NOW + offset).toISOString();
    const bumpCpu = (): void => {
      for (const [pid, value] of cpuByPid) cpuByPid.set(pid, value + 100);
    };
    // Every daemon beat is one more second of work charged to both synthetic children: a silent
    // child stays "late but working" until the ceiling, never an early end on flat CPU.
    const tickAt = (offset: number): void => {
      bumpCpu();
      clock.at = NOW + offset;
      fleet.tick(new Date(clock.at));
    };

    tickAt(0);
    for (const root of [speaking, silent]) {
      const fake = fakeOf(root);
      fake.emit({ type: 'ready', pid: fake.pid, at: AT });
      fake.emit(heartbeat(fake, AT, cpuByPid.get(fake.pid) ?? 10_000));
    }

    // Every even second the speaking child completes a pass; every odd one it reaches a seam.
    // The pulses that reach the daemon's cross-route hook are exactly the odd-second frames.
    const expectedPulses: string[] = [];
    const speak = (step: number): void => {
      const at = isoAt(step * 1000);
      if (step % 2 === 0) {
        fakeOf(speaking).emit({ type: 'watch-cycle', root: speaking, at });
      } else {
        fakeOf(speaking).emit({ type: 'watch-pulse', root: speaking, at });
        expectedPulses.push(`${speaking} ${at}`);
      }
    };

    // The first second: the speaking child's second beat is a seam pulse; the silent child's is
    // its ordinary last heartbeat. Both have now beaten twice, so the missed-beat rule judges.
    clock.at = NOW + 1000;
    bumpCpu();
    speak(1);
    fakeOf(silent).emit(heartbeat(fakeOf(silent), isoAt(1000), cpuByPid.get(fakeOf(silent).pid) ?? 0));
    tickAt(1000);
    speak(2);
    tickAt(2000);

    // One overdue beat is late; the second missed beat keeps a working child with a row reason.
    speak(3);
    tickAt(3000);
    expect(fleet.stateFor(silent)).toMatchObject({ state: 'late', missed: 1 });
    expect(fakeOf(silent).kills).toHaveLength(0);
    speak(4);
    tickAt(4000);
    expect(fleet.stateFor(silent)).toMatchObject({
      state: 'late',
      missed: 2,
      why: 'the child has missed 2 heartbeats but is still working',
    });
    expect(fakeOf(silent).kills).toHaveLength(0);

    // From here the speaking child keeps speaking every second; the silent one emits nothing,
    // while the machine keeps charging both. Cross the clock to one second short of the ceiling.
    for (let step = 5; step <= CEILING_MS / 1000; step += 1) {
      speak(step);
      tickAt(step * 1000);
    }

    // One second short of a full silent ceiling: no end has been asked for.
    expect(fleet.stateFor(speaking)).toMatchObject({ state: 'ok', missed: 0, pid: fakeOf(speaking).pid });
    expect(fleet.stateFor(silent)).toMatchObject({ state: 'late', missed: 2 });
    expect(fakeOf(speaking).kills).toHaveLength(0);
    expect(fakeOf(silent).kills).toHaveLength(0);

    // The ceiling is measured from the daemon's last read of a silent beat: the silent child's
    // last one was read at +1000, so +601000 is the first instant at the ceiling.
    speak(CEILING_MS / 1000 + 1);
    tickAt(CEILING_MS + 1000);
    expect(fakeOf(silent).kills.map((kill) => kill.why)).toEqual([CEILING_WHY]);
    expect(fakeOf(silent).kills[0]?.evenIfWorking).toBe(true);
    expect(fleet.stateFor(silent)).toMatchObject({
      state: 'late',
      missed: 2,
      pid: fakeOf(silent).pid,
      heartbeatAt: isoAt(1000),
      why: CEILING_WHY,
    });

    // The speaking child is still ok past the ceiling, and a further tick does not repeat the end.
    speak(CEILING_MS / 1000 + 10);
    tickAt(CEILING_MS + 10_000);
    expect(fleet.stateFor(speaking)).toMatchObject({
      state: 'ok',
      missed: 0,
      why: null,
      heartbeatAt: isoAt(CEILING_MS + 10_000),
    });
    expect(fakeOf(speaking).kills).toHaveLength(0);
    expect(fakeOf(silent).kills).toHaveLength(1);

    // Every pulse that reached the daemon's cross-route hook names the speaking child at the
    // instant its frame carried; the silent child never produced one, and the ticks themselves
    // produced none either.
    expect(pulses).toEqual(expectedPulses);
  });

  test('daemon ticks advance the silence clock but never synthesize a pulse', () => {
    const world = makeWorld('quiet');
    const root = world.roots[0]!;
    register(world.home, root);
    const clock = { at: NOW };
    const fake = fakeChild(7201, root);
    const cpu = { at: 5_000 };
    const pulses: string[] = [];
    const fleet = createChoresFleet({
      home: world.home,
      beatMs: 1000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(root, teamOf(), policy())],
      log: () => {},
      cpuTimeOf: () => cpu.at,
      watchPulse: (one, at) => {
        pulses.push(`${one} ${at.toISOString()}`);
      },
      factory: () => fake.child,
    });
    const isoAt = (offset: number): string => new Date(NOW + offset).toISOString();
    const tickAt = (offset: number): void => {
      clock.at = NOW + offset;
      fleet.tick(new Date(clock.at));
    };

    tickAt(0);
    fake.emit({ type: 'ready', pid: fake.pid, at: AT });
    fake.emit(heartbeat(fake, AT, cpu.at));
    clock.at = NOW + 1000;
    cpu.at += 100;
    fake.emit(heartbeat(fake, isoAt(1000), cpu.at));
    tickAt(1000);
    expect(fleet.stateFor(root)).toMatchObject({ state: 'ok', missed: 0 });

    // Two bare daemon ticks: the missed count moves, the pulse sink does not.
    clock.at = NOW + 2000;
    cpu.at += 100;
    tickAt(2000);
    expect(fleet.stateFor(root)).toMatchObject({ state: 'ok', missed: 0 });
    clock.at = NOW + 3000;
    cpu.at += 100;
    tickAt(3000);
    expect(fleet.stateFor(root)).toMatchObject({ state: 'late', missed: 1 });
    expect(pulses).toEqual([]);

    // A child's own pulse frame is the only thing that reaches the cross-route hook.
    clock.at = NOW + 4000;
    cpu.at += 100;
    fake.emit({ type: 'watch-pulse', root, at: isoAt(4000) });
    tickAt(4000);
    expect(pulses).toEqual([`${root} ${isoAt(4000)}`]);
    expect(fleet.stateFor(root)).toMatchObject({ state: 'ok', missed: 0 });

    // A cycle is liveness too, and still no pulse is invented for it.
    clock.at = NOW + 5000;
    cpu.at += 100;
    fake.emit({ type: 'watch-cycle', root, at: isoAt(5000) });
    tickAt(5000);
    expect(pulses).toEqual([`${root} ${isoAt(4000)}`]);
    expect(fleet.stateFor(root)).toMatchObject({ state: 'ok', missed: 0, heartbeatAt: isoAt(5000) });
    expect(fake.kills).toHaveLength(0);

    // The daemon's only writes to the child on these beats are its ticks.
    expect(fake.sends.length).toBeGreaterThan(0);
    expect(fake.sends.every((message) => message.type === 'tick')).toBe(true);
  });

  test('the protocol reads a watch-cycle only with both a root and an instant', () => {
    const frame = { type: 'watch-cycle', root: '/checkout/c76', at: AT } as const;
    expect(readChildMessage(frame)).toEqual(frame);
    expect(readChildMessage({ type: 'watch-cycle', root: '', at: AT })).toBeNull();
    expect(readChildMessage({ type: 'watch-cycle', root: '/checkout/c76', at: '' })).toBeNull();
    expect(readChildMessage({ type: 'watch-cycle', root: '/checkout/c76' })).toBeNull();
    expect(readChildMessage({ type: 'watch-cycle', at: AT })).toBeNull();
    // The sibling frame keeps the same shape rule, so the pair stays one contract.
    expect(readChildMessage({ type: 'watch-pulse', root: '/checkout/c76', at: AT })).toEqual({
      type: 'watch-pulse',
      root: '/checkout/c76',
      at: AT,
    });
  });
});

const WATCH_MACHINE: Machine = {
  loadPerCore: 0.5,
  memoryFree: 60,
  diskFree: 200e9,
  swapTotal: 9e9,
  swapFree: 8e9,
  swapUsed: 1e9,
};

/** A quiet session: the terminal host answers, naming no agent and no pane. */
function quietSources(clock: { at: number }, home: string): WatchSources {
  return {
    home,
    pid: process.pid,
    alive: () => true,
    live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
    machine: () => WATCH_MACHINE,
    standing: () => ({ kind: 'none' }),
    readChecks: () => [],
    screen: () => '● Done.\n',
    status: () => 'idle',
    foreground: () => ['claude'],
    processes: () => null,
    typeText: () => false,
    pressEnter: () => false,
    sendKey: () => false,
    sleep: async () => {},
    notify: () => {},
    now: () => new Date(clock.at),
    wait: async () => false,
  };
}

async function waitUntil(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the hosted watch');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the hosted pass yields between its sub-steps', () => {
  test('a timer armed at the end of the checks runs before the machine step only when the watch is hosted', async () => {
    type Seam = {
      atMachine: { ticks: number; marker: boolean } | undefined;
      hostedBeats: number;
      code: number;
    };

    const scene = async (hosted: boolean): Promise<Seam> => {
      const world = makeWorld('seam');
      const root = world.roots[0]!;
      const clock = { at: NOW };
      let ticks = 0;
      let marker = false;
      let interval: ReturnType<typeof setInterval> | undefined;
      const observed: { atMachine?: { ticks: number; marker: boolean } } = {};
      let hostedBeats = 0;
      const controller = new AbortController();
      const sources: WatchSources = {
        ...quietSources(clock, world.home),
        // The seam: both timers are armed as the checks step returns. The step after it is the
        // machine read, reached synchronously unless a macrotask yield intervenes.
        readChecks: () => {
          interval = setInterval(() => {
            ticks += 1;
          }, 0);
          setTimeout(() => {
            marker = true;
          }, 0);
          return [];
        },
        machine: () => {
          observed.atMachine = { ticks, marker };
          return WATCH_MACHINE;
        },
        ...(hosted
          ? {
              hosted: {
                signal: controller.signal,
                wait: async () => false,
                cycled: () => {},
                standby: (): never => {
                  throw new Error('the seam scene never stands by');
                },
                beat: () => {
                  hostedBeats += 1;
                },
              },
            }
          : {}),
      };
      const io = testIo(root, { kind: 'owner' });
      const code = await runWatch([], io, sources);
      if (interval !== undefined) clearInterval(interval);
      return { atMachine: observed.atMachine, hostedBeats, code };
    };

    const hosted = await scene(true);
    expect(hosted.code).toBe(0);
    expect(hosted.atMachine).toBeDefined();
    // The hosted seam fires the daemon's cross-route beat and yields a macrotask: both timers
    // armed at the end of the checks have run by the time the machine step asks.
    expect(hosted.hostedBeats).toBeGreaterThan(0);
    expect(hosted.atMachine?.marker).toBe(true);
    expect(hosted.atMachine?.ticks).toBeGreaterThanOrEqual(1);

    const cli = await scene(false);
    expect(cli.code).toBe(0);
    expect(cli.atMachine).toBeDefined();
    // A command-line watch has no host and no yield: the same two timers armed at the same seam
    // have not run when the very next synchronous sub-step asks.
    expect(cli.hostedBeats).toBe(0);
    expect(cli.atMachine?.marker).toBe(false);
    expect(cli.atMachine?.ticks).toBe(0);
  });
});

describe('the child watch carries a completed pass across the pipe', () => {
  beforeEach(() => {
    forgetIdleEpisodes();
  });

  afterEach(() => {
    forgetIdleEpisodes();
  });

  test('a hosted pass emits a cycle at the pass clock and a pulse at its seams, and nothing after stop', async () => {
    const world = makeWorld('child');
    const root = world.roots[0]!;
    const teamFile = join(root, '.agents', 'team.yaml');
    updateState(join(root, '.agents'), (state) => {
      (state.sessions[SESSION] ??= emptySession()).watchdog = { file: teamFile };
    });
    const clock = { at: NOW };
    const pulses: { root: string; at: string }[] = [];
    const cycles: { root: string; at: string }[] = [];
    const reports: { root: string; state: HostedWatchState }[] = [];
    const route: ChoresChildRoute = {
      root,
      team: PROJECT,
      session: SESSION,
      teamFile: teamOf(),
      watch: { teamFile, presence: false },
    };
    const watch = createChoresWatch({
      routes: [route],
      log: () => {},
      report: (one, state) => {
        reports.push({ root: one, state });
      },
      pulse: (one, at) => {
        pulses.push({ root: one, at: at.toISOString() });
      },
      cycle: (one, at) => {
        cycles.push({ root: one, at: at.toISOString() });
      },
      faultResult: () => {},
      now: () => new Date(clock.at),
      base: quietSources(clock, world.home),
    });
    try {
      // The pass runs on the virtual clock and completes once; the host reports the cycle.
      await waitUntil(() => cycles.length >= 1);
      expect(cycles[0]).toEqual({ root, at: AT });
      // A hosted pass that yields at its seams has fired at least one pulse, and the state the
      // host reports carries the pass it completed.
      expect(pulses.length).toBeGreaterThan(0);
      expect(pulses.every((entry) => entry.root === root && entry.at === AT)).toBe(true);
      // Reports ride the daemon's beats, so one beat after the pass carries the cycle it counted.
      watch.beat(root, new Date(clock.at), null);
      expect(reports.at(-1)).toMatchObject({ root, state: { phase: 'running', cycles: 1, failures: 0 } });
    } finally {
      await watch.stop('the independent test is done');
    }
    // The stop ends the route's run; no later frame is invented for the stopped route.
    const cyclesAtStop = cycles.length;
    const pulsesAtStop = pulses.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cycles.length).toBe(cyclesAtStop);
    expect(pulses.length).toBe(pulsesAtStop);
  });

});
