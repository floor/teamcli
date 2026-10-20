// Independent acceptance for the presence lifecycle at its actual surfaces: the activity
// reconciler driven by the daemon's own ingester over a synthetic `.agents` folder, and the
// machine host's close path with a synthetic home, a synthetic checkout, the real single-instance
// lock and machine socket, and injected presence handles. No owner session, credential, pane or
// live team file is touched.
//
// The activity scenes pin: canonical turn transitions between beats move the persisted clock only
// forward to the event's own instant; waiting and gone move the fence without touching the exact
// stamp; only applied lines of the current binding reconcile while the scan cursor advances over
// every line read; a held state lock writes nothing; presence never creates a seat record.
//
// The close scenes pin the long watch pass and the hung presence pass against admission: send and
// bus stop admitting without waiting for a watch that will not stop, the record says the daemon is
// closing before an unbounded drain is awaited, and only a truthful quiescence releases ownership.
// A non-quiescent ingester close is asked again on a later close rather than cached forever.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMachineDaemon, type StartMachineDaemonInput } from '../src/daemon/host.ts';
import { daemonLockPath, daemonSocketPath } from '../src/daemon/paths.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import {
  createPresenceActivity, type PresenceActivityResult, type PresenceActivityStep,
} from '../src/daemon/presence/activity.ts';
import { presenceId, type PresenceEvent } from '../src/daemon/presence/contract.ts';
import {
  createPresenceIngester, type PresenceIngestResult, type PresenceIngester,
} from '../src/daemon/presence/ingest.ts';
import { readPresenceTransitions } from '../src/daemon/presence/read.ts';
import { presencePaths, stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import { busSocket } from '../src/bus/server.ts';
import { daemonSocketPath as sendDaemonSocketPath } from '../src/send/daemon.ts';
import {
  LOCK_FILE, STATE_FILE, emptySession, readState, type SessionState,
} from '../src/state.ts';

const NOW = Date.parse('2026-10-20T03:00:00Z');
const SESSION = 'crew';
const SEAT = 'writer';
const SEAT_ID = 'seat_0123456789ab';
const BINDING = 'prs_0123456789ab';
const SUCCESSOR = 'prs_fedcba987654';

function at(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

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
    name: writer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

let cleanups: Array<() => Promise<void> | void> = [];
function later(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}
afterEach(async () => {
  const fns = cleanups.reverse();
  cleanups = [];
  for (const fn of fns) {
    try { await fn(); } catch { /* one failed cleanup must not hide another */ }
  }
});

// ---------------------------------------------------------------- activity fixtures

type ActivityWorld = { base: string; stateDir: string };

let revision = 0;
type SeatSeed = {
  id?: string;
  last_active?: string;
  binding?: string | null;
  applied?: Record<string, unknown>;
};

/** Writes the team state record. The increasing, forced mtime makes a rewritten record visible
 *  to readers that cache by stat even when its bytes keep one size. */
function writeSeats(world: ActivityWorld, seats: Record<string, SeatSeed>): void {
  const written: Record<string, unknown> = {};
  for (const [seat, seed] of Object.entries(seats)) {
    const record: Record<string, unknown> = { stage: 'ready' };
    if (seed.id !== undefined) record.id = seed.id;
    if (seed.last_active !== undefined) record.last_active = seed.last_active;
    if (seed.binding !== null) record.presence_binding = seed.binding ?? BINDING;
    if (seed.applied !== undefined) record.presence_applied = seed.applied;
    written[seat] = record;
  }
  const body = {
    format: 1,
    sessions: { [SESSION]: { seats: written, worktrees: {} } },
  };
  const path = join(world.stateDir, STATE_FILE);
  writeFileSync(path, JSON.stringify(body));
  revision += 1;
  const stamp = new Date(1700000000000 + revision * 1000);
  utimesSync(path, stamp, stamp);
}

function activityWorld(seats: Record<string, SeatSeed> = { [SEAT]: { id: SEAT_ID } }): ActivityWorld {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'presence-lifecycle-')));
  const stateDir = join(base, '.agents');
  mkdirSync(stateDir);
  const world: ActivityWorld = { base, stateDir };
  writeSeats(world, seats);
  later(() => rmSync(base, { recursive: true, force: true }));
  return world;
}

