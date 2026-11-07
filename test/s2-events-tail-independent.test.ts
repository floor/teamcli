// Independent coverage for S2: no full events-log scan per send.
//
// A sender's append answers a duplicate and the next sequence from what the retained log already
// proves — the open segment's verified lines and the sealed segments' signed indexes — and never
// treats a forged tail, a tampered line, index or seal as proof. An oversized open file from an
// older segment bound is not rotated on the sender's path; the migration pass splits and seals it
// in slices. Below the total cap a sender leaves housekeeping to the daemon; at the cap it rotates,
// prunes and declares the drop itself, so the retained bytes stay bounded with no daemon running.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvent,
  appendIndexReads,
  eventLogPath,
  readEvents,
  resetAppendIndexReads,
  retainedLogBytes,
  sealUnsealedSegmentsSteps,
  verifyEventLogSeals,
  type EventAppendResult,
} from '../src/bus/log.ts';
import type { EventKind } from '../src/bus/kinds.ts';
import { indexPathOf, sealPathOf } from '../src/bus/seal.ts';
import { appendStep } from '../src/send/steps.ts';

const PROJECT = 'acme';
const TS = '2026-10-19T12:00:00.000Z';
const DAY = 24 * 60 * 60;

type World = { root: string; home: string };
const dirs: string[] = [];
afterEach(() => {
  for (const base of dirs.splice(0)) rmSync(base, { recursive: true, force: true });
});

function world(name: string): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `team-s2-${name}-`)));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function livePath(at: World): string {
  return eventLogPath(PROJECT, at.root, at.home);
}

type AppendOptions = {
  maxBytes?: number;
  kept?: number;
  retentionSeconds?: number;
  maxTotalBytes?: number;
  retain?: boolean;
};

// Rotation at 4 KB with four slots: two rotations seal the first records into `.2`.
const RETENTION: AppendOptions = {
  maxBytes: 4_000,
  kept: 4,
  retentionSeconds: 30 * DAY,
  maxTotalBytes: 100_000_000,
};

type OkAppend = Extract<EventAppendResult, { ok: true }>;

function appendOk(
  at: World,
  id: string,
  kind: EventKind = 'message.arrived',
  over: AppendOptions & { reason?: string } = {},
): OkAppend {
  const { reason, ...options } = over;
  const result = appendEvent(
    PROJECT,
    at.root,
    at.home,
    { ts: TS, kind, session: 'acme', record_id: id, reason: reason ?? 'x'.repeat(160) },
    { ...RETENTION, ...options },
  );
  if (!result.ok) throw new Error(result.reason);
  return result;
}

/** Filler until a rotation has moved the first records into `slot`. */
function fillUntilSealed(at: World, slot: number, prefix: string): OkAppend {
  let last!: OkAppend;
  for (let n = 1; n <= 400; n += 1) {
    last = appendOk(at, `${prefix}-${String(n)}`);
    if (existsSync(`${livePath(at)}.${String(slot)}`)) return last;
  }
  throw new Error(`the fixture never sealed slot ${String(slot)}`);
}

/** Moves the open file to a fresh inode with the same bytes, so this process must build its append
 *  index afresh, as a new process would, without changing a byte of the log. */
function coldStart(at: World): void {
  const path = livePath(at);
  const content = readFileSync(path);
  rmSync(path);
  writeFileSync(path, content, { mode: 0o600 });
}

function newestSeq(at: World, kept = 4): number {
  const read = readEvents(PROJECT, at.root, at.home, { kept });
  if (!read.ok) throw new Error(read.reason);
  if (read.newestSeq === null) throw new Error('the fixture holds no verified record');
  return read.newestSeq;
}

function forgedLine(kind: EventKind, id: string, seq: number): string {
  return `${JSON.stringify({
    payload: { v: 1, seq, ts: TS, kind, session: 'acme', record_id: id },
    signature: '00'.repeat(64),
  })}\n`;
}

/** Rewrites one record's own line at the same length with a signature the key does not hold. */
function tamperLine(path: string, id: string): void {
  const lines = readFileSync(path, 'utf8').split('\n');
  const at = lines.findIndex((line) => line.includes(`"record_id":"${id}"`));
  if (at < 0) throw new Error(`no line for ${id}`);
  const line = lines[at] as string;
  const signature = (JSON.parse(line) as { signature: string }).signature;
  const flipped = `${signature[0] === '0' ? '1' : '0'}${signature.slice(1)}`;
  lines[at] = line.replace(`"signature":"${signature}"`, `"signature":"${flipped}"`);
  writeFileSync(path, lines.join('\n'));
}

