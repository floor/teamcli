// Migration: a store written before seals existed has its segments verified in full once and then
// sealed oldest first, each seal naming the one before it. A segment whose lines do not all verify
// is never sealed and blocks every newer seal; a segment whose seal exists but does not hold is
// never re-sealed, because a re-sign would launder exactly what the failed check refuses.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvent,
  eventLogPath,
  readEvents,
  retainedLogBytes,
  sealUnsealedSegments,
  sealUnsealedSegmentsSteps,
  verifyEventLogSeals,
} from '../src/bus/log.ts';
import { createReconcileState, reconcilePass } from '../src/bus/reconcile.ts';
import { indexPathOf, sealPathOf } from '../src/bus/seal.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { appendStep } from '../src/send/steps.ts';

const PROJECT = 'acme';
const NOW = new Date('2026-10-19T12:00:00.000Z');
const MAX_BYTES = 50_000;
const KEPT = 4;

const dirs: string[] = [];

afterEach(() => {
  for (const base of dirs.splice(0)) rmSync(base, { recursive: true, force: true });
});

const TEAM_YAML = `format: 1
project: acme
entity: floor
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    leads: true
`;

type World = { root: string; home: string };

function makeWorld(name: string): World {
  const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `bus-seal-migrate-${name}-`)));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home);
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  const written = writePolicySet(
    home,
    { level: 'team', target: teamIdOf(root), teamRoot: root, name: 'event-segment-mb', value: 1 },
    { now: NOW },
  );
  if (!written.ok) throw new Error(written.why);
  return { root, home };
}

function livePath(world: World): string {
  return eventLogPath(PROJECT, world.root, world.home);
}

function appendPadded(world: World, id: string): void {
  const appended = appendEvent(PROJECT, world.root, world.home, {
    ts: NOW.toISOString(),
    kind: 'message.arrived',
    session: 'acme',
    record_id: id,
    reason: 'x'.repeat(200),
  }, { maxBytes: MAX_BYTES, kept: KEPT });
  if (!appended.ok) throw new Error(appended.reason);
}

function appendUntilSealed(world: World, slots: number, prefix: string): void {
  for (let index = 1; index <= 900; index += 1) {
    appendPadded(world, `${prefix}-${String(index)}`);
    if (existsSync(`${livePath(world)}.${String(slots)}`)) return;
  }
  throw new Error(`the fixture never sealed ${String(slots)} segment(s)`);
}

function stripSidecars(world: World, slots: number): void {
  for (let n = 1; n <= slots; n += 1) {
    rmSync(sealPathOf(`${livePath(world)}.${String(n)}`), { force: true });
    rmSync(indexPathOf(`${livePath(world)}.${String(n)}`), { force: true });
  }
}

function migrate(world: World): string[] {
  return sealUnsealedSegments(PROJECT, world.root, world.home, { kept: KEPT });
}