function stateFile(world: ActivityWorld): string {
  return join(world.stateDir, STATE_FILE);
}

function sessionOf(world: ActivityWorld): SessionState | undefined {
  return readState(world.stateDir).sessions[SESSION];
}

function seatOf(world: ActivityWorld): SessionState['seats'][string] | undefined {
  return sessionOf(world)?.seats?.[SEAT];
}

function ingesterFor(world: ActivityWorld): PresenceIngester {
  const ingester = createPresenceIngester({
    stateDir: world.stateDir,
    session: SESSION,
    now: () => new Date(NOW),
  });
  later(async () => {
    if (!ingester.isClosed()) await ingester.close();
  });
  return ingester;
}

function activityFor(world: ActivityWorld, seats?: readonly string[]): PresenceActivityStep {
  return createPresenceActivity({
    stateDir: world.stateDir,
    session: SESSION,
    ...(seats === undefined ? {} : { seats }),
  });
}

let nonceCounter = 0;
type StageOptions = { ts?: string; binding?: string };
function stage(world: ActivityWorld, event: PresenceEvent, options: StageOptions = {}): { id: string; ts: string } {
  const ts = options.ts ?? at(600);
  nonceCounter += 1;
  const id = presenceId(ts, nonceCounter.toString(16).padStart(8, '0'));
  if (id === null) throw new Error('the scene instant is not a presence instant');
  const staged = stagePresenceRecord(world.stateDir, {
    session: SESSION,
    seat: SEAT,
    binding: options.binding ?? BINDING,
    source: 'runtime-hook',
    event,
    ts,
    id,
  });
  if (staged.kind !== 'staged') throw new Error(staged.why);
  return { id, ts };
}

function logBytes(world: ActivityWorld): number {
  const paths = presencePaths(world.stateDir, SESSION, SEAT);
  if (paths === null) throw new Error('the scene seat cannot name a presence folder');
  return existsSync(paths.log) ? Buffer.byteLength(readFileSync(paths.log, 'utf8')) : 0;
}

function seatResult(result: PresenceActivityResult) {
  const one = result.seats.find((seat) => seat.seat === SEAT);
  if (one === undefined) throw new Error('the activity pass reported no seat');
  return one;
}

