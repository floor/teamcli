// Independent acceptance for the host's latest-staged-event reconciliation: the real spool, the
// real ingester, the real activity fence and the real machine socket, with a synthetic source
// reading and a synthetic home/checkout. No owner session, credential, pane or live runtime is
// touched, and no production endpoint is discovered or dialled.
//
// The scenes pin: a runtime seat whose source has staged an event the canonical projection and
// its applied fence have not reached is held at read time in both the in-process snapshot and the
// wire client; the exact applied identity serves only once the projection and fence name it; a
// staged identity with no applied fence is held with the fence-specific why; and the complete
// seat list carries an explicit source class for hook siblings while a runtime seat is held.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMachineDaemon, type StartMachineDaemonInput } from '../src/daemon/host.ts';
import { probeDaemonHealth } from '../src/daemon/health.ts';
import { daemonSocketPath } from '../src/daemon/paths.ts';
import { createPresenceActivity, type PresenceActivityResult } from '../src/daemon/presence/activity.ts';
import type { PresenceSource, PresenceSourceStatus } from '../src/daemon/presence/health.ts';
import { createPresenceIngester, type PresenceIngester } from '../src/daemon/presence/ingest.ts';
import { presencePaths, stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import { STATE_FILE } from '../src/state.ts';

const SESSION = 'crew';
const WORKER = 'worker-1';
const BINDING = 'prs_0123456789ab';
const HOOK_BINDING = 'prs_ffffffffffff';
const NOW_ISO = '2026-10-20T06:00:00.000Z';
const OLD = `${NOW_ISO}-aaaaaaaa`;
const NEW = `${NOW_ISO}-bbbbbbbb`;

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

type Scratch = { base: string; root: string; home: string };
type PresenceSnapshot = {
  session?: string;
  state?: string;
  healthy?: boolean;
  why?: string | null;
  seats?: Array<Record<string, unknown>>;
};
type RootSnapshot = { root?: string; presence?: PresenceSnapshot };

let world: Scratch = { base: '', root: '', home: '' };
const made: Scratch[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function scratch(): Scratch {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'b7-b5-host-')));
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), CREW);
  return { base, root, home };
}

beforeEach(() => {
  world = scratch();
  made.push(world);
});

afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch { /* one failed cleanup must not hide another */ }
  }
  cleanups.length = 0;
  for (const one of made.splice(0)) rmSync(one.base, { recursive: true, force: true });
});

