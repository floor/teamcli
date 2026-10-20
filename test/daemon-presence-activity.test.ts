// The daemon's presence activity reconciler against a synthetic world: a temporary `.agents`
// folder, a team state record with one seat, and spool records written exactly as a runtime hook
// would write them. No live CLI home, pane, socket or screen is touched.
//
// The scenes pin the two-clock rule (the projection answers what the runtime reported; only an
// applied current-binding turn line moves the exact `last_active` a claim compares), the separate
// scan cursor (audit and predecessor lines advance the reader without moving the fence or the
// clock), monotonicity, the wait-0 lock answer, and that a repeated observation writes nothing.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  presenceId, type PresenceEvent, type PresenceWriterSource,
} from '../src/daemon/presence/contract.ts';
import { createPresenceIngester, type PresenceIngester } from '../src/daemon/presence/ingest.ts';
import { createPresenceActivity, type PresenceActivityStep } from '../src/daemon/presence/activity.ts';
import { presencePaths, stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import { LOCK_FILE, STATE_FILE, readState } from '../src/state.ts';

const SESSION = 'teamcli';
const SEAT = 'builder-5';
const SEAT_ID = 'seat_0123456789ab';
const BINDING = 'prs_0123456789ab';
const SUCCESSOR = 'prs_fedcba987654';

type SeatSeed = {
  id?: string;
  last_active?: string;
  binding?: string | null;
  claims?: Record<string, unknown>;
};

type World = { base: string; stateDir: string };

let cleanups: Array<() => void | Promise<void>> = [];
function later(fn: () => void | Promise<void>): void {
  cleanups.push(fn);
}
afterEach(async () => {
  const fns = cleanups.reverse();
  cleanups = [];
  for (const fn of fns) {
    try { await fn(); } catch { /* one failed cleanup must not hide another */ }
  }
});

let revision = 0;
/** Writes the team state record. The increasing, forced mtime makes the ingester's stat cache see
 *  every rewrite even when the bytes keep one size. */
function writeSeats(world: World, seats: Record<string, SeatSeed>, session = SESSION): void {
  const written: Record<string, unknown> = {};
  for (const [seat, seed] of Object.entries(seats)) {
    const record: Record<string, unknown> = { stage: 'ready' };
    if (seed.id !== undefined) record.id = seed.id;
    if (seed.last_active !== undefined) record.last_active = seed.last_active;
    if (seed.binding !== null) record.presence_binding = seed.binding ?? BINDING;
    written[seat] = record;
  }
  const claims = Object.entries(seats)
    .map(([seat, seed]) => [seat, seed.claims] as const)
    .filter(([, claim]) => claim !== undefined);
  const idleClaims = Object.fromEntries(claims);
  const body = {
    format: 1,
    sessions: {
      [session]: {
        seats: written,
        worktrees: {},
        ...(claims.length === 0 ? {} : { idle_claims: idleClaims }),
      },
    },
  };
  const path = join(world.stateDir, STATE_FILE);
  writeFileSync(path, JSON.stringify(body));
  revision += 1;
  const stamp = new Date(1700000000000 + revision * 1000);
  utimesSync(path, stamp, stamp);
}

function makeWorld(seats: Record<string, SeatSeed> = { [SEAT]: { id: SEAT_ID } }): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-presence-activity-')));
  const stateDir = join(base, '.agents');
  mkdirSync(stateDir);
  const world: World = { base, stateDir };
  writeSeats(world, seats);
  later(() => rmSync(base, { recursive: true, force: true }));
  return world;
}

let nonceCounter = 0;
function nonce(): string {
  nonceCounter += 1;
  return nonceCounter.toString(16).padStart(8, '0');
}

type StageOptions = {
  ts?: string;
  binding?: string;
  source?: PresenceWriterSource;
  seat?: string;
};

function stage(world: World, event: PresenceEvent, options: StageOptions = {}): { id: string; ts: string } {
  const ts = options.ts ?? new Date().toISOString();
  const id = presenceId(ts, nonce());
  if (id === null) throw new Error('the test supplied an invalid event instant');
  const staged = stagePresenceRecord(world.stateDir, {
    session: SESSION,
    seat: options.seat ?? SEAT,
    binding: options.binding ?? BINDING,
    source: options.source ?? 'runtime-hook',
    event,
    ts,
    id,
  });
  if (staged.kind !== 'staged') throw new Error(staged.why);
  return { id, ts };
}

