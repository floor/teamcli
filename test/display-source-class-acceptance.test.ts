// Independent acceptance of the display's per-seat identity and source-class reading against the
// real machine daemon and the real health client. A synthetic checkout, home and runtime source
// live under a temporary directory; the daemon's own ingester and activity apply the staged transitions to
// the canonical projection and its fence, and every display answer comes through
// `daemonHealth()`'s own strict wire reading and the display functions in src/labels/presence.ts.
// No live seat, pane, service, owner home or credential file is involved.
//
// The scenes pin the final source-class contract:
//   - a newer staged transition the canonical projection has not applied holds the runtime seat
//     last known, and only the exact applied identity the fresh answer names is live;
//   - a projection that has advanced past the proof the daemon last reconciled stays last known,
//     never promoted on route health alone;
//   - a predecessor incarnation's binding is never this seat's live reading, and a route whose
//     runtime classification failed never serves its seats;
//   - a healthy hook sibling stays live on the mixed route, and an old (quiet) native event age
//     is not a hold;
//   - the list shapes around a real answer: an absent list, a duplicate, a missing entry and the
//     impossible serving `unknown`/missing-transition entries are all invalid, never partly served.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonHealth, type DaemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon, type MachineDaemon } from '../src/daemon/host.ts';
import type { PresenceSourceRuntime, PresenceSourceStatus } from '../src/daemon/presence/health.ts';
import { createPresenceIngester, type PresenceIngester } from '../src/daemon/presence/ingest.ts';
import { readPresenceCurrent } from '../src/daemon/presence/read.ts';
import { stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import {
  presenceChannelHealthy,
  presenceSeatsOf,
  readPresenceForSeat,
  seatPresenceProof,
  type PresenceSeatsRead,
} from '../src/labels/presence.ts';
import { seatState } from '../src/labels/state.ts';

const SESSION = 'crew';
const NATIVE = 'native-seat';
const HOOK = 'hook-seat';
const LEAD = 'crew-lead';
const BINDING = 'prs_0123456789ab';
const HOOK_BINDING = 'prs_ba9876543210';
const PREDECESSOR = 'prs_ffffffffffff';

const TEAM_TEXT = `format: 1
project: acme
entity: acme
session: crew
coordinator: crew-lead
operator: crew-lead
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
    leads: true
  - role: implementer
    name: native-seat
    cli: codex
    vendor: openai
    model: GPT-5
    version: "5"
    launch: codex
  - role: implementer
    name: hook-seat
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

type World = { base: string; home: string; root: string; dir: string };
let worlds: World[] = [];
let daemons: MachineDaemon[] = [];
let antiHang: Array<() => void> = [];

beforeEach(() => {
  worlds = [];
  daemons = [];
  antiHang = [];
});

afterEach(async () => {
  // A scene that failed while its ingest gate was armed must open it before the daemon can
  // finish its in-flight pass and close.
  for (const release of antiHang.splice(0)) {
    try { release(); } catch { /* already released */ }
  }
  for (const daemon of daemons.splice(0)) {
    try { await daemon.close(); } catch { /* the scene closed it already */ }
  }
  for (const world of worlds.splice(0)) rmSync(world.base, { recursive: true, force: true });
});

function makeWorld(nativeBinding: string = BINDING): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'display-source-class-')));
  const home = join(base, 'home');
  const root = join(base, 'repo');
  const dir = join(root, '.agents');
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'team.yaml'), TEAM_TEXT);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const world: World = { base, home, root, dir };
  writeStateFile(world, nativeBinding);
  worlds.push(world);
  return world;
}

/** The state record a launch writes: each seat's runtime incarnation binding. */
function writeStateFile(world: World, nativeBinding: string): void {
  writeFileSync(join(world.dir, 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: {
      crew: {
        seats: {
          [NATIVE]: { stage: 'ready', id: 'seat_0123456789ab', presence_binding: nativeBinding },
          [HOOK]: { stage: 'ready', id: 'seat_ba9876543210', presence_binding: HOOK_BINDING },
          [LEAD]: { stage: 'ready', id: 'seat_111111111111' },
        },
        worktrees: {},
      },
    },
  })}\n`);
}

