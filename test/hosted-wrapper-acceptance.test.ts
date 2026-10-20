// Independent acceptance of the route-bound hosted watch wrapper (`src/daemon/watch-authority.ts`)
// on the actual source: the binding, the fixed five-second renewal that rides the daemon's own
// beat, the per-effect gate and its truthful report, successor loss, the cleanup retry, and the
// binding while a quiet watch runs. Everything below drives the
// product surface — `hostedWatchAuthority`, `createHostedWatch` composed exactly as
// `startMachineDaemon` composes it, and `startMachineDaemon` itself once — with synthetic homes,
// a virtual clock and a scratch checkout. Nothing reads or writes a real pane, home or session.
//
// The scenes first measured red on 7cb78f1a6 stated the behaviour the wrapper owes. The corrected
// source 34437b0b9 delivers every unchanged body, so the whole file now runs as ordinary tests.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { daemonLogPath } from '../src/daemon/paths.ts';
import { routeOf, type HostedRoute } from '../src/daemon/routes.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import { createHostedWatch } from '../src/daemon/watch.ts';
import {
  HOSTED_AUTHORITY_TICK_MS,
  hostedWatchAuthority,
  type HostedWatchAuthorityInput,
} from '../src/daemon/watch-authority.ts';
import { emptySession, LOCK_FILE, readState, updateState } from '../src/state.ts';
import { forgetIdleEpisodes, type WorkPushRequest } from '../src/watch/dispatch.ts';
import { mintWatchEpoch } from '../src/watch/epoch.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-20T06:00:00Z');
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

function iso(at: number): string {
  return new Date(at).toISOString();
}

function idleLive(): Live {
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
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-hosted-wrapper-')));
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
    session.seats['worker-1'] = { stage: 'ready', last_active: iso(NOW - 10 * MIN) };
  });
});

afterEach(() => {
  forgetIdleEpisodes();
  rmSync(base, { recursive: true, force: true });
});

