// The append index hydrates from the sealed segments' signed indexes: the id map and the newest
// sequence come from the indexes, so a fresh process appends to a log whose sealed segments
// cannot even be read, and reads only the open segment's bytes and the appended record's own
// candidate line. A duplicate that lives in a sealed segment is answered from that one line; a
// segment without a trusted seal is read whole, exactly as before; and an index that names a
// record whose own line no longer verifies sends the cold build through the ordinary verified
// walk, so a forged payload is never returned as a duplicate. A later append reads only the bytes
// the previous append added to the open segment.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvent, appendIndexReads, eventLogPath, resetAppendIndexReads, type EventAppendResult,
} from '../src/bus/log.ts';
import { sealPathOf } from '../src/bus/seal.ts';

const PROJECT = 'acme';
const NOW = new Date('2026-10-19T12:00:00.000Z');
// The fixture rotates at 20 KB with four slots, so two rotations seal the oldest records into
// `.2` in a couple of hundred small appends.
const MAX_BYTES = 20_000;
const KEPT = 4;

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
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: builder
    name: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

const RETENTION = {
  maxBytes: MAX_BYTES,
  kept: KEPT,
  retentionSeconds: 30 * 24 * 60 * 60,
  maxTotalBytes: 100_000_000,
};

type World = { root: string; home: string };

const dirs: string[] = [];

afterEach(() => {
  for (const base of dirs.splice(0)) rmSync(base, { recursive: true, force: true });
});

function makeWorld(name: string): World {
  const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `bus-append-sealed-${name}-`)));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home);
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  return { root, home };
}

function livePath(world: World): string {
  return eventLogPath(PROJECT, world.root, world.home);
}

function append(world: World, id: string): Extract<EventAppendResult, { ok: true }> {
  const result = appendEvent(PROJECT, world.root, world.home, {
    ts: NOW.toISOString(),
    kind: 'message.arrived',
    session: 'acme',
    record_id: id,
    from: 'lead',
    to: 'builder',
    reason: 'x'.repeat(160),
  }, RETENTION);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

/** Padded filler until the fixture rotation creates `slot`. The records written before the
 *  rotation that first created `.2` end up inside it and the newest records in newer segments. */
function fillUntilSealed(world: World, slot: number, prefix: string): EventAppendResult {
  let last: EventAppendResult = { ok: false, reason: 'nothing appended' };
  for (let n = 1; n <= 900; n += 1) {
    last = append(world, `${prefix}-${String(n)}`);
    if (existsSync(`${livePath(world)}.${String(slot)}`)) return last;
  }
  throw new Error(`the fixture never sealed slot ${String(slot)}`);
}

function newestSeq(result: EventAppendResult): number {
  if (!result.ok) throw new Error(result.reason);
  return result.record.payload.seq;
}

/** One record's own line in a sealed segment, rewritten at the same length with a signature the
 *  key does not hold: the segment's size and its signed index still match the seal, so only a
 *  reader that checks the line's own signature can tell. */
function tamper(path: string, recordId: string): void {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.includes(`"record_id":"${recordId}"`));
  if (at < 0) throw new Error(`no line for ${recordId}`);
  const line = lines[at] as string;
  const signature = (JSON.parse(line) as { signature: string }).signature;
  // A hex signature is case-insensitive, so the forge must change a digit's value, not its case.
  const flipped = `${signature[0] === '0' ? '1' : '0'}${signature.slice(1)}`;
  lines[at] = line.replace(`"signature":"${signature}"`, `"signature":"${flipped}"`);
  writeFileSync(path, lines.join('\n'));
}

/** Moves one retained file's stamp so the append index must build afresh, as a new process does,
 *  without touching a byte the seal covers. */
function coldStart(path: string): void {
  const at = new Date();
  utimesSync(path, at, at);
}

