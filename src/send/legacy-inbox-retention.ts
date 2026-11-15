// Moves settled mail out of the older `.agents/messages/<seat>` store, the one the runtime still
// writes its notices into (`evt-fallback-*`, `evt-work-*`, `evt-prompt-*`, `unread-*`). The rules
// are the drop archive's (src/send/inbox-retention.ts), in that store's own shape:
//
// - a record that verifies with this checkout's message key, for this session, whose signed read
//   receipt is older than seven days, moves to `<seat>/archive/<YYYY-MM>/`, the month of the
//   record's own `at`;
// - an unread runtime notice (sender `runtime`) moves to `<seat>/archive/<YYYY-MM>/unread/` once
//   it is older than fourteen days, for any seat: push already delivered it;
// - an unread record from a real sender moves there only when the caller says the seat is at
//   rest (stopped or retired) and the record is older than the caller's window;
// - a running seat's unread mail from a real sender, a general brief, a client record, a record
//   that does not verify and anything that is not a record stay;
// - the owner's mailbox (`owner`) is never touched: its records are the watch's memory of what it
//   already told the owner, and a watch re-read from cursor 0 must still find them.
//
// The writers of this store take no lock: a record is written to a temporary name and renamed
// onto the live name, and a reader writes its receipt the same way. So the archive never unlinks
// a live name. It claims a family first: the live record, then the live receipt, are renamed to
// `.<name>.claim`, a name no writer uses. A rename takes exactly the file that is there at that
// instant; a writer that renames a newer record onto the live name afterwards is left alone. The
// decision is then made again on the claimed files, so what moves is what was judged. A family
// judged to stay is linked back to its live names; when a writer has meanwhile put a newer file
// there, the older claimed one was replaced and goes to `archive/<YYYY-MM>/superseded/`. Only the
// claim names are ever unlinked, and only once the same file is in its place.
//
// Only one archiver works a mailbox, by design rather than by a lock protocol. The real move runs
// in the daemon's chores child for that root (one process per root), and inside it an in-process
// mutex keeps two calls off one mailbox. A manual `team drops archive` moves nothing here while
// the daemon serves the root (`daemonServesRoot`): it lists what is due and leaves it to the
// nightly pass. Only with no daemon may the manual run move, and then it is the one contender.
//
// The lock file `<seat>/.archiver.lock` (O_EXCL; pid, host, start time, boot) stays as the guard
// for the one remaining overlap: a chores child that died across a daemon restart. It is broken
// only when its pid is dead on this host or the machine booted since, never on age while its pid
// lives; a mailbox whose lock is held is skipped and reported busy. The holder checks the lock is
// still its own before every unit, so a claim seen by a holder belongs to a mover that stopped.
//
// Recovery (a claim a stopped pass left, a live receipt whose record is already archived) is
// bounded by the same limits as the moves, before them: every claim and every archive probe for
// a stray receipt is charged to the scan limit, a recovery cursor carries the place, and `more`
// stays set while any is left.
// Nothing is deleted. A runtime writer that writes a record once per id asks
// `legacyArchivedRecordExists`, which also sees a claimed record, so a notice is not written twice.
import type { KeyObject } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { hostname, uptime } from 'node:os';
import { daemonStateAlive, readDaemonState } from '../daemon/state.ts';
import { join } from 'node:path';
import { heldAt } from '../held.ts';
import { GENERAL_BRIEF_FROM, GENERAL_BRIEF_RULE } from '../launch/general-brief.ts';
import { MESSAGE_DOMAIN, verifyDomain, type Json } from '../store/keys.ts';
import { legacyReceiptMatches, messagePayload } from '../commands/messages.ts';
import { DROP_ARCHIVE_UNREAD, DROP_MONTH_ARCHIVE } from './drop-folder.ts';
import { archiveMonth, INBOX_READ_KEEP_MS } from './inbox-retention.ts';
import { sameFolder } from './record.ts';

/** The mailbox the owner's notices are kept in; never archived (see the header). */
export const LEGACY_OWNER_MAILBOX = 'owner';

/** The sender the runtime's own notices carry (`OWNER_RECORD_FROM` in src/bus/owner.ts). */
export const RUNTIME_SENDER = 'runtime';

