// The receiver's read-once admission: one exclusive, persistent claim per message id, decided
// before the read receipt is written or the body returned.
//
// The signed receipt answers whether a message was served, but it is written after verification:
// two readers that cross the receipt check both verify the record and both show the body, and a
// second `inbox_read` of the same id shows it again. This module is the gate in front of that
// receipt. A claim file named for the id, created exclusively under the receiving seat's own drop
// folder, is held while the winner verifies, writes the receipt and hands the body over. A loser
// gets no body: `already-served` when a durable receipt proves the content was served, `busy`
// while a live holder owns the claim.
//
// The claim is scoped to the receiving inbox: root, session and seat are written into it, and a
// claim that names another inbox is refused rather than trusted or removed. Neither the claim nor
// its folder is followed through a link; both must be this user's, 0600 and 0700.
//
// Reclaim is deliberately narrow. A claim is cleared only when its holder process is
// demonstrably gone AND no receipt verifies for the message, asked again immediately before the
// unlink, and only the exact directory entry that was judged is removed (dev and inode). A
// receipt is durable proof the content went out; no age or dead pid overrides it, so a message
// with a receipt is never served twice. An unreadable or mismatched claim is ambiguous: the read
// fails closed and the entry stays as evidence.
//
// The crash gap is honest. The receipt is written and flushed before any body is returned, so a
// crash between the claim and the receipt leaves an id that a later reader can reclaim and serve,
// while a crash between the receipt and exposure leaves the message spent with no body handed
// over. The guarantee is at-most-once content exposure, not exactly-once runtime effects
// downstream of the read.
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { heldAt } from '../launch/rules-file.ts';
import { readNoFollow } from '../send/history.ts';
import { recordNameOk, sameFolder } from '../send/record.ts';

/** `O_NOFOLLOW` is POSIX: 0 on platforms without it, while `heldAt` (`lstat`) still guards every open. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The folder of claims inside one seat's drop folder. A dot name: no listing walks it. */
export const ADMISSION_FOLDER = '.admission';

/** A claim this gate writes is a short JSON object; a larger file at the name is not one. */
const CLAIM_MAX_BYTES = 4096;

/** How many times one admission re-examines the name after losing a publish or clearing a dead
 *  claim. Each pass ends on a durable fact; a name that keeps changing is refused. */
const ADMISSION_PASSES = 3;

/** Where the admission is decided and what it releases. `reclaimed` says the claim was won over
 *  a demonstrably dead holder and no receipt, for the read's own report. */
export type InboxAdmission =
  | { ok: true; reclaimed: boolean; release: () => void }
  | { ok: false; state: 'already-served' | 'busy' | 'refused'; why: string };

export type InboxAdmissionInput = {
  /** The receiving seat's drop folder: `<root>/.agents/send-drops/<session>/<seat>`. */
  dropDir: string;
  root: string;
  seat: string;
  session: string;
  /** The message id the claim is named for. */
  id: string;
  /** Whether a signed receipt already verifies for this message, under the same binding the
   *  read uses. Asked before every decision and again before a dead claim is cleared. */
  receiptHeld: () => boolean;
  now?: Date;
};

type Claim = {
  id: string;
  root: string;
  session: string;
  seat: string;
  pid: number;
  at: string;
};

type ClaimHeld = { claim: Claim; dev: number; ino: number };

type ClaimRead = { ok: true; held: ClaimHeld } | { ok: false; why: string };

type Publish =
  | { ok: true; dev: number; ino: number }
  | { ok: false; exists: true }
  | { ok: false; exists: false; why: string };

type Reclaim =
  | { ok: true }
  | { ok: false; receipt: true }
  | { ok: false; gone: true }
  | { ok: false; why: string };

/** Whether a pid names a process still there. `EPERM` means another user's live process: alive.
 *  Any other failure, `ESRCH` included, means the holder is gone — the same rule the listener
 *  marker's liveness uses. */
function holderAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function admissionFolder(dropDir: string): string {
  return join(dropDir, ADMISSION_FOLDER);
}

export function claimPath(dropDir: string, id: string): string {
  return join(admissionFolder(dropDir), `${id}.claim`);
}

/** Makes the admission folder if it is absent, then requires it to be this user's private
 *  directory. An existing folder is never repaired: a wider mode or another owner is refused,
 *  and the owner can look at what is there. Returns the problem, or null when it is usable. */
