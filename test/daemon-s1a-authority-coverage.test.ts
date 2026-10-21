// Independent T3 coverage for the S1a hosted-watch fault diagnostic's authority and target.
//
// Contract read at B5's published head 6f7af92e94326e78f3c9963bfc9f046f58a7bf19:
// src/daemon/fault.ts, src/daemon/watch.ts, src/daemon/host.ts, src/commands/daemon.ts,
// src/permissions/map.ts, contract/cli.json and contract/exit-codes.json. The cases below were
// authored here; no builder test file or fixture was read or copied. Every daemon, watch,
// request and team is synthetic and in-process: no live service, no owner state, no signal and
// no process is killed. The authority scenes prove the install/uninstall admission
// (`ownerAllows`) and never the stricter foreground `run` gate (`runAllowed`).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { Caller } from '../src/caller.ts';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import {
  FAULT_WHY,
  createFaultInbox,
  faultRequestPath,
  faultResultPath,
  readFaultResult,
  writeFaultRequest,
  type FaultRequest,
  type FaultResult,
  type FaultTarget,
} from '../src/daemon/fault.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { canonicalRoot, routeId, routeOf, type HostedRoute } from '../src/daemon/routes.ts';
import { readDaemonState, writeDaemonState, type DaemonRootState, type DaemonState } from '../src/daemon/state.ts';
import { createHostedWatch, type HostedWatch } from '../src/daemon/watch.ts';
import type { HostedWatchState } from '../src/watch/hosted.ts';
import { testIo, type TestIo } from './helpers.ts';

const NOW = '2026-10-21T00:10:00.000Z';
const SEATS = ['orchestrator', 'operator-1', 'operator-2'] as const;
const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

/** The one route digest, computed here from the contract's own definition: sha256 of the
 *  canonical root, first 32 lowercase hex. `routeId` is asserted against it separately. */
function digestOf(root: string): string {
  return createHash('sha256').update(root, 'utf8').digest('hex').slice(0, 32);
}

function teamText(input: { home: string; root: string; project?: string; session?: string; entity?: string; lead?: string; seats?: readonly string[] }): string {
  const project = input.project ?? 'acme';
  const session = input.session ?? 'acme';
  const entity = input.entity ?? 'acme';
  const lead = input.lead ?? 'orchestrator';
  const seats = input.seats ?? SEATS;
  const lobby = join(input.home, '.config', 'team', 'lobbies', entity);
  const lines = [
    'format: 1',
    `project: ${project}`,
    `session: ${session}`,
    `entity: ${entity}`,
    `coordinator: ${lead}`,
    ...(seats.includes('operator-1') ? ['operator: operator-1'] : []),
    'workspace:',
    '  mode: shared',
    'seats:',
  ];
  for (const name of seats) {
    lines.push(
      `  - role: ${name === lead ? 'coordinator' : 'builder'}`,
      `    name: ${name}`,
      '    cli: claude-code',
      '    vendor: anthropic',
      '    model: Claude Opus',
      '    version: "5.5"',
      '    launch: claude --model claude-opus-5-5',
    );
  }
  lines.push('trust:', `  - ${lobby}`, `  - ${input.root}`);
  return `${lines.join('\n')}\n`;
}

type World = { base: string; home: string; root: string; route: HostedRoute; id: string };

function makeWorld(options: { project?: string; session?: string; entity?: string; name?: string; homeDir?: string } = {}): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-s1a-')));
  bases.push(base);
  const home = options.homeDir ?? join(base, 'home');
  mkdirSync(home, { recursive: true });
  const root = join(base, options.name ?? 'proj');
  const agents = join(root, '.agents');
  mkdirSync(agents, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'queue.yaml'), '');
  const project = options.project ?? 'acme';
  const session = options.session ?? 'acme';
  const canonical = canonicalRoot(root);
  if (canonical === null) throw new Error('the fixture root is not a readable folder');
  writeFileSync(
    join(agents, 'team.yaml'),
    teamText({ home, root: canonical, project, session, ...(options.entity !== undefined ? { entity: options.entity } : {}) }),
  );
  const route = routeOf(canonical, project, session, SEATS);
  return { base, home, root: canonical, route, id: digestOf(canonical) };
}

/** A home outside the team's own folder, for the scenes where the parent team's root holds the
 *  project: the loader refuses a trust entry that would cover the home's lobby and store. */
function outsideHome(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-s1a-home-')));
  bases.push(dir);
  return dir;
}

/** A seat state the dev-mode admission judges: `stage: ready` and the pane `team up` recorded. */
function writeSeatState(world: World, panes: Record<string, string>, session = world.route.session): void {
  const seats: Record<string, { stage: 'ready'; pane: string }> = {};
  for (const [name, pane] of Object.entries(panes)) seats[name] = { stage: 'ready', pane };
  writeFileSync(
    join(world.root, '.agents', 'team.state.json'),
    `${JSON.stringify({ format: 1, sessions: { [session]: { seats, worktrees: {} } } }, null, 2)}\n`,
  );
}

