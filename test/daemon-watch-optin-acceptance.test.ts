// Independent acceptance for the machine daemon's watch opt-in: the command flag, the unit it
// writes, and the host it starts. The command-level scenes use the real parse/refusal/admission
// path with an injected start so the flags can be read; the host-level scenes start the real
// machine host (real lock, socket and state record) with a synthetic hosted watch, so no pane,
// credential or live service is touched. Effects stay blocked unless a scene explicitly injects
// open ones to watch a drain, and the broker feature is asserted off at both its policy and its
// serving record.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import { startMachineDaemon, type StartMachineDaemonInput } from '../src/daemon/host.ts';
import { darwinServiceManager } from '../src/daemon/service-darwin.ts';
import type { ServiceManager, ServiceProgram } from '../src/daemon/service.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import type { HostedWatchBuild } from '../src/daemon/host.ts';
import type { HostedLoop } from '../src/watch/hosted.ts';
import type { HostedRoute } from '../src/daemon/routes.ts';
import type { PresenceIngester } from '../src/daemon/presence/ingest.ts';
import { POLICY_CATALOGUE } from '../src/policy/types.ts';
import { resolvePolicy } from '../src/policy/resolve.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
coordinator: clerk
operator: op-1
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: clerk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
  - role: worker
    name: op-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`;

const owner = { kind: 'owner' } as const;

type World = { base: string; root: string; home: string; other: string };

const worlds: World[] = [];
const running: Array<{ close: () => Promise<void> }> = [];

function scratch(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'b7watch-')));
  const root = join(base, 'repo');
  const other = join(base, 'other');
  const home = join(base, 'home');
  for (const repo of [root, other]) {
    mkdirSync(join(repo, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, '.agents', 'team.yaml'), TEAM);
  }
  mkdirSync(home, { recursive: true });
  const world = { base, root, home, other };
  worlds.push(world);
  return world;
}

afterEach(async () => {
  for (const one of running.splice(0)) {
    try {
      await one.close();
    } catch {
      // A scene that already closed its daemon leaves nothing to close.
    }
  }
  for (const world of worlds.splice(0)) rmSync(world.base, { recursive: true, force: true });
});

function sourcesOf(home: string, overrides: Partial<DaemonCommandSources> = {}): DaemonCommandSources {
  return {
    home,
    program: { execPath: '/runtime/bin/node', entry: '/app/dist/cli.js' },
    version: 'test',
    ...overrides,
  };
}

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the daemon');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fakeService(): ServiceManager & { calls: string[]; programs: ServiceProgram[] } {
  const calls: string[] = [];
  const programs: ServiceProgram[] = [];
  return {
    kind: 'system-service-manager',
    calls,
    programs,
    unitPath: (home) => join(home, 'unit.plist'),
    plan: (_home, program) => {
      programs.push(program);
      return { unitPath: join(_home, 'unit.plist'), program: [program.execPath, program.entry, 'daemon', 'run'] };
    },
    install: (_home, program) => {
      calls.push('install');
      programs.push(program);
      return { ok: true, unitPath: join(_home, 'unit.plist') };
    },
    uninstall: (home) => {
      calls.push('uninstall');
      return { ok: true, unitPath: join(home, 'unit.plist'), removed: true };
    },
  };
}

/** A synthetic pass that cycles once per heartbeat and never emits anything. */
function cyclingBuild(): HostedWatchBuild {
  return {
    run: async (loop: HostedLoop) => {
      for (;;) {
        loop.cycled(new Date());
        if (!(await loop.wait(0))) return 0;
      }
    },
  };
}

type RunThroughHost = {
  inputs: StartMachineDaemonInput[];
  routes: HostedRoute[];
  serving: () => Extract<Awaited<ReturnType<typeof startMachineDaemon>>, { kind: 'serving' }> | null;
  /** Ends the command's own run wait, which closes the daemon before the command returns. */
  finish: () => Promise<number>;
};

/**
 * Runs the command's own `run` path and hands the real host the exact input the command built,
 * adding only the test's synthetic watch and heartbeat. Every flag the command forwards is read
 * off that input, before the host turns it into routes. The command's stop seam is held open so
 * the scene chooses when the daemon closes; finish releases it and waits for the close.
 */
async function runThroughHost(
  world: World,
  argv: string[],
  caller: Parameters<typeof testIo>[1],
  build: (route: HostedRoute, log: (text: string) => void) => HostedWatchBuild,
): Promise<RunThroughHost> {
  const inputs: StartMachineDaemonInput[] = [];
  const routes: HostedRoute[] = [];
  let serving: Extract<Awaited<ReturnType<typeof startMachineDaemon>>, { kind: 'serving' }> | null = null;
  let release: (() => void) | null = null;
  let finished = false;
  const start = async (input: StartMachineDaemonInput) => {
    inputs.push(input);
    const result = await startMachineDaemon({
      ...input,
      heartbeatMs: 15,
      hostedWatch: (route, log) => {
        routes.push(route);
        return build(route, log);
      },
    });
    if (result.kind === 'serving') {
      serving = result;
      running.push({ close: () => result.daemon.close() });
    }
    return result;
  };
  const stop = (end: () => void) => {
    release = end;
    return () => {};
  };
  const io = testIo(world.root, caller);
  const done = runDaemon(argv, io, sourcesOf(world.home, { start, stop }));
  void done.then(() => {
    finished = true;
  });
  await waitUntil(() => release !== null || finished);
  return {
    inputs,
    routes,
    serving: () => serving,
    finish: async () => {
      release?.();
      return done;
    },
  };
}

describe('the run flag reaches the real host, and only when asked', () => {
  test('run --watch starts the host with watch hosting; a plain run leaves it off', async () => {
    const world = scratch();
    const plain = await runThroughHost(world, ['run'], owner, cyclingBuild);
    expect(plain.inputs[0]?.watchHosting).toBeUndefined();
    expect(plain.routes.length).toBe(0);
    const plainServing = plain.serving();
    expect(plainServing).not.toBeNull();
    if (plainServing === null) return;
    expect(plainServing.daemon.roots[0]?.watch).toBeUndefined();
    const plainState = readDaemonState(world.home);
    expect(plainState.kind).toBe('ok');
    if (plainState.kind === 'ok') {
      expect(plainState.state.roots[0]?.watch).toBeUndefined();
      expect(plainState.state.features).toEqual({ broker: 'absent' });
    }
    expect(await plain.finish()).toBe(0);

    const watchedWorld = scratch();
    const watched = await runThroughHost(watchedWorld, ['run', '--watch'], owner, cyclingBuild);
    expect(watched.inputs[0]?.watchHosting).toBe(true);
    expect(watched.inputs[0]?.presenceHosting).toBeUndefined();
    expect(watched.routes.map((route) => route.root)).toEqual([watchedWorld.root]);
    const serving = watched.serving();
    expect(serving).not.toBeNull();
    if (serving === null) return;
    await waitUntil(() => (serving.daemon.roots[0]?.watch?.cycles ?? 0) >= 2);
    expect(serving.daemon.roots[0]?.watch).toMatchObject({
      // The host's own default: outbound effects stay blocked without a verified sender.
      effects: 'blocked',
      phase: 'running',
      required: true,
      failures: 0,
    });
    const state = readDaemonState(watchedWorld.home);
    expect(state.kind).toBe('ok');
    if (state.kind === 'ok') {
      expect(state.state.roots[0]?.watch?.cycles).toBeGreaterThanOrEqual(2);
      expect(state.state.features).toEqual({ broker: 'absent' });
    }
    expect(await watched.finish()).toBe(0);
    // The closing beat stopped the watch with the daemon's own reason before ownership moved.
    expect(serving.daemon.roots[0]?.watch).toMatchObject({ phase: 'stopped', why: 'the daemon is closing' });
  });

  test('run --watch --presence forwards both flags; neither run implies the other', async () => {
    const world = scratch();
    const seen: StartMachineDaemonInput[] = [];
    const start = async (input: StartMachineDaemonInput) => {
      seen.push(input);
      return { kind: 'already-running' as const, pid: 7 };
    };
    for (const argv of [['run'], ['run', '--presence'], ['run', '--watch'], ['run', '--presence', '--watch']]) {
      const io = testIo(world.root, owner);
      expect(await runDaemon(argv, io, sourcesOf(world.home, { start }))).toBe(0);
    }
    expect(seen.map((input) => input.watchHosting)).toEqual([undefined, undefined, true, true]);
    expect(seen.map((input) => input.presenceHosting)).toEqual([undefined, true, undefined, true]);
  });

  test('presence-only and watch-plus-presence hosts are independent at the host itself', async () => {
    const world = scratch();
    const ingester = (): PresenceIngester => ({
      step: async () => ({
        ingested: [], rejected: [], stale: [], repaired: [], errors: [], healthy: false, pending: false, closed: false,
      }),
      close: async () => ({ quiesced: true }),
      isClosed: () => false,
    });
    const presence = {
      presenceIngest: () => ingester(),
      presenceActivity: () => async () => ({ seats: [], failed: null }),
      presencePublish: () => async () => ({ seats: [], failed: null }),
    };
    const built: HostedRoute[] = [];
    const presenceOnly = await startMachineDaemon({
      home: world.home,
      roots: [world.root],
      startedBy: 'manual',
      version: 'test',
      heartbeatMs: 15,
      presenceHosting: true,
      presenceEveryMs: 50,
      ...presence,
      hostedWatch: (route) => {
        built.push(route);
        return cyclingBuild();
      },
    });
    expect(presenceOnly.kind).toBe('serving');
    if (presenceOnly.kind !== 'serving') return;
    running.push({ close: () => presenceOnly.daemon.close() });
    await waitUntil(() => presenceOnly.daemon.health().roots?.[0]?.presence !== undefined);
    // Presence hosting alone builds no watch and starts none.
    expect(built.length).toBe(0);
    expect(presenceOnly.daemon.roots[0]?.watch).toBeUndefined();
    await presenceOnly.daemon.close();

    const bothWorld = scratch();
    const bothBuilt: HostedRoute[] = [];
    const both = await startMachineDaemon({
      home: bothWorld.home,
      roots: [bothWorld.root],
      startedBy: 'manual',
      version: 'test',
      heartbeatMs: 15,
      presenceHosting: true,
      presenceEveryMs: 50,
      ...presence,
      watchHosting: true,
      hostedWatch: (route) => {
        bothBuilt.push(route);
        return cyclingBuild();
      },
    });
    expect(both.kind).toBe('serving');
    if (both.kind !== 'serving') return;
    running.push({ close: () => both.daemon.close() });
    await waitUntil(() =>
      (both.daemon.roots[0]?.watch?.cycles ?? 0) >= 1
      && both.daemon.health().roots?.[0]?.presence !== undefined);
    // Both pipelines stand on their own route: the watch exists while presence keeps its answer.
    expect(bothBuilt.length).toBe(1);
    expect(both.daemon.roots[0]?.watch?.phase).toBe('running');
    expect(both.daemon.health().roots?.[0]?.presence).toBeDefined();
    await both.daemon.close();
  });
});

describe('synthetic effects and the closing drain', () => {
  test('a watch pass drains when the daemon closes, and the record states the reason', async () => {
    const world = scratch();
    const events: string[] = [];
    const drain: HostedWatchBuild = {
      effects: 'open',
      run: async (loop) => {
        events.push('run-start');
        await new Promise<void>((resolve) => {
          loop.signal.addEventListener('abort', () => {
            // The drain outlives the close call by design: close must wait for it.
            setTimeout(() => {
              events.push('drained');
              resolve();
            }, 25);
          }, { once: true });
        });
        return 0;
      },
    };
    const started = await runThroughHost(world, ['run', '--watch'], owner, () => drain);
    const serving = started.serving();
    expect(serving).not.toBeNull();
    if (serving === null) return;
    await waitUntil(() => events.includes('run-start'));
    expect(serving.daemon.roots[0]?.watch?.effects).toBe('open');
    const began = Date.now();
    // finish releases the command's stop wait; the command's own close must then wait the drain.
    expect(await started.finish()).toBe(0);
    expect(Date.now() - began).toBeGreaterThanOrEqual(20);
    // The close waited for the pass's own cleanup; the watch then read stopped with its reason.
    expect(events).toEqual(['run-start', 'drained']);
    expect(serving.daemon.roots[0]?.watch).toMatchObject({ phase: 'stopped', why: 'the daemon is closing' });
  });

  test('a tick returning false closes effects and settles the outstanding wait false', async () => {
    const world = scratch();
    let ended = '';
    let ticks = 0;
    const closingEffect: HostedWatchBuild = {
      run: async (loop) => {
        for (;;) {
          loop.cycled(new Date());
          const ok = await loop.wait(0);
          if (!ok) {
            ended = 'settled-false';
            return 0;
          }
        }
      },
      tick: () => {
        ticks += 1;
        return ticks < 2;
      },
    };
    const started = await startMachineDaemon({
      home: world.home,
      roots: [world.root],
      startedBy: 'manual',
      version: 'test',
      heartbeatMs: 15,
      watchHosting: true,
      hostedWatch: () => closingEffect,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    running.push({ close: () => started.daemon.close() });
    await waitUntil(() => ended !== '');
    expect(ended).toBe('settled-false');
    // The loop's settle and the record are two steps: the beat that settles the wait writes the
    // root before the run's continuation reaches `stopped`, so the next beat is what records it.
    // Wait for the record's own terminal phase instead of sampling between the two beats.
    await waitUntil(() => started.daemon.roots[0]?.watch?.phase === 'stopped');
    // The synthetic pulse is the route's own clock and it is the only thing that ended the pass.
    expect(started.daemon.roots[0]?.watch).toMatchObject({ phase: 'stopped', why: 'the watch loop ended' });
    await started.daemon.close();
  });
});

describe('the install contract writes only the opt-in that was asked for', () => {
  test('plain, presence, watch and both reach the service manager distinctly', async () => {
    const world = scratch();
    const installed: ServiceProgram[] = [];
    const service = { ...fakeService(), install: (home: string, program: ServiceProgram) => {
      installed.push(program);
      return { ok: true, unitPath: join(home, 'unit.plist') } as const;
    } };
    for (const argv of [['install'], ['install', '--presence'], ['install', '--watch'], ['install', '--presence', '--watch']]) {
      const io = testIo(world.root, owner);
      expect(await runDaemon(argv, io, sourcesOf(world.home, { service }))).toBe(0);
    }
    const [plain, presenceOnly, watchOnly, both] = installed;
    expect(plain).toMatchObject({ roots: [world.root] });
    expect(plain?.presence).toBeUndefined();
    expect(plain?.watch).toBeUndefined();
    expect(presenceOnly).toMatchObject({ roots: [world.root], presence: true });
    expect(presenceOnly?.watch).toBeUndefined();
    expect(watchOnly).toMatchObject({ roots: [world.root], watch: true });
    expect(watchOnly?.presence).toBeUndefined();
    expect(both).toMatchObject({ roots: [world.root], presence: true, watch: true });
  });

  test('install --watch --dry-run writes nothing and names the opt-in in its plan', async () => {
    const world = scratch();
    const service = fakeService();
    const text = testIo(world.root, owner);
    expect(await runDaemon(['install', '--watch', '--dry-run'], text, sourcesOf(world.home, { service }))).toBe(0);
    expect(service.calls).toEqual([]);
    expect(service.programs.at(-1)).toMatchObject({ roots: [world.root], watch: true });
    expect(text.out).toContain('would install');
    expect(text.out).not.toContain('launchd');

    const json = testIo(world.root, owner);
    expect(await runDaemon(['install', '--presence', '--watch', '--dry-run', '--json'], json, sourcesOf(world.home, { service }))).toBe(0);
    expect(service.calls).toEqual([]);
    const document = JSON.parse(json.out) as Record<string, unknown>;
    expect(document).toMatchObject({
      format: 1,
      command: 'install',
      dry_run: true,
      installed: false,
      roots: [world.root],
      // The neutral plan is the run command the unit would carry; the watch flag rides the
      // program the adapter was asked to write, not a platform word this command prints.
      program: ['/runtime/bin/node', '/app/dist/cli.js', 'daemon', 'run'],
    });
    expect(document.schema).toMatchObject({ name: 'team.daemon-install', version: 1 });
    expect(service.programs.at(-1)).toMatchObject({ roots: [world.root], presence: true, watch: true });
  });

  test('the written unit carries --watch exactly once and presence only when asked', async () => {
    const world = scratch();
    const manager = darwinServiceManager({ runner: () => ({ status: 0, stdout: '', stderr: '' }), uid: 501 });
    const install = async (argv: string[]) => {
      const io = testIo(world.root, owner);
      expect(await runDaemon(argv, io, sourcesOf(world.home, { service: manager }))).toBe(0);
      return { path: manager.unitPath(world.home), unit: readFileSync(manager.unitPath(world.home), 'utf8') };
    };
    const plain = await install(['install']);
    expect(plain.unit).not.toContain('--watch');
    expect(plain.unit).not.toContain('--presence');
    const presenceOnly = await install(['install', '--presence']);
    expect(presenceOnly.unit).toContain('--presence');
    expect(presenceOnly.unit).not.toContain('--watch');
    const watchOnly = await install(['install', '--watch']);
    expect(watchOnly.unit).not.toContain('--presence');
    expect(watchOnly.unit.split('--watch').length - 1).toBe(1);
    const both = await install(['install', '--presence', '--watch']);
    expect(both.unit.split('--presence').length - 1).toBe(1);
    expect(both.unit.split('--watch').length - 1).toBe(1);
    expect(both.unit.indexOf('--presence')).toBeLessThan(both.unit.indexOf('--watch'));
    // The unit still starts the one admitted no-terminal run, with the same roots.
    expect(both.unit).toContain('<string>daemon</string>');
    expect(both.unit).toContain('<string>--started-by</string>');
    expect(both.unit).toContain('<string>service-manager</string>');
    expect(both.unit).toContain(`<string>${world.root}</string>`);
  });

  test('--watch is refused on status and uninstall with the same usage message', async () => {
    const world = scratch();
    for (const argv of [['status', '--watch'], ['uninstall', '--watch']]) {
      const io = testIo(world.root, owner);
      expect(await runDaemon(argv, io, sourcesOf(world.home, { service: fakeService() }))).toBe(2);
      expect(io.err).toContain('--watch belongs to run or install');
    }
  });

  test('only the service-manager no-terminal start is admitted with both flags', async () => {
    const world = scratch();
    const seen: StartMachineDaemonInput[] = [];
    const start = async (input: StartMachineDaemonInput) => {
      seen.push(input);
      return { kind: 'already-running' as const, pid: 9 };
    };
    const unit = testIo(world.root, { kind: 'owner-no-tty' });
    const admitted = await runDaemon(
      ['run', '--presence', '--watch', '--started-by', 'service-manager'],
      unit,
      sourcesOf(world.home, { start }),
    );
    expect(admitted).toBe(0);
    expect(seen[0]).toMatchObject({ startedBy: 'service-manager', presenceHosting: true, watchHosting: true });

    const manual = testIo(world.root, { kind: 'owner-no-tty' });
    expect(await runDaemon(['run', '--presence', '--watch'], manual, sourcesOf(world.home, { start }))).toBe(1);
    expect(manual.err).toContain('only the owner or the system service manager runs the machine daemon');
    expect(seen.length).toBe(1);
  });
});

describe('the broker stays absent and off, whatever the watch opt-in', () => {
  test('the catalogue default is off and a serving watch-opted daemon records the feature absent', async () => {
    const spec = POLICY_CATALOGUE['daemon.broker'];
    expect(spec.defaultValue).toBe('off');
    const resolved = resolvePolicy('daemon.broker', []);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.effective.value).toBe('off');

    const world = scratch();
    const started = await runThroughHost(world, ['run', '--watch'], owner, cyclingBuild);
    const serving = started.serving();
    expect(serving).not.toBeNull();
    if (serving === null) return;
    expect(serving.daemon.roots[0]?.watch).toBeDefined();
    const state = readDaemonState(world.home);
    expect(state.kind).toBe('ok');
    if (state.kind === 'ok') expect(state.state.features.broker).toBe('absent');
    expect(await started.finish()).toBe(0);
  });
});