type StagedEvent = { event: 'turn-start' | 'turn-end' | 'human-wait'; ts: string; id: string };

/** The synthetic runtime a managed native seat would hand the host: a pump that stages one
 *  queued transition and a status that names its own latest staged identity and evidence
 *  instant. It is not a live CLI; the daemon treats it exactly as another producer's source. */
function runtimeSource(): {
  queue: StagedEvent[];
  staged: StagedEvent[];
  hooks: { afterStage: (() => void) | null };
  source: PresenceSourceRuntime;
} {
  const queue: StagedEvent[] = [];
  const staged: StagedEvent[] = [];
  const hooks: { afterStage: (() => void) | null } = { afterStage: null };
  // A connected, initialized stream has measured evidence even before its first event; the
  // event's own instant is used only when there is a staged event to name.
  const connectedAt = new Date().toISOString();
  return {
    queue,
    staged,
    hooks,
    source: {
      seat: NATIVE,
      step: async () => {
        const next = queue.shift();
        if (next === undefined) return;
        const written = stagePresenceRecord(worldDir(), {
          session: SESSION,
          seat: NATIVE,
          binding: BINDING,
          source: 'runtime-event',
          event: next.event,
          ts: next.ts,
          id: next.id,
        });
        if (written.kind !== 'staged') throw new Error(`the transition was not staged: ${written.why}`);
        staged.push(next);
        hooks.afterStage?.();
      },
      status: (): PresenceSourceStatus => {
        const last = staged[staged.length - 1];
        return {
          seat: NATIVE,
          binding: BINDING,
          threadId: 'thread-acceptance',
          channel: 'connected',
          stream: 'initialized',
          baseline: 'read',
          evidenceAt: last === undefined ? connectedAt : last.ts,
          stagedEventId: last === undefined ? null : last.id,
          why: null,
        };
      },
      close: async () => ({ quiesced: true as const }),
    },
  };
}

// The source is created before its world in a few scenes; this indirection keeps the staging
// writer pointed at the test's own checkout without threading the world through every call.
let currentWorld: World | null = null;
function worldDir(): string {
  if (currentWorld === null) throw new Error('the scene has no world yet');
  return currentWorld.dir;
}

async function start(world: World, source: PresenceSourceRuntime | null, options: {
  ingest?: () => PresenceIngester;
  subscriptions?: () => PresenceSourceRuntime[];
} = {}): Promise<MachineDaemon> {
  const started = await startMachineDaemon({
    home: world.home,
    roots: [world.root],
    version: '0.0.0-display-source-class-acceptance',
    heartbeatMs: 60_000,
    presenceHosting: true,
    presenceEveryMs: 25,
    presenceSubscriptions: options.subscriptions ?? (() => (source === null ? [] : [source])),
    ...(options.ingest === undefined ? {} : { presenceIngest: options.ingest }),
  });
  if (started.kind !== 'serving') throw new Error(`the daemon did not start: ${started.kind}`);
  daemons.push(started.daemon);
  return started.daemon;
}

async function waitFor<T>(check: () => Promise<T | null> | T | null, label: string, deadlineMs = 10_000): Promise<T> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== false) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function presenceOf(health: DaemonHealth): {
  state?: unknown;
  healthy?: unknown;
  seats?: unknown;
} | undefined {
  return health.roots[0]?.presence as { state?: unknown; healthy?: unknown; seats?: unknown } | undefined;
}

/** The display's whole chain at one instant: the real client's answer, the route verdict, the
 *  strict per-seat reading, this seat's proof, and the projection read it qualifies. */
async function display(world: World, seat: string, binding: unknown) {
  const health = await daemonHealth(world.home, { timeoutMs: 2_000 });
  const now = new Date();
  const channel = presenceChannelHealthy(health, world.root, SESSION, now);
  const seats = presenceSeatsOf(health, world.root, SESSION, now);
  const proof = seatPresenceProof(seats, seat, binding);
  const read = readPresenceForSeat(
    world.dir, SESSION, seat, binding, channel && proof.qualified, proof.appliedEventId,
  );
  return { health, channel, seats, proof, read, now };
}