/** An unread runtime notice moves to `unread/` after this, whatever the seat's state. */
export const RUNTIME_UNREAD_KEEP_MS = 14 * 86_400_000;

/** Where a claimed file that a writer replaced meanwhile goes, under `archive/<YYYY-MM>/`. */
export const LEGACY_SUPERSEDED = 'superseded';

const ID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const MONTH = /^\d{4}-\d{2}$/;
const RECORD_SUFFIX = '.json';
const READ_SUFFIX = '.read.json';
const CLAIM_SUFFIX = '.claim';

export type LegacyMove = { seat: string; id: string; month: string; unread?: true };

export type LegacyStayReason = 'unread' | 'too-recent' | 'record-does-not-verify' | 'other-session' | 'general-brief' | 'client-record';

/** Work a stopped pass left: a claimed record (with or without its claimed receipt), a claimed
 *  receipt alone, or a live receipt whose record is already in the archive. */
export type LegacyRecovery =
  | { kind: 'claim'; id: string }
  | { kind: 'receipt-claim'; id: string }
  | { kind: 'stray'; id: string; month: string; unread: boolean };

export type LegacyPlan = {
  move: LegacyMove[];
  recovery: LegacyRecovery[];
  stays: Record<LegacyStayReason, number>;
  /** Records looked at plus recovery candidates looked at (each claim, each archive probe). */
  scanned: number;
  more: boolean;
  last: string | null;
  /** The last name recovery discovery looked at, when it stopped part way. */
  recoveryLast: string | null;
  /** Recovery discovery reached the end of the folder (or was skipped). */
  recoveryDone: boolean;
};

export type LegacyPlanOptions = {
  /** Unread mail from a real sender older than this moves to `unread/`; null (a running seat)
   *  moves none. Runtime notices follow `RUNTIME_UNREAD_KEEP_MS` whatever this says. */
  unreadKeepMs: number | null;
  /** At most this many families move, recovery units counted first. */
  limit?: number;
  /** At most this many records and recovery units are looked at. */
  scanLimit?: number;
  /** Look only at ids after this one (the daily pass's cursor). */
  after?: string;
  /** Recovery discovery resumes after this folder name (the daily pass's recovery cursor). */
  recoveryAfter?: string;
  /** Recovery discovery was finished earlier today for this mailbox. */
  skipRecovery?: boolean;
};

/** Points a test can act at, between the steps of one move. */
export type LegacyMoveHooks = {
  beforeClaim?: (id: string) => void;
  afterClaim?: (id: string) => void;
};

/** Mailbox folders this process is archiving now: a second call in the same process waits its
 *  turn as busy, never as a second archiver. */
const inProcess = new Set<string>();

/** Whether a running daemon serves `root`, so its chores child is the store's one archiver. An
 *  unreadable daemon record counts as serving: a manual run then moves nothing, which is safe. */
export function daemonServesRoot(home: string, root: string): boolean {
  const read = readDaemonState(home);
  if (read.kind === 'missing') return false;
  if (read.kind === 'unreadable') return true;
  if (!daemonStateAlive(read.state)) return false;
  return read.state.roots.some((entry) => sameFolder(entry.root, root));
}

/** The archiver lock's name in a seat's mailbox folder. */
export const LEGACY_ARCHIVER_LOCK = '.archiver.lock';

/** A lock file with no readable holder this long after it was made is a crash's leftover. */
const LOCK_UNWRITTEN_MS = 60_000;

/** How far two readings of the boot instant may differ and still be the same boot. */
const BOOT_SLACK_MS = 120_000;

type LockHolder = { pid: number; host: string; started: string; boot: string; token: string };

/** The machine's boot instant, to the second: now less the uptime. */
export function bootInstant(): string {
  return new Date(Math.round((Date.now() - uptime() * 1000) / 1000) * 1000).toISOString();
}

