// Records a launch writes under a CLI's own home before its pane starts: the folder trust the
// CLI would otherwise ask for, and Grok's sandbox profile. Both are the owner's private files,
// and both refuse to write through a symbolic link — a config file or folder that is a link is
// left untouched, and the caller says what it can instead.
import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Writes a record under a CLI's home as its owner's private file. */
export function writePrivate(file: string, text: string, home: string): void {
  assertNoLink(file, home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
}

/** Replaces a record under a CLI's home whole. The text is written to an exclusive private
 *  temporary file in the record's own folder, synced, and renamed over the record: a failure
 *  leaves the record as it was and removes the temporary, and the result is mode 0600 even when
 *  the record it replaced was not. A reader of the record sees the old text or the new one,
 *  never a half-written file. */
export function writePrivateAtomic(file: string, text: string, home: string): void {
  assertNoLink(file, home);
  const folder = dirname(file);
  mkdirSync(folder, { recursive: true });
  const temp = join(folder, `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    // The open mode is subject to the process umask; the record is private regardless of it.
    fchmodSync(fd, 0o600);
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    removeQuietly(temp);
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, file);
  } catch (error) {
    removeQuietly(temp);
    throw error;
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The temporary is already gone; the failure being reported is the write's own.
  }
}

/** The file and each folder under the home are opened as themselves. A link, including
 *  one whose target is absent, is not a path this run reads or writes. */
export function assertNoLink(path: string, home: string): void {
  let current = path;
  while (current.startsWith(`${home}/`)) {
    let linked = false;
    try {
      linked = lstatSync(current).isSymbolicLink();
    } catch (error) {
      if (!absent(error)) throw error;
    }
    if (linked) throw new Error('a symbolic link');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** A TOML basic string: the quotes and backslashes a path carries are escaped. */
export function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function absent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT';
}