function route(): HostedRoute {
  return routeOf(root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
}

/** The watchdog binding `up` writes: exactly the route's own team file. */
function bind(): void {
  updateState(agents, (state) => {
    (state.sessions.crew ??= emptySession()).watchdog = { file: teamFile };
  });
}

function record(): { pid?: number; heartbeat?: string; epoch?: string; pane?: string } | undefined {
  return readState(agents).sessions.crew?.watch;
}

/** The daemon's own composition: the build's run under a host whose tick rides every beat. */
function composed(
  build: ReturnType<typeof hostedWatchAuthority>, clock: { at: number },
) {
  return createHostedWatch({
    route: route(),
    now: () => new Date(clock.at),
    ...build,
    onTick: build.tick,
  });
}

/** A quiet session: herdr answers, naming no agent and no pane. */
function quietSources(clock: { at: number }): WatchSources {
  return {
    live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
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

/** One idle seat the loop may dispatch queued work to. */
function workingSources(clock: { at: number }): WatchSources {
  return { ...quietSources(clock), live: () => idleLive() };
}

function buildWith(
  clock: { at: number },
  base: WatchSources,
  extra: Partial<HostedWatchAuthorityInput> = {},
): ReturnType<typeof hostedWatchAuthority> {
  return hostedWatchAuthority({
    route: route(),
    teamFile,
    log: () => {},
    now: () => new Date(clock.at),
    base,
    ...extra,
  });
}

async function waitUntil(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the hosted watch');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the fixed daemon beat', () => {
  test('renews the held authority through a pending sweep and starts no pass early', async () => {
    bind();
    const clock = { at: NOW };
    expect(HOSTED_AUTHORITY_TICK_MS).toBe(5_000);
    const host = composed(buildWith(clock, quietSources(clock)), clock);
    await waitUntil(() => host.state().cycles === 1);
    expect(record()).toMatchObject({ pid: process.pid, heartbeat: iso(NOW) });
    // Beats on the daemon's own five-second cadence while the 120-second sweep wait is still
    // pending: every beat renews the captured record, and no beat starts a pass of its own.
    for (let beat = 1; beat <= 23; beat++) {
      clock.at = NOW + beat * HOSTED_AUTHORITY_TICK_MS;
      host.tick(new Date(clock.at));
      expect(record()?.heartbeat).toBe(iso(clock.at));
      expect(host.state()).toMatchObject({ phase: 'running', cycles: 1, failures: 0 });
    }
    // One second short of the sweep's own due instant: still no second pass.
    clock.at = NOW + 119_000;
    host.tick(new Date(clock.at));
    expect(host.state().cycles).toBe(1);
    expect(record()?.heartbeat).toBe(iso(clock.at));
    await host.stop('done');
    expect(record()).toBeUndefined();
  });
});

describe('a blocked quiet watch', () => {
  test('reads a second time after the sweep instead of draining', async () => {
    bind();
    const clock = { at: NOW };
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'service-manager',
      version: '0.5.3-hosted-wrapper-acceptance',
      heartbeatMs: 25,
      watchHosting: true,
      now: () => new Date(clock.at),
      hostedWatch: (hostedRoute, log) => hostedWatchAuthority({
        route: hostedRoute,
        teamFile,
        log,
        now: () => new Date(clock.at),
        base: quietSources(clock),
      }),
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const watch = () => started.daemon.roots[0]?.watch;
      await waitUntil(() => watch()?.cycles === 1);
      const held = record()?.epoch;
      expect(held).toBeString();
      expect(watch()).toMatchObject({ phase: 'running', cycles: 1, effects: 'blocked' });
      // The daemon's own beat renews the held record on its real cadence until the sweep is due.
      for (let beat = 1; beat <= 23; beat++) {
        clock.at = NOW + beat * HOSTED_AUTHORITY_TICK_MS;
        await waitUntil(() => record()?.heartbeat === iso(clock.at));
      }
      expect(watch()?.cycles).toBe(1);
      // The first sweep completes: the watch must read again under the same authority. Draining
      // here would stop a quiet watch that has nothing wrong with its record.
      clock.at = NOW + 120_000;
      await waitUntil(() => (watch()?.cycles ?? 0) >= 2 || watch()?.phase === 'stopped');
      expect(watch()?.cycles).toBe(2);
      expect(watch()?.phase).toBe('running');
      expect(record()?.epoch).toBe(held);
      expect(record()?.heartbeat).toBe(iso(clock.at));
      const logText = existsSync(daemonLogPath(home)) ? readFileSync(daemonLogPath(home), 'utf8') : '';
      expect(logText).not.toContain('no shared watch authority verifier is wired');
    } finally {
      await started.daemon.close();
    }
  });
});

describe('the reported effects', () => {
  test('are never open when the sender factory builds no sender', async () => {
    bind();
    const clock = { at: NOW };
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'service-manager',
      version: '0.5.3-hosted-wrapper-acceptance',
      heartbeatMs: 25,
      watchHosting: true,
      now: () => new Date(clock.at),
      hostedWatch: (hostedRoute, log) => hostedWatchAuthority({
        route: hostedRoute,
        teamFile,
        log,
        now: () => new Date(clock.at),
        base: quietSources(clock),
        // Narrow cast: the declared factory returns a WorkPush, so a runtime undefined result
        // can only be exercised off the type. The blocked fallback is the thing under test.
        sender: (() => undefined) as unknown as HostedWatchAuthorityInput['sender'],
        verifyAuthority: () => ({ ok: true }),
      }),
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      // The factory is called before the first pass and answered with no sender, so no effect can
      // ever leave this host. Wait for that first pass, then for the next beat's state write.
      await waitUntil(() => started.daemon.roots[0]?.watch?.cycles === 1);
      clock.at = NOW + HOSTED_AUTHORITY_TICK_MS;
      await waitUntil(() => {
        const read = readDaemonState(home);
        return read.kind === 'ok' && read.state.heartbeatAt === iso(clock.at);
      });
      const read = readDaemonState(home);
      expect(read.kind).toBe('ok');
      if (read.kind !== 'ok') return;
      // A reader of the daemon's record must see the closed push, not the injected factory.
      expect(read.state.roots[0]?.watch?.effects).toBe('blocked');
    } finally {
      await started.daemon.close();
    }
  });
});

describe('the honest effect report', () => {
  test('reads blocked while a standing watch holds the session', async () => {
    bind();
    const clock = { at: NOW };
    const heartbeat = iso(NOW);
    updateState(agents, (state) => {
      (state.sessions.crew ??= emptySession()).watch = { pane: 'w1:p1', heartbeat };
    });
    const build = buildWith(clock, quietSources(clock), {
      verifyAuthority: () => ({ ok: true }),
      sender: () => async () => ({ ok: true, outcome: 'typed (unconfirmed)' }),
    });
    const host = composed(build, clock);
    await waitUntil(() => host.state().phase === 'standby');
    // Another watch holds the session: this host cannot push, whatever was injected.
    expect(host.state().effects).toBe('blocked');
    expect(host.state().why).toContain('stands for the session');
    expect(record()).toEqual({ pane: 'w1:p1', heartbeat });
    await host.stop('done');
  });

  test('reads blocked when the acquisition is refused', async () => {
    bind();
    const clock = { at: NOW };
    const build = hostedWatchAuthority({
      route: route(),
      teamFile,
      log: () => {},
      now: () => {
        throw new Error('clock unavailable');
      },
      base: quietSources(clock),
      verifyAuthority: () => ({ ok: true }),
      sender: () => async () => ({ ok: true, outcome: 'typed (unconfirmed)' }),
    });
    const host = createHostedWatch({
      route: route(),
      now: () => new Date(clock.at),
      ...build,
      onTick: build.tick,
    });
    await waitUntil(() => host.state().phase === 'standby');
    expect(host.state().why).toContain('refused');
    expect(host.state().effects).toBe('blocked');
    expect(record()).toBeUndefined();
    await host.stop('done');
  });

  test('reads blocked once the captured authority is lost', async () => {
    bind();
    const clock = { at: NOW };
    const build = buildWith(clock, quietSources(clock), {
      verifyAuthority: () => ({ ok: true }),
      sender: () => async () => ({ ok: true, outcome: 'typed (unconfirmed)' }),
    });
    const host = composed(build, clock);
    await waitUntil(() => host.state().cycles === 1);
    expect(host.state().effects).toBe('open');
    const successor = mintWatchEpoch();
    const heartbeat = iso(clock.at);
    updateState(agents, (state) => {
      (state.sessions.crew ??= emptySession()).watch = { pid: process.pid, epoch: successor, heartbeat };
    });
    clock.at += HOSTED_AUTHORITY_TICK_MS;
    host.tick(new Date(clock.at));
    await waitUntil(() => host.state().phase === 'stopped');
    // The record is another epoch's: the report may not still claim a live push.
    expect(host.state().effects).toBe('blocked');
    expect(record()).toEqual({ pid: process.pid, epoch: successor, heartbeat });
    await host.stop('done');
  });

  test('reads blocked after the run has finished', async () => {
    bind();
    const clock = { at: NOW };
    const build = buildWith(clock, quietSources(clock), {
      verifyAuthority: () => ({ ok: true }),
      sender: () => async () => ({ ok: true, outcome: 'typed (unconfirmed)' }),
    });
    const host = composed(build, clock);
    await waitUntil(() => host.state().cycles === 1);
    expect(host.state().effects).toBe('open');
    await host.stop('done');
    expect(record()).toBeUndefined();
    expect(host.state().effects).toBe('blocked');
  });
});

describe('the binding while a quiet watch runs', () => {
  /** Runs a quiet watch to its first cycle, changes the recorded binding, and expects one beat
   *  to stand the authority down: no further pass, effects closed, the record released. */
  async function standDownAfter(
    change: (session: ReturnType<typeof emptySession>) => void,
  ): Promise<void> {
    bind();
    const clock = { at: NOW };
    const build = buildWith(clock, quietSources(clock), {
      verifyAuthority: () => ({ ok: true }),
      sender: () => async () => ({ ok: true, outcome: 'typed (unconfirmed)' }),
    });
    const host = composed(build, clock);
    await waitUntil(() => host.state().cycles === 1);
    expect(host.state().effects).toBe('open');
    updateState(agents, (state) => {
      change(state.sessions.crew ??= emptySession());
    });
    clock.at += HOSTED_AUTHORITY_TICK_MS;
    host.tick(new Date(clock.at));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The binding is re-read every beat: a quiet watch may not keep carrying the authority
    // under a watchdog record that was moved out from under it.
    expect(host.state().phase).not.toBe('running');
    expect(host.state().effects).toBe('blocked');
    expect(host.state().cycles).toBe(1);
    expect(record()).toBeUndefined();
    await host.stop('done');
  }

  test('a repointed watchdog file stands the authority down', async () => {
    await standDownAfter((session) => {
      session.watchdog = { file: join(agents, 'other.yaml') };
    });
  });

  test('a cleared watchdog binding stands the authority down', async () => {
    await standDownAfter((session) => {
      delete session.watchdog;
    });
  });
});

describe('a pass in flight', () => {
  test('keeps renewing on every beat and pushes once when it finishes', async () => {
    bind();
    const clock = { at: NOW };
    const pushes: WorkPushRequest[] = [];
    let entered!: () => void;
    const enteredPush = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let releasePush!: () => void;
    const pushGate = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    const build = buildWith(clock, workingSources(clock), {
      verifyAuthority: () => ({ ok: true }),
      sender: () => async (request) => {
        entered();
        pushes.push(request);
        await pushGate;
        return { ok: true, outcome: 'typed (unconfirmed)' };
      },
    });
    const host = composed(build, clock);
    await enteredPush;
    // A factory that does build a sender is the positive control for the effect report.
    expect(host.state().effects).toBe('open');
    // The pass is still inside its push; two beats renew the record and start no pass.
    for (const beat of [1, 2]) {
      clock.at = NOW + beat * HOSTED_AUTHORITY_TICK_MS;
      host.tick(new Date(clock.at));
      expect(record()?.heartbeat).toBe(iso(clock.at));
      expect(host.state().cycles).toBe(0);
      expect(host.state().failures).toBe(0);
    }
    releasePush();
    await waitUntil(() => host.state().cycles === 1);
    expect(host.state()).toMatchObject({ phase: 'running', cycles: 1, lastCycleOutcome: 'pass' });
    expect(pushes.length).toBe(1);
    expect(pushes[0]).toMatchObject({ seat: 'worker-1', pane: 'w1:p1' });
    await host.stop('done');
    expect(record()).toBeUndefined();
  });
});

describe('a successor on a beat', () => {
  test('gives no next pass and no next push, and its record is left exact', async () => {
    bind();
    const clock = { at: NOW };
    const pushes: WorkPushRequest[] = [];
    let verifyAfter: (() => boolean) | undefined;
    const logs: string[] = [];
    const build = hostedWatchAuthority({
      route: route(),
      teamFile,
      log: (text) => logs.push(text),
      now: () => new Date(clock.at),
      base: workingSources(clock),
      verifyAuthority: () => ({ ok: true }),
      sender: (input) => {
        verifyAfter = input.verify;
        return async (request) => {
          pushes.push(request);
          return { ok: true, outcome: 'typed (unconfirmed)' };
        };
      },
    });
    const host = composed(build, clock);
    await waitUntil(() => host.state().cycles === 1);
    expect(pushes.length).toBe(1);
    const successor = mintWatchEpoch();
    const heartbeat = iso(clock.at);
    updateState(agents, (state) => {
      (state.sessions.crew ??= emptySession()).watch = { pid: process.pid, epoch: successor, heartbeat };
    });
    // The sweep waits minutes; one ordinary beat must be enough to close the push and end the run.
    clock.at += HOSTED_AUTHORITY_TICK_MS;
    host.tick(new Date(clock.at));
    await waitUntil(() => host.state().phase === 'stopped');
    expect(pushes.length).toBe(1);
    expect(host.state().cycles).toBe(1);
    expect(verifyAfter?.()).toBe(false);
    expect(record()).toEqual({ pid: process.pid, epoch: successor, heartbeat });
    expect(logs.some((line) => line.includes("the hosted watch's authority was lost"))).toBe(true);
    // A whole sweep later, the ended run still starts no pass and pushes nothing.
    clock.at += 120_000;
    host.tick(new Date(clock.at));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.state().cycles).toBe(1);
    expect(pushes.length).toBe(1);
    expect(record()).toEqual({ pid: process.pid, epoch: successor, heartbeat });
    // Stopping the host never clears a record this run does not own.
    await host.stop('done');
    expect(record()).toEqual({ pid: process.pid, epoch: successor, heartbeat });
  });
});

