// Where one drop's files live. The live seat folder is the hot path. A message that has
// left it sits in `<seat>/archive/<YYYY-MM>/` under the same name, or, when it was moved
// unread from a seat that was stopped or retired, in `<seat>/archive/<YYYY-MM>/unread/`.
// A lookup by id reads that copy. Nothing here creates, moves, or deletes a file.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { heldAt } from '../launch/rules-file.ts';
import { seatListingDirs } from '../queue/mail-tree.ts';

/** The folder under a seat's drop directory that holds archived months. */
export const DROP_MONTH_ARCHIVE = 'archive';

/** The folder inside an archive month that holds mail moved while still unread. */
export const DROP_ARCHIVE_UNREAD = 'unread';

const MONTH = /^\d{4}-\d{2}$/;

/**
 * The directory that holds `id`'s record: the live seat folder when the record is still
 * there, otherwise the archive month that has it. A missing record names the live folder,
 * which is where a new one is written.
 *
 * E7b revision 3: a seat has two folders (`src/queue/mail-tree.ts`), and a record lives in exactly
 * one of them. From either folder, the lookup reads the legacy folder, then the stamped one, then
 * each one's archive months; a missing record names the folder it was asked about.
 */
export function folderOfDrop(dropDir: string, id: string): string {
  if (id === '' || id.includes('/') || id.includes('\\') || id === '.' || id === '..') return dropDir;
  const folders = seatListingDirs(dropDir);
  for (const folder of folders) if (heldAt(join(folder, id)).kind === 'file') return folder;
  for (const folder of folders) {
    const found = archivedFolderOf(folder, id);
    if (found !== null) return found;
  }
  return dropDir;
}

function archivedFolderOf(dropDir: string, id: string): string | null {
  const root = join(dropDir, DROP_MONTH_ARCHIVE);
  if (heldAt(root).kind !== 'folder') return null;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  for (const month of names) {
    if (!MONTH.test(month)) continue;
    const dir = join(root, month);
    // Each folder on the way is checked itself, so a link standing for a month or for the unread
    // folder is never followed to a record elsewhere.
    if (heldAt(dir).kind !== 'folder') continue;
    if (heldAt(join(dir, id)).kind === 'file') return dir;
    const unread = join(dir, DROP_ARCHIVE_UNREAD);
    if (heldAt(unread).kind === 'folder' && heldAt(join(unread, id)).kind === 'file') return unread;
  }
  return null;
}

/**
 * The seat folder (legacy or stamped, never an archive month) of the tree that holds `id`'s record,
 * for the sidecars kept at the seat level of the record's own tree (claims, exposures, pending and
 * taken markers). A record in neither tree names the folder it was asked about, so a writer that
 * passes its era's folder keeps it.
 */
export function seatFolderOf(dropDir: string, id: string): string {
  const folders = seatListingDirs(dropDir);
  if (folders.length < 2) return dropDir;
  const found = folderOfDrop(dropDir, id);
  for (const folder of folders) if (found === folder || found.startsWith(`${folder}/`)) return folder;
  return dropDir;
}

/** The live path of `id`'s record in the seat folder of the tree that holds it (never an archive
 *  month: a record that has left its seat folder is not at this path, as before revision 3). */
export function liveRecordPath(dropDir: string, id: string): string {
  return join(seatFolderOf(dropDir, id), id);
}
