import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkPrivilegedSelfSubscription,
  DEFAULT_OWNER_AT_ONCE_KINDS,
  DEFAULT_PRIVILEGED_KINDS,
  DEFAULT_RECONCILE_INTERVAL_SECONDS,
  DEFAULT_SUBSCRIBER_BUFFER_LIMIT,
  EVENT_KINDS,
  isEventKind,
  isOwnerAtOnce,
  isPrivilegedKind,
  PRIVILEGED_SELF_SUBSCRIPTION_RULE,
  recipientsForEvent,
} from '../src/bus/kinds.ts';
import {
  appendEvent,
  createSequenceTracker,
  eventLogPath,
  readEvents,
  readEventsFromCursor,
  verifySignedEvent,
} from '../src/bus/log.ts';

const dirs: string[] = [];

function makeScratch(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-bus-log-')));
  dirs.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  return { root, home };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('bus kinds, privileged self-subscription, and routing (RFC 002 Amendment 01 §4.3, §4.4)', () => {
  test('validates closed event kinds, privileged kinds, owner-at-once defaults, and threshold constants', () => {
    expect(EVENT_KINDS.length).toBeGreaterThanOrEqual(25);
    expect(isEventKind('message.arrived')).toBe(true);
    expect(isEventKind('team.policy-refused')).toBe(true);
    expect(isEventKind('seat.at-prompt')).toBe(true);
    expect(isEventKind('not.a.kind')).toBe(false);

    for (const kind of DEFAULT_PRIVILEGED_KINDS) {
      expect(isPrivilegedKind(kind)).toBe(true);
    }
    expect(isPrivilegedKind('message.arrived')).toBe(false);
    expect(isPrivilegedKind('message.arrived', ['message.arrived'])).toBe(true);

    expect(DEFAULT_OWNER_AT_ONCE_KINDS).toContain('seat.at-prompt');
    expect(DEFAULT_OWNER_AT_ONCE_KINDS).toContain('team.policy-refused');
    expect(isOwnerAtOnce('seat.at-prompt')).toBe(true);
    expect(isOwnerAtOnce('seat.unreachable', { seat: 'clerk', leadSeats: new Set(['clerk']) })).toBe(true);
    expect(isOwnerAtOnce('seat.unreachable', { seat: 'worker-1', leadSeats: new Set(['clerk']) })).toBe(false);

    expect(DEFAULT_RECONCILE_INTERVAL_SECONDS).toBeGreaterThan(0);
    expect(DEFAULT_SUBSCRIBER_BUFFER_LIMIT).toBeGreaterThan(0);
  });

  test('refuses non-lead self-subscription to privileged kinds under privileged-self-subscription', () => {
    const denied = checkPrivilegedSelfSubscription('worker-1', ['message.arrived', 'team.grant-issued']);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.rule).toBe(PRIVILEGED_SELF_SUBSCRIPTION_RULE);
      expect(denied.kind).toBe('team.grant-issued');
    }

    const allowedWorker = checkPrivilegedSelfSubscription('worker-1', ['message.arrived', 'seat.idle']);
    expect(allowedWorker.ok).toBe(true);

    const allowedLead = checkPrivilegedSelfSubscription('clerk', ['team.grant-issued', 'seat.at-prompt'], {
      isLead: true,
    });
    expect(allowedLead.ok).toBe(true);

    const allowedOwner = checkPrivilegedSelfSubscription('owner', ['team.policy-refused'], {
      isOwner: true,
    });
    expect(allowedOwner.ok).toBe(true);
  });

  test('resolves default and additive event recipients without removing upper-level recipients', () => {
    const team = {
      orchestrator: 'clerk',
      operator: 'op-1',
      seats: [
        { name: 'clerk', leads: true },
        { name: 'op-1' },
        { name: 'worker-1' },
      ],
    };

    const arrived = recipientsForEvent(
      { kind: 'message.arrived', from: 'clerk', to: 'worker-1' },
      team,
    );
    expect([...arrived]).toEqual(['worker-1']);

    const prompt = recipientsForEvent(
      { kind: 'seat.at-prompt', seat: 'worker-1' },
      team,
      { 'seat.at-prompt': ['auditor'] },
    );
    expect(prompt.has('clerk')).toBe(true);
    expect(prompt.has('op-1')).toBe(true);
    expect(prompt.has('owner')).toBe(true);
    expect(prompt.has('auditor')).toBe(true);
  });
});

