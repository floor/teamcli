// `team ask-show`: print the question from a signed ask when the guard's marker HMAC matches.
// No team file, no caller check, no herdr. Whoever can read the key file can run it. The key
// is base64url of 32 bytes. The marker is the guard's side file, not a new field of the ask.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { readArgs } from '../args.ts';
import type { Command, Io } from '../io.ts';

export const USAGE = `Usage: team ask-show <request_id> --ask <path> --marker <path> --key <path>

Prints the question from the ask file when the marker's HMAC matches that question and
this request id, and expires_at is not yet past. The same 5 seconds of clock skew the
guard allows still counts as in time. A marker that does not verify, or an ask that has
expired, prints nothing of the question. The key file is the marker key, base64url of 32
bytes. Whoever can read that file may run this: there is no team-file check and no herdr
call.

Exits 0 when the question is printed, 1 when the marker does not verify, the ask has
expired, or a file cannot be read, 2 when the invocation cannot be read.
`;

/** Domain prefix of the marker HMAC, including the trailing NUL. */
export const MARKER_DOMAIN = 'TeamCLI:ask-marker:v1\0';

/** Fields the mac covers, in this order. `mac` itself is not an input. */
export const MARKER_FIELDS = ['v', 'request_id', 'question_sha256', 'expires_at'] as const;

/** How far past expires_at still counts as in time. The guard's CLOCK_SKEW_MS is the same 5s. */
export const CLOCK_SKEW_MS = 5_000;

const ASK_HEADER = 'TeamCLI signed ask v1\n';
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const EXPIRES_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const ASK_MAX = 16_384;
const MARKER_MAX = 4_096;
const KEY_MAX = 128;

export type MarkerBody = {
  v: 1;
  request_id: string;
  question_sha256: string;
  expires_at: string;
};

const askShow: Command = (argv, io) => runAskShow(argv, io);
export default askShow;

/** SHA-256 of the question, lowercase hex. The marker stores this, not the question. */
export function questionDigest(question: string): string {
  return createHash('sha256').update(question, 'utf8').digest('hex');
}

/** Domain, then each covered field: u32be(name length), name, u32be(JSON length), JSON.stringify(value). */
export function markerSigningBytes(body: MarkerBody): Buffer {
  const parts: Buffer[] = [Buffer.from(MARKER_DOMAIN, 'utf8')];
  for (const name of MARKER_FIELDS) {
    const field = Buffer.from(name, 'utf8');
    const value = Buffer.from(JSON.stringify(body[name]), 'utf8');
    const fieldLength = Buffer.alloc(4);
    const valueLength = Buffer.alloc(4);
    fieldLength.writeUInt32BE(field.length);
    valueLength.writeUInt32BE(value.length);
    parts.push(fieldLength, field, valueLength, value);
  }
  return Buffer.concat(parts);
}

/** Lowercase hex HMAC-SHA256 of `markerSigningBytes` under `key`. */
export function markerMac(key: Buffer, body: MarkerBody): string {
  return createHmac('sha256', key).update(markerSigningBytes(body)).digest('hex');
}

export async function runAskShow(argv: string[], io: Io, now: Date = new Date()): Promise<number> {
  const args = readArgs(argv, ['ask', 'marker', 'key'], []);
  if (args.error) return invocation(io, args.error);
  const requestId = args.rest[0];
  if (args.rest.length !== 1 || requestId === undefined || !REQUEST_ID.test(requestId)) {
    return invocation(io, 'a request id, --ask, --marker and --key are required');
  }
  const askPath = args.values.ask;
  const markerPath = args.values.marker;
  const keyPath = args.values.key;
  if (askPath === undefined || markerPath === undefined || keyPath === undefined) {
    return invocation(io, 'a request id, --ask, --marker and --key are required');
  }

  const key = readKey(io.cwd, keyPath);
  if (key === 'unreadable') return refused(io, 'the key file cannot be read');
  if (key === 'shape') return refused(io, 'the key is not 32 bytes');

  const ask = readAsk(io.cwd, askPath);
  if (ask === 'unreadable') return refused(io, 'the ask file cannot be read');
  if (ask === 'shape') return refused(io, 'the marker does not verify');

  const marker = readMarker(io.cwd, markerPath);
  if (marker === 'unreadable') return refused(io, 'the marker file cannot be read');
  if (marker === 'shape') return refused(io, 'the marker does not verify');

  if (marker.request_id !== requestId || marker.request_id !== ask.requestId) {
    return refused(io, 'the marker does not verify');
  }
  if (marker.question_sha256 !== questionDigest(ask.question)) return refused(io, 'the marker does not verify');
  const mac = Buffer.from(markerMac(key, marker), 'hex');
  const given = Buffer.from(marker.mac, 'hex');
  if (mac.length !== given.length || !timingSafeEqual(mac, given)) return refused(io, 'the marker does not verify');

  const expires = Date.parse(marker.expires_at);
  const at = now.getTime();
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== marker.expires_at || !Number.isFinite(at)) {
    return refused(io, 'the marker does not verify');
  }
  if (at > expires + CLOCK_SKEW_MS) return expired(io);

  io.stdout(ask.question.endsWith('\n') ? ask.question : `${ask.question}\n`);
  // exit: ask-show.shown
  return 0;
}

