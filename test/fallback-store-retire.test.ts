// The fallback store's retirement: a finished episode — delivered, refused by a published
// escalation, or expired past the signed event-retention window — is moved out of the live
// send-drops tree into the store's archive, its attempt ledger goes with it, its publication
// ledger stays (replay dedup outlives the episode), and its key-lock folder is removed. A fact
// for a retired episode is a duplicate that writes nothing, and a fact for an expired one
// reopens it. Stale lock folders whose holder is gone are reclaimed, a live or young one is
// left, and an acquirer whose folder was reclaimed between `mkdir` and `open` retries rather
// than throwing. The sweep retires only when asked; `team fallback prune` lists finished
// episodes by age and, with `--apply`, retires them as the owner. Every home is synthetic.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runFallback } from '../src/commands/fallback.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { projectsFile } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { sweepFallbackEscalations } from '../src/daemon/fallback-sweep.ts';
import {
  attemptLedgerFileName,
  escalateDue,
  fallbackKeyOf,
  fallbackRetentionOf,
  finishedKind,
  markerPathOf,
  noteTransport,
  planRetirement,
  publicationLedgerFileName,
  reclaimFallbackLocks,
  retireFinished,
  type CanonicalRecipient,
  type EscalationContext,
  type FallbackContext,
  type FallbackMarker,
  type TransportFact,
} from '../src/send/fallback-events.ts';
import { historyPath } from '../src/send/history.ts';
import { LOCK_FILE, reclaimLockDir, withLock } from '../src/state.ts';
import { testIo } from './helpers.ts';

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
const CALLER = { kind: 'seat', name: 'worker-1', pane: 'pane-1', session: 'acme-dev' } as const;
const DAY = 86_400_000;

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