describe('canonical activity transitions between beats', () => {
  test('turns move the persisted clock forward to the event instant; an idle beat writes nothing', async () => {
    const world = activityWorld({ [SEAT]: { id: SEAT_ID, binding: BINDING, last_active: at(7200) } });
    const ingester = ingesterFor(world);
    const activity = activityFor(world);

    stage(world, 'turn-start', { ts: at(1200) });
    expect((await ingester.step()).ingested).toHaveLength(1);
    const firstBeat = new Date(NOW);
    const first = await activity(firstBeat);
    expect(seatResult(first)).toMatchObject({
      seat: SEAT, read: 1, reconciled: 1, stamped: at(1200), fence: 1, cursor: 1, busy: false, bad: null,
    });
    let seat = seatOf(world)!;
    expect(seat.last_active).toBe(at(1200));
    expect(seat.presence_applied).toEqual({
      seat_id: SEAT_ID, binding: BINDING, seq: 1, applied_at: firstBeat.toISOString(),
    });
    expect(seat.presence_scan).toEqual({ binding: BINDING, seq: 1, offset: logBytes(world) });

    stage(world, 'turn-end', { ts: at(600) });
    expect((await ingester.step()).ingested).toHaveLength(1);
    const secondBeat = new Date(NOW + 1000);
    const second = await activity(secondBeat);
    expect(seatResult(second)).toMatchObject({
      read: 1, reconciled: 1, stamped: at(600), fence: 2, cursor: 2,
    });
    seat = seatOf(world)!;
    expect(seat.last_active).toBe(at(600));
    expect(seat.presence_applied).toMatchObject({ binding: BINDING, seq: 2, applied_at: secondBeat.toISOString() });

    // No transition between this beat and the next: the pass reads nothing and writes nothing.
    const before = readFileSync(stateFile(world), 'utf8');
    const quiet = await activity(new Date(NOW + 2000));
    expect(seatResult(quiet)).toMatchObject({ read: 0, reconciled: 0, stamped: null, fence: 2, cursor: 2 });
    expect(readFileSync(stateFile(world), 'utf8')).toBe(before);
  }, 15_000);

  test('waiting and gone move the fence and leave the exact persisted stamp untouched', async () => {
    const world = activityWorld({ [SEAT]: { id: SEAT_ID, binding: BINDING, last_active: at(7200) } });
    const ingester = ingesterFor(world);
    const activity = activityFor(world);

    stage(world, 'human-wait', { ts: at(1200) });
    expect((await ingester.step()).ingested).toHaveLength(1);
    const waiting = await activity(new Date(NOW));
    expect(seatResult(waiting)).toMatchObject({
      read: 1, reconciled: 1, stamped: null, fence: 1, cursor: 1,
    });
    // An exact string, not merely "old": presence may never invent an activity instant.
    expect(seatOf(world)!.last_active).toBe(at(7200));
    expect(seatOf(world)!.presence_applied).toMatchObject({ seq: 1 });

    stage(world, 'session-end', { ts: at(600) });
    expect((await ingester.step()).ingested).toHaveLength(1);
    const gone = await activity(new Date(NOW + 1000));
    expect(seatResult(gone)).toMatchObject({
      read: 1, reconciled: 1, stamped: null, fence: 2, cursor: 2,
    });
    expect(seatOf(world)!.last_active).toBe(at(7200));
    expect(seatOf(world)!.presence_applied).toMatchObject({ binding: BINDING, seq: 2 });
  }, 15_000);

  test('only applied lines of the current binding reconcile; the cursor advances over all of them', async () => {
    const world = activityWorld({ [SEAT]: { id: SEAT_ID, binding: BINDING, last_active: at(3600) } });
    const ingester = ingesterFor(world);

    stage(world, 'turn-start', { ts: at(1800), binding: BINDING });
    expect((await ingester.step()).ingested).toHaveLength(1);
    // A relaunch mints a successor incarnation before the reconciler ever saw the predecessor.
    writeSeats(world, { [SEAT]: { id: SEAT_ID, binding: SUCCESSOR, last_active: at(3600) } });
    stage(world, 'turn-end', { ts: at(600), binding: SUCCESSOR });
    expect((await ingester.step()).ingested).toHaveLength(1);

    const lines = await readPresenceTransitions({
      stateDir: world.stateDir, session: SESSION, seat: SEAT, afterSeq: 0, afterOffset: 0,
    });
    if (lines.kind !== 'ok') throw new Error(`the log is ${lines.kind}`);
    expect(lines.transitions.map((line) => ({ binding: line.binding, applied: line.applied, seq: line.seq })))
      .toEqual([
        { binding: BINDING, applied: true, seq: 1 },
        { binding: SUCCESSOR, applied: true, seq: 2 },
      ]);

    const applied = await activityFor(world)(new Date(NOW));
    // Both lines are applied, but only the successor's is this incarnation's canonical work.
    expect(seatResult(applied)).toMatchObject({
      read: 2, reconciled: 1, stamped: at(600), fence: 2, cursor: 2,
    });
    const seat = seatOf(world)!;
    expect(seat.last_active).toBe(at(600));
    expect(seat.presence_applied).toMatchObject({ seat_id: SEAT_ID, binding: SUCCESSOR, seq: 2 });
    expect(seat.presence_scan).toEqual({ binding: SUCCESSOR, seq: 2, offset: logBytes(world) });
  }, 15_000);

  test('an audit line advances the scan cursor but never the fence or the clock', async () => {
    const world = activityWorld({ [SEAT]: { id: SEAT_ID, binding: BINDING, last_active: at(7200) } });
    const ingester = ingesterFor(world);

    stage(world, 'turn-end', { ts: at(1800) });
    expect((await ingester.step()).ingested).toHaveLength(1);
    // Older than the projection: appended for the audit, never applied.
    stage(world, 'turn-start', { ts: at(3600) });
    expect((await ingester.step()).ingested).toHaveLength(1);

    const applied = await activityFor(world)(new Date(NOW));
    expect(seatResult(applied)).toMatchObject({
      read: 2, reconciled: 1, stamped: at(1800), fence: 1, cursor: 2,
    });
    const seat = seatOf(world)!;
    expect(seat.last_active).toBe(at(1800));
    expect(seat.presence_applied).toMatchObject({ seq: 1 });
    expect(seat.presence_scan).toMatchObject({ seq: 2 });
    expect(seat.presence_scan?.seq).toBeGreaterThan(seat.presence_applied?.seq ?? 0);
  }, 15_000);

  test('a held state lock writes nothing and applies nothing; the next beat catches up', async () => {
    const world = activityWorld({ [SEAT]: { id: SEAT_ID, binding: BINDING, last_active: at(7200) } });
    const ingester = ingesterFor(world);
    const activity = activityFor(world);

    stage(world, 'turn-end', { ts: at(600) });
    expect((await ingester.step()).ingested).toHaveLength(1);
    const before = readFileSync(stateFile(world), 'utf8');
    const lock = join(world.stateDir, LOCK_FILE);
    writeFileSync(lock, `${String(process.pid)}\n`);
    const busy = await activity(new Date(NOW));
    expect(seatResult(busy)).toMatchObject({
      read: 1, reconciled: 0, stamped: null, fence: null, cursor: 0, busy: true, bad: null,
    });
    expect(readFileSync(stateFile(world), 'utf8')).toBe(before);
    unlinkSync(lock);

    const caughtUp = await activity(new Date(NOW + 1000));
    expect(seatResult(caughtUp)).toMatchObject({ read: 1, reconciled: 1, stamped: at(600), cursor: 1, busy: false });
    expect(seatOf(world)!.last_active).toBe(at(600));
  }, 15_000);

  test('a transition for a seat with no state record writes nothing and creates no record', async () => {
    const world = activityWorld({ [SEAT]: { id: SEAT_ID, binding: BINDING } });
    const ingester = ingesterFor(world);
    stage(world, 'turn-end', { ts: at(600) });
    expect((await ingester.step()).ingested).toHaveLength(1);
    // The record disappears between the append and the reconcile: presence must not resurrect it.
    writeSeats(world, {});
    const before = readFileSync(stateFile(world), 'utf8');

    const result = await activityFor(world, [SEAT])(new Date(NOW));
    // The pass reports no transition for a seat it will not create; the invariant is the written
    // state, which keeps the missing record missing and its bytes untouched.
    expect(seatResult(result)).toMatchObject({
      seat: SEAT, reconciled: 0, stamped: null, fence: null, cursor: 0, busy: false, bad: null,
    });
    expect(readFileSync(stateFile(world), 'utf8')).toBe(before);
    expect(sessionOf(world)?.seats?.[SEAT]).toBeUndefined();
  }, 15_000);
});

