// Independent acceptance for the daemon host's per-seat native health at 52a2bcf97, and the same
// file unchanged on the fix c806dddb1. Synthetic home and checkout only: the real machine host,
// single-instance lock and socket run over a temporary root, with injected ingester, activity,
// publisher and runtime sources, so no owner session, credential, pane or live runtime is touched.
//
// The scenes hold the actual host to the behavior the consumer depends on:
//   - a factory that throws while building the route's runtime subscriptions (or its unproven
//     resolutions) holds the route: an expected native attachment can never inherit the ingest
//     answer of the route it failed to classify, and the hold is visible in `daemon.health()`;
//   - a source whose step never settles holds only its own seat: the route's activity still runs
//     and a healthy sibling is still sampled and served while the first pump is in flight, and
//     shutdown cancels the held source so ownership is released;
//   - a named source the host cannot drain is held as explicitly unproven, never sampled as a
//     serving channel and never closing the door on the route's own answer;
//   - a seat's sampled answer carries the current managed binding it was fenced on, so a reader
//     can name the incarnation (the fixed host's seat-health record).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMachineDaemon, type StartMachineDaemonInput } from '../src/daemon/host.ts';
import { daemonLockPath } from '../src/daemon/paths.ts';
import type { PresenceActivityResult } from '../src/daemon/presence/activity.ts';
import type { PresenceSource, PresenceSourceStatus } from '../src/daemon/presence/health.ts';
import type { PresenceIngestResult, PresenceIngester } from '../src/daemon/presence/ingest.ts';
import type { PresencePublishResult } from '../src/daemon/presence/publish.ts';
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

const BINDING = 'prs_0123456789ab';
const OTHER = 'prs_ffffffffffff';
const CLOCK = new Date('2026-10-20T00:00:00.000Z');

function servingIngest(): PresenceIngestResult {
  return {
    ingested: [], rejected: [], stale: [], repaired: [], errors: [],
    healthy: true, pending: false, closed: false,
  };
}

function activityResult(): PresenceActivityResult {
  return { seats: [], failed: null };
}

function publishResult(): PresencePublishResult {
  return { seats: [], failed: null };
}

const serving = (seat: string, binding: string, evidenceAt: string): PresenceSourceStatus => ({
  seat, binding, threadId: `thread-${seat}`, channel: 'connected', stream: 'initialized',
  baseline: 'read', evidenceAt, why: null,
});

type Scratch = { base: string; root: string; home: string };

let world: Scratch;
let cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  const base = realpathSync(mkdtempSync('/private/tmp/b7-host-accept-'));
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), CREW);
  world = { base, root, home };
});

afterEach(async () => {
  for (const clean of cleanups.reverse()) {
    try { await clean(); } catch { /* one failed cleanup must not hide another */ }
  }
  cleanups = [];
  rmSync(world.base, { recursive: true, force: true });
});

/** The seat bindings the host fences a sample on, written as the machine does. */
function bindSeats(bindings: Record<string, string>): void {
  const seats: Record<string, unknown> = {};
  for (const [seat, binding] of Object.entries(bindings)) {
    seats[seat] = { stage: 'ready', presence_binding: binding };
  }
  writeFileSync(join(world.root, '.agents', STATE_FILE), JSON.stringify({
    format: 1,
    sessions: { crew: { seats, worktrees: {} } },
  }));
}

async function start(overrides: Partial<StartMachineDaemonInput>) {
  const started = await startMachineDaemon({
    home: world.home,
    roots: [world.root],
    startedBy: 'service-manager',
    version: '0.5.3-host-native-acceptance',
    heartbeatMs: 20,
    ...overrides,
  });
  if (started.kind !== 'serving') throw new Error(`the daemon did not start: ${started.kind}`);
  cleanups.push(async () => {
    try { await started.daemon.close(); } catch { /* the scene may already have closed it */ }
  });
  return started.daemon;
}

async function until(check: () => boolean, ms = 1500): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const presenceOf = (daemon: Awaited<ReturnType<typeof start>>) =>
  daemon.health().roots?.[0]?.presence;

/** A source whose step settles immediately and whose reading is the given one. */
function healthySource(seat: string, binding: string): PresenceSource {
  return {
    seat,
    step: async () => {},
    status: () => serving(seat, binding, CLOCK.toISOString()),
    close: async () => ({ quiesced: true }),
  };
}

const baseInput = {
  presenceHosting: true,
  presenceEveryMs: 10,
  now: () => CLOCK,
  presenceIngest: (): PresenceIngester => ({
    step: async () => servingIngest(),
    close: async () => ({ quiesced: true }),
    isClosed: () => false,
  }),
  presenceActivity: () => async () => activityResult(),
  presencePublish: () => async () => publishResult(),
};

