// The hosted watch yields to the daemon's beat. One route's pass is synchronous and can hold
// the only event loop for the length of its slowest herdr read; the interval beats it spans
// never run, so the routes beside it would age out of their authority while it works. A due
// beat therefore lands inside the pass: the pass carries it to every other hosted route, and
// never to the route whose pass it is (that pass can hold its own state's lock).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import { routeOf, type HostedRoute } from '../src/daemon/routes.ts';
import { createHostedBeat, createHostedWatch, type HostedBeat, type HostedWatch } from '../src/daemon/watch.ts';
import { hostedWatchAuthority } from '../src/daemon/watch-authority.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { WATCH_DIRECT_WORK, verifyWatchAuthority } from '../src/watch/authority.ts';
import { WATCH_AUTHORITY_MAX_AGE_MS } from '../src/watch/epoch.ts';
import { forgetIdleEpisodes, type WorkPushRequest } from '../src/watch/dispatch.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';

const NOW = Date.parse('2026-10-20T05:00:00Z');
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

type World = { root: string; home: string; agents: string; teamFile: string };

let base = '';

function makeWorld(name: string): World {
  const root = join(base, name, 'repo');
  const home = join(base, name, 'home');
  const agents = join(root, '.agents');
  mkdirSync(agents, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const teamFile = join(agents, 'team.yaml');
  writeFileSync(teamFile, CREW);
  writeFileSync(join(agents, 'queue.yaml'), '- id: t1\n  title: "First"\n');
  updateState(agents, (state) => {
    const session = (state.sessions.crew ??= emptySession());
    session.seats['worker-1'] = { stage: 'ready', last_active: new Date(NOW - 10 * 60_000).toISOString() };
  });
  return { root, home, agents, teamFile };
}

beforeEach(() => {
  forgetIdleEpisodes();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-hosted-beat-')));
});

afterEach(() => {
  forgetIdleEpisodes();
  rmSync(base, { recursive: true, force: true });
});

function routeOfWorld(world: World): HostedRoute {
  return routeOf(world.root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
}

function recordOf(world: World): { pid?: number; heartbeat: string; epoch?: string } | undefined {
  return readState(world.agents).sessions.crew?.watch;
}

function live(): Live {
  const agents: HerdrAgent[] = [{
    name: 'worker-1', agent: 'claude', pane: 'pane-worker', workspace: 'pane-ws', status: 'idle', cwd: null,
  }];
  return {
    running: true,
    agents,
    workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })),
    screens: { 'pane-worker': idleScreen },
  };
}

function idleSources(world: World, clock: { at: number }): WatchSources {
  return {
    live: () => live(),
    machine: () => fine,
    standing: () => ({ kind: 'none' }),
    readChecks: () => [],
    screen: () => idleScreen,
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
    alive: () => true,
    pid: process.pid,
    home: world.home,
    statusSource: undefined,
  };
}

function quietSources(world: World, clock: { at: number }): WatchSources {
  return {
    ...idleSources(world, clock),
    live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
  };
}

function hostOf(
  route: HostedRoute,
  build: ReturnType<typeof hostedWatchAuthority>,
  clock: { at: number },
  beat: HostedBeat,
): HostedWatch {
  return createHostedWatch({
    route,
    now: () => new Date(clock.at),
    ...build,
    onTick: build.tick,
    onBeat: () => beat.midPass(route),
  });
}