function watchState(world: World, over: Partial<HostedWatchState> = {}): HostedWatchState {
  return {
    routeId: world.id,
    root: world.root,
    team: world.route.team,
    session: world.route.session,
    phase: 'running',
    startedAt: '2026-10-21T00:00:00.000Z',
    lastCycleAt: '2026-10-21T00:00:05.000Z',
    lastCycleOutcome: 'pass',
    cycles: 3,
    failures: 0,
    effects: 'blocked',
    required: true,
    why: null,
    ...over,
  };
}

function rootRecord(world: World, watch: HostedWatchState | undefined = watchState(world)): DaemonRootState {
  return {
    root: world.root,
    team: world.route.team,
    send: 'serving',
    bus: 'serving',
    why: null,
    ...(watch !== undefined ? { watch } : {}),
  };
}

/** A running daemon record with a live pid: the CLI's health read treats it as running even
 *  though the synthetic socket is never there. */
function writeHealth(world: World, options: { pid?: number; since?: string; roots?: DaemonRootState[] } = {}): { pid: number; since: string } {
  const pid = options.pid ?? process.pid;
  const since = options.since ?? '2026-10-21T00:00:00.000Z';
  const state: DaemonState = {
    format: 1,
    pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : 501,
    since,
    startedBy: 'manual',
    version: '0.5.4-s1a-coverage',
    heartbeatAt: '2026-10-21T00:00:05.000Z',
    socket: join(world.home, '.config', 'team', 'daemon.sock'),
    features: { broker: 'absent' },
    stuck: [],
    roots: options.roots ?? [rootRecord(world)],
  };
  writeDaemonState(world.home, state);
  return { pid, since };
}

function ownerIo(world: World): TestIo {
  return testIo(world.root, { kind: 'owner' });
}

function seatIo(world: World, name: string, pane: string, session = world.route.session): TestIo {
  const caller: Caller = { kind: 'seat', name, pane, session };
  return testIo(world.root, caller);
}

function sources(world: World, over: Partial<DaemonCommandSources> = {}): DaemonCommandSources {
  return { home: world.home, now: () => new Date(NOW), ...over };
}

async function run(world: World, argv: string[], io: TestIo = ownerIo(world), over: Partial<DaemonCommandSources> = {}): Promise<number> {
  return runDaemon(argv, io, sources(world, over));
}

type JsonDoc = {
  schema?: { name?: string; version?: number };
  error?: { id?: string; message?: string };
  [key: string]: unknown;
};

function jsonOf(io: TestIo): JsonDoc {
  return JSON.parse(io.out) as JsonDoc;
}

function expectNothingWritten(world: World): void {
  expect(existsSync(faultRequestPath(world.home))).toBe(false);
  expect(existsSync(faultResultPath(world.home))).toBe(false);
}

/** A tiny stand-in for one daemon beat: it consumes the CLI's request with the real inbox and
 *  answers it the way the named outcome says, through the same public seams the daemon uses. */
function sceneSources(
  world: World,
  answer: 'faulted' | 'refused' | 'not reached' | 'none',
  over: Partial<DaemonCommandSources> = {},
): { sources: DaemonCommandSources; requests: FaultRequest[]; targetCount: () => number } {
  const requests: FaultRequest[] = [];
  const seen = { targets: 0 };
  const built = sources(world, {
    faultWaitMs: 3000,
    faultPollMs: 1,
    sleep: async () => {
      const path = faultRequestPath(world.home);
      if (!existsSync(path)) return;
      const request = JSON.parse(readFileSync(path, 'utf8')) as FaultRequest;
      requests.push(request);
      const inbox = createFaultInbox({
        home: world.home,
        pid: request.daemonPid,
        since: request.daemonSince,
        now: () => new Date(NOW),
      });
      let left: ((recorded: string) => void) | undefined;
      const target: FaultTarget = {
        state: () => ({ routeId: request.routeId, phase: 'running', required: true }),
        fault: (why, reached) => {
          seen.targets += 1;
          left = reached;
          return answer !== 'refused';
        },
      };
      inbox.consume([target]);
      if (answer === 'faulted') left?.(request.why);
      if (answer === 'not reached') inbox.close();
    },
    ...over,
  });
  return { sources: built, requests, targetCount: () => seen.targets };
}

function requestFor(home: string, route: string, over: Partial<FaultRequest> = {}): FaultRequest {
  return {
    format: 1,
    home,
    routeId: route,
    daemonPid: 4242,
    daemonSince: '2026-10-21T00:00:00.000Z',
    why: FAULT_WHY,
    requestedAt: '2026-10-21T00:00:01.000Z',
    nonce: 'nonce-0001',
    ...over,
  };
}

function fakeTarget(route: string, input: { phase?: HostedWatchState['phase']; required?: boolean; accepted?: boolean } = {}): FaultTarget & {
  calls: { why: string; left: ((recorded: string) => void) | undefined }[];
} {
  const calls: { why: string; left: ((recorded: string) => void) | undefined }[] = [];
  return {
    calls,
    state: () => ({ routeId: route, phase: input.phase ?? 'running', required: input.required ?? true }),
    fault: (why, left) => {
      calls.push({ why, left });
      return input.accepted ?? true;
    },
  };
}

async function waitUntil(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the scene');
    await new Promise((settle) => setTimeout(settle, 5));
  }
}

