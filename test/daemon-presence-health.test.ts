// The daemon's channel-health answer and the seam that carries it to the watch's dispatcher.
// The scenes use a fixed clock: health is a liveness fact, never a wall-clock sleep.
import { describe, expect, test } from 'bun:test';
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import { hostedWatchSources } from '../src/daemon/watch-run.ts';
import {
  PRESENCE_HEALTH_GRACE_MS, adoptPresenceSource, createPresenceChannelHealth, presenceStepHealth,
  reconcilePresenceProof, reconciledProofHolds, unprovenSource,
  type PresenceCanonicalPosition, type PresenceReconciledProof, type PresenceSourceStatus,
} from '../src/daemon/presence/health.ts';
import { presenceId } from '../src/daemon/presence/contract.ts';
import { createPresenceIngester } from '../src/daemon/presence/ingest.ts';
import { presencePaths, stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import type { HostedRoute } from '../src/daemon/routes.ts';
import { STATE_FILE } from '../src/state.ts';
import type { HostedLoop } from '../src/watch/hosted.ts';

const START = new Date('2026-10-20T00:00:00.000Z');
const after = (ms: number): Date => new Date(START.getTime() + ms);

describe('the channel health answer', () => {
  test('unknown until a step finishes, then healthy only inside the grace window', () => {
    const health = createPresenceChannelHealth();
    expect(health.healthy(START)).toBe(false);
    health.stepped(true, START);
    expect(health.healthy(START)).toBe(true);
    expect(health.healthy(after(PRESENCE_HEALTH_GRACE_MS))).toBe(true);
    expect(health.healthy(after(PRESENCE_HEALTH_GRACE_MS + 1))).toBe(false);
  });

  test('a failed step is unhealthy at once, and only the next success renews it', () => {
    const health = createPresenceChannelHealth();
    health.stepped(true, START);
    health.stepped(false, after(100));
    expect(health.healthy(after(100))).toBe(false);
    health.stepped(true, after(200));
    expect(health.healthy(after(200))).toBe(true);
  });

  test('each success renews the window', () => {
    const health = createPresenceChannelHealth();
    health.stepped(true, START);
    health.stepped(true, after(PRESENCE_HEALTH_GRACE_MS));
    expect(health.healthy(after(PRESENCE_HEALTH_GRACE_MS * 2))).toBe(true);
    expect(health.healthy(after(PRESENCE_HEALTH_GRACE_MS * 2 + 1))).toBe(false);
  });

  test('a pass stamped in the future is not evidence of health', () => {
    const health = createPresenceChannelHealth();
    health.stepped(true, after(PRESENCE_HEALTH_GRACE_MS));
    expect(health.healthy(START)).toBe(false);
  });

  test('the display reason names the false answer without ever changing it', () => {
    const health = createPresenceChannelHealth();
    expect(health.reason(START)).toBe('the presence channel did not answer healthy');
    health.stepped(false, START, 'the presence log is faulted');
    expect(health.healthy(START)).toBe(false);
    expect(health.reason(START)).toBe('the presence log is faulted');
    health.stepped(false, after(10));
    expect(health.reason(after(10))).toBe('the presence channel did not answer healthy');
    health.stepped(true, after(20));
    expect(health.healthy(after(20))).toBe(true);
    expect(health.reason(after(20))).toBeNull();
    // The grace boundary is inclusive, so one millisecond past it is the gap.
    expect(health.reason(after(PRESENCE_HEALTH_GRACE_MS + 21))).toBe(
      'no presence step finished inside the liveness window',
    );
  });
});

describe('a step is not healthy just because it finished', () => {
  test('only the ingester\'s own healthy answer with no known backlog counts', () => {
    expect(presenceStepHealth({ healthy: true, pending: false })).toBe(true);
  });

  test('a faulted or unconvincing answer is not healthy, even with no reported errors', () => {
    expect(presenceStepHealth({ pending: false })).toBe(false);
    expect(presenceStepHealth({ healthy: false, pending: false })).toBe(false);
    expect(presenceStepHealth({ healthy: 'yes', pending: false })).toBe(false);
    expect(presenceStepHealth({})).toBe(false);
  });

  test('a known backlog pending holds the channel unhealthy until it catches up', () => {
    expect(presenceStepHealth({ healthy: true, pending: true })).toBe(false);
    expect(presenceStepHealth({ healthy: true })).toBe(false);
  });

  test('a step that throws records no success', () => {
    const health = createPresenceChannelHealth();
    health.stepped(true, START);
    expect(health.healthy(START)).toBe(true);
    // The host passes the typed answer, which a throwing step never produces.
    health.stepped(presenceStepHealth({}), after(10));
    expect(health.healthy(after(10))).toBe(false);
  });
});

// A runtime source answers for one seat's channel only. Its continuity is fenced on the seat's
// current managed binding, tagged with the daemon epoch that sampled it, and renewed by the live
// read this pass — never by an event's age, so a quiet channel stays serving.
describe('the per-seat runtime answer', () => {
  const SEAT = 'worker-1';
  const BINDING = 'prs_0123456789ab';
  const reading = (over: Partial<PresenceSourceStatus> = {}): PresenceSourceStatus => ({
    seat: SEAT, binding: BINDING, threadId: 'thread-1', channel: 'connected',
    stream: 'initialized', baseline: 'read', evidenceAt: START.toISOString(), why: null, ...over,
  });

  test('an expected seat is not served before its first sample, and a current sample serves it', () => {
    const health = createPresenceChannelHealth(PRESENCE_HEALTH_GRACE_MS, 'epoch-a');
    health.stepped(true, START);
    health.seatExpected(SEAT);
    expect(health.seatHealthy(SEAT, START)).toBe(false);
    expect(health.seatReason(SEAT, START)).toBe('the runtime channel has not been sampled yet');
    health.seatObserved({ source: reading(), currentBinding: BINDING, epoch: 'epoch-a' }, START);
    expect(health.seatHealthy(SEAT, START)).toBe(true);
    expect(health.seatReason(SEAT, START)).toBeNull();
  });

  test('a seat with no source keeps the route answer, and one non-serving source never touches a sibling', () => {
    const health = createPresenceChannelHealth(PRESENCE_HEALTH_GRACE_MS, 'epoch-a');
    health.stepped(true, START);
    expect(health.seatHealthy('crew-op', START)).toBe(true);
    health.seatObserved({
      source: reading({ channel: 'unknown', why: 'no measured delivery yet' }),
      currentBinding: BINDING,
      epoch: 'epoch-a',
    }, START);
    expect(health.seatHealthy('crew-op', START)).toBe(true);
    expect(health.seatHealthy(SEAT, START)).toBe(false);
    expect(health.seatReason(SEAT, START)).toBe('no measured delivery yet');
  });

  test('a quiet channel does not age out: old measured evidence still serves a connected channel', () => {
    const health = createPresenceChannelHealth(PRESENCE_HEALTH_GRACE_MS, 'epoch-a');
    health.stepped(true, START);
    const old = new Date(START.getTime() - 6 * 60 * 60_000).toISOString();
    health.seatObserved({ source: reading({ evidenceAt: old }), currentBinding: BINDING, epoch: 'epoch-a' }, START);
    expect(health.seatHealthy(SEAT, START)).toBe(true);
  });

  test('a sample older than the shared grace is not current, even with no failure since', () => {
    const late = after(PRESENCE_HEALTH_GRACE_MS + 1);
    const health = createPresenceChannelHealth(PRESENCE_HEALTH_GRACE_MS, 'epoch-a');
    health.stepped(true, late);
    health.seatObserved({ source: reading(), currentBinding: BINDING, epoch: 'epoch-a' }, START);
    expect(health.seatHealthy(SEAT, late)).toBe(false);
    expect(health.seatReason(SEAT, late)).toBe(
      'no runtime-channel answer from the seat inside the liveness window',
    );
  });

  test('an initialized stream over a read baseline is required, and evidence must be measured', () => {
    const health = createPresenceChannelHealth(PRESENCE_HEALTH_GRACE_MS, 'epoch-a');
    health.stepped(true, START);
    health.seatObserved({
      source: reading({ stream: 'uninitialized' }), currentBinding: BINDING, epoch: 'epoch-a',
    }, START);
    expect(health.seatReason(SEAT, START)).toBe('the runtime stream is not initialized');
    health.seatObserved({
      source: reading({ baseline: 'pending' }), currentBinding: BINDING, epoch: 'epoch-a',
    }, START);
    expect(health.seatReason(SEAT, START)).toBe('the bound thread baseline is not read');
    health.seatObserved({
      source: reading({ evidenceAt: null }), currentBinding: BINDING, epoch: 'epoch-a',
    }, START);
    expect(health.seatHealthy(SEAT, START)).toBe(false);
    expect(health.seatReason(SEAT, START)).toBe(
      'the runtime channel has no measured bound-thread evidence',
    );
  });

  test('binding, daemon epoch and the source state are fences, not decoration', () => {
    const health = createPresenceChannelHealth(PRESENCE_HEALTH_GRACE_MS, 'epoch-a');
    health.stepped(true, START);
    health.seatObserved({ source: reading(), currentBinding: 'prs_ffffffffffff', epoch: 'epoch-a' }, START);
    expect(health.seatHealthy(SEAT, START)).toBe(false);
    expect(health.seatReason(SEAT, START)).toBe('the runtime channel belongs to another incarnation');

    health.seatObserved({ source: reading(), currentBinding: BINDING, epoch: 'epoch-b' }, START);
    expect(health.seatHealthy(SEAT, START)).toBe(false);
    expect(health.seatReason(SEAT, START)).toBe('the runtime channel answer is from another daemon epoch');

    health.seatObserved({
      source: reading({ channel: 'stopped', why: 'the socket closed' }),
      currentBinding: BINDING,
      epoch: 'epoch-a',
    }, START);
    expect(health.seatHealthy(SEAT, START)).toBe(false);
    expect(health.seatReason(SEAT, START)).toBe('the socket closed');
  });

  test('gone never renders continuity: its non-idle verdict is the projection\'s', () => {
    const health = createPresenceChannelHealth(PRESENCE_HEALTH_GRACE_MS, 'epoch-a');
    health.stepped(true, START);
    health.seatObserved({
      source: reading({ channel: 'gone' }), currentBinding: BINDING, epoch: 'epoch-a',
    }, START);
    expect(health.seatHealthy(SEAT, START)).toBe(false);
    expect(health.seatReason(SEAT, START)).toBe('the runtime reports the session ended');
  });

  test('an unresolved route holds every seat, sampled or not', () => {
    const health = createPresenceChannelHealth(PRESENCE_HEALTH_GRACE_MS, 'epoch-a');
    health.stepped(true, START);
    health.seatExpected(SEAT);
    health.seatObserved({ source: reading(), currentBinding: BINDING, epoch: 'epoch-a' }, START);
    expect(health.seatHealthy(SEAT, START)).toBe(true);
    health.unresolved('the runtime subscriptions were not built: the resolver failed');
    // The route is the first thing a seat inherits, so holding it holds every seat.
    expect(health.healthy(START)).toBe(false);
    expect(health.reason(START)).toBe(
      'the runtime subscriptions were not built: the resolver failed',
    );
    expect(health.seatHealthy(SEAT, START)).toBe(false);
    expect(health.seatHealthy('crew-op', START)).toBe(false);
    expect(health.seatReason('crew-op', START)).toBe(
      'the runtime subscriptions were not built: the resolver failed',
    );
  });

  test('the sampled binding is kept beside the answer so a reader can fence it', () => {
    const health = createPresenceChannelHealth(PRESENCE_HEALTH_GRACE_MS, 'epoch-a');
    health.stepped(true, START);
    expect(health.seatBinding(SEAT)).toBeNull();
    health.seatObserved({ source: reading(), currentBinding: BINDING, epoch: 'epoch-a' }, START);
    expect(health.seatBinding(SEAT)).toBe(BINDING);
    // A seat record that no longer names a binding can never be fenced, and the sample says so.
    health.seatObserved({
      source: reading({ binding: 'prs_999999999999' }),
      currentBinding: null,
      epoch: 'epoch-a',
    }, START);
    expect(health.seatBinding(SEAT)).toBeNull();
    expect(health.seatReason(SEAT, START)).toBe('the runtime channel belongs to another incarnation');
  });

  test('a refused attachment is registered as an explicit unproven source that closes cleanly', async () => {
    const source = unprovenSource(SEAT, 'the managed thread could not be resolved');
    await source.step(START);
    expect(source.status(START)).toEqual({
      seat: SEAT, binding: '', threadId: '', channel: 'unknown',
      stream: 'uninitialized', baseline: 'pending', evidenceAt: null,
      why: 'the managed thread could not be resolved',
    });
    expect(await source.close()).toEqual({ quiesced: true });
  });
});

// The reconciliation race: ingest runs first and the activity reconciler after, so a source can
// already have staged an event while the canonical projection still carries the older word. A
// proof exists only when the newest staged identity is the projection's and the applied fence
// names the same seat record, incarnation and sequence. The proof is then re-checked against a
// fresh source reading at every use, so a newer stage holds at once.
describe('reconciling a staged runtime event', () => {
  const SEAT = 'worker-1';
  const BINDING = 'prs_0123456789ab';
  const SEAT_ID = 'seat_0123456789ab';
  const EVENT = '2026-10-20T00:00:00.000Z-aaaaaaaa';
  const OLD = '2026-10-19T23:00:00.000Z-bbbbbbbb';
  const reading = (over: Partial<PresenceSourceStatus> = {}): PresenceSourceStatus => ({
    seat: SEAT, binding: BINDING, threadId: 'thread-1', channel: 'connected',
    stream: 'initialized', baseline: 'read', evidenceAt: START.toISOString(),
    stagedEventId: EVENT, why: null, ...over,
  });
  const canonical = (over: Partial<PresenceCanonicalPosition> = {}): PresenceCanonicalPosition => ({
    id: EVENT, binding: BINDING, seq: 7, seatId: SEAT_ID,
    fence: { seat_id: SEAT_ID, binding: BINDING, seq: 7 }, ...over,
  });
  const proof = (over: Partial<PresenceReconciledProof> = {}): PresenceReconciledProof => ({
    id: EVENT, binding: BINDING, epoch: 'epoch-a', ...over,
  });
  const reconcile = (
    source: PresenceSourceStatus,
    position: PresenceCanonicalPosition | null,
    canonicalWhy: string | null = null,
    currentBinding: string | null = BINDING,
  ) => reconcilePresenceProof({ source, canonical: position, canonicalWhy, currentBinding, at: START });

  test('exactly one staged identity applied in the projection and the fence is a proof', () => {
    expect(reconcile(reading(), canonical())).toEqual({
      ok: true, proof: { id: EVENT, binding: BINDING },
    });
  });

  test('an old projection, the same identity staged after it, holds and never serves', () => {
    expect(reconcile(reading(), canonical({ id: OLD }))).toEqual({
      ok: false, why: 'the canonical projection has not applied the runtime event',
    });
  });

  test('a source that staged nothing, or a seat with no projection, names what is missing', () => {
    expect(reconcile(reading({ stagedEventId: null }), canonical())).toEqual({
      ok: false, why: 'the runtime source has staged no event yet',
    });
    expect(reconcile(reading(), null, 'the seat has no canonical presence projection yet')).toEqual({
      ok: false, why: 'the seat has no canonical presence projection yet',
    });
  });

  test('the projection must belong to the current incarnation before its word is trusted', () => {
    expect(reconcile(reading(), canonical(), null, 'prs_ffffffffffff')).toEqual({
      ok: false, why: 'the canonical projection belongs to another incarnation',
    });
    expect(reconcile(reading(), canonical(), null, null)).toEqual({
      ok: false, why: 'the seat records no current presence binding',
    });
  });

  test('a half-applied position is refused: the projection alone is not the fence', () => {
    expect(reconcile(reading(), canonical({ fence: null }))).toEqual({
      ok: false, why: 'the seat records no applied presence fence',
    });
    expect(reconcile(reading(), canonical({
      fence: { seat_id: 'seat_ffffffffffff', binding: BINDING, seq: 7 },
    }))).toEqual({ ok: false, why: 'the applied fence names another seat record' });
    expect(reconcile(reading(), canonical({
      fence: { seat_id: SEAT_ID, binding: 'prs_ffffffffffff', seq: 7 },
    }))).toEqual({ ok: false, why: 'the applied fence belongs to another incarnation' });
    expect(reconcile(reading(), canonical({
      fence: { seat_id: SEAT_ID, binding: BINDING, seq: 6 },
    }))).toEqual({ ok: false, why: 'the applied fence has not reached the canonical projection' });
  });

  test('a channel that is not continuous cannot prove application, even with the identity', () => {
    expect(reconcile(reading({ channel: 'unknown', why: 'no measured delivery yet' }), canonical())).toEqual({
      ok: false, why: 'no measured delivery yet',
    });
  });

  test('a cached proof is re-checked against the fresh reading, not against its own age', () => {
    // A quiet duplicate live state keeps the same staged identity and therefore qualifies, with
    // no event-age window: eight hours later the same reading still proves application.
    expect(reconciledProofHolds({
      proof: proof(), source: reading(), currentBinding: BINDING, epoch: 'epoch-a', at: after(8 * 60 * 60_000),
    })).toEqual({ qualified: true, why: null });
    expect(reconciledProofHolds({
      proof: undefined, source: reading(), currentBinding: BINDING, epoch: 'epoch-a', at: START,
    })).toEqual({ qualified: false, why: 'the runtime event has not been reconciled' });
  });

  test('a newer stage invalidates the proof immediately, before the next pass could reconcile it', () => {
    expect(reconciledProofHolds({
      proof: proof(), source: reading({ stagedEventId: '2026-10-20T00:01:00.000Z-cccccccc' }),
      currentBinding: BINDING, epoch: 'epoch-a', at: after(60_000),
    })).toEqual({
      qualified: false,
      why: 'the runtime staged an event the canonical projection has not applied',
    });
  });

  test('epoch, incarnation and continuity are fences on the cached proof too', () => {
    const holds = (over: Partial<{
      proof: PresenceReconciledProof; source: PresenceSourceStatus;
      currentBinding: string | null; epoch: string;
    }> = {}) => reconciledProofHolds({
      proof: proof(), source: reading(), currentBinding: BINDING, epoch: 'epoch-a', at: START, ...over,
    });
    expect(holds({ epoch: 'epoch-b' })).toEqual({
      qualified: false, why: 'the reconciled proof is from another daemon epoch',
    });
    expect(holds({ currentBinding: null })).toEqual({
      qualified: false, why: 'the runtime channel belongs to another incarnation',
    });
    expect(holds({ source: reading({ channel: 'stopped', why: 'the socket closed' }) })).toEqual({
      qualified: false, why: 'the socket closed',
    });
    expect(holds({ source: reading({ stagedEventId: null }) })).toEqual({
      qualified: false, why: 'the runtime source has staged no event yet',
    });
  });
});

describe('the unresolved route reason', () => {
  test('is null while classification succeeded and names the failure once it did not', () => {
    const health = createPresenceChannelHealth(PRESENCE_HEALTH_GRACE_MS, 'epoch-a');
    expect(health.unresolvedWhy()).toBeNull();
    health.unresolved('the runtime subscriptions were not built: the resolver failed');
    expect(health.unresolvedWhy()).toBe('the runtime subscriptions were not built: the resolver failed');
  });
});

// The producer's final source shape is adopted once, at registration: its seat may be named on
// the source or only on its status reading, and its alias spellings are the adapter's own.
describe('adopting a producer source', () => {
  const SEAT = 'worker-1';
  const STATUS: PresenceSourceStatus = {
    seat: SEAT, binding: 'prs_0123456789ab', threadId: 'thread-1', channel: 'connecting',
    stream: 'uninitialized', baseline: 'pending', evidenceAt: null, why: 'the stream is connecting',
  };

  test('the seat may live on the status reading, and state/cancel are accepted aliases', async () => {
    const adopted = adoptPresenceSource({
      step: async () => {},
      state: () => STATUS,
      cancel: async () => ({ quiesced: true }),
    }, START);
    if (!('source' in adopted)) throw new Error(adopted.why);
    expect(adopted.source.seat).toBe(SEAT);
    expect(adopted.source.status(START)).toEqual(STATUS);
    expect(await adopted.source.close()).toEqual({ quiesced: true });
  });

  test('an unnamed, unreadable or unclosable source is not adopted', () => {
    expect(adoptPresenceSource({
      step: async () => {},
      status: () => ({ ...STATUS, seat: '' }),
    }, START)).toEqual({ seat: null, why: 'the runtime source does not name its seat' });
    expect(adoptPresenceSource({ seat: SEAT, step: async () => {} }, START)).toEqual({
      seat: SEAT, why: 'the runtime source has no status reader',
    });
    expect(adoptPresenceSource({
      seat: SEAT, step: async () => {}, status: () => STATUS,
    }, START)).toEqual({ seat: SEAT, why: 'the runtime source cannot be closed' });
    expect(adoptPresenceSource({
      seat: 'crew-op',
      step: async () => {},
      status: () => STATUS,
      close: async () => ({ quiesced: true }),
    }, START)).toEqual({ seat: 'crew-op', why: 'the runtime source answered for another seat' });
  });
});

describe('the owned source seam', () => {
  test('the hosted source carries the daemon provider by reference', () => {
    const route: HostedRoute = { root: '/tmp/route', team: 'acme', session: 'crew', seats: [] };
    const loop: HostedLoop = {
      signal: new AbortController().signal,
      wait: async () => true,
      cycled: () => {},
      standby: () => {},
    };
    const provider = (): boolean => true;
    const sources = hostedWatchSources(
      route, loop, {} as WatchSources, undefined, undefined, provider,
    );
    expect(sources.presenceChannelHealthy).toBe(provider);
  });

  test('a hosted source without a provider answers nothing, so a projection is held', () => {
    const route: HostedRoute = { root: '/tmp/route', team: 'acme', session: 'crew', seats: [] };
    const loop: HostedLoop = {
      signal: new AbortController().signal,
      wait: async () => true,
      cycled: () => {},
      standby: () => {},
    };
    const sources = hostedWatchSources(route, loop, {} as WatchSources);
    expect(sources.presenceChannelHealthy).toBeUndefined();
  });
});

// The seam above, fed by the real ingester rather than a stub: a synthetic spool on disk, the
// producer's own step, and its typed verdict carried by reference to the hosted source. No live
// CLI home, pane or socket is touched.
const SCENE_SESSION = 'crew';
const SCENE_SEAT = 'worker-1';
const SCENE_BINDING = 'prs_0123456789ab';

type SceneWorld = { base: string; stateDir: string; log: string };

function sceneWorld(): SceneWorld {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-presence-health-')));
  const stateDir = join(base, '.agents');
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, STATE_FILE), JSON.stringify({
    format: 1,
    sessions: {
      [SCENE_SESSION]: {
        seats: { [SCENE_SEAT]: { stage: 'ready', presence_binding: SCENE_BINDING } },
        worktrees: {},
      },
    },
  }));
  const paths = presencePaths(stateDir, SCENE_SESSION, SCENE_SEAT);
  if (paths === null) throw new Error('the scene seat cannot name a presence folder');
  return { base, stateDir, log: paths.log };
}

