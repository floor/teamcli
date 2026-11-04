// The fallback episode's focused fixtures: one all-failed event per episode (its actual fanout:
// the sender, the receiver's lead and the addressed recipient — the bus matches `to`); persistent
// dedup in the marker, not the rotating event log; every attempt kept in the durable ledger while
// the marker carries a bounded summary; deterministic ids from the canonical recipient as well as
// the message id; event intents retried after a crash on either side of the append, with the
// publication ledger keeping replay dedup across event-log rotation; the policy-
// delayed main escalation fired once and resumed after a restart, and its delay re-resolved by a
// later pass after an unreadable policy; recovery cancellation; the digest as a checked value;
// typed transport receipts where a missing one is explicit; and a cross-root episode whose
// ledgers, log, lock, escalation and retirement all live in the receiving team's one store — the
// sender defers on that store's held key, and a publication the pre-fix sender key recorded is
// still honored for one release.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendEvent, eventLogPath, readEvents, verifySignedEvent, type SignedEventRecord } from '../src/bus/log.ts';
import { recipientsForEvent } from '../src/bus/kinds.ts';
import type { Caller } from '../src/caller.ts';
import { messageFile } from '../src/commands/messages.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import {
  allFailedRecordId,
  attemptLedgerFileName,
  escalateDue,
  escalatedRecordId,
  escalationDelayOf,
  escalationMailboxId,
  fallbackKeyOf,
  FALLBACK_ARCHIVE_DIR,
  MARKER_ATTEMPT_LIMIT,
  markerPathOf,
  noteTransport,
  noteTransportSoon,
  publicationLedgerFileName,
  retireFinished,
  type CanonicalRecipient,
  type EscalationContext,
  type FallbackContext,
  type FallbackMarker,
  type RelayReceipt,
  type TransportFact,
} from '../src/send/fallback-events.ts';
import { historyPath } from '../src/send/history.ts';