function makeWorld(options: { teamFile?: boolean } = {}): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-fallback-store-')));
  dirs.push(base);
  const root = join(base, 'repo');
  const entityRoot = join(base, 'entity-repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(entityRoot, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  if (options.teamFile !== false) writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);

  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    entity: 'floor',
    session: 'acme-dev',
    root,
    roster: [{ agent: 'agt_crewlead0000', seat: 'crew-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });

  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return {
    root,
    entityRoot,
    home,
    team: validated.team,
    ctx: { caller: CALLER, team: validated.team, root, home, now: () => new Date(AT) },
    recipient: { team: 'acme', seat: 'worker-2', toId: 'agt_worker2', session: 'acme-dev', root },
  };
}

/** The daemon's context: no caller, and the target lead fixed so the fixture needs no entity
 *  registry record. */
function sweepContext(world: World): EscalationContext {
  return {
    team: world.team,
    root: world.root,
    home: world.home,
    now: () => new Date(AT),
    orchestrator: { seat: 'entity-lead', team: 'floor', root: world.entityRoot, session: 'floor-hq' },
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

function at(iso: string): Date {
  return new Date(iso);
}

function readMarker(world: World, messageId = 'm-001'): FallbackMarker {
  return JSON.parse(readFileSync(markerPathOf(world.recipient, messageId), 'utf8')) as FallbackMarker;
}

function markerExists(world: World, messageId = 'm-001'): boolean {
  return existsSync(markerPathOf(world.recipient, messageId));
}

function storeDir(world: World): string {
  return dirname(historyPath(world.team.project, world.root, world.home));
}

function hashOf(world: World, messageId = 'm-001'): string {
  return createHash('sha256').update(fallbackKeyOf(world.recipient, messageId)).digest('hex').slice(0, 16);
}

function lockDirOf(world: World, messageId = 'm-001'): string {
  return join(storeDir(world), 'locks', `fallback-${hashOf(world, messageId)}`);
}

function archivedMarkerPath(world: World, messageId = 'm-001'): string {
  return join(storeDir(world), 'fallback-archive', 'markers', `${hashOf(world, messageId)}.json`);
}

function archivedAttemptsPath(world: World, messageId = 'm-001'): string {
  return join(storeDir(world), 'fallback-archive', 'attempts', attemptLedgerFileName(world.recipient, messageId));
}

function attemptsPath(world: World, messageId = 'm-001'): string {
  return join(storeDir(world), attemptLedgerFileName(world.recipient, messageId));
}

function publishedPath(world: World, messageId = 'm-001'): string {
  return join(storeDir(world), publicationLedgerFileName(world.recipient, messageId));
}

function lines(path: string): number {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').length;
}

/** A delivered episode, written by the product itself. */
function delivered(world: World, messageId = 'm-001'): FallbackMarker {
  const noted = noteTransport(world.ctx, fact(world, { messageId, outcome: 'delivered', route: 'native' }));
  if (!noted.ok) throw new Error(noted.reason);
  return noted.marker;
}

/** A refused episode: exhausted, then escalated once its delay runs out. */
function refused(world: World, messageId = 'm-001'): FallbackMarker {
  const first = noteTransport(world.ctx, fact(world, { messageId }));
  if (!first.ok) throw new Error(first.reason);
  const due = Date.parse(first.dueAt!);
  const report = escalateDue(sweepContext(world), { at: new Date(due), lockWaitMs: 0 });
  if (report.escalated.length !== 1) throw new Error(`no escalation: ${JSON.stringify(report)}`);
  return readMarker(world, messageId);
}

/** A walk still trying: no exhaustion, so nothing is scheduled. */
function trying(world: World, messageId = 'm-001', when = AT): FallbackMarker {
  const noted = noteTransport(world.ctx, fact(world, { messageId, outcome: 'held', liveRoutesRemain: true, at: when }));
  if (!noted.ok) throw new Error(noted.reason);
  return noted.marker;
}

describe('the fallback store retirement', () => {
  test('classifies only finished episodes', () => {
    const world = makeWorld();
    expect(finishedKind(delivered(world, 'm-001'))).toBe('delivered');
    expect(finishedKind(refused(world, 'm-002'))).toBe('refused');
    expect(finishedKind(trying(world, 'm-003'))).toBe('expired');

    const pending = noteTransport(world.ctx, fact(world, { messageId: 'm-004' }));
    if (!pending.ok) throw new Error(pending.reason);
    expect(finishedKind(pending.marker)).toBeNull();

    // An event intent not yet flushed is unfinished whatever the status says: the escalation
    // pass must retry it first, and retirement must never archive an unflushed episode.
    const deliveredMarker = delivered(world, 'm-005');
    expect(finishedKind({ ...deliveredMarker, outbox: { kind: 'escalated', recordId: 'r', at: AT } })).toBeNull();
  });

  test('retires a delivered episode, archives its marker and attempts, and removes its lock folder', () => {
    const world = makeWorld();
    delivered(world);
    expect(markerExists(world)).toBe(true);
    expect(existsSync(attemptsPath(world))).toBe(true);
    expect(existsSync(lockDirOf(world))).toBe(true);

    const report = retireFinished(world.ctx, { at: at(AT), lockWaitMs: 0 });
    expect(report.retired).toHaveLength(1);
    expect(report.retired[0]!.kind).toBe('delivered');
    expect(report.refused).toHaveLength(0);

    expect(markerExists(world)).toBe(false);
    expect(existsSync(archivedMarkerPath(world))).toBe(true);
    const archived = JSON.parse(readFileSync(archivedMarkerPath(world), 'utf8')) as FallbackMarker;
    expect(archived.status).toBe('delivered');
    expect(archived.messageId).toBe('m-001');
    expect(archived.recipient).toEqual(world.recipient);

    expect(existsSync(attemptsPath(world))).toBe(false);
    expect(existsSync(archivedAttemptsPath(world))).toBe(true);
    expect(lines(archivedAttemptsPath(world))).toBe(1);

    expect(existsSync(lockDirOf(world))).toBe(false);
  });

  test('retires a refused episode and keeps its publication ledger', () => {
    const world = makeWorld();
    refused(world);
    expect(existsSync(publishedPath(world))).toBe(true);
    const published = readFileSync(publishedPath(world), 'utf8');

    const report = retireFinished(world.ctx, { at: at('2026-10-20T10:05:00.000Z'), lockWaitMs: 0 });
    expect(report.retired).toHaveLength(1);
    expect(report.retired[0]!.kind).toBe('refused');
    expect(markerExists(world)).toBe(false);
    expect(existsSync(archivedMarkerPath(world))).toBe(true);

    // The published escalation is the replay proof: it is never archived away.
    expect(existsSync(publishedPath(world))).toBe(true);
    expect(readFileSync(publishedPath(world), 'utf8')).toBe(published);
  });

  test('leaves a pending escalation and a walk inside the retention window alone', () => {
    const world = makeWorld();
    const pending = noteTransport(world.ctx, fact(world, { messageId: 'm-001' }));
    if (!pending.ok) throw new Error(pending.reason);
    trying(world, 'm-002');

    const plan = planRetirement(world.ctx, { at: at('2026-10-21T10:00:00.000Z') });
    // Only the still-trying walk is a finished candidate; the pending escalation is not.
    expect(plan.candidates.map((entry) => entry.messageId)).toEqual(['m-002']);
    expect(plan.candidates[0]!.kind).toBe('expired');
    expect(plan.candidates[0]!.eligible).toBe(false);
    expect(plan.retention?.seconds).toBe(30 * 86_400);

    const report = retireFinished(world.ctx, { at: at('2026-10-21T10:00:00.000Z'), lockWaitMs: 0 });
    expect(report.retired).toHaveLength(0);
    expect(report.waiting.map((entry) => entry.messageId)).toEqual(['m-002']);
    expect(markerExists(world, 'm-001')).toBe(true);
    expect(markerExists(world, 'm-002')).toBe(true);
  });

  test('retires an expired walk once the signed retention window runs out', () => {
    const world = makeWorld();
    trying(world);

    const inside = planRetirement(world.ctx, { at: at('2026-11-19T09:59:59.000Z') }); // 29d 23:59:59
    expect(inside.candidates[0]!.eligible).toBe(false);

    const past = planRetirement(world.ctx, { at: at('2026-11-19T10:00:00.000Z') }); // exactly 30d
    expect(past.candidates[0]!.kind).toBe('expired');
    expect(past.candidates[0]!.eligible).toBe(true);

    const report = retireFinished(world.ctx, { at: at('2026-11-19T10:00:00.000Z'), lockWaitMs: 0 });
    expect(report.retired).toHaveLength(1);
    expect(report.retired[0]!.kind).toBe('expired');
    expect(markerExists(world)).toBe(false);
  });

  test('a shorter signed retention word is the window the pass uses', () => {
    const world = makeWorld();
    trying(world);
    const wrote = writePolicySet(
      world.home,
      { level: 'team', target: world.root, teamRoot: world.root, name: 'event-retention-days', value: 2 },
      { now: at(AT) },
    );
    expect(wrote.ok).toBe(true);

    const inside = planRetirement(world.ctx, { at: at('2026-10-22T09:59:59.000Z') });
    expect(inside.retention?.seconds).toBe(2 * 86_400);
    expect(inside.candidates[0]!.eligible).toBe(false);

    const report = retireFinished(world.ctx, { at: at('2026-10-22T10:00:00.000Z'), lockWaitMs: 0 });
    expect(report.retired).toHaveLength(1);
  });

  test('an unreadable retention chain retires nothing expired and says why', () => {
    const world = makeWorld();
    trying(world, 'm-001');
    delivered(world, 'm-002');

    // The project registry carries a signed policy source: a corrupt one is a refusal, never a
    // run on the release default.
    writeFileSync(projectsFile(world.home), 'not-a-map\n', { mode: 0o600 });

    const plan = planRetirement(world.ctx, { at: at('2027-10-20T10:00:00.000Z') });
    expect(plan.retention).not.toBeNull();
    expect(plan.retention!.seconds).toBeNull();
    expect(plan.retention!.refusal).not.toBeNull();
    expect(plan.candidates.find((entry) => entry.messageId === 'm-001')!.eligible).toBe(false);

    const report = retireFinished(world.ctx, { at: at('2027-10-20T10:00:00.000Z'), lockWaitMs: 0 });
    // The delivered episode needs no chain, so it still goes; the expired one waits, named.
    expect(report.retired.map((entry) => entry.messageId)).toEqual(['m-002']);
    expect(report.waiting.map((entry) => entry.messageId)).toEqual(['m-001']);
    expect(markerExists(world, 'm-001')).toBe(true);
    expect(markerExists(world, 'm-002')).toBe(false);
  });

  test('a fact after retirement is a duplicate that writes nothing', () => {
    const world = makeWorld();
    delivered(world);
    retireFinished(world.ctx, { at: at(AT), lockWaitMs: 0 });

    const again = noteTransport(world.ctx, fact(world, { outcome: 'delivered', route: 'native', at: '2026-10-20T10:10:00.000Z' }));
    if (!again.ok) throw new Error(again.reason);
    expect(again.state).toBe('duplicate');
    expect(again.event).toBeUndefined();
    expect(again.eventDuplicate).toBe(false);
    expect(markerExists(world)).toBe(false);
    expect(existsSync(attemptsPath(world))).toBe(false);

    // The archived marker keeps the episode's identity: another digest is still a conflict.
    const conflict = noteTransport(world.ctx, fact(world, { recordDigest: 'b'.repeat(64), outcome: 'delivered' }));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.kind).toBe('conflict');
  });

  test('a fact for an expired episode reopens it', () => {
    const world = makeWorld();
    trying(world);
    retireFinished(world.ctx, { at: at('2026-11-19T10:00:00.000Z'), lockWaitMs: 0 });
    expect(markerExists(world)).toBe(false);

    const later = '2026-11-20T10:00:00.000Z';
    const reopened = noteTransport(world.ctx, fact(world, { at: later, outcome: 'held', liveRoutesRemain: true }));
    if (!reopened.ok) throw new Error(reopened.reason);
    expect(reopened.state).toBe('continued');
    expect(markerExists(world)).toBe(true);
    expect(readMarker(world).status).toBe('trying');
    expect(readMarker(world).updatedAt).toBe(later);
    expect(existsSync(attemptsPath(world))).toBe(true);
    // The archived summary stays readable beside the reopened episode.
    expect(existsSync(archivedMarkerPath(world))).toBe(true);
  });

  test('retires at most the limit the sweep gives it', () => {
    const world = makeWorld();
    delivered(world, 'm-001');
    delivered(world, 'm-002');
    delivered(world, 'm-003');

    const first = retireFinished(world.ctx, { at: at(AT), lockWaitMs: 0, limit: 2 });
    expect(first.retired).toHaveLength(2);
    expect(markerExists(world, 'm-003')).toBe(true);

    const second = retireFinished(world.ctx, { at: at(AT), lockWaitMs: 0 });
    expect(second.retired.map((entry) => entry.messageId)).toEqual(['m-003']);
    expect([markerExists(world, 'm-001'), markerExists(world, 'm-002'), markerExists(world, 'm-003')]).toEqual([
      false,
      false,
      false,
    ]);
  });

  test('the sweep retires only when asked, and a retired episode leaves the walk', () => {
    const world = makeWorld();
    delivered(world);

    const plain = sweepFallbackEscalations({
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(AT),
    });
    expect(plain.roots[0]!.retirement).toBeNull();
    expect(markerExists(world)).toBe(true);

    const asked = sweepFallbackEscalations({
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(AT),
      retire: { limit: 64, lockWaitMs: 0 },
    });
    expect(asked.roots[0]!.retirement!.retired).toHaveLength(1);
    expect(markerExists(world)).toBe(false);

    // The next passes read no marker at all: cost falls with the history instead of growing.
    const after = planRetirement(world.ctx, { at: at(AT) });
    expect(after.scanned).toBe(0);
    expect(after.candidates).toHaveLength(0);
  });

  test('reclaims stale lock folders and leaves live, young and foreign ones', () => {
    const world = makeWorld();
    const locksDir = join(storeDir(world), 'locks');
    mkdirSync(locksDir, { recursive: true });

    const empty = join(locksDir, 'fallback-aaaaaaaaaaaaaaaa');
    withLock(empty, () => {});
    expect(existsSync(empty)).toBe(true);

    const dead = join(locksDir, 'fallback-bbbbbbbbbbbbbbbb');
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, LOCK_FILE), '2147483647\n');

    const live = join(locksDir, 'fallback-cccccccccccccccc');
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, LOCK_FILE), `${String(process.pid)}\n`);

    const young = join(locksDir, 'fallback-dddddddddddddddd');
    mkdirSync(young, { recursive: true });
    writeFileSync(join(young, LOCK_FILE), '\n');

    const foreign = join(locksDir, 'other-eeeeeeeeeeeeeeee');
    mkdirSync(foreign, { recursive: true });

    const report = reclaimFallbackLocks(world.ctx, { limit: 64, youngMs: 0 });
    expect(report.reclaimed).toBe(2);
    expect(existsSync(empty)).toBe(false);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(foreign)).toBe(true);

    // Without the grace an empty folder a live acquirer just made is left alone.
    const fresh = join(locksDir, 'fallback-ffffffffffffffff');
    mkdirSync(fresh, { recursive: true });
    expect(reclaimLockDir(fresh, { youngMs: 60_000 })).toBe('kept');
    expect(existsSync(fresh)).toBe(true);
  });

  test('an acquirer survives a sweep reclaiming its folder between mkdir and open', async () => {
    const world = makeWorld();
    const dir = lockDirOf(world, 'm-777');
    const base = dirname(world.root);
    const scriptPath = join(base, 'acquire-loop.ts');
    const stateModule = join(import.meta.dir, '..', 'src', 'state.ts');
    writeFileSync(
      scriptPath,
      `import { withLock } from ${JSON.stringify(stateModule)};
const [dir] = process.argv.slice(2);
for (let i = 0; i < 800; i += 1) withLock(dir, () => {}, { waitMs: 2_000 });
`,
    );
    const proc = Bun.spawn([process.execPath, scriptPath, dir], { stdout: 'ignore', stderr: 'pipe' });
    while (proc.exitCode === null) {
      reclaimFallbackLocks(world.ctx, { limit: 64, youngMs: 0 });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });
});