function currentId(stateDir: string, seat: string): Promise<string | null> {
  return readPresenceCurrent(stateDir, SESSION, seat).then((read) =>
    read.kind === 'ok' ? read.value.id : null);
}

async function appliedId(world: World, seat: string, binding: unknown): Promise<string | null> {
  const shown = await display(world, seat, binding);
  return shown.seats.kind === 'listed' ? shown.seats.seats.get(seat)?.appliedEventId ?? null : null;
}

/** A real ingest gate: the host's next pass waits at its ingester step, so the canonical
 *  projection and the daemon's cached proof stand still while the scene measures the answer. */
function ingestGate(real: PresenceIngester): {
  ingester: PresenceIngester;
  arm: () => void;
  release: () => void;
  entered: () => boolean;
} {
  const control: { gate: Promise<void> | null; open: (() => void) | null; seen: boolean } = {
    gate: null, open: null, seen: false,
  };
  const release = (): void => {
    const open = control.open;
    if (open === null) return;
    control.open = null;
    control.gate = null;
    open();
  };
  antiHang.push(release);
  return {
    ingester: {
      step: async () => {
        const gate = control.gate;
        if (gate !== null) {
          control.seen = true;
          await gate;
        }
        return real.step();
      },
      close: () => real.close(),
      isClosed: () => real.isClosed(),
    },
    arm: () => { control.gate = new Promise<void>((resolve) => { control.open = resolve; }); control.seen = false; },
    release,
    entered: () => control.seen,
  };
}

