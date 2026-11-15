// Where one drop's files live. The live seat folder is the hot path. A message that has
// left it sits in `<seat>/archive/<YYYY-MM>/` under the same name, or, when it was moved
// unread from a seat that was stopped or retired, in `<seat>/archive/<YYYY-MM>/unread/`.
// A lookup by id reads that copy. Nothing here creates, moves, or deletes a file.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { heldAt } from '../launch/rules-file.ts';

/** The folder under a seat's drop directory that holds archived months. */
export const DROP_MONTH_ARCHIVE = 'archive';

/** The folder inside an archive month that holds mail moved while still unread. */
export const DROP_ARCHIVE_UNREAD = 'unread';

const MONTH = /^\d{4}-\d{2}$/;

/**
 * The directory that holds `id`'s record: the live seat folder when the record is still
 * there, otherwise the archive month that has it. A missing record names the live folder,
 * which is where a new one is written.
 */
export function folderOfDrop(dropDir: string, id: string): string {
  if (id === '' || id.includes('/') || id.includes('\\') || id === '.' || id === '..') return dropDir;
  if (heldAt(join(dropDir, id)).kind === 'file') return dropDir;
  const root = join(dropDir, DROP_MONTH_ARCHIVE);
  if (heldAt(root).kind !== 'folder') return dropDir;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return dropDir;
  }
  for (const month of names) {
    if (!MONTH.test(month)) continue;
    const dir = join(root, month);
    if (heldAt(join(dir, id)).kind === 'file') return dir;
    const unread = join(dir, DROP_ARCHIVE_UNREAD);
    if (heldAt(join(unread, id)).kind === 'file') return unread;
  }
  return dropDir;
}