describe('migration of an older store', () => {
  test('a store with no seals is verified once and sealed oldest first, each naming the one before', () => {
    const world = makeWorld('plain');
    appendUntilSealed(world, 3, 'r');
    stripSidecars(world, 3);

    expect(migrate(world)).toEqual(['events.jsonl.3', 'events.jsonl.2', 'events.jsonl.1']);
    const seals = [3, 2, 1].map((slot) => {
      const text = readFileSync(sealPathOf(`${livePath(world)}.${String(slot)}`), 'utf8');
      return JSON.parse(text) as { segment: string; previous: string | null; sealDigest: string };
    });
    expect(seals.map((seal) => seal.segment)).toEqual(['events.jsonl.3', 'events.jsonl.2', 'events.jsonl.1']);
    expect(seals[0]!.previous).toBeNull();
    expect(seals[1]!.previous).toBe(seals[0]!.sealDigest);
    expect(seals[2]!.previous).toBe(seals[1]!.sealDigest);
    for (const slot of [3, 2, 1]) {
      expect(existsSync(indexPathOf(`${livePath(world)}.${String(slot)}`))).toBe(true);
    }

    const checked = verifyEventLogSeals(PROJECT, world.root, world.home, { kept: KEPT });
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.problems).toEqual([]);
    expect(checked.segments.map((segment) => segment.state)).toEqual(['sealed', 'sealed', 'sealed']);
  });

  test('a segment whose lines do not all verify is not sealed and blocks every newer seal', () => {
    const world = makeWorld('bad-line');
    appendUntilSealed(world, 3, 'r');
    stripSidecars(world, 3);
    appendFileSync(`${livePath(world)}.2`, 'not a signed record\n');

    expect(migrate(world)).toEqual(['events.jsonl.3']);
    expect(existsSync(sealPathOf(`${livePath(world)}.2`))).toBe(false);
    expect(existsSync(sealPathOf(`${livePath(world)}.1`))).toBe(false);

    const checked = verifyEventLogSeals(PROJECT, world.root, world.home, { kept: KEPT });
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.segments.map((segment) => [segment.name, segment.state, segment.why])).toEqual([
      ['events.jsonl.3', 'sealed', undefined],
      ['events.jsonl.2', 'unsealed', 'no-seal'],
      ['events.jsonl.1', 'unsealed', 'no-seal'],
    ]);
  });

  test('a second pass seals nothing and rewrites nothing', () => {
    const world = makeWorld('idempotent');
    appendUntilSealed(world, 2, 'r');
    stripSidecars(world, 2);
    expect(migrate(world)).toEqual(['events.jsonl.2', 'events.jsonl.1']);
    const before = [1, 2].map((slot) => {
      const at = sealPathOf(`${livePath(world)}.${String(slot)}`);
      return { text: readFileSync(at, 'utf8'), mtimeMs: statSync(at).mtimeMs };
    });

    expect(migrate(world)).toEqual([]);
    const after = [1, 2].map((slot) => {
      const at = sealPathOf(`${livePath(world)}.${String(slot)}`);
      return { text: readFileSync(at, 'utf8'), mtimeMs: statSync(at).mtimeMs };
    });
    expect(after).toEqual(before);
    // A store whose segments already carry seals is not touched at all.
    expect(migrate(world)).toEqual([]);
  });

  test('a segment whose seal exists but no longer holds is never re-sealed', () => {
    const world = makeWorld('bad-seal');
    appendUntilSealed(world, 1, 'r');
    const segment = `${livePath(world)}.1`;
    writeFileSync(segment, `${readFileSync(segment, 'utf8')} `);

    expect(migrate(world)).toEqual([]);
    const checked = verifyEventLogSeals(PROJECT, world.root, world.home, { kept: KEPT });
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.segments[0]!.state).toBe('unsealed');
    expect(checked.segments[0]!.why).toBe('size');
  });

  test('the pass gives the event loop a turn while it verifies a segment', () => {
    const world = makeWorld('sliced');
    appendUntilSealed(world, 2, 'r');
    stripSidecars(world, 2);

    const steps = sealUnsealedSegmentsSteps(PROJECT, world.root, world.home, {
      kept: KEPT,
      sliceLines: 2,
    });
    let turns = 0;
    const sealed = (() => {
      for (;;) {
        const next = steps.next();
        if (next.done) return next.value;
        turns += 1;
      }
    })();
    expect(sealed).toEqual(['events.jsonl.2', 'events.jsonl.1']);
    expect(turns).toBeGreaterThan(0);
  });

  test('the reconcile pass runs the migration after its first verified read, once', () => {
    const world = makeWorld('reconcile');
    appendUntilSealed(world, 2, 'r');
    stripSidecars(world, 2);
    const state = createReconcileState();

    const first = reconcilePass({
      project: PROJECT,
      root: world.root,
      session: 'acme',
      home: world.home,
      now: NOW,
      state,
    });
    expect(first.ok).toBe(true);
    expect(state.sealAttempted).toBe(true);
    for (const slot of [2, 1]) {
      expect(existsSync(sealPathOf(`${livePath(world)}.${String(slot)}`))).toBe(true);
    }
    const before = statSync(sealPathOf(`${livePath(world)}.1`)).mtimeMs;

    const second = reconcilePass({
      project: PROJECT,
      root: world.root,
      session: 'acme',
      home: world.home,
      now: NOW,
      state,
    });
    expect(second.ok).toBe(true);
    expect(statSync(sealPathOf(`${livePath(world)}.1`)).mtimeMs).toBe(before);
    const checked = verifyEventLogSeals(PROJECT, world.root, world.home, { kept: KEPT });
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.segments.map((segment) => segment.state)).toEqual(['sealed', 'sealed']);
  });

  test('a settled seal attempt stays settled when a later read still sees an unsealed segment', () => {
    const world = makeWorld('pending-settled');
    appendUntilSealed(world, 1, 'r');
    stripSidecars(world, 1);
    appendFileSync(`${livePath(world)}.1`, 'not a signed record\n');
    const state = createReconcileState();
    const pass = {
      project: PROJECT,
      root: world.root,
      session: 'acme',
      home: world.home,
      now: NOW,
      state,
    };
    const first = reconcilePass(pass);
    expect(first.ok).toBe(true);
    expect(state.sealAttempted).toBe(true);
    expect(state.sealPending).toBe(false);
    utimesSync(`${livePath(world)}.1`, new Date(), new Date());
    const second = reconcilePass(pass);
    expect(second.ok).toBe(true);
    expect(state.sealAttempted).toBe(true);
    expect(state.sealPending).toBe(false);
  });

  test('an oversized pre-migration open events.jsonl is not rotated by a sender append, and is split into sealed segments by the migration pass', () => {
    const world = makeWorld('oversize-open');
    const segmentBytes = 4_000;
    const kept = 6;
    // Seed a single open `events.jsonl` of ~14 KB (> 3 * segmentBytes) without rotating, as a
    // store written under an older larger segment bound holds.
    for (let i = 1; i <= 40; i += 1) {
      const res = appendEvent(
        PROJECT,
        world.root,
        world.home,
        {
          ts: NOW.toISOString(),
          kind: 'message.arrived',
          session: 'acme',
          record_id: `big-${String(i)}`,
          reason: 'x'.repeat(200),
        },
        { maxBytes: 1_000_000, kept, retain: false },
      );
      expect(res.ok).toBe(true);
    }

    const openPath = livePath(world);
    expect(statSync(openPath).size).toBeGreaterThan(segmentBytes * 3);
    expect(existsSync(`${openPath}.1`)).toBe(false);

    // 1. A sender's `appendStep` (and a cold `appendEvent` under the smaller `segmentBytes`) must
    //    NOT rotate or seal the oversized open file under `locks/events`; it stays correct by
    //    reading the open file, refusing duplicates across it, and minting the next sequence.
    appendStep(
      { project: PROJECT, root: world.root, home: world.home },
      {
        ts: NOW.toISOString(),
        kind: 'message.staged',
        session: 'acme',
        record_id: 'msg-step-1:staged',
        from: 'lead',
        to: 'helper',
        outcome: 'delivered',
        ms: 1,
      },
    );
    expect(existsSync(`${openPath}.1`)).toBe(false);

    const dupInBigOpen = appendEvent(
      PROJECT,
      world.root,
      world.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'big-1',
        reason: 'x'.repeat(200),
      },
      { maxBytes: segmentBytes, kept },
    );
    expect(dupInBigOpen.ok).toBe(true);
    if (!dupInBigOpen.ok) return;
    expect(dupInBigOpen.duplicate).toBe(true);
    expect(dupInBigOpen.record.payload.seq).toBe(1);
    expect(existsSync(`${openPath}.1`)).toBe(false);

    const freshBeforeSplit = appendEvent(
      PROJECT,
      world.root,
      world.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'big-42',
        reason: 'x'.repeat(200),
      },
      { maxBytes: segmentBytes, kept },
    );
    expect(freshBeforeSplit.ok).toBe(true);
    if (!freshBeforeSplit.ok) return;
    expect(freshBeforeSplit.duplicate).toBe(false);
    expect(freshBeforeSplit.record.payload.seq).toBe(42);
    expect(existsSync(`${openPath}.1`)).toBe(false);

    // 2. The sliced migration pass splits and seals the oversized open file into `<= segmentBytes`
    //    sealed segments, leaving `< segmentBytes` in the open `events.jsonl`.
    const steps = sealUnsealedSegmentsSteps(PROJECT, world.root, world.home, {
      kept,
      segmentBytes,
      sliceLines: 5,
    });
    let turns = 0;
    const sealed = (() => {
      for (;;) {
        const next = steps.next();
        if (next.done) return next.value;
        turns += 1;
      }
    })();
    expect(turns).toBeGreaterThan(0);
    expect(sealed.length).toBeGreaterThanOrEqual(3);
    expect(statSync(openPath).size).toBeLessThan(segmentBytes);

    const checked = verifyEventLogSeals(PROJECT, world.root, world.home, { kept });
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.problems).toEqual([]);
    expect(checked.segments.length).toBe(sealed.length);
    for (const seg of checked.segments) {
      expect(seg.state).toBe('sealed');
      expect(seg.seal!.bytes).toBeLessThanOrEqual(segmentBytes);
    }

    // 3. All 42 records remain intact in sequence order, duplicates in the newly sealed segments
    //    and in the open tail are refused, and the next sequence is 43.
    const allRead = readEvents(PROJECT, world.root, world.home, { kept });
    expect(allRead.ok).toBe(true);
    if (!allRead.ok) return;
    expect(allRead.events.map((e) => e.payload.seq)).toEqual(
      Array.from({ length: 42 }, (_, idx) => idx + 1),
    );

    const dupInSealed = appendEvent(
      PROJECT,
      world.root,
      world.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'big-1',
        reason: 'x'.repeat(200),
      },
      { maxBytes: segmentBytes, kept },
    );
    expect(dupInSealed.ok).toBe(true);
    if (!dupInSealed.ok) return;
    expect(dupInSealed.duplicate).toBe(true);
    expect(dupInSealed.record.payload.seq).toBe(1);

    const dupInOpenTail = appendEvent(
      PROJECT,
      world.root,
      world.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'big-42',
        reason: 'x'.repeat(200),
      },
      { maxBytes: segmentBytes, kept },
    );
    expect(dupInOpenTail.ok).toBe(true);
    if (!dupInOpenTail.ok) return;
    expect(dupInOpenTail.duplicate).toBe(true);
    expect(dupInOpenTail.record.payload.seq).toBe(42);

    const nextAfterSplit = appendEvent(
      PROJECT,
      world.root,
      world.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'big-43',
        reason: 'x'.repeat(200),
      },
      { maxBytes: segmentBytes, kept },
    );
    expect(nextAfterSplit.ok).toBe(true);
    if (!nextAfterSplit.ok) return;
    expect(nextAfterSplit.duplicate).toBe(false);
    expect(nextAfterSplit.record.payload.seq).toBe(43);
  });

  test('with no daemon passes, when retained bytes reach the cap the next append rotates, prunes, and declares the drop while staying within the cap', () => {
    const world = makeWorld('cap-no-daemon');
    const segmentBytes = 1_000;
    const maxTotalBytes = 8_000;
    const kept = 4;
    const openPath = livePath(world);

    let seq = 0;
    const sendStep = (): void => {
      seq += 1;
      const res = appendStep(
        { project: PROJECT, root: world.root, home: world.home },
        {
          ts: NOW.toISOString(),
          kind: 'message.staged',
          session: 'acme',
          record_id: `daemon-down-${String(seq)}:staged`,
          from: 'lead',
          to: 'helper',
          outcome: 'delivered',
          ms: 1,
        },
        100,
        { maxBytes: segmentBytes, kept, maxTotalBytes },
      );
      expect(res.ok).toBe(true);
    };

    // Push the open file past the segment bound (and past 2x segmentBytes) right up to `maxTotalBytes`
    // without crossing it: below the cap, sender appends never rotate.
    while (!existsSync(openPath) || statSync(openPath).size + 350 <= maxTotalBytes) {
      sendStep();
      expect(existsSync(`${openPath}.1`)).toBe(false);
    }
    expect(statSync(openPath).size).toBeGreaterThan(segmentBytes * 6);
    expect(statSync(openPath).size).toBeLessThanOrEqual(maxTotalBytes);

    // The next append crosses `maxTotalBytes`: even on a sender step and on a file past 2x
    // `segmentBytes`, it rotates, prunes the closed segment over the cap, and declares the drop.
    const seqBeforeCap = seq;
    while (seq < seqBeforeCap + 5) {
      sendStep();
      expect(retainedLogBytes(PROJECT, world.root, world.home, { kept })).toBeLessThanOrEqual(maxTotalBytes);
    }

    const read = readEvents(PROJECT, world.root, world.home, { kept });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const drops = read.events.filter((e) => e.payload.kind === 'team.event-log-dropped');
    expect(drops.length).toBeGreaterThanOrEqual(1);
    expect(drops[0]!.payload.dropped_oldest_seq).toBe(1);
    expect(drops[0]!.payload.dropped_newest_seq).toBeGreaterThanOrEqual(seqBeforeCap);
    expect(drops[0]!.payload.reason).toBe('size');
  });

  test('below the total cap, a file only over the segment bound is not rotated by a sender append', () => {
    const world = makeWorld('below-cap-no-rotate');
    const segmentBytes = 1_000;
    const maxTotalBytes = 20_000;
    const kept = 4;
    const openPath = livePath(world);

    for (let i = 1; i <= 15; i += 1) {
      const res = appendStep(
        { project: PROJECT, root: world.root, home: world.home },
        {
          ts: NOW.toISOString(),
          kind: 'message.staged',
          session: 'acme',
          record_id: `below-cap-${String(i)}:staged`,
          from: 'lead',
          to: 'helper',
          outcome: 'delivered',
          ms: 1,
        },
        100,
        { maxBytes: segmentBytes, kept, maxTotalBytes },
      );
      expect(res.ok).toBe(true);
    }

    expect(statSync(openPath).size).toBeGreaterThan(segmentBytes * 3);
    expect(retainedLogBytes(PROJECT, world.root, world.home, { kept })).toBeLessThan(maxTotalBytes);
    expect(existsSync(`${openPath}.1`)).toBe(false);
  });
});
