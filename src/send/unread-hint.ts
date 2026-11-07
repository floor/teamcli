// The unread index one recipient folder keeps beside its records (ADR `zeus-message-path`, D3).
//
// A `team send` from S to X settles X's newest delivered-unread message from S, and finding it by
// reading every record in the session's transport tree is what made every send wait tens of
// seconds on a large tree. This module keeps that answer in one small file per recipient folder,
// `.unread.json`, naming the newest few records each sending seat has staged there. An entry is
// written when the drop lands and removed when its id is read — `publishRecordRead` is the one
// receipt sink every reader passes, so a read, an ack, a reply and the sweep itself all clear it
// in the same place.
//
// The map is a hint, never evidence. The sweep re-reads and verifies each entry it names, newest
// first, until one holds; an entry that is missing, names nothing, does not verify or names an
// already-read message settles nothing, and the sweep never falls back to a scan of the tree. The
// newest few are kept rather than the newest one because a message that is not a delivery this
// rule counts — a typed wake, a webhook post, one delivered after the send — never blocks an older
// delivered one. A hint another writer loses by racing costs one auto-mark, never a wrong one, and
// the next drop from that sender rewrites the entry.
import { readStateFile, writeStateFile } from '../file-write.ts';
import { basename, dirname, join } from 'node:path';
import { acquireSeatLock } from '../launch/seat-lock.ts';

/** A seat name this file can name: the shape a record's sender carries. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** The hint file's own name. It starts with a dot, so no reader that lists record ids can meet
 *  it as one: `NAME` rejects it, `isMarkerName` rejects its `.json` end, `listDrops` skips a name
 *  holding a dot and the watch's folder reader does the same. */
const HINT_FILE = '.unread.json';

/** One sender's staged record, as the drop wrote it. */
export type UnreadHintEntry = { id: string; at: string };

/** How many of a sender's newest records one entry keeps. A sweep reads at most this many, so its
 *  work is capped by the index's shape, never by the tree; the count is far past the point where a
 *  newer message could still be blocking an older one in practice. */
const HINTS_PER_SENDER = 16;

type HintMap = { v: 1; unread: Record<string, { entries: UnreadHintEntry[] }> };

/** The hint file's path in one recipient folder. */
export function unreadHintPath(dropDir: string): string {
  return join(dropDir, HINT_FILE);
}

/** The folder's seat and session, when it is a seat's drop folder, with the `.agents` directory
 *  a seat lock lives in. Anything else — a client inbox, a folder a test made by hand — names
 *  null and takes no hint: only a seat's own drop folder is read by a seat's send. */
function dropFolder(dropDir: string): { dir: string; session: string; seat: string } | null {
  const seat = basename(dropDir);
  const session = basename(dirname(dropDir));
  const sendDrops = dirname(dirname(dropDir));
  if (basename(sendDrops) !== 'send-drops') return null;
  if (!NAME.test(seat) || !NAME.test(session)) return null;
  return { dir: dirname(sendDrops), session, seat };
}

/** The map as it is on disk, or an empty one when there is no readable map. A file that is not
 *  this shape is treated as absent: a hint is re-derived by the next drop, never repaired. */
function readMap(dropDir: string): HintMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readStateFile(unreadHintPath(dropDir), undefined, dropFolder(dropDir)?.dir) ?? '');
  } catch {
    return { v: 1, unread: {} };
  }
  if (typeof parsed !== 'object' || parsed === null) return { v: 1, unread: {} };
  const raw = parsed as { v?: unknown; unread?: unknown };
  if (raw.v !== 1 || typeof raw.unread !== 'object' || raw.unread === null) return { v: 1, unread: {} };
  const unread: HintMap['unread'] = {};
  for (const [peer, entry] of Object.entries(raw.unread as Record<string, unknown>)) {
    if (!NAME.test(peer)) continue;
    if (typeof entry !== 'object' || entry === null) continue;
    const list = (entry as { entries?: unknown }).entries;
    if (!Array.isArray(list)) continue;
    const entries: UnreadHintEntry[] = [];
    for (const one of list) {
      if (typeof one !== 'object' || one === null) continue;
      const fields = one as { id?: unknown; at?: unknown };
      if (typeof fields.id !== 'string' || !NAME.test(fields.id)) continue;
      if (typeof fields.at !== 'string' || Number.isNaN(Date.parse(fields.at))) continue;
      if (entries.some((had) => had.id === fields.id)) continue;
      entries.push({ id: fields.id, at: fields.at });
      if (entries.length >= HINTS_PER_SENDER) break;
    }
    if (entries.length > 0) unread[peer] = { entries };
  }
  return { v: 1, unread };
}

