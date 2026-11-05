// Independent verification of fix/chores-kill-storm (182cad35d):
// 1. A slow child whose CPU advances is never ended (both after proving two heartbeats and across
//    the startup deadline), and returns to `ok` when its heartbeat resumes.
// 2. A stuck child (flat CPU, delta <= 1 ms) is ended once, and the next start waits at least 60 s;
//    when a child was previously spared for advancing CPU and then goes flat, the supervisor logs
//    `the child's CPU stopped advancing; ending it` before ending it.
// 3. Under a run of failures (repeated flat children, early crashes before two beats, and factory
//    start throws), at most one restart per child occurs in any 60 s window.
// 4. SIGKILL is never forced while the CPU advances across a grace period; a `null` (or backwards)
//    probe during the grace defers the kill instead of forcing; an ordinary end stands down when
//    the child beats, and a deliberate end upgrades an in-flight ordinary request.
// 5. No `ps` probe runs on a healthy heartbeat (CPU comes in the heartbeat frame and serves as the
//    baseline for later probes); K drained heartbeats cost zero probes and the next overdue
//    judgement runs at most one async probe in flight; a failing (`null`) or backwards probe spares
//    the child until two comparable numeric readings prove flat CPU.
// 6. The 10-minute hung ceiling (`600000 ms`) ends a CPU-burning silent child (including one
//    already under a spared ordinary kill) with `evenIfWorking: true` and `10000 ms` grace, logged
//    apart as a hung loop and never withdrawn by a beat during its grace.
// Fakes only (fake clock, fake child, fake CPU probe); single test file; throwaway HOME; no real
// processes spawned.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChoresPolicy } from '../src/daemon/chores/policy.ts';
import type { ChoresChildConfig, ChoresChildMessage, ChoresHostMessage } from '../src/daemon/chores/protocol.ts';
import {
  CPU_PROGRESS_EPSILON_MS,
  spawnChoresChild,
  type ChoresChild,
  type ChoresChildEvent,
} from '../src/daemon/chores/spawn.ts';
import { createChoresFleet, type ChoresRouteInput } from '../src/daemon/chores/supervisor.ts';
import { routeOf } from '../src/daemon/routes.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { fixtureBase } from './helpers.ts';

