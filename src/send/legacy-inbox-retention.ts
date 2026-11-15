// Moves settled mail out of the older `.agents/messages/<seat>` store, the one the runtime still
// writes its notices into (`evt-fallback-*`, `evt-work-*`, `evt-prompt-*`, `unread-*`). The rules
// are the drop archive's (src/send/inbox-retention.ts), in that store's own shape:
//
// - a record that verifies with this checkout's message key, for this session, whose signed read
//   receipt is older than seven days, moves to `<seat>/archive/<YYYY-MM>/`, the month of the
//   record's own `at`;
// - an unread record moves to `<seat>/archive/<YYYY-MM>/unread/` only when the caller says the
//   seat is at rest (stopped or retired) and the record is older than the caller's window;
// - a running seat's unread mail, a general brief, a client record, a record that does not verify
//   and anything that is not a record stay;
// - the owner's mailbox (`owner`) is never touched: its records are the watch's memory of what it
//   already told the owner, and a watch re-read from cursor 0 must still find them.
//
// Nothing is deleted. Each file is linked into the archive under a free name, then the live name
// is released only when it is the same file; the record leaves first, its receipt after, so a
// stopped move leaves either the whole family live, or the record archived with a stray receipt
// that the next pass finishes. A runtime writer that writes a record once per id asks
// `legacyArchivedRecordExists` too, so an archived notice is not written again.
import type { KeyObject } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
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

const ID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const READ_SUFFIX = '.read.json';

export type LegacyMove = { seat: string; id: string; month: string; unread?: true };

export type LegacyStayReason = 'unread' | 'too-recent' | 'record-does-not-verify' | 'other-session' | 'general-brief' | 'client-record';

export type LegacyPlan = {
  move: LegacyMove[];
  /** Live receipts whose record is already in the archive: a move a stopped pass left. */
  strays: { id: string; month: string; unread: boolean }[];
  stays: Record<LegacyStayReason, number>;
  scanned: number;
  more: boolean;
  last: string | null;
};

export type LegacyPlanOptions = {
  /** Unread records older than this move to `unread/`; null (a running seat) moves none. */
  unreadKeepMs: number | null;
  /** At most this many families move. */
  limit?: number;
  /** At most this many records are looked at. */
  scanLimit?: number;
  /** Look only at ids after this one (the daily pass's cursor). */
  after?: string;
};

/** `<root>/.agents/messages/<seat>`. */
export function legacySeatDir(root: string, seat: string): string {
  return join(root, '.agents', 'messages', seat);
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
    return readdirSync(archive).filter((name) => /^\d{4}-\d{2}$/.test(name)).sort();
  } catch {
    return [];
  }
}

/** Where an archived record of `id` sits, when one does: `{ month, unread }`. */
function archivedAt(dir: string, id: string, months: readonly string[]): { month: string; unread: boolean } | null {
  for (const month of months) {
    const monthDir = join(dir, DROP_MONTH_ARCHIVE, month);
    if (heldAt(join(monthDir, `${id}.json`)).kind === 'file') return { month, unread: false };
    if (heldAt(join(monthDir, DROP_ARCHIVE_UNREAD, `${id}.json`)).kind === 'file') return { month, unread: true };
  }
  return null;
}

