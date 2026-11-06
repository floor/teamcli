// Independent verification of bus event-log rotation, signed segment seals, drop declarations,
// and keep-all retention:
// 1. A tampered seal or tampered index is never trusted and the segment is read and verified in full.
// 2. A dropped segment is declared with a signed `team.event-log-dropped` record naming the verified range.
// 3. Keep-all (`0` / `'all'`) keeps every aged segment while total bytes remain under the size cap.
// 4. Rotation never rewrites a sealed byte in a closed segment or its companion index.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EVENT_DOMAIN,
  appendEvent,
  eventLogPath,
  hydrateEventLog,
  parseSignedEventLine,
  pruneEventLog,
  readEvents,
  readEventsFromCursor,
  sealUnsealedSegments,
  verifyEventLogSeals,
  verifySignedEvent,
} from '../src/bus/log.ts';
import { eventLogSettingsFor } from '../src/bus/log-settings.ts';
import { reconcilePass } from '../src/bus/reconcile.ts';
import {
  SEAL_DOMAIN,
  indexPathOf,
  keyPrintOfKey,
  sealDigestOf,
  sealPathOf,
  sealPayloadOf,
  SEAL_SUFFIX,
  type SealFields,
  type StoredSeal,
} from '../src/bus/seal.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { LOG_FILE } from '../src/state.ts';
import { messageKeyOf, messageKeyPath, signDomain, verifyDomain, type Json } from '../src/store/keys.ts';

const PROJECT = 'acme';
const NOW = new Date('2026-10-19T12:00:00.000Z');
const MAX_BYTES = 25_000;
const KEPT = 4;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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

function makeWorld(label: string): World {
  const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `bus-rot-ind-${label}-`)));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home);
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  const segPolicy = writePolicySet(
    home,
    { level: 'team', target: teamIdOf(root), teamRoot: root, name: 'event-segment-mb', value: 1 },
    { now: NOW },
  );
  if (!segPolicy.ok) throw new Error(segPolicy.why);
  return { root, home };
}

function livePath(world: World): string {
  return eventLogPath(PROJECT, world.root, world.home);
}

function appendPadded(
  world: World,
  id: string,
  options: {
    maxBytes?: number;
    kept?: number;
    maxTotalBytes?: number;
    retentionSeconds?: number;
    padBytes?: number;
  } = {},
) {
  const res = appendEvent(
    PROJECT,
    world.root,
    world.home,
    {
      ts: NOW.toISOString(),
      kind: 'message.arrived',
      session: 'acme',
      record_id: id,
      from: 'lead',
      to: 'builder',
      seat: 'lead',
      reason: 'r'.repeat(options.padBytes ?? 220),
    },
    {
      maxBytes: options.maxBytes ?? MAX_BYTES,
      kept: options.kept ?? KEPT,
      ...(options.maxTotalBytes !== undefined ? { maxTotalBytes: options.maxTotalBytes } : {}),
      ...(options.retentionSeconds !== undefined ? { retentionSeconds: options.retentionSeconds } : {}),
    },
  );
  if (!res.ok) throw new Error(res.reason);
  return res.record;
}

