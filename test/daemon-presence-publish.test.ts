// The presence publisher and the read-only feed, against a synthetic world: a temporary project
// state folder, a team state record naming one seat's runtime binding, a temporary home and
// checkout root. The scenes drive the real ingester first (spool records exactly as a runtime
// hook writes them), then the real publisher (bus appends through `appendEvent`), then the real
// verified reader, so the proof is an actual ingester → publisher → bus log → feed path.
//
// Pinned here: the payload and stable identity; applied current-binding lines only; a binding
// that changes between the ingester's append and the publish leaves the old line unpublished; a
// daemon restart's replay dedupes against the retained bus log; a failed append holds the seat's
// cursor and the existing pass retries it after its backoff; and a self-contradicting bus record
// is dropped whole rather than shown. No live session, credential or pane is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, rmdirSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENT_KINDS } from '../src/bus/kinds.ts';
import { EVENT_ROUTING_DEFAULTS } from '../src/policy/events.ts';
import { appendEvent, eventLogPath } from '../src/bus/log.ts';
import {
  PRESENCE_STATE_OF, presenceId,
  type PresenceEvent, type PresenceWriterSource,
} from '../src/daemon/presence/contract.ts';
import { createPresenceIngester, type PresenceIngester } from '../src/daemon/presence/ingest.ts';
import { createPresencePublisher, presenceRecordIdOf } from '../src/daemon/presence/publish.ts';
import { readPresenceFeed } from '../src/daemon/presence/feed.ts';
import { stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import { STATE_FILE } from '../src/state.ts';

const SESSION = 'teamcli';
const SEAT = 'builder-5';
const BINDING = 'prs_0123456789ab';
const SUCCESSOR = 'prs_fedcba987654';
const PROJECT = 'acme';
// Fixed offsets from a recent instant: the ingester refuses a runtime event too far ahead of its
// own clock, so the scene's staged records start in the past, never at a wall-clock guess.
const T0 = Date.now() - 120_000;

type World = {
  base: string;
  stateDir: string;
  root: string;
  home: string;
  binding: string;
};

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
/** Writes the team state record the ingester and the publisher read a seat's binding from. The
 *  increasing mtime lets the ingester's stat cache observe every rewrite. */
function writeSeats(world: World, binding: string | null, session = SESSION): void {
  const seat = binding === null ? { stage: 'ready' } : { stage: 'ready', presence_binding: binding };
  const path = join(world.stateDir, STATE_FILE);
  writeFileSync(path, JSON.stringify({ format: 1, sessions: { [session]: { seats: { [SEAT]: seat }, worktrees: {} } } }));
  revision += 1;
  const stamp = new Date(1700000000000 + revision * 1000);
  utimesSync(path, stamp, stamp);
  world.binding = binding ?? world.binding;
}

function makeWorld(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-presence-publish-')));
  const stateDir = join(base, '.agents');
  mkdirSync(stateDir);
  const world: World = { base, stateDir, root: join(base, 'repo'), home: join(base, 'home'), binding: BINDING };
  writeSeats(world, BINDING);
  later(() => rmSync(base, { recursive: true, force: true }));
  return world;
}

function ingesterFor(world: World): PresenceIngester {
  const ingester = createPresenceIngester({ stateDir: world.stateDir, session: SESSION });
  later(async () => {
    if (!ingester.isClosed()) await ingester.close();
  });
  return ingester;
}

function publisherFor(world: World, retryMs?: number) {
  return createPresencePublisher({
    stateDir: world.stateDir,
    session: SESSION,
    project: PROJECT,
    root: world.root,
    home: world.home,
    ...(retryMs === undefined ? {} : { retryMs }),
  });
}

let nonceCounter = 0;
function stage(
  world: World,
  event: PresenceEvent,
  at: number,
  options: { binding?: string; source?: PresenceWriterSource } = {},
): { id: string; ts: string } {
  nonceCounter += 1;
  const ts = new Date(at).toISOString();
  const id = presenceId(ts, nonceCounter.toString(16).padStart(8, '0'));
  if (id === null) throw new Error('the test supplied an invalid event instant');
  const staged = stagePresenceRecord(world.stateDir, {
    session: SESSION,
    seat: SEAT,
    binding: options.binding ?? world.binding,
    source: options.source ?? 'runtime-hook',
    event,
    ts,
    id,
  });
  if (staged.kind !== 'staged') throw new Error(staged.why);
  return { id, ts };
}

function feedAfter(world: World, after = 0) {
  return readPresenceFeed(PROJECT, world.root, world.home, { after });
}

describe('presence.changed: kind, payload and routing', () => {
  test('is a closed-table kind routed to nobody by default', () => {
    expect(EVENT_KINDS).toContain('presence.changed');
    expect(EVENT_ROUTING_DEFAULTS['presence.changed']).toEqual([]);
  });
});

describe('an actual ingester → publisher → verified feed', () => {
  test('every applied transition reaches the feed with its contract fields and stable id', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    const events: Array<{ event: PresenceEvent; at: number }> = [
      { event: 'turn-start', at: T0 },
      { event: 'turn-end', at: T0 + 1000 },
      { event: 'human-wait', at: T0 + 2000 },
      { event: 'session-end', at: T0 + 3000 },
    ];
    const staged = events.map((one) => ({ ...one, ...stage(world, one.event, one.at) }));

    const ingest = await ingester.step();
    expect(ingest.ingested).toHaveLength(4);
    expect(ingest.errors).toEqual([]);

    const publisher = publisherFor(world);
    const step = await publisher(new Date(T0 + 4000));
    expect(step.failed).toBeNull();
    expect(step.seats).toHaveLength(1);
    const seat = step.seats[0]!;
    expect(seat.seat).toBe(SEAT);
    expect(seat.read).toBe(4);
    expect(seat.published).toBe(4);
    expect(seat.duplicate).toBe(0);
    expect(seat.skipped).toBe(0);
    expect(seat.cursor).toBe(4);
    expect(seat.failure).toBeNull();
    expect(seat.bad).toBeNull();

    const feed = feedAfter(world);
    expect(feed.kind).toBe('ok');
    if (feed.kind !== 'ok') return;
    expect(feed.cursor).toBe(4);
    expect(feed.oldestSeq).toBe(1);
    expect(feed.newestSeq).toBe(4);
    expect(feed.unverified).toBe(0);
    expect(feed.events).toHaveLength(4);
    for (const [index, event] of feed.events.entries()) {
      const expected = staged[index]!;
      expect(event.seq).toBe(index + 1);
      expect(event.ts).toBe(expected.ts);
      expect(event.session).toBe(SESSION);
      expect(event.seat).toBe(SEAT);
      expect(event.state).toBe(PRESENCE_STATE_OF[expected.event]);
      expect(event.event).toBe(expected.event);
      expect(event.source).toBe('runtime-hook');
      expect(event.binding).toBe(BINDING);
      expect(event.presenceSeq).toBe(index + 1);
      expect(event.eventId).toBe(expected.id);
      expect(event.recordId).toBe(presenceRecordIdOf(SEAT, { binding: BINDING, seq: index + 1, id: expected.id }));
      expect(Number.isFinite(Date.parse(event.observedAt))).toBe(true);
    }
  });

  test('a daemon restart replays the durable log and the bus log answers duplicate', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    stage(world, 'turn-start', T0);
    stage(world, 'turn-end', T0 + 1000);
    await ingester.step();

    const first = await publisherFor(world)(new Date(T0 + 2000));
    expect(first.seats[0]!.published).toBe(2);
    const before = feedAfter(world);
    expect(before.kind).toBe('ok');
    if (before.kind !== 'ok') return;
    expect(before.events).toHaveLength(2);

    // A fresh publisher object is a fresh daemon run: its cursor is (0, 0) again.
    const replay = await publisherFor(world)(new Date(T0 + 3000));
    const seat = replay.seats[0]!;
    expect(seat.read).toBe(2);
    expect(seat.published).toBe(0);
    expect(seat.duplicate).toBe(2);
    expect(seat.cursor).toBe(2);
    expect(seat.failure).toBeNull();

    const after = feedAfter(world);
    expect(after.kind).toBe('ok');
    if (after.kind !== 'ok') return;
    expect(after.events).toHaveLength(2);
    expect(after.newestSeq).toBe(before.newestSeq);
  });

  test('a binding that changes before the publish skips the old line without inventing a successor', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    const old = stage(world, 'turn-start', T0);
    await ingester.step();

    // The ingester appended an applied line under BINDING; the seat is relaunched before the
    // publisher runs, so that line is now a predecessor's. It must not reach the feed.
    writeSeats(world, SUCCESSOR);
    const publisher = publisherFor(world);
    const skipped = await publisher(new Date(T0 + 1000));
    const skipSeat = skipped.seats[0]!;
    expect(skipSeat.read).toBe(1);
    expect(skipSeat.published).toBe(0);
    expect(skipSeat.skipped).toBe(1);
    expect(skipSeat.cursor).toBe(1);
    expect(skipSeat.failure).toBeNull();
    let feed = feedAfter(world);
    expect(feed.kind).toBe('ok');
    if (feed.kind !== 'ok') return;
    expect(feed.events).toEqual([]);

    // The successor's own applied transition publishes normally.
    stage(world, 'turn-start', T0 + 2000);
    await ingester.step();
    const published = await publisher(new Date(T0 + 3000));
    expect(published.seats[0]!.published).toBe(1);
    feed = feedAfter(world);
    expect(feed.kind).toBe('ok');
    if (feed.kind !== 'ok') return;
    expect(feed.events).toHaveLength(1);
    expect(feed.events[0]!.binding).toBe(SUCCESSOR);
    expect(feed.events[0]!.eventId).not.toBe(old.id);
  });

  test('an older late line is consumed as a skip, never published as the newest state', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    stage(world, 'turn-end', T0 + 2000);
    const publishOne = publisherFor(world);
    await ingester.step();
    expect((await publishOne(new Date(T0 + 3000))).seats[0]!.published).toBe(1);

    // An older turn-start arrives late. The ingester keeps it in the durable log with
    // `applied: false` because it did not become the projection; the publisher consumes it
    // without publishing it, so the feed's newest word stays the applied `idle`.
    stage(world, 'turn-start', T0 + 1000);
    const late = await ingester.step();
    expect(late.stale).toEqual([]);
    expect(late.ingested).toHaveLength(1);
    expect(late.ingested[0]!.applied).toBe(false);
    const step = await publishOne(new Date(T0 + 4000));
    const seat = step.seats[0]!;
    expect(seat.read).toBe(1);
    expect(seat.published).toBe(0);
    expect(seat.skipped).toBe(1);
    expect(seat.cursor).toBe(2);

    const feed = feedAfter(world);
    expect(feed.kind).toBe('ok');
    if (feed.kind !== 'ok') return;
    expect(feed.events.map((event) => event.state)).toEqual(['idle']);
    expect(feed.events.map((event) => event.presenceSeq)).toEqual([1]);
  });

  test('a failed append holds the cursor and the existing backoff pass retries it', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    stage(world, 'turn-start', T0);
    await ingester.step();

    // Force the bus append to fail: a directory stands where the event log file belongs.
    const logPath = eventLogPath(PROJECT, world.root, world.home);
    mkdirSync(logPath, { recursive: true });
    const publisher = publisherFor(world, 5000);
    const at = T0 + 1000;
    const failed = await publisher(new Date(at));
    const failedSeat = failed.seats[0]!;
    expect(typeof failedSeat.failure).toBe('string');
    expect(failedSeat.published).toBe(0);
    expect(failedSeat.cursor).toBe(0);
    expect(failedSeat.retryAt).toBe(at + 5000);

    // Inside the backoff the same pass does not attempt the seat again.
    const waiting = await publisher(new Date(at + 1000));
    expect(waiting.seats[0]!.read).toBe(0);
    expect(waiting.seats[0]!.failure).toBeNull();
    expect(waiting.seats[0]!.retryAt).toBe(at + 5000);

    // Once the obstruction is gone, the retry publishes the line the cursor held.
    rmdirSync(logPath);
    const retried = await publisher(new Date(at + 5001));
    const retrySeat = retried.seats[0]!;
    expect(retrySeat.failure).toBeNull();
    expect(retrySeat.published).toBe(1);
    expect(retrySeat.cursor).toBe(1);
    const feed = feedAfter(world);
    expect(feed.kind).toBe('ok');
    if (feed.kind !== 'ok') return;
    expect(feed.events).toHaveLength(1);
    expect(feed.events[0]!.state).toBe('working');
  });
});