/** Changes one index line's sequence digits without changing the file's length. */
function tamperIndex(path: string): void {
  const text = readFileSync(path, 'utf8');
  const replaced = text.replace(/"seq":(\d+)/, (_whole, digits: string) => `"seq":${[...digits].map((d) => String((Number(d) + 1) % 10)).join('')}`);
  if (replaced === text) throw new Error('the index held no sequence to change');
  writeFileSync(path, replaced);
}

/** Makes a seal's signature fail while its JSON still parses. */
function tamperSeal(path: string): void {
  const seal = JSON.parse(readFileSync(path, 'utf8')) as { signature: string };
  seal.signature = `${seal.signature[0] === '0' ? '1' : '0'}${seal.signature.slice(1)}`;
  writeFileSync(path, `${JSON.stringify(seal)}\n`);
}

describe('S2: a duplicate never writes, in the open tail or behind a seal', () => {
  test('the open tail: decoys and a forged occurrence do not hide the real duplicate', () => {
    const at = world('open-duplicate');

    // A verified line that merely quotes the id, then a forged line that claims the exact key.
    appendOk(at, 'coil-decoy', 'message.arrived', {
      reason: 'an earlier note quoting "record_id":"coil-open" and bare coil-open in its payload',
    });
    const real = appendOk(at, 'coil-open', 'message.delivered');
    appendFileSync(livePath(at), forgedLine('message.delivered', 'coil-open', 5000));
    for (let n = 1; n <= 6; n += 1) appendOk(at, `coil-after-${String(n)}`);

    coldStart(at);
    const before = readFileSync(livePath(at));
    resetAppendIndexReads();
    const duplicate = appendOk(at, 'coil-open', 'message.delivered');

    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.record.payload.seq).toBe(real.record.payload.seq);
    // Nothing was written for the duplicate, including no shadow of the forged line.
    expect(readFileSync(livePath(at)).equals(before)).toBe(true);
    const reads = appendIndexReads();
    expect(reads.files).toBe(1);
    expect(reads.bytes).toBeGreaterThanOrEqual(before.length);
    expect(reads.bytes).toBeLessThan(before.length + 2_048);

    // The forged line was never the newest sequence: the next append follows the verified tail.
    const tail = newestSeq(at);
    const next = appendOk(at, 'coil-open-next');
    expect(next.duplicate).toBe(false);
    expect(next.record.payload.seq).toBe(tail + 1);

    // An id that is a prefix of an earlier one is a new record, not a duplicate of it.
    appendOk(at, 'coil-a-10');
    const prefix = appendOk(at, 'coil-a-1');
    expect(prefix.duplicate).toBe(false);
    expect(prefix.record.payload.seq).toBe(newestSeq(at));
  });

  test('a sealed duplicate is answered from its own line without reading the sealed bytes', () => {
    const at = world('sealed-duplicate');
    const target = appendOk(at, 'coil-sealed', 'message.delivered');
    const lastSealed = fillUntilSealed(at, 2, 'coil-fill');
    expect(lastSealed.record.payload.seq).toBeGreaterThan(target.record.payload.seq);

    const path = livePath(at);
    const openBytes = statSync(path).size;
    const sealedBytes = statSync(`${path}.2`).size + statSync(`${path}.1`).size;
    expect(openBytes).toBeLessThan(sealedBytes);

    coldStart(at);
    resetAppendIndexReads();
    const duplicate = appendOk(at, 'coil-sealed', 'message.delivered');
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.record.payload.seq).toBe(target.record.payload.seq);
    // Only the open segment was read whole; the sealed indexes answered for the rest.
    const reads = appendIndexReads();
    expect(reads.files).toBe(1);
    expect(reads.bytes).toBeGreaterThanOrEqual(openBytes);
    expect(reads.bytes).toBeLessThan(openBytes + 2_048);
    expect(reads.bytes).toBeLessThan(sealedBytes);

    const tail = newestSeq(at);
    const next = appendOk(at, 'coil-sealed-next');
    expect(next.duplicate).toBe(false);
    expect(next.record.payload.seq).toBe(tail + 1);
  });
});

