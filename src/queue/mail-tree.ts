// The two mail trees of a root (rfc-event-comms E7b, revision 3: invisible to older readers).
//
//   <root>/.agents/send-drops/<session>/<seat>/     the legacy tree: every unstamped record, and the
//                                                   seat's own markers (listener, wake, hints, ...)
//   <root>/.agents/send-stamped/<session>/<seat>/   the stamped tree: every stamped (lvl 3) record,
//                                                   with its sidecars and its month archive
//
// Level-2 code (E7a and earlier) lists and opens mail only under `send-drops/`, so a stamped record
// placed in `send-stamped/` is one no older process can read, expose or settle. Level-3 code reads
// both: a seat's listing is the union of its two folders, and a record's folder is the one that
// holds it (`folderOfDrop`). A record's `dropDir` is the folder it lives in; the seat's identity
// (session, seat, its queue, its markers) is the same from either folder (`mailDirOf`).
//
// Every path to either tree is built here: no other module names `send-drops` or `send-stamped`
// (the body-write inventory test holds that).
import { readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const LEGACY_TREE = 'send-drops';
export const STAMPED_TREE = 'send-stamped';

export type MailTree = 'legacy' | 'stamped';

/** A tree's root under an `.agents` folder. */
export function mailTreeIn(agentsDir: string, tree: MailTree = 'legacy'): string {
  return join(agentsDir, tree === 'stamped' ? STAMPED_TREE : LEGACY_TREE);
}

/** A tree's root under a project root. */
export function mailTreeOf(root: string, tree: MailTree = 'legacy'): string {
  return mailTreeIn(join(root, '.agents'), tree);
}

/** Both trees' roots under a project root, legacy first. */
export function sessionMailRoots(root: string): string[] {
  return [mailTreeOf(root, 'legacy'), mailTreeOf(root, 'stamped')];
}

/** A seat's folder in one tree, under an `.agents` folder. The legacy folder is the seat's identity
 *  folder: its markers, wake files and hints live there only. */
export function seatMailDirIn(agentsDir: string, session: string, seat: string, tree: MailTree = 'legacy'): string {
  return join(mailTreeIn(agentsDir, tree), session, seat);
}

/** A seat's legacy folder under a project root (its identity folder). */
export function seatDropDir(root: string, session: string, seat: string): string {
  return seatMailDirIn(join(root, '.agents'), session, seat, 'legacy');
}

/** A seat's two folders under a project root. */
export function seatMailDirs(root: string, session: string, seat: string): { legacy: string; stamped: string } {
  const agents = join(root, '.agents');
  return { legacy: seatMailDirIn(agents, session, seat, 'legacy'), stamped: seatMailDirIn(agents, session, seat, 'stamped') };
}

/** A session's folder in one tree, under a project root. */
export function sessionMailDir(root: string, session: string, tree: MailTree = 'legacy'): string {
  return join(mailTreeOf(root, tree), session);
}

/** The relative path parts of a seat's folder from its project root. */
export function seatMailParts(session: string, seat: string, tree: MailTree = 'legacy'): string[] {
  return ['.agents', tree === 'stamped' ? STAMPED_TREE : LEGACY_TREE, session, seat];
}

/** The seat a folder belongs to, when it is a seat folder of either tree
 *  (`<agents>/<tree>/<session>/<seat>`): its `.agents` folder, session, seat and tree. Null for any
 *  other folder (a client inbox, a test's own folder). Names are not validated here. */
export function mailDirOf(dropDir: string): { agents: string; session: string; seat: string; tree: MailTree } | null {
  const seat = basename(dropDir);
  const sessionDir = dirname(dropDir);
  const session = basename(sessionDir);
  const treeDir = dirname(sessionDir);
  const name = basename(treeDir);
  if (name !== LEGACY_TREE && name !== STAMPED_TREE) return null;
  if (seat === '' || session === '') return null;
  return { agents: dirname(treeDir), session, seat, tree: name === STAMPED_TREE ? 'stamped' : 'legacy' };
}

/** A seat folder's two folders, from either of them; null when `dropDir` is no seat folder. */
export function twinsOf(dropDir: string): { legacy: string; stamped: string } | null {
  const at = mailDirOf(dropDir);
  if (at === null) return null;
  return { legacy: seatMailDirIn(at.agents, at.session, at.seat, 'legacy'), stamped: seatMailDirIn(at.agents, at.session, at.seat, 'stamped') };
}

/** The seat's identity (legacy) folder for a folder of either tree; the folder itself otherwise. */
export function identityDirOf(dropDir: string): string {
  return twinsOf(dropDir)?.legacy ?? dropDir;
}

/** The folders a seat's listing reads, legacy first: both trees for a seat folder (from either
 *  one), the folder alone for any other. A folder that does not exist lists as empty. */
export function seatListingDirs(dropDir: string): string[] {
  const twins = twinsOf(dropDir);
  return twins === null ? [dropDir] : [twins.legacy, twins.stamped];
}

/**
 * The stamped folder of a seat, listed, for a reader that already listed the seat's legacy folder:
 * `null` when `dropDir` is no legacy seat folder or its stamped folder does not exist (a dark root
 * never has one), `'unreadable'` when it exists but cannot be listed (the caller fails as it does
 * for an unreadable legacy folder: an unreadable inbox is never an empty one).
 */
export function stampedListing(dropDir: string): { folder: string; names: string[] } | null | 'unreadable' {
  const at = mailDirOf(dropDir);
  if (at === null || at.tree !== 'legacy') return null;
  const folder = seatMailDirIn(at.agents, at.session, at.seat, 'stamped');
  try {
    return { folder, names: readdirSync(folder) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable';
  }
}

/**
 * The one era-aware container for a record write (E7b revision 3): a stamped record goes only into
 * the seat's stamped folder, never the legacy one; an unstamped record into `dropDir` itself. Null
 * for a stamped record whose `dropDir` is no seat folder: no container older code never reads
 * stands for it, so it is not written (fail closed).
 */
export function recordFolderFor(dropDir: string, stamped: boolean): string | null {
  if (!stamped) return dropDir;
  return twinsOf(dropDir)?.stamped ?? null;
}

/** The refusal a writer gives when `recordFolderFor` names no folder. */
export const NO_STAMPED_FOLDER = 'a stamped record has no stamped folder here, and it is never written where an older reader lists mail';

/** Where a stamped send's native handoff waits (E7b revision 3, carrier 1): under the stamped
 *  tree, never the project state's `pending/` folder an older watch reads and expires. */
export function nativePendingDir(root: string): string {
  return join(mailTreeOf(root, 'stamped'), '.native-pending');
}

/** The ids this process stamped (E7b revision 3, history era): a history line written by the
 *  process that signed a stamped record carries no body, whatever the floor says by then. */
const stampedHere = new Set<string>();

/** Notes an id this process stamped. */
export function noteStampedId(id: string): void {
  if (stampedHere.size > 65_536) stampedHere.clear();
  stampedHere.add(id);
}

/** Whether this process stamped the id. */
export function stampedHereId(id: string): boolean {
  return stampedHere.has(id);
}
