// The fallback marker stamp cache: the daemon's sweep walks every hosted root on each heartbeat,
// so an unchanged marker must cost a stat rather than a read and a parse. A changed or vanished
// marker must still be seen, and a due marker must escalate exactly once through the cached path.
// The cost is asserted in marker reads, never in wall time.
import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents, verifySignedEvent, type SignedEventRecord } from '../src/bus/log.ts';
import type { Caller } from '../src/caller.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import {
  escalatedRecordId,
  escalateDue,
  markerCacheStats,
  markerPathOf,
  noteTransport,
  type CanonicalRecipient,
  type FallbackContext,
  type FallbackMarker,
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
const CALLER: Caller = { kind: 'seat', name: 'worker-1', pane: 'pane-worker-1', session: 'acme-dev' };

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

function makeWorld(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-fallback-cache-')));
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
  upsertTeam(home, teamIdOf(entityRoot), {
    project: 'floor',
    entity: 'floor',
    session: 'floor-hq',
    root: entityRoot,
    roster: [{ agent: 'agt_entitylead00', seat: 'entity-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });

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

/** Settled episodes written straight to a seat's drop folder, the way a long-lived checkout has
 *  thousands of them: enough that a full read of the tree is the sweep's whole cost. */
function writeSettledMarkers(world: World, count: number): void {
  const dir = join(world.root, '.agents', 'send-drops', world.recipient.session, world.recipient.seat);
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const messageId = `m-${String(index).padStart(5, '0')}`;
    const marker = {
      format: 1,
      messageId,
      recipient: world.recipient,
      recordDigest: DIGEST,
      sender: 'worker-1',
      status: 'delivered',
      attempts: [],
      updatedAt: AT,
    };
    writeFileSync(join(dir, `${messageId}.fallback.json`), `${JSON.stringify(marker)}\n`);
  }
}

describe('the fallback marker stamp cache', () => {
  test('an unchanged marker is answered from its stamp, not read again', () => {
    const world = makeWorld();
    const note = noteTransport(world.ctx, fact(world));
    if (!note.ok) throw new Error(note.reason);
    // Before its due instant the marker has nothing to do, so each pass walks it without a lock.
    const first = escalateDue(world.ctx, { at: new Date(Date.parse(AT) + 1_000) });
    expect(first.scanned).toBe(1);
    const warm = markerCacheStats();
    expect(warm.read).toBeGreaterThan(0);

    const second = escalateDue(world.ctx, { at: new Date(Date.parse(AT) + 2_000) });
    expect(second.scanned).toBe(1);
    const after = markerCacheStats();
    expect(after.read - warm.read).toBe(0);
    expect(after.reused - warm.reused).toBe(1);
  });

  test('a changed stamp is read again, by modification time or by size', () => {
    const world = makeWorld();
    const note = noteTransport(world.ctx, fact(world));
    if (!note.ok) throw new Error(note.reason);
    const path = markerPathOf(world.recipient, 'm-001');
    escalateDue(world.ctx, { at: new Date(Date.parse(AT) + 1_000) });

    // Same bytes, later modification time.
    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);
    let before = markerCacheStats();
    escalateDue(world.ctx, { at: new Date(Date.parse(AT) + 2_000) });
    let after = markerCacheStats();
    expect(after.read - before.read).toBe(1);
    expect(after.reused - before.reused).toBe(0);

    // Same modification time family, a longer file: the size alone forces the read.
    appendFileSync(path, '\n');
    before = markerCacheStats();
    escalateDue(world.ctx, { at: new Date(Date.parse(AT) + 3_000) });
    after = markerCacheStats();
    expect(after.read - before.read).toBe(1);
    expect(after.reused - before.reused).toBe(0);
    expect(readMarker(world).messageId).toBe('m-001');
  });

  test('a marker deleted between passes leaves the cache', () => {
    const world = makeWorld();
    const note = noteTransport(world.ctx, fact(world));
    if (!note.ok) throw new Error(note.reason);
    escalateDue(world.ctx, { at: new Date(Date.parse(AT) + 1_000) });
    const warm = markerCacheStats();
    expect(warm.cached).toBeGreaterThan(0);

    unlinkSync(markerPathOf(world.recipient, 'm-001'));
    const after = escalateDue(world.ctx, { at: new Date(Date.parse(AT) + 2_000) });
    expect(after.scanned).toBe(0);
    expect(after.unreadable).toHaveLength(0);
    expect(markerCacheStats().cached).toBe(warm.cached - 1);
  });

  test('a due marker still escalates exactly once through the cached pass', () => {
    const world = makeWorld();
    const note = noteTransport(world.ctx, fact(world));
    if (!note.ok) throw new Error(note.reason);
    const due = Date.parse(note.dueAt!);

    const fired = escalateDue(world.ctx, { at: new Date(due) });
    expect(fired.refused).toHaveLength(0);
    expect(fired.escalated).toHaveLength(1);
    expect(fired.escalated[0]!.event.payload.record_id).toBe(escalatedRecordId(world.recipient, 'm-001'));
    expect(readMarker(world).escalatedAt).toBe(new Date(due).toISOString());

    // The escalation rewrote the marker, so the next pass reads it afresh and finds it settled.
    const again = escalateDue(world.ctx, { at: new Date(due + 60_000) });
    expect(again.escalated).toHaveLength(0);
    expect(verifiedLog(world)).toHaveLength(2);
  });

  test('a store of settled episodes costs one read each, then only stats', () => {
    const world = makeWorld();
    const settled = 3_000;
    writeSettledMarkers(world, settled);

    const first = escalateDue(world.ctx, { at: new Date(Date.parse(AT) + 1_000) });
    expect(first.escalated).toHaveLength(0);
    expect(first.unreadable).toHaveLength(0);
    expect(first.scanned).toBe(settled);
    const warm = markerCacheStats();

    const second = escalateDue(world.ctx, { at: new Date(Date.parse(AT) + 2_000) });
    expect(second.escalated).toHaveLength(0);
    expect(second.scanned).toBe(settled);
    const after = markerCacheStats();
    expect(after.read - warm.read).toBe(0);
    expect(after.reused - warm.reused).toBe(settled);
  });
});
