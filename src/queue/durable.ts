// Durable, exclusive file steps shared by the E6 fences (rfc-event-comms §2, §3, §5).
//
// Every fence file is created once and never replaced: a private temp file in the same folder is
// written and fsynced, linked to its name (EEXIST means a rival or an earlier run made it, and that
// file stands), the temp is unlinked, then the folder is fsynced. A crash at any point leaves the
// name either absent or whole. Faults are injectable so the fault grid can crash, fail an fsync or
// fail an unlink at every step.
import { closeSync, constants, fstatSync, fsyncSync, lstatSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { linkSync, mkdirSync, openSync, unlinkSync, writeSync } from '../host/guarded-fs.ts';
import { readOwn } from './append.ts';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The step a fault is injected at (the grid names them). */
export type DurableStep = 'temp' | 'temp-fsync' | 'link' | 'unlink-temp' | 'folder-fsync';

/** Test seam: `before(step)` runs before a step and may throw (a crash or an I/O fault). */
export type DurableFaults = { before?: (step: DurableStep | 'mkdir' | 'parent-fsync', path: string) => void };

export type ExclusiveOutcome = 'created' | 'exists' | 'failed';

function fsyncFolder(folder: string): void {
  const fd = openSync(folder, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Makes `folder` and every missing parent, owner-only, DURABLY: each directory this call creates
 * has its new name made durable in its parent (the parent fsynced) before the next level, so the
 * first fence written in a new tree cannot lose its folder chain to a machine crash. A component
 * that exists must be a real directory, never a link. `before` is the fault seam (`mkdir` and
 * `parent-fsync` steps).
 */
export function ensureFolder(folder: string, faults: { before?: (step: 'mkdir' | 'parent-fsync', path: string) => void } = {}): boolean {
  const missing: string[] = [];
  let at = folder;
  for (;;) {
    try {
      const held = lstatSync(at);
      if (!held.isDirectory() || held.isSymbolicLink()) return false;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      missing.push(at);
      const parent = dirname(at);
      if (parent === at) return false;
      at = parent;
    }
  }
  try {
    for (const path of missing.reverse()) {
      faults.before?.('mkdir', path);
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const held = lstatSync(path);
        if (!held.isDirectory() || held.isSymbolicLink()) return false;
      }
      faults.before?.('parent-fsync', path);
      fsyncFolder(dirname(path));
    }
    // A retry after a parent fsync failed finds the folder standing: every level from the team's
    // `.agents` folder down is flushed in its parent on every call, so no earlier, unsynced mkdir
    // is taken for durable.
    const anchor = folder.lastIndexOf('/.agents/');
    if (anchor >= 0) {
      for (let at = folder; at.length > anchor + '/.agents'.length; at = dirname(at)) {
        if (!missing.includes(at)) {
          faults.before?.('parent-fsync', at);
          fsyncFolder(dirname(at));
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates `path` with `text`, exclusively and durably. `created`: this call made it, and it and its
 * folder are fsynced. `exists`: the name already stood (its folder is fsynced again, so an earlier
 * run's link is durable before anyone acts on it). `failed`: a fault before the link; the name was
 * not made by this call. A fault after the link but before the folder fsync is reported `failed`
 * too: the name may stand, and the caller treats the step as not done (fail closed) and repeats it.
 */
export function createExclusive(path: string, text: string, faults: DurableFaults = {}): ExclusiveOutcome {
  const folder = dirname(path);
  if (!ensureFolder(folder, faults)) return 'failed';
  const temp = join(folder, `.${basename(path)}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | null = null;
  let linked = false;
  try {
    faults.before?.('temp', path);
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    if (!fstatSync(fd).isFile()) return 'failed';
    const bytes = Buffer.from(text);
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    faults.before?.('temp-fsync', path);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    faults.before?.('link', path);
    try {
      linkSync(temp, path);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'failed';
    }
    faults.before?.('unlink-temp', path);
    unlinkSync(temp);
    faults.before?.('folder-fsync', path);
    fsyncFolder(folder);
    return linked ? 'created' : 'exists';
  } catch {
    return 'failed';
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* closed */ }
    }
    try { unlinkSync(temp); } catch { /* unlinked or never made */ }
  }
}

/** Removes `path` and fsyncs its folder. `removed` includes "already absent" (ENOENT); `failed`
 *  means the name may still stand and the caller keeps its state (fail closed). */
export function removeDurable(path: string, faults: { before?: (step: 'unlink' | 'folder-fsync', path: string) => void } = {}): 'removed' | 'failed' {
  try {
    faults.before?.('unlink', path);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'failed';
    }
    faults.before?.('folder-fsync', path);
    fsyncFolder(dirname(path));
    return 'removed';
  } catch {
    return 'failed';
  }
}

/** A fence file's text: '' when proved absent (ENOENT), null when unknown (any other fault, a link,
 *  a non-file). Unknown is never read as absent. */
export function readFence(path: string): string | null {
  const text = readOwn(path);
  if (text !== '') return text;
  // `readOwn` answers '' for an absent file and for an empty one; an empty fence file is unknown.
  try {
    lstatSync(path);
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? '' : null;
  }
}