async function waitUntil(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the hosted watch');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the beat between hosted routes', () => {
  test('a due beat lands mid-pass, renews the other route and never the calling one', async () => {
    const a = makeWorld('a');
    const b = makeWorld('b');
    const routeA = routeOfWorld(a);
    const routeB = routeOfWorld(b);
    const clock = { at: NOW };
    const hosts: HostedWatch[] = [];
    const beat = createHostedBeat({
      intervalMs: 5_000,
      watches: () => hosts,
      log: () => {},
      now: () => new Date(clock.at),
    });

    // Route B is an ordinary hosted route in the same process: it acquires its authority,
    // opens its effects and finishes its first pass before route A starts.
    const pushes: WorkPushRequest[] = [];
    const buildB = hostedWatchAuthority({
      route: routeB,
      teamFile: b.teamFile,
      log: () => {},
      now: () => new Date(clock.at),
      base: idleSources(b, clock),
      verifyAuthority: (check) =>
        verifyWatchAuthority({ ...check, purpose: WATCH_DIRECT_WORK, now: new Date(clock.at) }),
      sender: () => async (request) => {
        pushes.push(request);
        return { ok: true, outcome: 'typed (unconfirmed)' };
      },
    });
    const hostB = hostOf(routeB, buildB, clock, beat);
    hosts.push(hostB);
    await waitUntil(() => pushes.length === 1 && hostB.state().effects === 'open');
    expect(recordOf(b)?.heartbeat).toBe(new Date(NOW).toISOString());

    // Route A reads slowly. Each read advances the shared clock by more than one heartbeat, so
    // every seam lands on a due beat; the interval itself never runs while the pass holds the
    // loop. What B's record said at the machine read is taken from inside the pass.
    const seenAtMachine: string[] = [];
    const baseA: WatchSources = {
      ...quietSources(a, clock),
      live: () => {
        clock.at += 7_000;
        return { running: true, agents: [], workspaces: [], screens: {} };
      },
      readChecks: () => {
        clock.at += 7_000;
        return [];
      },
      machine: () => {
        seenAtMachine.push(recordOf(b)?.heartbeat ?? '');
        clock.at += 7_000;
        return fine;
      },
    };
    const buildA = hostedWatchAuthority({
      route: routeA,
      teamFile: a.teamFile,
      log: () => {},
      now: () => new Date(clock.at),
      base: baseA,
    });
    const hostA = hostOf(routeA, buildA, clock, beat);
    hosts.push(hostA);
    await waitUntil(() => hostA.state().cycles >= 1, 8000);

    // Two due beats landed inside A's pass before its machine read: B was renewed at 7 s and at
    // 14 s on the pass's own clock, while A's interval beat was blocked.
    expect(seenAtMachine).toEqual([new Date(NOW + 14_000).toISOString()]);
    // A third landed after the machine read. B's record is current at the pass's end, inside the
    // fixed freshness bound the shared verifier judges every effect by.
    const endedAt = new Date(NOW + 21_000).toISOString();
    expect(recordOf(b)?.heartbeat).toBe(endedAt);
    expect(clock.at - Date.parse(recordOf(b)!.heartbeat)).toBeLessThanOrEqual(WATCH_AUTHORITY_MAX_AGE_MS);
    // The effect gate itself admits B's captured epoch at that instant: no stale effect runs.
    const verdict = verifyWatchAuthority({
      root: routeB.root,
      session: 'crew',
      epoch: recordOf(b)!.epoch!,
      purpose: WATCH_DIRECT_WORK,
      now: new Date(clock.at),
    });
    expect(verdict.ok).toBe(true);
    expect(hostB.state().effects).toBe('open');
    expect(hostB.state().phase).toBe('running');
    // The route whose pass ran is never pulsed by that pass: its own heartbeat is untouched, so
    // a busy renewal judged against a held lock can never drain it from inside its fold.
    expect(recordOf(a)?.heartbeat).toBe(new Date(NOW).toISOString());

    await hostA.stop('test end');
    await hostB.stop('test end');
  });

  test('between beats the seam is a no-op, and a due one reaches every route but the caller', () => {
    const clock = { at: NOW };
    const ticked: string[] = [];
    const fake = (root: string): HostedWatch => ({
      route: routeOf(root, 'acme-web', 'crew', []),
      state: () => {
        throw new Error('unused');
      },
      tick: (at: Date) => {
        ticked.push(`${root} ${at.toISOString()}`);
      },
      stop: async () => {},
      done: Promise.resolve(),
      fault: () => false,
    });
    const self = fake('/repo/self');
    const other = fake('/repo/other');
    const beat = createHostedBeat({
      intervalMs: 5_000,
      watches: () => [self, other],
      log: () => {},
      now: () => new Date(clock.at),
    });

    // Between beats nothing is ticked, however often a pass yields.
    clock.at = NOW + 4_999;
    beat.midPass(self.route);
    expect(ticked).toEqual([]);
    // A due beat reaches the other route only.
    clock.at = NOW + 5_000;
    beat.midPass(self.route);
    expect(ticked).toEqual([`/repo/other ${new Date(NOW + 5_000).toISOString()}`]);
    // The daemon's interval beat ticks every route, itself included, and marks the beat.
    clock.at = NOW + 6_000;
    beat.tick();
    expect(ticked).toEqual([
      `/repo/other ${new Date(NOW + 5_000).toISOString()}`,
      `/repo/self ${new Date(NOW + 6_000).toISOString()}`,
      `/repo/other ${new Date(NOW + 6_000).toISOString()}`,
    ]);
    // A pass that yields right after the interval beat is a no-op again.
    clock.at = NOW + 7_000;
    beat.midPass(self.route);
    expect(ticked).toHaveLength(3);
  });

  test('a throwing peer tick is logged and does not stop the others', () => {
    const clock = { at: NOW };
    const ticked: string[] = [];
    const logs: string[] = [];
    const fake = (root: string, throws: boolean): HostedWatch => ({
      route: routeOf(root, 'acme-web', 'crew', []),
      state: () => {
        throw new Error('unused');
      },
      tick: () => {
        if (throws) throw new Error('the state lock is held');
        ticked.push(root);
      },
      stop: async () => {},
      done: Promise.resolve(),
      fault: () => false,
    });
    const beat = createHostedBeat({
      intervalMs: 5_000,
      watches: () => [fake('/repo/a', true), fake('/repo/b', false)],
      log: (text) => logs.push(text),
      now: () => new Date(clock.at),
    });
    clock.at = NOW + 5_000;
    beat.midPass(routeOf('/repo/self', 'acme-web', 'crew', []));
    expect(ticked).toEqual(['/repo/b']);
    expect(logs).toEqual(['root /repo/a: the hosted watch tick failed: the state lock is held']);
  });
});