async function start(overrides: Partial<StartMachineDaemonInput>) {
  const started = await startMachineDaemon({
    home: world.home,
    roots: [world.root],
    startedBy: 'service-manager',
    version: '0.5.3-applied-event-acceptance',
    heartbeatMs: 20,
    ...overrides,
  });
  if (started.kind !== 'serving') throw new Error(`the daemon did not start: ${started.kind}`);
  cleanups.push(async () => {
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

// A few pass intervals after the canonical files settle; the proof is reconciled on the pass
// after the files change, and the pass interval in these scenes is 10 ms.
async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function presenceOf(snapshot: unknown): PresenceSnapshot {
  const roots = (snapshot as { roots?: RootSnapshot[] }).roots;
  const presence = roots?.[0]?.presence;
  if (presence === undefined) throw new Error('the snapshot carries no presence for the route');
  return presence;
}

function seatOf(snapshot: unknown, seat: string): Record<string, unknown> {
  const found = presenceOf(snapshot).seats?.find((one) => one.seat === seat);
  if (found === undefined) throw new Error(`the snapshot does not list ${seat}`);
  return found;
}

async function wirePresence(): Promise<PresenceSnapshot> {
  const answer = await probeDaemonHealth(daemonSocketPath(world.home), { id: 'applied-event-scene' }) as unknown as {
    kind: string;
    health?: { roots?: RootSnapshot[] };
  };
  expect(answer.kind).toBe('answered');
  return presenceOf(answer.health);
}

function writeState(seats: Record<string, Record<string, unknown>>): void {
  writeFileSync(join(world.root, '.agents', STATE_FILE), JSON.stringify({
    format: 1,
    sessions: { crew: { seats, worktrees: {} } },
  }));
}

function readStateJson(): {
  sessions: { crew: { seats: Record<string, Record<string, unknown>> } };
} {
  return JSON.parse(readFileSync(join(world.root, '.agents', STATE_FILE), 'utf8')) as {
    sessions: { crew: { seats: Record<string, Record<string, unknown>> } };
  };
}

function currentOf(stateDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(presencePaths(stateDir, SESSION, WORKER)!.current, 'utf8')) as Record<string, unknown>;
}

function fenceOf(): Record<string, unknown> | undefined {
  return readStateJson().sessions.crew.seats[WORKER]?.presence_applied as
    | Record<string, unknown>
    | undefined;
}

// A record that is already staged on disk but whose projection the ingester has not read yet:
// the identity exists in the spool, so the source is allowed to name it.

describe('the host applied-event acceptance', () => {
  test('a newer staged event holds the runtime seat until the old canonical projection and fence advance, in both snapshots', async () => {
    const clock = new Date(NOW_ISO);
    const stateDir = join(world.root, '.agents');
    const seatId = 'seat_0123456789ab';
    writeState({
      [WORKER]: { id: seatId, stage: 'ready', presence_binding: BINDING },
      'crew-lead': { id: 'seat_abcdef012345', stage: 'ready', presence_binding: HOOK_BINDING },
      'crew-op': { id: 'seat_111111111111', stage: 'ready' },
    });
    const realIngester = createPresenceIngester({ stateDir, session: SESSION, now: () => clock });
    const gateControl: { release: (() => void) | null } = { release: null };
    let gate: Promise<void> | null = null;
    let gateEntered = false;
    function releaseIngest(): void {
      const release = gateControl.release;
      if (release === null) throw new Error('the ingest gate was never armed');
      release();
    }
    const gated: PresenceIngester = {
      step: async () => {
        if (gate !== null) {
          gateEntered = true;
          await gate;
        }
        return realIngester.step();
      },
      close: () => realIngester.close(),
      isClosed: () => realIngester.isClosed(),
    };
    let toStage: string | null = OLD;
    let staged: string | null = null;
    let holdAfterStage = false;
    const source: PresenceSource = {
      seat: WORKER,
      step: async () => {
        const next = toStage;
        if (next === null) return;
        const written = stagePresenceRecord(stateDir, {
          session: SESSION,
          seat: WORKER,
          binding: BINDING,
          source: 'runtime-event',
          event: next === NEW ? 'turn-start' : 'turn-end',
          ts: NOW_ISO,
          id: next,
        });
        if (written.kind !== 'staged') throw new Error(`the event was not staged: ${written.why}`);
        toStage = null;
        staged = next;
        if (holdAfterStage) {
          gateEntered = false;
          gate = new Promise<void>((resolve) => { gateControl.release = resolve; });
        }
      },
      status: (): PresenceSourceStatus => ({
        seat: WORKER,
        binding: BINDING,
        threadId: 'thread-acceptance',
        channel: 'connected',
        stream: 'initialized',
        baseline: 'read',
        evidenceAt: NOW_ISO,
        stagedEventId: staged,
        why: null,
      } as PresenceSourceStatus),
      close: async () => ({ quiesced: true }),
    };
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      now: () => clock,
      presenceIngest: () => gated,
      presenceActivity: () => createPresenceActivity({ stateDir, session: SESSION, seats: [WORKER] }),
      presenceSubscriptions: (): PresenceSource[] => [source],
    });

    // The first event goes through the real pipeline: spool, projection, applied fence, proof.
    await waitUntil(() => {
      try {
        return currentOf(stateDir).id === OLD && fenceOf() !== undefined;
      } catch {
        return false;
      }
    });
    await settle();
    expect(currentOf(stateDir)).toMatchObject({ id: OLD, state: 'idle', seq: 1 });
    expect(fenceOf()).toMatchObject({ seat_id: seatId, binding: BINDING, seq: 1 });
    expect(seatOf(daemon.health(), WORKER)).toMatchObject({
      seat: WORKER,
      state: 'serving',
      healthy: true,
      source: 'runtime',
      binding: BINDING,
      appliedEventId: OLD,
      why: null,
    });
    // The hook sibling is live on the same route, and the unbound hook seat is explicitly pending:
    // the list is complete, never just the seats with a source.
    expect(seatOf(daemon.health(), 'crew-lead')).toMatchObject({
      seat: 'crew-lead',
      state: 'serving',
      healthy: true,
      source: 'hook',
      binding: HOOK_BINDING,
      appliedEventId: null,
      why: null,
    });
    expect(seatOf(daemon.health(), 'crew-op')).toMatchObject({
      seat: 'crew-op',
      state: 'pending',
      healthy: false,
      source: 'hook',
      binding: null,
      appliedEventId: null,
      why: 'the seat records no presence binding',
    });
    const wireBefore = await wirePresence();
    expect(wireBefore.seats?.map((one) => one.seat).sort()).toEqual(['crew-lead', 'crew-op', WORKER]);
    expect(seatOf({ roots: [{ presence: wireBefore }] }, WORKER)).toMatchObject({
      state: 'serving', source: 'runtime', binding: BINDING, appliedEventId: OLD,
    });

    // Stage a working event while the old idle projection and fence stand, and hold the next
    // ingest. The pass that stages it still finishes its activity and reconciliation; the next
    // pass stops at the ingester, so the held answer is stable instead of a wall-clock race.
    holdAfterStage = true;
    toStage = NEW;
    await waitUntil(() => staged === NEW && gateEntered);
    expect(presenceOf(daemon.health())).toMatchObject({ state: 'serving', healthy: true, why: null });
    // The runtime seat is ahead of its canonical position in the daemon's own snapshot.
    expect(seatOf(daemon.health(), WORKER)).toEqual({
      seat: WORKER,
      state: 'pending',
      healthy: false,
      source: 'runtime',
      binding: BINDING,
      appliedEventId: null,
      why: 'the canonical projection has not applied the runtime event',
    });
    // The actual wire client carries the same hold, source class and identity fields.
    const wireHeld = await wirePresence();
    expect(seatOf({ roots: [{ presence: wireHeld }] }, WORKER)).toEqual({
      seat: WORKER,
      state: 'pending',
      healthy: false,
      source: 'runtime',
      binding: BINDING,
      appliedEventId: null,
      why: 'the canonical projection has not applied the runtime event',
    });
    // Hook siblings are untouched by a runtime seat's hold.
    expect(seatOf({ roots: [{ presence: wireHeld }] }, 'crew-lead')).toMatchObject({
      state: 'serving', healthy: true, source: 'hook', appliedEventId: null, why: null,
    });
    // The canonical position and its fence have not moved.
    expect(currentOf(stateDir)).toMatchObject({ id: OLD, state: 'idle', seq: 1 });
    expect(fenceOf()).toMatchObject({ seat_id: seatId, binding: BINDING, seq: 1 });

    // Release the real ingester: projection and fence advance, then the seat serves again with
    // exactly the staged identity, in both snapshots.
    releaseIngest();
    await waitUntil(() => {
      try {
        return seatOf(daemon.health(), WORKER).appliedEventId === NEW;
      } catch {
        return false;
      }
    });
    expect(currentOf(stateDir)).toMatchObject({ id: NEW, state: 'working', seq: 2 });
    expect(fenceOf()).toMatchObject({ seat_id: seatId, binding: BINDING, seq: 2 });
    const served = seatOf(daemon.health(), WORKER);
    expect(served).toEqual({
      seat: WORKER,
      state: 'serving',
      healthy: true,
      source: 'runtime',
      binding: BINDING,
      appliedEventId: NEW,
      why: null,
    });
    const wireServed = await wirePresence();
    expect(seatOf({ roots: [{ presence: wireServed }] }, WORKER)).toEqual(served);
  }, 20_000);

  test('a staged identity with no applied fence holds with the fence-specific why, then serves once the real activity writes it', async () => {
    const clock = new Date(NOW_ISO);
    const stateDir = join(world.root, '.agents');
    const seatId = 'seat_0123456789ab';
    // The state record names the current incarnation but carries no presence_applied fence yet.
    writeState({
      [WORKER]: { id: seatId, stage: 'ready', presence_binding: BINDING },
      'crew-lead': { id: 'seat_abcdef012345', stage: 'ready', presence_binding: HOOK_BINDING },
      'crew-op': { id: 'seat_111111111111', stage: 'ready' },
    });
    const realActivity = createPresenceActivity({ stateDir, session: SESSION, seats: [WORKER] });
    const emptyActivity = (): PresenceActivityResult => ({ seats: [], failed: null });
    let fenceNow = false;
    let staged: string | null = null;
    let toStage: string | null = OLD;
    const source: PresenceSource = {
      seat: WORKER,
      step: async () => {
        const next = toStage;
        if (next === null) return;
        const written = stagePresenceRecord(stateDir, {
          session: SESSION,
          seat: WORKER,
          binding: BINDING,
          source: 'runtime-event',
          event: 'turn-end',
          ts: NOW_ISO,
          id: next,
        });
        if (written.kind !== 'staged') throw new Error(`the event was not staged: ${written.why}`);
        toStage = null;
        staged = next;
      },
      status: (): PresenceSourceStatus => ({
        seat: WORKER,
        binding: BINDING,
        threadId: 'thread-acceptance',
        channel: 'connected',
        stream: 'initialized',
        baseline: 'read',
        evidenceAt: NOW_ISO,
        stagedEventId: staged,
        why: null,
      } as PresenceSourceStatus),
      close: async () => ({ quiesced: true }),
    };
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      now: () => clock,
      presenceIngest: () => createPresenceIngester({ stateDir, session: SESSION, now: () => clock }),
      presenceActivity: () => async (at: Date) => fenceNow ? realActivity(at) : emptyActivity(),
      presenceSubscriptions: (): PresenceSource[] => [source],
    });

    // The real ingester projects the staged record, but the activity reconciler has not fenced
    // it: the projection alone is deliberately not enough.
    await waitUntil(() => {
      try {
        return currentOf(stateDir).id === OLD;
      } catch {
        return false;
      }
    });
    await settle();
    expect(fenceOf()).toBeUndefined();
    expect(currentOf(stateDir)).toMatchObject({ id: OLD, seq: 1 });
    expect(seatOf(daemon.health(), WORKER)).toEqual({
      seat: WORKER,
      state: 'pending',
      healthy: false,
      source: 'runtime',
      binding: BINDING,
      appliedEventId: null,
      why: 'the seat records no applied presence fence',
    });
    const wireHeld = await wirePresence();
    expect(seatOf({ roots: [{ presence: wireHeld }] }, WORKER)).toEqual({
      seat: WORKER,
      state: 'pending',
      healthy: false,
      source: 'runtime',
      binding: BINDING,
      appliedEventId: null,
      why: 'the seat records no applied presence fence',
    });
    expect(seatOf({ roots: [{ presence: wireHeld }] }, 'crew-lead')).toMatchObject({
      state: 'serving', healthy: true, source: 'hook', appliedEventId: null, why: null,
    });

    // The real activity writes the fence for the exact applied line; only then does the seat
    // serve, naming the staged identity rather than merely "recently seen".
    fenceNow = true;
    await waitUntil(() => {
      try {
        return seatOf(daemon.health(), WORKER).appliedEventId === OLD;
      } catch {
        return false;
      }
    });
    expect(fenceOf()).toMatchObject({ seat_id: seatId, binding: BINDING, seq: 1 });
    expect(seatOf(daemon.health(), WORKER)).toEqual({
      seat: WORKER,
      state: 'serving',
      healthy: true,
      source: 'runtime',
      binding: BINDING,
      appliedEventId: OLD,
      why: null,
    });
    const wireServed = await wirePresence();
    expect(seatOf({ roots: [{ presence: wireServed }] }, WORKER)).toEqual(
      seatOf(daemon.health(), WORKER),
    );
  }, 20_000);
});
