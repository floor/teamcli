// Moves settled inbox mail out of the live seat folder.
//
// A read and an acknowledgement are different. A read receipt — including one that names the
// channel, and one that names no reader — waits two days. An acknowledgement is separate
// evidence: the note `team ack` writes, a lead's clearance, or a reply. That moves at once.
// Unread mail stays. Nothing is deleted. Receipts are placed in
// `<root>/.agents/send-drops/<session>/<seat>/archive/<YYYY-MM>/` first and the record last,
// by a link that does not replace a file already there. A lookup by id still reads them there.
//
// The daemon's daily run (src/daemon/chores/inbox-archive.ts) uses the same moves, bounded per
// pass, and one more: mail still unread after fourteen days to a seat that is stopped or retired
// moves to `archive/<YYYY-MM>/unread/`. A running seat's unread mail is never moved.
//
// The one-time pass marks unread drops whose delivery receipt (or, failing that, read receipt)
// is older than the seat's channel start. The record's own sent time is not that proof. A dry
// run lists both sets and writes nothing. A real run writes one audit line, including a move
// that stopped part way.
import { hostedCommit } from '../host/request-scope.ts';
import { lstatSync, readdirSync } from 'node:fs';
import { linkSync, mkdirSync, unlinkSync } from '../host/guarded-fs.ts';
import { dirname, join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { readListener } from '../mcp/inbox.ts';
import { flushReceipt, publishReadReceipt } from '../mcp/inbox-admission.ts';
import { heldAt } from '../launch/rules-file.ts';
import { isGeneralBriefRecord } from '../launch/general-brief.ts';
import { logLine } from '../log.ts';
import { messageKeyState } from '../store/keys.ts';
import { DROP_ARCHIVE_UNREAD, DROP_MONTH_ARCHIVE, folderOfDrop } from './drop-folder.ts';
import { publishRecordRead } from './read-receipt.ts';
import {
  isLeadAckReadBy,
  isRead,
  isStampedPayload,
  readRecord,
  readVerifiedReceipt,
  sameFolder,
  signReceiptPayload,
  verifyRecord,
  type StatusContext,
} from './record.ts';
import { clearUnread } from './unread-hint.ts';
import { archiveLegacySeat, daemonServesRoot, legacySeatFolders } from './legacy-inbox-retention.ts';

/** `read_by` on the note `team ack` writes. A plain read receipt does not carry it. */
export const EXPLICIT_ACK_READ_BY = 'ack';

/** The note beside a record that `team ack` acknowledged, including one a channel had already read. */
export function ackNotePath(folder: string, id: string): string {
  return join(folder, `${id}.ack.json`);
}

/** A read receipt younger than this stays in the live folder unless the message was acknowledged.
 *  Two days, not seven: every pass of the watch and the inbox lists and stats the whole live
 *  folder, and on 2026-11-17 three quarters of a busy checkout's live mail (3,526 of 4,454 read
 *  records) was read two to seven days earlier. A moved message is still found by id, so
 *  `team reply`, `team show` and the receipts work on it as before. */
export const INBOX_READ_KEEP_MS = 2 * 86_400_000;
/** The older store keeps its seven days: it is listed, not scanned, on every pass. */
export const LEGACY_READ_KEEP_MS = 7 * 86_400_000;

const MONTH = /^(\d{4})-(\d{2})$/;
const ID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** One family to move. `unread` marks mail moved before it was read, from a seat at rest; it
 *  lands in `archive/<YYYY-MM>/unread/`. */
export type InboxArchiveMove = {
  seat: string; id: string; month: string; files: string[]; unread?: true;
  /** E7b: a stamped record moved unacknowledged because its seat is retired; its sender is told
   *  "not delivered: seat retired". */
  undelivered?: { from: string };
};

/** What a plan may take beyond the settled mail. */
export type InboxArchivePlanOptions = {
  /** Mark unread drops delivered before the channel started as read. The command does; the
   *  daemon's run does not, since that would speak for a seat's reading. Default true. */
  markPreChannel?: boolean;
  /** Move mail still unread when its signed `at` is older than this. Only for a seat the caller
   *  proved is stopped or retired; null or absent moves no unread mail. */
  unreadKeepMs?: number | null;
  /** E7b: the seat is retired or removed (no longer in the registry or the team file). Only then
   *  does an unacknowledged stamped record move, marked undelivered. Absent: it never moves. */
  retired?: boolean;
  /** The most families one plan takes (moves and marks together), orphans finished first
   *  included. Absent: no bound. */
  limit?: number;
  /** The most families one plan looks at. With it, families are taken in id order. */
  scanLimit?: number;
  /** Look only at families whose id sorts after this one (a cursor from an earlier call). */
  after?: string;
  /** Finish orphaned sidecars and crash temps before planning. Default true. */
  orphans?: boolean;
  /** The folder's families as `listSeatFamilies` read them once, so a caller that plans in
   *  chunks lists the folder once rather than every chunk. A family gone since is skipped. */
  families?: readonly SeatFamily[];
};
export type InboxArchiveMark = { seat: string; id: string };

export type InboxArchiveReport = {
  dryRun: boolean;
  move: InboxArchiveMove[];
  markRead: InboxArchiveMark[];
  /** Ids whose move or mark stopped before it finished. The files already placed stay. */
  partial: string[];
  refused: string | null;
  /** The plan stopped at a limit with families still to look at. */
  more?: boolean;
  /** How many families the plan looked at, and the id of the last one (null: none). */
  scanned?: number;
  last?: string | null;
};

/** The month folder a record's signed `at` belongs in, or null when `at` is not an instant. */
export function archiveMonth(at: string): string | null {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  const month = new Date(ms).toISOString().slice(0, 7);
  return MONTH.test(month) ? month : null;
}

type Family = { id: string; files: string[] };
export type SeatFamily = Family;

/** The folder's names as they stand now, by family id: one listing, no file read. A chunk that
 *  plans from an earlier listing checks each family against this, so a sidecar that joined since
 *  (a fallback note, a pending mark) is seen, and a name that left is not moved. */
export function currentNames(dropDir: string): Map<string, string[]> | null {
  let names: string[];
  try {
    names = readdirSync(dropDir);
  } catch {
    return null;
  }
  const byId = new Map<string, string[]>();
  for (const name of names) {
    if (name === DROP_MONTH_ARCHIVE || name.startsWith('.')) continue;
    const dot = name.indexOf('.');
    const id = dot < 0 ? name : name.slice(0, dot);
    const list = byId.get(id);
    if (list === undefined) byId.set(id, [name]);
    else list.push(name);
  }
  return byId;
}

/** The index of the first family whose id sorts after `after`. */
function firstAfter(families: readonly Family[], after: string): number {
  let lo = 0;
  let hi = families.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((families[mid] as Family).id <= after) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One seat folder's message families, in id order, or null when the folder cannot be read. */
export function listSeatFamilies(dropDir: string): SeatFamily[] | null {
  const families = familiesOf(dropDir);
  return families === null ? null : families.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function familiesOf(dropDir: string): Family[] | null {
  let names: string[];
  try {
    names = readdirSync(dropDir);
  } catch {
    return null;
  }
  const byId = new Map<string, string[]>();
  for (const name of names) {
    if (name === DROP_MONTH_ARCHIVE || name.startsWith('.')) continue;
    const dot = name.indexOf('.');
    const id = dot < 0 ? name : name.slice(0, dot);
    if (!ID_NAME.test(id)) continue;
    const list = byId.get(id);
    if (list === undefined) byId.set(id, [name]);
    else list.push(name);
  }
  return [...byId.entries()]
    .filter(([id, files]) => files.includes(id))
    .map(([id, files]) => ({ id, files: files.slice().sort() }));
}

function blocked(id: string, files: readonly string[]): boolean {
  return files.some((name) =>
    name === `${id}.pending`
    || name === `${id}.taken`
    || name === `${id}.fallback.json`
    || name.startsWith(`${id}.fallback-note-`),
  );
}

/**
 * What one seat folder would archive and what it would mark read. `channelStartMs` is the
 * listener's own time when that listener declared the channel; otherwise nothing is marked.
 */
export function planSeatArchive(
  dropDir: string,
  seat: string,
  context: StatusContext,
  key: KeyObject,
  nowMs: number,
  channelStartMs: number | null,
  options: InboxArchivePlanOptions = {},
): { move: InboxArchiveMove[]; markRead: InboxArchiveMark[]; more: boolean; scanned: number; last: string | null } | { refused: string } {
  const after = options.after;
  let families: readonly Family[];
  let from = 0;
  let fresh: Map<string, string[]> | null = null;
  if (options.families !== undefined) {
    // Sorted by `listSeatFamilies`: the cursor's place is found by a binary search, and the names
    // as they stand now are listed once for this call.
    fresh = currentNames(dropDir);
    if (fresh === null) return { refused: `${seat}: the drop folder cannot be read` };
    // Walked by index from the cursor's place: nothing past the chunk is copied.
    families = options.families;
    from = after === undefined ? 0 : firstAfter(options.families, after);
  } else {
    const listed = familiesOf(dropDir);
    if (listed === null) return { refused: `${seat}: the drop folder cannot be read` };
    const ordered = options.scanLimit !== undefined || after !== undefined;
    families = ordered
      ? listed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).filter((family) => after === undefined || family.id > after)
      : listed;
  }
  const scanLimit = options.scanLimit ?? Number.POSITIVE_INFINITY;
  let scanned = 0;
  let last: string | null = null;
  const move: InboxArchiveMove[] = [];
  const markRead: InboxArchiveMark[] = [];
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const unreadKeepMs = options.unreadKeepMs ?? null;
  const markPreChannel = options.markPreChannel !== false;
  let more = false;
  for (let index = from; index < families.length; index += 1) {
    const listedFamily = families[index] as Family;
    if (move.length + markRead.length >= limit || scanned >= scanLimit) {
      more = true;
      break;
    }
    scanned += 1;
    last = listedFamily.id;
    const nowFiles = fresh === null ? listedFamily.files : fresh.get(listedFamily.id);
    if (nowFiles === undefined) continue;
    const family: Family = { id: listedFamily.id, files: nowFiles.slice().sort() };
    if (!family.files.includes(family.id)) continue;
    if (blocked(family.id, family.files)) continue;
    const looked = readRecord(join(dropDir, family.id), family.id);
    if (!looked.ok || looked.record === null || !verifyRecord(looked.record, key)) continue;
    const payload = looked.record.payload;
    if (isGeneralBriefRecord(payload)) continue;
    if (payload.from_client !== undefined || payload.to_client !== undefined) continue;
    if (isStampedPayload(payload)) {
      // E7b (decision 4): a stamped record is settled only by its recipient. Settled, it moves as
      // acknowledged mail; unsettled, it never moves while its seat is in the registry, running or
      // stopped (a writer-side read is not settlement, and the pre-channel mark is not written). A
      // retired seat's unacknowledged record moves to the unread archive, and its sender is told.
      if (isRead(dropDir, family.id, context, key)) {
        const month = archiveMonth(payload.at);
        if (month !== null) move.push({ seat, id: family.id, month, files: family.files });
        continue;
      }
      if (options.retired === true) {
        const month = archiveMonth(payload.at);
        if (month !== null) move.push({ seat, id: family.id, month, files: family.files, unread: true, undelivered: { from: payload.from } });
      }
      continue;
    }
    const read = readVerifiedReceipt(join(dropDir, `${family.id}.read.json`), family.id, 'read', context, key);
    const replied = readVerifiedReceipt(join(dropDir, `${family.id}.replied.json`), family.id, 'replied', context, key);
    const delivered = readVerifiedReceipt(join(dropDir, `${family.id}.delivered.json`), family.id, 'delivered', context, key);
    const note = readVerifiedReceipt(ackNotePath(dropDir, family.id), family.id, 'read', context, key);
    // A read receipt is not an acknowledgement, whether or not it names the channel. `team ack`
    // writes a separate note. A lead's clearance and a reply are acknowledgements too.
    const acked = replied !== null
      || (note !== null && note.payload.read_by === EXPLICIT_ACK_READ_BY)
      || (read !== null && (read.payload.read_by === EXPLICIT_ACK_READ_BY || isLeadAckReadBy(read.payload.read_by) || read.payload.read_by === 'reply' || read.payload.read_by === 'answered-by-send'));
    const readAt = read?.payload.at ?? null;
    const readMs = readAt === null ? Number.NaN : Date.parse(readAt);
    const readOld = !acked && read !== null && Number.isFinite(readMs) && nowMs - readMs > INBOX_READ_KEEP_MS;
    if (acked || readOld) {
      const month = archiveMonth(payload.at);
      if (month === null) continue;
      move.push({ seat, id: family.id, month, files: family.files });
      continue;
    }
    if (read !== null || replied !== null) continue;
    if (unreadKeepMs !== null && note === null) {
      // Unread mail to a seat at rest. The signed sent time is the age; a record whose `at` is not
      // an instant stays.
      const sentMs = Date.parse(payload.at);
      const month = archiveMonth(payload.at);
      if (month !== null && Number.isFinite(sentMs) && nowMs - sentMs > unreadKeepMs) {
        move.push({ seat, id: family.id, month, files: family.files, unread: true });
        continue;
      }
    }
    if (!markPreChannel || channelStartMs === null) continue;
    // A read receipt already settled the message above. What is still unread was delivered only
    // when its delivered receipt says so. The record's sent time is not that proof.
    const proofAt = delivered?.payload.at ?? null;
    const proofMs = proofAt === null ? Number.NaN : Date.parse(proofAt);
    if (!Number.isFinite(proofMs) || proofMs >= channelStartMs) continue;
    markRead.push({ seat, id: family.id });
  }
  return { move, markRead, more, scanned, last };
}

function channelStartMs(dropDir: string, context: StatusContext): number | null {
  const listener = readListener(dropDir);
  if (listener === null || listener.channel !== true) return null;
  if (listener.seat !== context.to || listener.session !== context.session) return null;
  if (!sameFolder(listener.root, context.root)) return null;
  const ms = Date.parse(listener.ts);
  return Number.isFinite(ms) ? ms : null;
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

/** Links `from` onto `to` without replacing an existing different file. A copy already there, or
 *  a source that has already left, is success. The live name is not removed here. */
function placeFile(from: string, to: string): string | null {
  const src = heldAt(from);
  const dest = heldAt(to);
  if (src.kind === 'link' || dest.kind === 'link') return 'a link was not followed';
  if (src.kind === 'missing') return dest.kind === 'file' ? null : 'is missing';
  if (src.kind !== 'file') return 'is not a file';
  if (dest.kind === 'file') return sameInode(from, to) ? null : 'is already in the archive';
  if (dest.kind !== 'missing') return 'is not a free name in the archive';
  try {
    linkSync(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return sameInode(from, to) ? null : 'is already in the archive';
    return 'could not be placed';
  }
  return null;
}

function releaseLive(from: string, to: string): string | null {
  if (heldAt(from).kind === 'missing') return null;
  if (heldAt(to).kind !== 'file' || !sameInode(from, to)) return 'the archive copy is not this file';
  try {
    unlinkSync(from);
  } catch {
    return 'could not leave the live folder';
  }
  return null;
}

function moveFamily(dropDir: string, planned: InboxArchiveMove): string | null {
  const monthDir = join(dropDir, DROP_MONTH_ARCHIVE, planned.month);
  const destDir = planned.unread === true ? join(monthDir, DROP_ARCHIVE_UNREAD) : monthDir;
  if (heldAt(join(dropDir, DROP_MONTH_ARCHIVE)).kind === 'link') return `${planned.id}: archive is a link`;
  if (heldAt(monthDir).kind === 'link') return `${planned.id}: the archive month is a link`;
  try {
    mkdirSync(destDir, { recursive: true, mode: 0o700 });
  } catch {
    return `${planned.id}: the archive folder could not be created`;
  }
  if (heldAt(monthDir).kind !== 'folder') return `${planned.id}: the archive month is not a folder`;
  if (heldAt(destDir).kind !== 'folder') return `${planned.id}: the archive folder is not a folder`;
  const arriving = join(destDir, `.${planned.id}.arriving`);
  const finalName = join(destDir, planned.id);
  // A crash may have left the record under its temp name. Publish that name before anything else.
  if (heldAt(arriving).kind === 'file' && heldAt(finalName).kind === 'missing') {
    const staged = placeFile(arriving, finalName);
    if (staged !== null) return `${planned.id}: ${staged}`;
  }
  const sidecars = planned.files.filter((name) => name !== planned.id);
  for (const name of sidecars) {
    const problem = placeFile(join(dropDir, name), join(destDir, name));
    if (problem !== null) return `${planned.id}: ${name} ${problem}`;
  }
  // The record is the name a lookup finds. It is published last, from a temp link, so a crash
  // before this leaves the live record in place with its receipts already in the archive.
  if (heldAt(finalName).kind === 'missing') {
    const staged = placeFile(join(dropDir, planned.id), arriving);
    if (staged !== null) return `${planned.id}: ${staged}`;
    const published = placeFile(arriving, finalName);
    if (published !== null) return `${planned.id}: ${published}`;
  } else if (heldAt(join(dropDir, planned.id)).kind === 'file' && !sameInode(join(dropDir, planned.id), finalName)) {
    return `${planned.id}: is already in the archive`;
  }
  if (heldAt(arriving).kind === 'file' && heldAt(finalName).kind === 'file' && sameInode(arriving, finalName)) {
    try {
      unlinkSync(arriving);
    } catch {
      // The final name is in place. The next pass removes the temp name.
    }
  }
  // Drop the live record first, so a lookup switches to the archive where the receipts already are.
  const recordGone = releaseLive(join(dropDir, planned.id), finalName);
  if (recordGone !== null) return `${planned.id}: ${recordGone}`;
  for (const name of sidecars) {
    const problem = releaseLive(join(dropDir, name), join(destDir, name));
    if (problem !== null) return `${planned.id}: ${name} ${problem}`;
  }
  clearUnread(dropDir, planned.id);
  return null;
}

/** A temp name left from a crash, published onto the record's final name when that name is free. */
function retireTemps(dropDir: string, budget: { left: number; more: boolean }): void {
  const root = join(dropDir, DROP_MONTH_ARCHIVE);
  if (heldAt(root).kind !== 'folder') return;
  let months: string[];
  try {
    months = readdirSync(root);
  } catch {
    return;
  }
  const dirs: string[] = [];
  for (const month of months) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const dir = join(root, month);
    if (heldAt(dir).kind !== 'folder') continue;
    dirs.push(dir);
    const unread = join(dir, DROP_ARCHIVE_UNREAD);
    if (heldAt(unread).kind === 'folder') dirs.push(unread);
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('.') || !name.endsWith('.arriving')) continue;
      if (budget.left <= 0) {
        budget.more = true;
        return;
      }
      budget.left -= 1;
      const id = name.slice(1, -'.arriving'.length);
      const tmp = join(dir, name);
      const finalName = join(dir, id);
      if (heldAt(finalName).kind === 'missing') {
        if (placeFile(tmp, finalName) !== null) continue;
      }
      if (heldAt(finalName).kind === 'file' && sameInode(tmp, finalName)) {
        try {
          unlinkSync(tmp);
        } catch {
          // The final name is in place. The next pass removes the temp name.
        }
      }
    }
  }
}

/** Publishes one crash temp onto its record's final name, when that name is free. */
function retireTemp(dir: string, name: string): void {
  const id = name.slice(1, -'.arriving'.length);
  const tmp = join(dir, name);
  const finalName = join(dir, id);
  if (heldAt(finalName).kind === 'missing') {
    if (placeFile(tmp, finalName) !== null) return;
  }
  if (heldAt(finalName).kind === 'file' && sameInode(tmp, finalName)) {
    try {
      unlinkSync(tmp);
    } catch {
      // The final name is in place. The next pass removes the temp name.
    }
  }
}

/** Places one live sidecar whose record already left beside that record, and drops the live
 *  name. Returns the id when it finished, null otherwise (the record is live, or nowhere). */
function finishSidecar(dropDir: string, name: string): string | null {
  if (name === DROP_MONTH_ARCHIVE || name.startsWith('.')) return null;
  const dot = name.indexOf('.');
  if (dot <= 0) return null;
  const id = name.slice(0, dot);
  if (!ID_NAME.test(id) || heldAt(join(dropDir, id)).kind === 'file') return null;
  const monthDir = folderOfDrop(dropDir, id);
  if (monthDir === dropDir) return null;
  const from = join(dropDir, name);
  const to = join(monthDir, name);
  if (placeFile(from, to) !== null) return null;
  if (releaseLive(from, to) !== null) return null;
  clearUnread(dropDir, id);
  return id;
}

/** One unit of recovery work: a crash temp in an archive folder, or a live name with a dot that
 *  may be a sidecar left behind. `key` orders the list and is the cursor a caller keeps. */
export type RecoveryItem = { key: string; kind: 'temp'; dir: string; name: string } | { key: string; kind: 'sidecar'; name: string };

/** Every unit of recovery work in one seat folder, in key order: one listing of the live folder
 *  and of each archive month, nothing else read. Null when the live folder cannot be read. */
export function listRecoveryWork(dropDir: string): RecoveryItem[] | null {
  let live: string[];
  try {
    live = readdirSync(dropDir);
  } catch {
    return null;
  }
  const items: RecoveryItem[] = [];
  const root = join(dropDir, DROP_MONTH_ARCHIVE);
  if (heldAt(root).kind === 'folder') {
    let months: string[] = [];
    try {
      months = readdirSync(root);
    } catch {
      months = [];
    }
    for (const month of months) {
      if (!MONTH.test(month)) continue;
      const dir = join(root, month);
      if (heldAt(dir).kind !== 'folder') continue;
      const dirs: Array<[string, string]> = [[dir, month]];
      const unread = join(dir, DROP_ARCHIVE_UNREAD);
      if (heldAt(unread).kind === 'folder') dirs.push([unread, `${month}/${DROP_ARCHIVE_UNREAD}`]);
      for (const [at, label] of dirs) {
        let names: string[];
        try {
          names = readdirSync(at);
        } catch {
          continue;
        }
        for (const name of names) {
          if (name.startsWith('.') && name.endsWith('.arriving')) items.push({ key: `0:${label}/${name}`, kind: 'temp', dir: at, name });
        }
      }
    }
  }
  for (const name of live) {
    if (name === DROP_MONTH_ARCHIVE || name.startsWith('.') || name.indexOf('.') <= 0) continue;
    items.push({ key: `1:${name}`, kind: 'sidecar', name });
  }
  return items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Whether every folder from `dropDir`'s archive down to `dir` is a plain folder now. */
function archiveChainOk(dropDir: string, dir: string): boolean {
  const root = join(dropDir, DROP_MONTH_ARCHIVE);
  if (dir !== root && !dir.startsWith(`${root}/`)) return false;
  let at = dir;
  for (;;) {
    if (heldAt(at).kind !== 'folder') return false;
    if (at === root) return true;
    at = dirname(at);
  }
}

/** Does the given units of recovery work, each looked at once whatever it finds. Returns the
 *  ids whose sidecars it finished. */
export function recoverItems(dropDir: string, items: readonly RecoveryItem[]): string[] {
  const done = new Set<string>();
  for (const item of items) {
    if (item.kind === 'temp') {
      // The folders on the way from the seat folder to the temp are checked now, each one, so an
      // archive, month or unread folder replaced by a link since the listing is not followed.
      if (archiveChainOk(dropDir, item.dir)) retireTemp(item.dir, item.name);
      continue;
    }
    const id = finishSidecar(dropDir, item.name);
    if (id !== null) done.add(id);
  }
  return [...done];
}

/** Sidecars left in the live folder after their record reached the archive. Place any the
 *  archive does not have, then drop the live name. Returns the ids this pass finished. */
function finishOrphans(dropDir: string, limit = Number.POSITIVE_INFINITY): SeatRecovery {
  const budget = { left: limit, more: false };
  retireTemps(dropDir, budget);
  let names: string[];
  try {
    names = readdirSync(dropDir);
  } catch {
    return { finished: [], used: limit - budget.left, more: budget.more };
  }
  const done = new Set<string>();
  for (const name of names) {
    if (name === DROP_MONTH_ARCHIVE || name.startsWith('.')) continue;
    const dot = name.indexOf('.');
    if (dot <= 0) continue;
    const id = name.slice(0, dot);
    if (!ID_NAME.test(id) || heldAt(join(dropDir, id)).kind === 'file') continue;
    // Every sidecar looked at here is work, finished or not: it is charged to the budget.
    if (budget.left <= 0) {
      budget.more = true;
      break;
    }
    budget.left -= 1;
    const monthDir = folderOfDrop(dropDir, id);
    if (monthDir === dropDir) continue;
    const from = join(dropDir, name);
    const to = join(monthDir, name);
    if (placeFile(from, to) !== null) continue;
    if (releaseLive(from, to) !== null) continue;
    clearUnread(dropDir, id);
    done.add(id);
  }
  return { finished: [...done], used: limit - budget.left, more: budget.more };
}

/** What one recovery call did: the ids it finished, the work it used, and whether it stopped
 *  at its limit with more to look at. */
export type SeatRecovery = { finished: string[]; used: number; more: boolean };

/**
 * Archives one seat's settled mail and marks its pre-channel unread drops read.
 * A dry run returns the plan and leaves the folder untouched.
 */
export function archiveSeatInbox(input: {
  dropDir: string;
  seat: string;
  context: StatusContext;
  key: KeyObject;
  home: string;
  now: Date;
  dryRun: boolean;
  options?: InboxArchivePlanOptions;
}): InboxArchiveReport {
  const nowMs = input.now.getTime();
  const options = input.options ?? {};
  // Orphans first, inside the same budget: a family finished here counts against the limit.
  const orphans: InboxArchiveMove[] = input.dryRun || options.orphans === false
    ? []
    : finishOrphans(input.dropDir, options.limit).finished.map((id) => ({ seat: input.seat, id, month: '', files: [] }));
  const planned = planSeatArchive(
    input.dropDir,
    input.seat,
    input.context,
    input.key,
    nowMs,
    channelStartMs(input.dropDir, input.context),
    options.limit === undefined ? options : { ...options, limit: Math.max(0, options.limit - orphans.length) },
  );
  if ('refused' in planned) {
    return { dryRun: input.dryRun, move: orphans, markRead: [], partial: [], refused: planned.refused };
  }
  const seen = { more: planned.more, scanned: planned.scanned, last: planned.last };
  if (input.dryRun) {
    return { dryRun: true, move: planned.move, markRead: planned.markRead, partial: [], refused: null, ...seen };
  }
  const moved: InboxArchiveMove[] = orphans;
  const partial: string[] = [];
  for (const family of planned.move) {
    const problem = moveFamily(input.dropDir, family);
    if (problem !== null) {
      partial.push(family.id);
      return { dryRun: false, move: moved, markRead: [], partial, refused: problem, ...seen };
    }
    moved.push(family);
  }
  const marked: InboxArchiveMark[] = [];
  for (const item of planned.markRead) {
    const outcome = publishRecordRead({
      dropDir: input.dropDir,
      id: item.id,
      to: input.context.to,
      root: input.context.root,
      session: input.context.session,
      home: input.home,
      key: input.key,
      at: input.now.toISOString(),
      ...(input.context.lead === undefined ? {} : { lead: input.context.lead }),
    });
    if (outcome.kind === 'held' || outcome.kind === 'unwritten') {
      partial.push(item.id);
      return {
        dryRun: false,
        move: moved,
        markRead: marked,
        partial,
        refused: `${item.id}: it was not marked read`,
      };
    }
    marked.push(item);
  }
  return { dryRun: false, move: moved, markRead: marked, partial, refused: null, ...seen };
}

/** Writes the acknowledgement note beside the record. A read receipt already there is left as
 *  it is, including a channel read. The note is the evidence a later archive pass looks for. */
export function writeExplicitAck(input: {
  folder: string;
  id: string;
  to: string;
  root: string;
  session: string;
  home: string;
  key: KeyObject;
  at: string;
}): boolean {
  hostedCommit('writeExplicitAck');
  const path = ackNotePath(input.folder, input.id);
  const context: StatusContext = { to: input.to, root: input.root, session: input.session };
  const existing = readVerifiedReceipt(path, input.id, 'read', context, input.key);
  if (existing !== null && existing.payload.read_by === EXPLICIT_ACK_READ_BY) return true;
  if (heldAt(path).kind !== 'missing') return false;
  const signed = signReceiptPayload({
    kind: 'receipt',
    status: 'read',
    id: input.id,
    to: input.to,
    root: input.root,
    session: input.session,
    at: input.at,
    read_by: EXPLICIT_ACK_READ_BY,
  }, input.home);
  const published = publishReadReceipt(path, `${JSON.stringify(signed, null, 2)}\n`);
  if (published === 'failed') return false;
  if (published === 'written' && !flushReceipt(path, input.folder)) return false;
  const noted = readVerifiedReceipt(path, input.id, 'read', context, input.key);
  return noted !== null && noted.payload.read_by === EXPLICIT_ACK_READ_BY;
}

/** One message moved while unread: its id, the archive month and the record's path. */
export type ArchivedUnread = { id: string; month: string; path: string };

/** The messages in `dropDir`'s `archive/<YYYY-MM>/unread/` folders, oldest month first. Nothing
 *  is read but the folder names; a lookup by id reads the record. */
export function listArchivedUnread(dropDir: string): ArchivedUnread[] {
  const root = join(dropDir, DROP_MONTH_ARCHIVE);
  if (heldAt(root).kind !== 'folder') return [];
  let months: string[];
  try {
    months = readdirSync(root).filter((name) => MONTH.test(name)).sort();
  } catch {
    return [];
  }
  const out: ArchivedUnread[] = [];
  for (const month of months) {
    if (heldAt(join(root, month)).kind !== 'folder') continue;
    const dir = join(root, month, DROP_ARCHIVE_UNREAD);
    if (heldAt(dir).kind !== 'folder') continue;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.') || name.includes('.') || !ID_NAME.test(name)) continue;
      if (heldAt(join(dir, name)).kind !== 'file') continue;
      out.push({ id: name, month, path: join(dir, name) });
    }
  }
  return out;
}

/** One seat drop folder under a root: its session, its seat and its path. */
export type SeatDropFolder = { session: string; seat: string; dropDir: string };

/** Every seat drop folder under `root`, in session then seat order as the folder lists them. A
 *  folder that is not a plain folder, or whose name is not an id, is not listed. */
export function seatDropFolders(root: string): SeatDropFolder[] {
  const base = join(root, '.agents', 'send-drops');
  if (heldAt(base).kind !== 'folder') return [];
  let sessions: string[];
  try {
    sessions = readdirSync(base);
  } catch {
    return [];
  }
  const out: SeatDropFolder[] = [];
  for (const session of sessions) {
    if (session.startsWith('.') || !ID_NAME.test(session)) continue;
    const sessionDir = join(base, session);
    if (heldAt(sessionDir).kind !== 'folder') continue;
    let seats: string[];
    try {
      seats = readdirSync(sessionDir);
    } catch {
      continue;
    }
    for (const seat of seats) {
      if (seat.startsWith('.') || seat === DROP_MONTH_ARCHIVE || !ID_NAME.test(seat)) continue;
      const dropDir = join(sessionDir, seat);
      if (heldAt(dropDir).kind !== 'folder') continue;
      out.push({ session, seat, dropDir });
    }
  }
  return out;
}

/**
 * Archives settled mail under `root` and marks unread drops delivered before each seat's
 * channel started. A dry run changes nothing and writes no audit line. The ids are the
 * message names, in seat-folder order.
 */
export function runInboxRetention(
  root: string,
  options: { now: Date; home: string; dryRun?: boolean; seats?: readonly string[]; session?: string },
): {
  move: string[];
  markRead: string[];
  partial: string[];
  refused: string | null;
  busy?: string[];
  /** The older store, listed only: the daemon's nightly pass is its one mover. `running` says
   *  whether a daemon serves this root now. */
  daemon?: { running: boolean; due: string[]; stay: number };
} {
  const key = messageKeyState(options.home);
  if (key.kind !== 'key') return { move: [], markRead: [], partial: [], refused: null };
  const base = join(root, '.agents', 'send-drops');
  // No drop tree, or one that cannot be read: no drop moves, the older store is still looked at.
  let sessions: string[] = [];
  if (heldAt(base).kind === 'folder') {
    try {
      sessions = readdirSync(base);
    } catch {
      sessions = [];
    }
  }
  const move: string[] = [];
  const markRead: string[] = [];
  const partial: string[] = [];
  const refusals: string[] = [];
  const dryRun = options.dryRun === true;
  for (const session of sessions) {
    if (session.startsWith('.') || !ID_NAME.test(session)) continue;
    const sessionDir = join(base, session);
    if (heldAt(sessionDir).kind !== 'folder') continue;
    let seats: string[];
    try {
      seats = readdirSync(sessionDir);
    } catch {
      continue;
    }
    for (const seat of seats) {
      if (seat.startsWith('.') || seat === DROP_MONTH_ARCHIVE || !ID_NAME.test(seat)) continue;
      if (options.seats !== undefined && !options.seats.includes(seat)) continue;
      const dropDir = join(sessionDir, seat);
      if (heldAt(dropDir).kind !== 'folder') continue;
      const context: StatusContext = { to: seat, root, session };
      const report = archiveSeatInbox({
        dropDir,
        seat,
        context,
        key: key.key,
        home: options.home,
        now: options.now,
        dryRun,
      });
      move.push(...report.move.map((item) => item.id));
      markRead.push(...report.markRead.map((item) => item.id));
      partial.push(...report.partial);
      if (report.refused !== null) refusals.push(report.refused);
    }
  }
  // The older `.agents/messages` store, for this session. A manual run never knows a seat is at
  // rest, so unread mail from a real sender stays; unread runtime notices past fourteen days move.
  // A mailbox another archiver holds (the daemon's daily pass) is skipped and named, not refused.
  const busy: string[] = [];
  // The daemon's chores child is the store's one archiver: this run only lists what is due, as a
  // dry run would, and moves nothing, whether or not a daemon runs now.
  const deferred = options.session !== undefined;
  const daemon = { running: deferred && daemonServesRoot(options.home, root), due: [] as string[], stay: 0 };
  if (options.session !== undefined) {
    for (const folder of legacySeatFolders(root)) {
      if (options.seats !== undefined && !options.seats.includes(folder.seat)) continue;
      const report = archiveLegacySeat({
        root,
        session: options.session,
        seat: folder.seat,
        key: key.key,
        now: options.now,
        dryRun: dryRun || deferred,
        options: { unreadKeepMs: null },
      });
      if (deferred) {
        daemon.due.push(...report.plan.move.map((item) => item.id));
        daemon.stay += Object.values(report.plan.stays).reduce((total, count) => total + count, 0);
        continue;
      }
      move.push(...(dryRun ? report.plan.move : report.moved).map((item) => item.id));
      if (report.busy !== null) busy.push(folder.seat);
      if (report.refused !== null) refusals.push(report.refused);
    }
  }
  if (!dryRun) {
    const line = [
      `moved ${move.join(' ')}`,
      `marked ${markRead.join(' ')} read`,
      ...(partial.length === 0 ? [] : [`partial ${partial.join(' ')}`]),
      ...(busy.length === 0 ? [] : [`busy ${busy.join(' ')}`]),
      ...refusals,
    ].join('; ');
    logLine(join(root, '.agents'), 'drops archive', 'retention', line, options.now);
  }
  return {
    move,
    markRead,
    partial,
    refused: refusals.length === 0 ? null : refusals.join('; '),
    ...(busy.length === 0 ? {} : { busy }),
    ...(deferred ? { daemon } : {}),
  };
}

/** One audit line for a real archive run. A dry run does not call this. */
export function auditInboxArchive(
  dir: string,
  caller: string,
  moved: number,
  marked: number,
  now: Date,
): void {
  logLine(
    dir,
    'drops archive',
    caller,
    `moved ${moved} message(s) into archive/<YYYY-MM> and marked ${marked} pre-channel drop(s) read`,
    now,
  );
}
