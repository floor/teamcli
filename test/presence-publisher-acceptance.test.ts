// Independent acceptance for the presence publisher and its verified feed, at the actual
// publisher/feed SHA cfa5bb91f: a real synthetic state record, real spool records through the
// real ingester, the publisher's own bounded step, then the bus log's verified reader and the
// feed adapter. No pane, seat, owner home or live runtime is touched; every world lives under
// `/private/tmp`.
//
// What these scenes hold the publisher to:
//   - every applied line of the current binding reaches the bus as `presence.changed` with the
//     publisher's derived identity, no body and no sender/recipient;
//   - a restart replays the durable log and the retained bus records answer duplicate;
//   - a failed append holds the cursor, backs off, and recovers without inventing success;
//   - another binding's applied line, and a not-applied line, are skipped and consumed;
//   - the feed returns only whole, self-consistent records, and the bus's own gap answer;
//   - retention permits republication after the old records are gone: the same record identity
//     can appear in the feed again under a new bus sequence. No exactly-once claim is made.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import { recipientsForEvent } from '../src/bus/kinds.ts';
import { appendEvent, readEvents } from '../src/bus/log.ts';
import { readPresenceFeed } from '../src/daemon/presence/feed.ts';
import { createPresenceIngester } from '../src/daemon/presence/ingest.ts';
import { createPresencePublisher, presenceRecordIdOf } from '../src/daemon/presence/publish.ts';
import type { PresenceEvent } from '../src/daemon/presence/contract.ts';
import { stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import { emptySession, updateState } from '../src/state.ts';

const PROJECT = 'acme';
const SESSION = 'teamcli';
const SEAT = 'worker';
const BINDING = 'prs_0123456789ab';
const PREDECESSOR = 'prs_ba9876543210';

// The ingester refuses an event clock too far in the future, so the scenes' fixed instants are
// yesterday's; only their order matters to the publisher.
const T1 = '2026-10-19T10:00:00.000Z';
const T2 = '2026-10-19T10:00:01.000Z';
const T3 = '2026-10-19T10:00:02.000Z';
const T4 = '2026-10-19T10:00:03.000Z';
const T5 = '2026-10-19T10:00:04.000Z';
const T0 = '2026-10-19T09:59:59.000Z';

describe('presence transitions reach the bus with their own identity and no audience', () => {
  let root: string;
  let dir: string;
  let home: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync('/private/tmp/b7-publish-world-'));
    dir = join(root, '.agents');
    mkdirSync(dir);
    home = join(root, 'home');
    mkdirSync(home);
    updateState(dir, (state) => {
      state.sessions[SESSION] = {
        ...emptySession(),
        seats: {
          worker: {
            id: 'seat_111111111111',
            pane: 'pane-1',
            workspace: 'ws-1',
            stage: 'ready',
            model: 'Claude Opus',
            version: '5.5',
            launch_line: 'claude --model claude-opus-5-5',
            presence_binding: BINDING,
          },
        },
      };
    });
  });

  function setBinding(binding: string): void {
    updateState(dir, (state) => {
      state.sessions[SESSION] = {
        ...emptySession(),
        seats: {
          worker: {
            id: 'seat_111111111111',
            pane: 'pane-1',
            workspace: 'ws-1',
            stage: 'ready',
            model: 'Claude Opus',
            version: '5.5',
            launch_line: 'claude --model claude-opus-5-5',
            presence_binding: binding,
          },
        },
      };
    });
  }

  function stage(event: PresenceEvent, ts: string, binding = BINDING): void {
    const staged = stagePresenceRecord(dir, {
      session: SESSION,
      seat: SEAT,
      binding,
      source: 'runtime-hook',
      event,
      ...(event === 'human-wait' ? { raw: 'permission_prompt' } : {}),
      ts,
    });
    if (staged.kind !== 'staged') throw new Error(`the scene could not stage ${event}: ${staged.why}`);
  }

  async function ingest(): Promise<void> {
    const ingester = createPresenceIngester({ stateDir: dir, session: SESSION });
    try {
      await ingester.step();
    } finally {
      await ingester.close();
    }
  }

  function publisher(over: { home?: string; maxRecords?: number; retryMs?: number } = {}) {
    return createPresencePublisher({
      stateDir: dir,
      session: SESSION,
      project: PROJECT,
      root,
      home: over.home ?? home,
      seats: [SEAT],
      ...(over.maxRecords === undefined ? {} : { maxRecords: over.maxRecords }),
      ...(over.retryMs === undefined ? {} : { retryMs: over.retryMs }),
    });
  }

  function seatOf(result: Awaited<ReturnType<ReturnType<typeof publisher>>>) {
    const found = result.seats.find((entry) => entry.seat === SEAT);
    if (found === undefined) throw new Error('the publisher reported no row for the seat');
    return found;
  }

  function bus() {
    const read = readEvents(PROJECT, root, home);
    if (!read.ok) throw new Error(`the bus log could not be read: ${read.reason}`);
    return read;
  }

  function feed(after = 0) {
    const read = readPresenceFeed(PROJECT, root, home, { after });
    if (read.kind !== 'ok') throw new Error(`the feed answered ${read.kind}`);
    return read;
  }

  test('three applied transitions are published whole, verified and without a sender or recipient', async () => {
    stage('turn-start', T1);
    stage('human-wait', T2);
    stage('turn-end', T3);
    await ingest();

    const step = publisher();
    const result = await step(new Date());
    expect(result.failed).toBeNull();
    expect(seatOf(result)).toMatchObject({
      read: 3,
      published: 3,
      duplicate: 0,
      skipped: 0,
      cursor: 3,
      failure: null,
      bad: null,
    });

    const read = bus();
    expect(read.events).toHaveLength(3);
    expect(read.unverified).toBe(0);
    expect(read.events.map((record) => record.payload.kind)).toEqual([
      'presence.changed',
      'presence.changed',
      'presence.changed',
    ]);
    const first = read.events[0]!.payload;
    // Held before the matcher assertion: the event id is the identity's last segment either way.
    const firstEventId = String(first.presence_event_id);
    // A copy: bun's `toMatchObject` writes the asymmetric matcher into the object it receives,
    // and that object is the bus reader's own payload (the feed reads the same checkpoint).
    expect({ ...first }).toMatchObject({
      session: SESSION,
      seat: SEAT,
      presence_state: 'working',
      presence_event: 'turn-start',
      presence_source: 'runtime-hook',
      presence_binding: BINDING,
      presence_event_id: expect.stringMatching(/^2026-10-19T10:00:00\.000Z-[0-9a-f]{8}$/),
      presence_observed_at: expect.any(String),
      presence_seq: 1,
    });
    expect(first.record_id).toBe(presenceRecordIdOf(SEAT, {
      binding: BINDING,
      seq: 1,
      id: firstEventId,
    }));
    for (const absent of ['from', 'to', 'subject']) {
      expect(first).not.toHaveProperty(absent);
    }
    const team = {
      orchestrator: 'orchestrator',
      operator: 'operator',
      seats: [{ name: SEAT }, { name: 'lead', leads: true }],
    };
    expect(recipientsForEvent(first, team)).toEqual(new Set());

    const answered = feed();
    expect(answered.events).toHaveLength(3);
    expect(answered.cursor).toBe(3);
    expect(answered.unverified).toBe(0);
    expect(answered.events.map((event) => event.event)).toEqual(['turn-start', 'human-wait', 'turn-end']);
    expect(answered.events.map((event) => event.recordId)).toEqual(
      read.events.map((record) => record.payload.record_id),
    );
    expect(answered.events[1]).toMatchObject({
      seat: SEAT,
      state: 'waiting-for-a-person',
      event: 'human-wait',
      source: 'runtime-hook',
      binding: BINDING,
      presenceSeq: 2,
    });
  });

  test('a restarted publisher replays the durable log and the retained records answer duplicate', async () => {
    stage('turn-start', T1);
    stage('human-wait', T2);
    stage('turn-end', T3);
    await ingest();

    const first = publisher();
    expect(seatOf(await first(new Date()))).toMatchObject({ published: 3, duplicate: 0, cursor: 3 });
    const second = publisher();
    expect(seatOf(await second(new Date()))).toMatchObject({ published: 0, duplicate: 3, cursor: 3 });
    expect(seatOf(await first(new Date()))).toMatchObject({ read: 0, published: 0, duplicate: 0, cursor: 3 });

    expect(bus().events).toHaveLength(3);
    expect(feed().events).toHaveLength(3);
  });

  test('a failed append holds the cursor and backs off; recovery publishes the held batch once', async () => {
    stage('turn-start', T1);
    stage('human-wait', T2);
    stage('turn-end', T3);
    await ingest();

    const blocked = join(root, 'blocked-home');
    writeFileSync(blocked, 'not a directory\n');
    const step = publisher({ home: blocked, retryMs: 1_000 });
    const t0 = new Date();
    const failed = await step(t0);
    const held = seatOf(failed);
    expect(held).toMatchObject({
      read: 3,
      published: 0,
      duplicate: 0,
      cursor: 0,
      failure: expect.any(String),
      retryAt: t0.getTime() + 1_000,
    });
    expect(existsSync(join(blocked, '.config'))).toBe(false);

    const backingOff = await step(new Date(t0.getTime() + 999));
    expect(seatOf(backingOff)).toMatchObject({
      read: 0,
      published: 0,
      duplicate: 0,
      cursor: 0,
      failure: null,
      retryAt: t0.getTime() + 1_000,
    });

    unlinkSync(blocked);
    mkdirSync(blocked);
    const recovered = await step(new Date(t0.getTime() + 1_000));
    expect(seatOf(recovered)).toMatchObject({
      read: 3,
      published: 3,
      duplicate: 0,
      cursor: 3,
      failure: null,
      retryAt: null,
    });
    const read = readEvents(PROJECT, root, blocked);
    if (!read.ok) throw new Error(`the recovered bus log could not be read: ${read.reason}`);
    expect(read.events).toHaveLength(3);
    expect(read.unverified).toBe(0);
  });

  test('a bounded step publishes a prefix, and the next step continues from its committed cursor', async () => {
    stage('turn-start', T1);
    stage('human-wait', T2);
    stage('turn-start', T3);
    stage('turn-end', T4);
    stage('human-wait', T5);
    await ingest();

    const step = publisher({ maxRecords: 2 });
    expect(seatOf(await step(new Date()))).toMatchObject({ read: 2, published: 2, cursor: 2 });
    expect(seatOf(await step(new Date()))).toMatchObject({ read: 2, published: 2, cursor: 4 });
    expect(seatOf(await step(new Date()))).toMatchObject({ read: 1, published: 1, cursor: 5 });
    expect(seatOf(await step(new Date()))).toMatchObject({ read: 0, published: 0, cursor: 5 });
    expect(bus().events).toHaveLength(5);
    expect(feed().events).toHaveLength(5);
  });

  test('another binding and a not-applied line are skipped, consumed and never published', async () => {
    // The predecessor's line is ingested while its own binding is the managed one, so it really is
    // applied in the durable log. The seat then launches a successor, whose first event carries an
    // earlier clock than the predecessor's human-wait.
    setBinding(PREDECESSOR);
    stage('human-wait', T2, PREDECESSOR);
    await ingest();
    setBinding(BINDING);
    stage('turn-start', T1);
    await ingest();

    const step = publisher();
    expect(seatOf(await step(new Date()))).toMatchObject({
      read: 2,
      published: 1,
      duplicate: 0,
      skipped: 1,
      cursor: 2,
    });
    expect(feed().events.map((event) => event.binding)).toEqual([BINDING]);
    expect(feed().events.map((event) => event.event)).toEqual(['turn-start']);

    // An out-of-order event of the current binding is in the log without being applied.
    stage('turn-end', T0);
    await ingest();
    expect(seatOf(await step(new Date()))).toMatchObject({
      read: 1,
      published: 0,
      duplicate: 0,
      skipped: 1,
      cursor: 3,
    });
    expect(bus().events).toHaveLength(1);
    expect(feed().events).toHaveLength(1);
  });

  test('the feed drops a self-contradicting or incomplete presence record whole and filters other kinds', async () => {
    stage('turn-start', T1);
    stage('human-wait', T2);
    stage('turn-end', T3);
    await ingest();
    await publisher()(new Date());
    const before = feed();
    expect(before.events).toHaveLength(3);

    const stamp = '2026-10-19T10:05:00.000Z';
    const eventId = `${stamp}-deadbeef`;
    const contradicting = appendEvent(PROJECT, root, home, {
      ts: stamp,
      kind: 'presence.changed',
      session: SESSION,
      record_id: presenceRecordIdOf(SEAT, { binding: BINDING, seq: 9, id: eventId }),
      seat: SEAT,
      presence_state: 'idle',
      presence_event: 'turn-start',
      presence_source: 'runtime-hook',
      presence_binding: BINDING,
      presence_event_id: eventId,
      presence_observed_at: stamp,
      presence_seq: 9,
    }, { deduplicate: false });
    expect(contradicting.ok).toBe(true);
    const incomplete = appendEvent(PROJECT, root, home, {
      ts: stamp,
      kind: 'presence.changed',
      session: SESSION,
      record_id: 'presence:not-whole',
      seat: SEAT,
    }, { deduplicate: false });
    expect(incomplete.ok).toBe(true);
    const otherKind = appendEvent(PROJECT, root, home, {
      ts: stamp,
      kind: 'seat.idle',
      session: SESSION,
      record_id: 'not-a-presence-record',
      seat: SEAT,
    }, { deduplicate: false });
    expect(otherKind.ok).toBe(true);

    const raw = bus();
    expect(raw.events).toHaveLength(6);
    expect(raw.unverified).toBe(0);
    const after = feed();
    expect(after.events).toHaveLength(3);
    expect(after.events.map((event) => event.recordId)).toEqual(before.events.map((event) => event.recordId));
    expect(after.cursor).toBe(6);
  });

  test('retention permits republication: the same record identity returns under a new bus sequence', async () => {
    stage('turn-start', T1);
    stage('human-wait', T2);
    stage('turn-end', T3);
    await ingest();
    await publisher()(new Date());

    const before = feed();
    expect(before.events).toHaveLength(3);
    const identities = before.events.map((event) => event.recordId);

    // One direct append trips the size bounds, rotating the live file into a sealed segment and
    // dropping it whole; the pass declares the dropped range in the live log.
    const probe = appendEvent(PROJECT, root, home, {
      ts: new Date().toISOString(),
      kind: 'seat.idle',
      session: SESSION,
      record_id: 'retention-probe',
      seat: SEAT,
    }, { kept: 2, maxBytes: 1, maxTotalBytes: 1, retentionSeconds: 10 * 365 * 86_400 });
    expect(probe.ok).toBe(true);
    if (!probe.ok) throw new Error('unreachable');

    // A follower that had read only sequence 1 now finds sequence 2..3 gone: the bus answers its
    // own declared retention gap, never a silent skip.
    const gap = readPresenceFeed(PROJECT, root, home, { after: 1 });
    expect(gap.kind).toBe('gap');
    if (gap.kind !== 'gap') throw new Error('unreachable');
    expect(gap).toMatchObject({
      oldest_seq: 4,
      reason: 'retention',
      dropped_oldest_seq: 2,
      dropped_newest_seq: 3,
    });

    // A fresh publisher (a daemon restart) has no cursor and replays the durable presence log.
    // The bus no longer retains the old records, so dedupe finds nothing and the same identities
    // are appended again under new sequences. That is the documented consequence, not a global
    // exactly-once promise.
    const restarted = publisher();
    expect(seatOf(await restarted(new Date()))).toMatchObject({
      read: 3,
      published: 3,
      duplicate: 0,
      cursor: 3,
    });
    const after = feed(gap.oldest_seq - 1);
    expect(after.events).toHaveLength(3);
    expect(after.events.map((event) => event.recordId)).toEqual(identities);
    for (const event of after.events) expect(event.seq).toBeGreaterThan(probe.record.payload.seq);
  });
});
