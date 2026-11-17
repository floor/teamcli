// The one exclusive read claim every body-serving reader takes (rfc-event-comms E5, review round 4).
//
// A reader that serves a message's body holds `<dropDir>/.read-claims/<id>` from before the body
// is handed over until its receipt is sealed or it gives up. A relayed read also names its owning
// operation in `<id>.owner`, made durable (file and folder fsynced) before any output is written.
// A claim whose owner file stands belongs to that operation and, once it is cut off, to its
// recovery alone: a new reader that finds it gets "being recovered" and no body, whether the
// holder lives or not, and never takes it over. Only the owner's seal or release, or its recovery,
// removes the owner file and the claim. A claim with no owner file keeps the seat lock's rule: a
// live holder refuses a rival, a dead one's claim is taken over.
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { linkSync, openSync, unlinkSync, writeSync } from '../host/guarded-fs.ts';
import { acquireLockAt } from '../launch/seat-lock.ts';
import { readOwn } from '../queue/append.ts';

/** The folder of exclusive read claims inside a seat's drop folder: a dot name, never a message. */
export const READ_CLAIMS = '.read-claims';
const OWNER_SUFFIX = '.owner';
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export type ReadClaim =
  /** `release` settles the claim (owner file, then claim); `keep` lets go of the claim lock only,
   *  leaving a named owner's file standing for its recovery (a seal that could not be made). */
  | { ok: true; release: () => void; keep: () => void }
  | { ok: false; why: 'busy' | 'recovering' | 'unknown' | 'durable' | 'unwritable' };

/** The owner a relayed read's claim names: the outbox request that holds it. */
export function relayClaimOwner(outbox: string, request: string): string {
  return `relay:${outbox}/${request}`;
}

function ownerPath(dropDir: string, id: string): string {
  return join(dropDir, READ_CLAIMS, `${id}${OWNER_SUFFIX}`);
}

/** The owner file's operation: null when none stands (ENOENT only), 'unknown' for any other fault
 *  or content this build cannot read. Unknown is never read as absent. */
function ownerOf(dropDir: string, id: string): string | null | 'unknown' {
  const text = readOwn(ownerPath(dropDir, id));
  if (text === null) return 'unknown';
  if (text === '') {
    // `readOwn` answers '' for an absent file and for an empty one: an empty owner file is unknown.
    try {
      lstatSync(ownerPath(dropDir, id));
      return 'unknown';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unknown';
    }
  }
  try {
    const parsed = JSON.parse(text) as { owner?: unknown };
    return typeof parsed.owner === 'string' && parsed.owner !== '' ? parsed.owner : 'unknown';
  } catch {
    return 'unknown';
  }
}

function fsyncPath(path: string, flags: number): void {
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Publishes the owner file whole and durable: a private temp file, written and fsynced, linked to
 *  the name (never replacing one), then the claim file and the folder fsynced. */
function writeOwner(dropDir: string, id: string, owner: string): boolean {
  const folder = join(dropDir, READ_CLAIMS);
  const temp = join(folder, `${id}${OWNER_SUFFIX}.${String(process.pid)}.${String(Date.now())}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    if (!fstatSync(fd).isFile()) return false;
    const text = Buffer.from(`${JSON.stringify({ v: 1, owner, pid: process.pid, at: new Date().toISOString() })}\n`);
    let written = 0;
    while (written < text.length) written += writeSync(fd, text, written, text.length - written);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    linkSync(temp, ownerPath(dropDir, id));
    fsyncPath(join(folder, id), constants.O_RDONLY | NOFOLLOW);
    fsyncPath(folder, constants.O_RDONLY);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* closed */ }
    }
    try { unlinkSync(temp); } catch { /* not made */ }
  }
}

/** Removes the owner file (only when it names `owner`) and then the claim, the folder fsynced
 *  between: a crash leaves either both, the claim alone (taken over by the next reader), or none. */
function settle(dropDir: string, id: string, owner: string | undefined): void {
  const folder = join(dropDir, READ_CLAIMS);
  if (owner !== undefined && ownerOf(dropDir, id) === owner) {
    try { unlinkSync(ownerPath(dropDir, id)); } catch { /* gone */ }
    try { fsyncPath(folder, constants.O_RDONLY); } catch { /* the claim below still guards */ }
  }
}

/**
 * Takes the id's exclusive read claim. `owner`, when given, names the operation that will hand the
 * body over (a relayed read), and is made durable before this returns. A reader with no owner holds
 * the claim only while it lives.
 */
export function claimRead(dropDir: string, id: string, owner?: string, adopt = false): ReadClaim {
  const folder = join(dropDir, READ_CLAIMS);
  const standing = ownerOf(dropDir, id);
  if (standing === 'unknown') return { ok: false, why: 'unknown' };
  // Recovery adopts the claim its own cut-off request left: the owner file stays, names `owner`,
  // and is settled by this claim's seal or release like a live one's.
  if (adopt) {
    if (owner === undefined || standing !== owner) return { ok: false, why: 'recovering' };
  } else if (standing !== null) {
    return { ok: false, why: 'recovering' };
  }
  let lock: ReturnType<typeof acquireLockAt>;
  try {
    lock = acquireLockAt(join(folder, id), folder);
  } catch {
    // The claim folder or its file cannot be written: no reader may serve the id now.
    return { ok: false, why: 'unwritable' };
  }
  if (!('release' in lock)) return { ok: false, why: 'busy' };
  // An owner file published while this reader waited (its holder died, the lock was taken over)
  // still belongs to that operation's recovery.
  const after = ownerOf(dropDir, id);
  if (adopt ? after !== owner : after !== null) {
    lock.release();
    return { ok: false, why: after === 'unknown' ? 'unknown' : 'recovering' };
  }
  if (owner !== undefined && !adopt && !writeOwner(dropDir, id, owner)) {
    lock.release();
    return { ok: false, why: 'durable' };
  }
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      settle(dropDir, id, owner);
      lock.release();
    },
    keep: () => {
      if (released) return;
      released = true;
      lock.release();
    },
  };
}

/** The ids whose standing claim names `owner`: a cut-off relayed read's, found by its recovery.
 *  [] only when the claim folder is proven absent; null when it, or any owner file in it, cannot
 *  be read now, since an unread owner file may be this request's. Unknown is never read as none. */
export function claimsOwnedBy(dropDir: string, owner: string, list: (folder: string) => string[] = readdirSync): string[] | null {
  let names: string[];
  try {
    names = list(join(dropDir, READ_CLAIMS));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  const ids: string[] = [];
  for (const name of names) {
    if (!name.endsWith(OWNER_SUFFIX)) continue;
    const id = name.slice(0, -OWNER_SUFFIX.length);
    const standing = ownerOf(dropDir, id);
    if (standing === 'unknown') return null;
    if (standing === owner) ids.push(id);
  }
  return ids.sort();
}

/** Recovery's end of a cut-off claim. The dead holder's claim file goes first, while the owner file
 *  still turns every reader away; the owner file last. A reader that takes the bare claim between
 *  the two finds the owner file after taking it and lets it go. A crash between the two leaves the
 *  owner file, and the next recovery pass settles it again. */
export function settleOwnedClaim(dropDir: string, id: string, owner: string): void {
  if (ownerOf(dropDir, id) !== owner) return;
  try { unlinkSync(join(dropDir, READ_CLAIMS, id)); } catch { /* gone */ }
  settle(dropDir, id, owner);
}
