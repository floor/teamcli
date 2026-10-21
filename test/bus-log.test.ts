import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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
import { messageKeyOf, messageKeyPath, signDomain, type Json } from '../src/store/keys.ts';
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
    expect(EVENT_KINDS.length).toBe(34);
    expect(isEventKind('config.changed')).toBe(true);
    expect(isEventKind('message.arrived')).toBe(true);
    expect(isEventKind('team.policy-refused')).toBe(true);
    expect(isEventKind('record.invalid')).toBe(true);
    expect(isEventKind('security.refused')).toBe(true);
    expect(isEventKind('team.event-log-dropped')).toBe(true);
    expect(isPrivilegedKind('team.event-log-dropped')).toBe(false);
    expect(isEventKind('seat.at-prompt')).toBe(true);
    expect(isEventKind('seat.unblocked')).toBe(true);
    expect(isEventKind('not.a.kind')).toBe(false);
    expect(isEventKind('seat.started')).toBe(false);
    expect(isEventKind('seat.provider-error')).toBe(false);
    expect(isEventKind('team.up')).toBe(false);
    expect(isEventKind('team.grant-added')).toBe(false);

    for (const kind of DEFAULT_PRIVILEGED_KINDS) {
      expect(isPrivilegedKind(kind)).toBe(true);
    }
    expect(DEFAULT_PRIVILEGED_KINDS).toContain('record.invalid');
    expect(DEFAULT_PRIVILEGED_KINDS).toContain('security.refused');
    expect(isPrivilegedKind('record.invalid')).toBe(true);
    expect(isPrivilegedKind('security.refused')).toBe(true);
    expect(isPrivilegedKind('message.arrived')).toBe(false);
    expect(isPrivilegedKind('message.arrived', ['message.arrived'])).toBe(true);
    // A setting is a value, not a limit: the change is routed, never privileged, never at once.
    expect(isPrivilegedKind('config.changed')).toBe(false);
    expect(DEFAULT_OWNER_AT_ONCE_KINDS).not.toContain('config.changed');

    expect(DEFAULT_OWNER_AT_ONCE_KINDS).toContain('seat.at-prompt');
    expect(DEFAULT_OWNER_AT_ONCE_KINDS).toContain('team.policy-refused');
    expect(DEFAULT_OWNER_AT_ONCE_KINDS).toContain('record.invalid');
    expect(DEFAULT_OWNER_AT_ONCE_KINDS).toContain('security.refused');
    expect(isOwnerAtOnce('record.invalid')).toBe(true);
    expect(isOwnerAtOnce('security.refused')).toBe(true);
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

    // The forged record sits past the verified sequence, so it is checked again on every read;
    // the verified record below the checkpoint is not.
    const again = readEvents('acme', root, home);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.full).toBe(false);
    expect(again.checked).toBe(1);
    expect(again.unverified).toBe(2);
    expect(again.events.length).toBe(1);
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