describe('the append index hydrates from the sealed indexes', () => {
  test('a fresh append over sealed segments reads only the open segment, sealed bytes unread', () => {
    const world = makeWorld('fresh');
    const lastSealed = fillUntilSealed(world, 2, 'r');
    const before = newestSeq(append(world, 'open-1'));
    expect(newestSeq(lastSealed)).toBeLessThan(before);

    const live = livePath(world);
    const sealedBytes = statSync(`${live}.2`).size + statSync(`${live}.1`).size;
    const openBytes = statSync(live).size;
    expect(openBytes).toBeGreaterThan(0);
    expect(openBytes).toBeLessThan(sealedBytes);
    // Neither sealed segment can be read at all: the append still answers, and its sequence
    // follows the sealed indexes.
    chmodSync(`${live}.2`, 0o000);
    chmodSync(`${live}.1`, 0o000);
    coldStart(`${live}.1`);

    resetAppendIndexReads();
    const appended = append(world, 'fresh-key');
    expect(appended.duplicate).toBe(false);
    expect(appended.record.payload.seq).toBe(before + 1);
    const reads = appendIndexReads();
    expect(reads.files).toBe(1);
    expect(reads.bytes).toBe(openBytes);

    // The next append reads only the bytes the first one added to the open segment.
    resetAppendIndexReads();
    const second = append(world, 'fresh-key-2');
    expect(second.record.payload.seq).toBe(before + 2);
    const tail = appendIndexReads();
    expect(tail.files).toBe(1);
    expect(tail.bytes).toBeLessThan(1_000);
  });

  test('a duplicate inside a sealed segment is answered from its own line', () => {
    const world = makeWorld('duplicate');
    fillUntilSealed(world, 2, 'r');
    append(world, 'open-1');

    const live = livePath(world);
    const openBytes = statSync(live).size;
    const sealedBytes = statSync(`${live}.2`).size + statSync(`${live}.1`).size;
    // The newest sealed segment cannot be read; the oldest one, which holds the record being
    // replayed, can.
    chmodSync(`${live}.1`, 0o000);
    coldStart(`${live}.1`);

    resetAppendIndexReads();
    const replay = append(world, 'r-1');
    expect(replay.duplicate).toBe(true);
    expect(replay.record.payload.record_id).toBe('r-1');
    const reads = appendIndexReads();
    expect(reads.bytes).toBeGreaterThanOrEqual(openBytes);
    expect(reads.bytes).toBeLessThan(openBytes + 2_048);
    expect(reads.bytes).toBeLessThan(sealedBytes);
  });

  test('a segment with no trusted seal is read whole and the answer is unchanged', () => {
    const world = makeWorld('unsealed');
    fillUntilSealed(world, 2, 'r');
    const before = newestSeq(append(world, 'open-1'));

    const live = livePath(world);
    const openBytes = statSync(live).size;
    const unsealedBytes = statSync(`${live}.1`).size;
    rmSync(sealPathOf(`${live}.1`), { force: true });
    coldStart(`${live}.1`);

    resetAppendIndexReads();
    const appended = append(world, 'fresh-key');
    expect(appended.duplicate).toBe(false);
    expect(appended.record.payload.seq).toBe(before + 1);
    // The seal-less segment and the open segment are read; the sealed `.2` is not.
    const reads = appendIndexReads();
    expect(reads.files).toBe(2);
    expect(reads.bytes).toBe(openBytes + unsealedBytes);
  });

  test('a sealed index that names a line which no longer verifies falls back to the verified walk', () => {
    const world = makeWorld('disagree');
    fillUntilSealed(world, 2, 'r');
    const before = newestSeq(append(world, 'open-1'));

    const live = livePath(world);
    const retainedBytes = statSync(`${live}.2`).size + statSync(`${live}.1`).size + statSync(live).size;
    tamper(`${live}.2`, 'r-1');
    coldStart(`${live}.1`);

    resetAppendIndexReads();
    const appended = append(world, 'r-1');
    // The forged line is never returned as the duplicate; the ordinary verified walk answers that
    // no verified r-1 is retained, and the append writes a new record.
    expect(appended.duplicate).toBe(false);
    expect(appended.record.payload.reason).toBe('x'.repeat(160));
    expect(appended.record.payload.seq).toBe(before + 1);
    // The fallback reads every retained file once, plus the candidate line it had already tried.
    const reads = appendIndexReads();
    expect(reads.bytes).toBeGreaterThanOrEqual(retainedBytes);
    expect(reads.bytes).toBeLessThan(retainedBytes + 2_048);
  });

  test('a sealed index walks past earlier decoy occurrences of the record id and finds the real duplicate later', () => {
    const world = makeWorld('sealed-decoy');
    // 1. An earlier event in what will become `.2` whose `from` field in `.index.jsonl` spells `"sealed-decoy-1"`.
    const decoyFrom = appendEvent(
      PROJECT,
      world.root,
      world.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: 'other-id-1',
        from: 'sealed-decoy-1',
        to: 'builder',
        reason: 'x'.repeat(160),
      },
      RETENTION,
    );
    expect(decoyFrom.ok).toBe(true);

    // 2. An earlier event in `.2` with the same `record_id` under another kind (`message.staged`).
    const decoyKind = appendEvent(
      PROJECT,
      world.root,
      world.home,
      {
        ts: NOW.toISOString(),
        kind: 'message.staged',
        session: 'acme',
        record_id: 'sealed-decoy-1',
        from: 'lead',
        to: 'builder',
        reason: 'x'.repeat(160),
      },
      RETENTION,
    );
    expect(decoyKind.ok).toBe(true);

    // 3. The real `message.arrived` record for `sealed-decoy-1` comes later in `.2`.
    const real = append(world, 'sealed-decoy-1');
    expect(real.duplicate).toBe(false);

    fillUntilSealed(world, 2, 'r');
    append(world, 'open-1');

    const live = livePath(world);
    const openBytes = statSync(live).size;
    const sealedBytes = statSync(`${live}.2`).size + statSync(`${live}.1`).size;
    chmodSync(`${live}.1`, 0o000);
    coldStart(`${live}.1`);

    resetAppendIndexReads();
    const replay = append(world, 'sealed-decoy-1');
    expect(replay.duplicate).toBe(true);
    expect(replay.record.payload.seq).toBe(real.record.payload.seq);
    const reads = appendIndexReads();
    expect(reads.files).toBe(1);
    expect(reads.lines).toBe(2);
    expect(reads.bytes).toBeGreaterThanOrEqual(openBytes);
    expect(reads.bytes).toBeLessThan(openBytes + 2_048);
    expect(reads.bytes).toBeLessThan(sealedBytes);
  });
});
