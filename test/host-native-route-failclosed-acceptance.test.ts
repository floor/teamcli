// Independent acceptance for the daemon host's per-seat native health at 52a2bcf97, and the same
// file unchanged on the fix c806dddb1. Synthetic home and checkout only: the real machine host,
// single-instance lock and socket run over a temporary root, with injected ingester, activity,
// publisher and runtime sources, so no owner session, credential, pane or live runtime is touched.
//
// The scenes hold the actual host to the behavior the consumer depends on:
//   - a factory that throws while building the route's runtime subscriptions (or its unproven
//     resolutions) holds the route: an expected native attachment can never inherit the ingest
//     answer of the route it failed to classify, and `daemon.health()` answers with the complete
//     ordered seat list, every seat pending and `unknown`, never an omitted list;
//   - a source whose step never settles holds only its own seat: the route's activity still runs
//     and a sibling whose transition is really staged, applied and fenced is served while the
//     first pump is in flight, and shutdown cancels the held source so ownership is released;
//   - a named source the host cannot drain is held as explicitly unproven, never sampled as a
//     serving channel and never closing the door on the route's own answer;
//   - a seat's sampled answer carries the current managed binding it was fenced on, so a reader
//     can name the incarnation (the fixed host's seat-health record).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMachineDaemon, type StartMachineDaemonInput } from '../src/daemon/host.ts';
import { daemonLockPath } from '../src/daemon/paths.ts';
import { createPresenceActivity, type PresenceActivityResult } from '../src/daemon/presence/activity.ts';
import type { PresenceSource, PresenceSourceStatus } from '../src/daemon/presence/health.ts';
import type { PresenceIngestResult, PresenceIngester } from '../src/daemon/presence/ingest.ts';
import type { PresencePublishResult } from '../src/daemon/presence/publish.ts';
import { stagePresenceRecord } from '../src/daemon/presence/spool.ts';
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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'b7-host-accept-')));
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

/** The seat ids a launch writes beside each runtime incarnation binding. */
const SEAT_IDS: Record<string, string> = {
  'crew-lead': 'seat_111111111111',
  'crew-op': 'seat_ba9876543210',
  'worker-1': 'seat_0123456789ab',
};

