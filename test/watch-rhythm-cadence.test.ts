// Live cadence acceptance for the governed watch rhythm.
//
// These scenes drive the production hosted loop (`createHostedWatch` + `hostedWatchRun`) over
// authored scratch roots, an authored team file and a controlled clock. They pin two claims:
//
//   1. A signed `watch-rhythm` is read again on every pass: changing it while the watch waits
//      changes the cadence the next pass asks for, with no restart (one run, one host).
//   2. The daemon's heartbeat runs on its own fixed timer: it stamps and answers health while a
//      long governed wait is pending, never releases a wait before its due instant, and never
//      scales with the preset's wait factor.
//
// Every root is isolated and every policy write is signed with that scratch home's own key.
// Nothing here touches a live policy, a live service, a pane or an owner home.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import type { WatchSources } from '../src/commands/watch.ts';
import { daemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { routeOf } from '../src/daemon/routes.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import { createHostedWatch } from '../src/daemon/watch.ts';
import { hostedWatchRun } from '../src/daemon/watch-run.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import type { Standing } from '../src/store/store.ts';
import type { Machine } from '../src/watch/machine.ts';
import type { HostedLoop } from '../src/watch/hosted.ts';

const NOW = Date.parse('2026-10-21T09:00:00Z');
const PID = 5150;

const TEAM = `format: 1
project: rhythm-lab
session: pulse
coordinator: pulse-lead
operator: pulse-op
workspace:
  mode: shared
watch:
  interval: 45s
seats:
  - role: coordinator
    name: pulse-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: pulse-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: worker
    name: pulse-worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

const fine: Machine = {
  loadPerCore: 0.4,
  memoryFree: 55,
  diskFree: 400e9,
  swapTotal: 8e9,
  swapFree: 7e9,
  swapUsed: 1e9,
};

type Clock = { at: number };

function clockAt(at: number): Clock {
  return { at };
}

function teamOf(text: string): TeamFile {
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.team;
}

function teamAt(root: string): TeamFile {
  return teamOf(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8'));
}

let base = '';
let root = '';
let home = '';

function scratch(): void {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'watch-rhythm-cadence-')));
  root = join(base, 'repo');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
}

beforeEach(() => {
  scratch();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function signed(value: string, at: number = NOW): void {
  const plan = writePolicySet(home, {
    level: 'team',
    target: teamIdOf(root),
    teamRoot: root,
    name: 'watch-rhythm',
    value,
  }, { now: new Date(at) });
  if (!plan.ok) throw new Error(`the signed watch-rhythm was refused: ${plan.why}`);
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the hosted watch');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A recording loop: every wait the pass asks for, in milliseconds, in order. */
function recording(loop: HostedLoop, asked: number[]): HostedLoop {
  return {
    signal: loop.signal,
    wait(ms) {
      asked.push(ms);
      return loop.wait(ms);
    },
    cycled(at) {
      loop.cycled(at);
    },
    standby(why) {
      loop.standby(why);
    },
  };
}

/**
 * The read sources a hosted pass runs with: no live session (this suite measures cadence, not
 * panes), a verified reading of the root's current file, and the scratch home for the policy
 * chain. The hosted source set closes every mutating source over this base.
 */
function sourcesAt(clock: Clock, at: string): WatchSources {
  return {
    live: () => null,
    machine: () => fine,
    standing: (where: string): Standing =>
      verifiedOf(teamAt(where), join(where, '.agents', 'team.yaml'), where, new Date(clock.at)),
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
    pid: PID,
    home: at,
  };
}

type Harness = {
  host: ReturnType<typeof createHostedWatch>;
  clock: Clock;
  asked: number[];
  log: string[];
  starts: () => number;
};

/** One hosted watch over the scratch route, with a controlled clock and a recorded wait list. */
function hosted(): Harness {
  const clock = clockAt(NOW);
  const asked: number[] = [];
  const log: string[] = [];
  let starts = 0;
  const route = routeOf(root, 'rhythm-lab', 'pulse', ['pulse-lead', 'pulse-op', 'pulse-worker']);
  const run = hostedWatchRun({
    route,
    log: (text) => log.push(text),
    base: sourcesAt(clock, home),
    pid: PID,
  });
  const host = createHostedWatch({
    route,
    now: () => new Date(clock.at),
    run: (loop) => {
      starts += 1;
      return run(recording(loop, asked));
    },
  });
  return { host, clock, asked, log, starts: () => starts };
}

describe('a signed rhythm reloads without a restart', () => {
  test('a changed preset and sweep change the cadence the next pass asks for', async () => {
    signed('relaxed');
    const watch = hosted();
    await until(() => watch.asked.length === 1);
    expect(watch.asked).toEqual([240_000]);
    expect(watch.host.state()).toMatchObject({ phase: 'running', cycles: 1, startedAt: new Date(NOW).toISOString() });

    // The signed value changes while the first wait is pending.
    signed('urgent@15', NOW + 1_000);
    watch.clock.at = NOW + 240_000;
    watch.host.tick(new Date(watch.clock.at));
    await until(() => watch.asked.length === 2);
    // The explicit sweep is final: the urgent factor does not scale it, and the old sweep is gone.
    expect(watch.asked).toEqual([240_000, 15_000]);

    watch.clock.at = NOW + 255_000;
    watch.host.tick(new Date(watch.clock.at));
    await until(() => watch.asked.length === 3);
    expect(watch.asked).toEqual([240_000, 15_000, 15_000]);
    expect(watch.host.state()).toMatchObject({
      phase: 'running',
      cycles: 3,
      failures: 0,
      lastCycleAt: new Date(NOW + 255_000).toISOString(),
    });
    // One host, one run: the cadence changed inside the running watch.
    expect(watch.starts()).toBe(1);
    // The announcement belongs to the first pass only; the reload is measured by the waits.
    const watching = watch.log.filter((line) => line.includes('watching the session'));
    expect(watching).toHaveLength(1);
    expect(watching[0]).toContain('every 240s');
    await watch.host.stop('done');
  });

  test('changing only the sweep keeps the preset and still changes the next cadence', async () => {
    signed('night@30');
    const watch = hosted();
    await until(() => watch.asked.length === 1);
    // Night's factor would scale the six other waits, never this sweep.
    expect(watch.asked).toEqual([30_000]);

    signed('night@45', NOW + 1_000);
    watch.clock.at = NOW + 30_000;
    watch.host.tick(new Date(watch.clock.at));
    await until(() => watch.asked.length === 2);
    expect(watch.asked).toEqual([30_000, 45_000]);

    watch.clock.at = NOW + 75_000;
    watch.host.tick(new Date(watch.clock.at));
    await until(() => watch.asked.length === 3);
    expect(watch.asked).toEqual([30_000, 45_000, 45_000]);
    expect(watch.starts()).toBe(1);
    await watch.host.stop('done');
  });

  test('with no signed policy the verified file interval is re-read each pass', async () => {
    const watch = hosted();
    await until(() => watch.asked.length === 1);
    expect(watch.asked).toEqual([45_000]);

    // The owner's file changes between passes; the same watch runs.
    writeFileSync(join(root, '.agents', 'team.yaml'), TEAM.replace('interval: 45s', 'interval: 12s'));
    watch.clock.at = NOW + 45_000;
    watch.host.tick(new Date(watch.clock.at));
    await until(() => watch.asked.length === 2);
    expect(watch.asked).toEqual([45_000, 12_000]);

    // A declared interval below the floor is normalized on the next pass, and said once.
    writeFileSync(join(root, '.agents', 'team.yaml'), TEAM.replace('interval: 45s', 'interval: 5s'));
    watch.clock.at = NOW + 57_000;
    watch.host.tick(new Date(watch.clock.at));
    await until(() => watch.asked.length === 3);
    expect(watch.asked).toEqual([45_000, 12_000, 10_000]);
    expect(watch.log.filter((line) => line.includes('below the 10s sweep floor'))).toHaveLength(1);
    expect(watch.host.state()).toMatchObject({ phase: 'running', cycles: 3, failures: 0 });
    expect(watch.starts()).toBe(1);
    await watch.host.stop('done');
  });
});

describe('the daemon heartbeat stays independent of the governed pace', () => {
  test('beats keep stamping through a long wait, and releases land exactly at the due instant', async () => {
    signed('night@30');
    const clock = clockAt(NOW);
    const asked: number[] = [];
    const route = routeOf(root, 'rhythm-lab', 'pulse', ['pulse-lead', 'pulse-op', 'pulse-worker']);
    const base = sourcesAt(clock, home);
    let starts = 0;
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'service-manager',
      version: '0.5.4-rhythm-cadence-test',
      heartbeatMs: 20,
      now: () => new Date(clock.at),
      watchHosting: true,
      hostedWatch: (one, log) => ({
        run: (loop) => {
          starts += 1;
          return hostedWatchRun({ route: one, log, base, pid: PID })(recording(loop, asked));
        },
      }),
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    const watchOf = () => {
      const read = readDaemonState(home);
      return read.kind === 'ok' ? read.state.roots[0]?.watch : undefined;
    };
    try {
      await until(() => (watchOf()?.cycles ?? 0) === 1 && asked.length === 1);
      expect(asked).toEqual([30_000]);
      expect(watchOf()?.lastCycleAt).toBe(new Date(NOW).toISOString());

      // A beat at a five-second-scale clock reading stamps the record with no pass.
      clock.at = NOW + 5_000;
      await until(() => {
        const read = readDaemonState(home);
        return read.kind === 'ok' && read.state.heartbeatAt === new Date(NOW + 5_000).toISOString();
      });
      expect(watchOf()?.cycles).toBe(1);
      // Health answers while the governed wait is pending.
      expect((await daemonHealth(home)).state).toBe('running');

      // One millisecond before the wait's own due instant: the beat stamps, no pass starts.
      clock.at = NOW + 29_999;
      await until(() => {
        const read = readDaemonState(home);
        return read.kind === 'ok' && read.state.heartbeatAt === new Date(NOW + 29_999).toISOString();
      });
      expect(watchOf()?.cycles).toBe(1);

      // At the due instant the beat releases the pass; the next cadence is unchanged.
      clock.at = NOW + 30_000;
      await until(() => (watchOf()?.cycles ?? 0) === 2 && asked.length === 2);
      expect(watchOf()?.lastCycleAt).toBe(new Date(NOW + 30_000).toISOString());
      expect(asked).toEqual([30_000, 30_000]);

      // A signed change made while the second wait is pending reaches the following pass.
      signed('urgent@10', NOW + 30_000);
      clock.at = NOW + 35_000;
      await until(() => {
        const read = readDaemonState(home);
        return read.kind === 'ok' && read.state.heartbeatAt === new Date(NOW + 35_000).toISOString();
      });
      expect(watchOf()?.cycles).toBe(2);
      clock.at = NOW + 60_000;
      await until(() => (watchOf()?.cycles ?? 0) === 3 && asked.length === 3);
      expect(watchOf()?.lastCycleAt).toBe(new Date(NOW + 60_000).toISOString());
      expect(asked).toEqual([30_000, 30_000, 10_000]);

      // The new ten-second wait also releases only at its own due instant.
      clock.at = NOW + 65_000;
      await until(() => {
        const read = readDaemonState(home);
        return read.kind === 'ok' && read.state.heartbeatAt === new Date(NOW + 65_000).toISOString();
      });
      expect(watchOf()?.cycles).toBe(3);
      clock.at = NOW + 70_000;
      await until(() => (watchOf()?.cycles ?? 0) === 4 && asked.length === 4);
      expect(watchOf()?.lastCycleAt).toBe(new Date(NOW + 70_000).toISOString());
      expect(asked).toEqual([30_000, 30_000, 10_000, 10_000]);
      expect(starts).toBe(1);
    } finally {
      await started.daemon.close();
    }
  }, 15_000);
});
