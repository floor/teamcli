// Independent acceptance of the display's live chain against the real machine daemon. A real
// daemon hosts a synthetic checkout; a fake runtime source stages records into the real spool;
// the daemon's real ingester and activity steps apply them to the canonical projection and its
// applied fence; the host then answers with its complete per-seat list. The display's answers
// come only through the real `daemonHealth` client (its own strict reading of the wire) and the
// display's own functions in src/labels/presence.ts. The runtime seat is rendered working, idle
// and waiting-for-a-person, each only after the staged identity it reports is proven applied; a
// hook sibling on the same route is rendered through the route's ingest with no applied id. No
// live runtime, seat, pane, owner home, credential file or existing daemon/service is involved.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { daemonHealth, type DaemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon, type MachineDaemon } from '../src/daemon/host.ts';
import type { PresenceSourceStatus } from '../src/daemon/presence/health.ts';
import { readPresenceCurrent } from '../src/daemon/presence/read.ts';
import { presencePaths } from '../src/daemon/presence/spool.ts';
import {
  presenceChannelHealthy,
  presenceSeatsOf,
  readPresenceForSeat,
  seatPresenceProof,
} from '../src/labels/presence.ts';
import { seatState } from '../src/labels/state.ts';

const SESSION = 'crew';
const RUNTIME_SEAT = 'codex-seat';
const HOOK_SEAT = 'claude-seat';
const RUNTIME_BINDING = 'prs_0123456789ab';
const HOOK_BINDING = 'prs_ba9876543210';

const TEAM_TEXT = `format: 1
project: acme
entity: acme
session: crew
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    leads: true
  - role: implementer
    name: codex-seat
    cli: codex
    vendor: openai
    model: GPT-5
    version: "5"
    launch: codex
  - role: implementer
    name: claude-seat
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

type World = { base: string; home: string; root: string; dir: string };

let worlds: World[] = [];
let daemons: MachineDaemon[] = [];

beforeEach(() => {
  worlds = [];
  daemons = [];
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    try { await daemon.close(); } catch { /* the scene closed it already */ }
  }
  for (const world of worlds.splice(0)) rmSync(world.base, { recursive: true, force: true });
});

/** One synthetic checkout, home and two seat records, under /private/tmp: the same place the
 *  accepted daemon scenes measure, never the owner's home or a real checkout. */
function makeWorld(): World {
  const base = realpathSync(mkdtempSync(join('/private/tmp', 'display-host-acceptance-')));
  const home = join(base, 'home');
  const root = join(base, 'repo');
  const dir = join(root, '.agents');
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'team.yaml'), TEAM_TEXT);
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(dir, 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: {
      crew: {
        seats: {
          'codex-seat': { stage: 'ready', id: 'seat_0123456789ab', presence_binding: RUNTIME_BINDING },
          'claude-seat': { stage: 'ready', id: 'seat_ba9876543210', presence_binding: HOOK_BINDING },
        },
        worktrees: {},
      },
    },
  })}\n`);
  const world: World = { base, home, root, dir };
  worlds.push(world);
  return world;
}

type PendingEvent = { event: 'turn-start' | 'turn-end' | 'human-wait'; ts: string };
type RuntimeSource = {
  queued: PendingEvent[];
  staged: string[];
  source: {
    seat: string;
    step: () => Promise<void>;
    status: () => PresenceSourceStatus;
    close: () => Promise<{ quiesced: true }>;
  };
};

let serial = 0;

/** One spool record in the producer's own contract. The hook seat's records are written by the
 *  hook itself; the runtime seat's are written by its source's `step`, which is why the same
 *  writer serves both. */
function writeRecord(
  world: World,
  seat: string,
  binding: string,
  source: 'runtime-hook' | 'runtime-event',
  event: PendingEvent['event'],
  ts: string,
): string {
  const paths = presencePaths(world.dir, SESSION, seat);
  if (paths === null) throw new Error('the seat has no presence paths');
  mkdirSync(paths.spool, { recursive: true });
  serial += 1;
  const id = `${ts}-${(0x10000000 + serial).toString(16).padStart(8, '0')}`;
  writeFileSync(join(paths.spool, `${id}.json`), `${JSON.stringify({
    v: 1, id, ts, session: SESSION, seat, binding, source, event,
  })}\n`);
  return id;
}