describe('the fallback archive is held to the state ladder', () => {
  /** One delivered episode and a folder outside the store that a link in the archive would
   *  reach. */
  function linked(world: World, path: string): { outside: string; link: string } {
    const outside = join(dirname(world.root), 'outside-archive');
    mkdirSync(outside, { recursive: true });
    const link = join(storeDir(world), path);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link);
    return { outside, link };
  }

  test('a linked archive folder is refused, and nothing lands outside the store', () => {
    const world = makeWorld();
    delivered(world);
    const { outside } = linked(world, 'fallback-archive');

    const report = retireFinished(world.ctx, { at: at(AT), lockWaitMs: 0 });
    expect(report.retired).toHaveLength(0);
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0]!.reason).toContain('symbolic link');
    expect(report.refused[0]!.reason).toContain('fallback-archive');

    expect(readdirSync(outside)).toEqual([]);
    expect(markerExists(world)).toBe(true);
    expect(existsSync(attemptsPath(world))).toBe(true);
  });

  test('a linked markers folder is refused, and nothing lands outside the store', () => {
    const world = makeWorld();
    delivered(world);
    const { outside } = linked(world, join('fallback-archive', 'markers'));

    const report = retireFinished(world.ctx, { at: at(AT), lockWaitMs: 0 });
    expect(report.retired).toHaveLength(0);
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0]!.reason).toContain('symbolic link');
    expect(report.refused[0]!.reason).toContain('markers');

    expect(readdirSync(outside)).toEqual([]);
    expect(markerExists(world)).toBe(true);
  });

  test('a linked attempts folder is refused before the marker is archived', () => {
    const world = makeWorld();
    delivered(world);
    const { outside } = linked(world, join('fallback-archive', 'attempts'));

    const report = retireFinished(world.ctx, { at: at(AT), lockWaitMs: 0 });
    expect(report.retired).toHaveLength(0);
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0]!.reason).toContain('symbolic link');
    expect(report.refused[0]!.reason).toContain('attempts');

    expect(readdirSync(outside)).toEqual([]);
    // The refusal comes before the first write: the live marker and its ledger are untouched,
    // and the real markers folder stays empty.
    expect(markerExists(world)).toBe(true);
    expect(existsSync(attemptsPath(world))).toBe(true);
    expect(existsSync(archivedMarkerPath(world))).toBe(false);
  });

  test('a source ledger already appended to the archive is removed, not appended again', () => {
    const world = makeWorld();
    delivered(world);
    const text = readFileSync(attemptsPath(world), 'utf8');
    mkdirSync(dirname(archivedAttemptsPath(world)), { recursive: true });
    writeFileSync(archivedAttemptsPath(world), text, { mode: 0o600 });

    // An earlier pass appended the ledger and then failed to remove the source.
    const report = retireFinished(world.ctx, { at: at(AT), lockWaitMs: 0 });
    expect(report.refused).toHaveLength(0);
    expect(report.retired).toHaveLength(1);
    expect(lines(archivedAttemptsPath(world))).toBe(1);
    expect(existsSync(attemptsPath(world))).toBe(false);
    expect(markerExists(world)).toBe(false);
  });

  test('a source ledger the archive does not yet hold is merged into it atomically', () => {
    const world = makeWorld();
    delivered(world);
    const text = readFileSync(attemptsPath(world), 'utf8');
    mkdirSync(dirname(archivedAttemptsPath(world)), { recursive: true });
    writeFileSync(archivedAttemptsPath(world), '{"episode":"an older one"}\n', { mode: 0o600 });

    const report = retireFinished(world.ctx, { at: at(AT), lockWaitMs: 0 });
    expect(report.refused).toHaveLength(0);
    expect(report.retired).toHaveLength(1);
    expect(readFileSync(archivedAttemptsPath(world), 'utf8')).toBe(`{"episode":"an older one"}\n${text}`);
    expect(existsSync(attemptsPath(world))).toBe(false);
  });
});