describe('the verified feed refuses to guess', () => {
  test('a self-contradicting or misidentified presence record is dropped whole', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    stage(world, 'turn-start', T0);
    await ingester.step();
    await publisherFor(world)(new Date(T0 + 1000));

    const observedAt = new Date(T0 + 1000).toISOString();
    const eventAt = new Date(T0 + 2000).toISOString();
    const eventId = `${eventAt}-deadbeef`;
    // state contradicts its event: idle is not what a turn-start establishes.
    const contradictory = appendEvent(PROJECT, world.root, world.home, {
      ts: eventAt,
      kind: 'presence.changed',
      session: SESSION,
      record_id: 'presence:builder-5:prs_0123456789ab:9:not-the-derived-id',
      seat: SEAT,
      presence_state: 'idle',
      presence_event: 'turn-start',
      presence_source: 'runtime-hook',
      presence_binding: BINDING,
      presence_event_id: eventId,
      presence_observed_at: observedAt,
      presence_seq: 9,
    });
    expect(contradictory.ok).toBe(true);
    // A coherent pair under an id the publisher would never derive.
    const misidentified = appendEvent(PROJECT, world.root, world.home, {
      ts: eventAt,
      kind: 'presence.changed',
      session: SESSION,
      record_id: 'presence:builder-5:prs_0123456789ab:9:trust-me',
      seat: SEAT,
      presence_state: 'working',
      presence_event: 'turn-start',
      presence_source: 'runtime-hook',
      presence_binding: BINDING,
      presence_event_id: eventId,
      presence_observed_at: observedAt,
      presence_seq: 9,
    });
    expect(misidentified.ok).toBe(true);

    const feed = feedAfter(world);
    expect(feed.kind).toBe('ok');
    if (feed.kind !== 'ok') return;
    expect(feed.events).toHaveLength(1);
    expect(feed.events[0]!.eventId).not.toBe(eventId);
    expect(feed.events[0]!.recordId).not.toBe('presence:builder-5:prs_0123456789ab:9:trust-me');
    expect(feed.unverified).toBe(0);
  });

  test('a missing bus log is an empty feed, not an invented one', () => {
    const world = makeWorld();
    expect(existsSync(eventLogPath(PROJECT, world.root, world.home))).toBe(false);
    const feed = feedAfter(world);
    expect(feed.kind).toBe('ok');
    if (feed.kind !== 'ok') return;
    expect(feed.events).toEqual([]);
    expect(feed.cursor).toBe(0);
    expect(feed.oldestSeq).toBeNull();
    expect(feed.newestSeq).toBeNull();
  });
});
