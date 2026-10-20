// The daemon's presence lifecycle under the real machine host: a synthetic home and checkout, the
// real single-instance lock and machine socket, and injected presence handles so the scenes can
// observe steps, coalescing and close without a live runtime. No owner session, credential or
// pane is touched.
//
// The scenes pin: integration default closed; one ingester per canonical route and none for a
// duplicate or unreadable root; at most one pass per route in flight (a busy route is skipped, not
// queued); admission closes before the presence drain; and ownership is retained with the record
// saying `pending` until the drain is truthfully quiesced.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startMachineDaemon, type StartMachineDaemonInput } from '../src/daemon/host.ts';
import { daemonHealth, probeDaemonHealth } from '../src/daemon/health.ts';
import { daemonLockPath, daemonSocketPath } from '../src/daemon/paths.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import type { PresenceActivityResult } from '../src/daemon/presence/activity.ts';
import { createPresenceActivity } from '../src/daemon/presence/activity.ts';
import {
  PRESENCE_HEALTH_GRACE_MS, type PresenceSource, type PresenceSourceRuntime,
  type PresenceSourceStatus,
} from '../src/daemon/presence/health.ts';
import { createPresenceIngester, type PresenceIngestResult, type PresenceIngester } from '../src/daemon/presence/ingest.ts';
import type { PresencePublishResult } from '../src/daemon/presence/publish.ts';
import { presencePaths, stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import { STATE_FILE } from '../src/state.ts';

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
    launch: claude
`;

function emptyIngest(): PresenceIngestResult {
  // A fake closed result is not the ingester's verdict on a live channel: it is never healthy.
  return { ingested: [], rejected: [], stale: [], repaired: [], errors: [], healthy: false, pending: false, closed: false };
}

function ingest(over: Partial<PresenceIngestResult> = {}): PresenceIngestResult {
  return { ...emptyIngest(), ...over };
}

function activityResult(): PresenceActivityResult {
  return { seats: [], failed: null };
}

function publishResult(): PresencePublishResult {
  return { seats: [], failed: null };
}

type Scratch = { base: string; root: string; home: string };

function scratch(name = 'repo'): Scratch {
  const made = realpathSync(mkdtempSync(join(tmpdir(), 'team-presence-host-')));
  const repo = join(made, name);
  const home = join(made, 'home');
  mkdirSync(join(repo, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, '.agents', 'team.yaml'), CREW);
  return { base: made, root: repo, home };
}

let world: Scratch = { base: '', root: '', home: '' };
let made: Scratch[] = [];
let cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  world = scratch();
  made = [world];
});

afterEach(async () => {
  const fns = cleanups.reverse();
  cleanups = [];
  for (const fn of fns) {
    try { await fn(); } catch { /* one failed cleanup must not hide another */ }
  }
  for (const one of made) rmSync(one.base, { recursive: true, force: true });
});

function later(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}

async function start(overrides: Partial<StartMachineDaemonInput>) {
  const started = await startMachineDaemon({
    home: world.home,
    roots: [world.root],
    startedBy: 'service-manager',
    version: '0.5.3-presence-host-test',
    heartbeatMs: 20,
    ...overrides,
  });
  if (started.kind !== 'serving') throw new Error(`the daemon did not start: ${started.kind}`);
  later(async () => {
    try { await started.daemon.close(); } catch { /* the scene already closed it */ }
  });
  return started.daemon;
}

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the daemon');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the presence pass', () => {
  test('integration is closed by default: neither builder runs', async () => {
    let built = 0;
    let steps = 0;
    const ingester: PresenceIngester = {
      step: async () => { steps += 1; return emptyIngest(); },
      close: async () => ({ quiesced: true }),
      isClosed: () => false,
    };
    const daemon = await start({
      presenceIngest: () => { built += 1; return ingester; },
      presenceActivity: () => async () => { built += 1; return activityResult(); },
      presencePublish: () => async () => { built += 1; return publishResult(); },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(built).toBe(0);
    expect(steps).toBe(0);
    await daemon.close();
  }, 15_000);

  test('one ingester per canonical route; a duplicate spelling and an unreadable root get none', async () => {
    const unreadable = join(world.base, 'unreadable');
    mkdirSync(unreadable, { recursive: true });
    const built: Array<{ root: string; stateDir: string }> = [];
    const published: Array<{ root: string; stateDir: string }> = [];
    let steps = 0;
    const ingester: PresenceIngester = {
      step: async () => { steps += 1; return emptyIngest(); },
      close: async () => ({ quiesced: true }),
      isClosed: () => false,
    };
    const daemon = await start({
      roots: [world.root, `${world.root}/`, unreadable],
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: (route, stateDir) => { built.push({ root: route.root, stateDir }); return ingester; },
      presenceActivity: () => async () => activityResult(),
      presencePublish: (route, stateDir) => {
        published.push({ root: route.root, stateDir });
        return async () => publishResult();
      },
    });
    await waitUntil(() => steps >= 2);
    expect(built).toEqual([{ root: world.root, stateDir: join(world.root, '.agents') }]);
    expect(published).toEqual([{ root: world.root, stateDir: join(world.root, '.agents') }]);
    await daemon.close();
  }, 15_000);

  test('a route with a pass in flight is skipped, never queued, and the pass resumes', async () => {
    let steps = 0;
    let first = true;
    let release: (() => void) | null = null;
    let activities = 0;
    const ingester: PresenceIngester = {
      step: () => {
        steps += 1;
        if (!first) return Promise.resolve(emptyIngest());
        first = false;
        return new Promise<PresenceIngestResult>((resolve) => {
          release = () => { resolve(emptyIngest()); };
        });
      },
      close: async () => ({ quiesced: true }),
      isClosed: () => false,
    };
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: () => ingester,
      presenceActivity: () => async () => { activities += 1; return activityResult(); },
    });
    await waitUntil(() => steps === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(steps).toBe(1);
    expect(activities).toBe(0);
    release!();
    await waitUntil(() => activities >= 1);
    await waitUntil(() => steps >= 2);
    // The activity step runs only after the ingester step it follows resolved.
    await daemon.close();
  }, 15_000);
});

describe('closing', () => {
  test('admission closes first, the in-flight pass drains, and ownership is released only then', async () => {
    const order: string[] = [];
    let resolveClose: ((value: { quiesced: true }) => void) | null = null;
    const ingester: PresenceIngester = {
      step: async () => emptyIngest(),
      close: () => {
        order.push('ingest-close');
        return new Promise<{ quiesced: true }>((resolve) => { resolveClose = resolve; });
      },
      isClosed: () => false,
    };
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: () => ingester,
      presenceActivity: () => async () => activityResult(),
      watchHosting: true,
      hostedWatch: () => ({
        run: (loop) => new Promise<number>((resolve) => {
          loop.signal.addEventListener('abort', () => {
            order.push('watch-stop');
            resolve(0);
          }, { once: true });
        }),
      }),
    });
    let settled = false;
    const closing = daemon.close().then(() => { settled = true; });
    await waitUntil(() => order.includes('watch-stop') && order.includes('ingest-close'));
    expect(order.indexOf('watch-stop')).toBeLessThan(order.indexOf('ingest-close'));
    expect(settled).toBe(false);
    expect(existsSync(daemonLockPath(world.home))).toBe(true);
    expect(existsSync(daemonSocketPath(world.home))).toBe(true);
    resolveClose!({ quiesced: true });
    await closing;
    expect(existsSync(daemonLockPath(world.home))).toBe(false);
    expect(existsSync(daemonSocketPath(world.home))).toBe(false);
  }, 15_000);

  test('a truthful non-quiescence retains the lock, socket and record and says pending', async () => {
    let closeCalls = 0;
    const ingester: PresenceIngester = {
      step: async () => emptyIngest(),
      close: async () => {
        closeCalls += 1;
        return { quiesced: false, why: 'the presence log write is stuck' } as unknown as { quiesced: true };
      },
      isClosed: () => false,
    };
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: () => ingester,
      presenceActivity: () => async () => activityResult(),
    });
    await daemon.close();
    expect(closeCalls).toBe(1);
    expect(existsSync(daemonLockPath(world.home))).toBe(true);
    expect(existsSync(daemonSocketPath(world.home))).toBe(true);
    const read = readDaemonState(world.home);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') {
      expect(read.state.roots[0]?.presence).toEqual({
        state: 'pending',
        why: 'the presence log write is stuck',
      });
    }
    // A second close retries the handle whose own answer was not truthful; ownership still holds.
    await daemon.close();
    expect(closeCalls).toBe(2);
    expect(existsSync(daemonLockPath(world.home))).toBe(true);
  }, 15_000);

  test('a false, then a rejected, then a truthful close: one retry per handle and release only on true', async () => {
    let closeCalls = 0;
    let answer: 'false' | 'reject' | 'true' = 'false';
    const ingester: PresenceIngester = {
      step: async () => emptyIngest(),
      close: async () => {
        closeCalls += 1;
        if (answer === 'reject') throw new Error('the presence log write is stuck');
        if (answer === 'false') {
          return { quiesced: false, why: 'the presence log write is stuck' } as unknown as { quiesced: true };
        }
        return { quiesced: true };
      },
      isClosed: () => false,
    };
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: () => ingester,
      presenceActivity: () => async () => activityResult(),
    });

    await daemon.close();
    expect(closeCalls).toBe(1);
    expect(existsSync(daemonLockPath(world.home))).toBe(true);
    expect(existsSync(daemonSocketPath(world.home))).toBe(true);
    const first = readDaemonState(world.home);
    if (first.kind === 'ok') {
      expect(first.state.roots[0]?.presence).toEqual({
        state: 'pending',
        why: 'the presence log write is stuck',
      });
    }

    answer = 'reject';
    await daemon.close();
    expect(closeCalls).toBe(2);
    expect(existsSync(daemonLockPath(world.home))).toBe(true);
    const second = readDaemonState(world.home);
    if (second.kind === 'ok') {
      expect(second.state.roots[0]?.presence?.why).toBe('the presence log write is stuck');
    }

    // Two concurrent callers join one run: the retried handle is closed once, and only a truthful
    // quiescence releases the lock, socket and record.
    answer = 'true';
    const left = daemon.close();
    const right = daemon.close();
    expect(right).toBe(left);
    await Promise.all([left, right]);
    expect(closeCalls).toBe(3);
    expect(existsSync(daemonLockPath(world.home))).toBe(false);
    expect(existsSync(daemonSocketPath(world.home))).toBe(false);
    expect(readDaemonState(world.home).kind).toBe('missing');
  }, 15_000);
});

// The existing read-only health answer carries each route's presence answer, derived in memory
// for the request. Nothing here is persisted or read back from `status.json`; the only healthy
// answer is the producer's typed one, current inside the fixed grace, with the daemon open.
describe('the health answer', () => {
  const canonical = (): string => realpathSync(world.root);

  function handle(over: Partial<PresenceIngester> = {}): PresenceIngester {
    return {
      step: async () => ingest(),
      close: async () => ({ quiesced: true }),
      isClosed: () => false,
      ...over,
    };
  }

  test('presence hosting off omits presence, so no health is known', async () => {
    const daemon = await start({});
    const snapshot = daemon.health();
    expect(snapshot.roots).toEqual([{ root: canonical() }]);
    expect(snapshot.roots?.[0]?.presence).toBeUndefined();
    await daemon.close();
  }, 15_000);

  test('a typed healthy step answers serving; a fault and a backlog answer pending with a why', async () => {
    let clock = new Date('2026-10-20T00:00:00.000Z');
    let current = ingest({ healthy: true });
    let steps = 0;
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      now: () => clock,
      presenceIngest: () => handle({
        step: async () => { steps += 1; return current; },
      }),
      presenceActivity: () => async () => activityResult(),
    });
    await waitUntil(() => steps >= 1);
    const serving = daemon.health().roots?.[0]?.presence;
    expect(serving).toMatchObject({ session: 'crew', state: 'serving', healthy: true, why: null });
    expect(serving?.checkedAt).toBe(clock.toISOString());

    // The next request is fresh: the clock moved, so its checkedAt is its own instant, and the
    // producer's typed fault replaces the old serving record rather than being averaged with it.
    clock = new Date(clock.getTime() + 1_000);
    current = ingest({ errors: [{ seat: 'worker-1', id: '', why: 'the presence log is faulted' }] });
    let mark = steps;
    await waitUntil(() => steps > mark);
    const faulted = daemon.health().roots?.[0]?.presence;
    expect(faulted).toMatchObject({
      session: 'crew', state: 'pending', healthy: false, why: 'the presence log is faulted',
    });
    expect(faulted?.checkedAt).toBe(clock.toISOString());

    // Healthy true with pending true is the producer's own backlog: not caught up, not serving.
    clock = new Date(clock.getTime() + 1_000);
    current = ingest({ healthy: true, pending: true });
    mark = steps;
    await waitUntil(() => steps > mark);
    expect(daemon.health().roots?.[0]?.presence).toMatchObject({
      state: 'pending', healthy: false, why: 'the presence channel still has a backlog',
    });
    await daemon.close();
  }, 15_000);

  test('a gap past the fixed grace answers pending, never the last serving word', async () => {
    let clock = new Date('2026-10-20T00:00:00.000Z');
    let steps = 0;
    let hang = false;
    let release: (() => void) | null = null;
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      now: () => clock,
      presenceIngest: () => handle({
        step: () => {
          steps += 1;
          if (!hang) return Promise.resolve(ingest({ healthy: true }));
          return new Promise<PresenceIngestResult>((resolve) => {
            release = () => {
              hang = false;
              resolve(ingest({ healthy: true }));
            };
          });
        },
      }),
      presenceActivity: () => async () => activityResult(),
    });
    later(() => release?.());
    await waitUntil(() => daemon.health().roots?.[0]?.presence?.healthy === true);

    hang = true;
    const mark = steps;
    await waitUntil(() => steps > mark);
    clock = new Date(clock.getTime() + PRESENCE_HEALTH_GRACE_MS + 1);
    expect(daemon.health().roots?.[0]?.presence).toMatchObject({
      state: 'pending',
      healthy: false,
      why: 'no presence step finished inside the liveness window',
    });

    release!();
    await daemon.close();
  }, 15_000);

  test('a closing daemon answers pending with why, never the last serving word', async () => {
    let release: (() => void) | null = null;
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: () => handle({
        step: async () => ingest({ healthy: true }),
        close: () => new Promise((resolve) => {
          release = () => resolve({ quiesced: true });
        }),
      }),
      presenceActivity: () => async () => activityResult(),
    });
    await waitUntil(() => daemon.health().roots?.[0]?.presence?.healthy === true);

    // Admission stops synchronously at the first line of the close; the endpoint refuses, and
    // the in-process snapshot names the close instead of repeating the last serving answer.
    const closing = daemon.close();
    expect(daemon.health().roots?.[0]?.presence).toMatchObject({
      state: 'pending', healthy: false, why: 'the daemon is closing',
    });
    await waitUntil(() => release !== null);
    release!();
    await closing;
  }, 15_000);

  test('the socket answer and the client reading carry the same fresh presence by canonical root', async () => {
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: () => handle({ step: async () => ingest({ healthy: true }) }),
      presenceActivity: () => async () => activityResult(),
    });
    await waitUntil(() => daemon.health().roots?.[0]?.presence?.healthy === true);

    const answer = await probeDaemonHealth(daemonSocketPath(world.home), { id: 'health-scene' });
    expect(answer.kind).toBe('answered');
    if (answer.kind === 'answered') {
      expect(answer.health.roots).toHaveLength(1);
      expect(answer.health.roots?.[0]).toMatchObject({
        root: canonical(),
        presence: { session: 'crew', state: 'serving', healthy: true, why: null },
      });
    }

    const reading = await daemonHealth(world.home);
    expect(reading.state).toBe('running');
    expect(reading.probe.state).toBe('answered');
    expect(reading.roots).toHaveLength(1);
    expect(reading.roots[0]?.root).toBe(canonical());
    expect(reading.roots[0]?.presence).toMatchObject({
      session: 'crew', state: 'serving', healthy: true, why: null,
    });
    await daemon.close();
  }, 15_000);
});

// Runtime sources are per seat and per managed incarnation. The route's answer stays the ingest
// answer; a seat's own answer is a fresh in-memory sample fenced on the seat's current binding
// and this daemon epoch, and a failed expected attachment is an explicit unproven source rather
// than silence. A quiet channel is never expired by an event's age.
describe('the per-seat runtime sources', () => {
  const BINDING = 'prs_0123456789ab';

  function writeSeatBindings(bindings: Record<string, string>): void {
    const seats: Record<string, unknown> = {};
    for (const [seat, binding] of Object.entries(bindings)) {
      seats[seat] = { stage: 'ready', presence_binding: binding };
    }
    writeFileSync(join(world.root, '.agents', STATE_FILE), JSON.stringify({
      format: 1,
      sessions: { crew: { seats, worktrees: {} } },
    }));
  }

  function servingIngester(): PresenceIngester {
    return {
      step: async () => ingest({ healthy: true }),
      close: async () => ({ quiesced: true }),
      isClosed: () => false,
    };
  }

  // The exact staged identity both the canonical projection and its applied fence name. A
  // source is only qualified once its own `stagedEventId` equals this and the fence matches.
  const EVENT_ID = '2026-10-20T00:00:00.000Z-aaaaaaaa';
  const seatIds = new Map<string, string>();

  /** Writes the canonical position a reconciled runtime seat needs: `current.json` and the
   *  state record's binding plus applied fence, naming the same staged id and sequence. Each
   *  seat gets its own `seat_...` id, because a repeated seat id is dropped by the state door. */
  function writeCanonical(
    seat: string,
    input: { binding: string; id?: string; seq?: number; state?: string },
  ): void {
    const id = input.id ?? EVENT_ID;
    const seq = input.seq ?? 1;
    let seatId = seatIds.get(seat);
    if (seatId === undefined) {
      seatId = `seat_${String(seatIds.size + 1).padStart(12, '0')}`;
      seatIds.set(seat, seatId);
    }
    type LooseSession = { seats?: Record<string, Record<string, unknown>>; worktrees?: Record<string, unknown> };
    let file: { format?: number; sessions?: Record<string, LooseSession> } = {};
    try {
      file = JSON.parse(readFileSync(join(world.root, '.agents', STATE_FILE), 'utf8'));
    } catch {
      // A fresh scratch world has no state file yet; the canonical record is the first one.
    }
    file.format ??= 1;
    file.sessions ??= {};
    const session = file.sessions.crew ??= {};
    session.seats ??= {};
    session.worktrees ??= {};
    session.seats[seat] = {
      ...(session.seats[seat] ?? {}),
      id: seatId,
      stage: 'ready',
      presence_binding: input.binding,
      presence_applied: {
        seat_id: seatId,
        binding: input.binding,
        seq,
        applied_at: '2026-10-20T00:00:00.000Z',
      },
    };
    writeFileSync(join(world.root, '.agents', STATE_FILE), JSON.stringify(file));
    const dir = join(world.root, '.agents', 'presence', 'crew', seat);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'current.json'), JSON.stringify({
      v: 1,
      seq,
      id,
      state: input.state ?? 'idle',
      source: 'runtime-event',
      event: 'turn-end',
      binding: input.binding,
      since: '2026-10-20T00:00:00.000Z',
      observedAt: '2026-10-20T00:00:00.000Z',
    }));
  }

  function started(
    seat: string,
    reading: () => PresenceSourceStatus,
    close: () => Promise<{ quiesced: true }> = async () => ({ quiesced: true }),
  ): PresenceSource {
    // A started source that has reached its baseline has staged one record; the scenes that
    // need a different identity override it in the reading.
    return { seat, step: async () => {}, status: () => ({ stagedEventId: EVENT_ID, ...reading() }), close };
  }

  test('a current-incarnation source serves one seat while a refused expected attachment stays pending', async () => {
    const clock = new Date('2026-10-20T00:00:00.000Z');
    writeSeatBindings({ 'worker-1': BINDING, 'crew-op': 'prs_ffffffffffff' });
    writeCanonical('worker-1', { binding: BINDING });
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      now: () => clock,
      presenceIngest: () => servingIngester(),
      presenceActivity: () => async () => activityResult(),
      presenceSubscriptions: (): PresenceSource[] => [
        started('worker-1', () => ({
          seat: 'worker-1', binding: BINDING, threadId: 'thread-1', channel: 'connected',
          stream: 'initialized', baseline: 'read', evidenceAt: clock.toISOString(), why: null,
        })),
      ],
      presenceUnproven: () => [{ seat: 'crew-op', why: 'the managed thread is archived' }],
    });
    await waitUntil(() => daemon.health().roots?.[0]?.presence?.seats
      ?.find((seat) => seat.seat === 'worker-1')?.healthy === true);
    const presence = daemon.health().roots?.[0]?.presence;
    // The route's own answer is still the ingest answer, and the refused seat never inherits it.
    // The list is complete: the never-launched hook seat is explicitly pending, not omitted.
    expect(presence).toMatchObject({ session: 'crew', state: 'serving', healthy: true, why: null });
    expect(presence?.seats).toEqual([
      {
        seat: 'crew-lead', state: 'pending', healthy: false, source: 'hook', binding: null,
        appliedEventId: null, why: 'the seat records no presence binding',
      },
      {
        seat: 'crew-op', state: 'pending', healthy: false, source: 'runtime',
        binding: 'prs_ffffffffffff', appliedEventId: null, why: 'the managed thread is archived',
      },
      {
        seat: 'worker-1', state: 'serving', healthy: true, source: 'runtime', binding: BINDING,
        appliedEventId: EVENT_ID, why: null,
      },
    ]);
    await daemon.close();
  }, 15_000);

  test('a predecessor binding never serves a seat, and a quiet current channel serves with old evidence', async () => {
    const clock = new Date('2026-10-20T00:00:00.000Z');
    writeSeatBindings({ 'worker-1': BINDING, 'crew-op': 'prs_ffffffffffff' });
    writeCanonical('crew-op', { binding: 'prs_ffffffffffff' });
    const old = new Date(clock.getTime() - 8 * 60 * 60_000).toISOString();
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      now: () => clock,
      presenceIngest: () => servingIngester(),
      presenceActivity: () => async () => activityResult(),
      presenceSubscriptions: (): PresenceSource[] => [
        started('worker-1', () => ({
          seat: 'worker-1', binding: 'prs_999999999999', threadId: 'thread-1', channel: 'connected',
          stream: 'initialized', baseline: 'read', evidenceAt: clock.toISOString(), why: null,
        })),
        started('crew-op', () => ({
          seat: 'crew-op', binding: 'prs_ffffffffffff', threadId: 'thread-2', channel: 'connected',
          stream: 'initialized', baseline: 'read', evidenceAt: old, why: null,
        })),
      ],
    });
    await waitUntil(() => daemon.health().roots?.[0]?.presence?.seats
      ?.find((seat) => seat.seat === 'crew-op')?.healthy === true);
    expect(daemon.health().roots?.[0]?.presence?.seats).toEqual([
      {
        seat: 'crew-lead', state: 'pending', healthy: false, source: 'hook', binding: null,
        appliedEventId: null, why: 'the seat records no presence binding',
      },
      {
        seat: 'crew-op', state: 'serving', healthy: true, source: 'runtime',
        binding: 'prs_ffffffffffff', appliedEventId: EVENT_ID, why: null,
      },
      {
        seat: 'worker-1', state: 'pending', healthy: false, source: 'runtime', binding: BINDING,
        appliedEventId: null, why: 'the runtime channel belongs to another incarnation',
      },
    ]);
    await daemon.close();
  }, 15_000);

  test('a staged working holds against the old idle until ingest and activity apply it, then serves', async () => {
    // The real spool, the real ingester and the real activity reconciler, with one gate: after the
    // second event is staged the ingester's next step waits, so the hold between "the source has
    // staged" and "the canonical position applied it" is observable instead of a wall-clock race.
    const clock = new Date('2026-10-20T00:00:00.000Z');
    const stateDir = join(world.root, '.agents');
    const seatId = 'seat_0123456789ab';
    const OLD = '2026-10-20T00:00:00.000Z-aaaaaaaa';
    const NEW = '2026-10-20T00:00:00.000Z-bbbbbbbb';
    writeFileSync(join(stateDir, STATE_FILE), JSON.stringify({
      format: 1,
      sessions: {
        crew: {
          seats: { 'worker-1': { id: seatId, stage: 'ready', presence_binding: BINDING } },
          worktrees: {},
        },
      },
    }));
    const real = createPresenceIngester({ stateDir, session: 'crew', now: () => clock });
    let holdIngest = false;
    let releaseIngest!: () => void;
    const released = new Promise<void>((resolve) => { releaseIngest = resolve; });
    const gated: PresenceIngester = {
      step: async () => {
        if (holdIngest) await released;
        return real.step();
      },
      close: () => real.close(),
      isClosed: () => real.isClosed(),
    };
    let toStage: string | null = OLD;
    let staged: string | null = null;
    let holdAfterStage = false;
    let pumps = 0;
    const source: PresenceSource = {
      seat: 'worker-1',
      step: async () => {
        pumps += 1;
        const next = toStage;
        if (next === null) return;
        const stagedRecord = stagePresenceRecord(stateDir, {
          session: 'crew',
          seat: 'worker-1',
          binding: BINDING,
          source: 'runtime-event',
          event: next === NEW ? 'turn-start' : 'turn-end',
          ts: '2026-10-20T00:00:00.000Z',
          id: next,
        });
        if (stagedRecord.kind !== 'staged') throw new Error(`the event was not staged: ${stagedRecord.why}`);
        toStage = null;
        staged = next;
        if (holdAfterStage) holdIngest = true;
      },
      // The evidence instant is fixed: after the clock jumps eight hours it is old evidence, and
      // the seat must still serve, because event age is not a liveness fact.
      status: (): PresenceSourceStatus => ({
        seat: 'worker-1', binding: BINDING, threadId: 'thread-1', channel: 'connected',
        stream: 'initialized', baseline: 'read', evidenceAt: '2026-10-20T00:00:00.000Z',
        stagedEventId: staged, why: null,
      }),
      close: async () => ({ quiesced: true }),
    };
    const seatOf = () => daemon.health().roots?.[0]?.presence?.seats
      ?.find((seat) => seat.seat === 'worker-1');
    const currentOf = (): Record<string, unknown> => JSON.parse(
      readFileSync(presencePaths(stateDir, 'crew', 'worker-1')!.current, 'utf8'),
    ) as Record<string, unknown>;
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      now: () => clock,
      presenceIngest: () => gated,
      presenceActivity: () => createPresenceActivity({ stateDir, session: 'crew', seats: ['worker-1'] }),
      presenceSubscriptions: (): PresenceSource[] => [source],
    });
    // The old idle event goes through the real pipeline and is proven applied in both places.
    await waitUntil(() => seatOf()?.healthy === true && seatOf()?.appliedEventId === OLD);
    expect(currentOf()).toMatchObject({ id: OLD, state: 'idle', seq: 1 });
    // Now stage a working event while that exact idle projection and fence stand, and hold the
    // next ingest so the un-applied window can be read rather than guessed at.
    holdAfterStage = true;
    toStage = NEW;
    await waitUntil(() => seatOf()?.state === 'pending' && seatOf()?.why !== null);
    expect(seatOf()).toMatchObject({
      state: 'pending', healthy: false, source: 'runtime', binding: BINDING,
      appliedEventId: null,
    });
    // The route's own answer is untouched: only the seat that is ahead of its projection holds.
    expect(daemon.health().roots?.[0]?.presence).toMatchObject({ state: 'serving', healthy: true });
    // The canonical position has not moved: the working event is staged, not applied.
    expect(currentOf()).toMatchObject({ id: OLD, state: 'idle', seq: 1 });
    // Release the real ingester: it projects the staged event and the activity reconciler applies
    // the fence, and only then does the seat serve again, naming the new identity.
    releaseIngest();
    await waitUntil(() => seatOf()?.healthy === true && seatOf()?.appliedEventId === NEW);
    expect(currentOf()).toMatchObject({ id: NEW, state: 'working', seq: 2 });
    const applied = (JSON.parse(readFileSync(join(stateDir, STATE_FILE), 'utf8')) as {
      sessions: { crew: { seats: Record<string, { presence_applied?: Record<string, unknown> }> } };
    }).sessions.crew.seats['worker-1']?.presence_applied;
    expect(applied).toMatchObject({ seat_id: seatId, binding: BINDING, seq: 2 });
    // Eight hours later, with no new event, the seat still serves: there is no event-age expiry.
    const before = pumps;
    clock.setTime(clock.getTime() + 8 * 60 * 60_000);
    await waitUntil(() => pumps >= before + 3);
    expect(seatOf()).toMatchObject({
      state: 'serving', healthy: true, source: 'runtime', appliedEventId: NEW,
    });
    await daemon.close();
  }, 15_000);

  test('sources close before the ingester drain, and a rejected close retains ownership until it drains', async () => {
    const order: string[] = [];
    let reject = true;
    let ingestClosed = 0;
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: () => ({
        step: async () => ingest({ healthy: true }),
        close: async () => {
          ingestClosed += 1;
          order.push('ingest-close');
          return { quiesced: true };
        },
        isClosed: () => false,
      }),
      presenceActivity: () => async () => activityResult(),
      presenceSubscriptions: (): PresenceSource[] => [
        started('worker-1', () => ({
          seat: 'worker-1', binding: '', threadId: '', channel: 'unknown',
          stream: 'uninitialized', baseline: 'pending', evidenceAt: null,
          why: 'the source is not connected',
        }), async () => {
          order.push('source-close');
          if (reject) throw new Error('the source socket is still open');
          return { quiesced: true };
        }),
      ],
    });
    await waitUntil(() => daemon.health().roots?.[0]?.presence?.seats !== undefined);

    await daemon.close();
    // The ingester stays open while a source that may still stage spool is not closed.
    expect(order).toEqual(['source-close']);
    expect(ingestClosed).toBe(0);
    expect(existsSync(daemonLockPath(world.home))).toBe(true);
    const retained = readDaemonState(world.home);
    expect(retained.kind).toBe('ok');
    if (retained.kind === 'ok') {
      expect(retained.state.roots[0]?.presence).toEqual({
        state: 'pending', why: 'the source socket is still open',
      });
    }

    // A later close retries the source; only a resolved drain closes the ingester and releases.
    reject = false;
    await daemon.close();
    expect(order).toEqual(['source-close', 'source-close', 'ingest-close']);
    expect(ingestClosed).toBe(1);
    expect(existsSync(daemonLockPath(world.home))).toBe(false);
  }, 15_000);

  test('a factory that throws holds the route, so no seat inherits the hook answer', async () => {
    const clock = new Date('2026-10-20T00:00:00.000Z');
    writeSeatBindings({ 'worker-1': BINDING });
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      now: () => clock,
      presenceIngest: () => servingIngester(),
      presenceActivity: () => async () => activityResult(),
      presenceSubscriptions: (): PresenceSourceRuntime[] => {
        throw new Error('the target resolver failed');
      },
    });
    await waitUntil(() => daemon.health().roots?.[0]?.presence?.state === 'pending');
    // Ingest is healthy, but the unclassified native attachment holds the route: an expected
    // seat can never hide behind the route's hook answer.
    expect(daemon.health().roots?.[0]?.presence).toMatchObject({
      session: 'crew', state: 'pending', healthy: false,
      why: 'the runtime subscriptions were not built: the target resolver failed',
    });
    // Every declared seat is listed as `unknown`: a failed classification must never let a
    // reader infer that a missing source means the seat is a hook seat.
    const unresolved = 'the runtime subscriptions were not built: the target resolver failed';
    expect(daemon.health().roots?.[0]?.presence?.seats).toEqual([
      {
        seat: 'crew-lead', state: 'pending', healthy: false, source: 'unknown', binding: null,
        appliedEventId: null, why: unresolved,
      },
      {
        seat: 'crew-op', state: 'pending', healthy: false, source: 'unknown', binding: null,
        appliedEventId: null, why: unresolved,
      },
      {
        seat: 'worker-1', state: 'pending', healthy: false, source: 'unknown', binding: BINDING,
        appliedEventId: null, why: unresolved,
      },
    ]);
    await daemon.close();
    expect(existsSync(daemonLockPath(world.home))).toBe(false);
  }, 15_000);

  test('a named adoption failure holds its seat, and an unnamed one holds the route', async () => {
    const clock = new Date('2026-10-20T00:00:00.000Z');
    writeSeatBindings({ 'worker-1': BINDING });
    const named = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      now: () => clock,
      presenceIngest: () => servingIngester(),
      presenceActivity: () => async () => activityResult(),
      // The producer names its seat but offers nothing that can drain the source.
      presenceSubscriptions: (): PresenceSourceRuntime[] => [{
        seat: 'worker-1',
        step: async () => {},
        status: () => ({
          seat: 'worker-1', binding: BINDING, threadId: 'thread-1', channel: 'connected',
          stream: 'initialized', baseline: 'read', evidenceAt: clock.toISOString(), why: null,
        }),
      }],
    });
    await waitUntil(
      () => named.health().roots?.[0]?.presence?.seats
        ?.find((seat) => seat.seat === 'worker-1')?.why === 'the runtime source cannot be closed',
    );
    const namedPresence = named.health().roots?.[0]?.presence;
    expect(namedPresence).toMatchObject({ state: 'serving', healthy: true });
    expect(namedPresence?.seats).toEqual([
      {
        seat: 'crew-lead', state: 'pending', healthy: false, source: 'hook', binding: null,
        appliedEventId: null, why: 'the seat records no presence binding',
      },
      {
        seat: 'crew-op', state: 'pending', healthy: false, source: 'hook', binding: null,
        appliedEventId: null, why: 'the seat records no presence binding',
      },
      {
        seat: 'worker-1', state: 'pending', healthy: false, source: 'runtime', binding: BINDING,
        appliedEventId: null, why: 'the runtime source cannot be closed',
      },
    ]);
    await named.close();

    const unnamed = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      now: () => clock,
      presenceIngest: () => servingIngester(),
      presenceActivity: () => async () => activityResult(),
      presenceSubscriptions: (): PresenceSourceRuntime[] => [{ step: async () => {} }],
    });
    await waitUntil(() => unnamed.health().roots?.[0]?.presence?.state === 'pending');
    expect(unnamed.health().roots?.[0]?.presence).toMatchObject({
      state: 'pending', healthy: false,
      why: 'the runtime subscriptions were not classified: the runtime source has no status reader',
    });
    await unnamed.close();
  }, 20_000);

  test('a hung source pump holds only its own seat, never a sibling or the route', async () => {
    const clock = new Date('2026-10-20T00:00:00.000Z');
    writeSeatBindings({ 'worker-1': BINDING, 'crew-op': 'prs_ffffffffffff' });
    writeCanonical('crew-op', { binding: 'prs_ffffffffffff' });
    let release: (() => void) | null = null;
    let activitySteps = 0;
    let closedHung = false;
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      now: () => clock,
      presenceIngest: () => servingIngester(),
      presenceActivity: () => async () => {
        activitySteps += 1;
        return activityResult();
      },
      presenceSubscriptions: (): PresenceSource[] => [
        {
          seat: 'worker-1',
          step: () => new Promise<void>((resolve) => { release = resolve; }),
          status: () => ({
            seat: 'worker-1', binding: BINDING, threadId: 'thread-1', channel: 'connecting',
            stream: 'uninitialized', baseline: 'pending', evidenceAt: null,
            why: 'the stream is connecting',
          }),
          close: async () => {
            closedHung = true;
            release?.();
            return { quiesced: true };
          },
        },
        started('crew-op', () => ({
          seat: 'crew-op', binding: 'prs_ffffffffffff', threadId: 'thread-2',
          channel: 'connected', stream: 'initialized', baseline: 'read',
          evidenceAt: clock.toISOString(), why: null,
        })),
      ],
    });
    await waitUntil(() => daemon.health().roots?.[0]?.presence?.seats
      ?.find((seat) => seat.seat === 'crew-op')?.healthy === true);
    const presence = daemon.health().roots?.[0]?.presence;
    // The route and the sibling are measured while the first source's step is still pending.
    expect(presence).toMatchObject({ state: 'serving', healthy: true });
    expect(presence?.seats?.find((seat) => seat.seat === 'worker-1')).toEqual({
      seat: 'worker-1', state: 'pending', healthy: false, source: 'runtime', binding: null,
      appliedEventId: null, why: 'the runtime channel has not been sampled yet',
    });
    expect(activitySteps).toBeGreaterThan(0);
    expect(closedHung).toBe(false);

    // Shutdown cancels the hung source; its pump drains before ownership is released.
    await daemon.close();
    expect(closedHung).toBe(true);
    expect(existsSync(daemonLockPath(world.home))).toBe(false);
  }, 20_000);
});