/** The entries one sender has waiting, newest first, or an empty list. This is the whole lookup
 *  the send path makes; each entry is still only a hint, verified against its record. */
export function readUnreadHint(dropDir: string, peer: string): UnreadHintEntry[] {
  if (!NAME.test(peer)) return [];
  const entries = readMap(dropDir).unread[peer]?.entries ?? [];
  // The instant the sweep's rule names, newest first; an equal instant keeps the greater id, the
  // same order the tree walk settled ties in.
  return [...entries].sort((a, b) => {
    const byAt = Date.parse(b.at) - Date.parse(a.at);
    return byAt !== 0 ? byAt : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/** Writes the map atomically: a temp name no reader meets as a record, then a rename over the
 *  hint's name. A crash leaves either the old map or the new one, never a torn file. */
function writeMap(dropDir: string, map: HintMap): void {
  writeStateFile(unreadHintPath(dropDir), `${JSON.stringify(map, null, 2)}\n`, { root: dropFolder(dropDir)?.dir });
}

/**
 * Records that `id` is a record `peer` has staged into this folder, keeping the newest few. Taken
 * under the folder's seat lock when the caller holds none, so two drops from one sender settle on
 * the later instant; a lock another command holds never blocks the drop — the write is atomic on
 * its own and the sweep verifies the entry it finds, so the worst a race costs is one hint.
 * `held` is for a caller that already holds this folder's seat lock (a reply writes its record
 * and its hint under one lock). Never throws: a hint that cannot be written is a hint missing.
 */
export function noteUnread(
  dropDir: string,
  peer: string,
  id: string,
  at: string,
  options: { held?: boolean } = {},
): void {
  try {
    if (!NAME.test(peer) || !NAME.test(id)) return;
    if (Number.isNaN(Date.parse(at))) return;
    const folder = dropFolder(dropDir);
    if (folder === null) return;
    // The lock is best effort: another command holding it, or a tree this drop cannot lock in,
    // never costs the entry. The write is atomic on its own, and a race can only lose a hint —
    // which the sweep settles by verifying whatever it finds.
    let lock: ReturnType<typeof acquireSeatLock> | null = null;
    if (options.held !== true) {
      try {
        lock = acquireSeatLock(folder.dir, folder.session, folder.seat);
      } catch {
        lock = null;
      }
    }
    try {
      const map = readMap(dropDir);
      const current = map.unread[peer]?.entries ?? [];
      if (current.some((entry) => entry.id === id)) return;
      // Newest first, the same order the sweep reads: the later instant, then the greater id when
      // two share one (the order the tree walk settled ties in).
      const entries = [...current, { id, at }]
        .sort((a, b) => {
          const byAt = Date.parse(b.at) - Date.parse(a.at);
          return byAt !== 0 ? byAt : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
        })
        .slice(0, HINTS_PER_SENDER);
      map.unread[peer] = { entries };
      writeMap(dropDir, map);
    } finally {
      if (lock !== null && 'release' in lock) lock.release();
    }
  } catch {
    // A hint is an optimisation of the sweep, never a step of the send or the read.
  }
}

/**
 * Forgets the entry that names `id`, whichever sender wrote it: the message is read, so it can no
 * longer be settled by a sweep. Older entries a sender still has unread stay — they are still the
 * truth, and the next sweep that finds them newest-first may mark the next one. Called by the one
 * read-receipt sink; a map that cannot be read or written is left as it is, and the sweep's own
 * verification still settles the stale entry correctly (it marks nothing).
 */
export function clearUnread(dropDir: string, id: string): void {
  try {
    if (!NAME.test(id)) return;
    // Lock when the folder's seat lock is free, like the drop-side write: the clear and a landing
    // drop then serialise, and a read that races one still ends with the hint verifying correctly
    // (the sweep marks nothing for an id that is already read).
    const folder = dropFolder(dropDir);
    let lock: ReturnType<typeof acquireSeatLock> | null = null;
    if (folder !== null) {
      try {
        lock = acquireSeatLock(folder.dir, folder.session, folder.seat);
      } catch {
        lock = null;
      }
    }
    try {
      const map = readMap(dropDir);
      let changed = false;
      for (const [peer, entry] of Object.entries(map.unread)) {
        const entries = entry.entries.filter((one) => one.id !== id);
        if (entries.length === entry.entries.length) continue;
        changed = true;
        if (entries.length === 0) delete map.unread[peer];
        else map.unread[peer] = { entries };
      }
      if (changed) writeMap(dropDir, map);
    } finally {
      if (lock !== null && 'release' in lock) lock.release();
    }
  } catch {
    // The receipt is the message's proof; the hint's leftover is settled by the next sweep.
  }
}