// ---------------------------------------------------------------- host fixtures

function emptyIngest(): PresenceIngestResult {
  return { ingested: [], rejected: [], stale: [], repaired: [], errors: [], pending: false, closed: false };
}

function activityResult(): PresenceActivityResult {
  return { seats: [], failed: null };
}

type Scratch = { base: string; root: string; home: string };

function scratch(): Scratch {
  const made = realpathSync(mkdtempSync(join(tmpdir(), 'presence-close-acceptance-')));
  const repo = join(made, 'repo');
  const home = join(made, 'home');
  mkdirSync(join(repo, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, '.agents', 'team.yaml'), CREW);
  return { base: made, root: repo, home };
}

let world: Scratch = { base: '', root: '', home: '' };

beforeEach(() => {
  world = scratch();
  later(() => rmSync(world.base, { recursive: true, force: true }));
});

async function start(overrides: Partial<StartMachineDaemonInput>) {
  const started = await startMachineDaemon({
    home: world.home,
    roots: [world.root],
    startedBy: 'service-manager',
    version: '0.5.3-presence-close-acceptance',
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

/** One successful connect is the whole liveness answer a bus socket has. */
function listening(socketPath: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ path: socketPath });
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('error', () => finish(false));
    socket.on('connect', () => finish(true));
    socket.on('close', () => finish(false));
  });
}

