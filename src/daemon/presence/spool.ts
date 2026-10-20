// The presence spool's paths and its one writer. A runtime adapter or the daemon stages a record
// here; the daemon's ingester is the only process that appends to `events.jsonl` and replaces
// `current.json`. The folder layout lives beside the seat-state folder and uses the same session
// encoding (`.` and `..` never appear; every byte outside `[A-Za-z0-9_-]` is `%XX`), so a session
// name can never escape the presence tree. `test/daemon-presence-ingest.test.ts` pins that the
// encoding agrees with `src/launch/cli-hook.ts`.
//
// A missing `spool/` folder means the seat is not participating (it was launched before this
// feature, or the launch kept no hook): the ingester leaves everything under that seat alone and
// creates no log, projection or status file. The first valid spool is what permits creation.
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SEAT_NAME } from '../../file/sections/seats.ts';
import {
  presenceRecordOf, readPresenceRecord, type PresenceEvent, type PresenceWriterSource,
} from './contract.ts';

/** The four paths of one seat's presence state, under the team file's own folder (today
 *  `.agents`), never the checkout root. */
export type PresencePaths = {
  root: string;
  spool: string;
  log: string;
  current: string;
  rejected: string;
  stale: string;
};

/** A session name as one folder name, exactly as the seat-state tree encodes it. */
export function presenceSessionFolder(session: string): string | null {
  if (session.length === 0) return null;
  let encoded = '';
  for (const byte of Buffer.from(session, 'utf8')) {
    const kept = (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f || byte === 0x2d;
    encoded += kept ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return Buffer.byteLength(encoded) <= 255 ? encoded : null;
}

/** Whether a seat name can be one path segment under the presence tree: the team file's own rule
 *  and the filesystem's segment limit. */
export function isPresenceSeatName(seat: string): boolean {
  return SEAT_NAME.test(seat) && Buffer.byteLength(seat) <= 255;
}

/** The folder holding every presence seat of one session, or null when the session cannot be a
 *  folder. */
export function presenceSessionDir(stateDir: string, session: string): string | null {
  const folder = presenceSessionFolder(session);
  return folder === null ? null : join(stateDir, 'presence', folder);
}

/** One seat's presence paths, or null when the session or seat cannot name a folder. */
export function presencePaths(stateDir: string, session: string, seat: string): PresencePaths | null {
  const sessionDir = presenceSessionDir(stateDir, session);
  if (sessionDir === null || !isPresenceSeatName(seat)) return null;
  const root = join(sessionDir, seat);
  return {
    root,
    spool: join(root, 'spool'),
    log: join(root, 'events.jsonl'),
    current: join(root, 'current.json'),
    rejected: join(root, 'rejected'),
    stale: join(root, 'stale'),
  };
}

/** The route-level channel record, written by the ingester (or by the daemon on its behalf) so a
 *  reader can tell a live channel from a last-known reading. It lives beside the seat folders. */
export function presenceStatusPath(stateDir: string, session: string): string | null {
  const dir = presenceSessionDir(stateDir, session);
  return dir === null ? null : join(dir, 'status.json');
}

/** What a writer supplies. `v` and `id` are derived; `ts` defaults to now unless the emitter has
 *  its own event instant (a launch end stamps the process end, not the stage instant). */
export type PresenceStageInput = {
  session: string;
  seat: string;
  binding: string;
  source: PresenceWriterSource;
  event: PresenceEvent;
  raw?: string;
  ts?: string;
  id?: string;
};

export type PresenceStageResult =
  | { kind: 'staged'; path: string }
  | { kind: 'refused'; why: string };

/** The one writer of a spool record. The input is built into a record and validated whole; then
 *  it is written to a temporary name in the spool folder and renamed to `<id>.json`, so a reader
 *  never sees a half-written record and a planted link is replaced rather than written through.
 *  The writer creates the spool folder; it creates nothing else — the ingester owns the log, the
 *  projection and the status file. The daemon's launch/end uses this same entry with
 *  `source: 'daemon-launch'`; a runtime adapter uses its own source word. */
export function stagePresenceRecord(stateDir: string, input: PresenceStageInput): PresenceStageResult {
  const record = presenceRecordOf({
    session: input.session,
    seat: input.seat,
    binding: input.binding,
    source: input.source,
    event: input.event,
    ...(input.raw === undefined ? {} : { raw: input.raw }),
    ts: input.ts ?? new Date().toISOString(),
    ...(input.id === undefined ? {} : { id: input.id }),
  });
  if (record === null) return { kind: 'refused', why: 'the writer supplied a field the contract does not allow' };
  const checked = readPresenceRecord(JSON.stringify(record));
  if (checked.kind === 'bad') return { kind: 'refused', why: checked.why };
  const paths = presencePaths(stateDir, checked.record.session, checked.record.seat);
  if (paths === null) return { kind: 'refused', why: 'the session or seat cannot name a presence folder' };
  try {
    mkdirSync(paths.spool, { recursive: true, mode: 0o700 });
    const temporary = join(paths.spool, `.new.${String(process.pid)}.${randomBytes(4).toString('hex')}`);
    writeFileSync(temporary, `${JSON.stringify(checked.record)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    const path = join(paths.spool, `${checked.record.id}.json`);
    renameSync(temporary, path);
    return { kind: 'staged', path };
  } catch (error) {
    return { kind: 'refused', why: `the record could not be staged: ${(error as Error).message}` };
  }
}