/** The runtime source a managed Codex launch would hand the daemon: a pump that stages the
 *  queued events and a status that names its own latest staged identity. It is synthetic, not a
 *  live CLI; the daemon treats it exactly as a producer's source. */
function runtimeSource(world: World): RuntimeSource {
  const q: PendingEvent[] = [];
  const staged: string[] = [];
  return {
    queued: q,
    staged,
    source: {
      seat: RUNTIME_SEAT,
      step: async () => {
        const next = q.shift();
        if (next === undefined) return;
        staged.push(writeRecord(world, RUNTIME_SEAT, RUNTIME_BINDING, 'runtime-event', next.event, next.ts));
      },
      status: () => ({
        seat: RUNTIME_SEAT,
        binding: RUNTIME_BINDING,
        threadId: 'thread-1',
        channel: 'connected',
        stream: 'initialized',
        baseline: 'read',
        evidenceAt: new Date().toISOString(),
        stagedEventId: staged.length === 0 ? null : staged[staged.length - 1],
        why: null,
      }),
      close: async () => ({ quiesced: true as const }),
    },
  };
}

async function waitFor<T>(check: () => Promise<T | null> | T | null, label: string, deadlineMs = 15_000): Promise<T> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== false) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The route's complete seat list from one client answer; a persisted close record carries none,
 *  which the display reads as an incomplete answer rather than a hook-only route. */
function seatListOf(health: DaemonHealth, root: string): readonly { seat: string; appliedEventId: string | null; healthy: boolean }[] | undefined {
  const presence = health.roots.find((entry) => entry.root === root)?.presence;
  return presence !== undefined && 'seats' in presence ? presence.seats : undefined;
}

