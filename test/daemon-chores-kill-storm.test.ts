// Coverage scenes for the chores supervisor kill storm: liveness judged by the child's own
// progress, the long hung-loop ceiling, and the per-root restart floor.
//
// All supervisor scenes run in-process with fake clocks, synthetic `ChoresChild` handles and a
// fake CPU-time probe: no child processes are spawned and no host commands are invoked.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-chores-kill-storm-')));
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

type KillCall = {
  why: string;
  graceMs: number | undefined;
  options: { evenIfWorking?: boolean } | undefined;
};

type Fake = {
  pid: number;
  root: string;
  spawnedAtMs: number;
  child: ChoresChild;
  sends: ChoresHostMessage[];
  kills: string[];
  killCalls: KillCall[];
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
  const killCalls: KillCall[] = [];
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
    kill(why, graceMs, options) {
      kills.push(why);
      killCalls.push({ why, graceMs, options });
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
    killCalls,
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

function beat(atMs: number): ChoresChildMessage {
  return { type: 'heartbeat', at: new Date(atMs).toISOString(), rssBytes: RSS, busy: null, markerCache: null };
}

describe('chores supervisor liveness by progress', () => {
  test('1. a child that stops beating while its CPU keeps advancing is kept, and its row says it is still working', async () => {
    const { home, roots } = makeWorld(['root-slow-progress']);
    const root = roots[0]!;
    const clock = { at: NOW };
    const cpu = { ms: 10_000 };
    const spawned: Fake[] = [];
    const fleet = createChoresFleet({
      home,
      beatMs: 5000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(root)],
      log: () => {},
      cpuTimeOf: () => cpu.ms,
      factory: (input) => {
        const child = fakeChild(6100 + spawned.length, input.config.routes[0]!.root, clock.at);
        spawned.push(child);
        return child.child;
      },
    });

    const tickAt = (offsetMs: number): void => {
      clock.at = NOW + offsetMs;
      fleet.tick(new Date(clock.at));
    };

    tickAt(0);
    const child = spawned[0]!;
    child.emit({ type: 'ready', pid: child.pid, at: AT });
    child.emit(beat(NOW));
    tickAt(5000);
    child.emit(beat(NOW + 5000));

    // From here the child sends no beat, but the machine keeps charging it CPU time: it is late
    // under load, not stopped.
    for (const offsetMs of [10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 40_000]) {
      cpu.ms += 500;
      tickAt(offsetMs);
    }

    expect(child.kills).toEqual([]);
    expect(fleet.stateFor(root)).toMatchObject({ state: 'late', restarts: 0, missed: 2 });
    expect(fleet.stateFor(root)?.why).toContain('still');
    expect(fleet.stateFor(root)?.why).toContain('working');

    // When the beat resumes, the row reads ok again on the next on-time beat.
    cpu.ms += 100;
    tickAt(45_000);
    child.emit(beat(NOW + 45_000));
    tickAt(50_000);
    expect(fleet.stateFor(root)).toMatchObject({ state: 'ok', restarts: 0, missed: 0 });
    expect(child.kills).toEqual([]);
  });

  test('2. the storm: a child that beats twice then starves while its CPU advances is never replaced, so replacements never chain', async () => {
    const { home, roots } = makeWorld(['root-starved']);
    const root = roots[0]!;
    const clock = { at: NOW };
    const cpu = { ms: 15_000 };
    const spawned: Fake[] = [];
    const beatsSent = new Map<Fake, number>();
    const fleet = createChoresFleet({
      home,
      beatMs: 5000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(root)],
      log: () => {},
      cpuTimeOf: () => cpu.ms,
      factory: (input) => {
        const child = fakeChild(6200 + spawned.length, input.config.routes[0]!.root, clock.at);
        spawned.push(child);
        // A fresh child reports ready and one beat, as `serveChoresChild` does, then is starved
        // before its next beat.
        queueMicrotask(() => {
          if (!child.child.alive || child.kills.length > 0) return;
          const iso = new Date(child.spawnedAtMs).toISOString();
          child.emit({ type: 'ready', pid: child.pid, at: iso });
          child.emit(beat(child.spawnedAtMs));
        });
        beatsSent.set(child, 1);
        return child.child;
      },
    });

    for (let offsetMs = 0; offsetMs <= 600_000; offsetMs += 5000) {
      clock.at = NOW + offsetMs;
      fleet.tick(new Date(clock.at));
      await Promise.resolve();
      await Promise.resolve();
      cpu.ms += 250;
      for (const active of spawned) {
        if (!active.child.alive) continue;
        if (active.kills.length > 0) {
          // Let the supervisor's replacement path run as it does in production.
          active.leave(null, 'SIGTERM');
          await Promise.resolve();
          await Promise.resolve();
          continue;
        }
        // Each child sends exactly one more beat after its first, then nothing.
        if ((beatsSent.get(active) ?? 1) < 2 && clock.at - active.spawnedAtMs >= 5000) {
          beatsSent.set(active, 2);
          active.emit(beat(clock.at));
        }
      }
    }

    // Ten fake minutes without a beat, with the CPU advancing the whole time: one child, no end.
    expect(spawned).toHaveLength(1);
    expect(spawned.flatMap((child) => child.kills)).toEqual([]);
    expect(fleet.stateFor(root)).toMatchObject({ state: 'late', restarts: 0 });
  });

  test('3. a child that never beats again while consuming CPU is ended at the ten-minute ceiling, named apart as a hung loop', async () => {
    const { home, roots } = makeWorld(['root-hung']);
    const root = roots[0]!;
    const clock = { at: NOW };
    const cpu = { ms: 5000 };
    const spawned: Fake[] = [];
    const logs: string[] = [];
    const fleet = createChoresFleet({
      home,
      beatMs: 5000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(root)],
      log: (text) => logs.push(text),
      cpuTimeOf: () => cpu.ms,
      factory: (input) => {
        const child = fakeChild(6400 + spawned.length, input.config.routes[0]!.root, clock.at);
        spawned.push(child);
        return child.child;
      },
    });

    const tickAt = (offsetMs: number): void => {
      clock.at = NOW + offsetMs;
      fleet.tick(new Date(clock.at));
    };

    tickAt(0);
    const child = spawned[0]!;
    child.emit({ type: 'ready', pid: child.pid, at: AT });
    child.emit(beat(NOW));
    tickAt(5000);
    child.emit(beat(NOW + 5000));

    // The child is spinning in a loop that keeps consuming CPU but never beats. It is spared as
    // late for ten minutes — and only then ended, on its own reason.
    for (let offsetMs = 10_000; offsetMs <= 600_000; offsetMs += 5000) {
      cpu.ms += 300;
      tickAt(offsetMs);
      expect(child.kills).toEqual([]);
    }
    cpu.ms += 300;
    tickAt(605_000);

    expect(child.kills).toHaveLength(1);
    expect(child.kills[0]).toContain('while its CPU kept advancing');
    expect(child.killCalls[0]?.options?.evenIfWorking).toBe(true);
    expect(fleet.stateFor(root)?.why).toContain('not beaten for 600000 ms');
    expect(logs.some((line) => line.includes('hung loop'))).toBe(true);
    // Counted apart from the pass-mark-1 cases: this end is never the missed-beats sentence.
    expect(logs.some((line) => line.includes('missed 2 heartbeats; ending it'))).toBe(false);
  });

  test('4. a child whose CPU cannot be read is kept, and a flat reading after recovery still ends it', async () => {
    const { home, roots } = makeWorld(['root-unreadable-cpu']);
    const root = roots[0]!;
    const clock = { at: NOW };
    let cpu: number | null = null;
    const spawned: Fake[] = [];
    const fleet = createChoresFleet({
      home,
      beatMs: 5000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(root)],
      log: () => {},
      cpuTimeOf: () => cpu,
      factory: (input) => {
        const child = fakeChild(6500 + spawned.length, input.config.routes[0]!.root, clock.at);
        spawned.push(child);
        return child.child;
      },
    });

    const tickAt = (offsetMs: number): void => {
      clock.at = NOW + offsetMs;
      fleet.tick(new Date(clock.at));
    };

    tickAt(0);
    const child = spawned[0]!;
    child.emit({ type: 'ready', pid: child.pid, at: AT });
    child.emit(beat(NOW));
    tickAt(5000);
    child.emit(beat(NOW + 5000));

    for (const offsetMs of [10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 40_000, 45_000, 50_000, 55_000, 60_000]) {
      tickAt(offsetMs);
    }
    expect(child.kills).toEqual([]);
    expect(fleet.stateFor(root)?.why).toContain('CPU');
    expect(fleet.stateFor(root)?.why).toContain('read');

    // The probe recovers: the first numeric reading is only a baseline, the next flat reading
    // ends the child on the ordinary reason.
    cpu = 40_000;
    tickAt(65_000);
    expect(child.kills).toEqual([]);
    tickAt(70_000);
    expect(child.kills).toEqual(['the child missed 2 heartbeats']);
  });

  test('5. a child that has not beaten twice by the startup deadline but is still consuming CPU is kept', async () => {
    const { home, roots } = makeWorld(['root-slow-start']);
    const root = roots[0]!;
    const clock = { at: NOW };
    const cpu = { ms: 1000 };
    const spawned: Fake[] = [];
    const fleet = createChoresFleet({
      home,
      beatMs: 5000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(root)],
      log: () => {},
      cpuTimeOf: () => cpu.ms,
      factory: (input) => {
        const child = fakeChild(6600 + spawned.length, input.config.routes[0]!.root, clock.at);
        spawned.push(child);
        return child.child;
      },
    });

    const tickAt = (offsetMs: number): void => {
      clock.at = NOW + offsetMs;
      fleet.tick(new Date(clock.at));
    };

    tickAt(0);
    const child = spawned[0]!;
    // A child still loading its watches: no `ready`, no beat, but the machine charges it CPU.
    for (let offsetMs = 5000; offsetMs <= 55_000; offsetMs += 5000) {
      cpu.ms += 500;
      tickAt(offsetMs);
      expect(child.kills).toEqual([]);
    }
    cpu.ms += 500;
    tickAt(60_000);
    expect(child.kills).toEqual([]);
    expect(fleet.stateFor(root)?.why).toContain('still');
    cpu.ms += 500;
    tickAt(65_000);
    expect(child.kills).toEqual([]);

    // The start stops consuming CPU: the deadline reason ends it.
    tickAt(70_000);
    expect(child.kills).toHaveLength(1);
    expect(child.kills[0]).toContain('did not beat twice');
  });

  test('6. while no child serves a root, presence runs inline and the row reads restarting', async () => {
    const { home, roots } = makeWorld(['root-down']);
    const root = roots[0]!;
    const clock = { at: NOW };
    const cpu = { ms: 30_000 };
    const spawned: Fake[] = [];
    const fleet = createChoresFleet({
      home,
      beatMs: 5000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(root)],
      log: () => {},
      cpuTimeOf: () => cpu.ms,
      factory: (input) => {
        const child = fakeChild(6700 + spawned.length, input.config.routes[0]!.root, clock.at);
        spawned.push(child);
        return child.child;
      },
    });

    const tickAt = (offsetMs: number): void => {
      clock.at = NOW + offsetMs;
      fleet.tick(new Date(clock.at));
    };

    tickAt(0);
    const child = spawned[0]!;
    child.emit({ type: 'ready', pid: child.pid, at: AT });
    child.emit(beat(NOW));
    tickAt(5000);
    child.emit(beat(NOW + 5000));
    tickAt(10_000);
    tickAt(15_000);
    tickAt(20_000);
    expect(child.kills).toEqual(['the child missed 2 heartbeats']);
    child.leave(null, 'SIGTERM');
    await Promise.resolve();
    await Promise.resolve();

    expect(fleet.presence({ root, at: new Date(NOW + 25_000), readings: [] })).toBeNull();
    expect(fleet.stateFor(root)?.state).toBe('restarting');
  });

  test('7. a child that answers after its end was asked is taken back into service, not left out forever', async () => {
    const { home, roots } = makeWorld(['root-answers-late']);
    const root = roots[0]!;
    const clock = { at: NOW };
    const cpu = { ms: 20_000 };
    const spawned: Fake[] = [];
    const fleet = createChoresFleet({
      home,
      beatMs: 5000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(root)],
      log: () => {},
      cpuTimeOf: () => cpu.ms,
      factory: (input) => {
        const child = fakeChild(6800 + spawned.length, input.config.routes[0]!.root, clock.at);
        spawned.push(child);
        return child.child;
      },
    });

    const tickAt = (offsetMs: number): void => {
      clock.at = NOW + offsetMs;
      fleet.tick(new Date(clock.at));
    };

    tickAt(0);
    const child = spawned[0]!;
    child.emit({ type: 'ready', pid: child.pid, at: AT });
    child.emit(beat(NOW));
    tickAt(5000);
    child.emit(beat(NOW + 5000));
    tickAt(10_000);
    tickAt(15_000);
    tickAt(20_000);
    expect(child.kills).toEqual(['the child missed 2 heartbeats']);
    expect(fleet.stateFor(root)?.state).toBe('late');

    // The handle's guard withheld the forced end because the process was still consuming CPU; the
    // child itself answers next. The end request is withdrawn and the group serves the root again,
    // rather than holding a live child out of service until the daemon restarts.
    clock.at = NOW + 25_000;
    child.emit(beat(NOW + 25_000));
    tickAt(30_000);
    expect(fleet.stateFor(root)).toMatchObject({ state: 'ok', restarts: 0, missed: 0 });
    expect(fleet.stateFor(root)?.why).toBeNull();
    expect(child.kills).toHaveLength(1);
    expect(child.sends.length).toBeGreaterThan(0);
  });

  test('8. a flat child is ended once, and the next start waits the 60 s floor', async () => {
    const { home, roots } = makeWorld(['root-stuck']);
    const root = roots[0]!;
    const clock = { at: NOW };
    const cpu = { ms: 30_000 };
    const spawned: Fake[] = [];
    const fleet = createChoresFleet({
      home,
      beatMs: 5000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(root)],
      log: () => {},
      cpuTimeOf: () => cpu.ms,
      factory: (input) => {
        const child = fakeChild(6900 + spawned.length, input.config.routes[0]!.root, clock.at);
        spawned.push(child);
        queueMicrotask(() => {
          if (!child.child.alive || child.kills.length > 0) return;
          const iso = new Date(child.spawnedAtMs).toISOString();
          child.emit({ type: 'ready', pid: child.pid, at: iso });
          child.emit(beat(child.spawnedAtMs));
        });
        return child.child;
      },
    });

    const tickAt = (offsetMs: number): void => {
      clock.at = NOW + offsetMs;
      fleet.tick(new Date(clock.at));
    };
    const settle = async (): Promise<void> => {
      await Promise.resolve();
      await Promise.resolve();
    };

    // First child: two beats, then silence with a flat CPU. End at two missed beats.
    tickAt(0);
    await settle();
    const first = spawned[0]!;
    tickAt(5000);
    first.emit(beat(NOW + 5000));
    tickAt(10_000);
    expect(first.kills).toEqual([]);
    tickAt(15_000);
    expect(first.kills).toEqual([]);
    tickAt(20_000);
    expect(first.kills).toEqual(['the child missed 2 heartbeats']);
    first.leave(null, 'SIGTERM');
    await settle();

    // The replacement may not start within 60 s of the end: the next start is due at 80 s.
    tickAt(21_000);
    expect(spawned).toHaveLength(1);
    expect(fleet.stateFor(root)).toMatchObject({ state: 'restarting' });
    expect(fleet.stateFor(root)?.nextStartAt).toBe(new Date(NOW + 80_000).toISOString());
    tickAt(79_000);
    expect(spawned).toHaveLength(1);
    tickAt(80_000);
    await settle();
    expect(spawned).toHaveLength(2);

    // The second child repeats the cycle, and the floor holds again: the end at 100 s puts the
    // next start at 160 s, never at 101 s.
    const second = spawned[1]!;
    tickAt(85_000);
    second.emit(beat(NOW + 85_000));
    tickAt(90_000);
    tickAt(95_000);
    tickAt(100_000);
    expect(second.kills).toEqual(['the child missed 2 heartbeats']);
    second.leave(null, 'SIGTERM');
    await settle();
    tickAt(101_000);
    expect(spawned).toHaveLength(2);
    expect(fleet.stateFor(root)?.nextStartAt).toBe(new Date(NOW + 160_000).toISOString());
    tickAt(160_000);
    await settle();
    expect(spawned).toHaveLength(3);

    // The pass mark at scene level: no two starts of this root are closer than 60 s.
    const starts = spawned.map((child) => child.spawnedAtMs);
    for (let index = 1; index < starts.length; index += 1) {
      expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(60_000);
    }
  });

  test('9. a child asked to end that keeps running without a beat is ended as a hung loop at the ceiling', async () => {
    const { home, roots } = makeWorld(['root-survivor']);
    const root = roots[0]!;
    const clock = { at: NOW };
    const cpu = { ms: 9000 };
    const spawned: Fake[] = [];
    const logs: string[] = [];
    const fleet = createChoresFleet({
      home,
      beatMs: 5000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(root)],
      log: (text) => logs.push(text),
      cpuTimeOf: () => cpu.ms,
      factory: (input) => {
        const child = fakeChild(7000 + spawned.length, input.config.routes[0]!.root, clock.at);
        spawned.push(child);
        return child.child;
      },
    });

    const tickAt = (offsetMs: number): void => {
      clock.at = NOW + offsetMs;
      fleet.tick(new Date(clock.at));
    };

    tickAt(0);
    const child = spawned[0]!;
    child.emit({ type: 'ready', pid: child.pid, at: AT });
    child.emit(beat(NOW));
    tickAt(5000);
    child.emit(beat(NOW + 5000));
    tickAt(10_000);
    tickAt(15_000);
    tickAt(20_000);
    expect(child.killCalls).toHaveLength(1);
    // The child survives the end request — the handle withheld the forced end because the process
    // was still consuming CPU — and never speaks again. It is not forgotten: ten minutes of
    // silence past its last beat ends it as a hung loop, with a forced end this time.
    for (let offsetMs = 25_000; offsetMs <= 600_000; offsetMs += 5000) {
      cpu.ms += 300;
      tickAt(offsetMs);
      expect(child.killCalls).toHaveLength(1);
    }
    cpu.ms += 300;
    tickAt(605_000);
    expect(child.killCalls).toHaveLength(2);
    expect(child.killCalls[1]?.options?.evenIfWorking).toBe(true);
    expect(child.killCalls[1]?.why).toContain('while its CPU kept advancing');
    expect(fleet.stateFor(root)?.why).toContain('not beaten for 600000 ms');
    expect(logs.some((line) => line.includes('hung loop'))).toBe(true);
  });

  test('10. a beat while the ceiling end is still in force does not take the child back into service', async () => {
    const { home, roots } = makeWorld(['root-ceiling-speaks']);
    const root = roots[0]!;
    const clock = { at: NOW };
    const cpu = { ms: 9000 };
    const spawned: Fake[] = [];
    const fleet = createChoresFleet({
      home,
      beatMs: 5000,
      since: AT,
      now: () => new Date(clock.at),
      routes: [routeInput(root)],
      log: () => {},
      cpuTimeOf: () => cpu.ms,
      factory: (input) => {
        const child = fakeChild(7200 + spawned.length, input.config.routes[0]!.root, clock.at);
        spawned.push(child);
        return child.child;
      },
    });

    const tickAt = (offsetMs: number): void => {
      clock.at = NOW + offsetMs;
      fleet.tick(new Date(clock.at));
    };

    tickAt(0);
    const child = spawned[0]!;
    child.emit({ type: 'ready', pid: child.pid, at: AT });
    child.emit(beat(NOW));
    tickAt(5000);
    child.emit(beat(NOW + 5000));
    tickAt(10_000);
    tickAt(15_000);
    tickAt(20_000);
    expect(child.killCalls).toHaveLength(1);
    for (let offsetMs = 25_000; offsetMs <= 600_000; offsetMs += 5000) {
      cpu.ms += 300;
      tickAt(offsetMs);
    }
    cpu.ms += 300;
    tickAt(605_000);
    expect(child.killCalls).toHaveLength(2);
    expect(child.killCalls[1]?.options?.evenIfWorking).toBe(true);

    // The child speaks once more while the forced end's grace is still running. A deliberate end
    // is not withdrawn by a beat: the child is still going to be forced, so it must not be sent a
    // tick again and its row must keep naming the hung loop until it leaves.
    const ticked = child.sends.length;
    child.emit(beat(NOW + 605_000));
    tickAt(610_000);
    expect(child.sends).toHaveLength(ticked);
    expect(child.killCalls).toHaveLength(2);
    expect(fleet.stateFor(root)?.why).toContain('not beaten for 600000 ms');
  });
});