function appendUntilSlotExists(world: World, slot: number, prefix: string, startIdx = 1): number {
  let idx = startIdx;
  for (; idx <= startIdx + 1500; idx += 1) {
    appendPadded(world, `${prefix}-${String(idx)}`);
    if (existsSync(`${livePath(world)}.${String(slot)}`)) {
      return idx + 1;
    }
  }
  throw new Error(`segment .${String(slot)} was never created`);
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function readStoredSealJson(segmentPath: string): StoredSeal {
  return JSON.parse(readFileSync(sealPathOf(segmentPath), 'utf8')) as StoredSeal;
}

describe('bus-log rotation independent security and retention probes', () => {
  test('1a. a tampered seal is never trusted, breaks newer chained seals, cannot be re-sealed, and forces full segment verification', () => {
    const world = makeWorld('tampered-seal');
    const nextIdx = appendUntilSlotExists(world, 2, 'seg');
    appendPadded(world, `open-${String(nextIdx)}`);

    const seg2 = `${livePath(world)}.2`;
    const seg1 = `${livePath(world)}.1`;

    // Baseline: both .2 and .1 are sealed and trusted; hydration does not read sealed bytes.
    const baselineCheck = verifyEventLogSeals(PROJECT, world.root, world.home, { kept: KEPT });
    expect(baselineCheck.ok).toBe(true);
    if (!baselineCheck.ok) return;
    expect(baselineCheck.segments.map((s) => [s.name, s.state])).toEqual([
      ['events.jsonl.2', 'sealed'],
      ['events.jsonl.1', 'sealed'],
    ]);

    // Tamper with .2.seal.json (flip one hex character in the signed content digest while keeping valid JSON).
    const origSeal2 = readStoredSealJson(seg2);
    const flippedDigest = `${origSeal2.digest[0] === 'a' ? 'b' : 'a'}${origSeal2.digest.slice(1)}`;
    writeFileSync(
      sealPathOf(seg2),
      `${JSON.stringify({ ...origSeal2, digest: flippedDigest })}\n`,
    );

    // Also tamper in-place with one record inside .2 (same byte length so size matches seal.bytes)
    // to prove that full fallback verification actually checks every record signature inside .2.
    const seg2Raw = readFileSync(seg2, 'utf8');
    const seg2Lines = seg2Raw.split('\n').filter((line) => line.trim() !== '');
    expect(seg2Lines.length).toBeGreaterThan(2);
    const corruptedLine = seg2Lines[1]!.replace('"record_id":"seg-2"', '"record_id":"seg-X"');
    expect(Buffer.byteLength(corruptedLine)).toBe(Buffer.byteLength(seg2Lines[1]!));
    const tamperedSeg2Raw = [seg2Lines[0]!, corruptedLine, ...seg2Lines.slice(2)].join('\n') + '\n';
    expect(Buffer.byteLength(tamperedSeg2Raw)).toBe(Buffer.byteLength(seg2Raw));
    writeFileSync(seg2, tamperedSeg2Raw);

    // 1. Seal verification marks .2 unsealed ('bad-seal') AND .1 unsealed ('chain').
    const afterTamper = verifyEventLogSeals(PROJECT, world.root, world.home, { kept: KEPT });
    expect(afterTamper.ok).toBe(true);
    if (!afterTamper.ok) return;
    expect(afterTamper.segments.map((s) => [s.name, s.state, s.why])).toEqual([
      ['events.jsonl.2', 'unsealed', 'bad-seal'],
      ['events.jsonl.1', 'unsealed', 'chain'],
    ]);

    // 2. Migration (`sealUnsealedSegments`) refuses to re-seal a segment with a broken seal.
    expect(sealUnsealedSegments(PROJECT, world.root, world.home, { kept: KEPT })).toEqual([]);

    // 3. `hydrateEventLog` and `readEventsFromCursor` refuse the sidecar and read/verify in full,
    //    catching the in-place corrupted record in .2 (`unverified: 1`) while serving all valid records.
    const hydrated = hydrateEventLog(PROJECT, world.root, world.home, { kept: KEPT });
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    expect(hydrated.full).toBe(true);
    expect(hydrated.unsealed).toBe(2);
    expect(hydrated.sealedNewestSeq).toBeNull();
    expect(hydrated.unverified).toBe(1);
    const hydratedIds = hydrated.entries.map((e) => e.record_id);
    expect(hydratedIds).toContain('seg-1');
    expect(hydratedIds).not.toContain('seg-2');
    expect(hydratedIds).not.toContain('seg-X');
    expect(hydratedIds).toContain('seg-3');

    // Cursor read at the tail also refuses the fast sealed-tail shortcut (`unsealed > 0`) and
    // discloses `unverified: 1` from the full segment scan rather than trusting the sidecars.
    const newestSeq = hydrated.newestSeq!;
    const tailRead = readEventsFromCursor(PROJECT, world.root, world.home, newestSeq - 1, {
      kept: KEPT,
    });
    expect(tailRead.ok).toBe(true);
    if (!tailRead.ok || tailRead.kind !== 'events') return;
    expect(tailRead.unverified).toBe(1);
    expect(tailRead.events.map((e) => e.payload.record_id)).toEqual([`open-${String(nextIdx)}`]);

    // Reconcile pass also runs without trusting the broken seal (`unsealed === 2`).
    const rec = reconcilePass({
      project: PROJECT,
      root: world.root,
      session: 'acme',
      home: world.home,
      now: NOW,
    });
    expect(rec.ok).toBe(true);
    void seg1;
  });

  test('1b. a same-byte-length tampered index is never trusted on read or across rotation', () => {
    const world = makeWorld('tampered-index');
    appendUntilSlotExists(world, 1, 'idx');
    appendPadded(world, 'open-tail');

    const seg1 = `${livePath(world)}.1`;
    const idx1Path = indexPathOf(seg1);
    const origIdxText = readFileSync(idx1Path, 'utf8');

    // Same-byte-length tamper in `.1.index.jsonl`: replace `"idx-1"` with `"FORGE"` (both 5 chars).
    const tamperedIdxText = origIdxText.replace('"record_id":"idx-1"', '"record_id":"FORGE"');
    expect(tamperedIdxText).not.toBe(origIdxText);
    expect(Buffer.byteLength(tamperedIdxText)).toBe(Buffer.byteLength(origIdxText));
    writeFileSync(idx1Path, tamperedIdxText);

    // 1. Seal check flags `.1` as `unsealed` with `why: 'index'`.
    const sealCheck = verifyEventLogSeals(PROJECT, world.root, world.home, { kept: KEPT });
    expect(sealCheck.ok).toBe(true);
    if (!sealCheck.ok) return;
    expect(sealCheck.segments.map((s) => [s.name, s.state, s.why])).toEqual([
      ['events.jsonl.1', 'unsealed', 'index'],
    ]);

    // 2. Hydration ignores the forged index and reads `.1` in full, returning `'idx-1'` and never `'FORGE'`.
    const hydrated = hydrateEventLog(PROJECT, world.root, world.home, { kept: KEPT });
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    expect(hydrated.full).toBe(true);
    expect(hydrated.unsealed).toBe(1);
    const ids = hydrated.entries.map((e) => e.record_id);
    expect(ids).toContain('idx-1');
    expect(ids).not.toContain('FORGE');

    // 3. When rotation shifts `.1` -> `.2`, `moveSeal` checks `sealedSegmentAgrees` and refuses to
    //    re-sign `.1.seal.json` for `.2`, leaving `.2` unsealed ('bad-seal') and refusing to seal
    //    the newly closed `.1` ('no-seal').
    appendUntilSlotExists(world, 2, 'rot');
    const afterRotCheck = verifyEventLogSeals(PROJECT, world.root, world.home, { kept: KEPT });
    expect(afterRotCheck.ok).toBe(true);
    if (!afterRotCheck.ok) return;
    expect(afterRotCheck.segments.map((s) => [s.name, s.state, s.why])).toEqual([
      ['events.jsonl.2', 'unsealed', 'bad-seal'],
      ['events.jsonl.1', 'unsealed', 'no-seal'],
    ]);
  });

  test('2. a drop is declared with a signed team.event-log-dropped record naming the verified range and carrying the floor forward', () => {
    const world = makeWorld('drop-declared');
    // Keep 3 files total (`events.jsonl`, `.1`, `.2`) so rotating a 3rd time drops `.2`.
    const kept = 3;
    let seqCounter = 1;
    while (!existsSync(`${livePath(world)}.2`)) {
      appendPadded(world, `batch1-${String(seqCounter)}`, { kept });
      seqCounter += 1;
    }

    // Record the exact verified sequence range inside `.2` (which is about to be dropped on next rotation).
    const seg2Path = `${livePath(world)}.2`;
    const seg2Seal = readStoredSealJson(seg2Path);
    expect(seg2Seal.firstSeq).toBe(1);
    const firstDropNewestSeq = seg2Seal.lastSeq;

    // Inject an unsigned/tampered line into `.2` before it is dropped by rotation: `verifiedRangeOf`
    // must ignore unverified lines and declare only the verified sequence range `1..firstDropNewestSeq`.
    const bogusLine = JSON.stringify({
      payload: {
        v: 1,
        seq: 99999,
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'forged-in-dropped-segment',
      },
      signature: 'deadbeef',
    });
    appendFileSync(seg2Path, `${bogusLine}\n`);

    // Drive one more rotation so `.2` is dropped.
    const seg1Before = readStoredSealJson(`${livePath(world)}.1`);
    while (readStoredSealJson(`${livePath(world)}.2`).firstSeq === seg2Seal.firstSeq) {
      appendPadded(world, `batch2-${String(seqCounter)}`, { kept });
      seqCounter += 1;
    }
    const seg2AfterFirstDrop = readStoredSealJson(`${livePath(world)}.2`);
    expect(seg2AfterFirstDrop.firstSeq).toBe(seg1Before.firstSeq);

    // Read events and inspect the signed `team.event-log-dropped` declaration record.
    const read1 = readEvents(PROJECT, world.root, world.home, { kept });
    expect(read1.ok).toBe(true);
    if (!read1.ok) return;
    const drops1 = read1.events.filter((e) => e.payload.kind === 'team.event-log-dropped');
    expect(drops1.length).toBe(1);
    const dropRec1 = drops1[0]!;
    expect(verifySignedEvent(dropRec1, world.home)).toBe(true);
    expect(
      verifyDomain(
        EVENT_DOMAIN,
        dropRec1.payload as unknown as Json,
        dropRec1.signature,
        messageKeyOf(world.home),
      ),
    ).toBe(true);
    expect(dropRec1.payload.dropped_oldest_seq).toBe(1);
    expect(dropRec1.payload.dropped_newest_seq).toBe(firstDropNewestSeq);
    expect(dropRec1.payload.reason).toBe('size');
    expect(dropRec1.payload.record_id).toBe(`retention:1-${String(firstDropNewestSeq)}`);

    // A subscriber with cursor 1 sees a declared retention gap covering `2..firstDropNewestSeq`.
    const gap1 = readEventsFromCursor(PROJECT, world.root, world.home, 1, { kept });
    expect(gap1).toEqual({
      ok: true,
      kind: 'gap',
      oldest_seq: firstDropNewestSeq + 1,
      newest_seq: read1.newestSeq!,
      reason: 'retention',
      dropped_oldest_seq: 2,
      dropped_newest_seq: firstDropNewestSeq,
    });

    // Now prune by `maxTotalBytes` so the remaining `.2` (and `.1`) are dropped, and verify that
    // the new signed `team.event-log-dropped` record carries `dropped_oldest_seq: 1` forward
    // while advancing `dropped_newest_seq` to `.1`'s `lastSeq`.
    const seg1CurrentSeal = readStoredSealJson(`${livePath(world)}.1`);
    pruneEventLog(PROJECT, world.root, world.home, {
      kept,
      maxTotalBytes: 1,
      retentionSeconds: 0,
      session: 'acme',
    });
    expect(existsSync(`${livePath(world)}.2`)).toBe(false);
    expect(existsSync(`${livePath(world)}.1`)).toBe(false);

    const read2 = readEvents(PROJECT, world.root, world.home, { kept });
    expect(read2.ok).toBe(true);
    if (!read2.ok) return;
    const drops2 = read2.events.filter((e) => e.payload.kind === 'team.event-log-dropped');
    const latestDrop = drops2.at(-1)!;
    expect(verifySignedEvent(latestDrop, world.home)).toBe(true);
    expect(latestDrop.payload.dropped_oldest_seq).toBe(1);
    expect(latestDrop.payload.dropped_newest_seq).toBe(seg1CurrentSeal.lastSeq);
    expect(latestDrop.payload.reason).toBe('size');
    expect(latestDrop.payload.record_id).toBe(`retention:1-${String(seg1CurrentSeal.lastSeq)}`);

    const gap2 = readEventsFromCursor(PROJECT, world.root, world.home, 1, { kept });
    expect(gap2).toEqual({
      ok: true,
      kind: 'gap',
      oldest_seq: seg1CurrentSeal.lastSeq + 1,
      newest_seq: read2.newestSeq!,
      reason: 'retention',
      dropped_oldest_seq: 2,
      dropped_newest_seq: seg1CurrentSeal.lastSeq,
    });
  });

  test('3. keep-all (0 / all) keeps every aged segment under the size cap and drops only when the size cap is exceeded', () => {
    const world = makeWorld('keep-all');
    const policyRes = writePolicySet(
      world.home,
      {
        level: 'team',
        target: teamIdOf(world.root),
        teamRoot: world.root,
        name: 'event-retention-days',
        value: 'all',
      },
      { now: NOW },
    );
    expect(policyRes.ok).toBe(true);
    const settings = eventLogSettingsFor(world.root, world.home);
    expect(settings.retentionSeconds).toBe(0);

    // Create 2 sealed segments (`.2`, `.1`) and an open segment (`events.jsonl`).
    const nextIdx = appendUntilSlotExists(world, 2, 'keep');
    appendPadded(world, `keep-open-${String(nextIdx)}`, { retentionSeconds: 0 });

    const seg2 = `${livePath(world)}.2`;
    const seg1 = `${livePath(world)}.1`;
    const open = livePath(world);

    // Backdate `.2`, `.1`, and `events.jsonl` by 400 days (well past the default 30-day window).
    const yearAgo = new Date(Date.now() - 400 * 86_400 * 1_000);
    for (const file of [seg2, seg1, open]) {
      utimesSync(file, yearAgo, yearAgo);
    }

    // Run `pruneEventLog` using the configured keep-all policy (retentionSeconds: 0) while well under the 100 MB cap.
    pruneEventLog(PROJECT, world.root, world.home, { kept: KEPT });
    expect(existsSync(seg2)).toBe(true);
    expect(existsSync(seg1)).toBe(true);
    expect(existsSync(open)).toBe(true);

    // Append another event (also under keep-all): `sealIdleLiveFile` and `pruneSealed` must NOT age-drop anything.
    appendPadded(world, `keep-open-${String(nextIdx + 1)}`, { retentionSeconds: 0 });
    expect(existsSync(seg2)).toBe(true);
    expect(existsSync(seg1)).toBe(true);

    const readUnderCap = readEvents(PROJECT, world.root, world.home, { kept: KEPT });
    expect(readUnderCap.ok).toBe(true);
    if (!readUnderCap.ok) return;
    expect(readUnderCap.oldestSeq).toBe(1);
    expect(readUnderCap.events.filter((e) => e.payload.kind === 'team.event-log-dropped')).toEqual([]);

    // Now lower `maxTotalBytes` so `.2` pushes total bytes over the cap while `retentionSeconds` is still 0:
    // `.2` is dropped by the size cap (`reason: 'size'`), while `.1` and `events.jsonl` remain under the cap.
    const seg1Bytes = readFileSync(seg1).length;
    const openBytes = readFileSync(open).length;
    const capForSeg1AndOpen = seg1Bytes + openBytes + 2_000;
    const expectedOldestAfterCap = readStoredSealJson(seg1).firstSeq;
    const expectedDroppedNewest = readStoredSealJson(seg2).lastSeq;

    pruneEventLog(PROJECT, world.root, world.home, {
      kept: KEPT,
      retentionSeconds: 0,
      maxTotalBytes: capForSeg1AndOpen,
      session: 'acme',
    });
    expect(existsSync(seg2)).toBe(false);
    expect(existsSync(sealPathOf(seg2))).toBe(false);
    expect(existsSync(indexPathOf(seg2))).toBe(false);
    expect(existsSync(seg1)).toBe(true);

    const readOverCap = readEvents(PROJECT, world.root, world.home, { kept: KEPT });
    expect(readOverCap.ok).toBe(true);
    if (!readOverCap.ok) return;
    expect(readOverCap.oldestSeq).toBe(expectedOldestAfterCap);
    const dropEvents = readOverCap.events.filter((e) => e.payload.kind === 'team.event-log-dropped');
    expect(dropEvents.length).toBe(1);
    expect(dropEvents[0]!.payload.reason).toBe('size');
    expect(dropEvents[0]!.payload.dropped_oldest_seq).toBe(1);
    expect(dropEvents[0]!.payload.dropped_newest_seq).toBe(expectedDroppedNewest);
  });

  test('4. rotation never rewrites a sealed byte in the segment or its index across slots .1 -> .2 -> .3', () => {
    const world = makeWorld('immutable-sealed-bytes');
    let nextIdx = appendUntilSlotExists(world, 1, 'imm', 1);

    const seg1Path = `${livePath(world)}.1`;
    const seg1BytesAtSlot1 = readFileSync(seg1Path);
    const seg1DigestAtSlot1 = sha256Hex(seg1BytesAtSlot1);
    const idx1BytesAtSlot1 = readFileSync(indexPathOf(seg1Path));
    const idx1DigestAtSlot1 = sha256Hex(idx1BytesAtSlot1);
    const sealAtSlot1 = readStoredSealJson(seg1Path);

    expect(sealAtSlot1.segment).toBe('events.jsonl.1');
    expect(sealAtSlot1.bytes).toBe(seg1BytesAtSlot1.length);
    expect(sealAtSlot1.digest).toBe(seg1DigestAtSlot1);
    expect(sealAtSlot1.index.bytes).toBe(idx1BytesAtSlot1.length);
    expect(sealAtSlot1.index.digest).toBe(idx1DigestAtSlot1);
    expect(sealAtSlot1.previous).toBeNull();

    // Rotate once more so our segment moves from `.1` -> `.2`.
    nextIdx = appendUntilSlotExists(world, 2, 'imm', nextIdx);
    const seg2Path = `${livePath(world)}.2`;
    const seg2Bytes = readFileSync(seg2Path);
    const idx2Bytes = readFileSync(indexPathOf(seg2Path));
    const sealAtSlot2 = readStoredSealJson(seg2Path);

    // Every byte of the segment and its `.index.jsonl` is identical to when it was first sealed at `.1`.
    expect(Buffer.compare(seg2Bytes, seg1BytesAtSlot1)).toBe(0);
    expect(Buffer.compare(idx2Bytes, idx1BytesAtSlot1)).toBe(0);
    expect(sealAtSlot2.segment).toBe('events.jsonl.2');
    expect(sealAtSlot2.digest).toBe(sealAtSlot1.digest);
    expect(sealAtSlot2.bytes).toBe(sealAtSlot1.bytes);
    expect(sealAtSlot2.lines).toBe(sealAtSlot1.lines);
    expect(sealAtSlot2.firstSeq).toBe(sealAtSlot1.firstSeq);
    expect(sealAtSlot2.lastSeq).toBe(sealAtSlot1.lastSeq);
    expect(sealAtSlot2.sealedAt).toBe(sealAtSlot1.sealedAt);
    expect(sealAtSlot2.index).toEqual(sealAtSlot1.index);

    // Rotate a third time so the original segment moves from `.2` -> `.3`.
    appendUntilSlotExists(world, 3, 'imm', nextIdx);
    const seg3Path = `${livePath(world)}.3`;
    const seg3Bytes = readFileSync(seg3Path);
    const idx3Bytes = readFileSync(indexPathOf(seg3Path));
    const sealAtSlot3 = readStoredSealJson(seg3Path);

    expect(Buffer.compare(seg3Bytes, seg1BytesAtSlot1)).toBe(0);
    expect(Buffer.compare(idx3Bytes, idx1BytesAtSlot1)).toBe(0);
    expect(sealAtSlot3.segment).toBe('events.jsonl.3');
    expect(sealAtSlot3.digest).toBe(sealAtSlot1.digest);
    expect(sealAtSlot3.bytes).toBe(sealAtSlot1.bytes);
    expect(sealAtSlot3.lines).toBe(sealAtSlot1.lines);
    expect(sealAtSlot3.firstSeq).toBe(sealAtSlot1.firstSeq);
    expect(sealAtSlot3.lastSeq).toBe(sealAtSlot1.lastSeq);
    expect(sealAtSlot3.sealedAt).toBe(sealAtSlot1.sealedAt);
    expect(sealAtSlot3.index).toEqual(sealAtSlot1.index);

    // Every line in `.3` still parses and verifies under `EVENT_DOMAIN` byte-for-byte.
    const key = messageKeyOf(world.home);
    for (const rawLine of seg3Bytes.toString('utf8').split('\n')) {
      if (rawLine.trim() === '') continue;
      const parsed = parseSignedEventLine(rawLine);
      expect(parsed).not.toBeNull();
      expect(verifyDomain(EVENT_DOMAIN, parsed!.payload as unknown as Json, parsed!.signature, key)).toBe(true);
    }

    // Even if a byte inside `.2` is altered in-place (preserving file length), rotating `.2` -> `.3`
    // never re-hashes the segment file: the carried-forward `seal.digest` continues to pin the
    // original bytes, so comparing the file's SHA-256 against `seal.digest` (and full-read event
    // verification) catches the in-place edit.
    const seg2BeforeFlip = readFileSync(seg2Path, 'utf8');
    const flippedSeg2 = seg2BeforeFlip.replace('"from":"lead"', '"from":"XXXX"');
    expect(Buffer.byteLength(flippedSeg2)).toBe(Buffer.byteLength(seg2BeforeFlip));
    const origSeg2Seal = readStoredSealJson(seg2Path);
    writeFileSync(seg2Path, flippedSeg2);

    // Trigger one more rotation (`.2` shifts to `.3`).
    let extra = 5000;
    const prevSlot1FirstSeq = readStoredSealJson(seg1Path).firstSeq;
    while (readStoredSealJson(seg1Path).firstSeq === prevSlot1FirstSeq) {
      appendPadded(world, `extra-${String(extra)}`);
      extra += 1;
    }
    const shiftedSealAt3 = readStoredSealJson(seg3Path);
    // `moveSeal` never recomputes `seal.digest` from the segment bytes on disk: it preserves `origSeg2Seal.digest`.
    expect(shiftedSealAt3.digest).toBe(origSeg2Seal.digest);
    expect(sha256Hex(readFileSync(seg3Path))).not.toBe(shiftedSealAt3.digest);

    // And a full verified read rejects the altered line in `.3` (`unverified: 1`).
    const fullRead = readEvents(PROJECT, world.root, world.home, { kept: KEPT });
    expect(fullRead.ok).toBe(true);
    if (!fullRead.ok) return;
    expect(fullRead.unverified).toBe(1);

    // Also verify `SEAL_DOMAIN`, `keyPrintOfKey`, `sealDigestOf`, `sealPayloadOf` round-trip on the seal.
    const fields: SealFields = {
      format: shiftedSealAt3.format,
      keyPrint: shiftedSealAt3.keyPrint,
      store: shiftedSealAt3.store,
      segment: shiftedSealAt3.segment,
      firstSeq: shiftedSealAt3.firstSeq,
      lastSeq: shiftedSealAt3.lastSeq,
      lines: shiftedSealAt3.lines,
      bytes: shiftedSealAt3.bytes,
      digest: shiftedSealAt3.digest,
      previous: shiftedSealAt3.previous,
      sealedAt: shiftedSealAt3.sealedAt,
      index: shiftedSealAt3.index,
    };
    expect(fields.keyPrint).toBe(keyPrintOfKey(key));
    expect(sealDigestOf(fields)).toBe(shiftedSealAt3.sealDigest);
    expect(signDomain(SEAL_DOMAIN, sealPayloadOf(fields), key)).toBe(shiftedSealAt3.signature);
  });
});

const EARLY = { maxBytes: 800, kept: 3, retentionSeconds: 0, maxTotalBytes: 50_000_000, padBytes: 280 };

/** A live file already at the segment bound, and an oldest slot the next append's rotation removes. */
function parkOldest(world: World): { path: string; text: string; newestSeq: number } {
  let n = 1;
  while (!existsSync(`${livePath(world)}.2`)) {
    appendPadded(world, `park-${String(n)}`, EARLY);
    n += 1;
    if (n > 40) throw new Error('the oldest slot never appeared');
  }
  if (statSync(livePath(world)).size < EARLY.maxBytes) {
    appendPadded(world, `park-${String(n)}`, { ...EARLY, padBytes: 900 });
  }
  const path = `${livePath(world)}.2`;
  const text = readFileSync(path, 'utf8');
  let newestSeq = 0;
  for (const line of text.split('\n')) {
    const parsed = parseSignedEventLine(line);
    if (parsed !== null) newestSeq = Math.max(newestSeq, parsed.payload.seq);
  }
  return { path, text, newestSeq };
}

const DROP_KIND = ['team', 'event-log-dropped'].join('.');

function declaresRange(world: World, seq: number): boolean {
  const read = readEvents(PROJECT, world.root, world.home, { kept: EARLY.kept });
  if (!read.ok) return false;
  return read.events.some(
    (event) =>
      event.payload.kind === DROP_KIND &&
      (event.payload.dropped_oldest_seq ?? seq + 1) <= seq &&
      (event.payload.dropped_newest_seq ?? 0) >= seq,
  );
}

describe('a rotation declares the slot it already removed', () => {
  test('an invalid payload still declares the slot the rotation removed', () => {
    const world = makeWorld('invalid-payload');
    const oldest = parkOldest(world);
    const result = appendEvent(
      PROJECT,
      world.root,
      world.home,
      {
        ts: 'not-a-time',
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'invalid-payload',
        from: 'lead',
        to: 'builder',
        seat: 'lead',
      },
      EARLY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('the event payload is invalid');
    expect(readFileSync(oldest.path, 'utf8')).not.toBe(oldest.text);
    expect(declaresRange(world, oldest.newestSeq)).toBe(true);
  });

  test('a key that cannot sign still declares the slot the rotation removed', () => {
    const world = makeWorld('unreadable-key');
    const oldest = parkOldest(world);
    const logPath = join(world.root, '.agents', LOG_FILE);
    const before = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    writeFileSync(messageKeyPath(world.home), 'not a key\n');
    const result = appendEvent(
      PROJECT,
      world.root,
      world.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'unreadable-key',
        from: 'lead',
        to: 'builder',
        seat: 'lead',
      },
      EARLY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('the event could not be signed with the message key');
    expect(readFileSync(oldest.path, 'utf8')).not.toBe(oldest.text);
    const added = readFileSync(logPath, 'utf8').slice(before.length);
    expect(added).toContain('retention dropped events.jsonl.2');
  });

  test('a throw after the unlink still declares the slot the rotation removed', () => {
    const world = makeWorld('rotation-throw');
    const oldest = parkOldest(world);
    const seal = `${oldest.path}${SEAL_SUFFIX}`;
    rmSync(seal);
    mkdirSync(seal);
    const result = appendEvent(
      PROJECT,
      world.root,
      world.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'rotation-throw',
        from: 'lead',
        to: 'builder',
        seat: 'lead',
        reason: 'r'.repeat(280),
      },
      EARLY,
    );
    expect(result.ok).toBe(false);
    expect(readFileSync(oldest.path, 'utf8')).not.toBe(oldest.text);
    expect(declaresRange(world, oldest.newestSeq)).toBe(true);
  });

  test('an idle live file still declares the slot a failed rotation removed', () => {
    const world = makeWorld('idle-age');
    const oldest = parkOldest(world);
    const seal = `${oldest.path}${SEAL_SUFFIX}`;
    rmSync(seal);
    mkdirSync(seal);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(livePath(world), past, past);
    pruneEventLog(PROJECT, world.root, world.home, {
      kept: EARLY.kept,
      retentionSeconds: 60,
      maxTotalBytes: EARLY.maxTotalBytes,
    });
    expect(declaresRange(world, oldest.newestSeq)).toBe(true);
  });

  test('an unreadable oldest slot still appends a signed drop', () => {
    const world = makeWorld('unreadable-range');
    const oldest = parkOldest(world);
    writeFileSync(oldest.path, 'not a signed segment\n');
    const logPath = join(world.root, '.agents', LOG_FILE);
    const before = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const result = appendEvent(
      PROJECT,
      world.root,
      world.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'unreadable-range',
        from: 'lead',
        to: 'builder',
        seat: 'lead',
        reason: 'r'.repeat(280),
      },
      EARLY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const added = readFileSync(logPath, 'utf8').slice(before.length);
    expect(added).toContain('retention dropped events.jsonl.2');
    const read = readEvents(PROJECT, world.root, world.home, { kept: EARLY.kept });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const drop = read.events.find(
      (event) => event.payload.kind === DROP_KIND && event.payload.dropped_oldest_seq === undefined,
    );
    expect(drop).toBeDefined();
  });
});