describe('bus verification checkpoint: verify only what came after the last verified sequence', () => {
  const TS = '2026-10-18T12:00:00.000Z';

  function appendOne(root: string, home: string, id: string): ReturnType<typeof appendEvent> {
    return appendEvent('acme', root, home, { ts: TS, kind: 'message.arrived', session: 'acme', record_id: id });
  }

  test('a first read verifies the whole log; the next reads check only what was appended since it', () => {
    const { root, home } = makeScratch();
    for (const id of ['m-1', 'm-2', 'm-3']) expect(appendOne(root, home, id).ok).toBe(true);

    const first = readEvents('acme', root, home);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.full).toBe(true);
    expect(first.checked).toBe(3);
    expect(first.events.map((event) => event.payload.seq)).toEqual([1, 2, 3]);

    const quiet = readEvents('acme', root, home);
    expect(quiet.ok).toBe(true);
    if (!quiet.ok) return;
    expect(quiet.full).toBe(false);
    expect(quiet.checked).toBe(0);
    expect(quiet.unverified).toBe(0);
    expect(quiet.events.map((event) => event.payload.seq)).toEqual([1, 2, 3]);

    // A subscription reads through the same checkpoint.
    const subscribed = readEventsFromCursor('acme', root, home, 0);
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) return;
    expect(subscribed.kind).toBe('events');
    if (subscribed.kind === 'events') {
      expect(subscribed.full).toBe(false);
      expect(subscribed.checked).toBe(0);
      expect(subscribed.events.map((event) => event.payload.seq)).toEqual([1, 2, 3]);
    }

    expect(appendOne(root, home, 'm-4').ok).toBe(true);
    const grown = readEvents('acme', root, home);
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;
    expect(grown.full).toBe(false);
    expect(grown.checked).toBe(1);
    expect(grown.events.map((event) => event.payload.seq)).toEqual([1, 2, 3, 4]);
  });

  test('a record altered in place changes the digest, so the next read verifies the whole log and catches it', () => {
    const { root, home } = makeScratch();
    for (const id of ['m-1', 'm-2', 'm-3']) expect(appendOne(root, home, id).ok).toBe(true);
    const first = readEvents('acme', root, home);
    expect(first.ok).toBe(true);

    // Rewrite the second line's payload without the key: it still parses, but its signature no
    // longer verifies. The checkpoint covered the bytes that were there.
    const path = eventLogPath('acme', root, home);
    const lines = readFileSync(path, 'utf8').split('\n');
    const second = JSON.parse(lines[1]!) as { payload: Record<string, unknown>; signature: string };
    second.payload.record_id = 'm-2-altered';
    lines[1] = JSON.stringify(second);
    writeFileSync(path, lines.join('\n'));

    const altered = readEvents('acme', root, home);
    expect(altered.ok).toBe(true);
    if (!altered.ok) return;
    expect(altered.full).toBe(true);
    expect(altered.checked).toBe(3);
    expect(altered.unverified).toBe(1);
    expect(altered.events.map((event) => event.payload.record_id)).toEqual(['m-1', 'm-3']);

    // The rebuilt checkpoint covers the altered line too: the next read trusts the bytes it just
    // verified, keeps the line counted as unverified, and checks nothing.
    const again = readEvents('acme', root, home);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.full).toBe(false);
    expect(again.checked).toBe(0);
    expect(again.unverified).toBe(1);
    expect(again.events.map((event) => event.payload.record_id)).toEqual(['m-1', 'm-3']);
  });

  test('a rotation that keeps every byte keeps the checkpoint; a trim under it forces a full verify', () => {
    const { root, home } = makeScratch();
    for (const id of ['m-1', 'm-2', 'm-3']) expect(appendOne(root, home, id).ok).toBe(true);
    const first = readEvents('acme', root, home);
    expect(first.ok).toBe(true);

    // Move the file boundary without dropping a byte: a rotation on its own is not a trim.
    const path = eventLogPath('acme', root, home);
    renameSync(path, `${path}.1`);
    expect(appendOne(root, home, 'm-4').ok).toBe(true);

    const rotated = readEvents('acme', root, home);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.full).toBe(false);
    expect(rotated.checked).toBe(1);
    expect(rotated.events.map((event) => event.payload.seq)).toEqual([1, 2, 3, 4]);

    // The trim drops the segment the checkpoint covered: the digest no longer matches and the
    // retained log is verified again.
    unlinkSync(`${path}.1`);
    const trimmed = readEvents('acme', root, home);
    expect(trimmed.ok).toBe(true);
    if (!trimmed.ok) return;
    expect(trimmed.full).toBe(true);
    expect(trimmed.checked).toBe(1);
    expect(trimmed.events.map((event) => event.payload.seq)).toEqual([4]);
  });

  test('a key change invalidates the checkpoint rather than trusting records checked under the old key', () => {
    const { root, home } = makeScratch();
    expect(appendOne(root, home, 'm-1').ok).toBe(true);
    const first = readEvents('acme', root, home);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.checked).toBe(1);

    const keyFile = messageKeyPath(home);
    const saved = readFileSync(keyFile, 'utf8');
    unlinkSync(keyFile);

    const missing = readEvents('acme', root, home);
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.full).toBe(true);
    expect(missing.events).toHaveLength(0);
    expect(missing.unverified).toBe(1);

    writeFileSync(keyFile, saved, { mode: 0o600 });
    const restored = readEvents('acme', root, home);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.full).toBe(true);
    expect(restored.checked).toBe(1);
    expect(restored.events.map((event) => event.payload.seq)).toEqual([1]);
  });
});

