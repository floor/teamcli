// The move half of the scoped message archive (`team ack --seat` and `team archive --seat`): what
// of one stopped seat's backlog is due, what must stay, and how a due family leaves the two trees
// a bus pass re-reads. The rules are the proven archive procedure's — a family is the record plus
// every sidecar beside it, the record must verify with this checkout's message key, the read or
// replied receipt is what acknowledges it, and a general brief, a pending handoff, a fresh family
// and an unverifiable one never move. A plain-text drop an earlier build wrote has no record and
// no reader: it is moved whole, alone, and never served or acknowledged. Every file is read
// without following a link and moved with `renameSync`; nothing here unlinks anything.
import { createHash, type KeyObject } from 'node:crypto';
import { closeSync, constants, existsSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { legacyReceiptMatches, messagePayload } from '../commands/messages.ts';
import { ensureFoldersBelow } from './history.ts';
import { GENERAL_BRIEF_FROM, GENERAL_BRIEF_RULE, isGeneralBriefRecord } from '../launch/general-brief.ts';
import { isReadOrCleared, recordAuthOf, sameFolder, statusOf, type RecordPayload } from './record.ts';
import { readState } from '../state.ts';
import { MESSAGE_DOMAIN, verifyDomain, type Json } from '../store/keys.ts';

/** A family member's suffixes in move order: the receipts in status order, the thread close, and
 *  the bookkeeping that is only meaningful beside the record. The record itself is named first. */
const FAMILY_SUFFIXES: readonly string[] = [
  '.held.json', '.delivered.json', '.read.json', '.replied.json', '.closed.json',
  '.held', '.delivered', '.read', '.replied', '.wake', '.reported', '.fallback.json',
];

/** A name one message file may have: no separator, no traversal, no NUL. */
const RECORD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** A nudge beside the records, not a message: it never moves and is never counted. */
const WORK_PREFIX = 'work-';

/** Why a family stays where it is. The names are the procedure's, so a run's report reads the
 *  same as the hand-run archive's. */
export type StayReason =
  | 'unread'
  | 'delivered-only'
  | 'pending-or-taken'
  | 'general-brief'
  | 'too-recent'
  | 'record-does-not-verify'
  | 'not-a-record'
  | 'unknown-age'
  | 'not-this-seat-or-checkout'
  | 'client-record';

export type Stay = { id: string; reason: StayReason };

/** One family the archive will move: the record first for the transport tree, the receipt first
 *  for the legacy store, as the procedure's manual move does. */
export type PlannedMove = {
  store: 'send-drops' | 'messages';
  seat: string;
  id: string;
  dir: string;
  files: string[];
  newest: number;
  bytes: number;
};

export type ArchiveScan = { move: PlannedMove[]; stays: Stay[]; scanned: number };

/** A record a lead's sweep may clear: its id, and the signed sender, body and thread the history
 *  line the clearance writes carries. */
export type AckDue = { id: string; from: string; body: string; thread: string };

/** What the scoped ack read: the records it may write a receipt for, the ones a receipt already
 *  serves, and the families that stay for a reason. */
export type AckScan = { due: AckDue[]; already: number; stays: Stay[]; scanned: number };

/** Whether one seat's backlog is the scoped calls' to clear. A lead clears a stopped or retired
 *  seat's stale mail, never a running seat's: the seat is still there to read it. */
export type SeatClearTarget =
  | { kind: 'admitted' }
  | { kind: 'running' }
  | { kind: 'unknown' }
  | { kind: 'unreadable'; reason: string };

/**
 * The lifecycle gate for `team ack --seat` and `team archive --seat`. A seat the team file
 * declares and the state records is running, and stays its own reader. One the file declares and
 * the state does not record — or the file marks `stopped: true` — is stopped, and admitted. One
 * the file no longer declares is retired, and admitted while its own folder (transport or the
 * older store) or a leftover state entry remembers it; a name with none of those was never a seat
 * here. A state file that cannot be read is reported, never treated as an empty one: a running
 * seat must not be cleared because its record is unreadable.
 */
export function seatClearTargetStatus(options: {
  agents: string;
  session: string;
  seat: string;
  seats: readonly { name: string; stopped: boolean }[];
}): SeatClearTarget {
  const { agents, session, seat, seats } = options;
  const declared = seats.find((member) => member.name === seat);
  let recorded: unknown;
  try {
    recorded = readState(agents).sessions[session]?.seats?.[seat];
  } catch (error) {
    return { kind: 'unreadable', reason: messageOf(error) };
  }
  if (declared !== undefined) {
    if (declared.stopped !== true && recorded !== undefined) return { kind: 'running' };
    return { kind: 'admitted' };
  }
  if (recorded !== undefined) return { kind: 'admitted' };
  if (realDir(join(agents, 'send-drops', session, seat))) return { kind: 'admitted' };
  if (realDir(join(agents, 'messages', seat))) return { kind: 'admitted' };
  return { kind: 'unknown' };
}

export type MovedFile = { digest: string; bytes: number; source: string; dest: string };

/** `<n><unit>` with a whole positive number and the four window units: 90m, 12h, 7d, 30s. */
export function parseDuration(text: string): number | null {
  const match = /^([1-9][0-9]*)([smhd])$/.exec(text);
  if (match === null) return null;
  const count = Number(match[1]);
  const unit = match[2] === 's' ? 1000 : match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000;
  const ms = count * unit;
  return Number.isSafeInteger(ms) ? ms : null;
}

function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function realDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function anything(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A read that never follows a link: the caller lstat'ed a regular file first, and O_NOFOLLOW
 *  turns a race that swaps in a link into an error instead of a read of its target. */
function readRegular(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function parsedFile(path: string): unknown {
  try {
    return JSON.parse(readRegular(path).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function newestMtime(paths: readonly string[]): number | null {
  let newest = Number.NEGATIVE_INFINITY;
  for (const path of paths) {
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
    } catch {
      return null;
    }
  }
  return Number.isFinite(newest) ? newest : null;
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stay(scan: { stays: Stay[] }, id: string, reason: StayReason): void {
  scan.stays.push({ id, reason });
}

function authOf(parsed: unknown, key: KeyObject): ReturnType<typeof recordAuthOf> {
  try {
    return recordAuthOf(parsed, key);
  } catch {
    return { kind: 'shape' };
  }
}

function isClientRecord(payload: RecordPayload): boolean {
  return payload.from_client !== undefined || payload.to_client !== undefined;
}

/** The files of one transport family, record first, in move order, that are regular files. */
function familyFiles(dir: string, id: string): string[] {
  return [id, ...FAMILY_SUFFIXES.map((suffix) => id + suffix)].filter((name) => regularFile(join(dir, name)));
}

/**
 * The seat's transport folder, as the scoped ack sees it: a verified record that is due for a
 * signed read receipt. Bodies, the general brief, a client's record, a pending handoff, a fresh
 * family and a family that does not verify are reported, never acked.
 */
export function scanAckSeat(options: {
  root: string;
  session: string;
  seat: string;
  key: KeyObject;
  olderThanMs: number;
  now: Date;
  /** The team's resolved lead: the only seat name a clearance receipt may carry and settle. */
  lead?: string;
}): AckScan {
  const { root, session, seat, key } = options;
  const context = { to: seat, root, session, ...(options.lead === undefined ? {} : { lead: options.lead }) };
  const cutoff = options.now.getTime() - options.olderThanMs;
  const dir = join(root, '.agents', 'send-drops', session, seat);
  const scan: AckScan = { due: [], already: 0, stays: [], scanned: 0 };
  if (!realDir(dir)) return scan;
  for (const name of readdirSync(dir).sort()) {
    if (name.includes('.') || !RECORD_NAME.test(name) || name.startsWith(WORK_PREFIX)) continue;
    const path = join(dir, name);
    if (!regularFile(path)) continue;
    scan.scanned += 1;
    const parsed = parsedFile(path);
    if (parsed === undefined) {
      stay(scan, name, 'not-a-record');
      continue;
    }
    const auth = authOf(parsed, key);
    if (auth.kind !== 'ok') {
      stay(scan, name, 'record-does-not-verify');
      continue;
    }
    const payload = auth.value.payload;
    if (payload.id !== name || payload.to !== seat || payload.session !== session || !sameFolder(payload.root, root)) {
      stay(scan, name, 'not-this-seat-or-checkout');
      continue;
    }
    if (isGeneralBriefRecord(payload)) {
      stay(scan, name, 'general-brief');
      continue;
    }
    if (isClientRecord(payload)) {
      stay(scan, name, 'client-record');
      continue;
    }
    if (anything(join(dir, `${name}.pending`)) || anything(join(dir, `${name}.taken`))) {
      stay(scan, name, 'pending-or-taken');
      continue;
    }
    const files = familyFiles(dir, name);
    const newest = newestMtime(files.map((file) => join(dir, file)));
    if (newest === null) {
      stay(scan, name, 'unknown-age');
      continue;
    }
    if (newest > cutoff) {
      stay(scan, name, 'too-recent');
      continue;
    }
    // A message the seat read, or one a lead already cleared, is not due again: the receipt name
    // is held by the first serving and is never rewritten.
    if (isReadOrCleared(dir, name, context, key)) {
      scan.already += 1;
      continue;
    }
    scan.due.push({ id: name, from: payload.from, body: payload.body, thread: payload.thread });
  }
  return scan;
}

/**
 * The seat's transport folder, as the scoped archive sees it: an acknowledged family, or a
 * plain-text drop of an earlier build, older than the window. The general brief, a client's
 * record, a pending handoff, an unread family, a fresh family and one that does not verify stay.
 */
export function scanArchiveSeat(options: {
  root: string;
  session: string;
  seat: string;
  key: KeyObject;
  olderThanMs: number;
  now: Date;
  /** The team's resolved lead: the only seat name a clearance receipt may carry and settle. */
  lead?: string;
}): ArchiveScan {
  const { root, session, seat, key } = options;
  const context = { to: seat, root, session, ...(options.lead === undefined ? {} : { lead: options.lead }) };
  const cutoff = options.now.getTime() - options.olderThanMs;
  const dir = join(root, '.agents', 'send-drops', session, seat);
  const scan: ArchiveScan = { move: [], stays: [], scanned: 0 };
  if (!realDir(dir)) return scan;
  for (const name of readdirSync(dir).sort()) {
    if (name.includes('.') || !RECORD_NAME.test(name) || name.startsWith(WORK_PREFIX)) continue;
    const path = join(dir, name);
    if (!regularFile(path)) continue;
    scan.scanned += 1;
    const parsed = parsedFile(path);
    if (parsed === undefined) {
      // A body file written before the record spine is plain text where the record would be. No
      // reader serves it and no receipt acknowledges it; it is moved alone, never beside a family.
      const newest = newestMtime([path]);
      if (newest === null) {
        stay(scan, name, 'unknown-age');
        continue;
      }
      if (newest > cutoff) {
        stay(scan, name, 'too-recent');
        continue;
      }
      scan.move.push({ store: 'send-drops', seat, id: name, dir, files: [name], newest, bytes: sizeOf(path) });
      continue;
    }
    const auth = authOf(parsed, key);
    if (auth.kind !== 'ok') {
      stay(scan, name, 'record-does-not-verify');
      continue;
    }
    const payload = auth.value.payload;
    if (payload.id !== name || payload.to !== seat || payload.session !== session || !sameFolder(payload.root, root)) {
      stay(scan, name, 'not-this-seat-or-checkout');
      continue;
    }
    if (isGeneralBriefRecord(payload)) {
      stay(scan, name, 'general-brief');
      continue;
    }
    if (isClientRecord(payload)) {
      stay(scan, name, 'client-record');
      continue;
    }
    if (anything(join(dir, `${name}.pending`)) || anything(join(dir, `${name}.taken`))) {
      stay(scan, name, 'pending-or-taken');
      continue;
    }
    const files = familyFiles(dir, name);
    const newest = newestMtime(files.map((file) => join(dir, file)));
    if (newest === null) {
      stay(scan, name, 'unknown-age');
      continue;
    }
    if (newest > cutoff) {
      stay(scan, name, 'too-recent');
      continue;
    }
    // A lead's clearance settles the family exactly as the seat's own read does: it is eligible
    // to move, and its clearance receipt travels with it.
    if (!isReadOrCleared(dir, name, context, key)) {
      stay(scan, name, statusOf(dir, name, context, key) === 'delivered' ? 'delivered-only' : 'unread');
      continue;
    }
    scan.move.push({
      store: 'send-drops',
      seat,
      id: name,
      dir,
      files,
      newest,
      bytes: files.reduce((total, file) => total + sizeOf(join(dir, file)), 0),
    });
  }
  return scan;
}

/**
 * The older `.agents/messages` store, as the scoped archive sees it: a signed record, its signed
 * legacy receipt, and a family older than the window. The receipt moves first, as the procedure's
 * manual move does, so a crash leaves the record findable rather than a record with no proof.
 */
export function scanLegacySeat(options: {
  root: string;
  session: string;
  seat: string;
  key: KeyObject;
  olderThanMs: number;
  now: Date;
}): ArchiveScan {
  const { root, session, seat, key } = options;
  const cutoff = options.now.getTime() - options.olderThanMs;
  const dir = join(root, '.agents', 'messages', seat);
  const scan: ArchiveScan = { move: [], stays: [], scanned: 0 };
  if (!realDir(dir)) return scan;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json') || name.endsWith('.read.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!RECORD_NAME.test(id)) continue;
    const path = join(dir, name);
    if (!regularFile(path)) continue;
    scan.scanned += 1;
    const parsed = parsedFile(path);
    if (parsed === undefined) {
      stay(scan, id, 'not-a-record');
      continue;
    }
    const payload = messagePayload(parsed);
    if (
      payload === null ||
      payload.id !== id ||
      payload.to !== seat ||
      payload.session !== session ||
      !sameFolder(payload.root, root) ||
      (payload as { from_client?: unknown }).from_client !== undefined ||
      !verifyDomain(MESSAGE_DOMAIN, payload as unknown as Json, (parsed as { signature: string }).signature, key)
    ) {
      stay(scan, id, 'record-does-not-verify');
      continue;
    }
    // The older store's payload carries no `rule` in its type; a brief the launch wrote there
    // still carries the rule it was admitted by, so the same pair is read from the raw payload.
    if (payload.from === GENERAL_BRIEF_FROM && (payload as { rule?: string }).rule === GENERAL_BRIEF_RULE) {
      stay(scan, id, 'general-brief');
      continue;
    }
    const files = [`${id}.read.json`, name].filter((candidate) => regularFile(join(dir, candidate)));
    const newest = newestMtime(files.map((candidate) => join(dir, candidate)));
    if (newest === null) {
      stay(scan, id, 'unknown-age');
      continue;
    }
    if (newest > cutoff) {
      stay(scan, id, 'too-recent');
      continue;
    }
    if (!legacyReceiptMatches(join(dir, `${id}.read.json`), seat, id, root, session, key)) {
      stay(scan, id, 'unread');
      continue;
    }
    scan.move.push({
      store: 'messages',
      seat,
      id,
      dir,
      files,
      newest,
      bytes: files.reduce((total, candidate) => total + sizeOf(join(dir, candidate)), 0),
    });
  }
  return scan;
}

/** Where one family's files go: beside the tree they left, dated by the run's UTC day. */
function destinationOf(
  entry: Pick<PlannedMove, 'store' | 'seat'>,
  at: { agents: string; date: string; session: string },
): string {
  return entry.store === 'send-drops'
    ? join(at.agents, 'send-drops-archive', at.date, at.session, entry.seat)
    : join(at.agents, 'messages-archive', at.date, entry.seat);
}

/**
 * Moves one family, pre-checked whole before the first rename: every source readable and every
 * destination name free, so a refusal leaves the family where it is. The bytes are hashed for the
 * manifest as they are read. Record first for a transport family, receipt first for a legacy one.
 * A failure part way leaves what moved moved and reports the rest; the manifest then holds
 * exactly the files that moved.
 */
export function moveFamily(
  entry: PlannedMove,
  at: { root: string; agents: string; date: string; session: string },
): { moved: MovedFile[]; errors: string[] } {
  const destDir = destinationOf(entry, at);
  // The destination's new components are checked before the first write, one level at a time:
  // a link standing where a folder would be made is refused, never followed, so a family can
  // never land outside the checkout while the report names an in-root path.
  const folderProblem = ensureFoldersBelow(at.agents, [relative(at.agents, destDir)]);
  if (folderProblem !== null) return { moved: [], errors: [folderProblem] };
  for (const name of entry.files) {
    if (anything(join(destDir, name))) {
      const dest = relative(at.root, join(destDir, name));
      const source = relative(at.root, join(entry.dir, name));
      return { moved: [], errors: [`destination already holds ${dest}; ${source} is left in place`] };
    }
  }
  const hashed: { name: string; digest: string; bytes: number }[] = [];
  for (const name of entry.files) {
    try {
      const data = readRegular(join(entry.dir, name));
      hashed.push({ name, digest: createHash('sha256').update(data).digest('hex'), bytes: data.byteLength });
    } catch (error) {
      return { moved: [], errors: [`cannot read ${relative(at.root, join(entry.dir, name))}: ${messageOf(error)}`] };
    }
  }
  const moved: MovedFile[] = [];
  const errors: string[] = [];
  for (const held of hashed) {
    const source = join(entry.dir, held.name);
    const dest = join(destDir, held.name);
    try {
      renameSync(source, dest);
    } catch (error) {
      errors.push(`cannot move ${relative(at.root, source)}: ${messageOf(error)}`);
      break;
    }
    moved.push({ digest: held.digest, bytes: held.bytes, source: relative(at.root, source), dest: relative(at.root, dest) });
  }
  return { moved, errors };
}

/** One manifest name for this run, never an existing one: a second run in the same second gets
 *  its own file rather than overwriting the first run's record. */
export function manifestPath(agents: string, now: Date): string {
  const date = now.toISOString().slice(0, 10);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const folder = join(agents, 'archive-manifests', date);
  let path = join(folder, `manifest-${stamp}.tsv`);
  for (let n = 2; existsSync(path); n += 1) path = join(folder, `manifest-${stamp}-${String(n)}.tsv`);
  return path;
}

/** The record of the move: one header line, then one row per moved file — digest, bytes, source
 *  and destination, each relative to the checkout. Its folder is checked the same way the move's
 *  destination is, and the file is created, never followed: null when written, or the reason. */
export function writeManifest(path: string, header: string, moved: readonly MovedFile[], base: string): string | null {
  const folderProblem = ensureFoldersBelow(base, [relative(base, dirname(path))]);
  if (folderProblem !== null) return folderProblem;
  const rows = moved.map((file) => `${file.digest}\t${String(file.bytes)}\t${file.source}\t${file.dest}`);
  try {
    writeFileSync(path, `${[header, ...rows].join('\n')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    return `${path}: the manifest could not be written: ${messageOf(error)}`;
  }
  return null;
}