function pidLives(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolder(path: string): LockHolder | null {
  const parsed = readJsonNoLink(path) as Partial<LockHolder> | undefined;
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return null;
  if (typeof parsed.pid !== 'number' || typeof parsed.host !== 'string' || typeof parsed.boot !== 'string' || typeof parsed.token !== 'string') return null;
  return parsed as LockHolder;
}

/** Whether a lock may be broken: its pid is dead on this host, or this host booted since. A lock
 *  from another host, or a live pid of this boot, is never stale, whatever its age. */
function lockStale(path: string, holder: LockHolder | null, deps: LockDeps): boolean {
  if (holder === null) {
    try {
      return Date.now() - lstatSync(path).mtimeMs > LOCK_UNWRITTEN_MS;
    } catch {
      return false;
    }
  }
  if (holder.host !== deps.host) return false;
  const was = Date.parse(holder.boot);
  const now = Date.parse(deps.boot);
  if (!Number.isFinite(was) || !Number.isFinite(now) || Math.abs(was - now) > BOOT_SLACK_MS) return true;
  return !deps.alive(holder.pid);
}

/** What the lock reads of the machine; a test swaps them. */
export type LockDeps = { pid: number; host: string; boot: string; alive: (pid: number) => boolean };

export const realLockDeps = (): LockDeps => ({ pid: process.pid, host: hostname(), boot: bootInstant(), alive: pidLives });

export type ArchiverLock = { kind: 'held'; path: string; token: string; still: () => boolean; release: () => void } | { kind: 'busy'; holder: string };

function create(path: string, deps: LockDeps): ArchiverLock | 'exists' | string {
  const holder: LockHolder = { pid: deps.pid, host: deps.host, started: new Date().toISOString(), boot: deps.boot, token: randomBytes(12).toString('hex') };
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'the archiver lock could not be made';
  }
  try {
    writeSync(fd, `${JSON.stringify(holder)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const still = (): boolean => readHolder(path)?.token === holder.token;
  return {
    kind: 'held',
    path,
    token: holder.token,
    still,
    release: () => {
      if (!still()) return;
      try {
        unlinkSync(path);
      } catch {
        // Already gone; the next archiver makes its own.
      }
    },
  };
}

function describeHolder(holder: LockHolder | null): string {
  return holder === null ? 'an archiver whose lock is still being written' : `pid ${String(holder.pid)} on ${holder.host} since ${holder.started}`;
}

/** Takes the mailbox's archiver lock, breaking it once when its holder is provably gone. */
export function takeArchiverLock(dir: string, deps: LockDeps = realLockDeps()): ArchiverLock | { kind: 'refused'; why: string } {
  const path = join(dir, LEGACY_ARCHIVER_LOCK);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (heldAt(path).kind === 'link') return { kind: 'refused', why: 'the archiver lock is a link' };
    const made = create(path, deps);
    if (typeof made === 'object') return made;
    if (made !== 'exists') return { kind: 'refused', why: made };
    const holder = readHolder(path);
    if (attempt === 1 || !lockStale(path, holder, deps)) return { kind: 'busy', holder: describeHolder(holder) };
    // Move the stale lock aside (only one breaker can), then check it is the one judged stale: a
    // fresh lock taken in between is put back, and its holder keeps it.
    const aside = join(dir, `${LEGACY_ARCHIVER_LOCK}.broken.${randomBytes(6).toString('hex')}`);
    try {
      renameSync(path, aside);
    } catch {
      continue;
    }
    const moved = readHolder(aside);
    const same = holder === null ? moved === null : moved?.token === holder.token;
    if (!same) {
      try {
        linkSync(aside, path);
        unlinkSync(aside);
      } catch {
        // Another lock was taken meanwhile; the one moved aside fails its holder's next check.
      }
      return { kind: 'busy', holder: describeHolder(moved) };
    }
    try {
      unlinkSync(aside);
    } catch {
      // A lock file, not mail; a leftover name is harmless.
    }
  }
  return { kind: 'busy', holder: 'another archiver' };
}

type Judge = {
  root: string;
  session: string;
  seat: string;
  key: KeyObject;
  nowMs: number;
  unreadKeepMs: number | null;
};

type Verdict = { kind: 'move'; month: string; unread: boolean } | { kind: 'stay'; reason: LegacyStayReason; month: string | null };

/** `<root>/.agents/messages/<seat>`. */
export function legacySeatDir(root: string, seat: string): string {
  return join(root, '.agents', 'messages', seat);
}

function claimName(name: string): string {
  return `.${name}${CLAIM_SUFFIX}`;
}

/** The seat folders of the older store, `owner` left out, plain folders only. */
export function legacySeatFolders(root: string): { seat: string; dir: string }[] {
  const base = join(root, '.agents', 'messages');
  if (heldAt(base).kind !== 'folder') return [];
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  return names
    .filter((seat) => !seat.startsWith('.') && seat !== LEGACY_OWNER_MAILBOX && ID_NAME.test(seat))
    .sort()
    .map((seat) => ({ seat, dir: join(base, seat) }))
    .filter((folder) => heldAt(folder.dir).kind === 'folder');
}

function archiveMonths(dir: string): string[] {
  const archive = join(dir, DROP_MONTH_ARCHIVE);
  if (heldAt(archive).kind !== 'folder') return [];
  try {
    return readdirSync(archive).filter((name) => MONTH.test(name)).sort();
  } catch {
    return [];
  }
}

/** Where an archived record of `id` sits, when one does: `{ month, unread }`. */
function archivedAt(dir: string, id: string, months: readonly string[]): { month: string; unread: boolean } | null {
  for (const month of months) {
    const monthDir = join(dir, DROP_MONTH_ARCHIVE, month);
    if (heldAt(join(monthDir, `${id}${RECORD_SUFFIX}`)).kind === 'file') return { month, unread: false };
    if (heldAt(join(monthDir, DROP_ARCHIVE_UNREAD, `${id}${RECORD_SUFFIX}`)).kind === 'file') return { month, unread: true };
  }
  return null;
}

/** Whether a record of `id` for `seat` is archived, read or unread, or claimed by a move now. */
export function legacyArchivedRecordExists(root: string, seat: string, id: string): boolean {
  const dir = legacySeatDir(root, seat);
  if (heldAt(join(dir, claimName(`${id}${RECORD_SUFFIX}`))).kind === 'file') return true;
  return archivedAt(dir, id, archiveMonths(dir)) !== null;
}

export type LegacyArchivedUnread = { seat: string; id: string; month: string; path: string };

/** The records in `<seat>/archive/<YYYY-MM>/unread/`, oldest month first, by folder names only.
 *  An id may hold dots; the `.json` suffix is what names the record, `.read.json` is a receipt. */
export function listLegacyArchivedUnread(root: string, seat: string): LegacyArchivedUnread[] {
  const dir = legacySeatDir(root, seat);
  const out: LegacyArchivedUnread[] = [];
  for (const month of archiveMonths(dir)) {
    const monthDir = join(dir, DROP_MONTH_ARCHIVE, month);
    if (heldAt(monthDir).kind !== 'folder') continue;
    const unreadDir = join(monthDir, DROP_ARCHIVE_UNREAD);
    if (heldAt(unreadDir).kind !== 'folder') continue;
    let names: string[];
    try {
      names = readdirSync(unreadDir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.') || !name.endsWith(RECORD_SUFFIX) || name.endsWith(READ_SUFFIX)) continue;
      const id = name.slice(0, -RECORD_SUFFIX.length);
      if (!ID_NAME.test(id) || heldAt(join(unreadDir, name)).kind !== 'file') continue;
      out.push({ seat, id, month, path: join(unreadDir, name) });
    }
  }
  return out;
}

function readJsonNoLink(path: string): unknown {
  if (heldAt(path).kind !== 'file') return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function receiptAt(path: string): number {
  const parsed = readJsonNoLink(path) as { payload?: { at?: unknown } } | undefined;
  const at = parsed?.payload?.at;
  return typeof at === 'string' ? Date.parse(at) : Number.NaN;
}

/** The rules of the header, on one record file and its receipt file (null: none). */
function judge(j: Judge, id: string, recordPath: string, receiptPath: string | null): Verdict {
  const parsed = readJsonNoLink(recordPath);
  const payload = messagePayload(parsed);
  if (
    payload === null ||
    payload.id !== id ||
    payload.to !== j.seat ||
    !sameFolder(payload.root, j.root) ||
    !verifyDomain(MESSAGE_DOMAIN, payload as unknown as Json, (parsed as { signature: string }).signature, j.key)
  ) {
    return { kind: 'stay', reason: 'record-does-not-verify', month: null };
  }
  const month = archiveMonth(payload.at);
  if (payload.session !== j.session) return { kind: 'stay', reason: 'other-session', month };
  if ((payload as { from_client?: unknown }).from_client !== undefined) return { kind: 'stay', reason: 'client-record', month };
  if (payload.from === GENERAL_BRIEF_FROM && (payload as { rule?: string }).rule === GENERAL_BRIEF_RULE) {
    return { kind: 'stay', reason: 'general-brief', month };
  }
  if (month === null) return { kind: 'stay', reason: 'record-does-not-verify', month };
  if (receiptPath !== null) {
    // A receipt that is not this record's proof: neither read nor plainly unread; it stays.
    if (!legacyReceiptMatches(receiptPath, j.seat, id, j.root, j.session, j.key)) return { kind: 'stay', reason: 'record-does-not-verify', month };
    const readMs = receiptAt(receiptPath);
    return Number.isFinite(readMs) && j.nowMs - readMs > INBOX_READ_KEEP_MS
      ? { kind: 'move', month, unread: false }
      : { kind: 'stay', reason: 'too-recent', month };
  }
  const sentMs = Date.parse(payload.at);
  // A runtime notice was already delivered by push; it ages out after fourteen days even for a
  // running seat. Mail from a real sender keeps the caller's rule.
  const keepMs = payload.from === RUNTIME_SENDER ? RUNTIME_UNREAD_KEEP_MS : j.unreadKeepMs;
  if (keepMs !== null && Number.isFinite(sentMs) && j.nowMs - sentMs > keepMs) return { kind: 'move', month, unread: true };
  return { kind: 'stay', reason: 'unread', month };
}

/** What of one seat's older-store mail is due, by the rules in the header. Reads only. */
export function planLegacySeatArchive(input: {
  root: string;
  session: string;
  seat: string;
  key: KeyObject;
  nowMs: number;
  options: LegacyPlanOptions;
}): LegacyPlan {
  const { root, session, seat, key, nowMs, options } = input;
  const dir = legacySeatDir(root, seat);
  const plan: LegacyPlan = {
    move: [],
    recovery: [],
    stays: { unread: 0, 'too-recent': 0, 'record-does-not-verify': 0, 'other-session': 0, 'general-brief': 0, 'client-record': 0 },
    scanned: 0,
    more: false,
    last: null,
    recoveryLast: null,
    recoveryDone: options.skipRecovery === true,
  };
  if (seat === LEGACY_OWNER_MAILBOX || heldAt(dir).kind !== 'folder') return plan;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return plan;
  }
  const present = new Set(names);
  const months = archiveMonths(dir);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const scanLimit = options.scanLimit ?? Number.POSITIVE_INFINITY;
  const full = (): boolean => plan.move.length + plan.recovery.length >= limit || plan.scanned >= scanLimit;

  // 1. Recovery first, inside the same limits. The listing is read once; each claim and each
  //    archive probe for a stray receipt is charged to the scan limit, from the recovery cursor.
  if (options.skipRecovery !== true) {
    for (const name of [...names].sort()) {
      if (options.recoveryAfter !== undefined && name <= options.recoveryAfter) continue;
      let unit: (() => LegacyRecovery | null) | null = null;
      if (name.startsWith('.') && name.endsWith(CLAIM_SUFFIX)) {
        const inner = name.slice(1, -CLAIM_SUFFIX.length);
        if (inner.endsWith(READ_SUFFIX)) {
          const id = inner.slice(0, -READ_SUFFIX.length);
          // A claimed receipt beside its claimed record is recovered with the record.
          if (ID_NAME.test(id) && !present.has(claimName(`${id}${RECORD_SUFFIX}`))) unit = () => ({ kind: 'receipt-claim', id });
        } else if (inner.endsWith(RECORD_SUFFIX)) {
          const id = inner.slice(0, -RECORD_SUFFIX.length);
          if (ID_NAME.test(id)) unit = () => ({ kind: 'claim', id });
        }
      } else if (!name.startsWith('.') && name.endsWith(READ_SUFFIX)) {
        const id = name.slice(0, -READ_SUFFIX.length);
        if (ID_NAME.test(id) && !present.has(`${id}${RECORD_SUFFIX}`) && !present.has(claimName(`${id}${RECORD_SUFFIX}`))) {
          unit = () => {
            const where = archivedAt(dir, id, months);
            return where === null ? null : { kind: 'stray', id, ...where };
          };
        }
      }
      if (unit === null) continue;
      if (full()) {
        plan.more = true;
        return plan;
      }
      plan.scanned += 1;
      plan.recoveryLast = name;
      const found = unit();
      if (found !== null) plan.recovery.push(found);
    }
    plan.recoveryDone = true;
    plan.recoveryLast = null;
  }

  // 2. The live records, from the cursor.
  const j: Judge = { root, session, seat, key, nowMs, unreadKeepMs: options.unreadKeepMs };
  const ids = names
    .filter((name) => name.endsWith(RECORD_SUFFIX) && !name.endsWith(READ_SUFFIX) && !name.startsWith('.'))
    .map((name) => name.slice(0, -RECORD_SUFFIX.length))
    .filter((id) => ID_NAME.test(id) && (options.after === undefined || id > options.after))
    .sort();
  for (const id of ids) {
    if (full()) {
      plan.more = true;
      break;
    }
    plan.scanned += 1;
    plan.last = id;
    const receipt = present.has(`${id}${READ_SUFFIX}`) ? join(dir, `${id}${READ_SUFFIX}`) : null;
    const verdict = judge(j, id, join(dir, `${id}${RECORD_SUFFIX}`), receipt);
    if (verdict.kind === 'move') plan.move.push({ seat, id, month: verdict.month, ...(verdict.unread ? { unread: true as const } : {}) });
    else plan.stays[verdict.reason] += 1;
  }
  return plan;
}

function sameInode(left: string, right: string): boolean {
  try {
    const a = lstatSync(left);
    const b = lstatSync(right);
    return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/** Renames the live file to its claim name. 'none': nothing plain was there to claim. */
function claim(dir: string, name: string): 'claimed' | 'none' | string {
  const live = join(dir, name);
  const claimed = join(dir, claimName(name));
  if (heldAt(claimed).kind !== 'missing') return `${name}: a claim is already there`;
  if (heldAt(live).kind !== 'file') return 'none';
  try {
    renameSync(live, claimed);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : `${name}: could not be claimed`;
  }
  // A rename takes whatever is at the name; a link swapped in between the look and the rename is
  // put back where it was found.
  if (heldAt(claimed).kind !== 'file') {
    try {
      renameSync(claimed, live);
    } catch {
      // Left under the claim name; the next pass's recovery reports it.
    }
    return 'none';
  }
  return 'claimed';
}

/** Links the claimed file to `to` (a free name, or the same file already) and drops the claim
 *  name. Only the claim name is ever unlinked. */
function settle(claimed: string, to: string): 'placed' | 'taken' | string {
  if (heldAt(claimed).kind !== 'file') return heldAt(to).kind === 'file' ? 'placed' : 'the claimed file is missing';
  const dest = heldAt(to).kind;
  if (dest === 'link') return 'a link was not followed';
  if (dest === 'file' && !sameInode(claimed, to)) return 'taken';
  if (dest === 'missing') {
    try {
      linkSync(claimed, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        if (!sameInode(claimed, to)) return 'taken';
      } else {
        return 'could not be placed';
      }
    }
  } else if (dest !== 'file') {
    return 'is not a free name';
  }
  try {
    unlinkSync(claimed);
  } catch {
    return 'the claim name could not be dropped';
  }
  return 'placed';
}

function folderBelow(dir: string, month: string, leaf: string | null): string | null {
  const archive = join(dir, DROP_MONTH_ARCHIVE);
  const monthDir = join(archive, month);
  const dest = leaf === null ? monthDir : join(monthDir, leaf);
  if (heldAt(archive).kind === 'link' || heldAt(monthDir).kind === 'link') return null;
  try {
    mkdirSync(dest, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  return heldAt(monthDir).kind === 'folder' && heldAt(dest).kind === 'folder' ? dest : null;
}

function nowMonth(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

/** Puts a claimed file back on its live name; a newer file there means ours was replaced, and it
 *  goes to `superseded/` under a free name. */
function putBack(dir: string, name: string, month: string): string | null {
  const claimed = join(dir, claimName(name));
  if (heldAt(claimed).kind === 'missing') return null;
  const back = settle(claimed, join(dir, name));
  if (back === 'placed') return null;
  if (back !== 'taken') return `${name}: ${back}`;
  const superseded = folderBelow(dir, month, LEGACY_SUPERSEDED);
  if (superseded === null) return `${name}: the superseded folder is not a plain folder`;
  for (let n = 0; n < 10; n += 1) {
    const out = settle(claimed, join(superseded, n === 0 ? name : `${name}.${String(n)}`));
    if (out === 'placed') return null;
    if (out !== 'taken') return `${name}: ${out}`;
  }
  return `${name}: no free name in superseded/`;
}

type MoveOutcome = { kind: 'moved'; move: LegacyMove } | { kind: 'stayed' } | { kind: 'gone' } | { kind: 'refused'; why: string };

/** Claims one family, judges the claimed files again, and moves or puts back what it holds. */
function moveClaimed(dir: string, j: Judge, id: string, hooks: LegacyMoveHooks | undefined, alreadyClaimed: boolean): MoveOutcome {
  const recordName = `${id}${RECORD_SUFFIX}`;
  const receiptName = `${id}${READ_SUFFIX}`;
  if (!alreadyClaimed) {
    hooks?.beforeClaim?.(id);
    const took = claim(dir, recordName);
    if (took === 'none') return { kind: 'gone' };
    if (took !== 'claimed') return { kind: 'refused', why: took };
  }
  hooks?.afterClaim?.(id);
  // The receipt is claimed after the record: a reader no longer finds the live record, so no new
  // receipt is written for it while it is claimed. A receipt claimed by a stopped pass is kept.
  if (heldAt(join(dir, claimName(receiptName))).kind === 'missing') {
    const tookReceipt = claim(dir, receiptName);
    if (tookReceipt !== 'claimed' && tookReceipt !== 'none') return { kind: 'refused', why: tookReceipt };
  }
  const recordClaim = join(dir, claimName(recordName));
  const receiptClaim = join(dir, claimName(receiptName));
  const hasReceipt = heldAt(receiptClaim).kind === 'file';
  const verdict = judge(j, id, recordClaim, hasReceipt ? receiptClaim : null);
  const month = verdict.month ?? nowMonth(j.nowMs);
  if (verdict.kind === 'stay') {
    const problem = putBack(dir, recordName, month) ?? putBack(dir, receiptName, month);
    return problem === null ? { kind: 'stayed' } : { kind: 'refused', why: `${id}: ${problem}` };
  }
  const dest = folderBelow(dir, verdict.month, verdict.unread ? DROP_ARCHIVE_UNREAD : null);
  if (dest === null) {
    const problem = putBack(dir, recordName, month) ?? putBack(dir, receiptName, month);
    return { kind: 'refused', why: `${id}: the archive folder is not a plain folder${problem === null ? '' : `; ${problem}`}` };
  }
  for (const name of [recordName, ...(hasReceipt ? [receiptName] : [])]) {
    const out = settle(join(dir, claimName(name)), join(dest, name));
    if (out === 'taken') {
      const problem = putBack(dir, recordName, month) ?? putBack(dir, receiptName, month);
      return { kind: 'refused', why: `${id}: ${name} is already in the archive${problem === null ? '' : `; ${problem}`}` };
    }
    if (out !== 'placed') return { kind: 'refused', why: `${id}: ${name} ${out}` };
  }
  return { kind: 'moved', move: { seat: j.seat, id, month: verdict.month, ...(verdict.unread ? { unread: true as const } : {}) } };
}

/** Finishes one unit of recovery. */
function recover(dir: string, j: Judge, item: LegacyRecovery): string | null {
  const receiptName = `${item.id}${READ_SUFFIX}`;
  if (item.kind === 'claim') {
    const out = moveClaimed(dir, j, item.id, undefined, true);
    return out.kind === 'refused' ? out.why : null;
  }
  if (item.kind === 'receipt-claim') {
    // Its record is gone from both live and claim names: the receipt goes back to where it was.
    return putBack(dir, receiptName, nowMonth(j.nowMs));
  }
  const dest = join(dir, DROP_MONTH_ARCHIVE, item.month, ...(item.unread ? [DROP_ARCHIVE_UNREAD] : []));
  const took = claim(dir, receiptName);
  if (took === 'none') return null;
  if (took !== 'claimed') return took;
  const out = settle(join(dir, claimName(receiptName)), join(dest, receiptName));
  if (out === 'placed') return null;
  if (out === 'taken') return putBack(dir, receiptName, item.month);
  return `${item.id}: ${receiptName} ${out}`;
}

export type LegacyArchiveReport = {
  dryRun: boolean;
  plan: LegacyPlan;
  moved: LegacyMove[];
  /** Recovery units finished. */
  finished: number;
  /** Planned families that, judged again on the claimed files, stayed or were already gone. */
  kept: number;
  /** Another archiver holds this mailbox: nothing was done, and the pass should come back. */
  busy: string | null;
  refused: string | null;
};

/** Plans one seat's older-store archive and, unless `dryRun`, carries it out. */
export function archiveLegacySeat(input: {
  root: string;
  session: string;
  seat: string;
  key: KeyObject;
  now: Date;
  dryRun: boolean;
  options: LegacyPlanOptions;
  hooks?: LegacyMoveHooks;
  lockDeps?: LockDeps;
}): LegacyArchiveReport {
  const nowMs = input.now.getTime();
  const dir = legacySeatDir(input.root, input.seat);
  if (input.dryRun) {
    const plan = planLegacySeatArchive({ ...input, nowMs });
    return { dryRun: true, plan, moved: [], finished: 0, kept: 0, busy: null, refused: null };
  }
  const empty = planLegacySeatArchive({ ...input, nowMs, options: { ...input.options, limit: 0, skipRecovery: true } });
  if (input.seat === LEGACY_OWNER_MAILBOX || heldAt(dir).kind !== 'folder') {
    return { dryRun: false, plan: { ...empty, more: false }, moved: [], finished: 0, kept: 0, busy: null, refused: null };
  }
  if (inProcess.has(dir)) {
    return { dryRun: false, plan: { ...empty, more: true }, moved: [], finished: 0, kept: 0, busy: 'this process is archiving it', refused: null };
  }
  inProcess.add(dir);
  try {
    const lock = takeArchiverLock(dir, input.lockDeps);
    if (lock.kind === 'busy') return { dryRun: false, plan: { ...empty, more: true }, moved: [], finished: 0, kept: 0, busy: lock.holder, refused: null };
    if (lock.kind === 'refused') return { dryRun: false, plan: { ...empty, more: false }, moved: [], finished: 0, kept: 0, busy: null, refused: `${input.seat}: ${lock.why}` };
    try {
      return archiveHeld(input, dir, nowMs, lock);
    } finally {
      lock.release();
    }
  } finally {
    inProcess.delete(dir);
  }
}

/** The real run, under the mailbox's lock: planned after the lock was taken, so every claim it
 *  sees was left by a mover that stopped. */
function archiveHeld(
  input: { root: string; session: string; seat: string; key: KeyObject; options: LegacyPlanOptions; hooks?: LegacyMoveHooks },
  dir: string,
  nowMs: number,
  lock: Extract<ArchiverLock, { kind: 'held' }>,
): LegacyArchiveReport {
  const plan = planLegacySeatArchive({ ...input, nowMs });
  const report: LegacyArchiveReport = { dryRun: false, plan, moved: [], finished: 0, kept: 0, busy: null, refused: null };
  const lost = (): boolean => {
    if (lock.still()) return false;
    report.busy = 'the archiver lock was taken over';
    report.plan.more = true;
    return true;
  };
  const j: Judge = { root: input.root, session: input.session, seat: input.seat, key: input.key, nowMs, unreadKeepMs: input.options.unreadKeepMs };
  for (const item of plan.recovery) {
    if (lost()) return report;
    const problem = recover(dir, j, item);
    if (problem !== null) {
      report.refused = problem;
      return report;
    }
    report.finished += 1;
  }
  for (const move of plan.move) {
    if (lost()) return report;
    const out = moveClaimed(dir, j, move.id, input.hooks, false);
    if (out.kind === 'refused') {
      report.refused = out.why;
      return report;
    }
    if (out.kind === 'moved') report.moved.push(out.move);
    else report.kept += 1;
  }
  return report;
}
