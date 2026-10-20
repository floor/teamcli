import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import { routeOf } from '../src/daemon/routes.ts';
import { createHostedWatch } from '../src/daemon/watch.ts';
import { HOSTED_AUTHORITY_TICK_MS, hostedWatchAuthority, type WatchAuthorityCheck } from '../src/daemon/watch-authority.ts';
import { emptySession, LOCK_FILE, readState, STATE_FILE, updateState } from '../src/state.ts';
import { forgetIdleEpisodes, type WorkPushRequest } from '../src/watch/dispatch.ts';
import { mintWatchEpoch } from '../src/watch/epoch.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-20T05:00:00Z');
const WIN = '5.5';
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idleScreen = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

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
    launch: claude
`;

function live(): Live {
  const agents: HerdrAgent[] = [{
    name: 'worker-1', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null,
  }];
  return {
    running: true,
    agents,
    workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })),
    screens: { 'w1:p1': idleScreen },
  };
}

let base = '';
let root = '';
let home = '';
let agents = '';
let teamFile = '';

beforeEach(() => {
  forgetIdleEpisodes();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-watch-authority-')));
  root = join(base, 'repo');
  home = join(base, 'home');
  agents = join(root, '.agents');
  teamFile = join(agents, 'team.yaml');
  mkdirSync(agents, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(teamFile, CREW);
  writeFileSync(join(agents, 'queue.yaml'), '- id: t1\n  title: "First"\n');
  updateState(agents, (state) => {
    const session = (state.sessions.crew ??= emptySession());
    session.seats['worker-1'] = { stage: 'ready', last_active: new Date(NOW - 10 * MIN).toISOString() };
  });
});

afterEach(() => {
  forgetIdleEpisodes();
  rmSync(base, { recursive: true, force: true });
});

function route() {
  return routeOf(root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
}

function bind(file = teamFile): void {
  updateState(agents, (state) => {
    (state.sessions.crew ??= emptySession()).watchdog = { file };
  });
}

function record(): { pid?: number; heartbeat: string; epoch?: string; pane?: string } | undefined {
  return readState(agents).sessions.crew?.watch;
}

function idleSources(clock: { at: number }): WatchSources {
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
    home,
    statusSource: undefined,
  };
}

function quietSources(clock: { at: number }): WatchSources {
  return {
    ...idleSources(clock),
    live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
  };
}

/** A hosted watch as the daemon composes it: the build's own tick rides the fixed beat. */
function machine(
  build: ReturnType<typeof hostedWatchAuthority>, clock: { at: number },
) {
  return createHostedWatch({
    route: route(),
    now: () => new Date(clock.at),
    ...build,
    onTick: build.tick,
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

describe('the watchdog file binding', () => {
  test('a route with no recorded binding is blocked, runs nothing and writes no authority', async () => {
    const logs: string[] = [];
    const build = hostedWatchAuthority({ route: route(), teamFile, log: (text) => logs.push(text) });
    expect(build.effects).toBe('blocked');
    expect(build.standby).toContain('records no watchdog file binding');
    const host = createHostedWatch({ route: route(), now: () => new Date(NOW), ...build, onTick: build.tick });
    expect(host.state()).toMatchObject({ phase: 'standby', why: build.standby, effects: 'blocked', cycles: 0 });
    expect(record()).toBeUndefined();
    expect(logs.some((line) => line.includes('the hosted watch is blocked'))).toBe(true);
    await host.stop('done');
  });

  test('a binding that names another file is blocked with that mismatch, and writes nothing', async () => {
    bind(join(agents, 'other.yaml'));
    const logs: string[] = [];
    const build = hostedWatchAuthority({ route: route(), teamFile, log: (text) => logs.push(text) });
    expect(build.effects).toBe('blocked');
    expect(build.standby).toContain("is not this route's team file");
    expect(record()).toBeUndefined();
    const host = createHostedWatch({ route: route(), now: () => new Date(NOW), ...build, onTick: build.tick });
    expect(host.state().phase).toBe('standby');
    await host.stop('done');
  });
});

describe('the authority under the hosted watch', () => {
  test('a standing pane record holds it in standby and is left exactly as it stood', async () => {
    bind();
    const heartbeat = new Date(NOW).toISOString();
    updateState(agents, (state) => {
      (state.sessions.crew ??= emptySession()).watch = { pane: 'w1:p1', heartbeat };
    });
    const before = readFileSync(join(agents, STATE_FILE), 'utf8');
    const clock = { at: NOW };
    const build = hostedWatchAuthority({
      route: route(), teamFile, log: () => {}, now: () => new Date(clock.at), base: quietSources(clock),
    });
    const host = machine(build, clock);
    await waitUntil(() => host.state().phase === 'standby');
    expect(host.state().why).toContain('a watch authority stands for the session "crew"');
    expect(readFileSync(join(agents, STATE_FILE), 'utf8')).toBe(before);
    expect(record()).toEqual({ pane: 'w1:p1', heartbeat });
    await host.stop('done');
  });

  test('a busy state lock is retried on the next fixed tick, then the watch holds the authority', async () => {
    bind();
    writeFileSync(join(agents, LOCK_FILE), '1\n');
    const clock = { at: NOW };
    const build = hostedWatchAuthority({
      route: route(), teamFile, log: () => {}, now: () => new Date(clock.at), base: quietSources(clock),
    });
    const host = machine(build, clock);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.state().phase).toBe('starting');
    expect(record()).toBeUndefined();
    rmSync(join(agents, LOCK_FILE));
    clock.at = NOW + HOSTED_AUTHORITY_TICK_MS;
    host.tick(new Date(clock.at));
    await waitUntil(() => record()?.epoch !== undefined);
    expect(record()?.pid).toBe(process.pid);
    await host.stop('done');
    expect(record()).toBeUndefined();
  });

  test('renewal rides the fixed beat while a sweep wait is still pending', async () => {
    bind();
    const clock = { at: NOW };
    const build = hostedWatchAuthority({
      route: route(), teamFile, log: () => {}, now: () => new Date(clock.at), base: quietSources(clock),
    });
    const host = machine(build, clock);
    await waitUntil(() => host.state().cycles === 1);
    expect(record()?.heartbeat).toBe(new Date(NOW).toISOString());
    for (const beat of [1, 2, 3]) {
      clock.at = NOW + beat * HOSTED_AUTHORITY_TICK_MS;
      host.tick(new Date(clock.at));
      expect(record()?.heartbeat).toBe(new Date(clock.at).toISOString());
      // The sweep wait itself has not resolved: renewal is independent of it.
      expect(host.state().cycles).toBe(1);
    }
    await host.stop('done');
    expect(record()).toBeUndefined();
  });

  test('the first pass pushes only through the captured epoch and the shared verifier', async () => {
    bind();
    const clock = { at: NOW };
    const pushes: WorkPushRequest[] = [];
    const checks: WatchAuthorityCheck[] = [];
    let epochSeen = '';
    let verifiedAtPush = false;
    let capturedVerify: (() => boolean) | undefined;
    const build = hostedWatchAuthority({
      route: route(),
      teamFile,
      log: () => {},
      now: () => new Date(clock.at),
      base: idleSources(clock),
      verifyAuthority: (check) => {
        checks.push(check);
        return { ok: true };
      },
      sender: (input) => {
        epochSeen = input.epoch;
        capturedVerify = input.verify;
        return async (request) => {
          verifiedAtPush = input.verify();
          pushes.push(request);
          return { ok: true, outcome: 'typed (unconfirmed)' };
        };
      },
    });
    expect(build.effects).toBe('open');
    const host = machine(build, clock);
    await waitUntil(() => pushes.length === 1);
    expect(epochSeen).toMatch(/^watch_[0-9a-f]{32}$/);
    expect(verifiedAtPush).toBe(true);
    expect(checks[0]).toEqual({ root: route().root, session: 'crew', epoch: epochSeen });
    expect(record()).toMatchObject({ pid: process.pid, epoch: epochSeen });
    expect(capturedVerify?.()).toBe(true);
    await host.stop('done');
    expect(record()).toBeUndefined();
  });

  test('a refused shared verdict closes the push and drains before any effect', async () => {
    bind();
    const clock = { at: NOW };
    const pushes: WorkPushRequest[] = [];
    const logs: string[] = [];
    let checks = 0;
    const build = hostedWatchAuthority({
      route: route(),
      teamFile,
      log: (text) => logs.push(text),
      now: () => new Date(clock.at),
      base: idleSources(clock),
      verifyAuthority: () => {
        checks += 1;
        return { ok: false, why: 'the record is stale' };
      },
      sender: () => async (request) => {
        pushes.push(request);
        return { ok: true, outcome: 'typed (unconfirmed)' };
      },
    });
    const host = machine(build, clock);
    await waitUntil(() => host.state().phase === 'stopped');
    expect(checks).toBeGreaterThan(0);
    expect(pushes.length).toBe(0);
    expect(logs.some((line) => line.includes('shared watch authority verifier refused'))).toBe(true);
    await host.stop('done');
  });

  test('a successor found on a beat drains at once, closes the push and ends the pending wait', async () => {
    bind();
    const clock = { at: NOW };
    const pushes: WorkPushRequest[] = [];
    const logs: string[] = [];
    let capturedVerify: (() => boolean) | undefined;
    const build = hostedWatchAuthority({
      route: route(),
      teamFile,
      log: (text) => logs.push(text),
      now: () => new Date(clock.at),
      base: idleSources(clock),
      verifyAuthority: () => ({ ok: true }),
      sender: (input) => {
        capturedVerify = input.verify;
        return async (request) => {
          input.verify();
          pushes.push(request);
          return { ok: true, outcome: 'typed (unconfirmed)' };
        };
      },
    });
    const host = machine(build, clock);
    await waitUntil(() => pushes.length === 1);
    const successor = mintWatchEpoch();
    const heartbeat = new Date(clock.at).toISOString();
    updateState(agents, (state) => {
      (state.sessions.crew ??= emptySession()).watch = { pid: process.pid, epoch: successor, heartbeat };
    });
    // The sweep waits on the order of minutes; the daemon's next five-second beat must be enough.
    clock.at += HOSTED_AUTHORITY_TICK_MS;
    host.tick(new Date(clock.at));
    await waitUntil(() => host.state().phase === 'stopped');
    expect(logs.some((line) => line.includes("the hosted watch's authority was lost"))).toBe(true);
    expect(pushes.length).toBe(1);
    expect(capturedVerify?.()).toBe(false);
    expect(record()).toEqual({ pid: process.pid, epoch: successor, heartbeat });
    await host.stop('done');
  });

  test('a release left pending is retried on the fixed beat while the daemon lives', async () => {
    bind();
    const clock = { at: NOW };
    const logs: string[] = [];
    const build = hostedWatchAuthority({
      route: route(), teamFile, log: (text) => logs.push(text), now: () => new Date(clock.at), base: quietSources(clock),
    });
    let releaseWait: ((ok: boolean) => void) | undefined;
    const loop = {
      signal: new AbortController().signal,
      wait: () => new Promise<boolean>((resolve) => {
        releaseWait = resolve;
      }),
      cycled: () => {},
      standby: () => {},
    };
    const running = build.run(loop);
    await waitUntil(() => record()?.epoch !== undefined);
    const held = record()?.epoch;
    writeFileSync(join(agents, LOCK_FILE), '1\n');
    await waitUntil(() => releaseWait !== undefined);
    releaseWait?.(false);
    await running;
    expect(logs.some((line) => line.includes('the watch authority release is pending'))).toBe(true);
    expect(record()?.epoch).toBe(held);
    // The run is over but the daemon is not closing: the next beat retries the same epoch only.
    rmSync(join(agents, LOCK_FILE));
    clock.at += HOSTED_AUTHORITY_TICK_MS;
    build.tick?.(new Date(clock.at));
    expect(record()).toBeUndefined();
  });
});