function ingesterFor(world: World): PresenceIngester {
  const ingester = createPresenceIngester({ stateDir: world.stateDir, session: SESSION });
  later(async () => {
    if (!ingester.isClosed()) await ingester.close();
  });
  return ingester;
}

function activityFor(world: World): PresenceActivityStep {
  return createPresenceActivity({ stateDir: world.stateDir, session: SESSION });
}

function stateOf(world: World) {
  return readState(world.stateDir).sessions[SESSION];
}

function seatOf(world: World) {
  return stateOf(world)?.seats[SEAT];
}

function logSize(world: World): number {
  const paths = presencePaths(world.stateDir, SESSION, SEAT);
  if (paths === null) throw new Error('the test seat cannot name a presence folder');
  return existsSync(paths.log) ? Buffer.byteLength(readFileSync(paths.log, 'utf8')) : 0;
}

function past(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

describe('the two clocks', () => {
  test('an applied turn line moves the exact last_active clock; wait and end move only the fence', async () => {
    const claimSince = past(600);
    const world = makeWorld({
      [SEAT]: {
        id: SEAT_ID,
        binding: BINDING,
        last_active: past(120),
        claims: {
          claim_id: '0123456789abcdef',
          idle_since: claimSince,
          state: 'pending',
          claimed_at: claimSince,
        },
      },
    });
    const ingester = ingesterFor(world);
    const start = stage(world, 'turn-start', { ts: past(30) });
    const end = stage(world, 'turn-end', { ts: past(20) });
    stage(world, 'human-wait', { ts: past(15) });
    stage(world, 'session-end', { ts: past(10) });
    await ingester.step();

    const at = new Date('2026-10-20T03:00:00.000Z');
    const applied = await activityFor(world)(at);
    expect(applied.failed).toBeNull();
    const one = applied.seats.find((seat) => seat.seat === SEAT);
    expect(one).toMatchObject({ read: 4, reconciled: 4, fence: 4, cursor: 4, busy: false, bad: null });
    expect(one?.stamped).toBe(end.ts);

    const seat = seatOf(world)!;
    // The event's own instant, not the ingest instant and not the writer's instant.
    expect(seat.last_active).toBe(end.ts);
    expect(seat.last_active).not.toBe(start.ts);
    expect(seat.presence_applied).toEqual({
      seat_id: SEAT_ID,
      binding: BINDING,
      seq: 4,
      applied_at: at.toISOString(),
    });
    expect(seat.presence_scan).toEqual({ binding: BINDING, seq: 4, offset: logSize(world) });
    // The claim is preserved, not pruned: its exact idle_since no longer matches the moved clock,
    // which is what makes the old episode stale for the next capture.
    expect(stateOf(world)?.idle_claims?.[SEAT]).toMatchObject({ idle_since: claimSince });
  }, 15_000);

  test('the fence follows the projection; an audit line advances only the scan cursor', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    stage(world, 'turn-start', { ts: past(30) });
    stage(world, 'turn-end', { ts: past(20) });
    const third = stage(world, 'turn-start', { ts: past(10) });
    await ingester.step();
    // Older than the projection: logged for the audit, never applied.
    stage(world, 'session-end', { ts: past(40) });
    await ingester.step();

    const applied = await activityFor(world)(new Date());
    const one = applied.seats.find((seat) => seat.seat === SEAT);
    expect(one).toMatchObject({ read: 4, reconciled: 3, fence: 3, cursor: 4 });
    const seat = seatOf(world)!;
    expect(seat.last_active).toBe(third.ts);
    // The consumer's equation holds: fence seq equals the projection's seq.
    const current = JSON.parse(readFileSync(
      presencePaths(world.stateDir, SESSION, SEAT)!.current,
      'utf8',
    )) as { seq: number };
    expect(current.seq).toBe(3);
    expect(seat.presence_applied?.seq).toBe(current.seq);
    // The cursor moved past the audit line even though the fence did not.
    expect(seat.presence_scan?.seq).toBe(4);
  }, 15_000);

  test('a predecessor incarnation moves neither the clock nor the fence; its line is skipped', async () => {
    const world = makeWorld({ [SEAT]: { id: SEAT_ID, binding: BINDING, last_active: past(120) } });
    const ingester = ingesterFor(world);
    stage(world, 'turn-start', { ts: past(30), binding: BINDING });
    await ingester.step();
    // Relaunch: same seat, new runtime incarnation.
    writeSeats(world, { [SEAT]: { id: SEAT_ID, binding: SUCCESSOR, last_active: past(120) } });
    const fresh = stage(world, 'turn-end', { ts: past(10), binding: SUCCESSOR });
    await ingester.step();

    await activityFor(world)(new Date());
    const seat = seatOf(world)!;
    expect(seat.last_active).toBe(fresh.ts);
    expect(seat.presence_applied).toMatchObject({ binding: SUCCESSOR, seq: 2 });
    expect(seat.presence_scan?.seq).toBe(2);
  }, 15_000);

  test('the clock never moves backwards, and a repeated observation writes nothing', async () => {
    const recent = past(5);
    const world = makeWorld({ [SEAT]: { id: SEAT_ID, binding: BINDING, last_active: recent } });
    const ingester = ingesterFor(world);
    stage(world, 'turn-start', { ts: past(30) });
    stage(world, 'turn-end', { ts: past(20) });
    stage(world, 'turn-start', { ts: past(10) });
    await ingester.step();

    const activity = activityFor(world);
    await activity(new Date());
    const seat = seatOf(world)!;
    expect(seat.last_active).toBe(recent);
    expect(seat.presence_applied?.seq).toBe(3);

    const path = join(world.stateDir, STATE_FILE);
    const before = readFileSync(path, 'utf8');
    const mtime = statSync(path).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const again = await activity(new Date());
    expect(again.seats.find((one) => one.seat === SEAT)).toMatchObject({ read: 0, reconciled: 0 });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(statSync(path).mtimeMs).toBe(mtime);
  }, 15_000);

  test('a waiting line alone sets the fence without inventing an activity instant', async () => {
    const world = makeWorld({ [SEAT]: { id: SEAT_ID, binding: BINDING } });
    const ingester = ingesterFor(world);
    stage(world, 'human-wait', { ts: past(10) });
    await ingester.step();
    await activityFor(world)(new Date());
    const seat = seatOf(world)!;
    expect(seat.last_active).toBeUndefined();
    expect(seat.presence_applied).toMatchObject({ binding: BINDING, seq: 1 });
  }, 15_000);

  test('a seat with no id keeps the clock but writes no fence', async () => {
    const world = makeWorld({ [SEAT]: { binding: BINDING } });
    const ingester = ingesterFor(world);
    const started = stage(world, 'turn-start', { ts: past(10) });
    await ingester.step();
    await activityFor(world)(new Date());
    const seat = seatOf(world)!;
    expect(seat.last_active).toBe(started.ts);
    expect(seat.presence_applied).toBeUndefined();
  }, 15_000);
});