describe('S2: an oversized open file migrates in slices and its records stay duplicates', () => {
  test('a sender does not rotate it below the cap; the migration pass splits and seals it', () => {
    const at = world('migrate');
    const SEGMENT = 3_000;
    const KEPT = 6;
    // An older larger segment bound left one open file of ~10 KB with no closed segment.
    for (let n = 1; n <= 30; n += 1) {
      appendOk(at, `coil-big-${String(n)}`, 'message.arrived', { maxBytes: 1_000_000, kept: KEPT, retain: false });
    }
    const path = livePath(at);
    expect(statSync(path).size).toBeGreaterThan(SEGMENT * 3);
    expect(existsSync(`${path}.1`)).toBe(false);

    // Below the cap, a sender append neither rotates nor seals it, and answers normally.
    const duplicate = appendOk(at, 'coil-big-1', 'message.arrived', { maxBytes: SEGMENT, kept: KEPT });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.record.payload.seq).toBe(1);
    expect(existsSync(`${path}.1`)).toBe(false);
    const fresh = appendOk(at, 'coil-big-31', 'message.arrived', { maxBytes: SEGMENT, kept: KEPT });
    expect(fresh.duplicate).toBe(false);
    expect(fresh.record.payload.seq).toBe(31);
    expect(existsSync(`${path}.1`)).toBe(false);

    // The migration pass verifies and splits the oversized open file in slices, then seals each
    // piece oldest first.
    const steps = sealUnsealedSegmentsSteps(PROJECT, at.root, at.home, {
      kept: KEPT,
      segmentBytes: SEGMENT,
      sliceLines: 4,
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
    expect(sealed.length).toBeGreaterThanOrEqual(2);
    expect(statSync(path).size).toBeLessThan(SEGMENT);

    const checked = verifyEventLogSeals(PROJECT, at.root, at.home, { kept: KEPT });
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.problems).toEqual([]);
    expect(checked.segments.length).toBe(sealed.length);
    for (const segment of checked.segments) {
      expect(segment.state).toBe('sealed');
      expect(segment.seal!.bytes).toBeLessThanOrEqual(SEGMENT);
    }

    const read = readEvents(PROJECT, at.root, at.home, { kept: KEPT });
    if (!read.ok) throw new Error(read.reason);
    expect(read.events.map((event) => event.payload.seq)).toEqual(
      Array.from({ length: 31 }, (_, index) => index + 1),
    );

    // The oldest record now lives in a migrated, sealed segment: still a duplicate, answered
    // without reading that segment whole; the newest is in the open tail; the next sequence
    // follows both.
    const openBytes = statSync(path).size;
    resetAppendIndexReads();
    const migratedDuplicate = appendOk(at, 'coil-big-1', 'message.arrived', { maxBytes: SEGMENT, kept: KEPT });
    expect(migratedDuplicate.duplicate).toBe(true);
    expect(migratedDuplicate.record.payload.seq).toBe(1);
    expect(appendIndexReads().files).toBe(1);
    expect(appendIndexReads().bytes).toBeLessThan(openBytes + 2_048);

    const tailDuplicate = appendOk(at, 'coil-big-31', 'message.arrived', { maxBytes: SEGMENT, kept: KEPT });
    expect(tailDuplicate.duplicate).toBe(true);
    expect(tailDuplicate.record.payload.seq).toBe(31);
    const next = appendOk(at, 'coil-big-32', 'message.arrived', { maxBytes: SEGMENT, kept: KEPT });
    expect(next.duplicate).toBe(false);
    expect(next.record.payload.seq).toBe(32);
  });
});