describe('the display reads identity and source class from the actual health answer', () => {
  test('a new stage holds last known; the exact applied id is live; a hook sibling and a quiet native age stay live', async () => {
    const clock = Date.now();
    const OLD_TS = new Date(clock - 40 * 60_000).toISOString();
    const OLD_ID = `${OLD_TS}-aaaaaaaa`;
    const NEW_TS = new Date(clock - 5_000).toISOString();
    const NEW_ID = `${NEW_TS}-bbbbbbbb`;
    const HOOK_TS = new Date(clock - 10_000).toISOString();
    const HOOK_ID = `${HOOK_TS}-dddddddd`;

    const world = makeWorld();
    currentWorld = world;
    const runtime = runtimeSource();
    runtime.queue.push({ event: 'turn-start', ts: OLD_TS, id: OLD_ID });
    // The hook sibling writes its own record, as the hook itself would.
    const hookWritten = stagePresenceRecord(world.dir, {
      session: SESSION, seat: HOOK, binding: HOOK_BINDING, source: 'runtime-hook',
      event: 'human-wait', ts: HOOK_TS, id: HOOK_ID,
    });
    expect(hookWritten.kind).toBe('staged');

    const realIngester = createPresenceIngester({ stateDir: world.dir, session: SESSION });
    const gate = ingestGate(realIngester);
    await start(world, runtime.source, { ingest: () => gate.ingester });

    // The old working transition is applied and fenced; its event is 40 minutes old, and the
    // source's evidence instant is the same old sample. Age is not a liveness fact.
    await waitFor(async () => (await appliedId(world, NATIVE, BINDING)) === OLD_ID, 'the old applied identity');
    const quiet = await display(world, NATIVE, BINDING);
    expect(quiet.channel).toBe(true);
    expect(quiet.proof).toEqual({ qualified: true, appliedEventId: OLD_ID });
    expect(quiet.read).toEqual({
      kind: 'ok',
      observation: { state: 'working', source: 'runtime-event', event: 'turn-start', since: OLD_TS, live: true },
    });
    expect(seatState({ presence: quiet.read.kind === 'ok' ? quiet.read.observation : undefined }, quiet.now))
      .toMatchObject({ state: 'working', source: 'presence', presence: { live: true, since: OLD_TS } });
    // A bound entry for another incarnation is not this seat's proof, even on a serving answer.
    expect(seatPresenceProof(quiet.seats, NATIVE, PREDECESSOR)).toEqual({ qualified: false, appliedEventId: null });

    const hookLive = await display(world, HOOK, HOOK_BINDING);
    expect(hookLive.proof).toEqual({ qualified: true, appliedEventId: null });
    expect(hookLive.read).toMatchObject({
      kind: 'ok', observation: { state: 'waiting-for-a-person', live: true },
    });
    // The unbound hook sibling is listed pending and never live.
    if (hookLive.seats.kind !== 'listed') throw new Error('the complete list did not read');
    expect(hookLive.seats.seats.get(LEAD)).toEqual({
      healthy: false, source: 'hook', binding: null, appliedEventId: null,
    });
    const leadRaw = presenceOf(hookLive.health)?.seats as Array<Record<string, unknown>>;
    expect(leadRaw.find((one) => one.seat === LEAD)).toMatchObject({
      state: 'pending', why: 'the seat records no presence binding',
    });
    expect(seatPresenceProof(hookLive.seats, LEAD, undefined)).toEqual({ qualified: false, appliedEventId: null });

    // Stage a newer idle transition while the old projection and proof stand. The source's own
    // pump stages it in the pass that reconciles; the next pass is held at its ingester step, so
    // the answer cannot race the write.
    runtime.hooks.afterStage = () => gate.arm();
    runtime.queue.push({ event: 'turn-end', ts: NEW_TS, id: NEW_ID });
    await waitFor(() => runtime.staged.some((one) => one.id === NEW_ID), 'the new stage');
    await waitFor(() => gate.entered(), 'the held ingest');
    expect(await currentId(world.dir, NATIVE)).toBe(OLD_ID);

    const held = await display(world, NATIVE, BINDING);
    if (held.seats.kind !== 'listed') throw new Error('the complete list did not read');
    expect(held.seats.seats.get(NATIVE)).toEqual({
      healthy: false, source: 'runtime', binding: BINDING, appliedEventId: null,
    });
    const heldRaw = presenceOf(held.health)?.seats as Array<Record<string, unknown>>;
    expect(heldRaw.find((one) => one.seat === NATIVE)).toMatchObject({
      state: 'pending',
      why: 'the canonical projection has not applied the runtime event',
    });
    expect(held.channel).toBe(true);
    expect(held.proof).toEqual({ qualified: false, appliedEventId: null });
    // The old projection is the runtime's last known word: shown, never promoted live.
    expect(held.read).toEqual({
      kind: 'ok',
      observation: { state: 'working', source: 'runtime-event', event: 'turn-start', since: OLD_TS, live: false },
    });
    expect(seatState({ presence: held.read.kind === 'ok' ? held.read.observation : undefined }, held.now))
      .toMatchObject({ state: 'working', source: 'presence', presence: { live: false } });
    // The hook sibling is untouched by the runtime seat's hold: its class answers on the route.
    const hookHeld = await display(world, HOOK, HOOK_BINDING);
    expect(hookHeld.proof).toEqual({ qualified: true, appliedEventId: null });
    expect(hookHeld.read).toMatchObject({ kind: 'ok', observation: { live: true } });

    // Release the real ingester: the new transition is applied and fenced, and only then does
    // the display carry exactly that identity live.
    gate.release();
    await waitFor(async () => (await appliedId(world, NATIVE, BINDING)) === NEW_ID, 'the new applied identity');
    expect(await currentId(world.dir, NATIVE)).toBe(NEW_ID);
    const freed = await display(world, NATIVE, BINDING);
    expect(freed.proof).toEqual({ qualified: true, appliedEventId: NEW_ID });
    expect(freed.read).toEqual({
      kind: 'ok',
      observation: { state: 'idle', source: 'runtime-event', event: 'turn-end', since: NEW_TS, live: true },
    });
    expect(seatState({ presence: freed.read.kind === 'ok' ? freed.read.observation : undefined }, freed.now))
      .toMatchObject({ state: 'idle', source: 'presence', presence: { live: true } });
  }, 30_000);

  test('a projection that advanced past the proof the daemon last reconciled stays last known', async () => {
    const clock = Date.now();
    const OLD_TS = new Date(clock - 60_000).toISOString();
    const OLD_ID = `${OLD_TS}-aaaaaaaa`;
    const AHEAD_TS = new Date(clock - 20_000).toISOString();
    const AHEAD_ID = `${AHEAD_TS}-cccccccc`;

    const world = makeWorld();
    currentWorld = world;
    const runtime = runtimeSource();
    runtime.queue.push({ event: 'turn-end', ts: OLD_TS, id: OLD_ID });

    const realIngester = createPresenceIngester({ stateDir: world.dir, session: SESSION });
    const gate = ingestGate(realIngester);
    await start(world, runtime.source, { ingest: () => gate.ingester });

    await waitFor(async () => (await appliedId(world, NATIVE, BINDING)) === OLD_ID, 'the idle applied identity');
    const before = await display(world, NATIVE, BINDING);
    expect(before.proof).toEqual({ qualified: true, appliedEventId: OLD_ID });
    expect(before.read).toMatchObject({ kind: 'ok', observation: { state: 'idle', live: true } });

    // Freeze the host's next pass, then apply a newer transition directly to the canonical
    // projection with a separate real ingester. The producer's source still names the old
    // identity, so the daemon's cached proof and answer stay on it while the file moves ahead.
    gate.arm();
    await waitFor(() => gate.entered(), 'the held host pass');
    const written = stagePresenceRecord(world.dir, {
      session: SESSION, seat: NATIVE, binding: BINDING, source: 'runtime-event',
      event: 'turn-start', ts: AHEAD_TS, id: AHEAD_ID,
    });
    expect(written.kind).toBe('staged');
    const mine = createPresenceIngester({ stateDir: world.dir, session: SESSION });
    try {
      await waitFor(async () => {
        await mine.step();
        return (await currentId(world.dir, NATIVE)) === AHEAD_ID;
      }, 'the advanced projection');
    } finally {
      await mine.close();
    }

    const ahead = await display(world, NATIVE, BINDING);
    // The actual answer still serves the old proof; the file already names the newer transition.
    if (ahead.seats.kind !== 'listed') throw new Error('the complete list did not read');
    expect(ahead.seats.seats.get(NATIVE)).toEqual({
      healthy: true, source: 'runtime', binding: BINDING, appliedEventId: OLD_ID,
    });
    const aheadRaw = presenceOf(ahead.health)?.seats as Array<Record<string, unknown>>;
    expect(aheadRaw.find((one) => one.seat === NATIVE)).toMatchObject({ state: 'serving', why: null });
    expect(ahead.proof).toEqual({ qualified: true, appliedEventId: OLD_ID });
    expect(await currentId(world.dir, NATIVE)).toBe(AHEAD_ID);
    // The display refuses to extend the proof to a projection it does not name.
    expect(ahead.read).toEqual({
      kind: 'ok',
      observation: { state: 'working', source: 'runtime-event', event: 'turn-start', since: AHEAD_TS, live: false },
    });
    expect(seatState({ presence: ahead.read.kind === 'ok' ? ahead.read.observation : undefined }, ahead.now))
      .toMatchObject({ state: 'working', source: 'presence', presence: { live: false, since: AHEAD_TS } });
    gate.release();
  }, 30_000);

  test('a predecessor projection under a successor record is invalid, and the hook sibling stays live', async () => {
    const clock = Date.now();
    const OLD_TS = new Date(clock - 30_000).toISOString();
    const OLD_ID = `${OLD_TS}-aaaaaaaa`;
    const HOOK_TS = new Date(clock - 10_000).toISOString();
    const HOOK_ID = `${HOOK_TS}-dddddddd`;

    // Phase 1: the predecessor launch applied and projected its own idle transition.
    const world = makeWorld(PREDECESSOR);
    currentWorld = world;
    expect(stagePresenceRecord(world.dir, {
      session: SESSION, seat: NATIVE, binding: PREDECESSOR, source: 'runtime-event',
      event: 'turn-end', ts: OLD_TS, id: OLD_ID,
    }).kind).toBe('staged');
    const previous = createPresenceIngester({ stateDir: world.dir, session: SESSION });
    try {
      await waitFor(async () => {
        await previous.step();
        return (await currentId(world.dir, NATIVE)) === OLD_ID;
      }, 'the predecessor projection');
    } finally {
      await previous.close();
    }

    // Phase 2: a successor launch records its own incarnation and its source has staged nothing
    // yet. The predecessor's projection stays on disk as last known; the display must fence it
    // out under the successor's binding rather than promote it.
    writeStateFile(world, BINDING);
    const runtime = runtimeSource();
    stagePresenceRecord(world.dir, {
      session: SESSION, seat: HOOK, binding: HOOK_BINDING, source: 'runtime-hook',
      event: 'turn-end', ts: HOOK_TS, id: HOOK_ID,
    });
    await start(world, runtime.source);
    const held = await waitFor(async () => {
      const shown = await display(world, NATIVE, BINDING);
      if (shown.seats.kind !== 'listed') return null;
      const entry = shown.seats.seats.get(NATIVE);
      return entry !== undefined && entry.healthy === false && entry.binding === BINDING ? shown : null;
    }, 'the successor-bound seat hold');

    if (held.seats.kind !== 'listed') throw new Error('the complete list did not read');
    expect(held.seats.seats.get(NATIVE)).toEqual({
      source: 'runtime', healthy: false, binding: BINDING, appliedEventId: null,
    });
    const nativeRaw = presenceOf(held.health)?.seats as Array<Record<string, unknown>>;
    expect(nativeRaw.find((one) => one.seat === NATIVE)).toMatchObject({
      state: 'pending', why: 'the runtime source has staged no event yet',
    });
    expect(held.channel).toBe(true);
    expect(held.proof).toEqual({ qualified: false, appliedEventId: null });
    // An existing projection the successor's record cannot claim is invalid: neither live nor
    // a permission for the screen to answer in its place.
    expect(await currentId(world.dir, NATIVE)).toBe(OLD_ID);
    expect(held.read).toEqual({
      kind: 'invalid', why: 'the projection belongs to another runtime incarnation',
    });
    // The hook sibling names no applied transition and remains live through the route ingest.
    const hook = await display(world, HOOK, HOOK_BINDING);
    if (hook.seats.kind !== 'listed') throw new Error('the complete list did not read');
    expect(hook.seats.seats.get(HOOK)).toEqual({
      healthy: true, source: 'hook', binding: HOOK_BINDING, appliedEventId: null,
    });
    const hookRaw = presenceOf(hook.health)?.seats as Array<Record<string, unknown>>;
    expect(hookRaw.find((one) => one.seat === HOOK)).toMatchObject({ state: 'serving', why: null });
    expect(hook.proof).toEqual({ qualified: true, appliedEventId: null });
    expect(hook.read).toMatchObject({ kind: 'ok', observation: { state: 'idle', live: true } });
  }, 30_000);

  test('a route whose runtime classification failed lists unknown seats that never serve', async () => {
    const world = makeWorld();
    currentWorld = world;
    const now = Date.now();
    const OLD_TS = new Date(now - 30_000).toISOString();
    // A projection exists on disk, so the scene can tell "last known" from "absent".
    expect(stagePresenceRecord(world.dir, {
      session: SESSION, seat: NATIVE, binding: BINDING, source: 'runtime-event',
      event: 'turn-end', ts: OLD_TS, id: `${OLD_TS}-aaaaaaaa`,
    }).kind).toBe('staged');

    await start(world, null, {
      subscriptions: () => { throw new Error('the named codex endpoint is missing'); },
    });
    // The ingester still owns the route's spool even when classification failed; wait for the
    // seeded projection so this scene reads a last-known word rather than racing the first pass.
    await waitFor(async () => (await currentId(world.dir, NATIVE)) !== null, 'the seeded projection');

    const shown = await display(world, NATIVE, BINDING);
    const presence = presenceOf(shown.health);
    expect(presence?.state).toBe('pending');
    expect(presence?.healthy).toBe(false);
    // The raw answer classifies every seat explicitly: the failure is never inferred away, and
    // no entry is serving.
    const raw = Array.isArray(presence?.seats) ? presence.seats as Array<Record<string, unknown>> : [];
    expect(raw.map((entry) => entry.seat).sort()).toEqual([HOOK, LEAD, NATIVE].sort());
    for (const entry of raw) {
      expect(entry).toMatchObject({ state: 'pending', healthy: false, source: 'unknown', appliedEventId: null });
      expect(typeof entry.why).toBe('string');
    }
    // The display drops the unclassified answer whole: no route health, no seat proof.
    expect(shown.channel).toBe(false);
    expect(shown.seats).toEqual({
      kind: 'invalid', why: 'the route verdict is not fresh and serving for this session',
    });
    expect(shown.proof).toEqual({ qualified: false, appliedEventId: null });
    expect(shown.read).toMatchObject({ kind: 'ok', observation: { state: 'idle', live: false } });
  }, 30_000);

  test('the list shapes around a real answer are refused whole, never partly served', async () => {
    const clock = Date.now();
    const OLD_TS = new Date(clock - 20 * 60_000).toISOString();
    const OLD_ID = `${OLD_TS}-aaaaaaaa`;
    const HOOK_TS = new Date(clock - 5_000).toISOString();

    const world = makeWorld();
    currentWorld = world;
    const runtime = runtimeSource();
    runtime.queue.push({ event: 'turn-end', ts: OLD_TS, id: OLD_ID });
    stagePresenceRecord(world.dir, {
      session: SESSION, seat: HOOK, binding: HOOK_BINDING, source: 'runtime-hook',
      event: 'turn-end', ts: HOOK_TS, id: `${HOOK_TS}-dddddddd`,
    });
    await start(world, runtime.source);
    await waitFor(async () => (await appliedId(world, NATIVE, BINDING)) === OLD_ID, 'the serving answer');

    const base = await display(world, NATIVE, BINDING);
    expect(base.seats.kind).toBe('listed');
    const actual = presenceOf(base.health)?.seats as Array<Record<string, unknown>>;
    expect(Array.isArray(actual)).toBe(true);

    /** The same fresh answer with one list field altered; the display must refuse it whole. */
    const altered = (seats: unknown): DaemonHealth => ({
      ...base.health,
      roots: base.health.roots.map((entry) => entry.root === world.root
        ? { ...entry, presence: { ...entry.presence, seats } as typeof entry.presence }
        : entry),
    });
    const at = base.now;
    const invalid = (seats: unknown): PresenceSeatsRead => presenceSeatsOf(altered(seats), world.root, SESSION, at);

    const runtimeEntry = actual.find((entry) => entry.seat === NATIVE);
    const hookEntry = actual.find((entry) => entry.seat === HOOK);
    if (runtimeEntry === undefined || hookEntry === undefined) throw new Error('the answer is not complete');

    // No list at all: under the complete-list contract neither class is live by route health.
    const absent = invalid(undefined);
    expect(absent).toEqual({ kind: 'invalid', why: 'the route carries no seat list' });
    expect(presenceChannelHealthy(altered(undefined), world.root, SESSION, at)).toBe(false);
    expect(seatPresenceProof(absent, NATIVE, BINDING)).toEqual({ qualified: false, appliedEventId: null });
    expect(seatPresenceProof(absent, HOOK, HOOK_BINDING)).toEqual({ qualified: false, appliedEventId: null });

    // A repeated entry is not a complete list.
    expect(invalid([...actual, runtimeEntry])).toEqual({
      kind: 'invalid', why: 'a seat entry does not name one unique seat',
    });
    // A serving entry with an impossible class or no applied transition is refused.
    expect(invalid(actual.map((entry) => entry.seat === NATIVE ? { ...entry, source: 'unknown' } : entry)))
      .toEqual({ kind: 'invalid', why: 'a serving seat entry has an unknown source class' });
    expect(invalid(actual.map((entry) => entry.seat === NATIVE ? { ...entry, appliedEventId: null } : entry)))
      .toEqual({ kind: 'invalid', why: 'a serving runtime seat names no applied transition' });
    // A missing entry is held for that seat alone; the listed runtime seat keeps its exact proof.
    const missingEntry = invalid(actual.filter((entry) => entry.seat !== HOOK));
    if (missingEntry.kind !== 'listed') throw new Error('the incomplete-entry list did not read');
    expect(seatPresenceProof(missingEntry, NATIVE, BINDING)).toEqual({ qualified: true, appliedEventId: OLD_ID });
    expect(seatPresenceProof(missingEntry, HOOK, HOOK_BINDING)).toEqual({ qualified: false, appliedEventId: null });
  }, 30_000);
});