describe('the display answers only through the real host answer and its client', () => {
  test('runtime working -> idle -> waiting and a hook sibling render live from applied proofs', async () => {
    const world = makeWorld();
    const runtime = runtimeSource(world);
    const started = await startMachineDaemon({
      home: world.home,
      roots: [world.root],
      version: '0.0.0-display-host-acceptance',
      heartbeatMs: 60_000,
      presenceHosting: true,
      presenceEveryMs: 100,
      presenceSubscriptions: () => [runtime.source],
    });
    if (started.kind !== 'serving') throw new Error(`the daemon did not start: ${started.kind}`);
    daemons.push(started.daemon);

    /** The display's whole chain at one instant: the client's own read of the wire, the strict
     *  seat reading, each seat's proof, and the projection read + rendered state. */
    const display = async (seat: string, binding: string) => {
      const health = await daemonHealth(world.home, { timeoutMs: 2_000 });
      const now = new Date();
      const channel = presenceChannelHealthy(health, world.root, SESSION, now);
      const seats = presenceSeatsOf(health, world.root, SESSION, now);
      const proof = seatPresenceProof(seats, seat, binding);
      const read = readPresenceForSeat(
        world.dir, SESSION, seat, binding, channel && proof.qualified, proof.appliedEventId,
      );
      return { health, channel, seats, proof, read, now };
    };

    // 1. The runtime seat starts working. The source stages a runtime-event record; the real
    //    ingester applies it and the real activity step fences it, so the host can prove it.
    const workingTs = new Date(Date.now() - 60_000).toISOString();
    runtime.queued.push({ event: 'turn-start', ts: workingTs });
    const workingId = await waitFor(() => runtime.staged[0] ?? null, 'the working record to be staged');
    await waitFor(async () => {
      const current = await readPresenceCurrent(world.dir, SESSION, RUNTIME_SEAT);
      return current.kind === 'ok' && current.value.state === 'working' ? current : null;
    }, 'the working projection');
    await waitFor(async () => {
      const { health } = await display(RUNTIME_SEAT, RUNTIME_BINDING);
      const seats = seatListOf(health, world.root);
      return seats?.find((entry) => entry.seat === RUNTIME_SEAT)?.appliedEventId === workingId;
    }, 'the working proof');

    const working = await display(RUNTIME_SEAT, RUNTIME_BINDING);
    expect(working.seats.kind).toBe('listed');
    if (working.seats.kind !== 'listed') throw new Error('the seat list did not read');
    expect(working.seats.seats.get(RUNTIME_SEAT)).toMatchObject({
      healthy: true, source: 'runtime', binding: RUNTIME_BINDING, appliedEventId: workingId,
    });
    expect(working.proof).toEqual({ qualified: true, appliedEventId: workingId });
    expect(working.read).toMatchObject({ kind: 'ok', observation: { state: 'working', live: true } });
    const workingRender = working.read.kind === 'ok'
      ? seatState({ presence: working.read.observation }, working.now)
      : null;
    expect(workingRender).toMatchObject({ state: 'working', source: 'presence' });

    // 2. The seat finishes its turn: idle, live under the new applied identity, never the old.
    const idleTs = new Date(Date.now() - 30_000).toISOString();
    runtime.queued.push({ event: 'turn-end', ts: idleTs });
    const idleId = await waitFor(() => runtime.staged[1] ?? null, 'the idle record to be staged');
    expect(idleId).not.toBe(workingId);
    await waitFor(async () => {
      const { health } = await display(RUNTIME_SEAT, RUNTIME_BINDING);
      const seats = seatListOf(health, world.root);
      return seats?.find((entry) => entry.seat === RUNTIME_SEAT)?.appliedEventId === idleId;
    }, 'the idle proof');
    const idle = await display(RUNTIME_SEAT, RUNTIME_BINDING);
    expect(idle.proof).toEqual({ qualified: true, appliedEventId: idleId });
    expect(idle.read).toMatchObject({ kind: 'ok', observation: { state: 'idle', live: true } });

    // 3. The seat stops at a person while the hook sibling also reports one. The runtime seat's
    //    proof must advance to the newly staged identity before the display calls it live; the
    //    unit scenes pin the mismatch case deterministically.
    const waitingTs = new Date(Date.now() - 5_000).toISOString();
    runtime.queued.push({ event: 'human-wait', ts: waitingTs });
    const waitingId = await waitFor(() => runtime.staged[2] ?? null, 'the waiting record to be staged');
    writeRecord(world, HOOK_SEAT, HOOK_BINDING, 'runtime-hook', 'human-wait', waitingTs);
    await waitFor(async () => {
      const { health } = await display(RUNTIME_SEAT, RUNTIME_BINDING);
      const seats = seatListOf(health, world.root);
      const runtimeEntry = seats?.find((entry) => entry.seat === RUNTIME_SEAT);
      const hookEntry = seats?.find((entry) => entry.seat === HOOK_SEAT);
      return runtimeEntry?.appliedEventId === waitingId && hookEntry?.healthy === true;
    }, 'the waiting proof and the hook sibling');

    const waiting = await display(RUNTIME_SEAT, RUNTIME_BINDING);
    if (waiting.seats.kind !== 'listed') throw new Error('the seat list did not read');
    expect(waiting.seats.seats.get(RUNTIME_SEAT)).toMatchObject({
      healthy: true, source: 'runtime', appliedEventId: waitingId,
    });
    // The hook sibling states its class explicitly and names no applied transition.
    expect(waiting.seats.seats.get(HOOK_SEAT)).toMatchObject({
      healthy: true, source: 'hook', binding: HOOK_BINDING, appliedEventId: null,
    });
    expect(waiting.channel).toBe(true);
    expect(waiting.read).toMatchObject({
      kind: 'ok', observation: { state: 'waiting-for-a-person', live: true },
    });
    const waitingRender = waiting.read.kind === 'ok'
      ? seatState({ presence: waiting.read.observation }, waiting.now)
      : null;
    expect(waitingRender).toMatchObject({ state: 'blocked', source: 'presence' });

    // The hook sibling: live through the route ingest, with no id to compare.
    const hookProof = seatPresenceProof(waiting.seats, HOOK_SEAT, HOOK_BINDING);
    expect(hookProof).toEqual({ qualified: true, appliedEventId: null });
    const hookRead = readPresenceForSeat(
      world.dir, SESSION, HOOK_SEAT, HOOK_BINDING, waiting.channel && hookProof.qualified, hookProof.appliedEventId,
    );
    expect(hookRead).toMatchObject({ kind: 'ok', observation: { state: 'waiting-for-a-person', live: true } });

    // The lead seat has no runtime binding, so its hook entry is pending: an incomplete seat is
    // never live, and the complete list still names it.
    if (waiting.seats.kind !== 'listed') throw new Error('the seat list did not read');
    expect(waiting.seats.seats.get('lead')).toMatchObject({ healthy: false, source: 'hook', appliedEventId: null });
    expect(seatPresenceProof(waiting.seats, 'lead', undefined)).toEqual({ qualified: false, appliedEventId: null });
  }, 40_000);
});
