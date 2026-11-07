// Plain-runtime state-file publication: check parents and leaves, use a private exclusive
// temporary, flush its descriptor, then publish one complete file.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { basename, dirname, join, parse, relative, resolve } from 'node:path';

export class FileWriteRefusal extends Error {}
const refuse = (): never => { throw new FileWriteRefusal('state file refused: a parent or file is unsafe or changed'); };
function stat(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function regular(value: Stats): boolean { return value.isFile() && value.nlink === 1; }
function unchanged(a: Stats | null, b: Stats | null): boolean {
  return a === null ? b === null : b !== null && regular(b) && same(a, b)
    && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function parents(path: string, root?: string): () => void {
  const stop = resolve(root ?? parse(resolve(path)).root);
  const within = relative(stop, resolve(path));
  if (within === '' || within === '..' || within.startsWith('../') || parse(within).root !== '') refuse();
  const chain: { path: string; value: Stats }[] = [];
  let folder = dirname(resolve(path));
  while (true) {
    const value = lstatSync(folder);
    if (!value.isDirectory()) refuse();
    chain.push({ path: folder, value });
    if (folder === stop) break;
    if (folder === parse(folder).root) refuse();
    folder = dirname(folder);
  }
  return () => { for (const row of chain) {
    const value = stat(row.path);
    if (value === null || !value.isDirectory() || !same(row.value, value)) refuse();
  } };
}
function leaf(path: string): Stats | null {
  const value = stat(path);
  if (value !== null && !regular(value)) refuse();
  return value;
}
function flags(): void { if (!constants.O_NOFOLLOW) refuse(); }
function write(fd: number, text: string): void {
  const bytes = Buffer.from(text); let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0) refuse();
    offset += count;
  }
}

/** Missing is null; an unsafe, changed, or oversized file throws rather than reading a link. */
export function readStateFile(path: string, limit = 4 * 1024 * 1024, root?: string): string | null {
  flags(); const check = parents(path, root); const before = leaf(path);
  if (before === null) return null;
  if (before.size > limit) refuse();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!regular(opened) || !unchanged(before, opened)) refuse();
    check(); const bytes = Buffer.alloc(limit + 1); let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    check();
    if (length > limit || !unchanged(opened, fstatSync(fd)) || !unchanged(opened, leaf(path))) refuse();
    return bytes.subarray(0, length).toString('utf8');
  } finally { closeSync(fd); }
}

/** Existing leaves must be regular single-link files; parent creation belongs to the caller. */
export function writeStateFile(path: string, text: string, options: { root?: string; validateTemporary?: (path: string) => void } = {}): void {
  flags(); const check = parents(path, options.root); const before = leaf(path);
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(16).toString('hex')}.tmp`);
  let fd: number | undefined; let owned: Stats | undefined; let published = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    owned = fstatSync(fd);
    check(); if (!regular(owned)) refuse();
    write(fd, text); fsyncSync(fd);
    closeSync(fd); fd = undefined;
    options.validateTemporary?.(temporary);
    check();
    if (!unchanged(before, leaf(path))) refuse();
    const staged = leaf(temporary);
    if (staged === null || !same(owned, staged)) refuse();
    renameSync(temporary, path); published = true;
    check(); const final = leaf(path);
    if (final === null || !same(owned, final)) refuse();
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!published && owned !== undefined) {
      try { check(); const current = stat(temporary); if (current !== null && regular(current) && same(owned, current)) unlinkSync(temporary); }
      catch { /* Leave an unprovable temporary alone. */ }
    }
  }
}