function openAdmissionFolder(folder: string): string | null {
  const before = heldAt(folder);
  if (before.kind === 'missing') {
    let made = false;
    try {
      mkdirSync(folder, { mode: 0o700 });
      made = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'the admission folder could not be made';
    }
    if (made) {
      let fd: number | null = null;
      try {
        fd = openSync(folder, constants.O_RDONLY | NOFOLLOW);
        fchmodSync(fd, 0o700);
      } catch {
        // The mode is checked below; a folder this gate made but cannot set private is refused
        // by that check rather than trusted.
      } finally {
        if (fd !== null) {
          try {
            closeSync(fd);
          } catch {}
        }
      }
    }
  }
  const held = heldAt(folder);
  if (held.kind === 'missing') return 'the admission folder is missing';
  if (held.kind === 'link') return 'the admission folder is a symbolic link';
  if (held.kind !== 'folder') return 'the admission folder is not a directory';
  if (process.getuid !== undefined && held.uid !== process.getuid()) return "the admission folder belongs to another user";
  if ((held.mode & 0o077) !== 0) return `the admission folder is mode 0${held.mode.toString(8)}, not private`;
  return null;
}

function claimOf(value: unknown): Claim | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.v !== 1) return null;
  for (const field of ['id', 'root', 'session', 'seat', 'at'] as const) {
    if (typeof row[field] !== 'string' || row[field] === '') return null;
  }
  if (typeof row.pid !== 'number' || !Number.isInteger(row.pid) || row.pid <= 0) return null;
  return {
    id: row.id as string,
    root: row.root as string,
    session: row.session as string,
    seat: row.seat as string,
    pid: row.pid,
    at: row.at as string,
  };
}

function claimText(input: InboxAdmissionInput): string {
  const now = input.now ?? new Date();
  const claim: Claim = {
    id: input.id,
    root: input.root,
    session: input.session,
    seat: input.seat,
    pid: process.pid,
    at: now.toISOString(),
  };
  return `${JSON.stringify({ v: 1, ...claim }, null, 2)}\n`;
}

/** The claim at `path`, or null when the name is free. A file that is not exactly what this gate
 *  writes — a link, a FIFO, another owner's, a wider mode, oversized, unparsable — is refused:
 *  the caller fails closed and never removes what it could not identify. */
function readClaim(path: string): ClaimRead | null {
  const held = heldAt(path);
  if (held.kind === 'missing') return null;
  if (held.kind === 'link') return { ok: false, why: 'the admission claim is a symbolic link' };
  if (held.kind !== 'file') return { ok: false, why: 'the admission claim is not a regular file' };
  if (process.getuid !== undefined && held.uid !== process.getuid()) {
    return { ok: false, why: 'the admission claim belongs to another user' };
  }
  if ((held.mode & 0o077) !== 0) {
    return { ok: false, why: `the admission claim is mode 0${held.mode.toString(8)}, not private` };
  }
  const first = lstatSync(path, { throwIfNoEntry: false });
  if (first === undefined) return null;
  if (first.size > CLAIM_MAX_BYTES) return { ok: false, why: 'the admission claim is larger than this gate writes' };
  const text = readNoFollow(path);
  if (text === null) return { ok: false, why: 'the admission claim cannot be read' };
  // The name must still hold the entry that was read: a replacement between the stat and the
  // read is ambiguous, not a claim to judge.
  const again = lstatSync(path, { throwIfNoEntry: false });
  if (again === undefined || again.dev !== first.dev || again.ino !== first.ino) {
    return { ok: false, why: 'the admission claim changed while it was read' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, why: 'the admission claim is not readable JSON' };
  }
  const claim = claimOf(parsed);
  if (claim === null) return { ok: false, why: 'the admission claim is not the shape this gate writes' };
  return { ok: true, held: { claim, dev: first.dev, ino: first.ino } };
}

/** Creates the claim exclusively: a private temp file, written and flushed, then linked onto the
 *  id's name. `link` never replaces, so a rival's claim at the name is the loser's answer
 *  (`exists`), exactly as `createOwned` publishes the broker lock. The claim itself is not
 *  fsynced as a directory entry: losing it in a crash only re-opens admission, and the receipt,
 *  written later, is the durable record. */
function publishClaim(folder: string, name: string, content: string): Publish {
  const final = join(folder, name);
  const tmp = `${final}.${process.pid}.${randomBytes(6).toString('hex')}.new`;
  let fd: number;
  try {
    fd = openSync(tmp, 'wx', 0o600);
  } catch {
    return { ok: false, exists: false, why: 'the admission claim could not be written' };
  }
  let stat;
  try {
    stat = fstatSync(fd);
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
    return { ok: false, exists: false, why: 'the admission claim could not be written' };
  }
  try {
    closeSync(fd);
  } catch {}
  try {
    linkSync(tmp, final);
  } catch (error) {
    const exists = (error as NodeJS.ErrnoException).code === 'EEXIST';
    try {
      unlinkSync(tmp);
    } catch {}
    return exists ? { ok: false, exists: true } : { ok: false, exists: false, why: 'the admission claim could not be published' };
  }
  try {
    unlinkSync(tmp);
  } catch {}
  return { ok: true, dev: stat.dev, ino: stat.ino };
}

/** Clears a dead holder's claim when, and only when, that is still true at the unlink: no
 *  receipt verifies, the pid is gone, the name still holds the judged entry, and its content
 *  still names the same pid. `gone` means a rival cleared it first; the caller re-examines. */