describe('the fault request is bound to the exact run and route', () => {
  test('the route digest is the contract definition, and a world names one exact route', () => {
    const world = makeWorld();
    expect(routeId(world.route)).toBe(world.id);
    expect(world.id).toMatch(/^[0-9a-f]{32}$/);
    // The seats are sorted into the route, so file order never changes the digest.
    const reversed = routeOf(world.root, world.route.team, world.route.session, [...SEATS].reverse());
    expect(routeId(reversed)).toBe(world.id);
  });

  test('a valid private request faults exactly the route it names and answers only when the seam is left', () => {
    const world = makeWorld();
    const other: HostedRoute = { ...world.route, root: join(world.base, 'other'), team: 'other', session: 'other' };
    const chosen = fakeTarget(world.id);
    const untouched = fakeTarget(routeId(other));
    const inbox = createFaultInbox({ home: world.home, pid: 4242, since: '2026-10-21T00:00:00.000Z', now: () => new Date(NOW) });
    const written = writeFaultRequest(world.home, requestFor(world.home, world.id, { why: 'diagnostic one' }));
    expect(written).toEqual({ ok: true });

    inbox.consume([untouched, chosen]);
    expect(chosen.calls).toHaveLength(1);
    expect(chosen.calls[0]?.why).toBe('diagnostic one');
    expect(untouched.calls).toHaveLength(0);
    // One-shot: the file is consumed, and no answer exists until the run reaches its seam.
    expect(existsSync(faultRequestPath(world.home))).toBe(false);
    expect(readFaultResult(world.home)).toBeNull();

    chosen.calls[0]?.left?.('the recorded reason');
    const result = readFaultResult(world.home);
    expect(result).toMatchObject({
      format: 1,
      home: world.home,
      routeId: world.id,
      nonce: 'nonce-0001',
      outcome: 'faulted',
      why: 'the recorded reason',
    });
  });

  test('a request for another daemon run (pid or since) is refused, never replayed', () => {
    const world = makeWorld();
    const inbox = createFaultInbox({ home: world.home, pid: 4242, since: '2026-10-21T00:00:00.000Z' });
    writeFaultRequest(world.home, requestFor(world.home, world.id, { daemonPid: 1717 }));
    const stale = fakeTarget(world.id);
    inbox.consume([stale]);
    expect(stale.calls).toHaveLength(0);
    expect(readFaultResult(world.home)).toMatchObject({
      outcome: 'refused',
      nonce: 'nonce-0001',
      why: 'the fault request was written for another daemon run',
    });

    // A second beat sees no request at all: the refusal consumed it.
    writeFileSync(faultResultPath(world.home), 'not the result');
    inbox.consume([stale]);
    expect(stale.calls).toHaveLength(0);
    expect(readFaultResult(world.home)).toBeNull();
  });

  test('a request resolved for another home is refused even when everything else matches', () => {
    const world = makeWorld();
    const inbox = createFaultInbox({ home: world.home, pid: 4242, since: '2026-10-21T00:00:00.000Z' });
    writeFaultRequest(world.home, requestFor(join(world.base, 'elsewhere'), world.id));
    const target = fakeTarget(world.id);
    inbox.consume([target]);
    expect(target.calls).toHaveLength(0);
    expect(readFaultResult(world.home)).toMatchObject({
      outcome: 'refused',
      why: 'the fault request names another daemon home',
    });
  });

  test('a request that names no hosted route, an optional route, a standby or a stopped one is refused', () => {
    const world = makeWorld();
    const unknownId = digestOf(join(world.base, 'not-hosted'));
    const cases: { request: string; target: FaultTarget; why: string }[] = [
      { request: unknownId, target: fakeTarget(world.id), why: 'no hosted watch serves this route' },
      { request: world.id, target: fakeTarget(world.id, { required: false }), why: 'the route was not started with a hosted watch' },
      { request: world.id, target: fakeTarget(world.id, { phase: 'standby' }), why: 'the route stands down to a live pane watch' },
      { request: world.id, target: fakeTarget(world.id, { phase: 'stopped' }), why: 'the hosted watch has stopped' },
      { request: world.id, target: fakeTarget(world.id, { accepted: false }), why: 'no hosted run is in flight to fault' },
    ];
    for (const one of cases) {
      const inbox = createFaultInbox({ home: world.home, pid: 4242, since: '2026-10-21T00:00:00.000Z' });
      writeFaultRequest(world.home, requestFor(world.home, one.request));
      inbox.consume([one.target]);
      expect(readFaultResult(world.home)).toMatchObject({ outcome: 'refused', why: one.why });
    }
  });

  test('a public request and a private result are both 0600 in the machine folder', () => {
    const world = makeWorld();
    const inbox = createFaultInbox({ home: world.home, pid: 4242, since: '2026-10-21T00:00:00.000Z' });
    writeFaultRequest(world.home, requestFor(world.home, world.id));
    expect(statSync(faultRequestPath(world.home)).mode & 0o777).toBe(0o600);
    const target = fakeTarget(world.id);
    inbox.consume([target]);
    target.calls[0]?.left?.('recorded');
    expect(statSync(faultResultPath(world.home)).mode & 0o777).toBe(0o600);
  });

  test('a request that is not a private 0600 file is refused without being acted on', () => {
    const world = makeWorld();
    const path = faultRequestPath(world.home);
    mkdirSync(join(world.home, '.config', 'team'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(requestFor(world.home, world.id), null, 2)}\n`, { mode: 0o644 });
    chmodSync(path, 0o644);
    const inbox = createFaultInbox({ home: world.home, pid: 4242, since: '2026-10-21T00:00:00.000Z' });
    const target = fakeTarget(world.id);
    inbox.consume([target]);
    expect(target.calls).toHaveLength(0);
    expect(readFaultResult(world.home)).toMatchObject({
      outcome: 'refused',
      nonce: 'nonce-0001',
      why: 'the fault request is not a private 0600 file',
    });
    expect(existsSync(path)).toBe(false);
  });

  test('malformed requests are refused, unlinked, and never replayed by a later beat', () => {
    const world = makeWorld();
    const path = faultRequestPath(world.home);
    const shapes = [
      'not json at all',
      JSON.stringify({ format: 2, home: world.home, routeId: world.id }),
      JSON.stringify(requestFor(world.home, 'NOT-A-ROUTE')),
      JSON.stringify(requestFor(world.home, world.id, { why: 'x'.repeat(201) })),
      JSON.stringify(requestFor(world.home, world.id, { nonce: 'x'.repeat(101) })),
    ];
    for (const text of shapes) {
      const inbox = createFaultInbox({ home: world.home, pid: 4242, since: '2026-10-21T00:00:00.000Z' });
      writeFaultRequest(world.home, requestFor(world.home, world.id));
      writeFileSync(path, text, { mode: 0o600 });
      chmodSync(path, 0o600);
      const target = fakeTarget(world.id);
      inbox.consume([target]);
      expect(target.calls).toHaveLength(0);
      expect(readFaultResult(world.home)).toMatchObject({ outcome: 'refused' });
      expect(existsSync(path)).toBe(false);
    }
  });

  test('one request is consumed once; a second request while the first is leaving its seam is refused', () => {
    const world = makeWorld();
    const inbox = createFaultInbox({ home: world.home, pid: 4242, since: '2026-10-21T00:00:00.000Z' });
    writeFaultRequest(world.home, requestFor(world.home, world.id, { nonce: 'first' }));
    const target = fakeTarget(world.id);
    inbox.consume([target]);
    expect(target.calls).toHaveLength(1);

    // No request file is left, so another beat does nothing at all.
    inbox.consume([target]);
    expect(target.calls).toHaveLength(1);

    // The first fault has not reached its seam; a second request is answered refused instead of
    // replacing the first writer's answer.
    writeFaultRequest(world.home, requestFor(world.home, world.id, { nonce: 'second' }));
    inbox.consume([target]);
    expect(target.calls).toHaveLength(1);
    expect(readFaultResult(world.home)).toMatchObject({ outcome: 'refused', nonce: 'second' });

    target.calls[0]?.left?.('first recorded');
    expect(readFaultResult(world.home)).toMatchObject({ outcome: 'faulted', nonce: 'first' });
  });

  test('closing answers a fault that never reached its seam as not reached', () => {
    const world = makeWorld();
    const inbox = createFaultInbox({ home: world.home, pid: 4242, since: '2026-10-21T00:00:00.000Z' });
    writeFaultRequest(world.home, requestFor(world.home, world.id));
    const target = fakeTarget(world.id);
    inbox.consume([target]);
    expect(readFaultResult(world.home)).toBeNull();
    inbox.close();
    expect(readFaultResult(world.home)).toMatchObject({
      outcome: 'not reached',
      nonce: 'nonce-0001',
      why: 'the daemon closed before the run left its seam',
    });
    // close runs after every watch stop has settled, so no left callback can still arrive.
    // The inbox keeps no pending entry once it has answered.
    inbox.close();
    expect(readFaultResult(world.home)).toMatchObject({ outcome: 'not reached' });
  });

  test('closing with no pending fault writes nothing, and a missing request is a no-op', () => {
    const world = makeWorld();
    const inbox = createFaultInbox({ home: world.home, pid: 4242, since: '2026-10-21T00:00:00.000Z' });
    inbox.consume([fakeTarget(world.id)]);
    inbox.close();
    expect(existsSync(faultResultPath(world.home))).toBe(false);
  });
});

describe('the watch seam ends only the run in flight, through its own exit path', () => {
  test('a fault during a wait counts one failure, records the reason, restarts on the next beat, and answers once', async () => {
    const world = makeWorld();
    let attempts = 0;
    const host = createHostedWatch({
      route: world.route,
      run: async (loop) => {
        attempts += 1;
        loop.cycled(new Date(NOW));
        if (!(await loop.wait(60_000))) return 0;
        return 0;
      },
    });
    const answered: string[] = [];
    await waitUntil(() => host.state().cycles === 1);
    expect(host.state().phase).toBe('running');
    expect(host.fault('injected one', (recorded) => answered.push(recorded))).toBe(true);
    expect(answered).toHaveLength(0);

    await waitUntil(() => host.state().failures === 1);
    expect(host.state()).toMatchObject({
      phase: 'failed',
      failures: 1,
      lastCycleOutcome: 'failed',
      why: 'injected one',
    });
    expect(answered).toEqual(['injected one']);

    // One restart on the next heartbeat tick, and the second run waits again.
    host.tick(new Date(Date.parse(NOW) + 5_000));
    expect(attempts).toBe(2);
    await waitUntil(() => host.state().phase === 'running');
    expect(host.state().failures).toBe(1);
    // A second fault before this run leaves its seam is refused; the first owns the exit.
    expect(host.fault('injected two')).toBe(true);
    expect(host.fault('injected three')).toBe(false);
    await host.stop('scene over');
  });

  test('a fault that lands while the run is mid-pass is delivered at the next wait, not slept past', async () => {
    const world = makeWorld();
    let release!: () => void;
    const gate = new Promise<void>((settle) => {
      release = settle;
    });
    let attempts = 0;
    const host = createHostedWatch({
      route: world.route,
      run: async (loop) => {
        attempts += 1;
        await gate;
        if (!(await loop.wait(60_000))) return 0;
        return 0;
      },
    });
    await Promise.resolve();
    expect(host.fault('mid-pass')).toBe(true);
    release();
    await waitUntil(() => host.state().failures === 1);
    expect(host.state()).toMatchObject({ phase: 'failed', failures: 1, why: 'mid-pass' });
    await host.stop('scene over');
    expect(attempts).toBe(1);
  });

  test('a standby, a stopped host, a terminal pulse failure and the gap before a restart all refuse', async () => {
    const world = makeWorld();

    const standing = createHostedWatch({ route: world.route, standby: 'a live pane watch owns this session', run: async () => 0 });
    expect(standing.state().phase).toBe('standby');
    expect(standing.fault('no one to end')).toBe(false);
    expect(standing.state().failures).toBe(0);

    const stopped = createHostedWatch({ route: world.route, run: async (loop) => {
      await loop.wait(60_000);
      return 0;
    } });
    await stopped.stop('closed');
    expect(stopped.fault('too late')).toBe(false);

    const terminal = createHostedWatch({
      route: world.route,
      run: async (loop) => {
        await loop.wait(60_000);
        return 0;
      },
      onTick: () => {
        throw new Error('the pulse failed');
      },
    });
    terminal.tick(new Date(NOW));
    expect(terminal.state()).toMatchObject({ phase: 'failed', failures: 1, why: 'the pulse failed' });
    expect(terminal.fault('no run to end')).toBe(false);

    let attempts = 0;
    const gap = createHostedWatch({ route: world.route, run: async (loop) => {
      attempts += 1;
      if (attempts === 1) throw new Error('the first run left');
      await loop.wait(60_000);
      return 0;
    } });
    await waitUntil(() => gap.state().failures === 1);
    expect(gap.fault('between runs')).toBe(false);
    expect(attempts).toBe(1);
    await gap.stop('scene over');
  });

  test('a deliberate stop after a fault owns the exit: the fault is dropped and never counted or answered', async () => {
    const world = makeWorld();
    let release!: () => void;
    const gate = new Promise<void>((settle) => {
      release = settle;
    });
    let answered = 0;
    const host = createHostedWatch({
      route: world.route,
      run: async (loop) => {
        await gate;
        if (!(await loop.wait(60_000))) return 0;
        return 0;
      },
    });
    await Promise.resolve();
    expect(host.fault('dropped by the stop', () => {
      answered += 1;
    })).toBe(true);
    const stopping = host.stop('the scene closed');
    release();
    await stopping;
    expect(host.state()).toMatchObject({ phase: 'stopped', why: 'the scene closed', failures: 0 });
    expect(answered).toBe(0);
  });

  test('an empty reason takes the fixed sentence rather than an empty record', async () => {
    const world = makeWorld();
    const host = createHostedWatch({ route: world.route, run: async (loop) => {
      loop.cycled(new Date(NOW));
      await loop.wait(60_000);
      return 0;
    } });
    expect(host.fault('   ')).toBe(true);
    await waitUntil(() => host.state().failures === 1);
    expect(host.state().why).toBe('a hosted watch fault was requested');
    await host.stop('scene over');
  });

  test('the same host restart cycle keeps a deliberate stop out of the failure count', async () => {
    const world = makeWorld();
    const host = createHostedWatch({ route: world.route, run: async (loop) => {
      loop.cycled(new Date(NOW));
      if (!(await loop.wait(60_000))) return 0;
      return 0;
    } });
    await waitUntil(() => host.state().cycles === 1);
    await host.stop('a deliberate stop');
    expect(host.state()).toMatchObject({ phase: 'stopped', failures: 0, cycles: 1 });
  });
});

describe('the CLI proves the route, the daemon and the watch before one request', () => {
  test('the owner is admitted; a missing daemon run is the refusal, not the owner gate', async () => {
    const world = makeWorld();
    const io = ownerIo(world);
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--json'], io)).toBe(1);
    expect(jsonOf(io).error?.id).toBe('daemon.fault-daemon');
    expect(jsonOf(io).error?.message).toContain('not running');
    expectNothingWritten(world);
  });

  test('the dev-mode orchestrator of the target team is admitted with its warning and log line', async () => {
    const world = makeWorld();
    writeSeatState(world, { orchestrator: 'main:p1' });
    writeHealth(world);
    const scene = sceneSources(world, 'faulted');
    const io = seatIo(world, 'orchestrator', 'main:p1');
    io.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id], io, scene.sources)).toBe(0);
    expect(io.err).toContain('warning: only the owner installs or removes the machine daemon; this call is orchestrator; dev mode continues');
    expect(io.out).toContain('faulted the hosted watch');
    const audit = readFileSync(join(world.root, '.agents', 'team.log'), 'utf8');
    expect(audit).toContain('daemon [orchestrator]');
    expect(audit).toContain('admitted as orchestrator');
    expect(scene.requests).toHaveLength(1);
    expect(scene.targetCount()).toBe(1);
  });

  test('operator-1 and operator-2 are refused by role even with dev mode on and a recorded pane', async () => {
    for (const name of ['operator-1', 'operator-2']) {
      const world = makeWorld();
      writeSeatState(world, { 'operator-1': 'main:p2', 'operator-2': 'main:p3' });
      writeHealth(world);
      const io = seatIo(world, name, name === 'operator-1' ? 'main:p2' : 'main:p3');
      io.env = { TEAMCLI_DEV_MODE: '1' };
      expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--json'], io, sceneSources(world, 'faulted').sources)).toBe(1);
      expect(jsonOf(io).error?.id).toBe('daemon.not-owner');
      expect(io.err).toBe('');
      expectNothingWritten(world);
    }
  });

  test('dev mode off, an unrecorded pane and an unplaced caller are no admission', async () => {
    const world = makeWorld();
    writeSeatState(world, { orchestrator: 'main:p1' });
    writeHealth(world);

    const off = seatIo(world, 'orchestrator', 'main:p1');
    off.env = {};
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--json'], off)).toBe(1);
    expect(jsonOf(off).error?.id).toBe('daemon.not-owner');

    const wrongPane = seatIo(world, 'orchestrator', 'main:p9');
    wrongPane.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--json'], wrongPane)).toBe(1);
    expect(jsonOf(wrongPane).error?.id).toBe('daemon.not-owner');

    const unplaced = testIo(world.root, { kind: 'unplaced', reason: 'its parent processes can\'t be read to the top' });
    unplaced.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--json'], unplaced)).toBe(1);
    expect(jsonOf(unplaced).error?.id).toBe('daemon.not-owner');
    expectNothingWritten(world);
  });

  test('the main orchestrator above the target is admitted only for the same entity', async () => {
    for (const entity of ['acme', 'beta']) {
      const world = makeWorld({ entity: 'acme', homeDir: outsideHome() });
      // The main team's root is the folder that holds the project checkout, so it strictly
      // contains the target.
      const parent = world.base;
      mkdirSync(join(parent, '.agents'), { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: parent });
      const canonicalParent = realpathSync(parent);
      writeFileSync(
        join(parent, '.agents', 'team.yaml'),
        teamText({ home: world.home, root: canonicalParent, project: 'main', session: 'main', entity, seats: ['orchestrator', 'operator-1'] }),
      );
      writeFileSync(
        join(parent, '.agents', 'team.state.json'),
        `${JSON.stringify({ format: 1, sessions: { main: { seats: { orchestrator: { stage: 'ready', pane: 'main:p0' } }, worktrees: {} } } }, null, 2)}\n`,
      );
      const { upsertTeam } = await import('../src/registry/teams.ts');
      upsertTeam(world.home, 'main-team', { project: 'main', session: 'main', root: canonicalParent, entity });
      writeHealth(world);
      const io = seatIo(world, 'orchestrator', 'main:p0', 'main');
      io.env = { TEAMCLI_DEV_MODE: '1' };
      const code = await run(world, ['fault-watch', '--root', world.root, '--route', world.id], io, sceneSources(world, 'faulted').sources);
      if (entity === 'acme') {
        expect(code).toBe(0);
        expect(io.err).toContain('dev mode continues');
      } else {
        expect(code).toBe(1);
        expect(io.err).toContain('team daemon: only the owner installs or removes the machine daemon');
      }
    }
  });

  test('a route id that is not the named checkout\'s own is refused before any request', async () => {
    const world = makeWorld();
    writeSeatState(world, { orchestrator: 'main:p1' });
    writeHealth(world);
    const io = seatIo(world, 'orchestrator', 'main:p1');
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const elsewhere = digestOf(join(world.base, 'elsewhere'));
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', elsewhere, '--json'], io, sceneSources(world, 'faulted').sources)).toBe(1);
    expect(jsonOf(io).error?.id).toBe('daemon.fault-route');
    expect(jsonOf(io).error?.message).toContain(world.id);
    expectNothingWritten(world);
  });

  test('malformed route ids and a malformed invocation are usage refusals', async () => {
    const world = makeWorld();
    writeHealth(world);
    const bad = ['not-a-route', world.id.toUpperCase(), world.id.slice(0, 31), `${world.id}0`];
    for (const id of bad) {
      const io = ownerIo(world);
      expect(await run(world, ['fault-watch', '--root', world.root, '--route', id, '--json'], io)).toBe(2);
      expect(jsonOf(io).error?.id).toBe('daemon.fault-usage');
      expectNothingWritten(world);
    }
    const invocations: string[][] = [
      ['fault-watch', '--root', world.root],
      ['fault-watch', '--route', world.id],
      ['fault-watch', '--root', world.root, '--root', world.root, '--route', world.id],
      ['fault-watch', '--root', world.root, '--route', world.id, '--started-by', 'manual'],
    ];
    for (const argv of invocations) {
      const io = ownerIo(world);
      expect(await run(world, [...argv, '--json'], io)).toBe(2);
      expect(jsonOf(io).error?.id).toBe('daemon.usage');
      expectNothingWritten(world);
    }
  });

  test('an unreadable checkout, a missing watch and an unwatchable state each refuse with their own id', async () => {
    const world = makeWorld();
    writeHealth(world);
    const unreadable = ownerIo(world);
    expect(await run(world, ['fault-watch', '--root', join(world.base, 'absent'), '--route', world.id, '--json'], unreadable)).toBe(2);
    expect(jsonOf(unreadable).error?.id).toBe('daemon.fault-root');

    const noWatch = ownerIo(world);
    // A root record with no hosted watch at all: the route is hosted for send and bus only.
    const { watch: _watch, ...bareRoot } = rootRecord(world);
    writeHealth(world, { roots: [bareRoot] });
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--json'], noWatch)).toBe(1);
    expect(jsonOf(noWatch).error?.id).toBe('daemon.fault-watch');

    for (const watch of [watchState(world, { required: false }), watchState(world, { phase: 'standby' }), watchState(world, { phase: 'stopped' })]) {
      writeHealth(world, { roots: [rootRecord(world, watch)] });
      const io = ownerIo(world);
      expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--json'], io)).toBe(1);
      expect(jsonOf(io).error?.id).toBe('daemon.fault-watch-state');
    }
    expectNothingWritten(world);
  });

  test('a dead pid is not a running daemon, and the resolved home is the one asked', async () => {
    const world = makeWorld();
    writeHealth(world, { pid: 0x7fffffff });
    const io = ownerIo(world);
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--json'], io)).toBe(1);
    expect(jsonOf(io).error?.id).toBe('daemon.fault-daemon');

    // The same checkout with a daemon record in a second home: only the injected home counts.
    const second = join(world.base, 'home2');
    mkdirSync(second, { recursive: true });
    // The file lists both homes' lobbies, so it loads under either resolved home; what decides
    // the reading is which home's daemon record is asked.
    mkdirSync(join(world.home, '.config', 'team', 'lobbies', 'acme'), { recursive: true });
    const file = join(world.root, '.agents', 'team.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('trust:\n', `trust:\n  - ${join(second, '.config', 'team', 'lobbies', 'acme')}\n`));
    const ioSecond = ownerIo(world);
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--json'], ioSecond, { home: second })).toBe(1);
    expect(jsonOf(ioSecond).error?.id).toBe('daemon.fault-daemon');
    expect(existsSync(join(second, '.config', 'team', 'daemon.fault-request.json'))).toBe(false);
  });

  test('a dry run prints the plan for the one route and writes nothing', async () => {
    const world = makeWorld();
    writeHealth(world);
    const text = ownerIo(world);
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--dry-run'], text)).toBe(0);
    expect(text.out).toContain('would ask the running daemon to fault the hosted watch');
    expectNothingWritten(world);

    const json = ownerIo(world);
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--dry-run', '--json'], json)).toBe(0);
    expect(jsonOf(json).schema?.name).toBe('team.daemon-fault');
    expect(jsonOf(json)).toMatchObject({ format: 1, command: 'fault-watch', dry_run: true, root: world.root, route_id: world.id });
    expectNothingWritten(world);
  });

  test('a request already waiting is refused and left byte-identical', async () => {
    const world = makeWorld();
    writeHealth(world);
    writeFaultRequest(world.home, requestFor(world.home, world.id, { nonce: 'waiting' }));
    const before = readFileSync(faultRequestPath(world.home), 'utf8');
    const io = ownerIo(world);
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--json'], io)).toBe(1);
    expect(jsonOf(io).error?.id).toBe('daemon.fault-pending');
    expect(readFileSync(faultRequestPath(world.home), 'utf8')).toBe(before);
    expect(existsSync(faultResultPath(world.home))).toBe(false);
  });

  test('the answer faulted is one request, one nonce and one result, and exits 0', async () => {
    const world = makeWorld();
    const health = writeHealth(world);
    const scene = sceneSources(world, 'faulted');
    const io = ownerIo(world);
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id], io, scene.sources)).toBe(0);
    expect(io.out).toContain('faulted the hosted watch');
    expect(scene.requests).toHaveLength(1);
    const request = scene.requests[0] as FaultRequest;
    expect(request).toMatchObject({
      format: 1,
      home: world.home,
      routeId: world.id,
      daemonPid: health.pid,
      daemonSince: health.since,
      why: FAULT_WHY,
      requestedAt: NOW,
    });
    expect(request.nonce.length).toBeGreaterThan(0);
    expect(existsSync(faultRequestPath(world.home))).toBe(false);
    expect(readFaultResult(world.home)).toMatchObject({ outcome: 'faulted', routeId: world.id, nonce: request.nonce });
  });

  test('--json names the fault, the route and the daemon\'s own reason', async () => {
    const world = makeWorld();
    writeHealth(world);
    const io = ownerIo(world);
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--json'], io, sceneSources(world, 'faulted').sources)).toBe(0);
    const doc = jsonOf(io);
    expect(doc.schema?.name).toBe('team.daemon-fault');
    expect(doc).toMatchObject({ format: 1, command: 'fault-watch', outcome: 'faulted', root: world.root, route_id: world.id, why: FAULT_WHY });
    expect(typeof doc.requested_at).toBe('string');
    expect(typeof doc.answered_at).toBe('string');
  });

  test('a refused answer and a not-reached answer are different refusals, both exit 1', async () => {
    const world = makeWorld();
    writeHealth(world);
    const refused = ownerIo(world);
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--json'], refused, sceneSources(world, 'refused').sources)).toBe(1);
    expect(jsonOf(refused).error?.id).toBe('daemon.fault-refused');
    expect(jsonOf(refused).error?.message).toContain('no hosted run is in flight to fault');

    const unreached = ownerIo(world);
    expect(await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--json'], unreached, sceneSources(world, 'not reached').sources)).toBe(1);
    expect(jsonOf(unreached).error?.id).toBe('daemon.fault-not-reached');
    expect(jsonOf(unreached).error?.message).toContain('did not reach the fault');
  });

  test('a timed-out wait leaves the request for a later beat and kills nothing', async () => {
    const world = makeWorld();
    writeHealth(world);
    const io = ownerIo(world);
    const code = await run(world, ['fault-watch', '--root', world.root, '--route', world.id, '--json'], io, { faultWaitMs: 0 });
    expect(code).toBe(1);
    expect(jsonOf(io).error?.id).toBe('daemon.fault-not-reached');
    expect(existsSync(faultRequestPath(world.home))).toBe(true);
    expect(statSync(faultRequestPath(world.home)).mode & 0o777).toBe(0o600);
    expect(existsSync(faultResultPath(world.home))).toBe(false);
  });

  test('refusals never write a request, and the JSON error names the contract id', async () => {
    const world = makeWorld();
    const cases: { argv: string[]; id: string; code: number }[] = [
      { argv: ['fault-watch', '--root', join(world.base, 'absent'), '--route', world.id], id: 'daemon.fault-root', code: 2 },
      { argv: ['fault-watch', '--root', world.root, '--route', digestOf(join(world.base, 'nope'))], id: 'daemon.fault-route', code: 1 },
    ];
    for (const one of cases) {
      const io = ownerIo(world);
      expect(await run(world, [...one.argv, '--json'], io)).toBe(one.code);
      expect(jsonOf(io).error?.id).toBe(one.id);
      expectNothingWritten(world);
    }
  });
});

describe('the daemon heartbeat consumes the request and faults exactly the named host', () => {
  test('one rooted request ends the named watch, counts one failure, restarts it, and leaves the other route alone', async () => {
    const world = makeWorld();
    const second = makeWorld({ project: 'other', session: 'other', name: 'other', homeDir: world.home });
    const attempts = new Map<string, number>();
    const started = await startMachineDaemon({
      home: world.home,
      roots: [world.root, second.root],
      startedBy: 'manual',
      version: '0.5.4-s1a-coverage',
      heartbeatMs: 25,
      watchHosting: true,
      hostedWatch: (route) => ({
        run: async (loop) => {
          attempts.set(route.root, (attempts.get(route.root) ?? 0) + 1);
          for (;;) {
            loop.cycled(new Date());
            if (!(await loop.wait(60_000))) return 0;
          }
        },
      }),
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const watchOf = (root: string): HostedWatchState | undefined => {
        const read = readDaemonState(world.home);
        return read.kind === 'ok' ? read.state.roots.find((one) => one.root === root)?.watch : undefined;
      };
      await waitUntil(() => watchOf(world.root)?.phase === 'running' && watchOf(second.root)?.phase === 'running');
      const before = readDaemonState(world.home);
      expect(before.kind).toBe('ok');
      if (before.kind === 'ok') {
        const ids = before.state.roots.map((one) => one.watch?.routeId);
        expect(ids).toContain(world.id);
        expect(ids).toContain(second.id);
      }

      const io = ownerIo(world);
      expect(await runDaemon(
        ['fault-watch', '--root', world.root, '--route', world.id, '--json'],
        io,
        { home: world.home, faultWaitMs: 4000, faultPollMs: 5 },
      )).toBe(0);
      const doc = jsonOf(io);
      expect(doc).toMatchObject({ outcome: 'faulted', route_id: world.id, why: FAULT_WHY });

      await waitUntil(() => (attempts.get(world.root) ?? 0) >= 2);
      const after = readDaemonState(world.home);
      expect(after.kind).toBe('ok');
      if (after.kind === 'ok') {
        const target = after.state.roots.find((one) => one.root === world.root)?.watch;
        const untouched = after.state.roots.find((one) => one.root === second.root)?.watch;
        expect(target?.failures).toBe(1);
        expect(target?.lastCycleAt).not.toBeNull();
        expect(untouched?.failures).toBe(0);
      }
      expect(attempts.get(second.root)).toBe(1);
      expect(existsSync(faultRequestPath(world.home))).toBe(false);
      expect(readFaultResult(world.home)).toMatchObject({ outcome: 'faulted', routeId: world.id, why: FAULT_WHY });
    } finally {
      await started.daemon.close();
    }
  }, 20_000);
});