describe('event log appends are serialized across processes (RFC 002 Amendment 01 §4.1)', () => {
  const TS = '2026-10-21T12:00:00.000Z';
  const DAY_MS = 86_400 * 1_000;

  test('twelve concurrent writers each take a unique sequence and every record is read past a shared cursor', async () => {
    const { root, home } = makeScratch();
    const seed = appendEvent(
      'acme',
      root,
      home,
      { ts: TS, kind: 'message.arrived', session: 'acme', record_id: 'seed' },
      { deduplicate: false, retain: false },
    );
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;
    expect(seed.record.payload.seq).toBe(1);

    // Each writer is a separate process released at one instant, so the scene exercises the
    // cross-process path: allocation and append must serialize or two writers mint one sequence.
    const script = join(import.meta.dir, 'bus-log-race-run.ts');
    const startAt = Date.now() + 1_500;
    const children = Array.from({ length: 12 }, (_, at) => {
      const id = `race-${String(at)}`;
      const child = Bun.spawn([process.execPath, script, root, home, id, String(startAt)], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return { id, child };
    });

    const written: { id: string; ok: boolean; seq?: number; reason?: string }[] = [];
    for (const { id, child } of children) {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ id, err, code }).toEqual({ id, err: '', code: 0 });
      written.push(JSON.parse(out.trim().split('\n').at(-1) ?? 'null') as (typeof written)[number]);
    }

    expect(written.filter((result) => result.ok !== true)).toEqual([]);
    const seqs = written.map((result) => result.seq ?? -1).sort((a, b) => a - b);
    expect(seqs).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

    // A consumer that had already passed seq 1 sees every sibling: the cursor filter drops only
    // records at or below the cursor, so a duplicate sequence would silently hide one.
    const read = readEventsFromCursor('acme', root, home, 1, { kept: 2 });
    expect(read.ok).toBe(true);
    if (!read.ok || read.kind !== 'events') return;
    expect(read.events.map((event) => event.payload.seq).sort((a, b) => a - b)).toEqual(seqs);
    const tracker = createSequenceTracker(1);
    for (const event of read.events) {
      expect(tracker.accept(event)).toBe(true);
    }
    expect(tracker.cursor).toBe(13);

    const full = readEvents('acme', root, home);
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.events).toHaveLength(13);
    expect(full.unverified).toBe(0);
  }, 30_000);

  test('a drop declared from inside an append takes the next sequence, and the append after it is stale by nothing', () => {
    const { root, home } = makeScratch();
    const appendOne = (id: string, options: Parameters<typeof appendEvent>[4] = {}) =>
      appendEvent(
        'acme',
        root,
        home,
        { ts: TS, kind: 'message.arrived', session: 'acme', record_id: id },
        { deduplicate: false, ...options },
      );
    expect(appendOne('kept-1', { retain: false }).ok).toBe(true);
    expect(appendOne('kept-2', { retain: false }).ok).toBe(true);

    // Backdate the live file past the window: the next append seals it, the prune drops it, and
    // the drop declaration appends its signed record from inside that append.
    const path = eventLogPath('acme', root, home);
    const monthAgo = new Date(Date.now() - 31 * DAY_MS);
    utimesSync(path, monthAgo, monthAgo);

    const fresh = appendOne('fresh');
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.record.payload.seq).toBe(3);

    const after = appendOne('after');
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.record.payload.seq).toBe(5);

    const read = readEvents('acme', root, home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.events.map((event) => [event.payload.record_id, event.payload.seq])).toEqual([
      ['fresh', 3],
      ['retention:1-2', 4],
      ['after', 5],
    ]);
    expect(read.unverified).toBe(0);
  });

  test('the standalone prune pass holds the same lock, so a startup prune cannot mint a sequence beside a writer', async () => {
    const { root, home } = makeScratch();
    const seed = appendEvent(
      'acme',
      root,
      home,
      { ts: TS, kind: 'message.arrived', session: 'acme', record_id: 'kept' },
      { deduplicate: false, retain: false },
    );
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;

    // A separate process holds the event lock; the prune pass must wait for it before it touches
    // the retained files or precomputes its declaration. Without the wait it would return at once.
    const storeDir = dirname(eventLogPath('acme', root, home));
    const ready = join(storeDir, 'holder.ready');
    const holder = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'bus-log-hold-lock-run.ts'), storeDir, ready, '3000'],
      { stdout: 'ignore', stderr: 'pipe' },
    );
    const exit = holder.exited;
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    expect(existsSync(ready)).toBe(true);

    const started = Date.now();
    pruneEventLog('acme', root, home);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(await exit).toBe(0);
    expect(await new Response(holder.stderr).text()).toBe('');
  }, 20_000);

  test('an append that cannot take the lock within its bounded wait fails closed and writes nothing', async () => {
    const { root, home } = makeScratch();
    const seed = appendEvent(
      'acme',
      root,
      home,
      { ts: TS, kind: 'message.arrived', session: 'acme', record_id: 'seed' },
      { deduplicate: false, retain: false },
    );
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;

    // The holder outlasts the append's bounded wait, so the append must answer with the
    // structured failure instead of blocking forever or writing beside the holder.
    const storeDir = dirname(eventLogPath('acme', root, home));
    const ready = join(storeDir, 'holder-busy.ready');
    const holder = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'bus-log-hold-lock-run.ts'), storeDir, ready, '8000'],
      { stdout: 'ignore', stderr: 'pipe' },
    );
    const exit = holder.exited;
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    expect(existsSync(ready)).toBe(true);

    const busy = appendEvent(
      'acme',
      root,
      home,
      { ts: TS, kind: 'message.arrived', session: 'acme', record_id: 'busy' },
      { deduplicate: false, retain: false },
    );
    expect(busy).toEqual({ ok: false, reason: 'the event log is busy; the record was not written' });
    expect(await exit).toBe(0);
    expect(await new Response(holder.stderr).text()).toBe('');

    const read = readEvents('acme', root, home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.events.map((event) => event.payload.record_id)).toEqual(['seed']);
  }, 20_000);
});
