// LL3: every stall the daemon records — a beat that arrives late on the main loop, a child
// ended for silence — logs the machine's 1-minute load beside it, so a load stall is told
// apart from the daemon's own work in the log alone. In-process fakes and synthetic roots
// only; the load is injected, never read from the host machine.
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

const NOW = Date.parse('2026-11-05T02:00:00.000Z');
const AT = new Date(NOW).toISOString();
const RSS = 48 * 1024 * 1024;
/** One unchanging CPU total. A silent child is ended only when the process table says it did not advance. */
const flatCpu = (): number => 5_000;
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function teamFile(): TeamFile {
  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return validated.team;
}

function makeWorld(): { home: string; root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-stall-load-')));
  dirs.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const root = join(base, 'root-one');
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
  return { home, root };
}

function routeInput(root: string): ChoresRouteInput {
  const policy: ChoresPolicy = { mode: 'per-root', sliceMs: 2000, missedBeats: 2, backoffCapMs: 30_000 };
  return {
    route: routeOf(root, 'acme', 'acme-dev', ['crew-lead']),
    team: teamFile(),
    policy,
    watch: { teamFile: join(root, '.agents', 'team.yaml'), presence: false },
  };
}

type Fake = {
  child: ChoresChild;
  kills: string[];
  emit(message: ChoresChildMessage): void;
};

function fakeChild(pid: number): Fake {
  const listeners = new Set<(event: ChoresChildEvent) => void>();
  let settle: () => void = () => {};
  const exited = new Promise<void>((resolve) => { settle = resolve; });
  const kills: string[] = [];
  const sends: ChoresHostMessage[] = [];
  const child: ChoresChild = {
    pid,
    alive: true,
    send(message) { sends.push(message); return true; },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    kill(why) { kills.push(why); },
    exited,
  };
  void settle;
  return {
    child,
    kills,
    emit(message) {
      for (const listener of [...listeners]) listener({ kind: 'message', message });
    },
  };
}

function makeFleet(home: string, root: string, clock: { at: number }, logs: string[], spawned: Fake[]) {
  return createChoresFleet({
    home,
    beatMs: 1000,
    since: AT,
    now: () => new Date(clock.at),
    routes: [routeInput(root)],
    log: (text) => logs.push(text),
    loadAverage: () => 23.456,
    cpuTimeOf: flatCpu,
    factory: () => {
      const fake = fakeChild(4100 + spawned.length);
      spawned.push(fake);
      return fake.child;
    },
  });
}

function beat(fake: Fake, atMs: number): void {
  fake.emit({ type: 'heartbeat', at: new Date(atMs).toISOString(), rssBytes: RSS, busy: null, markerCache: null });
}

describe('a recorded stall carries the machine load', () => {
  test('a late daemon beat logs the load and ends no child', () => {
    const { home, root } = makeWorld();
    const clock = { at: NOW };
    const logs: string[] = [];
    const spawned: Fake[] = [];
    const fleet = makeFleet(home, root, clock, logs, spawned);
    fleet.tick(new Date(clock.at));
    const child = spawned[0]!;
    child.emit({ type: 'ready', pid: 4100, at: AT });
    beat(child, clock.at);
    clock.at += 1000;
    fleet.tick(new Date(clock.at));
    beat(child, clock.at);
    // The next beat arrives 3.5 s later on a 1 s cadence: the main loop itself stalled.
    clock.at += 3500;
    fleet.tick(new Date(clock.at));
    expect(logs.some((line) => line.includes('arrived late') && line.includes('machine load (1 min) 23.5'))).toBe(true);
    expect(child.kills).toEqual([]);
  });

  test('a child ended for missed heartbeats logs the load beside the end', () => {
    const { home, root } = makeWorld();
    const clock = { at: NOW };
    const logs: string[] = [];
    const spawned: Fake[] = [];
    const fleet = makeFleet(home, root, clock, logs, spawned);
    fleet.tick(new Date(clock.at));
    const child = spawned[0]!;
    child.emit({ type: 'ready', pid: 4100, at: AT });
    beat(child, clock.at);
    clock.at += 1000;
    fleet.tick(new Date(clock.at));
    beat(child, clock.at);
    // On-time beats, then silence. The process table stays flat, so the missed beats end the child and the load is logged beside that end.
    clock.at += 1000;
    fleet.tick(new Date(clock.at));
    clock.at += 1000;
    fleet.tick(new Date(clock.at));
    clock.at += 1000;
    fleet.tick(new Date(clock.at));
    expect(child.kills).toHaveLength(1);
    expect(logs.some((line) => line.includes('ending it and starting a replacement') && line.includes('machine load (1 min) 23.5'))).toBe(true);
  });
});