function reclaimClaim(path: string, held: ClaimHeld, receiptHeld: () => boolean): Reclaim {
  if (receiptHeld()) return { ok: false, receipt: true };
  if (holderAlive(held.claim.pid)) return { ok: false, why: 'the admission claim is held by a live process' };
  const now = lstatSync(path, { throwIfNoEntry: false });
  if (now === undefined) return { ok: false, gone: true };
  if (now.dev !== held.dev || now.ino !== held.ino) {
    return { ok: false, why: 'the admission claim changed while it was being cleared' };
  }
  const text = readNoFollow(path);
  if (text === null) return { ok: false, why: 'the admission claim cannot be read' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, why: 'the admission claim is not readable JSON' };
  }
  const claim = claimOf(parsed);
  if (claim === null) return { ok: false, why: 'the admission claim is not the shape this gate writes' };
  if (claim.pid !== held.claim.pid) return { ok: false, why: 'the admission claim changed while it was being cleared' };
  try {
    unlinkSync(path);
    return { ok: true };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { ok: false, gone: true }
      : { ok: false, why: 'the admission claim could not be cleared' };
  }
}

/** Removes this reader's claim, and only the entry it published. A claim replaced by another
 *  process is left alone; a claim that cannot be removed does not keep a body from the reader
 *  that already holds the receipt, and a later reader reclaims it when this pid is gone. */
function releaseClaim(path: string, dev: number, ino: number): void {
  let now;
  try {
    now = lstatSync(path, { throwIfNoEntry: false });
  } catch {
    return;
  }
  if (now === undefined || now.dev !== dev || now.ino !== ino) return;
  try {
    unlinkSync(path);
  } catch {}
}

/**
 * Takes the exclusive claim for one message before its receipt is written and its body is
 * returned. `ok` carries the release the caller must run once the read is decided (body handed
 * over, refused, or superseded). `already-served` and `busy` are ordinary races, not defects:
 * both return no body by construction, and the message stays waiting only in the `busy` case.
 */
export function admitInboxMessage(input: InboxAdmissionInput): InboxAdmission {
  if (!recordNameOk(input.id) || input.id.length > 128) {
    return { ok: false, state: 'refused', why: 'the message id cannot name an admission claim' };
  }
  // The seat's own folder is the scope of the claim; a link standing in its path is refused
  // before anything is made inside it. The walk down from the root is the caller's check.
  if (heldAt(input.dropDir).kind !== 'folder') {
    return { ok: false, state: 'refused', why: 'the inbox folder is not a real folder' };
  }
  const folder = admissionFolder(input.dropDir);
  const problem = openAdmissionFolder(folder);
  if (problem !== null) return { ok: false, state: 'refused', why: problem };

  const name = `${input.id}.claim`;
  const path = join(folder, name);
  const content = claimText(input);
  let reclaimed = false;
  for (let pass = 0; pass < ADMISSION_PASSES; pass++) {
    if (input.receiptHeld()) return { ok: false, state: 'already-served', why: 'the message was already served' };
    const existing = readClaim(path);
    if (existing === null) {
      const published = publishClaim(folder, name, content);
      if (published.ok) {
        return { ok: true, reclaimed, release: () => releaseClaim(path, published.dev, published.ino) };
      }
      if (published.exists) continue;
      return { ok: false, state: 'refused', why: published.why };
    }
    if (!existing.ok) return { ok: false, state: 'refused', why: existing.why };
    const { claim } = existing.held;
    if (claim.id !== input.id) {
      return { ok: false, state: 'refused', why: 'the admission claim names another message' };
    }
    if (claim.session !== input.session || claim.seat !== input.seat || !sameFolder(claim.root, input.root)) {
      return { ok: false, state: 'refused', why: 'the admission claim is bound to another inbox' };
    }
    if (holderAlive(claim.pid)) {
      return { ok: false, state: 'busy', why: 'another reader holds this message' };
    }
    const cleared = reclaimClaim(path, existing.held, input.receiptHeld);
    if (cleared.ok) {
      reclaimed = true;
      continue;
    }
    if ('receipt' in cleared) return { ok: false, state: 'already-served', why: 'the message was already served' };
    if ('gone' in cleared) continue;
    return { ok: false, state: 'refused', why: cleared.why };
  }
  // Every pass ended on a name that changed under it. The message is not served: no body, and
  // whatever is at the name is left for the owner to look at.
  if (input.receiptHeld()) return { ok: false, state: 'already-served', why: 'the message was already served' };
  return { ok: false, state: 'refused', why: 'the admission claim could not be decided' };
}

/**
 * Flushes the written receipt and its folder before a body is returned, so the receipt that
 * proves the exposure survives a crash. The file is opened without following a link and must
 * still be a regular file; either flush failing means the receipt is not durable, and the read
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