describe('team fallback prune', () => {
  type Sources = { home: string; now: () => Date };

  function sources(world: World): Sources {
    return { home: world.home, now: () => new Date(AT) };
  }

  test('a dry run lists finished episodes by age and exits 1 when one is due', async () => {
    const world = makeWorld();
    delivered(world, 'm-001');
    trying(world, 'm-002');

    const io = testIo(world.root, { kind: 'seat', name: 'worker-1', pane: 'pane-1', session: 'acme-dev' });
    const code = await runFallback(['prune'], io, sources(world));
    expect(code).toBe(1);
    expect(io.out).toContain('2 finished fallback episodes: 1 episode to retire');
    expect(io.out).toContain('EPISODE');
    expect(io.out).toContain('m-001');
    expect(io.out).toContain('delivered');
    expect(io.out).toContain('retire');
    expect(io.out).toContain('expired');
    expect(io.out).toContain('none');
    // The dry run writes nothing.
    expect(markerExists(world, 'm-001')).toBe(true);
    expect(markerExists(world, 'm-002')).toBe(true);
  });

  test('a store with nothing finished exits 0', async () => {
    const world = makeWorld();
    const io = testIo(world.root, { kind: 'owner' });
    const code = await runFallback(['prune'], io, sources(world));
    expect(code).toBe(0);
    expect(io.out).toContain('no finished fallback episode stands in this project\'s state store');
  });

  test('--apply retires every eligible episode for the owner', async () => {
    const world = makeWorld();
    delivered(world, 'm-001');
    trying(world, 'm-002');

    const io = testIo(world.root, { kind: 'owner' });
    const code = await runFallback(['prune', '--apply'], io, sources(world));
    expect(code).toBe(0);
    expect(io.out).toContain('1 episode retired');
    expect(markerExists(world, 'm-001')).toBe(false);
    expect(markerExists(world, 'm-002')).toBe(true);
    expect(existsSync(archivedMarkerPath(world, 'm-001'))).toBe(true);
  });

  test('--apply is the owner\'s alone', async () => {
    const world = makeWorld();
    delivered(world);
    const io = testIo(world.root, { kind: 'seat', name: 'worker-1', pane: 'pane-1', session: 'acme-dev' });
    const code = await runFallback(['prune', '--apply'], io, sources(world));
    expect(code).toBe(1);
    expect(io.err).toContain('--apply is the owner\'s');
    expect(markerExists(world)).toBe(true);
  });

  test('an unreadable retention chain refuses the run', async () => {
    const world = makeWorld();
    trying(world);
    writeFileSync(projectsFile(world.home), 'not-a-map\n', { mode: 0o600 });
    const io = testIo(world.root, { kind: 'owner' });
    const code = await runFallback(['prune'], io, sources(world));
    expect(code).toBe(1);
    expect(io.err).toContain('event-retention');
  });

  test('the invocation is read strictly', async () => {
    const world = makeWorld();
    const io = testIo(world.root, { kind: 'owner' });
    const code = await runFallback([], io, sources(world));
    expect(code).toBe(2);
    expect(io.err).toContain('a subcommand is required (prune)');
  });

  test('--json prints one team.fallback document', async () => {
    const world = makeWorld();
    delivered(world);
    const io = testIo(world.root, { kind: 'owner' });
    const code = await runFallback(['prune', '--json'], io, sources(world));
    expect(code).toBe(1);
    const doc = JSON.parse(io.out) as {
      schema: { name: string };
      apply: boolean;
      episodes: { message_id: string; state: string; action: string; age_seconds: number }[];
      counts: { listed: number; to_retire: number };
    };
    expect(doc.schema.name).toBe('team.fallback');
    expect(doc.apply).toBe(false);
    expect(doc.episodes).toHaveLength(1);
    expect(doc.episodes[0]!.message_id).toBe('m-001');
    expect(doc.episodes[0]!.state).toBe('delivered');
    expect(doc.episodes[0]!.action).toBe('retire');
    expect(doc.counts).toMatchObject({ listed: 1, to_retire: 1 });
  });
});