const TEAM_YAML = `format: 1
entity: floor
project: acme
session: acme-dev
coordinator: crew-lead
operator: crew-lead
workspace:
  mode: shared
seats:
  - name: crew-lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - name: worker-1
    role: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - name: worker-2
    role: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

const AT = '2026-10-20T10:00:00.000Z';
const DIGEST = 'a'.repeat(64);
const CALLER: Caller = { kind: 'seat', name: 'worker-1', pane: 'w1:p1', session: 'acme-dev' };

type World = {
  root: string;
  entityRoot: string;
  home: string;
  team: TeamFile;
  ctx: FallbackContext;
  recipient: CanonicalRecipient;
};

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function parseTeam(): TeamFile {
  const res = validateTeamFile(TEAM_YAML);
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.team;
}

function makeWorld(options: { entity?: boolean } = {}): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-fallback-events-')));
  dirs.push(base);
  const root = join(base, 'repo');
  const entityRoot = join(base, 'entity-repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(entityRoot, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });

  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    entity: 'floor',
    session: 'acme-dev',
    root,
    roster: [{ agent: 'agt_crewlead0000', seat: 'crew-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  if (options.entity !== false) {
    upsertTeam(home, teamIdOf(entityRoot), {
      project: 'floor',
      entity: 'floor',
      session: 'floor-hq',
      root: entityRoot,
      roster: [{ agent: 'agt_entitylead00', seat: 'entity-lead', role: 'coordinator', leads: true }],
      lifecycle: 'running',
    });
  }

  const team = parseTeam();
  return {
    root,
    entityRoot,
    home,
    team,
    ctx: { caller: CALLER, team, root, home, now: () => new Date(AT) },
    recipient: { team: 'acme', seat: 'worker-2', toId: 'agt_worker2', session: 'acme-dev', root },
  };
}

function fact(world: World, over: Partial<TransportFact> = {}): TransportFact {
  return {
    recipient: world.recipient,
    messageId: 'm-001',
    recordDigest: DIGEST,
    route: 'socket',
    outcome: 'unreachable',
    at: AT,
    ms: 120,
    reason: 'the socket did not answer',
    liveRoutesRemain: false,
    ...over,
  };
}

function delayMs(world: World, recipient: CanonicalRecipient = world.recipient, ctx: FallbackContext = world.ctx): number {
  const delay = escalationDelayOf(ctx, recipient, AT);
  if (delay.ms === null) throw new Error(delay.refusal ?? 'no delay resolved');
  return delay.ms;
}

function readMarker(world: World, messageId = 'm-001'): FallbackMarker {
  return JSON.parse(readFileSync(markerPathOf(world.recipient, messageId), 'utf8')) as FallbackMarker;
}

function publicationPath(world: World, messageId = 'm-001'): string {
  return join(
    dirname(historyPath(world.team.project, world.root, world.home)),
    publicationLedgerFileName(world.recipient, messageId),
  );
}

function verifiedLog(world: World): SignedEventRecord[] {
  const res = readEvents(world.team.project, world.root, world.home);
  if (!res.ok) throw new Error(res.reason);
  expect(res.unverified).toBe(0);
  for (const record of res.events) expect(verifySignedEvent(record, world.home)).toBe(true);
  return res.events;
}

describe('the fallback episode', () => {
  test('records one all-failed event and its actual fanout is sender, receiver lead and recipient', () => {
    const world = makeWorld();
    const note = noteTransport(world.ctx, fact(world));
    if (!note.ok) throw new Error(note.reason);

    expect(note.state).toBe('all-failed');
    expect(note.eventDuplicate).toBe(false);
    expect(note.dueAt).toBe(new Date(Date.parse(AT) + delayMs(world)).toISOString());
    const delay = escalationDelayOf(world.ctx, world.recipient, AT);
    expect(delay.source).toBe('release-default');
    expect(delay.seconds).toBe(300);
    expect(delay.ms).toBe(300_000);
    expect(delay.ms).toBe(delayMs(world));
    expect(delay.refusal).toBeUndefined();

    const events = verifiedLog(world);
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload;
    expect(payload.kind).toBe('message.held');
    expect(payload.record_id).toBe(allFailedRecordId(world.recipient, 'm-001'));
    expect(payload.from).toBe('worker-1');
    expect(payload.to).toBe('worker-2');
    expect(payload.seat).toBe('worker-2');
    expect(payload.thread).toBe('m-001');
    expect(payload.reason).toBe('all live routes failed');
    expect(payload.via).toBe('socket');
    const routed = recipientsForEvent(payload, world.team);
    expect(routed.has('worker-1')).toBe(true);
    expect(routed.has('crew-lead')).toBe(true);
    // `to` names the held recipient, as the existing reconcile emitters do. `recipientsForEvent`
    // alone answers the routing word (sender + lead); the bus's `matchesSubscriber` also
    // delivers an event addressed to a seat, so the actual audience is the union: sender,
    // receiver lead and the addressed recipient. The delayed escalation's audience is the same
    // union with the entity orchestrator in the addressed place.
    const audience = new Set([...routed, ...(payload.to === undefined ? [] : [payload.to])]);
    expect(audience.has('worker-2')).toBe(true);

    const marker = readMarker(world);
    expect(marker.status).toBe('all-failed');
    expect(marker.recipient).toEqual(world.recipient);
    expect(marker.recordDigest).toBe(DIGEST);
    expect(marker.sender).toBe('worker-1');
    expect(marker.allFailedAt).toBe(AT);
    expect(marker.attempts).toHaveLength(1);
    expect(marker.attempts[0]!.route).toBe('socket');
    expect(marker.attempts[0]!.outcome).toBe('unreachable');
    expect(marker.attempts[0]!.receipt).toEqual({ kind: 'unknown' });
  });

  test('a repeated fact adds no second event, including after the log is gone', () => {
    const world = makeWorld();
    const first = noteTransport(world.ctx, fact(world));
    if (!first.ok) throw new Error(first.reason);

    const again = noteTransport(world.ctx, fact(world, { route: 'native', at: '2026-10-20T10:00:05.000Z' }));
    if (!again.ok) throw new Error(again.reason);
    expect(again.state).toBe('duplicate');
    expect(again.event).toBeUndefined();
    expect(verifiedLog(world)).toHaveLength(1);

    // The log rotating away (or a fresh process finding an empty index) must not reopen the
    // episode: the marker beside the record is the replay-lifetime proof.
    unlinkSync(eventLogPath(world.team.project, world.root, world.home));
    const afterRotation = noteTransport(world.ctx, fact(world, { route: 'drop', outcome: 'timeout', at: '2026-10-20T10:00:10.000Z' }));
    if (!afterRotation.ok) throw new Error(afterRotation.reason);
    expect(afterRotation.state).toBe('duplicate');
    const reread = readEvents(world.team.project, world.root, world.home);
    if (!reread.ok) throw new Error(reread.reason);
    expect(reread.events).toHaveLength(0);

    const marker = readMarker(world);
    expect(marker.allFailedAt).toBe(AT);
    expect(marker.dueAt).toBe(new Date(Date.parse(AT) + delayMs(world)).toISOString());
    expect(marker.attempts).toHaveLength(3);
  });

  test('a different digest or recipient id is a conflict and writes nothing', () => {
    const world = makeWorld();
    const first = noteTransport(world.ctx, fact(world, { messageId: 'm-conflict' }));
    if (!first.ok) throw new Error(first.reason);

    const otherDigest = noteTransport(world.ctx, fact(world, { messageId: 'm-conflict', recordDigest: 'b'.repeat(64) }));
    if (otherDigest.ok) throw new Error('a different digest was accepted');
    expect(otherDigest.kind).toBe('conflict');

    const otherId = noteTransport(world.ctx, fact(world, {
      messageId: 'm-conflict',
      recipient: { ...world.recipient, toId: 'agt_someoneelse' },
    }));
    if (otherId.ok) throw new Error('a different registry id was accepted');
    expect(otherId.kind).toBe('conflict');

    expect(verifiedLog(world)).toHaveLength(1);
    const marker = readMarker(world, 'm-conflict');
    expect(marker.recordDigest).toBe(DIGEST);
    expect(marker.recipient.toId).toBe('agt_worker2');
    expect(marker.attempts).toHaveLength(1);
  });

  test('a held attempt with a live route left is a continuation, and a delivery cancels the delay', () => {
    const world = makeWorld();
    const held = noteTransport(world.ctx, fact(world, {
      messageId: 'm-held',
      outcome: 'held',
      liveRoutesRemain: true,
      receipt: { kind: 'stored', id: 'drop-1' },
    }));
    if (!held.ok) throw new Error(held.reason);
    expect(held.state).toBe('continued');
    expect(held.dueAt).toBeNull();
    expect(verifiedLog(world)).toHaveLength(0);
    let marker = readMarker(world, 'm-held');
    expect(marker.status).toBe('trying');
    expect(marker.allFailedAt).toBeUndefined();
    expect(marker.receipt).toEqual({ kind: 'stored', id: 'drop-1' });

    const exhausted = noteTransport(world.ctx, fact(world, {
      messageId: 'm-held',
      outcome: 'unreachable',
      route: 'native',
      at: '2026-10-20T10:00:05.000Z',
    }));
    if (!exhausted.ok) throw new Error(exhausted.reason);
    expect(exhausted.state).toBe('all-failed');
    expect(verifiedLog(world)).toHaveLength(1);

    const delivered = noteTransport(world.ctx, fact(world, {
      messageId: 'm-held',
      outcome: 'delivered',
      route: 'native',
      at: '2026-10-20T10:00:30.000Z',
      receipt: { kind: 'maybe-consumed' },
    }));
    if (!delivered.ok) throw new Error(delivered.reason);
    expect(delivered.state).toBe('delivered');
    expect(delivered.dueAt).toBeNull();
    expect(delivered.marker.receipt).toEqual({ kind: 'maybe-consumed' });
    marker = readMarker(world, 'm-held');
    expect(marker.status).toBe('delivered');
    expect('dueAt' in marker).toBe(false);

    const due = Date.parse(AT) + delayMs(world);
    const escalation = escalateDue(world.ctx, { at: new Date(due + 1_000) });
    expect(escalation.escalated).toHaveLength(0);
    expect(verifiedLog(world)).toHaveLength(1);
  });

  test('the delayed main escalation fires once and resumes after a restart', () => {
    const world = makeWorld();
    const first = noteTransport(world.ctx, fact(world));
    if (!first.ok) throw new Error(first.reason);
    const due = Date.parse(first.dueAt!);

    const early = escalateDue(world.ctx, { at: new Date(due - 1) });
    expect(early.escalated).toHaveLength(0);
    expect(early.scanned).toBe(1);

    const fired = escalateDue(world.ctx, { at: new Date(due) });
    expect(fired.refused).toHaveLength(0);
    expect(fired.escalated).toHaveLength(1);
    const entry = fired.escalated[0]!;
    expect(entry.event.payload.record_id).toBe(escalatedRecordId(world.recipient, 'm-001'));
    expect(entry.event.payload.kind).toBe('message.held');
    expect(entry.event.payload.to).toBe('entity-lead');
    expect(entry.event.payload.from).toBe('worker-1');
    expect(entry.event.payload.via).toBe('fallback');
    const escalationFanout = recipientsForEvent(entry.event.payload, world.team);
    // Routed to the sender and receiver lead; addressed to the entity orchestrator, which the
    // bus also delivers to via `to`.
    expect(escalationFanout.has('worker-1')).toBe(true);
    expect(escalationFanout.has('crew-lead')).toBe(true);
    expect(entry.event.payload.to).toBe('entity-lead');
    expect(entry.mailbox).toBe(messageFile(world.entityRoot, 'entity-lead', escalationMailboxId(world.recipient, 'm-001')));
    const mailbox = JSON.parse(readFileSync(entry.mailbox!, 'utf8')) as {
      payload: { to: string; id: string; body: string; session: string };
    };
    expect(mailbox.payload.to).toBe('entity-lead');
    expect(mailbox.payload.id).toBe(escalationMailboxId(world.recipient, 'm-001'));
    expect(mailbox.payload.session).toBe('floor-hq');
    expect(mailbox.payload.body).toContain('still undelivered');
    expect(readMarker(world).escalatedAt).toBe(new Date(due).toISOString());
    expect(verifiedLog(world)).toHaveLength(2);

    const again = escalateDue(world.ctx, { at: new Date(due + 60_000) });
    expect(again.escalated).toHaveLength(0);
    const restarted = escalateDue({ ...world.ctx }, { at: new Date(due + 120_000) });
    expect(restarted.escalated).toHaveLength(0);
    expect(verifiedLog(world)).toHaveLength(2);

    // A restart that also lost the log still does not raise the escalation twice.
    unlinkSync(eventLogPath(world.team.project, world.root, world.home));
    const afterRotation = escalateDue({ ...world.ctx }, { at: new Date(due + 180_000) });
    expect(afterRotation.escalated).toHaveLength(0);
    expect(readdirSync(join(world.entityRoot, '.agents', 'messages', 'entity-lead'))).toHaveLength(1);
  });

  test('no main orchestrator leaves the escalation pending until the registry names one', () => {
    const world = makeWorld({ entity: false });
    const first = noteTransport(world.ctx, fact(world));
    if (!first.ok) throw new Error(first.reason);
    const due = Date.parse(first.dueAt!) + 1_000;

    const pending = escalateDue(world.ctx, { at: new Date(due) });
    expect(pending.escalated).toHaveLength(0);
    expect(pending.refused).toHaveLength(1);
    expect(pending.refused[0]!.reason).toContain('main orchestrator');
    expect(readMarker(world).escalatedAt).toBeUndefined();

    upsertTeam(world.home, teamIdOf(world.entityRoot), {
      project: 'floor',
      entity: 'floor',
      session: 'floor-hq',
      root: world.entityRoot,
      roster: [{ agent: 'agt_entitylead00', seat: 'entity-lead', role: 'coordinator', leads: true }],
      lifecycle: 'running',
    });
    const repaired = escalateDue(world.ctx, { at: new Date(due + 1_000) });
    expect(repaired.refused).toHaveLength(0);
    expect(repaired.escalated).toHaveLength(1);
  });

  test('an unreadable marker is reported, never overwritten', () => {
    const world = makeWorld();
    const broken = markerPathOf(world.recipient, 'm-broken');
    mkdirSync(dirname(broken), { recursive: true });
    writeFileSync(broken, '{}\n');

    const report = escalateDue(world.ctx, { at: new Date(AT) });
    expect(report.unreadable).toEqual([broken]);
    expect(report.scanned).toBe(0);
    expect(report.escalated).toHaveLength(0);
    expect(readFileSync(broken, 'utf8')).toBe('{}\n');
  });

  test('receipts stay typed: missing is unknown, a string is never cast', () => {
    const world = makeWorld();

    const missing = noteTransport(world.ctx, fact(world, { messageId: 'm-none', outcome: 'held', liveRoutesRemain: true }));
    if (!missing.ok) throw new Error(missing.reason);
    expect(readMarker(world, 'm-none').receipt).toEqual({ kind: 'unknown' });
    expect(readMarker(world, 'm-none').attempts[0]!.receipt).toEqual({ kind: 'unknown' });

    const cast = noteTransport(world.ctx, fact(world, {
      messageId: 'm-string',
      outcome: 'held',
      liveRoutesRemain: true,
      receipt: 'maybe-consumed' as unknown as RelayReceipt,
    }));
    if (!cast.ok) throw new Error(cast.reason);
    expect(readMarker(world, 'm-string').receipt).toEqual({ kind: 'unknown' });

    const maybe = noteTransport(world.ctx, fact(world, {
      messageId: 'm-maybe',
      outcome: 'held',
      liveRoutesRemain: true,
      receipt: { kind: 'maybe-consumed' },
    }));
    if (!maybe.ok) throw new Error(maybe.reason);
    expect(readMarker(world, 'm-maybe').receipt).toEqual({ kind: 'maybe-consumed' });

    const stored = noteTransport(world.ctx, fact(world, {
      messageId: 'm-stored',
      outcome: 'held',
      liveRoutesRemain: true,
      receipt: { kind: 'stored', id: 'drop-7' },
    }));
    if (!stored.ok) throw new Error(stored.reason);
    expect(readMarker(world, 'm-stored').receipt).toEqual({ kind: 'stored', id: 'drop-7' });
    expect(verifiedLog(world)).toHaveLength(0);
  });

  test('every attempt is kept in the durable ledger while the marker summary stays bounded', () => {
    const world = makeWorld();
    const total = MARKER_ATTEMPT_LIMIT + 2;
    for (let n = 0; n < total; n++) {
      const note = noteTransport(world.ctx, fact(world, {
        messageId: 'm-ledger',
        outcome: 'held',
        liveRoutesRemain: true,
        route: n % 2 === 0 ? 'socket' : 'native',
        at: new Date(Date.parse(AT) + n * 1_000).toISOString(),
        ms: n,
        receipt: { kind: 'stored', id: `drop-${n}` },
      }));
      if (!note.ok) throw new Error(note.reason);
      expect(note.state).toBe('continued');
    }

    const ledgerPath = join(
      dirname(historyPath(world.team.project, world.root, world.home)),
      attemptLedgerFileName(world.recipient, 'm-ledger'),
    );
    const lines = readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(total);
    expect(lines[0]!.route).toBe('socket');
    expect(lines[total - 1]!.route).toBe('native');
    expect(lines[total - 1]!.recipient).toEqual(world.recipient);
    expect(lines[total - 1]!.receipt).toEqual({ kind: 'stored', id: `drop-${total - 1}` });

    const marker = readMarker(world, 'm-ledger');
    expect(marker.attempts).toHaveLength(MARKER_ATTEMPT_LIMIT);
    // The two oldest left the marker summary only; the ledger above still holds them.
    expect(marker.attempts[0]!.route).toBe('socket');
    expect(marker.attempts[MARKER_ATTEMPT_LIMIT - 1]!.route).toBe('native');
    expect(marker.status).toBe('trying');
    expect(verifiedLog(world)).toHaveLength(0);
  });

  test('one message id to two recipients never shares an event, a ledger or a mailbox', () => {
    const world = makeWorld();
    const other: CanonicalRecipient = {
      team: 'acme',
      seat: 'crew-lead',
      toId: 'agt_crewlead0000',
      session: 'acme-dev',
      root: world.root,
    };
    const first = noteTransport(world.ctx, fact(world, { messageId: 'm-twin' }));
    if (!first.ok) throw new Error(first.reason);
    const second = noteTransport(world.ctx, fact(world, { messageId: 'm-twin', recipient: other }));
    if (!second.ok) throw new Error(second.reason);

    expect(first.event!.payload.record_id).not.toBe(second.event!.payload.record_id);
    expect(second.event!.payload.to).toBe('crew-lead');
    expect(verifiedLog(world)).toHaveLength(2);

    expect(attemptLedgerFileName(world.recipient, 'm-twin')).not.toBe(attemptLedgerFileName(other, 'm-twin'));
    const storeDir = dirname(historyPath(world.team.project, world.root, world.home));
    expect(readdirSync(storeDir).filter((name) => name.startsWith('fallback-attempts-'))).toHaveLength(2);

    const fired = escalateDue(world.ctx, { at: new Date(Date.parse(first.dueAt!) + 1_000) });
    expect(fired.refused).toHaveLength(0);
    expect(fired.escalated).toHaveLength(2);
    const mailboxes = fired.escalated.map((entry) => entry.mailbox);
    expect(new Set(mailboxes).size).toBe(2);
    expect(escalationMailboxId(world.recipient, 'm-twin')).not.toBe(escalationMailboxId(other, 'm-twin'));
    expect(readdirSync(join(world.entityRoot, '.agents', 'messages', 'entity-lead'))).toHaveLength(2);
    // Both immediate events and both escalation events stand apart.
    expect(verifiedLog(world)).toHaveLength(4);
  });

  test('an event intent left before the append is drained exactly once after a restart', () => {
    const world = makeWorld();
    const first = noteTransport(world.ctx, fact(world));
    if (!first.ok) throw new Error(first.reason);

    // The crash window: the intent is durable, the process died before the append ran. Model it
    // by re-adding the intent to the marker and dropping the event log.
    const marker = readMarker(world);
    marker.outbox = {
      kind: 'all-failed',
      recordId: allFailedRecordId(world.recipient, 'm-001'),
      at: AT,
      route: 'socket',
    };
    writeFileSync(markerPathOf(world.recipient, 'm-001'), `${JSON.stringify(marker)}\n`);
    unlinkSync(eventLogPath(world.team.project, world.root, world.home));
    // No publication happened before the crash, so the episode's publication ledger is empty.
    unlinkSync(publicationPath(world));

    const resumed = noteTransport(world.ctx, fact(world, { at: '2026-10-20T10:00:05.000Z' }));
    if (!resumed.ok) throw new Error(resumed.reason);
    expect(resumed.state).toBe('duplicate');
    expect(resumed.eventDuplicate).toBe(false);
    expect(resumed.event!.payload.record_id).toBe(allFailedRecordId(world.recipient, 'm-001'));
    expect(verifiedLog(world)).toHaveLength(1);
    expect(readMarker(world).outbox).toBeUndefined();

    const again = noteTransport(world.ctx, fact(world, { at: '2026-10-20T10:00:10.000Z' }));
    if (!again.ok) throw new Error(again.reason);
    expect(again.event).toBeUndefined();
    expect(verifiedLog(world)).toHaveLength(1);
  });

  test('an intent left after the append is drained as a duplicate, not a second event', () => {
    const world = makeWorld();
    const first = noteTransport(world.ctx, fact(world));
    if (!first.ok) throw new Error(first.reason);

    // The other crash window: the append returned, the process died before the marker cleared
    // the intent. The log still holds the event.
    const marker = readMarker(world);
    marker.outbox = {
      kind: 'all-failed',
      recordId: allFailedRecordId(world.recipient, 'm-001'),
      at: AT,
      route: 'socket',
    };
    writeFileSync(markerPathOf(world.recipient, 'm-001'), `${JSON.stringify(marker)}\n`);

    const resumed = noteTransport(world.ctx, fact(world, { route: 'native', at: '2026-10-20T10:00:05.000Z' }));
    if (!resumed.ok) throw new Error(resumed.reason);
    expect(resumed.state).toBe('duplicate');
    expect(resumed.eventDuplicate).toBe(true);
    expect(resumed.event!.payload.record_id).toBe(allFailedRecordId(world.recipient, 'm-001'));
    expect(verifiedLog(world)).toHaveLength(1);
    expect(readMarker(world).outbox).toBeUndefined();
  });

  test('a crash after the escalation mailbox write retries as a duplicate, not a second record', () => {
    const world = makeWorld();
    const first = noteTransport(world.ctx, fact(world));
    if (!first.ok) throw new Error(first.reason);
    const due = Date.parse(first.dueAt!);
    const fired = escalateDue(world.ctx, { at: new Date(due) });
    expect(fired.escalated).toHaveLength(1);
    const mailbox = fired.escalated[0]!.mailbox!;

    // The crash window after both writes and before the marker's outbox was cleared.
    const marker = readMarker(world);
    marker.outbox = {
      kind: 'escalated',
      recordId: escalatedRecordId(world.recipient, 'm-001'),
      at: fired.escalated[0]!.event.payload.ts,
      reason: 'still undelivered after 600s: all live routes failed',
    };
    writeFileSync(markerPathOf(world.recipient, 'm-001'), `${JSON.stringify(marker)}\n`);

    const retried = escalateDue(world.ctx, { at: new Date(due + 1_000) });
    expect(retried.escalated).toHaveLength(1);
    expect(retried.escalated[0]!.duplicate).toBe(true);
    expect(retried.escalated[0]!.mailbox).toBe(mailbox);
    expect(readMarker(world).outbox).toBeUndefined();
    expect(verifiedLog(world)).toHaveLength(2);
    expect(readdirSync(join(world.entityRoot, '.agents', 'messages', 'entity-lead'))).toHaveLength(1);
  });

  test('a delivery keeps the fixed all-failed event but cancels a pending escalation intent', () => {
    const world = makeWorld();
    const first = noteTransport(world.ctx, fact(world));
    if (!first.ok) throw new Error(first.reason);

    // Crash before the immediate event's append, then the message arrives: the all-failed event
    // is an invariant of the episode and is still emitted by the delivery's own call.
    const marker = readMarker(world);
    marker.outbox = {
      kind: 'all-failed',
      recordId: allFailedRecordId(world.recipient, 'm-001'),
      at: AT,
      route: 'socket',
    };
    writeFileSync(markerPathOf(world.recipient, 'm-001'), `${JSON.stringify(marker)}\n`);
    unlinkSync(eventLogPath(world.team.project, world.root, world.home));
    // No publication happened before the crash, so the episode's publication ledger is empty.
    unlinkSync(publicationPath(world));

    const delivered = noteTransport(world.ctx, fact(world, {
      outcome: 'delivered',
      route: 'native',
      at: '2026-10-20T10:00:05.000Z',
    }));
    if (!delivered.ok) throw new Error(delivered.reason);
    expect(delivered.state).toBe('delivered');
    expect(delivered.eventDuplicate).toBe(false);
    expect(delivered.event!.payload.record_id).toBe(allFailedRecordId(world.recipient, 'm-001'));
    expect(verifiedLog(world)).toHaveLength(1);
    expect(readMarker(world).status).toBe('delivered');
    expect(readMarker(world).outbox).toBeUndefined();

    // An escalation intent decided but never appended is cancelled by a later delivery, and a
    // pass afterwards raises nothing.
    const world2 = makeWorld();
    const exhausted = noteTransport(world2.ctx, fact(world2));
    if (!exhausted.ok) throw new Error(exhausted.reason);
    const pending = readMarker(world2);
    pending.escalatedAt = AT;
    pending.escalatedTo = { seat: 'entity-lead', team: 'floor', root: world2.entityRoot, session: 'floor-hq' };
    pending.outbox = {
      kind: 'escalated',
      recordId: escalatedRecordId(world2.recipient, 'm-001'),
      at: AT,
      reason: 'still undelivered after 0s: all live routes failed',
    };
    writeFileSync(markerPathOf(world2.recipient, 'm-001'), `${JSON.stringify(pending)}\n`);

    const arrived = noteTransport(world2.ctx, fact(world2, {
      outcome: 'delivered',
      route: 'native',
      at: '2026-10-20T10:00:05.000Z',
    }));
    if (!arrived.ok) throw new Error(arrived.reason);
    expect(arrived.state).toBe('delivered');
    expect(readMarker(world2).outbox).toBeUndefined();
    expect(verifiedLog(world2)).toHaveLength(1);
    expect(existsSync(join(world2.entityRoot, '.agents', 'messages', 'entity-lead'))).toBe(false);
    const after = escalateDue(world2.ctx, { at: new Date(Date.parse(AT) + 10 * 60_000) });
    expect(after.escalated).toHaveLength(0);
    expect(verifiedLog(world2)).toHaveLength(1);
  });

  test('a crash after the append loses no event to rotation and adds no second one', () => {
    const world = makeWorld();
    const first = noteTransport(world.ctx, fact(world));
    if (!first.ok) throw new Error(first.reason);

    // The publication is durable in the episode's own ledger, with the signed record itself.
    expect(readFileSync(publicationPath(world), 'utf8').trim().split('\n')).toHaveLength(1);

    // Crash after the append and before the marker cleared its intent, then retention drops the
    // segment that held the event before recovery runs.
    const marker = readMarker(world);
    marker.outbox = {
      kind: 'all-failed',
      recordId: allFailedRecordId(world.recipient, 'm-001'),
      at: AT,
      route: 'socket',
    };
    writeFileSync(markerPathOf(world.recipient, 'm-001'), `${JSON.stringify(marker)}\n`);
    unlinkSync(eventLogPath(world.team.project, world.root, world.home));

    const recovered = noteTransport(world.ctx, fact(world, { at: '2026-10-20T10:00:05.000Z' }));
    if (!recovered.ok) throw new Error(recovered.reason);
    expect(recovered.state).toBe('duplicate');
    expect(recovered.eventDuplicate).toBe(true);
    expect(recovered.event!.payload.record_id).toBe(allFailedRecordId(world.recipient, 'm-001'));

    // Nothing was appended into the retained log; the publication ledger still holds one record.
    const retained = readEvents(world.team.project, world.root, world.home);
    if (!retained.ok) throw new Error(retained.reason);
    expect(retained.events).toHaveLength(0);
    expect(readFileSync(publicationPath(world), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readMarker(world).outbox).toBeUndefined();
  });

  test('an unreadable policy leaves the escalation unscheduled until a later pass resolves it', () => {
    const world = makeWorld();
    const unreadable: FallbackContext = { ...world.ctx, team: { ...world.team, policies: 'unreadable' } };

    const first = noteTransport(unreadable, fact(world));
    if (!first.ok) throw new Error(first.reason);
    expect(first.state).toBe('all-failed');
    expect(first.dueAt).toBeNull();
    expect(first.policyRefusal).toContain('must be a map');
    // The immediate all-failed event is fixed and does not wait for the policy.
    expect(verifiedLog(world)).toHaveLength(1);
    expect('dueAt' in readMarker(world)).toBe(false);

    // Fail closed while unreadable: no escalation, no zero-delay shortcut, the episode stays.
    const pending = escalateDue(unreadable, { at: new Date(Date.parse(AT) + 10 * 60_000) });
    expect(pending.escalated).toHaveLength(0);
    expect(pending.refused).toHaveLength(1);
    expect(pending.refused[0]!.reason).toContain('unreadable');
    expect(verifiedLog(world)).toHaveLength(1);
    expect(existsSync(join(world.entityRoot, '.agents', 'messages', 'entity-lead'))).toBe(false);

    // A later pass under a readable chain schedules from the original failure and fires now.
    const repaired = escalateDue(world.ctx, { at: new Date(Date.parse(AT) + delayMs(world) + 1_000) });
    expect(repaired.refused).toHaveLength(0);
    expect(repaired.escalated).toHaveLength(1);
    expect(readMarker(world).dueAt).toBe(new Date(Date.parse(AT) + delayMs(world)).toISOString());
    expect(verifiedLog(world)).toHaveLength(2);
  });
});

describe('a cross-root episode', () => {
  // A send from project acme at `root` to a seat of project floor at `entityRoot`: the receiving
  // team's own registry record is already in place (makeWorld upserts floor at entityRoot). The
  // canonical store key under test is the RECEIVING team's project over the receiving root — the
  // same folder the receiver-side sweep resolves — so one episode has one lock folder, one pair
  // of ledgers and one log either side reads.

  const ENTITY_TEAM_YAML = `format: 1