describe('the host holds unresolved native routes and never starves a sibling', () => {
  test('a throwing subscriptions factory holds the route instead of lending it hook health', async () => {
    bindSeats({ 'worker-1': BINDING });
    let passes = 0;
    const daemon = await start({
      ...baseInput,
      presenceActivity: () => async () => { passes += 1; return activityResult(); },
      presenceSubscriptions: () => {
        throw new Error('the target resolver failed');
      },
    });
    // The pass itself still runs: the assertion is about the answer, not about a stalled loop.
    expect(await until(() => passes > 0)).toBe(true);
    const presence = presenceOf(daemon);
    // Nothing classified this route's native attachments, so no seat can be told apart from one
    // that expected native; the ingest answer must not be published as the route's health.
    expect(presence).toMatchObject({ state: 'pending', healthy: false });
    expect(presence?.why).toContain('the runtime subscriptions were not built: the target resolver failed');
    expect(presence?.seats).toBeUndefined();
    await daemon.close();
  }, 15_000);

  test('a throwing unproven-resolution factory holds the route too', async () => {
    bindSeats({ 'worker-1': BINDING });
    let passes = 0;
    const daemon = await start({
      ...baseInput,
      presenceActivity: () => async () => { passes += 1; return activityResult(); },
      presenceSubscriptions: () => [healthySource('worker-1', BINDING)],
      presenceUnproven: () => {
        throw new Error('the managed-target index was unreadable');
      },
    });
    expect(await until(() => passes > 0)).toBe(true);
    const presence = presenceOf(daemon);
    expect(presence).toMatchObject({ state: 'pending', healthy: false });
    expect(presence?.why).toContain('the runtime resolutions were not built: the managed-target index was unreadable');
    // The already-adopted source is still listed and held, not promoted to a healthy route.
    expect(presence?.seats?.every((seat) => seat.healthy === false)).toBe(true);
    await daemon.close();
  }, 15_000);

  test('a hung source pump holds only its own seat while the sibling and the route keep running', async () => {
    bindSeats({ 'worker-1': BINDING, 'crew-op': OTHER });
    let release: (() => void) | null = null;
    let cancelled = false;
    let activitySteps = 0;
    const daemon = await start({
      ...baseInput,
      presenceActivity: () => async () => { activitySteps += 1; return activityResult(); },
      presenceSubscriptions: () => [
        {
          seat: 'worker-1',
          step: () => new Promise<void>((resolve) => { release = resolve; }),
          status: () => serving('worker-1', BINDING, CLOCK.toISOString()),
          close: async () => {
            cancelled = true;
            release?.();
            return { quiesced: true };
          },
        },
        healthySource('crew-op', OTHER),
      ],
    });
    // The sibling must be served while the first source's step is still in flight, and the
    // route's activity must not wait behind the hung pump either.
    const sawSibling = await until(() => presenceOf(daemon)?.seats?.[1]?.healthy === true, 800);
    expect(sawSibling).toBe(true);
    const presence = presenceOf(daemon);
    expect(presence).toMatchObject({ state: 'serving', healthy: true });
    expect(activitySteps).toBeGreaterThan(0);
    expect(cancelled).toBe(false);
    expect(release).not.toBeNull();
    // The sampled answer carries the managed binding it was fenced on (the fixed host's field);
    // the cast keeps this one assertion compiling against the base shape too.
    expect(presence?.seats?.[1] as unknown as Record<string, unknown>).toEqual({
      seat: 'crew-op', state: 'serving', healthy: true, binding: OTHER, why: null,
    });
    // The held seat itself is honestly unsampled, never served by its last word.
    expect(presence?.seats?.[0]).toMatchObject({ seat: 'worker-1', state: 'pending', healthy: false });

    await daemon.close();
    expect(cancelled).toBe(true);
    expect(existsSync(daemonLockPath(world.home))).toBe(false);
  }, 15_000);

  test('a named source that cannot be drained is explicitly unproven, never a serving seat', async () => {
    bindSeats({ 'worker-1': BINDING });
    // A producer source the host can read but cannot close: named, so the failure belongs to its
    // seat. (The cast keeps this file at the base shape while the fixed host adopts the aliases.)
    const undrainable = {
      seat: 'worker-1',
      step: async () => {},
      status: () => serving('worker-1', BINDING, CLOCK.toISOString()),
    } as unknown as PresenceSource;
    const daemon = await start({
      ...baseInput,
      presenceSubscriptions: () => [undrainable],
    });
    expect(await until(() => presenceOf(daemon)?.seats?.[0] !== undefined)).toBe(true);
    // Let several 10 ms passes sample the registered source.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const presence = presenceOf(daemon);
    expect(presence).toMatchObject({ state: 'serving', healthy: true });
    expect(presence?.seats?.[0] as unknown as Record<string, unknown>).toEqual({
      seat: 'worker-1', state: 'pending', healthy: false, binding: BINDING,
      why: 'the runtime source cannot be closed',
    });
    await daemon.close();
  }, 15_000);
});
