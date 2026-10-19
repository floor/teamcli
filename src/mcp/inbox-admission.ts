// The receiver's read-once admission: the signed read receipt is itself the gate, and it is
// published exclusively before any body is returned.
//
// The signed receipt answers whether a message was served, but it used to be written by rename
// after verification: two readers that crossed the receipt check both verified the record and both
// showed the body, and a second `inbox_read` of the same id showed it again. A separate claim file
// in front of the receipt only moved the problem: clearing a dead reader's claim needs a
// compare-and-delete, and the filesystem has no conditional unlink, so two reclaimers could remove
// a rival's freshly published claim. This module therefore keeps no claim at all. The receipt,
// which is never deleted or replaced once it exists, is the one per-id fact both readers race to
// create, and `link` makes that creation exclusive and no-clobber: exactly one reader wins the
// name, and every other reader sees `exists` and is served nothing.
//
// Nothing exists at the id's shared receipt name before that publication, so there is no stale
// entry to reclaim and no dead holder to judge. A crash before the link leaves no shared trace; a
// later reader is free to serve. A crash after the link leaves a durable receipt; the message is
// spent. The read receipt is flushed with its folder before the body is returned, so the honest
// guarantee is at-most-once content exposure — never exactly-once runtime effects downstream.
//
// An entry at the receipt name that the caller cannot verify — unreadable, unsigned, signed for
// another message or binding, a link, a FIFO, another owner's — is uncertainty, not proof that the
// content went unserved. The caller preserves it, returns no body, and never rewrites it: a
// corrupt receipt can hide a read that happened, and replacing it would re-expose the content.
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

/** `O_NOFOLLOW` is POSIX: 0 on platforms without it, while the caller's `lstat` guards the open. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** What became of an attempt to publish one receipt name, and the only outcomes a caller needs:
 *  this reader won the name, a rival's entry is there (never replaced), or nothing was written. */
export type ReceiptPublish = 'written' | 'exists' | 'failed';

/**
 * Publishes `content` at `path` only if the name is free: a private temp file in the same folder,
 * written whole and flushed, then linked onto the final name. `link` fails with `EEXIST` instead of
 * replacing, so a rival that wins the race is left standing and the loser learns `exists`; no
 * reader can ever overwrite the receipt that proves the body went out. The losing temp file is
 * removed. The final directory entry is flushed separately by `flushReceipt`, after the caller has
 * confirmed it won.
 */
export function publishReadReceipt(path: string, content: string): ReceiptPublish {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.new`;
  let fd: number;
  try {
    fd = openSync(tmp, 'wx', 0o600);
  } catch {
    return 'failed';
  }
  try {
    fchmodSync(fd, 0o600);
    const bytes = Buffer.from(content, 'utf8');
    for (let wrote = 0; wrote < bytes.length;) {
      wrote += writeSync(fd, bytes, wrote, bytes.length - wrote);
    }
    fsyncSync(fd);
  } catch {
    try {
      closeSync(fd);
    } catch {}
    try {
      unlinkSync(tmp);
    } catch {}
    return 'failed';
  }
  try {
    closeSync(fd);
  } catch {}
  try {
    linkSync(tmp, path);
  } catch (error) {
    const exists = (error as NodeJS.ErrnoException).code === 'EEXIST';
    try {
      unlinkSync(tmp);
    } catch {}
    return exists ? 'exists' : 'failed';
  }
  try {
    unlinkSync(tmp);
  } catch {}
  return 'written';
}

/**
 * Flushes the published receipt and its folder before a body is returned, so the receipt that
 * proves the exposure survives a crash. The file is opened without following a link and must
 * still be a regular file. Either flush failing means the receipt is not durable, and the read
 * then returns no body (the message is spent, never re-served).
 */
export function flushReceipt(path: string, folder: string): boolean {
  let file: number | null = null;
  try {
    file = openSync(path, constants.O_RDONLY | NOFOLLOW);
    if (!fstatSync(file).isFile()) return false;
    fsyncSync(file);
  } catch {
    return false;
  } finally {
    if (file !== null) {
      try {
        closeSync(file);
      } catch {}
    }
  }
  let directory: number | null = null;
  try {
    directory = openSync(folder, constants.O_RDONLY);
    fsyncSync(directory);
  } catch {
    return false;
  } finally {
    if (directory !== null) {
      try {
        closeSync(directory);
      } catch {}
    }
  }
  return true;
}
