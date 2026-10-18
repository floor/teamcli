import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs';
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
  EVENT_DOMAIN,
  eventLogPath,
  pruneEventLog,
  readEvents,
  readEventsFromCursor,
  verifySignedEvent,
} from '../src/bus/log.ts';
import { messageKeyOf, signDomain, type Json } from '../src/store/keys.ts';
import { seatResolverOf } from '../src/bus/seats.ts';
import type { Agent, AgentLifecycle } from '../src/registry/agents.ts';

function registryAgent(
  id: string,
  seat: string,
  team: string,
  lifecycle: AgentLifecycle = 'running',
): Agent {
  return {
    id,
    name: seat,
    signing: { model: 'claude', version: '4.6', role: 'worker' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team, seat, session: 'acme', pane: null, address: null },
    mcp: [],
    skills: [],
    lifecycle,
    provenance: {
      registered_by: 'owner',
      registered_at: '2026-10-18T00:00:00.000Z',
      updated_at: '2026-10-18T00:00:00.000Z',
    },
  };
}

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
    expect(EVENT_KINDS.length).toBe(26);
    expect(isEventKind('message.arrived')).toBe(true);
    expect(isEventKind('team.policy-refused')).toBe(true);
    expect(isEventKind('team.event-log-dropped')).toBe(true);
    expect(isPrivilegedKind('team.event-log-dropped')).toBe(false);
    expect(isEventKind('seat.at-prompt')).toBe(true);
    expect(isEventKind('not.a.kind')).toBe(false);
    expect(isEventKind('seat.started')).toBe(false);
    expect(isEventKind('seat.provider-error')).toBe(false);
    expect(isEventKind('team.up')).toBe(false);
    expect(isEventKind('team.grant-added')).toBe(false);

    for (const kind of DEFAULT_PRIVILEGED_KINDS) {
      expect(isPrivilegedKind(kind)).toBe(true);
    }
    expect(isPrivilegedKind('message.arrived')).toBe(false);
    expect(isPrivilegedKind('message.arrived', ['message.arrived'])).toBe(true);

    expect(DEFAULT_OWNER_AT_ONCE_KINDS).toContain('seat.at-prompt');
    expect(DEFAULT_OWNER_AT_ONCE_KINDS).toContain('team.policy-refused');
    expect(isOwnerAtOnce('seat.at-prompt')).toBe(true);
    expect(isOwnerAtOnce('seat.at-prompt', { prompt: 'permission' })).toBe(true);
    expect(isOwnerAtOnce('seat.at-prompt', { prompt: 'vendor notice' })).toBe(true);
    expect(isOwnerAtOnce('seat.at-prompt', { prompt: 'rate limit' })).toBe(true);
    expect(isOwnerAtOnce('seat.at-prompt', { prompt: 'question' })).toBe(false);
    expect(isOwnerAtOnce('seat.unreachable', { seat: 'clerk', leadSeats: new Set(['clerk']) })).toBe(true);
    expect(isOwnerAtOnce('seat.unreachable', { seat: 'worker-1', leadSeats: new Set(['clerk']) })).toBe(false);

    expect(DEFAULT_RECONCILE_INTERVAL_SECONDS).toBe(120);
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

    const permPrompt = recipientsForEvent(
      { kind: 'seat.at-prompt', seat: 'worker-1', prompt: 'permission' },
      team,
      { 'seat.at-prompt': ['auditor'] },
    );
    expect([...permPrompt].sort()).toEqual(['auditor', 'clerk', 'op-1', 'owner']);

    const questionPrompt = recipientsForEvent(
      { kind: 'seat.at-prompt', seat: 'worker-1', prompt: 'question' },
      team,
    );
    expect([...questionPrompt].sort()).toEqual(['clerk', 'op-1']);

    const unreachableWorker = recipientsForEvent(
      { kind: 'seat.unreachable', seat: 'worker-1' },
      team,
    );
    expect([...unreachableWorker].sort()).toEqual(['clerk', 'op-1']);

    const unreachableLead = recipientsForEvent(
      { kind: 'seat.unreachable', seat: 'clerk' },
      team,
    );
    expect([...unreachableLead].sort()).toEqual(['clerk', 'op-1', 'owner']);

    const gate = recipientsForEvent(
      { kind: 'work.gate', seat: 'worker-1', subject: 'worker-1' },
      team,
    );
    expect([...gate]).toEqual(['clerk']);
  });

  test('resolves a recipient named by agent registry id to the seat that holds it, keeps a plain name, and leaves an unknown, retired, or foreign id as written', () => {
    const team = {
      orchestrator: 'clerk',
      operator: 'op-1',
      seats: [{ name: 'clerk', leads: true }, { name: 'op-1' }, { name: 'worker-1' }, { name: 'worker-2' }],
    };
    const resolve = seatResolverOf(
      [
        registryAgent('agt_111111111111', 'worker-1', 'team-a'),
        registryAgent('agt_222222222222', 'worker-2', 'team-a', 'retired'),
        registryAgent('agt_333333333333', 'worker-2', 'team-b'),
      ],
      'team-a',
    );
    const question = { kind: 'seat.at-prompt' as const, seat: 'worker-1', prompt: 'question' };

    const byId = recipientsForEvent(question, team, { 'seat.at-prompt': ['agt_111111111111'] }, [], resolve);
    expect([...byId].sort()).toEqual(['clerk', 'op-1', 'worker-1']);

    const byName = recipientsForEvent(question, team, { 'seat.at-prompt': ['worker-1'] }, [], resolve);
    expect([...byName].sort()).toEqual(['clerk', 'op-1', 'worker-1']);

    const retired = recipientsForEvent(question, team, { 'seat.at-prompt': ['agt_222222222222'] }, [], resolve);
    expect(retired.has('worker-2')).toBe(false);
    expect(retired.has('agt_222222222222')).toBe(true);

    const foreignTeam = recipientsForEvent(question, team, { 'seat.at-prompt': ['agt_333333333333'] }, [], resolve);
    expect(foreignTeam.has('worker-2')).toBe(false);

    const unknown = recipientsForEvent(question, team, { 'seat.at-prompt': ['agt_444444444444'] }, [], resolve);
    expect([...unknown].sort()).toEqual(['agt_444444444444', 'clerk', 'op-1']);
  });

  test('the release defaults stand under a routing chain: a word cannot remove a recipient it did not add, and a privileged kind keeps its default owner', () => {
    const team = { orchestrator: 'clerk', operator: 'op-1', seats: [{ name: 'clerk', leads: true }] };
    const chain = [
      {
        level: 'team' as const,
        word: {
          'seat.blocked': { remove: ['lead' as const, 'operator' as const] },
          'team.policy-refused': { remove: ['owner' as const] },
        },
      },
    ];
    const blocked = recipientsForEvent({ kind: 'seat.blocked', seat: 'worker-1' }, team, undefined, chain);
    expect([...blocked].sort()).toEqual(['clerk', 'op-1']);
    const refused = recipientsForEvent({ kind: 'team.policy-refused' }, team, undefined, chain);
    expect(refused.has('owner')).toBe(true);
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
      kind: 'team.seat-added',
      session: 'acme',
      record_id: 'seat-add-1',
      seat: 'worker-1',
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
          kind: 'team.grant-issued',
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

  test('a record another writer appended is seen by the next append, and an unverified line in the tail is never a duplicate', () => {
    const { root, home } = makeScratch();
    const ts = '2026-10-18T12:00:00.000Z';
    const path = eventLogPath('acme', root, home);

    const first = appendEvent('acme', root, home, {
      ts,
      kind: 'message.arrived',
      session: 'acme',
      record_id: 'a-1',
    });
    expect(first.ok).toBe(true);

    // Another process writes a signed record without touching this process's index, and an
    // unverified line right after it.
    const foreign = {
      v: 1,
      seq: 2,
      ts,
      kind: 'message.delivered',
      session: 'acme',
      record_id: 'a-2',
      from: 'clerk',
    };
    const signature = signDomain(EVENT_DOMAIN, foreign as unknown as Json, messageKeyOf(home));
    appendFileSync(path, `${JSON.stringify({ payload: foreign, signature })}\n`);
    appendFileSync(
      path,
      `${JSON.stringify({ payload: { ...foreign, seq: 3, record_id: 'forged-2' }, signature: '00'.repeat(64) })}\n`,
    );

    // The next append follows the verified foreign record, not the forged line.
    const next = appendEvent('acme', root, home, { ts, kind: 'seat.idle', session: 'acme', record_id: 'a-3' });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.record.payload.seq).toBe(3);

    // The foreign record is a duplicate by (kind, record_id, session); the forged one never is.
    const dup = appendEvent('acme', root, home, {
      ts,
      kind: 'message.delivered',
      session: 'acme',
      record_id: 'a-2',
    });
    expect(dup.ok).toBe(true);
    if (!dup.ok) return;
    expect(dup.duplicate).toBe(true);
    expect(dup.record.payload.seq).toBe(2);

    const notForged = appendEvent('acme', root, home, {
      ts,
      kind: 'message.delivered',
      session: 'acme',
      record_id: 'forged-2',
    });
    expect(notForged.ok).toBe(true);
    if (!notForged.ok) return;
    expect(notForged.duplicate).toBe(false);
    expect(notForged.record.payload.seq).toBe(4);
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
    expect(read.unverified).toBe(0);
    // The newest record written — the last message — is still retained; each dropping pass also
    // left its signed declaration after the records it kept.
    expect(read.events.some((event) => event.payload.record_id === 'msg-12')).toBe(true);

    const rotatedPath = `${eventLogPath('acme', root, home)}.1`;
    expect(statSync(rotatedPath).mode & 0o777).toBe(0o600);

    // A stale cursor older than oldestSeq receives `gap` with `oldest_seq`.
    const gap = readEventsFromCursor('acme', root, home, 1, { kept: 2 });
    expect(gap.ok).toBe(true);
    if (!gap.ok) return;
    expect(gap.kind).toBe('gap');
    if (gap.kind === 'gap') {
      expect(gap.oldest_seq).toBe(read.oldestSeq!);
      expect(gap.newest_seq).toBe(read.newestSeq!);
    }

    // A cursor at or after oldestSeq receives the unseen events.
    const validCursor = read.oldestSeq!;
    const recent = readEventsFromCursor('acme', root, home, validCursor, { kept: 2 });
    expect(recent.ok).toBe(true);
    if (!recent.ok) return;
    expect(recent.kind).toBe('events');
    if (recent.kind === 'events') {
      expect(recent.events.every((e) => e.payload.seq > validCursor)).toBe(true);
      expect(recent.cursor).toBe(read.newestSeq!);
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

describe('event-log retention: 30 days or 100 MB per team, oldest first', () => {
  const TS = '2026-10-18T12:00:00.000Z';
  const DAY_MS = 86_400 * 1_000;

  function appendOne(root: string, home: string, id: string, options: Parameters<typeof appendEvent>[4] = {}) {
    return appendEvent('acme', root, home, { ts: TS, kind: 'message.arrived', session: 'acme', record_id: id }, options);
  }

  function dropLines(root: string): string[] {
    const path = join(root, '.agents', 'team.log');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.includes('retention dropped'));
  }

  test('an age drop is declared by one signed record naming the dropped range, and a resync across it is told it was retention', () => {
    const { root, home } = makeScratch();
    expect(appendOne(root, home, 'old-1').ok).toBe(true);
    expect(appendOne(root, home, 'old-2').ok).toBe(true);

    const path = eventLogPath('acme', root, home);
    const monthAgo = new Date(Date.now() - 31 * DAY_MS);
    utimesSync(path, monthAgo, monthAgo);

    // The append seals the idle file, then the prune drops it: both old records go, the new one
    // stays, and the pass declares the dropped range in one signed record.
    const fresh = appendOne(root, home, 'fresh-1');
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(existsSync(`${path}.1`)).toBe(false);

    const read = readEvents('acme', root, home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.events.map((event) => event.payload.record_id)).toEqual(['fresh-1', 'retention:1-2']);
    expect(read.oldestSeq).toBe(3);
    expect(read.unverified).toBe(0);

    // The declaration verifies and names the range and the reason.
    const drop = read.events[1]!;
    expect(drop.payload.kind).toBe('team.event-log-dropped');
    expect(drop.payload.reason).toBe('age');
    expect(drop.payload.dropped_oldest_seq).toBe(1);
    expect(drop.payload.dropped_newest_seq).toBe(2);
    expect(verifySignedEvent(drop, home)).toBe(true);

    // Retention unlinks a whole segment and never rewrites a file it keeps: the surviving record
    // is byte for byte the signed line that was written (the declaration follows it).
    expect(readFileSync(path, 'utf8').split('\n')[0]).toBe(JSON.stringify(fresh.record));

    const drops = dropLines(root);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain('events.jsonl.1');
    expect(drops[0]).toContain('past 2592000s old');

    // A subscriber resyncing across the declared range is told the hole is retention, not loss.
    const resync = readEventsFromCursor('acme', root, home, 1);
    expect(resync.ok).toBe(true);
    if (!resync.ok) return;
    expect(resync.kind).toBe('gap');
    if (resync.kind === 'gap') {
      expect(resync.oldest_seq).toBe(3);
      expect(resync.newest_seq).toBe(4);
      expect(resync.reason).toBe('retention');
      expect(resync.dropped_oldest_seq).toBe(2);
      expect(resync.dropped_newest_seq).toBe(2);
    }
  });

  test('the oldest sealed segment is dropped first when the team log is over its size cap, and every pass declares its range', () => {
    const { root, home } = makeScratch();
    for (let i = 1; i <= 12; i++) {
      expect(appendOne(root, home, `msg-${String(i)}`, { maxBytes: 600, kept: 2, maxTotalBytes: 450 }).ok).toBe(true);
    }

    const read = readEvents('acme', root, home, { kept: 2 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.unverified).toBe(0);
    expect(read.newestSeq).not.toBeNull();
    expect(read.events.some((event) => event.payload.record_id === 'msg-12')).toBe(true);

    // What is kept is the newest contiguous run of verified records, declarations included.
    const seqs = read.events.map((event) => event.payload.seq);
    expect(seqs).toEqual(seqs.map((_, at) => seqs[0]! + at));

    // Every sequence below the retained window is inside a declared range carried by a retained
    // drop record: the newest declaration keeps the oldest dropped sequence in view.
    const declared = read.events.filter((event) => event.payload.kind === 'team.event-log-dropped');
    expect(declared.length).toBeGreaterThan(0);
    const ranges = declared.map((event) => [
      event.payload.dropped_oldest_seq!,
      event.payload.dropped_newest_seq!,
    ]);
    for (let seq = 1; seq < read.oldestSeq!; seq++) {
      expect(ranges.some(([start, end]) => seq >= start! && seq <= end!)).toBe(true);
    }
    const latest = declared[declared.length - 1]!;
    expect(verifySignedEvent(latest, home)).toBe(true);
    expect(latest.payload.dropped_oldest_seq).toBe(1);

    const drops = dropLines(root);
    expect(drops.length).toBeGreaterThan(0);
    for (const line of drops) {
      expect(line).toContain('events.jsonl.1');
      expect(line).toContain('past 450 bytes');
    }
  });

  test('the bus-start prune drops an idle live file and leaves only its signed drop record', () => {
    const { root, home } = makeScratch();
    expect(appendOne(root, home, 'old-1').ok).toBe(true);
    expect(appendOne(root, home, 'old-2').ok).toBe(true);

    const path = eventLogPath('acme', root, home);
    const monthAgo = new Date(Date.now() - 31 * DAY_MS);
    utimesSync(path, monthAgo, monthAgo);

    pruneEventLog('acme', root, home);

    expect(existsSync(`${path}.1`)).toBe(false);
    const read = readEvents('acme', root, home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.events.map((event) => event.payload.record_id)).toEqual(['retention:1-2']);
    expect(read.oldestSeq).toBe(3);
    expect(read.unverified).toBe(0);
    expect(verifySignedEvent(read.events[0]!, home)).toBe(true);
    expect(dropLines(root)).toHaveLength(1);
  });

  test('a missing segment no drop record declares stays an undeclared gap', () => {
    const { root, home } = makeScratch();
    for (let i = 1; i <= 3; i++) {
      expect(appendOne(root, home, `msg-${String(i)}`, { maxBytes: 600, kept: 2 }).ok).toBe(true);
    }
    const path = eventLogPath('acme', root, home);
    expect(existsSync(`${path}.1`)).toBe(true);
    // Remove a segment by hand: nothing in the retained log declares this loss.
    unlinkSync(`${path}.1`);

    const read = readEventsFromCursor('acme', root, home, 1, { kept: 2 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.kind).toBe('gap');
    if (read.kind === 'gap') {
      expect(read.oldest_seq).toBe(3);
      expect(read.reason).toBeUndefined();
      expect(read.dropped_oldest_seq).toBeUndefined();
      expect(read.dropped_newest_seq).toBeUndefined();
    }
  });
});
