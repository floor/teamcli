// Sealed segments: a rotation closes the live segment and writes it a signed seal and the
// per-record index the seal vouches for. The scenes pin what the seal signs (range, line count,
// byte count, digest, predecessor, the segment file's own mtime), that a later rotation carries
// the sidecars with its segment and chains the seals, and that a segment this build cannot
// verify — a malformed line, a predecessor with no seal — is left unsealed rather than trusted.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, EVENT_DOMAIN, eventLogPath } from '../src/bus/log.ts';
import {
  buildSegmentIndex,
  indexPathOf,
  keyPrintOfKey,
  readSeal,
  sealDigestOf,
  sealPayloadOf,
  SEAL_DOMAIN,
  type StoredSeal,
} from '../src/bus/seal.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { messageKeyOf, messageKeyState, signDomain, verifyDomain, type Json } from '../src/store/keys.ts';
import { storePath } from '../src/store/store.ts';

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
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

type World = { root: string; home: string; teamId: string };

function makeWorld(name: string): World {
  const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `bus-seal-${name}-`)));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home);
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  const teamId = teamIdOf(root);
  const written = writePolicySet(
    home,
    { level: 'team', target: teamId, teamRoot: root, name: 'event-segment-mb', value: 1 },
    { now: NOW },
  );
  if (!written.ok) throw new Error(written.why);
  return { root, home, teamId };
}

function appendPadded(world: World, id: string, bytes = 200): void {
  const appended = appendEvent(PROJECT, world.root, world.home, {
    ts: NOW.toISOString(),
    kind: 'message.arrived',
    session: 'acme',
    record_id: id,
    reason: 'x'.repeat(bytes),
  }, { maxBytes: MAX_BYTES, kept: KEPT });
  if (!appended.ok) throw new Error(appended.reason);
}

/** Appends until the store holds `slots` sealed segments (`.1` counts), or fails the scene. */
function appendUntilSealed(world: World, slots: number, prefix: string): void {
  for (let index = 1; index <= 600; index += 1) {
    appendPadded(world, `${prefix}-${String(index)}`);
    if (existsSync(`${eventLogPath(PROJECT, world.root, world.home)}.${String(slots)}`)) return;
  }
  throw new Error(`the fixture never sealed ${String(slots)} segment(s)`);
}

function livePath(world: World): string {
  return eventLogPath(PROJECT, world.root, world.home);
}

function sealOf(world: World, slot: number): StoredSeal | null {
  const segmentPath = `${livePath(world)}.${String(slot)}`;
  const state = messageKeyState(world.home);
  if (state.kind !== 'key') throw new Error('the fixture has no message key');
  return readSeal(
    segmentPath,
    `events.jsonl.${String(slot)}`,
    storePath(PROJECT, world.root, world.home),
    keyPrintOfKey(state.key),
    state.key,
  );
}

/** The record lines of one sealed segment, parsed as they stand on disk. */
function linesOf(world: World, slot: number): { seq: number; kind: string; record_id: string; text: string }[] {
  const text = readFileSync(`${livePath(world)}.${String(slot)}`, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const parsed = JSON.parse(line) as { payload: { seq: number; kind: string; record_id: string } };
      return { seq: parsed.payload.seq, kind: parsed.payload.kind, record_id: parsed.payload.record_id, text: line };
    });
}

