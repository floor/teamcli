import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import { routeOf } from '../src/daemon/routes.ts';
import { createHostedWatch } from '../src/daemon/watch.ts';
import { HOSTED_AUTHORITY_TICK_MS, hostedWatchAuthority, type WatchAuthorityCheck, type WatchSenderFactory } from '../src/daemon/watch-authority.ts';
import { emptySession, LOCK_FILE, readState, STATE_FILE, updateState } from '../src/state.ts';
import { WATCH_DIRECT_WORK, verifyWatchAuthority } from '../src/watch/authority.ts';
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

/** What the build reports right now: the effects value may be a getter (the wrapper's is). */
function effectsOf(build: ReturnType<typeof hostedWatchAuthority>): string {
  return typeof build.effects === 'function' ? build.effects() : build.effects ?? 'blocked';
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
    expect(effectsOf(build)).toBe('blocked');
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
    expect(effectsOf(build)).toBe('blocked');
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
    expect(host.state().effects).toBe('blocked');
    expect(record()).toBeUndefined();
    rmSync(join(agents, LOCK_FILE));
    clock.at = NOW + HOSTED_AUTHORITY_TICK_MS;
    host.tick(new Date(clock.at));
    await waitUntil(() => record()?.epoch !== undefined);
    expect(record()?.pid).toBe(process.pid);
    // No sender factory is injected here, so held authority still emits nothing.
    expect(host.state().effects).toBe('blocked');
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
        return verifyWatchAuthority({ ...check, purpose: WATCH_DIRECT_WORK, now: new Date(clock.at) });
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
    // The build reports blocked before any run; only the run's own sender opens effects.
    expect(effectsOf(build)).toBe('blocked');
    const host = machine(build, clock);
    await waitUntil(() => pushes.length === 1);
    expect(host.state().effects).toBe('open');
    expect(epochSeen).toMatch(/^watch_[0-9a-f]{32}$/);
    expect(verifiedAtPush).toBe(true);
    expect(checks[0]).toEqual({ root: route().root, session: 'crew', epoch: epochSeen });
    expect(record()).toMatchObject({ pid: process.pid, epoch: epochSeen });
    expect(capturedVerify?.()).toBe(true);
    await host.stop('done');
    expect(record()).toBeUndefined();
    // The run has ended: the recorded state closes effects again.
    expect(host.state().effects).toBe('blocked');
  });

  test('a binding repointed before the first pass drains before any authority is taken', async () => {
    bind();
    const clock = { at: NOW };
    const pushes: WorkPushRequest[] = [];
    const logs: string[] = [];
    const build = hostedWatchAuthority({
      route: route(),
      teamFile,
      log: (text) => logs.push(text),
      now: () => new Date(clock.at),
      base: idleSources(clock),
      verifyAuthority: (check) => verifyWatchAuthority({ ...check, purpose: WATCH_DIRECT_WORK, now: new Date(clock.at) }),
      sender: () => async (request) => {
        pushes.push(request);
        return { ok: true, outcome: 'typed (unconfirmed)' };
      },
    });
    // The binding the build validated is changed before the run starts: the build gate cannot
    // see this, so the run's own recheck must, before it acquires and before its first pass.
    const other = join(agents, 'other.yaml');
    writeFileSync(other, CREW);
    updateState(agents, (state) => {
      (state.sessions.crew ??= emptySession()).watchdog = { file: other };
    });
    const host = machine(build, clock);
    await waitUntil(() => host.state().phase === 'stopped');
    expect(pushes.length).toBe(0);
    expect(logs.some((line) => line.includes('the hosted watch cannot continue'))).toBe(true);
    expect(logs.some((line) => line.includes('watchdog file binding changed'))).toBe(true);
    expect(host.state().effects).toBe('blocked');
    // No authority was ever acquired for the repointed route.
    expect(record()).toBeUndefined();
    await host.stop('done');
  });

  test('a factory that builds no sender leaves effects blocked and the read-only loop running', async () => {
    bind();
    writeFileSync(join(agents, 'queue.yaml'), '');
    const clock = { at: NOW };
    const build = hostedWatchAuthority({
      route: route(),
      teamFile,
      log: () => {},
      now: () => new Date(clock.at),
      base: idleSources(clock),
      verifyAuthority: (check) => verifyWatchAuthority({ ...check, purpose: WATCH_DIRECT_WORK, now: new Date(clock.at) }),
      // A broken factory must not open effects: the state stays truthful even off the type.
      sender: (() => undefined) as unknown as WatchSenderFactory,
    });
    expect(effectsOf(build)).toBe('blocked');
    const host = machine(build, clock);
    await waitUntil(() => host.state().cycles === 1);
    expect(host.state().effects).toBe('blocked');
    // The watch still holds its captured authority and keeps cycling read-only.
    expect(record()?.epoch).toBeDefined();
    await host.stop('done');
    expect(host.state().effects).toBe('blocked');
    expect(record()).toBeUndefined();
  });

  test('a verifier refusal at effect time closes the push, drains and releases', async () => {
    bind();
    const clock = { at: NOW };
    const pushes: WorkPushRequest[] = [];
    const logs: string[] = [];
    const build = hostedWatchAuthority({
      route: route(),
      teamFile,
      log: (text) => logs.push(text),
      now: () => new Date(clock.at),
      base: idleSources(clock),
      // The lifecycle stays authoritative; only the shared verifier's judgement is refused.
      verifyAuthority: () => ({ ok: false, why: 'the record does not stand for this host' }),
      sender: () => async (request) => {
        pushes.push(request);
        return { ok: true, outcome: 'typed (unconfirmed)' };
      },
    });
    const host = machine(build, clock);
    await waitUntil(() => host.state().phase === 'stopped');
    expect(pushes.length).toBe(0);
    expect(logs.some((line) => line.includes('shared watch authority verifier refused'))).toBe(true);
    expect(host.state().effects).toBe('blocked');
    // The lifecycle still held this epoch, so the ending run released it cleanly.
    expect(record()).toBeUndefined();
    await host.stop('done');
  });

  test('quiet sweeps continue with no sender or verifier, and renewal rides each beat', async () => {
    bind();
    // A ready seat with an empty queue: the sweep cycles, and nothing asks for a push.
    writeFileSync(join(agents, 'queue.yaml'), '');
    const clock = { at: NOW };
    const logs: string[] = [];
    const build = hostedWatchAuthority({
      route: route(), teamFile, log: (text) => logs.push(text), now: () => new Date(clock.at), base: idleSources(clock),
    });
    expect(effectsOf(build)).toBe('blocked');
    const host = machine(build, clock);
    await waitUntil(() => host.state().cycles === 1);
    // Let the first sweep register its wait under the current clock before the beats move it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The daemon beats every five seconds; each beat renews before the sweep's wait can be due.
    for (let t = HOSTED_AUTHORITY_TICK_MS; t <= 120_000; t += HOSTED_AUTHORITY_TICK_MS) {
      clock.at = NOW + t;
      host.tick(new Date(clock.at));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await waitUntil(() => host.state().cycles === 2);
    expect(record()?.heartbeat).toBe(new Date(clock.at).toISOString());
    expect(host.state()).toMatchObject({ phase: 'running', effects: 'blocked' });
    for (let t = 125_000; t <= 240_000; t += HOSTED_AUTHORITY_TICK_MS) {
      clock.at = NOW + t;
      host.tick(new Date(clock.at));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await waitUntil(() => host.state().cycles === 3);
    expect(record()?.heartbeat).toBe(new Date(clock.at).toISOString());
    expect(logs.some((line) => line.includes('authority was lost'))).toBe(false);
    await host.stop('done');
    expect(record()).toBeUndefined();
  });

  test('a binding cleared while acquire waits ends the run before any authority is taken', async () => {
    bind();
    writeFileSync(join(agents, LOCK_FILE), '1\n');
    const clock = { at: NOW };
    const logs: string[] = [];
    const build = hostedWatchAuthority({
      route: route(), teamFile, log: (text) => logs.push(text), now: () => new Date(clock.at), base: quietSources(clock),
    });
    const host = machine(build, clock);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.state().effects).toBe('blocked');
    expect(record()).toBeUndefined();
    // The route's binding is cleared while the acquire waits on the busy lock. The next fixed
    // beat must end the run, not retry the acquire forever on a stale claim.
    rmSync(join(agents, LOCK_FILE));
    updateState(agents, (state) => {
      delete (state.sessions.crew ??= emptySession()).watchdog;
    });
    clock.at = NOW + HOSTED_AUTHORITY_TICK_MS;
    host.tick(new Date(clock.at));
    await waitUntil(() => host.state().phase === 'stopped');
    expect(logs.some((line) => line.includes('the hosted watch cannot continue'))).toBe(true);
    expect(logs.some((line) => line.includes('records no watchdog file binding'))).toBe(true);
    expect(record()).toBeUndefined();
    expect(host.state().effects).toBe('blocked');
    await host.stop('done');
  });

  const bindingCases: [string, () => void, string][] = [
    ['cleared', () => {
      updateState(agents, (state) => {
        delete (state.sessions.crew ??= emptySession()).watchdog;
      });
    }, 'records no watchdog file binding'],
    ['repointed', () => {
      const other = join(agents, 'other.yaml');
      writeFileSync(other, CREW);
      updateState(agents, (state) => {
        (state.sessions.crew ??= emptySession()).watchdog = { file: other };
      });
    }, "is not this route's team file"],
    ['unreadable', () => {
      writeFileSync(join(agents, STATE_FILE), '{ this is not json');
    }, 'the session state cannot be read'],
  ];

  for (const [name, mutate, needle] of bindingCases) {
    test(`a binding ${name} on a beat drains the quiet watch without a verifier`, async () => {
      bind();
      writeFileSync(join(agents, 'queue.yaml'), '');
      const clock = { at: NOW };
      const logs: string[] = [];
      const build = hostedWatchAuthority({
        route: route(), teamFile, log: (text) => logs.push(text), now: () => new Date(clock.at), base: idleSources(clock),
      });
      const host = machine(build, clock);
      await waitUntil(() => host.state().cycles === 1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      mutate();
      const kept = name === 'unreadable' ? undefined : readState(agents).sessions.crew?.watchdog;
      clock.at += HOSTED_AUTHORITY_TICK_MS;
      host.tick(new Date(clock.at));
      await waitUntil(() => host.state().phase === 'stopped');
      expect(logs.some((line) => line.includes('watchdog file binding changed'))).toBe(true);
      expect(logs.some((line) => line.includes(needle))).toBe(true);
      expect(host.state().effects).toBe('blocked');
      // The binding is never rewritten: the record is exactly what the mutation left.
      if (name !== 'unreadable') expect(readState(agents).sessions.crew?.watchdog).toEqual(kept);
      await host.stop('done');
    });
  }

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
      verifyAuthority: (check) => verifyWatchAuthority({ ...check, purpose: WATCH_DIRECT_WORK, now: new Date(clock.at) }),
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
    expect(host.state().effects).toBe('open');
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
    expect(host.state().effects).toBe('blocked');
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
    await waitUntil(() => record()?.epoch !== undefined && releaseWait !== undefined);
    const held = record()?.epoch;
    writeFileSync(join(agents, LOCK_FILE), '1\n');
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