/** The seat bindings the host fences a sample on, written as the machine does. */
function bindSeats(bindings: Record<string, string>): void {
  const seats: Record<string, unknown> = {};
  for (const [seat, binding] of Object.entries(bindings)) {
    const id = SEAT_IDS[seat];
    seats[seat] = {
      stage: 'ready', ...(id === undefined ? {} : { id }), presence_binding: binding,
    };
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

/** A runtime source whose first pump stages one real transition through the spool writer and
 *  whose reading then names that staged identity and its instant. The host's real ingester must
 *  apply it and the real activity must fence it before the seat can serve: a `serving` reading is
 *  a claim about the channel, not proof of application. */
function stagingSource(
  seat: string,
  binding: string,
  transition: { event: 'turn-start' | 'turn-end' | 'human-wait'; ts: string; id: string },
): PresenceSource {
  let staged: string | null = null;
  return {
    seat,
    step: async () => {
      if (staged !== null) return;
      const written = stagePresenceRecord(join(world.root, '.agents'), {
        session: 'crew',
        seat,
        binding,
        source: 'runtime-event',
        event: transition.event,
        ts: transition.ts,
        id: transition.id,
      });
      if (written.kind !== 'staged') throw new Error(`the transition was not staged: ${written.why}`);
      staged = transition.id;
    },
    status: () => ({
      seat,
      binding,
      threadId: `thread-${seat}`,
      channel: 'connected',
      stream: 'initialized',
      baseline: 'read',
      evidenceAt: transition.ts,
      stagedEventId: staged,
      why: null,
    }),
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
    // that expected native; the ingest answer must not be published as the route's health. The
    // complete ordered list is still answered, every seat explicitly pending and `unknown` at the
    // binding its record names: an omitted list is not the contract.
    const hold = 'the runtime subscriptions were not built: the target resolver failed';
    expect(presence).toMatchObject({ state: 'pending', healthy: false });
    expect(presence?.why).toContain(hold);
    expect(presence?.seats).toEqual([
      {
        seat: 'crew-lead', state: 'pending', healthy: false, source: 'unknown',
        binding: null, appliedEventId: null, why: hold,
      },
      {
        seat: 'crew-op', state: 'pending', healthy: false, source: 'unknown',
        binding: null, appliedEventId: null, why: hold,
      },
      {
        seat: 'worker-1', state: 'pending', healthy: false, source: 'unknown',
        binding: BINDING, appliedEventId: null, why: hold,
      },
    ]);
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
    // The already-adopted source is still listed and held, never promoted to a healthy route. The
    // channel answers the sticky classification failure for every seat, so no seat can claim its
    // own verdict; the adopted seat still carries the binding its sample was fenced on.
    const hold = 'the runtime resolutions were not built: the managed-target index was unreadable';
    const adopted = () => presenceOf(daemon)?.seats?.find((seat) => seat.seat === 'worker-1');
    expect(await until(() => adopted()?.binding === BINDING)).toBe(true);
    const presence = presenceOf(daemon);
    expect(presence).toMatchObject({ state: 'pending', healthy: false });
    expect(presence?.why).toContain(hold);
    expect(presence?.seats).toEqual([
      {
        seat: 'crew-lead', state: 'pending', healthy: false, source: 'unknown',
        binding: null, appliedEventId: null, why: hold,
      },
      {
        seat: 'crew-op', state: 'pending', healthy: false, source: 'unknown',
        binding: null, appliedEventId: null, why: hold,
      },
      {
        seat: 'worker-1', state: 'pending', healthy: false, source: 'unknown',
        binding: BINDING, appliedEventId: null, why: hold,
      },
    ]);
    await daemon.close();
  }, 15_000);

  test('a hung source pump holds only its own seat while the sibling and the route keep running', async () => {
    bindSeats({ 'worker-1': BINDING, 'crew-op': OTHER });
    const OP_TS = CLOCK.toISOString();
    const OP_ID = `${OP_TS}-bbbbbbbb`;
    let release: (() => void) | null = null;
    let cancelled = false;
    let activitySteps = 0;
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      now: () => CLOCK,
      // The sibling is proved only through the real pipeline: its staged transition must be
      // applied by the real ingester and fenced by the real activity writer, which is what
      // qualifies a runtime seat now. The route's activity is wrapped only to count its passes.
      presenceActivity: (_route, stateDir) => {
        const real = createPresenceActivity({ stateDir, session: 'crew' });
        return async (at) => { activitySteps += 1; return real(at); };
      },
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
        stagingSource('crew-op', OTHER, { event: 'turn-start', ts: OP_TS, id: OP_ID }),
      ],
    });
    // The sibling must be served while the first source's step is still in flight, and the
    // route's activity must not wait behind the hung pump either. Serving is not the source's own
    // word: the entry names the exact transition the canonical projection applied and fenced.
    const sibling = () => presenceOf(daemon)?.seats?.find((seat) => seat.seat === 'crew-op');
    const sawSibling = await until(() => sibling()?.healthy === true, 1500);
    expect(sawSibling).toBe(true);
    expect(sibling() as unknown as Record<string, unknown>).toEqual({
      seat: 'crew-op', state: 'serving', healthy: true, source: 'runtime',
      binding: OTHER, appliedEventId: OP_ID, why: null,
    });
    const presence = presenceOf(daemon);
    expect(presence).toMatchObject({ state: 'serving', healthy: true });
    expect(activitySteps).toBeGreaterThan(0);
    expect(cancelled).toBe(false);
    expect(release).not.toBeNull();
    // The held seat itself is honestly unsampled, never served by its last word: its pump never
    // settled, so it staged no event and was never fenced on the current binding.
    expect(presence?.seats?.find((seat) => seat.seat === 'worker-1') as unknown as Record<string, unknown>).toEqual({
      seat: 'worker-1', state: 'pending', healthy: false, source: 'runtime',
      binding: null, appliedEventId: null, why: 'the runtime channel has not been sampled yet',
    });

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
    // The complete ordered list names every declared seat, so the unproven seat is found by its
    // name: the route's hook seats are listed too, and the array index is not the seat's identity.
    const unproven = () => presenceOf(daemon)?.seats?.find((seat) => seat.seat === 'worker-1');
    expect(await until(() => unproven() !== undefined)).toBe(true);
    // Let several 10 ms passes sample the registered source.
    expect(await until(() => unproven()?.why === 'the runtime source cannot be closed')).toBe(true);
    const presence = presenceOf(daemon);
    expect(presence).toMatchObject({ state: 'serving', healthy: true });
    expect(presence?.seats?.map((seat) => seat.seat)).toEqual(['crew-lead', 'crew-op', 'worker-1']);
    expect(unproven() as unknown as Record<string, unknown>).toEqual({
      seat: 'worker-1', state: 'pending', healthy: false, source: 'runtime', binding: BINDING,
      appliedEventId: null, why: 'the runtime source cannot be closed',
    });
    await daemon.close();
  }, 15_000);
});
