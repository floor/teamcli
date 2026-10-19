// The fallback episode's focused fixtures: one all-failed event per episode (its actual fanout:
// the sender, the receiver's lead and the addressed recipient — the bus matches `to`); persistent
// dedup in the marker, not the rotating event log; every attempt kept in the durable ledger while
// the marker carries a bounded summary; deterministic ids from the canonical recipient as well as
// the message id; event intents retried after a crash on either side of the append, with the
// publication ledger keeping replay dedup across event-log rotation; the policy-
// delayed main escalation fired once and resumed after a restart, and its delay re-resolved by a
// later pass after an unreadable policy; recovery cancellation; the digest as a checked value; and
// typed transport receipts where a missing one is explicit.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { eventLogPath, readEvents, verifySignedEvent, type SignedEventRecord } from '../src/bus/log.ts';
import { recipientsForEvent } from '../src/bus/kinds.ts';
import type { Caller } from '../src/caller.ts';
import { messageFile } from '../src/commands/messages.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { eventThresholdsInForce } from '../src/policy/thresholds.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import {
  allFailedRecordId,
  attemptLedgerFileName,
  ESCALATION_DELAY_POLICY,
  escalateDue,
  escalatedRecordId,
  escalationDelayOf,
  escalationMailboxId,
  MARKER_ATTEMPT_LIMIT,
  markerPathOf,
  noteTransport,
  publicationLedgerFileName,
  type CanonicalRecipient,
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

function delayMs(world: World): number {
  const resolved = eventThresholdsInForce({ home: world.home, root: world.root, team: world.team, now: new Date(AT) });
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.refusals));
  return resolved.thresholds.unreachable_threshold_seconds * 1000;
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
    const delay = escalationDelayOf(world.ctx, AT);
    expect(delay.policy).toBe(ESCALATION_DELAY_POLICY);
    expect(delay.policy).toBe('event-unreachable-threshold-seconds');
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