describe('durable signed event log (RFC 002 Amendment 01 §4.1, §4.2)', () => {
  test('appends Ed25519-signed events at mode 0600, mints monotonic sequence numbers, and deduplicates by (kind, record_id, session)', () => {
    const { root, home } = makeScratch();
    const t1 = '2026-10-18T12:00:00.000Z';
    const t2 = '2026-10-18T12:00:01.000Z';

    const first = appendEvent('acme', root, home, {
      ts: t1,
      kind: 'message.arrived',
      session: 'acme',
      record_id: 'msg-1',
      from: 'clerk',
      to: 'worker-1',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.duplicate).toBe(false);
    expect(first.record.payload.seq).toBe(1);
    expect(verifySignedEvent(first.record, home)).toBe(true);

    const mode = statSync(eventLogPath('acme', root, home)).mode & 0o777;
    expect(mode).toBe(0o600);

    // Duplicate append of the same (kind, record_id, session) returns the existing record without incrementing seq.
    const dup = appendEvent('acme', root, home, {
      ts: t2,
      kind: 'message.arrived',
      session: 'acme',
      record_id: 'msg-1',
      from: 'clerk',
      to: 'worker-1',
    });
    expect(dup.ok).toBe(true);
    if (!dup.ok) return;
    expect(dup.duplicate).toBe(true);
    expect(dup.record.payload.seq).toBe(1);

    // Second distinct event gets seq = 2.
    const second = appendEvent('acme', root, home, {
      ts: t2,
      kind: 'message.delivered',
      session: 'acme',
      record_id: 'msg-1:delivered',
      from: 'clerk',
      to: 'worker-1',
      via: 'drop',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.duplicate).toBe(false);
    expect(second.record.payload.seq).toBe(2);

    const read = readEvents('acme', root, home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.events.map((e) => e.payload.seq)).toEqual([1, 2]);
    expect(read.oldestSeq).toBe(1);
    expect(read.newestSeq).toBe(2);
    expect(read.unverified).toBe(0);
  });

  test('ignores forged or malformed lines when reading the event log', () => {
    const { root, home } = makeScratch();
    const res = appendEvent('acme', root, home, {
      ts: '2026-10-18T12:00:00.000Z',
      kind: 'team.up',
      session: 'acme',
      record_id: 'up-1',
    });
    expect(res.ok).toBe(true);
    const path = eventLogPath('acme', root, home);
    appendFileSync(
      path,
      `${JSON.stringify({
        payload: {
          v: 1,
          seq: 2,
          ts: '2026-10-18T12:00:01.000Z',
          kind: 'team.grant-added',
          session: 'acme',
          record_id: 'forged-1',
        },
        signature: '00'.repeat(64),
      })}\nnot-json\n`,
    );

    const read = readEvents('acme', root, home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.events.length).toBe(1);
    expect(read.events[0]!.payload.seq).toBe(1);
    expect(read.unverified).toBe(2);
  });

  test('rotates events.jsonl at maxBytes keeping mode 0600 and answers gap when cursor is older than oldest retained sequence', () => {
    const { root, home } = makeScratch();
    // Use a small maxBytes and kept = 2 so early events rotate out of retention.
    for (let i = 1; i <= 12; i++) {
      const appended = appendEvent(
        'acme',
        root,
        home,
        {
          ts: new Date(Date.UTC(2026, 9, 18, 12, 0, i)).toISOString(),
          kind: 'message.arrived',
          session: 'acme',
          record_id: `msg-${String(i)}`,
          from: 'clerk',
          to: 'worker-1',
        },
        { maxBytes: 700, kept: 2 },
      );
      expect(appended.ok).toBe(true);
    }

    const read = readEvents('acme', root, home, { kept: 2 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.oldestSeq).not.toBeNull();
    expect(read.oldestSeq!).toBeGreaterThan(1);
    expect(read.newestSeq).toBe(12);

    const rotatedPath = `${eventLogPath('acme', root, home)}.1`;
    expect(statSync(rotatedPath).mode & 0o777).toBe(0o600);

    // A stale cursor older than oldestSeq receives `gap` with `oldest_seq`.
    const gap = readEventsFromCursor('acme', root, home, 1, { kept: 2 });
    expect(gap.ok).toBe(true);
    if (!gap.ok) return;
    expect(gap.kind).toBe('gap');
    if (gap.kind === 'gap') {
      expect(gap.oldest_seq).toBe(read.oldestSeq!);
      expect(gap.newest_seq).toBe(12);
    }

    // A cursor at or after oldestSeq receives the unseen events.
    const validCursor = read.oldestSeq!;
    const recent = readEventsFromCursor('acme', root, home, validCursor, { kept: 2 });
    expect(recent.ok).toBe(true);
    if (!recent.ok) return;
    expect(recent.kind).toBe('events');
    if (recent.kind === 'events') {
      expect(recent.events.every((e) => e.payload.seq > validCursor)).toBe(true);
      expect(recent.cursor).toBe(12);
    }
  });

  test('SequenceTracker accepts monotonically increasing sequences and drops duplicates or reordered events', () => {
    const tracker = createSequenceTracker(0);
    const makePayload = (seq: number) => ({
      v: 1 as const,
      seq,
      ts: '2026-10-18T12:00:00.000Z',
      kind: 'message.arrived' as const,
      session: 'acme',
      record_id: `m-${String(seq)}`,
    });

    expect(tracker.accept(makePayload(1))).toBe(true);
    expect(tracker.cursor).toBe(1);
    // Duplicate seq 1 is dropped.
    expect(tracker.accept(makePayload(1))).toBe(false);
    expect(tracker.cursor).toBe(1);
    // Advance to seq 3, then reordered seq 2 is dropped.
    expect(tracker.accept(makePayload(3))).toBe(true);
    expect(tracker.cursor).toBe(3);
    expect(tracker.accept(makePayload(2))).toBe(false);
    expect(tracker.cursor).toBe(3);
  });
});