describe('a release left pending', () => {
  test('is retried on the same epoch and never clears a successor', async () => {
    bind();
    const clock = { at: NOW };
    const logs: string[] = [];
    const build = hostedWatchAuthority({
      route: route(),
      teamFile,
      log: (text) => logs.push(text),
      now: () => new Date(clock.at),
      base: quietSources(clock),
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
    const held = record()?.epoch as string;
    await waitUntil(() => releaseWait !== undefined);
    // The run ends while the state lock is held: the release is busy, not silent.
    writeFileSync(join(agents, LOCK_FILE), `${String(process.pid)}\n`);
    releaseWait?.(false);
    await running;
    expect(logs.some((line) => line.includes('the watch authority release is pending'))).toBe(true);
    expect(record()?.epoch).toBe(held);
    // A beat while the lock is still held retries only that release: no acquire, no renew.
    clock.at += HOSTED_AUTHORITY_TICK_MS;
    build.tick?.(new Date(clock.at));
    expect(record()?.epoch).toBe(held);
    // The successor appears while cleanup is pending; a retried release leaves it exact.
    rmSync(join(agents, LOCK_FILE));
    const successor = mintWatchEpoch();
    const heartbeat = iso(clock.at);
    updateState(agents, (state) => {
      (state.sessions.crew ??= emptySession()).watch = { pid: process.pid, epoch: successor, heartbeat };
    });
    writeFileSync(join(agents, LOCK_FILE), `${String(process.pid)}\n`);
    clock.at += HOSTED_AUTHORITY_TICK_MS;
    build.tick?.(new Date(clock.at));
    expect(record()).toEqual({ pid: process.pid, epoch: successor, heartbeat });
    // Freed at last, the release finds the record is another epoch's and leaves its bytes alone.
    rmSync(join(agents, LOCK_FILE));
    clock.at += HOSTED_AUTHORITY_TICK_MS;
    build.tick?.(new Date(clock.at));
    expect(record()).toEqual({ pid: process.pid, epoch: successor, heartbeat });
    clock.at += HOSTED_AUTHORITY_TICK_MS;
    build.tick?.(new Date(clock.at));
    expect(record()).toEqual({ pid: process.pid, epoch: successor, heartbeat });
  });
});