/** Whether a record of `id` for `seat` is already in that seat's archive, read or unread. */
export function legacyArchivedRecordExists(root: string, seat: string, id: string): boolean {
  const dir = legacySeatDir(root, seat);
  return archivedAt(dir, id, archiveMonths(dir)) !== null;
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
    strays: [],
    stays: { unread: 0, 'too-recent': 0, 'record-does-not-verify': 0, 'other-session': 0, 'general-brief': 0, 'client-record': 0 },
    scanned: 0,
    more: false,
    last: null,
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
  const ids = names
    .filter((name) => name.endsWith('.json') && !name.endsWith(READ_SUFFIX) && !name.startsWith('.'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => ID_NAME.test(id) && (options.after === undefined || id > options.after))
    .sort();
  // A receipt whose record already left: finish that move before anything new.
  for (const name of names) {
    if (!name.endsWith(READ_SUFFIX) || name.startsWith('.')) continue;
    const id = name.slice(0, -READ_SUFFIX.length);
    if (!ID_NAME.test(id) || present.has(`${id}.json`)) continue;
    const where = archivedAt(dir, id, months);
    if (where !== null) plan.strays.push({ id, ...where });
  }
  for (const id of ids) {
    if (plan.move.length >= limit || plan.scanned >= scanLimit) {
      plan.more = true;
      break;
    }
    plan.scanned += 1;
    plan.last = id;
    const parsed = readJsonNoLink(join(dir, `${id}.json`));
    const payload = messagePayload(parsed);
    if (
      payload === null ||
      payload.id !== id ||
      payload.to !== seat ||
      !sameFolder(payload.root, root) ||
      !verifyDomain(MESSAGE_DOMAIN, payload as unknown as Json, (parsed as { signature: string }).signature, key)
    ) {
      plan.stays['record-does-not-verify'] += 1;
      continue;
    }
    if (payload.session !== session) {
      plan.stays['other-session'] += 1;
      continue;
    }
    if ((payload as { from_client?: unknown }).from_client !== undefined) {
      plan.stays['client-record'] += 1;
      continue;
    }
    if (payload.from === GENERAL_BRIEF_FROM && (payload as { rule?: string }).rule === GENERAL_BRIEF_RULE) {
      plan.stays['general-brief'] += 1;
      continue;
    }
    const month = archiveMonth(payload.at);
    if (month === null) {
      plan.stays['record-does-not-verify'] += 1;
      continue;
    }
    const receipt = join(dir, `${id}${READ_SUFFIX}`);
    if (present.has(`${id}${READ_SUFFIX}`)) {
      if (!legacyReceiptMatches(receipt, seat, id, root, session, key)) {
        // A receipt that is not this record's proof: neither read nor plainly unread; it stays.
        plan.stays['record-does-not-verify'] += 1;
        continue;
      }
      const readMs = receiptAt(receipt);
      if (Number.isFinite(readMs) && nowMs - readMs > INBOX_READ_KEEP_MS) plan.move.push({ seat, id, month });
      else plan.stays['too-recent'] += 1;
      continue;
    }
    const sentMs = Date.parse(payload.at);
    if (options.unreadKeepMs !== null && Number.isFinite(sentMs) && nowMs - sentMs > options.unreadKeepMs) {
      plan.move.push({ seat, id, month, unread: true });
    } else {
      plan.stays.unread += 1;
    }
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

/** Links `from` to the free name `to`; already there as the same file counts as done. */
function place(from: string, to: string): string | null {
  const src = heldAt(from).kind;
  const dest = heldAt(to).kind;
  if (src === 'link' || dest === 'link') return 'a link was not followed';
  if (src === 'missing') return dest === 'file' ? null : 'is missing';
  if (src !== 'file') return 'is not a file';
  if (dest === 'file') return sameInode(from, to) ? null : 'is already in the archive';
  if (dest !== 'missing') return 'is not a free name in the archive';
  try {
    linkSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return sameInode(from, to) ? null : 'is already in the archive';
    return 'could not be placed';
  }
  return null;
}

/** Releases the live name only when the archive holds the same file. */
function release(from: string, to: string): string | null {
  if (heldAt(from).kind === 'missing') return null;
  if (!sameInode(from, to)) return 'the archive copy is not this file';
  try {
    unlinkSync(from);
  } catch {
    return 'could not leave the live folder';
  }
  return null;
}

function destOf(dir: string, month: string, unread: boolean): string | null {
  const archive = join(dir, DROP_MONTH_ARCHIVE);
  const monthDir = join(archive, month);
  const dest = unread ? join(monthDir, DROP_ARCHIVE_UNREAD) : monthDir;
  if (heldAt(archive).kind === 'link' || heldAt(monthDir).kind === 'link') return null;
  try {
    mkdirSync(dest, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  return heldAt(monthDir).kind === 'folder' && heldAt(dest).kind === 'folder' ? dest : null;
}

/** Moves one family: record first, its receipt after. Returns the problem, or null. */
function moveLegacyFamily(dir: string, move: LegacyMove): string | null {
  const dest = destOf(dir, move.month, move.unread === true);
  if (dest === null) return `${move.id}: the archive folder is not a plain folder`;
  const files = [`${move.id}.json`, ...(move.unread === true ? [] : [`${move.id}${READ_SUFFIX}`])];
  for (const name of files) {
    const problem = place(join(dir, name), join(dest, name));
    if (problem !== null) return `${move.id}: ${name} ${problem}`;
  }
  for (const name of files) {
    const problem = release(join(dir, name), join(dest, name));
    if (problem !== null) return `${move.id}: ${name} ${problem}`;
  }
  return null;
}

export type LegacyArchiveReport = {
  dryRun: boolean;
  plan: LegacyPlan;
  moved: LegacyMove[];
  finished: number;
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
}): LegacyArchiveReport {
  const plan = planLegacySeatArchive({ ...input, nowMs: input.now.getTime() });
  const report: LegacyArchiveReport = { dryRun: input.dryRun, plan, moved: [], finished: 0, refused: null };
  if (input.dryRun) return report;
  const dir = legacySeatDir(input.root, input.seat);
  for (const stray of plan.strays) {
    const dest = join(dir, DROP_MONTH_ARCHIVE, stray.month, ...(stray.unread ? [DROP_ARCHIVE_UNREAD] : []));
    const name = `${stray.id}${READ_SUFFIX}`;
    const problem = place(join(dir, name), join(dest, name)) ?? release(join(dir, name), join(dest, name));
    if (problem !== null) {
      report.refused = `${stray.id}: ${name} ${problem}`;
      return report;
    }
    report.finished += 1;
  }
  for (const move of plan.move) {
    const problem = moveLegacyFamily(dir, move);
    if (problem !== null) {
      report.refused = problem;
      return report;
    }
    report.moved.push(move);
  }
  return report;
}