entity: floor
project: floor
session: floor-hq
coordinator: entity-lead
operator: entity-lead
workspace:
  mode: shared
seats:
  - name: entity-lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

  type CrossWorld = World & {
    cross: CanonicalRecipient;
    /** The receiver-side pass's context, as the sweep builds it: the receiving root's own team. */
    receiver: (at?: string) => EscalationContext;
  };

  function makeCrossWorld(): CrossWorld {
    const world = makeWorld();
    const parsed = validateTeamFile(ENTITY_TEAM_YAML);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const entityTeam = parsed.team;
    return {
      ...world,
      // The sender's walk carries the receiving team's validated file in hand, as the real walk
      // does when it resolved `to` from the registry; the delay reads the receiver's own chain.
      ctx: { ...world.ctx, recipientTeam: entityTeam },
      cross: { team: 'floor', seat: 'entity-lead', toId: 'agt_entitylead00', session: 'floor-hq', root: world.entityRoot },
      receiver: (at = AT) => ({ team: entityTeam, root: world.entityRoot, home: world.home, now: () => new Date(at) }),
    };
  }

  function crossFact(world: CrossWorld, over: Partial<TransportFact> = {}): TransportFact {
    return fact(world, { recipient: world.cross, messageId: 'm-cross', ...over });
  }

  /** The canonical store: the receiving team's project over the receiving root. */
  function receiverStore(world: CrossWorld): string {
    return dirname(historyPath(world.cross.team, world.cross.root, world.home));
  }

  /** The pre-fix sender key: the sending team's project over the receiving root. */
  function senderStoreOverReceiverRoot(world: CrossWorld): string {
    return dirname(historyPath(world.team.project, world.cross.root, world.home));
  }

  function episodeLockDir(world: CrossWorld, messageId: string): string {
    const hash = createHash('sha256').update(fallbackKeyOf(world.cross, messageId)).digest('hex').slice(0, 16);
    return join(receiverStore(world), 'locks', `fallback-${hash}`);
  }

  /** A live holder exactly as `withLock` plants one: the key's directory plus its holder file. */
  function holdEpisodeLock(world: CrossWorld, messageId: string): void {
    mkdirSync(episodeLockDir(world, messageId), { recursive: true });
    writeFileSync(join(episodeLockDir(world, messageId), 'team.lock'), `${process.pid}\n`);
  }

  function readCrossMarker(world: CrossWorld, messageId = 'm-cross'): FallbackMarker {
    return JSON.parse(readFileSync(markerPathOf(world.cross, messageId), 'utf8')) as FallbackMarker;
  }

  function verifiedEvents(project: string, root: string, home: string): SignedEventRecord[] {
    const res = readEvents(project, root, home);
    if (!res.ok) throw new Error(res.reason);
    expect(res.unverified).toBe(0);
    for (const record of res.events) expect(verifySignedEvent(record, home)).toBe(true);
    return res.events;
  }

  test("keeps its ledgers and its event in the receiving team's store", () => {
    const world = makeCrossWorld();
    const note = noteTransport(world.ctx, crossFact(world));
    if (!note.ok) throw new Error(note.reason);
    expect(note.state).toBe('all-failed');
    expect(note.eventDuplicate).toBe(false);

    const store = receiverStore(world);
    expect(existsSync(join(store, attemptLedgerFileName(world.cross, 'm-cross')))).toBe(true);
    expect(existsSync(join(store, publicationLedgerFileName(world.cross, 'm-cross')))).toBe(true);
    // The exhaustion event is filed under the receiving team's log as well: the sender's walk
    // appends it there, so the episode has one log whichever side reads it back.
    const events = verifiedEvents(world.cross.team, world.cross.root, world.home);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.record_id).toBe(allFailedRecordId(world.cross, 'm-cross'));
    // The sending team's store over the receiving root never comes to exist.
    expect(existsSync(senderStoreOverReceiverRoot(world))).toBe(false);
  });

  test('defers the sender on a key the receiving store holds', () => {
    const world = makeCrossWorld();
    holdEpisodeLock(world, 'm-cross');

    const note = noteTransportSoon(world.ctx, crossFact(world));
    if (!note.ok) throw new Error(note.reason);
    if (note.state !== 'deferred') throw new Error(`the sender did not defer: ${note.state}`);
    expect(existsSync(note.notePath)).toBe(true);
    // Nothing was recorded past the note beside the record: no marker, no ledger. (The store's
    // lock ladder exists — this scene planted the held key in it.)
    expect(existsSync(markerPathOf(world.cross, 'm-cross'))).toBe(false);
    expect(existsSync(join(receiverStore(world), attemptLedgerFileName(world.cross, 'm-cross')))).toBe(false);
  });

  test('defers the receiver sweep on the sender-held key and escalates once it is free', () => {
    const world = makeCrossWorld();
    const first = noteTransport(world.ctx, crossFact(world));
    if (!first.ok) throw new Error(first.reason);
    const due = Date.parse(first.dueAt!);

    // The pair with the scene above is the cross-side proof: the sender takes the key this
    // store holds (previous scene), and the sweep meets the very same key here.
    holdEpisodeLock(world, 'm-cross');
    const busy = escalateDue(world.receiver(new Date(due).toISOString()), { at: new Date(due), lockWaitMs: 0 });
    expect(busy.deferred).toEqual([{ messageId: 'm-cross', recipient: world.cross }]);
    expect(busy.escalated).toHaveLength(0);
    expect(existsSync(join(world.entityRoot, '.agents', 'messages', 'entity-lead'))).toBe(false);

    rmSync(episodeLockDir(world, 'm-cross'), { recursive: true });
    const fired = escalateDue(world.receiver(), { at: new Date(due + 1_000) });
    expect(fired.escalated).toHaveLength(1);
    expect(fired.escalated[0]!.event.payload.record_id).toBe(escalatedRecordId(world.cross, 'm-cross'));
    expect(fired.escalated[0]!.duplicate).toBe(false);
  });

  test('fires the delayed escalation once, from the one store', () => {
    const world = makeCrossWorld();
    const first = noteTransport(world.ctx, crossFact(world));
    if (!first.ok) throw new Error(first.reason);
    const due = Date.parse(first.dueAt!);

    const fired = escalateDue(world.receiver(), { at: new Date(due) });
    expect(fired.refused).toHaveLength(0);
    expect(fired.escalated).toHaveLength(1);
    const entry = fired.escalated[0]!;
    expect(entry.event.payload.record_id).toBe(escalatedRecordId(world.cross, 'm-cross'));
    expect(entry.event.payload.to).toBe('entity-lead');
    expect(readCrossMarker(world).escalatedAt).toBe(new Date(due).toISOString());

    // The exhaustion event and the escalation event are both in the RECEIVING team's log, and
    // the sender-keyed store over this root still never existed.
    expect(verifiedEvents(world.cross.team, world.cross.root, world.home)).toHaveLength(2);
    expect(existsSync(senderStoreOverReceiverRoot(world))).toBe(false);

    // A second pass stays quiet, and the publication ledger keeps exactly the two records.
    const again = escalateDue(world.receiver(), { at: new Date(due + 60_000) });
    expect(again.escalated).toHaveLength(0);
    expect(verifiedEvents(world.cross.team, world.cross.root, world.home)).toHaveLength(2);
    expect(
      readFileSync(join(receiverStore(world), publicationLedgerFileName(world.cross, 'm-cross')), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(2);
  });

  test("retires the episode out of the receiving team's one store", () => {
    const world = makeCrossWorld();
    const exhausted = noteTransport(world.ctx, crossFact(world));
    if (!exhausted.ok) throw new Error(exhausted.reason);
    const delivered = noteTransport(world.ctx, crossFact(world, {
      outcome: 'delivered',
      route: 'native',
      at: '2026-10-20T10:00:30.000Z',
      receipt: { kind: 'maybe-consumed' },
    }));
    if (!delivered.ok) throw new Error(delivered.reason);
    expect(delivered.state).toBe('delivered');

    const store = receiverStore(world);
    const ledger = join(store, attemptLedgerFileName(world.cross, 'm-cross'));
    expect(existsSync(ledger)).toBe(true);

    const report = retireFinished(world.receiver('2026-10-20T11:00:00.000Z'), {
      at: new Date('2026-10-20T11:00:00.000Z'),
      lockWaitMs: 0,
    });
    expect(report.retired).toHaveLength(1);
    expect(report.retired[0]!.kind).toBe('delivered');
    expect(report.retired[0]!.messageId).toBe('m-cross');
    // The live marker and the live ledger are both gone from the one store, the ledger archived.
    expect(existsSync(markerPathOf(world.cross, 'm-cross'))).toBe(false);
    expect(existsSync(ledger)).toBe(false);
    expect(
      readdirSync(join(store, FALLBACK_ARCHIVE_DIR, 'attempts')).filter((name) => name.startsWith('fallback-attempts-')),
    ).toHaveLength(1);
    expect(existsSync(senderStoreOverReceiverRoot(world))).toBe(false);

    // A later fact meets the archived marker in the same store and answers a duplicate.
    const again = noteTransport(world.ctx, crossFact(world, { route: 'drop', at: '2026-10-20T11:01:00.000Z' }));
    if (!again.ok) throw new Error(again.reason);
    expect(again.state).toBe('duplicate');
  });

  test('still honors a publication the pre-fix sender key recorded', () => {
    const world = makeCrossWorld();
    const first = noteTransport(world.ctx, crossFact(world));
    if (!first.ok) throw new Error(first.reason);
    const due = Date.parse(first.dueAt!);
    const fired = escalateDue(world.receiver(), { at: new Date(due) });
    expect(fired.escalated).toHaveLength(1);

    // The release straddle: pre-fix code filed the publication ledger under the SENDING team's
    // project over the receiving root. Move the ledger there, drop the canonical copy, lose the
    // marker's escalation memory and rotate the log away — the ledger is the only witness left.
    const canonical = join(receiverStore(world), publicationLedgerFileName(world.cross, 'm-cross'));
    const legacy = join(senderStoreOverReceiverRoot(world), publicationLedgerFileName(world.cross, 'm-cross'));
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, readFileSync(canonical, 'utf8'));
    unlinkSync(canonical);
    unlinkSync(eventLogPath(world.cross.team, world.cross.root, world.home));
    const marker = readCrossMarker(world);
    delete marker.escalatedAt;
    writeFileSync(markerPathOf(world.cross, 'm-cross'), `${JSON.stringify(marker)}\n`);

    const replay = escalateDue(world.receiver(), { at: new Date(due + 120_000) });
    expect(replay.escalated).toHaveLength(1);
    expect(replay.escalated[0]!.duplicate).toBe(true);
    expect(replay.escalated[0]!.event.payload.record_id).toBe(escalatedRecordId(world.cross, 'm-cross'));
    // Nothing was appended: the rotated log stays empty and the sender-keyed ledger still holds
    // exactly the two records it was planted with.
    const log = readEvents(world.cross.team, world.cross.root, world.home);
    if (!log.ok) throw new Error(log.reason);
    expect(log.events).toHaveLength(0);
    expect(readFileSync(legacy, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  test('escalates a cross-root episode once by the receiver sweep after sender lock contention and never duplicates across retries', () => {
    const world = makeCrossWorld();
    const firstLeg = noteTransport(
      world.ctx,
      crossFact(world, { messageId: 'm-cross-race', route: 'socket', liveRoutesRemain: true }),
    );
    if (!firstLeg.ok) throw new Error(firstLeg.reason);
    expect(firstLeg.state).toBe('continued');

    const exhausted = noteTransport(
      world.ctx,
      crossFact(world, {
        messageId: 'm-cross-race',
        route: 'native',
        at: '2026-10-20T10:00:05.000Z',
        liveRoutesRemain: false,
      }),
    );
    if (!exhausted.ok) throw new Error(exhausted.reason);
    expect(exhausted.state).toBe('all-failed');
    const due = Date.parse(exhausted.dueAt!);

    // While the sender holds the canonical episode lock in the receiving team's store, both a
    // receiver sweep and a concurrent non-blocking sender note defer on the same lock folder.
    holdEpisodeLock(world, 'm-cross-race');
    const sweepWhileLocked = escalateDue(world.receiver(new Date(due).toISOString()), {
      at: new Date(due),
      lockWaitMs: 0,
    });
    expect(sweepWhileLocked.deferred).toEqual([{ messageId: 'm-cross-race', recipient: world.cross }]);
    expect(sweepWhileLocked.escalated).toHaveLength(0);
    expect(sweepWhileLocked.refused).toHaveLength(0);

    const senderWhileLocked = noteTransportSoon(
      world.ctx,
      crossFact(world, {
        messageId: 'm-cross-race',
        route: 'drop',
        at: new Date(due + 500).toISOString(),
      }),
    );
    if (!senderWhileLocked.ok) throw new Error(senderWhileLocked.reason);
    expect(senderWhileLocked.state).toBe('deferred');
    expect(verifiedEvents(world.cross.team, world.cross.root, world.home)).toHaveLength(1);

    // Once the sender releases the lock, the receiver sweep escalates the episode exactly once.
    rmSync(episodeLockDir(world, 'm-cross-race'), { recursive: true });
    const fired = escalateDue(world.receiver(new Date(due + 1_000).toISOString()), {
      at: new Date(due + 1_000),
      lockWaitMs: 0,
    });
    expect(fired.deferred).toHaveLength(0);
    expect(fired.refused).toHaveLength(0);
    expect(fired.escalated).toHaveLength(1);
    expect(fired.escalated[0]!.duplicate).toBe(false);
    expect(fired.escalated[0]!.event.payload.record_id).toBe(escalatedRecordId(world.cross, 'm-cross-race'));

    // Neither a later receiver sweep nor a later sender fact emits a second escalation event,
    // and the pre-fix sender-keyed store directory never comes into existence.
    const laterSweep = escalateDue(world.receiver(new Date(due + 30_000).toISOString()), {
      at: new Date(due + 30_000),
      lockWaitMs: 0,
    });
    expect(laterSweep.escalated).toHaveLength(0);
    const laterSender = noteTransport(
      world.ctx,
      crossFact(world, {
        messageId: 'm-cross-race',
        route: 'drop',
        at: new Date(due + 35_000).toISOString(),
      }),
    );
    if (!laterSender.ok) throw new Error(laterSender.reason);
    expect(laterSender.state).toBe('duplicate');
    expect(laterSender.event).toBeUndefined();
    expect(verifiedEvents(world.cross.team, world.cross.root, world.home)).toHaveLength(2);
    expect(existsSync(senderStoreOverReceiverRoot(world))).toBe(false);
  });

  test('a release-straddling crash with a pending outbox intent drains from the pre-fix sender store without writing to it', () => {
    const world = makeCrossWorld();
    const first = noteTransport(world.ctx, crossFact(world, { messageId: 'm-straddle' }));
    if (!first.ok) throw new Error(first.reason);
    const due = Date.parse(first.dueAt!);
    const fired = escalateDue(world.receiver(), { at: new Date(due) });
    expect(fired.escalated).toHaveLength(1);

    // Move the publication ledger to the pre-fix sender-keyed store, remove the canonical ledger
    // and the rotated event log, and leave a pending `escalated` outbox intent as if a pre-fix
    // process crashed after recording the publication and before clearing `marker.outbox`.
    const canonical = join(receiverStore(world), publicationLedgerFileName(world.cross, 'm-straddle'));
    const legacyDir = senderStoreOverReceiverRoot(world);
    const legacy = join(legacyDir, publicationLedgerFileName(world.cross, 'm-straddle'));
    mkdirSync(legacyDir, { recursive: true });
    const legacyBytes = readFileSync(canonical, 'utf8');
    writeFileSync(legacy, legacyBytes);
    unlinkSync(canonical);
    unlinkSync(eventLogPath(world.cross.team, world.cross.root, world.home));

    const marker = readCrossMarker(world, 'm-straddle');
    marker.outbox = {
      kind: 'escalated',
      recordId: escalatedRecordId(world.cross, 'm-straddle'),
      at: new Date(due).toISOString(),
      reason: 'still undelivered after 300s: all live routes failed',
    };
    writeFileSync(markerPathOf(world.cross, 'm-straddle'), `${JSON.stringify(marker)}\n`);

    const drained = escalateDue(world.receiver(), { at: new Date(due + 5_000) });
    expect(drained.refused).toHaveLength(0);
    expect(drained.escalated).toHaveLength(1);
    expect(drained.escalated[0]!.duplicate).toBe(true);
    expect(drained.escalated[0]!.event.signature).toBe(fired.escalated[0]!.event.signature);
    expect(readCrossMarker(world, 'm-straddle').outbox).toBeUndefined();

    // The rotated log stays empty and the pre-fix store is untouched (read-only bridge).
    const log = readEvents(world.cross.team, world.cross.root, world.home);
    if (!log.ok) throw new Error(log.reason);
    expect(log.events).toHaveLength(0);
    expect(readdirSync(legacyDir)).toEqual([publicationLedgerFileName(world.cross, 'm-straddle')]);
    expect(readFileSync(legacy, 'utf8')).toBe(legacyBytes);
  });

  test('does not read a foreign store over the same root hash as ours', () => {
    const world = makeCrossWorld();
    const first = noteTransport(world.ctx, crossFact(world, { messageId: 'm-foreign' }));
    if (!first.ok) throw new Error(first.reason);
    const due = Date.parse(first.dueAt!);

    // Mint a validly structured event signed by a DIFFERENT home's message key (`foreignHome`).
    const foreignHome = realpathSync(mkdtempSync(join(tmpdir(), 'team-fallback-foreign-home-')));
    dirs.push(foreignHome);
    mkdirSync(join(foreignHome, '.config', 'team'), { recursive: true });
    const foreignAppended = appendEvent('foreign', world.cross.root, foreignHome, {
      ts: new Date(due).toISOString(),
      kind: 'message.held',
      session: world.cross.session,
      record_id: escalatedRecordId(world.cross, 'm-foreign'),
      from: 'worker-1',
      to: world.cross.seat,
      seat: world.cross.seat,
      thread: 'm-foreign',
      via: 'fallback',
      reason: 'forged foreign escalation',
    });
    if (!foreignAppended.ok) throw new Error(foreignAppended.reason);
    expect(verifySignedEvent(foreignAppended.record, foreignHome)).toBe(true);
    expect(verifySignedEvent(foreignAppended.record, world.home)).toBe(false);

    // Plant a sibling directory in `world.home/.config/team` sharing the receiving root's
    // `-<12-hex>` suffix that holds the foreign-signed record for the exact `escalatedRecordId`,
    // plus a symlink sibling store pointing to `foreignHome`'s store.
    const foreignSiblingDir = dirname(historyPath('aaa-foreign', world.cross.root, world.home));
    mkdirSync(foreignSiblingDir, { recursive: true });
    const ledgerName = publicationLedgerFileName(world.cross, 'm-foreign');
    writeFileSync(
      join(foreignSiblingDir, ledgerName),
      `${JSON.stringify({
        ts: new Date(due).toISOString(),
        recordId: escalatedRecordId(world.cross, 'm-foreign'),
        kind: 'escalated',
        record: foreignAppended.record,
      })}\n`,
    );
    const symlinkSiblingDir = dirname(historyPath('aab-symlink', world.cross.root, world.home));
    symlinkSync(foreignSiblingDir, symlinkSiblingDir);
    unlinkSync(join(receiverStore(world), ledgerName));

    // Neither the symlinked store nor the foreign-signed ledger in the same-root-hash sibling
    // suppresses or refuses our real escalation: `escalateDue` appends a fresh event signed by
    // `world.home` and records it in the canonical receiver store.
    const fired = escalateDue(world.receiver(), { at: new Date(due) });
    expect(fired.refused).toHaveLength(0);
    expect(fired.escalated).toHaveLength(1);
    expect(fired.escalated[0]!.duplicate).toBe(false);
    expect(fired.escalated[0]!.event.signature).not.toBe(foreignAppended.record.signature);
    expect(verifySignedEvent(fired.escalated[0]!.event, world.home)).toBe(true);
    expect(existsSync(join(receiverStore(world), ledgerName))).toBe(true);
  });
});

describe('the escalation delay resolver', () => {
  test('an explicit shorter legacy threshold caps the canonical delay', () => {
    const world = makeWorld();
    const shorter = writePolicySet(
      world.home,
      { level: 'entity', target: 'floor', name: 'event-unreachable-threshold-seconds', value: 150 },
      { now: new Date(AT) },
    );
    if (!shorter.ok) throw new Error(shorter.why);

    const delay = escalationDelayOf(world.ctx, world.recipient, AT);
    expect(delay).toEqual({ ms: 150_000, seconds: 150, source: 'event-unreachable-threshold-seconds' });

    // The scheduling path consumes the capped number: the due instant moves with it.
    const note = noteTransport(world.ctx, fact(world));
    if (!note.ok) throw new Error(note.reason);
    expect(note.dueAt).toBe(new Date(Date.parse(AT) + 150_000).toISOString());
  });

  test('a receiver in another root reads its own chain, never the sender team', () => {
    const world = makeWorld();
    // The sender's chain declares 240 s at its own entity.
    const senderPolicy = writePolicySet(
      world.home,
      { level: 'entity', target: 'floor', name: 'delivery-escalation', value: 240 },
      { now: new Date(AT) },
    );
    if (!senderPolicy.ok) throw new Error(senderPolicy.why);
    expect(escalationDelayOf(world.ctx, world.recipient, AT)).toEqual({
      ms: 240_000,
      seconds: 240,
      source: 'delivery-escalation',
    });

    const foreign: CanonicalRecipient = {
      team: 'floor',
      seat: 'entity-lead',
      toId: 'agt_entitylead00',
      session: 'floor-hq',
      root: world.entityRoot,
    };
    // Without the receiver's file in hand, nothing is borrowed from the sender: the episode stays
    // pending and says which root could not be read.
    const borrowed = escalationDelayOf(world.ctx, foreign, AT);
    expect(borrowed.ms).toBeNull();
    expect(borrowed.refusal).toContain('never read for another team');
    expect(borrowed.refusal).toContain(world.entityRoot);

    // With the receiver's validated file in hand, its own chain answers — the canonical 300 s
    // release default, not the sender's 240 s.
    const foreignYaml = TEAM_YAML.replace('project: acme', 'project: floor').replace('entity: floor', 'entity: ops');
    const foreignTeam = validateTeamFile(foreignYaml);
    if (!foreignTeam.ok) throw new Error(JSON.stringify(foreignTeam.errors));
    const own = escalationDelayOf({ ...world.ctx, recipientTeam: foreignTeam.team }, foreign, AT);
    expect(own).toEqual({ ms: 300_000, seconds: 300, source: 'release-default' });
  });
});
