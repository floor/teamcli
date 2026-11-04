// Sealed event segments. A rotation closes the live segment; the closed file gets a sidecar seal
// — a signed statement of its name, range, line count, byte count, digest, predecessor and the
// per-record index it vouches for — and the index itself, one compact line per record so a reader
// can seek by sequence or record id without re-reading the segment.
//
// The seal is signed under the checkout's message key in its own domain and proves the log was
// not edited after sealing; each event line keeps its own signature for authorship. The index is
// untrusted on its own: its byte count, line count and digest are signed into the seal, and a
// reader compares the file against that triple before it trusts any offset.
//
// A segment this build cannot spell exactly — a partial or malformed line, a file that moved while
// it was read — gets no seal and no index. Readers then verify it in full, exactly as before
// seals existed, and a segment that cannot be sealed blocks the sealing of every later segment
// (their predecessor chain would be broken).
import { createHash, type KeyObject } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readSync, type Stats } from 'node:fs';
import { heldAt } from '../launch/rules-file.ts';
import { readNoFollow } from '../send/history.ts';
import { writeAtomic } from '../state.ts';
import { signDomain, verifyDomain } from '../store/keys.ts';

/** The seal's own signing domain: a seal signature can never be read as an event signature and
 *  the reverse, even though both use the message key. */
export const SEAL_DOMAIN = 'teamcli bus segment-seal v1\n';
/** The format a seal spells for itself; a different word is another build's file, not a guess. */
export const SEAL_FORMAT = 'teamcli bus segment-seal v1';
export const SEAL_SUFFIX = '.seal.json';
export const INDEX_SUFFIX = '.index.jsonl';

const HEX_64 = /^[0-9a-f]{64}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The companion index's signed triple: what a reader checks before trusting an offset. */
export type SealIndex = { bytes: number; lines: number; digest: string };

/** Everything a seal signs. The order below is the order the payload is built in, so the digest
 *  and the signature are stable across processes. */
export type SealFields = {
  format: string;
  keyPrint: string;
  store: string;
  segment: string;
  firstSeq: number;
  lastSeq: number;
  lines: number;
  bytes: number;
  digest: string;
  previous: string | null;
  sealedAt: number;
  index: SealIndex;
};

/** A seal on disk: the signed fields, their digest and the signature over them. */
export type StoredSeal = SealFields & { sealDigest: string; signature: string };

/** The exact shape the digest and signature cover: `SealFields` in the fixed order below. */
export type SealPayload = {
  format: string;
  keyPrint: string;
  store: string;
  segment: string;
  firstSeq: number;
  lastSeq: number;
  lines: number;
  bytes: number;
  digest: string;
  previous: string | null;
  sealedAt: number;
  index: SealIndex;
};

/** One record's place in a sealed segment: no payload, no signature, never trusted on its own. */
export type SegmentIndexEntry = {
  seq: number;
  offset: number;
  kind: string;
  record_id: string;
  session: string;
  seat?: string;
  ts?: string;
  from?: string;
  to?: string;
};

export function sealPathOf(segmentPath: string): string {
  return `${segmentPath}${SEAL_SUFFIX}`;
}

export function indexPathOf(segmentPath: string): string {
  return `${segmentPath}${INDEX_SUFFIX}`;
}

/** The key print every signed sidecar names: the private key's PKCS#8 PEM, hashed. Built here so
 *  the checkpoint and the seal spell the same print for the same key. */
export function keyPrintOfKey(key: KeyObject): string {
  return createHash('sha256').update(key.export({ type: 'pkcs8', format: 'pem' })).digest('hex');
}

/** The fields a seal's digest and signature cover, in a fixed order. */
export function sealPayloadOf(fields: SealFields): SealPayload {
  return {
    format: fields.format,
    keyPrint: fields.keyPrint,
    store: fields.store,
    segment: fields.segment,
    firstSeq: fields.firstSeq,
    lastSeq: fields.lastSeq,
    lines: fields.lines,
    bytes: fields.bytes,
    digest: fields.digest,
    previous: fields.previous,
    sealedAt: fields.sealedAt,
    index: {
      bytes: fields.index.bytes,
      lines: fields.index.lines,
      digest: fields.index.digest,
    },
  };
}

