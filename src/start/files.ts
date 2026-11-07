// Setup checks both workspace leaves before writing. Plain Node has no directory-relative
// rename: parent identity checks detect replacements but do not eliminate a swap between a
// check and a path operation. A concurrent parent swap can still redirect temporary creation
// or publication; a later refusal detects that change but cannot undo filesystem effects.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { join, resolve } from 'node:path';

const LIMIT = 64 * 1024;
const NAMES = ['start.json', 'team.yaml'] as const;
type Name = typeof NAMES[number];
type File = { stat: Stats; text: string } | null;

export class StartFilesError extends Error {}
function refuse(message: string): never { throw new StartFilesError(message); }
function inode(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function unchanged(a: File, b: File): boolean {
  return a === null ? b === null : b !== null && inode(a.stat, b.stat)
    && a.stat.size === b.stat.size && a.stat.ctimeMs === b.stat.ctimeMs
    && a.stat.mtimeMs === b.stat.mtimeMs && a.text === b.text;
}
function held(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export class StartFiles {
  private root: string;
  private rootStat: Stats;
  private folderStat: Stats | undefined;
  private closed = false;

  constructor(root: string) {
    this.root = resolve(root);
    if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) refuse('this runtime cannot open setup files without following links');
    try {
      if (!lstatSync(this.root).isDirectory()) refuse('the project root must be a real directory');
      this.root = realpathSync(this.root);
      this.rootStat = lstatSync(this.root);
      this.check();
    } catch (error) {
      if (error instanceof StartFilesError) throw error;
      refuse('the project setup files cannot be checked safely');
    }
  }

  close(): void { this.closed = true; }

  private guardRoot(): void {
    if (this.closed) refuse('the setup file guard is closed');
    const current = held(this.root);
    if (!current?.isDirectory() || !inode(this.rootStat, current)) refuse('the project root changed');
  }

  private folder(create: boolean): string | null {
    this.guardRoot();
    const path = join(this.root, '.agents');
    let stat = held(path);
    if (stat === null && this.folderStat === undefined) {
      if (!create) return null;
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      this.guardRoot();
      stat = held(path);
    }
    if (!stat?.isDirectory()) refuse('the setup folder must be a real directory inside the project');
    if (this.folderStat !== undefined && !inode(this.folderStat, stat)) refuse('the setup folder changed');
    this.folderStat = stat;
    return path;
  }

  private read(folder: string, name: Name): File {
    const path = join(folder, name);
    const before = held(path);
    if (before === null) return null;
    if (!before.isFile() || before.nlink !== 1 || before.size > LIMIT) refuse(`${name} must be a bounded regular file with one link`);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMIT || !inode(before, stat)) refuse(`${name} changed before reading`);
      this.folder(false);
      const bytes = Buffer.alloc(LIMIT + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, length);
        if (count === 0) break;
        length += count;
      }
      const after = fstatSync(fd);
      if (length > LIMIT || stat.size !== after.size || stat.ctimeMs !== after.ctimeMs || stat.mtimeMs !== after.mtimeMs) {
        refuse(`${name} changed while it was read`);
      }
      this.folder(false);
      const current = held(path);
      if (current === null || !inode(stat, current) || !current.isFile() || current.nlink !== 1) refuse(`${name} changed while it was read`);
      return { stat, text: bytes.subarray(0, length).toString('utf8') };
    } finally { closeSync(fd); }
  }

  /** Both leaves are checked before the first directory, temporary, or preset write. */
  check(): Record<Name, File> {
    try {
      const folder = this.folder(false);
      return {
        'start.json': folder === null ? null : this.read(folder, 'start.json'),
        'team.yaml': folder === null ? null : this.read(folder, 'team.yaml'),
      };
    } catch (error) {
      if (error instanceof StartFilesError) throw error;
      refuse('the project setup files cannot be checked safely');
    }
  }

  write(name: Name, text: string, createOnly = false): void {
    let temp: string | undefined;
    let tempFd: number | undefined;
    let tempStat: Stats | undefined;
    try {
      const before = this.check()[name];
      if (createOnly && before !== null) refuse('the team file already exists');
      if (Buffer.byteLength(text) > LIMIT) refuse(`${name} exceeds the setup file size limit`);
      const folder = this.folder(true);
      if (folder === null) refuse('the setup folder could not be opened');
      if (!unchanged(before, this.check()[name])) refuse(`${name} changed before writing`);
      temp = join(folder, `.${name}.${randomBytes(12).toString('hex')}.tmp`);
      tempFd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      tempStat = fstatSync(tempFd);
      // Check the folder again before handing any state bytes to the open file.
      this.check();
      fchmodSync(tempFd, 0o600);
      const bytes = Buffer.from(text);
      let offset = 0;
      while (offset < bytes.length) {
        const count = writeSync(tempFd, bytes, offset, bytes.length - offset);
        if (count <= 0) refuse('writing the setup file made no progress');
        offset += count;
      }
      fsyncSync(tempFd);
      closeSync(tempFd); tempFd = undefined;
      if (!unchanged(before, this.check()[name])) refuse(`${name} changed during writing`);
      const currentTemp = held(temp);
      if (!currentTemp?.isFile() || currentTemp.nlink !== 1 || !inode(tempStat, currentTemp)) refuse('the private setup temporary changed');
      // Rename replaces a directory entry; it never writes through an old leaf link.
      renameSync(temp, join(folder, name));
      temp = undefined;
      if (this.check()[name]?.text !== text) refuse('the published setup file could not be verified');
    } catch (error) {
      if (error instanceof StartFilesError) throw error;
      refuse('the project setup files could not be written safely');
    } finally {
      if (tempFd !== undefined) closeSync(tempFd);
      if (temp !== undefined && tempStat !== undefined) {
        try {
          const current = held(temp);
          if (current?.isFile() && inode(tempStat, current)) unlinkSync(temp);
        } catch { /* A changed parent or temporary is left for inspection. */ }
      }
    }
  }
}