function invocation(io: Io, message: string): number {
  io.stderr(`team ask-show: ${message}\n${USAGE}`);
  // exit: ask-show.invocation
  return 2;
}

function expired(io: Io): number {
  io.stderr('team ask-show: the ask has expired\n');
  // exit: ask-show.expired
  return 1;
}

function refused(io: Io, message: string): number {
  io.stderr(`team ask-show: ${message}\n`);
  // exit: ask-show.refused
  return 1;
}

function readKey(cwd: string, path: string): Buffer | 'unreadable' | 'shape' {
  const bytes = readBounded(cwd, path, KEY_MAX);
  if (bytes === null) return 'unreadable';
  const text = bytes.toString('utf8');
  const raw = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (raw.length === 0 || raw.includes('\n')) return 'shape';
  const key = Buffer.from(raw, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== raw) return 'shape';
  return key;
}

function readAsk(cwd: string, path: string): { requestId: string; question: string } | 'unreadable' | 'shape' {
  const bytes = readBounded(cwd, path, ASK_MAX);
  if (bytes === null) return 'unreadable';
  const text = bytes.toString('utf8');
  if (!text.startsWith(ASK_HEADER)) return 'shape';
  let raw = text.slice(ASK_HEADER.length);
  if (raw.endsWith('\n')) raw = raw.slice(0, -1);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return 'shape';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'shape';
  const question = (value as { question?: unknown }).question;
  const requestId = (value as { request_id?: unknown }).request_id;
  if (typeof question !== 'string' || question.length === 0) return 'shape';
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return 'shape';
  return { requestId, question };
}

function readMarker(cwd: string, path: string): (MarkerBody & { mac: string }) | 'unreadable' | 'shape' {
  const bytes = readBounded(cwd, path, MARKER_MAX);
  if (bytes === null) return 'unreadable';
  let raw = bytes.toString('utf8');
  if (raw.endsWith('\n')) raw = raw.slice(0, -1);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return 'shape';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'shape';
  const fields = Object.keys(value);
  const expected = [...MARKER_FIELDS, 'mac'];
  if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])) return 'shape';
  if (JSON.stringify(value) !== raw) return 'shape';
  const marker = value as { v: unknown; request_id: unknown; question_sha256: unknown; expires_at: unknown; mac: unknown };
  if (marker.v !== 1) return 'shape';
  if (typeof marker.request_id !== 'string' || !REQUEST_ID.test(marker.request_id)) return 'shape';
  if (typeof marker.question_sha256 !== 'string' || !SHA256_HEX.test(marker.question_sha256)) return 'shape';
  if (typeof marker.expires_at !== 'string' || !EXPIRES_AT.test(marker.expires_at)) return 'shape';
  if (typeof marker.mac !== 'string' || !SHA256_HEX.test(marker.mac)) return 'shape';
  return {
    v: 1,
    request_id: marker.request_id,
    question_sha256: marker.question_sha256,
    expires_at: marker.expires_at,
    mac: marker.mac,
  };
}

/** A regular file, not a symlink, no larger than `max`. Null when it cannot be read. */
function readBounded(cwd: string, path: string, max: number): Buffer | null {
  const full = resolve(cwd, path);
  let fd: number;
  try {
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) return null;
    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buf.length) {
      const count = readSync(fd, buf, offset, buf.length - offset, null);
      if (count === 0) return null;
      offset += count;
    }
    return buf;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
