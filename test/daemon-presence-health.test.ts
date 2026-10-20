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
  PRESENCE_HEALTH_GRACE_MS, createPresenceChannelHealth, presenceStepHealth, unprovenSource,
  type PresenceSourceStatus,
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
