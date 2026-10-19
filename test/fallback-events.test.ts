// The fallback episode's focused fixtures: one all-failed event per episode, routed to the sender
// and the receiver's lead; persistent dedup in the marker, not the rotating event log; the policy-
// delayed main escalation fired once and resumed after a restart; recovery cancellation; the
// digest as a checked value; and typed transport receipts where a missing one is explicit.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
  escalateDue,
  escalatedRecordId,
  escalationMailboxId,
  markerPathOf,
  noteTransport,
  type CanonicalRecipient,
  type FallbackContext,
  type FallbackMarker,
  type RelayReceipt,
  type TransportFact,
} from '../src/send/fallback-events.ts';

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

function verifiedLog(world: World): SignedEventRecord[] {
  const res = readEvents(world.team.project, world.root, world.home);
  if (!res.ok) throw new Error(res.reason);
  expect(res.unverified).toBe(0);
  for (const record of res.events) expect(verifySignedEvent(record, world.home)).toBe(true);
  return res.events;
}

describe('the fallback episode', () => {
  test('records one all-failed event for the sender and the receiver lead', () => {
    const world = makeWorld();
    const note = noteTransport(world.ctx, fact(world));
    if (!note.ok) throw new Error(note.reason);

    expect(note.state).toBe('all-failed');
    expect(note.eventDuplicate).toBe(false);
    expect(note.dueAt).toBe(new Date(Date.parse(AT) + delayMs(world)).toISOString());

    const events = verifiedLog(world);
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload;
    expect(payload.kind).toBe('message.held');
    expect(payload.record_id).toBe(allFailedRecordId('m-001'));
    expect(payload.from).toBe('worker-1');
    expect(payload.to).toBe('worker-2');
    expect(payload.seat).toBe('worker-2');
    expect(payload.thread).toBe('m-001');
    expect(payload.reason).toBe('all live routes failed');
    expect(payload.via).toBe('socket');
    const routed = recipientsForEvent(payload, world.team);
    expect(routed.has('worker-1')).toBe(true);
    expect(routed.has('crew-lead')).toBe(true);

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
    expect(entry.event.payload.record_id).toBe(escalatedRecordId('m-001'));
    expect(entry.event.payload.kind).toBe('message.held');
    expect(entry.event.payload.to).toBe('entity-lead');
    expect(entry.event.payload.from).toBe('worker-1');
    expect(entry.event.payload.via).toBe('fallback');
    expect(entry.mailbox).toBe(messageFile(world.entityRoot, 'entity-lead', escalationMailboxId('m-001')));
    const mailbox = JSON.parse(readFileSync(entry.mailbox!, 'utf8')) as {
      payload: { to: string; id: string; body: string; session: string };
    };
    expect(mailbox.payload.to).toBe('entity-lead');
    expect(mailbox.payload.id).toBe(escalationMailboxId('m-001'));
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
});
