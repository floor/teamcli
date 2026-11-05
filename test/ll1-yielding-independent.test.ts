// Independent coverage for the LL1 sweep changes: a chores slice must be checked inside a store
// scan, a stop must leave the store exactly as it found it, and the sliced pass must do exactly
// what the one-shot pass does — the same drained notes, escalations, retirements and drop
// archives, down to the bytes on disk.
//
// The world is synthetic and small: a scratch team, a scratch home, one seat folder holding
// staged signed drops, deferred notes, transport markers and decoy sidecars. Nothing here reads
// the machine's real state or the owner's files.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import { choresPolicyFor } from '../src/daemon/chores/policy.ts';
import { sweepFallbackEscalations, sweepFallbackEscalationsSliced } from '../src/daemon/fallback-sweep.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { DAEMON_CHORES_DEFAULTS, POLICY_CATALOGUE, writePolicySet } from '../src/policy/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { dropRetirementSteps, retireDropsSliced } from '../src/send/drop-retention.ts';
import {
  type CanonicalRecipient,
  deferredNotePathOf,
  markerPathOf,
  noteTransport,
  type TransportFact,
} from '../src/send/fallback-events.ts';
import { RECORD_KIND, signReceiptPayload, writeReceipt } from '../src/send/record.ts';
import { MESSAGE_DOMAIN, messageKeyOf, signDomain } from '../src/store/keys.ts';

const AT = '2026-10-20T10:00:00.000Z';
const DUE = '2026-10-20T10:06:00.000Z';
const DIGEST = 'd'.repeat(64);
const SESSION = 'll1-dev';
const SEAT = 'sailor-1';
const LEAD = 'deck-lead';
const CALLER = { kind: 'seat', name: LEAD, pane: 'fixture-pane-2', session: SESSION } as const;