function sceneStage(world: SceneWorld, event: 'turn-start' | 'turn-end', secondsAgo: number): void {
  const ts = new Date(Date.now() - secondsAgo * 1000).toISOString();
  const id = presenceId(ts, event === 'turn-start' ? 'a1b2c3d4' : 'b2c3d4e5');
  if (id === null) throw new Error('the scene supplied an invalid event instant');
  const staged = stagePresenceRecord(world.stateDir, {
    session: SCENE_SESSION,
    seat: SCENE_SEAT,
    binding: SCENE_BINDING,
    source: 'runtime-hook',
    event,
    ts,
    id,
  });
  if (staged.kind !== 'staged') throw new Error(staged.why);
}

const sceneRoute = (): HostedRoute => ({ root: '/tmp/route', team: 'acme', session: 'crew', seats: [] });
const sceneLoop = (): HostedLoop => ({
  signal: new AbortController().signal,
  wait: async () => true,
  cycled: () => {},
  standby: () => {},
});

describe('the actual producer through the owned health seam', () => {
  test('a valid caught-up turn becomes healthy, with no stub anywhere in the path', async () => {
    const world = sceneWorld();
    const ingester = createPresenceIngester({ stateDir: world.stateDir, session: SCENE_SESSION });
    try {
      sceneStage(world, 'turn-start', 5);
      const step = await ingester.step();
      expect(step.errors).toEqual([]);
      expect(step.healthy).toBe(true);

      const nowAt = new Date();
      const channel = createPresenceChannelHealth();
      channel.stepped(presenceStepHealth(step), nowAt);
      const provider = (): boolean => channel.healthy(nowAt);
      const sources = hostedWatchSources(
        sceneRoute(), sceneLoop(), {} as WatchSources, undefined, undefined, provider,
      );
      // This is the exact answer the watch dispatch reads into IdleDispatchInput.
      expect(sources.presenceChannelHealthy?.(SCENE_SEAT)).toBe(true);
      expect(sources.presenceChannelHealthy?.(SCENE_SEAT) === true).toBe(true);
    } finally {
      await ingester.close();
      rmSync(world.base, { recursive: true, force: true });
    }
  });

  test('a real step fault stays false on a later quiet beat', async () => {
    const world = sceneWorld();
    const first = createPresenceIngester({ stateDir: world.stateDir, session: SCENE_SESSION });
    sceneStage(world, 'turn-start', 10);
    const caughtUp = await first.step();
    expect(caughtUp.healthy).toBe(true);
    await first.close();

    // Fatal log bytes, with a valid later record still staged behind them.
    writeFileSync(world.log, `${readFileSync(world.log, 'utf8')}not a presence line\n`);
    sceneStage(world, 'turn-end', 1);

    const second = createPresenceIngester({ stateDir: world.stateDir, session: SCENE_SESSION });
    try {
      let nowAt = new Date();
      const channel = createPresenceChannelHealth();
      const provider = (): boolean => channel.healthy(nowAt);
      const sources = hostedWatchSources(
        sceneRoute(), sceneLoop(), {} as WatchSources, undefined, undefined, provider,
      );

      const faulted = await second.step();
      expect(faulted.errors.length).toBeGreaterThan(0);
      expect(faulted.healthy).toBe(false);
      channel.stepped(presenceStepHealth(faulted), nowAt);
      expect(sources.presenceChannelHealthy?.(SCENE_SEAT)).toBe(false);

      // The fault is reported once; the next beat is quiet, and the verdict must still be false.
      // The producer's recovery marker, not the error list of this step, is what carries it.
      nowAt = new Date(nowAt.getTime() + 250);
      const quiet = await second.step();
      expect(quiet.errors).toEqual([]);
      expect(quiet.healthy).toBe(false);
      channel.stepped(presenceStepHealth(quiet), nowAt);
      expect(sources.presenceChannelHealthy?.(SCENE_SEAT)).toBe(false);
    } finally {
      await second.close();
      rmSync(world.base, { recursive: true, force: true });
    }
  });
});