type FakeSpawnedProcess = EventEmitter & {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  signals: (NodeJS.Signals | number | undefined)[];
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

const spawnedProcesses: FakeSpawnedProcess[] = [];
let nextSpawnPid = 9100;

const fakeSpawn = (() => {
  const proc = new EventEmitter() as FakeSpawnedProcess;
  proc.pid = nextSpawnPid++;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.signals = [];
  proc.kill = (signal?: NodeJS.Signals | number) => {
    proc.signals.push(signal);
    if (signal === 'SIGKILL') {
      proc.emit('exit', null, 'SIGKILL');
      proc.emit('close', null, 'SIGKILL');
    }
    return true;
  };
  spawnedProcesses.push(proc);
  return proc;
}) as unknown as typeof nodeSpawn;

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

const BASE_MS = Date.parse('2026-11-04T04:00:00.000Z');
const BASE_ISO = new Date(BASE_MS).toISOString();
const RSS_BYTES = 48 * 1024 * 1024;
const ORIGINAL_HOME = process.env.HOME;

let scratchBase: string | null = null;
let homeDir = '';

beforeEach(() => {
  scratchBase = fixtureBase('chores-kill-storm-independent-');
  homeDir = join(scratchBase, 'home');
  mkdirSync(join(homeDir, '.config', 'team'), { recursive: true });
  process.env.HOME = homeDir;
  spawnedProcesses.length = 0;
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (scratchBase !== null) {
    rmSync(scratchBase, { recursive: true, force: true });
    scratchBase = null;
  }
});

function parsedTeamFile(): TeamFile {
  const res = validateTeamFile(TEAM_YAML);
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.team;
}

function makePolicy(overrides: Partial<ChoresPolicy> = {}): ChoresPolicy {
  return {
    mode: 'per-root',
    sliceMs: 2_000,
    missedBeats: 2,
    backoffCapMs: 30_000,
    ...overrides,
  };
}

function makeRoute(name: string, policy: ChoresPolicy = makePolicy()): { root: string; routeInput: ChoresRouteInput } {
  if (scratchBase === null) throw new Error('scratchBase not initialized');
  const root = join(scratchBase, name);
  mkdirSync(join(root, '.agents'), { recursive: true });
  const teamPath = join(root, '.agents', 'team.yaml');
  writeFileSync(teamPath, TEAM_YAML);
  return {
    root,
    routeInput: {
      route: routeOf(root, 'acme', 'acme-dev', ['crew-lead']),
      team: parsedTeamFile(),
      policy,
      watch: { teamFile: teamPath, presence: false },
    },
  };
}

type RecordedKill = {
  why: string;
  graceMs: number | undefined;
  options: { evenIfWorking?: boolean } | undefined;
  atMs: number;
};

type SyntheticChild = {
  pid: number | null;
  root: string;
  spawnedAtMs: number;
  child: ChoresChild;
  sends: ChoresHostMessage[];
  kills: RecordedKill[];
  emitMessage(message: ChoresChildMessage): void;
  emitNote(text: string): void;
  exitNow(code?: number | null, signal?: NodeJS.Signals | null): void;
};

function createSyntheticChild(pid: number | null, root: string, clock: { at: number }): SyntheticChild {
  const listeners = new Set<(event: ChoresChildEvent) => void>();
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const sends: ChoresHostMessage[] = [];
  const kills: RecordedKill[] = [];
  let alive = true;

  const child: ChoresChild = {
    pid,
    get alive() {
      return alive;
    },
    send(message) {
      if (!alive) throw new Error('attempted to send a frame to a child that already exited');
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
      kills.push({ why, graceMs, options, atMs: clock.at });
    },
    exited,
  };

  return {
    pid,
    root,
    spawnedAtMs: clock.at,
    child,
    sends,
    kills,
    emitMessage(message) {
      for (const listener of [...listeners]) listener({ kind: 'message', message });
    },
    emitNote(text) {
      for (const listener of [...listeners]) listener({ kind: 'note', text });
    },
    exitNow(code = null, signal = 'SIGTERM') {
      if (!alive) return;
      alive = false;
      for (const listener of [...listeners]) listener({ kind: 'exit', code, signal });
      resolveExit();
    },
  };
}

function heartbeatAt(atMs: number, cpuMs?: number | null): ChoresChildMessage {
  return {
    type: 'heartbeat',
    at: new Date(atMs).toISOString(),
    rssBytes: RSS_BYTES,
    busy: null,
    markerCache: null,
    ...(cpuMs === undefined ? {} : { cpuMs }),
  };
}

async function flushMicrotasks(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe('chores kill-storm independent verification', () => {
  test('1. a slow child whose CPU advances is never ended, both after proving beats and during slow startup', async () => {
    const { root, routeInput } = makeRoute('slow-advancing');
    const clock = { at: BASE_MS };
    const cpu = { ms: 4_000 };
    const logs: string[] = [];
    const children: SyntheticChild[] = [];

    const fleet = createChoresFleet({
      home: homeDir,
      beatMs: 5_000,
      since: BASE_ISO,
      now: () => new Date(clock.at),
      routes: [routeInput],
      log: (line) => logs.push(line),
      cpuTimeOf: () => cpu.ms,
      factory: (input) => {
        const c = createSyntheticChild(7100 + children.length, input.config.routes[0]!.root, clock);
        children.push(c);
        return c.child;
      },
    });

    const tick = (offsetMs: number): void => {
      clock.at = BASE_MS + offsetMs;
      fleet.tick(new Date(clock.at));
    };

    tick(0);
    const first = children[0]!;
    first.emitMessage({ type: 'ready', pid: first.pid ?? 7100, at: BASE_ISO });
    first.emitMessage(heartbeatAt(BASE_MS, cpu.ms));
    tick(5_000);
    cpu.ms += 100;
    first.emitMessage(heartbeatAt(BASE_MS + 5_000, cpu.ms));
    expect(fleet.stateFor(root)).toMatchObject({ state: 'ok', restarts: 0, missed: 0, why: null });

    // Child goes silent for 9 minutes (540 s < 600 s ceiling), advancing CPU by just +2 ms (> 1 ms epsilon) per beat.
    for (let offset = 10_000; offset <= 540_000; offset += 5_000) {
      cpu.ms += CPU_PROGRESS_EPSILON_MS + 1;
      tick(offset);
      expect(first.kills).toEqual([]);
    }

    expect(children).toHaveLength(1);
    expect(fleet.stateFor(root)).toMatchObject({
      state: 'late',
      restarts: 0,
      missed: 2,
      why: 'the child has missed 106 heartbeats but is still working',
    });
    const spareLogs = logs.filter((line) => line.includes('its CPU is still advancing'));
    expect(spareLogs).toHaveLength(1);

    // Heartbeat resumes: state returns to ok.
    first.emitMessage(heartbeatAt(BASE_MS + 540_000, cpu.ms));
    tick(545_000);
    expect(fleet.stateFor(root)).toMatchObject({ state: 'ok', restarts: 0, missed: 0, why: null });

    // Also verify a slow-starting child (beats < 2 past the 60 s startup deadline) whose CPU advances is never ended.
    const slowStart = makeRoute('slow-startup');
    const startChildren: SyntheticChild[] = [];
    const startFleet = createChoresFleet({
      home: homeDir,
      beatMs: 5_000,
      since: BASE_ISO,
      now: () => new Date(clock.at),
      routes: [slowStart.routeInput],
      log: () => {},
      cpuTimeOf: () => cpu.ms,
      factory: (input) => {
        const c = createSyntheticChild(7200 + startChildren.length, input.config.routes[0]!.root, clock);
        startChildren.push(c);
        return c.child;
      },
    });

    clock.at = BASE_MS;
    startFleet.tick(new Date(clock.at));
    const slowChild = startChildren[0]!;
    for (let offset = 5_000; offset <= 180_000; offset += 5_000) {
      cpu.ms += 10;
      clock.at = BASE_MS + offset;
      startFleet.tick(new Date(clock.at));
      expect(slowChild.kills).toEqual([]);
    }
    expect(startFleet.stateFor(slowStart.root)?.why).toBe(
      'the child did not beat twice within 60000 ms of its start but is still working',
    );
  });

  test("2. a stuck child (flat CPU) is ended once, its replacement waits >= 60 s, and a spared child that goes flat logs 'the child's CPU stopped advancing; ending it'", async () => {
    const { root, routeInput } = makeRoute('stuck-flat');
    const clock = { at: BASE_MS };
    const cpu = { ms: 20_000 };
    const logs: string[] = [];
    const children: SyntheticChild[] = [];

    const fleet = createChoresFleet({
      home: homeDir,
      beatMs: 5_000,
      since: BASE_ISO,
      now: () => new Date(clock.at),
      routes: [routeInput],
      log: (line) => logs.push(line),
      cpuTimeOf: () => cpu.ms,
      factory: (input) => {
        const c = createSyntheticChild(7300 + children.length, input.config.routes[0]!.root, clock);
        children.push(c);
        return c.child;
      },
    });

    const tick = (offsetMs: number): void => {
      clock.at = BASE_MS + offsetMs;
      fleet.tick(new Date(clock.at));
    };

    tick(0);
    const first = children[0]!;
    first.emitMessage({ type: 'ready', pid: first.pid ?? 7300, at: BASE_ISO });
    first.emitMessage(heartbeatAt(BASE_MS, cpu.ms));
    tick(5_000);
    first.emitMessage(heartbeatAt(BASE_MS + 5_000, cpu.ms));

    // At 15 s (1 missed beat), no probe or kill yet.
    tick(10_000);
    tick(15_000);
    expect(first.kills).toEqual([]);

    // At 20 s (2 missed beats), CPU rose by only +1 ms (=== CPU_PROGRESS_EPSILON_MS, flat): ended once,
    // without the "CPU stopped advancing" line because it was never spared first.
    cpu.ms += CPU_PROGRESS_EPSILON_MS;
    tick(20_000);
    expect(first.kills).toHaveLength(1);
    expect(first.kills[0]).toMatchObject({
      why: 'the child missed 2 heartbeats',
      graceMs: 2_000,
      options: undefined,
      atMs: BASE_MS + 20_000,
    });
    expect(logs.some((line) => line.includes("the child's CPU stopped advancing; ending it"))).toBe(false);

    // While the child is still exiting (`killing === true`), another tick neither sends a frame nor calls kill a second time.
    const sendsBefore = first.sends.length;
    tick(22_000);
    expect(first.kills).toHaveLength(1);
    expect(first.sends).toHaveLength(sendsBefore);

    // Child exits at 22 s: replacement must wait the full 60 s floor from the exit instant (until 82 s).
    first.exitNow(null, 'SIGTERM');
    await flushMicrotasks();

    expect(fleet.stateFor(root)).toMatchObject({
      state: 'restarting',
      restarts: 1,
      nextStartAt: new Date(BASE_MS + 82_000).toISOString(),
      why: 'the child was ended by SIGTERM',
    });

    for (const offset of [25_000, 30_000, 50_000, 80_000, 81_999]) {
      tick(offset);
      expect(children).toHaveLength(1);
    }

    tick(82_000);
    expect(children).toHaveLength(2);
    const second = children[1]!;
    expect(second.spawnedAtMs - first.kills[0]!.atMs).toBeGreaterThanOrEqual(60_000);
    expect(second.spawnedAtMs).toBe(BASE_MS + 82_000);

    // Now on the second child: prove two beats, then advance CPU across two late checks (spared),
    // then hold CPU flat (delta === +1 ms): must log "the child's CPU stopped advancing; ending it"
    // immediately before the ordinary end log line, and end the child once.
    second.emitMessage({ type: 'ready', pid: second.pid ?? 7301, at: new Date(BASE_MS + 82_000).toISOString() });
    second.emitMessage(heartbeatAt(BASE_MS + 82_000, cpu.ms));
    tick(87_000);
    second.emitMessage(heartbeatAt(BASE_MS + 87_000, cpu.ms));

    tick(92_000);
    tick(97_000);
    cpu.ms += 250;
    tick(102_000);
    expect(second.kills).toEqual([]);
    expect(fleet.stateFor(root)?.why).toBe('the child has missed 2 heartbeats but is still working');

    cpu.ms += 250;
    tick(107_000);
    expect(second.kills).toEqual([]);

    // CPU stops advancing (+1 ms <= epsilon): logs "the child's CPU stopped advancing; ending it" and ends it.
    cpu.ms += CPU_PROGRESS_EPSILON_MS;
    tick(112_000);
    expect(second.kills).toHaveLength(1);
    expect(second.kills[0]?.why).toBe('the child missed 2 heartbeats');
    const stoppedIdx = logs.findIndex((line) =>
      line.includes(`chores ${root}: the child's CPU stopped advancing; ending it`),
    );
    const endingIdx = logs.findIndex(
      (line, idx) => idx > stoppedIdx && line.includes(`chores ${root}: the child missed 2 heartbeats; ending it`),
    );
    expect(stoppedIdx).toBeGreaterThanOrEqual(0);
    expect(endingIdx).toBe(stoppedIdx + 1);
  });

  test('3. at most one restart per child in any 60 s window under a sustained run of failures', async () => {
    const { root, routeInput } = makeRoute('failure-storm');
    const clock = { at: BASE_MS };
    const cpu = { ms: 50_000 };
    const attemptTimes: number[] = [];
    const children: SyntheticChild[] = [];
    let attemptIndex = 0;

    const fleet = createChoresFleet({
      home: homeDir,
      beatMs: 5_000,
      since: BASE_ISO,
      now: () => new Date(clock.at),
      routes: [routeInput],
      log: () => {},
      cpuTimeOf: () => cpu.ms,
      factory: (input) => {
        attemptTimes.push(clock.at);
        attemptIndex += 1;
        if (attemptIndex === 2) {
          throw new Error('simulated spawn EAGAIN under load');
        }
        const c = createSyntheticChild(7400 + children.length, input.config.routes[0]!.root, clock);
        children.push(c);
        return c.child;
      },
    });

    for (let offset = 0; offset <= 720_000; offset += 1_000) {
      clock.at = BASE_MS + offset;
      fleet.tick(new Date(clock.at));
      await flushMicrotasks();

      const current = children[children.length - 1];
      if (current === undefined || !current.child.alive) continue;

      const age = clock.at - current.spawnedAtMs;
      if (attemptIndex === 4) {
        if (age >= 1_000) {
          current.exitNow(1, null);
          await flushMicrotasks();
        }
        continue;
      }

      if (age === 0) {
        current.emitMessage({ type: 'ready', pid: current.pid ?? 7400, at: new Date(clock.at).toISOString() });
        current.emitMessage(heartbeatAt(clock.at, cpu.ms));
      } else if (age === 5_000) {
        current.emitMessage(heartbeatAt(clock.at, cpu.ms));
      }
      if (current.kills.length > 0) {
        current.exitNow(null, 'SIGTERM');
        await flushMicrotasks();
      }
    }

    expect(attemptTimes.length).toBeGreaterThanOrEqual(8);

    for (let i = 1; i < attemptTimes.length; i += 1) {
      expect(attemptTimes[i]! - attemptTimes[i - 1]!).toBeGreaterThanOrEqual(60_000);
    }
    for (const windowStart of attemptTimes) {
      const inWindow = attemptTimes.filter((t) => t >= windowStart && t < windowStart + 60_000);
      expect(inWindow).toHaveLength(1);
    }
    expect(fleet.stateFor(root)?.restarts).toBeGreaterThanOrEqual(7);
  });

  test('4. SIGKILL is never forced while CPU advances or while the probe returns null/backwards during grace, and stand-down/upgrade work', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    type ScheduledTimer = { id: number; ms: number; fn: () => void; cleared: boolean };
    const timers: ScheduledTimer[] = [];
    let nextTimerId = 1;

    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
      const entry: ScheduledTimer = {
        id: nextTimerId++,
        ms: Number(ms ?? 0),
        fn: () => fn(),
        cleared: false,
      };
      timers.push(entry);
      return {
        id: entry.id,
        unref() {
          return this;
        },
        ref() {
          return this;
        },
      } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    globalThis.clearTimeout = ((handle: unknown) => {
      const id = (handle as { id?: number } | null | undefined)?.id;
      const found = timers.find((t) => t.id === id);
      if (found !== undefined) found.cleared = true;
    }) as typeof clearTimeout;

    const fireNextGrace = async (): Promise<ScheduledTimer> => {
      while (timers.length > 0 && timers[0]!.cleared) timers.shift();
      const next = timers.shift();
      if (next === undefined) throw new Error('expected an active grace timer');
      next.fn();
      await flushMicrotasks();
      return next;
    };

    try {
      let probeReading: number | null = 1_000;
      const config: ChoresChildConfig = {
        version: 1,
        home: homeDir,
        beatMs: 5_000,
        sliceMs: 2_000,
        since: BASE_ISO,
        routes: [],
      };

      const handle = spawnChoresChild({
        config,
        entry: import.meta.path,
        cpuTimeOf: () => Promise.resolve(probeReading),
        spawn: fakeSpawn,
      });
      const proc = spawnedProcesses[0]!;
      expect(proc).toBeDefined();
      expect(handle.pid).toBe(proc.pid);

      const notes: string[] = [];
      handle.subscribe((event) => {
        if (event.kind === 'note') notes.push(event.text);
      });

      // Start ordinary kill with a 2000 ms grace.
      handle.kill('the child missed 2 heartbeats', 2_000);
      await flushMicrotasks();
      // A duplicate ordinary kill while one is in flight is ignored.
      handle.kill('duplicate ordinary kill', 2_000);
      expect(proc.signals).toEqual(['SIGTERM']);
      expect(notes.filter((n) => n.startsWith('the child was ended:'))).toHaveLength(1);

      // Across 3 graces where CPU advances, SIGKILL is never forced and the note logs once.
      for (const nextCpu of [1_002, 1_050, 1_200]) {
        probeReading = nextCpu;
        const fired = await fireNextGrace();
        expect(fired.ms).toBe(2_000);
        expect(proc.signals).toEqual(['SIGTERM']);
        expect(handle.alive).toBe(true);
      }
      expect(notes.filter((n) => n.includes('the child is still consuming CPU; not forcing it'))).toHaveLength(1);

      // During the next 2 graces, the probe returns `null` (and then a backwards value < baseline):
      // the handle defers the kill on both, logging `the child's CPU could not be read; not forcing it` once.
      probeReading = null;
      await fireNextGrace();
      expect(proc.signals).toEqual(['SIGTERM']);
      expect(handle.alive).toBe(true);

      probeReading = 900; // backwards relative to 1_200 baseline
      await fireNextGrace();
      expect(proc.signals).toEqual(['SIGTERM']);
      expect(handle.alive).toBe(true);
      expect(notes.filter((n) => n.includes("the child's CPU could not be read; not forcing it"))).toHaveLength(1);

      // Next grace: CPU is flat at 1_201 (+1 ms === CPU_PROGRESS_EPSILON_MS from 1_200 baseline): SIGKILL is forced.
      probeReading = 1_200 + CPU_PROGRESS_EPSILON_MS;
      await fireNextGrace();
      expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(handle.alive).toBe(false);
      await handle.exited;

      // Also verify when baseline itself is `null` at `kill()` time: the first numeric grace reading
      // only sets the baseline (deferring the kill), and a flat reading on the next grace forces SIGKILL.
      probeReading = null;
      const nullBaseHandle = spawnChoresChild({
        config,
        entry: import.meta.path,
        cpuTimeOf: () => Promise.resolve(probeReading),
        spawn: fakeSpawn,
      });
      const nullBaseProc = spawnedProcesses[1]!;
      nullBaseHandle.kill('the child missed 2 heartbeats', 2_000);
      await flushMicrotasks();
      expect(nullBaseProc.signals).toEqual(['SIGTERM']);

      // Grace 1 while probe is still null: deferred.
      await fireNextGrace();
      expect(nullBaseProc.signals).toEqual(['SIGTERM']);

      // Grace 2 when probe recovers with 5_000: establishes baseline only, deferred.
      probeReading = 5_000;
      await fireNextGrace();
      expect(nullBaseProc.signals).toEqual(['SIGTERM']);

      // Grace 3 when probe reads 5_000 again (flat against the established baseline): forces SIGKILL.
      await fireNextGrace();
      expect(nullBaseProc.signals).toEqual(['SIGTERM', 'SIGKILL']);
      await nullBaseHandle.exited;

      // Verify stand-down on heartbeat during an ordinary kill, followed by an in-flight upgrade to deliberate kill.
      probeReading = 2_000;
      const answeringHandle = spawnChoresChild({
        config,
        entry: import.meta.path,
        cpuTimeOf: () => Promise.resolve(probeReading),
        spawn: fakeSpawn,
      });
      const answeringProc = spawnedProcesses[2]!;
      const answeringNotes: string[] = [];
      answeringHandle.subscribe((event) => {
        if (event.kind === 'note') answeringNotes.push(event.text);
      });

      answeringHandle.kill('the child missed 2 heartbeats', 2_000);
      await flushMicrotasks();
      expect(answeringProc.signals).toEqual(['SIGTERM']);
      answeringProc.stdout.write(`${JSON.stringify(heartbeatAt(BASE_MS + 25_000, 2_000))}\n`);
      expect(
        answeringNotes.some((n) =>
          n.includes('the child answered its end request; not forcing it: the child missed 2 heartbeats'),
        ),
      ).toBe(true);
      expect(timers.filter((t) => !t.cleared)).toHaveLength(0);

      // Start another ordinary kill, spare it across one grace while CPU advances, then upgrade it
      // with a deliberate hung-ceiling kill (`evenIfWorking: true`) while probe returns null:
      // deliberate kill forces SIGKILL even when probe is null or advancing.
      answeringHandle.kill('the child missed 2 heartbeats', 2_000);
      await flushMicrotasks();
      probeReading = 2_100;
      await fireNextGrace();
      expect(answeringProc.signals).toEqual(['SIGTERM', 'SIGTERM']);

      probeReading = null;
      answeringHandle.kill('the child has not beaten for 600000 ms while its CPU kept advancing', 10_000, {
        evenIfWorking: true,
      });
      await flushMicrotasks();
      const upgradedFired = await fireNextGrace();
      expect(upgradedFired.ms).toBe(10_000);
      expect(answeringProc.signals).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL']);
      await answeringHandle.exited;
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test('5. no ps probe runs on a healthy heartbeat, K drained heartbeats give at most one probe on the next overdue check, and a failing/backwards probe spares the child', async () => {
    const { root, routeInput } = makeRoute('no-probe-on-beat-and-drain');
    const clock = { at: BASE_MS };
    let currentCpu = 15_000;
    let probeCalls = 0;
    const pendingProbes: ((val: number | null) => void)[] = [];
    const logs: string[] = [];
    const children: SyntheticChild[] = [];

    const fleet = createChoresFleet({
      home: homeDir,
      beatMs: 5_000,
      since: BASE_ISO,
      now: () => new Date(clock.at),
      routes: [routeInput],
      log: (line) => logs.push(line),
      cpuTimeOf: () => {
        probeCalls += 1;
        return new Promise<number | null>((resolve) => pendingProbes.push(resolve));
      },
      factory: (input) => {
        const c = createSyntheticChild(7600 + children.length, input.config.routes[0]!.root, clock);
        children.push(c);
        return c.child;
      },
    });

    const tick = (offsetMs: number): void => {
      clock.at = BASE_MS + offsetMs;
      fleet.tick(new Date(clock.at));
    };

    // Start takes 1 async baseline probe.
    tick(0);
    expect(probeCalls).toBe(1);
    pendingProbes.shift()!(currentCpu);
    await flushMicrotasks();

    const child = children[0]!;
    child.emitMessage({ type: 'ready', pid: 7600, at: BASE_ISO });

    // 8 healthy heartbeats carrying advancing `cpuMs` in the frame cost 0 probes.
    for (let i = 0; i < 8; i += 1) {
      const offset = i * 5_000;
      if (offset > 0) tick(offset);
      currentCpu += 300;
      child.emitMessage(heartbeatAt(BASE_MS + offset, currentCpu));
    }
    expect(probeCalls).toBe(1);
    expect(fleet.stateFor(root)).toMatchObject({ state: 'ok', missed: 0, restarts: 0 });

    // Hold the daemon loop across 6 beats (from 35 s to 65 s), then drain K = 6 buffered heartbeats:
    // neither the stalled tick nor the K = 6 drained heartbeats trigger any probe.
    tick(65_000);
    for (let k = 1; k <= 6; k += 1) {
      currentCpu += 200;
      child.emitMessage(heartbeatAt(BASE_MS + 35_000 + k * 5_000, currentCpu));
    }
    expect(probeCalls).toBe(1);
    tick(70_000);
    expect(probeCalls).toBe(1);

    // Child now goes silent after the 65 s read: overdue at 75 s (1 missed) -> no probe;
    // at 80 s (2 missed) -> 1 probe launched; further overdue ticks at 85 s and 90 s while that
    // async probe is in flight do NOT launch another probe (at most 1 probe in flight).
    tick(75_000);
    expect(probeCalls).toBe(1);
    tick(80_000);
    expect(probeCalls).toBe(2);
    expect(pendingProbes).toHaveLength(1);
    tick(85_000);
    tick(90_000);
    expect(probeCalls).toBe(2);
    expect(child.kills).toEqual([]);

    // Probe answers `null` (failing probe): child is spared (`its CPU could not be read`).
    pendingProbes.shift()!(null);
    await flushMicrotasks();
    expect(child.kills).toEqual([]);
    expect(fleet.stateFor(root)?.why).toBe(
      'the child has missed 2 heartbeats and its CPU could not be read',
    );

    // Next overdue tick launches probe #3, which answers backwards (< last frame baseline `currentCpu`):
    // treated as unproven (`its CPU reading went backwards`) and spared, while updating `probeCpuMs`.
    tick(95_000);
    expect(probeCalls).toBe(3);
    pendingProbes.shift()!(currentCpu - 500);
    await flushMicrotasks();
    expect(child.kills).toEqual([]);
    expect(fleet.stateFor(root)?.why).toContain('its CPU reading went backwards');

    // Next overdue tick launches probe #4, which returns `currentCpu - 500` again (flat against
    // the latest probed reading at 95_000): since the child was spared earlier, it logs
    // `the child's CPU stopped advancing; ending it` and ends the child.
    tick(100_000);
    expect(probeCalls).toBe(4);
    pendingProbes.shift()!(currentCpu - 500);
    await flushMicrotasks();
    expect(child.kills).toHaveLength(1);
    expect(child.kills[0]?.why).toBe('the child missed 2 heartbeats');
    expect(logs.some((line) => line.includes("the child's CPU stopped advancing; ending it"))).toBe(true);
  });

  test('6. the 10-minute hung ceiling ends a CPU-burning silent child with evenIfWorking and 10 s grace, logged apart', async () => {
    const { root, routeInput } = makeRoute('hung-ceiling');
    const clock = { at: BASE_MS };
    const cpu = { ms: 8_000 };
    const logs: string[] = [];
    const children: SyntheticChild[] = [];

    const fleet = createChoresFleet({
      home: homeDir,
      beatMs: 5_000,
      since: BASE_ISO,
      now: () => new Date(clock.at),
      routes: [routeInput],
      log: (line) => logs.push(line),
      cpuTimeOf: () => cpu.ms,
      factory: (input) => {
        const c = createSyntheticChild(7800 + children.length, input.config.routes[0]!.root, clock);
        children.push(c);
        return c.child;
      },
    });

    const tick = (offsetMs: number): void => {
      clock.at = BASE_MS + offsetMs;
      fleet.tick(new Date(clock.at));
    };

    tick(0);
    const child = children[0]!;
    child.emitMessage({ type: 'ready', pid: 7800, at: BASE_ISO });
    child.emitMessage(heartbeatAt(BASE_MS, cpu.ms));
    tick(5_000);
    child.emitMessage(heartbeatAt(BASE_MS + 5_000, cpu.ms));

    for (let offset = 10_000; offset <= 600_000; offset += 5_000) {
      cpu.ms += 400;
      tick(offset);
      expect(child.kills).toEqual([]);
    }

    cpu.ms += 400;
    tick(605_000);

    expect(child.kills).toHaveLength(1);
    expect(child.kills[0]).toEqual({
      why: 'the child has not beaten for 600000 ms while its CPU kept advancing',
      graceMs: 10_000,
      options: { evenIfWorking: true },
      atMs: BASE_MS + 605_000,
    });
    expect(fleet.stateFor(root)).toMatchObject({
      state: 'late',
      why: 'the child has not beaten for 600000 ms while its CPU kept advancing',
    });
    expect(
      logs.some((line) =>
        line.includes(
          'the child has not beaten for 600000 ms while its CPU kept advancing; ending it as a hung loop and starting a replacement',
        ),
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes('missed 2 heartbeats; ending it'))).toBe(false);

    // Also verify the 10-minute ceiling upgrade on a child already in `killing === true` from an
    // ordinary end request, and that a heartbeat during the deliberate ceiling grace does not withdraw it.
    const upgradeRoute = makeRoute('hung-ceiling-upgrade');
    const upgradeLogs: string[] = [];
    const upgradeChildren: SyntheticChild[] = [];
    let upgradeCpu = 10_000;
    const upgradeFleet = createChoresFleet({
      home: homeDir,
      beatMs: 5_000,
      since: BASE_ISO,
      now: () => new Date(clock.at),
      routes: [upgradeRoute.routeInput],
      log: (line) => upgradeLogs.push(line),
      cpuTimeOf: () => upgradeCpu,
      factory: (input) => {
        const c = createSyntheticChild(8000 + upgradeChildren.length, input.config.routes[0]!.root, clock);
        upgradeChildren.push(c);
        return c.child;
      },
    });

    clock.at = BASE_MS;
    upgradeFleet.tick(new Date(clock.at));
    const upChild = upgradeChildren[0]!;
    upChild.emitMessage({ type: 'ready', pid: 8000, at: BASE_ISO });
    upChild.emitMessage(heartbeatAt(BASE_MS, upgradeCpu));
    clock.at = BASE_MS + 5_000;
    upgradeFleet.tick(new Date(clock.at));
    upChild.emitMessage(heartbeatAt(clock.at, upgradeCpu));

    for (const offset of [10_000, 15_000, 20_000]) {
      clock.at = BASE_MS + offset;
      upgradeFleet.tick(new Date(clock.at));
    }
    expect(upChild.kills).toHaveLength(1);
    expect(upChild.kills[0]?.options).toBeUndefined();

    for (let offset = 25_000; offset <= 600_000; offset += 5_000) {
      upgradeCpu += 200;
      clock.at = BASE_MS + offset;
      upgradeFleet.tick(new Date(clock.at));
      expect(upChild.kills).toHaveLength(1);
    }

    upgradeCpu += 200;
    clock.at = BASE_MS + 605_000;
    upgradeFleet.tick(new Date(clock.at));
    expect(upChild.kills).toHaveLength(2);
    expect(upChild.kills[1]).toEqual({
      why: 'the child has not beaten for 600000 ms while its CPU kept advancing',
      graceMs: 10_000,
      options: { evenIfWorking: true },
      atMs: BASE_MS + 605_000,
    });
    expect(upgradeLogs.some((line) => line.includes('ending it as a hung loop'))).toBe(true);

    const sendsBeforeBeat = upChild.sends.length;
    upChild.emitMessage(heartbeatAt(BASE_MS + 605_000, upgradeCpu));
    clock.at = BASE_MS + 610_000;
    upgradeFleet.tick(new Date(clock.at));
    expect(upChild.sends).toHaveLength(sendsBeforeBeat);
    expect(upgradeFleet.stateFor(upgradeRoute.root)).toMatchObject({
      state: 'late',
      why: 'the child has not beaten for 600000 ms while its CPU kept advancing',
    });
  });
});