const TEAM_YAML = `format: 1
project: ll1
coordinator: ${LEAD}
operator: ${SEAT}
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${LEAD}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
  - role: worker
    name: ${SEAT}
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type World = {
  base: string;
  home: string;
  root: string;
  team: TeamFile;
  recipient: CanonicalRecipient;
  ctx: Parameters<typeof noteTransport>[0];
  seatDir: string;
};

function makeWorld(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'll1-independent-')));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'repo');
  const entityRoot = join(base, 'hq');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(entityRoot, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  upsertTeam(home, teamIdOf(root), {
    project: 'll1',
    entity: 'll1-org',
    session: SESSION,
    root,
    roster: [{ agent: 'agt_decklead0000', seat: LEAD, role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  upsertTeam(home, teamIdOf(entityRoot), {
    project: 'll1-org',
    entity: 'll1-org',
    session: 'll1-hq',
    root: entityRoot,
    roster: [{ agent: 'agt_hqlead000000', seat: LEAD, role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  const recipient: CanonicalRecipient = { team: 'll1', seat: SEAT, toId: null, session: SESSION, root };
  const ctx = { caller: CALLER, team: validated.team, root, home, now: () => new Date(AT) };
  messageKeyOf(home);
  const seatDir = join(root, '.agents', 'send-drops', SESSION, SEAT);
  mkdirSync(seatDir, { recursive: true });
  return { base, home, root, team: validated.team, recipient, ctx, seatDir };
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every path under `dir`, with each file's digest and each folder's name. Order is sorted, so
 *  two trees compare only when the same files hold the same bytes. */
function treeOf(dir: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (at: string): void => {
    const entries = readdirSync(at, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        out.push([`${relative(dir, full)}/`, 'dir']);
        walk(full);
      } else {
        out.push([relative(dir, full), sha256(readFileSync(full))]);
      }
    }
  };
  walk(dir);
  return out;
}

function snapshot(world: World): string {
  const saved = join(world.base, '..', `saved-${String(Math.random()).slice(2)}`);
  cpSync(world.base, saved, { recursive: true, preserveTimestamps: true });
  dirs.push(saved);
  return saved;
}

function restore(world: World, saved: string): void {
  rmSync(world.base, { recursive: true, force: true });
  cpSync(saved, world.base, { recursive: true, preserveTimestamps: true });
}

function stageRecord(world: World, id: string, at = AT): { digest: string; path: string } {
  const payload = {
    kind: RECORD_KIND,
    id,
    from: 'owner',
    from_id: null,
    to: SEAT,
    to_id: null,
    root: world.root,
    session: SESSION,
    at,
    rule: 'all',
    thread: id,
    body: `body for ${id}`,
  };
  const signature = signDomain(MESSAGE_DOMAIN, payload, messageKeyOf(world.home));
  const text = `${JSON.stringify({ payload, signature })}\n`;
  const path = join(world.seatDir, id);
  writeFileSync(path, text);
  return { digest: sha256(text), path };
}

function stageRead(world: World, id: string, at = AT): void {
  const receipt = signReceiptPayload(
    { kind: 'receipt', status: 'read', id, to: SEAT, root: world.root, session: SESSION, at },
    world.home,
  );
  const wrote = writeReceipt(world.seatDir, receipt, world.home);
  if (!wrote.ok) throw new Error(wrote.reason);
}

function deferredNote(world: World, id: string, fact: TransportFact, index: number): string {
  const path = deferredNotePathOf(world.recipient, id, String(index).padStart(16, '0'));
  writeFileSync(path, `${JSON.stringify({ format: 1, sender: 'owner', fact })}\n`);
  return path;
}

function factFor(recipient: CanonicalRecipient, id: string, over: Partial<TransportFact> = {}): TransportFact {
  return {
    messageId: id,
    recipient,
    recordDigest: DIGEST,
    route: 'socket',
    outcome: 'unreachable',
    reason: 'the socket did not answer',
    at: AT,
    ms: 100,
    liveRoutesRemain: false,
    ...over,
  };
}

function marker(world: World, id: string, over: Partial<TransportFact> = {}): void {
  const noted = noteTransport(world.ctx, factFor(world.recipient, id, over));
  if (!noted.ok) throw new Error(noted.reason);
}

/** A world with every kind of work the pass judges: 2 delivered notes, 1 exhausted note that is
 *  due in the same pass, 1 unreadable note, 2 direct due markers, 3 direct delivered markers, 1
 *  corrupt marker, 2 archivable drop families, 1 young family and 1 family a sidecar holds, plus
 *  100 decoy sidecars that are expected names and carry no work. */
function makeWorkWorld(): World {
  const world = makeWorld();
  for (const [index, id] of ['dn-01', 'dn-02'].entries()) {
    const staged = stageRecord(world, id);
    deferredNote(
      world, id,
      factFor(world.recipient, id, { recordDigest: staged.digest, outcome: 'delivered', route: 'native', reason: undefined }),
      index,
    );
  }
  const due = stageRecord(world, 'dn-03');
  deferredNote(world, 'dn-03', factFor(world.recipient, 'dn-03', { recordDigest: due.digest }), 10);
  writeFileSync(deferredNotePathOf(world.recipient, 'bad-note', '0000000000000099'), '{not-json');

  marker(world, 'go-01');
  marker(world, 'go-02');
  for (const id of ['go-03', 'go-04', 'go-05']) {
    marker(world, id, { outcome: 'delivered', route: 'native', reason: undefined });
  }
  writeFileSync(markerPathOf(world.recipient, 'broken-marker'), '{corrupt');

  stageRecord(world, 'old-01');
  stageRead(world, 'old-01');
  stageRecord(world, 'old-02');
  stageRead(world, 'old-02');
  stageRecord(world, 'fresh-01');
  stageRead(world, 'fresh-01', DUE);
  stageRecord(world, 'hold-01');
  stageRead(world, 'hold-01');
  writeFileSync(join(world.seatDir, 'hold-01.pending'), '');

  for (let i = 0; i < 100; i += 1) {
    writeFileSync(join(world.seatDir, `decoy-${String(i).padStart(4, '0')}.wake`), '');
  }
  return world;
}

function advancing(step = 20): () => number {
  let now = 0;
  return () => {
    now += step;
    return now;
  };
}

function slices(sliceMs: number, stopping: () => boolean, onYield: () => boolean): {
  sliceMs: number; stopping: () => boolean; yield: () => Promise<boolean>;
} {
  return { sliceMs, stopping, yield: async () => onYield() };
}

describe('the chores slice word', () => {
  test('the default is tens of milliseconds and the door takes 10 to 30000 whole milliseconds', () => {
    expect(DAEMON_CHORES_DEFAULTS.sliceMs).toBe(20);
    const spec = POLICY_CATALOGUE['daemon.chores-slice-ms'];
    expect(spec.defaultValue).toBe(20);
    const parse = spec.parseValue!;
    const problem = spec.valueProblem!;
    expect(parse(10)).toBe(10);
    expect(parse(20)).toBe(20);
    expect(parse(30_000)).toBe(30_000);
    expect(parse('20')).toBe(20);
    expect(parse(9)).toBeNull();
    expect(parse(30_001)).toBeNull();
    expect(parse(4.5)).toBeNull();
    expect(parse('20ms')).toBeNull();
    expect(parse(-20)).toBeNull();
    expect(problem(9)).not.toBeNull();
    expect(problem(10)).toBeNull();
  });

  test('a team policy moves the child slice to a boundary value and back', () => {
    const world = makeWorld();
    expect(choresPolicyFor(world.team, world.root, world.home, new Date(AT)).sliceMs).toBe(20);
    const wrote = writePolicySet(
      world.home,
      { level: 'team', target: world.root, teamRoot: world.root, name: 'daemon.chores-slice-ms', value: 10 },
      { now: new Date(AT) },
    );
    expect(wrote.ok).toBe(true);
    expect(choresPolicyFor(world.team, world.root, world.home, new Date(AT)).sliceMs).toBe(10);
  });
});

describe('the slice budget is checked inside a scan, not only between work items', () => {
  test('a folder of 200 decoys yields the loop several times even though the pass has no work', async () => {
    const world = makeWorld();
    for (let i = 0; i < 200; i += 1) {
      writeFileSync(join(world.seatDir, `drop-${String(i).padStart(4, '0')}.json`), '{"x":1}\n');
    }
    const before = treeOf(join(world.root, '.agents'));
    let yields = 0;
    const sliced = await sweepFallbackEscalationsSliced({
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(DUE),
      retire: { limit: 64, lockWaitMs: 0, youngMs: 1_000 },
      sliceClock: advancing(),
      slices: slices(20, () => false, () => {
        yields += 1;
        return true;
      }),
    });
    expect(yields).toBeGreaterThanOrEqual(3);
    const root = sliced.roots[0]!;
    expect(root.notes!.drained).toEqual([]);
    expect(root.report!.escalated).toEqual([]);
    expect(root.retirement!.retired).toEqual([]);
    // Nothing in the store was a candidate, so a completed pass leaves every byte as it was.
    expect(treeOf(join(world.root, '.agents'))).toEqual(before);
  });

  test('a stop requested at the second boundary lands inside the scan and leaves the store untouched', async () => {
    const world = makeWorld();
    for (let i = 0; i < 200; i += 1) {
      writeFileSync(join(world.seatDir, `drop-${String(i).padStart(4, '0')}.json`), '{"x":1}\n');
    }
    const before = treeOf(join(world.root, '.agents'));
    let yields = 0;
    const partial = await sweepFallbackEscalationsSliced({
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(DUE),
      retire: { limit: 64, lockWaitMs: 0, youngMs: 1_000 },
      sliceClock: advancing(),
      slices: slices(20, () => false, () => {
        yields += 1;
        return yields < 2;
      }),
    });
    expect(yields).toBe(2);
    expect(partial.roots).toEqual([]);
    expect(treeOf(join(world.root, '.agents'))).toEqual(before);
  });
});

describe('the sliced pass does exactly what the one-shot pass does', () => {
  test('notes, escalations, retirements and drop archiving match, down to the bytes on disk', async () => {
    const world = makeWorkWorld();
    const saved = snapshot(world);
    const retire = { limit: 64, lockWaitMs: 0, youngMs: 1_000 };
    const dropInput = { root: world.root, home: world.home, team: world.team, at: new Date(DUE), olderThanMs: 1, limit: 64 };

    const oneShot = sweepFallbackEscalations({
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(DUE),
      retire,
    });
    const dropSteps = dropRetirementSteps(dropInput);
    let dropStep = dropSteps.next();
    while (!dropStep.done) dropStep = dropSteps.next();
    const oneShotDrops = dropStep.value;
    const oneShotTree = treeOf(join(world.root, '.agents'));
    const oneShotEvents = readEvents('ll1', world.root, world.home);
    if (!oneShotEvents.ok) throw new Error(oneShotEvents.reason);

    // The work the one-shot pass judged, category by category.
    const judged = oneShot.roots[0]!;
    expect(judged.notes!.drained.map((entry) => entry.messageId).sort()).toEqual(['dn-01', 'dn-02', 'dn-03']);
    expect(judged.notes!.unreadable).toHaveLength(1);
    expect(judged.report!.escalated.map((entry) => entry.messageId).sort()).toEqual(['dn-03', 'go-01', 'go-02']);
    expect(judged.report!.unreadable).toHaveLength(1);
    expect(judged.retirement!.retired.map((entry) => entry.messageId).sort()).toEqual([
      'dn-01', 'dn-02', 'dn-03', 'go-01', 'go-02', 'go-03', 'go-04', 'go-05',
    ]);
    expect(oneShotDrops.refused).toBeNull();
    expect(oneShotDrops.archived.map((family) => family.id).sort()).toEqual(['old-01', 'old-02']);
    // The three note records carry no read/replied receipt, and the young and sidecar-held
    // families stay: five records were read and left in place.
    expect(oneShotDrops.stayed).toBe(5);
    expect(oneShotEvents.events.length).toBeGreaterThan(0);

    // The same world, byte for byte, through the sliced driver with a slice boundary after every
    // single step: the pass must be interrupted and resumed at arbitrary points and still agree.
    restore(world, saved);
    let sweepYields = 0;
    let dropYields = 0;
    const sliced = await sweepFallbackEscalationsSliced({
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(DUE),
      retire,
      sliceClock: advancing(),
      slices: slices(20, () => false, () => {
        sweepYields += 1;
        return true;
      }),
    });
    const slicedDrops = await retireDropsSliced({
      ...dropInput,
      sliceClock: advancing(),
      slices: slices(20, () => false, () => {
        dropYields += 1;
        return true;
      }),
    });
    expect(sweepYields).toBeGreaterThan(10);
    expect(dropYields).toBeGreaterThan(5);
    expect(sliced).toEqual(oneShot);
    expect(slicedDrops).toEqual(oneShotDrops);
    expect(treeOf(join(world.root, '.agents'))).toEqual(oneShotTree);
    const slicedEvents = readEvents('ll1', world.root, world.home);
    if (!slicedEvents.ok) throw new Error(slicedEvents.reason);
    expect(slicedEvents.events).toEqual(oneShotEvents.events);
  });
});
