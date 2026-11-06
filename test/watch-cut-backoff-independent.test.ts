// Independent verification of the cut-pass retry backoff (C7.6 cause D): after a pass whose
// read phase was cut short, the watch waits five seconds, doubling on each consecutive cut up
// to its own interval; a pass that reads in full clears the count, so a later cut starts a new
// episode at five seconds and says its line again. Every scene drives the shared hosted loop
// with the clock, the reader and the waits injected; the wait each pass asked for is recorded
// at the loop's seam, and no scene reads a real clock, waits a wall time or opens a session.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import type { AsyncLiveRead } from '../src/commands/status.ts';
import { routeOf, type HostedRoute } from '../src/daemon/routes.ts';
import { createHostedWatch, type HostedWatch } from '../src/daemon/watch.ts';
import { hostedWatchRun } from '../src/daemon/watch-run.ts';
import type { HerdrAgent, HerdrWorkspace, PaneProcesses } from '../src/herdr.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { forgetIdleEpisodes } from '../src/watch/dispatch.ts';
import type { HostedLoop } from '../src/watch/hosted.ts';
import type { Machine } from '../src/watch/machine.ts';

const NOW = Date.parse('2026-11-02T09:00:00Z');
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idleScreen = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const PUSH_LAUNCH = 'claude --dangerously-load-development-channels server:team-inbox';
const CUT_LINE = 'the read pass ran out of its 2000 ms budget';

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
    version: "5.5"
    launch: claude
  - role: operator
    name: crew-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: worker
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
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
  base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'team-cut-backoff-independent-')));
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

function sourcesOf(world: World, clock: { at: number }, liveAsync: WatchSources['liveAsync']): WatchSources {
  return {
    live: () => null,
    liveAsync,
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
  };
}

function recording(loop: HostedLoop, asked: number[]): HostedLoop {
  return {
    ...loop,
    wait: (ms) => {
      asked.push(ms);
      return loop.wait(ms);
    },
  };
}

type Hosted = { host: HostedWatch; asked: number[]; log: string[] };

function hostedOf(world: World, clock: { at: number }, liveAsync: WatchSources['liveAsync']): Hosted {
  const route = routeOfWorld(world);
  const asked: number[] = [];
  const log: string[] = [];
  const host = createHostedWatch({
    route,
    now: () => new Date(clock.at),
    run: (loop) => hostedWatchRun({
      route,
      log: (text) => void log.push(text),
      base: sourcesOf(world, clock, liveAsync),
    })(recording(loop, asked)),
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

/** Lets the last pass end at its own due instant and returns once the next pass asks for a wait. */
async function oneMorePass(hosted: Hosted, clock: { at: number }): Promise<void> {
  const before = hosted.asked.length;
  if (before === 0) throw new Error('no pass has asked for a wait yet');
  const due = hosted.asked[before - 1]!;
  clock.at += due;
  hosted.host.tick(new Date(clock.at));
  await until(() => hosted.asked.length === before + 1);
}

function cutLines(log: string[]): string[] {
  return log.filter((line) => line.includes(CUT_LINE));
}

describe('the cut-pass retry backoff', () => {
  test('a pass that reads in full asks for the whole interval and says no cut line', async () => {
    const world = makeWorld('full');
    const clock = { at: NOW };
    const hosted = hostedOf(world, clock, async () => (
      { live: fullLive(), next: 0, cut: false } satisfies AsyncLiveRead
    ));
    await until(() => hosted.asked.length >= 1);

    expect(hosted.asked).toEqual([120_000]);
    expect(cutLines(hosted.log)).toEqual([]);

    await hosted.host.stop('test end');
  });

  test('consecutive cut passes double from five seconds up to the interval and hold there', async () => {
    const world = makeWorld('plateau');
    const clock = { at: NOW };
    const hosted = hostedOf(world, clock, async () => {
      clock.at += 2000;
      return { live: fullLive(), next: 0, cut: true } satisfies AsyncLiveRead;
    });
    await until(() => hosted.asked.length >= 1);

    // Twelve consecutive cut passes: five doublings, then the 120 s interval for the rest.
    for (let index = 0; index < 11; index += 1) await oneMorePass(hosted, clock);

    expect(hosted.asked.slice(0, 6)).toEqual([5000, 10_000, 20_000, 40_000, 80_000, 120_000]);
    expect(hosted.asked).toHaveLength(12);
    expect(hosted.asked.slice(5)).toEqual(Array(7).fill(120_000));
    for (const ms of hosted.asked) expect(Number.isFinite(ms)).toBe(true);
    expect(cutLines(hosted.log)).toHaveLength(1);

    await hosted.host.stop('test end');
  });

  test('a full read between cut episodes resets the retry to five seconds and each episode says its line once', async () => {
    const world = makeWorld('episodes');
    const clock = { at: NOW };
    // cut, cut, full, cut, cut, full, cut
    const pattern = [true, true, false, true, true, false, true];
    let pass = 0;
    const hosted = hostedOf(world, clock, async () => {
      const cut = pattern[pass]!;
      pass += 1;
      if (cut) clock.at += 2000;
      return { live: fullLive(), next: 0, cut } satisfies AsyncLiveRead;
    });
    await until(() => hosted.asked.length >= 1);

    for (let index = 0; index < 6; index += 1) await oneMorePass(hosted, clock);

    // Cut 1: 5 s, cut 2: 10 s, full: the interval; the next cut starts again at 5 s.
    expect(hosted.asked).toEqual([5000, 10_000, 120_000, 5000, 10_000, 120_000, 5000]);
    expect(cutLines(hosted.log)).toHaveLength(3);

    await hosted.host.stop('test end');
  });
});