describe('a rotation seals the segment it closes', () => {
  test('the seal names the segment, its range and its bytes, and verifies under the message key', () => {
    const world = makeWorld('seal-fields');
    appendUntilSealed(world, 1, 'r');
    const segmentPath = `${livePath(world)}.1`;
    const segment = linesOf(world, 1);
    expect(segment.length).toBeGreaterThan(0);

    const seal = sealOf(world, 1);
    expect(seal).not.toBeNull();
    if (seal === null) return;
    expect(seal.format).toBe('teamcli bus segment-seal v1');
    expect(seal.store).toBe(storePath(PROJECT, world.root, world.home));
    expect(seal.segment).toBe('events.jsonl.1');
    expect(seal.firstSeq).toBe(segment[0]!.seq);
    expect(seal.lastSeq).toBe(segment[segment.length - 1]!.seq);
    expect(seal.lines).toBe(segment.length);
    expect(seal.bytes).toBe(statSync(segmentPath).size);
    expect(seal.digest).toBe(createHash('sha256').update(readFileSync(segmentPath)).digest('hex'));
    expect(seal.previous).toBeNull();
    // The segment's own last-write time, never the writer's clock, truncated to the millisecond
    // the signed canonical form can spell.
    expect(seal.sealedAt).toBe(Math.floor(statSync(segmentPath).mtimeMs));
    expect(seal.sealDigest).toBe(sealDigestOf(seal));

    // The signature covers every field, in this domain and no other.
    const key = messageKeyOf(world.home);
    expect(verifyDomain(SEAL_DOMAIN, sealPayloadOf(seal), seal.signature, key)).toBe(true);
    expect(verifyDomain(EVENT_DOMAIN, sealPayloadOf(seal), seal.signature, key)).toBe(false);
  });

  test('the companion index is one line per record at its byte offset, and the seal signs its triple', () => {
    const world = makeWorld('seal-index');
    appendUntilSealed(world, 1, 'r');
    const seal = sealOf(world, 1);
    if (seal === null) throw new Error('the rotation wrote no seal');
    const indexPath = indexPathOf(`${livePath(world)}.1`);
    const bytes = readFileSync(indexPath);
    expect(seal.index.bytes).toBe(bytes.length);
    expect(seal.index.digest).toBe(createHash('sha256').update(bytes).digest('hex'));

    const segmentBytes = readFileSync(`${livePath(world)}.1`);
    const rows = bytes.toString('utf8').split('\n').filter((line) => line.trim() !== '');
    expect(rows).toHaveLength(seal.lines);
    expect(seal.index.lines).toBe(rows.length);
    let lastOffset = -1;
    for (const row of rows) {
      const entry = JSON.parse(row) as { seq: number; offset: number; kind: string; record_id: string; session: string };
      expect(entry.offset).toBeGreaterThan(lastOffset);
      lastOffset = entry.offset;
      const line = segmentBytes.subarray(entry.offset, segmentBytes.indexOf(0x0a, entry.offset)).toString('utf8');
      const parsed = JSON.parse(line) as { payload: { seq: number; kind: string; record_id: string; session: string } };
      expect(entry.seq).toBe(parsed.payload.seq);
      expect(entry.kind).toBe(parsed.payload.kind);
      expect(entry.record_id).toBe(parsed.payload.record_id);
      expect(entry.session).toBe(parsed.payload.session);
    }
  });

  test('a second rotation shifts the sidecars with its segment and chains the seals', () => {
    const world = makeWorld('seal-chain');
    appendUntilSealed(world, 2, 'r');
    const older = sealOf(world, 2);
    const newer = sealOf(world, 1);
    expect(older).not.toBeNull();
    expect(newer).not.toBeNull();
    if (older === null || newer === null) return;
    expect(older.segment).toBe('events.jsonl.2');
    expect(newer.segment).toBe('events.jsonl.1');
    expect(newer.previous).toBe(older.sealDigest);
    // The sidecars moved with the segment, not left behind at the slot it used to hold.
    expect(existsSync(`${livePath(world)}.2.seal.json`)).toBe(true);
    expect(existsSync(`${livePath(world)}.1.index.jsonl`)).toBe(true);
  });

  test('a segment without a seal blocks the next seal, leaving both unsealed', () => {
    const world = makeWorld('seal-blocked');
    appendUntilSealed(world, 1, 'r');
    rmSync(`${livePath(world)}.1.seal.json`, { force: true });
    rmSync(`${livePath(world)}.1.index.jsonl`, { force: true });
    appendUntilSealed(world, 2, 's');
    // The segment that moved to .2 has no seal, so the new .1 is not sealed either.
    expect(existsSync(`${livePath(world)}.2.seal.json`)).toBe(false);
    expect(existsSync(`${livePath(world)}.1.seal.json`)).toBe(false);
  });

  test('a malformed line in the closed segment leaves it unsealed', () => {
    const world = makeWorld('seal-malformed');
    appendPadded(world, 'r-0');
    appendFileSync(livePath(world), 'this is not an event line\n');
    appendUntilSealed(world, 1, 'r');
    expect(existsSync(`${livePath(world)}.1.seal.json`)).toBe(false);
    expect(existsSync(`${livePath(world)}.1.index.jsonl`)).toBe(false);
  });

  test('a seal naming another segment or store is a miss, even under the real key', () => {
    const world = makeWorld('seal-foreign');
    appendUntilSealed(world, 1, 'r');
    const seal = sealOf(world, 1);
    if (seal === null) throw new Error('the rotation wrote no seal');
    const key = messageKeyOf(world.home);
    const fields = { ...seal, segment: 'events.jsonl.9' };
    const signature = signDomain(SEAL_DOMAIN, sealPayloadOf(fields), key);
    writeFileSync(`${livePath(world)}.1.seal.json`, `${JSON.stringify({ ...fields, signature })}\n`);
    expect(sealOf(world, 1)).toBeNull();
  });

  test('a shift re-signs a segment only while its seal, size and index still agree', () => {
    // A sealing act must only sign what it has verified: a shift that re-signed a tampered
    // segment would turn stale evidence into a fresh signature at the new slot.
    const sized = makeWorld('resign-size');
    appendUntilSealed(sized, 1, 'r');
    appendFileSync(`${livePath(sized)}.1`, 'x');
    appendUntilSealed(sized, 2, 's');
    expect(sealOf(sized, 2)).toBeNull();
    expect(sealOf(sized, 1)).toBeNull();

    const indexed = makeWorld('resign-index');
    appendUntilSealed(indexed, 1, 'r');
    const indexPath = indexPathOf(`${livePath(indexed)}.1`);
    const text = readFileSync(indexPath, 'utf8');
    expect(text).toContain('message.arrived');
    // One letter changed inside the same byte count: only the signed digest catches this.
    writeFileSync(indexPath, text.replace('message.arrived', 'message.arrivex'));
    appendUntilSealed(indexed, 2, 's');
    expect(sealOf(indexed, 2)).toBeNull();
    expect(sealOf(indexed, 1)).toBeNull();
  });

  test('a same-size edit survives the shift only as far as its carried digest, never past a read', () => {
    const world = makeWorld('resign-same-size');
    appendUntilSealed(world, 1, 'r');
    const segmentPath = `${livePath(world)}.1`;
    const bytes = readFileSync(segmentPath);
    const reasonAt = bytes.indexOf('"reason":"');
    expect(reasonAt).toBeGreaterThanOrEqual(0);
    bytes[reasonAt + '"reason":"'.length] = 'y'.charCodeAt(0);
    writeFileSync(segmentPath, bytes);

    const before = sealOf(world, 1);
    if (before === null) throw new Error('the first rotation wrote no seal');
    appendUntilSealed(world, 2, 's');
    const after = sealOf(world, 2);
    expect(after).not.toBeNull();
    if (after === null) return;
    // The re-sign names its new slot and carries the old signed claim forward; recomputing the
    // digest from the current bytes would launder this edit into a fresh promise.
    expect(after.digest).toBe(before.digest);
    expect(after.lines).toBe(before.lines);
    expect(after.bytes).toBe(before.bytes);
    expect(after.firstSeq).toBe(before.firstSeq);
    expect(after.lastSeq).toBe(before.lastSeq);
    // The next whole-segment read compares these bytes with the carried digest and sees the edit.
    expect(createHash('sha256').update(readFileSync(`${livePath(world)}.2`)).digest('hex')).not.toBe(after.digest);
  });

  test('the index builder refuses a segment with a line it cannot spell', () => {
    const good = Buffer.from(`${JSON.stringify({
      payload: { v: 1, seq: 1, ts: NOW.toISOString(), kind: 'message.arrived', session: 'acme', record_id: 'r-1' },
      signature: '00',
    })}\n`, 'utf8');
    const built = buildSegmentIndex(good);
    expect(built).not.toBeNull();
    if (built === null) return;
    expect(built.entries).toHaveLength(1);
    expect(built.entries[0]!.offset).toBe(0);
    expect(buildSegmentIndex(Buffer.from(`${good.toString('utf8')}{"nope":1}\n`))).toBeNull();
  });
});