describe('S2: forged tails, lines, indexes and seals fall back to the verified walk', () => {
  test('a forged tail line is not the newest sequence and is never read as an event', () => {
    const at = world('forged-tail');
    for (let n = 1; n <= 3; n += 1) appendOk(at, `coil-tail-${String(n)}`);
    appendFileSync(livePath(at), forgedLine('message.arrived', 'coil-forged', 9000));
    coldStart(at);

    const next = appendOk(at, 'coil-tail-next');
    expect(next.duplicate).toBe(false);
    expect(next.record.payload.seq).toBe(4);

    const read = readEvents(PROJECT, at.root, at.home);
    if (!read.ok) throw new Error(read.reason);
    expect(read.events.some((event) => event.payload.record_id === 'coil-forged')).toBe(false);
    expect(read.unverified).toBeGreaterThanOrEqual(1);
  });

  test('a sealed line whose signature no longer holds is not a duplicate', () => {
    const at = world('tampered-line');
    const victim = appendOk(at, 'coil-victim', 'message.delivered');
    fillUntilSealed(at, 2, 'coil-fill');
    const segment = `${livePath(at)}.2`;
    tamperLine(segment, 'coil-victim');
    // The tampered segment no longer parses into a verified record: a read after the fact reports
    // the line as unverified and never returns it, while the verified fillers above it stand.
    const damaged = readEvents(PROJECT, at.root, at.home, { kept: 4 });
    if (!damaged.ok) throw new Error(damaged.reason);
    expect(damaged.unverified).toBeGreaterThanOrEqual(1);
    expect(damaged.events.some((event) => event.payload.seq === victim.record.payload.seq)).toBe(false);
    if (damaged.newestSeq === null) throw new Error('the fixture holds no verified record');
    const before = damaged.newestSeq;

    coldStart(at);
    const written = appendOk(at, 'coil-victim', 'message.delivered');
    expect(written.duplicate).toBe(false);
    expect(written.record.payload.seq).toBe(before + 1);
    expect(written.record.payload.seq).toBeGreaterThan(victim.record.payload.seq);

    const read = readEvents(PROJECT, at.root, at.home, { kept: 4 });
    if (!read.ok) throw new Error(read.reason);
    const held = read.events.filter((event) => event.payload.record_id === 'coil-victim');
    expect(held.length).toBe(1);
    expect(held[0]!.payload.seq).toBe(before + 1);
  });

  test('a tampered index is not trusted, and the verified walk still answers the duplicate', () => {
    const at = world('tampered-index');
    const target = appendOk(at, 'coil-indexed', 'message.delivered');
    fillUntilSealed(at, 2, 'coil-fill');
    const segment = `${livePath(at)}.2`;
    tamperIndex(indexPathOf(segment));

    coldStart(at);
    const before = readFileSync(livePath(at));
    const duplicate = appendOk(at, 'coil-indexed', 'message.delivered');
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.record.payload.seq).toBe(target.record.payload.seq);
    expect(readFileSync(livePath(at)).equals(before)).toBe(true);
  });

  test('a tampered seal leaves the segment unsealed, and the read still answers the duplicate', () => {
    const at = world('tampered-seal');
    const target = appendOk(at, 'coil-sealed-record', 'message.delivered');
    fillUntilSealed(at, 2, 'coil-fill');
    tamperSeal(sealPathOf(`${livePath(at)}.2`));

    coldStart(at);
    const duplicate = appendOk(at, 'coil-sealed-record', 'message.delivered');
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.record.payload.seq).toBe(target.record.payload.seq);
  });
});

describe('S2: the total retained cap holds with no daemon running', () => {
  test('a sender below the cap never rotates; at the cap it rotates, prunes and declares the drop', () => {
    const at = world('cap');
    const SEGMENT = 1_000;
    const KEPT = 4;
    const CAP = 7_500;
    const path = livePath(at);
    const options: AppendOptions = { maxBytes: SEGMENT, kept: KEPT, maxTotalBytes: CAP, retentionSeconds: 30 * DAY };
    let seq = 0;

    const step = (id: string) => {
      const result = appendStep(
        { project: PROJECT, root: at.root, home: at.home },
        {
          ts: TS,
          kind: 'message.staged',
          session: 'acme',
          record_id: id,
          from: 'lead',
          to: 'helper',
          outcome: 'delivered',
          ms: 1,
          reason: 'x'.repeat(220),
        },
        100,
        options,
      );
      if (!result.ok) throw new Error(result.reason);
      return result;
    };
    const total = (): number => retainedLogBytes(PROJECT, at.root, at.home, { kept: KEPT });

    // Below the cap, a sender append grows the open file past 2x the segment bound and never
    // rotates: sealing, pruning and drop declarations stay with the daemon.
    while (!existsSync(path) || statSync(path).size + 600 <= CAP) {
      seq += 1;
      step(`coil-cap-${String(seq)}:staged`);
      expect(existsSync(`${path}.1`)).toBe(false);
      expect(total()).toBeLessThan(CAP);
      if (seq > 100) throw new Error('the fixture never reached the cap');
    }
    expect(statSync(path).size).toBeGreaterThan(SEGMENT * 2);

    // A duplicate at the below-cap size writes nothing and does not move the cap.
    const before = readFileSync(path);
    const replay = step(`coil-cap-${String(seq)}:staged`);
    expect(replay.duplicate).toBe(true);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(false);
    expect(total()).toBeLessThan(CAP);

    // The next appends cross the cap: even on a sender step and an open file past 2x the segment
    // bound, the append rotates the open file into a closed slot, prunes it straight over the cap
    // and declares the drop, so the retained bytes never sit above the cap.
    for (let n = 0; n < 8; n += 1) {
      seq += 1;
      step(`coil-cap-${String(seq)}:staged`);
      expect(total()).toBeLessThanOrEqual(CAP);
    }

    const read = readEvents(PROJECT, at.root, at.home, { kept: KEPT });
    if (!read.ok) throw new Error(read.reason);
    const drops = read.events.filter((event) => event.payload.kind === 'team.event-log-dropped');
    expect(drops.length).toBeGreaterThanOrEqual(1);
    expect(drops[0]!.payload.reason).toBe('size');
    expect(drops[0]!.payload.dropped_oldest_seq).toBe(1);
    expect(drops[0]!.payload.dropped_newest_seq).toBeGreaterThanOrEqual(2);
  });
});