describe('admission against a close that cannot finish', () => {
  test('a watch stop that never resolves does not leave send or bus admitting behind it', async () => {
    let release: (() => void) | null = null;
    let closing: Promise<void> | null = null;
    const ingester: PresenceIngester = {
      step: async () => emptyIngest(),
      close: async () => ({ quiesced: true }),
      isClosed: () => false,
    };
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: () => ingester,
      presenceActivity: () => async () => activityResult(),
      watchHosting: true,
      hostedWatch: () => ({
        run: () => new Promise<number>((resolve) => { release = () => resolve(0); }),
      }),
    });
    try {
      await waitUntil(() => release !== null);

      const bus = busSocket(world.root);
      const send = sendDaemonSocketPath('acme-web', world.root, world.home);
      expect(await listening(bus)).toBe(true);
      expect(await listening(send)).toBe(true);

      closing = daemon.close();
      // Long enough for every admission stop to be initiated and for the endpoints to stop
      // admitting; the watch stop is still held, so this is not the drain.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await listening(bus)).toBe(false);
      expect(await listening(send)).toBe(false);

      // Ownership is retained until the drain is truthful, and the record says it is closing.
      expect(existsSync(daemonLockPath(world.home))).toBe(true);
      expect(existsSync(daemonSocketPath(world.home))).toBe(true);
      const read = readDaemonState(world.home);
      expect(read.kind).toBe('ok');
      if (read.kind === 'ok') {
        expect(read.state.roots[0]?.presence).toEqual({ state: 'pending', why: 'the daemon is closing' });
      }

      release!();
      await closing;
      expect(existsSync(daemonLockPath(world.home))).toBe(false);
      expect(existsSync(daemonSocketPath(world.home))).toBe(false);
    } finally {
      // A red assertion must not leave the held stop behind for the process teardown.
      (release as (() => void) | null)?.();
      if (closing !== null) await closing.catch(() => undefined);
    }
  }, 15_000);

  test('a hung presence pass still leaves the record saying pending, with ownership retained', async () => {
    let release: (() => void) | null = null;
    let closing: Promise<void> | null = null;
    const ingester: PresenceIngester = {
      step: () => new Promise<PresenceIngestResult>((resolve) => { release = () => resolve(emptyIngest()); }),
      close: async () => ({ quiesced: true }),
      isClosed: () => false,
    };
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: () => ingester,
      presenceActivity: () => async () => activityResult(),
    });
    try {
      await waitUntil(() => release !== null);

      closing = daemon.close();
      await new Promise((resolve) => setTimeout(resolve, 150));
      // The unbounded drain must not leave the old serving record standing behind it.
      const read = readDaemonState(world.home);
      expect(read.kind).toBe('ok');
      if (read.kind === 'ok') {
        expect(read.state.roots[0]?.presence?.state).toBe('pending');
        expect(read.state.roots[0]?.presence?.why).toBeTruthy();
      }
      expect(existsSync(daemonLockPath(world.home))).toBe(true);

      release!();
      await closing;
      expect(existsSync(daemonLockPath(world.home))).toBe(false);
      expect(readDaemonState(world.home).kind).toBe('missing');
    } finally {
      (release as (() => void) | null)?.();
      if (closing !== null) await closing.catch(() => undefined);
    }
  }, 15_000);

  test('a non-quiescent ingester close is asked again on a later close and releases once it quiesces', async () => {
    let closeCalls = 0;
    const ingester: PresenceIngester = {
      step: async () => emptyIngest(),
      close: async () => {
        closeCalls += 1;
        return (closeCalls === 1
          ? { quiesced: false, why: 'the presence log write is stuck' }
          : { quiesced: true }) as unknown as { quiesced: true };
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
    const pending = readDaemonState(world.home);
    expect(pending.kind).toBe('ok');
    if (pending.kind === 'ok') {
      expect(pending.state.roots[0]?.presence).toEqual({
        state: 'pending',
        why: 'the presence log write is stuck',
      });
    }

    // A false answer is not the final answer: the next close asks the handle again.
    await daemon.close();
    expect(closeCalls).toBe(2);
    expect(existsSync(daemonLockPath(world.home))).toBe(false);
    expect(existsSync(daemonSocketPath(world.home))).toBe(false);
    expect(readDaemonState(world.home).kind).toBe('missing');
  }, 15_000);
});