describe('the state lock', () => {
  test('a held lock applies nothing and advances no cursor; the next call applies', async () => {
    const world = makeWorld({ [SEAT]: { id: SEAT_ID, binding: BINDING, last_active: past(120) } });
    const ingester = ingesterFor(world);
    const started = stage(world, 'turn-start', { ts: past(10) });
    await ingester.step();
    const path = join(world.stateDir, STATE_FILE);
    const before = readFileSync(path, 'utf8');

    const lock = join(world.stateDir, LOCK_FILE);
    writeFileSync(lock, `${String(process.pid)}\n`);
    const busy = await activityFor(world)(new Date());
    expect(busy.seats.find((seat) => seat.seat === SEAT)).toMatchObject({ busy: true, reconciled: 0 });
    expect(readFileSync(path, 'utf8')).toBe(before);
    unlinkSync(lock);

    const applied = await activityFor(world)(new Date());
    expect(applied.seats.find((seat) => seat.seat === SEAT)).toMatchObject({ busy: false, reconciled: 1 });
    const seat = seatOf(world)!;
    expect(seat.last_active).toBe(started.ts);
    expect(seat.presence_scan?.seq).toBe(1);
  }, 15_000);

  test('an unreadable state record fails closed and is never replaced', async () => {
    const world = makeWorld();
    const path = join(world.stateDir, STATE_FILE);
    writeFileSync(path, '{"format":1,');
    const result = await activityFor(world)(new Date());
    expect(result.failed).not.toBeNull();
    expect(readFileSync(path, 'utf8')).toBe('{"format":1,');
  }, 15_000);
});