/** The digest a successor seal names as its `previous`: the canonical payload, hashed. */
export function sealDigestOf(fields: SealFields): string {
  return createHash('sha256').update(JSON.stringify(sealPayloadOf(fields)), 'utf8').digest('hex');
}

function canonicalFields(record: StoredSeal | SealFields): SealFields {
  return {
    format: record.format,
    keyPrint: record.keyPrint,
    store: record.store,
    segment: record.segment,
    firstSeq: record.firstSeq,
    lastSeq: record.lastSeq,
    lines: record.lines,
    bytes: record.bytes,
    digest: record.digest,
    previous: record.previous,
    sealedAt: record.sealedAt,
    index: { bytes: record.index.bytes, lines: record.index.lines, digest: record.index.digest },
  };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** The seal a sidecar spells, or null when the file is not the shape this build wrote or its
 *  signed digest no longer matches its fields. Never repairs, never guesses. */
export function parseStoredSeal(text: string): StoredSeal | null {
  if (text === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Partial<StoredSeal>;
  if (record.format !== SEAL_FORMAT) return null;
  for (const field of ['keyPrint', 'store', 'segment'] as const) {
    if (typeof record[field] !== 'string' || record[field] === '') return null;
  }
  if (typeof record.firstSeq !== 'number' || !Number.isInteger(record.firstSeq) || record.firstSeq < 1) return null;
  if (typeof record.lastSeq !== 'number' || !Number.isInteger(record.lastSeq) || record.lastSeq < 1) return null;
  if (!isCount(record.lines) || !isCount(record.bytes)) return null;
  if (typeof record.digest !== 'string' || !HEX_64.test(record.digest)) return null;
  if (record.previous !== null && (typeof record.previous !== 'string' || !HEX_64.test(record.previous))) return null;
  if (typeof record.sealedAt !== 'number' || !Number.isFinite(record.sealedAt)) return null;
  const index = record.index as Partial<SealIndex> | undefined;
  if (typeof index !== 'object' || index === null) return null;
  if (!isCount(index.bytes) || !isCount(index.lines)) return null;
  if (typeof index.digest !== 'string' || !HEX_64.test(index.digest)) return null;
  if (typeof record.sealDigest !== 'string' || !HEX_64.test(record.sealDigest)) return null;
  if (typeof record.signature !== 'string') return null;
  const fields = canonicalFields(record as SealFields);
  if (sealDigestOf(fields) !== record.sealDigest) return null;
  return { ...fields, sealDigest: record.sealDigest, signature: record.signature };
}

/**
 * Reads and verifies one segment's seal: shape and signed digest, the segment and store it
 * names, the key print this read is running under, and the signature under the message key.
 * Any disagreement — missing, unreadable, foreign, altered, another key — is a miss.
 */
export function readSeal(
  segmentPath: string,
  segmentName: string,
  storeDir: string,
  keyPrint: string,
  key: KeyObject | null,
): StoredSeal | null {
  if (key === null) return null;
  const text = readNoFollow(sealPathOf(segmentPath));
  if (text === null) return null;
  const seal = parseStoredSeal(text);
  if (seal === null) return null;
  if (seal.segment !== segmentName || seal.store !== storeDir || seal.keyPrint !== keyPrint) return null;
  if (!verifyDomain(SEAL_DOMAIN, sealPayloadOf(seal), seal.signature, key)) return null;
  return seal;
}

/** The segment's bytes as it stands, with the stat taken after the read. Null when the path is
 *  not a regular file this user owns, the read cannot finish, or the file moved while it was
 *  read (a segment that changed gets no seal from this pass). */
function readSegmentBytes(path: string): { bytes: Buffer; after: Stats } | null {
  if (heldAt(path).kind !== 'file') return null;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) return null;
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < before.size) {
      const n = readSync(fd, bytes, position, before.size - position, position);
      if (n <= 0) break;
      position += n;
    }
    const after = fstatSync(fd);
    if (position !== before.size) return null;
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null;
    return { bytes, after };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * The companion index for one closed segment: one JSON line per complete record line, naming its
 * byte offset and the fields a lookup needs. Null when the segment is empty, does not end in a
 * newline, or holds a line this build cannot spell — such a segment is sealed by nobody and
 * verified in full by every reader.
 */
export function buildSegmentIndex(bytes: Buffer): { text: string; entries: SegmentIndexEntry[] } | null {
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) return null;
  const entries: SegmentIndexEntry[] = [];
  let position = 0;
  while (position < bytes.length) {
    const newline = bytes.indexOf(0x0a, position);
    if (newline < 0) return null;
    const line = bytes.subarray(position, newline).toString('utf8');
    if (line === '') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const payload = (parsed as { payload?: unknown }).payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    if (typeof record['seq'] !== 'number' || !Number.isInteger(record['seq']) || record['seq'] < 1) return null;
    if (typeof record['kind'] !== 'string') return null;
    if (typeof record['record_id'] !== 'string') return null;
    if (typeof record['session'] !== 'string') return null;
    const entry: SegmentIndexEntry = {
      seq: record['seq'],
      offset: position,
      kind: record['kind'],
      record_id: record['record_id'],
      session: record['session'],
    };
    for (const field of ['seat', 'ts', 'from', 'to'] as const) {
      const value = record[field];
      if (typeof value === 'string') entry[field] = value;
    }
    entries.push(entry);
    position = newline + 1;
  }
  if (entries.length === 0) return null;
  return { text: `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, entries };
}

/**
 * Seals one closed segment: reads it, writes its index beside it, then writes the signed seal
 * that names the index's triple. `previous` is the predecessor seal's digest, or null only for
 * the chain's root. Null when the segment cannot be spelled exactly as it stands; the segment
 * then stays unsealed for every reader.
 */
export function sealSegment(
  segmentPath: string,
  segmentName: string,
  storeDir: string,
  keyPrint: string,
  key: KeyObject | null,
  previous: string | null,
): StoredSeal | null {
  if (key === null) return null;
  const read = readSegmentBytes(segmentPath);
  if (read === null) return null;
  const index = buildSegmentIndex(read.bytes);
  if (index === null) return null;
  const indexBytes = Buffer.from(index.text, 'utf8');
  const fields: SealFields = {
    format: SEAL_FORMAT,
    keyPrint,
    store: storeDir,
    segment: segmentName,
    firstSeq: index.entries[0]!.seq,
    lastSeq: index.entries[index.entries.length - 1]!.seq,
    lines: index.entries.length,
    bytes: read.bytes.length,
    digest: createHash('sha256').update(read.bytes).digest('hex'),
    previous,
    // The segment's own last-write time, never the writer's clock. The signing canonical form
    // takes safe integers only, so the millisecond is truncated, not rounded.
    sealedAt: Math.floor(read.after.mtimeMs),
    index: {
      bytes: indexBytes.length,
      lines: index.entries.length,
      digest: createHash('sha256').update(indexBytes).digest('hex'),
    },
  };
  const sealDigest = sealDigestOf(fields);
  const signature = signDomain(SEAL_DOMAIN, sealPayloadOf(fields), key);
  // A second process sealing the same bytes computes the same fields and the same digest; either
  // rename may land. The segment was checked before and after the read, so a file that moved in
  // between carries no seal from this pass.
  writeAtomic(indexPathOf(segmentPath), index.text);
  writeAtomic(
    sealPathOf(segmentPath),
    `${JSON.stringify({ ...sealPayloadOf(fields), sealDigest, signature })}\n`,
  );
  return { ...fields, sealDigest, signature };
}
