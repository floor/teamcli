// Independent scenes for (B) the retirement backlog drain (writer-04, fix/fallback-marker-drain
// b64d9d74f on int/0.5.12). Written against the change's claims, not the builder's tests: the
// threshold is strictly-greater and the bulk limit only ever widens a pass; a pending, unsettled or
// linked marker is never a candidate and an archive-ladder link refuses the whole retirement; a
// retired episode is archived byte for byte — marker and attempt ledger — while its publication
// ledger stays; and a two-thousand-episode pass is measured, because loop starvation is the bug
// this lane exists to fix.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sweepFallbackEscalations } from '../src/daemon/fallback-sweep.ts';
import { readEvents } from '../src/bus/log.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import {
  attemptLedgerFileName,
  escalateDue,
  escalatedRecordId,
  fallbackKeyOf,
  markerPathOf,
  noteTransport,
  retireFinished,
  type CanonicalRecipient,
  type EscalationContext,
  type FallbackContext,
  type FallbackMarker,
  type TransportFact,
} from '../src/send/fallback-events.ts';
import { historyPath } from '../src/send/history.ts';

const AT = '2026-10-20T10:00:00.000Z';
const DIGEST = 'c'.repeat(64);
const TEAM_YAML = `format: 1
entity: floor
project: writer04
session: writer04-dev
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

type World = {
  root: string;
  entityRoot: string;
  home: string;
  team: TeamFile;
  ctx: FallbackContext;
  sweep: EscalationContext;
  recipient: CanonicalRecipient;
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeWorld(tag: string): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `team-drain-writer04-${tag}-`)));
  dirs.push(base);
  const root = join(base, 'repo');
  const entityRoot = join(base, 'entity-repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(entityRoot, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return {
    root,
    entityRoot,
    home,
    team: validated.team,
    ctx: { caller: { kind: 'seat', name: 'worker-1', pane: 'p1', session: 'writer04-dev' }, team: validated.team, root, home, now: () => new Date(AT) },
    sweep: {
      team: validated.team,
      root,
      home,
      now: () => new Date(AT),
      // The target lead fixed, so the fixture needs no entity registry record.
      orchestrator: { seat: 'entity-lead', team: 'floor', root: entityRoot, session: 'floor-hq' },
    },
    recipient: { team: 'writer04', seat: 'worker-2', toId: 'agt_worker2', session: 'writer04-dev', root },
  };
}

function seatDir(world: World): string {
  return join(world.root, '.agents', 'send-drops', world.recipient.session, world.recipient.seat);
}

function markerPath(world: World, messageId: string): string {
  return markerPathOf(world.recipient, messageId);
}

function storeDir(world: World): string {
  return dirname(historyPath(world.team.project, world.root, world.home));
}

function hashOf(world: World, messageId: string): string {
  return createHash('sha256').update(fallbackKeyOf(world.recipient, messageId)).digest('hex').slice(0, 16);
}

function archivedMarkerPath(world: World, messageId: string): string {
  return join(storeDir(world), 'fallback-archive', 'markers', `${hashOf(world, messageId)}.json`);
}

function archivedAttemptsPath(world: World, messageId: string): string {
  return join(storeDir(world), 'fallback-archive', 'attempts', attemptLedgerFileName(world.recipient, messageId));
}

function attemptsPath(world: World, messageId: string): string {
  return join(storeDir(world), attemptLedgerFileName(world.recipient, messageId));
}

/** Eligible delivered episodes written straight to the drop folder: the backlog. */
function backlog(world: World, count: number, from = 0): void {
  mkdirSync(seatDir(world), { recursive: true });
  for (let index = from; index < from + count; index += 1) {
    const marker: FallbackMarker = {
      format: 1,
      messageId: `m-back-${String(index).padStart(5, '0')}`,
      recipient: world.recipient,
      recordDigest: DIGEST,
      sender: 'worker-1',
      status: 'delivered',
      attempts: [],
      receipt: { kind: 'unknown' },
      updatedAt: AT,
    };
    writeFileSync(markerPath(world, marker.messageId), `${JSON.stringify(marker)}\n`);
  }
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

/** A delivered episode through the product's own path, so its attempt ledger exists. */
function deliveredEpisode(world: World, messageId: string): FallbackMarker {
  const noted = noteTransport(world.ctx, fact(world, { messageId, outcome: 'delivered', route: 'native', ms: 30, liveRoutesRemain: true }));
  if (!noted.ok) throw new Error(noted.reason);
  return noted.marker;
}

/** An exhausted episode whose escalation has not been decided: unsettled, never a candidate. */
function unsettledEpisode(world: World, messageId: string): { marker: FallbackMarker; bytes: string } {
  const noted = noteTransport(world.ctx, fact(world, { messageId }));
  if (!noted.ok) throw new Error(noted.reason);
  if (noted.marker.status !== 'all-failed' || noted.marker.escalatedAt !== undefined) throw new Error('the fixture episode is not unsettled');
  return { marker: noted.marker, bytes: readFileSync(markerPath(world, messageId), 'utf8') };
}

function eventCount(world: World, recordId: string): number {
  const read = readEvents(world.team.project, world.root, world.home);
  if (!read.ok) throw new Error(read.reason);
  return read.events.filter((event) => (event.payload as { record_id?: string }).record_id === recordId).length;
}

describe('writer-04: the retirement backlog drain against its own claims', () => {
  test('the threshold is strictly greater, the bulk limit only widens, and the whole arc drains', () => {
    // Exactly at the threshold: the steady limit rules.
    const atThreshold = makeWorld('bound256');
    backlog(atThreshold, 256);
    const steady = retireFinished(atThreshold.sweep, { at: new Date(AT), lockWaitMs: 0, limit: 5, backlogAbove: 256, backlogLimit: 30 });
    expect(steady.retired).toHaveLength(5);

    // One more eligible episode than the threshold: the bulk limit takes over, and a smaller
    // steady limit never narrows it (the max is the wider of the two).
    const above = makeWorld('bound257');
    backlog(above, 257);
    const bulk = retireFinished(above.sweep, { at: new Date(AT), lockWaitMs: 0, limit: 5, backlogAbove: 256, backlogLimit: 30 });
    expect(bulk.retired).toHaveLength(30);

    // The machine daemon's own numbers on a never-retired store: 2,500 clear in two passes
    // (2,000 then the 500 that remain above the threshold) and the third pass has nothing left.
    const machine = makeWorld('machine');
    backlog(machine, 2_500);
    const drain = { limit: 256, backlogAbove: 256, backlogLimit: 2_000, lockWaitMs: 0 } as const;
    const first = retireFinished(machine.sweep, { at: new Date(AT), ...drain });
    expect(first.retired).toHaveLength(2_000);
    const second = retireFinished(machine.sweep, { at: new Date(AT), ...drain });
    expect(second.retired).toHaveLength(500);
    const third = retireFinished(machine.sweep, { at: new Date(AT), ...drain });
    expect(third.retired).toHaveLength(0);

    // A caller whose explicit limit is wider than the bulk limit still gets its wider pass.
    const wider = makeWorld('wider');
    backlog(wider, 2_500);
    const open = retireFinished(wider.sweep, { at: new Date(AT), lockWaitMs: 0, limit: 3_000, backlogAbove: 256, backlogLimit: 2_000 });
    expect(open.retired).toHaveLength(2_500);
  }, 60_000);

  test('a pending, unsettled or trying episode is never a candidate, and the unsettled one escalates after the drain', () => {
    const world = makeWorld('survivors');
    backlog(world, 300);
    const unsettled = unsettledEpisode(world, 'm-hot');
    const unsettledBytes = unsettled.bytes;
    const trying = noteTransport(world.ctx, fact(world, { messageId: 'm-01-warm', outcome: 'held', liveRoutesRemain: true }));
    expect(trying.ok).toBe(true);
    const tryingBytes = readFileSync(markerPath(world, 'm-01-warm'), 'utf8');

    const drained = retireFinished(world.sweep, { at: new Date(AT), lockWaitMs: 0, limit: 10, backlogAbove: 256, backlogLimit: 280 });
    expect(drained.retired.length).toBeGreaterThan(0);
    expect(drained.retired.map((entry) => entry.messageId)).not.toContain('m-hot');
    expect(drained.retired.map((entry) => entry.messageId)).not.toContain('m-01-warm');
    // The unsettled episode is not even a candidate; the trying one is a candidate that waits.
    expect(drained.waiting.map((entry) => entry.messageId)).not.toContain('m-hot');
    expect(drained.waiting.map((entry) => entry.messageId)).toContain('m-01-warm');
    // Both survive byte for byte.
    expect(readFileSync(markerPath(world, 'm-hot'), 'utf8')).toBe(unsettledBytes);
    expect(readFileSync(markerPath(world, 'm-01-warm'), 'utf8')).toBe(tryingBytes);

    // The survivor still escalates exactly once once its instant comes.
    const due = Date.parse(JSON.parse(unsettledBytes).dueAt);
    const fired = escalateDue(world.sweep, { at: new Date(due), lockWaitMs: 0 });
    expect(fired.escalated).toHaveLength(1);
    const recordId = escalatedRecordId(world.recipient, 'm-hot');
    expect(eventCount(world, recordId)).toBe(1);
    const again = escalateDue(world.sweep, { at: new Date(due + 3_600_000), lockWaitMs: 0 });
    expect(again.escalated).toHaveLength(0);
    expect(eventCount(world, recordId)).toBe(1);
  }, 60_000);

  test('a linked marker is never retired, and a link in the archive ladder refuses the whole retirement', () => {
    const world = makeWorld('links');
    backlog(world, 2);
    // An eligible episode whose marker is replaced by a link to a byte-identical copy: the listing
    // filters non-files, so it is not a candidate; nothing is archived and the target is untouched.
    const linked = deliveredEpisode(world, 'm-linked');
    const target = join(world.root, 'linked-copy.json');
    writeFileSync(target, readFileSync(markerPath(world, 'm-linked')));
    rmSync(markerPath(world, 'm-linked'));
    symlinkSync(target, markerPath(world, 'm-linked'));

    const pass = retireFinished(world.sweep, { at: new Date(AT), lockWaitMs: 0, limit: 10 });
    expect(pass.retired.map((entry) => entry.messageId)).not.toContain('m-linked');
    expect(existsSync(archivedMarkerPath(world, 'm-linked'))).toBe(false);
    expect(lstatSync(markerPath(world, 'm-linked')).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain(linked.messageId);

    // The archive ladder itself: one normal retirement creates it, then a link planted at the
    // archive root refuses the next retirement with the live marker untouched (the FLO-1187 rule:
    // a link anywhere below the store never becomes a write path).
    const normal = deliveredEpisode(world, 'm-normal');
    const okay = retireFinished(world.sweep, { at: new Date(AT), lockWaitMs: 0, limit: 10 });
    expect(okay.retired.map((entry) => entry.messageId)).toContain('m-normal');

    const next = deliveredEpisode(world, 'm-ladder');
    const nextBytes = readFileSync(markerPath(world, 'm-ladder'), 'utf8');
    const archiveDir = join(storeDir(world), 'fallback-archive');
    const through = join(world.root, 'archive-elsewhere');
    mkdirSync(through, { recursive: true });
    rmSync(archiveDir, { recursive: true });
    symlinkSync(through, archiveDir);

    const refused = retireFinished(world.sweep, { at: new Date(AT), lockWaitMs: 0, limit: 10 });
    expect(refused.retired.map((entry) => entry.messageId)).not.toContain('m-ladder');
    expect(refused.refused.map((entry) => entry.messageId)).toContain('m-ladder');
    expect(refused.refused.find((entry) => entry.messageId === 'm-ladder')!.reason).toContain('fallback-archive');
    expect(readFileSync(markerPath(world, 'm-ladder'), 'utf8')).toBe(nextBytes);
    // Nothing was written through the link.
    expect(readdirSync(through)).toHaveLength(0);
  }, 60_000);

  test('retiring archives byte for byte, moves the attempt ledger, and leaves the publication ledger', () => {
    const world = makeWorld('archive');
    const plain = deliveredEpisode(world, 'm-plain');
    const plainBytes = readFileSync(markerPath(world, 'm-plain'), 'utf8');
    const plainLedger = readFileSync(attemptsPath(world, 'm-plain'), 'utf8');

    // A refused episode — exhausted, then escalated — so a publication ledger exists to keep.
    const armed = noteTransport(world.ctx, fact(world, { messageId: 'm-refused' }));
    expect(armed.ok).toBe(true);
    const due = Date.parse((armed.ok ? armed.marker : plain).dueAt!);
    const fired = escalateDue(world.sweep, { at: new Date(due), lockWaitMs: 0 });
    expect(fired.escalated).toHaveLength(1);
    const refusedBytes = readFileSync(markerPath(world, 'm-refused'), 'utf8');
    const refusedLedger = readFileSync(attemptsPath(world, 'm-refused'), 'utf8');
    const publicationPath = join(storeDir(world), `fallback-published-${hashOf(world, 'm-refused')}.jsonl`);
    expect(existsSync(publicationPath)).toBe(true);
    const publicationBytes = readFileSync(publicationPath, 'utf8');

    const drained = retireFinished(world.sweep, { at: new Date(due + 3_600_000), lockWaitMs: 0, limit: 10 });
    expect(drained.retired.map((entry) => entry.messageId).sort()).toEqual(['m-plain', 'm-refused']);

    for (const [id, value, ledger] of [['m-plain', JSON.parse(plainBytes), plainLedger], ['m-refused', JSON.parse(refusedBytes), refusedLedger]] as const) {
      // The live marker is gone; the archive holds its exact value (the archived copy is
      // re-serialized in the parser's canonical key order, so the value is compared, not the
      // bytes); the attempt ledger is moved by rename, byte for byte.
      expect(existsSync(markerPath(world, id))).toBe(false);
      expect(existsSync(archivedMarkerPath(world, id))).toBe(true);
      expect(JSON.parse(readFileSync(archivedMarkerPath(world, id), 'utf8'))).toEqual(value);
      expect(existsSync(attemptsPath(world, id))).toBe(false);
      expect(existsSync(archivedAttemptsPath(world, id))).toBe(true);
      expect(readFileSync(archivedAttemptsPath(world, id), 'utf8')).toBe(ledger);
    }
    // The publication ledger stays where it was: replay dedup outlives the episode.
    expect(existsSync(publicationPath)).toBe(true);
    expect(readFileSync(publicationPath, 'utf8')).toBe(publicationBytes);
  }, 60_000);

  test('MEASURED: a two-thousand-episode pass with the daemon numbers, cold and warm', () => {
    const world = makeWorld('measure');
    backlog(world, 2_050);
    const drain = { limit: 256, backlogAbove: 256, backlogLimit: 2_000, lockWaitMs: 0 } as const;

    // The worst case the daemon can face: a never-retired store, the stamp cache cold, and the
    // full bulk limit taken. The whole sweep — escalation pass, retirement, lock reclaim — is
    // synchronous on the daemon's one event loop, so this is exactly the loop's pause.
    const coldStart = performance.now();
    const first = sweepFallbackEscalations({
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(AT),
      retire: drain,
    });
    const coldMs = performance.now() - coldStart;
    expect(first.roots[0]!.retirement!.retired).toHaveLength(2_000);

    const warmStart = performance.now();
    const second = sweepFallbackEscalations({
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(AT),
      retire: drain,
    });
    const warmMs = performance.now() - warmStart;
    expect(second.roots[0]!.retirement!.retired).toHaveLength(50);

    console.log(`writer04 drain measure: cold 2,000-retire pass ${coldMs.toFixed(0)} ms, warm 50-retire pass ${warmMs.toFixed(0)} ms`);
    // A pass must not eat a whole heartbeat, let alone the 30 s housekeeping cadence.
    expect(coldMs).toBeLessThan(5_000);
    expect(warmMs).toBeLessThan(1_000);
  }, 120_000);
});
